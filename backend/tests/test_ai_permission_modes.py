"""내장 AI 권한 모드 — Claude Code 와 동일한 이름(default·acceptEdits·plan·auto·bypassPermissions)."""

import pytest

from app.db.models import McpWriteRequest
from app.mcp import writes
from app.mcp.server import execute_tool
from tests.test_mcp_s3_writes import LOG, _ctx, env  # noqa: F401 (픽스처 재사용)
from tests.test_settings_security_p8 import db  # noqa: F401

RW = frozenset({"mcp:read", "mcp:write"})


async def _call(tool, args, user, source="ai"):
    t = _ctx(source)
    try:
        return await execute_tool(tool, args, user, scopes=RW)
    finally:
        writes.call_context.reset(t)


async def _mode(env, m):
    await writes.set_permission_mode(env["db"], "alice", m)


async def test_default_mode_unchanged(env):
    assert await writes.get_permission_mode(env["db"], "alice") == "default"
    r = await _call("t_low", {"title": "a"}, env["alice"])
    assert r["result"]["status"] == "pending_confirmation" and LOG == []


async def test_accept_edits_runs_low_asks_high(env):
    await _mode(env, "acceptEdits")
    r = await _call("t_low", {"title": "a"}, env["alice"])
    assert r["result"]["status"] == "executed" and LOG == [("create", "a")]
    r = await _call("t_high", {"to": "x@y"}, env["alice"])
    assert r["result"]["status"] == "pending_approval" and LOG == [("create", "a")]


async def test_auto_runs_high_unless_external_read(env):
    await _mode(env, "auto")
    r = await _call("t_high", {"to": "x@y"}, env["alice"])
    assert r["result"]["status"] == "executed"
    env["marks"][("alice", "k1")] = {"kind": "mail", "from": "evil@x"}
    r = await _call("t_high", {"to": "z@y"}, env["alice"])
    assert r["result"]["status"] == "pending_approval"
    r = await _call("t_low", {"title": "b"}, env["alice"])     # low 는 외부 읽기 이후에도 자동 실행
    assert r["result"]["status"] == "executed"
    assert LOG == [("send", "x@y"), ("create", "b")]


async def test_bypass_runs_everything(env):
    await _mode(env, "bypassPermissions")
    env["marks"][("alice", "k1")] = {"kind": "mail", "from": "evil@x"}
    r = await _call("t_high", {"to": "x@y"}, env["alice"])
    assert r["result"]["status"] == "executed" and LOG == [("send", "x@y")]


async def test_mode_only_applies_to_builtin_ai(env):
    await _mode(env, "bypassPermissions")
    r = await _call("t_high", {"to": "x@y"}, env["alice"], source="mcp")
    assert r["result"]["status"] == "pending_approval" and LOG == []


async def test_mode_is_per_user_and_validated(env):
    await _mode(env, "auto")
    assert await writes.get_permission_mode(env["db"], "bob") == "default"
    with pytest.raises(writes.WriteError):
        await writes.set_permission_mode(env["db"], "alice", "yolo")


async def test_approve_all_runs_pending_low_cards(env):
    t = writes.call_context.set(writes.CallContext(source="ai", client_key="c1", conversation_id="c1"))
    try:
        for x in ("a", "b", "c"):
            await execute_tool("t_low", {"title": x}, env["alice"], scopes=RW)
        await execute_tool("t_high", {"to": "x@y"}, env["alice"], scopes=RW)
    finally:
        writes.call_context.reset(t)
    done = await writes.batch_decide(env["db"], env["alice"], "c1")
    assert [d.status for d in done] == ["executed"] * 3
    assert LOG == [("create", "a"), ("create", "b"), ("create", "c")]   # high 는 대기함에 유지된다
    left = [r for r in (await env["db"].execute(
        __import__("sqlalchemy").select(McpWriteRequest).where(McpWriteRequest.status == "pending"))).scalars()]
    assert [r.tool for r in left] == ["t_high"]


