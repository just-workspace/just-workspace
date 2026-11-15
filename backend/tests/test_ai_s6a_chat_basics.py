"""AI 대화 기본기: 진행 단계·출처·피드백·AI 생성 표시·이어서 받기."""

import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.ai import config as ai_config
from app.ai import progress
from app.ai import router as ai_router
from app.ai.models import AIConversation, AIMessage, AIMessageFeedback
from app.db.models import User
from app.mcp import usage_router
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)

CFG = SimpleNamespace(model="test-model", kind="ollama", base="")


def _events(chunks: list[str]) -> list[tuple[str, dict]]:
    out = []
    for c in chunks:
        for block in c.strip().split("\n\n"):
            if not block:
                continue
            ev, data = "message", {}
            for line in block.split("\n"):
                if line.startswith("event:"):
                    ev = line[6:].strip()
                elif line.startswith("data:"):
                    data = json.loads(line[5:].strip())
            out.append((ev, data))
    return out


@pytest.fixture()
async def env(db, monkeypatch):
    @asynccontextmanager
    async def _session():
        yield db
    monkeypatch.setattr(ai_router, "async_session", _session)
    conv = AIConversation(user_id="alice", title="t", tools_enabled=True)
    db.add(conv)
    await db.commit()
    alice = await db.get(User, "alice")
    bob = await db.get(User, "bob")
    return {"db": db, "conv": conv.id, "alice": alice, "bob": bob}


async def _run(gen) -> list[tuple[str, dict]]:
    chunks = []
    async for c in gen:
        chunks.append(c if isinstance(c, str) else c.decode())
    return _events(chunks)


async def _assistant(db, conv_id):
    return (await db.execute(select(AIMessage).where(AIMessage.conversation_id == conv_id,
                                                     AIMessage.role == "assistant"))).scalars().all()


# ── 순수 함수 ─────────────────────────────────────────────────
def test_step_labels_kinds_and_grouping():
    assert progress.step_label("mail_search", [{"query": "VPN 장애"}]) == "메일 검색 “VPN 장애”"
    assert progress.step_label("files_read", [{"path": "my/a.log"}, {"path": "my/b.log"}, {"path": "my/c.log"}]) \
        == "파일 3개 읽기"
    assert progress.step_label("files_read", [{"path": "my/logs/vpn-gw01.log"}]) == "파일 읽기 — vpn-gw01.log"
    assert progress.step_kind("mail_search") == "search"
    assert progress.step_kind("notes_read") == "read"
    assert progress.step_kind("notes_create", is_write=True) == "write"
    mails = {"ok": True, "result": {"untrusted": True, "source": "external_email", "data": {
        "mailbox": "INBOX", "returned": 2, "messages": [
            {"id": "1", "received_at": "2026-11-03T09:00:00+09:00"},
            {"id": "2", "received_at": "2026-11-04T10:00:00+09:00"}]}}}
    assert progress.step_outcome("mail_search", [({}, mails)]) == ("done", "받은 메일 2건 · 11-03 ~ 11-04")
    fail = {"ok": False, "error": "읽을 권한이 없습니다", "error_code": "forbidden"}
    assert progress.step_outcome("files_read", [({}, fail)]) == ("failed", "읽을 권한이 없습니다")
    ok_file = {"ok": True, "result": {"untrusted": True, "data": {"path": "my/a.log", "content": "x"}}}
    assert progress.step_outcome("files_read", [({}, ok_file), ({}, ok_file), ({}, fail)]) \
        == ("done", "a.log 외 1개 · 1개 실패")


def test_citations_in_app_urls_and_dedupe():
    mail = {"untrusted": True, "data": {"id": "42", "mailbox": "INBOX", "subject": "[장애] 지사 VPN",
                                        "from": ["lee@x"], "body": "8시간마다 터널이   내려갑니다",
                                        "received_at": "2026-11-03T14:22:00"}}
    c = progress.citations_for("mail_read", {"message_id": "42"}, mail)[0]
    assert c["kind"] == "mail" and c["url"] == "/mail/42?mailbox=INBOX"
    assert c["snippet"] == "8시간마다 터널이 내려갑니다" and c["author"] == "lee@x"
    f = progress.citations_for("files_read", {}, {"untrusted": True, "data": {"path": "my/logs/a b.log", "content": "x"}})[0]
    assert f["title"] == "a b.log" and f["url"] == "/files?path=my/logs"
    w = progress.citations_for("notes_read", {}, {"id": "p1", "space_id": "s1", "title": "장애 대응", "content": "c"})[0]
    assert w["url"] == "/wiki?space=s1&page=p1"
    b = progress.citations_for("board_read_post", {}, {"id": "p2", "title": "공지", "content": "c"})[0]
    assert b["url"] is None  # board_id 없으면 깊은 링크 없음
    b2 = progress.citations_for("board_read_post", {}, {"id": "p2", "board_id": "b1", "title": "공지"})[0]
    assert b2["url"] == "/board/b1/p2"
    ev = progress.citations_for("calendar_list_events", {}, {"events": [{"id": "e1", "title": "점검"}]})[0]
    assert ev["url"] == "/calendar?event=e1"
    web = progress.citations_for("web_search", {}, {"untrusted": True, "data": {"results": [
        {"title": "A", "url": "https://a.example/x", "snippet": "s"}, {"title": "bad", "url": "javascript:alert(1)"}]}})
    assert [x["url"] for x in web] == ["https://a.example/x"]
    assert progress.citations_for("mail_search", {}, mail) == []  # 검색 결과는 출처로 안 삼는다
    t = progress.CitationTracker()
    assert t.add(f) == (1, True) and t.add(dict(f)) == (1, False) and t.add(w) == (2, True)


