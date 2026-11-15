"""대시보드 카드용 가벼운 조회(큰 화면에서 더 꺼내는 카드).

- GET /api/dashboard/frequent-channels : 자주 쓰는 채널 — 최근 30일 내가 쓴 메시지 수 순. 내가 속한, 보관 안 된,
  DM 이 아닌 채널만(그래서 "내가 볼 수 있는 것"만). 미읽음 수는 프런트가 이미 가진 채널 목록에서 붙인다.
- GET /api/dashboard/recent-wiki       : 최근 위키 — 내가 볼 수 있는 공간(공개 · 내 것 · 멤버)의 페이지를 고친 시각 순.
  위키 공간 목록(/api/wiki/spaces)과 같은 가시성 규칙.

나머지 새 카드(최근 파일 · 진행 중 회의 · 저장소 · 팀 출석)는 기존 API 로 그린다.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import Channel, ChannelMember, Message, User, WikiPage, WikiSpace, WikiSpaceMember
from app.db.session import get_db
from app.modules.registry import require_module

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


async def frequent_channels(db: AsyncSession, user_id: str, limit: int = 5, days: int = 30) -> list[dict]:
    """내가 최근 `days` 일 동안 메시지를 많이 쓴 채널 순(같으면 마지막으로 쓴 시각이 최근인 쪽)."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    mine = select(ChannelMember.channel_id).where(ChannelMember.user_id == user_id)
    n = func.count(Message.id).label("n")
    last = func.max(Message.created_at).label("last")
    rows = (await db.execute(
        select(Channel.id, Channel.name, Channel.type, n, last)
        .join(Message, Message.channel_id == Channel.id)
        .where(
            Message.sender_id == user_id,
            Message.created_at >= since,
            Message.is_deleted == False,  # noqa: E712
            Channel.id.in_(mine),
            Channel.type != "dm",
            Channel.is_archived == False,  # noqa: E712
        )
        .group_by(Channel.id, Channel.name, Channel.type)
        .order_by(n.desc(), last.desc())
        .limit(limit)
    )).all()
    return [{"id": r.id, "name": r.name, "type": r.type, "count": int(r.n)} for r in rows]


async def recent_wiki_pages(db: AsyncSession, user_id: str, limit: int = 5) -> list[dict]:
    """내가 볼 수 있는 위키 공간의 페이지 — 고친 시각 최신순."""
    visible = (
        (WikiSpace.visibility == "public")
        | (WikiSpace.owner_id == user_id)
        | (WikiSpace.id.in_(select(WikiSpaceMember.space_id).where(WikiSpaceMember.user_id == user_id)))
    )
    rows = (await db.execute(
        select(WikiPage.id, WikiPage.title, WikiPage.space_id, WikiPage.updated_at, WikiSpace.name.label("space_name"))
        .join(WikiSpace, WikiSpace.id == WikiPage.space_id)
        .where(visible)
        .order_by(WikiPage.updated_at.desc())
        .limit(limit)
    )).all()
    out = []
    for r in rows:
        at = r.updated_at
        if at is not None and at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        out.append({
            "id": r.id, "title": r.title, "space_id": r.space_id, "space_name": r.space_name,
            "updated_at": at.isoformat() if at else None,
        })
    return out


@router.get("/frequent-channels")
@require_module("chat")
async def get_frequent_channels(
    limit: int = Query(5, ge=1, le=12),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return {"items": await frequent_channels(db, str(user.id), limit)}


@router.get("/recent-wiki")
@require_module("wiki")
async def get_recent_wiki(
    limit: int = Query(5, ge=1, le=12),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return {"items": await recent_wiki_pages(db, str(user.id), limit)}
