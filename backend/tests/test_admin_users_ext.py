"""관리 사용자 — 목록 필터·status, 일괄 처리, 삭제 안전장치·소유 데이터 처리, 초대 링크, 운영 요약."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.backup.models  # noqa: F401 — 메타데이터에 테이블 등록
from app.admin import router as ar
from app.admin import users_ext as ux
from app.db.models import AuditLog, Base, Channel, TaskDB, User, UserInvite
from app.groups.models import Group, GroupMember

LOGIN = datetime(2026, 10, 1, tzinfo=timezone.utc)


class _Req:
    headers: dict = {}
    client = None


@pytest.fixture()
async def db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _no_mail(*a, **kw):
        return None

    monkeypatch.setattr(ar, "_send_welcome_email", _no_mail)
    async with factory() as s:
        s.add(User(id="admin", username="admin", email="admin@x", password_hash="x", is_admin=True,
                   display_name="관리자", last_login_at=LOGIN))
        s.add(User(id="kim", username="kim", email="kim@x", password_hash="x", display_name="김민지",
                   last_login_at=LOGIN))
        s.add(User(id="new", username="newbie", email="n@x", password_hash="x", is_active=False))
        s.add(User(id="gone", username="gone", email="g@x", password_hash="x", is_active=False,
                   suspended_at=LOGIN))
        s.add(Group(id="g1", name="개발팀"))
        s.add(GroupMember(group_id="g1", user_id="kim"))
        await s.commit()
        yield s
    await engine.dispose()


async def _admin(db):
    return await db.get(User, "admin")


@pytest.mark.asyncio
async def test_list_users_compat_and_filters(db):
    admin = await _admin(db)
    rows = await ar.list_users(admin=admin, db=db)
    assert isinstance(rows, list) and len(rows) == 4                 # 무인자 = 기존과 동일하게 배열
    by = {r["id"]: r for r in rows}
    assert by["admin"]["status"] == "active" and by["new"]["status"] == "pending"
    assert by["gone"]["status"] == "suspended"
    assert by["kim"]["groups"] == [{"id": "g1", "name": "개발팀"}]

    res = await ar.list_users(status="pending", admin=admin, db=db)
    assert [r["id"] for r in res] == ["new"]
    res = await ar.list_users(q="민지", admin=admin, db=db)
    assert [r["id"] for r in res] == ["kim"]
    res = await ar.list_users(group="g1", admin=admin, db=db)
    assert [r["id"] for r in res] == ["kim"]
    res = await ar.list_users(sort="username", page=1, size=2, admin=admin, db=db)
    assert res["total"] == 4 and [r["username"] for r in res["users"]] == ["admin", "gone"]
    with pytest.raises(HTTPException):
        await ar.list_users(status="weird", admin=admin, db=db)


@pytest.mark.asyncio
async def test_list_users_multi_status_and_role(db):
    """관리 사용자 칩: 승인 대기 + 정지 를 함께 선택(쉼표), 관리자만(role)."""
    admin = await _admin(db)
    res = await ar.list_users(status="pending,suspended", sort="username", admin=admin, db=db)
    assert [r["id"] for r in res] == ["gone", "new"]
    res = await ar.list_users(role="admin", admin=admin, db=db)
    assert [r["id"] for r in res] == ["admin"]
    res = await ar.list_users(role="member", status="active", page=1, size=10, admin=admin, db=db)
    assert res["total"] == 1 and res["users"][0]["id"] == "kim"
    for bad in ({"status": "pending,weird"}, {"status": ","}, {"role": "owner"}):
        with pytest.raises(HTTPException):
            await ar.list_users(admin=admin, db=db, **bad)


@pytest.mark.asyncio
async def test_non_admin_is_forbidden(db):
    with pytest.raises(HTTPException) as e:
        await ar.require_admin(user=await db.get(User, "kim"))
    assert e.value.status_code == 403


@pytest.mark.asyncio
async def test_deactivate_marks_suspended(db):
    admin = await _admin(db)
    await ar.deactivate_user_endpoint("kim", _Req(), admin=admin, db=db)
    kim = await db.get(User, "kim")
    assert kim.suspended_at is not None and ar.user_status(kim) == "suspended"


@pytest.mark.asyncio
async def test_bulk_actions(db):
    admin = await _admin(db)
    res = await ux.bulk_users(ux.BulkRequest(ids=["new", "kim", "nope"], action="approve"), _Req(), admin=admin, db=db)
    assert {r["id"]: r["ok"] for r in res["results"]} == {"new": True, "kim": False, "nope": False}
    assert (await db.get(User, "new")).is_active is True

    res = await ux.bulk_users(ux.BulkRequest(ids=["kim", "admin"], action="suspend"), _Req(), admin=admin, db=db)
    r = {x["id"]: x for x in res["results"]}
    assert r["kim"]["ok"] and not r["admin"]["ok"]               # 본인 계정은 정지 불가
    kim = await db.get(User, "kim")
    assert kim.is_active is False and kim.suspended_at is not None

    # 정지된 사용자는 거절(삭제) 대상이 아니다 — 가입 대기만 해당
    res = await ux.bulk_users(ux.BulkRequest(ids=["kim"], action="reject"), _Req(), admin=admin, db=db)
    assert res["results"][0]["ok"] is False and await db.get(User, "kim") is not None

    res = await ux.bulk_users(ux.BulkRequest(ids=["new"], action="add_group", group_id="g1"), _Req(), admin=admin, db=db)
    assert res["ok"] == 1
    assert (await db.execute(select(GroupMember).where(GroupMember.user_id == "new"))).first()
    with pytest.raises(HTTPException):
        await ux.bulk_users(ux.BulkRequest(ids=["new"], action="add_group", group_id="zz"), _Req(), admin=admin, db=db)
    # 감사 로그
    assert (await db.execute(select(AuditLog).where(AuditLog.action == "user.bulk_approve"))).first()


@pytest.mark.asyncio
async def test_bulk_suspend_cannot_remove_last_admin(db):
    db.add(User(id="admin2", username="admin2", email="a2@x", password_hash="x", is_admin=True))
    await db.commit()
    admin2 = await db.get(User, "admin2")
    # admin2 가 admin 을 정지하면 활성 관리자는 admin2 하나만 남는다 → 허용
    res = await ux.bulk_users(ux.BulkRequest(ids=["admin"], action="suspend"), _Req(), admin=admin2, db=db)
    assert res["ok"] == 1
    # admin2 가 본인을 포함하여 정지를 시도하면 본인은 제외되고 처리된다(잔여 관리자 = admin2)
    res = await ux.bulk_users(ux.BulkRequest(ids=["admin2"], action="suspend"), _Req(), admin=admin2, db=db)
    assert res["ok"] == 0


@pytest.mark.asyncio
async def test_delete_guards(db):
    admin = await _admin(db)
    with pytest.raises(HTTPException) as e:
        await ux.delete_user("admin", _Req(), confirm="admin", admin=admin, db=db)
    assert e.value.status_code == 400                                   # 본인 계정
    with pytest.raises(HTTPException) as e:
        await ux.delete_user("kim", _Req(), confirm="wrong", admin=admin, db=db)
    assert e.value.status_code == 400                                   # 확인 이름 불일치
    # 다른 관리자가 마지막 관리자를 삭제하려는 경우
    db.add(User(id="admin2", username="admin2", email="a2@x", password_hash="x", is_admin=True, is_active=False))
    await db.commit()
    impact = await ux.user_delete_impact("admin", admin=await db.get(User, "kim"), db=db)
    assert impact["blocked"]                                            # (kim 은 관리자가 아니지만 점검 함수만 호출)


@pytest.mark.asyncio
async def test_delete_transfers_shared_and_clears_assignee(db):
    admin = await _admin(db)
    db.add(Channel(id=str(uuid.uuid4()), name="general", type="public", created_by="kim"))
    db.add(TaskDB(id="t-own", user_id="kim", title="내 일"))
    db.add(TaskDB(id="t-assigned", user_id="admin", title="맡긴 일", assignee_id="kim"))
    await db.commit()

    impact = await ux.user_delete_impact("kim", admin=admin, db=db)
    assert impact["transfer_required"] == {"channels.created_by": 1}
    assert impact["nullified"] == {"tasks.assignee_id": 1}
    assert impact["deleted"]["tasks.user_id"] == 1 and impact["deleted"]["group_members.user_id"] == 1

    with pytest.raises(HTTPException) as e:
        await ux.delete_user("kim", _Req(), confirm="kim", admin=admin, db=db)
    assert e.value.status_code == 409                                   # 인수자 없이 중단

    res = await ux.delete_user("kim", _Req(), confirm="kim", transfer_to="admin", admin=admin, db=db)
    assert "kept_outside_db" in res and res["policy"]
    db.expire_all()
    assert await db.get(User, "kim") is None
    ch = (await db.execute(select(Channel))).scalars().one()
    assert ch.created_by == "admin"
    assert (await db.get(TaskDB, "t-assigned")).assignee_id is None
    assert (await db.execute(select(GroupMember).where(GroupMember.user_id == "kim"))).first() is None


@pytest.mark.asyncio
async def test_invites_create_list_revoke(db, monkeypatch):
    admin = await _admin(db)
    sent = []

    async def fake_mail(_db, to, url, inviter, expires):
        sent.append((to, url))

    monkeypatch.setattr(ux, "_send_invite_mail", fake_mail)
    res = await ux.create_invites(ux.InviteCreate(emails=["a@ext.com"], group_id="g1"), _Req(), admin=admin, db=db)
    inv = res["invites"][0]
    assert inv["emailed"] and sent[0][0] == "a@ext.com" and "/register?invite=" in inv["url"]
    token = inv["url"].split("invite=")[1]
    row = await db.get(UserInvite, inv["id"])
    assert row.token_hash != token and row.token_hash == ux.token_digest(token)   # 원문은 저장하지 않음
    assert (await ux.find_open_invite(db, token)).id == inv["id"]

    res = await ux.create_invites(ux.InviteCreate(count=2, send_email=False), _Req(), admin=admin, db=db)
    assert len(res["invites"]) == 2 and not any(i["emailed"] for i in res["invites"])

    await ux.revoke_invite(inv["id"], admin=admin, db=db)
    assert await ux.find_open_invite(db, token) is None
    lst = await ux.list_invites(admin=admin, db=db)
    assert {i["state"] for i in lst["invites"]} == {"open", "revoked"}


@pytest.mark.asyncio
async def test_ops_summary(db, monkeypatch):
    from app.backup.models import BackupRecord

    db.add(BackupRecord(id="b1", status="success", created_at=datetime.now(timezone.utc) - timedelta(days=1)))
    await db.commit()

    async def fake_ssl():
        return {"not_after": "2026-12-01T00:00:00+00:00", "days_left": 47, "source": "remote"}

    monkeypatch.setattr(ux, "ssl_expiry", fake_ssl)
    res = await ux.ops_summary(admin=await _admin(db), db=db)
    assert res["users"]["pending"] == 1 and res["users"]["suspended"] == 1 and res["users"]["active"] == 2
    assert res["backup"]["status"] == "success" and res["backup"]["last_success_at"]
    assert res["ssl"]["days_left"] == 47
    assert set(res["services"]) >= {"ok", "down", "down_names"}


@pytest.mark.asyncio
async def test_register_with_invite_skips_approval(client, monkeypatch):
    """초대 링크 가입 — 가입이 닫힌 상태에서도 가능하며 즉시 활성. 동일 링크의 재사용은 불가."""
    from app.db.models import SystemSetting
    from app.db.session import async_session

    monkeypatch.setattr(ar, "_send_welcome_email", lambda *a, **k: _none())
    token = "invite-" + uuid.uuid4().hex
    async with async_session() as s:
        if await s.get(SystemSetting, "auth.registration_mode") is None:
            s.add(SystemSetting(key="auth.registration_mode", value="closed"))
        s.add(UserInvite(token_hash=ux.token_digest(token), email="lee@ext.com",
                         expires_at=datetime.now(timezone.utc) + timedelta(days=1)))
        await s.commit()

    r = await client.get(f"/api/auth/invites/{token}")
    assert r.json() == {"valid": True, "email": "lee@ext.com", "expires_at": r.json()["expires_at"]}
    body = {"username": "leeinv", "password": "Zx9!corgi-lantern-42", "display_name": "이초대",
            "recovery_email": "lee@ext.com", "invite_token": token}
    r = await client.post("/api/auth/register", json=body)
    assert r.status_code == 201, r.text
    assert r.json()["invited"] is True
    async with async_session() as s:
        u = (await s.execute(select(User).where(User.username == "leeinv"))).scalars().one()
        assert u.is_active is True and u.email_verified is True
    r = await client.post("/api/auth/register", json={**body, "username": "leeinv2"})
    assert r.status_code == 400                                        # 이미 사용된 초대
    r = await client.get(f"/api/auth/invites/{token}")
    assert r.json() == {"valid": False}
    async with async_session() as s:   # 가입 닫힘 설정이 다른 테스트에 영향을 주지 않도록
        row = await s.get(SystemSetting, "auth.registration_mode")
        if row is not None:
            await s.delete(row)
            await s.commit()


async def _none():
    return None


@pytest.mark.asyncio
async def test_ssl_expiry_sources(monkeypatch, tmp_path):
    """SSL D-n: 설정한 인증서 파일 → 업로드된 인증서 → 내부 주소(SNI=공개 이름) → 공개 주소 순. 읽기 실패 시 None."""
    from app.admin import router as admin_router

    na = datetime.now(timezone.utc) + timedelta(days=40, hours=1)
    seen = []

    info = {"not_after": na, "not_before": na - timedelta(days=90), "name": "ws.example.com", "issuer": "Let's Encrypt"}

    def fake_file(path):
        seen.append(("file", str(path)))
        return info

    def fake_remote(host, port=443, sni=None):
        seen.append(("remote", host, port, sni))
        return info if host == "10.0.0.5" else None

    monkeypatch.setattr(ux, "_cert_info_from_file", fake_file)
    monkeypatch.setattr(ux, "_cert_info_remote", fake_remote)
    monkeypatch.setattr(admin_router, "SSL_DIR", tmp_path / "none")
    monkeypatch.setattr(ux.settings, "app_url", "https://ws.example.com")

    # 1) 인증서 파일
    cert = tmp_path / "fullchain.pem"
    cert.write_text("x")
    monkeypatch.setattr(ux.settings, "ssl_cert_path", str(cert))
    monkeypatch.setattr(ux.settings, "ssl_check_host", "")
    ux._ssl_cache.clear()
    v = await ux.ssl_expiry()
    assert v["source"] == "file" and v["days_left"] == 40

    # 2) 내부 주소로 확인 — SNI 는 공개 호스트명
    monkeypatch.setattr(ux.settings, "ssl_cert_path", "")
    monkeypatch.setattr(ux.settings, "ssl_check_host", "10.0.0.5:8443")
    ux._ssl_cache.clear(); seen.clear()
    v = await ux.ssl_expiry()
    assert v["source"] == "probe" and seen[0] == ("remote", "10.0.0.5", 8443, "ws.example.com")
    assert v["name"] == "ws.example.com" and v["issuer"] == "Let's Encrypt" and v["not_before"]

    # 3) 전부 읽기 실패(헤어핀 NAT 없음) → None, 단시간 캐시
    monkeypatch.setattr(ux.settings, "ssl_check_host", "")
    ux._ssl_cache.clear()
    v = await ux.ssl_expiry()
    assert v == {"not_after": None, "not_before": None, "days_left": None, "source": None, "name": None, "issuer": None,
                 "temporary": False}
    assert ux._ssl_cache["ttl"] == 300
    ux._ssl_cache.clear()


@pytest.mark.asyncio
async def test_ssl_expiry_prefers_installer(monkeypatch, tmp_path):
    """설치 관리자가 관리하는 설치 — 관리 › 보안의 인증서 카드와 동일한 출처(설치 관리자의 인증서 상태)를 우선 사용한다.
    backend 가 공개 주소로 접속할 수 없는 환경(헤어핀 NAT 없음)에서도 "확인 불가"가 되지 않는다."""
    import httpx

    from app.admin import router as admin_router
    from app.system import installer_client

    na = (datetime.now(timezone.utc) + timedelta(days=60, hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    state = {"managed": True, "mode": "temporary", "temporary": True, "domain": "ws.example.com",
             "names": ["ws.example.com"], "not_after": na, "days_left": 60, "issuer": "Just Workspace"}
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get(installer_client.KEY_HEADER)))
        return httpx.Response(200, json=state)

    monkeypatch.setenv(installer_client.ENV_URL, "http://jw-installer:8444")
    monkeypatch.setenv(installer_client.ENV_KEY, "k" * 48)
    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr(ux, "_cert_info_remote", lambda *a, **k: pytest.fail("공개 주소로 접속하지 않아야 한다"))
    monkeypatch.setattr(admin_router, "SSL_DIR", tmp_path / "none")
    monkeypatch.setattr(ux.settings, "app_url", "https://ws.example.com")
    monkeypatch.setattr(ux.settings, "ssl_cert_path", "")
    monkeypatch.setattr(ux.settings, "ssl_check_host", "")

    ux._ssl_cache.clear()
    v = await ux.ssl_expiry()
    assert seen == [("/internal/cert", "k" * 48)]
    assert v["source"] == "installer" and v["days_left"] == 60 and v["temporary"] is True
    assert v["name"] == "ws.example.com" and v["issuer"] == "Just Workspace"
    assert ux._ssl_cache["ttl"] == 300

    # 프런트 프록시가 TLS 를 담당하는 설치(managed = false) — 기존 순서(파일 → … → 공개 주소)로 넘어간다
    state.update(managed=False, not_after=None, temporary=False)
    calls = []
    monkeypatch.setattr(ux, "_cert_info_remote", lambda host, port=443, sni=None: calls.append(host) or None)
    ux._ssl_cache.clear()
    v = await ux.ssl_expiry()
    assert calls == ["ws.example.com"] and v["source"] is None and v["temporary"] is False

    # 설치 관리자 응답 없음 — 동일하게 다음 출처로 넘어간다
    monkeypatch.setattr(installer_client, "transport", httpx.MockTransport(lambda r: httpx.Response(503)))
    ux._ssl_cache.clear(); calls.clear()
    v = await ux.ssl_expiry()
    assert calls == ["ws.example.com"] and v["source"] is None
    ux._ssl_cache.clear()


@pytest.mark.asyncio
async def test_ssl_settings_effective_matches_ops_summary(db, monkeypatch, tmp_path):
    """보안·SSL 화면(GET /settings/ssl)과 관리 개요(ops-summary)는 동일한 인증서 정보를 조회한다.
    업로드된 인증서가 없어도 리버스 프록시(SSL_CHECK_HOST)에서 읽은 인증서가 effective 로 반환된다."""
    na = datetime.now(timezone.utc) + timedelta(days=50, hours=1)
    info = {"not_after": na, "not_before": na - timedelta(days=90), "name": "ws.example.com", "issuer": "Let's Encrypt"}
    monkeypatch.setattr(ux, "_cert_info_from_file", lambda p: None)
    monkeypatch.setattr(ux, "_cert_info_remote", lambda h, port=443, sni=None: info if h == "10.0.0.5" else None)
    monkeypatch.setattr(ar, "SSL_DIR", tmp_path / "none")
    monkeypatch.setattr(ux.settings, "app_url", "https://ws.example.com")
    monkeypatch.setattr(ux.settings, "ssl_cert_path", "")
    monkeypatch.setattr(ux.settings, "ssl_check_host", "10.0.0.5")
    ux._ssl_cache.clear()
    admin = await _admin(db)
    page = await ar.get_ssl_status(admin=admin)
    summary = await ux.ops_summary(admin=admin, db=db)
    assert page["installed"] is False
    assert page["effective"] == summary["ssl"]
    assert page["effective"]["source"] == "probe" and page["effective"]["days_left"] == 50
    # 인증서를 삭제하면(업로드도 동일) 캐시를 초기화하여 두 화면이 즉시 새 값을 조회한다
    await ar.delete_ssl(admin=admin)
    assert ux._ssl_cache == {}


def test_split_host_port():
    assert ux._split_host_port("192.168.10.50") == ("192.168.10.50", 443)
    assert ux._split_host_port("rp.lan:8443") == ("rp.lan", 8443)
    assert ux._split_host_port("[fd00::1]:9443") == ("fd00::1", 9443)


@pytest.mark.asyncio
async def test_reset_link_local_ok_ldap_blocked_and_null_source_is_local(db, monkeypatch):
    """auth_source 가 비어 있는(컬럼 추가 이전) 계정은 로컬 — 재설정 링크를 수신할 수 있어야 한다."""
    from types import SimpleNamespace

    admin = await _admin(db)
    r = await ar.admin_password_reset_link("kim", _Req(), admin=admin, db=db)
    assert "/reset-password?token=" in r["reset_url"] and r["emailed"] is False
    assert (await db.get(User, "kim")).password_reset_token

    kim = await db.get(User, "kim")
    kim.auth_source = "ldap"
    await db.commit()
    with pytest.raises(HTTPException) as e:
        await ar.admin_password_reset_link("kim", _Req(), admin=admin, db=db)
    assert e.value.status_code == 400

    # NULL 은 NOT NULL 인 테스트 DB 에 삽입할 수 없으므로 조회만 대체한다
    legacy = SimpleNamespace(id="old", username="old", auth_source=None, recovery_email=None,
                             password_reset_token=None, password_reset_sent_at=None)

    class _Db:
        async def get(self, model, pk):
            return legacy

        async def commit(self):
            return None

    async def _no_audit(*a, **kw):
        return None

    monkeypatch.setattr(ar.audit, "log_action", _no_audit)
    r = await ar.admin_password_reset_link("old", _Req(), admin=admin, db=_Db())
    assert "/reset-password?token=" in r["reset_url"] and legacy.password_reset_token


def test_auto_migrate_carries_string_server_default():
    """문자열 server_default 는 ADD COLUMN 에 포함되어야 기존 행이 채워진다."""
    from sqlalchemy import create_engine, text

    from app.db import baseline

    eng = create_engine("sqlite://")
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE users (id VARCHAR(36) PRIMARY KEY)"))
        stmts = {(t, c): sql for t, c, _ty, sql in baseline._diff_columns(conn)}
    assert stmts[("users", "auth_source")].endswith("DEFAULT 'local'")
