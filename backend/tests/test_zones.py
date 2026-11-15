"""구역(zone) — 설치된 구역만 라우터·루프가 올라오는지.

JW_ZONES 가 없으면 전부 설치(기존 동작), 있으면 적힌 구역과 core 만. 선언(zones.json)과
표(app/zones.py 의 ROUTERS·LOOPS)가 서로 어긋나거나 썩지 않는지도 여기서 지킨다.
"""

import inspect
import logging

import pytest
from fastapi import APIRouter

from app import zones

# 구역마다 대표 경로 하나씩 — 그 구역 라우터가 올라왔는지 보는 표지
ZONE_PATHS = {
    "mail": "/api/mail/",
    "chat": "/api/chat/",
    "calendar": "/api/calendar/",
    "docs": "/api/wopi/",
    "meetings": "/api/meetings/",
    "git": "/api/git/",
    "ai": "/api/ai/",
    "rbi": "/api/rbi/",
}
CORE_PATHS = ["/api/auth/", "/api/files/", "/api/admin/", "/api/platform/modules", "/api/health", "/api/search"]


def _routes(app) -> list:
    """앱의 라우트를 한 줄로 — 새 FastAPI 는 include_router 한 라우터를 묶음째 들고 있어 풀어야 한다."""
    try:
        from fastapi.routing import iter_route_contexts
    except ImportError:  # 묶음이 없는 옛 FastAPI — app.routes 가 이미 평평하다
        return list(app.routes)
    return list(iter_route_contexts(app.routes))


def _table(app) -> list[tuple[str, tuple[str, ...]]]:
    return [(r.path, tuple(sorted(getattr(r, "methods", None) or []))) for r in _routes(app)]


def _paths(app) -> list[str]:
    return [r.path for r in _routes(app)]


def _has(app, prefix: str) -> bool:
    return any(p.startswith(prefix) for p in _paths(app))


def _middleware_names(app) -> list[str]:
    return [m.cls.__name__ for m in app.user_middleware]


# ─── (a) JW_ZONES 없음 → 전부 ───


def test_unset_means_everything_installed(monkeypatch):
    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    assert zones.installed_zones() == set(zones.all_zone_ids())
    monkeypatch.setenv(zones.ENV_VAR, "")
    assert zones.installed_zones() == set(zones.all_zone_ids())
    monkeypatch.setenv(zones.ENV_VAR, " , ")
    assert zones.installed_zones() == set(zones.all_zone_ids())


def test_default_app_has_every_zone(monkeypatch):
    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    from app.main import create_app

    app = create_app()
    for zone_id, prefix in ZONE_PATHS.items():
        assert _has(app, prefix), f"{zone_id}: {prefix} 가 라우트 표에 없다"
    for prefix in CORE_PATHS:
        assert _has(app, prefix), prefix
    paths = _paths(app)
    assert "/dav" in paths
    assert "/.well-known/caldav" in paths and "/.well-known/carddav" in paths
    assert "/ws/chat" in paths
    assert "/api/chat/voice/states" in paths
    assert "/api/dashboard/briefing" in paths
    assert "RbiHostGuard" in _middleware_names(app)
    # 표의 라우터가 하나도 빠지지 않고 순서대로 들어갔다
    assert len(zones.active_routers()) == len(zones.ROUTERS)
    assert len(zones.active_loops()) == len(zones.LOOPS)


def test_module_level_app_matches_factory(monkeypatch):
    """기존 진입점 app.main:app — 같은 환경에서 만든 create_app() 과 라우트가 같다(순서 포함)."""
    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    from app.main import app, create_app

    fresh = _table(create_app())
    current = _table(app)
    # 다른 테스트가 app 에 경로를 덧붙였을 수 있으니(마운트 등) 앞부분만 견준다
    assert current[: len(fresh)] == fresh


# ─── (b) JW_ZONES=chat → core 와 chat 만 ───


