"""Office 편집 도구 — docx_edit · xlsx_edit · pptx_edit (쓰기).

기본은 원본 보존(새 이름 "원본 (수정).docx" 로 저장, 위험도 low). ``overwrite=true`` 면 원본을 덮어쓰며
위험도 high — 승인 대기함을 거친다(writes.tool_risk 가 tool.risk_for 로 판정). 덮어쓰기 시 이전본은 버전 기록에 보존.
"""

from __future__ import annotations

import asyncio

from app.db.models import User
from app.mcp.filetools import office_ops, store
from app.mcp.filetools.toolkit import DST_FOLDER_PARAM, OUTPUT_NAME_PARAM, base, guard, risk_overwrite
from app.mcp.server import Tool, register
from app.mcp.tools._common import path_shared, shared_target  # noqa: F401 — 타인에게 노출되는 쓰기 판정

OFFICE_MAX = 50 * 1024 * 1024


async def _edit(user: User, path: str, ext: str, fn, operations, overwrite: bool, output_name: str,
                dst_folder: str) -> dict:
    data, _name = await store.read_input(user, path, max_bytes=OFFICE_MAX, exts=(ext,))
    out, info = await asyncio.to_thread(fn, data, operations)
    mime = store.mime_for("x" + ext)
    if overwrite is True or str(overwrite).lower() in ("true", "1", "yes"):
        res = await store.overwrite(user, path, out, mime)
    else:
        name = store.with_ext(output_name, ext) if output_name else store.derived_name(path, "수정", ext)
        res = await store.save_outputs(user, [store.OutFile(name, out, mime)], dst_folder=dst_folder)
    res.update(info)
    return res


@guard
async def docx_edit(user: User, path: str, operations: list, overwrite: bool = False, output_name: str = "",
                    dst_folder: str = "", **_: object) -> dict:
    return await _edit(user, path, ".docx", office_ops.edit_docx, operations, overwrite, output_name, dst_folder)


@guard
async def xlsx_edit(user: User, path: str, operations: list, overwrite: bool = False, output_name: str = "",
                    dst_folder: str = "", **_: object) -> dict:
    return await _edit(user, path, ".xlsx", office_ops.edit_xlsx, operations, overwrite, output_name, dst_folder)


@guard
async def pptx_edit(user: User, path: str, operations: list, overwrite: bool = False, output_name: str = "",
                    dst_folder: str = "", **_: object) -> dict:
    return await _edit(user, path, ".pptx", office_ops.edit_pptx, operations, overwrite, output_name, dst_folder)


def _sum(label: str):
    def f(args: dict) -> str:
        ops = args.get("operations") or []
        n = len(ops) if isinstance(ops, list) else 1
        mode = "원본 덮어쓰기" if risk_overwrite(args) == "high" else "새 파일로 저장"
        return f"{label} · {base(args.get('path'))} · 작업 {n}개 · {mode}"
    return f


def _prev(args: dict) -> list[dict]:
    rows = [{"field": "path", "label": "파일", "before": None, "after": base(args.get("path"))}]
    ops = args.get("operations") or []
    for o in (ops if isinstance(ops, list) else [ops])[:20]:
        if not isinstance(o, dict):
            continue
        op = o.get("op")
        if op == "replace":
            rows.append({"field": "operations", "label": "바꾸기", "before": o.get("find"), "after": o.get("replace")})
        else:
            desc = {k: v for k, v in o.items() if k != "op"}
            txt = str(desc)
            rows.append({"field": "operations", "label": str(op), "before": None,
                         "after": txt if len(txt) <= 400 else txt[:400] + "…"})
    rows.append({"field": "overwrite", "label": "저장", "before": None,
                 "after": "원본 덮어쓰기(이전본은 버전 기록)" if risk_overwrite(args) == "high" else "새 파일(원본 보존)"})
    return rows


_OVERWRITE = {"type": "boolean", "default": False,
              "description": "true = overwrite the original file (HIGH risk: needs the user's approval in the "
                             "workspace approval inbox; the previous version is kept in version history). "
                             "Default false = save as a new file and keep the original.",
              "x-label": "원본 덮어쓰기"}
