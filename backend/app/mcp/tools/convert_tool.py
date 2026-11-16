"""files_convert — 형식 변환(쓰기, low). 결과는 새 파일.

간단 변환은 백엔드 내부에서 수행(라이브러리): xlsx→csv, csv→xlsx, md/txt→docx(pandoc), md/txt→pdf(reportlab),
이미지(여러 장)→pdf(Pillow). 그 외 오피스·한글(hwp·hwpx) 문서 변환은 ws-docconv(LibreOffice + H2Orestart).
"""

from __future__ import annotations

import asyncio
import os

from app.db.models import User
from app.mcp.filetools import containers, convert_ops, store
from app.mcp.filetools.toolkit import DST_FOLDER_PARAM, OUTPUT_NAME_PARAM, RESULT_NOTE, base, guard
from app.mcp.server import Tool, register
from app.mcp.tools._common import path_shared, shared_target  # noqa: F401 — 타인 노출 쓰기 판정
from app.mcp.tools._common import err

CONVERT_MAX = 100 * 1024 * 1024
IMAGES_MAX_TOTAL = 200 * 1024 * 1024
TARGETS = ("pdf", "docx", "odt", "xlsx", "ods", "csv", "pptx", "odp")


def supported_summary() -> str:
    return ("xlsx→csv · csv/tsv→xlsx · md/txt→docx · md/txt→pdf · images (png/jpg/gif/webp/bmp/tiff, several)→pdf · "
            "doc/docx/odt/rtf/hwp/hwpx→pdf/docx/odt · xls/xlsx/ods/csv→pdf/xlsx/ods · ppt/pptx/odp→pdf/pptx/odp")


@guard
async def files_convert(user: User, to: str, path: str = "", paths: list | None = None, sheet: str = "",
                        all_sheets: bool = False, output_name: str = "", dst_folder: str = "", **_: object) -> dict:
    target = str(to or "").lower().lstrip(".")
    if target not in TARGETS:
        return err("invalid_argument", f"to 는 {', '.join(TARGETS)} 중 하나입니다")
    srcs = [p for p in (paths or []) if isinstance(p, str) and p.strip()] or ([path] if path else [])
    if not srcs:
        return err("invalid_argument", "path(또는 이미지 여러 장이면 paths)가 필요합니다")
    exts = [os.path.splitext(p)[1].lower() for p in srcs]

    # 이미지 → pdf (여러 장이면 하나의 PDF 로 병합)
    if target == "pdf" and all(e in convert_ops.IMAGE_EXTS for e in exts):
        if len(srcs) > convert_ops.MAX_IMAGES:
            return err("invalid_argument", f"이미지는 {convert_ops.MAX_IMAGES}장까지입니다")
        datas, total = [], 0
        for p in srcs:
            d, _n = await store.read_input(user, p, max_bytes=50 * 1024 * 1024, exts=convert_ops.IMAGE_EXTS)
            total += len(d)
            if total > IMAGES_MAX_TOTAL:
                return err("too_large", "이미지 총량이 너무 큽니다")
            datas.append(d)
        out = await asyncio.to_thread(convert_ops.images_to_pdf, datas)
        name = store.with_ext(output_name, ".pdf") if output_name else store.derived_name(srcs[0], "PDF", ".pdf")
        res = await store.save_outputs(user, [store.OutFile(name, out, "application/pdf")], dst_folder=dst_folder)
        res.update(engine="library", images=len(srcs))
        return res
    if len(srcs) > 1:
        return err("invalid_argument", "여러 파일은 이미지 → PDF 만 한 번에 됩니다. 문서는 하나씩 바꾸세요")

    src, ext = srcs[0], exts[0]
    if ext == "." + target:
        return err("invalid_argument", "이미 그 형식입니다")
    data, _n = await store.read_input(user, src, max_bytes=CONVERT_MAX)
    stem = os.path.splitext(base(src))[0]
    local = convert_ops.LOCAL.get((ext, target))
    outputs: list[store.OutFile] = []
    engine = "library"
    if local == "xlsx_csv":
        sheets = await asyncio.to_thread(convert_ops.xlsx_to_csv, data, sheet, bool(all_sheets))
        if len(sheets) == 1:
            name = store.with_ext(output_name, ".csv") if output_name else f"{stem}.csv"
            outputs = [store.OutFile(name, sheets[0][1], "text/csv")]
        else:
            outputs = [store.OutFile(f"{stem} - {store.clean_name(sh)}.csv", b, "text/csv") for sh, b in sheets]
    elif local == "csv_xlsx":
        out = await asyncio.to_thread(convert_ops.csv_to_xlsx, data, ext, stem)
        outputs = [store.OutFile(store.with_ext(output_name, ".xlsx") if output_name else f"{stem}.xlsx", out)]
    elif local == "md_docx":
        out = await asyncio.to_thread(convert_ops.md_to_docx, data, ext == ".txt")
        outputs = [store.OutFile(store.with_ext(output_name, ".docx") if output_name else f"{stem}.docx", out)]
    elif local in ("md_pdf", "txt_pdf"):
        fn = convert_ops.md_to_pdf if local == "md_pdf" else convert_ops.txt_to_pdf
        out = await asyncio.to_thread(fn, data, stem)
        outputs = [store.OutFile(store.with_ext(output_name, ".pdf") if output_name else f"{stem}.pdf", out)]
    else:
        fam = containers.docconv_family(ext)
        if fam is None or target not in containers.DOCCONV_TARGETS[fam]:
            return err("unsupported", f"{ext or '확장자 없음'} → {target} 변환은 지원하지 않습니다. 지원: {supported_summary()}")
        out = await containers.docconv_convert(data, ext, target)
        engine = "docconv"
        outputs = [store.OutFile(store.with_ext(output_name, "." + target) if output_name else f"{stem}.{target}", out)]
    for o in outputs:
        o.mime = o.mime or store.mime_for(o.name)
    res = await store.save_outputs(user, outputs, dst_folder=dst_folder,
                                   group_name=f"{stem} 변환" if len(outputs) > 1 else "")
    res["engine"] = engine
    return res


