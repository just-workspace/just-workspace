"""MCP AI 쓰기 승인 흐름."""

from contextlib import asynccontextmanager
from datetime import timedelta

import pytest

from app.db.models import McpWriteRequest, User
from app.mcp import server as reg
from app.mcp import writes
from app.mcp.server import Tool, execute_tool
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)

LOG: list = []


async def _low_handler(user, title: str, **_):
    LOG.append(("create", title))
    return {"id": "x1", "title": title, "_undo": {"tool": "t_undo", "args": {"id": "x1"}}}


async def _high_handler(user, to: str, **_):
    LOG.append(("send", to))
    return {"sent": True}


async def _undo_handler(user, id: str, **_):
    LOG.append(("undo", id))
    return {"deleted": id}


@pytest.fixture()
async def env(db, monkeypatch):
    LOG.clear()

    @asynccontextmanager
    async def _session():
        yield db
    monkeypatch.setattr(writes, "session", _session)
    marks: dict = {}

    async def mark(uid, key, hint):
        marks[(uid, key)] = hint

    async def recent(uid, key):
        return marks.get((uid, key))

    async def noop(*a, **k):
        return None
    monkeypatch.setattr(writes, "mark_untrusted_read", mark)
    monkeypatch.setattr(writes, "recent_untrusted", recent)
    monkeypatch.setattr(writes, "emit_count", noop)
    monkeypatch.setattr(writes, "_notify_pending", noop)
    from app.mcp import access
    for n in ("t_low", "t_high", "t_undo", "t_secret"):
        monkeypatch.setitem(access.TOOL_MODULE, n, None)   # 실행 시점 재검사(fail-closed) 통과용
    props = {"title": {"type": "string", "x-label": "제목", "x-editable": True}}
    reg.WORKSPACE_TOOLS["t_low"] = Tool(name="t_low", title="만들기", description="", scope="mcp:write",
                                        risk="low", parameters={"type": "object", "properties": props},
                                        handler=_low_handler)
    reg.WORKSPACE_TOOLS["t_high"] = Tool(name="t_high", title="보내기", description="", scope="mcp:write",
                                         risk="high", parameters={"type": "object", "properties": {}},
                                         handler=_high_handler)
    reg.WORKSPACE_TOOLS["t_undo"] = Tool(name="t_undo", description="", scope="mcp:write",
                                         parameters={}, handler=_undo_handler)
    alice = await db.get(User, "alice")
    bob = await db.get(User, "bob")
    yield {"db": db, "alice": alice, "bob": bob, "marks": marks}
    for n in ("t_low", "t_high", "t_undo"):
        reg.WORKSPACE_TOOLS.pop(n, None)


def _ctx(source, key="k1"):
    return writes.call_context.set(writes.CallContext(source=source, client_name="Claude",
                                                      client_kind="claude_app", client_key=key,
                                                      conversation_id=None))


