"""관리 › 구역 API — 설치 관리자 내부 API 를 가짜 transport 로 바꿔 본다.

권한(비관리자 403), 대신 부르기(경로·공유 키·본문), 오류 변환, 설치 관리자 없음, 비밀 가림, 감사 기록,
설치 관리자의 작업 목록으로 진행 중·최근 작업 이어 받기, 연결 보류와 다시 연결, 인증서 상태·다시 발급.
"""

import json
import logging
import os
import sys
import types
from datetime import datetime, timedelta, timezone

if os.name == "nt" and "resource" not in sys.modules:  # 유닉스 전용 모듈을 import 하는 곳이 있다
    sys.modules["resource"] = types.ModuleType("resource")

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import zones
from app.auth.deps import get_current_user
from app.db.models import AuditLog, Base, User
from app.db.session import get_db
from app.system import installer_client
from app.system import router as system_router

KEY = "shared-key-for-tests"
SMTP_PASSWORD = "smtp-secret-do-not-log"
AI_KEY = "sk-ai-secret-do-not-log"


class FakeInstaller:
    """내부 API 흉내 — 받은 요청을 적어 두고, 경로별로 정해 둔 응답을 준다."""

    def __init__(self):
        self.calls: list[dict] = []
        self.routes: dict[tuple[str, str], object] = {}
        self.enabled = {"mail", "chat"}
        self.jobs: dict[str, dict] = {}

    def on(self, method: str, path: str, response) -> None:
        self.routes[(method, path)] = response

    def listing(self) -> dict:
        declared = zones.load_zones()

        def row(z, kind):
            return {"id": z["id"], "kind": kind, "name": z["name"], "summary": z["summary"],
                    "memory_mb": z["memory_mb"], "ports": z.get("ports", []), "requires": [],
                    "wizard_step": z.get("wizard_step"), "enabled": z["id"] in self.enabled,
                    "has_settings": z["id"] in ("mail", "meetings", "ai", "git"), "fits": z["id"] != "ai"}

        return {"version": 1, "zones": [row(z, "zone") for z in declared["zones"]],
                "addons": [row(z, "addon") for z in declared["addons"]],
                "memory": {"need_mb": 5000, "have_mb": 7900, "nominal_mb": 8192, "ok": True, "below_minimum": False}}

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append({"method": request.method, "path": request.url.path, "query": dict(request.url.params),
                           "key": request.headers.get("x-jw-installer-key"), "body": body})
        found = self.routes.get((request.method, request.url.path))
        if callable(found):
            found = found(request)
        if isinstance(found, httpx.Response):
            return found
        if isinstance(found, tuple):
            return httpx.Response(found[0], json=found[1])
        if found is not None:
            return httpx.Response(200, json=found)
        if request.method == "GET" and request.url.path == "/internal/zones":
            return httpx.Response(200, json=self.listing())
        if request.method == "GET" and request.url.path == "/internal/jobs":
            newest_first = sorted(self.jobs.values(), key=lambda j: j.get("started_at") or "", reverse=True)
            return httpx.Response(200, json={"jobs": newest_first})
        if request.method == "GET" and request.url.path.startswith("/internal/jobs/"):
            job = self.jobs.get(request.url.path.rsplit("/", 1)[-1])
            if job is None:
                return httpx.Response(404, json={"code": "job_unknown", "vars": {}})
            return httpx.Response(200, json=job)
        return httpx.Response(404, json={"detail": "Not Found"})

    def last(self, path: str) -> dict:
        return [c for c in self.calls if c["path"] == path][-1]


def job(job_id="a1b2c3d4e5f60718", kind="enable", zone="meetings", status="running", **extra) -> dict:
    return {"id": job_id, "kind": kind, "zone": zone, "status": status,
            "stages": [{"id": "pull", "status": "done"}, {"id": "configure", "status": "running"},
                       {"id": "connect", "status": "pending"}],
            "error": None, "warnings": [], "ports": ["7881/tcp"], "started_at": "2026-01-01T00:00:00Z",
            "finished_at": None, **extra}


@pytest.fixture()
async def env(monkeypatch):
    """(client, fake, state) — state.user 를 바꿔 호출자를 바꾼다."""
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as s:
        s.add(User(id="root", username="root", email="root@x", password_hash="x", is_admin=True))
        s.add(User(id="alice", username="alice", email="alice@x", password_hash="x"))
        await s.commit()

    state = types.SimpleNamespace(user="root", factory=factory)

    async def current_user():
        async with factory() as s:
            return await s.get(User, state.user)

    async def db():
        async with factory() as s:
            yield s

    app = FastAPI()
    app.include_router(system_router.router)
    app.include_router(system_router.public_router)
    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_db] = db

    fake = FakeInstaller()
    monkeypatch.setenv(installer_client.ENV_URL, "http://jw-installer:8444")
    monkeypatch.setenv(installer_client.ENV_KEY, KEY)
    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(fake.handler))
    monkeypatch.delenv(zones.ENV_VAR, raising=False)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client, fake, state
    await engine.dispose()


async def _audit(state) -> list[AuditLog]:
    async with state.factory() as s:
        return list((await s.execute(select(AuditLog).order_by(AuditLog.created_at))).scalars())


# ─── 등록 ───


