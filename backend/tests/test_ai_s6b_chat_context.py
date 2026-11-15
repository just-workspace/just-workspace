"""AI 대화 기본기 2: 답변 버전·임시 대화·프로젝트·메모리·첨부·대화 검색."""

import io
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from starlette.datastructures import Headers, UploadFile

from app.ai import attachments as ai_att
from app.ai import config as ai_config
from app.ai import memory as ai_memory
from app.ai import projects as ai_projects
from app.ai import router as ai_router
from app.ai.models import AIAttachment, AIConversation, AIMemory, AIMessage
from app.ai.providers import ProviderConfig, _with_images, supports_vision
from app.db.models import FileShare, User
from app.files import service as fs
from app.groups.models import Group, GroupMember
from app.mcp import docread
from app.mcp.server import WORKSPACE_TOOLS
from tests.test_ai_s6a_chat_basics import _events
from tests.test_settings_security_p8 import db  # noqa: F401 (픽스처 재사용)

CFG = SimpleNamespace(model="test-model", kind="ollama", base="", extra={})
VISION_CFG = ProviderConfig(kind="ollama", model="llava:13b")


@pytest.fixture()
async def env(db, monkeypatch, tmp_path):
    @asynccontextmanager
    async def _session():
        yield db
    monkeypatch.setattr(ai_router, "async_session", _session)

    async def resolve(db_, user):
        return CFG, False
    monkeypatch.setattr(ai_config, "resolve_provider_for_user", resolve)
    monkeypatch.setattr(ai_att, "ATTACH_DIR", str(tmp_path / "att"))
    monkeypatch.setattr(fs, "STORAGE_ROOT", tmp_path / "storage")
    seen: list = []

    async def fake_stream(cfg, msgs, system=None, tools=None):
        seen.append({"msgs": msgs, "system": system, "tools": tools})
        last = msgs[-1]["content"] if msgs else ""
        yield {"type": "text", "text": f"답:{last[:20]}"}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)
    alice = await db.get(User, "alice")
    bob = await db.get(User, "bob")
    return SimpleNamespace(db=db, alice=alice, bob=bob, seen=seen, tmp=tmp_path, mp=monkeypatch)


async def _drain(resp) -> list[tuple[str, dict]]:
    chunks = []
    async for c in resp.body_iterator:
        chunks.append(c if isinstance(c, str) else c.decode())
    return _events(chunks)


async def _conv(env, user, **kw) -> str:
    body = ai_router.ConversationCreate(tools_enabled=kw.pop("tools_enabled", False), **kw)
    out = await ai_router.create_conversation.__wrapped__(body, user=user, db=env.db)
    return out["id"]


async def _chat(env, conv_id, text, user=None, **kw):
    resp = await ai_router.chat_send.__wrapped__(conv_id, ai_router.ChatRequest(content=text, **kw),
                                                 user=user or env.alice, db=env.db)
    return await _drain(resp)


async def _msgs(env, conv_id, user=None):
    out = await ai_router.get_messages.__wrapped__(conv_id, user=user or env.alice, db=env.db)
    return out["messages"]


def _contents(msgs):
    return [m["content"] for m in msgs]


