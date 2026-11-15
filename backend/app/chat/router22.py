"""chat22 REST — 첨부 묶음·스레드(혼합형)·커스텀 이모지·검색·프로필·채팅 정책·보관 카테고리.

기존 router.py 엔드포인트는 그대로(하위 호환)이고,
메시지 모양(reply_to·silent·attachments·thread)은 service._message_to_dict + msg22.enrich 가 모든 경로에 붙인다.
"""

from __future__ import annotations

import json
import mimetypes
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.chat import emoji22, msg22, service
from app.chat import permissions as perms
from app.chat.schemas import (
    THREAD_ARCHIVE_MINUTES, ChatPolicyUpdate, ChatServerSettingsUpdate, EmojiRename, ProfileUpdate, ThreadPatch, ThreadStart,
)
from app.config import get_settings
from app.db.models import ChatEmoji, Message, User
from app.db.session import get_db
from app.realtime.events import emit_to_channel

router = APIRouter(prefix="/api/chat", tags=["chat22"])

MAX_FILES = 10
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_ALT = 1024


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message})


async def _broadcast_all(event: dict) -> None:
    """접속한 모든 사용자에게(워크스페이스 전역 변경 — 이모지·정책). presence 와 같은 전역 Pub/Sub 길을 쓴다."""
    try:
        from app.chat.websocket import manager
        await manager.publish_presence(event)
    except Exception:
        pass


# ─── 첨부 묶음 ───

def _image_size(path: Path) -> tuple[int, int] | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(path) as im:
            return int(im.width), int(im.height)
    except Exception:
        return None


def _safe_name(raw: str | None) -> str:
    name = os.path.basename(raw or "upload").strip()
    if not name or name.startswith(".") or "\x00" in name or ".." in name or len(name) > 255:
        raise _err(400, "bad_filename", "잘못된 파일명입니다")
    return name


def _parse_spoilers(raw: str | None, n: int) -> set[int]:
    out: set[int] = set()
    for part in (raw or "").split(","):
        part = part.strip()
        if part.isdigit() and int(part) < n:
            out.add(int(part))
    return out


def _parse_alts(raw: str | None, n: int) -> list[str | None]:
    if not raw:
        return [None] * n
    try:
        arr = json.loads(raw)
    except ValueError:
        raise _err(400, "bad_alts", "alts 는 JSON 배열 문자열입니다")
    if not isinstance(arr, list):
        raise _err(400, "bad_alts", "alts 는 JSON 배열 문자열입니다")
    out: list[str | None] = []
    for i in range(n):
        v = arr[i] if i < len(arr) else None
        out.append(str(v)[:MAX_ALT] if v not in (None, "") else None)
    return out


