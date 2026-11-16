"""내장 AI 응답 생성 분리 — 연결이 끊겨도 완료까지 진행, 임의 워커에서 이어 받기, 멈춤·하트비트·종료 (app/ai/runs.py)."""

import asyncio
import json
import time
from contextlib import asynccontextmanager

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.ai import config as ai_config
from app.ai import router as ai_router
from app.ai import runs
from app.ai.models import AIConversation, AIMessage
from app.db.models import User
from tests.test_ai_s6a_chat_basics import CFG, _events
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)


class FakeStreamRedis:
    """Redis Stream 일부(XADD/XREAD BLOCK) + 키·TTL — 워커들이 동일 Redis 를 참조하는 상황과 동일하다."""

    def __init__(self):
        self.kv: dict[str, tuple[str, float | None]] = {}
        self.streams: dict[str, list[tuple[str, dict]]] = {}
        self.ttl: dict[str, int] = {}
        self._seq = 0

    def _get(self, k):
        v = self.kv.get(k)
        if v is None:
            return None
        if v[1] is not None and v[1] < time.time():
            self.kv.pop(k, None)
            return None
        return v[0]

    async def set(self, k, v, ex=None, nx=False):
        if nx and self._get(k) is not None:
            return None
        self.kv[k] = (str(v), time.time() + ex if ex else None)
        return True

    async def get(self, k):
        return self._get(k)

    async def exists(self, k):
        return int(self._get(k) is not None or k in self.streams)

    async def delete(self, *ks):
        n = 0
        for k in ks:
            n += int(self.kv.pop(k, None) is not None) + int(self.streams.pop(k, None) is not None)
        return n

    async def expire(self, k, sec):
        self.ttl[k] = sec
        return True

    async def xadd(self, k, fields, maxlen=None, approximate=True):
        self._seq += 1
        sid = f"{self._seq}-0"
        lst = self.streams.setdefault(k, [])
        lst.append((sid, dict(fields)))
        if maxlen and len(lst) > maxlen:
            del lst[: len(lst) - maxlen]
        return sid

    @staticmethod
    def _n(sid):
        a, _, b = sid.partition("-")
        return (int(a), int(b or 0))

    async def xread(self, streams, count=None, block=None):
        deadline = time.monotonic() + (block or 0) / 1000
        while True:
            out = []
            for k, after in streams.items():
                got = [(sid, f) for sid, f in self.streams.get(k, []) if self._n(sid) > self._n(after)]
                if count:
                    got = got[:count]
                if got:
                    out.append([k, got])
            if out or block is None or time.monotonic() >= deadline:
                return out
            await asyncio.sleep(0.005)

    def expire_stream(self, mid):
        """TTL 만료 상황 모사 — 스트림·소유자 키 삭제"""
        self.streams.pop(runs.k_stream(mid), None)
        self.kv.pop(runs.k_owner(mid), None)


@pytest.fixture()
async def env(db, monkeypatch):
    @asynccontextmanager
    async def _session():
        yield db
    monkeypatch.setattr(ai_router, "async_session", _session)
    monkeypatch.setattr(runs, "async_session", _session)
    fake = FakeStreamRedis()

    async def _r():
        return fake
    monkeypatch.setattr(runs, "_redis", _r)
    monkeypatch.setattr(runs, "SAVE_EVERY", 3600)   # 동일 세션의 동시 사용 방지(진행 저장은 별도 테스트)
    monkeypatch.setattr(runs, "STOP_POLL", 0.02)
    monkeypatch.setattr(runs, "READ_BLOCK_MS", 50)
    runs._RUNS.clear()
    conv = AIConversation(user_id="alice", title="t", tools_enabled=False)
    db.add(conv)
    await db.commit()
    yield {"db": db, "conv": conv.id, "alice": await db.get(User, "alice"), "bob": await db.get(User, "bob"),
           "redis": fake}
    for r in list(runs._RUNS.values()):
        if r.task:
            r.task.cancel()
    runs._RUNS.clear()


def _gated_stream(monkeypatch, gate: asyncio.Event, first="앞부분", rest="…뒷부분"):
    async def fake_stream(cfg, msgs, system=None, tools=None):
        yield {"type": "text", "text": first}
        await gate.wait()
        yield {"type": "text", "text": rest}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)


