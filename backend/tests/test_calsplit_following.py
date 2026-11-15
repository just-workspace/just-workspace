"""반복 일정 "이 일정과 이후 모두" 수정 — 서버가 한 트랜잭션으로 시리즈를 둘로 나눈다(PATCH ?scope=following).

이후 구간에 있던 지운 회차(EXDATE)는 새 시리즈에서도 지운 채, "이 일정만" 수정한 회차는 새 시리즈의 예외로
옮겨 보존한다. 날짜가 옮겨졌거나 규칙이 바뀌어 그 회차가 새 시리즈에 없으면 버린다.
라우터 함수를 직접 부른다(db_session = SQLite).
"""

from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.calendar import router as cal_router
from app.calendar import service
from app.calendar.schemas import EventUpdate
from app.db.models import CalendarDB, CalendarEventAttendee, CalendarEventDB, Notification, User

UTC = timezone.utc


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    from app.notifications import service as ns

    async def _no_deliver(*a, **kw):
        return None

    monkeypatch.setattr(ns, "_deliver", _no_deliver)


async def _seed(db):
    for uid, email in (("owner", "owner@x.io"), ("guest", "guest@x.io"), ("late", "late@x.io"), ("other", "other@x.io")):
        db.add(User(id=uid, username=uid, email=email, password_hash="x", display_name=uid.upper()))
    await db.commit()
    db.add(CalendarDB(id="cal-o", user_id="owner", name="내 캘린더", color="#3b82f6"))
    db.add(CalendarDB(id="cal-2", user_id="owner", name="둘째", color="#10b981"))
    db.add(CalendarDB(id="cal-x", user_id="other", name="남의 것", color="#ef4444"))
    await db.commit()
    return await db.get(User, "owner")


async def _weekly(db, **kw):
    return await service.create_event(db, "owner", {
        "calendar_id": "cal-o",
        "title": "주간 회의",
        "location": "3층",
        "start": "2026-10-01T06:00:00Z",  # 목 15:00 KST
        "end": "2026-10-01T07:00:00Z",
        "timezone": "Asia/Seoul",
        "recurrence_rule": "FREQ=WEEKLY;BYDAY=TH",
        **kw,
    })


def _dt(day: int, hour: int = 6, month: int = 10) -> datetime:
    return datetime(2026, month, day, hour, tzinfo=UTC)


async def _split(db, user, event_id, occurrence, **fields):
    return await cal_router.update_event(
        event_id=event_id, body=EventUpdate(**fields), occurrence=occurrence, user=user, db=db, scope="following",
    )


async def _children(db, master_id):
    rows = (await db.execute(
        select(CalendarEventDB).where(CalendarEventDB.parent_event_id == master_id)
    )).scalars().all()
    return {service._utc(r.recurrence_id).isoformat()[:16]: r for r in rows}


async def _shown(db, start="2026-09-28T00:00:00Z", end="2026-11-30T00:00:00Z"):
    evs = await service.get_events(db, "owner", start, end)
    return sorted((e["start"][:16], e["title"]) for e in evs)


async def _with_exceptions(db):
    """10/08 예외(분할 앞), 10/22 예외(제목·시각 변경), 11/05 예외(장소만), 10/29 삭제."""
    ev = await _weekly(db)
    mid = ev["id"]
    await service.update_occurrence(db, "owner", mid, _dt(8), {"title": "앞쪽 예외"})
    await service.update_occurrence(db, "owner", mid, _dt(22), {
        "title": "특별 회의", "start": "2026-10-22T08:00:00Z", "end": "2026-10-22T09:00:00Z"})
    await service.update_occurrence(db, "owner", mid, _dt(5, month=11), {"location": "대회의실"})
    await service.delete_occurrence(db, "owner", mid, _dt(29))
    return mid


