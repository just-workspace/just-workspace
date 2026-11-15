"""파일 보강 — 최근·즐겨찾기·공유 링크(비밀번호·내려받기 막음·묶음·PATCH)·휴지통 단건 삭제·
버전 작성자/옛 버전 받기·활동 기록·공유받은 폴더 탐색·채널로 공유·이동/복사·손님 링크 정보.

라우터 함수를 직접 부른다. 저장소 루트는 임시 폴더, DB 는 SQLite.
"""

import io
import json
import os
import sys
import types
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

from app.db.models import Base, FileActivity, FileShare, ShareLink, User  # noqa: E402
from app.files import activity as act  # noqa: E402
from app.files import router as fr  # noqa: E402
from app.files import service as fs  # noqa: E402
from app.files.schemas import (  # noqa: E402
    ChannelShareRequest, MoveRequest, RecentRequest, ShareLinkCreate, ShareLinkUpdate,
    ShareUnlockRequest, StarRequest,
)


class Req:
    """Request 대용 — headers 만 쓴다."""

    def __init__(self, headers=None):
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}


@pytest.fixture()
async def env(tmp_path: Path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _session():
        return factory()

    monkeypatch.setattr(act, "_session", _session)
    monkeypatch.setattr(fr.settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(fs, "STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(fs, "VERSIONS_ROOT", tmp_path / ".versions")
    fs._dir_cache.clear()

    async with factory() as db:
        for uid in ("alice", "bob"):
            db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.title()))
        await db.commit()
        alice = await db.get(User, "alice")
        bob = await db.get(User, "bob")
        home = tmp_path / "users" / "alice"
        (home / "docs" / "sub").mkdir(parents=True)
        (home / "docs" / "a.txt").write_text("hello")
        (home / "docs" / "sub" / "b.txt").write_text("world")
        (home / "img.png").write_bytes(b"\x89PNG")
        (tmp_path / "users" / "bob").mkdir(parents=True)
        yield SimpleNamespace(db=db, alice=alice, bob=bob, root=tmp_path, home=home)
    await engine.dispose()


# ─── 이동 / 복사 ───


@pytest.mark.asyncio
async def test_copy_really_copies_and_names_duplicates(env):
    r = await fr.move_file(body=MoveRequest(src="my/docs/a.txt", dst="my/docs", copy=True), user=env.alice, db=env.db)
    assert r["path"] == "my/docs/a (사본).txt"
    r = await fr.move_file(body=MoveRequest(src="my/docs/a.txt", dst="my/docs", copy=True), user=env.alice, db=env.db)
    assert r["path"] == "my/docs/a (사본 2).txt"
    assert (env.home / "docs" / "a.txt").read_text() == "hello"  # 원본 그대로
    r = await fr.move_file(body=MoveRequest(src="my/docs/a.txt", dst="my", copy=True), user=env.alice, db=env.db)
    assert r["path"] == "my/a.txt" and (env.home / "a.txt").is_file() and (env.home / "docs" / "a.txt").is_file()
    # 폴더 복사(같은 자리)
    r = await fr.move_file(body=MoveRequest(src="my/docs", dst="my", copy=True), user=env.alice, db=env.db)
    assert r["path"] == "my/docs (사본)" and (env.home / "docs (사본)" / "sub" / "b.txt").is_file()


@pytest.mark.asyncio
async def test_move_into_itself_rejected_and_move_works(env):
    with pytest.raises(HTTPException) as e:
        await fr.move_file(body=MoveRequest(src="my/docs", dst="my/docs/sub", copy=True), user=env.alice, db=env.db)
    assert e.value.status_code == 400
    with pytest.raises(HTTPException):
        await fr.move_file(body=MoveRequest(src="my/docs", dst="my/docs", copy=False), user=env.alice, db=env.db)
    r = await fr.move_file(body=MoveRequest(src="my/docs/a.txt", dst="my", copy=False), user=env.alice, db=env.db)
    assert r["path"] == "my/a.txt" and not (env.home / "docs" / "a.txt").exists()
    # 이동은 이름이 겹치면 예전처럼 409
    (env.home / "docs" / "a.txt").write_text("again")
    with pytest.raises(HTTPException) as e:
        await fr.move_file(body=MoveRequest(src="my/docs/a.txt", dst="my", copy=False), user=env.alice, db=env.db)
    assert e.value.status_code == 409


# ─── 즐겨찾기 · 최근 · 목록 필드 ───


@pytest.mark.asyncio
async def test_stars_recent_and_list_fields(env):
    db = env.db
    await fr.add_star(body=StarRequest(path="my/docs/a.txt"), user=env.alice, db=db)
    await fr.add_star(body=StarRequest(path="my/docs/a.txt"), user=env.alice, db=db)  # 중복 무시
    stars = (await fr.list_stars(user=env.alice, db=db))["items"]
    assert [s["path"] for s in stars] == ["my/docs/a.txt"] and stars[0]["exists"]

    # bob 의 my/ 는 bob 자기 공간 — alice 파일을 즐겨찾기할 수 없다
    with pytest.raises(HTTPException) as e:
        await fr.add_star(body=StarRequest(path="my/docs/a.txt"), user=env.bob, db=db)
    assert e.value.status_code == 404
    assert (await fr.list_stars(user=env.bob, db=db))["items"] == []

    listing = await fr.list_files(path="my/docs", user=env.alice, db=db)
    by = {i.name: i for i in listing.items}
    assert by["a.txt"].is_starred is True and by["sub"].is_starred is False
    assert by["a.txt"].owner == {"id": "alice", "name": "Alice"}

    await fr.add_recent(body=RecentRequest(path="my/docs/a.txt"), user=env.alice, db=db)
    await fr.add_recent(body=RecentRequest(path="my/img.png"), user=env.alice, db=db)
    rec = (await fr.list_recent(limit=30, user=env.alice, db=db))["items"]
    assert [r["path"] for r in rec] == ["my/img.png", "my/docs/a.txt"]
    (env.home / "img.png").unlink()
    rec = (await fr.list_recent(limit=30, user=env.alice, db=db))["items"]
    assert [r["path"] for r in rec] == ["my/docs/a.txt"]
    assert (await fr.list_recent(limit=30, user=env.bob, db=db))["items"] == []

    await fr.remove_star(path="my/docs/a.txt", user=env.alice, db=db)
    assert (await fr.list_stars(user=env.alice, db=db))["items"] == []


@pytest.mark.asyncio
async def test_rename_moves_star_and_activity(env):
    db = env.db
    from app.files.schemas import RenameRequest
    await fr.add_star(body=StarRequest(path="my/docs"), user=env.alice, db=db)
    await act.record(act.canonical_key("my/docs/a.txt", env.alice), "alice", "upload")
    await fr.rename_file(body=RenameRequest(path="my/docs", new_name="문서"), user=env.alice, db=env.db)
    stars = (await fr.list_stars(user=env.alice, db=db))["items"]
    assert [s["path"] for s in stars] == ["my/문서"]
    acts = (await fr.file_activity(path="my/문서/a.txt", limit=50, include_children=False, user=env.alice, db=db))["items"]
    assert [a["action"] for a in acts] == ["upload"]
    folder = (await fr.file_activity(path="my/문서", limit=50, include_children=True, user=env.alice, db=db))["items"]
    assert {a["action"] for a in folder} == {"upload", "rename"}


@pytest.mark.asyncio
async def test_activity_permissions(env):
    await act.record(act.canonical_key("my/docs/a.txt", env.alice), "alice", "upload")
    # bob 은 users/alice 경로를 못 본다(관리자 아님)
    with pytest.raises(HTTPException) as e:
        await fr.file_activity(path="users/alice/docs/a.txt", limit=50, include_children=False, user=env.bob, db=env.db)
    assert e.value.status_code == 403
    # bob 의 my/docs/a.txt 는 bob 공간이라 alice 기록이 보이지 않는다
    (env.root / "users" / "bob" / "docs").mkdir()
    (env.root / "users" / "bob" / "docs" / "a.txt").write_text("b")
    res = await fr.file_activity(path="my/docs/a.txt", limit=50, include_children=False, user=env.bob, db=env.db)
    assert res["items"] == []


# ─── 공유 링크 ───


@pytest.mark.asyncio
async def test_password_link(env):
    db = env.db
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt", password="1234"), user=env.alice, db=db)
    assert link.has_password
    with pytest.raises(HTTPException) as e:
        await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, db=db)
    assert e.value.status_code == 401
    with pytest.raises(HTTPException) as e:
        await fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="x"), db=db)
    assert e.value.status_code == 401
    acc = (await fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="1234"), db=db))["access"]
    resp = await fr.download_shared(token=link.token, request=Req(), access=acc, inline=False, db=db)
    assert resp.status_code == 200
    resp = await fr.download_shared(token=link.token, request=Req({"X-Share-Password": "1234"}), access=None, inline=False, db=db)
    assert resp.status_code == 200
    # 다른 링크 토큰의 access 는 안 통한다
    other = await fr.create_share_link(body=ShareLinkCreate(path="my/img.png", password="9"), user=env.alice, db=db)
    with pytest.raises(HTTPException):
        await fr.download_shared(token=other.token, request=Req(), access=acc, inline=False, db=db)