def _endless_stream(monkeypatch):
    async def fake_stream(cfg, msgs, system=None, tools=None):
        i = 0
        while True:
            i += 1
            yield {"type": "text", "text": f"t{i} "}
            await asyncio.sleep(0.01)
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)


async def _start(env):
    resp = await ai_router._start_chat(env["conv"], env["alice"], CFG, False, None, None, False,
                                       [{"role": "user", "content": "질문"}])
    return resp


def _only_run():
    assert len(runs._RUNS) == 1
    return next(iter(runs._RUNS.values()))


async def _collect(it) -> list[str]:
    out = []
    async for c in it:
        out.append(c if isinstance(c, str) else c.decode())
    return out


def _ids(chunks: list[str]) -> list[str]:
    return [c.split("\n", 1)[0][4:] for c in chunks if c.startswith("id: ")]


async def _assistant(db, conv_id):
    return (await db.execute(select(AIMessage).where(AIMessage.conversation_id == conv_id,
                                                     AIMessage.role == "assistant"))).scalars().all()


# ── 연결이 끊겨도 완료까지 진행 ─────────────────────────────────────
async def test_disconnect_does_not_stop_generation(env, monkeypatch):
    gate = asyncio.Event()
    _gated_stream(monkeypatch, gate)
    resp = await _start(env)
    run = _only_run()
    it = resp.body_iterator
    first = []
    async for c in it:
        first.append(c)
        if "event: token" in c:
            break
    await it.aclose()  # 페이지 이동 — 구독만 종료된다
    assert all(c.startswith("id: ") for c in first)
    assert not run.task.done()
    gate.set()
    await asyncio.wait_for(run.task, 5)
    [m] = await _assistant(env["db"], env["conv"])
    assert m.status == "complete" and m.content == "앞부분…뒷부분"
    # 스트림에는 done 과 종료 표시, 하트비트는 삭제되고 TTL 이 설정된다
    r = env["redis"]
    assert r.streams[runs.k_stream(m.id)][-1][1] == {"end": "1"}
    assert r.ttl[runs.k_stream(m.id)] == runs.DONE_TTL
    assert await r.get(runs.k_alive(m.id)) is None
    assert m.id not in runs._RUNS


async def test_reconnect_from_other_worker_gets_only_after(env, monkeypatch):
    gate = asyncio.Event()
    _gated_stream(monkeypatch, gate)
    resp = await _start(env)
    run = _only_run()
    task = run.task
    runs._RUNS.clear()  # 다른 워커 — 작업 레지스트리 없이 Redis 만으로 처리
    it = resp.body_iterator
    head = []
    async for c in it:
        head.append(c)
        if "event: token" in c:
            break
    await it.aclose()
    last_id = _ids(head)[-1]
    gate.set()
    await asyncio.wait_for(task, 5)
    msg_id = run.msg_id
    out = await ai_router.message_stream.__wrapped__(msg_id, after=last_id, user=env["alice"], db=env["db"])
    tail = await _collect(out.body_iterator)
    evs = _events(tail)
    assert [e for e, _ in evs] == ["token", "done"]
    assert evs[0][1]["text"] == "…뒷부분" and evs[1][1]["status"] == "complete"
    assert all(FakeStreamRedis._n(i) > FakeStreamRedis._n(last_id) for i in _ids(tail))
    # 처음부터(새로고침)
    full = _events(await _collect((await ai_router.message_stream.__wrapped__(
        msg_id, after="0", user=env["alice"], db=env["db"])).body_iterator))
    assert [e for e, _ in full][0] == "meta" and "".join(d["text"] for e, d in full if e == "token") == "앞부분…뒷부분"
    # 타인의 메시지는 404, 잘못된 after 는 처음부터
    with pytest.raises(HTTPException) as ei:
        await ai_router.message_stream.__wrapped__(msg_id, after="0", user=env["bob"], db=env["db"])
    assert ei.value.status_code == 404
    assert runs.clean_after("0;DROP") == "0" and runs.clean_after("12-3") == "12-3"