@pytest.mark.asyncio
async def test_title_change_keeps_later_exceptions_and_deleted(db_session):
    owner = await _seed(db_session)
    mid = await _with_exceptions(db_session)
    r = await _split(db_session, owner, mid, "2026-10-15T06:00:00Z", title="새 제목", location="5층")
    new_id = r["id"]
    assert r["ok"] and new_id != mid

    old = await db_session.get(CalendarEventDB, mid)
    assert old.recurrence_rule == "FREQ=WEEKLY;BYDAY=TH;UNTIL=20261015T055959Z"
    assert service.parse_exdates(old.exdates) == []
    assert list(await _children(db_session, mid)) == ["2026-10-08T06:00"]      # 앞쪽 예외는 옛 시리즈에 그대로

    new = await db_session.get(CalendarEventDB, new_id)
    assert new.title == "새 제목" and new.recurrence_rule == "FREQ=WEEKLY;BYDAY=TH"
    assert service._utc(new.start) == _dt(15) and new.timezone == "Asia/Seoul"
    assert service.parse_exdates(new.exdates) == [_dt(29)]                       # 지운 회차는 계속 지운 채
    kids = await _children(db_session, new_id)
    assert sorted(kids) == ["2026-10-22T06:00", "2026-11-05T06:00"]
    # 따로 고친 칸은 예외 값 그대로, 안 고친 칸은 새 값을 따른다
    assert kids["2026-10-22T06:00"].title == "특별 회의" and kids["2026-10-22T06:00"].location == "5층"
    assert service._utc(kids["2026-10-22T06:00"].start) == _dt(22, 8)
    assert kids["2026-11-05T06:00"].title == "새 제목" and kids["2026-11-05T06:00"].location == "대회의실"

    assert await _shown(db_session, end="2026-11-13T00:00:00Z") == [
        ("2026-10-01T06:00", "주간 회의"), ("2026-10-08T06:00", "앞쪽 예외"),
        ("2026-10-15T06:00", "새 제목"), ("2026-10-22T08:00", "특별 회의"),
        ("2026-11-05T06:00", "새 제목"), ("2026-11-12T06:00", "새 제목"),
    ]


@pytest.mark.asyncio
async def test_time_shift_same_day_moves_exceptions_with_series(db_session):
    owner = await _seed(db_session)
    mid = await _with_exceptions(db_session)
    r = await _split(db_session, owner, mid, "2026-10-15T06:00:00Z",
                     start="2026-10-15T08:00:00Z", end="2026-10-15T09:30:00Z")
    new = await db_session.get(CalendarEventDB, r["id"])
    assert service.parse_exdates(new.exdates) == [_dt(29, 8)]
    kids = await _children(db_session, new.id)
    assert sorted(kids) == ["2026-10-22T08:00", "2026-11-05T08:00"]              # 원래 회차 = 새 시각의 그 회차
    # 시각을 따로 옮겼던 예외는 자기 시각 그대로
    assert service._utc(kids["2026-10-22T08:00"].start) == _dt(22, 8)
    assert service._utc(kids["2026-10-22T08:00"].end) == _dt(22, 9)
    # 시각을 안 건드린 예외(장소만)는 새 시각·새 길이를 따른다
    moved = kids["2026-11-05T08:00"]
    assert service._utc(moved.start) == _dt(5, 8, 11)
    assert service._utc(moved.end) == datetime(2026, 11, 5, 9, 30, tzinfo=UTC)
    assert moved.location == "대회의실"
    shown = await _shown(db_session, start="2026-10-14T00:00:00Z", end="2026-11-06T00:00:00Z")
    assert [s for s, _ in shown] == ["2026-10-15T08:00", "2026-10-22T08:00", "2026-11-05T08:00"]


@pytest.mark.asyncio
async def test_weekday_change_drops_exceptions_keeps_deleted(db_session):
    owner = await _seed(db_session)
    mid = await _with_exceptions(db_session)
    # 목 → 금: 예외 회차의 날짜(목요일)는 새 시리즈에 없다
    r = await _split(db_session, owner, mid, "2026-10-15T06:00:00Z",
                     start="2026-10-16T06:00:00Z", end="2026-10-16T07:00:00Z", recurrence_rule="FREQ=WEEKLY;BYDAY=FR")
    new = await db_session.get(CalendarEventDB, r["id"])
    assert await _children(db_session, new.id) == {}
    assert list(await _children(db_session, mid)) == ["2026-10-08T06:00"]
    assert service.parse_exdates(new.exdates) == [_dt(30)]                       # 지운 회차는 그 주 금요일로
    orphans = (await db_session.execute(
        select(CalendarEventAttendee).where(CalendarEventAttendee.event_id.notin_(select(CalendarEventDB.id)))
    )).scalars().all()
    assert orphans == []
    shown = await _shown(db_session, start="2026-10-14T00:00:00Z", end="2026-11-07T00:00:00Z")
    assert [s for s, _ in shown] == ["2026-10-16T06:00", "2026-10-23T06:00", "2026-11-06T06:00"]


