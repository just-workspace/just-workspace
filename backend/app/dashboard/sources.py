"""대시보드가 모으는 "내가 볼 수 있는 것" 조회 모음 — 오늘 브리핑 칩(summary)과 AI 브리핑이 같이 쓴다.

전부 이 사용자 권한 안의 것만 읽는다.
- 오늘 일정: 캘린더 서비스 get_events(내 캘린더 + 공유받은 캘린더, 반복 펼침) — 캘린더 화면과 같은 범위
- 작업: 내가 만들었거나 담당(작업 서비스 _visible)
- 메일: 내 기본 메일 계정의 받은편지함(IMAP/POP3). 메일 서버로 가는 요청이라 시간 제한과 짧은 캐시를 둔다
- 채팅: 내가 멤버인 채널의 안 읽은 메시지(채널 목록 미읽음과 같은 조건)
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, ChannelMember, Message, TaskDB, User
from app.modules.registry import is_module_enabled

logger = logging.getLogger(__name__)

MAIL_TIMEOUT_S = 4.0
MAIL_CACHE_S = 60.0
_mail_cache: dict[str, tuple[float, int | None]] = {}

_MEETING_RE = re.compile(r"(https?://\S+)?/meetings/[\w\-/]+")


def parse_day_range(day_start: str | None, day_end: str | None) -> tuple[datetime, datetime]:
    """프런트가 캘린더 시간대 기준으로 보낸 "오늘" [시작, 끝). 없거나 이상하면 UTC 오늘.

    지금 시각에서 너무 먼 값(±36시간 밖)은 받지 않는다 — 하루 단위 캐시·한도를 날짜로 우회하지 못하게.
    """
    now = datetime.now(timezone.utc)
    try:
        s = datetime.fromisoformat((day_start or "").replace("Z", "+00:00"))
        e = datetime.fromisoformat((day_end or "").replace("Z", "+00:00"))
        if s.tzinfo is None:
            s = s.replace(tzinfo=timezone.utc)
        if e.tzinfo is None:
            e = e.replace(tzinfo=timezone.utc)
        if timedelta(hours=1) <= e - s <= timedelta(hours=26) and abs((s - now).total_seconds()) <= 36 * 3600:
            return s, e
    except ValueError:
        pass
    s = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return s, s + timedelta(days=1)


def meeting_link(ev: dict) -> str | None:
    """일정 장소·설명에 들어 있는 /meetings/ 주소(대시보드 오늘 카드와 같은 규칙). 같은 출처면 경로만."""
    m = _MEETING_RE.search(f"{ev.get('location') or ''} {ev.get('description') or ''}")
    return m.group(0) if m else None


def _dt(v) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


async def today_events(db: AsyncSession, user_id: str, s: datetime, e: datetime) -> list[dict]:
    """오늘 [s, e) 와 겹치는 일정(취소 제외) — 종일 먼저, 그다음 시작 순."""
    if not is_module_enabled("calendar"):
        return []
    from app.calendar import service as cal

    try:
        evs = await cal.get_events(db, user_id, (s - timedelta(days=1)).isoformat(), (e + timedelta(days=1)).isoformat())
    except Exception as ex:  # 캘린더 하나가 깨져도 대시보드는 그린다
        logger.debug("오늘 일정 조회 실패: %s", ex)
        await db.rollback()
        return []
    out = []
    for ev in evs:
        if ev.get("status") == "cancelled":
            continue
        st, en = _dt(ev.get("start")), _dt(ev.get("end"))
        if st is None:
            continue
        en = en or st
        if ev.get("all_day"):
            # 종일은 날짜(UTC 00:00 저장, 끝 날짜 미포함)로 비교한다. 화면의 "오늘" 날짜 = 창 가운데의 UTC 날짜
            # (시간대 ±12시간 안에서는 그 지역 날짜와 같다)
            day = (s + (e - s) / 2).date()
            last = (en - timedelta(microseconds=1)).date() if en > st else st.date()
            if not (st.date() <= day <= last):
                continue
        elif not (st < e and en > s):
            continue
        out.append({**ev, "_start": st, "_end": en})
    out.sort(key=lambda x: (not x.get("all_day"), x["_start"]))
    return out


def next_meeting(events: list[dict], now: datetime | None = None) -> dict | None:
    """오늘 일정 가운데 아직 끝나지 않은 가장 이른 시각 일정(종일 제외)."""
    now = now or datetime.now(timezone.utc)
    timed = [ev for ev in events if not ev.get("all_day") and ev["_end"] > now]
    if not timed:
        return None
    ev = min(timed, key=lambda x: x["_start"])
    return {
        "id": ev.get("original_event_id") or ev.get("id"),
        "title": ev.get("title") or "",
        "start": ev["_start"].isoformat(),
        "end": ev["_end"].isoformat(),
        "join_url": meeting_link(ev),
    }


async def task_counts(db: AsyncSession, user_id: str, s: datetime, e: datetime) -> tuple[int, int]:
    """(오늘 마감, 지난 마감) — 끝나지 않은, 내가 볼 수 있는 최상위 작업."""
    if not is_module_enabled("tasks"):
        return 0, 0
    from app.tasks.service import _visible

    base = and_(_visible(user_id), TaskDB.status != "done", TaskDB.parent_id.is_(None), TaskDB.due_date.is_not(None))
    today = await db.scalar(select(func.count(TaskDB.id)).where(base, TaskDB.due_date >= s, TaskDB.due_date < e)) or 0
    overdue = await db.scalar(select(func.count(TaskDB.id)).where(base, TaskDB.due_date < s)) or 0
    return int(today), int(overdue)


async def due_tasks(db: AsyncSession, user_id: str, e: datetime, limit: int = 10) -> list[TaskDB]:
    """오늘까지 마감(지난 것 포함)인 끝나지 않은 작업 — 마감 순."""
    if not is_module_enabled("tasks"):
        return []
    from app.tasks.service import _visible

    return list((await db.execute(
        select(TaskDB).where(
            _visible(user_id), TaskDB.status != "done", TaskDB.parent_id.is_(None),
            TaskDB.due_date.is_not(None), TaskDB.due_date < e,
        ).order_by(TaskDB.due_date).limit(limit)
    )).scalars().all())


# ─── 메일 ───

async def _mail_account(db: AsyncSession, user: User):
    from fastapi import HTTPException

    from app.mail.router import _get_account

    try:
        return await _get_account(db, user)
    except HTTPException:
        return None


async def mail_unread(db: AsyncSession, user: User) -> int | None:
    """받은편지함 안 읽음 수. 계정 없음·모듈 꺼짐·메일 서버 실패면 None(칩을 그리지 않는다). 60초 캐시."""
    if not is_module_enabled("mail"):
        return None
    hit = _mail_cache.get(user.id)
    if hit and time.monotonic() - hit[0] < MAIL_CACHE_S:
        return hit[1]
    account = await _mail_account(db, user)
    if account is None:
        _mail_cache[user.id] = (time.monotonic(), None)
        return None
    from app.mail.router import _incoming

    try:
        boxes = await asyncio.wait_for(_incoming(account).list_mailboxes(account), MAIL_TIMEOUT_S)
        n: int | None = sum(int(b.get("unread_count") or 0) for b in boxes if b.get("role") == "inbox")
    except Exception as ex:
        logger.debug("메일 안 읽음 조회 실패: %s", ex)
        n = None
    _mail_cache[user.id] = (time.monotonic(), n)
    return n


async def unread_mails(db: AsyncSession, user: User, limit: int = 10) -> tuple[str | None, list[dict]]:
    """(받은편지함 id, 안 읽은 메일 요약 목록) — 최신순. 못 읽으면 (None, [])."""
    if not is_module_enabled("mail"):
        return None, []
    account = await _mail_account(db, user)
    if account is None:
        return None, []
    from app.mail.router import _incoming

    try:
        boxes = await asyncio.wait_for(_incoming(account).list_mailboxes(account), MAIL_TIMEOUT_S)
        inbox = next((b for b in boxes if b.get("role") == "inbox"), None)
        if not inbox:
            return None, []
        msgs, _total = await asyncio.wait_for(
            _incoming(account).fetch_messages(account, inbox["id"], 0, limit, unread=True), MAIL_TIMEOUT_S * 2,
        )
        return inbox["id"], msgs
    except Exception as ex:
        logger.debug("안 읽은 메일 조회 실패: %s", ex)
        return None, []


# ─── 채팅 ───

async def unread_chat_messages(db: AsyncSession, user_id: str, limit: int = 30) -> list[dict]:
    """내 채널(보관 제외)의 안 읽은 메시지 — 최신순. 보낸 사람·채널 이름 포함, 본문은 400자까지."""
    if not is_module_enabled("chat"):
        return []
    from app.chat.service import main_timeline_filter

    rows = (await db.execute(
        select(Message, Channel.name, Channel.type, User.display_name, User.username)
        .join(ChannelMember, and_(ChannelMember.channel_id == Message.channel_id, ChannelMember.user_id == user_id))
        .join(Channel, Channel.id == Message.channel_id)
        .outerjoin(User, User.id == Message.sender_id)
        .where(
            Message.seq > func.coalesce(ChannelMember.last_read_seq, 0),
            Message.is_deleted == False,  # noqa: E712
            Channel.is_archived == False,  # noqa: E712
            main_timeline_filter(),
            or_(Message.sender_id.is_(None), Message.sender_id != user_id),
        )
        .order_by(Message.created_at.desc())
        .limit(limit)
    )).all()
    out = []
    for m, ch_name, ch_type, dn, un in rows:
        out.append({
            "id": m.id, "channel_id": m.channel_id, "channel_name": ch_name or "", "channel_type": ch_type,
            "sender": dn or un or "", "content": (m.content or "")[:400],
            "created_at": (m.created_at if m.created_at.tzinfo else m.created_at.replace(tzinfo=timezone.utc)).isoformat()
            if m.created_at else None,
        })
    return out
