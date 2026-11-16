"""Tests for GET /api/platform/capabilities.

인증 없이 조회 가능하고, 버전·기능 플래그만 포함하며, 민감한 값(URL·도메인·키)은 없어야 한다.
"""

import pytest


@pytest.mark.asyncio
async def test_capabilities_public(client):
    response = await client.get("/api/platform/capabilities")
    assert response.status_code == 200
    assert "max-age" in response.headers.get("cache-control", "")


@pytest.mark.asyncio
async def test_capabilities_shape(client):
    data = (await client.get("/api/platform/capabilities")).json()

    assert data["product"] == "just-workspace"
    assert isinstance(data["version"], str) and data["version"]
    assert isinstance(data["features"], list)
    assert all(isinstance(f, str) for f in data["features"])
    # 활성화된 모듈은 module.<id> 플래그로도 제공된다 — 클라이언트는 features 하나만 확인하면 충분하다.
    for mid in data["modules"]:
        assert f"module.{mid}" in data["features"]
    # 코드가 보장하는 서버 기능은 항상 활성화되어 있다.
    assert "realtime.multi_connection" in data["features"]


@pytest.mark.asyncio
async def test_capabilities_no_sensitive_fields(client):
    data = (await client.get("/api/platform/capabilities")).json()
    # /api/health·/api/app-config 에 있는 사이트 식별 값이 여기로 노출되면 안 된다.
    for key in ("domain", "app_url", "api", "ws", "gitea_url", "livekit_url", "onlyoffice_url"):
        assert key not in data
    # 기능 플래그는 이름만 포함한다. 값(URL·키)이 혼입되면 안 된다.
    assert all("://" not in f for f in data["features"])
