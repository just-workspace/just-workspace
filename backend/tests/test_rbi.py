"""격리 브라우저(RBI) — 정책 생성·대상 검증·권한·세션 수명·스트림 인증·관리자 API.

docker 는 부르지 않는다(app.rbi.docker 를 가짜로 바꾼다). Redis 도 안 쓴다(가짜 저장소 — tests/rbi_fakes.py).
rbi 전용 출처(SSO 홉·쿠키 격리·호스트 제한)는 tests/test_rbi_site.py.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from sqlalchemy import select
from httpx import ASGITransport, AsyncClient

from app.auth.deps import get_current_user, sign_value
from app.rbi.site import get_rbi_user
from tests.rbi_fakes import RBI_HOST, fake_redis, rbi_origin, site_cookie  # noqa: F401 — 픽스처
from app.db.models import User
from app.db.session import get_db
from app.groups.models import Group, GroupMember  # noqa: F401 — db_engine 픽스처의 create_all 전에 등록
from app.rbi import docker as dk
from app.rbi import policy as pol
from app.rbi import service as svc
from app.rbi import router as rbi_router
from app.rbi.models import RbiSession, RbiTarget

ADMIN = User(id="u-admin", username="admin", display_name="관리자", is_admin=True, is_active=True,
             email="a@x", token_version=0)
ALICE = User(id="u-alice", username="alice", display_name="앨리스", is_admin=False, is_active=True,
             email="al@x", token_version=0)
BOB = User(id="u-bob", username="bob", display_name="밥", is_admin=False, is_active=True,
           email="b@x", token_version=0)

TARGET = "http://192.168.10.170"


# ── 정책(순수 함수) ──

def test_chromium_policy_locks_to_target_and_blocks_leaks():
    p = pol.TargetPolicy(url=TARGET)
    c = pol.chromium_policy(p)
    assert c["URLBlocklist"] == ["*"]
    assert "192.168.10.170" in c["URLAllowlist"]
    assert c["ExtensionInstallBlocklist"] == ["*"]
    assert c["DeveloperToolsAvailability"] == 2
    assert c["PasswordManagerEnabled"] is False
    assert c["DownloadRestrictions"] == 3 and c["AllowFileSelectionDialogs"] is False
    assert c["PrintingEnabled"] is False
    assert c["RestoreOnStartupURLs"] == [TARGET]
    assert c["IncognitoModeAvailability"] == 1
    json.loads(pol.chromium_policy_json(p))  # 유효한 JSON


def test_chromium_policy_downloads_uploads_toggle():
    c = pol.chromium_policy(pol.TargetPolicy(url=TARGET, downloads=True, uploads=True))
    assert c["DownloadRestrictions"] == 0 and c["AllowFileSelectionDialogs"] is True and c["PrintingEnabled"] is True


def test_kasmvnc_yaml_clipboard_and_idle():
    y = pol.kasmvnc_yaml(pol.TargetPolicy(url=TARGET, clipboard_from_browser=False, idle_minutes=15))
    assert "no_user_session_timeout: 900" in y and "inactive_user_session_timeout: 900" in y
    assert "server_to_client:\n      enabled: false" in y
    assert "client_to_server:\n      enabled: true" in y
    assert "pem_certificate: ${HOME}/.vnc/self.pem" in y  # 이미지 기본값 유지


def test_container_env_disables_side_services_and_mirrors_clipboard():
    env = pol.container_env(pol.TargetPolicy(url=TARGET, clipboard_to_browser=False), "pw")
    assert env["VNC_PW"] == "pw" and env["LAUNCH_URL"] == TARGET
    assert env["KASMVNC_AUTO_RECOVER"] == "false"
    for k in ("KASM_SVC_AUDIO", "KASM_SVC_AUDIO_INPUT", "KASM_SVC_UPLOADS", "KASM_SVC_WEBCAM", "KASM_SVC_PRINTER", "KASM_SVC_SMARTCARD", "KASM_SVC_GAMEPAD"):
        assert env[k] == "0", k
    assert env["KASM_SVC_ACCEPT_CUT_TEXT"] == "-AcceptCutText 0"
    assert env["KASM_SVC_SEND_CUT_TEXT"] == "-SendCutText 1"


def test_docker_create_args_hardening():
    args = pol.docker_create_args(name="ws-rbi-s-abc", network="ws-rbi", publish_ip="172.28.0.1",
                                  image="kasmweb/chromium:1.18.0", env={"A": "1"}, cpu=2, memory_mb=2048)
    s = " ".join(args)
    assert args[0] == "create"
    assert "--read-only" in args and "--cap-drop ALL" in s and "no-new-privileges:true" in s
    assert "--user 1000:1000" in s and "--publish 172.28.0.1::6901" in s and "--network ws-rbi" in s
    assert "--cpus 2" in s and "--memory 2048m" in s and "--pids-limit 512" in s
    assert "--dns 0.0.0.0" in s and "disable_ipv6=1" in s
    assert "-v " not in s  # 호스트 경로 바인드 없음(정책은 환경변수 → tmpfs 파일)
    assert "--tmpfs /etc/chromium/policies/managed:" in s and "--tmpfs /etc/kasmvnc:" in s
    assert "--entrypoint /bin/bash kasmweb/chromium:1.18.0 -c " in s and args[-1] == pol.STARTUP_SCRIPT



def test_mirror_policy_allows_cdp_pipe_only_difference():
    tp = pol.TargetPolicy(url="http://192.168.10.170")
    base, mir = pol.chromium_policy(tp), pol.mirror_chromium_policy(tp)
    assert mir["RemoteDebuggingAllowed"] is True and base["RemoteDebuggingAllowed"] is False
    diff = {k for k in base if base[k] != mir.get(k)}
    assert diff == {"RemoteDebuggingAllowed", "DeveloperToolsAvailability", "DownloadDirectory"}
    assert mir["DeveloperToolsAvailability"] == 1
    assert mir["URLBlocklist"] == ["*"] and "192.168.10.170" in mir["URLAllowlist"]


def test_mirror_docker_create_args_same_hardening_and_port():
    tp = pol.TargetPolicy(url="http://192.168.10.170")
    env = pol.mirror_container_env(tp, sid="a" * 32)
    args = pol.mirror_docker_create_args(name="ws-rbi-s-x", network="ws-rbi", publish_ip="172.28.0.1", image="ws-rbi-mirror:p0",
                                         env=env, cpu=2, memory_mb=2048)
    s = " ".join(args)
    for must in ("--read-only", "--cap-drop ALL", "--user 1000:1000", "no-new-privileges:true", "--dns 0.0.0.0",
                 "--publish 172.28.0.1::6901", "--pids-limit 512", "net.ipv6.conf.all.disable_ipv6=1", "app.just-workspace.rbi=session"):
        assert must in s
    assert "MIRROR_PORT=6901" in s and "remote-debugging-port" not in s
    assert args[-1] == pol.MIRROR_STARTUP_SCRIPT and "zz-rbi-policy.json" in args[-1]

@pytest.mark.parametrize("raw,norm", [
    ("192.168.10.170", "http://192.168.10.170"), ("http://192.168.10.170/", "http://192.168.10.170"),
    ("https://portal.lan:8443/admin", "https://portal.lan:8443/admin"),
])
def test_normalize_url_ok(raw, norm):
    assert pol.normalize_url(raw) == norm


@pytest.mark.parametrize("raw", ["ftp://x", "http://u:p@h", "http://h/?a=1", "http://", "file:///etc/passwd", ""])
def test_normalize_url_rejects(raw):
    with pytest.raises(ValueError):
        pol.normalize_url(raw)


def test_normalize_hosts_includes_target_host_with_port():
    assert pol.normalize_hosts(["other.lan"], "http://192.168.10.170:8080") == ["192.168.10.170:8080", "other.lan"]
    with pytest.raises(ValueError):
        pol.normalize_hosts(["bad host!"], TARGET)


def test_validate_key():
    assert pol.validate_key(" PORTAL-one ") == "portal-one"
    for bad in ("-x", "a", "x" * 40, "a b"):
        with pytest.raises(ValueError):
            pol.validate_key(bad)


# ── 가짜 docker ──

class FakeDocker:
    def __init__(self):
        self.created: list[tuple[list[str], dict]] = []
        self.removed: list[str] = []
        self.running: dict[str, bool] = {}
        self.viewers: dict[str, int | None] = {}
        self.ready = True
        self.network_ok = True
        self.orphans: list[tuple[str, str]] = []

    async def ensure_network(self):
        if not self.network_ok:
            raise dk.DockerError("no network")

    async def create_session_container(self, args):
        cid = f"cid{len(self.created):04d}" + "0" * 56
        env = {}
        for i, a in enumerate(args):
            if a == "-e" and "=" in args[i + 1]:
                k, v = args[i + 1].split("=", 1)
                env[k] = v
        self.created.append((args, env))
        self.running[cid] = True
        return cid

    async def published_upstream(self, cid):
        return "172.28.0.1:32811"

    async def wait_ready(self, cid, timeout=45.0):
        return self.ready

    async def container_state(self, cid):
        return self.running.get(cid, False), None

    async def established_viewers(self, cid):
        return self.viewers.get(cid, 0)

    async def remove_container(self, cid):
        self.removed.append(cid)
        self.running.pop(cid, None)

    async def list_session_containers(self):
        return self.orphans


@pytest.fixture()
def fake_docker(monkeypatch):
    fd = FakeDocker()
    for n in ("ensure_network", "create_session_container", "published_upstream", "wait_ready",
              "container_state", "established_viewers", "remove_container", "list_session_containers"):
        monkeypatch.setattr(dk, n, getattr(fd, n))
    # 사이드카가 이 출구들을 건 상태(동적 허용 목록 시험은 tests/test_rbi_egress.py)
    fd.allow = ["192.168.10.170:80", "192.168.10.170:443", "192.168.10.171:80", "192.168.10.171:443"]
    monkeypatch.setattr(dk, "read_guard_state", lambda: dk.GuardState(ok=True, reason="ok", age=5.0, allow=list(fd.allow)))
    return fd


@pytest.fixture(autouse=True)
def _allow_file(tmp_path, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "rbi_allow_file", str(tmp_path / "allow" / "allow.txt"))


async def _seed_users(db, *users: User) -> None:
    """거두기는 세션 소유자 계정이 살아 있는지도 본다 — 계정 행이 없으면 세션을 끝내므로 시험에서도 넣어 둔다."""
    for u in users:
        db.add(User(id=u.id, username=u.username, display_name=u.display_name, is_admin=u.is_admin,
                    is_active=True, email=u.email, token_version=0))
    await db.commit()


async def _target(db, **kw) -> RbiTarget:
    t = RbiTarget()
    data = {"key": "portal", "name": "Portal", "url": TARGET}
    data.update(kw)
    svc.apply_target_fields(t, data, creating=True)
    await svc.refresh_egress(t)
    db.add(t)
    await db.commit()
    return t


# ── 권한 ──

async def test_user_can_use_default_deny(db_session):
    t = await _target(db_session)
    assert await svc.user_can_use(db_session, ADMIN, t)
    assert not await svc.user_can_use(db_session, ALICE, t)
    svc.apply_target_fields(t, {"allowed_user_ids": [ALICE.id]}, creating=False)
    await db_session.commit()
    assert await svc.user_can_use(db_session, ALICE, t)
    assert not await svc.user_can_use(db_session, BOB, t)
    t.enabled = False
    assert not await svc.user_can_use(db_session, ALICE, t)


async def test_user_can_use_via_group(db_session):
    g = Group(name="netops")
    db_session.add(g)
    await db_session.flush()
    db_session.add(GroupMember(group_id=g.id, user_id=BOB.id))
    t = await _target(db_session, allowed_group_ids=[g.id])
    assert await svc.user_can_use(db_session, BOB, t)
    assert not await svc.user_can_use(db_session, ALICE, t)


# ── 세션 수명 ──

async def test_start_session_creates_hardened_container_with_policies(db_session, fake_docker):
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, "10.0.0.5")
    assert s.status == "running" and s.upstream == "172.28.0.1:32811"
    assert len(s.id) == 32 and s.container_name.endswith(s.id[:12])
    args, env = fake_docker.created[0]
    assert "--read-only" in args and "ALL" in args
    assert "RBI_POLICY_JSON" in env and "RBI_KASMVNC_YAML" in env
    assert json.loads(env["RBI_POLICY_JSON"])["URLAllowlist"][0] == "192.168.10.170"
    assert "no_user_session_timeout: 900" in env["RBI_KASMVNC_YAML"]
    assert args[-2] == "-c" and "zz-rbi-policy.json" in args[-1] and "kasm_startup.sh --wait" in args[-1]
    # 비밀번호는 암호문으로만 저장
    assert "VNC_PW=" in " ".join(args) and s.vnc_password_enc not in " ".join(args)
    # 같은 사용자가 다시 시작하면 같은 세션
    again = await svc.start_session(db_session, ALICE, t, None)
    assert again.id == s.id and len(fake_docker.created) == 1
    # 스트림 인증: 소유자만
    assert svc.stream_auth(s, ALICE.id)[0] == "172.28.0.1:32811"
    assert svc.stream_auth(s, ALICE.id)[1].startswith("Basic ")
    assert svc.stream_auth(s, BOB.id) is None


async def test_start_session_refuses_without_guard(db_session, fake_docker, monkeypatch):
    monkeypatch.setattr(dk, "read_guard_state", lambda: dk.GuardState(ok=False, reason="stale"))
    monkeypatch.setattr(svc, "GUARD_WAIT_SECONDS", 0)
    t = await _target(db_session)
    with pytest.raises(svc.SessionStartError) as ei:
        await svc.start_session(db_session, ADMIN, t, None)
    assert ei.value.status == 503 and "stale" in str(ei.value)
    assert fake_docker.created == []


async def test_start_session_failure_cleans_up(db_session, fake_docker):
    fake_docker.ready = False
    t = await _target(db_session)
    with pytest.raises(svc.SessionStartError):
        await svc.start_session(db_session, ADMIN, t, None)
    rows = list((await db_session.execute(select(RbiSession))).scalars())
    assert rows[0].status == "error" and rows[0].end_reason == "error"
    assert fake_docker.removed  # 컨테이너 제거


async def test_start_session_limits(db_session, fake_docker, monkeypatch):
    t = await _target(db_session)
    t2 = await _target(db_session, key="other", url="http://192.168.10.171")
    await svc.start_session(db_session, ADMIN, t, None)
    with pytest.raises(svc.SessionStartError) as ei:
        await svc.start_session(db_session, ADMIN, t2, None)
    assert ei.value.status == 409
    monkeypatch.setattr(svc.get_settings(), "rbi_max_sessions", 1)
    with pytest.raises(svc.SessionStartError) as ei:
        await svc.start_session(db_session, ALICE, t, None)
    assert ei.value.status in (403, 429)  # 상한 또는 권한
    monkeypatch.setattr(svc.get_settings(), "rbi_max_sessions", 4)


async def test_reaper_ends_exited_idle_and_expired(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, BOB)
    t = await _target(db_session, idle_minutes=1, max_hours=1)
    s1 = await svc.start_session(db_session, ADMIN, t, None)   # 컨테이너가 죽음
    # 두 번째 세션은 다른 사용자(BOB 허용)로
    svc.apply_target_fields(t, {"allowed_user_ids": [BOB.id]}, creating=False)
    await db_session.commit()
    sb = await svc.start_session(db_session, BOB, t, None)
    fake_docker.running[s1.container_id] = False
    # BOB: 핑이 오래 끊기고 뷰어도 없다 → idle
    sb.last_seen_at = datetime.now(timezone.utc) - timedelta(minutes=10)
    await db_session.commit()
    fake_docker.viewers[sb.container_id] = 0
    # 다른 스택(접두어가 다른 이름)의 세션 컨테이너는 같은 라벨이어도 건드리지 않는다
    fake_docker.orphans = [("deadbeef1234", "ws-rbi-s-orphan"), ("cafebabe5678", "r22e-rbi-s-other"), ("0badf00d9999", "/ws-rbi-s-slash")]
    st = await svc.reap_once(db_session)
    assert st["ended"] == 2 and st["orphans"] == 2
    assert "cafebabe5678" not in fake_docker.removed and "0badf00d9999" in fake_docker.removed
    await db_session.refresh(s1)
    await db_session.refresh(sb)
    assert s1.status == "ended" and s1.end_reason == "container_exited"
    assert sb.status == "ended" and sb.end_reason == "idle"
    assert "deadbeef1234" in fake_docker.removed


async def test_reaper_keeps_session_with_viewer_and_kills_expired(db_session, fake_docker):
    await _seed_users(db_session, ADMIN)
    t = await _target(db_session, idle_minutes=1, max_hours=1)
    s = await svc.start_session(db_session, ADMIN, t, None)
    s.last_seen_at = datetime.now(timezone.utc) - timedelta(minutes=30)
    await db_session.commit()
    fake_docker.viewers[s.container_id] = 1          # 뷰어가 붙어 있으면 핑이 없어도 유지
    assert (await svc.reap_once(db_session))["ended"] == 0
    s.started_at = datetime.now(timezone.utc) - timedelta(hours=2)
    await db_session.commit()
    assert (await svc.reap_once(db_session))["ended"] == 1
    await db_session.refresh(s)
    assert s.end_reason == "max_lifetime"


# ── API ──

def _app(user: User | None, db):
    app = FastAPI()
    app.include_router(rbi_router.router)
    if user is not None:
        app.dependency_overrides[get_current_user] = lambda: user
        app.dependency_overrides[get_rbi_user] = lambda: user

    async def _db():
        yield db
    app.dependency_overrides[get_db] = _db
    return app


async def _req(user, db, method, url, **kw):
    async with AsyncClient(transport=ASGITransport(app=_app(user, db)), base_url="http://t") as c:
        return await c.request(method, url, **kw)


@pytest.fixture(autouse=True)
def _module_on(monkeypatch):
    from app.modules import registry
    monkeypatch.setitem(registry._module_states, "rbi", True)


async def test_api_targets_filtered_by_permission(db_session, fake_docker):
    await _target(db_session, allowed_user_ids=[ALICE.id])
    await _target(db_session, key="hidden", url="http://192.168.10.171")
    r = await _req(ALICE, db_session, "GET", "/api/rbi/targets")
    assert r.status_code == 200
    keys = [t["key"] for t in r.json()["targets"]]
    assert keys == ["portal"]
    assert "allowed_user_ids" not in r.json()["targets"][0]   # 사용자 응답에는 권한 목록 없음
    r = await _req(ADMIN, db_session, "GET", "/api/rbi/targets")
    assert sorted(t["key"] for t in r.json()["targets"]) == ["hidden", "portal"]


async def test_api_session_flow_and_ownership(db_session, fake_docker):
    t = await _target(db_session, allowed_user_ids=[ALICE.id, BOB.id])
    r = await _req(ALICE, db_session, "POST", "/api/rbi/sessions", json={"target_id": t.id})
    assert r.status_code == 201, r.text
    body = r.json()
    sid = body["id"]
    assert body["stream_url"] == f"/rbi/{sid}/" and body["status"] == "running"
    # 세션 시작이 쿠키를 심지 않는다(예전 경로 한정 쿠키 폐지 — rbi 출처 세션 쿠키가 스트림까지 덮는다)
    assert "set-cookie" not in r.headers
    # 다른 사용자는 상태도 못 보고 끝내지도 못한다
    assert (await _req(BOB, db_session, "GET", f"/api/rbi/sessions/{sid}")).status_code == 404
    assert (await _req(BOB, db_session, "DELETE", f"/api/rbi/sessions/{sid}")).status_code == 404
    # 소유자 핑
    assert (await _req(ALICE, db_session, "POST", f"/api/rbi/sessions/{sid}/ping")).json()["status"] == "running"
    # 입장 티켓·enter 는 없어졌다
    assert (await _req(ALICE, db_session, "POST", f"/api/rbi/sessions/{sid}/ticket")).status_code in (404, 405)
    assert (await _req(None, db_session, "GET", f"/api/rbi/enter/{sid}?t=x")).status_code in (404, 405)
    # 관리자도 세션을 끝낼 수 있다
    r = await _req(ADMIN, db_session, "DELETE", f"/api/rbi/sessions/{sid}")
    assert r.status_code == 200 and r.json()["status"] == "ended" and r.json()["end_reason"] == "admin"
    assert fake_docker.removed


async def test_api_my_recent_sessions_only_mine(db_session, fake_docker):
    t = await _target(db_session, allowed_user_ids=[ALICE.id, BOB.id])
    a = await svc.start_session(db_session, ALICE, t, None)
    await svc.stop_session(db_session, a, "user")
    await svc.start_session(db_session, BOB, t, None)
    r = await _req(ALICE, db_session, "GET", "/api/rbi/sessions/me")
    assert r.json()["sessions"] == []
    r = await _req(ALICE, db_session, "GET", "/api/rbi/sessions/me?recent=1")
    got = r.json()["sessions"]
    assert [x["id"] for x in got] == [a.id] and got[0]["status"] == "ended" and got[0]["end_reason"] == "user"


async def test_api_permission_denied_target(db_session, fake_docker):
    t = await _target(db_session)
    r = await _req(ALICE, db_session, "POST", "/api/rbi/sessions", json={"target_id": t.id})
    assert r.status_code == 404
    assert fake_docker.created == []


async def test_internal_stream_auth(db_session, fake_docker, rbi_origin, fake_redis):
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    db_session.add_all([User(id=ALICE.id, username="alice", display_name="앨리스", is_active=True, email="al@x", token_version=0),
                        User(id=BOB.id, username="bob", display_name="밥", is_active=True, email="b@x", token_version=0)])
    await db_session.commit()
    s = await svc.start_session(db_session, ALICE, t, None)
    url = "/api/internal/rbi/auth"
    ck_alice = await site_cookie(fake_redis, ALICE.id)
    good = {"Host": RBI_HOST, "X-Original-URI": f"/rbi/{s.id}/websockify", "Cookie": ck_alice}
    r = await _req(None, db_session, "GET", url, headers=good)
    assert r.status_code == 204, r.text
    assert r.headers["x-rbi-upstream"] == "172.28.0.1:32811" and r.headers["x-rbi-authorization"].startswith("Basic ")
    # 쿠키 없음 → 401 · 다른 사용자의 rbi 세션 → 403
    assert (await _req(None, db_session, "GET", url, headers={"Host": RBI_HOST, "X-Original-URI": f"/rbi/{s.id}/"})).status_code == 401
    ck_bob = await site_cookie(fake_redis, BOB.id)
    assert (await _req(None, db_session, "GET", url, headers={**good, "Cookie": ck_bob})).status_code == 403
    # 워크스페이스 출처(Host)로는 스트림을 열지 않는다 — 같은 쿠키여도 403
    assert (await _req(None, db_session, "GET", url, headers={**good, "Host": "ws.test"})).status_code == 403
    # 모르는 세션·엉뚱한 경로 → 403(auth_request 는 401/403 만 전달)
    assert (await _req(None, db_session, "GET", url, headers={**good, "X-Original-URI": "/rbi/" + "0" * 32 + "/"})).status_code == 403
    assert (await _req(None, db_session, "GET", url, headers={**good, "X-Original-URI": "/api/files"})).status_code == 403
    # 끝난 세션 → 403
    await svc.stop_session(db_session, s, "user")
    assert (await _req(None, db_session, "GET", url, headers=good)).status_code == 403


async def test_internal_stream_auth_rejects_workspace_session_cookie(db_session, fake_docker, rbi_origin, fake_redis, monkeypatch):
    """워크스페이스 세션 쿠키로는 스트림이 안 열린다(예전엔 받았다) — 그 쿠키는 rbi 출처로 오지도 않지만, 와도 안 본다."""
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    tok = sign_value({"user_id": ALICE.id, "tv": 0, "sid": "x"})
    r = await _req(None, db_session, "GET", "/api/internal/rbi/auth",
                   headers={"Host": RBI_HOST, "X-Original-URI": f"/rbi/{s.id}/", "Cookie": f"ws_session={tok}"})
    assert r.status_code == 401


async def test_admin_target_crud_and_overview(db_session, fake_docker):
    r = await _req(ADMIN, db_session, "POST", "/api/admin/rbi/targets",
                   json={"key": "PORTAL", "name": "Portal", "url": "192.168.10.170", "allowed_user_ids": [ALICE.id]})
    assert r.status_code == 201, r.text
    tid = r.json()["id"]
    assert r.json()["key"] == "portal" and r.json()["url"] == TARGET and r.json()["private_ip"] is True
    assert r.json()["allowed_hosts"] == ["192.168.10.170"]
    # 중복 키
    assert (await _req(ADMIN, db_session, "POST", "/api/admin/rbi/targets", json={"key": "portal", "name": "x", "url": "10.0.0.1"})).status_code == 409
    # 검증
    assert (await _req(ADMIN, db_session, "POST", "/api/admin/rbi/targets", json={"key": "k2", "name": "x", "url": "ftp://x"})).status_code == 400
    assert (await _req(ADMIN, db_session, "PUT", f"/api/admin/rbi/targets/{tid}", json={"idle_minutes": 0})).status_code == 400
    r = await _req(ADMIN, db_session, "PUT", f"/api/admin/rbi/targets/{tid}", json={"downloads": True, "idle_minutes": 30})
    assert r.status_code == 200 and r.json()["policy"]["downloads"] is True and r.json()["policy"]["idle_minutes"] == 30
    # 일반 사용자는 관리 API 불가
    assert (await _req(ALICE, db_session, "GET", "/api/admin/rbi")).status_code == 403
    r = await _req(ADMIN, db_session, "GET", "/api/admin/rbi")
    assert r.status_code == 200
    assert r.json()["status"]["guard"]["ok"] is True and r.json()["status"]["image"]
    # 활성 세션이 있는 대상 삭제 → 세션도 종료
    await _req(ALICE, db_session, "POST", "/api/rbi/sessions", json={"target_id": tid})
    assert (await _req(ADMIN, db_session, "DELETE", f"/api/admin/rbi/targets/{tid}")).status_code == 200
    assert fake_docker.removed
    assert (await _req(ADMIN, db_session, "GET", "/api/admin/rbi")).json()["targets"] == []


async def test_module_disabled_blocks_user_api(db_session, fake_docker, monkeypatch):
    from app.modules import registry
    monkeypatch.setitem(registry._module_states, "rbi", False)
    r = await _req(ADMIN, db_session, "GET", "/api/rbi/targets")
    assert r.status_code == 403


# ── 미러 모드(P1) ──

def test_validate_mode_and_agent_policy():
    assert pol.validate_mode(None) == "pixel" and pol.validate_mode(" Mirror ") == "mirror"
    with pytest.raises(ValueError):
        pol.validate_mode("dom")
    tp = pol.TargetPolicy(url=TARGET, clipboard_to_browser=False, clipboard_from_browser=True, downloads=True, uploads=False)
    assert pol.mirror_agent_policy(tp) == {"ci": False, "co": True, "dl": True, "ul": False}


def test_mirror_container_env_carries_policy_allowlist_idle_and_devtools_1():
    tp = pol.TargetPolicy(url="http://192.168.10.170:8080", allowed_hosts=["10.0.0.9"], idle_minutes=20, clipboard_from_browser=False)
    env = pol.mirror_container_env(tp, sid="b" * 32, auth_header="Basic eA==")
    assert env["MIRROR_AUTH"] == "Basic eA==" and env["MIRROR_SID"] == "b" * 32 and env["MIRROR_PORT"] == "6901"
    assert json.loads(env["MIRROR_POLICY"]) == {"ci": True, "co": False, "dl": False, "ul": False}
    assert json.loads(env["MIRROR_ALLOW"]) == ["192.168.10.170:8080", "10.0.0.9"]
    assert env["MIRROR_IDLE_SECONDS"] == "1200"
    chrome = json.loads(env["RBI_POLICY_JSON"])
    # P0 함정: 정책 2(금지)면 CDP 가 페이지에 못 붙는다 → 미러는 1. URL 허용목록·다운로드 차단은 픽셀과 같다
    assert chrome["DeveloperToolsAvailability"] == 1 and chrome["RemoteDebuggingAllowed"] is True
    assert chrome["URLBlocklist"] == ["*"] and chrome["URLAllowlist"][:2] == ["192.168.10.170:8080", "10.0.0.9"]
    assert chrome["DownloadRestrictions"] == 3 and chrome["AllowFileSelectionDialogs"] is False
    assert "VNC_PW" not in env and "remote-debugging-port" not in json.dumps(env)


def test_mirror_create_args_label_and_tmpfs():
    args = pol.mirror_docker_create_args(name="ws-rbi-s-y", network="ws-rbi", publish_ip="172.28.0.1", image="localhost/just-workspace-rbi-mirror:latest",
                                         env={"A": "1"}, cpu=1.5, memory_mb=1024)
    s = " ".join(args)
    assert "app.just-workspace.rbi.mode=mirror" in s and "app.just-workspace.rbi=session" in s
    assert "--tmpfs /tmp:" in s and "--tmpfs /home/node:" in s and "--tmpfs /etc/chromium/policies/managed:" in s
    assert "/etc/kasmvnc" not in s and "--cpus 1.5" in s and "--memory 1024m" in s
    assert "--entrypoint /bin/sh localhost/just-workspace-rbi-mirror:latest -c " in s


async def test_target_mode_default_and_modes(db_session, fake_docker):
    t = await _target(db_session)
    assert t.mode == "pixel" and svc.target_dict(t)["modes"] == ["pixel"]
    svc.apply_target_fields(t, {"mode": "mirror"}, creating=False)
    assert t.mode == "mirror" and svc.target_dict(t)["mode"] == "mirror" and svc.target_dict(t)["modes"] == ["mirror", "pixel"]
    with pytest.raises(ValueError):
        svc.apply_target_fields(t, {"mode": "vnc"}, creating=False)
    t.mode = None  # 옛 행
    assert svc.target_mode(t) == "pixel"


async def test_start_mirror_session_uses_mirror_image_env_and_auth(db_session, fake_docker):
    t = await _target(db_session, mode="mirror", allowed_user_ids=[ALICE.id], clipboard_from_browser=False)
    s = await svc.start_session(db_session, ALICE, t, None)
    assert s.status == "running" and s.mode == "mirror"
    args, env = fake_docker.created[0]
    assert svc.get_settings().rbi_mirror_image in args and "kasmweb/chromium:1.18.0" not in args
    assert env["MIRROR_SID"] == s.id and json.loads(env["MIRROR_POLICY"])["co"] is False
    assert "RBI_KASMVNC_YAML" not in env and args[-1] == pol.MIRROR_STARTUP_SCRIPT
    # nginx 에 넘기는 Authorization 은 에이전트 env 와 같은 값(mirror:<비밀>)
    up, authz = svc.stream_auth(s, ALICE.id)
    import base64 as b64
    assert authz == env["MIRROR_AUTH"] and b64.b64decode(authz.split()[1]).decode().startswith("mirror:")
    assert svc.session_dict(s, t)["mode"] == "mirror" and svc.session_dict(s, t)["modes"] == ["mirror", "pixel"]


async def test_mirror_target_can_fallback_to_pixel_but_pixel_target_cannot_mirror(db_session, fake_docker):
    tm = await _target(db_session, mode="mirror")
    s = await svc.start_session(db_session, ADMIN, tm, None, mode="pixel")
    assert s.mode == "pixel" and "kasmweb/chromium:1.18.0" in fake_docker.created[0][0]
    await svc.stop_session(db_session, s, "user")
    tp = await _target(db_session, key="pix", url="http://192.168.10.171")
    with pytest.raises(svc.SessionStartError) as ei:
        await svc.start_session(db_session, ADMIN, tp, None, mode="mirror")
    assert ei.value.status == 400 and len(fake_docker.created) == 1


async def test_api_switch_mode_restarts_session_and_audits(db_session, fake_docker):
    t = await _target(db_session, mode="mirror", allowed_user_ids=[ALICE.id, BOB.id])
    r = await _req(ALICE, db_session, "POST", "/api/rbi/sessions", json={"target_id": t.id})
    assert r.status_code == 201 and r.json()["mode"] == "mirror"
    sid = r.json()["id"]
    # 다른 사용자는 못 바꾼다
    assert (await _req(BOB, db_session, "POST", f"/api/rbi/sessions/{sid}/mode", json={"mode": "pixel"})).status_code == 404
    r = await _req(ALICE, db_session, "POST", f"/api/rbi/sessions/{sid}/mode", json={"mode": "pixel"})
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["id"] != sid and new["mode"] == "pixel" and new["stream_url"] == f"/rbi/{new['id']}/"
    old = await db_session.get(RbiSession, sid)
    assert old.status == "ended" and old.end_reason == "mode_switch"
    assert len(fake_docker.created) == 2 and fake_docker.removed
    # 잘못된 방식
    assert (await _req(ALICE, db_session, "POST", f"/api/rbi/sessions/{new['id']}/mode", json={"mode": "dom"})).status_code == 400
    from app.db.models import AuditLog
    actions = [a.action for a in (await db_session.execute(select(AuditLog))).scalars()]
    assert "rbi.session.mode" in actions


@pytest.mark.parametrize("mode,path,ok", [
    ("mirror", "view", True), ("mirror", "mirror", True), ("mirror", "asset/" + "a" * 64, True),
    ("mirror", "font/cjks-400-k0.woff2", True), ("mirror", "download/" + "c" * 32, True), ("mirror", "upload/" + "d" * 32, True),
    ("mirror", "", False), ("mirror", "websockify", False), ("mirror", "vnc.html", False), ("mirror", "asset/../view", False),
    ("mirror", "font/../../etc/passwd", False), ("mirror", "dev/", False),
    ("pixel", "", True), ("pixel", "websockify", True), ("pixel", "Downloads/x.txt", True),
    ("pixel", "view", False), ("pixel", "mirror", False), ("pixel", "asset/" + "a" * 64, False),
])
async def test_internal_auth_path_must_match_session_mode(db_session, fake_docker, rbi_origin, fake_redis, mode, path, ok):
    t = await _target(db_session, mode="mirror", allowed_user_ids=[ALICE.id])
    db_session.add(User(id=ALICE.id, username="alice", display_name="앨리스", is_active=True, email="al@x", token_version=0))
    await db_session.commit()
    s = await svc.start_session(db_session, ALICE, t, None, mode=mode)
    cookie = await site_cookie(fake_redis, ALICE.id)
    r = await _req(None, db_session, "GET", "/api/internal/rbi/auth",
                   headers={"Host": RBI_HOST, "X-Original-URI": f"/rbi/{s.id}/{path}", "Cookie": cookie})
    assert r.status_code == (204 if ok else 403)


async def test_reaper_keeps_container_of_session_still_starting(db_session, fake_docker):
    """컨테이너는 만들어졌는데 container_id 가 아직 커밋되지 않은 순간에 정리가 돌아도 그 컨테이너를 지우지 않는다."""
    t = await _target(db_session)
    name = f"{svc.get_settings().rbi_container_prefix}abcdef012345"
    db_session.add(RbiSession(
        id="a" * 32, user_id=ADMIN.id, target_id=t.id, target_key=t.key, status="starting", mode="pixel",
        container_name=name, vnc_password_enc="x", idle_minutes=t.idle_minutes, max_hours=t.max_hours,
        started_at=datetime.now(timezone.utc), last_seen_at=datetime.now(timezone.utc),
    ))
    await db_session.commit()
    fake_docker.orphans = [("feedface0001", name)]
    st = await svc.reap_once(db_session)
    assert st["orphans"] == 0 and "feedface0001" not in fake_docker.removed
