"""Tasks service — async SQLAlchemy CRUD.

작업은 생성자(user_id, 소유자)에게 귀속되며, 담당자(assignee_id)를 지정하면 담당자도 조회·수정할 수 있다.
삭제·담당자 변경은 소유자만 가능하다. 타인의 작업(소유자도 담당자도 아님)은 존재하지 않는 것으로 처리한다.
"""

import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select, and_, or_, func, case, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import TaskDB, User

logger = logging.getLogger(__name__)

MAX_TAGS = 20
MAX_TAG_LEN = 40


class TaskPermissionError(Exception):
    """조회는 가능하나 해당 동작은 소유자만 수행할 수 있다(담당자의 삭제·재배정 시도)."""


def _tags(t: TaskDB) -> list[str]:
    raw = getattr(t, "tags_json", None)
    if not raw:
        return []
    try:
        v = json.loads(raw)
        return [str(x) for x in v] if isinstance(v, list) else []
    except ValueError:
        return []


def normalize_tags(tags) -> list[str]:
    """앞뒤 공백 제거·중복 제거(순서 유지)·개수/길이 제한."""
    out: list[str] = []
    for x in tags or []:
        s = str(x).strip()[:MAX_TAG_LEN]
        if s and s not in out:
            out.append(s)
    return out[:MAX_TAGS]


def _task_to_dict(t: TaskDB, subtask_count: int = 0, completed_subtask_count: int = 0,
                  assignee_name: str | None = None) -> dict:
    return {
        "id": t.id,
        "user_id": t.user_id,
        "title": t.title,
        "description": t.description,
        "due_date": t.due_date,
        "priority": t.priority,
        "status": t.status,
        "calendar_event_id": t.calendar_event_id,
        "sort_order": t.sort_order,
        "parent_id": t.parent_id,
        "subtask_count": subtask_count,
        "completed_subtask_count": completed_subtask_count,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
        "assignee_id": getattr(t, "assignee_id", None),
        "assignee_name": assignee_name,
        "tags": _tags(t),
        "project": getattr(t, "project", None),
        "channel_id": getattr(t, "channel_id", None),
    }


