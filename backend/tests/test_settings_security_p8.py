"""설정 › 보안·연결된 앱·AI — 2단계 복구 코드, 앱 비밀번호, 연결된 앱, 로그인 보호 정책, 사용자 AI 기본값.

보안 민감 동작은 "본인 것만" 다루는지(타 사용자 id → 404, 타 사용자 자격으로 인증 불가)를 함께 검증한다.
Redis 는 가짜 구현을 사용하고, 메일 발송·역방향 DNS 는 차단한다.
"""

import base64
import json
import time
from datetime import datetime, timedelta, timezone

import pyotp
import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from starlette.requests import Request

import app.ai.models  # noqa: F401 — 메타데이터 등록
import app.backup.models  # noqa: F401
import app.groups.models  # noqa: F401
from app.ai import config as ai_config
from app.ai import router as ai_router
from app.auth import deps as auth_deps
from app.auth import internal_router
from app.auth import me_security, security_policy, two_factor
from app.auth import router as auth_router
from app.auth import sessions as sess_mod
from app.auth.deps import sign_value
from app.auth.schemas import TwoFactorDisableRequest, TwoFactorEnableRequest, TwoFactorVerifyRequest
from app.db.models import AppPassword, Base, OAuthConsent, OAuthRefreshToken, User
from app.dav.auth import authenticate_dav
from app.modules import registry
from app.rate_limit import limiter


class FakeRedis:
    def __init__(self):
        self.kv, self.sets, self.ttls = {}, {}, {}

    async def setex(self, k, ttl, v):
        self.kv[k] = v
        self.ttls[k] = ttl

    async def get(self, k):
        return self.kv.get(k)

    async def delete(self, *ks):
        for k in ks:
            self.kv.pop(k, None)
            self.sets.pop(k, None)

    async def incr(self, k):
        self.kv[k] = str(int(self.kv.get(k) or 0) + 1)
        return int(self.kv[k])

    async def ttl(self, k):
        return self.ttls.get(k, -1)

    async def expire(self, k, ttl):
        self.ttls[k] = ttl
        return True

    async def sadd(self, k, *v):
        self.sets.setdefault(k, set()).update(v)

    async def srem(self, k, *v):
        self.sets.get(k, set()).difference_update(v)

    async def smembers(self, k):
        return set(self.sets.get(k, set()))


def _request(path="/api/auth/2fa/verify", ua="Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36", ip="10.0.0.5"):
    return Request({
        "type": "http", "method": "POST", "path": path, "query_string": b"",
        "headers": [(b"user-agent", ua.encode()), (b"x-real-ip", ip.encode())],
        "client": (ip, 1234), "server": ("test", 80), "scheme": "http",
    })


def _set_policy(**kw):
    pol = {**security_policy.DEFAULTS, **kw}
    security_policy._cache["p"] = (time.monotonic(), pol)
    return pol


@pytest.fixture()
async def redis(monkeypatch):
    r = FakeRedis()

    async def _get():
        return r

    monkeypatch.setattr(sess_mod, "get_redis", _get)
    monkeypatch.setattr(security_policy, "_redis", _get)

    async def _no_dns(ip):
        return ""

    monkeypatch.setattr(sess_mod, "resolve_hostname", _no_dns)
    sent = []

    async def _mail(*a, **kw):
        sent.append(a)

    monkeypatch.setattr(security_policy, "_send_new_device_mail", _mail)
    r.sent = sent
    return r


@pytest.fixture()
async def db(monkeypatch):
    monkeypatch.setattr(limiter, "enabled", False)
    security_policy.invalidate_cache()
    _set_policy()
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        s.add(User(id="alice", username="alice", email="alice@x", password_hash="x", email_verified=True))
        s.add(User(id="bob", username="bob", email="bob@x", password_hash="x", email_verified=True))
        s.add(User(id="root", username="root", email="root@x", password_hash="x", is_admin=True))
        await s.commit()
        yield s
    await engine.dispose()
    security_policy.invalidate_cache()


# ── 2단계 복구 코드 ─────────────────────────────────────────


