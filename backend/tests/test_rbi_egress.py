"""격리 브라우저 동적 출구 허용 목록(app/rbi/egress.py) — 대상 검증 거부·강제·이름 고정 · 관리 API → 허용 파일 · 감사 · 세션 시작 전 확인.

사이드카(deploy/rbi-netfilter)가 파일을 읽어 체인에 거는 것은 임시 컨테이너 시험(deploy/rbi-netfilter/test-propagation.sh — docs/rbi.md §8)이 본다.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.admin.router import require_admin
from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import AuditLog, User
from app.db.session import get_db
from app.groups.models import Group, GroupMember  # noqa: F401
from app.rbi import docker as dk
from app.rbi import egress as eg
from app.rbi import router as rbi_router
from app.rbi import service as svc
from app.rbi.models import RbiTarget
from app.rbi.site import get_rbi_user
from tests.test_rbi import ALICE, FakeDocker  # noqa: F401

ADMIN = User(id="u-admin", username="admin", display_name="관리자", is_admin=True, is_active=True, email="a@x", token_version=0)
DNS = {"portal.lan": ["192.168.10.170"], "nas.lan": ["192.168.10.20", "192.168.10.21"], "rp.lan": ["192.168.10.150"],
       "pub.example": ["8.8.8.8"], "loop.lan": ["127.0.0.1"], "workspace.test": ["192.168.10.150"], "rbi.workspace.test": ["192.168.10.150"]}


@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path):
    s = get_settings()
    monkeypatch.setattr(s, "rbi_allow_file", str(tmp_path / "allow" / "allow.txt"))
    monkeypatch.setattr(s, "rbi_protected", "192.168.10.120,192.168.10.1")
    monkeypatch.setattr(s, "rbi_allow_ceiling", "")
    monkeypatch.setattr(s, "app_url", "https://workspace.test")
    monkeypatch.setattr(s, "rbi_public_origin", "https://rbi.workspace.test")

    async def resolve(h):
        return DNS.get(h, [])

    async def nets():
        return eg._nets("172.31.200.0/24,172.28.0.0/24,172.17.0.0/16,172.18.0.0/16")
    monkeypatch.setattr(eg, "resolve_ipv4", resolve)
    monkeypatch.setattr(eg, "docker_networks", nets)
    from app.modules import registry
    monkeypatch.setitem(registry._module_states, "rbi", True)
    return s


@pytest.fixture()
def guard(monkeypatch):
    fd = FakeDocker()
    for n in ("ensure_network", "create_session_container", "published_upstream", "wait_ready",
              "container_state", "established_viewers", "remove_container", "list_session_containers"):
        monkeypatch.setattr(dk, n, getattr(fd, n))
    state = {"allow": []}
    monkeypatch.setattr(dk, "read_guard_state", lambda: dk.GuardState(ok=True, reason="ok", age=1.0, allow=list(state["allow"])))
    monkeypatch.setattr(svc, "GUARD_WAIT_SECONDS", 0.2)
    fd.state = state
    return fd


def _app(db):
    app = FastAPI()
    app.include_router(rbi_router.router)
    app.dependency_overrides[require_admin] = lambda: ADMIN
    app.dependency_overrides[get_current_user] = lambda: ADMIN
    app.dependency_overrides[get_rbi_user] = lambda: ADMIN

    async def _db():
        yield db
    app.dependency_overrides[get_db] = _db
    return app


async def _req(db, method, url, **kw):
    async with AsyncClient(transport=ASGITransport(app=_app(db)), base_url="http://t") as c:
        return await c.request(method, url, **kw)


def _file_lines() -> list[str]:
    try:
        with open(get_settings().rbi_allow_file, encoding="utf-8") as f:
            return [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    except FileNotFoundError:
        return []


async def _audit(db, action) -> list[dict]:
    rows = (await db.execute(select(AuditLog).where(AuditLog.action == action))).scalars().all()
    return [json.loads(r.details) if isinstance(r.details, str) else r.details for r in rows]


# ── 검증 ──

@pytest.mark.parametrize("url,hosts,ports,msg", [
    ("http://8.8.8.8", [], [], "허용 상한"),                         # 공인 IP
    ("http://pub.example", [], [], "허용 상한"),                     # 공인으로 풀리는 이름
    ("http://127.0.0.1", [], [], "루프백"),
    ("http://loop.lan", [], [], "루프백"),
    ("http://169.254.1.1", [], [], "루프백"),
    ("http://172.28.0.10:8000", [], [8000], "도커 브리지"),         # 워크스페이스 컨테이너 망
    ("http://172.31.200.5", [], [], "도커 브리지"),                  # 세션 대역
    ("http://192.168.10.120", [], [], "워크스페이스 자신"),            # RBI_PROTECTED(앱 호스트)
    ("http://192.168.10.1", [], [], "워크스페이스 자신"),              # 게이트웨이
    ("http://rp.lan", [], [], "워크스페이스 자신"),                  # APP_URL/RBI_PUBLIC_ORIGIN 이 풀리는 RP
    ("http://192.168.10.170:8080", [], [], "포트는 80·443"),          # 추가 포트 미명시
    ("http://192.168.10.170", ["192.168.10.171:22"], [], "포트는 80·443"),
    ("http://nope.lan", [], [], "이름을 풀지"),
    ("http://[fd00::1]", [], [], "IPv6"),
    ("http://bad_name", [], [], "형식"),
])
async def test_validation_rejects(url, hosts, ports, msg):
    with pytest.raises(ValueError) as ei:
        await eg.compute_egress(url, hosts, ports)
    assert msg in str(ei.value), str(ei.value)


async def test_force_allows_own_host_with_warning_but_not_hard_denied():
    entries, warn = await eg.compute_egress("http://192.168.10.120", [], [], force=True)
    assert [e.line() for e in entries] == ["192.168.10.120:80", "192.168.10.120:443"] and all(e.forced for e in entries)
    assert warn and "강제로" in warn[0]
    for bad in ("http://127.0.0.1", "http://172.28.0.10", "http://8.8.8.8"):
        with pytest.raises(ValueError):
            await eg.compute_egress(bad, [], [], force=True)


async def test_hostname_pinned_and_ports():
    entries, warn = await eg.compute_egress("https://nas.lan:8443/ui", ["portal.lan", "192.168.10.171:443"], [8443])
    assert warn == []
    assert [(e.host, e.line()) for e in entries] == [
        ("nas.lan", "192.168.10.20:8443"),            # 여러 IP 중 첫 번째로 고정
        ("portal.lan", "192.168.10.170:80"), ("portal.lan", "192.168.10.170:443"),
        ("192.168.10.171", "192.168.10.171:443"),
    ]
    assert eg.add_host_args(entries) == ["--add-host", "nas.lan:192.168.10.20", "--add-host", "portal.lan:192.168.10.170"]


def test_extra_ports_validation():
    assert eg.validate_extra_ports([8443, "8080", 80, 8080]) == [8080, 8443]
    for bad in ([0], [70000], ["x"], "8080"):
        with pytest.raises(ValueError):
            eg.validate_extra_ports(bad)


# ── 관리 API → 허용 파일 → 감사 ──

async def test_admin_add_disable_delete_propagates_and_audits(db_session):
    r = await _req(db_session, "POST", "/api/admin/rbi/targets", json={"key": "nas", "name": "NAS", "url": "http://nas.lan"})
    assert r.status_code == 201, r.text
    tid = r.json()["id"]
    assert [e["ip"] for e in r.json()["egress"]] == ["192.168.10.20", "192.168.10.20"]
    assert _file_lines() == ["192.168.10.20:443  # nas", "192.168.10.20:80  # nas"]
    adds = await _audit(db_session, "rbi.allow.add")
    assert adds and adds[-1]["entries"] == ["192.168.10.20:443", "192.168.10.20:80"] and adds[-1]["target"] == "nas"
    # 두 번째 대상이 같은 IP 를 쓰면 줄은 하나(주석에 두 키)
    r = await _req(db_session, "POST", "/api/admin/rbi/targets", json={"key": "nas2", "name": "NAS2", "url": "http://192.168.10.20"})
    assert r.status_code == 201
    assert _file_lines() == ["192.168.10.20:443  # nas,nas2", "192.168.10.20:80  # nas,nas2"]
    assert len(await _audit(db_session, "rbi.allow.add")) == 1          # 새 출구가 없으니 추가 감사도 없다
    # 끄면 그 대상만의 출구가 빠진다(겹치면 남는다) → 지우면 빠지고 감사
    assert (await _req(db_session, "PUT", f"/api/admin/rbi/targets/{tid}", json={"url": "http://portal.lan"})).status_code == 200
    assert _file_lines() == ["192.168.10.170:443  # nas", "192.168.10.170:80  # nas", "192.168.10.20:443  # nas2", "192.168.10.20:80  # nas2"]
    assert (await _req(db_session, "PUT", f"/api/admin/rbi/targets/{tid}", json={"enabled": False})).status_code == 200
    assert _file_lines() == ["192.168.10.20:443  # nas2", "192.168.10.20:80  # nas2"]
    rem = await _audit(db_session, "rbi.allow.remove")
    assert rem[-1]["entries"] == ["192.168.10.170:443", "192.168.10.170:80"]
    t2 = (await _req(db_session, "GET", "/api/admin/rbi")).json()["targets"]
    nas2 = next(t for t in t2 if t["key"] == "nas2")
    assert (await _req(db_session, "DELETE", f"/api/admin/rbi/targets/{nas2['id']}")).status_code == 200
    assert _file_lines() == []
    assert (await _audit(db_session, "rbi.allow.remove"))[-1]["entries"] == ["192.168.10.20:443", "192.168.10.20:80"]
    # 대상 감사도 남는다
    for a in ("rbi.target.create", "rbi.target.update", "rbi.target.delete"):
        assert await _audit(db_session, a), a


async def test_admin_rejects_and_force(db_session):
    r = await _req(db_session, "POST", "/api/admin/rbi/targets", json={"key": "rp", "name": "RP", "url": "http://rp.lan"})
    assert r.status_code == 400 and "워크스페이스 자신" in r.json()["detail"]
    r = await _req(db_session, "POST", "/api/admin/rbi/targets", json={"key": "pub", "name": "P", "url": "http://8.8.8.8"})
    assert r.status_code == 400
    r = await _req(db_session, "POST", "/api/admin/rbi/targets", json={"key": "alt", "name": "A", "url": "http://192.168.10.170:8080"})
    assert r.status_code == 400 and "포트" in r.json()["detail"]
    assert _file_lines() == [] and not (await db_session.execute(select(RbiTarget))).scalars().all()
    r = await _req(db_session, "POST", "/api/admin/rbi/targets", json={"key": "alt", "name": "A", "url": "http://192.168.10.170:8080", "extra_ports": [8080]})
    assert r.status_code == 201 and r.json()["extra_ports"] == [8080]
    r = await _req(db_session, "POST", "/api/admin/rbi/targets", json={"key": "rp", "name": "RP", "url": "http://rp.lan", "force": True})
    assert r.status_code == 201 and r.json()["egress_forced"] is True and r.json()["warnings"]
    assert "192.168.10.150:443 force  # rp" in _file_lines()
    created = await _audit(db_session, "rbi.target.create")
    assert any(c.get("forced") for c in created)
    # 수정 실패는 DB 를 바꾸지 않는다
    tid = r.json()["id"]
    assert (await _req(db_session, "PUT", f"/api/admin/rbi/targets/{tid}", json={"url": "http://8.8.8.8"})).status_code == 400
    assert (await _req(db_session, "GET", "/api/admin/rbi")).json()["targets"][-1]["url"] in ("http://rp.lan", "http://192.168.10.170:8080")


async def test_status_shows_desired_applied_pending(db_session, guard):
    await _req(db_session, "POST", "/api/admin/rbi/targets", json={"key": "portal", "name": "P", "url": "http://192.168.10.170"})
    st = (await _req(db_session, "GET", "/api/admin/rbi")).json()["status"]
    assert st["egress"]["desired"] == ["192.168.10.170:443", "192.168.10.170:80"]
    assert st["egress"]["pending"] == ["192.168.10.170:443", "192.168.10.170:80"]
    guard.state["allow"] = ["192.168.10.170:80", "192.168.10.170:443"]
    st = (await _req(db_session, "GET", "/api/admin/rbi")).json()["status"]
    assert st["egress"]["pending"] == [] and st["guard"]["allow"] == ["192.168.10.170:80", "192.168.10.170:443"]


async def test_session_waits_for_sidecar_to_apply_target(db_session, guard):
    r = await _req(db_session, "POST", "/api/admin/rbi/targets", json={"key": "nas", "name": "NAS", "url": "http://nas.lan", "mode": "pixel"})
    t = await svc.get_target(db_session, r.json()["id"])
    with pytest.raises(svc.SessionStartError) as ei:
        await svc.start_session(db_session, ADMIN, t, None)
    assert "아직 이 대상을 허용하지 않습니다" in str(ei.value) and guard.created == []
    guard.state["allow"] = ["192.168.10.20:80", "192.168.10.20:443"]
    s = await svc.start_session(db_session, ADMIN, t, None)
    assert s.status == "running"
    args = guard.created[0][0]
    assert "--add-host" in args and args[args.index("--add-host") + 1] == "nas.lan:192.168.10.20"
    assert args.index("--add-host") < args.index("--entrypoint")


async def test_legacy_target_without_egress_is_filled_by_sync(db_session):
    t = RbiTarget()
    svc.apply_target_fields(t, {"key": "old", "name": "Old", "url": "http://192.168.10.170"}, creating=True)
    t.egress = None
    db_session.add(t)
    await db_session.commit()
    lines = await eg.sync_allow_file(db_session)
    assert [ln.split()[0] for ln in lines] == ["192.168.10.170:443", "192.168.10.170:80"]
    await db_session.refresh(t)
    assert json.loads(t.egress)[0]["ip"] == "192.168.10.170"
    # 파일은 바뀔 때만 쓴다
    assert eg.write_allow_file(lines) is False
