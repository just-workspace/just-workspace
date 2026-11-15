"""Chat business logic — channel/message/member CRUD."""

import json
import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Channel, ChannelMember, ChatDraft, ChatMention, Message, Reaction, SavedMessage,
    ThreadFollow, User,
)
from app.chat.link_preview import first_external_url, public_preview, stored_url
from app.chat import msg22

# 채널 목록 두 번째 줄에 넣는 마지막 메시지 미리보기 길이
PREVIEW_LEN = 200

# 채널별 알림 수준 값. NULL(기본)은 effective_notify_level 이 채널 종류로 푼다.
NOTIFY_LEVELS = ("all", "mentions", "none")


def effective_notify_level(level: str | None, channel_type: str) -> str:
    """멤버행의 notify_level 이 비어 있으면 DM 은 'all', 그 외는 서버 기본값(chat22 server22, 기본 'mentions').

    서버 기본값은 프로세스 캐시 — 이 값을 쓰는 서비스 함수가 먼저 `await server22.refresh(db)` 를 부른다.
    """
    if level in NOTIFY_LEVELS:
        return level
    if channel_type == "dm":
        return "all"
    from app.chat import server22
    return server22.default_level()


def effective_muted(muted, muted_until, now: datetime | None = None) -> bool:
    """음소거 기간(chat22) — muted 이고 muted_until 이 지났으면 음소거 아님(지연 판정, 배치 정리 없음)."""
    if not muted:
        return False
    if muted_until is None:
        return True
    if muted_until.tzinfo is None:
        muted_until = muted_until.replace(tzinfo=timezone.utc)
    return muted_until > (now or datetime.now(timezone.utc))


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def main_timeline_filter():
    """메인 타임라인에 보이는 메시지 — 원 메시지, 또는 "채널에도 보내기" 한 답글.

    미읽음 계산·마지막 메시지 포인터·타임라인 조회가 같은 조건을 써야 배지와 화면이 어긋나지
    않는다. 기존 행은 auto-migrate 의 DEFAULT FALSE 로 채워지지만 NULL 도 안전하게 받는다.
    """
    return or_(
        Message.parent_id.is_(None),
        func.coalesce(Message.thread_broadcast, False) == True,  # noqa: E712
    )


# ─── Channel ───

async def create_channel(
    db: AsyncSession,
    name: str,
    type: str,
    created_by: str,
    description: str | None = None,
    member_ids: list[str] | None = None,
    voice: bool = False,
    forum_board_id: str | None = None,
) -> Channel:
    channel = Channel(
        id=str(uuid.uuid4()),
        name=name,
        type=type,
        description=description,
        created_by=created_by,
        is_voice=True if voice else None,
        forum_board_id=forum_board_id,
    )
    db.add(channel)

    # Add creator as owner
    db.add(ChannelMember(
        id=str(uuid.uuid4()),
        channel_id=channel.id,
        user_id=created_by,
        role="owner",
    ))

    # Add extra members
    if member_ids:
        for uid in member_ids:
            if uid != created_by:
                db.add(ChannelMember(
                    id=str(uuid.uuid4()),
                    channel_id=channel.id,
                    user_id=uid,
                    role="member",
                ))

    # System message
    db.add(Message(
        id=str(uuid.uuid4()),
        channel_id=channel.id,
        sender_id=None,
        content="채널이 생성되었습니다.",
        message_type="system",
    ))

    await db.commit()
    await db.refresh(channel)
    return channel


async def get_user_channels(db: AsyncSession, user_id: str) -> list[dict]:
    """내가 속한 채널 목록 + 미읽음·멘션 수 + 마지막 메시지(R-13).

    쿼리 3개로 끝낸다(채널 수와 무관). (+ 서버 알림 기본값 캐시가 식었으면 1개)
    1) 채널 + 내 멤버행 + 멤버 수 + 마지막 메시지(channels.last_message_seq 로 1행 조인)
    2) 미읽음: seq > last_read_seq 인, 내가 보낸 게 아닌·삭제되지 않은 메인 타임라인 메시지 수
    3) 멘션: chat_mentions 중 seq > last_read_seq 인 행 수

    예전엔 last_read 를 created_at 으로 환산해 COUNT 두 번 + DISTINCT ON 이었다. seq 비교는
    같은 ms 충돌이 없고 (channel_id, seq) 인덱스를 그대로 탄다. 스레드 답글은 메인 뷰에
    안 보여서 채널을 열어도 읽음 처리가 안 되므로 미읽음에서 뺀다(배지가 영영 안 꺼지는 문제).
    """
    from app.chat import server22
    await server22.refresh(db)
    member_sq = (
        select(
            ChannelMember.channel_id,
            ChannelMember.last_read_seq,
            ChannelMember.last_read_message_id,
            ChannelMember.notify_level,
            ChannelMember.muted,
            ChannelMember.muted_until,
        )
        .where(ChannelMember.user_id == user_id)
        .subquery()
    )
    count_sq = (
        select(
            ChannelMember.channel_id,
            func.count(ChannelMember.id).label("member_count"),
        )
        .group_by(ChannelMember.channel_id)
        .subquery()
    )

    # 마지막 메시지는 비정규화된 seq 로 유니크 인덱스 1회 조회
    LastMsg = Message.__table__.alias("last_msg")
    LastSender = User.__table__.alias("last_sender")

    rows = (
        await db.execute(
            select(
                Channel,
                member_sq.c.last_read_seq,
                member_sq.c.notify_level,
                member_sq.c.muted,
                member_sq.c.muted_until,
                count_sq.c.member_count,
                LastMsg.c.content,
                LastMsg.c.message_type,
                LastMsg.c.created_at,
                LastSender.c.display_name,
                LastSender.c.username,
            )
            .join(member_sq, Channel.id == member_sq.c.channel_id)
            .outerjoin(count_sq, Channel.id == count_sq.c.channel_id)
            .outerjoin(LastMsg, LastMsg.c.seq == Channel.last_message_seq)
            .outerjoin(LastSender, LastSender.c.id == LastMsg.c.sender_id)
            .where(Channel.is_archived == False)  # noqa: E712
            .order_by(Channel.created_at)
        )
    ).all()

    if not rows:
        return []

    # 미읽음 — 멤버행과 조인해 채널마다 다른 last_read_seq 를 한 쿼리에서 비교
    unread_rows = (
        await db.execute(
            select(Message.channel_id, func.count(Message.id))
            .join(member_sq, member_sq.c.channel_id == Message.channel_id)
            .where(
                Message.seq > func.coalesce(member_sq.c.last_read_seq, 0),
                Message.is_deleted == False,  # noqa: E712
                main_timeline_filter(),
                or_(Message.sender_id.is_(None), Message.sender_id != user_id),
            )
            .group_by(Message.channel_id)
        )
    ).all()
    unread_map = {cid: cnt for cid, cnt in unread_rows}

    is_group = func.coalesce(ChatMention.is_group, False)
    mention_rows = (
        await db.execute(
            select(
                ChatMention.channel_id,
                func.count(ChatMention.id).filter(is_group == False),  # noqa: E712
                func.count(ChatMention.id).filter(is_group == True),  # noqa: E712
            )
            .join(member_sq, member_sq.c.channel_id == ChatMention.channel_id)
            .where(
                ChatMention.user_id == user_id,
                ChatMention.seq > func.coalesce(member_sq.c.last_read_seq, 0),
            )
            .group_by(ChatMention.channel_id)
        )
    ).all()
    mention_map = {cid: cnt for cid, cnt, _g in mention_rows}
    group_map = {cid: g > 0 for cid, _c, g in mention_rows}

    result = []
    for ch, last_read_seq, notify_level, muted, muted_until, member_count, lm_content, lm_type, lm_at, lm_dn, lm_un in rows:
        last_message = None
        if ch.last_message_seq is not None and lm_at is not None:
            last_message = {
                "content": lm_content,
                "message_type": lm_type,
                "created_at": lm_at,
                "sender_name": lm_dn or lm_un,
            }
        result.append({
            "id": ch.id,
            "name": ch.name,
            "type": ch.type,
            "description": ch.description,
            "created_by": ch.created_by,
            "is_archived": ch.is_archived,
            "is_voice": bool(ch.is_voice),
            # 카테고리·정렬(P1-1) — 프런트 카테고리 화면(P1-3)이 쓴다. NULL = 카테고리 없음
            "category_id": ch.category_id,
            "position": ch.position,
            "created_at": ch.created_at,
            "updated_at": ch.updated_at,
            "member_count": member_count or 0,
            "unread_count": unread_map.get(ch.id, 0),
            "mention_count": mention_map.get(ch.id, 0),
            "group_mention": group_map.get(ch.id, False),
            "last_read_seq": last_read_seq,
            "last_message_seq": ch.last_message_seq,
            "last_message": last_message,
            # 채널별 알림 설정 — 기본값은 채널 종류로 푼 실효값을 내려 프런트가 따로 계산하지 않게
            "notify_level": effective_notify_level(notify_level, ch.type),
            "muted": effective_muted(muted, muted_until),
            "muted_until": _iso(muted_until) if effective_muted(muted, muted_until) else None,
            # chat22 — 포럼 채널(게시판 연결)·새 스레드 자동 보관 기본값(분)
            "forum_board_id": ch.forum_board_id,
            "default_thread_auto_archive_minutes": ch.default_thread_auto_archive_minutes or msg22.DEFAULT_THREAD_ARCHIVE,
        })

    # 최근 대화가 위로. 메시지가 하나도 없는 채널은 생성 시각으로 정렬한다.
    def _sort_key(item: dict):
        lm = item.get("last_message")
        return (lm or {}).get("created_at") or item["created_at"]

    result.sort(key=_sort_key, reverse=True)
    return result


