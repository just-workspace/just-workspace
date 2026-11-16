"""메일 첨부 HTTP 헤더 보조 — 라우터와 분리하여 FastAPI 없이도 단위 테스트가 가능하다."""

from urllib.parse import quote

# 브라우저 내 표시가 안전한 형식만 inline 을 허용한다. 규칙은 파일 서빙 공용(serve_safety).
# 첨부의 Content-Type 은 발신자가 지정한다. text/html·image/svg+xml 을 앱 도메인에서 inline 으로
# 열면 메일 내 스크립트가 로그인 세션으로 실행된다(저장형 XSS). 따라서 목록 외 형식은 inline 요청이어도 다운로드로 전송한다.
from app.files.serve_safety import INLINE_SAFE_TYPES, inline_allowed  # noqa: E402,F401


def attachment_disposition(filename: str | None, inline: bool = False, content_type: str | None = None) -> str:
    """Content-Disposition 값을 생성한다.

    - 기본은 `attachment`(다운로드). 미리보기(PDF 모달·이미지 썸네일)는 `inline`.
    - `content_type` 지정 시 안전 목록(INLINE_SAFE_TYPES) 외 형식은 inline 요청이어도 attachment 로 전송한다.
    - 파일 이름은 따옴표·줄바꿈을 제거하고, ASCII 폴백 + RFC 5987 `filename*` 을 함께 포함한다.
    """
    safe_name = (filename or "attachment").replace('"', "").replace("\n", "").replace("\r", "")
    encoded_name = quote(safe_name, safe="")
    # 비 ASCII 문자를 _ 로 치환한 ASCII 폴백(구형 클라이언트용)
    ascii_name = safe_name.encode("ascii", "replace").decode("ascii").replace("?", "_")
    if inline and content_type is not None and not inline_allowed(content_type):
        inline = False
    kind = "inline" if inline else "attachment"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"
