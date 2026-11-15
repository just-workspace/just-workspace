import asyncio
import html
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from slowapi.errors import RateLimitExceeded
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.session import get_db, init_db
from app.rate_limit import DefaultRateLimitMiddleware, limiter
from app.middleware.access_log import AccessLogMiddleware, run_log_flusher, run_log_cleanup
from app.middleware.request_id import RequestIdMiddleware
from app.middleware.origin_check import CookieOriginGuard
from app.auth.router import router as auth_router
from app.auth.oauth_provider import router as oauth_router
from app.auth.devices_router import router as devices_router
from app.auth.me_sessions import router as me_sessions_router
from app.auth.me_security import router as me_security_router
from app.auth.two_factor import router as two_factor_router
from app.auth.recovery_email import router as recovery_email_router
from app.auth.internal_router import router as internal_router
from app.middleware.csp_report import router as csp_report_router
from app.middleware.client_error import router as client_error_router
from app.auth.oauth_provider import root_router as oauth_discovery_router
from app.auth.ldap_router import router as ldap_router
from app.services.router import router as services_router
from app.files.indexer import run_indexer
from app.services.health import run_health_checker
from app.files.router import router as files_router
from app.files.comments import router as file_comments_router   # 파일 댓글(p9)
from app.mail.router import router as mail_router
from app.mail.oauth import router as mail_oauth_router
from app.mail.client_setup import router as mail_client_setup_router, root_router as mail_autoconfig_router
from app.ai.router import router as ai_router
from app.ai.inline_router import router as ai_inline_router
from app.backup.router import router as backup_router
from app.groups.router import router as groups_router
from app.apps.router import router as apps_router
from app.admin.router import router as admin_router
from app.admin.users_ext import router as admin_users_ext_router
from app.admin.settings_ext import router as admin_settings_ext_router
from app.setup.router import router as setup_router
from app.git.router import router as git_router
from app.dashboard.router import router as dashboard_router
from app.dashboard.checklist import router as dashboard_checklist_router
from app.dashboard.cards import router as dashboard_cards_router
from app.dashboard.home import router as dashboard_home_router
from app.dashboard.briefing import router as dashboard_briefing_router
from app.mail.sender import router as mail_sender_router
from app.calendar.router import router as calendar_router
from app.contacts.router import router as contacts_router
from app.meetings.router import router as meetings_router
from app.meetings.calls import router as meeting_calls_router
from app.chat.router import router as chat_router
from app.chat.tabs import router as chat_tabs_router
from app.chat.roles import router as chat_roles_router
from app.chat.router22 import router as chat22_router
from app.chat.voice import router as chat_voice_router
from app.chat.websocket import router as chat_ws_router
from app.chat.voice_relay import router as chat_voice_relay_router
from app.chat.webhook import router as webhook_router
from app.modules.router import router as modules_router
from app.board.router import router as board_router
from app.tasks.router import router as tasks_router
from app.search.router import router as search_router
from app.dav.router import dav_app
from app.plugins.router import router as plugins_router
from app.push.router import router as push_router
from app.wiki.router import router as wiki_router
from app.wiki.collab import router as wiki_collab_router
from app.wopi.router import router as wopi_router
from app.wopi.share import router as wopi_share_router     # 새 문서 · 공유 링크로 같이 편집(OnlyOffice)
from app.notifications.router import router as notifications_router
from app.me.prefs import router as me_prefs_router
from app.privacy.router import router as privacy_router
from app.mcp.account_router import router as mcp_account_router
from app.mcp.approvals_router import router as approvals_router
from app.ai.artifacts_router import router as ai_artifacts_router
from app.mcp.usage_router import router as ai_usage_router
from app.ai.feedback_admin import router as ai_feedback_admin_router
from app.rbi.router import router as rbi_router
from app.rbi.site import RbiHostGuard, router as rbi_site_router

settings = get_settings()

APP_VERSION = "4.3.0"


