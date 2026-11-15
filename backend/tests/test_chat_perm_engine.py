"""채팅 역할·권한 엔진(P1-1) — 그림자/강제 모드 비교, 계산 순서, 역할·덮어쓰기·카테고리 API, @역할 멘션.

핵심 보증: 기본 역할 세트(@everyone = DEFAULT_EVERYONE, 역할·덮어쓰기 없음)에서
  - shadow 모드: 스냅샷 표 그대로 + 불일치 0 + 엔진 오류 0
  - enforce 모드: 새 엔진으로 막아도 스냅샷 표 그대로
"""

import json
import logging
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.chat import permissions as P
from tests import chat_perm_matrix as M


@pytest.fixture()
def world(monkeypatch, tmp_path):
    M.silence_side_effects(monkeypatch, str(tmp_path))

    async def _no_redis(_fields):
        return None
    monkeypatch.setattr(P, "_record_redis", _no_redis)
    return str(tmp_path)


def _mode(monkeypatch, mode):
    monkeypatch.setattr(P, "engine_mode", lambda: mode)


def _reset_stats():
    for k in P.SHADOW_STATS:
        P.SHADOW_STATS[k] = 0


# ─── 1. 기본 역할 세트 = 지금 동작 ───

@pytest.mark.parametrize("action,ch,actor", M.all_cases())
async def test_shadow_zero_mismatch(world, monkeypatch, action, ch, actor):
    _mode(monkeypatch, "shadow")
    _reset_stats()
    got = await M.run_case(action, ch, actor, world, seeded=True)
    assert got == M.expected(action, ch, actor)
    assert P.SHADOW_STATS["mismatch"] == 0, f"{action} @ {ch} by {actor}"
    assert P.SHADOW_STATS["error"] == 0


@pytest.mark.parametrize("action,ch,actor", M.all_cases())
async def test_enforce_matches_snapshot(world, monkeypatch, action, ch, actor):
    _mode(monkeypatch, "enforce")
    _reset_stats()
    got = await M.run_case(action, ch, actor, world, seeded=True)
    assert got == M.expected(action, ch, actor), f"{action} @ {ch} by {actor}"
    assert P.SHADOW_STATS["error"] == 0


async def test_shadow_without_seed_rows_still_zero(world, monkeypatch):
    """@everyone 행이 아직 없을 때(마이그레이션 전) — 상수 기본값으로 계산해도 불일치 0."""
    _mode(monkeypatch, "shadow")
    _reset_stats()
    for action in M.EXPECTED:
        for ch in M.CHANNELS:
            for actor in ("own", "mem", "out"):
                assert await M.run_case(action, ch, actor, world) == M.expected(action, ch, actor)
    assert P.SHADOW_STATS["mismatch"] == 0 and P.SHADOW_STATS["error"] == 0
    assert P.SHADOW_STATS["checks"] > 0


async def test_legacy_mode_skips_engine(world, monkeypatch):
    _mode(monkeypatch, "legacy")
    _reset_stats()
    assert await M.run_case("message.send", "pub", "mem", world) == 200
    assert await M.run_case("message.send", "pub", "out", world) == 403
    assert P.SHADOW_STATS["checks"] == 0


# ─── 2. 계산 순서(순수 함수) ───

def _ctx(**kw):
    ch = kw.pop("channel", SimpleNamespace(id="c", type="public", category_id="cat", is_voice=None))
    base = dict(user_id="u", channel=ch, member_role="member", everyone_role_id="ev")
    base.update(kw)
    return P.PermContext(**base)


def test_order_role_deny_then_allow_then_member():
    S = P.SEND_MESSAGES
    # @everyone 거부 → 역할 A 거부, 역할 B 허용 → 허용이 이긴다
    c = _ctx(role_ids={"a", "b"}, channel_overwrites=[
        ("role", "ev", 0, S), ("role", "a", 0, S), ("role", "b", S, 0)])
    assert P.compute_permissions(c) & S
    # 사용자 거부가 역할 허용보다 나중
    c.channel_overwrites.append(("user", "u", 0, S))
    assert not P.compute_permissions(c) & S


