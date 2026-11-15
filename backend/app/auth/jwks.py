"""OIDC 서명 키 관리 + JWKS 발행.

OpenID Connect Discovery 1.0 은 ``jwks_uri`` 를 REQUIRED 로, 그리고
``id_token_signing_alg_values_supported`` 에 **RS256 을 MUST** 로 규정한다.
이전 구현은 HS256(대칭키) 단독이라 두 조건을 모두 위반했고, 표준 OIDC 클라이언트는
서명을 검증할 수단이 없었다.

전환 정책:
  * 새로 발급하는 토큰은 **RS256** 으로 서명하고 헤더에 ``kid`` 를 넣는다.
  * 검증은 RS256 을 먼저 시도하고, 실패하면 기존 HS256 으로 폴백한다.
    이미 발급된 HS256 토큰(최대 1시간 수명)이 만료될 때까지 무중단으로 넘어간다.
  * 폴백은 한시적이다. 전환이 끝나면 ``ALLOW_HS256_FALLBACK`` 을 끈다.
"""

from __future__ import annotations

import base64
import logging
import secrets
import threading
from datetime import datetime, timezone

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import OAuthSigningKey

logger = logging.getLogger(__name__)

ALGORITHM = "RS256"
KEY_SIZE = 2048
PURPOSE = "oidc"

# 기존 HS256 토큰을 계속 받아줄지. 전환기(2026-08-31, 토큰 수명 1시간)는 끝났다 — 끈다.
# 켜 두면 SECRET_KEY 만 있으면 토큰을 만들 수 있고, 실제 거절 사유(aud 등)가 폴백 오류에 묻힌다.
ALLOW_HS256_FALLBACK = False

# 프로세스 내 캐시 — 워커마다 하나씩 뜬다. 키는 거의 바뀌지 않으므로 단순 캐시로 충분.
_lock = threading.Lock()
_cache: dict[str, object] = {"active": None, "all": None}


def _generate() -> tuple[str, str, str]:
    """(kid, private_pem, public_pem) 생성."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=KEY_SIZE)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return secrets.token_urlsafe(16), private_pem, public_pem


async def get_active_key(db: AsyncSession) -> OAuthSigningKey:
    """활성 서명키를 돌려준다. 없으면 만든다.

    uvicorn 워커가 8개라 최초 기동 시 동시에 생성하려 든다. ``retired_at IS NULL``
    부분 유니크 인덱스가 두 번째 INSERT 를 막고, 그 경우 남의 키를 다시 읽는다.
    """
    cached = _cache.get("active")
    if isinstance(cached, OAuthSigningKey):
        return cached

    row = (
        await db.execute(
            select(OAuthSigningKey).where(
                OAuthSigningKey.purpose == PURPOSE,
                OAuthSigningKey.retired_at.is_(None),
            )
        )
    ).scalar_one_or_none()

    if row is None:
        kid, priv, pub = _generate()
        row = OAuthSigningKey(
            kid=kid, purpose=PURPOSE, algorithm=ALGORITHM,
            private_pem=priv, public_pem=pub,
        )
        db.add(row)
        try:
            await db.commit()
            logger.info("OIDC 서명키 생성: kid=%s alg=%s", kid, ALGORITHM)
        except Exception:
            # 다른 워커가 먼저 넣었다 — 그 키를 쓴다.
            await db.rollback()
            row = (
                await db.execute(
                    select(OAuthSigningKey).where(
                        OAuthSigningKey.purpose == PURPOSE,
                        OAuthSigningKey.retired_at.is_(None),
                    )
                )
            ).scalar_one()

    with _lock:
        _cache["active"] = row
    return row


async def get_all_keys(db: AsyncSession) -> list[OAuthSigningKey]:
    """JWKS 에 실을 키 전체 — 폐기된 키도 포함한다.

    회전 직후에도 **이전 키로 서명된 토큰이 아직 유효**하므로, 그 키를 JWKS 에서
    바로 빼면 RP 가 검증에 실패한다.
    """
    rows = (
        await db.execute(
            select(OAuthSigningKey)
            .where(OAuthSigningKey.purpose == PURPOSE)
            .order_by(OAuthSigningKey.created_at.desc())
        )
    ).scalars().all()
    return list(rows)


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def to_jwk(row: OAuthSigningKey) -> dict:
    """공개키를 RFC 7517 JWK 로 — 공개 성분(n, e)만 나간다."""
    pub = serialization.load_pem_public_key(row.public_pem.encode())
    numbers = pub.public_numbers()  # type: ignore[attr-defined]
    n = numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")
    e = numbers.e.to_bytes((numbers.e.bit_length() + 7) // 8, "big")
    return {
        "kty": "RSA",
        "use": "sig",
        "alg": row.algorithm,
        "kid": row.kid,
        "n": _b64u(n),
        "e": _b64u(e),
    }


async def jwks_document(db: AsyncSession) -> dict:
    """JWKS 문서. 키가 아직 없으면 만든다.

    키를 첫 서명 시점에만 만들면, RP 가 그 전에 JWKS 를 읽었을 때 빈 집합을
    받는다. 대부분의 OIDC 클라이언트는 등록·최초 접속 시 JWKS 를 캐시하므로
    빈 응답을 주면 그 뒤 서명 검증이 계속 실패한다.
    """
    await get_active_key(db)
    return {"keys": [to_jwk(r) for r in await get_all_keys(db)]}


async def rotate(db: AsyncSession) -> OAuthSigningKey:
    """새 키를 만들고 기존 키를 폐기 표시한다(JWKS 에는 남는다)."""
    now = datetime.now(timezone.utc)
    for row in await get_all_keys(db):
        if row.retired_at is None:
            row.retired_at = now
    kid, priv, pub = _generate()
    new = OAuthSigningKey(
        kid=kid, purpose=PURPOSE, algorithm=ALGORITHM,
        private_pem=priv, public_pem=pub,
    )
    db.add(new)
    await db.commit()
    with _lock:
        _cache["active"] = new
    logger.info("OIDC 서명키 회전: 새 kid=%s", kid)
    return new
