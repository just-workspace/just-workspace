"""MCP S3 — 도메인 쓰기 도구(파일·메일·일정·할일·위키·게시판·채팅).

도메인마다: low 는 바로 실행 / high 는 승인 대기(승인 전엔 실행 안 함) / 남의 것은 거부 / 되돌리기로 원상복구.
저장소 루트는 임시 폴더, DB 는 SQLite(tests.test_settings_security_p8 의 db 픽스처).
"""

from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.db.models import (
    Board, CalendarEventDB, Channel, ChannelMember, MailAccount, MailDraft, McpWriteRequest, Message, Post,
    PostComment, ShareLink, TaskDB, User, WikiPage, WikiPageVersion, WikiSpace, WikiSpaceMember,
)
from app.mcp import server as reg
from app.mcp import writes
from app.mcp.access import TOOL_MODULE
from app.mcp.server import execute_tool
from app.mcp.tools import collab_write_tool, files_write_tool, mail_write_tool, notes_tool, pim_write_tool
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)

SCOPES = frozenset({"mcp:read", "mcp:write"})

NEW_TOOLS = {
    "files_write_text": "low", "files_create_folder": "low", "files_copy": "low", "files_move": "low",
    "files_undo_create": "low", "files_delete": "high", "files_share_external": "high",
    "mail_save_draft": "low", "mail_undo_save_draft": "low", "mail_send": "high",
    "calendar_create_event": "low", "calendar_undo_create_event": "low", "calendar_update_event": "low",
    "calendar_delete_event": "high",
    "tasks_create": "low", "tasks_undo_create": "low", "tasks_update": "low", "tasks_delete": "high",
    "notes_create": "low", "notes_undo_create": "low", "notes_update": "low", "notes_delete": "high",
    "board_create_post": "low", "board_undo_create_post": "low", "board_add_comment": "low",
    "board_undo_add_comment": "low", "board_delete_post": "high",
    "chat_send_message": "low", "chat_undo_send_message": "low",
}


class _Ctx:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        return self.db

    async def __aexit__(self, *a):
        return False


