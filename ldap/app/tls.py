"""LDAPS 인증서 준비.

주의: **ldaptor 는 StartTLS 를 지원하지 않는다.** LDAPServer 에 StartTLS 확장 핸들러
(OID 1.3.6.1.4.1.1466.20037)가 없다. 따라서 암호화 경로는 **LDAPS(636, 암묵적
TLS)** 가 유일하다. 장비에서 "389 + StartTLS" 로 설정하면 평문으로 접속된다 —
반드시 "636 + SSL/LDAPS" 를 선택해야 한다.

인증서 우선순위:
  1. LDAP_TLS_CERT/LDAP_TLS_KEY 로 지정된 파일이 있으면 해당 파일을 사용한다
     (예: Let's Encrypt 인증서를 마운트해 공인 이름으로 접속시키는 경우)
  2. 없으면 자체 서명 인증서를 생성해 **볼륨에 저장**한다

2번에서는 저장이 필수다. 기동마다 재생성하면 인증서를 신뢰 목록에 등록한
장비(NAS·하이퍼바이저 등)가 재기동마다 접속에 실패한다.
"""

from __future__ import annotations

import datetime
import ipaddress
import logging
import os
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from app.config import settings

logger = logging.getLogger(__name__)

VALID_DAYS = 3650  # 자체 서명은 장기 유효로 설정 — 갱신 절차 없음


def _san_entries(sans: list[str]) -> list:
    out = []
    for s in sans:
        s = s.strip()
        if not s:
            continue
        try:
            out.append(x509.IPAddress(ipaddress.ip_address(s)))
        except ValueError:
            out.append(x509.DNSName(s))
    return out


def _generate(cert_path: Path, key_path: Path, sans: list[str]) -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cn = next((s for s in sans if not s[0].isdigit()), "ldap.local")
    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "just-workspace"),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)                       # 자체 서명
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=VALID_DAYS))
        .add_extension(x509.SubjectAlternativeName(_san_entries(sans)), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    os.chmod(key_path, 0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    logger.info("자체 서명 인증서 생성: CN=%s SAN=%s (%d일)", cn, sans, VALID_DAYS)


def ensure_cert() -> tuple[str, str] | None:
    """(certfile, keyfile) 을 반환한다. LDAPS 활성화가 불가하면 None."""
    # 1) 외부 지정 인증서
    if settings.ldap_tls_cert and settings.ldap_tls_key:
        c, k = Path(settings.ldap_tls_cert), Path(settings.ldap_tls_key)
        if c.is_file() and k.is_file():
            logger.info("지정된 인증서 사용: %s", c)
            return str(c), str(k)
        logger.warning(
            "LDAP_TLS_CERT/KEY 가 지정됐지만 파일이 없다(%s, %s) — 자체 서명으로 대체", c, k
        )

    # 2) 자체 서명(볼륨에 보존)
    d = Path(settings.ldap_tls_dir)
    cert_path, key_path = d / "ldaps-cert.pem", d / "ldaps-key.pem"
    if not (cert_path.is_file() and key_path.is_file()):
        sans = [s.strip() for s in settings.ldap_tls_sans.split(",") if s.strip()]
        if not sans:
            logger.error("LDAP_TLS_SANS 가 비어 있어 인증서를 만들 수 없다")
            return None
        try:
            _generate(cert_path, key_path, sans)
        except Exception:
            logger.exception("인증서 생성 실패 — LDAPS 를 켜지 않는다")
            return None
    else:
        logger.info("기존 자체 서명 인증서 사용: %s", cert_path)
    return str(cert_path), str(key_path)
