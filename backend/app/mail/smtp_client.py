"""SMTP client for sending mail via user's SMTP server."""

import logging
from contextvars import ContextVar
from email.header import Header
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from email import encoders

import aiosmtplib

from app.db.models import MailAccount
from app.mail import access_guard
from app.mail.crypto import decrypt_password

# AI 기본법(2026-01-22 시행) — AI 가 작성·발송한 메일임을 기계 판독 가능하게 표시한다(비가시 표시).
# MCP mail_send 도구가 발송 중 활성화한다. 사용자가 직접 작성한 메일에는 추가되지 않는다.
AI_GENERATED: ContextVar[str | None] = ContextVar("mail_ai_generated", default=None)

logger = logging.getLogger(__name__)


def _encode_address(name: str | None, addr: str) -> str:
    """Encode a single email address with RFC 2047 display name."""
    if name:
        return formataddr((str(Header(name, "utf-8")), addr))
    return addr


def _encode_address_list(addrs: list[dict]) -> str:
    """Encode a list of {name, email} dicts into a header value."""
    return ", ".join(
        _encode_address(a.get("name"), a["email"]) for a in addrs
    )


async def _xoauth2_send(account, msg, recipients: list[str], tls_context) -> None:
    """OAuth2(XOAUTH2) SMTP 전송 — aiosmtplib 수동 흐름."""
    import base64
    from app.mail import oauth as mail_oauth

    token = await mail_oauth.get_access_token(account)
    auth = base64.b64encode(
        f"user={account.username}\x01auth=Bearer {token}\x01\x01".encode()
    ).decode()
    smtp = aiosmtplib.SMTP(
        hostname=account.smtp_host, port=account.smtp_port,
        use_tls=(account.smtp_security == "ssl"), start_tls=False,
        tls_context=tls_context, timeout=30,
    )
    await smtp.connect()
    try:
        if account.smtp_security == "starttls":
            await smtp.starttls(tls_context=tls_context)
        await smtp.ehlo()
        code, resp = await smtp.execute_command(b"AUTH", b"XOAUTH2", auth.encode())
        if code not in (235, 334):
            raise RuntimeError(f"XOAUTH2 인증 실패: {code} {resp}")
        await smtp.send_message(msg, sender=account.email, recipients=recipients)
    finally:
        try:
            await smtp.quit()
        except Exception:
            pass


async def send_message(
    account: MailAccount,
    from_name: str,
    to: list[dict],
    cc: list[dict] | None = None,
    bcc: list[dict] | None = None,
    subject: str = "",
    text_body: str = "",
    html_body: str | None = None,
    in_reply_to: str | None = None,
    references: list[str] | None = None,
    attachments: list[dict] | None = None,
    request_read_receipt: bool = False,
) -> bytes:
    """Send email via SMTP. Returns raw message bytes on success."""
    from app.config import get_settings

    settings = get_settings()

    # 마스터 인증은 사용자 본인의 내장 메일함 객체에서만(access_guard). 외부 계정은 내부망 접속 금지.
    await access_guard.ensure_account_hosts(account)
    is_builtin = access_guard.is_builtin(account)
    auth_method = getattr(account, "auth_method", "password") or "password"
    smtp_user = account.username
    password = ""
    if auth_method != "oauth":
        smtp_user, password, is_builtin = access_guard.login_credentials(account, decrypt_password)

    # Build the email message
    if attachments:
        msg = MIMEMultipart("mixed")
        if html_body:
            alt = MIMEMultipart("alternative")
            alt.attach(MIMEText(text_body, "plain", "utf-8"))
            alt.attach(MIMEText(html_body, "html", "utf-8"))
            msg.attach(alt)
        else:
            msg.attach(MIMEText(text_body, "plain", "utf-8"))

        for att in attachments:
            part = MIMEBase("application", "octet-stream")
            part.set_payload(att["data"])
            encoders.encode_base64(part)
            part.add_header(
                "Content-Disposition",
                "attachment",
                filename=att.get("name", "attachment"),
            )
            if att.get("type"):
                part.replace_header("Content-Type", att["type"])
            msg.attach(part)
    elif html_body:
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))
    else:
        msg = MIMEText(text_body, "plain", "utf-8")

    msg["Subject"] = Header(subject, "utf-8").encode() if subject else ""
    _ai = AI_GENERATED.get()
    if _ai:
        msg["X-AI-Generated"] = _ai
    msg["From"] = _encode_address(from_name, account.email)
    msg["To"] = _encode_address_list(to)
    if cc:
        msg["Cc"] = _encode_address_list(cc)
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = " ".join(references)
    if request_read_receipt:
        msg["Disposition-Notification-To"] = account.email
    # 스레드(수신 측·본 서비스 측 모두)가 Message-ID 로 연결되므로 직접 추가한다.
    # MTA 의 자동 추가에 의존하면 외부 SMTP 제출 경로에서는 누락되는 경우가 있다.
    if not msg.get("Message-ID"):
        from email.utils import make_msgid
        dom = (account.email or "").rpartition("@")[2] or settings.domain
        msg["Message-ID"] = make_msgid(domain=dom)
    if not msg.get("Date"):
        from email.utils import formatdate
        msg["Date"] = formatdate(localtime=False, usegmt=True)

    # Collect all recipients
    recipients = [a["email"] for a in to]
    if cc:
        recipients.extend(a["email"] for a in cc)
    if bcc:
        recipients.extend(a["email"] for a in bcc)

    # Determine TLS mode
    use_tls = account.smtp_security == "ssl"
    start_tls = account.smtp_security == "starttls"

    import ssl as _ssl
    # 내부 mailserver만 검증 생략. 외부 SMTP는 정상 검증(자격증명 MITM 방지).
    tls_context = _ssl.create_default_context()
    if is_builtin:
        tls_context.check_hostname = False
        tls_context.verify_mode = _ssl.CERT_NONE

    try:
        if auth_method == "oauth":
            await _xoauth2_send(account, msg, recipients, tls_context)
        else:
            await aiosmtplib.send(
                msg,
                hostname=account.smtp_host,
                port=account.smtp_port,
                username=smtp_user,
                password=password,
                use_tls=use_tls,
                start_tls=start_tls,
                tls_context=tls_context,
                recipients=recipients,
                timeout=30,
            )
        return msg.as_bytes()
    except Exception as e:
        logger.error("SMTP send failed for %s: %s", account.email, e)
        raise


