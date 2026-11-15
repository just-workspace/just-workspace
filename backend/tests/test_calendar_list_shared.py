"""캘린더 목록 — 공유받은 캘린더 표시(is_shared·can_write).

프론트 사이드바가 "내 캘린더" / "공유받은 캘린더" 를 나누고 읽기 전용 공유를 표시하는 데 쓴다.
"""

import pytest

from app.calendar import service
from app.db.models import CalendarDB, CalendarShareDB, User


async def _seed(db):
    for uid in ("owner", "viewer", "editor"):
        db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid))
    await db.commit()
    cal = CalendarDB(id="cal-1", user_id="owner", name="팀", color="#10b981")
    db.add(cal)
    await db.commit()
    db.add(CalendarShareDB(calendar_id="cal-1", shared_with_user_id="viewer", can_write=False))
    db.add(CalendarShareDB(calendar_id="cal-1", shared_with_user_id="editor", can_write=True))
    await db.commit()


@pytest.mark.asyncio
async def test_own_calendar_is_not_shared(db_session):
    await _seed(db_session)
    cals = await service.get_calendars(db_session, "owner")
    own = next(c for c in cals if c["id"] == "cal-1")
    assert own["is_shared"] is False
    assert own["can_write"] is True


@pytest.mark.asyncio
async def test_shared_calendar_flags_follow_share_permission(db_session):
    await _seed(db_session)

    viewer = await service.get_calendars(db_session, "viewer")
    shared = next(c for c in viewer if c["id"] == "cal-1")
    assert shared["is_shared"] is True
    assert shared["can_write"] is False, "읽기 전용 공유가 쓰기 가능으로 보인다"

    editor = await service.get_calendars(db_session, "editor")
    shared = next(c for c in editor if c["id"] == "cal-1")
    assert shared["is_shared"] is True
    assert shared["can_write"] is True


@pytest.mark.asyncio
async def test_auto_created_default_calendar_has_flags(db_session):
    db_session.add(User(id="new", username="new", email="new@x", password_hash="x", display_name="new"))
    await db_session.commit()
    cals = await service.get_calendars(db_session, "new")
    assert len(cals) == 1
    assert cals[0]["is_shared"] is False and cals[0]["can_write"] is True
