"""MCP server exposed over Streamable HTTP for remote clients (claude.ai custom
connector, Claude Code CLI, etc.).

This is the primary remote transport. The legacy SSE transport lives in
``sse_server.py`` and shares the auth / user-binding / RBAC logic defined here.

Auth: every request carries an OAuth **Bearer** access token minted
by the built-in OAuth provider. We verify signature, ``exp``, ``aud`` (must equal this
endpoint's resource URL) and ``scope`` (must contain the endpoint's required
scope). The real user is resolved from the token ``sub`` and bound to every tool
call — there is no ``MCP_ADMIN_USERNAME`` fallback. Unauthenticated/invalid
requests get **401** + a ``WWW-Authenticate`` header pointing at the protected
resource metadata, never 200.

Tool exposure: both ``tools/list`` and ``tools/call`` are filtered by the
module on/off state (``app.modules.registry``) and per-user RBAC grants
(``app.groups.service``) for the resolved user.

The endpoint is modelled as a resource-aware :class:`MCPEndpoint`. There are
three resources with distinct ``aud``: the base ``/api/mcp`` and ``/api/mcp/read``
(read tools only) and ``/api/mcp/write`` (read + write tools; write calls are not
executed directly but go through ``app.mcp.writes`` — immediate for low-risk,
approval queue for high-risk).
"""

from __future__ import annotations

import contextlib
import hmac
import json
import logging
import time as _time
from contextvars import ContextVar
from dataclasses import dataclass

import jwt
from jwt import PyJWTError as JWTError
from mcp.server import Server
from mcp.server.context import ServerRequestContext
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.types import (
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool as McpTool,
)
from sqlalchemy import select
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount
from starlette.types import Receive, Scope, Send

from app.config import get_settings
from app.db.models import SystemSetting, User
from app.db.session import async_session
from app.groups import service as groups_service
from app.modules.registry import _module_key, is_module_enabled
from app.mcp.server import WORKSPACE_TOOLS, execute_tool, fail
from app.mcp import pat_store, revocation
# Reuse the OAuth provider token signing algorithm so this validator matches the
# provider's ``_create_access_token`` exactly (same key = settings.secret_key).
from app.auth.oauth_provider import JWT_ALGORITHM

logger = logging.getLogger(__name__)
settings = get_settings()


# ── Tool → module map ──────────────────────────────────
# Maps each registered tool to the module_id that gates it. Tools with no
# backing module (module_id None) are always available (e.g. web_search).
# TOOL_MODULE 은 app.mcp.access 로 옮겼다(내장 AI 와 공유). 옛 import 경로 호환용 재수출.
from app.mcp.access import TOOL_MODULE, module_enabled as _access_module_enabled, tool_accessible  # noqa: E402,F401
from app.mcp.access import write_enabled as _access_write_enabled  # noqa: E402
from app.mcp.access import mcp_exposed as _access_mcp_exposed  # noqa: E402


# ── Per-request auth context (bound before the transport runs) ─
@dataclass
class McpContext:
    """Resolved caller identity for the current MCP request/connection."""
    user: User | None
    scopes: frozenset[str]
    resource: str
    # The required scope of the endpoint this request came in on. It doubles as
    # the tool-scope filter: an endpoint exposes only tools whose
    # ``tool.scope`` equals this, so a mcp:write tool is invisible/unreachable on
    # the read (or base) endpoint.
    endpoint_scope: str = "mcp:read"
    client_id: str | None = None
    internal: bool = False  # True = static-key internal-tools mode (no user)
    # 승인 카드·대기함에 보일 요청 출처. claude_app | personal_token
    client_name: str | None = None
    client_kind: str | None = None
    # 토큰 발급 시각(OAuth iat) 또는 연결 시각(개인 토큰) — 그 뒤에 연결을 끊었으면 거절한다(app.mcp.revocation)
    issued_at: float | None = None


# ContextVar is copied into the transport's per-request task by anyio, so tool
# handlers read the correct caller even under concurrent requests / 8 workers.
_mcp_ctx: ContextVar[McpContext | None] = ContextVar("mcp_ctx", default=None)


# ── Endpoint description (resource-aware; separate read/write resources) ─
@dataclass
class MCPEndpoint:
    path: str            # ASGI route path
    resource: str        # token ``aud`` must equal this (char-for-char)
    required_scope: str  # token ``scope`` must contain this
    metadata_path: str   # protected-resource metadata path (for WWW-Authenticate)
    # scopes advertised back to the client in the challenge (informational)
    advertise_scopes: str = ""


