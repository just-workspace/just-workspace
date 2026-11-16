"""회귀 — 레이트리밋 카운터는 워커 공유 저장소(Redis)에 저장되며, 기본 한도가 실제로 적용된다."""

import pytest
from httpx import ASGITransport, AsyncClient
from limits.storage import MemoryStorage
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from app import rate_limit
from app.auth.deps import sign_value


def test_storage_defaults_to_redis(monkeypatch):
    monkeypatch.delenv("RATE_LIMIT_STORAGE_URI", raising=False)
    assert rate_limit.storage_uri().startswith("redis://")


def test_main_app_has_default_limit_middleware():
    from app.main import app
    assert any(m.cls is rate_limit.DefaultRateLimitMiddleware for m in app.user_middleware)


def _app(storage, limit="3/minute"):
    async def ok(_req):
        return PlainTextResponse("ok")
    inner = Starlette(routes=[Route("/api/x", ok), Route("/api/internal/mail-auth", ok), Route("/static", ok)])
    return rate_limit.DefaultRateLimitMiddleware(inner, limit=limit, storage=storage)


async def _codes(app, n, headers=None, path="/api/x"):
    async with AsyncClient(transport=ASGITransport(app=app, client=("203.0.113.7", 1)), base_url="http://t") as c:
        return [(await c.get(path, headers=headers or {})).status_code for _ in range(n)]


async def test_default_limit_applies_and_is_shared_between_workers():
    shared = MemoryStorage()   # 운영 환경에서는 Redis — 워커 2개가 동일 저장소를 참조
    w1, w2 = _app(shared), _app(shared)
    assert await _codes(w1, 2) == [200, 200]
    assert await _codes(w2, 2) == [200, 429]


async def test_forged_session_values_do_not_reset_the_bucket():
    app = _app(MemoryStorage())
    codes = []
    for i in range(4):
        codes += await _codes(app, 1, headers={"cookie": f"ws_session=forged-{i}"})
    assert codes[-1] == 429


async def test_signed_sessions_get_their_own_bucket():
    app = _app(MemoryStorage())
    a = sign_value({"user_id": "a", "tv": 0, "sid": "s"})
    b = sign_value({"user_id": "b", "tv": 0, "sid": "s"})
    assert await _codes(app, 3, headers={"cookie": f"ws_session={a}"}) == [200, 200, 200]
    assert await _codes(app, 1, headers={"cookie": f"ws_session={a}"}) == [429]
    assert await _codes(app, 1, headers={"authorization": f"Bearer {b}"}) == [200]


async def test_internal_and_non_api_paths_exempt():
    app = _app(MemoryStorage(), limit="1/minute")
    assert await _codes(app, 3, path="/api/internal/mail-auth") == [200, 200, 200]
    assert await _codes(app, 3, path="/static") == [200, 200, 200]
