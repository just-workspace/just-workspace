"""Unified Notification Center API endpoints."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import NotificationPref, User
from app.db.session import get_db
from app.notifications import service
from app.notifications.schemas import (
    NotificationListResponse,
    NotificationResponse,
    UnreadCountResponse,
)

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

# 알림 타입 — 프로필 '알림' 탭에서 채널별(in_app/push/email) 토글. 정의는 service 한 곳.
NOTIFICATION_TYPES = service.NOTIFICATION_TYPES


@router.get("", response_model=NotificationListResponse, include_in_schema=False)
@router.get("/", response_model=NotificationListResponse)
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    type: str | None = Query(None, description="타입 필터, 쉼표로 여러 개(mention,thread_reply)"),
    unread: bool | None = Query(None, description="true 면 안 읽은 것만(unread_only 와 같음)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List notifications for the current user. 활동 수신함용 type·unread 필터."""
    types = [t.strip() for t in type.split(",") if t.strip()] if type else None
    notifications, total = await service.get_notifications(
        db, user.id, unread_only=bool(unread_only or unread), limit=limit, offset=offset, types=types,
    )
    return {"notifications": [NotificationResponse(**n) for n in notifications], "total": total}


# ── 시험 푸시 · 방해 금지 일정 ──────────────────────────────


@router.post("/test", response_model=dict)
async def test_push(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """시험 푸시 — 내 구독 기기 전부에 보낸다. 방해 금지 일정은 건너뛰고(시험이니까), 걸려 있었는지는 알려 준다."""
    from sqlalchemy import func as _f

    from app.db.models import PushSubscription
    from app.notifications import dnd
    from app.push.router import send_push

    subs = (await db.execute(
        select(_f.count(PushSubscription.id)).where(PushSubscription.user_id == str(user.id))
    )).scalar() or 0
    sent = 0
    if subs:
        sent = await send_push(str(user.id), "시험 알림", "알림이 이 기기에 잘 도착합니다.", "/", bypass_dnd=True)
    return {
        "ok": bool(sent),
        "subscriptions": subs,
        "sent": sent,
        "dnd_scheduled_now": await dnd.schedule_blocks(str(user.id)),
        "detail": None if subs else "이 계정에 등록된 푸시 구독이 없습니다(브라우저에서 알림 허용 필요)",
    }


@router.get("/dnd-schedule", response_model=dict)
async def get_dnd_schedule(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """방해 금지 일정 — 없으면 꺼진 기본값. active 는 지금 일정에 걸려 있는지."""
    from app.me.prefs import get_prefs
    from app.notifications import dnd

    prefs = await get_prefs(db, str(user.id))
    sched = prefs.get(dnd.PREF_KEY) or {
        "enabled": False, "days": [0, 1, 2, 3, 4, 5, 6], "start": "22:00", "end": "08:00", "timezone": None,
    }
    return {"schedule": sched, "active": dnd.in_quiet_hours(sched, fallback_tz=prefs.get("timezone"))}


@router.put("/dnd-schedule", response_model=dict)
async def put_dnd_schedule(
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """방해 금지 일정 저장. {enabled, days:[0(월)..6(일)], start:"HH:MM", end:"HH:MM", timezone?}"""
    from app.me.prefs import set_server_pref
    from app.notifications import dnd

    sched = dnd.validate(body)
    prefs = await set_server_pref(db, str(user.id), dnd.PREF_KEY, sched)
    return {"schedule": sched, "active": dnd.in_quiet_hours(sched, fallback_tz=prefs.get("timezone"))}


@router.get("/unread-count", response_model=UnreadCountResponse)
async def unread_count(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get count of unread notifications (for badge)."""
    count = await service.get_unread_count(db, user.id)
    return {"count": count}


async def _emit_unread(db: AsyncSession, user_id: str) -> None:
    """읽음·삭제 뒤 안 읽은 수를 그 사용자의 모든 탭·기기에 알린다.

    예전에는 DB 만 고쳐서 다른 탭·기기의 벨 배지가 보정 폴링(5분)까지 그대로였다.
    실시간 전달 실패는 읽음 처리 자체를 실패시키지 않는다.
    """
    try:
        from app.realtime.events import emit_to_user

        count = await service.get_unread_count(db, user_id)
        await emit_to_user(str(user_id), {"type": "notification_read", "unread": count})
    except Exception:  # noqa: BLE001
        pass


@router.patch("/{notification_id}/read", response_model=dict)
async def mark_read(
    notification_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark a single notification as read."""
    ok = await service.mark_as_read(db, user.id, notification_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Notification not found")
    await _emit_unread(db, user.id)
    return {"ok": True}


@router.post("/read-all", response_model=dict)
async def mark_all_read(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark all notifications as read."""
    count = await service.mark_all_as_read(db, user.id)
    await _emit_unread(db, user.id)
    return {"ok": True, "updated": count}


@router.delete("/{notification_id}", response_model=dict)
async def delete_notification(
    notification_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a notification."""
    ok = await service.delete_notification(db, user.id, notification_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Notification not found")
    await _emit_unread(db, user.id)
    return {"ok": True}


# ── 알림 선호(채널별 on/off) — 프로필 '알림' 탭 ──────────────


class NotificationPrefItem(BaseModel):
    type: str
    in_app: bool = True
    push: bool = True
    email: bool = True


class NotificationPrefUpdate(BaseModel):
    prefs: list[NotificationPrefItem]


@router.get("/prefs", response_model=dict)
async def get_prefs(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """타입별 알림 채널 선호. 저장된 행이 없는 타입은 전체 on(하위호환)."""
    rows = (await db.execute(
        select(NotificationPref).where(NotificationPref.user_id == user.id)
    )).scalars().all()
    by_type = {r.type: r for r in rows}
    prefs = []
    for t in NOTIFICATION_TYPES:
        r = by_type.get(t)
        prefs.append({
            "type": t,
            "in_app": r.in_app if r else True,
            "push": r.push if r else True,
            "email": r.email if r else True,
        })
    return {"prefs": prefs}


@router.put("/prefs", response_model=dict)
async def update_prefs(
    body: NotificationPrefUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """알림 채널 선호 upsert(caller 본인만). 알 수 없는 타입은 무시."""
    existing = {
        r.type: r for r in (await db.execute(
            select(NotificationPref).where(NotificationPref.user_id == user.id)
        )).scalars().all()
    }
    now = datetime.now(timezone.utc)
    for item in body.prefs:
        if item.type not in NOTIFICATION_TYPES:
            continue
        row = existing.get(item.type)
        if row:
            row.in_app, row.push, row.email, row.updated_at = item.in_app, item.push, item.email, now
        else:
            db.add(NotificationPref(
                user_id=user.id, type=item.type,
                in_app=item.in_app, push=item.push, email=item.email,
            ))
    await db.commit()
    return {"ok": True}
