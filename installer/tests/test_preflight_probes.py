"""사전 점검과 확인(probe) — docker·DNS·HTTP·SMTP 는 모두 가짜."""

import datetime as dt
import json
import smtplib

import pytest

from app import certs, helper, preflight, probes, render
from app import validators as v
from app.docker_api import Result
from tests.conftest import make_answers
from tests.fakes import FakeRunner, healthy_host, make_docker


def by_id(report):
    return {i["id"]: i for i in report["items"]}


def run_preflight(docker, catalog, answers=None, **kw):
    kw.setdefault("reach", lambda url: True)
    kw.setdefault("clock", lambda: True)
    kw.setdefault("data_free_bytes", lambda: 300 * 1024 ** 3)
    return preflight.run(docker, answers or make_answers(), catalog, **kw)


# ─── 사전 점검 ───


def test_preflight_all_pass(tmp_path, catalog):
    docker, runner, _ = make_docker(tmp_path)
    healthy_host(runner)
    report = run_preflight(docker, catalog)
    assert report["ok"], [i for i in report["items"] if i["status"] != "pass"]
    assert [i["id"] for i in report["items"]] == [
        "docker_engine", "docker_compose", "cpu", "memory", "arch", "disk", "time_sync",
        "port_80", "port_443", "port_25", "subnet", "internet", "registry", "selinux"]
    assert report["facts"] == {"memory_mb": 16384, "cpus": 4, "outbound_address": "192.168.10.20"}
    # 호스트 네트워크로 띄운 보조 컨테이너에서 포트를 본다 — 인자는 배열로 나간다
    probe = runner.find("app.helper", "host-probe")[0]
    assert probe[:4] == ["run", "--rm", "--network", "host"] and "sha256:selfimage" in probe


@pytest.mark.parametrize("info,item_id,fix", [
    ({"ServerVersion": "20.10.24"}, "docker_engine", "docker_too_old"),
    ({"NCPU": 1}, "cpu", "cpu_too_few"),
    ({"MemTotal": 2 * 1024 ** 3}, "memory", "memory_below_minimum"),
    ({"MemTotal": 5 * 1024 ** 3}, "memory", "memory_insufficient"),      # 협업 묶음은 7GB 권장
    ({"Architecture": "aarch64"}, "arch", "arch_unsupported"),
])
def test_preflight_failures(tmp_path, catalog, info, item_id, fix):
    docker, runner, _ = make_docker(tmp_path)
    healthy_host(runner, info=info)
    report = run_preflight(docker, catalog)
    assert not report["ok"]
    assert by_id(report)[item_id]["status"] == "fail" and by_id(report)[item_id]["fix"]["key"] == fix


def test_preflight_old_compose_and_no_docker(tmp_path, catalog):
    docker, runner, _ = make_docker(tmp_path)
    healthy_host(runner)
    runner.on("compose", "version", "--short", out="2.5.0\n")
    assert by_id(run_preflight(docker, catalog))["docker_compose"]["fix"]["key"] == "compose_too_old"
    runner.on("info", "--format", rc=1, err="Cannot connect to the Docker daemon")
    assert by_id(run_preflight(docker, catalog))["docker_engine"]["fix"]["key"] == "docker_unreachable"


def test_preflight_ports(tmp_path, catalog):
    docker, runner, _ = make_docker(tmp_path)
    healthy_host(runner, ports={"80": "used", "443": "free", "25": "used"})
    items = by_id(run_preflight(docker, catalog))
    assert items["port_80"]["status"] == "fail" and items["port_80"]["fix"]["vars"] == {"port": 80}
    assert items["port_25"]["status"] == "warn" and items["port_25"]["fix"]["vars"]["needed"] is True
    # 우리 컨테이너가 쓰는 포트면 통과(다시 적용하는 경우)
    runner.on("ps", "--format", out="ws-nginx\t0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\nother\t0.0.0.0:25->25/tcp\n")
    items = by_id(run_preflight(docker, catalog))
    assert items["port_80"] == {"id": "port_80", "status": "pass", "value": "own", "fix": None}
    assert items["port_25"]["status"] == "warn"