def _app_base() -> str:
    return settings.app_url.rstrip("/")


def _mcp_base() -> str:
    """Base URL of the MCP resource server (dedicated subdomain like
    https://mcp.example.com; falls back to app_url). Drives resource/aud +
    WWW-Authenticate. The OAuth issuer/authorize/token stay on app_url."""
    return (settings.mcp_public_url or settings.app_url).rstrip("/")


# The base endpoint is a single, neutral ``/api/mcp`` resource whose protected-resource
# metadata is the root document (``resource`` = ``<app>/api/mcp``).
# This base endpoint exposes READ tools only — its
# ``required_scope`` is ``mcp:read`` and that value doubles as the tool-scope
# filter, so no ``mcp:write`` tool is reachable here. Write tools live on the
# separate write resource below.
PHASE2_ENDPOINT = MCPEndpoint(
    path="/api/mcp",
    resource=f"{_mcp_base()}/api/mcp",
    required_scope="mcp:read",
    metadata_path="/.well-known/oauth-protected-resource",
    advertise_scopes="mcp:read",
)


# Read side: a physically-separate read resource with its own ``aud``
# (``<app>/api/mcp/read``) and its own protected-resource metadata. It
# exposes ONLY ``mcp:read`` tools. This is the URL registered on claude.ai.
READ_ENDPOINT = MCPEndpoint(
    path="/api/mcp/read",
    resource=f"{_mcp_base()}/api/mcp/read",
    required_scope="mcp:read",
    metadata_path="/.well-known/oauth-protected-resource/api/mcp/read",
    advertise_scopes="mcp:read",
)


# 쓰기 리소스 — aud ``<app>/api/mcp/write``, mcp:write 필요. 읽기+쓰기 도구를 모두 노출한다.
# 쓰기 도구는 실행되지 않고 app.mcp.writes 로 간다(low 즉시·high 승인 대기함). 커넥터 URL 을 따로 두어
# 사용자가 "쓰기 커넥터"를 일부러 연결해야만 쓰기가 열린다(읽기 커넥터는 그대로 읽기 전용).
WRITE_ENDPOINT = MCPEndpoint(
    path="/api/mcp/write",
    resource=f"{_mcp_base()}/api/mcp/write",
    required_scope="mcp:write",
    metadata_path="/.well-known/oauth-protected-resource/api/mcp/write",
    advertise_scopes="mcp:read mcp:write",
)


def www_authenticate(endpoint: MCPEndpoint) -> str:
    """RFC 9728 challenge. The ``resource_metadata`` pointer is what makes the
    connector start discovery — omitting it is the #1 cause of silent failures."""
    meta = f"{_mcp_base()}{endpoint.metadata_path}"
    header = f'Bearer resource_metadata="{meta}"'
    if endpoint.advertise_scopes:
        header += f', scope="{endpoint.advertise_scopes}"'
    return header


def unauthorized(endpoint: MCPEndpoint, detail: str = "unauthorized") -> JSONResponse:
    return JSONResponse(
        {"error": "invalid_token", "error_description": detail},
        status_code=401,
        headers={"WWW-Authenticate": www_authenticate(endpoint)},
    )


# ── Bearer verification + user binding ──────────
def _extract_bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    return auth.split(None, 1)[1].strip() or None


async def _resolve_active_user(user_id: str) -> User | None:
    async with async_session() as db:
        user = await db.get(User, user_id)
        if user and user.is_active:
            return user
    return None


