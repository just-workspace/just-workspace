"""업데이트 사전 공지·점검 모드 — 설치 관리자가 통지하는 경로의 보호와 브로드캐스트, 로그인한 사용자의 조회.

계약: docs/update-api.md 8절
"""

import json
import os
import sys
import types

if os.name == "nt" and "resource" not in sys.modules:  # 유닉스 전용 모듈을 import 하는 코드가 존재
    sys.modules["resource"] = types.ModuleType("resource")

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.admin.settings import get_setting, set_setting
from app.auth.deps import get_current_user
from app.db.models import Base, User
from app.db.session import get_db
from app.notifications import service as notifications
from app.realtime import events
from app.system import installer_client
from app.system import update_router

KEY = "shared-key-for-tests"
URL = "/api/internal/system/update-event"
HEAD = {"X-JW-Installer-Key": KEY}
COUNTDOWN = {"type": "countdown", "job": "j1", "kind": "update", "trigger": "manual",
             "ends_at": "2026-01-12T01:35:00Z", "expected_seconds": 240}
MAINTENANCE = {"type": "maintenance", "job": "j1", "kind": "update", "started_at": "2026-01-12T01:35:00Z",
               "expected_seconds": 240}


@pytest.fixture()
async def env(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as s:
        s.add(User(id="root", username="root", email="root@x", password_hash="x", is_admin=True))
        s.add(User(id="boss", username="boss", email="boss@x", password_hash="x", is_admin=True))
        s.add(User(id="gone", username="gone", email="gone@x", password_hash="x", is_admin=True, is_active=False))
        s.add(User(id="alice", username="alice", email="alice@x", password_hash="x"))
        await s.commit()

    state = types.SimpleNamespace(user="alice", factory=factory, sent=[], notified=[], live=None, live_calls=0)

    async def current_user():
        async with factory() as s:
            return await s.get(User, state.user)

    async def db():
        async with factory() as s:
            yield s

    async def emit_to_all(event):
        state.sent.append(event)

    async def create_notification(db, user_id, type, title, body=None, link=None, **kw):
        state.notified.append({"user": user_id, "type": type, "title": title, "body": body, "link": link})
        return {}

    def installer(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/internal/update/maintenance":
            state.live_calls += 1
            if state.live is None:
                raise httpx.ConnectError("refused")
            return httpx.Response(200, json=state.live)
        return httpx.Response(404, json={"detail": "Not Found"})

    app = FastAPI()
    app.include_router(update_router.public_router)
    app.include_router(update_router.internal_router)
    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_db] = db

    monkeypatch.setenv(installer_client.ENV_URL, "http://jw-installer:8444")
    monkeypatch.setenv(installer_client.ENV_KEY, KEY)
    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(installer))
    monkeypatch.setattr(events, "emit_to_all", emit_to_all)
    monkeypatch.setattr(notifications, "create_notification", create_notification)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client, state
    await engine.dispose()


async def _stored(state):
    async with state.factory() as s:
        raw = await get_setting(s, update_router.NOTICE_KEY)
    return json.loads(raw) if raw else None


# ─── 보호 ───


async def test_event_needs_the_installer_key(env):
    client, state = env
    assert (await client.post(URL, json=COUNTDOWN)).status_code == 401
    assert (await client.post(URL, json=COUNTDOWN, headers={"X-JW-Installer-Key": "wrong"})).status_code == 401
    # 로그인한 관리자라도 키가 없으면 거부
    state.user = "root"
    assert (await client.post(URL, json=COUNTDOWN)).status_code == 401
    assert state.sent == [] and await _stored(state) is None


async def test_event_route_is_closed_without_installer(env, monkeypatch):
    client, state = env
    monkeypatch.delenv(installer_client.ENV_KEY)
    r = await client.post(URL, json=COUNTDOWN, headers=HEAD)
    assert r.status_code == 404
    assert state.sent == []


async def test_unknown_or_broken_events_are_rejected(env):
    client, state = env
    assert (await client.post(URL, json={"type": "reboot"}, headers=HEAD)).status_code == 422
    assert (await client.post(URL, json={"type": "countdown", "job": "j1"}, headers=HEAD)).status_code == 422
    assert state.sent == []


# ─── 브로드캐스트 ───


async def test_countdown_is_broadcast_and_remembered(env):
    client, state = env
    r = await client.post(URL, json={**COUNTDOWN, "secret": "x"}, headers=HEAD)
    assert r.status_code == 200 and r.json() == {"ok": True, "delivered": True}
    assert state.sent == [{"type": "system.update_countdown", "job": "j1", "kind": "update",
                           "ends_at": "2026-01-12T01:35:00Z", "expected_seconds": 240}]
    assert (await _stored(state))["state"] == "countdown"


async def test_cancel_clears_and_broadcasts(env):
    client, state = env
    await client.post(URL, json=COUNTDOWN, headers=HEAD)
    await client.post(URL, json={"type": "cancelled", "job": "j1"}, headers=HEAD)
    assert state.sent[-1] == {"type": "system.update_cancelled", "job": "j1"}
    assert await _stored(state) is None