def test_category_then_channel():
    S = P.SEND_MESSAGES
    c = _ctx(category_overwrites=[("role", "ev", 0, S)])
    assert not P.compute_permissions(c) & S
    c.channel_overwrites = [("role", "ev", S, 0)]
    assert P.compute_permissions(c) & S


def test_membership_gate_and_explicit_view():
    c = _ctx(member_role=None)
    assert P.compute_permissions(c) == 0
    c.channel_overwrites = [("user", "u", P.VIEW_CHANNEL, 0)]
    assert P.compute_permissions(c) & P.VIEW_CHANNEL


def test_administrator_short_circuit_and_dm_isolation():
    c = _ctx(member_role=None, role_permissions=P.ADMINISTRATOR, channel_overwrites=[("user", "u", 0, P.VIEW_CHANNEL)])
    assert P.compute_permissions(c) == P.ALL_PERMISSIONS
    dm = SimpleNamespace(id="d", type="dm", category_id=None, is_voice=None)
    # DM: 역할(ADMINISTRATOR 포함)·덮어쓰기 무시, 멤버만
    assert P.compute_permissions(_ctx(channel=dm, member_role=None, role_permissions=P.ADMINISTRATOR)) == 0
    assert P.compute_permissions(_ctx(channel=dm, everyone_permissions=0)) == P.DM_PERMISSIONS


def test_global_admin_is_workspace_only():
    assert P.compute_permissions(_ctx(channel=None, is_global_admin=True)) == P.ALL_PERMISSIONS
    # 채널 안에서는 특권 없음(지금 동작 — 남의 비공개 채널·DM 을 못 본다)
    assert P.compute_permissions(_ctx(member_role=None, is_global_admin=True)) == 0


def test_dependencies():
    c = _ctx(channel_overwrites=[("role", "ev", 0, P.SEND_MESSAGES | P.CONNECT)])
    bits = P.compute_permissions(c)
    assert not bits & (P.ATTACH_FILES | P.MENTION_EVERYONE | P.SPEAK | P.STREAM)
    assert bits & P.ADD_REACTIONS


def test_channel_role_implicit():
    assert P.compute_permissions(_ctx(member_role="admin")) & P.MANAGE_CHANNELS
    assert not P.compute_permissions(_ctx(member_role="owner")) & P.MANAGE_MESSAGES


def test_bits_of():
    assert P.bits_of(["view_channel", "SEND_MESSAGES"]) == P.VIEW_CHANNEL | P.SEND_MESSAGES
    with pytest.raises(ValueError):
        P.bits_of(["NOPE"])
    with pytest.raises(ValueError):
        P.bits_of(1 << 50)
    assert len(P.PERMISSIONS) >= 30


# ─── 3. 역할을 쓰기 시작하면: 그림자는 차이만 기록, 강제는 새 판정 ───

async def _world(world):
    eng, db = await M.open_world(world)
    await M.seed_defaults(db)
    return eng, db


async def _close(eng, db):
    await db.close()
    await eng.dispose()


async def _mk_role(db, admin, **kw):
    from app.chat import roles as R
    return await R.create_role(R.RoleCreate(**kw), user=admin, db=db)


async def test_manage_messages_role_shadow_vs_enforce(world, monkeypatch, caplog):
    from app.chat import roles as R
    from app.chat import router as r
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        role = await _mk_role(db, admin, name="moderator", permissions=["MANAGE_MESSAGES"])
        await R.assign_role(role["id"], "adm", user=admin, db=db)

        _mode(monkeypatch, "shadow")
        _reset_stats()
        caplog.set_level(logging.WARNING, logger="app.chat.permissions")
        with pytest.raises(HTTPException) as e:
            await r.delete_message("m_mem_pub", user=M.user_ns("adm"), db=db)
        assert e.value.status_code == 403          # 그림자: 예전대로 막는다
        assert P.SHADOW_STATS["mismatch"] == 1     # … 차이는 기록
        rec = [json.loads(x.getMessage()) for x in caplog.records if "chat_perm_shadow_mismatch" in x.getMessage()]
        assert rec and rec[0]["action"] == "message.delete" and rec[0]["legacy"] is False and rec[0]["engine"] is True
        # 개인정보 없음 — id 는 해시, 본문 없음
        raw = caplog.text
        assert '"adm"' not in raw and "hello from" not in raw and rec[0]["user"] and len(rec[0]["user"]) == 12

        _mode(monkeypatch, "enforce")
        assert await r.delete_message("m_mem_pub", user=M.user_ns("adm"), db=db) == {"ok": True}
    finally:
        await _close(eng, db)


