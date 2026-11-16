"""게시판·위키 구역 전수조사 수정 사항 고정.

게시판: 일반 사용자의 본인 글 수정(고정·필독 값을 함께 전송해도 403 아님) · 카테고리/첨부 비우기 ·
        다른 글의 댓글을 부모로 한 답글 거부 · 북마크 수에서 삭제된 글 제외.
위키:   base_version 충돌 409 · 다른 스페이스 부모 거부 · 멤버 역할 검증/중복 추가 · 설명 비우기.
"""

import pytest
from fastapi import HTTPException

from app.board import router as board_router
from app.board import service as board_service
from app.board.schemas import CommentCreate, PostCreate, PostUpdate
from app.db.models import Post, User, WikiSpace
from app.wiki import router as wiki_router
from app.wiki import service as wiki_service
from app.wiki.schemas import MemberAdd, MemberUpdate, PageCreate, PageUpdate, SpaceUpdate


@pytest.fixture(autouse=True)
def _no_realtime(monkeypatch):
    from app.notifications import service as nsvc

    async def _deliver(d, push=True):
        return None

    monkeypatch.setattr(nsvc, "_deliver", _deliver)


async def _users(db):
    db.add(User(id="alice", username="alice", email="alice@x", password_hash="x", display_name="Alice"))
    db.add(User(id="bob", username="bob", email="bob@x", password_hash="x", display_name="Bob"))
    db.add(User(id="root", username="root", email="root@x", password_hash="x", is_admin=True))
    await db.commit()
    return await db.get(User, "alice"), await db.get(User, "bob"), await db.get(User, "root")


# ─── 게시판 ───

@pytest.mark.asyncio
async def test_author_can_edit_own_post_when_flags_are_sent_unchanged(db_session):
    """편집 화면은 is_pinned·is_must_read 를 항상 전송한다 — 값이 동일하면 공지 권한 검사 대상이 아니다."""
    db = db_session
    alice, bob, root = await _users(db)
    b = await board_service.create_board(db, name="자유", slug="free")  # notice_permission 기본 = admin
    p = await board_router.create_post(board_id=b["id"], body=PostCreate(title="원래 제목", content="본문"), user=alice, db=db)

    out = await board_router.update_post(
        post_id=p["id"],
        body=PostUpdate(title="고친 제목", content="고친 본문", category=None, is_pinned=False, is_must_read=False, attachments=[]),
        user=alice, db=db,
    )
    assert out["title"] == "고친 제목" and out["content"] == "고친 본문"

    # 값을 실제로 변경하려는 경우는 여전히 관리자만 허용
    with pytest.raises(HTTPException) as ei:
        await board_router.update_post(post_id=p["id"], body=PostUpdate(is_pinned=True), user=alice, db=db)
    assert ei.value.status_code == 403
    with pytest.raises(HTTPException) as ei:
        await board_router.update_post(post_id=p["id"], body=PostUpdate(is_must_read=True), user=alice, db=db)
    assert ei.value.status_code == 403
    assert (await board_router.update_post(post_id=p["id"], body=PostUpdate(is_pinned=True), user=root, db=db))["is_pinned"] is True

    # 타 사용자의 글은 여전히 수정 불가
    with pytest.raises(HTTPException) as ei:
        await board_router.update_post(post_id=p["id"], body=PostUpdate(title="x"), user=bob, db=db)
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_edit_can_clear_category_and_attachments(db_session):
    db = db_session
    alice, _bob, _root = await _users(db)
    b = await board_service.create_board(db, name="자유", slug="free", categories=["질문"])
    p = await board_router.create_post(
        board_id=b["id"],
        body=PostCreate(title="t", content="c", category="질문", attachments=[{"name": "a.txt", "url": "/s/1"}]),
        user=alice, db=db,
    )
    assert p["category"] == "질문" and len(p["attachments"]) == 1

    # 전송하지 않은 필드는 유지
    out = await board_router.update_post(post_id=p["id"], body=PostUpdate(title="t2"), user=alice, db=db)
    assert out["category"] == "질문" and len(out["attachments"]) == 1

    # null · 빈 목록 전송 시 비움
    out = await board_router.update_post(post_id=p["id"], body=PostUpdate(category=None, attachments=[]), user=alice, db=db)
    assert out["category"] is None and out["attachments"] == []
    row = await db.get(Post, p["id"])
    assert row.category is None and row.attachments is None

    # 다시 첨부한 뒤 null 로도 비워짐
    await board_router.update_post(post_id=p["id"], body=PostUpdate(attachments=[{"name": "b", "url": "/s/2"}]), user=alice, db=db)
    out = await board_router.update_post(post_id=p["id"], body=PostUpdate(attachments=None), user=alice, db=db)
    assert out["attachments"] == []

    # 제목·본문의 null 은 "안 바꿈", 빈 본문은 거부
    out = await board_router.update_post(post_id=p["id"], body=PostUpdate(title=None, content=None, category="질문"), user=alice, db=db)
    assert out["title"] == "t2" and out["content"] == "c" and out["category"] == "질문"
    with pytest.raises(HTTPException) as ei:
        await board_router.update_post(post_id=p["id"], body=PostUpdate(content="   "), user=alice, db=db)
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_reply_parent_must_belong_to_same_post(db_session):
    db = db_session
    alice, bob, _root = await _users(db)
    b = await board_service.create_board(db, name="자유", slug="free")
    p1 = await board_router.create_post(board_id=b["id"], body=PostCreate(title="1", content="c"), user=alice, db=db)
    p2 = await board_router.create_post(board_id=b["id"], body=PostCreate(title="2", content="c"), user=alice, db=db)
    c1 = await board_router.create_comment(post_id=p1["id"], body=CommentCreate(content="첫 댓글"), user=alice, db=db)

    with pytest.raises(HTTPException) as ei:
        await board_router.create_comment(post_id=p2["id"], body=CommentCreate(content="엉뚱한 답글", parent_id=c1["id"]), user=bob, db=db)
    assert ei.value.status_code == 400
    assert (await db.get(Post, p2["id"])).comment_count == 0

    # 같은 글의 답글은 허용
    r = await board_router.create_comment(post_id=p1["id"], body=CommentCreate(content="답글", parent_id=c1["id"]), user=bob, db=db)
    assert r["parent_id"] == c1["id"]


