"""AI 쓰기 요청 — 위험도별 2단계 승인.

쓰기 도구(scope="mcp:write")는 직접 실행하지 않고 :func:`request_write` 를 거친다.

    low  + MCP(claude.ai 등) : claude.ai 가 자체 도구 승인을 받았으므로 즉시 실행.
                               단, 직전에 외부 내용을 읽었으면(인젝션 위험) 즉시 실행하지 않고
                               승인 대기함에 등록한다.
    low  + 내장 AI           : 채팅 카드 [실행]을 대기한다(5분).
    high (출처 무관)         : 승인 대기함에서 사용자가 승인해야 서버가 실행한다(30분).

도구 핸들러는 결과 dict 에 ``_undo: {"tool", "args"}`` 를 포함하여 역연산을 지정할 수 있다.
되돌리기는 실행 후 10분 이내에만 허용한다. 역연산은 승인 없이 즉시 실행한다(사용자 본인의 조작).
"""

from __future__ import annotations

import inspect
import json
import logging
import secrets
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from app.db.models import McpWriteRequest, User

logger = logging.getLogger(__name__)

LOW_TTL = timedelta(minutes=5)
HIGH_TTL = timedelta(minutes=30)
UNDO_WINDOW = timedelta(minutes=10)
UNTRUSTED_WINDOW_SEC = 15 * 60       # 외부 내용 읽기 이후 15분 이내의 쓰기는 경고·자동실행 금지(턴 수와 무관)

# ── 권한 모드(Claude Code 와 동일한 이름·의미) ───────────────────────
# default            low=카드 [실행] · high=승인 대기함 (기존 동작)
# acceptEdits        low(되돌리기 가능한 생성·수정)는 즉시 실행 · high 는 사용자 확인 요청
# plan               쓰기 도구를 실행하지 않는다(모델은 계획만 제시)
# auto               low 즉시 실행 · high 도 즉시 실행하되, 직전에 외부 내용(메일·웹)을 읽었으면 승인 대기함(주입 방어)
# bypassPermissions  확인 없이 전부 실행
# 예외(모든 모드·허용 규칙 공통): 동일 대화에서 타인이 작성한 내용을 읽은 이후의 '타인에게 노출되는 쓰기'
# (Tool.visible_to_others — 채팅 발송·게시글·댓글·메일 발송 등)는 사용자 확인을 요청한다. 주입 → 사칭 발송 방어.
# 내장 AI(source="ai")에만 적용한다 — 외부 MCP 클라이언트는 기존 규칙 유지.
PERMISSION_MODES = ("default", "acceptEdits", "plan", "auto", "bypassPermissions")
PERMISSION_PREF_KEY = "ai.permission_mode"


async def get_permission_mode(db, user_id: str) -> str:
    try:
        from app.me.prefs import get_prefs

        v = (await get_prefs(db, user_id)).get(PERMISSION_PREF_KEY)
    except Exception:  # noqa: BLE001
        v = None
    return v if v in PERMISSION_MODES else "default"


# ── 허용·거부 규칙(Claude Code permissions.allow/deny) ──────────
# 내장 AI(source="ai")에만 적용. 거부 > 허용 > 모드 순서로 판정한다.
#   항상(계정): 사용자 설정 ai.permission_rules = {"allow": [tool], "deny": [tool]}
#   이 대화만: Redis 집합(대화 단위, 30일) — 카드의 "예, 이 대화에서는 다시 묻지 않기"
RULES_PREF_KEY = "ai.permission_rules"
CONV_RULE_TTL = 30 * 86400
MAX_RULES = 100
_local_conv_rules: dict[str, set[str]] = {}


def _write_tool_names() -> set[str]:
    from app.mcp.server import WORKSPACE_TOOLS

    return {n for n, t in WORKSPACE_TOOLS.items() if getattr(t, "scope", "") == "mcp:write"}


def write_tool_catalog() -> list[dict]:
    """규칙 화면용 — 쓰기 도구 이름·제목·기본 위험도."""
    from app.mcp.server import WORKSPACE_TOOLS

    out = []
    for n in sorted(_write_tool_names()):
        t = WORKSPACE_TOOLS[n]
        out.append({"name": n, "title": getattr(t, "title", None) or n, "risk": getattr(t, "risk", "low") or "low"})
    return out


def _clean_rules(raw) -> dict:
    known = _write_tool_names()
    raw = raw if isinstance(raw, dict) else {}
    deny = [t for t in dict.fromkeys(raw.get("deny") or []) if isinstance(t, str) and t in known][:MAX_RULES]
    allow = [t for t in dict.fromkeys(raw.get("allow") or []) if isinstance(t, str) and t in known and t not in deny][:MAX_RULES]
    return {"allow": allow, "deny": deny}


async def get_rules(db, user_id: str) -> dict:
    try:
        from app.me.prefs import get_prefs

        return _clean_rules((await get_prefs(db, user_id)).get(RULES_PREF_KEY))
    except Exception:  # noqa: BLE001
        return {"allow": [], "deny": []}


async def set_rules(db, user_id: str, rules: dict) -> dict:
    raw = rules if isinstance(rules, dict) else {}
    known = _write_tool_names()
    bad = [t for t in list(raw.get("allow") or []) + list(raw.get("deny") or []) if t not in known]
    if bad:
        raise WriteError("invalid_argument", f"쓰기 도구가 아닙니다: {', '.join(map(str, bad[:5]))}")
    clean = _clean_rules(raw)
    from app.me.prefs import set_server_pref

    await set_server_pref(db, user_id, RULES_PREF_KEY, clean if (clean["allow"] or clean["deny"]) else None)
    try:
        from app.db.models import AuditLog

        db.add(AuditLog(actor_id=user_id, action="ai_permission_rules.set", resource_type="user_prefs",
                        resource_id=user_id[:36], details=_j(clean)))
        await db.commit()
    except Exception:  # noqa: BLE001
        await db.rollback()
    return clean


async def add_rule(db, user_id: str, kind: str, tool: str) -> dict:
    cur = await get_rules(db, user_id)
    other = "deny" if kind == "allow" else "allow"
    cur[other] = [t for t in cur[other] if t != tool]
    if tool not in cur[kind]:
        cur[kind].append(tool)
    return await set_rules(db, user_id, cur)


def _conv_key(user_id: str, conv_id: str) -> str:
    return f"ai:perm:conv:{user_id}:{conv_id}"


async def conv_allowed(user_id: str, conv_id: str | None) -> list[str]:
    if not conv_id:
        return []
    try:
        from app.chat.redis_client import get_redis

        r = await get_redis()
        vals = await r.smembers(_conv_key(user_id, conv_id))
        return sorted(v.decode() if isinstance(v, bytes) else str(v) for v in (vals or []))
    except Exception:  # noqa: BLE001
        return sorted(_local_conv_rules.get(_conv_key(user_id, conv_id), set()))