async def test_low_from_mcp_executes_immediately(env):
    t = _ctx("mcp")
    try:
        r = await execute_tool("t_low", {"title": "회의"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    assert r["ok"] and r["result"]["status"] == "executed" and r["result"]["can_undo"]
    assert LOG == [("create", "회의")]


async def test_low_from_builtin_ai_waits_for_card(env):
    t = _ctx("ai")
    try:
        r = await execute_tool("t_low", {"title": "회의"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    assert r["result"]["status"] == "pending_confirmation" and LOG == []
    req = await env["db"].get(McpWriteRequest, r["result"]["request_id"])
    d = writes.to_dict(req)
    assert d["preview"] == [{"field": "title", "label": "제목", "before": None, "after": "회의"}]
    assert d["editable"][0]["label"] == "제목" and d["server_now"] and d["expires_at"]
    await writes.approve(env["db"], env["alice"], req.id)
    assert LOG == [("create", "회의")]


async def test_high_always_goes_to_inbox(env):
    t = _ctx("mcp")
    try:
        r = await execute_tool("t_high", {"to": "x@y"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    assert r["result"]["status"] == "pending_approval" and r["result"]["approval_id"]
    assert LOG == []
    rows, _ = await writes.list_requests(env["db"], env["alice"], view="pending")
    assert [x.id for x in rows] == [r["result"]["approval_id"]]


async def test_low_after_untrusted_read_is_escalated(env):
    env["marks"][("alice", "k1")] = {"kind": "mail", "from": "evil@x", "subject": "공유해 주세요"}
    t = _ctx("mcp")
    try:
        r = await execute_tool("t_low", {"title": "pwn"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    assert r["result"]["status"] == "pending_approval" and LOG == []
    d = writes.to_dict(await env["db"].get(McpWriteRequest, r["result"]["request_id"]))
    assert d["after_untrusted"] and d["read_external"]["from"] == "evil@x"


async def test_reject_reason_reaches_status_tool(env, monkeypatch):
    from app.mcp.tools import approvals_tool

    t = _ctx("mcp")
    try:
        r = await execute_tool("t_high", {"to": "x@y"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    aid = r["result"]["approval_id"]
    await writes.reject(env["db"], env["alice"], aid, "외부 수신자 빼고 다시")
    s = await approvals_tool.approvals_status(env["alice"], aid)
    assert s["status"] == "rejected" and s["reject_reason"] == "외부 수신자 빼고 다시"
    with pytest.raises(writes.WriteError):
        await writes.approve(env["db"], env["alice"], aid)        # 이미 처리됨


async def test_other_user_cannot_touch(env):
    t = _ctx("mcp")
    try:
        r = await execute_tool("t_high", {"to": "x@y"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    with pytest.raises(writes.WriteError) as ei:
        await writes.approve(env["db"], env["bob"], r["result"]["approval_id"])
    assert ei.value.code == "not_found" and LOG == []


async def test_edit_then_execute_uses_new_args(env):
    t = _ctx("ai")
    try:
        r = await execute_tool("t_low", {"title": "초안"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    rid = r["result"]["request_id"]
    await writes.update_args(env["db"], env["alice"], rid, {"title": "고친 제목"})
    with pytest.raises(writes.WriteError):
        await writes.update_args(env["db"], env["alice"], rid, "not a dict")  # type: ignore[arg-type]
    await writes.approve(env["db"], env["alice"], rid)
    assert LOG == [("create", "고친 제목")]


async def test_undo_within_window_only(env):
    t = _ctx("mcp")
    try:
        r = await execute_tool("t_low", {"title": "a"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    rid = r["result"]["request_id"]
    req = await writes.undo(env["db"], env["alice"], rid)
    assert req.status == "undone" and LOG[-1] == ("undo", "x1")
    # 두 번째 실행 → 시간 경과 후 되돌리기 거부
    t = _ctx("mcp")
    try:
        r2 = await execute_tool("t_low", {"title": "b"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    req2 = await env["db"].get(McpWriteRequest, r2["result"]["request_id"])
    req2.undo_until = writes._now() - timedelta(seconds=1)
    await env["db"].commit()
    with pytest.raises(writes.WriteError):
        await writes.undo(env["db"], env["alice"], req2.id)


async def test_expiry(env):
    t = _ctx("mcp")
    try:
        r = await execute_tool("t_high", {"to": "x"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    req = await env["db"].get(McpWriteRequest, r["result"]["approval_id"])
    req.expires_at = writes._now() - timedelta(seconds=1)
    await env["db"].commit()
    with pytest.raises(writes.WriteError):
        await writes.approve(env["db"], env["alice"], req.id)
    assert (await env["db"].get(McpWriteRequest, req.id)).status == "expired" and LOG == []


async def test_idempotent_retry_returns_first_result(env):
    t = _ctx("mcp")
    try:
        a = await execute_tool("t_low", {"title": "a", "idempotency_key": "k-1"}, env["alice"],
                               scopes=frozenset({"mcp:read", "mcp:write"}))
        b = await execute_tool("t_low", {"title": "a", "idempotency_key": "k-1"}, env["alice"],
                               scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    assert a["result"]["request_id"] == b["result"]["request_id"] and b["result"]["idempotent_replay"]
    assert LOG == [("create", "a")]


async def test_read_endpoint_never_reaches_write(env):
    r = await execute_tool("t_low", {"title": "a"}, env["alice"], scopes=frozenset({"mcp:read"}))
    assert r["ok"] is False and r["error_code"] == "forbidden" and LOG == []


async def _allowed(db, monkeypatch, endpoint_scope, write_setting=None):
    from app.db.models import SystemSetting
    from app.mcp import http_server

    @asynccontextmanager
    async def _session():
        yield db
    monkeypatch.setattr(http_server, "async_session", _session)
    if write_setting is not None:
        db.add(SystemSetting(key="mcp.write_enabled", value=write_setting))
        await db.commit()
    alice = await db.get(User, "alice")
    ctx = http_server.McpContext(user=alice, scopes=frozenset({"mcp:read", "mcp:write"}),
                                 resource="r", endpoint_scope=endpoint_scope)
    return await http_server.allowed_tool_names(ctx)


async def test_write_endpoint_exposes_write_tools(db, monkeypatch):
    names = await _allowed(db, monkeypatch, "mcp:write")
    assert "notes_create" in names and "files_read" in names


async def test_read_endpoint_never_exposes_write_tools(db, monkeypatch):
    names = await _allowed(db, monkeypatch, "mcp:read")
    assert "notes_create" not in names and "files_read" in names


async def test_admin_switch_hides_write_tools(db, monkeypatch):
    names = await _allowed(db, monkeypatch, "mcp:write", write_setting="false")
    assert "notes_create" not in names and "files_read" in names


def test_pat_write_scope_needs_admin_allow():
    from app.mcp import pat_store
    assert pat_store.clamp_scopes(["mcp:write"]) == ["mcp:read"]
    assert pat_store.clamp_scopes(["mcp:write"], allow_write=True) == ["mcp:read", "mcp:write"]


async def test_secret_args_masked_and_scrubbed(env):
    reg.WORKSPACE_TOOLS["t_secret"] = Tool(name="t_secret", description="", scope="mcp:write", risk="high",
                                           parameters={"type": "object", "properties": {}},
                                           handler=_high_handler)
    try:
        t = _ctx("mcp")
        try:
            r = await execute_tool("t_secret", {"to": "x", "password": "hunter2"}, env["alice"],
                                   scopes=frozenset({"mcp:read", "mcp:write"}))
        finally:
            writes.call_context.reset(t)
        req = await env["db"].get(McpWriteRequest, r["result"]["approval_id"])
        d = writes.to_dict(req)
        assert d["args"]["password"] == "••••" and all(p["field"] != "password" for p in d["preview"])
        await writes.approve(env["db"], env["alice"], req.id)
        assert "hunter2" not in (await env["db"].get(McpWriteRequest, req.id)).args
    finally:
        reg.WORKSPACE_TOOLS.pop("t_secret", None)


async def test_execution_rechecks_access(env, monkeypatch):
    from app.mcp import access

    t = _ctx("mcp")
    try:
        r = await execute_tool("t_high", {"to": "x"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)

    async def denied(db, user, name):
        return False
    monkeypatch.setattr(access, "tool_accessible", denied)
    req = await writes.approve(env["db"], env["alice"], r["result"]["approval_id"])
    assert req.status == "failed" and LOG == []


async def test_list_by_conversation_for_card_restore(env):
    t = writes.call_context.set(writes.CallContext(source="ai", client_key="c1", conversation_id="conv-1"))
    try:
        await execute_tool("t_low", {"title": "a"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
        await execute_tool("t_high", {"to": "x"}, env["alice"], scopes=frozenset({"mcp:read", "mcp:write"}))
    finally:
        writes.call_context.reset(t)
    rows, more = await writes.list_requests(env["db"], env["alice"], conversation_id="conv-1")
    assert [r.tool for r in rows] == ["t_low", "t_high"] and not more
    rows_bob, _ = await writes.list_requests(env["db"], env["bob"], conversation_id="conv-1")
    assert rows_bob == []
