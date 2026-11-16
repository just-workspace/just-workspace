"""설치 관리자 내부 API 클라이언트.

설치 관리자는 설치 완료 후에도 컨테이너로 상주하며 내부망에서만 접근 가능한 API 를 제공한다(docs/installer.md 의
"내부 API"). 브라우저는 해당 API 에 접근할 수 없으므로, 관리자 권한을 확인한 backend 가 대리 호출한다.

- 주소와 공유 키는 환경변수 `JW_INSTALLER_URL` · `JW_INSTALLER_KEY`(설치 관리자가 `.env` 에 기록한다).
  둘 중 하나라도 비어 있으면 설치 관리자 없이 구성한 설치이다 — 모든 호출이 `installer_unavailable` 이다.
- 오류는 전부 `InstallerError(status, code, vars)` 로 변환한다. 화면은 code 로 문구를 선택한다.
- 요청·응답 본문은 로그에 기록하지 않는다(SMTP 비밀번호·AI 키가 포함된다). 기록 대상은 경로와 상태 코드뿐이다.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

ENV_URL = "JW_INSTALLER_URL"
ENV_KEY = "JW_INSTALLER_KEY"
KEY_HEADER = "X-JW-Installer-Key"

DEFAULT_TIMEOUT = 15.0
PROBE_TIMEOUT = 40.0       # 연결 확인은 설치 관리자가 외부 서버에 접속을 시도하는 시간까지 대기

#: 테스트에서 가짜 transport 로 교체. None 이면 실제 네트워크 사용.
transport: httpx.AsyncBaseTransport | None = None


class InstallerError(Exception):
    """설치 관리자 호출 실패 — 화면에 그대로 전달되는 `{code, vars}` 와 HTTP 상태."""

    def __init__(self, status: int, code: str, vars: dict | None = None):
        super().__init__(code)
        self.status = status
        self.code = code
        self.vars = vars or {}

    def as_dict(self) -> dict:
        return {"code": self.code, "vars": self.vars}


def base_url() -> str:
    return os.environ.get(ENV_URL, "").strip().rstrip("/")


def shared_key() -> str:
    return os.environ.get(ENV_KEY, "").strip()


def configured() -> bool:
    return bool(base_url() and shared_key())


def _convert(status: int, body: Any) -> InstallerError:
    """설치 관리자의 오류 응답 → InstallerError."""
    code = body.get("code") if isinstance(body, dict) else None
    vars_ = body.get("vars") if isinstance(body, dict) else None
    vars_ = vars_ if isinstance(vars_, dict) else {}
    if not isinstance(code, str) or not code:
        # 설치 관리자가 생성한 오류가 아님 — 해당 경로가 없는 설치 관리자(404)이거나 예상하지 못한 응답
        if status in (404, 405):
            return InstallerError(501, "installer_unsupported")
        return InstallerError(502, "installer_error", {"status": status})
    if status == 404 and code == "not_found":
        # 공유 키가 불일치하거나 backend 가 내부 대역 밖에서 호출한 경우 — 설치 관리자는 사유를 숨기고 404 를 반환
        return InstallerError(502, "installer_rejected")
    if status >= 500:
        return InstallerError(502, "installer_error", {"status": status, "cause": code})
    return InstallerError(status, code, vars_)


async def request(method: str, path: str, *, json: Any = None, params: dict | None = None,
                  timeout: float = DEFAULT_TIMEOUT) -> Any:
    """내부 API 를 호출하고 JSON 본문을 반환한다. 실패 시 InstallerError 예외가 발생한다."""
    if not configured():
        raise InstallerError(503, "installer_unavailable")
    try:
        async with httpx.AsyncClient(base_url=base_url(), timeout=timeout, transport=transport,
                                     follow_redirects=False) as client:
            response = await client.request(method, path, json=json, params=params,
                                            headers={KEY_HEADER: shared_key()})
    except httpx.TimeoutException:
        logger.warning("[system] 설치 관리자 응답 없음 — %s %s", method, path)
        raise InstallerError(504, "installer_timeout") from None
    except httpx.HTTPError as e:
        logger.warning("[system] 설치 관리자에 닿지 못함 — %s %s (%s)", method, path, type(e).__name__)
        raise InstallerError(503, "installer_unreachable") from None
    try:
        body = response.json()
    except ValueError:
        body = None
    if response.status_code >= 400:
        logger.info("[system] 설치 관리자 %s %s → %s", method, path, response.status_code)
        raise _convert(response.status_code, body)
    if body is None:
        raise InstallerError(502, "installer_error", {"status": response.status_code})
    return body
