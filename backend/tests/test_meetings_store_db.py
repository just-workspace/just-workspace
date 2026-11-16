"""회의 저장소(DB) — 예약 회의가 Redis·LiveKit 수명과 무관하게 유지되는지, 참석 응답·수정·대기실·종료 상태.

SQLite(회의·사용자·알림 테이블만) + 가짜 Redis·LiveKit·캘린더·메일. 라우터 함수를 직접 호출한다.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import (
    Base, MeetingDB, MeetingInvitee, Notification, NotificationPref, User, UserPref,
)
from app.meetings import repo
from app.meetings import router as mr
from app.meetings import store
from app.meetings.schemas import InviteeItem, JoinRequestCreate, RoomCreate, RoomUpdate, RsvpRequest, TokenRequest

TABLES = [t.__table__ for t in (User, MeetingDB, MeetingInvitee, Notification, NotificationPref, UserPref)]


class FakeRedis:
    def __init__(self):
        self.kv: dict[str, str] = {}

    async def get(self, k):
        return self.kv.get(k)

    async def setex(self, k, ttl, v):
        self.kv[k] = v

    async def set(self, k, v, ex=None, nx=False):
        self.kv[k] = v
        return True

    async def delete(self, *ks):
        for k in ks:
            self.kv.pop(k, None)

    async def incr(self, k):
        self.kv[k] = str(int(self.kv.get(k) or 0) + 1)

    async def expire(self, k, ttl):
        return True

    # 해시(참가 신청 mtg:req:<방>) — kv 안에 dict 로 저장(delete 가 함께 삭제)
    async def hset(self, k, f, v):
        self.kv.setdefault(k, {})[f] = v

    async def hget(self, k, f):
        return (self.kv.get(k) or {}).get(f)

    async def hgetall(self, k):
        return dict(self.kv.get(k) or {})


@pytest.fixture()
async def env(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(repo, "_session_factory", factory)

    redis = FakeRedis()

    async def _get_redis():
        return redis

    monkeypatch.setattr(store, "get_redis", _get_redis)
    monkeypatch.setattr(mr, "get_redis", _get_redis)

    lk = {"rooms": {}, "created": [], "deleted": []}

    async def list_rooms():
        return [dict(v) for v in lk["rooms"].values()]

    async def create_room(name, max_participants=10, empty_timeout=300):
        lk["created"].append(name)
        lk["rooms"].setdefault(name, {"name": name, "num_participants": 0,
                                      "max_participants": max_participants, "creation_time": 1})
        return dict(lk["rooms"][name])

    async def delete_room(name):
        lk["deleted"].append(name)
        lk["rooms"].pop(name, None)

    monkeypatch.setattr(mr, "_check_configured", lambda: None)
    monkeypatch.setattr(mr.livekit, "is_configured", lambda: True)
    monkeypatch.setattr(mr.livekit, "list_rooms", list_rooms)
    monkeypatch.setattr(mr.livekit, "create_room", create_room)
    monkeypatch.setattr(mr.livekit, "delete_room", delete_room)
    monkeypatch.setattr(mr.livekit, "generate_token", lambda **kw: f"lk:{kw['room']}:{kw['identity'][:6]}")
    monkeypatch.setattr(mr.livekit, "get_ws_url", lambda: "wss://x/livekit/")

    cal = {"created": [], "updated": [], "deleted": []}

    async def create_calendar_event(**kw):
        cal["created"].append(kw)
        return f"ev-{len(cal['created'])}"

    async def update_calendar_event_time(*a, **kw):
        cal["updated"].append(a)
        return True

    async def delete_calendar_event(*a):
        cal["deleted"].append(a)
        return True

    mails = []

    async def send_invite_email(**kw):
        mails.append(kw["to_email"])

    monkeypatch.setattr(mr, "create_calendar_event", create_calendar_event)
    monkeypatch.setattr(mr, "update_calendar_event_time", update_calendar_event_time)
    monkeypatch.setattr(mr, "delete_calendar_event", delete_calendar_event)
    monkeypatch.setattr(mr, "send_invite_email", send_invite_email)

    from app.notifications import service as nsvc

    async def _deliver(d, push=True, realtime=True):
        return None

    monkeypatch.setattr(nsvc, "_deliver", _deliver)

    async with factory() as db:
        for uid in ("alice", "bob", "carol"):
            db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.capitalize()))
        await db.commit()
        yield {"db": db, "redis": redis, "lk": lk, "cal": cal, "mails": mails, "factory": factory}
    await engine.dispose()


async def _u(env, uid):
    return await env["db"].get(User, uid)


def _tomorrow():
    return (datetime.now(timezone.utc) + timedelta(days=1)).replace(microsecond=0)


async def _create(env, name="kickoff", **kw):
    alice = await _u(env, "alice")
    body = RoomCreate(
        name=name, scheduled_at=_tomorrow().isoformat(), duration_minutes=30,
        invitees=[InviteeItem(type="internal", user_id="bob", username="bob"),
                  InviteeItem(type="external", email="guest@ext")],
        **kw,
    )
    return await mr.create_room(body, user=alice, db=env["db"])


@pytest.mark.asyncio
async def test_create_saves_meeting_invitees_calendar_and_notification(env):
    info = await _create(env)
    assert info.meeting_id and info.status == "scheduled"
    assert info.invitee_count == 2 and info.waiting_room is True
    row = await env["db"].get(MeetingDB, info.meeting_id)
    assert row.host_user_id == "alice" and row.share_token == info.share_token
    assert row.host_calendar_event_id == "ev-1"      # 호스트 캘린더 일정 연결
    invs = (await env["db"].execute(select(MeetingInvitee))).scalars().all()
    assert {(i.user_id, i.email) for i in invs} == {("bob", "bob@x"), (None, "guest@ext")}
    # 초대 메일(내부·외부) 변경 없음
    assert set(env["mails"]) == {"bob@localhost", "guest@ext"}
    # bob 에게 수락/거절 버튼이 포함된 알림
    n = (await env["db"].execute(select(Notification).where(Notification.user_id == "bob"))).scalars().one()
    assert n.type == "meeting_invite" and n.actor_id == "alice" and n.actor_name == "Alice"
    assert '"accepted"' in n.actions_json and f"/api/meetings/by-id/{info.meeting_id}/rsvp" in n.actions_json


@pytest.mark.asyncio
async def test_meeting_survives_redis_and_livekit_expiry(env):
    info = await _create(env)
    # 24시간 TTL·방 5분 타임아웃이 경과한 상황
    env["redis"].kv.clear()
    env["lk"]["rooms"].clear()

    join = await mr.get_join_info(info.share_token)
    assert join.name == "kickoff" and join.host_name == "Alice" and join.duration_minutes == 30

    env["lk"]["created"].clear()
    tok = await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "alice"), db=env["db"])
    assert tok.is_host is True
    assert env["lk"]["created"] == ["kickoff"]       # 호스트 입장 시 방 재생성


@pytest.mark.asyncio
async def test_list_merges_db_and_livekit_and_hides_others(env):
    info = await _create(env)
    env["lk"]["rooms"].clear()      # 예약만 된 상태(방 없음)
    # 다른 사용자가 현재 개설한 즉석 회의
    await mr.create_room(RoomCreate(name="standup"), user=await _u(env, "carol"), db=env["db"])

    alice_rooms = {r.name: r for r in (await mr.get_rooms(user=await _u(env, "alice"), db=env["db"])).rooms}
    assert alice_rooms["kickoff"].status == "scheduled" and alice_rooms["kickoff"].is_host
    assert "standup" not in alice_rooms                       # 타인이 개설한 진행 중 회의도 초대 없이는 미노출

    bob_rooms = {r.name: r for r in (await mr.get_rooms(user=await _u(env, "bob"), db=env["db"])).rooms}
    assert bob_rooms["kickoff"].my_response == "pending"
    assert bob_rooms["kickoff"].share_token == ""             # 초대받은 사용자에게 호스트 링크는 제공하지 않음

    carol_rooms = {r.name for r in (await mr.get_rooms(user=await _u(env, "carol"), db=env["db"])).rooms}
    assert "kickoff" not in carol_rooms                       # 타인의 예약 회의는 미노출


@pytest.mark.asyncio
async def test_rsvp_and_detail_permissions(env):
    info = await _create(env)
    bob, carol = await _u(env, "bob"), await _u(env, "carol")

    res = await mr.rsvp_meeting(info.meeting_id, RsvpRequest(response="accepted"), user=bob, db=env["db"])
    assert res["response"] == "accepted"
    detail = await mr.get_meeting(info.meeting_id, user=await _u(env, "alice"), db=env["db"])
    assert detail.accepted_count == 1
    assert {i.display_name: i.response for i in detail.invitees}["Bob"] == "accepted"
    assert detail.join_url.endswith(info.share_token)

    with pytest.raises(HTTPException) as e:
        await mr.rsvp_meeting(info.meeting_id, RsvpRequest(response="accepted"), user=carol, db=env["db"])
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await mr.get_meeting(info.meeting_id, user=carol, db=env["db"])
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await mr.rsvp_meeting(info.meeting_id, RsvpRequest(response="maybe"), user=bob, db=env["db"])
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_patch_host_only_and_waiting_room_off(env):
    info = await _create(env)
    with pytest.raises(HTTPException) as e:
        await mr.update_room("kickoff", RoomUpdate(waiting_room=False), user=await _u(env, "bob"), db=env["db"])
    assert e.value.status_code == 403

    new_time = (_tomorrow() + timedelta(hours=2)).isoformat()
    d = await mr.update_room(
        "kickoff",
        RoomUpdate(waiting_room=False, scheduled_at=new_time, title="킥오프",
                   add_invitees=[InviteeItem(type="internal", user_id="carol")]),
        user=await _u(env, "alice"), db=env["db"],
    )
    assert d.waiting_room is False and d.title == "킥오프" and d.invitee_count == 3
    assert env["cal"]["updated"]                               # 호스트 일정도 이동됨
    meta = await store.get_room_meta("kickoff")
    assert meta.waiting_room is False and meta.scheduled_at.startswith(new_time[:16])

    # 대기실 비활성 → 승인 없이 즉시 입장
    res = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="손님"))
    assert res.status == "approved" and res.token


@pytest.mark.asyncio
async def test_waiting_room_off_with_password_still_needs_password(env):
    info = await _create(env, password="4454", waiting_room=False)
    with pytest.raises(HTTPException) as e:
        await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="손님"))
    assert e.value.status_code == 403
    ok = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="손님", password="4454"))
    assert ok.status == "approved"


@pytest.mark.asyncio
async def test_waiting_room_on_keeps_host_approval(env):
    info = await _create(env)
    res = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="손님"))
    assert res.status == "pending" and res.token is None


@pytest.mark.asyncio
async def test_webhook_status_transitions(env):
    info = await _create(env)
    # 아무도 입장하지 않은 채 방 종료(빈 방 5분) → 예정 상태 유지
    await repo.on_room_event("room_finished", "kickoff")
    row = await env["db"].get(MeetingDB, info.meeting_id)
    await env["db"].refresh(row)
    assert row.status == "scheduled"

    await repo.on_room_event("participant_joined", "kickoff")
    await env["db"].refresh(row)
    assert row.status == "live" and row.started_at is not None

    await repo.on_room_event("room_finished", "kickoff")
    await env["db"].refresh(row)
    assert row.status == "ended" and row.ended_at is not None

    env["lk"]["rooms"].clear()
    rooms = {r.name: r for r in (await mr.get_rooms(user=await _u(env, "alice"), db=env["db"])).rooms}
    assert rooms["kickoff"].status == "ended"


@pytest.mark.asyncio
async def test_delete_before_start_cancels_and_removes_calendar(env):
    info = await _create(env)
    await mr.delete_room("kickoff", user=await _u(env, "alice"), db=env["db"])
    row = await env["db"].get(MeetingDB, info.meeting_id)
    await env["db"].refresh(row)
    assert row.status == "cancelled"
    assert env["cal"]["deleted"] == [("alice", "ev-1")]
    rooms = {r.name for r in (await mr.get_rooms(user=await _u(env, "alice"), db=env["db"])).rooms}
    assert "kickoff" not in rooms
    # 취소된 회의 링크는 재활성화되지 않음
    env["redis"].kv.clear()
    with pytest.raises(HTTPException):
        await mr.get_join_info(info.share_token)


@pytest.mark.asyncio
async def test_end_marks_ended(env):
    info = await _create(env)
    res = await mr.end_room("kickoff", user=await _u(env, "alice"), db=env["db"])
    assert res["status"] == "ended"
    with pytest.raises(HTTPException) as e:
        await mr.end_room("kickoff", user=await _u(env, "bob"), db=env["db"])
    assert e.value.status_code in (403, 404)


@pytest.mark.asyncio
async def test_same_name_owned_by_other_is_conflict(env):
    await _create(env)
    with pytest.raises(HTTPException) as e:
        await mr.create_room(RoomCreate(name="kickoff"), user=await _u(env, "carol"), db=env["db"])
    assert e.value.status_code == 409


def test_effective_status_window():
    now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)
    row = MeetingDB(room_name="x", status="scheduled", scheduled_at=now - timedelta(hours=3), duration_minutes=60,
                    created_at=now - timedelta(days=1))
    assert repo.effective_status(row, False, now) == "ended"
    assert repo.effective_status(row, True, now) == "live"
    row.scheduled_at = now + timedelta(hours=1)
    assert repo.effective_status(row, False, now) == "scheduled"
    row.status = "cancelled"
    assert repo.effective_status(row, True, now) == "cancelled"


@pytest.mark.asyncio
async def test_delete_ended_meeting_hides_it(env):
    """지난 회의 [삭제] — 기존에는 204 를 반환하나 행이 잔존했다. 현재는 목록에서 제외된다(해당 행만)."""
    info = await _create(env)
    row = await env["db"].get(MeetingDB, info.meeting_id)
    row.status = "ended"
    row.ended_at = datetime.now(timezone.utc)
    await env["db"].commit()
    env["lk"]["rooms"].clear()
    env["redis"].kv.clear()
    alice = await _u(env, "alice")
    names = [r.name for r in (await mr.get_rooms(user=alice, db=env["db"])).rooms]
    assert names.count("kickoff") == 1
    # 다른 사용자는 삭제 불가
    with pytest.raises(HTTPException) as e:
        await mr.delete_room("kickoff", meeting_id=info.meeting_id, user=await _u(env, "bob"), db=env["db"])
    assert e.value.status_code == 403
    await mr.delete_room("kickoff", meeting_id=info.meeting_id, user=alice, db=env["db"])
    await env["db"].refresh(row)
    assert row.deleted_at is not None and row.status == "ended"
    names = [r.name for r in (await mr.get_rooms(user=alice, db=env["db"])).rooms]
    assert "kickoff" not in names
