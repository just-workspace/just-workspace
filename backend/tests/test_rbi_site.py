"""격리 브라우저 전용 출처(app/rbi/site.py) — SSO 홉 · 코드 재사용 · 열린 리디렉트 · 쿠키 범위 · rbi 출처의 워크스페이스 API 차단.

실제 앱(app.main)을 그대로 띄워 Host 헤더로 두 출처를 흉내 낸다(ws-nginx 가 Host $host 를 넘기는 것과 같다).
Redis 는 가짜(tests/rbi_fakes.py), docker 는 부르지 않는다.
"""
from __future__ import annotations

import json
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, unquote, urlsplit

import pytest
from httpx import ASGITransport, AsyncClient

from app.auth.deps import sign_value
from app.db.models import Base, User
from app.db.session import get_db
from app.rbi import site
from app.rbi.models import RbiSession, RbiTarget  # noqa: F401 — db_engine 픽스처의 create_all 전에 등록(이 파일만 돌릴 때)
from tests.rbi_fakes import RBI_HOST, RBI_ORIGIN, WS_HOST, WS_ORIGIN, fake_redis, rbi_origin, site_cookie, ws_session  # noqa: F401


@pytest.fixture(autouse=True)
def _module_on(monkeypatch):
    from app.modules import registry
    monkeypatch.setitem(registry._module_states, "rbi", True)


@pytest.fixture()
async def app(db_session):
    from app.main import app as real
    from app.db.session import engine as app_engine
    async with app_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async def _db():
        yield db_session
    real.dependency_overrides[get_db] = _db
    yield real
    real.dependency_overrides.pop(get_db, None)


@pytest.fixture()
async def alice(db_session):
    u = User(id="u-alice", username="alice", display_name="앨리스", is_admin=False, is_active=True, email="al@x", token_version=0)
    db_session.add(u)
    await db_session.commit()
    return u


async def _get(app, host, url, headers=None, method="GET"):
    async with AsyncClient(transport=ASGITransport(app=app), base_url=f"http://{host}") as c:
        return await c.request(method, url, headers={"Host": host, **(headers or {})})


def _set_cookies(resp) -> dict[str, dict]:
    """Set-Cookie 들 → {이름: {value, 속성…}}."""
    out: dict[str, dict] = {}
    for raw in resp.headers.get_list("set-cookie"):
        c = SimpleCookie()
        c.load(raw)
        for name, m in c.items():
            attrs = {k: m[k] for k in m.keys() if m[k]}
            low = raw.lower()
            attrs["secure"] = "; secure" in low
            attrs["httponly"] = "; httponly" in low
            out[name] = {"value": m.value, **attrs, "raw": raw}
    return out


async def _ws_cookie(fr, user: User, wsid="wsid-1") -> str:
    await ws_session(fr, user.id, wsid)
    return "ws_session=" + sign_value({"user_id": user.id, "tv": user.token_version, "sid": wsid})


async def _hop(app, fr, user, ret="/x?target=portal"):
    """홉 전체 — (state 쿠키 헤더, 콜백 응답, 코드)."""
    r1 = await _get(app, RBI_HOST, f"/api/rbi/site/login?return={ret}")
    assert r1.status_code == 302
    loc = urlsplit(r1.headers["location"])
    assert f"{loc.scheme}://{loc.netloc}" == WS_ORIGIN and loc.path == "/rbi-login"
    state = parse_qs(loc.query)["state"][0]
    sc = _set_cookies(r1)[site.state_cookie_name()]
    state_hdr = f"{site.state_cookie_name()}={sc['value']}"
    r2 = await _get(app, WS_HOST, f"/api/rbi/site/sso?{loc.query}", {"Cookie": await _ws_cookie(fr, user)})
    assert r2.status_code == 302, r2.text
    cb = urlsplit(r2.headers["location"])
    assert f"{cb.scheme}://{cb.netloc}" == RBI_ORIGIN and cb.path == "/auth/callback"
    q = parse_qs(cb.query)
    assert q["state"][0] == state
    r3 = await _get(app, RBI_HOST, f"/api/rbi/site/callback?{cb.query}", {"Cookie": state_hdr})
    return state_hdr, r3, q["code"][0], cb.query


# ── 홉 ──

