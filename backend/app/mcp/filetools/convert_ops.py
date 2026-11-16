"""간단 변환(라이브러리) — xlsx↔csv, md→docx(pandoc), txt/md→pdf(reportlab), 이미지→pdf(Pillow).

그 외(오피스·한글 문서 → pdf, docx↔odt 등)는 ws-docconv(LibreOffice) 가 담당한다 — app.mcp.filetools.docconv_client.
"""

from __future__ import annotations

import csv
import io
import os
import re
import subprocess
from xml.sax.saxutils import escape

MAX_IMAGES = 100
MAX_IMAGE_PIXELS = 80_000_000
MAX_TEXT_CHARS = 2_000_000
PANDOC_TIMEOUT = 60

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff")

# (원본 확장자, 대상) → 로컬 변환 이름
LOCAL = {
    (".xlsx", "csv"): "xlsx_csv", (".xlsm", "csv"): "xlsx_csv",
    (".csv", "xlsx"): "csv_xlsx", (".tsv", "xlsx"): "csv_xlsx",
    (".md", "docx"): "md_docx", (".markdown", "docx"): "md_docx", (".txt", "docx"): "md_docx",
    (".md", "pdf"): "md_pdf", (".markdown", "pdf"): "md_pdf", (".txt", "pdf"): "txt_pdf",
}


class ConvertError(Exception):
    def __init__(self, message: str, code: str = "invalid_argument"):
        super().__init__(message)
        self.code = code
        self.message = message


def decode_text(data: bytes) -> str:
    encs = ("utf-16",) if data[:2] in (b"\xff\xfe", b"\xfe\xff") else ("utf-8-sig", "cp949")
    for enc in encs:
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


# ── xlsx ↔ csv ────────────────────────────────────────────────
def xlsx_to_csv(data: bytes, sheet: str = "", all_sheets: bool = False) -> list[tuple[str, bytes]]:
    """[(시트 이름, csv 바이트)]. 값은 계산된 값(수식 결과 — 엑셀이 저장한 값). UTF-8 BOM(엑셀 한글)."""
    from openpyxl import load_workbook

    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001
        raise ConvertError(f"xlsx 를 열 수 없습니다: {e}", "unsupported")
    if sheet:
        if sheet not in wb.sheetnames:
            raise ConvertError(f"없는 시트입니다: {sheet} (시트: {', '.join(wb.sheetnames)})", "not_found")
        names = [sheet]
    else:
        names = list(wb.sheetnames) if all_sheets else [wb.sheetnames[0]]
    out = []
    for name in names:
        ws = wb[name]
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\r\n")
        rows = 0
        for row in ws.iter_rows(values_only=True):
            w.writerow(["" if v is None else v for v in row])
            rows += 1
            if rows > 1_000_000:
                raise ConvertError("행이 너무 많습니다(100만 행 상한)", "too_large")
        out.append((name, ("\ufeff" + buf.getvalue()).encode("utf-8")))
    wb.close()
    return out


_NUM = re.compile(r"^-?(0|[1-9]\d{0,14})(\.\d+)?$")


def _csv_value(s: str):
    t = s.strip()
    if _NUM.match(t):          # "0012" 같은 선행 0 은 문자열로 유지한다(우편번호·코드)
        try:
            return int(t) if "." not in t else float(t)
        except ValueError:
            return s
    if t.startswith("="):      # csv 의 수식은 실행하지 않는다(CSV 인젝션) — 문자열로 처리
        return "'" + s
    return s


