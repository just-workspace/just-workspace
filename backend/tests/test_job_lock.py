"""백그라운드 잡 락 — 워커 8개 중 하나만 돌아야 한다(R-17)."""

import pytest

from app.jobs import lock


class _FakeRedis:
    """SET NX EX 만 흉내낸다. TTL 은 기록만 하고 만료시키지 않는다."""

    def __init__(self, fail: bool = False):
        self.store: dict[str, tuple[str, int]] = {}
        self.fail = fail

    async def set(self, key, value, nx=False, ex=None):
        if self.fail:
            raise ConnectionError("redis down")
        if nx and key in self.store:
            return None
        self.store[key] = (value, ex)
        return True

    async def delete(self, key):
        self.store.pop(key, None)


@pytest.fixture()
def fake_redis(monkeypatch):
    r = _FakeRedis()

    async def _get_redis():
        return r

    import app.chat.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", _get_redis)
    return r


@pytest.mark.asyncio
async def test_only_first_acquirer_wins(fake_redis):
    """같은 주기에 8명이 달려들면 한 명만 True."""
    results = [await lock.try_acquire("calendar:reminder", ttl=55) for _ in range(8)]
    assert results.count(True) == 1
    assert results[0] is True
    assert fake_redis.store[lock.lock_key("calendar:reminder")] == ("1", 55)


@pytest.mark.asyncio
async def test_different_jobs_do_not_block_each_other(fake_redis):
    assert await lock.try_acquire("a", ttl=10)
    assert await lock.try_acquire("b", ttl=10)


@pytest.mark.asyncio
async def test_run_exclusive_runs_once(fake_redis):
    calls = []

    async def work():
        calls.append(1)

    assert await lock.run_exclusive("files:retention", 100, work) is True
    assert await lock.run_exclusive("files:retention", 100, work) is False
    assert calls == [1]


@pytest.mark.asyncio
async def test_redis_failure_is_fail_closed(monkeypatch):
    """Redis 가 죽으면 실행하지 않는다 — 중복 발송보다 한 주기 건너뛰는 쪽."""
    r = _FakeRedis(fail=True)

    async def _get_redis():
        return r

    import app.chat.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", _get_redis)
    assert await lock.try_acquire("x", ttl=5) is False


@pytest.mark.asyncio
async def test_ttl_must_be_positive(fake_redis):
    with pytest.raises(ValueError):
        await lock.try_acquire("x", ttl=0)
