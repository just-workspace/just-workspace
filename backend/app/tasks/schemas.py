"""Tasks API schemas."""

from datetime import datetime

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
    title: str = Field(..., max_length=500)
    description: str | None = None
    due_date: datetime | None = None
    priority: str = Field("medium", pattern="^(low|medium|high|urgent)$")
    status: str = Field("todo", pattern="^(todo|in_progress|review|done)$")
    calendar_event_id: str | None = None
    sort_order: int = 0
    parent_id: str | None = None
    # 담당자·태그·프로젝트
    assignee_id: str | None = None
    tags: list[str] = []
    project: str | None = Field(None, max_length=100)
    # 채널 연결(채널 탭 "작업"). 본인이 멤버인 채널만 허용
    channel_id: str | None = None


class TaskUpdate(BaseModel):
    title: str | None = Field(None, max_length=500)
    description: str | None = None
    due_date: datetime | None = None
    priority: str | None = Field(None, pattern="^(low|medium|high|urgent)$")
    status: str | None = Field(None, pattern="^(todo|in_progress|review|done)$")
    calendar_event_id: str | None = None
    sort_order: int | None = None
    parent_id: str | None = None
    # 전달된 경우에만 변경. null 이면 값을 비움(담당 해제·프로젝트 없음).
    assignee_id: str | None = None
    tags: list[str] | None = None
    project: str | None = Field(None, max_length=100)
    # 전달된 경우에만 변경. null 이면 채널 연결 해제(생성자만 가능)
    channel_id: str | None = None


class TaskResponse(BaseModel):
    id: str
    user_id: str
    title: str
    description: str | None = None
    due_date: datetime | None = None
    priority: str
    status: str
    calendar_event_id: str | None = None
    sort_order: int
    parent_id: str | None = None
    subtask_count: int = 0
    completed_subtask_count: int = 0
    created_at: datetime
    updated_at: datetime
    assignee_id: str | None = None
    assignee_name: str | None = None
    tags: list[str] = []
    project: str | None = None
    channel_id: str | None = None


class TaskListResponse(BaseModel):
    tasks: list[TaskResponse]
    total: int = 0
