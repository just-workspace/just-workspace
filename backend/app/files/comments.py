"""파일 댓글 — 공유 권한 '댓글' 단계의 실체.

파일은 공유와 같은 식별자로 가리킨다: (원 소유자 id, 소유자 가상경로 'my/..').
요청 경로는 내 파일(my/..) 또는 공유받은 경로(shared-with-me/<id>/..) 무엇이든 되고, 같은 파일이면 같은 댓글이 보인다.

- 읽기: 보기 권한 이상(소유자 포함)
- 쓰기: 댓글 권한 이상(댓글·편집·공동 소유)과 소유자
- 수정·삭제: 쓴 사람만(그리고 지금도 댓글 권한이 있을 때)
- @멘션: 게시판 댓글과 같은 해석(@아이디) — 그 파일을 볼 수 있는 사람에게만 기존 알림 체계로 알린다
  (볼 수 없는 사람에게 파일 이름·내용 일부가 새지 않게)

추가된 것:
- 답글(parent_id — 늘 최상위 댓글에 붙는다) · 위치 조각(anchor, 예 "시트 3 · D14") · 해결(최상위만, 댓글 권한 이상 누구나)
- GET /comments/mentionable — "@" 후보: 디렉터리 사용자 + 그 파일에 대한 권한(볼 수 없으면 role=null)
- POST /access-request — 보기 권한인 사람이 원 소유자에게 "댓글/편집 권한 요청" 알림을 보낸다(공유를 바꾸지는 않는다)

이름 변경·이동·휴지통·복원·영구 삭제 때 따라가는 일은 access.repoint/purge 가 한다.
팀 공유 폴더(shared/)와 관리자 전체 보기(users/)는 소유자 기준 식별자가 없거나 애매해 지원하지 않는다(400).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import FileComment, User
from app.db.session import get_db
from app.files import access as acc
from app.files import activity as act

router = APIRouter(prefix="/api/files", tags=["files"])

MAX_LEN = 4000


class CommentCreate(BaseModel):
    path: str
    content: str = Field(..., min_length=1, max_length=MAX_LEN)
    # 답글이면 대상 댓글 id(답글의 답글은 그 최상위 댓글에 붙인다)
    parent_id: str | None = None
    # 위치 조각(오피스 편집기가 셀·쪽 위치를 넘길 때). 사람이 읽는 짧은 글
    anchor: str | None = Field(None, max_length=200)


class CommentResolve(BaseModel):
    resolved: bool = True


class AccessRequest(BaseModel):
    path: str
    # 요청하는 권한(댓글·편집). 공동 소유는 요청 대상이 아니다
    role: str = "comment"
    message: str | None = Field(None, max_length=500)


class CommentUpdate(BaseModel):
    content: str = Field(..., min_length=1, max_length=MAX_LEN)


async def _target(db: AsyncSession, user: User, path: str, need: str) -> acc.Access:
    vp = (path or "").strip("/")
    if not (vp.startswith("my/") or acc.parse_shared(vp)):
        raise HTTPException(status_code=400, detail="내 파일·공유받은 파일에만 댓글을 달 수 있습니다")
    a = await acc.resolve(db, user, vp, need)
    if not a.owner_id or not a.owner_vpath:
        raise HTTPException(status_code=400, detail="댓글을 달 수 없는 경로입니다")
    if not a.real.exists():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    return a


def _to_dict(c: FileComment, author: User | None, me: User, resolver: User | None = None) -> dict:
    mentions = []
    if c.mentions:
        try:
            mentions = json.loads(c.mentions)
        except ValueError:
            mentions = []
    return {
        "id": c.id,
        "content": c.content,
        "author": ({"id": author.id, "username": author.username,
                    "display_name": author.display_name or author.username,
                    "avatar_url": getattr(author, "avatar_url", None)} if author else None),
        "mentions": mentions,
        "is_edited": bool(c.is_edited),
        "is_mine": bool(c.author_id) and c.author_id == me.id,
        "parent_id": c.parent_id,
        "anchor": c.anchor,
        "resolved": c.resolved_at is not None,
        "resolved_at": c.resolved_at.isoformat() if c.resolved_at else None,
        "resolved_by": ({"id": resolver.id, "display_name": resolver.display_name or resolver.username}
                        if resolver else None),
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


@router.get("/comments")
async def list_comments(
    path: str = Query(..., description="파일 가상경로(my/.. 또는 shared-with-me/..)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """파일 댓글(오래된 순). can_comment: 내가 댓글을 쓸 수 있나(보기 권한이면 false), role: 내 권한,
    owner: 원 소유자(보기 권한 안내 "○○ 님에게 권한 요청"), is_original_owner: 내가 원 소유자인가."""
    a = await _target(db, user, path, "view")
    rows = (await db.execute(
        select(FileComment, User)
        .outerjoin(User, FileComment.author_id == User.id)
        .where(FileComment.owner_id == a.owner_id, FileComment.file_path == a.owner_vpath)
        .order_by(FileComment.created_at.asc())
    )).all()
    resolver_ids = {c.resolved_by for c, _ in rows if c.resolved_by}
    resolvers = {}
    if resolver_ids:
        resolvers = {u.id: u for u in (await db.execute(select(User).where(User.id.in_(resolver_ids)))).scalars().all()}
    owner = await db.get(User, a.owner_id)
    return {
        "items": [_to_dict(c, u, user, resolvers.get(c.resolved_by)) for c, u in rows],
        "can_comment": acc.at_least(a.role, "comment"),
        "role": a.role,
        "owner": ({"id": owner.id, "display_name": owner.display_name or owner.username} if owner else None),
        "is_original_owner": a.owner_id == user.id,
    }


@router.get("/comments/mentionable")
async def mentionable_people(
    path: str = Query(..., description="파일 가상경로"),
    q: str = Query("", max_length=100),
    limit: int = Query(8, ge=1, le=20),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """"@" 후보(시안 "이 파일을 볼 수 있는 사람") — 이름·아이디·이메일 앞부분 검색, 나 제외.
    role = 그 사람의 이 파일 권한(볼 수 없으면 null — 언급해도 알림이 가지 않는다). 볼 수 있는 사람이 먼저."""
    a = await _target(db, user, path, "comment")
    term = (q or "").strip().lstrip("@").lower()
    stmt = select(User).where(User.is_active.is_(True), User.id != user.id)
    if term:
        like = f"{term}%"
        stmt = stmt.where(or_(
            func.lower(User.username).like(like),
            func.lower(func.coalesce(User.display_name, "")).like(like),
            func.lower(func.coalesce(User.display_name, "")).like(f"% {like}"),
            func.lower(func.coalesce(User.email, "")).like(like),
        ))
    cands = (await db.execute(stmt.order_by(User.display_name, User.username).limit(50))).scalars().all()
    out = []
    for u in cands:
        role, _ = await acc.role_on(db, u, a.owner_id, a.owner_vpath)
        out.append({
            "id": u.id, "username": u.username, "display_name": u.display_name or u.username,
            "email": u.email, "avatar_url": getattr(u, "avatar_url", None),
            "role": role if acc.at_least(role, "view") else None,
        })
    out.sort(key=lambda x: (x["role"] is None,))
    return {"items": out[:limit]}


@router.post("/access-request")
async def request_access(
    body: AccessRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """보기 권한으로 받은 파일에 더 높은 권한(댓글·편집)을 원 소유자에게 요청 — 알림만 보낸다.
    이미 그 권한 이상이면 400, 공유받지 않은 경로(내 파일)는 400."""
    if body.role not in ("comment", "edit"):
        raise HTTPException(status_code=400, detail="요청할 수 있는 권한은 댓글·편집입니다")
    vp = (body.path or "").strip("/")
    if not acc.parse_shared(vp):
        raise HTTPException(status_code=400, detail="공유받은 파일에서만 권한을 요청할 수 있습니다")
    a = await _target(db, user, vp, "view")
    if acc.at_least(a.role, body.role):
        raise HTTPException(status_code=400, detail="이미 그 권한이 있습니다")
    from app.notifications.service import create_notification
    name = user.display_name or user.username
    label = {"comment": "댓글", "edit": "편집"}[body.role]
    parent = a.owner_vpath.rsplit("/", 1)[0] if "/" in a.owner_vpath else a.owner_vpath
    note = (body.message or "").strip()
    await create_notification(
        db, a.owner_id, "file_shared",
        f"{name}님이 '{a.real.name}' 에 {label} 권한을 요청했습니다",
        note[:300] or None,
        link=f"/files?path={parent}", actor_id=user.id, actor_name=name,
    )
    return {"ok": True, "notified": 1}


async def _notify_mentions(db: AsyncSession, a: acc.Access, author: User, comment: dict, mentions: list[dict]) -> int:
    """멘션된 사람 중 그 파일을 볼 수 있는 사람에게만 알림. 보낸 수."""
    from app.notifications.service import create_notification
    name = author.display_name or author.username
    fname = a.real.name
    sent = 0
    for m in mentions:
        target = await db.get(User, m["id"])
        if target is None:
            continue
        role, share = await acc.role_on(db, target, a.owner_id, a.owner_vpath)
        if not acc.at_least(role, "view"):
            continue
        # 소유자는 내 파일 폴더로, 받은 사람은 공유받음으로
        if target.id == a.owner_id:
            parent = a.owner_vpath.rsplit("/", 1)[0]
            link = f"/files?path={parent}"
        else:
            link = "/files?view=shared-with-me"
        try:
            await create_notification(
                db, target.id, "mention",
                f"{name}님이 파일 댓글에서 회원님을 멘션했습니다",
                f"{fname}: {(comment.get('content') or '')[:150]}",
                link=link, actor_id=author.id, actor_name=name,
            )
            sent += 1
        except Exception:
            continue
    return sent


@router.post("/comments", status_code=201)
async def create_comment(
    body: CommentCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """댓글 쓰기 — 댓글 권한 이상·소유자. @아이디 멘션은 그 파일을 볼 수 있는 사람에게 알린다."""
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="댓글 내용을 입력하세요")
    a = await _target(db, user, body.path, "comment")
    parent_id = None
    if body.parent_id:
        parent = await db.get(FileComment, body.parent_id)
        if parent is None or parent.owner_id != a.owner_id or parent.file_path != a.owner_vpath:
            raise HTTPException(status_code=404, detail="답글을 달 댓글을 찾을 수 없습니다")
        parent_id = parent.parent_id or parent.id
    from app.board.service import resolve_mentions
    mentions = await resolve_mentions(db, content, exclude_user_id=user.id)
    now = datetime.now(timezone.utc)
    c = FileComment(owner_id=a.owner_id, file_path=a.owner_vpath, author_id=user.id, content=content,
                    mentions=json.dumps(mentions, ensure_ascii=False) if mentions else None,
                    parent_id=parent_id, anchor=(body.anchor or "").strip() or None,
                    created_at=now, updated_at=now)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    out = _to_dict(c, user, user)
    await act.record(a.key, user.id, "comment", {"comment_id": c.id})
    if mentions:
        out["notified"] = await _notify_mentions(db, a, user, out, mentions)
    return out


async def _own_comment(db: AsyncSession, comment_id: str, user: User) -> FileComment:
    c = await db.get(FileComment, comment_id)
    if c is None:
        raise HTTPException(status_code=404, detail="댓글을 찾을 수 없습니다")
    # 지금도 그 파일에 댓글 권한이 있어야 한다(보기로 내려갔거나 공유가 풀리면 못 고친다)
    role, _ = await acc.role_on(db, user, c.owner_id, c.file_path)
    if role is None:
        raise HTTPException(status_code=404, detail="댓글을 찾을 수 없습니다")
    if c.author_id != user.id:
        raise HTTPException(status_code=403, detail="내가 쓴 댓글만 고치거나 지울 수 있습니다")
    if not acc.at_least(role, "comment"):
        raise acc.deny("comment")
    return c


@router.post("/comments/{comment_id}/resolve")
async def resolve_comment(
    comment_id: str,
    body: CommentResolve,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """해결/다시 열기 — 최상위 댓글만, 그 파일에 댓글 권한 이상이면 누구나(쓴 사람이 아니어도)."""
    c = await db.get(FileComment, comment_id)
    if c is None:
        raise HTTPException(status_code=404, detail="댓글을 찾을 수 없습니다")
    role, _ = await acc.role_on(db, user, c.owner_id, c.file_path)
    if role is None:
        raise HTTPException(status_code=404, detail="댓글을 찾을 수 없습니다")
    if not acc.at_least(role, "comment"):
        raise acc.deny("comment")
    if c.parent_id:
        raise HTTPException(status_code=400, detail="답글은 따로 해결할 수 없습니다")
    if body.resolved:
        c.resolved_at = datetime.now(timezone.utc)
        c.resolved_by = user.id
    else:
        c.resolved_at = None
        c.resolved_by = None
    await db.commit()
    await db.refresh(c)
    author = await db.get(User, c.author_id) if c.author_id else None
    return _to_dict(c, author, user, user if body.resolved else None)


@router.patch("/comments/{comment_id}")
async def update_comment(
    comment_id: str,
    body: CommentUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """내 댓글 고치기. 멘션은 다시 해석해 저장만 한다(고칠 때마다 알림을 다시 보내지 않는다)."""
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="댓글 내용을 입력하세요")
    c = await _own_comment(db, comment_id, user)
    from app.board.service import resolve_mentions
    mentions = await resolve_mentions(db, content, exclude_user_id=user.id)
    c.content = content
    c.mentions = json.dumps(mentions, ensure_ascii=False) if mentions else None
    c.is_edited = True
    c.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(c)
    return _to_dict(c, user, user)


@router.delete("/comments/{comment_id}")
async def delete_comment(
    comment_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """내 댓글 지우기(완전 삭제). 최상위를 지우면 답글도 같이 지운다."""
    c = await _own_comment(db, comment_id, user)
    if not c.parent_id:
        for r in (await db.execute(select(FileComment).where(FileComment.parent_id == c.id))).scalars().all():
            await db.delete(r)
    await db.delete(c)
    await db.commit()
    return {"ok": True}
