"""외부 캘린더 구독(.ics) — 주소 검사(SSRF) · 수신 제한 · 일정 동기화 · 읽기 전용."""

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select

from app.calendar import service
from app.calendar import subscriptions as subs
from app.db.models import CalendarDB, CalendarEventAttendee, CalendarEventDB, User

UTC = timezone.utc

ICS_V1 = """BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:대한민국 공휴일
BEGIN:VEVENT
UID:hangul@x
DTSTART;VALUE=DATE:20261009
DTEND;VALUE=DATE:20261010
SUMMARY:한글날
ATTENDEE:mailto:owner@x.io
BEGIN:VALARM
TRIGGER:-PT10M
ACTION:DISPLAY
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:foundation@x
DTSTART;VALUE=DATE:20261003
DTEND;VALUE=DATE:20261004
SUMMARY:개천절
END:VEVENT
END:VCALENDAR
"""

ICS_V2 = """BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:hangul@x
DTSTART;VALUE=DATE:20261009
DTEND;VALUE=DATE:20261010
SUMMARY:한글날(대체)
END:VEVENT
END:VCALENDAR
"""


# ── 주소 검사 ──


@pytest.mark.parametrize("raw,want", [
    ("https://calendar.example.com/a.ics", "https://calendar.example.com/a.ics"),
    ("webcal://calendar.example.com/a.ics", "https://calendar.example.com/a.ics"),
    ("  http://example.com  ", "http://example.com/"),
])
def test_normalize_ok(raw, want):
    assert subs.normalize_url(raw) == want


@pytest.mark.parametrize("raw,code", [
    ("", "invalid_url"),
    ("ftp://example.com/a.ics", "scheme"),
    ("file:///etc/passwd", "scheme"),
    ("gopher://example.com", "scheme"),
    ("https://user:pw@example.com/a.ics", "invalid_url"),
    ("https:///a.ics", "invalid_url"),
    ("https://example.com:99999/a.ics", "invalid_url"),
    ("https://example.com/" + "a" * 1000, "invalid_url"),
])
def test_normalize_rejects(raw, code):
    with pytest.raises(subs.SubscriptionError) as e:
        subs.normalize_url(raw)
    assert e.value.code == code


@pytest.mark.parametrize("ip,ok", [
    ("8.8.8.8", True),
    ("2606:4700:4700::1111", True),
    ("127.0.0.1", False),
    ("10.0.0.5", False),
    ("172.16.3.4", False),
    ("192.168.10.1", False),
    ("169.254.169.254", False),   # 클라우드 메타데이터
    ("100.64.0.1", False),        # CGNAT
    ("0.0.0.0", False),
    ("::1", False),
    ("fe80::1", False),
    ("fc00::1", False),
    ("::ffff:10.0.0.1", False),   # IPv4-mapped 사설
    ("::ffff:8.8.8.8", True),
    ("224.0.0.1", False),
    ("not-an-ip", False),
])
def test_ip_allowed(ip, ok):
    assert subs.ip_allowed(ip) is ok


@pytest.mark.asyncio
async def test_resolve_blocks_private_and_mixed(monkeypatch):
    import asyncio

    async def fake_gai(host, port, type=0):
        table = {
            "inside.example": ["10.1.2.3"],
            "mixed.example": ["8.8.8.8", "192.168.1.1"],   # 하나라도 사설이면 거부
            "public.example": ["8.8.8.8"],
        }
        return [(2, 1, 6, "", (ip, port)) for ip in table[host]]

    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "getaddrinfo", fake_gai)
    for host in ("inside.example", "mixed.example", "127.0.0.1", "169.254.169.254"):
        with pytest.raises(subs.SubscriptionError) as e:
            await subs.resolve_public(host, 443)
        assert e.value.code == "blocked"
    assert await subs.resolve_public("public.example", 443) == ["8.8.8.8"]


# ── 수신(가짜 전송) ──


