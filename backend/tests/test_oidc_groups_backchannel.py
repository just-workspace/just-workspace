"""OIDC 제공자 — groups 스코프·클레임 + Back-Channel Logout 1.0.

실제 FastAPI 앱에 authorize → token → userinfo 를 태우고, 로그아웃 경로가 RP 로
logout_token 을 보내는지 본다. Redis 는 가짜, RP 는 httpx.MockTransport.
기존 클라이언트(Gitea 형 레거시·claude.ai MCP·데스크톱 앱) 회귀도 같이 확인한다.
"""

import base64
import hashlib
import json
import secrets
import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest

from app.auth import backchannel
from app.auth import jwks as jwks_mod
from app.auth import oauth_provider as op
from app.auth import sessions as sess_mod
from app.auth.deps import sign_value
from app.db.models import User
from app.db.session import async_session
from app.groups.models import Group, GroupMember

ISS = "http://localhost:8000"   # conftest APP_URL
LAB_BCL = "https://lab.example.test/auth/backchannel-logout"
LAB_CB = "https://lab.example.test/auth/callback"


# ── 가짜 Redis ──────────────────────────────────────────────


class FakeRedis:
    def __init__(self):
        self.kv, self.sets = {}, {}

    async def setex(self, k, ttl, v):
        self.kv[k] = v

    async def get(self, k):
        return self.kv.get(k)

    async def getdel(self, k):
        return self.kv.pop(k, None)

    async def delete(self, *ks):
        for k in ks:
            self.kv.pop(k, None)
            self.sets.pop(k, None)

    async def sadd(self, k, *v):
        self.sets.setdefault(k, set()).update(v)

    async def srem(self, k, *v):
        self.sets.get(k, set()).difference_update(v)

    async def smembers(self, k):
        return set(self.sets.get(k, set()))

    async def expire(self, k, ttl):
        return True

    async def scan_iter(self, match="*", count=None):
        prefix = match.rstrip("*")
        for k in list(self.kv) + list(self.sets):
            if k.startswith(prefix):
                yield k


class BrokenRedis(FakeRedis):
    """세션 레지스트리는 살아 있고 백채널 추적만 못 읽는 상황."""

    async def smembers(self, k):
        raise ConnectionError("redis down")


class RP:
    """MockTransport 로 받는 RP. ``plan`` 은 시도별 응답(정수=상태코드, 'err'=연결 실패)."""

    def __init__(self, plan=None):
        self.plan = list(plan or [])
        self.calls: list[httpx.Request] = []

    def handler(self, request: httpx.Request):
        self.calls.append(request)
        step = self.plan.pop(0) if self.plan else 200
        if step == "err":
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(step)

    def tokens(self):
        return [parse_qs(c.content.decode())["logout_token"][0] for c in self.calls]


@pytest.fixture()
async def env(client, monkeypatch):
    r = FakeRedis()

    async def _get():
        return r

    import app.chat.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", _get)          # oauth_store (지연 import)
    monkeypatch.setattr(sess_mod, "get_redis", _get)
    monkeypatch.setattr(backchannel, "get_redis", _get)
    monkeypatch.setattr(backchannel, "RETRY_DELAYS", (0.0, 0.0))
    monkeypatch.setattr(backchannel, "_session_factory", async_session)
    rp = RP()
    monkeypatch.setattr(backchannel, "_transport", httpx.MockTransport(rp.handler))
    clients = {
        "netlab": {
            "secret": "lab-secret", "trusted": True, "client_name": "랩",
            "redirect_uris": [LAB_CB],
            "scopes": ["openid", "profile", "email", "groups"],
            "backchannel_logout_uri": LAB_BCL,
            "backchannel_logout_session_required": True,
        },
        # 운영 .env 의 레거시 Gitea 항목과 같은 모양(scopes 없음, trusted)
        "portal-gitea": {
            "secret": "gitea-secret", "trusted": True,
            "redirect_uris": ["https://ws.example.test/git/user/oauth2/portal/callback"],
        },
        "claude-mcp": {
            "secret": "mcp-secret", "scopes": ["mcp:read"],
            "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
        },
    }
    monkeypatch.setattr(op.settings, "oauth_clients_json", json.dumps(clients))
    yield {"client": client, "redis": r, "rp": rp, "clients": clients,
           "monkeypatch": monkeypatch}
    await backchannel.drain()


