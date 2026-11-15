"""Chat presence — 연결 여부는 Redis SET, 사람이 고른 상태(자리비움·방해 금지·숨김·커스텀)는 DB.

실효 상태(effective_state) 네 가지 + offline:
  연결 없음 → offline · invisible → offline 로 보임 · dnd(또는 dnd_until 이 미래) → dnd ·
  away → away · auto → online
만료된 커스텀 상태·DND 는 읽을 때 무시한다(배치 정리 없음). DND 중엔 웹푸시를 보내지 않는다.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.redis_client import get_redis
from app.db.models import User, UserStatus

ONLINE_KEY = "chat:online"
WS_KEY_PREFIX = "chat:user:"
WS_TTL = 60  # seconds

STATUS_MODES = ("auto", "away", "dnd", "invisible")


async def set_online(user_id: str) -> None:
    r = await get_redis()
    pipe = r.pipeline()
    pipe.sadd(ONLINE_KEY, user_id)
    pipe.set(f"{WS_KEY_PREFIX}{user_id}:ws", "1", ex=WS_TTL)
    await pipe.execute()


async def set_offline(user_id: str) -> None:
    r = await get_redis()
    pipe = r.pipeline()
    pipe.srem(ONLINE_KEY, user_id)
    pipe.delete(f"{WS_KEY_PREFIX}{user_id}:ws")
    await pipe.execute()


CONN_KEY = "chat:user:{}:conns"
# 워커가 죽어 감소가 빠진 카운터가 영원히 남지 않게. 살아 있는 소켓의 ping 이 계속 늘려 준다.
CONN_TTL = 180


async def connection_opened(user_id: str) -> bool:
    """WS 하나가 열렸다. 이 사용자의 첫 연결(모든 워커 합산)이면 True.

    한 사용자가 탭 여럿·데스크톱 셸로 동시에 붙고, 그 연결들이 서로 다른 워커에 있을 수
    있다. 워커 메모리만 보고 온라인/오프라인을 정하면 한 탭을 닫았을 때 오프라인이 된다.
    """
    r = await get_redis()
    key = CONN_KEY.format(user_id)
    pipe = r.pipeline()
    pipe.incr(key)
    pipe.expire(key, CONN_TTL)
    count, _ = await pipe.execute()
    await set_online(user_id)
    return int(count) == 1


async def connection_closed(user_id: str) -> bool:
    """WS 하나가 닫혔다. 마지막 연결이었으면 오프라인으로 바꾸고 True."""
    r = await get_redis()
    key = CONN_KEY.format(user_id)
    left = int(await r.decr(key))
    if left > 0:
        return False
    await r.delete(key)
    await set_offline(user_id)
    return True


async def refresh_heartbeat(user_id: str) -> None:
    r = await get_redis()
    pipe = r.pipeline()
    pipe.set(f"{WS_KEY_PREFIX}{user_id}:ws", "1", ex=WS_TTL)
    pipe.expire(CONN_KEY.format(user_id), CONN_TTL)
    await pipe.execute()


async def get_online_users() -> set[str]:
    r = await get_redis()
    return await r.smembers(ONLINE_KEY)


async def is_online(user_id: str) -> bool:
    r = await get_redis()
    return await r.sismember(ONLINE_KEY, user_id)


# ─── 사용자 상태(UserStatus) ───


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    # SQLite 는 tz 를 떨어뜨려 돌려주므로 비교 전에 UTC 로 맞춘다
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def is_dnd(status: UserStatus | None, now: datetime | None = None) -> bool:
    """방해 금지인가 — mode 가 dnd(만료 안 됨) 거나 dnd_until 이 미래."""
    if status is None:
        return False
    now = now or _now()
    until = _aware(status.dnd_until)
    if until is not None and until > now:
        return True
    # dnd 모드인데 until 이 지났으면 풀린 것. until 이 없으면 무기한.
    return status.mode == "dnd" and until is None


def custom_status(status: UserStatus | None, now: datetime | None = None) -> tuple[str | None, str | None]:
    """(emoji, text) — 만료됐으면 (None, None)."""
    if status is None:
        return None, None
    exp = _aware(status.custom_expires_at)
    if exp is not None and exp <= (now or _now()):
        return None, None
    return status.custom_emoji or None, status.custom_text or None


def effective_state(status: UserStatus | None, connected: bool, now: datetime | None = None) -> str:
    """'online' | 'away' | 'dnd' | 'offline'. invisible 은 남에게 offline 으로 보인다."""
    if not connected:
        return "offline"
    if status is None:
        return "online"
    if status.mode == "invisible":
        return "offline"
    if is_dnd(status, now):
        return "dnd"
    if status.mode == "away":
        return "away"
    return "online"


def status_to_dict(status: UserStatus | None, connected: bool) -> dict:
    """GET/PUT /me/status 응답 — 저장된 설정 전부 + 지금의 실효 상태(남에게 보이는 것)."""
    emoji, text = custom_status(status)
    return {
        "mode": status.mode if status else "auto",
        "custom_emoji": emoji,
        "custom_text": text,
        "custom_expires_at": status.custom_expires_at if status else None,
        "dnd_until": status.dnd_until if status else None,
        "state": effective_state(status, connected),
    }


def presence_entry(status: UserStatus | None, connected: bool, now: datetime | None = None) -> dict:
    """presence 응답·이벤트의 사용자 1명분 {state, emoji, text}."""
    emoji, text = custom_status(status, now)
    return {"state": effective_state(status, connected, now), "emoji": emoji, "text": text}


async def get_status(db: AsyncSession, user_id: str) -> UserStatus | None:
    return await db.get(UserStatus, user_id)


async def set_status(db: AsyncSession, user_id: str, **fields) -> UserStatus:
    """바꿀 필드만 넘긴다(None 도 '비우기' 로 반영). 행이 없으면 만든다."""
    row = await db.get(UserStatus, user_id)
    if row is None:
        row = UserStatus(user_id=user_id, mode="auto")
        db.add(row)
    for k, v in fields.items():
        if k == "mode" and v not in STATUS_MODES:
            continue
        setattr(row, k, v)
    row.updated_at = _now()
    await db.commit()
    await db.refresh(row)
    return row


async def push_allowed(user_id: str) -> bool:
    """웹푸시 게이트 — 방해 금지면 False. DB 를 못 읽으면 보내는 쪽(True)으로 둔다."""
    from app.db.session import async_session

    try:
        async with async_session() as db:
            return not is_dnd(await db.get(UserStatus, user_id))
    except Exception:
        return True


async def presence_snapshot(db: AsyncSession) -> dict:
    """GET /presence — {online_user_ids(하위호환, invisible 제외), statuses: {uid: {state, emoji, text}}}.

    statuses 에는 연결된 사람 전원 + 상태 행이 있는(커스텀 텍스트가 남아 있을 수 있는) 사람을
    넣는다. 상태 행은 사람이 한 번이라도 고른 경우에만 생기므로 테이블이 작다.
    """
    online = set(await get_online_users())
    rows = {
        s.user_id: s
        for s in (await db.execute(select(UserStatus))).scalars().all()
    }
    now = _now()
    statuses: dict[str, dict] = {}
    for uid in online | set(rows):
        statuses[uid] = presence_entry(rows.get(uid), uid in online, now)
    visible_online = [uid for uid in online if statuses[uid]["state"] != "offline"]
    return {"online_user_ids": visible_online, "statuses": statuses}


async def presence_event(db: AsyncSession, user_id: str, connected: bool) -> dict:
    """presence 브로드캐스트 1건 — websocket.py 의 연결/해제와 상태 변경이 같은 모양을 쓴다.

    `status` 는 예전 프런트(online/offline 두 값)용, `state` 가 네 가지 실효 상태다.
    """
    user = await db.get(User, user_id)
    entry = presence_entry(await db.get(UserStatus, user_id), connected)
    return {
        "type": "presence",
        "user_id": user_id,
        "username": user.username if user else None,
        "status": "offline" if entry["state"] == "offline" else "online",
        **entry,
    }
