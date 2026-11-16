"""xlsx / pptx 읽기 — 외부 의존성 없이 직접 해석한다.

라이브러리 미사용 사유
----------------------
openpyxl·python-pptx 는 각각 수 MB 이며 C 확장까지 수반하는데, 본 모듈에 필요한 것은
"값과 글자의 추출" 뿐이다(파일 검색 색인 — app/files/indexer.py). xlsx·pptx 는 XML 을
담은 zip 이므로 표준 라이브러리만으로 충분히 읽을 수 있다. 편집은 OnlyOffice 가 수행한다.

가져오지 않는 항목(의도적)
  - 셀 서식(글꼴·색). 스타일 테이블을 참조하려면 styles.xml 전체를 해석해야 하며,
    가져오더라도 본 프로젝트의 서식 모델과 1:1 로 대응하지 않아 불완전한 상태로 반영된다.
  - 차트·도형·SmartArt. 그림은 슬라이드 본문 텍스트만 보존한다.
  - 피벗·조건부 서식·매크로.

xlsx 는 수식을 원문 그대로 가져오므로(=SUM(A1:A3)), 본 프로젝트의 수식 엔진이 재계산한다.
"""

import io
import logging
import re
import zipfile
from xml.etree import ElementTree as ET

logger = logging.getLogger(__name__)

NS_SS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"

# 본 프로젝트 격자의 한계. 이보다 큰 파일은 초과분을 제외하고 그 사실을 통지한다.
MAX_ROWS = 200
MAX_COLS = 26


class OoxmlError(ValueError):
    pass


def _q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def _col_index(ref: str) -> int:
    """'B7' → 1 (0-based 열 번호)."""
    m = re.match(r"([A-Za-z]+)", ref)
    if not m:
        return -1
    n = 0
    for ch in m.group(1).upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _row_index(ref: str) -> int:
    m = re.search(r"(\d+)", ref)
    return int(m.group(1)) - 1 if m else -1


# ── xlsx ────────────────────────────────────────────────


