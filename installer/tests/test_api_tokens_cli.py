"""설치 토큰·세션, 마법사 API, 내부 API 의 문, `jw` 명령."""

import json

import pytest
from starlette.testclient import TestClient

from app import api, cli, tokens
from app.state import Store
from tests.conftest import make_answers
from tests.fakes import make_paths
from tests.harness import Host
from tests.test_preflight_probes import FakeResolver


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


@pytest.fixture()
def tok(tmp_path):
    clock = Clock()
    return tokens.TokenStore(Store(make_paths(tmp_path)), clock), clock


# ─── 토큰 ───


def test_token_shape():
    for _ in range(50):
        t = tokens.generate()
        assert len(t) == 12 and set(t) <= set(tokens.ALPHABET)
        assert not set(t) & set("0O1I")
    assert tokens.normalize(" abcd-efgh jklm ") == "ABCDEFGHJKLM"


def test_token_ok_wrong_expired(tok):
    store, clock = tok
    assert store.check("ANYTHING") == ("none", 0)
    token = store.issue()
    assert store.check(token) == ("ok", 0)
    assert store.check(token.lower()) == ("ok", 0)
    assert store.check("WRONGWRONG22") == ("wrong", 0)
    clock.now += tokens.TOKEN_TTL + 1
    assert store.check(token) == ("expired", 0)                 # 맞지만 만료 — 틀린 것과 구분된다
    assert store.check("WRONGWRONG22")[0] == "wrong"
    assert store.current() is None


def test_token_reissue_invalidates_old(tok):
    store, _ = tok
    old = store.issue()
    new = store.issue()
    assert old != new and store.check(old)[0] == "wrong" and store.check(new)[0] == "ok"
    assert store.ensure() == new


def test_token_lock_after_five_failures(tok):
    store, clock = tok
    token = store.issue()
    for i in range(4):
        assert store.check("BADBADBADBAD") == ("wrong", 0)
    assert store.check("BADBADBADBAD") == ("wrong", tokens.LOCK_SECONDS)
    status, retry = store.check(token)                           # 잠긴 동안은 맞는 토큰도 받지 않는다
    assert status == "locked" and 0 < retry <= tokens.LOCK_SECONDS + 1
    clock.now += tokens.LOCK_SECONDS + 1
    assert store.check(token) == ("ok", 0)
    assert store.check("BADBADBADBAD") == ("wrong", 0)           # 성공하면 횟수가 지워진다


def test_sessions(tok):
    store, clock = tok
    sid = store.new_session()
    assert store.session_valid(sid) and not store.session_valid("nope") and not store.session_valid(None)
    store.issue()
    assert store.session_valid(sid)                               # 토큰을 다시 받아도 세션은 그대로
    clock.now += tokens.SESSION_TTL + 1
    assert not store.session_valid(sid)
    sid = store.new_session()
    store.revoke_all()
    assert not store.session_valid(sid) and store.current() is None


# ─── 마법사 API ───


