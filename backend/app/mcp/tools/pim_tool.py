"""개인정보관리(PIM) 읽기 도구 — 캘린더 · 연락처 · 할일.

MCP 로 제공되던 도구가 files/mail/notes/web 4종뿐이어서 일정·연락처·할일은
접근이 불가했다. 전부 **읽기 전용**(mcp:read)이다 — 쓰기는 승인 게이트가 구비된
이후 제공한다.

각 도구는 서비스 계층을 그대로 호출한다. 쿼리를 직접 작성하면 소유권/공유 필터가
누락될 수 있으나, 서비스 함수는 user_id 기준으로 본인 소유 항목과 공유받은 항목만
반환한다.
"""

from datetime import datetime, timedelta, timezone

from app.calendar import service as cal_svc
from app.contacts import service as contact_svc
from app.db.models import User
from app.db.session import async_session
from app.mcp.server import Tool, register
from app.mcp.tools._common import (
    CURSOR_PARAM, PAGINATION_HINT, clamp, drop_empty, fit_page, query_hash, read_cursor, shorten,
)
from app.tasks import service as task_svc

# 응답이 과도하게 커지면 모델 컨텍스트를 소모하므로 도구별 상한을 둔다.
_MAX_ITEMS = 100


def _iso(v):
    """서비스 계층이 datetime 을 그대로 반환하는 필드가 있다(tasks.due_date 등).
    JSON 직렬화가 불가하므로 문자열로 변환한다."""
    return v.isoformat() if isinstance(v, datetime) else v


_DESC_MAX = 300   # 일정·할일 설명 상한(글자) — 목록에서는 요지만 제공, 전문은 원본 화면에서 확인


async def calendar_list_events(
    user: User, start: str = "", end: str = "", days: int = 14, limit: int = 100, cursor: str = "", **_: object
) -> dict:
    """기간 내 일정을 반환한다. start/end 미지정 시 오늘부터 days 일.

    순서는 서비스(get_events)가 반환하는 시작 시각순을 유지한다(동일 요청이면 동일 순서 — 반복 일정 전개 포함).
    """
    if not start:
        now = datetime.now(timezone.utc)
        start = now.date().isoformat()
        end = end or (now + timedelta(days=max(1, min(365, days)))).date().isoformat()
    n = clamp(limit, 1, _MAX_ITEMS, _MAX_ITEMS)
    qh = query_hash("calendar_list_events", start, end)
    off, cerr = read_cursor(cursor, qh)
    if cerr:
        return cerr
    async with async_session() as db:
        events = await cal_svc.get_events(db, user.id, start=start, end=end)
    window = events[off:off + n]
    rows = [
        drop_empty({
            "id": e.get("id"),
            "title": e.get("title"),
            "start": _iso(e.get("start")),
            "end": _iso(e.get("end")),
            "all_day": e.get("all_day") or None,
            "location": e.get("location"),
            "description": shorten(e.get("description"), _DESC_MAX),
            "calendar_id": e.get("calendar_id"),
        })
        for e in window
    ]
    return fit_page(rows, offset=off, total=len(events), list_key="events", qhash=qh,
                    extras={"range": {"start": start, "end": end}})


async def calendar_list_calendars(user: User, **_: object) -> dict:
    """사용자가 접근 가능한 캘린더 목록(본인 소유 + 공유받은 것)."""
    async with async_session() as db:
        cals = await cal_svc.get_calendars(db, user.id)
    return {
        "count": len(cals),
        "calendars": [
            {"id": c.get("id"), "name": c.get("name"), "color": c.get("color"),
             "is_visible": c.get("is_visible")}
            for c in cals
        ],
    }


async def contacts_search(
    user: User, query: str = "", limit: int = 50, cursor: str = "", **_: object
) -> dict:
    """연락처를 검색한다. query 가 비어 있으면 전체 목록. 순서: 이름 → id(서비스)."""
    n = clamp(limit, 1, _MAX_ITEMS, 50)
    qh = query_hash("contacts_search", (query or "").strip())
    off, cerr = read_cursor(cursor, qh)
    if cerr:
        return cerr
    page, skip = divmod(off, n)
    async with async_session() as db:
        rows, total = await contact_svc.get_contacts(
            db, user.id, q=(query or None), page=page, limit=n
        )
    rows = rows[skip:]
    out = [
        drop_empty({
            "id": c.get("id"),
            "name": c.get("name"),
            "organization": c.get("organization"),
            "emails": c.get("emails"),
            "phones": c.get("phones"),
        })
        for c in rows
    ]
    return fit_page(out, offset=off, total=int(total or 0), list_key="contacts", qhash=qh,
                    extras={"query": query})


