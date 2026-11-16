"""Office 편집(바이트 → 바이트) — python-docx(MIT)·openpyxl(MIT)·python-pptx(MIT).

모두 "작업 목록(operations)" 을 받아 순서대로 적용한다. 하나라도 오류가 있으면 아무것도 저장하지 않는다(OfficeError).
찾아 바꾸기는 런(서식 조각) 경계를 넘는 문구도 탐색하며, 첫 런의 서식을 유지한다.
"""

from __future__ import annotations

import io
import re
import zipfile

MAX_OPS = 200
MAX_CELLS = 100_000
MAX_TEXT = 20_000


class OfficeError(Exception):
    def __init__(self, message: str, code: str = "invalid_argument"):
        super().__init__(message)
        self.code = code
        self.message = message


def _ops(operations) -> list[dict]:
    if isinstance(operations, dict):
        operations = [operations]
    if not isinstance(operations, list) or not operations:
        raise OfficeError("operations 는 작업 목록이어야 합니다(예: [{\"op\":\"replace\",\"find\":\"…\",\"replace\":\"…\"}])")
    if len(operations) > MAX_OPS:
        raise OfficeError(f"작업이 너무 많습니다({len(operations)}개, 상한 {MAX_OPS})")
    for i, o in enumerate(operations, 1):
        if not isinstance(o, dict) or not isinstance(o.get("op"), str):
            raise OfficeError(f"{i}번째 작업에 op 가 없습니다")
    return operations


def _text(v, name: str = "text", limit: int = MAX_TEXT) -> str:
    if v is None:
        return ""
    s = str(v)
    if len(s) > limit:
        raise OfficeError(f"{name} 가 너무 깁니다({len(s)}자, 상한 {limit})")
    return s


def _open_zip_check(data: bytes, kind: str) -> None:
    if data[:8] == bytes.fromhex("d0cf11e0a1b11ae1"):
        raise OfficeError("암호가 걸렸거나 옛 형식(doc·xls·ppt) 문서입니다 — files_convert 로 새 형식으로 바꾼 뒤 편집하세요",
                          "unsupported")
    if not zipfile.is_zipfile(io.BytesIO(data)):
        raise OfficeError(f"{kind} 파일이 아니거나 손상됐습니다", "unsupported")


# ── 런 경계를 넘는 찾아 바꾸기(docx·pptx 공통) ─────────────────
def replace_in_runs(runs, find: str, repl: str, match_case: bool = True) -> int:
    """문단의 런 목록에서 find → repl. 첫 런의 서식을 적용한다. 치환 횟수를 반환한다."""
    if not find:
        return 0
    texts = [r.text or "" for r in runs]
    full = "".join(texts)
    flags = 0 if match_case else re.IGNORECASE
    matches = list(re.finditer(re.escape(find), full, flags))
    if not matches:
        return 0
    # 뒤에서부터 치환하여 앞쪽 위치 변동을 방지
    for m in reversed(matches):
        start, end = m.span()
        pos = 0
        first = True
        for i, t in enumerate(texts):
            a, b = pos, pos + len(t)
            pos = b
            if b <= start or a >= end:
                continue
            s0 = max(start, a) - a
            s1 = min(end, b) - a
            if first:
                texts[i] = t[:s0] + repl + t[s1:]
                first = False
            else:
                texts[i] = t[:s0] + t[s1:]
        # 길이가 변경되어도 다음(앞쪽) 매치는 그대로 유효 — 앞쪽 런 텍스트는 변경되지 않음
    for r, t in zip(runs, texts):
        if (r.text or "") != t:
            r.text = t
    return len(matches)


# ── docx ──────────────────────────────────────────────────────
def _heading_level(p) -> int | None:
    name = (p.style.name if p.style is not None else "") or ""
    m = re.match(r"(?:Heading|제목)\s*(\d)", name, re.I)
    if m:
        return int(m.group(1))
    if name.lower() == "title":
        return 0
    try:
        ol = p._p.pPr.outlineLvl if p._p.pPr is not None else None
        if ol is not None and ol.val is not None:
            return int(ol.val) + 1
    except Exception:  # noqa: BLE001
        pass
    return None


