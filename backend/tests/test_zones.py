"""구역(zone) — 설치된 구역의 라우터·루프만 등록되는지 검증.

JW_ZONES 가 없으면 전부 설치(기존 동작), 있으면 명시된 구역과 core 만 설치. 선언(zones.json)과
표(app/zones.py 의 ROUTERS·LOOPS)의 불일치·노후화 여부도 본 모듈에서 검증.
"""

import inspect
import logging

import pytest
from fastapi import APIRouter

from app import zones

# 구역별 대표 경로 1개 — 해당 구역 라우터의 등록 여부를 확인하는 지표
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
    """앱의 라우트를 평탄화 — 신규 FastAPI 는 include_router 한 라우터를 묶음 단위로 보유하므로 전개가 필요하다."""
    try:
        from fastapi.routing import iter_route_contexts
    except ImportError:  # 묶음이 없는 구버전 FastAPI — app.routes 가 이미 평탄함
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
    # 표의 라우터가 누락 없이 순서대로 등록됨
    assert len(zones.active_routers()) == len(zones.ROUTERS)
    assert len(zones.active_loops()) == len(zones.LOOPS)


def test_module_level_app_matches_factory(monkeypatch):
    """기존 진입점 app.main:app — 동일 환경에서 생성한 create_app() 과 라우트가 동일하다(순서 포함)."""
    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    from app.main import app, create_app

    fresh = _table(create_app())
    current = _table(app)
    # 다른 테스트가 app 에 경로를 추가했을 수 있으므로(마운트 등) 앞부분만 비교
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
    assert set(zones.active_socket_handlers()) == {"send_message", "toggle_reaction", "typing", "mark_read"}

    for zone_id in ("mail", "calendar", "docs", "meetings", "git", "ai", "rbi"):
        assert not _has(app, ZONE_PATHS[zone_id]), f"{zone_id} 경로가 남아 있다"
    for prefix in (
        "/api/contacts", "/api/tasks", "/api/wiki", "/api/board",
        "/api/ai-connect", "/api/approvals", "/api/admin/ai", "/api/dashboard/briefing",
        "/dav", "/.well-known/caldav", "/.well-known/carddav",
        "/.well-known/autoconfig", "/autodiscover", "/mail/config-v1.1.xml",
    ):
        assert not _has(app, prefix), prefix
    # 음성 채널은 회의 구역이 필요
    assert not any("/voice/" in p for p in paths)
    assert "RbiHostGuard" not in _middleware_names(app)
    # 대시보드(코어)는 유지
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
    """구역을 제외해도 나머지 경로의 상대 순서는 전부 설치한 경우와 동일하다."""
    from app.main import create_app

    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    full = _table(create_app())
    monkeypatch.setenv(zones.ENV_VAR, "mail,chat,calendar,docs")
    part = _table(create_app())
    assert len(part) < len(full)
    it = iter(full)
    assert all(row in it for row in part)  # part 는 full 의 부분열


# ─── 실시간 소켓은 코어 — 채팅 구역이 없어도 등록됨 ───


def test_realtime_socket_without_chat(monkeypatch):
    """알림·배지·통화 상태가 이 소켓으로 전달된다. 채팅 프레임 처리기만 채팅 구역 설치 여부를 따른다."""
    from app.main import create_app

    monkeypatch.setenv(zones.ENV_VAR, "mail,meetings")
    app = create_app()
    assert "/ws/chat" in _paths(app)
    assert not _has(app, "/api/chat/")
    assert zones.active_socket_handlers() == {}

    monkeypatch.setenv(zones.ENV_VAR, "nope-zone-z")      # core 만
    assert "/ws/chat" in _paths(create_app())

    monkeypatch.delenv(zones.ENV_VAR)
    assert "send_message" in zones.active_socket_handlers()


def test_socket_position_unchanged(monkeypatch):
    """소켓 라우터는 ROUTERS 의 기존 위치를 유지한다 — 전부 설치한 경우 라우트 순서가 변경되지 않는다."""
    targets = [t for _, t in zones.ROUTERS]
    at = targets.index("app.realtime.socket:router")
    assert targets[at - 1] == "app.chat.voice:router" and targets[at + 1] == "app.chat.voice_relay:router"
    assert dict((t, r) for r, t in zones.ROUTERS)["app.realtime.socket:router"] == zones.CORE


def test_old_websocket_import_path_reexports():
    """구 경로 app.chat.websocket 의 이름들은 코어 소켓의 동일 객체이다."""
    from app.chat import websocket as old
    from app.realtime import socket as new

    assert old.manager is new.manager and old.router is new.router
    assert old.ConnectionManager is new.ConnectionManager and old.chat_ws is new.chat_ws
    for name in ("PUBSUB_MSG", "PUBSUB_PRESENCE", "PUBSUB_TYPING", "PUBSUB_NOTIFICATION", "_Conn", "_authenticate_ws"):
        assert getattr(old, name) is getattr(new, name), name


