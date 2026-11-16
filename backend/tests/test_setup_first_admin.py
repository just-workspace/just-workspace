"""첫 관리자 만들기(`POST /api/setup/admin`)와 설정 토큰(app/setup/token.py).

- 설치 관리자가 꾸린 설치(JW_INSTALLER_KEY)에서는 관리자가 0명이어도 닫혀 있다.
- 그 밖에서는 일회용 설정 토큰이 맞아야 한다. 토큰은 DB 에 해시로만 있고(워커·CLI 공통), 관리자가 생기면 사라진다.
- 비밀번호 하한은 12자.
- 같은 접두사의 나머지 경로는 관리자 세션 없이는 아무것도 바꾸지 못한다.
"""

import asyncio
import hashlib

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import cli
from app.db.models import Base, SystemSetting, User
from app.db.session import get_db
from app.rate_limit import limiter
from app.setup import token as setup_token

GOOD_PASSWORD = "first-admin-pass-7"   # 18자


@pytest.fixture()
async def factory(tmp_path, monkeypatch):
    """빈 DB 하나(파일 — 세션 여럿이 같은 DB 를 본다). cli·기동 훅이 쓰는 세션 공장도 이것으로 바꾼다."""
    import app.db.session as session_mod

    monkeypatch.delenv(setup_token.INSTALLER_ENV, raising=False)
    monkeypatch.setattr(limiter, "enabled", False)
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'setup.db'}", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    f = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(session_mod, "engine", engine)
    monkeypatch.setattr(session_mod, "async_session", f)
    yield f
    await engine.dispose()


@pytest.fixture()
async def http(factory):
    from app.main import app

    async def _get_db():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_db] = _get_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db, None)


async def _issue(factory) -> str:
    async with factory() as s:
        return await setup_token.issue(s)


async def _admins(factory) -> int:
    async with factory() as s:
        return await s.scalar(select(func.count()).select_from(User).where(User.is_admin == True))  # noqa: E712


async def _stored(factory) -> str | None:
    async with factory() as s:
        return await s.scalar(select(SystemSetting.value).where(SystemSetting.key == setup_token.KEY))


def _body(token=None, **over):
    body = {"username": "root1", "password": GOOD_PASSWORD}
    if token is not None:
        body["setup_token"] = token
    body.update(over)
    return body


def _code(resp) -> str | None:
    detail = resp.json().get("detail")
    return detail.get("code") if isinstance(detail, dict) else None


# ─── 토큰 ───


async def test_without_token_is_refused(http, factory):
    await _issue(factory)
    r = await http.post("/api/setup/admin", json=_body())
    assert r.status_code == 403 and _code(r) == "setup_token_invalid"
    assert await _admins(factory) == 0


async def test_wrong_token_is_refused(http, factory):
    token = await _issue(factory)
    for bad in ("", "x", token[:-1], token + "a", token.upper() + "!"):
        r = await http.post("/api/setup/admin", json=_body(bad))
        assert r.status_code == 403 and _code(r) == "setup_token_invalid", bad
    assert await _admins(factory) == 0
    assert await _stored(factory) is not None   # 틀린 시도로 토큰이 사라지지 않는다


async def test_no_token_issued_means_closed(http, factory):
    """토큰이 한 번도 발급되지 않은 서버(기동 훅이 못 돈 경우)는 어떤 값으로도 열리지 않는다."""
    for candidate in (None, "", "0" * 64, hashlib.sha256(b"").hexdigest()):
        r = await http.post("/api/setup/admin", json=_body(candidate))
        assert r.status_code == 403 and _code(r) == "setup_token_invalid"
    assert await _admins(factory) == 0


async def test_right_token_creates_admin_and_is_consumed(http, factory):
    token = await _issue(factory)
    r = await http.post("/api/setup/admin", json=_body(f"  {token}\n", display_name="첫 관리자"))
    assert r.status_code == 201 and r.json() == {"ok": True, "username": "root1"}
    assert await _admins(factory) == 1
    assert await _stored(factory) is None
    # 같은 토큰으로 다시 — 관리자가 있으니 닫혔다
    r = await http.post("/api/setup/admin", json=_body(token, username="root2"))
    assert r.status_code == 403 and _code(r) == "admin_exists"
    assert await _admins(factory) == 1


async def test_token_is_stored_only_as_hash(factory):
    token = await _issue(factory)
    stored = await _stored(factory)
    assert stored == hashlib.sha256(token.encode()).hexdigest()
    assert token not in stored and len(token) >= 43   # 32바이트 난수


async def test_reissue_invalidates_previous_token(http, factory):
    old = await _issue(factory)
    new = await _issue(factory)
    assert old != new
    r = await http.post("/api/setup/admin", json=_body(old))
    assert r.status_code == 403
    r = await http.post("/api/setup/admin", json=_body(new))
    assert r.status_code == 201


