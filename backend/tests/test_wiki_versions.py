"""위키 버전 묶기·최상위 이동·순환 방지 — 자동 저장이 몇 초마다 PATCH 해도 버전이 폭증하지 않아야 한다."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base, User, WikiPage, WikiPageVersion, WikiSpace, WikiSpaceMember
from app.wiki import service

TABLES = [t.__table__ for t in (User, WikiSpace, WikiSpaceMember, WikiPage, WikiPageVersion)]


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        for uid in ("alice", "bob"):
            session.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid))
        await session.commit()
        sp = WikiSpace(name="s", slug="s", owner_id="alice")
        session.add(sp)
        await session.commit()
        await session.refresh(sp)
        session.info["space_id"] = sp.id
        yield session
    await engine.dispose()


async def _versions(db, page_id):
    rows = (await db.execute(
        select(WikiPageVersion).where(WikiPageVersion.page_id == page_id)
        .order_by(WikiPageVersion.version_number)
    )).scalars().all()
    return [(v.version_number, v.author_id, v.content) for v in rows]


async def _new_page(db, title="p", parent_id=None):
    return await service.create_page(db, db.info["space_id"], "alice", title=title, slug=title,
                                     content="v1", parent_id=parent_id)


async def test_autosave_coalesces_same_author(db):
    p = await _new_page(db)
    for i in range(5):
        await service.update_page(db, p["id"], "alice", content=f"draft {i}")
    vs = await _versions(db, p["id"])
    # 생성 버전 1 은 원본으로 남고, 연속 저장 5번은 버전 2 하나로 묶인다
    assert [v[0] for v in vs] == [1, 2]
    assert vs[0][2] == "v1" and vs[1][2] == "draft 4"
    page = await service.get_page(db, p["id"])
    assert page["version"] == 2 and page["content"] == "draft 4"


async def test_other_author_or_old_version_makes_new(db):
    p = await _new_page(db)
    await service.update_page(db, p["id"], "alice", content="a")
    await service.update_page(db, p["id"], "bob", content="b")       # 다른 사람 → 새 버전
    await service.update_page(db, p["id"], "bob", content="b2")      # 같은 사람 연속 → 묶임
    last = (await db.execute(
        select(WikiPageVersion).where(WikiPageVersion.page_id == p["id"])
        .order_by(WikiPageVersion.version_number.desc()).limit(1)
    )).scalar_one()
    last.created_at = datetime.now(timezone.utc) - timedelta(seconds=service.VERSION_COALESCE_SECONDS + 5)
    await db.commit()
    await service.update_page(db, p["id"], "bob", content="b3")      # 오래됨 → 새 버전
    vs = await _versions(db, p["id"])
    assert [(v[0], v[1], v[2]) for v in vs] == [
        (1, "alice", "v1"), (2, "alice", "a"), (3, "bob", "b2"), (4, "bob", "b3"),
    ]


async def test_same_content_no_version(db):
    p = await _new_page(db)
    await service.update_page(db, p["id"], "bob", content="v1")
    assert [v[0] for v in await _versions(db, p["id"])] == [1]


async def test_move_to_root_and_cycle_guard(db):
    a = await _new_page(db, "a")
    b = await _new_page(db, "b", parent_id=a["id"])
    c = await _new_page(db, "c", parent_id=b["id"])
    with pytest.raises(service.WikiMoveError):
        await service.update_page(db, a["id"], "alice", parent_id=c["id"])
    with pytest.raises(service.WikiMoveError):
        await service.update_page(db, a["id"], "alice", parent_id=a["id"])
    moved = await service.update_page(db, c["id"], "alice", parent_id=None)
    assert moved["parent_id"] is None
    # 위치만 바꾼 건 버전을 만들지 않는다
    assert [v[0] for v in await _versions(db, c["id"])] == [1]


async def test_restore_keeps_latest_version(db):
    """복원은 10분 묶기에 들어가지 않는다 — 복원 전 최신 본문(v2)이 기록에 남고 복원은 새 버전(v3)."""
    p = await _new_page(db)
    await service.update_page(db, p["id"], "alice", content="본문 있음")    # v2 (같은 사람·방금)
    await service.restore_page_version(db, p["id"], 1, "alice")
    vs = await _versions(db, p["id"])
    assert [(v[0], v[2]) for v in vs] == [(1, "v1"), (2, "본문 있음"), (3, "v1")]
    page = await service.get_page(db, p["id"])
    assert page["version"] == 3 and page["content"] == "v1"
