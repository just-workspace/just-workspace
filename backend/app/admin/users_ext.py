"""관리 사용자 확장 — 일괄 처리·삭제(안전장치)·초대 링크·운영 요약.

admin/router.py 의 규모가 이미 크므로 신규 엔드포인트는 본 모듈에 둔다(동일한 /api/admin 접두사, 동일한 관리자 검사).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import audit
from app.admin.router import _client_ip, activate_user, require_admin, user_status, _status_clause
from app.config import get_settings
from app.db.models import Base, TaskDB, User, UserInvite
from app.db.session import get_db

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ════════════════════════════════════════════
# 일괄 처리
# ════════════════════════════════════════════


class BulkRequest(BaseModel):
    ids: list[str] = Field(..., min_length=1, max_length=200)
    action: str  # approve | reject | suspend | add_group
    group_id: str | None = None


async def _active_admin_count(db: AsyncSession, exclude: set[str] | None = None) -> int:
    stmt = select(func.count(User.id)).where(User.is_admin == True, User.is_active == True)  # noqa: E712
    if exclude:
        stmt = stmt.where(User.id.not_in(exclude))
    return (await db.execute(stmt)).scalar() or 0


@router.post("/users/bulk")
async def bulk_users(
    body: BulkRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """복수 사용자 일괄 처리 — approve(승인/정지 해제) · reject(가입 대기만 거절=삭제) · suspend(정지) ·
    add_group(그룹 추가, group_id 필수). 사용자별 결과를 개별 반환한다(일부 실패 시에도 나머지는 진행)."""
    action = body.action
    if action not in ("approve", "reject", "suspend", "add_group"):
        raise HTTPException(status_code=400, detail="action 은 approve·reject·suspend·add_group 중 하나")
    group = None
    if action == "add_group":
        from app.groups.models import Group
        if not body.group_id or not (group := await db.get(Group, body.group_id)):
            raise HTTPException(status_code=400, detail="그룹을 찾을 수 없습니다")

    ids = list(dict.fromkeys(body.ids))
    if action == "suspend":
        # 본 일괄 정지로 활성 관리자가 0명이 되는 경우 차단한다
        targets = set(ids) - {admin.id}
        if await _active_admin_count(db, exclude=targets) == 0:
            raise HTTPException(status_code=400, detail="마지막 관리자까지 정지할 수 없습니다")

    results = []
    for uid in ids:
        user = await db.get(User, uid)
        if user is None:
            results.append({"id": uid, "ok": False, "error": "사용자를 찾을 수 없습니다"})
            continue
        try:
            if action == "approve":
                if user.is_active:
                    raise ValueError("이미 활성 사용자입니다")
                mail_ok = await activate_user(db, user)
                results.append({"id": uid, "ok": True, "status": "active",
                                **({} if mail_ok else {"warning": "메일 계정 생성 실패 — 수동 확인"})})
            elif action == "reject":
                if user_status(user) != "pending":
                    raise ValueError("가입 승인 대기 사용자만 거절할 수 있습니다(정지·활성 사용자는 삭제 API 사용)")
                # 메일 계정은 삭제하지 않는다 — 승인 대기 계정에는 사서함이 없으므로(승인 시 생성)
                # 여기서 삭제되는 것은 동일 주소의 타 사서함뿐이다(admin/router.reject_user 주석 참고).
                await db.delete(user)
                await db.commit()
                results.append({"id": uid, "ok": True, "status": "deleted"})
            elif action == "suspend":
                if user.id == admin.id:
                    raise ValueError("자기 자신은 정지할 수 없습니다")
                if not user.is_active:
                    raise ValueError("이미 비활성 사용자입니다")
                user.is_active = False
                user.suspended_at = datetime.now(timezone.utc)
                user.token_version = (user.token_version or 0) + 1   # 열린 세션도 종료
                from app.auth.oauth_store import revoke_user_refresh_tokens
                await revoke_user_refresh_tokens(db, user.id)        # 데스크톱 앱·MCP 커넥터 포함
                await db.commit()
                try:
                    from app.auth import sessions as sess_mod
                    await sess_mod.revoke_user_sessions(user.id)
                except Exception:
                    pass
                # 열려 있는 격리 브라우저 세션도 즉시 종료한다(실패해도 정지는 유지)
                from app.rbi.service import enforce_access_quietly
                await enforce_access_quietly(db, user_id=uid, actor_id=admin.id, ip=_client_ip(request))
                results.append({"id": uid, "ok": True, "status": "suspended"})
            else:  # add_group
                from app.groups.models import GroupMember
                exists = (await db.execute(select(GroupMember.id).where(
                    GroupMember.group_id == group.id, GroupMember.user_id == uid))).first()
                if not exists:
                    db.add(GroupMember(group_id=group.id, user_id=uid))
                    await db.commit()
                results.append({"id": uid, "ok": True, "group_id": group.id, "already": bool(exists)})
        except ValueError as e:
            results.append({"id": uid, "ok": False, "error": str(e)})
        except Exception as e:
            await db.rollback()
            logger.warning("일괄 %s 실패(%s): %s", action, uid, e)
            results.append({"id": uid, "ok": False, "error": "처리 중 오류"})

    if action == "add_group":
        try:
            from app.groups import service as gsvc
            await gsvc.load_grants(db)
        except Exception:
            pass
    done = sum(1 for r in results if r["ok"])
    await audit.log_action(
        db, admin.id, f"user.bulk_{action}", "user", None,
        {"ids": ids, "ok": done, "failed": len(results) - done, "group_id": body.group_id}, _client_ip(request),
    )
    return {"action": action, "ok": done, "failed": len(results) - done, "results": results}


# ════════════════════════════════════════════
# 삭제 — 안전장치 및 소유 데이터 처리
# ════════════════════════════════════════════
#
# 처리 방침(삭제 응답·사전 점검 응답의 "policy" 로도 동일하게 반환한다):
#   1. 자기 자신·마지막 활성 관리자는 삭제 금지. 오조작 방지를 위해 confirm=<사용자명> 이 일치해야 한다.
#   2. 공동 사용 데이터(채널 개설자·위키 공간 소유·위키 문서/버전 작성자·게시글/댓글 작성자)는
#      transfer_to(인수 사용자) 가 지정되면 해당 사용자에게 이전한다. 미지정 상태에서 해당 데이터가 있으면 409 로
#      목록을 반환하고 중단한다(게시글·댓글은 DB 규칙상 삭제 시 함께 삭제되므로 이전하지 않으면 소실된다).
#   3. 개인 데이터(작업·알림·캘린더·연락처·채팅 멤버십·기기·푸시 구독·메일 서명·공유 링크 등)는 삭제.
#   4. 타 사용자가 생성한 작업의 담당자였으면 담당자만 NULL 처리한다. 접속·감사 로그는 보존하고 사용자 칸만 NULL 처리한다.
#   5. 디스크의 개인 파일(storage/users/<id>)·메일 사서함·Git 계정은 **삭제하지 않는다** — 복원 불가이므로
#      관리자가 확인 후 직접 정리한다. 응답에 경로를 포함한다.

POLICY = [
    "자기 자신·마지막 활성 관리자는 삭제할 수 없습니다",
    "공동 콘텐츠(채널·위키·게시글/댓글)는 transfer_to 사용자에게 넘깁니다(없으면 중단)",
    "개인 데이터(작업·알림·일정·연락처·채팅 멤버십·기기·푸시 구독 등)는 삭제됩니다",
    "남의 작업 담당자였으면 담당만 비우고, 접속·감사 로그는 사용자 칸만 비웁니다",
    "개인 파일 폴더·메일 사서함·Git 계정은 지우지 않습니다 — 관리자가 직접 정리",
]

# (테이블, 컬럼) — 인수 사용자에게 소유를 이전할 공동 콘텐츠
TRANSFER_COLUMNS = [
    ("channels", "created_by"),
    ("wiki_spaces", "owner_id"),
    ("wiki_pages", "author_id"),
    ("wiki_page_versions", "author_id"),
    ("posts", "author_id"),
    ("post_comments", "author_id"),
]
# 사용자 칸만 NULL 처리할 기록(nullable)
NULLIFY_COLUMNS = [("access_logs", "user_id"), ("audit_logs", "actor_id"), ("tasks", "assignee_id")]
# FK 없이 사용자 id 를 보유한 개인 데이터 — 직접 삭제한다
EXTRA_DELETE_COLUMNS = [("group_members", "user_id"), ("user_devices", "user_id")]


def _user_fk_columns() -> list[tuple[str, str, str | None, bool]]:
    """users.id 를 가리키는 모든 FK 컬럼 — (테이블, 컬럼, ondelete, nullable)."""
    out = []
    for table in Base.metadata.sorted_tables:
        if table.name == "users":
            continue
        for col in table.columns:
            for fk in col.foreign_keys:
                if fk.column.table.name == "users" and fk.column.name == "id":
                    out.append((table.name, col.name, (fk.ondelete or "").upper() or None, bool(col.nullable)))
    return out


async def _count(db: AsyncSession, table: str, col: str, uid: str) -> int:
    t = Base.metadata.tables.get(table)
    if t is None or col not in t.c:
        return 0
    try:
        return (await db.execute(select(func.count()).select_from(t).where(t.c[col] == uid))).scalar() or 0
    except Exception:
        await db.rollback()
        return 0   # 해당 테이블이 본 설치에 없음(모듈 미사용 등)


async def delete_impact(db: AsyncSession, user: User) -> dict:
    """삭제 시 처리 내역 — 테이블별 건수."""
    transfer = {}
    for t, c in TRANSFER_COLUMNS:
        n = await _count(db, t, c, user.id)
        if n:
            transfer[f"{t}.{c}"] = n
    nullify = {}
    for t, c in NULLIFY_COLUMNS:
        n = await _count(db, t, c, user.id)
        if n:
            nullify[f"{t}.{c}"] = n
    skip = {f"{t}.{c}" for t, c in TRANSFER_COLUMNS + NULLIFY_COLUMNS}
    deleted = {}
    for t, c, _ondelete, _nullable in _user_fk_columns():
        if f"{t}.{c}" in skip:
            continue
        n = await _count(db, t, c, user.id)
        if n:
            deleted[f"{t}.{c}"] = n
    for t, c in EXTRA_DELETE_COLUMNS:
        n = await _count(db, t, c, user.id)
        if n:
            deleted[f"{t}.{c}"] = n
    files = Path(settings.storage_root) / "users" / user.id
    return {
        "user": {"id": user.id, "username": user.username, "status": user_status(user), "is_admin": user.is_admin},
        "transfer_required": transfer,
        "nullified": nullify,
        "deleted": deleted,
        "kept_outside_db": {
            "files_dir": str(files) if files.exists() else None,
            "mail_account": user.email,
            "note": "파일 폴더·메일 사서함·Git 계정은 남는다 — 확인 후 직접 정리",
        },
        "policy": POLICY,
    }


async def _guard_delete(db: AsyncSession, user: User, admin: User) -> None:
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="자기 자신은 삭제할 수 없습니다")
    if user.is_admin and user.is_active and await _active_admin_count(db, exclude={user.id}) == 0:
        raise HTTPException(status_code=400, detail="마지막 관리자는 삭제할 수 없습니다")


@router.get("/users/{user_id}/delete-impact")
async def user_delete_impact(
    user_id: str,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """삭제 전 점검 — 이전 대상 공동 콘텐츠·삭제될 개인 데이터·잔존 파일. 변경을 수행하지 않는다."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    impact = await delete_impact(db, user)
    try:
        await _guard_delete(db, user, admin)
        impact["blocked"] = None
    except HTTPException as e:
        impact["blocked"] = e.detail
    return impact


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    request: Request,
    confirm: str | None = None,
    transfer_to: str | None = None,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """사용자 삭제. confirm=<사용자명> 필수. 공동 콘텐츠가 있으면 transfer_to=<사용자 id> 필수."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    await _guard_delete(db, user, admin)
    if confirm != user.username:
        raise HTTPException(status_code=400, detail="확인용 사용자명(confirm)이 맞지 않습니다")

    impact = await delete_impact(db, user)
    heir = None
    if transfer_to:
        if transfer_to == user.id:
            raise HTTPException(status_code=400, detail="넘겨받을 사용자가 삭제 대상과 같습니다")
        heir = await db.get(User, transfer_to)
        if heir is None or not heir.is_active:
            raise HTTPException(status_code=400, detail="넘겨받을 사용자를 찾을 수 없습니다(활성 사용자여야 함)")
    if impact["transfer_required"] and heir is None:
        raise HTTPException(status_code=409, detail={
            "message": "공동 콘텐츠가 있어 넘겨받을 사용자(transfer_to)가 필요합니다",
            "transfer_required": impact["transfer_required"],
        })

    username = user.username
    md = Base.metadata.tables
    try:
        if heir is not None:
            for t, c in TRANSFER_COLUMNS:
                if t in md and c in md[t].c:
                    await db.execute(update(md[t]).where(md[t].c[c] == user.id).values({c: heir.id}))
        for t, c in NULLIFY_COLUMNS:
            if t in md and c in md[t].c:
                await db.execute(update(md[t]).where(md[t].c[c] == user.id).values({c: None}))
        for t, c in EXTRA_DELETE_COLUMNS:
            if t in md and c in md[t].c:
                await db.execute(delete(md[t]).where(md[t].c[c] == user.id))
        # FK 가 있으나 DB 에 CASCADE 가 없는 개인 데이터는 먼저 삭제한다(예: push_subscriptions, mail_signatures)
        transfer_keys = {f"{t}.{c}" for t, c in TRANSFER_COLUMNS + NULLIFY_COLUMNS}
        for t, c, ondelete, nullable in _user_fk_columns():
            if f"{t}.{c}" in transfer_keys or ondelete in ("CASCADE", "SET NULL"):
                continue
            if nullable:
                await db.execute(update(md[t]).where(md[t].c[c] == user.id).values({c: None}))
            else:
                await db.execute(delete(md[t]).where(md[t].c[c] == user.id))
        # users.id 를 FK 없이 보유한 OAuth 리프레시 토큰 — 행은 남더라도 사용할 수 없도록 폐기한다
        from app.auth.oauth_store import revoke_user_refresh_tokens
        await revoke_user_refresh_tokens(db, user.id)
        await db.delete(user)
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        logger.warning("사용자 삭제 실패(%s): %s", username, e)
        raise HTTPException(status_code=409, detail="연결된 데이터 때문에 삭제하지 못했습니다 — 대신 정지(suspend)를 쓰세요")

    try:
        from app.auth import sessions as sess_mod
        await sess_mod.revoke_user_sessions(user_id)
    except Exception:
        pass
    # 삭제된 계정이 열어 둔 격리 브라우저 세션도 즉시 종료한다(실패해도 삭제는 유지)
    from app.rbi.service import enforce_access_quietly
    await enforce_access_quietly(db, user_id=user_id, actor_id=admin.id, ip=_client_ip(request))
    await audit.log_action(
        db, admin.id, "user.delete", "user", user_id,
        {"username": username, "transfer_to": transfer_to,
         "transferred": impact["transfer_required"], "deleted": impact["deleted"]},
        _client_ip(request),
    )
    return {"message": f"{username} 사용자를 삭제했습니다", "transfer_to": transfer_to, **impact}


# ════════════════════════════════════════════
# 2단계 인증 초기화
# ════════════════════════════════════════════


@router.post("/users/{user_id}/reset-2fa")
async def reset_user_2fa(
    user_id: str,
    request: Request = None,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """사용자의 2단계 인증을 비활성화한다 — 인증 앱과 복구 코드를 모두 분실한 사용자를 구제하는 유일한 수단.

    본인은 코드가 있어야만 비활성화할 수 있다(/api/auth/2fa/disable). 둘 다 없으면 DB 를 수동으로 수정하는 방법밖에
    없었다. 비활성화와 함께 해당 사용자의 열린 세션도 종료한다(그 사이 제3자가 접속해 있었을 가능성). 정책상 2단계가
    필수인 사용자는 다음 로그인 시 등록 화면으로 이동한다.
    """
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    if not user.totp_secret:
        raise HTTPException(status_code=400, detail="2단계 인증을 쓰지 않는 사용자입니다")
    from app.auth import security_policy, two_factor

    user.totp_secret = None
    two_factor.clear_codes(user)
    if user.id != admin.id:
        user.token_version = (user.token_version or 0) + 1
    await db.commit()
    if user.id != admin.id:
        try:
            from app.auth import sessions as sess_mod
            await sess_mod.revoke_user_sessions(user.id)
        except Exception:
            pass
    await security_policy.clear_2fa_failures(user.id)
    await audit.log_action(
        db, admin.id, "user.reset_2fa", "user", user.id, {"username": user.username}, _client_ip(request),
    )
    return {"message": f"{user.username} 사용자의 2단계 인증을 초기화했습니다"}


# ════════════════════════════════════════════
# 초대 링크
# ════════════════════════════════════════════


class InviteCreate(BaseModel):
    emails: list[str] = Field(default_factory=list, max_length=100)
    count: int = Field(1, ge=1, le=50)       # emails 가 비어 있을 때 생성할 링크 수(메일 없이 링크만)
    expires_days: int = Field(7, ge=1, le=90)
    group_id: str | None = None
    send_email: bool = True


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def invite_url(token: str) -> str:
    return f"{settings.app_url}/register?invite={token}"


def _invite_state(inv: UserInvite, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    exp = inv.expires_at if inv.expires_at.tzinfo else inv.expires_at.replace(tzinfo=timezone.utc)
    if inv.revoked_at:
        return "revoked"
    if inv.used_at:
        return "used"
    if exp < now:
        return "expired"
    return "open"


def _invite_dict(inv: UserInvite) -> dict:
    return {
        "id": inv.id, "email": inv.email, "group_id": inv.group_id, "invited_by": inv.invited_by,
        "expires_at": inv.expires_at.isoformat() if inv.expires_at else None,
        "used_at": inv.used_at.isoformat() if inv.used_at else None, "used_by": inv.used_by,
        "created_at": inv.created_at.isoformat() if inv.created_at else None,
        "state": _invite_state(inv),
    }


async def _send_invite_mail(db: AsyncSession, to: str, url: str, inviter: str, expires: datetime) -> None:
    """기존 시스템 메일 발송 유틸(get_smtp_config + send_system_email)."""
    from email.mime.text import MIMEText

    from app.admin.settings import get_smtp_config, send_system_email

    cfg = await get_smtp_config(db)
    msg = MIMEText(
        f"{inviter} 님이 {settings.app_name} 에 초대했습니다.\n\n"
        f"아래 링크에서 가입하면 바로 사용할 수 있습니다(승인 대기 없음).\n{url}\n\n"
        f"링크는 {expires.strftime('%Y-%m-%d')} 까지 한 번만 쓸 수 있습니다.\n\n— {settings.app_name}",
        "plain", "utf-8",
    )
    msg["Subject"] = f"[{settings.domain}] {settings.app_name} 초대"
    msg["From"] = cfg.from_addr
    msg["To"] = to
    await asyncio.to_thread(send_system_email, cfg, msg)


@router.post("/invites", status_code=201)
async def create_invites(
    body: InviteCreate,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """초대 링크 생성. emails 를 지정하면 수신자별 링크 1개(send_email 이면 메일도 발송), 비우면 count 개의
    링크만 생성한다. 링크 원문은 본 응답에서만 확인 가능하다(DB 에는 해시만 저장)."""
    if body.group_id:
        from app.groups.models import Group
        if not await db.get(Group, body.group_id):
            raise HTTPException(status_code=400, detail="그룹을 찾을 수 없습니다")
    emails = [e.strip() for e in body.emails if e and e.strip()]
    for e in emails:
        if "@" not in e or len(e) > 255:
            raise HTTPException(status_code=400, detail=f"메일 주소 형식이 올바르지 않습니다: {e}")
    expires = datetime.now(timezone.utc) + timedelta(days=body.expires_days)
    made: list[tuple[UserInvite, str]] = []
    for email in (emails or [None] * body.count):
        token = secrets.token_urlsafe(24)
        inv = UserInvite(token_hash=token_digest(token), email=email, group_id=body.group_id,
                         invited_by=admin.id, expires_at=expires)
        db.add(inv)
        made.append((inv, token))
    await db.commit()

    out = []
    inviter = admin.display_name or admin.username
    for inv, token in made:
        url = invite_url(token)
        emailed, err = False, None
        if inv.email and body.send_email:
            try:
                await _send_invite_mail(db, inv.email, url, inviter, expires)
                emailed = True
            except Exception as e:
                logger.warning("초대 메일 발송 실패(%s): %s", inv.email, e)
                err = "메일 발송 실패 — 링크를 직접 전달하세요"
        out.append({**_invite_dict(inv), "url": url, "emailed": emailed, "email_error": err})
    await audit.log_action(
        db, admin.id, "user.invite", "invite", None,
        {"count": len(out), "emails": emails, "group_id": body.group_id}, _client_ip(request),
    )
    return {"invites": out}


@router.get("/invites")
async def list_invites(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(UserInvite).order_by(UserInvite.created_at.desc()).limit(200))).scalars().all()
    return {"invites": [_invite_dict(r) for r in rows]}


@router.delete("/invites/{invite_id}")
async def revoke_invite(
    invite_id: str,
    request: Request = None,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    inv = await db.get(UserInvite, invite_id)
    if inv is None:
        raise HTTPException(status_code=404, detail="초대를 찾을 수 없습니다")
    if inv.used_at is None and inv.revoked_at is None:
        inv.revoked_at = datetime.now(timezone.utc)
        await db.commit()
        await audit.log_action(
            db, admin.id, "user.invite_revoke", "invite", inv.id, {"email": inv.email}, _client_ip(request),
        )
    return _invite_dict(inv)


async def find_open_invite(db: AsyncSession, token: str) -> UserInvite | None:
    """가입에 사용 가능한 초대(미사용·미취소·기한 내)."""
    if not token:
        return None
    inv = (await db.execute(select(UserInvite).where(UserInvite.token_hash == token_digest(token)))).scalars().first()
    if inv is None or _invite_state(inv) != "open":
        return None
    return inv


# ════════════════════════════════════════════
# 운영 요약
# ════════════════════════════════════════════

_ssl_cache: dict = {}
_SSL_TTL = 3600


def _x509_info(cert) -> dict:
    """인증서에서 화면 표시용 값만 추출 — 만료·시작 시각, 이름(CN, 없으면 첫 SAN), 발급자(O, 없으면 CN)."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID

    def _attr(name, oid) -> str:
        try:
            v = name.get_attributes_for_oid(oid)
            return str(v[0].value) if v else ""
        except Exception:
            return ""

    na = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after.replace(tzinfo=timezone.utc)
    nb = getattr(cert, "not_valid_before_utc", None) or cert.not_valid_before.replace(tzinfo=timezone.utc)
    cn = _attr(cert.subject, NameOID.COMMON_NAME)
    if not cn:
        try:
            san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            names = san.get_values_for_type(x509.DNSName)
            cn = names[0] if names else ""
        except Exception:
            cn = ""
    issuer = _attr(cert.issuer, NameOID.ORGANIZATION_NAME) or _attr(cert.issuer, NameOID.COMMON_NAME)
    return {"not_after": na, "not_before": nb, "name": cn, "issuer": issuer}


