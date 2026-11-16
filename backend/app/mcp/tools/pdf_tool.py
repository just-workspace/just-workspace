"""PDF 도구 — 정보·폼 필드 읽기(읽기) / 병합·분할·쪽 추출·회전·쪽 삭제·폼 채우기·워터마크(쓰기, low).

모든 쓰기 결과는 새 파일(원본 보존). 저장 규칙은 app.mcp.filetools.store(기본 "AI 결과물/날짜 대화 제목").
"""

from __future__ import annotations

import asyncio
import os

from app.db.models import User
from app.mcp.filetools import pdf_ops, store
from app.mcp.filetools.toolkit import DST_FOLDER_PARAM, OUTPUT_NAME_PARAM, RESULT_NOTE, base, guard
from app.mcp.server import Tool, register
from app.mcp.tools._common import path_shared, shared_target  # noqa: F401 — 타인에게 노출되는 쓰기 판정
from app.mcp.tools._common import err

PDF_MAX = 100 * 1024 * 1024
MERGE_MAX_FILES = 50
MERGE_MAX_TOTAL = 300 * 1024 * 1024
IMG_MAX = 20 * 1024 * 1024
_PDF = (".pdf",)

PAGES_HELP = "Pages, 1-based: \"3\", \"1-3\", \"5-\" (to end), \"-2\", comma-separated; \"all\" or empty = every page."


async def _read(user: User, path: str) -> bytes:
    data, _ = await store.read_input(user, path, max_bytes=PDF_MAX, exts=_PDF)
    return data


def _name(output_name: str, src: str, suffix: str) -> str:
    return store.with_ext(output_name, ".pdf") if output_name else store.derived_name(src, suffix, ".pdf")


async def _save_one(user, data: bytes, name: str, dst_folder: str, extra: dict | None = None) -> dict:
    out = await store.save_outputs(user, [store.OutFile(name, data, "application/pdf")], dst_folder=dst_folder)
    if extra:
        out.update(extra)
    return out


# ── 읽기 ──────────────────────────────────────────────────────
@guard
async def pdf_inspect(user: User, path: str, **_: object) -> dict:
    data = await _read(user, path)
    info = await asyncio.to_thread(pdf_ops.inspect, data)
    return {"path": (path or "").strip("/"), "size": len(data), **info}


# ── 쓰기 ──────────────────────────────────────────────────────
@guard
async def pdf_merge(user: User, paths: list, output_name: str = "", dst_folder: str = "", **_: object) -> dict:
    paths = [p for p in (paths or []) if isinstance(p, str) and p.strip()]
    if len(paths) < 2:
        return err("invalid_argument", "합칠 PDF 경로를 두 개 이상 주세요")
    if len(paths) > MERGE_MAX_FILES:
        return err("invalid_argument", f"한 번에 {MERGE_MAX_FILES}개까지 합칠 수 있습니다")
    datas, total = [], 0
    for p in paths:
        d = await _read(user, p)
        total += len(d)
        if total > MERGE_MAX_TOTAL:
            return err("too_large", f"합칠 파일 총량이 너무 큽니다(상한 {MERGE_MAX_TOTAL // 1024 // 1024}MB)")
        datas.append(d)
    out = await asyncio.to_thread(pdf_ops.merge, datas)
    return await _save_one(user, out, _name(output_name, paths[0], "합침"), dst_folder,
                           {"pages": await asyncio.to_thread(pdf_ops.page_count, out), "sources": len(paths)})


@guard
async def pdf_split(user: User, path: str, ranges: list | None = None, every: int = 0, dst_folder: str = "",
                    **_: object) -> dict:
    data = await _read(user, path)
    parts = await asyncio.to_thread(pdf_ops.split, data, ranges, int(every or 0))
    stem = os.path.splitext(base(path))[0]
    files = [store.OutFile(f"{stem} ({label}쪽).pdf", b, "application/pdf") for label, b in parts]
    out = await store.save_outputs(user, files, dst_folder=dst_folder, group_name=f"{stem} 나누기")
    out["parts"] = len(files)
    return out


@guard
async def pdf_extract_pages(user: User, path: str, pages: str, output_name: str = "", dst_folder: str = "",
                            **_: object) -> dict:
    data = await _read(user, path)
    out = await asyncio.to_thread(pdf_ops.extract, data, pages)
    return await _save_one(user, out, _name(output_name, path, f"{str(pages).replace(' ', '')}쪽"), dst_folder,
                           {"pages": await asyncio.to_thread(pdf_ops.page_count, out)})


@guard
async def pdf_rotate(user: User, path: str, angle: int = 90, pages: str = "", output_name: str = "",
                     dst_folder: str = "", **_: object) -> dict:
    data = await _read(user, path)
    out = await asyncio.to_thread(pdf_ops.rotate, data, angle, pages or None)
    return await _save_one(user, out, _name(output_name, path, "회전"), dst_folder)


