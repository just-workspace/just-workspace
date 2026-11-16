"""인증서 — 자체 서명 생성, 업로드한 파일 검증, 지문.

배치 규칙(서비스마다 조회하는 폴더 이름이 상이)은 app/render.py 의 `Plan.cert_dir`·`cert_aliases` 와
app/helper.py 의 `place-cert` 에 있다.
"""

from __future__ import annotations

import datetime as dt
import ipaddress

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

EXPIRY_WARN_DAYS = 14


def _utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def self_signed(names: list[str], *, days: int = 365, common_name: str | None = None) -> tuple[str, str]:
    """자체 서명 인증서(ECDSA P-256). names 는 도메인 이름 또는 IP 주소. 반환값: (인증서 PEM, 키 PEM)."""
    if not names:
        raise ValueError("이름이 하나는 있어야 합니다")
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, (common_name or names[0])[:64])])
    sans: list[x509.GeneralName] = []
    for name in names:
        try:
            sans.append(x509.IPAddress(ipaddress.ip_address(name)))
        except ValueError:
            sans.append(x509.DNSName(name))
    now = _utcnow()
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject).issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=days))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    key_pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode()
    return cert_pem, key_pem


def chain_pem(cert_pem: str) -> str:
    """업로드한 인증서 파일에서 **첫 번째(서버 인증서)를 제외한 나머지** — 함께 포함된 발급 CA(중간·루트). 없으면 빈 문자열."""
    try:
        chain = x509.load_pem_x509_certificates(cert_pem.encode())
    except Exception:  # noqa: BLE001
        return ""
    return "".join(c.public_bytes(serialization.Encoding.PEM).decode() for c in chain[1:])


def _load_all(pem: str) -> list[x509.Certificate]:
    try:
        return list(x509.load_pem_x509_certificates(pem.encode()))
    except Exception:  # noqa: BLE001
        return []


def _is_ca(cert: x509.Certificate) -> bool:
    try:
        return bool(cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca)
    except x509.ExtensionNotFound:
        return False


def _issued_by(cert: x509.Certificate, issuer: x509.Certificate) -> bool:
    """`issuer` 가 `cert` 를 직접 서명했는지 여부(이름·서명 모두)."""
    try:
        cert.verify_directly_issued_by(issuer)
        return True
    except Exception:  # noqa: BLE001 — 이름 불일치, 서명 불일치 또는 미지원 알고리즘
        return False


def trust_pem(cert_pem: str, ca_pem: str | None = None) -> str:
    """컨테이너가 신뢰하도록 할 CA 번들 — 업로드한 인증서 파일에 포함된 발급 CA(첫 번째 이후)와 별도 업로드한 CA 인증서를 중복 없이 병합한다.

    둘 다 없으면 빈 문자열(신뢰 대상 CA 확인 불가 — 공개 CA 발급 인증서이면 불필요).
    """
    seen: set[bytes] = set()
    out: list[str] = []
    for cert in [*_load_all(cert_pem)[1:], *_load_all(ca_pem or "")]:
        mark = cert.fingerprint(hashes.SHA256())
        if mark not in seen:
            seen.add(mark)
            out.append(cert.public_bytes(serialization.Encoding.PEM).decode())
    return "".join(out)


def inspect_ca(ca_pem: str, cert_pem: str) -> list[dict]:
    """별도 업로드한 CA 인증서 검증 — 검사 항목 목록(`inspect` 의 checks 와 동일 형식).

    읽기 가능 여부(`ca_not_pem`) · 전부 CA 인증서인지 여부(`ca_not_a_ca` — 서버 인증서를 잘못 업로드한 경우) ·
    서버 인증서(또는 동반된 체인의 끝)를 발급한 CA 의 포함 여부(`ca_not_issuer`).
    """
    def line(check_id: str, status: str, value=None, fix: str | None = None) -> dict:
        return {"id": check_id, "status": status, "value": value, "fix": {"key": fix, "vars": {}} if fix else None}

    if "PRIVATE KEY" in ca_pem:
        return [line("ca_readable", "fail", fix="ca_is_private_key")]
    cas = _load_all(ca_pem)
    if not cas:
        return [line("ca_readable", "fail", fix="ca_not_pem")]
    checks = [line("ca_readable", "pass", len(cas))]
    if not all(_is_ca(c) for c in cas):
        checks.append(line("ca_is_ca", "fail", fix="ca_not_a_ca"))
        return checks
    checks.append(line("ca_is_ca", "pass"))
    chain = _load_all(cert_pem)
    if not chain:
        return checks                                   # 서버 인증서 읽기 실패 — 해당 검사에서 보고
    # 체인 중 하나라도 업로드한 CA 가 발급한 것이면 체인이 연결된다(서버 인증서 → 중간 → 업로드한 루트)
    if any(_issued_by(c, ca) for c in chain for ca in cas):
        checks.append(line("ca_issues_cert", "pass", cas[0].subject.rfc4514_string()))
    else:
        checks.append(line("ca_issues_cert", "fail", chain[0].issuer.rfc4514_string(), fix="ca_not_issuer"))
    return checks


def fingerprint_sha256(cert_pem: str) -> str:
    """`AB:CD:…` 형식의 SHA-256 지문(첫 번째 인증서)."""
    cert = x509.load_pem_x509_certificates(cert_pem.encode())[0]
    raw = cert.fingerprint(hashes.SHA256()).hex().upper()
    return ":".join(raw[i:i + 2] for i in range(0, len(raw), 2))


def _names(cert: x509.Certificate) -> list[str]:
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return []
    return [*san.get_values_for_type(x509.DNSName), *[str(ip) for ip in san.get_values_for_type(x509.IPAddress)]]


