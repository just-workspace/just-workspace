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


# 시작 후 이 시간까지는 "아직 알릴 수 있는" 회차로 간주한다. 검사 주기가 60초(main._reminder_loop)이므로
# "시작 시각"(0분 전) 알림은 start > now 와 start <= now 를 동시에 충족할 수 없어 발송되지 않았다.
START_GRACE = timedelta(minutes=5)


def _aware(dt: datetime) -> datetime:
    # SQLite(테스트)는 시간대 없는 값을 반환 — UTC 로 간주
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _due_occurrence(
    event: CalendarEventDB, now: datetime, moved: list[datetime] | None = None,
) -> datetime | None:
    """리마인더 발송 대상 occurrence 시작 시각 반환(없으면 None).
    비반복: master start. 반복: (now - 유예) 이후 다음 occurrence 를 rrule 로 계산.

    moved: "이 일정만" 수정된 회차의 원래 시작(예외 행 recurrence_id) — 해당 회차는 예외 행이 자체 시각에
    별도로 알리므로 마스터는 건너뜀(건너뛰지 않으면 이동 전 시각에도 알림이 발송됨)."""
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
        # 탐색 횟수 상한(rrule_guard) — 오래되고 조밀한 규칙이 리마인더 루프를 점유하는 것을 방지
        nxt = rrule_guard.next_after(rule, floor)
        guard = 0
        while nxt is not None and guard < 50:
            if nxt.astimezone(timezone.utc).replace(microsecond=0) in skip:
                pass
            # 이미 알린 회차(유예 창 안에 아직 남아 있는 것)는 건너뛰고 그다음 회차를 확인한다.
            # last 는 알림 완료 범위의 상한이다 — 동일 회차만 건너뛰면, 알림 시간이 반복 간격 이상일 때(매일 반복 + 1일 전)
            # 유예 창 안에서 이전 회차와 다음 회차가 번갈아 재발송된다.
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
    """리마인더 발송 대상 일정 검사 → 발송 수 반환. 반복 일정은 다음 occurrence 기준."""
    now = datetime.now(timezone.utc)
    sent_count = 0

    result = await db.execute(
        select(CalendarEventDB)
        .where(
            and_(
                CalendarEventDB.reminder_minutes.isnot(None),
                or_(
                    # 비반복: 시작 전이며 미발송
                    and_(
                        CalendarEventDB.recurrence_rule.is_(None),
                        CalendarEventDB.reminder_sent == False,  # noqa: E712
                        CalendarEventDB.start > now - START_GRACE,
                    ),
                    # 반복: occurrence 계산은 Python 에서 수행
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
        # 반복 일정은 해당 회차를 가리킨다(마스터 id 이면 화면이 시리즈 첫 회차 날짜로 이동) — service.get_event 가 해석한다
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