def docx_outline(doc) -> list[dict]:
    out = []
    for p in doc.paragraphs:
        lv = _heading_level(p)
        if lv is not None and p.text.strip():
            out.append({"level": lv, "text": p.text.strip()[:200]})
    return out[:300]


def _all_paragraphs(doc):
    def walk_tables(tables):
        for t in tables:
            for row in t.rows:
                for cell in row.cells:
                    yield from cell.paragraphs
                    yield from walk_tables(cell.tables)
    yield from doc.paragraphs
    yield from walk_tables(doc.tables)
    for s in doc.sections:
        for part in (s.header, s.footer, s.first_page_header, s.first_page_footer):
            try:
                if part is not None and not part.is_linked_to_previous:
                    yield from part.paragraphs
                    yield from walk_tables(part.tables)
            except Exception:  # noqa: BLE001
                continue


def _section_end(doc, heading_text: str):
    """해당 제목 절의 끝(다음 동급·상위 제목) 요소. None 이면 문서 끝. 제목이 없으면 OfficeError."""
    target = None
    target_level = None
    want = heading_text.strip().lower()
    for p in doc.paragraphs:
        lv = _heading_level(p)
        if lv is not None and p.text.strip().lower() == want:
            target, target_level = p, lv
            break
    if target is None:
        for p in doc.paragraphs:      # 정확히 일치하는 항목이 없으면 부분 일치
            lv = _heading_level(p)
            if lv is not None and want and want in p.text.strip().lower():
                target, target_level = p, lv
                break
    if target is None:
        raise OfficeError(f"제목을 찾지 못했습니다: {heading_text} — 문서 제목: "
                          + ", ".join(h["text"] for h in docx_outline(doc)[:30]), "not_found")
    from docx.text.paragraph import Paragraph

    el = target._p.getnext()
    while el is not None:
        if el.tag.endswith("}p"):
            lv = _heading_level(Paragraph(el, target._parent))
            if lv is not None and lv <= target_level:
                return el
        if el.tag.endswith("}sectPr"):
            return el
        el = el.getnext()
    return None


def _place(doc, new_el, before_el) -> None:
    if before_el is not None:
        before_el.addprevious(new_el)


def _add_par(doc, text: str, style: str | None, heading: int | None):
    if heading is not None:
        lv = max(0, min(9, int(heading)))
        try:
            return doc.add_heading(text, lv)
        except KeyError:
            p = doc.add_paragraph()
            run = p.add_run(text)
            run.bold = True
            from docx.shared import Pt

            run.font.size = Pt(max(11, 20 - lv * 2))
            return p
    p = doc.add_paragraph()
    if style:
        try:
            p.style = doc.styles[style]
        except KeyError:
            raise OfficeError(f"문서에 없는 스타일입니다: {style}")
    # 줄바꿈은 문단 내 줄바꿈으로 변환
    lines = text.split("\n")
    for i, line in enumerate(lines):
        r = p.add_run(line)
        if i < len(lines) - 1:
            r.add_break()
    return p


