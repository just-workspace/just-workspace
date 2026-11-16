"""선승인(Claude Code 방식) — 내장 AI 답변은 쓰기 요청이 발생하면 사용자의 결정을 대기한 뒤 실제 결과로 이어서 작성한다.

- 실행 시: 모델의 다음 차례에 실행 결과(executed)가 전달되고, 카드 상태 이벤트가 재송신된다.
- 취소 시: 모델에 '취소함 — 다시 요청하지 말 것'이 전달된다(실행되지 않음).
- 답변 중지 시: 대기 중인 low 카드는 취소된다.
- 대기 중 처리된 high 는 대화에 별도의 결과 메시지를 추가하지 않는다(답변이 이어서 서술한다).
"""

import asyncio
import json

import pytest
from sqlalchemy import select

from app.ai import router as ai_router
from app.db.models import User, WikiPage
from app.mcp import writes
from tests.test_sec_h8_ai_write_tools import env  # noqa: F401 (픽스처 재사용)
from tests.test_settings_security_p8 import db  # noqa: F401


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    monkeypatch.setattr(writes, "WAIT_POLL_SEC", 0.01)

    async def _no_redis():
        raise RuntimeError("no redis in tests")
    import app.chat.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", _no_redis)


def _wire(env, monkeypatch, seen):
    calls = {"n": 0}

    async def fake_stream(cfg, msgs, system=None, tools=None):
        calls["n"] += 1
        if calls["n"] == 1:
            yield {"type": "text", "text": "만들게요. "}
            yield {"type": "tool_call", "name": "notes_create",
                   "args": json.dumps({"title": "x", "content": "y", "space": env["space"]})}
        else:
            seen.append(msgs[-1]["content"])
            yield {"type": "text", "text": "끝"}
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


LOCK = asyncio.Lock()


def _serialize(monkeypatch):
    """테스트는 DB 세션 하나를 공유한다 — 대기 폴링과 '사용자 클릭'이 겹치지 않도록 잠금을 적용한다(운영은 세션 분리)."""
    from contextlib import asynccontextmanager
    orig = writes.session
    global LOCK
    LOCK = asyncio.Lock()   # 테스트마다 새 잠금 — 모듈 수준 잠금은 최초로 경합한 테스트의 이벤트 루프에 묶여 다음 테스트에서 예외가 발생한다

    @asynccontextmanager
    async def locked():
        async with LOCK:
            async with orig() as s:
                yield s
    monkeypatch.setattr(writes, "session", locked)


async def _drive(env, user, on_card, monkeypatch):
    """스트림을 실행하다가 첫 카드가 발생하면 on_card(rid) 를 호출한다(사용자의 카드 클릭에 해당)."""
    _serialize(monkeypatch)
    chunks: list[str] = []
    gen = ai_router._chat_event_stream(env["conv"], user, object(), False, None,
                                       [{"function": {"name": "notes_create"}}], True,
                                       [{"role": "user", "content": "만들어 줘"}])
    done = asyncio.Event()

    async def consume():
        async for ch in gen:
            chunks.append(ch if isinstance(ch, str) else ch.decode())
        done.set()

    task = asyncio.create_task(consume())
    rid = None
    for _ in range(500):
        await asyncio.sleep(0.01)
        cards = [d for e, d in _events(chunks) if e == "write_request"]
        if cards and rid is None:
            rid = cards[0]["id"]
            # 결정 전에는 답변이 이어지지 않는다(중단 후 대기)
            assert not any(e == "done" for e, _ in _events(chunks))
            async with LOCK:
                await on_card(rid, task)
        if done.is_set() or task.done():
            break
    if not task.done():
        await asyncio.wait_for(task, 5)
    return rid, _events(chunks)


async def test_approve_feeds_real_result(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen)
    bob = await env["db"].get(User, "bob")

    async def click(rid, _t):
        await asyncio.sleep(0.05)
        await writes.approve(env["db"], bob, rid)

    rid, evs = await _drive(env, bob, click, monkeypatch)
    assert rid
    assert len((await env["db"].execute(select(WikiPage))).scalars().all()) == 1
    # 모델의 다음 차례에 실제 실행 결과가 전달되었다
    assert seen and '"executed"' in seen[0] and "pending_confirmation" not in seen[0]
    # 카드 상태(실행됨)를 화면에 재송신 + 단계가 대기 → 완료
    cards = [d for e, d in evs if e == "write_request"]
    assert cards[0]["status"] == "pending" and cards[-1]["status"] == "executed"
    steps = [d for e, d in evs if e == "step"]
    assert any(s["detail"].startswith("승인 대기") for s in steps)
    assert steps[-1]["status"] == "done"
    assert evs[-1][0] == "done"


async def test_cancel_tells_model_not_to_retry(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen)
    bob = await env["db"].get(User, "bob")

    async def cancel(rid, _t):
        await writes.reject(env["db"], bob, rid, None, cancel=True)

    await _drive(env, bob, cancel, monkeypatch)
    assert (await env["db"].execute(select(WikiPage))).scalars().all() == []
    assert seen and '"canceled"' in seen[0] and "다시 요청하지" in seen[0]


async def test_stop_while_waiting_cancels_low_card(env, monkeypatch):
    seen: list = []
    _wire(env, monkeypatch, seen)
    bob = await env["db"].get(User, "bob")
    box = {}

    async def stop(rid, task):
        box["rid"] = rid
        task.cancel()

    try:
        await _drive(env, bob, stop, monkeypatch)
    except asyncio.CancelledError:
        pass
    req = await env["db"].get(writes.McpWriteRequest, box["rid"])
    await env["db"].refresh(req)
    assert req.status == "canceled"
    assert seen == []


async def test_report_back_skipped_while_awaited(monkeypatch):
    await writes.mark_awaited(["wr_x"], True)
    assert await writes.is_awaited("wr_x")
    await writes.mark_awaited(["wr_x"], False)
    assert not await writes.is_awaited("wr_x")
