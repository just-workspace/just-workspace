"""사용자 기본 할당(관리 › 저장소·백업 "사용자 기본 할당").

설정 키 files.user_quota_gb — 0(기본) = 제한 없음. 내 파일(my/ 아래, storage_root/users/{id})에 올리는
업로드만 센다. 공유 폴더·채널 파일은 개인 할당에 넣지 않는다.

사용량은 fs.get_dir_size(트리 순회, 자체 TTL 캐시)로 잰다 — 정확한 회계가 아니라 "넘치기 전에 막는"
문지기라 캐시 시간만큼 조금 넘칠 수 있다. 그룹별 할당은 아직 없다(모든 사용자 같은 값).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings

KEY_USER_QUOTA_GB = "files.user_quota_gb"
GB = 1024 ** 3


async def get_user_quota_gb(db: AsyncSession) -> int:
    from app.admin.settings import get_setting

    try:
        return max(0, int(await get_setting(db, KEY_USER_QUOTA_GB) or 0))
    except (TypeError, ValueError):
        return 0


async def personal_usage(user_id: str) -> int:
    from app.files import service as fs

    p = Path(get_settings().storage_root) / "users" / user_id
    return await asyncio.to_thread(fs.get_dir_size, p)


async def room_left(db: AsyncSession, user, vpath: str) -> int | None:
    """내 파일에 더 넣을 수 있는 바이트. 제한 없음/내 파일 밖이면 None."""
    vp = (vpath or "").strip("/")
    if not (vp == "my" or vp.startswith("my/")):
        return None
    quota_gb = await get_user_quota_gb(db)
    if quota_gb <= 0:
        return None
    return max(0, quota_gb * GB - await personal_usage(user.id))


def quota_error(quota_gb: int | None = None) -> HTTPException:
    q = f"({quota_gb}GB)" if quota_gb else ""
    return HTTPException(
        status_code=413,
        detail=f"내 파일 할당{q}을 넘습니다. 파일을 정리하거나 관리자에게 문의하세요",
    )


async def ensure_room(db: AsyncSession, user, vpath: str, incoming: int) -> int | None:
    """incoming 바이트를 더 넣을 자리가 없으면 413. 남은 자리(제한 없으면 None)를 돌려준다."""
    room = await room_left(db, user, vpath)
    if room is not None and max(0, int(incoming or 0)) > room:
        raise quota_error(await get_user_quota_gb(db))
    return room