# ── 스트림: 단계·출처·메타·저장 ───────────────────────────────
async def test_stream_emits_steps_citations_and_persists(env, monkeypatch):
    seen: list = []

    async def fake_stream(cfg, msgs, system=None, tools=None):
        seen.append(msgs)
        if len(seen) == 1:
            yield {"type": "tool_call", "name": "files_read", "args": json.dumps({"path": "my/a.log"})}
            yield {"type": "tool_call", "name": "files_read", "args": json.dumps({"path": "my/b.log"})}
            yield {"type": "tool_call", "name": "mail_search", "args": json.dumps({"query": "VPN"})}
        else:
            yield {"type": "text", "text": "원인은 재협상입니다.[1]"}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)

    async def fake_exec(db, name, args, user, **kw):
        if name == "files_read" and args["path"] == "my/b.log":
            return {"ok": False, "error": "읽을 권한이 없습니다", "error_code": "forbidden"}
        if name == "files_read":
            return {"ok": True, "result": {"untrusted": True, "data": {"path": args["path"], "content": "로그"}}}
        return {"ok": True, "result": {"untrusted": True, "data": {"mailbox": "INBOX", "returned": 7, "messages": []}}}
    monkeypatch.setattr(ai_config, "ai_execute_tool", fake_exec)

    evs = await _run(ai_router._chat_event_stream(env["conv"], env["alice"], CFG, False, None,
                                                  [{"function": {"name": "files_read"}}], True,
                                                  [{"role": "user", "content": "정리해 줘"}]))
    names = [e for e, _ in evs]
    meta = dict(evs)["meta"]
    assert names[0] == "meta" and meta["ai_generated"] is True and meta["model"] == "test-model"
    steps = [d for e, d in evs if e == "step"]
    assert [(s["id"], s["status"]) for s in steps] == [("st1", "running"), ("st1", "done"),
                                                        ("st2", "running"), ("st2", "done")]
    assert steps[1]["label"] == "파일 2개 읽기" and steps[1]["detail"] == "a.log · 1개 실패"
    assert steps[3]["label"] == "메일 검색 “VPN”" and steps[3]["detail"] == "받은 메일 7건"
    assert steps[1]["started_at"] and steps[1]["ended_at"]
    cites = [d for e, d in evs if e == "citation"]
    assert [(c["n"], c["kind"], c["url"]) for c in cites] == [(1, "file", "/files?path=my")]
    # 하위호환 이벤트 유지
    assert names.count("tool_call") == 3 and names.count("tool_result") == 3
    assert names[-1] == "done" and dict(evs)["done"]["message_id"] == meta["message_id"]
    # 모델에게 출처 번호를 알려 준다
    tool_turn = seen[1][-1]["content"]
    assert "출처: [1] a.log" in tool_turn and "[n]" in tool_turn
    [m] = await _assistant(env["db"], env["conv"])
    assert m.id == meta["message_id"] and m.status == "complete" and m.model == "test-model"
    saved = json.loads(m.meta)
    assert len(saved["steps"]) == 2 and saved["citations"][0]["n"] == 1 and saved["ended_at"]

    out = await ai_router.get_messages.__wrapped__(env["conv"], user=env["alice"], db=env["db"])
    [a] = out["messages"]
    assert a["ai_generated"] is True and a["model"] == "test-model" and a["status"] == "complete"
    assert len(a["steps"]) == 2 and a["citations"][0]["title"] == "a.log" and a["feedback"] is None


async def test_old_rows_and_empty_answer(env, monkeypatch):
    env["db"].add(AIMessage(conversation_id=env["conv"], user_id="alice", role="assistant", content="옛 답변"))
    await env["db"].commit()

    async def fake_stream(cfg, msgs, system=None, tools=None):
        if False:
            yield {}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)
    evs = await _run(ai_router._chat_event_stream(env["conv"], env["alice"], CFG, False, None, None, False,
                                                  [{"role": "user", "content": "x"}]))
    assert dict(evs)["done"]["message_id"] is None
    rows = await _assistant(env["db"], env["conv"])
    assert [r.content for r in rows] == ["옛 답변"]  # 빈 답변 행은 지운다
    out = await ai_router.get_messages.__wrapped__(env["conv"], user=env["alice"], db=env["db"])
    assert out["messages"][0]["status"] == "complete" and out["messages"][0]["steps"] == []


