"""캘린더·연락처·작업 구역 전수조사 수정 사항 고정.

- 예외 회차(이 일정만 수정한 행) 삭제 범위: this/범위 없음 = 해당 회차만, all = 시리즈 전체(화면은 범위를 확인한다)
- 일정 수정: 전송된 null 은 비운다(알림 없음·반복 안 함·반복 종료 없음·설명·장소), 제목·시작·끝 null 은 변경 없음
- 쓰기 공유 캘린더의 일정 수정, 2년 넘은 반복 일정, 알림(시작 시각·이동한 회차·회차 링크), 공유 대상 없음 400
- 연락처: 비우기, CardDAV PUT 전체 교체, vCard 가져오기(중복·CP949·손상 파일)
- 작업: 상위 소유자의 하위 작업 삭제, parent_id 검증
"""

import io
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile

from app.calendar import reminder
from app.calendar import router as cal_router
from app.calendar import rrule_guard, service
from app.calendar.schemas import CalendarShareRequest, CalendarSharee, EventUpdate
from app.contacts import router as c_router
from app.contacts.schemas import ContactCreate, ContactUpdate
from app.dav import service as dav_svc
from app.dav.vcard_utils import vcard_to_contact_data
from app.db.models import (
    AddressBookDB, CalendarDB, CalendarEventDB, CalendarShareDB, ContactDB, Notification, User,
)
from app.tasks import router as t_router
from app.tasks.schemas import TaskCreate, TaskUpdate

UTC = timezone.utc


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    from app.notifications import service as ns

    async def _no_deliver(*a, **kw):
        return None

    monkeypatch.setattr(ns, "_deliver", _no_deliver)

    async def _no_mail(*a, **kw):
        return None

    monkeypatch.setattr(service, "_send_cancel_mails", _no_mail)


async def _seed(db):
    for uid in ("owner", "guest", "other"):
        db.add(User(id=uid, username=uid, email=f"{uid}@x.io", password_hash="x", display_name=uid.upper()))
    await db.commit()
    db.add(CalendarDB(id="cal-o", user_id="owner", name="내 캘린더", color="#3b82f6"))
    db.add(CalendarDB(id="cal-g", user_id="guest", name="손님 캘린더", color="#22c55e"))
    db.add(CalendarDB(id="cal-x", user_id="other", name="남의 캘린더", color="#ef4444"))
    await db.commit()
    return [await db.get(User, u) for u in ("owner", "guest", "other")]


async def _weekly(db, start="2026-10-01T06:00:00Z", end="2026-10-01T07:00:00Z", **extra):
    return await service.create_event(db, "owner", {
        "calendar_id": "cal-o", "title": "주간 회의", "start": start, "end": end,
        "recurrence_rule": "FREQ=WEEKLY", **extra,
    })


async def _starts(db, uid="owner", start="2026-09-28T00:00:00Z", end="2026-11-01T00:00:00Z"):
    evs = await service.get_events(db, uid, start, end)
    return sorted(e["start"][:16] for e in evs if e["title"].startswith("주간 회의"))


# ─── 1. 예외 회차 삭제 ───


