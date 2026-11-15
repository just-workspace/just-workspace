"""마지막 멤버는 채널을 나갈 수 없다 — 나가면 아무도 못 지우는 고아 채널이 남았다."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.chat import router as chat_router
from app.chat import service
from app.db.models import Base, Channel, ChannelMember, User

TABLES = [t.__table__ for t in (User, Channel, ChannelMember)]


@pytest.fixture()
async def db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))

    async def _changed(_ids):
        return None
    monkeypatch.setattr(chat_router.manager, "notify_channels_changed", _changed)
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        for uid in ("alice", "bob"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x"))
        s.add(Channel(id="c1", name="c", type="private", created_by="alice"))
        s.add(ChannelMember(channel_id="c1", user_id="alice", role="owner"))
        s.add(ChannelMember(channel_id="c1", user_id="bob", role="member"))
        await s.commit()
        yield s
    await engine.dispose()


async def test_last_member_cannot_leave(db):
    alice, bob = SimpleNamespace(id="alice"), SimpleNamespace(id="bob")
    assert (await chat_router.remove_member("c1", "bob", user=bob, db=db)) == {"ok": True}
    with pytest.raises(HTTPException) as e:
        await chat_router.remove_member("c1", "alice", user=alice, db=db)
    assert e.value.status_code == 409
    assert await service.is_channel_member(db, "c1", "alice")
