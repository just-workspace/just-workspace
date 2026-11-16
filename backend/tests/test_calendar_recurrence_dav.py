"""캘린더 반복·회차 예외·참석자·시간대 — CalDAV 직렬화 왕복과 API 동작.

이전 CalDAV 직렬화에는 RRULE·EXDATE·ATTENDEE 가 전혀 없어 반복 일정이 휴대폰에서
1회성 일정으로 표시되었다. 여기서는
- 웹에서 생성한 반복 일정 → .ics → 재파싱 시 규칙·예외·참석자·시간대가 유지되는지
- 휴대폰이 PUT 한 VCALENDAR(마스터+RECURRENCE-ID) → DB → 다시 GET 한 결과가 동일한지
- 회차 삭제(EXDATE)·회차 수정(RECURRENCE-ID)이 목록 전개에 반영되는지
- RSVP·free/busy 권한
을 확인한다.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.calendar import router as cal_router
from app.calendar import service
from app.calendar.schemas import EventUpdate, RsvpRequest
from app.dav import service as dav_svc
from app.dav.ical_utils import ical_to_event_bundle, ical_to_event_data
from app.db.models import CalendarDB, CalendarEventAttendee, CalendarEventDB, User

UTC = timezone.utc


async def _seed(db):
    for uid, email in (("owner", "owner@x.io"), ("guest", "guest@x.io"), ("other", "other@x.io")):
        db.add(User(id=uid, username=uid, email=email, password_hash="x", display_name=uid.upper()))
    await db.commit()
    db.add(CalendarDB(id="cal-o", user_id="owner", name="내 캘린더", color="#3b82f6"))
    db.add(CalendarDB(id="cal-g", user_id="guest", name="게스트", color="#10b981"))
    await db.commit()


async def _weekly(db, **extra):
    data = {
        "calendar_id": "cal-o",
        "title": "주간 회의",
        "start": "2026-10-05T01:00:00Z",  # 월 10:00 KST
        "end": "2026-10-05T02:00:00Z",
        "recurrence_rule": "FREQ=WEEKLY;BYDAY=MO",
        "timezone": "Asia/Seoul",
        "meeting_url": "https://meet.example.com/abc",
        "attendees": [{"email": "Guest@x.io"}, {"email": "outside@ext.com", "name": "외부인"}],
    }
    data.update(extra)
    return await service.create_event(db, "owner", data)


@pytest.mark.asyncio
async def test_create_with_attendees_tz_meeting(db_session):
    await _seed(db_session)
    ev = await _weekly(db_session)
    assert ev["timezone"] == "Asia/Seoul"
    assert ev["meeting_url"] == "https://meet.example.com/abc"
    emails = sorted(a["email"] for a in ev["attendees"])
    assert emails == ["guest@x.io", "outside@ext.com"]
    guest = next(a for a in ev["attendees"] if a["email"] == "guest@x.io")
    assert guest["user_id"] == "guest" and guest["response"] == "needs-action"


@pytest.mark.asyncio
async def test_bad_timezone_rejected(db_session):
    await _seed(db_session)
    with pytest.raises(ValueError):
        await _weekly(db_session, timezone="Mars/Olympus")


@pytest.mark.asyncio
async def test_exdate_and_override_in_expansion(db_session):
    await _seed(db_session)
    ev = await _weekly(db_session)
    mid = ev["id"]
    # 10/12 회차 삭제, 10/19 회차는 시간만 변경
    assert await service.delete_occurrence(db_session, "owner", mid, datetime(2026, 10, 12, 1, tzinfo=UTC))
    ov_id = await service.update_occurrence(
        db_session, "owner", mid, datetime(2026, 10, 19, 1, tzinfo=UTC),
        {"start": "2026-10-19T05:00:00Z", "end": "2026-10-19T06:00:00Z", "title": "주간 회의(변경)"},
    )
    assert ov_id

    evs = await service.get_events(db_session, "owner", "2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z")
    starts = sorted(e["start"] for e in evs)
    assert "2026-10-12T01:00:00+00:00" not in starts  # EXDATE
    assert "2026-10-19T01:00:00+00:00" not in starts  # 원래 회차는 제외되고
    ov = next(e for e in evs if e["id"] == ov_id)       # 회차 예외가 대신 반환됨
    assert ov["is_exception"] and ov["parent_event_id"] == mid
    assert ov["title"] == "주간 회의(변경)"
    assert ov["start"].startswith("2026-10-19T05:00")
    assert "2026-10-26T01:00:00+00:00" in starts
    # 회차 id 형식이 이전과 동일(마스터_UTC스탬프)
    assert any(e["id"] == f"{mid}_20261026T010000" for e in evs)


@pytest.mark.asyncio
async def test_occurrence_id_routes_to_exception(db_session):
    """프런트가 사용하는 회차 id('{마스터}_{스탬프}')로 DELETE/PATCH 하면 회차 예외로 처리된다."""
    await _seed(db_session)
    owner = await db_session.get(User, "owner")
    ev = await _weekly(db_session)
    mid = ev["id"]
    await cal_router.delete_event(event_id=f"{mid}_20261012T010000", occurrence=None, user=owner, db=db_session)
    res = await cal_router.update_event(
        event_id=f"{mid}_20261019T010000", body=EventUpdate(title="바뀐 회차"),
        occurrence=None, user=owner, db=db_session,
    )
    assert res["id"] != mid
    master = await db_session.get(CalendarEventDB, mid)
    assert "2026-10-12" in (master.exdates or "")
    # 회차 예외 행을 삭제해도 해당 회차는 복원되지 않는다(EXDATE 로 유지)
    await cal_router.delete_event(event_id=res["id"], occurrence=None, user=owner, db=db_session)
    await db_session.refresh(master)
    assert "2026-10-19" in (master.exdates or "")
    evs = await service.get_events(db_session, "owner", "2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z")
    assert not any(e["start"].startswith("2026-10-19") for e in evs)


@pytest.mark.asyncio
async def test_occurrence_exception_keeps_attendees_and_responses(db_session):
    """회차만 수정해도 참석자·응답이 예외 행에 승계되고, 초대받은 사용자의 목록에 해당 회차가 유지된다."""
    await _seed(db_session)
    guest = await db_session.get(User, "guest")
    ev = await _weekly(db_session)
    mid = ev["id"]
    await service.rsvp(db_session, guest, mid, "accepted")
    ov_id = await service.update_occurrence(
        db_session, "owner", mid, datetime(2026, 10, 19, 1, tzinfo=UTC),
        {"start": "2026-10-19T05:00:00Z", "end": "2026-10-19T06:00:00Z"},
    )
    rows = (await service.load_attendees(db_session, [ov_id])).get(ov_id, [])
    by = {a.email: a.response for a in rows}
    assert by == {"guest@x.io": "accepted", "outside@ext.com": "needs-action"}

    # 프런트와 같이 동일한 참석자 목록을 재전송해도 응답이 유지된다
    await service.update_occurrence(
        db_session, "owner", mid, datetime(2026, 10, 19, 1, tzinfo=UTC),
        {"title": "바뀐 회차", "attendees": [{"email": "guest@x.io"}, {"email": "outside@ext.com"}]},
    )
    rows = (await service.load_attendees(db_session, [ov_id])).get(ov_id, [])
    assert {a.email: a.response for a in rows}["guest@x.io"] == "accepted"

    # 초대받은 사용자 측 목록에 이동한 회차가 표시되고, 본인 응답이 포함된다
    evs = await service.get_events(db_session, "guest", "2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z", include_invited=True)
    ov = next(e for e in evs if e["id"] == ov_id)
    assert ov["is_invited"] and ov["my_response"] == "accepted"
    assert ov["start"].startswith("2026-10-19T05:00")


@pytest.mark.asyncio
async def test_other_user_cannot_touch_occurrence(db_session):
    await _seed(db_session)
    other = await db_session.get(User, "other")
    ev = await _weekly(db_session)
    with pytest.raises(HTTPException) as e:
        await cal_router.delete_event(event_id=f"{ev['id']}_20261012T010000", occurrence=None, user=other, db=db_session)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_timezone_expansion_keeps_local_time_across_dst(db_session):
    """뉴욕 09:00 주간 회의 — 서머타임 종료 후에도 현지 09:00 (UTC 기준 13→14시)."""
    await _seed(db_session)
    ev = await service.create_event(db_session, "owner", {
        "calendar_id": "cal-o", "title": "NY standup",
        "start": "2026-10-26T13:00:00Z", "end": "2026-10-26T13:30:00Z",
        "recurrence_rule": "FREQ=WEEKLY", "timezone": "America/New_York",
    })
    evs = await service.get_events(db_session, "owner", "2026-10-20T00:00:00Z", "2026-11-12T00:00:00Z")
    starts = sorted(e["start"] for e in evs if e["title"] == "NY standup")
    assert starts[0] == "2026-10-26T13:00:00+00:00"
    assert "2026-11-02T14:00:00+00:00" in starts  # DST 종료 후


# ─── CalDAV 직렬화 왕복 ───


@pytest.mark.asyncio
async def test_web_event_to_ical_roundtrip(db_session):
    await _seed(db_session)
    ev = await _weekly(db_session, recurrence_end="2026-12-31T23:59:59Z")
    mid = ev["id"]
    await service.delete_occurrence(db_session, "owner", mid, datetime(2026, 10, 12, 1, tzinfo=UTC))
    await service.update_occurrence(
        db_session, "owner", mid, datetime(2026, 10, 19, 1, tzinfo=UTC),
        {"start": "2026-10-19T05:00:00Z", "end": "2026-10-19T06:00:00Z"},
    )
    row = await db_session.get(CalendarEventDB, mid)
    text = await dav_svc.event_ical_text(db_session, row)

    assert "RRULE:FREQ=WEEKLY" in text and "UNTIL=" in text
    assert "EXDATE" in text and "RECURRENCE-ID" in text
    assert "TZID=Asia/Seoul" in text and "BEGIN:VTIMEZONE" in text
    assert "ATTENDEE" in text and "mailto:guest@x.io" in text
    assert "ORGANIZER" in text and "mailto:owner@x.io" in text
    assert "https://meet.example.com/abc" in text

    b = ical_to_event_bundle(text)
    m = b["master"]
    assert m["uid"] == mid
    assert m["recurrence_rule"].startswith("FREQ=WEEKLY")
    assert m["timezone"] == "Asia/Seoul"
    assert m["start"] == datetime(2026, 10, 5, 1, tzinfo=UTC)
    assert [d.isoformat() for d in m["exdates"]] == ["2026-10-12T01:00:00+00:00"]
    assert {a["email"] for a in m["attendees"]} == {"guest@x.io", "outside@ext.com"}
    assert m["meeting_url"] == "https://meet.example.com/abc"
    assert len(b["overrides"]) == 1
    ov = b["overrides"][0]
    assert ov["recurrence_id"] == datetime(2026, 10, 19, 1, tzinfo=UTC)
    assert ov["start"] == datetime(2026, 10, 19, 5, tzinfo=UTC)


PHONE_ICS = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iPhone OS 18.0//EN
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
DTSTART:20070311T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZNAME:EDT
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
DTSTART:20071104T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZNAME:EST
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:phone-uid-123@icloud.com
DTSTAMP:20261001T000000Z
DTSTART;TZID=America/New_York:20261005T090000
DTEND;TZID=America/New_York:20261005T093000
SUMMARY:Standup
RRULE:FREQ=DAILY;COUNT=10
EXDATE;TZID=America/New_York:20261007T090000
ORGANIZER;CN=Owner:mailto:owner@x.io
ATTENDEE;CN=Guest;PARTSTAT=ACCEPTED:mailto:guest@x.io
ATTENDEE;PARTSTAT=TENTATIVE:mailto:x@ext.com
END:VEVENT
BEGIN:VEVENT
UID:phone-uid-123@icloud.com
DTSTAMP:20261001T000000Z
RECURRENCE-ID;TZID=America/New_York:20261008T090000
DTSTART;TZID=America/New_York:20261008T100000
DTEND;TZID=America/New_York:20261008T103000
SUMMARY:Standup (late)
END:VEVENT
END:VCALENDAR
"""