def test_recovery_codes_hashed_and_single_use():
    u = User(id="u", username="u")
    codes = two_factor.issue_new_codes(u)
    assert len(codes) == 10 and len(set(codes)) == 10
    assert all(len(c) == 9 and c[4] == "-" for c in codes)
    stored = json.loads(u.totp_recovery_codes)
    assert not any(c in u.totp_recovery_codes for c in codes)  # 평문 미저장
    assert len(stored) == 10 and all(len(h) == 64 for h in stored)
    assert two_factor.consume(u, codes[0].upper().replace("-", " ")) is True  # 대소문자·구분자 무시
    assert two_factor.consume(u, codes[0]) is False  # 1회만 사용 가능
    assert two_factor.consume(u, "123456") is False  # TOTP 형식은 복구 코드가 아님
    assert two_factor.remaining(u) == 9


@pytest.mark.asyncio
async def test_enable_returns_codes_and_recovery_login(db, redis):
    alice = await db.get(User, "alice")
    secret = pyotp.random_base32()
    with pytest.raises(HTTPException):
        await auth_router.enable_2fa(TwoFactorEnableRequest(secret=secret, code="000000"), user=alice, db=db)
    res = await auth_router.enable_2fa(
        TwoFactorEnableRequest(secret=secret, code=pyotp.TOTP(secret).now()), user=alice, db=db)
    codes = res["recovery_codes"]
    assert len(codes) == 10 and alice.totp_secret == secret

    temp = sign_value({"user_id": "alice", "purpose": "2fa", "remember_me": False})
    ok = await auth_router.verify_2fa(_request(), TwoFactorVerifyRequest(temp_token=temp, code=codes[3]), db=db)
    assert ok.status_code == 200
    assert two_factor.remaining(alice) == 9
    with pytest.raises(HTTPException) as e:  # 같은 복구 코드 재사용 불가
        await auth_router.verify_2fa(_request(), TwoFactorVerifyRequest(temp_token=temp, code=codes[3]), db=db)
    assert e.value.status_code == 401
    # 타 사용자의 복구 코드로는 로그인 불가
    bob = await db.get(User, "bob")
    bob.totp_secret = pyotp.random_base32()
    await db.commit()
    temp_bob = sign_value({"user_id": "bob", "purpose": "2fa"})
    with pytest.raises(HTTPException):
        await auth_router.verify_2fa(_request(), TwoFactorVerifyRequest(temp_token=temp_bob, code=codes[4]), db=db)


@pytest.mark.asyncio
async def test_regenerate_codes_requires_totp_and_status(db, redis):
    alice = await db.get(User, "alice")
    secret = pyotp.random_base32()
    alice.totp_secret = secret
    old = two_factor.issue_new_codes(alice)
    await db.commit()
    with pytest.raises(HTTPException) as e:
        await two_factor.regenerate_recovery_codes(_request(), two_factor.CodeBody(code="000000"), user=alice, db=db)
    assert e.value.status_code == 400
    res = await two_factor.regenerate_recovery_codes(
        _request(), two_factor.CodeBody(code=pyotp.TOTP(secret).now()), user=alice, db=db)
    assert len(res["recovery_codes"]) == 10
    assert two_factor.consume(alice, old[0]) is False  # 이전 코드 폐기
    st = await two_factor.two_factor_status(user=alice)
    assert st["enabled"] is True and st["recovery_remaining"] == 10 and st["required"] is False
    bob = await db.get(User, "bob")
    with pytest.raises(HTTPException):  # 2단계 인증 미설정 사용자는 발급 불가
        await two_factor.regenerate_recovery_codes(_request(), two_factor.CodeBody(code="123456"), user=bob, db=db)


@pytest.mark.asyncio
async def test_disable_blocked_when_policy_requires(db, redis):
    root = await db.get(User, "root")
    secret = pyotp.random_base32()
    root.totp_secret = secret
    await db.commit()
    _set_policy(require_2fa="admins")
    with pytest.raises(HTTPException) as e:
        await auth_router.disable_2fa(_request(), TwoFactorDisableRequest(code=pyotp.TOTP(secret).now()), user=root, db=db)
    assert e.value.status_code == 400 and root.totp_secret == secret
    _set_policy(require_2fa="off")
    await auth_router.disable_2fa(_request(), TwoFactorDisableRequest(code=pyotp.TOTP(secret).now()), user=root, db=db)
    assert root.totp_secret is None and root.totp_recovery_codes is None


