"""관리 › 업데이트 API — 설치 관리자의 업데이트 내부 API 를 가짜 transport 로 대체하여 검증한다.

권한(비관리자 403), 대리 호출(경로·공유 키·본문의 actor), 오류 변환, 설치 관리자 없음/미지원,
파일 업로드(스트리밍 전달), 기록 다운로드, 감사 기록, 연락처.
계약: docs/update-api.md
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
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import zones
from app.admin.settings import get_setting
from app.auth.deps import get_current_user
from app.db.models import AuditLog, Base, User
from app.db.session import get_db
from app.system import installer_client
from app.system import update_router

KEY = "shared-key-for-tests"
B = "/api/admin/system/update"
P = "/internal/update"
JOB_ID = "b7e2c1d09a4f5e63"


def job(**extra) -> dict:
    return {"id": JOB_ID, "kind": "update", "trigger": "manual", "status": "countdown", "from_version": "1.0.0",
            "target_version": "1.1.0", "path": ["1.1.0"], "version_index": 0,
            "countdown": {"ends_at": "2026-01-12T01:35:00Z", "seconds": 300},
            "steps": [{"id": s, "status": "pending"} for s in
                      ("preflight", "backup", "pull", "migrate", "switch", "verify")],
            "error": None, "choices": [], "rollback_job": None, "restore": None, "expected_seconds": 240,
            "started_at": "2026-01-12T01:30:00Z", "maintenance_started_at": None, "finished_at": None, **extra}


STATUS = {"current": {"version": "1.0.0", "channel": "stable", "applied_at": None, "previous_version": None},
          "settings": {"mode": "manual", "window": {"start": "03:00", "end": "05:00"}, "channel": "stable",
                       "min_age_days": 3},
          "check": {"state": "idle", "last_at": "2026-01-12T00:00:04Z", "ok": True, "error": None},
          "available": {"state": "none"}, "job": None,
          "auto": {"paused": False, "paused_at": None, "reason": None}, "last_auto": None,
          "server_time": "2026-01-12T01:23:45Z"}


class FakeInstaller:
    """내부 API 모사 — 수신한 요청을 기록하고, 경로별로 지정된 응답을 반환한다."""

    def __init__(self):
        self.calls: list[dict] = []
        self.routes: dict[tuple[str, str], object] = {}

    def on(self, method: str, path: str, response) -> None:
        self.routes[(method, path)] = response

    def handler(self, request: httpx.Request) -> httpx.Response:
        raw = request.content
        try:
            body = json.loads(raw) if raw else None
        except ValueError:
            body = None
        self.calls.append({"method": request.method, "path": request.url.path, "query": dict(request.url.params),
                           "key": request.headers.get("x-jw-installer-key"), "body": body, "raw": raw,
                           "headers": dict(request.headers)})
        found = self.routes.get((request.method, request.url.path))
        if callable(found):
            found = found(request)
        if isinstance(found, httpx.Response):
            return found
        if isinstance(found, tuple):
            return httpx.Response(found[0], json=found[1])
        if found is not None:
            return httpx.Response(200, json=found)
        return httpx.Response(404, json={"detail": "Not Found"})

    def last(self, path: str) -> dict:
        return [c for c in self.calls if c["path"] == path][-1]


@pytest.fixture()
async def env(monkeypatch):
    """(client, fake, state) — state.user 를 변경하여 호출자를 전환한다."""
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as s:
        s.add(User(id="root", username="root", display_name="루트", email="root@x", password_hash="x", is_admin=True))
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
    app.include_router(update_router.router)
    app.include_router(update_router.public_router)
    app.include_router(update_router.internal_router)
    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_db] = db

    fake = FakeInstaller()
    monkeypatch.setenv(installer_client.ENV_URL, "http://jw-installer:8444")
    monkeypatch.setenv(installer_client.ENV_KEY, KEY)
    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(fake.handler))

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client, fake, state
    await engine.dispose()


async def _audit(state) -> list[AuditLog]:
    async with state.factory() as s:
        return list((await s.execute(select(AuditLog).order_by(AuditLog.created_at))).scalars())


# ─── 등록 ───


def test_routers_are_core():
    table = dict((target, zone) for zone, target in zones.ROUTERS)
    for name in ("router", "public_router", "internal_router"):
        assert table[f"app.system.update_router:{name}"] == "core"
    assert update_router.router.prefix == B
    assert update_router.internal_router.prefix == "/api/internal/system"


# ─── 권한 ───

ADMIN_CALLS = [
    ("GET", "/status"), ("POST", "/check"), ("GET", "/releases/1.0.0"), ("GET", "/settings"), ("PUT", "/settings"),
    ("POST", "/apply"), ("GET", f"/jobs/{JOB_ID}"), ("POST", f"/jobs/{JOB_ID}/action"), ("GET", f"/jobs/{JOB_ID}/log"),
    ("GET", f"/jobs/{JOB_ID}/log/download"), ("POST", "/auto/resume"), ("GET", "/restore-points"),
    ("POST", "/restore"), ("GET", "/offline"), ("POST", "/offline/bundle"), ("POST", "/offline/bundle-path"),
    ("DELETE", "/offline/bundle"), ("POST", "/offline/images/postgres"), ("POST", "/offline/apply"),
    ("GET", "/history"), ("GET", f"/history/{JOB_ID}"), ("GET", "/apps"), ("GET", "/contact"), ("PUT", "/contact"),
]


async def test_non_admin_gets_403_everywhere(env):
    client, fake, state = env
    state.user = "alice"
    for method, path in ADMIN_CALLS:
        r = await client.request(method, B + path, json={})
        assert r.status_code == 403, (method, path, r.status_code)
    assert fake.calls == []
    assert await _audit(state) == []


async def test_every_admin_route_is_in_the_permission_list():
    listed = {(m, p) for m, p in ADMIN_CALLS}
    for route in update_router.router.routes:
        path = route.path[len(B):]
        for raw, sample in (("{job_id}", JOB_ID), ("{entry_id}", JOB_ID), ("{image_id}", "postgres"),
                            ("{version}", "1.0.0")):
            path = path.replace(raw, sample)
        for method in route.methods - {"HEAD", "OPTIONS"}:
            assert (method, path) in listed, (method, path)


# ─── 대리 호출 ───


async def test_status_is_proxied_with_key(env):
    client, fake, _ = env
    fake.on("GET", f"{P}/status", STATUS)
    r = await client.get(f"{B}/status")
    assert r.status_code == 200 and r.json() == STATUS
    assert fake.last(f"{P}/status")["key"] == KEY


async def test_check_and_release_and_lists_are_proxied(env):
    client, fake, _ = env
    fake.on("POST", f"{P}/check", (202, {**STATUS, "check": {**STATUS["check"], "state": "checking"}}))
    fake.on("GET", f"{P}/releases/1.0.0", {"version": "1.0.0", "changelog": "- a"})
    fake.on("GET", f"{P}/restore-points", {"points": []})
    fake.on("GET", f"{P}/history", {"items": [], "retention_days": 365, "more": False})
    fake.on("GET", f"{P}/history/{JOB_ID}", {"id": JOB_ID, "versions": []})
    fake.on("GET", f"{P}/apps", {"version": "1.0.0", "download_page": None, "apps": []})
    fake.on("GET", f"{P}/offline", {"bundle": None, "images": [], "ready": False, "blockers": ["bundle_missing"]})

    r = await client.post(f"{B}/check")
    assert r.status_code == 202 and r.json()["check"]["state"] == "checking"
    assert (await client.get(f"{B}/releases/1.0.0")).json()["changelog"] == "- a"
    assert (await client.get(f"{B}/restore-points")).json() == {"points": []}
    assert (await client.get(f"{B}/history", params={"limit": 10, "before": JOB_ID})).json()["retention_days"] == 365
    assert fake.last(f"{P}/history")["query"] == {"limit": "10", "before": JOB_ID}
    assert (await client.get(f"{B}/history/{JOB_ID}")).json()["id"] == JOB_ID
    assert (await client.get(f"{B}/apps")).json()["apps"] == []
    assert (await client.get(f"{B}/offline")).json()["blockers"] == ["bundle_missing"]


async def test_bad_ids_never_reach_installer(env):
    client, fake, _ = env
    for method, path, code in (("GET", "/jobs/.hidden", "job_unknown"), ("GET", "/jobs/a b", "job_unknown"),
                               ("GET", "/history/a$b", "history_unknown"), ("GET", "/releases/latest", "history_unknown"),
                               ("POST", "/offline/images/a$b", "image_unknown")):
        r = await client.request(method, B + path, content=b"x", headers={"X-JW-Filename": "x.tar"})
        assert r.status_code == 404 and r.json()["code"] == code, (path, r.status_code, r.text)
    r = await client.post(f"{B}/restore", json={"point": "../x"})
    assert r.status_code == 404 and r.json()["code"] == "restore_point_unknown"
    assert fake.calls == []


# ─── 설치 관리자 없음 / 미지원 ───


async def test_no_installer_is_update_unavailable(env, monkeypatch):
    client, fake, _ = env
    monkeypatch.delenv(installer_client.ENV_URL)
    for method, path in (("GET", "/status"), ("POST", "/apply"), ("GET", "/history"), ("POST", "/offline/bundle")):
        r = await client.request(method, B + path, json={"target": "1.1.0"}, headers={"X-JW-Filename": "b.tar"})
        assert r.status_code == 503, (path, r.status_code)
        assert r.json()["code"] == "update_unavailable" and r.json()["vars"] == {"reason": "no_installer"}
        assert r.json()["detail"]
    assert fake.calls == []


@pytest.mark.parametrize("reply", [
    httpx.Response(404, json={"detail": "Not Found"}),          # 이 경로를 지원하지 않는 설치 관리자
    httpx.Response(405, text="Method Not Allowed"),
    httpx.Response(501, json={"code": "not_implemented", "vars": {}}),
    httpx.Response(501, text=""),
])
async def test_old_installer_is_update_unavailable_unsupported(env, reply):
    client, fake, _ = env
    fake.on("GET", f"{P}/status", reply)
    r = await client.get(f"{B}/status")
    assert r.status_code == 501
    assert r.json()["code"] == "update_unavailable" and r.json()["vars"] == {"reason": "unsupported"}


async def test_unreachable_and_rejected_keep_their_codes(env, monkeypatch):
    client, fake, _ = env

    def boom(request):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(boom))
    r = await client.get(f"{B}/status")
    assert r.status_code == 503 and r.json()["code"] == "installer_unreachable"

    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(fake.handler))
    fake.on("GET", f"{P}/status", (404, {"code": "not_found", "vars": {}}))
    r = await client.get(f"{B}/status")
    assert r.status_code == 502 and r.json()["code"] == "installer_rejected"


async def test_installer_errors_are_passed_through(env):
    client, fake, state = env
    fake.on("POST", f"{P}/apply", (409, {"code": "busy", "vars": {"job": "zz"}}))
    r = await client.post(f"{B}/apply", json={"target": "1.1.0"})
    assert r.status_code == 409
    assert r.json() == {"code": "busy", "vars": {"job": "zz"}, "detail": update_router.MESSAGES["busy"]}
    assert r.headers["cache-control"] == "no-store"

    fake.on("POST", f"{P}/apply", (409, {"code": "target_stale", "vars": {"target": "1.2.0"}}))
    assert (await client.post(f"{B}/apply", json={"target": "1.1.0"})).json()["vars"] == {"target": "1.2.0"}

    fake.on("PUT", f"{P}/settings", (422, {"code": "settings_invalid", "vars": {"errors": [{"field": "window", "code": "same"}]}}))
    r = await client.put(f"{B}/settings", json={"window": {"start": "03:00", "end": "03:00"}})
    assert r.status_code == 422 and r.json()["vars"]["errors"][0]["field"] == "window"

    fake.on("GET", f"{P}/jobs/{JOB_ID}", (500, {"code": "boom", "vars": {}}))
    r = await client.get(f"{B}/jobs/{JOB_ID}")
    assert r.status_code == 502 and r.json()["code"] == "installer_error"
    # 실패한 요청은 감사 로그에 기록되지 않음
    assert await _audit(state) == []


# ─── 적용 · 작업 제어 · 감사 ───


async def test_apply_sends_actor_and_audits(env):
    client, fake, state = env
    fake.on("POST", f"{P}/apply", (202, job()))
    r = await client.post(f"{B}/apply", json={"target": "1.1.0", "start": "now", "actor": {"id": "forged"}, "x": 1})
    assert r.status_code == 202 and r.json()["id"] == JOB_ID
    sent = fake.last(f"{P}/apply")
    assert sent["key"] == KEY
    assert sent["body"] == {"target": "1.1.0", "start": "now", "actor": {"id": "root", "name": "루트"}}
    (log,) = await _audit(state)
    assert log.action == "system.update.apply" and log.actor_id == "root"
    assert log.resource_type == "update" and log.resource_id == JOB_ID


async def test_apply_defaults_to_countdown(env):
    client, fake, _ = env
    fake.on("POST", f"{P}/apply", (202, job()))
    await client.post(f"{B}/apply", json={"target": "1.1.0"})
    assert fake.last(f"{P}/apply")["body"]["start"] == "countdown"


@pytest.mark.parametrize("action", ["start_now", "cancel", "retry", "rollback"])
async def test_job_actions_are_proxied_and_audited(env, action):
    client, fake, state = env
    fake.on("POST", f"{P}/jobs/{JOB_ID}/action", job(status="running", rollback_job="r1" if action == "rollback" else None))
    r = await client.post(f"{B}/jobs/{JOB_ID}/action", json={"action": action})
    assert r.status_code == 200
    assert fake.last(f"{P}/jobs/{JOB_ID}/action")["body"] == {"action": action, "actor": {"id": "root", "name": "루트"}}
    (log,) = await _audit(state)
    assert log.action == f"system.update.{action}" and log.resource_id == JOB_ID


async def test_unknown_action_is_rejected_here(env):
    client, fake, state = env
    r = await client.post(f"{B}/jobs/{JOB_ID}/action", json={"action": "delete"})
    assert r.status_code == 422 and r.json()["code"] == "invalid"
    assert fake.calls == [] and await _audit(state) == []


async def test_job_and_log_are_proxied(env):
    client, fake, _ = env
    fake.on("GET", f"{P}/jobs/{JOB_ID}", job(status="running"))
    fake.on("GET", f"{P}/jobs/{JOB_ID}/log", lambda request: httpx.Response(
        200, text="[pull] 시작\n[pull] 실패\n") if request.url.params.get("format") == "text"
        else httpx.Response(200, json={"lines": ["[pull] 시작", 7]}))
    assert (await client.get(f"{B}/jobs/{JOB_ID}")).json()["status"] == "running"
    r = await client.get(f"{B}/jobs/{JOB_ID}/log", params={"tail": 50})
    assert r.json() == {"lines": ["[pull] 시작", "7"]}
    assert fake.last(f"{P}/jobs/{JOB_ID}/log")["query"] == {"tail": "50"}

    r = await client.get(f"{B}/jobs/{JOB_ID}/log/download")
    assert r.status_code == 200 and r.text == "[pull] 시작\n[pull] 실패\n"
    assert r.headers["content-type"].startswith("text/plain")
    assert f"update-{JOB_ID}.log" in r.headers["content-disposition"]
    assert fake.last(f"{P}/jobs/{JOB_ID}/log")["query"] == {"format": "text"}


async def test_settings_change_is_audited_and_beta_restore_counts_as_restore(env):
    client, fake, state = env
    settings = {"mode": "auto", "window": {"start": "02:00", "end": "04:00"}, "channel": "beta", "min_age_days": 3,
                "beta": {"since": None, "restore_point": None}}
    fake.on("GET", f"{P}/settings", settings)
    fake.on("PUT", f"{P}/settings", {"settings": settings, "effect": {"channel": "to_beta", "wait": None, "job": None}})
    assert (await client.get(f"{B}/settings")).json() == settings
    r = await client.put(f"{B}/settings", json={"mode": "auto", "window": {"start": "02:00", "end": "04:00"},
                                                "channel": "beta", "min_age_days": 0})
    assert r.status_code == 200 and r.json()["effect"]["channel"] == "to_beta"
    assert fake.last(f"{P}/settings")["body"] == {"mode": "auto", "window": {"start": "02:00", "end": "04:00"},
                                                  "channel": "beta", "actor": {"id": "root", "name": "루트"}}
    (log,) = await _audit(state)
    assert log.action == "system.update.settings"

    restore = job(kind="restore", restore={"point": "rp-beta", "version": "1.0.0", "reason": "beta"})
    fake.on("PUT", f"{P}/settings", (202, {"settings": settings, "effect": {"channel": "to_stable_restore", "wait": None, "job": restore}}))
    r = await client.put(f"{B}/settings", json={"channel": "stable", "stable_return": "restore"})
    assert r.status_code == 202 and r.json()["effect"]["job"]["kind"] == "restore"
    actions = [x.action for x in await _audit(state)]
    assert actions == ["system.update.settings", "system.update.settings", "system.update.restore"]


async def test_restore_and_auto_resume_are_audited(env):
    client, fake, state = env
    fake.on("POST", f"{P}/restore", (202, job(kind="restore")))
    fake.on("POST", f"{P}/auto/resume", {"auto": {"paused": False}, "window": {"start": "03:00", "end": "05:00"}})
    r = await client.post(f"{B}/restore", json={"point": "rp-20260110"})
    assert r.status_code == 202
    assert fake.last(f"{P}/restore")["body"] == {"point": "rp-20260110", "start": "countdown",
                                                 "actor": {"id": "root", "name": "루트"}}
    assert (await client.post(f"{B}/auto/resume")).json()["auto"]["paused"] is False
    assert [x.action for x in await _audit(state)] == ["system.update.restore", "system.update.auto_resume"]


# ─── 오프라인 ───


async def test_bundle_upload_is_streamed_through(env):
    client, fake, state = env
    fake.on("POST", f"{P}/offline/bundle", (202, {"bundle": {"state": "verifying"}, "images": [], "ready": False}))
    payload = b"\x00\x01bundle-bytes" * 1000
    r = await client.post(f"{B}/offline/bundle", content=payload,
                          headers={"X-JW-Filename": "just workspace-1.2.0-offline.tar",
                                   "Content-Type": "application/octet-stream"})
    assert r.status_code == 202 and r.json()["bundle"]["state"] == "verifying"
    sent = fake.last(f"{P}/offline/bundle")
    assert sent["raw"] == payload and sent["key"] == KEY
    assert sent["headers"]["x-jw-filename"] == "just%20workspace-1.2.0-offline.tar"
    assert sent["headers"]["content-length"] == str(len(payload))
    (log,) = await _audit(state)
    assert log.action == "system.update.offline_bundle"


async def test_upload_needs_a_plain_filename(env):
    client, fake, _ = env
    r = await client.post(f"{B}/offline/bundle", content=b"x")
    assert r.status_code == 422 and r.json()["vars"] == {"field": "filename"}
    fake.on("POST", f"{P}/offline/images/postgres", (202, {"bundle": None, "images": [], "ready": False}))
    r = await client.post(f"{B}/offline/images/postgres", content=b"img", headers={"X-JW-Filename": "../../etc/postgres.tar"})
    assert r.status_code == 202
    assert fake.last(f"{P}/offline/images/postgres")["headers"]["x-jw-filename"] == "postgres.tar"


async def test_bundle_path_clear_and_apply(env):
    client, fake, state = env
    fake.on("POST", f"{P}/offline/bundle-path", (202, {"bundle": {"state": "verifying", "source": "path"}}))
    fake.on("DELETE", f"{P}/offline/bundle", {"bundle": None, "images": [], "ready": False})
    fake.on("POST", f"{P}/offline/apply", (202, job(trigger="offline")))
    r = await client.post(f"{B}/offline/bundle-path", json={"path": " /data/in/bundle.tar "})
    assert r.status_code == 202
    assert fake.last(f"{P}/offline/bundle-path")["body"]["path"] == "/data/in/bundle.tar"
    assert (await client.post(f"{B}/offline/bundle-path", json={"path": ""})).status_code == 422
    assert (await client.delete(f"{B}/offline/bundle")).json()["bundle"] is None
    r = await client.post(f"{B}/offline/apply")
    assert r.status_code == 202 and r.json()["trigger"] == "offline"
    assert fake.last(f"{P}/offline/apply")["body"] == {"start": "countdown", "actor": {"id": "root", "name": "루트"}}

    fake.on("POST", f"{P}/offline/apply", (409, {"code": "offline_incomplete", "vars": {"blockers": ["images_missing"]}}))
    r = await client.post(f"{B}/offline/apply", json={"start": "now"})
    assert r.status_code == 409 and r.json()["vars"]["blockers"] == ["images_missing"]
    assert [x.action for x in await _audit(state)] == [
        "system.update.offline_bundle", "system.update.offline_clear", "system.update.offline_apply"]


# ─── 연락처 ───


async def test_contact_is_stored_and_pushed_to_installer(env):
    client, fake, state = env
    fake.on("PUT", f"{P}/maintenance/contact", {"ok": True})
    assert (await client.get(f"{B}/contact")).json() == {"contact": None}
    r = await client.put(f"{B}/contact", json={"contact": "  내선\n1234  "})
    assert r.json() == {"contact": "내선 1234", "synced": True}
    assert fake.last(f"{P}/maintenance/contact")["body"] == {"contact": "내선 1234"}
    assert (await client.get(f"{B}/contact")).json() == {"contact": "내선 1234"}

    r = await client.put(f"{B}/contact", json={"contact": ""})
    assert r.json() == {"contact": None, "synced": True}
    async with state.factory() as s:
        assert await get_setting(s, update_router.CONTACT_KEY) is None
    assert (await client.put(f"{B}/contact", json={"contact": "x" * 201})).status_code == 422
    assert [x.action for x in await _audit(state)] == ["system.update.contact"] * 2


async def test_contact_is_kept_even_without_installer(env, monkeypatch):
    client, _, _ = env
    monkeypatch.delenv(installer_client.ENV_URL)
    r = await client.put(f"{B}/contact", json={"contact": "내선 1234"})
    assert r.status_code == 200 and r.json() == {"contact": "내선 1234", "synced": False}
