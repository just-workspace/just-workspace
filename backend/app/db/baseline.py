"""기준선(스키마 버전 1) — 버전 기록 도입 이전의 스키마 보정 전체.

버전 기록(`schema_migrations`)이 없던 시기에는 서버 기동 시마다 `create_all` + 누락 컬럼
`ADD COLUMN` + 수작업 ALTER·백필을 실행했다. 해당 묶음 전체를 "기준선 = 1"로 정의한다.

- 신규 설치: 빈 DB 에 본 묶음을 실행하면 현재 모델과 동일한 스키마가 된다.
- 기존 설치(테이블은 있으나 버전 기록이 없음): 동일한 묶음이 누락분만 보충한다(전부 멱등 — 반복 실행해도
  결과가 동일하다). 데이터는 삭제하지 않는다.

**여기에 신규 변경을 추가하지 않는다.** 기준선 이후의 스키마 변경은 `app/db/migrations.py` 에 새 번호의
단계로만 추가한다. 본 파일은 기준선의 정의이므로, 수정하면 "버전 1"의 의미가 설치마다 달라진다.

실패 처리:
- 필수(테이블 생성, 누락 컬럼 추가, 메시지 순번)가 실패하면 예외 발생 — 기준선으로 표시하지 않는다.
- 선택(인덱스·확장·시드·백필)은 기존과 같이 건너뛰고 경고를 반환한다. 경고는 버전 기록의 notes 에 기록되며
  `python -m app.cli migrate --repair` 로 재시도할 수 있다. 이를 필수로 격상하면, 예컨대 중복 행으로 인해
  유니크 인덱스를 생성하지 못하는 기존 설치가 업데이트 후 기동하지 못한다.
"""

from sqlalchemy import inspect, text

from app.db.models import Base


def _first_line(e: BaseException) -> str:
    lines = str(e).splitlines()
    return (lines[0] if lines else type(e).__name__)[:200]

# ── SQLAlchemy type → PostgreSQL DDL ──

def _col_ddl(col) -> str:
    """Convert a SQLAlchemy Column to a PostgreSQL DDL type string."""
    type_cls = col.type.__class__.__name__.upper()
    if type_cls == "VARCHAR" or type_cls == "STRING":
        length = getattr(col.type, "length", None)
        return f"VARCHAR({length})" if length else "VARCHAR"
    if type_cls == "TEXT":
        return "TEXT"
    if type_cls in ("INTEGER", "INT"):
        return "INTEGER"
    if type_cls in ("BIGINTEGER", "BIGINT"):
        return "BIGINT"
    if type_cls == "BOOLEAN":
        return "BOOLEAN"
    if type_cls in ("DATETIME", "TIMESTAMP"):
        if getattr(col.type, "timezone", False):
            return "TIMESTAMPTZ"
        return "TIMESTAMP"
    if type_cls == "FLOAT":
        return "DOUBLE PRECISION"
    return "TEXT"


def column_add_sql(table_name: str, col) -> str:
    """모델 컬럼 하나를 추가하는 ALTER 문(항상 NULL 허용, 상수 기본값은 DEFAULT 로 지정)."""
    ddl_type = _col_ddl(col)
    # Always make new columns nullable to avoid breaking existing rows
    default = ""
    type_cls = col.type.__class__.__name__.upper()
    if type_cls == "BOOLEAN" and col.default is not None:
        arg = col.default.arg
        if not callable(arg):
            default = f" DEFAULT {'TRUE' if arg else 'FALSE'}"
    elif type_cls in ("INTEGER", "INT") and col.default is not None:
        arg = col.default.arg
        if not callable(arg):
            default = f" DEFAULT {arg}"
    elif type_cls in ("STRING", "VARCHAR") and col.server_default is not None:
        # 문자열 기본값도 포함해야 기존 행이 채워진다. 누락 시 users.auth_source 가
        # 과거 계정에서 NULL 로 남아 "local 이 아니면 외부 인증" 판정에 해당되었다.
        arg = getattr(col.server_default, "arg", None)
        if isinstance(arg, str):
            default = " DEFAULT '" + arg.replace("'", "''") + "'"

    return f'ALTER TABLE "{table_name}" ADD COLUMN "{col.name}" {ddl_type}{default}'


