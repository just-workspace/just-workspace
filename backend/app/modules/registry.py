"""Module registry — built-in module definitions + plugin modules + DB-backed enable/disable."""

import json
import logging
from functools import wraps
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import SystemSetting
from app.chat.redis_client import get_redis
from app.zones import module_installed

logger = logging.getLogger(__name__)

# ─── Plugin modules (filled by loader at startup) ───

_plugin_modules: list[dict[str, Any]] = []

# ─── Built-in module definitions ───
# 모듈의 소속 구역은 app/zones.json 의 modules 가 결정한다(id 가 동일해야 한다).
# 미설치 구역의 모듈은 목록에서 제외되며 활성화도 불가하다 — _all_modules · is_module_enabled.

BUILTIN_MODULES: list[dict[str, Any]] = [
    {
        "id": "mail",
        "name": "메일",
        "icon": "mail",
        "route": "/mail",
        "api_prefix": "/api/mail",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        "id": "chat",
        "name": "채팅",
        "icon": "message-square",
        "route": "/chat",
        "api_prefix": "/api/chat",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        "id": "ai",
        "name": "AI",
        "icon": "sparkles",
        "route": "/ai",
        "api_prefix": "/api/ai",
        "type": "builtin",
        "requires": [],
        "default_enabled": False,  # 제공자(키/모델) 설정 후 활성화
    },
    {
        "id": "meetings",
        "name": "화상회의",
        "icon": "video",
        "route": "/meetings",
        "api_prefix": "/api/meetings",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        "id": "files",
        "name": "파일",
        "icon": "folder",
        "route": "/files",
        "api_prefix": "/api/files",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        "id": "calendar",
        "name": "캘린더",
        "icon": "calendar",
        "route": "/calendar",
        "api_prefix": "/api/calendar",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        "id": "contacts",
        "name": "연락처",
        "icon": "users",
        "route": "/contacts",
        "api_prefix": "/api/contacts",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        "id": "git",
        "name": "Git",
        "icon": "git-branch",
        "route": "/code",
        "api_prefix": "/api/git",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        "id": "board",
        "name": "게시판",
        "icon": "clipboard-list",
        "route": "/board",
        "api_prefix": "/api/board",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        "id": "tasks",
        "name": "할 일",
        "icon": "check-square",
        "route": "/tasks",
        "api_prefix": "/api/tasks",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        "id": "wiki",
        "name": "위키",
        "icon": "book-open",
        "route": "/wiki",
        "api_prefix": "/api/wiki",
        "type": "builtin",
        "requires": [],
        "default_enabled": True,
    },
    {
        # 격리 브라우저(RBI) — 내부 자산을 세션별 일회용 브라우저 컨테이너로만 연다(docs/rbi.md).
        # 호스트 netfilter 사이드카(profiles: rbi)가 있어야 세션이 기동되므로 기본값은 비활성화이다.
        "id": "rbi",
        "name": "격리 브라우저",
        "icon": "shield",
        "route": "/rbi",
        "api_prefix": "/api/rbi",
        "type": "builtin",
        "requires": [],
        "default_enabled": False,
    },
]

# ─── Nav 카테고리 ───
# 사이드바는 모듈을 본 카테고리별로 그룹 렌더링한다. 라벨/순서 매핑은 프론트에서 수행한다.
# 그룹: 커뮤니케이션 / 협업 / 콘텐츠 / AI 스튜디오 / 개발·시스템.
_CATEGORY_BY_ID: dict[str, str] = {
    "mail": "communication",
    "chat": "communication",
    "meetings": "communication",
    "board": "collaboration",
    "wiki": "collaboration",
    "tasks": "collaboration",
    "calendar": "collaboration",
    "contacts": "collaboration",
    "files": "content",
    "notes": "content",
    "ai": "ai",
    "git": "system",
    "rbi": "system",
}


def _category_for(mod: dict[str, Any]) -> str:
    """모듈 카테고리: 명시 category → builtin 맵 → 플러그인 기본값(ai/콘텐츠 성격)."""
    if mod.get("category"):
        return mod["category"]
    return _CATEGORY_BY_ID.get(mod["id"], "plugin")


# ─── In-memory cache ───

_module_states: dict[str, bool] = {}
_cache_loaded = False


def _module_key(module_id: str) -> str:
    return f"module.{module_id}.enabled"


