"""Notification API schemas."""

from datetime import datetime

from pydantic import BaseModel, Field


class NotificationResponse(BaseModel):
    id: str
    user_id: str
    type: str
    title: str
    body: str | None = None
    link: str | None = None
    is_read: bool
    created_at: datetime
    # 발신자·행동(활동 수신함). 이전 알림은 값이 없다.
    actor_id: str | None = None
    actor_name: str | None = None
    action_url: str | None = None
    # [{id, label, method, url, body?}] — 예: 회의 초대 수락/거절
    actions: list[dict] | None = None


class NotificationListResponse(BaseModel):
    notifications: list[NotificationResponse]
    total: int = 0


class UnreadCountResponse(BaseModel):
    count: int


class NotificationReadRequest(BaseModel):
    notification_ids: list[str] | None = None