async def test_batch_selected_only_and_cancel(env):
    t = writes.call_context.set(writes.CallContext(source="ai", client_key="c2", conversation_id="c2"))
    try:
        ids = [(await execute_tool("t_low", {"title": x}, env["alice"], scopes=RW))["result"]["request_id"]
               for x in ("a", "b", "c")]
    finally:
        writes.call_context.reset(t)
    done = await writes.batch_decide(env["db"], env["alice"], "c2", [ids[0], ids[2]])
    assert [d.id for d in done] == [ids[0], ids[2]] and LOG == [("create", "a"), ("create", "c")]
    gone = await writes.batch_decide(env["db"], env["alice"], "c2", None, action="cancel")
    assert [g.status for g in gone] == ["canceled"] and LOG == [("create", "a"), ("create", "c")]
    # 타인의 요청은 처리할 수 없다
    assert await writes.batch_decide(env["db"], env["bob"], "c2", ids) == []


# ── 허용·거부 규칙(Claude Code permissions.allow/deny) ─────────
@pytest.fixture()
def no_redis(monkeypatch):
    async def _no():
        raise RuntimeError("no redis")
    import app.chat.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", _no)
    writes._local_conv_rules.clear()


async def _call_conv(tool, args, user, conv="c1"):
    t = writes.call_context.set(writes.CallContext(source="ai", client_name="내장 AI", client_kind="builtin_web",
                                                   client_key=conv, conversation_id=conv))
    try:
        return await execute_tool(tool, args, user, scopes=RW)
    finally:
        writes.call_context.reset(t)


async def test_deny_rule_blocks_without_request(env, no_redis):
    await writes.set_rules(env["db"], "alice", {"deny": ["t_low"]})
    r = await _call("t_low", {"title": "a"}, env["alice"])
    assert "denied_by_rule" in str(r) and r.get("ok") is not True
    assert LOG == []


async def test_always_allow_runs_without_card_but_high_after_external_read_still_asks(env, no_redis):
    await writes.set_rules(env["db"], "alice", {"allow": ["t_low", "t_high"]})
    r = await _call("t_low", {"title": "a"}, env["alice"])
    assert r["result"]["status"] == "executed"
    env["marks"][("alice", "k1")] = {"kind": "mail", "from": "evil@x"}
    r = await _call("t_high", {"to": "x@y"}, env["alice"])
    assert r["result"]["status"] == "pending_approval"
    assert LOG == [("create", "a")]


async def test_rules_validate_and_deny_wins(env, no_redis):
    with pytest.raises(writes.WriteError):
        await writes.set_rules(env["db"], "alice", {"allow": ["nope"]})
    out = await writes.set_rules(env["db"], "alice", {"allow": ["t_low"], "deny": ["t_low"]})
    assert out == {"allow": [], "deny": ["t_low"]}
    assert await writes.get_rules(env["db"], "bob") == {"allow": [], "deny": []}


async def test_remember_conversation_allows_same_tool_in_that_conversation_only(env, no_redis):
    r1 = await _call_conv("t_low", {"title": "a"}, env["alice"])
    r2 = await _call_conv("t_low", {"title": "b"}, env["alice"])
    assert r1["result"]["status"] == r2["result"]["status"] == "pending_confirmation"
    req = await writes.approve(env["db"], env["alice"], r1["result"]["request_id"])
    await writes.remember_approval(env["db"], env["alice"], req, "conversation")
    # 동일 대화에 대기 중이던 동일 도구 카드도 함께 실행
    other = await env["db"].get(McpWriteRequest, r2["result"]["request_id"])
    assert other.status == "executed"
    r3 = await _call_conv("t_low", {"title": "c"}, env["alice"])
    assert r3["result"]["status"] == "executed"
    r4 = await _call_conv("t_low", {"title": "d"}, env["alice"], conv="c2")   # 다른 대화에서는 재확인한다
    assert r4["result"]["status"] == "pending_confirmation"
    assert await writes.conv_allowed("alice", "c1") == ["t_low"]


async def test_remember_always_persists_rule(env, no_redis):
    r = await _call("t_low", {"title": "a"}, env["alice"])
    req = await writes.approve(env["db"], env["alice"], r["result"]["request_id"])
    await writes.remember_approval(env["db"], env["alice"], req, "always")
    assert (await writes.get_rules(env["db"], "alice"))["allow"] == ["t_low"]


async def test_reject_reason_becomes_instruction(env, no_redis):
    r = await _call_conv("t_low", {"title": "a"}, env["alice"])
    req = await writes.reject(env["db"], env["alice"], r["result"]["request_id"], "제목을 b로 바꿔서 해")
    v = writes.decision_view(req)
    assert v["status"] == "rejected" and v["user_instruction"] == "제목을 b로 바꿔서 해"
    assert "다시 계획" in v["message"]
