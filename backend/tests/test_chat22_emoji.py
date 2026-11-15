"""chat22 — 커스텀 이모지 CRUD·검증·128px 축소·권한(MANAGE_EXPRESSIONS)·`:name:` 리액션·reactions.emoji 64."""

import io

import pytest
from fastapi import HTTPException, UploadFile
from pydantic import ValidationError

from app.chat import permissions as P
from app.chat import router as chat_router
from app.chat import router22, service
from app.chat.schemas import EmojiRename, ReactionToggle
from app.db.models import ChatMemberRole, ChatRole
from tests.chat22_fixtures import db, events, u  # noqa: F401


def _img(fmt="PNG", w=300, h=200, frames=1) -> bytes:
    from PIL import Image
    b = io.BytesIO()
    if frames > 1:
        ims = [Image.new("RGB", (w, h), (i * 40, 0, 0)) for i in range(frames)]
        ims[0].save(b, fmt, save_all=True, append_images=ims[1:], duration=100)
    else:
        Image.new("RGB", (w, h), (0, 120, 0)).save(b, fmt)
    return b.getvalue()


def _f(data: bytes, name="e.png") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=name)


@pytest.mark.asyncio
async def test_crud_resize_and_permission(db, events):
    alice, root = await u(db, "alice"), await u(db, "root")
    with pytest.raises(HTTPException) as e:
        await router22.create_emoji(file=_f(_img()), name="party", user=alice, db=db)
    assert e.value.status_code == 403 and e.value.detail["code"] == "forbidden"
    item = await router22.create_emoji(file=_f(_img()), name="Party", user=root, db=db)
    assert item["name"] == "party" and item["animated"] is False and item["url"].startswith("/api/chat/emojis/")
    assert item["created_by"]["id"] == "root"
    resp = await router22.emoji_image(emoji_id=item["id"], user=alice, db=db)
    from PIL import Image
    im = Image.open(io.BytesIO(resp.body))
    assert max(im.size) == 128 and resp.media_type == "image/png"
    assert "immutable" in resp.headers["cache-control"] and resp.headers["x-content-type-options"] == "nosniff"
    gif = await router22.create_emoji(file=_f(_img("GIF", 200, 200, frames=3), "a.gif"), name="spin", user=root, db=db)
    assert gif["animated"] is True
    lst = await router22.list_emojis(user=alice, db=db)
    assert [x["name"] for x in lst["items"]] == ["party", "spin"] and lst["can_manage"] is False and lst["limit"] == 200
    assert (await router22.list_emojis(user=root, db=db))["can_manage"] is True
    ren = await router22.rename_emoji(emoji_id=item["id"], body=EmojiRename(name="yay"), user=root, db=db)
    assert ren["name"] == "yay"
    assert (await router22.delete_emoji(emoji_id=gif["id"], user=root, db=db))["ok"] is True
    assert any(ev["type"] == "emoji_update" for ev in events["all"])
    # 역할로 MANAGE_EXPRESSIONS 를 받으면 일반 사용자도 된다
    role = ChatRole(id="r-exp", name="이모지 담당", position=1, permissions=P.MANAGE_EXPRESSIONS)
    db.add(role)
    db.add(ChatMemberRole(user_id="alice", role_id="r-exp"))
    await db.commit()
    ok = await router22.create_emoji(file=_f(_img(w=64, h=64)), name="ok_hand2", user=alice, db=db)
    assert ok["name"] == "ok_hand2"


@pytest.mark.asyncio
async def test_validation_errors(db, events, monkeypatch):
    root = await u(db, "root")

    async def _code(name, data, fname="e.png"):
        with pytest.raises(HTTPException) as e:
            await router22.create_emoji(file=_f(data, fname), name=name, user=root, db=db)
        return e.value.status_code, e.value.detail["code"]

    assert await _code("a", _img()) == (400, "name_invalid")
    assert await _code("한글", _img()) == (400, "name_invalid")
    assert await _code("ok", b"not an image") == (400, "bad_type")
    assert await _code("ok", _img("BMP"), "x.bmp") == (400, "bad_type")
    assert await _code("ok", b"\x89PNG" + b"0" * (256 * 1024 + 10)) == (413, "too_large")
    await router22.create_emoji(file=_f(_img()), name="dup", user=root, db=db)
    assert await _code("dup", _img()) == (409, "name_taken")
    from app.chat import emoji22
    monkeypatch.setattr(emoji22, "MAX_EMOJIS", 1)
    assert await _code("more", _img()) == (400, "limit_reached")


@pytest.mark.asyncio
async def test_custom_reaction(db, events):
    root = await u(db, "root")
    await router22.create_emoji(file=_f(_img()), name="this_is_a_long_emoji_name_32char", user=root, db=db)
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    m = await service.create_message(db, ch.id, "alice", "hi")
    bob = await u(db, "bob")
    res = await chat_router.toggle_reaction(message_id=m["id"], body=ReactionToggle(emoji=":this_is_a_long_emoji_name_32char:"),
                                            user=bob, db=db)
    assert res["action"] == "added" and res["reactions"][0]["emoji"] == ":this_is_a_long_emoji_name_32char:"
    with pytest.raises(HTTPException) as e:
        await chat_router.toggle_reaction(message_id=m["id"], body=ReactionToggle(emoji=":nope:"), user=bob, db=db)
    assert e.value.detail["code"] == "emoji_not_found"
    res = await chat_router.toggle_reaction(message_id=m["id"], body=ReactionToggle(emoji="👍"), user=bob, db=db)
    assert {r["emoji"] for r in res["reactions"]} == {"👍", ":this_is_a_long_emoji_name_32char:"}
    with pytest.raises(ValidationError):
        ReactionToggle(emoji="x" * 65)
