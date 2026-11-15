"""관리 › 구역 API — 설치 관리자 내부 API 를 가짜 transport 로 바꿔 본다.

권한(비관리자 403), 대신 부르기(경로·공유 키·본문), 오류 변환, 설치 관리자 없음, 비밀 가림, 감사 기록,
진행 중인 작업 이어 받기.
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


@pytest.mark.asyncio
async def test_finished_jobs_fade_and_failed_jobs_stay_until_dismissed(env):
    client, fake, _ = env
    now = datetime.now(timezone.utc)

    async def start(zone, job_id):
        fake.on("POST", f"/internal/zones/{zone}/enable", (202, job(job_id, zone=zone)))
        assert (await client.post(f"/api/admin/system/zones/{zone}/enable", json={})).status_code == 202

    async def rows():
        data = (await client.get("/api/admin/system/zones")).json()
        return {z["id"]: z for z in (*data["zones"], *data["addons"])}

    await start("meetings", "aaaa1111")
    await start("git", "bbbb2222")
    await start("ai", "cccc3333")
    await start("sso", "dddd4444")
    stamp = lambda delta: (now - delta).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    fake.jobs["aaaa1111"] = job("aaaa1111", zone="meetings", status="done", finished_at=stamp(timedelta(minutes=1)))
    fake.jobs["bbbb2222"] = job("bbbb2222", zone="git", status="done", finished_at=stamp(timedelta(hours=1)))
    fake.jobs["cccc3333"] = job("cccc3333", zone="ai", status="failed", finished_at=stamp(timedelta(hours=5)),
                                error={"cause": "pull_failed", "fix": "see_log", "vars": {}})
    # dddd4444 는 설치 관리자가 모른다(오래돼 지워짐)

    got = await rows()
    assert got["meetings"]["job"]["status"] == "done"          # 방금 끝난 것은 잠시 남는다
    assert got["git"]["job"] is None                           # 오래전에 끝난 것은 걷힌다
    assert got["ai"]["job"]["status"] == "failed"              # 실패는 걷을 때까지 남는다
    assert got["ai"]["job"]["error"]["cause"] == "pull_failed"
    assert got["sso"]["job"] is None

    assert (await client.delete("/api/admin/system/zones/ai/job")).status_code == 200
    assert (await rows())["ai"]["job"] is None


@pytest.mark.asyncio
async def test_tracked_job_survives_installer_hiccup(env, monkeypatch):
    client, fake, _ = env
    fake.on("POST", "/internal/zones/git/enable", (202, job("eeee5555", zone="git")))
    await client.post("/api/admin/system/zones/git/enable", json={})
    fake.on("GET", "/internal/jobs/eeee5555", (500, {"code": "unexpected_error", "vars": {}}))
    rows = {z["id"]: z for z in (await client.get("/api/admin/system/zones")).json()["zones"]}
    assert rows["git"]["job"]["id"] == "eeee5555" and rows["git"]["job"]["status"] == "unknown"
    fake.routes.pop(("GET", "/internal/jobs/eeee5555"))
    fake.jobs["eeee5555"] = job("eeee5555", zone="git")
    rows = {z["id"]: z for z in (await client.get("/api/admin/system/zones")).json()["zones"]}
    assert rows["git"]["job"]["status"] == "running"


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
