"""AI 설정 + 거버넌스 (Phase B).

- 전역 제공자 설정(키 암호화) + 거버넌스(도구 허용목록·외부정책·사용자키 허용)를
  SystemSetting(key/value)에 저장 → 별도 테이블/마이그레이션 불필요.
- 사용자 동의(외부 AI 데이터 접근)도 SystemSetting per-user 키로.
- **ai_execute_tool**: 빌트인 AI의 유일한 데이터 접근 경로. MCP(execute_tool) 앞단에서
  거버넌스 검사 → 외부 상용 AI에 개인데이터가 무단으로 나가지 않게 통제 + 감사 로그.
"""
from __future__ import annotations

import ipaddress
import json
import logging
from urllib.parse import urlparse

from sqlalchemy import select

from app.ai.providers import ProviderConfig, SUPPORTED
from app.db.models import SystemSetting, User
from app.mail.crypto import decrypt_password, encrypt_password
from app.mcp.server import WORKSPACE_TOOLS, execute_tool as _mcp_execute

logger = logging.getLogger(__name__)

# 개인 데이터 도구 판정은 app.mcp.access 로 일원화(fail-closed: 비개인 도구만 명시, 나머지는 전부 개인 데이터).
# 예전 고정 목록엔 mail_read·채팅·게시판·캘린더·연락처·할일이 빠져, 외부 AI 데이터 접근을 꺼도 이들이 새어 나갔다.
from app.mcp.access import is_data_tool, tool_accessible  # noqa: E402


class _DataTools:
    """옛 ``name in DATA_TOOLS`` 호환 — 실제 판정은 is_data_tool."""

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and is_data_tool(name)

    def __iter__(self):
        return iter(sorted(n for n in WORKSPACE_TOOLS if is_data_tool(n)))


DATA_TOOLS = _DataTools()


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "host.docker.internal", "host.containers.internal"}


