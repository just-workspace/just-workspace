"""구역 훅 — 기본 동작, Gitea 훅의 순서와 명령, 설치 뒤 켜고 끄기."""

import json

import pytest

from app import envfile, zonectl, zones
from app.docker_api import Result
from app.zones import git as git_hook
from tests.harness import Host

AUTH_LIST_EMPTY = "ID\tName\tType\tEnabled\n"
AUTH_LIST_ONE = AUTH_LIST_EMPTY + "1\tworkspace\tOAuth2\ttrue\n"
TOKEN = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"


def gitea_host(tmp_path) -> Host:
    host = Host(tmp_path)
    host.services += ["mailserver", "onlyoffice", "gitea", "livekit", "egress", "audiorelay", "searxng", "docconv", "sandbox"]
    host.auth_list = AUTH_LIST_EMPTY

    def add_oauth(argv, _):
        host.auth_list = AUTH_LIST_ONE
        return ""
    r = host.runner
    r.on("exec", "ws-gitea", "auth", "list", fn=lambda argv, i: host.auth_list)
    r.on("exec", "ws-gitea", "auth", "add-oauth", fn=add_oauth)
    r.on("exec", "ws-gitea", "generate-access-token", out=TOKEN + "\n")
    host.http.responses["http://gitea:3000/api/v1/user"] = 401      # 아직 토큰이 없다
    return host


def env_of(host):
    return envfile.parse(host.paths.env_file.read_text(encoding="utf-8"))


# ─── 기본 훅 ───


def test_default_hook_for_zone_without_module():
    hook = zones.get("chat")
    assert hook.install is zones.default_install and hook.remove is zones.default_remove
    assert zones.get("git").install is git_hook.install
    with pytest.raises(ValueError):
        zones.get("../evil")


def test_install_starts_only_services_of_active_profiles(tmp_path):
    host = Host(tmp_path)
    host.services += ["mailserver", "onlyoffice"]
    svc = host.install()
    assert svc.engine.run()["status"] == "done"
    r = host.runner
    assert r.find("compose", "up", "mailserver") and r.find("compose", "up", "onlyoffice")
    # 컨테이너가 없는 구역(채팅·일정)은 아무것도 띄우지 않는다
    ups = [c[c.index("up"):] for c in r.find("compose", "up")]
    assert not any("chat" in u or "calendar" in u for u in ups)
    zone_rows = svc.engine.status()["steps"][4]["detail"]["zones"]
    assert zone_rows == [{"id": z, "status": "done"} for z in ("mail", "chat", "calendar", "docs")]


def test_zone_start_failure_names_the_zone(tmp_path):
    host = Host(tmp_path)
    host.services += ["mailserver", "onlyoffice"]
    host.unhealthy.add("ws-onlyoffice")
    svc = host.install()
    state = svc.engine.run()
    assert state["error"]["step"] == "zones" and state["error"]["cause"] == "service_not_ready"
    assert state["error"]["vars"]["zone"] == "docs" and state["error"]["vars"]["container"] == "ws-onlyoffice"


# ─── Gitea ───


