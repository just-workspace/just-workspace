"""S4 결과물 도구 — 문서 만들기(docx·xlsx·pptx·pdf)·여러 개 묶음·파일 압축·작업 상태·내 파일에 저장.

모두 쓰기 체계(app.mcp.writes.request_write)를 지난다. 문서 만들기는 low + auto_run(본인만 받는 24시간 임시
결과물이라 카드 없이 바로), 내 파일 저장은 low(내장 AI 에서는 승인 카드). 결과는 내려받기 링크
(claude.ai 는 절대 주소, 내장 AI 는 화면 결과물 카드).
"""

from __future__ import annotations

import logging

from app.ai import artifacts as arts
from app.ai import docgen
from app.db.models import User
from app.mcp.server import Tool, register
from app.mcp.tools._common import err, http_err

logger = logging.getLogger(__name__)

_CODE = {"gone": "not_found", "expired": "conflict"}


def _ctx():
    from app.mcp import writes

    return writes.call_context.get()


def _absolute() -> bool:
    c = _ctx()
    return bool(c and c.source == "mcp")


def _conv_id() -> str | None:
    c = _ctx()
    return c.conversation_id if c else None


def _note(kind: str) -> str:
    if _absolute():
        return ("Give the user the download_url as a link. It works for 24 hours and only when they are signed in "
                "to the workspace. Offer to save it to their files (artifacts_save_to_files) if they want to keep it.")
    return ("화면에 결과물 카드(미리보기·다운로드·내 파일에 저장)가 자동으로 보입니다. 링크를 따로 적지 말고 "
            + ("무엇을 만들었는지만 짧게 알리세요." if kind == "file" else "서버에서 만드는 중이며 끝나면 알림이 간다고 알리세요."))


def _art_err(e: arts.ArtifactError) -> dict:
    return err(_CODE.get(e.code, e.code), e.message, **e.extra)


def _spec_of(item: dict) -> dict:
    return {k: item.get(k) for k in ("title", "subtitle", "filename", "blocks", "sheets", "slides")}


# ── 문서 하나 ─────────────────────────────────────────────────
async def docs_create(user: User, format: str, title: str = "", subtitle: str = "", filename: str = "",
                      blocks: list | None = None, sheets: list | None = None, slides: list | None = None,
                      **_: object) -> dict:
    try:
        spec = docgen.normalize(format, {"title": title, "subtitle": subtitle, "filename": filename,
                                         "blocks": blocks, "sheets": sheets, "slides": slides})
    except docgen.SpecError as e:
        return err(e.code, e.message)
    async with arts.session() as db:
        a = await arts.create_artifact(db, user.id, spec, _conv_id())
        out = arts.artifact_out(a, _absolute())
    res = {"artifact": out, "status": out["status"], "name": out["name"], "message": _note("file")}
    if out["status"] == "failed":
        res["message"] = f"문서를 만들지 못했습니다({out['error']}). 사용자는 카드의 [다시 만들기]로 다시 시도할 수 있습니다."
    else:
        res["download_url"] = out["download_url"]
        res["expires_at"] = out["expires_at"]
    return res


# ── 여러 개 → zip(서버 작업) ──────────────────────────────────
async def docs_create_bundle(user: User, files: list, zip_name: str = "", **_: object) -> dict:
    if not isinstance(files, list) or not files:
        return err("invalid_argument", "files 는 문서 입력의 배열이어야 합니다")
    if len(files) > arts.MAX_BUNDLE:
        return err("too_large", f"한 번에 {arts.MAX_BUNDLE}개까지 만들 수 있습니다")
    specs = []
    for i, f in enumerate(files):
        if not isinstance(f, dict):
            return err("invalid_argument", f"files[{i}] 가 객체가 아닙니다")
        try:
            specs.append(docgen.normalize(f.get("format"), _spec_of(f)))
        except docgen.SpecError as e:
            return err(e.code, f"files[{i}]: {e.message}")
    async with arts.session() as db:
        job = await arts.start_bundle(db, user.id, specs, zip_name, _conv_id())
        out = await arts.job_view(db, job, _absolute())
    return {"job": out, "job_id": out["id"], "status": "running", "message": _note("bundle")
            + (" Poll docs_job_status(job_id) for progress and the zip link." if _absolute() else "")}


