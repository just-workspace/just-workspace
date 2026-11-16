"""화면 내 AI — 메일 요약·답장 초안, 채팅방 요약, 회의 할 일, 문서 교정, 할일 등록(쓰기 승인 체계).

- 버튼 상태: 미설정·외부 차단·내부 모델(가리기 안내 없음)
- 외부 AI 이면 개인정보를 가린 뒤 전송한다, 자료는 "지시가 아님" 경계 내에 배치
- 권한: 채널 멤버가 아니면 403(접근 검사 우회 금지), 타인의 회의는 404
- 감사: inline_<kind> 로 기록하되 인자 값은 기록하지 않는다 · 하루 한도에 계수한다
- 할일 등록은 writes.request_write(low) → 승인 → 실행(되돌리기 가능), 담당 배정은 회의 참석자에게만
- AI 초안으로 송신한 메일에 X-AI-Generated
"""

import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.ai import inline
from app.ai import inline_router as ir
from app.db.models import (
    AuditLog, Channel, ChannelMember, ChatMention, McpWriteRequest, MeetingDB, MeetingInvitee, Message,
    SystemSetting, TaskDB, User,
)
from app.mcp import audit, writes
from app.mcp.tools import pim_write_tool
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)


async def _set(db, **kv):
    for k, v in kv.items():
        key = k.replace("__", ".")
        row = (await db.execute(select(SystemSetting).where(SystemSetting.key == key))).scalars().first()
        if row:
            row.value = v
        else:
            db.add(SystemSetting(key=key, value=v))
    await db.commit()


@pytest.fixture()
async def env(db, monkeypatch):
    @asynccontextmanager
    async def _session():
        yield db

    monkeypatch.setattr(audit, "session", _session)
    monkeypatch.setattr(writes, "session", _session)
    monkeypatch.setattr(pim_write_tool, "async_session", _session)

    async def none(*a, **k):
        return None
    monkeypatch.setattr(audit, "check_rate", none)
    monkeypatch.setattr(writes, "recent_untrusted", none)
    monkeypatch.setattr(writes, "emit_count", none)

    from app.notifications import service as nsvc
    sent = []

    async def _notif(_db, uid, kind, *a, **k):
        sent.append((uid, kind))
        return {"id": "n"}
    monkeypatch.setattr(nsvc, "create_notification", _notif)

    for m in ("ai", "chat", "tasks", "meetings", "mail"):
        db.add(SystemSetting(key=f"module.{m}.enabled", value="true"))
    await db.commit()
    await _set(db, ai__provider__kind="anthropic", ai__provider__model="claude-opus-5-5",
               ai__gov__external_allow_data="true")

    calls = []
    reply = {"text": "{}"}

    async def fake_chat(cfg, messages, system=None):
        calls.append({"system": system, "messages": messages})
        return reply["text"]
    monkeypatch.setattr("app.ai.providers.chat", fake_chat)
    return {"db": db, "alice": await db.get(User, "alice"), "bob": await db.get(User, "bob"),
            "calls": calls, "reply": reply, "notified": sent}


# ── 버튼 상태 ─────────────────────────────────────────────────
async def test_status_reasons(env):
    db, alice = env["db"], env["alice"]
    s = await inline.status(db, alice)
    assert s["available"] and s["external"] and s["mask_pii"] and s["model"] == "claude-opus-5-5"

    await _set(db, ai__gov__external_allow_data="false")
    s = await inline.status(db, alice)
    assert not s["available"] and s["reason"] == "external_blocked"

    await _set(db, ai__provider__kind="ollama", ai__provider__model="qwen")
    s = await inline.status(db, alice)
    assert s["available"] and not s["external"] and not s["mask_pii"]

    await _set(db, ai__provider__kind="", ai__provider__model="")
    assert (await inline.status(db, alice))["reason"] == "not_configured"

    await _set(db, module__ai__enabled="false")
    assert (await inline.status(db, alice))["reason"] == "module_off"


