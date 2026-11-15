"""화면 안 AI API — 로직은 app.ai.inline.

- GET  /api/ai/inline/status              버튼 상태(쓸 수 있음·막힌 이유·외부 AI·개인정보 가리기·모델 이름)
- POST /api/ai/inline/mail_summary        {message_id, mailbox_id?, account_id?, tz?} → {points, todos[{title,due,who}]}
- POST /api/ai/inline/mail_reply          {message_id, mailbox_id?, account_id?, tone: polite|short, tz?} → {draft}
- POST /api/ai/inline/chat_summary        {channel_id, scope: unread|range, from_message_id?, to_message_id?, tz?}
- POST /api/ai/inline/meeting_summary     {room, chat_lines?[{name,text}], started_at?, tz?} → {points, todos[...]}
- POST /api/ai/inline/doc_proofread       {text, mode: all|style, title?} → {items[{kind,original,fixed,reason}]}
- POST /api/ai/inline/tasks               {source: mail|meeting|chat, room?, items[{title,due_date?,description?,assignee_id?,idempotency_key?}]}

오류는 {detail: {code, message, ...}} — code: module_off·not_configured·external_blocked·rate_limited·daily_limit·
forbidden·not_found·nothing·no_content·too_large·timeout·provider_error·bad_output·invalid_argument.
응답은 스트리밍이 아니라 한 번에(구조화된 결과라 화면이 다 받은 뒤에 그린다).

주의: `from __future__ import annotations` 금지(ai/router.py 머리말과 같은 이유).
"""
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import inline
from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db

router = APIRouter(prefix="/api/ai/inline", tags=["ai"])

_REASON_MSG = {
    "module_off": "AI 기능이 꺼져 있습니다",
    "not_configured": "AI 제공자가 설정되지 않았습니다(관리자에게 문의)",
    "external_blocked": "외부 AI 로 업무 데이터를 보낼 수 없게 막혀 있습니다(관리자 설정)",
}


class MailBody(BaseModel):
    message_id: str = Field(..., min_length=1, max_length=200)
    mailbox_id: str | None = Field(None, max_length=300)
    account_id: str | None = Field(None, max_length=100)
    tone: str = "polite"
    tz: str | None = Field(None, max_length=64)


class ChatBody(BaseModel):
    channel_id: str = Field(..., min_length=1, max_length=36)
    scope: str = "unread"
    from_message_id: str | None = Field(None, max_length=36)
    to_message_id: str | None = Field(None, max_length=36)
    tz: str | None = Field(None, max_length=64)


class ChatLine(BaseModel):
    name: str = Field("", max_length=100)
    text: str = Field("", max_length=4000)


class MeetingBody(BaseModel):
    room: str = Field(..., min_length=1, max_length=200)
    chat_lines: list[ChatLine] = Field(default_factory=list, max_length=inline.MAX_CLIENT_LINES)
    started_at: str | None = Field(None, max_length=40)
    tz: str | None = Field(None, max_length=64)


class DocBody(BaseModel):
    text: str = Field(..., max_length=inline.MAX_DOC_CHARS * 2)
    mode: str = "all"
    title: str | None = Field(None, max_length=300)


class TaskItem(BaseModel):
    title: str = Field(..., max_length=300)
    due_date: str | None = Field(None, max_length=40)
    description: str | None = Field(None, max_length=4000)
    assignee_id: str | None = Field(None, max_length=36)
    idempotency_key: str | None = Field(None, max_length=100)


class TasksBody(BaseModel):
    source: str
    room: str | None = Field(None, max_length=200)
    items: list[TaskItem] = Field(default_factory=list, max_length=50)


def _http(e: "inline.InlineError") -> HTTPException:
    headers = {"Retry-After": str(e.extra["retry_after"])} if e.extra.get("retry_after") else None
    return HTTPException(status_code=e.status, detail={"code": e.code, "message": e.message, **e.extra},
                         headers=headers)


@router.get("/status")
async def inline_status(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await inline.status(db, user)


async def _run(kind: str, db: AsyncSession, user: User, body: BaseModel, fn, **kwargs):
    started = time.monotonic()
    arg_keys = sorted(k for k, v in body.model_dump().items() if v not in (None, "", []))
    a = await inline.availability(db, user)
    if a["reason"]:
        raise HTTPException(status_code=403 if a["reason"] != "not_configured" else 400,
                            detail={"code": a["reason"], "message": _REASON_MSG[a["reason"]]})
    try:
        await inline.enforce_limits(db, user)
    except inline.InlineError as e:
        raise _http(e)
    mask_on = bool(a["external"] and a["mask_pii"])
    try:
        out = await fn(db, user, a["cfg"], mask_on, **kwargs)
    except inline.InlineError as e:
        await inline.record(user, kind, ok=False, error_code=e.code, started=started, arg_keys=arg_keys)
        raise _http(e)
    except HTTPException as e:
        # 메일 API 등 원래 경로의 거절(권한·없음·메일 서버 오류)을 그대로 — 우회하지 않는다
        await inline.record(user, kind, ok=False, error_code=str(e.status_code), started=started, arg_keys=arg_keys)
        msg = e.detail if isinstance(e.detail, str) else "요청을 처리하지 못했습니다"
        code = {403: "forbidden", 404: "not_found"}.get(e.status_code, "source_error")
        raise HTTPException(status_code=e.status_code, detail={"code": code, "message": msg})
    await inline.record(user, kind, ok=True, error_code=None, started=started, arg_keys=arg_keys)
    return {**out, "ai_generated": True, "external": a["external"], "masked": mask_on}


@router.post("/mail_summary")
async def mail_summary(body: MailBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await _run("mail_summary", db, user, body, inline.mail_summary, message_id=body.message_id,
                      mailbox_id=body.mailbox_id, account_id=body.account_id, tz=body.tz)


@router.post("/mail_reply")
async def mail_reply(body: MailBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await _run("mail_reply", db, user, body, inline.mail_reply, message_id=body.message_id,
                      mailbox_id=body.mailbox_id, account_id=body.account_id, tone=body.tone, tz=body.tz)


@router.post("/chat_summary")
async def chat_summary(body: ChatBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await _run("chat_summary", db, user, body, inline.chat_summary, channel_id=body.channel_id,
                      scope=body.scope, from_message_id=body.from_message_id, to_message_id=body.to_message_id,
                      tz=body.tz)


@router.post("/meeting_summary")
async def meeting_summary(body: MeetingBody, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    return await _run("meeting_summary", db, user, body, inline.meeting_summary, room=body.room,
                      chat_lines=[c.model_dump() for c in body.chat_lines], started_at=body.started_at, tz=body.tz)


@router.post("/doc_proofread")
async def doc_proofread(body: DocBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await _run("doc_proofread", db, user, body, inline.doc_proofread, text=body.text, mode=body.mode,
                      title=body.title)


@router.post("/tasks")
async def create_tasks(body: TasksBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """AI 가 뽑은 할 일 중 사용자가 고른 것을 등록 — app.mcp.writes 쓰기 요청(low)으로, 버튼이 곧 승인."""
    try:
        return await inline.create_tasks(db, user, source=body.source, room=body.room,
                                         items=[i.model_dump() for i in body.items])
    except inline.InlineError as e:
        raise _http(e)
