"""MCP S2 — 개인정보 가리기·호출 한도·감사 기록·사용량."""

import json
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import select

from app.ai import pii
from app.db.models import AuditLog, User
from app.mcp import audit
from app.mcp import server as reg
from app.mcp.server import Tool, execute_tool
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)


# ── 개인정보 가리기 ────────────────────────────────────────────
@pytest.mark.parametrize("raw,expect", [
    ("주민번호 900101-1234567 입니다", "주민번호 [주민등록번호] 입니다"),
    ("연락처 010-1234-5678", "연락처 [전화번호]"),
    ("사무실 02-123-4567", "사무실 [전화번호]"),
    ("카드 4111-1111-1111-1111", "카드 [카드번호]"),
    ("계좌 110-123-456789 로", "계좌 [계좌번호] 로"),
])
def test_pii_masked(raw, expect):
    assert pii.mask_text(raw) == expect


@pytest.mark.parametrize("raw", [
    "2026-11-05 회의", "버전 1.2.3", "IP 192.168.10.20", "포트 8443", "hana.kim@example.com",
    "카드 1234-5678-9012-3456",   # Luhn 불일치 — 카드번호 아님
    "티켓 PRJ-0100",
])
def test_pii_not_overmasked(raw):
    assert pii.mask_text(raw) == raw


def test_mask_messages_multipart():
    out = pii.mask_messages([{"role": "user", "content": [{"type": "text", "text": "010-1111-2222"}, {"type": "image"}]}])
    assert out[0]["content"][0]["text"] == "[전화번호]" and out[0]["content"][1] == {"type": "image"}


# ── 호출 한도 · 감사 ───────────────────────────────────────────
async def _echo(user, q: str = "", **_):
    return {"q": q}


@pytest.fixture()
async def env(db, monkeypatch):
    @asynccontextmanager
    async def _session():
        yield db
    monkeypatch.setattr(audit, "session", _session)
    reg.WORKSPACE_TOOLS["t_echo"] = Tool(name="t_echo", description="", parameters={}, handler=_echo)
    yield {"db": db, "alice": await db.get(User, "alice")}
    reg.WORKSPACE_TOOLS.pop("t_echo", None)


async def test_rate_limited(env, monkeypatch):
    async def over(uid):
        return 17
    monkeypatch.setattr(audit, "check_rate", over)
    r = await execute_tool("t_echo", {}, env["alice"], scopes=frozenset({"mcp:read"}))
    assert r["ok"] is False and r["error_code"] == "rate_limited" and r["retryable"] and r["retry_after"] == 17


async def test_in_process_plugin_not_rate_limited(env, monkeypatch):
    async def over(uid):
        return 17
    monkeypatch.setattr(audit, "check_rate", over)
    r = await execute_tool("t_echo", {}, env["alice"], scopes=None)
    assert r["ok"] is True


async def test_audit_records_call_without_arg_values(env, monkeypatch):
    async def ok(uid):
        return None
    monkeypatch.setattr(audit, "check_rate", ok)
    await execute_tool("t_echo", {"q": "비밀 검색어"}, env["alice"], scopes=frozenset({"mcp:read"}))
    row = (await env["db"].execute(select(AuditLog).where(AuditLog.action == "ai_tool.call"))).scalars().one()
    d = json.loads(row.details)
    assert row.actor_id == "alice" and d["tool"] == "t_echo" and d["ok"] is True and d["args"] == ["q"]
    assert "비밀 검색어" not in row.details


async def test_usage_aggregates(env, monkeypatch):
    from app.mcp import usage_router

    async def ok(uid):
        return None
    monkeypatch.setattr(audit, "check_rate", ok)
    for _ in range(3):
        await execute_tool("t_echo", {}, env["alice"], scopes=frozenset({"mcp:read"}))
    await execute_tool("no_such_tool", {}, env["alice"], scopes=frozenset({"mcp:read"}))
    root = await env["db"].get(User, "root")
    out = await usage_router.ai_usage(days=7, admin=root, db=env["db"])
    assert out["totals"]["tool_calls"] == 4
    tools = {t["tool"]: t for t in out["tools"]}
    assert tools["t_echo"]["calls"] == 3 and tools["t_echo"]["success_rate"] == 1.0
    assert tools["no_such_tool"]["failures"] == 1
    assert out["users"][0]["user_id"] == "alice" and out["users"][0]["tool_calls"] == 4
    audit_out = await usage_router.ai_audit(limit=2, cursor="", user_id="", tool="", admin=root, db=env["db"])
    assert len(audit_out["items"]) == 2 and audit_out["has_more"]