def test_socket_handler_table_imports():
    for requirement, target in zones.SOCKET_HANDLERS:
        handlers = zones.resolve(target)
        assert handlers and all(inspect.iscoroutinefunction(fn) for fn in handlers.values()), target
        assert "ping" not in handlers        # ping 은 소켓이 직접 응답


@pytest.mark.asyncio
async def test_socket_subscribes_no_channels_without_chat(monkeypatch, db_session):
    from app.realtime import socket

    monkeypatch.setenv(zones.ENV_VAR, "mail")
    assert await socket._user_channel_ids(db_session, "nobody") == []


# ─── 미설치 구역은 상태 점검·검색·대시보드에서 제외 ───


def test_health_checks_follow_zones(monkeypatch):
    from app.services import health
    from app.services.schemas import ServiceStatus

    def names() -> set[str]:
        return {d["name"] for d in health._build_service_defs()}

    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    assert {"Gitea", "PostgreSQL", "Redis"} <= names()

    monkeypatch.setenv(zones.ENV_VAR, "chat")
    assert names() == {"PostgreSQL", "Redis"}
    monkeypatch.setenv(zones.ENV_VAR, "git")
    assert names() == {"PostgreSQL", "Redis", "Gitea"}

    # 점검 표의 구역 이름 노후화 방지
    monkeypatch.delenv(zones.ENV_VAR)
    known = {zones.CORE, *zones.all_zone_ids()}
    assert all(d["zone"] in known for d in health._build_service_defs())

    # 공개 상태 — 미설치 구역의 묶음은 "꺼짐"이 아니라 항목 자체가 없음
    monkeypatch.setenv(zones.ENV_VAR, "chat")
    ok = [ServiceStatus(name=n, url=None, status="ok", response_ms=3, internal_only=True) for n in ("PostgreSQL", "Redis")]
    keys = {s["key"] for s in health.build_public_status(cache=ok, module_enabled=lambda _m: True, checked_at=1.0)["services"]}
    assert keys == {"auth", "chat", "files"}


def test_search_targets_follow_zones(monkeypatch):
    from app.search.router import VALID_MODULES, searchable_modules

    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    assert searchable_modules("") == VALID_MODULES
    assert searchable_modules("chat,nope") == {"chat"}

    monkeypatch.setenv(zones.ENV_VAR, "chat")
    assert searchable_modules("") == {"chat", "files"}
    assert searchable_modules("wiki,board,tasks,calendar,contacts") == set()   # 명시해도 검색하지 않음
    monkeypatch.setenv(zones.ENV_VAR, "calendar,docs")
    assert searchable_modules("") == {"files", "calendar", "contacts", "tasks", "wiki", "board"}


def test_checklist_items_follow_zones(monkeypatch):
    from types import SimpleNamespace
    from app.dashboard.checklist import ITEMS, visible_items

    member, admin = SimpleNamespace(is_admin=False), SimpleNamespace(is_admin=True)
    monkeypatch.delenv(zones.ENV_VAR, raising=False)
    assert visible_items(member) == ITEMS

    monkeypatch.setenv(zones.ENV_VAR, "mail")              # 채팅·회의 없음
    ids = [i for i, _, _ in visible_items(member)]
    assert "first_message" not in ids and "invite_colleague" not in ids and "upload_file" in ids
    assert dict((i, link) for i, _, link in visible_items(admin))["invite_colleague"] == "/admin/users"

    monkeypatch.setenv(zones.ENV_VAR, "chat")              # 채팅만 — 초대는 채널로
    items = dict((i, link) for i, _, link in visible_items(member))
    assert items["invite_colleague"] == "/chat" and "first_message" in items


@pytest.mark.asyncio
async def test_dashboard_summary_drops_uninstalled(monkeypatch, db_session):
    from app.dashboard.router import dashboard_summary
    from app.db.models import User

    user = User(id="zone-u1", username="zone-u1", email="zone-u1@x", password_hash="x")
    db_session.add(user)
    await db_session.commit()
    zone_keys = {"tasks", "tasks_due_today", "tasks_overdue", "recent_posts_7d", "recent_messages_7d",
                 "upcoming_events_7d", "today_events", "next_meeting", "mail_unread"}

    monkeypatch.setenv(zones.ENV_VAR, "git")               # 대시보드가 조회하는 구역이 하나도 없음
    out = await dashboard_summary(day_start=None, day_end=None, user=user, db=db_session)
    assert not (zone_keys & set(out)), zone_keys & set(out)
    assert {"status", "unread_notifications", "mentions_unread", "active_share_links", "admin"} <= set(out)

    monkeypatch.setenv(zones.ENV_VAR, "chat,calendar,docs")
    out = await dashboard_summary(day_start=None, day_end=None, user=user, db=db_session)
    assert zone_keys - {"mail_unread"} <= set(out) and "mail_unread" not in out


