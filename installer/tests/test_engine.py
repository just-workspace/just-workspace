"""적용 엔진 — 단계 생성, 순서, 실패 후 재시도, 재시작 후 이어가기, 인증서 실패 → 임시 인증서, 로그 가림."""

import json

from app import answers as ans
from app import engine as eng
from app import envfile, render
from app.catalog import Catalog
from tests.conftest import make_answers
from tests.harness import Host


def steps_of(state):
    return [(s["id"], s["status"]) for s in state["steps"]]


def plan_for(bundle, **answers):
    a = make_answers(**answers)
    return eng.plan_steps(a, render.derive(a, ans.Facts(), Catalog(bundle.zones)))


# ─── 단계 생성 ───


def test_steps_follow_answers(bundle):
    assert plan_for(bundle) == ["config", "pull", "database", "cert", "zones", "admin", "lock"]
    assert plan_for(bundle, storage={"kind": "nfs", "server": "192.168.10.9", "export": "/x"})[1] == "storage"
    assert plan_for(bundle, storage={"kind": "local", "path": "/srv/ws"})[1] == "storage"
    # 앞단 프록시가 인증서를 맡고, 따로 인증서가 필요한 구역도 없으면 인증서 단계가 없다
    proxy = {"network": "proxy", "cert": "proxy", "proxy_addresses": ["192.168.10.5"]}
    assert "cert" not in plan_for(bundle, access=proxy, preset="minimal")
    assert "cert" in plan_for(bundle, access=proxy)          # 내장 메일이 인증서를 찾는다


# ─── 끝까지 ───


