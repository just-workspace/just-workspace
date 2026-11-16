"""회의 예약 시각·길이·호스트 이름이 목록·초대 입장 응답에 포함된다.

LiveKit·Redis 는 모의 객체로 대체한다. 검증 대상은 저장(직렬화)과 응답 매핑이다.
"""

import json

import pytest

from app.meetings import router as meetings_router
from app.meetings import store


def test_meta_roundtrip_keeps_schedule():
    meta = store.RoomMeta(
        name="kickoff", host_user_id="1", host_username="minji", host_display_name="박민지",
        scheduled_at="2026-10-16T05:00:00+00:00", duration_minutes=60,
    )
    back = store._deserialize(store._serialize(meta))
    assert back.scheduled_at == "2026-10-16T05:00:00+00:00"
    assert back.duration_minutes == 60


def test_old_meta_without_schedule_still_loads():
    """필드 추가 이전에 저장된 방(Redis 에 잔존한 JSON)도 조회된다."""
    old = json.dumps({
        "name": "old", "host_user_id": "1", "host_username": "a", "host_display_name": "A",
        "share_token": "t", "created_at": 1.0, "password_hash": None, "chat_channel_id": None, "requests": {},
    })
    back = store._deserialize(old)
    assert back.scheduled_at is None and back.duration_minutes is None


def test_parse_scheduled():
    p = meetings_router._parse_scheduled
    assert p(None) is None
    assert p("nope") is None
    assert p("2026-10-16T14:00:00+09:00").isoformat() == "2026-10-16T14:00:00+09:00"
    # 시간대가 없으면 기존과 동일하게 UTC 로 간주
    assert p("2026-10-16T05:00:00").isoformat() == "2026-10-16T05:00:00+00:00"
    assert p("2026-10-16T05:00:00Z").isoformat() == "2026-10-16T05:00:00+00:00"


@pytest.fixture()
def fake_room(monkeypatch):
    meta = store.RoomMeta(
        name="kickoff", host_user_id="7", host_username="minji", host_display_name="박민지",
        share_token="tok", scheduled_at="2026-10-16T06:00:00+00:00", duration_minutes=60,
    )

    async def list_rooms():
        return [{"name": "kickoff", "num_participants": 3, "max_participants": 10, "creation_time": 1}]

    async def get_room_meta(name):
        return meta if name == "kickoff" else None

    async def get_room_by_token(token):
        return meta if token == "tok" else None

    async def get_pending_requests(name):
        return []

    monkeypatch.setattr(meetings_router, "_check_configured", lambda: None)
    monkeypatch.setattr(meetings_router.livekit, "list_rooms", list_rooms)
    monkeypatch.setattr(meetings_router.store, "get_room_meta", get_room_meta)
    monkeypatch.setattr(meetings_router.store, "get_room_by_token", get_room_by_token)
    monkeypatch.setattr(meetings_router.store, "get_pending_requests", get_pending_requests)
    return meta


class _User:
    id = 7


@pytest.fixture()
async def meeting_db():
    """목록이 DB 회의 저장소도 조회한다(app/meetings/repo.py) — 빈 SQLite 를 제공한다."""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from app.db.models import Base, MeetingDB, MeetingInvitee, User

    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(
            c, tables=[User.__table__, MeetingDB.__table__, MeetingInvitee.__table__]))
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        yield s
    await engine.dispose()


@pytest.mark.asyncio
async def test_room_list_has_host_and_schedule(fake_room, meeting_db):
    res = await meetings_router.get_rooms(user=_User(), db=meeting_db)
    room = res.rooms[0]
    assert room.host_name == "박민지"
    assert room.is_host is True
    assert room.scheduled_at == "2026-10-16T06:00:00+00:00"
    assert room.duration_minutes == 60


@pytest.mark.asyncio
async def test_join_info_has_schedule(fake_room):
    res = await meetings_router.get_join_info("tok")
    assert res.host_name == "박민지"
    assert res.num_participants == 3
    assert res.scheduled_at == "2026-10-16T06:00:00+00:00"
    assert res.duration_minutes == 60
