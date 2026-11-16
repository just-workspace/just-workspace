"""실시간 소켓(`/ws/chat`) — 연결 관리자 + Redis Pub/Sub 전달. 코어 소속.

이 소켓 하나로 알림·배지·통화 상태·채팅 등 모든 실시간 이벤트가 전달된다(발행은
app/realtime/events.py). 경로 이름이 `/ws/chat` 인 것은 기존 클라이언트와의 호환을 위한 것이며,
채팅 구역이 설치되지 않아도 활성화된다.

클라이언트가 송신하는 프레임은 `type` 으로 구분한다. `ping` 은 본 모듈에서 처리하고, 나머지는
구역이 등록한 처리기로 전달한다(app/zones.py 의 `SOCKET_HANDLERS` — 설치된 구역의 처리기만 해당).
처리기가 없는 종류에는 오류 프레임으로 응답한다.
"""

import asyncio
import json
import logging
from dataclasses import dataclass

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db.session import async_session
from app.db.models import User
from app import zones
from app.chat.presence import (
    connection_closed, connection_opened, presence_event, refresh_heartbeat,
)
from app.chat.redis_client import get_redis

logger = logging.getLogger(__name__)
router = APIRouter()

PUBSUB_MSG = "chat:channel:{}"
PUBSUB_PRESENCE = "chat:presence"
PUBSUB_TYPING = "chat:typing:{}"
PUBSUB_NOTIFICATION = "chat:notification:{}"


async def _user_channel_ids(db, user_id: str) -> list[str]:
    """해당 사용자가 구독할 채팅 채널 id. 채팅 구역이 없으면 구독 대상 채널도 없다."""
    if not zones.zone_installed("chat"):
        return []
    from app.chat import service
    return [ch["id"] for ch in await service.get_user_channels(db, user_id)]


class _Conn:
    """소켓 하나 + 전송 큐. 느린 연결 하나가 동일 워커의 타 사용자 전송을 지연시키지 않도록 한다.

    이전에는 Pub/Sub 루프가 `await ws.send_json` 을 순차 호출하여, 한 연결의 TCP 버퍼가 가득 차면
    해당 워커의 전체 연결이 대기했다. 현재는 루프가 큐에 적재만 하고 연결별 writer 가 송신한다.
    """

    MAX = 256          # 큐 상한. 초과 시 연결 종료 — 재접속 시 누락분을 재조회
    SHED_AT = 128      # 절반을 초과해 적체되면 폐기 가능한 항목(타이핑·접속 상태)부터 폐기
    SHEDDABLE = {"typing", "presence"}

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.q: asyncio.Queue = asyncio.Queue(maxsize=self.MAX)
        self.task = asyncio.create_task(self._writer())

    def offer(self, data: dict) -> None:
        if self.q.qsize() >= self.SHED_AT and data.get("type") in self.SHEDDABLE:
            return
        try:
            self.q.put_nowait(data)
        except asyncio.QueueFull:
            logger.warning("WS 전송 큐 가득 참 — 연결을 끊는다(재접속 시 복구)")
            asyncio.create_task(self._close())

    async def _close(self) -> None:
        try:
            await self.ws.close(code=1013, reason="slow consumer")
        except Exception:
            pass

    async def _writer(self) -> None:
        try:
            while True:
                data = await self.q.get()
                await self.ws.send_json(data)
        except asyncio.CancelledError:
            pass
        except Exception:
            # 송신 실패 시 해당 연결은 종료된 것으로 간주. 정리는 수신 루프의 finally 에서 수행
            pass

    def stop(self) -> None:
        self.task.cancel()


