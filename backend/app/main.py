import asyncio
import html
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from slowapi.errors import RateLimitExceeded
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.session import get_db, init_db
from app.rate_limit import DefaultRateLimitMiddleware, limiter
from app.middleware.access_log import AccessLogMiddleware
from app.middleware.request_id import RequestIdMiddleware
from app.middleware.origin_check import CookieOriginGuard
from app import zones
# 스키마는 구역과 무관하게 동일하다. 라우터를 등록하지 않는 구역의 테이블도 메타데이터에 등록한다
# (나머지 모델은 app.db.session 이 등록한다). 이후 구역을 추가해도 테이블이 이미 존재한다.
from app.backup import models as _backup_models  # noqa: F401
from app.dashboard import models as _dashboard_models  # noqa: F401
from app.rbi import models as _rbi_models  # noqa: F401

settings = get_settings()

from app.version import APP_VERSION  # noqa: E402,F401 — 단일 출처는 리포 루트 VERSION (app/version.py)


def _install_log_redaction() -> None:
    """접근 로그에서 비밀 쿼리 파라미터를 마스킹한다.

    WOPI 편집기는 access_token 을 쿼리에 포함해 백엔드를 호출한다. uvicorn 접근 로그는
    경로 전체를 기록하므로, 미처리 시 유효한 토큰이 로그 파일과 `docker logs` 에
    평문으로 누적된다. 로그 열람 권한이 곧 해당 파일의 열람 권한이 된다.
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

# lifespan 이 기동한 백그라운드 루프(설치된 구역 한정 — app/zones.py 의 LOOPS)
_tasks: list = []


async def _reminder_loop():
    """Periodically check for calendar event reminders (every 60s).

    워커 8개가 동일 시각에 기동해 동일한 미발송 일정을 조회하면 알림이 8회 발송된다
    (`check_and_send_reminders` 는 SELECT → 알림 생성 → reminder_sent 갱신 순서이며
    조건부 UPDATE 로 보호되지 않는다). 한 주기에 한 워커만 수행한다.
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
    """외부 캘린더 구독(.ics)을 6시간마다 갱신한다 — 10분 주기로 기동해 갱신 시점이 도래한 항목만, 한 워커만 수행."""
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
            # ran_today 검사는 커밋 전 경합에 취약하다. 워커 둘이 동일 시각에 진입하면
            # 백업이 2회 실행된다. 락 TTL 은 백업 소요 시간을 포괄하도록 주기와 유사하게 설정한다.
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
    from app.chat.redis_client import get_redis, close_redis

    # 취약·기본 비밀값으로는 기동하지 않는다(app/security_defaults.py — 변수별 사유 1줄, 값은 출력하지 않는다).
    # 컨테이너에서는 entrypoint 가 동일 검사를 먼저 수행해 워커 기동 전에 중지한다. 본 검사는 그 외 실행 경로용이다.
    from app import security_defaults
    security_defaults.enforce()

    # DB 스키마를 코드가 요구하는 버전으로 맞춘다. 컨테이너에서는 entrypoint 가 워커 기동 전에 먼저 수행하므로
    # 여기서는 통상 버전 확인만 수행한다. 맞출 수 없으면 예외를 발생시켜 기동을 중지한다(app/db/migrate.py).
    await init_db()

    # 최초 기동 시 관리자 시드 — 사용자가 한 명도 없는 경우에만 수행한다. 이후에는 env 에 값이 남아 있어도 no-op 이며,
    # 동일 이름의 일반 계정을 관리자로 승격하지도 않는다(경고만). 워커 다수가 동시에 기동하므로 한 워커만 수행한다.
    admin_user = os.environ.get("ADMIN_USERNAME")
    admin_pass = os.environ.get("ADMIN_PASSWORD")
    if admin_user and admin_pass:
        from app.cli import seed_admin
        from app.jobs.lock import try_acquire
        if await try_acquire("startup:seed-admin", ttl=20):
            try:
                await seed_admin(admin_user, admin_pass, only_if_empty=True)
            except Exception as e:  # noqa: BLE001 — 시드 실패가 서비스 전체의 기동 실패로 이어지면 안 된다
                print(f"[SEED] 관리자 시드 실패: {type(e).__name__}")

    # 관리자가 아직 없으면(설치 관리자를 통한 설치가 아닌 경우) 최초 관리자 생성에 사용할 일회용 설정 토큰을 로그에 기록한다.
    try:
        from app.setup import token as setup_token
        await setup_token.announce_on_start()
    except Exception as e:  # noqa: BLE001 — 토큰이 없으면 웹의 최초 관리자 생성이 차단된 상태로 유지된다(안전한 쪽)
        print(f"[SETUP] 설정 토큰을 만들지 못했습니다({type(e).__name__}) — python -m app.cli setup-token 으로 발급하세요")

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
    # Desktop, Cursor, etc.): Streamable HTTP (primary) + legacy SSE. AI 구역 소속.
    ai_installed = zones.zone_installed("ai")
    if ai_installed:
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
    # 백그라운드 루프 — 설치된 구역 한정, app/zones.py 의 LOOPS 순서대로 기동
    for loop_fn in zones.active_loops():
        _tasks.append(asyncio.create_task(loop_fn()))
    print(f"[STARTUP] {settings.app_name} started (zones: {', '.join(zones.installed_zone_ids()) or '-'})")

    yield

    # Flush remaining access logs before shutdown
    from app.middleware.access_log import _flush_buffer
    await _flush_buffer()

    if ai_installed:
        # 진행 중인 내장 AI 답변 — 수신한 부분까지 interrupted 로 저장(/continue 로 재개). Redis 종료 전에 수행.
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

    for task in _tasks:
        task.cancel()
    for task in _tasks:
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    _tasks.clear()
    await close_redis()


