"""백업에서 복원 — 설정 병합 규칙, 버전 판정, 백업 수신(업로드·경로·암호), 단계, 실패·재시도, 무인 경로."""

import json

import pytest
from starlette.testclient import TestClient

from app import answers as ans
from app import api, cli, envfile, render, restore
from app import restore_config as rc
from app.docker_api import Result
from tests.conftest import SECRETS
from tests.harness import Host
from tests.test_preflight_probes import FakeResolver

BACKUP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
OLD_KEY = "0f" * 24
OLD_ENV = {
    **{k: v for k, v in SECRETS.items() if k not in ("JW_INSTALL_ID", "JW_INSTALLER_KEY")},
    "SECRET_KEY": OLD_KEY,
    "JW_INSTALL_ID": BACKUP_ID,
    "JW_INSTALLER_KEY": "old-installer-key-0123456789abcdef0123456789",
    "JW_INSTALLER_URL": "http://jw-installer:8444",
    "JW_ZONES": "core,mail,chat,calendar,docs,git",
    "COMPOSE_PROFILES": "mailserver,onlyoffice,gitea,certbot",
    "DEPLOY_MODE": "standalone",
    "APP_URL": "https://old.example.com",
    "APP_NAME": "Acme Workspace",
    "DOMAIN": "example.com",
    "ADMIN_EMAILS": "root@example.com",
    "FEATURE_BUILTIN_MAILSERVER": "true",
    "GITEA_IMAGE": "gitea/gitea:1.24.0",
    "GITEA_TOKEN": "b" * 40,
    "OAUTH_CLIENTS_JSON": '{"gitea":{"secret":"s3","redirect_uris":["https://old.example.com/git/user/oauth2/workspace/callback"]}}',
    "JW_NET_PREFIX": "172.30.5",
    "LETSENCRYPT_EMAIL": "ops@example.com",
    "BRAND_COLOR": "#123456",
    "OAUTH_DYNAMIC_CLIENTS_MAX": "5",
    "GPU_HOST_IP": "192.168.10.99",
    "MCP_PUBLIC_URL": "https://mcp.old.example.com",
    "BACKEND_WORKERS": "8",
    "HAIRPIN_HOST": "old.example.com",
}
SUMMARY = {
    "format": 1, "kind": "full", "created_at": "2026-01-01T03:00:00Z", "product_version": "1.0.0", "schema_version": 3,
    "postgres_version": 160004, "install_id": BACKUP_ID, "domain": "example.com", "source_url": "https://old.example.com",
    "zones": ["core", "mail", "chat", "calendar", "docs", "git"], "users": 2, "data_bytes": 12_000_000,
    "storage": {"kind": "local"}, "storage_bytes": 5000, "files_included": True, "files_bytes": 5000,
    "items": ["db", "config", "mail", "gitea", "plugins-data", "certs", "files"], "skipped": {},
    "config_included": True, "config_encrypted": False, "size_bytes": 20_000_000, "is_archive": True,
}


def env_text(env: dict) -> str:
    return "".join(f"{k}={envfile.quote(v)}\n" for k, v in env.items())


class Backup:
    """모의 backend CLI — inspect·verify·extract-config·restore 의 응답을 지정한다."""

    def __init__(self, host: Host, *, summary: dict | None = None, env: dict | None = None, password: str | None = None):
        self.host, self.summary, self.env, self.password = host, dict(summary or SUMMARY), dict(env or OLD_ENV), password
        self.inspect: Result | None = None
        self.verify = {"ok": True, "problems": []}
        self.restore_result: Result | dict = {"ok": True, "items": [], "stages": ["verify", "db-load"], "schema": [3, 3]}
        self.marker = {"status": "missing", "install_id": None}
        host.services += ["mailserver", "onlyoffice", "gitea"]
        r = host.runner
        r.on("app.cli", "schema-version", out="3\n")
        r.on("app.cli", "backup", "inspect", fn=lambda argv, i: self.inspect or json.dumps(self.summary, indent=2))
        r.on("app.cli", "backup", "verify", fn=lambda argv, i: Result(0 if self.verify["ok"] else 1, json.dumps(self.verify)))
        r.on("app.cli", "backup", "extract-config", fn=self._extract)
        r.on("compose", "run", "backend", "app.cli", "restore", fn=self._restore)
        r.on("app.helper", "restore-files", out=json.dumps({"status": "restored", "entries": 3, "bytes": 5000}) + "\n")
        r.on("app.helper", "read-marker", fn=lambda argv, i: json.dumps(self.marker) + "\n")
        r.on("exec", "ws-postgres", "psql", out="2\n")
        r.on("exec", "ws-gitea", "auth", "list", out="ID\tName\tType\tEnabled\n1\tworkspace\tOAuth2\ttrue\n")
        r.on("exec", "ws-gitea", "generate-access-token", out="c" * 40 + "\n")

    def _extract(self, argv, _):
        if self.summary.get("config_encrypted"):
            pw = self.host.paths.state / "restore" / "password"
            if "--password-file" not in argv or pw.read_text(encoding="utf-8").strip() != self.password:
                return Result(1, "", "ERROR: 암호가 틀렸거나 설정 항목이 손상됐습니다")
        out = self.host.paths.state / "restore" / "config"
        (out / "livekit").mkdir(parents=True, exist_ok=True)
        (out / ".env").write_text(env_text(self.env), encoding="utf-8")
        return ".env\n"

    def _restore(self, argv, _):
        if isinstance(self.restore_result, Result):
            return self.restore_result
        items = argv[argv.index("--items") + 1].split(",")
        return "[restore] 진행\n" + json.dumps({**self.restore_result, "items": items}) + "\n"


