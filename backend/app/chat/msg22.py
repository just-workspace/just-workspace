"""chat22 메시지 형태 — 인라인 답장·@silent·다중 첨부·스레드 메타.

service._message_to_dict 가 DB 없이 채울 수 있는 항목(reply_to_id·reply_ping·silent·attachments·명시적으로 시작된 스레드)은
fields_of() 로, DB 가 필요한 항목(reply_to 원문 요약·답글 수가 있는 스레드 메타)은 enrich() 로 **목록 단위 1회에** 채운다
(답장 원문은 id 를 수집하여 쿼리 1회 + 발신자 1회 — N+1 없음).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, Message, User

# messages.flags 비트(답장 멘션)
MSG_FLAG_SILENT = 1
MSG_FLAG_SUPPRESS_EMBEDS = 2      # 예약
MSG_FLAG_REPLY_PING = 32

THREAD_ARCHIVE_CHOICES = (60, 1440, 4320, 10080)
DEFAULT_THREAD_ARCHIVE = 4320
REPLY_SUMMARY_LEN = 200
THREAD_DISPLAY_LEN = 40
SILENT_PREFIX = "@silent "


class ReplyError(ValueError):
    """답장 대상이 유효하지 않음 — code 는 프런트가 분기에 사용하는 값."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def split_silent(content: str) -> tuple[str, bool]:
    """본문이 `@silent ` 로 시작하면 이를 제거하고 silent=True."""
    if content and content.startswith(SILENT_PREFIX):
        return content[len(SILENT_PREFIX):].lstrip(), True
    return content, False


def make_flags(*, silent: bool = False, reply_ping: bool = False) -> int:
    return (MSG_FLAG_SILENT if silent else 0) | (MSG_FLAG_REPLY_PING if reply_ping else 0)


def _aware(dt):
    if dt is None:
        return None
    if isinstance(dt, str):
        try:
            dt = datetime.fromisoformat(dt)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def attachment_kind(mime: str | None) -> str:
    m = (mime or "").lower()
    if m.startswith("image/"):
        return "image"
    if m.startswith("video/"):
        return "video"
    if m.startswith("audio/"):
        return "audio"
    return "file"


def _public_attachment(a: dict, idx: int) -> dict:
    out = {
        "id": str(a.get("id") or a.get("disk_name") or idx),
        "filename": a.get("filename") or "file",
        "size": int(a.get("size") or 0),
        "mime_type": a.get("mime_type") or "application/octet-stream",
        "url": a.get("url") or "",
        "spoiler": bool(a.get("spoiler")),
        "alt": a.get("alt") or None,
    }
    for k in ("width", "height", "duration"):
        if a.get(k) is not None:
            out[k] = a[k]
    return out


def attachments_of(msg: Message) -> list[dict]:
    """attachments(JSON 배열) — 없으면 기존 단일 file_meta 를 1개 항목 배열로 변환."""
    raw = getattr(msg, "attachments", None)
    items: list = []
    if raw:
        try:
            items = json.loads(raw) or []
        except (ValueError, TypeError):
            items = []
    elif msg.message_type == "file" and msg.file_meta:
        try:
            fm = json.loads(msg.file_meta)
            if isinstance(fm, dict) and (fm.get("url") or fm.get("filename")):
                items = [fm]
        except (ValueError, TypeError):
            items = []
    return [_public_attachment(a, i) for i, a in enumerate(items) if isinstance(a, dict)]


