"""내장 AI·MCP 구역 감사 수정 회귀.

3  동일 승인 요청을 동시에 두 번 승인해도 핸들러는 1회만 실행된다(되돌리기도 동일). 실행 중에는 거절·수정·만료 불가.
4  하루 한도 카운터는 Redis 일별 키 — 대화(행)를 삭제해도 감소하지 않는다. Redis 가 없으면 행 수로 계산.
5  연결을 해제하면 그 이전에 발급된 액세스 토큰(iat)을 거부한다.
7  타인이 작성한 글을 반환하는 읽기 도구는 신뢰 경계로 감싸고 '직전 외부 읽기' 표시를 남긴다.
"""

from datetime import timedelta

import pytest

from app.db.models import McpWriteRequest
from app.mcp import server as reg
from app.mcp import writes
from app.mcp.server import Tool, execute_tool
from tests.test_mcp_s3_writes import LOG, _ctx, env  # noqa: F401 (픽스처 재사용)
from tests.test_settings_security_p8 import db  # noqa: F401

SCOPES = frozenset({"mcp:read", "mcp:write"})


class FakeRedis:
    def __init__(self):
        self.kv: dict = {}

    async def get(self, k):
        return self.kv.get(k)

    async def set(self, k, v, ex=None):
        self.kv[k] = v
        return True

    async def incr(self, k):
        self.kv[k] = int(self.kv.get(k) or 0) + 1
        return self.kv[k]

    async def expire(self, k, ttl):
        return True


