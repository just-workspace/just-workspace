"""사용자 원장 접근 + 세션 검증.

**ws-sso 는 사용자를 소유하지 않는다.** users 테이블은 backend 가 기록하고 여기서는
읽기만 한다. 이전 버전은 Authentik 을 원장으로 두는 구조였으나 폐기되었으며,
동일한 오류의 재발을 방지하기 위한 경계이다.

  ws-sso   : 프로토콜(SAML/SCIM/OIDC) — 인증을 수행하지 않는다
  backend  : users 테이블 · 로그인 UI · Argon2id · TOTP · 승인제 가입

세션 검증은 backend 와 **동일한 규칙**을 사용한다. 규칙이 불일치하면 한쪽에서 폐기한
세션이 다른 쪽에서 유효한 상태로 남는다(실제로 backend 의 /oauth/authorize 가
token_version 을 확인하지 않아 해당 상태가 발생한 바 있다).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

logger = logging.getLogger(__name__)

SESSION_COOKIE = "ws_session"
SESSION_MAX_AGE = 86400 * 30  # backend 의 remember-me 상한과 동일

_signer = URLSafeTimedSerializer(settings.secret_key)

engine = create_async_engine(settings.database_url, pool_pre_ping=True, pool_size=5)
Session = async_sessionmaker(engine, expire_on_commit=False)


@dataclass(frozen=True)
class Identity:
    id: str
    username: str
    display_name: str
    email: str
    is_admin: bool
    is_active: bool


# ORM 모델을 복제하지 않고 필요한 컬럼만 직접 조회한다. backend 의 models.py 를
# 가져오면 스키마 변경 시마다 두 서비스의 동시 배포가 강제된다.
_USER_COLS = (
    "id, username, coalesce(display_name, username) AS display_name, "
    "coalesce(email, '') AS email, is_admin, is_active, token_version"
)


async def get_user_by_id(db: AsyncSession, user_id: str) -> tuple[Identity, int] | None:
    row = (
        await db.execute(
            text(f"SELECT {_USER_COLS} FROM users WHERE id = :i"), {"i": user_id}
        )
    ).mappings().first()
    return _to_identity(row) if row else None


async def get_user_by_username(db: AsyncSession, username: str) -> tuple[Identity, int] | None:
    row = (
        await db.execute(
            text(f"SELECT {_USER_COLS} FROM users WHERE lower(username) = lower(:u)"),
            {"u": username},
        )
    ).mappings().first()
    return _to_identity(row) if row else None


async def list_users(db: AsyncSession, *, active_only: bool = True) -> list[Identity]:
    q = f"SELECT {_USER_COLS} FROM users"
    if active_only:
        q += " WHERE is_active"
    q += " ORDER BY username"
    rows = (await db.execute(text(q))).mappings().all()
    return [_to_identity(r)[0] for r in rows]


def _to_identity(row) -> tuple[Identity, int]:
    return (
        Identity(
            id=row["id"],
            username=row["username"],
            display_name=row["display_name"],
            email=row["email"],
            is_admin=bool(row["is_admin"]),
            is_active=bool(row["is_active"]),
        ),
        int(row["token_version"]),
    )


async def resolve_session(db: AsyncSession, cookie: str | None) -> Identity | None:
    """backend 가 발급한 ws_session 쿠키를 검증하여 사용자를 반환한다.

    서명 검증 → 사용자 조회 → **token_version 대조**까지 수행한다. tv 를 확인하지 않으면
    비밀번호 변경이나 강제 로그아웃으로 폐기된 쿠키가 여기서 계속 유효하다.

    sid(세션 레지스트리, Redis) 검사는 아직 수행하지 않는다 — backend 만 Redis 를 사용하고
    있어, 여기서 확인하려면 Redis 접근을 허용해야 한다. 그때까지는 tv 가 최소 기준이다.
    """
    if not cookie:
        return None
    try:
        data = _signer.loads(cookie, max_age=SESSION_MAX_AGE)
    except BadSignature:
        return None
    if not isinstance(data, dict) or "user_id" not in data:
        return None

    found = await get_user_by_id(db, data["user_id"])
    if not found:
        return None
    identity, token_version = found
    if not identity.is_active:
        return None
    if data.get("tv") != token_version:
        logger.info("세션 거부: token_version 불일치 user=%s", identity.username)
        return None
    return identity
