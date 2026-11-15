"""화면 쪽 오류 수집 — 오류 화면이 보여 준 요청 번호로 서버 로그에서 찾을 수 있게.

서버가 낸 오류(500)는 RequestIdMiddleware 가 요청 번호와 트레이스백을 남긴다. 화면 쪽 오류
(렌더 실패·화면 조각 로드 실패 등)는 브라우저가 같은 꼴(xxxx-xxxx)의 번호를 만들어 보여 주므로,
그 번호와 오류 내용을 여기로 받아 컨테이너 로그(stdout)에 남긴다.

로그인 전 화면에서도 나므로 인증 없이 열려 있다. 크기 제한·번호 형식 검사·중복 억제를 둔다.
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
    """항상 204. 형식이 틀리거나 같은 번호가 다시 오면 조용히 버린다."""
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
