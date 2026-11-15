"""메모리 — AI 가 대화에서 기억해 두는 사용자 정보(선호·업무·사람).

- 저장 경로는 둘: 설정 › AI › 메모리(직접 추가·수정)와 **내장 AI 전용 도구** ``memory_save``.
  이 도구는 WORKSPACE_TOOLS(=MCP 레지스트리)에 넣지 않는다 — claude.ai 등 외부 커넥터에는 보이지 않고,
  내장 AI 채팅 루프(app.ai.router._chat_event_stream)가 이름으로 가로채 직접 처리한다.
- 비밀 거부: 비밀번호·토큰·API 키·개인키·주민등록번호·카드번호는 저장하지 않는다(app.ai.pii 패턴 + 비밀 단어 휴리스틱).
- 스위치 "메모리 사용"(사용자별, 기본 켬): 끄면 읽지도(시스템 맥락에 안 넣음) 쓰지도(도구 안 보임) 않는다. 지우지는 않는다.
- 임시 대화는 읽지도 쓰지도 않는다(호출자가 판단).
"""

from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import config as ai_config
from app.ai import pii
from app.ai.models import AIMemory

KINDS = ("preference", "work", "person")
MAX_TEXT = 500
MAX_ITEMS = 300               # 사용자당 보관 상한
CONTEXT_BUDGET = 3000         # 시스템 맥락에 넣는 글자 상한
TOOL_NAME = "memory_save"


class MemoryError(Exception):  # noqa: A001 — 모듈 안 이름
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ── 비밀 거부 ─────────────────────────────────────────────────
# 비밀 단어 뒤에 값이 붙은 모양 — "비번: hunter2", "password=Abc123!", "API 키는 sk-…".
# 값은 한글이 섞이지 않은 4자 이상(“비밀번호는 90일마다 바꾼다” 같은 습관 서술은 걸리지 않게).
_SECRET_WORD = re.compile(
    r"(password|passwd|passphrase|pwd|pin|otp|비밀\s*번호|비번|암호|패스워드|"
    r"token|토큰|api[\s_-]*key|access[\s_-]*key|secret|시크릿|private[\s_-]*key|개인\s*키|인증\s*키|api\s*키)"
    r"\s*(?:[:=：]|은|는|이|가|을|를|is|=)\s*[\"'`]?([^\s가-힣\"'`]{4,})",
    re.IGNORECASE,
)
# 값 자체가 비밀 모양 — 서비스 키 접두·JWT·개인키 블록·긴 고엔트로피 문자열
_SECRET_VALUE = re.compile(
    r"(sk-[A-Za-z0-9_\-]{16,}|sk-ant-[A-Za-z0-9_\-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xox[abprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,}|glpat-[A-Za-z0-9_\-]{16,}|"
    r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)
_LONG_TOKEN = re.compile(r"(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-+/=]{32,}(?![A-Za-z0-9_\-])")


def _looks_random(tok: str) -> bool:
    has_digit = any(c.isdigit() for c in tok)
    has_alpha = any(c.isalpha() for c in tok)
    has_upper = any(c.isupper() for c in tok)
    has_lower = any(c.islower() for c in tok)
    return has_digit and has_alpha and (has_upper and has_lower or len(tok) >= 40)


def secret_reason(text: str) -> str | None:
    """비밀로 보이면 이유(한국어), 아니면 None."""
    if not text:
        return None
    if pii._RRN.search(text):
        return "주민등록번호"
    for m in pii._CARD.finditer(text):
        if pii._luhn("".join(m.groups())):
            return "카드번호"
    if re.search(r"(?<!\d)\d{13,19}(?!\d)", text):
        digits = re.search(r"(?<!\d)\d{13,19}(?!\d)", text).group(0)  # type: ignore[union-attr]
        if pii._luhn(digits):
            return "카드번호"
    if _SECRET_VALUE.search(text):
        return "토큰·키"
    m = _SECRET_WORD.search(text)
    if m:
        return "비밀번호·키"
    for t in _LONG_TOKEN.findall(text):
        if _looks_random(t):
            return "토큰·키"
    return None