def thread_meta_of(msg: Message, reply_count: int, last_reply_at, channel_default: int | None,
                   now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    minutes = msg.thread_auto_archive_minutes or channel_default or DEFAULT_THREAD_ARCHIVE
    last = _aware(last_reply_at)
    marks = [d for d in (_aware(msg.thread_activity_at), last, _aware(msg.thread_started_at),
                         _aware(msg.created_at)) if d is not None]
    activity = max(marks) if marks else now
    archived = msg.thread_archived_at is not None or activity + timedelta(minutes=minutes) < now
    name = msg.thread_name or None
    display = name
    if not display:
        text = " ".join((msg.content or "").split())
        if not text:
            atts = attachments_of(msg)
            text = atts[0]["filename"] if atts else ""
        display = text[:THREAD_DISPLAY_LEN] or "스레드"
    return {
        "name": name,
        "display_name": display,
        "archived": bool(archived),
        "auto_archive_minutes": int(minutes),
        "reply_count": int(reply_count or 0),
        "last_reply_at": last.isoformat() if last else None,
        "activity_at": activity.isoformat(),
    }


def fields_of(msg: Message) -> dict:
    """_message_to_dict 에 추가하는 필드(DB 불필요). reply_to·답글 있는 스레드는 enrich 가 채운다."""
    flags = int(getattr(msg, "flags", 0) or 0)
    started = getattr(msg, "thread_started_at", None) is not None and msg.parent_id is None
    return {
        "reply_to_id": getattr(msg, "reply_to_id", None),
        "reply_ping": bool(flags & MSG_FLAG_REPLY_PING),
        "reply_to": None,
        "silent": bool(flags & MSG_FLAG_SILENT),
        "attachments": attachments_of(msg),
        "thread": thread_meta_of(msg, 0, None, None) if started else None,
    }


def _sender_dict(u: User | None) -> dict | None:
    if u is None:
        return None
    return {"id": u.id, "username": u.username, "display_name": u.display_name, "avatar_url": u.avatar_url}


def reply_summary(src: Message, target: Message | None, sender: User | None) -> dict:
    """원문 상태 4가지 — ok · deleted(삭제된 글) · unavailable(행 없음/다른 채널) · forbidden(조회 권한 없음).

    동일 채널에만 답장할 수 있으므로(전송 시 검사) 현재 forbidden 은 발생하지 않는다 — 원문이 다른 채널로 판정되면
    unavailable(계약). forbidden 은 채널 READ_HISTORY 덮어쓰기(enforce) 이후 용도로 예약해 둔다.
    """
    rid = src.reply_to_id
    base = {"id": rid, "sender": None, "content": "", "message_type": "text",
            "has_attachment": False, "attachment_kind": None}
    if target is None or target.channel_id != src.channel_id:
        return {**base, "state": "unavailable"}
    if target.is_deleted:
        return {**base, "state": "deleted", "message_type": target.message_type or "text"}
    atts = attachments_of(target)
    content = target.content or ""
    # 기존 /upload 파일 메시지는 본문 = 파일 이름 → "첨부만"으로 간주
    if target.message_type == "file" and not getattr(target, "attachments", None):
        content = ""
    return {
        **base,
        "state": "ok",
        "sender": _sender_dict(sender),
        "content": content[:REPLY_SUMMARY_LEN],
        "message_type": target.message_type or "text",
        "has_attachment": bool(atts),
        "attachment_kind": attachment_kind(atts[0]["mime_type"]) if atts else None,
    }


async def enrich(db: AsyncSession, pairs: list[tuple[Message, dict]]) -> None:
    """목록 단위 1회로 reply_to·thread 를 채운다(제자리 수정).

    thread: 루트(parent_id 없음) 중 답글이 있거나(d["reply_count"] 또는 조회) 명시적으로 시작된 것.
    d 에 reply_count·last_reply_at 이 이미 있으면(get_messages) 해당 값을 사용하고, 없으면 쿼리 1회로 집계한다.
    """
    if not pairs:
        return
    # ── 답장 원문 ──
    ids = {m.reply_to_id for m, _d in pairs if getattr(m, "reply_to_id", None)}
    if ids:
        targets = {t.id: t for t in (await db.execute(select(Message).where(Message.id.in_(ids)))).scalars()}
        sids = {t.sender_id for t in targets.values() if t.sender_id}
        users = {u.id: u for u in (await db.execute(select(User).where(User.id.in_(sids)))).scalars()} if sids else {}
        for m, d in pairs:
            if m.reply_to_id:
                t = targets.get(m.reply_to_id)
                d["reply_to"] = reply_summary(m, t, users.get(t.sender_id) if t and t.sender_id else None)
    # ── 스레드 메타 ──
    roots = [(m, d) for m, d in pairs if m.parent_id is None and not m.is_deleted]
    if not roots:
        return
    need_count = [m.id for m, d in roots if "reply_count" not in d]
    counts: dict[str, tuple[int, datetime | None]] = {}
    if need_count:
        for pid, n, last in (await db.execute(
            select(Message.parent_id, func.count(Message.id), func.max(Message.created_at))
            .where(Message.parent_id.in_(need_count), Message.is_deleted == False)  # noqa: E712
            .group_by(Message.parent_id)
        )).all():
            counts[pid] = (int(n), last)
    chan_ids = {m.channel_id for m, _d in roots}
    defaults = {cid: dflt for cid, dflt in (await db.execute(
        select(Channel.id, Channel.default_thread_auto_archive_minutes).where(Channel.id.in_(chan_ids))
    )).all()}
    now = datetime.now(timezone.utc)
    for m, d in roots:
        if "reply_count" in d:
            n, last = d.get("reply_count") or 0, d.get("last_reply_at")
        else:
            n, last = counts.get(m.id, (0, None))
        if n or m.thread_started_at is not None:
            d["thread"] = thread_meta_of(m, n, last, defaults.get(m.channel_id), now)
        else:
            d["thread"] = None


async def validate_reply(
    db: AsyncSession, channel_id: str, parent_id: str | None, reply_to_id: str | None,
) -> Message | None:
    """답장 대상 검증 — 동일 채널, 스레드 내부이면 동일 스레드(루트 또는 그 답글), 외부이면 메인 타임라인 글."""
    if not reply_to_id:
        return None
    t = await db.get(Message, reply_to_id)
    if t is None or t.channel_id != channel_id:
        raise ReplyError("reply_not_found", "답장할 메시지를 찾을 수 없습니다")
    if t.is_deleted:
        raise ReplyError("reply_deleted", "삭제된 메시지에는 답장할 수 없습니다")
    if parent_id:
        if not (t.id == parent_id or t.parent_id == parent_id):
            raise ReplyError("reply_other_thread", "같은 스레드의 메시지에만 답장할 수 있습니다")
    else:
        if t.parent_id is not None and not t.thread_broadcast:
            raise ReplyError("reply_other_thread", "스레드 안 메시지는 그 스레드에서 답장하십시오")
    return t
