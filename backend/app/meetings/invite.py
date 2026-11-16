"""Meeting invitation utilities — ICS generation, invite email, calendar event."""

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders

from app.config import get_settings
from app.calendar import service as calendar_service

logger = logging.getLogger(__name__)
settings = get_settings()


# ─── ICS generation ───


def generate_ics(
    summary: str,
    description: str,
    location: str,
    start: datetime,
    end: datetime,
    organizer_name: str,
    organizer_email: str,
) -> str:
    """Generate an ICS (iCalendar) string for a meeting invitation."""
    uid = f"{uuid.uuid4()}@{settings.domain}"

    def _fmt(dt: datetime) -> str:
        utc = dt.astimezone(timezone.utc)
        return utc.strftime("%Y%m%dT%H%M%SZ")

    now = _fmt(datetime.now(timezone.utc))
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:-//{settings.domain}//Meeting//KO",
        "CALSCALE:GREGORIAN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"DTSTAMP:{now}",
        f"DTSTART:{_fmt(start)}",
        f"DTEND:{_fmt(end)}",
        f"SUMMARY:{summary}",
        f"DESCRIPTION:{description}",
        f"LOCATION:{location}",
        f"ORGANIZER;CN={organizer_name}:mailto:{organizer_email}",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(lines)


# ─── SMTP invite email ───


async def send_invite_email(
    to_email: str,
    meeting_name: str,
    host_name: str,
    join_url: str,
    scheduled_at: datetime,
    duration_minutes: int,
    ics_content: str,
    password: str | None = None,
) -> None:
    """Send a meeting invitation email with ICS attachment."""
    end_time = scheduled_at + timedelta(minutes=duration_minutes)
    # 비밀번호는 평문으로 포함한다(사용자 요청) — 이 메일의 수신자는 입장 권한 보유자이다
    pw_row = (
        f'<tr><td style="padding: 4px 12px 4px 0; color: #888;">비밀번호</td>'
        f'<td style="font-family: monospace; font-weight: 600;">{password}</td></tr>'
        if password else ""
    )
    time_str = scheduled_at.strftime("%Y-%m-%d %H:%M") + " ~ " + end_time.strftime("%H:%M") + " (UTC)"

    html_body = f"""\
<div style="font-family: sans-serif; max-width: 560px;">
  <h2 style="color: #1a1a1a; margin-bottom: 4px;">{meeting_name}</h2>
  <p style="color: #666; margin-top: 0;">회의 초대</p>
  <table style="border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 4px 12px 4px 0; color: #888;">호스트</td><td>{host_name}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #888;">시간</td><td>{time_str}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #888;">시간(분)</td><td>{duration_minutes}분</td></tr>
    {pw_row}
  </table>
  <p>
    <a href="{join_url}"
       style="display: inline-block; padding: 10px 24px; background: #2563eb; color: #fff;
              text-decoration: none; border-radius: 6px; font-weight: 600;">
      회의 참여하기
    </a>
  </p>
  <p style="color: #999; font-size: 12px; margin-top: 24px;">
    이 메일은 {settings.domain} 포털에서 자동 발송되었습니다.
  </p>
</div>"""

    from app.admin.settings import get_smtp_config, send_system_email
    from app.db.session import async_session

    async with async_session() as db:
        cfg = await get_smtp_config(db)

    msg = MIMEMultipart("mixed")
    msg["Subject"] = f"[회의 초대] {meeting_name}"
    msg["From"] = cfg.from_addr
    msg["To"] = to_email

    msg.attach(MIMEText(html_body, "html", "utf-8"))

    # ICS attachment
    ics_part = MIMEBase("text", "calendar", method="REQUEST")
    ics_part.set_payload(ics_content.encode("utf-8"))
    encoders.encode_base64(ics_part)
    ics_part.add_header("Content-Disposition", "attachment", filename="invite.ics")
    msg.attach(ics_part)

    await asyncio.to_thread(send_system_email, cfg, msg)


# ─── Calendar event creation (internal users) ───


async def create_calendar_event(
    meeting_name: str,
    join_url: str,
    scheduled_at: datetime,
    duration_minutes: int,
    username: str | None = None,
    user_id: str | None = None,
) -> str | None:
    """내부 사용자 기본 캘린더에 회의 일정을 생성하고 일정 id 를 반환한다(실패 시 None).

    과거에는 bool 을 반환했다 — id 문자열도 참/거짓 판정은 동일하다. 캘린더 모듈 내부는 변경하지 않고
    calendar_service 공개 함수만 호출한다.
    """
    from sqlalchemy import select
    from app.db.session import async_session
    from app.db.models import User

    async with async_session() as db:
        # Resolve user_id from username if needed
        resolved_user_id = user_id
        if not resolved_user_id and username:
            result = await db.execute(
                select(User.id).where(User.username == username)
            )
            row = result.scalar_one_or_none()
            if not row:
                logger.warning("Cannot create calendar event: user not found: %s", username)
                return None
            resolved_user_id = row

        if not resolved_user_id:
            return None

        # Get first calendar (default)
        calendars = await calendar_service.get_calendars(db, resolved_user_id)
        if not calendars:
            logger.warning("No calendars found for user %s", resolved_user_id)
            return None
        calendar_id = calendars[0]["id"]

        end_dt = scheduled_at + timedelta(minutes=duration_minutes)
        event_data = {
            "calendar_id": calendar_id,
            "title": f"[회의] {meeting_name}",
            "description": f"회의 참여: {join_url}",
            "location": join_url,
            "start": scheduled_at.isoformat(),
            "end": end_dt.isoformat(),
        }
        result = await calendar_service.create_event(db, resolved_user_id, event_data)
        return (result or {}).get("id") if result else None


async def update_calendar_event_time(
    user_id: str, event_id: str, scheduled_at: datetime, duration_minutes: int,
    meeting_name: str | None = None,
) -> bool:
    """회의 시각·제목이 변경되면 호스트 일정도 갱신한다."""
    from app.db.session import async_session

    data = {
        "start": scheduled_at.isoformat(),
        "end": (scheduled_at + timedelta(minutes=duration_minutes)).isoformat(),
    }
    if meeting_name:
        data["title"] = f"[회의] {meeting_name}"
    async with async_session() as db:
        return bool(await calendar_service.update_event(db, user_id, event_id, data))


async def delete_calendar_event(user_id: str, event_id: str) -> bool:
    """시작 전에 취소한 회의의 호스트 일정을 삭제한다."""
    from app.db.session import async_session

    async with async_session() as db:
        return bool(await calendar_service.delete_event(db, user_id, event_id))