async def set_conv_allowed(user_id: str, conv_id: str, tool: str, on: bool) -> list[str]:
    key = _conv_key(user_id, conv_id)
    try:
        from app.chat.redis_client import get_redis

        r = await get_redis()
        if on:
            await r.sadd(key, tool)
            await r.expire(key, CONV_RULE_TTL)
        else:
            await r.srem(key, tool)
    except Exception:  # noqa: BLE001
        s = _local_conv_rules.setdefault(key, set())
        (s.add if on else s.discard)(tool)
    return await conv_allowed(user_id, conv_id)


async def rule_for(db, user_id: str, tool: str, conv_id: str | None) -> str | None:
    """'deny' | 'allow' | None — 거부 우선."""
    rules = await get_rules(db, user_id)
    if tool in rules["deny"]:
        return "deny"
    if tool in rules["allow"] or tool in await conv_allowed(user_id, conv_id):
        return "allow"
    return None


async def set_permission_mode(db, user_id: str, mode: str) -> str:
    if mode not in PERMISSION_MODES:
        raise WriteError("invalid_argument", f"알 수 없는 권한 모드: {mode}")
    from app.me.prefs import set_server_pref

    await set_server_pref(db, user_id, PERMISSION_PREF_KEY, None if mode == "default" else mode)
    try:
        from app.db.models import AuditLog

        db.add(AuditLog(actor_id=user_id, action="ai_permission_mode.set", resource_type="user_prefs",
                        resource_id=user_id[:36], details=_j({"mode": mode})))
        await db.commit()
    except Exception:  # noqa: BLE001
        await db.rollback()
    return mode


def mode_runs_now(mode: str, risk: str, after_untrusted: bool) -> bool:
    """이 모드에서 확인 없이 즉시 실행하는지 여부(plan 은 호출 전에 차단된다)."""
    if mode == "bypassPermissions":
        return True
    if mode == "auto":
        return risk == "low" or not after_untrusted
    if mode == "acceptEdits":
        return risk == "low"
    return False


TERMINAL = {"executed", "failed", "rejected", "canceled", "expired", "undone"}


def session():
    """DB 세션 진입점 — 테스트에서 교체한다."""
    from app.db.session import async_session

    return async_session()


# ── 호출 맥락 (주체·출처) ─────────────────────────────────────
@dataclass
class CallContext:
    source: str                          # "mcp" | "ai" | "internal"
    client_name: str | None = None       # claude.ai 앱 이름 / 개인 토큰 이름 / "내장 AI(웹)"
    client_kind: str | None = None       # claude_app | personal_token | builtin_web | builtin_desktop | internal
    client_key: str | None = None        # 외부 읽기 표시의 묶음 단위(MCP=client_id, AI=대화 id)
    conversation_id: str | None = None
    extra: dict = field(default_factory=dict)


call_context: ContextVar[CallContext | None] = ContextVar("mcp_call_context", default=None)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ── 직전 외부 읽기 표시 ────────────────────────────────────────
# 워커가 8개이므로 프로세스 메모리로는 공유할 수 없다 → Redis 사용. Redis 가 없으면 프로세스 메모리(best-effort).
_local_marks: dict[str, tuple[float, dict]] = {}


def _mark_key(user_id: str, client_key: str | None) -> str:
    return f"mcp:untrusted:{user_id}:{client_key or '-'}"


async def mark_untrusted_read(user_id: str, client_key: str | None, hint: dict) -> None:
    key = _mark_key(user_id, client_key)
    val = json.dumps({"t": time.time(), "hint": hint}, ensure_ascii=False, default=str)
    try:
        from app.chat.redis_client import get_redis

        r = await get_redis()
        await r.set(key, val, ex=UNTRUSTED_WINDOW_SEC)
        return
    except Exception:  # noqa: BLE001
        pass
    _local_marks[key] = (time.time(), hint)


async def recent_untrusted(user_id: str, client_key: str | None) -> dict | None:
    key = _mark_key(user_id, client_key)
    try:
        from app.chat.redis_client import get_redis

        r = await get_redis()
        raw = await r.get(key)
        if raw:
            d = json.loads(raw)
            return d.get("hint") or {"kind": "external", "label": "외부 내용"}
        return None
    except Exception:  # noqa: BLE001
        pass
    t_hint = _local_marks.get(key)
    if t_hint and time.time() - t_hint[0] < UNTRUSTED_WINDOW_SEC:
        return t_hint[1]
    return None


def untrusted_hint(tool_name: str, result: object) -> dict:
    """외부 읽기 경고(read_external) — {kind, at, from, subject, label}. 승인 대기함 상세 경고에서 표시한다."""
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data = result.get("data") if isinstance(result, dict) and "data" in result else result
    d = {"kind": "external", "at": at, "from": None, "subject": None, "label": tool_name}
    if tool_name in ("mail_read", "mail_read_attachment") and isinstance(data, dict):
        frm = data.get("from")
        d["kind"] = "mail"
        d["from"] = ", ".join(frm) if isinstance(frm, list) else frm
        d["subject"] = data.get("subject") or data.get("name")
        d["label"] = "받은 메일" if tool_name == "mail_read" else "메일 첨부"
    elif tool_name == "mail_search":
        d.update(kind="mail", label="받은 메일 목록")
    elif tool_name == "web_search":
        d.update(kind="web", label="웹 검색 결과")
    elif tool_name == "web_fetch":
        d.update(kind="web", label="웹 페이지",
                 subject=(data.get("final_url") or data.get("url")) if isinstance(data, dict) else None)
    elif tool_name == "files_read" and isinstance(data, dict):
        d.update(kind="file", subject=data.get("path"), label="파일 본문")
    elif tool_name in _WORKSPACE_READ_LABEL:
        # 워크스페이스 내부이나 타인이 작성한 글 — 카드 경고에 읽은 대상을 사용자가 이해할 수 있는 문구로 표시한다
        d.update(kind="workspace", label=_WORKSPACE_READ_LABEL[tool_name],
                 subject=(data.get("title") or data.get("name")) if isinstance(data, dict) else None)
    return d


# ── 대화 단위 외부 읽기 표시(내장 AI) ──────────────────────────
# 위 15분 창은 MCP(턴 개념 없음)용이다. 내장 AI 는 읽은 내용이 대화 맥락에 계속 남아 15분 이후에도 모델에
# 영향을 줄 수 있으므로, '타인에게 노출되는 쓰기' 관문은 대화가 유지되는 동안(허용 규칙과 동일한 30일) 유지한다.
# Redis 조회 실패 시 "읽기 여부 불명" = 읽은 것으로 간주하여 사용자 확인을 요청한다(fail-closed). 프로세스 메모리 fallback 은 두지 않는다
# — 워커가 여러 개이므로 다른 워커가 기록한 표시를 확인하지 못한 채 통과시키기 때문이다.
CONV_MARK_UNKNOWN = {"kind": "external", "label": "외부 내용(읽기 기록을 확인할 수 없음)"}


def _conv_mark_key(user_id: str, conv_id: str) -> str:
    return f"ai:untrusted:conv:{user_id}:{conv_id}"


