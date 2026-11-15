"""셸·통화 범위 백엔드.

- 공개 서비스 상태: 내부 이름·주소·버전 없이 묶음 key·상태·응답 ms 만, 인증 불요.
- 오피스 글자 미리보기 생략 요소 수("[표 1개 · 이미지 2개 생략됨]").
- 회의 종료 요약("이번 회의") — 볼 수 있는 사람만.
- 대기실 신청 → 호스트 활동 패널 알림([들이기][거절] 행동).
"""

import io
import json
import os
import sys
import types
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

from app.db.models import Base, Channel, MeetingDB, MeetingInvitee, Notification, NotificationPref, User  # noqa: E402
from app.files import preview as pv  # noqa: E402
from app.meetings import repo  # noqa: E402
from app.meetings import router as mr  # noqa: E402
from app.meetings import store  # noqa: E402
from app.meetings.schemas import JoinRequestCreate  # noqa: E402
from app.services import health  # noqa: E402
from app.services.schemas import ServiceStatus  # noqa: E402


# ─── 공개 서비스 상태 ───


def _svc(name, status="ok", ms=40):
    return ServiceStatus(name=name, url="/x/" if name == "Gitea" else None, status=status, response_ms=ms, internal_only=True)


def test_public_status_groups_and_hides_internal_names():
    cache = [_svc("PostgreSQL", ms=5), _svc("Redis", ms=3), _svc("Gitea", ms=60), _svc("LiveKit", "down", None),
             _svc("OnlyOffice", ms=1200), _svc("Mail Server", ms=42)]
    out = health.build_public_status(cache, module_enabled=lambda m: m != "git", checked_at=1_760_000_000)
    by = {s["key"]: s for s in out["services"]}
    assert by["auth"] == {"key": "auth", "status": "ok", "response_ms": 5}
    assert by["mail"]["status"] == "ok" and by["mail"]["response_ms"] == 42
    assert by["files"]["status"] == "slow" and by["files"]["response_ms"] == 1200
    assert by["meetings"]["status"] == "down" and by["meetings"]["response_ms"] is None
    assert by["git"]["status"] == "off"
    assert out["checked_at"].startswith("2025-")
    raw = json.dumps(out)
    for secret in ("PostgreSQL", "Redis", "Gitea", "LiveKit", "OnlyOffice", "/x/", "version"):
        assert secret not in raw


def test_public_status_skips_group_without_checks_and_reports_checking():
    # 메일 점검이 없으면(외부 IMAP) 메일 줄을 뺀다. 아직 점검 전이면 checking
    cache = [_svc("PostgreSQL", "checking", None), _svc("Redis", "checking", None)]
    out = health.build_public_status(cache, module_enabled=lambda m: True, checked_at=None)
    keys = [s["key"] for s in out["services"]]
    assert "mail" not in keys and "meetings" not in keys
    assert {s["status"] for s in out["services"]} == {"checking"}


@pytest.mark.asyncio
async def test_public_status_endpoint_needs_no_login(client):
    r = await client.get("/api/services/public-status")
    assert r.status_code == 200
    data = r.json()
    assert set(data) == {"checked_at", "services"}
    for s in data["services"]:
        assert set(s) == {"key", "status", "response_ms"}
    # 기존 상세 상태는 여전히 로그인 필요
    assert (await client.get("/api/services/status")).status_code in (401, 403)


# ─── 오피스 생략 요소 ───


def _zip(path: Path, parts: dict[str, str]):
    with zipfile.ZipFile(path, "w") as z:
        for n, body in parts.items():
            z.writestr(n, body)


def test_docx_omitted_counts_tables_and_images(tmp_path: Path):
    import docx
    from PIL import Image

    img = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 0, 0)).save(img, format="PNG")
    img.seek(0)
    d = docx.Document()
    d.add_paragraph("본문")
    d.add_table(rows=2, cols=2)
    d.add_picture(img)
    img.seek(0)
    d.add_picture(img)
    p = tmp_path / "a.docx"
    d.save(str(p))
    assert pv.get_office_omitted(p) == {"tables": 1, "images": 2}


def test_pptx_and_xlsx_omitted_counts(tmp_path: Path):
    pp = tmp_path / "s.pptx"
    _zip(pp, {
        "ppt/slides/slide1.xml": '<p:sld><a:tbl><a:tr/></a:tbl><p:pic id="1"/></p:sld>',
        "ppt/slides/slide2.xml": "<p:sld><p:pic><x/></p:pic></p:sld>",
        "ppt/slideLayouts/slideLayout1.xml": "<p:pic/>",
    })
    assert pv.get_office_omitted(pp) == {"tables": 1, "images": 2}
    xx = tmp_path / "t.xlsx"
    _zip(xx, {"xl/drawings/drawing1.xml": "<xdr:wsDr><xdr:pic/><xdr:pic/></xdr:wsDr>", "xl/worksheets/sheet1.xml": "<x/>"})
    assert pv.get_office_omitted(xx) == {"tables": 0, "images": 2}


def test_omitted_broken_file_is_zero(tmp_path: Path):
    p = tmp_path / "b.docx"
    p.write_bytes(b"not a zip")
    assert pv.get_office_omitted(p) == {"tables": 0, "images": 0}


# ─── 회의 요약 · 대기실 알림 ───

TABLES = [t.__table__ for t in (User, MeetingDB, MeetingInvitee, Notification, NotificationPref, Channel)]