async def test_overwrite_deny_send_enforced(world, monkeypatch):
    from app.chat import roles as R
    from app.chat import router as r
    from app.chat.schemas import MessageCreate
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        ow = await R.put_channel_overwrite("pub", "role", "everyone", R.OverwriteBody(deny=["SEND_MESSAGES"]),
                                           user=admin, db=db)
        assert ow["deny_names"] == ["SEND_MESSAGES"]
        me = await R.my_channel_permissions("pub", user=M.user_ns("mem"), db=db)
        assert "SEND_MESSAGES" not in me["permission_names"] and "VIEW_CHANNEL" in me["permission_names"]
        # 역할 허용이 @everyone 거부를 이긴다
        role = await _mk_role(db, admin, name="speakers", permissions=0)
        await R.assign_role(role["id"], "mem", user=admin, db=db)
        await R.put_channel_overwrite("pub", "role", role["id"], R.OverwriteBody(allow=["SEND_MESSAGES"]),
                                      user=admin, db=db)
        _mode(monkeypatch, "enforce")
        assert (await r.send_message("pub", MessageCreate(content="ok"), user=M.user_ns("mem"), db=db))["id"]
        with pytest.raises(HTTPException) as e:
            await r.send_message("pub", MessageCreate(content="no"), user=M.user_ns("gam"), db=db)
        assert e.value.status_code == 403
        # 덮어쓰기 지우면 원상
        await R.delete_channel_overwrite("pub", "role", "everyone", user=admin, db=db)
        assert (await r.send_message("pub", MessageCreate(content="ok"), user=M.user_ns("gam"), db=db))["id"]
        # DM 에는 덮어쓰기 불가
        with pytest.raises(HTTPException) as e:
            await R.put_channel_overwrite("dm", "role", "everyone", R.OverwriteBody(deny=1), user=admin, db=db)
        assert e.value.status_code == 400
    finally:
        await _close(eng, db)


async def test_category_overwrite_applies(world, monkeypatch):
    from app.chat import roles as R
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        cats = (await R.list_categories(user=admin, db=db))["items"]
        text_cat = next(c for c in cats if c["name"] == "채널")
        await R.put_category_overwrite(text_cat["id"], "role", "everyone", R.OverwriteBody(deny=["ADD_REACTIONS"]),
                                       user=admin, db=db)
        assert not await P.effective_permissions(db, M.user_ns("mem"), "pub") & P.ADD_REACTIONS
        assert await P.effective_permissions(db, M.user_ns("mem"), "voi") & P.ADD_REACTIONS   # 음성 카테고리
        # 채널 덮어쓰기가 카테고리보다 나중
        await R.put_channel_overwrite("pub", "user", "mem", R.OverwriteBody(allow=["ADD_REACTIONS"]), user=admin, db=db)
        assert await P.effective_permissions(db, M.user_ns("mem"), "pub") & P.ADD_REACTIONS
    finally:
        await _close(eng, db)


# ─── 4. 역할 API — 권한·계층·관리되는 역할·감사 로그 ───