@router.post("/channels/{channel_id}/attachments", status_code=201)
async def upload_attachments(
    channel_id: str,
    files: list[UploadFile] = File(...),
    content: str | None = Form(None),
    spoilers: str | None = Form(None),
    alts: str | None = Form(None),
    reply_to_id: str | None = Form(None),
    reply_ping: bool = Form(True),
    silent: bool = Form(False),
    parent_id: str | None = Form(None),
    also_to_channel: bool = Form(False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """파일 1–10개 = 메시지 1개(message_type=file, attachments N). 파일당 50MB. 이미지면 width/height."""
    if not await perms.allowed(db, user, "file.upload", channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    if not files or len(files) > MAX_FILES:
        raise _err(400, "too_many_files", "파일은 한 번에 1–10개입니다")
    if parent_id:
        parent = await db.get(Message, parent_id)
        if not parent or parent.channel_id != channel_id or parent.is_deleted:
            raise _err(404, "parent_not_found", "원 메시지를 찾을 수 없습니다")
        if parent.parent_id:
            parent_id = parent.parent_id
    text = (content or "").strip()
    text, silent_prefix = msg22.split_silent(text)
    silent = silent or silent_prefix
    if len(text) > 10000:
        raise _err(400, "too_long", "본문은 10,000자까지입니다")
    try:
        await msg22.validate_reply(db, channel_id, parent_id, reply_to_id or None)
    except msg22.ReplyError as e:
        raise _err(400, e.code, e.message)

    spoiler_idx = _parse_spoilers(spoilers, len(files))
    alt_list = _parse_alts(alts, len(files))
    root = Path(get_settings().storage_root) / "chat_files" / channel_id
    root.mkdir(parents=True, exist_ok=True)
    written_paths: list[Path] = []
    items: list[dict] = []
    try:
        for i, f in enumerate(files):
            name = _safe_name(f.filename)
            disk_name = f"{uuid.uuid4().hex[:8]}_{name}"
            target = root / disk_name
            size = 0
            with open(target, "wb") as out:
                written_paths.append(target)
                while chunk := await f.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise _err(413, "too_large", f"파일 크기가 50MB를 초과합니다: {name}")
                    out.write(chunk)
            mime = f.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
            item = {
                "id": uuid.uuid4().hex[:12],
                "filename": name,
                "size": size,
                "mime_type": mime,
                "url": f"/api/chat/channels/{channel_id}/files/{disk_name}",
                "disk_name": disk_name,
                "spoiler": i in spoiler_idx,
                "alt": alt_list[i],
            }
            if mime.startswith("image/"):
                wh = _image_size(target)
                if wh:
                    item["width"], item["height"] = wh
            items.append(item)
    except BaseException:
        for pth in written_paths:
            pth.unlink(missing_ok=True)
        raise

    first = items[0]
    # 옛 프런트 호환 — file_meta 는 첫 파일(단일 파일 메시지와 같은 모양)
    file_meta = json.dumps({k: first[k] for k in ("filename", "size", "mime_type", "url", "disk_name")},
                           ensure_ascii=False)
    msg = await service.create_message(
        db, channel_id, user.id, text,
        message_type="file", file_meta=file_meta,
        parent_id=parent_id, thread_broadcast=also_to_channel,
        reply_to_id=reply_to_id or None,
        flags=msg22.make_flags(silent=silent, reply_ping=bool(reply_to_id and reply_ping)),
        attachments=json.dumps(items, ensure_ascii=False),
    )
    from app.chat.notify import after_message_created
    await after_message_created(db, msg, channel_id, user.id, text)
    return msg


# ─── 스레드(혼합형) ───

async def _root_or_404(db: AsyncSession, message_id: str) -> Message:
    m = await db.get(Message, message_id)
    if m is None or m.is_deleted:
        raise _err(404, "not_found", "메시지를 찾을 수 없습니다")
    if m.parent_id is not None:
        raise _err(400, "not_root", "스레드는 채널의 원 메시지에서만 시작합니다")
    if m.message_type == "system":
        raise _err(400, "system_message", "시스템 메시지에서는 스레드를 시작할 수 없습니다")
    return m


async def _thread_dict(db: AsyncSession, m: Message) -> dict:
    sender = await db.get(User, m.sender_id) if m.sender_id else None
    d = service._message_to_dict(m, sender)
    await msg22.enrich(db, [(m, d)])
    if d.get("thread") is None:
        d["thread"] = msg22.thread_meta_of(m, 0, None, None)
    return d


@router.post("/messages/{message_id}/thread")
async def start_thread(
    message_id: str,
    body: ThreadStart | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """답글 없이 스레드만 시작(+ 이름). 이미 있는 스레드에 이름을 붙이는 건 루트 작성자·MANAGE_THREADS."""
    m = await _root_or_404(db, message_id)
    if not await perms.allowed(db, user, "message.reply", m.channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    name = ((body.name if body else None) or "").strip() or None
    exists = m.thread_started_at is not None or (await service.get_thread_reply_count(db, [m.id])).get(m.id)
    if exists and name is not None:
        from app.chat.perm_compat import can_manage_thread
        ch = await service.get_channel(db, m.channel_id)
        if not await can_manage_thread(db, user, ch, m):
            raise _err(403, "forbidden", "스레드 이름을 바꿀 권한이 없습니다")
    now = datetime.now(timezone.utc)
    if m.thread_started_at is None:
        m.thread_started_at = now
    if name is not None:
        m.thread_name = name
    m.thread_activity_at = now
    await service.ensure_thread_follows(db, m.id, m.channel_id, [user.id], refollow=True)
    await db.commit()
    await db.refresh(m)
    d = await _thread_dict(db, m)
    await emit_to_channel(m.channel_id, {"type": "message_update", "message": d})
    return d["thread"]


@router.patch("/messages/{message_id}/thread")
async def patch_thread(
    message_id: str,
    body: ThreadPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이름·보관·자동 보관 — 루트 작성자 또는 MANAGE_THREADS(perm_compat.can_manage_thread)."""
    m = await _root_or_404(db, message_id)
    ch = await service.get_channel(db, m.channel_id)
    if not await perms.allowed(db, user, "channel.view", ch):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    from app.chat.perm_compat import can_manage_thread
    if not await can_manage_thread(db, user, ch, m):
        raise _err(403, "forbidden", "스레드를 관리할 권한이 없습니다")
    fields = body.model_fields_set
    if not fields:
        raise _err(400, "empty", "변경할 내용이 없습니다")
    now = datetime.now(timezone.utc)
    if "auto_archive_minutes" in fields and body.auto_archive_minutes is not None:
        if body.auto_archive_minutes not in THREAD_ARCHIVE_MINUTES:
            raise _err(400, "bad_auto_archive", "자동 보관은 60·1440·4320·10080분 중 하나입니다")
        m.thread_auto_archive_minutes = body.auto_archive_minutes
    if "name" in fields:
        m.thread_name = (body.name or "").strip() or None
    if "archived" in fields and body.archived is not None:
        if body.archived:
            m.thread_archived_at = m.thread_archived_at or now
        else:
            m.thread_archived_at = None
            m.thread_activity_at = now   # 되살리면 자동 보관 시계도 다시
    if m.thread_started_at is None:
        m.thread_started_at = now
    await db.commit()
    await db.refresh(m)
    d = await _thread_dict(db, m)
    await emit_to_channel(m.channel_id, {"type": "message_update", "message": d})
    return d["thread"]


@router.get("/channels/{channel_id}/threads")
async def list_channel_threads(
    channel_id: str,
    archived: bool = Query(False),
    limit: int = Query(25, ge=1, le=100),
    before: str | None = Query(None, description="ISO 시각 — 이보다 이전 활동(다음 페이지)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await service.get_channel(db, channel_id)
    if ch is None:
        raise HTTPException(404, "채널을 찾을 수 없습니다")
    if not await perms.allowed(db, user, "message.read", ch):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    cursor = None
    if before:
        try:
            cursor = datetime.fromisoformat(before.replace("Z", "+00:00"))
        except ValueError:
            raise _err(400, "bad_before", "before 는 ISO 시각입니다")
        if cursor.tzinfo is None:
            cursor = cursor.replace(tzinfo=timezone.utc)
    from app.chat import messages22
    return await messages22.list_channel_threads(db, ch, user.id, archived=archived, limit=limit, before=cursor)


# ─── 커스텀 이모지 ───

async def _creators(db: AsyncSession, rows: list[ChatEmoji]) -> dict[str, User]:
    ids = {e.created_by for e in rows if e.created_by}
    if not ids:
        return {}
    return {u.id: u for u in (await db.execute(select(User).where(User.id.in_(ids)))).scalars()}


@router.get("/emojis")
async def list_emojis(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.chat.perm_compat import can_manage_expressions
    rows = list((await db.execute(select(ChatEmoji).order_by(ChatEmoji.name))).scalars())
    users = await _creators(db, rows)
    return {
        "items": [emoji22.to_dict(e, users.get(e.created_by or "")) for e in rows],
        "can_manage": await can_manage_expressions(db, user),
        "limit": emoji22.MAX_EMOJIS,
    }


async def _require_expressions(db: AsyncSession, user) -> None:
    from app.chat.perm_compat import can_manage_expressions
    if not await can_manage_expressions(db, user):
        raise _err(403, "forbidden", "이모지를 관리할 권한이 없습니다")


@router.post("/emojis", status_code=201)
async def create_emoji(
    file: UploadFile = File(...),
    name: str = Form(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_expressions(db, user)
    try:
        n = emoji22.check_name(name)
        if await emoji22.name_taken(db, n):
            raise emoji22.EmojiError(409, "name_taken", "같은 이름의 이모지가 있습니다")
        if await emoji22.count(db) >= emoji22.MAX_EMOJIS:
            raise emoji22.EmojiError(400, "limit_reached", f"이모지는 {emoji22.MAX_EMOJIS}개까지입니다")
        raw = await file.read(emoji22.MAX_BYTES + 1)
        data, ctype, animated = emoji22.normalize(raw)
    except emoji22.EmojiError as e:
        raise _err(e.status, e.code, e.message)
    e = ChatEmoji(id=str(uuid.uuid4()), name=n, content_type=ctype, data=data, animated=animated,
                  created_by=user.id)
    db.add(e)
    await db.commit()
    await db.refresh(e)
    from app.admin.audit import log_action
    await log_action(db, user.id, "chat.emoji.create", "chat_emoji", e.id, {"name": n})
    out = emoji22.to_dict(e, user)
    await _broadcast_all({"type": "emoji_update", "action": "create", "emoji": out})
    return out


@router.patch("/emojis/{emoji_id}")
async def rename_emoji(
    emoji_id: str,
    body: EmojiRename,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_expressions(db, user)
    e = await db.get(ChatEmoji, emoji_id)
    if e is None:
        raise _err(404, "not_found", "이모지를 찾을 수 없습니다")
    try:
        n = emoji22.check_name(body.name)
        if await emoji22.name_taken(db, n, exclude_id=e.id):
            raise emoji22.EmojiError(409, "name_taken", "같은 이름의 이모지가 있습니다")
    except emoji22.EmojiError as err:
        raise _err(err.status, err.code, err.message)
    before = e.name
    e.name = n
    await db.commit()
    await db.refresh(e)
    from app.admin.audit import log_action
    await log_action(db, user.id, "chat.emoji.rename", "chat_emoji", e.id, {"from": before, "to": n})
    creator = await db.get(User, e.created_by) if e.created_by else None
    out = emoji22.to_dict(e, creator)
    await _broadcast_all({"type": "emoji_update", "action": "update", "emoji": out})
    return out


@router.delete("/emojis/{emoji_id}")
async def delete_emoji(emoji_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _require_expressions(db, user)
    e = await db.get(ChatEmoji, emoji_id)
    if e is None:
        raise _err(404, "not_found", "이모지를 찾을 수 없습니다")
    name = e.name
    await db.delete(e)
    await db.commit()
    from app.admin.audit import log_action
    await log_action(db, user.id, "chat.emoji.delete", "chat_emoji", emoji_id, {"name": name})
    await _broadcast_all({"type": "emoji_update", "action": "delete", "emoji": {"id": emoji_id, "name": name}})
    return {"ok": True}


@router.get("/emojis/{emoji_id}/image")
async def emoji_image(emoji_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    e = await db.get(ChatEmoji, emoji_id)
    if e is None or e.content_type not in emoji22._FORMATS.values():
        raise HTTPException(404, "없습니다")
    return Response(content=e.data, media_type=e.content_type, headers={
        # url 에 ?v=<수정 시각> 이 붙어 있어 내용이 바뀌면 주소가 바뀐다 → 길게 캐시
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline",
    })


# ─── 검색(오른쪽 자리) ───

@router.get("/search")
async def search(
    q: str = Query("", max_length=500),
    from_: str | None = Query(None, alias="from"),
    mentions: str | None = Query(None),
    in_: str | None = Query(None, alias="in"),
    has: str | None = Query(None, description="link,file,image,video,sound,embed (쉼표)"),
    before: str | None = Query(None),
    after: str | None = Query(None),
    during: str | None = Query(None),
    pinned: bool | None = Query(None),
    sort: str = Query("new", pattern=r"^(new|old)$"),
    offset: int = Query(0, ge=0, le=10000),
    limit: int = Query(25, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.chat import messages22
    has_list = [h.strip().lower() for h in (has or "").split(",") if h.strip()]
    try:
        return await messages22.search(
            db, user, q=q, from_user=from_, mentions=mentions, in_channel=in_, has=has_list,
            before=before, after=after, during=during, pinned=pinned, sort=sort, offset=offset, limit=limit,
        )
    except messages22.SearchError as e:
        raise _err(400, "bad_filter", str(e))


# ─── 프로필 팝아웃 ───

@router.get("/users/{target_id}/profile")
async def user_profile(target_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    u = await db.get(User, target_id)
    if u is None or not u.is_active:
        raise _err(404, "not_found", "사용자를 찾을 수 없습니다")
    presence = custom = None
    try:
        from app.chat.presence import custom_status, get_status, presence_entry
        from app.realtime.events import is_connected
        st = await get_status(db, u.id)
        presence = presence_entry(st, await is_connected(u.id))
        emoji, text = custom_status(st)
        custom = {"emoji": emoji, "text": text} if (emoji or text) else None
    except Exception:
        presence = None
    return {
        "id": u.id,
        "username": u.username,
        "display_name": u.display_name,
        "avatar_url": u.avatar_url,
        # 직함·부서 — 지금 사용자·조직 데이터에 없다(연락처는 개인 주소록). 컬럼이 생기면 그대로 싣는다.
        "job_title": getattr(u, "job_title", None),
        "department": getattr(u, "department", None),
        "bio": u.bio,
        "timezone": u.timezone,
        "presence": presence,
        "custom_status": custom,
        "is_me": u.id == user.id,
    }


@router.patch("/me/profile")
async def update_my_profile(body: ProfileUpdate, user: User = Depends(get_current_user),
                            db: AsyncSession = Depends(get_db)):
    fields = body.model_fields_set
    if not fields:
        raise _err(400, "empty", "변경할 내용이 없습니다")
    me = await db.get(User, user.id)
    if "bio" in fields:
        me.bio = (body.bio or "").strip() or None
    if "timezone" in fields:
        tzname = (body.timezone or "").strip() or None
        if tzname:
            try:
                from zoneinfo import ZoneInfo
                ZoneInfo(tzname)
            except Exception:
                raise _err(400, "bad_timezone", "알 수 없는 시간대입니다(예: Asia/Seoul)")
        me.timezone = tzname
    await db.commit()
    return {"bio": me.bio, "timezone": me.timezone}


# ─── 채팅 정책(관리자 토글) ───

@router.get("/policy")
async def get_chat_policy(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.chat import policy
    return {**await policy.get_policy(db), "can_edit": bool(user.is_admin)}


@router.put("/policy")
async def put_chat_policy(body: ChatPolicyUpdate, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    if not user.is_admin:
        raise _err(403, "forbidden", "전역 관리자만 바꿀 수 있습니다")
    from app.chat import policy
    changes = {k: getattr(body, k) for k in body.model_fields_set if getattr(body, k) is not None}
    if not changes:
        raise _err(400, "empty", "변경할 내용이 없습니다")
    out = await policy.set_policy(db, user.id, changes)
    await _broadcast_all({"type": "chat_policy_changed", **out})
    return {**out, "can_edit": True}


# ─── 보관 시스템 카테고리 ───

@router.get("/layout/meta")
async def layout_meta(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.chat.archive22 import ensure_archive_category
    return {"archive_category_id": await ensure_archive_category(db)}


# ─── 채팅 서버 설정(개요·알림 기본값) ───

async def _can_edit_server(db: AsyncSession, user) -> bool:
    if getattr(user, "is_admin", False):
        return True
    try:
        bits = await perms.guarded(db, lambda: perms.workspace_permissions(db, user))
    except Exception:
        return False
    return bool(bits & (perms.MANAGE_CHANNELS | perms.ADMINISTRATOR))


@router.get("/server-settings")
async def get_server_settings(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.chat import server22
    return {**await server22.refresh(db), "can_edit": await _can_edit_server(db, user)}


@router.put("/server-settings")
async def put_server_settings(body: ChatServerSettingsUpdate, user: User = Depends(get_current_user),
                              db: AsyncSession = Depends(get_db)):
    if not await _can_edit_server(db, user):
        raise _err(403, "forbidden", "채팅 서버 설정을 바꿀 권한이 없습니다")
    fields = body.model_fields_set
    if not fields:
        raise _err(400, "empty", "변경할 내용이 없습니다")
    from app.chat import server22
    changes = {k: (getattr(body, k).strip() if isinstance(getattr(body, k), str) else getattr(body, k))
               for k in fields}
    out = await server22.update(db, user.id, changes)
    await _broadcast_all({"type": "chat_server_settings_changed", **out})
    return {**out, "can_edit": True}