@pytest.mark.asyncio
async def test_rule_change_drops_exceptions_whose_occurrence_is_gone(db_session):
    owner = await _seed(db_session)
    ev = await _weekly(db_session)
    mid = ev["id"]
    await service.update_occurrence(db_session, "owner", mid, _dt(22), {"title": "사라질 회차"})
    await service.update_occurrence(db_session, "owner", mid, _dt(29), {"title": "남을 회차"})
    r = await _split(db_session, owner, mid, "2026-10-15T06:00:00Z", recurrence_rule="FREQ=WEEKLY;INTERVAL=2;BYDAY=TH")
    kids = await _children(db_session, r["id"])
    assert {k: v.title for k, v in kids.items()} == {"2026-10-29T06:00": "남을 회차"}
    shown = await _shown(db_session, start="2026-10-14T00:00:00Z", end="2026-11-13T00:00:00Z")
    assert shown == [("2026-10-15T06:00", "주간 회의"), ("2026-10-29T06:00", "남을 회차"), ("2026-11-12T06:00", "주간 회의")]


@pytest.mark.asyncio
async def test_no_longer_recurring_drops_later_exceptions(db_session):
    owner = await _seed(db_session)
    mid = await _with_exceptions(db_session)
    r = await _split(db_session, owner, mid, "2026-10-15T06:00:00Z", recurrence_rule=None, recurrence_end=None)
    new = await db_session.get(CalendarEventDB, r["id"])
    assert new.recurrence_rule is None and new.exdates is None
    assert await _children(db_session, new.id) == {}
    shown = await _shown(db_session, start="2026-10-14T00:00:00Z")
    assert shown == [("2026-10-15T06:00", "주간 회의")]


@pytest.mark.asyncio
async def test_count_series_keeps_only_remaining(db_session):
    owner = await _seed(db_session)
    ev = await service.create_event(db_session, "owner", {
        "calendar_id": "cal-o", "title": "매일", "start": "2026-10-20T01:00:00Z", "end": "2026-10-20T02:00:00Z",
        "recurrence_rule": "FREQ=DAILY;COUNT=5",
    })
    await service.delete_occurrence(db_session, "owner", ev["id"], _dt(21, 1))    # 지운 회차도 COUNT 에 든다
    r = await _split(db_session, owner, ev["id"], "2026-10-22T01:00:00Z", title="바뀜", recurrence_rule="FREQ=DAILY;COUNT=5")
    new = await db_session.get(CalendarEventDB, r["id"])
    assert new.recurrence_rule == "FREQ=DAILY;COUNT=3"
    shown = await _shown(db_session, start="2026-10-19T00:00:00Z", end="2026-11-10T00:00:00Z")
    assert shown == [("2026-10-20T01:00", "매일"), ("2026-10-22T01:00", "바뀜"),
                     ("2026-10-23T01:00", "바뀜"), ("2026-10-24T01:00", "바뀜")]
    # 횟수를 직접 바꿨으면 그 값 그대로
    ev2 = await service.create_event(db_session, "owner", {
        "calendar_id": "cal-2", "title": "매일2", "start": "2026-10-20T01:00:00Z", "end": "2026-10-20T02:00:00Z",
        "recurrence_rule": "FREQ=DAILY;COUNT=5",
    })
    r2 = await _split(db_session, owner, ev2["id"], "2026-10-22T01:00:00Z", recurrence_rule="FREQ=DAILY;COUNT=7")
    assert (await db_session.get(CalendarEventDB, r2["id"])).recurrence_rule == "FREQ=DAILY;COUNT=7"