@guard
async def pdf_delete_pages(user: User, path: str, pages: str, output_name: str = "", dst_folder: str = "",
                           **_: object) -> dict:
    data = await _read(user, path)
    out = await asyncio.to_thread(pdf_ops.delete_pages, data, pages)
    return await _save_one(user, out, _name(output_name, path, "쪽 삭제"), dst_folder,
                           {"pages": await asyncio.to_thread(pdf_ops.page_count, out)})


@guard
async def pdf_fill_form(user: User, path: str, values: dict, flatten: bool = False, output_name: str = "",
                        dst_folder: str = "", **_: object) -> dict:
    data = await _read(user, path)
    out, filled, missing = await asyncio.to_thread(pdf_ops.fill_form, data, values, bool(flatten))
    if not filled:
        return err("invalid_argument", "이름이 맞는 폼 칸이 없습니다 — pdf_inspect 로 칸 이름을 확인하세요",
                   unknown_fields=missing[:50])
    extra = {"filled": filled}
    if missing:
        extra["unknown_fields"] = missing[:50]
    return await _save_one(user, out, _name(output_name, path, "작성"), dst_folder, extra)


@guard
async def pdf_watermark(user: User, path: str, text: str = "", image_path: str = "", opacity: float = 0.15,
                        font_size: float = 0, angle: float = 45, color: str = "", scale: float = 0.5,
                        position: str = "center", pages: str = "", output_name: str = "", dst_folder: str = "",
                        **_: object) -> dict:
    data = await _read(user, path)
    img = None
    if image_path:
        img, _n = await store.read_input(user, image_path, max_bytes=IMG_MAX,
                                         exts=(".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"))
    out = await asyncio.to_thread(
        lambda: pdf_ops.watermark(data, text=text, image=img, opacity=opacity, font_size=font_size, angle=angle,
                                  color=color, scale=scale, position=position, pages=pages or None))
    return await _save_one(user, out, _name(output_name, path, "워터마크"), dst_folder)


# ── 카드 요약 ─────────────────────────────────────────────────
def _sum(label: str):
    def f(args: dict) -> str:
        src = args.get("paths") or args.get("path")
        if isinstance(src, list):
            src = " + ".join(base(p) for p in src[:4]) + (f" 외 {len(src) - 4}개" if len(src) > 4 else "")
        else:
            src = base(src)
        pages = args.get("pages")
        return f"{label} · {src}" + (f" · {pages}쪽" if pages else "")
    return f


_P = {"type": "string", "description": "Virtual path of the PDF.", "x-label": "PDF"}
_PAGES = {"type": "string", "description": PAGES_HELP, "x-label": "쪽", "x-editable": True}

register(Tool(
    name="pdf_inspect",
    title="PDF 정보 보기",
    description="Inspect a PDF: page count, page sizes/rotation, metadata and fillable form fields "
                "(name, type, current value, options). Use before pdf_fill_form or page operations.",
    parameters={"type": "object", "properties": {"path": _P}, "required": ["path"]},
    handler=pdf_inspect,
))

register(Tool(
    name="pdf_merge",
    title="PDF 합치기",
    description="Merge two or more PDFs, in the given order, into one new PDF." + RESULT_NOTE,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "paths": {"type": "array", "items": {"type": "string"}, "description": "PDF virtual paths in order.",
                  "x-label": "합칠 PDF"},
        "output_name": OUTPUT_NAME_PARAM, "dst_folder": DST_FOLDER_PARAM,
    }, "required": ["paths"]},
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 타인에게 노출되는 쓰기(외부 내용 읽기 이후에는 사용자 확인 요청)
    handler=pdf_merge, summarizer=_sum("PDF 합치기"),
))

register(Tool(
    name="pdf_split",
    title="PDF 나누기",
    description="Split a PDF into several new PDFs: by `ranges` (e.g. [\"1-3\", \"4-\"]) or every N pages "
                "(`every`); with neither, one file per page. The parts are saved together in a new folder."
                + RESULT_NOTE,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "path": _P,
        "ranges": {"type": "array", "items": {"type": "string"}, "description": "Page ranges, one per output file.",
                   "x-label": "나눌 범위", "x-editable": True},
        "every": {"type": "integer", "default": 0, "description": "Pages per part (when ranges is empty).",
                  "x-label": "몇 쪽씩", "x-editable": True},
        "dst_folder": DST_FOLDER_PARAM,
    }, "required": ["path"]},
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 타인에게 노출되는 쓰기(외부 내용 읽기 이후에는 사용자 확인 요청)
    handler=pdf_split, summarizer=_sum("PDF 나누기"),
))

