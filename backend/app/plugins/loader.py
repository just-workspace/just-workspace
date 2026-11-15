"""Plugin loader — scan /plugins/*/manifest.json, validate, and dynamically load."""

import importlib
import importlib.util
import json
import logging
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from app.modules.registry import parse_plugin_order, plugin_sort_key, register_plugin_module

logger = logging.getLogger(__name__)

PLUGINS_DIR = Path("/plugins")          # 번들(리포, 읽기전용)
UPLOADED_DIR = Path("/plugins-data")    # 업로드(쓰기가능 볼륨) — 플러그앤플레이 설치
PLUGIN_DIRS = [PLUGINS_DIR, UPLOADED_DIR]

# Loaded plugin metadata (filled at startup)
_loaded_plugins: list[dict[str, Any]] = []
# 로드하지 않은 플러그인과 그 사유(필요한 구역 미설치 등) — 관리 화면 목록에 사유를 보여 준다
_skipped_plugins: list[dict[str, Any]] = []
# plugin_id → router module (라이프사이클 훅 호출용: on_install/on_enable/on_disable/on_uninstall)
_hook_modules: dict[str, Any] = {}


async def run_plugin_hook(plugin_id: str, hook_name: str) -> None:
    """플러그인 라이프사이클 훅 실행(있으면). 훅 시그니처: def hook(db) 또는 async def hook(db)."""
    import inspect
    mod = _hook_modules.get(plugin_id)
    fn = getattr(mod, hook_name, None) if mod else None
    if not callable(fn):
        return
    from app.db.session import async_session
    try:
        async with async_session() as db:
            res = fn(db)
            if inspect.isawaitable(res):
                await res
        logger.info("[Plugins] %s: hook %s done", plugin_id, hook_name)
    except Exception as e:
        logger.error("[Plugins] %s: hook %s failed: %s", plugin_id, hook_name, e)


async def _installed_flag(plugin_id: str, set_to: bool | None = None) -> bool:
    """SystemSetting plugin.<id>.installed 조회/설정."""
    from sqlalchemy import select
    from app.db.models import SystemSetting
    from app.db.session import async_session
    key = f"plugin.{plugin_id}.installed"
    async with async_session() as db:
        r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
        s = r.scalar_one_or_none()
        if set_to is not None:
            if s:
                s.value = "true" if set_to else "false"
            else:
                db.add(SystemSetting(key=key, value="true" if set_to else "false"))
            await db.commit()
            return set_to
        return bool(s and s.value == "true")

REQUIRED_MANIFEST_FIELDS = {"id", "name", "route", "api_prefix"}


def _validate_manifest(manifest: dict, manifest_path: Path) -> list[str]:
    """Return list of validation errors (empty = valid)."""
    errors = []
    for field in REQUIRED_MANIFEST_FIELDS:
        if not manifest.get(field):
            errors.append(f"missing required field: {field}")
    if manifest.get("id") and not manifest["id"].replace("-", "").replace("_", "").isalnum():
        errors.append(f"invalid id: {manifest['id']} (alphanumeric, hyphens, underscores only)")
    if manifest.get("api_prefix") and not manifest["api_prefix"].startswith("/api/plugins/"):
        errors.append(f"api_prefix must start with /api/plugins/, got: {manifest['api_prefix']}")
    return errors


