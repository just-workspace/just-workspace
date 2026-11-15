"""파일 서명 — 릴리스를 내는 사람의 PC 에서만 쓴다(빌드 서버에는 비공개 키가 없다).

형식은 `cosign sign-blob --key` 가 내는 것과 같다:
파일 바이트의 SHA-256 에 대한 ECDSA(P-256) 서명을 ASN.1 DER 로 적고 base64(표준 알파벳, 패딩 있음)로 감싼
한 줄. `.sig` 파일에는 그 문자열만 들어 있다(줄바꿈 없음).

비공개 키는 표준 PEM(PKCS#8 또는 SEC1, 암호화 가능)을 받는다. cosign 이 만드는 키 파일
(`ENCRYPTED SIGSTORE PRIVATE KEY`)은 cosign 고유 포맷이라 여기서 읽지 못한다 — 그 키로는 cosign CLI 로 서명한다.
"""

from __future__ import annotations

import base64
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

SIG_SUFFIX = ".sig"


class SigningError(Exception):
    """서명할 수 없다(키 형식·암호 등)."""


def load_private_key(pem: bytes, password: bytes | None = None) -> ec.EllipticCurvePrivateKey:
    if b"SIGSTORE PRIVATE KEY" in pem:
        raise SigningError("cosign 고유 포맷 키는 읽지 못한다 — cosign sign-blob 으로 서명하거나 표준 PEM 키를 쓴다")
    try:
        key = serialization.load_pem_private_key(pem, password=password or None)
    except TypeError as e:
        raise SigningError(f"키 암호가 필요하거나 필요 없는데 주어졌다: {e}") from None
    except ValueError as e:
        raise SigningError(f"비공개 키를 읽지 못했다(형식 또는 암호): {e}") from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise SigningError("ECDSA P-256 키가 아니다")
    return key


def sign_bytes(data: bytes, key: ec.EllipticCurvePrivateKey) -> bytes:
    """서명 파일 내용(base64 한 줄, 줄바꿈 없음)."""
    der = key.sign(data, ec.ECDSA(hashes.SHA256()))
    return base64.b64encode(der)


def public_key_pem(key: ec.EllipticCurvePrivateKey) -> bytes:
    """짝이 되는 공개 키(SPKI PEM — cosign.pub 과 같은 형식)."""
    return key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)


def sig_path(path: Path) -> Path:
    return path.with_name(path.name + SIG_SUFFIX)


def sign_file(path: Path, key: ec.EllipticCurvePrivateKey) -> Path:
    """`path` 옆에 `path.sig` 를 쓴다."""
    out = sig_path(path)
    out.write_bytes(sign_bytes(path.read_bytes(), key))
    return out


def load_private_key_file(path: Path, password: str | None = None) -> ec.EllipticCurvePrivateKey:
    return load_private_key(path.read_bytes(), password.encode("utf-8") if password else None)
