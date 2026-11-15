"""Chat WebSocket endpoint + ConnectionManager + Redis Pub/Sub."""

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db.session import async_session
from app.db.models import User
from app.chat import service
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


class _Conn:
    """소켓 하나 + 전송 큐. 느린 연결 하나가 같은 워커의 다른 사람 전송을 막지 않게 한다.

    예전엔 Pub/Sub 루프가 `await ws.send_json` 을 차례로 불러서, 한 연결의 TCP 버퍼가 차면
    그 워커의 전원이 기다렸다. 이제 루프는 큐에 넣기만 하고 연결마다 writer 가 보낸다.
    """

    MAX = 256          # 큐 상한. 가득 차면 끊는다 — 재접속하면 R-03 복구가 놓친 것을 다시 읽는다
    SHED_AT = 128      # 반 넘게 밀리면 버려도 되는 것(타이핑·접속 상태)부터 버린다
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
            # 보내다 실패하면 이 연결은 끝난 것 — 수신 루프 쪽 finally 가 정리한다
            pass

    def stop(self) -> None:
        self.task.cancel()


class ConnectionManager:
    """이 워커에 붙은 소켓들. 한 사용자가 여러 소켓을 가질 수 있다(탭 여럿, 데스크톱 셸 + 웹뷰).

    예전엔 user_id → ws 하나라서 두 번째 연결이 첫 연결을 덮어쓰고, 먼저 닫힌 쪽이
    살아 있는 연결의 엔트리까지 지웠다(데스크톱 셸이 늘 웹뷰와 충돌).
    """

    def __init__(self):
        self.active: dict[str, dict[WebSocket, _Conn]] = {}  # user_id → {소켓: 연결}
        self.user_channels: dict[str, set[str]] = {}  # user_id → channel_ids
        self._subscriber_task: asyncio.Task | None = None
        # 구독 대상(사용자·채널)이 바뀌었을 때만 Redis 구독을 다시 계산한다
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
        """멤버십이 바뀐 사용자의 구독 채널을 DB 에서 다시 읽는다(채널 생성·초대·탈퇴·DM)."""
        if user_id not in self.active:
            return
        async with async_session() as db:
            chans = await service.get_user_channels(db, user_id)
        if user_id in self.active:
            self.user_channels[user_id] = {ch["id"] for ch in chans}
            self._subs_dirty.set()

    async def _send_all(self, user_id: str, data: dict) -> None:
        for conn in list(self.active.get(user_id, {}).values()):
            conn.offer(data)

    async def notify_channels_changed(self, user_ids) -> None:
        """멤버십이 바뀐 사용자들에게 알린다. 워커가 여럿이라 사용자 알림 채널(Redis)로 보낸다 —
        그 사용자의 소켓을 가진 워커가 구독 채널을 다시 읽고 프런트에 channel_update 를 넘긴다."""
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
                # 구독 대상이 바뀌었을 때만 다시 계산한다(예전엔 0.5초마다 전체를 다시 셌다)
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
                            # 구독 채널부터 갱신해야 이 뒤에 오는 새 채널 메시지를 받는다
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