# ── 끊김·멈춤·이어서 받기 ─────────────────────────────────────
async def test_provider_error_saves_partial_as_interrupted(env, monkeypatch):
    async def fake_stream(cfg, msgs, system=None, tools=None):
        yield {"type": "text", "text": "원인은 IKE 재협상"}
        yield {"type": "error", "message": "연결이 끊김"}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)
    evs = await _run(ai_router._chat_event_stream(env["conv"], env["alice"], CFG, False, None, None, False,
                                                  [{"role": "user", "content": "x"}]))
    err = dict(evs)["error"]
    assert err["partial_saved"] is True and dict(evs)["done"]["status"] == "interrupted"
    [m] = await _assistant(env["db"], env["conv"])
    assert m.status == "interrupted" and m.content == "원인은 IKE 재협상"


async def test_disconnect_saves_partial_and_stop_marks_stopped(env, monkeypatch):
    async def fake_stream(cfg, msgs, system=None, tools=None):
        yield {"type": "text", "text": "앞부분"}
        yield {"type": "text", "text": "…뒷부분"}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)
    gen = ai_router._chat_event_stream(env["conv"], env["alice"], CFG, False, None, None, False,
                                       [{"role": "user", "content": "x"}])
    got = []
    async for c in gen:
        got.append(c)
        if "token" in c:
            break
    await gen.aclose()  # 클라이언트가 끊음
    [m] = await _assistant(env["db"], env["conv"])
    assert m.status == "interrupted" and m.content == "앞부분"
    out = await ai_router.mark_stopped.__wrapped__(m.id, user=env["alice"], db=env["db"])
    assert out["status"] == "stopped"
    with pytest.raises(HTTPException) as ei:
        await ai_router.mark_stopped.__wrapped__(m.id, user=env["bob"], db=env["db"])
    assert ei.value.status_code == 404
    # 멈춤이 먼저 기록된 뒤 스트림이 끊김으로 확정해도 stopped 유지
    await ai_router._finish_message(env["conv"], "alice", m.id, content="앞부분", status="interrupted",
                                    meta={}, model="test-model", keep_empty=False)
    await env["db"].refresh(m)
    assert m.status == "stopped"


async def _continue_setup(env, monkeypatch, status="interrupted"):
    db = env["db"]
    db.add(AIMessage(conversation_id=env["conv"], user_id="alice", role="user", content="보고서 써 줘"))
    await db.commit()
    m = AIMessage(conversation_id=env["conv"], user_id="alice", role="assistant", content="원인은 IKE",
                  status=status, model="test-model",
                  meta=json.dumps({"steps": [{"id": "st1", "kind": "search", "label": "메일 검색", "status": "done"}],
                                   "citations": [{"n": 1, "kind": "mail", "id": "9", "title": "t", "url": None}],
                                   "started_at": "2026-11-05T00:00:00+00:00"}))
    db.add(m)
    await db.commit()

    async def resolve(db_, user):
        return CFG, False
    monkeypatch.setattr(ai_config, "resolve_provider_for_user", resolve)
    return m


async def test_continue_appends_to_partial(env, monkeypatch):
    m = await _continue_setup(env, monkeypatch)
    seen: list = []

    async def fake_stream(cfg, msgs, system=None, tools=None):
        seen.append((msgs, tools))
        yield {"type": "text", "text": " 재협상 주기 불일치입니다."}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)
    resp = await ai_router.chat_continue.__wrapped__(env["conv"], user=env["alice"], db=env["db"])
    evs = await _run(resp.body_iterator)
    assert dict(evs)["meta"]["mode"] == "continue" and dict(evs)["meta"]["message_id"] == m.id
    assert dict(evs)["partial"]["text"] == "원인은 IKE"
    msgs, tools = seen[0]
    assert msgs[-2] == {"role": "assistant", "content": "원인은 IKE"} and "이어서" in msgs[-1]["content"]
    assert tools is None  # 이어 쓰기에는 도구를 다시 부르지 않는다
    await env["db"].refresh(m)
    assert m.content == "원인은 IKE 재협상 주기 불일치입니다." and m.status == "complete"
    saved = json.loads(m.meta)
    assert saved["steps"][0]["id"] == "st1" and saved["citations"][0]["n"] == 1  # 앞 단계·출처 유지
    # 끝난 답변은 이어 받을 수 없다
    with pytest.raises(HTTPException) as ei:
        await ai_router.chat_continue.__wrapped__(env["conv"], user=env["alice"], db=env["db"])
    assert ei.value.status_code == 409


