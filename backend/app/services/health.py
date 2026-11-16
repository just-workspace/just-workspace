"""Background service health checker with in-memory cache."""

import asyncio
import logging
import time

import httpx

from app.config import get_settings
from app.services.schemas import ServiceStatus

logger = logging.getLogger(__name__)


def _build_service_defs() -> list[dict]:
    """점검 대상 — 설정(.env 의 주소)과 설치된 구역으로 결정한다.

    항목의 "zone" 은 해당 서비스를 기동하는 구역이다. 미설치 구역의 서비스는 점검하지
    않는다 — 컨테이너 부재는 장애가 아니다.
    """
    s = get_settings()
    defs = [
        {
            "name": "Gitea",
            "zone": "git",
            "health_url": f"{s.gitea_url}/api/v1/version",
            "external_url": "/git/",
            "internal_only": False,
        },
        {
            "name": "PostgreSQL",
            "zone": "core",
            "health_tcp": "postgres:5432",
            "external_url": None,
            "internal_only": True,
        },
        {
            "name": "Redis",
            "zone": "core",
            "health_tcp": "redis:6379",
            "external_url": None,
            "internal_only": True,
        },
    ]
    # 메일서버 헬스: 빌트인이면 mailserver, 아니면 내부 별도 메일서버(MAIL_HEALTH_HOST) 지정 시 해당 호스트.
    # 둘 다 아니면(외부 IMAP 클라이언트 모드) 메일서버 항목 자체를 포함하지 않음.
    _mail_host = "mailserver:993" if getattr(s, "feature_builtin_mailserver", False) else (getattr(s, "mail_health_host", "") or "")
    if _mail_host:
        if ":" not in _mail_host:
            _mail_host += ":993"
        defs.append({
            "name": "Mail Server",
            "zone": "mail",
            "health_tcp": _mail_host,
            "external_url": "/mail/",
            "internal_only": True,
        })
    if s.livekit_url:
        defs.append({
            "name": "LiveKit",
            "zone": "meetings",
            "health_url": s.livekit_url.replace("ws://", "http://").replace("wss://", "https://") + "/",
            "external_url": None,
            "internal_only": True,
        })
    if s.onlyoffice_jwt_secret:
        defs.append({
            "name": "OnlyOffice",
            "zone": "docs",
            "health_url": f"{s.onlyoffice_url}/healthcheck",
            "external_url": None,
            "internal_only": True,
        })
    from app.zones import zone_installed
    return [d for d in defs if zone_installed(d["zone"])]

# In-memory cache
_cache: list[ServiceStatus] = []
# 마지막 주기를 완료한 시각(epoch 초) — 공개 상태 "확인 10:42:08"
_checked_at: float | None = None
_check_interval = 60  # seconds


async def check_service(svc: dict) -> ServiceStatus:
    """Check a single service health endpoint (HTTP or TCP)."""
    elapsed_ms = None
    status = "down"

    try:
        start = time.monotonic()
        if "health_tcp" in svc:
            host, port = svc["health_tcp"].rsplit(":", 1)
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, int(port)), timeout=5.0
            )
            writer.close()
            await writer.wait_closed()
            elapsed_ms = int((time.monotonic() - start) * 1000)
            status = "ok"
        else:
            headers = svc.get("health_headers", {})
            async with httpx.AsyncClient(timeout=10.0, verify=False, follow_redirects=True) as client:
                resp = await client.get(svc["health_url"], headers=headers)
                elapsed_ms = int((time.monotonic() - start) * 1000)
                status = "ok" if resp.status_code < 400 else "down"
    except Exception:
        elapsed_ms = None
        status = "down"

    return ServiceStatus(
        name=svc["name"],
        url=svc["external_url"],
        status=status,
        response_ms=elapsed_ms,
        internal_only=svc["internal_only"],
    )


# 워커 8개가 동일 루프를 실행한다 — 한 주기에 한 워커만 점검하고(jobs.lock), 결과는 Redis 로 공유한다.
# 이전에는 60초마다 외부 점검이 8배로 발생했고, 워커별 캐시가 상이하여 대시보드 값이 요청마다 달라졌다.
HEALTH_REDIS_KEY = "health:services"
_TICK = 15          # 이 간격으로 Redis 저장본을 조회(점검 자체는 락 TTL 주기)
_LOCK_TTL = _check_interval - 5


async def _check_all() -> list[ServiceStatus]:
    defs = _build_service_defs()
    results = await asyncio.gather(
        *(check_service(svc) for svc in defs),
        return_exceptions=True,
    )
    return [
        r if isinstance(r, ServiceStatus)
        else ServiceStatus(
            name="unknown", url=None, status="down",
            response_ms=None, internal_only=False,
        )
        for r in results
    ]


async def _publish(rows: list[ServiceStatus], checked_at: float) -> None:
    try:
        import json
        from app.chat.redis_client import get_redis
        redis = await get_redis()
        await redis.set(HEALTH_REDIS_KEY, json.dumps({
            "checked_at": checked_at, "services": [r.model_dump() for r in rows],
        }), ex=_check_interval * 3)
    except Exception as e:  # noqa: BLE001 — 공유 실패 시에도 로컬 캐시는 사용
        logger.debug("헬스 결과 Redis 저장 실패: %s", e)


