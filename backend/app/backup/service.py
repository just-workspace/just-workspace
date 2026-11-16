"""관리 화면의 백업 — 기록(BackupRecord)을 저장하며 app/backup/runner.py 를 실행한다.

백업 형식은 단일하다(app/backup/format.py): `BACKUP_ROOT/<시각>-full/` 하위의 manifest.json 과 항목별 파일.
CLI(`python -m app.cli backup create`)·scripts/backup.sh·설치 관리자의 업데이트 전 백업이 동일 형식을 생성한다.

복원은 본 모듈에 없다. backend 가 자신을 중지하고 DB 를 교체할 수는 없으므로, 복원은 backend 외부에서
(`scripts/restore.sh` → `python -m app.cli restore`, 또는 설치 관리자) 수행한다 — docs/data-safety.md.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.backup import format as fmt
from app.backup import runner
from app.backup.models import BackupRecord
from app.db.models import SystemSetting

logger = logging.getLogger(__name__)

BACKUP_ROOT = Path(os.getenv("BACKUP_ROOT", "/backups"))

# 파일 저장소의 백업 포함 여부(관리 설정). 로컬 저장소인 경우에만 유효 — NFS 이면 포함하지 않음
SETTING_INCLUDE_FILES = "backup.include_files"


async def include_files_setting(db) -> bool:
    row = (await db.execute(select(SystemSetting).where(SystemSetting.key == SETTING_INCLUDE_FILES))).scalar_one_or_none()
    return (row.value if row and row.value is not None else "true") == "true"


def _components(result: runner.BackupResult) -> dict[str, str]:
    """기록에 저장할 항목별 결과 — ok / skip: 이유 / fail."""
    comps = {item: "ok" for item in result.manifest.get("items", {})}
    for item, reason in (result.manifest.get("skipped") or {}).items():
        comps[item] = "fail" if reason == "failed" else f"skip: {reason}"
    return comps


async def run_backup(db, *, kind: str = "manual", user_id: str = "") -> BackupRecord:
    """전체 백업 하나를 생성하고 기록을 저장한다. 실패 시 기록에 status="failed" 와 error(사유)를 저장한다."""
    rec = BackupRecord(status="running", kind=kind, path="", created_by=user_id, components="{}")
    db.add(rec)
    await db.commit()
    try:
        include_files = await include_files_setting(db)
        result = await asyncio.to_thread(
            runner.create_backup, BACKUP_ROOT, kind=fmt.KIND_FULL, include_files=include_files, log=logger.info,
        )
        rec.path = str(result.path)
        rec.status = result.status
        rec.components = json.dumps(_components(result), ensure_ascii=False)
        rec.size_bytes = result.size_bytes
        rec.error = "; ".join(result.failures)[:2000]
        await db.commit()
        logger.info("[backup] %s status=%s size=%d", result.path.name, rec.status, rec.size_bytes)
    except Exception as e:  # noqa: BLE001 — 사전 검사 거부·DB 덤프 실패 등: 기록에 그대로 저장
        rec.status = "failed"
        rec.error = str(e)[:2000]
        await db.commit()
        if isinstance(e, fmt.BackupError):
            logger.error("[backup] 실패: %s", e)
        else:
            logger.exception("[backup] 실패: %s", e)
    return rec


def verify_record(rec: BackupRecord) -> list[str]:
    """기록이 가리키는 백업의 파일을 manifest 의 해시와 대조한다. 반환값: 문제 목록."""
    if not rec.path or not Path(rec.path).is_dir():
        return ["백업 파일을 찾을 수 없습니다"]
    try:
        return fmt.verify(fmt.open_backup(rec.path))
    except fmt.BackupError as e:
        return [str(e)]


async def list_backups(db) -> list[BackupRecord]:
    rows = (await db.execute(select(BackupRecord).order_by(BackupRecord.created_at.desc()))).scalars().all()
    return list(rows)


async def delete_backup(db, backup_id: str) -> bool:
    rec = await db.get(BackupRecord, backup_id)
    if not rec:
        return False
    try:
        # 기록의 경로가 백업 위치 직하위인 경우에만 삭제(기록이 잘못된 경로를 가리켜도 다른 대상을 삭제하지 않도록 함)
        target = Path(rec.path) if rec.path else None
        if target and target.is_dir() and target.parent.resolve() == BACKUP_ROOT.resolve():
            shutil.rmtree(target, ignore_errors=True)
    except Exception:
        pass
    await db.delete(rec)
    await db.commit()
    return True


async def apply_retention(db, days: int) -> int:
    """days보다 오래된 백업 삭제. 삭제 개수 반환."""
    from datetime import timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (await db.execute(select(BackupRecord).where(BackupRecord.created_at < cutoff))).scalars().all()
    n = 0
    for rec in rows:
        if await delete_backup(db, rec.id):
            n += 1
    return n