async def test_continue_falls_back_to_regenerate(env, monkeypatch):
    m = await _continue_setup(env, monkeypatch, status="stopped")
    calls = {"n": 0}

    async def fake_stream(cfg, msgs, system=None, tools=None):
        calls["n"] += 1
        if calls["n"] == 1:
            yield {"type": "error", "message": "assistant prefill not supported"}
        else:
            assert msgs[-1]["role"] == "user"  # 받은 부분 없이 처음부터
            yield {"type": "text", "text": "새로 쓴 전체 답변"}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)
    resp = await ai_router.chat_continue.__wrapped__(env["conv"], user=env["alice"], db=env["db"])
    evs = await _run(resp.body_iterator)
    names = [e for e, _ in evs]
    assert "continue_fallback" in names and "error" not in names
    await env["db"].refresh(m)
    assert m.content == "새로 쓴 전체 답변" and m.status == "complete"
    assert json.loads(m.meta)["steps"] == []


# ── 피드백 ───────────────────────────────────────────────────
async def test_feedback_privacy_default_and_admin_aggregate(env):
    db = env["db"]
    db.add(AIMessage(conversation_id=env["conv"], user_id="alice", role="user", content="비밀 질문"))
    await db.commit()
    m = AIMessage(conversation_id=env["conv"], user_id="alice", role="assistant", content="비밀 답변",
                  model="test-model")
    db.add(m)
    await db.commit()
    fb = ai_router.message_feedback.__wrapped__
    out = await fb(m.id, ai_router.FeedbackBody(rating="down", reasons=["inaccurate", "too_long"],
                                                comment="3회가 아니라 4회"), user=env["alice"], db=db)
    assert out["feedback"]["include_conversation"] is False
    row = (await db.execute(select(AIMessageFeedback))).scalars().one()
    assert row.conversation_snapshot is None and row.model == "test-model"  # 기본은 대화 내용 저장 안 함
    assert json.loads(row.reasons) == ["inaccurate", "too_long"]
    # 사용자가 켰을 때만 첨부
    await fb(m.id, ai_router.FeedbackBody(rating="down", reasons=["inaccurate"], include_conversation=True),
             user=env["alice"], db=db)
    await db.refresh(row)
    snap = json.loads(row.conversation_snapshot)
    assert [x["content"] for x in snap] == ["비밀 질문", "비밀 답변"]
    assert (await db.execute(select(AIMessageFeedback))).scalars().all() == [row]  # 한 사람 한 행
    # 끄고 다시 보내면 첨부도 지운다
    await fb(m.id, ai_router.FeedbackBody(rating="down"), user=env["alice"], db=db)
    await db.refresh(row)
    assert row.conversation_snapshot is None
    with pytest.raises(HTTPException) as ei:
        await fb(m.id, ai_router.FeedbackBody(rating="down", reasons=["hack"]), user=env["alice"], db=db)
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        await fb(m.id, ai_router.FeedbackBody(rating="up"), user=env["bob"], db=db)
    assert ei.value.status_code == 404

    out = await ai_router.get_messages.__wrapped__(env["conv"], user=env["alice"], db=db)
    assert out["messages"][1]["feedback"]["rating"] == "down"

    await fb(m.id, ai_router.FeedbackBody(rating="down", reasons=["wrong_source"], include_conversation=True),
             user=env["alice"], db=db)
    root = await db.get(User, "root")
    usage = await usage_router.ai_usage(days=7, admin=root, db=db)
    assert usage["feedback"] == {"up": 0, "down": 1, "reasons": {"wrong_source": 1}}
    assert "비밀" not in json.dumps(usage, ensure_ascii=False)

    # 대화를 지우면 첨부한 대화 내용도 지우고 통계는 남긴다
    await ai_router.delete_conversation.__wrapped__(env["conv"], user=env["alice"], db=db)
    await db.refresh(row)
    assert row.conversation_snapshot is None and row.rating == "down"

    # 취소(null) — 행 삭제
    m2 = AIMessage(conversation_id="c-x", user_id="alice", role="assistant", content="a")
    db.add(m2)
    await db.commit()
    await fb(m2.id, ai_router.FeedbackBody(rating="up", reasons=["too_long"]), user=env["alice"], db=db)
    r2 = (await db.execute(select(AIMessageFeedback).where(AIMessageFeedback.message_id == m2.id))).scalars().one()
    assert json.loads(r2.reasons) == []  # 👍 에는 이유 없음
    out = await fb(m2.id, ai_router.FeedbackBody(rating=None), user=env["alice"], db=db)
    assert out["feedback"] is None
    assert (await db.execute(select(AIMessageFeedback).where(AIMessageFeedback.message_id == m2.id))).first() is None