def test_routers_are_core():
    table = dict((target, zone) for zone, target in zones.ROUTERS)
    assert table["app.system.router:router"] == "core"
    assert table["app.system.router:public_router"] == "core"
    assert system_router.router.prefix == "/api/admin/system"


# ─── 권한 ───


@pytest.mark.asyncio
async def test_non_admin_gets_403_everywhere(env):
    client, fake, state = env
    state.user = "alice"
    seen = 0
    for route in system_router.router.routes:
        path = route.path.replace("{zone_id}", "mail").replace("{job_id}", "abc123")
        for method in route.methods - {"HEAD"}:
            r = await client.request(method, path, json={} if method in ("POST", "PUT") else None)
            assert r.status_code == 403, (method, path, r.status_code)
            seen += 1
    assert seen >= 14
    assert fake.calls == []                      # 설치 관리자까지 가지 않는다
    assert await _audit(state) == []


# ─── 목록 ───


@pytest.mark.asyncio
async def test_list_merges_declaration_and_installer_state(env):
    client, fake, _ = env
    r = await client.get("/api/admin/system/zones")
    assert r.status_code == 200
    data = r.json()
    assert data["installer"] == {"available": True, "reason": None}
    assert data["memory"] == {"need_mb": 5000, "have_mb": 7900, "nominal_mb": 8192, "ok": True}
    assert [z["id"] for z in data["zones"]] == [z["id"] for z in zones.load_zones()["zones"]]
    assert [z["id"] for z in data["addons"]] == ["sso", "rbi"]
    rows = {z["id"]: z for z in (*data["zones"], *data["addons"])}
    assert rows["mail"]["enabled"] and not rows["meetings"]["enabled"]
    assert rows["mail"]["has_settings"] and not rows["chat"]["has_settings"]
    assert rows["mail"]["name"]["ko"] == "메일" and rows["mail"]["recommend_mb"] == 1000
    assert rows["meetings"]["ports"] == ["7881/tcp", "7882-7892/udp", "3478/udp", "4433/udp"]
    assert rows["ai"]["fits"] is False and rows["git"]["fits"] is True
    # 메뉴가 생기는 구역과 아닌 구역
    assert rows["mail"]["menu"] and rows["docs"]["menu"]
    assert not rows["sso"]["menu"] and not rows["rbi"]["menu"]
    assert all(z["job"] is None for z in rows.values())
    assert fake.calls[0]["key"] == KEY and fake.calls[0]["path"] == "/internal/zones"


@pytest.mark.asyncio
async def test_no_installer_gives_read_only_listing_and_503(env, monkeypatch):
    client, fake, state = env
    monkeypatch.delenv(installer_client.ENV_KEY)
    monkeypatch.setenv(zones.ENV_VAR, "core,mail,docs,sso")
    r = await client.get("/api/admin/system/zones")
    assert r.status_code == 200
    data = r.json()
    assert data["installer"] == {"available": False, "reason": "not_configured"}
    on = [z["id"] for z in (*data["zones"], *data["addons"]) if z["enabled"]]
    assert on == ["mail", "docs", "sso"]
    core = zones.load_zones()["core"]["memory_mb"]["recommend"]
    assert data["memory"] == {"need_mb": core + 1000 + 2000 + 500, "have_mb": None, "nominal_mb": None, "ok": None}

    calls = [("POST", "/zones/mail/check"), ("POST", "/zones/mail/enable"), ("POST", "/zones/mail/disable"),
             ("GET", "/zones/mail/settings"), ("PUT", "/zones/mail/settings"), ("GET", "/jobs/abc123"),
             ("GET", "/jobs/abc123/log"), ("POST", "/probe/smtp"), ("POST", "/probe/ai"),
             ("POST", "/probe/mail-records"), ("GET", "/probe/public-ip")]
    for method, path in calls:
        r = await client.request(method, "/api/admin/system" + path, json={} if method != "GET" else None)
        assert r.status_code == 503, (method, path)
        assert r.json()["code"] == "installer_unavailable" and r.json()["detail"]
    assert fake.calls == []
    assert await _audit(state) == []


@pytest.mark.asyncio
async def test_unreachable_installer(env, monkeypatch):
    client, _, _ = env

    def boom(request):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(boom))
    r = await client.get("/api/admin/system/zones")
    assert r.status_code == 200 and r.json()["installer"] == {"available": False, "reason": "installer_unreachable"}
    r = await client.post("/api/admin/system/zones/mail/check", json={})
    assert r.status_code == 503 and r.json()["code"] == "installer_unreachable"

    def slow(request):
        raise httpx.ReadTimeout("slow")

    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(slow))
    r = await client.post("/api/admin/system/zones/mail/check", json={})
    assert r.status_code == 504 and r.json()["code"] == "installer_timeout"


# ─── 대신 부르기 · 오류 변환 ───


@pytest.mark.asyncio
async def test_check_is_proxied(env):
    client, fake, state = env
    report = {"zone": "meetings", "ok": True, "errors": [], "ports": ["7881/tcp"], "cautions": [],
              "memory": {"need_mb": 6000, "have_mb": 7900, "nominal_mb": 8192, "ok": True, "below_minimum": False}}
    fake.on("POST", "/internal/zones/meetings/check", report)
    r = await client.post("/api/admin/system/zones/meetings/check", json={"settings": {"turn": False}})
    assert r.status_code == 200 and r.json() == report
    call = fake.last("/internal/zones/meetings/check")
    assert call["body"] == {"settings": {"turn": False}} and call["key"] == KEY
    assert await _audit(state) == []             # 확인은 아무것도 바꾸지 않는다