# ── 앱 비밀번호 ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_app_password_lifecycle_and_ownership(db):
    alice = await db.get(User, "alice")
    bob = await db.get(User, "bob")
    created = await me_security.create_app_password(
        me_security.AppPasswordCreate(name="노트북 메일", scopes=["mail"]), user=alice, db=db)
    plain = created["password"]
    assert len(plain) == 19 and plain.count("-") == 3

    listed = await me_security.list_app_passwords(user=alice, db=db)
    dump = json.dumps(listed, default=str)
    assert plain not in dump and "token_hash" not in dump
    assert listed["app_passwords"][0]["scopes"] == ["mail"]
    assert (await me_security.list_app_passwords(user=bob, db=db))["app_passwords"] == []

    assert await me_security.verify_app_password(db, alice, plain, "mail") is True
    assert await me_security.verify_app_password(db, alice, plain.upper(), "mail") is True
    assert await me_security.verify_app_password(db, alice, plain, "dav") is False  # 범위 밖
    assert await me_security.verify_app_password(db, bob, plain, "mail") is False   # 타 사용자 계정
    row = await db.get(AppPassword, created["id"])
    assert row.last_used_at is not None and plain not in row.token_hash

    with pytest.raises(HTTPException) as e:  # 타 사용자의 항목은 삭제 불가
        await me_security.delete_app_password(created["id"], user=bob, db=db)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException):
        await me_security.create_app_password(me_security.AppPasswordCreate(name="x", scopes=["admin"]), user=alice, db=db)
    await me_security.delete_app_password(created["id"], user=alice, db=db)
    assert await me_security.verify_app_password(db, alice, plain, "mail") is False


@pytest.mark.asyncio
async def test_app_password_accepted_by_mail_auth_and_dav(db, monkeypatch):
    alice = await db.get(User, "alice")
    alice.totp_secret = pyotp.random_base32()  # 2단계 사용자도 OTP 불필요
    await db.commit()
    mail_pw = (await me_security.create_app_password(
        me_security.AppPasswordCreate(name="m", scopes=["mail"]), user=alice, db=db))["password"]
    dav_pw = (await me_security.create_app_password(
        me_security.AppPasswordCreate(name="d", scopes=["dav"]), user=alice, db=db))["password"]
    monkeypatch.setattr(internal_router.settings, "internal_api_key", "k")

    r = await internal_router.mail_auth(_request("/api/internal/mail-auth"), email="alice@x", password=mail_pw,
                                        x_internal_key="k", db=db)
    assert r.body == b"OK"
    r = await internal_router.mail_auth(_request("/api/internal/mail-auth"), email="bob@x", password=mail_pw,
                                        x_internal_key="k", db=db)
    assert r.body == b"NO"
    r = await internal_router.mail_auth(_request("/api/internal/mail-auth"), email="alice@x", password=dav_pw,
                                        x_internal_key="k", db=db)
    assert r.body == b"NO"

    def basic(u, p):
        return "Basic " + base64.b64encode(f"{u}:{p}".encode()).decode()

    assert (await authenticate_dav(basic("alice", dav_pw), db)).id == "alice"
    assert await authenticate_dav(basic("alice", mail_pw), db) is None
    assert await authenticate_dav(basic("bob", dav_pw), db) is None