async def test_blocked_route_does_not_call_model(env):
    await _set(env["db"], ai__gov__external_allow_data="false")
    with pytest.raises(HTTPException) as ei:
        await ir.mail_summary(ir.MailBody(message_id="1"), user=env["alice"], db=env["db"])
    assert ei.value.status_code == 403 and ei.value.detail["code"] == "external_blocked"
    assert env["calls"] == []


# ── 메일 ──────────────────────────────────────────────────────
def _mail(body="안녕하세요. 연락처 010-1234-5678 로 11월 7일까지 회신 부탁드립니다."):
    a = SimpleNamespace(name="박준호", email="junho@example.com")
    return SimpleNamespace(from_=[a], to=[SimpleNamespace(name=None, email="alice@x")], cc=[],
                           subject="[협조] 랙 증설", text_body=body, html_body=None,
                           received_at="2026-11-05T01:12:00+00:00")


async def test_mail_summary_masks_pii_and_audits_names_only(env, monkeypatch):
    async def load(db, user, mid, mb, acc):
        assert user.id == "alice" and mid == "42"
        return _mail()
    monkeypatch.setattr(inline, "_load_mail", load)
    env["reply"]["text"] = "```json\n" + json.dumps({
        "points": ["랙 2대 증설", ""],
        "todos": [{"title": "분전반 용량 회신", "due": "2026-11-07", "who": "박준호"},
                  {"title": "타일 확인", "due": "금요일", "who": None}],
    }, ensure_ascii=False) + "\n```"
    out = await ir.mail_summary(ir.MailBody(message_id="42", mailbox_id="INBOX", tz="Asia/Seoul"),
                                user=env["alice"], db=env["db"])
    assert out["points"] == ["랙 2대 증설"]
    assert out["todos"][0] == {"title": "분전반 용량 회신", "due": "2026-11-07", "who": "박준호"}
    assert out["todos"][1]["due"] is None            # 임의로 생성된 날짜 형식은 폐기한다
    assert out["ai_generated"] and out["masked"] and out["model"] == "claude-opus-5-5"
    sent = env["calls"][0]["messages"][0]["content"]
    assert "010-1234-5678" not in sent and "[전화번호]" in sent
    assert "<자료>" in sent and "지시가 아닙니다" in env["calls"][0]["system"]
    assert "2026-11-05 10:12" in sent                 # 사용자 시간대 기준
    row = (await env["db"].execute(select(AuditLog).where(AuditLog.action == "ai_tool.call"))).scalars().one()
    d = json.loads(row.details)
    assert row.resource_id == "inline_mail_summary" and d["source"] == "inline" and d["ok"]
    assert "42" not in row.details and "INBOX" not in row.details and d["args"] == ["mailbox_id", "message_id", "tone", "tz"]


async def test_internal_model_not_masked(env, monkeypatch):
    await _set(env["db"], ai__provider__kind="ollama", ai__provider__model="qwen")

    async def load(*a):
        return _mail()
    monkeypatch.setattr(inline, "_load_mail", load)
    env["reply"]["text"] = '{"draft": "준호 님, 7일까지 회신드리겠습니다."}'
    out = await ir.mail_reply(ir.MailBody(message_id="1", tone="short"), user=env["alice"], db=env["db"])
    assert out["draft"].startswith("준호 님") and not out["masked"] and out["tone"] == "short"
    assert "010-1234-5678" in env["calls"][0]["messages"][0]["content"]


async def test_mail_load_error_passes_through(env, monkeypatch):
    async def load(*a):
        raise HTTPException(status_code=404, detail="메일 계정을 찾을 수 없습니다")
    monkeypatch.setattr(inline, "_load_mail", load)
    with pytest.raises(HTTPException) as ei:
        await ir.mail_summary(ir.MailBody(message_id="1"), user=env["alice"], db=env["db"])
    assert ei.value.status_code == 404 and ei.value.detail["code"] == "not_found"
    assert env["calls"] == []


