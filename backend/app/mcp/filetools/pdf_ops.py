"""PDF 처리(바이트 → 바이트) — pypdf(BSD). 텍스트 워터마크 글꼴은 reportlab 내장 CID 글꼴(한글).

쪽 번호는 사용자 기준 1부터 시작. 범위 문법: "3", "1-3", "5-"(끝까지), "-2"(처음부터), 쉼표로 복수 지정, "all".
"""

from __future__ import annotations

import io
import re

MAX_PAGES = 3000
MAX_SPLIT_PARTS = 200


class PdfError(Exception):
    def __init__(self, message: str, code: str = "invalid_argument"):
        super().__init__(message)
        self.code = code
        self.message = message


def _reader(data: bytes):
    from pypdf import PdfReader

    try:
        r = PdfReader(io.BytesIO(data))
        if r.is_encrypted:
            try:
                ok = r.decrypt("")
            except Exception:  # noqa: BLE001
                ok = 0
            if not ok:
                raise PdfError("암호가 걸린 PDF 입니다 — 암호를 푼 파일로 다시 시도하세요", "unsupported")
        n = len(r.pages)
    except PdfError:
        raise
    except Exception as e:  # noqa: BLE001
        raise PdfError(f"PDF 를 열 수 없습니다(손상됐거나 PDF 가 아님): {e}", "unsupported") from e
    if n == 0:
        raise PdfError("쪽이 없는 PDF 입니다", "unsupported")
    if n > MAX_PAGES:
        raise PdfError(f"쪽이 너무 많습니다({n}쪽, 상한 {MAX_PAGES})", "too_large")
    return r


def _out(writer) -> bytes:
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def parse_pages(spec, n: int) -> list[int]:
    """사용자용 쪽 지정 → 0부터 시작하는 번호(순서·중복 유지). 범위를 벗어나면 PdfError."""
    if spec is None or (isinstance(spec, str) and spec.strip().lower() in ("", "all", "전체")):
        return list(range(n))
    if isinstance(spec, int):
        spec = str(spec)
    if isinstance(spec, list):
        spec = ",".join(str(x) for x in spec)
    if not isinstance(spec, str):
        raise PdfError("pages 는 \"1-3,5\" 같은 문자열이어야 합니다")
    out: list[int] = []
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        m = re.fullmatch(r"(\d*)-(\d*)", part)
        if m:
            a = int(m.group(1)) if m.group(1) else 1
            b = int(m.group(2)) if m.group(2) else n
            if a > b:
                raise PdfError(f"쪽 범위가 거꾸로입니다: {part}")
        elif part.isdigit():
            a = b = int(part)
        elif part.lower() in ("last", "끝"):
            a = b = n
        else:
            raise PdfError(f"쪽 지정을 알 수 없습니다: {part} (예: 1-3,5,8-)")
        if a < 1 or b > n:
            raise PdfError(f"쪽 범위를 벗어났습니다: {part} (이 문서는 {n}쪽)")
        out.extend(range(a - 1, b))
    if not out:
        raise PdfError("고른 쪽이 없습니다")
    if len(out) > MAX_PAGES:
        raise PdfError("쪽 지정이 너무 깁니다", "too_large")
    return out


def page_count(data: bytes) -> int:
    return len(_reader(data).pages)


def inspect(data: bytes) -> dict:
    r = _reader(data)
    pages = []
    for i, p in enumerate(r.pages[:200], 1):
        box = p.mediabox
        pages.append({"page": i, "width_pt": round(float(box.width), 1), "height_pt": round(float(box.height), 1),
                      "rotation": int(p.get("/Rotate", 0) or 0) % 360})
    meta = {}
    try:
        md = r.metadata or {}
        for k in ("title", "author", "subject", "creator", "producer"):
            v = getattr(md, k, None)
            if v:
                meta[k] = str(v)[:300]
    except Exception:  # noqa: BLE001
        pass
    return {"pages": len(r.pages), "page_info": pages, "page_info_truncated": len(r.pages) > 200,
            "metadata": meta, "form_fields": form_fields(data, reader=r)}


def merge(datas: list[bytes]) -> bytes:
    from pypdf import PdfWriter

    if len(datas) < 2:
        raise PdfError("합칠 PDF 가 두 개 이상이어야 합니다")
    w = PdfWriter()
    total = 0
    for d in datas:
        r = _reader(d)
        total += len(r.pages)
        if total > MAX_PAGES:
            raise PdfError(f"합친 쪽 수가 너무 많습니다(상한 {MAX_PAGES})", "too_large")
        w.append(r)
    return _out(w)


def _subset(r, idx: list[int]) -> bytes:
    from pypdf import PdfWriter

    w = PdfWriter()
    for i in idx:
        w.add_page(r.pages[i])
    return _out(w)


def extract(data: bytes, pages) -> bytes:
    r = _reader(data)
    return _subset(r, parse_pages(pages, len(r.pages)))


