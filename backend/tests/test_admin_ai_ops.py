"""관리자 › AI 운영 — 사용량 확장·감사 필터/CSV·정책(보관·로컬 전용)·피드백 목록/스냅샷/정리 (시안 F1·F2·I1·I2)."""

import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.ai import config as ai_config
from app.ai import feedback_admin as fa
from app.ai import ops_retention
from app.ai import router as ai_router
from app.ai.models import AIConversation, AIMessage, AIMessageFeedback
from app.db.models import AuditLog, McpWriteRequest, User
from app.mcp import usage_router
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)

NOW = datetime.now(timezone.utc)


def _call(actor, tool, ok=True, source="ai", code=None, at=None, kind=None):
    return AuditLog(actor_id=actor, action="ai_tool.call", resource_type="ai_tool", resource_id=tool,
                    details=json.dumps({"tool": tool, "ok": ok, "error_code": code, "ms": 10, "source": source,
                                        "client": "내장 AI", "kind": kind, "args": ["q"]}, ensure_ascii=False),
                    created_at=at or NOW)


@pytest.fixture()
async def env(db):
    root = await db.get(User, "root")
    alice = await db.get(User, "alice")
    return {"db": db, "root": root, "alice": alice}


# ── 사용량 확장 ──────────────────────────────────────────────
async def test_usage_daily_questions_writes_summary(env):
    db = env["db"]
    conv = AIConversation(user_id="alice", title="t")
    db.add(conv)
    await db.commit()
    for _ in range(3):
        db.add(AIMessage(conversation_id=conv.id, user_id="alice", role="user", content="q"))
    db.add_all([_call("alice", "mail_search"), _call("alice", "mail_search", ok=False, code="forbidden"),
                _call("bob", "files_read", source="mcp")])
    exp = NOW + timedelta(minutes=5)
    db.add_all([
        McpWriteRequest(id="wr_1", user_id="alice", tool="files_mkdir", risk="low", status="executed", source="ai", expires_at=exp),
        McpWriteRequest(id="wr_2", user_id="alice", tool="files_mkdir", risk="low", status="undone", source="ai", expires_at=exp,
                        after_untrusted=True),
        McpWriteRequest(id="wr_3", user_id="alice", tool="mail_send", risk="high", status="rejected", source="mcp", expires_at=exp),
        McpWriteRequest(id="wr_4", user_id="alice", tool="mail_send", risk="high", status="expired", source="mcp", expires_at=exp),
    ])
    await db.commit()
    out = await usage_router.ai_usage(days=7, admin=env["root"], db=db)
    assert len(out["daily"]) == 7 and out["daily"][-1]["questions"] == 3 and out["daily"][-1]["tool_calls"] == 3
    t = out["totals"]
    assert t["questions"] == 3 and t["connector_calls"] == 1 and t["builtin_calls"] == 2 and t["tool_failures"] == 1
    assert t["users_total"] == 3
    ws = out["writes_summary"]
    assert ws["low"]["executed"] == 2 and ws["low"]["undone"] == 1 and ws["low_after_untrusted"] == 1
    assert ws["high"]["rejected"] == 1 and ws["high"]["expired"] == 1 and ws["untrusted_window_min"] == 15


# ── 감사 로그 필터·CSV ────────────────────────────────────────
async def test_audit_filters_and_csv(env):
    db = env["db"]
    db.add_all([_call("alice", "mail_search"), _call("alice", "files_read", ok=False, code="forbidden"),
                _call("bob", "=cmd", source="mcp", kind="claude_app"),
                _call("alice", "old_tool", at=NOW - timedelta(days=40))])
    db.add(AuditLog(actor_id="alice", action="ai_write.rejected", resource_type="ai_write", resource_id="wr_x",
                    details=json.dumps({"tool": "mail_send", "risk": "high", "source": "mcp", "status": "rejected"})))
    db.add(AuditLog(actor_id="alice", action="user.approve", resource_type="user", resource_id="x", details="{}"))
    await db.commit()
    a = usage_router.ai_audit
    base = dict(limit=100, cursor="", user_id="", tool="", admin=env["root"], db=db)
    out = await a(**base)
    assert {i["action"] for i in out["items"]} == {"ai_tool.call", "ai_write.rejected"}  # 다른 감사 행은 안 보임
    assert out["retention_years"] == 1
    rej = next(i for i in out["items"] if i["action"] == "ai_write.rejected")
    assert rej["tool"] == "mail_send" and rej["result"] == "rejected" and rej["code"] == "rejected_by_user"
    assert all(i["user_name"] in ("alice", "bob") for i in out["items"])
    assert {i["tool"] for i in (await a(**base, failed_only=True))["items"]} == {"files_read"}
    assert {i["tool"] for i in (await a(**base, source="connector"))["items"]} == {"=cmd", "mail_send"}
    assert {i["tool"] for i in (await a(**base, q="bob"))["items"]} == {"=cmd"}
    assert {i["tool"] for i in (await a(**base, q="mail"))["items"]} == {"mail_search", "mail_send"}
    assert "old_tool" not in {i["tool"] for i in (await a(**base, days=30))["items"]}
    resp = await usage_router.ai_audit_csv(user_id="", tool="", q="", source="connector", failed_only=False, days=0,
                                          admin=env["root"], db=db)
    body = resp.body.decode("utf-8-sig")
    assert body.splitlines()[0] == "at,user,tool,source,client,result,error_code"
    assert "'=cmd" in body and '"q"' not in body  # 수식 주입 방지, 인자 이름도 없음


