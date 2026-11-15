"""스키마 버전 관리(app/db/migrate.py) — SQLite 로 볼 수 있는 것.

PostgreSQL 전용(advisory lock, 트랜잭션 DDL, 기준선의 시퀀스·인덱스)은 tests/test_schema_migrate_pg.py.
"""

import json
import re
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app import cli
from app.db import migrate as mg
from app.db import migrations as steps_mod
from app.db import schema_version as sv
from app.db.migrations import Step, add_column, create_tables, has_column


def quiet(_line: str) -> None:
    return None


@pytest.fixture()
async def eng(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'schema.db'}")
    yield engine
    await engine.dispose()


def use_steps(monkeypatch, *steps: Step) -> None:
    """테스트용 단계 목록 — 코드가 요구하는 버전도 그 끝 번호로 맞춘다."""
    monkeypatch.setattr(steps_mod, "STEPS", tuple(steps))
    monkeypatch.setattr(mg, "SCHEMA_VERSION", steps[-1].version if steps else sv.BASELINE_VERSION)


async def scalar(engine, sql: str):
    async with engine.connect() as conn:
        return (await conn.execute(text(sql))).scalar()


async def _noop(conn) -> None:
    return None


# ─── 선언의 일관성 ───


def test_steps_are_contiguous_and_end_at_schema_version():
    mg.check_steps()
    assert [v for v, _ in mg.all_steps()][-1] == sv.SCHEMA_VERSION


def test_check_steps_rejects_gap(monkeypatch):
    monkeypatch.setattr(steps_mod, "STEPS", (Step(3, "건너뜀", _noop),))
    monkeypatch.setattr(mg, "SCHEMA_VERSION", 3)
    with pytest.raises(ValueError):
        mg.check_steps()


def test_model_modules_cover_every_model_file():
    """Base 를 상속한 모델 파일은 전부 MODEL_MODULES 에 있어야 한다(빠지면 CLI 가 그 테이블을 안 만든다)."""
    app_dir = Path(mg.__file__).resolve().parents[1]
    found = set()
    for path in app_dir.rglob("*.py"):
        if re.search(r"^class \w+\(Base\):", path.read_text(encoding="utf-8"), re.M):
            found.add("app." + ".".join(path.relative_to(app_dir).with_suffix("").parts))
    assert found == set(mg.MODEL_MODULES)


def test_models_fingerprint_matches_recorded_value():
    """모델을 고쳤으면 변경 단계가 필요하다.

    실패하면: app/db/migrations.py 에 새 단계를 더하고 SCHEMA_VERSION 을 올린 뒤,
    app/db/schema_version.py 의 MODELS_FINGERPRINT 를 `python -m app.cli schema-version --fingerprint`
    값으로 바꾼다(작성법: docs/data-safety.md). 첫 릴리스 전의 변경은 기준선에 들어가므로 지문만 바꾼다.
    """
    assert mg.models_fingerprint() == sv.MODELS_FINGERPRINT


# ─── 새 DB · 기존 DB ───


async def test_empty_db_gets_baseline(eng):
    assert (await mg.read_state(eng)).kind == "empty"
    result = await mg.migrate(eng, log=quiet)
    assert result.applied == mg.all_steps() and result.applied[0] == (1, mg.BASELINE_NAME)
    assert result.to_version == sv.SCHEMA_VERSION
    state = await mg.read_state(eng)
    assert state.kind == "versioned" and state.current == sv.SCHEMA_VERSION
    assert state.applied[0]["name"] == mg.BASELINE_NAME and state.applied[0]["app_version"]
    assert await mg.find_drift(eng) == []

    again = await mg.migrate(eng, log=quiet)                 # 두 번째는 할 일이 없다
    assert again.applied == [] and again.to_version == sv.SCHEMA_VERSION
    assert await scalar(eng, "SELECT count(*) FROM schema_migrations") == sv.SCHEMA_VERSION


