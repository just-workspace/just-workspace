"""개인 설정 서버 저장 — GET/PATCH /api/me/prefs (키 규칙·크기 제한·병합·사용자 분리)."""

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base, User, UserPref
from app.me import prefs as mp


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[User.__table__, UserPref.__table__]))
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        for uid in ("alice", "bob"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x"))
        await s.commit()
        yield s
    await engine.dispose()


@pytest.mark.asyncio
async def test_empty_then_merge_and_delete(db):
    alice = await db.get(User, "alice")
    assert (await mp.read_prefs(user=alice, db=db))["prefs"] == {}

    r = await mp.patch_prefs({"density": "compact", "theme": "dark", "tabbar_pinned": ["mail", "chat"],
                              "mail.dark_view": True}, user=alice, db=db)
    assert r["prefs"]["tabbar_pinned"] == ["mail", "chat"]
    # 병합 — 전송한 키만 변경되고 null 은 삭제. {"prefs": {...}} 로 감싼 형태도 수신
    r = await mp.patch_prefs({"prefs": {"theme": None, "week_start": 1}}, user=alice, db=db)
    assert r["prefs"] == {"density": "compact", "tabbar_pinned": ["mail", "chat"], "mail.dark_view": True,
                          "week_start": 1}
    assert (await mp.read_prefs(user=alice, db=db))["prefs"]["week_start"] == 1


@pytest.mark.asyncio
async def test_users_are_separate(db):
    alice, bob = await db.get(User, "alice"), await db.get(User, "bob")
    await mp.patch_prefs({"theme": "light"}, user=alice, db=db)
    assert (await mp.read_prefs(user=bob, db=db))["prefs"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", [
    {"Theme": "x"},                    # 대문자
    {"random_key": 1},                 # 허용 목록·접두사 밖
    {"ui.": 1, "x" * 70: 1},
    {"dashboard.checklist_dismissed_at": "2026"},   # 서버 관리 키
    {"ui.blob": "x" * 5000},          # 4KB 초과
])
async def test_rejects_bad_keys_and_sizes(db, bad):
    alice = await db.get(User, "alice")
    with pytest.raises(HTTPException) as e:
        await mp.patch_prefs(bad, user=alice, db=db)
    assert e.value.status_code in (400, 413)


@pytest.mark.asyncio
async def test_total_size_limit(db):
    alice = await db.get(User, "alice")
    with pytest.raises(HTTPException) as e:
        await mp.patch_prefs({f"ui.k{i}": "x" * 3000 for i in range(12)}, user=alice, db=db)
    assert e.value.status_code == 413