_COMMON = {"overwrite": _OVERWRITE, "output_name": OUTPUT_NAME_PARAM, "dst_folder": DST_FOLDER_PARAM}

_DOCX_OPS = (
    "Operations, applied in order: "
    "{op:'replace', find, replace, match_case?=true} — find & replace everywhere (body, tables, headers/footers; "
    "keeps formatting, works across formatting runs); "
    "{op:'append_paragraph', text, style?, heading?:0-9, after_heading?} — add a paragraph (heading level → "
    "Heading N style); `after_heading` = put it at the end of that heading's section (keeps the outline), "
    "otherwise at the end of the document; "
    "{op:'add_heading', text, level, after_heading?}; "
    "{op:'append_table', rows:[[...]], header?=true, style?='Table Grid', after_heading?}. "
    "The result includes the document outline (headings) for checking."
)
_XLSX_OPS = (
    "Operations, applied in order: "
    "{op:'set_cells', sheet?, cells:{'A1': value, 'B2': '=SUM(B3:B9)'}} — values or formulas (start with '='); "
    "{op:'set_range', sheet?, start:'A1', rows:[[...]]}; "
    "{op:'add_sheet', name, rows?:[[...]], index?}; "
    "{op:'chart', sheet?, type:'bar'|'col'|'line'|'pie'|'scatter', data:'B1:C10' (first row = series names), "
    "categories?:'A2:A10', title?, x_title?, y_title?, anchor?:'E2'}. "
    "Omitted sheet = the active sheet. External links / WEBSERVICE-type formulas are refused. "
    "Note: existing charts/images in the workbook may not survive editing (a warning is returned)."
)
_PPTX_OPS = (
    "Operations, applied in order: "
    "{op:'replace', find, replace, match_case?=true} — in all slides, tables and notes, keeping formatting; "
    "{op:'add_slide', title, bullets?:[text | {text, level}], notes?, layout?:index|name, position?:1-based}; "
    "{op:'set_text', slide:1-based, shape:'title'|'body'|'notes'|index|shape name, text} — replace one text box. "
    "The result lists the slide titles."
)


def _schema(path_desc: str, ops_desc: str) -> dict:
    return {"type": "object", "properties": {
        "path": {"type": "string", "description": path_desc, "x-label": "파일"},
        "operations": {"type": "array", "items": {"type": "object"}, "description": ops_desc,
                       "x-label": "작업", "x-editable": True},
        **_COMMON,
    }, "required": ["path", "operations"]}


for _name, _title, _fn, _desc, _ops, _label in (
    ("docx_edit", "Word 문서 고치기", docx_edit,
     "Edit a Word (.docx) document: find & replace text, add paragraphs/headings/tables (optionally inside a "
     "given heading's section so the heading structure stays intact).", _DOCX_OPS, "Word 고치기"),
    ("xlsx_edit", "Excel 고치기", xlsx_edit,
     "Edit an Excel (.xlsx) workbook: write cells/ranges and formulas, add sheets, add simple charts.",
     _XLSX_OPS, "Excel 고치기"),
    ("pptx_edit", "PowerPoint 고치기", pptx_edit,
     "Edit a PowerPoint (.pptx) deck: add slides (title, bullets, notes), replace wording, set a text box.",
     _PPTX_OPS, "PowerPoint 고치기"),
):
    _t = Tool(
        name=_name, title=_title,
        description=_desc + " By default saves a NEW file next to your results and keeps the original; "
                    "returns `{path, name, size, mime}`. Use `overwrite=true` only when the user explicitly asks "
                    "to change the original.",
        scope="mcp:write", risk="low",
        parameters=_schema(f"Virtual path of the {_name.split('_')[0]} file.", _ops),
        handler=_fn, summarizer=_sum(_label), previewer=_prev,
    )
    _t.risk_for = risk_overwrite      # 덮어쓰기 시 high (writes.tool_risk)
    # 저장 폴더가 공유 영역이거나 공유 영역의 원본을 덮어쓰면 타인에게 노출되는 쓰기
    _t.visible_for = lambda a, u=None: (path_shared(a.get("dst_folder"), u)
                                        or (bool(a.get("overwrite")) and path_shared(a.get("path"), u)))
    register(_t)
