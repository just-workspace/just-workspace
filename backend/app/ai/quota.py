"""내장 AI 하루 요청 한도 — 채팅 생성 횟수 카운터.

예전엔 "최근 24시간에 남아 있는 사용자 메시지 행 수"로 셌다. 대화를 지우면(임시 대화는 나가기만 해도 지워진다)
행이 사라져 한도가 되살아났고, 다시 만들기·이어 받기는 사용자 메시지를 만들지 않아 아예 세지 않았다.
이제 Redis 일별 키(사용자 시간대의 오늘)에 생성 한 번마다 +1 한다 — 행 삭제와 무관하다.
Redis 를 못 쓰면 예전 방식(행 수)으로 센다.
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
    """오늘 쓴 채팅 생성 횟수(질문·질문 수정·다시 만들기). Redis 를 못 읽으면 최근 24시간 사용자 메시지 수."""
    try:
        r = await _redis()
        v = await r.get(_key(user))
        return int(v or 0)
    except Exception:  # noqa: BLE001
        return await _rows_24h(db, user)


async def chat_count(user) -> None:
    """생성 한 번을 센다(답변 작업을 띄우기 직전). Redis 가 없으면 아무것도 안 한다 — 행 수가 대신 센다."""
    try:
        r = await _redis()
        k = _key(user)
        await r.incr(k)
        await r.expire(k, KEY_TTL)
    except Exception:  # noqa: BLE001
        pass