@pytest.mark.asyncio
async def test_download_blocked_link_allows_inline_preview_only(env):
    db = env.db
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt", allow_download=False), user=env.alice, db=db)
    with pytest.raises(HTTPException) as e:
        await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, db=db)
    assert e.value.status_code == 403
    res = await fr.download_shared(token=link.token, request=Req(), access=None, inline=True, db=db)
    assert res["type"] == "text" and "hello" in res["content"]


@pytest.mark.asyncio
async def test_patch_share_link_and_permissions(env):
    db = env.db
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt"), user=env.alice, db=db)
    with pytest.raises(HTTPException) as e:
        await fr.update_share_link(link_id=link.id, body=ShareLinkUpdate(password="x"), user=env.bob, db=db)
    assert e.value.status_code == 404
    item = await fr.update_share_link(link_id=link.id, body=ShareLinkUpdate(password="pw", allow_download=False, max_downloads=3),
                                      user=env.alice, db=db)
    assert item.has_password and item.allow_download is False and item.max_downloads == 3
    item = await fr.update_share_link(link_id=link.id, body=ShareLinkUpdate(password="", allow_download=True, max_downloads=0),
                                      user=env.alice, db=db)
    assert not item.has_password and item.allow_download and item.max_downloads is None
    lst = await fr.list_share_links(user=env.alice, db=db)
    assert lst[0].paths == ["my/docs/a.txt"]