@pytest.fixture()
async def env(db, tmp_path: Path, monkeypatch):
    @asynccontextmanager
    async def _session():
        yield db

    for mod in (files_write_tool, mail_write_tool, pim_write_tool, notes_tool, collab_write_tool):
        monkeypatch.setattr(mod, "async_session", _session)
    monkeypatch.setattr(writes, "session", _session)

    async def none(*a, **k):
        return None
    monkeypatch.setattr(writes, "recent_untrusted", none)
    monkeypatch.setattr(writes, "emit_count", none)
    monkeypatch.setattr(writes, "_notify_pending", none)

    # 파일 저장소 = 임시 폴더
    from app.files import activity as act
    from app.files import indexer
    from app.files import router as fr
    from app.files import service as fs

    async def _act_session():
        return _Ctx(db)
    monkeypatch.setattr(act, "_session", _act_session)
    monkeypatch.setattr(fr.settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(fs, "STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(fs, "VERSIONS_ROOT", tmp_path / ".versions")
    monkeypatch.setattr(indexer, "schedule_quick_index", lambda *a, **k: None)
    fs._dir_cache.clear()
    for u in ("alice", "bob"):
        (tmp_path / "users" / u).mkdir(parents=True)
    (tmp_path / "users" / "alice" / "docs").mkdir()
    (tmp_path / "users" / "alice" / "docs" / "a.txt").write_text("hello", encoding="utf-8")
    (tmp_path / "users" / "bob" / "secret.txt").write_text("bob only", encoding="utf-8")

    # 알림은 기록만
    from app.notifications import service as nsvc

    async def _notif(*a, **k):
        return {"id": "n"}
    monkeypatch.setattr(nsvc, "create_notification", _notif)

    alice = await db.get(User, "alice")
    bob = await db.get(User, "bob")
    return {"db": db, "root": tmp_path, "alice": alice, "bob": bob}


def _mcp():
    return writes.call_context.set(writes.CallContext(source="mcp", client_name="Claude",
                                                      client_kind="claude_app", client_key="k1"))


async def call(name: str, args: dict, user: User) -> dict:
    t = _mcp()
    try:
        return await execute_tool(name, args, user, scopes=SCOPES)
    finally:
        writes.call_context.reset(t)


async def run_low(env, name, args, user=None) -> dict:
    """low 도구 — 바로 실행돼야 한다. (req_id, result) 반환."""
    r = await call(name, args, user or env["alice"])
    assert r["ok"], r
    assert r["result"]["status"] == "executed", r
    return r["result"]


async def run_fail(env, name, args, user=None) -> dict:
    r = await call(name, args, user or env["alice"])
    assert r["ok"] is False, r
    return r


async def pend_high(env, name, args, user=None) -> str:
    r = await call(name, args, user or env["alice"])
    assert r["ok"] and r["result"]["status"] == "pending_approval", r
    return r["result"]["approval_id"]


async def approve(env, rid, user=None) -> McpWriteRequest:
    return await writes.approve(env["db"], user or env["alice"], rid)


# ── 공통 ──────────────────────────────────────────────────────
def test_all_new_tools_registered_with_risk_module_and_labels():
    for name, risk in NEW_TOOLS.items():
        t = reg.WORKSPACE_TOOLS[name]
        assert t.scope == "mcp:write" and t.risk == risk, name
        assert TOOL_MODULE.get(name), name
        assert t.title, name
        for k, p in (t.parameters.get("properties") or {}).items():
            assert p.get("x-label"), f"{name}.{k} x-label 없음"
        if risk == "high":
            assert "approval" in t.description and "approvals_status" in t.description, name


def test_mail_summary_flags_external(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "domain", "x")
    s = mail_write_tool.summarize_recipients({"to": ["alice@x", "Ext <ext@gmail.com>"], "cc": ["bob@x"],
                                              "subject": "보고"})
    assert s == "받는 사람 3명(외부 1) · 보고"
    assert files_write_tool.vp_label("my/프로젝트/보고서.docx") == "내 파일 › 프로젝트 › 보고서.docx"
    assert files_write_tool.vp_label("shared-with-me/abc/x.txt") == "공유받은 항목 › x.txt"


# ── 파일 ──────────────────────────────────────────────────────
async def test_files_write_text_then_undo(env):
    res = await run_low(env, "files_write_text", {"path": "my/notes/회의록.md", "content": "# 안건\n- a"})
    f = env["root"] / "users" / "alice" / "notes" / "회의록.md"
    assert f.read_text(encoding="utf-8") == "# 안건\n- a" and res["can_undo"]
    assert "_undo" not in res["result"]
    await writes.undo(env["db"], env["alice"], res["request_id"])
    assert not f.exists()


async def test_files_write_text_refuses_overwrite_and_bad_ext(env):
    await run_fail(env, "files_write_text", {"path": "my/docs/a.txt", "content": "x"})
    assert (env["root"] / "users" / "alice" / "docs" / "a.txt").read_text(encoding="utf-8") == "hello"
    await run_fail(env, "files_write_text", {"path": "my/x.html", "content": "<script>"})
    assert not (env["root"] / "users" / "alice" / "x.html").exists()


async def test_files_undo_not_after_change_or_forged(env):
    res = await run_low(env, "files_write_text", {"path": "my/n.md", "content": "v1"})
    f = env["root"] / "users" / "alice" / "n.md"
    f.write_text("사용자가 고침", encoding="utf-8")
    with pytest.raises(writes.WriteError):
        await writes.undo(env["db"], env["alice"], res["request_id"])
    assert f.exists()
    # 서명 없이 되돌리기 도구로 남의(=만들지 않은) 파일 지우기 → 거부
    await run_fail(env, "files_undo_create", {"path": "my/docs/a.txt", "token": "deadbeef"})
    assert (env["root"] / "users" / "alice" / "docs" / "a.txt").exists()


async def test_files_folder_copy_move_and_undo(env):
    a = env["root"] / "users" / "alice"
    r1 = await run_low(env, "files_create_folder", {"path": "my/보관"})
    assert (a / "보관").is_dir()
    r2 = await run_low(env, "files_copy", {"src": "my/docs/a.txt", "dst_folder": "my/보관"})
    assert (a / "보관" / "a.txt").read_text(encoding="utf-8") == "hello"
    await writes.undo(env["db"], env["alice"], r2["request_id"])
    assert not (a / "보관" / "a.txt").exists() and (a / "docs" / "a.txt").exists()
    r3 = await run_low(env, "files_move", {"src": "my/docs/a.txt", "dst_folder": "my/보관", "new_name": "b.txt"})
    assert (a / "보관" / "b.txt").exists() and not (a / "docs" / "a.txt").exists()
    assert r3["result"]["path"] == "my/보관/b.txt"
    await writes.undo(env["db"], env["alice"], r3["request_id"])
    assert (a / "docs" / "a.txt").read_text(encoding="utf-8") == "hello" and not (a / "보관" / "b.txt").exists()
    await writes.undo(env["db"], env["alice"], r1["request_id"])
    assert not (a / "보관").exists()


async def test_files_other_users_storage_denied(env):
    await run_fail(env, "files_move", {"src": "users/bob/secret.txt", "dst_folder": "my"})
    await run_fail(env, "files_copy", {"src": "users/bob/secret.txt", "dst_folder": "my"})
    await run_fail(env, "files_copy", {"src": "shared-with-me/nope/x.txt", "dst_folder": "my"})
    assert (env["root"] / "users" / "bob" / "secret.txt").exists()
    assert not (env["root"] / "users" / "alice" / "secret.txt").exists()
    rid = await pend_high(env, "files_delete", {"path": "users/bob/secret.txt"})
    req = await approve(env, rid)
    assert req.status == "failed" and (env["root"] / "users" / "bob" / "secret.txt").exists()


async def test_files_delete_is_high_and_goes_to_trash(env):
    f = env["root"] / "users" / "alice" / "docs" / "a.txt"
    rid = await pend_high(env, "files_delete", {"path": "my/docs/a.txt"})
    assert f.exists()
    req = await approve(env, rid)
    assert req.status == "executed" and not f.exists()
    trash = list((env["root"] / "users" / "alice" / ".trash").iterdir())
    assert len(trash) == 1 and trash[0].name.endswith("_a.txt")


async def test_files_share_external_is_high(env):
    rid = await pend_high(env, "files_share_external", {"path": "my/docs/a.txt", "expires_in": "1d"})
    assert (await env["db"].execute(select(func.count()).select_from(ShareLink))).scalar() == 0
    d = writes.to_dict(await env["db"].get(McpWriteRequest, rid))
    assert d["target_summary"] == "외부 공유 링크 · 내 파일 › docs › a.txt · 1일"
    req = await approve(env, rid)
    assert req.status == "executed", req.error
    link = (await env["db"].execute(select(ShareLink))).scalars().one()
    assert link.created_by == "alice" and link.expires_at is not None
    assert "/api/files/shared/" in writes._uj(req.result)["url"]


# ── 메일 ──────────────────────────────────────────────────────
@pytest.fixture()
async def mail_env(env, monkeypatch):
    from app.mail import router as mr

    env["db"].add(MailAccount(user_id="alice", display_name="Alice", email="alice@x", imap_host="imap.example.com",
                              smtp_host="smtp.example.com", username="alice@x", password_encrypted="x",
                              is_default=True))
    await env["db"].commit()
    sent: list = []

    async def _send(db, user, account, payload, attachments):
        sent.append((user.id, account.email, payload))
    monkeypatch.setattr(mr, "perform_send", _send)
    env["sent"] = sent
    return env


async def test_mail_save_draft_then_undo(mail_env):
    env = mail_env
    res = await run_low(env, "mail_save_draft", {"to": ["홍길동 <hong@example.com>"], "subject": "초안",
                                                 "body": "안녕하세요\n감사합니다"})
    d = (await env["db"].execute(select(MailDraft))).scalars().one()
    assert d.user_id == "alice" and d.subject == "초안" and "hong@example.com" in d.to_addresses
    assert env["sent"] == []
    await writes.undo(env["db"], env["alice"], res["request_id"])
    assert (await env["db"].execute(select(func.count()).select_from(MailDraft))).scalar() == 0


async def test_mail_undo_bound_to_user(mail_env):
    env = mail_env
    res = await run_low(env, "mail_save_draft", {"to": ["a@b.co"], "subject": "s"})
    did = res["result"]["draft_id"]
    req = await env["db"].get(McpWriteRequest, res["request_id"])
    tok = writes._uj(req.undo)["args"]["token"]
    # bob 이 alice 의 서명을 들고 와도 거부(서명은 사용자에 묶임 + 소유 확인)
    await run_fail(env, "mail_undo_save_draft", {"draft_id": did, "token": tok}, user=env["bob"])
    assert await env["db"].get(MailDraft, did) is not None


async def test_mail_send_is_high_and_uses_own_account(mail_env):
    env = mail_env
    rid = await pend_high(env, "mail_send", {"to": ["ext@gmail.com"], "cc": ["bob@x"], "subject": "보고",
                                             "body": "본문"})
    assert env["sent"] == []
    req = await approve(env, rid)
    assert req.status == "executed", req.error
    uid, frm, payload = env["sent"][0]
    assert uid == "alice" and frm == "alice@x"
    assert payload["to"][0]["email"] == "ext@gmail.com" and payload["text_body"] == "본문"
    # 형식 오류는 승인 뒤 실행 단계에서 실패로 남는다(보내지 않음)
    bad = await pend_high(env, "mail_send", {"to": ["not-an-address"]})
    assert (await approve(env, bad)).status == "failed" and len(env["sent"]) == 1


async def test_mail_send_without_account_fails(mail_env):
    env = mail_env
    rid = await pend_high(env, "mail_send", {"to": ["a@b.co"]}, user=env["bob"])
    req = await approve(env, rid, user=env["bob"])
    assert req.status == "failed" and env["sent"] == []


# ── 일정 ──────────────────────────────────────────────────────
async def test_calendar_create_update_undo(env):
    res = await run_low(env, "calendar_create_event", {"title": "회의", "start": "2026-11-10T05:00:00+00:00",
                                                       "end": "2026-11-10T06:00:00+00:00"})
    eid = res["result"]["id"]
    ev = await env["db"].get(CalendarEventDB, eid)
    assert ev.title == "회의"
    up = await run_low(env, "calendar_update_event", {"event_id": eid, "title": "주간 회의", "location": "3층"})
    assert up["result"]["before"] == {"title": "회의", "location": ""}
    await env["db"].refresh(ev)
    assert ev.title == "주간 회의" and ev.location == "3층"
    await writes.undo(env["db"], env["alice"], up["request_id"])
    await env["db"].refresh(ev)
    assert ev.title == "회의" and not ev.location
    await writes.undo(env["db"], env["alice"], res["request_id"])
    env["db"].expire_all()
    assert await env["db"].get(CalendarEventDB, eid) is None


async def test_calendar_other_user_and_delete_high(env):
    res = await run_low(env, "calendar_create_event", {"title": "비밀", "start": "2026-11-10T05:00:00+00:00",
                                                       "end": "2026-11-10T06:00:00+00:00"})
    eid = res["result"]["id"]
    await run_fail(env, "calendar_update_event", {"event_id": eid, "title": "털림"}, user=env["bob"])
    rid_b = await pend_high(env, "calendar_delete_event", {"event_id": eid}, user=env["bob"])
    assert (await approve(env, rid_b, user=env["bob"])).status == "failed"
    rid = await pend_high(env, "calendar_delete_event", {"event_id": eid})
    title = (await env["db"].execute(select(CalendarEventDB.title).where(CalendarEventDB.id == eid))).scalar()
    assert title == "비밀"
    assert (await approve(env, rid)).status == "executed"
    n = (await env["db"].execute(select(func.count()).select_from(CalendarEventDB)
                                 .where(CalendarEventDB.id == eid))).scalar()
    assert n == 0
    await run_fail(env, "calendar_create_event", {"title": "x", "start": "2026-11-10T06:00:00+00:00",
                                                  "end": "2026-11-10T05:00:00+00:00"})


# ── 할일 ──────────────────────────────────────────────────────
async def test_tasks_create_update_undo(env):
    res = await run_low(env, "tasks_create", {"title": "보고서", "due_date": "2026-11-12"})
    tid = res["result"]["id"]
    up = await run_low(env, "tasks_update", {"task_id": tid, "status": "done", "due_date": ""})
    t = await env["db"].get(TaskDB, tid)
    await env["db"].refresh(t)
    assert t.status == "done" and t.due_date is None
    assert up["result"]["before"]["status"] == "todo" and up["result"]["before"]["due_date"].startswith("2026-11-12")
    await writes.undo(env["db"], env["alice"], up["request_id"])
    await env["db"].refresh(t)
    assert t.status == "todo" and t.due_date is not None
    await writes.undo(env["db"], env["alice"], res["request_id"])
    env["db"].expire_all()
    assert await env["db"].get(TaskDB, tid) is None


async def test_tasks_other_user_and_delete_high(env):
    res = await run_low(env, "tasks_create", {"title": "내 일"})
    tid = res["result"]["id"]
    await run_fail(env, "tasks_update", {"task_id": tid, "title": "남의 일"}, user=env["bob"])
    rid_b = await pend_high(env, "tasks_delete", {"task_id": tid}, user=env["bob"])
    assert (await approve(env, rid_b, user=env["bob"])).status == "failed"
    rid = await pend_high(env, "tasks_delete", {"task_id": tid})
    assert await env["db"].get(TaskDB, tid) is not None
    assert (await approve(env, rid)).status == "executed"
    env["db"].expire_all()
    assert await env["db"].get(TaskDB, tid) is None


# ── 위키 ──────────────────────────────────────────────────────
@pytest.fixture()
async def wiki_env(env):
    sp = WikiSpace(name="team", slug="team", owner_id="root", visibility="private")
    env["db"].add(sp)
    await env["db"].commit()
    env["db"].add(WikiSpaceMember(space_id=sp.id, user_id="alice", role="writer"))
    env["db"].add(WikiSpaceMember(space_id=sp.id, user_id="bob", role="reader"))
    await env["db"].commit()
    env["space"] = sp.id
    return env


async def _versions(db, pid):
    return (await db.execute(select(func.count()).select_from(WikiPageVersion)
                             .where(WikiPageVersion.page_id == pid))).scalar()


async def test_wiki_create_update_keeps_history_and_undo(wiki_env):
    env = wiki_env
    res = await run_low(env, "notes_create", {"title": "규칙", "content": "v1"})
    pid = res["result"]["id"]
    assert res["result"]["space_id"] == env["space"] and res["can_undo"]
    up = await run_low(env, "notes_update", {"page_id": pid, "content": "v2"})
    page = await env["db"].get(WikiPage, pid)
    await env["db"].refresh(page)
    assert page.content == "v2" and await _versions(env["db"], pid) == 2
    await writes.undo(env["db"], env["alice"], up["request_id"])
    await env["db"].refresh(page)
    assert page.content == "v1" and await _versions(env["db"], pid) == 3      # 기록은 남는다
    # 고쳐진 페이지는 '만들기 되돌리기'로 지우지 않는다
    with pytest.raises(writes.WriteError):
        await writes.undo(env["db"], env["alice"], res["request_id"])
    res2 = await run_low(env, "notes_create", {"title": "임시", "content": "x"})
    await writes.undo(env["db"], env["alice"], res2["request_id"])
    env["db"].expire_all()
    assert await env["db"].get(WikiPage, res2["result"]["id"]) is None


async def test_wiki_reader_denied_and_delete_high(wiki_env):
    env = wiki_env
    res = await run_low(env, "notes_create", {"title": "규칙", "content": "v1"})
    pid = res["result"]["id"]
    await run_fail(env, "notes_update", {"page_id": pid, "content": "털림"}, user=env["bob"])
    await run_fail(env, "notes_create", {"title": "x", "content": "y", "space": env["space"]}, user=env["bob"])
    rid_b = await pend_high(env, "notes_delete", {"page_id": pid}, user=env["bob"])
    assert (await approve(env, rid_b, user=env["bob"])).status == "failed"
    rid = await pend_high(env, "notes_delete", {"page_id": pid})
    assert await env["db"].get(WikiPage, pid) is not None
    assert (await approve(env, rid)).status == "executed"
    env["db"].expire_all()
    assert await env["db"].get(WikiPage, pid) is None


# ── 게시판 ────────────────────────────────────────────────────
@pytest.fixture()
async def board_env(env):
    # 댓글 소프트 삭제가 쓰는 greatest() 는 SQLite 에 없다 — 테스트 연결에만 붙인다
    raw = await (await env["db"].connection()).get_raw_connection()
    await raw.driver_connection.create_function(
        "greatest", -1, lambda *a: max((x for x in a if x is not None), default=None))
    b = Board(name="자유", slug="free")
    nb = Board(name="공지", slug="notice", write_permission="admin")
    env["db"].add_all([b, nb])
    await env["db"].commit()
    env["board"], env["notice"] = b.id, nb.id
    return env


async def test_board_post_comment_undo(board_env):
    env = board_env
    res = await run_low(env, "board_create_post", {"board_id": env["board"], "title": "안녕", "content": "본문"})
    pid = res["result"]["id"]
    c = await run_low(env, "board_add_comment", {"post_id": pid, "content": "댓글"}, user=env["bob"])
    cid = c["result"]["id"]
    await writes.undo(env["db"], env["bob"], c["request_id"])
    assert (await env["db"].get(PostComment, cid)).is_deleted
    await writes.undo(env["db"], env["alice"], res["request_id"])
    assert (await env["db"].get(Post, pid)).is_deleted


async def test_board_permissions_and_delete_high(board_env):
    env = board_env
    await run_fail(env, "board_create_post", {"board_id": env["notice"], "title": "x", "content": "y"})
    res = await run_low(env, "board_create_post", {"board_id": env["board"], "title": "안녕", "content": "본문"})
    pid = res["result"]["id"]
    rid_b = await pend_high(env, "board_delete_post", {"post_id": pid}, user=env["bob"])
    assert (await approve(env, rid_b, user=env["bob"])).status == "failed"
    assert not (await env["db"].get(Post, pid)).is_deleted
    rid = await pend_high(env, "board_delete_post", {"post_id": pid})
    assert not (await env["db"].get(Post, pid)).is_deleted
    assert (await approve(env, rid)).status == "executed"
    assert (await env["db"].get(Post, pid)).is_deleted


# ── 채팅 ──────────────────────────────────────────────────────
@pytest.fixture()
async def chat_env(env, monkeypatch):
    from app.chat import router as chat_router

    async def _no_broadcast(*a, **k):
        return None
    monkeypatch.setattr(chat_router, "_broadcast_message", _no_broadcast)
    # 삭제·수정은 채널에 실시간 이벤트를 보낸다(message_delete·message_update) — 테스트에는 Redis 가 없다
    monkeypatch.setattr(chat_router, "emit_to_channel", _no_broadcast)
    env["db"].add(Channel(id="dev", name="개발", type="private", created_by="alice"))
    await env["db"].commit()
    env["db"].add(ChannelMember(channel_id="dev", user_id="alice", role="owner"))
    await env["db"].commit()
    return env


async def test_chat_send_then_undo(chat_env):
    env = chat_env
    res = await run_low(env, "chat_send_message", {"channel_id": "dev", "content": "배포 끝"})
    mid = res["result"]["id"]
    m = await env["db"].get(Message, mid)
    assert m.sender_id == "alice" and m.content == "배포 끝"
    await writes.undo(env["db"], env["alice"], res["request_id"])
    await env["db"].refresh(m)
    assert m.is_deleted


async def test_chat_non_member_denied(chat_env):
    env = chat_env
    await run_fail(env, "chat_send_message", {"channel_id": "dev", "content": "침입"}, user=env["bob"])
    n = (await env["db"].execute(select(func.count()).select_from(Message))).scalar()
    assert n == 0