async def mark_conv_untrusted(user_id: str, conv_id: str | None, hint: dict) -> None:
    if not conv_id:
        return
    key = _conv_mark_key(user_id, conv_id)
    try:
        from app.chat.redis_client import get_redis

        r = await get_redis()
        await r.set(key, json.dumps({"t": time.time(), "hint": hint}, ensure_ascii=False, default=str),
                    ex=CONV_RULE_TTL)
    except Exception:  # noqa: BLE001 — 표시 실패가 읽기를 차단해서는 안 된다(읽는 쪽이 fail-closed 로 처리)
        logger.warning("[mcp-write] conversation untrusted mark failed", exc_info=True)


async def conv_untrusted(user_id: str, conv_id: str | None) -> dict | None:
    if not conv_id:
        return None
    key = _conv_mark_key(user_id, conv_id)
    try:
        from app.chat.redis_client import get_redis

        r = await get_redis()
        raw = await r.get(key)
        if raw:
            return json.loads(raw).get("hint") or {"kind": "external", "label": "외부 내용"}
        return None
    except Exception:  # noqa: BLE001 — 판정 불가 = 사용자 확인 요청
        logger.warning("[mcp-write] conversation untrusted lookup failed — treating as read", exc_info=True)
        return dict(CONV_MARK_UNKNOWN)


async def tool_visible(tool, args: dict | None, user=None) -> bool:
    """타인에게 노출되는 쓰기인지 판정 — 도구 정의의 명시 플래그만 확인한다(이름 기반 추측 없음).
    visible_for(args, user) 는 DB 조회가 필요하면 코루틴이어도 된다. 판정 실패는 '노출'로 간주한다."""
    fn = getattr(tool, "visible_for", None)
    if callable(fn):
        try:
            v = fn(args or {}, user)
            if inspect.isawaitable(v):
                v = await v
            return bool(v)
        except Exception:  # noqa: BLE001 — 판정 실패는 보수적인 쪽으로 처리
            logger.debug("[mcp-write] visible_for failed", exc_info=True)
            return True
    return bool(getattr(tool, "visible_to_others", False))


def reads_others(tool, args: dict | None) -> bool:
    """결과에 타인이 작성한 내용이 포함되는 도구인지 판정(untrusted_output 또는 conv_untrusted) — 내장 AI 대화 표시용."""
    if getattr(tool, "untrusted_output", False):
        return True
    f = getattr(tool, "conv_untrusted", False)
    if callable(f):
        try:
            return bool(f(args or {}))
        except Exception:  # noqa: BLE001
            return True
    return bool(f)


# 승인 카드에 표시할 확인 요청 사유 — untrusted_hint JSON 의 gate 값(DB 컬럼 추가 없이 기존 컬럼에 저장한다).
# 화면에는 사유 코드(ask_reason)로 전달하며 문구는 프런트가 번역한다.
GATE_VISIBLE = "visible_after_untrusted"


_WORKSPACE_READ_LABEL = {
    "chat_read_messages": "채팅 메시지", "board_search": "게시글 검색 결과", "board_read_post": "게시글",
    "notes_search": "위키 검색 결과", "notes_read": "위키 문서", "calendar_list_events": "캘린더 일정",
    "contacts_search": "연락처", "tasks_list": "할 일",
    "ai_attachment": "대화 첨부 파일", "ai_project_knowledge": "프로젝트 지식 파일",
    "ai_project_instructions": "공유 프로젝트 지침",
    # conv_untrusted — 타인이 작성한 글 일부가 포함되는 목록·검색(내장 AI 대화 표시만)
    "files_search": "파일 검색 결과", "files_list": "공유 폴더 목록", "board_list_posts": "게시글 목록",
    "chat_list_channels": "채팅 채널 목록", "notes_list": "위키 문서 목록", "code_run": "코드 실행 결과",
}


# ── 비밀값 마스킹 ──────────────────────────────────────────────
# 외부 공유 링크 비밀번호 등의 값은 실행에 필요하여 인자에 포함되지만, 승인 대기함·카드·감사 기록에
# 평문으로 노출되어서는 안 된다. 화면에서는 마스킹하고, 요청이 종료되면(실행·실패·거부·만료) DB 에서도 삭제한다.
_SECRET_KEYS = ("password", "passwd", "secret", "token", "api_key", "apikey", "credential")


def _is_secret_key(k: str) -> bool:
    kl = str(k).lower()
    return any(x in kl for x in _SECRET_KEYS)


def _mask(args: dict) -> dict:
    return {k: ("••••" if (v not in (None, "") and _is_secret_key(k)) else v) for k, v in (args or {}).items()}


def _scrub(req) -> None:
    """종료된 요청의 인자에서 비밀값을 삭제한다(되돌리기 서명 token 은 실행 후 불필요)."""
    args = _uj(req.args) or {}
    if any(_is_secret_key(k) for k in args):
        req.args = _j({k: ("[삭제됨]" if _is_secret_key(k) and v not in (None, "") else v) for k, v in args.items()})


# ── 직렬화 ─────────────────────────────────────────────────────
def _j(v) -> str:
    return json.dumps(v, ensure_ascii=False, default=str)


def _uj(s: str | None):
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:  # noqa: BLE001
        return None


def _props(tool) -> dict:
    return ((getattr(tool, "parameters", None) or {}).get("properties") or {}) if tool else {}


def _editable(tool) -> list[dict]:
    """인라인 편집 필드 — 스키마에서 x-editable 인 항목만, 한국어 라벨(x-label)과 함께 반환."""
    out = []
    for k, p in _props(tool).items():
        if k == "idempotency_key" or not p.get("x-editable"):
            continue
        out.append({"field": k, "label": p.get("x-label") or k, "type": p.get("type", "string"),
                    "enum": p.get("enum"), "multiline": bool(p.get("x-multiline"))})
    return out


def _preview(tool, args: dict) -> list[dict]:
    """미리보기 diff — [{field,label,before,after}]. 도구 previewer 가 있으면 해당 결과를, 없으면 인자로 '추가' 행을 구성한다."""
    fn = getattr(tool, "previewer", None) if tool else None
    if fn:
        try:
            rows = fn(args)
            if isinstance(rows, list):
                return rows
        except Exception:  # noqa: BLE001
            logger.debug("[mcp-write] previewer failed", exc_info=True)
    props = _props(tool)
    rows = []
    for k, v in (args or {}).items():
        if k == "idempotency_key" or v in (None, "", [], {}):
            continue
        p = props.get(k) or {}
        if p.get("x-hidden") or _is_secret_key(k):
            continue
        rows.append({"field": k, "label": p.get("x-label") or k, "before": None, "after": v})
    return rows


def _summary(tool, args: dict, name: str) -> str:
    fn = getattr(tool, "summarizer", None) if tool else None
    if fn:
        try:
            return str(fn(args))[:300]
        except Exception:  # noqa: BLE001
            pass
    for k in ("path", "title", "subject", "to", "name", "src"):
        v = (args or {}).get(k)
        if v:
            return (", ".join(map(str, v)) if isinstance(v, list) else str(v))[:300]
    return getattr(tool, "title", None) or name