def _install_log_redaction() -> None:
    """접근 로그에서 비밀 쿼리 파라미터를 가린다.

    WOPI 편집기는 access_token 을 쿼리로 달고 백엔드를 호출한다. uvicorn 접근 로그는
    경로를 통째로 찍으므로, 그대로 두면 유효한 토큰이 로그 파일과 `docker logs` 에
    평문으로 쌓인다. 로그를 볼 수 있는 사람이 곧 그 파일을 열 수 있게 되는 셈이다.
    """
    import logging
    import re

    pattern = re.compile(r"((?:access_token|token|code|password)=)[^&\s]+")

    class _Redact(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            try:
                if record.args and isinstance(record.args, tuple):
                    record.args = tuple(
                        pattern.sub(r"<redacted>", a) if isinstance(a, str) else a
                        for a in record.args
                    )
                if isinstance(record.msg, str):
                    record.msg = pattern.sub(r"<redacted>", record.msg)
            except Exception:
                pass
            return True

    for name in ("uvicorn.access", "uvicorn.error"):
        logging.getLogger(name).addFilter(_Redact())


_install_log_redaction()

_health_task = None
_file_index_task = None
_log_flusher_task = None
_log_cleanup_task = None
_reminder_task = None
_mail_poll_task = None
_backup_task = None
_call_state_task = None
_retention_task = None
# p4 콘텐츠 보강에서 추가한 백그라운드 작업(예약 메일 발송 등)
_extra_tasks: list = []


async def _reminder_loop():
    """Periodically check for calendar event reminders (every 60s).

    워커 8개가 같은 초에 깨어나 같은 미발송 일정을 읽으면 알림이 8번 간다
    (`check_and_send_reminders` 는 SELECT → 알림 생성 → reminder_sent 갱신이라
    조건부 UPDATE 로 막혀 있지 않다). 한 주기에 한 워커만 돈다.
    """
    import logging
    _logger = logging.getLogger(__name__)
    from app.db.session import async_session as _async_session
    from app.calendar.reminder import check_and_send_reminders
    from app.jobs.lock import try_acquire

    while True:
        try:
            if await try_acquire("calendar:reminder", ttl=55):
                async with _async_session() as db:
                    sent = await check_and_send_reminders(db)
                    if sent:
                        _logger.info("Sent %d calendar reminder(s)", sent)
        except Exception as e:
            _logger.error("Reminder check failed: %s", e)
        await asyncio.sleep(60)


async def _calendar_subscription_loop():
    """외부 캘린더 구독(.ics)을 6시간마다 새로 받는다 — 10분마다 깨어 때가 된 것만, 한 워커만."""
    import logging
    _logger = logging.getLogger(__name__)
    from app.db.session import async_session as _async_session
    from app.calendar.subscriptions import refresh_due
    from app.jobs.lock import try_acquire

    await asyncio.sleep(30)
    while True:
        try:
            if await try_acquire("calendar:subscriptions", ttl=540):
                n = await refresh_due(_async_session)
                if n:
                    _logger.info("Refreshed %d calendar subscription(s)", n)
        except Exception as e:
            _logger.error("Calendar subscription refresh failed: %s", e)
        await asyncio.sleep(600)


async def _backup_loop():
    """예약 백업 — enabled + 지정 시각(UTC)에 하루 1회 실행 + 보존정책 적용."""
    import logging
    from datetime import datetime, timezone
    from sqlalchemy import select
    _logger = logging.getLogger(__name__)
    from app.db.session import async_session as _s
    from app.backup.router import get_schedule
    from app.backup import service as bsvc
    from app.backup.models import BackupRecord
    from app.jobs.lock import try_acquire

    await asyncio.sleep(60)
    while True:
        try:
            # ran_today 검사는 커밋 전 경합에 약하다 — 워커 둘이 같은 시각에 들어오면
            # 백업이 두 번 돈다. 락 TTL 은 백업 소요시간을 덮도록 주기와 비슷하게.
            if not await try_acquire("backup:scheduled", ttl=1700):
                await asyncio.sleep(1800)
                continue
            async with _s() as db:
                cfg = await get_schedule(db)
                now = datetime.now(timezone.utc)
                if cfg["enabled"] and now.hour == cfg["hour_utc"]:
                    rows = (await db.execute(
                        select(BackupRecord).where(BackupRecord.kind == "scheduled")
                    )).scalars().all()
                    ran_today = any(r.created_at and r.created_at.date() == now.date() for r in rows)
                    if not ran_today:
                        _logger.info("[backup] scheduled run starting")
                        await bsvc.run_backup(db, kind="scheduled")
                        removed = await bsvc.apply_retention(db, cfg["retention_days"])
                        if removed:
                            _logger.info("[backup] retention removed %d", removed)
        except Exception as e:
            _logger.error("Scheduled backup check failed: %s", e)
        await asyncio.sleep(1800)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _file_index_task
    global _health_task, _log_flusher_task, _log_cleanup_task, _reminder_task, _mail_poll_task, _backup_task, _call_state_task, _retention_task

    from app.chat.redis_client import get_redis, close_redis

    # Validate secret_key is not the default
    if settings.secret_key == "CHANGE_ME" and not settings.debug:
        raise RuntimeError(
            "FATAL: secret_key is set to the default 'CHANGE_ME'. "
            "Set a secure SECRET_KEY in .env before running in production."
        )

    await init_db()

    # Auto-seed admin if ADMIN_USERNAME + ADMIN_PASSWORD are set
    admin_user = os.environ.get("ADMIN_USERNAME")
    admin_pass = os.environ.get("ADMIN_PASSWORD")
    if admin_user and admin_pass:
        from app.cli import seed_admin
        await seed_admin(admin_user, admin_pass)

    # Load module states from DB
    from app.modules.registry import load_module_states
    from app.db.session import async_session
    async with async_session() as db:
        await load_module_states(db)

    # Load plugins from /plugins directory
    from app.plugins.loader import load_plugins
    await load_plugins(app)

    # Reload module states to include plugin defaults
    async with async_session() as db:
        await load_module_states(db)

    # Load RBAC module grants (group → module access)
    from app.groups.service import load_grants
    async with async_session() as db:
        await load_grants(db)

    # Mount MCP endpoints for external clients (claude.ai connector, Claude
    # Desktop, Cursor, etc.): Streamable HTTP (primary) + legacy SSE.
    try:
        from app.mcp.http_server import mount_mcp_http
        await mount_mcp_http(app)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("[MCP] Streamable HTTP mount failed: %s", e)
    try:
        from app.mcp.sse_server import mount_mcp
        mount_mcp(app)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("[MCP] SSE mount failed: %s", e)

    await get_redis()  # init Redis connection pool
    _health_task = asyncio.create_task(run_health_checker())
    # 파일 검색 색인 — 주기적으로 저장소를 훑어 이름·본문을 쌓는다
    _file_index_task = asyncio.create_task(run_indexer())
    _log_flusher_task = asyncio.create_task(run_log_flusher())
    _log_cleanup_task = asyncio.create_task(run_log_cleanup())
    _reminder_task = asyncio.create_task(_reminder_loop())
    # 메일 인박스 폴러(새 메일 → Redis `mail:new` 이벤트, AI 소비자용)
    from app.mail.poller import run_poller
    _mail_poll_task = asyncio.create_task(run_poller())
    _backup_task = asyncio.create_task(_backup_loop())
    # 채널 통화 상태 대조(웹훅 누락 보정)
    from app.meetings.calls import run_call_state_loop
    _call_state_task = asyncio.create_task(run_call_state_loop())
    # 버전·휴지통·업로드 세션 만료 정리(한 워커만, app/files/retention.py)
    from app.files.retention import run_retention
    _retention_task = asyncio.create_task(run_retention())
    # 예약 메일 발송(한 워커만 — Redis 락, app/mail/scheduled.py)
    from app.mail.scheduled import run_scheduled_sender
    _extra_tasks.append(asyncio.create_task(run_scheduled_sender()))
    # 외부 캘린더 구독(.ics) 6시간 갱신(한 워커만)
    _extra_tasks.append(asyncio.create_task(_calendar_subscription_loop()))
    # 격리 브라우저 세션 거두기(끝난 컨테이너·유휴·최대 수명·고아) — 한 워커만, app/rbi/service.py
    from app.rbi.service import run_reaper as _rbi_reaper
    _extra_tasks.append(asyncio.create_task(_rbi_reaper()))
    # AI 감사 기록 보관(1·2·3년)·피드백 스냅샷 90일 정리(한 워커만, app/ai/ops_retention.py)
    from app.ai.ops_retention import run_ai_retention
    _extra_tasks.append(asyncio.create_task(run_ai_retention()))
    print(f"[STARTUP] {settings.app_name} started")

    yield

    # Flush remaining access logs before shutdown
    from app.middleware.access_log import _flush_buffer
    await _flush_buffer()

    # 진행 중인 내장 AI 답변 — 받은 부분까지 interrupted 로 저장(/continue 로 이어 받기). Redis 닫기 전에.
    try:
        from app.ai import runs as _ai_runs
        await _ai_runs.shutdown()
    except Exception:
        pass

    # Tear down the MCP Streamable HTTP session manager task group.
    try:
        from app.mcp.http_server import unmount_mcp_http
        await unmount_mcp_http(app)
    except Exception:
        pass

    for task in _extra_tasks:
        task.cancel()
    for task in (_file_index_task, _health_task, _log_flusher_task, _log_cleanup_task, _reminder_task, _mail_poll_task, _backup_task, _call_state_task, _retention_task):
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    await close_redis()


app = FastAPI(
    title=settings.app_name,
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url="/api/docs" if settings.debug else None,
    redoc_url=None,
)

# CORS — same-origin(웹/SSR) + 번들 SPA 앱 출처(Tauri/Capacitor, Bearer 토큰 인증)
_cors_origins = [settings.app_url]
if settings.debug:
    _cors_origins += ["http://localhost:3000", "http://localhost:8000"]
# 네이티브 앱 셸 출처(데스크탑/모바일 번들 SPA가 cross-origin으로 /api 호출).
# allow_credentials=True 와 함께 쓰이므로 허용목록이 곧 신뢰 경계다.
# http(s)://localhost 는 Capacitor 안드로이드의 실제 출처라 뺄 수 없지만,
# 앱을 배포하지 않는 설치본에서는 ALLOW_NATIVE_APP_ORIGINS=false 로 좁힐 수 있다.
if settings.allow_native_app_origins:
    _cors_origins += [
        "tauri://localhost", "http://tauri.localhost",          # Tauri (mac/linux, windows)
        "capacitor://localhost", "http://localhost", "https://localhost",  # Capacitor (ios/android)
    ]

# 격리 브라우저 전용 출처(Host = RBI_PUBLIC_ORIGIN)로 온 요청은 /api/rbi/* · nginx 내부 인증 말고 404(ws-nginx 와 이중)
app.add_middleware(RbiHostGuard)
# 세션 쿠키로 인증된 상태 변경 요청의 출처 검사(CSRF) — 레이트리밋 안쪽이라 거부된 요청도 한도에 잡히고,
# 접속 로그(더 바깥)에 403 으로 남는다. 허용 출처는 CORS 목록과 같은 것을 쓴다(CSRF_ORIGIN_CHECK=false 로 끔)
app.add_middleware(CookieOriginGuard, allowed_origins=_cors_origins)
# 기본 레이트리밋(데코레이터 없는 /api·/oauth 라우트) — CORS 안쪽이라 429 에도 CORS 헤더가 붙는다
app.add_middleware(DefaultRateLimitMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

app.add_middleware(AccessLogMiddleware)
# 요청 번호 — 가장 바깥(마지막에 추가)이라 처리 안 된 예외도 여기서 500 JSON + 번호로 바뀐다
app.add_middleware(RequestIdMiddleware)

app.state.limiter = limiter


@app.exception_handler(RequestValidationError)
async def _validation_handler(request: Request, exc: RequestValidationError):
    """422 응답에서 입력값을 제거한다.

    Pydantic v2 는 검증에 실패한 값을 err["input"] 에 담아 보내고, FastAPI 기본
    핸들러가 그걸 그대로 응답에 싣는다. 비밀번호 정책 위반 시 평문 비밀번호가
    응답 본문에 노출된다(2026-08-27 확인). 위치(loc)와 사유(msg)만 남긴다.
    """
    safe = [
        {"type": e.get("type"), "loc": e.get("loc"), "msg": e.get("msg")}
        for e in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": safe})


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Please try again later."},
    )

# Mount DAV sub-application (PROPFIND/REPORT via raw ASGI)
app.mount("/dav", dav_app)

app.include_router(modules_router)
app.include_router(auth_router)
app.include_router(devices_router)     # 기기 등록·해지 (데스크톱 클라이언트)
app.include_router(me_sessions_router)  # 내 로그인 기기(세션) 목록·끊기
app.include_router(me_security_router)  # 내 연결된 앱(OAuth)·앱 비밀번호
app.include_router(two_factor_router)   # 2단계 인증 상태·복구 코드
app.include_router(recovery_email_router)  # 복구 이메일 변경(본인 확인 → 새 주소 인증 → 옛 주소 알림)
app.include_router(internal_router)    # 내부 서비스 전용(도커망 한정, 키 필요)
app.include_router(csp_report_router)  # CSP Report-Only 위반 수집
app.include_router(client_error_router)  # 화면 쪽 오류(오류 화면 요청 번호) 수집
app.include_router(oauth_router)
app.include_router(oauth_discovery_router)  # root-level .well-known discovery (§1-1, §1-2)
app.include_router(ldap_router)
app.include_router(services_router)
app.include_router(files_router)
app.include_router(file_comments_router)
app.include_router(mail_router)
app.include_router(mail_oauth_router)
app.include_router(mail_client_setup_router)  # 외부 메일 앱 안내·애플 구성 프로필
app.include_router(mail_autoconfig_router)    # autoconfig·autodiscover(루트 경로)
app.include_router(ai_inline_router)  # 화면 안 AI(메일·채팅·회의·문서, S7)
app.include_router(ai_router)
app.include_router(backup_router)
app.include_router(groups_router)
app.include_router(apps_router)
app.include_router(admin_router)
app.include_router(admin_users_ext_router)  # 관리 사용자 일괄·삭제·초대·운영 요약
app.include_router(admin_settings_ext_router)  # 관리 로그인 보호 정책·저장소 요약·사용자 할당
app.include_router(setup_router)
app.include_router(git_router)
app.include_router(dashboard_router)
app.include_router(dashboard_checklist_router)  # 시작 체크리스트
app.include_router(mail_sender_router)  # 메일 보낸 사람 카드(오른쪽 상세 패널)
app.include_router(dashboard_cards_router)  # 큰 화면 대시보드 카드(자주 쓰는 채널 · 최근 위키)
app.include_router(dashboard_home_router)  # 홈(handover 17): 이어서 하기 · 팀 · 내 저장 공간
app.include_router(dashboard_briefing_router)  # 홈 AI 브리핑 "오늘의 포커스"(옵트인)
app.include_router(calendar_router)
app.include_router(contacts_router)
app.include_router(meetings_router)
app.include_router(meeting_calls_router)
app.include_router(chat_router)
app.include_router(chat_tabs_router)   # 채널 탭(파일·위키·회의·작업)
app.include_router(chat_roles_router)  # 역할·권한·카테고리(P1-1)
app.include_router(chat22_router)  # 디스코드 동등 P1 — 첨부 묶음·스레드·이모지·검색·프로필·정책(chat22)
app.include_router(chat_voice_router)  # 음성 채널(토큰·접속 상태, handover-20)
app.include_router(chat_ws_router)
app.include_router(chat_voice_relay_router)  # 음성채널 무손실 티어 — 릴레이 토큰
app.include_router(webhook_router)
app.include_router(board_router)
app.include_router(tasks_router)
app.include_router(search_router)
app.include_router(plugins_router)
app.include_router(push_router)
app.include_router(wiki_router)
app.include_router(wiki_collab_router)
app.include_router(wopi_router)
app.include_router(wopi_share_router)
app.include_router(notifications_router)
app.include_router(me_prefs_router)      # 개인 설정 서버 저장 (/api/me/prefs)
app.include_router(privacy_router)
# MCP connector management (PATs + OAuth connections) for the profile "AI 연동"
# page. Prefix /api/ai-connect is OUTSIDE /api/mcp so it is never shadowed by the
# MCP Streamable-HTTP Mount("/api/mcp", …) added during lifespan startup.
app.include_router(mcp_account_router)
app.include_router(ai_usage_router)     # 관리자 › AI 운영(사용량·감사, S2)
app.include_router(ai_feedback_admin_router)  # 관리자 › AI 운영 › 피드백(시안 I1·I2)
app.include_router(approvals_router)   # AI 쓰기 승인 대기함·채팅 승인 카드(S3)
app.include_router(ai_artifacts_router)  # AI 결과물(문서·묶음·파일 압축·만료 링크, S4)
app.include_router(rbi_router)           # 격리 브라우저(RBI) — 세션·대상·nginx auth_request(/api/internal/rbi/auth)
app.include_router(rbi_site_router)      # 격리 브라우저 전용 출처 — SSO 홉(/rbi-login → /auth/callback)·rbi 세션


# ── .well-known CalDAV/CardDAV discovery ──

@app.get("/.well-known/caldav")
async def well_known_caldav():
    return RedirectResponse(url="/dav/", status_code=301)


@app.get("/.well-known/carddav")
async def well_known_carddav():
    return RedirectResponse(url="/dav/", status_code=301)


@app.get("/.well-known/workspace.json")
async def well_known_workspace(db: AsyncSession = Depends(get_db)):
    """Client auto-discovery endpoint — returns server connection info."""
    from app.admin.settings import get_settings_by_prefix

    db_vals = await get_settings_by_prefix(db, "branding.")
    site_name = db_vals.get("branding.site_name") or settings.app_name
    logo = db_vals.get("branding.logo_url") or settings.brand_logo

    return {
        "api": f"{settings.app_url}/api",
        "ws": f"{settings.app_url.replace('http', 'ws')}/ws",
        "name": site_name,
        "logo": f"{settings.app_url}{logo}" if logo and not logo.startswith("http") else logo,
        "domain": settings.domain,
        "version": APP_VERSION,
    }


# ── 앱 다운로드 (모바일 APK + QR + 안내) ──

def _apk_path() -> Path:
    return Path(settings.storage_root) / "apps" / "workspace-android.apk"


def _desktop_path() -> Path:
    return Path(settings.storage_root) / "apps" / "workspace-desktop-setup.exe"


@app.get("/api/apps/android")
async def app_android():
    p = _apk_path()
    if not p.is_file():
        raise HTTPException(status_code=404, detail="APK가 아직 업로드되지 않았습니다")
    return FileResponse(
        str(p), media_type="application/vnd.android.package-archive",
        filename="JustWorkspace.apk",
    )


@app.get("/api/apps/desktop")
async def app_desktop():
    p = _desktop_path()
    if not p.is_file():
        raise HTTPException(status_code=404, detail="데스크탑 설치파일이 아직 업로드되지 않았습니다")
    return FileResponse(
        str(p), media_type="application/octet-stream",
        filename="JustWorkspace-setup.exe",
    )


@app.get("/api/apps/android.qr")
async def app_android_qr():
    import io
    import qrcode
    url = f"{settings.app_url.rstrip('/')}/api/apps/android"
    buf = io.BytesIO()
    qrcode.make(url).save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@app.get("/api/apps", response_class=HTMLResponse)
async def app_landing():
    has_apk = _apk_path().is_file()
    has_desktop = _desktop_path().is_file()
    apk_block = (
        '<img src="/api/apps/android.qr" width="200" height="200" alt="QR" />'
        '<br><a class="btn" href="/api/apps/android">📱 Android APK 다운로드</a>'
        if has_apk else
        '<p class="s">Android APK가 아직 준비되지 않았습니다.</p>'
    )
    desktop_block = (
        '<br><a class="btn" href="/api/apps/desktop">🖥 Windows 데스크탑 앱 다운로드</a>'
        if has_desktop else
        '<p class="s">🖥 데스크탑: 브라우저 주소창의 <b>앱 설치</b> 아이콘으로 설치형 사용.</p>'
    )
    # NetLab 외부 콘솔 도우미 — 파일은 NetLab 출처가 서빙한다(netlab/helper, /downloads/). 주소가 설정됐을 때만
    netlab = settings.netlab_url.rstrip('/')
    netlab_block = (
        f'<p class="s">🧪 NetLab 콘솔 도우미: 랩 노드 콘솔을 PuTTY·SecureCRT·MobaXterm·Windows Terminal 로 바로 엽니다. '
        f'관리자 권한 없이 설치, 서명 없는 파일이라 SmartScreen 이 뜨면 <b>추가 정보 → 실행</b>.</p>'
        f'<a class="btn" href="{html.escape(netlab)}/downloads/netlab-console-setup.exe">🧪 NetLab 콘솔 도우미 (Windows)</a>'
        f'<p class="s"><a href="{html.escape(netlab)}/downloads/netlab-console-setup.exe.sha256" style="color:#9ab">SHA-256</a></p>'
        if netlab.startswith('https://') else ''
    )
    return HTMLResponse(f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>앱 다운로드</title>
<style>body{{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0c;color:#eee;text-align:center;padding:48px 16px;margin:0}}
h2{{margin:0 0 8px}} .s{{opacity:.6;font-size:14px;max-width:360px;margin:10px auto;line-height:1.5}}
a.btn{{display:inline-block;margin-top:14px;padding:14px 24px;background:#3b82f6;color:#fff;border-radius:10px;text-decoration:none;font-size:16px}}
img{{margin:22px auto;display:block;background:#fff;padding:10px;border-radius:12px}}</style></head>
<body><h2>Just Workspace 앱</h2>
<p class="s">📱 안드로이드: QR 스캔 또는 버튼으로 APK 받기. 설치 시 "출처를 알 수 없는 앱" 1회 허용.</p>
{apk_block}
<p class="s">🍎 iOS: Safari로 이 워크스페이스를 열고 <b>공유 → 홈 화면에 추가</b> (PWA 설치).</p>
{desktop_block}
<p class="s">🖥 Windows 앱은 트레이 상주형 — 닫아도 백그라운드 유지하며 알림을 띄웁니다.</p>
{netlab_block}
</body></html>""")


def _public_netlab_url() -> str:
    """설정된 NetLab 주소를 공개용으로 — https:// 로 시작할 때만, 끝 / 제거. 아니면 빈값."""
    url = (settings.netlab_url or "").strip().rstrip("/")
    return url if url.startswith("https://") else ""


@app.get("/api/health")
async def health_check(db: AsyncSession = Depends(get_db)):
    from app.admin.settings import get_settings_by_prefix

    db_vals = await get_settings_by_prefix(db, "branding.")
    gen_vals = await get_settings_by_prefix(db, "general.")
    auth_vals = await get_settings_by_prefix(db, "auth.")
    # 디자인 대개편용 확장 앱설정 — appcfg.<group>.<key> (예: appcfg.dash.cards).
    # 공개(비인증)로 노출: 로그인·셸·대시보드·빈상태가 렌더에 필요. 프리픽스 제거해 반환.
    appcfg = {
        k[len("appcfg."):]: v
        for k, v in (await get_settings_by_prefix(db, "appcfg.")).items()
    }

    return {
        "status": "ok",
        "service": db_vals.get("branding.site_name") or settings.app_name,
        "version": APP_VERSION,
        "domain": settings.domain,
        "app_url": settings.app_url,
        "gitea_url": settings.gitea_external_url or f"{settings.app_url}/git/",
        "brand_logo": db_vals.get("branding.logo_url") or settings.brand_logo,
        "brand_color": db_vals.get("branding.primary_color") or settings.brand_color,
        "default_theme": db_vals.get("branding.default_theme") or "system",
        "favicon": db_vals.get("branding.favicon_url") or "",
        "registration_mode": auth_vals.get("auth.registration_mode") or "approval",
        "announcement": gen_vals.get("general.announcement") or "",
        "announcement_type": gen_vals.get("general.announcement_type") or "info",
        "git_visibility": gen_vals.get("general.git_visibility") or "private",
        "demo_mode": settings.demo_mode,
        # NetLab(별도 출처 랩) 주소 — 레일 '도구' 항목·대시보드 카드가 새 탭으로 연다. https 만(아니면 빈값 → 둘 다 숨김)
        "netlab_url": _public_netlab_url(),
        "config": appcfg,
    }


@app.get("/api/branding/favicon")
async def serve_favicon():
    """Serve uploaded favicon (no auth required)."""
    favicon_dir = Path(settings.storage_root) / "branding"
    if favicon_dir.is_dir():
        for f in favicon_dir.iterdir():
            if f.name.startswith("favicon.") and f.is_file():
                media_map = {
                    ".ico": "image/x-icon",
                    ".png": "image/png",
                    ".svg": "image/svg+xml",
                }
                media = media_map.get(f.suffix.lower(), "image/x-icon")
                return FileResponse(str(f), media_type=media)
    raise HTTPException(status_code=404, detail="Favicon not found")


_WP_MEDIA = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm",
}


@app.get("/api/branding/wallpapers")
async def list_wallpapers():
    """공개: 업로드된 로그인 배경 목록(이미지/영상). 프론트가 접속마다 랜덤 선택."""
    wp_dir = Path(settings.storage_root) / "branding"
    out = []
    if wp_dir.is_dir():
        for f in sorted(wp_dir.iterdir(), key=lambda x: x.name):
            if f.is_file() and f.name.startswith("wallpaper") and f.suffix.lower() in _WP_MEDIA:
                out.append({
                    "url": f"/api/branding/wallpaper/{f.name}",
                    "type": "video" if f.suffix.lower() in (".mp4", ".webm") else "image",
                })
    return {"wallpapers": out}


@app.get("/api/branding/wallpaper/{name}")
async def serve_wallpaper_named(name: str):
    """공개: 이름별 배경 서빙(경로 트래버설 차단)."""
    if "/" in name or "\\" in name or ".." in name or not name.startswith("wallpaper"):
        raise HTTPException(status_code=404, detail="Not found")
    f = Path(settings.storage_root) / "branding" / name
    if f.is_file() and f.suffix.lower() in _WP_MEDIA:
        return FileResponse(str(f), media_type=_WP_MEDIA[f.suffix.lower()])
    raise HTTPException(status_code=404, detail="Wallpaper not found")


@app.get("/api/branding/wallpaper")
async def serve_wallpaper():
    """Serve first uploaded wallpaper (back-compat, no auth)."""
    wp_dir = Path(settings.storage_root) / "branding"
    if wp_dir.is_dir():
        for f in sorted(wp_dir.iterdir(), key=lambda x: x.name):
            if f.name.startswith("wallpaper") and f.is_file() and f.suffix.lower() in _WP_MEDIA:
                return FileResponse(str(f), media_type=_WP_MEDIA[f.suffix.lower()])
    raise HTTPException(status_code=404, detail="Wallpaper not found")


@app.get("/api/branding/logo")
async def serve_logo():
    """Serve uploaded branding logo (no auth required)."""
    logo_dir = Path(settings.storage_root) / "branding"
    if logo_dir.is_dir():
        for f in logo_dir.iterdir():
            if f.name.startswith("logo.") and f.is_file():
                media_map = {
                    ".png": "image/png",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".svg": "image/svg+xml",
                    ".webp": "image/webp",
                }
                media = media_map.get(f.suffix.lower(), "application/octet-stream")
                return FileResponse(str(f), media_type=media)
    raise HTTPException(status_code=404, detail="Logo not found")