async def test_maintenance_start_and_finish(env):
    client, state = env
    await client.post(URL, json=MAINTENANCE, headers=HEAD)
    assert state.sent[-1] == {"type": "system.maintenance", "active": True, "kind": "update",
                              "started_at": "2026-01-12T01:35:00Z", "expected_seconds": 240}
    assert (await _stored(state))["state"] == "maintenance"

    await client.post(URL, json={"type": "finished", "job": "j1", "kind": "update", "trigger": "manual",
                                 "result": "success", "version": "1.1.0", "from_version": "1.0.0"}, headers=HEAD)
    assert state.sent[-1] == {"type": "system.maintenance", "active": False, "result": "success"}
    assert await _stored(state) is None
    # 관리자가 직접 수행한 업데이트는 알림(종)을 생성하지 않음
    assert state.notified == []


@pytest.mark.parametrize("result,word", [("success", "완료했습니다"), ("rolled_back", "롤백했습니다"),
                                         ("rollback_failed", "실패했습니다")])
async def test_auto_update_result_notifies_active_admins_once_each(env, result, word):
    client, state = env
    await client.post(URL, json={"type": "finished", "job": "j1", "kind": "update", "trigger": "auto",
                                 "result": result, "version": "1.1.0", "from_version": "1.0.0",
                                 "failed_step": "migrate"}, headers=HEAD)
    assert sorted(n["user"] for n in state.notified) == ["boss", "root"]
    assert all(word in n["title"] and n["type"] == "system" and n["link"] == "/admin/update" for n in state.notified)
    if result != "success":
        assert all("1.0.0" in n["body"] and "중지되어" in n["body"] for n in state.notified)


async def test_broadcast_failure_does_not_fail_the_event(env, monkeypatch):
    client, state = env

    async def broken(event):
        raise RuntimeError("redis down")

    monkeypatch.setattr(events, "emit_to_all", broken)
    r = await client.post(URL, json=COUNTDOWN, headers=HEAD)
    assert r.status_code == 200 and r.json() == {"ok": True, "delivered": False}
    assert (await _stored(state))["state"] == "countdown"      # 조회로는 전달됨


# ─── 조회 ───


async def test_notice_is_none_by_default_and_needs_login(env):
    client, state = env
    r = await client.get("/api/system/update-notice")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert r.json() == {"state": "none", "job": None, "kind": None, "ends_at": None, "started_at": None,
                        "expected_seconds": None, "contact": None}
    assert state.live_calls == 0


async def test_notice_reports_countdown_then_maintenance_with_contact(env):
    client, state = env
    state.live = {"active": False, "phase": "countdown"}
    async with state.factory() as s:
        await set_setting(s, update_router.CONTACT_KEY, "내선 1234")
    await client.post(URL, json=COUNTDOWN, headers=HEAD)
    r = (await client.get("/api/system/update-notice")).json()
    assert r == {"state": "countdown", "job": "j1", "kind": "update", "ends_at": "2026-01-12T01:35:00Z",
                 "started_at": None, "expected_seconds": 240, "contact": "내선 1234"}

    state.live = {"active": True, "phase": "running"}
    await client.post(URL, json=MAINTENANCE, headers=HEAD)
    r = (await client.get("/api/system/update-notice")).json()
    assert r["state"] == "maintenance" and r["started_at"] == "2026-01-12T01:35:00Z" and r["ends_at"] is None


async def test_stale_notice_is_dropped_when_installer_says_idle(env):
    """종료 알림을 수신하지 못해도 화면이 점검 모드에 고정되지 않는다."""
    client, state = env
    await client.post(URL, json=MAINTENANCE, headers=HEAD)
    state.live = {"active": False, "phase": "idle"}
    assert (await client.get("/api/system/update-notice")).json()["state"] == "none"
    assert await _stored(state) is None


async def test_notice_is_kept_when_installer_cannot_be_asked(env):
    client, state = env
    await client.post(URL, json=MAINTENANCE, headers=HEAD)
    state.live = None       # 연결 불가
    assert (await client.get("/api/system/update-notice")).json()["state"] == "maintenance"


async def test_broken_stored_notice_is_cleared(env):
    client, state = env
    async with state.factory() as s:
        await set_setting(s, update_router.NOTICE_KEY, "{not json")
    assert (await client.get("/api/system/update-notice")).json()["state"] == "none"
    assert await _stored(state) is None


# ─── 전송 계층 ───


async def test_emit_to_all_publishes_on_the_everyone_channel(monkeypatch):
    published = []

    class Redis:
        async def publish(self, channel, data):
            published.append((channel, json.loads(data)))

    async def get_redis():
        return Redis()

    monkeypatch.setattr(events, "get_redis", get_redis)
    await events.emit_to_all({"type": "system.update_cancelled", "job": "j1"})
    from app.realtime import socket
    assert published == [(socket.PUBSUB_PRESENCE, {"type": "system.update_cancelled", "job": "j1"})]