def to_dict(req: McpWriteRequest) -> dict:
    from app.mcp.server import WORKSPACE_TOOLS

    tool = WORKSPACE_TOOLS.get(req.tool)
    args = _mask(_uj(req.args) or {})
    undo_until = _aware(req.undo_until)
    return {
        "id": req.id,
        "tool": req.tool,
        "title": getattr(tool, "title", None) or req.tool,
        "args": args,
        "risk": req.risk,
        "status": req.status,
        "source": req.source,
        "client_kind": req.client_kind,
        "client_name": req.client_name,
        "target_summary": _summary(tool, args, req.tool),
        "conversation_id": req.conversation_id,
        "after_untrusted": bool(req.after_untrusted),
        "read_external": _uj(req.untrusted_hint),
        "ask_reason": (_uj(req.untrusted_hint) or {}).get("gate"),
        "result": _uj(req.result),
        "error": req.error,
        "reject_reason": req.reject_reason,
        "created_at": _aware(req.created_at).isoformat() if req.created_at else None,
        "expires_at": _aware(req.expires_at).isoformat() if req.expires_at else None,
        "decided_at": _aware(req.decided_at).isoformat() if req.decided_at else None,
        "executed_at": _aware(req.executed_at).isoformat() if req.executed_at else None,
        "can_undo": bool(req.status == "executed" and req.undo and undo_until and undo_until > _now()),
        "undo_until": undo_until.isoformat() if undo_until else None,
        "preview": _preview(tool, args),
        "editable": _editable(tool) if req.status == "pending" else [],
        "server_now": _now().isoformat(),
    }


# ── 실행 선점 ─────────────────────────────────────────────────
# 과거에는 approve 가 "대기 상태 여부"를 조회한 뒤 실행했고, 상태는 핸들러 종료 후에야 변경됐다. 실행 시간이 긴 도구
# (메일 발송·변환·코드 실행)가 실행되는 동안 다른 탭·승인 대기함·일괄 실행이 동일 요청을 다시 승인하면 핸들러가
# 2회 실행됐다(메일 2회 발송). 현재는 조건부 UPDATE 1회로 "대기 상태이며 아직 선점되지 않은" 요청만 선점한다.
# 선점 표시는 decided_at — 상태 문자열은 pending 으로 유지되므로 목록·건수·카드·wait_decided 가 읽는 값은 변하지 않는다
# (실행 중 = status pending + decided_at 있음). 거절·취소·수정도 동일 조건으로만 통과한다.
CLAIM_GRACE = timedelta(minutes=10)   # 실행 중인 요청은 만료 시각이 지나도 이 시간 동안은 만료로 변경하지 않는다(서버 비정상 종료로 남은 요청 정리용)


def _unclaimed():
    return (McpWriteRequest.status == "pending") & McpWriteRequest.decided_at.is_(None)


async def _cas(db, req: McpWriteRequest, cond, **values) -> bool:
    """조건이 현재도 참일 때만 값을 변경한다. 변경했으면 True. 어느 경우든 req 를 DB 값으로 다시 읽는다."""
    from sqlalchemy import update

    res = await db.execute(update(McpWriteRequest).where(McpWriteRequest.id == req.id, cond).values(**values)
                           .execution_options(synchronize_session=False))
    await db.commit()
    await db.refresh(req)
    return res.rowcount == 1


async def _claim(db, req: McpWriteRequest) -> bool:
    return await _cas(db, req, _unclaimed(), decided_at=_now())


def _expired_now(req: McpWriteRequest) -> bool:
    """대기 만료 여부 — 실행 중(선점된) 요청에는 유예를 둔다(실행 도중 '만료됨'으로 전환되는 것 방지)."""
    if req.status != "pending":
        return False
    exp = _aware(req.expires_at)
    if req.decided_at is not None:
        exp = exp + CLAIM_GRACE
    return exp < _now()


# ── 만료 ──────────────────────────────────────────────────────
async def expire_due(db, user_id: str | None = None) -> int:
    q = select(McpWriteRequest).where(
        McpWriteRequest.status == "pending",
        or_(McpWriteRequest.decided_at.is_(None) & (McpWriteRequest.expires_at < _now()),
            McpWriteRequest.expires_at < _now() - CLAIM_GRACE))
    if user_id:
        q = q.where(McpWriteRequest.user_id == user_id)
    rows = (await db.execute(q)).scalars().all()
    for r in rows:
        r.status = "expired"
        r.decided_at = _now()
        _scrub(r)
    if rows:
        await db.commit()
        for uid in {r.user_id for r in rows}:
            await emit_count(db, uid)
    return len(rows)


# ── 실행 ──────────────────────────────────────────────────────
async def _run_handler(tool_name: str, args: dict, user: User) -> tuple[dict | None, str | None, dict | None]:
    """(result, error, undo). 쓰기 도구 핸들러를 직접 호출한다(승인 통과 이후)."""
    from app.mcp.server import WORKSPACE_TOOLS

    tool = WORKSPACE_TOOLS.get(tool_name)
    if tool is None:
        return None, f"unknown tool: {tool_name}", None
    kwargs = dict(args or {})
    if tool.requires_user:
        kwargs["user"] = user
    try:
        inspect.signature(tool.handler).bind(**kwargs)
    except TypeError as e:
        return None, f"bad arguments: {e}", None
    try:
        res = await tool.handler(**kwargs)
    except Exception as e:  # noqa: BLE001
        logger.exception("[mcp-write] %s failed", tool_name)
        return None, str(getattr(e, "detail", None) or e) or e.__class__.__name__, None
    if isinstance(res, dict) and isinstance(res.get("error"), str):
        # 오류 코드·힌트(error_code·hint 등)는 결과 필드에 유지하여 모델에 형식을 갖춘 오류로 반환한다
        extra = {k: v for k, v in res.items() if k != "error" and not str(k).startswith("_")}
        return (extra or None), res["error"], None
    undo = None
    if isinstance(res, dict) and isinstance(res.get("_undo"), dict):
        undo = res.pop("_undo")
    return (res if isinstance(res, dict) else {"result": res}), None, undo


