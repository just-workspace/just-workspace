"""메일 첨부 HTTP 헤더 보조 — 라우터와 분리해 두어 FastAPI 없이도 단위 테스트가 된다."""

from urllib.parse import quote

# 브라우저 안에서 열어 보여 줘도 안전한 형식만 inline 을 허락한다 — 규칙은 파일 서빙 공용(serve_safety).
# 첨부의 Content-Type 은 보낸 사람이 정한다 — text/html·image/svg+xml 을 앱 도메인에서 inline 으로
# 열면 메일 속 스크립트가 로그인 세션으로 돈다(저장형 XSS). 그래서 목록 밖이면 inline 을 요청해도 다운로드로 내린다.
from app.files.serve_safety import INLINE_SAFE_TYPES, inline_allowed  # noqa: E402,F401


def attachment_disposition(filename: str | None, inline: bool = False, content_type: str | None = None) -> str:
    """Content-Disposition 값을 만든다.

    - 기본은 `attachment`(다운로드). 미리보기(PDF 모달·이미지 썸네일)는 `inline`.
    - `content_type` 을 주면 안전 목록(INLINE_SAFE_TYPES) 밖의 형식은 inline 요청이어도 attachment 로 내린다.
    - 파일 이름은 따옴표·줄바꿈을 지우고, ASCII 폴백 + RFC 5987 `filename*` 을 함께 싣는다.
    """
    safe_name = (filename or "attachment").replace('"', "").replace("\n", "").replace("\r", "")
    encoded_name = quote(safe_name, safe="")
    # 비 ASCII 글자는 _ 로 바꾼 ASCII 폴백(구형 클라이언트용)
    ascii_name = safe_name.encode("ascii", "replace").decode("ascii").replace("?", "_")
    if inline and content_type is not None and not inline_allowed(content_type):
        inline = False
    kind = "inline" if inline else "attachment"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"
