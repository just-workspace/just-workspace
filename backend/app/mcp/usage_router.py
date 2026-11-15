"""관리자 › AI 운영 — 사용량·도구 품질·감사 로그.

GET /api/admin/ai/usage?days=7     사용자·그룹·도구·출처별 호출 수, 성공률, 응답 시간, 일별 추이, 쓰기 요청 현황
GET /api/admin/ai/audit?cursor=    AI 도구 호출·쓰기 감사 기록(최신순). 인자 값은 기록하지 않는다(이름만).
GET /api/admin/ai/audit.csv        같은 조건의 CSV 내보내기(최대 50,000행)
"""

import csv
import io
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.router import require_admin
from app.db.models import AuditLog, McpWriteRequest, User
from app.db.session import get_db

router = APIRouter(prefix="/api/admin/ai", tags=["admin-ai"])

_MAX_ROWS = 200_000


def _known_tools() -> set[str]:
    from app.mcp.server import WORKSPACE_TOOLS

    return set(WORKSPACE_TOOLS)


def _pct(sorted_vals: list[int], q: float) -> int | None:
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, int(round(q * (len(sorted_vals) - 1))))
    return sorted_vals[i]


@router.get("/usage")
async def ai_usage(days: int = Query(7, ge=1, le=90), admin: User = Depends(require_admin),
                   db: AsyncSession = Depends(get_db)):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (await db.execute(
        select(AuditLog.actor_id, AuditLog.resource_id, AuditLog.details, AuditLog.created_at)
        .where(AuditLog.action == "ai_tool.call", AuditLog.created_at >= since)
        .order_by(AuditLog.created_at.desc()).limit(_MAX_ROWS)
    )).all()

    by_user: dict[str, Counter] = defaultdict(Counter)
    by_tool: dict[str, dict] = defaultdict(lambda: {"calls": 0, "fail": 0, "ms": []})
    by_source: Counter = Counter()
    daily: Counter = Counter()
    for actor, tool, details, created in rows:
        try:
            d = json.loads(details or "{}")
        except Exception:  # noqa: BLE001
            d = {}
        ok = bool(d.get("ok"))
        by_user[actor or "-"]["calls"] += 1
        if not ok:
            by_user[actor or "-"]["fail"] += 1
        t = by_tool[tool or "?"]
        t["calls"] += 1
        t["fail"] += 0 if ok else 1
        if isinstance(d.get("ms"), int):
            t["ms"].append(d["ms"])
        by_source[d.get("source") or "?"] += 1
        if created:
            daily[created.date().isoformat()] += 1

    # 질문 수(내장 AI) — 사용자 메시지
    from app.ai.models import AIMessage

    q_rows = (await db.execute(
        select(AIMessage.user_id, AIMessage.created_at).where(AIMessage.role == "user", AIMessage.created_at >= since)
        .limit(_MAX_ROWS)
    )).all()
    questions: Counter = Counter()
    daily_q: Counter = Counter()
    for uid, created in q_rows:
        questions[uid] += 1
        if created:
            daily_q[created.date().isoformat()] += 1

    uids = set(by_user) | set(questions)
    uids.discard("-")
    names = {}
    groups: dict[str, list[str]] = defaultdict(list)
    if uids:
        for u in (await db.execute(select(User.id, User.username, User.display_name).where(User.id.in_(uids)))).all():
            names[u.id] = u.display_name or u.username
        try:
            from app.groups.models import Group, GroupMember

            for uid, gname in (await db.execute(
                select(GroupMember.user_id, Group.name).join(Group, Group.id == GroupMember.group_id)
                .where(GroupMember.user_id.in_(uids))
            )).all():
                groups[uid].append(gname)
        except Exception:  # noqa: BLE001
            pass

    users_out = []
    by_group: dict[str, Counter] = defaultdict(Counter)
    for uid in uids:
        c = by_user.get(uid, Counter())
        rec = {"user_id": uid, "name": names.get(uid, uid), "groups": sorted(groups.get(uid, [])),
               "questions": int(questions.get(uid, 0)), "tool_calls": c["calls"], "tool_failures": c["fail"]}
        users_out.append(rec)
        for g in rec["groups"] or ["(그룹 없음)"]:
            by_group[g]["questions"] += rec["questions"]
            by_group[g]["tool_calls"] += rec["tool_calls"]
            by_group[g]["users"] += 1
    users_out.sort(key=lambda r: (r["tool_calls"] + r["questions"]), reverse=True)

    tools_out = []
    for name, t in by_tool.items():
        ms = sorted(t["ms"])
        tools_out.append({
            "tool": name, "calls": t["calls"], "failures": t["fail"],
            "success_rate": round(1 - t["fail"] / t["calls"], 4) if t["calls"] else None,
            "p50_ms": _pct(ms, 0.5), "p95_ms": _pct(ms, 0.95),
        })
    tools_out.sort(key=lambda r: r["calls"], reverse=True)

    w_rows = (await db.execute(
        select(McpWriteRequest.status, McpWriteRequest.risk, func.count())
        .where(McpWriteRequest.created_at >= since)
        .group_by(McpWriteRequest.status, McpWriteRequest.risk)
    )).all()
    writes = [{"status": s, "risk": r, "count": n} for s, r, n in w_rows]
    # 쓰기 현황 — 위험도별 실행·되돌림·거부·만료·실패. 되돌린 건은 실행된 뒤 되돌린 것이라 실행에도 센다.
    summary = {r: {"executed": 0, "undone": 0, "rejected": 0, "canceled": 0, "expired": 0, "failed": 0, "pending": 0}
               for r in ("low", "high")}
    for st, risk, n in w_rows:
        b = summary.get(risk)
        if b is None:
            continue
        if st in b:
            b[st] += n
        if st == "undone":
            b["executed"] += n
    low_untrusted = int((await db.scalar(
        select(func.count()).select_from(McpWriteRequest).where(
            McpWriteRequest.created_at >= since, McpWriteRequest.risk == "low",
            McpWriteRequest.after_untrusted.is_(True))
    )) or 0)
    from app.mcp.writes import UNTRUSTED_WINDOW_SEC

    # 답변 피드백 — 통계만. 이유·의견·첨부된 대화 내용은 여기서 내보내지 않는다.
    from app.ai.models import AIMessageFeedback

    fb_rows = (await db.execute(
        select(AIMessageFeedback.rating, AIMessageFeedback.reasons)
        .where(AIMessageFeedback.updated_at >= since).limit(_MAX_ROWS)
    )).all()
    fb_counts: Counter = Counter()
    fb_reasons: Counter = Counter()
    for rating, reasons in fb_rows:
        fb_counts[rating] += 1
        try:
            for r in json.loads(reasons or "[]"):
                if isinstance(r, str):
                    fb_reasons[r] += 1
        except Exception:  # noqa: BLE001
            pass

    total = len(rows)
    fails = sum(t["fail"] for t in by_tool.values())
    from app.ai.config import is_write_tool

    known = _known_tools()
    write_calls = sum(t["calls"] for name, t in by_tool.items() if name in known and is_write_tool(name))
    users_total = int((await db.scalar(select(func.count()).select_from(User).where(User.is_active.is_(True)))) or 0)
    # 일별 — 기간의 모든 날(빈 날은 0)
    today = datetime.now(timezone.utc).date()
    days_list = [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    return {
        "days": days,
        "since": since.isoformat(),
        "totals": {
            "tool_calls": total,
            "tool_success_rate": round(1 - fails / total, 4) if total else None,
            "questions": int(sum(questions.values())),
            "connector_calls": int(by_source.get("mcp", 0)),
            "builtin_calls": int(by_source.get("ai", 0)),
            "write_tool_calls": write_calls,
            "tool_failures": fails,
            "active_users": len(uids),
            "users_total": users_total,
            "truncated": total >= _MAX_ROWS,
        },
        "by_source": dict(by_source),
        "daily": [{"date": d, "tool_calls": daily.get(d, 0), "questions": daily_q.get(d, 0)} for d in days_list],
        "users": users_out,
        "groups": [{"group": g, **dict(c)} for g, c in sorted(by_group.items(), key=lambda kv: -kv[1]["tool_calls"])],
        "tools": tools_out,
        "writes": writes,
        "writes_summary": {**summary, "low_after_untrusted": low_untrusted,
                           "untrusted_window_min": UNTRUSTED_WINDOW_SEC // 60},
        "feedback": {"up": fb_counts.get("up", 0), "down": fb_counts.get("down", 0), "reasons": dict(fb_reasons)},
    }


AUDIT_ACTIONS = ("ai_tool.call", "ai_feedback.view", "ai_feedback.snapshot_delete")


def _like_escape(v: str) -> str:
    return v.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def _audit_query(db: AsyncSession, *, user_id: str, tool: str, q: str, source: str, failed_only: bool,
                       days: int):
    stmt = select(AuditLog).where(or_(AuditLog.action.in_(AUDIT_ACTIONS), AuditLog.action.like("ai_write.%")))
    days = max(0, min(int(days or 0), 1100))
    if days:
        stmt = stmt.where(AuditLog.created_at >= datetime.now(timezone.utc) - timedelta(days=days))
    if user_id:
        stmt = stmt.where(AuditLog.actor_id == user_id)
    if tool:
        stmt = stmt.where(AuditLog.resource_id == tool[:36])
    q = (q or "").strip()[:100]
    if q:
        pat = f"%{_like_escape(q.lower())}%"
        uids = [r[0] for r in (await db.execute(select(User.id).where(or_(
            func.lower(User.username).like(pat, escape="\\"),
            func.lower(func.coalesce(User.display_name, "")).like(pat, escape="\\"))).limit(500))).all()]
        conds = [func.lower(AuditLog.resource_id).like(pat, escape="\\"),
                 AuditLog.details.like(f'%"tool": "%{_like_escape(q)}%', escape="\\")]
        if uids:
            conds.append(AuditLog.actor_id.in_(uids))
        stmt = stmt.where(or_(*conds))
    # 출처 — 내장 AI(source=ai) · AI 커넥터(source=mcp: claude.ai·개인 토큰)
    if source == "builtin":
        stmt = stmt.where(AuditLog.details.like('%"source": "ai"%'))
    elif source == "connector":
        stmt = stmt.where(AuditLog.details.like('%"source": "mcp"%'))
    if failed_only:
        stmt = stmt.where(or_(
            (AuditLog.action == "ai_tool.call") & AuditLog.details.like('%"ok": false%'),
            AuditLog.action == "ai_write.failed"))
    return stmt


def _audit_row(r: AuditLog, names: dict[str, str]) -> dict:
    try:
        d = json.loads(r.details or "{}")
    except Exception:  # noqa: BLE001
        d = {}
    if r.action == "ai_tool.call":
        result = "ok" if d.get("ok") else "failed"
        code = d.get("error_code") or (None if d.get("ok") else "error")
    elif r.action.startswith("ai_write."):
        # executed·failed·rejected·expired·canceled·undone·requested·edited
        result = r.action.split(".", 1)[1]
        code = {"rejected": "rejected_by_user", "expired": "expired", "failed": "failed"}.get(result)
    else:  # ai_feedback.* — 관리자 열람·삭제 기록(내용 없음)
        result = "viewed" if r.action == "ai_feedback.view" else "deleted"
        code = None
    return {**d, "at": r.created_at.isoformat() if r.created_at else None, "user_id": r.actor_id,
            "user_name": names.get(r.actor_id or "", r.actor_id), "action": r.action, "target": r.resource_id,
            "tool": d.get("tool") or (r.action if r.action.startswith("ai_feedback.") else r.resource_id),
            "result": result, "code": code}


async def _names(db: AsyncSession, ids: set) -> dict[str, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {u.id: (u.display_name or u.username) for u in
            (await db.execute(select(User.id, User.username, User.display_name).where(User.id.in_(ids)))).all()}


async def _retention_years(db: AsyncSession) -> int:
    from app.ai.config import AUDIT_RETENTION_KEY, _get, audit_retention_years

    return audit_retention_years(await _get(db, AUDIT_RETENTION_KEY, "1"))


@router.get("/audit")
async def ai_audit(limit: int = Query(100, ge=1, le=500), cursor: str = Query(""),
                   user_id: str = Query(""), tool: str = Query(""), q: str = "",
                   source: str = "", failed_only: bool = False, days: int = 0,
                   admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    try:
        offset = max(0, int(cursor)) if cursor else 0
    except ValueError:
        offset = 0
    stmt = await _audit_query(db, user_id=user_id, tool=tool, q=q, source=source, failed_only=failed_only, days=days)
    rows = (await db.execute(stmt.order_by(AuditLog.created_at.desc()).offset(offset).limit(limit + 1))).scalars().all()
    more = len(rows) > limit
    rows = rows[:limit]
    names = await _names(db, {r.actor_id for r in rows})
    return {"items": [_audit_row(r, names) for r in rows], "has_more": more,
            "next_cursor": str(offset + len(rows)) if more else None,
            "retention_years": await _retention_years(db)}


_CSV_MAX = 50_000


def _csv_safe(v: str) -> str:
    """스프레드시트 수식 주입 방지 — =,+,-,@ 로 시작하는 칸은 앞에 ' 를 붙인다."""
    return "'" + v if v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


@router.get("/audit.csv")
async def ai_audit_csv(user_id: str = "", tool: str = "", q: str = "",
                       source: str = "", failed_only: bool = False, days: int = 0,
                       admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """감사 로그 CSV — 화면과 같은 열(시각·사용자·도구·출처·결과·오류 코드). 인자 이름도 넣지 않는다."""
    stmt = await _audit_query(db, user_id=user_id, tool=tool, q=q, source=source, failed_only=failed_only, days=days)
    rows = (await db.execute(stmt.order_by(AuditLog.created_at.desc()).limit(_CSV_MAX))).scalars().all()
    names = await _names(db, {r.actor_id for r in rows})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["at", "user", "tool", "source", "client", "result", "error_code"])
    for r in rows:
        x = _audit_row(r, names)
        w.writerow([x["at"] or "", _csv_safe(str(x["user_name"] or "")), _csv_safe(str(x["tool"] or "")),
                    x.get("source") or "", _csv_safe(str(x.get("client") or "")), x["result"], x["code"] or ""])
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="ai-audit.csv"'})