@pytest.mark.asyncio
async def test_phone_put_then_get_roundtrip(db_session):
    await _seed(db_session)
    bundle = ical_to_event_bundle(PHONE_ICS)
    ev = await dav_svc.upsert_event(db_session, "res-1", "cal-o", bundle)
    assert ev.id == "res-1" and ev.ical_uid == "phone-uid-123@icloud.com"
    assert ev.timezone == "America/New_York"
    assert ev.recurrence_rule == "FREQ=DAILY;COUNT=10"

    # 웹 목록: 10회 - EXDATE 1 = 9, 그중 10/8 은 회차 예외로 대체
    evs = await service.get_events(db_session, "owner", "2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z")
    stand = [e for e in evs if e["title"].startswith("Standup")]
    assert len(stand) == 9
    assert not any(e["start"].startswith("2026-10-07") for e in stand)
    late = [e for e in stand if e["is_exception"]]
    assert len(late) == 1 and late[0]["start"] == "2026-10-08T14:00:00+00:00"
    master = next(e for e in stand if e["id"] == "res-1")
    resp = {a["email"]: a["response"] for a in master["attendees"]}
    assert resp == {"guest@x.io": "accepted", "x@ext.com": "tentative"}

    # 다시 GET → 동일한 의미
    text = await dav_svc.event_ical_text(db_session, ev)
    assert "UID:phone-uid-123@icloud.com" in text
    b2 = ical_to_event_bundle(text)
    assert b2["master"]["recurrence_rule"] == "FREQ=DAILY;COUNT=10"
    assert b2["master"]["timezone"] == "America/New_York"
    assert b2["master"]["exdates"] == bundle["master"]["exdates"]
    assert len(b2["overrides"]) == 1
    assert b2["overrides"][0]["recurrence_id"] == bundle["overrides"][0]["recurrence_id"]
    assert b2["overrides"][0]["title"] == "Standup (late)"

    # 휴대폰이 회차 예외를 삭제하고 다시 PUT → 예외 행도 삭제됨
    no_override = PHONE_ICS.split("BEGIN:VEVENT")[0] + "BEGIN:VEVENT" + PHONE_ICS.split("BEGIN:VEVENT")[1] + "END:VCALENDAR\n"
    no_override = no_override.replace("END:VEVENT\nEND:VCALENDAR", "END:VEVENT\nEND:VCALENDAR")
    await dav_svc.upsert_event(db_session, "res-1", "cal-o", ical_to_event_bundle(no_override))
    left = await service.load_overrides(db_session, ["res-1"])
    assert not left.get("res-1")

    # CalDAV 목록에는 마스터만 포함(회차 예외는 같은 리소스 내)
    rows = await dav_svc.get_calendar_events(db_session, "cal-o")
    assert [r.id for r in rows] == ["res-1"]
    assert await dav_svc.delete_event(db_session, "res-1")


