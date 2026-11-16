"""외부 캘린더 구독(.ics) — 설정 › 캘린더 "외부 캘린더 구독" 카드.

iCal(.ics) 주소를 읽기 전용 캘린더로 등록하고 6시간마다 재수신한다.

- 구독 = calendars 행 + source_url. 해당 캘린더는 읽기 전용이다
  (service._can_write_calendar 가 차단하고, CalDAV PUT/DELETE 도 403).
- 수신(fetch_ics)은 서버가 사용자를 대신해 외부 주소에 접속하는 동작이므로 SSRF 를 차단한다.
    · http/https 만 허용(webcal:// 은 https 로 변환하여 수신한다 — 동일 대상의 별칭)
    · 주소의 호스트를 직접 해석하여 **모든** 주소가 공인(global) 이어야 한다. 사설·루프백·링크 로컬·
      CGNAT·예약·멀티캐스트는 거부한다. 해석해 둔 IP 로 직접 접속하여(호스트 헤더·SNI 는 원래 이름)
      검사와 접속 사이에 DNS 가 변경되는 리바인딩을 차단한다.
    · 리다이렉트는 3회까지 허용하며, 매회 동일한 검사를 재수행한다.
    · 응답 5MB · 접속 5초 · 전체 20초 제한. 자격 증명이 포함된 주소(user:pass@)는 거부한다.
- 동기화(sync_events)는 UID 기준 덮어쓰기 + 이번 수신에 없는 일정 삭제. 참석자·알림은 제거한다
  (외부 일정의 참석자 이메일이 본 서비스 사용자와 일치할 때 초대로 표시되는 것을 방지하고, 외부 일정의 알림을 발송하지 않는다).
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CalendarDB, CalendarEventDB

logger = logging.getLogger(__name__)

REFRESH_EVERY = timedelta(hours=6)
# "지금 새로 고침"(구독 행 ⋮) 최소 간격 — 남용에 의한 외부 주소 반복 요청 방지. 마지막 시도(checked_at) 기준
MANUAL_MIN_INTERVAL = timedelta(minutes=1)
MAX_BYTES = 5 * 1024 * 1024
CONNECT_TIMEOUT = 5.0
TOTAL_TIMEOUT = 20.0
MAX_REDIRECTS = 3
MAX_EVENTS = 5000
MAX_PER_USER = 20
MAX_URL_LEN = 1000


class SubscriptionError(Exception):
    """수신 실패. code 는 화면에 그대로 표시되는 짧은 사유(HTTP 상태 숫자 또는 아래 이름)."""

    # 이름이 있는 사유: invalid_url · scheme · blocked · dns · timeout · too_large · network · not_ics · too_many
    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail or code


# ── 주소 검사 ──


def normalize_url(raw: str) -> str:
    """사용자가 입력한 주소를 수신용 주소로 변환한다. 규칙 위반 시 SubscriptionError."""
    url = (raw or "").strip()
    if not url or len(url) > MAX_URL_LEN:
        raise SubscriptionError("invalid_url", "주소가 비었거나 너무 깁니다")
    if url.lower().startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise SubscriptionError("scheme", "http·https(또는 webcal) 주소만 구독할 수 있습니다")
    if not parts.hostname:
        raise SubscriptionError("invalid_url", "주소에 호스트가 없습니다")
    if parts.username or parts.password:
        raise SubscriptionError("invalid_url", "아이디·비밀번호가 포함된 주소는 사용할 수 없습니다")
    try:
        port = parts.port
    except ValueError:
        raise SubscriptionError("invalid_url", "포트가 올바르지 않습니다")
    if port is not None and not (1 <= port <= 65535):
        raise SubscriptionError("invalid_url", "포트가 올바르지 않습니다")
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))


def ip_allowed(ip: str) -> bool:
    """인터넷 공인 주소만 허용. IPv4 를 내장한 IPv6(::ffff:10.0.0.1 등)는 내부 IPv4 로 판정한다."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address):
        inner = addr.ipv4_mapped or addr.sixtofour or (addr.teredo[1] if addr.teredo else None)
        if inner is not None:
            addr = inner
    if (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast
            or addr.is_reserved or addr.is_unspecified):
        return False
    return addr.is_global