# CORS — 기본값은 공개 주소(APP_URL) 하나. allow_credentials=True 와 함께 사용되므로 허용 목록이 곧 신뢰 경계이다.
_cors_origins = [settings.app_url]
if settings.debug:
    _cors_origins += ["http://localhost:3000", "http://localhost:8000"]   # 개발 서버(DEBUG 일 때만)
# 번들 빌드 모바일 앱(화면을 앱에 내장하고 API 만 서버로 호출하는 빌드)의 출처 — ALLOW_NATIVE_APP_ORIGINS=true 일 때만 허용.
# 기본 앱(데스크톱·모바일)은 서버 화면을 그대로 로드하여 동일 출처이므로 불필요. 목록과 근거: app/auth/ws_auth.py
if settings.allow_native_app_origins:
    from app.auth.ws_auth import NATIVE_APP_ORIGINS
    _cors_origins += list(NATIVE_APP_ORIGINS)


async def _validation_handler(request: Request, exc: RequestValidationError):
    """422 응답에서 입력값을 제거한다.

    Pydantic v2 는 검증에 실패한 값을 err["input"] 에 포함해 전달하고, FastAPI 기본
    핸들러는 이를 그대로 응답에 포함한다. 비밀번호 정책 위반 시 평문 비밀번호가
    응답 본문에 노출된다. 위치(loc)와 사유(msg)만 유지한다.
    """
    safe = [
        {"type": e.get("type"), "loc": e.get("loc"), "msg": e.get("msg")}
        for e in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": safe})


async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Please try again later."},
    )


# 라우터가 아닌 앱 직속 경로 — create_app 이 구역 라우터 뒤에 등록한다(등록 순서 유지).
_dav_discovery = APIRouter()   # 일정 구역: CalDAV/CardDAV 탐색
_site = APIRouter()            # 상시 등록: 자동 발견·앱 다운로드·사이트 설정·브랜딩


# ── .well-known CalDAV/CardDAV discovery ──

@_dav_discovery.get("/.well-known/caldav")
async def well_known_caldav():
    return RedirectResponse(url="/dav/", status_code=301)


@_dav_discovery.get("/.well-known/carddav")
async def well_known_carddav():
    return RedirectResponse(url="/dav/", status_code=301)


@_site.get("/.well-known/workspace.json")
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
    }


# ── 앱 다운로드 (모바일 APK + QR + 안내) ──

def _apk_path() -> Path:
    return Path(settings.storage_root) / "apps" / "workspace-android.apk"


def _desktop_path() -> Path:
    return Path(settings.storage_root) / "apps" / "workspace-desktop-setup.exe"


@_site.get("/api/apps/android")
async def app_android():
    p = _apk_path()
    if not p.is_file():
        raise HTTPException(status_code=404, detail="APK가 아직 업로드되지 않았습니다")
    return FileResponse(
        str(p), media_type="application/vnd.android.package-archive",
        filename="JustWorkspace.apk",
    )


@_site.get("/api/apps/desktop")
async def app_desktop():
    p = _desktop_path()
    if not p.is_file():
        raise HTTPException(status_code=404, detail="데스크탑 설치파일이 아직 업로드되지 않았습니다")
    return FileResponse(
        str(p), media_type="application/octet-stream",
        filename="JustWorkspace-setup.exe",
    )


@_site.get("/api/apps/android.qr")
async def app_android_qr():
    import io
    import qrcode
    url = f"{settings.app_url.rstrip('/')}/api/apps/android"
    buf = io.BytesIO()
    qrcode.make(url).save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