def test_old_signature_still_parses():
    d = ical_to_event_data(PHONE_ICS)
    assert d["title"] == "Standup" and d["all_day"] is False


def test_all_day_rrule_until_is_date():
    """종일 반복은 UNTIL 도 DATE 여야 휴대폰이 수용한다."""
    from app.dav.ical_utils import event_to_ical

    class E:
        id = "e1"; title = "휴가"; description = None; location = None
        start = datetime(2026, 10, 5, tzinfo=UTC); end = datetime(2026, 10, 6, tzinfo=UTC)
        all_day = True; status = "confirmed"; created_at = None; updated_at = None
        recurrence_rule = "FREQ=DAILY;UNTIL=20261010T145959Z"; recurrence_end = None
        timezone = None; meeting_url = None; exdates = '["2026-10-07T00:00:00+00:00"]'; ical_uid = None

    text = event_to_ical(E())
    assert "UNTIL=20261010;" in text or "UNTIL=20261010\r" in text
    assert "DTSTART;VALUE=DATE:20261005" in text
    assert "EXDATE;VALUE=DATE:20261007" in text


def test_legacy_device_midnight_all_day_not_shifted_back():
    """이전 웹 화면이 기기 자정(서울 = 전날 15:00Z)으로 저장한 종일 일정.

    `.date()` 로 절단하면 휴대폰에서 하루 앞당겨 표시되었다. 마스터·EXDATE·RECURRENCE-ID 는 가장 가까운
    UTC 자정으로, UNTIL(해당일 끝 14:59:59Z)은 마스터와 동일한 +9h 만큼 이동한 날짜여야 한다
    (UNTIL 을 별도로 반올림하면 다음날로 넘어가 회차가 하나 증가한다).
    """
    from app.dav.ical_utils import event_to_ical

    class E:
        id = "e2"; title = "휴가"; description = None; location = None
        # 서울 10/5 종일 = 10/4 15:00Z ~ 10/5 15:00Z
        start = datetime(2026, 10, 4, 15, tzinfo=UTC); end = datetime(2026, 10, 5, 15, tzinfo=UTC)
        all_day = True; status = "confirmed"; created_at = None; updated_at = None
        # 서울 10/10 23:59:59 까지
        recurrence_rule = "FREQ=DAILY;UNTIL=20261010T145959Z"; recurrence_end = None
        timezone = None; meeting_url = None; ical_uid = None
        exdates = '["2026-10-06T15:00:00+00:00"]'   # 서울 10/7 회차 삭제

    class Ov:
        id = "ov1"; title = "휴가(변경)"; description = None; location = None
        start = datetime(2026, 10, 7, 15, tzinfo=UTC); end = datetime(2026, 10, 8, 15, tzinfo=UTC)
        all_day = True; status = "confirmed"; created_at = None; updated_at = None
        recurrence_rule = None; recurrence_end = None; timezone = None; meeting_url = None
        recurrence_id = datetime(2026, 10, 7, 15, tzinfo=UTC)   # 서울 10/8 회차

    text = event_to_ical(E(), overrides=[Ov()])
    assert "DTSTART;VALUE=DATE:20261005" in text
    assert "DTEND;VALUE=DATE:20261006" in text
    assert "EXDATE;VALUE=DATE:20261007" in text
    assert "UNTIL=20261010;" in text or "UNTIL=20261010\r" in text
    assert "RECURRENCE-ID;VALUE=DATE:20261008" in text
    assert "UNTIL=20261011" not in text
    assert "DTSTART;VALUE=DATE:20261008" in text