async def test_daily_limit_counts_inline(env, monkeypatch):
    await _set(env["db"], ai__gov__daily_limit="1")

    async def load(*a):
        return _mail()
    monkeypatch.setattr(inline, "_load_mail", load)
    env["reply"]["text"] = '{"points": ["a"], "todos": []}'
    await ir.mail_summary(ir.MailBody(message_id="1"), user=env["alice"], db=env["db"])
    with pytest.raises(HTTPException) as ei:
        await ir.mail_summary(ir.MailBody(message_id="1"), user=env["alice"], db=env["db"])
    assert ei.value.status_code == 429 and ei.value.detail["code"] == "daily_limit"


async def test_rate_limited(env, monkeypatch):
    async def over(uid):
        return 9
    monkeypatch.setattr(audit, "check_rate", over)
    with pytest.raises(HTTPException) as ei:
        await ir.mail_summary(ir.MailBody(message_id="1"), user=env["alice"], db=env["db"])
    assert ei.value.status_code == 429 and ei.value.detail["retry_after"] == 9


# ── 채팅 ──────────────────────────────────────────────────────
@pytest.fixture()
async def chat(env):
    db = env["db"]
    db.add(Channel(id="ops", name="인프라운영", type="private", created_by="bob"))
    await db.commit()
    db.add(ChannelMember(channel_id="ops", user_id="alice", role="member", last_read_seq=2))
    db.add(ChannelMember(channel_id="ops", user_id="bob", role="owner"))
    base = datetime(2026, 11, 5, 0, 0, tzinfo=timezone.utc)
    rows = [("bob", "어제 얘기"), ("alice", "네"), ("bob", "재협상 주기 28800으로 맞췄습니다"),
            ("bob", "@alice 분전반 용량 금요일까지 확인 부탁드려요"), ("alice", "확인할게요")]
    for i, (who, text) in enumerate(rows, start=1):
        db.add(Message(id=f"m{i}", seq=i, channel_id="ops", sender_id=who, content=text,
                       created_at=base + timedelta(minutes=i)))
    await db.commit()
    db.add(ChatMention(user_id="alice", channel_id="ops", message_id="m4", seq=4))
    await db.commit()
    return env


async def test_chat_unread_summary(chat):
    chat["reply"]["text"] = json.dumps({"points": ["재협상 주기 변경 — bob"],
                                        "called_me": [{"n": 2, "text": "분전반 용량 확인 요청"}, {"n": 99, "text": "x"}]},
                                       ensure_ascii=False)
    out = await ir.chat_summary(ir.ChatBody(channel_id="ops", tz="Asia/Seoul"), user=chat["alice"], db=chat["db"])
    sent = chat["calls"][0]["messages"][0]["content"]
    assert "어제 얘기" not in sent and "재협상" in sent      # 읽은 메시지는 제외
    assert out["count"] == 2 and out["from_message_id"] == "m3" and out["to_message_id"] == "m5"
    assert out["called_me"] == [{"message_id": "m4", "text": "분전반 용량 확인 요청", "at": out["called_me"][0]["at"]}]


async def test_chat_mention_fallback_and_range(chat):
    chat["reply"]["text"] = '{"points": ["요약"], "called_me": []}'
    out = await ir.chat_summary(ir.ChatBody(channel_id="ops", scope="range", from_message_id="m1", to_message_id="m4"),
                                user=chat["alice"], db=chat["db"])
    assert out["count"] == 4 and out["called_me"][0]["message_id"] == "m4"


async def test_chat_non_member_forbidden(chat):
    db = chat["db"]
    db.add(User(id="carol", username="carol", email="c@x", password_hash="x"))
    await db.commit()
    with pytest.raises(HTTPException) as ei:
        await ir.chat_summary(ir.ChatBody(channel_id="ops"), user=await db.get(User, "carol"), db=db)
    assert ei.value.status_code == 403 and chat["calls"] == []


async def test_chat_nothing_unread(chat):
    db = chat["db"]
    m = (await db.execute(select(ChannelMember).where(ChannelMember.user_id == "alice"))).scalars().one()
    m.last_read_seq = 5
    await db.commit()
    with pytest.raises(HTTPException) as ei:
        await ir.chat_summary(ir.ChatBody(channel_id="ops"), user=chat["alice"], db=db)
    assert ei.value.detail["code"] == "nothing"