async def test_roles_crud_hierarchy_and_audit(world):
    from app.chat import roles as R
    from app.db.models import AuditLog, ChatMemberRole
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        mem = M.user_ns("mem")
        with pytest.raises(HTTPException) as e:
            await _mk_role(db, mem, name="x")
        assert e.value.status_code == 403
        with pytest.raises(HTTPException) as e:
            await _mk_role(db, admin, name="bad", color="#ff0000")
        assert e.value.status_code == 400
        with pytest.raises(HTTPException) as e:
            await _mk_role(db, admin, name="everyone")
        assert e.value.status_code == 400

        lead = await _mk_role(db, admin, name="Team Lead", color="primary", hoist=True,
                              permissions=["MANAGE_ROLES", "KICK_MEMBERS"])
        assert lead["mention"] == "team-lead" and lead["position"] == 1
        staff = await _mk_role(db, admin, name="staff")           # 새 역할은 맨 아래(1), lead 는 2
        assert staff["position"] == 1
        with pytest.raises(HTTPException) as e:
            await _mk_role(db, admin, name="STAFF")
        assert e.value.status_code == 409
        await R.assign_role(lead["id"], "mem", user=admin, db=db)

        # mem(lead 보유) — 아래 역할(staff)만 다룬다, 자기 비트만 준다
        await R.update_role(staff["id"], R.RolePatch(permissions=["KICK_MEMBERS"]), user=mem, db=db)
        with pytest.raises(HTTPException) as e:
            await R.update_role(staff["id"], R.RolePatch(permissions=["ADMINISTRATOR"]), user=mem, db=db)
        assert e.value.status_code == 403
        with pytest.raises(HTTPException) as e:
            await R.update_role(lead["id"], R.RolePatch(name="boss"), user=mem, db=db)
        assert e.value.status_code == 403
        new = await _mk_role(db, mem, name="helpers")
        await R.assign_role(new["id"], "out", user=mem, db=db)
        # 순서: mem 은 자기 역할 위로 올릴 수 없다
        with pytest.raises(HTTPException) as e:
            await R.reorder_roles(R.RoleOrder(role_ids=[new["id"], lead["id"]]), user=mem, db=db)
        assert e.value.status_code == 403

        # @everyone 은 권한만
        with pytest.raises(HTTPException) as e:
            await R.update_role("everyone", R.RolePatch(name="all"), user=admin, db=db)
        assert e.value.status_code == 400
        with pytest.raises(HTTPException) as e:
            await R.delete_role("everyone", user=admin, db=db)
        assert e.value.status_code == 400

        listed = (await R.list_roles(user=mem, db=db))["items"]
        assert listed[-1]["is_default"] and {r["name"] for r in listed} >= {"Team Lead", "staff", "helpers"}
        assert next(r for r in listed if r["id"] == new["id"])["member_count"] == 1

        await R.delete_role(new["id"], user=admin, db=db)
        assert not (await db.execute(select(ChatMemberRole).where(ChatMemberRole.role_id == new["id"]))).first()
        actions = set((await db.execute(select(AuditLog.action))).scalars())
        assert {"chat.role.create", "chat.role.update", "chat.role.assign", "chat.role.delete"} <= actions
    finally:
        await _close(eng, db)


async def test_group_sync_managed_role(world):
    from app.chat import roles as R
    from app.groups.models import Group, GroupMember
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        db.add(Group(id="g1", name="Design"))
        db.add(GroupMember(group_id="g1", user_id="mem"))
        await db.commit()
        out = await R.sync_groups(R.SyncGroups(), user=admin, db=db)
        assert len(out["created"]) == 1 and out["created"][0]["managed"]
        rid = out["created"][0]["id"]
        assert (await R.sync_groups(R.SyncGroups(), user=admin, db=db))["created"] == []   # 멱등
        assert [r["id"] for r in (await R.get_user_roles("mem", user=admin, db=db))["items"]] == [rid]
        with pytest.raises(HTTPException) as e:
            await R.assign_role(rid, "out", user=admin, db=db)
        assert e.value.status_code == 409
        # 그룹 멤버십으로 권한이 따라온다
        await R.update_role(rid, R.RolePatch(permissions=["MANAGE_MESSAGES"]), user=admin, db=db)
        assert await P.effective_permissions(db, M.user_ns("mem"), "pub") & P.MANAGE_MESSAGES
        assert not await P.effective_permissions(db, M.user_ns("own"), "pub") & P.MANAGE_MESSAGES
    finally:
        await _close(eng, db)