# ── 1. 질문 수정 → 답변 버전 ──────────────────────────────────
async def test_edit_creates_version_and_switching_keeps_both_branches(env):
    cid = await _conv(env, env.alice)
    await _chat(env, cid, "Q1")
    await _chat(env, cid, "Q2")
    msgs = await _msgs(env, cid)
    assert _contents(msgs) == ["Q1", "답:Q1", "Q2", "답:Q2"]
    q1 = msgs[0]
    assert q1["versions"] == [{"id": q1["id"], "created_at": q1["created_at"]}] and q1["active_version"] == 1

    # Q1 을 고친다 → 새 버전, 뒤 대화(Q2·답)는 숨겨지지만 남는다
    resp = await ai_router.edit_message.__wrapped__(q1["id"], ai_router.EditRequest(content="Q1b"),
                                                    user=env.alice, db=env.db)
    evs = await _drain(resp)
    assert [e for e, _ in evs][0] == "meta" and dict(evs)["done"]["status"] == "complete"
    assert env.seen[-1]["msgs"] == [{"role": "user", "content": "Q1b"}]  # 옛 가지는 모델 맥락에 안 들어감
    msgs = await _msgs(env, cid)
    assert _contents(msgs) == ["Q1b", "답:Q1b"]
    assert msgs[0]["active_version"] == 2 and len(msgs[0]["versions"]) == 2
    rows = (await env.db.execute(select(AIMessage).where(AIMessage.conversation_id == cid))).scalars().all()
    assert len(rows) == 6  # 아무것도 지우지 않았다

    v = await ai_router.message_versions.__wrapped__(msgs[0]["id"], user=env.alice, db=env.db)
    assert v["active_version"] == 2 and [x["id"] for x in v["versions"]][0] == q1["id"]

    # 1번 버전으로 → 옛 가지가 통째로 돌아온다
    out = await ai_router.switch_version.__wrapped__(msgs[0]["id"], 1, user=env.alice, db=env.db)
    assert _contents(out["messages"]) == ["Q1", "답:Q1", "Q2", "답:Q2"]
    assert out["messages"][0]["active_version"] == 1
    # 다시 2번 → 새 가지
    out = await ai_router.switch_version.__wrapped__(q1["id"], 2, user=env.alice, db=env.db)
    assert _contents(out["messages"]) == ["Q1b", "답:Q1b"]

    # 새 가지에서 이어 묻기 — 모델 맥락은 지금 가지만
    await _chat(env, cid, "Q3")
    assert [m["content"] for m in env.seen[-1]["msgs"]] == ["Q1b", "답:Q1b", "Q3"]
    out = await ai_router.switch_version.__wrapped__(q1["id"], 1, user=env.alice, db=env.db)
    assert _contents(out["messages"]) == ["Q1", "답:Q1", "Q2", "답:Q2"]
    out = await ai_router.switch_version.__wrapped__(q1["id"], 2, user=env.alice, db=env.db)
    assert _contents(out["messages"]) == ["Q1b", "답:Q1b", "Q3", "답:Q3"]

    # 다시 만들기는 지금 가지의 마지막 답만 바꾼다
    resp = await ai_router.chat_regenerate.__wrapped__(cid, user=env.alice, db=env.db)
    await _drain(resp)
    assert [m["content"] for m in env.seen[-1]["msgs"]] == ["Q1b", "답:Q1b", "Q3"]
    out = await ai_router.switch_version.__wrapped__(q1["id"], 1, user=env.alice, db=env.db)
    assert _contents(out["messages"]) == ["Q1", "답:Q1", "Q2", "답:Q2"]

    # 남의 메시지는 고치거나 바꿀 수 없다·없는 버전 404
    with pytest.raises(HTTPException) as ei:
        await ai_router.edit_message.__wrapped__(q1["id"], ai_router.EditRequest(content="x"), user=env.bob, db=env.db)
    assert ei.value.status_code == 404
    with pytest.raises(HTTPException) as ei:
        await ai_router.switch_version.__wrapped__(q1["id"], 9, user=env.alice, db=env.db)
    assert ei.value.status_code == 404


async def test_legacy_rows_backfilled_as_one_branch(env):
    cid = await _conv(env, env.alice)
    t0 = datetime.now(timezone.utc) - timedelta(minutes=5)
    for i, (role, c) in enumerate([("user", "옛 질문"), ("assistant", "옛 답")]):
        env.db.add(AIMessage(conversation_id=cid, user_id="alice", role=role, content=c,
                             created_at=t0 + timedelta(seconds=i)))
    await env.db.commit()
    msgs = await _msgs(env, cid)
    assert _contents(msgs) == ["옛 질문", "옛 답"] and msgs[0]["active_version"] == 1
    await _chat(env, cid, "새 질문")
    assert [m["content"] for m in env.seen[-1]["msgs"]] == ["옛 질문", "옛 답", "새 질문"]
    rows = (await env.db.execute(select(AIMessage).where(AIMessage.conversation_id == cid))).scalars().all()
    assert all(r.parent_id for r in rows)