def make(tmp_path, **kw):
    host = Host(tmp_path)
    backup = Backup(host, **kw)
    resolver = FakeResolver({("old.example.com", "A"): ["203.0.113.10"], ("new.example.com", "A"): ["198.51.100.7"]})
    svc = host.services_obj(resolver=resolver, ip_fetchers=[lambda: "203.0.113.10", lambda: "203.0.113.10"])
    svc.store.update_facts(memory_mb=16384, cpus=4, public_ip="203.0.113.10")
    from app import api_restore

    return host, backup, svc, api_restore.manager(svc)


def env_of(host) -> dict:
    return envfile.parse(host.paths.env_file.read_text(encoding="utf-8"))


# ─── 설정 병합 규칙 ───


def test_parse_env_reads_installer_and_hand_written_files():
    text = "# c\nA=1\nB='x y'\nC=\"q\\\"r\"\nexport D=v  # trailing\nE=\n bad line\n9X=no\n"
    assert rc.parse_env(text) == {"A": "1", "B": "x y", "C": 'q"r', "D": "v", "E": ""}
    assert rc.parse_env(env_text(OLD_ENV)) == OLD_ENV


def test_merge_carries_keys_overrides_address_and_makes_new(bundle, catalog):
    carried = rc.carried_secrets(OLD_ENV, bundle)
    # 이전하는 항목: 암호화 키·DB 비밀번호·구역 키·설치 id·코드 저장소 토큰
    assert carried["SECRET_KEY"] == OLD_KEY and carried["DB_PASSWORD"] == SECRETS["DB_PASSWORD"]
    assert carried["JW_INSTALL_ID"] == BACKUP_ID and carried["GITEA_TOKEN"] == "b" * 40
    # 신규 생성 항목: 설치 관리자 내부 키는 이전하지 않는다
    assert "JW_INSTALLER_KEY" not in carried

    target = {"domain": "new.example.com", "network": "direct", "cert": "temporary", "storage": {"kind": "local"}}
    answers, secrets = rc.answers_from_backup(OLD_ENV, SUMMARY, target, catalog, bundle)
    assert answers.mode == "restore" and answers.access.domain == "new.example.com"
    assert answers.zones == ["mail", "chat", "calendar", "docs", "git"] and answers.preset is None
    assert answers.mail.kind == "builtin" and answers.mail.mail_domain == "example.com"       # 메일 도메인은 백업의 값 사용
    assert answers.git.version == "1.24.0" and answers.advanced.subnet == "172.30.5.0/24"
    assert answers.admin.username == "root" and answers.admin.password is None and secrets == {}
    assert answers.access.acme_email == "ops@example.com"

    facts = ans.Facts(memory_mb=16384, cpus=4, dns_status="mismatch")
    plan = render.derive(answers, facts, catalog)
    managed = {k for _, pairs in render.env_sections(answers, {}, facts, plan, version="", registry="", gitea_image="")
               for k, _ in pairs}
    extra = rc.extra_env(OLD_ENV, managed, bundle)
    # 그대로 이전하는 항목: 계속 사용하는 값과 설치 관리자가 관리하지 않는 변수. 원래 서버에 종속된 값·비밀값·관리 변수는 제외된다
    assert extra == {"APP_NAME": "Acme Workspace", "DOMAIN": "example.com", "ADMIN_EMAILS": "root@example.com",
                     "BRAND_COLOR": "#123456", "OAUTH_DYNAMIC_CLIENTS_MAX": "5"}

    files = render.render(answers, {**carried, "JW_INSTALLER_KEY": "n" * 48, render.EXTRA_ENV_KEY: extra}, facts, bundle)
    env = envfile.parse(files[".env"])
    assert env["SECRET_KEY"] == OLD_KEY and env["JW_INSTALL_ID"] == BACKUP_ID          # 이전한 항목
    assert env["APP_NAME"] == "Acme Workspace" and env["BRAND_COLOR"] == "#123456"
    assert env["DOMAIN"] == "example.com" and env["ADMIN_EMAILS"] == "root@example.com"
    assert env["APP_URL"] == "https://new.example.com" and env["GIT_SSH_DOMAIN"] == "new.example.com"   # 덮어쓴 항목
    assert env["GITEA_EXTERNAL_URL"] == "https://new.example.com/git/" and env["JW_NET_PREFIX"] == "172.30.5"
    assert env["BACKEND_WORKERS"] == "4" and env["HAIRPIN_HOST"] == "new.example.com" and env["MCP_PUBLIC_URL"] == ""
    assert env["JW_INSTALLER_KEY"] == "n" * 48 and "GPU_HOST_IP" not in env             # 신규 생성 항목 · 이전하지 않는 항목
    assert "certbot" not in env["COMPOSE_PROFILES"]                                    # 임시 인증서 — 새 응답(answers)에서 결정된다