async def test_effective_endpoint_and_set_user_roles(world):
    from app.chat import roles as R
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        a = await _mk_role(db, admin, name="a", permissions=["MANAGE_MESSAGES"])
        b = await _mk_role(db, admin, name="b")
        out = await R.set_user_roles("mem", R.UserRoles(role_ids=[a["id"], b["id"]]), user=admin, db=db)
        assert set(out["added"]) == {a["id"], b["id"]}
        out = await R.set_user_roles("mem", R.UserRoles(role_ids=[b["id"]]), user=admin, db=db)
        assert out["removed"] == [a["id"]]
        with pytest.raises(HTTPException):
            await R.effective_for(user_id="own", channel_id="pub", user=M.user_ns("mem"), db=db)
        eff = await R.effective_for(user_id="own", channel_id="pub", user=admin, db=db)
        assert "MANAGE_CHANNELS" in eff["permission_names"] and "MANAGE_MESSAGES" not in eff["permission_names"]
        eff = await R.effective_for(user_id="out", channel_id="prv", user=admin, db=db)
        assert eff["permissions"] == 0
        cat = await R.permissions_catalog(user=admin)
        assert cat["default_everyone"] == P.DEFAULT_EVERYONE and len(cat["permissions"]) >= 30
    finally:
        await _close(eng, db)


# ─── 5. 카테고리 · 정렬 ───

async def test_categories_and_layout(world):
    from app.chat import roles as R
    from app.db.models import Channel
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        with pytest.raises(HTTPException):
            await R.create_category(R.CategoryCreate(name="x"), user=M.user_ns("mem"), db=db)
        c = await R.create_category(R.CategoryCreate(name="프로젝트"), user=admin, db=db)
        assert c["position"] == 3
        # 채널 owner 는 자기 채널을 옮길 수 있다(MANAGE_CHANNELS 암묵), member 는 못 한다
        await R.update_layout(R.LayoutBody(channels=[R.LayoutChannel(id="pub", category_id=c["id"], position=2)]),
                              user=M.user_ns("own"), db=db)
        with pytest.raises(HTTPException) as e:
            await R.update_layout(R.LayoutBody(channels=[R.LayoutChannel(id="prv", category_id=c["id"])]),
                                  user=M.user_ns("mem"), db=db)
        assert e.value.status_code == 403
        with pytest.raises(HTTPException) as e:
            await R.update_layout(R.LayoutBody(channels=[R.LayoutChannel(id="dm")]), user=admin, db=db)
        assert e.value.status_code == 400
        ch = await db.get(Channel, "pub")
        await db.refresh(ch)
        assert ch.category_id == c["id"] and ch.position == 2
        await R.update_category(c["id"], R.CategoryPatch(name="P", position=0), user=admin, db=db)
        await R.delete_category(c["id"], user=admin, db=db)
        await db.refresh(ch)
        assert ch.category_id is None
    finally:
        await _close(eng, db)


# ─── 6. 멤버 목록 역할별 ───

async def test_members_by_role(world):
    from app.chat import roles as R
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        mods = await _mk_role(db, admin, name="mods", hoist=True, color="success")
        vip = await _mk_role(db, admin, name="vip", hoist=True, color="warning")   # vip 가 mods 보다 아래(1)
        plain = await _mk_role(db, admin, name="plain", color="danger")            # hoist 아님, 가장 아래
        await R.reorder_roles(R.RoleOrder(role_ids=[mods["id"], vip["id"], plain["id"]]), user=admin, db=db)
        await R.assign_role(mods["id"], "own", user=admin, db=db)
        await R.assign_role(vip["id"], "own", user=admin, db=db)
        await R.assign_role(vip["id"], "adm", user=admin, db=db)
        await R.assign_role(plain["id"], "mem", user=admin, db=db)
        out = await R.members_by_role("pub", user=M.user_ns("mem"), db=db)
        groups = [(g["role"]["name"] if g["role"] else None, sorted(m["user_id"] for m in g["members"]))
                  for g in out["groups"]]
        assert groups == [("mods", ["own"]), ("vip", ["adm"]), (None, ["gam", "mem"])]
        mem_row = next(m for g in out["groups"] for m in g["members"] if m["user_id"] == "mem")
        assert mem_row["color"] == "danger"
        with pytest.raises(HTTPException):
            await R.members_by_role("prv", user=M.user_ns("out"), db=db)
    finally:
        await _close(eng, db)


