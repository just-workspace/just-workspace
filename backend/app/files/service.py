"""File system operations with path security enforcement."""

import logging
import mimetypes
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from app.config import get_settings
from app.db.models import User
from app.files.schemas import FileItem

settings = get_settings()
logger = logging.getLogger(__name__)

STORAGE_ROOT = Path(settings.storage_root)

# TTL cache: {real_path_str: (timestamp, dir_mtime_ns, [FileItem, ...])}
# 디렉터리 mtime 을 같이 둔다 — invalidate_cache 는 그 워커에서만 비워지고(uvicorn 워커 8개) 다른 워커는
# 30초 동안 옛 목록을 줘 새 폴더가 "있다/없다" 번갈아 보였다. 항목 추가·삭제·이름 바꾸기는 부모 mtime 을 바꾼다.
_dir_cache: dict[str, tuple[float, int, list[FileItem]]] = {}
_CACHE_TTL = 30  # seconds

# TTL cache for directory sizes: {path_str: (timestamp, size_bytes)}
_size_cache: dict[str, tuple[float, int]] = {}
_SIZE_CACHE_TTL = 60  # seconds


class PathSecurityError(Exception):
    pass


class AccessDeniedError(Exception):
    pass


def _resolve_virtual_path(virtual_path: str, user: User) -> Path:
    """Resolve a virtual path (my/... or shared/...) to a real filesystem path.

    Raises PathSecurityError if path traversal is detected.
    Raises AccessDeniedError if user lacks permission.
    """
    # Normalize and strip leading slashes
    vp = virtual_path.strip("/")
    if not vp:
        raise PathSecurityError("Empty path")

    parts = vp.split("/", 1)
    root_segment = parts[0]
    rest = parts[1] if len(parts) > 1 else ""

    if root_segment == "my":
        base = STORAGE_ROOT / "users" / user.id
    elif root_segment == "shared":
        base = STORAGE_ROOT / "shared"
    elif root_segment == "users" and user.is_admin:
        # Admin can browse all user directories
        base = STORAGE_ROOT / "users"
        if rest:
            real = (base / rest).resolve()
            if not real.is_relative_to(base.resolve()):
                raise PathSecurityError("Path traversal detected")
            return real
        return base.resolve()
    else:
        raise AccessDeniedError(f"Unknown root: {root_segment}")

    if rest:
        real = (base / rest).resolve()
    else:
        real = base.resolve()

    # Security: ensure resolved path is within the allowed base
    if not real.is_relative_to(base.resolve()):
        raise PathSecurityError("Path traversal detected")

    return real


def resolve_path(virtual_path: str, user: User) -> Path:
    """Public wrapper for path resolution."""
    return _resolve_virtual_path(virtual_path, user)


def compute_etag(st: os.stat_result) -> str:
    """파일 ETag — mtime(ns)+크기. 내용 해시가 아니라 stat 만으로 나오니 공짜다.

    같은 공식을 목록(`FileItem.etag`)과 다운로드 응답(`ETag` 헤더)이 함께 쓴다.
    업로드가 클라이언트 mtime 을 보존하므로(R-18) 같은 파일을 다시 올려도 값이 유지된다.
    """
    return f'"{st.st_mtime_ns:x}-{st.st_size:x}"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    """RFC 7232 If-None-Match 비교(약한 비교 — W/ 접두어는 무시). `*` 는 항상 일치."""
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True
    mine = etag[2:] if etag.startswith("W/") else etag
    for raw in if_none_match.split(","):
        tag = raw.strip()
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == mine:
            return True
    return False


def apply_mtime(target: Path, mtime_ms: int | None) -> None:
    """클라이언트가 준 수정 시각(epoch ms)을 보존한다. 없으면 그대로(=업로드 시각).

    안 하면 서버 mtime=업로드 시각이 되어 동기화 스냅샷이 방금 올린 파일을
    "서버에서 바뀜" 으로 본다. 같은 공식이 ETag 에도 들어가므로 재업로드에도 값이 유지된다.
    """
    if mtime_ms is None:
        return
    try:
        os.utime(target, ns=(time.time_ns(), int(mtime_ms) * 1_000_000))
    except (OSError, OverflowError, ValueError):
        pass


def ensure_user_dir(user: User) -> Path:
    """Ensure user's personal directory exists."""
    user_dir = STORAGE_ROOT / "users" / user.id
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def ensure_shared_dir() -> None:
    """Ensure shared directory exists."""
    shared_dir = STORAGE_ROOT / "shared"
    shared_dir.mkdir(parents=True, exist_ok=True)


# ─── 버전 관리 (my/ 파일 대상) ───
# 이전본 스냅샷을 STORAGE_ROOT/.versions/<owner_id>/<relpath>/<epoch_ms> 로 보관.