def test_answers_from_backup_external_mail_proxy_and_ip(bundle, catalog):
    env = {**OLD_ENV, "FEATURE_BUILTIN_MAILSERVER": "false", "SMTP_HOST": "smtp.example.net", "SMTP_PORT": "465",
           "SMTP_USER": "relay@example.net", "SMTP_PASSWORD": "relay-secret-1", "DEPLOY_MODE": "external_proxy",
           "COMPOSE_PROFILES": "onlyoffice,livekit,audiorelay", "JW_ZONES": "core,mail,chat,meetings",
           "GITEA_IMAGE": bundle.gitea_verified_image}
    summary = {**SUMMARY, "zones": []}
    answers, secrets = rc.answers_from_backup(env, summary, {"proxy_addresses": ["192.168.10.5"]}, catalog, bundle, turn=False)
    assert answers.access.network == "proxy" and answers.access.cert == "proxy" and answers.access.domain == "old.example.com"
    assert answers.mail.kind == "external" and answers.mail.host == "smtp.example.net" and answers.mail.port == 465
    assert secrets == {"mail.password": "relay-secret-1"}
    assert answers.zones == ["mail", "chat", "meetings"] and answers.meetings.lossless_audio and not answers.meetings.turn
    assert answers.git.version == "verified"
    ip, _ = rc.answers_from_backup(env, summary, {"domain": "192.168.10.50", "network": "direct"}, catalog, bundle)
    assert ip.meetings.turn is False                      # 주소가 IP 이면 중계를 비활성화한다
    assert rc.turn_enabled("port: 7880\nturn:\n  enabled: true\n  domain: turn.x\n") is True
    assert rc.turn_enabled("turn:\n  enabled: false\n") is False and rc.turn_enabled(None) is None


def test_restore_mode_does_not_ask_for_admin(catalog):
    facts = ans.Facts(memory_mb=16384, dns_status="match")
    a = ans.load({"mode": "restore", "access": {"domain": "ws.example.com"}, "zones": ["chat", "meetings"]})
    assert ans.validate(a, catalog, facts) == []          # 관리자·회의의 공인 주소를 요구하지 않는다
    a = ans.load({"mode": "restore", "access": {"domain": "ws.example.com"}, "zones": [],
                  "restore": {"path": "relative/x", "password_file": "/etc/pw"}})
    codes = {(e.field, e.code) for e in ans.validate(a, catalog, facts)}
    assert codes == {("restore.path", "path_invalid"), ("restore.password_file", "path_outside_data")}


# ─── 버전 판정 ───


@pytest.mark.parametrize("summary,expected", [
    ({"schema_version": 3, "product_version": "1.0.0"}, ("ok", None)),
    ({"schema_version": 2, "product_version": "0.9.4"}, ("ok", None)),
    ({"schema_version": 4, "product_version": "1.0.0"}, ("newer", "schema")),
    ({"schema_version": 3, "product_version": "1.0.1"}, ("newer", "product")),
    ({"schema_version": 3, "product_version": "1.0.0-beta.2"}, ("ok", None)),
    ({"schema_version": 3, "product_version": ""}, ("ok", None)),
])
def test_version_verdict(summary, expected):
    got = rc.judge_version(summary, installer_version="1.0.0", installer_schema=3)
    assert (got["status"], got["reason"]) == expected


# ─── 백업 수신 ───


def wizard(tmp_path, **kw):
    host, backup, svc, mgr = make(tmp_path, **kw)
    client = TestClient(api.create_wizard_app(svc), base_url="https://testserver")
    token = svc.tokens.ensure()
    assert client.get("/", params={"token": token}, follow_redirects=False).status_code == 302
    return host, backup, svc, client


