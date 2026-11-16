"""chat22 신규 기능의 권한 판정을 단일 위치에서 수행 — 스레드 관리(MANAGE_THREADS)·이모지 관리(MANAGE_EXPRESSIONS)·포럼 게시판 생성.

권한 엔진(app/chat/permissions.py)은 항상 함께 존재한다 — ImportError 폴백은 두지 않는다.
# TODO: enforce 전환이 완료되면 can_manage_thread 의 "예전 규칙"(채널 owner/admin·전역 관리자) 합집합을 제거하고
#            엔진 비트만 검사한다. 현재는 shadow 가 기본이므로 기존에 허용되던 사용자(owner/admin)가 갑자기 차단되지 않도록 둘 다 허용.
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
    """스레드 이름·보관·자동 보관 변경 — 루트 작성자 또는 MANAGE_THREADS.

    예전 규칙(엔진 도입 이전 계약): 채널 owner/admin · 전역 관리자. 엔진: 해당 채널의 실효 비트 MANAGE_THREADS.
    legacy 모드이면 예전 규칙만 적용하고, 그 외에는 둘 중 하나를 충족하면 허용한다(TODO 위 참고).
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
    """커스텀 이모지 업로드·이름 변경·삭제 — 워크스페이스 범위 MANAGE_EXPRESSIONS.

    @everyone 기본값에는 이 비트가 없으므로 기본적으로 전역 관리자만 가능하다(권한 엔진 도입 이전의 "전역 관리자만"과 동일한 결과).
    역할로 부여하면 해당 사용자도 가능하다. 신규 기능이므로 엔진 모드와 무관하다(roles.py 의 관리 판정과 동일 규칙).
    """
    if getattr(user, "is_admin", False):
        return True
    try:
        bits = await P.guarded(db, lambda: P.workspace_permissions(db, user))
    except Exception:
        return False
    return bool(bits & (P.MANAGE_EXPRESSIONS | P.ADMINISTRATOR))


async def can_create_forum_board(db: AsyncSession, user) -> bool:
    """포럼 채널 생성 시 새 게시판까지 생성 — 게시판은 전사 공용이므로 워크스페이스 MANAGE_CHANNELS(기본 = 관리자) 필요."""
    if getattr(user, "is_admin", False):
        return True
    try:
        bits = await P.guarded(db, lambda: P.workspace_permissions(db, user))
    except Exception:
        return False
    return bool(bits & (P.MANAGE_CHANNELS | P.ADMINISTRATOR))