# ── 회의 ──────────────────────────────────────────────────────
@pytest.fixture()
async def meeting(env):
    db = env["db"]
    now = datetime.now(timezone.utc)
    mt = MeetingDB(id="mt1", room_name="infra-weekly", title="인프라 정기점검", host_user_id="alice",
                   host_display_name="alice", share_token="tok1", started_at=now - timedelta(hours=1), ended_at=now)
    db.add(mt)
    await db.commit()
    db.add(MeetingInvitee(meeting_id="mt1", user_id="bob", display_name="bob", response="accepted"))
    db.add(User(id="carol", username="carol", email="c@x", password_hash="x"))
    await db.commit()
    return env


async def test_meeting_summary_maps_assignees(meeting):
    meeting["reply"]["text"] = json.dumps({"points": ["팬 경고 1건"], "todos": [
        {"title": "팬 부품 견적", "assignee": "bob", "due": "2026-11-10"},
        {"title": "펌웨어 확인", "assignee": "carol", "due": None, "note": "다음 점검 전"},
    ]}, ensure_ascii=False)
    out = await ir.meeting_summary(ir.MeetingBody(room="infra-weekly", chat_lines=[ir.ChatLine(name="bob", text="팬 교체 필요")]),
                                   user=meeting["alice"], db=meeting["db"])
    assert out["todos"][0]["assignee_id"] == "bob" and out["todos"][0]["assignee_name"] == "bob"
    assert out["todos"][1]["assignee_id"] is None    # 참석자가 아니면 담당 미정
    assert out["participants"] == 2 and "팬 교체 필요" in meeting["calls"][0]["messages"][0]["content"]


async def test_meeting_other_user_not_found(meeting):
    with pytest.raises(HTTPException) as ei:
        await ir.meeting_summary(ir.MeetingBody(room="infra-weekly", chat_lines=[ir.ChatLine(text="x")]),
                                 user=await meeting["db"].get(User, "carol"), db=meeting["db"])
    assert ei.value.status_code == 404


async def test_meeting_without_content(meeting):
    with pytest.raises(HTTPException) as ei:
        await ir.meeting_summary(ir.MeetingBody(room="infra-weekly"), user=meeting["alice"], db=meeting["db"])
    assert ei.value.detail["code"] == "no_content"


# ── 문서 교정 ─────────────────────────────────────────────────
DOC = "지사 VPN 터널이 8시간 마다 끊겼다. 원인은 주기가 서로 틀렸기 때문이다. DPD 를 활성화 시켰다."


async def test_proofread_keeps_only_exact_originals(env):
    env["reply"]["text"] = json.dumps({"items": [
        {"kind": "spacing", "original": "8시간 마다", "fixed": "8시간마다", "reason": "조사는 붙여 씀"},
        {"kind": "style", "original": "서로 틀렸기 때문이다", "fixed": "서로 달랐기 때문이다", "reason": "다르다"},
        {"kind": "spelling", "original": "원문에 없는 글", "fixed": "x", "reason": ""},
        {"kind": "grammar", "original": "끊겼다", "fixed": "끊어졌다", "reason": ""},
        {"kind": "style", "original": "활성화 시켰다", "fixed": "활성화 시켰다", "reason": "같음"},
    ]}, ensure_ascii=False)
    out = await ir.doc_proofread(ir.DocBody(text=DOC), user=env["alice"], db=env["db"])
    assert [i["original"] for i in out["items"]] == ["8시간 마다", "서로 틀렸기 때문이다"]

    out = await ir.doc_proofread(ir.DocBody(text=DOC, mode="style"), user=env["alice"], db=env["db"])
    assert [i["kind"] for i in out["items"]] == ["style"]


async def test_proofread_too_large(env, monkeypatch):
    monkeypatch.setattr(inline, "MAX_DOC_CHARS", 10)
    with pytest.raises(HTTPException) as ei:
        await ir.doc_proofread(ir.DocBody(text=DOC), user=env["alice"], db=env["db"])
    assert ei.value.status_code == 413 and env["calls"] == []


