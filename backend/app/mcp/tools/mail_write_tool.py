"""메일 쓰기 도구(S3) — 임시저장(low)·발송(high).

웹 작성 화면과 같은 경로를 쓴다: 메일 라우터의 save_draft / send_message 를 그대로 부른다
(모듈 사용 여부·그룹 권한(require_module), 본인 계정 확인(_get_account), 서명 정리, 보낸편지함 복사,
최근 수신인 기록이 웹과 같다). 보내는 계정은 언제나 사용자 본인의 기본 계정이다.
"""

from __future__ import annotations

import html as _html
import logging
from email.utils import getaddresses

from app.db.models import User
from app.db.session import async_session
from app.mcp.server import Tool, register
from app.mcp.tools._common import UNDO_HINT, UNDO_TOKEN_PARAM, check_undo_token, err, http_err, undo_token

logger = logging.getLogger(__name__)

_MAX_RECIPIENTS = 50
_BODY_MAX = 200_000


def _as_list(v: object) -> list[str]:
    if v in (None, ""):
        return []
    if isinstance(v, str):
        return [v]
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if x not in (None, "")]
    return [str(v)]


def parse_addrs(v: object) -> list[dict]:
    """"홍길동 <a@b.c>", "a@b.c", "a@b.c, d@e.f" → [{"name","email"}]. 잘못된 주소는 ValueError."""
    out: list[dict] = []
    for name, addr in getaddresses(_as_list(v)):
        addr = (addr or "").strip()
        if not addr:
            continue
        local, _, domain = addr.rpartition("@")
        if not local or not domain or "@" in domain or any(c.isspace() for c in addr):
            raise ValueError(f"메일 주소 형식이 아닙니다: {addr}")
        out.append({"name": (name or None), "email": addr})
    return out


def _internal_domain() -> str:
    try:
        from app.config import get_settings

        return (get_settings().domain or "").lower().strip(".")
    except Exception:  # noqa: BLE001
        return ""


def _is_external(addr: str, home: str) -> bool:
    dom = addr.rpartition("@")[2].lower().strip(".")
    if not home or home == "localhost":
        return True
    return not (dom == home or dom.endswith("." + home))


def _recipients(args: dict) -> list[str]:
    out = []
    for k in ("to", "cc", "bcc"):
        try:
            out += [a["email"] for a in parse_addrs(args.get(k))]
        except ValueError:
            out += _as_list(args.get(k))
    return out


def summarize_recipients(args: dict) -> str:
    """"받는 사람 4명(외부 1) · 제목" — 승인 카드 대상 요약."""
    rc = _recipients(args)
    home = _internal_domain()
    ext = sum(1 for a in rc if _is_external(a, home))
    s = f"받는 사람 {len(rc)}명" + (f"(외부 {ext})" if ext else "")
    subj = str(args.get("subject") or "").strip()
    return s + (f" · {subj}" if subj else "")


def _preview(args: dict) -> list[dict]:
    home = _internal_domain()
    rows = []
    for k, label in (("to", "받는 사람"), ("cc", "참조"), ("bcc", "숨은 참조")):
        vals = _as_list(args.get(k))
        if not vals:
            continue
        try:
            addrs = [a["email"] for a in parse_addrs(vals)]
        except ValueError:
            addrs = vals
        rows.append({"field": k, "label": label, "before": None,
                     "after": ", ".join(a + (" (외부)" if _is_external(a, home) else "") for a in addrs)})
    rows.append({"field": "subject", "label": "제목", "before": None, "after": args.get("subject") or ""})
    rows.append({"field": "body", "label": "본문", "before": None, "after": args.get("body") or ""})
    return rows


def _text_to_html(text: str) -> str:
    paras = (text or "").split("\n")
    return "".join(f"<p>{_html.escape(p) if p else '<br>'}</p>" for p in paras)