async def _execute(db, req: McpWriteRequest, user: User) -> McpWriteRequest:
    args = _uj(req.args) or {}
    # 승인까지 최대 30분 — 그 사이 관리자가 모듈을 비활성화했거나 그룹 권한을 회수했으면 실행하지 않는다
    try:
        from app.mcp.access import tool_accessible

        allowed = await tool_accessible(db, user, req.tool)
    except Exception:  # noqa: BLE001
        allowed = False
    if not allowed:
        result, error, undo = None, "이 기능을 쓸 권한이 없거나 관리자가 기능을 껐습니다", None
    else:
        # 승인 후 실행(카드·대기함)에는 요청 시점의 호출 맥락이 없다 → 행에 저장한 출처·대화로 복원한다
        # (결과물 저장 폴더 "AI 결과물/날짜 대화 제목" 처럼 대화 정보가 필요한 도구가 사용한다).
        ctx_tok = None if call_context.get() is not None else call_context.set(CallContext(
            source=req.source or "internal", client_name=req.client_name, client_kind=req.client_kind,
            client_key=req.conversation_id, conversation_id=req.conversation_id))
        try:
            result, error, undo = await _run_handler(req.tool, args, user)
        except BaseException:
            # 요청 취소·워커 종료로 핸들러가 중단된 경우 — 선점 표시(decided_at)만 남으면 카드는 "대기"로 표시되면서
            # 승인·거절이 전부 409 로 고착된다. 실패로 종료 처리한 뒤 예외를 그대로 전파한다.
            try:
                req.status = "failed"
                req.error = "실행이 중단되었습니다"
                req.executed_at = _now()
                await db.commit()
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            if ctx_tok is not None:
                call_context.reset(ctx_tok)
    req.executed_at = _now()
    if not error and req.source == "ai" and req.conversation_id:
        # 쓰기 도구라도 결과에 타인의 내용이 포함되면(입력 파일을 읽는 코드 실행의 stdout 등) 모델이 이를 읽는다
        # → 대화 표시 기록. 읽기 도구는 app.mcp.server 가 기록한다.
        from app.mcp.server import WORKSPACE_TOOLS

        _tool = WORKSPACE_TOOLS.get(req.tool)
        if _tool is not None and reads_others(_tool, args):
            await mark_conv_untrusted(user.id, req.conversation_id, untrusted_hint(req.tool, result))
    if error:
        req.status = "failed"
        req.error = error[:2000]
        if result:
            req.result = _j(result)
    else:
        req.status = "executed"
        req.result = _j(result)
        if undo:
            req.undo = _j(undo)
            req.undo_until = _now() + UNDO_WINDOW
    _scrub(req)
    await db.commit()
    await _audit(db, user.id, f"ai_write.{req.status}", req)
    return req


async def _audit(db, user_id: str, action: str, req: McpWriteRequest, mode: str | None = None) -> None:
    """audit_logs 에 기록한다(감사 로그의 첫 소비자). 실패해도 본 동작은 차단하지 않는다."""
    try:
        from app.db.models import AuditLog

        db.add(AuditLog(actor_id=user_id, action=action[:100], resource_type="ai_write",
                        resource_id=req.id[:36],
                        details=_j({"tool": req.tool, "risk": req.risk, "source": req.source,
                                    "client": req.client_name, "kind": req.client_kind,
                                    "status": req.status,
                                    **({"mode": mode} if mode and mode != "default" else {}),
                                    # 관문('타인에게 노출되는 쓰기')이 자동 실행을 차단하고 사용자 확인을 요청했다는 표시
                                    **({"gate": gate} if (gate := (_uj(req.untrusted_hint) or {}).get("gate")) else {})})))
        await db.commit()
    except Exception:  # noqa: BLE001
        logger.debug("[mcp-write] audit failed", exc_info=True)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass


async def _notify_pending(db, user: User, req: McpWriteRequest) -> None:
    try:
        from app.notifications.service import create_notification

        who = req.client_name or ("내장 AI" if req.source == "ai" else "AI 커넥터")
        title_tool = to_dict(req)["title"]
        await create_notification(
            db, user.id, "system",
            title=f"승인 요청 — {who}: {title_tool}",
            body=("직전에 외부 내용을 읽은 뒤의 요청입니다. " if req.after_untrusted else "")
                 + "승인 대기함에서 확인하십시오. 30분 후 만료됩니다.",
            link=f"/approvals?id={req.id}",
        )
    except Exception:  # noqa: BLE001
        logger.warning("[mcp-write] notify failed", exc_info=True)


async def emit_count(db, user_id: str, req: "McpWriteRequest | None" = None) -> None:
    """대기 건수 실시간 이벤트 — 레일 배지·벨·토스트가 동일한 값을 사용한다.

    변경된 요청이 있으면 해당 객체(to_dict)를 함께 전달하여 토스트·카드의 재조회를 방지한다.
    """
    try:
        from sqlalchemy import func

        from app.realtime.events import emit_to_user

        n = (await db.execute(select(func.count()).select_from(McpWriteRequest).where(
            McpWriteRequest.user_id == user_id, McpWriteRequest.status == "pending",
            McpWriteRequest.expires_at >= _now(),
            or_(McpWriteRequest.risk == "high", McpWriteRequest.source == "mcp"),
        ))).scalar() or 0
        ev = {"type": "approvals.count", "pending": int(n)}
        if req is not None:
            ev["request"] = to_dict(req)
        await emit_to_user(user_id, ev)
    except Exception:  # noqa: BLE001
        logger.debug("[mcp-write] emit count failed", exc_info=True)


