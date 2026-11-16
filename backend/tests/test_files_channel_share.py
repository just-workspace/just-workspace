"""파일 공유 "사람·채널" — 채널 공유 ACL·권한 검사·채팅 알림.

라우터 함수를 직접 호출한다. 저장소 루트는 임시 폴더, DB 는 SQLite(채널·멤버 테이블 포함).
"""

import os
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

from app.db.models import Base, Channel, ChannelMember, FileShare, User  # noqa: E402
from app.files import activity as act  # noqa: E402
from app.files import router as fr  # noqa: E402
from app.files import service as fs  # noqa: E402
from app.files.schemas import RecentRequest  # noqa: E402


class Req:
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

    # 채팅 알림은 실제 메시지 생성 대신 기록만 수행
    from app.chat import router as chat_router
    from app.chat import service as chat_service
    sent: list[tuple[str, str]] = []

    async def create_message(db, cid, uid, content, **kw):
        sent.append((cid, content))
        return {"id": f"m{len(sent)}", "content": content}

    async def broadcast(*a, **k):
        return None

    async def get_or_create_dm(db, a, b):
        return SimpleNamespace(id=f"dm-{a}-{b}")

    monkeypatch.setattr(chat_service, "create_message", create_message)
    monkeypatch.setattr(chat_service, "get_or_create_dm", get_or_create_dm)
    monkeypatch.setattr(chat_router, "_broadcast_message", broadcast)

    async with factory() as db:
        for uid in ("alice", "bob", "carol", "dave"):
            db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.title()))
        await db.commit()
        db.add(Channel(id="dev", name="개발", type="public", created_by="alice"))
        db.add(Channel(id="hr", name="채용", type="private", created_by="dave"))
        await db.commit()
        for cid, uid in (("dev", "alice"), ("dev", "bob"), ("dev", "carol"), ("hr", "dave")):
            db.add(ChannelMember(channel_id=cid, user_id=uid))
        await db.commit()
        users = {u: await db.get(User, u) for u in ("alice", "bob", "carol", "dave")}
        home = tmp_path / "users" / "alice"
        (home / "docs" / "sub").mkdir(parents=True)
        (home / "docs" / "a.txt").write_text("hello")
        (home / "docs" / "sub" / "b.txt").write_text("world")
        for u in ("bob", "carol", "dave"):
            (tmp_path / "users" / u).mkdir(parents=True)
        yield SimpleNamespace(db=db, u=users, sent=sent)
    await engine.dispose()


@pytest.mark.asyncio
async def test_share_to_people_and_channel_with_chat_notice(env):
    r = await fr.share_with_users(
        body=fr.ShareUserCreate(path="my/docs", user_ids=["dave"], channel_ids=["dev"], can_write=False,
                                notify=True, message="검토 부탁해요"),
        user=env.u["alice"], db=env.db,
    )
    assert r["created"] == 2 and r["notified"] == 2
    targets = {cid for cid, _ in env.sent}
    assert targets == {"dm-alice-dave", "dev"}
    assert all("검토 부탁해요" in text and "docs" in text for _, text in env.sent)

    lst = (await fr.list_user_shares(path="my/docs", user=env.u["alice"], db=env.db))["shares"]
    ch = next(s for s in lst if s["channel_id"] == "dev")
    assert ch["channel_name"] == "개발" and ch["member_count"] == 3 and ch["user_id"] is None


@pytest.mark.asyncio
async def test_no_notice_without_notify(env):
    r = await fr.share_with_users(
        body=fr.ShareUserCreate(path="my/docs", channel_ids=["dev"]), user=env.u["alice"], db=env.db,
    )
    assert r["notified"] == 0 and env.sent == []


@pytest.mark.asyncio
async def test_cannot_share_to_channel_i_am_not_in(env):
    with pytest.raises(HTTPException) as e:
        await fr.share_with_users(
            body=fr.ShareUserCreate(path="my/docs", channel_ids=["hr"]), user=env.u["alice"], db=env.db,
        )
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await fr.share_with_users(body=fr.ShareUserCreate(path="my/docs"), user=env.u["alice"], db=env.db)
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_channel_members_can_browse_others_cannot(env):
    await fr.share_with_users(
        body=fr.ShareUserCreate(path="my/docs", channel_ids=["dev"]), user=env.u["alice"], db=env.db,
    )
    sid = (await fr.list_user_shares(path="my/docs", user=env.u["alice"], db=env.db))["shares"][0]["id"]

    # 멤버(bob): 공유받음에 표시되고(경유 채널 포함) 폴더 내부를 조회할 수 있다
    mine = (await fr.shared_with_me(user=env.u["bob"], db=env.db))["items"]
    assert [i["name"] for i in mine] == ["docs"]
    assert mine[0]["via_channel"] == {"id": "dev", "name": "개발"}
    res = await fr.list_shared_folder(share_id=sid, path="", user=env.u["bob"], db=env.db)
    assert {i.name for i in res["items"]} == {"sub", "a.txt"}
    resp = await fr.download_shared_with_me(share_id=sid, request=Req(), path="sub/b.txt", user=env.u["carol"], db=env.db)
    assert Path(resp.path).read_text() == "world"
    await fr.add_recent(body=RecentRequest(path=f"shared-with-me/{sid}/a.txt"), user=env.u["bob"], db=env.db)
    assert (await fr.list_recent(limit=30, user=env.u["bob"], db=env.db))["items"][0]["name"] == "a.txt"

    # 비멤버(dave)·소유자 본인(alice)은 공유 경로로 열 수 없다
    for who in ("dave", "alice"):
        with pytest.raises(HTTPException) as e:
            await fr.list_shared_folder(share_id=sid, path="", user=env.u[who], db=env.db)
        assert e.value.status_code == 404
        assert (await fr.shared_with_me(user=env.u[who], db=env.db))["items"] == []

    # 채널에서 나가면 즉시 차단
    from sqlalchemy import delete
    await env.db.execute(delete(ChannelMember).where(ChannelMember.channel_id == "dev", ChannelMember.user_id == "bob"))
    await env.db.commit()
    with pytest.raises(HTTPException):
        await fr.download_shared_with_me(share_id=sid, request=Req(), path="a.txt", user=env.u["bob"], db=env.db)


@pytest.mark.asyncio
async def test_direct_and_channel_share_dedup_prefers_direct(env):
    await fr.share_with_users(
        body=fr.ShareUserCreate(path="my/docs", channel_ids=["dev"], can_write=True), user=env.u["alice"], db=env.db,
    )
    await fr.share_with_users(
        body=fr.ShareUserCreate(path="my/docs", user_ids=["bob"], can_write=False), user=env.u["alice"], db=env.db,
    )
    items = (await fr.shared_with_me(user=env.u["bob"], db=env.db))["items"]
    assert len(items) == 1 and items[0]["via_channel"] is None


@pytest.mark.asyncio
async def test_only_owner_can_remove_channel_share(env):
    await fr.share_with_users(
        body=fr.ShareUserCreate(path="my/docs", channel_ids=["dev"]), user=env.u["alice"], db=env.db,
    )
    sid = (await fr.list_user_shares(path="my/docs", user=env.u["alice"], db=env.db))["shares"][0]["id"]
    with pytest.raises(HTTPException) as e:
        await fr.delete_user_share(share_id=sid, user=env.u["bob"], db=env.db)
    assert e.value.status_code == 404
    assert (await fr.delete_user_share(share_id=sid, user=env.u["alice"], db=env.db))["ok"]
    assert await env.db.get(FileShare, sid) is None
