"""관리 › 저장소 상태 — 종류·위치 읽기, 표식·쓰기·잠금 확인, 응답 없는 저장소, 끊긴 시각, 사용자용 조회."""

import json
import os
import sys
import threading
import types

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth.deps import get_current_user
from app.db.models import Base, User
from app.db.session import get_db
from app.middleware import storage_guard
from app.system import installer_client
from app.system import router as system_router
from app.system import storage_status
from app.system.storage_status import StorageProber

MOUNTINFO = """\
22 1 8:2 / / rw,relatime - overlay overlay rw,lowerdir=/a,upperdir=/b
30 22 0:5 / /proc rw - proc proc rw
41 22 8:2 /var/lib/docker/volumes/ws-storage-data/_data /storage rw,relatime - ext4 /dev/sda2 rw
42 22 0:60 / /nfs rw,noatime - nfs4 nas.example.com:/volume1/workspace rw,vers=4.1,hard
43 22 8:2 /srv/team\\040files /bind rw - ext4 /dev/sda2 rw
44 22 0:61 / /storage/deep rw - nfs4 nas.example.com:/deep rw
"""


def test_describe_reads_kind_and_location_without_touching_storage():
    d = storage_status.describe
    assert d("/storage", MOUNTINFO) == {"kind": "local", "location": "/var/lib/docker/volumes/ws-storage-data/_data"}
    assert d("/nfs", MOUNTINFO) == {"kind": "nfs", "location": "nas.example.com:/volume1/workspace"}
    assert d("/nfs/", MOUNTINFO)["kind"] == "nfs"
    assert d("/bind", MOUNTINFO) == {"kind": "local", "location": "/srv/team files"}
    assert d("/storage/deep/x", MOUNTINFO) == {"kind": "nfs", "location": "nas.example.com:/deep"}
    assert d("/storagex", MOUNTINFO) == {"kind": "local", "location": None}      # 경계는 "/" 까지
    assert d("/elsewhere", MOUNTINFO) == {"kind": "local", "location": None}
    assert d("/storage", "") == {"kind": "local", "location": None}
    assert d("/storage", "garbage line\n\n") == {"kind": "local", "location": None}


def _marker(root, install_id="inst-1"):
    (root / storage_guard.MARKER_NAME).write_text(json.dumps({"install_id": install_id}), encoding="utf-8")


def test_probe_checks_marker_then_writes(tmp_path):
    _marker(tmp_path)
    got = storage_status.probe(str(tmp_path), "inst-1", True)
    assert got["reason"] is None and got["write"] is True and got["free_bytes"] > 0
    assert got["total_bytes"] >= got["used_bytes"]
    if os.name != "nt":
        assert got["lock"] is True
    assert sorted(p.name for p in tmp_path.iterdir()) == [storage_guard.MARKER_NAME]     # 시험 파일은 남지 않는다


def test_probe_never_writes_where_the_marker_is_missing(tmp_path):
    assert storage_status.probe(str(tmp_path), "inst-1", True) == {"reason": "missing"}
    assert list(tmp_path.iterdir()) == []            # 끊긴 자리의 빈 폴더에 쓰지 않는다
    _marker(tmp_path, "other-install")
    assert storage_status.probe(str(tmp_path), "inst-1", True) == {"reason": "mismatch"}
    assert storage_status.probe_marker(str(tmp_path), "inst-1", True) == {"reason": "mismatch"}
    # 표식을 쓰지 않는 설치 — 폴더가 있으면 정상
    assert storage_status.probe(str(tmp_path), "", False)["reason"] is None
    assert storage_status.probe(str(tmp_path / "gone"), "", False) == {"reason": "missing"}
    assert storage_status.probe_marker(str(tmp_path / "gone"), "", False) == {"reason": None}


@pytest.mark.skipif(os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0), reason="권한 비트가 안 먹는 환경")
def test_read_only_storage_reports_write_false(tmp_path):
    _marker(tmp_path)
    tmp_path.chmod(0o555)
    try:
        got = storage_status.probe(str(tmp_path), "inst-1", True)
    finally:
        tmp_path.chmod(0o755)
    assert got["reason"] is None and got["write"] is False and got["lock"] is None