async def test_token_works_across_sessions_like_other_workers(factory):
    """한 워커(세션)가 발급한 토큰을 다른 워커(세션)가 확인한다 — 저장소가 DB 라 프로세스 메모리에 기대지 않는다."""
    async with factory() as a:
        token = await setup_token.issue(a)
    async with factory() as b:
        assert await setup_token.matches(b, token)
        assert not await setup_token.matches(b, token + "x")
    assert not hasattr(setup_token, "_token")   # 모듈에 평문을 들고 있지 않다


async def test_same_token_cannot_be_consumed_twice(factory):
    token = await _issue(factory)
    async with factory() as a:
        assert await setup_token.consume(a, token)
        await a.commit()
    async with factory() as b:
        assert not await setup_token.consume(b, token)


async def test_validation_failure_keeps_token(http, factory):
    token = await _issue(factory)
    r = await http.post("/api/setup/admin", json=_body(token, username="A!"))
    assert r.status_code == 400
    assert await _stored(factory) is not None
    r = await http.post("/api/setup/admin", json=_body(token))
    assert r.status_code == 201


# ─── 비밀번호 하한 ───


@pytest.mark.parametrize("password,ok", [
    ("short-pw-1", False),            # 10자
    ("eleven-ch-1", False),           # 11자
    ("twelve-chr-1", True),           # 12자
    ("password123!", False),          # 12자지만 흔한 비밀번호
])
async def test_first_admin_password_minimum_is_12(http, factory, password, ok):
    token = await _issue(factory)
    r = await http.post("/api/setup/admin", json=_body(token, password=password))
    assert r.status_code == (201 if ok else 400), r.text
    assert await _admins(factory) == (1 if ok else 0)


async def test_password_rule_for_existing_accounts_is_unchanged():
    from app.auth import password_policy
    from app.setup.router import FIRST_ADMIN_PASSWORD_MIN

    assert FIRST_ADMIN_PASSWORD_MIN == 12
    assert password_policy.MIN_LENGTH == 8
    password_policy.validate("nine-ch-1")   # 9자 — 가입·변경 규칙으로는 통과


# ─── 설치 관리자 설치 ───


async def test_installer_managed_install_is_closed(http, factory, monkeypatch):
    token = await _issue(factory)   # 토큰이 어쩌다 있어도 소용없다
    monkeypatch.setenv(setup_token.INSTALLER_ENV, "k" * 48)
    r = await http.post("/api/setup/admin", json=_body(token))
    assert r.status_code == 403 and _code(r) == "setup_closed"
    assert await _admins(factory) == 0
    status = (await http.get("/api/setup/status")).json()
    assert status["setup_mode"] == "installer" and status["needs_setup"] is True
    # 관리자가 생긴 뒤에도 닫혀 있다
    assert await cli.seed_admin("root1", GOOD_PASSWORD) == "created"
    r = await http.post("/api/setup/admin", json=_body(token, username="root2"))
    assert r.status_code == 403 and _code(r) == "setup_closed"
    assert await _admins(factory) == 1


async def test_installer_managed_start_does_not_issue_token(factory, monkeypatch, capsys):
    monkeypatch.setenv(setup_token.INSTALLER_ENV, "k" * 48)
    assert await setup_token.announce_on_start() is None
    assert await _stored(factory) is None
    assert "setup token" not in capsys.readouterr().out


# ─── 기동 훅 ───


@pytest.fixture()
def lock(monkeypatch):
    """Redis 락 대신 — 처음 잡는 쪽만 True."""
    held: set[str] = set()

    async def try_acquire(name, ttl):
        if name in held:
            return False
        held.add(name)
        return True

    import app.jobs.lock as lock_mod

    monkeypatch.setattr(lock_mod, "try_acquire", try_acquire)
    return held


async def test_start_prints_token_once_among_workers(factory, lock, capsys):
    results = await asyncio.gather(*(setup_token.announce_on_start() for _ in range(4)))
    printed = [t for t in results if t]
    assert len(printed) == 1
    out = capsys.readouterr().out
    assert out.count(printed[0]) == 1 and "python -m app.cli setup-token" in out
    async with factory() as s:
        assert await setup_token.matches(s, printed[0])


async def test_restart_rotates_token(factory, lock):
    first = await setup_token.announce_on_start()
    lock.clear()
    second = await setup_token.announce_on_start()
    assert first and second and first != second
    async with factory() as s:
        assert not await setup_token.matches(s, first)
        assert await setup_token.matches(s, second)


async def test_start_with_admin_prints_nothing_and_drops_leftover(factory, lock, capsys):
    await _issue(factory)
    async with factory() as s:
        s.add(User(username="boss", password_hash="x", email="boss@example.com", is_admin=True, is_active=True))
        await s.commit()
    assert await setup_token.announce_on_start() is None
    assert await _stored(factory) is None
    assert "setup token" not in capsys.readouterr().out