async def test_legacy_db_is_adopted_without_data_loss(eng):
    """버전 기록이 없는 기존 설치: 빠진 컬럼을 채우고 기준선으로 표시한다. 행은 그대로."""
    from app.db.models import Base

    mg.register_models()
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("ALTER TABLE system_settings DROP COLUMN updated_at"))
        await conn.execute(text("DROP TABLE backup_records"))
        await conn.execute(text("INSERT INTO system_settings (key, value) VALUES ('general.x', 'kept')"))
    state = await mg.read_state(eng)
    assert state.kind == "legacy" and state.current == 0
    assert set(await mg.find_drift(eng)) == {"system_settings.updated_at", "backup_records"}

    result = await mg.migrate(eng, log=quiet)
    assert result.applied[0] == (1, mg.BASELINE_NAME) and result.to_version == sv.SCHEMA_VERSION
    assert await mg.find_drift(eng) == []
    assert await scalar(eng, "SELECT value FROM system_settings WHERE key = 'general.x'") == "kept"


async def test_step_2_adds_the_homes_for_state_that_lived_in_redis(eng):
    """버전 1 의 DB(표·컬럼이 없다)에 단계 2 를 적용한다 — 기존 행은 그대로, 새 컬럼은 기본값."""
    from app.db.models import Base

    mg.register_models()
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("DROP TABLE privacy_pins"))
        await conn.execute(text("DROP TABLE mail_pop3_state"))
        await conn.execute(text("ALTER TABLE mail_accounts DROP COLUMN last_seen_uid"))
        await conn.execute(text("ALTER TABLE mail_accounts DROP COLUMN pop3_state_imported"))
        await conn.execute(text(
            "INSERT INTO mail_accounts (id, user_id, display_name, email, protocol, imap_host, imap_port, "
            "imap_security, smtp_host, smtp_port, smtp_security, username, password_encrypted, auth_method, "
            "archive_enabled, is_default, created_at, updated_at) VALUES ('a1', 'u1', 'x', 'x@example.com', "
            "'pop3', 'h', 995, 'ssl', 'h', 587, 'starttls', 'x', 'x', 'password', 0, 1, "
            "'2026-01-01', '2026-01-01')"
        ))
        await conn.run_sync(lambda sync: mg.schema_migrations.create(sync, checkfirst=True))
        await mg._record(conn, 1, mg.BASELINE_NAME)
    assert (await mg.read_state(eng)).current == 1
    assert set(await mg.find_drift(eng)) == {
        "privacy_pins", "mail_pop3_state", "mail_accounts.last_seen_uid", "mail_accounts.pop3_state_imported",
    }

    result = await mg.migrate(eng, log=quiet)
    assert [v for v, _ in result.applied] == [2]
    assert await mg.find_drift(eng) == []
    assert await scalar(eng, "SELECT email FROM mail_accounts WHERE id = 'a1'") == "x@example.com"
    assert await scalar(eng, "SELECT last_seen_uid FROM mail_accounts WHERE id = 'a1'") is None
    assert not await scalar(eng, "SELECT pop3_state_imported FROM mail_accounts WHERE id = 'a1'")
    assert await scalar(eng, "SELECT count(*) FROM privacy_pins") == 0


# ─── 단계 적용 ───


async def test_pending_steps_apply_in_order(eng, monkeypatch):
    use_steps(monkeypatch)                                   # 기준선만 있는 DB 에서 시작한다
    await mg.migrate(eng, log=quiet)
    order = []

    async def two(conn):
        order.append(2)
        await conn.execute(text("CREATE TABLE IF NOT EXISTS t_two (id INTEGER PRIMARY KEY)"))

    async def three(conn):
        order.append(3)
        await conn.execute(text("ALTER TABLE t_two ADD COLUMN note TEXT"))

    use_steps(monkeypatch, Step(2, "둘", two), Step(3, "셋", three, transactional=False))
    assert mg.pending_steps(1) == [(2, "둘"), (3, "셋")]
    result = await mg.migrate(eng, log=quiet)
    assert order == [2, 3] and result.applied == [(2, "둘"), (3, "셋")]
    assert (await mg.read_state(eng)).current == 3
    assert (await mg.migrate(eng, log=quiet)).applied == []          # 다시 돌려도 안 돈다
    assert order == [2, 3]


async def test_new_install_runs_every_step_after_baseline(eng, monkeypatch):
    seen = []

    async def two(conn):
        seen.append(await has_column(conn, "users", "username"))

    use_steps(monkeypatch, Step(2, "둘", two))
    result = await mg.migrate(eng, log=quiet)
    assert [v for v, _ in result.applied] == [1, 2] and seen == [True]