async def _names(db: AsyncSession, ids: set[str]) -> dict[str, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = (await db.execute(select(User.id, User.display_name, User.username).where(User.id.in_(ids)))).all()
    return {r.id: (r.display_name or r.username) for r in rows}


def _visible(user_id: str):
    """해당 사용자가 조회 가능한 작업 — 본인이 생성했거나 담당인 작업."""
    return or_(TaskDB.user_id == user_id, TaskDB.assignee_id == user_id)


def _mine(t: TaskDB | None, user_id: str) -> bool:
    return bool(t) and (t.user_id == user_id or t.assignee_id == user_id)


async def _load_visible(db: AsyncSession, user_id: str, task_id: str) -> TaskDB | None:
    """본인이 생성했거나 담당인 작업, 또는 그러한 작업의 하위 작업(담당자가 체크리스트를 체크할 수 있도록 허용)."""
    task = await db.get(TaskDB, task_id)
    if not task:
        return None
    if _mine(task, user_id):
        return task
    if task.parent_id and _mine(await db.get(TaskDB, task.parent_id), user_id):
        return task
    return None


async def _subtask_counts(db: AsyncSession, task_ids: list[str]) -> dict[str, tuple[int, int]]:
    """Return {parent_id: (total, completed)} for given parent IDs."""
    if not task_ids:
        return {}
    result = await db.execute(
        select(
            TaskDB.parent_id,
            func.count(TaskDB.id).label("total"),
            func.sum(case((TaskDB.status == "done", 1), else_=0)).label("completed"),
        )
        .where(TaskDB.parent_id.in_(task_ids))
        .group_by(TaskDB.parent_id)
    )
    return {
        row.parent_id: (row.total, int(row.completed or 0))
        for row in result.all()
    }


async def _one_dict(db: AsyncSession, task: TaskDB) -> dict:
    counts = await _subtask_counts(db, [task.id])
    sc, cc = counts.get(task.id, (0, 0))
    names = await _names(db, {task.assignee_id} if task.assignee_id else set())
    return _task_to_dict(task, subtask_count=sc, completed_subtask_count=cc,
                         assignee_name=names.get(task.assignee_id or ""))


async def get_tasks(
    db: AsyncSession,
    user_id: str,
    status: str | None = None,
    priority: str | None = None,
    due_from: datetime | None = None,
    due_to: datetime | None = None,
    sort_by: str = "created_at",
    sort_dir: str = "desc",
    page: int = 0,
    limit: int = 50,
    parent_id: str | None = None,
    assignee: str | None = None,
    tag: str | None = None,
    project: str | None = None,
    parent_visible: bool = False,
) -> tuple[list[dict], int]:
    """Query tasks with optional filters. Returns (tasks, total).

    parent_id behaviour:
      - None (default): return only top-level tasks (parent_id IS NULL)
      - a task id string: return subtasks of that parent

    조회 범위는 항상 "본인이 생성했거나 담당" 이다. assignee 필터:
      - "me": 본인이 담당인 작업 / "none": 담당자 없음 / 사용자 id: 해당 사용자가 담당인 작업(조회 가능한 범위 내)
    status 는 쉼표로 복수 지정 가능(todo,review).
    """
    # 호출자가 부모 작업의 조회 가능 여부를 확인한 경우(하위 작업 목록) 하위 작업은 생성자와 무관하게 조회됨
    conditions = [] if (parent_id is not None and parent_visible) else [_visible(user_id)]

    # By default only return top-level tasks; when parent_id is given, return subtasks
    if parent_id is None:
        conditions.append(TaskDB.parent_id.is_(None))
    else:
        conditions.append(TaskDB.parent_id == parent_id)

    if status:
        statuses = [s for s in status.split(",") if s]
        conditions.append(TaskDB.status.in_(statuses) if len(statuses) > 1 else TaskDB.status == statuses[0])
    if priority:
        conditions.append(TaskDB.priority == priority)
    if due_from:
        conditions.append(TaskDB.due_date >= due_from)
    if due_to:
        conditions.append(TaskDB.due_date <= due_to)
    if assignee:
        if assignee == "me":
            conditions.append(TaskDB.assignee_id == user_id)
        elif assignee == "none":
            conditions.append(TaskDB.assignee_id.is_(None))
        else:
            conditions.append(TaskDB.assignee_id == assignee)
    if tag:
        # tags_json 은 JSON 배열 문자열 — 따옴표까지 포함하여 해당 태그만 정확히 일치시킴
        needle = json.dumps(tag.strip(), ensure_ascii=False)
        conditions.append(TaskDB.tags_json.contains(needle, autoescape=True))
    if project:
        conditions.append(TaskDB.project == project)

    where = and_(*conditions)

    # Total count
    count_result = await db.execute(select(func.count(TaskDB.id)).where(where))
    total = count_result.scalar() or 0

    # Sort
    sort_column_map = {
        "due_date": TaskDB.due_date,
        "priority": TaskDB.priority,
        "created_at": TaskDB.created_at,
        "sort_order": TaskDB.sort_order,
        "title": TaskDB.title,
    }
    sort_col = sort_column_map.get(sort_by, TaskDB.created_at)
    order = sort_col.desc() if sort_dir == "desc" else sort_col.asc()

    # Fetch page
    result = await db.execute(
        select(TaskDB)
        .where(where)
        # id 2차 정렬 기준 — 동일 시각·동일 값 항목이 페이지 경계에서 중복되거나 누락되지 않도록 함
        .order_by(order, TaskDB.id.asc())
        .offset(page * limit)
        .limit(limit)
    )
    task_rows = result.scalars().all()

    # Fetch subtask counts for each task
    task_ids = [t.id for t in task_rows]
    counts = await _subtask_counts(db, task_ids)
    names = await _names(db, {t.assignee_id for t in task_rows if t.assignee_id})

    tasks = []
    for t in task_rows:
        sc, cc = counts.get(t.id, (0, 0))
        tasks.append(_task_to_dict(t, subtask_count=sc, completed_subtask_count=cc,
                                   assignee_name=names.get(t.assignee_id or "")))

    return tasks, total


async def get_task(db: AsyncSession, user_id: str, task_id: str) -> dict | None:
    task = await _load_visible(db, user_id, task_id)
    if not task:
        return None
    return await _one_dict(db, task)


async def valid_assignee(db: AsyncSession, assignee_id: str) -> bool:
    u = await db.get(User, assignee_id)
    return bool(u and u.is_active)


async def _notify_assigned(db: AsyncSession, task: TaskDB, actor_id: str) -> None:
    """담당 배정 알림 — 본인에게 배정한 경우는 알리지 않는다. 실패하더라도 작업 저장은 이미 완료된 상태이다."""
    if not task.assignee_id or task.assignee_id == actor_id:
        return
    try:
        from app.notifications.service import create_notification

        actor = await db.get(User, actor_id)
        actor_name = (actor.display_name or actor.username) if actor else None
        await create_notification(
            db, task.assignee_id, "task_assigned",
            f"{actor_name or '누군가'} 님이 작업을 맡겼습니다: {task.title}"[:255],
            body=(task.description or "")[:200] or None,
            link=f"/tasks?task={task.id}",
            actor_id=actor_id, actor_name=actor_name,
            action_url=f"/tasks?task={task.id}",
        )
    except Exception as e:
        logger.warning("작업 배정 알림 실패(%s): %s", task.id, e)


async def create_task(db: AsyncSession, user_id: str, data: dict) -> dict:
    task = TaskDB(
        user_id=user_id,
        title=data["title"],
        description=data.get("description"),
        due_date=data.get("due_date"),
        priority=data.get("priority", "medium"),
        status=data.get("status", "todo"),
        calendar_event_id=data.get("calendar_event_id"),
        sort_order=data.get("sort_order", 0),
        parent_id=data.get("parent_id"),
        assignee_id=data.get("assignee_id") or None,
        tags_json=json.dumps(normalize_tags(data.get("tags")), ensure_ascii=False) if data.get("tags") else None,
        project=(data.get("project") or None),
        channel_id=(data.get("channel_id") or None),
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    await _notify_assigned(db, task, user_id)
    return await _one_dict(db, task)


async def update_task(
    db: AsyncSession, user_id: str, task_id: str, data: dict
) -> dict | None:
    task = await _load_visible(db, user_id, task_id)
    if not task:
        return None

    # 상위 작업 변경 — 생성 시와 동일한 규칙을 적용한다. 이전에는 검사가 없어 본인 작업을 타인의 작업 하위로 삽입하거나
    # (상대의 하위 목록·진행률에 표시된다) 자기 자신을 상위로 지정하여 목록에서 사라지게 할 수 있었다.
    new_parent = data.get("parent_id")
    if new_parent is not None and new_parent != task.parent_id:
        if new_parent == task.id:
            raise ValueError("자기 자신을 상위 작업으로 둘 수 없습니다")
        parent = await db.get(TaskDB, new_parent)
        if not _mine(parent, user_id):
            raise ValueError("상위 작업을 찾을 수 없습니다")
        if parent.parent_id:
            raise ValueError("하위 작업은 한 단계만 둘 수 있습니다")
        has_children = (await db.execute(
            select(TaskDB.id).where(TaskDB.parent_id == task.id).limit(1)
        )).first()
        if has_children:
            raise ValueError("하위 작업이 있는 작업은 다른 작업 밑으로 옮길 수 없습니다")

    for field in ("title", "priority", "status", "sort_order", "parent_id"):
        if field in data and data[field] is not None:
            setattr(task, field, data[field])
    # 비울 수 있는 필드 — 전달된 null 은 "없음"을 의미한다(마감 없음·설명 삭제·일정 연결 해제). 이전에는 None 을 건너뛰어
    # 화면에서 [마감 없음]을 선택해도 서버 응답으로 기존 날짜가 반환되었다.
    for field in ("description", "due_date", "calendar_event_id"):
        if field in data:
            v = data[field]
            setattr(task, field, (v or None) if field != "due_date" else v)

    # 신규 필드 — 비우기(None·빈 값)도 반영
    reassigned = False
    if "assignee_id" in data:
        if task.user_id != user_id:
            raise TaskPermissionError("담당자는 만든 사람만 바꿀 수 있습니다")
        new = data["assignee_id"] or None
        reassigned = new != task.assignee_id and new is not None
        task.assignee_id = new
    if "tags" in data:
        tags = normalize_tags(data["tags"])
        task.tags_json = json.dumps(tags, ensure_ascii=False) if tags else None
    if "project" in data:
        task.project = data["project"] or None
    if "channel_id" in data:
        if task.user_id != user_id:
            raise TaskPermissionError("채널은 만든 사람만 바꿀 수 있습니다")
        task.channel_id = data["channel_id"] or None

    task.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    if reassigned:
        await _notify_assigned(db, task, user_id)
    return await _one_dict(db, task)


async def delete_task(db: AsyncSession, user_id: str, task_id: str) -> bool:
    task = await _load_visible(db, user_id, task_id)
    if not task:
        return False
    if task.user_id != user_id:
        # 하위 작업(체크리스트)은 상위 작업의 생성자도 삭제할 수 있다 — 담당자가 추가한 항목을
        # 소유자가 삭제하지 못해 403 이 발생했다(상위 작업 전체 삭제는 가능했다).
        parent = await db.get(TaskDB, task.parent_id) if task.parent_id else None
        if not (parent and parent.user_id == user_id):
            raise TaskPermissionError("작업은 만든 사람만 지울 수 있습니다")
    # 하위 작업도 함께 삭제한다("하위 작업도 함께 지워집니다") — DB FK(CASCADE)가 없던 운영 DB 에서 고아 행이 남았다.
    # FK 가 있어도 앱에서 먼저 삭제하여 DB 와 무관하게 결과를 동일하게 한다. 하위의 하위까지 포함한다.
    ids, frontier = [], [task.id]
    while frontier:
        rows = (await db.execute(select(TaskDB.id).where(TaskDB.parent_id.in_(frontier)))).scalars().all()
        frontier = [r for r in rows if r not in ids and r != task.id]
        ids.extend(frontier)
    if ids:
        await db.execute(sa_delete(TaskDB).where(TaskDB.id.in_(ids)))
    await db.delete(task)
    await db.commit()
    return True


async def toggle_task(db: AsyncSession, user_id: str, task_id: str) -> dict | None:
    """Toggle task between 'todo' and 'done'."""
    task = await _load_visible(db, user_id, task_id)
    if not task:
        return None

    task.status = "done" if task.status != "done" else "todo"
    task.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    return await _one_dict(db, task)


async def list_projects_and_tags(db: AsyncSession, user_id: str) -> dict:
    """필터 드롭다운용 — 본인이 조회 가능한 작업에 사용된 프로젝트·태그."""
    rows = (await db.execute(
        select(TaskDB.project, TaskDB.tags_json).where(_visible(user_id))
    )).all()
    projects, tags = set(), set()
    for p, tj in rows:
        if p:
            projects.add(p)
        if tj:
            try:
                tags.update(str(x) for x in json.loads(tj) if x)
            except ValueError:
                pass
    return {"projects": sorted(projects), "tags": sorted(tags)}