async def _pending_high(env):
    t = _ctx("mcp")
    try:
        r = await execute_tool("t_high", {"to": "a@x"}, env["alice"], scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    return r["result"]["approval_id"]


# ── 3 승인 중복 실행 ─────────────────────────────────────────
async def test_second_approve_during_execution_runs_handler_once(env):
    """실행 중(상태는 아직 대기) 동일 요청이 재승인되어도 핸들러는 1회만 실행 — 메일 중복 발송 방지."""
    rid = await _pending_high(env)
    seen: list = []

    async def slow_send(user, to: str, **_):
        LOG.append(("send", to))
        # 다른 탭·승인 대기함·묶음 실행이 이 시점에 동일 요청을 승인·취소·수정한다
        for fn in (lambda: writes.approve(env["db"], user, rid),
                   lambda: writes.reject(env["db"], user, rid, "늦은 거절"),
                   lambda: writes.reject(env["db"], user, rid, None, cancel=True),
                   lambda: writes.update_args(env["db"], user, rid, {"to": "evil@x"})):
            with pytest.raises(writes.WriteError) as ei:
                await fn()
            seen.append(ei.value.code)
        return {"sent": True}

    reg.WORKSPACE_TOOLS["t_high"] = Tool(name="t_high", title="보내기", description="", scope="mcp:write",
                                         risk="high", parameters={"type": "object", "properties": {}},
                                         handler=slow_send)
    req = await writes.approve(env["db"], env["alice"], rid)
    assert seen == ["conflict"] * 4
    assert LOG == [("send", "a@x")]                    # 1회만, 수정된 인자가 아닌 승인된 인자로 실행
    assert req.status == "executed"
    with pytest.raises(writes.WriteError):             # 종료 후에도 재승인 불가
        await writes.approve(env["db"], env["alice"], rid)
    assert LOG == [("send", "a@x")]


async def test_claimed_request_is_not_expired_mid_execution(env):
    """실행 중인 요청은 만료 시각이 지나도 '만료됨'으로 전환되지 않는다(유예 이후에만 정리)."""
    rid = await _pending_high(env)
    req = await env["db"].get(McpWriteRequest, rid)
    assert await writes._claim(env["db"], req) is True
    assert await writes._claim(env["db"], req) is False            # 두 번째는 선점 불가
    req.expires_at = writes._now() - timedelta(seconds=5)
    await env["db"].commit()
    assert (await writes.get_owned(env["db"], env["alice"], rid)).status == "pending"
    assert await writes.expire_due(env["db"], "alice") == 0
    req.expires_at = writes._now() - writes.CLAIM_GRACE - timedelta(seconds=5)   # 서버 비정상 종료로 잔존한 요청
    await env["db"].commit()
    assert (await writes.get_owned(env["db"], env["alice"], rid)).status == "expired"


async def test_immediate_run_is_claimed_from_creation(env):
    """확인 없이 즉시 실행하는 요청(MCP low)은 생성 시점부터 선점된 상태 — 실행 도중 승인 대기함에서 재승인 불가."""
    inner: list = []

    async def low(user, title: str, **_):
        row = (await env["db"].execute(McpWriteRequest.__table__.select())).first()
        with pytest.raises(writes.WriteError):
            await writes.approve(env["db"], user, row.id)
        inner.append(row.status)
        LOG.append(("create", title))
        return {"id": "x1"}

    reg.WORKSPACE_TOOLS["t_low"] = Tool(name="t_low", title="만들기", description="", scope="mcp:write",
                                        risk="low", parameters={"type": "object", "properties": {}}, handler=low)
    t = _ctx("mcp")
    try:
        r = await execute_tool("t_low", {"title": "회의"}, env["alice"], scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    assert r["result"]["status"] == "executed" and inner == ["pending"]
    assert LOG == [("create", "회의")]


async def test_undo_runs_once_and_restores_on_failure(env):
    t = _ctx("mcp")
    try:
        r = await execute_tool("t_low", {"title": "a"}, env["alice"], scopes=SCOPES)
    finally:
        writes.call_context.reset(t)
    rid = r["result"]["request_id"]
    calls = {"n": 0, "fail": True}

    async def undo_h(user, id: str, **_):
        calls["n"] += 1
        with pytest.raises(writes.WriteError):         # 되돌리기 진행 중 재요청
            await writes.undo(env["db"], user, rid)
        if calls["fail"]:
            return {"error": "지금은 못 지웁니다"}
        return {"deleted": id}

    reg.WORKSPACE_TOOLS["t_undo"] = Tool(name="t_undo", description="", scope="mcp:write", parameters={},
                                         handler=undo_h)
    with pytest.raises(writes.WriteError):
        await writes.undo(env["db"], env["alice"], rid)
    req = await env["db"].get(McpWriteRequest, rid)
    await env["db"].refresh(req)
    assert req.status == "executed" and calls["n"] == 1          # 실패 시 재차 되돌릴 수 있도록 상태를 복원한다
    calls["fail"] = False
    req = await writes.undo(env["db"], env["alice"], rid)
    assert req.status == "undone" and calls["n"] == 2
    with pytest.raises(writes.WriteError):
        await writes.undo(env["db"], env["alice"], rid)
    assert calls["n"] == 2


# ── 4 하루 한도 ──────────────────────────────────────────────
async def test_quota_counter_survives_row_deletion(db, monkeypatch):  # noqa: F811
    from sqlalchemy import delete

    from app.ai import quota
    from app.ai.models import AIConversation, AIMessage
    from app.db.models import User

    alice = await db.get(User, "alice")
    r = FakeRedis()

    async def _get():
        return r
    monkeypatch.setattr(quota, "_redis", _get)
    conv = AIConversation(user_id="alice", title="임시", temporary=True)
    db.add(conv)
    await db.commit()
    for _ in range(3):
        db.add(AIMessage(conversation_id=conv.id, user_id="alice", role="user", content="q"))
        await quota.chat_count(alice)
    await db.commit()
    assert await quota.chat_used(db, alice) == 3
    await db.execute(delete(AIMessage))                # 임시 대화를 종료하면 행이 삭제된다
    await db.commit()
    assert await quota.chat_used(db, alice) == 3       # 한도는 복원되지 않는다


async def test_quota_falls_back_to_rows_without_redis(db, monkeypatch):  # noqa: F811
    from app.ai import quota
    from app.ai.models import AIConversation, AIMessage
    from app.db.models import User

    async def _boom():
        raise RuntimeError("no redis")
    monkeypatch.setattr(quota, "_redis", _boom)
    alice = await db.get(User, "alice")
    conv = AIConversation(user_id="alice", title="t")
    db.add(conv)
    await db.commit()
    db.add(AIMessage(conversation_id=conv.id, user_id="alice", role="user", content="q"))
    db.add(AIMessage(conversation_id=conv.id, user_id="alice", role="assistant", content="a"))
    await db.commit()
    await quota.chat_count(alice)                      # Redis 없이도 예외가 발생하지 않는다
    assert await quota.chat_used(db, alice) == 1


async def test_regenerate_and_continue_enforce_daily_limit(db, monkeypatch):  # noqa: F811
    from fastapi import HTTPException

    from app.ai import config as ai_config
    from app.ai import quota
    from app.ai import router as ai_router
    from app.ai.models import AIConversation
    from app.db.models import User

    r = FakeRedis()

    async def _get():
        return r
    monkeypatch.setattr(quota, "_redis", _get)

    async def _cfg(_db):
        return {"governance": {"daily_limit": 2}}
    monkeypatch.setattr(ai_config, "get_ai_config", _cfg)
    alice = await db.get(User, "alice")
    conv = AIConversation(user_id="alice", title="t")
    db.add(conv)
    await db.commit()
    await quota.chat_count(alice)
    await ai_router._enforce_daily_limit(db, alice)    # 1/2 — 통과
    await quota.chat_count(alice)
    regen = getattr(ai_router.chat_regenerate, "__wrapped__", ai_router.chat_regenerate)
    cont = getattr(ai_router.chat_continue, "__wrapped__", ai_router.chat_continue)
    for fn in (regen, cont):
        with pytest.raises(HTTPException) as ei:
            await fn(conv.id, user=alice, db=db)
        assert ei.value.status_code == 429


# ── 5 연결 해제 뒤 액세스 토큰 ───────────────────────────────
async def test_revocation_rejects_tokens_issued_before_disconnect(monkeypatch):
    import time

    from app.mcp import revocation

    r = FakeRedis()

    async def _get():
        return r
    monkeypatch.setattr(revocation, "_redis", _get)
    issued = int(time.time()) - 60
    assert await revocation.revoked_since("alice", "dcr_x", issued) is False
    await revocation.mark("alice", "dcr_x")
    assert await revocation.revoked_since("alice", "dcr_x", issued) is True       # 해제 전에 발급된 토큰
    assert await revocation.revoked_since("alice", "dcr_x", None) is True         # 발급 시각을 알 수 없으면 거부
    assert await revocation.revoked_since("alice", "dcr_x", time.time() + 5) is False   # 재연결하여 새로 발급받은 토큰
    assert await revocation.revoked_since("alice", "dcr_other", issued) is False  # 다른 앱
    assert await revocation.revoked_since("bob", "dcr_x", issued) is False        # 다른 사용자


async def test_revocation_without_redis_is_a_noop(monkeypatch):
    from app.mcp import revocation

    async def _boom():
        raise RuntimeError("no redis")
    monkeypatch.setattr(revocation, "_redis", _boom)
    await revocation.mark("alice", "dcr_x")
    assert await revocation.revoked_since("alice", "dcr_x", 1) is False


async def test_mcp_calls_stop_after_disconnect(monkeypatch):
    """장시간 열린 연결(구 SSE)도 호출마다 재확인한다 — 해제 후에는 도구 목록·호출이 차단된다."""
    import time

    from app.db.models import User
    from app.mcp import http_server, revocation

    r = FakeRedis()

    async def _get():
        return r
    monkeypatch.setattr(revocation, "_redis", _get)
    ctx = http_server.McpContext(user=User(id="alice", username="alice"), scopes=frozenset({"mcp:read"}),
                                 resource="x", client_id="dcr_x", issued_at=time.time() - 30)
    assert await http_server._disconnected(ctx) is False
    await revocation.mark("alice", "dcr_x")
    assert await http_server._disconnected(ctx) is True


# ── 7 타인이 작성한 글 = 외부 내용 ─────────────────────────────────
UNTRUSTED_READS = ("chat_read_messages", "board_search", "board_read_post", "notes_search", "notes_read",
                   "calendar_list_events")


def test_workspace_reads_of_others_content_are_untrusted():
    for name in UNTRUSTED_READS:
        tool = reg.WORKSPACE_TOOLS[name]
        assert tool.untrusted_output is True, name
        assert reg._UNTRUSTED_SOURCE.get(name), name
        hint = writes.untrusted_hint(name, {"title": "공지"})
        assert hint["kind"] == "workspace" and hint["label"] != name
    # 제목·이름만 반환하는 목록 도구는 기존대로(승인 창이 불필요하게 증가하지 않도록)
    for name in ("chat_list_channels", "board_list_posts", "notes_list", "calendar_list_calendars", "files_list"):
        assert reg.WORKSPACE_TOOLS[name].untrusted_output is False, name


async def test_attachment_turn_marks_conversation_untrusted(monkeypatch):
    from app.ai import router as ai_router

    seen: list = []

    async def mark(uid, key, hint):
        seen.append((uid, key, hint["label"], hint["subject"]))
    monkeypatch.setattr(writes, "mark_untrusted_read", mark)
    await ai_router._mark_context_read("alice", "conv1", "ai_attachment", "견적서.pdf")
    assert seen == [("alice", "conv1", "대화 첨부 파일", "견적서.pdf")]


# ── 14 계획 승인 응답이 실패하면 권한 모드는 유지 ────────────
async def test_expired_plan_card_does_not_switch_mode(db, monkeypatch):  # noqa: F811
    import time

    from fastapi import HTTPException

    from app.ai import interact
    from app.ai import router as ai_router
    from app.db.models import User

    async def _boom():
        raise RuntimeError("no redis")
    monkeypatch.setattr(interact, "_redis", _boom)
    alice = await db.get(User, "alice")
    rec = await interact.create("alice", "conv1", "msg1", "plan", {"plan": "1. 메일 보내기"})
    exp, stored = interact._local[rec["id"]]
    stored["expires_at"] = time.time() - 1            # 답변 작업이 비정상 종료되어 만료 표시를 남기지 못한 카드
    interact._local[rec["id"]] = (exp, stored)
    with pytest.raises(HTTPException) as ei:
        await ai_router.answer_question.__wrapped__(
            rec["id"], ai_router.QuestionAnswerBody(choice="acceptEdits"), user=alice, db=db)
    assert ei.value.status_code == 409
    assert await writes.get_permission_mode(db, "alice") == "default"