async def _user(is_admin=False, groups=()):
    uid = str(uuid.uuid4())
    async with async_session() as db:
        db.add(User(id=uid, username="u" + uid[:8], email=f"{uid[:8]}@x.test",
                    display_name="테스터", is_admin=is_admin, is_active=True, token_version=0))
        for name in groups:
            gid = str(uuid.uuid4())
            db.add(Group(id=gid, name=f"{name}" if name.lower() == "admin" else f"{name}-{uid[:4]}"))
            db.add(GroupMember(group_id=gid, user_id=uid))
        await db.commit()
    return uid


async def _group_names(uid):
    async with async_session() as db:
        from sqlalchemy import select
        rows = await db.execute(
            select(Group.name).join(GroupMember, GroupMember.group_id == Group.id)
            .where(GroupMember.user_id == uid))
        return sorted(rows.scalars().all())


async def _login(uid):
    sid = await sess_mod.create_session(uid, "10.0.0.5", "", "pytest", 3600)
    return sid, sign_value({"user_id": uid, "tv": 0, "sid": sid})


def _pkce():
    v = secrets.token_urlsafe(48)
    c = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()
    return v, c


async def _flow(env, uid, client_id, scope, redirect_uri, *, cookie=None, secret=None,
                pkce=False, resource=None, nonce="n-1"):
    c = env["client"]
    if cookie is None:
        _, cookie = await _login(uid)
    params = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
              "scope": scope, "state": "st", "nonce": nonce}
    verifier = None
    if pkce:
        verifier, challenge = _pkce()
        params.update(code_challenge=challenge, code_challenge_method="S256")
    if resource:
        params["resource"] = resource
    r = await c.get("/oauth/authorize", params=params, cookies={"ws_session": cookie})
    assert r.status_code == 302, r.text
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert "code" in q, r.headers["location"]
    form = {"grant_type": "authorization_code", "code": q["code"][0],
            "redirect_uri": redirect_uri, "client_id": client_id}
    if secret:
        form["client_secret"] = secret
    if verifier:
        form["code_verifier"] = verifier
    t = await c.post("/oauth/token", data=form)
    assert t.status_code == 200, t.text
    return t.json(), cookie


async def _verify(token, aud):
    async with async_session() as db:
        key = await jwks_mod.get_active_key(db)
    return jwt.decode(token, key.public_pem, algorithms=["RS256"], audience=aud, issuer=ISS)


# ── discovery ───────────────────────────────────────────────


async def test_discovery_advertises_groups_and_backchannel(env):
    for path in ("/.well-known/openid-configuration", "/oauth/.well-known/openid-configuration",
                 "/.well-known/oauth-authorization-server"):
        m = (await env["client"].get(path)).json()
        assert "groups" in m["scopes_supported"]
        assert {"groups", "sid", "sub", "email"} <= set(m["claims_supported"])
        assert m["backchannel_logout_supported"] is True
        assert m["backchannel_logout_session_supported"] is True
        # 기존 필드는 그대로
        assert m["issuer"] == ISS
        assert m["id_token_signing_alg_values_supported"] == ["RS256"]
        assert m["jwks_uri"] == f"{ISS}/oauth/jwks.json"
        assert {"openid", "profile", "email", "mcp:read", "mcp:write"} <= set(m["scopes_supported"])
        assert m["registration_endpoint"] == f"{ISS}/oauth/register"


# ── groups ──────────────────────────────────────────────────


async def test_groups_scope_emits_real_group_names_id_token_and_userinfo(env):
    uid = await _user(is_admin=False, groups=["netops", "lab-users"])
    tok, _ = await _flow(env, uid, "netlab", "openid profile email groups", LAB_CB,
                         secret="lab-secret")
    claims = await _verify(tok["id_token"], "netlab")
    expected = await _group_names(uid)
    assert claims["groups"] == expected and len(expected) == 2
    ui = (await env["client"].get("/oauth/userinfo",
                                  headers={"authorization": f"Bearer {tok['access_token']}"})).json()
    assert ui["groups"] == expected and ui["sub"] == uid


async def test_admin_marker_kept_first_and_admin_named_group_not_leaked(env):
    admin = await _user(is_admin=True, groups=["ops"])
    tok, _ = await _flow(env, admin, "netlab", "openid groups", LAB_CB, secret="lab-secret")
    g = (await _verify(tok["id_token"], "netlab"))["groups"]
    assert g[0] == "admin" and g[1:] == [n for n in await _group_names(admin)]

    # 비관리자가 "Admin" 이라는 이름의 그룹에 있어도 관리자 표식이 생기면 안 된다.
    plain = await _user(is_admin=False, groups=["Admin"])
    tok, _ = await _flow(env, plain, "netlab", "openid groups", LAB_CB, secret="lab-secret")
    assert (await _verify(tok["id_token"], "netlab"))["groups"] == []