def _cert_info_from_file(path: Path) -> dict | None:
    try:
        from cryptography import x509
        return _x509_info(x509.load_pem_x509_certificate(path.read_bytes()))
    except Exception:
        return None


def _cert_info_remote(host: str, port: int = 443, sni: str | None = None) -> dict | None:
    """해당 주소에 접속하여 실제로 제공되는 인증서를 조회한다(프런트 리버스 프록시가 TLS 를 종단하는 구성).
    sni 를 지정하면 접속 주소(내부 IP 등)와 다른 이름으로 인증서를 선택한다."""
    import socket
    import ssl

    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((host, port), timeout=3) as sock:
            with ctx.wrap_socket(sock, server_hostname=sni or host) as ss:
                der = ss.getpeercert(binary_form=True)
        from cryptography import x509
        return _x509_info(x509.load_der_x509_certificate(der))
    except Exception:
        return None


def _split_host_port(v: str, default_port: int = 443) -> tuple[str, int]:
    v = v.strip()
    if v.startswith("["):                      # [IPv6]:port
        host, _, rest = v[1:].partition("]")
        return host, int(rest[1:]) if rest.startswith(":") and rest[1:].isdigit() else default_port
    if v.count(":") == 1:
        host, port = v.split(":")
        return host, int(port) if port.isdigit() else default_port
    return v, default_port