async def authenticate(request: Request, endpoint: MCPEndpoint) -> McpContext | None:
    """Return an :class:`McpContext` on success, or None (caller emits 401).

    Order: OAuth Bearer first; static internal key only if explicitly enabled.
    """
    token = _extract_bearer(request)
    if not token:
        return None

    # Opt-in internal-tools mode (default OFF). Constant-time compare, no user.
    if (
        settings.mcp_internal_tools_enabled
        and settings.mcp_api_key
        and hmac.compare_digest(token, settings.mcp_api_key)
    ):
        return McpContext(
            user=None,
            scopes=frozenset({"mcp:read", "mcp:write"}),
            resource=endpoint.resource,
            endpoint_scope=endpoint.required_scope,
            internal=True,
        )

    # Personal Access Token (PAT) fallback: a ``wsmcp_`` bearer minted from the
    # profile "AI 연동" page. Recognised by prefix, so the OAuth JWT path below is
    # never touched for non-PAT tokens. PATs are user+scope bound (mcp:read only)
    # — no aud/resource check needed (the token itself binds the caller).
    if pat_store.is_pat(token):
        async with async_session() as db:
            row = await pat_store.resolve_pat(db, token)  # None if unknown/revoked/expired
            if row is None:
                logger.info("[mcp] PAT rejected: unknown/revoked/expired")
                return None
            scopes = frozenset(json.loads(row.scopes or "[]"))
            if endpoint.required_scope not in scopes:
                logger.info("[mcp] PAT scope %r missing (have %s)",
                            endpoint.required_scope, sorted(scopes))
                return None
            user = await _resolve_active_user(row.user_id)
            if user is None:      # inactive / deleted → 401
                return None
            await db.commit()     # persist last_used_at bump
        return McpContext(
            user=user,
            scopes=scopes,
            resource=endpoint.resource,
            endpoint_scope=endpoint.required_scope,
            client_id=f"pat:{row.id}",
            client_name=row.name or "개인 토큰",
            client_kind="personal_token",
            issued_at=_time.time(),
        )

    # OAuth Bearer: verify signature + exp + aud + iss.
    # 서명은 RS256(JWKS) — 검증 로직은
    # oauth_provider.verify_access_token 하나로 모은다. 여기서 알고리즘을
    # 따로 들고 있으면 provider 와 어긋난다.
    from app.auth.oauth_provider import verify_access_token
    from app.db.session import async_session

    try:
        async with async_session() as _kdb:
            payload = await verify_access_token(
                _kdb,
                token,
                audience=endpoint.resource,  # aud must EQUAL this resource
                issuer=settings.app_url,
                # aud 없는 토큰(Gitea SSO 등)은 MCP 에서 거절 — 필수 클레임을 명시.
                options={"require": ["aud", "exp", "iss", "sub"]},
            )
    except JWTError as e:
        logger.info("[mcp] bearer rejected: %s", e)
        return None

    scopes = frozenset((payload.get("scope") or "").split())
    if endpoint.required_scope not in scopes:
        logger.info("[mcp] scope %r missing (have %s)", endpoint.required_scope, sorted(scopes))
        return None

    sub = payload.get("sub")
    if not sub:
        return None
    user = await _resolve_active_user(sub)
    if user is None:      # inactive / deleted → 401
        return None

    client_id = payload.get("client_id") or payload.get("azp")
    # 연결을 끊은 뒤에도 이미 발급된 액세스 토큰(1시간)이 통하던 것을 막는다 — 해제 시각 전에 발급된 토큰은 거절
    if await revocation.revoked_since(user.id, client_id, payload.get("iat")):
        logger.info("[mcp] bearer rejected: connection revoked (client=%s)", client_id)
        return None
    return McpContext(
        user=user,
        scopes=scopes,
        resource=endpoint.resource,
        endpoint_scope=endpoint.required_scope,
        client_id=client_id,
        client_name=await _client_display_name(client_id),
        client_kind="claude_app",
        issued_at=payload.get("iat"),
    )


async def _client_display_name(client_id: str | None) -> str:
    """OAuth 클라이언트의 사람용 이름 — DCR 등록 이름(claude.ai 는 "Claude") 또는 정적 클라이언트 id."""
    if not client_id:
        return "AI 커넥터"
    try:
        if client_id.startswith("dcr_"):
            from app.db.models import OAuthDynamicClient

            async with async_session() as db:
                name = await db.scalar(select(OAuthDynamicClient.client_name)
                                       .where(OAuthDynamicClient.client_id == client_id))
            if name:
                return str(name)[:255]
    except Exception:  # noqa: BLE001
        pass
    return "Claude" if "claude" in client_id.lower() else client_id[:64]


# ── Module + RBAC tool filtering ───────────────────────
async def _module_enabled(db, module_id: str) -> bool:
    return await _access_module_enabled(db, module_id)


