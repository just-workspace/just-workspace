"""ask_user · plan_exit — Claude Code AskUserQuestion · ExitPlanMode.

- 질문 카드: 응답 시까지 답변이 중단되며, 응답(선택지·직접 입력)이 모델에 전달된다. 넘김·멈춤도 처리.
- 검증: 질문 1~4개·선택지 2~4개, 단일 선택 질문에 2개 이상 선택하면 거부, 타인의 질문에는 응답 불가.
- 계획 승인: 계획 모드에서만 가능. 승인하면 권한 모드가 변경되고(응답 저장보다 우선) 모델은 실행으로 전환한다.
"""

import asyncio
import json

import pytest

from app.ai import interact
from app.ai import router as ai_router
from app.db.models import User
from app.mcp import writes
from tests.test_sec_h8_ai_write_tools import env  # noqa: F401 (픽스처 재사용)
from tests.test_settings_security_p8 import db  # noqa: F401

Q = {"questions": [
    {"question": "어느 형식으로 만들까요?", "header": "형식", "options": [
        {"label": "PDF (추천)", "description": "보기 좋음"}, {"label": "DOCX"}]},
    {"question": "누구에게 보낼까요?", "multiSelect": True, "options": [{"label": "팀"}, {"label": "고객"}, {"label": "나"}]},
]}


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    monkeypatch.setattr(interact, "POLL_SEC", 0.01)
    interact._local.clear()

    async def _no():
        raise RuntimeError("no redis")
    import app.chat.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", _no)


def test_validate_ask_rules():
    assert len(interact.validate_ask(Q)) == 2
    with pytest.raises(interact.InteractError):
        interact.validate_ask({"questions": []})
    with pytest.raises(interact.InteractError):
        interact.validate_ask({"questions": [{"question": "x?", "options": [{"label": "a"}]}]})
    with pytest.raises(interact.InteractError):
        interact.validate_ask({"questions": [{"question": "x?", "options": [{"label": "a"}, {"label": "a"}]}]})


async def test_answer_validation_and_owner():
    rec = await interact.create("alice", "c1", "m1", "ask", {"questions": interact.validate_ask(Q)})
    with pytest.raises(interact.InteractError) as e:
        await interact.answer("bob", rec["id"], {"answers": [{"selected": ["DOCX"]}, {"selected": ["팀"]}]})
    assert e.value.code == "not_found"
    with pytest.raises(interact.InteractError):   # 단일 선택에 2개 선택
        await interact.answer("alice", rec["id"], {"answers": [{"selected": ["DOCX"], "other": "HWP"}, {"selected": ["팀"]}]})
    with pytest.raises(interact.InteractError):   # 응답 누락
        await interact.answer("alice", rec["id"], {"answers": [{"selected": []}, {"selected": ["팀"]}]})
    done = await interact.answer("alice", rec["id"], {"answers": [{"other": "HWP로"}, {"selected": ["팀", "나", "없는것"]}]})
    assert done["answer"]["answers"][0] == {"question": "어느 형식으로 만들까요?", "selected": [], "other": "HWP로"}
    assert done["answer"]["answers"][1]["selected"] == ["팀", "나"]
    with pytest.raises(interact.InteractError) as e:
        await interact.answer("alice", rec["id"], {"skip": True})
    assert e.value.code == "conflict"


def _wire(env, monkeypatch, seen, first_call):
    calls = {"n": 0}

    async def fake_stream(cfg, msgs, system=None, tools=None):
        calls["n"] += 1
        if calls["n"] == 1:
            yield {"type": "tool_call", "name": first_call[0], "args": json.dumps(first_call[1], ensure_ascii=False)}
        else:
            seen.append(msgs[-1]["content"])
            yield {"type": "text", "text": "알겠습니다"}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _session():
        yield env["db"]
    monkeypatch.setattr(ai_router, "async_session", _session)


def _events(chunks):
    out = []
    for c in chunks:
        ev = next((ln[7:] for ln in c.splitlines() if ln.startswith("event: ")), None)
        data = next((ln[6:] for ln in c.splitlines() if ln.startswith("data: ")), None)
        if ev:
            out.append((ev, json.loads(data) if data else None))
    return out