async def test_full_sso_hop_sets_host_only_rbi_cookie(app, fake_redis, rbi_origin, alice):
    r1 = await _get(app, RBI_HOST, "/api/rbi/site/login?return=/x")
    sc = _set_cookies(r1)[site.state_cookie_name()]
    # 홉 전 state 쿠키 — __Host-, Secure, HttpOnly, Path=/, Domain 없음, Lax, 10분
    assert site.state_cookie_name().startswith("__Host-")
    assert sc["secure"] and sc["httponly"] and sc["path"] == "/" and "domain" not in sc
    assert sc["samesite"].lower() == "lax" and int(sc["max-age"]) == site.STATE_TTL

    state_hdr, r3, _code, _q = await _hop(app, fake_redis, alice)
    assert r3.status_code == 302 and r3.headers["location"] == "/x?target=portal"
    cookies = _set_cookies(r3)
    c = cookies["__Host-jw_rbi"]
    assert c["secure"] and c["httponly"] and c["path"] == "/" and "domain" not in c and c["samesite"].lower() == "strict"
    assert int(c["max-age"]) == site.session_ttl()
    # state 쿠키는 지운다
    assert cookies[site.state_cookie_name()]["value"] in ("", '""')
    assert r3.headers["cache-control"] == "no-store"
    ck = f"__Host-jw_rbi={c['value']}"
    me = await _get(app, RBI_HOST, "/api/rbi/site/me", {"Cookie": ck})
    assert me.status_code == 200 and me.json()["user"]["id"] == alice.id and me.json()["workspace_url"] == WS_ORIGIN
    # rbi 쿠키로 격리 브라우저 API 가 열린다
    t = await _get(app, RBI_HOST, "/api/rbi/targets", {"Cookie": ck})
    assert t.status_code == 200 and t.json()["public_origin"] == RBI_ORIGIN


async def test_sso_requires_workspace_login_and_returns_after(app, fake_redis, rbi_origin, alice):
    r = await _get(app, WS_HOST, "/api/rbi/site/sso?state=" + "s" * 32 + "&return=/a")
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("/login?redirect=")
    back = unquote(loc.split("redirect=", 1)[1])
    assert back.startswith("/rbi-login?") and parse_qs(urlsplit(back).query)["state"][0] == "s" * 32
    # 무효 워크스페이스 쿠키도 로그인으로
    r = await _get(app, WS_HOST, "/api/rbi/site/sso?state=" + "s" * 32, {"Cookie": "ws_session=forged"})
    assert r.headers["location"].startswith("/login?redirect=")


async def test_sso_without_state_restarts_on_rbi_origin(app, fake_redis, rbi_origin, alice):
    r = await _get(app, WS_HOST, "/api/rbi/site/sso?return=/z", {"Cookie": await _ws_cookie(fake_redis, alice)})
    assert r.status_code == 302 and r.headers["location"] == f"{RBI_ORIGIN}/auth/login?return=%2Fz"
    assert not [k for k in fake_redis.kv if k.startswith(site.CODE_PREFIX)]   # 코드를 만들지 않았다


async def test_code_is_single_use(app, fake_redis, rbi_origin, alice):
    state_hdr, r3, code, q = await _hop(app, fake_redis, alice)
    assert r3.status_code == 302 and "__Host-jw_rbi" in _set_cookies(r3)
    # 같은 코드를 다시(state 쿠키를 그대로 들고 와도) → 거부
    again = await _get(app, RBI_HOST, f"/api/rbi/site/callback?{q}", {"Cookie": state_hdr})
    assert again.status_code == 302 and again.headers["location"] == "/?sso_error=code"
    assert "__Host-jw_rbi" not in _set_cookies(again)


async def test_code_expires(app, fake_redis, rbi_origin, alice):
    r1 = await _get(app, RBI_HOST, "/api/rbi/site/login?return=/")
    loc = urlsplit(r1.headers["location"])
    state_hdr = f"{site.state_cookie_name()}={_set_cookies(r1)[site.state_cookie_name()]['value']}"
    r2 = await _get(app, WS_HOST, f"/api/rbi/site/sso?{loc.query}", {"Cookie": await _ws_cookie(fake_redis, alice)})
    cb = urlsplit(r2.headers["location"])
    code = parse_qs(cb.query)["code"][0]
    # TTL 60초 — 저장할 때 ex 가 그 값이고, 지나면 없다
    exp = fake_redis.kv[site.CODE_PREFIX + code][1]
    import time
    assert 55 <= exp - time.time() <= 61
    fake_redis.expire_now(site.CODE_PREFIX + code)
    r3 = await _get(app, RBI_HOST, f"/api/rbi/site/callback?{cb.query}", {"Cookie": state_hdr})
    assert r3.headers["location"] == "/?sso_error=code"