@pytest.mark.asyncio
async def test_delete_exception_row_keeps_series(db_session):
    db = db_session
    owner, *_ = await _seed(db)
    m = await _weekly(db)
    occ = datetime(2026, 10, 15, 6, tzinfo=UTC)
    ex_id = await service.update_occurrence(db, "owner", m["id"], occ, {
        "start": "2026-10-16T06:00:00Z", "end": "2026-10-16T07:00:00Z", "title": "주간 회의(옮김)"})
    assert "2026-10-16T06:00" in await _starts(db)

    # 화면이 예외 회차에 전송하는 값: 범위 "이 일정만" → 해당 회차만 삭제되고 시리즈는 유지
    await cal_router.delete_event(event_id=ex_id, occurrence=None, user=owner, db=db, scope="this", notify=False)
    assert await db.get(CalendarEventDB, m["id"]) is not None
    assert await db.get(CalendarEventDB, ex_id) is None
    got = await _starts(db)
    assert "2026-10-16T06:00" not in got and "2026-10-15T06:00" not in got   # 원래 회차도 복원되지 않음
    assert got == ["2026-10-01T06:00", "2026-10-08T06:00", "2026-10-22T06:00", "2026-10-29T06:00"]

    # 범위 없이 예외 행 id 만 전달해도 동일(시리즈 전체가 아님)
    ex2 = await service.update_occurrence(db, "owner", m["id"], datetime(2026, 10, 22, 6, tzinfo=UTC), {"title": "주간 회의 x"})
    await cal_router.delete_event(event_id=ex2, occurrence=None, user=owner, db=db, scope=None, notify=False)
    assert await db.get(CalendarEventDB, m["id"]) is not None
    assert len(await _starts(db)) == 3

    # scope=all 은 문서대로 시리즈 전체 — 따라서 화면은 예외 회차에도 범위를 확인한다
    ex3 = await service.update_occurrence(db, "owner", m["id"], datetime(2026, 10, 29, 6, tzinfo=UTC), {"title": "주간 회의 y"})
    await cal_router.delete_event(event_id=ex3, occurrence=None, user=owner, db=db, scope="all", notify=False)
    assert await db.get(CalendarEventDB, m["id"]) is None
    assert await _starts(db) == []


# ─── 3. 전송된 null 은 비운다 ───


@pytest.mark.asyncio
async def test_update_null_clears_but_unset_and_guarded_fields_stay(db_session):
    db = db_session
    owner, *_ = await _seed(db)
    m = await _weekly(db, reminder_minutes=10, description="안건", location="3층",
                      recurrence_rule="FREQ=WEEKLY;UNTIL=20261015T235959Z",
                      recurrence_end="2026-10-15T23:59:59Z")
    eid = m["id"]

    # 전송하지 않은 필드는 유지
    await cal_router.update_event(event_id=eid, body=EventUpdate(title="주간 회의 2"), occurrence=None, user=owner, db=db)
    ev = await db.get(CalendarEventDB, eid)
    await db.refresh(ev)
    assert ev.title == "주간 회의 2" and ev.reminder_minutes == 10 and ev.description == "안건"
    assert ev.location == "3층" and ev.recurrence_rule and ev.recurrence_end is not None

    # 반복 종료를 "계속"으로 변경: 규칙에서 UNTIL 을 제거하고 recurrence_end=null → 이후 회차가 다시 전개됨
    await cal_router.update_event(
        event_id=eid, body=EventUpdate(recurrence_rule="FREQ=WEEKLY", recurrence_end=None),
        occurrence=None, user=owner, db=db)
    await db.refresh(ev)
    assert ev.recurrence_end is None
    assert "2026-10-29T06:00" in await _starts(db)

    # 알림 없음 · 설명·장소 비우기 · 제목/시작/끝 null 은 변경 없음
    await cal_router.update_event(
        event_id=eid,
        body=EventUpdate(reminder_minutes=None, description="", location="", title=None, start=None, end=None,
                         all_day=None, calendar_id=None, attendees=None),
        occurrence=None, user=owner, db=db)
    await db.refresh(ev)
    assert ev.reminder_minutes is None and not ev.description and ev.location is None
    assert ev.title == "주간 회의 2" and ev.start is not None and ev.end is not None
    assert ev.all_day is False and ev.calendar_id == "cal-o"

    # 반복 안 함
    await cal_router.update_event(event_id=eid, body=EventUpdate(recurrence_rule=None, recurrence_end=None),
                                  occurrence=None, user=owner, db=db)
    await db.refresh(ev)
    assert ev.recurrence_rule is None
    assert await _starts(db) == ["2026-10-01T06:00"]

    # 아무 필드도 전송하지 않으면 400
    with pytest.raises(HTTPException) as e:
        await cal_router.update_event(event_id=eid, body=EventUpdate(), occurrence=None, user=owner, db=db)
    assert e.value.status_code == 400