def _addr_args(to, cc, bcc):
    from app.mail.schemas import EmailAddress

    t, c, b = parse_addrs(to), parse_addrs(cc), parse_addrs(bcc)
    if len(t) + len(c) + len(b) > _MAX_RECIPIENTS:
        raise ValueError(f"받는 사람은 모두 {_MAX_RECIPIENTS}명까지입니다")
    return ([EmailAddress(**a) for a in t], [EmailAddress(**a) for a in c], [EmailAddress(**a) for a in b])


# ── 임시저장(low) ─────────────────────────────────────────────
async def mail_save_draft(user: User, subject: str = "", body: str = "", to: object = None,
                          cc: object = None, bcc: object = None, attachments: list | None = None,
                          **_: object) -> dict:
    from app.mail import router as mr
    from app.mail.schemas import DraftSave

    if len(body or "") > _BODY_MAX:
        return err("too_large", f"본문이 너무 깁니다(상한 {_BODY_MAX}자)")
    try:
        t, c, b = _addr_args(to, cc, bcc)
    except ValueError as e:
        return err("invalid_argument", str(e))
    try:
        async with async_session() as db:
            d = await mr.save_draft(
                DraftSave(subject=subject or "", to=t, cc=c, bcc=b,
                          body_text=body or "", body_html=_text_to_html(body or ""),
                          file_attachments=_paths(attachments)),
                user=user, db=db)
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    return {"draft_id": d.id, "subject": d.subject, "to": [a.email for a in d.to],
            "attachments": [{"path": f["path"], "name": f["name"], "size": f["size"]} for f in d.file_attachments],
            "note": "임시보관함에 저장했습니다. 보내지는 않았습니다.",
            "_undo": {"tool": "mail_undo_save_draft",
                      "args": {"draft_id": d.id, "token": undo_token(user.id, "mail_draft", d.id)}}}


async def mail_undo_save_draft(user: User, draft_id: str, token: str, **_: object) -> dict:
    from app.mail import router as mr

    if not check_undo_token(token, user.id, "mail_draft", str(draft_id)):
        return err("forbidden", "이 도구로 만든 임시저장이 아니라 지우지 않습니다")
    try:
        async with async_session() as db:
            await mr.delete_draft(str(draft_id), user=user, db=db)      # 본인 것만(404)
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    return {"deleted_draft": draft_id}


# ── 발송(high) ────────────────────────────────────────────────
async def mail_send(user: User, to: object, subject: str = "", body: str = "", cc: object = None,
                    bcc: object = None, in_reply_to: str = "", attachments: list | None = None,
                    **_: object) -> dict:
    from app.mail import router as mr
    from app.mail.schemas import SendMessageRequest

    if len(body or "") > _BODY_MAX:
        return err("too_large", f"본문이 너무 깁니다(상한 {_BODY_MAX}자)")
    try:
        t, c, b = _addr_args(to, cc, bcc)
    except ValueError as e:
        return err("invalid_argument", str(e))
    if not t:
        return err("invalid_argument", "받는 사람(to)이 없습니다")
    from app.mail import smtp_client as _smtp

    from app.mail import file_attach
    from app.mail.schemas import AttachmentRef

    _ai_tok = _smtp.AI_GENERATED.set("yes; just-workspace AI; approved-by-user")
    try:
        async with async_session() as db:
            refs = None
            if _paths(attachments):
                try:
                    metas = await file_attach.resolve(db, user, _paths(attachments))   # 보낼 때 권한·크기 다시
                    refs = [AttachmentRef(**x) for x in await file_attach.to_blobs(db, user, metas)]
                except file_attach.AttachError as e:
                    return err(e.code, e.message)
            r = await mr.send_message(
                SendMessageRequest(to=t, cc=c, bcc=b, subject=subject or "", text_body=body or "",
                                   in_reply_to=(in_reply_to or None), attachments=refs),
                user=user, db=db)
    except Exception as e:  # noqa: BLE001
        he = http_err(e)
        if he:
            return he
        raise
    finally:
        _smtp.AI_GENERATED.reset(_ai_tok)
    if not (isinstance(r, dict) and r.get("ok")):
        return err("internal", "메일을 보내지 못했습니다")
    return {"sent": True, "to": [a.email for a in t], "cc": [a.email for a in c],
            "bcc_count": len(b), "subject": subject or "", "attachments": len(_paths(attachments) or [])}


