"""설치 후의 인증서 — 상태, 재발급(자동·업로드), 실패 시 롤백, 보류된 구역 연결 재시도."""

import json

from starlette.testclient import TestClient

from app import api, api_cert, certs, envfile, zones
from tests.test_zones import TOKEN, finish, gitea_host

KEY_HEADERS = lambda svc: {api.KEY_HEADER: svc.store.env_secrets()["JW_INSTALLER_KEY"]}  # noqa: E731


def temporary_install(tmp_path, **answers):
    """임시 인증서 + 코드 저장소 — 인증서 문제로 로그인 연동이 적용되지 않은 설치."""
    host = gitea_host(tmp_path)
    host.trusted = False

    def oauth(argv, _):
        from app.docker_api import Result

        if not host.trusted:
            return Result(1, "", "Failed to initialize OpenID Connect Provider: x509: certificate signed by unknown authority")
        host.auth_list = "ID\tName\tType\tEnabled\n1\tworkspace\tOAuth2\ttrue\n"
        return ""

    host.runner.on("exec", "ws-gitea", "auth", "add-oauth", fn=oauth)
    host.runner.on("exec", "ws-gitea", "auth", "update-oauth", fn=oauth)
    svc = host.install(preset=None, zones=["git"], mail={}, access={"cert": "temporary"}, **answers)
    svc.store.update_facts(dns_status="mismatch")
    state = svc.engine.run()
    assert state["status"] == "done", state["error"]
    return host, svc


def test_temporary_install_records_pending_connection(tmp_path):
    host, svc = temporary_install(tmp_path)
    assert zones.pending(svc.store)["git"]["reason"] == "discovery_unreachable"
    rows = {z["id"]: z for z in svc.zones.listing()["zones"]}
    assert rows["git"]["pending"] is True and rows["git"]["pending_reason"] == "discovery_unreachable"
    assert rows["chat"]["pending"] is False                     # 비활성 구역은 보류 대상이 아니다

    status = api_cert.manager(svc).status()
    assert status["managed"] and status["mode"] == "temporary" and status["temporary"] and status["self_signed"]
    assert status["domain"] == "ws.example.com" and "ws.example.com" in status["names"]
    assert status["days_left"] > 300 and status["not_after"].endswith("Z") and status["pending"] == ["git"]
    assert status["job"] is None


def test_upload_reissue_reloads_and_reconnects(tmp_path):
    host, svc = temporary_install(tmp_path)
    client = TestClient(api.create_internal_app(svc), client=("127.0.0.1", 50000))
    assert client.get("/internal/cert").status_code == 404                      # 키가 없으면 존재하지 않는 경로로 응답한다
    h = KEY_HEADERS(svc)
    assert client.get("/internal/cert", headers=h).json()["temporary"] is True

    # 검증에 실패하는 인증서(다른 이름) → 422, 아무것도 변경하지 않는다
    wrong_cert, wrong_key = certs.self_signed(["other.example.com"])
    r = client.post("/internal/cert/reissue", headers=h, json={"mode": "upload", "cert": wrong_cert, "key": wrong_key})
    assert r.status_code == 422 and r.json()["code"] == "cert_invalid" and r.json()["vars"]["checks"]
    assert client.post("/internal/cert/reissue", headers=h, json={"mode": "magic"}).status_code == 422
    assert svc.store.load_answers().access.cert == "temporary"

    cert, key = certs.self_signed(["ws.example.com"], days=90)                 # 사설 CA 가 발급한 것으로 간주한다
    host.trusted = True
    restarts = len(host.runner.find("restart", "ws-nginx"))
    r = client.post("/internal/cert/reissue", headers=h, json={"mode": "upload", "cert": cert, "key": key})
    assert r.status_code == 202 and r.json()["kind"] == "cert" and r.json()["zone"] is None
    assert [s["id"] for s in r.json()["stages"]] == ["issue", "reload", "reconnect"]
    job = finish(svc, r.json())
    assert job["status"] == "done", job["error"]
    assert [s["status"] for s in job["stages"]] == ["done", "done", "done"] and job["warnings"] == []
    assert host.cert == cert and svc.store.load_answers().access.cert == "upload"
    assert svc.store.read("cert.json")["kind"] == "upload"
    assert len(host.runner.find("restart", "ws-nginx")) == restarts + 1         # 새 인증서를 다시 읽도록 재시작한다
    # 보류되었던 로그인 연동이 적용되었다
    assert zones.pending(svc.store) == {} and host.runner.find("exec", "ws-gitea", "auth", "add-oauth")
    status = client.get("/internal/cert", headers=h).json()
    assert status["mode"] == "upload" and status["pending"] == [] and status["days_left"] in (89, 90)
    env = envfile.parse(host.paths.env_file.read_text(encoding="utf-8"))
    assert "Strict-Transport-Security" in (host.paths.stack / "nginx/site.d/headers.conf").read_text(encoding="utf-8")
    assert json.loads(env["OAUTH_CLIENTS_JSON"])["gitea"] and env["GITEA_TOKEN"] == TOKEN
    jobs = client.get("/internal/jobs", headers=h).json()["jobs"]
    assert jobs[0]["kind"] == "cert"


