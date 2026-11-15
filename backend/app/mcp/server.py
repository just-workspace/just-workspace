"""Workspace MCP server.

Two ways to consume:
  - In-process (from a plugin): import `WORKSPACE_TOOLS`, call `execute_tool(name, args, user)` directly.
  - Remote (Claude Desktop etc.): GET /api/mcp/sse with `Authorization: Bearer <api_key>`.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from app.db.models import User

logger = logging.getLogger(__name__)


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict          # JSON schema
    handler: Callable[..., Awaitable[Any]]
    # Some tools don't need a user (e.g. web_search). Most do.
    requires_user: bool = True
    # OAuth scope required to call this tool (§3-1): "mcp:read" | "mcp:write".
    # Read/write endpoints are physically split by resource URL, and each exposes
    # only tools whose ``scope`` matches — a write tool is never reachable via the
    # read endpoint.
    scope: str = "mcp:read"
    # True = tool output is unauthenticated external content (e.g. inbound email,
    # web pages). The call path wraps such output behind a trust boundary (§3-3)
    # so the model treats it as data, never as instructions.
    untrusted_output: bool = False
    # 쓰기 도구의 위험도(S3): "low" = 생성·임시저장·수정(되돌리기 가능), "high" = 삭제·발송·외부 공유.
    # high 는 어디서 부르든 승인 대기함을 거친다. 읽기 도구에는 의미 없다.
    risk: str = "low"
    # 화면(승인 카드·대기함)에 보일 사람용 이름. 없으면 name.
    title: str | None = None
    # 쓰기 도구 선택 훅(S3): previewer(args) -> [{field,label,before,after}], summarizer(args) -> str.
    # 입력 스키마 속성에 "x-label"(한국어 칸 이름)·"x-editable"(카드에서 고칠 칸)·"x-hidden" 을 달 수 있다.
    previewer: Callable[[dict], Any] | None = None
    summarizer: Callable[[dict], Any] | None = None
    # S4 — low 쓰기 가운데 사용자 데이터를 바꾸지 않고 본인만 받는 임시 결과물(24시간 링크)을 만드는 도구
    # (문서 생성·파일 압축). 내장 AI 에서도 카드 없이 바로 실행하고, 직전 외부 읽기 뒤에도 승인함으로 올리지 않는다.
    # 기록·감사·멱등은 다른 쓰기와 같다(request_write).
    auto_run: bool = False
    # 다른 사람에게 보이거나 통지가 나가는 쓰기(채팅 발송·게시글·댓글·메일 발송·남에게 배정 등).
    # 내장 AI 가 같은 대화에서 남이 쓴 내용(untrusted_output)을 읽은 뒤에는 권한 모드·허용 규칙과 상관없이
    # 승인 카드를 띄운다(주입 → 사칭 발송 방어, writes.request_write). 이름으로 추측하지 않고 여기 명시한다.
    # 인자·대상에 따라 달라지면 visible_for(args, user) -> bool 을 단다. DB 조회가 필요하면 코루틴이어도 된다
    # (관문 판정 시점에 await). 판정 실패는 '보인다'로.
    visible_to_others: bool = False
    visible_for: Callable[[dict, Any], Any] | None = None
    # 결과에 남이 쓴 글 조각이 섞일 수 있는 도구(목록·검색 미리보기, 입력 파일을 읽는 코드 실행 등).
    # untrusted_output 과 달리 결과를 감싸지 않고 MCP 15분 창에도 서지 않는다 — 내장 AI 의 대화 단위 표시만
    # 남긴다('남에게 보이는 쓰기' 관문용). 인자에 따라 달라지면 (args) -> bool.
    conv_untrusted: Any = False


# ── Trust boundary (§3-3) ─────────────────────────────────────
# Maps an untrusted-output tool to the ``source`` label used in the wrapper.
_UNTRUSTED_SOURCE: dict[str, str] = {
    "mail_search": "external_email",
    "mail_read": "external_email",
    "mail_read_attachment": "external_email_attachment",
    "files_read": "file_content",
    "web_search": "external_web",
    "web_fetch": "external_web",
    # 워크스페이스 안이지만 다른 사람이 쓴 글(초대장·공유 문서·남이 배정한 할 일 포함)
    "chat_read_messages": "chat_messages",
    "board_search": "board_posts",
    "board_read_post": "board_posts",
    "notes_search": "wiki_pages",
    "notes_read": "wiki_pages",
    "calendar_list_events": "calendar_events",
    "contacts_search": "contacts",
    "tasks_list": "tasks",
}


def _wrap_untrusted(tool: "Tool", data: Any) -> dict:
    """Wrap external, unverified tool output behind an explicit trust boundary.

    The wrapper flags the payload as untrusted data so downstream consumers do
    not treat any text inside ``data`` as instructions.
    """
    return {
        "untrusted": True,
        "source": _UNTRUSTED_SOURCE.get(tool.name, "external"),
        "data": data,
    }


# Registry — populated by app.mcp.tools.*
WORKSPACE_TOOLS: dict[str, Tool] = {}


def register(tool: Tool) -> None:
    WORKSPACE_TOOLS[tool.name] = tool


async def execute_tool(
    name: str,
    args: dict,
    user: User | None,
    scopes: frozenset[str] | None = None,
) -> dict:
    """도구 실행 + 사용자별 호출 한도 + 감사 기록(S2). 실제 실행은 _execute_tool_core."""
    import time as _time

    from app.mcp import audit, writes

    ctx = writes.call_context.get()
    if user is not None and scopes is not None:
        wait = await audit.check_rate(user.id)
        if wait is not None:
            return fail("rate_limited", f"호출이 너무 많습니다. {wait}초 뒤에 다시 시도하세요", retry_after=wait)
    t0 = _time.monotonic()
    res = await _execute_tool_core(name, args, user, scopes)
    await audit.record_tool_call(
        user_id=getattr(user, "id", None), tool=name, ok=bool(res.get("ok")),
        error_code=res.get("error_code"), latency_ms=int((_time.monotonic() - t0) * 1000),
        source=(ctx.source if ctx else ("plugin" if scopes is None else "mcp")),
        client_name=(ctx.client_name if ctx else None), arg_keys=list((args or {}).keys()),
        client_kind=(ctx.client_kind if ctx else None),
    )
    return res


async def _execute_tool_core(
    name: str,
    args: dict,
    user: User | None,
    scopes: frozenset[str] | None = None,
) -> dict:
    """Run a registered tool. Returns {'ok': bool, 'result' or 'error': ...}.

    ``scopes`` = the caller's granted OAuth scopes. When provided (remote MCP
    callers), a tool whose required ``scope`` is not among them is rejected before
    execution — defense-in-depth on top of the endpoint-level scope filter (§3-1).
    ``None`` = trusted in-process caller (plugin); no scope gate.
    """
    tool = WORKSPACE_TOOLS.get(name)
    if not tool:
        return fail("not_found", f"unknown tool: {name}")
    if scopes is not None and tool.scope not in scopes:
        return fail("forbidden", f"tool '{name}' requires scope '{tool.scope}'")
    if tool.requires_user and user is None:
        return fail("forbidden", f"tool '{name}' requires authentication")
    call_kwargs = dict(args or {})
    if tool.scope == "mcp:write" and user is not None:
        return await _request_write(tool, call_kwargs, user)
    if tool.requires_user:
        call_kwargs["user"] = user
    try:
        # 필수 인자 누락 등 — 모델이 고쳐서 다시 부를 수 있게 invalid_argument 로.
        # (도구 안에서 난 TypeError 는 버그이므로 여기서 가리지 않는다)
        inspect.signature(tool.handler).bind(**call_kwargs)
    except TypeError as e:
        return fail("invalid_argument", f"bad arguments for '{name}': {e}")
    try:
        result = await tool.handler(**call_kwargs)
    except Exception as e:
        code = _exc_code(e)
        if code == "internal":
            logger.exception("[mcp] tool %s failed: %s", name, e)
        return fail(code, _exc_message(e))
    # 도구가 돌려준 {"error": ...} 도 실패로 올린다(예전엔 ok:true 안에 묻혀 있었다)
    if isinstance(result, dict) and isinstance(result.get("error"), str):
        code = result.get("error_code") or _infer_code(result["error"])
        extra = {k: v for k, v in result.items() if k not in ("error", "error_code")}
        return fail(code, result["error"], **extra)
    if tool.untrusted_output:
        if user is not None:
            await _mark_untrusted(tool, user, result)
        result = _wrap_untrusted(tool, result)
    elif user is not None and tool.conv_untrusted:
        await _mark_untrusted(tool, user, result, window=False, args=args)
    result, too_large = _fit_result(name, result)
    if too_large is not None:
        return fail("response_too_large", too_large["error"], hint=too_large["hint"])
    return {"ok": True, "result": result}


def _fit_result(name: str, result: Any) -> tuple[Any, dict | None]:
    """바깥 안전장치 — 도구가 스스로 못 맞춘 결과를 바깥 상한(글자) 안으로 구조를 지키며 줄인다.

    상한은 내장 AI 가 건 예산(fit_budget_scope) 또는 설정 mcp_response_max_chars. 줄여도 안 되면
    (결과, 오류) 의 오류 쪽을 채운다 → 호출자가 반쯤 잘린 JSON 대신 response_too_large 로 바꾼다.
    신뢰 경계 래퍼는 그대로 두고 data 안을 줄인다.
    """
    from app.mcp.tools import _common

    cap = _common.outer_cap()
    fitted, _text = _common.fit_payload(result, cap)
    if fitted is not result and isinstance(fitted, dict) and fitted.get("error_code") == "response_too_large"             and fitted.get("ok") is False:
        logger.warning("[mcp] tool %s response too large even after fitting (cap=%s)", name, cap)
        return None, fitted
    return fitted, None


async def _request_write(tool: "Tool", args: dict, user: User) -> dict:
    """쓰기 도구 — 직접 실행하지 않고 승인 흐름(app.mcp.writes)으로 보낸다."""
    from app.mcp import writes

    idem = args.pop("idempotency_key", None)
    try:
        inspect.signature(tool.handler).bind(user=user, **args) if tool.requires_user             else inspect.signature(tool.handler).bind(**args)
    except TypeError as e:
        return fail("invalid_argument", f"bad arguments for '{tool.name}': {e}")
    async with writes.session() as db:
        out = await writes.request_write(db, user, tool.name, args,
                                         idempotency_key=(str(idem) if idem else None))
    if out.get("status") == "failed":
        extra = {k: v for k, v in out.items()
                 if k not in ("status", "error", "error_code", "retryable", "ok", "tool", "risk")}
        return fail(out.get("error_code") or "internal", out.get("error") or "실행 실패", **extra)
    return {"ok": True, "result": out}


async def _mark_untrusted(tool: "Tool", user: User, result, *, window: bool = True, args: dict | None = None) -> None:
    """window=False — conv_untrusted 도구: MCP 15분 창은 건드리지 않고 내장 AI 대화 표시만."""
    try:
        from app.mcp import writes

        if not window and not writes.reads_others(tool, args):
            return
        ctx = writes.call_context.get()
        hint = writes.untrusted_hint(tool.name, result)
        if window:
            await writes.mark_untrusted_read(user.id, ctx.client_key if ctx else None, hint)
        if ctx is not None and ctx.source == "ai" and ctx.conversation_id:
            # 내장 AI — 읽은 내용은 대화 맥락에 계속 남으므로 15분 창과 별개로 대화 단위 표시도 남긴다
            await writes.mark_conv_untrusted(user.id, ctx.conversation_id, hint)
    except Exception:  # noqa: BLE001 — 표시 실패가 읽기를 막으면 안 된다
        logger.debug("[mcp] untrusted mark failed", exc_info=True)


# ── 오류 정규화 (설계 규칙) ─────────────────
_RETRYABLE = frozenset({"unavailable", "rate_limited", "timeout"})


def fail(code: str, message: str, **extra) -> dict:
    """``{"ok": False, "error": <문자열>, "error_code", "retryable"}``.
    ``error`` 는 문자열로 유지한다 — 내장 AI 화면이 그대로 표시한다(하위호환)."""
    out = {"ok": False, "error": message, "error_code": code, "retryable": code in _RETRYABLE}
    out.update(extra)
    return out


def _exc_code(e: Exception) -> str:
    import asyncio

    status = getattr(e, "status_code", None)   # fastapi HTTPException
    if isinstance(status, int):
        return {400: "invalid_argument", 401: "forbidden", 403: "forbidden", 404: "not_found",
                409: "conflict", 413: "too_large", 415: "unsupported", 422: "invalid_argument",
                429: "rate_limited", 503: "unavailable", 504: "timeout"}.get(status, "internal")
    if isinstance(e, FileNotFoundError):
        return "not_found"
    if isinstance(e, PermissionError):
        return "forbidden"
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
        return "timeout"
    if isinstance(e, ConnectionError):
        return "unavailable"
    if isinstance(e, ValueError):
        return "invalid_argument"
    return "internal"


def _exc_message(e: Exception) -> str:
    detail = getattr(e, "detail", None)
    return str(detail) if detail else (str(e) or e.__class__.__name__)


def _infer_code(msg: str) -> str:
    """error_code 없이 문자열만 돌려주던 옛 도구용 추정."""
    m = msg.lower()
    if "not found" in m or "없" in m:
        return "not_found"
    if any(k in m for k in ("permission", "denied", "not a member", "forbidden", "권한")):
        return "forbidden"
    if "too large" in m:
        return "too_large"
    if any(k in m for k in ("not available", "no mail account", "unavailable")):
        return "unavailable"
    if "binary" in m or "unsupported" in m:
        return "unsupported"
    return "invalid_argument"


def tools_as_ollama_format() -> list[dict]:
    """Return tools in Ollama/OpenAI function-calling format."""
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            },
        }
        for t in WORKSPACE_TOOLS.values()
    ]


def tools_as_mcp_list() -> list[dict]:
    """Return tools in MCP `tools/list` response format."""
    return [
        {
            "name": t.name,
            "description": t.description,
            "inputSchema": t.parameters,
        }
        for t in WORKSPACE_TOOLS.values()
    ]


# Load all tool modules on import so the registry is populated
def _autoload() -> None:
    from . import tools  # noqa: F401  — triggers registration via side-effects


_autoload()
print(f"[MCP] tools registered: {sorted(WORKSPACE_TOOLS.keys())}")