def _diff_columns(sync_conn) -> list[str]:
    """Compare model metadata with live DB schema. Returns ALTER TABLE SQL list.

    Runs synchronously inside run_sync().
    """
    insp = inspect(sync_conn)
    db_tables = set(insp.get_table_names())
    alter_stmts: list[str] = []

    for table in Base.metadata.sorted_tables:
        if table.name not in db_tables:
            continue  # New table — create_all handles it

        existing = {c["name"] for c in insp.get_columns(table.name)}

        for col in table.columns:
            if col.name in existing:
                continue

            ddl_type = _col_ddl(col)
            sql = column_add_sql(table.name, col)
            alter_stmts.append((table.name, col.name, ddl_type, sql))

    return alter_stmts


async def _auto_migrate(engine):
    """Inspect live DB schema and add missing columns from models.

    Safe because:
    - Only ADDs columns (never drops/renames)
    - New columns are always NULLable
    - Each ALTER runs independently
    """
    # Step 1: Diff inside run_sync (uses sync inspector)
    async with engine.begin() as conn:
        stmts = await conn.run_sync(_diff_columns)

    if not stmts:
        return

    # Step 2: Execute ALTER TABLE statements
    for table_name, col_name, ddl_type, sql in stmts:
        async with engine.begin() as conn:
            try:
                await conn.execute(text(sql))
                print(f"[DB] auto-migrate: added {table_name}.{col_name} ({ddl_type})")
            except Exception as e:
                # 다른 프로세스가 먼저 추가한 경우만 무시한다. 그 밖의 실패는 예외로 전파한다 —
                # 과거에는 여기서 예외를 무시하여 컬럼이 누락된 상태로 서버가 기동되었다.
                err_str = str(e).lower()
                if "already exists" not in err_str and "duplicate" not in err_str:
                    raise RuntimeError(
                        f"컬럼 추가 실패: {table_name}.{col_name} ({ddl_type}) — {_first_line(e)}"
                    ) from e