def csv_to_xlsx(data: bytes, ext: str = ".csv", sheet_name: str = "") -> bytes:
    from openpyxl import Workbook

    text = decode_text(data)
    if len(text) > 50_000_000:
        raise ConvertError("csv 가 너무 큽니다", "too_large")
    if ext == ".tsv":
        dialect = csv.excel_tab
    else:
        try:
            dialect = csv.Sniffer().sniff(text[:20000], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
    wb = Workbook(write_only=True)
    ws = wb.create_sheet(title=(sheet_name or "Sheet1")[:31])
    n = 0
    for row in csv.reader(io.StringIO(text), dialect):
        ws.append([_csv_value(c) for c in row])
        n += 1
        if n > 1_000_000:
            raise ConvertError("행이 너무 많습니다(100만 행 상한)", "too_large")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ── md → docx (pandoc) ────────────────────────────────────────
_PANDOC_FILTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pandoc_safe.lua")


def md_to_docx(data: bytes, plain: bool = False) -> bytes:
    """문서 내 그림·HTML 을 통한 서버 파일·네트워크 읽기 차단: 원시 HTML 비활성화 + 그림을 텍스트로 변환하는 필터.
    (데비안 pandoc 3.1 의 --sandbox 는 자체 docx 데이터 파일도 읽지 못해 사용 불가)"""
    text = decode_text(data)
    if len(text) > MAX_TEXT_CHARS:
        raise ConvertError("글이 너무 깁니다", "too_large")
    fmt = "markdown_strict-raw_html" if plain else "gfm-raw_html"
    try:
        p = subprocess.run(["pandoc", "-f", fmt, "-t", "docx", "--lua-filter", _PANDOC_FILTER,
                            "--resource-path", "/nonexistent", "-o", "-"],
                           input=text.encode("utf-8"), capture_output=True, timeout=PANDOC_TIMEOUT, check=False)
    except FileNotFoundError:
        raise ConvertError("pandoc 이 서버에 없습니다", "unavailable")
    except subprocess.TimeoutExpired:
        raise ConvertError("변환 시간이 지났습니다", "timeout")
    if p.returncode != 0 or not p.stdout:
        raise ConvertError(f"docx 로 바꾸지 못했습니다: {p.stderr.decode('utf-8', 'replace')[-300:]}", "internal")
    return p.stdout


# ── txt/md → pdf (reportlab) ──────────────────────────────────
_CID = "HYGothic-Medium"
_CID_SERIF = "HYSMyeongJo-Medium"


def _styles():
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont

    for f in (_CID, _CID_SERIF):
        try:
            pdfmetrics.getFont(f)
        except KeyError:
            pdfmetrics.registerFont(UnicodeCIDFont(f))
    base = ParagraphStyle("base", fontName=_CID, fontSize=10.5, leading=16, wordWrap="CJK", spaceAfter=5)
    heads = [ParagraphStyle(f"h{i}", parent=base, fontSize=s, leading=s * 1.35, spaceBefore=8, spaceAfter=6)
             for i, s in enumerate((20, 16, 14, 12.5, 11.5, 11), 1)]
    code = ParagraphStyle("code", parent=base, fontSize=9, leading=12.5, backColor="#f3f3f3", leftIndent=6,
                          borderPadding=4)
    quote = ParagraphStyle("quote", parent=base, leftIndent=14, textColor="#555555")
    bullet = ParagraphStyle("bullet", parent=base, leftIndent=14, bulletIndent=4)
    return base, heads, code, quote, bullet


def _inline(s: str) -> str:
    """마크다운 인라인 → reportlab 미니 마크업(굵게·기울임·코드·링크 텍스트)."""
    s = escape(s)
    s = re.sub(r"`([^`]+)`", r'<font face="Courier">\1</font>', s)
    s = re.sub(r"\*\*(.+?)\*\*|__(.+?)__", lambda m: f"<b>{m.group(1) or m.group(2)}</b>", s)
    s = re.sub(r"(?<![\*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)", r"<i>\1</i>", s)
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"[그림: \1]", s)
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r"\1 (\2)", s)
    return s


def _pdf_doc(flow, title: str) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate

    buf = io.BytesIO()

    def _page(canvas, doc):
        canvas.saveState()
        canvas.setFont(_CID, 8)
        canvas.setFillGray(0.5)
        canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, str(doc.page))
        canvas.restoreState()

    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm,
                            bottomMargin=18 * mm, title=title, author="Just Workspace AI")
    doc.build(flow, onFirstPage=_page, onLaterPages=_page)
    return buf.getvalue()


def txt_to_pdf(data: bytes, title: str = "") -> bytes:
    from reportlab.platypus import Paragraph, Preformatted

    text = decode_text(data)
    if len(text) > MAX_TEXT_CHARS:
        raise ConvertError("글이 너무 깁니다", "too_large")
    base, _h, code, _q, _b = _styles()
    flow = []
    for para in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        if not para.strip():
            continue
        if re.search(r"^( {4}|\t)", para, re.M) and len(para) < 20000:
            flow.append(Preformatted(para, code))
        else:
            flow.append(Paragraph(escape(para).replace("\n", "<br/>"), base))
    if not flow:
        flow.append(Paragraph(" ", base))
    return _pdf_doc(flow, title)


