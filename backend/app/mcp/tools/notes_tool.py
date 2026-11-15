"""Notes / wiki tools — 검색·읽기 + 쓰기(만들기·고치기·삭제). 권한은 웹 API 와 같은 writer 기준."""

import logging

from app.db.models import User
from app.db.session import async_session
from app.mcp.server import Tool, register
from app.mcp.tools._common import (
    CURSOR_PARAM, PAGINATION_HINT, UNDO_HINT, UNDO_TOKEN_PARAM, check_undo_token, clamp, drop_empty, err,
    fit_page, query_hash, read_cursor, shorten, undo_token,
)

logger = logging.getLogger(__name__)


async def _user_spaces(db, user: User) -> list[dict]:
    """Return wiki spaces the user can access. Tries service helpers; falls back to raw DB.

    Logs which resolution path was taken (service helper vs raw DB) at debug level,
    and warns when it ends up returning an empty list — an empty result is
    otherwise indistinguishable from a silent double-swallow of exceptions.
    """
    try:
        from app.wiki import service as wiki_service
        if hasattr(wiki_service, "list_user_spaces"):
            spaces = await wiki_service.list_user_spaces(db, str(user.id))
            logger.debug("[mcp] _user_spaces via service helper: %d space(s)", len(spaces))
            if not spaces:
                logger.warning("[mcp] _user_spaces returned empty (service helper) for user %s", user.id)
            return spaces
    except Exception as e:
        logger.warning("[mcp] _user_spaces service helper failed, falling back to raw DB: %s", e)
    try:
        from sqlalchemy import select
        from app.db.models import WikiSpace, WikiSpaceMember
        q = (
            select(WikiSpace)
            .join(WikiSpaceMember, WikiSpaceMember.space_id == WikiSpace.id, isouter=True)
            .where((WikiSpaceMember.user_id == str(user.id)) | (WikiSpace.owner_id == str(user.id)))
        )
        rows = (await db.execute(q)).scalars().unique().all()
        spaces = [{"id": s.id, "name": getattr(s, "name", s.id)} for s in rows]
        logger.debug("[mcp] _user_spaces via raw DB fallback: %d space(s)", len(spaces))
        if not spaces:
            logger.warning("[mcp] _user_spaces returned empty (raw DB) for user %s", user.id)
        return spaces
    except Exception as e:
        logger.warning("[mcp] _user_spaces fallback failed: %s", e)
        return []


_SEARCH_PER_SPACE = 200   # 공간 하나에서 모으는 최대 결과(페이지 넘김 대상)
_SNIPPET_MAX = 150        # 검색 결과 미리보기(글자)


async def notes_search(user: User, query: str, space: str = "", limit: int = 10, cursor: str = "", **_: object) -> dict:
    """위키 검색. `space` 비면 접근 가능한 모든 공간. 공간별로 번갈아 섞고(round-robin) 페이지로 나눈다."""
    try:
        from app.wiki import service as wiki_service
    except Exception as e:
        return err("unavailable", f"wiki module not available: {e}")
    n = clamp(limit, 1, 50, 10)
    qh = query_hash("notes_search", (query or "").strip(), space)
    off, cerr = read_cursor(cursor, qh)
    if cerr:
        return cerr
    async with async_session() as db:
        spaces = await _user_spaces(db, user)
        if space:
            spaces = [s for s in spaces if s["id"] == space]
            if not spaces:
                return err("forbidden", f"접근할 수 없는 공간입니다: {space}")
        if not spaces:
            return fit_page([], offset=0, total=0, list_key="results",
                            extras={"query": query, "note": "no accessible spaces",
                                    "spaces_searched": 0, "spaces_failed": 0})
        per_space: list[list[dict]] = []
        failed = 0
        for sp in spaces:
            try:
                res = await wiki_service.search_pages(db, sp["id"], query)
            except Exception as e:
                logger.warning("[mcp] notes_search %s failed: %s", sp["id"], e)
                failed += 1
                continue
            bucket: list[dict] = []
            for r in (res or [])[:_SEARCH_PER_SPACE]:
                get = (r.get if isinstance(r, dict) else lambda k, d=None, _r=r: getattr(_r, k, d))
                bucket.append(drop_empty({
                    "id": get("id"),
                    "title": get("title", ""),
                    "snippet": shorten((get("content", "") or "").strip(), _SNIPPET_MAX),
                    "space_id": sp["id"],
                    "updated_at": str(get("updated_at", "") or ""),
                }))
            per_space.append(bucket)
    merged: list[dict] = []
    idx = 0
    while any(idx < len(b) for b in per_space):
        for bucket in per_space:
            if idx < len(bucket):
                merged.append(bucket[idx])
        idx += 1
    window = merged[off:off + n]
    return fit_page(window, offset=off, total=len(merged), list_key="results", qhash=qh,
                    extras={"query": query, "spaces_searched": len(spaces) - failed, "spaces_failed": failed,
                            "hint": "본문은 notes_read(page_id) 로 읽는다"})


