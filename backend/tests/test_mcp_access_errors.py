"""MCP 도구 접근 판정(fail-closed) · 오류 정규화 — S0/S1.

S0 사고: TOOL_MODULE 에 없는 도구가 "모듈 없음 = 항상 허용"으로 처리돼, mail_read·채팅·게시판·
캘린더·연락처·할일이 관리자가 모듈을 꺼도·RBAC 가 없어도 MCP 로 불렸다. 내장 AI 의 DATA_TOOLS
에도 같은 도구가 빠져 외부 AI 데이터 차단을 우회했다.
"""

import pytest

from app.mcp import access
from app.mcp import server as reg
from app.mcp.server import Tool, execute_tool


def test_every_registered_tool_is_mapped():
    """새 도구를 만들고 TOOL_MODULE 을 빠뜨리면 여기서 깨진다(그 도구는 노출도 안 된다)."""
    missing = sorted(set(reg.WORKSPACE_TOOLS) - set(access.TOOL_MODULE))
    assert not missing, f"TOOL_MODULE 에 없는 도구: {missing}"


@pytest.mark.parametrize("name,module", [
    ("mail_read", "mail"), ("chat_read_messages", "chat"), ("board_read_post", "board"),
    ("calendar_list_events", "calendar"), ("contacts_search", "contacts"), ("tasks_list", "tasks"),
])
def test_previously_ungated_tools_now_have_module(name, module):
    assert access.TOOL_MODULE[name] == module


def test_data_tool_is_fail_closed():
    for name in ("mail_read", "chat_read_messages", "board_read_post", "calendar_list_events",
                 "contacts_search", "tasks_list", "some_future_tool"):
        assert access.is_data_tool(name), name
    assert not access.is_data_tool("web_search")
    from app.ai import config as ai_config
    assert "mail_read" in ai_config.DATA_TOOLS          # 옛 `in` 호환
    assert "web_search" not in ai_config.DATA_TOOLS


async def test_unmapped_tool_is_hidden():
    assert await access.tool_accessible(None, None, "definitely_not_mapped") is False


async def test_module_less_tool_needs_no_user():
    assert await access.tool_accessible(None, None, "web_search") is True


async def test_module_tool_without_user_is_hidden():
    assert await access.tool_accessible(None, None, "mail_read") is False


# ── 오류 정규화 ───────────────────────────────────────────────
@pytest.fixture()
def temp_tools():
    added = []

    def add(name, handler):
        reg.WORKSPACE_TOOLS[name] = Tool(name=name, description="", parameters={},
                                         handler=handler, requires_user=False)
        added.append(name)

    yield add
    for n in added:
        reg.WORKSPACE_TOOLS.pop(n, None)


async def test_tool_error_dict_becomes_ok_false(temp_tools):
    async def h(**_):
        return {"error": "file not found: a.txt"}
    temp_tools("t_err", h)
    r = await execute_tool("t_err", {}, None)
    assert r["ok"] is False and r["error"] == "file not found: a.txt"
    assert r["error_code"] == "not_found" and r["retryable"] is False


async def test_explicit_error_code_kept(temp_tools):
    from app.mcp.tools._common import err

    async def h(**_):
        return err("rate_limited", "slow down", retry_after=5)
    temp_tools("t_rl", h)
    r = await execute_tool("t_rl", {}, None)
    assert r["error_code"] == "rate_limited" and r["retryable"] is True and r["retry_after"] == 5


async def test_missing_required_argument_is_invalid_argument(temp_tools):
    async def h(path: str, **_):
        return {"ok": path}
    temp_tools("t_req", h)
    r = await execute_tool("t_req", {}, None)
    assert r["ok"] is False and r["error_code"] == "invalid_argument"


async def test_internal_type_error_is_not_masked(temp_tools):
    async def h(**_):
        return len(None)  # type: ignore[arg-type]  — 도구 버그
    temp_tools("t_bug", h)
    r = await execute_tool("t_bug", {}, None)
    assert r["error_code"] == "internal"


async def test_http_exception_maps_status(temp_tools):
    from fastapi import HTTPException

    async def h(**_):
        raise HTTPException(status_code=403, detail="nope")
    temp_tools("t_403", h)
    r = await execute_tool("t_403", {}, None)
    assert r["error_code"] == "forbidden" and r["error"] == "nope"


async def test_unknown_tool():
    r = await execute_tool("no_such_tool", {}, None)
    assert r["ok"] is False and r["error_code"] == "not_found"
