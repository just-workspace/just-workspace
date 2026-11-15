"""결과물 — 구조화 입력으로 문서를 만든다(docx·xlsx·pptx·pdf). DB·네트워크 없는 순수 함수.

입력(도구 인자와 같은 모양):
  공통   title(제목) · filename(확장자 없이, 선택) · subtitle(선택)
  docx·pdf  blocks: [{type: heading|paragraph|list|table|page_break, text, level, items, ordered, header, rows}]
  xlsx      sheets: [{name, header, rows}]  — 셀 값은 글자·숫자·참거짓·빈값, 또는 {"formula": "=SUM(B2:B5)"}
  pptx      slides: [{title, bullets, notes, table: {header, rows}}]  — 첫 장은 제목·부제로 자동

* 글자 안의 XML 금지 문자(제어 문자·짝 없는 서로게이트)는 지운다 — 남기면 Office 가 파일을 못 연다.
* 엑셀 수식은 허용 목록 함수만, 외부 참조·DDE(`[`, `|`, `\\`)는 거절. "=" 로 시작하는 일반 글자는 글자 그대로 둔다
  (메일 본문에서 온 글자가 수식으로 실행되는 수식 주입 방지).
* 만든 문서 메타데이터에 "AI 생성"을 남긴다(AI 기본법 표시).
"""

from __future__ import annotations

import io
import json
import re
from dataclasses import dataclass

