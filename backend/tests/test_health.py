"""Tests for the /api/health endpoint."""

import pytest


@pytest.mark.asyncio
async def test_health_returns_200(client):
    response = await client.get("/api/health")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_health_response_fields(client):
    response = await client.get("/api/health")
    data = response.json()

    assert "status" in data
    assert data["status"] == "ok"

    assert "service" in data
    assert isinstance(data["service"], str)

    # 인증 없이 공개된 응답에는 서버 버전을 포함하지 않는다(로그인한 요청에만 포함)
    assert "version" not in data
    assert "demo_mode" not in data
    # 로그인 화면 렌더링에 필요한 항목은 유지
    for key in ("brand_color", "registration_mode", "zones", "config"):
        assert key in data


@pytest.mark.asyncio
async def test_health_version_only_for_signed_in(client, monkeypatch):
    import app.main as main_mod

    async def yes(request, db):
        return True

    # 쿠키가 있어도 세션이 유효하지 않으면 버전 미포함
    r = await client.get("/api/health", headers={"Cookie": "ws_session=not-a-session"})
    assert r.status_code == 200 and "version" not in r.json()

    monkeypatch.setattr(main_mod, "_signed_in", yes)
    data = (await client.get("/api/health")).json()
    assert data["version"] == main_mod.APP_VERSION


@pytest.mark.asyncio
async def test_demo_login_is_gone(client):
    r = await client.post("/api/auth/demo-login")
    assert r.status_code in (404, 405)


def test_cors_default_is_app_url_only():
    """기본 허용 출처는 공개 주소 하나(+DEBUG 일 때 개발 서버). 로컬 출처는 번들 앱 활성화 시에만 허용."""
    import app.main as main_mod
    from app.auth.ws_auth import NATIVE_APP_ORIGINS
    from app.config import Settings

    assert Settings(_env_file=None).allow_native_app_origins is False
    assert "http://localhost" not in NATIVE_APP_ORIGINS
    assert not any(o.startswith("tauri") for o in NATIVE_APP_ORIGINS)
    if not main_mod.settings.allow_native_app_origins:
        assert not set(main_mod._cors_origins) & {"http://localhost", "https://localhost", "capacitor://localhost"}
