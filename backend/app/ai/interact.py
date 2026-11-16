"""내장 AI ↔ 사용자 상호작용 도구 — Claude Code 의 AskUserQuestion · ExitPlanMode.

- ``ask_user``  : 모델이 선택지를 제시하며 질문한다(질문 1~4개, 선택지 2~4개, 복수 선택, '기타' 직접 입력은 화면이 항상 추가한다).
- ``plan_exit`` : 계획 모드에서 계획을 제출하고 실행 승인을 받는다
                  (예·편집 자동 수락으로 진행 / 예·하나씩 승인하며 진행 / 아니요·계속 계획 + 피드백).

둘 다 MCP 레지스트리에 없는 내장 전용 도구이다. 답변 루프(app.ai.router)가 가로채어
SSE ``question`` 으로 화면에 표시하고, 사용자가 응답할 때까지 답변을 중단한 상태로 대기한 후 응답을 도구 결과로 전달한다.
상태는 Redis(없으면 프로세스 메모리)에 저장하고, 메시지 meta.questions 에도 기록하여 대화를 다시 열어도 표시된다.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time

ASK_TOOL = "ask_user"
PLAN_TOOL = "plan_exit"
TOOL_NAMES = (ASK_TOOL, PLAN_TOOL)
TTL_SEC = 30 * 60          # 응답 대기 최대 시간 — 초과 시 expired
KEEP_SEC = 2 * 3600        # 종료 후 키 보관 시간
POLL_SEC = 1.0
PLAN_CHOICES = ("acceptEdits", "default", "keep_planning")

_local: dict[str, tuple[float, dict]] = {}

ASK_SPEC = {
    "type": "function",
    "function": {
        "name": ASK_TOOL,
        "description": (
            "작업을 진행하려면 사용자의 결정이 꼭 필요할 때 선택지를 보여 주고 묻는다(답할 때까지 기다린다). "
            "요구가 모호하거나 방법이 여럿이라 사용자가 골라야 할 때만 쓴다. 스스로 정할 수 있는 건 묻지 않는다. "
            "질문 1~4개, 질문마다 선택지 2~4개. '기타(직접 입력)'는 화면이 자동으로 붙이니 넣지 않는다. "
            "추천하는 선택지가 있으면 맨 앞에 두고 label 끝에 '(추천)'을 붙인다."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array", "minItems": 1, "maxItems": 4,
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {"type": "string", "description": "물음표로 끝나는 완전한 질문"},
                            "header": {"type": "string", "description": "칩에 보일 아주 짧은 이름(12자 이하)"},
                            "multiSelect": {"type": "boolean", "description": "여러 개를 고를 수 있으면 true"},
                            "options": {
                                "type": "array", "minItems": 2, "maxItems": 4,
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {"type": "string", "description": "선택지 이름(1~5단어)"},
                                        "description": {"type": "string", "description": "고르면 어떻게 되는지·장단점"},
                                    },
                                    "required": ["label"],
                                },
                            },
                        },
                        "required": ["question", "options"],
                    },
                },
            },
            "required": ["questions"],
        },
    },
}

PLAN_SPEC = {
    "type": "function",
    "function": {
        "name": PLAN_TOOL,
        "description": (
            "계획 모드에서 조사를 마치고 실행 계획이 준비되면 계획을 사용자에게 내고 실행 승인을 받는다(답할 때까지 기다린다). "
            "계획은 마크다운으로, 무엇을 어떤 순서로 바꿀지(대상·도구) 구체적으로 쓴다. "
            "사용자가 승인하면 권한 모드가 바뀌고 그때부터 쓰기 도구를 쓸 수 있다. 거절하면 피드백을 반영해 계획을 고친다."
        ),
        "parameters": {
            "type": "object",
            "properties": {"plan": {"type": "string", "description": "실행 계획(마크다운)"}},
            "required": ["plan"],
        },
    },
}

ASK_PROMPT = (
    "요구가 모호하거나 사용자가 골라야 할 갈림길이 있으면 짐작하지 말고 ask_user 도구로 선택지를 내밀어 물으세요. "
    "스스로 정할 수 있는 사소한 것은 묻지 마세요."
)
PLAN_PROMPT = (
    "[계획 모드] 지금은 아무것도 바꾸지 않는 계획 모드입니다. 읽기 도구로 필요한 것을 조사하고, "
    "계획이 준비되면 plan_exit 도구로 계획을 내서 실행 승인을 받으세요. 쓰기 도구는 승인 전에는 거부됩니다."
)


class InteractError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _s(v, n: int) -> str:
    return str(v or "").strip()[:n]


def validate_ask(args: dict) -> list[dict]:
    qs = args.get("questions") if isinstance(args, dict) else None
    if not isinstance(qs, list) or not 1 <= len(qs) <= 4:
        raise InteractError("invalid_argument", "questions 는 1~4개여야 합니다")
    out = []
    for q in qs:
        if not isinstance(q, dict):
            raise InteractError("invalid_argument", "질문 형식이 잘못됐습니다")
        text = _s(q.get("question"), 300)
        opts = q.get("options")
        if not text or not isinstance(opts, list) or not 2 <= len(opts) <= 4:
            raise InteractError("invalid_argument", "질문마다 question 과 선택지 2~4개가 필요합니다")
        clean = []
        for o in opts:
            label = _s(o.get("label") if isinstance(o, dict) else o, 60)
            if not label:
                raise InteractError("invalid_argument", "선택지 label 이 비었습니다")
            clean.append({"label": label, "description": _s(o.get("description"), 240) if isinstance(o, dict) else ""})
        if len({c["label"] for c in clean}) != len(clean):
            raise InteractError("invalid_argument", "선택지 label 이 겹칩니다")
        out.append({"question": text, "header": _s(q.get("header"), 20), "multiSelect": bool(q.get("multiSelect")),
                    "options": clean})
    return out


def validate_plan(args: dict) -> str:
    plan = _s(args.get("plan") if isinstance(args, dict) else "", 20_000)
    if not plan:
        raise InteractError("invalid_argument", "plan 이 비었습니다")
    return plan


# ── 저장소 ───────────────────────────────────────────────────
def _key(qid: str) -> str:
    return f"ai:interact:{qid}"


async def _redis():
    from app.chat.redis_client import get_redis
    return await get_redis()


async def _put(qid: str, rec: dict, ttl: int) -> None:
    try:
        r = await _redis()
        await r.set(_key(qid), json.dumps(rec, ensure_ascii=False), ex=ttl)
        return
    except Exception:  # noqa: BLE001
        pass
    _local[qid] = (time.time() + ttl, rec)


async def _get(qid: str) -> dict | None:
    try:
        r = await _redis()
        raw = await r.get(_key(qid))
        return json.loads(raw) if raw else None
    except Exception:  # noqa: BLE001
        exp, rec = _local.get(qid, (0, None))
        return rec if exp > time.time() else None


async def peek(user_id: str, qid: str) -> dict | None:
    rec = await _get(qid)
    return rec if rec and rec.get("user_id") == user_id else None


def public(rec: dict) -> dict:
    """화면(SSE question · meta.questions)에 전달할 형태."""
    keys = ("id", "kind", "status", "questions", "plan", "answer", "created_at", "expires_at")
    return {k: rec.get(k) for k in keys if k in rec}


async def create(user_id: str, conv_id: str, msg_id: str, kind: str, payload: dict) -> dict:
    now = time.time()
    rec = {"id": "q_" + secrets.token_hex(6), "kind": kind, "status": "pending", "user_id": user_id,
           "conversation_id": conv_id, "message_id": msg_id, "created_at": now, "expires_at": now + TTL_SEC,
           "answer": None, **payload}
    await _put(rec["id"], rec, TTL_SEC + KEEP_SEC)
    return rec


async def answer(user_id: str, qid: str, body: dict) -> dict:
    """사용자의 응답. ask: {answers: [{selected: [label], other: str|None}]} — 질문 순서대로.
    plan: {choice: acceptEdits|default|keep_planning, feedback?}. skip=true 이면 응답 없이 건너뜀."""
    rec = await _get(qid)
    if rec is None or rec.get("user_id") != user_id:
        raise InteractError("not_found", "질문이 없습니다")
    if rec["status"] != "pending":
        raise InteractError("conflict", f"이미 처리된 질문입니다({rec['status']})")
    if time.time() > rec["expires_at"]:
        rec["status"] = "expired"
        await _put(qid, rec, KEEP_SEC)
        raise InteractError("conflict", "시간이 지나 만료된 질문입니다")
    body = body if isinstance(body, dict) else {}
    if body.get("skip"):
        rec.update(status="skipped", answer=None)
    elif rec["kind"] == "ask":
        raw = body.get("answers")
        if not isinstance(raw, list) or len(raw) != len(rec["questions"]):
            raise InteractError("invalid_argument", "질문마다 답이 필요합니다")
        ans = []
        for q, a in zip(rec["questions"], raw):
            a = a if isinstance(a, dict) else {}
            labels = {o["label"] for o in q["options"]}
            sel = [x for x in (a.get("selected") or []) if isinstance(x, str) and x in labels]
            other = _s(a.get("other"), 1000) or None
            if not sel and not other:
                raise InteractError("invalid_argument", f"답하지 않은 질문이 있습니다: {q['question']}")
            if not q["multiSelect"] and len(sel) + (1 if other else 0) > 1:
                raise InteractError("invalid_argument", f"하나만 고를 수 있는 질문입니다: {q['question']}")
            ans.append({"question": q["question"], "selected": sel, "other": other})
        rec.update(status="answered", answer={"answers": ans})
    else:
        choice = body.get("choice")
        if choice not in PLAN_CHOICES:
            raise InteractError("invalid_argument", "choice 는 acceptEdits · default · keep_planning")
        fb = _s(body.get("feedback"), 2000) or None
        rec.update(status="answered", answer={"choice": choice, "feedback": fb})
    rec["answered_at"] = time.time()
    await _put(qid, rec, KEEP_SEC)
    return rec


async def cancel(user_id: str, qid: str) -> None:
    rec = await _get(qid)
    if rec and rec.get("user_id") == user_id and rec["status"] == "pending":
        rec["status"] = "canceled"
        await _put(qid, rec, KEEP_SEC)


async def wait(qid: str, *, poll: float | None = None) -> dict:
    """응답(또는 만료·취소)까지 대기한다. 호출자가 취소되면 CancelledError 가 그대로 전파된다."""
    while True:
        rec = await _get(qid)
        if rec is None:
            return {"id": qid, "status": "expired"}
        if rec["status"] != "pending":
            return rec
        if time.time() > rec["expires_at"]:
            rec["status"] = "expired"
            await _put(qid, rec, KEEP_SEC)
            return rec
        await asyncio.sleep(POLL_SEC if poll is None else poll)


def model_result(rec: dict) -> dict:
    """모델에 전달할 도구 결과."""
    st = rec.get("status")
    if st == "answered" and rec.get("kind") == "ask":
        return {"status": "answered", **(rec.get("answer") or {}),
                "message": "사용자의 답입니다. 이 답을 따라 진행하세요. 'other' 는 사용자가 직접 쓴 답입니다."}
    if st == "answered" and rec.get("kind") == "plan":
        a = rec.get("answer") or {}
        if a.get("choice") == "keep_planning":
            return {"status": "rejected", "feedback": a.get("feedback"),
                    "message": "사용자가 계획을 승인하지 않았습니다. 아직 계획 모드입니다 — 피드백을 반영해 계획을 고친 뒤 "
                               "plan_exit 로 다시 내세요. 쓰기 도구는 쓰지 마세요."}
        mode = a.get("choice")
        return {"status": "approved", "permission_mode": mode, "feedback": a.get("feedback"),
                "message": ("사용자가 계획을 승인했습니다. 이제 계획대로 실행하세요. "
                            + ("편집은 자동 수락되고 삭제·발송은 카드로 확인받습니다." if mode == "acceptEdits"
                               else "쓰기 작업마다 카드로 확인받습니다."))}
    if st == "skipped":
        return {"status": "skipped", "message": "사용자가 답하지 않고 넘겼습니다. 묻지 말고 합리적인 기본값으로 진행하되, "
                                                 "무엇을 가정했는지 답변에 밝히세요."}
    if st == "canceled":
        return {"status": "canceled", "message": "사용자가 답변을 멈췄습니다."}
    return {"status": "expired", "message": "사용자가 제한 시간 안에 답하지 않았습니다. 진행하지 말고 무엇을 결정해야 하는지 정리해 알려 주세요."}