VERSIONS_ROOT = STORAGE_ROOT / ".versions"


def owner_relpath_from_my(virtual_path: str) -> str | None:
    """'my/docs/x.pdf' → 'docs/x.pdf'. my/ 아래가 아니면 None(버전 대상 아님)."""
    vp = virtual_path.strip("/")
    if vp == "my" or not vp.startswith("my/"):
        return None
    return vp[len("my/"):]


def _version_dir(owner_id: str, relpath: str) -> Path:
    d = (VERSIONS_ROOT / owner_id / relpath).resolve()
    base = (VERSIONS_ROOT / owner_id).resolve()
    if not d.is_relative_to(base):
        raise PathSecurityError("Path traversal detected")
    return d


def _rel_of(owner_vpath: str | None) -> str | None:
    return owner_relpath_from_my(owner_vpath) if owner_vpath else None


def move_versions(owner_id: str | None, old_owner_vpath: str | None, new_owner_vpath: str | None) -> None:
    """이름 바꾸기·이동 뒤 버전 스냅샷 폴더도 옮긴다(폴더면 하위 파일 버전 통째로).

    스냅샷이 경로에 묶여 있어 예전엔 옮기면 버전 기록이 사라졌다. 새 자리에 남은 옛 스냅샷
    (같은 이름으로 지웠던 파일 것)은 지우고 옮긴다. my/ 밖으로 나가면 버전 대상이 아니라 지운다."""
    if not owner_id:
        return
    old_rel, new_rel = _rel_of(old_owner_vpath), _rel_of(new_owner_vpath)
    if not old_rel:
        return
    try:
        src = _version_dir(owner_id, old_rel)
        if not src.exists():
            return
        if not new_rel:
            shutil.rmtree(src, ignore_errors=True)
            return
        dst = _version_dir(owner_id, new_rel)
        if dst == src:
            return
        if dst.exists():
            shutil.rmtree(dst, ignore_errors=True)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
    except (OSError, PathSecurityError):
        logger.warning("[files] 버전 스냅샷 이동 실패: %s → %s", old_owner_vpath, new_owner_vpath, exc_info=True)


def drop_versions(owner_id: str | None, owner_vpath: str | None) -> None:
    """영구 삭제 뒤 버전 스냅샷도 지운다(예전엔 .versions 에 고아로 남아 저장 공간을 먹었다)."""
    rel = _rel_of(owner_vpath)
    if not owner_id or not rel:
        return
    try:
        d = _version_dir(owner_id, rel)
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
    except (OSError, PathSecurityError):
        logger.warning("[files] 버전 스냅샷 삭제 실패: %s", owner_vpath, exc_info=True)


def snapshot_version(real_file: Path, owner_id: str, relpath: str) -> None:
    """덮어쓰기 직전 현재 파일을 버전 스냅샷으로 보관. 파일이 아니면 무시."""
    if not real_file.is_file():
        return
    vdir = _version_dir(owner_id, relpath)
    vdir.mkdir(parents=True, exist_ok=True)
    ts = str(int(time.time() * 1000))
    shutil.copy2(real_file, vdir / ts)


def list_versions(owner_id: str, relpath: str) -> list[dict]:
    """스냅샷 목록(최신순): version(epoch_ms), size, created_at."""
    try:
        vdir = _version_dir(owner_id, relpath)
    except PathSecurityError:
        return []
    if not vdir.is_dir():
        return []
    out = []
    for f in vdir.iterdir():
        if not f.is_file() or not f.name.isdigit():
            continue
        st = f.stat()
        out.append({
            "version": f.name,
            "size": st.st_size,
            "created_at": datetime.fromtimestamp(int(f.name) / 1000, tz=timezone.utc).isoformat(),
        })
    return sorted(out, key=lambda x: x["version"], reverse=True)


def restore_version(real_file: Path, owner_id: str, relpath: str, version: str) -> bool:
    """지정 버전으로 복원. 복원 전 현재본을 새 스냅샷으로 남김(비파괴). 성공 시 True."""
    if not version.isdigit():
        return False
    vdir = _version_dir(owner_id, relpath)
    snap = vdir / version
    if not snap.is_file():
        return False
    snapshot_version(real_file, owner_id, relpath)  # 현재본 보존
    real_file.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(snap, real_file)
    return True


def version_count(owner_id: str, relpath: str) -> int:
    try:
        vdir = _version_dir(owner_id, relpath)
    except PathSecurityError:
        return 0
    if not vdir.is_dir():
        return 0
    return sum(1 for f in vdir.iterdir() if f.is_file() and f.name.isdigit())


