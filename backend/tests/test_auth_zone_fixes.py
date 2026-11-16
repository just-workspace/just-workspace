"""인증·계정·관리자 구역 전수조사 수정 사항 고정.

- 거절 시 타 사용자의 메일함이 삭제되던 문제 / 예약어·기존 사서함 이름으로 가입(3·14)
- 비밀번호 NFKC 정규화가 저장 시에만 적용되어 로그인이 불가하던 문제(2)
- 비밀번호 변경·강제 로그아웃·정지 시 OAuth 리프레시 토큰 폐기, 액세스 토큰 tv(4)
- 로그인 기억 기간 상한(7), 내장 메일서버 웹 토글(9), 2단계 코드 대입 잠금·관리자 초기화(1·10)
- link-login 열린 리다이렉트(11), LDAP 계정의 로컬 비밀번호(13), 최근 로그인(15), 초대 선점(20)
"""

import unicodedata
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.backup.models  # noqa: F401 — 메타데이터에 테이블 등록
from app.admin import router as ar
from app.admin import settings as admin_settings
from app.admin import users_ext as ux
from app.auth import deps, oauth_store, security_policy, two_factor
from app.auth import router as auth_router
from app.auth.password import hash_password, verify_and_upgrade, verify_password
from app.auth.schemas import RegisterRequest
from app.db.models import AuditLog, Base, OAuthRefreshToken, SystemSetting, User, UserInvite

LOGIN = datetime(2026, 10, 1, tzinfo=timezone.utc)
# 한/영 상태에서 입력한 낱자모 — NFKC 적용 시 형태가 변경된다(호환 자모 → 조합형, 일부는 음절로 병합)
JAMO_PW = "ㅔㅁㄴㄴ재ㄱㅇ1!"


class _Req:
    """슬로우API 를 거치지 않고(__wrapped__) 처리기를 직접 호출할 때 사용하는 가짜 요청."""

    def __init__(self, cookies=None, headers=None):
        self.headers = headers or {}
        self.cookies = cookies or {}
        self.client = None
        self.scope = {"state": {}}

        class _S:
            pass

        self.state = _S()


@pytest.fixture()
async def db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _no_mail(*a, **kw):
        return None

    monkeypatch.setattr(ar, "_send_welcome_email", _no_mail)
    monkeypatch.setattr(auth_router, "_send_verify_email", _no_mail)
    monkeypatch.setattr(auth_router, "_send_admin_registration_notify", _no_mail)
    async with factory() as s:
        s.add(User(id="admin", username="boss", email="boss@x", password_hash="x", is_admin=True,
                   last_login_at=LOGIN, email_verified=True))
        s.add(User(id="kim", username="kim", email="kim@x", password_hash="x", last_login_at=LOGIN,
                   email_verified=True))
        s.add(User(id="new", username="newbie", email="newbie@x", password_hash="x", is_active=False))
        await s.commit()
        yield s
    await engine.dispose()


def _forbid_mail_delete(monkeypatch):
    """거절 경로가 메일 계정 삭제를 호출하면 즉시 실패하도록 한다."""
    from app.mail import mailserver

    async def _boom(email):
        raise AssertionError(f"거절이 메일 계정을 지우려 했다: {email}")

    monkeypatch.setattr(mailserver, "delete_account", _boom)


# ── 2: 비밀번호 정규화 ─────────────────────────────────────


def test_password_changed_by_nfkc_still_verifies():
    assert unicodedata.normalize("NFKC", JAMO_PW) != JAMO_PW          # 전제: 정규화로 변경되는 입력
    stored = hash_password(unicodedata.normalize("NFKC", JAMO_PW))     # 가입·변경 시 저장되는 형태
    assert verify_password(JAMO_PW, stored)                            # 사용자는 동일한 키를 그대로 입력
    assert verify_and_upgrade(JAMO_PW, stored) == (True, None)
    assert not verify_password(JAMO_PW + "x", stored)


def test_password_stored_raw_before_normalization_still_verifies():
    """최초 관리자·시드처럼 원문 그대로 해시한 기존 계정도 계속 로그인 가능해야 한다."""
    stored = hash_password(JAMO_PW)
    assert verify_password(JAMO_PW, stored)
    assert verify_and_upgrade(JAMO_PW, stored)[0] is True


