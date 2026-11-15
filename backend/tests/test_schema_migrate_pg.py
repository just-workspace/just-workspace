"""스키마 버전 관리 — 실제 PostgreSQL 이 있어야 볼 수 있는 것.

환경변수 `JW_TEST_PG_URL`(관리용 접속, 예: postgresql+asyncpg://postgres:pw@host:5432/postgres)이
있을 때만 돈다. 테스트마다 임시 DB 를 만들고 지운다.
"""

import asyncio
import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.db import migrate as mg
from app.db import migrations as steps_mod
from app.db.migrations import Step

PG_URL = os.environ.get("JW_TEST_PG_URL", "")
pytestmark = pytest.mark.skipif(not PG_URL, reason="JW_TEST_PG_URL 이 없다(실제 PostgreSQL 전용)")


def quiet(_line: str) -> None:
    return None


@pytest.fixture()
async def pg_url():
    name = "jwds_" + uuid.uuid4().hex[:12]
    admin = create_async_engine(PG_URL, isolation_level="AUTOCOMMIT")
    async with admin.connect() as conn:
        await conn.execute(text(f'CREATE DATABASE "{name}"'))
    try:
        yield make_url(PG_URL).set(database=name).render_as_string(hide_password=False)
    finally:
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        await admin.dispose()


@pytest.fixture()
async def eng(pg_url):
    engine = create_async_engine(pg_url)
    yield engine
    await engine.dispose()


async def scalar(engine, sql: str, **params):
    async with engine.connect() as conn:
        return (await conn.execute(text(sql), params)).scalar()


async def columns(engine) -> set[tuple]:
    """(표, 컬럼, 타입, 기본값). NULL 허용 여부는 뺀다 — 기준선이 나중에 더한 컬럼은 기존 행을 깨지 않게
    늘 NULL 허용으로 들어간다(버전 기록 이전부터 그랬고, 코드는 NULL 을 기본값으로 읽는다)."""
    async with engine.connect() as conn:
        rows = await conn.execute(text(
            "SELECT table_name, column_name, data_type, coalesce(column_default, '') "
            "FROM information_schema.columns WHERE table_schema = 'public'"
        ))
        return {tuple(r) for r in rows}


