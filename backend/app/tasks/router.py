"""Tasks API endpoints."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.tasks import service
from app.tasks.schemas import (
    TaskCreate,
    TaskUpdate,
    TaskResponse,
    TaskListResponse,
)
from app.modules.registry import require_module

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("/", response_model=TaskListResponse)
@require_module("tasks")
async def list_tasks(
    status: str | None = Query(None, pattern="^(todo|in_progress|review|done)(,(todo|in_progress|review|done))*$"),
    priority: str | None = Query(None, pattern="^(low|medium|high|urgent)$"),
    due_from: datetime | None = Query(None),
    due_to: datetime | None = Query(None),
    sort_by: str = Query("created_at", pattern="^(due_date|priority|created_at|sort_order|title)$"),
    sort_dir: str = Query("desc", pattern="^(asc|desc)$"),
    page: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    parent_id: str | None = Query(None),
    assignee: str | None = Query(None, max_length=36, description="me | none | 사용자 id"),
    tag: str | None = Query(None, max_length=40),
    project: str | None = Query(None, max_length=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """작업 목록 — 본인이 생성했거나 담당인 작업. assignee·tag·project·status(쉼표로 복수 지정) 필터."""
    tasks, total = await service.get_tasks(
        db, user.id, status, priority, due_from, due_to,
        sort_by, sort_dir, page, limit,
        parent_id=parent_id, assignee=assignee, tag=tag, project=project,
    )
    return {"tasks": [TaskResponse(**t) for t in tasks], "total": total}


@router.get("/facets", response_model=dict)
@require_module("tasks")
async def task_facets(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """필터 드롭다운용 — 본인이 조회 가능한 작업에 사용된 프로젝트·태그 목록."""
    return await service.list_projects_and_tags(db, user.id)


async def _check_assignee(db: AsyncSession, assignee_id: str | None) -> None:
    if assignee_id and not await service.valid_assignee(db, assignee_id):
        raise HTTPException(status_code=400, detail="담당자로 지정할 수 없는 사용자입니다")


async def _check_channel(db: AsyncSession, user: User, channel_id: str | None) -> None:
    """작업을 채널에 연결하려면 해당 채널의 멤버여야 한다(채널 탭 "작업")."""
    if not channel_id:
        return
    from app.chat import service as chat_service
    if not await chat_service.is_channel_member(db, channel_id, user.id):
        raise HTTPException(status_code=403, detail="멤버인 채널에만 작업을 묶을 수 있습니다")


@router.post("/", response_model=TaskResponse, status_code=201)
@require_module("tasks")
async def create_task(
    body: TaskCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Validate parent_id belongs to user and is a top-level task (one level only)
    if body.parent_id:
        parent = await service.get_task(db, user.id, body.parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="Parent task not found")
        if parent.get("parent_id"):
            raise HTTPException(status_code=400, detail="Only one level of nesting allowed")
    await _check_assignee(db, body.assignee_id)
    await _check_channel(db, user, body.channel_id)
    data = body.model_dump()
    result = await service.create_task(db, user.id, data)
    return TaskResponse(**result)


@router.get("/{task_id}", response_model=TaskResponse)
@require_module("tasks")
async def get_task(
    task_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    task = await service.get_task(db, user.id, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse(**task)


@router.get("/{task_id}/subtasks", response_model=TaskListResponse)
@require_module("tasks")
async def list_subtasks(
    task_id: str,
    sort_by: str = Query("created_at", pattern="^(due_date|priority|created_at|sort_order|title)$"),
    sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
    page: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify parent task exists and belongs to user
    parent = await service.get_task(db, user.id, task_id)
    if not parent:
        raise HTTPException(status_code=404, detail="Task not found")

    tasks, total = await service.get_tasks(
        db, user.id,
        sort_by=sort_by, sort_dir=sort_dir,
        page=page, limit=limit,
        parent_id=task_id, parent_visible=True,
    )
    return {"tasks": [TaskResponse(**t) for t in tasks], "total": total}


@router.patch("/{task_id}", response_model=TaskResponse)
@require_module("tasks")
async def update_task(
    task_id: str,
    body: TaskUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")
    await _check_assignee(db, data.get("assignee_id"))
    await _check_channel(db, user, data.get("channel_id"))
    try:
        result = await service.update_task(db, user.id, task_id, data)
    except service.TaskPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        # 상위 작업 지정이 규칙 위반(자기 자신·타인의 작업·2단계)
        raise HTTPException(status_code=400, detail=str(e))
    if not result:
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse(**result)


@router.delete("/{task_id}", response_model=dict)
@require_module("tasks")
async def delete_task(
    task_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        ok = await service.delete_task(db, user.id, task_id)
    except service.TaskPermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"ok": True}


@router.post("/{task_id}/toggle", response_model=TaskResponse)
@require_module("tasks")
async def toggle_task(
    task_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await service.toggle_task(db, user.id, task_id)
    if not result:
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse(**result)