@pytest.mark.asyncio
async def test_local_login_accepts_password_as_typed(db):
    body = RegisterRequest(username="hangul", password=JAMO_PW, display_name="한글", recovery_email="h@ex.com")
    db.add(User(id="h", username="hangul", email="hangul@x", password_hash=hash_password(body.password)))
    await db.commit()
    assert (await auth_router._try_local_login(db, "hangul", JAMO_PW)).id == "h"
    assert await auth_router._try_local_login(db, "hangul", "wrong-password") is None
    assert await auth_router._try_local_login(db, "nobody", JAMO_PW) is None      # 존재하지 않는 계정(더미 검증 경로)


# ── 13: LDAP 계정의 로컬 비밀번호 ───────────────────────────


@pytest.mark.asyncio
async def test_ldap_account_cannot_use_leftover_local_password(db, monkeypatch):
    from app.auth import ldap_client

    state = {"on": True}

    async def _enabled(_db):
        return state["on"]
    monkeypatch.setattr(ldap_client, "is_enabled", _enabled)
    db.add(User(id="l", username="ldapuser", email="l@x", password_hash=hash_password("Correct-Horse-9"),
                auth_source="ldap", recovery_email="l@ex.com"))
    db.add(User(id="o", username="olduser", email="o@x", password_hash=hash_password("Correct-Horse-9"),
                auth_source="local"))
    await db.commit()
    assert await auth_router._try_local_login(db, "ldapuser", "Correct-Horse-9") is None
    assert (await auth_router._try_local_login(db, "olduser", "Correct-Horse-9")).id == "o"
    # auth_source 가 비어 있는 기존 계정은 로컬 계정이다(NULL 을 외부 인증으로 간주하지 않는다)
    assert auth_router.is_local_account(User(username="ancient", auth_source=None))

    # 비밀번호 찾기는 동일한 응답을 반환하되 LDAP 계정에는 토큰을 생성하지 않는다
    from app.auth.schemas import ForgotPasswordRequest
    await auth_router.forgot_password.__wrapped__(_Req(), ForgotPasswordRequest(username="ldapuser"), db)
    assert (await db.get(User, "l")).password_reset_token is None

    # LDAP 비활성화 시 LDAP 으로 전환되었던 계정도 남아 있는 로컬 비밀번호로 로그인된다(연동 해제 시 잠김 방지)
    state["on"] = False
    assert (await auth_router._try_local_login(db, "ldapuser", "Correct-Horse-9")).id == "l"


# ── 3·14: 거절·가입 ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_reject_never_deletes_mail_account(db, monkeypatch):
    _forbid_mail_delete(monkeypatch)
    db.add(SystemSetting(key="feature.builtin_mailserver", value="1"))
    await db.commit()
    admin = await db.get(User, "admin")
    await ar.reject_user("new", _Req(), admin=admin, db=db)
    assert await db.get(User, "new") is None

    db.add(User(id="new2", username="noreply2", email="noreply2@x", password_hash="x", is_active=False))
    await db.commit()
    res = await ux.bulk_users(ux.BulkRequest(ids=["new2"], action="reject"), _Req(), admin=admin, db=db)
    assert res["ok"] == 1 and await db.get(User, "new2") is None


@pytest.mark.asyncio
async def test_reject_only_pending(db, monkeypatch):
    _forbid_mail_delete(monkeypatch)
    admin = await db.get(User, "admin")
    for uid in ("kim", "admin"):                                       # 활성 사용자·자기 자신
        with pytest.raises(HTTPException) as e:
            await ar.reject_user(uid, _Req(), admin=admin, db=db)
        assert e.value.status_code == 400
        assert await db.get(User, uid) is not None