async def ssl_expiry() -> dict:
    """{not_after, not_before, days_left, source, name, issuer}. 관리 개요(ops-summary)와
    보안·SSL 화면(GET /settings/ssl 의 effective)이 동일한 값을 사용한다 — 두 화면 간 불일치 방지.
    조회 순서(먼저 판독된 것 사용):

    1. file   — SSL_CERT_PATH(설정)로 지정한 인증서 파일
    2. local  — 관리 화면에서 업로드한 /etc/nginx/ssl/cert.pem
    3. probe  — SSL_CHECK_HOST(내부 주소, 예: 리버스 프록시 사설 IP)에 접속하되 SNI 는 공개 호스트명
    4. remote — 공개 주소(app_url). 헤어핀 NAT 가 없는 망에서는 여기서 실패한다 → 1·3 을 설정
    판독 실패 시 전부 None(화면은 "확인 불가"). 성공 시 1시간, 실패 시 5분 캐시(인증서 업로드·삭제 시 초기화).
    """
    now = time.monotonic()
    if _ssl_cache and now - _ssl_cache["at"] < _ssl_cache.get("ttl", _SSL_TTL):
        return _ssl_cache["value"]
    from urllib.parse import urlparse

    from app.admin.router import SSL_DIR

    source, info = None, None
    if settings.ssl_cert_path:
        p = Path(settings.ssl_cert_path)
        if p.is_file():
            info, source = await asyncio.to_thread(_cert_info_from_file, p), "file"
    if info is None:
        local = SSL_DIR / "cert.pem"
        if local.is_file():
            info, source = await asyncio.to_thread(_cert_info_from_file, local), "local"
    u = urlparse(settings.app_url)
    if info is None and settings.ssl_check_host and u.hostname:
        host, port = _split_host_port(settings.ssl_check_host)
        info, source = await asyncio.to_thread(_cert_info_remote, host, port, u.hostname), "probe"
    if info is None and u.scheme == "https" and u.hostname:
        info, source = await asyncio.to_thread(_cert_info_remote, u.hostname, u.port or 443), "remote"
    na = info["not_after"] if info else None
    nb = info.get("not_before") if info else None
    value = {
        "not_after": na.isoformat() if na else None,
        "not_before": nb.isoformat() if nb else None,
        "days_left": (na - datetime.now(timezone.utc)).days if na else None,
        "source": source if na else None,
        "name": (info.get("name") or u.hostname or None) if info else None,
        "issuer": (info.get("issuer") or None) if info else None,
    }
    _ssl_cache.update(at=now, value=value, ttl=_SSL_TTL if na else 300)
    return value


