"""반복 "모든 일정" 시각 변경 — 삭제한 회차·예외 회차가 복원되거나 중복되지 않는다(회귀)."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.calendar import service
from app.db.models import CalendarDB, CalendarEventDB, User

UTC = timezone.utc


async def _seed(db):
    db.add(User(id="owner", username="owner", email="o@x.io", password_hash="x"))
    await db.commit()
    db.add(CalendarDB(id="cal-o", user_id="owner", name="내 캘린더", color="#3b82f6"))
    await db.commit()
    return await service.create_event(db, "owner", {
        "calendar_id": "cal-o", "title": "매일",
        "start": "2026-10-20T01:00:00Z", "end": "2026-10-20T02:00:00Z",
        "recurrence_rule": "FREQ=DAILY;COUNT=5",
    })


@pytest.mark.asyncio
async def test_shift_series_moves_exdates_and_exceptions(db_session):
    ev = await _seed(db_session)
    # 22일 "이 일정만" 삭제, 21일 "이 일정만" 제목 수정
    await service.delete_occurrence(db_session, "owner", ev["id"], datetime(2026, 10, 22, 1, tzinfo=UTC))
    await service.update_occurrence(db_session, "owner", ev["id"], datetime(2026, 10, 21, 1, tzinfo=UTC),
                                    {"title": "예외", "start": "2026-10-21T01:00:00Z", "end": "2026-10-21T02:00:00Z"})
    # 모든 일정 10:00 → 14:00 KST (+4h)
    await service.update_event(db_session, "owner", ev["id"],
                               {"start": "2026-10-20T05:00:00Z", "end": "2026-10-20T06:00:00Z"})
    evs = await service.get_events(db_session, "owner", "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z")
    days = sorted(e["start"][:10] for e in evs)
    assert "2026-10-22" not in days                     # 삭제한 회차는 계속 없음
    assert days.count("2026-10-21") == 1                # 예외 하나만 존재(원래 회차와 중복되지 않음)
    master = await db_session.get(CalendarEventDB, ev["id"])
    assert [d.isoformat() for d in service.parse_exdates(master.exdates)] == ["2026-10-22T05:00:00+00:00"]
    ch = (await db_session.execute(select(CalendarEventDB).where(CalendarEventDB.parent_event_id == ev["id"]))).scalars().one()
    assert service._utc(ch.recurrence_id) == datetime(2026, 10, 21, 5, tzinfo=UTC)