def test_upload_is_streamed_checked_and_reviewed(tmp_path):
    host, backup, svc, client = wizard(tmp_path)
    assert client.get("/api/state").json()["info"]["backup_file_format"] == ".jwbak"
    assert client.get("/api/restore/file").json()["status"] == "none"
    assert client.get("/api/restore/review").status_code == 409
    body = b"JWBAK" * 50_000
    r = client.post("/api/restore/upload", files={"file": ("ws-backup.jwbak", body, "application/octet-stream")})
    assert r.status_code == 200, r.text
    info = r.json()
    assert (info["status"], info["state"], info["name"], info["size_bytes"], info["source"]) == \
        ("ok", "ready", "ws-backup.jwbak", len(body), "upload")
    saved = svc.paths.state / "restore" / "upload" / "backup.jwbak"
    assert saved.read_bytes() == body and not saved.with_name("backup.jwbak.part").exists()
    # 백업은 backend 이미지의 일회용 컨테이너에 읽기 전용으로 마운트하여 읽는다(호스트 경로)
    inspect = host.runner.find("app.cli", "backup", "inspect")[0]
    assert "type=bind,source=/opt/just-workspace/state/restore/upload/backup.jwbak,target=/restore-src,readonly" in inspect
    assert inspect[inspect.index("--network") + 1] == "none" and "localhost/just-workspace-backend:1.0.0" in inspect
    assert host.runner.index("app.cli", "backup", "inspect") < host.runner.index("app.cli", "backup", "verify") \
        < host.runner.index("app.cli", "backup", "extract-config")

    review = client.get("/api/restore/review").json()
    assert review["domain"] == "old.example.com" and review["source_url"] == "https://old.example.com"
    assert review["version_status"] == "ok" and review["blockers"] == []
    assert review["zones"] == ["mail", "chat", "calendar", "docs", "git"] and review["users"] == 2
    assert review["storage"] == {"kind": "local"} and review["files_included"] and review["files_bytes"] == 5000
    assert review["install_id"] == BACKUP_ID and review["subnet"] == "172.30.5.0/24" and review["mail_domain"] == "example.com"

    assert client.delete("/api/restore/file").json()["status"] == "none" and not saved.exists()


def test_rejected_backups(tmp_path):
    host, backup, svc, client = wizard(tmp_path)
    up = lambda: client.post("/api/restore/upload", files={"file": ("x.jwbak", b"data", "application/octet-stream")}).json()  # noqa: E731
    backup.inspect = Result(1, "", "ERROR: 백업 파일을 읽을 수 없습니다(tar 형식이 아니거나 손상)")
    assert (up()["status"], client.get("/api/restore/file").json()["reason"]) == ("invalid", "not_a_backup")
    backup.inspect = Result(1, "", "ERROR: 백업 형식 버전 9 은(는) 이 버전이 읽을 수 없습니다(읽을 수 있는 버전: 1)")
    assert up()["reason"] == "format_unsupported"
    backup.inspect = None
    backup.verify = {"ok": False, "problems": ["db.dump: 내용이 기록과 다릅니다(SHA-256 불일치)"]}
    assert up()["status"] == "corrupt"
    backup.verify = {"ok": True, "problems": []}
    backup.summary["config_included"] = False
    assert up()["reason"] == "no_config"
    backup.summary["config_included"] = True
    assert up()["status"] == "ok"

    # 서버 경로 — 존재하지 않는 파일, 잘못된 경로
    backup.inspect = Result(125, "", "docker: Error response from daemon: invalid mount config for type \"bind\": "
                                     "bind source path does not exist: /srv/none.jwbak")
    r = client.post("/api/restore/path", json={"path": "/srv/none.jwbak"}).json()
    assert (r["status"], r["source"], r["path"]) == ("not_found", "path", "/srv/none.jwbak")
    assert client.post("/api/restore/path", json={"path": "../etc/passwd"}).json()["reason"] == "path_invalid"
    backup.inspect = None
    r = client.post("/api/restore/path", json={"path": "/srv/backups/ws.jwbak"}).json()
    assert (r["status"], r["name"], r["size_bytes"]) == ("ok", "ws.jwbak", 20_000_000)
    assert "type=bind,source=/srv/backups/ws.jwbak,target=/restore-src,readonly" in host.runner.find("app.cli", "backup", "inspect")[-1]


def test_password_protected_backup(tmp_path):
    host, backup, svc, client = wizard(tmp_path, summary={**SUMMARY, "config_encrypted": True}, password="open sesame")
    r = client.post("/api/restore/path", json={"path": "/srv/ws.jwbak"}).json()
    assert r["status"] == "password_required" and client.get("/api/restore/review").status_code == 409
    verified = len(host.runner.find("app.cli", "backup", "verify"))
    assert client.post("/api/restore/password", json={"password": "wrong"}).json()["status"] == "password_wrong"
    assert not (svc.paths.state / "restore" / "password").exists()
    assert client.post("/api/restore/password", json={"password": "a\nb"}).status_code == 422
    r = client.post("/api/restore/password", json={"password": "open sesame"}).json()
    assert r["status"] == "ok" and len(host.runner.find("app.cli", "backup", "verify")) == verified   # 해시는 재계산하지 않는다
    extract = host.runner.find("app.cli", "backup", "extract-config")[-1]
    assert "--password-file" in extract and "open sesame" not in " ".join(extract)       # 암호는 인자에 포함하지 않는다
    assert client.post("/api/restore/password", json={"password": "x"}).status_code == 409