def _import_module_from_path(module_name: str, file_path: Path):
    """Import a Python module from an arbitrary filesystem path."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot create module spec for {file_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


def get_loaded_plugins() -> list[dict[str, Any]]:
    """Return list of loaded plugin metadata (manifest + status)."""
    return _loaded_plugins


def get_skipped_plugins() -> list[dict[str, Any]]:
    """로드하지 않은 플러그인 — [{id, name, reason, missing_zones}]."""
    return _skipped_plugins


def missing_zones(manifest: dict) -> list[str]:
    """manifest 의 "zones"(이 플러그인이 기대는 구역 id 목록) 중 설치되지 않은 것."""
    from app.zones import zone_installed

    wanted = manifest.get("zones") or []
    if not isinstance(wanted, list):
        return []
    return [str(z) for z in wanted if not zone_installed(str(z))]


async def load_plugins(app: FastAPI) -> None:
    """Scan plugins directory, validate manifests, load routers and models."""
    _loaded_plugins.clear()
    _skipped_plugins.clear()
    _hook_modules.clear()
    seen_ids: set[str] = set()

    plugin_dirs: list[Path] = []
    for base in PLUGIN_DIRS:
        if base.is_dir():
            for d in sorted(base.iterdir()):
                if d.is_dir() and d.name != "node_modules":
                    plugin_dirs.append(d)
    if not plugin_dirs:
        logger.info("[Plugins] no plugin directories")
        return

    for plugin_dir in plugin_dirs:
        manifest_path = plugin_dir / "manifest.json"
        if not manifest_path.is_file():
            logger.warning("[Plugins] skipping %s — no manifest.json", plugin_dir.name)
            continue

        # Parse manifest
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            logger.error("[Plugins] failed to parse %s: %s", manifest_path, e)
            continue

        # Validate
        errors = _validate_manifest(manifest, manifest_path)
        if errors:
            logger.error("[Plugins] invalid manifest in %s: %s", plugin_dir.name, "; ".join(errors))
            continue

        plugin_id = manifest["id"]
        if plugin_id in seen_ids:
            logger.info("[Plugins] %s: 중복 id(다른 디렉토리) — 건너뜀", plugin_id)
            continue
        seen_ids.add(plugin_id)

        # 기대는 구역이 설치되지 않았으면 올리지 않는다(라우터·모델·모듈 목록 모두) — 사유는 로그와 목록에
        missing = missing_zones(manifest)
        if missing:
            logger.warning("[Plugins] %s: 필요한 구역이 설치되지 않아 건너뜀 — %s", plugin_id, ", ".join(missing))
            _skipped_plugins.append({
                "id": plugin_id,
                "name": manifest.get("name", plugin_id),
                "reason": "zone_not_installed",
                "missing_zones": missing,
            })
            continue
        backend_dir = plugin_dir / "backend"

        # Import models.py if present (must be before router so models are registered)
        models_path = backend_dir / "models.py"
        if models_path.is_file():
            try:
                _import_module_from_path(f"plugin_{plugin_id}_models", models_path)
                logger.info("[Plugins] %s: models loaded", plugin_id)
            except Exception as e:
                logger.error("[Plugins] %s: failed to load models: %s", plugin_id, e)
                continue

        # Import router.py (required)
        router_path = backend_dir / "router.py"
        if not router_path.is_file():
            logger.error("[Plugins] %s: backend/router.py not found", plugin_id)
            continue

        try:
            router_mod = _import_module_from_path(f"plugin_{plugin_id}_router", router_path)
        except Exception as e:
            logger.error("[Plugins] %s: failed to load router: %s", plugin_id, e)
            continue

        # Find the APIRouter instance
        router_obj = getattr(router_mod, "router", None)
        if router_obj is None:
            logger.error("[Plugins] %s: router.py must export 'router' (APIRouter)", plugin_id)
            continue

        # Include the router in the FastAPI app
        app.include_router(router_obj, prefix=manifest["api_prefix"], tags=[f"plugin:{plugin_id}"])
        logger.info("[Plugins] %s: router mounted at %s", plugin_id, manifest["api_prefix"])

        # Register in module registry
        # Check if pre-built frontend bundle exists
        has_frontend = (plugin_dir / "frontend" / "dist" / "plugin.mjs").is_file()

        plugin_meta = {
            "id": plugin_id,
            "name": manifest.get("name", plugin_id),
            "name_en": manifest.get("name_en", manifest.get("name", plugin_id)),
            "icon": manifest.get("icon", "puzzle"),
            "route": manifest["route"],
            "api_prefix": manifest["api_prefix"],
            "type": "plugin",
            "requires": manifest.get("requires", []),
            "default_enabled": True,
            "version": manifest.get("version", "0.0.0"),
            "description": manifest.get("description", ""),
            "author": manifest.get("author", ""),
            "_folder": plugin_dir.name,
            "_dir": str(plugin_dir),
            "has_frontend": has_frontend,
            # 페이지가 화면 하단까지 자기 컨트롤로 쓴다 → 셸이 모바일 탭바를 숨긴다.
            "fullscreen": bool(manifest.get("fullscreen", False)),
            # 레일·메뉴·플러그인 목록 순서(정수, 작을수록 위). 없으면 None → 폴더 이름순으로 뒤에
            "order": parse_plugin_order(manifest.get("order")),
        }
        if "order" in manifest and plugin_meta["order"] is None:
            logger.warning("[Plugins] %s: order 는 정수여야 합니다(%r) — 무시", plugin_id, manifest["order"])
        register_plugin_module(plugin_meta)
        _loaded_plugins.append(plugin_meta)
        _hook_modules[plugin_id] = router_mod

        # 최초 1회 on_install 훅(설치 플래그로 추적)
        try:
            if not await _installed_flag(plugin_id):
                await run_plugin_hook(plugin_id, "on_install")
                await _installed_flag(plugin_id, True)
        except Exception as e:
            logger.error("[Plugins] %s: on_install 처리 실패: %s", plugin_id, e)

    # 순서: order 있는 것(작은 순) → 없는 것(폴더 이름순). 로드(라우터 마운트)는 폴더 이름순 그대로
    _loaded_plugins.sort(key=plugin_sort_key)
    print(f"[Plugins] loaded {len(_loaded_plugins)} plugin(s): {[p['id'] for p in _loaded_plugins]}")