# ── 2. 임시 대화 ─────────────────────────────────────────────
async def test_temporary_chat_hidden_from_history_and_memory(env):
    env.db.add(AIMemory(user_id="alice", kind="preference", text="보고서는 개조식 선호"))
    await env.db.commit()

    async def tools(db, user, prefs):
        return [{"type": "function", "function": {"name": "files_read"}}]
    env.mp.setattr(ai_router, "_model_tools", tools)

    normal = await _conv(env, env.alice, tools_enabled=True)
    temp = await _conv(env, env.alice, tools_enabled=True, temporary=True)
    lst = await ai_router.list_conversations.__wrapped__(user=env.alice, db=env.db)
    assert [c["id"] for c in lst["conversations"]] == [normal]
    assert [c["id"] for c in lst["temporary"]] == [temp] and lst["temporary"][0]["temporary"] is True

    # 일반 대화: 메모리가 맥락에 들어가고 저장 도구가 보인다
    await _chat(env, normal, "안녕")
    assert "개조식" in env.seen[-1]["system"]
    assert ai_memory.TOOL_NAME in [t["function"]["name"] for t in env.seen[-1]["tools"]]
    # 임시 대화: 메모리를 읽지도(맥락 없음) 쓰지도(도구 없음) 않는다
    await _chat(env, temp, "급여 규정 비밀 질문")
    assert "개조식" not in (env.seen[-1]["system"] or "")
    assert ai_memory.TOOL_NAME not in [t["function"]["name"] for t in env.seen[-1]["tools"]]

    # 모델이 억지로 memory_save 를 불러도 저장 안 됨
    async def sneaky(cfg, msgs, system=None, tools=None):
        if len(msgs) == 1 or msgs[-1]["role"] == "user" and "방금 도구" not in msgs[-1]["content"]:
            yield {"type": "tool_call", "name": "memory_save", "args": json.dumps({"kind": "work", "text": "급여일 25일"})}
        else:
            yield {"type": "text", "text": "ok"}
    env.mp.setattr(ai_router, "chat_stream", sneaky)
    evs = await _chat(env, temp, "기억해 줘")
    assert "memory_saved" not in [e for e, _ in evs]
    assert (await env.db.execute(select(AIMemory).where(AIMemory.text == "급여일 25일"))).first() is None

    # 검색되지 않는다
    res = await ai_router.search_conversations.__wrapped__(q="급여", user=env.alice, db=env.db)
    assert res["results"] == []
    # 임시 대화는 프로젝트에 못 넣는다
    with pytest.raises(HTTPException):
        await _conv(env, env.alice, temporary=True, project_id="p")

    # 24시간 지난 임시 대화는 목록을 열 때 정리된다(다른 사용자 것도)
    c = await env.db.get(AIConversation, temp)
    c.updated_at = datetime.now(timezone.utc) - timedelta(hours=25)
    await env.db.commit()
    await ai_router.list_conversations.__wrapped__(user=env.bob, db=env.db)
    assert await env.db.get(AIConversation, temp) is None
    assert (await env.db.execute(select(AIMessage).where(AIMessage.conversation_id == temp))).first() is None
    # 창을 닫으면 지운다(화면이 DELETE 를 보낸다)
    t2 = await _conv(env, env.alice, temporary=True)
    await ai_router.delete_conversation.__wrapped__(t2, user=env.alice, db=env.db)
    assert await env.db.get(AIConversation, t2) is None