async def allowed_tool_names(ctx: McpContext) -> set[str]:
    """Names this caller may see/call: tool scope matches the endpoint AND module
    enabled AND user has grant. Used by BOTH ``tools/list`` and ``tools/call`` so
    a filtered-out tool is neither listed nor invokable.

    The endpoint scope filter (``tool.scope == ctx.endpoint_scope``) is what keeps
    ``notes_create`` (mcp:write) off the read/base endpoints entirely.

    Internal (static-key) callers have no user, so only user-less tools apply.
    """
    allowed: set[str] = set()
    async with async_session() as db:
        writes_on = ctx.endpoint_scope == "mcp:write" and await _access_write_enabled(db)
        for name, tool in WORKSPACE_TOOLS.items():
            if ctx.endpoint_scope == "mcp:write":
                # 쓰기 커넥터: 읽기 도구 + (관리자 허용 시) 쓰기 도구
                if tool.scope == "mcp:write" and not writes_on:
                    continue
                if tool.scope not in ("mcp:read", "mcp:write"):
                    continue
            elif tool.scope != ctx.endpoint_scope:
                continue                   # tool not in this endpoint's scope
            if not await _access_mcp_exposed(db, name):    # 내장 AI 전용으로 시작한 도구(code_run 등)
                continue
            if await tool_accessible(db, ctx.user, name):   # TOOL_MODULE(fail-closed)+모듈 on/off+RBAC
                allowed.add(name)
    return allowed


async def _disconnected(ctx: McpContext) -> bool:
    """오래 열린 연결(옛 SSE)용 — 연결할 때만 인증하므로, 그 뒤에 사용자가 연결을 끊었는지 호출마다 다시 본다."""
    if ctx.user is None:
        return False
    return await revocation.revoked_since(ctx.user.id, ctx.client_id, ctx.issued_at)


# ── Shared MCP Server (used by BOTH Streamable HTTP and SSE) ───
# mcp 2.x: 핸들러는 데코레이터 대신 생성자 on_* 인자로 등록하고 (ctx, params) 를 받아
# 결과 타입(ListToolsResult/CallToolResult)을 직접 돌려준다. 호출자 신원은 전송 계층이
# 요청마다 _mcp_ctx 에 묶어 둔 것을 그대로 쓴다(ServerRequestContext 는 쓰지 않는다).
async def _list_tools(
    _rctx: ServerRequestContext, _params: PaginatedRequestParams | None
) -> ListToolsResult:
    ctx = _mcp_ctx.get()
    if ctx is None or await _disconnected(ctx):
        return ListToolsResult(tools=[])
    names = await allowed_tool_names(ctx)
    return ListToolsResult(tools=[
        McpTool(name=t.name, description=t.description, input_schema=t.parameters)
        for name, t in WORKSPACE_TOOLS.items()
        if name in names
    ])


async def _call_tool(_rctx: ServerRequestContext, params: CallToolRequestParams) -> CallToolResult:
    name, arguments = params.name, params.arguments
    ctx = _mcp_ctx.get()
    if ctx is None or await _disconnected(ctx):
        result = {"ok": False, "error": "unauthenticated"}
    else:
        names = await allowed_tool_names(ctx)
        if name not in names:
            # Reject even direct calls to hidden tools (module/RBAC,
            # endpoint scope). notes_create is filtered out here on read/base.
            result = fail("forbidden", f"tool '{name}' is not available")
        else:
            # Pass caller scopes so execute_tool re-checks the tool scope before
            # running — defense-in-depth on top of the endpoint filter.
            from app.mcp import writes as _writes

            _ct = _writes.call_context.set(_writes.CallContext(
                source="mcp", client_name=ctx.client_name, client_kind=ctx.client_kind,
                client_key=ctx.client_id or "mcp"))
            try:
                result = await execute_tool(name, arguments or {}, ctx.user, scopes=ctx.scopes)
            finally:
                _writes.call_context.reset(_ct)
    text = json.dumps(result, ensure_ascii=False, default=str)
    # 1.x 와 같은 wire 동작: 도구 오류도 JSON 본문의 ok:false 로만 전달하고 is_error 는 세우지 않는다.
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=False)


mcp_server: Server = Server(
    "just-workspace",
    on_list_tools=_list_tools,
    on_call_tool=_call_tool,
)


# ── Streamable HTTP transport wiring ──────────────────────────
# Stateless: no cross-request session state, which is required here because the
# 8 uvicorn workers do not share in-memory MCP sessions.
session_manager = StreamableHTTPSessionManager(
    app=mcp_server,
    json_response=False,   # SSE-style streamed responses
    stateless=True,
)