def test_upload_cancel_leaves_nothing_and_needs_space(tmp_path, monkeypatch):
    host, backup, svc, client = wizard(tmp_path)
    mgr = svc.cache["restore"]
    part = mgr.begin_upload("a.jwbak", 10)
    part.write_bytes(b"half")
    assert mgr.info()["state"] == "uploading"
    mgr.abort_upload(part)
    assert not part.exists() and mgr.info()["status"] == "none"
    with pytest.raises(restore.RestoreError) as e:
        mgr.begin_upload("a.jwbak", 10 ** 18)
    assert (e.value.status, e.value.code) == (507, "no_space")


def test_newer_backup_and_short_memory_block(tmp_path):
    host, backup, svc, client = wizard(tmp_path, summary={**SUMMARY, "schema_version": 9, "product_version": "9.9.0"})
    client.post("/api/restore/path", json={"path": "/srv/ws.jwbak"})
    review = client.get("/api/restore/review").json()
    assert review["version_status"] == "newer" and review["version_reason"] == "schema"
    assert review["blockers"][0]["code"] == "version_newer" and review["blockers"][0]["vars"]["installer_schema"] == 3
    r = client.post("/api/restore/apply", json={"domain": "old.example.com", "storage": {"kind": "local"}})
    assert r.status_code == 422 and ("mode", "version_newer") in {(e["field"], e["code"]) for e in r.json()["vars"]["errors"]}

    backup.summary.update(schema_version=3, product_version="1.0.0")
    client.post("/api/restore/path", json={"path": "/srv/ws.jwbak"})
    svc.store.update_facts(memory_mb=4096)
    assert client.get("/api/restore/review").json()["blockers"][0]["code"] == "memory_insufficient"
    r = client.post("/api/restore/apply", json={"domain": "old.example.com", "storage": {"kind": "local"}})
    assert ("zones", "memory_insufficient") in {(e["field"], e["code"]) for e in r.json()["vars"]["errors"]}


# ─── 저장소: NFS 기반 백업 ───

NFS_SUMMARY = {**SUMMARY, "storage": {"kind": "nfs", "server": "nas.example.com", "export": "/volume1/ws"},
               "files_included": False, "files_bytes": None,
               "items": ["db", "config", "mail", "gitea", "plugins-data", "certs"]}
NFS_TARGET = {"domain": "old.example.com", "storage": {"kind": "nfs", "server": "nas.example.com", "export": "/volume1/ws"}}


def test_nfs_backup_locks_local_and_checks_marker(tmp_path):
    host, backup, svc, client = wizard(tmp_path, summary=NFS_SUMMARY)
    svc.store.save_answers(ans.load({"mode": "restore"}))
    client.post("/api/restore/path", json={"path": "/srv/ws.jwbak"})
    review = client.get("/api/restore/review").json()
    assert review["storage"] == {"kind": "nfs", "server": "nas.example.com", "export": "/volume1/ws"}
    assert review["files_included"] is False

    def errors(target):
        r = client.post("/api/restore/apply", json=target)
        return {(e["field"], e["code"]) for e in r.json()["vars"]["errors"]} if r.status_code == 422 else r.status_code

    # 로컬은 선택 불가
    assert errors({"domain": "old.example.com", "storage": {"kind": "local"}}) == {("storage.kind", "storage_must_be_nfs")}
    # 다른 공유(저장소 마커 없음) · 다른 설치의 공유
    assert errors(NFS_TARGET) == {("storage", "storage_marker_missing")}
    backup.marker = {"status": "found", "install_id": "ffffffff-0000-0000-0000-000000000000"}
    assert errors(NFS_TARGET) == {("storage", "storage_other_install")}

    # 화면의 연결 확인(다섯 항목)에도 저장소 마커 대조가 포함된다
    host.runner.on("app.helper", "nfs-test", out=json.dumps({"write": None, "lock": None, "free_bytes": 50 * 1024 ** 3}) + "\n")
    import app.probes as probes_mod
    real = probes_mod.tcp_reachable
    probes_mod.probe_nfs.__kwdefaults__["reachable"] = lambda host_, port: True
    try:
        probe = client.post("/api/probe/nfs", json={"server": "nas.example.com", "export": "/volume1/ws"}).json()
        assert probe["ok"] is False and probe["cause"] == "other_install" and probe["marker"] == {"status": "mismatch"}
        assert all(s["status"] == "pass" for s in probe["steps"])
        backup.marker = {"status": "found", "install_id": BACKUP_ID}
        probe = client.post("/api/probe/nfs", json={"server": "nas.example.com", "export": "/volume1/ws"}).json()
        assert probe["ok"] is True and probe["marker"] == {"status": "match"}
    finally:
        probes_mod.probe_nfs.__kwdefaults__["reachable"] = real

    host.marker = {"status": "exists"}
    assert errors(NFS_TARGET) == 202
    svc.engine._thread.join(30)
    state = svc.engine.status()
    assert state["status"] == "done", state["error"]
    assert [s["id"] for s in state["steps"]] == ["unpack", "storage", "pull", "database", "cert", "zones"]   # 파일 복원 없음
    assert state["restore"] == {"files": "nfs", "storage_kind": "nfs", "cert": "auto", "domain_changed": False}
    assert host.volumes["ws-storage-data"]["Options"]["device"] == ":/volume1/ws"
    marker = host.runner.find("app.helper", "write-marker")[-1]
    assert marker[marker.index("--install-id") + 1] == BACKUP_ID
    assert not host.runner.find("app.helper", "restore-files")


