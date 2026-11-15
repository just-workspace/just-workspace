"""관리 › 보안·SSL "로그인 보호·세션" 정책, 관리 › 저장소·백업 "저장소" 요약·사용자 기본 할당.

- GET/PUT /api/admin/settings/security-policy — app/auth/security_policy.py 가 집행한다.
  2단계 필수를 켤 때, 그 대상에 드는 관리자 본인이 아직 2단계를 안 켰으면 거부한다
  (켜자마자 본인이 등록 화면에 갇히는 일을 막는다).
- GET /api/admin/storage/summary — 저장소 디스크 사용량, 사용자 기본 할당, 휴지통 보관 일수.
- PUT /api/admin/storage/quota — 사용자 기본 할당(GB, 0 = 제한 없음). app/files/quota.py 가 업로드에서 집행.
"""

from __future__ import annotations

import asyncio
import shutil

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import audit
from app.admin.router import _client_ip, require_admin
from app.admin.settings import get_setting, set_setting
from app.auth import security_policy
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.files import quota as file_quota
from app.files import retention

router = APIRouter(prefix="/api/admin", tags=["admin"])
settings = get_settings()


class SecurityPolicyUpdate(BaseModel):
    require_2fa: str | None = None          # off | admins | all
    lockout_enabled: bool | None = None
    new_device_alert: bool | None = None
    idle_timeout_minutes: int | None = None  # 0 | 15 | 30 | 60 | 120 | 240 | 480


def _policy_out(pol: dict) -> dict:
    return {
        **pol,
        "lockout_threshold": security_policy.LOCKOUT_THRESHOLD,
        "lockout_minutes": security_policy.LOCKOUT_MINUTES,
        "idle_choices": list(security_policy.IDLE_CHOICES),
    }


@router.get("/settings/security-policy")
async def get_security_policy(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    return _policy_out(await security_policy.get_policy(db))


@router.put("/settings/security-policy")
async def put_security_policy(
    body: SecurityPolicyUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if body.require_2fa is not None:
        if security_policy.totp_setup_required({"require_2fa": body.require_2fa}, admin):
            raise HTTPException(
                status_code=400,
                detail="먼저 내 2단계 인증을 켜세요(설정 › 보안) — 켜지 않으면 바로 등록 화면에 갇힙니다",
            )
    try:
        pol = await security_policy.set_policy(
            db,
            require_2fa=body.require_2fa,
            lockout_enabled=body.lockout_enabled,
            new_device_alert=body.new_device_alert,
            idle_timeout_minutes=body.idle_timeout_minutes,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await audit.log_action(
        db, admin.id, "settings.security_policy.update", "settings", "security_policy",
        {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None},
        _client_ip(request),
    )
    return _policy_out(pol)


class QuotaUpdate(BaseModel):
    user_quota_gb: int


@router.get("/storage/summary")
async def storage_summary(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    try:
        usage = await asyncio.to_thread(shutil.disk_usage, settings.storage_root)
        total, used, free = usage.total, usage.used, usage.free
    except OSError:
        total = used = free = 0
    trash = await get_setting(db, retention.KEY_TRASH_DAYS)
    return {
        "disk_total": total,
        "disk_used": used,
        "disk_free": free,
        "user_quota_gb": await file_quota.get_user_quota_gb(db),
        "trash_retention_days": int(trash) if trash and trash.isdigit() else retention.DEFAULT_TRASH_DAYS,
    }


@router.put("/storage/quota")
async def put_storage_quota(
    body: QuotaUpdate,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if body.user_quota_gb < 0 or body.user_quota_gb > 100000:
        raise HTTPException(status_code=400, detail="할당은 0~100000GB 범위여야 합니다(0 = 제한 없음)")
    await set_setting(db, file_quota.KEY_USER_QUOTA_GB, str(body.user_quota_gb))
    await audit.log_action(
        db, admin.id, "settings.storage.quota", "settings", "storage",
        {"user_quota_gb": body.user_quota_gb}, _client_ip(request),
    )
    return {"user_quota_gb": body.user_quota_gb}