@pytest.mark.asyncio
async def test_unknown_zone_never_reaches_installer(env):
    client, fake, _ = env
    for path in ("/zones/nope/check", "/zones/..%2Fjobs/enable", "/zones/core/enable"):
        r = await client.post("/api/admin/system" + path, json={})
        assert r.status_code == 404, path
    assert (await client.post("/api/admin/system/zones/nope/check", json={})).json()["code"] == "zone_unknown"
    assert fake.calls == []


@pytest.mark.asyncio
async def test_installer_errors_are_converted(env):
    client, fake, state = env
    memory = {"need_mb": 9000, "have_mb": 7900, "nominal_mb": 8192, "ok": False, "below_minimum": False}
    fake.on("POST", "/internal/zones/ai/enable", (409, {"code": "memory_insufficient", "vars": memory}))
    r = await client.post("/api/admin/system/zones/ai/enable", json={"settings": {"mode": "later"}})
    assert r.status_code == 409
    assert r.json()["code"] == "memory_insufficient" and r.json()["vars"] == memory and r.json()["detail"]

    errors = [{"field": "host", "code": "required", "vars": {}}]
    fake.on("POST", "/internal/zones/mail/enable", (422, {"code": "settings_invalid", "vars": {"errors": errors}}))
    r = await client.post("/api/admin/system/zones/mail/enable", json={"settings": {"kind": "external"}})
    assert r.status_code == 422 and r.json()["vars"]["errors"] == errors

    fake.on("POST", "/internal/zones/git/enable", (409, {"code": "busy", "vars": {}}))
    assert (await client.post("/api/admin/system/zones/git/enable", json={})).json()["code"] == "busy"

    # 공유 키가 틀리면 설치 관리자는 404 not_found 를 준다 — 화면에는 "받아들이지 않음"
    fake.on("POST", "/internal/zones/chat/check", (404, {"code": "not_found", "vars": {}}))
    r = await client.post("/api/admin/system/zones/chat/check", json={})
    assert r.status_code == 502 and r.json()["code"] == "installer_rejected"

    fake.on("POST", "/internal/zones/docs/check", (500, {"code": "unexpected_error", "vars": {}}))
    r = await client.post("/api/admin/system/zones/docs/check", json={})
    assert r.status_code == 502 and r.json()["code"] == "installer_error"

    fake.on("POST", "/internal/zones/sso/check", httpx.Response(200, text="not json"))
    r = await client.post("/api/admin/system/zones/sso/check", json={})
    assert r.status_code == 502 and r.json()["code"] == "installer_error"
    assert await _audit(state) == []             # 받아들여지지 않은 요청은 기록하지 않는다


# ─── 켜기 · 끄기 · 감사 기록 · 비밀 가림 ───


@pytest.mark.asyncio
async def test_enable_tracks_job_audits_and_hides_secrets(env, caplog):
    client, fake, state = env
    running = job(zone="mail")
    fake.on("POST", "/internal/zones/mail/enable", (202, running))
    fake.jobs[running["id"]] = running
    settings = {"kind": "external", "host": "smtp.example.com", "port": 587, "security": "starttls",
                "username": "sender@example.com", "password": SMTP_PASSWORD}
    with caplog.at_level(logging.DEBUG):
        r = await client.post("/api/admin/system/zones/mail/enable", json={"settings": settings})
    assert r.status_code == 202 and r.json()["id"] == running["id"] and r.json()["status"] == "running"
    assert fake.last("/internal/zones/mail/enable")["body"] == {"settings": settings}     # 설치 관리자에는 그대로
    assert SMTP_PASSWORD not in caplog.text

    logs = await _audit(state)
    assert [(a.actor_id, a.action, a.resource_type, a.resource_id) for a in logs] == [
        ("root", "system.zone.enable", "zone", "mail")]
    assert SMTP_PASSWORD not in logs[0].details
    details = json.loads(logs[0].details)
    assert details["settings"]["password"] == "***" and details["settings"]["host"] == "smtp.example.com"
    assert details["job"] == running["id"]

    # 화면을 떠났다 돌아와도 목록이 진행 중인 작업을 알려 준다
    rows = {z["id"]: z for z in (await client.get("/api/admin/system/zones")).json()["zones"]}
    assert rows["mail"]["job"]["id"] == running["id"] and rows["mail"]["job"]["status"] == "running"
    assert rows["mail"]["job"]["stages"][1] == {"id": "configure", "status": "running"}
    assert rows["chat"]["job"] is None

    r = await client.get(f"/api/admin/system/jobs/{running['id']}")
    assert r.status_code == 200 and r.json()["zone"] == "mail"


def _stamp(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) - delta).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _rows(client) -> dict:
    data = (await client.get("/api/admin/system/zones")).json()
    return {z["id"]: z for z in (*data["zones"], *data["addons"])}