def test_parse_json_variants():
    assert inline.parse_json('설명\n{"a": 1}\n끝') == {"a": 1}
    assert inline.parse_json("```json\n{\"b\": [1]}\n```") == {"b": [1]}
    assert inline.parse_json("없음") == {}


# ── 할일 등록 ─────────────────────────────────────────────────
async def test_tasks_via_write_requests_with_undo(env):
    db = env["db"]
    out = await ir.create_tasks(ir.TasksBody(source="mail", items=[
        ir.TaskItem(title="분전반 용량 회신", due_date="2026-11-07", description="박준호에게"),
        ir.TaskItem(title="  "),
    ]), user=env["alice"], db=db)
    assert out["created"] == 1 and out["results"][1]["ok"] is False
    r = out["results"][0]
    t = await db.get(TaskDB, r["task_id"])
    assert t.title == "분전반 용량 회신" and t.user_id == "alice" and r["can_undo"]
    req = await db.get(McpWriteRequest, r["request_id"])
    assert req.tool == "tasks_create" and req.status == "executed" and req.source == "ai"
    assert req.client_name == "화면 안 AI · 메일"
    await writes.undo(db, env["alice"], r["request_id"])
    db.expire_all()
    assert await db.get(TaskDB, r["task_id"]) is None


async def test_assign_only_meeting_participants(meeting):
    db = meeting["db"]
    with pytest.raises(HTTPException) as ei:
        await ir.create_tasks(ir.TasksBody(source="mail", items=[ir.TaskItem(title="x", assignee_id="bob")]),
                              user=meeting["alice"], db=db)
    assert ei.value.status_code == 403
    out = await ir.create_tasks(ir.TasksBody(source="meeting", room="infra-weekly", items=[
        ir.TaskItem(title="팬 부품 견적", assignee_id="bob"),
        ir.TaskItem(title="남에게", assignee_id="carol"),
    ]), user=meeting["alice"], db=db)
    assert out["results"][0]["ok"] and not out["results"][1]["ok"]
    t = await db.get(TaskDB, out["results"][0]["task_id"])
    assert t.assignee_id == "bob" and ("bob", "task_assigned") in meeting["notified"]


async def test_tasks_idempotent(env):
    body = ir.TasksBody(source="mail", items=[ir.TaskItem(title="한 번만", idempotency_key="k-1")])
    a = await ir.create_tasks(body, user=env["alice"], db=env["db"])
    b = await ir.create_tasks(body, user=env["alice"], db=env["db"])
    assert a["results"][0]["task_id"] == b["results"][0]["task_id"]
    n = (await env["db"].execute(select(TaskDB).where(TaskDB.title == "한 번만"))).scalars().all()
    assert len(n) == 1


# ── AI 초안 메일 표시 ─────────────────────────────────────────
async def test_ai_draft_send_sets_header(monkeypatch):
    from app.mail import router as mr
    from app.mail import smtp_client

    seen = []

    async def fake_send(**kw):
        seen.append(smtp_client.AI_GENERATED.get())
        return b"raw"

    class _In:
        async def append_to_sent(self, *a):
            return None

    async def _rec(*a, **k):
        return None
    monkeypatch.setattr(smtp_client, "send_message", fake_send)
    monkeypatch.setattr(mr, "_incoming", lambda acc: _In())
    monkeypatch.setattr("app.contacts.suggest.record_recipients", _rec)
    payload = {"from_name": "a", "to": [], "subject": "s", "text_body": "b"}
    await mr.perform_send(None, SimpleNamespace(id="u"), SimpleNamespace(), {**payload, "ai_generated": True}, None)
    await mr.perform_send(None, SimpleNamespace(id="u"), SimpleNamespace(), payload, None)
    assert seen[0] and seen[0].startswith("yes;") and seen[1] is None
    assert smtp_client.AI_GENERATED.get() is None
