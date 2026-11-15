"""회의 목록 DB 조회 실패 뒤에도 같은 세션으로 다음 쿼리를 할 수 있어야 한다(L-5 회귀).

PostgreSQL 은 실패한 쿼리 뒤 트랜잭션이 abort 되어 다음 쿼리가 InFailedSQLTransaction 으로 500 이 났다.
조회를 세이브포인트로 감싸 실패 시 그 부분만 되돌린다."""

from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base, MeetingDB, User
from app.meetings import router as mr


async def test_list_visible_failure_is_isolated(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[User.__table__, MeetingDB.__table__]))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    seen = {}

    async def broken(db, _user, _now):
        seen["nested"] = db.in_nested_transaction()
        await db.execute(text("SELECT * FROM no_such_table"))

    monkeypatch.setattr(mr.repo, "list_visible", broken)
    async with factory() as db:
        db.add(User(id="u1", username="u1", email="u1@x", password_hash="x"))
        await db.commit()
        u = await db.get(User, "u1")
        out = await mr._list_visible_safe(db, u, datetime.now(timezone.utc))
        assert out == []
        assert seen["nested"] is True            # 세이브포인트 안에서 실행됨
        assert u.username == "u1"                 # 이미 읽은 객체는 그대로 쓸 수 있다(만료 안 됨)
        assert (await db.execute(text("SELECT 1"))).scalar() == 1
    await engine.dispose()