# ─── 2. 쓰기 공유 캘린더 ───


@pytest.mark.asyncio
async def test_shared_writer_can_edit_and_move_is_checked(db_session):
    db = db_session
    owner, guest, other = await _seed(db)
    db.add(CalendarShareDB(calendar_id="cal-o", shared_with_user_id="guest", can_write=True))
    db.add(CalendarShareDB(calendar_id="cal-o", shared_with_user_id="other", can_write=False))
    await db.commit()
    ev = await service.create_event(db, "owner", {
        "calendar_id": "cal-o", "title": "공유 일정", "start": "2026-10-05T01:00:00Z", "end": "2026-10-05T02:00:00Z"})

    # 폼은 동일한 calendar_id 를 항상 전송
    await cal_router.update_event(event_id=ev["id"], body=EventUpdate(calendar_id="cal-o", title="고침"),
                                  occurrence=None, user=guest, db=db)
    row = await db.get(CalendarEventDB, ev["id"])
    await db.refresh(row)
    assert row.title == "고침"

    # 읽기 전용 공유는 여전히 수정 불가
    with pytest.raises(HTTPException) as e:
        await cal_router.update_event(event_id=ev["id"], body=EventUpdate(calendar_id="cal-o", title="x"),
                                      occurrence=None, user=other, db=db)
    assert e.value.status_code == 404

    # 쓰기 불가 캘린더로는 이동 불가 / 본인 캘린더로는 이동 가능
    with pytest.raises(HTTPException):
        await cal_router.update_event(event_id=ev["id"], body=EventUpdate(calendar_id="cal-x"),
                                      occurrence=None, user=guest, db=db)
    await db.refresh(row)
    assert row.calendar_id == "cal-o"
    await cal_router.update_event(event_id=ev["id"], body=EventUpdate(calendar_id="cal-g"),
                                  occurrence=None, user=guest, db=db)
    await db.refresh(row)
    assert row.calendar_id == "cal-g"


# ─── 5. 2년 넘은 반복 일정 ───


@pytest.mark.asyncio
async def test_old_recurring_event_still_shows_and_scan_is_bounded(db_session):
    db = db_session
    await _seed(db)
    await _weekly(db, start="2021-10-07T06:00:00Z", end="2021-10-07T07:00:00Z")   # 5년 전 목요일
    await service.create_event(db, "owner", {
        "calendar_id": "cal-o", "title": "생일", "start": "2015-10-20T00:00:00Z", "end": "2015-10-21T00:00:00Z",
        "all_day": True, "recurrence_rule": "FREQ=YEARLY"})
    evs = await service.get_events(db, "owner", "2026-10-01T00:00:00Z", "2026-10-31T23:59:59Z")
    weekly = sorted(e["start"][:10] for e in evs if e["title"] == "주간 회의")
    assert weekly == ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29"]
    assert [e["start"][:10] for e in evs if e["title"] == "생일"] == ["2026-10-20"]

    # 순회 상한은 유지 — 매우 오래된 조밀한 규칙은 상한에서 중단된다(무한 반복 방지)
    await service.create_event(db, "owner", {
        "calendar_id": "cal-o", "title": "매시간", "start": "2000-01-01T00:00:00Z", "end": "2000-01-01T00:10:00Z",
        "recurrence_rule": "FREQ=HOURLY"})
    evs = await service.get_events(db, "owner", "2026-10-01T00:00:00Z", "2026-10-31T23:59:59Z")
    assert [e for e in evs if e["title"] == "매시간"] == []          # 2만 회 순회해도 2026 년에 도달하지 못함
    evs = await service.get_events(db, "owner", "2000-01-01T00:00:00Z", "2001-01-01T00:00:00Z")
    assert len([e for e in evs if e["title"] == "매시간"]) == rrule_guard.MAX_OCCURRENCES


# ─── 4·9·14. 알림 ───


