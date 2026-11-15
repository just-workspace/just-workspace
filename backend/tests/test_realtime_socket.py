"""실시간 소켓(/ws/chat) — 전송 계층은 코어, 채팅 프레임 처리기는 채팅 구역이 설치됐을 때만.

Redis·DB 없이 수신 루프의 갈림만 본다: ping 은 소켓이 답하고, 나머지 프레임은 설치된 구역이
등록한 처리기로 가고, 처리기가 없으면 오류 프레임.
"""

import json
from types import SimpleNamespace

import pytest
from fastapi import WebSocketDisconnect

from app import zones
from app.realtime import socket


class _FakeWS:
    def __init__(self, frames: list):
        self._frames = [f if isinstance(f, str) else json.dumps(f) for f in frames]
        self.accepted = False
        self.closed: int | None = None

    async def accept(self, subprotocol=None):
        self.accepted = True

    async def close(self, code=1000, reason=""):
        self.closed = code

    async def receive_text(self) -> str:
        if not self._frames:
            raise WebSocketDisconnect()
        return self._frames.pop(0)


class _FakeConn:
    def __init__(self):
        self.sent: list[dict] = []

    def offer(self, data: dict) -> None:
        self.sent.append(data)


class _FakeManager:
    def __init__(self):
        self.conn = _FakeConn()
        self.connected: list[tuple[str, list[str]]] = []
        self.disconnected: list[str] = []

    async def connect(self, user_id, ws, channel_ids):
        self.connected.append((user_id, list(channel_ids)))
        return self.conn

    def disconnect(self, user_id, ws):
        self.disconnected.append(user_id)

    async def publish_presence(self, data):
        pass


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, model, key):
        return SimpleNamespace(id=key, username="alice", display_name="Alice", is_active=True, avatar_url=None)


@pytest.fixture()
def wired(monkeypatch):
    """소켓의 바깥 의존(인증·DB·접속 상태·연결 관리자)을 가짜로 바꾼다."""
    from app.auth import ws_auth

    manager = _FakeManager()

    async def _auth(ws):
        return "alice"

    async def _false(*a, **k):
        return False

    async def _none(*a, **k):
        return None

    async def _no_channels(db, user_id):
        return []

    monkeypatch.setattr(socket, "_authenticate_ws", _auth)
    monkeypatch.setattr(socket, "async_session", lambda: _FakeSession())
    monkeypatch.setattr(socket, "connection_opened", _false)
    monkeypatch.setattr(socket, "connection_closed", _false)
    monkeypatch.setattr(socket, "refresh_heartbeat", _none)
    monkeypatch.setattr(socket, "_user_channel_ids", _no_channels)
    monkeypatch.setattr(socket, "manager", manager)
    monkeypatch.setattr(ws_auth, "accept_subprotocol", lambda ws: None)
    return manager


@pytest.mark.asyncio
async def test_ping_and_error_frames_without_chat(monkeypatch, wired):
    monkeypatch.setenv(zones.ENV_VAR, "mail")          # 채팅 구역 없음
    ws = _FakeWS([{"type": "ping"}, "not json", {"type": "send_message", "channel_id": "c", "content": "hi"}, {"type": "typing", "channel_id": "c"}])
    await socket.chat_ws(ws)

    assert ws.accepted and wired.connected == [("alice", [])] and wired.disconnected == ["alice"]
    assert wired.conn.sent == [
        {"type": "pong"},
        {"type": "error", "detail": "Invalid JSON"},
        {"type": "error", "detail": "Unknown type: send_message"},   # 채팅 프레임 — 처리기가 등록되지 않았다
        {"type": "error", "detail": "Unknown type: typing"},
    ]


@pytest.mark.asyncio
async def test_chat_frames_go_to_registered_handlers(monkeypatch, wired):
    monkeypatch.setenv(zones.ENV_VAR, "chat")
    seen: list[tuple[str, str, dict]] = []

    async def fake_handler(ctx, data):
        seen.append((ctx.user_id, ctx.display_name or ctx.username, data))
        ctx.reply({"type": "ack"})

    monkeypatch.setattr(zones, "active_socket_handlers", lambda: {"typing": fake_handler})
    ws = _FakeWS([{"type": "typing", "channel_id": "c1"}, {"type": "nope"}, {"type": 7}])
    await socket.chat_ws(ws)

    assert seen == [("alice", "Alice", {"type": "typing", "channel_id": "c1"})]
    assert wired.conn.sent == [
        {"type": "ack"},
        {"type": "error", "detail": "Unknown type: nope"},
        {"type": "error", "detail": "Unknown type: 7"},
    ]


@pytest.mark.asyncio
async def test_unauthenticated_is_closed(monkeypatch, wired):
    async def _nobody(ws):
        return None

    monkeypatch.setattr(socket, "_authenticate_ws", _nobody)
    ws = _FakeWS([])
    await socket.chat_ws(ws)
    assert ws.closed == 4001 and not ws.accepted and wired.connected == []


@pytest.mark.asyncio
async def test_typing_handler_publishes_with_display_name(monkeypatch):
    """채팅 처리기 — 소켓이 넘긴 연결 정보(ctx)로 예전과 같은 이벤트를 낸다."""
    from app.chat import ws_handlers

    published: list[tuple[str, dict]] = []

    async def _publish_typing(channel_id, data):
        published.append((channel_id, data))

    monkeypatch.setattr(ws_handlers.manager, "publish_typing", _publish_typing)
    ctx = socket.SocketContext(user_id="alice", username="alice", display_name="Alice", conn=_FakeConn())
    await ws_handlers.HANDLERS["typing"](ctx, {"type": "typing", "channel_id": "c1"})
    await ws_handlers.HANDLERS["typing"](ctx, {"type": "typing"})          # 채널 없음 → 아무것도 안 한다
    assert published == [("c1", {"type": "typing", "channel_id": "c1", "user_id": "alice", "username": "Alice"})]

    # 내용이 빈 메시지는 보낸 연결에만 오류로 답한다(DB 를 건드리기 전에)
    await ws_handlers.HANDLERS["send_message"](ctx, {"type": "send_message", "channel_id": "c1", "content": "  "})
    assert ctx.conn.sent == [{"type": "error", "detail": "Missing channel_id or content"}]
