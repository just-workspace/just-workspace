"""요청 번호(X-Request-ID) 미들웨어 — 헤더 부여·프런트 프록시 값 재사용·미처리 예외의 500 JSON."""

import os
import sys
import types

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

# Windows 로컬 실행용(파일 색인이 resource 를 import) — 리눅스에서는 실제 모듈 사용
if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

from app.middleware.request_id import RequestIdMiddleware, new_request_id, pick_request_id


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/ok")
    async def ok():
        return {"ok": True}

    @app.get("/boom")
    async def boom():
        raise RuntimeError("터짐")

    app.add_middleware(RequestIdMiddleware)
    return app


def test_new_request_id_shape():
    rid = new_request_id()
    assert len(rid) == 9 and rid[4] == "-"


def test_pick_request_id_rejects_unsafe():
    assert pick_request_id("abcd-1234") == "abcd-1234"
    bad = pick_request_id("<script>alert(1)</script>")
    assert bad != "<script>alert(1)</script>" and len(bad) == 9
    assert len(pick_request_id(None)) == 9
    assert len(pick_request_id("x" * 200)) == 9


@pytest.mark.asyncio
async def test_header_on_every_response():
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://t") as c:
        r = await c.get("/ok")
        assert r.status_code == 200
        assert len(r.headers["x-request-id"]) == 9
        r2 = await c.get("/ok", headers={"X-Request-ID": "front-1234"})
        assert r2.headers["x-request-id"] == "front-1234"


@pytest.mark.asyncio
async def test_unhandled_error_returns_json_with_request_id():
    transport = ASGITransport(app=_app(), raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/boom")
        assert r.status_code == 500
        body = r.json()
        assert body["request_id"] == r.headers["x-request-id"]
        assert body["detail"] == "Internal Server Error"


@pytest.mark.asyncio
async def test_main_app_has_request_id(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.headers.get("x-request-id")
