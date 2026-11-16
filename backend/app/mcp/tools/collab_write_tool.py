"""게시판·채팅 쓰기 도구.

웹 API 와 동일한 판정 — 게시판·채팅 라우터의 엔드포인트 함수를 그대로 호출한다:
  게시판: 모듈·그룹 권한(require_module), 쓰기 권한(write_permission=admin 이면 관리자만),
          댓글 허용·댓글 권한, 삭제는 작성자·관리자만(소프트 삭제).
  채팅:   채널 권한 엔진(perms.allowed "message.send"/"message.reply", 삭제는 "message.delete").
          실시간 전달·멘션 알림도 웹과 동일한 후처리(_broadcast_message)를 거친다.
공지·필독·고정 설정은 지원하지 않는다.
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.db.models import User
from app.db.session import async_session
from app.mcp.server import Tool, register
from app.mcp.tools._common import UNDO_HINT, UNDO_TOKEN_PARAM, check_undo_token, err, http_err, undo_token

logger = logging.getLogger(__name__)


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def _handle(e: Exception) -> dict:
    he = http_err(e)
    if he:
        return he
    if isinstance(e, ValueError):
        return err("invalid_argument", str(e).splitlines()[0][:300] if str(e) else "잘못된 값입니다")
    raise e


def _get(d, k, default=None):
    return d.get(k, default) if isinstance(d, dict) else getattr(d, k, default)


# ══ 게시판 ════════════════════════════════════════════════════
async def board_create_post(user: User, board_id: str, title: str, content: str, category: str = "",
                            **_: object) -> dict:
    from app.board import router as br
    from app.board.schemas import PostCreate

    try:
        body = PostCreate(title=title, content=content, category=(category or None))
        async with async_session() as db:
            post = await br.create_post(str(board_id), body, user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    pid = _get(post, "id")
    return {"id": pid, "board_id": board_id, "title": _get(post, "title"),
            "_undo": {"tool": "board_undo_create_post",
                      "args": {"post_id": pid, "token": undo_token(user.id, "board_post", str(pid))}}}


async def board_undo_create_post(user: User, post_id: str, token: str, **_: object) -> dict:
    from app.board import router as br

    if not check_undo_token(token, user.id, "board_post", str(post_id)):
        return err("forbidden", "이 도구로 쓴 글이 아니라 지우지 않습니다")
    try:
        async with async_session() as db:
            await br.delete_post(str(post_id), user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"deleted_post": post_id}


async def board_add_comment(user: User, post_id: str, content: str, parent_id: str = "", **_: object) -> dict:
    from app.board import router as br
    from app.board.schemas import CommentCreate

    try:
        body = CommentCreate(content=content, parent_id=(parent_id or None))
        async with async_session() as db:
            c = await br.create_comment(str(post_id), body, user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    cid = _get(c, "id")
    return {"id": cid, "post_id": post_id,
            "_undo": {"tool": "board_undo_add_comment",
                      "args": {"comment_id": cid, "token": undo_token(user.id, "board_comment", str(cid))}}}


async def board_undo_add_comment(user: User, comment_id: str, token: str, **_: object) -> dict:
    from app.board import router as br

    if not check_undo_token(token, user.id, "board_comment", str(comment_id)):
        return err("forbidden", "이 도구로 쓴 댓글이 아니라 지우지 않습니다")
    try:
        async with async_session() as db:
            await br.delete_comment(str(comment_id), user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"deleted_comment": comment_id}


async def board_delete_post(user: User, post_id: str, **_: object) -> dict:
    from app.board import router as br

    try:
        async with async_session() as db:
            await br.delete_post(str(post_id), user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"deleted_post": post_id, "note": "게시글을 지웠습니다(목록에서 숨김 — 관리자 복구 기능은 없습니다)."}


# ══ 채팅 ═════════════════════════════════════════════════════
CHAT_ATTACH_MAX = 10


async def chat_send_message(user: User, channel_id: str, content: str = "", parent_id: str = "",
                            attachments: list | None = None, **_: object) -> dict:
    """글(선택) + 워크스페이스 파일 첨부(선택). 첨부는 채팅 업로드와 동일한 경로(채널 권한·50MB)로 파일 메시지가 된다."""
    import io

    from starlette.datastructures import Headers, UploadFile

    from app.chat import router as chr_
    from app.chat.schemas import MessageCreate
    from app.files import access as acc

    paths = [attachments] if isinstance(attachments, str) else [str(p) for p in (attachments or []) if p]
    if len(paths) > CHAT_ATTACH_MAX:
        return err("too_large", f"첨부는 {CHAT_ATTACH_MAX}개까지입니다")
    if not (content or "").strip() and not paths:
        return err("invalid_argument", "content 나 attachments 중 하나는 있어야 합니다")
    msg = None
    files_sent: list[dict] = []
    try:
        async with async_session() as db:
            blobs = []
            for p in paths:          # 전송 전에 전부 확인(일부만 업로드되는 것을 방지)
                vp = p.strip("/")
                try:
                    real = (await acc.resolve(db, user, vp, "view")).real
                except Exception:  # noqa: BLE001
                    return err("forbidden", f"첨부할 수 없습니다(권한 없음 또는 없는 파일): {vp}")
                if not real.is_file():
                    return err("invalid_argument", f"파일만 첨부할 수 있습니다(폴더는 files_zip 으로 묶으세요): {vp}")
                if real.stat().st_size > 50 * 1024 * 1024:
                    return err("too_large", f"{real.name}: 채팅 첨부는 50MB까지입니다")
                blobs.append(real)
            if (content or "").strip():
                body = MessageCreate(content=content, parent_id=(parent_id or None))
                msg = await chr_.send_message(str(channel_id), body, user=user, db=db)
            for real in blobs:
                import mimetypes

                up = UploadFile(file=io.BytesIO(real.read_bytes()), filename=real.name,
                                headers=Headers({"content-type": mimetypes.guess_type(real.name)[0]
                                                 or "application/octet-stream"}))
                fm = await chr_.upload_chat_file(str(channel_id), up, parent_id=(parent_id or None),
                                                 also_to_channel=False, user=user, db=db)
                files_sent.append({"id": _get(fm, "id"), "name": real.name})
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    if msg is None:
        return {"channel_id": channel_id, "files": files_sent}
    mid = _get(msg, "id")
    return {"id": mid, "channel_id": channel_id, "created_at": _iso(_get(msg, "created_at")), "files": files_sent,
            "_undo": {"tool": "chat_undo_send_message",
                      "args": {"message_id": mid, "token": undo_token(user.id, "chat_message", str(mid))}}}


async def chat_undo_send_message(user: User, message_id: str, token: str, **_: object) -> dict:
    from app.chat import router as chr_
    from app.db.models import Message

    if not check_undo_token(token, user.id, "chat_message", str(message_id)):
        return err("forbidden", "이 도구로 보낸 메시지가 아니라 지우지 않습니다")
    try:
        async with async_session() as db:
            msg = await db.get(Message, str(message_id))
            if not msg or msg.sender_id != user.id:     # 되돌리기는 본인 메시지만(관리 권한으로 타인의 메시지는 불가)
                return err("not_found", "메시지가 없습니다")
            await chr_.delete_message(str(message_id), user=user, db=db)
    except Exception as e:  # noqa: BLE001
        return _handle(e)
    return {"deleted_message": message_id}


def _clip(s: object, n: int = 60) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[:n] + "…"


register(Tool(
    name="board_create_post",
    title="게시글 작성",
    description="Write a new post on a board (Markdown/plain text). Get board ids from board_list_posts "
                "without arguments. Pinned/notice/must-read flags are not available.",
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "board_id": {"type": "string", "description": "Board id.", "x-label": "게시판", "x-hidden": True},
            "title": {"type": "string", "x-label": "제목", "x-editable": True},
            "content": {"type": "string", "x-label": "본문", "x-editable": True, "x-multiline": True},
            "category": {"type": "string", "default": "", "x-label": "분류", "x-editable": True},
        },
        "required": ["board_id", "title", "content"],
    },
    # 타인에게 노출된다 — 외부 내용을 읽은 뒤에는 자동 수락·허용 규칙이 적용되어도 확인을 요청한다(writes.request_write)
    visible_to_others=True,
    handler=board_create_post, summarizer=lambda a: _clip(a.get("title")) or "게시글",
))

register(Tool(
    name="board_undo_create_post",
    title="작성한 게시글 실행 취소",
    description="Delete a post that board_create_post just created." + UNDO_HINT,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "post_id": {"type": "string", "x-label": "게시글 id", "x-hidden": True},
        "token": UNDO_TOKEN_PARAM,
    }, "required": ["post_id", "token"]},
    handler=board_undo_create_post, summarizer=lambda a: "작성한 게시글 삭제",
))

register(Tool(
    name="board_add_comment",
    title="댓글 달기",
    description="Add a comment to a board post (max 5000 chars). Optional `parent_id` replies to a comment.",
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "post_id": {"type": "string", "description": "Post id.", "x-label": "게시글 id", "x-hidden": True},
            "content": {"type": "string", "x-label": "댓글", "x-editable": True, "x-multiline": True},
            "parent_id": {"type": "string", "default": "", "x-label": "답글 대상", "x-hidden": True},
        },
        "required": ["post_id", "content"],
    },
    # 타인에게 노출된다 — 외부 내용을 읽은 뒤에는 자동 수락·허용 규칙이 적용되어도 확인을 요청한다(writes.request_write)
    visible_to_others=True,
    handler=board_add_comment, summarizer=lambda a: f"댓글 · {_clip(a.get('content'), 40)}",
))

register(Tool(
    name="board_undo_add_comment",
    title="단 댓글 실행 취소",
    description="Delete a comment that board_add_comment just created." + UNDO_HINT,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "comment_id": {"type": "string", "x-label": "댓글 id", "x-hidden": True},
        "token": UNDO_TOKEN_PARAM,
    }, "required": ["comment_id", "token"]},
    handler=board_undo_add_comment, summarizer=lambda a: "단 댓글 삭제",
))

register(Tool(
    name="board_delete_post",
    title="게시글 삭제",
    description="Delete a board post (only the author or an admin can). Requires the user's approval in the "
                "workspace approval inbox; returns pending_approval — check later with approvals_status.",
    scope="mcp:write", risk="high",
    parameters={"type": "object", "properties": {
        "post_id": {"type": "string", "description": "Post id.", "x-label": "게시글 id"},
    }, "required": ["post_id"]},
    # 타인이 열람하던 항목이 삭제된다 — 외부 내용을 읽은 뒤에는 바이패스·오토여도 확인을 요청한다
    visible_to_others=True,
    handler=board_delete_post, summarizer=lambda a: f"게시글 {a.get('post_id', '')}",
))

register(Tool(
    name="chat_send_message",
    title="채팅 보내기",
    description="Send a message as the user to a chat channel or DM they are a member of (get ids from "
                "chat_list_channels). Optional `parent_id` posts a thread reply. Max 10000 chars. "
                "`attachments`: workspace file paths (e.g. a zip from files_zip) posted as file messages — "
                "re-checked with the user's permissions, 50 MB each, up to 10.",
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "channel_id": {"type": "string", "description": "Channel id.", "x-label": "채널", "x-hidden": True},
            "content": {"type": "string", "x-label": "메시지", "x-editable": True, "x-multiline": True},
            "parent_id": {"type": "string", "default": "", "description": "Thread parent message id.",
                          "x-label": "스레드", "x-hidden": True},
            "attachments": {"type": "array", "items": {"type": "string"}, "x-label": "첨부",
                            "description": "Workspace file paths to post (my/… or shared/…)."},
        },
        "required": ["channel_id"],
    },
    # 타인에게 노출된다 — 외부 내용을 읽은 뒤에는 자동 수락·허용 규칙이 적용되어도 확인을 요청한다(writes.request_write)
    visible_to_others=True,
    handler=chat_send_message, summarizer=lambda a: f"채팅 · {_clip(a.get('content'), 40)}",
))

register(Tool(
    name="chat_undo_send_message",
    title="보낸 채팅 실행 취소",
    description="Delete a message that chat_send_message just sent." + UNDO_HINT,
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "message_id": {"type": "string", "x-label": "메시지 id", "x-hidden": True},
        "token": UNDO_TOKEN_PARAM,
    }, "required": ["message_id", "token"]},
    handler=chat_undo_send_message, summarizer=lambda a: "보낸 채팅 삭제",
))
