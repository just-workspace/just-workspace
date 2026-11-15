"""내부 서비스 전용 자격증명 검증 API.

ws-ldap 이 LDAP simple bind 를 처리하려면 비밀번호를 검증해야 한다. 그렇다고
ws-ldap 에 password_hash 읽기 권한을 주면 **해시가 두 서비스로 퍼진다.** 해시를
다루는 코드는 한 곳에 두는 편이 낫다:

  * Argon2 재해시(verify_and_upgrade)가 여기서만 일어난다 — ws-ldap 이 직접
    검증하면 로그인 때마다 해야 할 해시 업그레이드가 LDAP 경로에서 누락된다.
  * passlib 설정이 두 서비스에 복제되면 언젠가 어긋난다.

그래서 ws-ldap 은 이 엔드포인트를 호출하고, 해시는 backend 밖으로 나가지 않는다.

접근 통제는 두 겹이다:
  1. nginx 가 /api/internal/ 을 외부에 노출하지 않는다(도커 네트워크 전용).
  2. INTERNAL_API_KEY 상수시간 비교.
"""

# ※ from __future__ import annotations 를 넣지 말 것.
#   PEP 563 로 애노테이션이 문자열이 되면 FastAPI 가 Pydantic 본문 모델을 인식하지
#   못하고 쿼리 파라미터로 오인한다(422 {"loc":["query","body"]}).
import hmac
import logging

from fastapi import APIRouter, Form, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from app.auth.password import verify_and_upgrade
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.rate_limit import limiter


async def _local_password_allowed(db, user) -> bool:
    # 로그인과 같은 규칙(app.auth.router.local_password_allowed) — 순환 import 를 피해 여기서 늦게 부른다
    from app.auth.router import local_password_allowed

    return await local_password_allowed(db, user)

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api/internal", tags=["internal"])


def _require_internal_key(key: str | None) -> None:
    expected = getattr(settings, "internal_api_key", "") or ""
    if not expected:
        # 키가 설정되지 않았으면 내부 API 자체를 닫는다(기본 비활성).
        raise HTTPException(status_code=404, detail="Not found")
    if not key or not hmac.compare_digest(key, expected):
        raise HTTPException(status_code=401, detail="Invalid internal key")


class VerifyRequest(BaseModel):
    username: str
    password: str
    # LDAP 은 2FA 챌린지를 할 수 없다. FreeIPA 등이 쓰는 관행대로 비밀번호 뒤에
    # OTP 를 붙여 보내면 여기서 분리해 검증한다.
    allow_totp_suffix: bool = True


class VerifyResponse(BaseModel):
    ok: bool
    user_id: str | None = None
    username: str | None = None
    display_name: str | None = None
    email: str | None = None
    is_admin: bool = False
    # 2FA 사용자인데 OTP 가 없거나 틀린 경우를 호출자가 구분할 수 있게 한다.
    reason: str | None = None


