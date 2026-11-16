"""Mail API endpoints — IMAP/SMTP client based (multi-account)."""

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import MailAccount, MailDraft, MailFilterRule, MailScheduledSend, MailSignature, User
from app.db.session import get_db
from app.mail import access_guard, imap_client, pop3_client, smtp_client, providers, threads
from app.mail.crypto import encrypt_password

from app.mail.schemas import (
    Mailbox,
    MailboxListResponse,
    MailboxCreateRequest,
    MailboxRenameRequest,
    MessageDetail,
    MessageListResponse,
    MessageSummary,
    MessageUpdateRequest,
    SendMessageRequest,
    BulkActionRequest,
    SignatureCreate,
    SignatureUpdate,
    SignatureResponse,
    EmailAddress,
    Attachment,
    MailAccountCreate,
    MailAccountUpdate,
    MailAccountResponse,
    DraftSave,
    DraftResponse,
    LabelListResponse,
    ScheduledMailResponse,
    ScheduledMailUpdate,
    ThreadResponse,
)
from app.modules.registry import require_module

logger = logging.getLogger(__name__)
from app.mail import file_attach as _file_attach  # noqa: E402  — 워크스페이스 파일 첨부

router = APIRouter(prefix="/api/mail", tags=["mail"])


def _incoming(account: MailAccount):
    """수신 프로토콜에 맞는 클라이언트 반환(imap_client | pop3_client). 인터페이스 동일."""
    return pop3_client if getattr(account, "protocol", "imap") == "pop3" else imap_client


POP3_NO_FOLDERS = "POP3 계정은 서버에 폴더가 없어 이동·보관·스팸 처리와 폴더 관리를 지원하지 않습니다"


def _reject_pop3_folder_op(account: MailAccount) -> None:
    """POP3 는 받은편지함 하나뿐이므로 폴더가 필요한 동작은 서버에 전송하지 않고 400 으로 응답한다.
    (pop3_client 의 해당 함수는 False 만 반환하여 이전에는 "실패했습니다" 500 으로 표시되었다.)"""
    if getattr(account, "protocol", "imap") == "pop3":
        raise HTTPException(status_code=400, detail=POP3_NO_FOLDERS)


# ─── 가이드형 IMAP 온보딩: 제공자 자동 감지 ───
@router.get("/providers/detect")
@require_module("mail")
async def detect_provider(email: str = Query(..., max_length=255), user: User = Depends(get_current_user)):
    """이메일 도메인으로 IMAP/SMTP 서버 + 인증 방식/안내 반환(서버 자동 채움용)."""
    return providers.detect(email)


@router.get("/providers")
@require_module("mail")
async def list_providers(user: User = Depends(get_current_user)):
    """대표 제공자 목록(피커용)."""
    return {"providers": providers.list_known()}


# ─── Helpers ───

_settings = get_settings()

# 첨부파일 임시 저장 — 데이터는 공유 temp파일(8워커 동일 컨테이너라 FS 공유),
# 메타데이터는 Redis(TTL)로 멀티워커 간 공유.
import os as _os

_ATTACH_DIR = "/tmp/ws_mail_attachments"
# 6시간. 30분이었을 때는 파일 첨부 후 본문 작성이 길어지면 발송 시 "첨부파일을 찾을 수 없습니다" 오류가 발생했다.
_ATTACHMENT_TTL = 6 * 60 * 60


def _attach_path(blob_id: str) -> str:
    return _os.path.join(_ATTACH_DIR, blob_id)


def _cleanup_expired_attachments():
    """TTL 지난 첨부 temp파일 정리 (Redis 메타는 자체 TTL로 만료)."""
    try:
        now = time.time()
        _os.makedirs(_ATTACH_DIR, exist_ok=True)
        for fn in _os.listdir(_ATTACH_DIR):
            p = _os.path.join(_ATTACH_DIR, fn)
            try:
                if now - _os.path.getmtime(p) > _ATTACHMENT_TTL:
                    _os.remove(p)
            except OSError:
                pass
    except Exception:
        pass


async def _builtin_enabled(db: AsyncSession) -> bool:
    """내장 메일서버 활성 여부 — DB(feature.builtin_mailserver) 우선, env 폴백(웹 토글용)."""
    from app.setup import config_store as _cfg
    v = await _cfg.get(db, "feature.builtin_mailserver")
    if v is not None:
        return v.strip().lower() in ("1", "true", "yes", "on")
    return getattr(_settings, "feature_builtin_mailserver", False)


def _builtin_account(user: User, enabled: bool | None = None) -> MailAccount | None:
    """Return an in-memory MailAccount for the builtin mailserver (no DB record).

    enabled: None이면 env 플래그 사용(하위호환). 호출부에서 _builtin_enabled(db) 결과 전달 권장.
    Returns None if builtin mail is disabled.
    """
    if enabled is None:
        enabled = getattr(_settings, "feature_builtin_mailserver", False)
    if not enabled:
        return None
    # 이메일이 없는 사용자(관리자가 아이디만으로 생성한 계정 등)는 내장 메일함이 없다.
    # 빈 주소로 가상 계정을 생성하면 IMAP 로그인이 실패하여 /mailboxes 가 502(서버 장애처럼)로 표시되었다.
    # 계정 자체가 없는 것(목록이 비어 있고 /mailboxes 404 "메일 계정이 설정되지 않았습니다")으로 처리한다.
    if not (user.email or "").strip():
        return None

    account = MailAccount(
        id=f"builtin-{user.id}",
        user_id=user.id,
        display_name=f"{_settings.domain} 메일",
        email=user.email,
        imap_host="mailserver", imap_port=993, imap_security="ssl",
        smtp_host="mailserver", smtp_port=587, smtp_security="starttls",
        username=user.email,
        password_encrypted="",
        is_default=True,
    )
    # 마스터 인증 표식 — 해당 사용자 본인 주소로만 부여. DB·요청 본문 계정에는 생성되지 않는다.
    access_guard.mark_builtin(account, user.email)
    return account


async def _reject_internal_hosts(imap_host: str | None, imap_port: int | None,
                                 smtp_host: str | None, smtp_port: int | None) -> None:
    """외부 메일 계정 등록·수정 — 내부망(서비스명·사설/루프백 대역) 호스트는 400."""
    try:
        await access_guard.check_external_host_async(imap_host, imap_port)
        await access_guard.check_external_host_async(smtp_host, smtp_port)
    except access_guard.MailHostRejected:
        raise HTTPException(status_code=400, detail=access_guard.REJECT_MESSAGE)


async def resolve_primary_email(db: AsyncSession, user: User) -> str | None:
    """주사용 메일주소 = default 메일계정 주소(send와 동일 해석). 없으면 user.email.

    builtin 메일서버 모드면 내장주소, IMAP클라/Exchange 외부연동이면 is_default 외부계정 주소.
    """
    try:
        account = await _get_account(db, user, None)
        return account.email or user.email
    except HTTPException:
        return user.email


async def _get_account(
    db: AsyncSession, user: User, account_id: str | None = None
) -> MailAccount:
    """Get user's mail account (default if account_id not specified)."""
    en = await _builtin_enabled(db)
    # Handle builtin virtual account id
    if account_id and account_id.startswith("builtin-"):
        builtin = _builtin_account(user, en)
        if builtin and account_id == builtin.id:
            return builtin
        raise HTTPException(status_code=404, detail="메일 계정을 찾을 수 없습니다")

    if account_id:
        account = await db.get(MailAccount, account_id)
        if not account or account.user_id != user.id:
            raise HTTPException(status_code=404, detail="메일 계정을 찾을 수 없습니다")
        return account

    # Builtin account takes priority as default
    builtin = _builtin_account(user, en)
    if builtin:
        return builtin

    # Get default account
    result = await db.execute(
        select(MailAccount)
        .where(MailAccount.user_id == user.id, MailAccount.is_default == True)
    )
    account = result.scalar_one_or_none()
    if account:
        return account

    # Get first account
    result = await db.execute(
        select(MailAccount)
        .where(MailAccount.user_id == user.id)
        .order_by(MailAccount.created_at)
        .limit(1)
    )
    account = result.scalar_one_or_none()
    if account:
        return account

    raise HTTPException(
        status_code=404,
        detail="메일 계정이 설정되지 않았습니다. 설정에서 메일 계정을 추가해주세요.",
    )


