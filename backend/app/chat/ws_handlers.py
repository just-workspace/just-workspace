"""채팅이 실시간 소켓으로 수신하는 프레임 처리 — 메시지 전송·반응·타이핑·읽음.

소켓 자체(연결·인증·전달)는 코어(app/realtime/socket.py)에 있으며, 본 모듈의 처리기는 채팅
구역이 설치된 경우에만 등록된다(app/zones.py 의 `SOCKET_HANDLERS`).
"""

from app.chat import service
from app.db.models import User
from app.db.session import async_session
from app.realtime.socket import SocketContext, manager


async def _send_message(ctx: SocketContext, data: dict) -> None:
    channel_id = data.get("channel_id")
    content = data.get("content", "").strip()
    message_type = data.get("message_type", "text")
    file_meta = data.get("file_meta")
    parent_id = data.get("parent_id")
    also_to_channel = bool(data.get("also_to_channel", False))   # 답글을 채널에도 표시
    # chat22 — 인라인 답장·답장 대상 알림(기본 활성)·@silent(본문 선두 "@silent " 도 동일)
    reply_to_id = data.get("reply_to_id") or None
    reply_ping = data.get("reply_ping", True) is not False
    from app.chat import msg22
    content, silent_prefix = msg22.split_silent(content)
    silent = bool(data.get("silent", False)) or silent_prefix

    if not channel_id or not content:
        ctx.reply({"type": "error", "detail": "Missing channel_id or content"})
        return

    async with async_session() as db:
        from app.chat import permissions as perms
        action = "message.reply" if parent_id else "message.send"
        if not await perms.allowed(db, perms.system_user(ctx.user_id), action, channel_id):
            ctx.reply({"type": "error", "detail": "Not a member"})
            return
        try:
            await msg22.validate_reply(db, channel_id, parent_id, reply_to_id)
        except msg22.ReplyError as e:
            ctx.reply({"type": "error", "detail": e.message, "code": e.code})
            return
        msg = await service.create_message(
            db, channel_id, ctx.user_id, content,
            message_type=message_type, file_meta=file_meta,
            parent_id=parent_id, thread_broadcast=also_to_channel,
            reply_to_id=reply_to_id,
            flags=msg22.make_flags(silent=silent, reply_ping=bool(reply_to_id and reply_ping)),
        )
        # 실시간 전달·멘션 알림·DM 푸시 — REST 경로와 동일한 함수(app/chat/notify.py)
        from app.chat.notify import after_message_created
        await after_message_created(db, msg, channel_id, ctx.user_id, content)


async def _toggle_reaction(ctx: SocketContext, data: dict) -> None:
    message_id = data.get("message_id")
    emoji = data.get("emoji", "").strip()
    if not message_id or not emoji or len(emoji) > 64:
        ctx.reply({"type": "error", "detail": "Missing message_id or emoji"})
        return

    async with async_session() as db:
        from app.db.models import Message as MsgModel
        msg_obj = await db.get(MsgModel, message_id)
        if not msg_obj:
            ctx.reply({"type": "error", "detail": "Message not found"})
            return
        from app.chat import permissions as perms
        if not await perms.allowed(db, perms.system_user(ctx.user_id), "reaction.add",
                                   msg_obj.channel_id, message=msg_obj):
            ctx.reply({"type": "error", "detail": "Not a member"})
            return
        from app.chat.emoji22 import check_reaction_emoji
        if not await check_reaction_emoji(db, emoji):
            ctx.reply({"type": "error", "detail": "Unknown custom emoji", "code": "emoji_not_found"})
            return
        result = await service.toggle_reaction(db, message_id, ctx.user_id, emoji)

    await manager.publish_to_channel(msg_obj.channel_id, {
        "type": "reaction_update",
        "message_id": message_id,
        "reactions": result["reactions"],
    })


async def _typing(ctx: SocketContext, data: dict) -> None:
    channel_id = data.get("channel_id")
    if channel_id:
        await manager.publish_typing(channel_id, {
            "type": "typing",
            "channel_id": channel_id,
            "user_id": ctx.user_id,
            "username": ctx.display_name or ctx.username,
        })


async def _mark_read(ctx: SocketContext, data: dict) -> None:
    channel_id = data.get("channel_id")
    message_id = data.get("message_id")
    if channel_id and message_id:
        async with async_session() as db:
            seq = await service.mark_read(db, channel_id, ctx.user_id, message_id)
            u = await db.get(User, ctx.user_id)
            avatar = u.avatar_url if u else None
        await manager.publish_to_channel(channel_id, {
            "type": "message_read",
            "channel_id": channel_id,
            "user_id": ctx.user_id,
            "username": ctx.display_name or ctx.username,
            "avatar_url": avatar,
            "message_id": message_id,
            "seq": seq,
        })
        if seq is not None:
            # 본인의 다른 기기·탭의 배지도 함께 해제한다(읽음은 계정 단위)
            from app.realtime.events import emit_to_user
            await emit_to_user(ctx.user_id, {
                "type": "channel_read", "channel_id": channel_id, "seq": seq,
            })


# 프레임 종류(type) → 처리기
HANDLERS = {
    "send_message": _send_message,
    "toggle_reaction": _toggle_reaction,
    "typing": _typing,
    "mark_read": _mark_read,
}