def _ev(**kw):
    base = dict(id="e1", calendar_id="cal-o", title="t", reminder_minutes=0, reminder_sent=False,
                recurrence_rule=None, exdates=None, recurrence_end=None, reminder_last_sent_for=None)
    base.update(kw)
    return CalendarEventDB(**base)


def test_reminder_at_start_fires_within_grace():
    start = datetime(2026, 10, 1, 6, tzinfo=UTC)
    ev = _ev(start=start, end=start + timedelta(hours=1))
    assert reminder._due_occurrence(ev, start - timedelta(seconds=30)) is None      # 시각 미도달
    assert reminder._due_occurrence(ev, start + timedelta(seconds=20)) == start     # 시작 직후 검사에서 발송
    assert reminder._due_occurrence(ev, start + timedelta(minutes=6)) is None       # 유예 경과 후에는 발송하지 않음
    ev.reminder_sent = True
    assert reminder._due_occurrence(ev, start + timedelta(seconds=20)) is None

    # 반복 일정의 "시작 시각" 알림 + 동일 회차 중복 발송 방지
    rec = _ev(start=start, end=start + timedelta(hours=1), recurrence_rule="FREQ=WEEKLY")
    occ = start + timedelta(days=7)
    assert reminder._due_occurrence(rec, occ - timedelta(minutes=1)) is None
    assert reminder._due_occurrence(rec, occ + timedelta(seconds=20)) == occ
    rec.reminder_last_sent_for = occ
    assert reminder._due_occurrence(rec, occ + timedelta(seconds=80)) is None

    # 10분 전 알림은 기존과 동일하며, 이미 알린 회차가 유예 창에 남아 있어도 다음 회차를 누락하지 않는다
    daily = _ev(start=start, end=start + timedelta(hours=1), recurrence_rule="FREQ=DAILY", reminder_minutes=1440)
    daily.reminder_last_sent_for = start + timedelta(days=1)
    assert reminder._due_occurrence(daily, start + timedelta(days=1, seconds=30)) == start + timedelta(days=2)


def test_reminder_skips_moved_occurrence():
    start = datetime(2026, 10, 1, 6, tzinfo=UTC)
    rec = _ev(start=start, end=start + timedelta(hours=1), recurrence_rule="FREQ=WEEKLY", reminder_minutes=10)
    occ = start + timedelta(days=7)
    now = occ - timedelta(minutes=5)
    assert reminder._due_occurrence(rec, now) == occ
    assert reminder._due_occurrence(rec, now, moved=[occ]) is None       # 이동한 회차는 원래 시각에 알리지 않음
    assert reminder._due_occurrence(rec, now, moved=[occ.replace(tzinfo=None)]) is None   # SQLite 의 naive 값도 동일


@pytest.mark.asyncio
async def test_reminder_link_points_to_occurrence_and_get_event_resolves_it(db_session):
    db = db_session
    owner, guest, _ = await _seed(db)
    now = datetime.now(UTC).replace(microsecond=0)
    first = now - timedelta(days=21) + timedelta(minutes=5)      # 3주 전 시작, 오늘 회차는 5분 뒤
    m = await _weekly(db, start=first.isoformat(), end=(first + timedelta(hours=1)).isoformat(), reminder_minutes=10)
    assert await reminder.check_and_send_reminders(db) == 1
    n = (await db.execute(Notification.__table__.select())).first()
    occ = first + timedelta(days=21)
    oid = f"{m['id']}_{occ.strftime('%Y%m%dT%H%M%S')}"
    assert n.link == f"/calendar?event={oid}"

    got = await cal_router.get_event(event_id=oid, user=owner, db=db)
    assert got.id == oid and got.is_occurrence and got.original_event_id == m["id"]
    assert got.start[:19] == occ.isoformat()[:19] and got.end[:19] == (occ + timedelta(hours=1)).isoformat()[:19]

    # 타 사용자는 조회 불가 / 존재하지 않는 마스터는 404
    with pytest.raises(HTTPException) as e:
        await cal_router.get_event(event_id=oid, user=guest, db=db)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException):
        await cal_router.get_event(event_id="nope_20261001T060000", user=owner, db=db)

    # 해당 회차가 "이 일정만" 수정된 예외이면 그 행을 반환
    ex_id = await service.update_occurrence(db, "owner", m["id"], occ, {"title": "주간 회의(옮김)"})
    got = await cal_router.get_event(event_id=oid, user=owner, db=db)
    assert got.id == ex_id and got.is_exception


