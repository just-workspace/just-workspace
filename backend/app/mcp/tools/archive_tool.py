"""zip 조회·해제 — files_archive_list(읽기) · files_unzip(쓰기 low, 승인 카드).

해제 방어:
  * zip slip — 절대 경로·드라이브·`..`·심볼릭 링크 항목은 건너뛴다(목록에 사유 포함).
  * zip bomb — 항목 수·총 해제 크기 상한(설정 ai.unzip.max_entries / ai.zip.max_bytes), 대형 항목의 압축률 상한,
    헤더 값이 허위여도 실제로 기록한 바이트로 재측정한다.
  * 덮어쓰지 않는다 — 기본은 zip 이름의 새 폴더에 해제하고(되돌리기 = 해당 폴더 삭제), 이름 충돌 시 " (2)".
  * 사용자 할당·업로드 대상 판정은 업로드와 동일하다.
한글 이름: UTF-8 표시가 없는 zip(Windows 탐색기)은 cp949 로 재해석한다.
"""

from __future__ import annotations

import asyncio
import os
import re
import stat
import zipfile
from pathlib import Path, PurePosixPath

from app.db.models import User
from app.db.session import async_session
from app.mcp.server import Tool, register
from app.mcp.tools._common import path_shared, shared_target  # noqa: F401 — 타인 노출 쓰기 판정
from app.mcp.tools._common import clamp, err, http_err, human_size

UNZIP_MAX_ENTRIES_KEY = "ai.unzip.max_entries"
UNZIP_MAX_ENTRIES = 10_000
BOMB_RATIO = 200                     # 1MB 초과 항목의 압축률이 이 값을 넘으면 거부
_BAD_SEG = re.compile(r'[\\:*?"<>|\x00-\x1f]')
_SKIP_TOP = ("__MACOSX",)


def entry_name(info: zipfile.ZipInfo) -> str:
    """UTF-8 표시가 없으면 zipfile 이 cp437 로 해석한 것 — 한국어 Windows zip 은 cp949 이다."""
    name = info.filename
    if not (info.flag_bits & 0x800):
        try:
            name = name.encode("cp437").decode("cp949")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return name


def safe_parts(name: str) -> list[str] | None:
    """zip 항목 이름 → 안전한 경로 조각. 위험하면 None(zip slip)."""
    n = name.replace("\\", "/")
    if n.startswith("/") or re.match(r"^[A-Za-z]:", n):
        return None
    parts = [p for p in PurePosixPath(n).parts if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return None
    out = []
    for p in parts:
        p = _BAD_SEG.sub("_", p).strip().rstrip(".")
        if not p:
            return None
        out.append(p[:255])
    return out


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF)


async def _limits(db) -> tuple[int, int]:
    from app.admin.settings import get_setting
    from app.ai import artifacts as arts

    _files, max_bytes = await arts.zip_limits(db)
    try:
        v = await get_setting(db, UNZIP_MAX_ENTRIES_KEY)
        n = max(1, int(v)) if v not in (None, "") else UNZIP_MAX_ENTRIES
    except Exception:  # noqa: BLE001
        n = UNZIP_MAX_ENTRIES
    return n, max_bytes


async def _open_zip(db, user: User, path: str) -> Path:
    from app.files import access as acc

    a = await acc.resolve(db, user, (path or "").strip("/"), "view")
    if not a.real.is_file():
        raise FileNotFoundError(path)
    return a.real


# ── 목록 ──────────────────────────────────────────────────────
async def files_archive_list(user: User, path: str, limit: int = 200, cursor: str = "", **_: object) -> dict:
    if not (path or "").lower().endswith(".zip"):
        return err("unsupported", "zip 파일만 볼 수 있습니다")
    off = clamp(cursor or 0, 0, 10 ** 9, 0)
    n = clamp(limit, 1, 1000, 200)
    try:
        async with async_session() as db:
            real = await _open_zip(db, user, path)
    except FileNotFoundError:
        return err("not_found", "파일이 없습니다")
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise

    def _read():
        with zipfile.ZipFile(real) as zf:
            return zf.infolist()
    try:
        infos = await asyncio.to_thread(_read)
    except zipfile.BadZipFile:
        return err("invalid_argument", "zip 파일이 손상됐거나 zip 이 아닙니다")
    files = [i for i in infos if not i.is_dir()]
    entries = []
    for i in infos[off:off + n]:
        name = entry_name(i)
        entries.append({"name": name, "dir": i.is_dir(), "size": i.file_size, "compressed": i.compress_size,
                        "encrypted": bool(i.flag_bits & 0x1),
                        **({"unsafe": True} if safe_parts(name) is None or _is_symlink(i) else {})})
    total = len(infos)
    nxt = off + len(entries)
    return {"total": total, "returned": len(entries), "has_more": nxt < total,
            "next_cursor": str(nxt) if nxt < total else None,
            "path": path, "files": len(files), "uncompressed_size": sum(i.file_size for i in files),
            "uncompressed_human": human_size(sum(i.file_size for i in files)),
            "encrypted": any(i.flag_bits & 0x1 for i in files), "entries": entries}


