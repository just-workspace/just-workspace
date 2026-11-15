"""저장소 표식 확인(app/middleware/storage_guard.py)과 제품 버전(app/version.py)."""
import json

from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from app.middleware import storage_guard as sg


async def _ok(request):
    return PlainTextResponse("ok")


def _app(root, install_id=""):
    inner = Starlette(routes=[
        Route("/api/files/upload", _ok, methods=["GET", "POST"]),
        Route("/api/files/list", _ok, methods=["GET"]),
        Route("/api/files", _ok, methods=["DELETE"]),
        Route("/api/filesx", _ok, methods=["POST"]),
        Route("/api/wopi/files/abc/contents", _ok, methods=["POST"]),
        Route("/api/auth/login", _ok, methods=["POST"]),
    ])
    return sg.StorageMarkerGuard(inner, root=str(root), install_id=install_id, cache_seconds=0)


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def test_required_flag():
    assert sg.required({"STORAGE_MARKER_REQUIRED": "1"})
    assert sg.required({"STORAGE_MARKER_REQUIRED": "true"})
    assert not sg.required({"STORAGE_MARKER_REQUIRED": "0"})
    assert not sg.required({})


def test_check_marker(tmp_path):
    assert sg.check_marker(tmp_path) == "missing"
    (tmp_path / sg.MARKER_NAME).write_text(json.dumps({"install_id": "abc"}), encoding="utf-8")
    assert sg.check_marker(tmp_path) is None
    assert sg.check_marker(tmp_path, "abc") is None
    assert sg.check_marker(tmp_path, "other") == "mismatch"
    (tmp_path / sg.MARKER_NAME).write_text("not json", encoding="utf-8")
    assert sg.check_marker(tmp_path) is None            # 설치 id 를 안 보면 있기만 하면 된다
    assert sg.check_marker(tmp_path, "abc") == "unreadable"


async def test_write_refused_without_marker(tmp_path):
    async with _client(_app(tmp_path)) as c:
        r = await c.post("/api/files/upload")
        assert r.status_code == 503
        assert r.json()["code"] == sg.ERROR_CODE
        assert r.json()["reason"] == "missing"
        assert r.headers["retry-after"] == "30"
        assert (await c.delete("/api/files")).status_code == 503
        assert (await c.post("/api/wopi/files/abc/contents")).status_code == 503


async def test_reads_and_other_paths_pass_without_marker(tmp_path):
    async with _client(_app(tmp_path)) as c:
        assert (await c.get("/api/files/upload")).status_code == 200
        assert (await c.get("/api/files/list")).status_code == 200
        assert (await c.post("/api/auth/login")).status_code == 200
        assert (await c.post("/api/filesx")).status_code == 200   # 이웃 경로는 해당 없음


async def test_write_passes_with_marker(tmp_path):
    (tmp_path / sg.MARKER_NAME).write_text(json.dumps({"install_id": "abc"}), encoding="utf-8")
    async with _client(_app(tmp_path, "abc")) as c:
        assert (await c.post("/api/files/upload")).status_code == 200
    async with _client(_app(tmp_path, "other")) as c:
        r = await c.post("/api/files/upload")
        assert r.status_code == 503 and r.json()["reason"] == "mismatch"


async def test_marker_comes_back(tmp_path):
    app = _app(tmp_path)
    async with _client(app) as c:
        assert (await c.post("/api/files/upload")).status_code == 503
        (tmp_path / sg.MARKER_NAME).write_text("{}", encoding="utf-8")
        assert (await c.post("/api/files/upload")).status_code == 200


def test_cache_reuses_result(tmp_path):
    guard = sg.StorageMarkerGuard(None, root=str(tmp_path), install_id="", cache_seconds=60)
    assert guard.problem() == "missing"
    (tmp_path / sg.MARKER_NAME).write_text("{}", encoding="utf-8")
    assert guard.problem() == "missing"       # 캐시 시간 안에서는 다시 보지 않는다


async def test_unresponsive_storage_is_refused_without_hanging(tmp_path):
    """끊긴 NFS(hard 마운트)처럼 표식 읽기가 돌아오지 않을 때 — 요청이 멈추지 않고 503 으로 거부된다."""
    import threading
    import time

    release = threading.Event()
    calls = []

    def stuck(root, install_id=""):
        calls.append(1)
        release.wait(30)                       # 저장소가 돌아올 때까지 돌아오지 않는 읽기
        return sg.check_marker(root, install_id)

    (tmp_path / sg.MARKER_NAME).write_text("{}", encoding="utf-8")
    inner = Starlette(routes=[Route("/api/files/upload", _ok, methods=["POST"]),
                              Route("/api/auth/login", _ok, methods=["POST"])])
    app = sg.StorageMarkerGuard(inner, root=str(tmp_path), install_id="", cache_seconds=0,
                                check_timeout=0.3, checker=stuck)
    async with _client(app) as c:
        t0 = time.monotonic()
        r = await c.post("/api/files/upload")
        assert r.status_code == 503 and r.json()["code"] == sg.ERROR_CODE
        assert r.json()["reason"] == "unresponsive"
        assert time.monotonic() - t0 < 5
        # 답이 없는 동안의 다음 요청은 새로 읽지 않고 바로 거부된다(멈춘 읽기는 하나뿐)
        t1 = time.monotonic()
        assert (await c.post("/api/files/upload")).status_code == 503
        assert time.monotonic() - t1 < 0.25 and len(calls) == 1
        assert (await c.post("/api/auth/login")).status_code == 200       # 저장소와 무관한 요청은 그대로
        # 저장소가 돌아오면(멈춘 읽기가 끝나면) 다시 받는다
        release.set()
        for _ in range(50):
            if (await c.post("/api/files/upload")).status_code == 200:
                break
            time.sleep(0.05)
        assert (await c.post("/api/files/upload")).status_code == 200


async def test_notify_admins_never_raises():
    # DB·Redis 에 닿지 못해도 예외를 밖으로 내지 않는다
    assert isinstance(await sg.notify_admins("missing"), int)


def test_guard_registered_only_when_required(monkeypatch):
    from app import main

    monkeypatch.delenv("STORAGE_MARKER_REQUIRED", raising=False)
    plain = main.create_app() if hasattr(main, "create_app") else None
    if plain is None:
        return
    names = [m.cls.__name__ for m in plain.user_middleware]
    assert "StorageMarkerGuard" not in names
    monkeypatch.setenv("STORAGE_MARKER_REQUIRED", "1")
    names = [m.cls.__name__ for m in main.create_app().user_middleware]
    assert "StorageMarkerGuard" in names


def test_version_reads_env_then_file(tmp_path):
    from app import version as v

    assert v.read_version({"JW_APP_VERSION": "v1.2.3"}) == "1.2.3"
    assert v.read_version({"JW_APP_VERSION": "bad value!"}, here=tmp_path / "a" / "app" / "version.py") == v.DEV_VERSION
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "VERSION").write_text("2.0.0\n", encoding="utf-8")
    assert v.read_version({}, here=tmp_path / "a" / "app" / "version.py") == "2.0.0"
    assert v.read_version({}, here=tmp_path / "x" / "y" / "app" / "version.py") == v.DEV_VERSION
    assert v.APP_VERSION        # 체크아웃·이미지 어디서든 비어 있지 않다