@pytest.mark.asyncio
async def test_bookmark_total_excludes_deleted_posts(db_session):
    db = db_session
    alice, bob, _root = await _users(db)
    b = await board_service.create_board(db, name="자유", slug="free")
    p1 = await board_router.create_post(board_id=b["id"], body=PostCreate(title="1", content="c"), user=alice, db=db)
    p2 = await board_router.create_post(board_id=b["id"], body=PostCreate(title="2", content="c"), user=alice, db=db)
    for p in (p1, p2):
        await board_router.toggle_bookmark(post_id=p["id"], user=bob, db=db)
    await board_router.delete_post(post_id=p1["id"], user=alice, db=db)
    out = await board_router.list_bookmarks(page=1, page_size=20, user=bob, db=db)
    assert out["total"] == 1 and [x["id"] for x in out["posts"]] == [p2["id"]]


# ─── 위키 ───

async def _space(db, owner="alice", slug="s"):
    sp = WikiSpace(name=slug, slug=slug, owner_id=owner)
    db.add(sp)
    await db.commit()
    await db.refresh(sp)
    return sp.id


@pytest.mark.asyncio
async def test_wiki_base_version_conflict_is_409(db_session):
    db = db_session
    alice, bob, _root = await _users(db)
    sid = await _space(db)
    await wiki_service.add_member(db, sid, "bob", "writer")
    page = await wiki_router.create_page(space_id=sid, body=PageCreate(title="p", slug="p", content="v1"), user=alice, db=db)
    assert page["version"] == 1

    # 밥이 먼저 수정(버전 2)
    out = await wiki_router.update_page(page_id=page["id"], body=PageUpdate(content="밥의 수정", base_version=1), user=bob, db=db)
    assert out["version"] == 2

    # 앨리스는 이전 버전(1)을 기준으로 저장 → 409, 본문은 밥의 수정본 유지
    with pytest.raises(HTTPException) as ei:
        await wiki_router.update_page(page_id=page["id"], body=PageUpdate(content="앨리스의 옛 본문", base_version=1), user=alice, db=db)
    assert ei.value.status_code == 409
    assert (await wiki_service.get_page(db, page["id"]))["content"] == "밥의 수정"

    # 버전이 일치하면 저장되며, base_version 없이(덮어쓰기 선택·구형 클라이언트)도 저장된다
    out = await wiki_router.update_page(page_id=page["id"], body=PageUpdate(content="앨리스 v3", base_version=2), user=alice, db=db)
    assert out["content"] == "앨리스 v3"
    out = await wiki_router.update_page(page_id=page["id"], body=PageUpdate(content="강제"), user=bob, db=db)
    assert out["content"] == "강제"

    # 이동·고정은 버전이 상이해도 차단하지 않음
    out = await wiki_router.update_page(page_id=page["id"], body=PageUpdate(is_pinned=True, base_version=1), user=alice, db=db)
    assert out["is_pinned"] is True


