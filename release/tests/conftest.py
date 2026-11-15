"""공통 준비물. 서명 키는 실행할 때마다 새로 만든다 — 리포에는 어떤 키도 두지 않는다."""

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

RELEASE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = RELEASE_DIR.parent
sys.path.insert(0, str(RELEASE_DIR))

from jwrelease import builder  # noqa: E402
from jwrelease.config import Settings  # noqa: E402

T0 = datetime(2026, 12, 1, 9, 0, 0, tzinfo=timezone.utc)


class KeyPair:
    def __init__(self):
        self.private = ec.generate_private_key(ec.SECP256R1())
        self.public = self.private.public_key()

    @property
    def private_pem(self) -> bytes:
        return self.private.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )

    @property
    def public_pem(self) -> bytes:
        return self.public.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)

    def write(self, directory: Path, name: str = "key") -> tuple[Path, Path]:
        priv, pub = directory / f"{name}.pem", directory / f"{name}.pub"
        priv.write_bytes(self.private_pem)
        pub.write_bytes(self.public_pem)
        return priv, pub


@pytest.fixture
def key() -> KeyPair:
    return KeyPair()


@pytest.fixture
def other_key() -> KeyPair:
    return KeyPair()


@pytest.fixture(scope="session")
def compose_text() -> str:
    return (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")


@pytest.fixture(scope="session")
def zones_raw() -> bytes:
    return (REPO_ROOT / "backend" / "app" / "zones.json").read_bytes()


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings()


def fake_digest(seed: str) -> str:
    return "sha256:" + hashlib.sha256(seed.encode()).hexdigest()


# 테스트용 다이제스트 표 — 실제 조회 값이 아니다.
PINS = {
    "postgres:16.16-alpine": fake_digest("postgres"),
    "redis:8.8.4-alpine": fake_digest("redis"),
    "nginx:1.31.8-alpine": fake_digest("nginx"),
    "livekit/egress:v1.15.0": fake_digest("egress"),
}

OWN = ["backend", "frontend-react", "mailserver", "sso", "ldap", "audiorelay", "rbi-netfilter", "rbi-mirror", "docconv", "sandbox"]


def digests_doc(version: str, settings: Settings, names=None) -> dict:
    names = OWN + ["installer"] if names is None else names
    return {
        "format": 1,
        "version": version,
        "registry": settings.registry,
        "commit": "0" * 40,
        "images": {n: {"repository": settings.image_repository(n), "digest": fake_digest("img:" + n)} for n in names},
    }


def make_digests(version: str, settings: Settings, names=None) -> builder.Digests:
    return builder.Digests.from_bytes(json.dumps(digests_doc(version, settings, names)).encode())


@pytest.fixture
def make_manifest(compose_text, zones_raw, settings):
    def _make(version="1.0.0-beta.1", published=T0, **kw):
        kw.setdefault("pins", PINS)
        return builder.make_manifest(
            version=version,
            digests=make_digests(version, settings),
            compose_text=compose_text,
            zones_raw=zones_raw,
            settings=settings,
            published=published,
            **kw,
        )

    return _make