def md_to_pdf(data: bytes, title: str = "") -> bytes:
    from reportlab.lib import colors
    from reportlab.platypus import HRFlowable, Paragraph, Preformatted, Spacer, Table, TableStyle

    text = decode_text(data).replace("\r\n", "\n")
    if len(text) > MAX_TEXT_CHARS:
        raise ConvertError("글이 너무 깁니다", "too_large")
    base, heads, code, quote, bullet = _styles()
    flow: list = []
    lines = text.split("\n")
    i = 0
    para: list[str] = []

    def flush():
        if para:
            flow.append(Paragraph(_inline(" ".join(x.strip() for x in para)), base))
            para.clear()

    while i < len(lines):
        line = lines[i]
        st = line.strip()
        if st.startswith("```"):
            flush()
            buf = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            flow.append(Preformatted("\n".join(buf) or " ", code))
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", st)
        if m:
            flush()
            flow.append(Paragraph(_inline(m.group(2).strip().rstrip("#").strip()), heads[len(m.group(1)) - 1]))
            i += 1
            continue
        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", st):
            flush()
            flow.append(HRFlowable(width="100%", color=colors.lightgrey))
            i += 1
            continue
        if st.startswith("|") and i + 1 < len(lines) and re.fullmatch(r"\|?\s*:?-{2,}.*", lines[i + 1].strip()):
            flush()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                if not re.fullmatch(r"\|?[\s:\-|]+\|?", lines[i].strip()):
                    cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                    rows.append([Paragraph(_inline(c), base) for c in cells])
                i += 1
            if rows:
                ncol = max(len(r) for r in rows)
                rows = [r + [""] * (ncol - len(r)) for r in rows]
                t = Table(rows, repeatRows=1)
                t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                                       ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
                                       ("VALIGN", (0, 0), (-1, -1), "TOP")]))
                flow.append(t)
                flow.append(Spacer(1, 6))
            continue
        m = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", line)
        if m:
            flush()
            depth = len(m.group(1).replace("\t", "    ")) // 2
            mark = "•" if m.group(2) in "-*+" else m.group(2)
            st_ = bullet.clone(f"b{depth}", leftIndent=14 + depth * 12, bulletIndent=4 + depth * 12)
            flow.append(Paragraph(_inline(m.group(3)), st_, bulletText=mark))
            i += 1
            continue
        if st.startswith(">"):
            flush()
            flow.append(Paragraph(_inline(st.lstrip("> ")), quote))
            i += 1
            continue
        if not st:
            flush()
        else:
            para.append(line)
        i += 1
    flush()
    if not flow:
        flow.append(Paragraph(" ", base))
    return _pdf_doc(flow, title)


# ── 이미지 → pdf ──────────────────────────────────────────────
def images_to_pdf(images: list[bytes]) -> bytes:
    from PIL import Image, ImageOps

    if not images:
        raise ConvertError("이미지가 없습니다")
    if len(images) > MAX_IMAGES:
        raise ConvertError(f"이미지가 너무 많습니다(상한 {MAX_IMAGES})", "too_large")
    pages = []
    try:
        for idx, b in enumerate(images, 1):
            try:
                im = Image.open(io.BytesIO(b))
                if im.width * im.height > MAX_IMAGE_PIXELS:
                    raise ConvertError(f"{idx}번째 이미지가 너무 큽니다({im.width}×{im.height})", "too_large")
                frames = []
                n = getattr(im, "n_frames", 1)
                for f in range(min(n, 200)):       # 다중 쪽 TIFF 는 쪽 단위로 처리
                    im.seek(f)
                    fr = ImageOps.exif_transpose(im.copy())
                    if fr.mode in ("RGBA", "LA", "P"):
                        bg = Image.new("RGB", fr.size, "white")
                        fr = fr.convert("RGBA")
                        bg.paste(fr, mask=fr.getchannel("A"))
                        fr = bg
                    elif fr.mode != "RGB":
                        fr = fr.convert("RGB")
                    frames.append(fr)
                    if im.format == "GIF":
                        break
                pages.extend(frames)
            except ConvertError:
                raise
            except Exception as e:  # noqa: BLE001
                raise ConvertError(f"{idx}번째 이미지를 열 수 없습니다: {e}", "unsupported")
        buf = io.BytesIO()
        pages[0].save(buf, format="PDF", save_all=True, append_images=pages[1:], resolution=150.0)
        return buf.getvalue()
    finally:
        for p in pages:
            try:
                p.close()
            except Exception:  # noqa: BLE001
                pass