def test_all_day_utc_midnight_unchanged_and_serial_bumped():
    """현행 규약(해당일 UTC 00:00)은 변경되지 않는다. 직렬화가 변경되었으므로 ETag 버전은 p5."""
    from app.dav.ical_utils import _dt_for_ical

    assert str(_dt_for_ical(datetime(2026, 10, 5, tzinfo=UTC), True, None)) == "2026-10-05"
    assert str(_dt_for_ical(datetime(2026, 10, 5, 11, 59, tzinfo=UTC), True, None)) == "2026-10-05"
    assert str(_dt_for_ical(datetime(2026, 10, 5, 12, tzinfo=UTC), True, None)) == "2026-10-06"
    assert dav_svc.SERIAL_VERSION == "p5"


# ─── RSVP · 초대받은 일정 · free/busy ───


@pytest.mark.asyncio
async def test_rsvp_and_invited_visibility(db_session):
    await _seed(db_session)
    ev = await _weekly(db_session, recurrence_rule=None, timezone=None)
    guest = await db_session.get(User, "guest")
    other = await db_session.get(User, "other")

    # 초대받은 사용자는 일정을 조회할 수 있고, 그 외 사용자는 조회할 수 없다
    assert (await service.get_event(db_session, "guest", ev["id"]))["is_invited"] is True
    assert await service.get_event(db_session, "other", ev["id"]) is None

    res = await cal_router.rsvp_event(event_id=ev["id"], body=RsvpRequest(response="accepted"), user=guest, db=db_session)
    assert res["response"] == "accepted"
    with pytest.raises(HTTPException) as e:
        await cal_router.rsvp_event(event_id=ev["id"], body=RsvpRequest(response="accepted"), user=other, db=db_session)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await cal_router.rsvp_event(event_id=ev["id"], body=RsvpRequest(response="maybe"), user=guest, db=db_session)
    assert e.value.status_code == 400

    # 목록: include_invited 인 경우에만 표시(기존 응답 호환)
    plain = await service.get_events(db_session, "guest", "2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z")
    assert not any(e["id"] == ev["id"] for e in plain)
    inv = await service.get_events(db_session, "guest", "2026-10-01T00:00:00Z", "2026-10-31T00:00:00Z", include_invited=True)
    mine = next(e for e in inv if e["id"] == ev["id"])
    assert mine["is_invited"] and mine["my_response"] == "accepted"


