"""그룹/모듈권한 서비스 — DB 직접 조회(8워커 환경에서 in-memory 캐시는 공유 안 되므로).

grant 없는 모듈은 전체 허용(기존 동작 유지). grant 있으면 해당 그룹 멤버(+admin)만.
grants 테이블은 작고 인덱스가 있어 요청당 조회 비용은 무시할 수준.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.groups.models import GroupMember, ModuleGrant

logger = logging.getLogger(__name__)


async def load_grants(db: AsyncSession) -> None:
    """하위호환용 no-op(과거 캐시 프리로드 호출처 유지). 실제 조회는 요청 시점에 DB로."""
    return None


async def module_grant_groups(db: AsyncSession, module_id: str) -> set[str]:
    rows = (await db.execute(
        select(ModuleGrant.group_id).where(ModuleGrant.module_id == module_id)
    )).scalars().all()
    return set(rows)


async def all_grants(db: AsyncSession) -> dict[str, set[str]]:
    g: dict[str, set[str]] = {}
    for gid, mid in (await db.execute(select(ModuleGrant.group_id, ModuleGrant.module_id))).all():
        g.setdefault(mid, set()).add(gid)
    return g


async def user_group_ids(db: AsyncSession, user_id: str) -> set[str]:
    rows = (await db.execute(
        select(GroupMember.group_id).where(GroupMember.user_id == user_id)
    )).scalars().all()
    return set(rows)


async def user_can_access(db: AsyncSession, user_id: str, module_id: str, is_admin: bool = False) -> bool:
    if is_admin:
        return True
    grants = await module_grant_groups(db, module_id)
    if not grants:           # grant 없으면 전체 허용
        return True
    return bool(grants & await user_group_ids(db, user_id))


async def filter_modules(db: AsyncSession, user_id: str | None, is_admin: bool, modules: list[dict]) -> list[dict]:
    """nav용 — 접근 불가(제한된) 모듈 제외."""
    if is_admin:
        return modules
    grants = await all_grants(db)
    if not grants:
        return modules
    gids = await user_group_ids(db, user_id) if user_id else set()
    out = []
    for m in modules:
        g = grants.get(m["id"])
        if not g or (gids & g):
            out.append(m)
    return out
