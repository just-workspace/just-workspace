"""Personal Access Token (PAT) store for the MCP connector.

PATs are a non-interactive fallback to the OAuth flow (§2-2): a user mints a
``wsmcp_<token_urlsafe>`` bearer credential on the profile "AI 연동" page and
pastes it into a client. Only the SHA-256 hash is persisted (mirrors
``app.auth.oauth_store``); the plaintext is shown exactly once at creation.

PATs are clamped to ``mcp:read`` and are user+scope bound — no ``aud``/resource
check is applied (unlike OAuth JWTs), because the token itself already ties the
caller to a single user and scope set.
"""

import hashlib
import json
import secrets
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import McpPersonalToken

# Recognisable prefix so ``authenticate`` can distinguish a PAT from an OAuth JWT
# by string prefix alone, before any DB lookup.
PAT_PREFIX = "wsmcp_"

# PATs may only ever hold this scope (never mcp:write).
PAT_ALLOWED_SCOPES = {"mcp:read"}
DEFAULT_PAT_SCOPES = ["mcp:read"]


def hash_pat(token: str) -> str:
    """SHA-256 hex digest — PATs are stored hashed, never plaintext."""
    return hashlib.sha256(token.encode()).hexdigest()


def clamp_scopes(scopes: list[str] | None, *, allow_write: bool = False) -> list[str]:
    """Restrict requested scopes to the PAT-allowed set.

    기본은 mcp:read 만. 관리자가 AI 쓰기를 허용(allow_write)했고 사용자가 명시적으로 mcp:write 를
    고른 토큰만 쓰기 권한을 받는다(S3). 쓰기 토큰은 /api/mcp/write 에서만 쓰기 도구가 보이고
    high 위험 작업은 여전히 승인 대기함을 거친다.
    """
    if not scopes:
        return list(DEFAULT_PAT_SCOPES)
    ok = PAT_ALLOWED_SCOPES | ({"mcp:write"} if allow_write else set())
    allowed = [s for s in scopes if s in ok]
    if "mcp:write" in allowed and "mcp:read" not in allowed:
        allowed.insert(0, "mcp:read")
    return allowed or list(DEFAULT_PAT_SCOPES)


async def create_personal_token(
    db: AsyncSession,
    *,
    user_id: str,
    name: str,
    scopes: list[str] | None = None,
    expires_at: datetime | None = None,
) -> tuple[str, McpPersonalToken]:
    """Create a PAT row and return ``(plaintext_token, row)``.

    Only the hash is persisted; the returned plaintext is handed to the caller
    once and never stored.
    """
    token = PAT_PREFIX + secrets.token_urlsafe(32)
    row = McpPersonalToken(
        token_hash=hash_pat(token),
        user_id=user_id,
        name=name,
        token_hint=token[-4:],
        # 호출자가 이미 관리자 정책으로 깎아 넘긴다(account_router). 여기서는 허용 집합 밖만 다시 막는다.
        scopes=json.dumps(clamp_scopes(scopes, allow_write=True)),
        expires_at=expires_at,
    )
    db.add(row)
    await db.flush()
    return token, row


def is_pat(token: str) -> bool:
    return token.startswith(PAT_PREFIX)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


async def resolve_pat(db: AsyncSession, token: str) -> McpPersonalToken | None:
    """Return the live PAT row for ``token`` or None if unknown/revoked/expired.

    Also bumps ``last_used_at`` on success (best effort, same session).
    """
    from sqlalchemy import select

    row = (
        await db.execute(
            select(McpPersonalToken).where(
                McpPersonalToken.token_hash == hash_pat(token)
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return None

    now = datetime.now(timezone.utc)
    if row.revoked_at is not None:
        return None
    exp = _aware(row.expires_at)
    if exp is not None and exp < now:
        return None

    row.last_used_at = now
    return row
