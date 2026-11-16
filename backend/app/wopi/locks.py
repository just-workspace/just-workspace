"""Redis-based WOPI file locking."""

import hashlib
import json
import logging

from app.chat.redis_client import get_redis

logger = logging.getLogger(__name__)

LOCK_PREFIX = "wopi:lock:"
LOCK_TTL = 1800  # 30 minutes


def subject(owner_id: str, virtual_path: str) -> str:
    """잠금 대상 — (파일 소유자, 소유자 기준 경로). 사용자별로 동일 이름 문서가 있어도 상이한 잠금이다.

    공유받은 사용자가 연 세션도 토큰의 owner_id·경로가 원 소유자 기준이므로 동일 잠금을 참조한다(공동 편집).
    """
    if not owner_id:
        raise ValueError("lock subject needs owner")
    return f"{owner_id}\x00{virtual_path}"


def _lock_key(lock_subject: str) -> str:
    h = hashlib.sha256(lock_subject.encode()).hexdigest()[:32]
    return f"{LOCK_PREFIX}v2:{h}"


def _safe_json_loads(raw: str | bytes) -> dict | None:
    """Parse JSON safely, returning None on error."""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        logger.warning("Corrupted WOPI lock data: %s", raw[:120] if raw else raw)
        return None


async def acquire_lock(
    virtual_path: str,
    lock_id: str,
    user_id: str,
    user_name: str,
    editor: str = "",
) -> tuple[bool, dict | None]:
    """Try to acquire a lock. Returns (success, existing_lock_or_None)."""
    redis = await get_redis()
    key = _lock_key(virtual_path)

    existing = await redis.get(key)
    if existing:
        data = _safe_json_loads(existing)
        if data is None:
            # Corrupted lock — delete and let caller retry
            await redis.delete(key)
            return False, None
        if data["lock_id"] == lock_id:
            # Same lock — refresh
            await redis.set(key, existing, ex=LOCK_TTL)
            return True, data
        return False, data

    lock_data = {
        "lock_id": lock_id,
        "user_id": user_id,
        "user_name": user_name,
        "editor": editor,
    }
    await redis.set(key, json.dumps(lock_data), ex=LOCK_TTL, nx=True)
    # Verify we got it (race condition guard)
    check = await redis.get(key)
    if check:
        stored = _safe_json_loads(check)
        if stored is None:
            await redis.delete(key)
            return False, None
        if stored["lock_id"] == lock_id:
            return True, stored
        return False, stored
    return False, None


async def refresh_lock(virtual_path: str, lock_id: str) -> bool:
    """Extend lock TTL. Returns True if lock exists and matches."""
    redis = await get_redis()
    key = _lock_key(virtual_path)

    existing = await redis.get(key)
    if not existing:
        return False

    data = _safe_json_loads(existing)
    if data is None:
        await redis.delete(key)
        return False
    if data["lock_id"] != lock_id:
        return False

    await redis.set(key, existing, ex=LOCK_TTL)
    return True


async def release_lock(virtual_path: str, lock_id: str) -> bool:
    """Release a lock. Returns True if released."""
    redis = await get_redis()
    key = _lock_key(virtual_path)

    existing = await redis.get(key)
    if not existing:
        return True

    data = _safe_json_loads(existing)
    if data is None:
        # Corrupted — delete it
        await redis.delete(key)
        return True
    if data["lock_id"] != lock_id:
        return False

    await redis.delete(key)
    return True


async def get_lock(virtual_path: str) -> dict | None:
    """Get current lock info, or None if unlocked."""
    redis = await get_redis()
    key = _lock_key(virtual_path)
    existing = await redis.get(key)
    if not existing:
        return None
    data = _safe_json_loads(existing)
    if data is None:
        await redis.delete(key)
        return None
    return data


async def get_current_lock_id(virtual_path: str) -> str:
    """Get current lock ID, or empty string if unlocked."""
    lock = await get_lock(virtual_path)
    return lock["lock_id"] if lock else ""
