"""연결 해제 표시 — 연결을 끊은 뒤에도 이미 발급된 액세스 토큰이 통하던 문제를 막는다.

설정 › AI 연동에서 "연결 끊기"를 누르면 리프레시 토큰 사슬만 폐기됐다. 액세스 토큰은 서명·만료·aud 만 보는
JWT(1시간)라 그 앱이 최대 1시간 더 읽고 쓸 수 있었다(MCP 의 low 쓰기는 즉시 실행). 이제 해제 시각을
Redis 에 남기고, 그 전에 발급된(iat) 토큰·그 전에 열린 연결을 거절한다.

Redis 를 못 쓰면 표시도 검사도 건너뛴다(예전 동작 — MCP 전체가 Redis 에 묶이지 않게).
"""
import logging
import time

logger = logging.getLogger(__name__)

# 액세스 토큰 수명(1시간)보다 길게 — 옛 SSE 연결은 토큰 만료 뒤에도 열려 있을 수 있어 하루를 둔다
MARK_TTL = 24 * 3600


def _key(user_id: str, client_id: str) -> str:
    return f"mcp:revoked:{user_id}:{client_id}"


async def _redis():
    from app.chat.redis_client import get_redis
    return await get_redis()


async def mark(user_id: str, client_id: str | None) -> None:
    """이 사용자의 이 연결(OAuth client_id 또는 ``pat:<id>``)을 지금 끊었다."""
    if not client_id:
        return
    try:
        r = await _redis()
        await r.set(_key(user_id, client_id), repr(time.time()), ex=MARK_TTL)
    except Exception:  # noqa: BLE001
        logger.warning("[mcp] 연결 해제 표시를 남기지 못했습니다(Redis) — 발급된 토큰은 만료까지 유효", exc_info=True)


async def revoked_since(user_id: str, client_id: str | None, issued_at: float | None) -> bool:
    """``issued_at`` (토큰 iat 또는 연결 시각) 뒤에 이 연결이 끊겼는가. 표시가 있는데 발급 시각을 모르면 끊긴 것으로 본다."""
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