async def test_start_without_lock_issues_nothing(factory, monkeypatch):
    """Redis 가 안 닿으면 락이 안 잡힌다 — 토큰 없이(닫힌 채) 뜬다."""
    import app.jobs.lock as lock_mod

    async def never(name, ttl):
        return False

    monkeypatch.setattr(lock_mod, "try_acquire", never)
    assert await setup_token.announce_on_start() is None
    assert await _stored(factory) is None


# ─── CLI ───


async def test_cli_setup_token_reissues(factory):
    old = await _issue(factory)
    new = await cli.issue_setup_token()
    async with factory() as s:
        assert await setup_token.matches(s, new) and not await setup_token.matches(s, old)


async def test_cli_setup_token_refused_when_admin_exists(factory):
    await _issue(factory)
    assert await cli.seed_admin("root1", GOOD_PASSWORD) == "created"
    assert await _stored(factory) is None    # seed-admin 이 남은 토큰을 지운다
    with pytest.raises(cli.SetupTokenRefused):
        await cli.issue_setup_token()


async def test_cli_setup_token_refused_on_installer_install(factory, monkeypatch):
    monkeypatch.setenv(setup_token.INSTALLER_ENV, "k" * 48)
    with pytest.raises(cli.SetupTokenRefused):
        await cli.issue_setup_token()
    assert await _stored(factory) is None


def test_cli_parser_has_setup_token():
    args = cli.build_parser().parse_args(["setup-token"])
    assert args.func is cli._cmd_setup_token


async def test_promote_drops_token(factory):
    await _issue(factory)
    async with factory() as s:
        s.add(User(username="kim", password_hash="x", email="kim@example.com", is_admin=False, is_active=True))
        await s.commit()
    assert await cli.seed_admin("kim", "", promote=True) == "promoted"
    assert await _stored(factory) is None


# ─── 시도 횟수 제한 ───


async def test_attempts_are_rate_limited(http, factory, monkeypatch):
    await _issue(factory)
    limiter.reset()
    monkeypatch.setattr(limiter, "enabled", True)
    try:
        codes = [(await http.post("/api/setup/admin", json=_body("wrong"))).status_code for _ in range(7)]
    finally:
        limiter.reset()
    assert codes[:5] == [403] * 5 and codes[5:] == [429, 429]


# ─── 같은 접두사의 다른 경로 ───


async def test_status_exposes_no_secret(http, factory):
    token = await _issue(factory)
    r = await http.get("/api/setup/status")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"needs_setup", "has_admin", "app_name", "setup_complete", "setup_mode"}
    assert body["setup_mode"] == "token" and body["needs_setup"] is True
    assert token not in r.text and (await _stored(factory)) not in r.text


@pytest.mark.parametrize("method,path,body", [
    ("POST", "/api/setup/complete", None),
    ("GET", "/api/setup/features", None),
    ("PATCH", "/api/setup/features", {"builtin_mailserver": True}),
    ("GET", "/api/setup/auth-order", None),
    ("PATCH", "/api/setup/auth-order", {"order": ["ldap"]}),
    ("GET", "/api/setup/storage", None),
    ("PATCH", "/api/setup/storage", {"backend": "s3"}),
    ("POST", "/api/setup/storage/test", {"backend": "filesystem"}),
    ("GET", "/api/setup/services", None),
    ("POST", "/api/setup/services/backend/restart", None),
])
async def test_other_setup_routes_need_a_session_even_with_no_admin(http, factory, method, path, body):
    """관리자가 0명이어도, 설정 토큰을 알아도 — 세션 없이는 401."""
    token = await _issue(factory)
    r = await http.request(method, path, json=body, headers={"X-Setup-Token": token})
    assert r.status_code == 401, (path, r.status_code)
    async with factory() as s:
        keys = set((await s.execute(select(SystemSetting.key))).scalars().all())
    assert keys == {setup_token.KEY}   # 아무 설정도 쓰이지 않았다


def test_every_setup_route_is_accounted_for():
    """접두사 아래에 새 경로가 생기면 이 표에 넣고 인증을 확인하게 한다."""
    from app.setup import router as setup_router

    seen = {(m, r.path) for r in setup_router.router.routes for m in r.methods if m != "HEAD"}
    open_routes = {("GET", "/api/setup/status"), ("POST", "/api/setup/admin")}
    admin_only = {
        ("POST", "/api/setup/complete"), ("GET", "/api/setup/features"), ("PATCH", "/api/setup/features"),
        ("GET", "/api/setup/auth-order"), ("PATCH", "/api/setup/auth-order"),
        ("GET", "/api/setup/storage"), ("PATCH", "/api/setup/storage"), ("POST", "/api/setup/storage/test"),
        ("GET", "/api/setup/services"), ("POST", "/api/setup/services/{service}/restart"),
    }
    assert seen == open_routes | admin_only