_NOTE_READ_DEFAULT = 20_000
_NOTE_READ_CAP = 200_000


async def notes_read(user: User, page_id: str, max_chars: int = _NOTE_READ_DEFAULT, offset: int = 0, **_: object) -> dict:
    """위키 페이지 본문(마크다운). 공간 읽기 권한을 확인한다."""
    try:
        from app.wiki import service as wiki_service
    except Exception as e:
        return err("unavailable", f"wiki module not available: {e}")
    n = clamp(max_chars, 200, _NOTE_READ_CAP, _NOTE_READ_DEFAULT)
    off = clamp(offset, 0, 1 << 40, 0)
    async with async_session() as db:
        page = await wiki_service.get_page(db, str(page_id))
        if not page:
            return err("not_found", f"위키 페이지가 없습니다: {page_id}")
        if not getattr(user, "is_admin", False):
            role = await wiki_service.get_user_role(db, page["space_id"], str(user.id))
            if not role:
                # 존재 여부도 흘리지 않는다
                return err("not_found", f"위키 페이지가 없습니다: {page_id}")
    body = page.get("content") or ""
    window = body[off:off + n]
    end = off + len(window)
    return {
        "id": page.get("id"),
        "title": page.get("title"),
        "space_id": page.get("space_id"),
        "parent_id": page.get("parent_id"),
        "author": (page.get("author") or {}).get("display_name") or (page.get("author") or {}).get("username"),
        "updated_at": str(page.get("updated_at") or ""),
        "content": window,
        "offset": off,
        "total_chars": len(body),
        "truncated": end < len(body),
        "next_offset": end if end < len(body) else None,
    }


async def notes_list(
    user: User, space: str = "", limit: int = 20, cursor: str = "", **_: object
) -> dict:
    """List wiki spaces and their pages (metadata only, no content).

    Enumeration counterpart to ``files_list`` for the wiki. If ``space`` is empty,
    lists every space the user can access. Page bodies are never returned — use
    a dedicated read tool for content.
    """
    try:
        from app.wiki import service as wiki_service
    except Exception as e:
        return {"error": f"wiki module not available: {e}"}
    limit = clamp(limit, 1, 100, 20)
    qh = query_hash("notes_list", space)
    offset, cerr = read_cursor(cursor, qh)
    if cerr:
        return cerr
    async with async_session() as db:
        spaces = await _user_spaces(db, user)
        if space:
            spaces = [s for s in spaces if s["id"] == space]
        if not spaces:
            return {"spaces": [], "note": "no accessible spaces"}
        space_out = [{"id": s["id"], "name": s.get("name", s["id"])} for s in spaces]
        # Gather page metadata across spaces. Per-space failures are surfaced in
        # the response (spaces_failed), never silently swallowed.
        pages: list[dict] = []
        failed = 0
        for sp in spaces:
            try:
                tree = await wiki_service.get_page_tree(db, sp["id"])
            except Exception as e:
                logger.warning("[mcp] notes_list %s failed: %s", sp["id"], e)
                failed += 1
                continue
            for p in tree or []:
                pages.append(drop_empty({
                    "id": p.get("id"),
                    "title": p.get("title", ""),
                    "space_id": sp["id"],
                    "updated_at": p.get("updated_at"),
                }))
    page_slice = pages[offset:offset + limit]
    return fit_page(page_slice, offset=offset, total=len(pages), list_key="pages", qhash=qh,
                    extras={"spaces": space_out, "spaces_searched": len(spaces) - failed,
                            "spaces_failed": failed})