def test_marker_judgement():
    assert restore.judge_marker({"status": "found", "install_id": BACKUP_ID}, BACKUP_ID)["status"] == "match"
    assert restore.judge_marker({"status": "found", "install_id": "other"}, BACKUP_ID)["status"] == "mismatch"
    assert restore.judge_marker({"status": "found", "install_id": ""}, "")["status"] == "mismatch"
    assert restore.judge_marker({"status": "missing"}, BACKUP_ID)["status"] == "missing"
    assert restore.judge_marker({"status": "error"}, BACKUP_ID)["status"] == "unknown"


# ─── 적용 ───


def run_restore(svc, mgr, target):
    mgr.use_path("/srv/backups/ws.jwbak")
    mgr.start(target)
    svc.engine._thread.join(60)
    return svc.engine.status()


def test_restore_to_new_address_with_files(tmp_path):
    host, backup, svc, mgr = make(tmp_path)
    new_installer_id = svc.store.install()["install_id"]
    state = run_restore(svc, mgr, {"domain": "new.example.com", "storage": {"kind": "local"}})
    assert state["status"] == "done", state["error"]
    assert [s["id"] for s in state["steps"]] == ["unpack", "pull", "database", "files", "cert", "zones"]
    assert state["mode"] == "restore"
    assert state["restore"] == {"files": "restored", "storage_kind": "local", "cert": "temporary", "domain_changed": True}

    env = env_of(host)
    assert env["SECRET_KEY"] == OLD_KEY                                    # 암호화 키는 변경되지 않는다
    assert env["JW_INSTALL_ID"] == BACKUP_ID != new_installer_id and svc.store.install()["install_id"] == BACKUP_ID
    assert env["APP_URL"] == "https://new.example.com" and env["DOMAIN"] == "example.com"
    assert env["APP_NAME"] == "Acme Workspace" and env["BRAND_COLOR"] == "#123456" and "GPU_HOST_IP" not in env
    assert env["JW_INSTALLER_KEY"] and env["JW_INSTALLER_KEY"] != OLD_ENV["JW_INSTALLER_KEY"]
    assert env["JW_ZONES"] == "core,mail,chat,calendar,docs,git" and env["GITEA_IMAGE"] == "gitea/gitea:1.24.0"
    assert svc.store.facts().dns_status == "mismatch" and svc.store.load_answers().access.cert == "temporary"

    r = host.runner
    call = r.find("compose", "run", "backend", "app.cli", "restore")[0]
    assert call[call.index("-v") + 1] == "/srv/backups/ws.jwbak:/restore-src:ro" and call[call.index("--user") + 1] == "0"
    # 주소가 변경되었으므로 인증서는 복원하지 않는다. 설정은 병합하여 별도로 기록하며, 파일은 파일 단계가 담당한다
    assert call[call.index("--items") + 1] == "db,mail,gitea,plugins-data" and "--with-config" not in call
    created = r.find("compose", "up", "--no-start")[0]
    assert created[-2:] == ["mailserver", "gitea"]
    # 순서: 빈 DB → 데이터 → 스키마 → 파일 → backend
    order = [r.index("compose", "up", "-d", "postgres"), r.index("compose", "run", "backend", "app.cli", "restore"),
             r.index("compose", "run", "backend", "migrate"), r.index("app.helper", "restore-files"),
             r.index("compose", "up", "-d", "backend")]
    assert order == sorted(order)
    files = r.find("app.helper", "restore-files")[0]
    assert "type=bind,source=/srv/backups/ws.jwbak,target=/restore-src,readonly" in files and "ws-storage-data:/storage" in files
    assert files[files.index("--member") + 1] == "files.tar" and "--user" not in files[:files.index("sha256:selfimage")]
    assert r.index("app.helper", "restore-files") < len(r.calls) and r.find("app.helper", "write-marker")
    # 코드 저장소의 로그인 원본은 새 주소로 갱신한다
    update = r.find("exec", "ws-gitea", "auth", "update-oauth")[0]
    assert update[update.index("--id") + 1] == "1"
    assert update[update.index("--auto-discover-url") + 1] == "https://new.example.com/oauth/.well-known/openid-configuration"
    assert not r.find("exec", "ws-backend", "seed-admin") and not r.find("exec", "ws-backend", "configure")
    # 잠금 · 정리
    assert svc.store.locked and not (svc.paths.state / "restore" / "config").exists()
    assert svc.store.read("restore.json")["summary"]["install_id"] == BACKUP_ID
    logs = "".join(p.read_text(encoding="utf-8") for p in host.paths.logs.glob("*.log"))
    assert OLD_KEY not in logs and SECRETS["DB_PASSWORD"] not in logs