async def test_failed_step_stops_and_keeps_earlier_ones(eng, monkeypatch):
    use_steps(monkeypatch)
    await mg.migrate(eng, log=quiet)
    ran = []

    async def three(conn):
        raise RuntimeError("칸을 만들 수 없음")

    async def four(conn):
        ran.append(4)

    use_steps(monkeypatch, Step(2, "둘", _noop), Step(3, "셋", three), Step(4, "넷", four))
    with pytest.raises(mg.MigrationError) as info:
        await mg.migrate(eng, log=quiet)
    assert info.value.version == 3 and info.value.name == "셋"
    assert "칸을 만들 수 없음" in str(info.value)
    assert ran == []                                         # 뒤 단계는 돌지 않는다
    assert (await mg.read_state(eng)).current == 2           # 앞 단계까지만 기록


async def test_step_helpers_are_idempotent(eng):
    await mg.migrate(eng, log=quiet)
    async with eng.begin() as conn:
        await conn.execute(text("ALTER TABLE system_settings DROP COLUMN updated_at"))
        await conn.execute(text("DROP TABLE backup_records"))
    async with eng.begin() as conn:
        assert await add_column(conn, "system_settings", "updated_at") is True
        assert await add_column(conn, "system_settings", "updated_at") is False
        await create_tables(conn, "backup_records")
        await create_tables(conn, "backup_records")
    assert await mg.find_drift(eng) == []


# ─── 기동 ───


async def test_ensure_schema_applies_by_default(eng):
    assert await mg.ensure_schema(eng, env={}, log=quiet) == sv.SCHEMA_VERSION
    assert (await mg.read_state(eng)).current == sv.SCHEMA_VERSION
    assert mg.confirmed_version() == sv.SCHEMA_VERSION


@pytest.mark.parametrize("value", ["0", "false", "off"])
async def test_ensure_schema_refuses_when_auto_apply_is_off(eng, value):
    env = {mg.ENV_MIGRATE_ON_START: value}
    with pytest.raises(mg.SchemaOutdated) as info:
        await mg.ensure_schema(eng, env=env, log=quiet)
    assert "python -m app.cli migrate" in str(info.value)
    assert (await mg.read_state(eng)).kind == "empty"        # 아무것도 만들지 않았다

    await mg.migrate(eng, log=quiet)                         # 설치 관리자가 따로 적용하면
    assert await mg.ensure_schema(eng, env=env, log=quiet) == sv.SCHEMA_VERSION


async def test_schema_newer_than_code_is_refused(eng):
    await mg.migrate(eng, log=quiet)
    async with eng.begin() as conn:
        await mg._record(conn, 99, "미래의 단계")
    with pytest.raises(mg.SchemaTooNew) as info:
        await mg.ensure_schema(eng, env={}, log=quiet)
    assert info.value.current == 99 and "복원" in str(info.value)
    with pytest.raises(mg.SchemaTooNew):
        await mg.migrate(eng, log=quiet)


async def test_verify_catches_missing_column_and_repair_fixes_it(eng):
    await mg.migrate(eng, log=quiet)
    async with eng.begin() as conn:
        await conn.execute(text("ALTER TABLE system_settings DROP COLUMN updated_at"))
    assert await mg.ensure_schema(eng, env={}, log=quiet) == sv.SCHEMA_VERSION   # 워커 기동은 버전만 본다
    with pytest.raises(mg.SchemaDrift) as info:
        await mg.ensure_schema(eng, verify=True, env={}, log=quiet)              # 컨테이너 기동은 대조한다
    assert info.value.missing == ["system_settings.updated_at"]
    await mg.migrate(eng, repair=True, log=quiet)
    assert await mg.ensure_schema(eng, verify=True, env={}, log=quiet) == sv.SCHEMA_VERSION


async def test_init_db_does_not_swallow_failures(monkeypatch):
    """예전에는 다섯 번 재시도한 뒤 예외 없이 서버가 떴다."""
    import app.db.session as session_mod

    async def boom(engine, **kwargs):
        raise mg.MigrationError(2, "둘", "실패")

    monkeypatch.setattr(mg, "ensure_schema", boom)
    with pytest.raises(mg.MigrationError):
        await session_mod.init_db()