# ── 3. 프로젝트 ──────────────────────────────────────────────
async def _project_setup(env):
    root = env.tmp / "storage" / "users" / "alice"
    root.mkdir(parents=True)
    (root / "장비목록.txt").write_text(
        "랩실 장비 목록\n\n방화벽 FW-01 은 3층 랙 A에 있다\n\n" + "무관한 문단입니다\n\n" * 3, encoding="utf-8")
    g = Group(name="인프라팀")
    env.db.add(g)
    await env.db.flush()
    env.db.add(GroupMember(group_id=g.id, user_id="bob"))
    env.db.add(GroupMember(group_id=g.id, user_id="alice"))
    await env.db.commit()
    p = await ai_router.create_project.__wrapped__(
        ai_router.ProjectBody(name="인프라 운영", instructions="답은 개조식으로"), user=env.alice, db=env.db)
    p = await ai_router.add_project_files.__wrapped__(p["id"], ai_router.ProjectFilesBody(paths=["my/장비목록.txt"]),
                                                      user=env.alice, db=env.db)
    assert [f["name"] for f in p["files"]] == ["장비목록.txt"] and p["files"][0]["path"] == "my/장비목록.txt"
    return p, g


async def test_project_context_injection_and_member_read_only(env):
    p, g = await _project_setup(env)
    # 주인 대화: 지침 + 관련 지식
    cid = await _conv(env, env.alice, project_id=p["id"])
    await _chat(env, cid, "방화벽 위치 알려줘")
    sys_ = env.seen[-1]["system"]
    assert "답은 개조식으로" in sys_ and "FW-01" in sys_ and "장비목록.txt" in sys_

    # 공유 전: bob 은 못 본다
    with pytest.raises(HTTPException) as ei:
        await ai_router.get_project.__wrapped__(p["id"], user=env.bob, db=env.db)
    assert ei.value.status_code == 404
    # 그룹 공유 → 읽기 전용 구성원
    out = await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(share_group_id=g.id),
                                                    user=env.alice, db=env.db)
    assert out["shared"] is True and out["share_group_name"] == "인프라팀"
    got = await ai_router.get_project.__wrapped__(p["id"], user=env.bob, db=env.db)
    assert got["role"] == "member" and got["editable"] is False and got["share_group_id"] is None
    lst = await ai_router.list_projects.__wrapped__(user=env.bob, db=env.db)
    assert [x["id"] for x in lst["projects"]] == [p["id"]]
    for call in (
        ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(instructions="해킹"), user=env.bob, db=env.db),
        ai_router.add_project_files.__wrapped__(p["id"], ai_router.ProjectFilesBody(paths=["my/x"]), user=env.bob, db=env.db),
        ai_router.delete_project.__wrapped__(p["id"], user=env.bob, db=env.db),
    ):
        with pytest.raises(HTTPException) as ei:
            await call
        assert ei.value.status_code == 403

    # 구성원 대화: 지침은 들어가지만 alice 의 개인 파일은 bob 권한으로 못 읽어 건너뛴다
    bcid = await _conv(env, env.bob, project_id=p["id"])
    await _chat(env, bcid, "방화벽 위치 알려줘", user=env.bob)
    sys_ = env.seen[-1]["system"]
    assert "답은 개조식으로" in sys_ and "FW-01" not in sys_
    # alice 가 그 파일을 bob 에게 공유하면 bob 권한으로 읽힌다
    env.db.add(FileShare(owner_id="alice", file_path="my/장비목록.txt", shared_with_user_id="bob", role="view"))
    await env.db.commit()
    await _chat(env, bcid, "방화벽 위치 알려줘", user=env.bob)
    assert "FW-01" in env.seen[-1]["system"]
    # 대화 수는 각자 자기 대화만
    assert (await ai_router.get_project.__wrapped__(p["id"], user=env.bob, db=env.db))["conversation_count"] == 1

    # 공유 해제 → bob 은 프로젝트를 못 보고 맥락도 안 들어간다
    await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(share_group_id=""), user=env.alice, db=env.db)
    await _chat(env, bcid, "방화벽?", user=env.bob)
    assert "개조식" not in (env.seen[-1]["system"] or "")
    # 남의 그룹에는 공유 못 한다
    g2 = Group(name="다른팀")
    env.db.add(g2)
    await env.db.commit()
    with pytest.raises(HTTPException) as ei:
        await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(share_group_id=g2.id),
                                                  user=env.alice, db=env.db)
    assert ei.value.status_code == 400
    # 지우면 대화는 남고 묶음만 풀린다
    await ai_router.delete_project.__wrapped__(p["id"], user=env.alice, db=env.db)
    assert (await env.db.get(AIConversation, cid)).project_id is None