@_site.get("/api/apps", response_class=HTMLResponse)
async def app_landing():
    has_apk = _apk_path().is_file()
    has_desktop = _desktop_path().is_file()
    apk_block = (
        '<img src="/api/apps/android.qr" width="200" height="200" alt="QR" />'
        '<br><a class="btn" href="/api/apps/android">Android APK 다운로드</a>'
        if has_apk else
        '<p class="s">Android APK가 아직 준비되지 않았습니다.</p>'
    )
    desktop_block = (
        '<br><a class="btn" href="/api/apps/desktop">Windows 데스크탑 앱 다운로드</a>'
        if has_desktop else
        '<p class="s">데스크탑: 브라우저 주소창의 <b>앱 설치</b> 아이콘으로 설치형 사용.</p>'
    )
    # NetLab 외부 콘솔 도우미 — 파일은 NetLab 출처가 제공한다(netlab/helper, /downloads/). 주소가 설정된 경우에만
    netlab = settings.netlab_url.rstrip('/')
    netlab_block = (
        f'<p class="s">NetLab 콘솔 도우미: 랩 노드 콘솔을 PuTTY·SecureCRT·MobaXterm·Windows Terminal 로 바로 엽니다. '
        f'관리자 권한 없이 설치, 서명 없는 파일이라 SmartScreen 이 표시되면 <b>추가 정보 → 실행</b>.</p>'
        f'<a class="btn" href="{html.escape(netlab)}/downloads/netlab-console-setup.exe">NetLab 콘솔 도우미 (Windows)</a>'
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
<p class="s">안드로이드: QR 스캔 또는 버튼으로 APK 다운로드. 설치 시 "출처를 알 수 없는 앱" 1회 허용.</p>
{apk_block}
<p class="s">iOS: Safari로 이 워크스페이스를 열고 <b>공유 → 홈 화면에 추가</b> (PWA 설치).</p>
{desktop_block}
<p class="s">Windows 앱은 트레이 상주형 — 닫아도 백그라운드 유지하며 알림을 표시합니다.</p>
{netlab_block}
</body></html>""")


from app.source import LICENSE_ID, public_source_url  # noqa: E402


def _public_netlab_url() -> str:
    """설정된 NetLab 주소를 공개용으로 변환 — https:// 로 시작하는 경우에만, 끝의 / 제거. 그 외에는 빈 값."""
    url = (settings.netlab_url or "").strip().rstrip("/")
    return url if url.startswith("https://") else ""


async def _signed_in(request: Request, db: AsyncSession) -> bool:
    """요청이 로그인한 사용자의 것인지 판정한다(세션 쿠키·Bearer). 아니면 예외 없이 False 반환."""
    if not request.cookies.get("ws_session") and not request.headers.get("authorization"):
        return False
    try:
        from app.auth.deps import get_current_user
        return await get_current_user(request, request.cookies.get("ws_session"), db) is not None
    except Exception:  # noqa: BLE001 — 만료·위조·저장소 장애 모두 미로그인으로 처리
        return False


@_site.get("/api/health")
async def health_check(request: Request, db: AsyncSession = Depends(get_db)):
    """상태 확인 + 로그인 화면 렌더링에 필요한 사이트 설정(브랜딩·가입 방식·공지·구역).

    비인증으로 공개되므로 **서버 버전은 포함하지 않는다** — 로그인한 요청에만 포함한다.
    (클라이언트 호환 확인용 버전은 /api/platform/capabilities 가 별도로 제공한다.)
    """
    from app.admin.settings import get_settings_by_prefix

    db_vals = await get_settings_by_prefix(db, "branding.")
    gen_vals = await get_settings_by_prefix(db, "general.")
    auth_vals = await get_settings_by_prefix(db, "auth.")
    # 디자인 대개편용 확장 앱 설정 — appcfg.<group>.<key> (예: appcfg.dash.cards).
    # 공개(비인증) 노출: 로그인·셸·대시보드·빈 상태 렌더링에 필요. 프리픽스를 제거해 반환.
    appcfg = {
        k[len("appcfg."):]: v
        for k, v in (await get_settings_by_prefix(db, "appcfg.")).items()
    }

    out = {
        "status": "ok",
        "service": db_vals.get("branding.site_name") or settings.app_name,
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
        # NetLab(별도 출처 랩) 주소 — 레일 '도구' 항목·대시보드 카드가 새 탭으로 연다. https 만 허용(아니면 빈 값 → 둘 다 숨김)
        "netlab_url": _public_netlab_url(),
        # 이 서버가 실행하는 프로그램의 소스 주소와 라이선스 — 로그인 화면·설정이 "소스 코드" 링크로 표시한다(app/source.py)
        "source_url": public_source_url(settings.jw_source_url),
        "license": LICENSE_ID,
        # 설치된 구역 id(JW_ZONES, 비어 있으면 전체) — 화면이 없는 구역의 메뉴·진입점 숨김에 사용
        "zones": zones.installed_zone_ids(),
        "config": appcfg,
    }
    if await _signed_in(request, db):
        out["version"] = APP_VERSION
        # DB 스키마 버전: 코드가 요구하는 값 / 이 워커가 기동 시 확인한 값(app/db/migrate.py)
        from app.db.migrate import confirmed_version
        from app.db.schema_version import SCHEMA_VERSION
        out["schema_version"] = {"required": SCHEMA_VERSION, "current": confirmed_version()}
    return out


@_site.get("/api/branding/favicon")
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


@_site.get("/api/branding/wallpapers")
async def list_wallpapers():
    """공개: 업로드된 로그인 배경 목록(이미지/영상). 프런트가 접속마다 무작위 선택."""
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


@_site.get("/api/branding/wallpaper/{name}")
async def serve_wallpaper_named(name: str):
    """공개: 이름별 배경 제공(경로 트래버설 차단)."""
    if "/" in name or "\\" in name or ".." in name or not name.startswith("wallpaper"):
        raise HTTPException(status_code=404, detail="Not found")
    f = Path(settings.storage_root) / "branding" / name
    if f.is_file() and f.suffix.lower() in _WP_MEDIA:
        return FileResponse(str(f), media_type=_WP_MEDIA[f.suffix.lower()])
    raise HTTPException(status_code=404, detail="Wallpaper not found")


@_site.get("/api/branding/wallpaper")
async def serve_wallpaper():
    """Serve first uploaded wallpaper (back-compat, no auth)."""
    wp_dir = Path(settings.storage_root) / "branding"
    if wp_dir.is_dir():
        for f in sorted(wp_dir.iterdir(), key=lambda x: x.name):
            if f.name.startswith("wallpaper") and f.is_file() and f.suffix.lower() in _WP_MEDIA:
                return FileResponse(str(f), media_type=_WP_MEDIA[f.suffix.lower()])
    raise HTTPException(status_code=404, detail="Wallpaper not found")


@_site.get("/api/branding/logo")
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


def create_app() -> FastAPI:
    """앱을 생성한다 — 설치된 구역(JW_ZONES)의 라우터·마운트·미들웨어만 등록한다.

    등록 순서는 구역과 무관하게 항상 동일하다(app/zones.py 의 ROUTERS 순서). 미설치 구역은 해당
    위치가 비는 것뿐이므로, JW_ZONES 가 없으면 라우트 집합과 순서가 기존과 동일하다.
    """
    app = FastAPI(
        title=settings.app_name,
        version=APP_VERSION,
        lifespan=lifespan,
        docs_url="/api/docs" if settings.debug else None,
        redoc_url=None,
    )

    if zones.zone_installed("rbi"):
        # 격리 브라우저 전용 출처(Host = RBI_PUBLIC_ORIGIN)로 수신된 요청은 /api/rbi/* · nginx 내부 인증 외에는 404(ws-nginx 와 이중)
        from app.rbi.site import RbiHostGuard
        app.add_middleware(RbiHostGuard)
    # 저장소 마커 확인 — STORAGE_MARKER_REQUIRED=1 일 때만. 마커가 확인되지 않으면 파일 쓰기를 503 으로 거부한다
    # (연결이 끊긴 네트워크 저장소 위치의 빈 폴더에 기록하는 사고 방지 — app/middleware/storage_guard.py)
    from app.middleware import storage_guard
    if storage_guard.required():
        app.add_middleware(storage_guard.StorageMarkerGuard)
    # 세션 쿠키로 인증된 상태 변경 요청의 출처 검사(CSRF) — 레이트리밋 안쪽이므로 거부된 요청도 한도에 산입되고,
    # 접속 로그(더 바깥)에 403 으로 기록된다. 허용 출처는 CORS 목록과 동일한 것을 사용한다(CSRF_ORIGIN_CHECK=false 로 비활성화)
    app.add_middleware(CookieOriginGuard, allowed_origins=_cors_origins)
    # 기본 레이트리밋(데코레이터 없는 /api·/oauth 라우트) — CORS 안쪽이므로 429 에도 CORS 헤더가 포함된다
    app.add_middleware(DefaultRateLimitMiddleware)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    app.add_middleware(AccessLogMiddleware)
    # 요청 번호 — 가장 바깥(마지막에 추가)이므로 미처리 예외도 여기서 500 JSON + 번호로 변환된다
    app.add_middleware(RequestIdMiddleware)

    app.state.limiter = limiter
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)

    if zones.zone_installed("calendar"):
        # Mount DAV sub-application (PROPFIND/REPORT via raw ASGI)
        from app.dav.router import dav_app
        app.mount("/dav", dav_app)

    for router in zones.active_routers():
        app.include_router(router)

    if zones.zone_installed("calendar"):
        app.include_router(_dav_discovery)
    app.include_router(_site)
    return app


app = create_app()