FORMATS: dict[str, dict] = {
    "docx": {"mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "label": "Word 문서"},
    "xlsx": {"mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "label": "Excel 통합 문서"},
    "pptx": {"mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "label": "PowerPoint 발표"},
    "pdf": {"mime": "application/pdf", "label": "PDF 문서"},
}

MAX_SPEC_CHARS = 2_000_000      # 문서 하나 입력 상한(JSON 글자)
MAX_TEXT = 20_000               # 칸 하나 글자
MAX_BLOCKS = 2_000
MAX_TABLE_ROWS = 1_000
MAX_TABLE_COLS = 30
MAX_SHEETS = 20
MAX_SHEET_ROWS = 10_000
MAX_SHEET_COLS = 50
MAX_SLIDES = 100
MAX_BULLETS = 20
AI_MARK = "AI 생성 문서 — 내용을 확인한 뒤 쓰세요"

_BAD_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿\ud800-\udfff]")
_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_SHEET_BAD = re.compile(r"[\[\]:*?/\\]")

FORMULA_FUNCS = frozenset({
    "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "COUNTBLANK", "COUNTIF", "COUNTIFS", "SUMIF", "SUMIFS",
    "AVERAGEIF", "AVERAGEIFS", "ROUND", "ROUNDUP", "ROUNDDOWN", "ABS", "IF", "IFS", "IFERROR", "AND", "OR", "NOT",
    "LEN", "LEFT", "RIGHT", "MID", "UPPER", "LOWER", "TRIM", "CONCAT", "CONCATENATE", "TEXT", "VALUE",
    "TODAY", "NOW", "DATE", "YEAR", "MONTH", "DAY", "MEDIAN", "STDEV", "PRODUCT", "MOD", "INT", "RANK", "SUMPRODUCT",
    "VLOOKUP", "HLOOKUP", "XLOOKUP", "INDEX", "MATCH", "LARGE", "SMALL", "PERCENTILE",
})
_FUNC_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_.]*)\s*\(")


class SpecError(ValueError):
    """입력이 잘못됨 — 모델이 고쳐 다시 부를 수 있다(invalid_argument)."""

    def __init__(self, message: str, code: str = "invalid_argument"):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Built:
    data: bytes
    info: dict          # {"pages"|"sheets"|"slides": n}


# ── 정리 도우미 ───────────────────────────────────────────────
def clean_text(v, limit: int = MAX_TEXT) -> str:
    if v is None:
        return ""
    s = v if isinstance(v, str) else str(v)
    return _BAD_XML.sub("", s)[:limit]


def safe_filename(name: str, fmt: str, fallback: str = "문서") -> str:
    """사람이 읽는 파일 이름 + 강제 확장자. 경로 구분자·예약 문자·앞쪽 점은 지운다."""
    base = clean_text(name or "", 200).strip()
    if base.lower().endswith("." + fmt):
        base = base[: -(len(fmt) + 1)]
    base = _BAD_NAME.sub(" ", base).strip().strip(".").strip()
    base = re.sub(r"\s+", " ", base)[:120] or fallback
    return f"{base}.{fmt}"


def _rows(raw, max_rows: int, max_cols: int, cell=None) -> list[list]:
    if raw in (None, ""):
        return []
    if not isinstance(raw, list):
        raise SpecError("rows 는 행의 배열이어야 합니다")
    if len(raw) > max_rows:
        raise SpecError(f"행이 너무 많습니다({len(raw)}행, 상한 {max_rows})", "too_large")
    out = []
    for r in raw:
        if not isinstance(r, list):
            r = [r]
        if len(r) > max_cols:
            raise SpecError(f"열이 너무 많습니다({len(r)}열, 상한 {max_cols})", "too_large")
        out.append([(cell or (lambda x: clean_text(x, 2000)))(c) for c in r])
    return out


def _cell_value(v):
    """엑셀 칸 값 — 숫자·참거짓은 그대로, 수식 객체는 검사, 나머지는 글자."""
    if v is None or isinstance(v, (bool, int, float)):
        if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
            return None
        return v
    if isinstance(v, dict):
        f = v.get("formula")
        if f is None:
            return clean_text(json.dumps(v, ensure_ascii=False), 2000)
        return {"formula": check_formula(f)}
    return clean_text(v, 32_000)


def check_formula(f) -> str:
    s = clean_text(f, 2000).strip()
    if not s.startswith("="):
        s = "=" + s
    if any(ch in s for ch in "[]|\\{}") or "://" in s:
        raise SpecError(f"허용하지 않는 수식입니다(외부 참조·DDE): {s[:80]}")
    for fn in _FUNC_RE.findall(s):
        if fn.upper() not in FORMULA_FUNCS:
            raise SpecError(f"허용하지 않는 함수입니다: {fn} (쓸 수 있는 함수: SUM·AVERAGE·IF·VLOOKUP 등 계산 함수)")
    return s


def _blocks(raw) -> list[dict]:
    if raw in (None, ""):
        return []
    if not isinstance(raw, list):
        raise SpecError("blocks 는 배열이어야 합니다")
    if len(raw) > MAX_BLOCKS:
        raise SpecError(f"블록이 너무 많습니다(상한 {MAX_BLOCKS})", "too_large")
    out: list[dict] = []
    for b in raw:
        if isinstance(b, str):
            b = {"type": "paragraph", "text": b}
        if not isinstance(b, dict):
            continue
        t = str(b.get("type") or "paragraph").lower()
        if t in ("h", "heading", "title"):
            lvl = b.get("level", 1)
            try:
                lvl = max(1, min(3, int(lvl)))
            except (TypeError, ValueError):
                lvl = 1
            out.append({"type": "heading", "text": clean_text(b.get("text"), 500), "level": lvl})
        elif t in ("list", "bullets", "ul", "ol"):
            items = b.get("items") or []
            if not isinstance(items, list):
                items = [items]
            out.append({"type": "list", "ordered": bool(b.get("ordered") or t == "ol"),
                        "items": [clean_text(x, 4000) for x in items[:500]]})
        elif t == "table":
            out.append({"type": "table", "header": [clean_text(x, 500) for x in (b.get("header") or [])][:MAX_TABLE_COLS],
                        "rows": _rows(b.get("rows"), MAX_TABLE_ROWS, MAX_TABLE_COLS)})
        elif t in ("page_break", "pagebreak", "break"):
            out.append({"type": "page_break"})
        else:
            out.append({"type": "paragraph", "text": clean_text(b.get("text"))})
    return out


def _sheets(raw) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise SpecError("xlsx 는 sheets 가 하나 이상 있어야 합니다")
    if len(raw) > MAX_SHEETS:
        raise SpecError(f"시트가 너무 많습니다(상한 {MAX_SHEETS})", "too_large")
    out, used = [], set()
    for i, s in enumerate(raw):
        if not isinstance(s, dict):
            raise SpecError("시트는 {name, header, rows} 객체여야 합니다")
        name = _SHEET_BAD.sub(" ", clean_text(s.get("name") or f"Sheet{i + 1}", 31)).strip().strip("'")[:31] or f"Sheet{i + 1}"
        base, n = name, 2
        while name.lower() in used:
            suffix = f" ({n})"
            name = base[: 31 - len(suffix)] + suffix
            n += 1
        used.add(name.lower())
        out.append({"name": name,
                    "header": [clean_text(x, 500) for x in (s.get("header") or [])][:MAX_SHEET_COLS],
                    "rows": _rows(s.get("rows"), MAX_SHEET_ROWS, MAX_SHEET_COLS, _cell_value)})
    return out


def _slides(raw) -> list[dict]:
    if raw in (None, ""):
        raw = []
    if not isinstance(raw, list):
        raise SpecError("slides 는 배열이어야 합니다")
    if len(raw) > MAX_SLIDES:
        raise SpecError(f"슬라이드가 너무 많습니다(상한 {MAX_SLIDES})", "too_large")
    out = []
    for s in raw:
        if isinstance(s, str):
            s = {"title": s}
        if not isinstance(s, dict):
            continue
        bullets = []
        for b in (s.get("bullets") or [])[:MAX_BULLETS]:
            if isinstance(b, dict):
                try:
                    lvl = max(0, min(4, int(b.get("level") or 0)))
                except (TypeError, ValueError):
                    lvl = 0
                bullets.append({"text": clean_text(b.get("text"), 1000), "level": lvl})
            else:
                bullets.append({"text": clean_text(b, 1000), "level": 0})
        tbl = s.get("table") if isinstance(s.get("table"), dict) else None
        out.append({
            "title": clean_text(s.get("title"), 300),
            "bullets": bullets,
            "notes": clean_text(s.get("notes"), 5000),
            "table": ({"header": [clean_text(x, 200) for x in (tbl.get("header") or [])][:12],
                       "rows": _rows(tbl.get("rows"), 30, 12)} if tbl else None),
        })
    return out


def normalize(fmt: str, spec: dict) -> dict:
    """도구 인자 → 검사·정리된 입력. 잘못되면 SpecError."""
    fmt = str(fmt or "").lower().lstrip(".")
    if fmt not in FORMATS:
        raise SpecError(f"format 은 {', '.join(FORMATS)} 중 하나여야 합니다(HWP 는 아직 만들 수 없습니다)", "unsupported"
                        if fmt in ("hwp", "hwpx") else "invalid_argument")
    if not isinstance(spec, dict):
        raise SpecError("입력이 객체가 아닙니다")
    try:
        size = len(json.dumps(spec, ensure_ascii=False, default=str))
    except Exception:  # noqa: BLE001
        raise SpecError("입력을 읽을 수 없습니다")
    if size > MAX_SPEC_CHARS:
        raise SpecError(f"내용이 너무 깁니다({size:,}자, 상한 {MAX_SPEC_CHARS:,}자) — 나눠서 만드세요", "too_large")
    title = clean_text(spec.get("title"), 300).strip()
    out = {"format": fmt, "title": title, "subtitle": clean_text(spec.get("subtitle"), 300).strip(),
           "filename": safe_filename(spec.get("filename") or title, fmt)}
    if fmt in ("docx", "pdf"):
        out["blocks"] = _blocks(spec.get("blocks"))
        if not out["blocks"] and not title:
            raise SpecError("blocks 가 비었습니다 — 제목·문단·표를 넣으세요")
    elif fmt == "xlsx":
        out["sheets"] = _sheets(spec.get("sheets"))
    else:
        out["slides"] = _slides(spec.get("slides"))
        if not out["slides"] and not title:
            raise SpecError("slides 가 비었습니다")
    return out


# ── 만들기 ────────────────────────────────────────────────────
def build(spec: dict) -> Built:
    """정리된 입력(normalize 결과) → 파일 바이트."""
    fmt = spec["format"]
    return {"docx": _docx, "xlsx": _xlsx, "pptx": _pptx, "pdf": _pdf}[fmt](spec)


def _docx(spec: dict) -> Built:
    from docx import Document
    from docx.oxml.ns import qn
    from docx.shared import Pt

    doc = Document()
    st = doc.styles["Normal"]
    st.font.name = "맑은 고딕"
    st.font.size = Pt(10.5)
    rpr = st.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), "맑은 고딕")
    cp = doc.core_properties
    cp.title = spec.get("title") or ""
    cp.subject = spec.get("subtitle") or ""
    cp.comments = AI_MARK
    cp.keywords = "AI 생성"
    cp.author = "Just Workspace AI"

    chars = 0
    breaks = 0
    rows = 0
    if spec.get("title"):
        doc.add_heading(spec["title"], 0)
    if spec.get("subtitle"):
        doc.add_paragraph(spec["subtitle"]).italic = True
    for b in spec.get("blocks") or []:
        t = b["type"]
        if t == "heading":
            doc.add_heading(b["text"], b["level"])
            chars += len(b["text"]) + 40
        elif t == "paragraph":
            p = doc.add_paragraph()
            lines = b["text"].split("\n")
            for i, line in enumerate(lines):
                run = p.add_run(line)
                if i < len(lines) - 1:
                    run.add_break()
            chars += len(b["text"]) + 60
        elif t == "list":
            style = "List Number" if b["ordered"] else "List Bullet"
            for it in b["items"]:
                doc.add_paragraph(it, style=style)
                chars += len(it) + 60
        elif t == "table":
            header, body = b["header"], b["rows"]
            ncols = max([len(header)] + [len(r) for r in body] + [1])
            table = doc.add_table(rows=0, cols=ncols)
            table.style = "Table Grid"
            if header:
                cells = table.add_row().cells
                for i, h in enumerate(header):
                    cells[i].text = ""
                    cells[i].paragraphs[0].add_run(h).bold = True
            for r in body:
                cells = table.add_row().cells
                for i, v in enumerate(r):
                    cells[i].text = v
            rows += len(body) + (1 if header else 0)
            doc.add_paragraph()
        elif t == "page_break":
            doc.add_page_break()
            breaks += 1
    buf = io.BytesIO()
    doc.save(buf)
    pages = 1 + breaks + chars // 1800 + rows // 35
    return Built(buf.getvalue(), {"pages": pages})