def _shared_strings(z: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    out: list[str] = []
    for si in root.findall(_q(NS_SS, "si")):
        # <si> 안에 <t> 가 여러 개 존재할 수 있다(서식이 중간에 바뀐 문자열).
        out.append("".join(t.text or "" for t in si.iter(_q(NS_SS, "t"))))
    return out


def _first_sheet_path(z: zipfile.ZipFile) -> str:
    """워크북이 가리키는 첫 시트의 경로. 이름 순서로 선택하면 다른 시트가 선택될 수 있다."""
    try:
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    except KeyError:
        return "xl/worksheets/sheet1.xml"

    sheets = wb.find(_q(NS_SS, "sheets"))
    if sheets is None or not len(sheets):
        return "xl/worksheets/sheet1.xml"
    rid = sheets[0].get(_q(NS_REL, "id"))

    for rel in rels.findall(_q(NS_PKG_REL, "Relationship")):
        if rel.get("Id") == rid:
            target = rel.get("Target", "worksheets/sheet1.xml")
            return "xl/" + target.lstrip("/").removeprefix("xl/")
    return "xl/worksheets/sheet1.xml"


def xlsx_to_seed(data: bytes) -> dict:
    """xlsx 를 시트 초기 데이터(`{cells, colW, title}`)로 변환한다.

    반환 형식은 프런트의 Y.Map('cells') 구조와 동일하다 — 편집기가 변환 없이 적재한다.
    """
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise OoxmlError("xlsx 파일이 아닙니다")

    strings = _shared_strings(z)
    sheet_path = _first_sheet_path(z)
    try:
        root = ET.fromstring(z.read(sheet_path))
    except KeyError:
        raise OoxmlError("시트를 찾을 수 없습니다")

    cells: dict[str, dict] = {}
    truncated = False

    for c in root.iter(_q(NS_SS, "c")):
        ref = c.get("r") or ""
        r = _row_index(ref)
        col = _col_index(ref)
        if r < 0 or col < 0:
            continue
        if r >= MAX_ROWS or col >= MAX_COLS:
            truncated = True
            continue

        f = c.find(_q(NS_SS, "f"))
        formula = (f.text or "").strip() if f is not None else ""
        if formula:
            # 수식은 원문 그대로 유지 — 본 프로젝트의 수식 엔진이 재계산한다.
            cells[f"{r}:{col}"] = {"v": "=" + formula}
            continue

        t = c.get("t")
        v = c.find(_q(NS_SS, "v"))
        if t == "s" and v is not None:
            try:
                text = strings[int(v.text or "0")]
            except (ValueError, IndexError):
                text = ""
        elif t == "inlineStr":
            is_el = c.find(_q(NS_SS, "is"))
            text = "".join(x.text or "" for x in is_el.iter(_q(NS_SS, "t"))) if is_el is not None else ""
        elif t == "b" and v is not None:
            text = "TRUE" if (v.text or "0") == "1" else "FALSE"
        elif v is not None:
            text = v.text or ""
        else:
            continue

        if text != "":
            cells[f"{r}:{col}"] = {"v": text}

    # 열 너비 — 엑셀 단위는 "기본 글꼴 문자 수" 이므로 약 7px 로 환산한다.
    col_w: dict[str, int] = {}
    cols_el = root.find(_q(NS_SS, "cols"))
    if cols_el is not None:
        for col in cols_el.findall(_q(NS_SS, "col")):
            try:
                lo = int(col.get("min", "1")) - 1
                hi = int(col.get("max", "1")) - 1
                width = float(col.get("width", "8.43"))
            except ValueError:
                continue
            px = max(40, min(600, int(width * 7)))
            for i in range(lo, min(hi + 1, MAX_COLS)):
                col_w[str(i)] = px

    # 병합
    merges = root.find(_q(NS_SS, "mergeCells"))
    if merges is not None:
        for m in merges.findall(_q(NS_SS, "mergeCell")):
            ref = m.get("ref", "")
            if ":" not in ref:
                continue
            a, b = ref.split(":", 1)
            r0, c0 = _row_index(a), _col_index(a)
            r1, c1 = _row_index(b), _col_index(b)
            if min(r0, c0, r1, c1) < 0 or r1 >= MAX_ROWS or c1 >= MAX_COLS:
                continue
            anchor = cells.setdefault(f"{r0}:{c0}", {})
            anchor["ms"] = {"r": r1 - r0 + 1, "c": c1 - c0 + 1}
            for r in range(r0, r1 + 1):
                for c in range(c0, c1 + 1):
                    if r == r0 and c == c0:
                        continue
                    cells[f"{r}:{c}"] = {"mg": {"r": r0, "c": c0}}

    return {"cells": cells, "colW": col_w, "truncated": truncated}


# ── pptx ────────────────────────────────────────────────


def _slide_paths(z: zipfile.ZipFile) -> list[str]:
    """발표 순서에 따른 슬라이드 경로. 파일 이름 순으로 선택하면 10장을 초과할 때 순서가 어긋난다."""
    try:
        pres = ET.fromstring(z.read("ppt/presentation.xml"))
        rels = ET.fromstring(z.read("ppt/_rels/presentation.xml.rels"))
    except KeyError:
        names = sorted(n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n))
        return names

    target_by_id = {
        rel.get("Id"): rel.get("Target", "")
        for rel in rels.findall(_q(NS_PKG_REL, "Relationship"))
    }
    out: list[str] = []
    lst = pres.find(_q(NS_P, "sldIdLst"))
    if lst is None:
        return sorted(n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n))
    for sld in lst.findall(_q(NS_P, "sldId")):
        target = target_by_id.get(sld.get(_q(NS_REL, "id")), "")
        if target:
            out.append("ppt/" + target.lstrip("/").removeprefix("ppt/"))
    return out


def _shape_text(sp: ET.Element) -> list[str]:
    """도형 하나의 문단 목록. <a:p> 가 문단이며, 그 안의 <a:t> 조각을 연결한다."""
    paras: list[str] = []
    for p in sp.iter(_q(NS_A, "p")):
        text = "".join(t.text or "" for t in p.iter(_q(NS_A, "t")))
        paras.append(text.strip())
    # 후행 빈 문단은 제거한다(파워포인트가 관례적으로 남김)
    while paras and not paras[-1]:
        paras.pop()
    return paras


def _is_title(sp: ET.Element) -> bool:
    for ph in sp.iter(_q(NS_P, "ph")):
        if (ph.get("type") or "") in ("title", "ctrTitle"):
            return True
    return False


