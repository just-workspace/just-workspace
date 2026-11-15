"""관리자 › AI 운영 › 피드백.

GET    /api/admin/ai/feedback?reason=&attached_only=&days=&cursor=   별로예요 목록(평가·이유·한 줄 의견·쓴 도구·첨부 상태)
GET    /api/admin/ai/feedback/{id}/snapshot                          첨부된 대화 보기 — 열람은 감사 로그(ai_feedback.view)
DELETE /api/admin/ai/feedback/{id}/snapshot                          스냅샷만 삭제(평가·이유·의견은 남음)

개인정보 원칙:
- 대화 내용(conversation_snapshot)은 사용자가 직접 첨부를 고른 경우에만 있고, 90일 뒤 스냅샷만 지운다
  (app.ai.ops_retention). 이유·의견·평가는 통계로 남는다.
- 목록은 누가 보냈는지 보이지 않는다(쪽 안에서만 "사용자 A·B…"로 구분). 사용자 id 는 내보내지 않는다.
- 열람·삭제 감사 기록에는 누가(관리자)·어느 피드백만 남기고 내용 값은 넣지 않는다.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.router import require_admin
from app.ai.models import AIMessage, AIMessageFeedback
from app.db.models import AuditLog, User
from app.db.session import get_db

router = APIRouter(prefix="/api/admin/ai", tags=["admin-ai"])

SNAPSHOT_TTL_DAYS = 90
REASONS = ("inaccurate", "wrong_source", "ignored_instructions", "too_long", "too_short", "other")
_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def snapshot_status(f: AIMessageFeedback) -> str:
    """attached · expired · conversation_deleted · admin_deleted · none."""
    if f.conversation_snapshot is not None:
        return "attached"
    return f.snapshot_state or "none"


def _reasons(raw: str | None) -> list[str]:
    try:
        v = json.loads(raw or "[]")
    except Exception:  # noqa: BLE001
        return []
    return [r for r in v if isinstance(r, str)] if isinstance(v, list) else []


def _tools_of(meta: str | None) -> list[str]:
    """답변 진행 단계에 남은 도구 이름(meta.steps[].tool). 옛 답변은 없다."""
    try:
        steps = (json.loads(meta or "{}") or {}).get("steps") or []
    except Exception:  # noqa: BLE001
        return []
    out: list[str] = []
    for st in steps:
        t = st.get("tool") if isinstance(st, dict) else None
        if isinstance(t, str) and t not in out:
            out.append(t)
    return out


async def _audit(db: AsyncSession, admin: User, action: str, fb_id: str) -> None:
    db.add(AuditLog(actor_id=admin.id, action=action, resource_type="ai_feedback", resource_id=fb_id[:36],
                    details=json.dumps({"feedback_id": fb_id}, ensure_ascii=False)))


def _base(days: int, reason: str, attached_only: bool):
    stmt = select(AIMessageFeedback).where(AIMessageFeedback.rating == "down")
    if days:
        stmt = stmt.where(AIMessageFeedback.updated_at >= _now() - timedelta(days=days))
    if reason:
        # reasons 는 JSON 배열 문자열 — 키는 고정 목록이라 따옴표 포함 일치로 충분하다
        stmt = stmt.where(AIMessageFeedback.reasons.like(f'%"{reason}"%'))
    if attached_only:
        stmt = stmt.where(AIMessageFeedback.conversation_snapshot.is_not(None))
    return stmt


@router.get("/feedback")
async def list_feedback(limit: int = Query(50, ge=1, le=200), cursor: str = "", reason: str = "",
                        attached_only: bool = False, days: int = 30,
                        admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    if reason and reason not in REASONS:
        raise HTTPException(status_code=400, detail=f"알 수 없는 이유: {reason}")
    days = max(0, min(int(days or 0), 365))
    try:
        offset = max(0, int(cursor)) if cursor else 0
    except ValueError:
        offset = 0
    stmt = _base(days, reason, attached_only)
    total = int((await db.scalar(select(func.count()).select_from(stmt.subquery()))) or 0)
    rows = (await db.execute(stmt.order_by(AIMessageFeedback.updated_at.desc(), AIMessageFeedback.id)
                             .offset(offset).limit(limit + 1))).scalars().all()
    more = len(rows) > limit
    rows = rows[:limit]
    metas = {}
    ids = [r.message_id for r in rows]
    if ids:
        metas = {mid: meta for mid, meta in (await db.execute(
            select(AIMessage.id, AIMessage.meta).where(AIMessage.id.in_(ids)))).all()}
    who: dict[str, str] = {}
    items = []
    for f in rows:
        if f.user_id not in who:
            n = len(who)
            who[f.user_id] = _LETTERS[n % 26] + (str(n // 26) if n >= 26 else "")
        upd = _aware(f.updated_at)
        st = snapshot_status(f)
        items.append({
            "id": f.id, "at": upd.isoformat() if upd else None, "rating": f.rating,
            "reasons": _reasons(f.reasons), "comment": f.comment or "", "model": f.model,
            "tools": _tools_of(metas.get(f.message_id)),
            "snapshot": st,
            "snapshot_expires_at": (upd + timedelta(days=SNAPSHOT_TTL_DAYS)).isoformat() if st == "attached" and upd else None,
            "who": who[f.user_id],
        })
    # 이유별 건수(필터와 무관한 기간 전체 — 칩 메뉴 숫자)
    reason_counts: dict[str, int] = {}
    for (raw,) in (await db.execute(select(AIMessageFeedback.reasons).where(
            AIMessageFeedback.rating == "down",
            *( [AIMessageFeedback.updated_at >= _now() - timedelta(days=days)] if days else [] )).limit(200_000))).all():
        for r in _reasons(raw):
            reason_counts[r] = reason_counts.get(r, 0) + 1
    # 통계 카드 "대화 내용 첨부"(평가 무관, 기간 안 — 지금 스냅샷이 있는 것)
    att_q = select(func.count()).select_from(AIMessageFeedback).where(AIMessageFeedback.conversation_snapshot.is_not(None))
    if days:
        att_q = att_q.where(AIMessageFeedback.updated_at >= _now() - timedelta(days=days))
    attached_total = int((await db.scalar(att_q)) or 0)
    return {"items": items, "total": total, "has_more": more, "attached_total": attached_total,
            "next_cursor": str(offset + len(rows)) if more else None,
            "reason_counts": reason_counts, "snapshot_ttl_days": SNAPSHOT_TTL_DAYS}


async def _get(db: AsyncSession, fb_id: str) -> AIMessageFeedback:
    f = await db.get(AIMessageFeedback, fb_id)
    if f is None:
        raise HTTPException(status_code=404, detail="피드백을 찾을 수 없습니다")
    return f


@router.get("/feedback/{fb_id}/snapshot")
async def view_snapshot(fb_id: str, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """첨부된 대화(이 답변까지) — 읽기 전용. 볼 때마다 감사 로그에 남긴다(내용 값은 남기지 않음).
    스냅샷이 없으면 410 {code: expired|conversation_deleted|admin_deleted|none}."""
    f = await _get(db, fb_id)
    st = snapshot_status(f)
    if st != "attached":
        raise HTTPException(status_code=410, detail={"code": st, "message": "첨부된 대화가 없습니다"})
    try:
        msgs = json.loads(f.conversation_snapshot or "[]")
    except Exception:  # noqa: BLE001
        msgs = []
    await _audit(db, admin, "ai_feedback.view", f.id)
    await db.commit()
    upd = _aware(f.updated_at)
    return {
        "id": f.id, "at": upd.isoformat() if upd else None, "reasons": _reasons(f.reasons),
        "comment": f.comment or "", "model": f.model,
        "messages": [{"role": m.get("role"), "content": m.get("content") or ""} for m in msgs
                     if isinstance(m, dict) and m.get("role") in ("user", "assistant")],
        "expires_at": (upd + timedelta(days=SNAPSHOT_TTL_DAYS)).isoformat() if upd else None,
    }


@router.delete("/feedback/{fb_id}/snapshot")
async def delete_snapshot(fb_id: str, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """관리자 화면의 스냅샷만 지운다 — 사용자 대화 원본과 평가·이유·의견은 그대로. 되돌릴 수 없다."""
    f = await _get(db, fb_id)
    if f.conversation_snapshot is None:
        return {"id": f.id, "snapshot": snapshot_status(f)}
    await db.execute(update(AIMessageFeedback).where(AIMessageFeedback.id == f.id).values(
        conversation_snapshot=None, snapshot_state="admin_deleted", updated_at=AIMessageFeedback.updated_at)
        .execution_options(synchronize_session=False))
    await _audit(db, admin, "ai_feedback.snapshot_delete", f.id)
    await db.commit()
    return {"id": f.id, "snapshot": "admin_deleted"}


async def expire_snapshots(db: AsyncSession, *, now: datetime | None = None) -> int:
    """90일 지난 스냅샷만 지운다(평가·이유·의견은 유지). 통계 기간이 흔들리지 않게 updated_at 은 그대로 둔다."""
    cutoff = (now or _now()) - timedelta(days=SNAPSHOT_TTL_DAYS)
    res = await db.execute(update(AIMessageFeedback).where(
        AIMessageFeedback.conversation_snapshot.is_not(None), AIMessageFeedback.updated_at < cutoff,
    ).values(conversation_snapshot=None, snapshot_state="expired", updated_at=AIMessageFeedback.updated_at)
        .execution_options(synchronize_session=False))
    await db.commit()
    return int(res.rowcount or 0)