# ── 연결된 앱(OAuth) ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_connected_apps_grouped_and_caller_scoped(db, monkeypatch):
    async def _lookup(db_, cid):
        return {"client_name": {"portal-gitea": "Gitea"}.get(cid, cid)}

    import app.auth.oauth_provider as op
    monkeypatch.setattr(op, "_lookup_client", _lookup)
    now = datetime.now(timezone.utc)
    db.add(OAuthConsent(user_id="alice", client_id="portal-gitea", scopes="openid profile",
                        granted_at=now - timedelta(days=30)))
    db.add(OAuthConsent(user_id="alice", client_id="dcr_x", scopes="mcp:read", granted_at=now - timedelta(days=3)))
    exp = now + timedelta(days=30)
    db.add(OAuthRefreshToken(token_hash="a" * 64, user_id="alice", client_id="dcr_x", scope="mcp:read",
                             issued_at=now - timedelta(days=3), expires_at=exp, revoked_at=now - timedelta(days=1)))
    db.add(OAuthRefreshToken(token_hash="b" * 64, user_id="alice", client_id="dcr_x", scope="mcp:read",
                             issued_at=now - timedelta(hours=2), expires_at=exp))
    db.add(OAuthConsent(user_id="bob", client_id="dcr_bob", scopes="mcp:read"))
    db.add(OAuthRefreshToken(token_hash="c" * 64, user_id="bob", client_id="dcr_bob", scope="mcp:read",
                             issued_at=now, expires_at=exp))
    await db.commit()

    alice = await db.get(User, "alice")
    bob = await db.get(User, "bob")
    apps = (await me_security.list_connected_apps(user=alice, db=db))["apps"]
    assert [a["client_id"] for a in apps] == ["dcr_x", "portal-gitea"]  # 최근 사용 순
    gitea = apps[1]
    assert gitea["name"] == "Gitea" and gitea["scopes"] == ["openid", "profile"]
    assert "이름·표시이름" in gitea["scope_labels"]
    assert apps[0]["last_used_at"] > apps[0]["connected_at"]

    with pytest.raises(HTTPException) as e:  # 타 사용자의 앱은 연결 해제 불가
        await me_security.disconnect_app("dcr_bob", user=alice, db=db)
    assert e.value.status_code == 404
    res = await me_security.disconnect_app("dcr_x", user=alice, db=db)
    assert res["revoked_tokens"] == 1
    assert [a["client_id"] for a in (await me_security.list_connected_apps(user=alice, db=db))["apps"]] == ["portal-gitea"]
    assert len((await me_security.list_connected_apps(user=bob, db=db))["apps"]) == 1  # bob 은 유지


# ── 로그인 보호 정책 ────────────────────────────────────────


@pytest.mark.asyncio
async def test_lockout_counts_account_and_ip(redis):
    pol = {**security_policy.DEFAULTS, "lockout_enabled": True}
    assert await security_policy.check_lockout(pol, "alice", "1.1.1.1") == 0
    for _ in range(security_policy.LOCKOUT_THRESHOLD):
        await security_policy.record_failure(pol, "Alice", "1.1.1.1")
    assert await security_policy.check_lockout(pol, "alice", "2.2.2.2") > 0   # 계정 기준(대소문자 무시)
    assert await security_policy.check_lockout(pol, "bob", "1.1.1.1") == 0    # IP 기준은 한도가 더 높음
    await security_policy.clear_failures("alice")
    assert await security_policy.check_lockout(pol, "alice", "2.2.2.2") == 0
    off = dict(security_policy.DEFAULTS)
    for _ in range(10):
        await security_policy.record_failure(off, "carol", "3.3.3.3")
    assert await security_policy.check_lockout(off, "carol", "3.3.3.3") == 0  # 비활성화 상태이면 무시


@pytest.mark.asyncio
async def test_policy_store_and_validation(db):
    pol = await security_policy.set_policy(db, require_2fa="admins", lockout_enabled=True, idle_timeout_minutes=30)
    assert pol["require_2fa"] == "admins" and pol["lockout_enabled"] is True and pol["idle_timeout_minutes"] == 30
    with pytest.raises(ValueError):
        await security_policy.set_policy(db, require_2fa="everyone")
    with pytest.raises(ValueError):
        await security_policy.set_policy(db, idle_timeout_minutes=7)


