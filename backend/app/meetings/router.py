"""Meetings (LiveKit) API router — 호스트 승인 + 공유링크 참여."""

import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, status

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.password import hash_password, verify_password
from app.chat.redis_client import get_redis
from app.config import get_settings
from app.db.models import MeetingDB, MeetingInvitee, MeetingRecording, User
from app.db.session import get_db
from app.meetings import livekit, repo, store
from app.meetings.schemas import is_channel_call_room, is_reserved_room_name
from app.meetings.invite import (
    create_calendar_event,
    delete_calendar_event,
    generate_ics,
    send_invite_email,
    update_calendar_event_time,
)
from app.meetings.schemas import (
    InviteeInfo,
    JoinNotifyHost,
    JoinRequestCreate,
    JoinRequestResponse,
    JoinRequestStatus,
    JoinRoomInfo,
    MeetingDetail,
    MeetingSummary,
    ParticipantInfo,
    PendingRequest,
    RoomCreate,
    RoomInfo,
    RoomListResponse,
    RoomUpdate,
    RsvpRequest,
    TokenRequest,
    TokenResponse,
)

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/meetings", tags=["meetings"])


def _parse_scheduled(value: str | None) -> datetime | None:
    """예약 시각 문자열 → 시간대 있는 datetime. 시간대가 없으면 UTC 로 본다(예전 동작 유지), 못 읽으면 None."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def _ensure_lk_room(meta) -> None:
    """DB 회의(meeting_id 있음)의 LiveKit 방을 연다(이미 있으면 그대로). 실패해도 입장은 막지 않는다 —
    LiveKit auto_create 가 켜져 있으면 입장 때 기본 설정으로라도 생긴다."""
    if not getattr(meta, "meeting_id", None):
        return
    try:
        await livekit.create_room(name=meta.name, max_participants=meta.max_participants or 10)
    except Exception as e:
        logger.debug("LiveKit 방 다시 열기 실패(%s): %s", meta.name, e)


def _check_configured():
    if not livekit.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LiveKit is not configured",
        )


# ════════════════════════════════════════════
# 인증 사용자 엔드포인트
# ════════════════════════════════════════════

def _iso(dt: datetime | None) -> str | None:
    dt = repo._aware(dt)
    return dt.isoformat() if dt else None


async def _invitee_stats(db: AsyncSession, meeting_ids: list[str], user) -> dict[str, dict]:
    """회의별 초대 인원·수락 인원·내 응답 — 목록 한 번에 한 쿼리."""
    out: dict[str, dict] = {mid: {"count": 0, "accepted": 0, "mine": None} for mid in meeting_ids}
    if not meeting_ids:
        return out
    rows = (await db.execute(
        select(MeetingInvitee).where(MeetingInvitee.meeting_id.in_(meeting_ids))
    )).scalars().all()
    for inv in rows:
        st = out[inv.meeting_id]
        st["count"] += 1
        if inv.response == "accepted":
            st["accepted"] += 1
        if repo._is_me(inv, user):
            st["mine"] = inv.response or "pending"
    return out


def _row_fields(row: MeetingDB | None, status_: str, stats: dict | None) -> dict:
    """DB 회의 행 → RoomInfo 추가 필드."""
    if row is None:
        return {"status": status_}
    stats = stats or {}
    return {
        "meeting_id": row.id,
        "status": status_,
        "title": row.title or row.room_name,
        "description": row.description,
        "waiting_room": bool(row.waiting_room) if row.waiting_room is not None else True,
        "my_response": stats.get("mine"),
        "invitee_count": stats.get("count", 0),
        "accepted_count": stats.get("accepted", 0),
        "started_at": _iso(row.started_at),
        "ended_at": _iso(row.ended_at),
    }


async def _can_see_channel_call(db: AsyncSession, name: str, user) -> bool:
    """채널·DM 통화 방(chan-<채널id>)은 그 채널 멤버만."""
    from app.chat import service as chat_service
    channel_id = name[len("chan-"):]
    if not channel_id:
        return False
    try:
        return bool(await chat_service.is_channel_member(db, channel_id, user.id))
    except Exception:
        return False


async def _visible_live_rooms(db: AsyncSession, user, rooms: list[dict]) -> list[dict]:
    out = []
    for r in rooms:
        name = r.get("name") or ""
        if is_reserved_room_name(name):
            # 음성 채널 방(voice-<채널id>)은 회의가 아니다 — 회의 목록에 싣지 않는다(채널 id 도 새지 않게).
            # 채널·DM 통화(chan-)만 그 채널 멤버에게 보인다.
            if not is_channel_call_room(name) or not await _can_see_channel_call(db, name, user):
                continue
        out.append(r)
    return out


async def _live_access(db: AsyncSession, name: str, meta, row: MeetingDB | None, user) -> str | None:
    """진행 중인 방을 이 사용자가 볼 수 있는 근거 — host | invited | joined | channel, 없으면 None.

    예전엔 진행 중인 회의가 로그인 사용자 모두의 목록에 공유 링크와 함께 실려, 대기실·비밀번호가 없는
    회의는 목록에서 눌러 누구나 들어올 수 있었다. 이제 호스트·초대 대상·(초대 링크로) 이미 들어온 사람만 본다.
    링크를 받은 사람은 목록과 상관없이 링크로 들어온다(/join/{token}) — 막는 것은 "목록에서 발견"뿐이다.
    """
    if is_reserved_room_name(name):
        return "channel"   # 채널·DM 통화 — 멤버 여부는 _visible_live_rooms 가 이미 걸렀다
    if meta is None:
        return None        # 누구 회의인지 모르는 방(메타 없음)은 아무에게도 싣지 않는다
    uid = str(user.id)
    if meta.host_user_id == uid:
        return "host"
    # 초대 대상은 회의가 아직 살아 있을 때만(토큰 발급 _is_invited 와 같은 조건). 끝났거나 취소된 회의의
    # LiveKit 방이 남아 있으면 "진행 중"으로 싣지 않는다 — 실으면 [참여]가 403 이다. 그 행은 지난 회의로 나온다.
    if row is not None and row.status in repo.ACTIVE and await repo.can_view(db, row, user):
        return "invited"
    try:
        if await store.is_link_user(name, uid):
            return "joined"
    except Exception:
        logger.debug("링크 입장 기록 조회 실패(%s)", name, exc_info=True)
    return None


async def _optional_user_id(
    request: Request,
    ws_session: str | None = Cookie(None),
) -> str | None:
    """로그인했으면 그 사용자 id, 아니면 None — 인증 불요 경로(초대 링크)에서 "누가 들어왔나"만 적을 때.

    DB 세션을 의존성(get_db)으로 받지 않고 여기서 직접 연다: 손님 입장은 DB 없이도 되는 경로라,
    DB·세션 저장소 장애가 입장 전체 실패로 번지면 안 된다. 무엇이 실패하든 익명으로 본다.
    """
    try:
        async with repo.session() as db:
            user = await get_current_user(request, ws_session, db)
            return str(user.id)
    except Exception:
        return None


async def _list_visible_safe(db: AsyncSession, user, now: datetime) -> list:
    """DB 회의 목록 — 깨져도 진행 중 방 목록은 보여 준다.

    세이브포인트 안에서 읽는다: PostgreSQL 은 쿼리 하나가 실패하면 트랜잭션 전체가 abort 되어
    다음 쿼리(_invitee_stats 등)가 InFailedSQLTransaction 으로 500 이 났다. 세이브포인트만 되돌리면
    바깥 트랜잭션·이미 읽은 행(live_rows)은 그대로 쓸 수 있다."""
    try:
        async with db.begin_nested():
            return await repo.list_visible(db, user, now)
    except Exception as e:
        logger.warning("회의 목록(DB) 조회 실패: %s", e)
        return []


@router.get("/rooms", response_model=RoomListResponse)
async def get_rooms(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """회의실 목록 (인증 사용자).

    진행 중(LiveKit 에 지금 있는 방)도 내 회의만 — 호스트이거나, 초대받았거나, 초대 링크로 이미 들어온 것
    (_live_access). 거기에 DB 에 저장된 내 회의(호스트이거나 초대받은 것) 중 지금 열려 있지 않은
    예정·지난 회의를 붙인다. 행마다 status 로 구분한다. 공유 링크는 호스트와 링크로 들어온 본인에게만 싣는다.
    """
    _check_configured()
    candidates = await _visible_live_rooms(db, user, await livekit.list_rooms())
    now = datetime.now(timezone.utc)

    # 진행 중 방 ↔ DB 행 짝짓기 + 내가 볼 수 있는 방만 남긴다
    lk_rooms: list[dict] = []
    live_rows: dict[str, MeetingDB | None] = {}
    metas = {}
    access: dict[str, str] = {}
    for r in candidates:
        meta = await store.get_room_meta(r["name"])
        row = None
        if meta and meta.meeting_id:
            row = await db.get(MeetingDB, meta.meeting_id)
        how = await _live_access(db, r["name"], meta, row, user)
        if how is None:
            continue
        lk_rooms.append(r)
        access[r["name"]] = how
        metas[r["name"]] = meta
        live_rows[r["name"]] = row

    visible = await _list_visible_safe(db, user, now)
    live_ids = {row.id for row in live_rows.values() if row is not None}
    live_names = set(live_rows)
    extra = [
        row for row in visible
        if row.id not in live_ids and not (row.room_name in live_names and row.status in repo.ACTIVE)
    ]
    stats = await _invitee_stats(db, list(live_ids | {row.id for row in extra}), user)

    result = []
    for r in lk_rooms:
        meta = metas[r["name"]]
        row = live_rows[r["name"]]
        how = access[r["name"]]
        # 대기 인원은 호스트만 본다(예전엔 목록을 보는 모두에게 나갔다)
        pending = await store.get_pending_requests(r["name"]) if (meta and how == "host") else []
        result.append(RoomInfo(
            **r,
            # 공유 링크: 호스트, 그리고 그 링크로 들어온 본인(이미 갖고 있는 값). 초대 대상은 예정 회의와 같게
            # 싣지 않는다 — 계정으로 초대받은 사람은 링크 없이 바로 들어가고, 링크는 초대 메일·알림에 있다.
            share_token=meta.share_token if (meta and how in ("host", "joined")) else "",
            is_host=how == "host",
            pending_count=len(pending),
            has_password=bool(meta.password_hash) if meta else False,
            host_name=meta.host_display_name if meta else "",
            scheduled_at=meta.scheduled_at if meta else None,
            duration_minutes=meta.duration_minutes if meta else None,
            **_row_fields(row, "live", stats.get(row.id) if row else None),
        ))
    for row in extra:
        is_host = row.host_user_id == str(user.id)
        created = repo._aware(row.created_at)
        result.append(RoomInfo(
            name=row.room_name,
            num_participants=0,
            max_participants=row.max_participants or 10,
            creation_time=int(created.timestamp()) if created else 0,
            # 공유 링크는 호스트에게만(초대받은 사람은 초대 메일·알림으로 받는다)
            share_token=row.share_token if is_host else "",
            is_host=is_host,
            pending_count=0,
            has_password=bool(row.password_hash),
            host_name=row.host_display_name or "",
            scheduled_at=_iso(row.scheduled_at),
            duration_minutes=row.duration_minutes,
            **_row_fields(row, repo.effective_status(row, False, now), stats.get(row.id)),
        ))
    return RoomListResponse(rooms=result)


async def _send_invites(
    *, invitees, meeting_name: str, user: User, share_token: str,
    scheduled_at: datetime | None, duration: int, password: str | None,
) -> None:
    """초대 메일(ICS)·내부 사용자 캘린더 일정 — best-effort (예전 create_room 본문 그대로)."""
    if not invitees:
        return
    join_url = f"{settings.app_url}/meetings/join/{share_token}"
    host_name = user.display_name or user.username
    host_email = user.email or f"{user.username}@{settings.domain}"
    scheduled = scheduled_at or datetime.now(timezone.utc)

    ics = generate_ics(
        summary=meeting_name,
        description=(f"회의 참여: {join_url}"
                     + (f"\n비밀번호: {password}" if password else "")),
        location=join_url,
        start=scheduled,
        end=scheduled + timedelta(minutes=duration),
        organizer_name=host_name,
        organizer_email=host_email,
    )

    for inv in invitees:
        # Determine recipient email
        if inv.type == "internal":
            to_email = f"{inv.username}@{settings.domain}" if inv.username else inv.email
        else:
            to_email = inv.email

        if not to_email:
            continue

        # a. Send invite email (ICS attached)
        try:
            await send_invite_email(
                to_email=to_email,
                meeting_name=meeting_name,
                host_name=host_name,
                join_url=join_url,
                scheduled_at=scheduled,
                duration_minutes=duration,
                ics_content=ics,
                password=password,
            )
        except Exception:
            logger.warning("Failed to send invite email to %s", to_email, exc_info=True)

        # b. Internal user → create calendar event
        if inv.type == "internal" and inv.username:
            try:
                await create_calendar_event(
                    username=inv.username,
                    meeting_name=meeting_name,
                    join_url=join_url,
                    scheduled_at=scheduled,
                    duration_minutes=duration,
                )
            except Exception:
                logger.warning("Failed to create calendar event for %s", inv.username, exc_info=True)


async def _notify_invitees(db: AsyncSession, row: MeetingDB, added: list[MeetingInvitee], host: User) -> None:
    """초대받은 내부 사용자에게 인앱 알림(수락/거절 버튼). 실패해도 회의는 만든다."""
    from app.notifications import service as nsvc

    when = repo._aware(row.scheduled_at)
    body = f"{host.display_name or host.username} 님이 회의에 초대했습니다"
    if when:
        body += f" · {when.isoformat()}"
    rsvp_url = f"/api/meetings/by-id/{row.id}/rsvp"
    for inv in added:
        if not inv.user_id or inv.user_id == str(host.id):
            continue
        try:
            await nsvc.create_notification(
                db, inv.user_id, "meeting_invite", f"회의 초대: {row.title or row.room_name}",
                body=body, link="/meetings",
                actor_id=str(host.id), actor_name=host.display_name or host.username,
                action_url="/meetings",
                actions=[
                    {"id": "accept", "label": "수락", "method": "POST", "url": rsvp_url,
                     "body": {"response": "accepted"}},
                    {"id": "decline", "label": "거절", "method": "POST", "url": rsvp_url,
                     "body": {"response": "declined"}},
                ],
            )
        except Exception as e:
            logger.warning("회의 초대 알림 실패(%s): %s", inv.user_id, e)


def _close_status(row: MeetingDB) -> str:
    """지우거나 끝낼 때 — 누가 들어온 적이 있으면 ended, 없으면 cancelled."""
    return "ended" if row.started_at is not None or row.status == "live" else "cancelled"


@router.post("/rooms", response_model=RoomInfo, status_code=201)
async def create_room(
    body: RoomCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """회의실 생성 → 호스트가 됨 + 참가자 초대. 회의는 DB 에도 저장한다(예약 회의가 살아남게)."""
    _check_configured()
    scheduled_at = _parse_scheduled(body.scheduled_at)
    if body.channel_id:
        from app.chat import service as chat_service
        if not await chat_service.is_channel_member(db, body.channel_id, user.id):
            raise HTTPException(status_code=403, detail="멤버인 채널에만 회의를 묶을 수 있습니다")

    # 같은 이름의 살아 있는 회의를 남이 갖고 있으면 덮어쓰지 않는다(예전엔 호스트가 바뀌었다).
    existing = await store.get_room_meta(body.name)
    if existing and existing.host_user_id != str(user.id):
        raise HTTPException(status_code=409, detail="같은 이름의 회의가 이미 있습니다")
    old = await repo.find_active(db, body.name)
    if old is not None:
        if old.host_user_id != str(user.id):
            raise HTTPException(status_code=409, detail="같은 이름의 회의가 이미 있습니다")
        # 내 회의를 같은 이름으로 다시 만들면 이전 것은 닫는다
        old.status = _close_status(old)
        old.ended_at = old.ended_at or datetime.now(timezone.utc)

    room = await livekit.create_room(
        name=body.name,
        max_participants=body.max_participants,
    )
    host_name = user.display_name or user.username
    row = MeetingDB(
        room_name=room["name"],
        title=body.name,
        description=body.description,
        host_user_id=str(user.id),
        host_display_name=host_name,
        share_token=secrets.token_hex(16),   # 32hex — store.RoomMeta 와 같은 강도
        password_hash=hash_password(body.password) if body.password else None,
        waiting_room=body.waiting_room,
        max_participants=body.max_participants,
        scheduled_at=scheduled_at,
        duration_minutes=body.duration_minutes,
        status="scheduled",
        chat_channel_id=body.channel_id or None,
    )
    db.add(row)
    await db.flush()
    added = await repo.add_invitees(db, row.id, body.invitees)
    await db.commit()

    meta = await store.create_room_meta(
        name=room["name"],
        host_user_id=str(user.id),
        host_username=user.username,
        host_display_name=host_name,
        password_hash=row.password_hash,
        scheduled_at=scheduled_at.isoformat() if scheduled_at else None,
        duration_minutes=body.duration_minutes,
        waiting_room=body.waiting_room,
        meeting_id=row.id,
        max_participants=body.max_participants,
        share_token=row.share_token,
        chat_channel_id=body.channel_id or None,
    )

    # ── 호스트 캘린더 일정 (예약 회의만, best-effort) ──
    if scheduled_at and body.add_to_calendar:
        try:
            ev_id = await create_calendar_event(
                user_id=str(user.id),
                meeting_name=body.name,
                join_url=f"{settings.app_url}/meetings/join/{row.share_token}",
                scheduled_at=scheduled_at,
                duration_minutes=body.duration_minutes,
            )
            if isinstance(ev_id, str) and ev_id:
                row.host_calendar_event_id = ev_id
                await db.commit()
        except Exception:
            logger.warning("호스트 캘린더 일정 생성 실패(%s)", user.username, exc_info=True)

    # ── 참가자 초대 (best-effort) ──
    await _send_invites(
        invitees=body.invitees, meeting_name=body.name, user=user, share_token=meta.share_token,
        scheduled_at=scheduled_at, duration=body.duration_minutes, password=body.password,
    )
    await _notify_invitees(db, row, added, user)

    stats = await _invitee_stats(db, [row.id], user)
    return RoomInfo(
        **room,
        share_token=meta.share_token,
        is_host=True,
        pending_count=0,
        has_password=bool(meta.password_hash),
        host_name=meta.host_display_name,
        scheduled_at=meta.scheduled_at,
        duration_minutes=meta.duration_minutes,
        **_row_fields(row, repo.effective_status(row, not scheduled_at), stats.get(row.id)),
    )


async def _host_row(db: AsyncSession, name: str, user: User):
    """호스트 전용 작업용 — (DB 행, Redis 메타). 둘 다 없으면 404, 호스트가 아니면 403."""
    meta = await store.get_room_meta(name)
    row = None
    if meta and meta.meeting_id:
        row = await db.get(MeetingDB, meta.meeting_id)
    if row is None:
        row = await repo.find_active(db, name)
    if row is None and meta is None:
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
    host_id = row.host_user_id if row is not None else meta.host_user_id
    if host_id != str(user.id):
        raise HTTPException(status_code=403, detail="호스트만 할 수 있습니다")
    return row, meta


@router.delete("/rooms/{name}", status_code=204)
async def delete_room(name: str, meeting_id: str | None = None,
                      user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """회의실 삭제 (호스트만 가능). DB 회의는 시작 전이면 취소, 진행했으면 종료로 남긴다.

    이미 끝난(지난) 회의를 지우면 목록에서 뺀다(deleted_at) — 예전엔 아무것도 안 바꾸고 204 라
    "지난 회의" 의 [삭제]가 무반응이었다. 같은 방 이름이 여러 번 끝났을 수 있어 meeting_id 로 행을 고른다."""
    _check_configured()
    # 채널·DM 통화(chan-)·음성 채널(voice-) 방은 회의가 아니다 — 여기서는 닫을 수 없다.
    if is_reserved_room_name(name):
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
    meta = await store.get_room_meta(name)
    if meta and meta.host_user_id != str(user.id):
        raise HTTPException(status_code=403, detail="호스트만 삭제할 수 있습니다")
    if meta and meta.meeting_id:
        row = await db.get(MeetingDB, meta.meeting_id)
    elif meeting_id:
        row = await db.get(MeetingDB, meeting_id)
        if row is not None and row.room_name != name:
            row = None
    else:
        row = await repo.find_active(db, name) or await repo.find_latest_closed(db, name, str(user.id))
    if row is not None and row.host_user_id != str(user.id):
        raise HTTPException(status_code=403, detail="호스트만 삭제할 수 있습니다")
    if meta is None and row is None:
        # 내 회의라는 근거(메타·DB 행)가 하나도 없다. 예전엔 여기서도 LiveKit 방을 닫아
        # 로그인 사용자 누구나 이름만 알면 남의 방을 닫을 수 있었다.
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
    if meta is None and row is not None and row.status not in repo.ACTIVE:
        # 지난 회의 행만 지운다 — 같은 이름으로 지금 열려 있을지 모르는 방(메타 없는 방)은 건드리지 않는다
        if row.deleted_at is None:
            row.deleted_at = datetime.now(timezone.utc)
            await db.commit()
        return
    try:
        await livekit.delete_room(name)
    except Exception:
        if row is None:
            raise
        # 예약만 해 둔 회의는 LiveKit 방이 이미 없을 수 있다
        logger.debug("LiveKit 방 삭제 생략(%s) — 이미 없음", name)
    await store.delete_room_meta(name)
    await store.clear_active_recording(name)
    if row is not None and row.status not in repo.ACTIVE:
        # 지난 회의 — 목록에서 지운다
        if row.deleted_at is None:
            row.deleted_at = datetime.now(timezone.utc)
            await db.commit()
        return
    if row is not None and row.status in repo.ACTIVE:
        row.status = _close_status(row)
        row.ended_at = datetime.now(timezone.utc)
        await db.commit()
        if row.status == "cancelled" and row.host_calendar_event_id:
            try:
                await delete_calendar_event(row.host_user_id, row.host_calendar_event_id)
            except Exception:
                logger.warning("취소한 회의의 캘린더 일정 삭제 실패(%s)", name, exc_info=True)


@router.post("/rooms/{name}/end")
async def end_room(name: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """회의 종료(호스트) — 모두 내보내고 '지난 회의' 로 남긴다."""
    row, meta = await _host_row(db, name, user)
    if livekit.is_configured():
        try:
            await livekit.delete_room(name)
        except Exception:
            pass
    await store.delete_room_meta(name)
    # 방이 닫히면 녹화(egress)도 끝난다 — 상태 키를 남기면 다음에 같은 방을 열 때 "녹화 중"으로 보인다
    await store.clear_active_recording(name)
    if row is not None:
        if row.status in repo.ACTIVE:
            row.status = "ended"
            row.ended_at = datetime.now(timezone.utc)
        await db.commit()
    return {"status": "ended", "meeting_id": row.id if row else None}


@router.patch("/rooms/{name}", response_model=MeetingDetail)
async def update_room(
    name: str,
    body: RoomUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """회의 수정(호스트) — 제목·설명·시각·길이·비밀번호·대기실·정원·초대 대상. 보낸 필드만 바뀐다."""
    row, meta = await _host_row(db, name, user)
    fields = body.model_fields_set
    time_changed = False

    new_sched = None
    if "scheduled_at" in fields:
        if body.scheduled_at:
            new_sched = _parse_scheduled(body.scheduled_at)
            if new_sched is None:
                raise HTTPException(status_code=400, detail="시각 형식이 올바르지 않습니다")
        time_changed = True
    pw_hash = hash_password(body.password) if ("password" in fields and body.password) else None

    added: list[MeetingInvitee] = []
    if row is not None:
        if row.status not in repo.ACTIVE:
            raise HTTPException(status_code=409, detail="끝났거나 취소된 회의는 고칠 수 없습니다")
        if "title" in fields and body.title is not None:
            row.title = body.title.strip() or row.room_name
            time_changed = True
        if "description" in fields:
            row.description = body.description
        if "scheduled_at" in fields:
            row.scheduled_at = new_sched
        if "duration_minutes" in fields and body.duration_minutes:
            row.duration_minutes = body.duration_minutes
            time_changed = True
        if "password" in fields:
            row.password_hash = pw_hash
        if "waiting_room" in fields and body.waiting_room is not None:
            row.waiting_room = body.waiting_room
        if "max_participants" in fields and body.max_participants:
            row.max_participants = body.max_participants
        if body.remove_invitee_ids:
            for inv in await repo.get_invitees(db, row.id):
                if inv.id in body.remove_invitee_ids:
                    await db.delete(inv)
        if body.add_invitees:
            added = await repo.add_invitees(db, row.id, body.add_invitees)
        await db.commit()
    elif body.add_invitees or body.remove_invitee_ids:
        raise HTTPException(status_code=400, detail="예약 정보가 없는 방은 초대 대상을 바꿀 수 없습니다")

    if meta is not None:
        if "scheduled_at" in fields:
            meta.scheduled_at = new_sched.isoformat() if new_sched else None
        if "duration_minutes" in fields and body.duration_minutes:
            meta.duration_minutes = body.duration_minutes
        if "password" in fields:
            meta.password_hash = pw_hash
        if "waiting_room" in fields and body.waiting_room is not None:
            meta.waiting_room = body.waiting_room
        if "max_participants" in fields and body.max_participants:
            meta.max_participants = body.max_participants
        await store.save_room_meta(meta)

    # 호스트 캘린더 일정 따라 옮기기 (best-effort)
    if row is not None and time_changed and row.host_calendar_event_id and row.scheduled_at:
        try:
            await update_calendar_event_time(
                row.host_user_id, row.host_calendar_event_id, repo._aware(row.scheduled_at),
                row.duration_minutes or repo.DEFAULT_DURATION, row.title,
            )
        except Exception:
            logger.warning("호스트 캘린더 일정 수정 실패(%s)", name, exc_info=True)

    if row is not None and added:
        new_items = [it for it in body.add_invitees]
        await _send_invites(
            invitees=new_items, meeting_name=row.title or row.room_name, user=user,
            share_token=row.share_token, scheduled_at=repo._aware(row.scheduled_at),
            duration=row.duration_minutes or repo.DEFAULT_DURATION,
            password=body.password if "password" in fields else None,
        )
        await _notify_invitees(db, row, added, user)

    return await _detail(db, row, meta, user, name)


async def _detail(db: AsyncSession, row: MeetingDB | None, meta, user: User, name: str) -> MeetingDetail:
    live, num = False, 0
    if livekit.is_configured():
        try:
            lk = next((r for r in await livekit.list_rooms() if r["name"] == name), None)
        except Exception:
            lk = None
        if lk:
            live, num = True, lk["num_participants"]
    if row is None:
        is_host = bool(meta and meta.host_user_id == str(user.id))
        return MeetingDetail(
            name=name, num_participants=num, max_participants=meta.max_participants if meta else 10,
            creation_time=int(meta.created_at) if meta else 0,
            share_token=meta.share_token if (meta and is_host) else "", is_host=is_host,
            has_password=bool(meta and meta.password_hash), host_name=meta.host_display_name if meta else "",
            scheduled_at=meta.scheduled_at if meta else None,
            duration_minutes=meta.duration_minutes if meta else None,
            status="live" if live else "scheduled", waiting_room=meta.waiting_room if meta else True,
        )
    is_host = row.host_user_id == str(user.id)
    invs = await repo.get_invitees(db, row.id)
    stats = await _invitee_stats(db, [row.id], user)
    created = repo._aware(row.created_at)
    pending = await store.get_pending_requests(row.room_name) if (is_host and live) else []
    return MeetingDetail(
        name=row.room_name,
        num_participants=num,
        max_participants=row.max_participants or 10,
        creation_time=int(created.timestamp()) if created else 0,
        share_token=row.share_token if is_host else "",
        is_host=is_host,
        pending_count=len(pending),
        has_password=bool(row.password_hash),
        host_name=row.host_display_name or "",
        scheduled_at=_iso(row.scheduled_at),
        duration_minutes=row.duration_minutes,
        **_row_fields(row, repo.effective_status(row, live), stats.get(row.id)),
        invitees=[InviteeInfo(**repo.invitee_dict(i)) for i in invs],
        join_url=f"{settings.app_url}/meetings/join/{row.share_token}" if is_host else "",
    )


@router.get("/by-id/{meeting_id}", response_model=MeetingDetail)
async def get_meeting(meeting_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """회의 상세(호스트·초대받은 사람만) — 초대 대상과 각자의 응답 포함. 예정·지난 회의 모두."""
    row = await db.get(MeetingDB, meeting_id)
    if row is None or not await repo.can_view(db, row, user):
        # 남의 회의는 있는지도 알려 주지 않는다
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
    return await _detail(db, row, None, user, row.room_name)


@router.post("/by-id/{meeting_id}/rsvp")
async def rsvp_meeting(
    meeting_id: str,
    body: RsvpRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """참석 응답(초대받은 사람 본인만) — accepted | declined | tentative."""
    if body.response not in ("accepted", "declined", "tentative"):
        raise HTTPException(status_code=400, detail="response 는 accepted·declined·tentative 중 하나")
    row = await db.get(MeetingDB, meeting_id)
    inv = await repo.my_invite(db, meeting_id, user) if row is not None else None
    if row is None or inv is None:
        raise HTTPException(status_code=404, detail="초대받은 회의가 아닙니다")
    if row.status == "cancelled":
        raise HTTPException(status_code=409, detail="취소된 회의입니다")
    inv.response = body.response
    inv.responded_at = datetime.now(timezone.utc)
    if not inv.user_id:
        inv.user_id = str(user.id)   # 메일 주소로 초대받은 내부 사용자 — 이제 계정으로 묶는다
    await db.commit()
    return {"ok": True, "meeting_id": row.id, "response": inv.response}


@router.post("/rooms/{name}/rsvp")
async def rsvp_room(
    name: str,
    body: RsvpRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """참석 응답 — 방 이름으로(지금 살아 있는 회의)."""
    row = await repo.find_active(db, name)
    if row is None:
        raise HTTPException(status_code=404, detail="초대받은 회의가 아닙니다")
    return await rsvp_meeting(row.id, body, user=user, db=db)


# ─── 회의 녹화 (Egress, 호스트 전용) ───

async def _require_host(name: str, user: User):
    meta = await store.get_room_meta(name)
    if not meta or meta.host_user_id != str(user.id):
        raise HTTPException(status_code=403, detail="호스트만 녹화를 제어할 수 있습니다")
    return meta


@router.post("/rooms/{name}/recording/start")
async def start_recording(name: str, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    _check_configured()
    meta = await _require_host(name, user)
    if await store.get_active_recording(name):
        raise HTTPException(status_code=409, detail="이미 녹화 중입니다")
    try:
        rec = await livekit.start_recording(name)
    except Exception as e:
        # egress 가 꺼져 있거나 CPU 가 모자라 요청을 거절하면 LiveKit 이 ~23초 뒤 "no response from servers".
        # 원문은 로그로, 사용자에게는 사람 말로(프런트가 토스트로 그대로 보여 준다).
        logger.warning("녹화 시작 실패(%s): %s", name, e)
        raise HTTPException(
            status_code=502,
            detail="녹화를 시작하지 못했습니다. 녹화 서버가 꺼져 있거나 자원이 부족합니다 — 관리자에게 문의하세요.",
        )
    await store.set_active_recording(name, rec["egress_id"], rec["filename"])
    # 파일 ↔ 회의 기록 — 목록·다운로드는 이 회의의 호스트·초대 대상·채널 멤버만
    try:
        db.add(MeetingRecording(
            filename=rec["filename"], room_name=name,
            meeting_id=getattr(meta, "meeting_id", None), host_user_id=str(user.id),
            chat_channel_id=getattr(meta, "chat_channel_id", None),
        ))
        await db.commit()
    except Exception:
        logger.warning("녹화 기록 저장 실패(%s)", rec.get("filename"), exc_info=True)
        await db.rollback()
    return {"recording": True, "filename": rec["filename"]}


@router.post("/rooms/{name}/recording/stop")
async def stop_recording(name: str, user: User = Depends(get_current_user)):
    _check_configured()
    await _require_host(name, user)
    active = await store.get_active_recording(name)
    if not active:
        raise HTTPException(status_code=404, detail="진행 중인 녹화가 없습니다")
    try:
        await livekit.stop_recording(active["egress_id"])
    except Exception as e:
        # 방이 닫히며 이미 끝난 egress 는 LiveKit 이 "멈출 수 없다"고 거절한다. 어느 쪽이든 녹화는 돌고 있지
        # 않으므로 상태를 내리고 정상 응답한다 — 예전엔 500 이 나가 화면이 "녹화 중"으로 굳었다.
        logger.warning("녹화 중지 실패(%s) — 이미 끝난 녹화로 보고 상태만 내린다: %s", name, e)
    finally:
        await store.clear_active_recording(name)
    return {"recording": False, "filename": active.get("filename")}


@router.get("/rooms/{name}/recording")
async def recording_status(name: str, user: User = Depends(get_current_user),
                           db: AsyncSession = Depends(get_db)):
    """녹화 중인가(회의 화면이 들어올 때 읽는다). 그 방을 볼 수 있는 사람에게만 답한다 —
    예전엔 방 이름만 알면 누구에게나 녹화 여부·파일 이름(방이 있다는 사실)이 나갔다. 아니면 "녹화 안 함"."""
    if is_reserved_room_name(name):
        allowed = is_channel_call_room(name) and await _can_see_channel_call(db, name, user)
    else:
        meta = await store.get_room_meta(name)
        row = await db.get(MeetingDB, meta.meeting_id) if (meta and meta.meeting_id) else None
        allowed = await _live_access(db, name, meta, row, user) is not None
    if not allowed:
        return {"recording": False, "filename": None}
    active = await store.get_active_recording(name)
    return {"recording": bool(active), "filename": active.get("filename") if active else None}


RECORDINGS_DIR = "/recordings"


async def _can_access_recording(db: AsyncSession, user, filename: str) -> bool:
    """녹화 파일을 볼 수 있나 — 관리자, 그 회의의 호스트·초대 대상, (채널 통화·채널에 묶인 회의) 채널 멤버.

    기록이 없는 예전 파일은 파일 이름의 방 이름으로 회의를 찾아 같은 기준을 적용하고,
    못 찾으면 관리자만.
    """
    if getattr(user, "is_admin", False):
        return True
    from app.chat import service as chat_service

    async def _member(channel_id: str | None) -> bool:
        if not channel_id:
            return False
        try:
            return bool(await chat_service.is_channel_member(db, channel_id, user.id))
        except Exception:
            return False

    rec = (await db.execute(
        select(MeetingRecording).where(MeetingRecording.filename == filename)
    )).scalars().first()
    if rec is not None:
        if rec.host_user_id and rec.host_user_id == str(user.id):
            return True
        if rec.meeting_id:
            row = await db.get(MeetingDB, rec.meeting_id)
            if row is not None and await repo.can_view(db, row, user):
                return True
        return await _member(rec.chat_channel_id)

    room = filename.rsplit("_", 1)[0] if "_" in filename else ""
    if not room:
        return False
    if is_reserved_room_name(room):
        # 채널·DM 통화(chan-)만 채널 멤버에게. 그 밖의 예약 이름(voice-)은 회의 녹화가 아니다 — 관리자만
        return await _member(room[len("chan-"):]) if is_channel_call_room(room) else False
    rows = (await db.execute(select(MeetingDB).where(MeetingDB.room_name == room))).scalars().all()
    for row in rows:
        if await repo.can_view(db, row, user) or await _member(row.chat_channel_id):
            return True
    return False


@router.get("/recordings")
async def list_recordings(
    room: str | None = None,  # 이 방(회의 room_name)의 녹화만
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    """저장된 녹화 파일 목록(egress-out 볼륨, 백엔드에 /recordings 로 마운트) — 볼 수 있는 것만.

    파일 이름은 `<방 이름>_<YYYYmmdd-HHMMSS>.mp4`(livekit.start_recording) — room 을 주면 그 방 것만."""
    import os
    d = RECORDINGS_DIR
    if not os.path.isdir(d):
        return {"recordings": []}
    items = []
    for fn in sorted(os.listdir(d), reverse=True):
        p = os.path.join(d, fn)
        if os.path.isfile(p) and fn.endswith((".mp4", ".webm", ".ogg")):
            if room and fn.rsplit("_", 1)[0] != room:
                continue
            if not await _can_access_recording(db, user, fn):
                continue
            items.append({"filename": fn, "size": os.path.getsize(p), "mtime": os.path.getmtime(p)})
    return {"recordings": items}


@router.get("/recordings/{filename}")
async def download_recording(filename: str, user: User = Depends(get_current_user),
                             db: AsyncSession = Depends(get_db)):
    import os
    from fastapi.responses import FileResponse
    # 경로 traversal 차단 — basename 만 허용
    safe = os.path.basename(filename)
    if safe != filename or "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="잘못된 파일명")
    path = os.path.join(RECORDINGS_DIR, safe)
    if not os.path.isfile(path) or not await _can_access_recording(db, user, safe):
        raise HTTPException(status_code=404, detail="녹화 파일을 찾을 수 없습니다")
    from app.files import serve_safety
    media, headers = serve_safety.safe_file_headers(safe)
    return FileResponse(path, media_type=media, headers=headers)


@router.post("/token", response_model=TokenResponse)
async def create_token(
    body: TokenRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """호스트용 직접 참여 토큰 발급. 게스트는 공유링크 승인 플로우 사용."""
    _check_configured()

    # 채널 통화(chat에서 시작) — "chan-<채널id>" 룸은 그 채널 멤버 누구나 입장.
    # 호스트/사전등록 개념 없이 LiveKit 룸 자동생성(디스코드 음성채널 방식).
    if is_reserved_room_name(body.room) and not body.room.startswith("chan-"):
        raise HTTPException(status_code=404, detail="회의실을 찾을 수 없습니다")
    if body.room.startswith("chan-"):
        channel_id = body.room[len("chan-"):]
        from app.chat import service as chat_service
        if not await chat_service.is_channel_member(db, channel_id, user.id):
            raise HTTPException(status_code=403, detail="채널 멤버가 아닙니다")
        token = livekit.generate_token(
            room=body.room,
            identity=livekit.session_identity(user.id),
            name=user.display_name or user.username,
        )
        return TokenResponse(token=token, livekit_url=livekit.get_ws_url(), is_host=False)

    # 인증우회 방지 — 임의 room 이름에 publish 토큰 발급 금지.
    # 방이 존재하고 요청자가 그 방의 호스트일 때만 토큰 발급.
    meta = await store.get_room_meta(body.room)
    if not meta:
        raise HTTPException(status_code=404, detail="회의실을 찾을 수 없습니다")
    is_host = meta.host_user_id == str(user.id)
    if not is_host and not await _is_invited(db, meta, user):
        # 목록을 받은 뒤 초대에서 빠진 경우 등 — 화면이 이 문구를 그대로 보여 준다(다음 길을 알려 준다)
        raise HTTPException(status_code=403, detail="호스트와 초대받은 사람만 바로 참여할 수 있습니다. 받은 초대 링크로 들어와 주세요")
    # identity는 세션마다 고유하게 — 같은 사용자가 여러 기기/탭으로 들어와도
    # LiveKit DUPLICATE_IDENTITY로 서로 쫓아내며 무한 재접속하는 것 방지.
    # 표시이름(name)만 사용자명 유지.
    token = livekit.generate_token(
        room=body.room,
        identity=livekit.session_identity(user.id),
        name=user.display_name or user.username,
    )

    # DB 에서 되살린 예약 회의는 LiveKit 방이 이미 닫혔을 수 있다 — 정원 설정대로 다시 연다
    await _ensure_lk_room(meta)

    return TokenResponse(token=token, livekit_url=livekit.get_ws_url(), is_host=is_host)


async def _is_invited(db: AsyncSession, meta, user: User) -> bool:
    """호스트가 이 사람을 초대 대상에 넣었나 — 계정으로 지정했거나, 초대한 메일 주소가 이 계정의 주소이거나.

    목록의 [참여]가 초대받은 사람에게도 뜨는데 토큰은 호스트에게만 줘서 들어갈 길이 없었다.
    초대 대상은 대기실·비밀번호(링크만 가진 손님을 거르는 장치) 없이 들인다.
    판정은 참석 응답(RSVP)·목록 노출과 같다(repo.my_invite): user_id 가 같거나, 로컬 계정이면서 초대 주소가
    계정 주소(User.email)와 같다. 로컬 계정의 주소는 가입 때 시스템이 정하고 본인이 바꿀 수 없다(바꿀 수 있는
    복구 메일 recovery_email 은 보지 않는다). LDAP 등 외부 인증 계정은 디렉터리 값이 주소를 덮어쓰므로
    주소로는 묶지 않는다(repo._own_email) — 계정을 지정한 초대나 초대 링크(대기실·비밀번호)로 들어온다.
    예전엔 메일 주소로만 초대된 내부 계정이 목록에서는 회의를 보는데 [참여]는 403 이었다.
    """
    meeting_id = getattr(meta, "meeting_id", None)
    if not meeting_id:
        return False
    row = await db.get(MeetingDB, meeting_id)
    if row is None or row.status not in repo.ACTIVE:
        return False
    return await repo.my_invite(db, row.id, user) is not None


@router.get("/rooms/{name}/participants", response_model=list[ParticipantInfo])
async def get_participants(name: str, user: User = Depends(get_current_user),
                           db: AsyncSession = Depends(get_db)):
    """참여자 목록. 채널·DM 통화 방은 그 채널 멤버만, 회의는 호스트·초대 대상만.

    예전엔 chan- 이 아니면 로그인 사용자 누구에게나 내줘서 방 이름만 알면 참가자 이름이 보였다.
    음성 채널(voice-)은 app/chat/voice.py 가 따로 낸다 — 여기서는 없는 방이다.
    """
    _check_configured()
    if is_reserved_room_name(name):
        if not is_channel_call_room(name) or not await _can_see_channel_call(db, name, user):
            raise HTTPException(status_code=404, detail="회의실을 찾을 수 없습니다")
    else:
        meta = await store.get_room_meta(name)
        allowed = bool(meta and meta.host_user_id == str(user.id))
        if not allowed and meta and meta.meeting_id:
            row = await db.get(MeetingDB, meta.meeting_id)
            allowed = row is not None and await repo.can_view(db, row, user)
        if not allowed:
            raise HTTPException(status_code=404, detail="회의실을 찾을 수 없습니다")
    participants = await livekit.list_participants(name)
    return [ParticipantInfo(**p) for p in participants]


@router.get("/rooms/{name}/summary", response_model=MeetingSummary)
async def meeting_summary(name: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """회의 종료 화면 "이번 회의" 카드(시안 R12Misc meetEnd) — 제목·호스트·채팅 채널·캘린더 일정·시각.

    볼 수 있는 사람: 채널 통화(chan-<id>)는 그 채널 멤버, 그 밖은 호스트·초대 대상(DB 회의) 또는
    Redis 방의 호스트. 아니면 404(남의 회의는 있는지도 알려 주지 않는다). 끝난 회의도 본다.
    """
    if name.startswith("chan-"):
        channel_id = name[len("chan-"):]
        from app.chat import service as chat_service
        if not await chat_service.is_channel_member(db, channel_id, user.id):
            raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
        ch_name = await _channel_name(channel_id)
        return MeetingSummary(
            name=name, title=f"#{ch_name}" if ch_name else "", chat_channel_id=channel_id, channel_name=ch_name,
        )

    row = (await db.execute(
        select(MeetingDB).where(MeetingDB.room_name == name).order_by(MeetingDB.created_at.desc()).limit(1)
    )).scalars().first()
    if row is not None:
        if not await repo.can_view(db, row, user):
            raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
        is_host = row.host_user_id == str(user.id)
        return MeetingSummary(
            name=name,
            title=row.title or row.room_name,
            host_name=row.host_display_name or "",
            is_host=is_host,
            chat_channel_id=row.chat_channel_id,
            channel_name=await _channel_name(row.chat_channel_id),
            calendar_event_id=row.host_calendar_event_id if is_host else None,
            scheduled_at=_iso(row.scheduled_at),
            started_at=_iso(row.started_at),
            ended_at=_iso(row.ended_at),
        )

    meta = await store.get_room_meta(name)
    if meta is None or meta.host_user_id != str(user.id):
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
    return MeetingSummary(
        name=name, title=name, host_name=meta.host_display_name or "", is_host=True,
        chat_channel_id=meta.chat_channel_id, channel_name=await _channel_name(meta.chat_channel_id),
        scheduled_at=meta.scheduled_at,
    )


# ════════════════════════════════════════════
# 호스트 — 참가 신청 관리
# ════════════════════════════════════════════

@router.get("/rooms/{name}/requests", response_model=list[PendingRequest])
async def get_pending_requests(name: str, user: User = Depends(get_current_user)):
    """대기 중인 참가 신청 목록 (호스트 전용)."""
    meta = await store.get_room_meta(name)
    if not meta or meta.host_user_id != str(user.id):
        raise HTTPException(status_code=403, detail="호스트만 확인할 수 있습니다")
    pending = await store.get_pending_requests(name)
    return [PendingRequest(id=r.id, nickname=r.nickname, created_at=r.created_at) for r in pending]


@router.post("/rooms/{name}/requests/{req_id}/approve", status_code=200)
async def approve_request(name: str, req_id: str, user: User = Depends(get_current_user)):
    """참가 신청 승인 → LiveKit 토큰 생성."""
    meta = await store.get_room_meta(name)
    if not meta or meta.host_user_id != str(user.id):
        raise HTTPException(status_code=403, detail="호스트만 승인할 수 있습니다")
    req = await store.get_join_request(name, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="신청을 찾을 수 없습니다")
    if req.status != "pending":
        raise HTTPException(status_code=400, detail="이미 처리된 신청입니다")

    token = livekit.generate_token(
        room=name,
        identity=f"guest-{req.id}",
        name=req.nickname,
    )
    await store.set_join_request_status(name, req_id, "approved", livekit_token=token)
    return {"status": "approved"}


@router.post("/rooms/{name}/requests/{req_id}/deny", status_code=200)
async def deny_request(name: str, req_id: str, user: User = Depends(get_current_user)):
    """참가 신청 거절."""
    meta = await store.get_room_meta(name)
    if not meta or meta.host_user_id != str(user.id):
        raise HTTPException(status_code=403, detail="호스트만 거절할 수 있습니다")
    req = await store.get_join_request(name, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="신청을 찾을 수 없습니다")
    if req.status != "pending":
        raise HTTPException(status_code=400, detail="이미 처리된 신청입니다")
    await store.set_join_request_status(name, req_id, "denied")
    return {"status": "denied"}


# ════════════════════════════════════════════
# 공유링크 (인증 불요)
# ════════════════════════════════════════════

# 비밀번호 무차별 대입 방지 — 10분 창에서 10회
_PW_MAX_FAILS = 10
_PW_WINDOW = 600
# "호스트에게 알리기" — 같은 링크로 10분에 한 번
_NOTIFY_HOST_WINDOW = 600


def _ended_at(row) -> str | None:
    """끝난 시각 — 기록이 없으면(예약만 하고 안 열린 회의) 예정 끝 시각."""
    end = row.ended_at
    if end is None and row.scheduled_at is not None:
        end = row.scheduled_at + timedelta(minutes=row.duration_minutes or repo.DEFAULT_DURATION)
    if end is None:
        return None
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return end.isoformat()


async def _ended_link_info(token: str) -> dict | None:
    """Redis 에 없는 링크가 끝났거나 취소된 회의의 것이면 결과 화면용 정보를(시안 WorkMobile meetEnded)."""
    try:
        async with repo.session() as db:
            row = await repo.find_by_token(db, token)
            if row is None or row.status in repo.ACTIVE:
                return None
            return {
                "code": "ended",
                "message": "이 초대 링크는 만료되었습니다",
                "name": row.title or row.room_name,
                "host_name": row.host_display_name or "",
                "ended_at": _ended_at(row),
                "status": row.status,
            }
    except Exception:
        logger.debug("끝난 초대 링크 조회 실패(%s)", token, exc_info=True)
        return None


async def _channel_name(channel_id: str | None) -> str | None:
    """회의에 묶인 채널 이름. DM·없는 채널은 None(손님 화면에 사람 이름이 나가지 않게)."""
    if not channel_id:
        return None
    try:
        from app.db.models import Channel
        async with repo.session() as db:
            ch = await db.get(Channel, channel_id)
            if ch is None or ch.type == "dm":
                return None
            return ch.name
    except Exception:
        return None


@router.get("/join/{token}", response_model=JoinRoomInfo)
async def get_join_info(token: str):
    """공유링크 → 회의실 정보 조회 (인증 불요).

    끝났거나 취소된 회의의 링크면 410 + detail {code: "ended", name, host_name, ended_at} —
    결과 화면이 "'회의' 는 10월 15일 16:00에 끝났습니다" 를 그린다. 모르는 링크는 404.
    """
    _check_configured()
    meta = await store.get_room_by_token(token)
    if not meta:
        ended = await _ended_link_info(token)
        if ended:
            raise HTTPException(status_code=410, detail=ended)
        raise HTTPException(status_code=404, detail="유효하지 않은 초대 링크입니다")

    # LiveKit에서 실시간 참여자 수 조회
    try:
        lk_rooms = await livekit.list_rooms()
        lk_info = next((r for r in lk_rooms if r["name"] == meta.name), None)
    except Exception:
        lk_info = None

    return JoinRoomInfo(
        name=meta.name,
        host_name=meta.host_display_name,
        num_participants=lk_info["num_participants"] if lk_info else 0,
        max_participants=lk_info["max_participants"] if lk_info else 10,
        requires_password=bool(meta.password_hash),
        scheduled_at=meta.scheduled_at,
        duration_minutes=meta.duration_minutes,
        waiting_room=meta.waiting_room,
        channel_name=await _channel_name(meta.chat_channel_id),
    )


@router.post("/join/{token}/notify-host", status_code=202)
async def notify_host(token: str, body: JoinNotifyHost):
    """만료된(또는 살아 있는) 초대 링크 화면의 "호스트에게 알리기" (인증 불요).

    호스트에게 인앱 알림 하나. 같은 링크로는 10분에 한 번만(429) — 손님이 알림 폭탄을 못 보내게.
    """
    nickname = (body.nickname or "").strip()[:30]
    host_id = None
    title = ""
    meta = await store.get_room_by_token(token)
    if meta:
        host_id, title = meta.host_user_id, meta.name
    else:
        async with repo.session() as db:
            row = await repo.find_by_token(db, token)
            if row is not None:
                host_id, title = row.host_user_id, (row.title or row.room_name)
    if not host_id:
        raise HTTPException(status_code=404, detail="유효하지 않은 초대 링크입니다")

    r = await get_redis()
    key = f"mtg:notifyhost:{token}"
    if not await r.set(key, "1", ex=_NOTIFY_HOST_WINDOW, nx=True):
        raise HTTPException(status_code=429, detail="이미 호스트에게 알렸습니다. 잠시 뒤 다시 시도해 주세요")

    from app.notifications.service import create_notification
    who = nickname or "손님"
    async with repo.session() as db:
        await create_notification(
            db, host_id, "meeting_invite",
            f"{who} 님이 \"{title}\" 초대 링크로 들어오려 합니다",
            "링크가 만료되었거나 회의가 끝났습니다. 새 링크를 보내 주세요.",
            link="/meetings",
            actor_name=who,
        )
    return {"ok": True}


@router.post("/join/{token}/request", response_model=JoinRequestResponse)
async def submit_join_request(token: str, body: JoinRequestCreate,
                              link_uid: str | None = Depends(_optional_user_id)):
    """공유링크 → 참가 신청 (인증 불요)."""
    _check_configured()
    meta = await store.get_room_by_token(token)
    if not meta:
        raise HTTPException(status_code=404, detail="유효하지 않은 초대 링크입니다")

    # 로그인한 사람이 링크로 들어오면 적어 둔다 — 회의 목록에서 자기가 들어가 있는 회의가 보이게(_live_access).
    # 입장 자체와는 무관하다: 실패해도 신청은 그대로 받는다. (라우터 밖에서 직접 부르면 Depends 객체가 온다)
    if isinstance(link_uid, str) and link_uid:
        try:
            await store.remember_link_user(meta.name, link_uid)
        except Exception:
            logger.debug("링크 입장 기록 실패(%s)", meta.name, exc_info=True)

    nickname = body.nickname.strip()
    if not nickname or len(nickname) > 30:
        raise HTTPException(status_code=400, detail="닉네임은 1~30자여야 합니다")

    # ── 비밀번호가 걸린 방: 맞히면 호스트 승인 없이 바로 입장 ──
    if meta.password_hash and body.password:
        r = await get_redis()
        fail_key = f"mtg:pwfail:{token}"
        fails = int(await r.get(fail_key) or 0)
        if fails >= _PW_MAX_FAILS:
            raise HTTPException(
                status_code=429, detail="시도가 너무 많습니다. 잠시 후 다시 시도해 주세요",
                headers={"X-Attempts-Remaining": "0"},
            )
        if not verify_password(body.password, meta.password_hash):
            # 무차별 대입 방지 — 10분 창에서 10회. 남은 횟수는 헤더로(결과 화면 "비밀번호가 맞지 않습니다 · 2번 남음")
            fails = int(await r.incr(fail_key) or fails + 1)
            await r.expire(fail_key, _PW_WINDOW)
            raise HTTPException(
                status_code=403, detail="비밀번호가 올바르지 않습니다",
                headers={"X-Attempts-Remaining": str(max(0, _PW_MAX_FAILS - fails))},
            )

        req = await store.create_join_request(meta.name, nickname)
        if not req:
            raise HTTPException(status_code=429, detail="대기 신청이 너무 많거나 회의실을 찾을 수 없습니다")
        lk_token = livekit.generate_token(
            room=meta.name,
            identity=f"guest-{req.id}",
            name=nickname,
        )
        await store.set_join_request_status(meta.name, req.id, "approved", livekit_token=lk_token)
        return JoinRequestResponse(
            request_id=req.id,
            status="approved",
            token=lk_token,
            livekit_url=livekit.get_ws_url(),
        )

    # ── 대기실 꺼짐: 승인 없이 바로 입장. 비밀번호가 걸린 방이면 비밀번호는 맞혀야 한다 ──
    if not meta.waiting_room:
        if meta.password_hash:
            raise HTTPException(status_code=403, detail="비밀번호가 필요합니다")
        req = await store.create_join_request(meta.name, nickname)
        if not req:
            raise HTTPException(status_code=429, detail="대기 신청이 너무 많거나 회의실을 찾을 수 없습니다")
        await _ensure_lk_room(meta)
        lk_token = livekit.generate_token(room=meta.name, identity=f"guest-{req.id}", name=nickname)
        await store.set_join_request_status(meta.name, req.id, "approved", livekit_token=lk_token)
        return JoinRequestResponse(
            request_id=req.id, status="approved", token=lk_token, livekit_url=livekit.get_ws_url(),
        )

    # 비밀번호가 없거나 입력하지 않았으면 기존 호스트 승인 경로
    req = await store.create_join_request(meta.name, nickname)
    if not req:
        raise HTTPException(status_code=429, detail="대기 신청이 너무 많거나 회의실을 찾을 수 없습니다")

    await _notify_host_waiting(meta, req.id, nickname)
    return JoinRequestResponse(request_id=req.id)


async def _notify_host_waiting(meta, req_id: str, nickname: str) -> None:
    """대기실 입장 신청 → 호스트 활동 패널에 [들이기][거절] 이 달린 알림(시안 R12Call 4 "활동 패널에도 기록").

    미니 통화 창의 요청 띠와 같은 신청이다 — 어느 쪽에서 처리해도 다른 쪽은 "이미 처리된 신청"(400)이 된다.
    알림이 실패해도 신청은 그대로 받는다.
    """
    from urllib.parse import quote

    try:
        from app.notifications.service import create_notification

        base = f"/api/meetings/rooms/{quote(meta.name, safe='')}/requests/{quote(req_id, safe='')}"
        async with repo.session() as db:
            title = meta.name
            if meta.meeting_id:
                row = await db.get(MeetingDB, meta.meeting_id)
                if row is not None and row.title:
                    title = row.title
            await create_notification(
                db, meta.host_user_id, "meeting_invite",
                f"{nickname} 님이 들어오려고 합니다",
                f"\"{title}\" 대기실",
                link=f"/meetings/room/{quote(meta.name, safe='')}",
                actor_name=nickname,
                actions=[
                    {"id": "approve", "label": "들이기", "method": "POST", "url": f"{base}/approve"},
                    {"id": "deny", "label": "거절", "method": "POST", "url": f"{base}/deny"},
                ],
            )
    except Exception:
        logger.debug("대기실 신청 알림 실패(%s)", meta.name, exc_info=True)


@router.post("/join/{token}/request/{req_id}/cancel", status_code=200)
async def cancel_join_request(token: str, req_id: str):
    """손님이 대기 중 [취소] (인증 불요 — 초대 링크와 자기 신청 id 를 아는 사람).

    예전엔 화면만 돌아가고 신청은 남아, 호스트 대기실에 유령 신청이 떠 있었다. 아직 대기 중인 신청만 접는다 —
    이미 승인·거절된 것은 그대로 둔다.
    """
    meta = await store.get_room_by_token(token)
    if not meta:
        raise HTTPException(status_code=404, detail="유효하지 않은 초대 링크입니다")
    req = await store.get_join_request(meta.name, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="신청을 찾을 수 없습니다")
    if req.status == "pending":
        await store.set_join_request_status(meta.name, req_id, "cancelled")
    return {"status": "cancelled" if req.status in ("pending", "cancelled") else req.status}


@router.get("/join/{token}/request/{req_id}/status", response_model=JoinRequestStatus)
async def get_request_status(token: str, req_id: str):
    """참가 신청 상태 폴링 (인증 불요)."""
    meta = await store.get_room_by_token(token)
    if not meta:
        raise HTTPException(status_code=404, detail="유효하지 않은 초대 링크입니다")

    req = await store.get_join_request(meta.name, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="신청을 찾을 수 없습니다")

    if req.status == "approved" and req.livekit_token:
        return JoinRequestStatus(
            status="approved",
            token=req.livekit_token,
            livekit_url=livekit.get_ws_url(),
        )

    return JoinRequestStatus(status=req.status)
