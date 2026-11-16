"""일정·할일 쓰기 도구.

웹 API 와 동일한 판정을 사용한다 — 캘린더·할일 라우터의 엔드포인트 함수를 그대로 호출한다
(모듈·그룹 권한(require_module), 캘린더 쓰기 권한(소유·쓰기 공유, 구독 캘린더 거부),
할일 열람 가능 여부(작성자·담당)·삭제(작성자만)·담당자/채널 검사).

참석자 초대는 제공하지 않는다(초대 알림이 타인에게 발송되므로 별도 판단 필요).
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.db.models import User
from app.db.session import async_session
from app.mcp.server import Tool, register
from app.mcp.tools._common import UNDO_HINT, UNDO_TOKEN_PARAM, check_undo_token, err, http_err, undo_token

logger = logging.getLogger(__name__)


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def _end_before_start(start, end) -> bool:
    """끝 < 시작이면 True. 형식 오류는 ValueError, 시간대 유무가 혼재하면 비교를 생략한다."""
    try:
        return _parse(end) < _parse(start)
    except TypeError:
        return False


def _handle(e: Exception) -> dict:
    he = http_err(e)
    if he:
        return he
    if isinstance(e, ValueError):        # pydantic ValidationError 포함
        return err("invalid_argument", str(e).splitlines()[0][:300] if str(e) else "잘못된 값입니다")
    raise e


# ══ 캘린더 ════════════════════════════════════════════════════
_EV_FIELDS = ("title", "start", "end", "all_day", "location", "description")


async def calendar_create_event(user: User, title: str, start: str, end: str, calendar_id: str = "",
                                all_day: bool = False, location: str = "", description: str = "",
                                timezone: str = "", reminder_minutes: int | None = None,
                                **_: object) -> dict:
    from app.calendar import router as cr
    from app.calendar import service as cal_svc
    from app.calendar.schemas import EventCreate

    try:
        if _end_before_start(start, end):
            return err("invalid_argument", "끝나는 시각이 시작보다 앞섭니다")
    except ValueError:
        return err("invalid_argument", "start·end 는 ISO 8601 이어야 합니다(예: 2026-11-10T14:00:00+09:00)")
    try:
        async with async_session() as db:
            cal_id = (calendar_id or "").strip()
            if not cal_id:
                cals = await cal_svc.get_calendars(db, user.id)    # 없으면 기본 캘린더를 생성함
                own = [c for c in cals if c.get("can_write") and not c.get("is_shared")]
                if not own:
                    return err("not_found", "일정을 넣을 수 있는 캘린더가 없습니다")
                cal_id = own[0]["id"]
            ev = await cr.create_event(
                EventCreate(calendar_id=cal_id, title=title, start=start, end=end, all_day=bool(all_day),
                            location=(location or None), description=(description or None),
                            timezone=(timezone or None), reminder_minutes=reminder_minutes),
                user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"id": ev.id, "calendar_id": ev.calendar_id, "title": ev.title, "start": ev.start, "end": ev.end,
            "_undo": {"tool": "calendar_undo_create_event",
                      "args": {"event_id": ev.id, "token": undo_token(user.id, "event", ev.id)}}}


async def calendar_undo_create_event(user: User, event_id: str, token: str, **_: object) -> dict:
    from app.calendar import router as cr

    if not check_undo_token(token, user.id, "event", str(event_id)):
        return err("forbidden", "이 도구로 만든 일정이 아니라 지우지 않습니다")
    try:
        async with async_session() as db:
            await cr.delete_event(str(event_id), occurrence=None, user=user, db=db, scope=None, notify=False)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"deleted_event": event_id}


async def calendar_update_event(user: User, event_id: str, title: str | None = None, start: str | None = None,
                                end: str | None = None, all_day: bool | None = None,
                                location: str | None = None, description: str | None = None,
                                **_: object) -> dict:
    from app.calendar import router as cr
    from app.calendar import service as cal_svc
    from app.calendar.schemas import EventUpdate

    new = {k: v for k, v in {"title": title, "start": start, "end": end, "all_day": all_day,
                             "location": location, "description": description}.items() if v is not None}
    if not new:
        return err("invalid_argument", "바꿀 항목이 없습니다")
    try:
        async with async_session() as db:
            cur = await cal_svc.get_event(db, user.id, str(event_id))
            if not cur:
                return err("not_found", f"일정이 없습니다: {event_id}")
            if _end_before_start(new.get("start", cur.get("start")), new.get("end", cur.get("end"))):
                return err("invalid_argument", "끝나는 시각이 시작보다 앞섭니다")
            before = {}
            for k in new:
                v = cur.get(k)
                before[k] = (bool(v) if k == "all_day" else (v or ""))
            await cr.update_event(str(event_id), EventUpdate(**new), occurrence=None, user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"id": event_id, "updated": new, "before": before,
            "_undo": {"tool": "calendar_update_event", "args": {"event_id": event_id, **before}}}


async def calendar_delete_event(user: User, event_id: str, **_: object) -> dict:
    from app.calendar import router as cr

    try:
        async with async_session() as db:
            await cr.delete_event(str(event_id), occurrence=None, user=user, db=db, scope=None, notify=False)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"deleted_event": event_id, "note": "일정을 지웠습니다(반복 일정이면 시리즈 전체). 되살릴 수 없습니다."}


async def _event_visible(args: dict, user) -> bool:
    """타인에게 노출되는 일정인지 판정 — 공유받은 캘린더, 본인이 타인에게 공유한 캘린더, 참석자가 있는 일정.
    calendar_id 없이 생성하는 일정은 본인의 첫 캘린더에 저장된다. 확인 불가 시 '노출'로 판정한다(writes.tool_visible)."""
    from sqlalchemy import select

    from app.calendar import service as cal_svc
    from app.db.models import CalendarDB, CalendarShareDB

    async with async_session() as db:
        cal_id = str(args.get("calendar_id") or "").strip()
        eid = str(args.get("event_id") or "").strip()
        if eid:
            ev = await cal_svc.get_event(db, user.id, eid)
            if not ev or ev.get("attendees") or ev.get("is_invited"):
                return True
            cal_id = str(ev.get("calendar_id") or "")
            if not cal_id:
                return True
        if not cal_id:
            # 기본 캘린더 = 본인 소유 중 쓰기 가능한 첫 번째(calendar_create_event 와 동일한 선택 기준)
            own = [c for c in await cal_svc.get_calendars(db, user.id) if c.get("can_write") and not c.get("is_shared")]
            if not own:
                return True
            cal_id = own[0]["id"]
        cal = await db.get(CalendarDB, cal_id)
        if cal is None or cal.user_id != user.id:
            return True
        shared = (await db.execute(select(CalendarShareDB.id).where(CalendarShareDB.calendar_id == cal_id).limit(1))).first()
        return shared is not None


async def _task_visible(args: dict, user) -> bool:
    """타인에게 노출되는 할일인지 판정 — 본인이 생성하고 담당도 본인(또는 없음)인 것만 '본인 전용'."""
    from app.db.models import TaskDB

    async with async_session() as db:
        t = await db.get(TaskDB, str(args.get("task_id") or ""))
        if t is None or t.user_id != user.id or t.assignee_id not in (None, "", user.id):
            return True
        if t.parent_id:      # 하위 작업은 상위 작업의 담당자·작성자도 열람 가능
            p = await db.get(TaskDB, t.parent_id)
            return p is None or p.user_id != user.id or p.assignee_id not in (None, "", user.id)
        return False


def _sum_event(args: dict) -> str:
    t = str(args.get("title") or "").strip()
    when = str(args.get("start") or "").replace("T", " ")[:16]
    return " · ".join(x for x in (t, when) if x) or f"일정 {args.get('event_id', '')}"


# ══ 할일 ═════════════════════════════════════════════════════
async def tasks_create(user: User, title: str, description: str = "", due_date: str = "",
                       priority: str = "medium", status: str = "todo", project: str = "",
                       assignee_id: str = "", **_: object) -> dict:
    from app.tasks import router as tr
    from app.tasks.schemas import TaskCreate

    try:
        # 담당자: 웹 API 와 동일한 검사(활성 사용자) + 타인에게 배정하면 해당 사용자에게 '할일 배정' 알림 발송(회의 할 일)
        body = TaskCreate(title=title, description=(description or None), due_date=(due_date or None),
                          priority=priority or "medium", status=status or "todo", project=(project or None),
                          assignee_id=(assignee_id or None))
        async with async_session() as db:
            t = await tr.create_task(body, user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"id": t.id, "title": t.title, "status": t.status, "priority": t.priority,
            "due_date": _iso(t.due_date),
            "_undo": {"tool": "tasks_undo_create",
                      "args": {"task_id": t.id, "token": undo_token(user.id, "task", t.id)}}}


async def tasks_undo_create(user: User, task_id: str, token: str, **_: object) -> dict:
    from app.tasks import router as tr

    if not check_undo_token(token, user.id, "task", str(task_id)):
        return err("forbidden", "이 도구로 만든 할일이 아니라 지우지 않습니다")
    try:
        async with async_session() as db:
            await tr.delete_task(str(task_id), user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"deleted_task": task_id}


async def tasks_update(user: User, task_id: str, title: str | None = None, description: str | None = None,
                       due_date: str | None = None, priority: str | None = None, status: str | None = None,
                       **_: object) -> dict:
    from app.tasks import router as tr
    from app.tasks import service as task_svc
    from app.tasks.schemas import TaskUpdate

    data: dict = {}
    if title is not None:
        data["title"] = title
    if description is not None:
        data["description"] = description or None
    if due_date is not None:
        data["due_date"] = due_date or None          # "" = 마감 없음
    if priority is not None:
        data["priority"] = priority
    if status is not None:
        data["status"] = status
    if not data:
        return err("invalid_argument", "바꿀 항목이 없습니다")
    try:
        body = TaskUpdate(**data)
        async with async_session() as db:
            cur = await task_svc.get_task(db, user.id, str(task_id))
            if not cur:
                return err("not_found", f"할일이 없습니다: {task_id}")
            before = {}
            for k in data:
                v = cur.get(k)
                before[k] = _iso(v) if k == "due_date" and v else (v or "")
            t = await tr.update_task(str(task_id), body, user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"id": t.id, "title": t.title, "status": t.status, "priority": t.priority,
            "due_date": _iso(t.due_date), "before": before,
            "_undo": {"tool": "tasks_update", "args": {"task_id": t.id, **before}}}


async def tasks_delete(user: User, task_id: str, **_: object) -> dict:
    from app.tasks import router as tr

    try:
        async with async_session() as db:
            await tr.delete_task(str(task_id), user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"deleted_task": task_id, "note": "할일과 그 하위 작업을 지웠습니다. 되살릴 수 없습니다."}


def _sum_task(args: dict) -> str:
    t = str(args.get("title") or "").strip()
    due = str(args.get("due_date") or "")[:10]
    st = {"done": "완료", "todo": "할 일", "in_progress": "진행 중", "review": "검토"}.get(str(args.get("status") or ""), "")
    return " · ".join(x for x in (t, (f"마감 {due}" if due else ""), st) if x) or f"할일 {args.get('task_id', '')}"


# ── 등록 ─────────────────────────────────────────────────────
_DT = "ISO 8601 date-time with offset, e.g. 2026-11-10T14:00:00+09:00 (call workspace_context for today/time zone)."

register(Tool(
    name="calendar_create_event",
    title="일정 만들기",
    description="Create an event in one of the user's calendars (default: the user's first own calendar). "
                "No attendees are invited. " + _DT,
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "title": {"type": "string", "x-label": "제목", "x-editable": True},
            "start": {"type": "string", "description": "Start. " + _DT, "x-label": "시작", "x-editable": True},
            "end": {"type": "string", "description": "End. " + _DT, "x-label": "끝", "x-editable": True},
            "all_day": {"type": "boolean", "default": False, "x-label": "종일", "x-editable": True},
            "location": {"type": "string", "default": "", "x-label": "장소", "x-editable": True},
            "description": {"type": "string", "default": "", "x-label": "설명", "x-editable": True,
                            "x-multiline": True},
            "calendar_id": {"type": "string", "default": "", "description": "From calendar_list_calendars. Empty = default.",
                            "x-label": "캘린더", "x-hidden": True},
            "timezone": {"type": "string", "default": "", "description": "Optional IANA zone, e.g. Asia/Seoul.",
                         "x-label": "시간대"},
            "reminder_minutes": {"type": "integer", "description": "Optional reminder N minutes before.",
                                 "x-label": "알림(분 전)", "x-editable": True},
        },
        "required": ["title", "start", "end"],
    },
    # 공유 캘린더(공유받은 것·본인이 공유한 것)에 추가하면 타인에게 노출됨
    visible_for=_event_visible,
    handler=calendar_create_event, summarizer=_sum_event,
))

register(Tool(
    name="calendar_undo_create_event",
    title="만든 일정 실행 취소",
    description="Delete an event that calendar_create_event just created." + UNDO_HINT,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "event_id": {"type": "string", "x-label": "일정 id", "x-hidden": True},
        "token": UNDO_TOKEN_PARAM,
    }, "required": ["event_id", "token"]},
    handler=calendar_undo_create_event, summarizer=lambda a: "만든 일정 삭제",
))

register(Tool(
    name="calendar_update_event",
    title="일정 수정",
    description="Change an event's title, time, all-day flag, location or description. Only the fields you "
                "pass change. Recurring events change as a whole series. " + _DT,
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "event_id": {"type": "string", "description": "Event id from calendar_list_events.",
                         "x-label": "일정 id", "x-hidden": True},
            "title": {"type": "string", "x-label": "제목", "x-editable": True},
            "start": {"type": "string", "x-label": "시작", "x-editable": True},
            "end": {"type": "string", "x-label": "끝", "x-editable": True},
            "all_day": {"type": "boolean", "x-label": "종일", "x-editable": True},
            "location": {"type": "string", "description": "\"\" clears it.", "x-label": "장소", "x-editable": True},
            "description": {"type": "string", "description": "\"\" clears it.", "x-label": "설명",
                            "x-editable": True, "x-multiline": True},
        },
        "required": ["event_id"],
    },
    # 공유 캘린더의 일정이거나 참석자가 있으면 타인에게 노출됨
    visible_for=_event_visible,
    handler=calendar_update_event, summarizer=_sum_event,
))

register(Tool(
    name="calendar_delete_event",
    title="일정 삭제",
    description="Delete an event (a recurring event is deleted as a whole series; attendees are not "
                "notified). Requires the user's approval in the workspace approval inbox; returns "
                "pending_approval — check later with approvals_status.",
    scope="mcp:write", risk="high",
    parameters={"type": "object", "properties": {
        "event_id": {"type": "string", "description": "Event id from calendar_list_events.", "x-label": "일정 id"},
    }, "required": ["event_id"]},
    # 공유 캘린더의 일정이거나 참석자가 있으면 타인이 열람하던 항목이 삭제됨
    visible_for=_event_visible,
    handler=calendar_delete_event, summarizer=_sum_event,
))

_PRI = {"type": "string", "enum": ["low", "medium", "high", "urgent"], "x-label": "우선순위", "x-editable": True}
_STATUS = {"type": "string", "enum": ["todo", "in_progress", "review", "done"], "x-label": "상태", "x-editable": True}

register(Tool(
    name="tasks_create",
    title="할일 만들기",
    description="Create a task for the user. `due_date` is ISO date or date-time (e.g. 2026-11-10).",
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "title": {"type": "string", "x-label": "제목", "x-editable": True},
            "description": {"type": "string", "default": "", "x-label": "설명", "x-editable": True,
                            "x-multiline": True},
            "due_date": {"type": "string", "default": "", "x-label": "마감", "x-editable": True},
            "priority": {**_PRI, "default": "medium"},
            "status": {**_STATUS, "default": "todo"},
            "project": {"type": "string", "default": "", "x-label": "프로젝트", "x-editable": True},
            "assignee_id": {"type": "string", "default": "", "x-label": "담당자(사용자 id)",
                            "description": "Optional user id to assign; they get a task-assigned notification."},
        },
        "required": ["title"],
    },
    # 타인에게 배정하면 해당 사용자에게 '할일 배정' 알림이 발송된다 — 이 경우에만 '타인에게 노출되는 쓰기'로 판정(본인 할일은 기존대로 자동 실행)
    visible_for=lambda a, u=None: str(a.get("assignee_id") or "").strip() not in ("", str(getattr(u, "id", ""))),
    handler=tasks_create, summarizer=_sum_task,
))

register(Tool(
    name="tasks_undo_create",
    title="만든 할일 실행 취소",
    description="Delete a task that tasks_create just created." + UNDO_HINT,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "task_id": {"type": "string", "x-label": "할일 id", "x-hidden": True},
        "token": UNDO_TOKEN_PARAM,
    }, "required": ["task_id", "token"]},
    handler=tasks_undo_create, summarizer=lambda a: "만든 할일 삭제",
))

register(Tool(
    name="tasks_update",
    title="할일 수정",
    description="Change a task: title, description, due date (\"\" = no due date), priority or status. Use "
                "status=\"done\" to complete it. Only the fields you pass change.",
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "Task id from tasks_list.", "x-label": "할일 id",
                        "x-hidden": True},
            "title": {"type": "string", "x-label": "제목", "x-editable": True},
            "description": {"type": "string", "x-label": "설명", "x-editable": True, "x-multiline": True},
            "due_date": {"type": "string", "x-label": "마감", "x-editable": True},
            "priority": _PRI,
            "status": _STATUS,
        },
        "required": ["task_id"],
    },
    # 타인이 생성했거나 타인에게 배정된 할일이면 타인에게 노출됨(확인 불가 시 노출로 판정)
    visible_for=_task_visible,
    handler=tasks_update, summarizer=_sum_task,
))

register(Tool(
    name="tasks_delete",
    title="할일 삭제",
    description="Delete a task the user created (its subtasks are deleted too). Requires the user's approval "
                "in the workspace approval inbox; returns pending_approval — check later with approvals_status.",
    scope="mcp:write", risk="high",
    parameters={"type": "object", "properties": {
        "task_id": {"type": "string", "description": "Task id from tasks_list.", "x-label": "할일 id"},
    }, "required": ["task_id"]},
    visible_for=_task_visible,   # tasks_update 와 동일한 판정
    handler=tasks_delete, summarizer=_sum_task,
))
