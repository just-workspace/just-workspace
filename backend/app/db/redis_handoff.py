"""Redis 전용 값의 DB 이전 — 기동 시 1회 수행한다.

개인 잠금 PIN, POP3 의 읽음·별표, 새 메일 감시의 마지막 UID 는 과거 Redis 에만 저장되었다(백업 미포함).
각 코드는 최초 조회 시 자체적으로 이전하지만(app/privacy/gate.py, app/mail/pop3_client.py, app/mail/poller.py),
이것만으로는 "업데이트한 뒤 한 번도 읽히지 않은 값"이 Redis 에 잔류한다 — 그 상태로 백업하여 서버를 이전하면 유실된다.
따라서 서버 기동 시 잔여 값을 이전한다. 이전 방식은 각 모듈의 구현을 그대로 사용한다(반복 실행해도 결과 동일).

Redis 의 기존 키는 삭제하지 않는다 — 사유는 docs/data-safety.md 의 "Redis 에서 DB 로 옮긴 값".
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
_LOCK_TTL = 600        # 다수 워커 중 하나만 수행
_START_DELAY = 20      # 기동 안정화 대기(초)


async def sweep() -> dict[str, int]:
    """잔여 값을 이전한다. 이전 건수를 반환한다."""
    from app.mail import poller, pop3_client
    from app.privacy import gate

    redis = await get_redis()
    moved = {"pins": 0, "pop3_accounts": 0, "last_uids": 0}

    # 개인 잠금 PIN — DB 에 없는 사용자의 키만 대상
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
            if await gate._pin_hash(uid):       # 조회 시 이전됨. 삭제된 사용자의 키는 이전되지 않음
                moved["pins"] += 1
        except Exception as e:  # noqa: BLE001 — 일부 실패 시에도 나머지는 이전
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
    """기동 후 1회 수행한다. 실패해도 서버 동작에는 영향이 없다 — 각 값은 최초 조회 시 다시 이전된다."""
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
