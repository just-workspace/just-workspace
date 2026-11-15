"""Generic per-user content lock — the unlock/PIN primitive.

Design goals:
- **Server-enforced**: hiding cannot be bypassed by calling the API directly.
  Endpoints decide visibility via ``is_unlocked(request, user)``.
- **Re-locks every session**: unlock returns a short-lived *signed* token that
  the frontend keeps IN MEMORY only (lost on page refresh / new login). It is
  replayed on each request via the ``X-Privacy-Unlock`` header. The server only
  checks the signature + expiry, so there is no server-side "unlocked" state to
  linger across sessions.
- **PIN-gated**: a numeric PIN (bcrypt-hashed in Redis) guards unlock. Setting
  the PIN requires the account password, so a shoulder-surfer / guest cannot
  mint a vault key.

This module is intentionally content-agnostic. Which models/files count as
"private" is decided by the callers (plugins), never here.
"""

from fastapi import Request
from itsdangerous import BadSignature, URLSafeTimedSerializer

from app.auth.password import hash_password, verify_password
from app.chat.redis_client import get_redis
from app.config import get_settings
from app.db.models import User

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


# ── PIN storage (bcrypt hash in Redis; persists via AOF) ──

async def has_pin(uid: str) -> bool:
    r = await get_redis()
    return bool(await r.get(_pin_key(uid)))


async def set_pin(uid: str, new_pin: str) -> None:
    r = await get_redis()
    await r.set(_pin_key(uid), hash_password(new_pin))


async def verify_pin(uid: str, pin: str) -> bool:
    r = await get_redis()
    h = await r.get(_pin_key(uid))
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
