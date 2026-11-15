"""공유 링크를 이메일로 보내기(R7).

발송은 워크스페이스의 시스템 메일 경로(app.admin.settings.get_smtp_config + send_system_email —
비밀번호 재설정·가입 초대 메일과 같은 것)를 그대로 쓴다. 새 SMTP 설정은 없다.

규칙
- 한 번에 받는 사람 MAX_RECIPIENTS(20)명까지, 보낸 사람당 1시간에 HOURLY_LIMIT(50)명까지(실패한 시도도 센다).
- 링크 소유자(만든 사람), 또는 링크 대상 파일에 편집 이상 권한이 있는 사람만 보낼 수 있다.
- 링크 비밀번호는 메일에 넣지 않는다 — 본문에 "비밀번호는 따로 전달됨" 안내만.
- 받는 사람마다 기록(share_link_emails)을 남기고, 워크스페이스 밖 주소인지(external) 표시한다.
- 템플릿 ko/en(보낸 사람 화면 언어). 만료 시각은 보낸 사람 브라우저 시간대(tz)로, 모르면 UTC.

테스트는 _deliver 를 바꿔 끼운다(실제 발송 금지).
"""

from __future__ import annotations

import asyncio
import html
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import ShareLink, ShareLinkEmail, User

settings = get_settings()

MAX_RECIPIENTS = 20
HOURLY_LIMIT = 50
MESSAGE_MAX = 1000
_EMAIL_RE = re.compile(r"^[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[^@\s,;<>\"']+$")


def normalize_recipients(raw: list[str]) -> tuple[list[str], list[str]]:
    """(형식이 맞는 주소 — 소문자·중복 제거·순서 유지, 형식이 틀린 주소)."""
    good: list[str] = []
    bad: list[str] = []
    seen: set[str] = set()
    for r in raw:
        e = (r or "").strip()
        if not e:
            continue
        if len(e) > 320 or not _EMAIL_RE.match(e):
            bad.append(e)
            continue
        k = e.lower()
        if k not in seen:
            seen.add(k)
            good.append(k)
    return good, bad


def _is_folder(link: ShareLink) -> bool:
    from app.files.router import is_folder_link
    return is_folder_link(link)


def link_url(link: ShareLink) -> str:
    """받는 사람이 여는 주소 — 프런트 lib/files shareUrl 과 같은 규칙."""
    base = settings.app_url.rstrip("/")
    guest = bool(link.can_edit) or bool(link.password_hash) or link.allow_download is False or _is_folder(link)
    return f"{base}/s/{link.token}" if guest else f"{base}/api/files/shared/{link.token}"


def _one_line(s: str | None) -> str:
    return re.sub(r"[\r\n\t]+", " ", s or "").strip()


def _fmt_expiry(at: datetime | None, tz: str | None, lang: str) -> str | None:
    if at is None:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    zone = None
    if tz:
        try:
            from zoneinfo import ZoneInfo
            zone = ZoneInfo(tz)
        except Exception:
            zone = None
    local = at.astimezone(zone or timezone.utc)
    label = tz if zone else "UTC"
    return f"{local.strftime('%Y-%m-%d %H:%M')} ({label})"


_T = {
    "ko": {
        "subject": "{sender} 님이 “{name}” 을(를) 공유했습니다",
        "lead": "{sender} 님이 파일을 공유했습니다.",
        "file": "파일",
        "expires": "만료",
        "never": "만료 없음",
        "one_time": "한 번만 열 수 있는 링크입니다.",
        "no_download": "미리보기만 할 수 있습니다(내려받기 막음).",
        "editable": "링크로 같이 편집할 수 있습니다.",
        "password": "이 링크는 비밀번호로 보호됩니다. 비밀번호는 보낸 사람이 따로 전달합니다.",
        "message": "남긴 말",
        "open": "열기",
        "footer": "이 메일은 {app} 에서 {sender} 님의 요청으로 보냈습니다. 모르는 사람이 보냈다면 링크를 열지 마세요.",
    },
    "en": {
        "subject": "{sender} shared “{name}” with you",
        "lead": "{sender} shared a file with you.",
        "file": "File",
        "expires": "Expires",
        "never": "No expiry",
        "one_time": "This link can be opened only once.",
        "no_download": "Preview only (download is turned off).",
        "editable": "You can edit it together through the link.",
        "password": "This link is password-protected. The sender will give you the password separately.",
        "message": "Message",
        "open": "Open",
        "footer": "Sent from {app} at {sender}'s request. If you don't know the sender, don't open the link.",
    },
}


@dataclass
class MailParts:
    subject: str
    text: str
    html: str