@pytest.mark.asyncio
async def test_multi_item_zip_link(env):
    db = env.db
    link = await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs", "my/img.png"]), user=env.alice, db=db)
    assert link.item_count == 2 and link.display_name.endswith(".zip")
    resp = await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, db=db)
    body = b"".join([c async for c in resp.body_iterator])
    z = zipfile.ZipFile(io.BytesIO(body))
    assert sorted(z.namelist()) == ["docs/a.txt", "docs/sub/b.txt", "img.png"]
    with pytest.raises(HTTPException):
        await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs", "shared/x"]), user=env.alice, db=db)


@pytest.mark.asyncio
async def test_guest_info_does_not_count(env):
    from app.wopi import share as wshare
    db = env.db
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt", one_time=True), user=env.alice, db=db)
    info = await wshare.shared_info(token=link.token, db=db)
    info = await wshare.shared_info(token=link.token, db=db)
    assert info.name == "a.txt" and info.size == 5 and info.downloads_left == 1 and info.owner_name == "Alice"
    row = await db.get(ShareLink, link.id)
    await db.refresh(row)
    assert row.download_count == 0
    locked = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt", password="p"), user=env.alice, db=db)
    info = await wshare.shared_info(token=locked.token, db=db)
    assert info.requires_password and info.name == "" and info.size is None


