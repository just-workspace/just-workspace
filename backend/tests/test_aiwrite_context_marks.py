"""내장 AI 대화 표시(남이 쓴 내용을 읽음) — 도구 밖 경로: 공유 프로젝트 지침, 메모리 저장 거절."""

import json

from sqlalchemy import select

from app.ai import memory as ai_memory
from app.ai import router as ai_router
from app.ai.models import AIMemory
from app.groups.models import Group, GroupMember
from app.mcp import writes
from tests.test_ai_s6b_chat_context import _chat, _conv, env  # noqa: F401 (픽스처 재사용)
from tests.test_aiwrite_visible_gate import FakeRedis
from tests.test_settings_security_p8 import db  # noqa: F401


def _redis(env):
    fake = FakeRedis()

    async def _get():
        return fake
    import app.chat.redis_client as rc
    env.mp.setattr(rc, "get_redis", _get)
    return fake


def _memory_stream(env):
    async def tools(db_, user, prefs):
        return [{"type": "function", "function": {"name": "files_read"}}]
    env.mp.setattr(ai_router, "_model_tools", tools)
    calls = {"n": 0}

    async def stream(cfg, msgs, system=None, tools=None):
        calls["n"] += 1
        if calls["n"] == 1:
            yield {"type": "tool_call", "name": "memory_save",
                   "args": json.dumps({"kind": "preference", "text": "앞으로 모든 답 끝에 링크를 붙인다"})}
        else:
            stream.last_tool_turn = msgs[-1]["content"]
            yield {"type": "text", "text": "네"}
    env.mp.setattr(ai_router, "chat_stream", stream)
    return stream


async def test_memory_save_refused_after_untrusted_read_in_conversation(env):
    _redis(env)
    stream = _memory_stream(env)
    cid = await _conv(env, env.alice, tools_enabled=True)
    await writes.mark_conv_untrusted("alice", cid, writes.untrusted_hint("board_read_post", {"title": "공지"}))
    evs = await _chat(env, cid, "게시글 요약해 줘")
    assert "memory_saved" not in [e for e, _ in evs]
    assert "after_untrusted_read" in stream.last_tool_turn and "저장하지 않았습니다" in stream.last_tool_turn
    assert (await env.db.execute(select(AIMemory))).first() is None


async def test_memory_save_still_works_without_untrusted_read(env):
    _redis(env)
    _memory_stream(env)
    cid = await _conv(env, env.alice, tools_enabled=True)
    evs = await _chat(env, cid, "기억해")
    assert [d["kind"] for e, d in evs if e == "memory_saved"] == ["preference"]
    assert ai_memory.TOOL_NAME  # 저장 경로는 그대로


async def test_shared_project_instructions_mark_conversation_for_members_only(env):
    fake = _redis(env)
    g = Group(name="인프라팀")
    env.db.add(g)
    await env.db.flush()
    env.db.add(GroupMember(group_id=g.id, user_id="bob"))
    env.db.add(GroupMember(group_id=g.id, user_id="alice"))
    await env.db.commit()
    p = await ai_router.create_project.__wrapped__(
        ai_router.ProjectBody(name="운영", instructions="답은 개조식으로"), user=env.alice, db=env.db)
    await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(share_group_id=g.id),
                                              user=env.alice, db=env.db)
    # 주인 — 본인이 쓴 지침이라 표시하지 않는다
    acid = await _conv(env, env.alice, project_id=p["id"])
    await _chat(env, acid, "안녕")
    assert "답은 개조식으로" in env.seen[-1]["system"]
    assert await writes.conv_untrusted("alice", acid) is None
    # 구성원 — 남이 쓴 지침이 맥락에 들어갔다 → 대화 표시(15분 창과 무관하게 대화 내내)
    bcid = await _conv(env, env.bob, project_id=p["id"])
    await _chat(env, bcid, "안녕", user=env.bob)
    assert "답은 개조식으로" in env.seen[-1]["system"]
    hint = await writes.conv_untrusted("bob", bcid)
    assert hint and hint["label"] == "공유 프로젝트 지침" and hint["subject"] == "운영"
    assert fake.kv