async def resolve_public(host: str, port: int) -> list[str]:
    """호스트를 해석하여 공인 주소 목록을 반환한다. 하나라도 사설이면 거부(혼합 응답을 이용한 리바인딩 수법 차단)."""
    # IP 를 직접 기재한 주소
    try:
        ipaddress.ip_address(host)
        literal = [host]
    except ValueError:
        literal = None
    if literal is not None:
        ips = literal
    else:
        loop = asyncio.get_running_loop()
        try:
            infos = await asyncio.wait_for(
                loop.getaddrinfo(host, port, type=socket.SOCK_STREAM), timeout=CONNECT_TIMEOUT,
            )
        except (socket.gaierror, asyncio.TimeoutError, OSError):
            raise SubscriptionError("dns", "주소의 호스트를 찾을 수 없습니다")
        ips = list(dict.fromkeys(i[4][0] for i in infos))
    if not ips:
        raise SubscriptionError("dns", "주소의 호스트를 찾을 수 없습니다")
    if not all(ip_allowed(ip) for ip in ips):
        raise SubscriptionError("blocked", "내부망·사설 주소는 구독할 수 없습니다")
    return ips


# ── 수신 ──


@dataclass
class Fetched:
    text: str
    final_url: str


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp949", errors="replace")


async def _get_once(client: httpx.AsyncClient, url: str) -> tuple[int, dict, bytes]:
    parts = urlsplit(url)
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    ips = await resolve_public(host, port)
    ip = ips[0]
    ip_host = f"[{ip}]" if ":" in ip else ip
    netloc = f"{ip_host}:{parts.port}" if parts.port else ip_host
    pinned = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
    host_header = parts.netloc.rsplit("@", 1)[-1]
    req = client.build_request(
        "GET", pinned,
        headers={"Host": host_header, "Accept": "text/calendar, text/plain;q=0.8, */*;q=0.1",
                 "User-Agent": "JustWorkspace-Calendar/1.0"},
        # TLS 는 원래 이름으로 수행(SNI·인증서 검증) — IP 로 접속해도 인증서는 호스트 이름과 대조
        extensions={"sni_hostname": host} if parts.scheme == "https" else {},
    )
    resp = await client.send(req, stream=True)
    try:
        if resp.status_code in (301, 302, 303, 307, 308):
            return resp.status_code, dict(resp.headers), b""
        if resp.status_code != 200:
            return resp.status_code, dict(resp.headers), b""
        declared = resp.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BYTES:
            raise SubscriptionError("too_large", "파일이 너무 큽니다(5MB)")
        buf = bytearray()
        async for chunk in resp.aiter_bytes():
            buf.extend(chunk)
            if len(buf) > MAX_BYTES:
                raise SubscriptionError("too_large", "파일이 너무 큽니다(5MB)")
        return 200, dict(resp.headers), bytes(buf)
    finally:
        await resp.aclose()


async def fetch_ics(raw_url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> Fetched:
    """주소에서 .ics 본문을 수신한다. 실패 시 SubscriptionError(code=HTTP 상태 또는 사유)."""
    url = normalize_url(raw_url)
    timeout = httpx.Timeout(TOTAL_TIMEOUT, connect=CONNECT_TIMEOUT)

    async def run() -> Fetched:
        nonlocal url
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=transport,
                                     trust_env=False) as client:
            for _ in range(MAX_REDIRECTS + 1):
                status, headers, body = await _get_once(client, url)
                if status in (301, 302, 303, 307, 308):
                    loc = headers.get("location") or headers.get("Location")
                    if not loc:
                        raise SubscriptionError(str(status), "리다이렉트 주소가 없습니다")
                    url = normalize_url(urljoin(url, loc))
                    continue
                if status != 200:
                    raise SubscriptionError(str(status), f"서버가 {status} 로 응답했습니다")
                text = _decode(body)
                if "BEGIN:VCALENDAR" not in text[:4096].upper():
                    raise SubscriptionError("not_ics", "iCalendar(.ics) 형식이 아닙니다")
                return Fetched(text=text, final_url=url)
            raise SubscriptionError("network", "리다이렉트가 너무 많습니다")

    try:
        return await asyncio.wait_for(run(), timeout=TOTAL_TIMEOUT)
    except SubscriptionError:
        raise
    except (asyncio.TimeoutError, httpx.TimeoutException):
        raise SubscriptionError("timeout", "응답이 지연되고 있습니다")
    except httpx.HTTPError as e:
        raise SubscriptionError("network", f"접속하지 못했습니다: {type(e).__name__}")


def calendar_name_of(text: str) -> str | None:
    """X-WR-CALNAME(있으면) — 구독 이름 기본값."""
    for line in text.splitlines()[:200]:
        if line.upper().startswith("X-WR-CALNAME"):
            _, _, v = line.partition(":")
            v = v.strip()
            if v:
                return v[:100]
    return None


# ── 동기화 ──