# ── 정책: 보관·로컬 전용 ─────────────────────────────────────
async def test_governance_retention_and_local_only(env):
    db = env["db"]
    g = (await ai_config.get_ai_config(db))["governance"]
    assert g["audit_retention_years"] == 1 and g["local_only"] is False
    await ai_config.set_governance(db, audit_retention_years=3, local_only=True)
    g = (await ai_config.get_ai_config(db))["governance"]
    assert g["audit_retention_years"] == 3 and g["local_only"] is True
    with pytest.raises(ValueError):
        await ai_config.set_governance(db, audit_retention_years=5)
    # 로컬 전용이면 외부 제공자는 해석되지 않는다
    await ai_config.set_ai_config(db, kind="anthropic", model="m", api_key="k")
    assert await ai_config.resolve_provider(db) is None
    await ai_config.set_ai_config(db, kind="ollama", model="m", base_url="http://localhost:11434")
    assert (await ai_config.resolve_provider(db)).kind == "ollama"
    await ai_config.set_governance(db, local_only=False)
    await ai_config.set_ai_config(db, kind="anthropic", model="m")
    assert (await ai_config.resolve_provider(db)).kind == "anthropic"
    # 화면 API 로도
    r = await ai_router.put_governance(ai_router.GovernanceUpdate(audit_retention_years=2), user=env["root"], db=db)
    assert r["governance"]["audit_retention_years"] == 2
    with pytest.raises(HTTPException) as ei:
        await ai_router.put_governance(ai_router.GovernanceUpdate(audit_retention_years=4), user=env["root"], db=db)
    assert ei.value.status_code == 400


async def test_purge_ai_audit_respects_years_and_other_actions(env):
    db = env["db"]
    old = NOW - timedelta(days=400)
    db.add_all([_call("alice", "a", at=old), _call("alice", "b", at=NOW - timedelta(days=100)),
                AuditLog(actor_id="alice", action="ai_feedback.view", resource_id="f", details="{}", created_at=old),
                AuditLog(actor_id="alice", action="user.approve", resource_id="x", details="{}", created_at=old)])
    await db.commit()

    @asynccontextmanager
    async def _s():
        yield db
    out = await ops_retention.run_once(_s)
    assert out["audit"] == 2
    left = {r.action + ":" + (r.resource_id or "") for r in (await db.execute(select(AuditLog))).scalars().all()}
    assert left == {"ai_tool.call:b", "user.approve:x"}
    await ai_config.set_governance(db, audit_retention_years=2)
    db.add(_call("alice", "c", at=old))
    await db.commit()
    assert (await ops_retention.run_once(_s))["audit"] == 0  # 2년 보관이면 400일 전 행은 남는다


# ── 피드백 ───────────────────────────────────────────────────
async def _feedback(db, **kw):
    f = AIMessageFeedback(message_id=kw.pop("message_id", "m-x"), conversation_id=kw.pop("conversation_id", "c-x"),
                          user_id=kw.pop("user_id", "alice"), rating=kw.pop("rating", "down"), **kw)
    db.add(f)
    await db.commit()
    return f


