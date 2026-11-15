"""init_db 는 전체가 한 락 안에서 돈다(L-7: 워커 8개 동시 마이그레이션 경합 회귀)."""

from app.db import session as dbs


async def test_init_db_runs_inside_lock(monkeypatch):
    events = []

    class Lock:
        async def __aenter__(self):
            events.append("lock")

        async def __aexit__(self, *a):
            events.append("unlock")

    async def body():
        events.append("migrate")

    monkeypatch.setattr(dbs, "_init_db_lock", lambda: Lock())
    monkeypatch.setattr(dbs, "_init_db_unlocked", body)
    await dbs.init_db()
    assert events == ["lock", "migrate", "unlock"]


async def test_lock_is_noop_off_postgres():
    # 테스트 DB 는 SQLite — 락 없이 그대로 지나간다
    async with dbs._init_db_lock():
        pass
