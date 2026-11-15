import asyncio
from contextlib import asynccontextmanager

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings
from app.db.models import (  # noqa: F401 — ensure all models registered
    Base, AccessLog, AuditLog, Channel, ChannelMember, ChatMention, Message, Notification, NotificationPref, Reaction,
    ThreadFollow, UserStatus, ChatDraft,
    SystemSetting, MailAccount, MailDraft, CalendarDB, CalendarEventDB, CalendarShareDB,
    AddressBookDB, ContactDB, TaskDB,
    Board, Post, PostComment, PostReaction, PostBookmark, PostReadLog,
    PushSubscription, MailFilterRule, ShareLink, ShareLinkEmail, FileShare, FileComment,
    WikiSpace, WikiPage, WikiPageVersion, WikiSpaceMember,
    OAuthRefreshToken, OAuthDynamicClient, McpPersonalToken, McpWriteRequest,
)
# 채팅 권한 엔진이 group_members 를 읽는다(관리되는 역할) — app.main 을 거치지 않는 init_db 에서도 테이블이 생기게
import app.groups.models  # noqa: F401,E402
# 내장 AI 대화·메시지·피드백(S6a ai_message_feedback)·프로젝트·메모리·첨부(S6b) — init_db 단독 실행에서도 테이블이 생기게
import app.ai.models  # noqa: F401,E402
import app.ai.artifact_models  # noqa: F401,E402  — S4 결과물(ai_artifacts·ai_artifact_jobs)

settings = get_settings()
engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=True,
    pool_recycle=300,
)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


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
                # 문자열 기본값도 실어야 기존 행이 채워진다. 빠뜨렸을 때 users.auth_source 가
                # 옛 계정에서 NULL 로 남아 "local 이 아니면 외부 인증" 판정에 걸렸다.
                arg = getattr(col.server_default, "arg", None)
                if isinstance(arg, str):
                    default = " DEFAULT '" + arg.replace("'", "''") + "'"

            sql = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {ddl_type}{default}'
            alter_stmts.append((table.name, col.name, ddl_type, sql))

    return alter_stmts


