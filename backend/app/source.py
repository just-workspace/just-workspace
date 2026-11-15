"""이 서버가 돌리는 프로그램의 소스가 있는 곳.

이 프로그램은 AGPL-3.0-or-later 로 배포된다. 네트워크로 서비스를 쓰는 사람도 그 서버가 돌리는 판의 소스를 얻을 수
있어야 하므로(13조), 화면(로그인 바닥글, 설정 › 앱)이 이 주소로 가는 "소스 코드" 링크를 보여 준다.

**고쳐서 서비스하는 사람은 환경변수 `JW_SOURCE_URL` 을 고친 소스의 주소로 바꿔야 한다.**
기본값은 원래 리포다(릴리스 도구의 `source_repo_url` 과 같은 값 — 테스트가 지킨다).
"""

from __future__ import annotations

DEFAULT_SOURCE_URL = "https://github.com/just-workspace/just-workspace"
LICENSE_ID = "AGPL-3.0-or-later"


def public_source_url(configured: str | None) -> str:
    """설정값을 화면에 내놓을 주소로 — http(s) 주소가 아니면 기본값."""
    url = (configured or "").strip()
    if not url.lower().startswith(("https://", "http://")) or any(ch.isspace() or ord(ch) < 32 for ch in url) \
            or any(ch in url for ch in "\"'<>") or len(url) > 2000:
        return DEFAULT_SOURCE_URL
    return url