async def _run_legacy_migrations(engine) -> list[str]:
    """One-time legacy migrations for constraints/indexes (idempotent). 반환값: 건너뛴 문장의 경고."""
    migrations = [
        "CREATE INDEX IF NOT EXISTS ix_reactions_message_id ON reactions(message_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_reactions_unique ON reactions(message_id, user_id, emoji)",
        "CREATE INDEX IF NOT EXISTS ix_messages_parent_id ON messages(parent_id)",
        # 캘린더 회차 예외 행 → 마스터 (컬럼은 auto-migrate 가 추가)
        "CREATE INDEX IF NOT EXISTS ix_calendar_events_parent ON calendar_events(parent_event_id)",
        # 파일 채널 공유: 사용자 대신 채널을 수신 대상으로 하는 행이 생성된다 → user 컬럼 NOT NULL 해제 + 채널 인덱스
        "ALTER TABLE file_shares ALTER COLUMN shared_with_user_id DROP NOT NULL",
        "CREATE INDEX IF NOT EXISTS ix_file_shares_channel ON file_shares(shared_with_channel_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_file_shares_unique_channel "
        "ON file_shares(owner_id, file_path, shared_with_channel_id)",
        # 파일 공유 권한 4단계: role 컬럼(auto-migrate)을 기존 can_write 값으로 1회 채운다.
        # role 이 비어 있는 행만 대상이므로 기동 시마다 실행해도 안전하다. 코드도 NULL 이면 can_write 로 판정한다.
        "UPDATE file_shares SET role = CASE WHEN can_write THEN 'edit' ELSE 'view' END WHERE role IS NULL",
        # Subtasks: parent_id column added by auto-migrate; index here
        "CREATE INDEX IF NOT EXISTS ix_tasks_parent_id ON tasks(parent_id)",
        # 하위 작업 FK(ON DELETE CASCADE) — 모델에는 있으나 auto-migrate 는 컬럼만 추가하므로 운영 DB 에 FK 가 없었다
        # (부모를 삭제해도 하위 작업이 고아 행으로 잔존). NOT VALID: 기존 고아 행은 검사하지 않으며(삭제하지 않는다)
        # 이후의 삽입·부모 삭제에만 적용한다. 이미 존재하면 건너뛴다.
        "DO $$ BEGIN "
        "IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a "
        "ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) "
        "WHERE c.conrelid = 'tasks'::regclass AND c.contype = 'f' AND a.attname = 'parent_id') THEN "
        "ALTER TABLE tasks ADD CONSTRAINT tasks_parent_id_fkey FOREIGN KEY (parent_id) "
        "REFERENCES tasks(id) ON DELETE CASCADE NOT VALID; "
        "END IF; END $$",
        # 채널 탭: 채널에 연결된 작업·회의 (컬럼은 auto-migrate)
        "CREATE INDEX IF NOT EXISTS ix_tasks_channel_id ON tasks(channel_id)",
        "CREATE INDEX IF NOT EXISTS ix_meetings_chat_channel ON meetings(chat_channel_id)",
        # AI 대화: 답변 버전 분기·프로젝트 묶음 (컬럼은 auto-migrate, 이름은 SQLAlchemy 기본 ix_<표>_<열> 과
        # 동일하게 지정 — 신규 설치에서 create_all 이 생성한 인덱스와 충돌하지 않고 그대로 건너뛴다)
        "CREATE INDEX IF NOT EXISTS ix_ai_messages_parent_id ON ai_messages(parent_id)",
        "CREATE INDEX IF NOT EXISTS ix_ai_conversations_project_id ON ai_conversations(project_id)",

        # ── 파일 검색 색인 ──
        # 한글은 형태소 분석기 없이 tsvector 를 사용하면 토큰이 통째로 추출되어
        # 부분 일치가 불가하다. trigram 으로 ILIKE 가 인덱스를 사용하도록 한다.
        "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        "CREATE INDEX IF NOT EXISTS ix_file_index_name_trgm "
        "ON file_index USING gin (lower(name) gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS ix_file_index_path_trgm "
        "ON file_index USING gin (lower(rel_path) gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS ix_file_index_content_trgm "
        "ON file_index USING gin (lower(content) gin_trgm_ops)",

        # ── 문자열 기본값 소급 ──
        # auto-migrate 가 문자열 server_default 를 제외하고 컬럼만 추가하여, 컬럼 추가 이전의 행은 NULL 이고
        # DB 기본값도 없었다. NULL 인 행만 채우므로 기동 시마다 실행해도 안전하다(LDAP 계정에는 "ldap" 이 저장되어 있다).
        "UPDATE users SET auth_source = 'local' WHERE auth_source IS NULL",
        "ALTER TABLE users ALTER COLUMN auth_source SET DEFAULT 'local'",
        "UPDATE mail_accounts SET protocol = 'imap' WHERE protocol IS NULL",
        "ALTER TABLE mail_accounts ALTER COLUMN protocol SET DEFAULT 'imap'",
    ]
    # 문장별 세이브포인트 사용 — PostgreSQL 은 한 문장이 실패하면 트랜잭션이 abort 되므로,
    # 과거처럼 단일 트랜잭션에서 except: pass 로 무시하면 이후 문장이 전부 경고 없이 실패했다.
    warnings: list[str] = []
    async with engine.begin() as conn:
        for sql in migrations:
            try:
                async with conn.begin_nested():
                    await conn.execute(text(sql))
            except Exception as e:
                line = f"건너뜀: {sql[:80]}… — {_first_line(e)[:160]}"
                print(f"[DB] legacy migration {line}")
                warnings.append(line)
    return warnings


# 채팅 마이그레이션용 advisory lock 키. 임의의 고정 상수이며 다른 락과 중복되지 않으면 충분하다.
_CHAT_MIGRATION_LOCK_KEY = 7314001


