"""/api/apps 내려받기 페이지 — NetLab 주소가 있으면 콘솔 도우미 링크, 없으면 숨김."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.config import get_settings
from app.main import app

settings = get_settings()


@pytest.mark.asyncio
async def test_netlab_helper_link_shown_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "netlab_url", "https://lab.example.com/")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/apps")
    assert r.status_code == 200
    assert 'href="https://lab.example.com/downloads/netlab-console-setup.exe"' in r.text


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["", "http://lab.example.com", "javascript:alert(1)"])
async def test_netlab_helper_link_hidden_without_https(monkeypatch, url):
    monkeypatch.setattr(settings, "netlab_url", url)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/apps")
    assert "netlab-console-setup" not in r.text


@pytest.mark.asyncio
@pytest.mark.parametrize("url,expected", [
    ("https://lab.example.com/", "https://lab.example.com"),
    ("", ""),
    ("http://lab.example.com", ""),
    ("javascript:alert(1)", ""),
])
async def test_health_exposes_netlab_url_https_only(client, monkeypatch, url, expected):
    """레일 '도구' 항목·대시보드 카드가 읽는 공개 주소 — https 만, 끝 / 제거. 비면 프런트가 둘 다 숨긴다."""
    monkeypatch.setattr(settings, "netlab_url", url)
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["netlab_url"] == expected