async def test_state_must_match_cookie(app, fake_redis, rbi_origin, alice):
    """로그인 CSRF — 공격자가 받은 코드를 피해자 브라우저(다른 state 쿠키, 또는 쿠키 없음)에서 쓰지 못한다."""
    _state_hdr, _r3, _c, _q = None, None, None, None
    r1 = await _get(app, RBI_HOST, "/api/rbi/site/login?return=/")
    loc = urlsplit(r1.headers["location"])
    r2 = await _get(app, WS_HOST, f"/api/rbi/site/sso?{loc.query}", {"Cookie": await _ws_cookie(fake_redis, alice)})
    cbq = urlsplit(r2.headers["location"]).query
    # 쿠키 없음
    r = await _get(app, RBI_HOST, f"/api/rbi/site/callback?{cbq}")
    assert r.headers["location"] == "/?sso_error=state"
    # 다른 홉의 state 쿠키(피해자 자신의 홉)
    other = await _get(app, RBI_HOST, "/api/rbi/site/login?return=/")
    victim_hdr = f"{site.state_cookie_name()}={_set_cookies(other)[site.state_cookie_name()]['value']}"
    r = await _get(app, RBI_HOST, f"/api/rbi/site/callback?{cbq}", {"Cookie": victim_hdr})
    assert r.headers["location"] == "/?sso_error=state" and "__Host-jw_rbi" not in _set_cookies(r)
    # 위조 state 쿠키(서명 없음)
    r = await _get(app, RBI_HOST, f"/api/rbi/site/callback?{cbq}", {"Cookie": f"{site.state_cookie_name()}=eyJzIjoieCJ9"})
    assert r.headers["location"] == "/?sso_error=state"


async def test_callback_rejects_revoked_workspace_session(app, fake_redis, rbi_origin, alice):
    r1 = await _get(app, RBI_HOST, "/api/rbi/site/login?return=/")
    loc = urlsplit(r1.headers["location"])
    state_hdr = f"{site.state_cookie_name()}={_set_cookies(r1)[site.state_cookie_name()]['value']}"
    r2 = await _get(app, WS_HOST, f"/api/rbi/site/sso?{loc.query}", {"Cookie": await _ws_cookie(fake_redis, alice)})
    await fake_redis.delete("sess:wsid-1")          # 그 사이 워크스페이스에서 로그아웃
    r3 = await _get(app, RBI_HOST, f"/api/rbi/site/callback?{urlsplit(r2.headers['location']).query}", {"Cookie": state_hdr})
    assert r3.headers["location"] == "/?sso_error=user"


# ── 열린 리디렉트 ──

@pytest.mark.parametrize("raw,want", [
    ("/ok", "/ok"), ("/ok?target=portal&x=1", "/ok?target=portal&x=1"), ("", "/"), (None, "/"),
    ("https://evil.example/x", "/"), ("//evil.example/x", "/"), ("/\\evil.example", "/"), ("\\\\evil", "/"),
    ("javascript:alert(1)", "/"), ("evil.example", "/"), ("/x\r\nSet-Cookie: a=b", "/"), ("/x\tz", "/"),
    (f"{RBI_ORIGIN}/deep?target=a", "/deep?target=a"), (f"{RBI_ORIGIN}", "/"), ("https://rbi.test.evil.example/x", "/"),
    ("http://rbi.test/x", "/"), ("/auth/login?return=/x", "/"), ("/auth/callback", "/"), ("/" + "a" * 1100, "/"),
])
def test_safe_return(rbi_origin, raw, want):
    assert site.safe_return(raw) == want


async def test_hop_never_redirects_off_origin(app, fake_redis, rbi_origin, alice):
    for ret in ("https://evil.example/x", "//evil.example", "/\\evil.example"):
        _s, r3, _c, _q = await _hop(app, fake_redis, alice, ret=ret.replace("&", "%26"))
        assert r3.status_code == 302 and r3.headers["location"] == "/"
    # 워크스페이스 쪽: return 이 무엇이든 목적지는 설정된 rbi 출처의 /auth/callback(또는 /auth/login)
    ck = await _ws_cookie(fake_redis, alice, "wsid-2")
    for q in ("state=" + "a" * 32 + "&return=https://evil.example", "state=" + "a" * 32 + "&return=//evil.example",
              "return=https://evil.example", "state=bad&return=//x"):
        r = await _get(app, WS_HOST, f"/api/rbi/site/sso?{q}", {"Cookie": ck})
        loc = r.headers["location"]
        assert loc.startswith(f"{RBI_ORIGIN}/auth/"), loc
        if "return=" in loc:
            assert parse_qs(urlsplit(loc).query)["return"][0] == "/"