def _strip_bundle(b: dict) -> dict:
    """구독 일정은 참석자·알림을 제거한다."""
    def clean(d: dict) -> dict:
        d = dict(d)
        d["attendees"] = []
        d.pop("reminder_minutes", None)
        return d
    return {
        "master": clean(b["master"]) if b.get("master") else None,
        "overrides": [clean(o) for o in (b.get("overrides") or [])],
    }


async def sync_events(db: AsyncSession, cal: CalendarDB, text: str) -> dict:
    """수신한 .ics 로 해당 캘린더의 일정을 동기화한다 — UID 가 같으면 덮어쓰고, 이번 수신에 없는 일정은 삭제한다."""
    from app.calendar import service
    from app.dav.ical_utils import ical_to_event_bundles

    bundles = ical_to_event_bundles(text)
    if bundles is None:
        raise SubscriptionError("not_ics", "iCalendar(.ics) 형식이 아닙니다")
    existing_rows = (
        await db.execute(
            select(CalendarEventDB.id, CalendarEventDB.ical_uid).where(
                CalendarEventDB.calendar_id == cal.id,
                CalendarEventDB.parent_event_id.is_(None),
            )
        )
    ).all()
    by_uid = {uid: eid for eid, uid in existing_rows if uid}
    kept: set[str] = set()
    created = updated = skipped = 0
    for b in bundles[:MAX_EVENTS]:
        if b.get("master") is None:
            skipped += 1
            continue
        b = _strip_bundle(b)
        uid = b["master"].get("uid")
        existing_id = by_uid.get(uid) if uid and not uid.startswith("__anon_") else None
        try:
            ev = await service.save_ical_bundle(db, cal.id, b, event_id=existing_id)
        except Exception as e:  # noqa: BLE001 — 일정 하나가 손상되어도 나머지는 수신
            logger.debug("구독 일정 저장 실패(%s): %s", cal.id, e)
            await db.rollback()
            skipped += 1
            continue
        kept.add(ev.id)
        if existing_id:
            updated += 1
        else:
            created += 1
    skipped += max(0, len(bundles) - MAX_EVENTS)
    stale_ids = [eid for eid, _uid in existing_rows if eid not in kept]
    removed = 0
    if stale_ids:
        rows = (
            await db.execute(
                select(CalendarEventDB).where(
                    (CalendarEventDB.id.in_(stale_ids)) | (CalendarEventDB.parent_event_id.in_(stale_ids))
                )
            )
        ).scalars().all()
        for r in rows:
            await db.delete(r)
        removed = len(stale_ids)
        await db.commit()
    return {"created": created, "updated": updated, "removed": removed, "skipped": skipped}


# ── 서비스 ──


def to_dict(cal: CalendarDB) -> dict:
    return {
        "id": cal.id,
        "name": cal.name,
        "color": cal.color,
        "url": cal.source_url,
        "fetched_at": cal.source_fetched_at.isoformat() if cal.source_fetched_at else None,
        "checked_at": cal.source_checked_at.isoformat() if cal.source_checked_at else None,
        "error": cal.source_error,
        "is_visible": cal.is_visible,
    }


async def list_subscriptions(db: AsyncSession, user_id: str) -> list[dict]:
    rows = (
        await db.execute(
            select(CalendarDB)
            .where(CalendarDB.user_id == user_id, CalendarDB.source_url.is_not(None))
            .order_by(CalendarDB.created_at)
        )
    ).scalars().all()
    return [to_dict(c) for c in rows]


def manual_wait_seconds(cal: CalendarDB, now: datetime | None = None) -> int:
    """수동 새로 고침이 가능해질 때까지 남은 초(0 이면 즉시 가능). 마지막 시도가 1분 이내이면 대기 필요."""
    last = cal.source_checked_at
    if last is None:
        return 0
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    left = (last + MANUAL_MIN_INTERVAL - now).total_seconds()
    return max(0, int(left + 0.999))


async def refresh(db: AsyncSession, cal: CalendarDB, *, fetch=fetch_ics) -> dict:
    """구독 하나를 즉시 재수신한다. 실패해도 예외를 발생시키지 않고 source_error 에 기록하며 기존 일정은 유지한다."""
    now = datetime.now(timezone.utc)
    cal_id = cal.id
    try:
        got = await fetch(cal.source_url or "")
        await sync_events(db, cal, got.text)
        cal = await db.get(CalendarDB, cal_id) or cal
        cal.source_fetched_at = now
        cal.source_error = None
    except SubscriptionError as e:
        await db.rollback()
        cal = await db.get(CalendarDB, cal_id) or cal
        cal.source_error = e.code[:200]
    cal.source_checked_at = now
    await db.commit()
    await db.refresh(cal)
    return to_dict(cal)


