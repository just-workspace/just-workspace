"""포럼 채널(chat22) = 게시판(boards) 데이터의 채팅 보기. 글·댓글은 기존 /api/board API 를 그대로 사용한다.

채널은 forum_board_id 만 보유한다. 새 게시판 생성은 전사 공용 자원을 추가하는 동작이므로
워크스페이스 MANAGE_CHANNELS(기본 = 전역 관리자, perm_compat.can_create_forum_board)가 필요하다.
기존 게시판 연결은 게시판이 이미 전체 사용자에게 공개되어 있으므로 채널 생성 권한만 있으면 가능하다.
"""

from __future__ import annotations

import re
import uuid

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Board


def _slug(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40]
    return f"chat-{base + '-' if base else ''}{uuid.uuid4().hex[:8]}"


async def resolve_forum_board(db: AsyncSession, user, name: str, description: str | None,
                              board_id: str | None) -> str:
    if board_id:
        b = await db.get(Board, board_id)
        if b is None:
            raise HTTPException(404, {"code": "board_not_found", "message": "게시판을 찾을 수 없습니다"})
        return b.id
    from app.chat.perm_compat import can_create_forum_board
    if not await can_create_forum_board(db, user):
        raise HTTPException(403, {"code": "forbidden", "message": "새 게시판을 만들 권한이 없습니다 — 기존 게시판을 고르세요"})
    from app.board import service as board_service
    b = await board_service.create_board(db, name=name[:100], slug=_slug(name), description=(description or None))
    return b["id"]