async def _can_write(db, user: User, space_id: str) -> bool:
    """웹 API(위키 페이지 만들기·고치기·지우기)와 같은 기준 — writer 이상, 관리자는 통과."""
    from app.wiki import service as wiki_service

    if getattr(user, "is_admin", False):
        return True
    role = await wiki_service.get_user_role(db, space_id, str(user.id))
    return role in ("writer", "admin")


async def notes_create(user: User, title: str, content: str, space: str = "", parent_id: str = "",
                       **_: object) -> dict:
    """Create a wiki page. Picks the first writable space if not specified."""
    try:
        from app.wiki import service as wiki_service
    except Exception as e:
        return err("unavailable", f"wiki module not available: {e}")
    if not (title or "").strip():
        return err("invalid_argument", "제목이 비었습니다")
    async with async_session() as db:
        target_space = space
        if not target_space:
            spaces = await _user_spaces(db, user)
            if not spaces:
                return err("not_found", "위키 공간이 없습니다 — 먼저 공간을 만드세요")
            target_space = None
            for sp in spaces:
                if await _can_write(db, user, sp["id"]):
                    target_space = sp["id"]
                    break
            if not target_space:
                return err("forbidden", "글을 쓸 수 있는 위키 공간이 없습니다")
        elif not await _can_write(db, user, target_space):
            return err("forbidden", "permission denied: 이 공간에 페이지를 만들 권한이 없습니다")
        if parent_id:
            parent = await wiki_service.get_page(db, str(parent_id))
            if not parent or parent["space_id"] != target_space:
                return err("not_found", f"상위 페이지가 이 공간에 없습니다: {parent_id}")
        try:
            import uuid as _uuid
            slug = f"{wiki_service._slugify(title)[:60]}-{_uuid.uuid4().hex[:6]}"
            page = await wiki_service.create_page(
                db, target_space, str(user.id), title=title, slug=slug, content=content,
                parent_id=(parent_id or None),
            )
        except Exception as e:
            logger.warning("[mcp] notes_create failed: %s", e)
            return err("internal", str(e))
    pid = page.get("id") if isinstance(page, dict) else getattr(page, "id", None)
    return {
        "id": pid,
        "title": title,
        "space_id": target_space,
        "_undo": {"tool": "notes_undo_create",
                  "args": {"page_id": pid, "token": undo_token(user.id, "wiki_page", str(pid))}},
    }


async def notes_undo_create(user: User, page_id: str, token: str, **_: object) -> dict:
    from app.wiki import service as wiki_service

    if not check_undo_token(token, user.id, "wiki_page", str(page_id)):
        return err("forbidden", "이 도구로 만든 페이지가 아니라 지우지 않습니다")
    async with async_session() as db:
        page = await wiki_service.get_page(db, str(page_id))
        if not page:
            return err("not_found", f"위키 페이지가 없습니다: {page_id}")
        if not await _can_write(db, user, page["space_id"]):
            return err("forbidden", "이 공간의 페이지를 지울 권한이 없습니다")
        if int(page.get("version") or 1) > 1:
            return err("conflict", "만든 뒤 고쳐진 페이지라 지우지 않습니다 — 필요하면 notes_delete 로")
        await wiki_service.delete_page(db, str(page_id))
    return {"deleted_page": page_id}


