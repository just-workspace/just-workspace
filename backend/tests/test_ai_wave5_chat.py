"""Wave5 chat — 내장 AI 화면 보강 백엔드(시안 J1·J2·K1·H1·H2).

J: 여러 그룹 공유 · 공유 전 점검(못 읽는 파일 경고) · 공유 끊기면 구성원 대화를 '최근 대화'로 · 피커 20개 · 지침 4,000자.
K: 첨부 원본 내려받기(주인만·보관 만료 410) · 질문 수정 때 첨부 골라 유지 · 모델 선택지별 vision.
H: 토큰 만료 필수·끝 4자 · 연결된 앱 목록 · 연결 끊으면 대기 쓰기 요청 '연결 해제됨' 거부.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.ai import attachments as ai_att
from app.ai import config as ai_config
from app.ai import extras_router as ai_extras
from app.ai import router as ai_router
from app.ai.models import AIConversation
from app.ai.providers import ProviderConfig
from app.db.models import FileShare, McpPersonalToken, McpWriteRequest, OAuthRefreshToken
from app.groups.models import Group, GroupMember
from app.mcp import account_router as acct
from app.mcp import writes
from app.mcp.http_server import READ_ENDPOINT, WRITE_ENDPOINT
from tests.test_ai_s6b_chat_context import _chat, _conv, _drain, _msgs, _up, env  # noqa: F401 (픽스처 재사용)
from tests.test_settings_security_p8 import db  # noqa: F401


async def _setup_two_groups(env):
    root = env.tmp / "storage" / "users" / "alice"
    root.mkdir(parents=True, exist_ok=True)
    (root / "장비목록.txt").write_text("방화벽 FW-01 은 3층 랙 A", encoding="utf-8")
    (root / "정책.txt").write_text("정책 기준", encoding="utf-8")
    g1, g2 = Group(name="인프라팀"), Group(name="랩실")
    env.db.add_all([g1, g2])
    await env.db.flush()
    env.db.add_all([GroupMember(group_id=g1.id, user_id="alice"), GroupMember(group_id=g1.id, user_id="bob"),
                    GroupMember(group_id=g2.id, user_id="alice")])
    await env.db.commit()
    p = await ai_router.create_project.__wrapped__(ai_router.ProjectBody(name="인프라 운영", instructions="개조식"),
                                                   user=env.alice, db=env.db)
    p = await ai_router.add_project_files.__wrapped__(
        p["id"], ai_router.ProjectFilesBody(paths=["my/장비목록.txt", "my/정책.txt"]), user=env.alice, db=env.db)
    return p, g1, g2


async def test_multi_group_share_check_and_detach(env):
    p, g1, g2 = await _setup_two_groups(env)
    # 대상 그룹 + 구성원 수
    targets = await ai_router.project_share_targets.__wrapped__(user=env.alice, db=env.db)
    by_name = {g["name"]: g for g in targets["groups"]}
    assert by_name["인프라팀"]["members"] == 2 and by_name["랩실"]["members"] == 1

    # 공유 전 점검 — bob 은 alice 개인 파일 둘 다 못 읽는다(경고만)
    chk = await ai_extras.project_share_check.__wrapped__(p["id"], group_ids=f"{g1.id},{g2.id}", user=env.alice, db=env.db)
    assert chk["members"] == 1 and chk["blocked_members"] == 1
    assert sorted(f["name"] for f in chk["files"]) == ["장비목록.txt", "정책.txt"]
    env.db.add(FileShare(owner_id="alice", file_path="my/장비목록.txt", shared_with_user_id="bob", role="view"))
    await env.db.commit()
    chk = await ai_extras.project_share_check.__wrapped__(p["id"], group_ids=g1.id, user=env.alice, db=env.db)
    assert [f["name"] for f in chk["files"]] == ["정책.txt"] and chk["files"][0]["blocked"] == 1
    with pytest.raises(HTTPException) as ei:  # 주인만
        await ai_extras.project_share_check.__wrapped__(p["id"], group_ids=g1.id, user=env.bob, db=env.db)
    assert ei.value.status_code == 404

    # 여러 그룹에 공유 — 주인은 전부, 구성원은 자기 그룹만 + 공유한 사람 이름 + 못 읽는 파일 표시
    out = await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(share_group_ids=[g1.id, g2.id]),
                                                    user=env.alice, db=env.db)
    assert out["shared"] and out["share_group_ids"] == [g1.id, g2.id] and out["owner_name"] == "alice"
    got = await ai_router.get_project.__wrapped__(p["id"], user=env.bob, db=env.db)
    assert got["role"] == "member" and [g["name"] for g in got["share_groups"]] == ["인프라팀"]
    assert got["share_group_ids"] == [] and got["unreadable_files"] == 1
    assert {f["name"]: f["readable"] for f in got["files"]} == {"장비목록.txt": True, "정책.txt": False}

    # bob 의 프로젝트 대화 → 공유를 끊으면 bob 대화는 '최근 대화'로(묶음 풀림), alice 대화는 그대로
    bcid = await _conv(env, env.bob, project_id=p["id"])
    acid = await _conv(env, env.alice, project_id=p["id"])
    await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(share_group_ids=[g2.id]),
                                              user=env.alice, db=env.db)
    assert (await env.db.get(AIConversation, bcid)).project_id is None
    assert (await env.db.get(AIConversation, acid)).project_id == p["id"]
    with pytest.raises(HTTPException) as ei:
        await ai_router.get_project.__wrapped__(p["id"], user=env.bob, db=env.db)
    assert ei.value.status_code == 404

    # 그룹에서 빠져 못 보게 된 경우도 대화 목록을 열 때 풀린다
    await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(share_group_ids=[g1.id]),
                                              user=env.alice, db=env.db)
    c2 = await _conv(env, env.bob, project_id=p["id"])
    gm = (await env.db.execute(select(GroupMember).where(GroupMember.group_id == g1.id,
                                                         GroupMember.user_id == "bob"))).scalar_one()
    await env.db.delete(gm)
    await env.db.commit()
    lst = await ai_router.list_conversations.__wrapped__(user=env.bob, db=env.db)
    assert {c["id"]: c["project_id"] for c in lst["conversations"]}[c2] is None
    # 옛 계약(share_group_id 하나)도 그대로 — "" = 해제
    out = await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(share_group_id=""),
                                                    user=env.alice, db=env.db)
    assert out["shared"] is False and out["share_group_ids"] == []


async def test_picker_limit_and_instructions_limit(env):
    p, _g1, _g2 = await _setup_two_groups(env)
    with pytest.raises(HTTPException) as ei:
        await ai_router.add_project_files.__wrapped__(
            p["id"], ai_router.ProjectFilesBody(paths=[f"my/f{i}.txt" for i in range(21)]), user=env.alice, db=env.db)
    assert ei.value.status_code == 400 and "20" in ei.value.detail
    with pytest.raises(HTTPException) as ei:
        await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(instructions="가" * 4001),
                                                  user=env.alice, db=env.db)
    assert "4,000자" in ei.value.detail
    await ai_router.patch_project.__wrapped__(p["id"], ai_router.ProjectPatch(instructions="가" * 4000),
                                              user=env.alice, db=env.db)


async def test_attachment_original_download_owner_only(env):
    doc = await _up(env, "점검표.md", "# 점검\n\n- FW-01".encode(), "text/markdown")
    png = await _up(env, "랙.png", b"\x89PNG\r\n\x1a\n" + b"\0" * 16, "image/png")
    assert doc["has_file"] is True
    r = await ai_extras.attachment_file.__wrapped__(png["id"], user=env.alice, db=env.db)
    assert r.media_type == "image/png" and r.headers["content-disposition"].startswith("inline")
    r = await ai_extras.attachment_file.__wrapped__(png["id"], download=True, user=env.alice, db=env.db)
    assert r.headers["content-disposition"].startswith("attachment")
    r = await ai_extras.attachment_file.__wrapped__(doc["id"], user=env.alice, db=env.db)
    assert r.media_type == "application/octet-stream" and r.headers["content-disposition"].startswith("attachment")
    with pytest.raises(HTTPException) as ei:  # 남의 첨부
        await ai_extras.attachment_file.__wrapped__(doc["id"], user=env.bob, db=env.db)
    assert ei.value.status_code == 404
    t = await ai_extras.attachment_text.__wrapped__(doc["id"], user=env.alice, db=env.db)
    assert "FW-01" in t["text"]
    ai_att._unlink(doc["id"])  # 보관 만료
    with pytest.raises(HTTPException) as ei:
        await ai_extras.attachment_file.__wrapped__(doc["id"], user=env.alice, db=env.db)
    assert ei.value.status_code == 410
    assert (await ai_extras.attachment_text.__wrapped__(doc["id"], user=env.alice, db=env.db))["has_file"] is False


async def test_edit_keeps_only_chosen_attachments(env):
    a = await _up(env, "a.md", b"AAA-alpha", "text/markdown")
    b = await _up(env, "b.md", b"BBB-beta", "text/markdown")
    cid = await _conv(env, env.alice)
    await _chat(env, cid, "비교해 줘", attachment_ids=[a["id"], b["id"]])
    q = (await _msgs(env, cid))[0]
    keep = [x["id"] for x in q["attachments"] if x["name"] == "b.md"]
    resp = await ai_router.edit_message.__wrapped__(q["id"], ai_router.EditRequest(content="b 만", keep_attachment_ids=keep),
                                                    user=env.alice, db=env.db)
    await _drain(resp)
    sent = env.seen[-1]["msgs"][-1]["content"]
    assert "BBB-beta" in sent and "AAA-alpha" not in sent
    q2 = (await _msgs(env, cid))[0]
    assert [x["name"] for x in q2["attachments"]] == ["b.md"]


async def test_model_choices_vision(env):
    async def resolve_provider(db_, advanced=False):
        return ProviderConfig(kind="anthropic", model="claude-sonnet-4-5") if advanced else ProviderConfig(kind="compatible", model="qwen3-27b")

    async def get_cfg(db_):
        return {"advanced_model": "claude-sonnet-4-5", "governance": {"allow_user_keys": False}}

    async def resolve_for_user(db_, user):
        return ProviderConfig(kind="compatible", model="qwen3-27b"), False
    env.mp.setattr(ai_config, "resolve_provider", resolve_provider)
    env.mp.setattr(ai_config, "get_ai_config", get_cfg)
    env.mp.setattr(ai_config, "resolve_provider_for_user", resolve_for_user)
    out = await ai_extras.model_choices.__wrapped__(user=env.alice, db=env.db)
    rows = {r["key"]: r for r in out["choices"]}
    assert out["current"] == "workspace" and out["vision"] is False
    assert rows["workspace"]["vision"] is False and rows["workspace"]["current"] is True
    assert rows["workspace_advanced"] == {"key": "workspace_advanced", "available": True, "model": "claude-sonnet-4-5",
                                          "vision": True, "current": False}
    assert rows["personal"]["available"] is False


# ── H: AI 연동(MCP) ─────────────────────────────────────────────
@pytest.fixture()
async def mcp_env(db, monkeypatch):
    async def noop(*a, **k):
        return None
    monkeypatch.setattr(writes, "emit_count", noop)
    monkeypatch.setattr(writes, "_notify_pending", noop)
    monkeypatch.setattr(writes, "_report_back", noop)
    from app.db.models import User
    return db, await db.get(User, "alice"), await db.get(User, "bob")


def _pending(uid, client_id, rid):
    now = datetime.now(timezone.utc)
    return McpWriteRequest(id=rid, user_id=uid, tool="mail_send", args="{}", risk="high", status="pending", source="mcp",
                           client_kind="claude_app", client_name="Claude", client_id=client_id,
                           expires_at=now + timedelta(minutes=30))


async def test_token_expiry_hint_and_info(mcp_env):
    db, alice, _bob = mcp_env
    with pytest.raises(HTTPException):
        await acct.create_token(acct.CreateTokenRequest(name="x", expires_days=0), user=alice, db=db)
    r = await acct.create_token(acct.CreateTokenRequest(name="hana-macbook", expires_days=30, scope="mcp:read mcp:write"),
                                user=alice, db=db)
    assert r["token"].startswith("wsmcp_") and r["hint"] == r["token"][-4:] and r["can_write"] is True
    exp = r["expires_at"] if r["expires_at"].tzinfo else r["expires_at"].replace(tzinfo=timezone.utc)
    assert timedelta(days=29) < exp - datetime.now(timezone.utc) <= timedelta(days=30)
    lst = await acct.list_tokens(user=alice, db=db)
    assert lst["tokens"][0]["hint"] == r["hint"] and "token" not in lst["tokens"][0]
    info = await acct.connector_info(user=alice, db=db)
    assert info["read_url"] == READ_ENDPOINT.resource and info["write_url"] == WRITE_ENDPOINT.resource
    assert info["write_enabled"] is True and info["token_prefix"] == "wsmcp_" and info["token_expiry_days"] == [30, 90, 365]


async def test_apps_list_and_disconnect_rejects_pending(mcp_env):
    db, alice, bob = mcp_env
    now = datetime.now(timezone.utc)
    db.add(OAuthRefreshToken(token_hash="h1", user_id="alice", client_id="dcr_claude", scope="mcp:read mcp:write",
                             resource=WRITE_ENDPOINT.resource, issued_at=now - timedelta(hours=1),
                             expires_at=now + timedelta(days=30)))
    db.add(OAuthRefreshToken(token_hash="h2", user_id="alice", client_id="portal-gitea", scope="openid",
                             resource=None, issued_at=now, expires_at=now + timedelta(days=30)))
    tok = McpPersonalToken(token_hash="p1", user_id="alice", name="lab-runner", scopes='["mcp:read"]',
                           last_used_at=now - timedelta(hours=2), expires_at=now + timedelta(days=10))
    unused = McpPersonalToken(token_hash="p2", user_id="alice", name="unused", scopes='["mcp:read"]')
    db.add_all([tok, unused])
    await db.flush()
    db.add_all([_pending("alice", "dcr_claude", "wr_a1"), _pending("alice", "dcr_claude", "wr_a2"),
                _pending("alice", f"pat:{tok.id}", "wr_a3"), _pending("bob", "dcr_claude", "wr_b1")])
    await db.commit()

    apps = (await acct.list_apps(user=alice, db=db))["apps"]
    assert [a["key"] for a in apps] == ["dcr_claude", f"pat:{tok.id}"]  # SSO 클라이언트·안 쓴 토큰은 빠짐
    claude = apps[0]
    assert claude["kind"] == "oauth" and claude["can_write"] is True and claude["pending"] == 2
    assert apps[1]["kind"] == "personal_token" and apps[1]["token_name"] == "lab-runner" and apps[1]["pending"] == 1

    with pytest.raises(HTTPException) as ei:  # 남의 연결
        await acct.disconnect_app("dcr_claude", user=bob, db=db)
    assert ei.value.status_code == 404
    out = await acct.disconnect_app("dcr_claude", user=alice, db=db)
    assert out == {"ok": True, "rejected": 2}
    for rid in ("wr_a1", "wr_a2"):
        r = await db.get(McpWriteRequest, rid)
        assert r.status == "rejected" and r.reject_reason == "연결 해제됨"
    assert (await db.get(McpWriteRequest, "wr_b1")).status == "pending"  # bob 것은 그대로
    assert (await db.execute(select(OAuthRefreshToken).where(OAuthRefreshToken.token_hash == "h1"))).scalar_one().revoked_at
    # 개인 토큰 폐기도 그 토큰의 대기 요청을 거부
    out = await acct.revoke_token(tok.id, user=alice, db=db)
    assert out["rejected"] == 1 and (await db.get(McpWriteRequest, "wr_a3")).reject_reason == "연결 해제됨"
    assert (await acct.list_apps(user=alice, db=db))["apps"] == []


async def test_mcp_write_request_records_client_id(mcp_env):
    db, alice, _bob = mcp_env
    from contextlib import asynccontextmanager

    from app.mcp import access
    from app.mcp import server as reg
    from app.mcp.server import Tool, execute_tool

    @asynccontextmanager
    async def _session():
        yield db

    async def _send(user, to: str, **_):
        return {"sent": True}
    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(writes, "session", _session)

        async def none(*a, **k):
            return None
        mp.setattr(writes, "recent_untrusted", none)
        mp.setitem(access.TOOL_MODULE, "t_w5_high", None)
        reg.WORKSPACE_TOOLS["t_w5_high"] = Tool(name="t_w5_high", title="보내기", description="", scope="mcp:write",
                                                risk="high", parameters={"type": "object", "properties": {}},
                                                handler=_send)
        t = writes.call_context.set(writes.CallContext(source="mcp", client_name="Claude", client_kind="claude_app",
                                                       client_key="dcr_claude"))
        try:
            res = await execute_tool("t_w5_high", {"to": "x@y"}, alice, scopes=frozenset({"mcp:read", "mcp:write"}))
        finally:
            writes.call_context.reset(t)
        rid = res.get("approval_id") or res.get("id") or (res.get("data") or {}).get("approval_id")
        rows = (await db.execute(select(McpWriteRequest).where(McpWriteRequest.tool == "t_w5_high"))).scalars().all()
        assert rows and rows[0].client_id == "dcr_claude", (res, rid)
    finally:
        reg.WORKSPACE_TOOLS.pop("t_w5_high", None)
        mp.undo()
