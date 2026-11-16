"""Admin API routes: user approval, management, analytics, settings."""

import asyncio
import logging
import os
import secrets
import time as _time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, select, and_, case, distinct, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.sessions import client_ip as _sess_client_ip
from app.db.models import AccessLog, User
from app.db.session import get_db
from app.config import get_settings
from app.admin.settings import (
    get_setting,
    set_setting,
    delete_setting,
    get_settings_by_prefix,
    get_smtp_config,
    send_system_email,
    builtin_mailserver_enabled,
)
from app.admin.schemas import (
    AccessLogEntry,
    AccessLogPage,
    ActiveUser,
    AnalyticsOverview,
    DailyVisit,
    GitActivityItem,
    GitStats,
    RecentLogin,
    ServiceUsage,
    TopIP,
    TopPage,
)

logger = logging.getLogger(__name__)


# ── 감사 로그 ──
# audit_logs 테이블과 log_action() 은 존재했으나 **호출 지점이 없어 항상 비어 있었다.**
# "누가 언제 무슨 설정을 바꿨나" 에 답할 수 없는 상태였다. 계정·권한·세션·설정과 같이
# 복원이 어렵거나 보안에 직결되는 변경에 한해 기록한다(전 요청 로깅은 access_logs 담당).
from app.admin import audit  # noqa: E402
from app.files import retention  # noqa: E402  — 보존 정책 키·기본값


def _client_ip(request: Request | None) -> str | None:
    """감사 로그용 클라이언트 IP — `auth.sessions.client_ip` 와 동일한 규칙.

    기존에는 X-Forwarded-For 첫 값을 신뢰했다. RP 는 XFF 를 덮어쓰지 않고 뒤에 추가하므로
    인터넷에서 송신한 위조 값이 첫 값으로 남아 감사 로그에 그대로 기록되었다.
    """
    if request is None:
        return None
    return _sess_client_ip(request) or None

settings = get_settings()

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ── Dependency: admin-only ───────────────────────────────────


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")
    return user


# ── 세션 강제 로그아웃 ────────────────────────────────────────