def test_auto_reissue_failure_puts_the_old_certificate_back(tmp_path):
    host, svc = temporary_install(tmp_path)
    before = host.cert
    host.certbot_ok = False
    job = finish(svc, api_cert.manager(svc).reissue({"mode": "auto"}))
    assert job["status"] == "failed" and job["error"]["cause"] == "cert_dns_mismatch"      # 접속 주소의 DNS 불일치가 감지된 설치
    assert [s["status"] for s in job["stages"]] == ["failed", "pending", "pending"]
    assert svc.store.load_answers().access.cert == "temporary"                 # 응답(answers)이 롤백되었다
    assert certs.is_self_signed(host.cert) and host.cert                        # 임시 인증서가 다시 배치되었다
    assert "certbot" not in envfile.parse(host.paths.env_file.read_text(encoding="utf-8"))["COMPOSE_PROFILES"]
    assert zones.pending(svc.store)["git"] and before

    host.certbot_ok = True
    host.trusted = True
    host.services.append("certbot")                                             # 자동 발급이면 갱신 컨테이너가 프로파일에 포함된다
    job = finish(svc, api_cert.manager(svc).reissue({"mode": "auto"}))
    assert job["status"] == "done", job["error"]
    assert svc.store.load_answers().access.cert == "auto" and zones.pending(svc.store) == {}
    assert "certbot" in envfile.parse(host.paths.env_file.read_text(encoding="utf-8"))["COMPOSE_PROFILES"]
    assert host.runner.find("compose", "up", "-d", "certbot")


def test_reissue_refusals(tmp_path):
    import pytest

    from app.zonectl import ZoneRequestError

    host = gitea_host(tmp_path)
    svc = host.install(preset="minimal", mail={}, access={"network": "proxy", "cert": "proxy", "proxy_addresses": ["192.168.10.5"]})
    mgr = api_cert.manager(svc)
    with pytest.raises(ZoneRequestError) as e:
        mgr.reissue({"mode": "auto"})
    assert e.value.code == "not_installed"
    assert svc.engine.run()["status"] == "done"
    with pytest.raises(ZoneRequestError) as e:
        mgr.reissue({"mode": "auto"})
    assert (e.value.status, e.value.code) == (409, "cert_managed_by_proxy")
    assert mgr.status()["managed"] is False and mgr.status()["temporary"] is False


def test_reconnect_job(tmp_path):
    import pytest

    from app.zonectl import ZoneRequestError

    host, svc = temporary_install(tmp_path)
    client = TestClient(api.create_internal_app(svc), client=("127.0.0.1", 50000))
    h = KEY_HEADERS(svc)
    # 아직 신뢰할 수 없는 인증서 — 재시도해도 보류 상태로 유지되며 작업은 실패로 종료된다
    r = client.post("/internal/zones/git/reconnect", headers=h)
    assert r.status_code == 202 and r.json()["kind"] == "reconnect"
    job = finish(svc, r.json())
    assert job["status"] == "failed" and job["error"]["cause"] == "connection_still_pending"
    assert job["error"]["vars"] == {"zone": "git", "reason": "discovery_unreachable"}
    assert zones.pending(svc.store)["git"]

    host.trusted = True
    job = finish(svc, svc.zones.reconnect("git"))
    assert job["status"] == "done" and zones.pending(svc.store) == {}
    assert not {z["id"] for z in svc.zones.listing()["zones"] if z["pending"]}
    with pytest.raises(ZoneRequestError) as e:
        svc.zones.reconnect("git")
    assert e.value.code == "not_pending"
    with pytest.raises(ZoneRequestError) as e:
        svc.zones.reconnect("chat")
    assert e.value.code == "not_enabled"


