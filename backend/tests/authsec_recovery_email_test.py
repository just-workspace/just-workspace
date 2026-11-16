"""복구 이메일 변경 절차(app/auth/recovery_email.py) 동작 고정.

세션만으로는 변경 불가: 본인 확인(현재 비밀번호 / LDAP 비밀번호 / 인증 앱 코드) → 새 주소 인증 → 교체 + 기존 주소 알림.
"""

import json

import pyotp
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth import recovery_email as re_mod
from app.auth import router as auth_router
from app.auth.password import hash_password
from app.auth.schemas import ProfileUpdateRequest
from app.chat import redis_client
from app.db.models import AuditLog, Base, User

PW = "Correct-Horse-9"


class _Req:
    def __init__(self):
        self.headers = {}
        self.cookies = {}
        self.client = None
        self.scope = {"state": {}}

        class _S:
            pass

        self.state = _S()


class _FakeRedis:
    def __init__(self):
        self.d = {}
        self.ttls = {}

    async def get(self, k):
        return self.d.get(k)

    async def set(self, k, v, ex=None, nx=False):
        if nx and k in self.d:
            return None
        self.d[k] = v
        self.ttls[k] = ex
        return True

    async def getdel(self, k):
        return self.d.pop(k, None)

    async def delete(self, *ks):
        for k in ks:
            self.d.pop(k, None)

    async def ttl(self, k):
        return (self.ttls.get(k) or 600) if k in self.d else -2

    async def incr(self, k):
        self.d[k] = int(self.d.get(k, 0)) + 1
        return self.d[k]

    async def decr(self, k):
        self.d[k] = int(self.d.get(k, 0)) - 1
        return self.d[k]

    async def expire(self, k, t):
        self.ttls[k] = t
        return True


