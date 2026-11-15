"""채널 탭(시안 ChannelTabs · 11 답 D6) — 요약·폴더/위키 연결 권한·파일 목록(메시지+폴더)·회의·작업.

라우터 함수를 직접 부른다. 저장소 루트는 임시 폴더, DB 는 SQLite.
"""

import json
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

from app.chat import tabs  # noqa: E402
from app.db.models import (  # noqa: E402
    Base, Channel, ChannelMember, FileShare, MeetingDB, Message, TaskDB, User, WikiPage, WikiSpace,
)
from app.files import router as fr  # noqa: E402
from app.files import service as fs  # noqa: E402
from app.tasks import router as tasks_router  # noqa: E402
from app.tasks.schemas import TaskCreate, TaskUpdate  # noqa: E402


@pytest.fixture()
async def env(tmp_path: Path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(fr.settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(fs, "STORAGE_ROOT", tmp_path)
    fs._dir_cache.clear()

    async with factory() as db:
        for uid in ("alice", "bob", "eve"):
            db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.title()))
        await db.commit()
        db.add(Channel(id="dev", name="개발", type="public", created_by="alice"))
        await db.commit()
        db.add(ChannelMember(channel_id="dev", user_id="alice", role="owner"))
        db.add(ChannelMember(channel_id="dev", user_id="bob", role="member"))
        await db.commit()
        home = tmp_path / "users" / "alice" / "프로젝트" / "개발"
        home.mkdir(parents=True)
        (home / "release-notes.md").write_text("notes")
        (home / ".hidden").write_text("x")
        now = datetime.now(timezone.utc)
        db.add(Message(seq=1, channel_id="dev", sender_id="bob", content="배포 체크리스트.pdf", message_type="file",
                       file_meta=json.dumps({"filename": "배포 체크리스트.pdf", "size": 12, "url": "/api/chat/channels/dev/files/x_a.pdf"}),
                       created_at=now))
        db.add(Message(seq=2, channel_id="dev", sender_id="bob", content="지운 파일", message_type="file", is_deleted=True,
                       file_meta=json.dumps({"filename": "gone.txt"}), created_at=now))
        await db.commit()
        users = {u: await db.get(User, u) for u in ("alice", "bob", "eve")}
        yield SimpleNamespace(db=db, u=users)
    await engine.dispose()


@pytest.mark.asyncio
async def test_non_member_is_403(env):
    for fn in (tabs.channel_tabs, tabs.channel_files, tabs.channel_meetings, tabs.channel_tasks):
        with pytest.raises(HTTPException) as e:
            await fn("dev", user=env.u["eve"], db=env.db)
        assert e.value.status_code == 403


@pytest.mark.asyncio
async def test_only_manager_links_folder(env):
    with pytest.raises(HTTPException) as e:
        await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="my/프로젝트/개발"), user=env.u["bob"], db=env.db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="my/없는폴더"), user=env.u["alice"], db=env.db)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="shared/x"), user=env.u["alice"], db=env.db)
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_link_folder_shares_to_channel_and_lists_files(env):
    r = await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="my/프로젝트/개발"), user=env.u["alice"], db=env.db)
    assert r["folder"]["segments"] == ["프로젝트", "개발"] and r["folder"]["mine"]
    assert r["files_count"] == 2   # 메시지 파일 1 + 폴더 파일 1(숨김·지운 것 제외)
    # 폴더 연결 = 채널 공유 행
    share = r["folder"]["share_id"]
    assert (await env.db.get(FileShare, share)).shared_with_channel_id == "dev"

    # 멤버(bob)는 공유받음 경로로 내려받는다 — 소유자 경로는 안 보인다
    res = await tabs.channel_files("dev", user=env.u["bob"], db=env.db)
    by = {i["name"]: i for i in res["items"]}
    assert by["release-notes.md"]["source"] == "folder"
    assert by["release-notes.md"]["url"] == f"/api/files/shared-with-me/{share}/download?path=release-notes.md"
    assert res["folder"]["path"] is None and res["folder"]["accessible"]
    assert by["배포 체크리스트.pdf"]["source"] == "message" and by["배포 체크리스트.pdf"]["who"] == "Bob"
    assert "gone.txt" not in by

    # 소유자가 채널 공유를 풀면 멤버는 폴더 파일을 못 본다(메시지 파일은 그대로)
    await fr.delete_user_share(share_id=share, user=env.u["alice"], db=env.db)
    res = await tabs.channel_files("dev", user=env.u["bob"], db=env.db)
    assert [i["source"] for i in res["items"]] == ["message"]
    assert res["folder"]["accessible"] is False

    # 연결 해제
    r = await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path=None), user=env.u["alice"], db=env.db)
    assert r["folder"] is None