async def test_reconnect_while_running_streams_live(env, monkeypatch):
    gate = asyncio.Event()
    _gated_stream(monkeypatch, gate)
    resp = await _start(env)
    run = _only_run()
    await resp.body_iterator.aclose()
    # 행이 아직 없을 수 있다 — Redis 소유자 키로 확인
    sub = await ai_router.message_stream.__wrapped__(run.msg_id, after="0", user=env["alice"], db=env["db"])
    reader = asyncio.create_task(_collect(sub.body_iterator))
    await asyncio.sleep(0.1)
    assert not reader.done()  # 실행 중인 작업을 대기 중(ping)
    gate.set()
    evs = _events(await asyncio.wait_for(reader, 5))
    assert [e for e, _ in evs if e != "message"][-1] == "done"


# ── 멈춤 ─────────────────────────────────────────────────────
async def test_stop_reaches_run_on_other_worker(env, monkeypatch):
    _endless_stream(monkeypatch)
    resp = await _start(env)
    run = _only_run()
    task = run.task
    runs._RUNS.clear()  # 멈춤 요청이 다른 워커로 수신됨
    it = resp.body_iterator
    async for c in it:
        if "event: token" in c:
            break
    await it.aclose()
    await asyncio.sleep(0.05)
    out = await ai_router.mark_stopped.__wrapped__(run.msg_id, user=env["alice"], db=env["db"])
    assert out["status"] == "stopped"
    assert await env["redis"].get(runs.k_stop(run.msg_id)) == "1"
    await asyncio.wait_for(task, 5)
    [m] = await _assistant(env["db"], env["conv"])
    assert m.status == "stopped" and m.content.startswith("t1")
    evs = _events([d["d"] for _, d in env["redis"].streams[runs.k_stream(m.id)] if "d" in d])
    assert evs[-1] == ("done", {"message_id": m.id, "status": "stopped", "ai_generated": True})


async def test_stop_while_waiting_on_provider_cancels_after_grace(env, monkeypatch):
    gate = asyncio.Event()  # 끝까지 열리지 않음 — 제공자가 응답 없이 정지한 상태
    _gated_stream(monkeypatch, gate)
    monkeypatch.setattr(runs, "STOP_GRACE", 0.05)
    resp = await _start(env)
    run = _only_run()
    it = resp.body_iterator
    async for c in it:
        if "event: token" in c:
            break
    await it.aclose()
    await ai_router.mark_stopped.__wrapped__(run.msg_id, user=env["alice"], db=env["db"])
    await asyncio.wait_for(run.task, 5)
    [m] = await _assistant(env["db"], env["conv"])
    assert m.status == "stopped" and m.content == "앞부분"


# ── 하트비트 보정 ─────────────────────────────────────────────
async def test_streaming_without_heartbeat_is_interrupted(env, monkeypatch):
    db = env["db"]
    q = AIMessage(conversation_id=env["conv"], user_id="alice", role="user", content="질문", parent_id=env["conv"])
    db.add(q)
    await db.flush()
    m = AIMessage(conversation_id=env["conv"], user_id="alice", role="assistant", content="", status="streaming",
                  parent_id=q.id)
    db.add(m)
    await db.commit()
    out = await ai_router.get_messages.__wrapped__(env["conv"], user=env["alice"], db=db)
    assert [x["role"] for x in out["messages"]] == ["user"]  # 중단된 빈 행은 숨김(기존과 동일)
    m.content = "받은 부분"
    await db.commit()
    out = await ai_router.get_messages.__wrapped__(env["conv"], user=env["alice"], db=db)
    assert out["messages"][-1]["status"] == "interrupted"
    # 작업이 실행 중이면 streaming 유지(빈 글이어도 표시하여 화면이 재연결)
    await env["redis"].set(runs.k_alive(m.id), "1", ex=15)
    out = await ai_router.get_messages.__wrapped__(env["conv"], user=env["alice"], db=db)
    assert out["messages"][-1]["status"] == "streaming"
    # 생성 중에는 이어 받기·재생성 거부
    async def _prov(db, user):
        return CFG, False
    monkeypatch.setattr(ai_config, "resolve_provider_for_user", _prov)
    for call in (ai_router.chat_regenerate, ai_router.chat_continue):
        with pytest.raises(HTTPException) as ei:
            await call.__wrapped__(env["conv"], user=env["alice"], db=db)
        assert ei.value.status_code == 409 and "만드는 중" in ei.value.detail