def test_preflight_443_not_needed_behind_proxy(tmp_path, catalog):
    docker, runner, _ = make_docker(tmp_path)
    healthy_host(runner, ports={"80": "free", "443": "used", "25": "free"})
    a = make_answers(access={"network": "proxy", "cert": "proxy", "proxy_addresses": ["192.168.10.5"]})
    assert by_id(run_preflight(docker, catalog, a))["port_443"]["value"] == "used_not_needed"
    assert by_id(run_preflight(docker, catalog))["port_443"]["status"] == "fail"


def test_preflight_subnet_conflicts(tmp_path, catalog):
    docker, runner, _ = make_docker(tmp_path)
    healthy_host(runner, networks={"bridge": ["172.17.0.0/16"], "other_default": ["172.28.0.0/16"]})
    item = by_id(run_preflight(docker, catalog))["subnet"]
    assert item["status"] == "fail" and item["fix"]["vars"]["conflicts"][0]["name"] == "other_default"
    # 우리 네트워크는 충돌이 아니다
    docker, runner, _ = make_docker(tmp_path / "b")
    healthy_host(runner, networks={"just-workspace_workspace": ["172.28.0.0/24"]},
                 routes=[{"dest": "172.28.0.0/24", "iface": "br-abc"}])
    assert by_id(run_preflight(docker, catalog))["subnet"]["status"] == "pass"
    # 호스트 경로표와 겹침(사내 대역)
    docker, runner, _ = make_docker(tmp_path / "c")
    healthy_host(runner, routes=[{"dest": "172.28.0.0/22", "iface": "eth1"}])
    item = by_id(run_preflight(docker, catalog))["subnet"]
    assert item["status"] == "fail" and item["fix"]["vars"]["conflicts"][0]["kind"] == "host_route"


def test_preflight_warnings_do_not_block(tmp_path, catalog):
    docker, runner, _ = make_docker(tmp_path)
    healthy_host(runner, free_gb=15)
    report = run_preflight(docker, catalog, reach=lambda url: False, clock=lambda: False,
                           registry="registry.example.com/jw")
    items = by_id(report)
    assert report["ok"]
    assert items["disk"]["status"] == "warn" and items["internet"]["status"] == "warn"
    assert items["registry"]["status"] == "warn" and items["time_sync"]["status"] == "warn"
    healthy_host(runner, free_gb=5)
    assert by_id(run_preflight(docker, catalog))["disk"]["fix"]["key"] == "disk_too_small"


def test_parse_routes():
    text = ("Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
            "eth0\t00000000\t010AA8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"
            "eth0\t000AA8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n"
            "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n")
    assert helper.parse_routes(text) == [{"dest": "192.168.10.0/24", "iface": "eth0"},
                                         {"dest": "172.17.0.0/16", "iface": "docker0"}]


def test_version_parsing():
    assert preflight.parse_version("27.3.1") == (27, 3, 1)
    assert preflight.parse_version("v2.29.7-desktop.1") == (2, 29, 7)
    assert preflight.parse_version("") is None


# ─── 공인 주소 · DNS ───


def test_public_ip_needs_agreement():
    f = lambda value: (lambda: value)  # noqa: E731
    assert probes.detect_public_ip([f("203.0.113.10"), f("203.0.113.10")])["ip"] == "203.0.113.10"
    assert probes.detect_public_ip([f("203.0.113.10"), f(None), f("203.0.113.10")])["status"] == "detected"
    # 한 곳만 답하거나 답이 갈리면 모른다
    assert probes.detect_public_ip([f("203.0.113.10"), f(None)])["status"] == "unknown"
    assert probes.detect_public_ip([f("203.0.113.10"), f("198.51.100.7")])["status"] == "unknown"
    # 사설 주소·쓰레기 답은 버린다
    assert probes.detect_public_ip([f("192.168.0.5"), f("192.168.0.5"), f("<html>")])["status"] == "unknown"

    def boom():
        raise RuntimeError("down")
    assert probes.detect_public_ip([boom, f("203.0.113.10"), f("203.0.113.10")])["ip"] == "203.0.113.10"
    # 서버의 나가는 주소가 공인 주소면 묻지 않는다
    got = probes.detect_public_ip([boom], local_address="8.8.4.4")
    assert got["ip"] == "8.8.4.4" and got["source"] == "interface"
    assert probes.detect_public_ip([], local_address="192.168.10.20")["status"] == "unknown"


