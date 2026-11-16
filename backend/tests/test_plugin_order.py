"""플러그인 manifest "order" — 레일·메뉴·플러그인 목록 정렬.

order(정수, 작을수록 위)가 있는 항목이 우선, 없는 항목은 기존과 같이 폴더 이름순으로 후순위.
라우터 마운트(로드) 순서는 폴더 이름순 유지.
"""

import json
from pathlib import Path

import pytest
from fastapi import FastAPI

from app.modules import registry
from app.modules.registry import parse_plugin_order, plugin_sort_key
from app.plugins import loader


def test_parse_plugin_order():
    assert parse_plugin_order(3) == 3
    assert parse_plugin_order(-1) == -1
    assert parse_plugin_order(0) == 0
    for bad in (None, True, False, 1.5, "2", [1]):
        assert parse_plugin_order(bad) is None


def test_sort_key_order_first_then_rest_stable():
    metas = [
        {"id": "a"},                 # order 없음(폴더 이름순 첫째)
        {"id": "b", "order": 20},
        {"id": "c"},
        {"id": "d", "order": 10},
        {"id": "e", "order": 20},    # b 와 같은 order → 원래 순서(b 먼저)
        {"id": "f", "order": 0},
    ]
    assert [m["id"] for m in sorted(metas, key=plugin_sort_key)] == ["f", "d", "b", "e", "a", "c"]


def _make_plugin(base: Path, folder: str, pid: str, order=None, *, with_order_key=True):
    d = base / folder
    (d / "backend").mkdir(parents=True)
    manifest = {"id": pid, "name": pid, "route": f"/{pid}", "api_prefix": f"/api/plugins/{pid}"}
    if with_order_key and order is not None:
        manifest["order"] = order
    (d / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (d / "backend" / "router.py").write_text(
        "from fastapi import APIRouter\nrouter = APIRouter()\n", encoding="utf-8"
    )


@pytest.mark.anyio
async def test_load_plugins_sorts_by_order(tmp_path, monkeypatch):
    base = tmp_path / "plugins"
    _make_plugin(base, "a-first", "pa")                 # order 없음
    _make_plugin(base, "b-second", "pb", 5)
    _make_plugin(base, "c-third", "pc")                 # order 없음
    _make_plugin(base, "d-fourth", "pd", 1)
    _make_plugin(base, "e-fifth", "pe", "x")           # 정수 아님 → 없음으로 처리

    monkeypatch.setattr(loader, "PLUGIN_DIRS", [base])

    async def _flag(plugin_id, set_to=None):
        return True  # on_install 생략(DB 없이)

    monkeypatch.setattr(loader, "_installed_flag", _flag)
    monkeypatch.setattr(registry, "_plugin_modules", [])

    mounted: list[str] = []
    app = FastAPI()
    orig = app.include_router

    def _spy(router, prefix="", **kw):
        mounted.append(prefix)
        return orig(router, prefix=prefix, **kw)

    monkeypatch.setattr(app, "include_router", _spy)
    await loader.load_plugins(app)

    want = ["pd", "pb", "pa", "pc", "pe"]
    assert [p["id"] for p in loader.get_loaded_plugins()] == want
    assert [p["id"] for p in registry._plugin_modules] == want
    assert {p["id"]: p["order"] for p in loader.get_loaded_plugins()} == {"pa": None, "pb": 5, "pc": None, "pd": 1, "pe": None}
    # 로드(마운트)는 폴더 이름순 유지
    assert mounted == [f"/api/plugins/{x}" for x in ("pa", "pb", "pc", "pd", "pe")]


@pytest.mark.anyio
async def test_platform_modules_carry_order(monkeypatch):
    monkeypatch.setattr(registry, "_plugin_modules", [])
    for pid, order in (("zz", None), ("yy", 2), ("xx", 1)):
        registry.register_plugin_module({
            "id": pid, "name": pid, "icon": "puzzle", "route": f"/{pid}", "type": "plugin",
            "requires": [], "default_enabled": True, "order": order,
        })

    async def _no_redis():
        raise RuntimeError("no redis")

    monkeypatch.setattr(registry, "get_redis", _no_redis)
    mods = await registry.get_enabled_modules()
    plug = [m for m in mods if m["type"] == "plugin"]
    assert [(m["id"], m["order"]) for m in plug] == [("xx", 1), ("yy", 2), ("zz", None)]
