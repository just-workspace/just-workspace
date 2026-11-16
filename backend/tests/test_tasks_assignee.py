"""작업 — 담당자·태그·프로젝트·review/urgent, 목록 필터, 배정 알림, 타 사용자 작업 차단."""

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base, Notification, NotificationPref, TaskDB, User
from app.tasks import router as tr
from app.tasks import service as ts
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
        for uid in ("alice", "bob", "carol"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.capitalize()))
        s.add(User(id="gone", username="gone", email="g@x", password_hash="x", is_active=False))
        await s.commit()
        yield s
    await engine.dispose()


async def _u(db, uid):
    return await db.get(User, uid)


@pytest.mark.asyncio
async def test_create_with_assignee_tags_project_notifies(db):
    alice = await _u(db, "alice")
    t = await tr.create_task(
        TaskCreate(title="배포 점검", assignee_id="bob", tags=["infra", " infra ", "릴리스"], project="v4.4",
                   status="review", priority="urgent"),
        user=alice, db=db,
    )
    assert t.assignee_id == "bob" and t.assignee_name == "Bob"
    assert t.tags == ["infra", "릴리스"] and t.project == "v4.4"
    assert t.status == "review" and t.priority == "urgent"
    n = (await db.execute(select(Notification).where(Notification.user_id == "bob"))).scalars().one()
    assert n.type == "task_assigned" and n.actor_id == "alice" and t.id in n.link
    # 본인에게 배정하면 알림 없음
    await tr.create_task(TaskCreate(title="내 일", assignee_id="alice"), user=alice, db=db)
    assert (await db.execute(select(Notification).where(Notification.user_id == "alice"))).first() is None


@pytest.mark.asyncio
async def test_invalid_assignee_rejected(db):
    with pytest.raises(HTTPException) as e:
        await tr.create_task(TaskCreate(title="x", assignee_id="gone"), user=await _u(db, "alice"), db=db)
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_filters_and_visibility(db):
    alice = await _u(db, "alice")
    await ts.create_task(db, "alice", {"title": "a1", "assignee_id": "bob", "tags": ["infra"], "project": "P"})
    await ts.create_task(db, "alice", {"title": "a2", "tags": ["infra-old"], "status": "review"})
    await ts.create_task(db, "carol", {"title": "c1", "assignee_id": "bob"})
    await ts.create_task(db, "carol", {"title": "c2"})

    titles = lambda rows: {t["title"] for t in rows[0]}
    # bob: 배정받은 작업이 기본 목록에 표시된다(타 사용자가 생성한 경우 포함)
    assert titles(await ts.get_tasks(db, "bob")) == {"a1", "c1"}
    assert titles(await ts.get_tasks(db, "alice")) == {"a1", "a2"}
    assert titles(await ts.get_tasks(db, "alice", assignee="bob")) == {"a1"}   # 본인 작업 중 bob 담당만
    assert titles(await ts.get_tasks(db, "alice", assignee="none")) == {"a2"}
    assert titles(await ts.get_tasks(db, "bob", assignee="me")) == {"a1", "c1"}
    assert titles(await ts.get_tasks(db, "alice", tag="infra")) == {"a1"}      # infra-old 는 불일치
    assert titles(await ts.get_tasks(db, "alice", project="P")) == {"a1"}
    assert titles(await ts.get_tasks(db, "alice", status="review,done")) == {"a2"}
    # carol 의 c2 는 alice 가 담당자로 필터링해도 표시되지 않음
    assert titles(await ts.get_tasks(db, "alice", assignee="carol")) == set()
    facets = await ts.list_projects_and_tags(db, "alice")
    assert facets == {"projects": ["P"], "tags": ["infra", "infra-old"]}

    # 라우터 경유 필터
    res = await tr.list_tasks(status=None, priority=None, due_from=None, due_to=None, sort_by="created_at",
                              sort_dir="desc", page=0, limit=50, parent_id=None, assignee="me", tag=None,
                              project=None, user=await _u(db, "bob"), db=db)
    assert {t.title for t in res["tasks"]} == {"a1", "c1"}


@pytest.mark.asyncio
async def test_assignee_can_update_but_not_delete_or_reassign(db):
    t = await ts.create_task(db, "alice", {"title": "a1", "assignee_id": "bob"})
    bob, carol = await _u(db, "bob"), await _u(db, "carol")

    r = await tr.update_task(t["id"], TaskUpdate(status="review"), user=bob, db=db)
    assert r.status == "review"
    with pytest.raises(HTTPException) as e:
        await tr.update_task(t["id"], TaskUpdate(assignee_id="carol"), user=bob, db=db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await tr.delete_task(t["id"], user=bob, db=db)
    assert e.value.status_code == 403
    # 타 사용자(carol)에게는 존재하지 않는 작업
    with pytest.raises(HTTPException) as e:
        await tr.update_task(t["id"], TaskUpdate(status="done"), user=carol, db=db)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await tr.get_task(t["id"], user=carol, db=db)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_reassign_notifies_new_assignee_and_clear(db):
    t = await ts.create_task(db, "alice", {"title": "a1"})
    r = await ts.update_task(db, "alice", t["id"], {"assignee_id": "carol", "tags": ["x"], "project": "Q"})
    assert r["assignee_id"] == "carol" and r["tags"] == ["x"] and r["project"] == "Q"
    assert (await db.execute(select(Notification).where(Notification.user_id == "carol"))).scalars().one()
    r = await ts.update_task(db, "alice", t["id"], {"assignee_id": None, "tags": None, "project": None})
    assert r["assignee_id"] is None and r["tags"] == [] and r["project"] is None


@pytest.mark.asyncio
async def test_assignee_sees_subtasks_of_assigned_parent(db):
    parent = await ts.create_task(db, "alice", {"title": "부모", "assignee_id": "bob"})
    sub = await ts.create_task(db, "alice", {"title": "체크", "parent_id": parent["id"]})
    res = await tr.list_subtasks(parent["id"], sort_by="created_at", sort_dir="asc", page=0, limit=50,
                                 user=await _u(db, "bob"), db=db)
    assert [t.title for t in res["tasks"]] == ["체크"]
    assert (await ts.toggle_task(db, "bob", sub["id"]))["status"] == "done"
