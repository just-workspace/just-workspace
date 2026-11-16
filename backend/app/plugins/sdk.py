"""플러그인 개발 SDK — backend/router.py 에서 사용하는 편의 re-export + 헬퍼.

예)
    from app.plugins.sdk import APIRouter, get_current_user, get_db, register_tool

    router = APIRouter()

    # 라이프사이클 훅(선택): db 인자, sync/async 모두 가능
    async def on_install(db): ...      # 최초 설치 1회(테이블 시드 등)
    async def on_enable(db): ...       # 활성화 시
    async def on_disable(db): ...      # 비활성화 시
    async def on_uninstall(db): ...    # 삭제 시(정리)

    # AI 도구 등록(선택): 내장 AI 와 외부 MCP 커넥터가 동일한 게이트를 경유하여 호출한다.
    # 도구는 본 플러그인의 모듈에 귀속된다 — 모듈이 비활성이거나 사용자에게 모듈 권한이 없으면 노출되지 않는다.
    async def _summarize(user, text: str):
        return {"summary": text[:100]}
    register_tool("notes_summarize", "메모 요약", {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    }, _summarize)
"""
import logging
from contextlib import contextmanager
from contextvars import ContextVar

from fastapi import APIRouter  # noqa: F401

from app.auth.deps import get_current_user  # noqa: F401
from app.db.models import User  # noqa: F401
from app.db.session import get_db  # noqa: F401
from app.modules.registry import require_module  # noqa: F401

logger = logging.getLogger(__name__)

# 로더가 현재 로드 중인 플러그인의 id — register_tool 이 도구를 해당 플러그인의 모듈에 귀속시키는 데 사용한다.
_loading_plugin: ContextVar[str | None] = ContextVar("jw_loading_plugin", default=None)
# 플러그인이 등록한 도구 → 등록한 플러그인 id
_plugin_tools: dict[str, str] = {}


@contextmanager
def loading_plugin(plugin_id: str):
    """로더 전용 — 본 블록 내에서 호출된 register_tool 은 도구를 `plugin_id` 모듈에 귀속시킨다."""
    token = _loading_plugin.set(plugin_id)
    try:
        yield
    finally:
        _loading_plugin.reset(token)


def plugin_tools(plugin_id: str | None = None) -> dict[str, str]:
    """플러그인이 등록한 도구 → 플러그인 id. `plugin_id` 지정 시 해당 플러그인의 도구만 반환한다."""
    return {n: p for n, p in _plugin_tools.items() if plugin_id is None or p == plugin_id}


def unregister_plugin_tools(plugin_id: str | None = None) -> None:
    """플러그인이 등록한 도구를 제거한다(로드 실패·재로드). 내장 도구는 변경하지 않는다."""
    from app.mcp.access import TOOL_MODULE
    from app.mcp.server import WORKSPACE_TOOLS

    for name in list(plugin_tools(plugin_id)):
        WORKSPACE_TOOLS.pop(name, None)
        TOOL_MODULE.pop(name, None)
        _plugin_tools.pop(name, None)


def register_tool(name: str, description: str, parameters: dict, handler, requires_user: bool = True) -> bool:
    """플러그인이 AI 도구를 등록한다. requires_user=True 이면 handler 는 `user` 키워드를 수신한다.

    도구는 **등록한 플러그인의 모듈**(= manifest 의 id)에 귀속된다. 접근 판정(`app.mcp.access.tool_accessible`)은
    내장 도구와 동일하다: 해당 모듈이 활성 상태이고 사용자에게 모듈 권한이 있는 경우에만 내장 AI 와 MCP 커넥터에 노출된다.
    개인 데이터를 처리하는 도구로 취급되어 외부 AI 제공자에 대한 관리자 정책·사용자 동의도 동일하게 적용된다.

    - 이미 존재하는 이름(내장 도구, 다른 플러그인의 도구)은 등록하지 않고 False 를 반환한다 — 이름에 플러그인 id 를 포함하여 사용한다.
    - 플러그인 로드 중이 아닐 때(로더 외부에서) 호출하면 도구는 등록되나 어느 모듈에도 귀속되지 않아 노출되지 않는다.
    """
    from app.mcp.access import TOOL_MODULE
    from app.mcp.server import WORKSPACE_TOOLS, Tool, register

    owner = _loading_plugin.get()
    if (name in WORKSPACE_TOOLS or name in TOOL_MODULE) and (owner is None or _plugin_tools.get(name) != owner):
        logger.error("[Plugins] %s: 도구 이름 %r 은 이미 쓰이고 있어 등록하지 않습니다", owner or "?", name)
        return False
    register(Tool(name=name, description=description, parameters=parameters,
                  handler=handler, requires_user=requires_user))
    if owner is None:
        logger.warning("[Plugins] 도구 %r: 플러그인을 올리는 중이 아니어서 모듈에 묶지 못했습니다 — 노출되지 않습니다", name)
        return True
    _plugin_tools[name] = owner
    TOOL_MODULE[name] = owner
    return True
