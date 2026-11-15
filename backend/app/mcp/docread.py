"""문서를 **구조째** 텍스트로 — MCP files_read · mail_read_attachment 용.

색인기(app/files/indexer.py)의 추출기는 검색용이라 공백을 전부 뭉갠다. 모델이 읽기엔
제목·표·시트·슬라이드·쪽 경계가 사라져 쓸모가 떨어진다. 여기서는 마크다운으로 구조를 남긴다.

지원: docx(제목·문단·표 순서 유지), xlsx(시트별 표), pptx(슬라이드별 제목·본문·노트),
pdf(쪽별), hwpx(zip+XML), hwp(5.0 바이너리 — olefile 로 열고 BodyText 레코드를 직접 푼다).
pyhwp 는 AGPL 이라 쓰지 않는다.

모든 함수는 bytes 를 받아 (markdown, meta) 를 돌려준다. 해석 실패는 DocReadError.
"""

from __future__ import annotations

import io
import re
import struct
import zipfile
import zlib

MAX_SHEET_ROWS = 2000      # 시트 하나에서 읽는 최대 행
MAX_SHEET_COLS = 60
MAX_PDF_PAGES = 300
MAX_DOC_CHARS = 1_000_000  # 문서 하나에서 뽑는 최대 글자 — 거대한 표 문서가 수백만 자·수 분 걸린 적이 있다


# 실패 코드(첨부 화면이 문구를 고른다) — 메시지 문자열을 해석하지 말고 code 를 볼 것.
ERROR_CODES = ("encrypted", "distribution", "corrupt", "too_large", "unsupported_version", "unsupported")


class DocReadError(Exception):
    """문서를 읽지 못함(손상·암호·배포용 등). 메시지는 사용자에게 그대로 보여도 된다.

    ``code`` ∈ ERROR_CODES: encrypted(암호) · distribution(배포용 hwp) · corrupt(손상·해석 실패, 기본) ·
    too_large · unsupported_version(hwp 3.x 등) · unsupported(형식 미지원).
    """

    def __init__(self, message: str, code: str = "corrupt"):
        super().__init__(message)
        self.code = code if code in ERROR_CODES else "corrupt"


