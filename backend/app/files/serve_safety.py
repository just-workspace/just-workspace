"""사용자 콘텐츠를 내려보낼 때의 안전 헤더 — 파일 서빙 전 경로가 이 함수 하나를 쓴다.

사용자가 올린 파일·받은 메일 첨부는 우리 출처(앱 도메인)에서 내려간다. html·svg·xml·js 같은
활성 콘텐츠를 브라우저가 그 자리에서 열면 안의 스크립트가 로그인 세션으로 돈다(저장형 XSS).

규칙
- 브라우저 안에서 열어 보여 줘도 되는 형식(INLINE_SAFE_TYPES: 이미지·PDF·오디오·비디오)만 inline.
- 그 밖은 inline 을 요청해도 attachment 로 내리고, 형식도 application/octet-stream 으로 고정.
- 모든 응답에 X-Content-Type-Options: nosniff.
- PDF 를 뺀 모든 응답에 Content-Security-Policy: sandbox(스크립트·같은 출처 권한 없음).
  PDF 는 브라우저 내장 뷰어가 sandbox 문서에서 열리지 않아 뺀다(PDF 안 스크립트는 우리 출처에서 돌지 않는다).
"""
from __future__ import annotations

import mimetypes
from urllib.parse import quote

INLINE_SAFE_TYPES = frozenset({
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/avif",
    "application/pdf",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/mp4",
    "video/mp4",
    "video/webm",
    "video/ogg",
})

SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"
SVG_IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"


def base_type(content_type: str | None) -> str:
    return (content_type or "").split(";", 1)[0].strip().lower()


def inline_allowed(content_type: str | None) -> bool:
    """inline 으로 내보내도 되는 형식인가(파라미터 `; charset=` 등은 무시, 대소문자 무시)."""
    return base_type(content_type) in INLINE_SAFE_TYPES


# 슬림 이미지는 시스템 mime 데이터베이스가 없어 webp 등을 모른다 — 안전 형식은 직접 매핑
_SAFE_BY_EXT = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".pdf": "application/pdf",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".wav": "audio/wav",
    ".m4a": "audio/mp4", ".weba": "audio/webm", ".mp4": "video/mp4", ".m4v": "video/mp4",
    ".webm": "video/webm", ".ogv": "video/ogg",
}


def guess_type(filename: str | None) -> str:
    if not filename:
        return "application/octet-stream"
    dot = filename.rfind(".")
    if dot >= 0 and filename[dot:].lower() in _SAFE_BY_EXT:
        return _SAFE_BY_EXT[filename[dot:].lower()]
    return base_type(mimetypes.guess_type(filename)[0]) or "application/octet-stream"


def content_disposition(filename: str | None, inline: bool = False) -> str:
    """Content-Disposition 값 — 따옴표·줄바꿈 제거, ASCII 폴백 + RFC 5987 filename*."""
    safe_name = (filename or "attachment").replace('"', "").replace("\n", "").replace("\r", "")
    encoded_name = quote(safe_name, safe="")
    ascii_name = safe_name.encode("ascii", "replace").decode("ascii").replace("?", "_")
    kind = "inline" if inline else "attachment"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"


def safe_file_headers(filename: str | None, *, content_type: str | None = None,
                      inline: bool = False) -> tuple[str, dict[str, str]]:
    """(내보낼 media type, 헤더). content_type 이 없으면 파일 이름으로 추측한다."""
    ct = base_type(content_type) or guess_type(filename)
    safe = ct in INLINE_SAFE_TYPES
    media = ct if safe else "application/octet-stream"
    headers = {
        "Content-Disposition": content_disposition(filename, inline=inline and safe),
        "X-Content-Type-Options": "nosniff",
    }
    if media != "application/pdf":
        headers["Content-Security-Policy"] = SANDBOX_CSP
    return media, headers


def svg_image_headers(filename: str | None) -> tuple[str, dict[str, str]]:
    """SVG 를 <img> 미리보기용으로 — 형식은 image/svg+xml 이지만 주소로 직접 열면 내려받기,
    sandbox CSP 로 스크립트·같은 출처 권한 없음."""
    return "image/svg+xml", {
        "Content-Disposition": content_disposition(filename or "image.svg", inline=False),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": SVG_IMAGE_CSP,
    }