# ── 파일 압축(쓰기 low — 내 파일에 새 zip) ──────────────────
async def files_zip(user: User, paths: list | None = None, folder: str = "", query: str = "", path: str = "",
                    name_only: bool = False, zip_name: str = "", dst_path: str = "", encoding: str = "utf-8",
                    conflict: str = "preserve_paths", dedupe: bool = False, **_: object) -> dict:
    if isinstance(paths, str):
        paths = [paths]
    if not (paths or (folder or "").strip("/") or (query or "").strip()):
        return err("invalid_argument", "paths·folder·query 중 하나는 있어야 합니다")
    name = zip_name or (query.strip() if query else "") or ((folder or "").strip("/").rsplit("/", 1)[-1]) or "파일 묶음"
    try:
        async with arts.session() as db:
            job, done = await arts.start_files_zip(
                db, user, name=name, conversation_id=_conv_id(), paths=paths, folder=folder, query=query,
                search_path=path, name_only=name_only in (True, "true", "1", 1), dst_path=dst_path or "",
                encoding=encoding or "utf-8", conflict=conflict or "preserve_paths",
                dedupe=dedupe in (True, "true", "1", 1))
            out = await arts.zip_summary(db, job, _absolute(), with_job=not _absolute())
            meta = arts._uj(job.meta, {}) or {}
    except arts.ArtifactError as e:
        return _art_err(e)
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    if done and out.get("status") == "failed" and not out.get("files"):
        return err("conflict" if out.get("error") and "이미 있는" in out["error"] else "not_found",
                   out.get("error") or "압축할 수 있는 파일이 없습니다", skipped=out.get("skipped"))
    if done and meta.get("undo"):
        out["_undo"] = {"tool": "files_undo_create", "args": meta["undo"]}
    if not done:
        out["message"] = ("큰 묶음이라 서버 작업으로 만듭니다. files_job_status(job_id)로 진행률과 결과를 확인하세요."
                          if _absolute() else _note("bundle"))
    return out


# ── 작업 상태(읽기) ───────────────────────────────────────────
async def docs_job_status(user: User, job_id: str, **_: object) -> dict:
    try:
        async with arts.session() as db:
            job = await arts.get_job(db, user, job_id)
            out = await arts.job_view(db, job, True)
    except arts.ArtifactError as e:
        return _art_err(e)
    if out["zip"] and out["zip"]["download_url"]:
        out["download_url"] = out["zip"]["download_url"]
    return out


# ── 내 파일에 저장(쓰기 low) ──────────────────────────────────
async def artifacts_save_to_files(user: User, artifact_id: str = "", job_id: str = "", **_: object) -> dict:
    if not artifact_id and not job_id:
        return err("invalid_argument", "artifact_id 나 job_id 가 필요합니다")
    try:
        async with arts.session() as db:
            items = await arts.artifacts_for(db, user, [artifact_id] if artifact_id else None, job_id or None)
            return await arts.save_to_files(db, user, items, job_id or None)
    except arts.ArtifactError as e:
        return _art_err(e)
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise


# ── 스키마 ────────────────────────────────────────────────────
_CELL = {"description": "Cell value: string, number, boolean, null, or {\"formula\": \"=SUM(B2:B5)\"} "
                        "(calculation functions only; external refs rejected)."}
_TABLE_ROWS = {"type": "array", "items": {"type": "array", "items": {"type": "string"}},
               "description": "Body rows (arrays of cell text)."}