@pytest.fixture()
async def env(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    r = _FakeRedis()

    async def _get_redis():
        return r

    monkeypatch.setattr(redis_client, "get_redis", _get_redis)
    mails = []

    async def _send(to, subject, body):
        mails.append((to, subject, body))

    monkeypatch.setattr(re_mod, "_send", _send)
    async with factory() as db:
        db.add(User(id="kim", username="kim", email="kim@x", password_hash=hash_password(PW),
                    recovery_email="old@ex.com", email_verified=True, password_reset_token="outstanding"))
        await db.commit()
        yield db, r, mails
    await engine.dispose()


def _token(mails) -> str:
    body = mails[-1][2]
    return body.split("/verify-email?change=")[1].split()[0]


async def _request(db, email="new@ex.com", **proof):
    user = await db.get(User, "kim")
    return await re_mod.request_change.__wrapped__(
        _Req(), re_mod.RecoveryEmailRequest(recovery_email=email, **proof), user=user, db=db)


async def _confirm(db, token):
    return await re_mod.confirm.__wrapped__(_Req(), re_mod.RecoveryEmailConfirm(token=token), db=db)


async def _check(token):
    return await re_mod.check.__wrapped__(_Req(), re_mod.RecoveryEmailConfirm(token=token))


async def _actions(db):
    return (await db.execute(select(AuditLog.action))).scalars().all()


# ── 기존 경로는 폐쇄됨 ──


@pytest.mark.asyncio
async def test_profile_patch_no_longer_changes_recovery_email(env):
    db, _r, _m = env
    kim = await db.get(User, "kim")
    with pytest.raises(HTTPException) as e:
        await auth_router.update_profile(ProfileUpdateRequest(recovery_email="attacker@evil.example"), user=kim, db=db)
    assert e.value.status_code == 400
    assert (await db.get(User, "kim")).recovery_email == "old@ex.com"
    # 표시 이름은 그대로 변경되며, 동일 주소를 그대로 포함해 송신하는 구 화면도 정상 동작한다
    await auth_router.update_profile(ProfileUpdateRequest(display_name="김", recovery_email="Old@ex.com"), user=kim, db=db)
    kim = await db.get(User, "kim")
    assert kim.display_name == "김" and kim.recovery_email == "old@ex.com"


# ── 본인 확인 ──


@pytest.mark.asyncio
async def test_wrong_or_missing_password_changes_nothing(env):
    db, r, mails = env
    for proof in ({"current_password": "wrong"}, {}, {"code": "123456"}):
        with pytest.raises(HTTPException) as e:
            await _request(db, **proof)
        assert e.value.status_code == 400
    assert mails == [] and not any(k.startswith("recovery-email:tok:") for k in r.d)
    assert (await db.get(User, "kim")).recovery_email == "old@ex.com"
    assert "user.recovery_email.reauth_failed" in await _actions(db)


@pytest.mark.asyncio
async def test_repeated_failures_lock_even_the_right_password(env):
    db, _r, mails = env
    for _ in range(re_mod.REAUTH_MAX_FAILS):
        with pytest.raises(HTTPException):
            await _request(db, current_password="wrong")
    with pytest.raises(HTTPException) as e:
        await _request(db, current_password=PW)
    assert e.value.status_code == 429 and mails == []


@pytest.mark.asyncio
async def test_same_address_and_bad_address_rejected(env):
    db, _r, mails = env
    with pytest.raises(HTTPException) as e:
        await _request(db, email=" OLD@ex.com ", current_password=PW)
    assert e.value.status_code == 400 and mails == []
    # 주소 하나만 허용 — 복수 주소·표시 이름·헤더 주입 형태는 전부 거부(To 헤더에 그대로 포함됨)
    for bad in ("nope", "a@b", "a b@ex.com", "a@ex.com,evil@ex.com", "a@ex.com;evil@ex.com", "a@ex.com, evil@ex.com",
                "Kim <a@ex.com>", "<a@ex.com>", "a@b@ex.com", "a@ex.com\nBcc: evil@ex.com", '"a"@ex.com',
                "x" * 320 + "@ex.com"):
        with pytest.raises(ValueError):
            re_mod.RecoveryEmailRequest(recovery_email=bad, current_password=PW)
    assert re_mod.RecoveryEmailRequest(recovery_email=" Kim.Min+tag@Mail.Example.com ").recovery_email \
        == "kim.min+tag@mail.example.com"


# ── 요청 → 확인 ──


@pytest.mark.asyncio
async def test_request_then_confirm(env):
    db, r, mails = env
    res = await _request(db, email=" New@Ex.com", current_password=PW)
    assert res["pending_email"] == "new@ex.com"
    # 새 주소로만 확인 메일 발송, 아직 변경 사항 없음
    assert [m[0] for m in mails] == ["new@ex.com"]
    assert (await db.get(User, "kim")).recovery_email == "old@ex.com"
    token = _token(mails)
    assert token not in json.dumps(r.d)                      # Redis 에는 토큰 원문이 없음(해시만 저장)
    assert all(v for k, v in r.ttls.items() if k.startswith("recovery-email:"))   # 전부 TTL 설정됨

    kim = await db.get(User, "kim")
    st = await re_mod.pending(user=kim, db=db)
    assert st["pending_email"] == "new@ex.com" and st["reauth"] == "password" and st["expires_in"] > 0

    await _confirm(db, token)
    kim = await db.get(User, "kim")
    assert kim.recovery_email == "new@ex.com"
    assert kim.password_reset_token is None                  # 기존 주소로 발송된 재설정 링크는 무효화된다
    # 기존 주소로 알림(새 주소는 포함하지 않는다)
    assert mails[-1][0] == "old@ex.com" and "변경" in mails[-1][1] and "new@ex.com" not in mails[-1][2]
    acts = await _actions(db)
    assert "user.recovery_email.change_requested" in acts and "user.recovery_email.changed" in acts
    row = (await db.execute(select(AuditLog).where(AuditLog.action == "user.recovery_email.changed"))).scalar_one()
    assert row.actor_id == "kim" and json.loads(row.details) == {"old": "old@ex.com", "new": "new@ex.com"}
    assert (await re_mod.pending(user=kim, db=db))["pending_email"] is None

    # 동일 링크를 재요청하면(중복 클릭·새로고침) 실패가 아닌 "이미 적용됨" — 재변경·재알림은 수행하지 않는다
    sent = len(mails)
    again = await _confirm(db, token)
    assert again.get("already") is True and len(mails) == sent
    assert (await _check(token))["state"] == "done"


@pytest.mark.asyncio
async def test_first_address_has_no_old_notice(env):
    db, _r, mails = env
    (await db.get(User, "kim")).recovery_email = None
    await db.commit()
    await _request(db, current_password=PW)
    await _confirm(db, _token(mails))
    assert (await db.get(User, "kim")).recovery_email == "new@ex.com"
    # 기존 복구 주소가 없던 계정 — 워크스페이스 메일함으로 알린다(최초 주소의 무단 등록을 계정 소유자가 인지할 수 있도록)
    assert [m[0] for m in mails] == ["new@ex.com", "kim@x"] and "변경" in mails[-1][1]


@pytest.mark.asyncio
async def test_bogus_token_rejected(env):
    db, _r, _m = env
    with pytest.raises(HTTPException) as e:
        await _confirm(db, "x" * 43)
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_new_request_kills_previous_link(env):
    db, _r, mails = env
    await _request(db, email="first@ex.com", current_password=PW)
    first = _token(mails)
    await _request(db, email="second@ex.com", current_password=PW)
    with pytest.raises(HTTPException):
        await _confirm(db, first)
    assert (await db.get(User, "kim")).recovery_email == "old@ex.com"
    await _confirm(db, _token(mails))
    assert (await db.get(User, "kim")).recovery_email == "second@ex.com"


@pytest.mark.asyncio
async def test_link_dies_when_sessions_were_revoked_or_address_changed(env):
    db, _r, mails = env
    # 요청 후 비밀번호 변경·강제 로그아웃(token_version 증가) — 사전에 발급된 링크는 무효
    await _request(db, current_password=PW)
    kim = await db.get(User, "kim")
    kim.token_version = (kim.token_version or 0) + 1
    await db.commit()
    with pytest.raises(HTTPException):
        await _confirm(db, _token(mails))
    assert (await db.get(User, "kim")).recovery_email == "old@ex.com"

    # 요청 후 관리자가 주소를 변경함 — 기존 요청으로 덮어쓰지 않는다
    await _request(db, current_password=PW)
    (await db.get(User, "kim")).recovery_email = "admin-set@ex.com"
    await db.commit()
    with pytest.raises(HTTPException):
        await _confirm(db, _token(mails))
    assert (await db.get(User, "kim")).recovery_email == "admin-set@ex.com"

    # 정지된 계정
    await _request(db, current_password=PW)
    (await db.get(User, "kim")).is_active = False
    await db.commit()
    with pytest.raises(HTTPException):
        await _confirm(db, _token(mails))


@pytest.mark.asyncio
async def test_cancel(env):
    db, r, mails = env
    await _request(db, current_password=PW)
    kim = await db.get(User, "kim")
    await re_mod.cancel(_Req(), user=kim, db=db)
    assert not any(k.startswith("recovery-email:") for k in r.d)
    with pytest.raises(HTTPException):
        await _confirm(db, _token(mails))
    assert "user.recovery_email.change_cancelled" in await _actions(db)


@pytest.mark.asyncio
async def test_mail_failure_leaves_no_pending(env, monkeypatch):
    db, r, _m = env

    async def _boom(*a):
        raise OSError("smtp down")

    monkeypatch.setattr(re_mod, "_send", _boom)
    with pytest.raises(HTTPException) as e:
        await _request(db, current_password=PW)
    assert e.value.status_code == 502
    assert not any(k.startswith("recovery-email:") for k in r.d)


@pytest.mark.asyncio
async def test_redis_down_refuses(env, monkeypatch):
    db, _r, mails = env

    async def _down():
        raise ConnectionError("redis down")

    monkeypatch.setattr(redis_client, "get_redis", _down)
    with pytest.raises(HTTPException) as e:
        await _request(db, current_password=PW)
    assert e.value.status_code == 503 and mails == []


@pytest.mark.asyncio
async def test_redis_down_never_reaches_password_check(env, monkeypatch):
    """잠금을 판정할 수 없으면 비밀번호 검증 자체를 수행하지 않는다(잠금 없는 대입 공격 경로가 되지 않도록)."""
    db, _r, _m = env

    async def _down():
        raise ConnectionError("redis down")

    async def _never(*a, **k):
        raise AssertionError("Redis 가 죽었는데 비밀번호를 검증했다")

    monkeypatch.setattr(redis_client, "get_redis", _down)
    monkeypatch.setattr(re_mod, "_check_password", _never)
    for pw in ("wrong", PW):
        with pytest.raises(HTTPException) as e:
            await _request(db, current_password=pw)
        assert e.value.status_code == 503


@pytest.mark.asyncio
async def test_attempts_are_counted_before_verifying(env, monkeypatch):
    """동시에 송신된 요청들이 모두 "아직 안 잠김"을 확인하고 통과하는 것을 방지한다 — 검증 전에 INCR 로 계수한다."""
    import asyncio

    db, r, _m = env
    checked = []

    async def _slow_wrong(_db, _user, password):
        checked.append(int(r.d["recovery-email:fail:kim"]))    # 검증 시점에 이미 계수됨
        await asyncio.sleep(0)
        return False

    monkeypatch.setattr(re_mod, "_check_password", _slow_wrong)

    async def _noop(*a, **k):
        return None

    from app.admin import audit
    monkeypatch.setattr(audit, "log_action", _noop)            # 단일 세션의 동시 사용 방지
    res = await asyncio.gather(*[_request(db, current_password=f"guess{i}") for i in range(12)],
                               return_exceptions=True)
    codes = sorted(e.status_code for e in res)
    assert codes.count(400) == re_mod.REAUTH_MAX_FAILS and codes.count(429) == 12 - re_mod.REAUTH_MAX_FAILS
    assert len(checked) == re_mod.REAUTH_MAX_FAILS and min(checked) >= 1


# ── 착지 화면: 조회만(check) → 버튼(confirm) ──


@pytest.mark.asyncio
async def test_check_does_not_consume_the_link(env):
    db, _r, mails = env
    await _request(db, current_password=PW)
    token = _token(mails)
    for _ in range(3):                                         # 메일 보안 장비의 사전 열람·새로고침
        assert (await _check(token))["state"] == "pending"
    assert (await db.get(User, "kim")).recovery_email == "old@ex.com"
    assert (await _check("y" * 43))["state"] == "invalid"
    await _confirm(db, token)
    assert (await _check(token))["state"] == "done"


# ── 비우기 ──


@pytest.mark.asyncio
async def test_clear_needs_reauth_then_applies_at_once(env):
    db, r, mails = env
    with pytest.raises(HTTPException) as e:
        await _request(db, email="", current_password="wrong")
    assert e.value.status_code == 400 and (await db.get(User, "kim")).recovery_email == "old@ex.com"

    await _request(db, email="pending@ex.com", current_password=PW)      # 대기 중이던 변경 요청
    pending_token = _token(mails)
    res = await _request(db, email="  ", current_password=PW)
    assert res["cleared"] is True
    kim = await db.get(User, "kim")
    assert kim.recovery_email is None and kim.password_reset_token is None
    assert mails[-1][0] == "old@ex.com" and "삭제" in mails[-1][1]        # 기존 주소로 알림
    assert "user.recovery_email.cleared" in await _actions(db)
    assert not any(k.startswith(("recovery-email:tok:", "recovery-email:user:")) for k in r.d)
    with pytest.raises(HTTPException):                                   # 대기 중이던 링크도 무효화된다
        await _confirm(db, pending_token)
    with pytest.raises(HTTPException) as e:                              # 이미 빈 값
        await _request(db, email="", current_password=PW)
    assert e.value.status_code == 400


# ── 로컬 비밀번호가 없는 계정 ──


@pytest.mark.asyncio
async def test_ldap_account_reauths_against_directory(env, monkeypatch):
    db, _r, mails = env
    from app.auth import ldap_client

    async def _enabled(_db):
        return True

    state = {"down": False}

    async def _auth(_db, username, password):
        if state["down"]:
            raise ldap_client.LdapUnavailable("connection refused")
        return {"dn": "cn=kim"} if (username, password) == ("kim", "dir-secret") else None

    monkeypatch.setattr(ldap_client, "is_enabled", _enabled)
    monkeypatch.setattr(ldap_client, "authenticate_strict", _auth)
    kim = await db.get(User, "kim")
    kim.auth_source = "ldap"                                 # 잔존하는 구 로컬 해시(PW)는 인증에 통과해서는 안 된다
    await db.commit()
    assert await re_mod.reauth_method(db, kim) == "password"
    with pytest.raises(HTTPException):
        await _request(db, current_password=PW)
    # 디렉터리 장애는 "틀림"이 아니다 — 503, 실패 횟수에 포함하지 않는다(장애 중 사용자 잠금 방지)
    state["down"] = True
    before = int(_r.d.get("recovery-email:fail:kim", 0))
    for _ in range(re_mod.REAUTH_MAX_FAILS + 2):
        with pytest.raises(HTTPException) as e:
            await _request(db, current_password="dir-secret")
        assert e.value.status_code == 503
    assert int(_r.d.get("recovery-email:fail:kim", 0)) == before
    state["down"] = False
    await _request(db, current_password="dir-secret")
    assert mails[-1][0] == "new@ex.com"


def test_ldap_strict_separates_outage_from_wrong_password(monkeypatch):
    """ldap_client: 기존 authenticate 는 장애도 None(틀림) — strict 만 LdapUnavailable 예외를 발생시킨다."""
    import sys
    import types

    from app.auth import ldap_client

    class _Boom:
        def __init__(self, *a, **k):
            raise OSError("connection refused")

    fake = types.ModuleType("ldap3")
    fake.Server = fake.Connection = _Boom
    fake.ALL = fake.SUBTREE = object()
    conv = types.ModuleType("ldap3.utils.conv")
    conv.escape_filter_chars = lambda s: s
    utils = types.ModuleType("ldap3.utils")
    utils.conv = conv
    for name, mod in (("ldap3", fake), ("ldap3.utils", utils), ("ldap3.utils.conv", conv)):
        monkeypatch.setitem(sys.modules, name, mod)
    cfg = {"host": "ldap", "port": 389, "use_ssl": False, "bind_dn": "", "bind_password": "", "base_dn": "dc=x",
           "user_filter": "(uid={username})", "attr_email": "mail", "attr_name": "cn"}
    assert ldap_client._authenticate_sync(cfg, "kim", "pw") is None
    with pytest.raises(ldap_client.LdapUnavailable):
        ldap_client._authenticate_sync(cfg, "kim", "pw", True)
    assert ldap_client._authenticate_sync(cfg, "kim", "", True) is None        # 빈 비밀번호는 장애가 아닌 거부


@pytest.mark.asyncio
async def test_passwordless_account_uses_totp_or_is_refused(env):
    db, _r, mails = env
    kim = await db.get(User, "kim")
    kim.password_hash = None
    await db.commit()
    assert await re_mod.reauth_method(db, kim) == "none"
    with pytest.raises(HTTPException) as e:
        await _request(db, current_password="anything")
    assert e.value.status_code == 400 and mails == []

    secret = pyotp.random_base32()
    kim.totp_secret = secret
    await db.commit()
    assert await re_mod.reauth_method(db, kim) == "totp"
    with pytest.raises(HTTPException):
        await _request(db, code="000000" if pyotp.TOTP(secret).now() != "000000" else "111111")
    await _request(db, code=pyotp.TOTP(secret).now())
    assert mails[-1][0] == "new@ex.com"