# ── 요청 ──────────────────────────────────────────────────────
async def request_write(db, user: User, tool_name: str, args: dict, *,
                        ctx: CallContext | None = None,
                        idempotency_key: str | None = None) -> dict:
    """쓰기 요청을 생성하고, 위험도·출처에 따라 즉시 실행하거나 대기시킨다.

    반환(모델에 그대로 전달):
      {"status": "executed", "request_id", "result", "can_undo"}
      {"status": "pending_confirmation", "request_id", ...}   — 내장 AI 카드 대기
      {"status": "pending_approval", "approval_id", ...}      — 승인 대기함
      {"status": "failed", "request_id", "error"}
    """
    from app.mcp.server import WORKSPACE_TOOLS

    ctx = ctx or call_context.get() or CallContext(source="internal")
    tool = WORKSPACE_TOOLS.get(tool_name)
    if tool is None:
        return {"status": "failed", "error": f"unknown tool: {tool_name}"}
    risk = tool_risk(tool, args)

    if idempotency_key:
        prev = (await db.execute(select(McpWriteRequest).where(
            McpWriteRequest.user_id == user.id,
            McpWriteRequest.idempotency_key == idempotency_key[:128],
            McpWriteRequest.tool == tool_name,
        ))).scalars().first()
        if prev is not None:
            out = _model_view(prev)
            out["idempotent_replay"] = True
            return out

    rule = await rule_for(db, user.id, tool_name, ctx.conversation_id) if ctx.source == "ai" else None
    if rule == "deny":
        # Claude Code deny 규칙 — 요청 자체를 생성하지 않는다. 모델은 다른 방법을 찾거나 사용자에게 질의한다
        return {"status": "failed", "error_code": "denied_by_rule",
                "error": f"사용자가 '{getattr(tool, 'title', None) or tool_name}' 도구를 거부 규칙으로 막아 두었습니다. "
                         "실행하지 않았습니다. 다른 방법을 쓰거나 사용자에게 어떻게 할지 물어보세요."}

    hint = await recent_untrusted(user.id, ctx.client_key)
    # 내장 AI 의 '타인에게 노출되는 쓰기' — 15분 창이 지났더라도 동일 대화에서 타인이 작성한 내용을 읽었으면 읽기 이후로 간주한다
    visible = ctx.source == "ai" and await tool_visible(tool, args, user)
    if visible and not hint:
        hint = await conv_untrusted(user.id, ctx.conversation_id)
    mode = await get_permission_mode(db, user.id) if ctx.source == "ai" else "default"
    by_mode = mode_runs_now(mode, risk, bool(hint))
    # 읽은 내용이 없었다면 확인 없이 실행됐을 요청인지 판정 — 관문이 결과를 변경한 경우에만 카드에 사유를 첨부한다
    # (auto 모드의 high 는 mode_runs_now 가 이미 차단하지만, 확인 요청 사유는 동일하므로 사유를 함께 포함한다)
    would_run = mode_runs_now(mode, risk, False) or rule == "allow"
    if rule == "allow" and not (risk == "high" and hint):
        # 허용 규칙(항상·이 대화) — 재확인하지 않는다. 단 외부 내용을 읽은 직후의 high 는 계속 사용자 확인을 요청한다
        by_mode = True
        mode = mode if mode != "default" else "rule"
    if visible and hint and (by_mode or would_run):
        # 주입된 지시가 사용자 명의로 글·메시지를 발송하는 경로를 차단한다. acceptEdits·auto·허용 규칙은 물론
        # bypassPermissions 도 예외가 아니다(바이패스는 관리자 전용이 아니며 본인 확인만으로 활성화된다).
        by_mode = False
        hint = {**hint, "gate": GATE_VISIBLE}
    req = McpWriteRequest(
        id="wr_" + secrets.token_hex(6),
        user_id=user.id,
        tool=tool_name,
        args=_j(args or {}),
        risk=risk,
        status="pending",
        source=ctx.source,
        client_name=(ctx.client_name or None) and ctx.client_name[:255],
        client_kind=ctx.client_kind or ("internal" if ctx.source == "internal" else None),
        client_id=((ctx.client_key or None) and ctx.client_key[:255]) if ctx.source == "mcp" else None,
        conversation_id=ctx.conversation_id,
        after_untrusted=bool(hint),
        untrusted_hint=_j(hint) if hint else None,
        idempotency_key=(idempotency_key or None) and idempotency_key[:128],
        expires_at=_now() + (HIGH_TTL if risk == "high" else LOW_TTL),
    )
    # 직전 외부 읽기 이후의 low 쓰기는 MCP 에서도 자동 실행하지 않고 승인 대기함에 등록한다
    auto_run = bool(getattr(tool, "auto_run", False)) and risk == "low"
    escalate = bool(hint) and risk == "low" and ctx.source == "mcp" and not auto_run
    if escalate:
        req.expires_at = _now() + HIGH_TTL
    run_now = by_mode or (risk == "low" and (ctx.source in ("mcp", "internal") or auto_run) and not escalate)
    if run_now:
        # 즉시 실행할 요청은 생성 시점부터 선점 상태로 둔다 — 실행 도중 승인 대기함에서 재승인 불가(_claim 과 동일한 표시)
        req.decided_at = _now()
    db.add(req)
    await db.commit()
    await _audit(db, user.id, "ai_write.requested", req, mode=mode)

    if run_now:
        await _execute(db, req, user)   # 결과는 이 호출의 반환값으로 모델에 즉시 전달된다(대화 보고 불필요)
    elif risk == "high" or escalate:
        await _notify_pending(db, user, req)
        await emit_count(db, user.id, req)
    return _model_view(req)


def _tool_of(name: str):
    from app.mcp.server import WORKSPACE_TOOLS

    return WORKSPACE_TOOLS.get(name)


def tool_risk(tool, args: dict | None) -> str:
    """도구 위험도. 인자에 따라 달라지는 도구(예: 덮어쓰기 옵션)는 ``tool.risk_for(args)`` 를 정의한다."""
    risk = getattr(tool, "risk", "low") or "low"
    fn = getattr(tool, "risk_for", None)
    if callable(fn):
        try:
            risk = fn(args or {}) or risk
        except Exception:  # noqa: BLE001 — 판정 실패는 위험도가 높은 쪽으로 처리
            risk = "high"
    return risk if risk in ("low", "high") else "high"


def _model_view(req: McpWriteRequest) -> dict:
    """모델에 반환할 요약 — 발생한 결과와 다음 행동."""
    d = {"request_id": req.id, "tool": req.tool, "risk": req.risk}
    if req.status == "executed":
        d.update(status="executed", result=_uj(req.result))
        if req.undo:
            d["can_undo"] = True
    elif req.status == "failed":
        d.update(status="failed", error=req.error)
        extra = _uj(req.result)
        if isinstance(extra, dict):
            d.update({k: v for k, v in extra.items() if k not in d})
    elif req.status == "pending":
        if req.risk == "high" or req.source == "mcp":
            d.update(
                status="pending_approval", approval_id=req.id,
                expires_at=_aware(req.expires_at).isoformat(),
                message=("실행하지 않았습니다. 사용자가 워크스페이스 승인 대기함에서 승인해야 실행됩니다"
                         + ("(직전에 외부 내용을 읽은 뒤의 요청이라 자동 실행하지 않았습니다)" if req.after_untrusted and req.risk == "low" else "")
                         + ". 결과는 approvals_status 로 확인하세요. 실행됐다고 말하지 마세요."),
            )
        else:
            gated = (_uj(req.untrusted_hint) or {}).get("gate") == GATE_VISIBLE
            d.update(status="pending_confirmation",
                     message="실행하지 않았습니다. 사용자가 화면의 카드에서 [실행]을 눌러야 합니다"
                             + ("(외부 내용을 읽은 뒤의, 다른 사람에게 보이는 작업이라 자동 실행하지 않았습니다)" if gated else "")
                             + ". 실행됐다고 말하지 마세요.")
    else:
        d.update(status=req.status)
        if req.reject_reason:
            d["reject_reason"] = req.reject_reason
    return d


# ── 사용자의 결정 ────────────────────────────────────────────────
class WriteError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


async def get_owned(db, user: User, req_id: str) -> McpWriteRequest:
    req = await db.get(McpWriteRequest, req_id)
    if req is None or req.user_id != user.id:
        raise WriteError("not_found", "요청이 없습니다")
    if _expired_now(req):
        req.status = "expired"
        req.decided_at = _now()
        await db.commit()
    return req


BUSY_MSG = "이미 처리 중인 요청입니다 — 잠시 후 결과를 확인하십시오"


async def approve(db, user: User, req_id: str) -> McpWriteRequest:
    """승인(high) 또는 카드 [실행](low) — 서버가 실행한다. 동일 요청을 동시에 여러 번 승인해도 1회만 실행한다."""
    req = await get_owned(db, user, req_id)
    if req.status != "pending":
        raise WriteError("conflict", f"이미 처리된 요청입니다({req.status})")
    if not await _claim(db, req):
        raise WriteError("conflict", BUSY_MSG if req.status == "pending" else f"이미 처리된 요청입니다({req.status})")
    await _execute(db, req, user)
    await _report_back(db, req)
    await emit_count(db, user.id, req)
    return req