@pytest.mark.asyncio
async def test_jobs_come_from_the_installer_not_from_what_this_backend_started(env):
    """이 backend 가 시작하지 않은 작업(다른 창, 다시 뜬 backend)도 목록에 보인다."""
    client, fake, state = env
    fake.jobs["aaaa1111"] = job("aaaa1111", zone="meetings", started_at=_stamp(timedelta(minutes=2)))
    fake.jobs["old00000"] = job("old00000", zone="meetings", status="failed", started_at=_stamp(timedelta(hours=3)),
                                finished_at=_stamp(timedelta(hours=3)))
    got = await _rows(client)
    assert got["meetings"]["job"]["id"] == "aaaa1111" and got["meetings"]["job"]["status"] == "running"
    assert all(z["job"] is None for k, z in got.items() if k != "meetings")
    assert not [c for c in fake.calls if c["path"].startswith("/internal/jobs/")]      # 목록 한 번으로 끝난다
    assert fake.last("/internal/jobs")["key"] == KEY

    # 예전 방식으로 적어 둔 작업 id 는 읽을 때 지운다
    async with state.factory() as s:
        await system_router.set_setting(s, "system.zonejob.git", json.dumps({"id": "zzzz9999", "kind": "enable"}))
    assert (await _rows(client))["git"]["job"] is None
    async with state.factory() as s:
        assert await system_router.get_settings_by_prefix(s, "system.zonejob.") == {}


@pytest.mark.asyncio
async def test_finished_jobs_fade_and_failed_jobs_stay_until_dismissed(env):
    client, fake, state = env
    fake.jobs["aaaa1111"] = job("aaaa1111", zone="meetings", status="done", started_at=_stamp(timedelta(minutes=3)),
                                finished_at=_stamp(timedelta(minutes=1)))
    fake.jobs["bbbb2222"] = job("bbbb2222", zone="git", status="done", started_at=_stamp(timedelta(hours=2)),
                                finished_at=_stamp(timedelta(hours=1)))
    fake.jobs["cccc3333"] = job("cccc3333", zone="ai", status="failed", started_at=_stamp(timedelta(hours=6)),
                                finished_at=_stamp(timedelta(hours=5)),
                                error={"cause": "pull_failed", "fix": "see_log", "vars": {}})

    got = await _rows(client)
    assert got["meetings"]["job"]["status"] == "done"          # 방금 끝난 것은 잠시 남는다
    assert got["git"]["job"] is None                           # 오래전에 끝난 것은 걷힌다
    assert got["ai"]["job"]["status"] == "failed"              # 실패는 걷을 때까지 남는다
    assert got["ai"]["job"]["error"]["cause"] == "pull_failed"
    assert got["sso"]["job"] is None

    assert (await client.delete("/api/admin/system/zones/ai/job")).status_code == 200
    assert (await _rows(client))["ai"]["job"] is None
    assert (await _rows(client))["ai"]["job"] is None          # 다시 읽어도 걷힌 채다
    assert (await _rows(client))["meetings"]["job"] is not None

    # 그 구역에 새 작업이 생기면 다시 보이고, 걷은 표시는 지워진다
    fake.jobs["dddd4444"] = job("dddd4444", zone="ai", started_at=_stamp(timedelta(seconds=5)))
    assert (await _rows(client))["ai"]["job"]["id"] == "dddd4444"
    async with state.factory() as s:
        assert await system_router.get_settings_by_prefix(s, system_router.DISMISSED_KEY_PREFIX) == {}

    # 진행 중인 작업은 걷을 수 없다
    assert (await client.delete("/api/admin/system/zones/ai/job")).status_code == 200
    assert (await _rows(client))["ai"]["job"]["id"] == "dddd4444"


@pytest.mark.asyncio
async def test_listing_survives_a_jobs_hiccup(env):
    client, fake, _ = env
    fake.jobs["eeee5555"] = job("eeee5555", zone="git")
    fake.on("GET", "/internal/jobs", (500, {"code": "unexpected_error", "vars": {}}))
    r = await client.get("/api/admin/system/zones")
    assert r.status_code == 200 and r.json()["installer"]["available"] is True
    assert all(z["job"] is None for z in r.json()["zones"])
    fake.routes.pop(("GET", "/internal/jobs"))
    assert (await _rows(client))["git"]["job"]["status"] == "running"


@pytest.mark.asyncio
async def test_jobs_list_is_proxied_with_every_kind(env, monkeypatch):
    client, fake, state = env
    fake.jobs["cert0001"] = {"id": "cert0001", "kind": "cert", "zone": None, "status": "running",
                             "stages": [{"id": "issue", "status": "running"}, {"id": "reload", "status": "pending"},
                                        {"id": "reconnect", "status": "pending"}],
                             "error": None, "warnings": [], "started_at": _stamp(timedelta(seconds=30)),
                             "finished_at": None, "secret_field": "never-shown"}
    fake.jobs["conn0001"] = job("conn0001", kind="reconnect", zone="git", status="failed",
                                started_at=_stamp(timedelta(minutes=5)), finished_at=_stamp(timedelta(minutes=5)),
                                stages=[{"id": "connect", "status": "failed"}],
                                error={"cause": "connection_still_pending", "fix": None,
                                       "vars": {"zone": "git", "reason": "cert_untrusted"}})
    r = await client.get("/api/admin/system/jobs")
    assert r.status_code == 200
    jobs = r.json()["jobs"]
    assert [j["id"] for j in jobs] == ["cert0001", "conn0001"]                  # 새것부터
    assert jobs[0]["kind"] == "cert" and jobs[0]["zone"] is None and jobs[0]["ports"] == []
    assert "secret_field" not in jobs[0]
    assert jobs[1]["error"]["cause"] == "connection_still_pending"
    # 인증서 작업은 구역 행에 붙지 않고, 다시 연결 작업은 그 구역에 붙는다
    got = await _rows(client)
    assert got["git"]["job"]["kind"] == "reconnect" and got["git"]["job"]["status"] == "failed"

    state.user = "alice"
    assert (await client.get("/api/admin/system/jobs")).status_code == 403
    state.user = "root"
    monkeypatch.delenv(installer_client.ENV_KEY)
    r = await client.get("/api/admin/system/jobs")
    assert r.status_code == 503 and r.json()["code"] == "installer_unavailable"


