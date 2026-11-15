"""시작 체크리스트 — 서버가 데이터로 판정·닫기/되돌리기·사용자 분리."""

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.dashboard import checklist as cl
from app.db.models import (
    Base, Channel, ChannelMember, FileIndex, MeetingDB, MeetingInvitee, Message, PushSubscription, User,
    UserDevice, UserInvite, UserPref,
)

TABLES = [t.__table__ for t in (User, Channel, ChannelMember, Message, MeetingDB, MeetingInvitee, FileIndex,
                                UserDevice, PushSubscription, UserInvite, UserPref)]


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        for uid in ("alice", "bob"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x"))
        await s.commit()
        yield s
    await engine.dispose()


def _done(res):
    return {i["id"]: i["done"] for i in res["items"]}


@pytest.mark.asyncio
async def test_all_false_for_new_user(db):
    res = await cl.get_checklist(user=await db.get(User, "alice"), db=db)
    assert res["done_count"] == 0 and res["total"] == len(cl.ITEMS) and not res["dismissed"]
    assert set(_done(res)) == {"profile_photo", "first_message", "invite_colleague", "upload_file",
                               "install_app", "enable_push", "enable_2fa"}


@pytest.mark.asyncio
async def test_items_computed_from_data(db):
    alice = await db.get(User, "alice")
    alice.avatar_url = "/api/auth/avatar/a.png"
    alice.totp_secret = "BASE32"
    dm = Channel(id="dm1", name="dm", type="dm", created_by="alice")
    ch = Channel(id="c1", name="general", type="public", created_by="alice")
    db.add_all([dm, ch])
    db.add(Message(id=str(uuid.uuid4()), channel_id="dm1", sender_id="alice", content="hi"))
    db.add(ChannelMember(channel_id="c1", user_id="bob"))
    db.add(PushSubscription(user_id="alice", endpoint="https://p/1", keys_json="{}"))
    db.add(UserDevice(user_id="alice", name="노트북", revoked_at=datetime.now(timezone.utc)))   # 해지된 기기
    db.add(FileIndex(scope="alice", rel_path="a.txt", name="a.txt", mtime=datetime.now(timezone.utc)))
    await db.commit()

    d = _done(await cl.get_checklist(user=alice, db=db))
    assert d["profile_photo"] and d["enable_2fa"] and d["enable_push"] and d["upload_file"]
    assert d["invite_colleague"]                 # 내 채널에 bob 이 있다
    assert d["first_message"] is False           # DM 은 안 친다
    assert d["install_app"] is False             # 해지된 기기는 안 친다

    db.add(Message(id=str(uuid.uuid4()), channel_id="c1", sender_id="alice", content="첫 글"))
    await db.commit()
    assert _done(await cl.get_checklist(user=alice, db=db))["first_message"] is True

    # bob 의 체크리스트는 alice 데이터와 무관
    assert (await cl.get_checklist(user=await db.get(User, "bob"), db=db))["done_count"] == 0


@pytest.mark.asyncio
async def test_meeting_invite_counts_as_invite(db):
    db.add(MeetingDB(id="m1", room_name="r", host_user_id="alice", share_token="t" * 32))
    db.add(MeetingInvitee(meeting_id="m1", email="guest@ext"))
    await db.commit()
    assert _done(await cl.get_checklist(user=await db.get(User, "alice"), db=db))["invite_colleague"] is True


@pytest.mark.asyncio
async def test_dismiss_and_undo(db):
    alice = await db.get(User, "alice")
    r = await cl.dismiss_checklist(None, user=alice, db=db)
    assert r["dismissed"] is True
    assert (await cl.get_checklist(user=alice, db=db))["dismissed"] is True
    assert (await cl.get_checklist(user=await db.get(User, "bob"), db=db))["dismissed"] is False
    await cl.dismiss_checklist(cl.DismissRequest(undo=True), user=alice, db=db)
    assert (await cl.get_checklist(user=alice, db=db))["dismissed"] is False


def test_links_point_to_real_frontend_routes():
    """링크는 프런트에 있는 화면이어야 한다(예전 /settings/profile·/settings/devices 는 404 화면)."""
    links = {i: link for i, _label, link in cl.ITEMS}
    assert links["profile_photo"] == "/settings/account"
    assert links["install_app"] == "/api/apps"
    assert links["enable_push"] == "/settings/notifications" and links["enable_2fa"] == "/settings/security"
