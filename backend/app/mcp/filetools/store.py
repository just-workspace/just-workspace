"""파일 도구의 입출력 — 사용자 권한으로 읽고, 결과는 새 파일로 저장(원본 보존).

* 읽기: ``acc.resolve(..., "view")`` — 웹·MCP 와 같은 권한 판정(공유받은 항목 포함).
* 저장 기본 폴더: ``my/AI 결과물/YYYY-MM-DD 대화 제목`` (결과물 저장과 같은 규칙 — 날짜는 사용자 시간대,
  대화가 없으면 "새 대화"). ``dst_folder`` 를 주면 그 폴더(편집 권한 이상).
* 업로드와 같은 대상 판정(_upload_target)·크기 상한·사용자 할당(quota)을 거친다. 이름이 겹치면 " (2)".
* 결과 파일 정보는 ``{path, name, size, mime}`` — 결과물 카드가 그대로 붙일 수 있는 모양.
* 되돌리기: 파일 하나면 그 파일, 여러 개면 묶음 폴더를 ``files_undo_create`` 로(만든 그대로일 때만).
* 덮어쓰기(고위험 승인 뒤에만): 이전본을 버전 기록으로 남기고 원자적으로 바꾼다.
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone

from app.db.models import User

ROOT_FOLDER = "AI 결과물"
DEFAULT_TITLE = "새 대화"
_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

MIME = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".hwp": "application/x-hwp",
    ".hwpx": "application/hwp+zip",
}


def mime_for(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    return MIME.get(ext) or mimetypes.guess_type(name)[0] or "application/octet-stream"


class StoreError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class OutFile:
    name: str
    data: bytes
    mime: str | None = None


def session():
    """DB 세션 진입점 — 테스트가 바꿔 끼운다."""
    from app.db.session import async_session

    return async_session()


def clean_name(name: str, fallback: str = "결과") -> str:
    n = _BAD_NAME.sub(" ", str(name or "")).strip().strip(".").strip()
    n = re.sub(r"\s+", " ", n)
    n = re.sub(r"\.{2,}", ".", n).lstrip(".")
    return n[:150] or fallback


def derived_name(src_path: str, suffix: str, ext: str | None = None) -> str:
    """원본 이름에서 새 이름 — "보고서.docx" + "수정" → "보고서 (수정).docx"."""
    base = os.path.basename(str(src_path or "").rstrip("/")) or "파일"
    stem, e = os.path.splitext(base)
    return clean_name(f"{stem} ({suffix}){ext if ext is not None else e}")


def with_ext(name: str, ext: str) -> str:
    name = clean_name(name)
    return name if name.lower().endswith(ext.lower()) else name + ext


# ── 읽기 ───────────────────────────────────────────────────────
async def read_input(user: User, path: str, *, max_bytes: int, exts: tuple[str, ...] | None = None,
                     db=None) -> tuple[bytes, str]:
    """(바이트, 파일 이름). 권한·형식·크기 위반은 StoreError / HTTPException(호출자가 http_err)."""
    from app.files import access as acc

    vp = (path or "").strip("/")
    if not vp:
        raise StoreError("invalid_argument", "path 가 비었습니다")
    ext = os.path.splitext(vp)[1].lower()
    if exts and ext not in exts:
        raise StoreError("unsupported", f"이 도구는 {', '.join(exts)} 파일만 다룹니다: {vp}")

    async def _go(d):
        a = await acc.resolve(d, user, vp, "view")
        real = a.real
        if not real.exists():
            raise StoreError("not_found", f"파일이 없습니다: {vp}")
        if not real.is_file():
            raise StoreError("invalid_argument", f"파일이 아닙니다: {vp}")
        size = real.stat().st_size
        if size > max_bytes:
            raise StoreError("too_large", f"파일이 너무 큽니다({size} bytes, 상한 {max_bytes}): {vp}")
        return await asyncio.to_thread(real.read_bytes), real.name

    if db is not None:
        return await _go(db)
    async with session() as d:
        return await _go(d)


# ── 저장 폴더 ──────────────────────────────────────────────────
async def _conversation_title(db, conv_id: str | None) -> str:
    if not conv_id:
        return DEFAULT_TITLE
    try:
        from app.ai.models import AIConversation

        c = await db.get(AIConversation, conv_id)
        t = (c.title or "").strip() if c else ""
        return t or DEFAULT_TITLE
    except Exception:  # noqa: BLE001
        return DEFAULT_TITLE


def folder_name(when: datetime, title: str, tz) -> str:
    d = when.astimezone(tz).strftime("%Y-%m-%d")
    t = _BAD_NAME.sub(" ", title or DEFAULT_TITLE).strip().strip(".").strip()
    t = re.sub(r"\s+", " ", t)[:80] or DEFAULT_TITLE
    return f"my/{ROOT_FOLDER}/{d} {t}"


async def default_folder(db, user: User) -> str:
    from app.mcp import writes
    from app.mcp.tools._common import user_tz

    ctx = writes.call_context.get()
    title = await _conversation_title(db, ctx.conversation_id if ctx else None)
    return folder_name(datetime.now(timezone.utc), title, user_tz(user))


def _unique(name: str, used: set[str]) -> str:
    if name.lower() not in used:
        used.add(name.lower())
        return name
    stem, ext = os.path.splitext(name)
    n = 2
    while f"{stem} ({n}){ext}".lower() in used:
        n += 1
    out = f"{stem} ({n}){ext}"
    used.add(out.lower())
    return out


# ── 저장 ───────────────────────────────────────────────────────
async def save_outputs(user: User, files: list[OutFile], *, dst_folder: str = "", group_name: str = "") -> dict:
    """새 파일로 저장. 여러 개이고 group_name 이 있으면 새 하위 폴더에 묶는다(되돌리기 단위).

    반환: {files:[{path,name,size,mime}], folder, folder_label, (하나면) path·name·size·mime, _undo}
    """
    from app.files import activity as act
    from app.files import indexer
    from app.files import quota as file_quota
    from app.files import router as fr
    from app.files import service as fs
    from app.mcp.tools.files_write_tool import _undo_for, vp_label

    if not files:
        raise StoreError("internal", "저장할 결과가 없습니다")
    async with session() as db:
        folder = (dst_folder or "").strip("/") or await default_folder(db, user)
        max_mb, max_bytes = await fr._upload_max_bytes(db)
        for f in files:
            if len(f.data) > max_bytes:
                raise StoreError("too_large", f"{f.name}: 업로드 상한({max_mb}MB)을 넘습니다")
        parent_norm, real_dir, a = await fr._upload_target(db, folder, user)   # 편집 권한 이상, 없으면 만든다
        q_user, q_vp = await fr._quota_subject(db, a, user)
        await file_quota.ensure_room(db, q_user, q_vp, sum(len(f.data) for f in files))
        used = {p.name.lower() for p in real_dir.iterdir()} if real_dir.is_dir() else set()
        group_vp = None
        if len(files) > 1 and group_name:
            gname = _unique(fr._safe_filename(clean_name(group_name)), used)
            real_dir = real_dir / gname
            await asyncio.to_thread(real_dir.mkdir)
            parent_norm = f"{parent_norm}/{gname}"
            group_vp = parent_norm
            used = set()
        saved = []
        for f in files:
            name = _unique(fr._safe_filename(clean_name(f.name)), used)
            target = real_dir / name

            def _write(t=target, d=f.data):
                with open(t, "xb") as fh:
                    fh.write(d)
            await asyncio.to_thread(_write)
            vp = f"{parent_norm}/{name}"
            saved.append({"path": vp, "name": name, "size": len(f.data), "mime": f.mime or mime_for(name)})
            indexer.schedule_quick_index(add=[target])
            key = fr._child_key(a, name if group_vp is None else f"{os.path.basename(group_vp)}/{name}")
            await act.record(key, user.id, "upload", {"size": len(f.data), "via": "ai"})
        fs.invalidate_cache(real_dir)
        if group_vp:
            fs.invalidate_cache(real_dir.parent)
            undo = await _undo_for(db, user, group_vp)
        else:
            undo = await _undo_for(db, user, saved[0]["path"]) if len(saved) == 1 else None
    folder_vp = group_vp or parent_norm
    out = {"files": saved, "folder": folder_vp, "folder_label": vp_label(folder_vp)}
    if len(saved) == 1:
        out.update(saved[0])
        out["label"] = vp_label(saved[0]["path"])
    if undo:
        out["_undo"] = undo
    return out


async def overwrite(user: User, path: str, data: bytes, mime: str | None = None) -> dict:
    """원본 덮어쓰기(고위험 승인 뒤에만 불린다). 이전본은 버전 기록(내 파일 my/ 영역)에 남긴다."""
    from app.files import access as acc
    from app.files import activity as act
    from app.files import indexer
    from app.files import quota as file_quota
    from app.files import router as fr
    from app.files import service as fs
    from app.mcp.tools.files_write_tool import vp_label

    vp = (path or "").strip("/")
    if "/" not in vp:
        raise StoreError("invalid_argument", "덮어쓸 파일 경로가 잘못됐습니다")
    parent_vp, name = vp.rsplit("/", 1)
    async with session() as db:
        pa = await acc.resolve(db, user, parent_vp, "edit")
        target = pa.real / name
        if not target.is_file():
            raise StoreError("not_found", f"덮어쓸 파일이 없습니다: {vp}")
        max_mb, max_bytes = await fr._upload_max_bytes(db)
        if len(data) > max_bytes:
            raise StoreError("too_large", f"업로드 상한({max_mb}MB)을 넘습니다")
        old = target.stat().st_size
        if len(data) > old:
            q_user, q_vp = await fr._quota_subject(db, pa, user)
            await file_quota.ensure_room(db, q_user, q_vp, len(data) - old)
        await asyncio.to_thread(fr._snapshot_before_overwrite, pa, target, name)

        def _replace():
            fd, tmp = tempfile.mkstemp(prefix=".ai-", dir=str(target.parent))
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(data)
                os.replace(tmp, target)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        await asyncio.to_thread(_replace)
        fs.invalidate_cache(target.parent)
        indexer.schedule_quick_index(add=[target])
        await act.record(fr._child_key(pa, name), user.id, "edit", {"size": len(data), "via": "ai"})
    info = {"path": vp, "name": name, "size": len(data), "mime": mime or mime_for(name)}
    return {**info, "files": [info], "overwritten": True, "label": vp_label(vp),
            "note": "원본을 덮어썼습니다. 내 파일(my/)이면 이전본은 파일 › 버전 기록에서 되살릴 수 있습니다."}
