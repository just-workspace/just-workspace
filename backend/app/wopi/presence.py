"""문서 편집 프레즌스 — "지금 누가 이 파일을 열고 있나".

WOPI 잠금(locks.py)과는 다른 것이다. 잠금은 **파일당 하나**고 동시편집 중에는
에디터가 대표로 하나만 쥔다. 그래서 잠금만으로는 "몇 명이 보고 있나" 를 알 수 없다.

여기서는 Redis 해시 하나에 `user_id -> {name, color, editor, ts}` 를 담는다.
Redis 해시는 필드 단위 TTL 이 없으므로 **읽을 때 오래된 항목을 걸러내고 지운다**.
편집기는 새 창으로 뜨고 사용자가 그냥 창을 닫아버리는 경우가 많아, 명시적 퇴장
신호를 신뢰할 수 없다 — 하트비트가 끊기면 자연히 사라지는 구조여야 한다.
"""

import hashlib
import json
import logging
import time

from app.chat.redis_client import get_redis

logger = logging.getLogger(__name__)

PRESENCE_PREFIX = "wopi:presence:"
# 하트비트 주기(프론트 15초)의 3배. 한두 번 놓쳐도 사라지지 않게.
STALE_AFTER = 45
# 해시 자체의 안전망. 모두 나가면 어차피 비지만, 고아 키가 남지 않게.
KEY_TTL = 300

# 사용자마다 안정적으로 같은 색을 주기 위한 팔레트(에디터 커서 색과 무관하게 우리 UI 용).
_COLORS = [
    "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
    "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
]


def _key(virtual_path: str) -> str:
    h = hashlib.sha256(virtual_path.encode()).hexdigest()[:32]
    return f"{PRESENCE_PREFIX}{h}"


def color_for(user_id: str) -> str:
    """사용자별 고정 색. 세션마다 바뀌면 목록에서 눈이 피곤하다."""
    n = int(hashlib.sha256(user_id.encode()).hexdigest()[:8], 16)
    return _COLORS[n % len(_COLORS)]


async def touch(
    virtual_path: str,
    user_id: str,
    user_name: str,
    editor: str = "",
) -> None:
    """입장 또는 하트비트. 같은 호출이 둘 다 한다."""
    redis = await get_redis()
    key = _key(virtual_path)
    await redis.hset(
        key,
        user_id,
        json.dumps({
            "user_id": user_id,
            "user_name": user_name,
            "editor": editor,
            "color": color_for(user_id),
            "ts": int(time.time()),
        }),
    )
    await redis.expire(key, KEY_TTL)


async def leave(virtual_path: str, user_id: str) -> None:
    """명시적 퇴장. 실패해도 무방하다 — 하트비트가 끊기면 어차피 사라진다."""
    redis = await get_redis()
    await redis.hdel(_key(virtual_path), user_id)


async def list_users(virtual_path: str) -> list[dict]:
    """지금 이 파일을 열고 있는 사람들. 읽는 김에 오래된 항목을 정리한다."""
    redis = await get_redis()
    key = _key(virtual_path)
    raw = await redis.hgetall(key)
    if not raw:
        return []

    now = int(time.time())
    users: list[dict] = []
    stale: list[str] = []

    for field, value in raw.items():
        uid = field.decode() if isinstance(field, bytes) else field
        try:
            data = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            stale.append(uid)
            continue
        if now - int(data.get("ts", 0)) > STALE_AFTER:
            stale.append(uid)
            continue
        users.append(data)

    if stale:
        await redis.hdel(key, *stale)

    users.sort(key=lambda u: u.get("user_name") or "")
    return users


async def list_many(virtual_paths: list[str]) -> dict[str, list[dict]]:
    """목록 화면용 — 여러 경로를 한 번에. 빈 것은 결과에서 뺀다."""
    out: dict[str, list[dict]] = {}
    for vp in virtual_paths:
        users = await list_users(vp)
        if users:
            out[vp] = users
    return out
