"""AI 운영 정리 작업 — 관리자 › AI 운영.

1. AI 감사 기록 보존: 정책의 1·2·3년(`ai.gov.audit_retention_years`, 기본 1년 — 개인정보 접속기록 최소 1년)을
   초과한 AI 감사 행(ai_tool.call · ai_write.* · ai_feedback.*)만 삭제한다. 다른 감사 기록(사용자 승인 등)은 변경하지 않는다.
2. 피드백 스냅샷: 첨부된 대화는 90일 후 스냅샷만 삭제한다(평가·이유·의견은 유지) — app.ai.feedback_admin.expire_snapshots.

워커 8개 중 락을 획득한 1개만 수행한다(app.jobs.lock, files/retention 과 동일한 방식). 6시간 주기.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, or_

logger = logging.getLogger(__name__)

LOCK_NAME = "ai:ops-retention"
RUN_INTERVAL = 6 * 3600
AI_AUDIT_PREFIXES = ("ai_tool.", "ai_write.", "ai_feedback.")


async def purge_ai_audit(db, years: int, *, now: datetime | None = None) -> int:
    from app.db.models import AuditLog

    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=365 * max(1, years))
    res = await db.execute(delete(AuditLog).where(
        AuditLog.created_at < cutoff,
        or_(*[AuditLog.action.like(p + "%") for p in AI_AUDIT_PREFIXES]),
    ))
    await db.commit()
    return int(res.rowcount or 0)


async def run_once(session_factory=None) -> dict:
    from app.ai.config import AUDIT_RETENTION_KEY, _get, audit_retention_years
    from app.ai.feedback_admin import expire_snapshots

    if session_factory is None:
        from app.db.session import async_session as session_factory
    async with session_factory() as db:
        years = audit_retention_years(await _get(db, AUDIT_RETENTION_KEY, "1"))
        audit_n = await purge_ai_audit(db, years)
        snap_n = await expire_snapshots(db)
    if audit_n or snap_n:
        logger.info("[ai-retention] 감사 %d행(%d년 지남) · 피드백 스냅샷 %d건(90일 지남) 정리", audit_n, years, snap_n)
    return {"audit": audit_n, "snapshots": snap_n}


async def run_ai_retention(interval_seconds: int = RUN_INTERVAL) -> None:
    from app.jobs.lock import run_exclusive

    await asyncio.sleep(180)
    while True:
        try:
            await run_exclusive(LOCK_NAME, max(60, interval_seconds - 100), run_once)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("[ai-retention] 정리 실패 — 다음 주기에 다시 시도한다")
        await asyncio.sleep(interval_seconds)
