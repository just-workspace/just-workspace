"""메일 보낸 사람 카드(메일 오른쪽 상세 패널).

GET /api/mail/sender?email=… → 그 주소가 이 워크스페이스 사용자면 {user: {id, username, display_name, avatar_url}}, 아니면 {user: null}.
패널의 [채팅]·[통화]가 이 id 로 DM 을 연다. 404 대신 null — 바깥 사람이 보낸 메일이 대부분이라 오류가 아니다.
돌려주는 값은 채팅 사용자 검색(/api/chat/users)이 이미 모두에게 주는 것과 같다(이메일은 되돌려 주지 않는다).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.modules.registry import require_module

router = APIRouter(prefix="/api/mail", tags=["mail"])


async def find_workspace_user(db: AsyncSession, email: str) -> dict | None:
    addr = (email or "").strip().lower()
    if not addr or "@" not in addr:
        return None
    u = (await db.execute(
        select(User).where(func.lower(User.email) == addr, User.is_active == True).limit(1)  # noqa: E712
    )).scalars().first()
    if u is None:
        return None
    return {"id": u.id, "username": u.username, "display_name": u.display_name, "avatar_url": u.avatar_url}


@router.get("/sender")
@require_module("mail")
async def get_sender(
    email: str = Query(..., max_length=320),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return {"user": await find_workspace_user(db, email)}