@router.post("/verify-credentials", response_model=VerifyResponse)
@limiter.limit("30/minute")
async def verify_credentials(
    request: Request,
    body: VerifyRequest,
    x_internal_key: str | None = Header(None, alias="X-Internal-Key"),
    db: AsyncSession = Depends(get_db),
) -> VerifyResponse:
    _require_internal_key(x_internal_key)

    user = (
        await db.execute(
            select(User).where(User.username == body.username)
        )
    ).scalar_one_or_none()
    # 사용자 없음/비활성/로컬비번 없음 을 구분해서 응답하지 않는다(계정 존재 여부 유출).
    # 외부 디렉터리(LDAP) 계정은 남아 있는 옛 로컬 해시로 받지 않는다(로그인과 같은 규칙).
    if not user or not user.is_active or not user.password_hash or not await _local_password_allowed(db, user):
        return VerifyResponse(ok=False, reason="invalid_credentials")

    secret = body.password
    otp = ""
    if user.totp_secret and body.allow_totp_suffix:
        # 끝 6자리가 숫자면 OTP 로 간주해 분리한다. 분리에 실패해도 그대로 검증을
        # 시도하므로, OTP 를 안 붙였을 때는 비밀번호 검증 단계에서 걸러진다.
        if len(secret) > 6 and secret[-6:].isdigit():
            secret, otp = secret[:-6], secret[-6:]

    ok, new_hash = verify_and_upgrade(secret, user.password_hash)
    if not ok:
        return VerifyResponse(ok=False, reason="invalid_credentials")
    if new_hash:
        user.password_hash = new_hash  # Argon2 재해시는 여기서만 일어난다
        await db.commit()

    if user.totp_secret:
        if not otp:
            return VerifyResponse(ok=False, reason="totp_required")
        import pyotp

        if not pyotp.TOTP(user.totp_secret).verify(otp, valid_window=1):
            return VerifyResponse(ok=False, reason="totp_invalid")

    return VerifyResponse(
        ok=True,
        user_id=user.id,
        username=user.username,
        display_name=user.display_name or user.username,
        email=user.email or "",
        is_admin=bool(user.is_admin),
    )


@router.post("/mail-auth")
@limiter.limit("60/minute")
async def mail_auth(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    x_internal_key: str | None = Header(None, alias="X-Internal-Key"),
    db: AsyncSession = Depends(get_db),
):
    """dovecot 이 IMAP/SMTP 로그인마다 호출한다.

    메일 비밀번호를 따로 보관하고 밀어넣어 맞추는 대신, 여기서 워크스페이스
    비밀번호를 그대로 검증한다. 그래서 동기화할 대상이 없다 — 비밀번호를 바꾸면
    그 순간부터 메일도 새 비밀번호로 들어온다.

    응답은 dovecot 의 lua 스크립트가 읽기 쉽게 최소한으로 유지한다(본문 OK/NO).
    계정 존재 여부를 드러내지 않도록 실패는 전부 같은 모양으로 답한다.
    """
    _require_internal_key(x_internal_key)

    # 본문은 폼 인코딩으로 받는다. dovecot 의 lua 스크립트가 JSON 을 만들려면
    # 백슬래시 이스케이프가 필요한데, 그 백슬래시가 쉘 heredoc 여러 겹을 지나며
    # 소실되기 쉽다. 퍼센트 인코딩은 백슬래시가 없어 그런 사고가 없다.
    email = (email or "").strip().lower()
    fail = PlainTextResponse("NO", status_code=403)
    if not email or not password:
        return fail

    user = (
        await db.execute(select(User).where(func.lower(User.email) == email))
    ).scalar_one_or_none()
    if not user or not user.is_active:
        return fail

    # 앱 비밀번호(설정 › 연결된 앱) — 메일 앱용 별도 비밀번호. 2단계 사용자도 OTP 없이 쓴다.
    from app.auth.me_security import verify_app_password
    if await verify_app_password(db, user, password, "mail"):
        return PlainTextResponse("OK")
    if not user.password_hash or not await _local_password_allowed(db, user):
        return fail

    secret = password
    otp = ""
    if user.totp_secret and len(secret) > 6 and secret[-6:].isdigit():
        # 메일 클라이언트는 2FA 를 물어볼 수 없다. LDAP 경로와 같은 관행으로,
        # 비밀번호 뒤에 OTP 6자리를 붙이는 방식만 허용한다.
        secret, otp = secret[:-6], secret[-6:]

    ok, new_hash = verify_and_upgrade(secret, user.password_hash)
    if not ok:
        return fail
    if new_hash:
        user.password_hash = new_hash
        await db.commit()

    if user.totp_secret:
        if not otp:
            return fail
        import pyotp

        if not pyotp.TOTP(user.totp_secret).verify(otp, valid_window=1):
            return fail

    return PlainTextResponse("OK")