async def send_mdn(
    account: MailAccount,
    from_email: str,
    to_email: str,
    original_message_id: str,
    original_subject: str,
) -> bool:
    """Send an MDN (read receipt) per RFC 8098."""
    from app.config import get_settings
    import uuid
    from email.utils import formatdate

    settings = get_settings()

    # 마스터 인증은 사용자 본인의 내장 메일함 객체에서만(access_guard). 외부 계정은 내부망 접속 금지.
    try:
        await access_guard.ensure_account_hosts(account)
    except access_guard.MailHostRejected:
        logger.warning("MDN skipped: mail host rejected for account %s", getattr(account, 'id', ''))
        return False
    is_builtin = access_guard.is_builtin(account)
    auth_method = getattr(account, "auth_method", "password") or "password"
    smtp_user = account.username
    password = ""
    if auth_method != "oauth":
        smtp_user, password, is_builtin = access_guard.login_credentials(account, decrypt_password)

    # Build multipart/report MDN message
    msg = MIMEMultipart("report", report_type="disposition-notification")
    msg["From"] = from_email
    msg["To"] = to_email
    msg["Subject"] = f"수신확인: {original_subject}"
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = f"<mdn-{uuid.uuid4()}@{settings.domain}>"

    # Human-readable part
    text_part = MIMEText(
        f"이 수신확인은 메일이 표시되었음을 의미합니다.\n\n"
        f"원본 제목: {original_subject}\n",
        "plain", "utf-8",
    )
    msg.attach(text_part)

    # Machine-readable part (RFC 8098)
    disposition = (
        f"Reporting-UA: {settings.domain}; workspace\r\n"
        f"Original-Message-ID: {original_message_id}\r\n"
        f"Final-Recipient: rfc822;{from_email}\r\n"
        f"Disposition: manual-action/MDN-sent-manually; displayed\r\n"
    )
    report_part = MIMEText(disposition, "disposition-notification", "utf-8")
    msg.attach(report_part)

    import ssl as _ssl
    # 내부 mailserver만 검증 생략. 외부 SMTP는 정상 검증(자격증명 MITM 방지).
    tls_context = _ssl.create_default_context()
    if is_builtin:
        tls_context.check_hostname = False
        tls_context.verify_mode = _ssl.CERT_NONE

    use_tls = account.smtp_security == "ssl"
    start_tls = account.smtp_security == "starttls"

    try:
        if auth_method == "oauth":
            await _xoauth2_send(account, msg, [to_email], tls_context)
        else:
            await aiosmtplib.send(
                msg,
                hostname=account.smtp_host,
                port=account.smtp_port,
                username=smtp_user,
                password=password,
                use_tls=use_tls,
                start_tls=start_tls,
                tls_context=tls_context,
                recipients=[to_email],
                timeout=30,
            )
        return True
    except Exception as e:
        logger.error("MDN send failed: %s", e)
        return False


async def test_connection(account: MailAccount) -> tuple[bool, str]:
    """Test SMTP connection. Returns (success, message)."""
    import ssl as _ssl
    from app.config import get_settings

    settings = get_settings()

    # 마스터 인증은 사용자 본인의 내장 메일함 객체에서만(access_guard). 외부 계정은 내부망 접속 금지.
    try:
        await access_guard.ensure_account_hosts(account)
    except access_guard.MailHostRejected:
        return False, access_guard.REJECT_MESSAGE
    is_builtin = access_guard.is_builtin(account)
    auth_method = getattr(account, "auth_method", "password") or "password"
    smtp_user = account.username
    password = ""
    if auth_method != "oauth":
        smtp_user, password, is_builtin = access_guard.login_credentials(account, decrypt_password)

    use_tls = account.smtp_security == "ssl"
    start_tls = account.smtp_security == "starttls"
    tls_context = _ssl.create_default_context()
    if is_builtin:
        tls_context.check_hostname = False
        tls_context.verify_mode = _ssl.CERT_NONE

    try:
        smtp = aiosmtplib.SMTP(
            hostname=account.smtp_host,
            port=account.smtp_port,
            use_tls=use_tls,
            start_tls=start_tls,
            tls_context=tls_context,
            timeout=15,
        )
        await smtp.connect()
        if auth_method == "oauth":
            import base64
            from app.mail import oauth as mail_oauth
            if start_tls:
                await smtp.starttls(tls_context=tls_context)
            await smtp.ehlo()
            token = await mail_oauth.get_access_token(account)
            auth = base64.b64encode(
                f"user={account.username}\x01auth=Bearer {token}\x01\x01".encode()).decode()
            code, resp = await smtp.execute_command(b"AUTH", b"XOAUTH2", auth.encode())
            if code not in (235, 334):
                raise RuntimeError(f"XOAUTH2 인증 실패: {code}")
        else:
            await smtp.login(smtp_user, password)
        await smtp.quit()
        return True, "연결 성공"
    except Exception as e:
        return False, str(e)
