"""협업 읽기 도구 — 채팅 · 게시판.

전부 **읽기 전용**(mcp:read). 쓰기는 승인 게이트(B단계) 이후에 연다.

★ 채팅은 접근 통제가 특히 중요하다. 채널 목록은 서비스가 사용자 기준으로
걸러주지만, **메시지 조회는 channel_id 만 받으므로 멤버십을 직접 확인해야 한다.**
확인을 빼면 채널 id 만 알면 남의 비공개 대화를 읽을 수 있다.
"""

import logging
from datetime import datetime

from app.board import service as board_svc
from app.chat import service as chat_svc
from app.db.models import User
from app.db.session import async_session
from app.mcp.server import Tool, register
from app.mcp.tools._common import (
    CURSOR_PARAM, PAGINATION_HINT, clamp, drop_empty, err, fit_page, query_hash, read_cursor, shorten,
)

logger = logging.getLogger(__name__)

_MAX_ITEMS = 100


def _iso(v):
    """서비스 계층이 datetime 을 그대로 돌려주는 필드가 있다(채널 created_at 등)."""
    return v.isoformat() if isinstance(v, datetime) else v


async def chat_list_channels(user: User, limit: int = 100, cursor: str = "", **_: object) -> dict:
    """사용자가 속한 채널 목록."""
    n = clamp(limit, 1, _MAX_ITEMS, _MAX_ITEMS)
    qh = query_hash("chat_list_channels")
    off, cerr = read_cursor(cursor, qh)
    if cerr:
        return cerr
    async with async_session() as db:
        chans = await chat_svc.get_user_channels(db, user.id)
    window = chans[off:off + n]
    rows = [
        drop_empty({
            "id": c.get("id"),
            "name": c.get("name"),
            "type": c.get("type"),
            "description": shorten(c.get("description"), 120),
            "unread": c.get("unread_count") or None,
        })
        for c in window
    ]
    return fit_page(rows, offset=off, total=len(chans), list_key="channels", qhash=qh)


def _oldest_id(msgs: list) -> str | None:
    if not msgs:
        return None
    if any(m.get("seq") is not None for m in msgs):
        return min(msgs, key=lambda m: m.get("seq") or 0).get("id")
    return msgs[0].get("id")


_MSG_MAX = 2_000   # 메시지 하나의 본문 상한(글자) — 나머지는 예산 맞추기가 처리


async def chat_read_messages(
    user: User, channel_id: str, limit: int = 50, cursor: str = "", **_: object
) -> dict:
    """채널 메시지(최신 페이지부터). ``cursor`` 를 주면 그보다 **이전** 메시지. 멤버가 아니면 거부.

    예산을 넘으면 **최신 메시지를 남기고** 오래된 쪽을 덜어 낸다. 그때 next_cursor 는 실제로 담은 것 중
    가장 오래된 메시지 id 라서, 이어 부르면 덜어 낸 메시지부터 나온다(건너뜀 없음).
    """
    n = clamp(limit, 1, _MAX_ITEMS, 50)
    async with async_session() as db:
        # ★ 멤버십 확인 — get_messages 는 channel_id 만 받고 권한을 보지 않는다.
        if not await chat_svc.is_channel_member(db, channel_id, user.id):
            return err("forbidden", "이 채널의 멤버가 아닙니다")
        msgs, has_more = await chat_svc.get_messages(db, channel_id, before=(cursor or None), limit=n)
    # 서비스는 오래된 → 최신 순(seq 오름차순)으로 준다
    rows = []
    for m in msgs:
        content = m.get("content")
        r = drop_empty({
            "id": m.get("id"),
            "sender": (m.get("sender") or {}).get("display_name")
            or (m.get("sender") or {}).get("username"),
            "content": shorten(content, _MSG_MAX),
            "created_at": _iso(m.get("created_at")),
            "parent_id": m.get("parent_id"),
        })
        if isinstance(content, str) and len(content) > _MSG_MAX:
            r["shortened"] = ["content"]
        rows.append(r)
    return fit_page(rows, total=None, list_key="messages", has_more=bool(has_more), keep="tail",
                    cursor_of=lambda kept: kept[0].get("id") if kept else None,
                    extras={"channel_id": channel_id})