class FakeResolver:
    def __init__(self, records: dict, fail: set | None = None):
        self.records, self.fail = records, fail or set()

    def query(self, name, rtype):
        if (name, rtype) in self.fail:
            raise LookupError("timeout")
        return list(self.records.get((name, rtype), []))


PUB = "203.0.113.10"


def test_probe_dns():
    r = FakeResolver({("ws.example.com", "A"): [PUB], ("old.example.com", "A"): ["198.51.100.7"]},
                     fail={("down.example.com", "A")})
    assert probes.probe_dns("ws.example.com", PUB, r)["status"] == "match"
    got = probes.probe_dns("old.example.com", PUB, r)
    assert got["status"] == "mismatch" and got["addresses"] == ["198.51.100.7"] and got["reason"] == "points_elsewhere"
    assert probes.probe_dns("none.example.com", PUB, r)["reason"] == "no_record"
    assert probes.probe_dns("down.example.com", PUB, r)["status"] == "unknown"
    assert probes.probe_dns("ws.example.com", None, r)["status"] == "unknown"
    with pytest.raises(v.Invalid):
        probes.probe_dns("bad host; rm", PUB, r)


def test_probe_mail_records():
    dkim = "v=DKIM1; k=rsa; p=ABCDEF"
    good = FakeResolver({
        ("example.com", "MX"): ["10 mail.example.com"],
        ("mail.example.com", "A"): [PUB],
        ("example.com", "TXT"): ["google-site-verification=x", "v=spf1 mx ~all"],
        ("default._domainkey.example.com", "TXT"): ["v=DKIM1; k=rsa; p=ABC DEF"],
        ("_dmarc.example.com", "TXT"): ["v=DMARC1; p=none"],
    })
    got = probes.probe_mail_records("example.com", PUB, dkim, good)
    assert got["ok"] and [r["status"] for r in got["records"]] == ["ok"] * 5
    assert got["records"][3]["expected"] == dkim

    bad = FakeResolver({
        ("example.com", "MX"): ["10 mx.other.net"],
        ("mail.example.com", "A"): ["198.51.100.7"],
        ("example.com", "TXT"): ["v=spf1 include:_spf.other.net -all"],
        ("default._domainkey.example.com", "TXT"): ["v=DKIM1; k=rsa; p=OTHER"],
    }, fail={("_dmarc.example.com", "TXT")})
    got = probes.probe_mail_records("example.com", PUB, dkim, bad)
    assert not got["ok"]
    assert {r["id"]: r["status"] for r in got["records"]} == {
        "mx": "different", "a": "different", "spf": "different", "dkim": "different", "dmarc": "unknown"}
    assert {r["status"] for r in probes.probe_mail_records("example.com", PUB, dkim, FakeResolver({}))["records"]} == {"missing"}


# ─── 인증서 ───


def test_cert_inspect_ok_and_problems():
    cert, key = certs.self_signed(["ws.example.com", "mail.example.com"])
    got = certs.inspect(cert, key, "ws.example.com", mail_host="mail.example.com")
    status = {c["id"]: c["status"] for c in got["checks"]}
    assert got["ok"] and status["domain_covered"] == "pass" and status["key_matches"] == "pass"
    assert status["issuer"] == "warn" and status["mail_host_covered"] == "pass"       # 자체 서명은 경고
    assert len(got["fingerprint"].split(":")) == 32

    got = certs.inspect(cert, key, "other.example.com")
    assert not got["ok"] and got["checks"][-3]["fix"]["key"] == "cert_domain_missing"

    _, other_key = certs.self_signed(["ws.example.com"])
    got = certs.inspect(cert, other_key, "ws.example.com")
    assert {c["id"]: c["status"] for c in got["checks"]}["key_matches"] == "fail"

    got = certs.inspect(cert, key, "ws.example.com", mail_host="mail.other.com")
    assert got["ok"] and got["checks"][-1]["status"] == "warn"

    later = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=400)
    assert certs.inspect(cert, key, "ws.example.com", now=later)["checks"][4]["fix"]["key"] == "cert_expired"
    soon = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=360)
    assert certs.inspect(cert, key, "ws.example.com", now=soon)["checks"][4]["status"] == "warn"

    assert certs.inspect("garbage", key, "ws.example.com")["checks"][0]["fix"]["key"] == "cert_not_pem"
    assert certs.inspect(cert, "garbage", "ws.example.com")["checks"][1]["fix"]["key"] == "key_not_pem"


