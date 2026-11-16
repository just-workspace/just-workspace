"""이 서버가 실행하는 프로그램의 소스 위치.

본 프로그램은 AGPL-3.0-or-later 로 배포된다. 네트워크로 서비스를 이용하는 사용자도 해당 서버가 실행하는 버전의 소스를 얻을 수
있어야 하므로(13조), 화면(로그인 바닥글, 설정 › 앱)에 이 주소로 연결되는 "소스 코드" 링크를 표시한다.

**수정하여 서비스하는 운영자는 환경변수 `JW_SOURCE_URL` 을 수정한 소스의 주소로 변경해야 한다.**
기본값은 원본 리포이다(릴리스 도구의 `source_repo_url` 과 동일 값 — 테스트로 검증한다).
"""

from __future__ import annotations

DEFAULT_SOURCE_URL = "https://github.com/just-workspace/just-workspace"
LICENSE_ID = "AGPL-3.0-or-later"


def public_source_url(configured: str | None) -> str:
    """설정값을 화면에 표시할 주소로 변환한다 — http(s) 주소가 아니면 기본값을 사용한다."""
    url = (configured or "").strip()
    if not url.lower().startswith(("https://", "http://")) or any(ch.isspace() or ord(ch) < 32 for ch in url) \
            or any(ch in url for ch in "\"'<>") or len(url) > 2000:
        return DEFAULT_SOURCE_URL
    return url