async def _run_chat_seq_migration(engine):
    """메시지 전역 순번 — 시퀀스 생성·기존 행 백필·DEFAULT/NOT NULL·인덱스.

    다음 세 가지를 보장해야 한다.
    - 멱등: 기동 시마다 실행해도 두 번째부터는 사실상 no-op (NULL 행이 없으면 백필 생략).
    - 동시 기동 안전: 워커 8개가 동시에 기동하므로 트랜잭션 범위 advisory lock 으로
      한 워커만 진입시키고, 나머지는 해당 커밋을 대기한 뒤 "할 게 없음"을 확인한다.
    - 순서 보존: 백필은 created_at, id 순으로 row_number 를 부여한다. 백필 중 구버전
      워커가 개입하여 NULL seq 행을 생성하지 못하도록 messages 테이블에 쓰기 락을 설정한다
      (읽기는 차단하지 않는다; 수만 건이면 수 초 내에 완료된다).
    """
    if engine.dialect.name != "postgresql":
        return

    async with engine.begin() as conn:
        await conn.execute(text(f"SELECT pg_advisory_xact_lock({_CHAT_MIGRATION_LOCK_KEY})"))

        await conn.execute(text("CREATE SEQUENCE IF NOT EXISTS messages_seq_seq AS BIGINT"))
        # 테이블 삭제 시 시퀀스도 함께 삭제 — 이름 충돌·고아 시퀀스 방지
        await conn.execute(text("ALTER SEQUENCE messages_seq_seq OWNED BY messages.seq"))

        has_null = (
            await conn.execute(text("SELECT EXISTS (SELECT 1 FROM messages WHERE seq IS NULL)"))
        ).scalar()
        if has_null:
            await conn.execute(text("LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE"))
            # 이미 seq 가 부여된 행(롤링 재시작 중 신버전이 먼저 삽입한 행)이 있으면 그 뒤에 이어서 부여한다.
            res = await conn.execute(text(
                "UPDATE messages m SET seq = s.rn + base.mx "
                "FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn "
                "      FROM messages WHERE seq IS NULL) s, "
                "     (SELECT coalesce(max(seq), 0) AS mx FROM messages) base "
                "WHERE m.id = s.id"
            ))
            print(f"[DB] chat-migrate: messages.seq 백필 {res.rowcount}행")

        # 시퀀스 현재값을 max(seq) 에 맞춘다. 비어 있으면 다음 nextval 이 1 이 되도록 is_called=false 로 설정한다.
        await conn.execute(text(
            "SELECT setval('messages_seq_seq', "
            "  GREATEST(coalesce((SELECT max(seq) FROM messages), 0), 1), "
            "  (SELECT max(seq) FROM messages) IS NOT NULL)"
        ))
        # ORM 을 거치지 않는 INSERT(구버전 워커·수동 SQL)에도 seq 가 부여되도록 DB 기본값으로 지정한다.
        await conn.execute(text(
            "ALTER TABLE messages ALTER COLUMN seq SET DEFAULT nextval('messages_seq_seq')"
        ))
        await conn.execute(text("ALTER TABLE messages ALTER COLUMN seq SET NOT NULL"))
        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_messages_seq ON messages(seq)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_messages_channel_seq ON messages(channel_id, seq)"
        ))

        # ── 읽음 포인터·채널 메타 백필 (seq 가 전부 채워진 이후에만 유효) ──
        # 기존 last_read_message_id → 해당 메시지의 seq. NULL 인 행만 대상이므로 멱등.
        res = await conn.execute(text(
            "UPDATE channel_members cm SET last_read_seq = m.seq "
            "FROM messages m "
            "WHERE m.id = cm.last_read_message_id AND cm.last_read_seq IS NULL"
        ))
        if res.rowcount:
            print(f"[DB] chat-migrate: channel_members.last_read_seq 백필 {res.rowcount}행")
        # 채널별 마지막 메시지(스레드 답글·삭제 제외) — 아직 채워지지 않은 채널만 대상
        res = await conn.execute(text(
            "UPDATE channels c SET last_message_seq = m.seq, last_message_at = m.created_at, "
            "  last_preview = left(m.content, 200) "
            "FROM (SELECT DISTINCT ON (channel_id) channel_id, seq, created_at, content "
            "      FROM messages WHERE is_deleted = false AND parent_id IS NULL "
            "      ORDER BY channel_id, seq DESC) m "
            "WHERE m.channel_id = c.id AND c.last_message_seq IS NULL"
        ))
        if res.rowcount:
            print(f"[DB] chat-migrate: channels.last_message_* 백필 {res.rowcount}행")