# ── 쿠키 범위 ──

async def test_rbi_cookie_is_not_a_workspace_session(app, fake_redis, rbi_origin, alice):
    """rbi 세션 쿠키 값은 워크스페이스 API 에서 쿠키로도 Bearer 로도 통하지 않는다(서명 salt 가 다르다)."""
    ck = await site_cookie(fake_redis, alice.id)
    val = ck.split("=", 1)[1]
    for hdr in ({"Cookie": f"ws_session={val}"}, {"Authorization": f"Bearer {val}"}, {"Cookie": ck}):
        r = await _get(app, WS_HOST, "/api/auth/me", hdr)
        assert r.status_code == 401, (hdr, r.status_code)
        r = await _get(app, WS_HOST, "/api/rbi/targets", hdr)
        assert r.status_code == 401, (hdr, r.status_code)


async def test_rbi_host_ignores_workspace_session(app, fake_redis, rbi_origin, alice):
    """rbi 출처는 워크스페이스 세션 쿠키·Bearer 를 받지 않는다 — rbi 세션 쿠키만."""
    ws = await _ws_cookie(fake_redis, alice)
    tok = ws.split("=", 1)[1]
    for hdr in ({"Cookie": ws}, {"Authorization": f"Bearer {tok}"}):
        assert (await _get(app, RBI_HOST, "/api/rbi/targets", hdr)).status_code == 401
        assert (await _get(app, RBI_HOST, "/api/rbi/site/me", hdr)).status_code == 401
    # 워크스페이스 출처에서는 그 쿠키로 대상 목록(런처)이 열린다
    r = await _get(app, WS_HOST, "/api/rbi/targets", {"Cookie": ws})
    assert r.status_code == 200 and r.json()["public_origin"] == RBI_ORIGIN


async def test_forged_or_foreign_rbi_cookie(app, fake_redis, rbi_origin, alice):
    # 워크스페이스 서명기로 만든 같은 모양 값 → 거부
    forged = sign_value({"rsid": "rs-x", "uid": alice.id})
    assert (await _get(app, RBI_HOST, "/api/rbi/site/me", {"Cookie": f"__Host-jw_rbi={forged}"})).status_code == 401
    # 서명은 맞지만 Redis 레코드가 없다(로그아웃한 쿠키를 되살림) → 거부
    ck = await site_cookie(fake_redis, alice.id)
    for k in [k for k in fake_redis.kv if k.startswith(site.SITE_PREFIX)]:
        await fake_redis.delete(k)
    assert (await _get(app, RBI_HOST, "/api/rbi/site/me", {"Cookie": ck})).status_code == 401
    # rbi 세션 저장소 장애 → 닫는다
    ck = await site_cookie(fake_redis, alice.id)
    fake_redis.down = True
    assert (await _get(app, RBI_HOST, "/api/rbi/site/me", {"Cookie": ck})).status_code == 401


# ── 로그아웃·에포크 ──

async def test_rbi_logout_clears_only_rbi(app, fake_redis, rbi_origin, alice):
    ck = await site_cookie(fake_redis, alice.id, wsid=await ws_session(fake_redis, alice.id, "wsid-9"))
    # Origin 없음·다른 출처 → 403(같은 사이트 하위 도메인 CSRF)
    assert (await _get(app, RBI_HOST, "/api/rbi/site/logout", {"Cookie": ck}, method="POST")).status_code == 403
    assert (await _get(app, RBI_HOST, "/api/rbi/site/logout", {"Cookie": ck, "Origin": WS_ORIGIN}, method="POST")).status_code == 403
    r = await _get(app, RBI_HOST, "/api/rbi/site/logout", {"Cookie": ck, "Origin": RBI_ORIGIN}, method="POST")
    assert r.status_code == 200 and _set_cookies(r)["__Host-jw_rbi"]["value"] in ("", '""')
    assert (await _get(app, RBI_HOST, "/api/rbi/site/me", {"Cookie": ck})).status_code == 401
    # 워크스페이스 세션은 그대로
    assert await fake_redis.get("sess:wsid-9")