register(Tool(
    name="pdf_extract_pages",
    title="PDF 쪽 뽑기",
    description="Copy selected pages (in the given order) of a PDF into a new PDF." + RESULT_NOTE,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "path": _P, "pages": _PAGES, "output_name": OUTPUT_NAME_PARAM, "dst_folder": DST_FOLDER_PARAM,
    }, "required": ["path", "pages"]},
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 타인에게 노출되는 쓰기(외부 내용 읽기 이후에는 사용자 확인 요청)
    handler=pdf_extract_pages, summarizer=_sum("PDF 쪽 뽑기"),
))

register(Tool(
    name="pdf_rotate",
    title="PDF 쪽 돌리기",
    description="Rotate pages of a PDF clockwise by 90/180/270 degrees (-90 = counter-clockwise)." + RESULT_NOTE,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "path": _P,
        "angle": {"type": "integer", "enum": [90, 180, 270, -90], "default": 90, "description": "Degrees clockwise.",
                  "x-label": "각도", "x-editable": True},
        "pages": {**_PAGES, "default": ""},
        "output_name": OUTPUT_NAME_PARAM, "dst_folder": DST_FOLDER_PARAM,
    }, "required": ["path"]},
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 타인에게 노출되는 쓰기(외부 내용 읽기 이후에는 사용자 확인 요청)
    handler=pdf_rotate, summarizer=_sum("PDF 쪽 돌리기"),
))

register(Tool(
    name="pdf_delete_pages",
    title="PDF 쪽 지우기",
    description="Make a copy of a PDF without the given pages (the original file is kept unchanged)." + RESULT_NOTE,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "path": _P, "pages": _PAGES, "output_name": OUTPUT_NAME_PARAM, "dst_folder": DST_FOLDER_PARAM,
    }, "required": ["path", "pages"]},
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 타인에게 노출되는 쓰기(외부 내용 읽기 이후에는 사용자 확인 요청)
    handler=pdf_delete_pages, summarizer=_sum("PDF 쪽 지우기"),
))

register(Tool(
    name="pdf_fill_form",
    title="PDF 서식 채우기",
    description="Fill the form fields of a PDF form ({field name: value}; checkboxes take true/false). Get the "
                "field names with pdf_inspect first. `flatten=true` bakes the values in (no longer editable)."
                + RESULT_NOTE,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "path": _P,
        "values": {"type": "object", "description": "Field name → value.", "x-label": "입력값", "x-editable": True},
        "flatten": {"type": "boolean", "default": False, "description": "Bake values into the page.",
                    "x-label": "고정(편집 불가)", "x-editable": True},
        "output_name": OUTPUT_NAME_PARAM, "dst_folder": DST_FOLDER_PARAM,
    }, "required": ["path", "values"]},
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 타인에게 노출되는 쓰기(외부 내용 읽기 이후에는 사용자 확인 요청)
    handler=pdf_fill_form, summarizer=_sum("PDF 서식 채우기"),
))

register(Tool(
    name="pdf_watermark",
    title="PDF 워터마크",
    description="Stamp a text watermark (Korean OK, diagonal by default) or an image watermark (`image_path`, "
                "e.g. a logo PNG) on PDF pages." + RESULT_NOTE,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "path": _P,
        "text": {"type": "string", "default": "", "description": "Watermark text (≤200 chars, \\n for lines).",
                 "x-label": "워터마크 글자", "x-editable": True},
        "image_path": {"type": "string", "default": "", "description": "Virtual path of a PNG/JPG image instead of text.",
                       "x-label": "워터마크 이미지"},
        "opacity": {"type": "number", "default": 0.15, "description": "0.02-1.", "x-label": "불투명도", "x-editable": True},
        "font_size": {"type": "number", "default": 0, "description": "Text size in pt; 0 = fit the page."},
        "angle": {"type": "number", "default": 45, "description": "Text angle in degrees."},
        "color": {"type": "string", "default": "", "description": "Text colour as hex, e.g. \"#cc0000\" (default grey)."},
        "scale": {"type": "number", "default": 0.5, "description": "Image width as a fraction of the page width."},
        "position": {"type": "string", "enum": ["center", "top-left", "top-right", "bottom-left", "bottom-right"],
                     "default": "center", "description": "Image position."},
        "pages": {**_PAGES, "default": ""},
        "output_name": OUTPUT_NAME_PARAM, "dst_folder": DST_FOLDER_PARAM,
    }, "required": ["path"]},
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 타인에게 노출되는 쓰기(외부 내용 읽기 이후에는 사용자 확인 요청)
    handler=pdf_watermark, summarizer=_sum("PDF 워터마크"),
))