def test_idle_and_totp_rules():
    pol = {**security_policy.DEFAULTS, "idle_timeout_minutes": 30, "require_2fa": "admins"}
    now = time.time()
    assert security_policy.idle_expired(pol, {"last_seen": now - 31 * 60}, now) is True
    assert security_policy.idle_expired(pol, {"last_seen": now - 5 * 60}, now) is False
    assert security_policy.idle_expired(security_policy.DEFAULTS, {"last_seen": 1}, now) is False
    admin = User(id="a", username="a", is_admin=True)
    member = User(id="m", username="m")
    assert security_policy.totp_setup_required(pol, admin) is True
    assert security_policy.totp_setup_required(pol, member) is False
    assert security_policy.totp_setup_blocks(pol, admin, "/api/files/list") is True
    assert security_policy.totp_setup_blocks(pol, admin, "/api/auth/2fa/setup") is False
    admin.totp_secret = "X"
    assert security_policy.totp_setup_blocks(pol, admin, "/api/files/list") is False


@pytest.mark.asyncio
async def test_get_current_user_enforces_totp_and_idle(db, redis):
    root = await db.get(User, "root")
    sid = await sess_mod.create_session("root", "10.0.0.5", "", "UA", 3600)
    token = sign_value({"user_id": "root", "tv": 0, "sid": sid})
    _set_policy(require_2fa="admins")
    with pytest.raises(HTTPException) as e:
        await auth_deps.get_current_user(_request("/api/files/list"), ws_session=token, db=db)
    assert e.value.status_code == 403
    assert (await auth_deps.get_current_user(_request("/api/auth/me"), ws_session=token, db=db)).id == "root"
    me = await auth_router.me(user=root, db=db)
    assert me.totp_setup_required is True

    _set_policy(idle_timeout_minutes=15)
    rec = json.loads(redis.kv["sess:" + sid])
    rec["last_seen"] = int(time.time()) - 16 * 60
    redis.kv["sess:" + sid] = json.dumps(rec)
    with pytest.raises(HTTPException) as e:
        await auth_deps.get_current_user(_request("/api/files/list"), ws_session=token, db=db)
    assert e.value.status_code == 401 and ("sess:" + sid) not in redis.kv  # 세션도 삭제


@pytest.mark.asyncio
async def test_new_device_alert(redis):
    user = User(id="alice", username="alice", email="alice@x")
    pol = {**security_policy.DEFAULTS, "new_device_alert": True}
    win = "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36"
    ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1"
    assert await security_policy.note_login_device(pol, user, win, "10.0.0.5") is False   # 첫 로그인은 알림 미발송
    assert await security_policy.note_login_device(pol, user, win, "10.0.0.77") is False  # 같은 /24·같은 브라우저
    assert await security_policy.note_login_device(pol, user, ios, "8.8.8.8") is True
    assert await security_policy.note_login_device(pol, user, ios, "8.8.8.8") is False    # 이 시점부터 알려진 기기
    off = dict(security_policy.DEFAULTS)
    assert await security_policy.note_login_device(off, user, "curl/8", "9.9.9.9") is False


# ── 사용자 AI 기본값 ────────────────────────────────────────


@pytest.mark.asyncio
async def test_ai_prefs_and_provider_choice(db, monkeypatch):
    monkeypatch.setitem(registry._module_states, "ai", True)
    alice = await db.get(User, "alice")
    await ai_config.set_ai_config(db, kind="compatible", base_url="http://127.0.0.1:9", model="base-m",
                                  advanced_model="big-m")
    await ai_config.set_governance(db, allow_user_keys=True)
    await ai_config.set_user_provider(db, "alice", kind="openai", model="gpt-x", api_key="sk-abcdefghijklmnop1234")

    cfg = await ai_config.get_user_provider_config(db, "alice")
    assert cfg["key_hint"] == "sk-…1234" and "abcdefgh" not in json.dumps(cfg)

    # 미지정 = 기존 동작(개인 키 우선)
    prov, personal = await ai_config.resolve_provider_for_user(db, alice)
    assert personal is True and prov.model == "gpt-x"
    res = await ai_router.put_my_settings(ai_router.MyAISettingsUpdate(default_model="workspace_advanced"), user=alice, db=db)
    assert res["effective_default_model"] == "workspace_advanced"
    prov, personal = await ai_config.resolve_provider_for_user(db, alice)
    assert personal is False and prov.model == "big-m"
    await ai_router.put_my_settings(ai_router.MyAISettingsUpdate(default_model="workspace"), user=alice, db=db)
    prov, _ = await ai_config.resolve_provider_for_user(db, alice)
    assert prov.model == "base-m"
    with pytest.raises(HTTPException):
        await ai_router.put_my_settings(ai_router.MyAISettingsUpdate(default_model="other"), user=alice, db=db)

    res = await ai_router.put_my_settings(
        ai_router.MyAISettingsUpdate(tools={"web": True, "mail": False, "bogus": True}, instructions="  짧게  "),
        user=alice, db=db)
    assert res["tools"] == {"mail": False, "files": True, "calendar": True, "web": True}
    assert res["instructions"] == "짧게"
    # bob 의 설정은 별도
    bob = await db.get(User, "bob")
    assert (await ai_config.get_user_ai_prefs(db, "bob"))["tools"]["mail"] is True
    assert ai_config.compose_system("짧게", "") == "짧게"
    assert ai_config.compose_system("짧게", "코드는 TS") == "짧게\n\n코드는 TS"
    assert ai_config.compose_system("", "") is None
    del bob