def test_only_chat_zone(monkeypatch):
    monkeypatch.setenv(zones.ENV_VAR, "chat")
    from app.main import create_app

    app = create_app()
    paths = _paths(app)

    for prefix in CORE_PATHS:
        assert _has(app, prefix), prefix
    assert _has(app, "/api/chat/")
    assert "/ws/chat" in paths
    assert _has(app, "/api/webhooks")

    for zone_id in ("mail", "calendar", "docs", "meetings", "git", "ai", "rbi"):
        assert not _has(app, ZONE_PATHS[zone_id]), f"{zone_id} 경로가 남아 있다"
    for prefix in (
        "/api/contacts", "/api/tasks", "/api/wiki", "/api/board",
        "/api/ai-connect", "/api/approvals", "/api/admin/ai", "/api/dashboard/briefing",
        "/dav", "/.well-known/caldav", "/.well-known/carddav",
        "/.well-known/autoconfig", "/autodiscover", "/mail/config-v1.1.xml",
    ):
        assert not _has(app, prefix), prefix
    # 음성 채널은 회의 구역이 있어야 한다
    assert not any("/voice/" in p for p in paths)
    assert "RbiHostGuard" not in _middleware_names(app)
    # 대시보드(코어)는 그대로
    assert _has(app, "/api/dashboard")

    loops = {target for req, target in zones.LOOPS if zones.requirement_met(req)}
    assert "app.files.indexer:run_indexer" in loops
    assert "app.mail.poller:run_poller" not in loops
    assert "app.mail.scheduled:run_scheduled_sender" not in loops
    assert "app.meetings.calls:run_call_state_loop" not in loops
    assert "app.main:_reminder_loop" not in loops
    assert "app.rbi.service:run_reaper" not in loops
    assert "app.ai.ops_retention:run_ai_retention" not in loops


def test_voice_needs_chat_and_meetings(monkeypatch):
    from app.main import create_app

    monkeypatch.setenv(zones.ENV_VAR, "meetings")
    assert not any("/voice/" in p for p in _paths(create_app()))
    monkeypatch.setenv(zones.ENV_VAR, "chat,meetings")
    paths = _paths(create_app())
    assert "/api/chat/voice/states" in paths
    assert "/api/chat/channels/{channel_id}/voice/relay-token" in paths


def test_route_order_is_stable_subset(monkeypatch):
    """구역을 빼도 남은 경로의 상대 순서는 전부 설치했을 때와 같다."""
    from app.main import create_app

    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    full = _table(create_app())
    monkeypatch.setenv(zones.ENV_VAR, "mail,chat,calendar,docs")
    part = _table(create_app())
    assert len(part) < len(full)
    it = iter(full)
    assert all(row in it for row in part)  # part 는 full 의 부분열


# ─── (c) module_installed · 알 수 없는 id ───


def test_module_installed(monkeypatch):
    monkeypatch.setenv(zones.ENV_VAR, "chat,calendar")
    assert zones.zone_installed("core")
    assert zones.zone_installed("chat")
    assert not zones.zone_installed("mail")
    assert not zones.zone_installed("no-such-zone")

    assert zones.module_installed("chat")
    assert zones.module_installed("tasks")       # calendar 구역
    assert zones.module_installed("contacts")
    assert not zones.module_installed("mail")
    assert not zones.module_installed("wiki")    # docs 구역
    assert not zones.module_installed("rbi")     # addon
    # core 의 모듈은 늘 설치
    assert zones.module_installed("files")
    assert zones.module_installed("dashboard")
    # zones.json 어디에도 없는 id(플러그인 모듈 등)는 막지 않는다
    assert zones.module_installed("some-plugin")

    monkeypatch.delenv(zones.ENV_VAR)
    assert zones.module_installed("mail") and zones.module_installed("rbi")


def test_unknown_zone_id_is_warned_and_ignored(monkeypatch, caplog):
    monkeypatch.setenv(zones.ENV_VAR, "chat, nope-zone-x ,CORE, Mail")
    with caplog.at_level(logging.WARNING, logger="app.zones"):
        installed = zones.installed_zones()
    assert installed == {"chat", "mail"}          # 대소문자·공백 무시, core 는 적어도 무해
    assert "nope-zone-x" in caplog.text
    assert zones.installed_zone_ids() == ["mail", "chat"]   # zones.json 선언 순서

    # 아는 id 가 하나도 없으면 core 만 — "전부"로 되돌아가지 않는다
    monkeypatch.setenv(zones.ENV_VAR, "nope-zone-y")
    assert zones.installed_zones() == set()