async def _run_thread_follow_backfill(engine):
    """스레드 팔로우 테이블이 비어 있을 때 1회만 — 기존 스레드의 참여 이력을 팔로우로 이전한다.

    과거 "내 스레드" 는 참여(원 글 작성·답글 작성) 기준으로 집계했다. 팔로우 기반으로 전환하면서 기존
    스레드가 목록에서 누락되지 않도록 동일한 집합을 thread_follows 에 삽입한다. last_read_seq 는
    해당 스레드의 마지막 답글 seq 로 설정하여 기존 스레드가 전부 미읽음으로 표시되지 않게 한다.
    테이블에 행이 하나라도 있으면 건너뛰므로 기동 시마다 실행해도 안전하다.
    """
    if engine.dialect.name != "postgresql":
        return
    async with engine.begin() as conn:
        await conn.execute(text(f"SELECT pg_advisory_xact_lock({_CHAT_MIGRATION_LOCK_KEY + 1})"))
        has_rows = (
            await conn.execute(text("SELECT EXISTS (SELECT 1 FROM thread_follows)"))
        ).scalar()
        if has_rows:
            return
        res = await conn.execute(text(
            "INSERT INTO thread_follows (id, user_id, root_message_id, channel_id, last_read_seq, followed, created_at) "
            "SELECT gen_random_uuid()::text, p.user_id, p.root_id, p.channel_id, p.max_seq, true, now() "
            "FROM ( "
            "  SELECT r.parent_id AS root_id, r.channel_id, u.user_id, max(r.seq) AS max_seq "
            "  FROM messages r "
            "  JOIN messages root ON root.id = r.parent_id "
            "  JOIN LATERAL (VALUES (r.sender_id), (root.sender_id)) AS u(user_id) ON u.user_id IS NOT NULL "
            "  WHERE r.parent_id IS NOT NULL AND r.is_deleted = false "
            "  GROUP BY r.parent_id, r.channel_id, u.user_id "
            ") p "
            "JOIN users ON users.id = p.user_id "
            "ON CONFLICT DO NOTHING"
        ))
        if res.rowcount:
            print(f"[DB] chat-migrate: thread_follows 백필 {res.rowcount}행")


async def _run_search_trgm_migration(engine) -> list[str]:
    """검색 인덱스와 쿼리의 일치 — 메시지·게시글 본문에 pg_trgm GIN 적용.

    메시지 검색(chat/service.search_messages, search/router)과 게시판 검색은 전부
    `ILIKE '%q%'` 인데 인덱스는 to_tsvector 였다 → 인덱스가 전혀 사용되지 않았다. 한국어는 형태소
    분석기 없이 tsvector 를 사용하면 부분 일치가 불가하므로 ILIKE 를 유지하고 trigram 으로
    보완한다(files/search.py 와 동일한 선택). 확장을 생성하지 못하면(권한) 경고만 기록하고 건너뛴다 —
    검색 속도만 저하될 뿐 결과는 정확하다.

    과거 모델이 선언하던 to_tsvector 인덱스(ix_messages_fulltext, ix_posts_fulltext)는 어떤
    쿼리에도 사용되지 않으면서 INSERT 마다 GIN 갱신 비용만 발생시켰다 — 모델에서 제거했으며, 해당 버전으로
    신규 설치하여 잔존하는 경우 여기서 삭제한다(IF EXISTS, 데이터와 무관).
    """
    warnings: list[str] = []
    if engine.dialect.name != "postgresql":
        return warnings
    for name in ("ix_messages_fulltext", "ix_posts_fulltext"):
        try:
            async with engine.begin() as conn:
                await conn.execute(text(f"DROP INDEX IF EXISTS {name}"))
        except Exception as e:
            print(f"[DB] WARN: 안 쓰는 인덱스 {name} 삭제 실패 — {e}")
            warnings.append(f"안 쓰는 인덱스 {name} 삭제 실패 — {_first_line(e)}")
    async with engine.begin() as conn:
        has_ext = (
            await conn.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'"))
        ).scalar()
    if not has_ext:
        try:
            async with engine.begin() as conn:
                await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        except Exception as e:
            print(f"[DB] WARN: pg_trgm 확장을 만들 수 없어 메시지/게시글 trigram 인덱스를 건너뜁니다 — {e}")
            warnings.append(f"pg_trgm 확장을 만들 수 없어 trigram 인덱스를 건너뜀 — {_first_line(e)}")
            return warnings

    indexes = [
        "CREATE INDEX IF NOT EXISTS ix_messages_content_trgm "
        "ON messages USING gin (content gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS ix_posts_title_trgm "
        "ON posts USING gin (title gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS ix_posts_content_trgm "
        "ON posts USING gin (content gin_trgm_ops)",
    ]
    for sql in indexes:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
        except Exception as e:
            print(f"[DB] WARN: trigram 인덱스 생성 실패 — {sql[:60]}… : {e}")
            warnings.append(f"trigram 인덱스 생성 실패 — {sql[:60]}… : {_first_line(e)}")
    return warnings


