"""채팅 보강 — 채널별 기기 알림 세부, 스레드 답글 파일 첨부, is_saved, 스레드 참여자·마지막 답글,
오프라인 스레드 팔로워 푸시(DND·notify_level·muted·기기 설정 존중).

test_chat_prereq.py 와 같은 방식(SQLite, 채팅 테이블만, Redis 는 monkeypatch).
"""

import io
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.chat import notify, service
from app.chat import router as chat_router
from app.chat.schemas import ChannelPrefsUpdate
from app.db.models import (
    Base, Channel, ChannelMember, ChatDraft, ChatMention, Message, Notification, Reaction,
    SavedMessage, SystemSetting, ThreadFollow, User, UserStatus,
)

TABLES = [
    t.__table__
    for t in (User, Channel, ChannelMember, Message, Reaction, Notification, ChatMention,
              ThreadFollow, UserStatus, ChatDraft, SavedMessage, SystemSetting)
]


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        for uid in ("alice", "bob", "carol", "dave"):
            session.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x",
                             display_name=uid.capitalize()))
        await session.commit()
        yield session
    await engine.dispose()


@pytest.fixture()
def events(monkeypatch):
    sent = {"user": [], "channel": [], "push": [], "online": set()}

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

    monkeypatch.setattr(notify, "emit_to_user", _to_user)
    monkeypatch.setattr(notify, "emit_to_channel", _to_channel)
    monkeypatch.setattr(notify, "connected_users", _connected)
    monkeypatch.setattr(notify, "_push", _push)
    monkeypatch.setattr(chat_router, "emit_to_user", _to_user)
    from app.notifications import service as nsvc
    import app.realtime.events as ev
    monkeypatch.setattr(ev, "emit_to_user", _to_user)
    monkeypatch.setattr(ev, "is_connected", _is_connected)
    monkeypatch.setattr(nsvc, "_push", lambda d: _push(d["user_id"], d["title"], "", ""))
    return sent


async def _flush_tasks():
    import asyncio
    for _ in range(3):
        await asyncio.sleep(0)


async def _send(db, cid, uid, text, parent=None):
    msg = await service.create_message(db, cid, uid, text, parent_id=parent)
    await notify.after_message_created(db, msg, cid, uid, text)
    await _flush_tasks()
    return msg


@pytest.mark.asyncio
async def test_device_prefs_roundtrip_and_permission(db, events):
    ch = await service.create_channel(db, "general", "public", "alice", member_ids=["bob"])
    bob = await db.get(User, "bob")
    dave = await db.get(User, "dave")
    p = await chat_router.get_channel_prefs(channel_id=ch.id, user=bob, db=db)
    assert p["desktop"] is True and p["push"] is True and p["email"] is False and p["thread_replies"] is True
    p = await chat_router.update_channel_prefs(
        channel_id=ch.id, body=ChannelPrefsUpdate(push=False, email=True), user=bob, db=db)
    assert p["push"] is False and p["email"] is True and p["notify_level"] == "mentions"
    with pytest.raises(HTTPException) as e:
        await chat_router.update_channel_prefs(
            channel_id=ch.id, body=ChannelPrefsUpdate(push=False), user=dave, db=db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException):
        await chat_router.get_channel_prefs(channel_id=ch.id, user=dave, db=db)


@pytest.mark.asyncio
async def test_push_off_suppresses_all_level_and_mention_push(db, events):
    ch = await service.create_channel(db, "general", "public", "alice", member_ids=["bob", "carol"])
    for uid in ("bob", "carol"):
        await service.update_channel_prefs(db, ch.id, uid, notify_level="all")
    await service.update_channel_prefs(db, ch.id, "bob", push=False)
    await _send(db, ch.id, "alice", "hi")
    pushed = {p[0] for p in events["push"]}
    assert "carol" in pushed and "bob" not in pushed
    events["push"].clear()
    await _send(db, ch.id, "alice", "@bob 봐 주세요")
    assert "bob" not in {p[0] for p in events["push"]}
    # 인앱 알림은 그대로 생긴다
    from sqlalchemy import select
    n = (await db.execute(select(Notification).where(Notification.user_id == "bob"))).scalars().all()
    assert len(n) == 1


@pytest.mark.asyncio
async def test_thread_reply_pushes_offline_followers_with_rules(db, events):
    ch = await service.create_channel(db, "dev", "public", "alice", member_ids=["bob", "carol", "dave"])
    root = await _send(db, ch.id, "alice", "배포 언제?")
    # bob, carol, dave 가 답글로 팔로우
    for uid in ("bob", "carol", "dave"):
        await _send(db, ch.id, uid, f"{uid} 의견", parent=root["id"])
    await service.update_channel_prefs(db, ch.id, "carol", thread_replies=False)
    await service.update_channel_prefs(db, ch.id, "dave", muted=True)
    events["online"] = {"alice"}
    events["push"].clear()

    await _send(db, ch.id, "bob", "오늘 저녁", parent=root["id"])
    pushed = [p for p in events["push"]]
    targets = {p[0] for p in pushed}
    # alice 는 접속 중, bob 은 보낸 사람, carol 은 스레드 답글 끔, dave 는 음소거
    assert targets == set()

    events["online"] = set()
    await _send(db, ch.id, "bob", "다시", parent=root["id"])
    pushed = [p for p in events["push"] if p[0] == "alice"]
    assert len(pushed) == 1 and "thread=" in pushed[0][2]
    assert {p[0] for p in events["push"]} == {"alice"}