async def notes_update(user: User, page_id: str, title: str | None = None, content: str | None = None,
                       **_: object) -> dict:
    """제목·본문 바꾸기. 고치기 전 본문은 버전 기록에 남는다(항상 새 버전)."""
    from app.wiki import service as wiki_service

    if title is None and content is None:
        return err("invalid_argument", "바꿀 항목이 없습니다(title 또는 content)")
    if title is not None and not title.strip():
        return err("invalid_argument", "제목을 비울 수 없습니다")
    async with async_session() as db:
        page = await wiki_service.get_page(db, str(page_id))
        if not page:
            return err("not_found", f"위키 페이지가 없습니다: {page_id}")
        if not await _can_write(db, user, page["space_id"]):
            # 읽기 권한도 없으면 존재 여부를 흘리지 않는다
            role = await wiki_service.get_user_role(db, page["space_id"], str(user.id))
            if not role and not getattr(user, "is_admin", False):
                return err("not_found", f"위키 페이지가 없습니다: {page_id}")
            return err("forbidden", "이 공간의 페이지를 고칠 권한이 없습니다")
        before = {}
        new = {}
        if title is not None:
            before["title"], new["title"] = page.get("title") or "", title
        if content is not None:
            before["content"], new["content"] = page.get("content") or "", content
        # AI 의 고침은 10분 묶기 없이 새 버전으로 — 사용자의 직전 버전을 덮어쓰지 않게
        updated = await wiki_service.update_page(db, str(page_id), str(user.id), force_new_version=True, **new)
    return {"id": page_id, "title": (updated or {}).get("title"), "version": (updated or {}).get("version"),
            "before": before, "_undo": {"tool": "notes_update", "args": {"page_id": page_id, **before}}}


async def notes_delete(user: User, page_id: str, **_: object) -> dict:
    from app.wiki import service as wiki_service

    async with async_session() as db:
        page = await wiki_service.get_page(db, str(page_id))
        if not page:
            return err("not_found", f"위키 페이지가 없습니다: {page_id}")
        if not await _can_write(db, user, page["space_id"]):
            return err("forbidden", "이 공간의 페이지를 지울 권한이 없습니다")
        await wiki_service.delete_page(db, str(page_id))
    return {"deleted_page": page_id, "title": page.get("title"),
            "note": "페이지를 지웠습니다(하위 페이지는 위로 올라갑니다). 위키에는 휴지통이 없어 되살릴 수 없습니다."}


def _sum_note(args: dict) -> str:
    t = str(args.get("title") or "").strip()
    return t or f"위키 페이지 {args.get('page_id', '')}".strip()


def _prev_update(args: dict) -> list[dict]:
    rows = []
    if args.get("title") is not None:
        rows.append({"field": "title", "label": "제목", "before": None, "after": args["title"]})
    if args.get("content") is not None:
        body = str(args["content"])
        rows.append({"field": "content", "label": "본문", "before": None,
                     "after": body if len(body) <= 4000 else body[:4000] + f"… (총 {len(body)}자)"})
    return rows


register(Tool(
    name="notes_search",
    description=(
        "Search the user's wiki pages by keyword across all accessible spaces. "
        "Results are distributed evenly across spaces up to `limit` (round-robin), "
        "so no single space monopolizes the results. The response includes "
        "`spaces_searched` and `spaces_failed` so partial failures are visible. "
        "Results carry a snippet only — read the body with notes_read."
        + PAGINATION_HINT
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "space": {"type": "string", "description": "Optional specific space id. Empty = search all.", "default": ""},
            "limit": {"type": "integer", "description": "Results per page (default 10, max 50).", "default": 10},
            "cursor": CURSOR_PARAM,
        },
        "required": ["query"],
    },
    # 남이 쓴 글이 들어 있다 — 신뢰 경계로 감싸고, 직후의 쓰기는 승인 흐름이 경고·자동 실행 금지로 다룬다
    handler=notes_search, untrusted_output=True,
))

register(Tool(
    name="notes_read",
    description=(
        "Read the full Markdown body of a wiki page. Get `page_id` from notes_search or "
        "notes_list. Long pages return a window; when `truncated` is true call again with "
        "`offset` = `next_offset`."
    ),
    parameters={
        "type": "object",
        "properties": {
            "page_id": {"type": "string", "description": "Page id from notes_search / notes_list."},
            "max_chars": {"type": "integer", "description": "Max characters (default 20000, max 200000).", "default": 20000},
            "offset": {"type": "integer", "description": "Character offset to continue from.", "default": 0},
        },
        "required": ["page_id"],
    },
    # 남이 쓴 글이 들어 있다 — 신뢰 경계로 감싸고, 직후의 쓰기는 승인 흐름이 경고·자동 실행 금지로 다룬다
    handler=notes_read, untrusted_output=True,
))