def test_knowledge_chunk_selection_prefers_overlap_and_budget():
    docs = [("a.txt", "서론입니다\n\n" + "VPN 게이트웨이 IKE 재협상 주기는 8시간\n\n" + "기타 " * 50),
            ("b.txt", "점심 메뉴\n\n회의실 예약")]
    picked = ai_projects.select_chunks(docs, "IKE 재협상 주기가 어떻게 돼?", budget=10_000)
    assert picked and all(name == "a.txt" for name, _ in picked)
    assert any("8시간" in c for _, c in picked)
    # 겹치는 게 없으면 앞부분부터
    assert ai_projects.select_chunks(docs, "zzz", budget=10_000)
    big = [("c.txt", ("가나다라 " * 300 + "\n\n") * 30)]
    assert sum(len(c) for _, c in ai_projects.select_chunks(big, "가나다", budget=3000)) <= 3000
    assert "재협" in ai_projects.terms("재협상을")  # 조사가 붙어도 두 글자 조각으로 겹친다


# ── 4. 메모리 ───────────────────────────────────────────────
def test_secret_filter():
    bad = ["내 비번: hunter22!", "password=Abc123!x", "API 키는 sk-abcdefghijklmnopqrstuvwx",
           "주민번호 900101-1234567", "카드 4111-1111-1111-1111", "토큰 ghp_abcdefghijklmnopqrstuvwxyz123456",
           "AKIAABCDEFGHIJKLMNOP 로 접속", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
           "키값 Zx8Kq2Lm9Pw4Rt7Yv1Bn6Cd3Fg5Hj0Ks"]
    for t in bad:
        assert ai_memory.secret_reason(t), t
    ok = ["보고서는 개조식으로, 수치는 단위와 함께", "비밀번호는 90일마다 바꾼다", "이서연 님 — 지사 네트워크 담당",
          "단축키는 Ctrl+K 를 선호", "정기점검은 매월 첫째 주 금요일 오전", "주로 쓰는 장비는 FW-01·L3-SW-02",
          "토큰은 JWT로 발급한다", "회의는 2026-11-05 10:00"]
    for t in ok:
        assert ai_memory.secret_reason(t) is None, t
    with pytest.raises(ai_memory.MemoryError) as ei:
        ai_memory.validate("work", "비번: hunter22!")
    assert ei.value.code == "secret"
    with pytest.raises(ai_memory.MemoryError):
        ai_memory.validate("secret-kind", "x")