def edit_docx(data: bytes, operations) -> tuple[bytes, dict]:
    import docx

    ops = _ops(operations)
    _open_zip_check(data, "docx")
    try:
        doc = docx.Document(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001
        raise OfficeError(f"docx 를 열 수 없습니다: {e}", "unsupported")
    report = []
    for i, o in enumerate(ops, 1):
        op = o["op"]
        if op == "replace":
            find = _text(o.get("find"), "find", 2000)
            if not find:
                raise OfficeError(f"{i}번째 작업: find 가 비었습니다")
            repl = _text(o.get("replace"), "replace")
            n = sum(replace_in_runs(p.runs, find, repl, bool(o.get("match_case", True)))
                    for p in _all_paragraphs(doc))
            report.append({"op": op, "find": find[:80], "replaced": n})
        elif op in ("append_paragraph", "add_heading", "add_paragraph"):
            text = _text(o.get("text"))
            heading = o.get("heading", o.get("level") if op == "add_heading" else None)
            if op == "add_heading" and heading is None:
                heading = 1
            before = _section_end(doc, str(o["after_heading"])) if o.get("after_heading") else None
            p = _add_par(doc, text, o.get("style"), heading)
            _place(doc, p._p, before)
            report.append({"op": op, "ok": True})
        elif op in ("append_table", "add_table"):
            rows = o.get("rows")
            if not isinstance(rows, list) or not rows or not all(isinstance(r, list) for r in rows):
                raise OfficeError(f"{i}번째 작업: rows 는 [[...], ...] 이어야 합니다")
            ncols = max(len(r) for r in rows)
            if ncols == 0 or len(rows) * ncols > 20_000:
                raise OfficeError(f"{i}번째 작업: 표 크기가 잘못됐습니다")
            before = _section_end(doc, str(o["after_heading"])) if o.get("after_heading") else None
            t = doc.add_table(rows=len(rows), cols=ncols)
            try:
                t.style = doc.styles[o.get("style") or "Table Grid"]
            except KeyError:
                pass
            for ri, row in enumerate(rows):
                for ci in range(ncols):
                    t.cell(ri, ci).text = _text(row[ci] if ci < len(row) else "", "cell", 5000)
                    if ri == 0 and o.get("header", True):
                        for r in t.cell(ri, ci).paragraphs[0].runs:
                            r.bold = True
            _place(doc, t._tbl, before)
            report.append({"op": op, "rows": len(rows), "cols": ncols})
        else:
            raise OfficeError(f"{i}번째 작업: 모르는 op '{op}' (replace·append_paragraph·add_heading·append_table)")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue(), {"operations": report, "outline": docx_outline(doc)}


# ── xlsx ──────────────────────────────────────────────────────
_BAD_FUNCS = re.compile(r"\b(WEBSERVICE|FILTERXML|CALL|REGISTER(\.ID)?|EXEC|IMPORTDATA|IMPORTXML|IMPORTHTML|"
                        r"IMPORTRANGE|IMPORTFEED|RTD|DDE)\s*\(", re.I)


def check_formula(f: str) -> str:
    if len(f) > 8000:
        raise OfficeError("수식이 너무 깁니다")
    if _BAD_FUNCS.search(f) or "[" in f or re.search(r"\|\s*'?!", f) or "://" in f:
        raise OfficeError(f"외부 연결·실행 수식은 넣을 수 없습니다: {f[:80]}")
    return f


def _cell_value(v):
    if isinstance(v, str):
        if v.startswith("="):
            return check_formula(v)
        if len(v) > 32_000:
            raise OfficeError("셀 글자가 너무 깁니다(32,000자 상한)")
    elif v is not None and not isinstance(v, (int, float, bool)):
        v = str(v)
    return v


def _sheet(wb, name):
    if name in (None, ""):
        return wb.active
    if name not in wb.sheetnames:
        raise OfficeError(f"없는 시트입니다: {name} (시트: {', '.join(wb.sheetnames)})", "not_found")
    return wb[name]


def _lossy_parts(data: bytes) -> list[str]:
    try:
        names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    except Exception:  # noqa: BLE001
        return []
    out = []
    if any(n.startswith("xl/charts/") for n in names):
        out.append("차트")
    if any(n.startswith("xl/media/") for n in names):
        out.append("그림")
    if any(n.startswith("xl/pivotTables/") for n in names):
        out.append("피벗 표")
    if any(n.startswith("xl/drawings/") and "vml" not in n for n in names) and not out:
        out.append("도형")
    return out


def edit_xlsx(data: bytes, operations) -> tuple[bytes, dict]:
    from openpyxl import load_workbook
    from openpyxl.chart import BarChart, LineChart, PieChart, Reference, ScatterChart, Series
    from openpyxl.utils.cell import coordinate_from_string, column_index_from_string, range_boundaries

    ops = _ops(operations)
    _open_zip_check(data, "xlsx")
    try:
        wb = load_workbook(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001
        raise OfficeError(f"xlsx 를 열 수 없습니다: {e}", "unsupported")
    warnings = []
    lossy = _lossy_parts(data)
    if lossy:
        warnings.append(f"원본의 {'·'.join(lossy)}은(는) 이 편집기가 보존하지 못할 수 있습니다 — 새 파일을 확인하세요")
    cells = 0
    report = []
    for i, o in enumerate(ops, 1):
        op = o["op"]
        if op == "set_cells":
            ws = _sheet(wb, o.get("sheet"))
            m = o.get("cells")
            if not isinstance(m, dict) or not m:
                raise OfficeError(f"{i}번째 작업: cells 는 {{\"A1\": 값}} 이어야 합니다")
            for ref, v in m.items():
                try:
                    coordinate_from_string(str(ref))
                except Exception:  # noqa: BLE001
                    raise OfficeError(f"{i}번째 작업: 셀 주소가 잘못됐습니다: {ref}")
                ws[str(ref)] = _cell_value(v)
            cells += len(m)
            report.append({"op": op, "sheet": ws.title, "cells": len(m)})
        elif op == "set_range":
            ws = _sheet(wb, o.get("sheet"))
            rows = o.get("rows")
            if not isinstance(rows, list) or not all(isinstance(r, list) for r in rows):
                raise OfficeError(f"{i}번째 작업: rows 는 [[...], ...] 이어야 합니다")
            try:
                col_l, row0 = coordinate_from_string(str(o.get("start") or "A1"))
            except Exception:  # noqa: BLE001
                raise OfficeError(f"{i}번째 작업: start 셀 주소가 잘못됐습니다")
            col0 = column_index_from_string(col_l)
            for ri, row in enumerate(rows):
                for ci, v in enumerate(row):
                    ws.cell(row=row0 + ri, column=col0 + ci, value=_cell_value(v))
                cells += len(row)
            report.append({"op": op, "sheet": ws.title, "rows": len(rows)})
        elif op == "add_sheet":
            name = _text(o.get("name"), "name", 31).strip()
            if not name or re.search(r"[\[\]:*?/\\]", name):
                raise OfficeError(f"{i}번째 작업: 시트 이름이 잘못됐습니다")
            if name in wb.sheetnames:
                raise OfficeError(f"{i}번째 작업: 이미 있는 시트입니다: {name}", "conflict")
            idx = o.get("index")
            ws = wb.create_sheet(name, int(idx) if isinstance(idx, int) else None)
            for r in o.get("rows") or []:
                if not isinstance(r, list):
                    raise OfficeError(f"{i}번째 작업: rows 는 [[...], ...] 이어야 합니다")
                ws.append([_cell_value(v) for v in r])
                cells += len(r)
            report.append({"op": op, "sheet": name})
        elif op in ("chart", "add_chart"):
            ws = _sheet(wb, o.get("sheet"))
            kind = str(o.get("type") or "bar").lower()
            data_ref = str(o.get("data") or "")
            try:
                c1, r1, c2, r2 = range_boundaries(data_ref)
            except Exception:  # noqa: BLE001
                raise OfficeError(f"{i}번째 작업: data 범위가 잘못됐습니다(예: \"B1:C10\")")
            if None in (c1, r1, c2, r2):
                raise OfficeError(f"{i}번째 작업: data 범위는 \"B1:C10\" 처럼 양끝을 적어 주세요")
            titles = bool(o.get("titles_from_data", True))
            chart = {"bar": BarChart, "col": BarChart, "column": BarChart, "line": LineChart,
                     "pie": PieChart, "scatter": ScatterChart}.get(kind)
            if chart is None:
                raise OfficeError(f"{i}번째 작업: type 은 bar·col·line·pie·scatter 중 하나입니다")
            ch = chart()
            if kind in ("bar",):
                ch.type = "bar"
            elif kind in ("col", "column"):
                ch.type = "col"
            if o.get("title"):
                ch.title = _text(o.get("title"), "title", 200)
            cats = None
            if o.get("categories"):
                try:
                    k1, kr1, k2, kr2 = range_boundaries(str(o["categories"]))
                except Exception:  # noqa: BLE001
                    raise OfficeError(f"{i}번째 작업: categories 범위가 잘못됐습니다")
                cats = Reference(ws, min_col=k1, min_row=kr1, max_col=k2, max_row=kr2)
            if kind == "scatter":
                if cats is None:
                    raise OfficeError(f"{i}번째 작업: scatter 는 categories(x 값) 범위가 필요합니다")
                for col in range(c1, c2 + 1):
                    vals = Reference(ws, min_col=col, min_row=r1, max_row=r2)
                    s = Series(vals, cats, title_from_data=titles)
                    ch.series.append(s)
            else:
                ch.add_data(Reference(ws, min_col=c1, min_row=r1, max_col=c2, max_row=r2), titles_from_data=titles)
                if cats is not None:
                    ch.set_categories(cats)
            if o.get("x_title") and hasattr(ch, "x_axis"):
                ch.x_axis.title = _text(o["x_title"], "x_title", 100)
            if o.get("y_title") and hasattr(ch, "y_axis"):
                ch.y_axis.title = _text(o["y_title"], "y_title", 100)
            anchor = str(o.get("anchor") or "")
            if not anchor:
                from openpyxl.utils import get_column_letter

                anchor = f"{get_column_letter(c2 + 2)}{r1}"
            ws.add_chart(ch, anchor)
            report.append({"op": op, "sheet": ws.title, "type": kind, "anchor": anchor})
        else:
            raise OfficeError(f"{i}번째 작업: 모르는 op '{op}' (set_cells·set_range·add_sheet·chart)")
        if cells > MAX_CELLS:
            raise OfficeError(f"한 번에 쓰는 셀이 너무 많습니다(상한 {MAX_CELLS:,})", "too_large")
    buf = io.BytesIO()
    wb.save(buf)
    info = {"operations": report, "sheets": wb.sheetnames}
    if warnings:
        info["warnings"] = warnings
    return buf.getvalue(), info


# ── pptx ──────────────────────────────────────────────────────
def _pptx_paragraphs(prs):
    def frames(shapes):
        for sh in shapes:
            if getattr(sh, "has_text_frame", False) and sh.has_text_frame:
                yield sh.text_frame
            if getattr(sh, "has_table", False) and sh.has_table:
                for row in sh.table.rows:
                    for cell in row.cells:
                        yield cell.text_frame
            if sh.shape_type == 6 and hasattr(sh, "shapes"):     # 그룹
                yield from frames(sh.shapes)
    for slide in prs.slides:
        for tf in frames(slide.shapes):
            yield from tf.paragraphs
        if slide.has_notes_slide:
            yield from slide.notes_slide.notes_text_frame.paragraphs


def _layout(prs, want):
    layouts = list(prs.slide_layouts)
    if isinstance(want, int) and 0 <= want < len(layouts):
        return layouts[want]
    if isinstance(want, str) and want:
        for lay in layouts:
            if lay.name.lower() == want.lower():
                return lay
    # 제목+내용 → 없으면 임의 항목
    for lay in layouts:
        names = {ph.placeholder_format.type for ph in lay.placeholders}
        if 1 in names and 2 in names or (1 in names and 7 in names):   # TITLE + BODY/OBJECT
            return lay
    return layouts[1] if len(layouts) > 1 else layouts[0]


def _body_placeholder(slide):
    for ph in slide.placeholders:
        t = ph.placeholder_format.type
        if t in (2, 7) or (ph.placeholder_format.idx == 1 and t not in (1, 3)):   # BODY / OBJECT
            return ph
    return None


def _move_slide(prs, old: int, new: int) -> None:
    lst = prs.slides._sldIdLst
    items = list(lst)
    el = items[old]
    lst.remove(el)
    lst.insert(new, el)


def pptx_outline(prs) -> list[dict]:
    out = []
    for i, s in enumerate(prs.slides, 1):
        title = s.shapes.title.text.strip() if s.shapes.title is not None and s.shapes.title.has_text_frame else ""
        out.append({"slide": i, "title": title[:150]})
    return out[:300]


def edit_pptx(data: bytes, operations) -> tuple[bytes, dict]:
    from pptx import Presentation

    ops = _ops(operations)
    _open_zip_check(data, "pptx")
    try:
        prs = Presentation(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001
        raise OfficeError(f"pptx 를 열 수 없습니다: {e}", "unsupported")
    report = []
    for i, o in enumerate(ops, 1):
        op = o["op"]
        if op == "replace":
            find = _text(o.get("find"), "find", 2000)
            if not find:
                raise OfficeError(f"{i}번째 작업: find 가 비었습니다")
            repl = _text(o.get("replace"), "replace")
            n = sum(replace_in_runs(p.runs, find, repl, bool(o.get("match_case", True)))
                    for p in _pptx_paragraphs(prs))
            report.append({"op": op, "find": find[:80], "replaced": n})
        elif op == "add_slide":
            slide = prs.slides.add_slide(_layout(prs, o.get("layout")))
            if slide.shapes.title is not None:
                slide.shapes.title.text = _text(o.get("title"), "title", 500)
            bullets = o.get("bullets") or []
            if not isinstance(bullets, list):
                raise OfficeError(f"{i}번째 작업: bullets 는 목록이어야 합니다")
            if bullets:
                ph = _body_placeholder(slide)
                if ph is None:
                    from pptx.util import Emu

                    ph = slide.shapes.add_textbox(Emu(prs.slide_width // 12), Emu(prs.slide_height // 4),
                                                  Emu(prs.slide_width * 10 // 12), Emu(prs.slide_height * 2 // 3))
                tf = ph.text_frame
                tf.clear()
                for bi, b in enumerate(bullets[:60]):
                    text, level = (b.get("text"), b.get("level", 0)) if isinstance(b, dict) else (b, 0)
                    p = tf.paragraphs[0] if bi == 0 else tf.add_paragraph()
                    p.text = _text(text, "bullet", 2000)
                    p.level = max(0, min(4, int(level or 0)))
            if o.get("notes"):
                slide.notes_slide.notes_text_frame.text = _text(o.get("notes"), "notes")
            n = len(prs.slides)
            pos = o.get("position")
            if isinstance(pos, int) and 1 <= pos < n:
                _move_slide(prs, n - 1, pos - 1)
            report.append({"op": op, "slide": pos if isinstance(pos, int) and 1 <= pos < n else n})
        elif op == "set_text":
            try:
                idx = int(o.get("slide")) - 1
            except (TypeError, ValueError):
                raise OfficeError(f"{i}번째 작업: slide 번호(1부터)가 필요합니다")
            slides = list(prs.slides)
            if not 0 <= idx < len(slides):
                raise OfficeError(f"{i}번째 작업: 없는 슬라이드입니다({idx + 1}, 전체 {len(slides)})", "not_found")
            slide = slides[idx]
            target = str(o.get("shape") or "title")
            if target == "title":
                sh = slide.shapes.title
            elif target == "body":
                sh = _body_placeholder(slide)
            elif target == "notes":
                slide.notes_slide.notes_text_frame.text = _text(o.get("text"))
                report.append({"op": op, "slide": idx + 1, "shape": target})
                continue
            else:
                shapes = [s for s in slide.shapes if getattr(s, "has_text_frame", False) and s.has_text_frame]
                try:
                    sh = shapes[int(target)]
                except (ValueError, IndexError):
                    sh = next((s for s in shapes if s.name == target), None)
            if sh is None or not getattr(sh, "has_text_frame", False):
                raise OfficeError(f"{i}번째 작업: 글상자를 찾지 못했습니다({target})", "not_found")
            tf = sh.text_frame
            lines = _text(o.get("text")).split("\n")
            # 첫 문단·첫 런의 서식을 유지하여 새 텍스트를 삽입한다
            first_par = tf.paragraphs[0]
            font_size = first_par.runs[0].font.size if first_par.runs else None
            for extra in tf.paragraphs[1:]:
                extra._p.getparent().remove(extra._p)
            if first_par.runs:
                first_par.runs[0].text = lines[0]
                for r in first_par.runs[1:]:
                    r._r.getparent().remove(r._r)
            else:
                first_par.text = lines[0]
            for line in lines[1:]:
                p = tf.add_paragraph()
                p.text = line
                if font_size:
                    for r in p.runs:
                        r.font.size = font_size
            report.append({"op": op, "slide": idx + 1, "shape": target})
        else:
            raise OfficeError(f"{i}번째 작업: 모르는 op '{op}' (replace·add_slide·set_text)")
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue(), {"operations": report, "slides": pptx_outline(prs)}
