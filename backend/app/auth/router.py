"""Auth API routes: login, me, logout, register, profile, password management, 2FA."""

import hashlib
import logging
import secrets
from datetime import datetime, timezone
from pathlib import Path

import pyotp
from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.rate_limit import limiter
from app.auth.deps import (
    SESSION_COOKIE,
    SESSION_MAX_AGE_DEFAULT,
    SESSION_MAX_AGE_REMEMBER,
    get_current_user,
    get_session_max_age_default,
    get_session_max_age_remember,
    sign_value,
    unsign_value,
)
from app.auth import password_policy
from app.auth.password import hash_password, verify_and_upgrade, verify_password
from app.auth.oauth_store import revoke_user_refresh_tokens
from app.admin.settings import builtin_mailserver_enabled
from app.auth.schemas import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    ProfileUpdateRequest,
    RegisterRequest,
    ResendVerificationRequest,
    ResetPasswordRequest,
    TwoFactorDisableRequest,
    TwoFactorEnableRequest,
    TwoFactorVerifyRequest,
    UserResponse,
)

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api/auth", tags=["auth"])


# ── Helper: session cookie response ──────────────────────────


def _is_web_origin(request: Request) -> bool:
    """요청이 우리 웹 화면(같은 출처)에서 왔나 — Origin(없으면 Referer)이 APP_URL 이나 요청 Host 와 같다."""
    from urllib.parse import urlsplit

    raw = request.headers.get("origin") or request.headers.get("referer") or ""
    try:
        p = urlsplit(raw)
    except ValueError:
        return False
    if not p.scheme or not p.netloc:
        return False
    origin = f"{p.scheme.lower()}://{p.netloc.lower()}"
    try:
        a = urlsplit(settings.app_url)
        mine = {f"{a.scheme.lower()}://{a.netloc.lower()}"}
    except ValueError:
        mine = set()
    host = (request.headers.get("host") or "").lower()
    if host:
        mine |= {f"https://{host}", f"http://{host}"}
    return origin in mine


async def _session_response(
    request: Request,
    user: User,
    body: dict | None = None,
    max_age: int = SESSION_MAX_AGE_DEFAULT,
) -> JSONResponse:
    from app.auth import sessions as sess_mod
    ip = sess_mod.client_ip(request)
    hostname = await sess_mod.resolve_hostname(ip)
    ua = request.headers.get("user-agent", "")
    sid = await sess_mod.create_session(user.id, ip, hostname, ua, max_age)
    session_data = sign_value({"user_id": user.id, "tv": user.token_version, "sid": sid})
    # 접속 로그(AccessLogMiddleware)는 요청 쿠키에서 사용자를 읽는데, 로그인 요청에는 아직 쿠키가 없다.
    # 방금 세션을 받은 사용자를 요청 상태에 남겨 관리 대시보드 "최근 로그인"이 비지 않게 한다.
    try:
        request.state.login_user_id = user.id
    except Exception:  # noqa: BLE001 — 테스트용 가짜 요청 등 state 가 없는 경우
        pass
    # 번들 SPA 앱(cross-origin, 쿠키 불가)용: 동일 서명값을 토큰으로도 반환 → Bearer 사용.
    # 웹(우리 출처에서 온 요청)은 httpOnly 쿠키만 — 본문에 토큰을 싣지 않는다(스크립트가 세션값을 못 읽게).
    out = dict(body or {"status": "ok"})
    if not _is_web_origin(request):
        out["token"] = session_data
    response = JSONResponse(content=out)
    is_https = settings.app_url.startswith("https://")
    response.set_cookie(
        SESSION_COOKIE,
        session_data,
        httponly=True,
        secure=is_https,
        samesite="lax",
        max_age=max_age,
        path="/",
    )
    return response


# ── POST /api/auth/login ─────────────────────────────────────


TEMP_TOKEN_MAX_AGE = 300  # 5 minutes for 2FA temp tokens


async def _try_ldap_login(db: AsyncSession, username: str, password: str):
    """LDAP/AD 폴백 — 성공 시 User(find-or-create) 반환, 아니면 None. (로컬 인증 실패 시에만 호출)"""
    from app.auth import ldap_client
    try:
        if not await ldap_client.is_enabled(db):
            return None
        attrs = await ldap_client.authenticate(db, username, password)
    except Exception:
        return None
    if not attrs:
        return None
    user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if user is None:
        if not await ldap_client.auto_provision(db):
            return None
        user = User(
            username=username,
            email=attrs.get("email") or f"{username}@ldap.local",
            display_name=attrs.get("name") or username,
            password_hash=None, auth_source="ldap",
            external_id=attrs.get("dn"), is_active=True, email_verified=True,
        )
        db.add(user)
        await db.flush()
    else:
        if attrs.get("email"):
            user.email = attrs["email"]
        if attrs.get("name"):
            user.display_name = attrs["name"]
        user.auth_source = "ldap"
        user.external_id = attrs.get("dn") or user.external_id
    return user


def _token_digest(token: str) -> str:
    """이메일 인증·비밀번호 재설정 토큰의 저장형(SHA-256).

    토큰을 DB 에 평문으로 두면 DB 덤프 하나로 임의 계정 탈취가 가능하다.
    토큰 자체는 secrets.token_urlsafe(32)(256비트)라 무차별 대입은 비현실적이므로
    솔트 없는 단순 해시로 충분하다(느린 KDF 가 필요한 비밀번호와 다르다).
    """
    return hashlib.sha256(token.encode()).hexdigest()


def _token_match(column, token: str):
    """저장형(해시)으로만 찾는다 — 토큰 원문은 DB 에 없다."""
    return column == _token_digest(token)


_dummy_hash: str | None = None