async def test_workspace_logout_ends_rbi_session(app, fake_redis, rbi_origin, alice, db_session):
    ck = await site_cookie(fake_redis, alice.id, wsid=await ws_session(fake_redis, alice.id, "wsid-5"))
    assert (await _get(app, RBI_HOST, "/api/rbi/site/me", {"Cookie": ck})).status_code == 200
    # 워크스페이스 로그아웃(실제 엔드포인트) → 그 sid 가 레지스트리에서 빠진다
    ws_tok = sign_value({"user_id": alice.id, "tv": 0, "sid": "wsid-5"})
    r = await _get(app, WS_HOST, "/api/auth/logout", {"Cookie": f"ws_session={ws_tok}"}, method="POST")
    assert r.status_code == 200
    assert (await _get(app, RBI_HOST, "/api/rbi/site/me", {"Cookie": ck})).status_code == 401
    assert not [k for k in fake_redis.kv if k.startswith(site.SITE_PREFIX)]   # rbi 세션 레코드도 지웠다
    # 강제 로그아웃(token_version +1)도 끊는다
    ck2 = await site_cookie(fake_redis, alice.id)
    alice.token_version = 1
    await db_session.commit()
    assert (await _get(app, RBI_HOST, "/api/rbi/site/me", {"Cookie": ck2})).status_code == 401


async def test_state_changing_rbi_api_needs_rbi_origin_header(app, fake_redis, rbi_origin, alice):
    ck = await site_cookie(fake_redis, alice.id)
    for origin in (None, WS_ORIGIN, "https://evil.example"):
        hdr = {"Cookie": ck, "Content-Type": "application/json"}
        if origin:
            hdr["Origin"] = origin
        async with AsyncClient(transport=ASGITransport(app=app), base_url=f"http://{RBI_HOST}") as c:
            r = await c.post("/api/rbi/sessions", headers={"Host": RBI_HOST, **hdr}, content=json.dumps({"target_id": "x"}))
        assert r.status_code == 403, origin
    async with AsyncClient(transport=ASGITransport(app=app), base_url=f"http://{RBI_HOST}") as c:
        r = await c.post("/api/rbi/sessions", headers={"Host": RBI_HOST, "Cookie": ck, "Origin": RBI_ORIGIN,
                                                        "Content-Type": "application/json"}, content=json.dumps({"target_id": "x"}))
    assert r.status_code == 404   # 인증·출처는 통과, 대상이 없을 뿐


# ── rbi 출처에서 워크스페이스 API 차단 ──

@pytest.mark.parametrize("path", [
    "/api/auth/me", "/api/files", "/api/admin/rbi", "/api/admin/users", "/api/health", "/api/mail/messages",
    "/oauth/authorize", "/dav/", "/api/rbi/site/sso?state=" + "a" * 32, "/api/internal/ldap/x", "/", "/rbi-login",
])
async def test_rbi_host_blocks_workspace_paths(app, fake_redis, rbi_origin, alice, path):
    ck = await site_cookie(fake_redis, alice.id)
    r = await _get(app, RBI_HOST, path, {"Cookie": ck + "; " + await _ws_cookie(fake_redis, alice, "wsid-b")})
    assert r.status_code == 404, (path, r.status_code)


async def test_rbi_host_guard_case_and_port(app, fake_redis, rbi_origin, alice):
    for host in ("RBI.TEST", "rbi.test:443", "rbi.test:8443"):
        assert (await _get(app, host, "/api/auth/me")).status_code == 404
    # 워크스페이스 출처에서 rbi 전용 엔드포인트는 없다
    assert (await _get(app, WS_HOST, "/api/rbi/site/login")).status_code == 404
    assert (await _get(app, WS_HOST, "/api/rbi/site/callback?code=x&state=y")).status_code == 404
    assert (await _get(app, WS_HOST, "/api/rbi/site/me")).status_code == 404


async def test_unconfigured_origin_disables_site(app, fake_redis, alice):
    from app.config import get_settings
    assert not get_settings().rbi_public_origin
    assert (await _get(app, RBI_HOST, "/api/rbi/site/login")).status_code == 404
    assert (await _get(app, WS_HOST, "/api/rbi/site/sso?state=" + "a" * 32)).status_code == 404
    r = await _get(app, WS_HOST, "/api/rbi/targets", {"Cookie": await _ws_cookie(fake_redis, alice)})
    assert r.status_code == 200 and r.json()["public_origin"] == ""


async def test_module_off_blocks_sso(app, fake_redis, rbi_origin, alice, monkeypatch):
    from app.modules import registry
    monkeypatch.setitem(registry._module_states, "rbi", False)
    r = await _get(app, WS_HOST, "/api/rbi/site/sso?state=" + "a" * 32, {"Cookie": await _ws_cookie(fake_redis, alice)})
    assert r.status_code == 403
    assert not [k for k in fake_redis.kv if k.startswith(site.CODE_PREFIX)]