# 목록에서 감출 항목.
#   "."  — 앱 내부용(.trash, .versions) + 유닉스 숨김 관례
#   NAS 시스템 이름 — QNAP·Synology 가 공유 폴더 안에 만드는 것. NFS 로 그대로 보인다.
#          "@ 로 시작하면 전부 숨김"으로 막으면 "@회의록" 같은 사용자 이름까지 못 쓰므로
#          알려진 이름 목록으로만 가린다.
#          (".@__thumb" 처럼 점으로 시작하는 것은 "." 규칙이 이미 가린다.)
#          비교는 대소문자 무시 — NAS 펌웨어·프로토콜에 따라 "@recycle" 로도 보인다.
#          새 시스템 이름이 목록에 보이면 여기 한 곳에만 더한다(목록·검색·색인·공유 링크·zip 이 모두 이 함수를 쓴다).
_HIDDEN_PREFIXES = (".",)
NAS_SYSTEM_NAMES = frozenset(n.lower() for n in (
    # QNAP
    "@Recycle", "@Recently-Snapshot", "@Snapshot", "@__thumb", "@Transcode", "@upload_cache",
    # Synology
    "@eaDir", "@tmp", "@SynoResource", "@SynoEAStream", "@sharebin", "#recycle", "#snapshot",
))


def is_system_name(name: str) -> bool:
    """NAS 가 만든 시스템 폴더·파일 이름인가(사용자가 만들 수도, 볼 수도 없다)."""
    return name.lower() in NAS_SYSTEM_NAMES


def is_hidden_name(name: str) -> bool:
    """목록·검색·색인·공유 링크·zip 에서 감출 이름 — 숨김 판정은 여기 한 곳."""
    return name.startswith(_HIDDEN_PREFIXES) or is_system_name(name)


_is_hidden = is_hidden_name   # 예전 이름(같은 모듈·router 가 쓴다)


class InvalidNameError(ValueError):
    """파일·폴더 이름으로 쓸 수 없는 값. 메시지는 사용자에게 그대로 보인다(한국어)."""


def validate_name(raw: str | None) -> str:
    """새 파일·폴더 이름 검증 — 새 폴더·이름 바꾸기·업로드가 함께 쓴다. 다듬은 이름을 돌려준다.

    규칙을 한곳에 둔 이유: 예전엔 업로드만 검사해 ".메모" 로 이름을 바꾸면 성공했는데도
    목록(is_hidden_name)에서 사라졌고, 반대로 업로드는 "v1..2.txt" 같은 정상 이름까지 막았다.
    `..` 는 이름 전체가 그것일 때만 위험하다(경로 구분자는 따로 막는다).
    "@회의록" 처럼 @ 로 시작하는 이름은 쓸 수 있다 — 막는 것은 NAS 시스템 이름(@Recycle 등)뿐이다.
    """
    name = (raw or "").strip()
    if not name:
        raise InvalidNameError("이름을 입력하세요")
    if name in (".", ".."):
        raise InvalidNameError("쓸 수 없는 이름입니다")
    if "/" in name or "\\" in name:
        raise InvalidNameError("이름에 / 또는 \\ 는 쓸 수 없습니다")
    if any(ord(ch) < 32 or ch == "\x7f" for ch in name):
        raise InvalidNameError("이름에 쓸 수 없는 문자가 있습니다")
    if is_system_name(name):
        raise InvalidNameError(f"'{name}' 은(는) 저장 장치가 쓰는 이름이라 쓸 수 없습니다(목록에 보이지 않습니다)")
    if is_hidden_name(name):
        raise InvalidNameError("이름은 . 으로 시작할 수 없습니다(숨김 항목이 되어 목록에 보이지 않습니다)")
    # 파일시스템 한도는 바이트 기준(한글 한 글자 = 3바이트)
    if len(name.encode("utf-8", "surrogatepass")) > 255:
        raise InvalidNameError("이름이 너무 깁니다")
    return name