def test_disabling_a_zone_clears_its_pending_mark(tmp_path):
    host, svc = temporary_install(tmp_path)
    job = finish(svc, svc.zones.disable("git"))
    assert job["status"] == "done" and zones.pending(svc.store) == {}


# ─── 업로드한 인증서의 발급 CA 를 코드 저장소의 신뢰 대상에 추가 ───


def test_uploaded_chain_is_trusted_by_the_git_container(tmp_path):
    from app import render

    host, svc = temporary_install(tmp_path)
    site = host.paths.stack / render.SITE_COMPOSE
    ca_file = host.paths.stack / render.SITE_CA_FILE
    assert "gitea" not in site.read_text(encoding="utf-8") and not ca_file.exists()

    leaf, key = certs.self_signed(["ws.example.com"], days=90)                 # 사설 CA 가 발급한 것으로 간주한다
    ca, _ = certs.self_signed(["Example Private CA"], days=3650)
    host.trusted = True
    job = finish(svc, api_cert.manager(svc).reissue({"mode": "upload", "cert": leaf + ca, "key": key}))
    assert job["status"] == "done", job["error"]
    # 체인(첫 장을 제외한 나머지)만 스택 폴더에 배치되며, 사이트 조각이 이를 컨테이너의 신뢰 폴더에 마운트한다
    assert ca_file.read_text(encoding="utf-8") == ca and leaf not in ca_file.read_text(encoding="utf-8")
    assert f"  gitea:\n    volumes:\n      - ./site-ca/ca.pem:{render.SITE_CA_MOUNT}:ro\n" in site.read_text(encoding="utf-8")
    assert '"443:443"' in site.read_text(encoding="utf-8")
    assert svc.store.facts().site_ca is True
    # 컨테이너 재생성 후 보류된 연결을 재시도한다
    from tests.fakes import seq

    calls = host.runner.calls
    recreate = [i for i, c in enumerate(calls) if seq("compose", "up", "-d", "gitea")(c)][-1]
    connect = [i for i, c in enumerate(calls) if seq("exec", "ws-gitea", "auth", "add-oauth")(c)][-1]
    assert recreate < connect and zones.pending(svc.store) == {}

    # 자동 발급으로 전환하면 제거한다
    host.services.append("certbot")
    job = finish(svc, api_cert.manager(svc).reissue({"mode": "auto"}))
    assert job["status"] == "done", job["error"]
    assert not ca_file.exists() and "gitea" not in site.read_text(encoding="utf-8") and svc.store.facts().site_ca is False


def test_uploaded_leaf_alone_adds_no_trust(tmp_path):
    from app import render

    host, svc = temporary_install(tmp_path)
    leaf, key = certs.self_signed(["ws.example.com"], days=90)
    job = finish(svc, api_cert.manager(svc).reissue({"mode": "upload", "cert": leaf, "key": key}))
    assert job["status"] in ("done", "failed")                                 # 연결은 여전히 보류 상태다(신뢰 대상에 추가할 CA 를 알 수 없다)
    assert not (host.paths.stack / render.SITE_CA_FILE).exists()
    assert "gitea" not in (host.paths.stack / render.SITE_COMPOSE).read_text(encoding="utf-8")
    assert svc.store.facts().site_ca is False and zones.pending(svc.store)["git"]


def test_chain_pem():
    leaf, _ = certs.self_signed(["ws.example.com"])
    mid, _ = certs.self_signed(["Intermediate"])
    root, _ = certs.self_signed(["Root"])
    assert certs.chain_pem(leaf) == "" and certs.chain_pem("garbage") == ""
    assert certs.chain_pem(leaf + mid + root) == mid + root