@pytest.mark.asyncio
async def test_attendees_keep_responses_and_only_new_ones_are_invited(db_session):
    owner = await _seed(db_session)
    ev = await _weekly(db_session, attendees=[{"email": "guest@x.io"}, {"email": "outside@ext.com"}])
    guest = await db_session.get(User, "guest")
    await service.rsvp(db_session, guest, ev["id"], "accepted")
    before = len((await db_session.execute(select(Notification).where(Notification.user_id == "guest"))).scalars().all())

    # 참석자를 안 보내면 그대로 물려받는다
    r = await _split(db_session, owner, ev["id"], "2026-10-15T06:00:00Z", title="새 제목")
    att = {a.email: a.response for a in (await service.load_attendees(db_session, [r["id"]]))[r["id"]]}
    assert att == {"guest@x.io": "accepted", "outside@ext.com": "needs-action"}

    # 목록을 바꾸면 새로 들어온 사람만 초대 알림
    r2 = await _split(db_session, owner, r["id"], "2026-10-29T06:00:00Z",
                      attendees=[{"email": "guest@x.io"}, {"email": "late@x.io"}])
    att2 = {a.email: a.response for a in (await service.load_attendees(db_session, [r2["id"]]))[r2["id"]]}
    assert att2 == {"guest@x.io": "accepted", "late@x.io": "needs-action"}
    after = len((await db_session.execute(select(Notification).where(Notification.user_id == "guest"))).scalars().all())
    assert after == before
    late = (await db_session.execute(select(Notification).where(Notification.user_id == "late"))).scalars().all()
    assert [n.title for n in late] == ["일정 초대: 주간 회의"] or [n.title for n in late] == ["일정 초대: 새 제목"]


@pytest.mark.asyncio
async def test_exception_row_id_resolves_to_master_and_is_absorbed(db_session):
    owner = await _seed(db_session)
    ev = await _weekly(db_session)
    ex_id = await service.update_occurrence(db_session, "owner", ev["id"], _dt(15), {"title": "이 회차만"})
    r = await _split(db_session, owner, ex_id, None, title="이후 전부")
    assert r["id"] not in (ev["id"], ex_id)
    assert await db_session.get(CalendarEventDB, ex_id) is None
    shown = await _shown(db_session, start="2026-10-07T00:00:00Z", end="2026-10-23T00:00:00Z")
    assert shown == [("2026-10-08T06:00", "주간 회의"), ("2026-10-15T06:00", "이후 전부"), ("2026-10-22T06:00", "이후 전부")]


@pytest.mark.asyncio
async def test_first_occurrence_is_whole_series_update(db_session):
    owner = await _seed(db_session)
    ev = await _weekly(db_session)
    r = await _split(db_session, owner, ev["id"], "2026-10-01T06:00:00Z", title="전체")
    assert r["id"] == ev["id"]
    rows = (await db_session.execute(select(CalendarEventDB))).scalars().all()
    assert [(x.title, x.recurrence_rule) for x in rows] == [("전체", "FREQ=WEEKLY;BYDAY=TH")]


@pytest.mark.asyncio
async def test_calendar_move_and_permissions(db_session):
    owner = await _seed(db_session)
    mid = await _with_exceptions(db_session)
    # 남의 캘린더로는 못 옮긴다 — 아무것도 바뀌지 않는다
    with pytest.raises(HTTPException) as e:
        await _split(db_session, owner, mid, "2026-10-15T06:00:00Z", calendar_id="cal-x")
    assert e.value.status_code == 404
    other = await db_session.get(User, "other")
    with pytest.raises(HTTPException) as e:
        await _split(db_session, other, mid, "2026-10-15T06:00:00Z", title="탈취")
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await _split(db_session, owner, mid, None, title="회차 없음")
    assert e.value.status_code == 400
    # 검증 실패(모르는 시간대)도 400 이고 반쯤 나뉜 상태가 남지 않는다
    with pytest.raises(HTTPException) as e:
        await _split(db_session, owner, mid, "2026-10-15T06:00:00Z", timezone="Mars/Olympus")
    assert e.value.status_code == 400
    assert not db_session.new and not db_session.dirty
    old =await db_session.get(CalendarEventDB, mid)
    assert old.recurrence_rule == "FREQ=WEEKLY;BYDAY=TH"
    assert len((await db_session.execute(select(CalendarEventDB).where(CalendarEventDB.parent_event_id.is_(None)))).scalars().all()) == 1

    r = await _split(db_session, owner, mid, "2026-10-15T06:00:00Z", calendar_id="cal-2")
    new = await db_session.get(CalendarEventDB, r["id"])
    assert new.calendar_id == "cal-2"
    kids = await _children(db_session, new.id)
    assert {k.calendar_id for k in kids.values()} == {"cal-2"}                   # 옮긴 예외도 새 캘린더로
    assert (await db_session.get(CalendarEventDB, mid)).calendar_id == "cal-o"