class ConnectionManager:
    """이 워커에 연결된 소켓 집합. 한 사용자가 여러 소켓을 가질 수 있다(다중 탭, 데스크톱 셸 + 웹뷰).

    이전에는 user_id → ws 단일 매핑이어서 두 번째 연결이 첫 연결을 덮어쓰고, 먼저 종료된 쪽이
    유지 중인 연결의 엔트리까지 삭제했다(데스크톱 셸이 웹뷰와 상시 충돌).
    """

    def __init__(self):
        self.active: dict[str, dict[WebSocket, _Conn]] = {}  # user_id → {소켓: 연결}
        self.user_channels: dict[str, set[str]] = {}  # user_id → channel_ids
        self._subscriber_task: asyncio.Task | None = None
        # 구독 대상(사용자·채널)이 변경된 경우에만 Redis 구독을 재계산
        self._subs_dirty = asyncio.Event()

    async def connect(self, user_id: str, ws: WebSocket, channel_ids: list[str]) -> _Conn:
        conn = _Conn(ws)
        self.active.setdefault(user_id, {})[ws] = conn
        self.user_channels[user_id] = set(channel_ids)
        self._subs_dirty.set()

        if self._subscriber_task is None or self._subscriber_task.done():
            self._subscriber_task = asyncio.create_task(self._subscribe_loop())
        return conn

    def disconnect(self, user_id: str, ws: WebSocket) -> None:
        conns = self.active.get(user_id)
        if conns is None:
            return
        conn = conns.pop(ws, None)
        if conn:
            conn.stop()
        if not conns:
            self.active.pop(user_id, None)
            self.user_channels.pop(user_id, None)
            self._subs_dirty.set()

    def update_channels(self, user_id: str, channel_ids: set[str]):
        self.user_channels[user_id] = channel_ids
        self._subs_dirty.set()

    async def refresh_channels(self, user_id: str) -> None:
        """멤버십이 변경된 사용자의 구독 채널을 DB 에서 재조회한다(채널 생성·초대·탈퇴·DM)."""
        if user_id not in self.active:
            return
        async with async_session() as db:
            channel_ids = await _user_channel_ids(db, user_id)
        if user_id in self.active:
            self.user_channels[user_id] = set(channel_ids)
            self._subs_dirty.set()

    async def _send_all(self, user_id: str, data: dict) -> None:
        for conn in list(self.active.get(user_id, {}).values()):
            conn.offer(data)

    async def notify_channels_changed(self, user_ids) -> None:
        """멤버십이 변경된 사용자들에게 통지한다. 워커가 복수이므로 사용자 알림 채널(Redis)로 발행한다 —
        해당 사용자의 소켓을 보유한 워커가 구독 채널을 재조회하고 프런트에 channel_update 를 전달한다."""
        for uid in {u for u in user_ids if u}:
            await self.publish_notification(uid, {"type": "channel_update"})

    async def publish_to_channel(self, channel_id: str, data: dict):
        from app.realtime.events import emit_to_channel
        await emit_to_channel(channel_id, data)

    async def publish_presence(self, data: dict):
        r = await get_redis()
        await r.publish(PUBSUB_PRESENCE, json.dumps(data))

    async def publish_typing(self, channel_id: str, data: dict):
        r = await get_redis()
        await r.publish(PUBSUB_TYPING.format(channel_id), json.dumps(data))

    async def publish_notification(self, user_id: str, data: dict):
        from app.realtime.events import emit_to_user
        await emit_to_user(user_id, data)

    async def _subscribe_loop(self):
        """Background subscriber that routes Pub/Sub messages to local WS connections."""
        r = await get_redis()
        pubsub = r.pubsub()
        subscribed_channels: set[str] = set()

        try:
            # Subscribe to presence channel
            await pubsub.subscribe(PUBSUB_PRESENCE)

            self._subs_dirty.set()
            while True:
                # 구독 대상이 변경된 경우에만 재계산(이전에는 0.5초마다 전체를 재계산)
                if self._subs_dirty.is_set():
                    self._subs_dirty.clear()
                    needed = set()
                    for uid, chs in list(self.user_channels.items()):
                        for ch in chs:
                            needed.add(PUBSUB_MSG.format(ch))
                            needed.add(PUBSUB_TYPING.format(ch))
                        needed.add(PUBSUB_NOTIFICATION.format(uid))

                    to_sub = needed - subscribed_channels
                    to_unsub = subscribed_channels - needed

                    if to_sub:
                        await pubsub.subscribe(*to_sub)
                        subscribed_channels.update(to_sub)
                    if to_unsub:
                        await pubsub.unsubscribe(*to_unsub)
                        subscribed_channels -= to_unsub

                if not self.active:
                    await asyncio.sleep(1)
                    continue

                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.5)
                if msg is None:
                    continue

                if msg["type"] != "message":
                    continue

                channel_name = msg["channel"]
                try:
                    data = json.loads(msg["data"])
                except (json.JSONDecodeError, TypeError):
                    continue

                if channel_name == PUBSUB_PRESENCE:
                    # Broadcast to all connected users
                    for uid in list(self.active):
                        await self._send_all(uid, data)
                elif channel_name.startswith("chat:channel:"):
                    ch_id = channel_name.split(":", 2)[2]
                    for uid in list(self.active):
                        if ch_id in self.user_channels.get(uid, set()):
                            await self._send_all(uid, data)
                elif channel_name.startswith("chat:typing:"):
                    ch_id = channel_name.split(":", 2)[2]
                    sender_id = data.get("user_id")
                    for uid in list(self.active):
                        if uid != sender_id and ch_id in self.user_channels.get(uid, set()):
                            await self._send_all(uid, data)
                elif channel_name.startswith("chat:notification:"):
                    target_uid = channel_name.split(":", 2)[2]
                    if target_uid in self.active:
                        if data.get("type") == "channel_update":
                            # 구독 채널을 먼저 갱신해야 이후 도착하는 신규 채널 메시지를 수신 가능
                            try:
                                await self.refresh_channels(target_uid)
                            except Exception as e:
                                logger.warning("refresh_channels(%s) 실패: %s", target_uid, e)
                        await self._send_all(target_uid, data)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error("Pub/Sub subscriber error: %s", e)
        finally:
            try:
                await pubsub.unsubscribe()
                await pubsub.aclose()
            except Exception:
                pass