# ─── 휴지통 단건 · 버전 ───


@pytest.mark.asyncio
async def test_trash_single_delete(env):
    r = await fr.delete_file(path="my/docs/a.txt", permanent=False, user=env.alice, db=env.db)
    r2 = await fr.delete_file(path="my/img.png", permanent=False, user=env.alice, db=env.db)
    await fr.delete_trash_item(trash_name=r["trash_name"], user=env.alice, db=env.db)
    trash = await fr.list_trash(user=env.alice, db=env.db)
    assert [t.trash_name for t in trash.items] == [r2["trash_name"]]
    for bad in ("..", "../alice", "x/../../y"):
        with pytest.raises(HTTPException):
            await fr.delete_trash_item(trash_name=bad, user=env.alice, db=env.db)
    with pytest.raises(HTTPException) as e:
        await fr.delete_trash_item(trash_name=r2["trash_name"], user=env.bob, db=env.db)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_version_author_and_download(env):
    import time
    from datetime import datetime, timedelta, timezone
    db = env.db
    key = act.canonical_key("my/docs/a.txt", env.alice)
    t0 = datetime.now(timezone.utc) - timedelta(minutes=10)
    db.add(FileActivity(path_key=key, user_id="bob", action="upload", created_at=t0))
    await db.commit()
    fs.snapshot_version(env.home / "docs" / "a.txt", "alice", "docs/a.txt")   # bob 이 쓴 내용
    db.add(FileActivity(path_key=key, user_id="alice", action="edit",
                        created_at=datetime.now(timezone.utc) + timedelta(seconds=1)))
    await db.commit()
    (env.home / "docs" / "a.txt").write_text("new")

    res = await fr.list_versions(path="my/docs/a.txt", user=env.alice, db=db)
    assert res["count"] == 1
    v = res["versions"][0]
    assert v["author"] == {"id": "bob", "name": "Bob"}
    assert res["current_author"] == {"id": "alice", "name": "Alice"}
    resp = await fr.download_version(request=Req(), path="my/docs/a.txt", version=v["version"], user=env.alice)
    assert Path(resp.path).read_text() == "hello"
    with pytest.raises(HTTPException):
        await fr.download_version(request=Req(), path="my/docs/a.txt", version="../../x", user=env.alice)
    with pytest.raises(HTTPException) as e:  # bob 의 my/ 에는 그 버전이 없다
        await fr.download_version(request=Req(), path="my/docs/a.txt", version=v["version"], user=env.bob)
    assert e.value.status_code == 404


# ─── 공유받은 폴더 탐색 ───


@pytest.mark.asyncio
async def test_browse_shared_folder(env):
    db = env.db
    s = FileShare(owner_id="alice", file_path="my/docs", shared_with_user_id="bob")
    db.add(s)
    await db.commit()
    res = await fr.list_shared_folder(share_id=s.id, path="", user=env.bob, db=db)
    names = {i.name: i for i in res["items"]}
    assert set(names) == {"sub", "a.txt"}
    assert names["a.txt"].path == f"shared-with-me/{s.id}/a.txt"
    assert names["a.txt"].owner["id"] == "alice"
    res = await fr.list_shared_folder(share_id=s.id, path="sub", user=env.bob, db=db)
    assert [i.path for i in res["items"]] == [f"shared-with-me/{s.id}/sub/b.txt"]
    resp = await fr.download_shared_with_me(share_id=s.id, request=Req(), path="sub/b.txt", user=env.bob, db=db)
    assert Path(resp.path).read_text() == "world"
    for bad in ("..", "../img.png", "sub/../../img.png"):
        with pytest.raises(HTTPException):
            await fr.download_shared_with_me(share_id=s.id, request=Req(), path=bad, user=env.bob, db=db)
    with pytest.raises(HTTPException) as e:
        await fr.list_shared_folder(share_id=s.id, path="", user=env.alice, db=db)  # 받는 사람이 아님
    assert e.value.status_code == 404
    # 최근 열람에 공유 경로도 남는다
    await fr.add_recent(body=RecentRequest(path=f"shared-with-me/{s.id}/sub/b.txt"), user=env.bob, db=db)
    rec = (await fr.list_recent(limit=30, user=env.bob, db=db))["items"]
    assert rec[0]["name"] == "b.txt"


