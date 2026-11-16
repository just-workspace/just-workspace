"""Calendar service — PostgreSQL CRUD (replaces JMAP)."""

import re
from datetime import datetime, timedelta, timezone

from dateutil.rrule import rrulestr

from app.calendar import rrule_guard
from sqlalchemy import select, and_, or_, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.dav.ical_utils import (
    dump_exdates,
    events_to_ical,
    get_zone,
    ical_to_event_bundles,
    normalize_rrule_for_aware,
    parse_exdates,
    strip_rrule_prefix,
)
from app.db.models import CalendarDB, CalendarEventAttendee, CalendarEventDB, CalendarShareDB, User


# ─── Calendar CRUD ───


async def get_calendars(db: AsyncSession, user_id: str) -> list[dict]:
    """Get all calendars owned by or shared with the user.
    Auto-creates a default calendar if the user has none.
    """
    # Own calendars
    result = await db.execute(
        select(CalendarDB)
        .where(CalendarDB.user_id == user_id)
        .order_by(CalendarDB.sort_order, CalendarDB.name)
    )
    calendars = []
    for cal in result.scalars().all():
        # 외부 .ics 구독 캘린더는 읽기 전용(app/calendar/subscriptions.py)
        sub = bool(cal.source_url)
        calendars.append({
            "id": cal.id,
            "name": cal.name,
            "color": cal.color,
            "is_visible": cal.is_visible,
            "sort_order": cal.sort_order,
            "is_shared": False,
            "can_write": not sub,
            "is_subscription": sub,
        })

    # Auto-create default calendar if none exist(구독만 있으면 쓰기 가능한 캘린더가 없으므로 이 경우에도 생성)
    if not any(c["can_write"] for c in calendars):
        default = await create_calendar(db, user_id, "내 캘린더", "#3b82f6")
        calendars.append({**default, "is_visible": True, "sort_order": 0,
                          "is_shared": False, "can_write": True})

    # Shared calendars
    # 프런트 사이드바가 "공유받은 캘린더" 묶음·읽기 전용 표시에 사용한다(is_shared·can_write).
    shared_result = await db.execute(
        select(CalendarDB, CalendarShareDB.can_write)
        .join(CalendarShareDB, CalendarShareDB.calendar_id == CalendarDB.id)
        .where(CalendarShareDB.shared_with_user_id == user_id)
        .order_by(CalendarDB.name)
    )
    for cal, can_write in shared_result.all():
        if not any(c["id"] == cal.id for c in calendars):
            calendars.append({
                "id": cal.id,
                "name": cal.name,
                "color": cal.color,
                "is_visible": cal.is_visible,
                "sort_order": cal.sort_order,
                "is_shared": True,
                "can_write": bool(can_write) and not cal.source_url,
                "is_subscription": bool(cal.source_url),
            })

    return calendars


async def create_calendar(
    db: AsyncSession, user_id: str, name: str, color: str | None = None
) -> dict:
    cal = CalendarDB(user_id=user_id, name=name, color=color)
    db.add(cal)
    await db.commit()
    await db.refresh(cal)
    return {"id": cal.id, "name": cal.name, "color": cal.color}


async def update_calendar(
    db: AsyncSession, user_id: str, calendar_id: str, updates: dict
) -> bool:
    cal = await db.get(CalendarDB, calendar_id)
    if not cal or cal.user_id != user_id:
        return False
    if "name" in updates and updates["name"] is not None:
        cal.name = updates["name"]
    if "color" in updates and updates["color"] is not None:
        cal.color = updates["color"]
    if "is_visible" in updates and updates["is_visible"] is not None:
        cal.is_visible = updates["is_visible"]
    await db.commit()
    return True


async def delete_calendar(db: AsyncSession, user_id: str, calendar_id: str) -> bool:
    cal = await db.get(CalendarDB, calendar_id)
    if not cal or cal.user_id != user_id:
        return False
    await db.delete(cal)
    await db.commit()
    return True


# ─── Calendar Sharing ───


async def get_calendar_shares(
    db: AsyncSession, user_id: str, calendar_id: str
) -> list[dict]:
    """Get shares for a calendar. Only owner can see shares."""
    cal = await db.get(CalendarDB, calendar_id)
    if not cal or cal.user_id != user_id:
        return []
    result = await db.execute(
        select(CalendarShareDB, User.email, User.username)
        .join(User, User.id == CalendarShareDB.shared_with_user_id)
        .where(CalendarShareDB.calendar_id == calendar_id)
    )
    shares = []
    for row in result.all():
        share = row[0]
        email = row[1]
        shares.append({
            "email": email or row[2],
            "can_write": share.can_write,
        })
    return shares


async def share_calendar(
    db: AsyncSession, user_id: str, calendar_id: str, shares: list[dict]
) -> bool:
    """Set shares on a calendar. Replace all existing shares."""
    cal = await db.get(CalendarDB, calendar_id)
    if not cal or cal.user_id != user_id:
        return False

    # 대상을 먼저 전부 조회한다 — 과거에는 존재하지 않는 사용자·본인을 무시하고 ok 를 반환하여, 화면에는 공유된 것으로
    # 표시되었다가 창을 다시 열면 사라졌다. 하나라도 찾지 못하면 아무것도 변경하지 않고 ValueError 를 발생시킨다(라우터가 400 응답).
    targets: dict[str, bool] = {}
    for s in shares:
        email = (s.get("email") or "").strip()
        # Look up user by email or username
        user_result = await db.execute(
            select(User).where(
                or_(User.email == email, User.username == email)
            )
        )
        target_user = user_result.scalars().first()
        if not target_user:
            raise ValueError(f"사용자를 찾을 수 없습니다: {email}")
        if target_user.id == user_id:
            raise ValueError("자기 자신에게는 공유할 수 없습니다")
        targets[target_user.id] = bool(s.get("can_write", False))

    # Delete existing shares
    result = await db.execute(
        select(CalendarShareDB).where(CalendarShareDB.calendar_id == calendar_id)
    )
    for share in result.scalars().all():
        await db.delete(share)
    await db.flush()

    # Create new shares
    for target_id, can_write in targets.items():
        db.add(CalendarShareDB(
            calendar_id=calendar_id,
            shared_with_user_id=target_id,
            can_write=can_write,
        ))

    await db.commit()
    return True


async def unshare_calendar(
    db: AsyncSession, user_id: str, calendar_id: str, email: str
) -> bool:
    """Remove a single user from calendar sharing."""
    cal = await db.get(CalendarDB, calendar_id)
    if not cal or cal.user_id != user_id:
        return False

    # Find user by email or username
    user_result = await db.execute(
        select(User).where(or_(User.email == email, User.username == email))
    )
    target_user = user_result.scalar_one_or_none()
    if not target_user:
        return False

    result = await db.execute(
        select(CalendarShareDB).where(
            CalendarShareDB.calendar_id == calendar_id,
            CalendarShareDB.shared_with_user_id == target_user.id,
        )
    )
    share = result.scalar_one_or_none()
    if share:
        await db.delete(share)
        await db.commit()
    return True


# ─── Event CRUD ───

_RESPONSES = {"needs-action", "accepted", "declined", "tentative"}
_OCC_ID_RE = re.compile(r"^(.+)_(\d{8}T\d{6})$")


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def occurrence_stamp(dt: datetime) -> str:
    """회차 id 접미부(UTC). 예: master_20261015T010000"""
    return _utc(dt).strftime("%Y%m%dT%H%M%S")