async def remember_approval(db, user: User, req: McpWriteRequest, scope: str) -> None:
    """카드 "예, 다시 묻지 않기" — 허용 규칙을 저장하고, 동일 대화에서 동일 도구로 대기 중인 카드도 함께 실행한다."""
    if scope == "conversation":
        if not req.conversation_id:
            raise WriteError("invalid_argument", "대화에 묶인 요청이 아닙니다")
        await set_conv_allowed(user.id, req.conversation_id, req.tool, True)
        try:
            from app.db.models import AuditLog

            db.add(AuditLog(actor_id=user.id, action="ai_permission_rules.conversation_allow",
                            resource_type="ai_conversation", resource_id=req.conversation_id[:36],
                            details=_j({"tool": req.tool, "request_id": req.id})))
            await db.commit()
        except Exception:  # noqa: BLE001
            await db.rollback()
    else:
        await add_rule(db, user.id, "allow", req.tool)
    if not req.conversation_id:
        return
    rows = (await db.execute(select(McpWriteRequest).where(
        McpWriteRequest.user_id == user.id, McpWriteRequest.conversation_id == req.conversation_id,
        McpWriteRequest.tool == req.tool, McpWriteRequest.status == "pending",
        McpWriteRequest.source == "ai", McpWriteRequest.id != req.id))).scalars().all()
    for r in rows:
        if r.risk == "high" and r.after_untrusted:
            continue  # 외부 내용을 읽은 직후의 high 는 규칙이 있어도 사용자 확인 요청
        if r.after_untrusted and await tool_visible(_tool_of(r.tool), _uj(r.args), user):
            continue  # 외부 내용 읽기 이후의 '타인에게 노출되는 쓰기'도 카드별로 개별 확인 요청
        try:
            await approve(db, user, r.id)
        except WriteError:
            continue


async def batch_decide(db, user: User, conversation_id: str, ids: list[str] | None = None,
                       action: str = "approve") -> list[McpWriteRequest]:
    """채팅 일괄 처리 — 이 대화의 대기 low 카드 중 선택한 것(ids 없으면 전부)을 실행(approve) 또는 취소(cancel).
    high 는 승인 대기함에서 개별 처리한다(여기서는 변경하지 않는다)."""
    await expire_due(db, user.id)
    q = select(McpWriteRequest).where(
        McpWriteRequest.user_id == user.id, McpWriteRequest.conversation_id == conversation_id,
        McpWriteRequest.status == "pending", McpWriteRequest.risk == "low",
        McpWriteRequest.source == "ai")
    if ids is not None:
        q = q.where(McpWriteRequest.id.in_(ids[:500]))
    rows = (await db.execute(q.order_by(McpWriteRequest.created_at))).scalars().all()
    out = []
    for r in rows:
        try:
            if action == "approve":
                out.append(await approve(db, user, r.id))
            else:
                out.append(await reject(db, user, r.id, None, cancel=True))
        except WriteError:
            continue
    return out


async def reject(db, user: User, req_id: str, reason: str | None = None, *, cancel: bool = False) -> McpWriteRequest:
    req = await get_owned(db, user, req_id)
    if req.status != "pending":
        raise WriteError("conflict", f"이미 처리된 요청입니다({req.status})")
    # 실행이 이미 시작된(선점된) 요청은 거절·취소로 전환하지 않는다 — 조건부 UPDATE 로만 변경한다
    if not await _cas(db, req, _unclaimed(), status="canceled" if cancel else "rejected",
                      reject_reason=(reason or "").strip()[:1000] or None, decided_at=_now()):
        raise WriteError("conflict", BUSY_MSG if req.status == "pending" else f"이미 처리된 요청입니다({req.status})")
    _scrub(req)
    await db.commit()
    await _audit(db, user.id, f"ai_write.{req.status}", req)
    await _report_back(db, req)
    await emit_count(db, user.id, req)
    return req


DISCONNECTED_REASON = "연결 해제됨"


async def pending_for_client(db, user_id: str, client_id: str) -> list[McpWriteRequest]:
    """이 연결(client_id)이 생성한, 아직 대기 중인 본인 요청."""
    from sqlalchemy import select as _select

    return list((await db.execute(_select(McpWriteRequest).where(
        McpWriteRequest.user_id == user_id, McpWriteRequest.client_id == client_id,
        McpWriteRequest.status == "pending",
    ))).scalars().all())


async def reject_for_client(db, user: User, client_id: str) -> int:
    """연결 해제 시 — 해당 연결의 대기 요청을 '연결 해제됨' 사유로 거부한다. 거부 건수를 반환."""
    n = 0
    for req in await pending_for_client(db, user.id, client_id):
        try:
            await reject(db, user, req.id, DISCONNECTED_REASON)
            n += 1
        except WriteError:
            continue
    return n


async def update_args(db, user: User, req_id: str, args: dict) -> McpWriteRequest:
    """[수정] — 대기 중인 요청의 인자를 수정한다. 만료 시각을 다시 계산한다."""
    if not isinstance(args, dict):
        raise WriteError("invalid_argument", "args 는 객체여야 합니다")
    req = await get_owned(db, user, req_id)
    if req.status != "pending":
        raise WriteError("conflict", f"이미 처리된 요청입니다({req.status})")
    from app.mcp.server import WORKSPACE_TOOLS

    tool = WORKSPACE_TOOLS.get(req.tool)
    if tool is not None:
        kwargs = dict(args)
        if tool.requires_user:
            kwargs["user"] = user
        try:
            inspect.signature(tool.handler).bind(**kwargs)
        except TypeError as e:
            raise WriteError("invalid_argument", f"인자가 맞지 않습니다: {e}")
        if tool_risk(tool, args) != req.risk:
            # 낮은 위험도로 승인받은 요청을 수정하여 덮어쓰기 등 고위험 동작으로 변경하는 것 방지
            raise WriteError("invalid_argument", "위험도가 변경되는 수정입니다 — 새 요청으로 다시 시도하십시오")
    # 실행 시작 이후에는 인자 변경 불가(승인과 동일한 조건부 UPDATE)
    if not await _cas(db, req, _unclaimed(), args=_j(args),
                      expires_at=_now() + (HIGH_TTL if req.risk == "high" or req.source == "mcp" else LOW_TTL)):
        raise WriteError("conflict", BUSY_MSG if req.status == "pending" else f"이미 처리된 요청입니다({req.status})")
    await _audit(db, user.id, "ai_write.edited", req)
    return req


async def undo(db, user: User, req_id: str) -> McpWriteRequest:
    req = await get_owned(db, user, req_id)
    inv = _uj(req.undo)
    until = _aware(req.undo_until)
    if req.status != "executed" or not inv or not until:
        raise WriteError("conflict", "실행 취소할 수 없는 요청입니다")
    if until < _now():
        raise WriteError("conflict", "실행 취소 가능 시간(10분)이 지났습니다")
    # 되돌리기도 1회만 — 먼저 executed → undone 으로 선점하고(조건부 UPDATE), 역연산이 실패하면 원상태로 복원한다
    if not await _cas(db, req, McpWriteRequest.status == "executed", status="undone"):
        raise WriteError("conflict", "이미 실행 취소했거나 실행 취소 중입니다")
    result, error, _ = await _run_handler(inv.get("tool", ""), inv.get("args") or {}, user)
    if error:
        await _cas(db, req, McpWriteRequest.status == "undone", status="executed")
        raise WriteError("internal", f"실행 취소 실패: {error}")
    req.undo_until = None
    await db.commit()
    await _audit(db, user.id, "ai_write.undone", req)
    return req