def name_covered(name: str, patterns: list[str]) -> bool:
    """인증서 이름 목록이 해당 이름을 포함하는지 여부(와일드카드는 한 단계만)."""
    name = name.lower().rstrip(".")
    for pattern in patterns:
        p = pattern.lower().rstrip(".")
        if p == name:
            return True
        if p.startswith("*.") and "." in name and name.split(".", 1)[1] == p[2:]:
            return True
    return False


def inspect(cert_pem: str, key_pem: str, domain: str, *, mail_host: str | None = None,
            ca_pem: str | None = None, now: dt.datetime | None = None) -> dict:
    """업로드한 인증서·키(및 별도 업로드한 CA 인증서) 검증.

    반환값: {"ok", "checks": [{"id", "status": pass|warn|fail, "value", "fix"}], "names", "not_after",
    "issuer", "fingerprint", "trust": included|none|self_signed}. 검사: 읽기 가능 여부 · 도메인 포함 · 키 일치 · 만료일 ·
    발급자 · 발급 CA 유무(warn) · 메일 호스트 이름(warn) · CA 인증서(`inspect_ca`).

    `trust` — 이 서버의 다른 컨테이너(코드 저장소 등)가 이 인증서를 신뢰하도록 할 CA 의 확인 여부: `included`(파일에 체인이
    동반되었거나 CA 인증서를 별도 업로드) · `none`(서버 인증서 1건뿐 — 공개 CA 이면 문제없으며, 사설 CA 이면 CA 인증서 필요) ·
    `self_signed`.
    """
    now = now or _utcnow()
    checks: list[dict] = []

    def add(check_id: str, status: str, value=None, fix: str | None = None, **fix_vars) -> None:
        checks.append({"id": check_id, "status": status, "value": value,
                       "fix": {"key": fix, "vars": fix_vars} if fix else None})

    def result(extra: dict | None = None) -> dict:
        return {"ok": not any(c["status"] == "fail" for c in checks), "checks": checks, **(extra or {})}

    try:
        chain = x509.load_pem_x509_certificates(cert_pem.encode())
        if not chain:
            raise ValueError("empty")
    except Exception:  # noqa: BLE001
        add("cert_readable", "fail", fix="cert_not_pem")
        return result()
    add("cert_readable", "pass", len(chain))
    cert = chain[0]

    try:
        key = serialization.load_pem_private_key(key_pem.encode(), password=None)
    except TypeError:
        add("key_readable", "fail", fix="key_encrypted")
        return result()
    except Exception:  # noqa: BLE001
        add("key_readable", "fail", fix="key_not_pem")
        return result()
    add("key_readable", "pass")

    def spki(public_key) -> bytes:
        return public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)

    if spki(cert.public_key()) == spki(key.public_key()):
        add("key_matches", "pass")
    else:
        add("key_matches", "fail", fix="key_mismatch")

    names = _names(cert)
    if name_covered(domain, names):
        add("domain_covered", "pass", domain)
    else:
        add("domain_covered", "fail", names, fix="cert_domain_missing", domain=domain)

    not_after = cert.not_valid_after_utc
    not_before = cert.not_valid_before_utc
    days_left = (not_after - now).days
    if now < not_before:
        add("validity", "fail", not_before.isoformat(), fix="cert_not_yet_valid")
    elif now >= not_after:
        add("validity", "fail", not_after.isoformat(), fix="cert_expired")
    elif days_left < EXPIRY_WARN_DAYS:
        add("validity", "warn", not_after.isoformat(), fix="cert_expires_soon", days=days_left)
    else:
        add("validity", "pass", not_after.isoformat())

    issuer = cert.issuer.rfc4514_string()
    if cert.issuer == cert.subject:
        add("issuer", "warn", issuer, fix="cert_self_signed")
        trust = "self_signed"
    else:
        add("issuer", "pass", issuer)
        trust = "included" if (len(chain) > 1 or (ca_pem or "").strip()) else "none"
        if trust == "none":
            # 서버 인증서 1건뿐 — 중간 인증서가 없으면 브라우저도 경고할 수 있으며, 사설 CA 이면 코드 저장소의 로그인 연동이 보류된다
            add("chain", "warn", fix="cert_chain_missing")
        else:
            add("chain", "pass", len(chain) - 1 + len(_load_all(ca_pem or "")))

    if (ca_pem or "").strip():
        checks.extend(inspect_ca(ca_pem, cert_pem))

    if mail_host:
        if name_covered(mail_host, names):
            add("mail_host_covered", "pass", mail_host)
        else:
            add("mail_host_covered", "warn", mail_host, fix="cert_mail_host_missing", name=mail_host)

    return result({"names": names, "not_after": not_after.isoformat(), "days_left": days_left,
                   "issuer": issuer, "fingerprint": fingerprint_sha256(cert_pem), "trust": trust})


def covers(cert_pem: str, names: list[str], *, min_days: int = 30, now: dt.datetime | None = None) -> bool:
    """기존 인증서가 해당 이름을 모두 포함하고 만료까지 min_days 를 초과하여 남았는지 여부(재발급 판단용)."""
    try:
        cert = x509.load_pem_x509_certificates(cert_pem.encode())[0]
    except Exception:  # noqa: BLE001
        return False
    have = _names(cert)
    now = now or _utcnow()
    return all(name_covered(n, have) for n in names) and (cert.not_valid_after_utc - now).days > min_days


def is_self_signed(cert_pem: str) -> bool:
    try:
        cert = x509.load_pem_x509_certificates(cert_pem.encode())[0]
    except Exception:  # noqa: BLE001
        return False
    return cert.issuer == cert.subject