async def board_list_posts(
    user: User, board_id: str = "", limit: int = 20, cursor: str = "", **_: object
) -> dict:
    """게시판 글 목록. board_id 가 없으면 게시판 목록을 돌려준다."""
    n = clamp(limit, 1, _MAX_ITEMS, 20)
    qh = query_hash("board_list_posts", board_id)
    off, cerr = read_cursor(cursor, qh)
    if cerr:
        return cerr
    async with async_session() as db:
        if not board_id:
            boards = await board_svc.get_boards(db)
            rows = [drop_empty({"id": b.get("id"), "name": b.get("name"), "slug": b.get("slug")})
                    for b in boards]
            window = rows[off:]
            return fit_page(window, offset=off, total=len(rows), list_key="boards", qhash=qh,
                            extras={"hint": "board_id 를 지정하면 그 게시판의 글 목록을 돌려준다"})
        page, skip = divmod(off, n)
        data = await board_svc.get_posts(db, board_id, page=page + 1, page_size=n)
    posts = (data.get("posts") or [])[skip:]
    rows = [
        drop_empty({
            "id": p.get("id"),
            "title": p.get("title"),
            "author": (p.get("author") or {}).get("display_name"),
            "created_at": _iso(p.get("created_at")),
            "view_count": p.get("view_count"),
        })
        for p in posts
    ]
    extras: dict = {"board_id": board_id}
    # 고정글은 첫 페이지에만 따로 붙인다(페이지마다 반복되면 중복으로 보이고, offset 계산에도 안 들어간다)
    if off == 0 and data.get("pinned"):
        extras["pinned"] = [
            drop_empty({"id": p.get("id"), "title": shorten(p.get("title"), 120),
                        "author": (p.get("author") or {}).get("display_name"),
                        "created_at": _iso(p.get("created_at"))})
            for p in (data.get("pinned") or [])[:20]
        ]
    return fit_page(rows, offset=off, total=int(data.get("total") or 0), list_key="posts", qhash=qh,
                    extras=extras)


async def board_search(
    user: User, query: str, board_id: str = "", limit: int = 20, cursor: str = "", **_: object
) -> dict:
    """제목/본문으로 게시글을 검색한다."""
    if not (query or "").strip():
        return err("invalid_argument", "query 가 비었습니다")
    n = clamp(limit, 1, _MAX_ITEMS, 20)
    qh = query_hash("board_search", query.strip(), board_id)
    off, cerr = read_cursor(cursor, qh)
    if cerr:
        return cerr
    page, skip = divmod(off, n)
    async with async_session() as db:
        data = await board_svc.search_posts(
            db, query, board_id=(board_id or None), page=page + 1, page_size=n
        )
    posts = (data.get("posts") or [])[skip:]
    rows = [
        drop_empty({
            "id": p.get("id"),
            "title": p.get("title"),
            "board": (p.get("board") or {}).get("name") or p.get("board_name"),
            "author": (p.get("author") or {}).get("display_name"),
            "created_at": _iso(p.get("created_at")),
        })
        for p in posts
    ]
    return fit_page(rows, offset=off, total=int(data.get("total") or 0), list_key="posts", qhash=qh,
                    extras={"query": query})


async def board_read_post(user: User, post_id: str, **_: object) -> dict:
    """게시글 본문을 읽는다."""
    async with async_session() as db:
        # ※ get_post 는 조회수를 1 올린다(원래 화면 조회용 함수다). "글을 봤다" 는 의미라 그대로 둔다.
        post = await board_svc.get_post(db, post_id)
    if not post:
        return err("not_found", f"게시글이 없습니다: {post_id}")
    return {
        "id": post.get("id"),
        # 앱 안 링크(/board/{board_id}/{id}) — 내장 AI 출처 칩
        "board_id": post.get("board_id"),
        "title": post.get("title"),
        "content": post.get("content"),
        "author": (post.get("author") or {}).get("display_name"),
        "created_at": _iso(post.get("created_at")),
    }


