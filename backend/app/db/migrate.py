"""스키마 버전 관리 — 버전 기록(`schema_migrations`)과 순서 있는 변경 단계.

- 기준선(1): app/db/baseline.py — 버전 기록이 생기기 전의 보정 전부.
- 단계(2~): app/db/migrations.py 의 `STEPS`.
- 코드가 요구하는 버전: app/db/schema_version.py 의 `SCHEMA_VERSION`.

누가 돌리는가:
- `python -m app.cli migrate` (설치 관리자·운영자) — `migrate()`
- 컨테이너 기동(entrypoint 가 워커를 띄우기 전에 한 번) · 워커 기동(lifespan) — `ensure_schema()`

한 번에 하나만 돈다(PostgreSQL 세션 advisory lock). 기다리던 쪽은 잠금을 얻은 뒤 상태를 다시 읽어
할 일이 없으면 그대로 끝낸다. 단계가 실패하면 `MigrationError` — 삼키지 않는다.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from sqlalchemy import Column, DateTime, Integer, MetaData, String, Table, Text, inspect, select, text
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.schema_version import BASELINE_VERSION, SCHEMA_VERSION

ENV_MIGRATE_ON_START = "JW_MIGRATE_ON_START"
BASELINE_NAME = "기준선"

# 세션 advisory lock 키 — 스키마를 만지는 것은 이 잠금을 쥔 하나뿐이다.
MIGRATION_LOCK_KEY = 0x6A77_1D80

# Base.metadata 와 따로 둔다 — create_all 이 이 표를 만들면 "기록 없음"과 "빈 기록"이 섞인다.
_meta = MetaData()
schema_migrations = Table(
    "schema_migrations",
    _meta,
    Column("version", Integer, primary_key=True, autoincrement=False),
    Column("name", String(200), nullable=False),
    Column("applied_at", DateTime(timezone=True), nullable=False),
    Column("app_version", String(64), nullable=False, default=""),
    Column("notes", Text, nullable=True),
)

# 이 프로세스가 마지막으로 확인한 DB 스키마 버전(/api/health 가 보여 준다). 확인 전에는 None.
_confirmed_version: int | None = None


class MigrationError(Exception):
    """변경 단계가 실패했다. version/name 은 실패한 단계."""

    def __init__(self, version: int, name: str, cause: BaseException | str):
        self.version = version
        self.name = name
        self.cause = cause
        detail = str(cause).strip().splitlines()
        super().__init__(f"스키마 변경 단계 {version}({name}) 실패: {detail[0] if detail else type(cause).__name__}")


class SchemaTooNew(Exception):
    """DB 스키마가 코드가 아는 것보다 높다 — 이미지를 되돌렸는데 DB 는 새것."""

    def __init__(self, current: int, required: int):
        self.current = current
        self.required = required
        super().__init__(
            f"DB 스키마 버전({current})이 이 버전의 코드가 요구하는 버전({required})보다 높습니다. "
            "제품을 이전 버전으로 되돌렸다면 DB 도 그 버전에서 만든 백업으로 복원해야 합니다 "
            "(python -m app.cli restore <백업> — docs/data-safety.md). "
            "되돌린 것이 아니라면 더 새 버전의 이미지로 기동하세요."
        )


class SchemaOutdated(Exception):
    """DB 스키마가 낮은데 자동 적용이 꺼져 있다."""

    def __init__(self, current: int, required: int, pending: list[str]):
        self.current = current
        self.required = required
        self.pending = pending
        super().__init__(
            f"DB 스키마 버전({current})이 코드가 요구하는 버전({required})보다 낮고 "
            f"{ENV_MIGRATE_ON_START}=0 이라 자동으로 적용하지 않습니다. "
            "먼저 python -m app.cli migrate 를 실행하세요. 대기 단계: " + ", ".join(pending)
        )


class SchemaDrift(Exception):
    """버전은 맞는데 모델에 있는 테이블·컬럼이 DB 에 없다."""

    def __init__(self, missing: list[str]):
        self.missing = missing
        shown = ", ".join(missing[:12]) + (f" 외 {len(missing) - 12}개" if len(missing) > 12 else "")
        super().__init__(
            "DB 에 없는 테이블·컬럼이 있습니다: " + shown
            + " — python -m app.cli migrate --repair 로 채울 수 있습니다(데이터는 지우지 않습니다)."
        )


@dataclass
class State:
    current: int                      # 기록된 최고 버전. 기록이 없으면 0
    has_tables: bool                  # 제품 테이블(users)이 있는가 — 기록 없이 True 면 버전 기록 이전의 설치
    applied: list[dict] = field(default_factory=list)

    @property
    def kind(self) -> str:
        if self.current:
            return "versioned"
        return "legacy" if self.has_tables else "empty"


@dataclass
class Result:
    from_version: int
    to_version: int
    applied: list[tuple[int, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# ─── 모델 등록 ───

# Base 를 상속한 모델이 있는 모듈 전부. 구역과 무관하게 스키마는 같다 — 라우터를 올리지 않는 구역의
# 테이블도 만든다. 새 모델 파일을 만들면 여기에 더한다(tests/test_schema_migrate.py 가 빠진 것을 잡는다).
MODEL_MODULES = (
    "app.db.models",
    "app.groups.models",
    "app.ai.models",
    "app.ai.artifact_models",
    "app.backup.models",
    "app.dashboard.models",
    "app.rbi.models",
)


def register_models() -> None:
    """모든 모델을 Base.metadata 에 올린다(app.main 을 거치지 않는 CLI 에서도 같은 스키마가 되게)."""
    import importlib

    for name in MODEL_MODULES:
        importlib.import_module(name)


def models_fingerprint() -> str:
    """모델(테이블·컬럼·타입·NULL 허용)의 지문 — 모델이 바뀌면 값이 바뀐다."""
    from app.db.models import Base

    register_models()
    lines = []
    for table in sorted(Base.metadata.tables.values(), key=lambda t: t.name):
        for col in sorted(table.columns, key=lambda c: c.name):
            lines.append(f"{table.name}.{col.name}:{col.type!r}:{int(bool(col.nullable))}:{int(bool(col.primary_key))}")
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()[:16]


# ─── 상태 읽기 ───


def _read_state_sync(sync_conn) -> State:
    insp = inspect(sync_conn)
    tables = set(insp.get_table_names())
    state = State(current=0, has_tables="users" in tables)
    if schema_migrations.name in tables:
        rows = sync_conn.execute(select(schema_migrations).order_by(schema_migrations.c.version)).mappings().all()
        state.applied = [dict(r) for r in rows]
        if rows:
            state.current = max(r["version"] for r in rows)
    return state


async def read_state(engine: AsyncEngine) -> State:
    async with engine.connect() as conn:
        return await conn.run_sync(_read_state_sync)


def _missing_sync(sync_conn) -> list[str]:
    from app.db.models import Base

    insp = inspect(sync_conn)
    tables = set(insp.get_table_names())
    missing: list[str] = []
    for table in Base.metadata.sorted_tables:
        if table.name not in tables:
            missing.append(table.name)
            continue
        have = {c["name"] for c in insp.get_columns(table.name)}
        missing += [f"{table.name}.{c.name}" for c in table.columns if c.name not in have]
    return missing


async def find_drift(engine: AsyncEngine) -> list[str]:
    """모델에는 있고 DB 에는 없는 테이블·컬럼("표" 또는 "표.컬럼")."""
    register_models()
    async with engine.connect() as conn:
        return await conn.run_sync(_missing_sync)


def all_steps() -> list[tuple[int, str]]:
    """(버전, 이름) — 기준선 포함, 번호 순."""
    from app.db.migrations import STEPS

    return [(BASELINE_VERSION, BASELINE_NAME)] + [(s.version, s.name) for s in STEPS]


def check_steps() -> None:
    """단계 번호가 2 부터 1씩 늘고 마지막이 SCHEMA_VERSION 인지. 아니면 ValueError."""
    versions = [v for v, _ in all_steps()]
    if versions != list(range(BASELINE_VERSION, SCHEMA_VERSION + 1)):
        raise ValueError(
            f"변경 단계 번호가 맞지 않습니다: 단계={versions}, SCHEMA_VERSION={SCHEMA_VERSION} "
            "(app/db/migrations.py 와 app/db/schema_version.py 를 함께 고치세요)"
        )


def pending_steps(current: int) -> list[tuple[int, str]]:
    return [(v, n) for v, n in all_steps() if v > current]


# ─── 잠금 ───


@asynccontextmanager
async def migration_lock(engine: AsyncEngine):
    """PostgreSQL 이면 세션 advisory lock 을 잡는다(다른 DB 는 아무것도 안 함).

    잠금 연결은 끝까지 열어 두고, 끝나면 풀고 닫는다. 풀기에 실패하면 그 연결은 버린다
    (풀에 돌아가면 잠금을 쥔 채 남는다). 이미 누가 쥐고 있으면 풀릴 때까지 기다린다.
    """
    if engine.dialect.name != "postgresql":
        yield
        return
    async with engine.connect() as conn:
        await conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": MIGRATION_LOCK_KEY})
        await conn.commit()
        try:
            yield
        finally:
            try:
                await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": MIGRATION_LOCK_KEY})
                await conn.commit()
            except Exception:  # noqa: BLE001
                await conn.invalidate()


# ─── 적용 ───


def _app_version() -> str:
    try:
        from app.version import APP_VERSION

        return APP_VERSION
    except Exception:  # noqa: BLE001
        return ""


async def _record(conn, version: int, name: str, notes: str | None = None) -> None:
    await conn.execute(
        schema_migrations.insert().values(
            version=version, name=name[:200], applied_at=datetime.now(timezone.utc),
            app_version=_app_version()[:64], notes=notes,
        )
    )


async def _apply_baseline(engine: AsyncEngine, log: Callable[[str], None]) -> list[str]:
    from app.db.baseline import apply_baseline

    try:
        warnings = await apply_baseline(engine)
    except Exception as e:  # noqa: BLE001
        raise MigrationError(BASELINE_VERSION, BASELINE_NAME, e) from e
    missing = await find_drift(engine)
    if missing:
        raise MigrationError(BASELINE_VERSION, BASELINE_NAME, str(SchemaDrift(missing)))
    for line in warnings:
        log(f"[DB] 기준선 경고: {line}")
    return warnings


async def migrate(
    engine: AsyncEngine,
    *,
    repair: bool = False,
    log: Callable[[str], None] = print,
) -> Result:
    """대기 중인 단계를 순서대로 적용한다. 실패하면 MigrationError(그 앞 단계까지는 적용된 채 남는다).

    repair=True: 버전과 무관하게 기준선 보정(빠진 테이블·컬럼·인덱스 채우기)을 다시 돌린다.
    """
    global _confirmed_version
    from app.db.migrations import STEPS

    check_steps()
    register_models()
    async with migration_lock(engine):
        state = await read_state(engine)
        if state.current > SCHEMA_VERSION:
            raise SchemaTooNew(state.current, SCHEMA_VERSION)
        result = Result(from_version=state.current, to_version=state.current)

        async with engine.begin() as conn:
            await conn.run_sync(lambda sync: schema_migrations.create(sync, checkfirst=True))

        if state.current < BASELINE_VERSION:
            log("[DB] " + ("기존 설치(버전 기록 없음) — 기준선으로 맞춥니다" if state.has_tables
                           else "새 DB — 스키마를 만듭니다"))
            warnings = await _apply_baseline(engine, log)
            async with engine.begin() as conn:
                await _record(conn, BASELINE_VERSION, BASELINE_NAME, "\n".join(warnings) or None)
            result.applied.append((BASELINE_VERSION, BASELINE_NAME))
            result.warnings += warnings
            result.to_version = BASELINE_VERSION
        elif repair:
            log("[DB] 기준선 보정을 다시 돌립니다(--repair)")
            warnings = await _apply_baseline(engine, log)
            async with engine.begin() as conn:
                await conn.execute(
                    schema_migrations.update().where(schema_migrations.c.version == BASELINE_VERSION)
                    .values(notes="\n".join(warnings) or None)
                )
            result.warnings += warnings

        for step in STEPS:
            if step.version <= result.to_version:
                continue
            log(f"[DB] 단계 {step.version} 적용: {step.name}")
            try:
                if step.transactional:
                    # 단계와 버전 기록이 한 트랜잭션 — 실패하면 둘 다 없던 일이 된다
                    async with engine.begin() as conn:
                        await step.apply(conn)
                        await _record(conn, step.version, step.name)
                else:
                    async with engine.connect() as conn:
                        auto = await conn.execution_options(isolation_level="AUTOCOMMIT")
                        await step.apply(auto)
                    async with engine.begin() as conn:
                        await _record(conn, step.version, step.name)
            except Exception as e:  # noqa: BLE001
                raise MigrationError(step.version, step.name, e) from e
            result.applied.append((step.version, step.name))
            result.to_version = step.version

        _confirmed_version = result.to_version
        return result


# ─── 기동 ───


def auto_migrate_enabled(env: dict[str, str] | None = None) -> bool:
    """`JW_MIGRATE_ON_START` — 0/false/no/off 면 끈다. 없으면 켠다."""
    value = (os.environ if env is None else env).get(ENV_MIGRATE_ON_START, "").strip().lower()
    return value not in ("0", "false", "no", "off")


def _is_connect_error(e: BaseException) -> bool:
    if isinstance(e, (OSError, asyncio.TimeoutError, InterfaceError)):
        return True
    if isinstance(e, (OperationalError, DBAPIError)):
        # DB 가 아직 안 떴거나 복구 중 — SQL 오류가 아니라 연결 문제만
        text_ = str(getattr(e, "orig", e)).lower()
        return isinstance(getattr(e, "orig", None), OSError) or any(
            s in text_ for s in ("connect", "starting up", "shutting down", "in recovery", "connection")
        )
    return False


async def _read_state_waiting(engine: AsyncEngine, wait_seconds: float, log: Callable[[str], None]) -> State:
    """DB 가 뜰 때까지(연결 오류에 한해) 기다렸다 상태를 읽는다."""
    deadline = asyncio.get_running_loop().time() + wait_seconds
    attempt = 0
    while True:
        try:
            return await read_state(engine)
        except Exception as e:  # noqa: BLE001
            attempt += 1
            if not _is_connect_error(e) or asyncio.get_running_loop().time() >= deadline:
                raise
            if attempt == 1:
                log(f"[DB] DB 연결을 기다립니다({type(e).__name__})")
            await asyncio.sleep(2)


async def ensure_schema(
    engine: AsyncEngine,
    *,
    verify: bool = False,
    wait_seconds: float = 30.0,
    env: dict[str, str] | None = None,
    log: Callable[[str], None] = print,
) -> int:
    """기동 때 부른다. DB 스키마가 코드가 요구하는 버전이 되게 하거나, 안 되면 예외로 기동을 막는다.

    - 같으면: 아무것도 안 한다(잠금도 안 잡는다).
    - 높으면: SchemaTooNew.
    - 낮으면: 자동 적용이 켜져 있으면 적용(실패하면 MigrationError), 꺼져 있으면 SchemaOutdated.
    - verify=True: 버전이 맞아도 모델과 DB 의 테이블·컬럼을 대조해 빠진 것이 있으면 SchemaDrift.
    """
    global _confirmed_version
    check_steps()
    state = await _read_state_waiting(engine, wait_seconds, log)
    if state.current > SCHEMA_VERSION:
        raise SchemaTooNew(state.current, SCHEMA_VERSION)
    if state.current < SCHEMA_VERSION:
        if not auto_migrate_enabled(env):
            raise SchemaOutdated(state.current, SCHEMA_VERSION, [f"{v}({n})" for v, n in pending_steps(state.current)])
        result = await migrate(engine, log=log)
        if result.applied:
            log(f"[DB] 스키마 {result.from_version} → {result.to_version} "
                f"({len(result.applied)}단계 적용, 경고 {len(result.warnings)}건)")
    if verify:
        missing = await find_drift(engine)
        if missing:
            raise SchemaDrift(missing)
    _confirmed_version = SCHEMA_VERSION
    return SCHEMA_VERSION


def confirmed_version() -> int | None:
    """이 프로세스가 기동 때 확인한 DB 스키마 버전(확인 전이면 None)."""
    return _confirmed_version


async def status(engine: AsyncEngine) -> dict:
    """현재 버전·대기 단계·기록·빠진 테이블/컬럼 — `migrate --status` 와 관리 화면용."""
    check_steps()
    state = await read_state(engine)
    drift = await find_drift(engine) if state.current else []
    return {
        "required": SCHEMA_VERSION,
        "current": state.current,
        "state": state.kind,
        "too_new": state.current > SCHEMA_VERSION,
        "pending": [{"version": v, "name": n} for v, n in pending_steps(state.current)],
        "applied": [
            {
                "version": r["version"], "name": r["name"], "app_version": r["app_version"],
                "applied_at": r["applied_at"].isoformat() if hasattr(r["applied_at"], "isoformat") else str(r["applied_at"]),
                "notes": r["notes"] or "",
            }
            for r in state.applied
        ],
        "missing": drift,
    }
