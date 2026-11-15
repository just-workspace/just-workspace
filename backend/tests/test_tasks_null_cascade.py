"""작업 — "마감 없음"·설명 비우기가 반영되고, 부모를 지우면 하위 작업도 지워진다(회귀)."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base, Notification, NotificationPref, TaskDB, User
from app.tasks import router as tr
from app.tasks.schemas import TaskCreate, TaskUpdate

TABLES = [t.__table__ for t in (User, TaskDB, Notification, NotificationPref)]


@pytest.fixture()
async def db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    from app.notifications import service as nsvc

    async def _deliver(d, push=True, realtime=True):
        return None

    monkeypatch.setattr(nsvc, "_deliver", _deliver)
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        s.add(User(id="alice", username="alice", email="a@x", password_hash="x"))
        await s.commit()
        yield s
    await engine.dispose()


@pytest.mark.asyncio
async def test_clear_due_date_and_description(db):
    alice = await db.get(User, "alice")
    t = await tr.create_task(TaskCreate(title="t", description="설명", due_date=datetime(2026, 12, 24, tzinfo=timezone.utc)),
                             user=alice, db=db)
    assert t.due_date is not None and t.description == "설명"
    r = await tr.update_task(t.id, TaskUpdate(due_date=None), user=alice, db=db)
    assert r.due_date is None
    r = await tr.update_task(t.id, TaskUpdate(description=None), user=alice, db=db)
    assert r.description in (None, "")
    # 보내지 않은 칸은 그대로
    r = await tr.update_task(t.id, TaskUpdate(title="새 제목"), user=alice, db=db)
    assert r.title == "새 제목" and r.due_date is None


@pytest.mark.asyncio
async def test_delete_parent_removes_subtasks(db):
    alice = await db.get(User, "alice")
    p = await tr.create_task(TaskCreate(title="부모"), user=alice, db=db)
    await tr.create_task(TaskCreate(title="하위1", parent_id=p.id), user=alice, db=db)
    await tr.create_task(TaskCreate(title="하위2", parent_id=p.id), user=alice, db=db)
    other = await tr.create_task(TaskCreate(title="남"), user=alice, db=db)
    await tr.delete_task(p.id, user=alice, db=db)
    left = (await db.execute(select(TaskDB.title))).scalars().all()
    assert left == ["남"] and other.id
