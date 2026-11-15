"""C1 회귀 — 외부 메일 계정으로 내부 메일서버 마스터 인증을 쓰지 못한다.

- 사용자가 만든 계정(host=mailserver, 남의 주소)은 등록 단계에서 400
- 내부망 이름·사설/루프백 IP 는 등록·접속 모두 거부
- 마스터 로그인은 _builtin_account() 가 만든 본인 내장 메일함 객체에서만
"""

import pytest
from fastapi import HTTPException

from app.db.models import MailAccount
from app.mail import access_guard, router as mail_router, smtp_client


@pytest.fixture(autouse=True)
def _master(monkeypatch):
    from app.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "dovecot_master_user", "mastr", raising=False)
    monkeypatch.setattr(s, "dovecot_master_password", "master-secret", raising=False)
    monkeypatch.delenv("MAIL_PRIVATE_HOST_ALLOWLIST", raising=False)
    # 네트워크 없이 — 공개 이름은 공인 IP 로, 그 외는 사설로 풀린다고 가정
    def _fake_resolve(host, port):
        table = {
            "imap.example.com": ["93.184.216.34"],
            "smtp.example.com": ["93.184.216.34"],
            "mail.rebind.example": ["10.0.0.5"],
            "mixed.example": ["93.184.216.34", "172.20.0.3"],
        }
        if host in table:
            return table[host]
        import socket
        raise socket.gaierror("nx")
    monkeypatch.setattr(access_guard, "_resolve", _fake_resolve)


class _User:
    id = "u-1"
    email = "me@example.org"


def _ext(**kw):
    base = dict(
        id="acc-1", user_id="u-1", email="ceo@example.org", username="ceo@example.org",
        imap_host="mailserver", imap_port=993, imap_security="ssl",
        smtp_host="mailserver", smtp_port=587, smtp_security="starttls",
        password_encrypted="", protocol="imap",
    )
    base.update(kw)
    return MailAccount(**base)


@pytest.mark.parametrize("host", [
    "mailserver", "ws-mailserver", "MailServer.", "localhost", "postgres", "foo.internal",
    "127.0.0.1", "10.1.2.3", "172.18.0.4", "192.168.10.20", "169.254.169.254", "::1",
    "[::ffff:127.0.0.1]", "fd00::1", "0.0.0.0", "mail.rebind.example", "mixed.example",
    "nonexistent.example", "",
])
def test_internal_hosts_rejected(host):
    with pytest.raises(access_guard.MailHostRejected):
        access_guard.check_external_host(host, 993)


def test_public_host_allowed():
    access_guard.check_external_host("imap.example.com", 993)
    access_guard.check_external_host("93.184.216.34", 993)


def test_allowlist_opens_private_but_never_mailserver(monkeypatch):
    monkeypatch.setenv("MAIL_PRIVATE_HOST_ALLOWLIST", "10.0.0.0/8, exchange.corp")
    access_guard.check_external_host("10.1.2.3", 993)
    access_guard.check_external_host("mail.rebind.example", 993)
    with pytest.raises(access_guard.MailHostRejected):
        access_guard.check_external_host("172.18.0.4", 993)
    monkeypatch.setenv("MAIL_PRIVATE_HOST_ALLOWLIST", "mailserver,127.0.0.0/8")
    with pytest.raises(access_guard.MailHostRejected):
        access_guard.check_external_host("mailserver", 993)
    with pytest.raises(access_guard.MailHostRejected):
        access_guard.check_external_host("127.0.0.1", 993)


def test_db_account_never_gets_master_login():
    acc = _ext()
    assert not access_guard.is_builtin(acc)
    user, pw, builtin = access_guard.login_credentials(acc, lambda _e: "user-own-pw")
    assert user == "ceo@example.org" and pw == "user-own-pw" and builtin is False
    assert "*" not in user


def test_forged_builtin_id_is_not_builtin():
    # id 를 builtin- 으로 흉내 내도 표식이 없으면 마스터 인증 없음
    acc = _ext(id="builtin-u-1")
    assert not access_guard.is_builtin(acc)


def test_builtin_account_master_login_only_for_own_address():
    acc = mail_router._builtin_account(_User(), True)
    assert access_guard.is_builtin(acc)
    user, pw, builtin = access_guard.login_credentials(acc, lambda _e: "x")
    assert user == "me@example.org*mastr" and pw == "master-secret" and builtin
    # 표식이 붙은 객체라도 주소를 바꾸면 마스터 인증이 풀린다
    acc.username = "ceo@example.org"
    assert not access_guard.is_builtin(acc)


@pytest.mark.asyncio
async def test_create_account_with_mailserver_host_rejected(monkeypatch):
    called = {"n": 0}

    async def _no_connect(*_a, **_k):
        called["n"] += 1
        return True, "ok"

    monkeypatch.setattr(smtp_client, "test_connection", _no_connect)
    monkeypatch.setattr(mail_router.imap_client, "test_connection", _no_connect)
    body = mail_router.MailAccountCreate(
        display_name="x", email="ceo@example.org", imap_host="mailserver", smtp_host="mailserver",
        username="ceo@example.org", password="anything",
    )
    with pytest.raises(HTTPException) as e:
        await mail_router.create_account.__wrapped__(body=body, user=_User(), db=None) \
            if hasattr(mail_router.create_account, "__wrapped__") else \
            await mail_router.create_account(body=body, user=_User(), db=None)
    assert e.value.status_code == 400
    assert called["n"] == 0  # 연결 시도조차 하지 않는다


@pytest.mark.asyncio
async def test_stored_internal_account_cannot_connect():
    # 예전에 저장된 host=mailserver 레코드 — 접속 직전 검사에서 막힌다(마스터 로그인 미사용)
    ok, msg = await smtp_client.test_connection(_ext())
    assert ok is False and msg == access_guard.REJECT_MESSAGE
    ok2, _ = await mail_router.imap_client.test_connection(_ext())
    assert ok2 is False
    with pytest.raises(access_guard.MailHostRejected):
        await smtp_client.send_message(_ext(), "x", [{"email": "a@b.c", "name": ""}])
