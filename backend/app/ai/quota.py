"""내장 AI 일일 요청 한도 — 채팅 생성 횟수 카운터.

이전 구현은 "최근 24시간에 남아 있는 사용자 메시지 행 수"를 집계했다. 대화를 삭제하면(임시 대화는 화면 이탈만으로 삭제된다)
행이 제거되어 한도가 복원되었고, 다시 만들기·이어 받기는 사용자 메시지를 생성하지 않아 집계에서 누락되었다.
현재는 Redis 일별 키(사용자 시간대 기준 당일)에 생성 1회마다 +1 한다 — 행 삭제와 무관하다.
Redis 사용 불가 시 이전 방식(행 수)으로 집계한다.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.ai.models import AIMessage

KEY_TTL = 2 * 86400


def _key(user) -> str:
    from app.mcp.tools._common import user_tz

    day = datetime.now(timezone.utc).astimezone(user_tz(user)).strftime("%Y%m%d")
    return f"ai:quota:chat:{user.id}:{day}"


async def _redis():
    from app.chat.redis_client import get_redis
    return await get_redis()


async def _rows_24h(db, user) -> int:
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    return int((await db.execute(select(func.count(AIMessage.id)).where(
        AIMessage.user_id == user.id, AIMessage.role == "user", AIMessage.created_at >= since,
    ))).scalar_one())


async def chat_used(db, user) -> int:
    """당일 채팅 생성 횟수(질문·질문 수정·다시 만들기). Redis 조회 실패 시 최근 24시간 사용자 메시지 수를 반환한다."""
    try:
        r = await _redis()
        v = await r.get(_key(user))
        return int(v or 0)
    except Exception:  # noqa: BLE001
        return await _rows_24h(db, user)


async def chat_count(user) -> None:
    """생성 1회를 집계한다(답변 작업 기동 직전). Redis 사용 불가 시 no-op — 행 수 집계로 대체된다."""
    try:
        r = await _redis()
        k = _key(user)
        await r.incr(k)
        await r.expire(k, KEY_TTL)
    except Exception:  # noqa: BLE001
        pass
