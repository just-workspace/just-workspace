"""approvals_status — AI 가 자신이 제출한 쓰기 요청의 결과를 확인한다.

claude.ai 는 high 위험 쓰기(삭제·발송·외부 공유)를 호출하면 `pending_approval` + `approval_id` 를
수신한다. 사용자가 승인 대기함에서 처리한 뒤 이 도구로 결과(실행 결과·실패·거부 사유·만료)를 조회한다.
"""

from app.db.models import User
from app.mcp.server import Tool, register
from app.mcp.tools._common import err


async def approvals_status(user: User, approval_id: str, **_: object) -> dict:
    from app.mcp import writes

    async with writes.session() as db:
        try:
            req = await writes.get_owned(db, user, str(approval_id))
        except writes.WriteError as e:
            return err("not_found" if e.code == "not_found" else "internal", e.message)
        view = writes._model_view(req)
        d = writes.to_dict(req)
    view.update({
        "status": d["status"] if d["status"] != "pending" else view.get("status"),
        "reject_reason": d["reject_reason"],
        "error": d["error"],
        "result": d["result"],
        "expires_at": d["expires_at"],
        "decided_at": d["decided_at"],
    })
    return view


register(Tool(
    name="approvals_status",
    description=(
        "Check the outcome of a write you requested that needed the user's approval "
        "(status `pending_approval`). Returns status: pending_approval, executed (with result), "
        "failed (with error), rejected (with `reject_reason` — the user's instruction to you), "
        "canceled or expired. Do not poll rapidly; check when the user says they handled it."
    ),
    parameters={
        "type": "object",
        "properties": {
            "approval_id": {"type": "string", "description": "`approval_id` from the pending write."},
        },
        "required": ["approval_id"],
    },
    handler=approvals_status,
))
