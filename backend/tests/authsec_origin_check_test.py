"""세션 쿠키로 인증된 상태 변경 요청의 Origin 검사(app/middleware/origin_check.py) 고정.

- 쿠키 + 남의 출처(같은 사이트의 다른 하위 도메인 포함) → 403
- 우리 출처·Host 와 같은 출처·CORS 허용 목록·추가 신뢰 출처 → 통과
- 쿠키 없음 / Bearer / Origin·Referer 둘 다 없음 / 안전한 메서드 / 밖에서 부르는 경로 / rbi 출처 → 검사 안 함
- 끄는 스위치
"""

import pytest

from app.middleware import origin_check
from app.middleware.origin_check import CookieOriginGuard

COOKIE = "theme=dark; ws_session=abc.def; other=1"


class _S:
    """get_settings() 대역 — 운영처럼 https 공개 주소."""

    app_url = "https://ws.example.com"
    debug = False
    csrf_origin_check = True
    csrf_trusted_origins = "https://alt.example.com/ , "
    rbi_public_origin = "https://rbi.example.com"


@pytest.fixture()
def guard(monkeypatch):
    monkeypatch.setattr(origin_check, "get_settings", lambda: _S)
    from app.rbi import site
    monkeypatch.setattr(site, "get_settings", lambda: _S)
    return CookieOriginGuard(None, allowed_origins=["https://ws.example.com", "tauri://localhost", "http://localhost"])


def _h(**kw):
    base = {"cookie": COOKIE, "host": "ws.example.com"}
    base.update(kw)
    return {k: v for k, v in base.items() if v is not None}


def test_foreign_origin_with_cookie_is_refused(guard):
    for origin in ("https://evil.example", "https://sub.ws.example.com", "https://rbi.example.com",
                   "http://ws.example.com",          # https 설치본에서 http 로 내려간 같은 이름
                   "https://ws.example.com:8443",    # 포트가 다르면 다른 출처
                   "null"):
        assert guard.verdict("POST", "/api/auth/change-password", _h(origin=origin)), origin
    for method in ("PUT", "PATCH", "DELETE"):
        assert guard.verdict(method, "/api/files/x", _h(origin="https://evil.example"))


def test_own_and_listed_origins_pass(guard):
    for origin in ("https://ws.example.com", "HTTPS://WS.EXAMPLE.COM", "tauri://localhost", "http://localhost",
                   "https://alt.example.com"):
        assert guard.verdict("POST", "/api/auth/logout", _h(origin=origin)) is None, origin
    # 다른 이름·사설 주소로 접속한 같은 출처 요청(Host 와 일치)
    assert guard.verdict("POST", "/api/x", _h(origin="https://10.0.0.5", host="10.0.0.5")) is None
    assert guard.verdict("POST", "/api/x", _h(origin="https://ws.example.com:8443", host="ws.example.com:8443")) is None


def test_referer_used_only_when_origin_missing(guard):
    assert guard.verdict("POST", "/api/x", _h(referer="https://ws.example.com/settings/account?a=1")) is None
    assert guard.verdict("POST", "/api/x", _h(referer="https://evil.example/page"))
    assert guard.verdict("POST", "/api/x", _h(referer="garbage"))
    # Origin 이 있으면 Referer 로 구제하지 않는다
    assert guard.verdict("POST", "/api/x", _h(origin="https://evil.example", referer="https://ws.example.com/"))


