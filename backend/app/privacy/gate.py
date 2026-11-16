"""Generic per-user content lock — the unlock/PIN primitive.

Design goals:
- **Server-enforced**: hiding cannot be bypassed by calling the API directly.
  Endpoints decide visibility via ``is_unlocked(request, user)``.
- **Re-locks every session**: unlock returns a short-lived *signed* token that
  the frontend keeps IN MEMORY only (lost on page refresh / new login). It is
  replayed on each request via the ``X-Privacy-Unlock`` header. The server only
  checks the signature + expiry, so there is no server-side "unlocked" state to
  linger across sessions.
- **PIN-gated**: a numeric PIN (bcrypt hash in the DB — table ``privacy_pins``) guards unlock. Setting
  the PIN requires the account password, so a shoulder-surfer / guest cannot
  mint a vault key.

This module is intentionally content-agnostic. Which models/files count as
"private" is decided by the callers (plugins), never here.
"""

import logging

from fastapi import Request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy.exc import IntegrityError

from app.auth.password import hash_password, verify_password
from app.chat.redis_client import get_redis
from app.config import get_settings
from app.db.models import PrivacyPin, User
from app.db.session import async_session

logger = logging.getLogger(__name__)

_settings = get_settings()
_signer = URLSafeTimedSerializer(_settings.secret_key, salt="privacy-unlock")

UNLOCK_HEADER = "x-privacy-unlock"   # Starlette header lookup is case-insensitive
UNLOCK_MAX_AGE = 3600                # token valid at most 1h even if kept in memory
_SCOPE = "adult"

PIN_MIN = 4
PIN_MAX = 12


def _pin_key(uid: str) -> str:
    return f"privacy:pin:{uid}"


def _fail_key(uid: str) -> str:
    return f"privacy:fail:{uid}"


# ── PIN 저장 ──
# 해시는 DB(privacy_pins)에 저장한다. 이전에는 Redis 에만 존재하여(키 `privacy:pin:<사용자>`) 백업에 포함되지
# 않았고 복원 시 소실되었다.
#
# - 읽기: DB 에 있으면 해당 값만 사용한다. 없는 경우에만 이전 Redis 키를 조회하고, 있으면 DB 로 이전한 뒤 해당 값을 사용한다.
# - 쓰기: DB 에 기록하고, 동일 값을 이전 Redis 키에도 기록한다. Redis 측은 읽지 않는 사본이다 —
#   업데이트 실패로 이전 버전(해당 키만 읽는다)으로 롤백되었을 때 PIN 이 그대로 유효하도록 하기 위함이다.
#   이전 후에도 키를 삭제하지 않는 이유도 동일하다.
# - DB 에 행이 생성된 이후에는 Redis 의 값과 무관하게 영향이 없다(stale 값이 복원되지 않는다).

async def _db_hash(uid: str) -> str | None:
    async with async_session() as db:
        row = await db.get(PrivacyPin, uid)
        return row.pin_hash if row else None


async def _legacy_hash(uid: str) -> str | None:
    try:
        r = await get_redis()
        h = await r.get(_pin_key(uid))
    except Exception as e:  # noqa: BLE001 — Redis 가 없어도 DB 의 PIN 은 동작해야 한다
        logger.warning("[privacy] 예전 PIN 위치를 읽지 못했습니다: %s", e)
        return None
    if isinstance(h, (bytes, bytearray)):
        h = h.decode()
    return h or None


async def _mirror_legacy(uid: str, pin_hash: str) -> None:
    try:
        r = await get_redis()
        await r.set(_pin_key(uid), pin_hash)
    except Exception as e:  # noqa: BLE001
        logger.warning("[privacy] PIN 사본을 쓰지 못했습니다(동작에는 영향 없음): %s", e)


async def _pin_hash(uid: str) -> str | None:
    h = await _db_hash(uid)
    if h:
        return h
    legacy = await _legacy_hash(uid)
    if not legacy:
        return None
    # 이전 수행. 다른 워커가 먼저 삽입한 경우(동일 값을 이전했거나 그 사이에 새 PIN 을 설정함) 해당 값을 우선한다.
    async with async_session() as db:
        db.add(PrivacyPin(user_id=uid, pin_hash=legacy))
        try:
            await db.commit()
            return legacy
        except IntegrityError:
            await db.rollback()
    return await _db_hash(uid)


async def has_pin(uid: str) -> bool:
    return bool(await _pin_hash(uid))


async def set_pin(uid: str, new_pin: str) -> None:
    new_hash = hash_password(new_pin)
    for _ in range(2):
        async with async_session() as db:
            row = await db.get(PrivacyPin, uid)
            if row is None:
                db.add(PrivacyPin(user_id=uid, pin_hash=new_hash))
            else:
                row.pin_hash = new_hash
            try:
                await db.commit()
                break
            except IntegrityError:   # 두 요청이 동시에 최초 설정 — 재조회 후 덮어쓴다
                await db.rollback()
    else:
        raise RuntimeError("PIN 을 저장하지 못했습니다")
    await _mirror_legacy(uid, new_hash)


async def verify_pin(uid: str, pin: str) -> bool:
    h = await _pin_hash(uid)
    if not h:
        return False
    try:
        return verify_password(pin, h)
    except Exception:
        return False


# ── Stateless unlock token ──

def make_unlock_token(uid: str) -> str:
    return _signer.dumps({"uid": uid, "scope": _SCOPE})


def _token_valid(token: str | None, uid: str) -> bool:
    if not token:
        return False
    try:
        data = _signer.loads(token, max_age=UNLOCK_MAX_AGE)
    except (BadSignature, Exception):
        return False
    return data.get("uid") == uid and data.get("scope") == _SCOPE


def is_unlocked(request: Request, user: User) -> bool:
    """True if the request carries a valid, unexpired unlock token for this user.

    Normally replayed via the ``X-Privacy-Unlock`` header. Plain ``<img>``/``<video>``
    element requests cannot set custom headers, so a ``?u=<token>`` query param is
    also accepted (same signed, short-lived, per-user token) for media endpoints.
    """
    tok = request.headers.get(UNLOCK_HEADER) or request.query_params.get("u")
    return _token_valid(tok, user.id)


# ── Brute-force throttle (per-user, 60s window) ──

async def register_fail(uid: str) -> int:
    r = await get_redis()
    k = _fail_key(uid)
    n = await r.incr(k)
    if n == 1:
        await r.expire(k, 60)
    return int(n)


async def fail_count(uid: str) -> int:
    r = await get_redis()
    return int(await r.get(_fail_key(uid)) or 0)


async def clear_fails(uid: str) -> None:
    r = await get_redis()
    await r.delete(_fail_key(uid))
