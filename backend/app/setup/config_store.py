"""런타임 설정 저장소 — DB(SystemSetting) 우선, env 시드 폴백.

Cisco Catalyst Center식 단일 웹 컨트롤 플레인 + K8s 대비:
설정을 .env가 아닌 DB에 두어, 배포방식(docker-compose/K8s)과 무관하게 웹에서 라이브로 바꾼다.
우선순위: DB > env(초기 시드) > 코드 기본값.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import SystemSetting


async def get(db: AsyncSession, key: str, default: str | None = None) -> str | None:
    val = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == key))
    return val if val is not None else default


async def get_bool(db: AsyncSession, key: str, default: bool = False) -> bool:
    val = await get(db, key)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


async def set(db: AsyncSession, key: str, value: str) -> None:
    existing = await db.get(SystemSetting, key)
    if existing:
        existing.value = value
    else:
        db.add(SystemSetting(key=key, value=value))


async def get_by_prefix(db: AsyncSession, prefix: str) -> dict[str, str]:
    rows = await db.execute(
        select(SystemSetting.key, SystemSetting.value).where(SystemSetting.key.startswith(prefix))
    )
    return {k: v for k, v in rows.all()}