async def test_expired_stream_falls_back_to_db(env):
    db = env["db"]
    m = AIMessage(conversation_id=env["conv"], user_id="alice", role="assistant", content="최종 답변",
                  status="complete", model="test-model", meta=json.dumps({"steps": [], "citations": []}))
    db.add(m)
    await db.commit()
    out = await ai_router.message_stream.__wrapped__(m.id, after="5-0", user=env["alice"], db=db)
    evs = _events(await _collect(out.body_iterator))
    assert len(evs) == 1 and evs[0][0] == "done"
    d = evs[0][1]
    assert d["status"] == "complete" and d["final"]["content"] == "최종 답변" and d["message_id"] == m.id


async def test_dead_run_stream_ends_with_db_state(env):
    """작업이 비정상 종료된 경우(워커 재시작) — 잔여 이벤트 이후 DB 상태(streaming→interrupted)로 done."""
    db = env["db"]
    m = AIMessage(conversation_id=env["conv"], user_id="alice", role="assistant", content="반쯤", status="streaming")
    db.add(m)
    await db.commit()
    r = env["redis"]
    await r.xadd(runs.k_stream(m.id), {"d": ai_router._sse("token", {"text": "반쯤"})})
    out = await ai_router.message_stream.__wrapped__(m.id, after="0", user=env["alice"], db=db)
    evs = _events(await _collect(out.body_iterator))
    assert [e for e, _ in evs] == ["token", "done"] and evs[1][1]["status"] == "interrupted"


# ── 진행 저장 · 종료 훅 ───────────────────────────────────────
async def test_progress_saved_to_db_while_streaming(env, monkeypatch):
    gate = asyncio.Event()
    _gated_stream(monkeypatch, gate)
    resp = await _start(env)
    run = _only_run()
    it = resp.body_iterator
    async for c in it:
        if "event: token" in c:
            break
    await it.aclose()
    await run.save_progress()
    [m] = await _assistant(env["db"], env["conv"])
    assert m.status == "streaming" and m.content == "앞부분"
    assert "started_at" in json.loads(m.meta)
    gate.set()
    await asyncio.wait_for(run.task, 5)
    assert m.status == "complete"


async def test_shutdown_saves_interrupted(env, monkeypatch):
    _endless_stream(monkeypatch)
    resp = await _start(env)
    run = _only_run()
    it = resp.body_iterator
    async for c in it:
        if "event: token" in c:
            break
    await it.aclose()
    await runs.shutdown(timeout=5)
    assert run.task.done()
    [m] = await _assistant(env["db"], env["conv"])
    assert m.status == "interrupted" and m.content.startswith("t1")
    entries = env["redis"].streams[runs.k_stream(m.id)]
    assert entries[-1][1] == {"end": "1"}
    assert _events([entries[-2][1]["d"]])[0] == ("done", {"message_id": m.id, "status": "interrupted",
                                                          "ai_generated": True})


async def test_new_events_relay_untouched(env, monkeypatch):
    """이벤트 종류를 필터링하지 않는다 — 다른 작업이 추가한 신규 이벤트(artifact 등)도 그대로 통과."""
    async def fake_gen(*a, **kw):
        yield ai_router._sse("meta", {"message_id": kw["msg_id"]})
        yield ai_router._sse("artifact", {"id": "a1", "kind": "doc"})
        yield ai_router._sse("done", {"message_id": kw["msg_id"], "status": "complete"})
    monkeypatch.setattr(ai_router, "_chat_event_stream", fake_gen)
    resp = await _start(env)
    evs = _events(await _collect(resp.body_iterator))
    evs = [x for x in evs if x[0] != "message"]  # ping 주석 제외
    assert [e for e, _ in evs] == ["meta", "artifact", "done"] and evs[1][1] == {"id": "a1", "kind": "doc"}


async def test_redis_down_falls_back_to_direct_stream(env, monkeypatch):
    async def _down():
        raise ConnectionError("redis down")
    monkeypatch.setattr(runs, "_redis", _down)
    gate = asyncio.Event()
    gate.set()
    _gated_stream(monkeypatch, gate)
    resp = await _start(env)
    assert not runs._RUNS
    evs = _events(await _collect(resp.body_iterator))
    assert evs[-1][0] == "done" and evs[-1][1]["status"] == "complete"
