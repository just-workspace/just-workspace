"""보관 시스템 카테고리(시안 §2.1(3)) — "보관된 프로젝트". 이름은 바꿀 수 있고 삭제·순서 변경은 안 된다(늘 DM 바로 위).

id 는 system_settings 'chat.archive_category_id'. PG 는 기동 마이그레이션(session._run_chat_archive_category_migration)
이 채운다. 비어 있으면(SQLite 테스트·마이그레이션 실패) 처음 읽는 요청이 같은 규칙으로 채운다.
보관(is_archived) 채널의 category_id 는 옮기지 않는다 — 프런트가 보관 채널을 늘 이 구역에 그린다.
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
    """설정에 있고 그 카테고리가 실제로 있을 때만 id."""
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
