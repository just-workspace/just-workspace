"""내장 AI 도구 결과 예산 — 도구 결과 1건을 모델에 전달할 때의 상한(글자).

이전 구현은 router 가 도구 결과 JSON 을 4,000자에서 단순 절단했다(JSON 손상·페이지 정보 소실). 현재는
모델 컨텍스트 크기에 맞춘 예산을 산정하고:

  - 도구 실행 중 ``_common.fit_budget_scope(budget)`` 를 적용하여 목록 도구가 해당 범위 내로 자체 조정하며
    (항목 단위·페이지 정보 맨 앞·truncated/next_cursor),
  - 모델 전달 직전에 ``_common.fit_json_text(payload, budget)`` 로 구조를 유지하며 재조정한다
    (본문 창 축소 및 next_offset 보정 → 그래도 초과하면 response_too_large 오류 JSON).

예산 단위는 글자(json.dumps(..., ensure_ascii=False) 의 len) — 모델이 수신하는 텍스트 길이와 동일하다.
라우터 측 컨텍스트 계산과 연동할 때는 ``tool_result_budget(cfg, context_chars=...)`` 로 전달한다.
"""

from __future__ import annotations

# 1M 토큰급 컨텍스트 모델 — 도구 결과 1건에 큰 예산 할당
LARGE_BUDGET = 60_000
# 일반 클라우드 모델(128k~200k 토큰급)
MEDIUM_BUDGET = 20_000
# 소형·로컬 모델(ollama 등, 컨텍스트 8k~32k 토큰급)
SMALL_BUDGET = 6_000
MIN_BUDGET = 2_000

# 모델 이름에 아래 문자열이 포함되면 1M 컨텍스트로 간주한다(대소문자 무시)
_LARGE_HINTS = ("[1m]", "-1m", "opus-5", "sonnet-5", "gemini-2.5", "gemini-3", "gpt-4.1", "gpt-5")
_SMALL_KINDS = ("ollama",)


def tool_result_budget(cfg=None, *, context_chars: int | None = None) -> int:
    """도구 결과 1건의 상한(글자).

    ``context_chars`` (모델 컨텍스트를 글자로 환산한 값)가 주어지면 그 1/8 을 사용하되 [MIN, LARGE] 범위로 제한한다.
    미지정 시 제공자 종류·모델 이름으로 추정: 1M 급 → 60,000, 로컬/소형 → 6,000, 그 외 → 20,000.
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


# 예산 중 도구 이름 줄·출처 표기용으로 확보하는 여유분
_HEAD_MARGIN = 300


def scope(budget: int):
    """도구 실행 중 목록 도구가 준수할 외부 상한을 설정한다(_common.fit_budget_scope)."""
    from app.mcp.tools import _common

    return _common.fit_budget_scope(max(MIN_BUDGET // 2, int(budget) - _HEAD_MARGIN))


def result_text(payload, budget: int) -> str:
    """모델에 전달할 도구 결과 JSON 텍스트 — 항상 유효한 JSON, budget 글자 이하(구조 유지)."""
    from app.mcp.tools import _common

    return _common.fit_json_text(payload, max(MIN_BUDGET // 2, int(budget) - _HEAD_MARGIN))