def _account_response(account: MailAccount) -> dict:
    is_builtin = getattr(account, "id", "").startswith("builtin-")
    return {
        "id": account.id,
        "display_name": account.display_name,
        "email": account.email,
        "protocol": getattr(account, "protocol", "imap") or "imap",
        "imap_host": account.imap_host,
        "imap_port": account.imap_port,
        "imap_security": account.imap_security,
        "smtp_host": account.smtp_host,
        "smtp_port": account.smtp_port,
        "smtp_security": account.smtp_security,
        "username": account.username,
        "is_default": account.is_default,
        # 빌트인(워크스페이스 메일)은 이미 본 서버에 저장되어 있으므로 아카이브 대상이 아님
        "archive_enabled": (not is_builtin) and bool(getattr(account, "archive_enabled", False)),
        "is_builtin": is_builtin,
        "last_sync_at": account.last_sync_at.isoformat() if not is_builtin and account.last_sync_at else None,
        "sync_error": account.sync_error if not is_builtin else None,
    }


# ─── Mail Account CRUD ───


@router.get("/accounts")
@require_module("mail")
async def list_accounts(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    items = []

    # Builtin virtual account (no DB record)
    builtin = _builtin_account(user, await _builtin_enabled(db))
    if builtin:
        items.append(_account_response(builtin))

    # External accounts from DB
    result = await db.execute(
        select(MailAccount)
        .where(MailAccount.user_id == user.id)
        .order_by(MailAccount.created_at)
    )
    for a in result.scalars():
        items.append(_account_response(a))

    return items


@router.post("/accounts", response_model=MailAccountResponse, status_code=201)
@require_module("mail")
async def create_account(
    body: MailAccountCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _reject_internal_hosts(body.imap_host, body.imap_port, body.smtp_host, body.smtp_port)
    # Test connection first
    test_account = MailAccount(
        protocol=body.protocol,
        imap_host=body.imap_host,
        imap_port=body.imap_port,
        imap_security=body.imap_security,
        smtp_host=body.smtp_host,
        smtp_port=body.smtp_port,
        smtp_security=body.smtp_security,
        username=body.username,
        password_encrypted=encrypt_password(body.password),
    )

    imap_ok, imap_msg = await _incoming(test_account).test_connection(test_account)
    if not imap_ok:
        raise HTTPException(
            status_code=400,
            detail=f"수신 서버 연결 실패: {imap_msg}",
        )

    smtp_ok, smtp_msg = await smtp_client.test_connection(test_account)
    if not smtp_ok:
        raise HTTPException(
            status_code=400,
            detail=f"SMTP 연결 실패: {smtp_msg}",
        )

    # If setting as default, unset other defaults
    if body.is_default:
        result = await db.execute(
            select(MailAccount).where(
                MailAccount.user_id == user.id, MailAccount.is_default == True
            )
        )
        for a in result.scalars():
            a.is_default = False

    account = MailAccount(
        user_id=user.id,
        display_name=body.display_name,
        email=body.email,
        protocol=body.protocol,
        imap_host=body.imap_host,
        imap_port=body.imap_port,
        imap_security=body.imap_security,
        smtp_host=body.smtp_host,
        smtp_port=body.smtp_port,
        smtp_security=body.smtp_security,
        username=body.username,
        password_encrypted=encrypt_password(body.password),
        is_default=body.is_default,
    )
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return _account_response(account)


@router.patch("/accounts/{account_id}", response_model=MailAccountResponse)
@require_module("mail")
async def update_account(
    account_id: str,
    body: MailAccountUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if account_id.startswith("builtin-"):
        raise HTTPException(status_code=400, detail="빌트인 메일 계정은 수정할 수 없습니다")
    account = await db.get(MailAccount, account_id)
    if not account or account.user_id != user.id:
        raise HTTPException(status_code=404, detail="메일 계정을 찾을 수 없습니다")

    if any(v is not None for v in (body.imap_host, body.imap_port, body.smtp_host, body.smtp_port)):
        await _reject_internal_hosts(
            body.imap_host if body.imap_host is not None else account.imap_host,
            body.imap_port if body.imap_port is not None else account.imap_port,
            body.smtp_host if body.smtp_host is not None else account.smtp_host,
            body.smtp_port if body.smtp_port is not None else account.smtp_port,
        )
    if body.display_name is not None:
        account.display_name = body.display_name
    if body.email is not None:
        account.email = body.email
    if body.protocol is not None:
        account.protocol = body.protocol
    if body.imap_host is not None:
        account.imap_host = body.imap_host
    if body.imap_port is not None:
        account.imap_port = body.imap_port
    if body.imap_security is not None:
        account.imap_security = body.imap_security
    if body.smtp_host is not None:
        account.smtp_host = body.smtp_host
    if body.smtp_port is not None:
        account.smtp_port = body.smtp_port
    if body.smtp_security is not None:
        account.smtp_security = body.smtp_security
    if body.username is not None:
        account.username = body.username
    if body.password is not None:
        account.password_encrypted = encrypt_password(body.password)
    if body.archive_enabled is not None:
        account.archive_enabled = body.archive_enabled
    if body.is_default is not None:
        if body.is_default:
            result = await db.execute(
                select(MailAccount).where(
                    MailAccount.user_id == user.id,
                    MailAccount.is_default == True,
                    MailAccount.id != account_id,
                )
            )
            for a in result.scalars():
                a.is_default = False
        account.is_default = body.is_default

    await db.commit()
    await db.refresh(account)
    return _account_response(account)


@router.delete("/accounts/{account_id}")
@require_module("mail")
async def delete_account(
    account_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if account_id.startswith("builtin-"):
        raise HTTPException(status_code=400, detail="빌트인 메일 계정은 삭제할 수 없습니다")
    account = await db.get(MailAccount, account_id)
    if not account or account.user_id != user.id:
        raise HTTPException(status_code=404, detail="메일 계정을 찾을 수 없습니다")
    await db.delete(account)
    await db.commit()
    return {"ok": True}


@router.post("/accounts/{account_id}/test")
@require_module("mail")
async def test_account(
    account_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Builtin virtual account
    if account_id.startswith("builtin-"):
        builtin = _builtin_account(user)
        if not builtin or account_id != builtin.id:
            raise HTTPException(status_code=404, detail="메일 계정을 찾을 수 없습니다")
        account = builtin
    else:
        account = await db.get(MailAccount, account_id)
        if not account or account.user_id != user.id:
            raise HTTPException(status_code=404, detail="메일 계정을 찾을 수 없습니다")

    imap_ok, imap_msg = await _incoming(account).test_connection(account)
    smtp_ok, smtp_msg = await smtp_client.test_connection(account)

    return {
        "imap": {"ok": imap_ok, "message": imap_msg},
        "smtp": {"ok": smtp_ok, "message": smtp_msg},
    }


# ─── Mailboxes ───


@router.get("/mailboxes", response_model=MailboxListResponse)
@require_module("mail")
async def list_mailboxes(
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_account(db, user, account_id)
    try:
        raw_mailboxes = await _incoming(account).list_mailboxes(account)
    except Exception as e:
        logger.error("IMAP list_mailboxes failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")

    mailboxes = [Mailbox(**mb) for mb in raw_mailboxes]
    return MailboxListResponse(mailboxes=mailboxes)


_PROTECTED_MAILBOXES = {"INBOX", "Sent", "Drafts", "Trash", "Junk", "Archive"}


@router.post("/mailboxes", status_code=201)
@require_module("mail")
async def create_mailbox(
    body: MailboxCreateRequest,
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.name in _PROTECTED_MAILBOXES:
        raise HTTPException(status_code=400, detail="기본 폴더는 생성할 수 없습니다")
    account = await _get_account(db, user, account_id)
    _reject_pop3_folder_op(account)
    ok = await _incoming(account).create_mailbox(account, body.name)
    if not ok:
        raise HTTPException(status_code=500, detail="편지함 생성에 실패했습니다")
    return {"ok": True, "name": body.name}


@router.patch("/mailboxes")
@require_module("mail")
async def rename_mailbox(
    body: MailboxRenameRequest,
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.old_name in _PROTECTED_MAILBOXES:
        raise HTTPException(status_code=400, detail="기본 폴더는 이름을 변경할 수 없습니다")
    if body.new_name in _PROTECTED_MAILBOXES:
        raise HTTPException(status_code=400, detail="기본 폴더 이름으로 변경할 수 없습니다")
    account = await _get_account(db, user, account_id)
    _reject_pop3_folder_op(account)
    ok = await _incoming(account).rename_mailbox(account, body.old_name, body.new_name)
    if not ok:
        raise HTTPException(status_code=500, detail="편지함 이름 변경에 실패했습니다")
    return {"ok": True}


@router.delete("/mailboxes/{mailbox_name:path}")
@require_module("mail")
async def delete_mailbox(
    mailbox_name: str,
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if mailbox_name in _PROTECTED_MAILBOXES:
        raise HTTPException(status_code=400, detail="기본 폴더는 삭제할 수 없습니다")
    account = await _get_account(db, user, account_id)
    _reject_pop3_folder_op(account)
    ok = await _incoming(account).delete_mailbox(account, mailbox_name)
    if not ok:
        raise HTTPException(status_code=500, detail="편지함 삭제에 실패했습니다")
    return {"ok": True}


# ─── Messages list ───


def _summary(msg: dict) -> MessageSummary:
    return MessageSummary(
        id=msg["id"],
        thread_id=msg.get("thread_id"),
        mailbox_ids=msg.get("mailbox_ids", []),
        from_=[EmailAddress(**a) for a in msg.get("from_", [])],
        to=[EmailAddress(**a) for a in msg.get("to", [])],
        subject=msg.get("subject"),
        preview=msg.get("preview"),
        received_at=msg.get("received_at"),
        is_unread=msg.get("is_unread", False),
        is_flagged=msg.get("is_flagged", False),
        has_attachment=msg.get("has_attachment", False),
        labels=msg.get("labels") or [],
        thread_count=msg.get("thread_count"),
    )


@router.get("/messages", response_model=MessageListResponse)
@require_module("mail")
async def list_messages(
    mailbox_id: str = Query(...),
    page: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    q: str | None = Query(None),
    account_id: str | None = Query(None),
    unread: bool | None = Query(None, description="true=안 읽은 것만, false=읽은 것만"),
    flagged: bool | None = Query(None, description="true=별표만"),
    has_attachment: bool | None = Query(None, description="true=첨부 있는 것만(multipart/mixed 근사)"),
    label: str | None = Query(None, max_length=100, description="이 라벨(IMAP 키워드)만"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_account(db, user, account_id)
    filters = {}
    if unread is not None:
        filters["unread"] = unread
    if flagged is not None:
        filters["flagged"] = flagged
    if has_attachment is not None:
        filters["has_attachment"] = has_attachment
    if label:
        filters["label"] = label
    try:
        raw_messages, total = await _incoming(account).fetch_messages(
            account, mailbox_id, page, limit, query=q, **filters
        )
    except Exception as e:
        logger.error("IMAP fetch_messages failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")

    messages = [_summary(msg) for msg in raw_messages]
    return MessageListResponse(messages=messages, total=total, page=page, limit=limit)


@router.get("/labels", response_model=LabelListResponse)
@require_module("mail")
async def list_labels(
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """메일함에 쓰인 라벨(IMAP 키워드)과 서버의 키워드 지원 여부. POP3 는 supported=false."""
    account = await _get_account(db, user, account_id)
    try:
        res = await _incoming(account).list_labels(account, mailbox_id)
    except Exception as e:
        logger.error("IMAP list_labels failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")
    return LabelListResponse(**res)


async def _sent_mailbox(account: MailAccount) -> str | None:
    try:
        for mb in await _incoming(account).list_mailboxes(account):
            if mb.get("role") == "sent":
                return mb["id"]
    except Exception:
        pass
    return None


@router.get("/messages/{message_uid}/thread", response_model=ThreadResponse)
@require_module("mail")
async def get_thread(
    message_uid: str,
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    include_sent: bool = Query(True, description="보낸편지함의 같은 대화도 포함"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이 메일이 속한 스레드의 메일 목록(오래된 순, 읽음 처리 미수행)."""
    account = await _get_account(db, user, account_id)
    extra = []
    if include_sent and getattr(account, "protocol", "imap") != "pop3":
        sent = await _sent_mailbox(account)
        if sent:
            extra.append(sent)
    try:
        res = await _incoming(account).fetch_thread(account, mailbox_id, message_uid, extra)
    except Exception as e:
        logger.error("IMAP fetch_thread failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")
    if not res:
        raise HTTPException(status_code=404, detail="Message not found")
    return ThreadResponse(thread_id=res.get("thread_id"), messages=[_summary(m) for m in res["messages"]])


@router.get("/messages/{message_uid}/attachments.zip")
@require_module("mail")
async def download_all_attachments(
    message_uid: str,
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이 메일의 첨부를 zip 하나로 반환(읽음 처리 미수행)."""
    import email as _email
    import io
    import zipfile
    from urllib.parse import quote

    account = await _get_account(db, user, account_id)
    try:
        raws = await _incoming(account).fetch_raw_many(account, mailbox_id, [message_uid])
    except Exception as e:
        logger.error("fetch_raw_many failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")
    raw = raws.get(message_uid)
    if not raw:
        raise HTTPException(status_code=404, detail="Message not found")
    msg = _email.message_from_bytes(raw)
    atts = imap_client._extract_attachments(msg)
    if not atts:
        raise HTTPException(status_code=404, detail="첨부가 없습니다")
    parts = list(msg.walk())
    buf = io.BytesIO()
    used: dict[str, int] = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for att in atts:
            idx = att["part_index"]
            if idx >= len(parts):
                continue
            data = parts[idx].get_payload(decode=True) or b""
            name = (att.get("name") or f"attachment_{idx}").replace("/", "_").replace("\\", "_")
            n = used.get(name, 0)
            used[name] = n + 1
            if n:
                stem, dot, ext = name.rpartition(".")
                name = f"{stem} ({n}).{ext}" if dot else f"{name} ({n})"
            zf.writestr(name, data)
    subject = imap_client._decode_header(msg.get("Subject")) or "attachments"
    fname = (subject.replace("/", "_")[:80] or "attachments") + ".zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename=\"attachments.zip\"; filename*=UTF-8''{quote(fname)}",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/messages/{message_uid}/attachments/reuse")
@require_module("mail")
async def reuse_attachments(
    message_uid: str,
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이 메일의 첨부를 발송용 임시 첨부로 복사 — 재발송·전달 시 원본 첨부를 그대로 포함한다."""
    import email as _email

    _cleanup_expired_attachments()
    account = await _get_account(db, user, account_id)
    try:
        raws = await _incoming(account).fetch_raw_many(account, mailbox_id, [message_uid])
    except Exception as e:
        logger.error("fetch_raw_many failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")
    raw = raws.get(message_uid)
    if not raw:
        raise HTTPException(status_code=404, detail="Message not found")
    msg = _email.message_from_bytes(raw)
    parts = list(msg.walk())
    out = []
    for att in imap_client._extract_attachments(msg):
        idx = att["part_index"]
        if idx >= len(parts):
            continue
        data = parts[idx].get_payload(decode=True) or b""
        out.append(await _store_temp_attachment(
            data, att.get("name") or f"attachment_{idx}",
            parts[idx].get_content_type() or "application/octet-stream", user.id))
    return {"attachments": out}


# ─── Message detail ───


@router.get("/messages/{message_uid}", response_model=MessageDetail)
@require_module("mail")
async def get_message(
    message_uid: str,
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_account(db, user, account_id)
    try:
        msg = await _incoming(account).fetch_message(account, mailbox_id, message_uid)
    except Exception as e:
        logger.error("IMAP fetch_message failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")

    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    return MessageDetail(
        id=msg["id"],
        thread_id=msg.get("thread_id"),
        mailbox_ids=msg.get("mailbox_ids", []),
        from_=[EmailAddress(**a) for a in msg.get("from_", [])],
        to=[EmailAddress(**a) for a in msg.get("to", [])],
        cc=[EmailAddress(**a) for a in msg.get("cc", [])],
        bcc=[EmailAddress(**a) for a in msg.get("bcc", [])],
        reply_to=[EmailAddress(**a) for a in msg.get("reply_to", [])],
        subject=msg.get("subject"),
        text_body=msg.get("text_body"),
        html_body=msg.get("html_body"),
        preview=msg.get("preview"),
        received_at=msg.get("received_at"),
        is_unread=msg.get("is_unread", False),
        is_flagged=msg.get("is_flagged", False),
        attachments=[Attachment(**a) for a in msg.get("attachments", [])],
        disposition_notification_to=msg.get("disposition_notification_to"),
        mdn_sent=msg.get("mdn_sent", False),
    )


# ─── Raw headers ───


@router.get("/messages/{message_uid}/headers")
@require_module("mail")
async def get_message_headers(
    message_uid: str,
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_account(db, user, account_id)
    try:
        headers = await _incoming(account).fetch_raw_headers(account, mailbox_id, message_uid)
    except Exception as e:
        logger.error("IMAP fetch_raw_headers failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")

    if headers is None:
        raise HTTPException(status_code=404, detail="Message not found")

    return {"headers": headers}


# ─── MDN (read receipt) ───


@router.post("/messages/{message_uid}/read-receipt")
@require_module("mail")
async def send_read_receipt(
    message_uid: str,
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_account(db, user, account_id)

    # Fetch message to get MDN destination and subject
    try:
        msg = await _incoming(account).fetch_message(account, mailbox_id, message_uid)
    except Exception as e:
        logger.error("IMAP fetch for MDN failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")

    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    dnt = msg.get("disposition_notification_to")
    if not dnt:
        raise HTTPException(status_code=400, detail="수신확인이 요청되지 않은 메일입니다")

    if msg.get("mdn_sent"):
        raise HTTPException(status_code=400, detail="이미 수신확인을 보냈습니다")

    # Send MDN
    original_message_id = msg.get("in_reply_to") or f"<uid-{message_uid}@{_settings.domain}>"
    ok = await smtp_client.send_mdn(
        account=account,
        from_email=account.email,
        to_email=dnt,
        original_message_id=original_message_id,
        original_subject=msg.get("subject") or "",
    )

    if not ok:
        raise HTTPException(status_code=502, detail="수신확인 발송에 실패했습니다")

    # Set $MDNSent flag to prevent duplicate
    await _incoming(account).update_flags(
        account, mailbox_id, message_uid,
        add_flags=["$MDNSent"],
    )

    return {"ok": True}


# ─── Update message (read/star/move) ───


@router.patch("/messages/{message_uid}")
@require_module("mail")
async def update_message(
    message_uid: str,
    body: MessageUpdateRequest,
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_account(db, user, account_id)
    # 이동이 포함된 요청은 플래그 변경 전에 거부한다(부분 적용 방지)
    if body.mailbox_ids and body.mailbox_ids[0] != mailbox_id:
        _reject_pop3_folder_op(account)

    # Handle flag changes
    add_flags = []
    remove_flags = []

    if body.is_unread is not None:
        if body.is_unread:
            remove_flags.append("\\Seen")
        else:
            add_flags.append("\\Seen")

    if body.is_flagged is not None:
        if body.is_flagged:
            add_flags.append("\\Flagged")
        else:
            remove_flags.append("\\Flagged")

    if body.add_labels or body.remove_labels:
        if getattr(account, "protocol", "imap") == "pop3":
            raise HTTPException(status_code=400, detail="POP3 계정은 라벨을 지원하지 않습니다")
        for l in body.add_labels or []:
            kw = threads.encode_keyword(l)
            if kw:
                add_flags.append(kw)
        for l in body.remove_labels or []:
            kw = threads.encode_keyword(l)
            if kw:
                remove_flags.append(kw)

    if add_flags or remove_flags:
        ok = await _incoming(account).update_flags(
            account, mailbox_id, message_uid,
            add_flags=add_flags or None,
            remove_flags=remove_flags or None,
        )
        if not ok:
            raise HTTPException(status_code=500, detail="Failed to update message flags")

    # Handle move
    if body.mailbox_ids and body.mailbox_ids[0] != mailbox_id:
        ok = await _incoming(account).move_message(
            account, mailbox_id, message_uid, body.mailbox_ids[0]
        )
        if not ok:
            raise HTTPException(status_code=500, detail="Failed to move message")

    return {"ok": True}


# ─── Delete message ───


@router.delete("/messages/{message_uid}")
@require_module("mail")
async def delete_message(
    message_uid: str,
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_account(db, user, account_id)

    # Find trash mailbox
    # 목록 조회에 실패했는데 "휴지통 없음"으로 판정하고 진행하면 영구 삭제가 되므로 실패로 종료한다.
    try:
        mailboxes = await _incoming(account).list_mailboxes(account)
    except Exception as e:
        logger.error("IMAP list_mailboxes failed (delete): %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")
    # LIST 가 NO/BAD 면 예외 없이 빈 목록이 반환된다. 편지함이 하나도 없는 계정은 없으므로 이 경우도 실패로 판정한다
    if not mailboxes:
        raise HTTPException(status_code=502, detail="메일 서버에서 편지함 목록을 받지 못했습니다")

    trash_mailbox = None
    for mb in mailboxes:
        if mb.get("role") == "trash":
            trash_mailbox = mb["id"]
            break

    try:
        result = await _incoming(account).delete_message(
            account, mailbox_id, message_uid, trash_mailbox
        )
    except Exception as e:
        logger.error("delete_message failed: %s", e)
        raise HTTPException(status_code=502, detail="메일 서버에 연결할 수 없습니다")
    # 클라이언트는 200 이면 목록에서 제거한다. 삭제 실패 시 오류로 응답한다(이전에는 ok=false 도 200 이었다).
    if not (result or {}).get("ok"):
        raise HTTPException(status_code=500, detail="메일을 삭제하지 못했습니다")
    return result


# ─── Send message ───


async def _signature_texts(db: AsyncSession, user_id: str) -> list[str]:
    res = await db.execute(select(MailSignature.html_content).where(MailSignature.user_id == user_id))
    return [threads.html_to_text(h or "") for (h,) in res.all()]


_FORWARD_MARK = "<p>---------- Forwarded message ----------</p>"


def _quote_start(html: str) -> int:
    """인용·전달 원문의 시작 위치(없으면 -1) — 서명은 그 앞에 삽입된다.

    작성기의 답장 인용은 `<p>날짜, 보낸 사람:</p><blockquote>…` 형태이므로 `<blockquote` 앞에 삽입하면 서명이
    머리줄과 인용문 사이에 위치하게 된다. 따라서 머리줄 문단부터를 인용으로 간주한다. 전달 원문은 blockquote 가 없어
    구분선 문단을 검색한다(없으면 기존과 같이 끝).
    """
    import re as _re
    q = html.lower().find("<blockquote")
    if q >= 0:
        m = _re.search(r"<p>[^<]{0,300}:</p>\s*$", html[:q])
        if m:
            q = m.start()
    f = html.find(_FORWARD_MARK)
    found = [x for x in (q, f) if x >= 0]
    return min(found) if found else -1


def _insert_signature(html: str | None, text: str, sig_html: str, sig_text: str,
                      known_texts: list[str]) -> tuple[str | None, str]:
    """본문에 포함된 서명(블록·알려진 서명 텍스트)을 모두 제거하고 정확히 하나만 삽입한다.

    위치: 기존 서명 블록 위치 → 없으면 인용(<blockquote) 바로 앞 → 없으면 끝.
    """
    block = f'<div class="signature"><p>--</p>{sig_html}</div>'
    if html is not None:
        spans = threads._signature_spans(html)
        if spans:
            pos = spans[0][0]
            stripped = threads.strip_signature_html(html)
            html = stripped[:pos] + block + stripped[pos:]
        else:
            q = _quote_start(html)
            html = (html[:q] + block + html[q:]) if q >= 0 else html + block
    text = threads.strip_signature_text(text or "", known_texts + [sig_text]) or ""
    text = text + f"\n\n--\n{sig_text}"
    return html, text


async def _resolve_reply_headers(account: MailAccount, in_reply_to: str | None,
                                 references: list[str], mailbox: str | None) -> tuple[str | None, list[str]]:
    """프런트가 in_reply_to 에 IMAP UID 를 넣어 전송하던 문제 보정.

    Message-ID(<..@..>) 가 아니면 원문 헤더에서 Message-ID·References 를 조회하여 설정한다.
    조회 실패 시 잘못된 헤더를 전송하지 않도록 비운다(수신 측 스레드 손상의 원인).
    """
    if not in_reply_to:
        return None, references
    if "@" in in_reply_to:
        return in_reply_to, references
    try:
        raw = await _incoming(account).fetch_raw_headers(account, mailbox or "INBOX", in_reply_to)
    except Exception:
        raw = None
    if not raw:
        return None, references
    import email as _email
    h = _email.message_from_string(raw)
    mid = (h.get("Message-ID") or "").strip()
    if not mid:
        return None, references
    if not references:
        refs = threads._ids(h.get("References"))
        if not refs:
            refs = threads._ids(h.get("In-Reply-To"))
        references = refs + [mid]
    return mid, references


async def perform_send(db: AsyncSession, user: User, account: MailAccount, payload: dict,
                       attachments: list[dict] | None) -> None:
    """실제 SMTP 발송 + 보낸편지함 복사 + 최근 수신인 기록. 즉시 발송·예약 발송 공용.

    payload["ai_generated"](화면 내 AI 답장 초안으로 작성한 메일)이면 X-AI-Generated 를 추가한다(예약 발송도 payload 로 전달된다).
    AI 도구 발송(mail_send)처럼 외부에서 이미 설정한 값은 덮어쓰지 않는다.
    """
    ai_tok = None
    if payload.get("ai_generated") and not smtp_client.AI_GENERATED.get():
        ai_tok = smtp_client.AI_GENERATED.set("yes; just-workspace AI draft; reviewed-and-sent-by-user")
    try:
        raw_msg = await smtp_client.send_message(
            account=account,
            from_name=payload["from_name"],
            to=payload["to"],
            cc=payload.get("cc") or None,
            bcc=payload.get("bcc") or None,
            subject=payload.get("subject") or "",
            text_body=payload.get("text_body") or "",
            html_body=payload.get("html_body"),
            in_reply_to=payload.get("in_reply_to"),
            references=payload.get("references") or None,
            attachments=attachments or None,
            request_read_receipt=bool(payload.get("request_read_receipt")),
        )
    finally:
        if ai_tok is not None:
            smtp_client.AI_GENERATED.reset(ai_tok)

    # Copy sent message to Sent folder
    try:
        await _incoming(account).append_to_sent(account, raw_msg)
    except Exception as e:
        logger.warning("Failed to copy to Sent folder: %s", e)

    # 자동완성용 최근 수신인 기록. 이전에는 브라우저 localStorage 에만 저장되어
    # 기기 변경 시 소실되었다. 실패해도 발송 결과에는 영향을 주지 않는다.
    from app.contacts.suggest import record_recipients
    everyone = list(payload["to"]) + list(payload.get("cc") or []) + list(payload.get("bcc") or [])
    await record_recipients(user.id, everyone)


@router.post("/send")
@require_module("mail")
async def send_message(
    body: SendMessageRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from datetime import datetime, timedelta, timezone

    account = await _get_account(db, user, body.account_id)

    from_name = body.from_name or user.display_name or user.username

    # 예약 발송 시각 검증(첨부를 소모하기 전에)
    send_at = None
    if body.send_at:
        try:
            send_at = datetime.fromisoformat(body.send_at.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="send_at 은 ISO 8601 이어야 합니다")
        if send_at.tzinfo is None:
            send_at = send_at.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if send_at > now + timedelta(days=366):
            raise HTTPException(status_code=400, detail="예약은 1년 안으로만 할 수 있습니다")
        if send_at <= now + timedelta(seconds=30):
            send_at = None  # 즉시 발송과 동일

    # 서명: signature_id 지정 시 서버가 추가(중복 제거), 아니면 중복 블록만 정리
    html_body = body.html_body
    text_body = body.text_body or ""
    known = await _signature_texts(db, user.id)
    if body.signature_id:
        sig = await db.get(MailSignature, body.signature_id)
        if not sig or sig.user_id != user.id:
            raise HTTPException(status_code=404, detail="서명을 찾을 수 없습니다")
        html_body, text_body = _insert_signature(
            html_body, text_body, sig.html_content, threads.html_to_text(sig.html_content), known,
        )
    else:
        html_body = threads.dedupe_signature_html(html_body)
        text_body = threads.dedupe_signature_text(text_body, known) or ""

    in_reply_to, references = await _resolve_reply_headers(
        account, body.in_reply_to, list(body.references or []), body.reply_mailbox_id,
    )

    payload = {
        "from_name": from_name,
        "to": [a.model_dump() for a in body.to],
        "cc": [a.model_dump() for a in body.cc] if body.cc else [],
        "bcc": [a.model_dump() for a in body.bcc] if body.bcc else [],
        "subject": body.subject,
        "text_body": text_body,
        "html_body": html_body,
        "in_reply_to": in_reply_to,
        "references": references,
        "request_read_receipt": body.request_read_receipt,
        "ai_generated": bool(body.ai_generated),
    }

    # Resolve attachment blob IDs to actual data
    resolved_attachments = None
    used_blobs: list[str] = []
    redis = None
    if body.attachments:
        import json as _json
        from app.chat.redis_client import get_redis
        redis = await get_redis()
        resolved_attachments = []
        for att_ref in body.attachments:
            meta_s = await redis.get(f"mailatt:{att_ref.blobId}")
            meta = _json.loads(meta_s) if meta_s else None
            path = _attach_path(att_ref.blobId)
            if not meta or meta.get("user_id") != user.id or not _os.path.isfile(path):
                raise HTTPException(status_code=400, detail=f"첨부파일을 찾을 수 없습니다: {att_ref.name}")
            with open(path, "rb") as f:
                blob_data = f.read()
            resolved_attachments.append({
                "data": blob_data,
                "name": meta["name"],
                "type": meta["type"],
            })
            used_blobs.append(att_ref.blobId)

    async def _consume_blobs() -> None:
        # 임시 첨부는 발송(또는 예약 등록) 완료 후 삭제한다. 먼저 삭제하면 SMTP 가 1회 실패했을 때
        # "보내기"를 다시 눌러도 "첨부파일을 찾을 수 없습니다" 로 종료되었다.
        for bid in used_blobs:
            try:
                await redis.delete(f"mailatt:{bid}")
            except Exception:  # noqa: BLE001 — 잔여 정리는 TTL 만료로 처리
                pass
            try:
                _os.remove(_attach_path(bid))
            except OSError:
                pass

    if send_at is not None:
        from app.mail import scheduled as _sched
        row = await _sched.enqueue(db, user, body.account_id, payload, resolved_attachments, send_at)
        await _consume_blobs()
        return {"ok": True, "scheduled": True, "id": row.id, "send_at": row.send_at.isoformat()}

    try:
        await perform_send(db, user, account, payload, resolved_attachments)
    except Exception as e:
        logger.error("SMTP send failed: %s", e)
        raise HTTPException(status_code=502, detail=f"메일 전송 실패: {str(e)}")

    await _consume_blobs()
    return {"ok": True}


# ─── 예약 발송 ───


def _scheduled_to_response(row: MailScheduledSend) -> ScheduledMailResponse:
    import json as _json
    try:
        p = _json.loads(row.payload)
    except Exception:
        p = {}
    return ScheduledMailResponse(
        id=row.id,
        account_id=row.account_id,
        subject=row.subject,
        to=[EmailAddress(**a) for a in p.get("to", [])],
        send_at=row.send_at.isoformat(),
        status=row.status,
        error=row.error,
        created_at=row.created_at.isoformat(),
        sent_at=row.sent_at.isoformat() if row.sent_at else None,
    )


@router.get("/scheduled", response_model=list[ScheduledMailResponse])
@require_module("mail")
async def list_scheduled(
    include_done: bool = Query(False, description="보냄·실패·취소도 포함"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(MailScheduledSend).where(MailScheduledSend.user_id == user.id)
    if not include_done:
        q = q.where(MailScheduledSend.status.in_(["pending", "sending", "failed"]))
    res = await db.execute(q.order_by(MailScheduledSend.send_at))
    return [_scheduled_to_response(r) for r in res.scalars().all()]


@router.patch("/scheduled/{scheduled_id}", response_model=ScheduledMailResponse)
@require_module("mail")
async def reschedule(
    scheduled_id: str,
    body: ScheduledMailUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from datetime import datetime, timezone
    row = await db.get(MailScheduledSend, scheduled_id)
    if not row or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="예약 메일을 찾을 수 없습니다")
    if row.status not in ("pending", "failed"):
        raise HTTPException(status_code=409, detail="이미 보냈거나 보내는 중입니다")
    try:
        at = datetime.fromisoformat(body.send_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="send_at 은 ISO 8601 이어야 합니다")
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    row.send_at = at
    row.status = "pending"
    row.error = None
    await db.commit()
    await db.refresh(row)
    return _scheduled_to_response(row)


@router.delete("/scheduled/{scheduled_id}")
@require_module("mail")
async def cancel_scheduled(
    scheduled_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """예약 취소. 발송 중이면 409. 디스크로 이동해 둔 첨부도 삭제한다."""
    from sqlalchemy import update as _update
    from app.mail import scheduled as _sched
    row = await db.get(MailScheduledSend, scheduled_id)
    if not row or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="예약 메일을 찾을 수 없습니다")
    # 발송 루프와 경합 — pending/failed 일 때만 조건부로 취소
    res = await db.execute(
        _update(MailScheduledSend)
        .where(MailScheduledSend.id == scheduled_id, MailScheduledSend.status.in_(["pending", "failed"]))
        .values(status="cancelled")
    )
    await db.commit()
    if res.rowcount != 1:
        raise HTTPException(status_code=409, detail="이미 보냈거나 보내는 중입니다")
    _sched.remove_files(scheduled_id)
    return {"ok": True}


# ─── 아카이브 백필 ───


@router.post("/accounts/{account_id}/archive/backfill")
@require_module("mail")
async def archive_backfill(
    account_id: str,
    mailbox: str = "INBOX",
    limit: int = 200,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이미 수신된 메일을 소급하여 아카이브한다.

    폴러는 '앞으로 오는' 메일만 저장한다. 활성화 이전에 누적된 메일은 본 기능으로 가져온다.
    이미 저장된 건은 건너뛰므로 반복 실행해도 안전하다.

    **요청 내에서 완료하지 않는다.** IMAP 에서 수백 통을 수신하는 작업이므로
    nginx 의 120초 게이트웨이 타임아웃을 초과한다(실제로 504 가 발생했다).
    백그라운드로 실행하고 진행 상황은 status 엔드포인트로 조회한다.
    """
    from app.mail import archive as mail_archive

    account = await _get_account(db, user, account_id)
    if not getattr(account, "archive_enabled", False):
        raise HTTPException(status_code=400, detail="이 계정은 아카이브가 꺼져 있습니다")

    limit = max(1, min(limit, 1000))
    started = await mail_archive.start_backfill(account, mailbox, limit)
    if not started:
        raise HTTPException(status_code=409, detail="이미 가져오는 중입니다")
    return {"started": True, "limit": limit}


@router.get("/accounts/{account_id}/archive/status")
@require_module("mail")
async def archive_status(
    account_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """백필 진행 상황. 프런트가 이를 폴링하여 완료를 통지한다."""
    from app.mail import archive as mail_archive

    account = await _get_account(db, user, account_id)
    return await mail_archive.backfill_status(account.id)


# ─── Attachment upload ───


@router.post("/upload")
@require_module("mail")
async def upload_attachment(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """Upload an attachment file temporarily. Returns a blob reference for sending."""

    _cleanup_expired_attachments()

    # 일반 첨부 15MB — 수신 측 서버 한도(통상 20~25MB, base64 로 1.37배)를 초과하지 않도록 설정.
    # 이보다 큰 파일은 작성 창이 대용량 첨부(파일함 + 30일 다운로드 링크)로 전환한다.
    MAX_FILE_SIZE = 15 * 1024 * 1024
    data = await file.read()
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="일반 첨부는 15MB까지입니다 — 대용량 첨부로 올려 주세요")

    return await _store_temp_attachment(data, file.filename or "attachment",
                                        file.content_type or "application/octet-stream", user.id)


async def _store_temp_attachment(data: bytes, name: str, ctype: str, user_id: str) -> dict:
    """발송용 임시 첨부(30분) — 디스크 + redis 메타. 반환 형식은 작성 창 UploadedAttachment 와 동일."""
    import uuid
    import json as _json
    from app.chat.redis_client import get_redis
    blob_id = str(uuid.uuid4())
    _os.makedirs(_ATTACH_DIR, exist_ok=True)
    with open(_attach_path(blob_id), "wb") as f:
        f.write(data)
    redis = await get_redis()
    await redis.setex(f"mailatt:{blob_id}", _ATTACHMENT_TTL, _json.dumps({
        "name": name, "type": ctype, "size": len(data), "user_id": user_id,
    }))
    return {"blobId": blob_id, "name": name, "type": ctype, "size": len(data)}


@router.post("/upload-inline")
@require_module("mail")
async def upload_inline_image(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """Upload an inline image, returns a base64 data URI for embedding in HTML."""
    import base64

    MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10 MB
    data = await file.read()
    if len(data) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail="인라인 이미지는 10MB를 초과할 수 없습니다")

    content_type = file.content_type or "image/png"
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="이미지 파일만 업로드할 수 있습니다")

    b64 = base64.b64encode(data).decode("ascii")
    return {"url": f"data:{content_type};base64,{b64}"}


# ─── Bulk operations ───


@router.post("/bulk")
@require_module("mail")
async def bulk_action(
    body: BulkActionRequest,
    mailbox_id: str = Query("INBOX"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_account(db, user, body.account_id)

    if not body.message_ids:
        raise HTTPException(status_code=400, detail="메시지를 선택해주세요")
    if body.action in ("spam", "move"):
        _reject_pop3_folder_op(account)

    # Pre-fetch mailbox list once for actions that need it
    target_mailbox = None
    if body.action == "delete":
        mailboxes = await _incoming(account).list_mailboxes(account)
        # 목록 조회에 실패했는데 "휴지통 없음"으로 판정하고 진행하면 영구 삭제가 됨
        if not mailboxes:
            raise HTTPException(status_code=502, detail="메일 서버에서 편지함 목록을 받지 못했습니다")
        target_mailbox = next((mb["id"] for mb in mailboxes if mb.get("role") == "trash"), None)
    elif body.action == "spam":
        mailboxes = await _incoming(account).list_mailboxes(account)
        target_mailbox = next((mb["id"] for mb in mailboxes if mb.get("role") == "junk"), None)
        if not target_mailbox:
            raise HTTPException(status_code=400, detail="스팸 폴더를 찾을 수 없습니다")
    elif body.action == "move":
        if not body.mailbox_id:
            raise HTTPException(status_code=400, detail="이동할 메일함을 지정해주세요")
        target_mailbox = body.mailbox_id

    # 건별로 결과를 확인한다. 이전에는 실패해도 ok 를 반환하여 화면에서만 제거되고 메일은 유지되었다.
    failed = 0
    for uid in body.message_ids:
        if body.action == "read":
            ok = await _incoming(account).update_flags(account, mailbox_id, uid, add_flags=["\\Seen"])
        elif body.action == "unread":
            ok = await _incoming(account).update_flags(account, mailbox_id, uid, remove_flags=["\\Seen"])
        elif body.action == "star":
            ok = await _incoming(account).update_flags(account, mailbox_id, uid, add_flags=["\\Flagged"])
        elif body.action == "unstar":
            ok = await _incoming(account).update_flags(account, mailbox_id, uid, remove_flags=["\\Flagged"])
        elif body.action == "delete":
            ok = (await _incoming(account).delete_message(account, mailbox_id, uid, target_mailbox) or {}).get("ok")
        elif body.action == "spam":
            ok = await _incoming(account).move_message(account, mailbox_id, uid, target_mailbox)
        elif body.action == "move":
            ok = await _incoming(account).move_message(account, mailbox_id, uid, target_mailbox)
        else:
            raise HTTPException(status_code=400, detail=f"지원하지 않는 작업: {body.action}")
        if not ok:
            failed += 1

    if failed:
        raise HTTPException(status_code=500, detail=f"{failed}건을 처리하지 못했습니다")
    return {"ok": True, "count": len(body.message_ids)}


# ─── Attachment download (via IMAP FETCH) ───


@router.get("/attachments/{blob_id}")
@require_module("mail")
async def download_attachment(
    blob_id: str,
    mailbox_id: str = Query("INBOX"),
    account_id: str | None = Query(None),
    inline: bool = Query(False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download attachment. blob_id format: {uid}:{part_index}"""
    account = await _get_account(db, user, account_id)

    parts = blob_id.split(":")
    if len(parts) != 2:
        raise HTTPException(status_code=400, detail="Invalid blob_id format")

    uid = parts[0]
    try:
        part_index = int(parts[1])
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid part index")

    result = await _incoming(account).download_attachment(account, mailbox_id, uid, part_index)
    if not result:
        raise HTTPException(status_code=404, detail="Attachment not found")

    data, content_type, filename = result
    # inline=1 이면 브라우저가 직접 표시한다(PDF 미리보기 모달·이미지 썸네일). 기본은 다운로드.
    # 이미지·PDF 가 아닌 형식(html·svg 등)은 inline 요청이어도 다운로드로 전송한다(http_utils.inline_allowed).
    # nosniff: 형식을 위조한 첨부를 브라우저가 html 로 추정하여 실행하지 않도록 한다.
    from app.files import serve_safety
    media, headers = serve_safety.safe_file_headers(filename, content_type=content_type, inline=inline)
    return Response(content=data, media_type=media, headers=headers)


# ─── Signatures CRUD (unchanged, DB-based) ───


@router.get("/signatures", response_model=list[SignatureResponse])
@require_module("mail")
async def list_signatures(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(MailSignature)
        .where(MailSignature.user_id == user.id)
        .order_by(MailSignature.created_at)
    )
    sigs = result.scalars().all()
    return [
        SignatureResponse(
            id=s.id,
            name=s.name,
            html_content=s.html_content,
            is_default=s.is_default,
            created_at=s.created_at.isoformat(),
        )
        for s in sigs
    ]


@router.get("/signatures/default", response_model=SignatureResponse | None)
@require_module("mail")
async def get_default_signature(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(MailSignature).where(
            MailSignature.user_id == user.id, MailSignature.is_default == True
        )
    )
    sig = result.scalar_one_or_none()
    if not sig:
        return None
    return SignatureResponse(
        id=sig.id,
        name=sig.name,
        html_content=sig.html_content,
        is_default=sig.is_default,
        created_at=sig.created_at.isoformat(),
    )


@router.post("/signatures", response_model=SignatureResponse, status_code=201)
@require_module("mail")
async def create_signature(
    body: SignatureCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.is_default:
        result = await db.execute(
            select(MailSignature).where(
                MailSignature.user_id == user.id, MailSignature.is_default == True
            )
        )
        for s in result.scalars():
            s.is_default = False

    sig = MailSignature(
        user_id=user.id,
        name=body.name,
        html_content=body.html_content,
        is_default=body.is_default,
    )
    db.add(sig)
    await db.commit()
    await db.refresh(sig)
    return SignatureResponse(
        id=sig.id,
        name=sig.name,
        html_content=sig.html_content,
        is_default=sig.is_default,
        created_at=sig.created_at.isoformat(),
    )


@router.patch("/signatures/{sig_id}", response_model=SignatureResponse)
@require_module("mail")
async def update_signature(
    sig_id: str,
    body: SignatureUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sig = await db.get(MailSignature, sig_id)
    if not sig or sig.user_id != user.id:
        raise HTTPException(status_code=404, detail="서명을 찾을 수 없습니다")

    if body.name is not None:
        sig.name = body.name
    if body.html_content is not None:
        sig.html_content = body.html_content
    if body.is_default is not None:
        if body.is_default:
            result = await db.execute(
                select(MailSignature).where(
                    MailSignature.user_id == user.id,
                    MailSignature.is_default == True,
                    MailSignature.id != sig_id,
                )
            )
            for s in result.scalars():
                s.is_default = False
        sig.is_default = body.is_default

    await db.commit()
    await db.refresh(sig)
    return SignatureResponse(
        id=sig.id,
        name=sig.name,
        html_content=sig.html_content,
        is_default=sig.is_default,
        created_at=sig.created_at.isoformat(),
    )


@router.delete("/signatures/{sig_id}")
@require_module("mail")
async def delete_signature(
    sig_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sig = await db.get(MailSignature, sig_id)
    if not sig or sig.user_id != user.id:
        raise HTTPException(status_code=404, detail="서명을 찾을 수 없습니다")
    await db.delete(sig)
    await db.commit()
    return {"ok": True}


# ─── Drafts CRUD ───


def _draft_to_response(draft: MailDraft, sig_texts: list[str] | None = None) -> DraftResponse:
    import json
    to_list = []
    cc_list = []
    bcc_list = []
    try:
        if draft.to_addresses:
            to_list = [EmailAddress(**a) for a in json.loads(draft.to_addresses)]
    except (json.JSONDecodeError, TypeError):
        pass
    try:
        if draft.cc_addresses:
            cc_list = [EmailAddress(**a) for a in json.loads(draft.cc_addresses)]
    except (json.JSONDecodeError, TypeError):
        pass
    try:
        if draft.bcc_addresses:
            bcc_list = [EmailAddress(**a) for a in json.loads(draft.bcc_addresses)]
    except (json.JSONDecodeError, TypeError):
        pass
    return DraftResponse(
        id=draft.id,
        account_id=draft.account_id,
        subject=draft.subject,
        to=to_list,
        cc=cc_list,
        bcc=bcc_list,
        body_html=draft.body_html,
        body_text=draft.body_text,
        created_at=draft.created_at.isoformat(),
        updated_at=draft.updated_at.isoformat(),
        signature_id=draft.signature_id,
        has_signature=threads.has_signature(draft.body_html, draft.body_text, sig_texts or []),
        body_html_without_signature=threads.strip_signature_html(draft.body_html),
        body_text_without_signature=threads.strip_signature_text(draft.body_text, sig_texts or []),
        file_attachments=_file_attach.loads(getattr(draft, "file_attachments", None)),
    )


@router.get("/drafts", response_model=list[DraftResponse])
@require_module("mail")
async def list_drafts(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(MailDraft)
        .where(MailDraft.user_id == user.id)
        .order_by(MailDraft.updated_at.desc())
    )
    drafts = result.scalars().all()
    sig_texts = await _signature_texts(db, user.id)
    return [_draft_to_response(d, sig_texts) for d in drafts]


@router.get("/drafts/{draft_id}", response_model=DraftResponse)
@require_module("mail")
async def get_draft(
    draft_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    draft = await db.get(MailDraft, draft_id)
    if not draft or draft.user_id != user.id:
        raise HTTPException(status_code=404, detail="임시보관 메일을 찾을 수 없습니다")
    out = _draft_to_response(draft, await _signature_texts(db, user.id))
    if out.file_attachments:
        # 작성 창에서 즉시 발송할 수 있도록 임시 첨부로 변환(해당 시점의 권한·크기로 재확인)
        try:
            out.attachments = await _file_attach.to_blobs(db, user, out.file_attachments)
        except _file_attach.AttachError as e:
            out.attachment_error = e.message
        except Exception:  # noqa: BLE001 — 첨부 실패가 초안 열기를 차단하지 않도록 함
            logger.warning("[mail] draft file attachments failed", exc_info=True)
            out.attachment_error = "첨부 파일을 불러오지 못했습니다"
    return out


@router.post("/drafts", response_model=DraftResponse, status_code=201)
@require_module("mail")
async def save_draft(
    body: DraftSave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    import json
    from datetime import datetime, timezone

    to_json = json.dumps([a.model_dump() for a in body.to], ensure_ascii=False) if body.to else None
    files_json = None
    if body.file_attachments is not None:
        try:
            files_json = _file_attach.dumps(await _file_attach.resolve(db, user, body.file_attachments))
        except _file_attach.AttachError as e:
            raise HTTPException(status_code={"forbidden": 403, "not_found": 404, "too_large": 413}.get(e.code, 400),
                                detail=e.message)
    cc_json = json.dumps([a.model_dump() for a in body.cc], ensure_ascii=False) if body.cc else None
    bcc_json = json.dumps([a.model_dump() for a in body.bcc], ensure_ascii=False) if body.bcc else None

    # Update existing draft if id provided
    if body.id:
        draft = await db.get(MailDraft, body.id)
        if draft and draft.user_id == user.id:
            draft.account_id = body.account_id
            draft.subject = body.subject
            draft.to_addresses = to_json
            draft.cc_addresses = cc_json
            draft.bcc_addresses = bcc_json
            draft.body_html = body.body_html
            draft.body_text = body.body_text
            if body.signature_id is not None:
                draft.signature_id = body.signature_id or None
            if body.file_attachments is not None:
                draft.file_attachments = files_json
            draft.updated_at = datetime.now(timezone.utc)
            await db.commit()
            await db.refresh(draft)
            return _draft_to_response(draft, await _signature_texts(db, user.id))

    # Create new draft
    draft = MailDraft(
        user_id=user.id,
        account_id=body.account_id,
        subject=body.subject,
        to_addresses=to_json,
        cc_addresses=cc_json,
        bcc_addresses=bcc_json,
        body_html=body.body_html,
        body_text=body.body_text,
        signature_id=body.signature_id or None,
        file_attachments=files_json,
    )
    db.add(draft)
    await db.commit()
    await db.refresh(draft)
    return _draft_to_response(draft, await _signature_texts(db, user.id))


@router.delete("/drafts/{draft_id}")
@require_module("mail")
async def delete_draft(
    draft_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    draft = await db.get(MailDraft, draft_id)
    if not draft or draft.user_id != user.id:
        raise HTTPException(status_code=404, detail="임시보관 메일을 찾을 수 없습니다")
    await db.delete(draft)
    await db.commit()
    return {"ok": True}


# ─── Mail Filter Rules ───


class FilterRuleCreate(BaseModel):
    name: str
    field: str  # from, to, subject, any
    match_type: str = "contains"  # contains, equals, starts_with
    value: str
    action: str = "move"
    target_folder: str
    account_id: str | None = None
    priority: int = 0


class FilterRuleUpdate(BaseModel):
    name: str | None = None
    field: str | None = None
    match_type: str | None = None
    value: str | None = None
    target_folder: str | None = None
    priority: int | None = None
    is_active: bool | None = None


@router.get("/filters")
@require_module("mail")
async def list_filter_rules(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all mail filter rules for the current user."""
    result = await db.execute(
        select(MailFilterRule)
        .where(MailFilterRule.user_id == user.id)
        .order_by(MailFilterRule.priority, MailFilterRule.created_at)
    )
    rules = result.scalars().all()
    return {
        "rules": [
            {
                "id": r.id,
                "name": r.name,
                "field": r.field,
                "match_type": r.match_type,
                "value": r.value,
                "action": r.action,
                "target_folder": r.target_folder,
                "account_id": r.account_id,
                "priority": r.priority,
                "is_active": r.is_active,
            }
            for r in rules
        ]
    }


@router.post("/filters")
@require_module("mail")
async def create_filter_rule(
    body: FilterRuleCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new mail filter rule."""
    if body.field not in ("from", "to", "subject", "any"):
        raise HTTPException(status_code=400, detail="유효하지 않은 필드: from, to, subject, any 중 선택")
    if body.match_type not in ("contains", "equals", "starts_with"):
        raise HTTPException(status_code=400, detail="유효하지 않은 매칭 유형")
    if not body.value.strip():
        raise HTTPException(status_code=400, detail="필터 값을 입력해주세요")

    rule = MailFilterRule(
        user_id=user.id,
        account_id=body.account_id,
        name=body.name,
        field=body.field,
        match_type=body.match_type,
        value=body.value.strip(),
        action=body.action,
        target_folder=body.target_folder,
        priority=body.priority,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return {
        "id": rule.id,
        "name": rule.name,
        "field": rule.field,
        "match_type": rule.match_type,
        "value": rule.value,
        "action": rule.action,
        "target_folder": rule.target_folder,
        "priority": rule.priority,
        "is_active": rule.is_active,
    }


@router.patch("/filters/{rule_id}")
@require_module("mail")
async def update_filter_rule(
    rule_id: str,
    body: FilterRuleUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update a mail filter rule."""
    rule = await db.get(MailFilterRule, rule_id)
    if not rule or rule.user_id != user.id:
        raise HTTPException(status_code=404, detail="필터 규칙을 찾을 수 없습니다")

    if body.name is not None:
        rule.name = body.name
    if body.field is not None:
        if body.field not in ("from", "to", "subject", "any"):
            raise HTTPException(status_code=400, detail="유효하지 않은 필드")
        rule.field = body.field
    if body.match_type is not None:
        rule.match_type = body.match_type
    if body.value is not None:
        rule.value = body.value.strip()
    if body.target_folder is not None:
        rule.target_folder = body.target_folder
    if body.priority is not None:
        rule.priority = body.priority
    if body.is_active is not None:
        rule.is_active = body.is_active

    await db.commit()
    return {"ok": True}


@router.delete("/filters/{rule_id}")
@require_module("mail")
async def delete_filter_rule(
    rule_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a mail filter rule."""
    rule = await db.get(MailFilterRule, rule_id)
    if not rule or rule.user_id != user.id:
        raise HTTPException(status_code=404, detail="필터 규칙을 찾을 수 없습니다")
    await db.delete(rule)
    await db.commit()
    return {"ok": True}


def _match_rule(rule: MailFilterRule, msg: dict) -> bool:
    """Check if a message matches a filter rule."""
    val = rule.value.lower()
    targets = []
    from_addrs = msg.get("from_") or msg.get("from") or []
    to_addrs = msg.get("to") or []
    if rule.field == "from":
        targets = [a.get("email", "").lower() + " " + (a.get("name") or "").lower()
                    for a in from_addrs]
    elif rule.field == "to":
        targets = [a.get("email", "").lower() + " " + (a.get("name") or "").lower()
                    for a in to_addrs]
    elif rule.field == "subject":
        targets = [(msg.get("subject") or "").lower()]
    elif rule.field == "any":
        targets = [
            *[a.get("email", "").lower() + " " + (a.get("name") or "").lower()
              for a in from_addrs],
            *[a.get("email", "").lower() + " " + (a.get("name") or "").lower()
              for a in to_addrs],
            (msg.get("subject") or "").lower(),
        ]

    for t in targets:
        if rule.match_type == "contains" and val in t:
            return True
        if rule.match_type == "equals" and val == t.strip():
            return True
        if rule.match_type == "starts_with" and t.strip().startswith(val):
            return True
    return False


@router.post("/filters/apply")
@require_module("mail")
async def apply_filter_rules(
    account_id: str | None = Query(None),
    mailbox_id: str = Query("INBOX"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Apply all active filter rules to messages in the specified mailbox."""
    account = await _get_account(db, user, account_id)
    # 필터 규칙의 동작은 "폴더로 이동"뿐이다. POP3 에서는 이전에 0건 이동으로 오류 없이 종료되었다
    _reject_pop3_folder_op(account)

    # Fetch active rules
    result = await db.execute(
        select(MailFilterRule)
        .where(MailFilterRule.user_id == user.id, MailFilterRule.is_active == True)
        .order_by(MailFilterRule.priority)
    )
    rules = result.scalars().all()
    if not rules:
        return {"ok": True, "moved": 0}

    # Fetch all messages from mailbox (up to 500)
    messages, total = await _incoming(account).fetch_messages(account, mailbox_id, page=0, limit=500)

    moved = 0
    for msg in messages:
        for rule in rules:
            if _match_rule(rule, msg):
                uid = msg.get("uid") or msg.get("id", "").split(":")[0]
                if uid:
                    ok = await _incoming(account).move_message(account, mailbox_id, uid, rule.target_folder)
                    if ok:
                        moved += 1
                break  # First matching rule wins

    return {"ok": True, "moved": moved}