@pytest.mark.asyncio
async def test_delete_following_leaves_no_orphans(db_session):
    owner = await _seed(db_session)
    mid = await _with_exceptions(db_session)
    # 앞 회차(10/08)의 예외를 분할 지점 뒤로 옮겨 둔다 — 원래 회차가 앞이라 남아야 한다
    await service.update_occurrence(db_session, "owner", mid, _dt(8), {
        "start": "2026-10-20T06:00:00Z", "end": "2026-10-20T07:00:00Z"})
    r = await cal_router.delete_event(event_id=mid, occurrence="2026-10-15T06:00:00Z", user=owner, db=db_session,
                                      scope="following")
    assert r["ok"]
    assert list(await _children(db_session, mid)) == ["2026-10-08T06:00"]
    old = await db_session.get(CalendarEventDB, mid)
    assert service.parse_exdates(old.exdates) == []
    assert await _shown(db_session) == [("2026-10-01T06:00", "주간 회의"), ("2026-10-20T06:00", "앞쪽 예외")]
    orphans = (await db_session.execute(
        select(CalendarEventAttendee).where(CalendarEventAttendee.event_id.notin_(select(CalendarEventDB.id)))
    )).scalars().all()
    assert orphans == []


@pytest.mark.asyncio
async def test_single_commit_then_invite_notifications(db_session, monkeypatch):
    """새 참석자 알림(create_notification 은 안에서 커밋한다)이 분할 중간에 끼면 한 트랜잭션이 깨진다."""
    owner = await _seed(db_session)
    mid = await _with_exceptions(db_session)
    from app.notifications import service as ns

    order: list[str] = []
    real_commit = db_session.commit
    real_notify = ns.create_notification

    async def _commit():
        # 커밋되는 순간 이미 예외 회차 옮기기까지 끝나 있어야 한다
        pending_moves = [o for o in db_session.dirty if isinstance(o, CalendarEventDB) and o.parent_event_id]
        order.append(f"commit:{len(pending_moves)}")
        await real_commit()

    async def _notify(db, *a, **kw):
        order.append("notify")
        return await real_notify(db, *a, **kw)

    monkeypatch.setattr(db_session, "commit", _commit)
    monkeypatch.setattr(ns, "create_notification", _notify)
    r = await _split(db_session, owner, mid, "2026-10-15T06:00:00Z", title="새 제목",
                     attendees=[{"email": "late@x.io"}])
    # 첫 커밋이 분할 전체(옮긴 예외 2건 포함)를 담고, 알림은 그 뒤
    assert order[0] == "commit:2" and order[1] == "notify"
    assert "notify" not in order[:1]
    assert sorted(await _children(db_session, r["id"])) == ["2026-10-22T06:00", "2026-11-05T06:00"]
    late = (await db_session.execute(select(Notification).where(Notification.user_id == "late"))).scalars().all()
    assert [n.title for n in late] == ["일정 초대: 새 제목"]


@pytest.mark.asyncio
async def test_timezone_added_matches_real_occurrences_across_dst(db_session):
    """시간대 없던 주간 반복(UTC 고정 시각)에 뉴욕 시간대를 채워 나누면 서머타임이 끝난 뒤(2026-11-01) 회차는
    한 시간 뒤로 간다 — 지운 회차·예외 회차가 그 실제 회차를 가리켜야 한다."""
    owner = await _seed(db_session)
    ev = await service.create_event(db_session, "owner", {
        "calendar_id": "cal-o", "title": "주간", "start": "2026-10-08T13:00:00Z", "end": "2026-10-08T14:00:00Z",
        "recurrence_rule": "FREQ=WEEKLY;BYDAY=TH",                                # 목 09:00 EDT, 시간대 없음
    })
    mid = ev["id"]
    await service.update_occurrence(db_session, "owner", mid, _dt(29, 13), {"title": "경계 전"})
    await service.update_occurrence(db_session, "owner", mid, _dt(12, 13, 11), {"title": "경계 후"})
    await service.delete_occurrence(db_session, "owner", mid, _dt(19, 13, 11))
    r = await _split(db_session, owner, mid, "2026-10-22T13:00:00Z", timezone="America/New_York")
    new = await db_session.get(CalendarEventDB, r["id"])
    assert service.parse_exdates(new.exdates) == [_dt(19, 14, 11)]               # 09:00 EST = 14:00Z
    kids = await _children(db_session, new.id)
    assert {k: v.title for k, v in kids.items()} == {"2026-10-29T13:00": "경계 전", "2026-11-12T14:00": "경계 후"}
    assert service._utc(kids["2026-11-12T14:00"].start) == _dt(12, 14, 11)      # 시각을 안 건드린 예외는 회차를 따라간다
    shown = await _shown(db_session, start="2026-10-21T00:00:00Z", end="2026-11-27T00:00:00Z")
    assert shown == [
        ("2026-10-22T13:00", "주간"), ("2026-10-29T13:00", "경계 전"), ("2026-11-05T14:00", "주간"),
        ("2026-11-12T14:00", "경계 후"), ("2026-11-26T14:00", "주간"),
    ]