@pytest.mark.asyncio
async def test_register_blocks_reserved_and_existing_mailbox(db, monkeypatch):
    assert await auth_router._username_blocked(db, "postmaster", "postmaster@x")
    assert await auth_router._username_blocked(db, "no-reply", "no-reply@x")
    # 시스템 발송 계정 주소(설정값)
    db.add(SystemSetting(key="smtp.user", value="alerts@x"))
    db.add(SystemSetting(key="smtp.from", value="워크스페이스 <hello@x>"))
    await db.commit()
    assert await auth_router._username_blocked(db, "alerts", "alerts@x")
    assert await auth_router._username_blocked(db, "hello", "hello@x")
    assert await auth_router._username_blocked(db, "minji", "minji@x") is None

    # 내장 메일서버에 이미 존재하는 주소 — 활성화 상태에서만 확인
    async def _exists(email):
        return email.startswith("shared@")

    monkeypatch.setattr(ar, "mailbox_exists", _exists)
    assert await auth_router._username_blocked(db, "shared", "shared@x") is None     # 비활성화 상태에서는 조회하지 않음
    db.add(SystemSetting(key="feature.builtin_mailserver", value="1"))
    await db.commit()
    assert await auth_router._username_blocked(db, "shared", "shared@x")
    assert await auth_router._username_blocked(db, "minji", "minji@x") is None

    with pytest.raises(HTTPException) as e:
        await auth_router.register.__wrapped__(
            _Req(), RegisterRequest(username="shared", password="Tr0ub4dor&3-horse", display_name="공용",
                                    recovery_email="s@ex.com"), db)
    assert e.value.status_code == 409
    assert (await db.execute(select(User).where(User.username == "shared"))).scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_mailbox_exists_matches_whole_address(monkeypatch):
    from app.mail import mailserver

    listing = "* jimin@x ( 12K / ~ ) [0%]\n* noreply@x ( 0 / ~ ) [0%]\n    [ aliases -> team@x ]\n"
    monkeypatch.setattr(mailserver, "_docker_exec", lambda *a, **kw: (0, listing))
    assert await ar.mailbox_exists("jimin@x") and await ar.mailbox_exists("NoReply@x")
    assert not await ar.mailbox_exists("min@x")                        # "jimin@x" 의 일부에 불과함
    monkeypatch.setattr(mailserver, "_docker_exec", lambda *a, **kw: (1, "docker down"))
    assert not await ar.mailbox_exists("jimin@x")


# ── 8·20: 바로 가입·초대 선점 ───────────────────────────────


@pytest.mark.asyncio
async def test_open_registration_prepares_account(db, monkeypatch):
    seen = []

    async def _activate(db_, user, send_welcome=True):
        seen.append((user.username, send_welcome))
        return True

    monkeypatch.setattr(ar, "activate_user", _activate)
    db.add(SystemSetting(key="auth.registration_mode", value="open"))
    await db.commit()
    await auth_router.register.__wrapped__(
        _Req(), RegisterRequest(username="minji", password="Tr0ub4dor&3-horse", display_name="민지",
                                recovery_email="m@ex.com"), db)
    assert seen == [("minji", False)]

    # 인증 완료 안내 — 이미 사용 가능한 계정에 "승인 후" 로 안내하지 않는다
    u = (await db.execute(select(User).where(User.username == "minji"))).scalar_one()
    u.email_verify_token = auth_router._token_digest("tok")
    u.email_verify_sent_at = None        # SQLite 는 시간대를 제거하고 반환하여 만료 계산이 불가하다(운영 PG 는 무관)
    await db.commit()
    msg = (await auth_router.verify_email.__wrapped__(_Req(), token="tok", db=db))["message"]
    assert "승인" not in msg and u.email_verified is True


@pytest.mark.asyncio
async def test_invite_cannot_be_used_twice(db, monkeypatch):
    async def _activate(db_, user, send_welcome=True):
        user.is_active = True
        await db_.commit()
        return True

    monkeypatch.setattr(ar, "activate_user", _activate)
    inv = UserInvite(token_hash=ux.token_digest("T"), email=None, invited_by="admin",
                     expires_at=datetime.now(timezone.utc) + timedelta(days=1))
    db.add(inv)
    await db.commit()

    def _body(name):
        return RegisterRequest(username=name, password="Tr0ub4dor&3-horse", display_name=name,
                               recovery_email=f"{name}@ex.com", invite_token="T")

    r = await auth_router.register.__wrapped__(_Req(), _body("first"), db)
    assert r["invited"] is True
    # 확인(find_open_invite) 통과 후 다른 요청이 먼저 사용 = 선점 실패
    stale = await db.get(UserInvite, inv.id)
    monkeypatch.setattr(ux, "find_open_invite", lambda *_a, **_k: _async(stale))
    with pytest.raises(HTTPException) as e:
        await auth_router.register.__wrapped__(_Req(), _body("second"), db)
    assert e.value.status_code == 400
    assert (await db.execute(select(User).where(User.username == "second"))).scalar_one_or_none() is None


