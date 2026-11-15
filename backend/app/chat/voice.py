"""음성 채널 — 디스코드식 상시 음성 방 + "누가 들어가 있나".

채널(`channels.is_voice`)마다 LiveKit 방 `voice-<채널id>` 하나. 거는 통화(chan-, app/meetings/calls.py)와
달리 벨이 없고 누르면 바로 붙는다. 토큰·권한은 채널 멤버십과 똑같다(is_channel_member).

접속 상태(presence)는 세 경로로 맞춘다 — 전부 "LiveKit 에 그 방 참가자를 다시 묻는다"로 끝난다.
1. **클라이언트 보고** `POST .../voice/state`·`/voice/leave` — 들어가자마자·음소거/듣기 끔을 바꿀 때·나갈 때.
   음소거·듣기 끔·음질 단계는 LiveKit 웹훅이 알려 주지 않으므로 이 경로만이 즉시 반영한다.
2. **웹훅**(participant_joined/left, room_finished) — app/meetings/calls.py 가 `voice-` 방을 여기로 넘긴다.
3. **대조 루프**(30초, calls.run_call_state_loop 와 같은 Redis 락) — 놓친 이벤트·죽은 탭 정리.

상태는 Redis 에 두어 uvicorn 워커 8개가 같은 것을 본다. 바뀐 채널만 채팅 소켓 이벤트
`voice_state {channel_id, participants:[{identity,user_id,name,avatar_url,muted,deafened,tier,joined_at}], since}` 로 알린다.

identity 는 세션마다 다른 불투명 값(livekit.session_identity)이라, 토큰을 줄 때 identity → 사용자 정보를
Redis 에 24시간 적어 두고(voice:ident:*) 참가자 목록을 사람으로 바꾼다.
"""

import json
import logging
import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.chat import service
from app.chat.redis_client import get_redis
from app.chat.schemas import VoiceLeave, VoiceStateUpdate
from app.db.models import User
from app.db.session import get_db
from app.meetings import livekit
from app.realtime.events import emit_to_channel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["chat-voice"])

PREFIX = "voice-"
STATE_KEY = "voice:state"             # hash: channel_id → {"participants": [...], "since": epoch}
IDENT_KEY = "voice:ident:{}"          # identity → {"user_id", "name", "avatar_url"}
FLAGS_KEY = "voice:flags:{}"          # identity → {"muted", "deafened", "tier"}
IDENT_TTL = 24 * 3600
MAX_PARTICIPANTS = 50


def room_of(channel_id: str) -> str:
    return f"{PREFIX}{channel_id}"


def channel_of(room: str) -> str | None:
    return room[len(PREFIX):] if room.startswith(PREFIX) else None


async def _require_voice_channel(db: AsyncSession, channel_id: str, user: User):
    ch = await service.get_channel(db, channel_id)
    if not ch:
        raise HTTPException(404, "채널을 찾을 수 없습니다")
    from app.chat import permissions as perms
    if not await perms.allowed(db, user, "voice.connect", ch):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    if not ch.is_voice:
        raise HTTPException(400, "음성 채널이 아닙니다")
    return ch


# ─── 참가자 목록 만들기 ───

async def _people(room: str) -> list[dict]:
    """그 방의 LiveKit 참가자를 사람 정보·상태 깃발과 합친다. 녹화 봇은 뺀다."""
    try:
        parts = await livekit.list_participants(room)
    except Exception:
        return []   # 방이 없다(아무도 없다)
    parts = [p for p in parts if not str(p.get("identity", "")).startswith("EG_")]
    if not parts:
        return []
    r = await get_redis()
    idents = [p["identity"] for p in parts]
    infos = await r.mget([IDENT_KEY.format(i) for i in idents])
    flags = await r.mget([FLAGS_KEY.format(i) for i in idents])
    out: list[dict] = []
    for p, raw_info, raw_flags in zip(parts, infos, flags):
        info = json.loads(raw_info) if raw_info else {}
        fl = json.loads(raw_flags) if raw_flags else {}
        out.append({
            "identity": p["identity"],
            "user_id": info.get("user_id"),
            "name": info.get("name") or p.get("name") or "",
            "avatar_url": info.get("avatar_url"),
            # 클라이언트 보고가 있으면 그것, 없으면 LiveKit 트랙 음소거(마이크 끔 = 트랙 mute)
            "muted": bool(fl.get("muted", p.get("mic_muted", False))),
            "deafened": bool(fl.get("deafened", False)),
            "tier": fl.get("tier") or "voice",
            "joined_at": p.get("joined_at") or 0,
        })
    out.sort(key=lambda x: (x["joined_at"], x["identity"]))
    return out[:MAX_PARTICIPANTS]


