"""무손실 음성 릴레이(ws-audiorelay) 토큰 — HMAC-SHA256, 릴레이와 포맷 공유.

형식: ``base64url(JSON claims) "." base64url(HMAC-SHA256(secret, base64url(JSON claims)))``
claims: ``{"room","uid","name","identity"?,"iat","exp","nonce"}`` (키 순서 고정 — Go 쪽 ``token.Claims`` 와 같다).

릴레이는 DB 가 없다. 채널 멤버십은 여기(백엔드)가 발급 전에 확인하고, 릴레이는 서명·만료만 본다.
벡터: backend/tests/test_voice_relay.py ↔ audiorelay/internal/token/token_test.go (한쪽이 바뀌면 둘 다 깨진다).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

TTL_SECONDS = 120


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def room_for_channel(channel_id: str) -> str:
    return f"voice-{channel_id}"


def mint(secret: str, *, room: str, uid: str, name: str = "", identity: str | None = None, ttl: int = TTL_SECONDS,
         now: int | None = None, nonce: str | None = None) -> str:
    if not secret:
        raise ValueError("AUDIORELAY_SECRET is empty")  # 길이(≥16) 검사는 voice_relay.is_configured 와 릴레이 기동이 한다
    iat = int(now if now is not None else time.time())
    claims: dict = {"room": room, "uid": uid, "name": name}
    if identity:
        claims["identity"] = identity   # 같은 세션의 LiveKit identity(음성 presence 키) — 선택
    claims.update({"iat": iat, "exp": iat + ttl, "nonce": nonce if nonce is not None else secrets.token_urlsafe(8)})
    enc = _b64(json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode())
    sig = hmac.new(secret.encode(), enc.encode(), hashlib.sha256).digest()
    return f"{enc}.{_b64(sig)}"


def verify(secret: str, token: str, now: int | None = None) -> dict:
    """서명·만료 검증(릴레이와 같은 규칙, 5 s 여유). 실패하면 ValueError."""
    if not secret or "." not in token:
        raise ValueError("malformed")
    enc, sig = token.split(".", 1)
    want = hmac.new(secret.encode(), enc.encode(), hashlib.sha256).digest()
    try:
        got = _unb64(sig)
    except Exception as e:  # noqa: BLE001
        raise ValueError("malformed") from e
    if not hmac.compare_digest(want, got):
        raise ValueError("bad signature")
    claims = json.loads(_unb64(enc))
    if not claims.get("room") or not claims.get("uid") or not claims.get("exp"):
        raise ValueError("missing claims")
    if int(now if now is not None else time.time()) > int(claims["exp"]) + 5:
        raise ValueError("expired")
    return claims
