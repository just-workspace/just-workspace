"""R5 cal-admin — 구독 미리 읽기(일정 수·이름·연도, SSRF 그대로) · SSL 인증서 미리 읽기(도메인·짝·형식) · 올리기 검사."""

import io
from datetime import datetime, timedelta, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID
from fastapi import HTTPException, UploadFile

from app.admin import ssl_inspect
from app.calendar import subscriptions as subs
from app.db.models import CalendarDB, User

ICS = """BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:대한민국 공휴일
BEGIN:VEVENT
UID:a@x
DTSTART;VALUE=DATE:20261009
DTEND;VALUE=DATE:20261010
SUMMARY:한글날
END:VEVENT
BEGIN:VEVENT
UID:b@x
DTSTART;VALUE=DATE:20270101
DTEND;VALUE=DATE:20270102
SUMMARY:신정
END:VEVENT
END:VCALENDAR
"""


def _fetch(text):
    async def f(url):
        if isinstance(text, Exception):
            raise text
        return subs.Fetched(text=text, final_url=url)
    return f


async def _seed(db):
    db.add(User(id="owner", username="owner", email="owner@x.io", password_hash="x"))
    await db.commit()


# ── 구독 미리 읽기 ──


@pytest.mark.asyncio
async def test_preview_counts_and_names_without_saving(db_session):
    await _seed(db_session)
    r = await subs.preview(db_session, "owner", "webcal://cal.example.com/kr.ics", fetch=_fetch(ICS))
    assert r == {"url": "https://cal.example.com/kr.ics", "name": "대한민국 공휴일", "count": 2,
                 "first_year": 2026, "last_year": 2027}
    # 저장하지 않는다
    assert await subs.list_subscriptions(db_session, "owner") == []


@pytest.mark.asyncio
async def test_preview_empty_calendar_and_errors(db_session):
    await _seed(db_session)
    r = await subs.preview(db_session, "owner", "https://cal.example.com/e.ics",
                           fetch=_fetch("BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n"))
    assert r["count"] == 0 and r["name"] is None and r["first_year"] is None
    with pytest.raises(subs.SubscriptionError) as e:
        await subs.preview(db_session, "owner", "https://cal.example.com/x.ics", fetch=_fetch(subs.SubscriptionError("404")))
    assert e.value.code == "404"
    db_session.add(CalendarDB(user_id="owner", name="s", source_url="https://cal.example.com/dup.ics"))
    await db_session.commit()
    with pytest.raises(subs.SubscriptionError) as e:
        await subs.preview(db_session, "owner", "https://cal.example.com/dup.ics", fetch=_fetch(ICS))
    assert e.value.code == "duplicate"


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [
    "http://127.0.0.1/x.ics",
    "http://10.0.0.5/x.ics",
    "http://192.168.1.10/x.ics",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/x.ics",
    "http://[::ffff:10.0.0.1]/x.ics",
])
async def test_preview_blocks_internal_addresses(db_session, url):
    """실제 fetch_ics 를 거친다 — 사설·루프백·링크 로컬은 접속 전에 거부."""
    await _seed(db_session)
    with pytest.raises(subs.SubscriptionError) as e:
        await subs.preview(db_session, "owner", url)
    assert e.value.code == "blocked"


@pytest.mark.asyncio
async def test_preview_rejects_scheme(db_session):
    await _seed(db_session)
    with pytest.raises(subs.SubscriptionError) as e:
        await subs.preview(db_session, "owner", "file:///etc/passwd")
    assert e.value.code == "scheme"


# ── SSL 미리 읽기 ──


def _key(kind="ec"):
    return ec.generate_private_key(ec.SECP256R1()) if kind == "ec" else rsa.generate_private_key(65537, 2048)


def _cert(key, names, cn=None, issuer_o="Example Trust CA", days=90):
    now = datetime.now(timezone.utc)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn or names[0])])
    issuer = x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, issuer_o),
                        x509.NameAttribute(NameOID.COMMON_NAME, "R1")])
    b = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer)
         .public_key(key.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=days)))
    if names:
        b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in names]), critical=False)
    return b.sign(key, hashes.SHA256())


def _pem(cert):
    return cert.public_bytes(serialization.Encoding.PEM)


def _key_pem(key, password=None):
    enc = serialization.BestAvailableEncryption(password) if password else serialization.NoEncryption()
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, enc)