async def test_without_groups_scope_legacy_value_unchanged(env):
    """Gitea 형 레거시(스코프 목록 없음) — groups 스코프 없이 예전 값 그대로."""
    cb = env["clients"]["portal-gitea"]["redirect_uris"][0]
    admin = await _user(is_admin=True, groups=["ops"])
    tok, _ = await _flow(env, admin, "portal-gitea", "openid email profile", cb,
                         secret="gitea-secret")
    c = await _verify(tok["id_token"], "portal-gitea")
    assert c["groups"] == ["admin"]
    assert c["nonce"] == "n-1" and c["preferred_username"].startswith("u")
    assert "refresh_token" in tok      # trusted → 기존대로
    plain = await _user(groups=["ops"])
    tok, _ = await _flow(env, plain, "portal-gitea", "openid email profile", cb,
                         secret="gitea-secret")
    assert (await _verify(tok["id_token"], "portal-gitea"))["groups"] == []
    ui = (await env["client"].get("/oauth/userinfo",
                                  headers={"authorization": f"Bearer {tok['access_token']}"})).json()
    assert ui["groups"] == []


async def test_restricted_clients_cannot_request_groups(env):
    """claude-mcp(mcp:read 만)·desktop-app(openid profile email)은 groups 를 못 달라고 한다."""
    uid = await _user()
    _, cookie = await _login(uid)
    for cid, cb in (("claude-mcp", "https://claude.ai/api/mcp/auth_callback"),
                    ("desktop-app", "http://127.0.0.1:53111/callback")):
        _, ch = _pkce()
        r = await env["client"].get("/oauth/authorize", params={
            "response_type": "code", "client_id": cid, "redirect_uri": cb,
            "scope": "openid groups", "code_challenge": ch, "code_challenge_method": "S256"},
            cookies={"ws_session": cookie})
        assert r.status_code == 302
        assert parse_qs(urlparse(r.headers["location"]).query)["error"] == ["invalid_scope"]


async def test_desktop_app_regression(env):
    uid = await _user(groups=["ops"])
    tok, _ = await _flow(env, uid, "desktop-app", "openid profile email",
                         "http://127.0.0.1:53111/callback", pkce=True)
    c = await _verify(tok["id_token"], "desktop-app")
    assert c["groups"] == [] and "sid" in c
    assert tok["refresh_token"]
    # 백채널 RP 가 아니므로 추적하지 않는다
    assert not env["redis"].sets.get("bclu:" + uid)


async def test_claude_mcp_regression(env):
    uid = await _user(is_admin=True)
    async with async_session() as db:
        await op._record_consent(db, uid, "claude-mcp", ["mcp:read"])
    res = op._mcp_resource("read")
    tok, _ = await _flow(env, uid, "claude-mcp", "mcp:read",
                         "https://claude.ai/api/mcp/auth_callback",
                         secret="mcp-secret", pkce=True, resource=res)
    assert tok["refresh_token"] and tok["scope"] == "mcp:read"
    async with async_session() as db:
        at = await op.verify_access_token(db, tok["access_token"], audience=res)
    assert at["aud"] == res and at["scope"] == "mcp:read"
    assert (await _verify(tok["id_token"], "claude-mcp"))["groups"] == ["admin"]


# ── back-channel logout ─────────────────────────────────────


async def _lab_login(env, uid):
    tok, cookie = await _flow(env, uid, "netlab", "openid groups", LAB_CB, secret="lab-secret")
    return (await _verify(tok["id_token"], "netlab")), cookie


async def test_id_token_sid_is_derived_not_raw(env):
    uid = await _user()
    sid, cookie = await _login(uid)
    tok, _ = await _flow(env, uid, "netlab", "openid", LAB_CB, secret="lab-secret", cookie=cookie)
    c = await _verify(tok["id_token"], "netlab")
    assert c["sid"] == backchannel.oidc_sid(sid) and c["sid"] != sid
    assert f"netlab\t{sid}" in env["redis"].sets["bclu:" + uid]