def _is_local_url(url: str) -> bool:
    """루프백/사설망 주소면 자체 호스팅으로 본다."""
    if not url:
        return False
    try:
        host = (urlparse(url if "://" in url else f"http://{url}").hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    if host in _LOCAL_HOSTS:
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback


def _is_external(kind: str, base_url: str = "") -> bool:
    """외부 상용 AI인지 — 개인데이터 도구에 동의 게이트를 걸지 결정한다.

    - ollama: 항상 내부(로컬 서빙).
    - compatible: base_url 이 루프백/사설망이면 **자체 호스팅**이므로 내부.
      (llama.cpp llama-server, vLLM 등 우리가 직접 돌리는 OpenAI 호환 서버)
    - openai/anthropic/gemini: base_url 과 무관하게 항상 외부.
      로컬 프록시를 두더라도 최종 목적지가 상용 API 이므로 보수적으로 본다.

    ⚠️ compatible + 사설주소는 "관리자가 그 주소에 무엇을 띄웠는지" 를 신뢰하는 것이다.
       사설 IP 에 상용 API 로 중계하는 프록시를 세우면 이 판정을 우회할 수 있다.
    """
    if not kind:
        return False
    if kind == "ollama":
        return False
    if kind == "compatible" and _is_local_url(base_url):
        return False
    return True


async def _get(db, key: str, default: str = "") -> str:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    return s.value if s is not None and s.value is not None else default


async def _set(db, key: str, value: str) -> None:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    if s:
        s.value = value
    else:
        db.add(SystemSetting(key=key, value=value))


AUDIT_RETENTION_KEY = "ai.gov.audit_retention_years"
AUDIT_RETENTION_CHOICES = (1, 2, 3)
LOCAL_ONLY_KEY = "ai.gov.local_only"


def audit_retention_years(v) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 1
    return n if n in AUDIT_RETENTION_CHOICES else 1


async def local_only(db) -> bool:
    return (await _get(db, LOCAL_ONLY_KEY, "false")) == "true"


def _int(v, default: int = 0) -> int:
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return default


# ─── 전역 제공자 설정 ───
async def get_ai_config(db, *, reveal_key: bool = False) -> dict:
    kind = await _get(db, "ai.provider.kind")
    enc = await _get(db, "ai.provider.api_key")
    key = ""
    if enc:
        try:
            key = decrypt_password(enc)
        except Exception:
            key = ""
    allowed_raw = await _get(db, "ai.gov.allowed_tools")
    return {
        "kind": kind,
        "model": await _get(db, "ai.provider.model"),
        # "워크스페이스 고급" — 같은 제공자의 다른(큰) 모델. 비우면 고급 선택지가 없다.
        "advanced_model": await _get(db, "ai.provider.advanced_model"),
        "base_url": (_bu := await _get(db, "ai.provider.base_url")),
        "max_tokens": int(await _get(db, "ai.provider.max_tokens", "0") or 0),
        "api_key": key if reveal_key else ("***" if key else ""),
        "has_key": bool(key),
        "external": _is_external(kind, _bu),
        "configured": bool(kind and await _get(db, "ai.provider.model")),
        "governance": {
            "allowed_tools": json.loads(allowed_raw) if allowed_raw else [],   # [] = 전체 허용
            "external_allow_data": (await _get(db, "ai.gov.external_allow_data", "false")) == "true",
            "allow_user_keys": (await _get(db, "ai.gov.allow_user_keys", "false")) == "true",
            # 한도 — 0 = 제한 없음. daily_limit: 사용자당 최근 24시간 질문 수, retention_days: 대화 보관 일수
            "daily_limit": _int(await _get(db, "ai.gov.daily_limit", "0")),
            "retention_days": _int(await _get(db, "ai.gov.retention_days", "0")),
            # 외부 AI 로 보내기 전 개인정보 가리기(기본 켬), AI 커넥터 쓰기 허용(기본 켬), 분당 도구 호출 한도
            "mask_pii": (await _get(db, "ai.gov.mask_pii", "true")) != "false",
            "mcp_write_enabled": (await _get(db, "mcp.write_enabled", "true")).strip().lower() not in ("false", "0", "off"),
            "mcp_rate_limit_per_min": _int(await _get(db, "mcp.rate_limit_per_min", "120"), 120),
            # 관리자 › AI 운영 › 정책 — AI 감사 기록 보관(년, 1·2·3 — 개인정보 접속기록 최소 1년),
            # 로컬 모델만 쓰기(외부 AI API 로 아무것도 보내지 않음 — 외부 제공자는 해석 단계에서 빠진다)
            "audit_retention_years": audit_retention_years(await _get(db, AUDIT_RETENTION_KEY, "1")),
            "local_only": (await _get(db, LOCAL_ONLY_KEY, "false")) == "true",
            # 분석 샌드박스(code_run) — 켜기(기본 켬, 내장 AI), 외부 커넥터(MCP) 노출(기본 끔)
            "code_run_enabled": (await _get(db, "ai.gov.code_run_enabled", "true")) != "false",
            "code_run_mcp": (await _get(db, "ai.gov.code_run_mcp", "false")) == "true",
        },
        "available_tools": sorted(WORKSPACE_TOOLS.keys()),
        "data_tools": sorted(DATA_TOOLS),
    }


def tools_for_user(gov: dict, external: bool) -> list[str]:
    """이 사용자 AI 가 실제로 쓸 수 있는 도구 이름 — 화면의 도구 목록·개수용(실행 관문은 ai_execute_tool).

    허용목록이 비어 있으면 전체, 외부 제공자에 데이터 접근이 막혀 있으면 개인데이터 도구는 뺀다.
    (동의 대기는 빼지 않는다 — 동의 배너로 풀 수 있는 상태라서.)
    """
    names = sorted(WORKSPACE_TOOLS.keys())
    allowed = gov.get("allowed_tools") or []
    if allowed:
        names = [n for n in names if n in allowed]
    if external and not gov.get("external_allow_data"):
        names = [n for n in names if n not in DATA_TOOLS]
    return names


async def set_ai_config(db, *, kind=None, model=None, base_url=None, api_key=None, max_tokens=None,
                        advanced_model=None) -> None:
    if advanced_model is not None:
        await _set(db, "ai.provider.advanced_model", advanced_model.strip())
    if kind is not None:
        if kind and kind not in SUPPORTED:
            raise ValueError(f"unsupported provider: {kind}")
        await _set(db, "ai.provider.kind", kind)
    if model is not None:
        await _set(db, "ai.provider.model", model)
    if base_url is not None:
        await _set(db, "ai.provider.base_url", base_url)
    if max_tokens is not None:
        await _set(db, "ai.provider.max_tokens", str(int(max_tokens)))
    if api_key is not None:
        await _set(db, "ai.provider.api_key", encrypt_password(api_key) if api_key else "")
    await db.commit()


async def set_governance(db, *, allowed_tools=None, external_allow_data=None, allow_user_keys=None,
                         daily_limit=None, retention_days=None, mask_pii=None, mcp_write_enabled=None,
                         mcp_rate_limit_per_min=None, audit_retention_years=None, local_only=None,
                         code_run_enabled=None, code_run_mcp=None) -> None:
    if audit_retention_years is not None:
        if int(audit_retention_years) not in AUDIT_RETENTION_CHOICES:
            raise ValueError("감사 로그 보관은 1·2·3년 중 하나입니다")
        await _set(db, AUDIT_RETENTION_KEY, str(int(audit_retention_years)))
    if local_only is not None:
        await _set(db, LOCAL_ONLY_KEY, "true" if local_only else "false")
    if code_run_enabled is not None:
        await _set(db, "ai.gov.code_run_enabled", "true" if code_run_enabled else "false")
    if code_run_mcp is not None:
        await _set(db, "ai.gov.code_run_mcp", "true" if code_run_mcp else "false")
    if mask_pii is not None:
        await _set(db, "ai.gov.mask_pii", "true" if mask_pii else "false")
    if mcp_write_enabled is not None:
        await _set(db, "mcp.write_enabled", "true" if mcp_write_enabled else "false")
    if mcp_rate_limit_per_min is not None:
        if not 0 <= int(mcp_rate_limit_per_min) <= 10000:
            raise ValueError("분당 도구 호출 한도는 0~10000 사이여야 합니다(0 = 제한 없음)")
        await _set(db, "mcp.rate_limit_per_min", str(int(mcp_rate_limit_per_min)))
    if daily_limit is not None:
        if not 0 <= int(daily_limit) <= 100000:
            raise ValueError("하루 요청 한도는 0~100000 사이여야 합니다")
        await _set(db, "ai.gov.daily_limit", str(int(daily_limit)))
    if retention_days is not None:
        if not 0 <= int(retention_days) <= 3650:
            raise ValueError("대화 보관 기간은 0~3650일 사이여야 합니다")
        await _set(db, "ai.gov.retention_days", str(int(retention_days)))
    if allowed_tools is not None:
        await _set(db, "ai.gov.allowed_tools", json.dumps(allowed_tools))
    if external_allow_data is not None:
        await _set(db, "ai.gov.external_allow_data", "true" if external_allow_data else "false")
    if allow_user_keys is not None:
        await _set(db, "ai.gov.allow_user_keys", "true" if allow_user_keys else "false")
    await db.commit()


# ─── 사용자 동의(외부 AI 데이터 접근) ───
async def get_user_consent(db, uid: str) -> bool:
    return (await _get(db, f"ai.user.{uid}.data_consent", "false")) == "true"


async def set_user_consent(db, uid: str, consent: bool) -> None:
    await _set(db, f"ai.user.{uid}.data_consent", "true" if consent else "false")
    await db.commit()


# ─── 제공자 해석(채팅용) ───
async def resolve_provider(db, *, advanced: bool = False) -> ProviderConfig | None:
    kind = await _get(db, "ai.provider.kind")
    model = await _get(db, "ai.provider.model")
    if advanced:
        model = await _get(db, "ai.provider.advanced_model") or model
    if not kind or not model:
        return None
    if _is_external(kind, await _get(db, "ai.provider.base_url")) and await local_only(db):
        return None   # 로컬 모델만 쓰기 — 외부 제공자는 없는 것으로 본다
    enc = await _get(db, "ai.provider.api_key")
    key = ""
    if enc:
        try:
            key = decrypt_password(enc)
        except Exception:
            key = ""
    return ProviderConfig(
        kind=kind, model=model,
        base_url=await _get(db, "ai.provider.base_url"),
        api_key=key,
        max_tokens=int(await _get(db, "ai.provider.max_tokens", "0") or 0),
    )


# ─── 사용자 개인 제공자(BYO 키) ───
def _user_prefix(uid: str) -> str:
    return f"ai.user.{uid}.provider."


async def allow_user_keys(db) -> bool:
    return (await _get(db, "ai.gov.allow_user_keys", "false")) == "true"


async def get_user_provider_config(db, uid: str, *, reveal_key: bool = False) -> dict:
    p = _user_prefix(uid)
    kind = await _get(db, p + "kind")
    enc = await _get(db, p + "api_key")
    key = ""
    if enc:
        try:
            key = decrypt_password(enc)
        except Exception:
            key = ""
    return {
        "kind": kind,
        "model": await _get(db, p + "model"),
        "base_url": (_bu := await _get(db, p + "base_url")),
        "max_tokens": int(await _get(db, p + "max_tokens", "0") or 0),
        "api_key": key if reveal_key else ("***" if key else ""),
        "has_key": bool(key),
        # 화면 표시용 가림 값(예: sk-…a91f). 키 전체는 절대 내보내지 않는다.
        "key_hint": mask_key(key),
        "verified_at": await _get(db, p + "verified_at") or None,
        "configured": bool(kind and await _get(db, p + "model")),
        "external": _is_external(kind, _bu),
    }


def mask_key(key: str) -> str:
    """API 키 가림 — 앞 3자(12자 이상일 때만)·뒤 4자만 남긴다."""
    if not key:
        return ""
    if len(key) < 8:
        return "…"
    head = key[:3] if len(key) >= 12 else ""
    return f"{head}…{key[-4:]}"


async def set_user_provider(db, uid: str, *, kind=None, model=None, base_url=None, api_key=None, max_tokens=None) -> None:
    p = _user_prefix(uid)
    # 연결 대상이 바뀌면 "연결 확인됨" 표시는 지운다(다시 시험해야 한다)
    if (kind is not None and kind != await _get(db, p + "kind")) or \
            (base_url is not None and base_url != await _get(db, p + "base_url")) or api_key is not None:
        await _set(db, p + "verified_at", "")
    if kind is not None:
        if kind and kind not in SUPPORTED:
            raise ValueError(f"unsupported provider: {kind}")
        await _set(db, p + "kind", kind)
    if model is not None:
        await _set(db, p + "model", model)
    if base_url is not None:
        await _set(db, p + "base_url", base_url)
    if max_tokens is not None:
        await _set(db, p + "max_tokens", str(int(max_tokens)))
    if api_key is not None:
        await _set(db, p + "api_key", encrypt_password(api_key) if api_key else "")
    await db.commit()


async def clear_user_provider(db, uid: str) -> None:
    p = _user_prefix(uid)
    for k in ("kind", "model", "base_url", "max_tokens", "api_key", "verified_at"):
        await _set(db, p + k, "")
    await db.commit()


async def resolve_user_provider(db, uid: str) -> ProviderConfig | None:
    p = _user_prefix(uid)
    kind = await _get(db, p + "kind")
    model = await _get(db, p + "model")
    if not kind or not model:
        return None
    if _is_external(kind, await _get(db, p + "base_url")) and await local_only(db):
        return None   # 로컬 모델만 쓰기 — 외부 개인 키도 쓰지 않는다
    enc = await _get(db, p + "api_key")
    key = ""
    if enc:
        try:
            key = decrypt_password(enc)
        except Exception:
            key = ""
    return ProviderConfig(
        kind=kind, model=model,
        base_url=await _get(db, p + "base_url"), api_key=key,
        max_tokens=int(await _get(db, p + "max_tokens", "0") or 0),
    )


async def resolve_provider_for_user(db, user: User) -> tuple[ProviderConfig | None, bool]:
    """사용자 기본 모델(설정 › AI)에 따라 제공자를 고른다. (cfg, is_personal) 반환.

    - "personal": 개인 키 허용 + 개인 설정이 있으면 그것(없으면 워크스페이스 기본으로)
    - "workspace_advanced": 관리자가 고급 모델을 지정했으면 그것(없으면 기본 모델)
    - "workspace": 워크스페이스 기본
    - 미지정(예전 사용자): 예전 동작 — 개인 설정이 있으면 개인, 아니면 전역
    """
    choice = await _get(db, _pref_prefix(user.id) + "default_model")
    if choice in ("", "personal") and await allow_user_keys(db):
        up = await resolve_user_provider(db, user.id)
        if up is not None:
            return up, True
    if choice == "workspace_advanced":
        return await resolve_provider(db, advanced=True), False
    return await resolve_provider(db), False


# ─── 사용자 AI 기본값(설정 › AI: 기본 모델·도구 기본값·내 지침) ───
DEFAULT_MODEL_CHOICES = ("workspace", "workspace_advanced", "personal")
# 화면의 도구 스위치 → 실제 도구 이름(접두). 여기 없는 도구(채팅·게시판·노트 등)는 스위치와 무관.
TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "mail": ("mail_",),
    "files": ("files_", "pdf_", "docx_", "xlsx_", "pptx_"),
    "calendar": ("calendar_",),
    "web": ("web_search", "web_fetch"),
}
DEFAULT_TOOL_PREFS = {"mail": True, "files": True, "calendar": True, "web": False}
MAX_INSTRUCTIONS = 2000


