"""회귀 — 반복 일정 규칙으로 서버 측 전개가 폭주하지 않는다."""

import time
from datetime import datetime, timedelta, timezone

import pytest
from dateutil.rrule import rrulestr
from pydantic import ValidationError

from app.calendar import rrule_guard, service
from app.calendar.schemas import EventCreate, EventUpdate


@pytest.mark.parametrize("rule", [
    "FREQ=SECONDLY", "FREQ=MINUTELY", "RRULE:FREQ=secondly;INTERVAL=1",
    "FREQ=HOURLY;BYMINUTE=0,15,30,45",
    "FREQ=DAILY;BYHOUR=0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23;BYMINUTE=0,30",
    "FREQ=DAILY;COUNT=999999", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;FREQ=SECONDLY",
    "FREQ=WEEKLY;" + "X=1;" * 200, "NOT A RULE", "FREQ=DAILY;BYDAY=XX",
])
def test_rejected_rules(rule):
    with pytest.raises(rrule_guard.RRuleRejected):
        rrule_guard.check_rrule(rule)
    with pytest.raises(ValidationError):
        EventCreate(calendar_id="c", title="t", start="2026-01-01T00:00:00Z",
                    end="2026-01-01T01:00:00Z", recurrence_rule=rule)


@pytest.mark.parametrize("rule", [
    "FREQ=DAILY", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", "FREQ=MONTHLY;BYMONTHDAY=1;COUNT=12",
    "FREQ=YEARLY;UNTIL=20301231T235959Z", "FREQ=HOURLY;INTERVAL=2",
])
def test_allowed_rules(rule):
    assert rrule_guard.check_rrule(rule) == rule.replace("RRULE:", "")


def test_update_can_clear_recurrence():
    assert EventUpdate(recurrence_rule="").recurrence_rule == ""


def test_sanitize_drops_bad_rule_from_imports():
    assert rrule_guard.sanitize_rrule("FREQ=SECONDLY") is None
    assert rrule_guard.sanitize_rrule("FREQ=DAILY") == "FREQ=DAILY"


def test_stored_secondly_rule_expansion_is_bounded():
    # 이전에 저장된(검증 전) 초 단위 규칙도 전개가 상한에서 중단됨
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ev = {"id": "e1", "start": start.isoformat(), "end": (start + timedelta(minutes=1)).isoformat(),
          "recurrence_rule": "FREQ=SECONDLY", "all_day": False, "timezone": None}
    t0 = time.monotonic()
    out = service._expand_recurring_event(ev, start, start + timedelta(days=730))
    assert len(out) <= rrule_guard.MAX_OCCURRENCES
    assert time.monotonic() - t0 < 5


def test_next_after_bounded():
    rule = rrulestr("FREQ=SECONDLY", dtstart=datetime(2000, 1, 1, tzinfo=timezone.utc))
    assert rrule_guard.next_after(rule, datetime(2026, 1, 1, tzinfo=timezone.utc)) is None
    rule = rrulestr("FREQ=DAILY", dtstart=datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert rrule_guard.next_after(rule, datetime(2026, 1, 5, tzinfo=timezone.utc)) == \
        datetime(2026, 1, 6, tzinfo=timezone.utc)