async def test_logout_sends_conformant_logout_token(env):
    uid = await _user()
    idt, cookie = await _lab_login(env, uid)
    r = await env["client"].post("/api/auth/logout", cookies={"ws_session": cookie})
    assert r.status_code == 200
    await backchannel.drain()
    rp = env["rp"]
    assert len(rp.calls) == 1
    req = rp.calls[0]
    assert str(req.url) == LAB_BCL and req.method == "POST"
    assert req.headers["content-type"].startswith("application/x-www-form-urlencoded")
    token = rp.tokens()[0]
    hdr = jwt.get_unverified_header(token)
    assert hdr["typ"] == "logout+jwt" and hdr["alg"] == "RS256" and hdr["kid"]
    # JWKS 문서에 실린 키로 검증된다(RP 가 하는 그대로)
    jwks = (await env["client"].get("/oauth/jwks.json")).json()
    jwk = next(k for k in jwks["keys"] if k["kid"] == hdr["kid"])
    pub = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(jwk))
    c = jwt.decode(token, pub, algorithms=["RS256"], audience="netlab", issuer=ISS)
    assert c["events"] == {"http://schemas.openid.net/event/backchannel-logout": {}}
    assert c["sub"] == uid and c["sid"] == idt["sid"]
    assert c["jti"] and isinstance(c["iat"], int) and c["exp"] - c["iat"] <= 120
    assert "nonce" not in c
    # 추적 기록은 정리된다
    assert not env["redis"].sets.get("bclu:" + uid)


async def test_jti_unique_per_token(env):
    a = backchannel.build_claims("netlab", "u", "s")
    b = backchannel.build_claims("netlab", "u", "s")
    assert a["jti"] != b["jti"]


async def test_only_logged_out_session_is_notified(env):
    uid = await _user()
    idt1, cookie1 = await _lab_login(env, uid)
    idt2, cookie2 = await _lab_login(env, uid)
    assert idt1["sid"] != idt2["sid"]
    await env["client"].post("/api/auth/logout", cookies={"ws_session": cookie1})
    await backchannel.drain()
    sids = [jwt.decode(t, options={"verify_signature": False})["sid"] for t in env["rp"].tokens()]
    assert sids == [idt1["sid"]]


async def test_user_wide_revoke_notifies_every_session(env):
    """비밀번호 변경·재설정·관리자 강제 로그아웃·정지·삭제가 부르는 경로."""
    uid = await _user()
    idt1, _ = await _lab_login(env, uid)
    idt2, _ = await _lab_login(env, uid)
    await sess_mod.revoke_user_sessions(uid)
    await backchannel.drain()
    got = sorted(jwt.decode(t, options={"verify_signature": False})["sid"]
                 for t in env["rp"].tokens())
    assert got == sorted([idt1["sid"], idt2["sid"]])


async def test_admin_deactivate_revokes_sessions_and_notifies(env):
    from app.admin.router import deactivate_user_endpoint

    admin = await _user(is_admin=True)
    uid = await _user()
    idt, _ = await _lab_login(env, uid)

    class _Req:
        client = None
        headers = {}

    async with async_session() as db:
        admin_u = await db.get(User, admin)
        await deactivate_user_endpoint(uid, _Req(), admin_u, db)
        u = await db.get(User, uid)
        assert u.is_active is False and u.token_version == 1
    await backchannel.drain()
    assert [jwt.decode(t, options={"verify_signature": False})["sid"]
            for t in env["rp"].tokens()] == [idt["sid"]]
    assert not env["redis"].sets.get("usess:" + uid)


async def test_logout_all_notifies(env):
    uid = await _user()
    await _lab_login(env, uid)
    await sess_mod.revoke_all_sessions()
    await backchannel.drain()
    assert len(env["rp"].calls) == 1


async def test_delivery_failure_does_not_block_logout(env):
    uid = await _user()
    sid, cookie = await _login(uid)
    await _flow(env, uid, "netlab", "openid", LAB_CB, secret="lab-secret", cookie=cookie)
    env["rp"].plan = ["err", "err", "err", "err"]
    r = await env["client"].post("/api/auth/logout", cookies={"ws_session": cookie})
    assert r.status_code == 200
    assert "ws_session" in r.headers.get("set-cookie", "")       # 쿠키 삭제
    assert await sess_mod.get_session(sid) is None                # 세션은 이미 끝
    await backchannel.drain()
    assert len(env["rp"].calls) == 3                              # 1 + 재시도 2


