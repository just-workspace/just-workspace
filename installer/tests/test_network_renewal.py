"""내부망 주소 배정·일회용 실행·인증서 갱신 서비스·발급 실패 분류·저사양 서버의 녹화 상한·클라우드 감지·채널 상태."""

import json

import pytest

from app import api, api_cert, certs, envfile, preflight, render, server
from app import answers as ans
from app import engine as eng
from app import update_release as rel
from app.catalog import Catalog
from app.docker_api import Result
from tests.conftest import make_answers
from tests.fakes import DOCKER_INFO, healthy_host, make_docker
from tests.harness import Host
from tests.update_harness import BASE, UpdateHost

NETWORK = "just-workspace_workspace"


def network_json(subnet: str = "172.28.0.0/24") -> str:
    return json.dumps([{"Name": NETWORK, "IPAM": {"Config": [{"Subnet": subnet}]}}])


def self_json(address: str | None) -> str:
    networks = {} if address is None else {NETWORK: {"IPAddress": address, "Aliases": ["jw-installer"]}}
    return json.dumps([{"Image": "sha256:selfimage", "NetworkSettings": {"Networks": networks}}])


# ─── 설치 관리자의 예약 주소 ───


def test_installer_connects_with_its_reserved_address(tmp_path):
    docker, runner, _ = make_docker(tmp_path)
    runner.on("network", "inspect", NETWORK, out=network_json("172.30.5.0/24"))
    assert docker.connect_self("jw-installer").ok
    connect = runner.find("network", "connect")
    assert len(connect) == 1 and connect[0][connect[0].index("--ip") + 1] == "172.30.5.100"
    assert connect[0][connect[0].index("--alias") + 1] == "jw-installer"


def test_installer_on_a_dynamic_address_is_moved_to_the_reserved_one(tmp_path):
    docker, runner, _ = make_docker(tmp_path)
    runner.on("network", "inspect", NETWORK, out=network_json())
    runner.on("container", "inspect", "jw-self", out=self_json("172.28.0.3"))      # 이전 버전이 동적으로 연결한 주소
    assert docker.connect_self("jw-installer").ok
    assert runner.index("network", "disconnect", NETWORK, "jw-self") < runner.index("network", "connect", "--ip", "172.28.0.100")

    # 예약 주소로 연결된 상태이면 변경하지 않는다
    docker2, runner2, _ = make_docker(tmp_path / "b")
    runner2.on("network", "inspect", NETWORK, out=network_json())
    runner2.on("container", "inspect", "jw-self", out=self_json("172.28.0.100"))
    assert docker2.connect_self("jw-installer").out == "already connected"
    assert not runner2.find("network", "disconnect") and not runner2.find("network", "connect")


def test_installer_falls_back_when_the_reserved_address_is_taken(tmp_path):
    docker, runner, _ = make_docker(tmp_path)
    runner.on("network", "inspect", NETWORK, out=network_json())
    runner.on("network", "connect", "--ip", "172.28.0.100", rc=1, err="Address already in use")
    assert docker.connect_self("jw-installer").ok
    used = [c[c.index("--ip") + 1] for c in runner.find("network", "connect")]
    assert used == ["172.28.0.100", "172.28.0.101"]

    # 대역을 확인할 수 없으면(네트워크 조회 실패) 주소를 지정하지 않고 연결한다
    docker2, runner2, _ = make_docker(tmp_path / "b")
    runner2.on("network", "inspect", NETWORK, rc=1, err="no such network")
    assert docker2.connect_self("jw-installer").ok
    assert "--ip" not in runner2.find("network", "connect")[0]


# ─── 일회용 실행 ───


def test_one_off_runs_do_not_inherit_the_fixed_address(tmp_path):
    docker, runner, paths = make_docker(tmp_path)
    docker.compose_run("certbot", ["certonly"], run_args=["--entrypoint", "certbot"])
    argv = runner.find("compose", "run")[0]
    fragment = paths.state / "run" / "run-network-certbot.yml"
    assert argv[argv.index(fragment.as_posix()) - 1] == "-f"
    assert argv[argv.index("run"):] == ["run", "--rm", "--no-deps", "--entrypoint", "certbot", "certbot", "certonly"]
    assert fragment.read_text(encoding="utf-8") == "services:\n  certbot:\n    networks: !override\n      workspace: {}\n"