def test_gitea_hook_order_and_commands(tmp_path):
    host = gitea_host(tmp_path)
    svc = host.install(preset=None, zones=["git"], mail={})
    state = svc.engine.run()
    assert state["status"] == "done", state["error"]
    r = host.runner

    order = [
        r.index("compose", "up", "gitea"),                               # 컨테이너 시작
        r.index("exec", "ws-gitea", "environment-to-ini"),               # 초기 설정(app.ini)
        r.index("restart", "ws-gitea"),
        r.index("exec", "ws-gitea", "admin", "user", "create"),          # 관리 계정
        r.index("exec", "ws-gitea", "generate-access-token"),            # 관리 토큰
        r.index("exec", "ws-gitea", "auth", "add-oauth"),                # 로그인 연동
    ]
    assert order == sorted(order)
    backend_ups = [i for i, c in enumerate(r.calls) if "up" in c and c[-1] == "backend"]
    assert backend_ups and backend_ups[-1] > order[-1]                   # 연동 값이 들어간 뒤 backend 를 다시 띄운다

    ini = r.find("exec", "ws-gitea", "environment-to-ini")[0]
    assert ini[ini.index("--user") + 1] == "git" and "--env-file" in ini
    assert svc.store.env_secrets()["DB_PASSWORD"] not in " ".join(ini)   # DB 비밀번호는 인자에 없다

    create = r.find("exec", "ws-gitea", "admin", "user", "create")[0]
    assert "--admin" in create and create[create.index("--username") + 1] == "jw-admin" and "--random-password" in create

    token_cmd = r.find("exec", "ws-gitea", "generate-access-token")[0]
    assert token_cmd[token_cmd.index("--scopes") + 1] == "all" and "--raw" in token_cmd

    oauth = r.find("exec", "ws-gitea", "auth", "add-oauth")[0]
    assert oauth[oauth.index("--provider") + 1] == "openidConnect" and oauth[oauth.index("--key") + 1] == "gitea"
    assert oauth[oauth.index("--auto-discover-url") + 1] == "https://ws.example.com/oauth/.well-known/openid-configuration"

    # backend 설정에 주입 — 토큰, OAuth 클라이언트(리다이렉트 주소는 Gitea 의 콜백과 정확히 같아야 한다)
    env = env_of(host)
    assert env["GITEA_TOKEN"] == TOKEN and env["GITEA_URL"] == "http://gitea:3000"
    client = json.loads(env["OAUTH_CLIENTS_JSON"])["gitea"]
    assert client["redirect_uris"] == ["https://ws.example.com/git/user/oauth2/workspace/callback"]
    assert client["scopes"] == ["openid", "email", "profile"] and client["trusted"] is True
    assert client["secret"] == oauth[oauth.index("--secret") + 1] and len(client["secret"]) == 48
    assert env["JW_ZONES"] == "core,git" and env["COMPOSE_PROFILES"] == "gitea,certbot"

    # 앞단 경로 확인은 nginx 를 거쳐서
    assert ("https://nginx/git/api/healthz", {"Host": "ws.example.com"}) in host.http.calls
    # 토큰은 로그에 남지 않는다
    logs = "".join(p.read_text(encoding="utf-8") for p in host.paths.logs.glob("*.log"))
    assert TOKEN not in logs and client["secret"] not in logs


def test_gitea_hook_is_idempotent(tmp_path):
    host = gitea_host(tmp_path)
    svc = host.install(preset=None, zones=["git"], mail={})
    svc.engine.run()
    host.http.responses["http://gitea:3000/api/v1/user"] = 200           # 넣어 둔 토큰이 살아 있다
    host.runner.on("exec", "ws-gitea", "admin", "user", "create", rc=1, err="user already exists")
    before = env_of(host)
    svc.store.set_phase("applying")
    svc.store.update_env_secrets({})
    from tests.conftest import make_answers

    svc.store.save_answers(make_answers(preset=None, zones=["git"], mail={}))
    state = svc.engine.run()
    assert state["status"] == "done", state["error"]
    assert len(host.runner.find("exec", "ws-gitea", "generate-access-token")) == 1
    assert len(host.runner.find("exec", "ws-gitea", "auth", "add-oauth")) == 1
    assert env_of(host)["GITEA_TOKEN"] == before["GITEA_TOKEN"]
    assert env_of(host)["OAUTH_CLIENTS_JSON"] == before["OAUTH_CLIENTS_JSON"]


def test_gitea_sso_failure_is_warning_not_failure(tmp_path):
    host = gitea_host(tmp_path)
    host.runner.on("exec", "ws-gitea", "auth", "add-oauth", rc=1, err="x509: certificate signed by unknown authority")
    host.http.responses["https://nginx/git/api/healthz"] = 502
    svc = host.install(preset=None, zones=["git"], mail={})
    state = svc.engine.run()
    assert state["status"] == "done"
    assert {w["key"] for w in state["warnings"]} >= {"git_sso_pending", "git_front_path_unverified"}


def test_gitea_failures_have_causes(tmp_path):
    host = gitea_host(tmp_path)
    host.runner.on("exec", "ws-gitea", "generate-access-token", rc=1, err="boom")
    svc = host.install(preset=None, zones=["git"], mail={})
    state = svc.engine.run()
    assert state["error"]["cause"] == "git_token_failed" and state["error"]["vars"]["zone"] == "git"

    host2 = gitea_host(tmp_path / "b")
    host2.http.responses["http://gitea:3000/api/healthz"] = 0
    svc2 = host2.install(preset=None, zones=["git"], mail={})
    assert svc2.engine.run()["error"]["cause"] == "git_not_responding"


def test_gitea_version_choice_reaches_compose_env(tmp_path):
    host = gitea_host(tmp_path)
    svc = host.install(preset=None, zones=["git"], mail={}, git={"version": "1.25.2"})
    svc.engine.run()
    assert env_of(host)["GITEA_IMAGE"] == "gitea/gitea:1.25.2"