def _md_cell(v: object) -> str:
    s = "" if v is None else str(v)
    return s.replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def _md_table(rows: list[list[object]]) -> str:
    rows = [r for r in rows if any(_md_cell(c) for c in r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    norm = [[_md_cell(c) for c in r] + [""] * (width - len(r)) for r in rows]
    out = ["| " + " | ".join(norm[0]) + " |", "|" + "---|" * width]
    out += ["| " + " | ".join(r) + " |" for r in norm[1:]]
    return "\n".join(out)


# ── docx ──────────────────────────────────────────────────────
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _w_text(el) -> str:
    return "".join(t.text or "" for t in el.iter(_W + "t"))


def read_docx(data: bytes) -> tuple[str, dict]:
    import docx
    from docx.text.paragraph import Paragraph

    try:
        d = docx.Document(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001
        raise DocReadError(f"docx 를 열 수 없습니다: {e}") from e
    parts: list[str] = []
    size = 0
    tables = 0
    truncated = False
    # 본문 순서 그대로(문단과 표가 섞인 순서) — d.paragraphs/d.tables 는 순서를 잃는다.
    # 표는 python-docx 의 row.cells 를 쓰지 않는다: 병합 셀이 많은 표에서 셀마다 격자를 다시 계산해
    # 실제 문서 하나가 117초 걸렸다. XML 의 w:tr/w:tc 를 직접 읽는다(병합 칸은 한 번만 나온다).
    for el in d.element.body.iterchildren():
        if size > MAX_DOC_CHARS:
            truncated = True
            break
        tag = el.tag.rsplit("}", 1)[-1]
        block = ""
        if tag == "p":
            p = Paragraph(el, d)
            text = p.text.strip()
            if not text:
                continue
            style = (p.style.name if p.style is not None else "") or ""
            m = re.match(r"(?:Heading|제목)\s*(\d)", style)
            if m:
                block = "#" * min(6, int(m.group(1))) + " " + text
            elif style.lower().startswith(("list", "목록")):
                block = "- " + text
            else:
                block = text
        elif tag == "tbl":
            rows = []
            for tr in el.iterchildren(_W + "tr"):   # 직계 행만(셀 안 중첩 표의 행은 셀 글자로 들어간다)
                rows.append([" ".join(_w_text(p) for p in tc.iter(_W + "p")).strip()
                             for tc in tr.iterchildren(_W + "tc")])
            block = _md_table(rows)
            if block:
                tables += 1
        if block:
            parts.append(block)
            size += len(block)
    meta = {"format": "docx", "tables": tables}
    if truncated:
        meta["truncated_document"] = True
        meta["note"] = f"문서가 매우 커서 앞 {MAX_DOC_CHARS:,}자까지만 해석했습니다"
    return "\n\n".join(parts), meta


# ── xlsx ──────────────────────────────────────────────────────
def read_xlsx(data: bytes) -> tuple[str, dict]:
    import openpyxl

    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001
        raise DocReadError(f"xlsx 를 열 수 없습니다: {e}") from e
    parts: list[str] = []
    sheets = []
    try:
        for ws in wb.worksheets:
            rows: list[list[object]] = []
            truncated = False
            for i, row in enumerate(ws.iter_rows(values_only=True)):
                if i >= MAX_SHEET_ROWS:
                    truncated = True
                    break
                rows.append(list(row[:MAX_SHEET_COLS]))
            # 뒤쪽 빈 열 잘라내기
            width = 0
            for r in rows:
                for j in range(len(r) - 1, -1, -1):
                    if r[j] not in (None, ""):
                        width = max(width, j + 1)
                        break
            rows = [r[:width] for r in rows]
            md = _md_table(rows)
            sheets.append({"name": ws.title, "rows": len(rows), "truncated": truncated})
            parts.append(f"## 시트: {ws.title}\n\n" + (md or "(빈 시트)")
                         + (f"\n\n(앞 {MAX_SHEET_ROWS}행만 표시)" if truncated else ""))
    finally:
        wb.close()
    return "\n\n".join(parts), {"format": "xlsx", "sheets": sheets}


# ── pptx ──────────────────────────────────────────────────────
def read_pptx(data: bytes) -> tuple[str, dict]:
    from app.files import ooxml

    try:
        slides = (ooxml.pptx_to_seed(data) or {}).get("slides", [])
    except Exception as e:  # noqa: BLE001
        raise DocReadError(f"pptx 를 열 수 없습니다: {e}") from e
    parts = []
    for i, s in enumerate(slides, 1):
        block = [f"## 슬라이드 {i}: {s.get('title') or '(제목 없음)'}"]
        for body in (s.get("body"), s.get("body2")):
            if body:
                block.append("\n".join("- " + ln for ln in body.splitlines() if ln.strip()))
        if s.get("notes"):
            block.append("> 노트: " + s["notes"].replace("\n", " "))
        parts.append("\n\n".join(block))
    return "\n\n".join(parts), {"format": "pptx", "slides": len(slides)}


# ── pdf ───────────────────────────────────────────────────────
def read_pdf(data: bytes) -> tuple[str, dict]:
    from pypdf import PdfReader

    try:
        r = PdfReader(io.BytesIO(data))
        if r.is_encrypted:
            try:
                r.decrypt("")
            except Exception:  # noqa: BLE001
                raise DocReadError("암호가 걸린 PDF 입니다", "encrypted")
        pages = r.pages
    except DocReadError:
        raise
    except Exception as e:  # noqa: BLE001
        raise DocReadError(f"PDF 를 열 수 없습니다: {e}") from e
    parts = []
    empty = 0
    n = len(pages)
    for i, page in enumerate(pages[:MAX_PDF_PAGES], 1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:  # noqa: BLE001
            text = ""
        if not text:
            empty += 1
        parts.append(f"--- {i}쪽 ---\n{text}")
    meta = {"format": "pdf", "pages": n, "pages_without_text": empty}
    if n and empty == min(n, MAX_PDF_PAGES):
        # 글자 층이 없는 스캔 PDF — OCR 은 아직 없다
        meta["note"] = "텍스트 층이 없는 스캔 문서로 보입니다(글자 인식 미지원)"
    return "\n\n".join(parts), meta


# ── hwpx ──────────────────────────────────────────────────────
def read_hwpx(data: bytes) -> tuple[str, dict]:
    from lxml import etree

    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise DocReadError("hwpx 파일이 아닙니다") from e
    names = sorted(
        (n for n in z.namelist() if re.match(r"Contents/section\d+\.xml$", n)),
        key=lambda n: int(re.search(r"(\d+)", n.rsplit("/", 1)[-1]).group(1)),  # type: ignore[union-attr]
    )
    if not names:
        raise DocReadError("hwpx 본문(section)을 찾을 수 없습니다")
    parts: list[str] = []
    tables = 0
    for name in names:
        root = etree.fromstring(z.read(name))

        def local(el) -> str:
            return el.tag.rsplit("}", 1)[-1] if isinstance(el.tag, str) else ""

        def para_text(p) -> str:
            return "".join(t.text or "" for t in p.iter() if local(t) == "t").strip()

        # 표 안의 문단은 표로 따로 모으고, 본문 문단에서는 뺀다
        for el in root.iter():
            tag = local(el)
            if tag == "tbl":
                rows = []
                for tr in el.iter():
                    if local(tr) != "tr":
                        continue
                    row = []
                    for tc in tr:
                        if local(tc) == "tc":
                            row.append(" ".join(para_text(p) for p in tc.iter() if local(p) == "p"))
                    rows.append(row)
                md = _md_table(rows)
                if md:
                    parts.append(md)
                    tables += 1
            elif tag == "p":
                if any(local(a) == "tbl" for a in el.iterancestors()):
                    continue
                if any(local(c) == "tbl" for c in el.iter()):
                    continue   # 표를 품은 문단 — 표는 위에서 따로 처리
                text = para_text(el)
                if text:
                    parts.append(text)
    return "\n\n".join(parts), {"format": "hwpx", "sections": len(names), "tables": tables}


# ── hwp (5.0 바이너리) ─────────────────────────────────────────
_HWPTAG_PARA_TEXT = 0x10 + 51   # 67
# 1 WCHAR 로 끝나는 제어문자: 0(unusable), 10(줄바꿈), 13(문단 끝), 24~31(문자 제어)
_CHAR_CTRL = {0, 10, 13} | set(range(24, 32))


def _hwp_para_text(buf: bytes) -> str:
    out: list[str] = []
    i = 0
    n = len(buf) - 1
    while i < n:
        code = buf[i] | (buf[i + 1] << 8)
        if code < 32:
            if code in _CHAR_CTRL:
                if code == 10:
                    out.append("\n")
                i += 2
            else:
                # 인라인·확장 제어문자는 8 WCHAR(16바이트)를 차지한다(9=탭은 인라인)
                if code == 9:
                    out.append("\t")
                i += 16
            continue
        out.append(chr(code))
        i += 2
    return "".join(out).strip()


def _hwp_records(stream: bytes):
    i = 0
    n = len(stream)
    while i + 4 <= n:
        (hdr,) = struct.unpack_from("<I", stream, i)
        tag = hdr & 0x3FF
        size = (hdr >> 20) & 0xFFF
        i += 4
        if size == 0xFFF:
            if i + 4 > n:
                return
            (size,) = struct.unpack_from("<I", stream, i)
            i += 4
        yield tag, stream[i:i + size]
        i += size


def read_hwp(data: bytes) -> tuple[str, dict]:
    import olefile

    if not olefile.isOleFile(io.BytesIO(data)):
        raise DocReadError("hwp 5.0 파일이 아닙니다(구버전 hwp 3.x 는 미지원)", "unsupported_version")
    try:
        ole = olefile.OleFileIO(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001
        raise DocReadError(f"hwp 를 열 수 없습니다: {e}") from e
    try:
        if not ole.exists("FileHeader"):
            raise DocReadError("hwp 헤더가 없습니다")
        header = ole.openstream("FileHeader").read()
        if not header.startswith(b"HWP Document File"):
            raise DocReadError("hwp 서명이 맞지 않습니다")
        (props,) = struct.unpack_from("<I", header, 36)
        compressed = bool(props & 0x01)
        if props & 0x02:
            raise DocReadError("암호가 걸린 hwp 입니다", "encrypted")
        if props & 0x04:
            raise DocReadError("배포용 hwp 는 읽을 수 없습니다(본문이 암호화되어 있음)", "distribution")
        sections = sorted(
            (e for e in ole.listdir() if len(e) == 2 and e[0] == "BodyText" and e[1].startswith("Section")),
            key=lambda e: int(e[1][7:] or 0),
        )
        if not sections:
            raise DocReadError("hwp 본문(BodyText)을 찾을 수 없습니다")
        parts: list[str] = []
        for sec in sections:
            raw = ole.openstream(sec).read()
            if compressed:
                try:
                    raw = zlib.decompress(raw, -15)
                except zlib.error as e:
                    raise DocReadError(f"hwp 본문 압축을 풀 수 없습니다: {e}") from e
            for tag, payload in _hwp_records(raw):
                if tag == _HWPTAG_PARA_TEXT:
                    t = _hwp_para_text(payload)
                    if t:
                        parts.append(t)
    finally:
        ole.close()
    # 표 구조는 아직 복원하지 않는다(셀 글자는 문단으로 순서대로 나온다)
    return "\n\n".join(parts), {"format": "hwp", "sections": len(sections),
                                "note": "표는 셀 글자만 순서대로 표시됩니다"}


READERS = {
    ".docx": read_docx,
    ".xlsx": read_xlsx,
    ".xlsm": read_xlsx,
    ".pptx": read_pptx,
    ".pdf": read_pdf,
    ".hwpx": read_hwpx,
    ".hwp": read_hwp,
}


_OOXML = (".docx", ".xlsx", ".xlsm", ".pptx")
_OLE_MAGIC = bytes.fromhex("d0cf11e0a1b11ae1")


def can_read(ext: str) -> bool:
    return ext.lower() in READERS


def read_document(data: bytes, ext: str) -> tuple[str, dict]:
    fn = READERS.get(ext.lower())
    if fn is not None and ext.lower() in _OOXML and data[:8] == _OLE_MAGIC:
        # 암호를 건 오피스 문서는 zip 이 아니라 OLE(CFB) 봉투에 들어 있다
        raise DocReadError("암호가 걸린 문서입니다", "encrypted")
    if fn is None:
        raise DocReadError(f"{ext} 형식은 아직 해석하지 못합니다", "unsupported")
    text, meta = fn(data)
    if len(text) > MAX_DOC_CHARS and not meta.get("truncated_document"):
        text = text[:MAX_DOC_CHARS]
        meta["truncated_document"] = True
        meta["note"] = f"문서가 매우 커서 앞 {MAX_DOC_CHARS:,}자까지만 해석했습니다"
    return text, meta