@pytest.mark.asyncio
async def test_same_zone_time_shift_across_dst(db_session):
    owner = await _seed(db_session)
    ev = await service.create_event(db_session, "owner", {
        "calendar_id": "cal-o", "title": "주간", "start": "2026-10-08T13:00:00Z", "end": "2026-10-08T14:00:00Z",
        "timezone": "America/New_York", "recurrence_rule": "FREQ=WEEKLY;BYDAY=TH",
    })
    mid = ev["id"]
    await service.update_occurrence(db_session, "owner", mid, _dt(12, 14, 11), {"title": "경계 후"})   # 09:00 EST
    await service.delete_occurrence(db_session, "owner", mid, _dt(19, 14, 11))
    # 09:00 → 10:00(현지)
    r = await _split(db_session, owner, mid, "2026-10-22T13:00:00Z",
                     start="2026-10-22T14:00:00Z", end="2026-10-22T15:00:00Z")
    new = await db_session.get(CalendarEventDB, r["id"])
    assert service.parse_exdates(new.exdates) == [_dt(19, 15, 11)]
    assert list(await _children(db_session, new.id)) == ["2026-11-12T15:00"]
    shown = await _shown(db_session, start="2026-11-01T00:00:00Z", end="2026-11-27T00:00:00Z")
    assert shown == [("2026-11-05T15:00", "주간"), ("2026-11-12T15:00", "경계 후"), ("2026-11-26T15:00", "주간")]


@pytest.mark.asyncio
async def test_split_at_first_real_occurrence_drops_empty_old_master(db_session):
    """시작일(수)이 규칙(매주 목)에 안 맞는 시리즈 — 첫 실제 회차에서 나누면 옛 마스터엔 회차가 없다."""
    owner = await _seed(db_session)
    ev = await service.create_event(db_session, "owner", {
        "calendar_id": "cal-o", "title": "주간", "start": "2026-09-30T06:00:00Z", "end": "2026-09-30T07:00:00Z",
        "timezone": "Asia/Seoul", "recurrence_rule": "FREQ=WEEKLY;BYDAY=TH",
        "attendees": [{"email": "guest@x.io"}],
    })
    mid = ev["id"]
    await service.update_occurrence(db_session, "owner", mid, _dt(8), {"title": "예외"})
    await service.delete_occurrence(db_session, "owner", mid, _dt(15))
    r = await _split(db_session, owner, mid, "2026-10-01T06:00:00Z", title="바뀜")
    assert r["id"] != mid
    assert await db_session.get(CalendarEventDB, mid) is None
    tops = (await db_session.execute(select(CalendarEventDB).where(CalendarEventDB.parent_event_id.is_(None)))).scalars().all()
    assert [(t.id, t.title, t.ical_uid) for t in tops] == [(r["id"], "바뀜", mid)]
    assert list(await _children(db_session, r["id"])) == ["2026-10-08T06:00"]
    att = (await db_session.execute(select(CalendarEventAttendee.event_id))).scalars().all()
    assert set(att) <= {r["id"]} | {k.id for k in (await _children(db_session, r["id"])).values()}
    shown = await _shown(db_session, end="2026-10-23T00:00:00Z")
    assert shown == [("2026-10-01T06:00", "바뀜"), ("2026-10-08T06:00", "예외"), ("2026-10-22T06:00", "바뀜")]
