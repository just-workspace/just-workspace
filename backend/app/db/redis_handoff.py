"""Redis 에만 있던 값을 DB 로 — 기동할 때 한 번 훑는다.

개인 잠금 PIN, POP3 의 읽음·별표, 새 메일 감시의 마지막 UID 는 예전에 Redis 에만 있었다(백업에 들지 않는다).
각 코드는 처음 읽을 때 스스로 옮기지만(app/privacy/gate.py, app/mail/pop3_client.py, app/mail/poller.py),
그것만으로는 "업데이트한 뒤 한 번도 읽히지 않은 값"이 Redis 에 남는다 — 그 상태로 백업해 서버를 옮기면 잃는다.
그래서 서버가 뜰 때 남은 것을 마저 옮긴다. 옮기는 방법은 각 모듈의 것을 그대로 쓴다(여러 번 돌아도 같다).

Redis 의 예전 키는 지우지 않는다 — 이유는 docs/data-safety.md 의 "Redis 에서 DB 로 옮긴 값".
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from app.chat.redis_client import get_redis
from app.db.models import MailAccount, PrivacyPin
from app.db.session import async_session

logger = logging.getLogger(__name__)

_LOCK_KEY = "handoff:redis-to-db:lock"
_LOCK_TTL = 600        # 워커 여럿 가운데 하나만 훑는다
_START_DELAY = 20      # 기동 안정화 대기(초)


async def sweep() -> dict[str, int]:
    """남은 값을 옮긴다. 옮긴 건수를 돌려준다."""
    from app.mail import poller, pop3_client
    from app.privacy import gate

    redis = await get_redis()
    moved = {"pins": 0, "pop3_accounts": 0, "last_uids": 0}

    # 개인 잠금 PIN — DB 에 없는 사용자의 키만
    async with async_session() as db:
        have = set((await db.execute(select(PrivacyPin.user_id))).scalars().all())
    prefix = gate._pin_key("")
    async for key in redis.scan_iter(match=prefix + "*"):
        if isinstance(key, (bytes, bytearray)):
            key = key.decode()
        uid = key[len(prefix):]
        if not uid or uid in have:
            continue
        try:
            if await gate._pin_hash(uid):       # 읽으면 옮겨진다. 지워진 사용자의 키는 옮겨지지 않는다
                moved["pins"] += 1
        except Exception as e:  # noqa: BLE001 — 하나가 막혀도 나머지는 옮긴다
            logger.warning("[handoff] PIN 을 옮기지 못했습니다(%s): %s", uid, e)

    async with async_session() as db:
        accounts = list((await db.execute(select(MailAccount))).scalars().all())
    for acc in accounts:
        try:
            if acc.protocol == "pop3":
                if not acc.pop3_state_imported:
                    await pop3_client._ensure_imported(acc.id)
                    moved["pop3_accounts"] += 1
            elif not acc.last_seen_uid:
                if await poller._load_last_seen(redis, acc):
                    moved["last_uids"] += 1
        except Exception as e:  # noqa: BLE001
            logger.warning("[handoff] 메일 계정 %s 의 값을 옮기지 못했습니다: %s", acc.id, e)
    return moved


async def run_handoff() -> None:
    """기동 뒤 한 번. 실패해도 서버는 그대로 돈다 — 각 값은 처음 읽힐 때 다시 옮겨진다."""
    await asyncio.sleep(_START_DELAY)
    try:
        redis = await get_redis()
        if not await redis.set(_LOCK_KEY, "1", nx=True, ex=_LOCK_TTL):
            return
        moved = await sweep()
        if any(moved.values()):
            logger.info(
                "[handoff] Redis 에만 있던 값을 DB 로 옮겼습니다 — PIN %d, POP3 계정 %d, 새 메일 감시 위치 %d",
                moved["pins"], moved["pop3_accounts"], moved["last_uids"],
            )
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("[handoff] 옮기는 중 오류")
