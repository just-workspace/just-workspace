"""소스 코드 링크의 주소 — 설정값 판정과 /api/health 응답."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.source import DEFAULT_SOURCE_URL, LICENSE_ID, public_source_url

REPO = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("value, expected", [
    ("", DEFAULT_SOURCE_URL),
    (None, DEFAULT_SOURCE_URL),
    ("https://git.example.com/acme/workspace", "https://git.example.com/acme/workspace"),
    ("  http://git.example.com/x  ", "http://git.example.com/x"),
    ("javascript:alert(1)", DEFAULT_SOURCE_URL),
    ("ftp://git.example.com/x", DEFAULT_SOURCE_URL),
    ("https://git.example.com/a b", DEFAULT_SOURCE_URL),
    ('https://git.example.com/"><script>', DEFAULT_SOURCE_URL),
    ("https://" + "a" * 2100, DEFAULT_SOURCE_URL),
])
def test_public_source_url(value, expected):
    assert public_source_url(value) == expected


def test_license_id():
    assert LICENSE_ID == "AGPL-3.0-or-later"


@pytest.mark.skipif(not (REPO / "release" / "jwrelease" / "config.py").is_file(), reason="리포 루트(release/)가 없다")
def test_default_matches_the_release_tool():
    """backend 는 릴리스 도구를 참조하지 않는다 — 동일 주소를 두 곳에 기재하므로 불일치가 발생하지 않도록 검증한다."""
    text = (REPO / "release" / "jwrelease" / "config.py").read_text(encoding="utf-8")
    assert f'source_repo_url: str = "{DEFAULT_SOURCE_URL}"' in text


async def test_health_carries_source_url_without_login(client, monkeypatch):
    from app.config import get_settings

    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["source_url"] == DEFAULT_SOURCE_URL and r.json()["license"] == LICENSE_ID
    monkeypatch.setattr(get_settings(), "jw_source_url", "https://git.example.com/acme/workspace")
    assert (await client.get("/api/health")).json()["source_url"] == "https://git.example.com/acme/workspace"


@pytest.mark.parametrize("env_value", [None, "", "   "])
def test_missing_and_empty_env_both_mean_the_default(monkeypatch, env_value):
    """`.env` 에 해당 줄이 없는 경우와 `JW_SOURCE_URL=`(빈 값)인 경우 모두 원본 리포의 주소가 반환된다.

    설치 관리자는 값이 없으면 해당 줄을 기록하지 않으나, 이전 버전이 기록한 빈 줄이 남아 있는 설치도 존재한다.
    """
    from app.config import Settings

    if env_value is None:
        monkeypatch.delenv("JW_SOURCE_URL", raising=False)
    else:
        monkeypatch.setenv("JW_SOURCE_URL", env_value)
    assert public_source_url(Settings(_env_file=None).jw_source_url) == DEFAULT_SOURCE_URL
    monkeypatch.setenv("JW_SOURCE_URL", "https://git.example.com/acme/workspace")
    assert public_source_url(Settings(_env_file=None).jw_source_url) == "https://git.example.com/acme/workspace"