@pytest.mark.asyncio
async def test_link_wiki_page(env):
    env.db.add(WikiSpace(id="sp", name="팀", slug="team", owner_id="alice", visibility="public"))
    await env.db.commit()
    env.db.add(WikiPage(id="pg", space_id="sp", title="온보딩 가이드", slug="onboarding", content="<p>x</p>", author_id="alice"))
    await env.db.commit()
    r = await tabs.update_channel_tabs("dev", tabs.TabsUpdate(wiki_page_id="pg"), user=env.u["alice"], db=env.db)
    assert r["wiki"] == {"id": "pg", "title": "온보딩 가이드", "space_id": "sp"}
    with pytest.raises(HTTPException) as e:
        await tabs.update_channel_tabs("dev", tabs.TabsUpdate(wiki_page_id="nope"), user=env.u["alice"], db=env.db)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_meetings_and_tasks_counts(env):
    soon = datetime.now(timezone.utc) + timedelta(days=1)
    env.db.add(MeetingDB(room_name="r1", title="4분기 킥오프", host_user_id="alice", share_token="t1",
                         status="scheduled", scheduled_at=soon, duration_minutes=60, chat_channel_id="dev"))
    env.db.add(MeetingDB(room_name="r2", title="끝난 회의", host_user_id="alice", share_token="t2",
                         status="ended", chat_channel_id="dev"))
    await env.db.commit()

    # 작업은 API 로 채널에 묶는다 — 멤버가 아니면 403
    t = await tasks_router.create_task(TaskCreate(title="배포 점검", channel_id="dev"), user=env.u["bob"], db=env.db)
    assert t.channel_id == "dev"
    with pytest.raises(HTTPException) as e:
        await tasks_router.create_task(TaskCreate(title="몰래", channel_id="dev"), user=env.u["eve"], db=env.db)
    assert e.value.status_code == 403
    env.db.add(TaskDB(user_id="alice", title="끝난 일", status="done", channel_id="dev"))
    await env.db.commit()

    s = await tabs.channel_tabs("dev", user=env.u["alice"], db=env.db)
    assert s["meetings_upcoming"] == 1 and s["tasks_open"] == 1 and s["can_manage"]
    assert (await tabs.channel_tabs("dev", user=env.u["bob"], db=env.db))["can_manage"] is False

    m = (await tabs.channel_meetings("dev", user=env.u["bob"], db=env.db))["items"]
    assert [x["title"] for x in m] == ["4분기 킥오프"] and m[0]["join_path"] == "/meetings/join/t1"
    ts = (await tabs.channel_tasks("dev", user=env.u["alice"], db=env.db))["items"]
    assert [x["title"] for x in ts] == ["배포 점검"] and ts[0]["owner_name"] == "Bob" and ts[0]["can_open"] is False

    # 채널에서 떼기는 만든 사람만
    up = await tasks_router.update_task(t.id, TaskUpdate(channel_id=None), user=env.u["bob"], db=env.db)
    assert up.channel_id is None


# ─── R4(12 답 A6): 탭 순서·끄기 · 위키 스페이스 · 지난 회의 · 작업 칩 ───


