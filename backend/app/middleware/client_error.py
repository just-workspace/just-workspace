"""화면 측 오류 수집 — 오류 화면에 표시된 요청 번호로 서버 로그를 검색할 수 있도록 한다.

서버에서 발생한 오류(500)는 RequestIdMiddleware 가 요청 번호와 트레이스백을 기록한다. 화면 측 오류
(렌더 실패·화면 조각 로드 실패 등)는 브라우저가 동일 형식(xxxx-xxxx)의 번호를 생성하여 표시하므로,
해당 번호와 오류 내용을 여기서 수신하여 컨테이너 로그(stdout)에 기록한다.

로그인 전 화면에서도 발생하므로 인증 없이 허용한다. 크기 제한·번호 형식 검사·중복 억제를 적용한다.
"""

from __future__ import annotations

import json
import logging
import re
import time

from fastapi import APIRouter, Request, Response

logger = logging.getLogger("client_error")
router = APIRouter(tags=["client-error"])

_MAX_BODY = 16 * 1024
_RID = re.compile(r"^[0-9a-f]{4}-[0-9a-f]{4}$")
_seen: dict[str, float] = {}
_DEDUPE_WINDOW = 600


def _clip(v: object, n: int) -> str:
    s = v if isinstance(v, str) else ""
    return s[:n].replace("\r", " ")


@router.post("/api/client-error", include_in_schema=False)
async def client_error(request: Request) -> Response:
    """항상 204. 형식이 올바르지 않거나 동일 번호가 다시 수신되면 무시한다."""
    raw = await request.body()
    if not raw or len(raw) > _MAX_BODY:
        return Response(status_code=204)
    try:
        data = json.loads(raw)
    except ValueError:
        return Response(status_code=204)
    if not isinstance(data, dict):
        return Response(status_code=204)
    rid = _clip(data.get("request_id"), 9)
    if not _RID.match(rid):
        return Response(status_code=204)

    now = time.time()
    if now - _seen.get(rid, 0) < _DEDUPE_WINDOW:
        return Response(status_code=204)
    _seen[rid] = now
    if len(_seen) > 1000:  # 무한 성장 방지
        for k in [k for k, v in _seen.items() if now - v > _DEDUPE_WINDOW]:
            _seen.pop(k, None)

    status = data.get("status")
    logger.warning(
        "[client-error] req=%s status=%s url=%s ua=%s msg=%s\n%s",
        rid,
        status if isinstance(status, int) else "?",
        _clip(data.get("url"), 500),
        _clip(request.headers.get("user-agent"), 200),
        _clip(data.get("message"), 500),
        _clip(data.get("stack"), 4000),
    )
    return Response(status_code=204)
