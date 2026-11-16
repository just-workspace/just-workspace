"""Board business logic — board/post/comment/reaction/bookmark/must-read CRUD."""

import json
import re
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import and_, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Board,
    Post,
    PostBookmark,
    PostComment,
    PostReaction,
    PostReadLog,
    User,
)


# ─── Board ───

async def get_boards(db: AsyncSession) -> list[dict]:
    rows = (
        await db.execute(
            select(Board).order_by(Board.sort_order, Board.created_at)
        )
    ).scalars().all()
    return [_board_to_dict(b) for b in rows]


async def get_board(db: AsyncSession, board_id: str) -> Board | None:
    return await db.get(Board, board_id)


async def get_board_by_slug(db: AsyncSession, slug: str) -> Board | None:
    row = (
        await db.execute(select(Board).where(Board.slug == slug))
    ).scalar_one_or_none()
    return row


async def create_board(db: AsyncSession, **kwargs) -> dict:
    if "categories" in kwargs and kwargs["categories"] is not None:
        kwargs["categories"] = json.dumps(kwargs["categories"], ensure_ascii=False)
    board = Board(id=str(uuid.uuid4()), **kwargs)
    db.add(board)
    await db.commit()
    await db.refresh(board)
    return _board_to_dict(board)


async def update_board(db: AsyncSession, board_id: str, **kwargs) -> dict | None:
    board = await db.get(Board, board_id)
    if not board:
        return None
    if "categories" in kwargs and kwargs["categories"] is not None:
        kwargs["categories"] = json.dumps(kwargs["categories"], ensure_ascii=False)
    for k, v in kwargs.items():
        if v is not None:
            setattr(board, k, v)
    board.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(board)
    return _board_to_dict(board)


async def delete_board(db: AsyncSession, board_id: str) -> bool:
    board = await db.get(Board, board_id)
    if not board:
        return False
    await db.delete(board)
    await db.commit()
    return True


# ─── Post ───

