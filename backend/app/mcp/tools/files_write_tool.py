"""파일 쓰기 도구(S3) — 새 텍스트 파일·새 폴더·복사·이동/이름변경·휴지통·외부 공유 링크.

권한 판정은 웹 API 와 **같은 함수**를 쓴다: 파일 라우터의 엔드포인트 함수(mkdir·move_file·rename_file·
delete_file·create_share_link)를 그대로 부르고, 새 텍스트 파일은 업로드와 같은 대상 판정
(_upload_target = 편집 권한 이상)·크기 상한·사용자 할당을 거친다.

되돌리기: 만들기(새 파일·새 폴더·복사)는 `files_undo_create`(만든 그대로일 때만 지움),
이동·이름변경은 `files_move` 로 원위치.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from pathlib import Path

from app.db.models import User
from app.db.session import async_session
from app.mcp.server import Tool, register
from app.mcp.tools._common import path_shared, shared_target  # noqa: F401 — 남에게 보이는 쓰기 판정
from app.mcp.tools._common import (
    UNDO_HINT, UNDO_TOKEN_PARAM, check_undo_token, err, http_err, undo_token,
)

logger = logging.getLogger(__name__)

_TEXT_MAX = 5 * 1024 * 1024      # AI 가 한 번에 쓰는 텍스트 상한
# 텍스트로만 만든다(실행·스크립트 형식은 거절 — 브라우저에서 열리는 html/svg 포함)
_TEXT_EXTS = frozenset({
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".log",
    ".ini", ".toml", ".cfg", ".conf", ".sql", ".rst", ".tex", ".srt", ".vtt",
})
_ROOT_LABEL = {"my": "내 파일", "shared": "공유 폴더", "shared-with-me": "공유받은 항목", "users": "사용자"}
_EXPIRES = {"1h": "1h", "1d": "1d", "7d": "7d", "30d": "30d", "never": None}
_EXPIRES_LABEL = {"1h": "1시간", "1d": "1일", "7d": "7일", "30d": "30일", "never": "만료 없음"}


def vp_label(vp: object) -> str:
    """가상경로 → 사람용 "내 파일 › 프로젝트 › 보고서.docx"."""
    parts = [p for p in str(vp or "").strip("/").split("/") if p]
    if not parts:
        return "(경로 없음)"
    head = _ROOT_LABEL.get(parts[0], parts[0])
    rest = parts[1:]
    if parts[0] == "shared-with-me" and rest:
        rest = rest[1:]            # 공유 id 는 사람에게 의미 없다
    return " › ".join([head, *rest])


def _split(vp: str) -> tuple[str, str]:
    vp = (vp or "").strip("/")
    if "/" not in vp:
        return "", vp
    parent, name = vp.rsplit("/", 1)
    return parent, name


def _fingerprint(real: Path) -> str:
    """만든 그대로인지 가리는 지문 — 파일은 내용 해시, 폴더는 하위 이름·크기 목록 해시."""
    h = hashlib.sha256()
    if real.is_file():
        with open(real, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return "f:" + h.hexdigest()
    for p in sorted(real.rglob("*")):
        rel = p.relative_to(real).as_posix()
        h.update(rel.encode("utf-8", "surrogatepass"))
        h.update(b"\0")
        if p.is_file():
            h.update(str(p.stat().st_size).encode())
        h.update(b"\n")
    return "d:" + h.hexdigest()


def _router():
    from app.files import router as fr
    return fr


async def _undo_for(db, user: User, vp: str) -> dict:
    """방금 만든 항목의 되돌리기 정보(지문 서명)."""
    from app.files import access as acc

    a = await acc.resolve(db, user, vp, "view")
    fp = await asyncio.to_thread(_fingerprint, a.real)
    return {"tool": "files_undo_create",
            "args": {"path": vp, "token": undo_token(user.id, "file", vp.strip("/"), fp)}}


# ── 새 텍스트 파일 ─────────────────────────────────────────────
async def files_write_text(user: User, path: str, content: str, **_: object) -> dict:
    from app.files import activity as act
    from app.files import indexer
    from app.files import quota as file_quota
    from app.files import service as fs

    fr = _router()
    vp = (path or "").strip("/")
    parent_vp, name = _split(vp)
    if not parent_vp or not name:
        return err("invalid_argument", "path 는 폴더를 포함한 전체 경로여야 합니다(예: my/메모/회의록.md)")
    ext = os.path.splitext(name)[1].lower()
    if ext not in _TEXT_EXTS:
        return err("unsupported", f"텍스트 파일만 만들 수 있습니다({', '.join(sorted(_TEXT_EXTS))})")
    data = (content or "").encode("utf-8")
    if len(data) > _TEXT_MAX:
        return err("too_large", f"내용이 너무 큽니다({len(data)} bytes, 상한 {_TEXT_MAX})")
    try:
        async with async_session() as db:
            safe = fr._safe_filename(name)
            max_mb, max_bytes = await fr._upload_max_bytes(db)
            if len(data) > max_bytes:
                return err("too_large", f"업로드 상한({max_mb}MB)을 넘습니다")
            parent_norm, real_dir, a = await fr._upload_target(db, parent_vp, user)   # 편집 권한 이상
            target = real_dir / safe
            if target.exists():
                return err("conflict", f"이미 있는 파일입니다: {vp_label(f'{parent_norm}/{safe}')} — 덮어쓰지 않습니다")
            q_user, q_vp = await fr._quota_subject(db, a, user)
            await file_quota.ensure_room(db, q_user, q_vp, len(data))

            def _write():
                with open(target, "xb") as f:      # 그 사이 생긴 파일도 덮지 않는다
                    f.write(data)
            try:
                await asyncio.to_thread(_write)
            except FileExistsError:
                return err("conflict", "이미 있는 파일입니다 — 덮어쓰지 않습니다")
            fs.invalidate_cache(real_dir)
            indexer.schedule_quick_index(add=[target])
            await act.record(fr._child_key(a, safe), user.id, "upload", {"size": len(data), "via": "ai"})
            new_vp = f"{parent_norm}/{safe}"
            undo = await _undo_for(db, user, new_vp)
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    return {"path": new_vp, "size": len(data), "label": vp_label(new_vp), "_undo": undo}


# ── 새 폴더 ───────────────────────────────────────────────────
async def files_create_folder(user: User, path: str, **_: object) -> dict:
    from app.files.schemas import MkdirRequest

    fr = _router()
    vp = (path or "").strip("/")
    try:
        async with async_session() as db:
            r = await fr.mkdir(MkdirRequest(path=vp), user=user, db=db)
            undo = await _undo_for(db, user, r["path"])
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    return {"path": r["path"], "label": vp_label(r["path"]), "_undo": undo}


# ── 복사 ──────────────────────────────────────────────────────
async def files_copy(user: User, src: str, dst_folder: str, **_: object) -> dict:
    from app.files.schemas import MoveRequest

    fr = _router()
    try:
        async with async_session() as db:
            r = await fr.move_file(MoveRequest(src=src, dst=dst_folder, copy=True), user=user, db=db)
            undo = await _undo_for(db, user, r["path"])
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    return {"path": r["path"], "label": vp_label(r["path"]), "_undo": undo}


# ── 이동 · 이름 변경 ──────────────────────────────────────────
async def files_move(user: User, src: str, dst_folder: str = "", new_name: str = "", **_: object) -> dict:
    from app.files.schemas import MoveRequest, RenameRequest

    fr = _router()
    orig = (src or "").strip("/")
    orig_parent, orig_name = _split(orig)
    dst = (dst_folder or "").strip("/")
    new_name = (new_name or "").strip()
    if not orig or not orig_name:
        return err("invalid_argument", "src 가 비었습니다")
    if not dst and not new_name:
        return err("invalid_argument", "dst_folder 나 new_name 중 하나는 있어야 합니다")
    if new_name and ("/" in new_name or "\\" in new_name):
        return err("invalid_argument", "new_name 에는 경로 구분자를 쓸 수 없습니다")
    cur = orig
    moved = False
    try:
        async with async_session() as db:
            if dst and dst != orig_parent:
                r = await fr.move_file(MoveRequest(src=cur, dst=dst), user=user, db=db)
                cur = r["path"]
                moved = True
            if new_name and new_name != _split(cur)[1]:
                try:
                    r = await fr.rename_file(RenameRequest(path=cur, new_name=new_name), user=user, db=db)
                except Exception:
                    if moved:      # 이름 바꾸기가 막히면 옮긴 것도 원위치(반쯤 된 상태를 남기지 않는다)
                        try:
                            await fr.move_file(MoveRequest(src=cur, dst=orig_parent), user=user, db=db)
                        except Exception:  # noqa: BLE001
                            logger.warning("[mcp] files_move rollback failed", exc_info=True)
                    raise
                cur = r["path"]
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    out = {"from": orig, "path": cur, "label": vp_label(cur)}
    if cur != orig:
        out["_undo"] = {"tool": "files_move",
                        "args": {"src": cur, "dst_folder": orig_parent, "new_name": orig_name}}
    return out


# ── 되돌리기: 방금 만든 항목 지우기 ────────────────────────────
async def files_undo_create(user: User, path: str, token: str, **_: object) -> dict:
    from app.files import access as acc
    from app.files import activity as act
    from app.files import indexer
    from app.files import service as fs

    vp = (path or "").strip("/")
    try:
        async with async_session() as db:
            a = await acc.resolve(db, user, vp, "edit")
            real = a.real
            if not real.exists():
                return err("not_found", f"이미 없습니다: {vp_label(vp)}")
            fp = await asyncio.to_thread(_fingerprint, real)
            if not check_undo_token(token, user.id, "file", vp, fp):
                return err("conflict", "만든 뒤 내용이 바뀌었거나 이 도구로 만든 항목이 아니라 지우지 않습니다")
            await asyncio.to_thread(fs.delete_path, real)
            fs.invalidate_cache(real.parent)
            indexer.schedule_quick_index(forget=[real])
            await acc.purge(db, a.owner_id, a.owner_vpath)
            await act.record(a.key, user.id, "delete", {"undo": True, "via": "ai"})
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    return {"removed": vp}


# ── 휴지통으로(high) ──────────────────────────────────────────
async def files_delete(user: User, path: str, **_: object) -> dict:
    fr = _router()
    try:
        async with async_session() as db:
            r = await fr.delete_file(path=path, permanent=False, user=user, db=db)
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    return {"trashed": (path or "").strip("/"), "trash_name": r.get("trash_name"),
            "note": "휴지통으로 옮겼습니다. 보관 기간 안에는 파일 › 휴지통에서 복원할 수 있습니다."}


# ── 외부 공유 링크(high) ──────────────────────────────────────
async def files_share_external(user: User, path: str, expires_in: str = "7d", password: str = "",
                               allow_download: bool = True, **_: object) -> dict:
    from app.files.schemas import ShareLinkCreate

    if expires_in not in _EXPIRES:
        return err("invalid_argument", "expires_in 은 1h·1d·7d·30d·never 중 하나입니다")
    fr = _router()
    try:
        vp = (path or "").strip("/")
        async with async_session() as db:
            is_dir = False
            try:
                from app.files import access as _acc

                is_dir = (await _acc.resolve(db, user, vp, "view")).real.is_dir()
            except Exception:  # noqa: BLE001 — 판정은 create_share_link 가 다시 한다
                pass
            r = await fr.create_share_link(
                ShareLinkCreate(path="" if is_dir else vp, paths=[vp] if is_dir else None,
                                expires_in=_EXPIRES[expires_in],
                                password=(password or None), allow_download=bool(allow_download)),
                user=user, db=db)
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    return {"url": r.url, "link_id": r.id, "name": r.display_name,
            "expires_at": r.expires_at.isoformat() if r.expires_at else None,
            "has_password": r.has_password, "allow_download": r.allow_download,
            "note": "링크를 아는 사람은 누구나 열 수 있습니다. 파일 › 공유 링크에서 끌 수 있습니다."}


# ── 미리보기·요약 ─────────────────────────────────────────────
def _sum_path(args: dict) -> str:
    return vp_label(args.get("path"))


def _sum_copy(args: dict) -> str:
    return f"{vp_label(args.get('src'))} → {vp_label(args.get('dst_folder'))}"


def _sum_move(args: dict) -> str:
    src = str(args.get("src") or "").strip("/")
    parent, name = _split(src)
    dst = str(args.get("dst_folder") or "").strip("/") or parent
    return f"{vp_label(src)} → {vp_label(dst + '/' + (args.get('new_name') or name))}"


def _prev_move(args: dict) -> list[dict]:
    src = str(args.get("src") or "").strip("/")
    parent, name = _split(src)
    dst = str(args.get("dst_folder") or "").strip("/") or parent
    return [{"field": "src", "label": "위치", "before": vp_label(src),
             "after": vp_label(dst + "/" + (args.get("new_name") or name))}]


def _sum_share(args: dict) -> str:
    exp = _EXPIRES_LABEL.get(str(args.get("expires_in") or "7d"), str(args.get("expires_in")))
    extra = " · 비밀번호" if args.get("password") else ""
    return f"외부 공유 링크 · {vp_label(args.get('path'))} · {exp}{extra}"


def _prev_share(args: dict) -> list[dict]:
    rows = [{"field": "path", "label": "파일", "before": None, "after": vp_label(args.get("path"))},
            {"field": "expires_in", "label": "만료", "before": None,
             "after": _EXPIRES_LABEL.get(str(args.get("expires_in") or "7d"), args.get("expires_in"))},
            {"field": "allow_download", "label": "내려받기", "before": None,
             "after": "허용" if args.get("allow_download", True) else "미리보기만"}]
    if args.get("password"):
        rows.append({"field": "password", "label": "비밀번호", "before": None, "after": "설정함"})
    return rows


def _prev_write_text(args: dict) -> list[dict]:
    body = str(args.get("content") or "")
    return [{"field": "path", "label": "새 파일", "before": None, "after": vp_label(args.get("path"))},
            {"field": "content", "label": "내용", "before": None,
             "after": body if len(body) <= 2000 else body[:2000] + f"… (총 {len(body)}자)"}]


_PATH_HELP = "Virtual path: `my/...` (personal), `shared/...` (team), `shared-with-me/<id>/...` (shared with the user)."

register(Tool(
    name="files_write_text",
    title="텍스트 파일 만들기",
    description=(
        "Create a NEW text file (Markdown, txt, csv, json, yaml…) in the user's storage with the given "
        "content. Refuses if a file already exists at that path (never overwrites). Missing parent "
        "folders are created. Needs edit permission on the folder. " + _PATH_HELP
    ),
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Full virtual path of the new file, e.g. `my/notes/meeting.md`.",
                     "x-label": "파일 경로", "x-editable": True},
            "content": {"type": "string", "description": "File content (UTF-8 text).",
                        "x-label": "내용", "x-editable": True, "x-multiline": True},
        },
        "required": ["path", "content"],
    },
    visible_for=shared_target("path"),   # 공유 영역이면 남에게 보이는 쓰기(외부 내용을 읽은 뒤에는 묻는다)
    handler=files_write_text, previewer=_prev_write_text, summarizer=_sum_path,
))

register(Tool(
    name="files_create_folder",
    title="새 폴더 만들기",
    description="Create a new folder at the given virtual path (fails if it exists). " + _PATH_HELP,
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Virtual path of the new folder, e.g. `my/projects/2026`.",
                     "x-label": "폴더 경로", "x-editable": True},
        },
        "required": ["path"],
    },
    visible_for=shared_target("path"),   # 공유 영역이면 남에게 보이는 쓰기(외부 내용을 읽은 뒤에는 묻는다)
    handler=files_create_folder, summarizer=_sum_path,
))

register(Tool(
    name="files_copy",
    title="파일 복사",
    description=(
        "Copy a file or folder into another folder. If the name is taken the copy is named "
        "\"name (사본)\". Needs view permission on the source and edit permission on the destination."
    ),
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "src": {"type": "string", "description": "Virtual path of the file/folder to copy.", "x-label": "원본"},
            "dst_folder": {"type": "string", "description": "Destination folder virtual path.",
                           "x-label": "복사할 폴더", "x-editable": True},
        },
        "required": ["src", "dst_folder"],
    },
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 남에게 보이는 쓰기(외부 내용을 읽은 뒤에는 묻는다)
    handler=files_copy, summarizer=_sum_copy,
))

register(Tool(
    name="files_move",
    title="파일 이동·이름 바꾸기",
    description=(
        "Move a file or folder to another folder and/or rename it. Give `dst_folder` to move, "
        "`new_name` to rename, or both. Shares and comments follow the item. Needs co-owner "
        "permission on the source (always true in the user's own `my/`)."
    ),
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "src": {"type": "string", "description": "Virtual path of the file/folder.", "x-label": "대상"},
            "dst_folder": {"type": "string", "description": "Destination folder. Empty = keep the current folder.",
                           "default": "", "x-label": "옮길 폴더", "x-editable": True},
            "new_name": {"type": "string", "description": "New name (no slashes). Empty = keep the name.",
                         "default": "", "x-label": "새 이름", "x-editable": True},
        },
        "required": ["src"],
    },
    visible_for=shared_target("src", "dst_folder"),   # 공유 영역이면 남에게 보이는 쓰기(외부 내용을 읽은 뒤에는 묻는다)
    handler=files_move, previewer=_prev_move, summarizer=_sum_move,
))

register(Tool(
    name="files_undo_create",
    title="만든 파일 되돌리기",
    description="Delete a file/folder that files_write_text, files_create_folder or files_copy just created, "
                "only if it is unchanged." + UNDO_HINT,
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path the write tool returned.", "x-label": "경로"},
            "token": UNDO_TOKEN_PARAM,
        },
        "required": ["path", "token"],
    },
    handler=files_undo_create, summarizer=_sum_path,
))

register(Tool(
    name="files_delete",
    title="파일 휴지통으로",
    description=(
        "Move a file or folder to the trash (not a permanent delete — it can be restored from the "
        "trash during the retention period). Requires the user's approval in the workspace approval "
        "inbox; returns pending_approval — check later with approvals_status."
    ),
    scope="mcp:write", risk="high",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Virtual path of the file/folder to trash.", "x-label": "대상"},
        },
        "required": ["path"],
    },
    visible_for=shared_target("path"),   # 공유 영역이면 남에게 보이는 쓰기(외부 내용을 읽은 뒤에는 묻는다)
    handler=files_delete, summarizer=_sum_path,
))

register(Tool(
    name="files_share_external",
    title="외부 공유 링크 만들기",
    description=(
        "Create a public share link for a file, a zip, or a folder (a folder link downloads as one zip) — "
        "anyone with the URL can open it. Default expiry 7 "
        "days; optional password; `allow_download=false` allows preview only "
        "(rejected with 400 for a single file whose format cannot be previewed — only images, PDF and text can — "
        "and for bundles of two or more items; a single folder is allowed). Requires the user's "
        "approval in the workspace approval inbox; returns pending_approval — check later with "
        "approvals_status (the URL is in the result once approved)."
    ),
    scope="mcp:write", risk="high",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Virtual path of the file, zip or folder (`my/...` or `shared/...`).",
                     "x-label": "파일·폴더"},
            "expires_in": {"type": "string", "enum": ["1h", "1d", "7d", "30d", "never"], "default": "7d",
                           "description": "Link lifetime.", "x-label": "만료", "x-editable": True},
            "password": {"type": "string", "default": "", "description": "Optional password for the link.",
                         "x-label": "비밀번호", "x-editable": True},
            "allow_download": {"type": "boolean", "default": True,
                               "description": "false = preview only, no download.",
                               "x-label": "내려받기 허용", "x-editable": True},
        },
        "required": ["path"],
    },
    # 링크를 아는 누구에게나 보인다 — 외부 내용을 읽은 뒤에는 어떤 모드여도 묻는다(writes.request_write)
    visible_to_others=True,
    handler=files_share_external, previewer=_prev_share, summarizer=_sum_share,
))