# ── 풀기 ──────────────────────────────────────────────────────
def _unique_name(dirpath: Path, name: str) -> str:
    if not (dirpath / name).exists():
        return name
    stem, ext = os.path.splitext(name)
    k = 2
    while (dirpath / f"{stem} ({k}){ext}").exists():
        k += 1
    return f"{stem} ({k}){ext}"


def _plan(real: Path, max_entries: int, max_bytes: int) -> tuple[list[tuple[zipfile.ZipInfo, list[str]]], list[dict], int]:
    """(해제할 항목[(info, 조각)], 건너뛴 항목[{name, reason}], 선언된 총 크기). 상한·암호는 ValueError."""
    with zipfile.ZipFile(real) as zf:
        infos = zf.infolist()
    if len(infos) > max_entries:
        raise ValueError(f"항목이 너무 많습니다({len(infos):,}개, 상한 {max_entries:,}개)")
    plan, skipped, total = [], [], 0
    for i in infos:
        name = entry_name(i)
        if i.flag_bits & 0x1:
            raise PermissionError("암호가 걸린 zip 은 풀 수 없습니다")
        parts = safe_parts(name)
        if parts is None or _is_symlink(i):
            skipped.append({"name": name, "reason": "위험한 경로(zip slip)·링크라 건너뜀"})
            continue
        if not parts or parts[0] in _SKIP_TOP or any(p.startswith(".") for p in parts):
            continue
        # NAS 시스템 이름(@Recycle·@eaDir …)은 해제해도 목록에 표시되지 않는다 — 판정은 files.service 한 곳에서 수행하고, 건너뛴 항목은 통지한다
        from app.files import service as _fs
        if any(_fs.is_hidden_name(p) for p in parts):
            skipped.append({"name": name, "reason": "저장 장치가 쓰는 이름(@Recycle 등)이라 건너뜀"})
            continue
        if i.is_dir():
            plan.append((i, parts))
            continue
        if i.file_size > 1024 * 1024 and i.compress_size and i.file_size / i.compress_size > BOMB_RATIO:
            raise ValueError(f"압축률이 비정상인 항목이 있어 풀지 않습니다(zip bomb 의심): {name}")
        total += i.file_size
        if total > max_bytes:
            raise ValueError(f"풀면 {human_size(total)} 이상으로 상한 {human_size(max_bytes)} 을 넘습니다")
        plan.append((i, parts))
    return plan, skipped, total


def _extract(real: Path, plan, base: Path, max_bytes: int) -> tuple[list[Path], list[dict]]:
    """실제 해제 — 기록한 바이트로 재측정하고(헤더 허위 값 방어), 기존 파일은 덮어쓰지 않고 이름을 변경한다."""
    created: list[Path] = []
    renamed: list[dict] = []
    written = 0
    base_r = base.resolve()
    with zipfile.ZipFile(real) as zf:
        for info, parts in plan:
            target_dir = base
            for seg in parts[:-1] if not info.is_dir() else parts:
                target_dir = target_dir / seg
            if not target_dir.resolve().is_relative_to(base_r):
                continue
            target_dir.mkdir(parents=True, exist_ok=True)
            if info.is_dir():
                continue
            name = _unique_name(target_dir, parts[-1])
            if name != parts[-1]:
                renamed.append({"from": "/".join(parts), "to": name})
            target = target_dir / name
            if not target.resolve().is_relative_to(base_r):
                continue
            with zf.open(info) as src, open(target, "xb") as dst:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes:
                        dst.close()
                        target.unlink(missing_ok=True)
                        raise ValueError("실제 해제 크기가 상한을 넘어 멈췄습니다(zip bomb 의심)")
                    dst.write(chunk)
            created.append(target)
    return created, renamed