async def _async(v):
    return v


# ── 4: OAuth 토큰 ───────────────────────────────────────────


def _token(uid, cid, h):
    now = datetime.now(timezone.utc)
    return OAuthRefreshToken(token_hash=h, user_id=uid, client_id=cid, scope="openid",
                             issued_at=now, expires_at=now + timedelta(days=30))


async def _live(db, uid):
    rows = (await db.execute(select(OAuthRefreshToken).where(OAuthRefreshToken.user_id == uid))).scalars().all()
    return sorted(r.token_hash for r in rows if r.revoked_at is None)


@pytest.mark.asyncio
async def test_refresh_tokens_revoked_with_sessions(db):
    admin = await db.get(User, "admin")
    db.add_all([_token("kim", "desktop-app", "k1"), _token("kim", "dcr_x", "k2"), _token("admin", "desktop-app", "a1")])
    await db.commit()

    assert await oauth_store.revoke_user_refresh_tokens(db, "kim") == 2
    await db.commit()
    assert await _live(db, "kim") == [] and await _live(db, "admin") == ["a1"]

    # 관리자 강제 로그아웃(개별) — 토큰 폐기 + token_version + 감사 로그
    db.add(_token("kim", "desktop-app", "k3"))
    await db.commit()
    await ar.logout_user_sessions("kim", _Req(), admin=admin, db=db)
    assert await _live(db, "kim") == [] and (await db.get(User, "kim")).token_version == 1
    acts = (await db.execute(select(AuditLog.action))).scalars().all()
    assert "session.logout_user" in acts

    # 정지(일괄·단건)
    db.add(_token("kim", "desktop-app", "k4"))
    await db.commit()
    await ux.bulk_users(ux.BulkRequest(ids=["kim"], action="suspend"), _Req(), admin=admin, db=db)
    assert await _live(db, "kim") == []

    # 전체 강제 로그아웃
    await ar.logout_all_sessions(_Req(), admin=admin, db=db)
    assert await _live(db, "admin") == []


@pytest.mark.asyncio
async def test_first_party_token_rejected_after_token_version_bump(db, monkeypatch):
    from app.auth import oauth_provider as oauth

    payload = {"type": "workspace_oauth", "client_id": "desktop-app", "sub": "kim"}

    async def _verify(db_, token, **kw):
        return dict(payload)

    monkeypatch.setattr(oauth, "verify_access_token", _verify)
    # 클레임이 없는 기존 토큰 — 배포 시점에 무효화되면 안 된다
    assert (await deps._user_from_first_party_oauth(db, "t")).id == "kim"
    payload["tv"] = 0
    assert (await deps._user_from_first_party_oauth(db, "t")).id == "kim"
    (await db.get(User, "kim")).token_version = 1                      # 비밀번호 변경·강제 로그아웃
    await db.commit()
    assert await deps._user_from_first_party_oauth(db, "t") is None
    payload.pop("tv")
    assert (await deps._user_from_first_party_oauth(db, "t")).id == "kim"


# ── 7·9·11·15 ───────────────────────────────────────────────


def test_session_signature_outlives_longest_remember_setting():
    assert deps.SESSION_MAX_AGE >= 365 * 86400                         # 설정 상한(365일)까지 서명이 유효해야 함


@pytest.mark.asyncio
async def test_builtin_mailserver_flag_follows_web_toggle(db):
    env = bool(getattr(admin_settings.get_settings(), "feature_builtin_mailserver", False))
    assert await admin_settings.builtin_mailserver_enabled(db) is env
    db.add(SystemSetting(key="feature.builtin_mailserver", value="0" if env else "1"))
    await db.commit()
    assert await admin_settings.builtin_mailserver_enabled(db) is (not env)


def test_safe_local_redirect():
    f = auth_router.safe_local_redirect
    assert f("/mail?x=1") == "/mail?x=1"
    for bad in ("//evil.example", "/\\evil.example", "https://evil.example", "evil", "", "/a\nb"):
        assert f(bad) == "/"


def test_access_log_sees_user_who_just_logged_in():
    from app.middleware.access_log import _extract_user_id

    req = _Req()
    assert _extract_user_id(req) is None
    req.scope["state"]["login_user_id"] = "kim"
    assert _extract_user_id(req) == "kim"


# ── 1·10: 2단계 ─────────────────────────────────────────────


