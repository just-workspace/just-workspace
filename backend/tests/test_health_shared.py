"""헬스 점검은 한 주기에 워커 하나만 — 결과는 Redis 로 나눠 쓴다(L-8: 외부 점검 8배·값 흔들림 회귀)."""

import pytest

from app.services import health
from app.services.schemas import ServiceStatus


class MiniRedis:
    def __init__(self):
        self.d = {}

    async def set(self, k, v, nx=False, ex=None):
        if nx and k in self.d:
            return None
        self.d[k] = v
        return True

    async def get(self, k):
        return self.d.get(k)


@pytest.fixture()
def redis(monkeypatch):
    r = MiniRedis()

    async def get_redis():
        return r
    import app.chat.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", get_redis)
    monkeypatch.setattr(health, "_cache", [])
    monkeypatch.setattr(health, "_checked_at", None)
    return r


async def test_only_one_worker_checks_and_others_read_shared(redis, monkeypatch):
    calls = {"n": 0}

    async def fake_check_all():
        calls["n"] += 1
        return [ServiceStatus(name="Gitea", url="/git/", status="ok", response_ms=12, internal_only=False)]

    monkeypatch.setattr(health, "_check_all", fake_check_all)
    assert await health.health_tick() is True          # 첫 워커: 점검
    # 다른 워커 흉내: 자기 캐시는 비어 있다
    monkeypatch.setattr(health, "_cache", [])
    monkeypatch.setattr(health, "_checked_at", None)
    assert await health.health_tick() is False         # 락 있음 → 점검 안 하고 저장본
    assert calls["n"] == 1
    assert [s.name for s in health.get_cached_status()] == ["Gitea"]
    assert health.get_cached_status()[0].response_ms == 12


async def test_redis_down_still_checks(monkeypatch):
    async def broken():
        raise ConnectionError("redis down")
    import app.chat.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", broken)
    monkeypatch.setattr(health, "_cache", [])

    async def fake_check_all():
        return [ServiceStatus(name="Redis", url=None, status="down", response_ms=None, internal_only=True)]
    monkeypatch.setattr(health, "_check_all", fake_check_all)
    assert await health.health_tick() is True
    assert health.get_cached_status()[0].status == "down"