def split(data: bytes, ranges: list | None = None, every: int = 0) -> list[tuple[str, bytes]]:
    """[(쪽 표시, 바이트)]. ranges = ["1-3","4-"] 또는 every = N쪽 단위. 둘 다 없으면 1쪽 단위."""
    r = _reader(data)
    n = len(r.pages)
    parts: list[tuple[str, list[int]]] = []
    if ranges:
        if not isinstance(ranges, list):
            ranges = [ranges]
        for spec in ranges:
            idx = parse_pages(spec, n)
            parts.append((str(spec).replace(" ", ""), idx))
    else:
        step = int(every or 1)
        if step < 1:
            raise PdfError("every 는 1 이상이어야 합니다")
        for a in range(0, n, step):
            b = min(n, a + step)
            parts.append((f"{a + 1}" if b - a == 1 else f"{a + 1}-{b}", list(range(a, b))))
    if len(parts) > MAX_SPLIT_PARTS:
        raise PdfError(f"나눌 조각이 너무 많습니다({len(parts)}개, 상한 {MAX_SPLIT_PARTS}) — every 를 키우세요",
                       "too_large")
    if len(parts) < 2 and not ranges:
        raise PdfError("한 쪽짜리 문서는 나눌 수 없습니다")
    return [(label, _subset(r, idx)) for label, idx in parts]


def rotate(data: bytes, angle: int, pages=None) -> bytes:
    from pypdf import PdfWriter

    try:
        angle = int(angle)
    except (TypeError, ValueError):
        raise PdfError("angle 은 90·180·270(-90) 중 하나입니다")
    if angle % 90 != 0 or angle % 360 == 0:
        raise PdfError("angle 은 90·180·270(-90) 중 하나입니다")
    r = _reader(data)
    sel = set(parse_pages(pages, len(r.pages)))
    w = PdfWriter(clone_from=r)
    for i, p in enumerate(w.pages):
        if i in sel:
            p.rotate(angle % 360)
    return _out(w)


def delete_pages(data: bytes, pages) -> bytes:
    r = _reader(data)
    n = len(r.pages)
    drop = set(parse_pages(pages, n))
    keep = [i for i in range(n) if i not in drop]
    if not keep:
        raise PdfError("모든 쪽을 지울 수는 없습니다")
    return _subset(r, keep)


# ── 폼 ────────────────────────────────────────────────────────
_FT = {"/Tx": "text", "/Btn": "button", "/Ch": "choice", "/Sig": "signature"}


def form_fields(data: bytes, reader=None) -> list[dict]:
    r = reader or _reader(data)
    try:
        fields = r.get_fields() or {}
    except Exception:  # noqa: BLE001
        return []
    out = []
    for name, f in list(fields.items())[:500]:
        ft = _FT.get(str(f.get("/FT", "")), str(f.get("/FT", "")) or "unknown")
        v = f.get("/V")
        item = {"name": name, "type": ft, "value": None if v is None else str(v)}
        if ft == "button":
            states = f.get("/_States_", None)
            if states:
                item["options"] = [str(s) for s in states]
                item["type"] = "checkbox" if len(states) <= 2 else "radio"
        elif ft == "choice":
            opts = f.get("/Opt")
            if opts:
                item["options"] = [str(o[1] if isinstance(o, list) and len(o) > 1 else o) for o in list(opts)[:100]]
        flags = int(f.get("/Ff", 0) or 0)
        if flags & 1:
            item["readonly"] = True
        if flags & 2:
            item["required"] = True
        out.append(item)
    return out


def fill_form(data: bytes, values: dict, flatten: bool = False) -> tuple[bytes, list[str], list[str]]:
    """(바이트, 채운 칸, 없는 칸)."""
    from pypdf import PdfWriter
    from pypdf.generic import NameObject

    if not isinstance(values, dict) or not values:
        raise PdfError("values 는 {칸 이름: 값} 이어야 합니다")
    r = _reader(data)
    known = {f["name"]: f for f in form_fields(data, reader=r)}
    if not known:
        raise PdfError("이 PDF 에는 채울 수 있는 폼 칸이 없습니다", "unsupported")
    missing = [k for k in values if k not in known]
    vals = {}
    for k, v in values.items():
        if k not in known:
            continue
        f = known[k]
        if f["type"] in ("checkbox", "radio", "button"):
            opts = [o for o in (f.get("options") or []) if o != "/Off"]
            if isinstance(v, bool) or str(v).lower() in ("true", "false", "yes", "no", "on", "off", "1", "0"):
                on = v if isinstance(v, bool) else str(v).lower() in ("true", "yes", "on", "1")
                v = (opts[0] if opts else "/Yes") if on else "/Off"
            elif not str(v).startswith("/"):
                v = "/" + str(v)
        vals[k] = v if isinstance(v, str) else str(v)
    w = PdfWriter(clone_from=r)
    for page in w.pages:
        if "/Annots" not in page:
            continue
        try:
            w.update_page_form_field_values(page, vals, auto_regenerate=False)
        except TypeError:
            w.update_page_form_field_values(page, vals)
    try:
        w.set_need_appearances_writer(True)
    except Exception:  # noqa: BLE001
        pass
    if flatten:
        # 값을 쪽 내용에 고정하고 필드를 제거한다(이후 수정 불가한 제출본)
        for page in w.pages:
            if "/Annots" in page:
                w.update_page_form_field_values(page, vals, auto_regenerate=False, flatten=True)
        try:
            w.remove_annotations(subtypes="/Widget")
        except Exception:  # noqa: BLE001
            pass
        if "/AcroForm" in w._root_object:
            del w._root_object[NameObject("/AcroForm")]
    return _out(w), sorted(vals), missing


