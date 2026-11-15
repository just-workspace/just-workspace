"""내장 AI 도구 결과 예산 — 도구 결과 하나를 모델에 넣을 때의 상한(글자).

예전엔 router 가 도구 결과 JSON 을 4,000자에서 그냥 잘랐다(JSON 깨짐·페이지 정보 소실). 이제는
모델 컨텍스트 크기에 맞춘 예산을 정하고:

  - 도구 실행 동안 ``_common.fit_budget_scope(budget)`` 를 걸어 목록 도구가 스스로 그 안에 맞추고
    (항목 단위·페이지 정보 맨 앞·truncated/next_cursor),
  - 모델에 넣기 직전에 ``_common.fit_json_text(payload, budget)`` 로 한 번 더 구조를 지키며 맞춘다
    (본문 창 줄이고 next_offset 고침 → 그래도 안 되면 response_too_large 오류 JSON).

예산 단위는 글자(json.dumps(..., ensure_ascii=False) 의 len) — 모델이 받는 텍스트 길이와 같다.
라우터 쪽 컨텍스트 계산과 연결할 때는 ``tool_result_budget(cfg, context_chars=...)`` 로 넘기면 된다.
"""

from __future__ import annotations

# 1M 토큰급 컨텍스트 모델 — 도구 결과 하나에 넉넉히
LARGE_BUDGET = 60_000
# 일반 클라우드 모델(128k~200k 토큰급)
MEDIUM_BUDGET = 20_000
# 소형·로컬 모델(ollama 등, 컨텍스트 8k~32k 토큰급)
SMALL_BUDGET = 6_000
MIN_BUDGET = 2_000

# 모델 이름에 이 조각이 있으면 1M 컨텍스트로 본다(대소문자 무시)
_LARGE_HINTS = ("[1m]", "-1m", "opus-5", "sonnet-5", "gemini-2.5", "gemini-3", "gpt-4.1", "gpt-5")
_SMALL_KINDS = ("ollama",)


def tool_result_budget(cfg=None, *, context_chars: int | None = None) -> int:
    """도구 결과 하나의 상한(글자).

    ``context_chars`` (모델 컨텍스트를 글자로 환산한 값)를 알면 그 1/8 을 쓰되 [MIN, LARGE] 로 자른다.
    모르면 제공자 종류·모델 이름으로 짐작: 1M 급 → 60,000, 로컬/소형 → 6,000, 그 밖 → 20,000.
    """
    if context_chars:
        try:
            return max(MIN_BUDGET, min(LARGE_BUDGET, int(context_chars) // 8))
        except (TypeError, ValueError):
            pass
    kind = str(getattr(cfg, "kind", "") or "").lower()
    model = str(getattr(cfg, "model", "") or "").lower()
    if any(h in model for h in _LARGE_HINTS):
        return LARGE_BUDGET
    if kind in _SMALL_KINDS:
        return SMALL_BUDGET
    if kind in ("anthropic", "openai", "gemini"):
        return MEDIUM_BUDGET
    return SMALL_BUDGET


# 예산 중 도구 이름 줄·출처 표기 몫으로 남기는 여유
_HEAD_MARGIN = 300


def scope(budget: int):
    """도구 실행 동안 목록 도구가 맞출 바깥 상한을 건다(_common.fit_budget_scope)."""
    from app.mcp.tools import _common

    return _common.fit_budget_scope(max(MIN_BUDGET // 2, int(budget) - _HEAD_MARGIN))


def result_text(payload, budget: int) -> str:
    """모델에 넣을 도구 결과 JSON 텍스트 — 언제나 올바른 JSON, budget 글자 이하(구조 유지)."""
    from app.mcp.tools import _common

    return _common.fit_json_text(payload, max(MIN_BUDGET // 2, int(budget) - _HEAD_MARGIN))
