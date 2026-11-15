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
from app.backup import format as backup_format
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
    include_files: bool | None = None  # 파일 저장소도 백업에 넣는다(로컬 저장소일 때만 뜻이 있다)


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
    return {
        "backups": [_rec_dict(r) for r in await backup_service.list_backups(db)],
        # 백업에는 암호화 키와 비밀번호가 들어 있다 — 화면이 내려받기 옆에 보여 준다
        "secret_warning": backup_format.SECRET_WARNING,
    }


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


@router.get("/{backup_id}/summary")
async def backup_summary(backup_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """백업의 내용 요약(manifest) — 만든 버전·스키마 버전·들어 있는 항목."""
    _require_admin(user)
    rec = await db.get(BackupRecord, backup_id)
    if not rec or not rec.path or not Path(rec.path).is_dir():
        raise HTTPException(status_code=404, detail="백업 파일을 찾을 수 없습니다")
    try:
        return backup_format.summarize(rec.path)
    except backup_format.BackupError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/{backup_id}/verify")
async def verify_backup(backup_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """백업의 모든 파일을 manifest 의 SHA-256 과 견준다."""
    _require_admin(user)
    rec = await db.get(BackupRecord, backup_id)
    if not rec:
        raise HTTPException(status_code=404, detail="백업을 찾을 수 없습니다")
    problems = await asyncio.to_thread(backup_service.verify_record, rec)
    return {"ok": not problems, "problems": problems}


@router.get("/{backup_id}/download")
async def download_backup(backup_id: str, request: Request = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """백업을 tar 한 개(.jwbak)로 내려받는다 — `python -m app.cli restore` 와 설치 마법사가 그대로 읽는다."""
    _require_admin(user)
    rec = await db.get(BackupRecord, backup_id)
    if not rec or not rec.path or not Path(rec.path).is_dir():
        raise HTTPException(status_code=404, detail="백업 파일을 찾을 수 없습니다")
    try:
        # manifest.json 이 첫 멤버여야 요약을 풀지 않고 읽을 수 있다 — 순서를 정해서 넘긴다
        members = backup_format.pack_order(Path(rec.path))
    except backup_format.BackupError as e:
        raise HTTPException(status_code=409, detail=f"이 백업은 내려받을 수 없습니다: {e}")
    # DB 덤프 전체(비밀번호 해시·2단계 비밀)와 설정(.env — 암호화 키)이 나간다 — 누가 언제 받았는지 남긴다
    await audit.log_action(
        db, user.id, "backup.download", "backup", backup_id, {"name": Path(rec.path).name}, _ip(request),
    )
    proc = await asyncio.create_subprocess_exec(
        "tar", "-cf", "-", "-C", rec.path, "--", *members,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )

    async def _stream():
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                yield chunk
            await proc.wait()
        finally:
            if proc.returncode is None:
                proc.kill()

    name = f"{Path(rec.path).name}{backup_format.ARCHIVE_SUFFIX}"
    return StreamingResponse(_stream(), media_type="application/x-tar",
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
        "include_files": (await _get(db, backup_service.SETTING_INCLUDE_FILES, "true")) == "true",
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
    if body.include_files is not None:
        await _set(db, backup_service.SETTING_INCLUDE_FILES, "true" if body.include_files else "false")
    await db.commit()
    await audit.log_action(
        db, user.id, "backup.schedule.update", "backup", None,
        {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None},
    )
    return await get_schedule(db)
