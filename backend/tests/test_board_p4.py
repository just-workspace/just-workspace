"""게시판 보강 — 목록 is_read · 안 읽은 수 · 모두 읽음 · 댓글 @멘션 해석/알림 · 내가 쓴 글."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.board import router as board_router
from app.board import service
from app.board.schemas import CommentCreate, PostCreate
from app.db.models import Notification, Post, SystemSetting, User


@pytest.fixture(autouse=True)
def _no_realtime(monkeypatch):
    from app.notifications import service as nsvc

    async def _deliver(d, push=True):
        return None

    monkeypatch.setattr(nsvc, "_deliver", _deliver)


async def _seed(db):
    for uid in ("alice", "bob", "carol"):
        db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.title()))
    await db.commit()
    # 읽음 추적 시작 시점을 과거로 설정 — 테스트 글 전체를 추적 대상에 포함
    db.add(SystemSetting(key=service.READ_SINCE_KEY,
                         value=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat()))
    await db.commit()
    b1 = await service.create_board(db, name="공지", slug="notice")
    b2 = await service.create_board(db, name="자유", slug="free")
    return b1["id"], b2["id"]


async def _post(db, board_id, user, title):
    return await board_router.create_post(board_id=board_id, body=PostCreate(title=title, content="본문"),
                                          user=user, db=db)


@pytest.mark.asyncio
async def test_is_read_and_unread_counts(db_session):
    db = db_session
    b1, b2 = await _seed(db)
    alice, bob = await db.get(User, "alice"), await db.get(User, "bob")
    p1 = await _post(db, b1, alice, "첫 공지")
    p2 = await _post(db, b1, alice, "둘째 공지")
    await _post(db, b2, alice, "자유글")
    await _post(db, b2, bob, "내 글")

    counts = await board_router.unread_counts(user=bob, db=db)
    assert counts["counts"] == {b1: 2, b2: 1} and counts["total"] == 3  # 자기 글 제외

    await board_router.get_post(post_id=p1["id"], user=bob, db=db)
    lst = await board_router.list_posts(board_id=b1, page=1, page_size=20, category=None, sort="latest",
                                        mine=False, user=bob, db=db)
    read = {p["id"]: p["is_read"] for p in lst["posts"]}
    assert read == {p1["id"]: True, p2["id"]: False}
    assert (await board_router.unread_counts(user=bob, db=db))["counts"] == {b1: 1, b2: 1}

    # 작성자에게는 본인 글이 읽음 상태
    lst = await board_router.list_posts(board_id=b1, page=1, page_size=20, category=None, sort="latest",
                                        mine=False, user=alice, db=db)
    assert all(p["is_read"] for p in lst["posts"])

    # 모두 읽음
    await board_router.mark_board_read(board_id=b2, user=bob, db=db)
    assert (await board_router.unread_counts(user=bob, db=db))["counts"] == {b1: 1}
    with pytest.raises(HTTPException):
        await board_router.mark_board_read(board_id="nope", user=bob, db=db)


@pytest.mark.asyncio
async def test_posts_before_tracking_start_are_read(db_session):
    db = db_session
    for uid in ("alice", "bob"):
        db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x"))
    await db.commit()
    b = await service.create_board(db, name="공지", slug="notice")
    alice = await db.get(User, "alice")
    old = await _post(db, b["id"], alice, "옛 글")
    row = await db.get(Post, old["id"])
    row.created_at = datetime.now(timezone.utc) - timedelta(days=30)
    await db.commit()
    # 추적 시작 시각이 현재로 설정됨 → 그 이전 글은 읽음 처리
    assert (await service.unread_counts(db, "bob")) == {}
    new = await _post(db, b["id"], alice, "새 글")
    assert (await service.unread_counts(db, "bob")) == {b["id"]: 1}


@pytest.mark.asyncio
async def test_comment_mentions_resolve_and_notify(db_session):
    db = db_session
    b1, _ = await _seed(db)
    alice, bob = await db.get(User, "alice"), await db.get(User, "bob")
    p = await _post(db, b1, alice, "회의록")
    c = await board_router.create_comment(
        post_id=p["id"], body=CommentCreate(content="@bob @carol 확인 부탁, @nobody 와 @alice(나)"),
        user=alice, db=db,
    )
    assert [m["username"] for m in c["mentions"]] == ["bob", "carol"]
    notes = (await db.execute(select(Notification).order_by(Notification.user_id))).scalars().all()
    assert [(n.user_id, n.type) for n in notes] == [("bob", "mention"), ("carol", "mention")]
    assert notes[0].link == f"/board/{b1}/{p['id']}#comment-{c['id']}"
    lst = await board_router.list_comments(post_id=p["id"], user=bob, db=db)
    assert [m["username"] for m in lst[0]["mentions"]] == ["bob", "carol"]
    # 이메일 주소 내의 @ 는 멘션이 아님
    c2 = await board_router.create_comment(
        post_id=p["id"], body=CommentCreate(content="메일은 bob@x 로"), user=alice, db=db,
    )
    assert c2["mentions"] == []


@pytest.mark.asyncio
async def test_mine_filter_and_my_posts(db_session):
    db = db_session
    b1, b2 = await _seed(db)
    alice, bob = await db.get(User, "alice"), await db.get(User, "bob")
    await _post(db, b1, alice, "a1")
    mine1 = await _post(db, b1, bob, "b1")
    mine2 = await _post(db, b2, bob, "b2")
    lst = await board_router.list_posts(board_id=b1, page=1, page_size=20, category=None, sort="latest",
                                        mine=True, user=bob, db=db)
    assert [p["id"] for p in lst["posts"]] == [mine1["id"]] and lst["total"] == 1
    my = await board_router.my_posts(page=1, page_size=20, user=bob, db=db)
    assert [p["id"] for p in my["posts"]] == [mine2["id"], mine1["id"]] and my["total"] == 2
    # 타 사용자의 글은 포함되지 않음
    my = await board_router.my_posts(page=1, page_size=20, user=alice, db=db)
    assert [p["title"] for p in my["posts"]] == ["a1"]


@pytest.mark.asyncio
async def test_mention_user_search(db_session):
    db = db_session
    await _seed(db)
    bob = await db.get(User, "bob")
    res = await board_router.mention_users(q="car", limit=10, user=bob, db=db)
    assert [u["username"] for u in res] == ["carol"]


@pytest.mark.asyncio
async def test_boards_with_posts_has_is_read(db_session):
    """인덱스 카드(boards-with-posts)도 목록과 동일한 규칙으로 is_read 를 부여한다."""
    db = db_session
    b1, b2 = await _seed(db)
    alice, bob = await db.get(User, "alice"), await db.get(User, "bob")
    p1 = await _post(db, b1, alice, "공지 하나")
    p2 = await _post(db, b1, alice, "공지 둘")
    p3 = await _post(db, b2, bob, "내가 쓴 자유글")
    await board_router.get_post(post_id=p1["id"], user=bob, db=db)

    out = await board_router.boards_with_recent_posts(limit_per_board=5, user=bob, db=db)
    read = {p["id"]: p["is_read"] for b in out for p in b["recent_posts"]}
    assert read == {p1["id"]: True, p2["id"]: False, p3["id"]: True}

    await board_router.mark_board_read(board_id=b1, user=bob, db=db)
    out = await board_router.boards_with_recent_posts(limit_per_board=5, user=bob, db=db)
    assert all(p["is_read"] for b in out for p in b["recent_posts"])