def _sum(args: dict) -> str:
    src = args.get("paths") or args.get("path")
    if isinstance(src, list):
        src = f"{base(src[0])} 외 {len(src) - 1}개" if len(src) > 1 else base(src[0] if src else "")
    else:
        src = base(src)
    return f"형식 변경 · {src} → {str(args.get('to') or '').upper()}"


register(Tool(
    name="files_convert",
    title="파일 형식 변경",
    description=(
        "Convert a file to another format and save the result as a new file. Supported: " + supported_summary()
        + ". Korean HWP/HWPX documents can be turned into PDF/DOCX. For xlsx→csv pick `sheet` or "
        "`all_sheets=true` (one csv per sheet). Several images → one PDF via `paths`." + RESULT_NOTE
    ),
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "path": {"type": "string", "default": "", "description": "Virtual path of the source file.", "x-label": "원본"},
        "paths": {"type": "array", "items": {"type": "string"}, "description": "Several images (in page order) → one PDF.",
                  "x-label": "원본(여러 장)"},
        "to": {"type": "string", "enum": list(TARGETS), "description": "Target format.", "x-label": "바꿀 형식",
               "x-editable": True},
        "sheet": {"type": "string", "default": "", "description": "xlsx→csv: sheet name (default first sheet)."},
        "all_sheets": {"type": "boolean", "default": False, "description": "xlsx→csv: one csv per sheet."},
        "output_name": OUTPUT_NAME_PARAM, "dst_folder": DST_FOLDER_PARAM,
    }, "required": ["to"]},
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 타인 노출 쓰기(외부 내용을 읽은 뒤에는 확인을 요청한다)
    handler=files_convert, summarizer=_sum,
))
