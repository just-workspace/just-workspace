"""설치 관리자 테스트 공통 준비 — docker 없이 로컬에서 돈다.

번들은 리포에서 바로 읽고(`Bundle()`), docker·호스트 접근은 `FakeRunner` 로 바꾼다.
"""

from __future__ import annotations

import os

import pytest

# 제품 버전은 리포 루트의 VERSION 에서 오는데, 그 값은 릴리스마다 바뀐다. 테스트의 기대값·스냅샷이 거기에 묶이지 않게
# 고정한다(설치 관리자가 실제로 받는 환경변수 — app/bundle.py). 이 변수 없이 VERSION 을 읽는 길은 그 테스트가 직접 지운다.
TEST_VERSION = "1.0.0"
os.environ["JW_INSTALLER_VERSION"] = TEST_VERSION

from app import answers as ans
from app.bundle import Bundle
from app.catalog import Catalog

SECRETS = {
    "JW_INSTALL_ID": "11111111-2222-3333-4444-555555555555",
    "JW_INSTALLER_KEY": "k" * 8 + "0123456789abcdef0123456789abcdef01234567",
    "SECRET_KEY": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
    "INTERNAL_API_KEY": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978",
    "DB_PASSWORD": "9a8b7c6d5e4f30219a8b7c6d5e4f3021",
    "LIVEKIT_API_KEY": "1a2b3c4d5e6f7089",
    "LIVEKIT_API_SECRET": "abcdef0123456789abcdef0123456789abcdef0123456789",
    "AUDIORELAY_SECRET": "fedcba9876543210fedcba9876543210fedcba9876543210",
    "DOVECOT_MASTER_PASSWORD": "0123456789abcdef0123456789abcdef",
    "ONLYOFFICE_JWT_SECRET": "00112233445566778899aabbccddeeff0011223344556677",
    "SANDBOX_TOKEN": "112233445566778899aabbccddeeff00112233445566778a",
    "DOCCONV_TOKEN": "2233445566778899aabbccddeeff00112233445566778a9b",
    "SEARXNG_SECRET": "33445566778899aabbccddeeff00112233445566778a9bbc",
    "SMTP_PASSWORD": "445566778899aabbccddeeff00112233",
}


@pytest.fixture(scope="session")
def bundle() -> Bundle:
    return Bundle()


@pytest.fixture(scope="session")
def catalog(bundle) -> Catalog:
    return Catalog(bundle.zones)


@pytest.fixture()
def secrets() -> dict:
    return dict(SECRETS)


def make_answers(**overrides) -> ans.Answers:
    """직접 연결 + 자동 인증서 + 협업 묶음 — 가장 흔한 꼴. overrides 는 최상위 항목을 바꾼다."""
    data = {
        "mode": "new",
        "access": {"domain": "ws.example.com", "network": "direct", "cert": "auto"},
        "storage": {"kind": "local"},
        "preset": "collab",
        "mail": {"kind": "builtin", "mail_domain": "example.com"},
        "admin": {"name": "관리자", "username": "admin", "password": "correct-horse-battery"},
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(data.get(key), dict):
            data[key] = {**data[key], **value}
        else:
            data[key] = value
    return ans.load(data)


@pytest.fixture()
def facts() -> ans.Facts:
    return ans.Facts(memory_mb=16000, cpus=4, public_ip="203.0.113.10", dns_status="match")
