"""보관 시스템 카테고리 — "보관된 프로젝트". 이름 변경은 가능하며 삭제·순서 변경은 불가하다(항상 DM 바로 위).

id 는 system_settings 'chat.archive_category_id'. PG 는 기동 마이그레이션(session._run_chat_archive_category_migration)
이 설정한다. 비어 있으면(SQLite 테스트·마이그레이션 실패) 최초 조회 요청이 동일 규칙으로 설정한다.
보관(is_archived) 채널의 category_id 는 변경하지 않는다 — 프런트가 보관 채널을 항상 이 구역에 표시한다.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ChatCategory, SystemSetting

KEY = "chat.archive_category_id"
NAME = "보관된 프로젝트"
SEED_NAME = "보관"


async def get_archive_category_id(db: AsyncSession) -> str | None:
    """설정에 값이 있고 해당 카테고리가 실제로 존재하는 경우에만 id 반환."""
    try:
        row = await db.get(SystemSetting, KEY)
    except Exception:
        return None
    if row is None or not row.value:
        return None
    return row.value if await db.get(ChatCategory, row.value) is not None else None


async def ensure_archive_category(db: AsyncSession) -> str:
    cid = await get_archive_category_id(db)
    if cid:
        return cid
    c = (await db.execute(
        select(ChatCategory).where(ChatCategory.name == SEED_NAME)
        .order_by(ChatCategory.position, ChatCategory.created_at).limit(1)
    )).scalar_one_or_none()
    if c is not None:
        c.name = NAME
    else:
        pos = ((await db.execute(select(func.max(ChatCategory.position)))).scalar() or -1) + 1
        c = ChatCategory(id=str(uuid.uuid4()), name=NAME, position=pos)
        db.add(c)
    await db.flush()
    row = await db.get(SystemSetting, KEY)
    if row is None:
        db.add(SystemSetting(key=KEY, value=c.id))
    else:
        row.value = c.id
    await db.commit()
    return c.id