def test_not_checked(guard):
    evil = "https://evil.example"
    # 쿠키가 없다 — 쿠키 인증이 아니다(OAuth 토큰 교환·웹훅·공유 링크 손님·내부 호출)
    assert guard.verdict("POST", "/api/auth/login", {"origin": evil, "host": "ws.example.com"}) is None
    assert guard.verdict("POST", "/api/x", {"origin": evil, "cookie": "xws_session=1; a=b"}) is None
    # Bearer 만 보내는 클라이언트(데스크톱 앱·MCP·API) — 쿠키가 없으니 대상이 아니다
    assert guard.verdict("POST", "/api/x", {"origin": evil, "host": "ws.example.com", "authorization": "Bearer tok"}) is None
    # 쿠키가 실려 있으면 Bearer 가 같이 와도 검사한다 — 인증은 쿠키를 먼저 쓴다(쿠키 + 아무 Bearer 로 우회 금지)
    assert guard.verdict("POST", "/api/x", _h(origin=evil, authorization="Bearer tok"))
    assert guard.verdict("POST", "/api/x", _h(origin=evil, authorization="Basic dTpw"))
    # 쿠키와 Bearer 를 같이 보낼 수 있는 번들 앱의 출처는 허용 목록에 있어 통과한다
    assert guard.verdict("POST", "/api/x", _h(origin="tauri://localhost", authorization="Bearer tok")) is None
    # Origin·Referer 둘 다 없음(비브라우저)
    assert guard.verdict("POST", "/api/x", _h()) is None
    # 안전한 메서드
    for m in ("GET", "HEAD", "OPTIONS"):
        assert guard.verdict(m, "/api/x", _h(origin=evil)) is None


def test_external_endpoints_exempt_but_cookie_ones_are_not(guard):
    evil = "https://partner.example"
    for path in ("/oauth/token", "/oauth/revoke", "/oauth/register", "/api/internal/mail-auth",
                 "/api/webhooks/gitea", "/api/wopi/files/abc/contents", "/api/wopi/files/abc",
                 "/api/mcp", "/api/mcp/messages", "/dav/calendars/kim/x.ics", "/api/meetings/livekit/webhook"):
        assert guard.verdict("POST", path, _h(origin=evil)) is None, path
    # 세션 쿠키로 인증되는 우리 화면의 요청은 예외가 아니다. 접두는 경계까지만(/api/mcp ≠ /api/mcpx, /api/mcp-admin)
    for path in ("/oauth/consent/decide", "/api/wopi/open", "/api/wopi/new", "/api/auth/recovery-email/request",
                 "/api/auth/profile", "/api/admin/users/x", "/api/mcpx", "/api/mcp-admin/keys", "/oauth/token/x",
                 "/api/internal", "/dav"):
        assert guard.verdict("POST", path, _h(origin=evil)), path


def test_rbi_host_is_left_to_its_own_check(guard):
    # 격리 브라우저 전용 출처로 온 요청 — 자체 세션·Origin 검사(app/rbi/site.py)
    h = _h(origin="https://rbi.example.com", host="rbi.example.com")
    assert guard.verdict("POST", "/api/rbi/site/logout", h) is None


def test_debug_allows_local_dev_servers(monkeypatch):
    class _Dev(_S):
        app_url = "http://localhost:8000"
        debug = True
        csrf_trusted_origins = ""
        rbi_public_origin = ""

    monkeypatch.setattr(origin_check, "get_settings", lambda: _Dev)
    g = CookieOriginGuard(None, allowed_origins=[])
    # vite 개발 서버 — 프록시가 Host 를 백엔드 주소로 바꿔 보낸다
    for origin in ("http://localhost:3000", "http://127.0.0.1:5173", "http://localhost:8000"):
        assert g.verdict("POST", "/api/x", {"cookie": COOKIE, "origin": origin, "host": "backend:8000"}) is None
    assert g.verdict("POST", "/api/x", {"cookie": COOKIE, "origin": "https://evil.example", "host": "backend:8000"})
    # http 설치본은 Host 와 같은 http 출처를 받는다
    assert g.verdict("POST", "/api/x", {"cookie": COOKIE, "origin": "http://192.168.10.9", "host": "192.168.10.9"}) is None


# ── ASGI 동작 ──