@pytest.mark.asyncio
async def test_update_attendees_keeps_existing_response(db_session):
    await _seed(db_session)
    ev = await _weekly(db_session, recurrence_rule=None)
    guest = await db_session.get(User, "guest")
    await service.rsvp(db_session, guest, ev["id"], "declined")
    await service.update_event(db_session, "owner", ev["id"], {"attendees": [{"email": "guest@x.io"}, {"email": "new@x.io"}]})
    rows = (await service.load_attendees(db_session, [ev["id"]]))[ev["id"]]
    resp = {a.email: a.response for a in rows}
    assert resp == {"guest@x.io": "declined", "new@x.io": "needs-action"}


@pytest.mark.asyncio
async def test_freebusy_hides_details_and_skips_declined(db_session):
    await _seed(db_session)
    other = await db_session.get(User, "other")
    # guest 본인 일정 하나
    await service.create_event(db_session, "guest", {
        "calendar_id": "cal-g", "title": "비밀 면담", "location": "3층",
        "start": "2026-10-06T01:00:00Z", "end": "2026-10-06T02:00:00Z",
    })
    # owner 가 guest 를 초대한 일정 두 개: 하나 수락, 하나 거절
    a = await _weekly(db_session, recurrence_rule=None, start="2026-10-07T01:00:00Z", end="2026-10-07T02:00:00Z")
    b = await _weekly(db_session, recurrence_rule=None, start="2026-10-08T01:00:00Z", end="2026-10-08T02:00:00Z")
    guest = await db_session.get(User, "guest")
    await service.rsvp(db_session, guest, a["id"], "accepted")
    await service.rsvp(db_session, guest, b["id"], "declined")

    res = await cal_router.get_freebusy(
        emails="guest@x.io,nobody@x.io", start="2026-10-05T00:00:00Z", end="2026-10-10T00:00:00Z",
        user=other, db=db_session,
    )
    g = next(u for u in res["users"] if u["email"] == "guest@x.io")
    assert g["known"] is True
    assert [s["start"] for s in g["busy"]] == ["2026-10-06T01:00:00+00:00", "2026-10-07T01:00:00+00:00"]
    flat = str(res)
    assert "비밀 면담" not in flat and "3층" not in flat
    n = next(u for u in res["users"] if u["email"] == "nobody@x.io")
    assert n["known"] is False

    with pytest.raises(HTTPException):
        await cal_router.get_freebusy(emails="guest@x.io", start="2026-01-01T00:00:00Z",
                                      end="2026-12-01T00:00:00Z", user=other, db=db_session)