# ── 워터마크 ──────────────────────────────────────────────────
_CID_FONT = "HYGothic-Medium"     # reportlab 내장 한글 CID 글꼴(글꼴 파일 없이 뷰어 글꼴 사용)


def _overlay_text(width: float, height: float, text: str, opacity: float, size: float, angle: float,
                  color: tuple[float, float, float]) -> bytes:
    from reportlab.lib.colors import Color
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas

    try:
        pdfmetrics.getFont(_CID_FONT)
    except KeyError:
        pdfmetrics.registerFont(UnicodeCIDFont(_CID_FONT))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width, height))
    c.setFillColor(Color(*color, alpha=opacity))
    c.setFont(_CID_FONT, size)
    c.saveState()
    c.translate(width / 2, height / 2)
    c.rotate(angle)
    lines = text.split("\n")[:5]
    for i, line in enumerate(lines):
        c.drawCentredString(0, (len(lines) / 2 - i - 0.75) * size * 1.2, line)
    c.restoreState()
    c.showPage()
    c.save()
    return buf.getvalue()


def _overlay_image(width: float, height: float, img_bytes: bytes, opacity: float, scale: float,
                   position: str) -> bytes:
    from PIL import Image, ImageOps
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    try:
        im = Image.open(io.BytesIO(img_bytes))
        im = ImageOps.exif_transpose(im).convert("RGBA")
    except Exception as e:  # noqa: BLE001
        raise PdfError(f"워터마크 이미지를 열 수 없습니다: {e}", "unsupported")
    if opacity < 1:
        a = im.getchannel("A").point(lambda v: int(v * opacity))
        im.putalpha(a)
    w = width * scale
    h = w * im.height / max(1, im.width)
    if h > height * 0.95:
        h = height * 0.95
        w = h * im.width / max(1, im.height)
    m = 24.0
    pos = {
        "center": ((width - w) / 2, (height - h) / 2),
        "top-left": (m, height - h - m), "top-right": (width - w - m, height - h - m),
        "bottom-left": (m, m), "bottom-right": (width - w - m, m),
    }.get(position, ((width - w) / 2, (height - h) / 2))
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width, height))
    c.drawImage(ImageReader(im), pos[0], pos[1], width=w, height=h, mask="auto")
    c.showPage()
    c.save()
    return buf.getvalue()


def _hex_color(s: str | None) -> tuple[float, float, float]:
    s = (s or "").strip().lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{6}", s):
        return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]
    return (0.5, 0.5, 0.5)


def watermark(data: bytes, *, text: str = "", image: bytes | None = None, opacity: float = 0.15,
              font_size: float = 0, angle: float = 45, color: str = "", scale: float = 0.5,
              position: str = "center", pages=None) -> bytes:
    from pypdf import PdfReader, PdfWriter

    text = (text or "").strip()
    if not text and not image:
        raise PdfError("text 나 image_path 중 하나는 있어야 합니다")
    if len(text) > 200:
        raise PdfError("워터마크 글자는 200자까지입니다")
    try:
        opacity = min(1.0, max(0.02, float(opacity)))
        scale = min(1.0, max(0.05, float(scale)))
        angle = float(angle)
    except (TypeError, ValueError):
        raise PdfError("opacity·scale·angle 은 숫자여야 합니다")
    r = _reader(data)
    sel = set(parse_pages(pages, len(r.pages)))
    w = PdfWriter(clone_from=r)
    cache: dict[tuple, object] = {}
    for i, page in enumerate(w.pages):
        if i not in sel:
            continue
        if page.get("/Rotate"):
            # 회전된 쪽은 표시 방향 기준으로 배치한다(회전을 내용에 반영한 뒤 크기를 측정한다)
            try:
                page.transfer_rotation_to_content()
            except Exception:  # noqa: BLE001
                pass
        box = page.mediabox
        pw, ph = float(box.width), float(box.height)
        key = (round(pw, 1), round(ph, 1))
        if key not in cache:
            if image:
                ob = _overlay_image(pw, ph, image, opacity, scale, position)
            else:
                size = float(font_size) if font_size else max(18.0, min(pw, ph) / max(4, len(text)) * 1.6)
                size = min(size, 200.0)
                ob = _overlay_text(pw, ph, text, opacity, size, angle, _hex_color(color))
            cache[key] = PdfReader(io.BytesIO(ob)).pages[0]
        page.merge_page(cache[key], over=True)
    return _out(w)
