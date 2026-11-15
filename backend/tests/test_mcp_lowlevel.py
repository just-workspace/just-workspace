"""MCP Streamable HTTP 엔드포인트 — JSON-RPC wire 수준 동작.

mcp SDK 를 올릴 때(1.x → 2.x 에서 lowlevel Server 핸들러 등록 방식이 바뀜) 바깥에서 보이는
동작이 그대로인지 확인한다. 그래서 SDK 의 파이썬 API 를 직접 부르지 않고, 클라이언트가 실제로
보내는 HTTP/JSON-RPC 요청만으로 검증한다(어느 SDK 버전에서도 같은 테스트가 돌아야 한다).

인증·RBAC 는 다른 테스트의 영역이라 여기서는 가짜 authenticate/allowed_tool_names 로 대체하고,
전송 → 핸들러 → execute_tool → 응답 경로만 본다.
"""

import contextlib
import json

import pytest
from httpx import ASGITransport, AsyncClient
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.applications import Starlette
from starlette.routing import Mount

from app.mcp import http_server, server as mcp_registry

MCP_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": "Bearer test-token",
}


def _rpc(method: str, params: dict | None = None, id: int = 1) -> dict:
    body = {"jsonrpc": "2.0", "id": id, "method": method}
    if params is not None:
        body["params"] = params
    return body


def _parse(resp) -> dict:
    """JSON 또는 SSE(data: 줄) 응답에서 JSON-RPC 메시지를 꺼낸다."""
    ctype = resp.headers.get("content-type", "")
    if ctype.startswith("application/json"):
        return resp.json()
    msgs = []
    for line in resp.text.splitlines():
        if line.startswith("data:"):
            msgs.append(json.loads(line[5:].strip()))
    assert msgs, f"no SSE data in response: {resp.text[:200]!r}"
    return msgs[-1]


async def _echo_tool(**kwargs):
    return {"echo": kwargs}


async def _boom_tool(**kwargs):
    raise RuntimeError("boom")


@pytest.fixture()
async def mcp_client(monkeypatch):
    # 가짜 도구 두 개를 레지스트리에 잠깐 등록(사용자 불필요 → DB 없이 실행)
    tools = {
        "t_echo": mcp_registry.Tool(
            name="t_echo", description="echo args",
            parameters={"type": "object", "properties": {"q": {"type": "string"}}},
            handler=_echo_tool, requires_user=False,
        ),
        "t_boom": mcp_registry.Tool(
            name="t_boom", description="always fails",
            parameters={"type": "object", "properties": {}},
            handler=_boom_tool, requires_user=False,
        ),
        "t_hidden": mcp_registry.Tool(
            name="t_hidden", description="filtered out by RBAC",
            parameters={"type": "object", "properties": {}},
            handler=_echo_tool, requires_user=False,
        ),
    }
    for name, t in tools.items():
        monkeypatch.setitem(mcp_registry.WORKSPACE_TOOLS, name, t)

    ctx = http_server.McpContext(
        user=None, scopes=frozenset({"mcp:read"}),
        resource=http_server.READ_ENDPOINT.resource, endpoint_scope="mcp:read", internal=True,
    )

    async def fake_authenticate(request, endpoint):
        if request.headers.get("authorization") != "Bearer test-token":
            return None
        return ctx

    async def fake_allowed(c):
        assert c is ctx, "handler must see the context bound by the transport layer"
        return {"t_echo", "t_boom"}

    monkeypatch.setattr(http_server, "authenticate", fake_authenticate)
    monkeypatch.setattr(http_server, "allowed_tool_names", fake_allowed)

    @contextlib.asynccontextmanager
    async def client():
        # 세션 매니저는 인스턴스당 run() 1회만 허용 → 호출마다 새로 만들어 모듈 전역을 바꿔 끼운다
        # (운영 코드와 같은 인자: 무상태, SSE 스트림 응답). anyio 태스크 그룹은 fixture 의 yield 를
        # 넘기면 다른 태스크에서 닫히게 되므로, 테스트 본문 안에서 열고 닫는다.
        manager = StreamableHTTPSessionManager(app=http_server.mcp_server, json_response=False, stateless=True)
        monkeypatch.setattr(http_server, "session_manager", manager)
        app = Starlette(routes=[
            Mount("/api/mcp/read", app=http_server._make_asgi_handler(http_server.READ_ENDPOINT)),
        ])
        async with manager.run():
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                yield ac

    return client


async def test_unauthenticated_gets_401_with_challenge(mcp_client):
    async with mcp_client() as ac:
        r = await ac.post("/api/mcp/read/", json=_rpc("tools/list"),
                          headers={**MCP_HEADERS, "Authorization": "Bearer wrong"})
    assert r.status_code == 401
    assert "resource_metadata=" in r.headers["WWW-Authenticate"]
    assert r.json()["error"] == "invalid_token"


async def test_tools_list_is_filtered(mcp_client):
    async with mcp_client() as ac:
        r = await ac.post("/api/mcp/read/", json=_rpc("tools/list"), headers=MCP_HEADERS)
    assert r.status_code == 200, r.text
    msg = _parse(r)
    assert msg["id"] == 1 and "result" in msg, msg
    tools = {t["name"]: t for t in msg["result"]["tools"]}
    assert set(tools) == {"t_echo", "t_boom"}          # t_hidden 은 안 보인다
    assert tools["t_echo"]["description"] == "echo args"
    assert tools["t_echo"]["inputSchema"]["properties"]["q"]["type"] == "string"


async def test_tools_call_roundtrip(mcp_client):
    async with mcp_client() as ac:
        r = await ac.post(
            "/api/mcp/read/",
            json=_rpc("tools/call", {"name": "t_echo", "arguments": {"q": "안녕"}}, id=7),
            headers=MCP_HEADERS,
        )
    assert r.status_code == 200, r.text
    msg = _parse(r)
    assert msg["id"] == 7, msg
    result = msg["result"]
    assert not result.get("isError")
    payload = json.loads(result["content"][0]["text"])
    assert payload == {"ok": True, "result": {"echo": {"q": "안녕"}}}


async def test_tools_call_without_arguments(mcp_client):
    async with mcp_client() as ac:
        r = await ac.post("/api/mcp/read/", json=_rpc("tools/call", {"name": "t_echo"}), headers=MCP_HEADERS)
    payload = json.loads(_parse(r)["result"]["content"][0]["text"])
    assert payload == {"ok": True, "result": {"echo": {}}}


async def test_tool_exception_becomes_ok_false(mcp_client):
    async with mcp_client() as ac:
        r = await ac.post("/api/mcp/read/", json=_rpc("tools/call", {"name": "t_boom", "arguments": {}}),
                          headers=MCP_HEADERS)
    msg = _parse(r)
    assert "result" in msg, msg                        # JSON-RPC 오류가 아니라 정상 결과 안의 ok:false
    payload = json.loads(msg["result"]["content"][0]["text"])
    assert payload["ok"] is False and "boom" in payload["error"]


async def test_hidden_tool_is_not_callable(mcp_client):
    async with mcp_client() as ac:
        r = await ac.post("/api/mcp/read/", json=_rpc("tools/call", {"name": "t_hidden", "arguments": {}}),
                          headers=MCP_HEADERS)
    payload = json.loads(_parse(r)["result"]["content"][0]["text"])
    assert payload["ok"] is False and payload["error"] == "tool 't_hidden' is not available"
    assert payload["error_code"] == "forbidden"
