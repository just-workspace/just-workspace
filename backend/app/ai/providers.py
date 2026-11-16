"""AI 제공자 추상화 — 로컬(Ollama) + 상용(OpenAI/Anthropic) + OpenAI 호환 generic.

공통 메시지 포맷: [{"role": "system|user|assistant|tool", "content": str}]
공통 툴 포맷: OpenAI function-calling 스키마(있으면). 제공자별로 변환.

핵심 인터페이스:
    cfg = ProviderConfig(kind="openai", api_key=..., model="gpt-4o-mini")
    async for ev in chat_stream(cfg, messages, system=None, tools=None):
        ev = {"type": "text", "text": "..."} | {"type":"tool_call","name","args"} |
             {"type": "done"} | {"type": "error", "message": "..."}
    text = await chat(cfg, messages)             # 비스트리밍 편의
    models = await list_models(cfg)              # 모델 목록(가능한 경우)
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

import httpx

# 제공자별 기본 base URL
DEFAULT_BASE = {
    "ollama": "http://host.docker.internal:11434",
    "openai": "https://api.openai.com",
    "anthropic": "https://api.anthropic.com",
    "gemini": "https://generativelanguage.googleapis.com",
    "compatible": "",  # 직접 지정 필수
}
SUPPORTED = tuple(DEFAULT_BASE.keys())
_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)


@dataclass
class ProviderConfig:
    kind: str                       # ollama | openai | anthropic | gemini | compatible
    model: str
    api_key: str = ""
    base_url: str = ""              # 미지정 시 DEFAULT_BASE[kind] 사용
    max_tokens: int = 0             # 0 = 모델 기준 자동 산정(app.ai.context.output_tokens)
    extra: dict = field(default_factory=dict)

    @property
    def base(self) -> str:
        return (self.base_url or DEFAULT_BASE.get(self.kind, "")).rstrip("/")


# ─── 이미지 입력(첨부) ───
# 공통 메시지에 {"images": [{"mime", "data"(base64)}]} 가 포함되면 제공자별 형식으로 변환한다.
# 모델의 이미지 입력 지원 여부는 모델 이름으로 추정한다(정확한 능력 조회 API 가 제공자별로 없거나 상이하다).
# 관리자가 extra["vision"] 을 지정하면 해당 값을 우선한다.
_VISION_HINTS = ("vision", "llava", "-vl", "vl-", "_vl", "qwen2.5vl", "qwen2-vl", "qwen3-vl", "gemma3", "gemma-3",
                 "minicpm-v", "pixtral", "llama4", "llama-4", "mistral-small3.1", "mistral-small-3.1", "moondream",
                 "bakllava", "internvl", "glm-4v", "phi-3.5-vision", "phi-4-multimodal", "granite3.2-vision")
_OPENAI_VISION = ("gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "gpt-5", "chatgpt-4o", "o1", "o3", "o4")


def supports_vision(cfg: "ProviderConfig | None") -> bool:
    if cfg is None:
        return False
    extra = getattr(cfg, "extra", None) or {}
    if "vision" in extra:
        return bool(extra["vision"])
    name = (getattr(cfg, "model", "") or "").lower()
    kind = getattr(cfg, "kind", "")
    if kind == "anthropic":
        return name.startswith("claude") and "claude-2" not in name and "instant" not in name
    if kind == "openai":
        if any(x in name for x in ("o1-mini", "o3-mini", "gpt-3.5")):
            return False
        return name.startswith(_OPENAI_VISION)
    if kind in ("ollama", "compatible"):
        return any(h in name for h in _VISION_HINTS)
    return False


def _with_images(kind: str, messages: list[dict]) -> list[dict]:
    out = []
    for m in messages:
        imgs = m.get("images") if isinstance(m, dict) else None
        if not imgs:
            if isinstance(m, dict) and "images" in m:
                m = {k: v for k, v in m.items() if k != "images"}
            out.append(m)
            continue
        text = m.get("content") or ""
        if kind == "ollama":
            out.append({"role": m["role"], "content": text, "images": [i["data"] for i in imgs]})
        elif kind == "anthropic":
            parts = [{"type": "image", "source": {"type": "base64", "media_type": i["mime"], "data": i["data"]}}
                     for i in imgs]
            parts.append({"type": "text", "text": text or "(이미지)"})
            out.append({"role": m["role"], "content": parts})
        else:  # openai · compatible
            parts = [{"type": "text", "text": text or "(이미지)"}]
            parts += [{"type": "image_url", "image_url": {"url": f"data:{i['mime']};base64,{i['data']}"}} for i in imgs]
            out.append({"role": m["role"], "content": parts})
    return out


# ─── OpenAI / 호환 ───
def _openai_headers(cfg: ProviderConfig) -> dict:
    h = {"Content-Type": "application/json"}
    if cfg.api_key:
        h["Authorization"] = f"Bearer {cfg.api_key}"
    return h


async def _openai_stream(cfg: ProviderConfig, messages, tools):
    payload = {"model": cfg.model, "messages": messages, "stream": True}
    if tools:
        payload["tools"] = tools
    url = f"{cfg.base}/v1/chat/completions"
    # OpenAI 스트리밍은 tool_call 의 arguments 를 여러 delta 로 분할하여 전송한다.
    # name 은 통상 첫 delta 에만 포함되고, arguments 는 후속 delta 에 분할되어 수신된다.
    # → index 별로 누적한 뒤 스트림 종료 후 일괄 방출한다.
    # (ollama 는 tool_calls 를 단일 덩어리로 전달하므로 해당 문제가 드러나지 않았다)
    tool_acc: dict[int, dict] = {}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        # llama.cpp 라우터 모드는 모델 자식 프로세스가 종료되면(콜드 로드 중 abort 등)
        # 5xx "upstream error" 를 반환하고, **다음 요청에서 모델을 재적재한다.**
        # 해당 1회 실패를 사용자에게 오류로 노출하지 않고 짧은 대기 후 재시도한다.
        # 토큰을 하나라도 송신한 뒤에는 재시도가 불가하므로 상태 코드 단계에서만 수행한다.
        attempts = 0
        while True:
            attempts += 1
            resp_cm = client.stream("POST", url, headers=_openai_headers(cfg), json=payload)
            resp = await resp_cm.__aenter__()
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")
                await resp_cm.__aexit__(None, None, None)
                retryable = resp.status_code >= 500 or "upstream" in body.lower()
                if retryable and attempts < 3:
                    await asyncio.sleep(3.0 * attempts)
                    continue
                hint = " (로컬 LLM 이 응답하지 않습니다 — 모델을 다시 올리는 중일 수 있으니 잠시 후 다시 시도하세요)" if retryable else ""
                yield {"type": "error", "message": f"{resp.status_code}: {body[:300]}{hint}"}
                return
            break
        try:
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                    delta = obj["choices"][0].get("delta", {})
                    if delta.get("content"):
                        yield {"type": "text", "text": delta["content"]}
                    for tc in delta.get("tool_calls", []) or []:
                        slot = tool_acc.setdefault(tc.get("index", 0), {"name": "", "args": ""})
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] = fn["name"]
                        if fn.get("arguments"):
                            slot["args"] += fn["arguments"]
                except Exception:
                    continue
        finally:
            await resp_cm.__aexit__(None, None, None)
    for _idx, slot in sorted(tool_acc.items()):
        if slot["name"]:
            yield {"type": "tool_call", "name": slot["name"], "args": slot["args"]}
    yield {"type": "done"}


# ─── Ollama ───
async def _ollama_stream(cfg: ProviderConfig, messages, tools):
    payload = {"model": cfg.model, "messages": messages, "stream": True}
    if tools:
        payload["tools"] = tools
    if "keep_alive" in cfg.extra:
        payload["keep_alive"] = cfg.extra["keep_alive"]
    url = f"{cfg.base}/api/chat"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        async with client.stream("POST", url, json=payload) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")
                yield {"type": "error", "message": f"{resp.status_code}: {body[:300]}"}
                return
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    msg = obj.get("message") or {}
                    if msg.get("content"):
                        yield {"type": "text", "text": msg["content"]}
                    for tc in msg.get("tool_calls", []) or []:
                        fn = tc.get("function", {})
                        if fn.get("name"):
                            args = fn.get("arguments", {})
                            yield {"type": "tool_call", "name": fn["name"],
                                   "args": args if isinstance(args, str) else json.dumps(args)}
                    if obj.get("done"):
                        break
                except Exception:
                    continue
    yield {"type": "done"}


# ─── Anthropic ───
def _openai_tools_to_anthropic(tools) -> list[dict]:
    """OpenAI function 스키마 → Anthropic tools 스키마."""
    out = []
    for t in tools or []:
        fn = t.get("function", t)
        out.append({
            "name": fn.get("name"),
            "description": fn.get("description", ""),
            "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
        })
    return out


def _cache_last_message(conv: list[dict]) -> None:
    """프롬프트 캐시 — 마지막 메시지 끝에 캐시 지점을 설정한다(도구·시스템 포함 최대 3개, 한도 4).

    1M 컨텍스트에서 긴 대화·대용량 첨부를 매 차례 재전송하더라도 앞부분은 캐시 읽기(입력가의 1/20)로 처리된다.
    """
    if not conv:
        return
    last = conv[-1]
    c = last.get("content")
    if isinstance(c, str):
        if not c:
            return
        last["content"] = [{"type": "text", "text": c, "cache_control": {"type": "ephemeral"}}]
    elif isinstance(c, list) and c and isinstance(c[-1], dict):
        c[-1] = {**c[-1], "cache_control": {"type": "ephemeral"}}


async def _anthropic_stream(cfg: ProviderConfig, messages, system, tools=None):
    # system은 별도 파라미터, messages는 user/assistant만(content=str)
    sys_parts = [m["content"] for m in messages if m.get("role") == "system" and m.get("content")]
    if system:
        sys_parts.insert(0, system)
    conv = [{"role": m["role"], "content": m.get("content", "")}
            for m in messages if m.get("role") in ("user", "assistant")]
    from app.ai.context import output_tokens

    payload = {"model": cfg.model, "max_tokens": output_tokens(cfg), "messages": conv, "stream": True}
    cache = (cfg.extra or {}).get("prompt_cache", True)
    if sys_parts:
        text = "\n\n".join(sys_parts)
        payload["system"] = [{"type": "text", "text": text, **({"cache_control": {"type": "ephemeral"}} if cache else {})}]
    if tools:
        payload["tools"] = _openai_tools_to_anthropic(tools)
        if cache:
            payload["tools"][-1]["cache_control"] = {"type": "ephemeral"}
    if cache:
        _cache_last_message(conv)
    headers = {
        "Content-Type": "application/json",
        "x-api-key": cfg.api_key,
        "anthropic-version": "2023-06-01",
    }
    url = f"{cfg.base}/v1/messages"
    cur_tool = None  # 진행 중 tool_use 블록: {"name", "args"(partial json 누적)}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "replace")
                yield {"type": "error", "message": f"{resp.status_code}: {body[:300]}"}
                return
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    obj = json.loads(line[5:].strip())
                except Exception:
                    continue
                typ = obj.get("type")
                if typ == "content_block_start":
                    cb = obj.get("content_block", {})
                    if cb.get("type") == "tool_use":
                        cur_tool = {"name": cb.get("name", ""), "args": ""}
                elif typ == "content_block_delta":
                    d = obj.get("delta", {})
                    dt = d.get("type")
                    if dt == "text_delta" and d.get("text"):
                        yield {"type": "text", "text": d["text"]}
                    elif dt == "input_json_delta" and cur_tool is not None:
                        cur_tool["args"] += d.get("partial_json", "")
                elif typ == "content_block_stop":
                    if cur_tool is not None:
                        yield {"type": "tool_call", "name": cur_tool["name"], "args": cur_tool["args"] or "{}"}
                        cur_tool = None
                elif typ == "message_stop":
                    break
    yield {"type": "done"}


async def chat_stream(cfg: ProviderConfig, messages: list[dict], system: str | None = None,
                      tools: list[dict] | None = None):
    """제공자별 스트리밍 채팅. 이벤트 dict를 async yield."""
    messages = _with_images(cfg.kind, messages)
    if cfg.kind in ("openai", "compatible"):
        msgs = list(messages)
        if system:
            msgs = [{"role": "system", "content": system}] + msgs
        async for ev in _openai_stream(cfg, msgs, tools):
            yield ev
    elif cfg.kind == "ollama":
        msgs = list(messages)
        if system:
            msgs = [{"role": "system", "content": system}] + msgs
        async for ev in _ollama_stream(cfg, msgs, tools):
            yield ev
    elif cfg.kind == "anthropic":
        async for ev in _anthropic_stream(cfg, messages, system, tools):
            yield ev
    else:
        yield {"type": "error", "message": f"지원하지 않는 제공자: {cfg.kind}"}


async def chat(cfg: ProviderConfig, messages: list[dict], system: str | None = None) -> str:
    """비스트리밍 — 전체 텍스트를 누적하여 반환(요약/분류 등 내부 용도)."""
    out = []
    async for ev in chat_stream(cfg, messages, system=system):
        if ev["type"] == "text":
            out.append(ev["text"])
        elif ev["type"] == "error":
            raise RuntimeError(ev["message"])
    return "".join(out)


async def list_models(cfg: ProviderConfig) -> list[str]:
    """가능한 경우 모델 목록 반환(관리자 UI용). 실패 시 빈 목록."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            if cfg.kind == "ollama":
                r = await client.get(f"{cfg.base}/api/tags")
                return [m["name"] for m in r.json().get("models", [])]
            if cfg.kind in ("openai", "compatible"):
                r = await client.get(f"{cfg.base}/v1/models", headers=_openai_headers(cfg))
                return [m["id"] for m in r.json().get("data", [])]
            if cfg.kind == "anthropic":
                r = await client.get(
                    f"{cfg.base}/v1/models",
                    headers={"x-api-key": cfg.api_key, "anthropic-version": "2023-06-01"},
                )
                return [m["id"] for m in r.json().get("data", [])]
    except Exception:
        return []
    return []  # gemini: 고정 목록은 상위에서 제공
