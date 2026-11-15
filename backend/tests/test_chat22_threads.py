"""chat22 — 스레드(혼합형): 이름·시작·보관·자동 보관·답글로 보관 해제·채널 스레드 목록·권한."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.chat import router as chat_router
from app.chat import router22, service
from app.chat.schemas import ChannelUpdate, ThreadPatch, ThreadStart
from app.db.models import Message
from tests.chat22_fixtures import db, events, u  # noqa: F401


async def _threads(db, cid, uid, archived=False, limit=25, before=None):
    return await router22.list_channel_threads(channel_id=cid, archived=archived, limit=limit, before=before,
                                               user=await u(db, uid), db=db)


@pytest.mark.asyncio
async def test_start_name_and_list(db, events):
    ch = await service.create_channel(db, "dev", "public", "alice", member_ids=["bob", "carol"])
    root = await service.create_message(db, ch.id, "alice", "배포 체크리스트를 여기서 정리합시다 — 서버·DB·프런트")
    meta = await router22.start_thread(message_id=root["id"], body=ThreadStart(name=None),
                                       user=await u(db, "bob"), db=db)
    assert meta["name"] is None and meta["display_name"] == "배포 체크리스트를 여기서 정리합시다 — 서버·DB·프런트"[:40]
    assert meta["reply_count"] == 0 and meta["archived"] is False and meta["auto_archive_minutes"] == 4320
    # 이미 시작된 스레드 이름 바꾸기 — 루트 작성자 아닌 일반 멤버는 안 됨
    with pytest.raises(HTTPException) as e:
        await router22.start_thread(message_id=root["id"], body=ThreadStart(name="체크"),
                                    user=await u(db, "carol"), db=db)
    assert e.value.status_code == 403
    meta = await router22.patch_thread(message_id=root["id"], body=ThreadPatch(name="배포"),
                                       user=await u(db, "alice"), db=db)
    assert meta["name"] == "배포" and meta["display_name"] == "배포"
    await service.create_message(db, ch.id, "carol", "DB 끝", parent_id=root["id"])
    res = await _threads(db, ch.id, "bob")
    assert len(res["items"]) == 1 and res["default_auto_archive_minutes"] == 4320 and res["total"] == 1
    it = res["items"][0]
    assert it["root"]["id"] == root["id"] and it["thread"]["reply_count"] == 1
    assert it["last_reply"]["content"] == "DB 끝" and it["last_reply"]["sender"]["id"] == "carol"
    assert it["followed"] is True and it["unread"] is True     # bob 은 시작하며 팔로우, carol 의 답글 미읽음
    assert {p["id"] for p in it["participants"]} == {"carol"}
    # 메시지 목록의 루트에도 thread 메타
    page = await chat_router.list_messages(channel_id=ch.id, before=None, after=None, before_seq=None,
                                           after_seq=None, around=None, limit=50, user=await u(db, "bob"), db=db)
    r = next(m for m in page["messages"] if m["id"] == root["id"])
    assert r["thread"]["name"] == "배포" and r["thread"]["reply_count"] == 1


@pytest.mark.asyncio
async def test_archive_unarchive_by_reply_and_auto(db, events):
    ch = await service.create_channel(db, "dev", "public", "alice", member_ids=["bob"])
    a = await service.create_message(db, ch.id, "bob", "스레드 A")
    await service.create_message(db, ch.id, "alice", "답", parent_id=a["id"])
    # 채널 owner(alice)는 남의 스레드도 관리(MANAGE_THREADS 자리)
    meta = await router22.patch_thread(message_id=a["id"], body=ThreadPatch(archived=True),
                                       user=await u(db, "alice"), db=db)
    assert meta["archived"] is True
    assert (await _threads(db, ch.id, "bob"))["items"] == []
    assert len((await _threads(db, ch.id, "bob", archived=True))["items"]) == 1
    # 보관된 스레드에 답글 → 보관 해제
    await service.create_message(db, ch.id, "bob", "다시", parent_id=a["id"])
    assert len((await _threads(db, ch.id, "bob"))["items"]) == 1
    # 자동 보관: 마지막 활동 + 60분 지남
    await router22.patch_thread(message_id=a["id"], body=ThreadPatch(auto_archive_minutes=60),
                                user=await u(db, "bob"), db=db)
    old = datetime.now(timezone.utc) - timedelta(hours=3)
    from sqlalchemy import update
    await db.execute(update(Message).where(Message.channel_id == ch.id)
                     .values(created_at=old, thread_activity_at=old))
    await db.execute(update(Message).where(Message.id == a["id"]).values(thread_started_at=old))
    await db.commit()
    cid = ch.id
    db.expire_all()
    assert (await _threads(db, cid, "bob"))["items"] == []
    arch = await _threads(db, cid, "bob", archived=True)
    assert arch["items"][0]["thread"]["archived"] is True
    # 보관 해제하면 자동 보관 시계도 다시
    meta = await router22.patch_thread(message_id=a["id"], body=ThreadPatch(archived=False),
                                       user=await u(db, "bob"), db=db)
    assert meta["archived"] is False
    with pytest.raises(HTTPException) as e:
        await router22.patch_thread(message_id=a["id"], body=ThreadPatch(auto_archive_minutes=7),
                                    user=await u(db, "bob"), db=db)
    assert e.value.detail["code"] == "bad_auto_archive"


@pytest.mark.asyncio
async def test_permissions_and_channel_default(db, events):
    ch = await service.create_channel(db, "dev", "public", "alice", member_ids=["bob", "carol"])
    root = await service.create_message(db, ch.id, "bob", "루트")
    with pytest.raises(HTTPException) as e:
        await router22.patch_thread(message_id=root["id"], body=ThreadPatch(archived=True),
                                    user=await u(db, "carol"), db=db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await router22.start_thread(message_id=root["id"], body=None, user=await u(db, "dave"), db=db)
    assert e.value.status_code == 403
    reply = await service.create_message(db, ch.id, "carol", "답", parent_id=root["id"])
    with pytest.raises(HTTPException) as e:
        await router22.start_thread(message_id=reply["id"], body=None, user=await u(db, "carol"), db=db)
    assert e.value.detail["code"] == "not_root"
    await chat_router.update_channel(channel_id=ch.id, body=ChannelUpdate(default_thread_auto_archive_minutes=1440),
                                     user=await u(db, "alice"), db=db)
    res = await _threads(db, ch.id, "carol")
    assert res["default_auto_archive_minutes"] == 1440
    assert res["items"][0]["thread"]["auto_archive_minutes"] == 1440
    with pytest.raises(HTTPException):
        await chat_router.update_channel(channel_id=ch.id, body=ChannelUpdate(default_thread_auto_archive_minutes=5),
                                         user=await u(db, "alice"), db=db)


@pytest.mark.asyncio
async def test_total_and_paging(db, events):
    ch = await service.create_channel(db, "dev", "public", "alice", member_ids=["bob"])
    roots = []
    for i in range(5):
        r = await service.create_message(db, ch.id, "alice", f"루트 {i}")
        await service.create_message(db, ch.id, "bob", "답", parent_id=r["id"])
        roots.append(r["id"])
    p1 = await _threads(db, ch.id, "bob", limit=2)
    assert p1["total"] == 5 and p1["has_more"] is True and len(p1["items"]) == 2
    assert p1["items"][0]["root"]["id"] == roots[-1]          # 최근 활동순
    cursor = p1["items"][-1]["thread"]["activity_at"]
    p2 = await _threads(db, ch.id, "bob", limit=2, before=cursor)
    assert p2["total"] == 5 and [i["root"]["id"] for i in p2["items"]] == [roots[2], roots[1]]
    assert (await _threads(db, ch.id, "bob", archived=True))["total"] == 0
