"""채널 통화 상태 — "이 채널에서 지금 N명이 통화 중".

채널 통화는 LiveKit 방 `chan-<채널id>` 로 연다(채팅 헤더의 통화 버튼). 누가 들어가 있는지는
LiveKit 만 알아서 두 경로로 따라간다.

1. **웹훅**(participant_joined / participant_left / room_finished) — LiveKit 이 바로 알려 준다.
   livekit.yaml 의 `webhook.urls` 가 이 엔드포인트를 가리킨다.
   서명(Authorization JWT)을 API 키·시크릿으로 검증한다.
2. **대조 루프**(30초) — 웹훅을 놓쳤거나(백엔드 재시작 중 등) 순서가 뒤바뀌어도 상태가 틀린 채
   남지 않게 LiveKit 방 목록을 다시 읽는다. 워커 8개 중 하나만 돈다(Redis 락).

두 경로 모두 "그 방의 참가자를 LiveKit 에 다시 물어서" 상태를 정한다. 이벤트 내용만 보고
+1/-1 하면 중복·누락 이벤트에 숫자가 어긋난다.

상태는 Redis 해시에 두고(화면을 새로 연 사람이 바로 읽는다), 바뀐 채널만 채팅 실시간 이벤트
`call_state {channel_id, count, names}` 로 알린다.
"""

import asyncio
import json
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.chat.redis_client import get_redis
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.meetings import livekit
from app.realtime.events import emit_to_channel

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/meetings", tags=["meetings-calls"])

PREFIX = "chan-"
STATE_KEY = "call:state"          # hash: channel_id → {"count", "names", "since"}
LOCK_KEY = "lock:call-state"
RECONCILE_INTERVAL = 30           # 초


def _channel_of(room: str) -> str | None:
    return room[len(PREFIX):] if room.startswith(PREFIX) else None


async def _people(room: str) -> list[str]:
    """그 방에 지금 있는 사람 표시 이름들. 녹화(egress) 봇은 뺀다."""
    try:
        people = await livekit.list_participants(room)
    except Exception:
        return []   # 방이 이미 없어졌다
    return [p.get("name") or "" for p in people if not str(p.get("identity", "")).startswith("EG_")]


async def _apply(channel_id: str, names: list[str]) -> None:
    """한 채널의 상태를 정하고, 바뀌었으면 알린다."""
    r = await get_redis()
    raw = await r.hget(STATE_KEY, channel_id)
    before = json.loads(raw) if raw else None
    if names:
        now = {"count": len(names), "names": names[:8], "since": (before or {}).get("since") or int(time.time())}
        if before and before.get("count") == now["count"] and before.get("names") == now["names"]:
            return
        await r.hset(STATE_KEY, channel_id, json.dumps(now))
    else:
        if not before:
            return
        await r.hdel(STATE_KEY, channel_id)
        now = None
    await emit_to_channel(channel_id, {
        "type": "call_state",
        "channel_id": channel_id,
        "count": (now or {}).get("count", 0),
        "names": (now or {}).get("names", []),
        "since": (now or {}).get("since"),
    })


async def refresh_room(room: str) -> None:
    ch = _channel_of(room)
    if ch:
        await _apply(ch, await _people(room))


async def reconcile() -> None:
    """LiveKit 의 방 목록과 저장된 상태를 맞춘다."""
    r = await get_redis()
    known = set(await r.hkeys(STATE_KEY))
    live: set[str] = set()
    for room in await livekit.list_rooms():
        ch = _channel_of(room["name"])
        if not ch:
            continue
        live.add(ch)
        await _apply(ch, await _people(room["name"]))
    for ch in known - live:
        await _apply(ch, [])


async def run_call_state_loop() -> None:
    if not livekit.is_configured():
        return
    while True:
        try:
            r = await get_redis()
            if await r.set(LOCK_KEY, "1", nx=True, ex=RECONCILE_INTERVAL - 5):
                await reconcile()
                # 음성 채널(voice-) 도 같은 락 안에서 — 워커 하나만 LiveKit 을 두드린다
                try:
                    from app.chat import voice
                    await voice.reconcile()
                except Exception as e:
                    logger.debug("voice state reconcile 실패: %s", e)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug("call state reconcile 실패: %s", e)
        await asyncio.sleep(RECONCILE_INTERVAL)


@router.post("/livekit/webhook")
async def livekit_webhook(request: Request):
    """LiveKit 웹훅. 공개 경로로도 닿지만 서명이 맞지 않으면 401 이다."""
    if not livekit.is_configured():
        raise HTTPException(status_code=404)
    from livekit import api

    body = (await request.body()).decode("utf-8", "replace")
    auth = request.headers.get("Authorization", "")
    try:
        receiver = api.WebhookReceiver(api.TokenVerifier(settings.livekit_api_key, settings.livekit_api_secret))
        event = receiver.receive(body, auth)
    except Exception:
        raise HTTPException(status_code=401, detail="invalid webhook signature")

    room = event.room.name if event.room else ""
    # 음성 채널(voice-<채널id>, app/chat/voice.py) — 회의 저장소·채널 통화와 무관하게 그쪽으로
    from app.chat import voice as chat_voice
    if room.startswith(chat_voice.PREFIX):
        if event.event in ("participant_joined", "participant_left", "room_started"):
            await chat_voice.refresh_room(room)
        elif event.event == "room_finished":
            await chat_voice.clear_room(room)
        return {"ok": True}
    if room and not room.startswith(PREFIX) and event.event in ("participant_joined", "room_finished"):
        # 예약 회의 상태(진행 중·종료) — DB 회의 저장소. 실패해도 채널 통화 처리는 계속한다.
        try:
            from app.meetings import repo
            await repo.on_room_event(event.event, room)
        except Exception as e:
            logger.debug("회의 상태 갱신 실패(%s): %s", room, e)
    if room and event.event == "room_finished":
        # 방이 닫히면 녹화(egress)도 끝난다. 상태 키(24시간 TTL)를 남기면 같은 방을 다시 열 때
        # 녹화가 안 도는데도 "녹화 중"으로 보이고 새 녹화도 409 로 막힌다.
        try:
            from app.meetings import store
            await store.clear_active_recording(room)
        except Exception as e:
            logger.debug("녹화 상태 정리 실패(%s): %s", room, e)
    if event.event in ("participant_joined", "participant_left", "room_started"):
        await refresh_room(room)
    elif event.event == "room_finished":
        ch = _channel_of(room)
        if ch:
            await _apply(ch, [])
    return {"ok": True}


@router.get("/channel-calls")
async def channel_calls(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """내가 속한 채널 중 지금 통화가 열려 있는 곳. 화면을 처음 열 때·재접속 때 쓴다."""
    from app.chat import service as chat_service

    mine = {c["id"] for c in await chat_service.get_user_channels(db, user.id)}
    r = await get_redis()
    raw = await r.hgetall(STATE_KEY)
    return {k: json.loads(v) for k, v in raw.items() if k in mine}
