"""Board REST API endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.board import service
from app.board.schemas import (
    BoardCreate,
    BoardUpdate,
    CommentCreate,
    CommentUpdate,
    PostCreate,
    PostUpdate,
    ReactionToggle,
)
from app.modules.registry import require_module

router = APIRouter(prefix="/api/board", tags=["board"])


# ─── Boards ───

@router.get("/boards")
@require_module("board")
async def list_boards(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.get_boards(db)


@router.post("/boards", status_code=201)
@require_module("board")
async def create_board(
    body: BoardCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not user.is_admin:
        raise HTTPException(403, "관리자만 게시판을 생성할 수 있습니다")
    # Check slug uniqueness
    existing = await service.get_board_by_slug(db, body.slug)
    if existing:
        raise HTTPException(400, "이미 사용 중인 슬러그입니다")
    return await service.create_board(
        db, **body.model_dump()
    )


@router.patch("/boards/{board_id}")
@require_module("board")
async def update_board(
    board_id: str,
    body: BoardUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not user.is_admin:
        raise HTTPException(403, "관리자만 게시판을 수정할 수 있습니다")
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "변경할 내용이 없습니다")
    result = await service.update_board(db, board_id, **updates)
    if not result:
        raise HTTPException(404, "게시판을 찾을 수 없습니다")
    return result


@router.delete("/boards/{board_id}")
@require_module("board")
async def delete_board(
    board_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not user.is_admin:
        raise HTTPException(403, "관리자만 게시판을 삭제할 수 있습니다")
    ok = await service.delete_board(db, board_id)
    if not ok:
        raise HTTPException(404, "게시판을 찾을 수 없습니다")
    return {"ok": True}


# ─── Posts ───

@router.get("/boards/{board_id}/posts")
@require_module("board")
async def list_posts(
    board_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    category: str | None = Query(None),
    sort: str = Query("latest", pattern=r"^(latest|views|comments)$"),
    mine: bool = Query(False, description="내가 쓴 글만"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    board = await service.get_board(db, board_id)
    if not board:
        raise HTTPException(404, "게시판을 찾을 수 없습니다")
    return await service.get_posts(
        db, board_id, page=page, page_size=page_size,
        category=category, sort=sort, user_id=user.id, mine=mine,
    )


@router.get("/unread-counts")
@require_module("board")
async def unread_counts(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """게시판별 읽지 않은 글 수 {counts: {board_id: n}, total}. 본인 작성 글·열람한 글·"모두 읽음" 이전 글 제외."""
    counts = await service.unread_counts(db, user.id)
    return {"counts": counts, "total": sum(counts.values())}


@router.post("/boards/{board_id}/read-all")
@require_module("board")
async def mark_board_read(
    board_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """해당 게시판의 글을 전부 읽음 처리."""
    if not await service.get_board(db, board_id):
        raise HTTPException(404, "게시판을 찾을 수 없습니다")
    await service.mark_board_read(db, user.id, board_id)
    return {"ok": True}


@router.get("/my-posts")
@require_module("board")
async def my_posts(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """전체 게시판에서 본인이 작성한 글."""
    return await service.get_my_posts(db, user.id, page, page_size)


@router.get("/mention-users")
@require_module("board")
async def mention_users(
    q: str = Query("", max_length=100),
    limit: int = Query(10, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """댓글 @멘션 자동완성 — 채팅 사용자 검색(app/chat/service.search_users)을 그대로 사용한다."""
    from app.chat.service import search_users
    return await search_users(db, q.strip() or None, limit=limit)


@router.post("/boards/{board_id}/posts", status_code=201)
@require_module("board")
async def create_post(
    board_id: str,
    body: PostCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    board = await service.get_board(db, board_id)
    if not board:
        raise HTTPException(404, "게시판을 찾을 수 없습니다")
    # Check write permission
    if board.write_permission == "admin" and not user.is_admin:
        raise HTTPException(403, "이 게시판에 글을 작성할 권한이 없습니다")
    # Check notice/pinned permission
    if (body.is_pinned or body.is_must_read):
        if board.notice_permission == "admin" and not user.is_admin:
            raise HTTPException(403, "공지/필독 설정은 관리자만 가능합니다")
    return await service.create_post(
        db,
        board_id=board_id,
        author_id=user.id,
        **body.model_dump(),
    )


@router.get("/posts/{post_id}")
@require_module("board")
async def get_post(
    post_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await service.get_post(db, post_id, user_id=user.id)
    if not result:
        raise HTTPException(404, "게시글을 찾을 수 없습니다")
    return result


@router.patch("/posts/{post_id}")
@require_module("board")
async def update_post(
    post_id: str,
    body: PostUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import Post as PostModel
    post = await db.get(PostModel, post_id)
    if not post or post.is_deleted:
        raise HTTPException(404, "게시글을 찾을 수 없습니다")
    if post.author_id != user.id and not user.is_admin:
        raise HTTPException(403, "수정 권한이 없습니다")
    # Check notice/pinned permission — 값이 실제로 변경되는 경우에만 검사한다.
    # (편집 화면은 고정·필독 값을 항상 함께 전송한다 — 전송 여부만으로 차단하면 일반 사용자가 본인 글을 수정할 수 없다)
    pin_changed = body.is_pinned is not None and body.is_pinned != post.is_pinned
    must_changed = body.is_must_read is not None and body.is_must_read != post.is_must_read
    # 필독 만료일에도 동일 권한 적용 — 일반 작성자가 본인 필독 글의 만료를 삭제하여 무기한으로 변경하는 것을 방지
    exp_changed = False
    if "must_read_expires_at" in body.model_fields_set:
        _norm = lambda d: d.replace(tzinfo=None, microsecond=0) if d is not None and hasattr(d, "replace") else d  # noqa: E731
        exp_changed = _norm(body.must_read_expires_at) != _norm(post.must_read_expires_at)
    if pin_changed or must_changed or exp_changed:
        board = await service.get_board(db, post.board_id)
        if board and board.notice_permission == "admin" and not user.is_admin:
            raise HTTPException(403, "공지/필독 설정은 관리자만 가능합니다")
    # 전송된 필드만 반영. null 은 "비우기"로 해석되는 필드(카테고리·첨부·필독 만료)에만 유지하고 나머지는 무시
    updates = {
        k: v for k, v in body.model_dump(exclude_unset=True).items()
        if v is not None or k in service.NULLABLE_POST_FIELDS
    }
    if updates.get("content") is not None and not updates["content"].strip():
        raise HTTPException(400, "내용을 입력하세요")
    if not updates:
        raise HTTPException(400, "변경할 내용이 없습니다")
    result = await service.update_post(db, post_id, **updates)
    return result


@router.delete("/posts/{post_id}")
@require_module("board")
async def delete_post(
    post_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import Post as PostModel
    post = await db.get(PostModel, post_id)
    if not post or post.is_deleted:
        raise HTTPException(404, "게시글을 찾을 수 없습니다")
    if post.author_id != user.id and not user.is_admin:
        raise HTTPException(403, "삭제 권한이 없습니다")
    await service.soft_delete_post(db, post_id)
    return {"ok": True}


# ─── Comments ───

@router.get("/posts/{post_id}/comments")
@require_module("board")
async def list_comments(
    post_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.get_comments(db, post_id)


@router.post("/posts/{post_id}/comments", status_code=201)
@require_module("board")
async def create_comment(
    post_id: str,
    body: CommentCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import Post as PostModel
    post = await db.get(PostModel, post_id)
    if not post or post.is_deleted:
        raise HTTPException(404, "게시글을 찾을 수 없습니다")
    # Check board allows comments
    board = await service.get_board(db, post.board_id)
    if board and not board.allow_comments:
        raise HTTPException(403, "이 게시판은 댓글을 허용하지 않습니다")
    if board and board.comment_permission == "admin" and not user.is_admin:
        raise HTTPException(403, "댓글 작성 권한이 없습니다")

    attachments_json = None
    if body.attachments:
        import json
        attachments_json = json.dumps(body.attachments, ensure_ascii=False)

    import json as _json
    mentions = await service.resolve_mentions(db, body.content, exclude_user_id=user.id)
    try:
        comment = await service.create_comment(
            db,
            post_id=post_id,
            author_id=user.id,
            content=body.content,
            parent_id=body.parent_id,
            attachments=attachments_json,
            mentions=_json.dumps(mentions, ensure_ascii=False) if mentions else None,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    if mentions:
        await service.notify_comment_mentions(db, post, comment, user, mentions)
    return comment


@router.patch("/comments/{comment_id}")
@require_module("board")
async def update_comment(
    comment_id: str,
    body: CommentUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import PostComment
    comment = await db.get(PostComment, comment_id)
    if not comment or comment.is_deleted:
        raise HTTPException(404, "댓글을 찾을 수 없습니다")
    if comment.author_id != user.id and not user.is_admin:
        raise HTTPException(403, "수정 권한이 없습니다")
    result = await service.update_comment(db, comment_id, body.content)
    return result


@router.delete("/comments/{comment_id}")
@require_module("board")
async def delete_comment(
    comment_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import PostComment
    comment = await db.get(PostComment, comment_id)
    if not comment or comment.is_deleted:
        raise HTTPException(404, "댓글을 찾을 수 없습니다")
    if comment.author_id != user.id and not user.is_admin:
        raise HTTPException(403, "삭제 권한이 없습니다")
    await service.soft_delete_comment(db, comment_id)
    return {"ok": True}


# ─── Reactions ───

@router.post("/posts/{post_id}/reactions")
@require_module("board")
async def toggle_reaction(
    post_id: str,
    body: ReactionToggle,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import Post as PostModel
    post = await db.get(PostModel, post_id)
    if not post or post.is_deleted:
        raise HTTPException(404, "게시글을 찾을 수 없습니다")
    board = await service.get_board(db, post.board_id)
    if board and not board.allow_reactions:
        raise HTTPException(403, "이 게시판은 리액션을 허용하지 않습니다")
    return await service.toggle_post_reaction(db, post_id, user.id, body.emoji)


# ─── Bookmarks ───

@router.post("/posts/{post_id}/bookmark")
@require_module("board")
async def toggle_bookmark(
    post_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import Post as PostModel
    post = await db.get(PostModel, post_id)
    if not post or post.is_deleted:
        raise HTTPException(404, "게시글을 찾을 수 없습니다")
    return await service.toggle_bookmark(db, post_id, user.id)


@router.get("/bookmarks")
@require_module("board")
async def list_bookmarks(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.get_user_bookmarks(db, user.id, page=page, page_size=page_size)


# ─── Must Read ───

@router.get("/must-read")
@require_module("board")
async def list_must_read(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.get_must_read_posts(db, user.id)


# ─── Dashboard ───

@router.get("/recent-posts")
@require_module("board")
async def recent_posts(
    limit: int = Query(10, ge=1, le=30),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.get_recent_posts(db, limit=limit)


@router.get("/notices")
@require_module("board")
async def notice_posts(
    limit: int = Query(5, ge=1, le=20),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.get_notice_posts(db, limit=limit)


@router.get("/boards-with-posts")
@require_module("board")
async def boards_with_recent_posts(
    limit_per_board: int = Query(5, ge=1, le=10),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.get_recent_posts_by_board(db, limit_per_board=limit_per_board, user_id=user.id)


# ─── Search ───

@router.get("/search")
@require_module("board")
async def search_posts(
    q: str = Query(..., min_length=1),
    board_id: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.search_posts(
        db, q, board_id=board_id, page=page, page_size=page_size
    )