register(Tool(
    name="chat_list_channels",
    description=(
        "List chat channels the user belongs to (public, private and DMs). "
        "Use this first to find a channel id before reading messages." + PAGINATION_HINT
    ),
    parameters={"type": "object", "properties": {
        "limit": {"type": "integer", "description": "Channels per page (default 100, max 100).", "default": 100},
        "cursor": CURSOR_PARAM,
    }},
    # 남이 쓴 글 조각이 섞인다 — 내장 AI 대화 표시만 남긴다(conv_untrusted: MCP 15분 창·래핑 없음)
    handler=chat_list_channels, conv_untrusted=True,
))

register(Tool(
    name="chat_read_messages",
    description=(
        "Read recent messages in a chat channel the user is a member of. "
        "Get the channel id from chat_list_channels first. Returns the newest page (oldest→newest); "
        "the response starts with `returned`, `has_more`, `next_cursor`, `truncated`. When `has_more` "
        "is true pass `next_cursor` as `cursor` to get OLDER messages. `truncated: true` means older "
        "messages were left out to keep the response small — they come next via `next_cursor`."
    ),
    parameters={
        "type": "object",
        "properties": {
            "channel_id": {"type": "string", "description": "Channel id from chat_list_channels."},
            "limit": {"type": "integer", "description": "Messages per page (default 50, max 100).", "default": 50},
            "cursor": {"type": "string", "description": "`next_cursor` from the previous page to get OLDER messages. Empty = newest.", "default": ""},
        },
        "required": ["channel_id"],
    },
    # 남이 쓴 글이 들어 있다 — 신뢰 경계로 감싸고, 직후의 쓰기는 승인 흐름이 경고·자동 실행 금지로 다룬다
    handler=chat_read_messages, untrusted_output=True,
))

register(Tool(
    name="board_list_posts",
    description=(
        "List posts on a board. Call without board_id to get the list of boards first, "
        "then pass a board_id to list its posts." + PAGINATION_HINT
    ),
    parameters={
        "type": "object",
        "properties": {
            "board_id": {"type": "string", "description": "Board id. Empty returns the board list."},
            "limit": {"type": "integer", "description": "Posts per page (default 20, max 100).", "default": 20},
            "cursor": CURSOR_PARAM,
        },
    },
    # 남이 쓴 글 조각이 섞인다 — 내장 AI 대화 표시만 남긴다(conv_untrusted: MCP 15분 창·래핑 없음)
    handler=board_list_posts, conv_untrusted=True,
))

register(Tool(
    name="board_search",
    description="Search board posts by title and content across boards (or within one board)." + PAGINATION_HINT,
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search term."},
            "board_id": {"type": "string", "description": "Limit to one board. Empty = all boards."},
            "limit": {"type": "integer", "description": "Results per page (default 20, max 100).", "default": 20},
            "cursor": CURSOR_PARAM,
        },
        "required": ["query"],
    },
    # 남이 쓴 글이 들어 있다 — 신뢰 경계로 감싸고, 직후의 쓰기는 승인 흐름이 경고·자동 실행 금지로 다룬다
    handler=board_search, untrusted_output=True,
))

register(Tool(
    name="board_read_post",
    description="Read the full body of a board post. Get the post id from board_list_posts or board_search.",
    parameters={
        "type": "object",
        "properties": {
            "post_id": {"type": "string", "description": "Post id."},
        },
        "required": ["post_id"],
    },
    # 남이 쓴 글이 들어 있다 — 신뢰 경계로 감싸고, 직후의 쓰기는 승인 흐름이 경고·자동 실행 금지로 다룬다
    handler=board_read_post, untrusted_output=True,
))