def test_cert_wildcard_and_covers():
    assert certs.name_covered("a.example.com", ["*.example.com"])
    assert not certs.name_covered("a.b.example.com", ["*.example.com"])
    assert not certs.name_covered("example.com", ["*.example.com"])
    cert, _ = certs.self_signed(["ws.example.com", "203.0.113.10"], days=90)
    assert certs.covers(cert, ["ws.example.com", "203.0.113.10"]) and not certs.covers(cert, ["mail.example.com"])
    assert not certs.covers(cert, ["ws.example.com"], min_days=120)
    assert certs.is_self_signed(cert)


# ─── SMTP · AI ───


class FakeSMTP:
    def __init__(self, behavior):
        self.behavior, self.calls = behavior, []

    def __call__(self, host, port, timeout=None):
        self.calls.append(("connect", host, port))
        if self.behavior == "refused":
            raise ConnectionRefusedError()
        return self

    def ehlo(self):
        self.calls.append(("ehlo",))

    def starttls(self, context=None):
        self.calls.append(("starttls",))
        if self.behavior == "no_tls":
            raise smtplib.SMTPNotSupportedError("no STARTTLS")

    def login(self, user, password):
        self.calls.append(("login", user))
        if self.behavior == "bad_auth":
            raise smtplib.SMTPAuthenticationError(535, b"no")

    def quit(self):
        self.calls.append(("quit",))


@pytest.mark.parametrize("behavior,status", [("ok", "ok"), ("refused", "unreachable"), ("bad_auth", "auth_failed"),
                                             ("no_tls", "tls_failed")])
def test_probe_smtp(behavior, status):
    fake = FakeSMTP(behavior)
    got = probes.probe_smtp("smtp.example.net", 587, "starttls", "user@example.net", "pw", smtp_factory=fake)
    assert got["status"] == status
    if behavior == "ok":
        assert [c[0] for c in fake.calls] == ["connect", "ehlo", "starttls", "ehlo", "login", "quit"]
    with pytest.raises(v.Invalid):
        probes.probe_smtp("bad host", 587, "starttls", "u", "p", smtp_factory=fake)


def test_probe_ai_requests_and_results():
    url, headers = probes.ai_request("anthropic", "sk-ant-x", None)
    assert url == "https://api.anthropic.com/v1/models" and headers["x-api-key"] == "sk-ant-x"
    url, headers = probes.ai_request("gemini", "g-key", None)
    assert "g-key" not in url and headers == {"x-goog-api-key": "g-key"}      # 키를 주소에 싣지 않는다
    url, headers = probes.ai_request("compatible", "", "http://192.168.10.30:8000/")
    assert url == "http://192.168.10.30:8000/v1/models" and headers == {}
    with pytest.raises(v.Invalid):
        probes.ai_request("compatible", "k", None)
    with pytest.raises(v.Invalid):
        probes.ai_request("nope", "k", None)

    ok = probes.probe_ai("openai", "sk", get=lambda u, h: (200, {"data": [{"id": "model-a"}, {"id": "model-b"}]}))
    assert ok == {"status": "ok", "http_status": 200, "models": ["model-a", "model-b"]}
    assert probes.probe_ai("openai", "bad", get=lambda u, h: (401, {}))["status"] == "auth_failed"
    assert probes.probe_ai("openai", "sk", get=lambda u, h: (500, {}))["status"] == "error"

    def down(u, h):
        raise OSError("no route")
    assert probes.probe_ai("openai", "sk", get=down)["status"] == "unreachable"
    assert probes.probe_ai("gemini", "k", get=lambda u, h: (200, {"models": [{"name": "models/g-1"}]}))["models"] == ["g-1"]


