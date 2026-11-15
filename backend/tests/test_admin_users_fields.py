"""관리 사용자 표(시안 AD2)가 쓰는 응답 필드 — last_login_at.

"최근 접속" 열과 승인 대기/정지 구분(로그인 이력 유무)에 쓴다. 라우터 함수를 직접 부른다(SQLite, users 테이블만).
"""

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.admin import router as admin_router
from app.db.models import Base, User
from app.groups.models import Group, GroupMember

# 목록이 사람마다 소속 그룹도 싣는다(groups·group_members)
TABLES = [User.__table__, Group.__table__, GroupMember.__table__]
LOGIN = datetime(2026, 10, 14, 9, 30, tzinfo=timezone.utc)


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        session.add(User(id="admin", username="admin", email="a@x", password_hash="x", is_admin=True, last_login_at=LOGIN))
        # 가입만 하고 승인 전(로그인 이력 없음)
        session.add(User(id="new", username="new", email="n@x", password_hash="x", is_active=False))
        # 쓰다가 정지된 사용자(로그인 이력 있음)
        session.add(User(id="gone", username="gone", email="g@x", password_hash="x", is_active=False, last_login_at=LOGIN))
        await session.commit()
        yield session
    await engine.dispose()


@pytest.mark.asyncio
async def test_list_users_reports_last_login_at(db):
    admin = await db.get(User, "admin")
    rows = {r["id"]: r for r in await admin_router.list_users(admin=admin, db=db)}
    assert rows["admin"]["last_login_at"].startswith("2026-10-14T09:30")
    assert rows["new"]["last_login_at"] is None
    # 기존 필드는 그대로
    assert rows["gone"]["is_active"] is False and rows["gone"]["username"] == "gone"


@pytest.mark.asyncio
async def test_pending_users_report_last_login_at(db):
    admin = await db.get(User, "admin")
    rows = {r["id"]: r for r in await admin_router.list_pending_users(admin=admin, db=db)}
    # 비활성 둘 다 나오되, 로그인 이력으로 승인 대기(new)와 정지(gone)를 가를 수 있어야 한다
    assert set(rows) == {"new", "gone"}
    assert rows["new"]["last_login_at"] is None
    assert rows["gone"]["last_login_at"] is not None
    assert "email_verified" in rows["new"]
