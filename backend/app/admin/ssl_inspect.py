"""SSL 인증서 올리기 모달(관리 › 보안·SSL) — 고른 인증서·개인 키를 저장 전에 읽어 본다.

- 인증서: PEM(체인이면 첫 번째 = 서버 인증서) 또는 DER. 도메인(SAN DNS 이름, 없으면 CN)·발급자·유효 기간.
- 개인 키: PEM/DER, 암호 걸린 키는 쓸 수 없다(nginx 가 암호 없이 읽어야 함).
- 짝: 인증서의 공개 키 == 개인 키의 공개 키.
- 도메인: 이 워크스페이스 도메인(settings.domain)을 인증서가 덮는가(와일드카드는 한 단계만).

오류는 화면 칸에 붙는 짧은 코드로: cert_invalid · key_invalid · key_encrypted · key_mismatch · domain_mismatch.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import ExtensionOID, NameOID

MAX_BYTES = 1024 * 1024


class SslInspectError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail or code


@dataclass
class CertInfo:
    domains: list[str]
    subject_cn: str | None
    issuer: str
    not_before: str
    not_after: str
    cert: x509.Certificate

    def to_dict(self) -> dict:
        return {
            "domains": self.domains,
            "subject_cn": self.subject_cn,
            "issuer": self.issuer,
            "not_before": self.not_before,
            "not_after": self.not_after,
        }


def _name_attr(name: x509.Name, oid) -> str | None:
    vals = name.get_attributes_for_oid(oid)
    return str(vals[0].value) if vals else None


def _utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def parse_cert(data: bytes) -> CertInfo:
    """인증서 바이트 → CertInfo. 못 읽으면 SslInspectError('cert_invalid')."""
    if not data or len(data) > MAX_BYTES:
        raise SslInspectError("cert_invalid", "인증서 파일이 비었거나 너무 큽니다(1MB)")
    cert: x509.Certificate | None = None
    try:
        if b"-----BEGIN" in data:
            certs = x509.load_pem_x509_certificates(data)
            cert = certs[0] if certs else None
        else:
            cert = x509.load_der_x509_certificate(data)
    except (ValueError, TypeError):
        cert = None
    if cert is None:
        raise SslInspectError("cert_invalid", "인증서(PEM·DER)로 읽을 수 없습니다")
    cn = _name_attr(cert.subject, NameOID.COMMON_NAME)
    domains: list[str] = []
    try:
        san = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
        domains = [d.lower() for d in san.get_values_for_type(x509.DNSName)]
    except x509.ExtensionNotFound:
        pass
    if not domains and cn:
        domains = [cn.lower()]
    issuer = (_name_attr(cert.issuer, NameOID.ORGANIZATION_NAME)
              or _name_attr(cert.issuer, NameOID.COMMON_NAME) or "")
    return CertInfo(
        domains=list(dict.fromkeys(domains)),
        subject_cn=cn,
        issuer=issuer,
        not_before=_utc(cert.not_valid_before_utc),
        not_after=_utc(cert.not_valid_after_utc),
        cert=cert,
    )


def load_key(data: bytes):
    """개인 키 바이트 → 키 객체. 암호 걸린 키는 key_encrypted, 못 읽으면 key_invalid."""
    if not data or len(data) > MAX_BYTES:
        raise SslInspectError("key_invalid", "개인 키 파일이 비었거나 너무 큽니다(1MB)")
    try:
        if b"-----BEGIN" in data:
            return serialization.load_pem_private_key(data, password=None)
        return serialization.load_der_private_key(data, password=None)
    except TypeError:
        # 암호가 필요한 키
        raise SslInspectError("key_encrypted", "암호가 걸린 개인 키는 쓸 수 없습니다")
    except (ValueError, Exception):  # noqa: BLE001 — 형식이 틀린 키(UnsupportedAlgorithm 포함)
        raise SslInspectError("key_invalid", "개인 키로 읽을 수 없습니다")


def _spki(pub) -> bytes:
    return pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def key_matches(cert: x509.Certificate, key) -> bool:
    try:
        return _spki(cert.public_key()) == _spki(key.public_key())
    except Exception:  # noqa: BLE001
        return False


def covers(domains: list[str], host: str) -> bool:
    """인증서 도메인 목록이 host 를 덮는가 — 와일드카드(*.example.com)는 한 단계만."""
    host = (host or "").strip().lower().rstrip(".")
    if not host:
        return False
    for d in domains:
        d = d.strip().lower().rstrip(".")
        if d == host:
            return True
        if d.startswith("*.") and "." in host:
            if host.split(".", 1)[1] == d[2:]:
                return True
    return False


def inspect(cert_data: bytes | None, key_data: bytes | None, domain: str) -> dict:
    """모달용 결과 — 칸마다 오류 코드를 따로 돌려준다(예외 없음).

    {cert: {...}|null, cert_error, key_error, key_match: bool|null, domain, domain_match: bool|null, ok}
    ok = 인증서·키 둘 다 읽혔고 짝이 맞고 도메인을 덮는다 → [올리고 적용] 가능.
    """
    out: dict = {"cert": None, "cert_error": None, "key_error": None,
                 "key_match": None, "domain": domain, "domain_match": None, "ok": False}
    info: CertInfo | None = None
    key = None
    if cert_data:
        try:
            info = parse_cert(cert_data)
            out["cert"] = info.to_dict()
            out["domain_match"] = covers(info.domains, domain)
            if not out["domain_match"]:
                out["cert_error"] = "domain_mismatch"
        except SslInspectError as e:
            out["cert_error"] = e.code
    if key_data:
        try:
            key = load_key(key_data)
        except SslInspectError as e:
            out["key_error"] = e.code
    if info is not None and key is not None:
        out["key_match"] = key_matches(info.cert, key)
        if not out["key_match"]:
            out["key_error"] = "key_mismatch"
    out["ok"] = bool(info is not None and key is not None and out["key_match"] and out["domain_match"])
    return out