def validate(kind: str, text: str) -> tuple[str, str]:
    kind = (kind or "").strip().lower()
    if kind not in KINDS:
        raise MemoryError("invalid_argument", "kind 는 preference·work·person 중 하나입니다")
    text = " ".join((text or "").split())
    if not text:
        raise MemoryError("invalid_argument", "내용이 비어 있습니다")
    if len(text) > MAX_TEXT:
        raise MemoryError("invalid_argument", f"메모리 한 개는 {MAX_TEXT}자까지입니다")
    why = secret_reason(text)
    if why:
        raise MemoryError("secret", f"비밀 정보({why})로 보여 메모리에 저장하지 않습니다")
    return kind, text


# ── 스위치 ───────────────────────────────────────────────────
def _enabled_key(uid: str) -> str:
    return f"ai.user.{uid}.pref.memory_enabled"


async def is_enabled(db: AsyncSession, uid: str) -> bool:
    v = await ai_config._get(db, _enabled_key(uid), "true")
    return (v or "true").strip().lower() not in ("false", "0", "off")


async def set_enabled(db: AsyncSession, uid: str, on: bool) -> None:
    await ai_config._set(db, _enabled_key(uid), "true" if on else "false")
    await db.commit()


# ── 저장·목록 ────────────────────────────────────────────────
def to_dict(m: AIMemory) -> dict:
    return {
        "id": m.id, "kind": m.kind, "text": m.text,
        "source_conversation_id": m.source_conversation_id,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "updated_at": m.updated_at.isoformat() if m.updated_at else None,
    }


async def save(db: AsyncSession, uid: str, kind: str, text: str, source_conversation_id: str | None) -> AIMemory:
    kind, text = validate(kind, text)
    rows = (await db.execute(select(AIMemory).where(AIMemory.user_id == uid))).scalars().all()
    same = next((r for r in rows if r.text == text), None)
    if same is not None:  # 같은 내용은 하나만
        if same.kind != kind:
            same.kind = kind
            await db.commit()
        return same
    if len(rows) >= MAX_ITEMS:
        raise MemoryError("too_large", f"메모리는 {MAX_ITEMS}개까지입니다 — 설정 › AI › 메모리에서 정리해 주세요")
    m = AIMemory(user_id=uid, kind=kind, text=text, source_conversation_id=source_conversation_id)
    db.add(m)
    await db.commit()
    return m


_KIND_LABEL = {"preference": "선호", "work": "업무", "person": "사람"}


async def context_block(db: AsyncSession, uid: str, budget: int | None = None) -> str:
    """시스템 맥락에 넣을 메모리(최근 고친 순, 글자 상한). 꺼져 있으면 빈 문자열."""
    if not await is_enabled(db, uid):
        return ""
    rows = (await db.execute(
        select(AIMemory).where(AIMemory.user_id == uid).order_by(AIMemory.updated_at.desc())
    )).scalars().all()
    lines: list[str] = []
    used = 0
    cap = budget or CONTEXT_BUDGET
    for r in rows:
        line = f"- ({_KIND_LABEL.get(r.kind, r.kind)}) {r.text}"
        if used + len(line) > cap:
            break
        lines.append(line)
        used += len(line) + 1
    if not lines:
        return ""
    return ("[사용자 메모리 — 이 사용자에 대해 기억해 둔 것. 답변에 자연스럽게 반영하되 그대로 읊지 마세요]\n"
            + "\n".join(lines))


# 모델에게 보이는 도구(OpenAI function 스키마). MCP 레지스트리에는 없다.
TOOL_SPEC = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": (
            "사용자가 앞으로도 기억해 주길 바라는 오래 쓸 정보(선호·업무 맥락·사람 관계)를 메모리에 저장한다. "
            "사용자가 '기억해 줘'라고 하거나, 반복해서 쓸 선호(문체·형식)·업무 사실이 분명할 때만 쓴다. "
            "비밀번호·토큰·API 키·주민등록번호·카드번호 같은 비밀은 절대 저장하지 않는다. 한 문장으로 짧게."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": list(KINDS),
                         "description": "preference(선호) · work(업무) · person(사람)"},
                "text": {"type": "string", "description": "기억할 내용 한 문장(500자 이하)"},
            },
            "required": ["kind", "text"],
        },
    },
}

MEMORY_PROMPT = (
    "사용자가 기억해 달라고 하거나 앞으로도 쓸 선호·업무 사실이 분명하면 memory_save 도구로 저장할 수 있습니다. "
    "비밀(비밀번호·토큰·키·주민번호·카드번호)은 저장하지 마세요."
)