def _notes_for(z: zipfile.ZipFile, slide_path: str) -> str:
    name = slide_path.rsplit("/", 1)[-1]
    rels_path = f"ppt/slides/_rels/{name}.rels"
    try:
        rels = ET.fromstring(z.read(rels_path))
    except KeyError:
        return ""
    for rel in rels.findall(_q(NS_PKG_REL, "Relationship")):
        if "notesSlide" in (rel.get("Type") or ""):
            target = rel.get("Target", "")
            path = "ppt/" + target.replace("../", "").lstrip("/")
            try:
                notes = ET.fromstring(z.read(path))
            except KeyError:
                return ""
            # 노트 슬라이드에도 자리 표시자가 여러 개 존재한다. 슬라이드 번호 상자까지 포함하면
            # 모든 슬라이드의 노트가 "1", "2" 같은 숫자로 채워진다. 본문 상자만 가져온다.
            out: list[str] = []
            for sp in notes.iter(_q(NS_P, "sp")):
                kinds = {(ph.get("type") or "body") for ph in sp.iter(_q(NS_P, "ph"))}
                if kinds - {"body"}:
                    continue
                out.extend(x for x in _shape_text(sp) if x)
            return "\n".join(out)
    return ""


def pptx_to_seed(data: bytes) -> dict:
    """pptx 를 슬라이드 초기 데이터(`{slides: [...]}`)로 변환한다."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise OoxmlError("pptx 파일이 아닙니다")

    slides: list[dict] = []
    for i, path in enumerate(_slide_paths(z)):
        try:
            root = ET.fromstring(z.read(path))
        except KeyError:
            continue

        title = ""
        bodies: list[list[str]] = []
        for sp in root.iter(_q(NS_P, "sp")):
            paras = [p for p in _shape_text(sp) if p]
            if not paras:
                continue
            if _is_title(sp) and not title:
                title = " ".join(paras)
            else:
                bodies.append(paras)

        # 자리 표시자 정보가 없는 파일이면 첫 텍스트 블록을 제목으로 간주한다.
        if not title and bodies:
            first = bodies.pop(0)
            title = first[0]
            if len(first) > 1:
                bodies.insert(0, first[1:])

        # 디자인된 슬라이드는 작은 텍스트 상자가 여러 개여서 그대로 처리하면 전부 "두 단" 이 된다.
        # 양쪽이 모두 여러 줄일 때만 두 단으로 간주하고, 그 외에는 하나로 병합한다.
        if len(bodies) >= 2 and len(bodies[0]) >= 2 and len(bodies[1]) >= 2:
            body = "\n".join(bodies[0])
            body2 = "\n".join(sum(bodies[1:], []))
            layout = "two"
        else:
            body = "\n".join(sum(bodies, []))
            body2 = ""
            layout = "title" if (title and not body) else "title-body"

        slides.append({
            "id": f"imp{i}",
            "layout": layout,
            "title": title,
            "body": body,
            "body2": body2,
            "notes": _notes_for(z, path),
            "bg": "#ffffff",
        })

    if not slides:
        raise OoxmlError("슬라이드를 찾을 수 없습니다")
    return {"slides": slides}


# ── xlsx 쓰기 ───────────────────────────────────────────
# 내보내기는 값만 포함한 최소 워크북을 생성한다. 서식까지 이전하려면 styles.xml 전체를
# 생성해야 하는데, 수신 측에서 다시 서식을 지정하는 경우가 대부분이므로 값을 우선한다.

_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""

_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

_WORKBOOK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""

_WB_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""


def _col_name(c: int) -> str:
    name = ""
    c += 1
    while c > 0:
        c, rem = divmod(c - 1, 26)
        name = chr(65 + rem) + name
    return name


def _esc(t: str) -> str:
    return (t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def rows_to_xlsx(rows: list[list[str]]) -> bytes:
    """문자열 표를 xlsx 시트 하나로 변환한다. 숫자로 해석되는 값은 숫자 셀로 저장한다."""
    parts: list[str] = []
    for r, row in enumerate(rows):
        cells: list[str] = []
        for c, val in enumerate(row):
            if val is None or val == "":
                continue
            ref = f"{_col_name(c)}{r + 1}"
            try:
                float(str(val).replace(",", ""))
                num = True
            except ValueError:
                num = False
            if num:
                cells.append(f'<c r="{ref}"><v>{_esc(str(val).replace(",", ""))}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{_esc(str(val))}</t></is></c>')
        if cells:
            parts.append(f'<row r="{r + 1}">{"".join(cells)}</row>')

    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(parts)}</sheetData></worksheet>'
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _CONTENT_TYPES)
        z.writestr("_rels/.rels", _ROOT_RELS)
        z.writestr("xl/workbook.xml", _WORKBOOK)
        z.writestr("xl/_rels/workbook.xml.rels", _WB_RELS)
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()