def test_inspect_ok_reads_domains_issuer_dates():
    k = _key()
    c = _cert(k, ["*.example.com", "example.com"])
    chain = _pem(c) + _pem(_cert(_key(), ["ca.example"]))   # 체인이면 첫 번째가 서버 인증서
    r = ssl_inspect.inspect(chain, _key_pem(k), "example.com")
    assert r["ok"] is True
    assert r["cert"]["domains"] == ["*.example.com", "example.com"]
    assert r["cert"]["issuer"] == "Example Trust CA"
    assert r["cert"]["not_after"] > r["cert"]["not_before"]
    assert r["key_match"] is True and r["domain_match"] is True
    assert r["cert_error"] is None and r["key_error"] is None


def test_inspect_cert_only_shows_info_before_key():
    k = _key("rsa")
    r = ssl_inspect.inspect(_pem(_cert(k, ["ws.example.com"])), None, "ws.example.com")
    assert r["cert"]["domains"] == ["ws.example.com"]
    assert r["key_match"] is None and r["ok"] is False


def test_inspect_key_mismatch_and_domain_mismatch():
    k = _key()
    c = _pem(_cert(k, ["other.example.org"]))
    r = ssl_inspect.inspect(c, _key_pem(_key()), "example.com")
    assert r["key_error"] == "key_mismatch" and r["key_match"] is False
    assert r["cert_error"] == "domain_mismatch" and r["domain_match"] is False
    assert r["ok"] is False


def test_inspect_invalid_and_encrypted():
    k = _key()
    r = ssl_inspect.inspect(b"not a cert", _key_pem(k, b"pw"), "example.com")
    assert r["cert_error"] == "cert_invalid" and r["cert"] is None
    assert r["key_error"] == "key_encrypted"
    r = ssl_inspect.inspect(None, b"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n", "example.com")
    assert r["key_error"] == "key_invalid"


def test_inspect_cn_fallback_and_der():
    k = _key()
    now = datetime.now(timezone.utc)
    c = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Legacy.Example.com")]))
         .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Old CA")]))
         .public_key(k.public_key()).serial_number(1)
         .not_valid_before(now).not_valid_after(now + timedelta(days=1)).sign(k, hashes.SHA256()))
    r = ssl_inspect.inspect(c.public_bytes(serialization.Encoding.DER), _key_pem(k), "legacy.example.com")
    assert r["cert"]["domains"] == ["legacy.example.com"] and r["cert"]["issuer"] == "Old CA"
    assert r["ok"] is True


@pytest.mark.parametrize("domains,host,ok", [
    (["*.example.com"], "ws.example.com", True),
    (["*.example.com"], "example.com", False),
    (["*.example.com"], "a.b.example.com", False),
    (["Example.COM"], "example.com.", True),
    ([], "example.com", False),
])
def test_covers(domains, host, ok):
    assert ssl_inspect.covers(domains, host) is ok


# ── 올리기: 같은 검사를 통과해야 저장 ──


def _upload(data: bytes, name: str) -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=name)


@pytest.mark.asyncio
async def test_upload_rejects_mismatch_and_saves_ok(tmp_path, monkeypatch):
    from app.admin import router as admin_router
    from app.admin import users_ext

    monkeypatch.setattr(admin_router, "SSL_DIR", tmp_path)
    monkeypatch.setattr(admin_router.settings, "domain", "example.com")
    monkeypatch.setattr(users_ext, "clear_ssl_cache", lambda: None)
    admin = User(id="root", username="root", is_admin=True)
    k = _key()
    cert = _pem(_cert(k, ["example.com"]))

    with pytest.raises(HTTPException) as e:
        await admin_router.upload_ssl(cert=_upload(cert, "c.pem"), key=_upload(_key_pem(_key()), "k.pem"), admin=admin)
    assert e.value.status_code == 400 and e.value.detail["code"] == "key_mismatch"
    assert not (tmp_path / "cert.pem").exists()

    other = _key()
    with pytest.raises(HTTPException) as e:
        await admin_router.upload_ssl(cert=_upload(_pem(_cert(other, ["nope.example.org"])), "c.pem"),
                                      key=_upload(_key_pem(other), "k.pem"), admin=admin)
    assert e.value.detail["code"] == "domain_mismatch"

    await admin_router.upload_ssl(cert=_upload(cert, "c.pem"), key=_upload(_key_pem(k), "k.pem"), admin=admin)
    assert (tmp_path / "cert.pem").read_bytes() == cert

    r = await admin_router.inspect_ssl(cert=_upload(cert, "c.pem"), key=None, admin=admin)
    assert r["cert"]["domains"] == ["example.com"] and r["domain"] == "example.com"
