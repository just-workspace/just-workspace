"""음성 채널 — 디스코드식 상시 음성 방 + "누가 들어가 있나".

채널(`channels.is_voice`)마다 LiveKit 방 `voice-<채널id>` 하나. 발신 통화(chan-, app/meetings/calls.py)와
달리 호출음(벨)이 없으며 선택 즉시 접속한다. 토큰·권한은 채널 멤버십과 동일하다(is_channel_member).

접속 상태(presence)는 세 경로로 동기화한다 — 모두 "LiveKit 에 해당 방 참가자를 다시 조회한다"로 귀결된다.
1. **클라이언트 보고** `POST .../voice/state`·`/voice/leave` — 입장 직후·음소거/듣기 끔 변경 시·퇴장 시.
   음소거·듣기 끔·음질 단계는 LiveKit 웹훅으로 전달되지 않으므로 이 경로만 즉시 반영한다.
2. **웹훅**(participant_joined/left, room_finished) — app/meetings/calls.py 가 `voice-` 방을 본 모듈로 전달한다.
3. **대조 루프**(30초, calls.run_call_state_loop 와 동일한 Redis 락) — 누락된 이벤트·종료된 탭 정리.

상태는 Redis 에 저장하여 uvicorn 워커 8개가 동일한 값을 참조한다. 변경된 채널만 채팅 소켓 이벤트
`voice_state {channel_id, participants:[{identity,user_id,name,avatar_url,muted,deafened,tier,joined_at}], since}` 로 전달한다.

identity 는 세션마다 상이한 불투명 값(livekit.session_identity)이므로, 토큰 발급 시 identity → 사용자 정보를
Redis 에 24시간 기록하고(voice:ident:*) 참가자 목록을 사용자 정보로 변환한다.
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


# ─── 참가자 목록 구성 ───

async def _people(room: str) -> list[dict]:
    """해당 방의 LiveKit 참가자를 사용자 정보·상태 플래그와 병합한다. 녹화 봇은 제외한다."""
    try:
        parts = await livekit.list_participants(room)
    except Exception:
        return []   # 방 없음(참가자 없음)
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
            # 클라이언트 보고가 있으면 해당 값, 없으면 LiveKit 트랙 음소거 사용(마이크 끔 = 트랙 mute)
            "muted": bool(fl.get("muted", p.get("mic_muted", False))),
            "deafened": bool(fl.get("deafened", False)),
            "tier": fl.get("tier") or "voice",
            "joined_at": p.get("joined_at") or 0,
        })
    out.sort(key=lambda x: (x["joined_at"], x["identity"]))
    return out[:MAX_PARTICIPANTS]


async def _apply(channel_id: str, participants: list[dict]) -> None:
    """채널 하나의 상태를 확정하고, 변경된 경우 전달한다."""
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
    """LiveKit 방 목록과 저장된 상태를 대조한다(calls.run_call_state_loop 가 락 내부에서 호출)."""
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
    """채널 삭제 시 처리 — 방을 종료하고 상태를 삭제한다. 어느 쪽이 실패해도 무시한다."""
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
    """이 identity 가 요청자 소유인지 확인한다(토큰 발급 시 기록한 값 기준). 아니면 403."""
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
    """음성 채널 입장 토큰. 채널 멤버이면 누구나 호출음(벨) 없이 즉시 입장 가능."""
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
    """본인의 음소거·듣기 끔·음질 단계를 보고한다(입장 직후에도 1회). 해당 방 상태를 LiveKit 에 다시 조회하여 전달한다."""
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
    """퇴장 처리 — 플래그를 삭제하고 방 상태를 다시 조회한다(웹훅보다 먼저 도착하든 나중에 도착하든 결과는 동일)."""
    await _require_voice_channel(db, channel_id, user)
    await _owned_identity(body.identity, user)
    r = await get_redis()
    await r.delete(FLAGS_KEY.format(body.identity))
    await refresh_room(room_of(channel_id))
    return {"ok": True}


@router.get("/voice/states")
async def voice_states(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """호출 사용자가 속한 음성 채널의 접속 상태 전체 — 화면 최초 진입 시·재접속 시 사용."""
    mine = {c["id"] for c in await service.get_user_channels(db, user.id) if c.get("is_voice")}
    if not mine:
        return {}
    r = await get_redis()
    raw = await r.hgetall(STATE_KEY)
    return {k: json.loads(v) for k, v in raw.items() if k in mine}
