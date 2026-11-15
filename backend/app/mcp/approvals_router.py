"""승인 대기함·채팅 승인 카드 API — /api/approvals (S3, 시안 A·B).

같은 요청 객체(app.mcp.writes.to_dict)를 채팅 카드와 승인 대기함이 함께 쓴다.

GET    /api/approvals?view=pending|history&cursor=   목록(대기함 = high·MCP 요청, 기록 = 처리된 것 전부)
GET    /api/approvals?conversation_id=               그 대화의 요청 전부(대화 다시 열 때 카드 복원)
GET    /api/approvals/count                          대기 건수(실시간 이벤트 approvals.count 의 처음 값)
GET    /api/approvals/{id}                           상세
POST   /api/approvals/{id}/approve                   승인·[실행] → 서버가 실행
POST   /api/approvals/{id}/reject  {reason}          거부(사유는 AI 에게 전달)
POST   /api/approvals/{id}/cancel                    카드 [취소]
PATCH  /api/approvals/{id}  {args}                   [수정] — 대기 중 인자 고치기
POST   /api/approvals/{id}/undo                      되돌리기(실행 후 10분)
GET    /api/approvals/mode                           내장 AI 권한 모드(Claude Code 와 같은 이름)
PUT    /api/approvals/mode  {mode, confirm}          모드 바꾸기 — bypassPermissions 는 confirm=true 필수
POST   /api/approvals/batch {conversation_id, ids?, action}  대화의 대기 low 카드 묶음 실행·취소(ids 없으면 전부)
GET    /api/approvals/rules?conversation_id=         허용·거부 규칙(항상) + 이 대화 허용 + 쓰기 도구 목록
PUT    /api/approvals/rules {allow, deny}            항상 규칙 바꾸기(Claude Code permissions.allow/deny)
DELETE /api/approvals/rules/conversation/{conv}/{tool}  이 대화 허용 하나 빼기
POST   /api/approvals/{id}/approve {remember?}       remember = conversation|always — 실행하고 다시 묻지 않기
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.mcp import writes

router = APIRouter(prefix="/api/approvals", tags=["approvals"])

_HTTP = {"not_found": 404, "conflict": 409, "invalid_argument": 400, "forbidden": 403, "internal": 500}


def _raise(e: writes.WriteError):
    raise HTTPException(status_code=_HTTP.get(e.code, 400), detail=e.message)


class RejectBody(BaseModel):
    reason: str | None = None


class ArgsBody(BaseModel):
    args: dict


class ModeBody(BaseModel):
    mode: str
    confirm: bool = False


class ApproveBody(BaseModel):
    remember: str | None = None   # conversation | always — Claude Code "예, 다시 묻지 않기"


class RulesBody(BaseModel):
    allow: list[str] = []
    deny: list[str] = []


class BatchBody(BaseModel):
    conversation_id: str
    ids: list[str] | None = None
    action: str = "approve"


@router.get("/mode")
async def get_mode(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return {"mode": await writes.get_permission_mode(db, user.id), "modes": list(writes.PERMISSION_MODES)}


@router.put("/mode")
async def put_mode(body: ModeBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if body.mode == "bypassPermissions" and not body.confirm:
        raise HTTPException(status_code=400, detail="바이패스 모드는 확인(confirm=true)이 필요합니다")
    try:
        return {"mode": await writes.set_permission_mode(db, user.id, body.mode)}
    except writes.WriteError as e:
        _raise(e)


@router.post("/batch")
async def batch(body: BatchBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if body.action not in ("approve", "cancel"):
        raise HTTPException(status_code=400, detail="action 은 approve 또는 cancel")
    rows = await writes.batch_decide(db, user, body.conversation_id, body.ids, body.action)
    return {"items": [writes.to_dict(r) for r in rows]}


@router.get("/rules")
async def get_rules(conversation_id: str = Query(""), user: User = Depends(get_current_user),
                    db: AsyncSession = Depends(get_db)):
    return {**await writes.get_rules(db, user.id),
            "conversation": await writes.conv_allowed(user.id, conversation_id or None),
            "tools": writes.write_tool_catalog()}


@router.put("/rules")
async def put_rules(body: RulesBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        return await writes.set_rules(db, user.id, body.model_dump())
    except writes.WriteError as e:
        _raise(e)


@router.delete("/rules/conversation/{conv_id}/{tool}")
async def delete_conv_rule(conv_id: str, tool: str, user: User = Depends(get_current_user)):
    return {"conversation": await writes.set_conv_allowed(user.id, conv_id, tool, False)}


@router.get("")
async def list_approvals(view: str = Query("pending", pattern="^(pending|history)$"),
                         limit: int = Query(50, ge=1, le=100), cursor: str = Query(""),
                         conversation_id: str = Query("", description="이 대화의 요청 전부(채팅 카드 복원용)"),
                         user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        offset = max(0, int(cursor)) if cursor else 0
    except ValueError:
        offset = 0
    rows, more = await writes.list_requests(db, user, view=view, limit=limit, offset=offset,
                                            conversation_id=(conversation_id or None))
    return {
        "items": [writes.to_dict(r) for r in rows],
        "has_more": more,
        "next_cursor": str(offset + len(rows)) if more else None,
        "pending": await writes.pending_count(db, user),
        "history_total": await writes.history_count(db, user),
        "server_now": writes._now().isoformat(),
    }


@router.get("/count")
async def approvals_count(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return {"pending": await writes.pending_count(db, user)}


@router.get("/{req_id}")
async def get_approval(req_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        return writes.to_dict(await writes.get_owned(db, user, req_id))
    except writes.WriteError as e:
        _raise(e)


@router.post("/{req_id}/approve")
async def approve_request(req_id: str, body: ApproveBody | None = None,
                          user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    remember = body.remember if body else None
    if remember not in (None, "conversation", "always"):
        raise HTTPException(status_code=400, detail="remember 는 conversation 또는 always")
    try:
        req = await writes.approve(db, user, req_id)
        if remember:
            await writes.remember_approval(db, user, req, remember)
        return writes.to_dict(req)
    except writes.WriteError as e:
        _raise(e)


@router.post("/{req_id}/reject")
async def reject_request(req_id: str, body: RejectBody | None = None,
                         user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        return writes.to_dict(await writes.reject(db, user, req_id, (body.reason if body else None)))
    except writes.WriteError as e:
        _raise(e)


@router.post("/{req_id}/cancel")
async def cancel_request(req_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        return writes.to_dict(await writes.reject(db, user, req_id, None, cancel=True))
    except writes.WriteError as e:
        _raise(e)


@router.patch("/{req_id}")
async def edit_request(req_id: str, body: ArgsBody, user: User = Depends(get_current_user),
                       db: AsyncSession = Depends(get_db)):
    try:
        return writes.to_dict(await writes.update_args(db, user, req_id, body.args))
    except writes.WriteError as e:
        _raise(e)


@router.post("/{req_id}/undo")
async def undo_request(req_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        return writes.to_dict(await writes.undo(db, user, req_id))
    except writes.WriteError as e:
        _raise(e)