@pytest.mark.asyncio
async def test_wiki_parent_must_be_in_same_space(db_session):
    db = db_session
    alice, _bob, _root = await _users(db)
    s1, s2 = await _space(db, slug="s1"), await _space(db, slug="s2")
    a = await wiki_router.create_page(space_id=s1, body=PageCreate(title="a", slug="a"), user=alice, db=db)
    other = await wiki_router.create_page(space_id=s2, body=PageCreate(title="o", slug="o"), user=alice, db=db)

    with pytest.raises(HTTPException) as ei:
        await wiki_router.create_page(space_id=s1, body=PageCreate(title="x", slug="x", parent_id=other["id"]), user=alice, db=db)
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        await wiki_router.update_page(page_id=a["id"], body=PageUpdate(parent_id=other["id"]), user=alice, db=db)
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        await wiki_router.update_page(page_id=a["id"], body=PageUpdate(parent_id="no-such-page"), user=alice, db=db)
    assert ei.value.status_code == 400

    # 같은 스페이스 내에서는 허용
    child = await wiki_router.create_page(space_id=s1, body=PageCreate(title="c", slug="c", parent_id=a["id"]), user=alice, db=db)
    assert child["parent_id"] == a["id"]


@pytest.mark.asyncio
async def test_wiki_member_role_validated_and_duplicate_add_updates(db_session):
    db = db_session
    alice, _bob, _root = await _users(db)
    sid = await _space(db)

    with pytest.raises(HTTPException) as ei:
        await wiki_router.add_member(space_id=sid, body=MemberAdd(user_id="bob", role="owner"), user=alice, db=db)
    assert ei.value.status_code == 400

    await wiki_router.add_member(space_id=sid, body=MemberAdd(user_id="bob", role="reader"), user=alice, db=db)
    # 동일 사용자를 다시 추가해도 500 이 아니라 역할만 변경됨
    await wiki_router.add_member(space_id=sid, body=MemberAdd(user_id="bob", role="writer"), user=alice, db=db)
    members = await wiki_service.get_members(db, sid)
    assert [(m["user_id"], m["role"]) for m in members] == [("bob", "writer")]

    with pytest.raises(HTTPException) as ei:
        await wiki_router.update_member(space_id=sid, member_user_id="bob", body=MemberUpdate(role="nope"), user=alice, db=db)
    assert ei.value.status_code == 400
    assert await wiki_service.get_user_role(db, sid, "bob") == "writer"


@pytest.mark.asyncio
async def test_wiki_space_description_can_be_cleared(db_session):
    db = db_session
    alice, _bob, _root = await _users(db)
    sid = await _space(db)
    await wiki_router.update_space(space_id=sid, body=SpaceUpdate(name="새 이름", description="설명"), user=alice, db=db)
    sp = await wiki_service.get_space(db, sid)
    assert (sp.name, sp.description) == ("새 이름", "설명")
    await wiki_router.update_space(space_id=sid, body=SpaceUpdate(description=None), user=alice, db=db)
    await db.refresh(sp)
    assert sp.name == "새 이름" and sp.description is None
    # 이름의 null 은 "안 바꿈"
    await wiki_router.update_space(space_id=sid, body=SpaceUpdate(name=None), user=alice, db=db)
    await db.refresh(sp)
    assert sp.name == "새 이름"