def test_addons_are_zones_too(monkeypatch):
    assert {"sso", "rbi"} <= set(zones.all_zone_ids())
    monkeypatch.setenv(zones.ENV_VAR, "rbi")
    from app.main import create_app

    app = create_app()
    assert _has(app, "/api/rbi/")
    assert "RbiHostGuard" in _middleware_names(app)
    assert not _has(app, "/api/chat/")


# ─── registry — 미설치 구역의 모듈은 목록에 없고 켤 수 없다 ───


def test_registry_hides_uninstalled_modules(monkeypatch):
    from app.modules import registry

    monkeypatch.setenv(zones.ENV_VAR, "chat")
    ids = {m["id"] for m in registry._all_modules()}
    assert ids == {"chat", "files"}
    monkeypatch.setitem(registry._module_states, "mail", True)   # DB 에 켜짐으로 남아 있어도
    monkeypatch.setitem(registry._module_states, "chat", True)
    assert registry.is_module_enabled("mail") is False
    assert registry.is_module_enabled("chat") is True

    monkeypatch.delenv(zones.ENV_VAR)
    assert {m["id"] for m in registry._all_modules()} >= {m["id"] for m in registry.BUILTIN_MODULES}
    assert registry.is_module_enabled("mail") is True


@pytest.mark.asyncio
async def test_registry_refuses_to_enable_uninstalled(monkeypatch, db_session):
    from fastapi import HTTPException
    from app.modules import registry

    monkeypatch.setenv(zones.ENV_VAR, "chat")
    assert await registry.set_module_enabled(db_session, "mail", True) is False

    listed = {m["id"] for m in await registry.get_enabled_modules(db_session)}
    assert "mail" not in listed and "chat" in listed
    await registry._invalidate_modules_cache()

    @registry.require_module("mail")
    async def endpoint():
        return "ok"

    with pytest.raises(HTTPException) as exc:
        await endpoint()
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_site_config_lists_zones(client, monkeypatch):
    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    data = (await client.get("/api/health")).json()
    assert data["zones"] == list(zones.all_zone_ids())

    monkeypatch.setenv(zones.ENV_VAR, "chat,docs")
    data = (await client.get("/api/health")).json()
    assert data["zones"] == ["chat", "docs"]


# ─── (d) 선언이 썩지 않게 ───


def test_tables_reference_known_zones():
    known = {zones.CORE, *zones.all_zone_ids()}
    for requirement, target in (*zones.ROUTERS, *zones.LOOPS):
        for zone_id in requirement.split("+"):
            assert zone_id in known, f"{target}: 모르는 구역 {zone_id!r}"
    assert len({t for _, t in zones.ROUTERS}) == len(zones.ROUTERS), "같은 라우터가 두 번"
    assert len({t for _, t in zones.LOOPS}) == len(zones.LOOPS), "같은 루프가 두 번"


def test_every_router_and_loop_imports():
    for _, target in zones.ROUTERS:
        assert isinstance(zones.resolve(target), APIRouter), target
    for _, target in zones.LOOPS:
        assert inspect.iscoroutinefunction(zones.resolve(target)), target


def test_zone_ids_unique_and_builtin_modules_owned():
    """구역 id 는 겹치지 않고, 내장 모듈은 모두 zones.json 의 어느 구역(또는 core)에 속한다."""
    from app.modules.registry import BUILTIN_MODULES

    ids = zones.all_zone_ids()
    assert len(set(ids)) == len(ids) and zones.CORE not in ids
    owner = zones._module_owner()
    for mod in BUILTIN_MODULES:
        assert mod["id"] in owner, f"내장 모듈 {mod['id']} 이 zones.json 에 없다"
    # 한 모듈은 한 구역만 소유한다
    data = zones.load_zones()
    seen: dict[str, str] = {}
    for zone in (data["core"], *data["zones"], *data["addons"]):
        for module_id in zone["modules"]:
            assert module_id not in seen, f"{module_id}: {seen.get(module_id)} 와 {zone['id']} 가 함께 소유"
            seen[module_id] = zone["id"]
    # presets 는 아는 구역만 가리킨다
    for name, preset in data.get("presets", {}).items():
        assert set(preset) <= set(ids), name
