"""Authorization code + refresh token store for Portal OIDC provider.

Authorization codes: Redis if available (survives restart), falls back to
in-memory. Refresh tokens: Postgres (see ``OAuthRefreshToken`` model) so they
survive restarts/container refreshes — Redis 단독 저장 금지.
"""

import hashlib
import json
import secrets
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import OAuthRefreshToken

CODE_TTL = 300  # 5 minutes
REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30  # 30 days


@dataclass
class AuthorizationCode:
    user_id: str
    client_id: str
    redirect_uri: str
    scope: str
    code_challenge: str | None
    nonce: str | None
    expires_at: float
    # PKCE method — only "S256" is accepted. None for legacy/non-PKCE.
    code_challenge_method: str | None = None
    # RFC 8707 resource indicator bound at /authorize, carried to token aud.
    resource: str | None = None
    # 코드를 발급한 워크스페이스 세션 sid — ID 토큰 sid·백채널 로그아웃 추적용.
    # 기본값이 None 이므로 배포 직전에 Redis 에 저장된 코드(필드 없음)도 그대로 조회된다.
    session_id: str | None = None


# ── In-memory fallback ──
_codes: dict[str, AuthorizationCode] = {}


def _cleanup() -> None:
    now = time.time()
    expired = [k for k, v in _codes.items() if v.expires_at < now]
    for k in expired:
        del _codes[k]


async def _get_redis():
    """Try to get Redis connection, return None if unavailable."""
    try:
        from app.chat.redis_client import get_redis
        return await get_redis()
    except Exception:
        return None


async def store_code_async(code: str, data: AuthorizationCode) -> None:
    """Store authorization code in Redis (preferred) or memory."""
    r = await _get_redis()
    if r:
        payload = json.dumps(asdict(data))
        await r.setex(f"oauth:code:{code}", CODE_TTL, payload)
    else:
        _cleanup()
        _codes[code] = data


async def consume_code_async(code: str) -> AuthorizationCode | None:
    """Return and remove code (one-time use)."""
    r = await _get_redis()
    if r:
        key = f"oauth:code:{code}"
        raw = await r.getdel(key)
        if not raw:
            return None
        d = json.loads(raw)
        ac = AuthorizationCode(**d)
        if ac.expires_at < time.time():
            return None
        return ac
    else:
        _cleanup()
        return _codes.pop(code, None)


# ── Sync wrappers for backward compatibility ──

def store_code(code: str, data: AuthorizationCode) -> None:
    """Sync wrapper — stores in memory only (legacy)."""
    _cleanup()
    _codes[code] = data


def consume_code(code: str) -> AuthorizationCode | None:
    """Sync wrapper — consumes from memory only (legacy)."""
    _cleanup()
    return _codes.pop(code, None)


# ── Refresh tokens (Postgres-backed, rotation + reuse detection) ──


def hash_refresh_token(token: str) -> str:
    """SHA-256 hex digest — refresh tokens are stored hashed, never plaintext."""
    return hashlib.sha256(token.encode()).hexdigest()


def hash_client_secret(secret: str) -> str:
    """SHA-256 hex digest — dynamic client secrets stored hashed, never plaintext.

    Mirrors :func:`hash_refresh_token` (RFC 7591 DCR clients, ``OAuthDynamicClient``).
    """
    return hashlib.sha256(secret.encode()).hexdigest()


async def issue_refresh_token(
    db: AsyncSession,
    *,
    user_id: str,
    client_id: str,
    scope: str,
    resource: str | None,
    rotated_from: str | None = None,
) -> str:
    """Create a new refresh token row and return the opaque plaintext token.

    Only the hash is persisted; the returned plaintext is handed to the client
    once and never stored.
    """
    token = secrets.token_urlsafe(48)
    now = datetime.now(timezone.utc)
    row = OAuthRefreshToken(
        token_hash=hash_refresh_token(token),
        user_id=user_id,
        client_id=client_id,
        scope=scope or "",
        resource=resource,
        issued_at=now,
        expires_at=now + timedelta(seconds=REFRESH_TOKEN_TTL),
        rotated_from=rotated_from,
    )
    db.add(row)
    await db.flush()
    return token


