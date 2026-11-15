"""관리자 시드 · reset-admin(app/cli.py).

- 자동 시드는 사용자가 한 명도 없을 때만 — 그 뒤로는 env 에 값이 남아 있어도 아무것도 하지 않는다.
- 같은 이름의 일반 계정을 관리자로 올리지 않는다(명시한 --promote 만).
- reset-admin 은 관리자 계정에만, 임시 비밀번호는 해시로만 저장하고 한 번만 돌려준다.
"""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app import cli
from app.auth import two_factor
from app.auth.password import hash_password, verify_password
from app.db.models import User


@pytest.fixture()
async def db(db_engine, monkeypatch):
    """cli 가 쓰는 엔진·세션을 테스트용 빈 DB 로 바꾼다."""
    import app.db.session as session_mod

    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(session_mod, "engine", db_engine)
    monkeypatch.setattr(session_mod, "async_session", factory)
    return factory


async def _add(db, username, *, is_admin=False, password="old-password-123", **kw):
    async with db() as s:
        u = User(username=username, password_hash=hash_password(password), email=f"{username}@example.com",
                 is_admin=is_admin, is_active=True, email_verified=True, **kw)
        s.add(u)
        await s.commit()
        return u.id


async def _get(db, username) -> User | None:
    async with db() as s:
        return (await s.execute(select(User).where(User.username == username))).scalar_one_or_none()


# ─── 시드 ───


async def test_seed_creates_admin_on_empty_install(db):
    assert await cli.seed_admin("root1", "first-password-123", only_if_empty=True) == "created"
    u = await _get(db, "root1")
    assert u.is_admin and u.is_active and verify_password("first-password-123", u.password_hash)


async def test_startup_seed_does_nothing_once_users_exist(db):
    await _add(db, "alice")
    assert await cli.seed_admin("root1", "first-password-123", only_if_empty=True) == "skipped"
    assert await _get(db, "root1") is None


async def test_startup_seed_never_promotes_same_name_account(db, capsys):
    await _add(db, "admin")
    assert await cli.seed_admin("admin", "whatever-password-1", only_if_empty=True) == "conflict"
    u = await _get(db, "admin")
    assert not u.is_admin
    assert verify_password("old-password-123", u.password_hash)        # 비밀번호도 그대로
    assert "승격하지 않습니다" in capsys.readouterr().out


async def test_startup_seed_is_idempotent(db):
    assert await cli.seed_admin("root1", "first-password-123", only_if_empty=True) == "created"
    # 다시 기동 — env 에 다른 비밀번호가 남아 있어도 계정을 건드리지 않는다
    assert await cli.seed_admin("root1", "another-password-456", only_if_empty=True) == "skipped"
    assert verify_password("first-password-123", (await _get(db, "root1")).password_hash)


async def test_explicit_seed_promotes_only_when_asked(db):
    await _add(db, "bob")
    assert await cli.seed_admin("bob", "x") == "conflict"
    assert not (await _get(db, "bob")).is_admin
    assert await cli.seed_admin("bob", "", promote=True) == "promoted"
    u = await _get(db, "bob")
    assert u.is_admin and verify_password("old-password-123", u.password_hash)
    assert await cli.seed_admin("bob", "x") == "exists"
    # 다른 사용자가 있어도 서버에서 직접 부르면 새 관리자를 만든다
    assert await cli.seed_admin("ops", "ops-password-12345") == "created"


# ─── reset-admin ───


async def test_reset_admin_sets_new_password_and_cuts_sessions(db):
    await _add(db, "root1", is_admin=True, token_version=3)
    password = await cli.reset_admin("root1")
    u = await _get(db, "root1")
    assert len(password) >= 20
    assert verify_password(password, u.password_hash)
    assert not verify_password("old-password-123", u.password_hash)
    assert password not in u.password_hash
    assert u.token_version == 4 and u.password_changed_at is not None
    # 두 번 부르면 다른 값
    assert await cli.reset_admin("root1") != password


async def test_reset_admin_refuses_non_admin_and_unknown(db):
    await _add(db, "alice")
    with pytest.raises(cli.ResetRefused):
        await cli.reset_admin("alice")
    with pytest.raises(cli.ResetRefused):
        await cli.reset_admin("nobody")
    assert verify_password("old-password-123", (await _get(db, "alice")).password_hash)


async def test_reset_admin_keeps_2fa_unless_asked(db):
    await _add(db, "root1", is_admin=True, totp_secret="JBSWY3DPEHPK3PXP")
    async with db() as s:
        u = (await s.execute(select(User).where(User.username == "root1"))).scalar_one()
        two_factor.issue_new_codes(u)
        await s.commit()

    await cli.reset_admin("root1")
    u = await _get(db, "root1")
    assert u.totp_secret == "JBSWY3DPEHPK3PXP" and two_factor.remaining(u) > 0

    await cli.reset_admin("root1", disable_2fa=True)
    u = await _get(db, "root1")
    assert u.totp_secret is None and two_factor.remaining(u) == 0


def test_reset_admin_command_prints_password_once(monkeypatch, capsys):
    calls = []

    async def fake(username, *, disable_2fa=False):
        calls.append((username, disable_2fa))
        if username == "alice":
            raise cli.ResetRefused("관리자 계정이 아닙니다")
        return "TEMP-PASSWORD-VALUE"

    monkeypatch.setattr(cli, "reset_admin", fake)
    assert cli.main(["reset-admin", "root1", "--disable-2fa"]) == 0
    assert capsys.readouterr().out.count("TEMP-PASSWORD-VALUE") == 1
    assert cli.main(["reset-admin", "alice"]) == 1
    captured = capsys.readouterr()
    assert "TEMP-PASSWORD-VALUE" not in captured.out and "관리자 계정이 아닙니다" in captured.err
    assert calls == [("root1", True), ("alice", False)]
