"""Global search API — unified search across posts, contacts, messages, files,
tasks, wiki pages, and calendar events."""

from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import (
    AddressBookDB,
    CalendarDB,
    CalendarEventDB,
    Channel,
    ChannelMember,
    FileIndex,
    ContactDB,
    Message,
    Post,
    TaskDB,
    User,
    WikiPage,
    WikiSpace,
    WikiSpaceMember,
)
from app.db.session import get_db
from app.files.service import is_hidden_name as _files_hidden
from app.modules.registry import is_module_enabled

router = APIRouter(prefix="/api/search", tags=["search"])

VALID_MODULES = {"board", "contacts", "chat", "files", "tasks", "wiki", "calendar"}
PER_MODULE_LIMIT = 10
TOTAL_LIMIT = 50


def _snippet(text: str | None, query: str, max_len: int = 120) -> str:
    """Extract a snippet around the query match."""
    if not text:
        return ""
    lower_text = text.lower()
    lower_q = query.lower()
    idx = lower_text.find(lower_q)
    if idx == -1:
        return text[:max_len] + ("..." if len(text) > max_len else "")
    start = max(0, idx - 40)
    end = min(len(text), idx + len(query) + 80)
    snippet = text[start:end]
    if start > 0:
        snippet = "..." + snippet
    if end < len(text):
        snippet = snippet + "..."
    return snippet


def _escape_like(q: str) -> str:
    """Escape LIKE wildcards for safe search."""
    return q.replace("%", "\\%").replace("_", "\\_")


def searchable_modules(modules: str) -> set[str]:
    """요청한 검색 대상(쉼표 구분) 중 실제로 찾을 것 — 아는 이름이 없으면 전부.

    꺼졌거나 설치하지 않은 구역의 모듈은 요청에 적혀 있어도 뺀다.
    """
    requested = {m.strip() for m in modules.split(",") if m.strip() in VALID_MODULES}
    if not requested:
        requested = set(VALID_MODULES)
    return {m for m in requested if is_module_enabled(m)}