@pytest.mark.asyncio
async def test_unresponsive_storage_does_not_hang_or_pile_up(tmp_path):
    release = threading.Event()
    started = []

    def stuck(root, install_id, guarded):
        started.append(1)
        release.wait(10)
        return {"reason": None, "total_bytes": 100, "used_bytes": 40, "free_bytes": 60, "write": True, "lock": True}

    prober = StorageProber(root=str(tmp_path), install_id="", guarded=True, timeout=0.2, cache_seconds=0.0, probe_fn=stuck)
    status = await prober.status()
    assert status["state"] == "down" and status["reason"] == "unresponsive" and status["free_bytes"] is None
    assert status["checked_at"]
    assert (await prober.status(force=True))["reason"] == "unresponsive"
    assert len(started) == 1                         # 멈춘 확인은 하나만 둔다
    release.set()
    for _ in range(50):
        status = await prober.status(force=True)
        if status["state"] == "ok":
            break
    assert status["state"] == "ok" and status["free_bytes"] == 60 and status["write"] is True


@pytest.mark.asyncio
async def test_prober_caches_and_force_rechecks(tmp_path):
    calls = []

    def fn(root, install_id, guarded):
        calls.append(1)
        return {"reason": None, "total_bytes": 1, "used_bytes": 0, "free_bytes": 1, "write": True, "lock": True}

    def broken(root, install_id, guarded):
        raise RuntimeError("boom")

    prober = StorageProber(root=str(tmp_path), install_id="", guarded=False, cache_seconds=60, probe_fn=fn)
    await prober.status()
    await prober.status()
    assert len(calls) == 1
    await prober.status(force=True)
    assert len(calls) == 2
    bad = StorageProber(root=str(tmp_path), install_id="", guarded=True, probe_fn=broken)
    assert (await bad.status())["reason"] == "unreadable"


# ─── API ───


