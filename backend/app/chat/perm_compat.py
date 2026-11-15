"""chat22 새 기능의 권한 판정 한 곳 — 스레드 관리(MANAGE_THREADS)·이모지 관리(MANAGE_EXPRESSIONS)·포럼 게시판 생성.

r24 권한 엔진(app/chat/permissions.py)은 이 브랜치에 병합돼 있다(10aacac) — ImportError 폴백은 두지 않는다.
# TODO(r24): enforce 전환이 끝나면 can_manage_thread 의 "예전 규칙"(채널 owner/admin·전역 관리자) 합집합을 빼고
#            엔진 비트만 본다. 지금은 shadow 기본이라 예전에 되던 사람(owner/admin)이 갑자기 막히지 않게 둘 다 허용.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import permissions as P
from app.db.models import Channel, ChannelMember, Message


async def _member_role(db: AsyncSession, channel_id: str, user_id: str) -> str | None:
    return (await db.execute(
        select(ChannelMember.role).where(ChannelMember.channel_id == channel_id, ChannelMember.user_id == user_id)
    )).scalar_one_or_none()


async def can_manage_thread(db: AsyncSession, user, channel: Channel, root: Message | None = None) -> bool:
    """스레드 이름·보관·자동 보관 바꾸기 — 루트 작성자 또는 MANAGE_THREADS.

    예전 규칙(엔진 없던 때 계약): 채널 owner/admin · 전역 관리자. 엔진: 그 채널의 실효 비트 MANAGE_THREADS.
    legacy 모드면 예전 규칙만, 그 외엔 둘 중 하나면 된다(TODO(r24) 위 참고).
    """
    uid = str(user.id)
    if root is not None and root.sender_id == uid:
        return True
    role = await _member_role(db, channel.id, uid)
    if getattr(user, "is_admin", False) or role in ("owner", "admin"):
        return True
    if P.engine_mode() == "legacy":
        return False
    try:
        bits = await P.guarded(db, lambda: P.effective_permissions(db, user, channel))
    except Exception:
        return False
    return bool(bits & P.MANAGE_THREADS)


async def can_manage_expressions(db: AsyncSession, user) -> bool:
    """커스텀 이모지 올리기·이름 바꾸기·지우기 — 워크스페이스 범위 MANAGE_EXPRESSIONS.

    @everyone 기본값엔 이 비트가 없어서 기본은 전역 관리자만(계약의 "r24 없으면 전역 관리자만"과 같은 결과).
    역할로 주면 그 사람도 된다. 새 기능이라 엔진 모드와 무관(roles.py 의 관리 판정과 같은 규칙).
    """
    if getattr(user, "is_admin", False):
        return True
    try:
        bits = await P.guarded(db, lambda: P.workspace_permissions(db, user))
    except Exception:
        return False
    return bool(bits & (P.MANAGE_EXPRESSIONS | P.ADMINISTRATOR))


async def can_create_forum_board(db: AsyncSession, user) -> bool:
    """포럼 채널을 만들며 새 게시판까지 만들기 — 게시판은 전사 공용이라 워크스페이스 MANAGE_CHANNELS(기본 = 관리자)."""
    if getattr(user, "is_admin", False):
        return True
    try:
        bits = await P.guarded(db, lambda: P.workspace_permissions(db, user))
    except Exception:
        return False
    return bool(bits & (P.MANAGE_CHANNELS | P.ADMINISTRATOR))