@router.get("")
async def global_search(
    q: str = Query(..., min_length=1, max_length=200),
    modules: str = Query("board,contacts,chat,files,tasks,wiki,calendar"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Unified search across multiple modules.

    Parameters:
        q: Search query string
        modules: Comma-separated list of modules to search (board, contacts, chat, files, tasks, wiki, calendar)

    Returns:
        {results: [{type, id, title, snippet, url}], total}
    """
    requested = searchable_modules(modules)

    results: list[dict] = []

    escaped = _escape_like(q)
    pattern = f"%{escaped}%"

    # ─── Board (posts) ───
    if "board" in requested:
        post_rows = (
            await db.execute(
                select(Post)
                .where(
                    Post.is_deleted == False,  # noqa: E712
                    or_(
                        Post.title.ilike(pattern, escape="\\"),
                        Post.content.ilike(pattern, escape="\\"),
                    ),
                )
                .order_by(Post.created_at.desc())
                .limit(PER_MODULE_LIMIT)
            )
        ).scalars().all()

        for p in post_rows:
            results.append({
                "type": "post",
                "id": p.id,
                "title": p.title,
                "snippet": _snippet(p.content, q),
                # 게시글 화면 주소는 /board/<게시판 id>/<글 id>. 예전 /board/posts/<id> 는 게시판 자리에 "posts" 가 들어가 목록·삭제 뒤 이동이 깨졌다.
                "url": f"/board/{p.board_id}/{p.id}",
            })

    # ─── Contacts ───
    if "contacts" in requested:
        # Only search user's own contacts
        ab_ids_result = await db.execute(
            select(AddressBookDB.id).where(AddressBookDB.user_id == user.id)
        )
        ab_ids = [row[0] for row in ab_ids_result.all()]

        if ab_ids:
            contact_rows = (
                await db.execute(
                    select(ContactDB)
                    .where(
                        ContactDB.address_book_id.in_(ab_ids),
                        or_(
                            ContactDB.full_name.ilike(pattern, escape="\\"),
                            ContactDB.emails.ilike(pattern, escape="\\"),
                            ContactDB.organization.ilike(pattern, escape="\\"),
                        ),
                    )
                    .order_by(ContactDB.full_name)
                    .limit(PER_MODULE_LIMIT)
                )
            ).scalars().all()

            for c in contact_rows:
                snippet_parts = []
                if c.organization:
                    snippet_parts.append(c.organization)
                if c.emails:
                    snippet_parts.append(c.emails[:80])
                results.append({
                    "type": "contact",
                    "id": c.id,
                    "title": c.full_name,
                    "snippet": " | ".join(snippet_parts) if snippet_parts else "",
                    # 연락처는 /contacts 한 화면뿐이다(/contacts/<id> 는 없는 경로라 404) — 목록으로 보낸다.
                    "url": "/contacts",
                })

    # ─── Chat (messages) ───
    if "chat" in requested:
        # Only search channels the user is a member of
        user_channels_q = select(ChannelMember.channel_id).where(
            ChannelMember.user_id == user.id
        )

        msg_rows = (
            await db.execute(
                select(Message, Channel)
                .join(Channel, Message.channel_id == Channel.id)
                .where(
                    Message.channel_id.in_(user_channels_q),
                    Message.is_deleted == False,  # noqa: E712
                    Message.content.ilike(pattern, escape="\\"),
                )
                .order_by(Message.created_at.desc())
                .limit(PER_MODULE_LIMIT)
            )
        ).all()

        for msg, ch in msg_rows:
            results.append({
                "type": "message",
                "id": msg.id,
                "title": f"#{ch.name}",
                "snippet": _snippet(msg.content, q),
                # 채팅 화면 주소는 /chat?channel=<id>(명령 팔레트 채널 행과 같은 형식). /chat/channels/<id> 는 없는 경로라 404.
                "url": f"/chat?channel={ch.id}",
            })

    # ─── Tasks ───
    if "tasks" in requested:
        task_rows = (
            await db.execute(
                select(TaskDB)
                .where(
                    TaskDB.user_id == user.id,
                    or_(
                        TaskDB.title.ilike(pattern, escape="\\"),
                        TaskDB.description.ilike(pattern, escape="\\"),
                    ),
                )
                .order_by(TaskDB.created_at.desc())
                .limit(PER_MODULE_LIMIT)
            )
        ).scalars().all()

        for t in task_rows:
            results.append({
                "type": "task",
                "id": t.id,
                "title": t.title,
                "snippet": _snippet(t.description, q) if t.description else t.status,
                # 작업 화면은 highlight 쿼리를 읽지 않는다 — 목록으로 보낸다.
                "url": "/tasks",
            })

    # ─── Wiki pages ───
    if "wiki" in requested:
        # Search public spaces + spaces the user is a member of
        member_space_ids_q = select(WikiSpaceMember.space_id).where(
            WikiSpaceMember.user_id == user.id
        )
        public_space_ids_q = select(WikiSpace.id).where(
            WikiSpace.visibility == "public"
        )
        accessible_space_ids_q = member_space_ids_q.union(public_space_ids_q)

        wiki_rows = (
            await db.execute(
                select(WikiPage, WikiSpace)
                .join(WikiSpace, WikiPage.space_id == WikiSpace.id)
                .where(
                    WikiPage.space_id.in_(accessible_space_ids_q),
                    or_(
                        WikiPage.title.ilike(pattern, escape="\\"),
                        WikiPage.content.ilike(pattern, escape="\\"),
                    ),
                )
                .order_by(WikiPage.updated_at.desc())
                .limit(PER_MODULE_LIMIT)
            )
        ).all()

        for page, space in wiki_rows:
            results.append({
                "type": "wiki",
                "id": page.id,
                "title": page.title,
                "snippet": _snippet(page.content, q),
                # 위키 화면 주소는 /wiki?space=<id>&page=<id>. 예전 /wiki/{slug}/{slug} 는 없는 경로라 404.
                "url": f"/wiki?space={space.id}&page={page.id}",
            })

    # ─── Calendar events ───
    if "calendar" in requested:
        user_cal_ids_q = select(CalendarDB.id).where(
            CalendarDB.user_id == user.id
        )

        event_rows = (
            await db.execute(
                select(CalendarEventDB)
                .where(
                    CalendarEventDB.calendar_id.in_(user_cal_ids_q),
                    or_(
                        CalendarEventDB.title.ilike(pattern, escape="\\"),
                        CalendarEventDB.description.ilike(pattern, escape="\\"),
                        CalendarEventDB.location.ilike(pattern, escape="\\"),
                    ),
                )
                .order_by(CalendarEventDB.start.desc())
                .limit(PER_MODULE_LIMIT)
            )
        ).scalars().all()

        for ev in event_rows:
            snippet_parts = []
            if ev.location:
                snippet_parts.append(ev.location)
            if ev.description:
                snippet_parts.append(_snippet(ev.description, q, max_len=80))
            results.append({
                "type": "event",
                "id": ev.id,
                "title": ev.title,
                "snippet": " | ".join(snippet_parts) if snippet_parts else "",
                "url": f"/calendar?event={ev.id}",
            })

    # ─── Files (이름) ───
    if "files" in requested:
        # 파일 색인(file_index)에서 찾는다. 예전에는 질의마다 rglob 으로 저장소 전체를 동기 순회해
        # 이벤트 루프를 막았고, 색인기가 건너뛰는 휴지통(.trash)·점 파일까지 결과에 나왔다.
        for scope, virtual_prefix in ((user.id, "my"), ("shared", "shared")):
            try:
                idx_rows = (
                    await db.execute(
                        select(FileIndex)
                        .where(
                            FileIndex.scope == scope,
                            FileIndex.name.ilike(pattern, escape="\\"),
                        )
                        .order_by(FileIndex.mtime.desc())
                        .limit(PER_MODULE_LIMIT)
                    )
                ).scalars().all()
            except Exception:
                idx_rows = []
            for f in idx_rows:
                rel = (f.rel_path or "").strip("/")
                if not rel or any(_files_hidden(part) for part in rel.split("/")):   # 숨김 판정은 files.service 한 곳
                    continue
                vpath = f"{virtual_prefix}/{rel}"
                parent = (f.parent_dir or "").strip("/")
                folder = vpath if f.is_dir else (f"{virtual_prefix}/{parent}" if parent else virtual_prefix)
                results.append({
                    "type": "file",
                    "id": vpath,
                    "title": f.name,
                    "snippet": vpath,
                    "url": f"/files?path={quote(folder, safe='/')}",
                })

    # Enforce total limit
    results = results[:TOTAL_LIMIT]

    return {"results": results, "total": len(results)}