def _all_modules() -> list[dict[str, Any]]:
    """Return combined list of builtin + plugin modules — 설치된 구역의 모듈만 포함.

    미설치 구역의 모듈은 여기서 제외되므로 모듈 목록(내비게이션)에 표시되지 않으며
    set_module_enabled 도 "없는 모듈"로 거부한다."""
    return [m for m in BUILTIN_MODULES + _plugin_modules if module_installed(m["id"])]


def parse_plugin_order(value: Any) -> int | None:
    """manifest "order" → 정수(작을수록 상위). 없거나 정수가 아니면 None(bool·실수·문자열은 허용하지 않는다)."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def plugin_sort_key(meta: dict[str, Any]) -> tuple[int, int]:
    """플러그인 정렬 키 — order 가 있는 항목이 우선(오름차순), 없는 항목은 후순위. 안정 정렬과 함께 사용하여
    동일 order·order 없음 항목 간에는 원래 순서(로더의 폴더 이름순)를 유지한다."""
    order = meta.get("order")
    return (0, order) if isinstance(order, int) and not isinstance(order, bool) else (1, 0)


def register_plugin_module(plugin_meta: dict[str, Any]) -> None:
    """Register a plugin module (called by plugin loader at startup).
    목록은 항상 plugin_sort_key 순으로 유지한다(레일·메뉴·모듈 목록이 이 순서를 따른다)."""
    # Avoid duplicates
    if any(p["id"] == plugin_meta["id"] for p in _plugin_modules):
        return
    _plugin_modules.append(plugin_meta)
    _plugin_modules.sort(key=plugin_sort_key)
    # Set default state if not already in cache
    if plugin_meta["id"] not in _module_states:
        _module_states[plugin_meta["id"]] = plugin_meta.get("default_enabled", True)
    logger.info("[Modules] registered plugin: %s", plugin_meta["id"])


async def load_module_states(db: AsyncSession) -> None:
    """Load module enabled/disabled states from DB into cache."""
    global _cache_loaded
    result = await db.execute(
        select(SystemSetting).where(SystemSetting.key.like("module.%.enabled"))
    )
    settings = result.scalars().all()

    # Start with defaults (builtin + already-registered plugins)
    _module_states.clear()
    for mod in _all_modules():
        _module_states[mod["id"]] = mod["default_enabled"]

    # Override with DB values
    for s in settings:
        # key = "module.xxx.enabled"
        parts = s.key.split(".")
        if len(parts) == 3:
            module_id = parts[1]
            try:
                _module_states[module_id] = json.loads(s.value)
            except (json.JSONDecodeError, TypeError):
                pass

    _cache_loaded = True
    # 배포/재기동 시 Redis 모듈 캐시 무효화 — 워커 불일치로 캐시된 stale 값 제거
    await _invalidate_modules_cache()
    logger.info("[Modules] loaded states: %s", _module_states)


def is_module_enabled(module_id: str) -> bool:
    """Fast cached check. Falls back to default_enabled if cache not loaded.

    구역이 미설치된 모듈은 DB 에 활성 상태로 남아 있어도 항상 비활성으로 판정한다."""
    if not module_installed(module_id):
        return False
    if module_id in _module_states:
        return _module_states[module_id]
    # Fallback: find in all modules
    for mod in _all_modules():
        if mod["id"] == module_id:
            return mod["default_enabled"]
    return False


_MODULES_CACHE_KEY = "cache:platform:modules"
_MODULES_CACHE_TTL = 60  # seconds


async def _invalidate_modules_cache() -> None:
    """Delete the Redis modules cache. Silently ignores Redis errors."""
    try:
        redis = await get_redis()
        await redis.delete(_MODULES_CACHE_KEY)
    except Exception:
        pass


async def get_enabled_modules(db: AsyncSession | None = None) -> list[dict]:
    """Return list of all modules (builtin + plugin) with their enabled status.

    상태의 권위 출처는 DB(SystemSetting)이다 — uvicorn 워커 8개 간 in-memory 불일치(토글이 한 워커의
    메모리만 갱신하여 nav 에 반영되지 않는 문제)를 방지한다. db 가 없으면 in-memory 로 fallback 한다.
    Redis 60초 캐시(DB 파생값이므로 워커와 무관하게 일관)."""
    # Try Redis cache first
    try:
        redis = await get_redis()
        cached = await redis.get(_MODULES_CACHE_KEY)
        if cached is not None:
            return json.loads(cached)
    except Exception:
        pass  # Redis unavailable — fall through

    # DB 에서 활성 상태 로드(권위 출처) 및 본 워커 메모리 동기화(require_module 보조)
    db_states: dict[str, bool] = {}
    if db is not None:
        try:
            rows = await db.execute(select(SystemSetting).where(SystemSetting.key.like("module.%.enabled")))
            for s in rows.scalars().all():
                parts = s.key.split(".")
                if len(parts) == 3:
                    try:
                        db_states[parts[1]] = json.loads(s.value)
                    except (json.JSONDecodeError, TypeError):
                        pass
            for _mid, _val in db_states.items():
                _module_states[_mid] = _val
        except Exception:
            pass

    result = []
    for mod in _all_modules():
        enabled = db_states.get(mod["id"], is_module_enabled(mod["id"]))
        entry = {
            "id": mod["id"],
            "name": mod["name"],
            "icon": mod["icon"],
            "route": mod["route"],
            "type": mod["type"],
            "requires": mod["requires"],
            "enabled": enabled,
            "category": _category_for(mod),
        }
        # Include plugin-specific fields
        if mod["type"] == "plugin":
            entry["name_en"] = mod.get("name_en", mod["name"])
            entry["version"] = mod.get("version", "0.0.0")
            entry["description"] = mod.get("description", "")
            entry["author"] = mod.get("author", "")
            entry["has_frontend"] = mod.get("has_frontend", False)
            entry["fullscreen"] = mod.get("fullscreen", False)
            entry["order"] = mod.get("order")
        result.append(entry)

    # Store in Redis cache
    try:
        redis = await get_redis()
        await redis.set(_MODULES_CACHE_KEY, json.dumps(result), ex=_MODULES_CACHE_TTL)
    except Exception:
        pass  # Redis unavailable — no cache, still works

    return result


async def set_module_enabled(db: AsyncSession, module_id: str, enabled: bool) -> bool:
    """Set module enabled/disabled in DB + update cache."""
    # Validate module exists (builtin or plugin)
    found = any(m["id"] == module_id for m in _all_modules())
    if not found:
        return False

    key = _module_key(module_id)
    result = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    setting = result.scalar_one_or_none()

    if setting:
        setting.value = json.dumps(enabled)
    else:
        setting = SystemSetting(key=key, value=json.dumps(enabled))
        db.add(setting)

    await db.commit()
    _module_states[module_id] = enabled
    await _invalidate_modules_cache()
    logger.info("[Modules] %s → %s", module_id, "enabled" if enabled else "disabled")

    # 플러그인이면 라이프사이클 훅(on_enable/on_disable)
    if any(p["id"] == module_id for p in _plugin_modules):
        try:
            from app.plugins.loader import run_plugin_hook
            await run_plugin_hook(module_id, "on_enable" if enabled else "on_disable")
        except Exception:
            pass
    return True


# ─── Decorator: require_module ───


def require_module(module_id: str):
    """Decorator for FastAPI endpoints — returns 403 if module is disabled."""
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            db = kwargs.get("db")
            # 구역이 미설치된 모듈 — DB 값과 무관하게 차단한다(라우터가 없으므로 통상 이 지점에 도달하지 않는다)
            if not module_installed(module_id):
                raise HTTPException(
                    status_code=403,
                    detail="이 기능은 비활성화되어 있습니다",
                )
            # 모듈 활성 여부의 권위 출처는 DB(워커 8개의 in-memory 불일치로 토글 후 403 이 발생하는 문제 방지)
            enabled = is_module_enabled(module_id)
            if db is not None:
                try:
                    v = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == _module_key(module_id)))
                    if v is not None:
                        enabled = json.loads(v)
                        _module_states[module_id] = enabled
                except Exception:
                    pass
            if not enabled:
                raise HTTPException(
                    status_code=403,
                    detail="이 기능은 비활성화되어 있습니다",
                )
            # 그룹 권한(grant) 검사 — 엔드포인트에 user/db 의존성이 있는 경우에만 수행.
            # grant 없는 모듈은 전체 허용(하위 호환). 권한 시스템 오류 시 차단하지 않음(가용성).
            user = kwargs.get("user")
            db = kwargs.get("db")
            if user is not None and db is not None and not getattr(user, "is_admin", False):
                try:
                    from app.groups import service as _gs
                    allowed = await _gs.user_can_access(db, user.id, module_id, False)
                except HTTPException:
                    raise
                except Exception:
                    allowed = True
                if not allowed:
                    raise HTTPException(status_code=403, detail="이 기능에 대한 접근 권한이 없습니다")
            return await func(*args, **kwargs)
        return wrapper
    return decorator
