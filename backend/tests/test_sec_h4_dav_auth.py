"""회귀 — CalDAV/CardDAV 는 앱 비밀번호만, 실패는 로그인 잠금에 집계."""

import base64

import pytest

from app.auth import me_security, security_policy
from app.auth.password import hash_password
from app.config import get_settings
from app.db.models import User
from app.dav.auth import authenticate_dav
from tests.test_settings_security_p8 import _set_policy, db, redis  # noqa: F401 (픽스처 재사용)


def basic(u, p):
    return "Basic " + base64.b64encode(f"{u}:{p}".encode()).decode()


async def _setup(db):
    alice = await db.get(User, "alice")
    alice.password_hash = hash_password("main-pass-123")
    await db.commit()
    pw = (await me_security.create_app_password(
        me_security.AppPasswordCreate(name="d", scopes=["dav"]), user=alice, db=db))["password"]
    return alice, pw


async def test_account_password_rejected_app_password_ok(db, redis):
    alice, dav_pw = await _setup(db)
    assert await authenticate_dav(basic("alice", "main-pass-123"), db, "10.0.0.9") is None
    assert (await authenticate_dav(basic("alice", dav_pw), db, "10.0.0.9")).id == "alice"


async def test_transition_flag_still_blocks_2fa_accounts(db, redis, monkeypatch):
    alice, _ = await _setup(db)
    monkeypatch.setattr(get_settings(), "dav_allow_account_password", True, raising=False)
    assert (await authenticate_dav(basic("alice", "main-pass-123"), db, "10.0.0.9")).id == "alice"
    alice.totp_secret = "JBSWY3DPEHPK3PXP"
    await db.commit()
    assert await authenticate_dav(basic("alice", "main-pass-123"), db, "10.0.0.9") is None
    alice.totp_secret = None
    await db.commit()
    _set_policy(require_2fa="all")
    assert await authenticate_dav(basic("alice", "main-pass-123"), db, "10.0.0.9") is None


async def test_failures_count_toward_lockout(db, redis):
    _, dav_pw = await _setup(db)
    _set_policy(lockout_enabled=True)
    for _ in range(security_policy.LOCKOUT_THRESHOLD):
        assert await authenticate_dav(basic("alice", "guess"), db, "10.0.0.9") is None
    # 잠긴 뒤에는 맞는 앱 비밀번호도 받지 않는다(메인 로그인과 같은 잠금)
    assert await authenticate_dav(basic("alice", dav_pw), db, "10.0.0.9") is None
