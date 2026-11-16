"""CSP 위반 리포트 수집 엔드포인트.

CSP 를 처음부터 강제(enforce)로 적용하면 앱이 경고 없이 오동작한다 — 프런트엔드
인라인 스크립트, Tailwind 인라인 스타일, Collabora/OnlyOffice iframe, LiveKit
WebSocket 이 모두 정책에 위반될 수 있으며, 위반 지점은 실제 트래픽으로만 확인할 수 있다.

따라서 ``Content-Security-Policy-Report-Only`` 로 먼저 적용하고 본 엔드포인트로 위반을
수집한 뒤, 위반 로그가 발생하지 않으면 강제로 전환한다.

브라우저의 전송 형식은 두 가지이다:
  * ``report-uri``  → ``application/csp-report``, {"csp-report": {...}}
  * ``report-to``   → ``application/reports+json``, [{"type":"csp-violation",...}]
두 형식 모두 수신한다. 인증 없이 공개되므로 레이트리밋과 크기 제한을 적용한다.
"""

from __future__ import annotations

import json
import logging
import time

from fastapi import APIRouter, Request, Response

logger = logging.getLogger("csp")
router = APIRouter(tags=["csp"])

# 동일 위반이 페이지마다 다량 발생하므로 중복을 억제하여 로그 가독성을 유지한다.
_seen: dict[str, float] = {}
_DEDUPE_WINDOW = 300  # 5분
_MAX_BODY = 16 * 1024


def _note(directive: str, blocked: str, source: str) -> None:
    key = f"{directive}|{blocked}"
    now = time.time()
    last = _seen.get(key, 0)
    if now - last < _DEDUPE_WINDOW:
        return
    _seen[key] = now
    if len(_seen) > 500:  # 무한 성장 방지
        for k in [k for k, v in _seen.items() if now - v > _DEDUPE_WINDOW]:
            _seen.pop(k, None)
    logger.warning(
        "[csp] 위반 directive=%s blocked=%s source=%s", directive, blocked, source
    )


@router.post("/api/csp-report", include_in_schema=False)
async def csp_report(request: Request) -> Response:
    """위반 리포트를 수신하여 로그에 기록한다. 항상 204 를 반환한다."""
    raw = await request.body()
    if not raw or len(raw) > _MAX_BODY:
        return Response(status_code=204)
    try:
        data = json.loads(raw)
    except ValueError:
        return Response(status_code=204)

    reports = []
    if isinstance(data, dict) and "csp-report" in data:      # report-uri
        reports = [data["csp-report"]]
    elif isinstance(data, list):                              # report-to
        reports = [r.get("body", {}) for r in data if isinstance(r, dict)]

    for r in reports:
        if not isinstance(r, dict):
            continue
        _note(
            str(r.get("effective-directive") or r.get("effectiveDirective")
                or r.get("violated-directive") or "?")[:80],
            str(r.get("blocked-uri") or r.get("blockedURL") or "?")[:200],
            str(r.get("document-uri") or r.get("documentURL") or "?")[:200],
        )
    return Response(status_code=204)