# ─── 설치 뒤 켜고 끄기 ───


def installed(tmp_path, **answers):
    host = gitea_host(tmp_path)
    svc = host.install(**answers)
    assert svc.engine.run()["status"] == "done"
    return host, svc


def finish(svc, job):
    svc.zones.wait(30)
    return svc.zones.job(job["id"])


def test_enable_git_after_install(tmp_path):
    host, svc = installed(tmp_path)
    assert "git" not in svc.zones.enabled()
    check = svc.zones.check("git", {"version": "tested"})
    assert check["ok"] and check["ports"] == ["2222/tcp"] and check["memory"]["ok"]
    job = svc.zones.enable("git", {"version": "tested"})
    assert job["status"] == "running" and job["ports"] == ["2222/tcp"]
    assert [s["id"] for s in job["stages"]] == ["pull", "configure", "connect"]
    job = finish(svc, job)
    assert job["status"] == "done", job["error"]
    assert [s["status"] for s in job["stages"]] == ["done"] * 3
    env = env_of(host)
    assert env["JW_ZONES"] == "core,mail,chat,calendar,docs,git" and "gitea" in env["COMPOSE_PROFILES"].split(",")
    assert env["GITEA_TOKEN"] == TOKEN
    assert "ws-gitea" in host.running and "git" in svc.zones.enabled()
    with pytest.raises(zonectl.ZoneRequestError) as e:
        svc.zones.enable("git")
    assert e.value.code == "already_enabled"


def test_enable_failure_leaves_zone_off(tmp_path):
    host, svc = installed(tmp_path)
    before = env_of(host)
    host.runner.on("exec", "ws-gitea", "generate-access-token", rc=1, err="boom")
    job = finish(svc, svc.zones.enable("git", {"version": "latest"}))
    assert job["status"] == "failed" and job["error"]["cause"] == "git_token_failed"
    assert [s["status"] for s in job["stages"]] == ["done", "done", "failed"]
    assert "git" not in svc.zones.enabled()
    after = env_of(host)
    assert after["JW_ZONES"] == before["JW_ZONES"] and after["COMPOSE_PROFILES"] == before["COMPOSE_PROFILES"]
    assert after["GITEA_TOKEN"] == "" and "ws-gitea" not in host.running        # 컨테이너도 멈춘다
    assert host.runner.find("compose", "stop", "gitea")


def test_enable_refused_when_memory_is_short(tmp_path):
    host, svc = installed(tmp_path)
    host.runner.on("info", "--format", out=json.dumps({"MemTotal": 7 * 1024 ** 3, "NCPU": 4}))
    check = svc.zones.check("meetings", {"turn": True, "lossless_audio": False})
    assert not check["ok"] and not check["memory"]["ok"] and check["memory"]["need_mb"] == 8000
    with pytest.raises(zonectl.ZoneRequestError) as e:
        svc.zones.enable("meetings", {"turn": True})
    assert e.value.status == 409 and e.value.code == "memory_insufficient"
    assert not svc.zones.jobs()


def test_enable_validates_settings(tmp_path):
    _, svc = installed(tmp_path, preset=None, zones=["chat"], mail={})
    with pytest.raises(zonectl.ZoneRequestError) as e:
        svc.zones.enable("mail", {"kind": "external", "host": "smtp.example.net"})
    fields = {x["field"] for x in e.value.vars["errors"]}
    assert e.value.code == "settings_invalid" and {"mail.username", "mail.password"} <= fields
    with pytest.raises(zonectl.ZoneRequestError) as e:
        svc.zones.enable("ai", {"mode": "now", "provider": "google", "bogus": 1})
    assert e.value.code == "settings_invalid" and e.value.vars["errors"][0]["code"] == "unknown_field"
    with pytest.raises(zonectl.ZoneRequestError) as e:
        svc.zones.enable("nope")
    assert e.value.status == 404


def test_enable_ai_with_provider_passes_key_on_stdin(tmp_path):
    host, svc = installed(tmp_path)
    job = finish(svc, svc.zones.enable("ai", {"mode": "now", "provider": "google", "api_key": "g-secret-key-123"}))
    assert job["status"] == "done", job["error"]
    i = host.runner.index("exec", "ws-backend", "app.cli", "configure")
    assert "g-secret-key-123" not in " ".join(host.runner.calls[i])
    payload = json.loads(host.runner.inputs[i])
    assert payload["ai"] == {"kind": "gemini", "model": "", "base_url": "", "api_key": "g-secret-key-123"}
    assert "ai.api_key" not in svc.store.answer_secrets()          # 넣은 뒤에는 보관하지 않는다
    got = svc.zones.get_settings("ai")
    assert got["enabled"] and got["settings"]["mode"] == "now" and got["settings"]["provider"] == "google"
    assert "api_key" not in got["settings"] and got["settings"]["api_key_set"] is False