# ─── 채널로 공유 ───


@pytest.mark.asyncio
async def test_share_to_channel(env, monkeypatch):
    from app.chat import router as chat_router
    from app.chat import service as chat_service
    made = []

    async def is_member(db, cid, uid):
        return cid == "ch1" and uid == "alice"

    async def create_message(db, cid, uid, content, message_type="text", file_meta=None, **kw):
        made.append((cid, content, message_type, json.loads(file_meta) if file_meta else None))
        return {"id": f"m{len(made)}", "content": content}

    async def broadcast(*a, **k):
        return None

    monkeypatch.setattr(chat_service, "is_channel_member", is_member)
    monkeypatch.setattr(chat_service, "create_message", create_message)
    monkeypatch.setattr(chat_router, "_broadcast_message", broadcast)

    res = await fr.share_to_channel(body=ChannelShareRequest(channel_id="ch1", paths=["my/docs/a.txt"], message="참고"),
                                    user=env.alice, db=env.db)
    assert len(res["messages"]) == 2
    assert made[0][1] == "참고" and made[1][2] == "file"
    meta = made[1][3]
    assert meta["filename"] == "a.txt" and meta["url"].startswith("/api/chat/channels/ch1/files/")
    assert (env.root / "chat_files" / "ch1" / meta["disk_name"]).read_text() == "hello"

    with pytest.raises(HTTPException) as e:
        await fr.share_to_channel(body=ChannelShareRequest(channel_id="ch1", paths=["my/docs/a.txt"]), user=env.bob, db=env.db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await fr.share_to_channel(body=ChannelShareRequest(channel_id="ch1", paths=["my/docs"]), user=env.alice, db=env.db)
    assert e.value.status_code == 400


# ─── 버전 기록이 이동·이름 바꾸기를 따라가고, 영구 삭제로 함께 지워진다(FUNC P2-2) ───


@pytest.mark.asyncio
async def test_versions_follow_rename_move_and_drop_on_delete(env):
    from app.files.router import RenameRequest
    fs.snapshot_version(env.home / "docs" / "a.txt", "alice", "docs/a.txt")
    assert len(fs.list_versions("alice", "docs/a.txt")) == 1
    await fr.rename_file(body=RenameRequest(path="my/docs/a.txt", new_name="b.txt"), user=env.alice, db=env.db)
    assert fs.list_versions("alice", "docs/a.txt") == []
    assert len(fs.list_versions("alice", "docs/b.txt")) == 1
    await fr.move_file(body=MoveRequest(src="my/docs/b.txt", dst="my", copy=False), user=env.alice, db=env.db)
    assert len(fs.list_versions("alice", "b.txt")) == 1
    # 폴더 이동 — 하위 파일 버전 통째로
    fs.snapshot_version(env.home / "docs" / "sub" / "b.txt", "alice", "docs/sub/b.txt")
    await fr.rename_file(body=RenameRequest(path="my/docs", new_name="papers"), user=env.alice, db=env.db)
    assert len(fs.list_versions("alice", "papers/sub/b.txt")) == 1
    # 영구 삭제 → 스냅샷도
    await fr.delete_file(path="my/b.txt", permanent=True, user=env.alice, db=env.db)
    assert not (env.root / ".versions" / "alice" / "b.txt").exists()