async def _run_chat_roles_migration(engine):
    """역할·권한 — @everyone 시드, 기본 카테고리 3개 시드+백필(1회), channels.category_id FK.

    - @everyone: is_default 행이 없을 때만 생성한다(권한 = permissions.DEFAULT_EVERYONE = 현재 동작).
      이미 있으면 변경하지 않는다 — 관리자가 변경한 기본 권한을 기동 시마다 되돌려서는 안 된다.
    - 카테고리: system_settings 'chat.categories_seeded' 표시가 없을 때 1회만 "채널"·"음성"·"보관"을 생성하고
      DM 이 아닌 채널의 category_id 가 비어 있으면 채운다(보관 → 보관, 음성 → 음성, 나머지 → 채널).
      표시를 기록하므로 관리자가 카테고리를 전부 삭제해도 재생성되지 않는다.
    - FK: auto-migrate 는 컬럼만 추가한다 → ON DELETE SET NULL FK 를 NOT VALID 로 추가한다(이미 있으면 건너뜀).
    워커 8개 동시 기동 — 마이그레이션 세션 락 안에서 실행되며, 여기서도 트랜잭션 advisory lock 을 추가로 획득한다.
    """
    if engine.dialect.name != "postgresql":
        return
    from app.chat.permissions import DEFAULT_EVERYONE

    async with engine.begin() as conn:
        await conn.execute(text(f"SELECT pg_advisory_xact_lock({_CHAT_MIGRATION_LOCK_KEY + 2})"))
        res = await conn.execute(text(
            "INSERT INTO chat_roles (id, name, position, permissions, hoist, mentionable, is_default, "
            "  created_at, updated_at) "
            "SELECT gen_random_uuid()::text, 'everyone', 0, :p, false, false, true, now(), now() "
            "WHERE NOT EXISTS (SELECT 1 FROM chat_roles WHERE is_default = true)"
        ), {"p": DEFAULT_EVERYONE})
        if res.rowcount:
            print("[DB] chat-migrate: @everyone 역할 생성(기본 권한 = 지금 동작)")

        seeded = (await conn.execute(text(
            "SELECT 1 FROM system_settings WHERE key = 'chat.categories_seeded'"
        ))).scalar()
        if not seeded:
            ids = {}
            for pos, name in enumerate(("채널", "음성", "보관")):
                cid = (await conn.execute(text(
                    "INSERT INTO chat_categories (id, name, position, created_at) "
                    "VALUES (gen_random_uuid()::text, :n, :p, now()) RETURNING id"
                ), {"n": name, "p": pos})).scalar()
                ids[name] = cid
            res = await conn.execute(text(
                "UPDATE channels SET category_id = CASE "
                "  WHEN is_archived THEN :arc WHEN coalesce(is_voice, false) THEN :voi ELSE :txt END "
                "WHERE category_id IS NULL AND type <> 'dm'"
            ), {"arc": ids["보관"], "voi": ids["음성"], "txt": ids["채널"]})
            await conn.execute(text(
                "INSERT INTO system_settings (key, value, updated_at) VALUES ('chat.categories_seeded', :v, now()) "
                "ON CONFLICT (key) DO NOTHING"
            ), {"v": "1"})
            print(f"[DB] chat-migrate: 기본 카테고리 3개 + 채널 {res.rowcount}개 배치")

        await conn.execute(text(
            "DO $$ BEGIN "
            "IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a "
            "ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) "
            "WHERE c.conrelid = 'channels'::regclass AND c.contype = 'f' AND a.attname = 'category_id') THEN "
            "ALTER TABLE channels ADD CONSTRAINT channels_category_id_fkey FOREIGN KEY (category_id) "
            "REFERENCES chat_categories(id) ON DELETE SET NULL NOT VALID; "
            "END IF; END $$"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_channels_category_id ON channels(category_id)"
        ))


async def _run_chat22_migration(engine):
    """chat22 — auto-migrate 가 처리하지 못하는 항목만. 전부 idempotent.

    - reactions.emoji VARCHAR(10) → VARCHAR(64): 커스텀 이모지 `:name:`. 이미 64 이상이면 건너뛴다
      (ALTER 는 짧은 ACCESS EXCLUSIVE 잠금을 획득한다 — varchar 확장은 테이블 재작성이 없어 무중단).
    - messages.reply_to_id 인덱스(신규 컬럼은 Step 2 auto-migrate 가 추가했다).
    워커 8개 — 마이그레이션 세션 락 안에서 실행되며, 여기서도 트랜잭션 advisory lock 을 획득한다.
    """
    if engine.dialect.name != "postgresql":
        return
    async with engine.begin() as conn:
        await conn.execute(text(f"SELECT pg_advisory_xact_lock({_CHAT_MIGRATION_LOCK_KEY + 3})"))
        width = (await conn.execute(text(
            "SELECT character_maximum_length FROM information_schema.columns "
            "WHERE table_name = 'reactions' AND column_name = 'emoji'"
        ))).scalar()
        if width is not None and width < 64:
            await conn.execute(text("ALTER TABLE reactions ALTER COLUMN emoji TYPE VARCHAR(64)"))
            print("[DB] chat22-migrate: reactions.emoji VARCHAR(10) → VARCHAR(64)")
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_messages_reply_to_id ON messages(reply_to_id)"
        ))