# ─── 6. 공유 대상 없음 ───


@pytest.mark.asyncio
async def test_share_unknown_user_is_400_and_changes_nothing(db_session):
    db = db_session
    owner, *_ = await _seed(db)
    ok = await cal_router.set_calendar_shares(
        calendar_id="cal-o", body=CalendarShareRequest(shares=[CalendarSharee(email="guest@x.io", can_write=True)]),
        user=owner, db=db)
    assert ok == {"ok": True}
    for bad in ("typo@x.io", "owner@x.io"):
        with pytest.raises(HTTPException) as e:
            await cal_router.set_calendar_shares(
                calendar_id="cal-o",
                body=CalendarShareRequest(shares=[CalendarSharee(email="guest@x.io"), CalendarSharee(email=bad)]),
                user=owner, db=db)
        assert e.value.status_code == 400
    shares = await cal_router.list_calendar_shares(calendar_id="cal-o", user=owner, db=db)
    assert [(s.email, s.can_write) for s in shares] == [("guest@x.io", True)]


# ─── 7·11·12. 연락처 ───


async def _book(db):
    owner, *_ = await _seed(db)
    db.add(AddressBookDB(id="ab", user_id="owner", name="기본", is_default=True))
    await db.commit()
    return owner


@pytest.mark.asyncio
async def test_contact_fields_can_be_cleared(db_session):
    db = db_session
    owner = await _book(db)
    c = await c_router.create_contact(body=ContactCreate(
        address_book_id="ab", name="김철수", first_name="철수", last_name="김", organization="Acme",
        notes="메모", title="팀장"), user=owner, db=db)
    await c_router.update_contact(contact_id=c.id, body=ContactUpdate(is_favorite=True), user=owner, db=db)
    got = await c_router.get_contact(contact_id=c.id, user=owner, db=db)
    assert got.organization == "Acme" and got.notes == "메모" and got.first_name == "철수"   # 전송하지 않은 필드는 유지

    await c_router.update_contact(contact_id=c.id, body=ContactUpdate(
        name=None, organization="", notes="", first_name=None, last_name="", emails=None), user=owner, db=db)
    got = await c_router.get_contact(contact_id=c.id, user=owner, db=db)
    assert got.organization is None and got.notes is None and got.first_name is None and got.last_name is None
    assert got.name == "김철수" and got.title == "팀장" and got.is_favorite


VCARD_FULL = ("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Kim\r\nN:Kim;;;;\r\nORG:Acme\r\nEMAIL;TYPE=WORK:kim@x.io\r\n"
              "TEL;TYPE=CELL:010-1111-2222\r\nNOTE:memo\r\nEND:VCARD\r\n")
VCARD_BARE = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Kim\r\nN:Kim;;;;\r\nEND:VCARD\r\n"


@pytest.mark.asyncio
async def test_carddav_put_replaces_whole_contact(db_session):
    db = db_session
    await _book(db)
    await dav_svc.upsert_contact(db, "c1", "ab", vcard_to_contact_data(VCARD_FULL))
    c = await db.get(ContactDB, "c1")
    assert c.organization == "Acme" and "kim@x.io" in c.emails and "010-1111-2222" in c.phones and c.notes == "memo"
    # 휴대폰에서 전화·메일·메모·소속을 삭제하고 업로드 → 서버에서도 삭제됨
    await dav_svc.upsert_contact(db, "c1", "ab", vcard_to_contact_data(VCARD_BARE))
    await db.refresh(c)
    assert c.full_name == "Kim" and c.organization is None and c.emails is None and c.phones is None and c.notes is None


def _upload(raw: bytes) -> UploadFile:
    return UploadFile(file=io.BytesIO(raw), filename="c.vcf")