async def test_retry_on_5xx_then_success_and_no_retry_on_4xx(env):
    uid = await _user()
    _, cookie = await _lab_login(env, uid)
    env["rp"].plan = [503, 200]
    await env["client"].post("/api/auth/logout", cookies={"ws_session": cookie})
    await backchannel.drain()
    assert len(env["rp"].calls) == 2

    env["rp"].calls.clear()
    uid2 = await _user()
    _, cookie2 = await _lab_login(env, uid2)
    env["rp"].plan = [400]
    await env["client"].post("/api/auth/logout", cookies={"ws_session": cookie2})
    await backchannel.drain()
    assert len(env["rp"].calls) == 1


async def test_timeout_is_short():
    assert backchannel.SEND_TIMEOUT.read <= 3 and backchannel.SEND_TIMEOUT.connect <= 2


async def test_redis_failure_falls_back_to_sub_only_but_respects_session_required(env):
    mp = env["monkeypatch"]
    clients = dict(env["clients"])
    clients["other-rp"] = {"secret": "x", "redirect_uris": ["https://o.test/cb"],
                           "backchannel_logout_uri": "https://o.test/bcl"}
    mp.setattr(op.settings, "oauth_clients_json", json.dumps(clients))
    broken = BrokenRedis()

    async def _get():
        return broken

    mp.setattr(backchannel, "get_redis", _get)
    await backchannel.on_user_revoked("user-x")
    await backchannel.drain()
    calls = env["rp"].calls
    assert [str(c.url) for c in calls] == ["https://o.test/bcl"]   # netlab(sid 필수)는 제외
    c = jwt.decode(env["rp"].tokens()[0], options={"verify_signature": False})
    assert c["sub"] == "user-x" and "sid" not in c


async def test_no_backchannel_clients_means_no_side_effects(env):
    mp = env["monkeypatch"]
    mp.setattr(op.settings, "oauth_clients_json", json.dumps({
        "portal-gitea": env["clients"]["portal-gitea"]}))
    uid = await _user()
    _, cookie = await _login(uid)
    cb = env["clients"]["portal-gitea"]["redirect_uris"][0]
    tok, _ = await _flow(env, uid, "portal-gitea", "openid", cb, secret="gitea-secret",
                         cookie=cookie)
    await env["client"].post("/api/auth/logout", cookies={"ws_session": cookie})
    await backchannel.drain()
    assert env["rp"].calls == []
    assert not any(k.startswith(("bclu:", "bcls:"))
                   for k in list(env["redis"].kv) + list(env["redis"].sets))


async def test_dcr_client_cannot_register_backchannel_uri(env):
    r = await env["client"].post("/oauth/register", json={
        "redirect_uris": ["https://evil.test/cb"],
        "backchannel_logout_uri": "http://169.254.169.254/latest"})
    assert r.status_code == 201
    assert r.json()["client_id"] not in backchannel.bcl_clients()
    assert "backchannel_logout_uri" not in r.json()


@pytest.mark.parametrize("uri,ok", [
    ("https://lab.example.com/auth/backchannel-logout", True),
    ("https://lab.test/bcl#frag", False),
    ("http://lab.example.com/bcl", False),
    ("http://192.168.10.160:8080/bcl", True),
    ("http://netlab-api:8000/bcl", True),
    ("ftp://x/y", False),
    ("", False),
    (None, False),
])
def test_logout_uri_validation(uri, ok):
    assert backchannel.valid_logout_uri(uri) is ok


async def test_old_authorization_code_without_session_id_still_works(env):
    """배포 직전에 Redis 에 저장된 코드(session_id 필드 없음)도 교환된다."""
    from dataclasses import asdict
    import time
    from app.auth.oauth_store import AuthorizationCode

    uid = await _user()
    d = asdict(AuthorizationCode(user_id=uid, client_id="netlab", redirect_uri=LAB_CB,
                                 scope="openid", code_challenge=None, nonce=None,
                                 expires_at=time.time() + 60))
    d.pop("session_id")
    await env["redis"].setex("oauth:code:legacy", 60, json.dumps(d))
    t = await env["client"].post("/oauth/token", data={
        "grant_type": "authorization_code", "code": "legacy", "redirect_uri": LAB_CB,
        "client_id": "netlab", "client_secret": "lab-secret"})
    assert t.status_code == 200
    assert "sid" not in await _verify(t.json()["id_token"], "netlab")