async def _apply(channel_id: str, participants: list[dict]) -> None:
    """한 채널의 상태를 정하고, 바뀌었으면 알린다."""
    r = await get_redis()
    raw = await r.hget(STATE_KEY, channel_id)
    before = json.loads(raw) if raw else None
    if participants:
        now = {
            "participants": participants,
            "since": (before or {}).get("since") or int(time.time()),
        }
        if before and before.get("participants") == participants:
            return
        await r.hset(STATE_KEY, channel_id, json.dumps(now))
    else:
        if not before:
            return
        await r.hdel(STATE_KEY, channel_id)
        now = None
    await emit_to_channel(channel_id, {
        "type": "voice_state",
        "channel_id": channel_id,
        "participants": (now or {}).get("participants", []),
        "since": (now or {}).get("since"),
    })


async def refresh_room(room: str) -> None:
    ch = channel_of(room)
    if ch:
        await _apply(ch, await _people(room))


async def clear_room(room: str) -> None:
    ch = channel_of(room)
    if ch:
        await _apply(ch, [])


async def reconcile() -> None:
    """LiveKit 방 목록과 저장된 상태를 맞춘다(calls.run_call_state_loop 가 락 안에서 부른다)."""
    r = await get_redis()
    known = set(await r.hkeys(STATE_KEY))
    live: set[str] = set()
    for room in await livekit.list_rooms():
        ch = channel_of(room["name"])
        if not ch:
            continue
        live.add(ch)
        await _apply(ch, await _people(room["name"]))
    for ch in known - live:
        await _apply(ch, [])


async def close_channel(channel_id: str) -> None:
    """채널이 지워졌다 — 방을 닫고 상태를 지운다. 어느 쪽이 실패해도 조용히."""
    try:
        if livekit.is_configured():
            await livekit.delete_room(room_of(channel_id))
    except Exception as e:
        logger.debug("voice room close 실패(%s): %s", channel_id, e)
    try:
        await _apply(channel_id, [])
    except Exception as e:
        logger.debug("voice state clear 실패(%s): %s", channel_id, e)


async def _owned_identity(identity: str, user: User) -> dict:
    """이 identity 가 요청자 것인가(토큰 발급 때 적어 둔 것). 아니면 403."""
    r = await get_redis()
    raw = await r.get(IDENT_KEY.format(identity))
    info = json.loads(raw) if raw else None
    if not info or info.get("user_id") != str(user.id):
        raise HTTPException(403, "내 접속이 아닙니다")
    return info


# ─── API ───

@router.post("/channels/{channel_id}/voice/token")
async def voice_token(
    channel_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """음성 채널 입장 토큰. 채널 멤버면 누구나, 벨 없이 바로."""
    if not livekit.is_configured():
        raise HTTPException(503, "회의 서버가 설정되지 않았습니다")
    await _require_voice_channel(db, channel_id, user)
    room = room_of(channel_id)
    identity = livekit.session_identity(user.id)
    name = user.display_name or user.username
    token = livekit.generate_token(room=room, identity=identity, name=name)
    r = await get_redis()
    await r.set(
        IDENT_KEY.format(identity),
        json.dumps({"user_id": str(user.id), "name": name, "avatar_url": getattr(user, "avatar_url", None)}),
        ex=IDENT_TTL,
    )
    return {"token": token, "livekit_url": livekit.get_ws_url(), "room": room, "identity": identity}


@router.post("/channels/{channel_id}/voice/state")
async def voice_state(
    channel_id: str,
    body: VoiceStateUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """내 음소거·듣기 끔·음질 단계를 알린다(들어간 직후에도 한 번). 그 방 상태를 LiveKit 에 다시 묻고 알린다."""
    await _require_voice_channel(db, channel_id, user)
    await _owned_identity(body.identity, user)
    r = await get_redis()
    await r.set(
        FLAGS_KEY.format(body.identity),
        json.dumps({"muted": body.muted, "deafened": body.deafened, "tier": body.tier}),
        ex=IDENT_TTL,
    )
    await refresh_room(room_of(channel_id))
    raw = await r.hget(STATE_KEY, channel_id)
    return json.loads(raw) if raw else {"participants": [], "since": None}


@router.post("/channels/{channel_id}/voice/leave")
async def voice_leave(
    channel_id: str,
    body: VoiceLeave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """나갔다 — 깃발을 지우고 방 상태를 다시 읽는다(웹훅보다 먼저 와도, 뒤에 와도 결과는 같다)."""
    await _require_voice_channel(db, channel_id, user)
    await _owned_identity(body.identity, user)
    r = await get_redis()
    await r.delete(FLAGS_KEY.format(body.identity))
    await refresh_room(room_of(channel_id))
    return {"ok": True}


@router.get("/voice/states")
async def voice_states(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """내가 속한 음성 채널의 접속 상태 전부 — 화면을 처음 열 때·재접속 때."""
    mine = {c["id"] for c in await service.get_user_channels(db, user.id) if c.get("is_voice")}
    if not mine:
        return {}
    r = await get_redis()
    raw = await r.hgetall(STATE_KEY)
    return {k: json.loads(v) for k, v in raw.items() if k in mine}
