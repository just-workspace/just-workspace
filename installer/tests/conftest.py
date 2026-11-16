"""설치 관리자 테스트 공통 준비 — docker 없이 로컬에서 돈다.

번들은 리포에서 바로 읽고(`Bundle()`), docker·호스트 접근은 `FakeRunner` 로 바꾼다.
"""

from __future__ import annotations

import functools
import json
import os
import re
from pathlib import Path

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


REPO_ROOT = Path(__file__).resolve().parents[2]


@functools.lru_cache(maxsize=None)
def repo_doc(relative: str) -> str:
    """리포의 문서를 읽는다(문서와 코드가 같은 말을 하는지 보는 검사용) — 테스트 실행 한 번에 **한 번만** 읽는다.

    테스트마다 다시 읽으면, 도는 동안 문서를 고치거나 저장하는 순간(반쯤 쓰인 파일)에 걸린 테스트만 깨진다.
    줄바꿈은 LF 로 맞춘다 — CRLF 로 받은 작업 폴더에서도 같은 결과가 나오게.
    읽지 못하면 무엇이 어디에 있어야 하는지 알리고 멈춘다.
    """
    path = REPO_ROOT / relative
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except OSError as e:
        pytest.fail(f"문서 {relative} 를 읽지 못했다({type(e).__name__}) — 이 검사는 리포 전체가 있어야 돈다"
                    f"(찾은 자리: {path}). installer/ 만 떼어 내 돌리는 경우 이 문서를 같은 상대 경로에 둔다.", pytrace=False)
    except UnicodeDecodeError:
        pytest.fail(f"문서 {relative} 가 UTF-8 이 아니다({path})", pytrace=False)
    return text.replace("\r\n", "\n")


def doc_json_examples(relative: str) -> list[dict]:
    """문서의 ```json 블록에 든 예시(객체인 것) — 블록 전체가 JSON 이 아니면 그 안에서 JSON 인 첫 줄을 쓴다."""
    out = []
    for block in re.findall(r"```json\n(.*?)```", repo_doc(relative), re.S):
        for text in (block, *block.strip().splitlines()):
            try:
                data = json.loads(text)
            except ValueError:
                continue
            if isinstance(data, dict):
                out.append(data)
                break
    if not out:
        pytest.fail(f"문서 {relative} 에서 JSON 예시(```json 블록)를 하나도 찾지 못했다 — 문서의 형식이 바뀌었는지 확인한다", pytrace=False)
    return out


@pytest.fixture(scope="session")
def update_api_examples() -> list[dict]:
    """업데이트 내부 API 계약 문서(docs/update-api.md)의 JSON 예시 — 세션에 한 번 읽는다."""
    return doc_json_examples("docs/update-api.md")


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
