"""Rate limiting configuration.

- 카운터는 Redis 에 둔다 — 백엔드 워커(8개)가 같은 한도를 나눠 쓴다. Redis 가 죽으면 워커별
  메모리로 잠시 대신 센다(인증이 멈추는 것보다 낫다).
- 라우트별 한도(@limiter.limit)는 예전처럼 클라이언트 IP 기준.
- 기본 한도(DefaultRateLimitMiddleware)는 데코레이터가 없는 /api/·/oauth/ 요청 전부에 붙는다.
  키는 서명이 맞는 세션이면 사용자, 아니면 IP — 사무실 NAT 뒤 여러 사람이 한 IP 를 나눠 써도
  서로의 한도를 먹지 않고, 세션값을 지어내 키를 바꾸는 우회는 서명 검사로 막는다.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os

from limits import parse
from limits.storage import MemoryStorage, storage_from_string
from limits.strategies import FixedWindowRateLimiter
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings

logger = logging.getLogger(__name__)
_settings = get_settings()

# 저장소 — 기본은 REDIS_URL. 테스트 등은 RATE_LIMIT_STORAGE_URI=memory:// 로 바꿀 수 있다.
def storage_uri() -> str:
    return os.environ.get("RATE_LIMIT_STORAGE_URI") or _settings.redis_url


STORAGE_URI = storage_uri()
_STORAGE_OPTIONS = {"socket_connect_timeout": 0.5, "socket_timeout": 0.5}     if STORAGE_URI.startswith(("redis://", "rediss://")) else {}

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=STORAGE_URI,
    storage_options=_STORAGE_OPTIONS,
    swallow_errors=True,
    in_memory_fallback_enabled=True,
    key_prefix="rl",
)

# ── 기본 한도 ──

DEFAULT_LIMIT = os.environ.get("RATE_LIMIT_DEFAULT", "600/minute")
_DEFAULT_PREFIXES = ("/api/", "/oauth/")
# 컨테이너 내부 호출(메일서버 → mail-auth 등)·헬스체크는 기본 한도 밖(자체 한도가 있다)
_EXEMPT_PREFIXES = ("/api/internal/", "/api/health")


def _session_user(scope) -> str | None:
    from app.auth.deps import unsign_value

    token = None
    for k, v in scope.get("headers") or []:
        if k == b"cookie" and not token:
            for part in v.decode("latin-1").split(";"):
                part = part.strip()
                if part.startswith("ws_session="):
                    token = part[len("ws_session="):]
                    break
        elif k == b"authorization" and not token:
            val = v.decode("latin-1")
            if val.startswith("Bearer "):
                token = val[7:].strip()
    if not token:
        return None
    data = unsign_value(token)
    if isinstance(data, dict) and data.get("user_id"):
        return str(data["user_id"])
    return None


def default_limit_key(scope) -> str:
    uid = _session_user(scope)
    if uid:
        return "u:" + hashlib.sha256(uid.encode()).hexdigest()[:24]
    client = scope.get("client") or ("", 0)
    return "ip:" + (client[0] or "-")


class DefaultRateLimitMiddleware:
    """데코레이터 없는 라우트에도 기본 한도 — 순수 ASGI(스트리밍 응답을 건드리지 않는다)."""

    def __init__(self, app, limit: str | None = None, storage=None):
        self.app = app
        self.item = parse(limit or DEFAULT_LIMIT)
        self._fallback = FixedWindowRateLimiter(MemoryStorage())
        if storage is None:
            try:
                storage = storage_from_string(STORAGE_URI, **_STORAGE_OPTIONS)
            except Exception as e:  # 드라이버·URL 문제 — 메모리로
                logger.warning("rate limit storage unavailable, using memory: %s", e)
                storage = MemoryStorage()
        self._limiter = FixedWindowRateLimiter(storage)

    def _hit(self, key: str) -> bool:
        try:
            return self._limiter.hit(self.item, "default", key)
        except Exception as e:
            logger.debug("rate limit storage error (memory fallback): %s", e)
            return self._fallback.hit(self.item, "default", key)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not getattr(limiter, "enabled", True):
            return await self.app(scope, receive, send)
        path = scope.get("path") or ""
        if not path.startswith(_DEFAULT_PREFIXES) or path.startswith(_EXEMPT_PREFIXES):
            return await self.app(scope, receive, send)
        if self._hit(default_limit_key(scope)):
            return await self.app(scope, receive, send)
        body = json.dumps({"detail": "Too many requests. Please try again later."}).encode()
        await send({"type": "http.response.start", "status": 429, "headers": [
            (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
            (b"retry-after", b"60"),
        ]})
        await send({"type": "http.response.body", "body": body})
