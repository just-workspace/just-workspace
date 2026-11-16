"""연결 해제 표시 — 연결 해제 후에도 이미 발급된 액세스 토큰이 유효하던 문제를 차단한다.

설정 › AI 연동에서 "연결 끊기"를 누르면 리프레시 토큰 사슬만 폐기되었다. 액세스 토큰은 서명·만료·aud 만 검증하는
JWT(1시간)이므로 해당 앱이 최대 1시간 더 읽기·쓰기가 가능했다(MCP 의 low 쓰기는 즉시 실행). 현재는 해제 시각을
Redis 에 기록하고, 그 이전에 발급된(iat) 토큰·그 이전에 열린 연결을 거부한다.

Redis 사용 불가 시 표시와 검사를 모두 생략한다(기존 동작 — MCP 전체가 Redis 에 종속되지 않도록).
"""
import logging
import time

logger = logging.getLogger(__name__)

# 액세스 토큰 수명(1시간)보다 길게 설정 — 구 SSE 연결은 토큰 만료 후에도 열려 있을 수 있어 1일로 둔다
MARK_TTL = 24 * 3600


def _key(user_id: str, client_id: str) -> str:
    return f"mcp:revoked:{user_id}:{client_id}"


async def _redis():
    from app.chat.redis_client import get_redis
    return await get_redis()


async def mark(user_id: str, client_id: str | None) -> None:
    """이 사용자의 이 연결(OAuth client_id 또는 ``pat:<id>``)을 현재 시각에 해제된 것으로 표시한다."""
    if not client_id:
        return
    try:
        r = await _redis()
        await r.set(_key(user_id, client_id), repr(time.time()), ex=MARK_TTL)
    except Exception:  # noqa: BLE001
        logger.warning("[mcp] 연결 해제 표시를 남기지 못했습니다(Redis) — 발급된 토큰은 만료까지 유효", exc_info=True)


async def revoked_since(user_id: str, client_id: str | None, issued_at: float | None) -> bool:
    """``issued_at`` (토큰 iat 또는 연결 시각) 이후 이 연결이 해제되었는지 여부. 표시가 있으나 발급 시각을 알 수 없으면 해제된 것으로 간주한다."""
    if not client_id:
        return False
    try:
        r = await _redis()
        raw = await r.get(_key(user_id, client_id))
    except Exception:  # noqa: BLE001
        return False
    if not raw:
        return False
    try:
        at = float(raw.decode() if isinstance(raw, bytes) else raw)
    except (TypeError, ValueError):
        return True
    return issued_at is None or float(issued_at) < at