async def get_posts(
    db: AsyncSession,
    board_id: str,
    page: int = 1,
    page_size: int = 20,
    category: str | None = None,
    sort: str = "latest",
    user_id: str | None = None,
    mine: bool = False,
) -> dict:
    """Return {pinned: [...], posts: [...], total, page, page_size}.

    user_id 를 지정하면 각 글에 is_read 를 포함한다. mine=True 이면 해당 사용자가 작성한 글만 반환한다.

    Optimised: JOINs author in the same query to avoid separate author-fetch queries.
    """
    base_cond = [
        Post.board_id == board_id,
        Post.is_deleted == False,  # noqa: E712
    ]
    if category:
        base_cond.append(Post.category == category)
    if mine and user_id:
        base_cond.append(Post.author_id == user_id)

    # Count total (non-pinned)
    count_q = select(func.count(Post.id)).where(
        Post.board_id == board_id,
        Post.is_deleted == False,  # noqa: E712
        Post.is_pinned == False,  # noqa: E712
    )
    if category:
        count_q = count_q.where(Post.category == category)
    if mine and user_id:
        count_q = count_q.where(Post.author_id == user_id)
    total = (await db.execute(count_q)).scalar() or 0

    # Pinned posts with author JOIN (always returned, no pagination)
    pinned_q = (
        select(Post, User)
        .outerjoin(User, Post.author_id == User.id)
        .where(*base_cond, Post.is_pinned == True)  # noqa: E712
        .order_by(Post.created_at.desc())
    )
    pinned_rows = (await db.execute(pinned_q)).all()

    # Normal posts with pagination and author JOIN
    if sort == "views":
        order = Post.view_count.desc()
    elif sort == "comments":
        order = Post.comment_count.desc()
    else:
        order = Post.created_at.desc()

    offset = (page - 1) * page_size
    posts_q = (
        select(Post, User)
        .outerjoin(User, Post.author_id == User.id)
        .where(*base_cond, Post.is_pinned == False)  # noqa: E712
        .order_by(order, Post.created_at.desc(), Post.id.desc())   # 동점(조회수 등) 페이지 경계 안정
        .offset(offset)
        .limit(page_size)
    )
    post_rows = (await db.execute(posts_q)).all()

    pinned = [_post_to_summary(p, u) for p, u in pinned_rows]
    posts = [_post_to_summary(p, u) for p, u in post_rows]
    if user_id:
        read = await read_post_ids(db, user_id, [p for p, _ in pinned_rows] + [p for p, _ in post_rows])
        for d in pinned + posts:
            d["is_read"] = d["id"] in read

    return {
        "pinned": pinned,
        "posts": posts,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


async def get_post(
    db: AsyncSession,
    post_id: str,
    user_id: str | None = None,
) -> dict | None:
    """Get post detail with reactions and bookmark status. Increments view count."""
    post = await db.get(Post, post_id)
    if not post or post.is_deleted:
        return None

    # Increment view count
    post.view_count += 1
    await db.commit()
    await db.refresh(post)

    author = await db.get(User, post.author_id) if post.author_id else None

    # Get reactions
    reactions = await _get_post_reactions(db, post_id)

    # Check bookmark
    is_bookmarked = False
    if user_id:
        bm = (
            await db.execute(
                select(PostBookmark.id).where(
                    PostBookmark.post_id == post_id,
                    PostBookmark.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        is_bookmarked = bm is not None

    # 읽음 기록 — 필독뿐 아니라 모든 글 대상(목록 is_read·읽지 않은 글 수에 사용)
    if user_id:
        existing_read = (
            await db.execute(
                select(PostReadLog.id).where(
                    PostReadLog.post_id == post_id,
                    PostReadLog.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if not existing_read:
            db.add(PostReadLog(
                id=str(uuid.uuid4()),
                post_id=post_id,
                user_id=user_id,
            ))
            await db.commit()

    return _post_to_detail(post, author, reactions, is_bookmarked)


async def create_post(db: AsyncSession, **kwargs) -> dict:
    if "attachments" in kwargs and kwargs["attachments"] is not None:
        kwargs["attachments"] = json.dumps(kwargs["attachments"], ensure_ascii=False)
    post = Post(id=str(uuid.uuid4()), **kwargs)
    db.add(post)
    await db.commit()
    await db.refresh(post)
    author = await db.get(User, post.author_id) if post.author_id else None
    return _post_to_detail(post, author, [], False)


# 수정 시 null 로 비울 수 있는 필드(나머지 필드의 null 은 "안 바꿈")
NULLABLE_POST_FIELDS = frozenset({"category", "attachments", "must_read_expires_at"})


async def update_post(db: AsyncSession, post_id: str, **kwargs) -> dict | None:
    post = await db.get(Post, post_id)
    if not post or post.is_deleted:
        return None
    if "attachments" in kwargs:
        # 빈 목록·null 은 "첨부 없음"
        kwargs["attachments"] = json.dumps(kwargs["attachments"], ensure_ascii=False) if kwargs["attachments"] else None
    if "category" in kwargs and not kwargs["category"]:
        kwargs["category"] = None
    for k, v in kwargs.items():
        if v is not None or k in NULLABLE_POST_FIELDS:
            setattr(post, k, v)
    post.is_edited = True
    post.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(post)
    author = await db.get(User, post.author_id) if post.author_id else None
    return _post_to_detail(post, author, [], False)


async def soft_delete_post(db: AsyncSession, post_id: str) -> bool:
    post = await db.get(Post, post_id)
    if not post:
        return False
    post.is_deleted = True
    post.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return True


async def search_posts(
    db: AsyncSession,
    query: str,
    board_id: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    """Search posts by title/content with author and board info JOINed."""
    escaped = query.replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"

    text_cond = (
        Post.title.ilike(pattern, escape="\\")
        | Post.content.ilike(pattern, escape="\\")
    )

    base_conds = [Post.is_deleted == False, text_cond]  # noqa: E712
    if board_id:
        base_conds.append(Post.board_id == board_id)

    count_q = select(func.count(Post.id)).where(*base_conds)
    total = (await db.execute(count_q)).scalar() or 0

    offset = (page - 1) * page_size
    rows = (
        await db.execute(
            select(Post, User, Board.name.label("board_name"))
            .outerjoin(User, Post.author_id == User.id)
            .join(Board, Post.board_id == Board.id)
            .where(*base_conds)
            .order_by(Post.created_at.desc(), Post.id.desc())
            .offset(offset)
            .limit(page_size)
        )
    ).all()

    return {
        "posts": [
            {
                **_post_to_summary(p, u),
                "board_name": bn or "",
            }
            for p, u, bn in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


# ─── Dashboard ───

async def get_recent_posts(db: AsyncSession, limit: int = 10) -> list[dict]:
    """Get recent posts across all boards for dashboard.
    JOINs author in the same query to avoid a separate batch fetch.
    """
    rows = (
        await db.execute(
            select(Post, User, Board.name.label("board_name"))
            .outerjoin(User, Post.author_id == User.id)
            .join(Board, Post.board_id == Board.id)
            .where(Post.is_deleted == False)  # noqa: E712
            .order_by(Post.created_at.desc())
            .limit(limit)
        )
    ).all()

    return [
        {**_post_to_summary(p, u), "board_name": bn}
        for p, u, bn in rows
    ]


async def get_notice_posts(db: AsyncSession, limit: int = 5) -> list[dict]:
    """Get pinned/notice posts across all boards for dashboard.
    JOINs author in the same query to avoid a separate batch fetch.
    """
    rows = (
        await db.execute(
            select(Post, User, Board.name.label("board_name"))
            .outerjoin(User, Post.author_id == User.id)
            .join(Board, Post.board_id == Board.id)
            .where(
                Post.is_deleted == False,  # noqa: E712
                Post.is_pinned == True,  # noqa: E712
            )
            .order_by(Post.created_at.desc())
            .limit(limit)
        )
    ).all()

    return [
        {**_post_to_summary(p, u), "board_name": bn}
        for p, u, bn in rows
    ]


def _with_read(d: dict, read: set[str] | None) -> dict:
    if read is not None:
        d["is_read"] = d["id"] in read
    return d


async def get_recent_posts_by_board(db: AsyncSession, limit_per_board: int = 5,
                                    user_id: str | None = None) -> list[dict]:
    """Get recent posts grouped by board for the board index page.

    Uses a window function (ROW_NUMBER) to fetch the top N posts per board
    in a single query instead of looping per board (avoids N+1).
    Total: 2 queries (boards + ranked posts with authors) instead of 1+2N.
    """
    # Query 1: all boards
    boards_list = (
        await db.execute(select(Board).order_by(Board.sort_order, Board.created_at))
    ).scalars().all()

    # Query 2: ranked post IDs via window function subquery,
    # then join back to Post (ORM entity) and User for clean access.
    row_num = (
        func.row_number()
        .over(partition_by=Post.board_id, order_by=Post.created_at.desc())
        .label("rn")
    )
    ranked_sq = (
        select(Post.id.label("post_id"), Post.board_id.label("ranked_board_id"), row_num)
        .where(Post.is_deleted == False)  # noqa: E712
        .subquery()
    )
    rows = (
        await db.execute(
            select(Post, User)
            .join(ranked_sq, Post.id == ranked_sq.c.post_id)
            .outerjoin(User, Post.author_id == User.id)
            .where(ranked_sq.c.rn <= limit_per_board)
            .order_by(ranked_sq.c.ranked_board_id, ranked_sq.c.rn)
        )
    ).all()

    # Group by board_id in Python
    posts_by_board: dict[str, list[tuple]] = defaultdict(list)
    for post, user in rows:
        posts_by_board[post.board_id].append((post, user))

    # user_id 를 지정하면 각 글에 is_read 포함(목록과 동일 규칙: 열람한 글·본인 글·"모두 읽음" 이전 글은 읽음)
    read = await read_post_ids(db, user_id, [p for p, _ in rows]) if user_id else None

    # Build result keeping original board order
    result = []
    for board in boards_list:
        board_posts = posts_by_board.get(board.id, [])
        result.append({
            **_board_to_dict(board),
            "recent_posts": [_with_read(_post_to_summary(p, u), read) for p, u in board_posts],
        })

    return result


# ─── Comments ───

async def get_comments(db: AsyncSession, post_id: str) -> list[dict]:
    """Get comments with 2-level nesting. Deleted comments show as placeholder."""
    rows = (
        await db.execute(
            select(PostComment, User)
            .outerjoin(User, PostComment.author_id == User.id)
            .where(PostComment.post_id == post_id)
            .order_by(PostComment.created_at.asc())
        )
    ).all()

    # Build tree: parent_id → children
    comment_map: dict[str, dict] = {}
    children_map: dict[str, list[dict]] = defaultdict(list)

    for comment, user in rows:
        d = _comment_to_dict(comment, user)
        comment_map[comment.id] = d
        if comment.parent_id:
            children_map[comment.parent_id].append(d)

    # Build result: top-level comments with nested replies
    result = []
    for comment, user in rows:
        if comment.parent_id is None:
            d = comment_map[comment.id]
            d["replies"] = children_map.get(comment.id, [])
            result.append(d)

    return result


async def create_comment(
    db: AsyncSession,
    post_id: str,
    author_id: str,
    content: str,
    parent_id: str | None = None,
    attachments: str | None = None,
    mentions: str | None = None,
) -> dict:
    # Validate 2-level nesting
    if parent_id:
        parent = await db.get(PostComment, parent_id)
        if not parent:
            raise ValueError("부모 댓글을 찾을 수 없습니다")
        # 다른 글의 댓글을 부모로 지정하면 댓글 수만 증가하고 어디에도 표시되지 않는 댓글이 생성됨
        if parent.post_id != post_id:
            raise ValueError("부모 댓글을 찾을 수 없습니다")
        if parent.parent_id is not None:
            raise ValueError("대댓글에는 답글을 달 수 없습니다")

    comment = PostComment(
        id=str(uuid.uuid4()),
        post_id=post_id,
        author_id=author_id,
        parent_id=parent_id,
        content=content,
        attachments=attachments,
        mentions=mentions,
    )
    db.add(comment)

    # Increment comment_count
    await db.execute(
        update(Post)
        .where(Post.id == post_id)
        .values(comment_count=Post.comment_count + 1)
    )

    await db.commit()
    await db.refresh(comment)
    author = await db.get(User, author_id)
    return _comment_to_dict(comment, author)


async def update_comment(
    db: AsyncSession, comment_id: str, content: str
) -> dict | None:
    comment = await db.get(PostComment, comment_id)
    if not comment or comment.is_deleted:
        return None
    comment.content = content
    comment.is_edited = True
    comment.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(comment)
    author = await db.get(User, comment.author_id)
    return _comment_to_dict(comment, author)


async def soft_delete_comment(db: AsyncSession, comment_id: str) -> bool:
    comment = await db.get(PostComment, comment_id)
    if not comment:
        return False
    comment.is_deleted = True
    comment.content = ""
    comment.updated_at = datetime.now(timezone.utc)

    # Decrement comment_count
    await db.execute(
        update(Post)
        .where(Post.id == comment.post_id)
        .values(comment_count=func.greatest(Post.comment_count - 1, 0))
    )

    await db.commit()
    return True


# ─── Reactions ───

async def toggle_post_reaction(
    db: AsyncSession, post_id: str, user_id: str, emoji: str
) -> dict:
    existing = (
        await db.execute(
            select(PostReaction).where(
                PostReaction.post_id == post_id,
                PostReaction.user_id == user_id,
                PostReaction.emoji == emoji,
            )
        )
    ).scalar_one_or_none()

    if existing:
        await db.delete(existing)
        await db.commit()
        action = "removed"
    else:
        db.add(PostReaction(
            id=str(uuid.uuid4()),
            post_id=post_id,
            user_id=user_id,
            emoji=emoji,
        ))
        await db.commit()
        action = "added"

    reactions = await _get_post_reactions(db, post_id)
    return {
        "action": action,
        "post_id": post_id,
        "reactions": reactions,
    }


async def _get_post_reactions(
    db: AsyncSession, post_id: str
) -> list[dict]:
    rows = (
        await db.execute(
            select(PostReaction.emoji, PostReaction.user_id)
            .where(PostReaction.post_id == post_id)
            .order_by(PostReaction.emoji)
        )
    ).all()

    emoji_map: dict[str, list[str]] = defaultdict(list)
    for emoji, uid in rows:
        emoji_map[emoji].append(uid)

    return [
        {"emoji": emoji, "count": len(uids), "user_ids": uids}
        for emoji, uids in emoji_map.items()
    ]


# ─── Bookmarks ───

async def toggle_bookmark(
    db: AsyncSession, post_id: str, user_id: str
) -> dict:
    existing = (
        await db.execute(
            select(PostBookmark).where(
                PostBookmark.post_id == post_id,
                PostBookmark.user_id == user_id,
            )
        )
    ).scalar_one_or_none()

    if existing:
        await db.delete(existing)
        await db.commit()
        return {"action": "removed", "is_bookmarked": False}
    else:
        db.add(PostBookmark(
            id=str(uuid.uuid4()),
            post_id=post_id,
            user_id=user_id,
        ))
        await db.commit()
        return {"action": "added", "is_bookmarked": True}


async def get_user_bookmarks(
    db: AsyncSession, user_id: str, page: int = 1, page_size: int = 20
) -> dict:
    """Get bookmarked posts with author JOINed to avoid separate fetch."""
    # 삭제된 글은 목록에서 제외되므로 개수에서도 제외(페이지 수 불일치 방지)
    count_q = select(func.count(PostBookmark.id)).join(Post, Post.id == PostBookmark.post_id).where(
        PostBookmark.user_id == user_id,
        Post.is_deleted == False,  # noqa: E712
    )
    total = (await db.execute(count_q)).scalar() or 0

    offset = (page - 1) * page_size
    rows = (
        await db.execute(
            select(Post, User)
            .outerjoin(User, Post.author_id == User.id)
            .join(PostBookmark, Post.id == PostBookmark.post_id)
            .where(
                PostBookmark.user_id == user_id,
                Post.is_deleted == False,  # noqa: E712
            )
            .order_by(PostBookmark.created_at.desc())
            .offset(offset)
            .limit(page_size)
        )
    ).all()

    return {
        "posts": [_post_to_summary(p, u) for p, u in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


# ─── Must Read ───

async def get_must_read_posts(db: AsyncSession, user_id: str) -> list[dict]:
    """Get must-read posts the user hasn't read yet.
    JOINs author in the same query to avoid a separate batch fetch.
    """
    now = datetime.now(timezone.utc)

    # Subquery: posts user has already read
    read_sq = select(PostReadLog.post_id).where(
        PostReadLog.user_id == user_id
    ).subquery()

    rows = (
        await db.execute(
            select(Post, User)
            .outerjoin(User, Post.author_id == User.id)
            .where(
                Post.is_must_read == True,  # noqa: E712
                Post.is_deleted == False,  # noqa: E712
                Post.id.notin_(select(read_sq.c.post_id)),
                (Post.must_read_expires_at == None) | (Post.must_read_expires_at > now),  # noqa: E711
            )
            .order_by(Post.created_at.desc())
        )
    ).all()

    return [_post_to_summary(p, u) for p, u in rows]


# ─── Helpers ───

def _board_to_dict(board: Board) -> dict:
    categories = []
    if board.categories:
        try:
            categories = json.loads(board.categories)
        except (json.JSONDecodeError, TypeError):
            pass
    return {
        "id": board.id,
        "name": board.name,
        "slug": board.slug,
        "description": board.description,
        "categories": categories,
        "sort_order": board.sort_order,
        "write_permission": board.write_permission,
        "notice_permission": board.notice_permission,
        "comment_permission": board.comment_permission,
        "allow_comments": board.allow_comments,
        "allow_reactions": board.allow_reactions,
        "created_at": board.created_at.isoformat(),
        "updated_at": board.updated_at.isoformat(),
    }


def _author_info(user: User | None) -> dict | None:
    if not user:
        return None
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
    }


_IMG_HTML_RE = re.compile(r"""<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
_IMG_MD_RE = re.compile(r"!\[[^\]]*\]\(\s*<?([^)\s>]+)")


def _safe_thumb(url: str | None) -> str | None:
    """목록 썸네일로 반환할 수 있는 주소만 허용 — 동일 출처 경로(/...) 또는 http(s). data:·javascript: 등은 제외."""
    u = (url or "").strip()
    if not u or len(u) > 2048:
        return None
    low = u.lower()
    if low.startswith(("http://", "https://")) or (u.startswith("/") and not u.startswith("//")):
        return u
    return None


def post_thumbnail_url(content: str | None, attachments: list | None) -> str | None:
    """포럼 갤러리(chat22)용 — 본문 첫 이미지(HTML <img> 또는 마크다운 ![]()), 없으면 첫 이미지 첨부. 없으면 None.

    본문 문자열만 검사한다(조회수·읽음 표시를 변경하지 않는다).
    """
    text = content or ""
    hits = [m for m in (_IMG_HTML_RE.search(text), _IMG_MD_RE.search(text)) if m]
    for m in sorted(hits, key=lambda m: m.start()):
        u = _safe_thumb(m.group(1))
        if u:
            return u
    for a in attachments or []:
        if not isinstance(a, dict):
            continue
        mime = str(a.get("mime_type") or a.get("content_type") or a.get("type") or "").lower()
        if mime.startswith("image/"):
            u = _safe_thumb(a.get("url"))
            if u:
                return u
    return None


def _post_to_summary(post: Post, author: User | None) -> dict:
    attachments = []
    if post.attachments:
        try:
            attachments = json.loads(post.attachments)
        except (json.JSONDecodeError, TypeError):
            pass
    return {
        "id": post.id,
        "board_id": post.board_id,
        "author": _author_info(author),
        "title": post.title,
        "category": post.category,
        "is_pinned": post.is_pinned,
        "is_must_read": post.is_must_read,
        "view_count": post.view_count,
        "comment_count": post.comment_count,
        "has_attachments": len(attachments) > 0,
        "thumbnail_url": post_thumbnail_url(post.content, attachments if isinstance(attachments, list) else None),
        "is_edited": post.is_edited,
        "created_at": post.created_at.isoformat(),
        "updated_at": post.updated_at.isoformat(),
    }


def _post_to_detail(
    post: Post,
    author: User | None,
    reactions: list[dict],
    is_bookmarked: bool,
) -> dict:
    attachments = []
    if post.attachments:
        try:
            attachments = json.loads(post.attachments)
        except (json.JSONDecodeError, TypeError):
            pass
    return {
        "id": post.id,
        "board_id": post.board_id,
        "author": _author_info(author),
        "title": post.title,
        "content": post.content,
        "category": post.category,
        "is_pinned": post.is_pinned,
        "is_must_read": post.is_must_read,
        "must_read_expires_at": post.must_read_expires_at.isoformat() if post.must_read_expires_at else None,
        "view_count": post.view_count,
        "comment_count": post.comment_count,
        "attachments": attachments,
        "reactions": reactions,
        "is_bookmarked": is_bookmarked,
        "is_edited": post.is_edited,
        "created_at": post.created_at.isoformat(),
        "updated_at": post.updated_at.isoformat(),
    }


def _comment_to_dict(comment: PostComment, author: User | None) -> dict:
    if comment.is_deleted:
        return {
            "id": comment.id,
            "post_id": comment.post_id,
            "author": None,
            "parent_id": comment.parent_id,
            "content": "[삭제된 댓글입니다]",
            "attachments": [],
            "is_edited": False,
            "is_deleted": True,
            "created_at": comment.created_at.isoformat(),
            "updated_at": comment.updated_at.isoformat(),
        }

    attachments = []
    if comment.attachments:
        try:
            attachments = json.loads(comment.attachments)
        except (json.JSONDecodeError, TypeError):
            pass
    mentions = []
    if getattr(comment, "mentions", None):
        try:
            mentions = json.loads(comment.mentions)
        except (json.JSONDecodeError, TypeError):
            pass
    return {
        "id": comment.id,
        "post_id": comment.post_id,
        "author": _author_info(author),
        "parent_id": comment.parent_id,
        "content": comment.content,
        "attachments": attachments,
        "mentions": mentions,
        "is_edited": comment.is_edited,
        "is_deleted": False,
        "created_at": comment.created_at.isoformat(),
        "updated_at": comment.updated_at.isoformat(),
    }


# ─── 읽음 · 안 읽은 수 · 멘션 ───
#
# 읽음 = (글 열람 기록 PostReadLog) 또는 (본인 작성 글) 또는 (기준 시각 이전 글).
# 기준 시각 = max(읽음 추적 시작 시각, 해당 게시판 "모두 읽음" 시각).
# 읽음 추적 시작 시각(system_settings 'board.read_tracking_since')은 최초 사용 시 1회 결정된다 —
# 기능 도입 이전 글이 전부 "안 읽음"으로 표시되는 것을 방지한다.

READ_SINCE_KEY = "board.read_tracking_since"


async def read_tracking_since(db: AsyncSession) -> datetime:
    from app.db.models import SystemSetting
    row = await db.get(SystemSetting, READ_SINCE_KEY)
    if row is not None:
        try:
            v = datetime.fromisoformat(row.value)
            return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    now = datetime.now(timezone.utc)
    try:
        db.add(SystemSetting(key=READ_SINCE_KEY, value=now.isoformat()))
        await db.commit()
    except Exception:
        await db.rollback()
        row = await db.get(SystemSetting, READ_SINCE_KEY)
        if row is not None:
            v = datetime.fromisoformat(row.value)
            return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    return now


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def _marks(db: AsyncSession, user_id: str) -> dict[str, datetime]:
    from app.db.models import BoardReadMark
    rows = (await db.execute(
        select(BoardReadMark.board_id, BoardReadMark.read_before).where(BoardReadMark.user_id == user_id)
    )).all()
    return {b: _aware(t) for b, t in rows}


async def read_post_ids(db: AsyncSession, user_id: str, posts: list[Post]) -> set[str]:
    if not posts:
        return set()
    since = await read_tracking_since(db)
    marks = await _marks(db, user_id)
    logged = set((await db.execute(
        select(PostReadLog.post_id).where(
            PostReadLog.user_id == user_id, PostReadLog.post_id.in_([p.id for p in posts])
        )
    )).scalars().all())
    out = set()
    for p in posts:
        cutoff = max(since, marks.get(p.board_id) or since)
        if p.id in logged or p.author_id == user_id or (_aware(p.created_at) or since) <= cutoff:
            out.add(p.id)
    return out


async def unread_counts(db: AsyncSession, user_id: str) -> dict[str, int]:
    """{board_id: 읽지 않은 글 수} — 전체 게시판을 일괄 조회(그룹 쿼리 1회)."""
    from app.db.models import BoardReadMark
    since = await read_tracking_since(db)
    q = (
        select(Post.board_id, func.count(Post.id))
        .outerjoin(PostReadLog, and_(PostReadLog.post_id == Post.id, PostReadLog.user_id == user_id))
        .outerjoin(BoardReadMark, and_(BoardReadMark.board_id == Post.board_id, BoardReadMark.user_id == user_id))
        .where(
            Post.is_deleted == False,  # noqa: E712
            PostReadLog.id.is_(None),
            Post.author_id != user_id,
            Post.created_at > since,
            (BoardReadMark.id.is_(None)) | (Post.created_at > BoardReadMark.read_before),
        )
        .group_by(Post.board_id)
    )
    return {b: int(c) for b, c in (await db.execute(q)).all()}


async def mark_board_read(db: AsyncSession, user_id: str, board_id: str) -> None:
    from app.db.models import BoardReadMark
    now = datetime.now(timezone.utc)
    row = (await db.execute(
        select(BoardReadMark).where(BoardReadMark.user_id == user_id, BoardReadMark.board_id == board_id)
    )).scalar_one_or_none()
    if row:
        row.read_before = now
    else:
        db.add(BoardReadMark(user_id=user_id, board_id=board_id, read_before=now))
    await db.commit()


async def get_my_posts(db: AsyncSession, user_id: str, page: int = 1, page_size: int = 20) -> dict:
    """전체 게시판에서 본인이 작성한 글(최신순)."""
    cond = [Post.author_id == user_id, Post.is_deleted == False]  # noqa: E712
    total = (await db.execute(select(func.count(Post.id)).where(*cond))).scalar() or 0
    rows = (await db.execute(
        select(Post, User).outerjoin(User, Post.author_id == User.id)
        .where(*cond).order_by(Post.created_at.desc())
        .offset((page - 1) * page_size).limit(page_size)
    )).all()
    return {"posts": [{**_post_to_summary(p, u), "is_read": True} for p, u in rows],
            "total": total, "page": page, "page_size": page_size}


_MENTION_RE = re.compile(r"(?:^|(?<=\s))@([\w.\-]+)")


def parse_comment_mentions(content: str) -> list[str]:
    return list(dict.fromkeys(m.rstrip(".-") for m in _MENTION_RE.findall(content or "")))


async def resolve_mentions(db: AsyncSession, content: str, exclude_user_id: str | None = None) -> list[dict]:
    """본문의 @username 을 활성 사용자로 해석(본인 제외). 존재하지 않는 이름은 제외."""
    names = parse_comment_mentions(content)[:20]
    if not names:
        return []
    rows = (await db.execute(
        select(User).where(User.username.in_(names), User.is_active == True)  # noqa: E712
    )).scalars().all()
    by = {u.username: u for u in rows}
    out = []
    for n in names:
        u = by.get(n)
        if u and u.id != exclude_user_id:
            out.append({"id": u.id, "username": u.username, "display_name": u.display_name})
    return out


async def notify_comment_mentions(db: AsyncSession, post: Post, comment: dict, author: User,
                                  mentions: list[dict]) -> None:
    """멘션 대상자에게 알림 — 기존 notifications 서비스 함수만 호출한다."""
    from app.notifications.service import create_notification
    name = author.display_name or author.username
    for m in mentions:
        try:
            await create_notification(
                db, m["id"], "mention",
                f"{name}님이 댓글에서 회원님을 멘션했습니다",
                f"{post.title}: {(comment.get('content') or '')[:150]}",
                link=f"/board/{post.board_id}/{post.id}#comment-{comment['id']}",
            )
        except Exception:
            pass
