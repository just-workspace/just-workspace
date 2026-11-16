"""격리 브라우저 — 권한 회수·대상 비활성화/삭제·계정 비활성/삭제 시 이미 열린 세션을 종료한다.

docker·Redis 는 가짜(tests/test_rbi.py · tests/rbi_fakes.py 의 구현을 그대로 사용). 검증 항목은
- 관리자 대상 API(비활성화·허용 사용자/그룹 축소·삭제) → 즉시 종료(컨테이너 삭제 · end_reason=admin · 감사에 사유)
- 대상 API 를 거치지 않는 회수(그룹 제외 · 모듈 권한 회수 · 계정 비활성/삭제) → 정리 루프 1회 주기에 종료
- 회수된 세션은 정리 전이라도 스트림 인증(auth_request)이 403
- 권한이 유지된 세션은 변경하지 않는다
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.admin import router as admin_router
from app.admin import users_ext
from app.db.models import AuditLog, SystemSetting, User
from app.groups import router as groups_router
from app.groups.models import ModuleGrant
from app.groups.models import Group, GroupMember
from app.rbi import service as svc
from app.rbi.models import RbiSession
from tests.rbi_fakes import RBI_HOST, fake_redis, rbi_origin, site_cookie  # noqa: F401 — 픽스처
from tests.test_rbi import (  # noqa: F401 — 픽스처·도우미
    ADMIN, ALICE, BOB, _allow_file, _module_on, _req, _seed_users, _target, fake_docker,
)


class _Req:
    headers: dict = {}
    client = None


@pytest.fixture(autouse=True)
def _fresh_stream_cache():
    svc._stream_access_cache.clear()
    yield
    svc._stream_access_cache.clear()


async def _causes(db) -> list[str]:
    rows = (await db.execute(select(AuditLog).where(AuditLog.action == "rbi.session.stop"))).scalars().all()
    return [json.loads(r.details or "{}").get("cause") for r in rows]


def _ended_by_admin(s: RbiSession) -> bool:
    return s.status == "ended" and s.end_reason == "admin" and s.ended_at is not None


# ── 사유 판정(순수 판단) ──

async def test_access_denied_reason_matrix(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    assert await svc.access_denied_reason(db_session, s) is None

    svc.apply_target_fields(t, {"allowed_user_ids": []}, creating=False)
    await db_session.commit()
    assert await svc.access_denied_reason(db_session, s) == "access_revoked"

    svc.apply_target_fields(t, {"allowed_user_ids": [ALICE.id], "enabled": False}, creating=False)
    await db_session.commit()
    assert await svc.access_denied_reason(db_session, s) == "target_disabled"

    t.enabled = True
    alice = await db_session.get(User, ALICE.id)
    alice.is_active = False
    await db_session.commit()
    assert await svc.access_denied_reason(db_session, s) == "user_inactive"

    await db_session.delete(alice)
    await db_session.commit()
    assert await svc.access_denied_reason(db_session, s) == "user_removed"

    s.user_id = ADMIN.id
    await db_session.delete(t)
    await db_session.commit()
    assert await svc.access_denied_reason(db_session, s) == "target_removed"


# ── (a) 대상 비활성화·삭제 ──

async def test_disabling_target_ends_open_sessions_immediately(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    cid = s.container_id
    r = await _req(ADMIN, db_session, "PUT", f"/api/admin/rbi/targets/{t.id}", json={"enabled": False})
    assert r.status_code == 200, r.text
    await db_session.refresh(s)
    assert _ended_by_admin(s)
    assert cid in fake_docker.removed          # 컨테이너가 삭제되어 스트림 연결이 종료된다
    assert await svc.active_sessions(db_session) == []
    assert await _causes(db_session) == ["target_disabled"]
    # 화면이 수신하는 상태 — 종료 + 관리자 종료
    body = (await _req(ALICE, db_session, "GET", f"/api/rbi/sessions/{s.id}")).json()
    assert body["status"] == "ended" and body["end_reason"] == "admin" and body["stream_url"] is None


async def test_disabling_target_ends_admins_own_session_too(db_session, fake_docker):
    """비활성화된 대상은 출구(netfilter 허용)에서도 제외된다 — 관리자 세션이라도 유지하지 않는다."""
    await _seed_users(db_session, ADMIN)
    t = await _target(db_session)
    s = await svc.start_session(db_session, ADMIN, t, None)
    assert (await _req(ADMIN, db_session, "PUT", f"/api/admin/rbi/targets/{t.id}", json={"enabled": False})).status_code == 200
    await db_session.refresh(s)
    assert _ended_by_admin(s)


async def test_deleting_target_ends_sessions_and_audits(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    assert (await _req(ADMIN, db_session, "DELETE", f"/api/admin/rbi/targets/{t.id}")).status_code == 200
    await db_session.refresh(s)
    assert _ended_by_admin(s) and s.container_id in fake_docker.removed
    assert await _causes(db_session) == ["target_removed"]


# ── (b) 사용자·그룹 권한 회수 ──

async def test_removing_user_from_target_ends_only_that_users_session(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE, BOB)
    t = await _target(db_session, allowed_user_ids=[ALICE.id, BOB.id])
    sa = await svc.start_session(db_session, ALICE, t, None)
    sb = await svc.start_session(db_session, BOB, t, None)
    r = await _req(ADMIN, db_session, "PUT", f"/api/admin/rbi/targets/{t.id}", json={"allowed_user_ids": [BOB.id]})
    assert r.status_code == 200, r.text
    await db_session.refresh(sa)
    await db_session.refresh(sb)
    assert _ended_by_admin(sa) and sa.container_id in fake_docker.removed
    assert sb.status == "running" and sb.container_id not in fake_docker.removed
    assert await _causes(db_session) == ["access_revoked"]


async def test_removing_group_from_target_ends_member_session(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, BOB)
    g = Group(name="netops")
    db_session.add(g)
    await db_session.flush()
    db_session.add(GroupMember(group_id=g.id, user_id=BOB.id))
    t = await _target(db_session, allowed_group_ids=[g.id])
    s = await svc.start_session(db_session, BOB, t, None)
    r = await _req(ADMIN, db_session, "PUT", f"/api/admin/rbi/targets/{t.id}", json={"allowed_group_ids": []})
    assert r.status_code == 200, r.text
    await db_session.refresh(s)
    assert _ended_by_admin(s)


async def test_unrelated_target_edit_keeps_sessions(db_session, fake_docker):
    """정책만 변경하는 저장(다운로드 허용 등)은 열린 세션에 영향을 주지 않는다."""
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    assert (await _req(ADMIN, db_session, "PUT", f"/api/admin/rbi/targets/{t.id}", json={"downloads": True})).status_code == 200
    # 권한 목록을 동일하게 재저장해도 유지
    assert (await _req(ADMIN, db_session, "PUT", f"/api/admin/rbi/targets/{t.id}",
                       json={"allowed_user_ids": [ALICE.id], "enabled": True})).status_code == 200
    await db_session.refresh(s)
    assert s.status == "running" and fake_docker.removed == []


async def test_group_membership_removed_is_caught_by_reaper(db_session, fake_docker):
    """그룹 제외는 대상 API 를 거치지 않는다 — 정리 루프(30초)가 다음 주기에 종료한다."""
    await _seed_users(db_session, ADMIN, BOB)
    g = Group(name="netops")
    db_session.add(g)
    await db_session.flush()
    gm = GroupMember(group_id=g.id, user_id=BOB.id)
    db_session.add(gm)
    t = await _target(db_session, allowed_group_ids=[g.id])
    s = await svc.start_session(db_session, BOB, t, None)
    fake_docker.viewers[s.container_id] = 1
    assert (await svc.reap_once(db_session))["ended"] == 0   # 권한이 유지되면 세션 유지
    await db_session.delete(gm)
    await db_session.commit()
    st = await svc.reap_once(db_session)
    assert st["ended"] == 1 and st["revoked"] == 1
    await db_session.refresh(s)
    assert _ended_by_admin(s) and s.container_id in fake_docker.removed
    assert await _causes(db_session) == ["access_revoked"]


# ── (c) 계정 비활성화·삭제 ──

async def test_deactivated_user_session_ended_by_reaper(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    fake_docker.viewers[s.container_id] = 1
    (await db_session.get(User, ALICE.id)).is_active = False
    await db_session.commit()
    st = await svc.reap_once(db_session)
    assert st["revoked"] == 1
    await db_session.refresh(s)
    assert _ended_by_admin(s) and s.container_id in fake_docker.removed
    assert await _causes(db_session) == ["user_inactive"]


async def test_deleted_user_session_ended_by_reaper(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    fake_docker.viewers[s.container_id] = 1
    await db_session.delete(await db_session.get(User, ALICE.id))
    await db_session.commit()
    assert (await svc.reap_once(db_session))["revoked"] == 1
    await db_session.refresh(s)
    assert _ended_by_admin(s)
    assert await _causes(db_session) == ["user_removed"]


async def test_enforce_access_scoped_to_user(db_session, fake_docker):
    """계정 측 코드가 직접 호출할 수 있는 진입점 — user_id 로 한정하여 해당 사용자의 세션만 확인한다."""
    await _seed_users(db_session, ADMIN, ALICE, BOB)
    t = await _target(db_session, allowed_user_ids=[ALICE.id, BOB.id])
    sa = await svc.start_session(db_session, ALICE, t, None)
    sb = await svc.start_session(db_session, BOB, t, None)
    (await db_session.get(User, ALICE.id)).is_active = False
    (await db_session.get(User, BOB.id)).is_active = False
    await db_session.commit()
    ended = await svc.enforce_access(db_session, user_id=ALICE.id, actor_id=ADMIN.id)
    assert [x.id for x in ended] == [sa.id]
    await db_session.refresh(sb)
    assert sb.status == "running"


async def test_recheck_error_does_not_kill_session_nor_break_the_cycle(db_session, fake_docker, monkeypatch):
    """권한 확인 자체가 실패하면(DB 일시 오류 등) 종료하지 않고, 트랜잭션을 롤백하여 동일 주기의 나머지 처리를 계속한다."""
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, idle_minutes=1, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ADMIN, t, None)
    sa = await svc.start_session(db_session, ALICE, t, None)
    fake_docker.viewers[s.container_id] = 1
    # ALICE 세션은 유휴 상태 — 권한 확인에서 예외가 발생해도 유휴 종료(조회·커밋)는 정상 수행되어야 한다
    sa.last_seen_at = datetime.now(timezone.utc) - timedelta(minutes=10)
    await db_session.commit()
    fake_docker.viewers[sa.container_id] = 0
    rolled = []
    real_rollback = db_session.rollback

    async def _rollback():
        rolled.append(1)
        await real_rollback()

    async def _boom(db, sess):
        raise RuntimeError("db hiccup")

    monkeypatch.setattr(db_session, "rollback", _rollback)
    monkeypatch.setattr(svc, "access_denied_reason", _boom)
    st = await svc.reap_once(db_session)
    assert st["checked"] == 2 and st["ended"] == 1 and st["revoked"] == 0
    assert len(rolled) == 2
    await db_session.refresh(s)
    await db_session.refresh(sa)
    assert s.status == "running"
    assert sa.status == "ended" and sa.end_reason == "idle"


# ── 모듈 rbi 전역 비활성화 ──

async def test_module_disabled_ends_all_sessions_including_admin(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s1 = await svc.start_session(db_session, ADMIN, t, None)
    s2 = await svc.start_session(db_session, ALICE, t, None)
    for x in (s1, s2):
        fake_docker.viewers[x.container_id] = 1
    # DB 값이 권위 — 이 워커의 메모리 값(_module_on 픽스처 = 활성)이 오래된 값이어도 비활성으로 간주한다
    db_session.add(SystemSetting(key="module.rbi.enabled", value="false"))
    await db_session.commit()
    assert await svc.access_denied_reason(db_session, s1) == "module_disabled"
    st = await svc.reap_once(db_session)
    assert st["revoked"] == 2
    await db_session.refresh(s1)
    await db_session.refresh(s2)
    assert _ended_by_admin(s1) and _ended_by_admin(s2)
    assert await _causes(db_session) == ["module_disabled", "module_disabled"]


async def test_module_disabled_falls_back_to_memory_state(db_session, fake_docker, monkeypatch):
    from app.modules import registry
    await _seed_users(db_session, ADMIN)
    t = await _target(db_session)
    s = await svc.start_session(db_session, ADMIN, t, None)
    assert await svc.access_denied_reason(db_session, s) is None
    monkeypatch.setitem(registry._module_states, "rbi", False)   # DB 에 행이 없으면 메모리 값 사용
    assert await svc.access_denied_reason(db_session, s) == "module_disabled"


# ── 계정·그룹 쪽 즉시 종료 훅 ──

async def test_admin_deactivate_ends_rbi_session_immediately(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    admin = await db_session.get(User, ADMIN.id)
    await admin_router.deactivate_user_endpoint(user_id=ALICE.id, request=_Req(), admin=admin, db=db_session)
    await db_session.refresh(s)
    assert _ended_by_admin(s) and s.container_id in fake_docker.removed
    assert await _causes(db_session) == ["user_inactive"]


async def test_bulk_suspend_ends_rbi_session_immediately(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    admin = await db_session.get(User, ADMIN.id)
    r = await users_ext.bulk_users(body=users_ext.BulkRequest(ids=[ALICE.id], action="suspend"),
                                   request=_Req(), admin=admin, db=db_session)
    assert r["results"][0]["ok"], r
    await db_session.refresh(s)
    assert _ended_by_admin(s)


async def test_group_member_removed_ends_rbi_session_immediately(db_session, fake_docker):
    await _seed_users(db_session, ADMIN, ALICE, BOB)
    g = Group(name="netops")
    db_session.add(g)
    await db_session.flush()
    db_session.add_all([GroupMember(group_id=g.id, user_id=BOB.id), GroupMember(group_id=g.id, user_id=ALICE.id)])
    t = await _target(db_session, allowed_group_ids=[g.id])
    sb = await svc.start_session(db_session, BOB, t, None)
    sa = await svc.start_session(db_session, ALICE, t, None)
    admin = await db_session.get(User, ADMIN.id)
    await groups_router.remove_member(group_id=g.id, user_id=BOB.id, user=admin, db=db_session)
    await db_session.refresh(sb)
    await db_session.refresh(sa)
    assert _ended_by_admin(sb) and sa.status == "running"
    assert await _causes(db_session) == ["access_revoked"]
    # 그룹을 삭제하면 잔여 멤버의 세션도 종료
    await groups_router.delete_group(group_id=g.id, user=admin, db=db_session)
    await db_session.refresh(sa)
    assert _ended_by_admin(sa)


async def test_module_grant_change_ends_rbi_session_immediately(db_session, fake_docker):
    """rbi 모듈을 특정 그룹에만 부여하도록 변경하면, 해당 그룹 외 사용자의 열린 세션이 종료된다."""
    await _seed_users(db_session, ADMIN, ALICE)
    g = Group(name="rbi-only")
    db_session.add(g)
    await db_session.commit()
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    admin = await db_session.get(User, ADMIN.id)
    await groups_router.set_modules(group_id=g.id, body=groups_router.ModulesBody(module_ids=["rbi"]), user=admin, db=db_session)
    await db_session.refresh(s)
    assert _ended_by_admin(s)
    assert await _causes(db_session) == ["module_revoked"]
    assert (await db_session.execute(select(ModuleGrant))).scalars().all()


async def test_hook_failure_does_not_break_the_admin_action(db_session, fake_docker, monkeypatch):
    await _seed_users(db_session, ADMIN, ALICE)

    async def _boom(db, **kw):
        raise RuntimeError("docker down")

    monkeypatch.setattr(svc, "enforce_access", _boom)
    admin = await db_session.get(User, ADMIN.id)
    r = await admin_router.deactivate_user_endpoint(user_id=ALICE.id, request=_Req(), admin=admin, db=db_session)
    assert "비활성화" in r["message"]
    assert (await db_session.get(User, ALICE.id)).is_active is False


# ── 스트림 인증 — 정리 전이라도 신규 연결은 차단한다 ──

async def test_stream_auth_denied_once_access_revoked(db_session, fake_docker, rbi_origin, fake_redis):
    await _seed_users(db_session, ALICE)
    t = await _target(db_session, allowed_user_ids=[ALICE.id])
    s = await svc.start_session(db_session, ALICE, t, None)
    cookie = await site_cookie(fake_redis, ALICE.id)
    hdr = {"Host": RBI_HOST, "X-Original-URI": f"/rbi/{s.id}/websockify", "Cookie": cookie}
    assert (await _req(None, db_session, "GET", "/api/internal/rbi/auth", headers=hdr)).status_code == 204
    # 허용 목록에서 제외됨(대상 API 가 아닌 경로로 DB 가 변경된 경우) — 세션 행은 아직 running
    svc.apply_target_fields(t, {"allowed_user_ids": []}, creating=False)
    await db_session.commit()
    assert s.status == "running"
    # 캐시 시간(STREAM_ACCESS_TTL) 내에서는 이전 결과를 사용한다 — 요청마다 DB 를 재조회하지 않는다
    assert (await _req(None, db_session, "GET", "/api/internal/rbi/auth", headers=hdr)).status_code == 204
    # 캐시 만료 후에는 정리 전이라도 차단된다
    exp, denied = svc._stream_access_cache[s.id]
    svc._stream_access_cache[s.id] = (exp - svc.STREAM_ACCESS_TTL - 1, denied)
    assert (await _req(None, db_session, "GET", "/api/internal/rbi/auth", headers=hdr)).status_code == 403


async def test_stream_access_cache_skips_db_within_ttl(db_session, fake_docker, monkeypatch):
    await _seed_users(db_session, ADMIN)
    t = await _target(db_session)
    s = await svc.start_session(db_session, ADMIN, t, None)
    n = []
    real = svc.access_denied_reason

    async def _count(db, sess):
        n.append(1)
        return await real(db, sess)

    monkeypatch.setattr(svc, "access_denied_reason", _count)
    for _ in range(5):
        assert await svc.stream_access_denied(db_session, s) is False
    assert len(n) == 1
    assert 0 < svc.STREAM_ACCESS_TTL <= 10