def test_install_migration_and_issuance_use_one_off_fragments(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    assert svc.engine.run()["status"] == "done"
    migrate = host.runner.find("compose", "run", "backend", "migrate")[0]
    certbot = host.runner.find("compose", "run", "certbot")[0]
    assert any(a.endswith("run-network-backend.yml") for a in migrate)
    assert any(a.endswith("run-network-certbot.yml") for a in certbot)


def test_compose_gives_every_long_running_service_a_distinct_fixed_address(bundle):
    """상주 서비스의 고정 주소는 중복되지 않고, 설치 관리자 예약 구간(100~104)·이전 버전의 동적 점유 주소(.3)와 겹치지 않는다."""
    import re

    from app.docker_api import INSTALLER_HOSTS

    hosts = [int(h) for h in re.findall(r"ipv4_address: \$\{JW_NET_PREFIX:-172\.28\.0\}\.(\d+)", bundle.read("docker-compose.yml"))]
    assert len(hosts) == len(set(hosts)) and 2 in hosts
    assert not set(hosts) & set(INSTALLER_HOSTS) and 3 not in hosts and max(hosts) < 100


# ─── 적용 실패 후 구성을 바꿔 재적용 ───


def test_reapply_removes_containers_of_dropped_zones(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    host.runner.on("ps", "-a", "--filter", out="ws-postgres\tpostgres\tFalse\nws-egress\tegress\tFalse\n"
                                               "just-workspace-backend-run-1a2b\tbackend\tTrue\nws-backend\tbackend\tFalse\n")
    assert svc.engine.run()["status"] == "done"
    removed = host.runner.find("rm", "-f", "ws-egress")
    assert removed and removed[0][-2:] == ["just-workspace-backend-run-1a2b", "ws-egress"]
    assert "ws-postgres" not in removed[0] and "ws-backend" not in removed[0]
    assert host.runner.index("rm", "-f", "ws-egress") < host.runner.index("compose", "up", "postgres", "redis")


# ─── 갱신 컨테이너 ───


def auto_host(tmp_path) -> tuple[Host, api.Services]:
    host = Host(tmp_path)
    host.services = [*host.services, "certbot"]
    return host, host.install()


def test_auto_install_starts_the_renewal_container_after_nginx(tmp_path):
    host, svc = auto_host(tmp_path)
    state = svc.engine.run()
    assert state["status"] == "done", state["error"]
    r = host.runner
    assert r.index("compose", "up", "backend", "frontend-react", "nginx") < r.index("compose", "up", "certbot")
    assert "ws-certbot" in host.running and state["warnings"] == []


def test_renewal_start_failure_is_a_warning_not_a_failure(tmp_path):
    host, svc = auto_host(tmp_path)
    host.runner.on("compose", "up", "certbot", rc=1, err="Error response from daemon: Address already in use")
    state = svc.engine.run()
    assert state["status"] == "done"
    assert [w["key"] for w in state["warnings"]] == ["cert_renewal_not_started"]


def test_ensure_renewal_restarts_a_missing_renewal_container(tmp_path):
    host, svc = auto_host(tmp_path)
    assert eng.ensure_renewal(svc.engine) == "not_applicable"        # 설치 전
    svc.engine.run()
    assert eng.ensure_renewal(svc.engine) == "running"
    host.running.discard("ws-certbot")
    before = len(host.runner.find("compose", "up", "certbot"))
    assert eng.ensure_renewal(svc.engine) == "started"
    assert len(host.runner.find("compose", "up", "certbot")) == before + 1 and "ws-certbot" in host.running

    # 임시 인증서 설치는 갱신 대상이 아니다
    other = Host(tmp_path / "temp")
    svc2 = other.install(access={"cert": "temporary"})
    svc2.engine.run()
    assert eng.ensure_renewal(svc2.engine) == "not_applicable" and not other.runner.find("compose", "up", "certbot")


def test_cert_status_reports_the_renewal_service(tmp_path):
    host, svc = auto_host(tmp_path)
    svc.engine.run()
    host.runner.on("app.helper", "read-cert", fn=lambda argv, i: json.dumps(
        {"cert": host.cert, "renewal": {"at": "2026-01-10T03:00:00Z", "rc": 0}}) + "\n")
    renewal = api_cert.manager(svc).status()["renewal"]
    assert renewal["applicable"] and renewal["service"] == "running"
    assert renewal["last_run_at"] == "2026-01-10T03:00:00Z" and renewal["last_result"] == "ok"
    info = __import__("app.certctl", fromlist=["describe"]).describe(host.cert)
    assert info["not_before"] < renewal["next_renewal_at"] < info["not_after"]       # 유효 기간의 2/3 지점

    host.running.discard("ws-certbot")
    host.runner.on("app.helper", "read-cert", fn=lambda argv, i: json.dumps(
        {"cert": host.cert, "renewal": {"at": "2026-01-10T03:00:00Z", "rc": 1}}) + "\n")
    renewal = api_cert.manager(svc).status()["renewal"]
    assert renewal["service"] == "missing" and renewal["last_result"] == "failed"

    other = Host(tmp_path / "temp")
    svc2 = other.install(access={"cert": "temporary"})
    svc2.engine.run()
    assert api_cert.manager(svc2).status()["renewal"]["applicable"] is False


# ─── 발급 실패의 분류 ───


@pytest.mark.parametrize("output, dns, cause", [
    ("Error response from daemon: failed to set up container networking: Address already in use", None, "cert_service_start_failed"),
    ("Bind for 0.0.0.0:80 failed: port is already allocated", None, "cert_service_start_failed"),
    ("urn:ietf:params:acme:error:rateLimited :: too many certificates (5) already issued", None, "cert_rate_limited"),
    ("Detail: DNS problem: NXDOMAIN looking up A for ws.example.com", None, "cert_dns_mismatch"),
    ("Detail: 203.0.113.9: Fetching http://ws.example.com/.well-known/acme-challenge/x: Timeout during connect (likely firewall problem)",
     None, "cert_acme_challenge_failed"),
    ("Detail: 203.0.113.9: Invalid response from http://ws.example.com/.well-known/acme-challenge/x: 404", "mismatch", "cert_dns_mismatch"),
    ("Some challenges have failed.", None, "cert_issue_failed"),
])
def test_cert_failure_is_classified_by_the_issuers_output(output, dns, cause):
    assert eng.classify_cert_failure(output, dns) == cause


def test_issuance_container_start_failure_is_not_reported_as_port_80(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    host.runner.on("compose", "run", "certbot", rc=1, err="Error response from daemon: Address already in use")
    state = svc.engine.run()
    assert state["error"]["cause"] == "cert_service_start_failed" and state["alternatives"] == [{"key": "use_temporary_cert"}]


def test_acme_server_override(monkeypatch):
    monkeypatch.delenv("JW_ACME_SERVER", raising=False)
    assert eng.acme_server_args() == []
    monkeypatch.setenv("JW_ACME_SERVER", "https://acme-staging-v02.api.letsencrypt.org/directory")
    assert eng.acme_server_args() == ["--server", "https://acme-staging-v02.api.letsencrypt.org/directory"]
    monkeypatch.setenv("JW_ACME_SERVER", "http://plain.example.com/dir --no-verify-ssl")
    assert eng.acme_server_args() == []


# ─── 코어 4개 미만 서버의 회의 녹화 ───


def test_egress_limits_follow_the_core_count(bundle, secrets):
    assert render.egress_limits(ans.Facts(cpus=2)) == ("2", "1")
    assert render.egress_limits(ans.Facts(cpus=3)) == ("3", "2")
    assert render.egress_limits(ans.Facts(cpus=16)) == ("4", "4")
    assert render.egress_limits(ans.Facts()) == ("", "")

    answers = make_answers(preset=None, zones=["meetings"], mail={})
    low = ans.Facts(cpus=2, memory_mb=8192, dns_status="match")
    env = envfile.parse(render.render(answers, secrets, low, bundle)[".env"])
    assert env["EGRESS_CPUS"] == "2" and env["EGRESS_ROOM_CPU_COST"] == "1"
    plan = render.derive(answers, low, Catalog(bundle.zones))
    assert {"key": "meetings_recording_low_cpu", "vars": {"cpus": 2, "recommend": 4}} in plan.cautions
    enough = render.derive(answers, ans.Facts(cpus=4), Catalog(bundle.zones))
    assert "meetings_recording_low_cpu" not in [c["key"] for c in enough.cautions]
    # compose 는 상한을 변수로 읽는다(고정값이면 코어 수가 적은 서버에서 컨테이너 생성이 거부된다)
    assert "cpus: '${EGRESS_CPUS:-4}'" in bundle.read("docker-compose.yml")


def test_preflight_warns_about_recording_below_four_cores(tmp_path, catalog):
    kwargs = {"reach": lambda url: True, "clock": lambda: True, "data_free_bytes": lambda: 300 * 1024 ** 3}
    docker, runner, _ = make_docker(tmp_path)
    healthy_host(runner, info={"NCPU": 2})
    with_meetings = preflight.run(docker, make_answers(preset=None, zones=["meetings"], mail={}), catalog, **kwargs)
    cpu = next(i for i in with_meetings["items"] if i["id"] == "cpu")
    assert with_meetings["ok"] and cpu["status"] == "warn"
    assert cpu["fix"] == {"key": "cpu_below_recording", "vars": {"cpus": 2, "recommend": 4}}
    without = preflight.run(docker, make_answers(preset="minimal", mail={}), catalog, **kwargs)
    assert next(i for i in without["items"] if i["id"] == "cpu")["status"] == "pass"


def test_no_fixed_cpu_limit_exceeds_the_minimum_core_count(bundle):
    """compose 의 고정 CPU 상한은 최소 사양(코어 2개)을 초과하지 않는다 — 초과분은 변수로 조정된다."""
    import re

    fixed = [float(x) for x in re.findall(r"cpus: '([0-9.]+)'", bundle.read("docker-compose.yml"))]
    assert fixed and max(fixed) <= preflight.CPU_MIN


# ─── 문서 편집기의 회귀 접속 ───


def test_docs_editor_skips_verification_only_for_untrusted_certificates(bundle, secrets):
    facts = ans.Facts(cpus=4, memory_mb=16384, dns_status="match")

    def flag(**access) -> str:
        answers = make_answers(preset=None, zones=["docs"], mail={}, access=access)
        return envfile.parse(render.render(answers, secrets, facts, bundle)[".env"])["ONLYOFFICE_ALLOW_UNTRUSTED_CERT"]

    assert flag(cert="temporary") == "true"
    assert flag(cert="auto") == "false"
    assert flag(network="proxy", cert="proxy", proxy_addresses=["192.168.10.5"]) == "false"


# ─── 클라우드 서버 감지 ───


def test_cloud_server_with_private_address_is_detected_as_direct(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    pre = {"facts": {"outbound_address": "172.31.5.20", "cloud": True}}
    assert api.detected_facts(svc, pre)["detected_network"] == "direct" and api.detected_facts(svc, pre)["cloud"] is True
    pre = {"facts": {"outbound_address": "192.168.10.20", "cloud": False}}
    assert api.detected_facts(svc, pre)["detected_network"] == "router" and api.detected_facts(svc, pre)["cloud"] is False


def test_preflight_carries_the_cloud_probe(tmp_path, catalog):
    docker, runner, _ = make_docker(tmp_path)
    healthy_host(runner)
    runner.on("app.helper", "host-probe", out=json.dumps({
        "ports": {"80": "free", "443": "free", "25": "free"}, "routes": [], "outbound_address": "172.31.5.20",
        "gateway": "172.31.0.1", "selinux": "", "cloud": True}) + "\n")
    report = preflight.run(docker, make_answers(), catalog, reach=lambda url: True, clock=lambda: True,
                           data_free_bytes=lambda: 300 * 1024 ** 3)
    assert report["facts"]["cloud"] is True
    assert "cloud" not in preflight.preflight_facts(report)


# ─── 기동 안내의 접속 주소 ───


def test_banner_shows_a_guessed_address_instead_of_a_placeholder(tmp_path, monkeypatch):
    monkeypatch.delenv("JW_PUBLIC_HOST", raising=False)
    host = Host(tmp_path)
    svc = host.services_obj()
    text = server.banner(svc, "AA:BB", 8443)
    assert "https://192.168.10.20:8443/?token=" in text and "<서버 주소>" not in text and "추정한 값" in text

    monkeypatch.setenv("JW_PUBLIC_HOST", "ws.example.com")
    text = server.banner(svc, "AA:BB", 8443)
    assert "https://ws.example.com:8443/?token=" in text and "추정한 값" not in text

    monkeypatch.delenv("JW_PUBLIC_HOST")
    host.runner.on("app.helper", "host-probe", rc=1, err="boom")
    assert "https://<서버 주소>:8443/" in server.banner(svc, "AA:BB", 8443)


# ─── 업데이트 채널 ───


def test_missing_channel_file_is_reported_as_no_release_yet(tmp_path, monkeypatch):
    host = UpdateHost(tmp_path, monkeypatch)
    host.install_keys()
    host.releases.publish("1.0.1")
    mgr = host.manager()
    real = host.releases.fetch

    def fetch(url: str) -> bytes:
        if url.startswith(f"{BASE}/channels/"):
            host.releases.fetched.append(url)
            raise rel.FetchError("HTTP 404")
        return real(url)

    mgr.fetch = fetch
    mgr.check()
    st = mgr.status()
    assert st["check"]["ok"] is False and st["check"]["error"]["code"] == "channel_empty"
    assert st["available"] == {"state": "none"}

    host.releases.down = True               # 서버에 도달하지 못한 경우는 기존대로 연결 실패
    mgr.fetch = real
    mgr.check()
    assert mgr.status()["check"]["error"]["code"] == "channel_unreachable"


def test_default_channel_follows_the_installed_version(tmp_path, monkeypatch):
    host = UpdateHost(tmp_path, monkeypatch)
    mgr = host.manager()
    assert mgr.settings()["channel"] == "stable"                     # Stable 버전으로 설치한 서버
    mgr._write("current.json", {"version": "1.0.1-beta.2", "applied_at": None, "previous_version": None})
    assert mgr.settings()["channel"] == "beta" and mgr.status()["settings"]["channel"] == "beta"
    mgr.put_settings({"channel": "stable"})                          # 사용자가 선택한 채널은 저장되어 우선한다
    assert mgr.settings()["channel"] == "stable"
