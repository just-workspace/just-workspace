"""반복 일정 삭제 범위 — 이 일정만 / 이후 모두 / 반복 전체 + 참석자 취소 알림.

라우터 함수를 직접 부른다(db_session = SQLite). 취소 메일은 가짜로 갈아 끼워 받는 사람만 본다.
"""

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.calendar import router as cal_router
from app.calendar import service
from app.db.models import CalendarDB, CalendarEventDB, Notification, User

UTC = timezone.utc


@pytest.fixture()
def mails(monkeypatch):
    sent: list[dict] = []

    async def _fake(emails, title, start, end, uid, organizer_name, organizer_email, scope, occ_start):
        sent.append({"emails": emails, "title": title, "scope": scope, "occ": occ_start})

    monkeypatch.setattr(service, "_send_cancel_mails", _fake)

    from app.notifications import service as ns

    async def _no_deliver(*a, **kw):
        return None

    monkeypatch.setattr(ns, "_deliver", _no_deliver)
    return sent


async def _seed(db):
    for uid, email in (("owner", "owner@x.io"), ("guest", "guest@x.io"), ("other", "other@x.io")):
        db.add(User(id=uid, username=uid, email=email, password_hash="x", display_name=uid.upper()))
    await db.commit()
    db.add(CalendarDB(id="cal-o", user_id="owner", name="내 캘린더", color="#3b82f6"))
    await db.commit()


async def _weekly(db):
    return await service.create_event(db, "owner", {
        "calendar_id": "cal-o",
        "title": "4분기 킥오프",
        "start": "2026-10-01T06:00:00Z",  # 목 15:00 KST
        "end": "2026-10-01T07:00:00Z",
        "recurrence_rule": "FREQ=WEEKLY;BYDAY=TH",
        "attendees": [{"email": "guest@x.io"}, {"email": "outside@ext.com"}, {"email": "owner@x.io"}],
    })


async def _starts(db, owner, start="2026-09-28T00:00:00Z", end="2026-11-30T00:00:00Z"):
    evs = await service.get_events(db, owner.id, start, end)
    return sorted(e["start"][:10] for e in evs if e["title"] == "4분기 킥오프")


def _call(db, user, event_id, **kw):
    return cal_router.delete_event(event_id=event_id, occurrence=kw.pop("occurrence", None), user=user, db=db, **kw)


@pytest.mark.asyncio
async def test_rrule_until_before_replaces_count():
    r = service.rrule_until_before("RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=TH", datetime(2026, 10, 15, 6, tzinfo=UTC))
    assert r == "FREQ=WEEKLY;BYDAY=TH;UNTIL=20261015T055959Z"


@pytest.mark.asyncio
async def test_scope_this_removes_one(db_session, mails):
    await _seed(db_session)
    owner = await db_session.get(User, "owner")
    ev = await _weekly(db_session)
    r = await _call(db_session, owner, ev["id"], occurrence="2026-10-15T06:00:00Z", scope="this")
    assert r == {"ok": True, "notified": 0}
    starts = await _starts(db_session, owner)
    assert "2026-10-15" not in starts and "2026-10-08" in starts and "2026-10-22" in starts


@pytest.mark.asyncio
async def test_scope_following_cuts_series_and_drops_later_exceptions(db_session, mails):
    await _seed(db_session)
    owner = await db_session.get(User, "owner")
    ev = await _weekly(db_session)
    # 뒤쪽 회차 하나는 예외 행(시간 변경)으로 만들어 둔다 — 끊은 뒤 남으면 안 된다
    await service.update_occurrence(db_session, "owner", ev["id"], datetime(2026, 10, 29, 6, tzinfo=UTC),
                                    {"title": "4분기 킥오프", "start": "2026-10-29T08:00:00Z", "end": "2026-10-29T09:00:00Z"})
    r = await _call(db_session, owner, ev["id"], occurrence="2026-10-15T06:00:00Z", scope="following")
    assert r["ok"]
    starts = await _starts(db_session, owner)
    assert starts == ["2026-10-01", "2026-10-08"]
    rows = (await db_session.execute(select(CalendarEventDB).where(CalendarEventDB.parent_event_id == ev["id"]))).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_scope_following_from_first_deletes_all(db_session, mails):
    await _seed(db_session)
    owner = await db_session.get(User, "owner")
    ev = await _weekly(db_session)
    await _call(db_session, owner, ev["id"], occurrence="2026-10-01T06:00:00Z", scope="following")
    assert await db_session.get(CalendarEventDB, ev["id"]) is None


@pytest.mark.asyncio
async def test_scope_following_needs_occurrence(db_session, mails):
    await _seed(db_session)
    owner = await db_session.get(User, "owner")
    ev = await _weekly(db_session)
    with pytest.raises(HTTPException) as e:
        await _call(db_session, owner, ev["id"], scope="following")
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_scope_all_from_occurrence_id_deletes_master(db_session, mails):
    await _seed(db_session)
    owner = await db_session.get(User, "owner")
    ev = await _weekly(db_session)
    await _call(db_session, owner, f"{ev['id']}_20261015T060000", scope="all")
    assert await db_session.get(CalendarEventDB, ev["id"]) is None


@pytest.mark.asyncio
async def test_notify_sends_to_attendees_except_me(db_session, mails):
    await _seed(db_session)
    owner = await db_session.get(User, "owner")
    ev = await _weekly(db_session)
    r = await _call(db_session, owner, ev["id"], occurrence="2026-10-15T06:00:00Z", scope="this", notify=True)
    assert r["notified"] == 2
    await asyncio.sleep(0)  # 취소 메일은 뒤에서(create_task) 나간다
    assert sorted(mails[0]["emails"]) == ["guest@x.io", "outside@ext.com"]
    assert mails[0]["scope"] == "this"
    notes = (await db_session.execute(select(Notification).where(Notification.user_id == "guest"))).scalars().all()
    assert any(n.title == "일정 취소: 4분기 킥오프" for n in notes)
    # 나(주최자)에게는 알리지 않는다
    mine = (await db_session.execute(
        select(Notification).where(Notification.user_id == "owner", Notification.title.like("일정 취소%"))
    )).scalars().all()
    assert mine == []


@pytest.mark.asyncio
async def test_other_user_cannot_delete_following(db_session, mails):
    await _seed(db_session)
    other = await db_session.get(User, "other")
    ev = await _weekly(db_session)
    with pytest.raises(HTTPException) as e:
        await _call(db_session, other, ev["id"], occurrence="2026-10-15T06:00:00Z", scope="following", notify=True)
    assert e.value.status_code == 404
    assert mails == []


def test_cancel_ics_single_occurrence_has_recurrence_id():
    ics = service.cancel_ics("uid-1", "회의", datetime(2026, 10, 15, 6, tzinfo=UTC), None, "주최", "o@x.io",
                             ["g@x.io"], recurrence_id=datetime(2026, 10, 15, 6, tzinfo=UTC), whole_series=False)
    assert "METHOD:CANCEL" in ics and "RECURRENCE-ID:20261015T060000Z" in ics and "ATTENDEE:mailto:g@x.io" in ics
    whole = service.cancel_ics("uid-1", "회의", datetime(2026, 10, 15, 6, tzinfo=UTC), None, "주최", "o@x.io", ["g@x.io"])
    assert "RECURRENCE-ID" not in whole