async def test_feedback_list_filters_and_privacy(env):
    db = env["db"]
    conv = AIConversation(user_id="alice", title="t")
    db.add(conv)
    await db.commit()
    m = AIMessage(conversation_id=conv.id, user_id="alice", role="assistant", content="비밀 답변",
                  meta=json.dumps({"steps": [{"id": "st1", "tool": "mail_search"}, {"id": "st2", "tool": "files_read"}]}))
    db.add(m)
    await db.commit()
    await _feedback(db, message_id=m.id, conversation_id=conv.id, reasons='["wrong_source"]', comment="인용 틀림",
                    conversation_snapshot=json.dumps([{"role": "user", "content": "비밀 질문"},
                                                      {"role": "assistant", "content": "비밀 답변"}], ensure_ascii=False))
    await _feedback(db, user_id="bob", reasons='["too_long"]')
    await _feedback(db, rating="up")
    await _feedback(db, reasons='["inaccurate"]', updated_at=NOW - timedelta(days=40))
    lf = fa.list_feedback
    base = dict(limit=50, cursor="", admin=env["root"], db=db)
    out = await lf(**base)
    assert out["total"] == 2 and len(out["items"]) == 2  # 👎 만, 기간 30일
    assert out["reason_counts"] == {"wrong_source": 1, "too_long": 1}
    assert out["attached_total"] == 1
    first = next(i for i in out["items"] if i["reasons"] == ["wrong_source"])
    assert first["tools"] == ["mail_search", "files_read"] and first["snapshot"] == "attached"
    assert first["snapshot_expires_at"] and first["who"] in ("A", "B")
    dumped = json.dumps(out, ensure_ascii=False)
    assert "비밀" not in dumped and "alice" not in dumped and "bob" not in dumped  # 내용·사용자 id 없음
    assert [i["reasons"] for i in (await lf(**base, reason="too_long"))["items"]] == [["too_long"]]
    assert (await lf(**base, attached_only=True))["total"] == 1
    assert (await lf(**base, days=90))["total"] == 3
    with pytest.raises(HTTPException):
        await lf(**base, reason="hack")


async def test_snapshot_view_audit_delete_and_states(env):
    db = env["db"]
    snap = json.dumps([{"role": "user", "content": "비밀 질문"}, {"role": "assistant", "content": "비밀 답변"}], ensure_ascii=False)
    f = await _feedback(db, reasons='["inaccurate"]', conversation_snapshot=snap)
    out = await fa.view_snapshot(f.id, admin=env["root"], db=db)
    assert [m["content"] for m in out["messages"]] == ["비밀 질문", "비밀 답변"]
    logs = (await db.execute(select(AuditLog).where(AuditLog.action == "ai_feedback.view"))).scalars().all()
    assert len(logs) == 1 and logs[0].actor_id == "root" and logs[0].resource_id == f.id
    assert "비밀" not in logs[0].details  # 누가·어느 피드백만
    # 감사 화면에도 보인다
    au = await usage_router.ai_audit(limit=10, cursor="", user_id="", tool="", admin=env["root"], db=db)
    assert au["items"][0]["action"] == "ai_feedback.view" and au["items"][0]["result"] == "viewed"
    # 삭제 — 평가·이유는 남는다
    before = f.updated_at
    r = await fa.delete_snapshot(f.id, admin=env["root"], db=db)
    assert r["snapshot"] == "admin_deleted"
    await db.refresh(f)
    assert f.conversation_snapshot is None and f.snapshot_state == "admin_deleted" and f.rating == "down"
    assert f.updated_at.replace(tzinfo=None) == before.replace(tzinfo=None)  # 통계 기간 안 흔들림
    with pytest.raises(HTTPException) as ei:
        await fa.view_snapshot(f.id, admin=env["root"], db=db)
    assert ei.value.status_code == 410 and ei.value.detail["code"] == "admin_deleted"
    assert len((await db.execute(select(AuditLog).where(AuditLog.action == "ai_feedback.snapshot_delete"))).scalars().all()) == 1
    with pytest.raises(HTTPException) as ei:
        await fa.view_snapshot("nope", admin=env["root"], db=db)
    assert ei.value.status_code == 404


async def test_snapshot_expiry_and_conversation_delete(env):
    db = env["db"]
    old = await _feedback(db, conversation_snapshot="[]", updated_at=NOW - timedelta(days=91), comment="의견")
    fresh = await _feedback(db, conversation_snapshot="[]", updated_at=NOW - timedelta(days=10))
    none = await _feedback(db, updated_at=NOW - timedelta(days=200))
    assert await fa.expire_snapshots(db) == 1
    for x in (old, fresh, none):
        await db.refresh(x)
    assert old.conversation_snapshot is None and old.snapshot_state == "expired" and old.comment == "의견"
    assert fresh.conversation_snapshot == "[]" and none.snapshot_state is None
    # 사용자가 대화를 지우면 "사용자가 지움"(첨부 없던 행은 그대로 '첨부 안 함')
    conv = AIConversation(user_id="alice", title="t")
    db.add(conv)
    await db.commit()
    a = await _feedback(db, conversation_id=conv.id, conversation_snapshot="[]")
    b = await _feedback(db, conversation_id=conv.id)
    await ai_router.delete_conversation.__wrapped__(conv.id, user=env["alice"], db=db)
    await db.refresh(a)
    await db.refresh(b)
    assert fa.snapshot_status(a) == "conversation_deleted" and fa.snapshot_status(b) == "none"
