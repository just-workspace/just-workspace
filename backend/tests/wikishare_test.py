"""위키 스페이스 공유 — 공개 범위 전환·멤버 추가/역할/제거 권한, 그리고 변경된 권한이 다음 요청부터 즉시 적용되는지 검증."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.db.models import User, WikiPage, WikiSpace, WikiSpaceMember
from app.wiki import collab
from app.wiki import router as wiki_router
from app.wiki.schemas import MemberAdd, MemberUpdate, SpaceCreate, SpaceUpdate


async def _seed(db):
    for uid in ("alice", "bob", "carol", "dave"):
        db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.title()))
    db.add(User(id="root", username="root", email="root@x", password_hash="x", is_admin=True))
    db.add(User(id="gone", username="gone", email="gone@x", password_hash="x", is_active=False))
    await db.commit()
    db.add(WikiSpace(id="s1", name="개발", slug="dev", owner_id="alice", visibility="private"))
    await db.commit()
    db.add(WikiPage(id="p1", space_id="s1", title="문서", slug="doc", content="본문", author_id="alice"))
    await db.commit()
    return {u: await db.get(User, u) for u in ("alice", "bob", "carol", "dave", "root")}


async def _status(coro) -> int:
    with pytest.raises(HTTPException) as e:
        await coro
    return e.value.status_code


async def _roles(db) -> dict[str, str]:
    return {m["user_id"]: m["role"] for m in await wiki_router.list_members(
        space_id="s1", user=await db.get(User, "alice"), db=db)}


@pytest.mark.asyncio
async def test_member_crud_by_owner(db_session):
    u = await _seed(db_session)
    db = db_session

    await wiki_router.add_member(space_id="s1", body=MemberAdd(user_id="bob"), user=u["alice"], db=db)
    assert await _roles(db) == {"bob": "reader"}

    await wiki_router.update_member(space_id="s1", member_user_id="bob", body=MemberUpdate(role="writer"),
                                    user=u["alice"], db=db)
    assert await _roles(db) == {"bob": "writer"}

    # 동일 사용자를 다시 추가하면 역할만 변경된다(행이 중복 생성되지 않는다)
    await wiki_router.add_member(space_id="s1", body=MemberAdd(user_id="bob", role="admin"), user=u["alice"], db=db)
    assert await _roles(db) == {"bob": "admin"}

    await wiki_router.remove_member(space_id="s1", member_user_id="bob", user=u["alice"], db=db)
    assert await _roles(db) == {}


@pytest.mark.asyncio
async def test_only_space_admins_can_change_sharing(db_session):
    u = await _seed(db_session)
    db = db_session
    db.add_all([
        WikiSpaceMember(space_id="s1", user_id="bob", role="writer"),
        WikiSpaceMember(space_id="s1", user_id="carol", role="admin"),
    ])
    await db.commit()

    # 편집 멤버·비멤버는 어떤 값도 변경할 수 없음
    for who in (u["bob"], u["dave"]):
        assert await _status(wiki_router.add_member(
            space_id="s1", body=MemberAdd(user_id="dave"), user=who, db=db)) == 403
        assert await _status(wiki_router.update_member(
            space_id="s1", member_user_id="bob", body=MemberUpdate(role="admin"), user=who, db=db)) == 403
        assert await _status(wiki_router.remove_member(
            space_id="s1", member_user_id="carol", user=who, db=db)) == 403
        assert await _status(wiki_router.update_space(
            space_id="s1", body=SpaceUpdate(visibility="public"), user=who, db=db)) == 403
    assert await _roles(db) == {"bob": "writer", "carol": "admin"}

    # 관리 역할 멤버와 시스템 관리자는 허용
    await wiki_router.add_member(space_id="s1", body=MemberAdd(user_id="dave"), user=u["carol"], db=db)
    await wiki_router.update_member(space_id="s1", member_user_id="dave", body=MemberUpdate(role="writer"),
                                    user=u["root"], db=db)
    assert (await _roles(db))["dave"] == "writer"
    await wiki_router.update_space(space_id="s1", body=SpaceUpdate(visibility="public"), user=u["carol"], db=db)
    assert (await db.get(WikiSpace, "s1")).visibility == "public"


@pytest.mark.asyncio
async def test_owner_stays_admin_and_bad_input_rejected(db_session):
    u = await _seed(db_session)
    db = db_session
    db.add(WikiSpaceMember(space_id="s1", user_id="carol", role="admin"))
    await db.commit()

    # 소유자는 멤버로 추가하거나 강등할 수 없음 → 관리자가 0명이 되지 않음
    assert await _status(wiki_router.add_member(
        space_id="s1", body=MemberAdd(user_id="alice", role="reader"), user=u["carol"], db=db)) == 400
    assert await _status(wiki_router.update_member(
        space_id="s1", member_user_id="alice", body=MemberUpdate(role="reader"), user=u["carol"], db=db)) == 400
    # 마지막 관리 멤버를 제거해도 소유자는 계속 관리자
    await wiki_router.remove_member(space_id="s1", member_user_id="carol", user=u["alice"], db=db)
    assert (await wiki_router.get_space(space_id="s1", user=u["alice"], db=db))["user_role"] == "admin"

    # 존재하지 않는·비활성 사용자, 알 수 없는 역할, 비멤버의 역할 변경, 존재하지 않는 스페이스
    assert await _status(wiki_router.add_member(
        space_id="s1", body=MemberAdd(user_id="nobody"), user=u["alice"], db=db)) == 404
    assert await _status(wiki_router.add_member(
        space_id="s1", body=MemberAdd(user_id="gone"), user=u["alice"], db=db)) == 404
    assert await _status(wiki_router.add_member(
        space_id="s1", body=MemberAdd(user_id="bob", role="owner"), user=u["alice"], db=db)) == 400
    assert await _status(wiki_router.update_member(
        space_id="s1", member_user_id="bob", body=MemberUpdate(role="writer"), user=u["alice"], db=db)) == 404
    assert await _status(wiki_router.add_member(
        space_id="nope", body=MemberAdd(user_id="bob"), user=u["root"], db=db)) == 404
    assert await _roles(db) == {}


@pytest.mark.asyncio
async def test_visibility_values(db_session):
    u = await _seed(db_session)
    db = db_session
    assert await _status(wiki_router.update_space(
        space_id="s1", body=SpaceUpdate(visibility="everyone"), user=u["alice"], db=db)) == 400
    assert await _status(wiki_router.create_space(
        body=SpaceCreate(name="x", slug="x", visibility="internal"), user=u["alice"], db=db)) == 400
    assert (await db.get(WikiSpace, "s1")).visibility == "private"
    # 이름만 변경하는 저장은 공개 범위를 변경하지 않음
    await wiki_router.update_space(space_id="s1", body=SpaceUpdate(name="새 이름"), user=u["alice"], db=db)
    sp = await db.get(WikiSpace, "s1")
    await db.refresh(sp)
    assert (sp.name, sp.visibility) == ("새 이름", "private")

    got = await wiki_router.get_space(space_id="s1", user=u["alice"], db=db)
    assert got["owner"] == {"id": "alice", "username": "alice", "display_name": "Alice", "avatar_url": None}


@pytest.mark.asyncio
async def test_access_follows_changes_on_next_request(db_session):
    """열려 있는 문서라도 권한이 변경되면 다음 요청부터 서버가 차단한다(요청마다 역할을 재조회한다)."""
    u = await _seed(db_session)
    db = db_session
    bob = u["bob"]

    assert await _status(wiki_router.get_page(page_id="p1", user=bob, db=db)) == 403
    assert await collab._page_access(bob, "p1", db) is None

    # 공개 → 읽기만 허용
    await wiki_router.update_space(space_id="s1", body=SpaceUpdate(visibility="public"), user=u["alice"], db=db)
    assert (await wiki_router.get_page(page_id="p1", user=bob, db=db))["user_role"] == "reader"
    assert await collab._page_access(bob, "p1", db) == "read"
    assert await _status(wiki_router.update_page(
        page_id="p1", body=wiki_router.PageUpdate(content="x"), user=bob, db=db)) == 403

    # 편집 멤버 → 쓰기
    await wiki_router.add_member(space_id="s1", body=MemberAdd(user_id="bob", role="writer"), user=u["alice"], db=db)
    await wiki_router.update_page(page_id="p1", body=wiki_router.PageUpdate(content="bob 이 씀"), user=bob, db=db)
    assert await collab._page_access(bob, "p1", db) == "write"

    # 읽기로 강등 → 저장 거부
    await wiki_router.update_member(space_id="s1", member_user_id="bob", body=MemberUpdate(role="reader"),
                                    user=u["alice"], db=db)
    assert await _status(wiki_router.update_page(
        page_id="p1", body=wiki_router.PageUpdate(content="y"), user=bob, db=db)) == 403
    assert await collab._page_access(bob, "p1", db) == "read"

    # 제거 후 비공개 전환 → 읽기·목록·검색·기록 전부 거부
    await wiki_router.remove_member(space_id="s1", member_user_id="bob", user=u["alice"], db=db)
    await wiki_router.update_space(space_id="s1", body=SpaceUpdate(visibility="private"), user=u["alice"], db=db)
    assert await _status(wiki_router.get_page(page_id="p1", user=bob, db=db)) == 403
    assert await _status(wiki_router.list_pages(space_id="s1", user=bob, db=db)) == 403
    assert await _status(wiki_router.list_versions(page_id="p1", user=bob, db=db)) == 403
    assert await _status(wiki_router.search_pages(space_id="s1", q="본문", user=bob, db=db)) == 403
    assert await _status(wiki_router.list_members(space_id="s1", user=bob, db=db)) == 403
    assert await collab._page_access(bob, "p1", db) is None
    assert all(s["id"] != "s1" for s in await wiki_router.list_spaces(user=bob, db=db))


class _FakeWs:
    def __init__(self):
        self.closed = None
        self.sent = []

    async def close(self, code=1000, reason=""):
        self.closed = code

    async def send_bytes(self, data):
        self.sent.append(bytes(data))


@pytest.mark.asyncio
async def test_collab_socket_rechecks_access(monkeypatch):
    """연결된 공동 편집 소켓도 권한을 주기적으로 재확인한다 — 변경 시 통지하고, 권한이 없어지면 연결을 종료한다."""
    answers = iter(["write", "read", RuntimeError("db down"), "read", "write", None])
    asked = []

    async def fake_access(user_id, page_id, db=None):
        asked.append((user_id, page_id))
        a = next(answers)
        if isinstance(a, Exception):
            raise a
        return a

    seen = []

    async def fake_sleep(_):
        seen.append(state["access"])

    monkeypatch.setattr(collab, "_current_access", fake_access)
    # 모듈이 참조하는 asyncio 만 교체한다(전역 asyncio.sleep 을 변경하면 테스트 러너까지 영향)
    monkeypatch.setattr(collab, "asyncio", SimpleNamespace(sleep=fake_sleep))
    ws, state = _FakeWs(), {"access": "write"}
    await collab._watch_access(ws, "bob", "p1", state)

    # DB 오류 1회는 연결을 종료하지 않고 무시한다. 권한이 없어진 시점에 4003 으로 종료한다
    assert seen == ["write", "write", "read", "read", "read", "write"]
    assert asked[0] == ("bob", "p1")
    assert ws.closed == 4003
    # 변경 시에만(쓰기→읽기, 읽기→쓰기) 해당 소켓에 제어 프레임을 송신
    assert ws.sent == [bytes([collab.MSG_ACCESS, 0]), bytes([collab.MSG_ACCESS, 1])]
    assert collab.frame_allowed("read", bytes([collab.MSG_UPDATE])) is False
    assert collab.frame_allowed("read", bytes([collab.MSG_AWARENESS])) is True
    # 클라이언트가 송신한 제어 프레임은 편집자의 것이라도 중계하지 않음
    assert collab.frame_allowed("write", bytes([collab.MSG_ACCESS, 0])) is False


@pytest.mark.asyncio
async def test_recheck_rereads_user(db_session):
    """재검사 시 사용자도 재조회한다 — 관리자 해제·비활성화가 접속 중인 소켓에 반영된다."""
    u = await _seed(db_session)
    db = db_session
    assert await collab._current_access("root", "p1", db) == "write"     # 사이트 관리자
    assert await collab._current_access("alice", "p1", db) == "write"    # 소유자
    assert await collab._current_access("bob", "p1", db) is None
    assert await collab._current_access("alice", "no-such-page", db) is None
    assert await collab._current_access("nobody", "p1", db) is None

    u["root"].is_admin = False
    await db.commit()
    assert await collab._current_access("root", "p1", db) is None        # 관리자에서 제외되면 멤버가 아님

    u["alice"].is_active = False
    await db.commit()
    assert await collab._current_access("alice", "p1", db) is None       # 비활성 = 연결 종료