@pytest.mark.asyncio
async def test_layout_order_and_hidden(env):
    s = await tabs.channel_tabs("dev", user=env.u["bob"], db=env.db)
    assert [x["key"] for x in s["layout"]] == ["files", "wiki", "meetings", "tasks"]
    assert all(x["visible"] for x in s["layout"])

    lay = tabs.TabsLayout(order=["tasks", "files", "meetings", "wiki"], hidden=["meetings"])
    # 멤버는 못 바꾼다
    with pytest.raises(HTTPException) as e:
        await tabs.update_channel_tabs("dev", tabs.TabsUpdate(layout=lay), user=env.u["bob"], db=env.db)
    assert e.value.status_code == 403
    r = await tabs.update_channel_tabs("dev", tabs.TabsUpdate(layout=lay), user=env.u["alice"], db=env.db)
    assert r["layout"] == [{"key": "tasks", "visible": True}, {"key": "files", "visible": True},
                           {"key": "meetings", "visible": False}, {"key": "wiki", "visible": True}]
    # 채널 멤버 모두에게 같은 순서
    s = await tabs.channel_tabs("dev", user=env.u["bob"], db=env.db)
    assert [x["key"] for x in s["layout"]] == ["tasks", "files", "meetings", "wiki"]

    # 빠진 키·모르는 키·중복·메시지는 거절
    for bad in (["files", "wiki"], ["files", "wiki", "meetings", "tasks", "board"],
                ["files", "files", "meetings", "tasks"], ["messages", "files", "wiki", "meetings"]):
        with pytest.raises(HTTPException) as e:
            await tabs.update_channel_tabs("dev", tabs.TabsUpdate(layout=tabs.TabsLayout(order=bad)), user=env.u["alice"], db=env.db)
        assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_link_wiki_space_and_legacy_page(env):
    env.db.add(WikiSpace(id="sp", name="개발 팀 스페이스", slug="dev", owner_id="alice", visibility="public"))
    env.db.add(WikiSpace(id="sp2", name="비공개", slug="p", owner_id="eve", visibility="private"))
    await env.db.commit()
    env.db.add(WikiPage(id="pg", space_id="sp", title="배포 체크리스트", slug="deploy", content="", author_id="alice"))
    await env.db.commit()
    # 예전 페이지 연결만 있어도 그 스페이스로 본다
    await tabs.update_channel_tabs("dev", tabs.TabsUpdate(wiki_page_id="pg"), user=env.u["alice"], db=env.db)
    s = await tabs.channel_tabs("dev", user=env.u["bob"], db=env.db)
    assert s["wiki_space"] == {"id": "sp", "name": "개발 팀 스페이스", "pages": 1}

    with pytest.raises(HTTPException) as e:
        await tabs.update_channel_tabs("dev", tabs.TabsUpdate(wiki_space_id="nope"), user=env.u["alice"], db=env.db)
    assert e.value.status_code == 404
    r = await tabs.update_channel_tabs("dev", tabs.TabsUpdate(wiki_space_id="sp"), user=env.u["alice"], db=env.db)
    assert r["wiki_space"]["id"] == "sp"
    # 떼면 페이지 연결도 같이 떨어진다
    r = await tabs.update_channel_tabs("dev", tabs.TabsUpdate(wiki_space_id=None), user=env.u["alice"], db=env.db)
    assert r["wiki_space"] is None and r["wiki"] is None


@pytest.mark.asyncio
async def test_past_meetings_and_task_filters(env):
    now = datetime.now(timezone.utc)
    env.db.add(MeetingDB(room_name="r3", title="CI 캐시 장애 회고", host_user_id="bob", host_display_name="Bob", share_token="t3",
                         status="ended", started_at=now - timedelta(minutes=50), ended_at=now - timedelta(minutes=8),
                         chat_channel_id="dev"))
    env.db.add(MeetingDB(room_name="r4", title="다른 채널", host_user_id="bob", share_token="t4", status="ended",
                         chat_channel_id="other"))
    await env.db.commit()
    res = await tabs.channel_meetings("dev", user=env.u["bob"], db=env.db)
    assert res["items"] == []
    assert [p["title"] for p in res["past"]] == ["CI 캐시 장애 회고"]
    assert res["past"][0]["actual_minutes"] == 42 and res["past"][0]["is_host"] is True
    assert (await tabs.channel_meetings("dev", user=env.u["alice"], db=env.db))["past"][0]["is_host"] is False

    env.db.add(TaskDB(user_id="alice", title="내 일", status="todo", channel_id="dev", assignee_id="bob"))
    env.db.add(TaskDB(user_id="alice", title="남의 일", status="in_progress", channel_id="dev", assignee_id="alice"))
    env.db.add(TaskDB(user_id="alice", title="끝", status="done", channel_id="dev"))
    await env.db.commit()
    r = await tabs.channel_tasks("dev", user=env.u["bob"], db=env.db)
    assert r["counts"] == {"open": 2, "mine": 1, "done": 1}
    assert {x["title"] for x in r["items"]} == {"내 일", "남의 일"}
    mine = await tabs.channel_tasks("dev", filter="mine", user=env.u["bob"], db=env.db)
    assert [x["title"] for x in mine["items"]] == ["내 일"] and mine["items"][0]["can_open"] is True
    done = await tabs.channel_tasks("dev", filter="done", user=env.u["bob"], db=env.db)
    assert [x["title"] for x in done["items"]] == ["끝"]
    with pytest.raises(HTTPException) as e:
        await tabs.channel_tasks("dev", filter="all", user=env.u["bob"], db=env.db)
    assert e.value.status_code == 400


# ── 연결 해제 = 연결이 만든 공유만 회수(R7) ──