async def subscribe(
    db: AsyncSession, user_id: str, url: str, name: str | None, color: str | None, *, fetch=fetch_ics,
) -> dict:
    """구독 추가 — 먼저 수신을 시도하고(실패 시 SubscriptionError) 캘린더를 생성한다."""
    norm = normalize_url(url)
    mine = (
        await db.execute(
            select(CalendarDB.source_url).where(
                CalendarDB.user_id == user_id, CalendarDB.source_url.is_not(None),
            )
        )
    ).scalars().all()
    if len(mine) >= MAX_PER_USER:
        raise SubscriptionError("too_many", f"구독은 {MAX_PER_USER}개까지입니다")
    if norm in mine:
        raise SubscriptionError("duplicate", "이미 구독한 주소입니다")
    got = await fetch(norm)
    title = (name or "").strip()[:100] or calendar_name_of(got.text) or (urlsplit(norm).hostname or "구독")[:100]
    cal = CalendarDB(user_id=user_id, name=title, color=color or "#64748b", source_url=norm)
    db.add(cal)
    await db.commit()
    await db.refresh(cal)
    now = datetime.now(timezone.utc)
    try:
        await sync_events(db, cal, got.text)
        cal = await db.get(CalendarDB, cal.id) or cal
        cal.source_fetched_at = now
        cal.source_error = None
    except SubscriptionError as e:
        cal.source_error = e.code
    cal.source_checked_at = now
    await db.commit()
    await db.refresh(cal)
    return to_dict(cal)


async def preview(db: AsyncSession, user_id: str, url: str, *, fetch=fetch_ics) -> dict:
    """구독 추가 모달의 "읽음 · 일정 n개" 확인 줄 — 주소를 사전 수신하여 일정 수·이름만 반환한다(저장하지 않음).

    수신은 subscribe 와 동일한 fetch_ics 를 사용한다(SSRF 검사·크기·시간 제한 동일)."""
    from app.dav.ical_utils import ical_to_event_bundles

    norm = normalize_url(url)
    mine = (
        await db.execute(
            select(CalendarDB.source_url).where(
                CalendarDB.user_id == user_id, CalendarDB.source_url.is_not(None),
            )
        )
    ).scalars().all()
    if norm in mine:
        raise SubscriptionError("duplicate", "이미 구독한 주소입니다")
    got = await fetch(norm)
    bundles = ical_to_event_bundles(got.text)
    if bundles is None:
        raise SubscriptionError("not_ics", "iCalendar(.ics) 형식이 아닙니다")
    masters = [b["master"] for b in bundles if b.get("master") is not None]
    years = sorted({m["start"].year for m in masters if getattr(m.get("start"), "year", None)})
    return {
        "url": norm,
        "name": calendar_name_of(got.text),
        "count": len(masters),
        # 확인 줄 오른쪽 "2026–2027" — 일정 시작 연도의 최초·최종 값(일정이 없으면 null)
        "first_year": years[0] if years else None,
        "last_year": years[-1] if years else None,
    }


async def get_owned(db: AsyncSession, user_id: str, cal_id: str) -> CalendarDB | None:
    cal = await db.get(CalendarDB, cal_id)
    if not cal or cal.user_id != user_id or not cal.source_url:
        return None
    return cal


async def due_ids(db: AsyncSession, now: datetime | None = None, limit: int = 50) -> list[str]:
    """재수신 시점이 도래한 구독(마지막 시도가 6시간 전보다 이전인 것)의 id."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - REFRESH_EVERY
    rows = (
        await db.execute(
            select(CalendarDB.id)
            .where(
                CalendarDB.source_url.is_not(None),
                (CalendarDB.source_checked_at.is_(None)) | (CalendarDB.source_checked_at < cutoff),
            )
            .order_by(CalendarDB.source_checked_at.asc().nulls_first())
            .limit(limit)
        )
    ).scalars().all()
    return list(rows)


async def refresh_due(session_factory) -> int:
    """1주기 — 시점이 도래한 구독을 순차 수신한다. 수신한 개수를 반환한다."""
    async with session_factory() as db:
        ids = await due_ids(db)
    n = 0
    for cid in ids:
        try:
            async with session_factory() as db:
                cal = await db.get(CalendarDB, cid)
                if cal and cal.source_url:
                    await refresh(db, cal)
                    n += 1
        except Exception as e:  # noqa: BLE001
            logger.warning("캘린더 구독 갱신 실패(%s): %s", cid, e)
    return n
