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
    svc = host.services_obj(resolver=resolver, ip_fetchers=[lambda: "203.0.113.10", lambda: "203.0.113.10"],
                            ai_get=lambda u, h: (200, {"data": [{"id": "m1"}]}))
    client = TestClient(api.create_wizard_app(svc), base_url="https://testserver")
    return host, svc, client


def login(svc, client):
    token = svc.tokens.ensure()
    r = client.get("/", params={"token": token}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/"
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    return token


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
    assert client.get("/", params={"token": "WRONGWRONG22"}).status_code == 401
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
    assert client.post("/api/restore").status_code == 501


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
    assert client.get("/api/state").json() == {"phase": "installed", "locked": True,
                                               "version": svc.bundle.version, "url": "https://ws.example.com"}
    for method, path in (("get", "/api/answers"), ("put", "/api/answers"), ("post", "/api/apply"),
                         ("get", "/api/apply"), ("post", "/api/preflight"), ("post", "/api/session")):
        kwargs = {"json": {}} if method != "get" else {}
        r = getattr(client, method)(path, **kwargs)
        assert r.status_code == 423 and r.json()["code"] == "locked", path
    assert "설치가 끝났습니다" in client.get("/").text


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