# ── 선승인 흐름(Claude Code 방식) ───────────────────────────────
# 내장 AI 답변은 쓰기 요청이 발생하면 그 시점에서 사용자의 결정을 대기한 뒤 실제 결과를 반영하여 이어서 작성한다.
# 대기 중에는 답변 자체가 결과를 전달하므로 _report_back(대화에 별도로 추가하는 결과 메시지)은 생략한다.
_local_awaited: dict[str, float] = {}
WAIT_POLL_SEC = 1.0


def _await_key(req_id: str) -> str:
    return f"mcp:write:awaited:{req_id}"


async def mark_awaited(req_ids: list[str], on: bool) -> None:
    ttl = int(HIGH_TTL.total_seconds()) + 120
    try:
        from app.chat.redis_client import get_redis

        r = await get_redis()
        for rid in req_ids:
            if on:
                await r.set(_await_key(rid), "1", ex=ttl)
            else:
                await r.delete(_await_key(rid))
        return
    except Exception:  # noqa: BLE001
        pass
    for rid in req_ids:
        if on:
            _local_awaited[rid] = time.time() + ttl
        else:
            _local_awaited.pop(rid, None)


async def is_awaited(req_id: str) -> bool:
    try:
        from app.chat.redis_client import get_redis

        r = await get_redis()
        return bool(await r.exists(_await_key(req_id)))
    except Exception:  # noqa: BLE001
        return _local_awaited.get(req_id, 0) > time.time()


async def wait_decided(user: User, req_ids: list[str], *, poll: float | None = None) -> dict[str, dict]:
    """요청이 모두 대기 상태를 벗어날 때까지(실행·실패·취소·거절·만료) 대기한다. 만료는 get_owned 가 반영한다.
    반환값: {id: {"status", "view"(모델용 decision_view), "card"(화면용 to_dict)}}.
    호출자가 취소되면(답변 중지) CancelledError 가 그대로 전파된다."""
    import asyncio


    left = list(dict.fromkeys(req_ids))
    out: dict[str, dict] = {}
    while left:
        async with session() as db:
            for rid in list(left):
                try:
                    req = await get_owned(db, user, rid)
                except WriteError:
                    left.remove(rid)
                    continue
                if req.status != "pending":
                    await db.refresh(req)
                    out[rid] = {"status": req.status, "view": decision_view(req), "card": to_dict(req)}
                    left.remove(rid)
        if left:
            await asyncio.sleep(WAIT_POLL_SEC if poll is None else poll)
    return out


async def cancel_awaited(user: User, req_ids: list[str]) -> None:
    """답변을 중지하면 아직 대기 중인 카드(low)는 취소한다 — Claude Code 와 동일하게 '중지 = 거절'.
    high 는 승인 대기함에 유지하며, 이후 처리되면 _report_back 이 대화에 결과를 기록한다."""

    async with session() as db:
        for rid in req_ids:
            try:
                req = await get_owned(db, user, rid)
                if req.status == "pending" and req.risk == "low":
                    await reject(db, user, rid, "답변을 멈춤", cancel=True)
            except WriteError:
                continue


def decision_view(req: McpWriteRequest) -> dict:
    """대기 종료 후의 결과 — 모델이 답변을 이어서 작성할 근거."""
    d = _model_view(req)
    note = {
        "canceled": "사용자가 이 작업을 취소했습니다. 같은 작업을 다시 요청하지 말고, 바꿀 점이 있는지 물어보세요.",
        "rejected": "사용자가 이 작업을 거절했습니다. 같은 작업을 다시 요청하지 마세요.",
        "expired": "사용자가 제한 시간 안에 응답하지 않아 요청이 만료됐습니다. 실행되지 않았습니다.",
        "undone": "실행했다가 사용자가 되돌렸습니다.",
    }.get(req.status)
    if note:
        d["message"] = note
    if req.reject_reason and req.status in ("canceled", "rejected"):
        # Claude Code "아니요, 대신 이렇게" — 사용자의 지시를 그대로 전달하여 모델이 재계획하도록 한다
        d["user_instruction"] = req.reject_reason
        d["message"] = ("사용자가 이 작업을 실행하지 않고 대신 이렇게 하라고 했습니다: "
                        f"\"{req.reject_reason}\". 이 지시를 따라 다시 계획하세요. 같은 요청을 그대로 다시 보내지 마세요.")
    return d


async def _report_back(db, req: McpWriteRequest) -> None:
    """내장 AI 대화로 결과를 전달한다(승인 대기함에서 처리한 경우 사용자가 대화에서도 확인할 수 있도록)."""
    if req.source != "ai" or not req.conversation_id or req.risk != "high":
        return
    if await is_awaited(req.id):
        return  # 답변이 이 결정을 대기 중 — 결과는 답변이 이어서 전달한다
    try:
        from app.ai.models import AIMessage

        label = {"executed": "승인되어 실행했습니다", "failed": "승인했지만 실행에 실패했습니다",
                 "rejected": "거부되었습니다", "canceled": "취소되었습니다"}.get(req.status, req.status)
        text = f"[승인 대기함] {to_dict(req)['title']} — {label}."
        if req.reject_reason:
            text += f" 사유: {req.reject_reason}"
        if req.error:
            text += f" 오류: {req.error}"
        db.add(AIMessage(conversation_id=req.conversation_id, user_id=req.user_id,
                         role="assistant", content=text))
        await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("[mcp-write] report back failed", exc_info=True)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass


# ── 조회 ──────────────────────────────────────────────────────
async def list_requests(db, user: User, *, view: str = "pending", limit: int = 50, offset: int = 0,
                        conversation_id: str | None = None):
    await expire_due(db, user.id)
    q = select(McpWriteRequest).where(McpWriteRequest.user_id == user.id)
    if conversation_id:
        # 대화를 다시 열 때의 채팅 카드 복원용 — 해당 대화의 요청 전부(대기·처리 포함), 오래된 순
        q = q.where(McpWriteRequest.conversation_id == conversation_id).order_by(McpWriteRequest.created_at.asc())
        rows = (await db.execute(q.offset(offset).limit(limit + 1))).scalars().all()
        return rows[:limit], len(rows) > limit
    if view == "pending":
        # 승인 대기함 = high 이거나 MCP 에서 등록된 요청(카드형 low 대기는 채팅 내에서 처리)
        q = q.where(McpWriteRequest.status == "pending",
                    or_(McpWriteRequest.risk == "high", McpWriteRequest.source == "mcp"))
        q = q.order_by(McpWriteRequest.created_at.desc())
    else:
        q = q.where(McpWriteRequest.status != "pending").order_by(McpWriteRequest.created_at.desc())
    rows = (await db.execute(q.offset(offset).limit(limit + 1))).scalars().all()
    return rows[:limit], len(rows) > limit


async def history_count(db, user: User) -> int:
    from sqlalchemy import func

    return int((await db.execute(select(func.count()).select_from(McpWriteRequest).where(
        McpWriteRequest.user_id == user.id, McpWriteRequest.status != "pending"))).scalar() or 0)


async def pending_count(db, user: User) -> int:
    rows, _ = await list_requests(db, user, view="pending", limit=200)
    return len(rows)
