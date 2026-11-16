"""워커 간 Yjs 릴레이.

필요성
-----------
백엔드는 uvicorn 워커 8개로 기동된다. 방 목록을 프로세스 메모리에만 두면 두 사용자가 서로
다른 워커에 접속하는 순간 편집 내용이 상대에게 **영구히** 전달되지 않는다. 양측 화면에 모두 "실시간
연결됨" 으로 표시되므로 증상 파악이 더욱 어렵다.

따라서 수신한 프레임을 항상 Redis pub/sub 으로 발행하고, 각 워커는 자신의 소켓에만 전달한다.
발신자 식별자(conn_id)를 함께 포함하여 발신 프레임이 발신자에게 되돌아오지 않도록 한다.

Redis 장애 시에는 동일 워커 내에서만 중계한다 — 협업이 완전히 중단되는 것보다 낫다.

사용 방법
-------
    relay = Relay("docs:collab")
    entry = await relay.join(path, ws, user.id)
    ...
    await relay.publish(path, entry, data)
    ...
    await relay.leave(path, entry)

문서(docs)와 위키(wiki)가 동일한 구현을 사용한다. 방 키만 상이하다(가상 경로 / 페이지 id).
"""

import asyncio
import base64
import json
import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass

from starlette.websockets import WebSocket, WebSocketState

from app.chat.redis_client import get_redis

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Member:
    ws: WebSocket
    member_id: str      # 통상 user.id — 프레즌스 정리에 사용
    conn_id: str        # 소켓 1개의 식별자


class Relay:
    def __init__(self, channel: str):
        self.channel = channel
        self._rooms: dict[str, set[Member]] = defaultdict(set)
        self._fanout: asyncio.Task | None = None

    # ── 방 ──────────────────────────────────────────────

    async def join(self, room: str, ws: WebSocket, member_id: str) -> Member:
        await self._ensure_fanout()
        m = Member(ws=ws, member_id=member_id, conn_id=uuid.uuid4().hex)
        self._rooms[room].add(m)
        return m

    def leave(self, room: str, m: Member) -> None:
        bucket = self._rooms.get(room)
        if not bucket:
            return
        bucket.discard(m)
        if not bucket:
            self._rooms.pop(room, None)

    def local_size(self, room: str) -> int:
        """이 워커에 접속된 수. 전체 인원은 프레즌스(Redis) 기준이다."""
        return len(self._rooms.get(room, set()))

    def has_member(self, room: str, member_id: str) -> bool:
        """동일 사용자가 이 워커에 아직 접속되어 있는지 여부(다른 탭 등)."""
        return any(m.member_id == member_id for m in self._rooms.get(room, set()))

    # ── 중계 ────────────────────────────────────────────

    async def publish(self, room: str, sender: Member, data: bytes) -> None:
        envelope = json.dumps({
            "r": room,
            "s": sender.conn_id,
            "d": base64.b64encode(data).decode("ascii"),
        })
        try:
            redis = await get_redis()
            await redis.publish(self.channel, envelope)
            return
        except Exception as e:
            logger.warning("relay %s: publish failed, local only: %s", self.channel, e)
        # Redis 발행이 성공하면 fanout 이 이 워커에도 되돌려 전달하므로 여기서 다시 송신하면
        # 동일 프레임이 2회 전달된다. 실패한 경우에만 직접 전달한다.
        await self._deliver(room, sender.conn_id, data)

    async def _deliver(self, room: str, src: str, data: bytes) -> None:
        targets = [
            m.ws for m in self._rooms.get(room, set())
            if m.conn_id != src and m.ws.client_state == WebSocketState.CONNECTED
        ]
        if targets:
            await asyncio.gather(*[_safe_send(ws, data) for ws in targets])

    async def _ensure_fanout(self) -> None:
        if self._fanout is None or self._fanout.done():
            self._fanout = asyncio.create_task(self._fanout_loop())

    async def _fanout_loop(self) -> None:
        try:
            redis = await get_redis()
            pubsub = redis.pubsub(ignore_subscribe_messages=True)
            await pubsub.subscribe(self.channel)
        except Exception as e:
            logger.warning("relay %s: subscribe failed: %s", self.channel, e)
            return

        logger.info("relay %s: fanout subscribed", self.channel)
        try:
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                try:
                    payload = json.loads(msg["data"])
                    data = base64.b64decode(payload["d"])
                except Exception:
                    continue
                await self._deliver(payload.get("r", ""), payload.get("s", ""), data)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # 다음 접속 시 재기동된다. 여기서 실패해도 프로세스 종료로 이어져서는 안 된다.
            logger.warning("relay %s: fanout stopped: %s", self.channel, e)
        finally:
            try:
                await pubsub.aclose()
            except Exception:
                pass


async def _safe_send(ws: WebSocket, data: bytes) -> None:
    try:
        await ws.send_bytes(data)
    except Exception:
        pass