@pytest.mark.asyncio
async def test_vcf_import_dedupes_cp949_and_broken_tail(db_session):
    db = db_session
    owner = await _book(db)
    two = (VCARD_FULL + "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Lee\r\nN:Lee;;;;\r\nEND:VCARD\r\n").encode()
    r = await c_router.import_vcf(file=_upload(two), book_id="ab", user=owner, db=db)
    assert (r["imported"], r["skipped"], r["errors"]) == (2, 0, 0)
    # 동일 파일 재가져오기 → 중복 없음
    r = await c_router.import_vcf(file=_upload(two), book_id="ab", user=owner, db=db)
    assert (r["imported"], r["skipped"]) == (0, 2)

    # CP949 파일의 한글 이름
    ko = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:홍길동\r\nN:홍;길동;;;\r\nEND:VCARD\r\n".encode("cp949")
    r = await c_router.import_vcf(file=_upload(ko), book_id="ab", user=owner, db=db)
    assert r["imported"] == 1
    lst = await c_router.list_contacts(q="홍길동", book_id=None, page=0, limit=50, favorite=None, group=None, user=owner, db=db)
    assert [c.name for c in lst["contacts"]] == ["홍길동"]

    # 뒷부분이 손상된 파일 — 500 이 아니라 읽은 부분까지 처리 + errors
    broken = ("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Park\r\nN:Park;;;;\r\nEND:VCARD\r\n"
              "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bad\r\nthis line is not a property\r\n").encode()
    r = await c_router.import_vcf(file=_upload(broken), book_id="ab", user=owner, db=db)
    assert r["ok"] and r["imported"] == 1 and r["errors"] >= 1


# ─── 13. 작업 ───


@pytest.mark.asyncio
async def test_parent_owner_deletes_assignee_subtask_and_parent_id_is_validated(db_session):
    db = db_session
    owner, guest, other = await _seed(db)
    parent = await t_router.create_task(body=TaskCreate(title="상위", assignee_id="guest"), user=owner, db=db)
    sub = await t_router.create_task(body=TaskCreate(title="담당자가 넣은 항목", parent_id=parent.id), user=guest, db=db)
    assert sub.user_id == "guest"
    # 상위 작업 생성자는 담당자가 추가한 하위 작업을 삭제할 수 있다
    assert await t_router.delete_task(task_id=sub.id, user=owner, db=db) == {"ok": True}
    # 담당자는 여전히 타 사용자(소유자)의 최상위 작업을 삭제할 수 없다
    with pytest.raises(HTTPException) as e:
        await t_router.delete_task(task_id=parent.id, user=guest, db=db)
    assert e.value.status_code == 403

    mine = await t_router.create_task(body=TaskCreate(title="남의 작업"), user=other, db=db)
    # 타 사용자의 작업 하위로 삽입 · 자기 자신 · 2단계 · 하위가 있는 작업 이동 → 400
    for tid, pid, user in ((mine.id, parent.id, other), (parent.id, parent.id, owner)):
        with pytest.raises(HTTPException) as e:
            await t_router.update_task(task_id=tid, body=TaskUpdate(parent_id=pid), user=user, db=db)
        assert e.value.status_code == 400
    a = await t_router.create_task(body=TaskCreate(title="A"), user=owner, db=db)
    child = await t_router.create_task(body=TaskCreate(title="A-1", parent_id=a.id), user=owner, db=db)
    b = await t_router.create_task(body=TaskCreate(title="B"), user=owner, db=db)
    for tid, pid in ((b.id, child.id), (a.id, b.id)):
        with pytest.raises(HTTPException) as e:
            await t_router.update_task(task_id=tid, body=TaskUpdate(parent_id=pid), user=owner, db=db)
        assert e.value.status_code == 400
    # 정상 이동은 허용
    moved = await t_router.update_task(task_id=b.id, body=TaskUpdate(parent_id=a.id), user=owner, db=db)
    assert moved.parent_id == a.id