def split_occurrence_id(event_id: str) -> tuple[str, datetime] | None:
    """'{master}_{YYYYmmddTHHMMSS}' → (master_id, 회차 시작 UTC). 회차 id 가 아니면 None."""
    m = _OCC_ID_RE.match(event_id or "")
    if not m:
        return None
    try:
        occ = datetime.strptime(m.group(2), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return m.group(1), occ


def _same_instant(a: datetime, b: datetime) -> bool:
    return abs((_utc(a) - _utc(b)).total_seconds()) < 1


def _attendee_to_dict(a: CalendarEventAttendee) -> dict:
    return {
        "email": a.email,
        "name": a.name,
        "response": a.response or "needs-action",
        "user_id": a.user_id,
    }


def _event_to_dict(
    event: CalendarEventDB,
    color: str | None = None,
    attendees: list[CalendarEventAttendee] | None = None,
    me: User | None = None,
) -> dict:
    att = [_attendee_to_dict(a) for a in (attendees or [])]
    my_response = None
    if me is not None:
        my_email = (me.email or "").lower()
        for a in attendees or []:
            if (a.user_id and a.user_id == me.id) or (my_email and a.email == my_email):
                my_response = a.response or "needs-action"
                break
    return {
        "id": event.id,
        "calendar_id": event.calendar_id,
        "title": event.title,
        "description": event.description,
        "location": event.location,
        # 시간대 없는 값(SQLite)은 UTC 로 간주 — PostgreSQL 은 본래 aware 이므로 출력 동일
        "start": _utc(event.start).isoformat() if event.start else "",
        "end": _utc(event.end).isoformat() if event.end else "",
        "all_day": event.all_day,
        "color": color,
        "status": event.status,
        "reminder_minutes": event.reminder_minutes,
        "recurrence_rule": event.recurrence_rule,
        "is_recurring": bool(event.recurrence_rule),
        "is_occurrence": False,
        "original_event_id": None,
        "created": event.created_at.isoformat() if event.created_at else None,
        "updated": event.updated_at.isoformat() if event.updated_at else None,
        # ── 추가 필드 ──
        "timezone": event.timezone,
        "meeting_url": event.meeting_url,
        "exdates": [d.isoformat() for d in parse_exdates(event.exdates)],
        "attendees": att,
        "my_response": my_response,
        # 회차 단일 수정 행이면 마스터 id·원래 회차 시작. 프런트는 이 행을 독립 일정과 동일하게
        # 처리한다(PATCH/DELETE 가 회차 예외로 처리한다).
        "parent_event_id": event.parent_event_id,
        "recurrence_id": _utc(event.recurrence_id).isoformat() if event.recurrence_id else None,
        "is_exception": bool(event.parent_event_id),
        "is_invited": False,
    }


def _expand_recurring_event(
    event_dict: dict,
    range_start: datetime,
    range_end: datetime,
    skip: list[datetime] | None = None,
    recurrence_end: datetime | None = None,
) -> list[dict]:
    """Expand a recurring event into individual occurrences within [range_start, range_end].

    - 시간대가 있으면 해당 지역 시각으로 전개한다(서머타임 지역에서 회차 시각 유지).
    - skip: EXDATE + 회차 단일 수정(RECURRENCE-ID)된 회차 — 제외하고 산출한다.
    - recurrence_end: 이 시각 이후 회차는 산출하지 않는다.
    """
    rrule_str = strip_rrule_prefix(event_dict.get("recurrence_rule"))
    if not rrule_str:
        return [event_dict]

    try:
        event_start = datetime.fromisoformat(event_dict["start"])
        event_end = datetime.fromisoformat(event_dict["end"])
    except (ValueError, KeyError):
        return [event_dict]
    if event_start.tzinfo is None:
        event_start = event_start.replace(tzinfo=timezone.utc)
        event_end = event_end.replace(tzinfo=timezone.utc)

    duration = event_end - event_start
    zone = None if event_dict.get("all_day") else get_zone(event_dict.get("timezone"))
    dtstart = event_start.astimezone(zone) if zone else event_start

    # Build the rrule.  dtstart must be set to the event's original start.
    try:
        rule = rrulestr(normalize_rrule_for_aware(rrule_str), dtstart=dtstart, ignoretz=False)
    except (ValueError, KeyError, TypeError):
        return [event_dict]

    # 조회 범위 끝까지 전개한다. 과거에는 "시작 + 2년"에서 중단하여, 2년이 지난 주간 회의·생일이 달력에서 누락되었다.
    # 무한 규칙은 rrule_guard.iter_bounded 의 탐색·회차 상한으로 차단한다.
    max_end = range_end
    skip_set = {occurrence_stamp(d) for d in (skip or [])}

    # Generate occurrences between range_start and max_end
    occurrences: list[dict] = []
    for occ_start in rrule_guard.iter_bounded(rule, range_start - duration, max_end):
        occ_start = _utc(occ_start)
        occ_end = occ_start + duration
        # Skip if completely outside the requested range
        if occ_end < range_start or occ_start > range_end:
            continue
        if recurrence_end and occ_start > _utc(recurrence_end):
            continue
        if occurrence_stamp(occ_start) in skip_set:
            continue

        if _same_instant(occ_start, event_start):
            # This is the master event itself
            occurrences.append(event_dict)
        else:
            occ = {
                **event_dict,
                "id": f"{event_dict['id']}_{occurrence_stamp(occ_start)}",
                "start": occ_start.isoformat(),
                "end": occ_end.isoformat(),
                "is_occurrence": True,
                "original_event_id": event_dict["id"],
            }
            occurrences.append(occ)

    return occurrences


async def load_attendees(db: AsyncSession, event_ids: list[str]) -> dict[str, list[CalendarEventAttendee]]:
    out: dict[str, list[CalendarEventAttendee]] = {}
    if not event_ids:
        return out
    ids = list(event_ids)
    for i in range(0, len(ids), 1000):  # IN 목록이 과도하게 길어지지 않도록 분할
        res = await db.execute(
            select(CalendarEventAttendee)
            .where(CalendarEventAttendee.event_id.in_(ids[i:i + 1000]))
            .order_by(CalendarEventAttendee.created_at, CalendarEventAttendee.email)
        )
        for a in res.scalars().all():
            out.setdefault(a.event_id, []).append(a)
    return out


async def load_overrides(db: AsyncSession, master_ids: list[str]) -> dict[str, list[CalendarEventDB]]:
    out: dict[str, list[CalendarEventDB]] = {}
    if not master_ids:
        return out
    ids = list(master_ids)
    for i in range(0, len(ids), 1000):
        res = await db.execute(
            select(CalendarEventDB)
            .where(CalendarEventDB.parent_event_id.in_(ids[i:i + 1000]))
            .order_by(CalendarEventDB.recurrence_id)
        )
        for e in res.scalars().all():
            out.setdefault(e.parent_event_id, []).append(e)
    return out


async def _collect_events(
    db: AsyncSession,
    cal_ids: list[str] | None,
    range_start: datetime | None,
    range_end: datetime | None,
    color_map: dict,
    me: User | None,
    extra_ids: list[str] | None = None,
) -> list[dict]:
    """캘린더(또는 지정 일정 id)의 일정을 범위로 조회하여 반복을 전개한다."""
    if not cal_ids and not extra_ids:
        return []

    def scope_cond():
        if cal_ids and extra_ids:
            return or_(CalendarEventDB.calendar_id.in_(cal_ids), CalendarEventDB.id.in_(extra_ids))
        if cal_ids:
            return CalendarEventDB.calendar_id.in_(cal_ids)
        return CalendarEventDB.id.in_(extra_ids)

    # --- Query non-recurring events (회차 단일 수정 행 포함) ---
    non_recur_conditions = [
        scope_cond(),
        or_(CalendarEventDB.recurrence_rule == None, CalendarEventDB.recurrence_rule == ""),  # noqa: E711
    ]
    if range_start:
        non_recur_conditions.append(CalendarEventDB.end >= range_start)
    if range_end:
        non_recur_conditions.append(CalendarEventDB.start <= range_end)

    result = await db.execute(
        select(CalendarEventDB)
        .where(and_(*non_recur_conditions))
        .order_by(CalendarEventDB.start)
        .limit(500)
    )
    singles = list(result.scalars().all())

    # --- Query recurring events ---
    # Recurring events may have started long before the view range, so we
    # cannot filter by CalendarEventDB.end >= range_start.  Instead, we
    # only require the event started before the view range ends.
    recur_conditions = [
        scope_cond(),
        CalendarEventDB.recurrence_rule != None,  # noqa: E711
        CalendarEventDB.recurrence_rule != "",
    ]
    if range_end:
        recur_conditions.append(CalendarEventDB.start <= range_end)
    recur_result = await db.execute(
        select(CalendarEventDB)
        .where(and_(*recur_conditions))
        .order_by(CalendarEventDB.start)
        .limit(100)
    )
    masters = list(recur_result.scalars().all())

    att_map = await load_attendees(db, [e.id for e in singles] + [e.id for e in masters])
    # 회차 단일 수정 행의 원래 회차는 전개에서 제외(범위 밖으로 이동된 경우 포함)
    ov_map = await load_overrides(db, [e.id for e in masters]) if masters else {}

    events = [
        _event_to_dict(e, color_map.get(e.calendar_id), att_map.get(e.id), me)
        for e in singles
    ]
    for e in masters:
        d = _event_to_dict(e, color_map.get(e.calendar_id), att_map.get(e.id), me)
        if range_start and range_end:
            skip = parse_exdates(e.exdates) + [
                o.recurrence_id for o in ov_map.get(e.id, []) if o.recurrence_id
            ]
            events.extend(_expand_recurring_event(d, range_start, range_end, skip, e.recurrence_end))
        else:
            # No range — just return master events as-is
            events.append(d)
    return events


async def _invited_event_ids(db: AsyncSession, user: User, response_in: set[str] | None = None) -> list[str]:
    email = (user.email or "").lower()
    conds = [CalendarEventAttendee.user_id == user.id]
    if email:
        conds.append(CalendarEventAttendee.email == email)
    q = select(CalendarEventAttendee.event_id).where(or_(*conds))
    if response_in:
        q = q.where(CalendarEventAttendee.response.in_(list(response_in)))
    res = await db.execute(q)
    return list({r[0] for r in res.all()})


async def get_events(
    db: AsyncSession, user_id: str,
    start: str | None = None, end: str | None = None,
    calendar_id: str | None = None,
    include_invited: bool = False,
) -> list[dict]:
    """Get events for the user's calendars within date range.
    Recurring events are expanded into individual occurrences.

    include_invited=True 이면 본인 캘린더에 없는, 참석자로 초대받은 일정도 포함한다(is_invited=True).
    """
    # Get user's calendar IDs (own + shared)
    calendars = await get_calendars(db, user_id)
    cal_ids = [c["id"] for c in calendars]
    color_map = {c["id"]: c.get("color") for c in calendars}

    if not cal_ids:
        return []
    if calendar_id:
        cal_ids = [c for c in cal_ids if c == calendar_id]
        if not cal_ids:
            return []

    # Parse range boundaries
    range_start: datetime | None = None
    range_end: datetime | None = None
    if start:
        try:
            range_start = _utc(_parse_iso(start))
        except ValueError:
            pass
    if end:
        try:
            range_end = _utc(_parse_iso(end))
        except ValueError:
            pass

    me = await db.get(User, user_id)
    events = await _collect_events(db, cal_ids, range_start, range_end, color_map, me)

    if include_invited and me is not None and not calendar_id:
        inv_ids = await _invited_event_ids(db, me)
        if inv_ids:
            # 본인 캘린더에 이미 있는 일정은 제외
            res = await db.execute(
                select(CalendarEventDB.id).where(
                    CalendarEventDB.id.in_(inv_ids),
                    CalendarEventDB.calendar_id.notin_(cal_ids),
                )
            )
            extra = [r[0] for r in res.all()]
            if extra:
                invited = await _collect_events(db, None, range_start, range_end, {}, me, extra_ids=extra)
                for ev in invited:
                    ev["is_invited"] = True
                events.extend(invited)

    # Sort all events by start time
    events.sort(key=lambda ev: ev.get("start", ""))
    return events


async def _can_write_calendar(db: AsyncSession, user_id: str, cal: CalendarDB | None) -> bool:
    if not cal:
        return False
    if cal.source_url:
        return False  # 외부 .ics 구독은 읽기 전용 — 다음 갱신 시 덮어쓰기됨
    if cal.user_id == user_id:
        return True
    share_result = await db.execute(
        select(CalendarShareDB).where(
            CalendarShareDB.calendar_id == cal.id,
            CalendarShareDB.shared_with_user_id == user_id,
            CalendarShareDB.can_write == True,  # noqa: E712
        )
    )
    return share_result.scalar_one_or_none() is not None


async def _can_read_calendar(db: AsyncSession, user_id: str, cal: CalendarDB | None) -> bool:
    if not cal:
        return False
    if cal.user_id == user_id:
        return True
    res = await db.execute(
        select(CalendarShareDB.id).where(
            CalendarShareDB.calendar_id == cal.id,
            CalendarShareDB.shared_with_user_id == user_id,
        )
    )
    return res.first() is not None


async def _is_attendee(db: AsyncSession, user: User, event_id: str) -> bool:
    email = (user.email or "").lower()
    conds = [CalendarEventAttendee.user_id == user.id]
    if email:
        conds.append(CalendarEventAttendee.email == email)
    res = await db.execute(
        select(CalendarEventAttendee.id).where(
            CalendarEventAttendee.event_id == event_id, or_(*conds)
        )
    )
    return res.first() is not None


async def get_event(db: AsyncSession, user_id: str, event_id: str) -> dict | None:
    event = await db.get(CalendarEventDB, event_id)
    # 회차 id('{마스터}_{YYYYmmddTHHMMSS}') — 반복 일정 알림 링크가 해당 회차를 가리킨다. 마스터를 반환하면
    # 화면이 시리즈 첫 회차(수년 전) 날짜로 이동했다. 해당 회차가 "이 일정만" 수정된 예외 행이면 그 행을 반환한다.
    occ_start: datetime | None = None
    if not event:
        split = split_occurrence_id(event_id)
        if not split:
            return None
        master = await db.get(CalendarEventDB, split[0])
        if not master or not master.recurrence_rule:
            return None
        res = await db.execute(
            select(CalendarEventDB).where(CalendarEventDB.parent_event_id == master.id)
        )
        override = next((o for o in res.scalars().all()
                         if o.recurrence_id and _same_instant(o.recurrence_id, split[1])), None)
        if override is not None:
            event = override
        else:
            event = master
            if not _same_instant(master.start, split[1]):
                occ_start = split[1]
    # Verify the user has access
    calendars = await get_calendars(db, user_id)
    cal_ids = {c["id"] for c in calendars}
    me = await db.get(User, user_id)
    invited = False
    if event.calendar_id not in cal_ids:
        # 참석자로 초대받은 일정은 조회 가능
        if me is None or not await _is_attendee(db, me, event.parent_event_id or event.id):
            return None
        invited = True
    color_map = {c["id"]: c.get("color") for c in calendars}
    att = (await load_attendees(db, [event.id])).get(event.id)
    d = _event_to_dict(event, color_map.get(event.calendar_id), att, me)
    d["is_invited"] = invited
    if occ_start is not None:
        duration = _utc(event.end) - _utc(event.start)
        d.update({
            "id": f"{event.id}_{occurrence_stamp(occ_start)}",
            "start": occ_start.isoformat(),
            "end": (occ_start + duration).isoformat(),
            "is_occurrence": True,
            "original_event_id": event.id,
        })
    return d


def _validate_timezone(tz: str | None) -> str | None:
    if tz is None or tz == "":
        return None
    if get_zone(tz) is None:
        raise ValueError(f"알 수 없는 시간대: {tz}")
    return tz


async def _set_attendees(
    db: AsyncSession,
    event: CalendarEventDB,
    attendees: list[dict],
    actor_id: str | None = None,
    notify: bool = True,
) -> list[str]:
    """참석자 목록을 전체 교체한다. 동일 이메일의 기존 응답은 유지한다(요청에 response 가 있으면 해당 값 적용).

    신규 추가된 워크스페이스 사용자 id 를 반환한다(본인 제외) — notify=False 로 호출한 측이 커밋 후
    _notify_invites 로 알릴 수 있도록 한다(알림 생성은 그 내부에서 커밋한다)."""
    res = await db.execute(
        select(CalendarEventAttendee).where(CalendarEventAttendee.event_id == event.id)
    )
    existing = {a.email: a for a in res.scalars().all()}
    wanted: dict[str, dict] = {}
    for a in attendees or []:
        email = str(a.get("email") or "").strip().lower()
        if not email or "@" not in email or len(email) > 255:
            continue
        wanted[email] = a

    for email, row in existing.items():
        if email not in wanted:
            await db.delete(row)

    new_user_ids: list[str] = []
    if wanted:
        ures = await db.execute(select(User).where(func.lower(User.email).in_(list(wanted))))
        users = {(u.email or "").lower(): u for u in ures.scalars().all()}
    else:
        users = {}
    for email, a in wanted.items():
        row = existing.get(email)
        resp = a.get("response")
        if resp is not None and resp not in _RESPONSES:
            resp = None
        u = users.get(email)
        if row is None:
            row = CalendarEventAttendee(
                event_id=event.id,
                email=email,
                name=(a.get("name") or (u.display_name if u else None)),
                user_id=u.id if u else None,
                response=resp or "needs-action",
            )
            db.add(row)
            if u and u.id != actor_id:
                new_user_ids.append(u.id)
        else:
            if a.get("name"):
                row.name = a["name"]
            if u and not row.user_id:
                row.user_id = u.id
            if resp:
                row.response = resp
    await db.flush()

    if notify:
        await _notify_invites(db, event, new_user_ids)
    return new_user_ids


async def _notify_invites(db: AsyncSession, event: CalendarEventDB, user_ids: list[str]) -> None:
    """신규 참석자에게 초대 알림. create_notification 이 커밋하므로 단일 트랜잭션이어야 하는 작업이 끝난 뒤 호출한다."""
    if not user_ids:
        return
    try:
        from app.notifications.service import create_notification
        when = event.start.isoformat() if event.start else ""
        for uid in user_ids:
            await create_notification(
                db, uid, "calendar_invite",
                f"일정 초대: {event.title}", when,
                link=f"/calendar?event={event.id}",
            )
    except Exception:
        pass


def _apply_fields(event: CalendarEventDB, data: dict) -> None:
    """EventCreate/EventUpdate 공통 필드 반영(캘린더 이동·참석자 제외)."""
    if "title" in data and data["title"] is not None:
        event.title = data["title"]
    if "description" in data:
        event.description = data.get("description") or ""
    if "location" in data:
        event.location = data.get("location") or None
    if "start" in data and data["start"] is not None:
        event.start = _parse_iso(data["start"])
    if "end" in data and data["end"] is not None:
        event.end = _parse_iso(data["end"])
    if "all_day" in data and data["all_day"] is not None:
        event.all_day = data["all_day"]
    if "reminder_minutes" in data:
        event.reminder_minutes = data.get("reminder_minutes")
        # Reset reminder_sent when reminder settings change
        event.reminder_sent = False
    if "recurrence_rule" in data:
        event.recurrence_rule = rrule_guard.check_rrule(data.get("recurrence_rule"))
    if "recurrence_end" in data:
        val = data.get("recurrence_end")
        event.recurrence_end = _parse_iso(val) if val else None
    if "timezone" in data:
        event.timezone = _validate_timezone(data.get("timezone"))
    if "meeting_url" in data:
        event.meeting_url = (data.get("meeting_url") or None)
    if "status" in data and data["status"]:
        event.status = data["status"]
    if "exdates" in data and data["exdates"] is not None:
        dts = []
        for s in data["exdates"]:
            try:
                dts.append(_parse_iso(s))
            except (ValueError, TypeError):
                continue
        event.exdates = dump_exdates(dts)


def _touch(event: CalendarEventDB) -> None:
    # CalDAV ETag·ctag 가 변경되어야 휴대폰이 재수신함
    event.updated_at = datetime.now(timezone.utc)


async def create_event(db: AsyncSession, user_id: str, data: dict) -> dict | None:
    # Verify calendar belongs to user
    cal = await db.get(CalendarDB, data["calendar_id"])
    if not cal:
        return None
    # Allow if owner or has write access
    if not await _can_write_calendar(db, user_id, cal):
        return None

    start_dt = _parse_iso(data["start"])
    end_dt = _parse_iso(data["end"])

    recurrence_end = None
    if data.get("recurrence_end"):
        recurrence_end = _parse_iso(data["recurrence_end"])

    event = CalendarEventDB(
        calendar_id=data["calendar_id"],
        title=data.get("title", ""),
        description=data.get("description"),
        location=data.get("location") or None,
        start=start_dt,
        end=end_dt,
        all_day=data.get("all_day", False),
        reminder_minutes=data.get("reminder_minutes"),
        recurrence_rule=rrule_guard.check_rrule(data.get("recurrence_rule")),
        recurrence_end=recurrence_end,
        timezone=_validate_timezone(data.get("timezone")),
        meeting_url=data.get("meeting_url") or None,
    )
    db.add(event)
    await db.flush()
    if data.get("attendees"):
        await _set_attendees(db, event, data["attendees"], actor_id=user_id)
    await db.commit()
    await db.refresh(event)
    att = (await load_attendees(db, [event.id])).get(event.id)
    me = await db.get(User, user_id)
    return _event_to_dict(event, cal.color, att, me)


async def _load_writable(db: AsyncSession, user_id: str, event_id: str) -> CalendarEventDB | None:
    event = await db.get(CalendarEventDB, event_id)
    if not event:
        return None
    cal = await db.get(CalendarDB, event.calendar_id)
    if not await _can_write_calendar(db, user_id, cal):
        return None
    return event


async def update_event(
    db: AsyncSession, user_id: str, event_id: str, data: dict
) -> bool:
    event = await _load_writable(db, user_id, event_id)
    if not event:
        return False

    # 폼은 캘린더를 변경하지 않아도 calendar_id 를 항상 전송한다 — 동일 값이면 이동이 아니다. 과거에는 "본인 소유"만
    # 허용하여, 쓰기 권한으로 공유받은 캘린더의 일정은 제목만 수정해도 404 가 반환되었다.
    if data.get("calendar_id") is not None and data["calendar_id"] != event.calendar_id:
        # IDOR 방지 — 이동 대상은 본인이 쓰기 가능한 캘린더(소유 또는 쓰기 공유, 구독 제외)여야 함
        new_cal = await db.get(CalendarDB, data["calendar_id"])
        if not await _can_write_calendar(db, user_id, new_cal):
            return False
        event.calendar_id = data["calendar_id"]
    old_start = event.start
    _apply_fields(event, data)
    # 반복 마스터의 시각을 이동하면("모든 일정" 시간 변경) 삭제된 회차(EXDATE)·예외 회차(RECURRENCE-ID)도
    # 동일한 간격만큼 이동한다. 이동하지 않으면 이전 시각을 가리켜 삭제된 회차가 새 시각에 복원되고, 예외 회차는
    # 원래 회차와 중복 표시되었다. 프런트가 exdates 를 직접 전송한 경우 해당 값을 그대로 사용한다.
    if (event.recurrence_rule and not event.parent_event_id and old_start is not None
            and event.start is not None and "exdates" not in data):
        delta = _utc(event.start) - _utc(old_start)
        if delta:
            exd = parse_exdates(event.exdates)
            if exd:
                event.exdates = dump_exdates([d + delta for d in exd])
            children = (await db.execute(
                select(CalendarEventDB).where(CalendarEventDB.parent_event_id == event.id)
            )).scalars().all()
            for ch in children:
                if ch.recurrence_id is not None:
                    ch.recurrence_id = _utc(ch.recurrence_id) + delta
                    _touch(ch)
    if data.get("attendees") is not None:
        await _set_attendees(db, event, data["attendees"], actor_id=user_id)
    if event.parent_event_id:
        master = await db.get(CalendarEventDB, event.parent_event_id)
        if master:
            _touch(master)
    _touch(event)
    await db.commit()
    return True


async def update_occurrence(
    db: AsyncSession, user_id: str, master_id: str, occ_start: datetime, data: dict
) -> str | None:
    """반복 일정의 한 회차만 수정(RECURRENCE-ID). 회차 예외 행 id 반환, 권한 없으면 None."""
    master = await _load_writable(db, user_id, master_id)
    if not master or not master.recurrence_rule:
        return None
    occ_start = _utc(occ_start)
    res = await db.execute(
        select(CalendarEventDB).where(CalendarEventDB.parent_event_id == master.id)
    )
    row = next((o for o in res.scalars().all()
                if o.recurrence_id and _same_instant(o.recurrence_id, occ_start)), None)
    if row is None:
        duration = master.end - master.start
        row = CalendarEventDB(
            calendar_id=master.calendar_id,
            title=master.title,
            description=master.description,
            location=master.location,
            start=occ_start,
            end=occ_start + duration,
            all_day=master.all_day,
            status=master.status,
            reminder_minutes=master.reminder_minutes,
            timezone=master.timezone,
            meeting_url=master.meeting_url,
            parent_event_id=master.id,
            recurrence_id=occ_start,
        )
        db.add(row)
        await db.flush()
        # 회차 예외도 마스터의 참석자(응답 포함)를 그대로 보유한다 — 그렇지 않으면 초대받은 사용자의 목록에서
        # 해당 회차가 누락되고(예외 행은 참석자 행으로만 조회된다), 재전송된 참석자는 "새 초대"로 간주되어 알림이 재발송된다.
        res_att = await db.execute(
            select(CalendarEventAttendee).where(CalendarEventAttendee.event_id == master.id)
        )
        for a in res_att.scalars().all():
            db.add(CalendarEventAttendee(
                event_id=row.id, email=a.email, name=a.name, user_id=a.user_id,
                response=a.response or "needs-action",
            ))
        await db.flush()
    # 회차 예외는 반복·캘린더 이동을 포함하지 않음
    data = {k: v for k, v in data.items() if k not in ("recurrence_rule", "recurrence_end", "exdates", "calendar_id")}
    _apply_fields(row, data)
    if data.get("attendees") is not None:
        await _set_attendees(db, row, data["attendees"], actor_id=user_id)
    _touch(row)
    _touch(master)
    await db.commit()
    return row.id


async def delete_occurrence(
    db: AsyncSession, user_id: str, master_id: str, occ_start: datetime
) -> bool:
    """반복 일정의 한 회차만 삭제 → 마스터 EXDATE 에 추가(회차 예외 행이 있으면 삭제)."""
    master = await _load_writable(db, user_id, master_id)
    if not master or not master.recurrence_rule:
        return False
    occ_start = _utc(occ_start)
    exd = parse_exdates(master.exdates)
    if not any(_same_instant(d, occ_start) for d in exd):
        exd.append(occ_start)
    master.exdates = dump_exdates(exd)
    res = await db.execute(
        select(CalendarEventDB).where(CalendarEventDB.parent_event_id == master.id)
    )
    for o in res.scalars().all():
        if o.recurrence_id and _same_instant(o.recurrence_id, occ_start):
            await _delete_rows(db, [o])
    _touch(master)
    await db.commit()
    return True


async def _delete_rows(db: AsyncSession, rows: list[CalendarEventDB]) -> None:
    ids = [r.id for r in rows]
    if ids:
        await db.execute(delete(CalendarEventAttendee).where(CalendarEventAttendee.event_id.in_(ids)))
    for r in rows:
        await db.delete(r)


async def delete_event(db: AsyncSession, user_id: str, event_id: str) -> bool:
    event = await _load_writable(db, user_id, event_id)
    if not event:
        return False
    if event.parent_event_id:
        # 회차 예외 행을 삭제할 때 해당 회차가 원래대로 복원되어서는 안 됨 → EXDATE 로 기록
        master = await db.get(CalendarEventDB, event.parent_event_id)
        if master and event.recurrence_id:
            exd = parse_exdates(master.exdates)
            exd.append(event.recurrence_id)
            master.exdates = dump_exdates(exd)
            _touch(master)
        await _delete_rows(db, [event])
    else:
        res = await db.execute(
            select(CalendarEventDB).where(CalendarEventDB.parent_event_id == event.id)
        )
        await _delete_rows(db, list(res.scalars().all()) + [event])
    await db.commit()
    return True


def rrule_until_before(rule: str, occ_start: datetime) -> str:
    """반복 규칙을 해당 회차 직전(1초 전)에서 종료한다 — UNTIL/COUNT 를 교체한다(프런트 rruleUntilBefore 와 동일 규칙)."""
    until = _utc(occ_start) - timedelta(seconds=1)
    parts = [p.strip() for p in (strip_rrule_prefix(rule) or "").split(";") if p.strip()]
    parts = [p for p in parts if not re.match(r"^(UNTIL|COUNT)=", p, re.I)]
    parts.append("UNTIL=" + until.strftime("%Y%m%dT%H%M%SZ"))
    return ";".join(parts)


async def delete_following(
    db: AsyncSession, user_id: str, master_id: str, occ_start: datetime
) -> bool:
    """반복 일정을 해당 회차부터 끝까지 삭제한다(분할 삭제).

    - 첫 회차(마스터 시작)부터이면 시리즈 전체 삭제와 동일하다.
    - 그 외에는 마스터 규칙을 해당 회차 직전에서 종료하고(UNTIL·recurrence_end), 해당 회차 이후의 회차 예외 행과
      EXDATE 를 정리한다 — 예외 행이 남으면 종료 이후에도 해당 회차만 표시된다.
    """
    master = await _load_writable(db, user_id, master_id)
    if not master or not master.recurrence_rule:
        return False
    occ_start = _utc(occ_start)
    if occ_start <= _utc(master.start):
        return await delete_event(db, user_id, master.id)
    master.recurrence_rule = rrule_until_before(master.recurrence_rule, occ_start)
    master.recurrence_end = occ_start - timedelta(seconds=1)
    master.exdates = dump_exdates([d for d in parse_exdates(master.exdates) if d < occ_start])
    res = await db.execute(
        select(CalendarEventDB).where(CalendarEventDB.parent_event_id == master.id)
    )
    gone = [o for o in res.scalars().all() if o.recurrence_id and _utc(o.recurrence_id) >= occ_start]
    await _delete_rows(db, gone)
    _touch(master)
    await db.commit()
    return True


def _series_rule(rule: str | None, start: datetime, all_day: bool, tz: str | None):
    """반복 규칙을 해당 일정의 시작·시간대로 해석한 rrule(전개 _expand_recurring_event 와 동일 기준). 해석 불가 시 None."""
    rrule_str = strip_rrule_prefix(rule)
    if not rrule_str:
        return None
    zone = None if all_day else get_zone(tz)
    dtstart = _utc(start).astimezone(zone) if zone else _utc(start)
    try:
        return rrulestr(normalize_rrule_for_aware(rrule_str), dtstart=dtstart, ignoretz=False)
    except (ValueError, KeyError, TypeError):
        return None


def _same_local_day(a: datetime, b: datetime, all_day: bool, tz: str | None) -> bool:
    """두 시각이 해당 일정 기준으로 같은 날인지 판정한다. 종일은 12시간 이내, 시간대 불명이면 24시간 이내로 간주한다."""
    if all_day:
        return abs(_utc(a) - _utc(b)) < timedelta(hours=12)
    zone = get_zone(tz)
    if zone is None:
        return abs(_utc(a) - _utc(b)) < timedelta(hours=24)
    return _utc(a).astimezone(zone).date() == _utc(b).astimezone(zone).date()


# 분할 시 보존한 예외 회차에서 "따로 고친 적 없는 칸"은 새 시리즈 값을 따른다 — 필드별 수정 기록이 없으므로
# 기존 마스터와 값이 같으면 수정하지 않은 것으로 간주한다.
_FOLLOW_FIELDS = ("title", "description", "location", "meeting_url", "reminder_minutes",
                  "timezone", "all_day", "status")


async def update_following(
    db: AsyncSession, user_id: str, master_id: str, occ_start: datetime, data: dict
) -> str | None:
    """반복 일정을 해당 회차부터 끝까지 수정(분할 수정) — 단일 트랜잭션. 새 시리즈 id 반환, 권한 없으면 None.

    기존 시리즈는 해당 회차 직전에서 종료하고(UNTIL·recurrence_end), 해당 회차부터는 data 를 반영한 새 시리즈를 생성한다.
    과거에는 프런트가 여러 요청(종료 → 신규 생성 → 예외 행 삭제 → EXDATE 이전)으로 나누어 처리하여, 중간에
    실패하면 부분 적용 상태가 남았고 이후 구간의 "이 일정만" 수정은 전부 소실되었다.

    이후 구간(해당 회차 포함)에 남아 있던 항목:
    - 삭제된 회차(EXDATE): 새 시각만큼 이동하여 새 시리즈에서도 삭제 상태로 유지한다.
    - 시간대가 변경되는 분할(시간대 없던 일정에 폼이 시간대를 채워 전송하는 경우 포함)은 서머타임 이후 회차가
      "옛 시각 + 옮긴 시간"과 약 1시간 어긋난다 → 새 시리즈를 실제로 전개하여 가장 가까운 회차에 맞춘다.
    - 기존 시리즈에 남는 회차가 하나도 없으면(시작일이 규칙에 맞지 않던 시리즈의 첫 회차에서 분할한 경우) 기존 마스터는
      삭제하고 새 시리즈만 유지한다(UID 는 승계한다) — 그렇지 않으면 회차 0개인 빈 마스터가 남는다.
    - "이 일정만" 수정 행: 새 시리즈의 예외로 이전한다(원래 회차 = 기존 원래 회차 + 이동 시간). 단, 이번 수정이
      날짜를 이동했거나(요일 변경 등) 규칙이 변경되어 해당 회차가 새 시리즈에 없으면 폐기한다. 시각을 별도로 이동한 적
      없는 예외는 새 시각을 따르고, 별도로 수정한 적 없는 필드(_FOLLOW_FIELDS)는 새 값을 따른다.
    - 횟수(COUNT) 반복: 규칙을 그대로 전송한 경우 새 시리즈는 잔여 회차만 포함한다(5회 → 2 + 5 가 되지 않도록 함).
    - 참석자: 기존 시리즈의 응답을 그대로 승계하며, 이번에 신규 추가된 참석자에게만 초대 알림을 발송한다
      (알림은 커밋을 유발하므로 전부 저장한 뒤 발송한다 — 중간 커밋이 발생하면 단일 트랜잭션이 유지되지 않는다).
    첫 회차(마스터 시작)부터이면 시리즈 전체 수정과 동일하다.
    """
    master = await _load_writable(db, user_id, master_id)
    if not master or not master.recurrence_rule or master.parent_event_id:
        return None
    occ_start = _utc(occ_start)
    if occ_start <= _utc(master.start):
        return master.id if await update_event(db, user_id, master.id, data) else None

    calendar_id = master.calendar_id
    if data.get("calendar_id") is not None and data["calendar_id"] != master.calendar_id:
        new_cal = await db.get(CalendarDB, data["calendar_id"])
        if not await _can_write_calendar(db, user_id, new_cal):
            return None
        calendar_id = data["calendar_id"]

    old_rule = strip_rrule_prefix(master.recurrence_rule)
    old_duration = _utc(master.end) - _utc(master.start)

    # 새 시리즈 = 기존 마스터 사본 + 이번 수정. 검증(반복 규칙·시간대)에 실패하면 변경 적용 전에 종료한다.
    new = CalendarEventDB(
        calendar_id=calendar_id,
        title=master.title,
        description=master.description,
        location=master.location,
        start=occ_start,
        end=occ_start + old_duration,
        all_day=master.all_day,
        status=master.status,
        reminder_minutes=master.reminder_minutes,
        recurrence_rule=old_rule,
        recurrence_end=master.recurrence_end,
        timezone=master.timezone,
        meeting_url=master.meeting_url,
    )
    _apply_fields(new, {k: v for k, v in data.items() if k not in ("exdates", "calendar_id", "attendees")})
    new.reminder_sent = False
    new_start = _utc(new.start)
    if "end" not in data or data.get("end") is None:
        new.end = new_start + old_duration
    delta = new_start - occ_start

    # 횟수 반복: 기존 규칙의 COUNT 를 그대로 가져온 경우 앞 시리즈가 소진한 회차 수만큼 차감(삭제된 회차도 COUNT 에 포함)
    old_series = _series_rule(old_rule, master.start, master.all_day, master.timezone)
    before = 0
    if old_series is not None:
        before = sum(1 for _ in rrule_guard.iter_bounded(
            old_series, _utc(master.start), occ_start - timedelta(seconds=1), max_occ=rrule_guard.MAX_SCAN))
    # 기존 시리즈에 남는 회차 없음 → 기존 마스터는 빈 마스터가 되므로 삭제(아래)
    drop_master = old_series is not None and before == 0
    m_old = re.search(r"(?:^|;)COUNT=(\d+)", old_rule or "", re.I)
    m_new = re.search(r"(?:^|;)COUNT=(\d+)", new.recurrence_rule or "", re.I)
    if m_old and m_new and m_old.group(1) == m_new.group(1):
        left = int(m_old.group(1)) - before
        new.recurrence_rule = (
            re.sub(r"COUNT=\d+", f"COUNT={left}", new.recurrence_rule, flags=re.I) if left > 0 else None
        )

    later_exdates = [d for d in parse_exdates(master.exdates) if d >= occ_start]
    res = await db.execute(
        select(CalendarEventDB).where(CalendarEventDB.parent_event_id == master.id)
    )
    all_rows = list(res.scalars().all())
    later_rows = [o for o in all_rows if o.recurrence_id and _utc(o.recurrence_id) >= occ_start]

    # 기존 회차 → 새 시리즈의 대응 회차. 기본적으로 "옛 시각 + 옮긴 시간"이 새 시리즈에 그대로 존재해야 한다.
    # 전개 기준 시간대가 변경되면 서머타임 이후 회차가 해당 값과 어긋나므로, 그 경우에만 가장 가까운 회차(2시간 이내)에 맞춘다.
    old_zone = None if master.all_day else get_zone(master.timezone)
    new_zone = None if new.all_day else get_zone(new.timezone)
    fuzzy = timedelta(hours=2) if str(old_zone) != str(new_zone) else timedelta(0)
    wanted = [_utc(o.recurrence_id) + delta for o in later_rows] + [d + delta for d in later_exdates]
    new_occs: list[datetime] = []
    new_series = _series_rule(new.recurrence_rule, new.start, new.all_day, new.timezone)
    if new_series is not None and wanted:
        for occ in rrule_guard.iter_bounded(
                new_series, new_start, max(wanted) + fuzzy, max_occ=rrule_guard.MAX_SCAN):
            if new.recurrence_end and _utc(occ) > _utc(new.recurrence_end):
                break
            new_occs.append(_utc(occ))

    def _match(cand: datetime) -> datetime | None:
        best = min(new_occs, key=lambda x: abs(x - cand), default=None)
        if best is None or abs(best - cand) > max(fuzzy, timedelta(seconds=1)):
            return None
        return best

    targets = {o.id: _match(_utc(o.recurrence_id) + delta) for o in later_rows}

    # ── 여기부터 변경 적용 ──
    db.add(new)
    await db.flush()

    if drop_master:
        # 캘린더 앱(CalDAV)에서 동일 일정의 변경으로 인식되도록 UID 를 승계
        new.ical_uid = master.ical_uid or master.id
    else:
        master.recurrence_rule = rrule_until_before(master.recurrence_rule, occ_start)
        master.recurrence_end = occ_start - timedelta(seconds=1)
        master.exdates = dump_exdates([d for d in parse_exdates(master.exdates) if d < occ_start])

    if new.recurrence_rule:
        # 대응 회차를 찾지 못한 항목은 이동한 값 그대로 유지(존재하지 않는 회차를 가리켜도 무해하며, 삭제된 회차가 복원되는 것보다 낫다)
        new.exdates = dump_exdates([_match(d + delta) or (d + delta) for d in later_exdates])
        # 직전에 기존 시리즈가 알린 회차를 새 시리즈가 중복 알림하지 않도록 함(시각·알림 설정이 동일한 경우에만)
        if (not delta and master.reminder_last_sent_for is not None
                and new.reminder_minutes == master.reminder_minutes
                and _utc(master.reminder_last_sent_for) >= occ_start):
            new.reminder_last_sent_for = master.reminder_last_sent_for

    # 참석자: 응답까지 그대로 승계 → 이후 목록이 변경된 경우 신규 추가된 참석자에게만 알림
    res_att = await db.execute(
        select(CalendarEventAttendee).where(CalendarEventAttendee.event_id == master.id)
    )
    for a in res_att.scalars().all():
        db.add(CalendarEventAttendee(
            event_id=new.id, email=a.email, name=a.name, user_id=a.user_id,
            response=a.response or "needs-action", responded_at=a.responded_at,
        ))
    await db.flush()
    invited: list[str] = []
    if data.get("attendees") is not None:
        invited = await _set_attendees(db, new, data["attendees"], actor_id=user_id, notify=False)

    gone: list[CalendarEventDB] = []
    for o in later_rows:
        rid = _utc(o.recurrence_id)
        target = targets[o.id]
        # 해당 회차 자체의 예외 행은 이번 수정이 해당 회차를 새로 정의하므로 흡수
        if (_same_instant(rid, occ_start) or target is None
                or not _same_local_day(rid, target, new.all_day, new.timezone)):
            gone.append(o)
            continue
        if _same_instant(o.start, rid):
            # 시각을 별도로 이동한 적 없는 예외 — 새 시각을 따름(길이도 변경하지 않았으면 새 길이 적용)
            o_duration = _utc(o.end) - _utc(o.start)
            o.start = target
            o.end = target + (_utc(new.end) - new_start if o_duration == old_duration else o_duration)
        for f in _FOLLOW_FIELDS:
            # "" 와 None 은 동일한 빈 값(설명·장소). 0(시작 시각 알림)·False 는 유효 값이므로 그대로 비교
            ov, mv = getattr(o, f), getattr(master, f)
            if (None if ov == "" else ov) == (None if mv == "" else mv) and ov != getattr(new, f):
                setattr(o, f, getattr(new, f))
                if f == "reminder_minutes":
                    o.reminder_sent = False
        o.parent_event_id = new.id
        o.recurrence_id = target
        o.calendar_id = new.calendar_id
        _touch(o)
    if drop_master:
        # 남는 회차가 없으므로 앞쪽 예외 행도 가리킬 회차가 없음 — 마스터와 함께 삭제
        gone = [o for o in all_rows if o.parent_event_id == master.id] + [master]
    await _delete_rows(db, gone)

    if not drop_master:
        _touch(master)
    _touch(new)
    new_id = new.id
    await db.commit()
    # 초대 알림은 이 시점에 발송 — create_notification 이 커밋하므로 위 변경이 전부 저장된 이후여야 함
    if invited:
        await db.refresh(new)  # 커밋으로 만료된 값을 재조회(알림 문구에 제목·시작 포함)
        await _notify_invites(db, new, invited)
    return new_id


async def cancellation_targets(
    db: AsyncSession, actor: User, event_id: str
) -> tuple[CalendarEventDB | None, list[CalendarEventAttendee]]:
    """취소 알림을 받을 참석자(본인 제외) — 삭제 전에 호출한다. 회차 예외 행이면 해당 행의 참석자."""
    event = await db.get(CalendarEventDB, event_id)
    if not event:
        return None, []
    res = await db.execute(
        select(CalendarEventAttendee).where(CalendarEventAttendee.event_id == event.id)
    )
    me = (actor.email or "").lower()
    out = [a for a in res.scalars().all()
           if not ((a.user_id and a.user_id == actor.id) or (me and a.email == me))]
    return event, out


async def notify_cancellation(
    db: AsyncSession,
    actor: User,
    event: CalendarEventDB,
    attendees: list[CalendarEventAttendee],
    scope: str,
    occ_start: datetime | None = None,
) -> int:
    """참석자에게 취소 알림 — 내부 사용자는 인앱 알림, 전체 대상 취소 메일(METHOD:CANCEL .ics)은 후속 처리로 발송한다.

    알림·메일 실패는 삭제를 차단하지 않는다(삭제는 이미 완료된 상태). 알림 대상자 수를 반환한다.
    """
    if not attendees:
        return 0
    when_dt = _utc(occ_start or event.start)
    scope_label = {"this": "이 일정", "following": "이 일정과 이후 모두", "all": "반복 전체"}.get(scope, "")
    title = f"일정 취소: {event.title}"
    body = when_dt.isoformat() + (f" · {scope_label}" if event.recurrence_rule and scope_label else "")
    try:
        from app.notifications.service import create_notification
        for a in attendees:
            if a.user_id:
                await create_notification(
                    db, a.user_id, "calendar_invite", title, body,
                    link="/calendar", actor_id=actor.id, actor_name=actor.display_name or actor.username,
                )
    except Exception:
        pass
    emails = [a.email for a in attendees if a.email]
    if emails:
        import asyncio
        asyncio.create_task(_send_cancel_mails(
            emails, event.title, when_dt, event.end and _utc(event.end), event.ical_uid or event.id,
            actor.display_name or actor.username, actor.email or "", scope, occ_start,
        ))
    return len(attendees)


def cancel_ics(uid: str, title: str, start: datetime, end: datetime | None, organizer_name: str,
               organizer_email: str, emails: list[str], recurrence_id: datetime | None = None,
               whole_series: bool = True) -> str:
    """iTIP CANCEL — 수신 측 메일 앱이 일정을 삭제한다. 단일 회차이면 RECURRENCE-ID 를 포함한다."""
    def _fmt(dt: datetime) -> str:
        return _utc(dt).strftime("%Y%m%dT%H%M%SZ")

    now = _fmt(datetime.now(timezone.utc))
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//just-workspace//Calendar//KO", "METHOD:CANCEL",
        "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{now}", f"DTSTART:{_fmt(start)}",
    ]
    if end:
        lines.append(f"DTEND:{_fmt(end)}")
    if recurrence_id is not None and not whole_series:
        lines.append(f"RECURRENCE-ID:{_fmt(recurrence_id)}")
    lines += [f"SUMMARY:{title}", "STATUS:CANCELLED", "SEQUENCE:1"]
    if organizer_email:
        lines.append(f"ORGANIZER;CN={organizer_name}:mailto:{organizer_email}")
    lines += [f"ATTENDEE:mailto:{e}" for e in emails]
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(lines)


