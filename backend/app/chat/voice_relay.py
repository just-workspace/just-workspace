"""음성채널 무손실 티어 — 릴레이 입장 토큰 발급.

``POST /api/chat/channels/{id}/voice/relay-token``  body(선택) ``{"identity": "<LiveKit identity>"}``
음성 채널 멤버 여부를 확인하고 ws-audiorelay 가 검증할 단기 HMAC 토큰(120 s)과 접속 정보를 반환한다.
릴레이가 비활성 상태이거나(프로파일 미활성·시크릿 없음) 연결할 수 없으면 503 — 클라이언트는 음악 티어로 fallback 한다.

presence 는 음성 채널과 동일한 흐름(app/chat/voice.py)을 그대로 사용한다: 무손실 클라이언트도 LiveKit 방에 입장하여
(Opus 호환 스트림 publish) ``/voice/state`` 로 tier='lossless' 를 보고한다. 여기서 수신하는 ``identity`` 는 해당 LiveKit
identity 이며, 요청자 소유인지(voice._owned_identity) 확인한 뒤 토큰 claims 에 포함하여 릴레이 피어 ↔ LiveKit 참가자를 대응시킬 수 있게 한다.

접속 정보의 정본은 릴레이 자체(``GET http://audiorelay:8090/audiorelay/info``)이다: WebTransport 주소·자가서명 cert_hash 를
여기서 그대로 전달한다(5 s 캐시). 백엔드는 릴레이의 인증서 상태를 별도로 파악할 필요가 없다.
"""
# from __future__ import annotations 금지 — Pydantic 본문 모델이 쿼리로 오인됨(internal_router 참고).

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
from app.security_defaults import KEY_MIN

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat", tags=["chat-voice"])

_INFO_TTL = 5.0
_info_cache: dict = {"at": 0.0, "info": None}


class RelayTokenRequest(BaseModel):
    identity: str | None = Field(None, min_length=1, max_length=64)


def is_configured() -> bool:
    s = get_settings()
    return bool(getattr(s, "audiorelay_secret", "") and len(s.audiorelay_secret) >= KEY_MIN and s.audiorelay_url)


async def fetch_relay_info() -> dict | None:
    """릴레이 /info 조회. 실패 시 None(캐시는 성공값만)."""
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
        await voice._owned_identity(identity, user)             # 요청자의 LiveKit 접속이 아니면 403
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
