"""회의 결과 화면 백엔드 —
끝난 링크 410 정보·비밀번호 남은 횟수 헤더·"호스트에게 알리기"·채널 이름.

SQLite(회의·사용자·알림·채널) + 가짜 Redis·LiveKit. 라우터 함수를 직접 호출한다.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth.password import hash_password
from app.db.models import Base, Channel, MeetingDB, Notification, NotificationPref, User
from app.meetings import repo
from app.meetings import router as mr
from app.meetings import store
from app.meetings.schemas import JoinNotifyHost, JoinRequestCreate

TABLES = [t.__table__ for t in (User, MeetingDB, Notification, NotificationPref, Channel)]


class FakeRedis:
    def __init__(self):
        self.kv: dict[str, str] = {}

    async def get(self, k):
        return self.kv.get(k)

    async def set(self, k, v, ex=None, nx=False):
        if nx and k in self.kv:
            return None
        self.kv[k] = v
        return True

    async def incr(self, k):
        self.kv[k] = str(int(self.kv.get(k) or 0) + 1)
        return int(self.kv[k])

    async def expire(self, k, ttl):
        return True


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

    monkeypatch.setattr(mr, "get_redis", _get_redis)
    monkeypatch.setattr(mr, "_check_configured", lambda: None)

    async def _no_rooms():
        return []

    monkeypatch.setattr(mr.livekit, "list_rooms", _no_rooms)
    monkeypatch.setattr(mr.livekit, "generate_token", lambda **kw: "lk")
    monkeypatch.setattr(mr.livekit, "get_ws_url", lambda: "wss://x/")

    # 실시간·푸시 전달은 비활성화(알림 행만 확인)
    from app.notifications import service as ns

    async def _no_deliver(*a, **kw):
        return None

    monkeypatch.setattr(ns, "_deliver", _no_deliver)

    metas: dict[str, store.RoomMeta] = {}

    async def _by_token(token):
        return metas.get(token)

    monkeypatch.setattr(mr.store, "get_room_by_token", _by_token)

    async with factory() as db:
        db.add(User(id="host", username="host", email="host@x", password_hash="x", display_name="박민지"))
        db.add(Channel(id="ch1", name="개발", type="public", created_by="host"))
        db.add(Channel(id="dm1", name="host,guest", type="dm", created_by="host"))
        await db.commit()
    yield {"factory": factory, "redis": redis, "metas": metas}
    await engine.dispose()


async def _add_meeting(factory, token, status, ended_at=None):
    async with factory() as db:
        db.add(MeetingDB(
            room_name=f"room-{token}", title="4분기 킥오프", host_user_id="host", host_display_name="박민지",
            share_token=token, status=status, ended_at=ended_at,
            scheduled_at=datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc), duration_minutes=60,
        ))
        await db.commit()


# ─── 끝난 링크 ───


@pytest.mark.asyncio
async def test_ended_link_returns_410_with_info(env):
    end = datetime(2026, 10, 15, 7, 0, tzinfo=timezone.utc)
    await _add_meeting(env["factory"], "old", "ended", ended_at=end)
    with pytest.raises(HTTPException) as e:
        await mr.get_join_info("old")
    assert e.value.status_code == 410
    d = e.value.detail
    assert d["code"] == "ended" and d["name"] == "4분기 킥오프" and d["host_name"] == "박민지"
    assert datetime.fromisoformat(d["ended_at"]) == end


@pytest.mark.asyncio
async def test_cancelled_without_end_uses_scheduled_end(env):
    await _add_meeting(env["factory"], "cx", "cancelled")
    with pytest.raises(HTTPException) as e:
        await mr.get_join_info("cx")
    assert e.value.status_code == 410
    assert datetime.fromisoformat(e.value.detail["ended_at"]) == datetime(2026, 10, 15, 7, 0, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_unknown_link_still_404(env):
    with pytest.raises(HTTPException) as e:
        await mr.get_join_info("nope")
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_join_info_channel_name_hides_dm(env):
    env["metas"]["t1"] = store.RoomMeta(name="r1", host_user_id="host", host_username="host",
                                        host_display_name="박민지", chat_channel_id="ch1")
    env["metas"]["t2"] = store.RoomMeta(name="r2", host_user_id="host", host_username="host",
                                        host_display_name="박민지", chat_channel_id="dm1")
    assert (await mr.get_join_info("t1")).channel_name == "개발"
    assert (await mr.get_join_info("t2")).channel_name is None


# ─── 비밀번호 남은 횟수 ───


@pytest.mark.asyncio
async def test_wrong_password_reports_remaining_attempts(env):
    env["metas"]["pw"] = store.RoomMeta(name="r", host_user_id="host", host_username="host",
                                        host_display_name="박민지", password_hash=hash_password("4454"))
    with pytest.raises(HTTPException) as e:
        await mr.submit_join_request("pw", JoinRequestCreate(nickname="손님", password="0000"))
    assert e.value.status_code == 403
    assert e.value.headers["X-Attempts-Remaining"] == "9"

    env["redis"].kv["mtg:pwfail:pw"] = "7"
    with pytest.raises(HTTPException) as e:
        await mr.submit_join_request("pw", JoinRequestCreate(nickname="손님", password="0000"))
    assert e.value.headers["X-Attempts-Remaining"] == "2"

    env["redis"].kv["mtg:pwfail:pw"] = "10"
    with pytest.raises(HTTPException) as e:
        await mr.submit_join_request("pw", JoinRequestCreate(nickname="손님", password="4454"))
    assert e.value.status_code == 429
    assert e.value.headers["X-Attempts-Remaining"] == "0"


# ─── 호스트에게 알리기 ───


@pytest.mark.asyncio
async def test_notify_host_for_ended_link_once_per_window(env):
    await _add_meeting(env["factory"], "old", "ended", ended_at=datetime.now(timezone.utc) - timedelta(hours=1))
    r = await mr.notify_host("old", JoinNotifyHost(nickname="지민"))
    assert r == {"ok": True}
    async with env["factory"]() as db:
        rows = (await db.execute(select(Notification).where(Notification.user_id == "host"))).scalars().all()
    assert len(rows) == 1
    assert "지민" in rows[0].title and "4분기 킥오프" in rows[0].title
    assert rows[0].link == "/meetings"

    with pytest.raises(HTTPException) as e:
        await mr.notify_host("old", JoinNotifyHost(nickname="지민"))
    assert e.value.status_code == 429


@pytest.mark.asyncio
async def test_notify_host_unknown_link_404(env):
    with pytest.raises(HTTPException) as e:
        await mr.notify_host("nope", JoinNotifyHost())
    assert e.value.status_code == 404