@pytest.fixture()
def wizard(tmp_path):
    host = Host(tmp_path)
    resolver = FakeResolver({("ws.example.com", "A"): ["203.0.113.10"], ("example.com", "MX"): ["10 mail.example.com"]})
    ui = tmp_path / "ui"
    (ui / "assets").mkdir(parents=True)
    (ui / "installer.html").write_text('<!doctype html><div id="app"></div><script type="module" src="./assets/app-abc123.js"></script>',
                                       encoding="utf-8")
    (ui / "assets" / "app-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (ui / "icon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")
    svc = host.services_obj(resolver=resolver, ip_fetchers=[lambda: "203.0.113.10", lambda: "203.0.113.10"],
                            ai_get=lambda u, h: (200, {"data": [{"id": "m1"}]}), ui_dir=ui)
    client = TestClient(api.create_wizard_app(svc), base_url="https://testserver")
    return host, svc, client


def login(svc, client):
    token = svc.tokens.ensure()
    r = client.get("/", params={"token": token}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/"            # 토큰 없는 주소로 넘긴다
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    return token


def test_ui_is_served_without_session(wizard):
    _, svc, client = wizard
    r = client.get("/")
    assert r.status_code == 200 and 'id="app"' in r.text and r.headers["cache-control"] == "no-cache"
    csp = r.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp and "unsafe-eval" not in csp
    assert "script-src 'self' 'unsafe-inline'" not in csp
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["referrer-policy"] == "no-referrer"
    a = client.get("/assets/app-abc123.js")
    assert a.status_code == 200 and "immutable" in a.headers["cache-control"]
    assert "javascript" in a.headers["content-type"] and a.headers["x-content-type-options"] == "nosniff"
    assert client.get("/icon.svg").headers["content-type"].startswith("image/svg+xml")
    assert client.get("/assets/nope.js").status_code == 404
    for escape in ("/assets/../../secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"):
        assert client.get(escape).status_code == 404, escape
    assert client.get("/api/state").headers["cache-control"] == "no-store"      # API 응답은 저장하지 않는다
    assert client.get("/api/answers").status_code == 401                         # 화면만 열려 있고 API 는 세션이 있어야 한다


def test_ui_missing_bundle_does_not_break_api(tmp_path):
    host = Host(tmp_path)
    svc = host.services_obj(ui_dir=tmp_path / "no-ui")
    client = TestClient(api.create_wizard_app(svc), base_url="https://testserver")
    assert client.get("/").status_code == 503 and client.get("/healthz").status_code == 200


def test_state_carries_step_facts_and_commands(wizard):
    host, svc, client = wizard
    login(svc, client)
    st = client.get("/api/state").json()
    assert st["step"] is None
    assert st["info"]["commands"] == {
        "reissue_token": "docker exec jw-installer jw token",
        "reset_admin": "docker exec jw-installer jw reset-admin",
        "install_from_answers": "docker exec -e JW_ADMIN_PASSWORD jw-installer jw apply --answers /data/answers.json",
        "reinstall": "docker exec jw-installer jw reinstall --yes",
    }
    assert st["info"]["git_verified_version"] and st["info"]["git_verified_version"][0].isdigit()
    assert st["facts"]["detected_network"] is None and st["facts"]["lan_ip"] is None      # 사전 점검 전에는 모른다
    # 이어 할 단계
    r = client.put("/api/answers", params={"step": "zones"}, json={"access": {"domain": "ws.example.com"}})
    assert r.status_code == 200 and client.get("/api/state").json()["step"] == "zones"
    assert client.put("/api/answers", params={"step": "../x"}, json={}).status_code == 422
    assert client.put("/api/answers", json={}).status_code == 200 and client.get("/api/state").json()["step"] == "zones"
    # 연결 형태 — 나가는 주소가 사설이면 router, 공인이면 direct
    for address, expected in (("192.168.10.20", "router"), ("203.0.113.10", "router"), ("8.8.8.8", "direct")):
        svc.store.write("preflight.json", {"ok": True, "items": [{"id": "disk", "value": {"free_gb": 41.5}}],
                                           "facts": {"outbound_address": address}})
        facts = client.get("/api/state").json()["facts"]
        assert (facts["lan_ip"], facts["detected_network"], facts["disk_free_gb"]) == (address, expected, 41.5), address


def test_api_requires_session(wizard):
    _, svc, client = wizard
    for method, path in (("get", "/api/state"), ("get", "/api/answers"), ("post", "/api/preflight"),
                         ("post", "/api/apply"), ("get", "/api/zones"), ("get", "/api/summary")):
        r = getattr(client, method)(path)
        assert r.status_code == 401 and r.json()["code"] == "auth_required", path
    assert client.get("/healthz").json() == {"ok": True}


def test_token_login_wrong_expired_locked(wizard):
    _, svc, client = wizard
    svc.tokens.ensure()
    r = client.post("/api/session", json={"token": "WRONGWRONG22"})
    assert r.status_code == 401 and r.json()["code"] == "token_wrong"
    # 주소에 실린 토큰이 틀리면 사유만 실어 토큰 없는 주소로 넘긴다(쿠키 없음) — 화면이 사유를 알린다
    r = client.get("/", params={"token": "WRONGWRONG22"}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/?token_status=wrong" and "set-cookie" not in r.headers
    for _ in range(3):
        client.post("/api/session", json={"token": "WRONGWRONG22"})
    r = client.post("/api/session", json={"token": svc.tokens.current()})
    assert r.status_code == 429 and r.json()["code"] == "token_locked" and r.json()["vars"]["retry_after"] > 0
    svc.store.write("token.json", {**svc.store.read("token.json"), "locked_until": 0, "expires": 0})
    r = client.post("/api/session", json={"token": svc.store.read("token.json")["token"]})
    assert r.status_code == 401 and r.json()["code"] == "token_expired"


def test_answers_partial_save_and_secrets(wizard):
    _, svc, client = wizard
    login(svc, client)
    r = client.put("/api/answers", json={"access": {"domain": "ws.example.com"}, "admin": {"password": "correct-horse-battery"}})
    assert r.status_code == 200
    body = r.json()
    assert body["answers"]["access"]["domain"] == "ws.example.com"
    assert "password" not in body["answers"]["admin"] and body["secrets_set"]["admin.password"] is True
    # 다음 저장에서 비밀번호를 보내지 않아도 남아 있다
    r = client.put("/api/answers", json={"admin": {"name": "관리자", "username": "admin"}, "preset": "collab",
                                         "mail": {"mail_domain": "example.com"}})
    assert r.json()["secrets_set"]["admin.password"] is True
    assert svc.store.load_answers().admin.password == "correct-horse-battery"
    # 모양이 틀리면 422 + 필드별 오류, 저장하지 않는다
    r = client.put("/api/answers", json={"access": {"network": "vpn"}})
    assert r.status_code == 422 and r.json()["code"] == "answers_invalid"
    assert r.json()["vars"]["errors"][0]["field"] == "access.network"
    # 뜻이 틀린 값은 저장하되 오류로 알려 준다
    r = client.put("/api/answers", json={"access": {"domain": "not a domain"}})
    assert {"field": "access.domain", "code": "domain_invalid", "vars": {}} in r.json()["errors"]

    r = client.get("/api/answers/export")
    assert "attachment" in r.headers["content-disposition"]
    assert "correct-horse-battery" not in r.text and "password" not in json.loads(r.text)["admin"]
    raw = (svc.paths.state / "answers.json").read_text(encoding="utf-8")
    assert "correct-horse-battery" not in raw


def test_preflight_zones_summary_and_probes(wizard):
    host, svc, client = wizard
    login(svc, client)
    svc.store.save_answers(make_answers())
    r = client.post("/api/preflight")
    assert r.json()["ok"] and svc.store.facts().memory_mb == 16384
    zones = client.get("/api/zones").json()
    assert {z["id"] for z in zones["zones"] if z["selected"]} == {"mail", "chat", "calendar", "docs"}
    assert zones["memory"]["ok"] and zones["preset_fits"]["full"]

    s = client.get("/api/summary").json()
    assert s["ready"] and s["errors"] == []              # 임시 인증서가 아니면 DNS 확인 없이도 답변은 유효하다
    r = client.post("/api/probe/dns", json={})
    assert r.json()["status"] == "match" and svc.store.facts().dns_status == "match"
    s = client.get("/api/summary").json()
    assert s["access"]["url"] == "https://ws.example.com" and "25/tcp" in s["ports"]
    assert s["steps"][0] == "config" and s["steps"][-1] == "lock"
    assert "mail_needs_dns_and_port25" in {c["key"] for c in s["cautions"]}

    mail = client.post("/api/probe/mail-records", json={}).json()
    assert [r["id"] for r in mail["records"]] == ["mx", "a", "spf", "dkim", "dmarc"]
    assert mail["records"][0]["status"] == "ok" and mail["records"][3]["expected"].startswith("v=DKIM1; k=rsa; p=")
    assert (svc.paths.state / "dkim" / "example.com.pem").exists()            # 적용 전에 만들어 둔다
    assert not (svc.paths.stack / "mailserver").exists()                       # 서버 구성은 아직 건드리지 않는다

    assert client.post("/api/probe/ai", json={"provider": "google", "api_key": "k"}).json()["status"] == "ok"
    assert client.post("/api/probe/nfs", json={"server": "nas;rm", "export": "/x"}).status_code == 422
    assert client.post("/api/probe/local-path", json={"path": "../etc"}).json()["code"] == "path_invalid"
    assert client.get("/api/restore/review").json()["code"] == "restore_no_backup"      # 복원 — tests/test_restore.py


def test_cert_upload_probe(wizard):
    from app import certs

    _, svc, client = wizard
    login(svc, client)
    svc.store.save_answers(make_answers(access={"cert": "upload"}))
    cert, key = certs.self_signed(["ws.example.com"])
    r = client.post("/api/probe/cert", json={"cert": cert, "key": key}).json()
    assert r["ok"] and svc.store.facts().upload_cert_ok
    assert [c for c in r["checks"] if c["id"] == "mail_host_covered"][0]["status"] == "warn"
    r = client.post("/api/probe/cert", json={"cert": cert, "key": "nope"}).json()
    assert not r["ok"] and not svc.store.facts().upload_cert_ok


def test_apply_via_api_then_locked(wizard):
    host, svc, client = wizard
    login(svc, client)
    host.install(svc)
    assert client.post("/api/apply").status_code == 202
    svc.engine._thread.join(30)
    # 끝나면 잠긴다 — 상태 조회만 남고, 세션도 토큰도 없다
    locked = client.get("/api/state").json()
    assert {k: locked[k] for k in ("phase", "locked", "version", "url")} == {
        "phase": "installed", "locked": True, "version": svc.bundle.version, "url": "https://ws.example.com"}
    assert locked["info"]["commands"]["reinstall"] == "docker exec jw-installer jw reinstall --yes"
    for method, path in (("get", "/api/answers"), ("put", "/api/answers"), ("post", "/api/apply"),
                         ("get", "/api/apply"), ("post", "/api/preflight"), ("post", "/api/session")):
        kwargs = {"json": {}} if method != "get" else {}
        r = getattr(client, method)(path, **kwargs)
        assert r.status_code == 423 and r.json()["code"] == "locked", path
    # 잠긴 뒤에도 화면은 내준다(잠김 안내를 화면이 그린다). 토큰이 실린 주소는 그냥 넘긴다.
    assert client.get("/").status_code == 200 and 'id="app"' in client.get("/").text
    r = client.get("/", params={"token": "WRONGWRONG22"}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/"


def test_apply_status_log_and_retry_api(wizard):
    host, svc, client = wizard
    login(svc, client)
    host.install(svc)
    host.certbot_ok = False
    client.post("/api/apply")
    svc.engine._thread.join(30)
    st = client.get("/api/apply").json()
    assert st["status"] == "failed" and st["alternatives"] == [{"key": "use_temporary_cert"}]
    assert client.get("/api/state").json()["apply"]["error"]["step"] == "cert"
    log = client.get("/api/apply/log", params={"step": "cert"}).json()["lines"]
    assert any("cert_issue_failed" in line for line in log)
    assert client.get("/api/apply/log", params={"step": "../../etc/passwd"}).json()["lines"] == []
    with client.stream("GET", "/api/apply/stream") as s:
        first = next(line for line in s.iter_lines() if line.startswith("data:"))
    assert json.loads(first[5:])["status"] == "failed"
    assert client.post("/api/apply/retry", json={"use_temporary_cert": True}).status_code == 202
    svc.engine._thread.join(30)
    assert svc.engine.status()["status"] == "done"


# ─── 내부 API 의 문 ───


def test_internal_api_needs_key_and_internal_address(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    svc.engine.run()
    key = svc.store.env_secrets()["JW_INSTALLER_KEY"]
    inside = TestClient(api.create_internal_app(svc), client=("172.28.0.20", 5000))
    outside = TestClient(api.create_internal_app(svc), client=("192.168.10.77", 5000))
    assert inside.get("/internal/health").json()["installed"] is True
    assert inside.get("/internal/zones").status_code == 404                         # 키 없음
    assert inside.get("/internal/zones", headers={api.KEY_HEADER: "wrong"}).status_code == 404
    assert outside.get("/internal/zones", headers={api.KEY_HEADER: key}).status_code == 404   # 내부 대역 밖
    r = inside.get("/internal/zones", headers={api.KEY_HEADER: key})
    assert r.status_code == 200 and {z["id"] for z in r.json()["zones"] if z["enabled"]} == {"mail", "chat", "calendar", "docs"}
    # 마법사 앱에는 내부 경로가 아예 없다
    wizard_client = TestClient(api.create_wizard_app(svc), base_url="https://testserver")
    assert wizard_client.get("/internal/zones", headers={api.KEY_HEADER: key}).status_code == 404
    # 같은 컨테이너의 jw 명령용 경로는 루프백 + 로컬 키
    assert inside.get("/local/apply", headers={api.LOCAL_KEY_HEADER: svc.local_key()}).status_code == 404
    local = TestClient(api.create_internal_app(svc), client=("127.0.0.1", 5000))
    assert local.get("/local/apply", headers={api.LOCAL_KEY_HEADER: svc.local_key()}).json()["status"] == "done"
    assert local.get("/local/apply").status_code == 404


def test_internal_api_closed_before_install(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    inside = TestClient(api.create_internal_app(svc), client=("172.28.0.20", 5000))
    assert inside.get("/internal/zones", headers={api.KEY_HEADER: ""}).status_code == 404


# ─── jw 명령 ───


@pytest.fixture()
def jw(tmp_path, monkeypatch):
    host = Host(tmp_path)
    svc = host.services_obj(resolver=FakeResolver({("ws.example.com", "A"): ["203.0.113.10"]}),
                            ip_fetchers=[lambda: "203.0.113.10", lambda: "203.0.113.10"])
    monkeypatch.setattr(cli, "_services", lambda args: svc)
    monkeypatch.setenv("JW_INTERNAL_PORT", "1")          # 서버가 없다 — 이 프로세스에서 직접 돌린다
    answers = tmp_path / "answers.json"
    data = json.loads(json.dumps(make_answers().model_dump(mode="json")))
    data["admin"].pop("password")
    answers.write_text(json.dumps(data), encoding="utf-8")
    return host, svc, answers


def test_jw_token(jw, capsys):
    _, svc, _ = jw
    old = svc.tokens.ensure()
    assert cli.main(["token"]) == 0
    out = capsys.readouterr().out
    new = svc.tokens.current()
    assert new != old and new in out and f"?token={new}" in out


def test_jw_dry_run_changes_nothing(jw, capsys, monkeypatch):
    host, svc, answers = jw
    monkeypatch.setenv("JW_ADMIN_PASSWORD", "correct-horse-battery")
    calls = len(host.runner.calls)
    assert cli.main(["apply", "--answers", str(answers), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "검증 통과" in out and "mail, chat, calendar, docs" in out and ".env" in out and "nginx/site.d/http.conf" in out
    assert "correct-horse-battery" not in out
    assert len(host.runner.calls) == calls and not host.paths.env_file.exists()
    assert svc.store.answers_public() == {}


def test_jw_dry_run_reports_errors(jw, capsys):
    _, _, answers = jw
    assert cli.main(["apply", "--answers", str(answers), "--dry-run"]) == 1       # 관리자 비밀번호가 없다
    assert "admin.password: required" in capsys.readouterr().out


def test_jw_apply_and_status(jw, capsys, monkeypatch):
    host, svc, answers = jw
    monkeypatch.setenv("JW_ADMIN_PASSWORD", "correct-horse-battery")
    assert cli.main(["apply", "--answers", str(answers)]) == 0
    assert "설치가 끝났습니다" in capsys.readouterr().out and svc.store.locked
    assert cli.main(["status"]) == 0
    assert "lock      done" in capsys.readouterr().out
    assert cli.main(["token"]) == 1


def test_jw_render_and_reset_admin(jw, capsys, tmp_path, monkeypatch):
    host, svc, answers = jw
    monkeypatch.setenv("JW_ADMIN_PASSWORD", "correct-horse-battery")
    out = tmp_path / "out"
    assert cli.main(["render", "--answers", str(answers), "--out", str(out)]) == 0
    assert (out / ".env").exists() and (out / "docker-compose.yml").exists() and (out / "nginx/site.d/listen-main.conf").exists()
    host.runner.on("exec", "ws-backend", "reset-admin", out="[RESET] 임시 비밀번호\nabc123\n")
    assert cli.main(["reset-admin", "admin", "--disable-2fa"]) == 0
    call = host.runner.find("exec", "ws-backend", "reset-admin")[0]
    assert call[-2:] == ["admin", "--disable-2fa"] and "abc123" in capsys.readouterr().out
    assert cli.main(["reset-admin", "admin; rm -rf /"]) == 2


def test_jw_reinstall_lists_first_then_wipes(jw, capsys, monkeypatch):
    host, svc, answers = jw
    monkeypatch.setenv("JW_ADMIN_PASSWORD", "correct-horse-battery")
    assert cli.main(["apply", "--answers", str(answers)]) == 0
    assert svc.store.locked and (svc.paths.stack / ".env").exists()
    (svc.paths.state / "tls").mkdir(exist_ok=True)
    (svc.paths.state / "tls" / "cert.pem").write_text("cert", encoding="utf-8")
    host.runner.on("ps", "-a", "--filter", out="ws-backend\nws-nginx\nws-postgres\n")
    host.runner.on("volume", "ls", "-q", out="ws-postgres-data\nws-redis-data\n")
    host.runner.on("network", "inspect", out=json.dumps([{"Name": "just-workspace_workspace"}]))
    host.volumes.setdefault("ws-certbot-data", {"Name": "ws-certbot-data", "Options": None})
    capsys.readouterr()

    # --yes 없이는 목록만 보여 주고 아무것도 지우지 않는다
    assert cli.main(["reinstall"]) == 1
    out = capsys.readouterr().out
    assert "ws-backend" in out and "ws-postgres-data" in out and "ws-storage-data" in out and "--yes" in out
    assert not host.runner.find("rm", "-f") and not host.runner.find("volume", "rm")
    assert svc.store.locked and (svc.paths.stack / ".env").exists()

    assert cli.main(["reinstall", "--yes"]) == 0
    removed = host.runner.find("rm", "-f", "-v")[0]
    assert {"ws-backend", "ws-nginx", "ws-postgres"} <= set(removed)
    gone = {c[-1] for c in host.runner.find("volume", "rm")}
    assert {"ws-postgres-data", "ws-redis-data", "ws-storage-data", "ws-certbot-data"} <= gone
    assert host.runner.find("network", "rm", "just-workspace_workspace")
    assert host.runner.find("restart", "jw-self")
    assert not (svc.paths.stack / ".env").exists()
    assert not svc.store.locked and svc.store.install()["phase"] == "wizard"      # 처음 상태 — 새 토큰으로 다시 시작한다
    assert (svc.paths.state / "tls" / "cert.pem").exists()                        # 설치 관리자의 인증서는 남는다


def test_internal_api_for_admin_screens(tmp_path):
    """설치 뒤 관리 화면이 쓰는 것 — 메일 레코드, 공인 주소, 작업 목록, 저장소, 코드 저장소의 검증한 버전."""
    host = Host(tmp_path)
    resolver = FakeResolver({("example.com", "MX"): ["10 mail.example.com"]})
    svc = host.services_obj(resolver=resolver, ip_fetchers=[lambda: "203.0.113.10", lambda: "203.0.113.10"])
    host.install(svc)
    assert svc.engine.run()["status"] == "done"
    key = svc.store.env_secrets()["JW_INSTALLER_KEY"]
    inside = TestClient(api.create_internal_app(svc), client=("172.28.0.20", 5000), headers={api.KEY_HEADER: key})
    nokey = TestClient(api.create_internal_app(svc), client=("172.28.0.20", 5000))
    for method, path in (("post", "/internal/probe/mail-records"), ("get", "/internal/probe/public-ip"),
                         ("get", "/internal/jobs"), ("get", "/internal/storage")):
        assert getattr(nokey, method)(path).status_code == 404, path

    rec = inside.post("/internal/probe/mail-records", json={}).json()
    by_id = {r["id"]: r for r in rec["records"]}
    assert set(by_id) == {"mx", "a", "spf", "dkim", "dmarc"} and by_id["mx"]["status"] == "ok"
    from app import dkim
    assert by_id["dkim"]["expected"] == dkim.ensure(svc.store, "example.com")["record_value"]      # 설치 때 만든 키

    assert inside.get("/internal/probe/public-ip").json()["ip"] == "203.0.113.10"
    assert inside.get("/internal/probe/public-ip", params={"refresh": "true"}).json()["status"] == "detected"

    st = inside.get("/internal/storage").json()
    assert st["kind"] == "local" and st["install_id"] == svc.store.install()["install_id"]
    svc.store.save_answers(make_answers(storage={"kind": "nfs", "server": "192.168.10.9", "export": "/export/ws"}))
    assert inside.get("/internal/storage").json()["location"] == "192.168.10.9:/export/ws"

    assert inside.get("/internal/jobs").json() == {"jobs": []}
    svc.store.write("jobs.json", {"a": {"id": "a", "zone": "chat", "status": "done", "started_at": "2026-01-01T00:00:00Z"},
                                  "b": {"id": "b", "zone": "git", "status": "running", "started_at": "2026-01-02T00:00:00Z"}})
    assert [j["id"] for j in inside.get("/internal/jobs").json()["jobs"]] == ["b", "a"]           # 새것부터

    version = svc.bundle.gitea_verified_version
    assert version and inside.get("/internal/zones").json()["git_verified_version"] == version
    assert inside.get("/internal/zones/git/settings").json()["verified_version"] == version
    assert "verified_version" not in inside.get("/internal/zones/mail/settings").json()