async def test_memory_saved_notice_cancel_and_secret_refusal(env):
    # 메모리 저장은 "이 대화에서 남이 쓴 내용을 읽었는가"를 먼저 본다(Redis 를 못 읽으면 거절 — fail-closed).
    # 테스트 환경엔 Redis 가 없으니 "읽은 적 없음"으로 고정한다(거절 경로는 test_aiwrite_context_marks.py).
    async def _not_read(user_id, conv_id):
        return None
    from app.mcp import writes as _writes
    env.mp.setattr(_writes, "conv_untrusted", _not_read)

    async def tools(db, user, prefs):
        return [{"type": "function", "function": {"name": "files_read"}}]
    env.mp.setattr(ai_router, "_model_tools", tools)
    calls = {"n": 0}

    async def stream(cfg, msgs, system=None, tools=None):
        calls["n"] += 1
        if calls["n"] == 1:
            yield {"type": "tool_call", "name": "memory_save",
                   "args": json.dumps({"kind": "preference", "text": "보고서는 개조식 선호"})}
            yield {"type": "tool_call", "name": "memory_save",
                   "args": json.dumps({"kind": "work", "text": "VPN 관리자 비번: Qwer1234!"})}
        else:
            stream.last_tool_turn = msgs[-1]["content"]
            yield {"type": "text", "text": "기억해 둘게요"}
    env.mp.setattr(ai_router, "chat_stream", stream)
    cid = await _conv(env, env.alice, tools_enabled=True)
    evs = await _chat(env, cid, "앞으로 보고서는 개조식으로. 그리고 VPN 비번 기억해")
    saved = [d for e, d in evs if e == "memory_saved"]
    assert len(saved) == 1 and saved[0]["kind"] == "preference" and saved[0]["text"] == "보고서는 개조식 선호"
    assert "비밀 정보" in stream.last_tool_turn  # 모델에게 거부 이유가 간다
    rows = (await env.db.execute(select(AIMemory).where(AIMemory.user_id == "alice"))).scalars().all()
    assert [r.text for r in rows] == ["보고서는 개조식 선호"] and rows[0].source_conversation_id == cid
    # memory_save 는 MCP 레지스트리에 없다(외부 커넥터에 안 보임)
    assert ai_memory.TOOL_NAME not in WORKSPACE_TOOLS

    lst = await ai_router.list_memory.__wrapped__(kind="", q="", user=env.alice, db=env.db)
    assert lst["enabled"] is True and lst["items"][0]["source_title"]
    # [취소] = 그 항목 삭제
    await ai_router.delete_memory.__wrapped__(saved[0]["id"], user=env.alice, db=env.db)
    assert (await env.db.execute(select(AIMemory))).first() is None
    with pytest.raises(HTTPException) as ei:
        await ai_router.delete_memory.__wrapped__(saved[0]["id"], user=env.alice, db=env.db)
    assert ei.value.status_code == 404

    # 직접 추가·수정 — 비밀은 422, 남의 것은 404
    m = await ai_router.add_memory.__wrapped__(ai_router.MemoryBody(kind="person", text="이서연 님 — 지사 담당"),
                                               user=env.alice, db=env.db)
    with pytest.raises(HTTPException) as ei:
        await ai_router.add_memory.__wrapped__(ai_router.MemoryBody(kind="work", text="토큰 ghp_abcdefghijklmnopqrstuvwxyz123456"),
                                               user=env.alice, db=env.db)
    assert ei.value.status_code == 422 and ei.value.detail["code"] == "secret"
    with pytest.raises(HTTPException) as ei:
        await ai_router.patch_memory.__wrapped__(m["id"], ai_router.MemoryPatch(text="password=Abc123!x"),
                                                 user=env.alice, db=env.db)
    assert ei.value.status_code == 422
    with pytest.raises(HTTPException) as ei:
        await ai_router.patch_memory.__wrapped__(m["id"], ai_router.MemoryPatch(text="x"), user=env.bob, db=env.db)
    assert ei.value.status_code == 404
    out = await ai_router.patch_memory.__wrapped__(m["id"], ai_router.MemoryPatch(kind="work"), user=env.alice, db=env.db)
    assert out["kind"] == "work"
    assert (await ai_router.list_memory.__wrapped__(kind="person", q="", user=env.alice, db=env.db))["items"] == []

    # 스위치 끄면 읽지도 쓰지도 않는다(지우지는 않음)
    await ai_router.put_memory_settings.__wrapped__(ai_router.MemorySettingsBody(enabled=False), user=env.alice, db=env.db)
    seen = []

    async def plain(cfg, msgs, system=None, tools=None):
        seen.append((system, tools))
        yield {"type": "text", "text": "x"}
    env.mp.setattr(ai_router, "chat_stream", plain)
    await _chat(env, cid, "안녕")
    system, tools_ = seen[-1]
    assert "지사 담당" not in (system or "") and ai_memory.TOOL_NAME not in [t["function"]["name"] for t in tools_]
    assert (await ai_router.list_memory.__wrapped__(kind="", q="", user=env.alice, db=env.db))["total"] == 1
    await ai_router.clear_memory.__wrapped__(user=env.alice, db=env.db)
    assert (await ai_router.list_memory.__wrapped__(kind="", q="", user=env.alice, db=env.db))["total"] == 0