async def test_waits_only_for_connection_errors(eng, monkeypatch):
    calls = []

    async def flaky(engine):
        calls.append(1)
        if len(calls) < 3:
            raise ConnectionRefusedError("아직 안 뜸")
        return mg.State(current=1, has_tables=True)

    async def no_sleep(_):
        return None

    monkeypatch.setattr(mg, "read_state", flaky)
    monkeypatch.setattr(mg.asyncio, "sleep", no_sleep)
    state = await mg._read_state_waiting(eng, 30, quiet)
    assert state.current == 1 and len(calls) == 3

    async def broken(engine):
        raise ValueError("연결 문제가 아님")

    monkeypatch.setattr(mg, "read_state", broken)
    with pytest.raises(ValueError):
        await mg._read_state_waiting(eng, 30, quiet)


async def test_lock_is_noop_off_postgres(eng):
    async with mg.migration_lock(eng):
        pass


# ─── CLI ───


@pytest.fixture()
def cli_engine(tmp_path, monkeypatch):
    """CLI 는 app.db.session.engine 을 쓴다 — 테스트용 파일 DB 로 바꾼다(명령마다 새 이벤트 루프)."""
    import app.db.session as session_mod

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'cli.db'}")
    monkeypatch.setattr(session_mod, "engine", engine)
    return engine


def test_cli_schema_version_prints_only_the_number(capsys):
    assert cli.main(["schema-version"]) == 0
    assert capsys.readouterr().out.strip() == str(sv.SCHEMA_VERSION)


def test_cli_migrate_check_status_and_apply(cli_engine, capsys):
    assert cli.main(["migrate", "--check"]) == cli.MIGRATE_FAILED          # 빈 DB: 기준선이 대기 중
    out = capsys.readouterr().out
    assert "대기" in out and mg.BASELINE_NAME in out

    assert cli.main(["migrate"]) == cli.MIGRATE_OK
    assert f"0 → {sv.SCHEMA_VERSION}" in capsys.readouterr().out
    assert cli.main(["migrate", "--check"]) == cli.MIGRATE_OK
    capsys.readouterr()

    assert cli.main(["migrate", "--status", "--json"]) == cli.MIGRATE_OK
    info = json.loads(capsys.readouterr().out)
    assert info["current"] == info["required"] == sv.SCHEMA_VERSION
    assert info["pending"] == [] and info["missing"] == [] and info["state"] == "versioned"


def test_cli_migrate_reports_failed_step(cli_engine, capsys, monkeypatch):
    async def bad(conn):
        raise RuntimeError("디스크가 가득 참")

    use_steps(monkeypatch)
    assert cli.main(["migrate"]) == cli.MIGRATE_OK
    use_steps(monkeypatch, Step(2, "큰 표 고치기", bad))
    assert cli.main(["migrate"]) == cli.MIGRATE_FAILED
    err = capsys.readouterr().err
    assert "단계 2(큰 표 고치기)" in err and "디스크가 가득 참" in err


def test_cli_on_start_respects_env_and_too_new(cli_engine, capsys, monkeypatch):
    monkeypatch.setenv(mg.ENV_MIGRATE_ON_START, "0")
    assert cli.main(["migrate", "--on-start"]) == cli.MIGRATE_FAILED       # 낮은데 자동 적용이 꺼져 있다
    assert "JW_MIGRATE_ON_START" in capsys.readouterr().err
    monkeypatch.delenv(mg.ENV_MIGRATE_ON_START)
    assert cli.main(["migrate", "--on-start"]) == cli.MIGRATE_OK

    monkeypatch.setattr(mg, "SCHEMA_VERSION", 0)                           # 코드가 DB 보다 낡은 상황
    monkeypatch.setattr(mg, "check_steps", lambda: None)
    assert cli.main(["migrate", "--on-start"]) == cli.MIGRATE_TOO_NEW
    assert "복원" in capsys.readouterr().err
    assert cli.main(["migrate", "--check"]) == cli.MIGRATE_TOO_NEW
