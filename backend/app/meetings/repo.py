"""회의 DB 저장소 — 예약 회의·초대 대상·참석 응답·상태.

Redis 메타(store.py)는 "지금 열려 있는 방"의 빠른 상태(참가 신청·녹화)를 들고, 이 모듈은
회의 자체를 오래 들고 있다. Redis 메타가 사라졌으면(24시간 TTL) 여기 행으로 되살린다.

상태 흐름: scheduled → live(누군가 들어옴, 웹훅) → ended(방이 닫힘, 웹훅·종료 버튼)
          scheduled → cancelled(시작 전에 호스트가 지움)
목록에 보이는 상태는 LiveKit 에 방이 살아 있는지와 예약 시간대를 함께 보고 정한다(effective_status).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MeetingDB, MeetingInvitee, User

logger = logging.getLogger(__name__)

ACTIVE = ("scheduled", "live")
RESPONSES = ("pending", "accepted", "declined", "tentative")
DEFAULT_DURATION = 60
PAST_DAYS = 30          # 목록에 싣는 지난 회의 범위
PAST_LIMIT = 50

# 테스트가 SQLite 세션 팩토리로 갈아끼운다. None 이면 앱 세션을 쓴다.
_session_factory = None


def session():
    if _session_factory is not None:
        return _session_factory()
    from app.db.session import async_session
    return async_session()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    # SQLite 는 시간대를 버린다 — 저장은 늘 UTC 라 UTC 로 붙인다
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def window(row: MeetingDB) -> tuple[datetime, datetime]:
    """회의 시간대(시작, 끝). 예약 없이 바로 만든 방은 만든 시각부터."""
    start = _aware(row.scheduled_at) or _aware(row.created_at) or _now()
    return start, start + timedelta(minutes=row.duration_minutes or DEFAULT_DURATION)


def effective_status(row: MeetingDB, live: bool, now: datetime | None = None) -> str:
    """목록에 보일 상태 — live | scheduled | ended | cancelled."""
    if row.status == "cancelled":
        return "cancelled"
    if live:
        return "live"
    if row.status == "ended":
        return "ended"
    now = now or _now()
    _, end = window(row)
    return "ended" if now > end else "scheduled"


async def find_active(db: AsyncSession, room_name: str) -> MeetingDB | None:
    """그 방 이름으로 아직 끝나지 않은 가장 최근 회의."""
    return (await db.execute(
        select(MeetingDB)
        .where(MeetingDB.room_name == room_name, MeetingDB.status.in_(ACTIVE))
        .order_by(MeetingDB.created_at.desc())
        .limit(1)
    )).scalars().first()


async def find_latest_closed(db: AsyncSession, room_name: str, host_user_id: str) -> MeetingDB | None:
    """그 방 이름으로 이 호스트가 연, 목록에 아직 남아 있는 가장 최근 지난(끝난·취소된) 회의."""
    return (await db.execute(
        select(MeetingDB)
        .where(MeetingDB.room_name == room_name, MeetingDB.host_user_id == host_user_id,
               MeetingDB.status.not_in(ACTIVE), MeetingDB.deleted_at.is_(None))
        .order_by(MeetingDB.created_at.desc())
        .limit(1)
    )).scalars().first()


async def find_by_token(db: AsyncSession, token: str) -> MeetingDB | None:
    return (await db.execute(
        select(MeetingDB).where(MeetingDB.share_token == token)
    )).scalars().first()


async def get_invitees(db: AsyncSession, meeting_id: str) -> list[MeetingInvitee]:
    return list((await db.execute(
        select(MeetingInvitee)
        .where(MeetingInvitee.meeting_id == meeting_id)
        .order_by(MeetingInvitee.created_at)
    )).scalars().all())


def _own_email(user) -> str:
    """초대 주소와 견줄 수 있는 이 계정의 주소(소문자) — 본인이 바꿀 수 없는 주소만. 없으면 "".

    로컬 계정의 주소는 가입 때 시스템이 정한다. LDAP 등 외부 인증 계정은 로그인할 때마다 디렉터리의
    mail 속성으로 덮어쓰는데(auth/router._try_ldap_login), 디렉터리에서 그 값을 스스로 바꿀 수 있는 사람이
    남에게 온 초대 주소로 맞춰 대기실·비밀번호 없이 들어올 수 있다 — 그런 계정은 주소로 묶지 않는다
    (계정을 지정한 초대나 초대 링크로 들어온다).
    """
    email = (getattr(user, "email", None) or "").strip().lower()
    if not email:
        return ""
    from app.auth.router import is_local_account
    return email if is_local_account(user) else ""


def _is_me(inv: MeetingInvitee, user) -> bool:
    if inv.user_id and inv.user_id == str(user.id):
        return True
    email = _own_email(user)
    return bool(email and inv.email and inv.email.lower() == email)


async def my_invite(db: AsyncSession, meeting_id: str, user) -> MeetingInvitee | None:
    for inv in await get_invitees(db, meeting_id):
        if _is_me(inv, user):
            return inv
    return None


async def can_view(db: AsyncSession, row: MeetingDB, user) -> bool:
    """회의 상세를 볼 수 있는 사람 — 호스트 또는 초대 대상."""
    if row.host_user_id == str(user.id):
        return True
    return await my_invite(db, row.id, user) is not None


async def add_invitees(db: AsyncSession, meeting_id: str, items) -> list[MeetingInvitee]:
    """InviteeItem 목록을 초대 행으로. 내부 사용자는 user_id 로 묶고(username 만 오면 찾는다),
    이미 있는 사람은 건너뛴다. 새로 추가된 행만 돌려준다(커밋은 호출자가)."""
    existing = await get_invitees(db, meeting_id)
    have_users = {i.user_id for i in existing if i.user_id}
    have_emails = {(i.email or "").lower() for i in existing if i.email}
    added: list[MeetingInvitee] = []
    for it in items:
        uid = None
        email = (it.email or "").strip() or None
        name = it.display_name or it.username or email or ""
        if it.type == "internal":
            u = None
            if it.user_id:
                u = await db.get(User, it.user_id)
            if u is None and it.username:
                u = (await db.execute(select(User).where(User.username == it.username))).scalars().first()
            if u is not None:
                uid = u.id
                email = email or u.email
                name = it.display_name or u.display_name or u.username
        if uid and uid in have_users:
            continue
        if not uid and (not email or email.lower() in have_emails):
            continue
        inv = MeetingInvitee(meeting_id=meeting_id, user_id=uid, email=email, display_name=name[:255])
        db.add(inv)
        added.append(inv)
        if uid:
            have_users.add(uid)
        if email:
            have_emails.add(email.lower())
    await db.flush()
    return added


def invitee_dict(inv: MeetingInvitee) -> dict:
    return {
        "id": inv.id,
        "user_id": inv.user_id,
        "email": inv.email,
        "display_name": inv.display_name,
        "response": inv.response or "pending",
        "responded_at": _aware(inv.responded_at).isoformat() if inv.responded_at else None,
    }


async def list_visible(db: AsyncSession, user, now: datetime | None = None) -> list[MeetingDB]:
    """내가 호스트이거나 초대받은 회의 — 끝나지 않은 것 전부 + 최근 30일 안에 끝난 것."""
    now = now or _now()
    # 이메일이 없는 계정은 이메일 조건을 뺀다. 예전엔 "\x00" 을 대신 넣었는데 PostgreSQL 은 NUL 문자를
    # 받지 않아 목록 전체가 500 이 됐다(이메일 없는 계정의 회의 목록).
    # 주소로 묶는 기준은 _is_me 와 같다(로컬 계정의 주소만, 대소문자 무시) — 목록에는 보이는데 입장은 안 되는 일이 없게.
    email = _own_email(user)
    conds = [MeetingInvitee.user_id == str(user.id)]
    if email:
        conds.append(and_(MeetingInvitee.email.is_not(None), func.lower(MeetingInvitee.email) == email))
    invited_ids = select(MeetingInvitee.meeting_id).where(or_(*conds))
    rows = (await db.execute(
        select(MeetingDB)
        .where(
            or_(MeetingDB.host_user_id == str(user.id), MeetingDB.id.in_(invited_ids)),
            MeetingDB.status != "cancelled",
            MeetingDB.deleted_at.is_(None),
            MeetingDB.created_at >= now - timedelta(days=365),
        )
        .order_by(MeetingDB.created_at.desc())
        .limit(500)
    )).scalars().all()
    cutoff = now - timedelta(days=PAST_DAYS)
    out, past = [], 0
    for r in rows:
        if effective_status(r, False, now) == "ended":
            if (_aware(r.ended_at) or window(r)[1]) < cutoff:
                continue
            past += 1
            if past > PAST_LIMIT:
                continue
        out.append(r)
    return out


def meta_kwargs(row: MeetingDB) -> dict:
    """Redis RoomMeta 로 되살릴 때 쓰는 값."""
    return dict(
        name=row.room_name,
        host_user_id=row.host_user_id,
        host_username="",
        host_display_name=row.host_display_name or "",
        share_token=row.share_token,
        password_hash=row.password_hash,
        scheduled_at=_aware(row.scheduled_at).isoformat() if row.scheduled_at else None,
        duration_minutes=row.duration_minutes,
        waiting_room=bool(row.waiting_room) if row.waiting_room is not None else True,
        meeting_id=row.id,
        max_participants=row.max_participants or 10,
        chat_channel_id=getattr(row, "chat_channel_id", None),
    )


async def load_for_restore(name: str | None = None, token: str | None = None) -> dict | None:
    """Redis 에 메타가 없을 때 DB 에서 찾아 RoomMeta 인자로. 끝났거나 취소된 회의는 되살리지 않는다."""
    async with session() as db:
        row = await find_active(db, name) if name else await find_by_token(db, token or "")
        if row is None or row.status not in ACTIVE:
            return None
        host = await db.get(User, row.host_user_id)
        kw = meta_kwargs(row)
        if host is not None:
            kw["host_username"] = host.username
        return kw


async def on_room_event(event: str, room_name: str) -> None:
    """LiveKit 웹훅 → 회의 상태. 채널 통화(chan-)는 여기 오지 않는다.

    room_finished 는 아무도 안 들어온 채 5분 지나 방이 닫혀도 온다(예약만 해 둔 회의).
    그래서 누가 들어온 적이 있을 때(started_at)만 ended 로 바꾼다.
    """
    async with session() as db:
        row = (await db.execute(
            select(MeetingDB)
            .where(MeetingDB.room_name == room_name, MeetingDB.status.in_(("scheduled", "live", "ended")))
            .order_by(MeetingDB.created_at.desc())
            .limit(1)
        )).scalars().first()
        if row is None:
            return
        now = _now()
        if event == "participant_joined":
            if row.status != "live":
                row.status = "live"
                row.ended_at = None
            if row.started_at is None:
                row.started_at = now
        elif event == "room_finished":
            if row.status == "live" or (row.started_at is not None and row.status == "scheduled"):
                row.status = "ended"
                row.ended_at = now
        else:
            return
        await db.commit()