def _scan_directory(real_path: Path, virtual_prefix: str) -> list[FileItem]:
    """Perform actual NFS I/O to list directory contents."""
    items: list[FileItem] = []
    try:
        for entry in sorted(real_path.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            if _is_hidden(entry.name):
                continue
            stat = entry.stat()
            mime = None
            is_file = entry.is_file()
            if is_file:
                mime, _ = mimetypes.guess_type(entry.name)

            vpath = f"{virtual_prefix}/{entry.name}".strip("/")
            items.append(
                FileItem(
                    name=entry.name,
                    path=vpath,
                    is_dir=entry.is_dir(),
                    size=stat.st_size if is_file else 0,
                    modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
                    mime_type=mime,
                    etag=compute_etag(stat) if is_file else None,
                )
            )
    except PermissionError:
        # 권한 문제로 목록을 못 읽으면 조용히 빈 목록을 주지 말고 남긴다.
        # NAS 로 옮긴 뒤 일부 폴더의 POSIX ACL 에 `user:<appuser>:---` 가 박히면
        # 파일탭이 "이 폴더는 비어 있습니다"만 띄운다 — 조용히 삼키면 원인을 찾기 어렵다.
        logger.warning("[files] 권한 거부로 목록을 읽지 못함: %s", real_path)
    return items


def list_directory(real_path: Path, virtual_prefix: str) -> list[FileItem]:
    """List contents of a directory (with TTL cache)."""
    if not real_path.is_dir():
        return []

    cache_key = str(real_path.resolve())
    now = time.monotonic()
    try:
        mtime = real_path.stat().st_mtime_ns
    except OSError:
        mtime = -1

    cached = _dir_cache.get(cache_key)
    if cached is not None:
        ts, cached_mtime, items = cached
        if now - ts < _CACHE_TTL and cached_mtime == mtime:
            return items

    items = _scan_directory(real_path, virtual_prefix)
    _dir_cache[cache_key] = (now, mtime, items)
    return items


def search_directory(
    real_base: Path,
    virtual_base: str,
    query: str,
    max_results: int = 500,
) -> list[FileItem]:
    """Recursively search files AND folders under real_base whose name contains query.

    Case-insensitive substring match on the entry name. Returns the same FileItem
    shape as list_directory, with each item's full virtual path (virtual_base +
    relative path) so the frontend can derive the containing folder. Hidden entries
    (e.g. .trash) are skipped. Capped at max_results.
    """
    q = query.strip().lower()
    if not q or not real_base.is_dir():
        return []

    results: list[FileItem] = []
    for dirpath, dirnames, filenames in os.walk(real_base):
        # Skip hidden directories (.trash, etc.) — prune in-place
        dirnames[:] = [d for d in dirnames if not _is_hidden(d)]
        rel_dir = Path(dirpath).relative_to(real_base)
        rel_prefix = "" if str(rel_dir) == "." else rel_dir.as_posix()

        for name, is_dir in [(d, True) for d in dirnames] + [(f, False) for f in filenames]:
            if _is_hidden(name):
                continue
            if q not in name.lower():
                continue
            entry = Path(dirpath) / name
            try:
                stat = entry.stat()
            except OSError:
                continue
            mime = None
            if not is_dir:
                mime, _ = mimetypes.guess_type(name)
            rel = f"{rel_prefix}/{name}" if rel_prefix else name
            vpath = f"{virtual_base}/{rel}".strip("/")
            results.append(
                FileItem(
                    name=name,
                    path=vpath,
                    is_dir=is_dir,
                    size=stat.st_size if not is_dir else 0,
                    modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
                    mime_type=mime,
                    etag=None if is_dir else compute_etag(stat),
                )
            )
            if len(results) >= max_results:
                return results
    return results


def invalidate_cache(real_path: Path) -> None:
    """Remove a directory from the listing cache and size cache."""
    key = str(real_path.resolve())
    _dir_cache.pop(key, None)
    # Also invalidate size caches (parent dirs may be affected)
    _size_cache.clear()


def get_dir_size(path: Path) -> int:
    """Get total size of all files in a directory tree (with TTL cache)."""
    if not path.exists():
        return 0

    cache_key = str(path.resolve())
    now = time.monotonic()
    cached = _size_cache.get(cache_key)
    if cached is not None:
        ts, size = cached
        if now - ts < _SIZE_CACHE_TTL:
            return size

    total = 0
    for f in path.rglob("*"):
        if f.is_file():
            total += f.stat().st_size

    _size_cache[cache_key] = (now, total)
    return total


def delete_path(real_path: Path) -> None:
    """Delete a file or directory."""
    if real_path.is_dir():
        shutil.rmtree(real_path)
    elif real_path.is_file():
        real_path.unlink()


def rename_path(real_path: Path, new_name: str) -> Path:
    """Rename a file or directory. Returns new path."""
    try:
        new_name = validate_name(new_name)
    except InvalidNameError as e:
        raise PathSecurityError(str(e))
    new_path = real_path.parent / new_name
    if new_path.exists():
        raise FileExistsError(f"'{new_name}' already exists")
    real_path.rename(new_path)
    return new_path


def move_path(src: Path, dst_dir: Path, copy: bool = False) -> Path:
    """Move or copy a file/directory into dst_dir."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    target = dst_dir / src.name
    if target.exists():
        raise FileExistsError(f"'{src.name}' already exists in destination")

    if copy:
        if src.is_dir():
            shutil.copytree(src, target)
        else:
            shutil.copy2(src, target)
    else:
        shutil.move(str(src), str(target))

    return target
