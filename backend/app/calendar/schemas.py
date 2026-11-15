"""Calendar API schemas."""

from pydantic import BaseModel, field_validator


class CalendarInfo(BaseModel):
    id: str
    name: str
    color: str | None = None
    is_visible: bool = True
    sort_order: int = 0
    # 공유받은 캘린더면 True, can_write 는 그 공유의 쓰기 권한(내 캘린더는 항상 True)
    is_shared: bool = False
    can_write: bool = True
    # 외부 .ics 구독(읽기 전용, 6시간마다 새로 받음)
    is_subscription: bool = False


class CalendarCreate(BaseModel):
    name: str
    color: str | None = None


class CalendarUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    is_visible: bool | None = None


class Attendee(BaseModel):
    email: str
    name: str | None = None
    response: str = "needs-action"  # needs-action | accepted | declined | tentative
    user_id: str | None = None


class AttendeeIn(BaseModel):
    email: str
    name: str | None = None
    # 보통 비워 둔다(새 참석자는 needs-action, 기존 참석자는 응답 유지)
    response: str | None = None


class CalendarEvent(BaseModel):
    id: str
    calendar_id: str
    title: str
    description: str | None = None
    location: str | None = None
    start: str  # ISO 8601
    end: str  # ISO 8601
    all_day: bool = False
    color: str | None = None  # inherited from calendar
    status: str | None = None  # confirmed, tentative, cancelled
    reminder_minutes: int | None = None
    recurrence_rule: str | None = None
    is_recurring: bool = False
    is_occurrence: bool = False
    original_event_id: str | None = None
    created: str | None = None
    updated: str | None = None
    # ── 추가 필드 ──
    timezone: str | None = None
    meeting_url: str | None = None
    exdates: list[str] = []
    attendees: list[Attendee] = []
    my_response: str | None = None  # 내가 참석자면 내 응답
    parent_event_id: str | None = None  # 회차 단일 수정 행이면 마스터 id
    recurrence_id: str | None = None  # 그 회차의 원래 시작
    is_exception: bool = False
    is_invited: bool = False  # 내 캘린더가 아니라 초대받아서 보이는 일정


class EventCreate(BaseModel):
    calendar_id: str
    title: str
    description: str | None = None
    location: str | None = None
    start: str
    end: str
    all_day: bool = False
    reminder_minutes: int | None = None
    recurrence_rule: str | None = None
    recurrence_end: str | None = None  # ISO datetime
    timezone: str | None = None  # IANA (예: Asia/Seoul)
    meeting_url: str | None = None
    attendees: list[AttendeeIn] | None = None

    @field_validator("recurrence_rule")
    @classmethod
    def _rrule_ok(cls, v: str | None) -> str | None:
        from app.calendar.rrule_guard import check_rrule
        if v is None or not v.strip():
            return v   # "" = 반복 지우기(수정) — 그대로 넘긴다
        return check_rrule(v)


class EventUpdate(BaseModel):
    calendar_id: str | None = None
    title: str | None = None
    description: str | None = None
    location: str | None = None
    start: str | None = None
    end: str | None = None
    all_day: bool | None = None
    reminder_minutes: int | None = None
    recurrence_rule: str | None = None
    recurrence_end: str | None = None  # ISO datetime
    timezone: str | None = None  # "" 이면 지움
    meeting_url: str | None = None  # "" 이면 지움
    attendees: list[AttendeeIn] | None = None  # 주면 통째로 교체
    exdates: list[str] | None = None  # 주면 통째로 교체(UTC ISO)
    status: str | None = None

    @field_validator("recurrence_rule")
    @classmethod
    def _rrule_ok(cls, v: str | None) -> str | None:
        from app.calendar.rrule_guard import check_rrule
        if v is None or not v.strip():
            return v   # "" = 반복 지우기(수정) — 그대로 넘긴다
        return check_rrule(v)


class RsvpRequest(BaseModel):
    response: str  # accepted | declined | tentative | needs-action


class CalendarSharee(BaseModel):
    email: str
    can_write: bool = False


class CalendarShareRequest(BaseModel):
    shares: list[CalendarSharee]


class CalendarShareInfo(BaseModel):
    email: str
    can_write: bool


class CalendarListResponse(BaseModel):
    calendars: list[CalendarInfo]


class EventListResponse(BaseModel):
    events: list[CalendarEvent]


class SubscriptionCreate(BaseModel):
    url: str
    name: str | None = None
    color: str | None = None


class SubscriptionPreviewRequest(BaseModel):
    url: str


class SubscriptionPreview(BaseModel):
    """구독 미리 읽기 결과 — 받을 주소(webcal → https 로 바뀐 것), 캘린더 이름(X-WR-CALNAME, 없으면 null), 일정 수."""
    url: str
    name: str | None = None
    count: int
    first_year: int | None = None
    last_year: int | None = None


class SubscriptionInfo(BaseModel):
    id: str
    name: str
    color: str | None = None
    url: str
    fetched_at: str | None = None
    checked_at: str | None = None
    # 마지막 받기 실패 이유 — HTTP 상태 숫자("404") 또는 timeout·too_large·not_ics·blocked·dns·network
    error: str | None = None
    is_visible: bool = True