# ─── 7. @역할 멘션 ───

async def _mentions(db, msg_id):
    from app.db.models import ChatMention, Notification
    rows = sorted((await db.execute(select(ChatMention.user_id, ChatMention.is_group).where(
        ChatMention.message_id == msg_id))).all())
    notifs = (await db.execute(select(Notification.user_id, Notification.title))).all()
    return rows, notifs


async def test_role_mention(world, monkeypatch):
    from app.chat import roles as R
    from app.chat import router as r
    from app.chat.schemas import MessageCreate
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        ops = await _mk_role(db, admin, name="On Call", mentionable=True)
        for u in ("own", "adm", "out"):           # out 은 채널 비멤버 → 안 받는다
            await R.assign_role(ops["id"], u, user=admin, db=db)
        msg = await r.send_message("pub", MessageCreate(content="@on-call 장애입니다"), user=M.user_ns("mem"), db=db)
        rows, notifs = await _mentions(db, msg["id"])
        assert rows == [("adm", False), ("own", False)]
        assert any("@On Call 역할" in t for _u, t in notifs)

        # 멘션 불가 역할 — MENTION_EVERYONE 이 있으면 부를 수 있다(기본 @everyone 에 있음)
        hidden = await _mk_role(db, admin, name="secret")
        await R.assign_role(hidden["id"], "gam", user=admin, db=db)
        msg = await r.send_message("pub", MessageCreate(content="@secret hi"), user=M.user_ns("mem"), db=db)
        assert (await _mentions(db, msg["id"]))[0] == [("gam", False)]
        await R.update_role("everyone", R.RolePatch(permissions=P.DEFAULT_EVERYONE & ~P.MENTION_EVERYONE),
                            user=admin, db=db)
        msg = await r.send_message("pub", MessageCreate(content="@secret hi"), user=M.user_ns("mem"), db=db)
        assert (await _mentions(db, msg["id"]))[0] == []

        # legacy 모드: 역할 멘션 꺼짐
        _mode(monkeypatch, "legacy")
        msg = await r.send_message("pub", MessageCreate(content="@on-call again"), user=M.user_ns("mem"), db=db)
        assert (await _mentions(db, msg["id"]))[0] == []
    finally:
        await _close(eng, db)


async def test_mention_everyone_permission(world, monkeypatch):
    from app.chat import roles as R
    from app.chat import router as r
    from app.chat.schemas import MessageCreate
    eng, db = await _world(world)
    try:
        admin = M.user_ns("gad")
        await R.update_role("everyone", R.RolePatch(permissions=P.DEFAULT_EVERYONE & ~P.MENTION_EVERYONE),
                            user=admin, db=db)
        _mode(monkeypatch, "shadow")
        _reset_stats()
        msg = await r.send_message("pub", MessageCreate(content="@everyone a"), user=M.user_ns("mem"), db=db)
        assert len((await _mentions(db, msg["id"]))[0]) == 3          # 그림자: 예전대로 전원
        assert P.SHADOW_STATS["mismatch"] == 1
        _mode(monkeypatch, "enforce")
        msg = await r.send_message("pub", MessageCreate(content="@everyone b"), user=M.user_ns("mem"), db=db)
        assert (await _mentions(db, msg["id"]))[0] == []
        # DM 은 역할과 무관 — 그대로 된다
        msg = await r.send_message("dm", MessageCreate(content="@everyone c"), user=M.user_ns("mem"), db=db)
        assert (await _mentions(db, msg["id"]))[0] == [("own", True)]
    finally:
        await _close(eng, db)


async def test_channel_delete_cleans_overwrites(world):
    from app.chat import roles as R
    from app.chat import router as r
    from app.db.models import ChatPermissionOverwrite
    eng, db = await _world(world)
    try:
        await R.put_channel_overwrite("pub", "user", "mem", R.OverwriteBody(deny=["PIN_MESSAGES"]),
                                      user=M.user_ns("gad"), db=db)
        await r.delete_channel("pub", user=M.user_ns("own"), db=db)
        assert not (await db.execute(select(ChatPermissionOverwrite))).first()
    finally:
        await _close(eng, db)