@pytest.mark.asyncio
async def test_ai_tool_gate_respects_user_prefs(db, monkeypatch):
    alice = await db.get(User, "alice")
    calls = []

    async def _exec(name, args, user, **_kw):
        calls.append(name)
        return {"ok": True, "result": {}}

    monkeypatch.setattr(ai_config, "_mcp_execute", _exec)
    await ai_config.set_user_ai_prefs(db, "alice", tools={"mail": False})
    r = await ai_config.ai_execute_tool(db, "mail_search", {}, alice, provider_external=False)
    assert r["ok"] is False and calls == []
    r = await ai_config.ai_execute_tool(db, "tasks_list", {}, alice, provider_external=False)  # 스위치 대상이 아닌 도구
    assert r["ok"] is True and calls == ["tasks_list"]
    filtered = ai_router._filter_tools_by_prefs(
        [{"function": {"name": "mail_search"}}, {"function": {"name": "files_read"}}],
        (await ai_config.get_user_ai_prefs(db, "alice"))["tools"])
    assert [t["function"]["name"] for t in filtered] == ["files_read"]


@pytest.mark.asyncio
async def test_ai_daily_limit_and_retention(db):
    from app.ai.models import AIConversation, AIMessage

    alice = await db.get(User, "alice")
    await ai_config.set_governance(db, daily_limit=2, retention_days=30)
    with pytest.raises(ValueError):
        await ai_config.set_governance(db, daily_limit=-1)
    c = AIConversation(id="c1", user_id="alice", title="t")
    old = AIConversation(id="c0", user_id="alice", title="old",
                         updated_at=datetime.now(timezone.utc) - timedelta(days=40))
    keep_bob = AIConversation(id="cb", user_id="bob", title="bob",
                              updated_at=datetime.now(timezone.utc) - timedelta(days=40))
    db.add_all([c, old, keep_bob])
    db.add(AIMessage(conversation_id="c1", user_id="alice", role="user", content="1"))
    await db.commit()
    await ai_router._enforce_daily_limit(db, alice)  # 1회 — 통과
    db.add(AIMessage(conversation_id="c1", user_id="alice", role="user", content="2"))
    await db.commit()
    with pytest.raises(HTTPException) as e:
        await ai_router._enforce_daily_limit(db, alice)
    assert e.value.status_code == 429
    await ai_router._prune_old_conversations(db, alice)
    assert await db.get(AIConversation, "c0") is None
    assert await db.get(AIConversation, "c1") is not None
    assert await db.get(AIConversation, "cb") is not None  # 타 사용자의 대화는 변경하지 않음


@pytest.mark.asyncio
async def test_setup_returns_qr_png(db):
    bob = await db.get(User, "bob")
    res = await auth_router.setup_2fa(user=bob)
    assert res["secret"] and res["otpauth_url"].startswith("otpauth://")
    assert res["qr_data_url"].startswith("data:image/png;base64,")