async def _auto_migrate():
    """Inspect live DB schema and add missing columns from models.

    Replaces manual migration lists. Safe because:
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
                err_str = str(e).lower()
                if "already exists" not in err_str and "duplicate" not in err_str:
                    print(f"[DB] auto-migrate FAILED: {table_name}.{col_name} — {e}")


async def _run_legacy_migrations():
    """One-time legacy migrations for constraints/indexes (idempotent)."""
    migrations = [
        "CREATE INDEX IF NOT EXISTS ix_reactions_message_id ON reactions(message_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_reactions_unique ON reactions(message_id, user_id, emoji)",
        "CREATE INDEX IF NOT EXISTS ix_messages_parent_id ON messages(parent_id)",
        # 캘린더 회차 예외 행 → 마스터 (p4, 컬럼은 auto-migrate 가 추가)
        "CREATE INDEX IF NOT EXISTS ix_calendar_events_parent ON calendar_events(parent_event_id)",
        # 파일 채널 공유 (p8): 사람 대신 채널을 받는 행이 생긴다 → user 칸 NOT NULL 해제 + 채널 인덱스
        "ALTER TABLE file_shares ALTER COLUMN shared_with_user_id DROP NOT NULL",
        "CREATE INDEX IF NOT EXISTS ix_file_shares_channel ON file_shares(shared_with_channel_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_file_shares_unique_channel "
        "ON file_shares(owner_id, file_path, shared_with_channel_id)",
        # 파일 공유 권한 4단계(p9): role 컬럼(auto-migrate)을 예전 can_write 로 한 번 채운다.
        # role 이 비어 있는 행만 건드리므로 매 기동 돌아도 안전. 코드도 NULL 이면 can_write 로 읽는다.
        "UPDATE file_shares SET role = CASE WHEN can_write THEN 'edit' ELSE 'view' END WHERE role IS NULL",
        # Subtasks: parent_id column added by auto-migrate; index here
        "CREATE INDEX IF NOT EXISTS ix_tasks_parent_id ON tasks(parent_id)",
        # 하위 작업 FK(ON DELETE CASCADE) — 모델엔 있지만 auto-migrate 는 컬럼만 더해 운영 DB 에 FK 가 없었다
        # (부모를 지워도 하위가 고아로 남음). NOT VALID: 이미 있는 고아 행은 검사하지 않고(지우지 않는다)
        # 앞으로의 삽입·부모 삭제에만 적용. 이미 있으면 건너뛴다.
        "DO $$ BEGIN "
        "IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a "
        "ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) "
        "WHERE c.conrelid = 'tasks'::regclass AND c.contype = 'f' AND a.attname = 'parent_id') THEN "
        "ALTER TABLE tasks ADD CONSTRAINT tasks_parent_id_fkey FOREIGN KEY (parent_id) "
        "REFERENCES tasks(id) ON DELETE CASCADE NOT VALID; "
        "END IF; END $$",
        # 채널 탭(p8): 채널에 묶인 작업·회의 (컬럼은 auto-migrate)
        "CREATE INDEX IF NOT EXISTS ix_tasks_channel_id ON tasks(channel_id)",
        "CREATE INDEX IF NOT EXISTS ix_meetings_chat_channel ON meetings(chat_channel_id)",
        # S6b AI 대화: 답변 버전 가지·프로젝트 묶음 (컬럼은 auto-migrate, 이름은 SQLAlchemy 기본 ix_<표>_<열> 과
        # 같게 — 새 설치에서 create_all 이 만든 인덱스와 겹치지 않고 그대로 건너뛴다)
        "CREATE INDEX IF NOT EXISTS ix_ai_messages_parent_id ON ai_messages(parent_id)",
        "CREATE INDEX IF NOT EXISTS ix_ai_conversations_project_id ON ai_conversations(project_id)",

        # ── 파일 검색 색인 ──
        # 한글은 형태소 분석기 없이 tsvector 를 쓰면 토큰이 통째로 잡혀
        # 부분일치가 안 된다. trigram 으로 ILIKE 를 인덱스 태운다.
        "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        "CREATE INDEX IF NOT EXISTS ix_file_index_name_trgm "
        "ON file_index USING gin (lower(name) gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS ix_file_index_path_trgm "
        "ON file_index USING gin (lower(rel_path) gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS ix_file_index_content_trgm "
        "ON file_index USING gin (lower(content) gin_trgm_ops)",

        # ── 문자열 기본값 소급 ──
        # auto-migrate 가 문자열 server_default 를 빼고 컬럼만 더해서, 컬럼 추가 전에 있던 행은 NULL,
        # DB 기본값도 없었다. NULL 인 행만 채우므로 매 기동 돌아도 안전(LDAP 계정은 "ldap" 이 들어 있다).
        "UPDATE users SET auth_source = 'local' WHERE auth_source IS NULL",
        "ALTER TABLE users ALTER COLUMN auth_source SET DEFAULT 'local'",
        "UPDATE mail_accounts SET protocol = 'imap' WHERE protocol IS NULL",
        "ALTER TABLE mail_accounts ALTER COLUMN protocol SET DEFAULT 'imap'",
    ]
    # 문장마다 세이브포인트 — PostgreSQL 은 한 문장이 실패하면 트랜잭션이 abort 되어,
    # 예전처럼 한 트랜잭션에서 except: pass 로 넘기면 그 뒤 문장이 전부 조용히 실패했다.
    async with engine.begin() as conn:
        for sql in migrations:
            try:
                async with conn.begin_nested():
                    await conn.execute(text(sql))
            except Exception as e:
                print(f"[DB] legacy migration 건너뜀: {sql[:80]}… — {str(e).splitlines()[0][:160]}")


# 채팅 마이그레이션용 advisory lock 키. 임의의 고정 상수 — 다른 락과 겹치지만 않으면 된다.
_CHAT_MIGRATION_LOCK_KEY = 7314001


async def _run_chat_seq_migration():
    """R-16 메시지 전역 순번 — 시퀀스 생성·기존 행 백필·DEFAULT/NOT NULL·인덱스.

    세 가지를 보장해야 한다.
    - 멱등: 매 기동마다 돌아도 두 번째부터는 사실상 no-op (NULL 행이 없으면 백필 생략).
    - 동시 기동 안전: 워커 8개가 함께 올라오므로 트랜잭션 범위 advisory lock 으로
      한 워커만 들어오고, 나머지는 그 커밋을 기다렸다가 "할 게 없음"을 확인한다.
    - 순서 보존: 백필은 created_at, id 순으로 row_number 를 매긴다. 백필 중 구버전
      워커가 끼어들어 NULL seq 행을 만들지 못하게 messages 테이블에 쓰기 락을 건다
      (읽기는 막지 않는다; 수만 건이면 수 초 안에 끝난다).
    """
    if engine.dialect.name != "postgresql":
        return

    async with engine.begin() as conn:
        await conn.execute(text(f"SELECT pg_advisory_xact_lock({_CHAT_MIGRATION_LOCK_KEY})"))

        await conn.execute(text("CREATE SEQUENCE IF NOT EXISTS messages_seq_seq AS BIGINT"))
        # 테이블이 지워지면 시퀀스도 같이 — 이름 충돌·고아 방지
        await conn.execute(text("ALTER SEQUENCE messages_seq_seq OWNED BY messages.seq"))

        has_null = (
            await conn.execute(text("SELECT EXISTS (SELECT 1 FROM messages WHERE seq IS NULL)"))
        ).scalar()
        if has_null:
            await conn.execute(text("LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE"))
            # 이미 seq 를 받은 행(롤링 재시작 중 신버전이 먼저 넣은 것)이 있으면 그 뒤에 붙인다.
            res = await conn.execute(text(
                "UPDATE messages m SET seq = s.rn + base.mx "
                "FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn "
                "      FROM messages WHERE seq IS NULL) s, "
                "     (SELECT coalesce(max(seq), 0) AS mx FROM messages) base "
                "WHERE m.id = s.id"
            ))
            print(f"[DB] chat-migrate: messages.seq 백필 {res.rowcount}행")

        # 시퀀스 현재값을 max(seq) 에 맞춘다. 비어 있으면 다음 nextval 이 1 이 되게 is_called=false.
        await conn.execute(text(
            "SELECT setval('messages_seq_seq', "
            "  GREATEST(coalesce((SELECT max(seq) FROM messages), 0), 1), "
            "  (SELECT max(seq) FROM messages) IS NOT NULL)"
        ))
        # ORM 을 거치지 않는 INSERT(구버전 워커·수동 SQL)도 seq 를 받도록 DB 기본값으로 박는다.
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

        # ── R-13 읽음 포인터·채널 메타 백필 (seq 가 전부 채워진 뒤에만 의미가 있다) ──
        # 기존 last_read_message_id → 그 메시지의 seq. NULL 인 것만 건드리니 멱등.
        res = await conn.execute(text(
            "UPDATE channel_members cm SET last_read_seq = m.seq "
            "FROM messages m "
            "WHERE m.id = cm.last_read_message_id AND cm.last_read_seq IS NULL"
        ))
        if res.rowcount:
            print(f"[DB] chat-migrate: channel_members.last_read_seq 백필 {res.rowcount}행")
        # 채널별 마지막 메시지(스레드 답글·삭제 제외) — 아직 안 채워진 채널만
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


async def _run_thread_follow_backfill():
    """스레드 팔로우 테이블이 비어 있을 때 한 번만 — 기존 스레드의 참여 이력을 팔로우로 옮긴다.

    예전 "내 스레드" 는 참여(원 글 작성·답글 작성)로 셌다. 팔로우 기반으로 바꾸면서 기존
    스레드가 목록에서 사라지지 않게 같은 집합을 thread_follows 로 넣는다. last_read_seq 는
    그 스레드의 마지막 답글 seq 로 두어 옛 스레드가 전부 미읽음으로 뜨지 않게 한다.
    테이블에 행이 하나라도 있으면 건너뛰므로 매 기동 돌아도 안전하다.
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


