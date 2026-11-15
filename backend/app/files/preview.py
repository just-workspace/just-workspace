"""File preview generation (thumbnails, text excerpts)."""

import io
import logging
from pathlib import Path

from PIL import Image

logger = logging.getLogger(__name__)

# Maximum dimensions for thumbnails
THUMB_MAX = (400, 400)
TEXT_PREVIEW_BYTES = 64 * 1024  # 64KB

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
TEXT_EXTENSIONS = {
    ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml",
    ".py", ".js", ".ts", ".html", ".css", ".sh", ".bat",
    ".log", ".ini", ".toml", ".cfg", ".conf", ".env",
    ".vue", ".jsx", ".tsx", ".sql", ".go", ".rs", ".java",
}
PDF_EXTENSIONS = {".pdf"}
# 오피스 문서 — 편집기가 늦게 뜰 때 "미리보기로 열기"(시안 ShellPage officeLoading)용 글자만 미리보기.
# 손님 공유 링크 미리보기(can_preview)에는 넣지 않는다 — 로그인 사용자 /preview 에서만.
OFFICE_TEXT_EXTENSIONS = {".docx", ".xlsx", ".pptx"}


def get_office_text(path: Path) -> str:
    """docx·xlsx·pptx 의 글자(줄 유지). 파일 색인과 같은 읽기 함수를 쓴다. 너무 크면 빈 글자."""
    from app.files import indexer

    ext = path.suffix.lower()
    if ext not in OFFICE_TEXT_EXTENSIONS:
        return ""
    try:
        if path.stat().st_size > indexer.MAX_OOXML_BYTES:
            return ""
    except OSError:
        return ""
    text = indexer._read_docx(path) if ext == ".docx" else indexer._read_ooxml(path, ext)
    return text[:TEXT_PREVIEW_BYTES]


# 글자 미리보기에서 빠지는 요소 세기(시안 R12Misc office "[표 1개 · 이미지 2개 생략됨]").
# 파트 XML 을 정규식으로 센다 — 파싱보다 싸고, 못 읽으면 0. 시트의 칸 글자는 미리보기에 그대로 나오므로
# xlsx 는 표를 세지 않고 그림만 센다.
_OMIT_PATTERNS = {
    ".docx": (("word/document.xml",), rb"<w:tbl[\s/>]", rb"<(?:w:drawing|w:pict)[\s/>]"),
    ".pptx": (("ppt/slides/slide",), rb"<a:tbl[\s/>]", rb"<p:pic[\s/>]"),
    ".xlsx": (("xl/drawings/drawing",), None, rb"<xdr:pic[\s/>]"),
}
_OMIT_MAX_PART = 32 * 1024 * 1024


def get_office_omitted(path: Path) -> dict:
    """{tables, images} — 글자 미리보기에서 빠진 표·그림 수. 못 읽으면 0."""
    import re
    import zipfile

    out = {"tables": 0, "images": 0}
    spec = _OMIT_PATTERNS.get(path.suffix.lower())
    if not spec:
        return out
    prefixes, tbl, pic = spec
    try:
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                n = info.filename
                if not n.endswith(".xml") or not any(n.startswith(p) for p in prefixes):
                    continue
                if info.file_size > _OMIT_MAX_PART:
                    continue
                data = z.read(info)
                if tbl:
                    out["tables"] += len(re.findall(tbl, data))
                out["images"] += len(re.findall(pic, data))
    except Exception:
        return {"tables": 0, "images": 0}
    return out


def can_preview(path: Path) -> str | None:
    """Return preview type if file is previewable, else None."""
    ext = path.suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in TEXT_EXTENSIONS:
        return "text"
    if ext in PDF_EXTENSIONS:
        return "pdf"
    return None


def generate_thumbnail(path: Path) -> bytes | None:
    """Generate a JPEG thumbnail for an image file."""
    ext = path.suffix.lower()
    if ext == ".svg":
        # Return SVG as-is
        return path.read_bytes()

    try:
        with Image.open(path) as img:
            img.thumbnail(THUMB_MAX, Image.Resampling.LANCZOS)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
            return buf.getvalue()
    except Exception as e:
        logger.debug("Failed to generate thumbnail for %s: %s", path, e)
        return None


def get_text_preview(path: Path) -> str | None:
    """Read the first portion of a text file."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(TEXT_PREVIEW_BYTES)
    except Exception as e:
        logger.debug("Failed to read text preview for %s: %s", path, e)
        return None