async def indexes(engine) -> set[str]:
    async with engine.connect() as conn:
        rows = await conn.execute(text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"))
        return {r[0] for r in rows}


def use_steps(monkeypatch, *steps: Step) -> None:
    monkeypatch.setattr(steps_mod, "STEPS", tuple(steps))
    monkeypatch.setattr(mg, "SCHEMA_VERSION", steps[-1].version)


async def test_new_database_reaches_baseline_without_warnings(eng):
    result = await mg.migrate(eng, log=quiet)
    assert result.applied == [(1, mg.BASELINE_NAME)] and result.warnings == []
    assert await mg.find_drift(eng) == []
    # create_all 만으로는 안 생기는 것들: 메시지 순번 시퀀스·기본값, trigram 인덱스, @everyone 역할
    assert "nextval" in await scalar(
        eng, "SELECT column_default FROM information_schema.columns WHERE table_name='messages' AND column_name='seq'")
    assert {"ix_messages_seq", "ix_messages_content_trgm", "ix_file_index_name_trgm"} <= await indexes(eng)
    assert await scalar(eng, "SELECT count(*) FROM chat_roles WHERE is_default") == 1
    assert await scalar(eng, "SELECT app_version FROM schema_migrations WHERE version = 1")


async def test_legacy_database_is_adopted_losslessly_and_matches_new_install(eng):
    """버전 기록 이전의 설치를 흉내 낸다 — 컬럼·인덱스·시퀀스가 빠진 DB 에 행이 들어 있다."""
    await mg.migrate(eng, log=quiet)
    fresh_columns, fresh_indexes = await columns(eng), await indexes(eng)

    from datetime import datetime, timedelta, timezone

    from sqlalchemy.ext.asyncio import AsyncSession

    from app.db.models import Channel, Message, User

    now = datetime.now(timezone.utc)
    async with AsyncSession(eng) as db:
        db.add(User(id="u1", username="kim", password_hash="x", display_name="김", email="kim@example.com"))
        await db.flush()
        db.add(Channel(id="c1", name="일반", type="public", created_by="u1"))
        await db.flush()
        db.add(Message(id="m1", channel_id="c1", sender_id="u1", content="첫째", created_at=now - timedelta(hours=2)))
        db.add(Message(id="m2", channel_id="c1", sender_id="u1", content="둘째", created_at=now - timedelta(hours=1)))
        await db.commit()

    async with eng.begin() as conn:
        for sql in (
            "DROP TABLE schema_migrations",
            # 옛 스키마로 되돌린다: 순번 없음, 인증 출처 칸 없음, 채널 카테고리 없음, 이모지 칸 좁음
            "ALTER TABLE messages ALTER COLUMN seq DROP NOT NULL",
            "ALTER TABLE messages ALTER COLUMN seq DROP DEFAULT",
            "UPDATE messages SET seq = NULL",
            "UPDATE channels SET last_message_seq = NULL, category_id = NULL",
            "DROP SEQUENCE messages_seq_seq",
            "DROP INDEX ix_messages_seq",
            "DROP INDEX ix_messages_content_trgm",
            "ALTER TABLE users DROP COLUMN auth_source",
            "ALTER TABLE reactions ALTER COLUMN emoji TYPE VARCHAR(10)",
            "DROP TABLE thread_follows",
            "DELETE FROM system_settings WHERE key LIKE 'chat.%'",
            "DELETE FROM chat_categories",
        ):
            await conn.execute(text(sql))
    assert (await mg.read_state(eng)).kind == "legacy"

    result = await mg.migrate(eng, log=quiet)
    assert result.applied == [(1, mg.BASELINE_NAME)] and result.warnings == []
    # 데이터는 그대로, 빠졌던 것은 채워졌다
    assert await scalar(eng, "SELECT count(*) FROM users") == 1
    assert await scalar(eng, "SELECT auth_source FROM users WHERE id = 'u1'") == "local"
    assert [await scalar(eng, "SELECT seq FROM messages WHERE id = :i", i=i) for i in ("m1", "m2")] == [1, 2]
    assert await scalar(eng, "SELECT last_message_seq FROM channels WHERE id = 'c1'") == 2
    assert await scalar(eng, "SELECT category_id FROM channels WHERE id = 'c1'")
    # 새 설치와 같은 모양
    assert await columns(eng) == fresh_columns
    assert await indexes(eng) == fresh_indexes


async def test_eight_concurrent_runs_apply_once(pg_url):
    """워커 여덟이 동시에 뜬다 — 하나만 적용하고 나머지는 기다렸다가 할 일이 없음을 확인한다."""
    engines = [create_async_engine(pg_url) for _ in range(8)]
    try:
        results = await asyncio.gather(*(mg.ensure_schema(e, env={}, log=quiet) for e in engines))
        assert results == [1] * 8
        assert await scalar(engines[0], "SELECT count(*) FROM schema_migrations") == 1
        assert await scalar(engines[0], "SELECT count(*) FROM chat_roles WHERE is_default") == 1
        assert await scalar(engines[0], "SELECT count(*) FROM chat_categories") == 3
        assert await mg.find_drift(engines[0]) == []
    finally:
        for e in engines:
            await e.dispose()


async def test_concurrent_step_runs_exactly_once(pg_url, monkeypatch):
    runs = []

    async def two(conn):
        runs.append(1)
        await asyncio.sleep(0.3)
        await conn.execute(text("CREATE TABLE t_two (id INTEGER PRIMARY KEY)"))   # 두 번 돌면 실패한다

    engines = [create_async_engine(pg_url) for _ in range(4)]
    try:
        await mg.migrate(engines[0], log=quiet)
        use_steps(monkeypatch, Step(2, "둘", two))
        results = await asyncio.gather(*(mg.migrate(e, log=quiet) for e in engines))
        assert len(runs) == 1
        assert sorted(len(r.applied) for r in results) == [0, 0, 0, 1]
    finally:
        for e in engines:
            await e.dispose()


async def test_migrate_waits_while_another_holds_the_lock(eng, pg_url):
    holder = create_async_engine(pg_url)
    try:
        async with mg.migration_lock(holder):
            task = asyncio.create_task(mg.migrate(eng, log=quiet))
            await asyncio.sleep(1.0)
            assert not task.done()                                    # 잠금이 풀릴 때까지 기다린다
            assert (await mg.read_state(holder)).kind == "empty"      # 그동안 아무것도 만들지 않았다
        result = await asyncio.wait_for(task, timeout=120)
        assert result.to_version == 1
    finally:
        await holder.dispose()


async def test_failed_step_rolls_back_its_ddl_and_version(eng, monkeypatch):
    await mg.migrate(eng, log=quiet)

    async def two(conn):
        await conn.execute(text("CREATE TABLE t_ok (id INTEGER PRIMARY KEY)"))

    async def three(conn):
        await conn.execute(text("CREATE TABLE t_half (id INTEGER PRIMARY KEY)"))
        await conn.execute(text("ALTER TABLE users ADD COLUMN half_done TEXT"))
        await conn.execute(text("SELECT 1 FROM no_such_table"))

    use_steps(monkeypatch, Step(2, "둘", two), Step(3, "셋", three))
    with pytest.raises(mg.MigrationError) as info:
        await mg.migrate(eng, log=quiet)
    assert info.value.version == 3 and "no_such_table" in str(info.value.cause)
    assert (await mg.read_state(eng)).current == 2
    assert await scalar(eng, "SELECT to_regclass('t_ok') IS NOT NULL") is True
    assert await scalar(eng, "SELECT to_regclass('t_half') IS NULL") is True          # 반쯤 된 것은 없다
    assert await scalar(
        eng, "SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='half_done'") == 0

    async def three_fixed(conn):
        await conn.execute(text("CREATE TABLE t_half (id INTEGER PRIMARY KEY)"))

    use_steps(monkeypatch, Step(2, "둘", two), Step(3, "셋", three_fixed))            # 고친 뒤 다시
    assert (await mg.migrate(eng, log=quiet)).applied == [(3, "셋")]


async def test_non_transactional_step_and_newer_schema(eng, monkeypatch):
    await mg.migrate(eng, log=quiet)

    async def two(conn):
        await conn.execute(text("CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_t_users_email ON users(email)"))

    use_steps(monkeypatch, Step(2, "동시 인덱스", two, transactional=False))
    assert (await mg.migrate(eng, log=quiet)).applied == [(2, "동시 인덱스")]
    assert "ix_t_users_email" in await indexes(eng)

    monkeypatch.setattr(mg, "SCHEMA_VERSION", 1)                       # 이미지를 되돌린 상황
    monkeypatch.setattr(steps_mod, "STEPS", ())
    with pytest.raises(mg.SchemaTooNew):
        await mg.ensure_schema(eng, env={}, log=quiet)


async def test_repair_retries_skipped_optional_parts(eng):
    await mg.migrate(eng, log=quiet)
    async with eng.begin() as conn:
        await conn.execute(text("DROP INDEX ix_messages_content_trgm"))
        await conn.execute(text("ALTER TABLE users DROP COLUMN auth_source"))
    with pytest.raises(mg.SchemaDrift):
        await mg.ensure_schema(eng, verify=True, env={}, log=quiet)
    await mg.migrate(eng, repair=True, log=quiet)
    assert "ix_messages_content_trgm" in await indexes(eng)
    assert await mg.ensure_schema(eng, verify=True, env={}, log=quiet) == 1