def _col_width(values) -> float:
    w = 8
    for v in values:
        s = "" if v is None else (v["formula"] if isinstance(v, dict) else str(v))
        s = s.split("\n")[0]
        n = sum(2 if ord(ch) > 0x2E7F else 1 for ch in s[:80])
        w = max(w, n + 2)
    return min(w, 60)


def _xlsx(spec: dict) -> Built:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    wb.remove(wb.active)
    wb.properties.title = spec.get("title") or ""
    wb.properties.subject = spec.get("subtitle") or ""
    wb.properties.description = AI_MARK
    wb.properties.keywords = "AI 생성"
    wb.properties.creator = "Just Workspace AI"
    bold = Font(bold=True)
    fill = PatternFill("solid", fgColor="E8EEF8")
    for s in spec["sheets"]:
        ws = wb.create_sheet(s["name"])
        r0 = 1
        if s["header"]:
            for c, h in enumerate(s["header"], 1):
                cell = ws.cell(row=1, column=c, value=h)
                cell.font = bold
                cell.fill = fill
                if isinstance(h, str) and h[:1] in ("=", "+", "-", "@"):
                    cell.data_type = "s"
            ws.freeze_panes = "A2"
            r0 = 2
        for ri, row in enumerate(s["rows"]):
            for ci, v in enumerate(row, 1):
                cell = ws.cell(row=r0 + ri, column=ci)
                if isinstance(v, dict):
                    cell.value = v["formula"]           # 검사한 수식만
                else:
                    cell.value = v
                    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@"):
                        cell.data_type = "s"           # 글자 그대로(수식 주입 방지)
        ncols = max([len(s["header"])] + [len(r) for r in s["rows"][:2000]] + [0])
        for ci in range(1, ncols + 1):
            vals = ([s["header"][ci - 1]] if ci <= len(s["header"]) else []) + \
                   [r[ci - 1] for r in s["rows"][:500] if ci <= len(r)]
            ws.column_dimensions[get_column_letter(ci)].width = _col_width(vals)
    buf = io.BytesIO()
    wb.save(buf)
    return Built(buf.getvalue(), {"sheets": len(spec["sheets"])})


