"""AI 도구 호출 감사·한도.

- 감사: 모든 AI 도구 호출(MCP·내장 AI)을 audit_logs 에 남긴다(action="ai_tool.call").
  누가·언제·어떤 도구·출처·결과·지연. **인자 값은 남기지 않는다**(메일 본문·검색어가 개인정보일 수 있다).
  인자 이름만 남긴다. 쓰기 요청 자체는 writes.py 가 ai_write.* 로 따로 남긴다.
- 한도: 사용자당 분당 호출 수(관리자 설정 mcp.rate_limit_per_min, 기본 120). 넘으면 rate_limited(재시도 가능).
  Redis 를 못 쓰면 통과시킨다(가용성 우선 — 한도는 남용 방지용이지 보안 경계가 아니다).
"""

from __future__ import annotations

import json
import logging
import time

logger = logging.getLogger(__name__)

RATE_SETTING = "mcp.rate_limit_per_min"
DEFAULT_RATE = 120
_rate_cache: tuple[float, int] | None = None


def session():
    from app.db.session import async_session

    return async_session()


async def _rate_limit_value() -> int:
    global _rate_cache
    now = time.time()
    if _rate_cache and now - _rate_cache[0] < 60:
        return _rate_cache[1]
    val = DEFAULT_RATE
    try:
        from sqlalchemy import select

        from app.db.models import SystemSetting

        async with session() as db:
            v = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == RATE_SETTING))
        if v not in (None, ""):
            val = max(0, int(v))
    except Exception:  # noqa: BLE001
        pass
    _rate_cache = (now, val)
    return val


async def check_rate(user_id: str) -> int | None:
    """한도 초과면 다시 시도할 때까지 초를 돌려준다. 통과면 None."""
    limit = await _rate_limit_value()
    if limit <= 0:
        return None
    minute = int(time.time() // 60)
    key = f"mcp:rl:{user_id}:{minute}"
    try:
        from app.chat.redis_client import get_redis

        r = await get_redis()
        n = await r.incr(key)
        if n == 1:
            await r.expire(key, 70)
    except Exception:  # noqa: BLE001
        return None
    if n > limit:
        return 60 - int(time.time() % 60)
    return None


async def record_tool_call(*, user_id: str | None, tool: str, ok: bool, error_code: str | None,
                           latency_ms: int, source: str, client_name: str | None,
                           arg_keys: list[str], client_kind: str | None = None) -> None:
    if not user_id:
        return
    try:
        from app.db.models import AuditLog

        async with session() as db:
            db.add(AuditLog(
                actor_id=user_id, action="ai_tool.call", resource_type="ai_tool", resource_id=tool[:36],
                details=json.dumps({
                    "tool": tool, "ok": ok, "error_code": error_code, "ms": latency_ms,
                    "source": source, "client": client_name, "kind": client_kind, "args": sorted(arg_keys)[:20],
                }, ensure_ascii=False),
            ))
            await db.commit()
    except Exception:  # noqa: BLE001 — 감사 기록 실패가 도구 호출을 막으면 안 된다
        logger.debug("[mcp-audit] record failed", exc_info=True)
