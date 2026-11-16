"""chat22 — 채팅 서버 설정(GET/PUT /server-settings): 이름·설명·비 DM 채널 기본 알림 수준·권한·감사 로그."""

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.chat import permissions as P
from app.chat import router22, server22, service
from app.chat.schemas import ChatServerSettingsUpdate as Body
from app.db.models import AuditLog, ChatMemberRole, ChatRole
from tests.chat22_fixtures import db, events, u  # noqa: F401


@pytest.mark.asyncio
async def test_defaults_permissions_and_update(db, events):
    alice, root = await u(db, "alice"), await u(db, "root")
    got = await router22.get_server_settings(user=alice, db=db)
    assert got == {"name": None, "description": None, "default_notify_level": "mentions", "can_edit": False}
    with pytest.raises(HTTPException) as e:
        await router22.put_server_settings(body=Body(name="우리 회사"), user=alice, db=db)
    assert e.value.status_code == 403
    out = await router22.put_server_settings(body=Body(name=" 우리 회사 ", description="사내 채팅"), user=root, db=db)
    assert out == {"name": "우리 회사", "description": "사내 채팅", "default_notify_level": "mentions", "can_edit": True}
    out = await router22.put_server_settings(body=Body(description=None), user=root, db=db)
    assert out["description"] is None and out["name"] == "우리 회사"
    logs = {x.action for x in (await db.execute(select(AuditLog))).scalars()}
    assert {"chat.server.name", "chat.server.description"} <= logs
    assert any(ev["type"] == "chat_server_settings_changed" for ev in events["all"])
    # 워크스페이스 MANAGE_CHANNELS 역할이면 일반 사용자도 가능
    db.add(ChatRole(id="r-ch", name="운영", position=1, permissions=P.MANAGE_CHANNELS))
    db.add(ChatMemberRole(user_id="alice", role_id="r-ch"))
    await db.commit()
    assert (await router22.get_server_settings(user=alice, db=db))["can_edit"] is True


@pytest.mark.asyncio
async def test_default_notify_level_applies_to_null_rows(db, events):
    root = await u(db, "root")
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    dm = await service.get_or_create_dm(db, "alice", "bob")
    lst = {c["id"]: c for c in await service.get_user_channels(db, "bob")}
    assert lst[ch.id]["notify_level"] == "mentions" and lst[dm.id]["notify_level"] == "all"
    await router22.put_server_settings(body=Body(default_notify_level="all"), user=root, db=db)
    lst = {c["id"]: c for c in await service.get_user_channels(db, "bob")}
    assert lst[ch.id]["notify_level"] == "all" and lst[dm.id]["notify_level"] == "all"
    members = {m["user_id"]: m for m in await service.get_members_for_notify(db, ch.id)}
    assert members["bob"]["notify_level"] == "all"
    # 사용자가 명시한 값은 유지
    await service.update_channel_prefs(db, ch.id, "bob", notify_level="none")
    assert (await service.get_channel_prefs(db, ch.id, "bob"))["notify_level"] == "none"
    await router22.put_server_settings(body=Body(default_notify_level=None), user=root, db=db)
    assert server22.default_level() == "mentions"
    lst = {c["id"]: c for c in await service.get_user_channels(db, "alice")}
    assert lst[ch.id]["notify_level"] == "mentions"
    with pytest.raises(Exception):
        Body(default_notify_level="loud")