def _pref_prefix(uid: str) -> str:
    return f"ai.user.{uid}.pref."


def tool_group(name: str) -> str | None:
    for g, prefixes in TOOL_GROUPS.items():
        if any(name.startswith(px) for px in prefixes):
            return g
    return None


def tool_enabled_by_prefs(name: str, prefs_tools: dict) -> bool:
    g = tool_group(name)
    return True if g is None else bool(prefs_tools.get(g, DEFAULT_TOOL_PREFS.get(g, True)))


async def get_user_ai_prefs(db, uid: str) -> dict:
    p = _pref_prefix(uid)
    raw = await _get(db, p + "tools")
    tools = dict(DEFAULT_TOOL_PREFS)
    if raw:
        try:
            d = json.loads(raw)
            if isinstance(d, dict):
                tools.update({k: bool(v) for k, v in d.items() if k in TOOL_GROUPS})
        except ValueError:
            pass
    choice = await _get(db, p + "default_model")
    return {
        "default_model": choice if choice in DEFAULT_MODEL_CHOICES else "",
        "tools": tools,
        "instructions": await _get(db, p + "instructions"),
    }


async def set_user_ai_prefs(db, uid: str, *, default_model=None, tools=None, instructions=None) -> dict:
    p = _pref_prefix(uid)
    if default_model is not None:
        if default_model not in DEFAULT_MODEL_CHOICES:
            raise ValueError("기본 모델 선택이 올바르지 않습니다")
        await _set(db, p + "default_model", default_model)
    if tools is not None:
        cur = (await get_user_ai_prefs(db, uid))["tools"]
        cur.update({k: bool(v) for k, v in tools.items() if k in TOOL_GROUPS})
        await _set(db, p + "tools", json.dumps(cur))
    if instructions is not None:
        text = instructions.strip()
        if len(text) > MAX_INSTRUCTIONS:
            raise ValueError(f"지침은 {MAX_INSTRUCTIONS}자 이하로 써 주세요")
        await _set(db, p + "instructions", text)
    await db.commit()
    return await get_user_ai_prefs(db, uid)