def clear_ssl_cache() -> None:
    """인증서 업로드·삭제 직후 개요·보안 화면이 즉시 갱신된 값을 조회하도록 캐시를 초기화한다."""
    _ssl_cache.clear()


@router.get("/ops-summary")
async def ops_summary(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """관리 첫 화면용 일괄 조회 — 승인 대기 수·마지막 백업·SSL 만료 D-n·서비스 상태."""
    pending = (await db.execute(select(func.count(User.id)).where(_status_clause("pending")))).scalar() or 0
    suspended = (await db.execute(select(func.count(User.id)).where(_status_clause("suspended")))).scalar() or 0
    active = (await db.execute(select(func.count(User.id)).where(_status_clause("active")))).scalar() or 0

    backup = None
    try:
        from app.backup.models import BackupRecord
        last = (await db.execute(select(BackupRecord).order_by(BackupRecord.created_at.desc()).limit(1))).scalars().first()
        ok = (await db.execute(
            select(BackupRecord).where(BackupRecord.status == "success")
            .order_by(BackupRecord.created_at.desc()).limit(1)
        )).scalars().first()
        if last is not None:
            backup = {
                "id": last.id, "status": last.status, "kind": last.kind,
                "created_at": last.created_at.isoformat() if last.created_at else None,
                "size_bytes": last.size_bytes,
                "last_success_at": ok.created_at.isoformat() if ok and ok.created_at else None,
            }
    except Exception as e:
        await db.rollback()
        logger.debug("백업 요약 실패: %s", e)

    services = {"ok": 0, "down": 0, "checking": 0, "down_names": []}
    try:
        from app.services.health import get_cached_status
        for s in get_cached_status():
            services[s.status if s.status in ("ok", "down") else "checking"] += 1
            if s.status == "down":
                services["down_names"].append(s.name)
    except Exception as e:
        logger.debug("서비스 상태 요약 실패: %s", e)

    open_invites = 0
    try:
        now = datetime.now(timezone.utc)
        open_invites = (await db.execute(select(func.count(UserInvite.id)).where(
            UserInvite.used_at.is_(None), UserInvite.revoked_at.is_(None), UserInvite.expires_at > now,
        ))).scalar() or 0
    except Exception:
        await db.rollback()

    return {
        "users": {"pending": pending, "active": active, "suspended": suspended, "open_invites": open_invites},
        "backup": backup,
        "ssl": await ssl_expiry(),
        "services": services,
    }