def _paths(v) -> list[str] | None:
    if v in (None, "", []):
        return None
    if isinstance(v, str):
        return [v]
    return [str(x) for x in v if x] if isinstance(v, list) else None


_ADDR_SCHEMA = {
    "type": "array", "items": {"type": "string"},
    "description": "Email addresses, e.g. [\"홍길동 <hong@example.com>\", \"kim@example.com\"].",
}

register(Tool(
    name="mail_save_draft",
    title="메일 임시저장",
    description=(
        "Save an email as a draft in the user's drafts (does NOT send). The user can review and send "
        "it from the mail app. Plain-text body. `attachments`: workspace file paths (e.g. a zip made by "
        "files_zip) — re-checked with the user's permissions; max 15 MB each / 25 MB total, folders not "
        "allowed (zip them first)."
    ),
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "to": {**_ADDR_SCHEMA, "x-label": "받는 사람", "x-editable": True},
            "cc": {**_ADDR_SCHEMA, "x-label": "참조", "x-editable": True},
            "bcc": {**_ADDR_SCHEMA, "x-label": "숨은 참조", "x-editable": True},
            "subject": {"type": "string", "default": "", "x-label": "제목", "x-editable": True},
            "body": {"type": "string", "default": "", "description": "Plain-text body.",
                     "x-label": "본문", "x-editable": True, "x-multiline": True},
            "attachments": {"type": "array", "items": {"type": "string"}, "x-label": "첨부",
                            "description": "Workspace file paths to attach (my/… or shared/…)."},
        },
    },
    handler=mail_save_draft, previewer=_preview, summarizer=summarize_recipients,
))

register(Tool(
    name="mail_undo_save_draft",
    title="임시저장 되돌리기",
    description="Delete a draft that mail_save_draft just created." + UNDO_HINT,
    scope="mcp:write", risk="low",
    parameters={
        "type": "object",
        "properties": {
            "draft_id": {"type": "string", "x-label": "임시저장 id", "x-hidden": True},
            "token": UNDO_TOKEN_PARAM,
        },
        "required": ["draft_id", "token"],
    },
    handler=mail_undo_save_draft, summarizer=lambda a: "임시저장 메일 삭제",
))

register(Tool(
    name="mail_send",
    title="메일 보내기",
    description=(
        "Send an email from the user's own mail account (plain-text body). Recipients outside the "
        "workspace domain are flagged to the user. Requires the user's approval in the workspace "
        "approval inbox; returns pending_approval — check later with approvals_status. Prefer "
        "mail_save_draft when the user only asked you to write an email. `attachments`: workspace file "
        "paths, re-checked with the user's permissions when sent (15 MB each / 25 MB total)."
    ),
    scope="mcp:write", risk="high",
    parameters={
        "type": "object",
        "properties": {
            "to": {**_ADDR_SCHEMA, "x-label": "받는 사람", "x-editable": True},
            "cc": {**_ADDR_SCHEMA, "x-label": "참조", "x-editable": True},
            "bcc": {**_ADDR_SCHEMA, "x-label": "숨은 참조", "x-editable": True},
            "subject": {"type": "string", "default": "", "x-label": "제목", "x-editable": True},
            "body": {"type": "string", "default": "", "description": "Plain-text body.",
                     "x-label": "본문", "x-editable": True, "x-multiline": True},
            "in_reply_to": {"type": "string", "default": "",
                            "description": "Optional: message id (UID from mail_search, or Message-ID) this replies to.",
                            "x-label": "답장 대상", "x-hidden": True},
            "attachments": {"type": "array", "items": {"type": "string"}, "x-label": "첨부",
                            "description": "Workspace file paths to attach (my/… or shared/…)."},
        },
        "required": ["to"],
    },
    # 남에게 보인다 — 외부 내용을 읽은 뒤에는 자동 수락·허용 규칙이어도 묻는다(writes.request_write)
    visible_to_others=True,
    handler=mail_send, previewer=_preview, summarizer=summarize_recipients,
))