# ─── 검증된 버전 · 연결 보류 · 다시 연결 ───


@pytest.mark.asyncio
async def test_listing_carries_verified_version_and_pending_state(env):
    client, fake, _ = env
    data = (await client.get("/api/admin/system/zones")).json()
    assert data["git_verified_version"] is None                # 설치 관리자가 주지 않으면 없음
    assert all(z["pending"] is False and z["pending_reason"] is None for z in data["zones"])

    base = fake.listing()
    for z in base["zones"]:
        if z["id"] == "git":
            z.update(enabled=True, pending=True, pending_reason="cert_untrusted")
    fake.on("GET", "/internal/zones", {**base, "git_verified_version": "1.25.4"})
    data = (await client.get("/api/admin/system/zones")).json()
    assert data["git_verified_version"] == "1.25.4"
    rows = {z["id"]: z for z in data["zones"]}
    assert rows["git"]["pending"] is True and rows["git"]["pending_reason"] == "cert_untrusted"
    assert rows["mail"]["pending"] is False

    fake.on("GET", "/internal/zones/git/settings", {"zone": "git", "enabled": True, "detected": {},
                                                    "settings": {"version": "tested"}, "verified_version": "1.25.4"})
    assert (await client.get("/api/admin/system/zones/git/settings")).json()["verified_version"] == "1.25.4"


@pytest.mark.asyncio
async def test_reconnect_is_proxied_and_audited(env):
    client, fake, state = env
    started = job("conn0002", kind="reconnect", zone="git", stages=[{"id": "connect", "status": "running"}])
    fake.on("POST", "/internal/zones/git/reconnect", (202, started))
    r = await client.post("/api/admin/system/zones/git/reconnect")
    assert r.status_code == 202 and r.json()["kind"] == "reconnect" and r.json()["stages"][0]["id"] == "connect"
    logs = await _audit(state)
    assert [(a.action, a.resource_type, a.resource_id) for a in logs] == [("system.zone.reconnect", "zone", "git")]
    assert json.loads(logs[0].details) == {"job": "conn0002"}

    for status, code in ((409, "not_pending"), (409, "not_enabled"), (409, "busy")):
        fake.on("POST", "/internal/zones/git/reconnect", (status, {"code": code, "vars": {}}))
        r = await client.post("/api/admin/system/zones/git/reconnect")
        assert r.status_code == status and r.json()["code"] == code and r.json()["detail"] != code
    assert len(await _audit(state)) == 1                       # 거부된 요청은 기록하지 않는다

    assert (await client.post("/api/admin/system/zones/nope/reconnect")).status_code == 404
    state.user = "alice"
    assert (await client.post("/api/admin/system/zones/git/reconnect")).status_code == 403


# ─── 인증서 ───

CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIB-cert-body\n-----END CERTIFICATE-----\n"
KEY_PEM = "-----BEGIN PRIVATE KEY-----\nMIIE-key-secret-do-not-log\n-----END PRIVATE KEY-----\n"


def cert_state(**over) -> dict:
    return {"managed": True, "mode": "temporary", "temporary": True, "domain": "ws.example.com",
            "names": ["ws.example.com"], "not_after": "2027-01-01T00:00:00Z", "days_left": 300,
            "issuer": "ws.example.com", "self_signed": True, "pending": ["git"], "job": None, **over}


def cert_job(**over) -> dict:
    return {"id": "cert0002", "kind": "cert", "zone": None, "status": "running",
            "stages": [{"id": "issue", "status": "running"}, {"id": "reload", "status": "pending"},
                       {"id": "reconnect", "status": "pending"}],
            "error": None, "warnings": [], "started_at": "2026-01-01T00:00:00Z", "finished_at": None, **over}


