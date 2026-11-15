"""스키마 변경 단계 — 기준선(1) 이후의 변경은 여기에 번호 순서로만 더한다.

작성법(자세한 것은 docs/data-safety.md):

1. 모델(app/**/models.py)을 고친다.
2. 아래 `STEPS` 끝에 다음 번호의 단계를 더한다. 번호는 1씩 늘고, 한 번 릴리스된 단계는 고치지 않는다.
3. `app/db/schema_version.py` 의 `SCHEMA_VERSION` 을 그 번호로, `MODELS_FINGERPRINT` 를 새 값으로 바꾼다.

단계는 **여러 번 돌려도 결과가 같아야 한다.** 새 설치는 지금 모델로 테이블을 만든 뒤(기준선) 모든 단계를
차례로 지나가므로, 단계가 더하려는 컬럼이 이미 있을 수 있다. 아래 도우미는 전부 그렇게 동작한다.

    async def _0002_user_title(conn):
        await add_column(conn, "users", "title")            # 모델에 선언된 컬럼을 그대로 더한다
        await run_sql(conn, "CREATE INDEX IF NOT EXISTS ix_users_title ON users(title)")

    STEPS = (
        Step(2, "users.title 추가", _0002_user_title),
    )

- 단계 하나는 한 트랜잭션이다(PostgreSQL 은 DDL 도 되돌린다). 실패하면 그 단계는 흔적 없이 되돌려지고
  버전은 오르지 않는다. `CREATE INDEX CONCURRENTLY` 처럼 트랜잭션 안에서 못 도는 것은
  `Step(..., transactional=False)` 로 따로 떼고, 반드시 멱등으로 쓴다.
- 되돌리는 단계(down)는 없다. 업데이트가 실패하면 직전 백업으로 복원한다.
- 지우기·이름 바꾸기·타입 좁히기는 되도록 두 릴리스에 나눈다(먼저 안 쓰게 하고, 다음에 지운다) —
  이전 이미지로 되돌렸을 때 복원 없이 버틸 수 있는 폭이 넓어진다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.db.models import Base


@dataclass(frozen=True)
class Step:
    version: int
    name: str
    apply: Callable[[AsyncConnection], Awaitable[None]]
    transactional: bool = True


# ─── 단계에서 쓰는 도우미(전부 멱등) ───


def is_postgres(conn: AsyncConnection) -> bool:
    return conn.dialect.name == "postgresql"


async def run_sql(conn: AsyncConnection, sql: str, params: dict | None = None, *, postgres_only: bool = True) -> None:
    """SQL 한 문장. 기본은 PostgreSQL 에서만 돈다(SQLite 는 테스트용이라 건너뛴다)."""
    if postgres_only and not is_postgres(conn):
        return
    await conn.execute(text(sql), params or {})


async def create_tables(conn: AsyncConnection, *table_names: str) -> None:
    """모델에 선언된 테이블을 만든다(이미 있으면 그대로 둔다)."""
    tables = [Base.metadata.tables[name] for name in table_names]
    await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables, checkfirst=True))


async def has_column(conn: AsyncConnection, table: str, column: str) -> bool:
    def _check(sync) -> bool:
        insp = inspect(sync)
        if table not in insp.get_table_names():
            return False
        return column in {c["name"] for c in insp.get_columns(table)}

    return await conn.run_sync(_check)


async def add_column(conn: AsyncConnection, table: str, column: str) -> bool:
    """모델에 선언된 컬럼을 DB 에 더한다. 이미 있으면 False.

    기존 행을 깨지 않게 늘 NULL 허용으로 더하고, 모델의 상수 기본값(불리언·정수)과 문자열
    server_default 는 DEFAULT 로 실어 기존 행을 채운다(기준선의 컬럼 추가와 같은 규칙).
    NOT NULL 이 필요하면 채운 뒤 같은 단계에서 `run_sql` 로 건다.
    """
    from app.db.baseline import column_add_sql

    if await has_column(conn, table, column):
        return False
    col = Base.metadata.tables[table].columns[column]
    await conn.execute(text(column_add_sql(table, col)))
    return True


# ─── 단계 목록(버전 2 부터) ───

STEPS: tuple[Step, ...] = ()
