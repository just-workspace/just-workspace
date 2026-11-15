"""워커를 가로지르는 Yjs 릴레이.

왜 필요한가
-----------
백엔드는 uvicorn 워커 8개로 뜬다. 방 목록을 프로세스 메모리에만 두면 두 사람이 서로
다른 워커에 붙는 순간 편집이 상대에게 **영원히** 가지 않는다. 둘 다 화면에는 "실시간
연결됨" 이라고 떠 있어서 증상이 더 고약하다.

그래서 받은 프레임을 무조건 Redis pub/sub 으로 흘리고, 각 워커가 자기 소켓에만 꽂는다.
발신자 표식(conn_id)을 같이 실어서 자기가 보낸 프레임이 자기에게 돌아오지 않게 한다.

Redis 가 죽어 있으면 같은 워커 안에서만 중계한다 — 협업이 아예 멈추는 것보다는 낫다.

쓰는 쪽
-------
    relay = Relay("docs:collab")
    entry = await relay.join(path, ws, user.id)
    ...
    await relay.publish(path, entry, data)
    ...
    await relay.leave(path, entry)

문서(docs)와 위키(wiki)가 같은 구현을 쓴다. 방 키만 다르다(가상 경로 / 페이지 id).
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
    member_id: str      # 보통 user.id — 프레즌스 정리에 쓴다
    conn_id: str        # 이 소켓 하나의 식별자


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
        """이 워커에 붙어 있는 수. 전체 인원은 프레즌스(Redis)가 답이다."""
        return len(self._rooms.get(room, set()))

    def has_member(self, room: str, member_id: str) -> bool:
        """같은 사용자가 이 워커에 아직 붙어 있는가(다른 탭 등)."""
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
        # Redis 가 받아 줬으면 fanout 이 이 워커에도 되돌려 주므로 여기서 또 보내면
        # 같은 프레임이 두 번 간다. 실패했을 때만 직접 뿌린다.
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
            # 다음 접속이 다시 띄운다. 여기서 죽어도 프로세스를 끌고 가면 안 된다.
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
