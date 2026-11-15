"""플러그인 개발 SDK — backend/router.py 에서 쓰는 편의 re-export + 헬퍼.

예)
    from app.plugins.sdk import APIRouter, get_current_user, get_db, register_tool

    router = APIRouter()

    # 라이프사이클 훅(선택): db 인자, sync/async 모두 가능
    async def on_install(db): ...      # 최초 설치 1회(테이블 시드 등)
    async def on_enable(db): ...       # 활성화 시
    async def on_disable(db): ...      # 비활성화 시
    async def on_uninstall(db): ...    # 삭제 시(정리)

    # AI(MCP) 도구 등록(선택): Claude/로컬LLM이 거버넌스 게이트웨이를 통해 호출
    async def _summarize(user, text: str):
        return {"summary": text[:100]}
    register_tool("notes_summarize", "메모 요약", {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    }, _summarize)
"""
from fastapi import APIRouter  # noqa: F401

from app.auth.deps import get_current_user  # noqa: F401
from app.db.models import User  # noqa: F401
from app.db.session import get_db  # noqa: F401
from app.modules.registry import require_module  # noqa: F401


def register_tool(name: str, description: str, parameters: dict, handler, requires_user: bool = True) -> None:
    """플러그인이 AI 도구를 등록. requires_user=True면 handler는 user 키워드를 받음.

    등록된 도구는 admin 거버넌스(허용목록/외부데이터정책/사용자동의)를 거쳐 호출되므로,
    외부 AI에 개인데이터가 무단 노출되지 않는다.
    """
    from app.mcp.server import Tool, register
    register(Tool(name=name, description=description, parameters=parameters,
                  handler=handler, requires_user=requires_user))
