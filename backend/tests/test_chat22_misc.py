"""chat22 — 음소거 기간·고정 시스템 줄·프로필·포럼 채널·채팅 정책 토글·보관 시스템 카테고리."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.chat import permissions as P
from app.chat import roles as chat_roles
from app.chat import router as chat_router
from app.chat import router22, service
from app.chat.schemas import ChannelCreate, ChannelPrefsUpdate, ChatPolicyUpdate, ProfileUpdate
from app.db.models import AuditLog, Board, ChannelMember, ChatCategory, Message
from tests.chat22_fixtures import db, events, u  # noqa: F401


# ─── 음소거 기간 ───

@pytest.mark.asyncio
async def test_muted_minutes(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    bob = await u(db, "bob")
    p = await chat_router.update_channel_prefs(channel_id=ch.id, body=ChannelPrefsUpdate(muted_minutes=60),
                                               user=bob, db=db)
    assert p["muted"] is True and p["muted_until"] is not None
    until = datetime.fromisoformat(p["muted_until"])
    assert timedelta(minutes=59) < until - datetime.now(timezone.utc) <= timedelta(minutes=60)
    lst = {c["id"]: c for c in await service.get_user_channels(db, "bob")}
    assert lst[ch.id]["muted"] is True and lst[ch.id]["muted_until"] == p["muted_until"]
    # 지나면 음소거 아님(지연 판정) — 목록·푸시 판단 모두
    cm = (await db.execute(select(ChannelMember).where(ChannelMember.channel_id == ch.id,
                                                       ChannelMember.user_id == "bob"))).scalar_one()
    cm.muted_until = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db.commit()
    lst = {c["id"]: c for c in await service.get_user_channels(db, "bob")}
    assert lst[ch.id]["muted"] is False and lst[ch.id]["muted_until"] is None
    members = {m["user_id"]: m for m in await service.get_members_for_notify(db, ch.id)}
    assert members["bob"]["muted"] is False
    # null 명시 = 끌 때까지
    p = await chat_router.update_channel_prefs(channel_id=ch.id, body=ChannelPrefsUpdate(muted_minutes=None),
                                               user=bob, db=db)
    assert p["muted"] is True and p["muted_until"] is None
    p = await chat_router.update_channel_prefs(channel_id=ch.id, body=ChannelPrefsUpdate(muted=False), user=bob, db=db)
    assert p["muted"] is False
    with pytest.raises(HTTPException) as e:
        await chat_router.update_channel_prefs(channel_id=ch.id, body=ChannelPrefsUpdate(muted_minutes=7),
                                               user=bob, db=db)
    assert e.value.detail["code"] == "bad_muted_minutes"


# ─── 고정 시스템 줄 ───

@pytest.mark.asyncio
async def test_pin_system_line_once(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    m = await service.create_message(db, ch.id, "alice", "중요 공지")
    bob = await u(db, "bob")
    await chat_router.pin_message(message_id=m["id"], user=bob, db=db)
    await chat_router.pin_message(message_id=m["id"], user=bob, db=db)     # 이미 고정 → 줄 그대로
    await chat_router.unpin_message(message_id=m["id"], user=bob, db=db)
    await chat_router.pin_message(message_id=m["id"], user=bob, db=db)     # 다시 고정해도 이미 줄이 있음
    lines = (await db.execute(select(Message).where(Message.channel_id == ch.id, Message.content == "고정"))).scalars().all()
    assert len(lines) == 1 and lines[0].message_type == "system"
    import json
    assert json.loads(lines[0].file_meta) == {"kind": "pin", "message_id": m["id"], "actor_id": "bob"}
    assert sum(1 for _c, ev in events["channel"] if ev["type"] == "new_message") == 1


# ─── 프로필 ───

@pytest.mark.asyncio
async def test_profile_get_patch(db, events):
    alice = await u(db, "alice")
    out = await router22.update_my_profile(body=ProfileUpdate(bio="  인프라 담당 ", timezone="Asia/Seoul"),
                                           user=alice, db=db)
    assert out == {"bio": "인프라 담당", "timezone": "Asia/Seoul"}
    with pytest.raises(HTTPException) as e:
        await router22.update_my_profile(body=ProfileUpdate(timezone="Mars/Base"), user=alice, db=db)
    assert e.value.detail["code"] == "bad_timezone"
    p = await router22.user_profile(target_id="alice", user=await u(db, "bob"), db=db)
    assert p["bio"] == "인프라 담당" and p["timezone"] == "Asia/Seoul" and p["is_me"] is False
    assert p["job_title"] is None and p["department"] is None and "presence" in p
    assert (await router22.user_profile(target_id="alice", user=alice, db=db))["is_me"] is True
    await router22.update_my_profile(body=ProfileUpdate(bio=None), user=alice, db=db)
    assert (await router22.user_profile(target_id="alice", user=alice, db=db))["bio"] is None
    with pytest.raises(HTTPException):
        await router22.user_profile(target_id="nobody", user=alice, db=db)


# ─── 포럼 ───

@pytest.mark.asyncio
async def test_forum_channel(db, events):
    root, alice = await u(db, "root"), await u(db, "alice")
    out = await chat_router.create_channel(body=ChannelCreate(name="질문 게시판", forum=True), user=root, db=db)
    b = await db.get(Board, out["forum_board_id"])
    assert b is not None and b.name == "질문 게시판" and b.slug.startswith("chat-")
    with pytest.raises(HTTPException) as e:
        await chat_router.create_channel(body=ChannelCreate(name="새 포럼", forum=True), user=alice, db=db)
    assert e.value.status_code == 403
    linked = await chat_router.create_channel(body=ChannelCreate(name="연결", forum=True, board_id=b.id),
                                              user=alice, db=db)
    assert linked["forum_board_id"] == b.id
    with pytest.raises(HTTPException) as e:
        await chat_router.create_channel(body=ChannelCreate(name="x", forum=True, board_id="nope"), user=alice, db=db)
    assert e.value.status_code == 404
    lst = {c["id"]: c for c in await service.get_user_channels(db, "alice")}
    assert lst[linked["id"]]["forum_board_id"] == b.id
    plain = await chat_router.create_channel(body=ChannelCreate(name="일반"), user=alice, db=db)
    assert plain["forum_board_id"] is None
    det = await chat_router.get_channel(channel_id=linked["id"], user=alice, db=db)
    assert det["forum_board_id"] == b.id


# ─── 채팅 정책 토글 ───

@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["shadow", "enforce", "legacy"])
async def test_policy_toggles(db, events, monkeypatch, mode):
    monkeypatch.setattr(P, "engine_mode", lambda: mode)
    for k in P.SHADOW_STATS:
        P.SHADOW_STATS[k] = 0
    root, alice, bob = await u(db, "root"), await u(db, "alice"), await u(db, "bob")
    pol = await router22.get_chat_policy(user=alice, db=db)
    assert pol == {"admin_channel_privileges": False, "owner_manage_messages": False, "can_edit": False}
    with pytest.raises(HTTPException) as e:
        await router22.put_chat_policy(body=ChatPolicyUpdate(owner_manage_messages=True), user=alice, db=db)
    assert e.value.status_code == 403

    priv = await service.create_channel(db, "secret", "private", "alice", member_ids=["bob"])
    dm = await service.get_or_create_dm(db, "alice", "bob")
    m_bob = await service.create_message(db, priv.id, "bob", "bob 의 글")
    msg_obj = await db.get(Message, m_bob["id"])
    # 기본(끔) = 지금 동작: 관리자도 남의 비공개 채널·DM 못 봄, owner 도 남의 글 못 지움
    assert not await P.allowed(db, root, "message.read", priv.id)
    assert not await P.allowed(db, root, "message.read", dm.id)
    assert not await P.allowed(db, alice, "message.delete", priv.id, message=msg_obj)

    out = await router22.put_chat_policy(body=ChatPolicyUpdate(admin_channel_privileges=True), user=root, db=db)
    assert out["admin_channel_privileges"] is True and out["owner_manage_messages"] is False and out["can_edit"]
    assert await P.allowed(db, root, "message.read", priv.id)
    assert await P.allowed(db, root, "message.read", dm.id)
    assert await P.allowed(db, root, "message.delete", priv.id, message=msg_obj)
    assert await P.allowed(db, root, "channel.delete", priv.id)
    assert not await P.allowed(db, root, "message.edit", priv.id, message=msg_obj)   # 남의 글 수정은 누구도
    assert not await P.allowed(db, alice, "message.delete", priv.id, message=msg_obj)

    await router22.put_chat_policy(body=ChatPolicyUpdate(owner_manage_messages=True), user=root, db=db)
    assert await P.allowed(db, alice, "message.delete", priv.id, message=msg_obj)       # owner
    assert await P.allowed(db, alice, "preview.dismiss", priv.id, message=msg_obj)
    m_alice = await db.get(Message, (await service.create_message(db, priv.id, "alice", "a"))["id"])
    assert not await P.allowed(db, bob, "message.delete", priv.id, message=m_alice)    # 일반 멤버는 그대로
    # 그림자 모드에서도 두 판정이 같다(불일치 0)
    assert P.SHADOW_STATS["error"] == 0
    if mode == "shadow":
        assert P.SHADOW_STATS["mismatch"] == 0
    logs = (await db.execute(select(AuditLog).where(AuditLog.action.like("chat.policy.%")))).scalars().all()
    assert {x.action for x in logs} == {"chat.policy.admin_channel_privileges", "chat.policy.owner_manage_messages"}
    import json
    assert json.loads(logs[0].details) == {"from": False, "to": True}
    assert any(ev["type"] == "chat_policy_changed" for ev in events["all"])
    await router22.put_chat_policy(body=ChatPolicyUpdate(admin_channel_privileges=False, owner_manage_messages=False),
                                   user=root, db=db)
    assert not await P.allowed(db, root, "message.read", priv.id)


@pytest.mark.asyncio
async def test_policy_no_shadow_mismatch(db, events, monkeypatch):
    monkeypatch.setattr(P, "engine_mode", lambda: "shadow")
    for k in P.SHADOW_STATS:
        P.SHADOW_STATS[k] = 0
    root = await u(db, "root")
    await router22.put_chat_policy(body=ChatPolicyUpdate(admin_channel_privileges=True, owner_manage_messages=True),
                                   user=root, db=db)
    priv = await service.create_channel(db, "secret", "private", "alice", member_ids=["bob"])
    m = await db.get(Message, (await service.create_message(db, priv.id, "bob", "x"))["id"])
    for who in ("root", "alice", "bob", "carol"):
        user = await u(db, who)
        for action in P.ACTIONS:
            if action == "mention.everyone" and who == "carol":
                continue   # 비멤버 @everyone 은 정책과 무관한 기존 차이(예전 'always') — 권한 매트릭스 범위 밖
            await P.allowed(db, user, action, priv.id, message=m)
    assert P.SHADOW_STATS["mismatch"] == 0 and P.SHADOW_STATS["error"] == 0


# ─── 보관 시스템 카테고리 ───

@pytest.mark.asyncio
async def test_archive_system_category(db, events):
    from app.chat.schemas import ChannelUpdate  # noqa: F401
    root = await u(db, "root")
    db.add(ChatCategory(id="c-ch", name="채널", position=0))
    db.add(ChatCategory(id="c-arc", name="보관", position=2))
    await db.commit()
    meta = await router22.layout_meta(user=root, db=db)
    assert meta["archive_category_id"] == "c-arc"
    assert (await db.get(ChatCategory, "c-arc")).name == "보관된 프로젝트"
    assert (await router22.layout_meta(user=root, db=db))["archive_category_id"] == "c-arc"   # 한 번만
    cats = {c["id"]: c for c in (await chat_roles.list_categories(user=root, db=db))["items"]}
    assert cats["c-arc"]["system"] is True and cats["c-ch"]["system"] is False
    with pytest.raises(HTTPException) as e:
        await chat_roles.delete_category(category_id="c-arc", user=root, db=db)
    assert e.value.status_code == 400 and e.value.detail["code"] == "system_category"
    # 이름은 바꿀 수 있고 순서는 고정
    body = chat_roles.CategoryPatch(name="옛 프로젝트", position=0)
    out = await chat_roles.update_category(category_id="c-arc", body=body, user=root, db=db)
    assert out["name"] == "옛 프로젝트" and out["position"] == 2 and out["system"] is True
    lay = chat_roles.LayoutBody(categories=[{"id": "c-arc", "position": 0}, {"id": "c-ch", "position": 5}], channels=[])
    await chat_roles.update_layout(body=lay, user=root, db=db)
    assert (await db.get(ChatCategory, "c-arc")).position == 2 and (await db.get(ChatCategory, "c-ch")).position == 5
    # 보관해도 채널의 카테고리는 옮기지 않는다
    ch = await service.create_channel(db, "proj", "public", "alice")
    ch.category_id = "c-ch"
    await db.commit()
    await service.update_channel(db, ch.id, is_archived=True)
    assert (await service.get_channel(db, ch.id)).category_id == "c-ch"


@pytest.mark.asyncio
async def test_archive_category_created_when_missing(db, events):
    root = await u(db, "root")
    cid = (await router22.layout_meta(user=root, db=db))["archive_category_id"]
    c = await db.get(ChatCategory, cid)
    assert c is not None and c.name == "보관된 프로젝트"