def _public_dns(monkeypatch, table: dict[str, str]):
    async def fake_resolve(host, port):
        ip = table.get(host, host)
        if not subs.ip_allowed(ip):
            raise subs.SubscriptionError("blocked", "blocked")
        return [ip]
    monkeypatch.setattr(subs, "resolve_public", fake_resolve)


@pytest.mark.asyncio
async def test_fetch_ok_pins_ip_and_keeps_host(monkeypatch):
    _public_dns(monkeypatch, {"cal.example.com": "93.184.216.34"})
    seen = {}

    def handler(req: httpx.Request):
        seen["url"] = str(req.url)
        seen["host"] = req.headers.get("host")
        seen["sni"] = req.extensions.get("sni_hostname")
        return httpx.Response(200, text=ICS_V1)

    got = await subs.fetch_ics("https://cal.example.com/h.ics", transport=httpx.MockTransport(handler))
    assert "BEGIN:VCALENDAR" in got.text
    assert seen["url"].startswith("https://93.184.216.34/")   # 검사한 IP 로 직접 접속(리바인딩 차단)
    assert seen["host"] == "cal.example.com"
    assert seen["sni"] == "cal.example.com"


@pytest.mark.asyncio
async def test_fetch_redirect_to_private_blocked(monkeypatch):
    _public_dns(monkeypatch, {"cal.example.com": "93.184.216.34", "internal.example.com": "10.0.0.7"})

    def handler(req: httpx.Request):
        return httpx.Response(302, headers={"location": "http://internal.example.com/secret"})

    with pytest.raises(subs.SubscriptionError) as e:
        await subs.fetch_ics("https://cal.example.com/h.ics", transport=httpx.MockTransport(handler))
    assert e.value.code == "blocked"


@pytest.mark.asyncio
async def test_fetch_redirect_scheme_blocked(monkeypatch):
    _public_dns(monkeypatch, {"cal.example.com": "93.184.216.34"})

    def handler(req: httpx.Request):
        return httpx.Response(301, headers={"location": "file:///etc/passwd"})

    with pytest.raises(subs.SubscriptionError) as e:
        await subs.fetch_ics("https://cal.example.com/h.ics", transport=httpx.MockTransport(handler))
    assert e.value.code == "scheme"


@pytest.mark.asyncio
async def test_fetch_status_size_and_format(monkeypatch):
    _public_dns(monkeypatch, {"cal.example.com": "93.184.216.34"})

    async def run(resp):
        with pytest.raises(subs.SubscriptionError) as e:
            await subs.fetch_ics("https://cal.example.com/h.ics", transport=httpx.MockTransport(lambda r: resp))
        return e.value.code

    assert await run(httpx.Response(404)) == "404"
    assert await run(httpx.Response(200, text="<html>not a calendar</html>")) == "not_ics"
    big = "BEGIN:VCALENDAR\n" + "X" * (subs.MAX_BYTES + 10)
    assert await run(httpx.Response(200, text=big)) == "too_large"
    assert await run(httpx.Response(200, headers={"content-length": str(subs.MAX_BYTES + 1)}, text="BEGIN:VCALENDAR")) == "too_large"


@pytest.mark.asyncio
async def test_fetch_too_many_redirects(monkeypatch):
    _public_dns(monkeypatch, {"cal.example.com": "93.184.216.34"})

    def handler(req: httpx.Request):
        return httpx.Response(302, headers={"location": "https://cal.example.com/again"})

    with pytest.raises(subs.SubscriptionError) as e:
        await subs.fetch_ics("https://cal.example.com/h.ics", transport=httpx.MockTransport(handler))
    assert e.value.code == "network"


# ── 구독 · 동기화 · 읽기 전용 ──


async def _seed(db):
    db.add(User(id="owner", username="owner", email="owner@x.io", password_hash="x"))
    db.add(User(id="other", username="other", email="other@x.io", password_hash="x"))
    await db.commit()