# ─── 저장소 ───


def nfs_opts(server, export):
    return render.storage_volume(make_answers(storage={"kind": "nfs", "server": server, "export": export}))["opts"]


def nfs_probe(docker, **kw):
    kw.setdefault("reachable", lambda host, port: True)
    return probes.probe_nfs(docker, "192.168.10.9", "/export/ws", volume_opts=nfs_opts, **kw)


def test_probe_nfs_success_and_cleanup(tmp_path):
    docker, runner, _ = make_docker(tmp_path)
    runner.on("app.helper", "nfs-test", out=json.dumps({"write": None, "lock": None, "free_bytes": 500 * 1024 ** 3}))
    got = nfs_probe(docker)
    assert got["ok"] and got["cause"] is None
    assert [s["status"] for s in got["steps"]] == ["pass"] * 5
    create = runner.find("volume", "create")[0]
    assert "type=nfs" in create and "device=:/export/ws" in create
    assert any(a.startswith("o=addr=192.168.10.9,") for a in create)
    test = runner.find("app.helper", "nfs-test")[0]
    assert test[test.index("--user") + 1] == "1000:1000"          # backend 가 쓰는 사용자로 검사한다
    assert test[test.index("-v") + 1].endswith(":/mnt:nocopy")    # 확인이 내보내기 뿌리의 소유자를 바꾸지 않게
    name = create[-1]
    assert runner.find("volume", "rm", name), "임시 볼륨을 지워야 한다"
    assert runner.index("volume", "create") < runner.index("app.helper", "nfs-test") < runner.index("volume", "rm")


@pytest.mark.parametrize("setup,cause,failed_step", [
    ("unreachable", "unreachable", "reach"),
    ("mount_denied", "permission_denied", "mount"),
    ("mount_timeout", "unreachable", "mount"),
    ("write_denied", "permission_denied", "write"),
    ("read_only", "read_only", "write"),
    ("no_lock", "no_locking", "lock"),
])
def test_probe_nfs_failure_causes(tmp_path, setup, cause, failed_step):
    docker, runner, _ = make_docker(tmp_path)
    kw = {}
    if setup == "unreachable":
        kw["reachable"] = lambda host, port: False
    elif setup == "mount_denied":
        runner.on("app.helper", "nfs-test", rc=125, err="error while mounting volume: mount.nfs: access denied by server")
    elif setup == "mount_timeout":
        runner.on("app.helper", "nfs-test", rc=125, err="error while mounting volume: connection timed out")
    elif setup == "write_denied":
        runner.on("app.helper", "nfs-test", out=json.dumps({"write": "EACCES", "lock": None, "free_bytes": 1}))
    elif setup == "read_only":
        runner.on("app.helper", "nfs-test", out=json.dumps({"write": "EROFS", "lock": None, "free_bytes": 1}))
    elif setup == "no_lock":
        runner.on("app.helper", "nfs-test", out=json.dumps({"write": None, "lock": "ENOLCK", "free_bytes": 1}))
    got = nfs_probe(docker, **kw)
    assert not got["ok"] and got["cause"] == cause
    steps = {s["id"]: s["status"] for s in got["steps"]}
    assert steps[failed_step] == "fail"
    if setup != "unreachable":
        assert runner.find("volume", "rm"), "실패해도 임시 볼륨은 지운다"
    else:
        assert not runner.find("volume", "create")


def test_probe_nfs_low_space_is_warning(tmp_path):
    docker, runner, _ = make_docker(tmp_path)
    runner.on("app.helper", "nfs-test", out=json.dumps({"write": None, "lock": None, "free_bytes": 3 * 1024 ** 3}))
    got = nfs_probe(docker)
    assert got["ok"] and got["steps"][-1] == {"id": "space", "status": "warn", "value": 3.0}