async def _run_chat_archive_category_migration(engine):
    """보관 시스템 카테고리 — system_settings 'chat.archive_category_id' 를 1회 채운다.

    역할 시드(_run_chat_roles_migration)가 생성한 '보관' 카테고리가 있으면 이를 '보관된 프로젝트'로 변경하여 사용하고,
    없으면 새로 생성한다. 키가 이미 있으면 아무 작업도 수행하지 않는다(관리자가 이름을 변경해도 되돌리지 않는다).
    """
    if engine.dialect.name != "postgresql":
        return
    async with engine.begin() as conn:
        await conn.execute(text(f"SELECT pg_advisory_xact_lock({_CHAT_MIGRATION_LOCK_KEY + 4})"))
        have = (await conn.execute(text(
            "SELECT value FROM system_settings WHERE key = 'chat.archive_category_id'"
        ))).scalar()
        if have and (await conn.execute(text(
            "SELECT 1 FROM chat_categories WHERE id = :i"), {"i": have})).scalar():
            return
        cid = (await conn.execute(text(
            "SELECT id FROM chat_categories WHERE name = '보관' ORDER BY position, created_at LIMIT 1"
        ))).scalar()
        if cid:
            await conn.execute(text("UPDATE chat_categories SET name = '보관된 프로젝트' WHERE id = :i"), {"i": cid})
        else:
            pos = (await conn.execute(text("SELECT coalesce(max(position), -1) + 1 FROM chat_categories"))).scalar()
            cid = (await conn.execute(text(
                "INSERT INTO chat_categories (id, name, position, created_at) "
                "VALUES (gen_random_uuid()::text, '보관된 프로젝트', :p, now()) RETURNING id"
            ), {"p": pos})).scalar()
        await conn.execute(text(
            "INSERT INTO system_settings (key, value, updated_at) VALUES ('chat.archive_category_id', :v, now()) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"
        ), {"v": cid})
        print(f"[DB] chat-migrate: 보관 시스템 카테고리 = {cid}")


async def apply_baseline(engine) -> list[str]:
    """기준선 묶음을 실행한다. 반환값: 건너뛴 선택 항목의 경고(없으면 빈 목록).

    호출자(app/db/migrate.py)가 잠금을 보유한 상태여야 한다.
    """
    warnings: list[str] = []
    postgres = engine.dialect.name == "postgresql"

    # 1) 신규 테이블
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # 2) 모델에는 있고 DB 에는 없는 컬럼 (실패 시 예외 발생)
    await _auto_migrate(engine)

    if not postgres:
        # 이하는 PostgreSQL 전용 문법이다(SQLite 는 테스트용 — 테이블·컬럼까지만 일치시킨다)
        return warnings

    # 3) 제약·인덱스·기본값 소급 (문장별로 건너뛸 수 있음)
    warnings += await _run_legacy_migrations(engine)

    # 4) 채팅 메시지 순번 — 시퀀스·백필·NOT NULL (실패 시 예외 발생)
    await _run_chat_seq_migration(engine)

    # 5) 검색용 trigram 인덱스
    warnings += await _run_search_trgm_migration(engine)

    # 6) 채팅 역할·카테고리 시드, 이모지 컬럼 확장, 보관 카테고리, 스레드 팔로우 백필
    for label, steps in (
        ("채팅 역할·카테고리", (_run_chat_roles_migration,)),
        ("chat22", (_run_chat22_migration, _run_chat_archive_category_migration)),
        ("스레드 팔로우 백필", (_run_thread_follow_backfill,)),
    ):
        try:
            for step in steps:
                await step(engine)
        except Exception as e:  # noqa: BLE001 — 선택 항목: 경고로 기록
            line = f"{label} 실패 — {_first_line(e)}"
            print(f"[DB] WARN: {line}")
            warnings.append(line)
    return warnings