class RefreshReuseError(Exception):
    """Raised when an already-rotated/revoked refresh token is presented.

    The whole rotation chain is revoked before this propagates.
    """


async def _revoke_chain(db: AsyncSession, row: OAuthRefreshToken) -> None:
    """Revoke every token in ``row``'s rotation chain (both directions)."""
    now = datetime.now(timezone.utc)
    seen: set[str] = set()
    frontier = [row.token_hash]
    if row.rotated_from:
        frontier.append(row.rotated_from)

    while frontier:
        h = frontier.pop()
        if h in seen:
            continue
        seen.add(h)
        # this token + any successors that rotated FROM it
        rows = (
            await db.execute(
                select(OAuthRefreshToken).where(
                    (OAuthRefreshToken.token_hash == h)
                    | (OAuthRefreshToken.rotated_from == h)
                )
            )
        ).scalars().all()
        for r in rows:
            if r.revoked_at is None:
                r.revoked_at = now
            if r.token_hash not in seen:
                frontier.append(r.token_hash)
            if r.rotated_from and r.rotated_from not in seen:
                frontier.append(r.rotated_from)
    await db.flush()


async def revoke_user_refresh_tokens(db: AsyncSession, user_id: str | None) -> int:
    """해당 사용자의 유효한 리프레시 토큰 전부 폐기(커밋은 호출자). user_id=None 이면 전체 사용자.

    기존에는 비밀번호 변경·재설정·관리자 강제 로그아웃·정지 시 웹 세션(token_version·sid)만 종료했다.
    데스크톱 앱·MCP 커넥터의 리프레시 토큰(30일, 회전)은 유지되어, 계정 탈취 후 비밀번호를
    변경해도 해당 경로의 접근은 계속 유효했다. 동일 시점에 함께 폐기한다.
    """
    from sqlalchemy import update

    live = OAuthRefreshToken.revoked_at.is_(None)
    scope = (OAuthRefreshToken.user_id == user_id) if user_id is not None else live
    pairs = (
        await db.execute(
            select(OAuthRefreshToken.user_id, OAuthRefreshToken.client_id).where(live, scope).distinct()
        )
    ).all()
    res = await db.execute(
        update(OAuthRefreshToken).where(live, scope)
        .values(revoked_at=datetime.now(timezone.utc))
        .execution_options(synchronize_session=False)
    )
    # MCP 는 액세스 토큰에 사용자 token_version 이 없던 시기의 발급분도 허용한다. 해제 시각을 기록하여
    # 그 이전에 발급된 액세스 토큰까지 거부하게 한다(app.mcp.revocation, Redis 부재 시 생략).
    try:
        from app.mcp import revocation

        for uid, cid in pairs:
            await revocation.mark(uid, cid)
    except Exception:  # noqa: BLE001 — 해제 시각 기록은 부가 처리이다. 리프레시 폐기는 이미 완료됨
        pass
    return res.rowcount or 0


async def rotate_refresh_token(
    db: AsyncSession, token: str
) -> OAuthRefreshToken | None:
    """Validate + consume a refresh token, enforcing mandatory rotation.

    Returns the (now revoked) row on success — caller mints a successor via
    :func:`issue_refresh_token` with ``rotated_from=row.token_hash``.

    - Unknown token → returns None (invalid_grant).
    - Expired → revokes the row, returns None (invalid_grant).
    - Already revoked/rotated (reuse) → revokes the WHOLE chain, raises
      :class:`RefreshReuseError` (invalid_grant).
    - Valid → marks this row revoked (consumed) and returns it.
    """
    row = (
        await db.execute(
            select(OAuthRefreshToken).where(
                OAuthRefreshToken.token_hash == hash_refresh_token(token)
            )
        )
    ).scalar_one_or_none()

    if row is None:
        return None

    now = datetime.now(timezone.utc)

    if row.revoked_at is not None:
        # Reuse of a consumed/revoked token → nuke the chain.
        await _revoke_chain(db, row)
        raise RefreshReuseError()

    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < now:
        row.revoked_at = now
        await db.flush()
        return None

    # Valid — consume (rotate).
    row.revoked_at = now
    await db.flush()
    return row