def _fake_fetch(texts: list[str | Exception]):
    async def fetch(url):
        v = texts.pop(0)
        if isinstance(v, Exception):
            raise v
        return subs.Fetched(text=v, final_url=url)
    return fetch


async def _titles(db, cal_id):
    rows = (await db.execute(select(CalendarEventDB).where(CalendarEventDB.calendar_id == cal_id))).scalars().all()
    return sorted(r.title for r in rows)


@pytest.mark.asyncio
async def test_subscribe_sync_and_readonly(db_session):
    db = db_session
    await _seed(db)
    texts: list = [ICS_V1]
    r = await subs.subscribe(db, "owner", "webcal://cal.example.com/h.ics", None, None, fetch=_fake_fetch(texts))
    assert r["name"] == "대한민국 공휴일"        # X-WR-CALNAME
    assert r["url"] == "https://cal.example.com/h.ics"
    assert r["fetched_at"] and r["error"] is None
    cal_id = r["id"]
    assert await _titles(db, cal_id) == ["개천절", "한글날"]

    # 참석자·알림은 폐기(내부 사용자 이메일이어도 초대로 표시되지 않도록)
    att = (await db.execute(select(CalendarEventAttendee))).scalars().all()
    assert att == []
    evs = (await db.execute(select(CalendarEventDB).where(CalendarEventDB.calendar_id == cal_id))).scalars().all()
    assert all(e.reminder_minutes is None for e in evs)

    # 목록: 구독은 읽기 전용 + 표시
    cals = await service.get_calendars(db, "owner")
    sub = next(c for c in cals if c["id"] == cal_id)
    assert sub["is_subscription"] is True and sub["can_write"] is False
    # 쓰기 가능한 기본 캘린더도 생성됨(구독만 있으면 일정을 생성할 캘린더가 없으므로)
    assert any(c["can_write"] for c in cals)

    # 읽기 전용 — 일정 생성·.ics 가져오기 차단
    cal = await db.get(CalendarDB, cal_id)
    assert await service._can_write_calendar(db, "owner", cal) is False
    assert await service.import_ics(db, "owner", cal_id, ICS_V2) is None

    # 재수신: 동일 UID 는 덮어쓰고 없어진 항목은 삭제
    cal.source_fetched_at = None
    await db.commit()
    r2 = await subs.refresh(db, cal, fetch=_fake_fetch([ICS_V2]))
    assert r2["error"] is None and r2["fetched_at"]
    assert await _titles(db, cal_id) == ["한글날(대체)"]

    # 실패 시 기존 일정은 유지하고 사유만 기록
    r3 = await subs.refresh(db, await db.get(CalendarDB, cal_id), fetch=_fake_fetch([subs.SubscriptionError("404")]))
    assert r3["error"] == "404"
    assert r3["fetched_at"] == r2["fetched_at"]
    assert await _titles(db, cal_id) == ["한글날(대체)"]

    # 목록·소유 확인
    assert [s["id"] for s in await subs.list_subscriptions(db, "owner")] == [cal_id]
    assert await subs.list_subscriptions(db, "other") == []
    assert await subs.get_owned(db, "other", cal_id) is None


@pytest.mark.asyncio
async def test_subscribe_duplicate_limit_and_failure(db_session, monkeypatch):
    db = db_session
    await _seed(db)
    await subs.subscribe(db, "owner", "https://cal.example.com/a.ics", "A", "#22c55e", fetch=_fake_fetch([ICS_V2]))
    with pytest.raises(subs.SubscriptionError) as e:
        await subs.subscribe(db, "owner", "https://cal.example.com/a.ics", None, None, fetch=_fake_fetch([ICS_V2]))
    assert e.value.code == "duplicate"
    # 수신 실패 시 캘린더를 생성하지 않음
    with pytest.raises(subs.SubscriptionError):
        await subs.subscribe(db, "owner", "https://cal.example.com/b.ics", None, None,
                             fetch=_fake_fetch([subs.SubscriptionError("timeout")]))
    assert len(await subs.list_subscriptions(db, "owner")) == 1
    monkeypatch.setattr(subs, "MAX_PER_USER", 1)
    with pytest.raises(subs.SubscriptionError) as e:
        await subs.subscribe(db, "owner", "https://cal.example.com/c.ics", None, None, fetch=_fake_fetch([ICS_V2]))
    assert e.value.code == "too_many"


