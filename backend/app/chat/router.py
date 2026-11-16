"""Chat REST API endpoints."""

import json
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.chat import service
from app.chat import permissions as perms
from app.chat.websocket import manager
from app.chat.schemas import (
    ChannelCreate,
    ChannelPrefsUpdate,
    ChannelUpdate,
    DMRequest,
    DraftUpsert,
    MarkUnreadRequest,
    MemberAdd,
    MessageCreate,
    MessageUpdate,
    NotificationReadRequest,
    ReactionToggle,
    ThreadReadRequest,
    UserStatusUpdate,
)
from app.realtime.events import emit_to_channel, emit_to_user

router = APIRouter(prefix="/api/chat", tags=["chat"])


# ─── Channels ───

@router.get("/channels")
async def list_channels(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    channels = await service.get_user_channels(db, user.id)
    return channels


@router.post("/channels", status_code=201)
async def create_channel(
    body: ChannelCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    board_id = None
    if body.forum:
        from app.chat.forum22 import resolve_forum_board
        board_id = await resolve_forum_board(db, user, body.name, body.description, body.board_id)
    ch = await service.create_channel(
        db,
        name=body.name,
        type=body.type,
        created_by=user.id,
        description=body.description,
        member_ids=body.member_ids,
        voice=body.voice and not body.forum,
        forum_board_id=board_id,
    )
    await manager.notify_channels_changed([user.id, *(body.member_ids or [])])
    return {"id": ch.id, "name": ch.name, "type": ch.type, "is_voice": bool(ch.is_voice),
            "forum_board_id": ch.forum_board_id}


@router.get("/channels/{channel_id}")
async def get_channel(
    channel_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ch = await service.get_channel(db, channel_id)
    if not ch:
        raise HTTPException(404, "채널을 찾을 수 없습니다")
    if not await perms.allowed(db, user, "channel.view", ch):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    members = await service.get_channel_members(db, channel_id)
    return {
        "id": ch.id,
        "name": ch.name,
        "type": ch.type,
        "description": ch.description,
        "created_by": ch.created_by,
        "is_archived": ch.is_archived,
        "is_voice": bool(ch.is_voice),
        "forum_board_id": ch.forum_board_id,
        "default_thread_auto_archive_minutes": ch.default_thread_auto_archive_minutes or 4320,
        "created_at": ch.created_at,
        "updated_at": ch.updated_at,
        "member_count": len(members),
        "members": members,
    }


@router.patch("/channels/{channel_id}")
async def update_channel(
    channel_id: str,
    body: ChannelUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not await perms.allowed(db, user, "channel.manage", channel_id):
        raise HTTPException(403, "권한이 없습니다")
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "변경할 내용이 없습니다")
    from app.chat.schemas import THREAD_ARCHIVE_MINUTES
    if updates.get("default_thread_auto_archive_minutes", 4320) not in THREAD_ARCHIVE_MINUTES:
        raise HTTPException(400, {"code": "bad_auto_archive", "message": "자동 보관은 60·1440·4320·10080분 중 하나입니다"})
    ch = await service.update_channel(db, channel_id, **updates)
    if not ch:
        raise HTTPException(404, "채널을 찾을 수 없습니다")
    return {"ok": True}


@router.delete("/channels/{channel_id}")
async def delete_channel(
    channel_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not await perms.allowed(db, user, "channel.delete", channel_id):
        raise HTTPException(403, "채널 소유자만 삭제할 수 있습니다")
    members = [m["user_id"] for m in await service.get_channel_members(db, channel_id)]
    ch = await service.get_channel(db, channel_id)
    was_voice = bool(ch and ch.is_voice)
    await service.delete_channel(db, channel_id)
    if was_voice:
        # 음성 방이 열려 있으면 종료하고 접속 상태를 삭제한다(실패해도 채널 삭제는 이미 완료됨)
        from app.chat import voice
        await voice.close_channel(channel_id)
    await manager.notify_channels_changed(members)
    return {"ok": True}


# ─── Members ───

@router.get("/channels/{channel_id}/members")
async def list_members(
    channel_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not await perms.allowed(db, user, "channel.view", channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    return await service.get_channel_members(db, channel_id)


@router.post("/channels/{channel_id}/members", status_code=201)
async def add_members(
    channel_id: str,
    body: MemberAdd,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not await perms.allowed(db, user, "member.invite", channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    added = await service.add_members(db, channel_id, body.user_ids)
    await manager.notify_channels_changed(body.user_ids)
    return {"added": added}


@router.delete("/channels/{channel_id}/members/{target_user_id}")
async def remove_member(
    channel_id: str,
    target_user_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Can remove self, or admin/owner can remove others
    if target_user_id != user.id:
        if not await perms.allowed(db, user, "member.kick", channel_id):
            raise HTTPException(403, "권한이 없습니다")
    # 마지막 멤버가 나가면 누구도 입장할 수 없는 고아 채널(메시지·파일)이 남음 — 나가기 대신 삭제를 사용하도록 유도
    members = await service.get_channel_members(db, channel_id)
    if len(members) == 1 and members[0]["user_id"] == target_user_id:
        raise HTTPException(409, "마지막 멤버는 채널을 나갈 수 없습니다 — 채널 삭제를 쓰세요")
    ok = await service.remove_member(db, channel_id, target_user_id)
    if not ok:
        raise HTTPException(404, "멤버를 찾을 수 없습니다")
    await manager.notify_channels_changed([target_user_id])
    return {"ok": True}


# ─── Messages ───

@router.get("/channels/{channel_id}/messages")
async def list_messages(
    channel_id: str,
    before: str | None = Query(None),
    after: str | None = Query(None),
    before_seq: int | None = Query(None, ge=0),
    after_seq: int | None = Query(None, ge=0),
    around: str | None = Query(None, description="이 메시지 id 를 가운데로(원문 점프, chat22)"),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """한 페이지 조회. has_more = 해당 방향(기본 위쪽, after 지정 시 아래쪽)에 추가 항목 존재, has_more_after = 아래쪽(최근 방향)에 추가 항목 존재."""
    if not await perms.allowed(db, user, "message.read", channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    from app.chat import messages22
    if not isinstance(around, str):   # 테스트에서 함수를 직접 호출하면 Query 기본값 객체가 전달됨
        around = None
    if around:
        res = await messages22.get_messages_around(db, channel_id, around, limit, user.id)
        if res is None:
            raise HTTPException(404, "메시지를 찾을 수 없습니다")
        return res
    messages, has_more = await service.get_messages(
        db, channel_id, before=before, after=after, limit=limit,
        before_seq=before_seq, after_seq=after_seq, user_id=user.id,
    )
    forward = after is not None or after_seq is not None
    has_more_after = has_more if forward else await messages22.has_newer(db, channel_id, messages)
    return {"messages": messages, "has_more": has_more, "has_more_after": has_more_after}


@router.get("/changes")
async def list_changes(
    since_seq: int = Query(..., ge=0),
    limit: int = Query(500, ge=1, le=1000),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """재접속 복구 — 호출 사용자의 모든 채널에서 since_seq 이후 생성된 메시지.

    `too_many` 인 경우 목록은 비어 있으며 클라이언트는 채널 목록·열린 채널을 다시 조회한다.
    """
    return await service.get_changes_since(db, user.id, since_seq, limit)


@router.get("/latest-seq")
async def latest_seq(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """클라이언트가 복구 커서를 최초 설정할 때 사용한다."""
    return {"seq": await service.get_latest_seq(db)}


async def _broadcast_message(db, channel_id: str, sender_id: str, content: str, msg) -> None:
    """생성된 메시지의 후처리(실시간 전달·멘션 알림·DM 푸시). WS 경로와 동일한 함수를 사용한다."""
    from app.chat.notify import after_message_created
    await after_message_created(db, msg, channel_id, sender_id, content)


@router.post("/channels/{channel_id}/messages", status_code=201)
async def send_message(
    channel_id: str,
    body: MessageCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    action = "message.reply" if body.parent_id else "message.send"
    if not await perms.allowed(db, user, action, channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    from app.chat import msg22
    content, silent_prefix = msg22.split_silent(body.content)
    silent = body.silent or silent_prefix
    if not content.strip():
        raise HTTPException(400, {"code": "empty", "message": "보낼 내용이 없습니다"})
    try:
        await msg22.validate_reply(db, channel_id, body.parent_id, body.reply_to_id)
    except msg22.ReplyError as e:
        raise HTTPException(400, {"code": e.code, "message": e.message})
    msg = await service.create_message(
        db, channel_id, user.id, content,
        message_type=body.message_type, file_meta=body.file_meta,
        parent_id=body.parent_id, thread_broadcast=body.also_to_channel,
        reply_to_id=body.reply_to_id,
        flags=msg22.make_flags(silent=silent, reply_ping=bool(body.reply_to_id and body.reply_ping)),
    )
    await _broadcast_message(db, channel_id, user.id, content, msg)
    return msg


@router.post("/channels/{channel_id}/unread")
async def mark_channel_unread(
    channel_id: str,
    body: MarkUnreadRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """"여기부터 안 읽음" — 읽음 포인터를 해당 메시지 직전으로 되돌린다. 본인의 다른 기기에는 channel_unread 를 전달한다."""
    if not await perms.allowed(db, user, "channel.participate", channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    seq = await service.mark_unread(db, channel_id, user.id, body.message_id)
    if seq is None:
        raise HTTPException(404, "메시지를 찾을 수 없습니다")
    state = await service.get_unread_state(db, user.id, channel_id)
    await emit_to_user(user.id, {
        "type": "channel_unread", "channel_id": channel_id, "seq": seq, **state,
    })
    return {"ok": True, "channel_id": channel_id, "last_read_seq": seq, **state}


@router.patch("/channels/{channel_id}/prefs")
async def update_channel_prefs(
    channel_id: str,
    body: ChannelPrefsUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """채널별 알림 수준(all|mentions|none)·음소거·기기 알림 세부(desktop/push/email/thread_replies).
    본인의 멤버행만 변경된다."""
    has_minutes = "muted_minutes" in body.model_fields_set
    if all(v is None for v in (body.notify_level, body.muted, body.desktop, body.push,
                               body.email, body.thread_replies)) and not has_minutes:
        raise HTTPException(400, "변경할 내용이 없습니다")
    from app.chat.schemas import MUTE_MINUTES
    if has_minutes and body.muted_minutes is not None and body.muted_minutes not in MUTE_MINUTES:
        raise HTTPException(400, {"code": "bad_muted_minutes", "message": "음소거 기간은 15·60·180·480·1440분 중 하나입니다"})
    prefs = await service.update_channel_prefs(
        db, channel_id, user.id, notify_level=body.notify_level, muted=body.muted,
        desktop=body.desktop, push=body.push, email=body.email, thread_replies=body.thread_replies,
        muted_minutes=body.muted_minutes if has_minutes else ...,
    )
    if prefs is None:
        raise HTTPException(403, "채널 멤버가 아닙니다")
    await emit_to_user(user.id, {"type": "channel_prefs", **prefs})
    return prefs


@router.get("/channels/{channel_id}/pins")
async def list_pins(
    channel_id: str,
    limit: int = Query(100, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not await perms.allowed(db, user, "message.read", channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    return {"items": await service.get_pinned_messages(db, channel_id, limit)}


# ─── File Upload (chat attachments) ───

@router.get("/channels/{channel_id}/prefs")
async def get_channel_prefs(
    channel_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """본인의 채널 알림 설정(notify_level·muted·desktop·push·email·thread_replies)."""
    prefs = await service.get_channel_prefs(db, channel_id, user.id)
    if prefs is None:
        raise HTTPException(403, "채널 멤버가 아닙니다")
    return prefs


@router.post("/channels/{channel_id}/upload", status_code=201)
async def upload_chat_file(
    channel_id: str,
    file: UploadFile,
    parent_id: str | None = Query(None, description="스레드 답글로 올릴 때 원 메시지 id"),
    also_to_channel: bool = Query(False, description="답글을 채널 타임라인에도"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload a file and create a message with message_type='file'. parent_id 지정 시 스레드 답글."""
    if not await perms.allowed(db, user, "file.upload", channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    if parent_id:
        from app.db.models import Message as _Msg
        parent = await db.get(_Msg, parent_id)
        if not parent or parent.channel_id != channel_id or parent.is_deleted:
            raise HTTPException(404, "원 메시지를 찾을 수 없습니다")
        if parent.parent_id:
            parent_id = parent.parent_id   # 답글의 답글은 동일 스레드로 처리

    settings = get_settings()

    # Prepare storage directory
    chat_files_dir = Path(settings.storage_root) / "chat_files" / channel_id
    chat_files_dir.mkdir(parents=True, exist_ok=True)

    # Sanitize filename
    raw_name = file.filename or "upload"
    safe_name = os.path.basename(raw_name).strip()
    if not safe_name or safe_name.startswith(".") or "\x00" in safe_name:
        raise HTTPException(400, "잘못된 파일명입니다")
    if ".." in safe_name or len(safe_name) > 255:
        raise HTTPException(400, "잘못된 파일명입니다")

    # Unique filename to avoid collisions
    import uuid as _uuid
    unique_prefix = _uuid.uuid4().hex[:8]
    disk_name = f"{unique_prefix}_{safe_name}"
    target = chat_files_dir / disk_name

    # Stream write with size limit (50 MB for chat files)
    max_bytes = 50 * 1024 * 1024
    written = 0
    with open(target, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            written += len(chunk)
            if written > max_bytes:
                f.close()
                target.unlink(missing_ok=True)
                raise HTTPException(413, "파일 크기가 50MB를 초과합니다")
            f.write(chunk)

    # Determine mime type
    import mimetypes
    mime_type = file.content_type or mimetypes.guess_type(safe_name)[0] or "application/octet-stream"

    # Build file URL (served via /api/files/download with a special path, or direct)
    file_url = f"/api/chat/channels/{channel_id}/files/{disk_name}"

    file_meta = json.dumps({
        "filename": safe_name,
        "size": written,
        "mime_type": mime_type,
        "url": file_url,
        "disk_name": disk_name,
    }, ensure_ascii=False)

    # Create file message
    msg = await service.create_message(
        db, channel_id, user.id,
        content=safe_name,
        message_type="file",
        file_meta=file_meta,
        parent_id=parent_id,
        thread_broadcast=also_to_channel,
    )
    await _broadcast_message(db, channel_id, user.id, safe_name, msg)
    return msg


# ─── Chat file download ───

@router.get("/channels/{channel_id}/files/{filename}")
async def download_chat_file(
    channel_id: str,
    filename: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download a file uploaded to a chat channel."""
    if not await perms.allowed(db, user, "file.download", channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")

    settings = get_settings()
    chat_files_dir = Path(settings.storage_root) / "chat_files" / channel_id
    file_path = chat_files_dir / filename

    # Security: ensure path doesn't escape
    if not str(file_path.resolve()).startswith(str(chat_files_dir.resolve())):
        raise HTTPException(403, "경로 접근이 거부되었습니다")
    if not file_path.is_file():
        raise HTTPException(404, "파일을 찾을 수 없습니다")

    from fastapi.responses import FileResponse
    # Extract original filename from disk_name (strip uuid prefix)
    original_name = filename.split("_", 1)[1] if "_" in filename else filename
    from app.files import serve_safety
    media, headers = serve_safety.safe_file_headers(original_name)
    return FileResponse(path=str(file_path), media_type=media, headers=headers)


@router.get("/messages/search")
async def search_messages(
    q: str = Query(..., min_length=1),
    channel_id: str | None = Query(None),
    limit: int = Query(20, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    results = await service.search_messages(
        db, user.id, q, channel_id=channel_id, limit=limit
    )
    return results


@router.get("/messages/{message_id}/thread")
async def get_thread(
    message_id: str,
    limit: int = Query(100, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import Message as MsgModel
    parent = await db.get(MsgModel, message_id)
    if not parent:
        raise HTTPException(404, "메시지를 찾을 수 없습니다")
    if not await perms.allowed(db, user, "message.read", parent.channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    replies = await service.get_thread_messages(db, message_id, limit=limit, user_id=user.id)
    follow = await service.get_thread_follow_state(db, user.id, message_id)
    # 원문도 함께 반환 — 딥 링크·검색으로 진입하면 원문이 화면의 최근 목록에 없어 패널이 원문 없이 표시되었음
    parent_dict = None if parent.is_deleted else await service.get_message_dict(db, parent, user_id=user.id)
    return {"replies": replies, "parent": parent_dict, **follow}


async def _set_pin(db: AsyncSession, message_id: str, user: User, pinned: bool) -> dict:
    from app.db.models import Message as MsgModel
    msg = await db.get(MsgModel, message_id)
    if not msg or msg.is_deleted:
        raise HTTPException(404, "메시지를 찾을 수 없습니다")
    if not await perms.allowed(db, user, "message.pin", msg.channel_id, message=msg):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    was_pinned = msg.pinned_at is not None
    updated = await service.set_pinned(db, message_id, user.id, pinned)
    # 편집과 동일한 형식 — 채널 구독자 전원이 메시지 전체를 교체한다
    await emit_to_channel(msg.channel_id, {"type": "message_update", "message": updated})
    # 고정 시스템 줄(chat22) — 신규 고정 시에만 생성하며, 동일 메시지의 줄이 이미 있으면 유지
    if pinned and not was_pinned:
        line = await service.create_pin_system_message(db, message_id, msg.channel_id, user.id)
        if line is not None:
            await emit_to_channel(msg.channel_id, {"type": "new_message", "message": line})
    return updated


@router.post("/messages/{message_id}/pin")
async def pin_message(
    message_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """채널 멤버 누구나 핀 가능. 이미 핀 상태이면 변경 없음."""
    return await _set_pin(db, message_id, user, True)


@router.delete("/messages/{message_id}/pin")
async def unpin_message(
    message_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _set_pin(db, message_id, user, False)


async def _set_follow(db: AsyncSession, message_id: str, user: User, followed: bool) -> dict:
    from app.db.models import Message as MsgModel
    msg = await db.get(MsgModel, message_id)
    if not msg:
        raise HTTPException(404, "메시지를 찾을 수 없습니다")
    if msg.parent_id is not None:
        raise HTTPException(400, "스레드의 원 메시지만 팔로우할 수 있습니다")
    if not await perms.allowed(db, user, "channel.participate", msg.channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    res = await service.set_thread_follow(db, user.id, message_id, followed)
    await emit_to_user(user.id, {"type": "thread_follow", **res})
    return res


@router.post("/messages/{message_id}/follow")
async def follow_thread(
    message_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _set_follow(db, message_id, user, True)


@router.delete("/messages/{message_id}/follow")
async def unfollow_thread(
    message_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _set_follow(db, message_id, user, False)


@router.post("/messages/{message_id}/reactions")
async def toggle_reaction(
    message_id: str,
    body: ReactionToggle,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import Message as MsgModel
    msg = await db.get(MsgModel, message_id)
    if not msg:
        raise HTTPException(404, "메시지를 찾을 수 없습니다")
    if not await perms.allowed(db, user, "reaction.add", msg.channel_id, message=msg):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    from app.chat.emoji22 import check_reaction_emoji
    emoji = body.emoji.strip()
    if not await check_reaction_emoji(db, emoji):
        raise HTTPException(400, {"code": "emoji_not_found", "message": "없는 커스텀 이모지입니다"})
    result = await service.toggle_reaction(db, message_id, user.id, emoji)
    return result


@router.patch("/messages/{message_id}")
async def edit_message(
    message_id: str,
    body: MessageUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import Message as MsgModel
    msg = await db.get(MsgModel, message_id)
    if not msg:
        raise HTTPException(404, "메시지를 찾을 수 없습니다")
    if not await perms.allowed(db, user, "message.edit", msg.channel_id, message=msg):
        raise HTTPException(403, "본인 메시지만 수정할 수 있습니다")
    had_preview = msg.link_preview
    updated = await service.update_message(db, message_id, body.content)
    # 첫 링크가 변경되어 카드가 제거된 경우 수신 측에서도 삭제하고, 새 링크이면 다시 생성한다
    if updated is not None:
        # 수정된 본문을 채널 전원에게 전달(본인의 다른 기기 포함) — 이전에는 이벤트를 전혀 송신하지 않아 새로고침해야 반영되었음. 핀과 동일한 형식
        await emit_to_channel(msg.channel_id, {"type": "message_update", "message": updated})
        updated_preview = updated.get("link_preview")
        if had_preview and not msg.link_preview:
            await emit_to_channel(msg.channel_id, {
                "type": "link_preview", "message_id": msg.id, "channel_id": msg.channel_id,
                "parent_id": msg.parent_id, "link_preview": None,
            })
        if not msg.link_preview and updated_preview is None:
            from app.chat.link_preview import schedule_for_message
            schedule_for_message(updated)
    return updated


@router.delete("/messages/{message_id}/link-preview")
async def dismiss_link_preview(
    message_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """미리보기 삭제 — 발신자만 가능. 동일 링크로는 재생성하지 않는다."""
    from app.db.models import Message as MsgModel
    msg = await db.get(MsgModel, message_id)
    if not msg or msg.is_deleted:
        raise HTTPException(404, "메시지를 찾을 수 없습니다")
    if not await perms.allowed(db, user, "preview.dismiss", msg.channel_id, message=msg):
        raise HTTPException(403, "보낸 사람만 미리보기를 지울 수 있습니다")
    ev = await service.dismiss_link_preview(db, msg)
    await emit_to_channel(msg.channel_id, {"type": "link_preview", **ev, "link_preview": None})
    return {"ok": True}


@router.get("/link-preview/images/{image_id}")
async def link_preview_image(
    image_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """미리보기 썸네일 — 서버가 수신하여 축소·재인코딩한 것만 제공한다(수신 측이 외부로 직접 접속하지 않도록 함)."""
    import re as _re
    from fastapi import Response
    from app.db.models import LinkPreviewImage
    if not _re.fullmatch(r"[0-9a-f]{64}", image_id):
        raise HTTPException(404, "없습니다")
    row = await db.get(LinkPreviewImage, image_id)
    if row is None or row.content_type not in ("image/jpeg", "image/png"):
        raise HTTPException(404, "없습니다")
    return Response(content=row.data, media_type=row.content_type, headers={
        "Cache-Control": "private, max-age=604800, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline",
    })


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.db.models import Message as MsgModel
    msg = await db.get(MsgModel, message_id)
    if not msg:
        raise HTTPException(404, "메시지를 찾을 수 없습니다")
    if not await perms.allowed(db, user, "message.delete", msg.channel_id, message=msg):
        raise HTTPException(403, "본인 메시지만 삭제할 수 있습니다")
    channel_id, parent_id = msg.channel_id, msg.parent_id
    await service.soft_delete_message(db, message_id)
    # 삭제 사실을 채널 전원에게 전달 — 이전에는 삭제한 사용자의 화면에서만 제거되고 다른 사용자·다른 기기에는 계속 남았음
    await emit_to_channel(channel_id, {
        "type": "message_delete", "message_id": message_id, "channel_id": channel_id, "parent_id": parent_id,
    })
    return {"ok": True}


# ─── DM ───

@router.post("/dm")
async def get_or_create_dm(
    body: DMRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.user_id == user.id:
        raise HTTPException(400, "자기 자신에게 DM을 보낼 수 없습니다")
    other = await db.get(User, body.user_id)
    if not other:
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    ch = await service.get_or_create_dm(db, user.id, body.user_id)
    # 신규 DM 이면 상대 측 구독에 아직 없음(기존 DM 이면 갱신은 무해)
    await manager.notify_channels_changed([user.id, body.user_id])
    return {"id": ch.id, "name": ch.name, "type": ch.type}


# ─── Presence ───

@router.get("/presence")
async def get_presence(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """{online_user_ids(하위호환 — invisible 제외), statuses: {user_id: {state, emoji, text}}}."""
    from app.chat.presence import presence_snapshot
    return await presence_snapshot(db)


@router.get("/me/status")
async def get_my_status(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.chat.presence import get_status, status_to_dict
    from app.realtime.events import is_connected
    return status_to_dict(await get_status(db, user.id), await is_connected(user.id))


@router.put("/me/status")
async def update_my_status(
    body: UserStatusUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """전송된 필드만 변경한다(null 명시 = 비우기). 변경된 실효 상태를 전원에게 presence 로 전달한다."""
    from app.chat.presence import presence_event, set_status, status_to_dict
    from app.realtime.events import is_connected

    fields = {k: getattr(body, k) for k in body.model_fields_set}
    if not fields:
        raise HTTPException(400, "변경할 내용이 없습니다")
    # 커스텀 텍스트를 비우면 이모지·만료도 함께 비운다(불완전한 상태가 남지 않도록 함)
    if "custom_text" in fields and not fields["custom_text"]:
        fields.setdefault("custom_emoji", None)
        fields.setdefault("custom_expires_at", None)
    row = await set_status(db, user.id, **fields)
    connected = await is_connected(user.id)
    try:
        await manager.publish_presence(await presence_event(db, user.id, connected))
    except Exception:
        pass
    return status_to_dict(row, connected)


# ─── User Search ───

# ─── Notifications (deprecated — use /api/notifications instead) ───

@router.get("/notifications", deprecated=True)
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.notifications import service as notif_svc
    notifications, total = await notif_svc.get_notifications(db, user.id, unread_only=unread_only, limit=limit)
    unread_count = await notif_svc.get_unread_count(db, user.id)
    return {"notifications": notifications, "unread_count": unread_count}


@router.post("/notifications/read", deprecated=True)
async def mark_notifications_read(
    body: NotificationReadRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.notifications import service as notif_svc
    if body.notification_ids:
        count = 0
        for nid in body.notification_ids:
            if await notif_svc.mark_as_read(db, user.id, nid):
                count += 1
    else:
        count = await notif_svc.mark_all_as_read(db, user.id)
    return {"ok": True, "updated": count}


@router.post("/notifications/read-all", deprecated=True)
async def mark_all_notifications_read(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.notifications import service as notif_svc
    count = await notif_svc.mark_all_as_read(db, user.id)
    return {"ok": True, "updated": count}


# ─── User Search ───

@router.get("/users")
async def search_users(
    q: str = Query("", min_length=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.search_users(db, q.strip() if q.strip() else None)


# ─── 저장한 메시지 · 내 스레드 (데스크톱 셸 "모아보기") ───


@router.post("/messages/{message_id}/save", status_code=201)
async def save_message(
    message_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """메시지를 저장한다. 이미 저장된 경우에도 그대로 201 을 반환한다 — 토글 방식이므로 중복 요청이 발생한다."""
    from app.db.models import Message as MsgModel

    msg = await db.get(MsgModel, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="메시지를 찾을 수 없습니다")
    if not await perms.allowed(db, user, "channel.participate", msg.channel_id):
        raise HTTPException(status_code=403, detail="이 대화의 멤버가 아닙니다")
    await service.save_message(db, user.id, message_id)
    return {"saved": True}


@router.delete("/messages/{message_id}/save")
async def unsave_message(
    message_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await service.unsave_message(db, user.id, message_id)
    return {"saved": False}


@router.get("/saved")
async def list_saved(
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """저장한 메시지 목록. 최근 저장 순."""
    return {"items": await service.get_saved_messages(db, user.id, limit)}


@router.get("/threads")
async def list_my_threads(
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """호출 사용자가 팔로우하는 스레드의 원 메시지 목록(+ unread_replies · followed · last_reply). 마지막 답글 순."""
    return {"items": await service.get_my_threads(db, user.id, limit)}


@router.get("/threads/unread-count")
async def thread_unread_count(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """{threads: 미읽음 답글이 있는 스레드 수, replies: 미읽음 답글 총수} — 셸의 스레드 배지."""
    return await service.get_thread_unread_count(db, user.id)


@router.post("/threads/{root_id}/read")
async def mark_thread_read(
    root_id: str,
    body: ThreadReadRequest | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """스레드 읽음 처리 — 마지막 답글(또는 body.seq)까지. 본인의 다른 기기에는 thread_read 를 전달한다."""
    from app.db.models import Message as MsgModel
    root = await db.get(MsgModel, root_id)
    if not root or root.parent_id is not None:
        raise HTTPException(404, "스레드를 찾을 수 없습니다")
    if not await perms.allowed(db, user, "channel.participate", root.channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    seq = await service.mark_thread_read(db, user.id, root_id, body.seq if body else None)
    if seq is not None:
        await emit_to_user(user.id, {"type": "thread_read", "root_id": root_id, "seq": seq})
    return {"ok": True, "root_id": root_id, "last_read_seq": seq}


# ─── 임시글 ───


@router.get("/drafts")
async def list_drafts(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return {"items": await service.get_drafts(db, user.id)}


@router.put("/drafts")
async def upsert_draft(
    body: DraftUpsert,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """저장(빈 content 이면 삭제). 본인의 다른 기기에는 draft_update(content null = 삭제)를 전달한다."""
    if not await perms.allowed(db, user, "channel.participate", body.channel_id):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    draft = await service.upsert_draft(db, user.id, body.channel_id, body.parent_id, body.content)
    event = draft or {"channel_id": body.channel_id, "parent_id": body.parent_id,
                      "content": None, "updated_at": None}
    await emit_to_user(user.id, {"type": "draft_update", **event})
    return event


@router.delete("/drafts")
async def delete_draft(
    channel_id: str = Query(...),
    parent_id: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    deleted = await service.delete_draft(db, user.id, channel_id, parent_id)
    if deleted:
        await emit_to_user(user.id, {
            "type": "draft_update", "channel_id": channel_id, "parent_id": parent_id,
            "content": None, "updated_at": None,
        })
    return {"ok": True, "deleted": deleted}