_BLOCKS = {
    "type": "array",
    "description": "docx/pdf body, in order. Each block: {type: heading|paragraph|list|table|page_break, ...}.",
    "items": {"type": "object", "properties": {
        "type": {"type": "string", "enum": ["heading", "paragraph", "list", "table", "page_break"]},
        "text": {"type": "string", "description": "heading/paragraph text (\\n = line break)."},
        "level": {"type": "integer", "description": "heading level 1-3."},
        "items": {"type": "array", "items": {"type": "string"}, "description": "list items."},
        "ordered": {"type": "boolean", "description": "numbered list."},
        "header": {"type": "array", "items": {"type": "string"}, "description": "table header cells."},
        "rows": _TABLE_ROWS,
    }, "required": ["type"]},
}
_SHEETS = {
    "type": "array", "description": "xlsx sheets.",
    "items": {"type": "object", "properties": {
        "name": {"type": "string"},
        "header": {"type": "array", "items": {"type": "string"}},
        "rows": {"type": "array", "items": {"type": "array", "items": _CELL}},
    }, "required": ["rows"]},
}
_SLIDES = {
    "type": "array", "description": "pptx slides after the automatic title slide.",
    "items": {"type": "object", "properties": {
        "title": {"type": "string"},
        "bullets": {"type": "array", "items": {"type": "string"}, "description": "Bullet lines (or {text, level})."},
        "notes": {"type": "string", "description": "Speaker notes."},
        "table": {"type": "object", "properties": {"header": {"type": "array", "items": {"type": "string"}},
                                                   "rows": _TABLE_ROWS}},
    }},
}
_DOC_PROPS = {
    "format": {"type": "string", "enum": list(docgen.FORMATS), "description": "File type. HWP is not supported.",
               "x-label": "형식"},
    "title": {"type": "string", "description": "Document title (also the default file name).", "x-label": "제목"},
    "subtitle": {"type": "string", "description": "Optional subtitle."},
    "filename": {"type": "string", "description": "File name without extension (optional).", "x-label": "파일 이름"},
    "blocks": _BLOCKS,
    "sheets": _SHEETS,
    "slides": _SLIDES,
}


def _sum_doc(a: dict) -> str:
    return docgen.safe_filename(a.get("filename") or a.get("title") or "", str(a.get("format") or "docx"))


def _prev_doc(a: dict) -> list[dict]:
    return [{"field": "filename", "label": "파일", "before": None, "after": _sum_doc(a)}]


register(Tool(
    name="docs_create",
    title="문서 만들기",
    description=(
        "Create a Word (docx), Excel (xlsx), PowerPoint (pptx) or PDF file from structured content and return a "
        "24-hour download link for the user (owner only). docx/pdf use `blocks`; xlsx uses `sheets`; pptx uses "
        "`slides` (a title slide is added from `title`/`subtitle`). The file is NOT saved to the user's files — "
        "use artifacts_save_to_files for that. For several files at once use docs_create_bundle."
    ),
    parameters={"type": "object", "properties": {**_DOC_PROPS, "idempotency_key": {"type": "string"}},
                "required": ["format"]},
    handler=docs_create, scope="mcp:write", risk="low", auto_run=True,
    summarizer=_sum_doc, previewer=_prev_doc,
))

register(Tool(
    name="docs_create_bundle",
    title="문서 여러 개 만들기",
    description=(
        f"Create up to {arts.MAX_BUNDLE} documents (same item shape as docs_create) as a server job and bundle them "
        "into a zip. Returns a job_id immediately; the job keeps running if the user leaves. If some files fail, "
        "the zip contains only the ones that were made and the failures are listed. Check docs_job_status(job_id)."
    ),
    parameters={"type": "object", "properties": {
        "files": {"type": "array", "items": {"type": "object", "properties": _DOC_PROPS, "required": ["format"]},
                  "description": "Documents to create."},
        "zip_name": {"type": "string", "description": "Zip file name without extension.", "x-label": "zip 이름"},
        "idempotency_key": {"type": "string"},
    }, "required": ["files"]},
    handler=docs_create_bundle, scope="mcp:write", risk="low", auto_run=True,
    summarizer=lambda a: f"문서 {len(a.get('files') or [])}개 → {a.get('zip_name') or 'zip'}",
))