async def _send_cancel_mails(emails, title, start, end, uid, organizer_name, organizer_email, scope, occ_start):
    """시스템 메일로 취소 안내 + .ics(METHOD:CANCEL) 발송. SMTP 미설정·실패 시 로그만 기록."""
    import asyncio
    import html as _html
    import logging
    from email import encoders
    from email.mime.base import MIMEBase
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    log = logging.getLogger(__name__)
    try:
        from app.admin.settings import get_smtp_config, send_system_email
        from app.db.session import async_session

        async with async_session() as db:
            cfg = await get_smtp_config(db)
        if not getattr(cfg, "host", None):
            return
        ics = cancel_ics(uid, title, occ_start or start, end, organizer_name, organizer_email, emails,
                         recurrence_id=occ_start, whole_series=scope != "this")
        when = _utc(occ_start or start).strftime("%Y-%m-%d %H:%M") + " (UTC)"
        for to in emails:
            msg = MIMEMultipart("mixed")
            msg["Subject"] = f"[일정 취소] {title}"
            msg["From"] = cfg.from_addr
            msg["To"] = to
            msg.attach(MIMEText(
                f"<p><b>{_html.escape(title)}</b> 일정이 취소되었습니다.</p><p>{when}</p>"
                f"<p>— {_html.escape(organizer_name or '')}</p>", "html", "utf-8",
            ))
            part = MIMEBase("text", "calendar", method="CANCEL")
            part.set_payload(ics.encode("utf-8"))
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename="cancel.ics")
            msg.attach(part)
            await asyncio.to_thread(send_system_email, cfg, msg)
    except Exception as e:  # noqa: BLE001
        log.warning("일정 취소 메일 실패: %s", e)


