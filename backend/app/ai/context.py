"""모델 컨텍스트 창에 맞춘 예산 — 1M 토큰 모델은 여유 있게, 소형 로컬 모델은 기존과 같이 엄격하게 설정한다.

내장 AI 가 모델에 입력하는 항목(도구 결과·프로젝트 지식·메모리·첨부 문서·대화 기록)의 상한을 고정 수치로 두면
1M 모델에서는 자료가 불필요하게 절단되고, 32K 로컬 모델에서는 초과한다. 본 모듈에서 일괄 결정한다.

- 창 크기: 관리자가 제공자 extra["context_window"] 를 지정하면 해당 값, 아니면 모델 이름으로 추정.
- 글자↔토큰: 한글은 대략 1자≈1토큰, 영문은 3.5자≈1토큰. 예산은 보수적으로(한글 기준) 산정한다.
- 출력 토큰: 설정이 0(자동)이면 모델에 맞춰 선택한다(1M급 32,000 / 다른 Claude 8,192 / 그 밖 4,096).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# 1M 컨텍스트 Claude — Opus 5.5/5, Fable 5.x, Sonnet 5.5/5, Opus·Sonnet 4.6~4.8
_CLAUDE_1M = re.compile(r"claude-(opus|sonnet|fable)-(5|4-[6-9])")
_OPENAI_1M = ("gpt-4.1", "gpt-5")


def context_window(cfg) -> int:
    """모델 입력 창(토큰)."""
    extra = getattr(cfg, "extra", None) or {}
    try:
        v = int(extra.get("context_window") or 0)
    except (TypeError, ValueError):
        v = 0
    if v > 0:
        return v
    name = (getattr(cfg, "model", "") or "").lower()
    kind = getattr(cfg, "kind", "")
    if "claude" in name or kind == "anthropic":
        return 1_000_000 if _CLAUDE_1M.search(name) else 200_000
    if kind == "gemini" or name.startswith("gemini"):
        return 1_000_000
    if name.startswith(_OPENAI_1M):
        return 1_000_000
    if kind == "openai":
        return 128_000
    # 로컬·호환 서버는 기동 설정(num_ctx 등)을 확인할 수 없다 — 보수적으로 설정
    return 32_768


def output_tokens(cfg) -> int:
    """응답 최대 토큰. 설정값(>0)이 있으면 그대로, 0 이면 모델에 맞춘 자동값."""
    try:
        v = int(getattr(cfg, "max_tokens", 0) or 0)
    except (TypeError, ValueError):
        v = 0
    if v > 0:
        return v
    win = context_window(cfg)
    name = (getattr(cfg, "model", "") or "").lower()
    if win >= 1_000_000 and "claude" in name:
        return 32_000
    if "claude" in name:
        return 8_192
    return 4_096


def est_tokens(text: str) -> int:
    """토큰 수 근사치(보수적) — ASCII 3.5자당 1, 나머지(한글 등) 1자당 1."""
    if not text:
        return 0
    ascii_n = sum(1 for ch in text if ord(ch) < 128)
    return int(ascii_n / 3.5) + (len(text) - ascii_n) + 1


def _clamp(v: float, lo: int, hi: int) -> int:
    return int(max(lo, min(hi, v)))


@dataclass(frozen=True)
class Budgets:
    window: int               # 입력 창(토큰)
    output: int               # 응답 최대 토큰
    tool_result: int          # 도구 결과 1건(글자)
    tool_round: int           # 1턴의 도구 결과 전체(글자)
    knowledge: int            # 프로젝트 관련 지식(글자)
    memory: int               # 사용자 메모리(글자)
    attach_turn: int          # 최근 사용자 턴 첨부 문서 합계(글자)
    attach_old_per_file: int  # 이전 턴 첨부 문서 1건(글자)
    input_tokens: int         # 시스템+도구+기록에 사용 가능한 토큰(응답·여유분 제외)


def budgets(cfg) -> Budgets:
    win = context_window(cfg)
    out = output_tokens(cfg)
    usable = max(8_000, win - out - max(4_000, win // 20))  # 응답 + 5% 여유분
    return Budgets(
        window=win,
        output=out,
        tool_result=_clamp(win * 0.12, 4_000, 150_000),
        tool_round=_clamp(usable * 0.35, 12_000, 400_000),
        knowledge=_clamp(win * 0.2, 12_000, 200_000),
        memory=_clamp(win * 0.01, 3_000, 20_000),
        attach_turn=_clamp(win * 0.5, 40_000, 600_000),
        attach_old_per_file=_clamp(win * 0.08, 4_000, 100_000),
        input_tokens=usable,
    )


def _msg_tokens(m: dict) -> int:
    c = m.get("content")
    n = est_tokens(c) if isinstance(c, str) else est_tokens(str(c or ""))
    return n + 1_600 * len(m.get("images") or []) + 8


def fit_history(msgs: list[dict], b: Budgets, reserved_tokens: int = 0) -> tuple[list[dict], int]:
    """오래된 턴부터 제외하여 창에 맞춘다. (잔여 기록, 제외된 메시지 수)

    reserved_tokens: 시스템 컨텍스트·도구 정의·도구 결과용으로 예약할 토큰.
    마지막 사용자 턴은 항상 유지한다. 첫 메시지가 user 가 되도록 조정한다(Anthropic 요구).
    """
    limit = max(2_000, b.input_tokens - reserved_tokens)
    costs = [_msg_tokens(m) for m in msgs]
    total = sum(costs)
    start = 0
    while total > limit and start < len(msgs) - 1:
        total -= costs[start]
        start += 1
    while start < len(msgs) - 1 and msgs[start].get("role") != "user":
        total -= costs[start]
        start += 1
    return msgs[start:], start