async def files_unzip(user: User, path: str, dst_folder: str = "", into_new_folder: bool = True,
                      **_: object) -> dict:
    from app.files import indexer
    from app.files import quota as file_quota
    from app.files import router as fr
    from app.files import service as fs
    from app.mcp.tools.files_write_tool import _undo_for, vp_label

    vp = (path or "").strip("/")
    if not vp.lower().endswith(".zip"):
        return err("unsupported", "zip 파일만 풀 수 있습니다")
    parent = vp.rsplit("/", 1)[0] if "/" in vp else ""
    dst = (dst_folder or "").strip("/") or parent
    if not dst:
        return err("invalid_argument", "dst_folder 가 필요합니다")
    into_new = into_new_folder not in (False, "false", "0", 0)
    try:
        async with async_session() as db:
            real = await _open_zip(db, user, vp)
            max_entries, max_bytes = await _limits(db)
            try:
                plan, skipped, total = await asyncio.to_thread(_plan, real, max_entries, max_bytes)
            except zipfile.BadZipFile:
                return err("invalid_argument", "zip 파일이 손상됐거나 zip 이 아닙니다")
            except PermissionError as e:
                return err("unsupported", str(e))
            except ValueError as e:
                return err("too_large", str(e))
            parent_norm, real_dir, a = await fr._upload_target(db, dst, user)   # 편집 권한 이상
            q_user, q_vp = await fr._quota_subject(db, a, user)
            await file_quota.ensure_room(db, q_user, q_vp, total)
            base_vp = parent_norm
            base = real_dir
            if into_new:
                folder = _unique_name(real_dir, fr._safe_filename(Path(real.name).stem or "압축 풀기"))
                base = real_dir / folder
                base.mkdir()
                base_vp = f"{parent_norm}/{folder}"
            try:
                created, renamed = await asyncio.to_thread(_extract, real, plan, base, max_bytes)
            except ValueError as e:
                return err("too_large", str(e))
            fs.invalidate_cache(real_dir)
            fs.invalidate_cache(base)
            indexer.schedule_quick_index(add=created[:5000])
            out = {"folder": base_vp, "label": vp_label(base_vp), "files": len(created),
                   "size": total, "size_human": human_size(total),
                   "renamed": renamed[:50], "skipped": skipped[:50]}
            if into_new:
                out["_undo"] = await _undo_for(db, user, base_vp)
            return out
    except FileNotFoundError:
        return err("not_found", "파일이 없습니다")
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise


register(Tool(
    name="files_archive_list",
    title="zip 내용 보기",
    description=("List what is inside a .zip file in the workspace (names, sizes, encrypted/unsafe flags) "
                 "without extracting. Paginated with limit/cursor."),
    parameters={"type": "object", "properties": {
        "path": {"type": "string", "description": "Virtual path of the .zip file."},
        "limit": {"type": "integer", "description": "Entries per page (default 200, max 1000)."},
        "cursor": {"type": "string", "description": "next_cursor from the previous page."},
    }, "required": ["path"]},
    handler=files_archive_list, untrusted_output=True,
))

register(Tool(
    name="files_unzip",
    title="zip 풀기",
    description=("Extract a .zip into a folder. By default creates a new folder named after the zip inside "
                 "`dst_folder` (default: the zip's folder) — undoable. Never overwrites (name conflicts get ' (2)'). "
                 "Unsafe entries (absolute paths, '..', links) are skipped; entry count and total size are capped; "
                 "encrypted zips are refused. Uses the user's storage quota."),
    parameters={"type": "object", "properties": {
        "path": {"type": "string", "description": "Virtual path of the .zip file.", "x-label": "zip 파일"},
        "dst_folder": {"type": "string", "description": "Folder to extract into (default: same folder).",
                       "x-label": "풀 폴더", "x-editable": True},
        "into_new_folder": {"type": "boolean", "description": "Create a new folder named after the zip (default true).",
                            "x-label": "새 폴더에 풀기", "x-editable": True},
        "idempotency_key": {"type": "string"},
    }, "required": ["path"]},
    # 해제 위치(없으면 zip 이 있는 폴더)가 공유 영역이면 타인 노출 쓰기
    visible_for=lambda a, u=None: path_shared(a.get("dst_folder") or a.get("path"), u),
    handler=files_unzip, scope="mcp:write", risk="low",
))
