"""Chat presence — 연결 여부는 Redis SET, 사용자가 선택한 상태(자리비움·방해 금지·숨김·커스텀)는 DB.

실효 상태(effective_state) 네 가지 + offline:
  연결 없음 → offline · invisible → offline 으로 표시 · dnd(또는 dnd_until 이 미래) → dnd ·
  away → away · auto → online
만료된 커스텀 상태·DND 는 조회 시 무시한다(배치 정리 없음). DND 중에는 웹푸시를 발송하지 않는다.
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
# 워커 비정상 종료로 감소가 누락된 카운터가 영구 잔존하지 않도록 함. 유지 중인 소켓의 ping 이 만료 시간을 계속 연장한다.
CONN_TTL = 180


async def connection_opened(user_id: str) -> bool:
    """WS 하나가 연결됨. 해당 사용자의 첫 연결(전체 워커 합산)이면 True.

    한 사용자가 여러 탭·데스크톱 셸로 동시에 접속하고, 해당 연결들이 서로 다른 워커에 존재할 수
    있다. 워커 메모리만으로 온라인/오프라인을 판정하면 탭 하나를 닫았을 때 오프라인으로 처리된다.
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
    """WS 하나가 종료됨. 마지막 연결이었으면 오프라인으로 전환하고 True."""
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
    # SQLite 는 tz 를 제거하여 반환하므로 비교 전에 UTC 로 정규화
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def is_dnd(status: UserStatus | None, now: datetime | None = None) -> bool:
    """방해 금지 여부 — mode 가 dnd(미만료) 이거나 dnd_until 이 미래."""
    if status is None:
        return False
    now = now or _now()
    until = _aware(status.dnd_until)
    if until is not None and until > now:
        return True
    # dnd 모드이나 until 이 경과했으면 해제된 상태. until 이 없으면 무기한.
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
    """'online' | 'away' | 'dnd' | 'offline'. invisible 은 타 사용자에게 offline 으로 표시된다."""
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
    """GET/PUT /me/status 응답 — 저장된 설정 전부 + 현재 실효 상태(타 사용자에게 표시되는 값)."""
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
    """변경할 필드만 전달한다(None 도 '비우기' 로 반영). 행이 없으면 생성한다."""
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
    """웹푸시 게이트 — 방해 금지이면 False. DB 조회 실패 시 발송 허용(True)으로 처리한다."""
    from app.db.session import async_session

    try:
        async with async_session() as db:
            return not is_dnd(await db.get(UserStatus, user_id))
    except Exception:
        return True


async def presence_snapshot(db: AsyncSession) -> dict:
    """GET /presence — {online_user_ids(하위호환, invisible 제외), statuses: {uid: {state, emoji, text}}}.

    statuses 에는 연결된 사용자 전원 + 상태 행이 있는(커스텀 텍스트가 남아 있을 수 있는) 사용자를
    포함한다. 상태 행은 사용자가 한 번이라도 선택한 경우에만 생성되므로 테이블 크기가 작다.
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
    """presence 브로드캐스트 1건 — websocket.py 의 연결/해제와 상태 변경이 동일한 형태를 사용한다.

    `status` 는 이전 프런트(online/offline 두 값)용이며, `state` 가 네 가지 실효 상태이다.
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