def test_same_address_keeps_certs_and_local_without_files_warns_nothing(tmp_path):
    summary = {**SUMMARY, "files_included": False, "files_bytes": None,
               "items": ["db", "config", "mail", "gitea", "plugins-data", "certs"]}
    host, backup, svc, mgr = make(tmp_path, summary=summary)
    host.issued_cert = True
    state = run_restore(svc, mgr, {"domain": "old.example.com", "storage": {"kind": "local"}})
    assert state["status"] == "done", state["error"]
    assert "files" not in [s["id"] for s in state["steps"]]
    assert state["restore"]["files"] == "not_included" and state["restore"]["domain_changed"] is False
    call = host.runner.find("compose", "run", "backend", "app.cli", "restore")[0]
    assert call[call.index("--items") + 1] == "db,mail,gitea,plugins-data,certs"     # 주소가 동일하고 자동 발급 — 인증서도 복원한다
    assert host.runner.find("compose", "up", "--no-start")[0][-3:] == ["mailserver", "gitea", "nginx"]


def test_data_restore_failure_then_retry(tmp_path):
    host, backup, svc, mgr = make(tmp_path)
    backup.restore_result = Result(1, json.dumps({"ok": False, "stage": "db-load", "error": "pg_restore: connection refused",
                                                  "state": "기존 데이터는 그대로입니다", "done": ["verify"]}), "ERROR: 복원 실패")
    state = run_restore(svc, mgr, {"domain": "new.example.com", "storage": {"kind": "local"}})
    assert state["status"] == "failed" and state["error"]["step"] == "database"
    assert state["error"]["cause"] == "restore_database_failed" and state["error"]["vars"]["stage"] == "db-load"
    assert not svc.store.locked and mgr.ready
    assert "db-load" not in "".join(state["error"]["vars"]) and "connection refused" in state["error"]["vars"]["detail"]

    pulls = len(host.runner.find("pull"))
    backup.restore_result = {"ok": True, "stages": [], "schema": [3, 3]}
    assert svc.engine.retry()
    svc.engine._thread.join(60)
    state = svc.engine.status()
    assert state["status"] == "done", state["error"]
    assert len(host.runner.find("pull")) == pulls                           # 완료된 단계(이미지 pull)는 재실행되지 않는다
    assert len(host.runner.find("compose", "run", "backend", "app.cli", "restore")) == 2 and svc.store.locked


def test_plan_steps_follow_backup_and_target(tmp_path, catalog):
    host, backup, svc, mgr = make(tmp_path)
    mgr.use_path("/srv/ws.jwbak")
    facts = svc.store.facts()

    def steps(target):
        answers, _, errors = mgr.build_answers(target)
        assert errors == [], errors
        return restore.plan_steps(answers, render.derive(answers, facts, catalog), svc.store)

    local = {"domain": "new.example.com", "storage": {"kind": "local"}}
    assert steps(local) == ["unpack", "pull", "database", "files", "cert", "zones"]
    assert steps({**local, "storage": {"kind": "nfs", "server": "nas.example.com", "export": "/v"}}) == \
        ["unpack", "storage", "pull", "database", "files", "cert", "zones"]          # 로컬 백업을 NFS 로 이전한다
    backup.summary.update(files_included=False)
    mgr.use_path("/srv/ws.jwbak")
    assert steps(local) == ["unpack", "pull", "database", "cert", "zones"]
    proxy = steps({**local, "network": "proxy", "proxy_addresses": ["192.168.10.5"]})
    assert proxy == ["unpack", "pull", "database", "cert", "zones"]                   # 메일의 인증서 위치는 프록시 뒤에서도 필요하다


def test_restored_dkim_key_is_kept(tmp_path):
    host, backup, svc, mgr = make(tmp_path)
    from app import dkim

    old_key = dkim.generate_private_key()

    def restore_cli(argv, _):
        target = host.paths.stack / "mailserver" / "config" / "rspamd" / "dkim" / "default.private"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(old_key, encoding="utf-8")
        return json.dumps({"ok": True, "items": ["db", "mail"], "stages": [], "schema": [3, 3]})

    host.runner.on("compose", "run", "backend", "app.cli", "restore", fn=restore_cli)
    state = run_restore(svc, mgr, {"domain": "new.example.com", "storage": {"kind": "local"}})
    assert state["status"] == "done", state["error"]
    kept = (host.paths.stack / "mailserver" / "config" / "rspamd" / "dkim" / "default.private").read_text(encoding="utf-8")
    assert kept.strip() == old_key.strip()
    assert (host.paths.state / "dkim" / "example.com.pem").read_text(encoding="utf-8") == old_key


# ─── 무인(jw apply --answers) ───


