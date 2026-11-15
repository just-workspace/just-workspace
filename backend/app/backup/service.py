"""백업 서비스 — backend 컨테이너의 docker CLI(+docker.sock)로 각 서비스 데이터를 덤프.

산출물: /backups/<timestamp>/  (named volume 'backups' 마운트)
  - postgres.dump   (pg_dump -Fc, ws-postgres 컨테이너의 pg_dump 사용 → 버전일치)
  - storage.tar.gz  (/storage 직접 tar)
  - redis.rdb       (BGSAVE 후 복사, 선택)
  - mail.tar.gz     (ws-mailserver 실행 시)
  - gitea.tar.gz    (ws-gitea 실행 시)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import select

from app.backup.models import BackupRecord
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

BACKUP_ROOT = Path(os.getenv("BACKUP_ROOT", "/backups"))

PG_CONTAINER = "ws-postgres"
REDIS_CONTAINER = "ws-redis"
MAIL_CONTAINER = "ws-mailserver"
GITEA_CONTAINER = "ws-gitea"


def _db_creds() -> tuple[str, str]:
    """database_url에서 (user, dbname) 추출."""
    try:
        u = urlparse(settings.database_url.replace("+asyncpg", ""))
        return (u.username or "workspace", (u.path or "/workspace").lstrip("/") or "workspace")
    except Exception:
        return ("workspace", "workspace")


async def _exec(cmd: list[str], outfile: Path | None = None, timeout: int = 1800) -> None:
    """subprocess 실행. outfile 지정 시 stdout을 그 파일로. 실패 시 예외."""
    stdout = open(outfile, "wb") if outfile else asyncio.subprocess.PIPE
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=stdout, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    finally:
        if outfile:
            stdout.close()
    if proc.returncode != 0:
        msg = (err or b"").decode("utf-8", "replace")[:300]
        raise RuntimeError(f"{cmd[0]} {cmd[1] if len(cmd) > 1 else ''} 실패(rc={proc.returncode}): {msg}")


async def _container_running(name: str) -> bool:
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "inspect", "-f", "{{.State.Running}}", name,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        return out.decode().strip() == "true"
    except Exception:
        return False


def _dir_size(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


async def _exec_lenient(cmd: list[str], stdin_file: Path | None = None, timeout: int = 1800) -> tuple[int, str]:
    """실패해도 예외 안 던짐(pg_restore는 경고로 nonzero 흔함). (rc, stderr-tail) 반환."""
    fin = open(stdin_file, "rb") if stdin_file else None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdin=fin or asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    finally:
        if fin:
            fin.close()
    return (proc.returncode or 0), (err or b"").decode("utf-8", "replace")[-400:]


async def restore_from_dir(target: Path) -> dict:
    """백업 디렉토리(postgres.dump + storage.tar.gz + mail/gitea)에서 복원. ⚠ 파괴적."""
    user, dbname = _db_creds()
    result: dict[str, str] = {}

    dump = target / "postgres.dump"
    if dump.is_file():
        # 다른 DB 연결 종료(복원 중 DROP 충돌 방지) — 자기 세션 제외
        await _exec_lenient(["docker", "exec", PG_CONTAINER, "psql", "-U", user, "-d", dbname, "-c",
            f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{dbname}' AND pid<>pg_backend_pid();"])
        rc, err = await _exec_lenient(
            ["docker", "exec", "-i", PG_CONTAINER, "pg_restore", "-U", user, "-d", dbname,
             "--clean", "--if-exists", "--no-owner", "--no-acl"],
            stdin_file=dump,
        )
        result["postgres"] = "ok" if rc == 0 else f"ok(warn rc={rc})"

    st = target / "storage.tar.gz"
    if st.is_file():
        try:
            await _exec(["tar", "xzf", str(st), "-C", "/storage"])
            result["storage"] = "ok"
        except Exception as e:
            result["storage"] = f"fail: {e}"

    mail = target / "mail.tar.gz"
    if mail.is_file() and await _container_running(MAIL_CONTAINER):
        rc, _ = await _exec_lenient(["docker", "exec", "-i", MAIL_CONTAINER, "tar", "xzf", "-", "-C", "/var/mail"], stdin_file=mail)
        result["mail"] = "ok" if rc == 0 else f"warn rc={rc}"

    gitea = target / "gitea.tar.gz"
    if gitea.is_file() and await _container_running(GITEA_CONTAINER):
        rc, _ = await _exec_lenient(["docker", "exec", "-i", GITEA_CONTAINER, "tar", "xzf", "-", "-C", "/data"], stdin_file=gitea)
        result["gitea"] = "ok" if rc == 0 else f"warn rc={rc}"

    return result


async def restore_from_archive(archive_path: Path) -> dict:
    """업로드된 백업 .tar.gz(다운로드 산출물)를 풀어 복원."""
    tmp = BACKUP_ROOT / f"_restore_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        await _exec(["tar", "xzf", str(archive_path), "-C", str(tmp)])
        # download 산출물은 루트에 파일이 있음; 혹시 단일 하위폴더면 그 안으로
        entries = [p for p in tmp.iterdir()]
        root = entries[0] if len(entries) == 1 and entries[0].is_dir() and not (tmp / "postgres.dump").exists() else tmp
        return await restore_from_dir(root)
    finally:
        try:
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass


async def schedule_backend_restart(delay: float = 3.0) -> None:
    """복원 후 백엔드 자체 재시작 — 메모리 캐시(모듈상태 등) 갱신."""
    async def _job():
        await asyncio.sleep(delay)
        try:
            proc = await asyncio.create_subprocess_exec("docker", "restart", "ws-backend",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await proc.communicate()
        except Exception:
            pass
    asyncio.create_task(_job())


async def run_backup(db, *, kind: str = "manual", user_id: str = "") -> BackupRecord:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    target = BACKUP_ROOT / ts
    rec = BackupRecord(status="running", kind=kind, path=str(target), created_by=user_id, components="{}")
    db.add(rec)
    await db.commit()

    components: dict[str, str] = {}
    try:
        target.mkdir(parents=True, exist_ok=True)
        user, dbname = _db_creds()

        # 1) PostgreSQL (필수)
        try:
            await _exec(["docker", "exec", PG_CONTAINER, "pg_dump", "-U", user, "-d", dbname, "-Fc"],
                        outfile=target / "postgres.dump")
            components["postgres"] = "ok"
        except Exception as e:
            components["postgres"] = f"fail: {e}"

        # 2) Storage (필수) — /storage 직접 tar
        try:
            await _exec(["tar", "czf", str(target / "storage.tar.gz"), "-C", "/storage", "."])
            components["storage"] = "ok"
        except Exception as e:
            components["storage"] = f"fail: {e}"

        # 3) Redis (선택)
        try:
            await _exec(["docker", "exec", REDIS_CONTAINER, "redis-cli", "SAVE"])
            await _exec(["docker", "cp", f"{REDIS_CONTAINER}:/data/dump.rdb", str(target / "redis.rdb")])
            components["redis"] = "ok"
        except Exception as e:
            components["redis"] = f"skip: {e}"

        # 4) Mail (선택, 실행 중일 때만)
        if await _container_running(MAIL_CONTAINER):
            try:
                await _exec(["docker", "exec", MAIL_CONTAINER, "tar", "czf", "-", "-C", "/var/mail", "."],
                            outfile=target / "mail.tar.gz")
                components["mail"] = "ok"
            except Exception as e:
                components["mail"] = f"fail: {e}"

        # 5) Gitea (선택, 실행 중일 때만)
        if await _container_running(GITEA_CONTAINER):
            try:
                await _exec(["docker", "exec", GITEA_CONTAINER, "tar", "czf", "-", "-C", "/data", "."],
                            outfile=target / "gitea.tar.gz")
                components["gitea"] = "ok"
            except Exception as e:
                components["gitea"] = f"fail: {e}"

        critical_ok = components.get("postgres") == "ok" and components.get("storage") == "ok"
        any_fail = any(v.startswith("fail") for v in components.values())
        rec.status = "success" if critical_ok and not any_fail else ("partial" if critical_ok else "failed")
        rec.components = json.dumps(components, ensure_ascii=False)
        rec.size_bytes = _dir_size(target)
        if not critical_ok:
            rec.error = "필수 구성(postgres/storage) 백업 실패"
        await db.commit()
        logger.info("[backup] %s status=%s size=%d", ts, rec.status, rec.size_bytes)
    except Exception as e:  # noqa: BLE001
        rec.status = "failed"
        rec.error = str(e)[:500]
        rec.components = json.dumps(components, ensure_ascii=False)
        await db.commit()
        logger.exception("[backup] 실패: %s", e)
    return rec


async def list_backups(db) -> list[BackupRecord]:
    rows = (await db.execute(select(BackupRecord).order_by(BackupRecord.created_at.desc()))).scalars().all()
    return list(rows)


async def delete_backup(db, backup_id: str) -> bool:
    rec = await db.get(BackupRecord, backup_id)
    if not rec:
        return False
    try:
        if rec.path and Path(rec.path).is_dir():
            shutil.rmtree(rec.path, ignore_errors=True)
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