async def _load_shared() -> tuple[list[ServiceStatus], float] | None:
    try:
        import json
        from app.chat.redis_client import get_redis
        redis = await get_redis()
        raw = await redis.get(HEALTH_REDIS_KEY)
        if not raw:
            return None
        d = json.loads(raw)
        return [ServiceStatus(**x) for x in d.get("services", [])], float(d.get("checked_at") or 0)
    except Exception as e:  # noqa: BLE001
        logger.debug("헬스 결과 Redis 읽기 실패: %s", e)
        return None


async def health_tick() -> bool:
    """1회 실행 — 락을 획득한 워커는 점검 후 Redis 에 저장하고, 나머지는 저장본을 조회한다. 점검을 수행했으면 True."""
    global _cache, _checked_at
    # jobs.lock.try_acquire 는 Redis 장애 시 "미수행"(fail-closed)이나, 헬스는 그 경우에 점검이 필요하다
    # (Redis down 을 표시해야 함) — 락 조회가 불가한 상황이면 이 워커가 직접 점검한다.
    try:
        from app.chat.redis_client import get_redis
        from app.jobs.lock import lock_key
        redis = await get_redis()
        mine = bool(await redis.set(lock_key("health:check"), "1", nx=True, ex=_LOCK_TTL))
    except Exception:  # noqa: BLE001
        mine = True
    if mine:
        rows = await _check_all()
        _cache, _checked_at = rows, time.time()
        await _publish(rows, _checked_at)
        return True
    shared = await _load_shared()
    if shared and (_checked_at is None or shared[1] >= _checked_at):
        _cache, _checked_at = shared
    return False


async def run_health_checker():
    """Background task: 15초마다 health_tick — 점검은 워커 하나가 약 60초마다 수행한다.

    한 주기에서 예외가 발생해도 루프를 유지한다. 이전에는 여기서 예외가 한 번 발생하면 태스크
    전체가 종료되어 캐시가 계속 비어 있었고, 대시보드에는 "서비스 0개 정상" 만 표시되었다.
    """
    while True:
        try:
            await health_tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("서비스 헬스체크 주기 실패 — 다음 주기에 다시 시도한다")
        await asyncio.sleep(_TICK)


def get_cached_status() -> list[ServiceStatus]:
    """Return cached service statuses."""
    if not _cache:
        try:
            defs = _build_service_defs()
        except Exception:
            logger.exception("서비스 목록을 만들지 못했다")
            return []
        return [
            ServiceStatus(
                name=svc["name"],
                url=svc["external_url"],
                status="checking",
                response_ms=None,
                internal_only=svc["internal_only"],
            )
            for svc in defs
        ]
    return _cache


# ─── 공개 서비스 상태(500 화면 "서비스 상태" — 로그인 전에도 조회 가능) ───
# 내부 이름(PostgreSQL·Redis)·주소·버전은 노출하지 않는다. 사용자 관점 그룹(로그인·메일·채팅…)의 key 와
# 상태·응답 시간만 제공한다. 그룹을 구성하는 내부 점검이 하나도 없으면(예: 외부 IMAP 메일) 해당 그룹은 제외하고,
# 모듈이 비활성화되어 있으면 off. 지연 판정 기준은 응답 1초.
PUBLIC_GROUPS: list[tuple[str, str | None, tuple[str, ...]]] = [
    # (key, 모듈 id(None = 상시 활성), 이 그룹을 구성하는 내부 점검 이름)
    ("auth", None, ("PostgreSQL", "Redis")),
    ("mail", "mail", ("Mail Server",)),
    ("chat", "chat", ("PostgreSQL", "Redis")),
    ("files", "files", ("PostgreSQL", "OnlyOffice")),
    ("meetings", "meetings", ("LiveKit",)),
    ("git", "git", ("Gitea",)),
]
SLOW_MS = 1000


def _group_status(parts: list[ServiceStatus]) -> tuple[str, int | None]:
    """복수의 내부 점검 → (ok|slow|down|checking, 최장 응답 ms)."""
    if any(p.status == "down" for p in parts):
        return "down", None
    if any(p.status != "ok" for p in parts):
        return "checking", None
    ms = max((p.response_ms or 0) for p in parts)
    return ("slow" if ms >= SLOW_MS else "ok"), ms


def build_public_status(cache: list[ServiceStatus] | None = None, module_enabled=None, checked_at: float | None = None) -> dict:
    """{checked_at: ISO|None, services: [{key, status, response_ms}]} — 공개 가능한 항목만 포함한다."""
    from datetime import datetime, timezone

    from app.zones import module_installed
    if module_enabled is None:
        from app.modules.registry import is_module_enabled as module_enabled
    rows = get_cached_status() if cache is None else cache
    by_name = {r.name: r for r in rows}
    out: list[dict] = []
    for key, module_id, names in PUBLIC_GROUPS:
        if module_id and not module_installed(module_id):
            continue  # 미설치 구역 — "꺼짐"이 아니라 항목 자체가 없음
        if module_id and not module_enabled(module_id):
            out.append({"key": key, "status": "off", "response_ms": None})
            continue
        parts = [by_name[n] for n in names if n in by_name]
        if not parts:
            continue
        st, ms = _group_status(parts)
        out.append({"key": key, "status": st, "response_ms": ms})
    at = _checked_at if checked_at is None else checked_at
    return {
        "checked_at": datetime.fromtimestamp(at, tz=timezone.utc).isoformat() if at else None,
        "services": out,
    }