async def _call(guard_app, method, headers):
    sent = []

    async def _send(msg):
        sent.append(msg)

    async def _recv():
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {"type": "http", "method": method, "path": "/api/auth/profile", "client": ("203.0.113.9", 1),
             "headers": [(k.encode(), v.encode()) for k, v in headers]}
    await guard_app(scope, _recv, _send)
    return sent


@pytest.mark.asyncio
async def test_asgi_blocks_with_403_and_logs(monkeypatch, caplog):
    monkeypatch.setattr(origin_check, "get_settings", lambda: _S)
    reached = []

    async def inner(scope, receive, send):
        reached.append(scope["path"])
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    g = CookieOriginGuard(inner, allowed_origins=[])
    with caplog.at_level("WARNING", logger="app.middleware.origin_check"):
        sent = await _call(g, "PATCH", [("host", "ws.example.com"), ("origin", "https://evil.example"),
                                        ("cookie", "a=1"), ("cookie", "ws_session=s")])   # HTTP/2 식 쿠키 여러 줄
    assert sent[0]["status"] == 403 and reached == []
    assert "evil.example" in caplog.text and "/api/auth/profile" in caplog.text

    sent = await _call(g, "PATCH", [("host", "ws.example.com"), ("origin", "https://ws.example.com"),
                                    ("cookie", "ws_session=s")])
    assert sent[0]["status"] == 200 and reached == ["/api/auth/profile"]

    # 읽을 수 없는 Origin/Referer(urlsplit 이 ValueError) — 500 이 아니라 403
    for name, bad in (("origin", "http://[::1"), ("referer", "https://[bad/page"), ("origin", "\x00garbage")):
        reached.clear()
        sent = await _call(g, "POST", [("host", "ws.example.com"), (name, bad), ("cookie", "ws_session=s")])
        assert sent[0]["status"] == 403 and reached == [], (name, bad)


@pytest.mark.asyncio
async def test_unparseable_origin_refused_even_in_debug(monkeypatch):
    class _Dev(_S):
        debug = True

    monkeypatch.setattr(origin_check, "get_settings", lambda: _Dev)
    g = CookieOriginGuard(None, allowed_origins=[])
    assert g.verdict("POST", "/api/x", {"cookie": COOKIE, "origin": "http://[::1", "host": "ws.example.com"})


@pytest.mark.asyncio
async def test_switch_turns_it_off(monkeypatch):
    class _Off(_S):
        csrf_origin_check = False

    monkeypatch.setattr(origin_check, "get_settings", lambda: _Off)

    async def inner(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    sent = await _call(CookieOriginGuard(inner), "POST",
                       [("host", "ws.example.com"), ("origin", "https://evil.example"), ("cookie", "ws_session=s")])
    assert sent[0]["status"] == 200


# ── 실제 앱에 걸려 있나(미들웨어 순서 포함) ──


@pytest.mark.asyncio
async def test_real_app_refuses_cross_origin_cookie_post(client):
    cookie = {"Cookie": "ws_session=not-a-real-session"}
    r = await client.post("/api/auth/profile-nope", headers={**cookie, "Origin": "https://evil.example"})
    assert r.status_code == 403 and "출처" in r.json()["detail"]
    # 같은 요청이라도: 우리 출처 / 출처 헤더 없음(테스트 클라이언트·비브라우저) / 쿠키 없음 → 미들웨어 통과(없는 경로라 404·405)
    r = await client.post("/api/auth/profile-nope",
                          headers={**cookie, "Origin": "https://evil.example", "Authorization": "Bearer x"})
    assert r.status_code == 403                                  # 쿠키 + 아무 Bearer 로는 못 건너뛴다
    for headers in ({**cookie, "Origin": "http://localhost:8000"}, cookie, {"Origin": "https://evil.example"},
                    {"Origin": "https://evil.example", "Authorization": "Bearer x"}):
        r = await client.post("/api/auth/profile-nope", headers=headers)
        assert r.status_code in (404, 405), (headers, r.status_code)
