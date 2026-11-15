"""Calendar event reminder checker — runs periodically to send notifications."""

import logging
from datetime import datetime, timedelta, timezone

from dateutil.rrule import rrulestr

from app.calendar import rrule_guard
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dav.ical_utils import normalize_rrule_for_aware, parse_exdates, strip_rrule_prefix
from app.db.models import CalendarDB, CalendarEventDB
from app.notifications.service import create_notification

logger = logging.getLogger(__name__)


# 시작한 지 이만큼까지는 "아직 알릴 수 있는" 회차로 본다. 검사는 60초마다(main._reminder_loop)라
# "시작 시각"(0분 전) 알림은 start > now 와 start <= now 를 동시에 만족할 수 없어 영영 안 갔다.
START_GRACE = timedelta(minutes=5)


def _aware(dt: datetime) -> datetime:
    # SQLite(테스트)는 시간대 없는 값을 돌려준다 — UTC 로 본다
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _due_occurrence(
    event: CalendarEventDB, now: datetime, moved: list[datetime] | None = None,
) -> datetime | None:
    """리마인더를 보내야 할 occurrence 시작시각 반환 (없으면 None).
    비반복: master start. 반복: (now - 유예) 이후 다음 occurrence를 rrule로 계산.

    moved: "이 일정만" 수정된 회차의 원래 시작(예외 행 recurrence_id) — 그 회차는 예외 행이 자기 시각에
    따로 알리므로 마스터는 건너뛴다(안 그러면 옮기기 전 시각에도 알림이 갔다)."""
    rm = event.reminder_minutes or 0
    floor = now - START_GRACE
    if not event.recurrence_rule:
        start = _aware(event.start)
        remind_at = start - timedelta(minutes=rm)
        if start > floor and remind_at <= now and not event.reminder_sent:
            return event.start
        return None
    # 반복일정 — 유예 창 이후 첫 occurrence
    try:
        rule = rrulestr(
            normalize_rrule_for_aware(strip_rrule_prefix(event.recurrence_rule) or ""),
            dtstart=_aware(event.start), ignoretz=False,
        )
        # 회차 삭제(EXDATE)·단일 수정(RECURRENCE-ID)된 회차는 건너뛴다
        skip = {d.replace(microsecond=0) for d in parse_exdates(event.exdates)}
        skip |= {_aware(d).astimezone(timezone.utc).replace(microsecond=0) for d in (moved or [])}
        last = _aware(event.reminder_last_sent_for) if event.reminder_last_sent_for else None
        # 훑는 횟수 상한(rrule_guard) — 오래된 촘촘한 규칙이 리마인더 루프를 붙잡지 않게
        nxt = rrule_guard.next_after(rule, floor)
        guard = 0
        while nxt is not None and guard < 50:
            if nxt.astimezone(timezone.utc).replace(microsecond=0) in skip:
                pass
            # 이미 알린 회차(유예 창 안에 아직 남아 있는 것)는 지나가고 그다음 회차를 본다
            # last 는 "여기까지 알렸다"는 상한 — 같은 회차만 건너뛰면, 알림 시간이 반복 간격 이상일 때(매일 반복 + 1일 전)
            # 유예 창 안에서 앞 회차와 다음 회차가 번갈아 다시 나간다
            elif last and nxt <= last + timedelta(seconds=60):
                pass
            else:
                break
            nxt = rrule_guard.next_after(rule, nxt)
            guard += 1
        else:
            nxt = None
    except Exception:
        return None
    if not nxt:
        return None
    if event.recurrence_end and nxt > _aware(event.recurrence_end):
        return None
    remind_at = nxt - timedelta(minutes=rm)
    if remind_at > now:
        return None  # 아직 리마인더 시각 전
    return nxt


async def check_and_send_reminders(db: AsyncSession) -> int:
    """리마인더 보낼 일정 검사 → 발송 수 반환. 반복일정은 다음 occurrence 기준."""
    now = datetime.now(timezone.utc)
    sent_count = 0

    result = await db.execute(
        select(CalendarEventDB)
        .where(
            and_(
                CalendarEventDB.reminder_minutes.isnot(None),
                or_(
                    # 비반복: 아직 시작 안 했고 미발송
                    and_(
                        CalendarEventDB.recurrence_rule.is_(None),
                        CalendarEventDB.reminder_sent == False,  # noqa: E712
                        CalendarEventDB.start > now - START_GRACE,
                    ),
                    # 반복: occurrence 계산은 파이썬에서
                    CalendarEventDB.recurrence_rule.isnot(None),
                )
            )
        )
    )
    events = result.scalars().all()

    # 반복 마스터별 "이 일정만" 수정된 회차의 원래 시작
    master_ids = [e.id for e in events if e.recurrence_rule]
    moved: dict[str, list[datetime]] = {}
    for i in range(0, len(master_ids), 1000):
        res = await db.execute(
            select(CalendarEventDB.parent_event_id, CalendarEventDB.recurrence_id).where(
                CalendarEventDB.parent_event_id.in_(master_ids[i:i + 1000]),
                CalendarEventDB.recurrence_id.isnot(None),
            )
        )
        for pid, rid in res.all():
            moved.setdefault(pid, []).append(rid)

    for event in events:
        occ_start = _due_occurrence(event, now, moved.get(event.id))
        if occ_start is None:
            continue

        # Look up calendar to find the owner
        cal = await db.get(CalendarDB, event.calendar_id)
        if not cal:
            continue

        # Format the reminder body
        if event.reminder_minutes == 0:
            time_desc = "지금"
        elif event.reminder_minutes < 60:
            time_desc = f"{event.reminder_minutes}분 후"
        elif event.reminder_minutes == 60:
            time_desc = "1시간 후"
        elif event.reminder_minutes == 1440:
            time_desc = "내일"
        else:
            hours = event.reminder_minutes // 60
            time_desc = f"{hours}시간 후"

        title = f"📅 {event.title}"
        body = f"{time_desc} 시작되는 일정입니다."
        if event.location:
            body += f" 장소: {event.location}"
        # 반복 일정은 그 회차를 가리킨다(마스터 id 면 화면이 시리즈 첫 회차 날짜로 간다) — service.get_event 가 푼다
        if event.recurrence_rule:
            stamp = _aware(occ_start).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S")
            link = f"/calendar?event={event.id}_{stamp}"
        else:
            link = f"/calendar?event={event.id}"

        try:
            await create_notification(
                db=db,
                user_id=cal.user_id,
                type="system",
                title=title,
                body=body,
                link=link,
            )
            if event.recurrence_rule:
                event.reminder_last_sent_for = occ_start
            else:
                event.reminder_sent = True
            sent_count += 1
        except Exception as e:
            logger.error("Failed to send reminder for event %s: %s", event.id, e)

    if sent_count > 0:
        await db.commit()

    return sent_count
