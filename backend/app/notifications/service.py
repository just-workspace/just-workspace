"""Unified notification service — async SQLAlchemy CRUD."""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import and_, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Notification, NotificationPref


logger = logging.getLogger(__name__)

# 알림 타입(컬럼 길이 20자). 순서는 프로필 '알림' 탭 매트릭스 순서.
# 생성 지점: mention(채팅 멘션) · system(캘린더 알림·시험 푸시) · task_assigned(작업 담당 배정) ·
#           meeting_invite(회의 초대 — 수락/거절 행동 버튼).
# 타입만 있음(생성 지점은 각 모듈 담당 브랜치에서 연결): thread_reply · new_mail · board_must_read ·
#           file_shared · calendar_invite
NOTIFICATION_TYPES = [
    "mention", "thread_reply", "task_assigned", "meeting_invite", "calendar_invite",
    "file_shared", "new_mail", "board_must_read", "system",
]
VALID_TYPES = set(NOTIFICATION_TYPES)

ACTION_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}


def _clean_actions(actions: list[dict] | None) -> list[dict] | None:
    """행동 버튼 정리 — 같은 출처 API 경로(/api/...)만, 최대 4개. 외부 URL 은 버린다."""
    if not actions:
        return None
    out = []
    for a in actions[:4]:
        if not isinstance(a, dict):
            continue
        url = str(a.get("url") or "")
        method = str(a.get("method") or "POST").upper()
        if not url.startswith("/") or url.startswith("//") or method not in ACTION_METHODS:
            continue
        item = {"id": str(a.get("id") or len(out)), "label": str(a.get("label") or "")[:40],
                "method": method, "url": url[:500]}
        if isinstance(a.get("body"), dict):
            item["body"] = a["body"]
        out.append(item)
    return out or None


def _notif_to_dict(n: Notification) -> dict:
    actions = None
    if getattr(n, "actions_json", None):
        try:
            actions = json.loads(n.actions_json)
        except ValueError:
            actions = None
    return {
        "id": n.id,
        "user_id": n.user_id,
        "type": n.type,
        "title": n.title,
        "body": n.body,
        "link": n.link,
        "is_read": n.is_read,
        "created_at": n.created_at,
        "actor_id": getattr(n, "actor_id", None),
        "actor_name": getattr(n, "actor_name", None),
        "action_url": getattr(n, "action_url", None) or n.link,
        "actions": actions,
    }


async def get_type_pref(db: AsyncSession, user_id: str, type: str) -> tuple[bool, bool, bool]:
    """(in_app, push, email). 저장된 행이 없으면 전부 켜짐(하위호환)."""
    row = (await db.execute(
        select(NotificationPref).where(NotificationPref.user_id == user_id, NotificationPref.type == type)
    )).scalars().first()
    if row is None:
        return True, True, True
    return bool(row.in_app), bool(row.push), bool(row.email)


async def create_notification(
    db: AsyncSession,
    user_id: str,
    type: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    push: bool = True,
    actor_id: str | None = None,
    actor_name: str | None = None,
    action_url: str | None = None,
    actions: list[dict] | None = None,
) -> dict:
    """Create a notification and return it as a dict.

    `push=False` 면 인앱(실시간·배지)만 하고 웹푸시는 건너뛴다 — 채널 알림 설정이 'none' 인 멘션.
    타입별 알림 설정(NotificationPref)을 따른다:
      - push 끔 → 웹푸시 안 함
      - in_app 끔 → 기록은 남기되 읽음 상태로 넣고 실시간·배지는 보내지 않는다(활동 수신함에선 보인다)
    """
    ntype = type if type in VALID_TYPES else "system"
    try:
        in_app, push_on, _email = await get_type_pref(db, user_id, ntype)
    except Exception:
        in_app, push_on = True, True
    clean = _clean_actions(actions)
    notif = Notification(
        id=str(uuid.uuid4()),
        user_id=user_id,
        type=ntype,
        title=title,
        body=body,
        link=link,
        is_read=not in_app,
        actor_id=actor_id,
        actor_name=(actor_name or None) and actor_name[:255],
        action_url=action_url,
        actions_json=json.dumps(clean, ensure_ascii=False) if clean else None,
    )
    db.add(notif)
    await db.commit()
    await db.refresh(notif)
    d = _notif_to_dict(notif)
    await _deliver(d, push=push and push_on, realtime=in_app)
    return d