class _FakeRedis:
    def __init__(self):
        self.d = {}

    async def get(self, k):
        return self.d.get(k)

    async def incr(self, k):
        self.d[k] = int(self.d.get(k, 0)) + 1
        return self.d[k]

    async def ttl(self, k):
        return 600 if k in self.d else -2

    async def expire(self, k, t):
        return True

    async def delete(self, *ks):
        for k in ks:
            self.d.pop(k, None)


@pytest.mark.asyncio
async def test_two_factor_lock_after_repeated_failures(monkeypatch):
    r = _FakeRedis()

    async def _redis():
        return r

    monkeypatch.setattr(security_policy, "_redis", _redis)
    for _ in range(security_policy.TWO_FA_MAX_FAILS - 1):
        await security_policy.record_2fa_failure("kim")
    assert await security_policy.check_2fa_lock("kim") == 0
    await security_policy.record_2fa_failure("kim")
    assert await security_policy.check_2fa_lock("kim") > 0
    assert await security_policy.check_2fa_lock("other") == 0          # 계정 단위
    await security_policy.clear_2fa_failures("kim")
    assert await security_policy.check_2fa_lock("kim") == 0


@pytest.mark.asyncio
async def test_two_factor_verify_refuses_while_locked(db, monkeypatch):
    import pyotp
    from app.auth.schemas import TwoFactorVerifyRequest

    secret = pyotp.random_base32()
    (await db.get(User, "kim")).totp_secret = secret
    await db.commit()

    async def _locked(uid):
        return 120

    monkeypatch.setattr(security_policy, "check_2fa_lock", _locked)
    temp = deps.sign_value({"user_id": "kim", "purpose": "2fa", "remember_me": False})
    with pytest.raises(HTTPException) as e:                            # 올바른 코드여도 잠금 중에는 거부
        await auth_router.verify_2fa.__wrapped__(
            _Req(), TwoFactorVerifyRequest(temp_token=temp, code=pyotp.TOTP(secret).now()), db)
    assert e.value.status_code == 429


@pytest.mark.asyncio
async def test_admin_reset_two_factor(db):
    admin = await db.get(User, "admin")
    kim = await db.get(User, "kim")
    with pytest.raises(HTTPException) as e:                            # 미사용 사용자
        await ux.reset_user_2fa("kim", _Req(), admin=admin, db=db)
    assert e.value.status_code == 400

    kim.totp_secret = "JBSWY3DPEHPK3PXP"
    two_factor.issue_new_codes(kim)
    await db.commit()
    assert ar._user_row(kim)["has_2fa"] is True
    await ux.reset_user_2fa("kim", _Req(), admin=admin, db=db)
    kim = await db.get(User, "kim")
    assert kim.totp_secret is None and kim.totp_recovery_codes is None
    assert kim.token_version == 1 and ar._user_row(kim)["has_2fa"] is False
    row = (await db.execute(select(AuditLog).where(AuditLog.action == "user.reset_2fa"))).scalar_one()
    assert row.actor_id == "admin" and row.resource_id == "kim"


# ── 6: 폴링은 유휴 시각을 갱신하지 않는다 ───────────────────


@pytest.mark.asyncio
async def test_background_poll_does_not_refresh_idle_clock(db, monkeypatch):
    from app.auth import sessions as sess_mod

    touched = []

    async def _get(sid):
        return {"user_id": "kim", "last_seen": 0, "ttl": 100}

    async def _touch(sid, rec, ip):
        touched.append(sid)

    async def _policy(db_=None):
        return dict(security_policy.DEFAULTS)

    monkeypatch.setattr(sess_mod, "get_session", _get)
    monkeypatch.setattr(sess_mod, "touch_session", _touch)
    monkeypatch.setattr(security_policy, "get_policy_cached", _policy)
    token = deps.sign_value({"user_id": "kim", "tv": 0, "sid": "S"})

    class _R(_Req):
        class url:  # noqa: N801
            path = "/api/notifications/unread-count"

    assert (await deps.get_current_user(_R(headers={"x-background": "1"}), ws_session=token, db=db)).id == "kim"
    assert touched == []                                               # 화면이 자동 수행하는 폴링
    await deps.get_current_user(_R(), ws_session=token, db=db)
    assert touched == ["S"]                                            # 사용자가 직접 수행한 요청
