"""백그라운드 잡 배타 락 — Redis `SET NX EX`.

백엔드는 uvicorn 워커 8개로 돈다. lifespan 에서 띄우는 루프(리마인더·백업·정리)는
워커마다 하나씩 생기므로, 아무 조치가 없으면 같은 일이 8번 실행된다(리마인더는
8번 발송). 메일 폴러(`mail:poll:lock`)·색인기(`files:index:lock`)가 각자 쓰던 패턴을
한곳으로 모은 것.

쓰는 법:
    if await try_acquire("calendar:reminder", ttl=55):
        ...한 주기 작업...

    # 또는
    ran = await run_exclusive("files:retention", 3500, do_work)

의도적으로 **락을 풀지 않는다**(TTL 만료에 맡김). "한 주기에 한 워커만"이 목적이라,
작업이 빨리 끝나고 락을 풀면 몇 초 뒤 깨어난 다른 워커가 같은 주기를 또 돈다.
TTL 은 루프 주기보다 조금 짧게 잡아 다음 주기에는 누군가 반드시 잡을 수 있게 한다.
오래 걸릴 수 있는 작업(백업·정리)은 TTL 을 주기 가까이 길게.

Redis 장애 시에는 **실행하지 않는다**(fail-closed). 중복 발송·중복 삭제보다
한 주기 건너뛰는 쪽이 싸고, Redis 가 죽으면 채팅부터 이미 멈춘 상태다.
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)

_PREFIX = "job:lock:"


def lock_key(name: str) -> str:
    return f"{_PREFIX}{name}"


async def try_acquire(name: str, ttl: int) -> bool:
    """`name` 잡의 이번 주기 락을 잡으면 True. 이미 누가 잡았거나 Redis 가 안 되면 False."""
    if ttl < 1:
        raise ValueError("ttl 은 1초 이상")
    try:
        from app.chat.redis_client import get_redis
        redis = await get_redis()
        got = await redis.set(lock_key(name), "1", nx=True, ex=ttl)
        return bool(got)
    except Exception as e:  # noqa: BLE001 — 락 실패는 잡을 멈추지 않고 이번 주기만 건너뛴다
        logger.warning("[jobs] 락 획득 실패(%s): %s — 이번 주기 건너뜀", name, e)
        return False


async def release(name: str) -> None:
    """락을 명시적으로 푼다. 보통은 TTL 만료에 맡기고 쓰지 않는다(모듈 설명 참고)."""
    try:
        from app.chat.redis_client import get_redis
        redis = await get_redis()
        await redis.delete(lock_key(name))
    except Exception:  # noqa: BLE001
        pass


async def run_exclusive(name: str, ttl: int, fn: Callable[[], Awaitable[object]]) -> bool:
    """락을 잡은 워커만 `fn()` 을 실행한다. 실행했으면 True.

    `fn` 의 예외는 그대로 올린다 — 호출하는 루프가 자기 방식으로 로깅한다.
    """
    if not await try_acquire(name, ttl):
        return False
    await fn()
    return True
