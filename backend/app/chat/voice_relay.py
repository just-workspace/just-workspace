"""음성채널 무손실 티어 — 릴레이 입장 토큰 발급.

``POST /api/chat/channels/{id}/voice/relay-token``  body(선택) ``{"identity": "<LiveKit identity>"}``
음성 채널 멤버인지 확인하고 ws-audiorelay 가 검증할 짧은 HMAC 토큰(120 s)과 접속 정보를 돌려준다.
릴레이가 꺼져 있거나(프로파일 미활성·시크릿 없음) 닿지 않으면 503 — 클라이언트는 음악 티어로 내려간다.

presence 는 Phase 1 과 같은 흐름(app/chat/voice.py)을 그대로 쓴다: 무손실 클라이언트도 LiveKit 방에 들어가
(Opus 호환 스트림 publish) ``/voice/state`` 로 tier='lossless' 를 알린다. 여기서 받는 ``identity`` 는 그 LiveKit
identity 로, 내 것인지(voice._owned_identity) 확인한 뒤 토큰 claims 에 실어 릴레이 피어 ↔ LiveKit 참가자를 짝지을 수 있게 한다.

접속 정보의 정본은 릴레이 자신(``GET http://audiorelay:8090/audiorelay/info``): WebTransport 주소·자가서명 cert_hash 를
여기서 그대로 전달한다(5 s 캐시). 백엔드는 릴레이의 인증서 상태를 따로 알 필요가 없다.
"""
# ※ from __future__ import annotations 금지 — Pydantic 본문 모델이 쿼리로 오인된다(internal_router 참고).

import logging
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.chat import relay_token, voice
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat", tags=["chat-voice"])

_INFO_TTL = 5.0
_info_cache: dict = {"at": 0.0, "info": None}


class RelayTokenRequest(BaseModel):
    identity: str | None = Field(None, min_length=1, max_length=64)


def is_configured() -> bool:
    s = get_settings()
    return bool(getattr(s, "audiorelay_secret", "") and len(s.audiorelay_secret) >= 16 and s.audiorelay_url)


async def fetch_relay_info() -> dict | None:
    """릴레이 /info. 실패하면 None(캐시는 성공값만)."""
    s = get_settings()
    now = time.monotonic()
    if _info_cache["info"] is not None and now - _info_cache["at"] < _INFO_TTL:
        return _info_cache["info"]
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(s.audiorelay_url.rstrip("/") + "/audiorelay/info")
            r.raise_for_status()
            info = r.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("audiorelay /info 실패: %s", e)
        return None
    _info_cache["info"], _info_cache["at"] = info, now
    return info


def _ws_url() -> str:
    s = get_settings()
    url = (s.app_url or "").rstrip("/")
    path = getattr(s, "audiorelay_ws_path", "/audiorelay/ws")
    if url.startswith("https://"):
        return url.replace("https://", "wss://", 1) + path
    if url.startswith("http://"):
        return url.replace("http://", "ws://", 1) + path
    return path


@router.post("/channels/{channel_id}/voice/relay-token")
async def issue_relay_token(
    channel_id: str,
    body: RelayTokenRequest | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not is_configured():
        raise HTTPException(503, "무손실 릴레이가 설정되지 않았습니다")
    await voice._require_voice_channel(db, channel_id, user)   # 404 / 403 / 400(음성 채널 아님)
    identity = body.identity if body else None
    if identity:
        await voice._owned_identity(identity, user)             # 내 LiveKit 접속이 아니면 403
    info = await fetch_relay_info()
    if info is None:
        raise HTTPException(503, "무손실 릴레이에 연결할 수 없습니다")
    s = get_settings()
    room = relay_token.room_for_channel(channel_id)
    tok = relay_token.mint(s.audiorelay_secret, room=room, uid=user.id, name=user.display_name or user.username, identity=identity)
    wt = info.get("webtransport") or None
    return {
        "token": tok,
        "expires_in": relay_token.TTL_SECONDS,
        "room": room,
        "identity": identity,
        "ws_url": _ws_url(),
        "ws_path": getattr(s, "audiorelay_ws_path", "/audiorelay/ws"),
        "webtransport": wt,
        "relay_version": info.get("version"),
        "protocol": info.get("protocol", 1),
    }
