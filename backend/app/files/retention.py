"""버전·휴지통·업로드 세션 만료 — 디스크가 무한히 자라지 않게 하는 정리 루프.

지금까지 `.versions/`(덮어쓰기 스냅샷)와 `users/<id>/.trash/` 는 쌓이기만 했다.
여기서는 세 가지를 주기적으로 정리한다.

1. 버전 간격표(수치는 Nextcloud 공개 문서값, 구현은 우리 것):
     나이 ≤ 1시간  : 2초 간격으로 하나
     나이 ≤ 1일    : 1분 간격
     나이 ≤ 1주    : 1시간 간격
     나이 ≤ 1달    : 1일 간격
     그 이후        : 1주 간격
   같은 간격 안에 여러 스냅샷이 있으면 가장 오래된 것 하나만 남긴다(최신본은 항상 남김).
   선택으로 `files.versions_max_age_days`(기본 0=무제한) 를 넘긴 스냅샷은 전부 지운다.
2. 휴지통: `files.trash_retention_days`(기본 30, 0=자동삭제 안 함) 지난 항목 삭제.
3. 청크 업로드 세션: 마지막 활동 후 24시간 지난 세션 디렉터리 삭제(`upload_sessions.py`).

안전장치 — 운영 저장소를 실제로 지우는 코드다:
- 지우는 경로는 반드시 `.versions/` 또는 `.trash/` 아래여야 한다(어휘적 검사 + resolve 검사).
- 심볼릭 링크는 따라가지 않는다. 링크 자체가 보존 대상이면 링크만 지운다.
- 삭제 대상 판정(`plan_*`)과 실제 삭제를 분리해 단위 테스트가 판정만 검증할 수 있게 했다.
- 한 워커만 돈다(`app.jobs.lock`).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# ── 설정 키·기본값 (SystemSetting) ──
KEY_TRASH_DAYS = "files.trash_retention_days"
KEY_VERSIONS_MAX_AGE_DAYS = "files.versions_max_age_days"
DEFAULT_TRASH_DAYS = 30
DEFAULT_VERSIONS_MAX_AGE_DAYS = 0          # 0 = 간격표만 적용, 상한 없음

RUN_INTERVAL = 3600                        # 초. 간격표 최소 단위가 2초라 더 자주 돌 이유는 없다
LOCK_NAME = "files:retention"

# (나이 상한 ms, 그 구간에서 유지할 최소 간격 ms). 마지막 행은 "그 이후".
_HOUR = 3600 * 1000
_DAY = 24 * _HOUR
VERSION_INTERVALS: tuple[tuple[int | None, int], ...] = (
    (1 * _HOUR, 2 * 1000),
    (1 * _DAY, 60 * 1000),
    (7 * _DAY, 1 * _HOUR),
    (30 * _DAY, 1 * _DAY),
    (None, 7 * _DAY),
)


def interval_for_age(age_ms: int) -> int:
    """나이(ms)에 해당하는 보존 간격(ms)."""
    for upper, step in VERSION_INTERVALS:
        if upper is None or age_ms <= upper:
            return step
    return VERSION_INTERVALS[-1][1]          # pragma: no cover — 위에서 항상 반환


@dataclass
class Stats:
    scanned: int = 0
    removed: int = 0
    bytes_freed: int = 0
    errors: int = 0
    removed_paths: list[str] = field(default_factory=list)   # 테스트·로그용(상한 있음)

    def note_removed(self, p: Path, size: int) -> None:
        self.removed += 1
        self.bytes_freed += max(0, size)
        if len(self.removed_paths) < 200:
            self.removed_paths.append(str(p))


# ─── 판정 (순수 함수) ───


def plan_version_expiry(
    timestamps_ms: list[int],
    now_ms: int,
    max_age_days: int = 0,
) -> set[int]:
    """스냅샷 타임스탬프(epoch ms) 중 지울 것을 고른다.

    간격표에서는 최신 스냅샷을 항상 남긴다. 그 다음부터 오래된 쪽으로 가며, 직전에
    남긴 스냅샷과의 간격이 그 나이 구간의 간격보다 짧으면 지운다. 미래 타임스탬프
    (시계 어긋남)는 나이 0 으로 본다. `max_age_days`>0 이면 그보다 오래된 스냅샷은
    최신 것이라도 지운다(원본이 사라진 파일의 버전 디렉터리가 영구히 남는 것 방지).
    """
    if not timestamps_ms:
        return set()
    ordered = sorted(set(timestamps_ms), reverse=True)
    drop: set[int] = set()
    max_age_ms = max_age_days * _DAY if max_age_days > 0 else None

    def _too_old(ts: int) -> bool:
        return max_age_ms is not None and max(0, now_ms - ts) > max_age_ms

    kept = ordered[0]
    if _too_old(kept):
        drop.add(kept)
    for ts in ordered[1:]:
        age = max(0, now_ms - ts)
        if _too_old(ts):
            drop.add(ts)
            continue
        if kept - ts < interval_for_age(age):
            drop.add(ts)
        else:
            kept = ts
    return drop


def plan_trash_expiry(
    entries: list[tuple[str, datetime | None]],
    now: datetime,
    retention_days: int,
) -> set[str]:
    """휴지통 항목 (이름, trashed_at) 중 보존기간을 넘긴 이름. retention_days<=0 이면 없음.

    trashed_at 을 모르는 항목(메타 유실)은 호출자가 이름 접두어나 mtime 으로 채워 넘긴다.
    그래도 None 이면 지우지 않는다 — 모르는 건 건드리지 않는다.
    """
    if retention_days <= 0:
        return set()
    cutoff = now.timestamp() - retention_days * 86400
    out: set[str] = set()
    for name, trashed_at in entries:
        if trashed_at is None:
            continue
        if trashed_at.tzinfo is None:
            trashed_at = trashed_at.replace(tzinfo=timezone.utc)
        if trashed_at.timestamp() < cutoff:
            out.add(name)
    return out


def trashed_at_from_name(trash_name: str) -> datetime | None:
    """`20260301120000_파일명` 접두어에서 삭제 시각 복원(메타 유실 폴백)."""
    head = trash_name.split("_", 1)[0]
    if len(head) != 14 or not head.isdigit():
        return None
    try:
        return datetime.strptime(head, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ─── 안전한 삭제 ───


def _is_under(child: Path, parent: Path) -> bool:
    """어휘적으로도, resolve 해서도 parent 아래인지. 링크로 밖을 가리키는 항목은 False."""
    try:
        if not child.is_relative_to(parent):
            return False
        # child 자체가 링크면 resolve 가 밖으로 나갈 수 있다 — 링크는 "그 자리"만 본다
        probe = child.parent.resolve(strict=True) / child.name
        return probe.is_relative_to(parent.resolve(strict=True))
    except (OSError, ValueError):
        return False


def remove_within(p: Path, root: Path, stats: Stats) -> None:
    """root 아래의 파일/디렉터리/링크 하나를 지운다. 링크는 따라가지 않는다."""
    if not _is_under(p, root):
        stats.errors += 1
        logger.error("[retention] 범위 밖 경로 삭제 거부: %s (root=%s)", p, root)
        return
    try:
        if p.is_symlink():
            size = 0
            p.unlink()
        elif p.is_dir():
            size = _tree_size(p)
            # rmtree 는 디렉터리 안의 링크를 따라가지 않는다(링크 자체만 지운다).
            shutil.rmtree(p)
        elif p.is_file():
            size = p.stat().st_size
            p.unlink()
        else:
            return
        stats.note_removed(p, size)
    except OSError as e:
        stats.errors += 1
        logger.warning("[retention] 삭제 실패 %s: %s", p, e)


def _tree_size(d: Path) -> int:
    total = 0
    for dirpath, _dirs, files in os.walk(d, followlinks=False):
        for f in files:
            fp = Path(dirpath) / f
            try:
                if not fp.is_symlink():
                    total += fp.stat().st_size
            except OSError:
                pass
    return total


def _prune_empty_dirs(start: Path, stop: Path) -> None:
    """start 부터 stop(미포함) 까지 올라가며 빈 디렉터리를 지운다."""
    cur = start
    while cur != stop and cur.is_relative_to(stop):
        try:
            if cur.is_symlink() or any(cur.iterdir()):
                return
            cur.rmdir()
        except OSError:
            return
        cur = cur.parent


# ─── 실제 정리 ───


def expire_versions(versions_root: Path, now_ms: int | None = None,
                    max_age_days: int = DEFAULT_VERSIONS_MAX_AGE_DAYS,
                    dry_run: bool = False) -> Stats:
    """`.versions/<owner>/<relpath>/<epoch_ms>` 트리에 간격표를 적용한다."""
    stats = Stats()
    if versions_root.name != ".versions" or not versions_root.is_dir() or versions_root.is_symlink():
        return stats
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)

    for dirpath, dirnames, filenames in os.walk(versions_root, followlinks=False):
        d = Path(dirpath)
        # 링크된 하위 디렉터리는 내려가지 않는다
        dirnames[:] = [n for n in dirnames if not (d / n).is_symlink()]
        snaps = [f for f in filenames if f.isdigit() and not (d / f).is_symlink()]
        if not snaps:
            continue
        stats.scanned += len(snaps)
        ts_list = [int(f) for f in snaps]
        drop = plan_version_expiry(ts_list, now_ms, max_age_days)
        for ts in drop:
            target = d / str(ts)
            if dry_run:
                stats.note_removed(target, 0)
            else:
                remove_within(target, versions_root, stats)
        if drop and not dry_run and len(drop) == len(snaps) and d != versions_root:
            # 스냅샷이 다 지워진 relpath 디렉터리는 걷어낸다. 소유자 디렉터리
            # (.versions/<owner>)까지는 지우지 않는다.
            owner_dir = versions_root / d.relative_to(versions_root).parts[0]
            _prune_empty_dirs(d, owner_dir)
    return stats


def expire_trash_for_user(user_dir: Path, retention_days: int,
                          now: datetime | None = None, dry_run: bool = False) -> Stats:
    """`users/<id>/.trash/` 한 곳을 정리하고 `.trash_meta.json` 에서도 지운 항목을 뺀다."""
    stats = Stats()
    if retention_days <= 0:
        return stats
    trash = user_dir / ".trash"
    if not trash.is_dir() or trash.is_symlink():
        return stats
    now = now or datetime.now(timezone.utc)

    meta_path = user_dir / ".trash_meta.json"
    meta: dict = {}
    try:
        if meta_path.is_file():
            meta = json.loads(meta_path.read_text(encoding="utf-8")) or {}
    except Exception:
        meta = {}

    entries: list[tuple[str, datetime | None]] = []
    for entry in trash.iterdir():
        stats.scanned += 1
        when: datetime | None = None
        raw = (meta.get(entry.name) or {}).get("trashed_at")
        if raw:
            try:
                when = datetime.fromisoformat(raw)
            except ValueError:
                when = None
        if when is None:
            # 메타가 없으면 이름 접두어(삭제 시각)로. 그것도 없으면 None 으로 남겨
            # plan 이 건너뛴다 — 항목 mtime 은 원본 수정 시각이라 근거가 못 된다.
            when = trashed_at_from_name(entry.name)
        entries.append((entry.name, when))

    drop = plan_trash_expiry(entries, now, retention_days)
    for name in drop:
        target = trash / name
        if dry_run:
            stats.note_removed(target, 0)
            continue
        remove_within(target, trash, stats)
        meta.pop(name, None)
    if drop and not dry_run:
        try:
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        except OSError as e:
            logger.warning("[retention] trash meta 갱신 실패 %s: %s", meta_path, e)
    return stats


def expire_all_trash(users_root: Path, retention_days: int,
                     now: datetime | None = None, dry_run: bool = False) -> Stats:
    total = Stats()
    if not users_root.is_dir():
        return total
    for user_dir in users_root.iterdir():
        if not user_dir.is_dir() or user_dir.is_symlink():
            continue
        s = expire_trash_for_user(user_dir, retention_days, now, dry_run)
        total.scanned += s.scanned
        total.removed += s.removed
        total.bytes_freed += s.bytes_freed
        total.errors += s.errors
        total.removed_paths.extend(s.removed_paths[: max(0, 200 - len(total.removed_paths))])
    return total


# ─── 루프 ───


async def trash_retention_days(db) -> int:
    """휴지통 보존 일수(관리자 설정, 없거나 잘못되면 기본값). 0 = 자동 삭제 안 함."""
    from app.admin.settings import get_setting
    v = await get_setting(db, KEY_TRASH_DAYS)
    try:
        return int(v) if v not in (None, "") else DEFAULT_TRASH_DAYS
    except ValueError:
        return DEFAULT_TRASH_DAYS


async def _load_policy() -> tuple[int, int]:
    from app.admin.settings import get_setting
    from app.db.session import async_session

    def _int(v: str | None, default: int) -> int:
        try:
            return int(v) if v is not None and v != "" else default
        except ValueError:
            return default

    async with async_session() as db:
        trash_days = _int(await get_setting(db, KEY_TRASH_DAYS), DEFAULT_TRASH_DAYS)
        ver_days = _int(await get_setting(db, KEY_VERSIONS_MAX_AGE_DAYS), DEFAULT_VERSIONS_MAX_AGE_DAYS)
    return trash_days, ver_days


async def run_once() -> None:
    from app.config import get_settings
    from app.files import upload_sessions

    root = Path(get_settings().storage_root)
    trash_days, ver_days = await _load_policy()

    v = await asyncio.to_thread(expire_versions, root / ".versions", None, ver_days)
    t = await asyncio.to_thread(expire_all_trash, root / "users", trash_days)
    u = await asyncio.to_thread(upload_sessions.expire_sessions, upload_sessions.sessions_root(root))
    if v.removed or t.removed or u.removed or v.errors or t.errors or u.errors:
        logger.info(
            "[retention] versions -%d(%dB, err %d) trash -%d(%dB, err %d) uploads -%d(err %d)",
            v.removed, v.bytes_freed, v.errors, t.removed, t.bytes_freed, t.errors, u.removed, u.errors,
        )


async def run_retention(interval_seconds: int = RUN_INTERVAL) -> None:
    """주기 정리. 워커 8개 중 락을 잡은 하나만 돈다. 한 주기가 터져도 루프를 놓지 않는다."""
    from app.jobs.lock import run_exclusive

    await asyncio.sleep(120)          # 기동 직후 색인기·헬스체크와 겹치지 않게
    while True:
        try:
            await run_exclusive(LOCK_NAME, max(60, interval_seconds - 100), run_once)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[retention] 정리 실패 — 다음 주기에 다시 시도한다")
        await asyncio.sleep(interval_seconds)