register(Tool(
    name="files_zip",
    title="파일 압축해서 내려받기",
    description=(
        "Zip workspace files into a NEW zip file in the user's files (dst_path, or 'AI 결과물/<date> <title>/'). "
        "Input: `paths` (files or folders, e.g. from files_search/files_list; folders are included recursively "
        "with their structure), `folder`, or `query` (+ `path`, `name_only`: every files_search match, all "
        "pages). Each file is re-checked with the user's permissions; unreadable files do not fail the zip — "
        "they are listed in skipped[] {path, reason} and in the zip manifest. Result starts with "
        "{path, size, files, skipped, deduped, undo} plus a 24-hour download_url. Small zips (<= 500 files and "
        "200 MB) finish in this call; larger ones return job_id — poll files_job_status. Limits: file count and "
        "total size (admin settings; default 2,000 files / 2 GB) — over the limit returns error_code too_large "
        "with a hint. Undo with files_undo_create(path, token). The zip can then be shared "
        "(files_share_external) or attached to mail (mail_save_draft/mail_send attachments)."
    ),
    parameters={"type": "object", "properties": {
        "paths": {"type": "array", "items": {"type": "string"}, "description": "Virtual paths (files or folders).",
                  "x-label": "대상"},
        "folder": {"type": "string", "description": "Folder to zip with everything under it.", "x-label": "폴더"},
        "query": {"type": "string", "description": "files_search query — zip every match.", "x-label": "검색어"},
        "path": {"type": "string", "description": "Limit `query` to this folder."},
        "name_only": {"type": "boolean", "description": "Match `query` against names only."},
        "zip_name": {"type": "string", "description": "Zip file name without extension.", "x-label": "zip 이름"},
        "dst_path": {"type": "string", "description": "Where to save the zip: a NEW file path under my/ "
                     "(e.g. my/보고/자료.zip). Existing files are never overwritten. Default: "
                     "my/AI 결과물/<date> <conversation title>/<zip_name>.zip.", "x-label": "저장 위치",
                     "x-editable": True},
        "encoding": {"type": "string", "enum": ["utf-8", "cp949"], "description": "File-name encoding. utf-8 "
                     "(default, sets the UTF-8 flag; Windows 10+/macOS) or cp949 for old Windows Explorer "
                     "(names that cp949 cannot hold stay UTF-8 with a warning)."},
        "conflict": {"type": "string", "enum": ["preserve_paths", "suffix"], "description": "Same file names: "
                     "preserve_paths (default) keeps their relative paths; suffix renames to name (2).ext."},
        "dedupe": {"type": "boolean", "description": "Keep only one of files with identical content (SHA-256); "
                   "the others are listed in deduped[] as {path, same_as}."},
        "idempotency_key": {"type": "string"},
    }},
    handler=files_zip, scope="mcp:write", risk="low",
    summarizer=lambda a: (a.get("zip_name") or a.get("query") or a.get("folder")
                          or f"파일 {len(a.get('paths') or [])}개"),
))

async def files_job_status(user: User, job_id: str, **_: object) -> dict:
    try:
        async with arts.session() as db:
            job = await arts.get_job(db, user, job_id)
            if job.kind == "files_zip":
                return await arts.zip_summary(db, job, True, with_job=False)
            out = await arts.job_view(db, job, True)
    except arts.ArtifactError as e:
        return _art_err(e)
    if out["zip"] and out["zip"]["download_url"]:
        out["download_url"] = out["zip"]["download_url"]
    return out


register(Tool(
    name="files_job_status",
    title="압축 작업 상태",
    description=("Progress and result of a large files_zip job: status running|done|partial|failed, progress "
                 "done/total, then the same result as files_zip {path, size, files, skipped, deduped, undo, "
                 "download_url} when finished."),
    parameters={"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"]},
    handler=files_job_status,
))

register(Tool(
    name="docs_job_status",
    title="결과물 작업 상태",
    description=("Progress and result of a docs_create_bundle / files_zip job: status running|done|partial|failed, "
                 "per-item status (failed items with reasons), and the zip download_url when finished."),
    parameters={"type": "object", "properties": {"job_id": {"type": "string"}}, "required": ["job_id"]},
    handler=docs_job_status,
))

register(Tool(
    name="artifacts_save_to_files",
    title="결과물을 내 파일에 저장",
    description=("Save a created file (artifact_id) or a whole job's files (job_id; for files_zip the zip) into "
                 "the user's files under 'AI 결과물/YYYY-MM-DD <conversation title>'. Never overwrites; uses the "
                 "user's storage quota."),
    parameters={"type": "object", "properties": {
        "artifact_id": {"type": "string", "x-label": "결과물"},
        "job_id": {"type": "string", "x-label": "묶음 작업"},
        "idempotency_key": {"type": "string"},
    }},
    handler=artifacts_save_to_files, scope="mcp:write", risk="low",
    summarizer=lambda a: "내 파일 › AI 결과물",
))