def _pptx(spec: dict) -> Built:
    from pptx import Presentation
    from pptx.util import Emu, Inches, Pt

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    cp = prs.core_properties
    cp.title = spec.get("title") or ""
    cp.subject = spec.get("subtitle") or ""
    cp.comments = AI_MARK
    cp.keywords = "AI 생성"
    cp.author = "Just Workspace AI"
    width = prs.slide_width
    n = 0
    if spec.get("title"):
        s = prs.slides.add_slide(prs.slide_layouts[0])
        s.shapes.title.text = spec["title"]
        if len(s.placeholders) > 1:
            s.placeholders[1].text = spec.get("subtitle") or ""
        n += 1
    for sl in spec.get("slides") or []:
        if sl.get("table"):
            s = prs.slides.add_slide(prs.slide_layouts[5])      # 제목만
            s.shapes.title.text = sl["title"]
            hdr, body = sl["table"]["header"], sl["table"]["rows"]
            ncols = max([len(hdr)] + [len(r) for r in body] + [1])
            nrows = len(body) + (1 if hdr else 0) or 1
            left, top = Inches(0.6), Inches(1.6)
            shape = s.shapes.add_table(nrows, ncols, left, top, Emu(width - 2 * left), Inches(0.4) * nrows)
            tbl = shape.table
            r0 = 0
            if hdr:
                for c, h in enumerate(hdr):
                    tbl.cell(0, c).text = h
                r0 = 1
            for ri, row in enumerate(body):
                for ci, v in enumerate(row):
                    cell = tbl.cell(r0 + ri, ci)
                    cell.text = v
                    for p in cell.text_frame.paragraphs:
                        for run in p.runs:
                            run.font.size = Pt(12)
        else:
            s = prs.slides.add_slide(prs.slide_layouts[1])      # 제목 + 내용
            s.shapes.title.text = sl["title"]
            body = s.placeholders[1].text_frame
            body.clear()
            for i, b in enumerate(sl["bullets"]):
                p = body.paragraphs[0] if i == 0 else body.add_paragraph()
                p.text = b["text"]
                p.level = b["level"]
        if sl.get("notes"):
            s.notes_slide.notes_text_frame.text = sl["notes"]
        n += 1
    buf = io.BytesIO()
    prs.save(buf)
    return Built(buf.getvalue(), {"slides": n})


