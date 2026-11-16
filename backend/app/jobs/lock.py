"""백그라운드 잡 배타 락 — Redis `SET NX EX`.

백엔드는 uvicorn 워커 8개로 실행된다. lifespan 에서 기동하는 루프(리마인더·백업·정리)는
워커마다 하나씩 생성되므로, 별도 조치가 없으면 동일 작업이 8번 실행된다(리마인더는
8번 발송). 메일 폴러(`mail:poll:lock`)·색인기(`files:index:lock`)가 각자 사용하던 패턴을
한곳으로 통합한 것이다.

사용법:
    if await try_acquire("calendar:reminder", ttl=55):
        ...한 주기 작업...

    # 또는
    ran = await run_exclusive("files:retention", 3500, do_work)

의도적으로 **락을 해제하지 않는다**(TTL 만료에 위임). "한 주기에 한 워커만"이 목적이므로,
작업이 조기에 종료되어 락을 해제하면 몇 초 뒤 기동한 다른 워커가 동일 주기를 다시 실행한다.
TTL 은 루프 주기보다 약간 짧게 설정하여 다음 주기에는 반드시 한 워커가 획득할 수 있게 한다.
장시간 소요될 수 있는 작업(백업·정리)은 TTL 을 주기에 가깝게 길게 설정한다.

Redis 장애 시에는 **실행하지 않는다**(fail-closed). 중복 발송·중복 삭제보다
한 주기를 건너뛰는 편이 비용이 작고, Redis 장애 시에는 채팅부터 이미 중단된 상태다.
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)

_PREFIX = "job:lock:"


def lock_key(name: str) -> str:
    return f"{_PREFIX}{name}"


async def try_acquire(name: str, ttl: int) -> bool:
    """`name` 잡의 이번 주기 락을 획득하면 True. 이미 획득된 상태이거나 Redis 사용 불가 시 False."""
    if ttl < 1:
        raise ValueError("ttl 은 1초 이상")
    try:
        from app.chat.redis_client import get_redis
        redis = await get_redis()
        got = await redis.set(lock_key(name), "1", nx=True, ex=ttl)
        return bool(got)
    except Exception as e:  # noqa: BLE001 — 락 실패 시 잡을 중지하지 않고 이번 주기만 건너뜀
        logger.warning("[jobs] 락 획득 실패(%s): %s — 이번 주기 건너뜀", name, e)
        return False


async def release(name: str) -> None:
    """락을 명시적으로 해제한다. 통상 TTL 만료에 위임하며 사용하지 않는다(모듈 설명 참고)."""
    try:
        from app.chat.redis_client import get_redis
        redis = await get_redis()
        await redis.delete(lock_key(name))
    except Exception:  # noqa: BLE001
        pass


async def run_exclusive(name: str, ttl: int, fn: Callable[[], Awaitable[object]]) -> bool:
    """락을 획득한 워커만 `fn()` 을 실행한다. 실행한 경우 True.

    `fn` 의 예외는 그대로 전파한다. 호출하는 루프가 자체 방식으로 로깅한다.
    """
    if not await try_acquire(name, ttl):
        return False
    await fn()
    return True
