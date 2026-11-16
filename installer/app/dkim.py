"""DKIM 키 — 메일 레코드 확인 화면에 표시해야 하므로 **적용 전에** 생성하여 상태 폴더에 저장한다.

서버 구성은 변경하지 않는다. 적용 시 렌더링이 이 키를 메일 서버 설정에 포함한다.
도메인당 1회만 생성한다(재호출 시 동일 키).
"""

from __future__ import annotations

from app import render
from app import validators as v
from app.state import Store, write_private

SELECTOR = render.DKIM_SELECTOR


def generate_private_key() -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                             serialization.NoEncryption()).decode()


def ensure(store: Store, mail_domain: str) -> dict:
    """{"domain", "selector", "private_key", "record_name", "record_value"}."""
    domain = v.domain(mail_domain)
    path = store.dir / "dkim" / f"{domain}.pem"
    try:
        pem = path.read_text(encoding="utf-8")
    except OSError:
        pem = generate_private_key()
        write_private(path, pem)
    return {
        "domain": domain,
        "selector": SELECTOR,
        "private_key": pem,
        "record_name": f"{SELECTOR}._domainkey.{domain}",
        "record_value": render.dkim_public_value(pem),
    }
