"""Calendar API endpoints — PostgreSQL backend."""

from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import CalendarEventDB, User
from app.db.session import get_db
from app.calendar import service
from app.calendar.schemas import (
    CalendarInfo,
    CalendarCreate,
    CalendarUpdate,
    CalendarEvent,
    EventCreate,
    EventUpdate,
    CalendarListResponse,
    EventListResponse,
    CalendarShareRequest,
    CalendarShareInfo,
    RsvpRequest,
    SubscriptionCreate,
    SubscriptionPreview,
    SubscriptionPreviewRequest,
    SubscriptionInfo,
)
from app.calendar import subscriptions as subs
from app.modules.registry import require_module

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


# ─── Calendars ───


@router.get("/calendars", response_model=CalendarListResponse)
@require_module("calendar")
async def list_calendars(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    calendars = await service.get_calendars(db, user.id)
    return {"calendars": [CalendarInfo(**c) for c in calendars]}


@router.post("/calendars", response_model=CalendarInfo)
@require_module("calendar")
async def create_calendar(
    body: CalendarCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await service.create_calendar(db, user.id, body.name, body.color)
    return CalendarInfo(**result)


@router.patch("/calendars/{calendar_id}", response_model=dict)
@require_module("calendar")
async def update_calendar(
    calendar_id: str,
    body: CalendarUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    ok = await service.update_calendar(db, user.id, calendar_id, updates)
    if not ok:
        raise HTTPException(status_code=404, detail="Calendar not found or no permission")
    return {"ok": True}


@router.delete("/calendars/{calendar_id}", response_model=dict)
@require_module("calendar")
async def delete_calendar(
    calendar_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ok = await service.delete_calendar(db, user.id, calendar_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Calendar not found or no permission")
    return {"ok": True}


# ─── 외부 캘린더 구독(.ics, 설정 › 캘린더) ───


@router.get("/subscriptions", response_model=list[SubscriptionInfo])
@require_module("calendar")
async def list_subscriptions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """본인의 외부 캘린더 구독 — 이름·색·주소·최종 수신 시각·실패 사유."""
    return await subs.list_subscriptions(db, user.id)


@router.post("/subscriptions", response_model=SubscriptionInfo)
@require_module("calendar")
async def create_subscription(
    body: SubscriptionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """iCal(.ics) 주소 구독 — 즉시 1회 수신하여 성공하면 읽기 전용 캘린더로 등록한다.
    http/https(webcal) 만 허용, 내부망·사설 주소는 거부(SSRF 방지), 5MB·20초 제한."""
    try:
        return await subs.subscribe(db, user.id, body.url, body.name, body.color)
    except subs.SubscriptionError as e:
        status = 409 if e.code == "duplicate" else 400
        raise HTTPException(status_code=status, detail={"code": e.code, "message": e.detail})


@router.post("/subscriptions/preview", response_model=SubscriptionPreview)
@require_module("calendar")
async def preview_subscription(
    body: SubscriptionPreviewRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """구독 추가 전에 주소를 사전 조회하여 일정 수·이름을 반환한다(저장하지 않음). 수신 규칙은 구독 추가와 동일하다
    (http/https(webcal) 만 허용, 내부망·사설·루프백·링크 로컬 거부, 5MB·20초). 실패는 400/409 {code, message}."""
    try:
        return await subs.preview(db, user.id, body.url)
    except subs.SubscriptionError as e:
        status = 409 if e.code == "duplicate" else 400
        raise HTTPException(status_code=status, detail={"code": e.code, "message": e.detail})


@router.post("/subscriptions/{calendar_id}/refresh", response_model=SubscriptionInfo)
@require_module("calendar")
async def refresh_subscription(
    calendar_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """즉시 재수신(구독 행 ⋮ "지금 새로 고침"). 실패해도 200 — 응답의 error 에 사유가 기록되고 기존 일정은 유지된다.
    마지막 시도 후 1분 이내에 재호출하면 429 {code: "too_soon", retry_after} (Retry-After 헤더 동일)."""
    cal = await subs.get_owned(db, user.id, calendar_id)
    if not cal:
        raise HTTPException(status_code=404, detail="Subscription not found")
    wait = subs.manual_wait_seconds(cal)
    if wait > 0:
        raise HTTPException(
            status_code=429,
            detail={"code": "too_soon", "message": "조금 전에 새로 받았습니다. 잠시 후 다시 시도하세요", "retry_after": wait},
            headers={"Retry-After": str(wait)},
        )
    return await subs.refresh(db, cal)


# ─── Calendar Sharing ───


@router.get("/calendars/{calendar_id}/shares", response_model=list[CalendarShareInfo])
@require_module("calendar")
async def list_calendar_shares(
    calendar_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    shares = await service.get_calendar_shares(db, user.id, calendar_id)
    return [CalendarShareInfo(**s) for s in shares]


@router.post("/calendars/{calendar_id}/shares", response_model=dict)
@require_module("calendar")
async def set_calendar_shares(
    calendar_id: str,
    body: CalendarShareRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    shares = [s.model_dump() for s in body.shares]
    try:
        ok = await service.share_calendar(db, user.id, calendar_id, shares)
    except ValueError as e:
        # 존재하지 않는 사용자·본인 — 무시하지 않고 오류로 응답(변경 사항 없음)
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="Calendar not found or no permission")
    return {"ok": True}


@router.delete("/calendars/{calendar_id}/shares/{email}", response_model=dict)
@require_module("calendar")
async def remove_calendar_share(
    calendar_id: str,
    email: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ok = await service.unshare_calendar(db, user.id, calendar_id, email)
    if not ok:
        raise HTTPException(status_code=404, detail="Share not found")
    return {"ok": True}


# ─── Events ───


@router.get("/events", response_model=EventListResponse)
@require_module("calendar")
async def list_events(
    start: str | None = Query(None, description="ISO 8601 start date"),
    end: str | None = Query(None, description="ISO 8601 end date"),
    calendar_id: str | None = Query(None),
    include_invited: bool = Query(False, description="초대받은 일정도 포함"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    events = await service.get_events(db, user.id, start, end, calendar_id, include_invited)
    return {"events": [CalendarEvent(**e) for e in events]}


@router.get("/events/{event_id}", response_model=CalendarEvent)
@require_module("calendar")
async def get_event(
    event_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    event = await service.get_event(db, user.id, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return CalendarEvent(**event)


@router.post("/events", response_model=CalendarEvent)
@require_module("calendar")
async def create_event(
    body: EventCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await service.create_event(db, user.id, body.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not result:
        raise HTTPException(status_code=400, detail="Failed to create event")
    return CalendarEvent(**result)


def _parse_occ(occurrence: str | None) -> datetime | None:
    if not occurrence:
        return None
    try:
        return datetime.fromisoformat(occurrence.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="occurrence 는 ISO 8601 이어야 합니다")


async def _resolve_occ(db, event_id: str, occurrence: str | None) -> tuple[str, datetime | None]:
    occ = _parse_occ(occurrence)
    if occ is None and await db.get(CalendarEventDB, event_id) is None:
        split = service.split_occurrence_id(event_id)
        if split:
            return split
    return event_id, occ


@router.patch("/events/{event_id}", response_model=dict)
@require_module("calendar")
async def update_event(
    event_id: str,
    body: EventUpdate,
    occurrence: str | None = Query(None, description="반복 일정의 이 회차만 수정(회차 원래 시작 ISO)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    scope: Annotated[
        Literal["this", "following"] | None,
        Query(description="반복 일정 수정 범위 — this(이 회차만, 기본) · following(이 회차와 이후 모두: 시리즈를 둘로 나눈다)"),
    ] = None,
):
    """일정 수정. 반복 일정의 한 회차만 변경하려면 ?occurrence=<회차 시작> 또는 회차 id
    ('{마스터}_{YYYYmmddTHHMMSS}')로 호출한다 → 회차 예외(RECURRENCE-ID) 행이 생성된다.

    scope=following(+occurrence 또는 회차 id·회차 예외 행 id): 해당 회차부터 끝까지 수정 — 기존 시리즈를 직전에서
    종료하고 새 시리즈를 생성한다(단일 트랜잭션, 응답 id = 새 시리즈). 이후 구간의 삭제된 회차는 새 시리즈에서도 삭제 상태로 유지하고,
    "이 일정만" 수정한 회차는 새 시리즈의 예외로 이전한다(해당 회차가 새 시리즈에 없으면 폐기한다). 횟수 반복은
    규칙을 그대로 전송하면 잔여 회차 수로 축소한다. 첫 회차이면 시리즈 전체 수정.

    전송된 필드만 변경된다. null 을 전송하면 값을 비운다(알림 없음·반복 안 함·반복 종료 없음·설명·장소·시간대·회의 링크).
    제목·시작·끝·종일·캘린더·참석자·상태·exdates 의 null 은 "변경 없음"으로 간주한다(service._apply_fields)."""
    # exclude_none 사용 시 "알림 없음"·"반복 안 함"으로 변경한 null 이 제거되어 저장되지 않았다
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    master_id, occ = await _resolve_occ(db, event_id, occurrence)
    try:
        if scope == "following":
            # 회차 예외 행 id 가 전달되면 마스터·해당 회차의 원래 시작으로 변환(삭제와 동일 규칙)
            row = await db.get(CalendarEventDB, master_id)
            if row is not None and row.parent_event_id:
                if occ is None and row.recurrence_id is not None:
                    occ = row.recurrence_id
                master_id = row.parent_event_id
            if occ is None:
                raise HTTPException(status_code=400, detail="scope=following 은 occurrence 가 필요합니다")
            new_id = await service.update_following(db, user.id, master_id, occ, updates)
            if not new_id:
                raise HTTPException(status_code=404, detail="Event not found or no permission")
            return {"ok": True, "id": new_id}
        if occ is not None:
            new_id = await service.update_occurrence(db, user.id, master_id, occ, updates)
            if not new_id:
                raise HTTPException(status_code=404, detail="Event not found or no permission")
            return {"ok": True, "id": new_id}
        ok = await service.update_event(db, user.id, event_id, updates)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="Event not found or no permission")
    return {"ok": True, "id": event_id}


@router.delete("/events/{event_id}", response_model=dict)
@require_module("calendar")
async def delete_event(
    event_id: str,
    occurrence: str | None = Query(None, description="반복 일정의 이 회차(회차 원래 시작 ISO)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    scope: Annotated[
        Literal["this", "following", "all"] | None,
        Query(description="반복 일정 삭제 범위 — this(이 회차만, EXDATE) · following(이 회차와 이후 모두) · all(반복 전체)"),
    ] = None,
    notify: Annotated[bool, Query(description="참석자에게 취소 알림(인앱 + 취소 메일)")] = False,
):
    """일정 삭제.

    - scope 없음: 기존 동작 유지 — ?occurrence= 또는 회차 id 이면 해당 회차만(EXDATE), 아니면 일정/시리즈 전체.
    - scope=this: 해당 회차만. occurrence(또는 회차 id) 필요. 회차 예외 행 id 이면 해당 행을 삭제하고 EXDATE 로 기록한다.
    - scope=following: 해당 회차부터 끝까지(규칙을 직전에서 종료하고 이후 예외 행 정리). 첫 회차이면 전체 삭제.
    - scope=all: 시리즈 전체(회차 id·예외 행 id 를 지정해도 마스터까지 삭제).
    notify=true 이면 본인을 제외한 참석자에게 취소 알림 — 응답 notified = 알림 대상자 수.
    """
    master_id, occ = await _resolve_occ(db, event_id, occurrence)
    row = await db.get(CalendarEventDB, master_id)
    # 회차 예외 행 id 가 전달되면 마스터·해당 회차 시작으로 변환하여 범위 삭제로 처리
    if row is not None and row.parent_event_id and scope in ("following", "all"):
        if occ is None and row.recurrence_id is not None:
            occ = row.recurrence_id
        master_id = row.parent_event_id

    targets_id = master_id if scope in ("following", "all") or occ is not None else event_id
    ev, attendees = await service.cancellation_targets(db, user, targets_id) if notify else (None, [])

    if scope == "following":
        if occ is None:
            raise HTTPException(status_code=400, detail="scope=following 은 occurrence 가 필요합니다")
        ok = await service.delete_following(db, user.id, master_id, occ)
    elif scope == "all":
        ok = await service.delete_event(db, user.id, master_id)
    elif occ is not None:
        ok = await service.delete_occurrence(db, user.id, master_id, occ)
    else:
        ok = await service.delete_event(db, user.id, event_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Event not found or no permission")
    notified = 0
    if notify and ev is not None:
        notified = await service.notify_cancellation(db, user, ev, attendees, scope or ("this" if occ else "all"), occ)
    return {"ok": True, "notified": notified}


# ─── 참석 응답 · 빈 시간 ───


@router.post("/events/{event_id}/rsvp", response_model=dict)
@require_module("calendar")
async def rsvp_event(
    event_id: str,
    body: RsvpRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """참석자 본인의 응답(accepted|declined|tentative|needs-action). 참석자가 아니면 404."""
    try:
        result = await service.rsvp(db, user, event_id, body.response)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not result:
        raise HTTPException(status_code=404, detail="초대받은 일정이 아닙니다")
    return {"ok": True, **result}


@router.get("/freebusy", response_model=dict)
@require_module("calendar")
async def get_freebusy(
    emails: str = Query(..., description="쉼표로 구분한 이메일(최대 50)"),
    start: str = Query(...),
    end: str = Query(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """워크스페이스 사용자의 바쁜 구간(내용 제외, 시각만). 미등록 이메일은 known=false."""
    try:
        items = await service.freebusy(db, [e for e in emails.split(",") if e.strip()], start, end)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"start": start, "end": end, "users": items}


# ─── .ics 가져오기 / 내보내기 ───


def _ics_response(name: str, body: str) -> Response:
    fname = (name or "calendar").replace("/", "_")[:100] + ".ics"
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename=\"calendar.ics\"; filename*=UTF-8''{quote(fname)}"
        },
    )


@router.get("/calendars/{calendar_id}/export.ics")
@require_module("calendar")
async def export_calendar(
    calendar_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    res = await service.export_calendar_ics(db, user.id, calendar_id)
    if not res:
        raise HTTPException(status_code=404, detail="Calendar not found or no permission")
    return _ics_response(*res)


@router.get("/events/{event_id}/export.ics")
@require_module("calendar")
async def export_event(
    event_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    res = await service.export_event_ics(db, user.id, event_id)
    if not res:
        raise HTTPException(status_code=404, detail="Event not found")
    return _ics_response(*res)


_ICS_MAX_BYTES = 10 * 1024 * 1024


@router.post("/calendars/{calendar_id}/import", response_model=dict)
@require_module("calendar")
async def import_calendar(
    calendar_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """.ics 업로드 → 해당 캘린더로 가져오기. 동일 UID 는 덮어쓴다. 응답: {created, updated, skipped}"""
    raw = await file.read(_ICS_MAX_BYTES + 1)
    if len(raw) > _ICS_MAX_BYTES:
        raise HTTPException(status_code=413, detail="파일이 너무 큽니다(10MB)")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp949", errors="replace")
    try:
        res = await service.import_ics(db, user.id, calendar_id, text)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if res is None:
        raise HTTPException(status_code=404, detail="Calendar not found or no permission")
    return {"ok": True, **res}