async def tasks_list(
    user: User, status: str = "", priority: str = "", limit: int = 50, cursor: str = "", **_: object
) -> dict:
    """할일 목록. status/priority 로 필터링 가능. 순서: 생성 시각 최신 → id(서비스)."""
    n = clamp(limit, 1, _MAX_ITEMS, 50)
    qh = query_hash("tasks_list", status, priority)
    off, cerr = read_cursor(cursor, qh)
    if cerr:
        return cerr
    page, skip = divmod(off, n)
    async with async_session() as db:
        rows, total = await task_svc.get_tasks(
            db, user.id,
            status=(status or None), priority=(priority or None), page=page, limit=n,
        )
    rows = rows[skip:]
    out = [
        drop_empty({
            "id": t.get("id"),
            "title": t.get("title"),
            "status": t.get("status"),
            "priority": t.get("priority"),
            "due_date": _iso(t.get("due_date")),
            "description": shorten(t.get("description"), _DESC_MAX),
        })
        for t in rows
    ]
    return fit_page(out, offset=off, total=int(total or 0), list_key="tasks", qhash=qh)


register(Tool(
    name="calendar_list_events",
    description=(
        "List the user's calendar events in a date range (their own calendars and "
        "any shared with them). Use this to answer questions about schedule, "
        "meetings, availability, or what is coming up. Dates are in the user's time zone — call "
        "workspace_context first if you need today's date." + PAGINATION_HINT
    ),
    parameters={
        "type": "object",
        "properties": {
            "start": {"type": "string", "description": "Start date, YYYY-MM-DD. Defaults to today."},
            "end": {"type": "string", "description": "End date, YYYY-MM-DD."},
            "days": {"type": "integer", "description": "If start/end omitted, look ahead this many days (default 14).", "default": 14},
            "limit": {"type": "integer", "description": "Events per page (default 100, max 100).", "default": 100},
            "cursor": CURSOR_PARAM,
        },
    },
    # 타인이 작성한 글 포함 — 신뢰 경계를 적용하며, 직후의 쓰기는 승인 흐름이 경고·자동 실행 금지로 처리한다
    handler=calendar_list_events, untrusted_output=True,
))

register(Tool(
    name="calendar_list_calendars",
    description="List calendars the user can access (own + shared), with id, name and colour.",
    parameters={"type": "object", "properties": {}},
    handler=calendar_list_calendars,
))

register(Tool(
    name="contacts_search",
    description=(
        "Search the user's address books by name, organization, email or phone. "
        "Leave query empty to list contacts. Use this to look up someone's contact details."
        + PAGINATION_HINT
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search term. Empty lists all."},
            "limit": {"type": "integer", "description": "Results per page (default 50, max 100).", "default": 50},
            "cursor": CURSOR_PARAM,
        },
    },
    # 타인이 작성한 글 일부 포함 — 내장 AI 대화 표시만 기록한다(conv_untrusted: MCP 15분 창·래핑 없음)
    handler=contacts_search, conv_untrusted=True,
))

register(Tool(
    name="tasks_list",
    description=(
        "List the user's tasks, optionally filtered by status or priority. "
        "Use this for questions about to-dos, what is pending, or what is overdue." + PAGINATION_HINT
    ),
    parameters={
        "type": "object",
        "properties": {
            "status": {"type": "string", "description": "Filter by status (e.g. todo, doing, done)."},
            "priority": {"type": "string", "description": "Filter by priority (e.g. low, normal, high)."},
            "limit": {"type": "integer", "description": "Results per page (default 50, max 100).", "default": 50},
            "cursor": CURSOR_PARAM,
        },
    },
    # 타인이 작성한 글 일부 포함 — 내장 AI 대화 표시만 기록한다(conv_untrusted: MCP 15분 창·래핑 없음)
    handler=tasks_list, conv_untrusted=True,
))