@pytest.fixture()
async def env(monkeypatch, tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as s:
        s.add(User(id="root", username="root", email="root@x", password_hash="x", is_admin=True))
        s.add(User(id="alice", username="alice", email="alice@x", password_hash="x"))
        await s.commit()
    state = types.SimpleNamespace(user="root", root=tmp_path)

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
    kwargs = dict(root=str(tmp_path), install_id="inst-1", guarded=True, cache_seconds=0.0)
    monkeypatch.setattr(storage_status, "prober", StorageProber(**kwargs))
    monkeypatch.setattr(storage_status, "light_prober", StorageProber(probe_fn=storage_status.probe_marker, **kwargs))
    monkeypatch.setattr(system_router, "_seen_down", None)
    # 설치 관리자 없이 구성한 설치가 기본 — 설치 관리자의 답을 쓰는 경우는 테스트가 따로 붙인다
    monkeypatch.delenv(installer_client.ENV_URL, raising=False)
    monkeypatch.delenv(installer_client.ENV_KEY, raising=False)
    monkeypatch.setattr(storage_status, "_installer_seen", None)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client, state
    await engine.dispose()


@pytest.mark.asyncio
async def test_storage_api_tracks_when_it_went_down(env):
    client, state = env
    _marker(state.root)
    r = await client.get("/api/admin/system/storage")
    assert r.status_code == 200
    ok = r.json()
    assert ok["state"] == "ok" and ok["reason"] is None and ok["guarded"] is True and ok["write"] is True
    assert ok["down_since"] is None and ok["checked_at"] and ok["kind"] in ("local", "nfs")
    assert ok["free_bytes"] > 0 and ok["total_bytes"] >= ok["used_bytes"]

    (state.root / storage_guard.MARKER_NAME).unlink()
    down = (await client.get("/api/admin/system/storage")).json()
    assert down["state"] == "down" and down["reason"] == "missing" and down["free_bytes"] is None
    assert down["write"] is None and down["down_since"]
    again = (await client.post("/api/admin/system/storage/recheck")).json()
    assert again["state"] == "down" and again["down_since"] == down["down_since"]     # 처음 본 시각을 지킨다

    _marker(state.root)
    back = (await client.post("/api/admin/system/storage/recheck")).json()
    assert back["state"] == "ok" and back["down_since"] is None


@pytest.mark.asyncio
async def test_kind_and_location_come_from_the_installer_when_it_answers(env, monkeypatch):
    client, state = env
    _marker(state.root)
    first = (await client.get("/api/admin/system/storage")).json()
    assert first["source"] == "mountinfo" and first["volume"] is None      # 설치 관리자 없음 → 마운트 정보의 추정

    calls: list[str] = []
    answer: dict = {"status": 200, "body": {"kind": "nfs", "location": "nas.example.com:/volume1/workspace",
                                           "volume": "ws-storage-data", "install_id": "never-shown"}}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path} {request.headers.get('x-jw-installer-key')}")
        return httpx.Response(answer["status"], json=answer["body"])

    monkeypatch.setenv(installer_client.ENV_URL, "http://jw-installer:8444")
    monkeypatch.setenv(installer_client.ENV_KEY, "shared-key-for-tests")
    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(handler))

    got = (await client.get("/api/admin/system/storage")).json()
    assert calls == ["GET /internal/storage shared-key-for-tests"]
    assert (got["kind"], got["location"], got["volume"], got["source"]) == (
        "nfs", "nas.example.com:/volume1/workspace", "ws-storage-data", "installer")
    assert "install_id" not in got and got["state"] == "ok"                # 연결 판정은 그대로 이 서버가 한다
    await client.get("/api/admin/system/storage")
    assert len(calls) == 1                                                 # 바뀌지 않는 값이라 잠시 기억한다

    # 위치를 모르는 답이면 종류만 쓰고 위치는 추정값을 둔다
    answer["body"] = {"kind": "local", "location": None, "volume": "ws-storage-data"}
    got = (await client.post("/api/admin/system/storage/recheck")).json()   # 다시 확인은 기억한 값을 쓰지 않는다
    assert len(calls) == 2
    assert got["kind"] == "local" and got["location"] == first["location"] and got["source"] == "installer"

    # 답이 없거나 알 수 없는 답이면 추정으로 떨어지고, 한동안 다시 묻지 않는다
    for status, body in ((500, {"code": "unexpected_error", "vars": {}}), (404, {"detail": "Not Found"}),
                         (200, {"kind": "tape"})):
        answer.update(status=status, body=body)
        got = (await client.post("/api/admin/system/storage/recheck")).json()
        assert got["source"] == "mountinfo" and got["volume"] is None and got["kind"] == first["kind"], status
    asked = len(calls)
    assert (await client.get("/api/admin/system/storage")).json()["source"] == "mountinfo"
    assert len(calls) == asked


@pytest.mark.asyncio
async def test_public_status_for_any_user_and_admin_only_details(env):
    client, state = env
    state.user = "alice"
    assert (await client.get("/api/admin/system/storage")).status_code == 403
    assert (await client.post("/api/admin/system/storage/recheck")).status_code == 403

    r = await client.get("/api/system/storage-status")
    assert r.status_code == 200 and r.json() == {"guarded": True, "available": False, "reason": "missing"}
    assert r.headers["cache-control"] == "no-store"
    assert list(state.root.iterdir()) == []          # 사용자용 조회는 저장소에 쓰지 않는다
    # 사용자 조회가 먼저 봤어도 끊긴 시각이 남는다
    state.user = "root"
    assert (await client.get("/api/admin/system/storage")).json()["down_since"]

    _marker(state.root)
    state.user = "alice"
    assert (await client.get("/api/system/storage-status")).json() == {"guarded": True, "available": True, "reason": None}
    assert sorted(p.name for p in state.root.iterdir()) == [storage_guard.MARKER_NAME]


@pytest.mark.asyncio
async def test_public_status_without_marker_guard_is_always_available(env, monkeypatch, tmp_path):
    client, state = env
    monkeypatch.setattr(storage_status, "light_prober",
                        StorageProber(root=str(tmp_path / "gone"), install_id="", guarded=False))
    state.user = "alice"
    assert (await client.get("/api/system/storage-status")).json() == {"guarded": False, "available": True, "reason": None}