# ─── 참석 응답(RSVP) ───


async def rsvp(db: AsyncSession, user: User, event_id: str, response: str) -> dict | None:
    """참석자 본인의 응답. 회차 id 가 전달되면 마스터에 응답한다. 참석자가 아니면 None."""
    if response not in _RESPONSES:
        raise ValueError("response 는 accepted | declined | tentative | needs-action")
    event = await db.get(CalendarEventDB, event_id)
    if event is None:
        occ = split_occurrence_id(event_id)
        if occ:
            event = await db.get(CalendarEventDB, occ[0])
    if event is None:
        return None
    email = (user.email or "").lower()
    conds = [CalendarEventAttendee.user_id == user.id]
    if email:
        conds.append(CalendarEventAttendee.email == email)
    res = await db.execute(
        select(CalendarEventAttendee).where(
            CalendarEventAttendee.event_id == event.id, or_(*conds)
        )
    )
    row = res.scalars().first()
    if row is None:
        return None
    changed = row.response != response
    row.response = response
    row.responded_at = datetime.now(timezone.utc)
    if not row.user_id:
        row.user_id = user.id
    _touch(event)
    if event.parent_event_id:
        master = await db.get(CalendarEventDB, event.parent_event_id)
        if master:
            _touch(master)
    await db.commit()

    if changed:
        cal = await db.get(CalendarDB, event.calendar_id)
        if cal and cal.user_id != user.id:
            label = {"accepted": "수락", "declined": "거절", "tentative": "미정"}.get(response, response)
            try:
                from app.notifications.service import create_notification
                await create_notification(
                    db, cal.user_id, "calendar_invite",
                    f"{user.display_name or user.username}님이 '{event.title}' 일정에 {label}",
                    None, link=f"/calendar?event={event.id}",
                )
            except Exception:
                pass
    return {"event_id": event.id, "email": row.email, "response": row.response}