def _make_asgi_handler(endpoint: MCPEndpoint, *, resolve_sub: bool = False):
    """endpoint 로 인증하는 ASGI 핸들러.

    ``resolve_sub``: 베이스 마운트(/api/mcp)용. Starlette ``Mount`` 는 접두어 뒤에
    슬래시가 오는 경로만 매칭한다(정규식 ``^/api/mcp/read(?P<path>/.*)$``). 그래서
    클라이언트가 실제로 POST 하는 **슬래시 없는 ``/api/mcp/read``** 는 read 마운트를
    비껴가 베이스 마운트에 걸리고, 베이스의 resource(``…/api/mcp``)와 토큰의 aud
    (``…/api/mcp/read``)가 어긋나 **401** 이 된다. ``/api/mcp/write`` 도 같다.

    베이스 마운트가 삼킨 경우 남은 경로를 보고 올바른 엔드포인트를 고른다.
    """
    async def handler(scope: Scope, receive: Receive, send: Send) -> None:
        request = Request(scope, receive)
        ep = endpoint
        if resolve_sub:
            # Starlette 버전에 따라 Mount 가 scope["path"] 를 잘라주기도 하고
            # (구버전: "/read") 원본을 그대로 두기도 한다(신버전: "/api/mcp/read").
            # 둘 다 받아야 한다.
            _p = scope.get("path", "").rstrip("/")
            if _p.endswith("/api/mcp/read") or _p == "/read":
                ep = READ_ENDPOINT
            elif _p.endswith("/api/mcp/write") or _p == "/write":
                ep = WRITE_ENDPOINT
        ctx = await authenticate(request, ep)
        if ctx is None:
            await unauthorized(ep)(scope, receive, send)
            return
        token = _mcp_ctx.set(ctx)
        try:
            await session_manager.handle_request(scope, receive, send)
        finally:
            _mcp_ctx.reset(token)

    return handler


async def mount_mcp_http(app) -> None:
    """Enter the session manager's task group and attach the HTTP route.

    Must be awaited from the FastAPI lifespan (startup). The task group is kept
    alive on ``app.state`` and closed by :func:`unmount_mcp_http` at shutdown.
    """
    stack = contextlib.AsyncExitStack()
    await stack.enter_async_context(session_manager.run())
    app.state._mcp_http_stack = stack

    internal_on = settings.mcp_internal_tools_enabled and settings.mcp_api_key
    # Mount (not Route): each `handler` is a raw ASGI app (scope/receive/send).
    # Starlette Route would mis-invoke it as handler(request) → 500. Mount treats
    # it as ASGI and the stateless session manager handles method routing itself.
    #
    # Order matters (Starlette matches routes in order): the more specific
    # ``/api/mcp/read`` and ``/api/mcp/write`` BEFORE the base ``/api/mcp`` so
    # their sub-paths aren't swallowed by the base mount's prefix.
    handler = _make_asgi_handler(READ_ENDPOINT)
    app.router.routes.append(Mount(READ_ENDPOINT.path, app=handler))
    print(
        f"[MCP] Streamable HTTP endpoint mounted at {READ_ENDPOINT.path} "
        f"(resource={READ_ENDPOINT.resource}, scope={READ_ENDPOINT.required_scope}, "
        f"OAuth Bearer{'; internal-key ON' if internal_on else ''})"
    )

    # 쓰기 엔드포인트. 하위 경로는 Mount, 슬래시 없는 /api/mcp/write 는 베이스 마운트의 resolve_sub 가
    # WRITE_ENDPOINT 로 인증한다(read 와 같은 방식).
    handler = _make_asgi_handler(WRITE_ENDPOINT)
    app.router.routes.append(Mount(WRITE_ENDPOINT.path, app=handler))
    print(
        f"[MCP] Streamable HTTP endpoint mounted at {WRITE_ENDPOINT.path} "
        f"(resource={WRITE_ENDPOINT.resource}, scope={WRITE_ENDPOINT.required_scope})"
    )

    # resolve_sub=True: 슬래시 없는 /api/mcp/read 가 여기로 흘러들어올 때
    # read 엔드포인트로 인증하도록 한다(위 docstring 참고).
    handler = _make_asgi_handler(PHASE2_ENDPOINT, resolve_sub=True)
    app.router.routes.append(Mount(PHASE2_ENDPOINT.path, app=handler))
    print(
        f"[MCP] Streamable HTTP endpoint mounted at {PHASE2_ENDPOINT.path} "
        f"(resource={PHASE2_ENDPOINT.resource}, scope={PHASE2_ENDPOINT.required_scope}, "
        f"OAuth Bearer{'; internal-key ON' if internal_on else ''})"
    )


async def unmount_mcp_http(app) -> None:
    stack = getattr(app.state, "_mcp_http_stack", None)
    if stack is not None:
        with contextlib.suppress(Exception):
            await stack.aclose()
        app.state._mcp_http_stack = None