def _pdf(spec: dict) -> Built:
    from xml.sax.saxutils import escape

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import (
        ListFlowable, ListItem, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    font = "HYGothic-Medium"
    try:
        pdfmetrics.getFont(font)
    except KeyError:
        pdfmetrics.registerFont(UnicodeCIDFont(font))
    base = ParagraphStyle("jw", fontName=font, fontSize=10.5, leading=16, wordWrap="CJK")
    styles = {
        0: ParagraphStyle("jw0", parent=base, fontSize=20, leading=28, spaceAfter=10),
        1: ParagraphStyle("jw1", parent=base, fontSize=15, leading=22, spaceBefore=10, spaceAfter=6),
        2: ParagraphStyle("jw2", parent=base, fontSize=13, leading=19, spaceBefore=8, spaceAfter=4),
        3: ParagraphStyle("jw3", parent=base, fontSize=11.5, leading=17, spaceBefore=6, spaceAfter=3),
    }
    sub = ParagraphStyle("jwsub", parent=base, textColor=colors.HexColor("#555555"), spaceAfter=8)
    cell_st = ParagraphStyle("jwcell", parent=base, fontSize=9, leading=12)

    def para(text, st=base):
        return Paragraph(escape(text).replace("\n", "<br/>"), st)

    story = []
    if spec.get("title"):
        story.append(para(spec["title"], styles[0]))
    if spec.get("subtitle"):
        story.append(para(spec["subtitle"], sub))
    avail = A4[0] - 36 * mm
    for b in spec.get("blocks") or []:
        t = b["type"]
        if t == "heading":
            story.append(para(b["text"], styles[b["level"]]))
        elif t == "paragraph":
            story.append(para(b["text"]))
            story.append(Spacer(1, 4))
        elif t == "list":
            items = [ListItem(para(x), leftIndent=12) for x in b["items"] if x is not None]
            if items:
                story.append(ListFlowable(items, bulletType="1" if b["ordered"] else "bullet",
                                          bulletFontName=font, start="1" if b["ordered"] else "•"))
        elif t == "table":
            header, body = b["header"], b["rows"]
            ncols = max([len(header)] + [len(r) for r in body] + [1])
            data = []
            if header:
                data.append([para(h, cell_st) for h in header] + [""] * (ncols - len(header)))
            for r in body:
                data.append([para(v, cell_st) for v in r] + [""] * (ncols - len(r)))
            if data:
                tb = Table(data, colWidths=[avail / ncols] * ncols, repeatRows=1 if header else 0)
                style = [("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#999999")),
                         ("VALIGN", (0, 0), (-1, -1), "TOP")]
                if header:
                    style.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF8")))
                tb.setStyle(TableStyle(style))
                story.append(tb)
                story.append(Spacer(1, 8))
        elif t == "page_break":
            story.append(PageBreak())
    if not story:
        story.append(para(" "))
    pages = {"n": 0}

    def _on_page(canvas, _doc):
        pages["n"] += 1
        canvas.saveState()
        canvas.setFont(font, 7.5)
        canvas.setFillColor(colors.HexColor("#888888"))
        canvas.drawString(18 * mm, 10 * mm, AI_MARK)
        canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, str(pages["n"]))
        canvas.restoreState()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm,
                            bottomMargin=18 * mm, title=spec.get("title") or "", author="Just Workspace AI",
                            subject=AI_MARK, keywords="AI 생성")
    doc.build(story, onFirstPage=_on_page, onLaterPages=_on_page)
    return Built(buf.getvalue(), {"pages": pages["n"]})


# ── 미리보기(화면 모달) ────────────────────────────────────────
def preview(spec: dict, limit_rows: int = 50) -> dict:
    """정리된 입력의 앞부분 — 화면 미리보기 모달이 그린다(바이트를 다시 읽지 않는다)."""
    fmt = spec.get("format")
    out = {"format": fmt, "title": spec.get("title") or "", "subtitle": spec.get("subtitle") or ""}
    if fmt in ("docx", "pdf"):
        blocks = []
        for b in (spec.get("blocks") or [])[:300]:
            if b.get("type") == "table":
                b = {**b, "rows": b["rows"][:limit_rows], "more_rows": max(0, len(b["rows"]) - limit_rows)}
            blocks.append(b)
        out["blocks"] = blocks
    elif fmt == "xlsx":
        out["sheets"] = [{"name": s["name"], "header": s["header"],
                          "rows": [[(c["formula"] if isinstance(c, dict) else c) for c in r] for r in s["rows"][:limit_rows]],
                          "more_rows": max(0, len(s["rows"]) - limit_rows)} for s in spec.get("sheets") or []]
    elif fmt == "pptx":
        out["slides"] = spec.get("slides") or []
    return out