async def _run_search_trgm_migration():
    """R-14 검색 인덱스와 쿼리 일치 — 메시지·게시글 본문에 pg_trgm GIN.

    메시지 검색(chat/service.search_messages, search/router)과 게시판 검색은 전부
    `ILIKE '%q%'` 인데 인덱스는 to_tsvector 였다 → 인덱스를 전혀 안 탔다. 한국어는 형태소
    분석기 없이 tsvector 를 쓰면 부분일치가 안 되므로 ILIKE 를 유지하고 trigram 으로
    받친다(files/search.py 와 같은 선택). 확장을 못 만들면(권한) 경고만 남기고 건너뛴다 —
    검색이 느려질 뿐 틀리진 않는다.

    예전 모델이 선언하던 to_tsvector 인덱스(ix_messages_fulltext, ix_posts_fulltext)는 어떤
    쿼리도 쓰지 않으면서 INSERT 마다 GIN 갱신 비용만 냈다 — 모델에서 뺐고, 그 버전으로
    새로 설치해 남아 있는 곳은 여기서 지운다(IF EXISTS, 데이터와 무관).
    """
    if engine.dialect.name != "postgresql":
        return
    for name in ("ix_messages_fulltext", "ix_posts_fulltext"):
        try:
            async with engine.begin() as conn:
                await conn.execute(text(f"DROP INDEX IF EXISTS {name}"))
        except Exception as e:
            print(f"[DB] WARN: 안 쓰는 인덱스 {name} 삭제 실패 — {e}")
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
            return

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