def compose_system(instructions: str, conv_system: str) -> str | None:
    """내 지침(모든 대화) + 대화별 시스템 프롬프트."""
    parts = [x.strip() for x in (instructions or "", conv_system or "") if x and x.strip()]
    return "\n\n".join(parts) or None


# ─── MCP 단일 관문(거버넌스 검사 후 실행) ───
def is_write_tool(name: str) -> bool:
    """읽기 전용(mcp:read)이 아닌 도구 — 모르는 도구도 쓰기로 본다."""
    t = WORKSPACE_TOOLS.get(name)
    return t is None or getattr(t, "scope", "mcp:write") != "mcp:read"


async def ai_execute_tool(db, name: str, args: dict, user: User, *, provider_external: bool,
                          confirmed: bool = False, conversation_id: str | None = None,
                          client_name: str = "내장 AI", client_kind: str = "builtin_web") -> dict:
    """AI 도구 호출의 유일한 경로. 정책 위반 시 차단(데이터 외부유출 방지) + 감사 로그.

    쓰기 도구는 모델이 부른 것만으로는 실행하지 않는다 — 대화에 들어온 외부 입력(메일 본문·웹
    결과)이 모델을 움직여 쓰기를 일으킬 수 있기 때문이다. 사용자가 확인 토큰으로 승인한 호출
    (confirmed=True, POST /api/ai/tools/confirm)만 실행한다. 읽기 도구는 mcp:read 스코프로만 돈다.
    """
    cfg = await get_ai_config(db)
    gov = cfg["governance"]
    allowed = gov["allowed_tools"]
    if allowed and name not in allowed:
        logger.info("[ai-tool][deny:allowlist] user=%s tool=%s", user.id, name)
        return {"ok": False, "error": f"도구 '{name}'는 AI에 허용되지 않았습니다(관리자 설정)"}
    if not tool_enabled_by_prefs(name, (await get_user_ai_prefs(db, user.id))["tools"]):
        logger.info("[ai-tool][deny:user-pref] user=%s tool=%s", user.id, name)
        return {"ok": False, "error": f"도구 '{name}'는 내 AI 설정에서 꺼져 있습니다(설정 › AI)"}
    if name in DATA_TOOLS and provider_external:
        if not gov["external_allow_data"]:
            logger.info("[ai-tool][deny:external] user=%s tool=%s", user.id, name)
            return {"ok": False, "error": "외부 AI의 개인데이터 접근이 비활성화되어 있습니다(관리자 설정)"}
        if not await get_user_consent(db, user.id):
            logger.info("[ai-tool][deny:consent] user=%s tool=%s", user.id, name)
            return {"ok": False, "error": "외부 AI 데이터 접근에 대한 사용자 동의가 필요합니다"}
    if not await tool_accessible(db, user, name):
        # MCP 와 같은 관문 — 관리자가 끈 모듈·그룹 권한 없는 기능은 AI 로도 못 쓴다
        logger.info("[ai-tool][deny:module/rbac] user=%s tool=%s", user.id, name)
        return {"ok": False, "error_code": "forbidden",
                "error": f"도구 '{name}'를 쓸 권한이 없거나 해당 기능이 꺼져 있습니다"}
    write = is_write_tool(name)
    logger.info("[ai-tool][run] user=%s tool=%s external=%s write=%s confirmed=%s args=%s",
                user.id, name, provider_external, write, confirmed, json.dumps(args, ensure_ascii=False)[:200])
    # 쓰기 도구는 실행하지 않고 승인 요청(app.mcp.writes)을 만든다 — low 는 채팅 카드 [실행],
    # high 는 승인 대기함. 대화에 들어온 외부 입력(메일 본문·웹 결과)이 모델을 움직여도 사람 손을 거친다.
    # confirmed=True(옛 확인 토큰 경로)는 사용자가 이미 누른 것이므로 요청을 만든 뒤 곧바로 승인한다.
    from app.mcp import writes

    if write and await writes.get_permission_mode(db, user.id) == "plan":
        # 계획 모드(Claude Code plan) — 쓰기는 만들지도 않는다. 모델은 계획을 글로 낸다
        return {"ok": False, "error_code": "plan_mode",
                "error": "계획 모드입니다. 아무것도 실행하지 말고, 할 일을 단계별 계획으로 정리해 사용자에게 보여 주세요. "
                         "사용자가 모드를 바꾸면 그때 실행합니다."}
    ctx_token = writes.call_context.set(writes.CallContext(
        source="ai", client_name=client_name, client_kind=client_kind,
        client_key=conversation_id or f"ai:{user.id}",
        conversation_id=conversation_id))
    try:
        res = await _mcp_execute(name, args, user,
                                 scopes=frozenset({"mcp:read", "mcp:write"}) if write else frozenset({"mcp:read"}))
    finally:
        writes.call_context.reset(ctx_token)
    if write and confirmed and res.get("ok"):
        rid = (res.get("result") or {}).get("request_id")
        if rid and (res["result"].get("status") in ("pending_confirmation", "pending_approval")):
            try:
                req = await writes.approve(db, user, rid)
                return {"ok": req.status == "executed", "result": writes._model_view(req),
                        **({} if req.status == "executed" else {"error": req.error or req.status})}
            except writes.WriteError as e:
                return {"ok": False, "error": e.message, "error_code": e.code}
    if write and res.get("ok") and (res.get("result") or {}).get("status") in ("pending_confirmation", "pending_approval"):
        # 화면이 카드(또는 대기함 안내)를 그리도록 표시. 모델에게는 "실행하지 않았다"가 간다.
        res["needs_confirmation"] = True
        res["write_request_id"] = res["result"].get("request_id")
    return res