# ─── .ics 가져오기 / 내보내기 ───


@pytest.mark.asyncio
async def test_ics_import_export(db_session):
    await _seed(db_session)
    res = await service.import_ics(db_session, "owner", "cal-o", PHONE_ICS)
    assert res == {"created": 1, "updated": 0, "skipped": 0}
    # 동일 파일을 다시 가져오면 중복 생성 대신 덮어쓴다
    res = await service.import_ics(db_session, "owner", "cal-o", PHONE_ICS)
    assert res["created"] == 0 and res["updated"] == 1

    name, text = await service.export_calendar_ics(db_session, "owner", "cal-o")
    assert name == "내 캘린더"
    assert text.count("BEGIN:VEVENT") == 2  # 마스터 + 회차 예외
    assert "RRULE:FREQ=DAILY;COUNT=10" in text

    # 타 사용자의 캘린더는 내보내기·가져오기 모두 차단
    assert await service.export_calendar_ics(db_session, "other", "cal-o") is None
    assert await service.import_ics(db_session, "other", "cal-o", PHONE_ICS) is None

    with pytest.raises(ValueError):
        await service.import_ics(db_session, "owner", "cal-o", "이건 ics 가 아님")


@pytest.mark.asyncio
async def test_caldav_report_query_includes_rrule_and_exceptions(db_session):
    """REPORT calendar-query(휴대폰 동기화 경로)가 RRULE·EXDATE·RECURRENCE-ID·ATTENDEE 를 포함한다."""
    from types import SimpleNamespace
    from app.dav.router import DavApp

    await _seed(db_session)
    ev = await _weekly(db_session)
    await service.delete_occurrence(db_session, "owner", ev["id"], datetime(2026, 10, 12, 1, tzinfo=UTC))
    await service.update_occurrence(db_session, "owner", ev["id"], datetime(2026, 10, 19, 1, tzinfo=UTC),
                                    {"title": "바뀐 회차"})
    body = (b'<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
            b'<D:prop><D:getetag/><C:calendar-data/></D:prop>'
            b'<C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>')

    class Req:
        async def body(self):
            return body

    owner = await db_session.get(User, "owner")
    resp = await DavApp()._report(Req(), {"type": "calendar", "col": "cal-o"}, owner, db_session, "/dav")
    text = resp.body.decode()
    assert resp.status_code == 207
    assert text.count(f"{ev['id']}.ics") == 1  # 회차 예외는 같은 리소스 안
    for needle in ("RRULE:FREQ=WEEKLY", "EXDATE", "RECURRENCE-ID", "ATTENDEE", "바뀐 회차"):
        assert needle in text, needle