# ── 5. 첨부 ─────────────────────────────────────────────────
def _upload(name: str, data: bytes, ctype: str = "application/octet-stream") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=name, headers=Headers({"content-type": ctype}))


async def _up(env, name, data, ctype="application/octet-stream", user=None):
    return await ai_router.upload_attachment.__wrapped__(file=_upload(name, data, ctype), conversation_id=None,
                                                         user=user or env.alice, db=env.db)


def test_docread_typed_codes():
    with pytest.raises(docread.DocReadError) as ei:
        docread.read_document(bytes.fromhex("d0cf11e0a1b11ae1") + b"\0" * 600, ".docx")
    assert ei.value.code == "encrypted"
    with pytest.raises(docread.DocReadError) as ei:
        docread.read_document(b"not a hwp", ".hwp")
    assert ei.value.code == "unsupported_version"
    with pytest.raises(docread.DocReadError) as ei:
        docread.read_document(b"garbage", ".pdf")
    assert ei.value.code == "corrupt"
    with pytest.raises(docread.DocReadError) as ei:
        docread.read_document(b"x", ".odt")
    assert ei.value.code == "unsupported"
    assert docread.DocReadError("x").code == "corrupt"


async def test_attachment_stages_and_failure_codes(env):
    ok = await _up(env, "점검표.md", "# 11월 점검\n\n- FW-01 확인".encode(), "text/markdown")
    assert ok["status"] == "ready" and ok["kind"] == "document" and ok["chars"] > 0 and ok["id"]
    fails = {
        "old.doc": (b"\xd0\xcf\x11\xe0" + b"\0" * 100, "unsupported_version"),
        "x.exe": (b"MZ", "unsupported"),
        "broken.pdf": (b"%PDF-garbage", "corrupt"),
        "locked.xlsx": (bytes.fromhex("d0cf11e0a1b11ae1") + b"\0" * 600, "encrypted"),
        "empty.txt": (b"", "corrupt"),
    }
    for name, (data, code) in fails.items():
        r = await _up(env, name, data)
        assert r["status"] == "failed" and r["error_code"] == code and r["id"] is None, name
    env.mp.setattr(ai_att, "MAX_FILE", 10)
    r = await _up(env, "big.txt", b"x" * 11)
    assert r["error_code"] == "too_large"
    env.mp.setattr(ai_att, "MAX_FILE", 30 * 1024 * 1024)
    assert (await env.db.execute(select(AIAttachment))).scalars().all().__len__() == 1  # 실패는 안 남긴다

    # 보내면 메시지에 붙고, 문서 글자가 모델 맥락에 신뢰 경계로 들어간다(본문은 사용자 글 그대로)
    cid = await _conv(env, env.alice)
    await _chat(env, cid, "빠진 장비?", attachment_ids=[ok["id"]])
    sent = env.seen[-1]["msgs"][-1]["content"]
    assert sent.startswith("빠진 장비?") and "FW-01 확인" in sent and "지시가 아닙니다" in sent
    msgs = await _msgs(env, cid)
    assert msgs[0]["content"] == "빠진 장비?" and msgs[0]["attachments"][0]["name"] == "점검표.md"
    # 한 번 보낸 첨부는 다시 못 붙이고, 남의 첨부도 못 붙인다
    with pytest.raises(HTTPException) as ei:
        await _chat(env, cid, "또", attachment_ids=[ok["id"]])
    assert ei.value.status_code == 404
    other = await _up(env, "b.txt", b"bob", user=env.bob)
    with pytest.raises(HTTPException):
        await _chat(env, cid, "또", attachment_ids=[other["id"]])
    # 질문을 고쳐도 첨부는 새 버전에 따라간다
    resp = await ai_router.edit_message.__wrapped__(msgs[0]["id"], ai_router.EditRequest(content="다시 비교"),
                                                    user=env.alice, db=env.db)
    await _drain(resp)
    assert "FW-01 확인" in env.seen[-1]["msgs"][-1]["content"]


