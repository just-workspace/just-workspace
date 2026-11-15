"""iCalendar serialization / deserialization.

CalDAV(휴대폰 캘린더)와 .ics 가져오기/내보내기가 같이 쓴다.

- 반복: RRULE · EXDATE · RECURRENCE-ID(회차 단일 수정)를 한 VCALENDAR 안에 같은 UID 로 묶는다.
- 시간대: 일정에 IANA 시간대가 있으면 DTSTART/DTEND 에 TZID 를 붙이고 VTIMEZONE 을 넣는다.
  (반복 일정은 UTC 로만 보내면 서머타임 지역에서 회차 시각이 한 시간씩 밀린다.)
- 참석자: ATTENDEE(CN·PARTSTAT·ROLE·RSVP)와 ORGANIZER.
- 회의 링크: CONFERENCE(RFC 7986) + URL. 읽을 때는 X-GOOGLE-CONFERENCE 등도 본다.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from icalendar import Calendar, Event, vCalAddress, vRecur, vText, vUri

_PARTSTAT_OUT = {
    "needs-action": "NEEDS-ACTION",
    "accepted": "ACCEPTED",
    "declined": "DECLINED",
    "tentative": "TENTATIVE",
}
_VALID_RESPONSES = set(_PARTSTAT_OUT)


# ─── 공통 헬퍼 ───


def get_zone(name: str | None):
    """IANA 이름 → ZoneInfo. 모르는 이름이면 None."""
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_exdates(raw: str | None) -> list[datetime]:
    """DB 의 exdates(JSON 배열, UTC ISO) → aware datetime 목록."""
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except (ValueError, TypeError):
        return []
    out: list[datetime] = []
    for s in items if isinstance(items, list) else []:
        try:
            out.append(_utc(datetime.fromisoformat(str(s).replace("Z", "+00:00"))))
        except ValueError:
            continue
    return out


def dump_exdates(dts: list[datetime]) -> str | None:
    if not dts:
        return None
    uniq = sorted({_utc(d).replace(microsecond=0) for d in dts})
    return json.dumps([d.isoformat() for d in uniq])


def strip_rrule_prefix(rule: str | None) -> str | None:
    if not rule:
        return None
    rule = rule.strip()
    if rule.upper().startswith("RRULE:"):
        rule = rule[6:]
    return rule or None


_UNTIL_RE = re.compile(r"UNTIL=([0-9TZ]+)", re.IGNORECASE)


def normalize_rrule_for_aware(rule: str) -> str:
    """UNTIL 이 시각인데 Z 가 없으면 Z 를 붙인다.

    dateutil 은 DTSTART 가 aware 면 UNTIL 도 UTC 여야 한다며 예외를 낸다 → 전개가 통째로
    실패해 마스터 한 건만 보이던 문제를 막는다.
    """
    def _fix(m):
        v = m.group(1)
        if "T" in v.upper() and not v.upper().endswith("Z"):
            v = v + "Z"
        return f"UNTIL={v}"
    return _UNTIL_RE.sub(_fix, rule)


# ─── 직렬화 ───


_HALF_DAY = timedelta(hours=12)


def _allday_date(dt: datetime) -> date:
    """종일 값의 날짜 = **가장 가까운 UTC 자정**의 날짜(프런트 calTz.allDayYmd 와 같은 규칙).

    현행 규약은 그날 UTC 00:00 이라 그대로 그날이다. 예전 웹 화면이 기기 자정으로 저장한 행
    (서울 = 전날 15:00Z)을 `.date()` 로 자르면 휴대폰·외부 클라이언트에서 하루 앞당겨 보였다
    (R7 B-1). UTC−12~+12 에서 정확하다.
    """
    return (_utc(dt) + _HALF_DAY).date()


def _allday_shift(start) -> timedelta:
    """종일 마스터의 시작을 가장 가까운 UTC 자정으로 옮기는 차이(현행 행이면 0, 서울 옛 행이면 +9h)."""
    if not isinstance(start, datetime):
        return timedelta(0)
    u = _utc(start)
    base = u.replace(hour=0, minute=0, second=0, microsecond=0)
    near = base + timedelta(days=1) if (u - base) >= _HALF_DAY else base
    return near - u


def _dt_for_ical(dt: datetime, all_day: bool, zone):
    if all_day:
        return _allday_date(dt) if isinstance(dt, datetime) else dt
    dt = _utc(dt)
    return dt.astimezone(zone) if zone else dt


def _rrule_value(ev) -> vRecur | None:
    rule = strip_rrule_prefix(ev.recurrence_rule)
    if not rule:
        return None
    try:
        rec = vRecur.from_ical(rule)
    except Exception:
        return None
    until = rec.get("UNTIL")
    if not until and not rec.get("COUNT") and getattr(ev, "recurrence_end", None):
        until = [ev.recurrence_end]
    if until:
        u = until[0] if isinstance(until, list) else until
        if ev.all_day:
            # RFC 5545: DTSTART 가 DATE 면 UNTIL 도 DATE 여야 한다.
            # UNTIL 은 "그날 끝"(현행 T235959Z, 옛 서울 행 T145959Z)이라 따로 가장 가까운 자정으로
            # 반올림하면 다음날로 넘어가 회차가 하나 는다 → **마스터 시작과 같은 차이**만큼 옮긴 뒤
            # 날짜를 취한다(현행 행은 차이 0 → 기존과 같음, R7 B-4 규칙).
            if isinstance(u, datetime):
                u = (_utc(u) + _allday_shift(getattr(ev, "start", None))).date()
        elif isinstance(u, datetime):
            u = _utc(u)
        elif isinstance(u, date):
            u = datetime(u.year, u.month, u.day, 23, 59, 59, tzinfo=timezone.utc)
        rec["UNTIL"] = [u]
    return rec


def _add_attendees(vevent: Event, attendees, organizer: dict | None):
    if organizer and organizer.get("email"):
        org = vCalAddress(f"mailto:{organizer['email']}")
        if organizer.get("name"):
            org.params["CN"] = vText(organizer["name"])
        vevent.add("organizer", org)
    for a in attendees or []:
        email = a["email"] if isinstance(a, dict) else a.email
        name = a.get("name") if isinstance(a, dict) else a.name
        resp = (a.get("response") if isinstance(a, dict) else a.response) or "needs-action"
        att = vCalAddress(f"mailto:{email}")
        if name:
            att.params["CN"] = vText(name)
        att.params["PARTSTAT"] = _PARTSTAT_OUT.get(resp, "NEEDS-ACTION")
        att.params["ROLE"] = "REQ-PARTICIPANT"
        att.params["CUTYPE"] = "INDIVIDUAL"
        if resp == "needs-action":
            att.params["RSVP"] = "TRUE"
        vevent.add("attendee", att, encode=0)


def _build_vevent(ev, *, uid: str, zone, attendees=None, organizer=None,
                  recurrence_id: datetime | None = None, master_all_day: bool | None = None,
                  include_rule: bool = True) -> Event:
    vevent = Event()
    vevent.add("uid", uid)
    vevent.add("summary", ev.title or "")
    if ev.description:
        vevent.add("description", ev.description)
    if ev.location:
        vevent.add("location", ev.location)

    vevent.add("dtstart", _dt_for_ical(ev.start, ev.all_day, zone))
    vevent.add("dtend", _dt_for_ical(ev.end, ev.all_day, zone))

    if recurrence_id is not None:
        vevent.add("recurrence-id", _dt_for_ical(recurrence_id, bool(master_all_day), zone))

    if include_rule:
        rec = _rrule_value(ev)
        if rec is not None:
            vevent.add("rrule", rec)
            exds = parse_exdates(getattr(ev, "exdates", None))
            if exds:
                vals = [_dt_for_ical(d, ev.all_day, zone) for d in exds]
                vevent.add("exdate", vals)

    meeting_url = getattr(ev, "meeting_url", None)
    if meeting_url:
        vevent.add("url", vUri(meeting_url))
        vevent.add("conference", vUri(meeting_url), parameters={"VALUE": "URI", "FEATURE": "VIDEO"})

    _add_attendees(vevent, attendees, organizer)

    if ev.status:
        vevent.add("status", ev.status.upper())
    if ev.created_at:
        vevent.add("created", _utc(ev.created_at))
    stamp = ev.updated_at or ev.created_at
    if ev.updated_at:
        vevent.add("last-modified", _utc(ev.updated_at))
    vevent.add("dtstamp", _utc(stamp) if stamp else datetime.now(timezone.utc))
    return vevent


def event_to_ical(ev, attendees=None, overrides=None, organizer: dict | None = None,
                  override_attendees: dict | None = None) -> str:
    """CalendarEventDB 한 건(+회차 예외들) → VCALENDAR 문자열.

    attendees: 마스터 참석자 행 목록(CalendarEventAttendee 또는 dict)
    overrides: 이 마스터의 회차 단일 수정 행 목록(parent_event_id == ev.id)
    override_attendees: {override_id: [참석자...]}
    organizer: {"email":..., "name":...}
    """
    cal = Calendar()
    cal.add("prodid", "-//just-workspace//CalDAV//EN")
    cal.add("version", "2.0")
    cal.add("calscale", "GREGORIAN")
    cal.add_component(build_vevents(ev, attendees, overrides, organizer, override_attendees, cal))
    _finish_calendar(cal)
    return cal.to_ical().decode("utf-8")


def build_vevents(ev, attendees=None, overrides=None, organizer=None,
                  override_attendees=None, cal: Calendar | None = None):
    """마스터 VEVENT 를 돌려주고, 회차 예외 VEVENT 들은 cal 에 바로 넣는다."""
    zone = None if ev.all_day else get_zone(getattr(ev, "timezone", None))
    uid = getattr(ev, "ical_uid", None) or ev.id
    master = _build_vevent(ev, uid=uid, zone=zone, attendees=attendees, organizer=organizer)
    if cal is not None:
        for ov in overrides or []:
            if ov.recurrence_id is None:
                continue
            ov_att = (override_attendees or {}).get(ov.id)
            cal.add_component(_build_vevent(
                ov, uid=uid, zone=None if ov.all_day else (get_zone(getattr(ov, "timezone", None)) or zone),
                attendees=ov_att if ov_att is not None else attendees,
                organizer=organizer, recurrence_id=ov.recurrence_id,
                master_all_day=ev.all_day, include_rule=False,
            ))
    return master


def _finish_calendar(cal: Calendar):
    # TZID 를 쓴 시간대의 VTIMEZONE 정의를 붙인다(없으면 iOS 가 UTC 로 해석).
    try:
        cal.add_missing_timezones()
    except Exception:
        pass


def events_to_ical(items: list[dict], name: str | None = None) -> str:
    """여러 일정 → 하나의 VCALENDAR(.ics 내보내기). items: event_to_ical 인자 dict 목록."""
    cal = Calendar()
    cal.add("prodid", "-//just-workspace//Calendar Export//EN")
    cal.add("version", "2.0")
    cal.add("calscale", "GREGORIAN")
    if name:
        cal.add("x-wr-calname", name)
    # 하위 VEVENT 들을 먼저 모은 다음 마스터 순으로 넣는다(순서는 무관하지만 읽기 쉽게)
    for it in items:
        master = build_vevents(
            it["event"], it.get("attendees"), it.get("overrides"), it.get("organizer"),
            it.get("override_attendees"), cal,
        )
        cal.add_component(master)
    _finish_calendar(cal)
    return cal.to_ical().decode("utf-8")


# ─── 역직렬화 ───


def _conv_dt(prop) -> tuple[datetime, bool, str | None]:
    """DTSTART 류 프로퍼티 → (UTC aware datetime, 종일 여부, 시간대 이름)."""
    dt = prop.dt
    if isinstance(dt, date) and not isinstance(dt, datetime):
        return datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc), True, None
    tzname = None
    if dt.tzinfo is not None:
        key = getattr(dt.tzinfo, "key", None) or getattr(dt.tzinfo, "zone", None)
        if key and get_zone(key):
            tzname = key
        elif prop.params.get("TZID") and get_zone(str(prop.params.get("TZID"))):
            tzname = str(prop.params.get("TZID"))
    else:
        tzid = prop.params.get("TZID") if hasattr(prop, "params") else None
        zone = get_zone(str(tzid)) if tzid else None
        dt = dt.replace(tzinfo=zone or timezone.utc)
        if zone:
            tzname = str(tzid)
    if tzname in ("UTC", "Etc/UTC"):
        tzname = None
    return _utc(dt), False, tzname


def _addr_email(v) -> str:
    s = str(v)
    if s.lower().startswith("mailto:"):
        s = s[7:]
    return s.strip().lower()


def _parse_attendees(component) -> list[dict]:
    raw = component.get("attendee")
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else [raw]
    out: list[dict] = []
    seen: set[str] = set()
    for a in items:
        email = _addr_email(a)
        if not email or "@" not in email or email in seen:
            continue
        seen.add(email)
        params = getattr(a, "params", {}) or {}
        ps = str(params.get("PARTSTAT", "NEEDS-ACTION")).lower()
        out.append({
            "email": email,
            "name": str(params["CN"]) if params.get("CN") else None,
            "response": ps if ps in _VALID_RESPONSES else "needs-action",
        })
    return out


def _parse_exdates(component) -> list[datetime]:
    raw = component.get("exdate")
    if raw is None:
        return []
    items = raw if isinstance(raw, list) else [raw]
    out: list[datetime] = []
    for item in items:
        for d in getattr(item, "dts", []) or []:
            dt = d.dt
            if isinstance(dt, date) and not isinstance(dt, datetime):
                out.append(datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc))
            else:
                if dt.tzinfo is None:
                    tzid = item.params.get("TZID") if hasattr(item, "params") else None
                    dt = dt.replace(tzinfo=get_zone(str(tzid)) if tzid else timezone.utc)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                out.append(_utc(dt))
    return out


def _parse_meeting_url(component) -> str | None:
    for key in ("conference", "x-google-conference", "x-microsoft-skypeteamsmeetingurl", "url"):
        v = component.get(key)
        if v is None:
            continue
        if isinstance(v, list):
            v = v[0] if v else None
        if v:
            s = str(v).strip()
            if s.lower().startswith(("http://", "https://")):
                return s[:1000]
    return None


def _component_to_data(component) -> dict:
    data: dict = {}
    uid = component.get("uid")
    if uid:
        data["uid"] = str(uid)

    summary = component.get("summary")
    data["title"] = str(summary) if summary else ""
    desc = component.get("description")
    if desc:
        data["description"] = str(desc)
    loc = component.get("location")
    if loc:
        data["location"] = str(loc)

    dtstart = component.get("dtstart")
    tzname = None
    if dtstart:
        start, all_day, tzname = _conv_dt(dtstart)
        data["start"] = start
        data["all_day"] = all_day
    dtend = component.get("dtend")
    if dtend:
        data["end"] = _conv_dt(dtend)[0]
    elif dtstart and component.get("duration"):
        data["end"] = data["start"] + component.get("duration").dt
    elif dtstart:
        data["end"] = data["start"] + (timedelta(days=1) if data.get("all_day") else timedelta(0))
    data["timezone"] = tzname

    status = component.get("status")
    if status:
        data["status"] = str(status).lower()

    rrule = component.get("rrule")
    if rrule is not None:
        if isinstance(rrule, list):
            rrule = rrule[0]
        data["recurrence_rule"] = rrule.to_ical().decode("utf-8")
        until = rrule.get("UNTIL")
        if until:
            u = until[0] if isinstance(until, list) else until
            if isinstance(u, datetime):
                data["recurrence_end"] = _utc(u)
            elif isinstance(u, date):
                data["recurrence_end"] = datetime(u.year, u.month, u.day, 23, 59, 59, tzinfo=timezone.utc)
        else:
            data["recurrence_end"] = None
    else:
        data["recurrence_rule"] = None
        data["recurrence_end"] = None

    data["exdates"] = _parse_exdates(component)
    data["attendees"] = _parse_attendees(component)
    data["meeting_url"] = _parse_meeting_url(component)

    org = component.get("organizer")
    if org is not None:
        data["organizer_email"] = _addr_email(org)

    rid = component.get("recurrence-id")
    if rid is not None:
        data["recurrence_id"] = _conv_dt(rid)[0]
    return data


def ical_to_event_bundles(ical_text: str) -> list[dict] | None:
    """VCALENDAR → UID 별 묶음 목록 [{"master": data|None, "overrides": [data...]}].

    .ics 가져오기처럼 여러 일정이 한 파일에 있는 경우에 쓴다. 파싱 실패면 None.
    """
    try:
        cal = Calendar.from_ical(ical_text)
    except Exception:
        return None
    groups: dict[str, dict] = {}
    order: list[str] = []
    anon = 0
    for component in cal.walk():
        if component.name != "VEVENT":
            continue
        data = _component_to_data(component)
        if "start" not in data:
            continue
        uid = data.get("uid")
        if not uid:
            anon += 1
            uid = f"__anon_{anon}"
        g = groups.get(uid)
        if g is None:
            g = {"master": None, "overrides": []}
            groups[uid] = g
            order.append(uid)
        if data.get("recurrence_id") is not None:
            g["overrides"].append(data)
        elif g["master"] is None:
            g["master"] = data
    return [groups[u] for u in order]


def ical_to_event_bundle(ical_text: str) -> dict | None:
    """CalDAV PUT 한 리소스 → {"master": data, "overrides": [...]}. 마스터 없으면 None."""
    bundles = ical_to_event_bundles(ical_text)
    if not bundles:
        return None
    b = bundles[0]
    if b["master"] is None:
        # 회차 예외만 온 경우(드묾) — 첫 예외를 단독 일정으로 취급
        if not b["overrides"]:
            return None
        m = dict(b["overrides"][0])
        m.pop("recurrence_id", None)
        return {"master": m, "overrides": []}
    return b


def ical_to_event_data(ical_text: str) -> dict | None:
    """Parse iCalendar text → dict of event fields (or None on error). (하위 호환)"""
    b = ical_to_event_bundle(ical_text)
    return b["master"] if b else None