manager = ConnectionManager()


@dataclass
class SocketContext:
    """처리기에 전달하는 연결 정보 — 송신자와 해당 연결로의 응답 수단."""

    user_id: str
    username: str
    display_name: str | None
    conn: _Conn

    def reply(self, data: dict) -> None:
        """송신한 연결에만 응답한다(오류 프레임 등)."""
        self.conn.offer(data)


async def _authenticate_ws(ws: WebSocket) -> str | None:
    """user_id 를 추출한다. 다음 세 가지 출처를 허용한다.

    1. ``ws_session`` 쿠키 — 웹
    2. 서명 세션값 — 번들 클라이언트(쿠키 사용이 불가한 cross-origin)
    3. 1st-party OAuth 액세스 토큰 — **데스크톱 앱**
    2·3 은 ``Sec-WebSocket-Protocol: jw.bearer, jw.token.<base64url>``(신규 클라이언트) 또는 ``?token=``(구 클라이언트).

    데스크톱은 세션 쿠키가 없고 OAuth 로만 인증한다. 알림 토스트를 표시하려면 셸이
    이 소켓에 직접 연결해야 하므로 3번이 필요하다. 임의의 OAuth 토큰을 허용하는 것이 아니라
    ``app.auth.deps`` 의 1st-party 게이트를 그대로 적용한다(MCP 토큰·Gitea SSO 제외).

    쿼리스트링 토큰은 nginx 액세스 로그에는 기록되지 않으나(``$uri``) error_log ``request:`` 필드에는 평문으로 기록된다 —
    따라서 신규 클라이언트는 프로토콜 헤더로 전송한다(app.auth.ws_auth).
    """
    from app.auth.ws_auth import authenticate_ws
    try:
        user = await authenticate_ws(ws)
    except Exception:
        return None
    return user.id if user else None


@router.websocket("/ws/chat")
async def chat_ws(ws: WebSocket):
    user_id = await _authenticate_ws(ws)
    if not user_id:
        await ws.close(code=4001, reason="Unauthorized")
        return

    from app.auth.ws_auth import accept_subprotocol
    await ws.accept(subprotocol=accept_subprotocol(ws))

    # Fetch user info & channels
    async with async_session() as db:
        user = await db.get(User, user_id)
        if not user or not user.is_active:
            await ws.close(code=4001, reason="Unauthorized")
            return
        username = user.username
        display_name = user.display_name

        channel_ids = await _user_channel_ids(db, user_id)

    first = await connection_opened(user_id)
    conn = await manager.connect(user_id, ws, channel_ids)

    # 첫 연결일 때만 온라인을 통지한다(탭 추가 연결은 상태 변화가 아니다).
    # 실효 상태(online/away/dnd)는 DB 의 UserStatus 로 결정한다 — invisible 이면 타 사용자에게 변화가 없으므로 통지하지 않는다.
    if first:
        try:
            async with async_session() as db:
                evt = await presence_event(db, user_id, connected=True)
        except Exception:
            evt = {"type": "presence", "user_id": user_id, "username": username,
                   "status": "online", "state": "online", "emoji": None, "text": None}
        if evt["state"] != "offline":
            await manager.publish_presence(evt)

    ctx = SocketContext(user_id=user_id, username=username, display_name=display_name, conn=conn)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                conn.offer({"type": "error", "detail": "Invalid JSON"})
                continue

            msg_type = data.get("type")

            if msg_type == "ping":
                await refresh_heartbeat(user_id)
                conn.offer({"type": "pong"})
                continue

            handler = zones.active_socket_handlers().get(msg_type) if isinstance(msg_type, str) else None
            if handler is None:
                # 알 수 없는 종류이거나, 해당 종류를 처리하는 구역이 미설치
                conn.offer({"type": "error", "detail": f"Unknown type: {msg_type}"})
                continue
            await handler(ctx, data)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("WebSocket error for user %s: %s", user_id, e)
    finally:
        manager.disconnect(user_id, ws)
        # 해당 사용자의 마지막 연결(전체 워커 합산)이 종료될 때만 오프라인 처리
        if await connection_closed(user_id):
            try:
                async with async_session() as db:
                    evt = await presence_event(db, user_id, connected=False)
            except Exception:
                evt = {"type": "presence", "user_id": user_id, "username": username,
                       "status": "offline", "state": "offline", "emoji": None, "text": None}
            await manager.publish_presence(evt)