def test_full_run(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    state = svc.engine.run()
    assert state["status"] == "done", state["error"]
    assert steps_of(state) == [(s, "done") for s in ("config", "pull", "database", "cert", "zones", "admin", "lock")]
    r = host.runner

    # 순서: 설정 검증 → 이미지 → DB → 인증서 → 코어 → 내부망 연결 → 관리자
    order = [r.index("compose", "config", "-q"), r.index("pull", "postgres:16"),
             r.index("compose", "up", "postgres", "redis"), r.index("compose", "run", "certbot"),
             r.index("compose", "up", "backend", "frontend-react", "nginx"),
             r.index("network", "connect"), r.index("exec", "ws-backend", "seed-admin")]
    assert order == sorted(order)

    # compose 는 늘 같은 앞머리로 — 프로젝트 폴더는 호스트 경로, 파일은 컨테이너 안 경로
    up = r.find("compose", "up", "postgres", "redis")[0]
    stack = host.paths.stack.as_posix()
    assert up[:10] == ["compose", "-p", "just-workspace", "--project-directory", "/opt/just-workspace/stack",
                       "-f", f"{stack}/docker-compose.yml", "-f", f"{stack}/docker-compose.site.yml", "--env-file"]
    assert "--no-build" in up

    # 인증서: nginx 가 뜨기 전이라 certbot 이 80 을 직접 듣는다
    certbot = r.find("compose", "run", "certbot")[0]
    assert "--standalone" in certbot and "--publish" in certbot
    assert certbot[certbot.index("--cert-name") + 1] == "ws.example.com"
    assert [certbot[i + 1] for i, a in enumerate(certbot) if a == "-d"] == ["ws.example.com", "mail.example.com"]

    # 관리자 비밀번호는 인자에 없다(env 파일로 넘기고 지운다), 끝나면 저장해 둔 것도 지운다
    seed = r.find("exec", "ws-backend", "seed-admin")[0]
    assert "correct-horse-battery" not in " ".join(seed) and "--env-file" in seed and seed[seed.index("--user") + 1] == "appuser"
    assert not list((host.paths.state / "tmp").glob("*"))
    assert "admin.password" not in svc.store.answer_secrets()

    # 잠금
    assert svc.store.locked and svc.tokens.current() is None
    env = envfile.parse(host.paths.env_file.read_text(encoding="utf-8"))
    assert len(env["SECRET_KEY"]) >= 32 and len(env["JW_INSTALLER_KEY"]) == 48
    assert env["JW_INSTALL_ID"] == svc.store.install()["install_id"]
    assert host.volumes["ws-storage-data"]["Options"] is None


def test_secrets_never_reach_logs_or_state(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    host.runner.on("compose", "up", "backend", fn=lambda argv, i: host._up(argv, i))
    assert svc.engine.run()["status"] == "done"
    secrets = [val for name, val in svc.store.env_secrets().items() if len(val) >= 16 and name != "JW_INSTALL_ID"]
    assert secrets
    logs = "".join(p.read_text(encoding="utf-8") for p in host.paths.logs.glob("*.log"))
    apply = (host.paths.state / "apply.json").read_text(encoding="utf-8")
    for value in [*secrets, "correct-horse-battery"]:
        assert value not in logs and value not in apply
    # 명령 인자에도 비밀값이 없다
    argv_text = "\n".join(host.runner.joined())
    for value in [*secrets, "correct-horse-battery"]:
        assert value not in argv_text
    assert eng.Redactor()("x") == "x"


def test_redactor_masks_known_values():
    r = eng.Redactor()
    r.add("supersecretvalue", "tiny")
    assert r("token=supersecretvalue tiny") == "token=*** tiny"      # 짧은 값은 가리지 않는다(오탐 방지)


def test_secrets_come_from_backend_image_when_available(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    sd = svc.bundle.security_defaults
    made = sd.generate([*sd.names(default_only=True), "SMTP_PASSWORD"])
    host.runner.on("run", "app.cli", "gen-secrets", out=json.dumps(made))
    assert svc.engine.run()["status"] == "done"
    call = host.runner.find("run", "app.cli", "gen-secrets")[0]
    assert call[:5] == ["run", "--rm", "--network", "none", "--entrypoint"]
    assert "localhost/just-workspace-backend:1.0.0" in call and "--format" in call
    assert svc.store.env_secrets()["SECRET_KEY"] == made["SECRET_KEY"]


def test_idempotent_second_run_keeps_secrets(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    svc.engine.run()
    before = svc.store.env_secrets()
    svc.store.set_phase("applying")                    # 잠금을 풀고 한 번 더(운영자가 다시 적용하는 경우)
    svc.store.save_answers(make_answers())
    state = svc.engine.run()
    assert state["status"] == "done"
    assert svc.store.env_secrets() == before
    assert len(host.runner.find("volume", "create")) == 1          # 볼륨은 한 번만 만든다


# ─── 실패 · 재시도 · 이어가기 ───


def test_failure_then_retry_from_failed_step(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    host.runner.on("pull", "nginx:1.31", rc=1, err="manifest unknown")
    host.runner.on("image", "inspect", "nginx:1.31", rc=1)
    state = svc.engine.run()
    assert state["status"] == "failed"
    assert state["error"] == {"step": "pull", "cause": "image_pull_failed", "fix": "check_network_or_registry",
                              "vars": {"image": "nginx:1.31"}}
    assert steps_of(state)[:3] == [("config", "done"), ("pull", "failed"), ("database", "pending")]
    images = {i["image"]: i["status"] for i in state["steps"][1]["detail"]["images"]}
    assert images["nginx:1.31"] == "failed" and images["localhost/just-workspace-backend:1.0.0"] == "present"
    assert not svc.store.locked

    # 고친 뒤 실패한 단계부터 — 앞 단계(config)는 다시 돌지 않는다
    host.runner.on("pull", "nginx:1.31", out="ok")
    host.runner.on("image", "inspect", "nginx:1.31", out="sha256:x")
    config_runs = len(host.runner.find("compose", "config", "-q"))
    assert svc.engine.retry()
    svc.engine._thread.join(30)
    state = svc.engine.status()
    assert state["status"] == "done", state["error"]
    assert len(host.runner.find("compose", "config", "-q")) == config_runs
    assert not svc.engine.retry()                       # 실패한 것이 없으면 재시도할 것도 없다


def test_status_is_running_before_start_returns(tmp_path):
    """시작·재시도 요청이 돌아온 직후의 상태 조회가 옛 상태(idle·failed)를 보이면 안 된다."""
    import threading

    host = Host(tmp_path)
    svc = host.install()
    gate = threading.Event()
    real = svc.engine.run

    def held(**kw):
        gate.wait(10)
        return real(**kw)
    svc.engine.run = held

    assert svc.engine.status()["status"] == "idle"
    assert svc.engine.start()
    assert svc.engine.status()["status"] == "running"          # 스레드가 아직 아무것도 안 했어도
    assert not svc.engine.start()                               # 돌고 있으면 또 시작하지 않는다
    gate.set()
    svc.engine._thread.join(30)
    assert svc.engine.status()["status"] == "done"

    # 실패 → 재시도: 돌려준 순간 이미 running 이고, 옛 오류·대안은 지워져 있다
    svc2_host = Host(tmp_path / "second")
    svc2 = svc2_host.install()
    svc2_host.certbot_ok = False
    assert svc2.engine.run()["status"] == "failed"
    gate2 = threading.Event()
    real2 = svc2.engine.run

    def held2(**kw):
        gate2.wait(10)
        return real2(**kw)
    svc2.engine.run = held2
    assert svc2.engine.retry(use_temporary_cert=True)
    now = svc2.engine.status()
    assert now["status"] == "running" and now["error"] is None and now["alternatives"] == []
    assert all(s["status"] != "failed" for s in now["steps"])
    gate2.set()
    svc2.engine._thread.join(30)
    assert svc2.engine.status()["status"] == "done"


def test_resume_when_stopped_right_after_start(tmp_path):
    """시작 요청만 기록되고 단계가 하나도 돌기 전에 설치 관리자가 죽은 경우 — 처음부터 돈다."""
    host = Host(tmp_path)
    svc = host.install()
    state = svc.engine.status()
    state["status"] = "running"
    svc.engine._save(state)

    svc2 = host.services_obj()
    assert svc2.engine.resume()
    svc2.engine._thread.join(30)
    assert svc2.engine.status()["status"] == "done"


def test_resume_after_installer_restart(tmp_path):
    host = Host(tmp_path)
    svc = host.install()

    # database 단계 도중 설치 관리자가 죽었다고 치자
    class Crash(BaseException):
        pass

    def die(argv, _):
        raise Crash()
    host.runner.on("compose", "up", "postgres", "redis", fn=die)
    try:
        svc.engine.run()
    except Crash:
        pass
    on_disk = svc.engine.status()
    assert on_disk["status"] == "running" and on_disk["current"] == "database"

    # 새 프로세스 — 같은 디스크 상태에서 이어 간다
    host.runner.on("compose", "up", "postgres", "redis", fn=host._up)
    svc2 = host.services_obj()
    pulls = len(host.runner.find("pull", "postgres:16"))
    assert svc2.engine.resume()
    svc2.engine._thread.join(30)
    state = svc2.engine.status()
    assert state["status"] == "done", state["error"]
    assert len(host.runner.find("pull", "postgres:16")) == pulls       # 끝난 단계는 다시 하지 않는다
    marked = [s["id"] for s in state["steps"] if s.get("interrupted")]
    assert marked == ["database"]                                      # 끊겼던 단계에 표시가 남는다
    assert not svc2.engine.resume()                                    # 돌던 것이 없으면 아무 일도 없다


def test_cert_failure_offers_temporary_cert(tmp_path):
    host = Host(tmp_path)
    host.certbot_ok = False
    svc = host.install()
    state = svc.engine.run()
    assert state["status"] == "failed" and state["error"]["step"] == "cert"
    assert state["error"]["cause"] == "cert_issue_failed" and state["error"]["fix"] == "cert_retry_or_temporary"
    assert state["alternatives"] == [{"key": "use_temporary_cert"}]
    assert svc.store.facts().cert_issue_failed

    assert svc.engine.retry(use_temporary_cert=True)
    svc.engine._thread.join(30)
    state = svc.engine.status()
    assert state["status"] == "done", state["error"]
    assert svc.store.load_answers().access.cert == "temporary"
    assert len(host.runner.find("compose", "run", "certbot")) == 1       # 다시 요청하지 않는다
    placed = [c for c in host.runner.find("app.helper", "place-cert") if "--link-only" not in c]
    assert placed and "-i" in placed[-1]                                 # 인증서·키는 표준 입력으로 넘긴다
    env = envfile.parse(host.paths.env_file.read_text(encoding="utf-8"))
    assert "certbot" not in env["COMPOSE_PROFILES"].split(",")
    assert "Strict-Transport-Security" not in (host.paths.stack / "nginx/site.d/headers.conf").read_text(encoding="utf-8")
    assert svc.store.read("cert.json")["kind"] == "self_signed"


def test_invalid_answers_stop_before_any_step(tmp_path):
    host = Host(tmp_path)
    svc = host.install(access={"network": "proxy", "cert": "auto"})
    state = svc.engine.run()
    assert state["status"] == "failed" and state["error"]["cause"] == "answers_invalid"
    assert state["steps"] == [] and not host.runner.find("compose")


def test_preflight_failure_blocks_apply(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    host.runner.on("app.helper", "host-probe", out=json.dumps({"ports": {"80": "used", "443": "free", "25": "free"}, "routes": []}))
    state = svc.engine.run()
    assert state["error"] == {"cause": "preflight_failed", "fix": "fix_preflight", "vars": {"items": ["port_80"]}}
    assert not host.runner.find("compose", "up")


def test_unhealthy_database_fails_with_cause(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    host.unhealthy.add("ws-postgres")
    state = svc.engine.run()
    assert state["error"]["step"] == "database" and state["error"]["cause"] == "database_not_ready"
    assert state["error"]["vars"]["container"] == "ws-postgres"


def test_unexpected_error_is_recorded_as_step_failure(tmp_path):
    host = Host(tmp_path)
    svc = host.install()

    def boom(argv, _):
        raise RuntimeError("something odd")
    host.runner.on("compose", "config", "--images", fn=boom)
    state = svc.engine.run()
    assert state["error"]["step"] == "pull" and state["error"]["cause"] == "unexpected_error"


# ─── 저장소 ───


def test_nfs_storage_creates_volume_and_marker(tmp_path):
    host = Host(tmp_path)
    svc = host.install(storage={"kind": "nfs", "server": "192.168.10.9", "export": "/export/ws"})
    state = svc.engine.run()
    assert state["status"] == "done", state["error"]
    assert steps_of(state)[1] == ("storage", "done")
    assert host.volumes["ws-storage-data"]["Options"]["type"] == "nfs"
    marker = host.runner.find("app.helper", "write-marker")[0]
    assert "ws-storage-data:/storage" in marker and marker[marker.index("--user") + 1] == "1000:1000"
    assert marker[marker.index("--install-id") + 1] == svc.store.install()["install_id"]


def test_storage_failures(tmp_path):
    host = Host(tmp_path)
    svc = host.install(storage={"kind": "local", "path": "/srv/ws"})
    host.marker = {"status": "other_install", "install_id": "zzz"}
    state = svc.engine.run()
    assert state["error"]["step"] == "storage" and state["error"]["cause"] == "storage_other_install"

    host.marker = {"status": "error", "error": "EACCES"}
    assert svc.engine.retry()
    svc.engine._thread.join(30)
    err = svc.engine.status()["error"]
    assert err["cause"] == "permission_denied" and err["vars"]["uid_gid"] == "1000:1000"

    # 같은 이름의 볼륨이 다른 옵션으로 이미 있으면 건드리지 않고 멈춘다
    host.marker = {"status": "written"}
    host.volumes["ws-storage-data"]["Options"] = {"type": "none", "o": "bind", "device": "/elsewhere"}
    assert svc.engine.retry()
    svc.engine._thread.join(30)
    assert svc.engine.status()["error"]["cause"] == "storage_volume_mismatch"


# ─── 인증서 갱신 뒤 ───


def test_reload_after_renewal(tmp_path):
    host = Host(tmp_path)
    svc = host.install()
    assert eng.reload_after_renewal(svc.engine) == "skipped"        # 설치 전
    svc.engine.run()
    assert eng.reload_after_renewal(svc.engine) == "unchanged"
    from app import certs

    host.cert = certs.self_signed(["ws.example.com", "mail.example.com"])[0]     # 갱신됨
    assert eng.reload_after_renewal(svc.engine) == "reloaded"
    assert host.runner.find("exec", "ws-nginx", "nginx", "-s", "reload")
    assert eng.reload_after_renewal(svc.engine) == "unchanged"


def test_quick_mode_downgrade_is_recorded(tmp_path):
    host = Host(tmp_path)
    svc = host.install(mode="quick", preset=None)
    host.runner.on("info", "--format", out=json.dumps({"ServerVersion": "27.3.1", "NCPU": 2, "MemTotal": 4 * 1024 ** 3,
                                                       "Architecture": "x86_64"}))
    svc.store.update_facts(memory_mb=4096)
    state = svc.engine.run()
    assert state["status"] == "done", state["error"]
    assert state["notes"][0]["key"] == "quick_downgraded"
    assert envfile.parse(host.paths.env_file.read_text(encoding="utf-8"))["JW_ZONES"] == "core"
