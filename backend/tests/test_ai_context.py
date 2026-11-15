"""1M 컨텍스트 예산(app.ai.context) + Anthropic 프롬프트 캐시 지점."""
from app.ai import context as ctx
from app.ai.providers import ProviderConfig, _cache_last_message


def _cfg(kind, model, **kw):
    return ProviderConfig(kind=kind, model=model, **kw)


def test_window_by_model():
    assert ctx.context_window(_cfg("anthropic", "claude-opus-5-5")) == 1_000_000
    assert ctx.context_window(_cfg("anthropic", "claude-sonnet-5-5")) == 1_000_000
    assert ctx.context_window(_cfg("anthropic", "claude-fable-5-1")) == 1_000_000
    assert ctx.context_window(_cfg("anthropic", "claude-haiku-5-5")) == 200_000
    assert ctx.context_window(_cfg("ollama", "qwen3:8b")) == 32_768
    assert ctx.context_window(_cfg("compatible", "x", extra={"context_window": 131072})) == 131_072


def test_output_tokens_auto_and_explicit():
    assert ctx.output_tokens(_cfg("anthropic", "claude-opus-5-5")) == 32_000
    assert ctx.output_tokens(_cfg("anthropic", "claude-haiku-5-5")) == 8_192
    assert ctx.output_tokens(_cfg("ollama", "qwen3")) == 4_096
    assert ctx.output_tokens(_cfg("anthropic", "claude-opus-5-5", max_tokens=2048)) == 2048


def test_budgets_scale():
    big = ctx.budgets(_cfg("anthropic", "claude-opus-5-5"))
    small = ctx.budgets(_cfg("ollama", "qwen3"))
    assert big.tool_result >= 100_000 and small.tool_result == 4_000
    assert big.knowledge == 200_000 and small.knowledge == 12_000
    assert big.attach_turn >= 500_000 and small.attach_turn == 40_000
    assert big.memory > small.memory
    assert big.input_tokens > 900_000
    assert small.input_tokens + small.output < small.window


def test_est_tokens_korean_conservative():
    assert ctx.est_tokens("가" * 1000) >= 1000
    assert ctx.est_tokens("a" * 3500) <= 1001


def test_fit_history_drops_oldest_keeps_last_user():
    b = ctx.budgets(_cfg("ollama", "qwen3"))
    msgs = []
    for i in range(40):
        msgs.append({"role": "user", "content": "질문" * 1000})
        msgs.append({"role": "assistant", "content": "답변" * 1000})
    msgs.append({"role": "user", "content": "마지막"})
    out, dropped = ctx.fit_history(msgs, b)
    assert dropped > 0
    assert out[-1]["content"] == "마지막"
    assert out[0]["role"] == "user"
    assert sum(ctx.est_tokens(m["content"]) for m in out) <= b.input_tokens


def test_fit_history_noop_on_1m():
    b = ctx.budgets(_cfg("anthropic", "claude-opus-5-5"))
    msgs = [{"role": "user", "content": "가" * 100_000}, {"role": "assistant", "content": "ok"},
            {"role": "user", "content": "다음"}]
    out, dropped = ctx.fit_history(msgs, b)
    assert dropped == 0 and out == msgs


def test_cache_last_message_str_and_blocks():
    conv = [{"role": "user", "content": "hi"}]
    _cache_last_message(conv)
    assert conv[0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    conv = [{"role": "user", "content": [{"type": "image", "source": {}}, {"type": "text", "text": "x"}]}]
    _cache_last_message(conv)
    assert conv[0]["content"][-1]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in conv[0]["content"][0]
