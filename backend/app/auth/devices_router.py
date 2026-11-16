"""기기 등록·해지 API.

데스크톱 앱의 인증을 세션 쿠키에서 OAuth 로 전환하는 실익이 본 모듈에 있다. 쿠키는
``token_version`` 을 증가시켜야 무효화되며, 이 경우 **해당 사용자의 모든 세션이 함께
무효화된다.** 기기를 별도로 기록해야 "노트북만 끊기" 가 가능하다.

해지가 실효를 가지려면 리프레시 토큰까지 폐기해야 한다 — 행만 삭제하면
토큰이 유효한 상태로 남아 앱이 계속 갱신한다. 따라서 등록 시 토큰 해시를 함께 기록한다.
"""

# 주의: from __future__ import annotations 사용 금지 — FastAPI 가 Pydantic 본문
#   모델을 쿼리 파라미터로 오인한다(app/auth/internal_router.py 참고).
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import OAuthRefreshToken, User, UserDevice
from app.db.session import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/devices", tags=["devices"])


class DeviceRegister(BaseModel):
    name: str = Field(max_length=200)
    platform: str = Field(default="", max_length=32)
    app_version: str = Field(default="", max_length=32)


class DeviceOut(BaseModel):
    id: str
    name: str
    platform: str
    app_version: str
    created_at: str | None
    last_seen_at: str | None
    revoked: bool


def _out(d: UserDevice) -> DeviceOut:
    return DeviceOut(
        id=d.id,
        name=d.name,
        platform=d.platform or "",
        app_version=d.app_version or "",
        created_at=d.created_at.isoformat() if d.created_at else None,
        last_seen_at=d.last_seen_at.isoformat() if d.last_seen_at else None,
        revoked=d.revoked_at is not None,
    )


@router.post("", response_model=DeviceOut, status_code=201)
async def register_device(
    request: Request,
    body: DeviceRegister,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DeviceOut:
    """앱이 토큰 교환 직후 자신을 등록한다.

    동일한 이름·플랫폼의 기기가 이미 있으면 신규 생성하지 않고 기존 행을 재활성화한다. 앱 재설치
    시마다 목록이 증가하면 사용자가 해지 대상을 식별할 수 없다.
    """
    existing = (
        await db.execute(
            select(UserDevice).where(
                UserDevice.user_id == user.id,
                UserDevice.name == body.name,
                UserDevice.platform == body.platform,
            )
        )
    ).scalar_one_or_none()

    now = datetime.now(timezone.utc)
    if existing:
        existing.app_version = body.app_version
        existing.last_seen_at = now
        existing.revoked_at = None
        await db.commit()
        return _out(existing)

    dev = UserDevice(
        user_id=user.id,
        name=body.name,
        platform=body.platform,
        app_version=body.app_version,
        last_seen_at=now,
    )
    db.add(dev)
    await db.commit()
    logger.info("기기 등록: user=%s device=%s (%s)", user.username, body.name, body.platform)
    return _out(dev)


@router.get("")
async def list_devices(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(UserDevice)
            .where(UserDevice.user_id == user.id)
            .order_by(UserDevice.last_seen_at.desc().nullslast())
        )
    ).scalars().all()
    return {"devices": [_out(d) for d in rows]}


@router.delete("/{device_id}")
async def revoke_device(
    device_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """기기를 해지한다 — **리프레시 토큰까지 폐기해야** 실제로 접근이 차단된다."""
    dev = (
        await db.execute(
            select(UserDevice).where(
                UserDevice.id == device_id,
                UserDevice.user_id == user.id,   # 타 사용자의 기기 해지 방지
            )
        )
    ).scalar_one_or_none()
    if not dev:
        raise HTTPException(status_code=404, detail="기기를 찾을 수 없습니다")

    now = datetime.now(timezone.utc)
    dev.revoked_at = now

    revoked = 0
    if dev.refresh_token_hash:
        # 회전된 후속 토큰까지 폐기해야 한다. 현재 저장된 해시는 마지막으로 발급된
        # 토큰의 것이므로, 동일 사용자·클라이언트의 유효한 토큰을 함께 정리한다.
        result = await db.execute(
            update(OAuthRefreshToken)
            .where(
                OAuthRefreshToken.user_id == user.id,
                OAuthRefreshToken.revoked_at.is_(None),
                OAuthRefreshToken.token_hash == dev.refresh_token_hash,
            )
            .values(revoked_at=now)
        )
        revoked = result.rowcount or 0

    await db.commit()
    logger.info(
        "기기 해지: user=%s device=%s tokens_revoked=%d", user.username, dev.name, revoked
    )
    return {"status": "ok", "tokens_revoked": revoked}
