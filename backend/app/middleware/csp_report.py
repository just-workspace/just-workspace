"""CSP 위반 리포트 수집 엔드포인트.

CSP 를 처음부터 강제(enforce)로 켜면 앱이 조용히 깨진다 — 프런트엔드
인라인 스크립트, Tailwind 인라인 스타일, Collabora/OnlyOffice iframe, LiveKit
WebSocket 이 전부 정책에 걸릴 수 있고, 어디가 걸리는지는 실제 트래픽을 봐야 안다.

그래서 ``Content-Security-Policy-Report-Only`` 로 먼저 띄우고 여기로 위반을 모은
뒤, 로그가 조용해지면 강제로 전환한다.

브라우저는 두 가지 형식으로 보낸다:
  * ``report-uri``  → ``application/csp-report``, {"csp-report": {...}}
  * ``report-to``   → ``application/reports+json``, [{"type":"csp-violation",...}]
둘 다 받는다. 인증 없이 열려 있으므로 레이트리밋과 크기 제한을 둔다.
"""

from __future__ import annotations

import json
import logging
import time

from fastapi import APIRouter, Request, Response

logger = logging.getLogger("csp")
router = APIRouter(tags=["csp"])

# 같은 위반이 페이지마다 쏟아지므로 중복은 눌러서 로그를 읽을 수 있게 한다.
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
    """위반 리포트를 받아 로그로 남긴다. 항상 204 를 돌려준다."""
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