async def _run_chat_roles_migration():
    """P1-1 역할·권한 — @everyone 시드, 기본 카테고리 3개 시드+백필(한 번), channels.category_id FK.

    - @everyone: is_default 행이 없을 때만 만든다(권한 = permissions.DEFAULT_EVERYONE = 지금 동작).
      이미 있으면 손대지 않는다 — 관리자가 바꾼 기본 권한을 기동 때마다 되돌리면 안 된다.
    - 카테고리: system_settings 'chat.categories_seeded' 표시가 없을 때 한 번만 "채널"·"음성"·"보관"을 만들고
      DM 이 아닌 채널의 category_id 가 비었으면 채운다(보관 → 보관, 음성 → 음성, 나머지 → 채널).
      표시를 남기므로 관리자가 카테고리를 다 지워도 다시 생기지 않는다.
    - FK: auto-migrate 는 컬럼만 더한다 → ON DELETE SET NULL FK 를 NOT VALID 로(이미 있으면 건너뜀).
    워커 8개 동시 기동 — init_db 세션 락 안에서 돌고, 여기서도 트랜잭션 advisory lock 을 한 번 더 잡는다.
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


async def _run_chat22_migration():
    """chat22(디스코드 동등 P1) — auto-migrate 가 못 하는 것만. 전부 idempotent.

    - reactions.emoji VARCHAR(10) → VARCHAR(64): 커스텀 이모지 `:name:`. 이미 64 이상이면 건너뛴다
      (ALTER 가 짧은 ACCESS EXCLUSIVE 잠금 — varchar 넓히기는 테이블 재작성이 없어 무중단).
    - messages.reply_to_id 인덱스(새 컬럼은 Step 2 auto-migrate 가 더했다).
    워커 8개 — init_db 세션 락 안에서 돌고, 여기서도 트랜잭션 advisory lock 을 잡는다.
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


async def _run_chat_archive_category_migration():
    """보관 시스템 카테고리(시안 §2.1(3)) — system_settings 'chat.archive_category_id' 를 한 번 채운다.

    r24 시드(_run_chat_roles_migration)가 만든 '보관' 카테고리가 있으면 그것을 '보관된 프로젝트'로 바꿔 쓰고,
    없으면 새로 만든다. 키가 이미 있으면 아무것도 안 한다(관리자가 이름을 바꿔도 되돌리지 않는다).
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


# init_db 전체를 감싸는 세션 advisory lock 키 — 워커 8개가 동시에 create_all·ALTER 를 돌려
# PG 에 duplicate key(pg_type)·already exists 오류가 쏟아지던 것(L-7). 한 워커가 끝내면 나머지는 사실상 no-op.
_INIT_DB_LOCK_KEY = 0x6A77_1D80


@asynccontextmanager
async def _init_db_lock():
    """PostgreSQL 이면 init_db 동안 세션 advisory lock 을 잡는다(다른 DB 는 아무것도 안 함).

    잠금 연결은 끝까지 열어 두고, 끝나면 풀고 닫는다. 풀기에 실패하면 그 연결은 버린다
    (풀에 돌아가면 락을 쥔 채 남는다)."""
    if engine.dialect.name != "postgresql":
        yield
        return
    async with engine.connect() as conn:
        await conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": _INIT_DB_LOCK_KEY})
        await conn.commit()
        try:
            yield
        finally:
            try:
                await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _INIT_DB_LOCK_KEY})
                await conn.commit()
            except Exception:
                await conn.invalidate()


async def init_db():
    async with _init_db_lock():
        await _init_db_unlocked()


async def _init_db_unlocked():
    for attempt in range(5):
        try:
            # Step 1: create new tables
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)

            # Step 2: auto-migrate missing columns
            await _auto_migrate()

            # Step 3: legacy index migrations
            await _run_legacy_migrations()

            # Step 4: 채팅 seq 시퀀스·백필 (컬럼은 Step 2 가 이미 추가했다)
            await _run_chat_seq_migration()

            # Step 5: 검색용 trigram 인덱스 (실패해도 기동은 막지 않는다)
            await _run_search_trgm_migration()

            # Step 5b: 채팅 역할·카테고리 시드(P1-1). 실패하면 엔진은 상수 기본값으로 돈다 — 기동은 막지 않는다
            try:
                await _run_chat_roles_migration()
            except Exception as e:
                print(f"[DB] WARN: 채팅 역할 마이그레이션 실패 — {e}")

            # Step 5c: chat22 — reactions.emoji 넓히기·답장 인덱스, 보관 시스템 카테고리(5b 시드 뒤). 실패해도 기동은 계속
            try:
                await _run_chat22_migration()
                await _run_chat_archive_category_migration()
            except Exception as e:
                print(f"[DB] WARN: chat22 마이그레이션 실패 — {e}")

            # Step 6: 스레드 팔로우 백필 (비어 있을 때 한 번; 실패해도 기동은 막지 않는다)
            try:
                await _run_thread_follow_backfill()
            except Exception as e:
                print(f"[DB] WARN: thread_follows 백필 실패 — {e}")

            print(f"[DB] init_db 완료 (attempt {attempt + 1})")
            return
        except Exception as e:
            print(f"[DB] init_db 실패 (attempt {attempt + 1}): {e}")
            if attempt < 4:
                await asyncio.sleep(2)


async def get_db():
    async with async_session() as session:
        yield session