async def _drive(env, user, on_q):
    chunks: list[str] = []
    gen = ai_router._chat_event_stream(env["conv"], user, object(), False, None,
                                       [{"function": {"name": "x"}}], True, [{"role": "user", "content": "해 줘"}])

    async def consume():
        async for ch in gen:
            chunks.append(ch if isinstance(ch, str) else ch.decode())

    task = asyncio.create_task(consume())
    asked = None
    for _ in range(500):
        await asyncio.sleep(0.01)
        qs = [d for e, d in _events(chunks) if e == "question"]
        if qs and asked is None:
            asked = qs[0]
            assert asked["status"] == "pending"
            assert not any(e == "done" for e, _ in _events(chunks))   # 응답 전에는 중단 상태
            await on_q(asked, task)
        if task.done():
            break
    if not task.done():
        await asyncio.wait_for(task, 5)
    return asked, _events(chunks)


async def test_ask_waits_and_feeds_answer(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen, ("ask_user", Q))
    bob = await env["db"].get(User, "bob")

    async def reply(q, _t):
        await interact.answer("bob", q["id"], {"answers": [{"selected": ["PDF (추천)"]}, {"selected": ["고객"], "other": "본부장"}]})

    q, evs = await _drive(env, bob, reply)
    assert q["questions"][0]["header"] == "형식"
    assert seen and '"answered"' in seen[0] and "PDF (추천)" in seen[0] and "본부장" in seen[0]
    qs = [d for e, d in evs if e == "question"]
    assert qs[-1]["status"] == "answered"
    assert evs[-1][0] == "done"


async def test_skip_tells_model_to_assume(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen, ("ask_user", Q))
    bob = await env["db"].get(User, "bob")

    async def skip(q, _t):
        await interact.answer("bob", q["id"], {"skip": True})

    await _drive(env, bob, skip)
    assert '"skipped"' in seen[0] and "가정" in seen[0]


async def test_invalid_ask_goes_back_to_model_without_card(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen, ("ask_user", {"questions": []}))
    bob = await env["db"].get(User, "bob")
    q, evs = await _drive(env, bob, lambda *_: None)
    assert q is None and "invalid_argument" in seen[0]


async def test_plan_exit_only_in_plan_mode(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen, ("plan_exit", {"plan": "1. 파일 만들기"}))
    bob = await env["db"].get(User, "bob")
    q, _ = await _drive(env, bob, lambda *_: None)
    assert q is None and "not_plan_mode" in seen[0]


async def test_plan_approve_switches_mode_before_resuming(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen, ("plan_exit", {"plan": "1. 파일 만들기\n2. 메일 보내기"}))
    await writes.set_permission_mode(env["db"], "bob", "plan")
    bob = await env["db"].get(User, "bob")

    async def approve(q, _t):
        assert q["kind"] == "plan" and "메일 보내기" in q["plan"]
        # 엔드포인트와 동일한 순서: 모드 먼저 → 응답 저장
        from app.ai.router import QuestionAnswerBody, answer_question
        out = await answer_question.__wrapped__(q["id"], QuestionAnswerBody(choice="acceptEdits"), user=bob, db=env["db"])
        assert out["mode"] == "acceptEdits"

    await _drive(env, bob, approve)
    assert await writes.get_permission_mode(env["db"], "bob") == "acceptEdits"
    assert '"approved"' in seen[0] and "acceptEdits" in seen[0]


async def test_plan_keep_planning_keeps_mode(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen, ("plan_exit", {"plan": "1. 파일 만들기"}))
    await writes.set_permission_mode(env["db"], "bob", "plan")
    bob = await env["db"].get(User, "bob")

    async def keep(q, _t):
        from app.ai.router import QuestionAnswerBody, answer_question
        out = await answer_question.__wrapped__(q["id"], QuestionAnswerBody(choice="keep_planning", feedback="메일은 빼"),
                                    user=bob, db=env["db"])
        assert out["mode"] is None

    await _drive(env, bob, keep)
    assert await writes.get_permission_mode(env["db"], "bob") == "plan"
    assert '"rejected"' in seen[0] and "메일은 빼" in seen[0]


async def test_stop_cancels_question(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen, ("ask_user", Q))
    bob = await env["db"].get(User, "bob")
    box = {}

    async def stop(q, task):
        box["id"] = q["id"]
        task.cancel()

    try:
        await _drive(env, bob, stop)
    except asyncio.CancelledError:
        pass
    await asyncio.sleep(0.05)
    assert (await interact.peek("bob", box["id"]))["status"] == "canceled"


def test_saved_pending_question_shows_expired_after_answer_ends():
    qs = [{"id": "q1", "status": "pending"}, {"id": "q2", "status": "answered"}]
    assert [q["status"] for q in ai_router._questions_view(qs, "complete")] == ["expired", "answered"]
    assert [q["status"] for q in ai_router._questions_view(qs, "streaming")] == ["pending", "answered"]