async def _authenticate_ws(ws: WebSocket) -> str | None:
    """user_id 를 뽑는다. 세 가지 출처를 받는다.

    1. ``ws_session`` 쿠키 — 웹
    2. 서명 세션값 — 번들 클라이언트(쿠키를 못 쓰는 cross-origin)
    3. 1st-party OAuth 액세스 토큰 — **데스크톱 앱**
    2·3 은 ``Sec-WebSocket-Protocol: jw.bearer, jw.token.<base64url>``(새 클라이언트) 또는 ``?token=``(옛 클라이언트).

    데스크톱은 세션 쿠키가 없고 OAuth 로만 인증한다. 알림 토스트를 띄우려면 셸이
    직접 이 소켓에 붙어야 해서 3번이 필요하다. 어떤 OAuth 토큰이나 받는 게 아니라
    ``app.auth.deps`` 의 1st-party 게이트를 그대로 쓴다(MCP 토큰·Gitea SSO 제외).

    쿼리스트링 토큰은 nginx 액세스 로그엔 안 남지만(``$uri``) error_log ``request:`` 필드엔 평문으로 남는다 —
    그래서 새 클라이언트는 프로토콜 헤더로 보낸다(app.auth.ws_auth).
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

        channels = await service.get_user_channels(db, user_id)
        channel_ids = [ch["id"] for ch in channels]

    first = await connection_opened(user_id)
    conn = await manager.connect(user_id, ws, channel_ids)

    # 첫 연결일 때만 온라인을 알린다(탭을 하나 더 연 건 상태 변화가 아니다).
    # 실효 상태(online/away/dnd)는 DB 의 UserStatus 로 푼다 — invisible 이면 남에게 변화가 없으니 침묵.
    if first:
        try:
            async with async_session() as db:
                evt = await presence_event(db, user_id, connected=True)
        except Exception:
            evt = {"type": "presence", "user_id": user_id, "username": username,
                   "status": "online", "state": "online", "emoji": None, "text": None}
        if evt["state"] != "offline":
            await manager.publish_presence(evt)

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

            elif msg_type == "send_message":
                channel_id = data.get("channel_id")
                content = data.get("content", "").strip()
                message_type = data.get("message_type", "text")
                file_meta = data.get("file_meta")
                parent_id = data.get("parent_id")
                also_to_channel = bool(data.get("also_to_channel", False))   # 답글을 채널에도
                # chat22 — 인라인 답장·답장 대상 알림(기본 켬)·@silent(본문 머리 "@silent " 도 같다)
                reply_to_id = data.get("reply_to_id") or None
                reply_ping = data.get("reply_ping", True) is not False
                from app.chat import msg22
                content, silent_prefix = msg22.split_silent(content)
                silent = bool(data.get("silent", False)) or silent_prefix

                if not channel_id or not content:
                    conn.offer({"type": "error", "detail": "Missing channel_id or content"})
                    continue

                async with async_session() as db:
                    from app.chat import permissions as perms
                    action = "message.reply" if parent_id else "message.send"
                    if not await perms.allowed(db, perms.system_user(user_id), action, channel_id):
                        conn.offer({"type": "error", "detail": "Not a member"})
                        continue
                    try:
                        await msg22.validate_reply(db, channel_id, parent_id, reply_to_id)
                    except msg22.ReplyError as e:
                        conn.offer({"type": "error", "detail": e.message, "code": e.code})
                        continue
                    msg = await service.create_message(
                        db, channel_id, user_id, content,
                        message_type=message_type, file_meta=file_meta,
                        parent_id=parent_id, thread_broadcast=also_to_channel,
                        reply_to_id=reply_to_id,
                        flags=msg22.make_flags(silent=silent, reply_ping=bool(reply_to_id and reply_ping)),
                    )
                    # 실시간 전달·멘션 알림·DM 푸시 — REST 경로와 같은 함수(app/chat/notify.py)
                    from app.chat.notify import after_message_created
                    await after_message_created(db, msg, channel_id, user_id, content)

            elif msg_type == "toggle_reaction":
                message_id = data.get("message_id")
                emoji = data.get("emoji", "").strip()
                if not message_id or not emoji or len(emoji) > 64:
                    conn.offer({"type": "error", "detail": "Missing message_id or emoji"})
                    continue

                async with async_session() as db:
                    from app.db.models import Message as MsgModel
                    msg_obj = await db.get(MsgModel, message_id)
                    if not msg_obj:
                        conn.offer({"type": "error", "detail": "Message not found"})
                        continue
                    from app.chat import permissions as perms
                    if not await perms.allowed(db, perms.system_user(user_id), "reaction.add",
                                               msg_obj.channel_id, message=msg_obj):
                        conn.offer({"type": "error", "detail": "Not a member"})
                        continue
                    from app.chat.emoji22 import check_reaction_emoji
                    if not await check_reaction_emoji(db, emoji):
                        conn.offer({"type": "error", "detail": "Unknown custom emoji", "code": "emoji_not_found"})
                        continue
                    result = await service.toggle_reaction(db, message_id, user_id, emoji)

                await manager.publish_to_channel(msg_obj.channel_id, {
                    "type": "reaction_update",
                    "message_id": message_id,
                    "reactions": result["reactions"],
                })

            elif msg_type == "typing":
                channel_id = data.get("channel_id")
                if channel_id:
                    await manager.publish_typing(channel_id, {
                        "type": "typing",
                        "channel_id": channel_id,
                        "user_id": user_id,
                        "username": display_name or username,
                    })

            elif msg_type == "mark_read":
                channel_id = data.get("channel_id")
                message_id = data.get("message_id")
                if channel_id and message_id:
                    async with async_session() as db:
                        seq = await service.mark_read(db, channel_id, user_id, message_id)
                        u = await db.get(User, user_id)
                        avatar = u.avatar_url if u else None
                    await manager.publish_to_channel(channel_id, {
                        "type": "message_read",
                        "channel_id": channel_id,
                        "user_id": user_id,
                        "username": display_name or username,
                        "avatar_url": avatar,
                        "message_id": message_id,
                        "seq": seq,
                    })
                    if seq is not None:
                        # 내 다른 기기·탭의 배지도 같이 끈다(읽음은 계정 단위)
                        from app.realtime.events import emit_to_user
                        await emit_to_user(user_id, {
                            "type": "channel_read", "channel_id": channel_id, "seq": seq,
                        })

            else:
                conn.offer({"type": "error", "detail": f"Unknown type: {msg_type}"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("WebSocket error for user %s: %s", user_id, e)
    finally:
        manager.disconnect(user_id, ws)
        # 이 사용자의 마지막 연결(모든 워커 합산)이 끊길 때만 오프라인
        if await connection_closed(user_id):
            try:
                async with async_session() as db:
                    evt = await presence_event(db, user_id, connected=False)
            except Exception:
                evt = {"type": "presence", "user_id": user_id, "username": username,
                       "status": "offline", "state": "offline", "emoji": None, "text": None}
            await manager.publish_presence(evt)
