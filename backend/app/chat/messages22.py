"""chat22 조회 — 원문 점프(around)·채널 스레드 목록·검색 필터.

직렬화는 service._message_to_dict + msg22.enrich 그대로(목록 단위 한 번에 — N+1 없음).
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import and_, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import msg22
from app.db.models import Channel, ChannelMember, ChatMention, Message, ThreadFollow, User

SEARCH_HAS = ("link", "file", "image", "video", "sound", "embed")
DEFAULT_TZ = "Asia/Seoul"


# ─── 원문 점프 ───

async def has_newer(db: AsyncSession, channel_id: str, messages: list[dict]) -> bool:
    """이 페이지의 마지막 메시지보다 최근 메인 타임라인 메시지가 있나(최근으로 바 표시용)."""
    from app.chat.service import main_timeline_filter
    if not messages:
        return False
    last = messages[-1].get("seq")
    if last is None:
        return False
    row = (await db.execute(
        select(Message.id).where(
            Message.channel_id == channel_id, Message.is_deleted == False,  # noqa: E712
            main_timeline_filter(), Message.seq > last,
        ).limit(1)
    )).scalar_one_or_none()
    return row is not None


async def get_messages_around(db: AsyncSession, channel_id: str, around_id: str, limit: int,
                              user_id: str) -> dict | None:
    """around 메시지를 가운데로 위아래 반씩. 없거나 다른 채널이면 None(404).

    원문이 스레드 안 답글(채널에도 보내기 아님)이면 메인 타임라인엔 없다 → {messages: [], thread_root_id}.
    """
    from app.chat import service
    t = await db.get(Message, around_id)
    if t is None or t.channel_id != channel_id:
        return None
    if t.parent_id is not None and not t.thread_broadcast:
        return {"messages": [], "has_more": False, "has_more_after": False,
                "thread_root_id": t.parent_id, "target_id": around_id}
    half = limit // 2
    older, has_more = await service.get_messages(db, channel_id, before_seq=t.seq, limit=half, user_id=user_id) \
        if half else ([], (await _older_exists(db, channel_id, t.seq)))
    newer, has_after = await service.get_messages(
        db, channel_id, after_seq=(t.seq or 0) - 1, limit=limit - half, user_id=user_id,
    )
    return {"messages": older + newer, "has_more": has_more, "has_more_after": has_after,
            "thread_root_id": None, "target_id": around_id}


async def _older_exists(db: AsyncSession, channel_id: str, seq: int) -> bool:
    from app.chat.service import main_timeline_filter
    return (await db.execute(select(Message.id).where(
        Message.channel_id == channel_id, Message.is_deleted == False,  # noqa: E712
        main_timeline_filter(), Message.seq < seq,
    ).limit(1))).scalar_one_or_none() is not None


# ─── 채널 스레드 목록 ───

async def list_channel_threads(
    db: AsyncSession, channel: Channel, user_id: str, *, archived: bool, limit: int,
    before: datetime | None = None,
) -> dict:
    """채널의 스레드(답글이 있거나 명시로 시작된 루트) — 최근 활동순, 보관/활성 따로.

    보관 = 명시 보관 또는 (마지막 활동 + 자동 보관 분) 지남. 활동 = 마지막 답글·보관 해제·시작·원문 시각 중 최근.
    계산은 파이썬에서(채널 하나의 스레드 수는 작다 — 수천을 넘으면 thread_activity_at 인덱스로 옮긴다).
    """
    from app.chat import service
    reply_sq = (
        select(
            Message.parent_id.label("pid"),
            func.count(Message.id).label("n"),
            func.max(Message.created_at).label("last_at"),
            func.max(Message.seq).label("last_seq"),
        )
        .where(Message.channel_id == channel.id, Message.parent_id.is_not(None),
               Message.is_deleted == False)  # noqa: E712
        .group_by(Message.parent_id)
        .subquery()
    )
    rows = (await db.execute(
        select(Message, User, reply_sq.c.n, reply_sq.c.last_at, reply_sq.c.last_seq)
        .outerjoin(User, User.id == Message.sender_id)
        .outerjoin(reply_sq, reply_sq.c.pid == Message.id)
        .where(
            Message.channel_id == channel.id, Message.parent_id.is_(None),
            Message.is_deleted == False,  # noqa: E712
            or_(reply_sq.c.n > 0, Message.thread_started_at.is_not(None)),
        )
    )).all()
    now = datetime.now(timezone.utc)
    dflt = channel.default_thread_auto_archive_minutes
    metas = []
    total = 0
    for m, u, n, last_at, last_seq in rows:
        meta = msg22.thread_meta_of(m, n or 0, last_at, dflt, now)
        if meta["archived"] != archived:
            continue
        total += 1   # 이 탭(활성/보관) 전체 개수 — before 커서와 무관
        act = datetime.fromisoformat(meta["activity_at"])
        if before is not None and act >= before:
            continue
        metas.append((act, m, u, meta, last_seq))
    metas.sort(key=lambda t: t[0], reverse=True)
    has_more = len(metas) > limit
    page = metas[:limit]

    roots = [m for _a, m, _u, _meta, _ls in page]
    ids = [m.id for m in roots]
    participants = await service.get_thread_meta(db, ids)
    last_seqs = [ls for *_x, ls in page if ls is not None]
    last_replies: dict[int, tuple[Message, User | None]] = {}
    if last_seqs:
        for lm, lu in (await db.execute(
            select(Message, User).outerjoin(User, User.id == Message.sender_id).where(Message.seq.in_(last_seqs))
        )).all():
            last_replies[lm.seq] = (lm, lu)
    follows = {tf.root_message_id: tf for tf in (await db.execute(
        select(ThreadFollow).where(ThreadFollow.user_id == user_id, ThreadFollow.root_message_id.in_(ids))
    )).scalars()} if ids else {}
    unread_rows = (await db.execute(
        select(ThreadFollow.root_message_id, func.count(Message.id))
        .join(Message, service._thread_unread_expr(ThreadFollow.user_id, ThreadFollow.last_read_seq))
        .where(ThreadFollow.user_id == user_id, ThreadFollow.root_message_id.in_(ids))
        .group_by(ThreadFollow.root_message_id)
    )).all() if ids else []
    unread = {rid: int(c) for rid, c in unread_rows}
    reactions = await service.get_reactions_for_messages(db, ids)

    items = []
    pairs = []
    for _act, m, u, meta, ls in page:
        d = service._message_to_dict(m, u)
        d["reply_count"] = meta["reply_count"]
        d["reactions"] = reactions.get(m.id, [])
        pairs.append((m, d))
        lr = last_replies.get(ls) if ls is not None else None
        tf = follows.get(m.id)
        items.append({
            "root": d,
            "thread": meta,
            "last_reply": {
                "sender": msg22._sender_dict(lr[1]),
                "content": (lr[0].content or "")[:msg22.REPLY_SUMMARY_LEN],
                "created_at": lr[0].created_at.isoformat(),
            } if lr else None,
            "participants": (participants.get(m.id) or {}).get("participants", []),
            "unread": unread.get(m.id, 0) > 0 and bool(tf and tf.followed),
            "unread_replies": unread.get(m.id, 0),
            "followed": bool(tf and tf.followed),
        })
    await msg22.enrich(db, pairs)
    for (_m, d), it in zip(pairs, items):
        d["thread"] = it["thread"]
    return {"items": items, "has_more": has_more, "total": total,
            "default_auto_archive_minutes": dflt or msg22.DEFAULT_THREAD_ARCHIVE}


# ─── 검색 ───

class SearchError(ValueError):
    pass


def _tz(name: str | None):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name or DEFAULT_TZ)
    except Exception:
        try:
            from zoneinfo import ZoneInfo
            return ZoneInfo(DEFAULT_TZ)
        except Exception:
            return timezone(timedelta(hours=9))   # tzdata 가 없는 이미지 — 서울 고정 오프셋


def _day(value: str | None, tz) -> datetime | None:
    if not value:
        return None
    try:
        d = date.fromisoformat(value.strip())
    except ValueError:
        raise SearchError("날짜는 YYYY-MM-DD 입니다")
    return datetime.combine(d, time.min, tzinfo=tz).astimezone(timezone.utc)


def _like(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _mime_cond(prefix: str):
    pat = f'%"mime_type": "{prefix}%'
    return or_(Message.attachments.like(pat), and_(Message.message_type == "file", Message.file_meta.like(pat)))


async def search(
    db: AsyncSession, user, *, q: str = "", from_user: str | None = None, mentions: str | None = None,
    in_channel: str | None = None, has: list[str] | None = None, before: str | None = None,
    after: str | None = None, during: str | None = None, pinned: bool | None = None,
    sort: str = "new", offset: int = 0, limit: int = 25,
) -> dict:
    """디스코드 검색 필터. 내가 멤버인 채널만, 삭제·시스템 줄 제외. 필터끼리는 AND.

    날짜(before·after·during)는 사용자 시간대(users.timezone, 없으면 Asia/Seoul) 기준 하루.
    before = 그날 0시 전, after = 그다음 날 0시부터, during = 그날 하루.
    """
    from app.chat import service
    tz = _tz(getattr(user, "timezone", None))
    mine = select(ChannelMember.channel_id).where(ChannelMember.user_id == user.id)
    conds = [
        Message.channel_id.in_(mine),
        Message.is_deleted == False,  # noqa: E712
        Message.message_type != "system",
    ]
    if in_channel:
        conds.append(Message.channel_id == in_channel)
    if q and q.strip():
        conds.append(Message.content.ilike(_like(q.strip()), escape="\\"))
    if from_user:
        conds.append(Message.sender_id.in_(select(User.id).where(User.username == from_user.strip().lstrip("@"))))
    if mentions:
        conds.append(Message.id.in_(
            select(ChatMention.message_id).join(User, User.id == ChatMention.user_id)
            .where(User.username == mentions.strip().lstrip("@"), func.coalesce(ChatMention.is_group, False) == False)  # noqa: E712
        ))
    for h in has or []:
        if h == "link":
            conds.append(or_(Message.content.ilike("%http://%"), Message.content.ilike("%https://%")))
        elif h == "file":
            conds.append(Message.message_type == "file")
        elif h == "image":
            conds.append(_mime_cond("image/"))
        elif h == "video":
            conds.append(_mime_cond("video/"))
        elif h == "sound":
            conds.append(_mime_cond("audio/"))
        elif h == "embed":
            conds.append(and_(Message.link_preview.is_not(None), not_(Message.link_preview.like('%"dismissed"%'))))
        else:
            raise SearchError(f"has 는 {', '.join(SEARCH_HAS)} 중 하나입니다")
    b = _day(before, tz)
    if b is not None:
        conds.append(Message.created_at < b)
    a = _day(after, tz)
    if a is not None:
        conds.append(Message.created_at >= a + timedelta(days=1))
    d = _day(during, tz)
    if d is not None:
        conds.append(and_(Message.created_at >= d, Message.created_at < d + timedelta(days=1)))
    if pinned:
        conds.append(Message.pinned_at.is_not(None))

    total = int((await db.execute(select(func.count(Message.id)).where(*conds))).scalar() or 0)
    order = Message.seq.asc() if sort == "old" else Message.seq.desc()
    rows = (await db.execute(
        select(Message, User, Channel)
        .outerjoin(User, User.id == Message.sender_id)
        .join(Channel, Channel.id == Message.channel_id)
        .where(*conds).order_by(order).offset(offset).limit(limit)
    )).all()
    ids = [m.id for m, _u, _c in rows]
    reactions = await service.get_reactions_for_messages(db, ids)
    items = []
    for m, u, c in rows:
        dct = service._message_to_dict(m, u)
        dct["channel_name"] = c.name
        dct["channel_type"] = c.type
        dct["reactions"] = reactions.get(m.id, [])
        items.append(dct)
    await msg22.enrich(db, [(m, dct) for (m, _u, _c), dct in zip(rows, items)])
    for dct in items:
        dct["reply_count"] = (dct.get("thread") or {}).get("reply_count", 0)
    return {"items": items, "total": total, "offset": offset, "limit": limit}
