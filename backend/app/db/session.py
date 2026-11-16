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
# 채팅 권한 엔진이 group_members 를 조회한다(관리되는 역할) — app.main 을 거치지 않는 경로에서도 테이블이 생성되도록 import
import app.groups.models  # noqa: F401,E402
# 내장 AI 대화·메시지·피드백(ai_message_feedback)·프로젝트·메모리·첨부 — init_db 단독 실행에서도 테이블이 생성되도록 import
import app.ai.models  # noqa: F401,E402
import app.ai.artifact_models  # noqa: F401,E402  — 결과물(ai_artifacts·ai_artifact_jobs)

settings = get_settings()
engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=True,
    pool_recycle=300,
)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


# ── 스키마 ──
# 스키마 생성·변경은 app/db/migrate.py(버전 기록·잠금·변경 단계)가 수행한다.
# 기준선(버전 1) 보정은 app/db/baseline.py, 이후 변경은 app/db/migrations.py 가 담당한다.


async def init_db(*, verify: bool = False) -> int:
    """서버 기동 시 호출 — DB 스키마를 코드가 요구하는 버전에 맞춘다.

    맞출 수 없으면(적용 실패, DB 가 코드보다 신규 버전, 자동 적용이 비활성화된 상태에서 버전이 낮음) 예외를 발생시킨다.
    예외를 무시하지 않는다 — 부분 적용된 스키마로 서버가 기동해서는 안 된다.
    """
    from app.db.migrate import ensure_schema

    return await ensure_schema(engine, verify=verify)


async def get_db():
    async with async_session() as session:
        yield session