async def get_channel(db: AsyncSession, channel_id: str) -> Channel | None:
    return await db.get(Channel, channel_id)


async def update_channel(
    db: AsyncSession, channel_id: str, **kwargs
) -> Channel | None:
    ch = await db.get(Channel, channel_id)
    if not ch:
        return None
    for k, v in kwargs.items():
        if v is not None:
            setattr(ch, k, v)
    ch.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(ch)
    return ch


async def delete_channel(db: AsyncSession, channel_id: str) -> bool:
    ch = await db.get(Channel, channel_id)
    if not ch:
        return False
    # 권한 덮어쓰기는 FK 가 없다(대상이 여러 테이블) — 채널과 같이 지운다
    from app.db.models import ChatPermissionOverwrite
    await db.execute(delete(ChatPermissionOverwrite).where(
        ChatPermissionOverwrite.target_kind == "channel", ChatPermissionOverwrite.target_id == channel_id,
    ))
    await db.delete(ch)
    await db.commit()
    return True


# ─── Members ───

async def get_channel_members(db: AsyncSession, channel_id: str) -> list[dict]:
    rows = (
        await db.execute(
            select(ChannelMember, User)
            .join(User, ChannelMember.user_id == User.id)
            .where(ChannelMember.channel_id == channel_id)
            .order_by(ChannelMember.joined_at)
        )
    ).all()
    return [
        {
            "user_id": u.id,
            "username": u.username,
            "display_name": u.display_name,
            "avatar_url": u.avatar_url,
            "role": cm.role,
        }
        for cm, u in rows
    ]


async def add_members(
    db: AsyncSession, channel_id: str, user_ids: list[str]
) -> list[str]:
    added = []
    for uid in user_ids:
        # Check already member
        existing = (
            await db.execute(
                select(ChannelMember).where(
                    ChannelMember.channel_id == channel_id,
                    ChannelMember.user_id == uid,
                )
            )
        ).scalar_one_or_none()
        if existing:
            continue
        db.add(ChannelMember(
            id=str(uuid.uuid4()),
            channel_id=channel_id,
            user_id=uid,
            role="member",
        ))
        added.append(uid)
    if added:
        await db.commit()
    return added


async def remove_member(
    db: AsyncSession, channel_id: str, user_id: str
) -> bool:
    result = await db.execute(
        delete(ChannelMember).where(
            ChannelMember.channel_id == channel_id,
            ChannelMember.user_id == user_id,
        )
    )
    await db.commit()
    return result.rowcount > 0