def test_probe_nfs_rejects_injection(tmp_path):
    docker, runner, _ = make_docker(tmp_path)
    for server, export in (("192.168.10.9,ro", "/x"), ("nas", "/x,addr=198.51.100.1"), ("nas", "/x y")):
        with pytest.raises(v.Invalid):
            probes.probe_nfs(docker, server, export, volume_opts=nfs_opts, reachable=lambda h, p: True)
    assert not runner.find("volume", "create")


def test_probe_local_path(tmp_path):
    docker, runner, _ = make_docker(tmp_path)
    runner.on("app.helper", "path-test", out=json.dumps({"exists": True, "writable": True, "free_bytes": 50 * 1024 ** 3}))
    got = probes.probe_local_path(docker, "/srv/workspace")
    assert got == {"status": "ok", "path": "/srv/workspace", "free_gb": 50.0}
    call = runner.find("app.helper", "path-test")[0]
    # -v 가 아니라 --mount: 없는 폴더를 만들어 버리지 않는다
    assert "type=bind,source=/srv/workspace,target=/probe" in call and "-v" not in call

    runner.on("app.helper", "path-test", rc=125, err="invalid mount config: bind source path does not exist: /srv/none")
    assert probes.probe_local_path(docker, "/srv/none")["status"] == "not_found"
    runner.on("app.helper", "path-test", out=json.dumps({"exists": True, "writable": False, "error": "EACCES"}))
    got = probes.probe_local_path(docker, "/srv/workspace")
    assert got["status"] == "not_writable" and got["uid_gid"] == "1000:1000"
    with pytest.raises(v.Invalid):
        probes.probe_local_path(docker, "/srv/x,readonly")


# ─── 보조 명령(컨테이너 안에서 도는 것) ───


def test_helper_marker(tmp_path, capsys):
    assert helper.main(["write-marker", str(tmp_path), "--install-id", "abc"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "written"
    assert json.loads((tmp_path / ".jw-storage").read_text(encoding="utf-8"))["install_id"] == "abc"
    helper.main(["write-marker", str(tmp_path), "--install-id", "abc"])
    assert json.loads(capsys.readouterr().out)["status"] == "exists"
    helper.main(["write-marker", str(tmp_path), "--install-id", "other"])
    assert json.loads(capsys.readouterr().out) == {"status": "other_install", "install_id": "abc"}
    assert json.loads((tmp_path / ".jw-storage").read_text(encoding="utf-8"))["install_id"] == "abc"


def test_helper_path_test(tmp_path, capsys):
    helper.main(["path-test", str(tmp_path)])
    out = json.loads(capsys.readouterr().out)
    assert out["exists"] and out["writable"] and list(tmp_path.iterdir()) == []      # 흔적을 남기지 않는다
    helper.main(["path-test", str(tmp_path / "missing")])
    assert json.loads(capsys.readouterr().out) == {"exists": False}


def test_helper_rejects_bad_cert_names(tmp_path):
    for bad in ("../x", "a/b", ".hidden", ""):
        with pytest.raises(SystemExit):
            helper.main(["read-cert", "--root", str(tmp_path), "--name", bad])


def test_classify_mount_error():
    assert probes.classify_mount_error("mount.nfs: access denied by server while mounting") == "permission_denied"
    assert probes.classify_mount_error("Connection refused") == "unreachable"
    assert probes.classify_mount_error("No route to host") == "unreachable"
    # NFSv4 서버는 없는 경로와 이 클라이언트에 허용하지 않은 내보내기를 같은 말로 답한다
    assert probes.classify_mount_error(
        "failed to mount local volume: mount :/srv/x:/var/lib/docker/volumes/v/_data, flags: 0x400, "
        "data: addr=192.168.10.9,nfsvers=4.1,hard: no such file or directory") == "export_not_found"
    assert probes.classify_mount_error(
        "failed to chmod on /var/lib/docker/volumes/v/_data: read-only file system") == "read_only"
    assert isinstance(Result(1, "", "x").text, str)
