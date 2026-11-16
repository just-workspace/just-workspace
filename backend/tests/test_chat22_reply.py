"""chat22 — 인라인 답장(reply_to 4상태·reply_ping 알림)·@silent·원문 점프(around)·has_more_after."""

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.chat import router as chat_router
from app.chat import service
from app.chat.schemas import MessageCreate
from app.db.models import ChatMention, Message, Notification
from tests.chat22_fixtures import db, events, flush_tasks, u  # noqa: F401


async def _post(db, cid, uid, content, **kw):
    out = await chat_router.send_message(channel_id=cid, body=MessageCreate(content=content, **kw),
                                         user=await u(db, uid), db=db)
    await flush_tasks()
    return out


async def _list(db, cid, uid, **kw):
    args = dict(before=None, after=None, before_seq=None, after_seq=None, around=None, limit=50)
    args.update(kw)
    return await chat_router.list_messages(channel_id=cid, user=await u(db, uid), db=db, **args)


@pytest.mark.asyncio
async def test_reply_summary_and_ping(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob", "carol"])
    root = await _post(db, ch.id, "alice", "배포 일정 공유합니다 " + "가" * 300)
    r = await _post(db, ch.id, "bob", "확인했어요", reply_to_id=root["id"])
    assert r["reply_to_id"] == root["id"] and r["reply_ping"] is True and r["silent"] is False
    rt = r["reply_to"]
    assert rt["state"] == "ok" and rt["sender"]["id"] == "alice"
    assert len(rt["content"]) == 200 and rt["has_attachment"] is False and rt["attachment_kind"] is None
    # 원문 작성자에게 멘션 행 + 알림
    m = (await db.execute(select(ChatMention).where(ChatMention.user_id == "alice"))).scalars().all()
    assert [x.message_id for x in m] == [r["id"]]
    n = (await db.execute(select(Notification).where(Notification.user_id == "alice"))).scalars().all()
    assert len(n) == 1 and "답장" in n[0].title
    # 목록에서도 동일한 요약(일괄 조회)
    page = await _list(db, ch.id, "carol")
    by_id = {x["id"]: x for x in page["messages"]}
    assert by_id[r["id"]]["reply_to"]["state"] == "ok"
    assert by_id[root["id"]]["reply_to"] is None
    assert page["has_more_after"] is False


@pytest.mark.asyncio
async def test_reply_ping_off_self_and_silent(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    root = await _post(db, ch.id, "alice", "질문")
    await _post(db, ch.id, "bob", "답(알림 끔)", reply_to_id=root["id"], reply_ping=False)
    await _post(db, ch.id, "alice", "내 글에 답", reply_to_id=root["id"])
    assert (await db.execute(select(ChatMention))).scalars().all() == []
    # @silent 머리말 — 제거 후 silent 처리. 멘션 행(배지)은 유지되고 알림·푸시는 없음
    s = await _post(db, ch.id, "bob", "@silent 조용히 @alice", reply_to_id=root["id"])
    assert s["silent"] is True and s["content"] == "조용히 @alice"
    rows = (await db.execute(select(ChatMention).where(ChatMention.user_id == "alice"))).scalars().all()
    assert len(rows) == 1
    assert (await db.execute(select(Notification))).scalars().all() == []
    assert events["push"] == []
    # 배지 갱신 이벤트는 발송됨
    assert any(ev.get("type") == "mention_count" for uid, ev in events["user"] if uid == "alice")


@pytest.mark.asyncio
async def test_reply_validation(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    other = await service.create_channel(db, "other", "public", "alice", member_ids=["bob"])
    x = await _post(db, other.id, "alice", "다른 채널")
    with pytest.raises(HTTPException) as e:
        await _post(db, ch.id, "bob", "답", reply_to_id=x["id"])
    assert e.value.status_code == 400 and e.value.detail["code"] == "reply_not_found"
    root = await _post(db, ch.id, "alice", "루트")
    t = await _post(db, ch.id, "bob", "스레드 답글", parent_id=root["id"])
    with pytest.raises(HTTPException) as e:
        await _post(db, ch.id, "alice", "메인에서 스레드 글에 답", reply_to_id=t["id"])
    assert e.value.detail["code"] == "reply_other_thread"
    ok = await _post(db, ch.id, "alice", "스레드 안에서 답", parent_id=root["id"], reply_to_id=t["id"])
    assert ok["reply_to"]["state"] == "ok"
    with pytest.raises(HTTPException):
        await _post(db, ch.id, "bob", "@silent ")


@pytest.mark.asyncio
async def test_reply_states_deleted_unavailable(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    a = await _post(db, ch.id, "alice", "곧 지움")
    r1 = await _post(db, ch.id, "bob", "답1", reply_to_id=a["id"])
    await service.soft_delete_message(db, a["id"])
    r2 = await _post(db, ch.id, "bob", "답2")
    m2 = await db.get(Message, r2["id"])
    m2.reply_to_id = "no-such-message"
    await db.commit()
    page = await _list(db, ch.id, "bob")
    by_id = {x["id"]: x for x in page["messages"]}
    assert by_id[r1["id"]]["reply_to"]["state"] == "deleted"
    assert by_id[r1["id"]]["reply_to"]["sender"] is None
    assert by_id[r2["id"]]["reply_to"]["state"] == "unavailable"


@pytest.mark.asyncio
async def test_around_jump_and_thread_target(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    ids = [(await _post(db, ch.id, "alice", f"m{i}"))["id"] for i in range(30)]
    res = await _list(db, ch.id, "bob", around=ids[10], limit=10)
    got = [m["content"] for m in res["messages"]]
    assert "m10" in got and len(got) == 10
    assert got.index("m10") == 5            # 위 반 · 아래 반(원문 포함)
    assert res["has_more"] is True and res["has_more_after"] is True
    # 스레드 내 답글이면 메인에는 없음 → thread_root_id
    t = await _post(db, ch.id, "bob", "스레드", parent_id=ids[0])
    res = await _list(db, ch.id, "bob", around=t["id"], limit=10)
    assert res["messages"] == [] and res["thread_root_id"] == ids[0]
    with pytest.raises(HTTPException) as e:
        await _list(db, ch.id, "bob", around="nope", limit=10)
    assert e.value.status_code == 404
    # 위쪽 페이지(before) 를 조회하면 최근 쪽에 추가 항목이 존재
    page = await _list(db, ch.id, "bob", before=ids[20], limit=5)
    assert page["has_more_after"] is True


@pytest.mark.asyncio
async def test_ws_path_uses_same_rules(db, events, monkeypatch):
    """WS send_message 도 동일한 검사·필드 — create_message 에 reply_to_id·flags 가 전달되는지 확인(직접 호출)."""
    from app.chat import msg22
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    root = await _post(db, ch.id, "alice", "루트")
    content, silent = msg22.split_silent("@silent 안녕")
    await msg22.validate_reply(db, ch.id, None, root["id"])
    msg = await service.create_message(db, ch.id, "bob", content, reply_to_id=root["id"],
                                       flags=msg22.make_flags(silent=silent, reply_ping=True))
    assert msg["silent"] is True and msg["reply_ping"] is True and msg["reply_to"]["state"] == "ok"