def test_unattended_restore(tmp_path, monkeypatch, capsys):
    host, backup, svc, mgr = make(tmp_path)
    monkeypatch.setattr(cli, "_services", lambda args: svc)
    monkeypatch.setenv("JW_INTERNAL_PORT", "1")
    path = tmp_path / "restore.json"
    path.write_text(json.dumps({"mode": "restore", "restore": {"path": "/srv/backups/ws.jwbak"},
                                "access": {"domain": "new.example.com", "network": "direct", "cert": "temporary"},
                                "storage": {"kind": "local"}}), encoding="utf-8")
    assert cli.main(["apply", "--answers", str(path), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "unpack → pull → database → files → cert → zones" in out and "new.example.com" in out
    assert not (svc.paths.state / "restore").exists() and not svc.paths.env_file.exists()      # 아무것도 남기지 않는다

    assert cli.main(["apply", "--answers", str(path)]) == 0
    assert "설치가 끝났습니다" in capsys.readouterr().out and svc.store.locked
    assert env_of(host)["SECRET_KEY"] == OLD_KEY and env_of(host)["APP_URL"] == "https://new.example.com"
    assert cli.main(["apply", "--answers", str(path)]) == 1                                    # 이미 완료된 설치


def test_unattended_restore_reports_problems(tmp_path, monkeypatch, capsys):
    host, backup, svc, mgr = make(tmp_path, summary={**SUMMARY, "config_encrypted": True}, password="pw-1234")
    monkeypatch.setattr(cli, "_services", lambda args: svc)
    monkeypatch.setenv("JW_INTERNAL_PORT", "1")
    path = tmp_path / "restore.json"

    def run(data):
        path.write_text(json.dumps({"mode": "restore", "access": {"domain": "old.example.com"}, **data}), encoding="utf-8")
        code = cli.main(["apply", "--answers", str(path), "--dry-run"])
        return code, capsys.readouterr().out

    assert run({})[1].count("restore.path: required") == 1
    code, out = run({"restore": {"path": "/srv/ws.jwbak"}})
    assert code == 1 and "password_required" in out
    monkeypatch.setenv("JW_BACKUP_PASSWORD", "nope")
    assert "password_wrong" in run({"restore": {"path": "/srv/ws.jwbak"}})[1]
    monkeypatch.setenv("JW_BACKUP_PASSWORD", "pw-1234")
    code, out = run({"restore": {"path": "/srv/ws.jwbak"}, "storage": {"kind": "nfs", "server": "nas.example.com", "export": "/v"}})
    assert code == 0, out
    backup.summary["storage"] = {"kind": "nfs", "server": "nas.example.com", "export": "/v"}
    code, out = run({"restore": {"path": "/srv/ws.jwbak"}, "storage": {"kind": "local"}})
    assert code == 1 and "storage_must_be_nfs" in out


# ─── 보조 명령(저장소 마커 조회 · 파일 복원) ───


def test_helper_read_marker_and_restore_files(tmp_path, capsys):
    import io
    import tarfile

    from app import helper

    storage = tmp_path / "storage"
    storage.mkdir()
    assert helper.main(["read-marker", str(storage)]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "missing"
    (storage / ".jw-storage").write_text(json.dumps({"install_id": BACKUP_ID}), encoding="utf-8")
    helper.main(["read-marker", str(storage)])
    assert json.loads(capsys.readouterr().out) == {"status": "found", "install_id": BACKUP_ID}

    # 백업(tar) 내부의 files.tar 를 저장소에 푼다 — 기존 내용은 삭제하고 백업 시점 상태로 복원한다
    inner = io.BytesIO()
    with tarfile.open(fileobj=inner, mode="w") as t:
        for name, data in (("./.jw-storage", b'{"install_id": "x"}'), ("./users/1/a.txt", b"hello"), ("./users/1/b.bin", b"\x00" * 10)):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    outer = tmp_path / "ws.jwbak"
    with tarfile.open(outer, mode="w") as t:
        for name, data in (("manifest.json", b"{}"), ("db.dump", b"dump"), ("files.tar", inner.getvalue())):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    (storage / "stale.txt").write_text("old", encoding="utf-8")
    assert helper.main(["restore-files", str(outer), str(storage), "--member", "files.tar", "--uid", "0"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["status"] == "restored" and out["bytes"] == 15 + len(b'{"install_id": "x"}')
    assert (storage / "users" / "1" / "a.txt").read_bytes() == b"hello" and not (storage / "stale.txt").exists()
    # 폴더 형식 백업
    folder = tmp_path / "dir-backup"
    folder.mkdir()
    (folder / "files.tar").write_bytes(inner.getvalue())
    assert helper.main(["restore-files", str(folder), str(storage), "--member", "files.tar", "--uid", "0"]) == 0
    assert json.loads(capsys.readouterr().out)["entries"] >= 3
    helper.main(["restore-files", str(outer), str(storage), "--member", "nope.tar", "--uid", "0"])
    assert json.loads(capsys.readouterr().out)["error"] == "source_unreadable"