@router.post("/sessions/logout-all")
async def logout_all_sessions(
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """모든 사용자의 전 세션 강제 로그아웃 (token_version 일괄 +1 + 레지스트리 정리).
    호출한 관리자 본인도 로그아웃되어 재로그인 필요."""
    from app.auth import sessions as sess_mod
    from app.auth.oauth_store import revoke_user_refresh_tokens
    result = await db.execute(update(User).values(token_version=User.token_version + 1))
    # 데스크톱 앱·MCP 커넥터의 리프레시 토큰도 전부 폐기한다(웹 세션만 종료하면 해당 토큰은 유효 상태로 남는다)
    await revoke_user_refresh_tokens(db, None)
    await db.commit()
    cleared = await sess_mod.revoke_all_sessions()
    logger.warning("[admin] %s forced LOGOUT-ALL (%s users, %s sessions)",
                   admin.username, result.rowcount, cleared)
    await audit.log_action(
        db, admin.id, "session.logout_all", None, None,
        {"users_affected": result.rowcount, "sessions_cleared": cleared},
        _client_ip(request),
    )
    return {"status": "ok", "users_affected": result.rowcount, "sessions_cleared": cleared}


@router.post("/users/{user_id}/logout")
async def logout_user_sessions(
    user_id: str,
    request: Request = None,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """특정 사용자의 전 세션 강제 로그아웃 (token_version +1 + 레지스트리 정리 + OAuth 리프레시 토큰 폐기)."""
    from app.auth import sessions as sess_mod
    from app.auth.oauth_store import revoke_user_refresh_tokens
    u = await db.get(User, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    u.token_version = (u.token_version or 0) + 1
    tokens = await revoke_user_refresh_tokens(db, user_id)
    await db.commit()
    await sess_mod.revoke_user_sessions(user_id)
    logger.warning("[admin] %s forced logout user=%s", admin.username, u.username)
    await audit.log_action(
        db, admin.id, "session.logout_user", "user", u.id,
        {"username": u.username, "oauth_tokens_revoked": tokens}, _client_ip(request),
    )
    return {"status": "ok"}


@router.get("/users/{user_id}/sessions")
async def list_user_sessions(
    user_id: str,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """특정 사용자의 활성 세션 목록 (IP/hostname/UA/last_seen)."""
    from app.auth import sessions as sess_mod
    u = await db.get(User, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    return {"sessions": await sess_mod.list_user_sessions(user_id)}


@router.post("/sessions/{sid}/revoke")
async def revoke_session(
    sid: str,
    request: Request = None,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """단일 세션(기기) 원격 로그아웃 — IP/hostname 으로 식별한 해당 세션만 종료."""
    from app.auth import sessions as sess_mod
    # 세션 소유자는 삭제 전에만 확인 가능하다(감사 로그용). sid 원문은 기록하지 않는다.
    try:
        owner = ((await sess_mod.get_session(sid)) or {}).get("user_id")
    except Exception:
        owner = None
    ok = await sess_mod.revoke_session(sid)
    logger.warning("[admin] %s revoked session sid=%s ok=%s", admin.username, sid[:8], ok)
    await audit.log_action(
        db, admin.id, "session.revoke", "user", owner, {"ok": ok}, _client_ip(request),
    )
    return {"status": "ok" if ok else "error"}


# ── GET /api/admin/users — 전체 사용자 목록 ──────────────────


def user_status(u: User) -> str:
    """active(사용 중) | pending(가입 승인 대기) | suspended(관리자가 정지).

    정지 시각(suspended_at) 도입 이전에 비활성화된 사용자는 로그인 이력으로 구분한다 —
    1회 이상 로그인했으면 정지, 아니면 승인 대기.
    """
    if u.is_active:
        return "active"
    if getattr(u, "suspended_at", None) is not None or u.last_login_at is not None:
        return "suspended"
    return "pending"


def _status_clause(status: str):
    from sqlalchemy import or_
    if status == "active":
        return User.is_active == True  # noqa: E712
    if status == "pending":
        return and_(User.is_active == False, User.suspended_at.is_(None), User.last_login_at.is_(None))  # noqa: E712
    return and_(User.is_active == False, or_(User.suspended_at.is_not(None), User.last_login_at.is_not(None)))  # noqa: E712


_USER_SORTS = {
    "created_at": User.created_at, "username": User.username, "display_name": User.display_name,
    "last_login_at": User.last_login_at, "email": User.email,
}


async def _user_groups(db: AsyncSession, user_ids: list[str]) -> dict[str, list[dict]]:
    from app.groups.models import Group, GroupMember
    if not user_ids:
        return {}
    rows = (await db.execute(
        select(GroupMember.user_id, Group.id, Group.name)
        .join(Group, Group.id == GroupMember.group_id)
        .where(GroupMember.user_id.in_(user_ids))
        .order_by(Group.name)
    )).all()
    out: dict[str, list[dict]] = {}
    for uid, gid, name in rows:
        out.setdefault(uid, []).append({"id": gid, "name": name})
    return out


def _user_row(u: User, groups: list[dict] | None = None) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "display_name": u.display_name,
        "email": u.email,
        "recovery_email": u.recovery_email,
        "is_admin": u.is_admin,
        "is_active": u.is_active,
        "email_verified": u.email_verified,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        # 관리 사용자 표 "최근 접속" 열·승인 대기/정지 구분(로그인 이력 유무)
        "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
        "status": user_status(u),
        "suspended_at": u.suspended_at.isoformat() if getattr(u, "suspended_at", None) else None,
        "avatar_url": u.avatar_url,
        "auth_source": u.auth_source or "local",
        # 관리 사용자 메뉴 "2단계 인증 초기화" 를 2단계 인증 활성화 사용자에게만 표시
        "has_2fa": bool(u.totp_secret),
        "groups": groups or [],
    }


@router.get("/users")
async def list_users(
    q: str | None = None,
    status: str | None = None,
    group: str | None = None,
    sort: str | None = None,
    page: int | None = None,
    size: int | None = None,
    role: str | None = None,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """List all users.

    인자 없이 호출하면 기존과 동일하게 전체 배열(최근 가입순)을 반환한다. 필터:
      q(아이디·이름·메일 부분 일치) · status(active|pending|suspended, 쉼표로 복수 지정 = 그중 하나) · group(그룹 id) ·
      role(admin|member) ·
      sort(created_at|username|display_name|last_login_at|email, 앞에 '-' 가 있으면 내림차순; 기본 -created_at)
    page/size 를 지정하면 {users, total, page, size} 형태로 반환한다(page 는 1부터).
    """
    from sqlalchemy import or_

    conds = []
    if q and q.strip():
        like = f"%{q.strip()}%"
        conds.append(or_(User.username.ilike(like), User.display_name.ilike(like), User.email.ilike(like)))
    if status:
        wanted = [x.strip() for x in status.split(",") if x.strip()]
        if not wanted or any(x not in ("active", "pending", "suspended") for x in wanted):
            raise HTTPException(status_code=400, detail="status 는 active·pending·suspended 중 하나(쉼표로 여럿)")
        conds.append(or_(*[_status_clause(x) for x in dict.fromkeys(wanted)]))
    if role:
        if role not in ("admin", "member"):
            raise HTTPException(status_code=400, detail="role 은 admin·member 중 하나")
        conds.append(User.is_admin == (role == "admin"))  # noqa: E712
    if group:
        from app.groups.models import GroupMember
        conds.append(User.id.in_(select(GroupMember.user_id).where(GroupMember.group_id == group)))

    sort = sort or "-created_at"
    desc = sort.startswith("-")
    col = _USER_SORTS.get(sort.lstrip("-"))
    if col is None:
        raise HTTPException(status_code=400, detail="지원하지 않는 정렬입니다")
    order = col.desc() if desc else col.asc()

    stmt = select(User).where(*conds).order_by(order, User.id)
    paged = page is not None or size is not None
    total = None
    if paged:
        page = max(1, page or 1)
        size = min(200, max(1, size or 50))
        total = (await db.execute(select(func.count(User.id)).where(*conds))).scalar() or 0
        stmt = stmt.offset((page - 1) * size).limit(size)
    users = (await db.execute(stmt)).scalars().all()
    groups = await _user_groups(db, [u.id for u in users])
    rows = [_user_row(u, groups.get(u.id)) for u in users]
    if paged:
        return {"users": rows, "total": total, "page": page, "size": size}
    return rows


# ── GET /api/admin/users/pending — 승인 대기 목록 ────────────


@router.get("/users/pending")
async def list_pending_users(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """List users pending approval."""
    result = await db.execute(
        select(User).where(User.is_active == False).order_by(User.created_at.desc())
    )
    users = result.scalars().all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "display_name": u.display_name,
            "email": u.email,
            "recovery_email": u.recovery_email,
            # 승인자가 "이 사람이 메일 인증을 했는지" 를 확인하여 판단할 수 있어야 한다
            "email_verified": u.email_verified,
            "email_verify_sent_at": u.email_verify_sent_at.isoformat() if u.email_verify_sent_at else None,
            "created_at": u.created_at.isoformat() if u.created_at else None,
            # 1회 이상 로그인했으면 "정지"(비활성화된 기존 사용자), 이력이 없으면 "승인 대기"
            "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
            "status": user_status(u),
        }
        for u in users
    ]


async def mailbox_exists(email: str) -> bool:
    """내장 메일서버에 해당 주소의 계정이 이미 존재하는지 여부(완전 일치 주소만).

    app.mail.mailserver.account_exists 는 목록 출력의 문자열 포함 여부만 확인하므로 "min@" 이
    "jimin@" 에도 일치한다. 가입 차단에 사용하면 정상 이름까지 차단되므로 주소 단위로 구분한다.
    """
    import re
    from app.mail import mailserver

    rc, out = await asyncio.to_thread(mailserver._docker_exec, ["setup", "email", "list"])
    if rc != 0:
        return False
    want = (email or "").strip().lower()
    return bool(want) and want in {m.lower() for m in re.findall(r"[^\s<>()*,;]+@[^\s<>()*,;]+", out or "")}


async def activate_user(db: AsyncSession, user: User, send_welcome: bool = True) -> bool:
    """승인 처리 본체 — 메일 사서함 보장·활성화·기본 캘린더/주소록·환영 메일.

    승인 버튼(approve_user)·일괄 승인·초대 링크 가입이 공용한다. 메일 사서함 생성 성공 여부를 반환한다.
    """
    # Ensure mail account exists in docker-mailserver (only if built-in mailserver is enabled)
    #
    # 빈 비밀번호로는 생성할 수 없다 — docker-mailserver 의 addmailuser 가
    # "Password must not be empty" 로 중단한다. 이 경우 계정이 accounts.cf 에
    # 등록되지 않아 postfix 의 virtual_mailbox_maps 에도 누락되고, 해당 주소로 수신되는
    # 메일이 전부 550 "User unknown in virtual mailbox table" 로 반송된다.
    #
    # 여기서 지정하는 비밀번호는 의미 없는 값이다. 메일 비밀번호 동기화는 폐지되었고
    # (dovecot passdb lua → 백엔드 /api/internal/mail-auth) 인증은 워크스페이스
    # 비밀번호로 매 요청 시 검증한다. 사서함은 postfix 라우팅을 위해 accounts.cf 에
    # 존재하기만 하면 충분하다. 가입 시점이 아닌 승인 시점에 생성하는 이유는,
    # 승인 전 계정에까지 사서함을 부여하면 스팸 가입자가 본 서버 도메인 주소를 보유하게 되기 때문이다.
    mail_created = True
    if await builtin_mailserver_enabled(db):
        try:
            from app.mail.mailserver import account_exists, create_account
            exists = await account_exists(user.email)
            if not exists:
                mail_created = await create_account(user.email, secrets.token_urlsafe(24))
        except Exception as e:
            logger.warning("Failed to ensure mail account for %s: %s", user.email, e)
            mail_created = False

    # Activate in DB
    user.is_active = True
    user.suspended_at = None
    await db.commit()

    # Create default calendar + address book for the new user
    try:
        from app.calendar.service import get_calendars, create_calendar
        from app.contacts.service import get_address_books, create_address_book
        cals = await get_calendars(db, user.id)
        if not cals:
            await create_calendar(db, user.id, "내 캘린더", "#3b82f6")
        books = await get_address_books(db, user.id)
        if not books:
            await create_address_book(db, user.id, "내 연락처")
    except Exception as e:
        logger.warning("Failed to create default calendar/address book for %s: %s", user.username, e)

    if send_welcome:
        try:
            await _send_welcome_email(user.email, user.username)
            logger.info("Welcome email sent to %s", user.email)
        except Exception as e:
            logger.warning("Failed to send welcome email to %s: %s", user.email, e)

    return mail_created


# ── POST /api/admin/users/{user_id}/approve — 승인 ──────────


@router.post("/users/{user_id}/approve")
async def approve_user(
    user_id: str,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Approve a pending user registration."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    if user.is_active:
        raise HTTPException(status_code=400, detail="이미 활성화된 사용자입니다")

    mail_created = await activate_user(db, user)

    msg = f"{user.username} 사용자가 승인되었습니다"
    if not mail_created:
        msg += " (메일 계정 생성에 실패했습니다. 수동 확인 필요)"

    await audit.log_action(
        db, admin.id, "user.approve", "user", user.id,
        {"username": user.username}, _client_ip(request),
    )
    return {"message": msg}


# ── POST /api/admin/users/{user_id}/resend-verification ─────


@router.post("/users/{user_id}/resend-verification")
async def admin_resend_verification(
    user_id: str,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """관리자가 인증 메일을 재발송한다(쿨다운 없음 — 수동 조작 버튼)."""
    from app.auth.router import issue_verification

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    if user.email_verified:
        raise HTTPException(status_code=400, detail="이미 인증된 사용자입니다")
    if not user.recovery_email:
        raise HTTPException(status_code=400, detail="복구 이메일이 등록되어 있지 않습니다")

    await issue_verification(user, db)
    await audit.log_action(
        db, admin.id, "user.resend_verification", "user", user.id,
        {"username": user.username}, _client_ip(request),
    )
    return {"message": f"{user.recovery_email} 으로 인증 메일을 다시 보냈습니다"}


# ── POST /api/admin/users/{user_id}/password-reset-link ─────


@router.post("/users/{user_id}/password-reset-link")
async def admin_password_reset_link(
    user_id: str,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """비밀번호 재설정 링크를 발급한다.

    복구 이메일로도 발송하지만 링크 자체를 관리자에게 반환한다 — 복구 이메일까지
    분실한 사용자의 구제가 본 기능의 목적이므로, 메일로만 발송하면
    정작 필요한 상황에서 사용할 수 없다. 관리자가 링크를 직접 전달한다.
    관리자가 비밀번호를 대신 지정하지는 않는다(지정 시 관리자가 타 사용자의 비밀번호를 알게 된다).
    """
    from app.auth.router import _send_recovery_email, _token_digest

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    # 컬럼 도입 이전에 생성된 계정은 auth_source 가 NULL 이다 — 로컬 계정으로 간주한다.
    # (기존에는 NULL != "local" 이어서 오래된 로컬 계정이 전부 "외부 인증"으로 차단되었다)
    if (user.auth_source or "local") != "local":
        raise HTTPException(status_code=400, detail="외부 인증(LDAP) 사용자는 여기서 재설정할 수 없습니다")

    token = secrets.token_urlsafe(32)
    user.password_reset_token = _token_digest(token)
    user.password_reset_sent_at = datetime.now(timezone.utc)
    await db.commit()

    reset_url = f"{settings.app_url}/reset-password?token={token}"
    emailed = False
    if user.recovery_email:
        try:
            await _send_recovery_email(user.recovery_email, user.username, reset_url)
            emailed = True
        except Exception as e:
            logger.warning("Failed to send admin-issued reset link to %s: %s", user.recovery_email, e)

    await audit.log_action(
        db, admin.id, "user.password_reset_link", "user", user.id,
        {"username": user.username, "emailed": emailed}, _client_ip(request),
    )
    return {"reset_url": reset_url, "emailed": emailed, "expires_hours": 1}


# ── POST /api/admin/users/{user_id}/reject — 거절 ───────────


@router.post("/users/{user_id}/reject")
async def reject_user(
    user_id: str,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Reject a pending user registration (deletes from workspace)."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    # 거절은 "가입 승인 대기"에만 적용한다. 가드가 없어 활성 사용자·자기 자신·마지막 관리자도 이 경로로
    # 삭제할 수 있었다(삭제 API 의 사용자명 확인·소유 이전·마지막 관리자 검사를 전부 우회).
    if user_status(user) != "pending":
        raise HTTPException(
            status_code=400,
            detail="가입 승인 대기 사용자만 거절할 수 있습니다(정지·활성 사용자는 삭제를 사용하십시오)",
        )
    # 아래에서 삭제되므로 감사 로그용으로 미리 확보한다.
    rejected_username = user.username

    # 메일 계정은 변경하지 않는다. 승인 대기 계정에는 사서함이 없다(승인 시 생성) — 여기서
    # `setup email del -y <주소>` 를 실행하면 삭제되는 것은 항상 동일 주소의 **타 사서함**이다
    # (시스템 발송 계정 noreply@, 수동 생성한 공용 사서함, 삭제된 사용자의 보존 사서함).
    # 해당 이름으로 가입 신청만 해도 관리자의 "거절" 1회로 메일 데이터가 소실되었다.

    # Delete from DB
    await db.delete(user)
    await db.commit()

    await audit.log_action(
        db, admin.id, "user.reject", "user", user_id,
        {"username": rejected_username}, _client_ip(request),
    )
    return {"message": "가입 신청이 거절되었습니다"}


# ── POST /api/admin/users/{user_id}/deactivate — 비활성화 ───


@router.post("/users/{user_id}/deactivate")
async def deactivate_user_endpoint(
    user_id: str,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Deactivate an active user."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    if not user.is_active:
        raise HTTPException(status_code=400, detail="이미 비활성화된 사용자입니다")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="자기 자신은 비활성화할 수 없습니다")

    # Deactivate in DB
    user.is_active = False
    user.suspended_at = datetime.now(timezone.utc)
    # 열린 세션도 종료한다(일괄 정지 users_ext 와 동일 규칙). 세션 폐기가 OIDC
    # 백채널 로그아웃을 유발하므로 외부 RP(별도 출처 앱) 세션도 함께 종료된다.
    user.token_version = (user.token_version or 0) + 1
    from app.auth.oauth_store import revoke_user_refresh_tokens
    await revoke_user_refresh_tokens(db, user.id)
    await db.commit()
    try:
        from app.auth import sessions as sess_mod
        await sess_mod.revoke_user_sessions(user.id)
    except Exception as e:
        logger.warning("비활성화 후 세션 폐기 실패(%s): %s", user.username, e)
    # 열려 있는 격리 브라우저 세션도 즉시 종료한다(실패해도 정지는 유지 — 회수 작업이 30초 이내에 재확인)
    from app.rbi.service import enforce_access_quietly
    await enforce_access_quietly(db, user_id=user.id, actor_id=admin.id, ip=_client_ip(request))

    await audit.log_action(
        db, admin.id, "user.deactivate", "user", user.id,
        {"username": user.username}, _client_ip(request),
    )
    return {"message": f"{user.username} 사용자가 비활성화되었습니다"}


# ── POST /api/admin/users/{user_id}/set-role — 권한 변경 ──


class SetRoleRequest(BaseModel):
    is_admin: bool


@router.post("/users/{user_id}/set-role")
async def set_user_role(
    user_id: str,
    body: SetRoleRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Grant or revoke admin role for a user."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="자기 자신의 권한은 변경할 수 없습니다")
    if not user.is_active:
        raise HTTPException(status_code=400, detail="비활성 사용자의 권한은 변경할 수 없습니다")
    if user.is_admin == body.is_admin:
        role = "관리자" if body.is_admin else "일반 사용자"
        raise HTTPException(status_code=400, detail=f"이미 {role}입니다")

    # Update DB
    user.is_admin = body.is_admin
    await db.commit()

    role = "관리자" if body.is_admin else "일반 사용자"
    await audit.log_action(
        db, admin.id, "user.set_role", "user", user.id,
        {"username": user.username, "role": role}, _client_ip(request),
    )
    return {"message": f"{user.username} 사용자가 {role}(으)로 변경되었습니다"}


# ── Analytics helpers ──────────────────────────────────────


def _period_start(period: str) -> datetime:
    now = datetime.now(timezone.utc)
    if period == "7d":
        return now - timedelta(days=7)
    if period == "30d":
        return now - timedelta(days=30)
    # today
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


# ── In-memory TTL cache ──────────────────────────────────

_cache: dict[str, tuple[float, Any]] = {}
_CACHE_TTL = 30  # seconds


def _cached(key: str) -> Any | None:
    entry = _cache.get(key)
    if entry and _time.monotonic() - entry[0] < _CACHE_TTL:
        return entry[1]
    return None


def _set_cache(key: str, value: Any) -> None:
    _cache[key] = (_time.monotonic(), value)


# ── Private IP exclusion for existing DB data ────────────

_PRIVATE_PREFIXES = (
    "10.", "172.16.", "172.17.", "172.18.", "172.19.",
    "172.20.", "172.21.", "172.22.", "172.23.", "172.24.",
    "172.25.", "172.26.", "172.27.", "172.28.", "172.29.",
    "172.30.", "172.31.", "192.168.", "127.", "::1", "fe80:", "fc00:", "fd",
)


def _exclude_private_ip():
    """SQLAlchemy filter: exclude Docker-internal IPs only (172.x bridge)."""
    docker_prefixes = (
        "172.16.", "172.17.", "172.18.", "172.19.",
        "172.20.", "172.21.", "172.22.", "172.23.", "172.24.",
        "172.25.", "172.26.", "172.27.", "172.28.", "172.29.",
        "172.30.", "172.31.", "127.",
    )
    return and_(*(~AccessLog.ip_address.startswith(p) for p in docker_prefixes))


# ── GET /api/admin/analytics/overview ─────────────────────


@router.get("/analytics/overview", response_model=AnalyticsOverview)
async def analytics_overview(
    period: str = Query("today", pattern="^(today|7d|30d)$"),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    cache_key = f"overview:{period}"
    if (hit := _cached(cache_key)) is not None:
        return hit

    since = _period_start(period)
    # "방문"은 요청 수가 아닌 방문자-일(distinct visitor per day) 단위로 집계.
    # (방문자 = 로그인 사용자면 user_id, 익명이면 ip) → API/폴링 요청에 의한 과다 집계 제거.
    _day = func.date(AccessLog.created_at)
    _visitor_day = func.concat(func.coalesce(AccessLog.user_id, AccessLog.ip_address), "|", _day)
    _auth_day = case((AccessLog.user_id.isnot(None), func.concat(AccessLog.user_id, "|", _day)))
    _anon_day = case((AccessLog.user_id.is_(None), func.concat(AccessLog.ip_address, "|", _day)))
    result = await db.execute(
        select(
            func.count(distinct(_visitor_day)),
            func.count(distinct(AccessLog.ip_address)),
            func.count(distinct(_auth_day)),
            func.count(distinct(_anon_day)),
            func.coalesce(func.avg(AccessLog.response_time_ms), 0),
        ).where(and_(AccessLog.created_at >= since, _exclude_private_ip()))
    )
    row = result.one()
    data = AnalyticsOverview(
        total_visits=row[0],
        unique_ips=row[1],
        authenticated_visits=row[2],
        unauthenticated_visits=row[3],
        avg_response_time_ms=int(row[4]),
    )
    _set_cache(cache_key, data)
    return data


# ── GET /api/admin/analytics/daily-visits ─────────────────


@router.get("/analytics/daily-visits", response_model=list[DailyVisit])
async def analytics_daily_visits(
    days: int = Query(30, ge=1, le=90),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    cache_key = f"daily:{days}"
    if (hit := _cached(cache_key)) is not None:
        return hit

    since = datetime.now(timezone.utc) - timedelta(days=days)
    date_col = func.date(AccessLog.created_at)
    # 일별 순방문자(요청 수가 아닌 distinct 방문자)
    _visitor = func.coalesce(AccessLog.user_id, AccessLog.ip_address)
    result = await db.execute(
        select(
            date_col.label("date"),
            func.count(distinct(_visitor)),
            func.count(distinct(AccessLog.user_id)),
            func.count(distinct(case((AccessLog.user_id.is_(None), AccessLog.ip_address)))),
        )
        .where(and_(AccessLog.created_at >= since, _exclude_private_ip()))
        .group_by(date_col)
        .order_by(date_col)
    )
    data = [
        DailyVisit(date=str(row[0]), total=row[1], authenticated=row[2], unauthenticated=row[3])
        for row in result.all()
    ]
    _set_cache(cache_key, data)
    return data


# ── GET /api/admin/analytics/top-pages ────────────────────


@router.get("/analytics/top-pages", response_model=list[TopPage])
async def analytics_top_pages(
    period: str = Query("today", pattern="^(today|7d|30d)$"),
    limit: int = Query(10, ge=1, le=50),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    cache_key = f"pages:{period}"
    if (hit := _cached(cache_key)) is not None:
        return hit

    since = _period_start(period)
    result = await db.execute(
        select(AccessLog.path, func.count(AccessLog.id).label("cnt"))
        .where(and_(AccessLog.created_at >= since, _exclude_private_ip()))
        .group_by(AccessLog.path)
        .order_by(func.count(AccessLog.id).desc())
        .limit(limit)
    )
    data = [TopPage(path=row[0], count=row[1]) for row in result.all()]
    _set_cache(cache_key, data)
    return data


# ── GET /api/admin/analytics/top-ips ──────────────────────


@router.get("/analytics/top-ips", response_model=list[TopIP])
async def analytics_top_ips(
    period: str = Query("today", pattern="^(today|7d|30d)$"),
    limit: int = Query(15, ge=1, le=50),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    cache_key = f"top-ips:{period}"
    if (hit := _cached(cache_key)) is not None:
        return hit

    since = _period_start(period)
    result = await db.execute(
        select(
            AccessLog.ip_address,
            func.count(AccessLog.id).label("cnt"),
            func.count(distinct(AccessLog.path)).label("paths"),
        )
        .where(and_(AccessLog.created_at >= since, _exclude_private_ip()))
        .group_by(AccessLog.ip_address)
        .order_by(func.count(AccessLog.id).desc())
        .limit(limit)
    )
    data = [
        TopIP(ip_address=row[0], count=row[1], paths=row[2])
        for row in result.all()
    ]
    _set_cache(cache_key, data)
    return data


# ── GET /api/admin/analytics/service-usage ────────────────


@router.get("/analytics/service-usage", response_model=list[ServiceUsage])
async def analytics_service_usage(
    period: str = Query("today", pattern="^(today|7d|30d)$"),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    cache_key = f"services:{period}"
    if (hit := _cached(cache_key)) is not None:
        return hit

    since = _period_start(period)
    result = await db.execute(
        select(AccessLog.service, func.count(AccessLog.id).label("cnt"))
        .where(and_(AccessLog.created_at >= since, AccessLog.service.isnot(None), _exclude_private_ip()))
        .group_by(AccessLog.service)
        .order_by(func.count(AccessLog.id).desc())
    )
    data = [ServiceUsage(service=row[0], count=row[1]) for row in result.all()]
    _set_cache(cache_key, data)
    return data


# ── GET /api/admin/analytics/active-users ─────────────────


@router.get("/analytics/active-users", response_model=list[ActiveUser])
async def analytics_active_users(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(minutes=5)
    # Subquery: latest log per user in last 5 min
    subq = (
        select(
            AccessLog.user_id,
            func.max(AccessLog.created_at).label("last_seen"),
        )
        .where(and_(AccessLog.created_at >= since, AccessLog.user_id.isnot(None)))
        .group_by(AccessLog.user_id)
        .subquery()
    )
    result = await db.execute(
        select(
            subq.c.user_id,
            User.username,
            User.display_name,
            AccessLog.path,
            AccessLog.ip_address,
            subq.c.last_seen,
        )
        .outerjoin(AccessLog, and_(
            AccessLog.user_id == subq.c.user_id,
            AccessLog.created_at == subq.c.last_seen,
        ))
        .outerjoin(User, User.id == subq.c.user_id)
        .order_by(subq.c.last_seen.desc())
    )
    return [
        ActiveUser(
            user_id=row[0], username=row[1], display_name=row[2],
            path=row[3], ip_address=row[4],
            last_seen=row[5].isoformat() if row[5] else "",
        )
        for row in result.all()
    ]


# ── GET /api/admin/analytics/recent-logins ────────────────


@router.get("/analytics/recent-logins", response_model=list[RecentLogin])
async def analytics_recent_logins(
    limit: int = Query(20, ge=1, le=100),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(
            AccessLog.user_id,
            User.username,
            User.display_name,
            AccessLog.ip_address,
            AccessLog.created_at,
        )
        .outerjoin(User, User.id == AccessLog.user_id)
        .where(and_(
            AccessLog.user_id.isnot(None),
            # 세션이 실제로 생성되는 두 지점(2단계 계정은 /2fa/verify). 사용자 칸은 로그인 처리기가
            # 요청 상태에 기록한 값으로 채워진다(middleware/access_log._extract_user_id).
            AccessLog.path.in_(["/api/auth/login", "/api/auth/2fa/verify"]),
            AccessLog.status_code < 400,
            _exclude_private_ip(),
        ))
        .order_by(AccessLog.created_at.desc())
        .limit(limit)
    )
    return [
        RecentLogin(
            user_id=row[0], username=row[1], display_name=row[2],
            ip_address=row[3],
            login_at=row[4].isoformat() if row[4] else "",
        )
        for row in result.all()
    ]


# ── GET /api/admin/analytics/access-logs ──────────────────


@router.get("/analytics/access-logs", response_model=AccessLogPage)
async def analytics_access_logs(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    service: str | None = Query(None),
    user_id: str | None = Query(None),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    conditions = [_exclude_private_ip()]
    if service:
        conditions.append(AccessLog.service == service)
    if user_id:
        conditions.append(AccessLog.user_id == user_id)

    where = and_(*conditions)

    # Count
    count_result = await db.execute(
        select(func.count(AccessLog.id)).where(where)
    )
    total = count_result.scalar() or 0

    # Fetch with LEFT JOIN to get username
    offset = (page - 1) * limit
    result = await db.execute(
        select(
            AccessLog.id,
            AccessLog.ip_address,
            AccessLog.method,
            AccessLog.path,
            AccessLog.status_code,
            AccessLog.response_time_ms,
            AccessLog.browser,
            AccessLog.os,
            AccessLog.device,
            AccessLog.user_id,
            User.username,
            AccessLog.service,
            AccessLog.created_at,
        )
        .outerjoin(User, User.id == AccessLog.user_id)
        .where(where)
        .order_by(AccessLog.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    logs = [
        AccessLogEntry(
            id=row[0], ip_address=row[1], method=row[2], path=row[3],
            status_code=row[4], response_time_ms=row[5],
            browser=row[6], os=row[7], device=row[8],
            user_id=row[9], username=row[10],
            service=row[11],
            created_at=row[12].isoformat() if row[12] else "",
        )
        for row in result.all()
    ]
    return AccessLogPage(logs=logs, total=total, page=page, limit=limit)


# ── GET /api/admin/analytics/git-activity ─────────────────


@router.get("/analytics/git-activity", response_model=list[GitActivityItem])
async def analytics_git_activity(
    admin: User = Depends(require_admin),
):
    if (hit := _cached("git-activity")) is not None:
        return hit

    from app.git import gitea
    try:
        repos, _ = await gitea.search_repos(limit=10, sort="updated")
    except Exception:
        return []

    items: list[GitActivityItem] = []
    for repo in repos[:5]:
        owner = repo.get("owner", {}).get("login", "")
        name = repo.get("name", "")
        full = repo.get("full_name", f"{owner}/{name}")

        # Recent commits (as push events)
        try:
            commits = await gitea.get_commits(owner, name, page=1)
            for c in commits[:3]:
                commit_info = c.get("commit", {})
                items.append(GitActivityItem(
                    repo_name=name, repo_full_name=full,
                    event_type="push",
                    title=commit_info.get("message", "").split("\n")[0][:100],
                    user=commit_info.get("author", {}).get("name", ""),
                    created_at=commit_info.get("author", {}).get("date", ""),
                ))
        except Exception:
            pass

        # Recent issues
        try:
            issues = await gitea.get_issues(owner, name, state="all", page=1)
            for iss in issues[:2]:
                items.append(GitActivityItem(
                    repo_name=name, repo_full_name=full,
                    event_type="issue",
                    title=iss.get("title", "")[:100],
                    user=iss.get("user", {}).get("login", ""),
                    created_at=iss.get("created_at", ""),
                ))
        except Exception:
            pass

        # Recent PRs
        try:
            pulls = await gitea.get_pulls(owner, name, state="all", page=1)
            for pr in pulls[:2]:
                items.append(GitActivityItem(
                    repo_name=name, repo_full_name=full,
                    event_type="pull_request",
                    title=pr.get("title", "")[:100],
                    user=pr.get("user", {}).get("login", ""),
                    created_at=pr.get("created_at", ""),
                ))
        except Exception:
            pass

    items.sort(key=lambda x: x.created_at, reverse=True)
    data = items[:20]
    _set_cache("git-activity", data)
    return data


# ── GET /api/admin/analytics/git-stats ────────────────────


@router.get("/analytics/git-stats", response_model=GitStats)
async def analytics_git_stats(
    admin: User = Depends(require_admin),
):
    if (hit := _cached("git-stats")) is not None:
        return hit

    from app.git import gitea
    try:
        repos, total_repos = await gitea.search_repos(limit=50, sort="updated")
        total_issues = sum(r.get("open_issues_count", 0) for r in repos)
        total_pulls = sum(r.get("open_pr_counter", 0) for r in repos)
        # Unique owners as proxy for users
        users = {r.get("owner", {}).get("login") for r in repos}
        data = GitStats(
            total_repos=total_repos,
            total_users=len(users),
            total_issues=total_issues,
            total_pulls=total_pulls,
        )
        _set_cache("git-stats", data)
        return data
    except Exception:
        return GitStats(total_repos=0, total_users=0, total_issues=0, total_pulls=0)


# ── Email helper ──────────────────────────────────────────


async def _send_welcome_email(to_email: str, username: str, db: AsyncSession | None = None) -> None:
    """Send welcome email via system SMTP."""
    from email.mime.text import MIMEText
    from app.db.session import async_session as _async_session

    async def _inner(session: AsyncSession):
        smtp_cfg = await get_smtp_config(session)
        msg = MIMEText(
            f"{username}님, {settings.app_name} 가입이 승인되었습니다.\n\n"
            f"이제 {settings.app_url} 에 로그인하여 메일, 파일, "
            f"회의 등 모든 서비스를 이용하실 수 있습니다.\n\n"
            f"— {settings.app_name} 관리팀",
            "plain",
            "utf-8",
        )
        msg["Subject"] = f"[{settings.domain}] 가입이 승인되었습니다"
        msg["From"] = smtp_cfg.from_addr
        msg["To"] = to_email
        await asyncio.to_thread(send_system_email, smtp_cfg, msg)

    if db:
        await _inner(db)
    else:
        async with _async_session() as session:
            await _inner(session)


# ── Settings API ─────────────────────────────────────────


LOGO_DIR = Path(settings.storage_root) / "branding"
LOGO_MAX_BYTES = 2 * 1024 * 1024
LOGO_ALLOWED_TYPES = {"image/png", "image/jpeg", "image/svg+xml", "image/webp"}
SSL_DIR = Path("/etc/nginx/ssl")


class BrandingUpdate(BaseModel):
    site_name: str | None = None
    primary_color: str | None = None
    default_theme: str | None = None  # light | dark | system


class GeneralUpdate(BaseModel):
    registration_mode: str | None = None  # open | approval | closed
    upload_max_size_mb: int | None = None
    session_hours: int | None = None
    session_remember_days: int | None = None
    announcement: str | None = None
    announcement_type: str | None = None  # info | warning | error
    git_visibility: str | None = None  # public | private
    trash_retention_days: int | None = None     # 휴지통 자동 삭제(일, 0=비활성)
    versions_max_age_days: int | None = None    # 버전 스냅샷 상한(일, 0=간격표만)


class SmtpUpdate(BaseModel):
    host: str | None = None
    port: int | None = None
    security: str | None = None  # starttls | ssl | none
    user: str | None = None
    password: str | None = None
    from_addr: str | None = None


class SmtpTestRequest(BaseModel):
    to_email: str


# ── Branding ─────────────────────────────────────────────


@router.get("/settings/branding")
async def get_branding(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get current branding settings (DB values with .env fallback)."""
    db_vals = await get_settings_by_prefix(db, "branding.")
    return {
        "site_name": db_vals.get("branding.site_name") or settings.app_name,
        "primary_color": db_vals.get("branding.primary_color") or settings.brand_color,
        "logo_url": db_vals.get("branding.logo_url") or settings.brand_logo or "",
        "default_theme": db_vals.get("branding.default_theme") or "system",
        "favicon_url": db_vals.get("branding.favicon_url") or "",
    }


@router.patch("/settings/branding")
async def update_branding(
    body: BrandingUpdate,
    request: Request = None,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update branding settings in DB."""
    if body.site_name is not None:
        await set_setting(db, "branding.site_name", body.site_name)
    if body.primary_color is not None:
        await set_setting(db, "branding.primary_color", body.primary_color)
    if body.default_theme is not None:
        if body.default_theme not in ("light", "dark", "system"):
            raise HTTPException(status_code=400, detail="유효하지 않은 테마 값입니다")
        await set_setting(db, "branding.default_theme", body.default_theme)
    await audit.log_action(
        db, admin.id, "settings.branding.update", "settings", "branding",
        {"keys": sorted(k for k, v in body.model_dump(exclude_unset=True).items() if v is not None)},
        _client_ip(request),
    )
    return {"message": "브랜딩 설정이 저장되었습니다"}


@router.post("/settings/branding/logo")
async def upload_logo(
    file: UploadFile,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Upload site logo (max 2MB, png/jpeg/svg/webp)."""
    if file.content_type not in LOGO_ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="png/jpeg/svg/webp 이미지만 허용됩니다")

    data = await file.read()
    if len(data) > LOGO_MAX_BYTES:
        raise HTTPException(status_code=413, detail="로고 이미지는 2MB 이하여야 합니다")

    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    ext = file.filename.rsplit(".", 1)[-1] if file.filename and "." in file.filename else "png"
    filename = f"logo.{ext}"
    (LOGO_DIR / filename).write_bytes(data)

    logo_url = "/api/branding/logo"
    await set_setting(db, "branding.logo_url", logo_url)
    await audit.log_action(db, admin.id, "settings.branding.logo_upload", "settings", "branding")
    return {"logo_url": logo_url}


@router.delete("/settings/branding/logo")
async def delete_logo(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Delete uploaded logo."""
    await delete_setting(db, "branding.logo_url")
    # Remove logo files
    if LOGO_DIR.exists():
        for f in LOGO_DIR.iterdir():
            if f.name.startswith("logo."):
                f.unlink(missing_ok=True)
    await audit.log_action(db, admin.id, "settings.branding.logo_delete", "settings", "branding")
    return {"message": "로고가 삭제되었습니다"}


# ── App Config (디자인 대개편 확장 설정) ──────────────────────
# appcfg.<key> 로 저장, /api/health 가 nested config 로 공개. 키 allowlist + maxlength 검증.
APPCFG_MAXLEN: dict[str, int] = {
    "brand.tagline": 60, "brand.short": 20, "brand.wallpaper": 16,
    "brand.wallpaper_url": 500, "brand.footer_links": 1000,
    "dash.greeting_mode": 16, "dash.greeting_text": 80, "dash.subtitle": 120,
    "dash.notice_banner": 120, "dash.notice_level": 16, "dash.primary_action": 40,
    "dash.primary_href": 200, "dash.cards": 300, "dash.shortcuts": 1000,
    "dash.layout": 4000,   # 관리자 기본 배치(JSON — app/dashboard/layout.py 가 검증·정규화)
    "auth.subtitle": 120, "auth.secondary_label": 40, "auth.secondary_href": 200,
    "auth.signup_enabled": 8, "auth.footer_note": 200,
    "empty.mail": 400, "empty.board": 400, "empty.wiki": 400, "empty.ai": 400,
    "system.status_services": 500, "system.latency_warn_ms": 8, "system.support_note": 200,
}


def normalize_dash_layout_text(val: str) -> str:
    """관리자 기본 배치(JSON 문자열) → 검증·정규화한 JSON 문자열. 고정(locked) 카드 허용."""
    import json
    from app.dashboard.layout import normalize_layout
    try:
        return json.dumps(normalize_layout(json.loads(val), allow_locked=True), ensure_ascii=False, separators=(",", ":"))
    except ValueError as e:   # json.JSONDecodeError 도 ValueError
        raise HTTPException(status_code=400, detail=f"dash.layout: {e}")


class AppConfigUpdate(BaseModel):
    values: dict[str, str]


@router.get("/settings/appconfig")
async def get_appconfig(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """현재 확장 앱설정(appcfg.*) — 프리픽스 제거한 dict."""
    raw = await get_settings_by_prefix(db, "appcfg.")
    return {"values": {k[len("appcfg."):]: v for k, v in raw.items()}}


@router.patch("/settings/appconfig")
async def update_appconfig(
    body: AppConfigUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """확장 앱설정 upsert. 허용 키만, maxlength 검증. 빈 문자열 = 요소 숨김(값 비움)."""
    for key, val in body.values.items():
        if key not in APPCFG_MAXLEN:
            raise HTTPException(status_code=400, detail=f"알 수 없는 설정 키: {key}")
        if val is not None and len(val) > APPCFG_MAXLEN[key]:
            raise HTTPException(status_code=400, detail=f"{key}: 최대 {APPCFG_MAXLEN[key]}자")
        if key == "dash.layout" and val:
            val = normalize_dash_layout_text(val)
        await set_setting(db, f"appcfg.{key}", val or "")
    # 로그인 화면 문구·보조 링크(auth.secondary_href)·대시보드 바로가기 등 모든 사용자에게 노출되는 값이다
    await audit.log_action(
        db, admin.id, "settings.appconfig.update", "settings", "appconfig", {"keys": sorted(body.values)},
    )
    return {"message": "설정이 저장되었습니다"}


# 이미지 및 영상(월페이퍼 엔진 방식의 동적 배경) 허용
WALLPAPER_ALLOWED_TYPES = {"image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"}
WALLPAPER_MAX_BYTES = 40 * 1024 * 1024  # 영상 허용으로 상향
WALLPAPER_MAX_COUNT = 4  # 브랜딩 화면 타일 그리드 — 최대 4장


def _wallpaper_files() -> list[str]:
    """branding 디렉터리의 wallpaper 파일명 목록(정렬)."""
    if not LOGO_DIR.exists():
        return []
    return sorted(f.name for f in LOGO_DIR.iterdir() if f.is_file() and f.name.startswith("wallpaper"))


def _wallpaper_index(name: str) -> int:
    """wallpaper-{n}-… 의 n(없으면 0)."""
    parts = name.split("-")
    return int(parts[1]) if len(parts) >= 3 and parts[1].isdigit() else 0


def _next_wallpaper_index() -> int:
    return max((_wallpaper_index(n) for n in _wallpaper_files()), default=-1) + 1


def reorder_wallpapers(names: list[str]) -> list[str]:
    """배경 순서 변경 — 파일 이름 앞 번호를 0,1,2… 로 재부여한다(정렬 = 표시 순서).
    names 는 현재 존재하는 파일 이름 전체(순서만 상이). 2단계 이름 변경으로 상호 덮어쓰기를 방지한다."""
    current = _wallpaper_files()
    if sorted(names) != sorted(current) or len(set(names)) != len(names):
        raise HTTPException(status_code=400, detail="지금 있는 배경 이름 전체를 순서대로 보내야 합니다")
    tmp: list[tuple[Path, str]] = []
    for i, n in enumerate(names):
        rest = n.split("-", 2)[2] if n.count("-") >= 2 else n.removeprefix("wallpaper")
        final = f"wallpaper-{i}-{rest}"
        t = LOGO_DIR / f".reorder-{i}-{rest}"
        (LOGO_DIR / n).rename(t)
        tmp.append((t, final))
    for t, final in tmp:
        t.rename(LOGO_DIR / final)
    return _wallpaper_files()


@router.put("/settings/appconfig/wallpapers/order")
async def order_wallpapers(
    body: dict,
    admin: User = Depends(require_admin),
):
    """배경 순서(드래그로 변경). body = {"names": ["wallpaper-…", …]} — 현재 존재하는 항목 전체."""
    names = body.get("names") if isinstance(body, dict) else None
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise HTTPException(status_code=400, detail="names 목록이 필요합니다")
    files = reorder_wallpapers([n.rsplit("/", 1)[-1] for n in names])
    return {"wallpapers": [f"/api/branding/wallpaper/{n}" for n in files]}


@router.post("/settings/appconfig/wallpaper")
async def upload_wallpaper(
    file: UploadFile,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """로그인/셸 배경 업로드 (다중 누적, max 40MB, png/jpeg/webp/mp4/webm).
    복수 업로드 시 로그인 화면 접속마다 무작위로 하나가 표시된다."""
    if file.content_type not in WALLPAPER_ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="png/jpeg/webp/mp4/webm 만 허용됩니다")
    if len(_wallpaper_files()) >= WALLPAPER_MAX_COUNT:
        raise HTTPException(status_code=400, detail=f"배경은 {WALLPAPER_MAX_COUNT}장까지입니다")
    data = await file.read()
    if len(data) > WALLPAPER_MAX_BYTES:
        raise HTTPException(status_code=413, detail="배경은 40MB 이하여야 합니다")
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    ext = file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "jpg"
    # 누적 저장(기존 파일 삭제 없음) — 고유 이름 사용. 순서 번호는 마지막 순번(정렬 = 표시 순서)
    name = f"wallpaper-{_next_wallpaper_index()}-{abs(hash(data)) % 10_000_000}.{ext}"
    (LOGO_DIR / name).write_bytes(data)
    # 최초 업로드 시 mode 를 image 로, url 은 목록 API 를 가리키도록 설정
    await set_setting(db, "appcfg.brand.wallpaper", "image")
    await set_setting(db, "appcfg.brand.wallpaper_url", "/api/branding/wallpapers")
    await audit.log_action(db, admin.id, "settings.branding.wallpaper_upload", "settings", "branding", {"name": name})
    return {"ok": True, "name": name, "count": len(_wallpaper_files())}


@router.get("/settings/appconfig/wallpapers")
async def list_wallpapers_admin(
    admin: User = Depends(require_admin),
):
    """업로드된 배경 목록(관리용)."""
    return {"wallpapers": [f"/api/branding/wallpaper/{n}" for n in _wallpaper_files()]}


@router.delete("/settings/appconfig/wallpaper")
async def delete_wallpaper(
    name: str | None = None,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """배경 삭제. name 지정 시 해당 1장, 미지정 시 전체."""
    if LOGO_DIR.exists():
        for f in LOGO_DIR.iterdir():
            if f.name.startswith("wallpaper") and (name is None or f.name == name):
                f.unlink(missing_ok=True)
    if not _wallpaper_files():  # 전부 삭제된 경우 config 도 초기화
        await delete_setting(db, "appcfg.brand.wallpaper_url")
    await audit.log_action(
        db, admin.id, "settings.branding.wallpaper_delete", "settings", "branding", {"name": name or "*"},
    )
    return {"message": "삭제되었습니다", "count": len(_wallpaper_files())}


# ── Favicon ──────────────────────────────────────────────

FAVICON_ALLOWED_TYPES = {"image/x-icon", "image/vnd.microsoft.icon", "image/png", "image/svg+xml"}
FAVICON_MAX_BYTES = 1 * 1024 * 1024


@router.post("/settings/branding/favicon")
async def upload_favicon(
    file: UploadFile,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Upload site favicon (max 1MB, ico/png/svg)."""
    ct = file.content_type or ""
    if ct not in FAVICON_ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="ico/png/svg 파일만 허용됩니다")

    data = await file.read()
    if len(data) > FAVICON_MAX_BYTES:
        raise HTTPException(status_code=413, detail="파비콘은 1MB 이하여야 합니다")

    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    # Remove old favicons
    for f in LOGO_DIR.iterdir():
        if f.name.startswith("favicon."):
            f.unlink(missing_ok=True)

    ext = file.filename.rsplit(".", 1)[-1] if file.filename and "." in file.filename else "ico"
    filename = f"favicon.{ext}"
    (LOGO_DIR / filename).write_bytes(data)

    favicon_url = "/api/branding/favicon"
    await set_setting(db, "branding.favicon_url", favicon_url)
    await audit.log_action(db, admin.id, "settings.branding.favicon_upload", "settings", "branding")
    return {"favicon_url": favicon_url}


@router.delete("/settings/branding/favicon")
async def delete_favicon(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Delete uploaded favicon."""
    await delete_setting(db, "branding.favicon_url")
    if LOGO_DIR.exists():
        for f in LOGO_DIR.iterdir():
            if f.name.startswith("favicon."):
                f.unlink(missing_ok=True)
    await audit.log_action(db, admin.id, "settings.branding.favicon_delete", "settings", "branding")
    return {"message": "파비콘이 삭제되었습니다"}


# ── General settings ─────────────────────────────────────


@router.get("/settings/general")
async def get_general_settings(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get general settings."""
    gen_vals = await get_settings_by_prefix(db, "general.")
    auth_vals = await get_settings_by_prefix(db, "auth.")
    file_vals = await get_settings_by_prefix(db, "files.")
    return {
        "registration_mode": auth_vals.get("auth.registration_mode") or "approval",
        "upload_max_size_mb": int(gen_vals.get("general.upload_max_size_mb") or str(settings.upload_max_size_mb)),
        "session_hours": int(auth_vals.get("auth.session_hours") or "8"),
        "session_remember_days": int(auth_vals.get("auth.session_remember_days") or "30"),
        "announcement": gen_vals.get("general.announcement") or "",
        "announcement_type": gen_vals.get("general.announcement_type") or "info",
        "git_visibility": gen_vals.get("general.git_visibility") or "private",
        # 파일 보존 정책(app/files/retention.py 가 매시간 적용)
        "trash_retention_days": int(file_vals.get(retention.KEY_TRASH_DAYS) or retention.DEFAULT_TRASH_DAYS),
        "versions_max_age_days": int(file_vals.get(retention.KEY_VERSIONS_MAX_AGE_DAYS) or retention.DEFAULT_VERSIONS_MAX_AGE_DAYS),
    }


@router.patch("/settings/general")
async def update_general_settings(
    body: GeneralUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update general settings."""
    if body.registration_mode is not None:
        if body.registration_mode not in ("open", "approval", "closed"):
            raise HTTPException(status_code=400, detail="유효하지 않은 가입 모드입니다")
        await set_setting(db, "auth.registration_mode", body.registration_mode)
    if body.upload_max_size_mb is not None:
        if body.upload_max_size_mb < 1 or body.upload_max_size_mb > 10240:
            raise HTTPException(status_code=400, detail="업로드 크기는 1~10240 MB 범위여야 합니다")
        await set_setting(db, "general.upload_max_size_mb", str(body.upload_max_size_mb))
    if body.session_hours is not None:
        if body.session_hours < 1 or body.session_hours > 720:
            raise HTTPException(status_code=400, detail="세션 시간은 1~720시간 범위여야 합니다")
        await set_setting(db, "auth.session_hours", str(body.session_hours))
    if body.session_remember_days is not None:
        if body.session_remember_days < 1 or body.session_remember_days > 365:
            raise HTTPException(status_code=400, detail="기억 기간은 1~365일 범위여야 합니다")
        await set_setting(db, "auth.session_remember_days", str(body.session_remember_days))
    if body.announcement is not None:
        await set_setting(db, "general.announcement", body.announcement)
    if body.announcement_type is not None:
        if body.announcement_type not in ("info", "warning", "error"):
            raise HTTPException(status_code=400, detail="유효하지 않은 공지 유형입니다")
        await set_setting(db, "general.announcement_type", body.announcement_type)
    if body.git_visibility is not None:
        if body.git_visibility not in ("public", "private"):
            raise HTTPException(status_code=400, detail="유효하지 않은 Git 공개 설정입니다")
        await set_setting(db, "general.git_visibility", body.git_visibility)
    if body.trash_retention_days is not None:
        if body.trash_retention_days < 0 or body.trash_retention_days > 3650:
            raise HTTPException(status_code=400, detail="휴지통 보존 기간은 0~3650일 범위여야 합니다")
        await set_setting(db, retention.KEY_TRASH_DAYS, str(body.trash_retention_days))
    if body.versions_max_age_days is not None:
        if body.versions_max_age_days < 0 or body.versions_max_age_days > 3650:
            raise HTTPException(status_code=400, detail="버전 보존 상한은 0~3650일 범위여야 합니다")
        await set_setting(db, retention.KEY_VERSIONS_MAX_AGE_DAYS, str(body.versions_max_age_days))
    await audit.log_action(
        db, admin.id, "settings.general.update", "settings", "general",
        # 값 자체가 아닌 **변경된 항목**만 기록한다. 공지 문구 등
        # 긴 값을 그대로 저장하면 감사 로그가 급격히 비대해진다.
        {"keys": sorted(
            k for k, v in body.model_dump(exclude_unset=True).items()
            if v is not None
        )},
        _client_ip(request),
    )
    return {"message": "일반 설정이 저장되었습니다"}


# ── SMTP ─────────────────────────────────────────────────


@router.get("/settings/smtp")
async def get_smtp(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get SMTP settings (password masked)."""
    cfg = await get_smtp_config(db)
    return {
        "host": cfg.host,
        "port": cfg.port,
        "security": cfg.security,
        "user": cfg.user,
        "password": "••••••••" if cfg.password else "",
        "from_addr": cfg.from_addr,
        "last_test_at": await get_setting(db, "smtp.last_test_at") or None,
        "last_test_ok": (await get_setting(db, "smtp.last_test_ok")) == "true",
    }


@router.patch("/settings/smtp")
async def update_smtp(
    request: Request,
    body: SmtpUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update SMTP settings in DB."""
    if body.host is not None:
        await set_setting(db, "smtp.host", body.host)
    if body.port is not None:
        await set_setting(db, "smtp.port", str(body.port))
    if body.security is not None:
        await set_setting(db, "smtp.security", body.security)
    if body.user is not None:
        await set_setting(db, "smtp.user", body.user)
    if body.password is not None:
        await set_setting(db, "smtp.password", body.password)
    if body.from_addr is not None:
        await set_setting(db, "smtp.from", body.from_addr)
    await audit.log_action(
        db, admin.id, "settings.smtp.update", "settings", "smtp",
        None, _client_ip(request),   # 값은 기록하지 않는다 — 비밀번호가 포함될 수 있다
    )
    return {"message": "SMTP 설정이 저장되었습니다"}


@router.post("/settings/smtp/test")
async def test_smtp(
    body: SmtpTestRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Send a test email using current SMTP settings."""
    from email.mime.text import MIMEText

    cfg = await get_smtp_config(db)
    msg = MIMEText(
        f"이 메일은 {settings.domain} 포털의 SMTP 테스트 메일입니다.\n\n"
        f"이 메일이 정상 수신되었다면 SMTP 설정이 올바르게 구성된 것입니다.",
        "plain",
        "utf-8",
    )
    msg["Subject"] = f"[{settings.domain}] SMTP 테스트"
    msg["From"] = cfg.from_addr
    msg["To"] = body.to_email

    # 마지막 시험 결과를 기록한다(관리 › 메일 발송 카드 푸터 "마지막 시험 MM/DD HH:MM · 성공")
    async def _record(ok: bool) -> None:
        try:
            await set_setting(db, "smtp.last_test_at", datetime.now(timezone.utc).isoformat())
            await set_setting(db, "smtp.last_test_ok", "true" if ok else "false")
        except Exception as e:  # noqa: BLE001
            logger.warning("SMTP test result not recorded: %s", e)

    try:
        await asyncio.to_thread(send_system_email, cfg, msg)
        await _record(True)
        return {"message": f"{body.to_email}으로 테스트 메일이 전송되었습니다"}
    except Exception as e:
        logger.error("SMTP test failed: %s", e)
        await _record(False)
        raise HTTPException(status_code=500, detail=f"SMTP 테스트 실패: {e}")


# ── SSL ──────────────────────────────────────────────────


@router.get("/settings/ssl")
async def get_ssl_status(
    admin: User = Depends(require_admin),
):
    """SSL 인증서 상태.

    installed·subject·… 는 관리 화면에서 업로드한 인증서(/etc/nginx/ssl) 정보, effective 는 실제 사용 중인 인증서
    (관리 개요 ops-summary 의 ssl 과 동일한 값 — 설치 관리자 → 설정 파일 → 업로드한 인증서 → SSL_CHECK_HOST → 공개 주소 순).
    """
    import subprocess

    from app.admin.users_ext import ssl_expiry

    effective = await ssl_expiry()
    cert_path = SSL_DIR / "cert.pem"
    key_path = SSL_DIR / "key.pem"

    if not cert_path.is_file():
        return {"installed": False, "message": "SSL 인증서가 설치되지 않았습니다", "effective": effective}

    try:
        result = subprocess.run(
            ["openssl", "x509", "-in", str(cert_path), "-noout",
             "-subject", "-issuer", "-dates"],
            capture_output=True, text=True, timeout=5,
        )
        lines = result.stdout.strip().split("\n")
        info = {}
        for line in lines:
            if "=" in line:
                k, v = line.split("=", 1)
                info[k.strip()] = v.strip()
        return {
            "installed": True,
            "subject": info.get("subject", ""),
            "issuer": info.get("issuer", ""),
            "not_before": info.get("notBefore", ""),
            "not_after": info.get("notAfter", ""),
            "has_key": key_path.is_file(),
            "effective": effective,
        }
    except Exception as e:
        return {"installed": True, "error": str(e), "effective": effective}


_SSL_ERR = {
    "cert_invalid": "인증서로 읽을 수 없습니다",
    "domain_mismatch": "인증서가 이 워크스페이스 도메인을 포함하지 않습니다",
    "key_invalid": "개인 키로 읽을 수 없습니다",
    "key_encrypted": "암호가 걸린 개인 키는 사용할 수 없습니다",
    "key_mismatch": "인증서와 개인 키의 짝이 맞지 않습니다",
}


@router.post("/settings/ssl/inspect")
async def inspect_ssl(
    cert: UploadFile | None = None,
    key: UploadFile | None = None,
    admin: User = Depends(require_admin),
):
    """업로드 전 사전 검사(저장하지 않음) — 인증서의 도메인·발급자·유효 기간, 키 쌍 일치, 도메인 일치.
    필드별 오류 코드(cert_error·key_error)를 개별 반환한다. ok 이면 [업로드 후 적용] 가능."""
    from app.admin import ssl_inspect

    cert_data = await cert.read(ssl_inspect.MAX_BYTES + 1) if cert else None
    key_data = await key.read(ssl_inspect.MAX_BYTES + 1) if key else None
    return ssl_inspect.inspect(cert_data, key_data, settings.domain)


async def _audit_ssl(admin: User, action: str, details: dict | None, request: Request | None) -> None:
    """인증서 업로드·삭제 감사 기록. 파일은 이미 변경된 상태이므로, 기록 실패가 해당 결과를 무효화하지 않도록 별도 세션을 사용한다."""
    from app.db.session import async_session

    try:
        async with async_session() as s:
            await audit.log_action(s, admin.id, action, "settings", "ssl", details, _client_ip(request))
    except Exception as e:  # noqa: BLE001
        logger.warning("SSL 감사 로그 기록 실패(%s): %s", action, e)


@router.post("/settings/ssl")
async def upload_ssl(
    cert: UploadFile,
    key: UploadFile,
    request: Request = None,
    admin: User = Depends(require_admin),
):
    """인증서·개인 키 업로드. 저장 전에 동일한 검사(/settings/ssl/inspect)를 수행한다 —
    둘 다 판독 가능하고 키 쌍이 일치하며 워크스페이스 도메인을 포함할 때만 저장(아니면 400 {code, message})."""
    from app.admin import ssl_inspect

    cert_data = await cert.read(ssl_inspect.MAX_BYTES + 1)
    key_data = await key.read(ssl_inspect.MAX_BYTES + 1)

    if len(cert_data) > ssl_inspect.MAX_BYTES or len(key_data) > ssl_inspect.MAX_BYTES:
        raise HTTPException(status_code=413, detail="인증서/키 파일은 1MB 이하여야 합니다")
    r = ssl_inspect.inspect(cert_data, key_data, settings.domain)
    if not r["ok"]:
        code = r["cert_error"] or r["key_error"] or "cert_invalid"
        raise HTTPException(status_code=400, detail={"code": code, "message": _SSL_ERR.get(code, code)})

    SSL_DIR.mkdir(parents=True, exist_ok=True)
    (SSL_DIR / "cert.pem").write_bytes(cert_data)
    (SSL_DIR / "key.pem").write_bytes(key_data)
    from app.admin.users_ext import clear_ssl_cache
    clear_ssl_cache()
    # 사이트 인증서·개인 키 교체 — 변경 주체와 시각을 기록한다(내용은 기록하지 않는다)
    await _audit_ssl(
        admin, "settings.ssl.upload",
        {"subject": (r.get("cert") or {}).get("subject") if isinstance(r.get("cert"), dict) else None},
        request,
    )

    return {
        "message": "SSL 인증서가 업로드되었습니다. nginx 재시작이 필요할 수 있습니다.",
    }


@router.delete("/settings/ssl")
async def delete_ssl(
    request: Request = None,
    admin: User = Depends(require_admin),
):
    """Delete uploaded SSL certificate."""
    for name in ("cert.pem", "key.pem"):
        path = SSL_DIR / name
        if path.is_file():
            path.unlink()
    from app.admin.users_ext import clear_ssl_cache
    clear_ssl_cache()
    await _audit_ssl(admin, "settings.ssl.delete", None, request)
    return {"message": "SSL 인증서가 삭제되었습니다"}


# ── Audit Logs ────────────────────────────────────────────


@router.get("/audit-logs")
async def list_audit_logs(
    page: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    actor_id: str | None = Query(None),
    action: str | None = Query(None),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """List audit log entries with optional filters (admin only)."""
    from app.admin.audit import get_audit_logs

    logs, total = await get_audit_logs(
        db, page=page, limit=limit, actor_id=actor_id, action=action
    )
    return {"logs": logs, "total": total, "page": page, "limit": limit}