@pytest.mark.asyncio
async def test_cert_state_is_proxied(env, monkeypatch):
    client, fake, state = env
    fake.on("GET", "/internal/cert", cert_state(job=cert_job(), internal_path="/data/never-shown"))
    r = await client.get("/api/admin/system/cert")
    assert r.status_code == 200
    data = r.json()
    assert data["managed"] is True and data["mode"] == "temporary" and data["temporary"] is True
    assert data["names"] == ["ws.example.com"] and data["days_left"] == 300 and data["pending"] == ["git"]
    assert data["job"]["kind"] == "cert" and data["job"]["ports"] == [] and data["job"]["zone"] is None
    assert "internal_path" not in data
    assert fake.last("/internal/cert")["key"] == KEY

    fake.on("GET", "/internal/cert", {"managed": False, "mode": "proxy", "temporary": False, "domain": "ws.example.com"})
    data = (await client.get("/api/admin/system/cert")).json()
    assert data["managed"] is False and data["names"] == [] and data["pending"] == [] and data["job"] is None

    state.user = "alice"
    assert (await client.get("/api/admin/system/cert")).status_code == 403
    assert (await client.post("/api/admin/system/cert/reissue", json={"mode": "auto"})).status_code == 403
    state.user = "root"

    fake.routes.pop(("GET", "/internal/cert"))                 # 인증서 경로가 없는 예전 설치 관리자
    r = await client.get("/api/admin/system/cert")
    assert r.status_code == 501 and r.json()["code"] == "installer_unsupported"

    monkeypatch.delenv(installer_client.ENV_URL)
    for method, path, body in (("GET", "/cert", None), ("POST", "/cert/reissue", {"mode": "auto"}),
                               ("POST", "/zones/git/reconnect", None)):
        r = await client.request(method, "/api/admin/system" + path, json=body)
        assert r.status_code == 503 and r.json()["code"] == "installer_unavailable", path


@pytest.mark.asyncio
async def test_cert_reissue_auto_and_upload(env, caplog):
    client, fake, state = env
    fake.on("POST", "/internal/cert/reissue", (202, cert_job()))
    r = await client.post("/api/admin/system/cert/reissue", json={"mode": "auto", "cert": "ignored", "key": "ignored"})
    assert r.status_code == 202 and r.json()["id"] == "cert0002" and r.json()["stages"][0]["id"] == "issue"
    assert fake.last("/internal/cert/reissue")["body"] == {"mode": "auto"}

    with caplog.at_level(logging.DEBUG):
        r = await client.post("/api/admin/system/cert/reissue", json={"mode": "upload", "cert": CERT_PEM, "key": KEY_PEM})
    assert r.status_code == 202
    assert fake.last("/internal/cert/reissue")["body"] == {"mode": "upload", "cert": CERT_PEM, "key": KEY_PEM}
    assert "key-secret-do-not-log" not in caplog.text

    logs = await _audit(state)
    assert [(a.actor_id, a.action, a.resource_type) for a in logs] == [("root", "system.cert.reissue", "cert")] * 2
    assert [json.loads(a.details) for a in logs] == [{"job": "cert0002", "mode": "auto"},
                                                     {"job": "cert0002", "mode": "upload"}]
    assert all("key-secret-do-not-log" not in a.details and "cert-body" not in a.details for a in logs)


@pytest.mark.asyncio
async def test_cert_reissue_errors(env):
    client, fake, state = env
    checks = [{"id": "domain", "status": "fail", "value": "other.example.com", "fix": "cert_domain_missing"},
              {"id": "key", "status": "pass", "value": None, "fix": None}]
    cases = [
        ((409, {"code": "busy", "vars": {}}), 409, "busy"),
        ((409, {"code": "cert_managed_by_proxy", "vars": {}}), 409, "cert_managed_by_proxy"),
        ((409, {"code": "not_installed", "vars": {}}), 409, "not_installed"),
        ((422, {"code": "cert_invalid", "vars": {"checks": checks}}), 422, "cert_invalid"),
        ((422, {"code": "cert_auto_needs_domain", "vars": {}}), 422, "cert_auto_needs_domain"),
        ((413, {"code": "file_too_large", "vars": {}}), 413, "file_too_large"),
    ]
    for response, status, code in cases:
        fake.on("POST", "/internal/cert/reissue", response)
        r = await client.post("/api/admin/system/cert/reissue", json={"mode": "upload", "cert": CERT_PEM, "key": KEY_PEM})
        assert r.status_code == status and r.json()["code"] == code, code
        assert r.json()["detail"] != code                      # 사람이 읽을 문구가 있다
    fake.on("POST", "/internal/cert/reissue", (422, {"code": "cert_invalid", "vars": {"checks": checks}}))
    r = await client.post("/api/admin/system/cert/reissue", json={"mode": "upload", "cert": CERT_PEM, "key": KEY_PEM})
    assert r.json()["vars"]["checks"] == checks                # 검증 실패 항목은 그대로 내려간다
    assert await _audit(state) == []                           # 시작하지 못한 요청은 기록하지 않는다

    # 너무 큰 파일은 설치 관리자까지 가지 않는다
    before = len(fake.calls)
    huge = "A" * (system_router.CERT_PEM_MAX + 1)
    r = await client.post("/api/admin/system/cert/reissue", json={"mode": "upload", "cert": huge, "key": KEY_PEM})
    assert r.status_code == 413 and r.json()["code"] == "file_too_large" and len(fake.calls) == before

    assert (await client.post("/api/admin/system/cert/reissue", json={"mode": "temporary"})).status_code == 422
    assert len(fake.calls) == before


@pytest.mark.asyncio
async def test_disable_audits(env):
    client, fake, state = env
    fake.on("POST", "/internal/zones/docs/disable", (202, job("ffff6666", kind="disable", zone="docs")))
    r = await client.post("/api/admin/system/zones/docs/disable")
    assert r.status_code == 202 and r.json()["kind"] == "disable"
    logs = await _audit(state)
    assert [(a.actor_id, a.action, a.resource_id) for a in logs] == [("root", "system.zone.disable", "docs")]