async def _deliver(d: dict, push: bool = True, realtime: bool = True) -> None:
    """만든 알림을 실시간으로 보내고, 그 사용자가 어디에도 접속해 있지 않으면 웹푸시.

    여기서 한 번에 처리하므로 알림을 만드는 쪽(채팅 멘션·캘린더·파일 공유…)은 따로 발행할 필요가 없다.
    방해 금지(app/chat/presence.py push_allowed)는 _push 안에서 걸러진다.
    """
    from app.realtime.events import emit_to_user, is_connected

    if realtime:
        # quiet = 방해 금지(지금 켜기·일정) 중. 데스크톱 앱은 소켓이 붙어 있어 웹푸시 대신 자체 토스트를 띄우므로
        # 같은 게이트를 따르게 알려준다(배지·활동 수신함은 그대로). 웹 탭은 이 값을 쓰지 않는다.
        try:
            from app.notifications.dnd import push_allowed
            quiet = not await push_allowed(d["user_id"])
        except Exception:
            quiet = False
        try:
            await emit_to_user(d["user_id"], {"type": "notification", "notification": d, "quiet": quiet})
        except Exception as e:
            logger.warning("알림 실시간 전달 실패(%s): %s", d["user_id"], e)
    if not push:
        return
    try:
        if not await is_connected(d["user_id"]):
            asyncio.create_task(_push(d))
    except Exception as e:
        logger.debug("푸시 판단 실패: %s", e)


async def _push(d: dict) -> None:
    try:
        from app.notifications.dnd import push_allowed
        if not await push_allowed(d["user_id"]):
            return   # 방해 금지(지금 켜기·일정) — 인앱 알림은 이미 갔고 푸시만 삼킨다
        from app.push.router import send_push
        await send_push(d["user_id"], d["title"], d.get("body") or "", d.get("link") or "/")
    except Exception as e:
        logger.debug("push 실패(%s): %s", d["user_id"], e)


async def get_notifications(
    db: AsyncSession,
    user_id: str,
    unread_only: bool = False,
    limit: int = 20,
    offset: int = 0,
    types: list[str] | None = None,
) -> tuple[list[dict], int]:
    """Get notifications for a user. Returns (notifications, total). types 가 있으면 그 타입만."""
    conditions = [Notification.user_id == user_id]
    if unread_only:
        conditions.append(Notification.is_read == False)  # noqa: E712
    if types:
        conditions.append(Notification.type.in_(types))

    where = and_(*conditions)

    # Total count
    count_result = await db.execute(
        select(func.count(Notification.id)).where(where)
    )
    total = count_result.scalar() or 0

    # Fetch page
    result = await db.execute(
        select(Notification)
        .where(where)
        .order_by(Notification.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    notifications = [_notif_to_dict(n) for n in result.scalars().all()]
    return notifications, total


async def get_unread_count(db: AsyncSession, user_id: str) -> int:
    """Get count of unread notifications for a user."""
    result = await db.execute(
        select(func.count(Notification.id)).where(
            Notification.user_id == user_id,
            Notification.is_read == False,  # noqa: E712
        )
    )
    return result.scalar() or 0


async def mark_as_read(
    db: AsyncSession, user_id: str, notification_id: str
) -> bool:
    """Mark a single notification as read. Returns True if found."""
    result = await db.execute(
        update(Notification)
        .where(
            Notification.id == notification_id,
            Notification.user_id == user_id,
        )
        .values(is_read=True)
    )
    await db.commit()
    return result.rowcount > 0


async def mark_all_as_read(db: AsyncSession, user_id: str) -> int:
    """Mark all unread notifications as read. Returns count updated."""
    result = await db.execute(
        update(Notification)
        .where(
            Notification.user_id == user_id,
            Notification.is_read == False,  # noqa: E712
        )
        .values(is_read=True)
    )
    await db.commit()
    return result.rowcount


async def delete_notification(
    db: AsyncSession, user_id: str, notification_id: str
) -> bool:
    """Delete a notification. Returns True if found and deleted."""
    result = await db.execute(
        delete(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == user_id,
        )
    )
    await db.commit()
    return result.rowcount > 0
