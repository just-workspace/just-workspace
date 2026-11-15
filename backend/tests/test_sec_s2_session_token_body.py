"""회귀 — 웹(같은 출처) 로그인 응답 본문에는 세션 토큰이 없다(httpOnly 쿠키만). 번들 앱·CLI 는 그대로."""

import json

import pytest
from starlette.requests import Request

from app.auth import router as auth_router
from app.auth import sessions as sess_mod
from app.db.models import User


def _req(origin=None, host="ws.example.com"):
    headers = [(b"host", host.encode()), (b"user-agent", b"t")]
    if origin:
        headers.append((b"origin", origin.encode()))
    return Request({"type": "http", "method": "POST", "path": "/api/auth/login", "query_string": b"",
                    "headers": headers, "client": ("10.0.0.1", 1), "server": ("ws.example.com", 443),
                    "scheme": "https"})


@pytest.fixture(autouse=True)
def _sess(monkeypatch):
    async def _create(*a, **k):
        return "sid-1"

    async def _host(ip):
        return ""
    monkeypatch.setattr(sess_mod, "create_session", _create)
    monkeypatch.setattr(sess_mod, "resolve_hostname", _host)


async def _body(req):
    u = User(id="u1", username="u", token_version=0)
    r = await auth_router._session_response(req, u)
    return json.loads(r.body), r.headers.get("set-cookie", "")


async def test_web_origin_gets_cookie_only():
    body, cookie = await _body(_req(origin="https://ws.example.com"))
    assert "token" not in body
    assert "ws_session=" in cookie and "httponly" in cookie.lower()


@pytest.mark.parametrize("origin", ["capacitor://localhost", "tauri://localhost", "http://localhost", None])
async def test_bundled_app_and_cli_still_get_token(origin):
    body, _ = await _body(_req(origin=origin))
    assert body.get("token")