@pytest.mark.asyncio
async def test_due_ids(db_session):
    db = db_session
    await _seed(db)
    now = datetime(2026, 10, 17, 12, tzinfo=UTC)
    db.add(CalendarDB(id="fresh", user_id="owner", name="f", source_url="https://a/x.ics", source_checked_at=now - timedelta(hours=1)))
    db.add(CalendarDB(id="stale", user_id="owner", name="s", source_url="https://a/y.ics", source_checked_at=now - timedelta(hours=7)))
    db.add(CalendarDB(id="never", user_id="owner", name="n", source_url="https://a/z.ics"))
    db.add(CalendarDB(id="mine", user_id="owner", name="내 캘린더"))
    await db.commit()
    assert set(await subs.due_ids(db, now)) == {"stale", "never"}


# ── 지금 새로 고침(구독 행 ⋮) — 1분 최소 간격 ──


def test_manual_wait_seconds():
    now = datetime(2026, 10, 17, 12, tzinfo=UTC)
    assert subs.manual_wait_seconds(CalendarDB(source_checked_at=None), now) == 0
    assert subs.manual_wait_seconds(CalendarDB(source_checked_at=now - timedelta(seconds=10)), now) == 50
    assert subs.manual_wait_seconds(CalendarDB(source_checked_at=now - timedelta(minutes=1)), now) == 0
    assert subs.manual_wait_seconds(CalendarDB(source_checked_at=now - timedelta(hours=2)), now) == 0
    # tz 없는 값(SQLite 등)은 UTC 로 간주
    naive = (now - timedelta(seconds=30)).replace(tzinfo=None)
    assert subs.manual_wait_seconds(CalendarDB(source_checked_at=naive), now) == 30


@pytest.mark.asyncio
async def test_refresh_endpoint_rate_limited(db_session, monkeypatch):
    from fastapi import HTTPException

    from app.calendar import router as cal_router

    db = db_session
    await _seed(db)
    owner = await db.get(User, "owner")
    db.add(CalendarDB(id="sub1", user_id="owner", name="s", source_url="https://cal.example.com/a.ics",
                      source_checked_at=datetime.now(UTC) - timedelta(seconds=5)))
    await db.commit()

    calls: list[str] = []

    async def fake_refresh(_db, cal, **_kw):
        calls.append(cal.id)
        return subs.to_dict(cal)

    monkeypatch.setattr(subs, "refresh", fake_refresh)

    with pytest.raises(HTTPException) as e:
        await cal_router.refresh_subscription(calendar_id="sub1", user=owner, db=db)
    assert e.value.status_code == 429
    assert e.value.detail["code"] == "too_soon"
    assert 1 <= e.value.detail["retry_after"] <= 60
    assert e.value.headers["Retry-After"] == str(e.value.detail["retry_after"])
    assert calls == []

    cal = await db.get(CalendarDB, "sub1")
    cal.source_checked_at = datetime.now(UTC) - timedelta(minutes=2)
    await db.commit()
    out = await cal_router.refresh_subscription(calendar_id="sub1", user=owner, db=db)
    assert out["id"] == "sub1" and calls == ["sub1"]

    # 타 사용자의 구독은 404
    other = await db.get(User, "other")
    with pytest.raises(HTTPException) as e2:
        await cal_router.refresh_subscription(calendar_id="sub1", user=other, db=db)
    assert e2.value.status_code == 404