register(Tool(
    name="notes_list",
    description=(
        "List the user's wiki spaces and their pages (metadata only — id, title, "
        "space_id, updated_at; no page content). Use this to browse the wiki or "
        "check whether a space has any pages. Read a page body with notes_read."
        + PAGINATION_HINT
    ),
    parameters={
        "type": "object",
        "properties": {
            "space": {"type": "string", "description": "Optional specific space id. Empty = list all accessible spaces.", "default": ""},
            "limit": {"type": "integer", "description": "Max pages to return (default 20, max 100).", "default": 20},
            "cursor": {"type": "string", "description": "Opaque pagination cursor from a previous response.", "default": ""},
        },
    },
    # 남이 쓴 제목이 섞인다 — 내장 AI 대화 표시만(MCP 15분 창·래핑 없음)
    handler=notes_list, conv_untrusted=True,
))

register(Tool(
    name="notes_create",
    title="위키 페이지 만들기",
    description="Create a new wiki page (Markdown). If `space` is not given, uses the first space the user "
                "can write to. Optional `parent_id` nests it under another page of the same space.",
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "title": {"type": "string", "x-label": "제목", "x-editable": True},
            "content": {"type": "string", "description": "Markdown body.", "x-label": "본문",
                        "x-editable": True, "x-multiline": True},
            "space": {"type": "string", "description": "Optional space id.", "default": "",
                      "x-label": "공간", "x-hidden": True},
            "parent_id": {"type": "string", "description": "Optional parent page id.", "default": "",
                          "x-label": "상위 페이지", "x-hidden": True},
        },
        "required": ["title", "content"],
    },
    # 위키 공간은 다른 구성원이 읽는다 — 외부 내용을 읽은 뒤에는 자동 수락·허용 규칙이어도 묻는다
    visible_to_others=True,
    handler=notes_create, summarizer=_sum_note,
))

register(Tool(
    name="notes_undo_create",
    title="만든 위키 페이지 되돌리기",
    description="Delete a wiki page that notes_create just created (only if not edited since)." + UNDO_HINT,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "page_id": {"type": "string", "x-label": "페이지 id", "x-hidden": True},
        "token": UNDO_TOKEN_PARAM,
    }, "required": ["page_id", "token"]},
    handler=notes_undo_create, summarizer=lambda a: "만든 위키 페이지 삭제",
))

register(Tool(
    name="notes_update",
    title="위키 페이지 고치기",
    description="Replace a wiki page's title and/or full Markdown body (read it with notes_read first and "
                "send the whole new body). The previous text stays in the page's version history.",
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "page_id": {"type": "string", "description": "Page id from notes_search / notes_list.",
                        "x-label": "페이지 id", "x-hidden": True},
            "title": {"type": "string", "x-label": "제목", "x-editable": True},
            "content": {"type": "string", "description": "New full Markdown body.", "x-label": "본문",
                        "x-editable": True, "x-multiline": True},
        },
        "required": ["page_id"],
    },
    # 위키 공간은 다른 구성원이 읽는다 — 외부 내용을 읽은 뒤에는 자동 수락·허용 규칙이어도 묻는다
    visible_to_others=True,
    handler=notes_update, previewer=_prev_update, summarizer=_sum_note,
))

register(Tool(
    name="notes_delete",
    title="위키 페이지 삭제",
    description="Delete a wiki page permanently (the wiki has no trash; child pages move up one level). "
                "Requires the user's approval in the workspace approval inbox; returns pending_approval — "
                "check later with approvals_status.",
    scope="mcp:write", risk="high",
    parameters={"type": "object", "properties": {
        "page_id": {"type": "string", "description": "Page id.", "x-label": "페이지 id"},
    }, "required": ["page_id"]},
    # 남이 보던 것이 사라진다 — 외부 내용을 읽은 뒤에는 바이패스·오토여도 묻는다
    visible_to_others=True,
    handler=notes_delete, summarizer=_sum_note,
))