def test_disable_keeps_data_volume(tmp_path):
    host, svc = installed(tmp_path)
    finish(svc, svc.zones.enable("git"))
    job = finish(svc, svc.zones.disable("git"))
    assert job["status"] == "done", job["error"]
    assert host.runner.find("exec", "ws-gitea", "auth", "delete", "--id", "1")
    assert host.runner.find("compose", "stop", "gitea") and host.runner.find("compose", "rm", "-f", "gitea")
    assert not host.runner.find("volume", "rm")                          # 데이터 볼륨은 남긴다
    assert not any("-v" in c or "--volumes" in c for c in host.runner.find("compose", "rm"))
    env = env_of(host)
    assert "git" not in env["JW_ZONES"].split(",") and env["GITEA_TOKEN"] == ""
    assert "gitea" not in json.loads(env["OAUTH_CLIENTS_JSON"])
    with pytest.raises(zonectl.ZoneRequestError):
        svc.zones.disable("git")


def test_settings_roundtrip_and_update(tmp_path):
    host, svc = installed(tmp_path)
    got = svc.zones.get_settings("mail")["settings"]
    assert got["kind"] == "builtin" and got["mail_domain"] == "example.com" and got["password_set"] is False
    assert svc.zones.get_settings("chat")["settings"] == {}
    assert svc.zones.get_settings("git")["settings"] == {"version": "tested", "custom_version": None}
    with pytest.raises(zonectl.ZoneRequestError) as e:
        svc.zones.put_settings("chat", {})
    assert e.value.code == "zone_has_no_settings"
    with pytest.raises(zonectl.ZoneRequestError) as e:
        svc.zones.put_settings("git", {"version": "latest"})
    assert e.value.code == "not_enabled"

    finish(svc, svc.zones.enable("git"))
    job = finish(svc, svc.zones.put_settings("git", {"version": "custom", "custom_version": "1.25.2"}))
    assert job["status"] == "done" and job["kind"] == "update", job["error"]
    assert env_of(host)["GITEA_IMAGE"] == "gitea/gitea:1.25.2"
    assert svc.zones.get_settings("git")["settings"] == {"version": "custom", "custom_version": "1.25.2"}
    with pytest.raises(zonectl.ZoneRequestError):
        svc.zones.put_settings("git", {"version": "custom", "custom_version": "bad tag;"})


def test_zone_operations_need_finished_install(tmp_path):
    host = gitea_host(tmp_path)
    svc = host.install()
    with pytest.raises(zonectl.ZoneRequestError) as e:
        svc.zones.enable("git")
    assert e.value.code == "not_installed"
    assert isinstance(Result(0).ok, bool)


def test_internal_api_enable_flow(tmp_path):
    from starlette.testclient import TestClient

    from app import api

    host, svc = installed(tmp_path)
    headers = {api.KEY_HEADER: svc.store.env_secrets()["JW_INSTALLER_KEY"]}
    client = TestClient(api.create_internal_app(svc), client=("172.28.0.20", 5000))
    r = client.post("/internal/zones/git/check", json={"settings": {"version": "tested"}}, headers=headers)
    assert r.json()["ok"] and r.json()["ports"] == ["2222/tcp"]
    r = client.post("/internal/zones/git/enable", json={"settings": {"version": "tested"}}, headers=headers)
    assert r.status_code == 202
    svc.zones.wait(30)
    job = client.get(f"/internal/jobs/{r.json()['id']}", headers=headers).json()
    assert job["status"] == "done"
    assert client.get(f"/internal/jobs/{job['id']}/log", headers=headers).json()["lines"]
    r = client.post("/internal/zones/git/enable", json={}, headers=headers)
    assert r.status_code == 409 and r.json()["code"] == "already_enabled"
    r = client.put("/internal/zones/git/settings", json={"settings": {"version": "latest"}}, headers=headers)
    assert r.status_code == 202
    svc.zones.wait(30)
    assert client.get("/internal/zones/git/settings", headers=headers).json()["settings"]["version"] == "latest"
    assert client.post("/internal/zones/git/disable", headers=headers).status_code == 202
    svc.zones.wait(30)
    assert client.get("/internal/jobs/nope", headers=headers).status_code == 404
