"""백업 관리 API (admin)."""
import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pathlib import Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import audit
from app.auth.deps import get_current_user
from app.auth.sessions import client_ip
from app.backup import service as backup_service
from app.backup.models import BackupRecord
from app.db.models import SystemSetting, User
from app.db.session import async_session, get_db

router = APIRouter(prefix="/api/admin/backup", tags=["backup"])


def _require_admin(user: User) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")


def _ip(request: Request | None) -> str | None:
    return (client_ip(request) or None) if request is not None else None


class ScheduleUpdate(BaseModel):
    enabled: bool | None = None
    hour_utc: int | None = None       # 0-23 (UTC)
    retention_days: int | None = None


def _rec_dict(r: BackupRecord) -> dict:
    try:
        comps = json.loads(r.components or "{}")
    except Exception:
        comps = {}
    return {
        "id": r.id, "created_at": r.created_at.isoformat() if r.created_at else None,
        "status": r.status, "kind": r.kind, "components": comps,
        "size_bytes": r.size_bytes, "error": r.error,
    }


@router.get("")
async def list_backups(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _require_admin(user)
    return {"backups": [_rec_dict(r) for r in await backup_service.list_backups(db)]}


@router.post("/run", status_code=202)
async def run_backup(request: Request = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _require_admin(user)
    uid = user.id
    await audit.log_action(db, uid, "backup.run", "backup", None, None, _ip(request))

    async def _job():
        async with async_session() as bdb:
            await backup_service.run_backup(bdb, kind="manual", user_id=uid)

    asyncio.create_task(_job())
    return {"ok": True, "message": "백업을 시작했습니다"}


@router.delete("/{backup_id}", status_code=204)
async def delete_backup(backup_id: str, request: Request = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _require_admin(user)
    if not await backup_service.delete_backup(db, backup_id):
        raise HTTPException(status_code=404, detail="백업을 찾을 수 없습니다")
    await audit.log_action(db, user.id, "backup.delete", "backup", backup_id, None, _ip(request))
    return None


@router.get("/{backup_id}/download")
async def download_backup(backup_id: str, request: Request = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _require_admin(user)
    rec = await db.get(BackupRecord, backup_id)
    if not rec or not rec.path or not Path(rec.path).is_dir():
        raise HTTPException(status_code=404, detail="백업 파일을 찾을 수 없습니다")
    # DB 덤프 전체(비밀번호 해시·2단계 비밀·SMTP 비밀번호 포함)가 나간다 — 누가 언제 받았는지 남긴다
    await audit.log_action(
        db, user.id, "backup.download", "backup", backup_id, {"name": Path(rec.path).name}, _ip(request),
    )
    # 백업 디렉토리를 tar.gz 스트림으로 다운로드
    proc = await asyncio.create_subprocess_exec(
        "tar", "czf", "-", "-C", rec.path, ".",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )

    async def _stream():
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            yield chunk
        await proc.wait()

    name = f"backup_{Path(rec.path).name}.tar.gz"
    return StreamingResponse(_stream(), media_type="application/gzip",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ─── 스케줄 설정 (SystemSetting) ───
async def _get(db, key: str, default: str = "") -> str:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    return s.value if s and s.value is not None else default


async def _set(db, key: str, value: str) -> None:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    if s:
        s.value = value
    else:
        db.add(SystemSetting(key=key, value=value))


async def get_schedule(db) -> dict:
    return {
        "enabled": (await _get(db, "backup.enabled", "false")) == "true",
        "hour_utc": int(await _get(db, "backup.hour_utc", "18") or 18),
        "retention_days": int(await _get(db, "backup.retention_days", "30") or 30),
        # 백업이 쌓이는 곳(서버 경로, 읽기 전용 표시) — BACKUP_ROOT
        "target": str(backup_service.BACKUP_ROOT),
    }


@router.get("/schedule/config")
async def schedule_get(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _require_admin(user)
    return await get_schedule(db)


@router.put("/schedule/config")
async def schedule_put(body: ScheduleUpdate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _require_admin(user)
    if body.enabled is not None:
        await _set(db, "backup.enabled", "true" if body.enabled else "false")
    if body.hour_utc is not None:
        await _set(db, "backup.hour_utc", str(max(0, min(23, body.hour_utc))))
    if body.retention_days is not None:
        await _set(db, "backup.retention_days", str(max(1, min(365, body.retention_days))))
    await db.commit()
    await audit.log_action(
        db, user.id, "backup.schedule.update", "backup", None,
        {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None},
    )
    return await get_schedule(db)