@pytest.fixture()
async def env(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(repo, "_session_factory", factory)
    monkeypatch.setattr(mr, "_check_configured", lambda: None)

    from app.notifications import service as ns

    async def _no_deliver(*a, **kw):
        return None

    monkeypatch.setattr(ns, "_deliver", _no_deliver)

    metas: dict[str, store.RoomMeta] = {}

    async def _meta(name):
        return metas.get(name)

    monkeypatch.setattr(mr.store, "get_room_meta", _meta)

    members = {("ch1", "u2")}
    from app.chat import service as chat_service

    async def _is_member(db, cid, uid):
        return (cid, uid) in members

    monkeypatch.setattr(chat_service, "is_channel_member", _is_member)

    async with factory() as db:
        db.add(User(id="host", username="host", email="host@x", password_hash="x", display_name="박민지"))
        db.add(User(id="u2", username="u2", email="u2@x", password_hash="x", display_name="김서연"))
        db.add(User(id="u3", username="u3", email="u3@x", password_hash="x", display_name="남"))
        db.add(Channel(id="ch1", name="개발", type="public", created_by="host"))
        await db.commit()
    async with factory() as db:
        yield {"factory": factory, "metas": metas, "db": db}
    await engine.dispose()


async def _user(env, uid):
    return await env["db"].get(User, uid)


@pytest.mark.asyncio
async def test_summary_channel_call_members_only(env):
    s = await mr.meeting_summary("chan-ch1", user=await _user(env, "u2"), db=env["db"])
    assert s.title == "#개발" and s.chat_channel_id == "ch1" and s.channel_name == "개발"
    with pytest.raises(HTTPException) as e:
        await mr.meeting_summary("chan-ch1", user=await _user(env, "u3"), db=env["db"])
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_summary_db_meeting_host_and_invitee(env):
    async with env["factory"]() as db:
        m = MeetingDB(room_name="room-a", title="4분기 킥오프", host_user_id="host", host_display_name="박민지",
                      share_token="tok-a", status="ended", host_calendar_event_id="ev1", chat_channel_id="ch1",
                      started_at=datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc),
                      ended_at=datetime(2026, 10, 15, 6, 58, tzinfo=timezone.utc))
        db.add(m)
        await db.flush()
        db.add(MeetingInvitee(meeting_id=m.id, user_id="u2", display_name="김서연"))
        await db.commit()
    host = await mr.meeting_summary("room-a", user=await _user(env, "host"), db=env["db"])
    assert host.is_host and host.title == "4분기 킥오프" and host.host_name == "박민지"
    assert host.calendar_event_id == "ev1" and host.channel_name == "개발"
    assert host.started_at.startswith("2026-10-15T06:00")
    inv = await mr.meeting_summary("room-a", user=await _user(env, "u2"), db=env["db"])
    assert not inv.is_host and inv.calendar_event_id is None
    with pytest.raises(HTTPException) as e:
        await mr.meeting_summary("room-a", user=await _user(env, "u3"), db=env["db"])
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_summary_redis_room_host_only(env):
    env["metas"]["quick"] = store.RoomMeta(name="quick", host_user_id="host", host_username="host", host_display_name="박민지")
    s = await mr.meeting_summary("quick", user=await _user(env, "host"), db=env["db"])
    assert s.is_host and s.host_name == "박민지"
    with pytest.raises(HTTPException):
        await mr.meeting_summary("quick", user=await _user(env, "u2"), db=env["db"])
    with pytest.raises(HTTPException):
        await mr.meeting_summary("nope", user=await _user(env, "host"), db=env["db"])


@pytest.mark.asyncio
async def test_waiting_request_notifies_host_with_actions(env, monkeypatch):
    meta = store.RoomMeta(name="room b", host_user_id="host", host_username="host", host_display_name="박민지")

    async def _by_token(t):
        return meta if t == "tk" else None

    class Req:
        id = "r1"

    async def _create(name, nick):
        return Req()

    monkeypatch.setattr(mr.store, "get_room_by_token", _by_token)
    monkeypatch.setattr(mr.store, "create_join_request", _create)
    r = await mr.submit_join_request("tk", JoinRequestCreate(nickname="최수아"))
    assert r.request_id == "r1"
    async with env["factory"]() as db:
        rows = (await db.execute(select(Notification).where(Notification.user_id == "host"))).scalars().all()
    assert len(rows) == 1
    n = rows[0]
    assert "최수아" in n.title and n.type == "meeting_invite"
    assert n.link == "/meetings/room/room%20b"
    acts = json.loads(n.actions_json)
    assert [a["label"] for a in acts] == ["들이기", "거절"]
    assert acts[0]["url"] == "/api/meetings/rooms/room%20b/requests/r1/approve"


@pytest.mark.asyncio
async def test_list_visible_without_email_sends_no_nul(env):
    """이메일 없는 계정의 회의 목록 — PostgreSQL 이 NUL 매개변수를 거부해 500 이 나던 것(운영 확인 중 발견)."""
    from sqlalchemy import event

    async with env["factory"]() as db:
        m = MeetingDB(room_name="room-c", title="c", host_user_id="host", host_display_name="박민지", share_token="tok-c", status="scheduled")
        db.add(m)
        await db.flush()
        db.add(MeetingInvitee(meeting_id=m.id, user_id="u3", display_name="남"))
        await db.commit()
    seen: list = []
    sync_engine = env["db"].bind.sync_engine

    def _capture(conn, cursor, statement, parameters, context, executemany):
        seen.append(parameters)

    event.listen(sync_engine, "before_cursor_execute", _capture)
    try:
        u3 = await _user(env, "u3")
        u3.email = None
        rows = await repo.list_visible(env["db"], u3)
    finally:
        event.remove(sync_engine, "before_cursor_execute", _capture)
    assert [r.room_name for r in rows] == ["room-c"]
    assert not any("\x00" in str(p) for p in seen)
