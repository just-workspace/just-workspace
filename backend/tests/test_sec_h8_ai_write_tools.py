"""회귀 — 내장 AI 의 쓰기 도구는 사용자 권한 검사 + 사용자 확인 토큰 없이는 실행되지 않는다."""

import json

import pytest
from sqlalchemy import select

from app.ai import config as ai_config
from app.ai import router as ai_router
from app.ai import tool_confirm
from app.ai.models import AIConversation
from app.db.models import User, WikiPage, WikiSpace, WikiSpaceMember
from app.mcp.tools import notes_tool
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)


class _Redis:
    def __init__(self):
        self.kv = {}

    async def set(self, k, v, ex=None, nx=False):
        if nx and k in self.kv:
            return None
        self.kv[k] = v
        return True


@pytest.fixture()
async def env(db, monkeypatch):
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _session():
        yield db
    monkeypatch.setattr(notes_tool, "async_session", _session)
    r = _Redis()

    async def _get():
        return r
    monkeypatch.setattr(tool_confirm, "_redis", _get)
    from app.mcp import writes
    monkeypatch.setattr(writes, "session", _session)

    async def _no_mark(*a, **k):
        return None
    monkeypatch.setattr(writes, "recent_untrusted", _no_mark)
    monkeypatch.setattr(writes, "emit_count", _no_mark)
    monkeypatch.setattr(writes, "_notify_pending", _no_mark)

    team = WikiSpace(name="team", slug="team", owner_id="root", visibility="private")
    db.add(team)
    await db.commit()
    db.add(WikiSpaceMember(space_id=team.id, user_id="alice", role="reader"))
    db.add(WikiSpaceMember(space_id=team.id, user_id="bob", role="writer"))
    conv = AIConversation(user_id="alice", title="t")
    db.add(conv)
    await db.commit()
    return {"db": db, "space": team.id, "conv": conv.id}


async def _pages(db):
    return (await db.execute(select(WikiPage))).scalars().all()


async def test_model_call_does_not_execute_write_tool(env):
    alice = await env["db"].get(User, "alice")
    r = await ai_config.ai_execute_tool(env["db"], "notes_create",
                                        {"title": "x", "content": "y", "space": env["space"]},
                                        alice, provider_external=False)
    # 실행하지 않고 승인 요청(채팅 카드)만 만든다 — 모델에게는 "실행하지 않았다"가 간다
    assert r.get("needs_confirmation") and r["result"]["status"] == "pending_confirmation"
    assert await _pages(env["db"]) == []


async def test_reader_cannot_create_page_even_when_confirmed(env):
    alice = await env["db"].get(User, "alice")
    r = await ai_config.ai_execute_tool(env["db"], "notes_create",
                                        {"title": "x", "content": "y", "space": env["space"]},
                                        alice, provider_external=False, confirmed=True)
    assert "error" in (r.get("result") or {}) or not r["ok"]
    assert await _pages(env["db"]) == []


async def test_writer_confirmed_creates_page(env):
    bob = await env["db"].get(User, "bob")
    r = await ai_config.ai_execute_tool(env["db"], "notes_create", {"title": "x", "content": "y"},
                                        bob, provider_external=False, confirmed=True)
    assert r["ok"] and r["result"]["status"] == "executed"
    assert r["result"]["result"]["space_id"] == env["space"]
    assert len(await _pages(env["db"])) == 1


async def test_confirm_token_single_use_bound_to_user_and_args(env):
    tok = await tool_confirm.issue("alice", env["conv"], "notes_create", {"title": "a", "content": "b"})
    with pytest.raises(tool_confirm.ConfirmError):
        await tool_confirm.consume(tok, "bob")
    info = await tool_confirm.consume(tok, "alice")
    assert info["name"] == "notes_create" and info["args"]["title"] == "a"
    with pytest.raises(tool_confirm.ConfirmError):
        await tool_confirm.consume(tok, "alice")
    with pytest.raises(tool_confirm.ConfirmError):
        await tool_confirm.consume(tok[:-2] + "xx", "alice")


async def test_injected_tool_call_in_stream_is_held(env, monkeypatch):
    # 메일 본문 등으로 유도된 모델이 쓰기 도구를 부르는 상황 — 실행 대신 확인 이벤트만 나간다
    calls = {"n": 0}

    async def fake_stream(cfg, msgs, system=None, tools=None):
        calls["n"] += 1
        if calls["n"] == 1:
            yield {"type": "tool_call", "name": "notes_create",
                   "args": json.dumps({"title": "pwn", "content": "x", "space": env["space"]})}
        else:
            yield {"type": "text", "text": "ok"}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _session():
        yield env["db"]
    monkeypatch.setattr(ai_router, "async_session", _session)
    bob = await env["db"].get(User, "bob")
    out = []
    async for chunk in ai_router._chat_event_stream(env["conv"], bob, object(), False, None,
                                                    [{"function": {"name": "notes_create"}}], True,
                                                    [{"role": "user", "content": "요약해 줘"}]):
        out.append(chunk if isinstance(chunk, str) else chunk.decode())
        if "event: write_request" in out[-1]:
            break  # 선승인 — 여기서 사용자의 결정을 기다린다(실행되지 않은 채)
    text = "".join(out)
    # 확인 토큰 대신 승인 요청 카드 이벤트
    assert "write_request" in text
    assert await _pages(env["db"]) == []