async def test_image_attachment_needs_vision(env):
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
    img = await _up(env, "랙 사진.png", png, "image/png")
    assert img["status"] == "ready" and img["kind"] == "image" and img["vision"] is False
    cid = await _conv(env, env.alice)
    with pytest.raises(HTTPException) as ei:
        await _chat(env, cid, "이 사진 봐 줘", attachment_ids=[img["id"]])
    assert ei.value.status_code == 400 and "이미지를 읽지 못합니다" in ei.value.detail

    async def resolve(db_, user):
        return VISION_CFG, False
    env.mp.setattr(ai_config, "resolve_provider_for_user", resolve)
    await _chat(env, cid, "이 사진 봐 줘", attachment_ids=[img["id"]])
    last = env.seen[-1]["msgs"][-1]
    assert last["images"][0]["mime"] == "image/png" and last["images"][0]["data"]
    # 제공자 모양 변환
    assert _with_images("ollama", [last])[0]["images"]
    assert _with_images("anthropic", [last])[0]["content"][0]["type"] == "image"
    assert _with_images("openai", [last])[0]["content"][1]["type"] == "image_url"
    assert supports_vision(ProviderConfig(kind="anthropic", model="claude-sonnet-4-5"))
    assert not supports_vision(ProviderConfig(kind="compatible", model="qwen3-27b"))
    assert supports_vision(ProviderConfig(kind="compatible", model="qwen3-27b", extra={"vision": True}))
    # 보내지 않은 첨부는 24시간 뒤 정리
    stale = await _up(env, "old.txt", b"old")
    row = await env.db.get(AIAttachment, stale["id"])
    row.created_at = datetime.now(timezone.utc) - timedelta(hours=25)
    await env.db.commit()
    assert await ai_att.sweep(env.db) == 1
    assert await env.db.get(AIAttachment, stale["id"]) is None


# ── 6. 대화 검색 ─────────────────────────────────────────────
async def test_conversation_search_title_and_content_own_only(env):
    a = await _conv(env, env.alice, title="VPN 장애 보고서 초안")
    await _chat(env, a, "본사 게이트웨이의 IKE 재협상 주기")
    b = await _conv(env, env.bob, title="bob IKE")
    await _chat(env, b, "IKE", user=env.bob)
    res = await ai_router.search_conversations.__wrapped__(q="ike", user=env.alice, db=env.db)
    assert [r["id"] for r in res["results"]] == [a]
    r = res["results"][0]
    assert r["match"] == "message" and "IKE" in r["snippet"] and r["message_id"]
    res = await ai_router.search_conversations.__wrapped__(q="보고서", user=env.alice, db=env.db)
    assert res["results"][0]["match"] == "title"
    assert (await ai_router.search_conversations.__wrapped__(q="%", user=env.alice, db=env.db))["results"] == []
    assert (await ai_router.search_conversations.__wrapped__(q="", user=env.alice, db=env.db))["results"] == []
