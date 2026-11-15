"""MCP server exposed over SSE — legacy/backward-compat transport.

Mounts two routes on the FastAPI app:
  - GET  /api/mcp/sse              — SSE channel (server → client events)
  - POST /api/mcp/messages/        — JSON-RPC inbound (client → server)

New clients should use the Streamable HTTP endpoint (``http_server.py``); SSE is
kept only so existing Claude Desktop / Cursor configs keep working.

Auth, user binding and RBAC are shared with the HTTP transport: an OAuth Bearer
access token is verified on the SSE GET (signature/exp/aud/scope), the real user
is resolved from the token ``sub`` and bound to the connection, and tool
list/call are filtered by module state + RBAC grants. There is no
``MCP_ADMIN_USERNAME`` fallback and no plain-string key comparison anymore.
"""

from __future__ import annotations

from mcp.server import NotificationOptions
from mcp.server.models import InitializationOptions
from mcp.server.sse import SseServerTransport
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

# Reuse the shared MCP server, auth, per-request context and endpoint config so
# both transports behave identically (§2-2/§2-3/§2-4).
from app.config import get_settings
from app.mcp.http_server import (
    PHASE2_ENDPOINT,
    _mcp_ctx,
    authenticate,
    mcp_server,
    unauthorized,
)

settings = get_settings()

# ── SSE transport wired into FastAPI ──
sse_transport = SseServerTransport("/api/mcp/messages/")


async def handle_sse(request: Request) -> Response:
    ctx = await authenticate(request, PHASE2_ENDPOINT)
    if ctx is None:
        return unauthorized(PHASE2_ENDPOINT)
    # Bind the resolved caller for this connection's lifetime. The tool handlers
    # run in this same task, so they read the correct user/scopes.
    token = _mcp_ctx.set(ctx)
    try:
        async with sse_transport.connect_sse(
            request.scope, request.receive, request._send,
        ) as (read_stream, write_stream):
            await mcp_server.run(
                read_stream,
                write_stream,
                InitializationOptions(
                    server_name="just-workspace",
                    server_version="1.0.0",
                    capabilities=mcp_server.get_capabilities(
                        notification_options=NotificationOptions(),
                        experimental_capabilities={},
                    ),
                ),
            )
    finally:
        _mcp_ctx.reset(token)
    return Response()


def mount_mcp(app):
    """Attach the legacy SSE MCP routes to a FastAPI app."""
    app.add_route("/api/mcp/sse", handle_sse, methods=["GET"])
    app.router.routes.append(
        Route("/api/mcp/messages/", endpoint=sse_transport.handle_post_message, methods=["POST"])
    )
    internal = settings.mcp_internal_tools_enabled and settings.mcp_api_key
    print(
        "[MCP] SSE endpoint mounted at /api/mcp/sse "
        f"(OAuth Bearer{'; internal-key ON' if internal else ''})"
    )