@pytest.mark.asyncio
async def test_settings_never_return_secrets_and_changes_are_audited(env, caplog):
    client, fake, state = env
    # 설치 관리자가 비밀을 빼고 주는 것이 정상이지만, 혹시 실려 와도 화면까지 가지 않는다
    fake.on("GET", "/internal/zones/ai/settings", {
        "zone": "ai", "enabled": True, "detected": {"public_ip": "203.0.113.24"},
        "settings": {"mode": "now", "provider": "anthropic", "api_key": AI_KEY, "model": None}})
    r = await client.get("/api/admin/system/zones/ai/settings")
    assert r.status_code == 200 and AI_KEY not in r.text
    assert r.json()["settings"] == {"mode": "now", "provider": "anthropic", "model": None, "api_key_set": True}

    fake.on("GET", "/internal/zones/mail/settings", {
        "zone": "mail", "enabled": True, "detected": {},
        "settings": {"kind": "external", "host": "smtp.example.com", "password_set": True}})
    assert (await client.get("/api/admin/system/zones/mail/settings")).json()["settings"]["password_set"] is True

    fake.on("PUT", "/internal/zones/ai/settings", (202, job("abab7777", kind="update", zone="ai")))
    with caplog.at_level(logging.DEBUG):
        r = await client.put("/api/admin/system/zones/ai/settings",
                             json={"settings": {"mode": "now", "provider": "openai", "api_key": AI_KEY}})
    assert r.status_code == 202 and r.json()["kind"] == "update"
    assert fake.last("/internal/zones/ai/settings")["body"]["settings"]["api_key"] == AI_KEY
    assert AI_KEY not in caplog.text
    logs = await _audit(state)
    assert logs[-1].action == "system.zone.settings" and logs[-1].resource_id == "ai" and logs[-1].actor_id == "root"
    assert AI_KEY not in logs[-1].details and json.loads(logs[-1].details)["settings"]["api_key"] == "***"


def test_redact_and_strip():
    assert system_router.redact({"password": "x", "api_key": "", "nested": {"api_key": "k"}, "host": "h"}) == {
        "password": "***", "api_key": "", "nested": {"api_key": "***"}, "host": "h"}
    assert system_router.strip_secrets({"password": "", "password_set": True}) == {"password_set": True}
    assert system_router.strip_secrets({"api_key": None}) == {"api_key_set": False}


# ─── 작업 ───


@pytest.mark.asyncio
async def test_job_and_log(env):
    client, fake, _ = env
    r = await client.get("/api/admin/system/jobs/nope1234")
    assert r.status_code == 404 and r.json()["code"] == "job_unknown"
    before = len(fake.calls)
    r = await client.get("/api/admin/system/jobs/bad.id")       # 영문·숫자만 — 설치 관리자까지 가지 않는다
    assert r.status_code == 404 and len(fake.calls) == before

    fake.jobs["abcd1234"] = job("abcd1234")
    fake.on("GET", "/internal/jobs/abcd1234/log", {"lines": ["받기 시작", "실패: pull_failed"]})
    r = await client.get("/api/admin/system/jobs/abcd1234/log", params={"tail": 50})
    assert r.status_code == 200 and r.json() == {"lines": ["받기 시작", "실패: pull_failed"]}
    assert fake.last("/internal/jobs/abcd1234/log")["query"] == {"tail": "50"}


# ─── 연결 확인 ───


@pytest.mark.asyncio
async def test_probes(env, caplog):
    client, fake, _ = env
    fake.on("POST", "/internal/probe/smtp", {"status": "auth_failed", "detail": None})
    body = {"host": "smtp.example.com", "port": 587, "security": "starttls", "username": "u", "password": SMTP_PASSWORD}
    with caplog.at_level(logging.DEBUG):
        r = await client.post("/api/admin/system/probe/smtp", json=body)
    assert r.status_code == 200 and r.json() == {"status": "auth_failed", "detail": None}
    assert fake.last("/internal/probe/smtp")["body"] == body and SMTP_PASSWORD not in caplog.text

    fake.on("POST", "/internal/probe/ai", {"status": "ok", "http_status": 200, "models": ["m-1"]})
    r = await client.post("/api/admin/system/probe/ai", json={"provider": "anthropic", "api_key": AI_KEY})
    assert r.json()["status"] == "ok" and r.json()["models"] == ["m-1"]

    # 내부 API 에 없는 확인 — 501 로 알린다
    r = await client.post("/api/admin/system/probe/mail-records", json={"mail_domain": "example.com"})
    assert r.status_code == 501 and r.json()["code"] == "installer_unsupported"
    # 생기면 그대로 지나간다
    records = {"mail_domain": "example.com", "ok": False, "records": [
        {"id": "mx", "name": "example.com", "type": "MX", "expected": "10 mail.example.com", "current": [], "status": "missing"}]}
    fake.on("POST", "/internal/probe/mail-records", records)
    assert (await client.post("/api/admin/system/probe/mail-records", json={})).json() == records