def _burn_password_check(password: str) -> None:
    """없는 계정에도 해시 검증 한 번 — 응답 시간으로 계정 존재를 가려내지 못하게(결과는 버린다)."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_password(secrets.token_urlsafe(16))
    verify_password(password, _dummy_hash)


def is_local_account(user: User) -> bool:
    """로컬 비밀번호로 인증하는 계정인가. auth_source 가 비어 있는 옛 계정은 로컬로 본다."""
    return (user.auth_source or "local") == "local"


async def local_password_allowed(db, user: User) -> bool:
    """이 계정이 로컬 비밀번호로 인증해도 되나. LDAP 계정은 LDAP 이 켜져 있는 동안만 막는다 —
    LDAP 을 끄거나 디렉터리 연동을 접었을 때 LDAP 으로 전환됐던 계정(관리자 포함)이 영영 잠기지 않게."""
    if is_local_account(user):
        return True
    try:
        from app.auth import ldap_client

        return not await ldap_client.is_enabled(db)
    except Exception:  # noqa: BLE001 — 설정을 못 읽으면 막는 쪽
        return False


async def _try_local_login(db: AsyncSession, username: str, password: str):
    """로컬 인증 — 성공 시 User 반환, 아니면 None."""
    user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    # 외부 디렉터리(LDAP) 계정은 로컬 비밀번호로 받지 않는다. LDAP 으로 전환된 계정에 남은 옛
    # password_hash 가 계속 통하면, 디렉터리에서 퇴사 처리해도 옛 비밀번호로 들어올 수 있다.
    if not user or not user.password_hash or not await local_password_allowed(db, user):
        _burn_password_check(password)
        return None
    ok, upgraded = verify_and_upgrade(password, user.password_hash)
    if not ok:
        return None
    # 구 스킴(bcrypt / bcrypt_sha256) 해시는 로그인 성공 시 조용히 Argon2id 로 재해싱한다.
    if upgraded:
        user.password_hash = upgraded
        await db.commit()
    return user


@router.post("/login")
@limiter.limit("10/minute")
async def login_post(request: Request, body: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Authenticate per configurable source order (auth.order, 기본 local,ldap). 2FA→temp_token.

    외부 디렉터리(LDAP/AD)를 우선으로 두려면 auth.order='ldap,local' — 부서/조직을 외부에서
    관리하는 조직용. 첫 성공 소스가 승리.
    """
    from app.setup import config_store as _cfg
    from app.auth import security_policy
    from app.auth import sessions as _sess_mod
    order_raw = await _cfg.get(db, "auth.order", "local,ldap")
    order = [s.strip() for s in (order_raw or "local,ldap").split(",") if s.strip()]

    # 로그인 보호 — 연속 실패 잠금(관리 › 보안·SSL). 꺼져 있으면 아무 것도 안 한다.
    pol = await security_policy.get_policy_cached(db)
    client = _sess_mod.client_ip(request)
    wait = await security_policy.check_lockout(pol, body.username, client)
    if wait:
        mins = max(1, (wait + 59) // 60)
        raise HTTPException(
            status_code=429,
            detail=f"로그인 시도가 너무 많습니다. {mins}분 뒤에 다시 시도하세요",
            headers={"Retry-After": str(wait)},
        )

    user = None
    for src in order:
        if src == "local":
            user = await _try_local_login(db, body.username, body.password)
        elif src == "ldap":
            user = await _try_ldap_login(db, body.username, body.password)
        if user is not None:
            break

    if user is None:
        await security_policy.record_failure(pol, body.username, client)
        raise HTTPException(status_code=401, detail="사용자명 또는 비밀번호가 올바르지 않습니다")
    await security_policy.clear_failures(body.username)

    if not user.is_active:
        raise HTTPException(status_code=403, detail="계정이 비활성 상태입니다. 관리자 승인을 기다려주세요.")

    # 복구 이메일 인증을 끝내야 로그인할 수 있다. 예전에는 email_verified 를
    # 기록만 하고 아무데서도 보지 않아서, 인증을 건너뛰어도 그냥 들어와졌다.
    # 프런트가 "재발송" 버튼을 띄울 수 있게 코드를 같이 내려준다.
    if not user.email_verified:
        return JSONResponse(
            status_code=403,
            content={
                "detail": "이메일 인증이 필요합니다. 가입 시 입력한 복구 이메일의 인증 링크를 확인해주세요.",
                "code": "email_unverified",
            },
        )

    # If 2FA is enabled, return a temp token instead of session cookie
    if user.totp_secret:
        temp_token = sign_value({
            "user_id": user.id,
            "purpose": "2fa",
            "remember_me": body.remember_me,
        })
        return JSONResponse(content={
            "requires_2fa": True,
            "temp_token": temp_token,
        })

    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    await security_policy.note_login_device(pol, user, request.headers.get("user-agent", ""), client)

    if body.remember_me:
        max_age = await get_session_max_age_remember(db)
    else:
        max_age = await get_session_max_age_default(db)
    return await _session_response(request, user, max_age=max_age)


# ── GET /api/auth/me ─────────────────────────────────────────


@router.get("/me", response_model=UserResponse)
async def me(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return current authenticated user info."""
    from app.auth import security_policy
    resp = UserResponse.from_user(user)
    # 관리자 정책상 2단계 인증이 필수인데 아직 등록 안 했으면 프런트가 설정 › 보안으로 보낸다
    resp.totp_setup_required = security_policy.totp_setup_required(
        await security_policy.get_policy_cached(db), user
    )
    # 주사용(default) 메일계정 주소 — 외부 IMAP/Exchange 연동 시 compose From·프로필 표출용
    try:
        from app.mail.router import resolve_primary_email
        resp.primary_email = await resolve_primary_email(db, user)
    except Exception:
        resp.primary_email = user.email
    return resp


# ── POST /api/auth/logout ───────────────────────────────────


@router.post("/logout")
async def logout(ws_session: str | None = Cookie(None)):
    """Clear session cookie + 레지스트리에서 현재 세션(sid) 제거."""
    if ws_session:
        data = unsign_value(ws_session)
        if data and data.get("sid"):
            from app.auth import sessions as sess_mod
            await sess_mod.revoke_session(data["sid"])
    response = JSONResponse(content={"status": "ok"})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


# ── POST /api/auth/register — 회원가입 ──────────────────────

# 사람 계정으로 내주면 안 되는 이름 — 메일 표준 주소(RFC 2142)와 시스템이 쓰는 주소.
# 이 이름으로 가입 신청이 들어오면 그 주소의 실제 사서함과 엮인다(승인 = 사서함 인계).
RESERVED_USERNAMES = frozenset({
    "postmaster", "abuse", "hostmaster", "webmaster", "mailer-daemon", "root", "admin", "administrator",
    "noreply", "no-reply", "security", "support", "info", "dmarc", "system", "daemon", "nobody",
})


async def _username_blocked(db: AsyncSession, username: str, email: str) -> str | None:
    """가입에 쓸 수 없는 이름이면 사용자에게 보일 사유, 괜찮으면 None."""
    from email.utils import parseaddr
    from app.admin.settings import get_smtp_config

    denied = "사용할 수 없는 사용자명입니다"
    if username in RESERVED_USERNAMES:
        return denied
    # 시스템 메일(인증·재설정·알림)을 보내는 계정 주소
    try:
        cfg = await get_smtp_config(db)
        system = {parseaddr(v or "")[1].strip().lower() for v in (cfg.user, cfg.from_addr)}
        if email.lower() in system:
            return denied
    except Exception as e:  # noqa: BLE001 — 설정을 못 읽어도 가입은 막지 않는다
        logger.debug("system mail address check skipped: %s", e)
    # 내장 메일서버에 이미 있는 주소(손으로 만든 공용 사서함, 삭제된 사용자의 보존 사서함)
    try:
        if await builtin_mailserver_enabled(db):
            from app.admin.router import mailbox_exists
            if await mailbox_exists(email):
                return "이미 사용 중인 사용자명입니다"
    except Exception as e:  # noqa: BLE001
        logger.warning("mailbox existence check failed for %s: %s", email, e)
    return None


@router.post("/register", status_code=201)
@limiter.limit("5/minute")
async def register(request: Request, body: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """Register a new user (respects registration_mode: open/approval/closed)."""
    from app.admin.settings import get_setting

    reg_mode = await get_setting(db, "auth.registration_mode") or "approval"
    invite = None
    if body.invite_token:
        from app.admin.users_ext import find_open_invite
        invite = await find_open_invite(db, body.invite_token)
        if invite is None:
            raise HTTPException(status_code=400, detail="초대 링크가 만료됐거나 이미 사용되었습니다")
    if reg_mode == "closed" and invite is None:
        raise HTTPException(status_code=403, detail="현재 회원가입이 비활성화되어 있습니다")

    email = f"{body.username}@{settings.domain}"

    # Check if username already exists in DB
    result = await db.execute(select(User).where(User.username == body.username))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 사용 중인 사용자명입니다")

    # 이미 있는 메일 주소(시스템 발송 계정·공용 사서함·삭제된 사용자의 보존 사서함)와 겹치는 이름은
    # 받지 않는다. 받으면 승인 때 그 사서함이 새 사람에게 통째로 넘어간다(activate_user 는 있으면 재사용).
    blocked = await _username_blocked(db, body.username, email)
    if blocked:
        raise HTTPException(status_code=409, detail=blocked)

    # Generate email verification token
    verify_token = secrets.token_urlsafe(32)

    # Create DB record with bcrypt password hash
    is_active = reg_mode == "open"  # open: immediate activation, approval: pending
    user = User(
        username=body.username,
        display_name=body.display_name,
        email=email,
        recovery_email=body.recovery_email,
        password_hash=hash_password(body.password),
        email_verified=False,
        email_verify_token=_token_digest(verify_token),
        email_verify_sent_at=datetime.now(timezone.utc),
        is_active=is_active,
    )
    if invite is not None:
        # 초대는 한 번만 — "안 쓴 초대일 때만 사용 표시"를 한 문장으로 해서 선점한다. 예전엔 확인(위)과
        # 표시(아래) 사이가 벌어져, 같은 링크로 동시에 가입한 두 계정이 모두 승인됐다.
        # 사용자 생성과 같은 트랜잭션이라 가입이 실패하면 초대도 그대로 남는다.
        from sqlalchemy import update as _update
        from app.db.models import UserInvite
        claimed = await db.execute(
            _update(UserInvite)
            .where(UserInvite.id == invite.id, UserInvite.used_at.is_(None), UserInvite.revoked_at.is_(None))
            .values(used_at=datetime.now(timezone.utc))
            .execution_options(synchronize_session=False)
        )
        if not claimed.rowcount:
            await db.rollback()
            raise HTTPException(status_code=400, detail="초대 링크가 만료됐거나 이미 사용되었습니다")
    db.add(user)
    await db.commit()

    # ── 초대 링크 가입: 초대를 쓰고 바로 승인(관리자가 이미 이 사람을 골랐다) ──
    if invite is not None:
        from app.admin.router import activate_user
        invite.used_at = datetime.now(timezone.utc)
        invite.used_by = user.id
        if invite.group_id:
            from app.groups.models import GroupMember
            db.add(GroupMember(group_id=invite.group_id, user_id=user.id))
        # 초대받은 주소 그대로 복구 이메일로 썼으면 그 주소는 확인된 것으로 본다
        if invite.email and invite.email.strip().lower() == body.recovery_email:
            user.email_verified = True
            user.email_verify_token = None
        await db.commit()
        try:
            await activate_user(db, user)
        except Exception as e:
            logger.warning("초대 가입 자동 승인 실패(%s): %s", user.username, e)
        if not user.email_verified:
            try:
                verify_url = f"{settings.app_url}/verify-email?token={verify_token}"
                await _send_verify_email(body.recovery_email, body.username, verify_url)
            except Exception as e:
                logger.warning("Failed to send verification email to %s: %s", body.recovery_email, e)
        return {"message": "가입이 완료되었습니다. 로그인해주세요.", "invited": True}

    # 메일 사서함은 여기서 만들지 않는다. 승인 전 계정까지 사서함을 받으면
    # 스팸 가입자가 곧바로 우리 도메인 주소를 갖게 된다. approve_user 가
    # "없으면 생성" 을 이미 하고 있으므로 승인 시점으로 일원화한다.
    #
    # 단, "바로 가입(open)" 은 승인 단계가 없다 — 가입이 곧 승인이므로 여기서 같은 처리를 한다.
    # 빠져 있어서 open 모드 가입자는 사서함·기본 캘린더·주소록이 영영 안 생겼다(수신 550,
    # 관리자가 승인을 눌러도 "이미 활성화된 사용자").
    if is_active:
        try:
            from app.admin.router import activate_user
            await activate_user(db, user, send_welcome=False)
        except Exception as e:
            logger.warning("바로 가입 계정 준비 실패(%s): %s", user.username, e)

    # Send verification email to recovery_email
    try:
        verify_url = f"{settings.app_url}/verify-email?token={verify_token}"
        await _send_verify_email(body.recovery_email, body.username, verify_url)
    except Exception as e:
        logger.warning("Failed to send verification email to %s: %s", body.recovery_email, e)

    # Notify admins of new registration
    try:
        await _send_admin_registration_notify(body.username, body.display_name, email, body.recovery_email)
    except Exception as e:
        logger.warning("Failed to send admin registration notification for %s: %s", body.username, e)

    if reg_mode == "open":
        return {"message": "가입이 완료되었습니다. 로그인해주세요."}
    return {"message": "가입 신청이 완료되었습니다. 복구 이메일로 전송된 인증 링크를 확인해주세요."}


# ── GET /api/auth/invites/{token} — 초대 링크 확인(가입 화면 미리 채우기) ──


@router.get("/invites/{token}")
@limiter.limit("20/minute")
async def check_invite(request: Request, token: str, db: AsyncSession = Depends(get_db)):
    """초대 링크가 쓸 수 있는지·받는 메일 주소. 인증 불요(가입 전 화면)."""
    from app.admin.users_ext import find_open_invite

    inv = await find_open_invite(db, token)
    if inv is None:
        return {"valid": False}
    return {"valid": True, "email": inv.email,
            "expires_at": inv.expires_at.isoformat() if inv.expires_at else None}


# ── GET /api/auth/verify-email — 이메일 인증 ────────────────


@router.get("/verify-email")
@limiter.limit("10/minute")
async def verify_email(request: Request, token: str = Query(...), db: AsyncSession = Depends(get_db)):
    """Verify recovery email via token link."""
    result = await db.execute(
        select(User).where(_token_match(User.email_verify_token, token))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=400, detail="유효하지 않은 인증 링크입니다.")

    # Check token expiry (24 hours)
    if user.email_verify_sent_at:
        elapsed = (datetime.now(timezone.utc) - user.email_verify_sent_at).total_seconds()
        if elapsed > 86400:
            raise HTTPException(
                status_code=400,
                detail="인증 링크가 만료되었습니다. 로그인 화면에서 인증 메일 재발송을 눌러주세요.",
            )

    user.email_verified = True
    user.email_verify_token = None
    await db.commit()

    # 이미 쓸 수 있는 계정(바로 가입·초대 가입·승인이 먼저 끝난 경우)에 "승인 후" 라고 하면 틀린 안내다
    if user.is_active:
        return {"message": "이메일 인증이 완료되었습니다. 이제 로그인할 수 있습니다."}
    return {"message": "이메일 인증이 완료되었습니다. 관리자 승인 후 로그인이 가능합니다."}


# ── POST /api/auth/resend-verification — 인증메일 재발송 ────

# 재발송 쿨다운. 메일이 스팸함에 갔거나 24시간 만료로 링크가 죽었을 때
# 사용자가 스스로 복구할 수 있어야 한다(예전에는 "다시 가입해주세요" 였는데
# username 이 이미 점유돼 재가입도 불가능했다).
RESEND_COOLDOWN_SEC = 60


async def issue_verification(user: User, db: AsyncSession) -> None:
    """새 인증 토큰을 발급해 복구 이메일로 보낸다. 실패해도 예외를 올리지 않는다."""
    token = secrets.token_urlsafe(32)
    user.email_verify_token = _token_digest(token)
    user.email_verify_sent_at = datetime.now(timezone.utc)
    await db.commit()
    if not user.recovery_email:
        return
    verify_url = f"{settings.app_url}/verify-email?token={token}"
    try:
        await _send_verify_email(user.recovery_email, user.username, verify_url)
    except Exception as e:
        logger.warning("Failed to send verification email to %s: %s", user.recovery_email, e)


@router.post("/resend-verification")
@limiter.limit("5/minute")
async def resend_verification(
    request: Request, body: ResendVerificationRequest, db: AsyncSession = Depends(get_db)
):
    """인증 메일 재발송. 계정 존재 여부를 흘리지 않도록 언제나 같은 응답."""
    success_msg = "인증 메일을 다시 보냈습니다. 복구 이메일을 확인해주세요."

    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()
    if not user or user.email_verified or not user.recovery_email:
        return {"message": success_msg}

    if user.email_verify_sent_at:
        elapsed = (datetime.now(timezone.utc) - user.email_verify_sent_at).total_seconds()
        if elapsed < RESEND_COOLDOWN_SEC:
            raise HTTPException(
                status_code=429,
                detail=f"잠시 후 다시 시도해주세요. ({int(RESEND_COOLDOWN_SEC - elapsed)}초 남음)",
            )

    await issue_verification(user, db)
    return {"message": success_msg}


# ── PATCH /api/auth/profile — 프로필 수정 ────────────────────


@router.patch("/profile")
async def update_profile(
    body: ProfileUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update display name."""
    # 복구 이메일은 여기서 바꾸지 않는다 — 비밀번호 재설정 링크가 가는 주소라, 세션만으로 바뀌면
    # 세션 탈취가 곧 계정 영구 탈취다. 본인 확인 + 새 주소 인증을 거치는 app/auth/recovery_email.py 로만.
    # (같은 값을 그대로 실어 보내는 옛 화면은 통과시킨다.)
    if body.recovery_email is not None and body.recovery_email != (user.recovery_email or "").strip().lower():
        raise HTTPException(
            status_code=400,
            detail="복구 이메일은 현재 비밀번호 확인과 새 주소 인증을 거쳐야 바꿀 수 있습니다",
        )

    if body.display_name is not None:
        user.display_name = body.display_name

    await db.commit()
    await db.refresh(user)
    return {"message": "프로필이 수정되었습니다"}


# ── POST /api/auth/avatar — 아바타 업로드 ────────────────────

AVATAR_DIR = Path(settings.storage_root) / "avatars"
AVATAR_MAX_BYTES = 5 * 1024 * 1024
AVATAR_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


@router.post("/avatar")
async def upload_avatar(
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload or replace user profile avatar."""
    if file.content_type not in AVATAR_ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="jpg/png/webp/gif 이미지만 허용됩니다")

    data = await file.read()
    if len(data) > AVATAR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="이미지 크기는 5MB 이하여야 합니다")

    import asyncio
    from io import BytesIO

    def _resize(raw: bytes) -> bytes:
        from PIL import Image
        img = Image.open(BytesIO(raw))
        img = img.convert("RGB")
        img.thumbnail((256, 256), Image.LANCZOS)
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()

    resized = await asyncio.to_thread(_resize, data)

    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{user.id}.jpg"
    (AVATAR_DIR / filename).write_bytes(resized)

    user.avatar_url = f"/api/auth/avatar/{filename}"
    await db.commit()

    return {"avatar_url": user.avatar_url}


# ── GET /api/auth/avatar/{filename} — 아바타 서빙 ────────────


@router.get("/avatar/{filename}")
async def serve_avatar(filename: str):
    """Serve avatar image file."""
    import re
    if not re.match(r'^[\w-]+\.jpg$', filename):
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = AVATAR_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Avatar not found")
    return FileResponse(str(path), media_type="image/jpeg")


# ── POST /api/auth/password-check — 비밀번호 규칙 판정(저장 안 함) ──────────


@router.post("/password-check")
@limiter.limit("30/minute")
async def password_check(
    request: Request,
    body: dict,
    user: User = Depends(get_current_user),
):
    """설정 › 보안 체크 목록의 "흔한 비밀번호 아님"·"아이디·이메일과 다름" 판정.
    블록리스트는 서버에만 있으므로 화면은 이 응답을 받은 뒤에 표시한다. 비밀번호는 기록하지 않는다."""
    pw = body.get("password") if isinstance(body, dict) else None
    if not isinstance(pw, str) or len(pw) > password_policy.MAX_LENGTH:
        raise HTTPException(status_code=400, detail="password 가 필요합니다")
    return password_policy.check(pw, user.username, user.email)


# ── POST /api/auth/change-password — 비밀번호 변경 ──────────


@router.post("/change-password")
@limiter.limit("5/minute")
async def change_password(
    request: Request,
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):  # noqa: E501
    """Change password (requires current password verification)."""
    if not user.password_hash or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=400, detail="현재 비밀번호가 올바르지 않습니다"
        )

    # 사용자명·이메일이 그대로 들어간 비밀번호 차단(스키마 단계에선 문맥을 모른다)
    password_policy.validate(body.new_password, user.username, user.email)

    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = datetime.now(timezone.utc)
    # 비밀번호가 바뀌면 기존 세션은 전부 끊는다(OWASP ASVS / NIST).
    # 세션을 탈취당한 사용자가 비밀번호를 바꿔도 공격자 세션이 살아 있으면
    # 사고 대응이 무력화된다. 현재 기기만 아래에서 새 세션으로 재발급한다.
    user.token_version = (user.token_version or 0) + 1
    # 데스크톱 앱·MCP 커넥터의 리프레시 토큰도 같이 끊는다(웹 세션만 끊으면 그쪽은 살아 있다)
    await revoke_user_refresh_tokens(db, user.id)
    await db.commit()
    try:
        from app.auth import sessions as _sess
        await _sess.revoke_user_sessions(user.id)
    except Exception as e:
        logger.warning("Failed to revoke sessions after password change for %s: %s", user.username, e)

    # Sync password to built-in mail server if enabled
    if await builtin_mailserver_enabled(db):
        try:
            from app.mail.mailserver import update_password as mail_update_password
            await mail_update_password(user.email, body.new_password)
        except Exception as e:
            logger.warning("Failed to sync password change to mail server for %s: %s", user.email, e)

    # 세션 재발급 — 위에서 token_version 을 올려 기존 쿠키를 전부 무효화했으므로
    # 현재 기기에는 새 세션을 내려준다(OWASP: 비밀번호 변경 후 세션 ID 재생성).
    return await _session_response(
        request, user, {"message": "비밀번호가 변경되었습니다. 다른 기기의 세션은 모두 로그아웃되었습니다"}
    )


# ── POST /api/auth/forgot-password — 비밀번호 찾기 ──────────


@router.post("/forgot-password")
@limiter.limit("3/minute")
async def forgot_password(
    request: Request, body: ForgotPasswordRequest, db: AsyncSession = Depends(get_db)
):
    """Send password reset link to recovery email."""
    result = await db.execute(
        select(User).where(User.username == body.username, User.is_active == True)
    )
    user = result.scalar_one_or_none()

    # Always return success to prevent username enumeration
    success_msg = "등록된 복구 이메일로 비밀번호 재설정 링크를 전송했습니다."

    # LDAP 계정은 비밀번호가 디렉터리에 있다. 여기서 링크를 주면 로컬 비밀번호가 새로 생겨
    # 디렉터리에서 막아도 들어올 수 있게 된다(관리자 링크 발급도 같은 이유로 막는다).
    if not user or not user.recovery_email or not await local_password_allowed(db, user):
        return {"message": success_msg}

    # Generate self-managed reset token
    token = secrets.token_urlsafe(32)
    user.password_reset_token = _token_digest(token)
    user.password_reset_sent_at = datetime.now(timezone.utc)
    await db.commit()

    reset_url = f"{settings.app_url}/reset-password?token={token}"
    try:
        await _send_recovery_email(user.recovery_email, user.username, reset_url)
    except Exception as e:
        logger.warning("Failed to send recovery email to %s: %s", user.recovery_email, e)

    return {"message": success_msg}


# ── POST /api/auth/reset-password — 비밀번호 재설정 ──────────


@router.post("/reset-password")
@limiter.limit("5/minute")
async def reset_password(request: Request, body: ResetPasswordRequest, db: AsyncSession = Depends(get_db)):
    """Reset password using a token from forgot-password email."""
    result = await db.execute(
        select(User).where(_token_match(User.password_reset_token, body.token))
    )
    user = result.scalar_one_or_none()

    if not user or not await local_password_allowed(db, user):
        raise HTTPException(status_code=400, detail="유효하지 않은 재설정 링크입니다")

    # Check expiry (1 hour)
    if user.password_reset_sent_at:
        elapsed = (datetime.now(timezone.utc) - user.password_reset_sent_at).total_seconds()
        if elapsed > 3600:
            raise HTTPException(status_code=400, detail="재설정 링크가 만료되었습니다")

    password_policy.validate(body.new_password, user.username, user.email)

    user.password_hash = hash_password(body.new_password)
    user.password_reset_token = None
    user.password_reset_sent_at = None
    user.password_changed_at = datetime.now(timezone.utc)
    # 재설정은 "비밀번호를 잊었다/탈취당했다" 정황이므로 전 세션을 끊는다.
    user.token_version = (user.token_version or 0) + 1
    await revoke_user_refresh_tokens(db, user.id)
    await db.commit()
    try:
        from app.auth import sessions as _sess
        await _sess.revoke_user_sessions(user.id)
    except Exception as e:
        logger.warning("Failed to revoke sessions after password reset for %s: %s", user.username, e)

    # Sync password to built-in mail server if enabled
    if await builtin_mailserver_enabled(db):
        try:
            from app.mail.mailserver import update_password as mail_update_password
            await mail_update_password(user.email, body.new_password)
        except Exception as e:
            logger.warning("Failed to sync password reset to mail server for %s: %s", user.email, e)

    return {"message": "비밀번호가 재설정되었습니다. 로그인해주세요."}


# ── GET /api/auth/users/search — 사용자 검색 ─────────────────


@router.get("/users/search")
async def search_users(
    q: str = Query(..., min_length=1, max_length=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Search active users by username or display_name (for meeting invitations etc.)."""
    safe_q = q.replace('%', '\\%').replace('_', '\\_')
    pattern = f"%{safe_q}%"
    result = await db.execute(
        select(User)
        .where(
            User.is_active == True,  # noqa: E712
            User.id != user.id,
            or_(
                User.username.ilike(pattern, escape='\\'),
                User.display_name.ilike(pattern, escape='\\'),
            ),
        )
        .limit(10)
    )
    users = result.scalars().all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "display_name": u.display_name or u.username,
            "email": u.email,
        }
        for u in users
    ]


# ── POST /api/auth/link-token — 외부 링크 자동 로그인 토큰 ────


@router.post("/link-token")
async def create_link_token(
    user: User = Depends(get_current_user),
):
    """Create a one-time login token for opening web links from desktop client."""
    import secrets
    from app.chat.redis_client import get_redis

    token = secrets.token_urlsafe(32)
    redis = await get_redis()
    await redis.setex(f"link_token:{token}", 30, user.id)  # 30초 만료
    return {"token": token}


def safe_local_redirect(target: str) -> str:
    """우리 사이트 안의 경로만 돌려준다(아니면 "/").

    "/" 로 시작하는지만 보면 "//evil.example"(스킴 없는 다른 호스트)이 통과한다. 브라우저는
    역슬래시도 "/" 로 읽으므로 그 꼴과 제어 문자도 막는다.
    """
    t = target or ""
    if not t.startswith("/") or t[1:2] in ("/", chr(92)):
        return "/"
    if any(ord(c) < 0x20 for c in t):
        return "/"
    return t


@router.get("/link-login")
async def link_login(
    request: Request,
    token: str = Query(...),
    redirect: str = Query("/"),
    db: AsyncSession = Depends(get_db),
):
    """One-time token login — creates session and redirects. Used by desktop client."""
    from starlette.responses import RedirectResponse
    from app.chat.redis_client import get_redis

    redis = await get_redis()
    user_id = await redis.get(f"link_token:{token}")
    if not user_id:
        raise HTTPException(status_code=401, detail="토큰이 만료되었거나 유효하지 않습니다")

    # Delete token (one-time use)
    await redis.delete(f"link_token:{token}")

    user = await db.get(User, user_id.decode() if isinstance(user_id, bytes) else user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="사용자를 찾을 수 없습니다")

    safe_redirect = safe_local_redirect(redirect)
    # 다른 계정 쿠키가 있어도 이 토큰의 계정으로 바꾼다 — 데스크톱 앱은 셸을 열 때마다 이 경로로 웹 세션을 맞추는데
    # (앱 로그아웃은 웹 쿠키를 지우지 않는다), 전환을 막으면 앱은 B 인데 화면은 앞사람 A 로 열린다.
    # 토큰은 30초·1회용이고 이동 주소는 위에서 앱 안 경로로 제한했다.

    # Create session cookie and redirect
    from app.auth import sessions as sess_mod
    ip = sess_mod.client_ip(request)
    hostname = await sess_mod.resolve_hostname(ip)
    sid = await sess_mod.create_session(
        user.id, ip, hostname, request.headers.get("user-agent", ""), SESSION_MAX_AGE_DEFAULT
    )
    session_data = sign_value({"user_id": user.id, "tv": user.token_version, "sid": sid})
    is_https = settings.app_url.startswith("https://")

    response = RedirectResponse(url=safe_redirect, status_code=302)
    response.set_cookie(
        SESSION_COOKIE,
        session_data,
        httponly=True,
        secure=is_https,
        samesite="lax",
        max_age=SESSION_MAX_AGE_DEFAULT,
        path="/",
    )
    return response


# ── GET /api/auth/users — 워크스페이스 사용자 목록 ────────────


@router.get("/users")
async def list_workspace_users(
    q: str = Query("", max_length=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all active users in this workspace (for contacts/directory)."""
    stmt = select(User).where(User.is_active == True)  # noqa: E712
    if q.strip():
        safe_q = q.replace('%', '\\%').replace('_', '\\_')
        pattern = f"%{safe_q}%"
        stmt = stmt.where(or_(
            User.username.ilike(pattern, escape='\\'),
            User.display_name.ilike(pattern, escape='\\'),
            User.email.ilike(pattern, escape='\\'),
        ))
    stmt = stmt.order_by(User.display_name, User.username).limit(200)
    result = await db.execute(stmt)
    users = result.scalars().all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "display_name": u.display_name or u.username,
            "email": u.email,
            "avatar_url": f"/api/auth/avatar/{u.id}.jpg" if u.avatar_url else None,
            "is_self": u.id == user.id,
        }
        for u in users
    ]


# ── 2FA (TOTP) endpoints ─────────────────────────────────────


@router.post("/2fa/setup")
async def setup_2fa(
    user: User = Depends(get_current_user),
):
    """Generate a new TOTP secret and return the otpauth URI for QR code display."""
    if user.totp_secret:
        raise HTTPException(status_code=400, detail="2단계 인증이 이미 활성화되어 있습니다")

    secret = pyotp.random_base32()
    totp = pyotp.TOTP(secret)
    otpauth_url = totp.provisioning_uri(
        name=user.username,
        issuer_name=settings.app_name,
    )
    # 화면에 바로 띄울 QR(PNG data URL) — 프런트에 QR 라이브러리를 들이지 않고 서버의 qrcode 로 그린다
    qr_data_url = ""
    try:
        import base64
        import io

        import qrcode

        buf = io.BytesIO()
        qrcode.make(otpauth_url, box_size=6, border=2).save(buf, format="PNG")
        qr_data_url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:  # noqa: BLE001 — QR 실패해도 비밀키 직접 입력으로 등록 가능
        logger.warning("2FA QR render failed: %s", e)
    return {"secret": secret, "otpauth_url": otpauth_url, "qr_data_url": qr_data_url}


@router.post("/2fa/enable")
async def enable_2fa(
    body: TwoFactorEnableRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Verify a TOTP code against the pending secret and enable 2FA."""
    if user.totp_secret:
        raise HTTPException(status_code=400, detail="2단계 인증이 이미 활성화되어 있습니다")

    # Validate the code against the secret provided during setup
    totp = pyotp.TOTP(body.secret)
    if not totp.verify(body.code, valid_window=1):
        raise HTTPException(status_code=400, detail="인증 코드가 올바르지 않습니다")

    # Store the secret only after successful verification
    user.totp_secret = body.secret
    # 복구 코드 10개 — 평문은 지금 한 번만 내려준다(저장은 HMAC 해시)
    from app.auth import two_factor
    codes = two_factor.issue_new_codes(user)
    await db.commit()
    return {"message": "2단계 인증이 활성화되었습니다", "recovery_codes": codes}


@router.post("/2fa/disable")
@limiter.limit("5/minute")
async def disable_2fa(
    request: Request,
    body: TwoFactorDisableRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """2단계 인증 끄기 — 인증 앱 코드 또는 복구 코드로 본인 확인(휴대폰을 잃었을 때도 끌 수 있게)."""
    if not user.totp_secret:
        raise HTTPException(status_code=400, detail="2단계 인증이 활성화되어 있지 않습니다")

    from app.auth import security_policy, two_factor
    # 정책 검사를 먼저 — 끌 수 없는 계정이면 복구 코드를 소모하지 않는다
    if security_policy.totp_required_for(await security_policy.get_policy_cached(db), user):
        raise HTTPException(status_code=400, detail="관리자 정책상 2단계 인증을 끌 수 없습니다")

    code = (body.code or "").strip()
    totp = pyotp.TOTP(user.totp_secret)
    if not totp.verify(code.replace(" ", ""), valid_window=1) and not two_factor.consume(user, code):
        raise HTTPException(status_code=400, detail="인증 코드가 올바르지 않습니다")
    user.totp_secret = None
    two_factor.clear_codes(user)
    await db.commit()
    return {"message": "2단계 인증이 비활성화되었습니다"}


@router.post("/2fa/verify")
@limiter.limit("3/minute")
async def verify_2fa(
    request: Request,
    body: TwoFactorVerifyRequest,
    db: AsyncSession = Depends(get_db),
):
    """Verify TOTP code during login flow using the temp_token."""
    data = unsign_value(body.temp_token, max_age=TEMP_TOKEN_MAX_AGE)
    if not data or data.get("purpose") != "2fa" or "user_id" not in data:
        raise HTTPException(status_code=401, detail="유효하지 않거나 만료된 임시 토큰입니다")

    user = await db.get(User, data["user_id"])
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="유효하지 않은 사용자입니다")

    if not user.totp_secret:
        raise HTTPException(status_code=400, detail="2단계 인증이 설정되어 있지 않습니다")

    # 코드 대입 방지 — 계정 기준으로 연속 실패를 센다(IP 한도만으로는 IP 를 바꿔 가며 대입할 수 있다)
    from app.auth import security_policy
    wait = await security_policy.check_2fa_lock(user.id)
    if wait:
        mins = max(1, (wait + 59) // 60)
        raise HTTPException(
            status_code=429,
            detail=f"인증 코드를 여러 번 틀렸습니다. {mins}분 뒤에 다시 시도하세요",
            headers={"Retry-After": str(wait)},
        )

    totp = pyotp.TOTP(user.totp_secret)
    if not totp.verify((body.code or "").replace(" ", ""), valid_window=1):
        # 인증 앱을 잃어버린 경우 — 복구 코드(xxxx-xxxx)를 한 번 쓸 수 있다
        from app.auth import two_factor
        if not two_factor.consume(user, body.code):
            await security_policy.record_2fa_failure(user.id)
            raise HTTPException(status_code=401, detail="인증 코드가 올바르지 않습니다")
    await security_policy.clear_2fa_failures(user.id)

    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    from app.auth import sessions as _sess_mod
    await security_policy.note_login_device(
        await security_policy.get_policy_cached(db), user,
        request.headers.get("user-agent", ""), _sess_mod.client_ip(request),
    )

    remember_me = data.get("remember_me", False)
    if remember_me:
        max_age = await get_session_max_age_remember(db)
    else:
        max_age = await get_session_max_age_default(db)
    return await _session_response(request, user, max_age=max_age)


# ── Email helpers ────────────────────────────────────────────


async def _send_verify_email(
    to_email: str, username: str, verify_url: str
) -> None:
    """Send email verification link via system SMTP."""
    import asyncio
    from email.mime.text import MIMEText
    from app.admin.settings import get_smtp_config, send_system_email
    from app.db.session import async_session

    async with async_session() as db:
        cfg = await get_smtp_config(db)

    msg = MIMEText(
        f"{username}님, 아래 링크를 클릭하여 이메일을 인증해주세요:\n\n"
        f"{verify_url}\n\n"
        f"이 링크는 24시간 후 만료됩니다.\n"
        f"본인이 요청하지 않은 경우 이 메일을 무시하세요.",
        "plain",
        "utf-8",
    )
    msg["Subject"] = f"[{settings.domain}] 이메일 인증"
    msg["From"] = cfg.from_addr
    msg["To"] = to_email

    await asyncio.to_thread(send_system_email, cfg, msg)


async def _send_recovery_email(
    to_email: str, username: str, recovery_link: str
) -> None:
    """Send recovery email via system SMTP."""
    import asyncio
    from email.mime.text import MIMEText
    from app.admin.settings import get_smtp_config, send_system_email
    from app.db.session import async_session

    async with async_session() as db:
        cfg = await get_smtp_config(db)

    msg = MIMEText(
        f"{username}님, 아래 링크를 클릭하여 비밀번호를 재설정하세요:\n\n"
        f"{recovery_link}\n\n"
        f"이 링크는 1시간 후 만료됩니다.\n"
        f"본인이 요청하지 않은 경우 이 메일을 무시하세요.",
        "plain",
        "utf-8",
    )
    msg["Subject"] = f"[{settings.domain}] 비밀번호 재설정"
    msg["From"] = cfg.from_addr
    msg["To"] = to_email

    await asyncio.to_thread(send_system_email, cfg, msg)


async def _send_admin_registration_notify(
    username: str, display_name: str, email: str, recovery_email: str
) -> None:
    """Notify admins when a new user registers."""
    import asyncio
    from email.mime.text import MIMEText
    from app.admin.settings import get_smtp_config, send_system_email
    from app.db.session import async_session

    admin_list = [e.strip() for e in settings.admin_emails.split(",") if e.strip()]
    if not admin_list:
        return

    async with async_session() as db:
        cfg = await get_smtp_config(db)

    msg = MIMEText(
        f"새로운 가입 신청이 접수되었습니다.\n\n"
        f"  사용자명: {username}\n"
        f"  표시 이름: {display_name or '(없음)'}\n"
        f"  포털 메일: {email}\n"
        f"  복구 이메일: {recovery_email}\n\n"
        f"포털 관리 페이지에서 승인/거절해주세요:\n"
        f"{settings.app_url}/admin/users",
        "plain",
        "utf-8",
    )
    msg["Subject"] = f"[{settings.domain}] 새 가입 신청: {username}"
    msg["From"] = cfg.from_addr
    msg["To"] = ", ".join(admin_list)

    await asyncio.to_thread(send_system_email, cfg, msg)
