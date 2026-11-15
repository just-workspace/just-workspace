"""설치 관리자 내부 API 클라이언트.

설치 관리자는 설치가 끝난 뒤에도 컨테이너로 남아 내부망에서만 닿는 API 를 연다(docs/installer.md 의
"내부 API"). 브라우저는 거기에 닿지 못하므로, 관리자 권한을 확인한 backend 가 대신 부른다.

- 주소와 공유 키는 환경변수 `JW_INSTALLER_URL` · `JW_INSTALLER_KEY`(설치 관리자가 `.env` 에 넣는다).
  둘 중 하나라도 비어 있으면 설치 관리자 없이 구성한 설치다 — 모든 호출이 `installer_unavailable` 이다.
- 오류는 전부 `InstallerError(status, code, vars)` 로 바꾼다. 화면은 code 로 문구를 고른다.
- 요청·응답 본문은 로그에 남기지 않는다(SMTP 비밀번호·AI 키가 지나간다). 남기는 것은 경로와 상태 코드뿐이다.
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
PROBE_TIMEOUT = 40.0       # 연결 확인은 설치 관리자가 바깥 서버에 붙어 보는 시간까지 기다린다

#: 테스트가 가짜 transport 로 바꾼다. None 이면 실제 네트워크.
transport: httpx.AsyncBaseTransport | None = None


class InstallerError(Exception):
    """설치 관리자 호출 실패 — 화면에 그대로 내려가는 `{code, vars}` 와 HTTP 상태."""

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
        # 설치 관리자가 만든 오류가 아니다 — 그 경로가 없는 설치 관리자(404)거나 예상하지 못한 응답
        if status in (404, 405):
            return InstallerError(501, "installer_unsupported")
        return InstallerError(502, "installer_error", {"status": status})
    if status == 404 and code == "not_found":
        # 공유 키가 다르거나 backend 가 내부 대역 밖에서 부른 경우 — 설치 관리자는 이유를 숨기고 404 를 준다
        return InstallerError(502, "installer_rejected")
    if status >= 500:
        return InstallerError(502, "installer_error", {"status": status, "cause": code})
    return InstallerError(status, code, vars_)


async def request(method: str, path: str, *, json: Any = None, params: dict | None = None,
                  timeout: float = DEFAULT_TIMEOUT) -> Any:
    """내부 API 를 부르고 JSON 본문을 돌려준다. 실패는 InstallerError."""
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