@pytest.mark.asyncio
async def test_public_ip_falls_back_to_detected_value(env):
    client, fake, _ = env
    fake.on("GET", "/internal/zones/meetings/settings", {"zone": "meetings", "enabled": False, "settings": {},
                                                         "detected": {"public_ip": "203.0.113.24"}})
    r = await client.get("/api/admin/system/probe/public-ip")
    assert r.json() == {"status": "detected", "ip": "203.0.113.24", "source": "cached"}
    fake.on("GET", "/internal/zones/meetings/settings", {"zone": "meetings", "settings": {}, "detected": {"public_ip": None}})
    assert (await client.get("/api/admin/system/probe/public-ip")).json()["status"] == "unknown"
    fake.on("GET", "/internal/probe/public-ip", {"status": "detected", "ip": "198.51.100.7", "source": "probe"})
    r = await client.get("/api/admin/system/probe/public-ip", params={"refresh": "true"})
    assert r.json()["ip"] == "198.51.100.7" and fake.last("/internal/probe/public-ip")["query"] == {"refresh": "true"}


@pytest.mark.asyncio
async def test_cert_ca_is_passed_with_the_upload_and_on_its_own(env):
    """사설 CA 의 인증서 — 인증서와 함께 올리거나, 나중에 CA 만 올린다(인증서·개인 키는 그대로)."""
    client, fake, state = env
    ca_pem = "-----BEGIN CERTIFICATE-----\nca-body\n-----END CERTIFICATE-----\n"
    fake.on("POST", "/internal/cert/reissue", (202, cert_job()))
    r = await client.post("/api/admin/system/cert/reissue", json={"mode": "upload", "cert": CERT_PEM, "key": KEY_PEM, "ca": ca_pem})
    assert r.status_code == 202
    assert fake.last("/internal/cert/reissue")["body"] == {"mode": "upload", "cert": CERT_PEM, "key": KEY_PEM, "ca": ca_pem}
    # 비어 있으면 항목을 싣지 않는다(CA 를 모르는 예전 설치 관리자에도 같은 요청이 간다)
    await client.post("/api/admin/system/cert/reissue", json={"mode": "upload", "cert": CERT_PEM, "key": KEY_PEM, "ca": "  "})
    assert "ca" not in fake.last("/internal/cert/reissue")["body"]

    fake.on("POST", "/internal/cert/ca", (202, cert_job(id="cert0003")))
    r = await client.post("/api/admin/system/cert/ca", json={"ca": ca_pem})
    assert r.status_code == 202 and r.json()["id"] == "cert0003" and r.json()["kind"] == "cert"
    assert fake.last("/internal/cert/ca")["body"] == {"ca": ca_pem} and fake.last("/internal/cert/ca")["key"] == KEY
    r = await client.post("/api/admin/system/cert/ca", json={"ca": ""})            # 걷어 내기
    assert r.status_code == 202 and fake.last("/internal/cert/ca")["body"] == {"ca": ""}
    logs = [a for a in await _audit(state) if a.action == "system.cert.ca"]
    assert [json.loads(a.details) for a in logs] == [{"job": "cert0003", "removed": False}, {"job": "cert0003", "removed": True}]
    assert all("ca-body" not in a.details for a in logs)

    # 거부는 그대로 전한다
    checks = [{"id": "ca_issues_cert", "status": "fail", "value": "CN=Other", "fix": {"key": "ca_not_issuer", "vars": {}}}]
    for response, status, code in (((409, {"code": "cert_ca_needs_upload", "vars": {"mode": "auto"}}), 409, "cert_ca_needs_upload"),
                                   ((422, {"code": "cert_invalid", "vars": {"checks": checks}}), 422, "cert_invalid"),
                                   ((409, {"code": "busy", "vars": {}}), 409, "busy")):
        fake.on("POST", "/internal/cert/ca", response)
        r = await client.post("/api/admin/system/cert/ca", json={"ca": ca_pem})
        assert r.status_code == status and r.json()["code"] == code and r.json()["detail"] != code, code
    assert r.json()["code"] == "busy"
    before = len(fake.calls)
    r = await client.post("/api/admin/system/cert/ca", json={"ca": "A" * (system_router.CERT_PEM_MAX + 1)})
    assert r.status_code == 413 and len(fake.calls) == before                        # 설치 관리자까지 가지 않는다

    state.user = "alice"
    assert (await client.post("/api/admin/system/cert/ca", json={"ca": ca_pem})).status_code == 403
    state.user = "root"


@pytest.mark.asyncio
async def test_cert_state_tells_whether_the_issuing_ca_is_known(env):
    client, fake, _ = env
    fake.on("GET", "/internal/cert", cert_state(mode="upload", temporary=False, self_signed=False, site_ca=False, ca_uploadable=True))
    data = (await client.get("/api/admin/system/cert")).json()
    assert data["site_ca"] is False and data["ca_uploadable"] is True and data["pending"] == ["git"]
    # 이 값을 주지 않는 예전 설치 관리자 — 화면이 CA 자리를 보이지 않게 false 로 채운다
    fake.on("GET", "/internal/cert", {k: v for k, v in cert_state().items() if k not in ("site_ca", "ca_uploadable")})
    data = (await client.get("/api/admin/system/cert")).json()
    assert data["site_ca"] is False and data["ca_uploadable"] is False