async def is_channel_member(
    db: AsyncSession, channel_id: str, user_id: str
) -> bool:
    row = (
        await db.execute(
            select(ChannelMember.id).where(
                ChannelMember.channel_id == channel_id,
                ChannelMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    return row is not None


async def get_member_role(
    db: AsyncSession, channel_id: str, user_id: str
) -> str | None:
    row = (
        await db.execute(
            select(ChannelMember.role).where(
                ChannelMember.channel_id == channel_id,
                ChannelMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    return row


# ─── Messages ───

async def create_message(
    db: AsyncSession,
    channel_id: str,
    sender_id: str | None,
    content: str,
    message_type: str = "text",
    file_meta: str | None = None,
    parent_id: str | None = None,
    thread_broadcast: bool = False,
    reply_to_id: str | None = None,
    flags: int = 0,
    attachments: str | None = None,
) -> dict:
    """메시지 1건 생성. 답글(parent_id)이면 스레드 팔로우도 함께 맞춘다.

    chat22: reply_to_id(인라인 답장 — 호출자가 msg22.validate_reply 로 검사), flags(SILENT·REPLY_PING),
    attachments(JSON 배열). 답글이 오면 루트 스레드의 보관을 풀고 마지막 활동을 올린다.

    `thread_broadcast`("채널에도 보내기")는 답글에만 의미가 있다 — 원 메시지에 오면 무시.
    답글 작성자는 자기 답글까지 읽은 것으로, 루트 작성자는 자동 팔로우(단, 끊어 둔 사람은 그대로).
    """
    thread_broadcast = bool(thread_broadcast and parent_id is not None)
    msg = Message(
        id=str(uuid.uuid4()),
        channel_id=channel_id,
        sender_id=sender_id,
        content=content,
        message_type=message_type,
        file_meta=file_meta,
        parent_id=parent_id,
        thread_broadcast=thread_broadcast,
        reply_to_id=reply_to_id,
        flags=flags or 0,
        attachments=attachments,
    )
    db.add(msg)
    await db.flush()
    # PG 에서는 seq 가 INSERT 의 nextval 로 들어가고 ORM 은 그 컬럼을 expire 만 해두므로
    # msg.seq 를 그냥 읽으면 async 세션에서 암묵적 IO(MissingGreenlet)가 난다 → 명시 조회.
    seq = (
        await db.execute(select(Message.seq).where(Message.id == msg.id))
    ).scalar_one()
    if parent_id is None or thread_broadcast:
        await _bump_channel_last_message(db, channel_id, seq, msg.created_at, content)
    if parent_id is not None:
        await _auto_follow_on_reply(db, parent_id, channel_id, sender_id, seq)
        # 보관된 스레드에 답글이 오면 보관 해제(디스코드와 같다)
        await db.execute(
            update(Message).where(Message.id == parent_id)
            .values(thread_archived_at=None, thread_activity_at=msg.created_at, updated_at=Message.updated_at)
        )
    await db.commit()
    await db.refresh(msg)

    # Fetch sender info
    sender = await db.get(User, sender_id) if sender_id else None
    d = _message_to_dict(msg, sender)
    if reply_to_id:
        await msg22.enrich(db, [(msg, d)])
    return d


async def _auto_follow_on_reply(
    db: AsyncSession, root_id: str, channel_id: str, sender_id: str | None, reply_seq: int
) -> None:
    """답글이 달렸다 — 답글 작성자(다시 켜고 읽음 포인터를 이 답글로)·루트 작성자(없으면 추가)."""
    root_sender = (
        await db.execute(select(Message.sender_id).where(Message.id == root_id))
    ).scalar_one_or_none()
    if sender_id:
        await ensure_thread_follows(
            db, root_id, channel_id, [sender_id], refollow=True, read_seq=reply_seq,
        )
    if root_sender and root_sender != sender_id:
        await ensure_thread_follows(db, root_id, channel_id, [root_sender])


async def _bump_channel_last_message(
    db: AsyncSession, channel_id: str, seq: int, created_at: datetime, content: str | None
) -> None:
    """channels.last_message_* 를 이 메시지로 올린다 — 단, seq 가 더 큰 쪽이 이미 있으면 그대로.

    워커 8개가 같은 채널에 동시에 쓰면 커밋 순서가 seq 순과 다를 수 있어서 `<` 가드가
    필요하다. updated_at 은 채널 설정 변경용이라 건드리지 않는다(onupdate 억제).
    """
    await db.execute(
        update(Channel)
        .where(
            Channel.id == channel_id,
            or_(Channel.last_message_seq.is_(None), Channel.last_message_seq < seq),
        )
        .values(
            last_message_seq=seq,
            last_message_at=created_at,
            last_preview=(content or "")[:PREVIEW_LEN],
            updated_at=Channel.updated_at,
        )
    )


async def _recompute_channel_last_message(db: AsyncSession, channel_id: str) -> None:
    """마지막 메시지가 삭제됐을 때 그 직전 메시지로 포인터를 되감는다. 없으면 NULL."""
    prev = (
        await db.execute(
            select(Message)
            .where(
                Message.channel_id == channel_id,
                Message.is_deleted == False,  # noqa: E712
                main_timeline_filter(),
            )
            .order_by(Message.seq.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    await db.execute(
        update(Channel)
        .where(Channel.id == channel_id)
        .values(
            last_message_seq=prev.seq if prev else None,
            last_message_at=prev.created_at if prev else None,
            last_preview=(prev.content or "")[:PREVIEW_LEN] if prev else None,
            updated_at=Channel.updated_at,
        )
    )


async def _seq_of(db: AsyncSession, message_id: str | None) -> int | None:
    """메시지 id 커서를 seq 로 바꾼다. 없는 id 면 None(= 커서 무시, 기존 동작 유지)."""
    if not message_id:
        return None
    return (
        await db.execute(select(Message.seq).where(Message.id == message_id))
    ).scalar_one_or_none()


async def get_messages(
    db: AsyncSession,
    channel_id: str,
    before: str | None = None,
    after: str | None = None,
    limit: int = 50,
    before_seq: int | None = None,
    after_seq: int | None = None,
    user_id: str | None = None,
) -> tuple[list[dict], bool]:
    """채널 메인 타임라인 한 페이지.

    user_id 를 주면 각 메시지에 is_saved(내가 저장했는지)를 붙인다. 답글이 있는 메시지에는
    thread_participants(최근 답글 순 최대 5명)·last_reply_at 도 붙는다.

    커서는 전부 seq 로 푼다(R-16). `before`/`after` 는 메시지 id(기존 프런트 호환),
    `before_seq`/`after_seq` 는 seq 직접 지정(재접속 복구·캐시 델타용). 둘 다 오면
    seq 쪽이 이긴다. created_at 커서는 같은 ms 에 두 메시지가 있으면 하나를 건너뛰어서
    더 쓰지 않는다.
    """
    q = (
        select(Message, User)
        .outerjoin(User, Message.sender_id == User.id)
        .where(
            Message.channel_id == channel_id,
            Message.is_deleted == False,  # noqa: E712
            main_timeline_filter(),   # 답글은 "채널에도 보내기" 한 것만 메인 뷰에
        )
    )

    if before_seq is None:
        before_seq = await _seq_of(db, before)
    if after_seq is None:
        after_seq = await _seq_of(db, after)

    if before_seq is not None:
        q = q.where(Message.seq < before_seq)
    if after_seq is not None:
        q = q.where(Message.seq > after_seq)

    forward = after_seq is not None
    if forward:
        q = q.order_by(Message.seq.asc())
    else:
        q = q.order_by(Message.seq.desc())

    q = q.limit(limit + 1)
    rows = (await db.execute(q)).all()

    has_more = len(rows) > limit
    rows = rows[:limit]

    if not forward:
        rows = list(reversed(rows))

    # Build read_by map: member → last_read_seq
    read_by_map = await _build_read_by_map(db, channel_id)

    # Get reply counts for these messages
    msg_ids = [msg.id for msg, _ in rows]
    reply_counts = await get_thread_reply_count(db, msg_ids)

    # Get reactions for these messages
    reactions_map = await get_reactions_for_messages(db, msg_ids)
    saved = await get_saved_ids(db, user_id, msg_ids) if user_id else set()
    thread_meta = await get_thread_meta(db, [m for m in msg_ids if reply_counts.get(m)])

    result = []
    for msg, user in rows:
        d = _message_to_dict(msg, user)
        d["reply_count"] = reply_counts.get(msg.id, 0)
        d["reactions"] = reactions_map.get(msg.id, [])
        d["is_saved"] = msg.id in saved
        tm = thread_meta.get(msg.id)
        d["thread_participants"] = tm["participants"] if tm else []
        d["last_reply_at"] = tm["last_reply_at"] if tm else None
        # Compute who has read this message (exclude sender)
        readers = []
        for member_info, read_up_to in read_by_map:
            if read_up_to is not None and msg.seq is not None and read_up_to >= msg.seq:
                if member_info["id"] != (msg.sender_id or ""):
                    readers.append(member_info)
        d["read_by"] = readers
        result.append(d)

    await msg22.enrich(db, [(msg, d) for (msg, _u), d in zip(rows, result)])
    return result, has_more


async def _build_read_by_map(
    db: AsyncSession, channel_id: str
) -> list[tuple[dict, int | None]]:
    """[(user_info_dict, last_read_seq), ...] — 채널 멤버 전원.

    읽음 포인터가 seq 라서 메시지 테이블 조인 없이 멤버행만 읽으면 된다.
    """
    member_rows = (
        await db.execute(
            select(ChannelMember.last_read_seq, User)
            .join(User, ChannelMember.user_id == User.id)
            .where(ChannelMember.channel_id == channel_id)
        )
    ).all()

    return [
        (
            {
                "id": u.id,
                "username": u.username,
                "display_name": u.display_name,
                "avatar_url": u.avatar_url,
            },
            read_seq,
        )
        for read_seq, u in member_rows
    ]


async def update_message(
    db: AsyncSession, message_id: str, content: str
) -> dict | None:
    msg = await db.get(Message, message_id)
    if not msg:
        return None
    msg.content = content
    msg.is_edited = True
    msg.updated_at = datetime.now(timezone.utc)
    # 첫 외부 링크가 바뀌면 예전 카드(또는 "지움" 표시)를 버린다 — 새 카드는 라우터가 다시 예약한다
    if msg.link_preview and stored_url(msg.link_preview) != first_external_url(content):
        msg.link_preview = None
    await db.commit()
    await db.refresh(msg)
    sender = await db.get(User, msg.sender_id) if msg.sender_id else None
    d = _message_to_dict(msg, sender)
    await msg22.enrich(db, [(msg, d)])
    return d


async def soft_delete_message(
    db: AsyncSession, message_id: str
) -> bool:
    msg = await db.get(Message, message_id)
    if not msg:
        return False
    msg.is_deleted = True
    msg.content = ""
    msg.link_preview = None
    msg.updated_at = datetime.now(timezone.utc)
    # 멘션 배지는 삭제된 메시지를 세면 안 된다 — 행을 지워 카운트 쿼리에 조인을 안 둔다
    await db.execute(delete(ChatMention).where(ChatMention.message_id == message_id))
    # 채널 목록의 "마지막 메시지" 가 이 메시지였으면 직전 것으로 되감는다
    ch = await db.get(Channel, msg.channel_id)
    if ch is not None and ch.last_message_seq is not None and ch.last_message_seq == msg.seq:
        await _recompute_channel_last_message(db, msg.channel_id)
    await db.commit()
    return True


async def mark_read(
    db: AsyncSession, channel_id: str, user_id: str, message_id: str
) -> int | None:
    """읽음 포인터를 message_id 의 seq 로 올린다. 올린 seq 를 돌려준다(없거나 뒤로 가면 None).

    포인터는 단조 증가만 한다 — 스크롤을 올려 옛 메시지를 보다가 mark_read 가 와도
    미읽음이 되살아나면 안 된다. 메시지가 다른 채널 것이거나 없으면 무시한다.
    """
    seq = (
        await db.execute(
            select(Message.seq).where(
                Message.id == message_id, Message.channel_id == channel_id
            )
        )
    ).scalar_one_or_none()
    if seq is None:
        return None

    result = await db.execute(
        update(ChannelMember)
        .where(
            ChannelMember.channel_id == channel_id,
            ChannelMember.user_id == user_id,
            or_(ChannelMember.last_read_seq.is_(None), ChannelMember.last_read_seq < seq),
        )
        .values(last_read_message_id=message_id, last_read_seq=seq)
    )
    await db.commit()
    return seq if result.rowcount else None


async def mark_unread(
    db: AsyncSession, channel_id: str, user_id: str, message_id: str
) -> int | None:
    """"여기부터 안 읽음" — 읽음 포인터를 message_id 의 seq 바로 앞으로 **되감는다**.

    mark_read 와 달리 뒤로 가는 것이 목적이다(이미 그보다 앞이면 그대로). 그 메시지와 그 뒤의
    메인 타임라인 메시지·멘션이 다시 미읽음으로 센다. 돌려주는 값은 새 포인터(seq - 1);
    메시지가 다른 채널 것이거나 없으면 None.
    """
    seq = (
        await db.execute(
            select(Message.seq).where(
                Message.id == message_id, Message.channel_id == channel_id
            )
        )
    ).scalar_one_or_none()
    if seq is None:
        return None
    new_seq = max(seq - 1, 0)
    result = await db.execute(
        update(ChannelMember)
        .where(
            ChannelMember.channel_id == channel_id,
            ChannelMember.user_id == user_id,
            or_(ChannelMember.last_read_seq.is_(None), ChannelMember.last_read_seq > new_seq),
        )
        # 포인터가 가리키는 메시지 id 는 이제 모르니 비운다(백필 로직은 last_read_seq 가 NULL 일 때만 본다)
        .values(last_read_message_id=None, last_read_seq=new_seq)
    )
    await db.commit()
    return new_seq if result.rowcount else None


async def get_unread_state(db: AsyncSession, user_id: str, channel_id: str) -> dict:
    """채널 하나의 {unread_count, mention_count, group_mention} — WS 이벤트 한 건에 쓴다.

    get_user_channels 의 미읽음·멘션 쿼리와 같은 조건이어야 한다.
    """
    last_read = (
        await db.execute(
            select(ChannelMember.last_read_seq).where(
                ChannelMember.channel_id == channel_id,
                ChannelMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    unread = (
        await db.execute(
            select(func.count(Message.id)).where(
                Message.channel_id == channel_id,
                Message.seq > (last_read or 0),
                Message.is_deleted == False,  # noqa: E712
                main_timeline_filter(),
                or_(Message.sender_id.is_(None), Message.sender_id != user_id),
            )
        )
    ).scalar_one()
    mention_count, group = await get_mention_state(db, user_id, channel_id)
    return {
        "unread_count": int(unread or 0),
        "mention_count": mention_count,
        "group_mention": group,
    }


# ─── 채널별 알림 설정 ───


async def update_channel_prefs(
    db: AsyncSession,
    channel_id: str,
    user_id: str,
    notify_level: str | None = None,
    muted: bool | None = None,
    desktop: bool | None = None,
    push: bool | None = None,
    email: bool | None = None,
    thread_replies: bool | None = None,
    muted_minutes=...,
) -> dict | None:
    """내 멤버행의 notify_level/muted/기기 알림 세부를 바꾼다. 멤버가 아니면 None. 바뀐 뒤의 실효값을 돌려준다.

    muted_minutes(chat22): 정수 = 지금부터 그 분 동안 음소거, None = 내가 끌 때까지, ...(안 줌) = 손대지 않음.
    muted=False 면 기간도 지운다.
    """
    from app.chat import server22
    await server22.refresh(db)
    row = (
        await db.execute(
            select(ChannelMember, Channel.type)
            .join(Channel, Channel.id == ChannelMember.channel_id)
            .where(
                ChannelMember.channel_id == channel_id,
                ChannelMember.user_id == user_id,
            )
        )
    ).one_or_none()
    if row is None:
        return None
    cm, ch_type = row
    if notify_level is not None:
        cm.notify_level = notify_level
    if muted is not None:
        cm.muted = muted
        if not muted or muted_minutes is ...:
            cm.muted_until = None
    if muted_minutes is not ... and muted is not False:
        cm.muted = True
        cm.muted_until = (datetime.now(timezone.utc) + timedelta(minutes=muted_minutes)
                          if muted_minutes else None)
    if desktop is not None:
        cm.pref_desktop = desktop
    if push is not None:
        cm.pref_push = push
    if email is not None:
        cm.pref_email = email
    if thread_replies is not None:
        cm.pref_thread_replies = thread_replies
    await db.commit()
    return _prefs_dict(channel_id, cm, ch_type)


def _prefs_dict(channel_id: str, cm, ch_type: str) -> dict:
    muted = effective_muted(cm.muted, cm.muted_until)
    return {
        "channel_id": channel_id,
        "notify_level": effective_notify_level(cm.notify_level, ch_type),
        "muted": muted,
        "muted_until": _iso(cm.muted_until) if muted else None,
        **_device_prefs(cm),
    }


def _device_prefs(cm) -> dict:
    """NULL(마이그레이션 직후 등)은 기본값으로 푼다."""
    return {
        "desktop": cm.pref_desktop is not False,
        "push": cm.pref_push is not False,
        "email": bool(cm.pref_email),
        "thread_replies": cm.pref_thread_replies is not False,
    }


async def get_channel_prefs(db: AsyncSession, channel_id: str, user_id: str) -> dict | None:
    from app.chat import server22
    await server22.refresh(db)
    row = (
        await db.execute(
            select(ChannelMember, Channel.type)
            .join(Channel, Channel.id == ChannelMember.channel_id)
            .where(ChannelMember.channel_id == channel_id, ChannelMember.user_id == user_id)
        )
    ).one_or_none()
    if row is None:
        return None
    cm, ch_type = row
    return _prefs_dict(channel_id, cm, ch_type)


async def get_members_for_notify(db: AsyncSession, channel_id: str) -> list[dict]:
    """푸시 판단용 멤버 전원 — 한 쿼리. [{user_id, username, display_name, notify_level(실효), muted}]."""
    from app.chat import server22
    await server22.refresh(db)
    rows = (
        await db.execute(
            select(ChannelMember.user_id, ChannelMember.notify_level, ChannelMember.muted,
                   User.username, User.display_name, Channel.type,
                   ChannelMember.pref_push, ChannelMember.pref_thread_replies, ChannelMember.muted_until)
            .join(User, User.id == ChannelMember.user_id)
            .join(Channel, Channel.id == ChannelMember.channel_id)
            .where(ChannelMember.channel_id == channel_id)
        )
    ).all()
    return [
        {
            "user_id": uid,
            "username": un,
            "display_name": dn,
            "notify_level": effective_notify_level(level, ch_type),
            "muted": effective_muted(muted, muted_until),
            "push": pref_push is not False,
            "thread_replies": pref_thread is not False,
        }
        for uid, level, muted, un, dn, ch_type, pref_push, pref_thread, muted_until in rows
    ]


# ─── DM ───

async def get_or_create_dm(
    db: AsyncSession, user_id: str, other_user_id: str
) -> Channel:
    """Find existing DM channel between two users, or create one."""
    # Find channels where both users are members and type is dm
    my_channels = select(ChannelMember.channel_id).where(
        ChannelMember.user_id == user_id
    ).subquery()
    their_channels = select(ChannelMember.channel_id).where(
        ChannelMember.user_id == other_user_id
    ).subquery()

    row = (
        await db.execute(
            select(Channel)
            .where(
                Channel.type == "dm",
                Channel.id.in_(select(my_channels.c.channel_id)),
                Channel.id.in_(select(their_channels.c.channel_id)),
            )
            .limit(1)
        )
    ).scalar_one_or_none()

    if row:
        return row

    # Create new DM
    other = await db.get(User, other_user_id)
    me = await db.get(User, user_id)
    dm_name = f"{me.username},{other.username}" if me and other else "DM"

    channel = Channel(
        id=str(uuid.uuid4()),
        name=dm_name,
        type="dm",
        created_by=user_id,
    )
    db.add(channel)
    db.add(ChannelMember(
        id=str(uuid.uuid4()), channel_id=channel.id,
        user_id=user_id, role="member",
    ))
    db.add(ChannelMember(
        id=str(uuid.uuid4()), channel_id=channel.id,
        user_id=other_user_id, role="member",
    ))
    await db.commit()
    await db.refresh(channel)
    return channel


# ─── User Search ───

async def search_users(
    db: AsyncSession, query: str | None = None, limit: int = 50
) -> list[dict]:
    q = select(User).where(User.is_active == True)  # noqa: E712
    if query:
        q = q.where(
            (User.username.ilike(f"%{query.replace('%', '\\%').replace('_', '\\_')}%", escape='\\'))
            | (User.display_name.ilike(f"%{query.replace('%', '\\%').replace('_', '\\_')}%", escape='\\'))
        )
    q = q.order_by(User.display_name, User.username).limit(limit)
    rows = (await db.execute(q)).scalars().all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "display_name": u.display_name,
            "avatar_url": u.avatar_url,
        }
        for u in rows
    ]


# ─── Message Search ───

async def search_messages(
    db: AsyncSession,
    user_id: str,
    query: str,
    channel_id: str | None = None,
    limit: int = 20,
) -> list[dict]:
    """Search messages the user has access to.

    ILIKE 부분일치를 유지한다(한국어 요구사항). session.py 가 messages.content 에
    pg_trgm GIN(ix_messages_content_trgm) 을 깔아 이 쿼리가 인덱스를 탄다 — 단, trigram
    특성상 질의가 3글자 미만이면 플래너가 순차 스캔으로 떨어질 수 있다.
    """
    # Get user's channel IDs
    user_channels_q = select(ChannelMember.channel_id).where(
        ChannelMember.user_id == user_id
    )

    q = (
        select(Message, User, Channel)
        .outerjoin(User, Message.sender_id == User.id)
        .join(Channel, Message.channel_id == Channel.id)
        .where(
            Message.channel_id.in_(user_channels_q),
            Message.is_deleted == False,  # noqa: E712
            Message.content.ilike(f"%{query.replace('%', '\\%').replace('_', '\\_')}%", escape='\\'),
        )
    )

    if channel_id:
        q = q.where(Message.channel_id == channel_id)

    q = q.order_by(Message.created_at.desc()).limit(limit)
    rows = (await db.execute(q)).all()

    out = [
        {
            **_message_to_dict(msg, user),
            "channel_name": ch.name,
            "channel_type": ch.type,
        }
        for msg, user, ch in rows
    ]
    await msg22.enrich(db, [(m, d) for (m, _u, _c), d in zip(rows, out)])
    return out


# ─── Mentions & Notifications ───

# 사용자 이름에 . - 가 들어갈 수 있다(first-last). 끝의 . - 는 문장부호로 본다 — 프런트 utils/chatMarkdown.ts 와 같게.
MENTION_RE = re.compile(r'(?:^|(?<=\s))@(\w(?:[\w.-]*\w)?)')


# 채널 전원을 부르는 말. 프런트 utils/chatMarkdown.ts 의 GROUP_MENTIONS 와 같아야 한다.
GROUP_MENTIONS = frozenset({"channel", "all", "here", "everyone", "채널", "전체", "모두"})


def parse_mentions(content: str) -> list[str]:
    """Extract unique usernames from @mentions in message content (그룹 멘션 단어 포함)."""
    return list(dict.fromkeys(MENTION_RE.findall(content)))


def split_mentions(names: list[str]) -> tuple[list[str], bool]:
    """(개인 사용자명들, 그룹 멘션 여부)."""
    group = any(n.lower() in GROUP_MENTIONS for n in names)
    return [n for n in names if n.lower() not in GROUP_MENTIONS], group


async def create_notifications_for_mentions(
    db: AsyncSession,
    msg_dict: dict,
    channel_id: str,
    sender_id: str,
    usernames: list[str],
    silent: bool = False,
) -> list[dict]:
    """Create Notification rows for valid mentions. Returns list of notification dicts.

    silent(@silent, chat22): 멘션 행(배지)은 남기고 알림(인앱·푸시)은 만들지 않는다 — 돌려주는 것은
    {"user_id", "silent": True} 만 있는 dict(배지 갱신 대상).
    """
    from app.notifications.service import create_notification

    if not usernames:
        return []
    usernames, is_group = split_mentions(usernames)

    ch = await db.get(Channel, channel_id)
    ch_type = ch.type if ch else "public"
    from app.chat import server22
    await server22.refresh(db)

    # @everyone·@채널 — MENTION_EVERYONE(그림자 모드에선 예전처럼 누구나, 차이만 기록)
    from app.chat import permissions as perms
    if is_group and ch is not None and not await perms.allowed(
        db, perms.system_user(sender_id), "mention.everyone", ch,
    ):
        is_group = False

    # 채널 멤버 전원 + 알림 수준(한 쿼리). 'none' 인 사람은 인앱 알림·배지만 받고 푸시는 안 간다.
    member_rows = (
        await db.execute(
            select(ChannelMember.user_id, ChannelMember.notify_level, ChannelMember.pref_push)
            .where(ChannelMember.channel_id == channel_id)
        )
    ).all()
    member_ids = {uid for uid, _lvl, _p in member_rows}
    # 'none' 이거나 이 채널 기기 푸시를 끈 사람은 인앱 알림만
    push_ok = {
        uid: effective_notify_level(lvl, ch_type) != "none" and pref_push is not False
        for uid, lvl, pref_push in member_rows
    }

    # Look up mentioned users by username
    mentioned_users = (
        await db.execute(
            select(User).where(
                User.username.in_(usernames),
                User.is_active == True,  # noqa: E712
            )
        )
    ).scalars().all() if usernames else []

    sender = await db.get(User, sender_id)
    sender_name = (sender.display_name or sender.username) if sender else "알 수 없음"

    # 보낸 사람 자신과 비멤버는 제외. 멘션 행과 알림은 같은 대상 집합에 남겨 숫자가 어긋나지 않게.
    targets = [u for u in mentioned_users if u.id != sender_id and u.id in member_ids]
    personal_ids = {u.id for u in targets}

    # @역할(P1-1) — 사용자 이름이 아닌 것만 역할로 본다(같은 이름이면 사람이 이긴다).
    # 받는 사람은 개인 멘션처럼 센다(배지·알림). 이미 이름으로 불린 사람은 한 번만.
    found_names = {u.username.lower() for u in mentioned_users}
    role_targets: list[tuple[str, str]] = []   # (user_id, 역할 이름)
    try:
        from app.chat.roles import resolve_role_mentions
        leftover = [n for n in usernames if n.lower() not in found_names]
        for role, uids in await perms.guarded(
            db, lambda: resolve_role_mentions(db, leftover, ch, sender_id),
        ):
            for uid in uids:
                if uid not in personal_ids and uid not in {t for t, _ in role_targets}:
                    role_targets.append((uid, role.name))
    except Exception:
        role_targets = []
    if role_targets:
        active = set((await db.execute(
            select(User.id).where(User.id.in_([u for u, _ in role_targets]), User.is_active == True)  # noqa: E712
        )).scalars().all())
        role_targets = [(u, n) for u, n in role_targets if u in active]
    role_ids_hit = {u for u, _ in role_targets}

    await record_mentions(db, msg_dict, channel_id, list(personal_ids | role_ids_hit))

    # 그룹 멘션(@채널 등) — 이름이 따로 불리지 않은 나머지 멤버 전원
    group_ids: list[str] = []
    if is_group:
        group_ids = [uid for uid in member_ids if uid != sender_id and uid not in personal_ids]
        group_ids = [uid for uid in group_ids if uid not in role_ids_hit]
        if group_ids:
            active = set(
                (await db.execute(
                    select(User.id).where(User.id.in_(group_ids), User.is_active == True)  # noqa: E712
                )).scalars().all()
            )
            group_ids = [uid for uid in group_ids if uid in active]
        await record_mentions(db, msg_dict, channel_id, group_ids, is_group=True)
    ch_label = f"#{ch.name}" if ch and ch.type != "dm" else "대화"

    # 답글 안에서 불린 사람은 그 스레드를 자동 팔로우한다(그룹 멘션은 제외 — 전원 구독은 과하다)
    if msg_dict.get("parent_id") and personal_ids:
        await ensure_thread_follows(db, msg_dict["parent_id"], channel_id, list(personal_ids))

    notifications = []
    role_name_of = dict(role_targets)
    recipients = ([(u.id, False) for u in targets] + [(u, False) for u, _ in role_targets]
                  + [(uid, True) for uid in group_ids])
    if silent:
        return [{"user_id": uid, "silent": True, "is_group": group} for uid, group in recipients]
    for uid, group in recipients:
        role_name = role_name_of.get(uid) if not group else None
        notif_dict = await create_notification(
            db,
            user_id=uid,
            type="mention",
            title=(f"{sender_name}님이 {ch_label} 전체를 불렀습니다" if group
                   else f"{sender_name}님이 @{role_name} 역할을 불렀습니다" if role_name
                   else f"{sender_name}님이 회원님을 멘션했습니다"),
            body=msg_dict.get("content", "")[:200],
            link=f"/chat?channel={channel_id}",
            push=push_ok.get(uid, True),
        )
        notif_dict["channel_id"] = channel_id
        notif_dict["message_id"] = msg_dict.get("id")
        notif_dict["seq"] = msg_dict.get("seq")
        notif_dict["is_group"] = group
        if role_name:
            notif_dict["role_name"] = role_name
        notifications.append(notif_dict)

    return notifications


async def record_mentions(
    db: AsyncSession,
    msg_dict: dict,
    channel_id: str,
    user_ids: list[str],
    is_group: bool = False,
) -> int:
    """채널별 멘션 배지용 chat_mentions 행을 남긴다(R-13). 남긴 행 수를 돌려준다.

    msg_dict 는 create_message 가 돌려준 것(id·seq 포함). 같은 메시지로 두 번 불려도
    유니크 인덱스에 걸리는 행은 건너뛴다 — 재전송·재처리에 안전.
    """
    seq = msg_dict.get("seq")
    message_id = msg_dict.get("id")
    if not user_ids or seq is None or not message_id:
        return 0

    existing = set(
        (
            await db.execute(
                select(ChatMention.user_id).where(
                    ChatMention.message_id == message_id,
                    ChatMention.user_id.in_(user_ids),
                )
            )
        ).scalars().all()
    )
    added = 0
    for uid in dict.fromkeys(user_ids):
        if uid in existing:
            continue
        db.add(ChatMention(
            id=str(uuid.uuid4()),
            user_id=uid,
            channel_id=channel_id,
            message_id=message_id,
            seq=seq,
            is_group=is_group,
        ))
        added += 1
    if added:
        await db.commit()
    return added


async def get_mention_count(db: AsyncSession, user_id: str, channel_id: str) -> int:
    """채널 하나의 미읽음 개인 멘션 수 — 채널 하나만 갱신할 때(WS 이벤트) 쓴다."""
    c, _g = await get_mention_state(db, user_id, channel_id)
    return c


async def get_mention_state(db: AsyncSession, user_id: str, channel_id: str) -> tuple[int, bool]:
    """(미읽음 개인 멘션 수, 미읽음 그룹 멘션 있음)."""
    last_read = (
        await db.execute(
            select(ChannelMember.last_read_seq).where(
                ChannelMember.channel_id == channel_id,
                ChannelMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    is_group = func.coalesce(ChatMention.is_group, False)
    row = (
        await db.execute(
            select(
                func.count(ChatMention.id).filter(is_group == False),  # noqa: E712
                func.count(ChatMention.id).filter(is_group == True),  # noqa: E712
            ).where(
                ChatMention.user_id == user_id,
                ChatMention.channel_id == channel_id,
                ChatMention.seq > (last_read or 0),
            )
        )
    ).one()
    return int(row[0] or 0), bool(row[1])


# ─── Threads ───

async def get_thread_reply_count(
    db: AsyncSession, message_ids: list[str]
) -> dict[str, int]:
    """Return {parent_id: reply_count} for the given message IDs."""
    if not message_ids:
        return {}
    rows = (
        await db.execute(
            select(Message.parent_id, func.count(Message.id))
            .where(
                Message.parent_id.in_(message_ids),
                Message.is_deleted == False,  # noqa: E712
            )
            .group_by(Message.parent_id)
        )
    ).all()
    return {pid: cnt for pid, cnt in rows}


async def get_saved_ids(db: AsyncSession, user_id: str | None, message_ids: list[str]) -> set[str]:
    if not user_id or not message_ids:
        return set()
    rows = (await db.execute(
        select(SavedMessage.message_id).where(
            SavedMessage.user_id == user_id, SavedMessage.message_id.in_(message_ids)
        )
    )).scalars().all()
    return set(rows)


async def get_thread_meta(db: AsyncSession, root_ids: list[str]) -> dict[str, dict]:
    """{root_id: {participants: [{id, username, display_name, avatar_url}], last_reply_at}} — 한 쿼리."""
    if not root_ids:
        return {}
    rows = (await db.execute(
        select(Message.parent_id, Message.sender_id, func.max(Message.created_at))
        .where(Message.parent_id.in_(root_ids), Message.is_deleted == False)  # noqa: E712
        .group_by(Message.parent_id, Message.sender_id)
    )).all()
    per: dict[str, list[tuple]] = {}
    sender_ids: set[str] = set()
    for pid, sid, last in rows:
        per.setdefault(pid, []).append((last, sid))
        if sid:
            sender_ids.add(sid)
    users = {
        u.id: u for u in (await db.execute(select(User).where(User.id.in_(sender_ids)))).scalars().all()
    } if sender_ids else {}
    out: dict[str, dict] = {}
    for pid, lst in per.items():
        lst.sort(key=lambda t: t[0], reverse=True)
        parts = []
        for _last, sid in lst:
            u = users.get(sid)
            if u and len(parts) < 5:
                parts.append({"id": u.id, "username": u.username, "display_name": u.display_name,
                              "avatar_url": u.avatar_url})
        last = lst[0][0]
        out[pid] = {"participants": parts, "last_reply_at": last.isoformat() if last else None}
    return out


async def get_thread_messages(
    db: AsyncSession, parent_id: str, limit: int = 100, user_id: str | None = None,
) -> list[dict]:
    """Get replies to a parent message, oldest first.

    limit 를 넘으면 **최신** limit 개를 준다 — 예전엔 오래된 것부터 잘라, 답글이 많은 스레드에서 최근 답글이 안 보였다.
    """
    rows = (
        await db.execute(
            select(Message, User)
            .outerjoin(User, Message.sender_id == User.id)
            .where(
                Message.parent_id == parent_id,
                Message.is_deleted == False,  # noqa: E712
            )
            .order_by(Message.seq.desc())
            .limit(limit)
        )
    ).all()
    rows = list(reversed(rows))

    msg_ids = [msg.id for msg, _ in rows]
    reactions_map = await get_reactions_for_messages(db, msg_ids)
    saved = await get_saved_ids(db, user_id, msg_ids) if user_id else set()

    result = []
    for msg, user in rows:
        d = _message_to_dict(msg, user)
        d["reply_count"] = 0
        d["reactions"] = reactions_map.get(msg.id, [])
        d["is_saved"] = msg.id in saved
        result.append(d)
    await msg22.enrich(db, [(m, d) for (m, _u), d in zip(rows, result)])
    for d in result:
        d["thread"] = None   # 답글에는 스레드 메타가 없다
    return result


# ─── Reactions ───

async def toggle_reaction(
    db: AsyncSession, message_id: str, user_id: str, emoji: str
) -> dict:
    """Toggle a reaction: add if not exists, remove if exists. Returns action and reaction state."""
    existing = (
        await db.execute(
            select(Reaction).where(
                Reaction.message_id == message_id,
                Reaction.user_id == user_id,
                Reaction.emoji == emoji,
            )
        )
    ).scalar_one_or_none()

    if existing:
        await db.delete(existing)
        await db.commit()
        action = "removed"
    else:
        db.add(Reaction(
            id=str(uuid.uuid4()),
            message_id=message_id,
            user_id=user_id,
            emoji=emoji,
        ))
        await db.commit()
        action = "added"

    # Return current reaction state for this message
    reactions = await get_reactions_for_messages(db, [message_id])
    return {
        "action": action,
        "message_id": message_id,
        "reactions": reactions.get(message_id, []),
    }


async def get_reactions_for_messages(
    db: AsyncSession, message_ids: list[str]
) -> dict[str, list[dict]]:
    """Return {message_id: [{emoji, count, user_ids}]} for the given message IDs."""
    if not message_ids:
        return {}
    rows = (
        await db.execute(
            select(Reaction.message_id, Reaction.emoji, Reaction.user_id)
            .where(Reaction.message_id.in_(message_ids))
            .order_by(Reaction.emoji)
        )
    ).all()

    # Group by message_id → emoji → user_ids
    from collections import defaultdict
    msg_emoji_map: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for mid, emoji, uid in rows:
        msg_emoji_map[mid][emoji].append(uid)

    result: dict[str, list[dict]] = {}
    for mid, emojis in msg_emoji_map.items():
        result[mid] = [
            {"emoji": emoji, "count": len(uids), "user_ids": uids}
            for emoji, uids in emojis.items()
        ]
    return result


# ─── Helpers ───

async def get_message_dict(db: AsyncSession, msg: Message, user_id: str | None = None) -> dict:
    """메시지 한 건을 목록과 같은 모양으로(답글 수·리액션·스레드 메타 포함). 스레드 패널의 원문용."""
    sender = await db.get(User, msg.sender_id) if msg.sender_id else None
    d = _message_to_dict(msg, sender)
    d["reply_count"] = (await get_thread_reply_count(db, [msg.id])).get(msg.id, 0)
    d["reactions"] = (await get_reactions_for_messages(db, [msg.id])).get(msg.id, [])
    d["is_saved"] = msg.id in (await get_saved_ids(db, user_id, [msg.id])) if user_id else False
    await msg22.enrich(db, [(msg, d)])
    return d


def _message_to_dict(msg: Message, sender: User | None) -> dict:
    return {
        "id": msg.id,
        "channel_id": msg.channel_id,
        "sender": {
            "id": sender.id,
            "username": sender.username,
            "display_name": sender.display_name,
            "avatar_url": sender.avatar_url,
        } if sender else None,
        "content": msg.content,
        "message_type": msg.message_type,
        "file_meta": msg.file_meta,
        "parent_id": msg.parent_id,
        "thread_broadcast": bool(msg.thread_broadcast),
        "is_edited": msg.is_edited,
        "is_deleted": msg.is_deleted,
        "pinned_at": msg.pinned_at.isoformat() if msg.pinned_at else None,
        "pinned_by": msg.pinned_by if msg.pinned_at else None,
        # 링크 미리보기 카드(R5 B12). 없거나 보낸 사람이 지웠으면 None — 표시 여부는 받는 쪽 설정(chat.link_preview)
        "link_preview": public_preview(getattr(msg, "link_preview", None)),
        "seq": msg.seq,
        "created_at": msg.created_at.isoformat(),
        "updated_at": msg.updated_at.isoformat(),
        # chat22 — reply_to_id·reply_ping·reply_to(enrich)·silent·attachments·thread(enrich)
        **msg22.fields_of(msg),
    }


# ─── seq 커서 · 재접속 복구 ───


async def get_latest_seq(db: AsyncSession) -> int:
    """지금까지 부여된 가장 큰 seq. 메시지가 하나도 없으면 0.

    클라이언트가 자기 채널에 새 메시지가 없어도 커서를 앞으로 옮길 수 있게 쓴다.
    """
    return (await db.execute(select(func.coalesce(func.max(Message.seq), 0)))).scalar_one()


async def get_changes_since(
    db: AsyncSession,
    user_id: str,
    since_seq: int,
    limit: int = 500,
) -> dict:
    """재접속 복구(R-16 2단계): 내가 속한 모든 채널에서 since_seq 이후 생긴 메시지.

    스레드 답글도 포함한다(클라이언트가 parent_id 로 라우팅). limit 를 넘으면 목록을
    비우고 `too_many=True` 만 돌려준다 — 그때는 풀 리프레시가 더 싸다(Matrix 의
    UnknownPos 리셋, Zulip 의 BAD_EVENT_QUEUE_ID 와 같은 선택).

    한계: 끊긴 동안의 **편집·삭제·리액션** 은 seq 를 올리지 않아 여기 안 잡힌다.
    삭제된 메시지는 is_deleted 플래그로 그대로 내려주므로 클라이언트가 지울 수 있다.
    """
    user_channels_q = select(ChannelMember.channel_id).where(
        ChannelMember.user_id == user_id
    )
    rows = (
        await db.execute(
            select(Message, User)
            .outerjoin(User, Message.sender_id == User.id)
            .where(
                Message.channel_id.in_(user_channels_q),
                Message.seq > since_seq,
            )
            .order_by(Message.seq.asc())
            .limit(limit + 1)
        )
    ).all()

    latest_seq = await get_latest_seq(db)
    if len(rows) > limit:
        return {"messages": [], "too_many": True, "latest_seq": latest_seq}

    msg_ids = [m.id for m, _ in rows]
    reply_counts = await get_thread_reply_count(db, msg_ids)
    reactions_map = await get_reactions_for_messages(db, msg_ids)

    out = []
    for msg, user in rows:
        d = _message_to_dict(msg, user)
        d["reply_count"] = reply_counts.get(msg.id, 0)
        d["reactions"] = reactions_map.get(msg.id, [])
        out.append(d)
    await msg22.enrich(db, [(m, d) for (m, _u), d in zip(rows, out)])
    return {"messages": out, "too_many": False, "latest_seq": latest_seq}


# ─── 저장한 메시지 · 내 스레드 ───
#
# 데스크톱 셸의 "모아보기" 열(멘션 · 저장됨 · 스레드)이 쓰는 두 목록이다.
# 멘션은 이미 알림에 있어서 여기서는 나머지 둘만 다룬다.


async def _decorate(db: AsyncSession, rows: list[Message]) -> list[dict]:
    """메시지에 보낸 사람 이름과 채널 이름을 붙인다. 카드 한 장에 필요한 최소치다."""
    if not rows:
        return []
    sender_ids = {m.sender_id for m in rows if m.sender_id}
    channel_ids = {m.channel_id for m in rows}

    users = {
        u.id: (u.display_name or u.username)
        for u in (
            await db.execute(select(User).where(User.id.in_(sender_ids)))
        ).scalars().all()
    } if sender_ids else {}
    channels = {
        c.id: (c.name, c.type)
        for c in (
            await db.execute(select(Channel).where(Channel.id.in_(channel_ids)))
        ).scalars().all()
    }

    out = []
    for m in rows:
        name, ctype = channels.get(m.channel_id, ("", "public"))
        out.append({
            "id": m.id,
            "channel_id": m.channel_id,
            "channel_name": name,
            "channel_type": ctype,
            "sender_id": m.sender_id,
            "sender_name": users.get(m.sender_id or "", "알 수 없음"),
            "content": m.content,
            "created_at": m.created_at,
        })
    return out


async def save_message(db: AsyncSession, user_id: str, message_id: str) -> bool:
    """저장 토글의 '저장' 쪽. 이미 저장돼 있으면 아무것도 하지 않는다."""
    exists = (
        await db.execute(
            select(SavedMessage).where(
                SavedMessage.user_id == user_id,
                SavedMessage.message_id == message_id,
            )
        )
    ).scalar_one_or_none()
    if exists:
        return False
    db.add(SavedMessage(user_id=user_id, message_id=message_id))
    await db.commit()
    return True


async def unsave_message(db: AsyncSession, user_id: str, message_id: str) -> bool:
    await db.execute(
        delete(SavedMessage).where(
            SavedMessage.user_id == user_id,
            SavedMessage.message_id == message_id,
        )
    )
    await db.commit()
    return True


async def get_saved_messages(
    db: AsyncSession, user_id: str, limit: int = 50
) -> list[dict]:
    rows = (
        await db.execute(
            select(Message)
            .join(SavedMessage, SavedMessage.message_id == Message.id)
            .where(
                SavedMessage.user_id == user_id,
                Message.is_deleted == False,  # noqa: E712
            )
            .order_by(SavedMessage.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return await _decorate(db, list(rows))


# ─── 스레드 팔로우 ───
#
# 참여(원 글·답글·멘션)하면 자동으로 팔로우되고, 사람이 끊거나 다시 켤 수 있다.
# "내 스레드" 목록과 스레드 미읽음은 전부 thread_follows 에서 나온다.


async def ensure_thread_follows(
    db: AsyncSession,
    root_id: str,
    channel_id: str,
    user_ids: list[str],
    refollow: bool = False,
    read_seq: int | None = None,
) -> int:
    """없는 팔로우 행을 만든다. 새로 만든 행 수를 돌려준다.

    이미 끊어 둔(followed=False) 사람은 그대로 두는 것이 기본 — `refollow=True` 는 본인이
    답글을 직접 쓴 경우처럼 다시 켜도 되는 때만. `read_seq` 가 있으면 그 사람의 읽음
    포인터를 거기까지 올린다(자기 답글은 읽은 것이다). 커밋은 호출자가 한다.
    """
    user_ids = [u for u in dict.fromkeys(user_ids) if u]
    if not user_ids:
        return 0
    existing = {
        tf.user_id: tf
        for tf in (
            await db.execute(
                select(ThreadFollow).where(
                    ThreadFollow.root_message_id == root_id,
                    ThreadFollow.user_id.in_(user_ids),
                )
            )
        ).scalars().all()
    }
    added = 0
    for uid in user_ids:
        tf = existing.get(uid)
        if tf is None:
            tf = ThreadFollow(
                id=str(uuid.uuid4()),
                user_id=uid,
                root_message_id=root_id,
                channel_id=channel_id,
                last_read_seq=read_seq,
                followed=True,
            )
            db.add(tf)
            added += 1
            continue
        if refollow and not tf.followed:
            tf.followed = True
        if read_seq is not None and (tf.last_read_seq is None or tf.last_read_seq < read_seq):
            tf.last_read_seq = read_seq
    await db.flush()
    return added


async def set_thread_follow(
    db: AsyncSession, user_id: str, root_id: str, followed: bool
) -> dict | None:
    """팔로우 켜기/끄기. 루트가 없거나 답글이면 None. {root_id, channel_id, followed}."""
    root = await db.get(Message, root_id)
    if root is None or root.parent_id is not None:
        return None
    tf = (
        await db.execute(
            select(ThreadFollow).where(
                ThreadFollow.user_id == user_id, ThreadFollow.root_message_id == root_id,
            )
        )
    ).scalar_one_or_none()
    if tf is None:
        # 끊기만 하는데 행이 없어도 끊긴 행을 남긴다 — 다음 답글의 자동 팔로우를 막기 위해
        tf = ThreadFollow(
            id=str(uuid.uuid4()),
            user_id=user_id,
            root_message_id=root_id,
            channel_id=root.channel_id,
            followed=followed,
        )
        db.add(tf)
    else:
        tf.followed = followed
    await db.commit()
    return {"root_id": root_id, "channel_id": root.channel_id, "followed": followed}


async def mark_thread_read(
    db: AsyncSession, user_id: str, root_id: str, up_to_seq: int | None = None
) -> int | None:
    """스레드 읽음 — 포인터를 마지막 답글(또는 up_to_seq)로 올린다. 올라간 값, 없으면 None.

    팔로우 행이 없어도 만든다(followed 는 건드리지 않는다 — 읽었다고 구독이 켜지진 않는다).
    """
    root = await db.get(Message, root_id)
    if root is None or root.parent_id is not None:
        return None
    if up_to_seq is None:
        up_to_seq = (
            await db.execute(
                select(func.max(Message.seq)).where(Message.parent_id == root_id)
            )
        ).scalar_one()
    if up_to_seq is None:
        return None
    tf = (
        await db.execute(
            select(ThreadFollow).where(
                ThreadFollow.user_id == user_id, ThreadFollow.root_message_id == root_id,
            )
        )
    ).scalar_one_or_none()
    if tf is None:
        db.add(ThreadFollow(
            id=str(uuid.uuid4()),
            user_id=user_id,
            root_message_id=root_id,
            channel_id=root.channel_id,
            last_read_seq=up_to_seq,
            followed=False,
        ))
    elif tf.last_read_seq is None or tf.last_read_seq < up_to_seq:
        tf.last_read_seq = up_to_seq
    else:
        return tf.last_read_seq
    await db.commit()
    return up_to_seq


def _thread_unread_expr(user_col, last_read_col):
    """팔로우 행 1개에 대한 "미읽음 답글" 조건 — 내 답글·삭제분 제외, seq > last_read_seq."""
    return and_(
        Message.parent_id == ThreadFollow.root_message_id,
        Message.is_deleted == False,  # noqa: E712
        Message.seq > func.coalesce(last_read_col, 0),
        or_(Message.sender_id.is_(None), Message.sender_id != user_col),
    )


async def get_thread_followers_unread(
    db: AsyncSession, root_id: str, exclude_user_id: str | None = None
) -> dict[str, int]:
    """{follower_user_id: unread_replies} — 팔로우가 켜진 사람 전원, 한 쿼리.

    새 답글이 생겼을 때 팔로워마다 thread_update 를 보내는 데 쓴다.
    """
    q = (
        select(ThreadFollow.user_id, func.count(Message.id))
        .outerjoin(Message, _thread_unread_expr(ThreadFollow.user_id, ThreadFollow.last_read_seq))
        .where(ThreadFollow.root_message_id == root_id, ThreadFollow.followed == True)  # noqa: E712
        .group_by(ThreadFollow.user_id)
    )
    if exclude_user_id:
        q = q.where(ThreadFollow.user_id != exclude_user_id)
    return {uid: int(cnt or 0) for uid, cnt in (await db.execute(q)).all()}


async def get_thread_unread_count(db: AsyncSession, user_id: str) -> dict:
    """{threads: 미읽음 답글이 있는 팔로우 스레드 수, replies: 미읽음 답글 총수} — 셸 배지용."""
    per_thread = (
        select(ThreadFollow.root_message_id, func.count(Message.id).label("n"))
        .join(Message, _thread_unread_expr(ThreadFollow.user_id, ThreadFollow.last_read_seq))
        .where(ThreadFollow.user_id == user_id, ThreadFollow.followed == True)  # noqa: E712
        .group_by(ThreadFollow.root_message_id)
        .subquery()
    )
    row = (
        await db.execute(
            select(func.count(per_thread.c.root_message_id), func.coalesce(func.sum(per_thread.c.n), 0))
        )
    ).one()
    return {"threads": int(row[0] or 0), "replies": int(row[1] or 0)}


async def get_thread_follow_state(db: AsyncSession, user_id: str, root_id: str) -> dict:
    """{followed, unread_replies, last_read_seq} — 스레드 패널을 열 때."""
    tf = (
        await db.execute(
            select(ThreadFollow).where(
                ThreadFollow.user_id == user_id, ThreadFollow.root_message_id == root_id,
            )
        )
    ).scalar_one_or_none()
    unread = (
        await db.execute(
            select(func.count(Message.id)).where(
                Message.parent_id == root_id,
                Message.is_deleted == False,  # noqa: E712
                Message.seq > ((tf.last_read_seq if tf else None) or 0),
                or_(Message.sender_id.is_(None), Message.sender_id != user_id),
            )
        )
    ).scalar_one()
    return {
        "followed": bool(tf and tf.followed),
        "unread_replies": int(unread or 0),
        "last_read_seq": tf.last_read_seq if tf else None,
    }


async def get_my_threads(
    db: AsyncSession, user_id: str, limit: int = 50
) -> list[dict]:
    """내가 팔로우하는 스레드의 **원 메시지** 목록 — 마지막 답글이 최근인 순.

    항목마다 reply_count · unread_replies · followed · last_reply(마지막 답글 요약)를 붙인다.
    팔로우는 참여(원 글·답글·멘션)로 자동 생기고 사람이 끊을 수 있다(ThreadFollow 참고).
    기존 스레드는 db/session.py 의 백필이 참여 이력을 팔로우로 옮겨 놓는다.
    """
    # 스레드마다 마지막 답글 seq (삭제분 제외)
    last_reply_sq = (
        select(Message.parent_id.label("root_id"), func.max(Message.seq).label("last_seq"))
        .where(Message.parent_id.is_not(None), Message.is_deleted == False)  # noqa: E712
        .group_by(Message.parent_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(Message, ThreadFollow.last_read_seq, last_reply_sq.c.last_seq)
            .join(ThreadFollow, ThreadFollow.root_message_id == Message.id)
            .outerjoin(last_reply_sq, last_reply_sq.c.root_id == Message.id)
            .where(
                ThreadFollow.user_id == user_id,
                ThreadFollow.followed == True,  # noqa: E712
                Message.is_deleted == False,  # noqa: E712
            )
            .order_by(func.coalesce(last_reply_sq.c.last_seq, Message.seq).desc())
            .limit(limit)
        )
    ).all()
    if not rows:
        return []

    roots = [m for m, _lr, _ls in rows]
    items = await _decorate(db, roots)
    counts = await get_thread_reply_count(db, [m.id for m in roots])

    # 마지막 답글 본문 (seq 로 1행씩)
    last_seqs = [ls for _m, _lr, ls in rows if ls is not None]
    last_replies: dict[int, tuple[Message, User | None]] = {}
    if last_seqs:
        for msg, u in (
            await db.execute(
                select(Message, User)
                .outerjoin(User, User.id == Message.sender_id)
                .where(Message.seq.in_(last_seqs))
            )
        ).all():
            last_replies[msg.seq] = (msg, u)

    # 미읽음 답글 수 — 스레드마다 다른 last_read_seq 를 한 쿼리에서 비교
    unread_rows = (
        await db.execute(
            select(ThreadFollow.root_message_id, func.count(Message.id))
            .join(Message, _thread_unread_expr(ThreadFollow.user_id, ThreadFollow.last_read_seq))
            .where(
                ThreadFollow.user_id == user_id,
                ThreadFollow.root_message_id.in_([m.id for m in roots]),
            )
            .group_by(ThreadFollow.root_message_id)
        )
    ).all()
    unread_map = {rid: int(n) for rid, n in unread_rows}

    for item, (_m, last_read, last_seq) in zip(items, rows):
        item["reply_count"] = counts.get(item["id"], 0)
        item["unread_replies"] = unread_map.get(item["id"], 0)
        item["followed"] = True
        item["last_read_seq"] = last_read
        lr = last_replies.get(last_seq) if last_seq is not None else None
        item["last_reply"] = {
            "id": lr[0].id,
            "seq": lr[0].seq,
            "sender_id": lr[0].sender_id,
            "sender_name": (lr[1].display_name or lr[1].username) if lr[1] else "알 수 없음",
            "content": lr[0].content,
            "created_at": lr[0].created_at,
        } if lr else None
    return items


# ─── 핀 ───


async def set_pinned(
    db: AsyncSession, message_id: str, user_id: str, pinned: bool
) -> dict | None:
    """메시지 핀/해제. 없거나 삭제된 메시지면 None. 갱신된 메시지 dict 를 돌려준다(이벤트용)."""
    msg = await db.get(Message, message_id)
    if msg is None or msg.is_deleted:
        return None
    if pinned:
        if msg.pinned_at is None:
            msg.pinned_at = datetime.now(timezone.utc)
            msg.pinned_by = user_id
    else:
        msg.pinned_at = None
        msg.pinned_by = None
    await db.commit()
    await db.refresh(msg)
    sender = await db.get(User, msg.sender_id) if msg.sender_id else None
    d = _message_to_dict(msg, sender)
    await msg22.enrich(db, [(msg, d)])
    return d


async def create_pin_system_message(db: AsyncSession, msg_id: str, channel_id: str, actor_id: str) -> dict | None:
    """고정 시스템 줄(chat22) — "OO님이 메시지를 고정했습니다" 자리. 이미 같은 메시지의 줄이 있으면 None(그대로)."""
    marker = json.dumps({"kind": "pin", "message_id": msg_id, "actor_id": actor_id}, ensure_ascii=False)
    exists = (await db.execute(
        select(Message.id).where(
            Message.channel_id == channel_id, Message.message_type == "system",
            Message.is_deleted == False,  # noqa: E712
            Message.file_meta.like('%"kind": "pin"%'),
            Message.file_meta.like(f'%"message_id": "{msg_id}"%'),
        ).limit(1)
    )).scalar_one_or_none()
    if exists:
        return None
    return await create_message(db, channel_id, None, "고정", message_type="system", file_meta=marker)


async def get_pinned_messages(
    db: AsyncSession, channel_id: str, limit: int = 100
) -> list[dict]:
    """채널의 핀 목록 — 최근 핀 순. 핀한 사람 이름을 pinned_by_name 으로 붙인다."""
    Pinner = User.__table__.alias("pinner")
    rows = (
        await db.execute(
            select(Message, User, Pinner.c.display_name, Pinner.c.username)
            .outerjoin(User, User.id == Message.sender_id)
            .outerjoin(Pinner, Pinner.c.id == Message.pinned_by)
            .where(
                Message.channel_id == channel_id,
                Message.pinned_at.is_not(None),
                Message.is_deleted == False,  # noqa: E712
            )
            .order_by(Message.pinned_at.desc())
            .limit(limit)
        )
    ).all()
    msg_ids = [m.id for m, _u, _dn, _un in rows]
    reactions_map = await get_reactions_for_messages(db, msg_ids)
    reply_counts = await get_thread_reply_count(db, msg_ids)
    out = []
    for msg, user, p_dn, p_un in rows:
        d = _message_to_dict(msg, user)
        d["reactions"] = reactions_map.get(msg.id, [])
        d["reply_count"] = reply_counts.get(msg.id, 0)
        d["pinned_by_name"] = p_dn or p_un
        out.append(d)
    await msg22.enrich(db, [(m, d) for (m, _u, _dn, _un), d in zip(rows, out)])
    return out


# ─── 임시글 ───


def _draft_to_dict(d: ChatDraft) -> dict:
    return {
        "channel_id": d.channel_id,
        "parent_id": d.parent_id,
        "content": d.content,
        "updated_at": d.updated_at,
    }


async def _find_draft(
    db: AsyncSession, user_id: str, channel_id: str, parent_id: str | None
) -> ChatDraft | None:
    q = select(ChatDraft).where(
        ChatDraft.user_id == user_id, ChatDraft.channel_id == channel_id,
    )
    q = q.where(ChatDraft.parent_id.is_(None)) if parent_id is None else q.where(ChatDraft.parent_id == parent_id)
    return (await db.execute(q)).scalar_one_or_none()


async def upsert_draft(
    db: AsyncSession, user_id: str, channel_id: str, parent_id: str | None, content: str
) -> dict | None:
    """임시글 저장. 빈 content 는 삭제와 같다(None 을 돌려준다)."""
    content = content or ""
    existing = await _find_draft(db, user_id, channel_id, parent_id)
    if not content.strip():
        if existing is not None:
            await db.delete(existing)
            await db.commit()
        return None
    if existing is None:
        existing = ChatDraft(
            id=str(uuid.uuid4()),
            user_id=user_id,
            channel_id=channel_id,
            parent_id=parent_id,
            content=content,
        )
        db.add(existing)
    else:
        existing.content = content
        existing.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(existing)
    return _draft_to_dict(existing)


async def delete_draft(
    db: AsyncSession, user_id: str, channel_id: str, parent_id: str | None
) -> bool:
    existing = await _find_draft(db, user_id, channel_id, parent_id)
    if existing is None:
        return False
    await db.delete(existing)
    await db.commit()
    return True


async def get_drafts(db: AsyncSession, user_id: str) -> list[dict]:
    rows = (
        await db.execute(
            select(ChatDraft)
            .where(ChatDraft.user_id == user_id)
            .order_by(ChatDraft.updated_at.desc())
        )
    ).scalars().all()
    return [_draft_to_dict(d) for d in rows]


async def dismiss_link_preview(db: AsyncSession, msg: Message) -> dict:
    """보낸 사람이 미리보기를 지운다. 같은 링크로는 다시 만들지 않게 "지움" 표시를 남긴다."""
    url = stored_url(msg.link_preview) or first_external_url(msg.content)
    msg.link_preview = json.dumps({"dismissed": True, "url": url}, ensure_ascii=False)
    await db.commit()
    return {"message_id": msg.id, "channel_id": msg.channel_id, "parent_id": msg.parent_id}
