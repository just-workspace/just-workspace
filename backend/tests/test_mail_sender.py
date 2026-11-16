"""메일 보낸 사람 카드 — 주소로 워크스페이스 사용자 조회(대소문자 무시·비활성 제외·외부 주소 null)."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base, User
from app.mail.sender import find_workspace_user


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[User.__table__]))
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        s.add(User(id="u1", username="alice", display_name="앨리스", email="Alice@Example.com", password_hash="x"))
        s.add(User(id="u2", username="gone", email="gone@example.com", password_hash="x", is_active=False))
        await s.commit()
        yield s
    await engine.dispose()


@pytest.mark.asyncio
async def test_find_by_email_case_insensitive(db):
    u = await find_workspace_user(db, " alice@example.COM ")
    assert u == {"id": "u1", "username": "alice", "display_name": "앨리스", "avatar_url": None}


@pytest.mark.asyncio
async def test_outside_inactive_and_garbage_are_none(db):
    assert await find_workspace_user(db, "someone@outside.org") is None
    assert await find_workspace_user(db, "gone@example.com") is None
    assert await find_workspace_user(db, "") is None
    assert await find_workspace_user(db, "not-an-email") is None
