"""Dashboard API router — aggregated summary for the dashboard page.

오늘 브리핑 줄: 인사 아래 칩(안 읽은 메일 · 나를 부른 것 · 오늘 마감(지남) · 다음 회의 ·
관리자 서비스 이상)과 관리자 운영 띠를 이 한 번의 호출로 그린다. 예전 필드(unread_notifications …)는 그대로 둔다.

- day_start/day_end: 프런트가 캘린더 시간대로 계산한 "오늘" [시작, 끝) ISO. 없으면 UTC 오늘.
- 메일 안 읽음은 메일 서버(IMAP)에 묻는 값이라 4초 제한·60초 캐시, 못 받으면 null(칩 숨김).
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.dashboard import sources
from app.db.models import (
    Notification, Post, Message, ShareLink, TaskDB, User,
    CalendarEventDB, CalendarDB,
)
from app.db.session import get_db
from app.modules.registry import is_module_enabled

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

# "나를 부른 것" — 나에게 직접 온 요청(멘션·스레드 답글·작업 배정·회의/일정 초대). 대시보드 "나에게 온 것" 우선 범위와 같다.
PRIORITY_TYPES = ("mention", "thread_reply", "task_assigned", "meeting_invite", "calendar_invite")
# 서비스 느림 기준 기본값(관리 › 일반 system.latency_warn_ms 가 없을 때 — 관리 개요 타일과 같은 800ms)
LATENCY_WARN_MS = 800


async def _admin_block(db: AsyncSession) -> dict:
    """관리자 운영 띠: 서비스 n/n · 이상(내려감/느림) · 저장소 · 승인 대기."""
    from app.admin.settings import get_setting

    try:
        warn = int((await get_setting(db, "appcfg.system.latency_warn_ms") or "").strip() or 0) or LATENCY_WARN_MS
    except (TypeError, ValueError):
        warn = LATENCY_WARN_MS
    services = {"ok": 0, "total": 0, "issues": []}
    try:
        from app.services.health import get_cached_status

        for s in get_cached_status():
            services["total"] += 1
            if s.status == "ok":
                services["ok"] += 1
                if s.response_ms is not None and s.response_ms >= warn:
                    services["issues"].append({"name": s.name, "status": "slow", "response_ms": s.response_ms})
            elif s.status == "down":
                services["issues"].append({"name": s.name, "status": "down", "response_ms": s.response_ms})
    except Exception as e:
        logger.debug("서비스 상태 요약 실패: %s", e)
    pending = 0
    try:
        from app.admin.users_ext import _status_clause

        pending = (await db.execute(select(func.count(User.id)).where(_status_clause("pending")))).scalar() or 0
    except Exception as e:
        await db.rollback()
        logger.debug("승인 대기 수 실패: %s", e)
    storage = None
    try:
        import shutil

        from app.config import get_settings

        u = await asyncio.to_thread(shutil.disk_usage, get_settings().storage_root)
        storage = {"used": u.used, "total": u.total}
    except OSError:
        pass
    return {"services": services, "pending_users": int(pending), "storage": storage}


@router.get("/summary")
async def dashboard_summary(
    day_start: str | None = Query(None, description="오늘 시작(ISO, 캘린더 시간대 기준)"),
    day_end: str | None = Query(None, description="오늘 끝(ISO, 미포함)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return an aggregated dashboard summary for the current user."""
    uid = str(user.id)
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    s, e = sources.parse_day_range(day_start, day_end)

    # Unread notifications
    unread_notifs = await db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == uid,
            Notification.is_read == False,  # noqa: E712
        )
    ) or 0
    mentions_unread = await db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == uid,
            Notification.is_read == False,  # noqa: E712
            Notification.type.in_(PRIORITY_TYPES),
        )
    ) or 0

    # 아래 모듈별 값은 그 모듈이 켜져 있을 때만 읽고 응답에 넣는다 — 꺼졌거나 설치하지 않은 구역의
    # 값은 0 이 아니라 키 자체가 없다.
    out: dict = {"status": "ok", "unread_notifications": unread_notifs}

    # Tasks by status
    if is_module_enabled("tasks"):
        task_rows = (await db.execute(
            select(TaskDB.status, func.count(TaskDB.id))
            .where(TaskDB.user_id == uid)
            .group_by(TaskDB.status)
        )).all()
        tasks = {row[0]: row[1] for row in task_rows}
        due_today, overdue = await sources.task_counts(db, uid, s, e)
        out["tasks"] = {
            "todo": tasks.get("todo", 0),
            "in_progress": tasks.get("in_progress", 0),
            "done": tasks.get("done", 0),
        }
        out["tasks_due_today"] = due_today
        out["tasks_overdue"] = overdue

    # Recent posts (last 7 days)
    if is_module_enabled("board"):
        out["recent_posts_7d"] = await db.scalar(
            select(func.count(Post.id)).where(Post.created_at >= week_ago)
        ) or 0

    # Recent chat messages (last 7 days)
    if is_module_enabled("chat"):
        out["recent_messages_7d"] = await db.scalar(
            select(func.count(Message.id)).where(Message.created_at >= week_ago)
        ) or 0

    # Active share links
    active_shares = await db.scalar(
        select(func.count(ShareLink.id)).where(
            ShareLink.created_by == uid,
            # 모델에 is_active 가 없다 — 만료 전이고 받기 횟수를 다 쓰지 않은 링크를 활성으로 센다.
            or_(ShareLink.expires_at.is_(None), ShareLink.expires_at > now),
            or_(ShareLink.max_downloads.is_(None), ShareLink.download_count < ShareLink.max_downloads),
        )
    ) or 0

    if is_module_enabled("files"):
        out["active_share_links"] = active_shares

    # Upcoming events (next 7 days)
    if is_module_enabled("calendar"):
        next_week = now + timedelta(days=7)
        my_calendars = (await db.execute(
            select(CalendarDB.id).where(CalendarDB.user_id == uid)
        )).scalars().all()
        upcoming_events = 0
        if my_calendars:
            upcoming_events = await db.scalar(
                select(func.count(CalendarEventDB.id)).where(
                    CalendarEventDB.calendar_id.in_(my_calendars),
                    CalendarEventDB.start >= now,
                    CalendarEventDB.start <= next_week,
                )
            ) or 0
        events = await sources.today_events(db, uid, s, e)
        out["upcoming_events_7d"] = upcoming_events
        out["today_events"] = len(events)
        out["next_meeting"] = sources.next_meeting(events, now)

    # ── 오늘 브리핑 줄 ──
    if is_module_enabled("mail"):
        out["mail_unread"] = await sources.mail_unread(db, user)
    out["mentions_unread"] = int(mentions_unread)
    out["admin"] = await _admin_block(db) if getattr(user, "is_admin", False) else None
    return out