def render(link: ShareLink, sender: User, *, message: str | None, lang: str, tz: str | None) -> MailParts:
    """메일 제목·본문(text + html). 비밀번호 원문은 어디에도 없다(해시만 갖고 있기도 하다)."""
    t = _T.get(lang) or _T["ko"]
    who = _one_line(sender.display_name or sender.username)
    sender_label = f"{who} <{sender.email}>" if sender.email else who
    name = _one_line(link.display_name)
    url = link_url(link)
    exp = _fmt_expiry(link.expires_at, tz, lang) or t["never"]
    notes: list[str] = []
    if link.max_downloads == 1:
        notes.append(t["one_time"])
    if link.allow_download is False:
        notes.append(t["no_download"])
    if link.can_edit:
        notes.append(t["editable"])
    if link.password_hash:
        notes.append(t["password"])
    msg = (message or "").strip()
    app = settings.app_name

    lines = [t["lead"].format(sender=sender_label), ""]
    if msg:
        lines += [f"{t['message']}:", msg, ""]
    lines += [f"{t['file']}: {name}", f"{t['expires']}: {exp}"]
    lines += notes
    lines += ["", url, "", "— " + t["footer"].format(app=app, sender=who)]
    text = "\n".join(lines)

    e = html.escape
    note_html = "".join(f'<p style="margin:4px 0;color:#555;">{e(n)}</p>' for n in notes)
    msg_html = (
        f'<p style="margin:12px 0 4px;color:#888;font-size:12px;">{e(t["message"])}</p>'
        f'<blockquote style="margin:0;padding:8px 12px;border-left:3px solid #ddd;white-space:pre-wrap;">{e(msg)}</blockquote>'
        if msg else ""
    )
    html_body = f"""\
<div style="font-family:sans-serif;max-width:560px;color:#1a1a1a;">
  <p>{e(t["lead"].format(sender=sender_label))}</p>
  {msg_html}
  <table style="border-collapse:collapse;margin:16px 0;">
    <tr><td style="padding:4px 12px 4px 0;color:#888;">{e(t["file"])}</td><td style="font-weight:600;">{e(name)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#888;">{e(t["expires"])}</td><td>{e(exp)}</td></tr>
  </table>
  {note_html}
  <p style="margin:16px 0;">
    <a href="{e(url)}" style="display:inline-block;padding:10px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">{e(t["open"])}</a>
  </p>
  <p style="color:#888;font-size:12px;word-break:break-all;">{e(url)}</p>
  <p style="color:#999;font-size:12px;margin-top:24px;">{e(t["footer"].format(app=app, sender=who))}</p>
</div>"""
    subject = t["subject"].format(sender=who, name=name)
    return MailParts(subject=subject[:200], text=text, html=html_body)


def build_message(parts: MailParts, *, from_addr: str, to: str, sender: User) -> MIMEMultipart:
    m = MIMEMultipart("alternative")
    m["Subject"] = parts.subject
    # 보낸 사람은 시스템 주소(SPF/DKIM 통과), 표시 이름에 사용자 이름. 답장은 사용자에게.
    who = _one_line(sender.display_name or sender.username)
    m["From"] = formataddr((f"{who} ({settings.app_name})", from_addr))
    m["To"] = to
    if sender.email and _EMAIL_RE.match(sender.email):
        m["Reply-To"] = sender.email
    m.attach(MIMEText(parts.text, "plain", "utf-8"))
    m.attach(MIMEText(parts.html, "html", "utf-8"))
    return m


async def _deliver(cfg, msg) -> None:
    """실제 발송(시스템 메일). 테스트에서 바꿔 끼운다."""
    from app.admin.settings import send_system_email
    await asyncio.to_thread(send_system_email, cfg, msg)


async def sent_last_hour(db: AsyncSession, user_id: str, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    return int((await db.execute(
        select(func.count()).select_from(ShareLinkEmail).where(
            ShareLinkEmail.sent_by == user_id, ShareLinkEmail.created_at >= now - timedelta(hours=1),
        )
    )).scalar() or 0)


async def classify(db: AsyncSession, emails: list[str]) -> dict[str, tuple[str | None, bool]]:
    """주소 → (워크스페이스 사용자 id, 외부 여부). 사용자 이메일과 같거나 워크스페이스 도메인이면 내부."""
    if not emails:
        return {}
    rows = (await db.execute(
        select(User.id, User.email).where(func.lower(User.email).in_(emails))
    )).all()
    by = {str(e).lower(): uid for uid, e in rows if e}
    domain = (settings.domain or "").lower().strip()
    out: dict[str, tuple[str | None, bool]] = {}
    for e in emails:
        uid = by.get(e)
        internal = uid is not None or (bool(domain) and e.rsplit("@", 1)[-1] == domain)
        out[e] = (uid, not internal)
    return out


def log_entry(r: ShareLinkEmail, names: dict[str, str] | None = None) -> dict:
    return {
        "id": r.id,
        "email": r.recipient,
        "user_id": r.recipient_user_id,
        "external": bool(r.external),
        "ok": bool(r.ok),
        "sent_by": r.sent_by,
        "sent_by_name": (names or {}).get(r.sent_by),
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }
