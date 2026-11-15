"""R8 — 접속 IP 신뢰 경계(R7 계획서 A1·A2).

배치 경로: 클라이언트 → 앞단 리버스 프록시(RP, X-Real-IP 덮어씀) → ws-nginx(172.28.0.2, realip 은 RP 만 신뢰,
뒤로는 X-Real-IP·XFF 를 덮어씀) → uvicorn(`--proxy-headers --forwarded-allow-ips 172.28.0.2`) → 앱.

앱은 헤더를 직접 읽지 않고 `request.client.host` 하나만 본다. 여기서는 uvicorn 의
ProxyHeadersMiddleware 를 운영과 같은 설정으로 앱 앞에 끼워서
- ws-nginx(신뢰) 연결이 넘긴 XFF 는 반영되고(= RP 경유 실 IP),
- 그 밖의 연결(LAN 직접·도커망)이 보낸 X-Real-IP / XFF 는 무시되는지,
- 세션·접속 로그·감사 로그·로그인 잠금·slowapi 레이트리밋 키가 모두 같은 값을 쓰는지 본다.
"""

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.admin import router as admin_router
from app.auth import sessions as sess_mod
from app.db.models import Base
from app.middleware import access_log
from app.rate_limit import limiter

WS_NGINX = "172.28.0.2"     # compose 고정 IP — uvicorn --forwarded-allow-ips 와 같아야 한다
LAN_PC = "192.168.10.50"


def _req(client: str, headers: dict[str, str]) -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/api/x", "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": (client, 5555), "server": ("test", 80), "scheme": "http",
    })


# ── 헬퍼 단위 ──────────────────────────────────────────────


def test_client_ip_ignores_spoofed_headers():
    r = _req(LAN_PC, {"X-Real-IP": "1.2.3.4", "X-Forwarded-For": "6.6.6.6, 7.7.7.7"})
    assert sess_mod.client_ip(r) == LAN_PC


def test_audit_ip_ignores_xff_first_value():
    """예전엔 XFF 첫 값을 믿어 인터넷에서 감사 로그 IP 를 위조할 수 있었다(R7 A-3 R2)."""
    r = _req("203.0.113.9", {"X-Forwarded-For": "6.6.6.6, 203.0.113.9"})
    assert admin_router._client_ip(r) == "203.0.113.9"
    assert admin_router._client_ip(None) is None


def test_rate_limit_key_is_client_host():
    """slowapi 키 함수가 request.client.host 를 쓰므로 uvicorn 이 정한 실 IP 가 곧 키다."""
    from slowapi.util import get_remote_address
    assert limiter._key_func is get_remote_address
    assert get_remote_address(_req("198.51.100.7", {"X-Real-IP": "1.1.1.1"})) == "198.51.100.7"


@pytest.mark.asyncio
async def test_private_ip_hostname_is_empty(monkeypatch):
    """사설·루프백은 PTR 을 찾지 않는다 — /etc/hosts 의 host.docker.internal 이 찍히던 것."""
    called = []
    monkeypatch.setattr(sess_mod.socket, "gethostbyaddr", lambda ip: called.append(ip) or ("host.docker.internal", [], [ip]))
    for ip in ("192.168.10.50", "172.28.0.1", "10.1.2.3", "127.0.0.1", "::1", "fe80::1", "not-an-ip"):
        assert await sess_mod.resolve_hostname(ip) == ""
    assert called == []
    assert await sess_mod.resolve_hostname("8.8.8.8") == "host.docker.internal"   # 공인 IP 는 그대로 조회
    assert called == ["8.8.8.8"]


# ── uvicorn --proxy-headers 를 낀 실제 앱 ─────────────────


@pytest.fixture()
async def app_via():
    """운영과 같은 신뢰 설정으로 감싼 앱. app_via(연결 주소) → AsyncClient."""
    from app.main import app
    from app.db.session import engine as app_engine

    async with app_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    wrapped = ProxyHeadersMiddleware(app, trusted_hosts=WS_NGINX)
    clients = []

    def make(peer: str) -> AsyncClient:
        c = AsyncClient(transport=ASGITransport(app=wrapped, client=(peer, 40000)), base_url="http://test")
        clients.append(c)
        return c

    limiter.reset()
    yield make
    limiter.reset()
    for c in clients:
        await c.aclose()


async def _login(c: AsyncClient, user: str, headers: dict[str, str]):
    return await c.post("/api/auth/login", json={"username": user, "password": "wrong-pw"}, headers=headers)


@pytest.mark.asyncio
async def test_rp_path_records_real_ip_and_direct_spoof_ignored(app_via, monkeypatch):
    """세션 잠금 키·접속 로그가 RP 경유면 실 IP, LAN 직접이면 위조 헤더를 무시한 연결 주소."""
    from app.auth import security_policy

    seen = []

    async def _check(pol, username, ip):
        seen.append(ip)
        return 0

    monkeypatch.setattr(security_policy, "check_lockout", _check)
    access_log._buffer.clear()

    # RP 경유: ws-nginx 가 X-Forwarded-For 를 실 IP 하나로 덮어써 보낸다
    via_rp = app_via(WS_NGINX)
    await _login(via_rp, "alice", {"X-Forwarded-For": "203.0.113.9", "X-Real-IP": "203.0.113.9"})
    # LAN 직접(신뢰 안 됨): 헤더로 IP 를 바꾸려 해도 무시
    direct = app_via(LAN_PC)
    await _login(direct, "alice", {"X-Forwarded-For": "6.6.6.6", "X-Real-IP": "1.2.3.4"})

    assert seen == ["203.0.113.9", LAN_PC]
    logged = [e["ip_address"] for e in access_log._buffer if e["path"] == "/api/auth/login"]
    assert logged == ["203.0.113.9", LAN_PC]
    access_log._buffer.clear()


@pytest.mark.asyncio
async def test_login_rate_limit_is_per_ip(app_via, monkeypatch):
    """로그인 10/분 제한이 전원 공용 바구니(ws-nginx IP)가 아니라 IP별로 갈린다."""
    monkeypatch.setattr(limiter, "enabled", True)
    c = app_via(WS_NGINX)
    a = {"X-Forwarded-For": "203.0.113.10"}
    b = {"X-Forwarded-For": "203.0.113.11"}
    codes = [(await _login(c, "nobody", a)).status_code for _ in range(10)]
    assert 429 not in codes
    assert (await _login(c, "nobody", a)).status_code == 429     # A 는 한도 초과
    assert (await _login(c, "nobody", b)).status_code != 429     # B 는 영향 없음

    # 신뢰 안 된 연결이 XFF 를 바꿔 끼워도 한도를 피하지 못한다(연결 주소가 키)
    d = app_via(LAN_PC)
    codes = [(await _login(d, "nobody", {"X-Forwarded-For": f"9.9.9.{i}"})).status_code for i in range(11)]
    assert codes[-1] == 429
