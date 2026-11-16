"""chat22 테스트 공용 — SQLite(전 테이블), 사용자 4명 + 관리자, 실시간·푸시 가로채기. pytest 수집 대상이 아닌 보조 모듈."""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.main  # noqa: F401 — 모든 모델 등록
from app.chat import notify
from app.chat import policy as chat_policy
from app.chat import server22
from app.chat import router as chat_router
from app.chat import router22
from app.db.models import Base, User


@pytest.fixture()
async def db():
    chat_policy.invalidate()
    server22.invalidate()
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        for uid in ("alice", "bob", "carol", "dave"):
            session.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x",
                             display_name=uid.capitalize(), is_active=True))
        session.add(User(id="root", username="root", email="root@x", password_hash="x",
                         display_name="Root", is_admin=True, is_active=True))
        await session.commit()
        yield session
    await engine.dispose()
    chat_policy.invalidate()
    server22.invalidate()


@pytest.fixture()
def events(monkeypatch, tmp_path):
    sent = {"user": [], "channel": [], "push": [], "online": set(), "all": []}

    async def _to_user(uid, ev):
        sent["user"].append((uid, ev))

    async def _to_channel(cid, ev):
        sent["channel"].append((cid, ev))

    async def _connected(ids):
        return {u for u in ids if u in sent["online"]}

    async def _push(uid, title, body, url):
        sent["push"].append((uid, title, url))

    async def _is_connected(uid):
        return uid in sent["online"]

    async def _all(ev):
        sent["all"].append(ev)

    monkeypatch.setattr(notify, "emit_to_user", _to_user)
    monkeypatch.setattr(notify, "emit_to_channel", _to_channel)
    monkeypatch.setattr(notify, "connected_users", _connected)
    monkeypatch.setattr(notify, "_push", _push)
    monkeypatch.setattr(chat_router, "emit_to_user", _to_user)
    monkeypatch.setattr(chat_router, "emit_to_channel", _to_channel)
    monkeypatch.setattr(router22, "emit_to_channel", _to_channel)
    monkeypatch.setattr(router22, "_broadcast_all", _all)
    from app.chat.websocket import manager

    async def _changed(_ids):
        return None
    monkeypatch.setattr(manager, "notify_channels_changed", _changed)
    from app.notifications import service as nsvc
    import app.realtime.events as ev
    monkeypatch.setattr(ev, "emit_to_user", _to_user)
    monkeypatch.setattr(ev, "emit_to_channel", _to_channel)
    monkeypatch.setattr(ev, "is_connected", _is_connected)
    monkeypatch.setattr(nsvc, "_push", lambda d: _push(d["user_id"], d["title"], "", ""))
    import app.chat.link_preview as lp
    monkeypatch.setattr(lp, "schedule_for_message", lambda _m: None)
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "storage_root", str(tmp_path))

    async def _no_redis(_fields):
        return None
    from app.chat import permissions as P
    monkeypatch.setattr(P, "_record_redis", _no_redis)
    return sent


async def flush_tasks():
    for _ in range(3):
        await asyncio.sleep(0)


async def u(db, uid):
    return await db.get(User, uid)
