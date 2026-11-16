"""도구 접근 판정 — MCP(claude.ai 등)와 내장 AI 가 **동일 함수**를 사용한다.

기존에는 판정이 두 곳에 분리되어 있었다:
  - MCP: http_server.TOOL_MODULE 에 없는 도구 = "모듈 없음" = 항상 허용 → mail_read·채팅·게시판·
    캘린더·연락처·할일이 모듈 off·RBAC 를 무시하고 노출되었다.
  - 내장 AI: 모듈·RBAC 검사가 전혀 없었고, 외부 AI 로의 데이터 전송을 차단하는 DATA_TOOLS 목록에도
    동일 도구들이 누락되어 있었다.
둘 다 **fail-closed** 로 변경한다: 맵에 없는 도구는 노출하지 않고, 비개인 도구만 명시한다.
"""

from __future__ import annotations

import json
import logging

from sqlalchemy import select

from app.db.models import SystemSetting, User

logger = logging.getLogger(__name__)

# 주의: 모든 도구는 본 맵에 등록되어야 한다. 미등록 도구는 노출하지 않는다.
# 값 = 해당 기능 모듈 id(관리자 on/off + 그룹 RBAC 대상). 모듈이 실제로 없는 도구만 None.
TOOL_MODULE: dict[str, str | None] = {
    "workspace_context": None,
    "files_list": "files",
    "files_read": "files",
    "files_search": "files",
    "files_recent": "files",
    "files_stat": "files",
    "notes_search": "wiki",
    "notes_list": "wiki",
    "notes_read": "wiki",
    "notes_create": "wiki",
    "mail_search": "mail",
    "mail_read": "mail",
    "mail_read_attachment": "mail",
    "chat_list_channels": "chat",
    "chat_read_messages": "chat",
    "board_list_posts": "board",
    "board_search": "board",
    "board_read_post": "board",
    "calendar_list_events": "calendar",
    "calendar_list_calendars": "calendar",
    "contacts_search": "contacts",
    "tasks_list": "tasks",
    # ── 쓰기 도구(되돌리기 보조 도구 포함) ──
    "files_write_text": "files",
    "files_create_folder": "files",
    "files_copy": "files",
    "files_move": "files",
    "files_undo_create": "files",
    "files_delete": "files",
    "files_share_external": "files",
    "mail_save_draft": "mail",
    "mail_undo_save_draft": "mail",
    "mail_send": "mail",
    "calendar_create_event": "calendar",
    "calendar_undo_create_event": "calendar",
    "calendar_update_event": "calendar",
    "calendar_delete_event": "calendar",
    "tasks_create": "tasks",
    "tasks_undo_create": "tasks",
    "tasks_update": "tasks",
    "tasks_delete": "tasks",
    "notes_undo_create": "wiki",
    "notes_update": "wiki",
    "notes_delete": "wiki",
    "board_create_post": "board",
    "board_undo_create_post": "board",
    "board_add_comment": "board",
    "board_undo_add_comment": "board",
    "board_delete_post": "board",
    "chat_send_message": "chat",
    "chat_undo_send_message": "chat",
    "web_search": None,
    "approvals_status": None,
    # ── 결과물 — 문서 생성은 기능 모듈이 없다(본인만 수신하는 임시 결과물). 파일 읽기·쓰기는 files ──
    "docs_create": None,
    "docs_create_bundle": None,
    "docs_job_status": None,
    "artifacts_save_to_files": "files",
    "files_zip": "files",
    "files_job_status": "files",
    "files_archive_list": "files",
    "files_unzip": "files",
    # ── 파일 도구(웹 읽기·PDF·Office 편집·변환·분석 샌드박스) ──
    "web_fetch": None,
    "pdf_inspect": "files",
    "pdf_merge": "files",
    "pdf_split": "files",
    "pdf_extract_pages": "files",
    "pdf_rotate": "files",
    "pdf_delete_pages": "files",
    "pdf_fill_form": "files",
    "pdf_watermark": "files",
    "docx_edit": "files",
    "xlsx_edit": "files",
    "pptx_edit": "files",
    "files_convert": "files",
    "code_run": "files",
}

# 사용자 개인 데이터에 접근하지 않는 도구. 여기에 없는 도구는 전부 "개인 데이터 도구"로 간주한다
# (외부 AI 제공자로 내용이 전송되면 민감 → 관리자 허용 + 사용자 동의 필요).
# 문서 생성은 대화 내 내용만 사용하고 개인 데이터를 읽지 않는다(외부 AI 데이터 차단과 무관).
NON_DATA_TOOLS = frozenset({"web_search", "workspace_context", "docs_create", "docs_create_bundle", "docs_job_status", "web_fetch"})

# 관리자 스위치가 별도로 있는 도구 — {도구: (설정 키, 기본값)}. 비활성화 시 내장 AI·MCP 어디에도 노출되지 않는다.
TOOL_SWITCH: dict[str, tuple[str, bool]] = {
    "code_run": ("ai.gov.code_run_enabled", True),
}
# 외부 커넥터(MCP) 노출을 별도로 활성화해야 하는 도구 — 기본 비활성화(내장 AI 전용으로 시작). 내장 AI 에는 영향 없음.
MCP_OPT_IN: dict[str, tuple[str, bool]] = {
    "code_run": ("ai.gov.code_run_mcp", False),
}


WRITE_SETTING = "mcp.write_enabled"


async def write_enabled(db) -> bool:
    """관리자 스위치 — AI(외부 커넥터) 쓰기 허용. 기본 활성화(사용자 결정: 내부 쓰기는 허용)."""
    try:
        v = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == WRITE_SETTING))
    except Exception:  # noqa: BLE001
        return True
    return (v or "true").strip().lower() not in ("false", "0", "off")


async def _bool_setting(db, key: str, default: bool) -> bool:
    try:
        v = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == key))
    except Exception:  # noqa: BLE001
        return default
    if v is None or str(v).strip() == "":
        return default
    return str(v).strip().lower() not in ("false", "0", "off")


async def tool_switched_on(db, name: str) -> bool:
    sw = TOOL_SWITCH.get(name)
    return True if sw is None else await _bool_setting(db, *sw)


async def mcp_exposed(db, name: str) -> bool:
    """MCP(claude.ai 등) 에 이 도구를 노출할지 여부 — MCP_OPT_IN 도구는 관리자가 활성화해야 노출된다."""
    opt = MCP_OPT_IN.get(name)
    return True if opt is None else await _bool_setting(db, *opt)


def is_data_tool(name: str) -> bool:
    return name not in NON_DATA_TOOLS


async def module_enabled(db, module_id: str) -> bool:
    """DB 기준 모듈 상태(워커 8개 안전), 실패 시 캐시."""
    from app.modules.registry import _module_key, is_module_enabled

    try:
        v = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == _module_key(module_id)))
        if v is not None:
            return bool(json.loads(v))
    except Exception:
        pass
    return is_module_enabled(module_id)


async def tool_accessible(db, user: User | None, name: str) -> bool:
    """모듈 on/off + RBAC. 스코프(읽기/쓰기 엔드포인트) 판정은 호출자가 별도로 수행한다."""
    from app.groups import service as groups_service

    if name not in TOOL_MODULE:
        logger.warning("[mcp] tool %s has no TOOL_MODULE entry — hidden (fail-closed)", name)
        return False
    if not await tool_switched_on(db, name):
        return False
    module_id = TOOL_MODULE[name]
    if module_id is None:
        return True
    if user is None:
        return False
    if not await module_enabled(db, module_id):
        return False
    return bool(await groups_service.user_can_access(db, user.id, module_id, bool(user.is_admin)))