async def _channel_rows(env):
    from sqlalchemy import select
    return (await env.db.execute(select(FileShare).where(FileShare.shared_with_channel_id == "dev"))).scalars().all()


@pytest.mark.asyncio
async def test_unlink_revokes_link_share_only(env):
    # 사람에게 직접 건 공유(같은 폴더, bob)는 연결과 무관
    await fr.share_with_users(fr.ShareUserCreate(path="my/프로젝트/개발", user_ids=["bob"], role="edit"),
                              user=env.u["alice"], db=env.db)
    r = await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="my/프로젝트/개발"), user=env.u["alice"], db=env.db)
    row = await env.db.get(FileShare, r["folder"]["share_id"])
    assert row.origin == tabs.LINK_ORIGIN and row.role == "view"
    await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path=None), user=env.u["alice"], db=env.db)
    assert await _channel_rows(env) == []
    from sqlalchemy import select
    left = (await env.db.execute(select(FileShare).where(FileShare.shared_with_user_id == "bob"))).scalars().all()
    assert len(left) == 1 and left[0].role == "edit"


@pytest.mark.asyncio
async def test_unlink_keeps_manual_channel_share(env):
    # 공유 창에서 먼저 채널에 걸었던 공유 → 연결은 그 행을 쓰고, 풀어도 남는다
    await fr.share_with_users(fr.ShareUserCreate(path="my/프로젝트/개발", channel_ids=["dev"], role="view"),
                              user=env.u["alice"], db=env.db)
    await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="my/프로젝트/개발"), user=env.u["alice"], db=env.db)
    rows = await _channel_rows(env)
    assert len(rows) == 1 and rows[0].origin is None
    await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path=None), user=env.u["alice"], db=env.db)
    assert len(await _channel_rows(env)) == 1


@pytest.mark.asyncio
async def test_reshare_from_modal_makes_link_share_manual(env):
    await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="my/프로젝트/개발"), user=env.u["alice"], db=env.db)
    await fr.share_with_users(fr.ShareUserCreate(path="my/프로젝트/개발", channel_ids=["dev"], role="edit"),
                              user=env.u["alice"], db=env.db)
    await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path=None), user=env.u["alice"], db=env.db)
    rows = await _channel_rows(env)
    assert len(rows) == 1 and rows[0].role == "edit"


@pytest.mark.asyncio
async def test_switch_folder_revokes_old_and_relink_same_keeps(env):
    other = fs.STORAGE_ROOT / "users" / "alice" / "다른"
    other.mkdir(parents=True)
    await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="my/프로젝트/개발"), user=env.u["alice"], db=env.db)
    first = (await _channel_rows(env))[0].id
    # 같은 폴더 다시 연결 — 같은 행
    await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="my/프로젝트/개발"), user=env.u["alice"], db=env.db)
    assert [r.id for r in await _channel_rows(env)] == [first]
    # 다른 폴더로 바꾸면 예전 공유는 회수, 새 공유 하나
    await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path="my/다른"), user=env.u["alice"], db=env.db)
    rows = await _channel_rows(env)
    assert len(rows) == 1 and rows[0].file_path == "my/다른" and rows[0].origin == tabs.LINK_ORIGIN


@pytest.mark.asyncio
async def test_legacy_rows_inferred_safely(env):
    """연결 표시(origin)가 없는 공유는 모양이 어떻든 사람이 건 것으로 보고 남긴다 — 회수는 표시된 것만."""
    ch = await env.db.get(Channel, "dev")
    cases = [
        (dict(created_by=None, role="view"), False),
        (dict(created_by=None, role=None), False),
        (dict(created_by="alice", role="view"), False),                      # 공유 창이 만든 행
        (dict(created_by=None, role="edit", can_write=True), False),
        (dict(created_by=None, role="view", origin=tabs.LINK_ORIGIN), True),  # 연결이 만든 행
    ]
    for kw, revoked in cases:
        row = FileShare(owner_id="alice", file_path="my/프로젝트/개발", shared_with_channel_id="dev", **kw)
        env.db.add(row)
        ch.linked_folder_owner_id, ch.linked_folder_path = "alice", "my/프로젝트/개발"
        await env.db.commit()
        await tabs.update_channel_tabs("dev", tabs.TabsUpdate(folder_path=None), user=env.u["alice"], db=env.db)
        rows = await _channel_rows(env)
        assert (rows == []) is revoked, kw
        for r in rows:
            await env.db.delete(r)
        await env.db.commit()