def test_plugin_zone_requirement(monkeypatch):
    from app.plugins.loader import missing_zones

    monkeypatch.setenv(zones.ENV_VAR, "chat")
    assert missing_zones({"zones": ["meetings"]}) == ["meetings"]
    assert missing_zones({"zones": ["chat"]}) == [] and missing_zones({}) == []
    monkeypatch.delenv(zones.ENV_VAR)
    assert missing_zones({"zones": ["meetings", "chat"]}) == []


@pytest.mark.asyncio
async def test_plugin_with_missing_zone_is_not_loaded(monkeypatch, tmp_path):
    import json

    from fastapi import FastAPI
    from app.plugins import loader

    plugin_dir = tmp_path / "needs-meetings"
    plugin_dir.mkdir()
    (plugin_dir / "manifest.json").write_text(json.dumps({
        "id": "needs-meetings", "name": "회의에 기대는 플러그인", "route": "/p/needs-meetings",
        "api_prefix": "/api/plugins/needs-meetings", "zones": ["meetings"],
    }), encoding="utf-8")
    monkeypatch.setattr(loader, "PLUGIN_DIRS", [tmp_path])
    monkeypatch.setattr(loader, "_loaded_plugins", [])
    monkeypatch.setattr(loader, "_skipped_plugins", [])
    monkeypatch.setattr(loader, "_hook_modules", {})
    monkeypatch.setenv(zones.ENV_VAR, "chat")

    app = FastAPI()
    await loader.load_plugins(app)
    assert loader.get_loaded_plugins() == []
    assert loader.get_skipped_plugins() == [{
        "id": "needs-meetings", "name": "회의에 기대는 플러그인",
        "reason": "zone_not_installed", "missing_zones": ["meetings"],
    }]
    assert not any(getattr(r, "path", "").startswith("/api/plugins/needs-meetings") for r in app.routes)


def test_bundled_plugin_manifests_name_known_zones():
    """리포에 포함된 플러그인 manifest 의 zones 는 알려진 구역 id 만 참조한다."""
    import json
    from pathlib import Path

    plugins_dir = Path(__file__).resolve().parents[2] / "plugins"
    if not plugins_dir.is_dir():
        pytest.skip("plugins 디렉터리가 없는 실행 환경")
    known = set(zones.all_zone_ids())
    for manifest_path in plugins_dir.glob("*/manifest.json"):
        wanted = json.loads(manifest_path.read_text(encoding="utf-8")).get("zones", [])
        assert set(wanted) <= known, f"{manifest_path.parent.name}: {wanted}"


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
    # core 의 모듈은 항상 설치
    assert zones.module_installed("files")
    assert zones.module_installed("dashboard")
    # zones.json 어디에도 없는 id(플러그인 모듈 등)는 차단하지 않음
    assert zones.module_installed("some-plugin")

    monkeypatch.delenv(zones.ENV_VAR)
    assert zones.module_installed("mail") and zones.module_installed("rbi")


def test_unknown_zone_id_is_warned_and_ignored(monkeypatch, caplog):
    monkeypatch.setenv(zones.ENV_VAR, "chat, nope-zone-x ,CORE, Mail")
    with caplog.at_level(logging.WARNING, logger="app.zones"):
        installed = zones.installed_zones()
    assert installed == {"chat", "mail"}          # 대소문자·공백 무시, core 는 명시해도 무해
    assert "nope-zone-x" in caplog.text
    assert zones.installed_zone_ids() == ["mail", "chat"]   # zones.json 선언 순서

    # 알려진 id 가 하나도 없으면 core 만 — "전부"로 fallback 하지 않음
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


# ─── registry — 미설치 구역의 모듈은 목록에 없으며 활성화 불가 ───


def test_registry_hides_uninstalled_modules(monkeypatch):
    from app.modules import registry

    monkeypatch.setenv(zones.ENV_VAR, "chat")
    ids = {m["id"] for m in registry._all_modules()}
    assert ids == {"chat", "files"}
    monkeypatch.setitem(registry._module_states, "mail", True)   # DB 에 활성화 상태로 남아 있어도
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


# ─── (d) 선언의 노후화 방지 ───


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
    """구역 id 는 중복되지 않으며, 내장 모듈은 모두 zones.json 의 특정 구역(또는 core)에 속한다."""
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
    # presets 는 알려진 구역만 참조
    for name, preset in data.get("presets", {}).items():
        assert set(preset) <= set(ids), name