@pytest.mark.asyncio
async def test_thread_push_respects_dnd(db, events, monkeypatch):
    """DND 는 notify._push 안(push_allowed)에서 거른다 — 여기서는 대상 계산이 DND 와 무관함만 본다."""
    members = [
        {"user_id": "a", "notify_level": "mentions", "muted": False, "push": True, "thread_replies": True},
        {"user_id": "b", "notify_level": "none", "muted": False, "push": True, "thread_replies": True},
        {"user_id": "c", "notify_level": "all", "muted": False, "push": False, "thread_replies": True},
        {"user_id": "d", "notify_level": "all", "muted": False, "push": True, "thread_replies": True},
    ]
    assert notify.thread_push_targets(members, ["a", "b", "c", "d", "x"], "d", {"a"}) == []
    assert notify.thread_push_targets(members, ["a", "b", "c", "d"], None, set()) == ["a", "d"]


@pytest.mark.asyncio
async def test_messages_have_saved_and_thread_meta(db, events):
    ch = await service.create_channel(db, "general", "public", "alice", member_ids=["bob", "carol"])
    root = await _send(db, ch.id, "alice", "질문")
    plain = await _send(db, ch.id, "alice", "그냥 글")
    await _send(db, ch.id, "bob", "답1", parent=root["id"])
    await _send(db, ch.id, "carol", "답2", parent=root["id"])
    last = await _send(db, ch.id, "bob", "답3", parent=root["id"])
    await service.save_message(db, "bob", root["id"])

    msgs, _ = await service.get_messages(db, ch.id, user_id="bob")
    by = {m["id"]: m for m in msgs}
    assert by[root["id"]]["is_saved"] is True and by[plain["id"]]["is_saved"] is False
    parts = [p["id"] for p in by[root["id"]]["thread_participants"]]
    assert parts == ["bob", "carol"]  # 최근 답글 순
    assert by[root["id"]]["last_reply_at"] == last["created_at"]
    assert by[plain["id"]]["thread_participants"] == [] and by[plain["id"]]["last_reply_at"] is None

    # 다른 사람 기준으론 저장 안 됨
    msgs, _ = await service.get_messages(db, ch.id, user_id="alice")
    assert not any(m["is_saved"] for m in msgs)
    # user_id 없이 부르면(기존 호출) is_saved 는 False
    msgs, _ = await service.get_messages(db, ch.id)
    assert not any(m["is_saved"] for m in msgs)

    replies = await service.get_thread_messages(db, root["id"], user_id="bob")
    await service.save_message(db, "bob", replies[0]["id"])
    replies = await service.get_thread_messages(db, root["id"], user_id="bob")
    assert replies[0]["is_saved"] is True and replies[1]["is_saved"] is False


@pytest.mark.asyncio
async def test_thread_reply_file_upload(db, events, tmp_path: Path, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "storage_root", str(tmp_path))
    ch = await service.create_channel(db, "general", "public", "alice", member_ids=["bob"])
    root = await _send(db, ch.id, "alice", "자료 주세요")
    bob = await db.get(User, "bob")
    up = UploadFile(file=io.BytesIO(b"data"), filename="보고서.pdf")
    msg = await chat_router.upload_chat_file(
        channel_id=ch.id, file=up, parent_id=root["id"], also_to_channel=False, user=bob, db=db,
    )
    assert msg["parent_id"] == root["id"] and msg["message_type"] == "file"
    timeline, _ = await service.get_messages(db, ch.id)
    assert msg["id"] not in {m["id"] for m in timeline}  # 답글이라 메인 타임라인엔 없음
    thread = await service.get_thread_messages(db, root["id"])
    assert [m["id"] for m in thread] == [msg["id"]]

    # 답글의 답글로 올리면 같은 스레드 루트로 붙는다
    up = UploadFile(file=io.BytesIO(b"x"), filename="b.txt")
    msg2 = await chat_router.upload_chat_file(
        channel_id=ch.id, file=up, parent_id=msg["id"], also_to_channel=True, user=bob, db=db,
    )
    assert msg2["parent_id"] == root["id"] and msg2["thread_broadcast"] is True

    other = await service.create_channel(db, "other", "public", "alice", member_ids=["bob"])
    with pytest.raises(HTTPException) as e:
        await chat_router.upload_chat_file(
            channel_id=other.id, file=UploadFile(file=io.BytesIO(b"x"), filename="c.txt"),
            parent_id=root["id"], also_to_channel=False, user=bob, db=db,
        )
    assert e.value.status_code == 404