# ─── 빈 시간 조회(free/busy) ───

_FREEBUSY_MAX_DAYS = 62


def _merge_intervals(items: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    items = sorted(items)
    out: list[list[datetime]] = []
    for s, e in items:
        if out and s <= out[-1][1]:
            if e > out[-1][1]:
                out[-1][1] = e
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


async def freebusy(
    db: AsyncSession, emails: list[str], start: str, end: str
) -> list[dict]:
    """사용자별 바쁜 구간만 반환한다(제목·장소 등 내용은 반환하지 않는다).

    대상: 해당 사용자 소유 캘린더의 일정 + 참석 수락/미정 상태의 초대 일정.
    취소된 일정·본인이 거절한 일정은 제외한다.
    """
    rs = _utc(_parse_iso(start))
    re_ = _utc(_parse_iso(end))
    if re_ <= rs:
        raise ValueError("end 는 start 보다 뒤여야 합니다")
    if re_ - rs > timedelta(days=_FREEBUSY_MAX_DAYS):
        raise ValueError(f"조회 범위는 최대 {_FREEBUSY_MAX_DAYS}일입니다")

    out: list[dict] = []
    for raw in emails[:50]:
        email = raw.strip().lower()
        if not email:
            continue
        ures = await db.execute(
            select(User).where(or_(func.lower(User.email) == email, User.username == raw.strip()))
        )
        u = ures.scalars().first()
        if u is None:
            out.append({"email": email, "known": False, "busy": [], "tentative": []})
            continue
        cres = await db.execute(select(CalendarDB.id).where(CalendarDB.user_id == u.id))
        cal_ids = [r[0] for r in cres.all()]
        inv = await _invited_event_ids(db, u, {"accepted", "tentative"})
        evs = await _collect_events(db, cal_ids, rs, re_, {}, u, extra_ids=inv or None)
        busy: list[tuple[datetime, datetime]] = []
        tentative: list[tuple[datetime, datetime]] = []
        for ev in evs:
            if (ev.get("status") or "").lower() == "cancelled":
                continue
            if ev.get("my_response") == "declined":
                continue
            s = _utc(datetime.fromisoformat(ev["start"]))
            e = _utc(datetime.fromisoformat(ev["end"]))
            if e < rs or s > re_:
                continue
            s, e = max(s, rs), min(e, re_)
            if ev.get("my_response") == "tentative" or (ev.get("status") or "").lower() == "tentative":
                tentative.append((s, e))
            else:
                busy.append((s, e))
        out.append({
            "email": (u.email or email).lower(),
            "user_id": u.id,
            "name": u.display_name or u.username,
            "known": True,
            "busy": [{"start": s.isoformat(), "end": e.isoformat()} for s, e in _merge_intervals(busy)],
            "tentative": [{"start": s.isoformat(), "end": e.isoformat()} for s, e in _merge_intervals(tentative)],
        })
    return out


# ─── .ics 가져오기 / 내보내기 · CalDAV 공용 ───


async def organizer_of(db: AsyncSession, cal: CalendarDB | None) -> dict | None:
    if not cal:
        return None
    owner = await db.get(User, cal.user_id)
    if not owner or not owner.email:
        return None
    return {"email": owner.email, "name": owner.display_name or owner.username}


async def ical_items_for(db: AsyncSession, masters: list[CalendarEventDB], cal: CalendarDB | None) -> list[dict]:
    """event_to_ical/events_to_ical 에 전달할 묶음(참석자·회차 예외 포함)을 생성한다."""
    ids = [m.id for m in masters]
    ov_map = await load_overrides(db, ids)
    ov_ids = [o.id for lst in ov_map.values() for o in lst]
    att_map = await load_attendees(db, ids + ov_ids)
    org = await organizer_of(db, cal)
    items = []
    for m in masters:
        ovs = ov_map.get(m.id, [])
        items.append({
            "event": m,
            "attendees": att_map.get(m.id, []),
            "overrides": ovs,
            "override_attendees": {o.id: att_map[o.id] for o in ovs if o.id in att_map},
            "organizer": org if att_map.get(m.id) else None,
        })
    return items


async def export_calendar_ics(db: AsyncSession, user_id: str, calendar_id: str) -> tuple[str, str] | None:
    cal = await db.get(CalendarDB, calendar_id)
    if not await _can_read_calendar(db, user_id, cal):
        return None
    res = await db.execute(
        select(CalendarEventDB)
        .where(CalendarEventDB.calendar_id == calendar_id, CalendarEventDB.parent_event_id.is_(None))
        .order_by(CalendarEventDB.start)
    )
    items = await ical_items_for(db, list(res.scalars().all()), cal)
    return cal.name, events_to_ical(items, cal.name)


async def export_event_ics(db: AsyncSession, user_id: str, event_id: str) -> tuple[str, str] | None:
    ev = await db.get(CalendarEventDB, event_id)
    if ev is None:
        occ = split_occurrence_id(event_id)
        if occ:
            ev = await db.get(CalendarEventDB, occ[0])
    if ev is None:
        return None
    if ev.parent_event_id:
        ev = await db.get(CalendarEventDB, ev.parent_event_id) or ev
    cal = await db.get(CalendarDB, ev.calendar_id)
    if not await _can_read_calendar(db, user_id, cal):
        me = await db.get(User, user_id)
        if me is None or not await _is_attendee(db, me, ev.id):
            return None
    items = await ical_items_for(db, [ev], cal)
    return ev.title or "event", events_to_ical(items)


_BUNDLE_FIELDS = ("title", "description", "location", "start", "end", "all_day", "status",
                  "recurrence_rule", "recurrence_end", "timezone", "meeting_url")


def _apply_ical_data(ev: CalendarEventDB, data: dict, *, is_override: bool = False) -> None:
    for k in _BUNDLE_FIELDS:
        if is_override and k in ("recurrence_rule", "recurrence_end"):
            continue
        if k in data:
            setattr(ev, k, data[k])
    if not is_override:
        ev.exdates = dump_exdates(data.get("exdates") or [])
    # DAV·가져오기·구독 — 허용 범위 밖 반복 규칙(초·분 단위 등)은 반복 없음으로 저장
    ev.recurrence_rule = rrule_guard.sanitize_rrule(ev.recurrence_rule)
    if ev.status is None:
        ev.status = "confirmed"


async def save_ical_bundle(
    db: AsyncSession,
    cal_id: str,
    bundle: dict,
    event_id: str | None = None,
    keep_uid: bool = True,
) -> CalendarEventDB:
    """iCalendar 묶음(마스터+회차 예외)을 일정으로 저장한다. CalDAV PUT·.ics 가져오기 공용.

    event_id 의 행이 있으면 덮어쓰고, 회차 예외는 수신한 내용으로 전체 교체한다.
    참석자는 수신한 목록으로 교체한다(외부 클라이언트 동기화이므로 알림은 발송하지 않는다).
    """
    data = bundle["master"]
    ev = await db.get(CalendarEventDB, event_id) if event_id else None
    if ev is None:
        ev = CalendarEventDB(calendar_id=cal_id, title="", start=data["start"], end=data["end"])
        if event_id:
            ev.id = event_id
        db.add(ev)
    _apply_ical_data(ev, data)
    uid = data.get("uid")
    if keep_uid and uid and uid != ev.id and not uid.startswith("__anon_"):
        ev.ical_uid = uid[:255]
    _touch(ev)
    await db.flush()
    await _set_attendees(db, ev, data.get("attendees") or [], notify=False)

    # 회차 예외 동기화
    res = await db.execute(select(CalendarEventDB).where(CalendarEventDB.parent_event_id == ev.id))
    existing = list(res.scalars().all())
    incoming = bundle.get("overrides") or []
    if not ev.recurrence_rule:
        incoming = []
    used: set[str] = set()
    for od in incoming:
        rid = od.get("recurrence_id")
        if rid is None:
            continue
        row = next((o for o in existing if o.id not in used and o.recurrence_id
                    and _same_instant(o.recurrence_id, rid)), None)
        if row is None:
            row = CalendarEventDB(
                calendar_id=ev.calendar_id, title="", start=od["start"], end=od["end"],
                parent_event_id=ev.id, recurrence_id=_utc(rid),
            )
            db.add(row)
        row.calendar_id = ev.calendar_id
        _apply_ical_data(row, od, is_override=True)
        _touch(row)
        await db.flush()
        used.add(row.id)
        if od.get("attendees") is not None:
            await _set_attendees(db, row, od.get("attendees") or [], notify=False)
    stale = [o for o in existing if o.id not in used]
    if stale:
        await _delete_rows(db, stale)
    await db.commit()
    await db.refresh(ev)
    return ev


_IMPORT_MAX_EVENTS = 5000


async def import_ics(db: AsyncSession, user_id: str, calendar_id: str, text: str) -> dict | None:
    """.ics 파일을 캘린더로 가져온다. 동일 UID 가 해당 캘린더에 이미 있으면 덮어쓴다(중복 방지)."""
    cal = await db.get(CalendarDB, calendar_id)
    if not await _can_write_calendar(db, user_id, cal):
        return None
    bundles = ical_to_event_bundles(text)
    if bundles is None:
        raise ValueError("iCalendar 형식이 아닙니다")
    created = updated = skipped = 0
    for b in bundles[:_IMPORT_MAX_EVENTS]:
        if b["master"] is None:
            skipped += 1
            continue
        uid = b["master"].get("uid")
        existing_id = None
        if uid and not uid.startswith("__anon_"):
            r = await db.execute(
                select(CalendarEventDB.id).where(
                    CalendarEventDB.calendar_id == calendar_id,
                    CalendarEventDB.parent_event_id.is_(None),
                    or_(CalendarEventDB.ical_uid == uid, CalendarEventDB.id == uid),
                )
            )
            row = r.first()
            existing_id = row[0] if row else None
        try:
            await save_ical_bundle(db, calendar_id, b, event_id=existing_id)
        except Exception:
            await db.rollback()
            skipped += 1
            continue
        if existing_id:
            updated += 1
        else:
            created += 1
    skipped += max(0, len(bundles) - _IMPORT_MAX_EVENTS)
    return {"created": created, "updated": updated, "skipped": skipped}
