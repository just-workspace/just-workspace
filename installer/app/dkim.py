"""DKIM 키 — 메일 레코드 확인 화면에서 보여 줘야 하므로 **적용 전에** 만들어 상태 폴더에 둔다.

서버 구성에는 손대지 않는다. 적용할 때 렌더링이 이 키를 메일 서버 설정에 넣는다.
도메인마다 한 번만 만든다(다시 부르면 같은 키).
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
