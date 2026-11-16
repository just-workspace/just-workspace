"""스키마 변경 단계 — 기준선(1) 이후의 변경은 여기에 번호 순서로만 추가한다.

작성 방법(상세 내용은 docs/data-safety.md):

1. 모델(app/**/models.py)을 수정한다.
2. 아래 `STEPS` 끝에 다음 번호의 단계를 추가한다. 번호는 1씩 증가하며, 한 번 릴리스된 단계는 수정하지 않는다.
3. `app/db/schema_version.py` 의 `SCHEMA_VERSION` 을 해당 번호로, `MODELS_FINGERPRINT` 를 새 값으로 변경한다.

단계는 **반복 실행해도 결과가 동일해야 한다.** 신규 설치는 현재 모델로 테이블을 생성한 뒤(기준선) 모든 단계를
순서대로 거치므로, 단계가 추가하려는 컬럼이 이미 존재할 수 있다. 아래 헬퍼는 전부 이 조건을 충족한다.

    async def _0003_user_title(conn):
        await add_column(conn, "users", "title")            # 모델에 선언된 컬럼을 그대로 더한다
        await run_sql(conn, "CREATE INDEX IF NOT EXISTS ix_users_title ON users(title)")

    STEPS = (
        ...,
        Step(3, "users.title 추가", _0003_user_title),
    )

- 단계 하나는 한 트랜잭션이다(PostgreSQL 은 DDL 도 롤백한다). 실패하면 해당 단계는 전부 롤백되고
  버전은 증가하지 않는다. `CREATE INDEX CONCURRENTLY` 처럼 트랜잭션 안에서 실행할 수 없는 것은
  `Step(..., transactional=False)` 로 분리하고, 반드시 멱등으로 작성한다.
- 롤백 단계(down)는 없다. 업데이트가 실패하면 직전 백업으로 복원한다.
- 삭제·이름 변경·타입 축소는 가급적 두 릴리스로 분리한다(먼저 사용을 중단하고, 다음 릴리스에서 삭제한다) —
  이전 이미지로 롤백했을 때 복원 없이 호환되는 범위가 넓어진다.
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


# ─── 단계에서 사용하는 헬퍼(전부 멱등) ───


def is_postgres(conn: AsyncConnection) -> bool:
    return conn.dialect.name == "postgresql"


async def run_sql(conn: AsyncConnection, sql: str, params: dict | None = None, *, postgres_only: bool = True) -> None:
    """SQL 한 문장 실행. 기본값은 PostgreSQL 에서만 실행(SQLite 는 테스트용이므로 건너뜀)."""
    if postgres_only and not is_postgres(conn):
        return
    await conn.execute(text(sql), params or {})


async def create_tables(conn: AsyncConnection, *table_names: str) -> None:
    """모델에 선언된 테이블을 생성한다(이미 있으면 그대로 유지한다)."""
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
    """모델에 선언된 컬럼을 DB 에 추가한다. 이미 있으면 False.

    기존 행이 손상되지 않도록 항상 NULL 허용으로 추가하고, 모델의 상수 기본값(불리언·정수)과 문자열
    server_default 는 DEFAULT 로 지정하여 기존 행을 채운다(기준선의 컬럼 추가와 동일한 규칙).
    NOT NULL 이 필요하면 값을 채운 뒤 같은 단계에서 `run_sql` 로 설정한다.
    """
    from app.db.baseline import column_add_sql

    if await has_column(conn, table, column):
        return False
    col = Base.metadata.tables[table].columns[column]
    await conn.execute(text(column_add_sql(table, col)))
    return True


# ─── 단계 목록(버전 2 부터) ───



async def _0002_state_out_of_redis(conn: AsyncConnection) -> None:
    """Redis 에만 있던 값 3종의 저장 위치 — 개인 잠금 PIN, POP3 의 읽음·별표, 새 메일 감시의 마지막 UID.

    저장 위치만 생성한다. 값은 코드가 최초 조회 시 Redis 에서 이전한다(본 단계는 DB 만 변경할 수 있다) —
    app/privacy/gate.py, app/mail/pop3_client.py, app/mail/poller.py.
    """
    await create_tables(conn, "privacy_pins", "mail_pop3_state")
    await add_column(conn, "mail_accounts", "last_seen_uid")
    await add_column(conn, "mail_accounts", "pop3_state_imported")


STEPS: tuple[Step, ...] = (
    Step(2, "개인 잠금 PIN·POP3 읽음 표시·새 메일 감시 위치를 DB 로", _0002_state_out_of_redis),
)
