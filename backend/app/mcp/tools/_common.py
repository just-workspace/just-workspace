"""MCP 도구 공통 규약 — 페이지 넘김 · 오류 형식.

"설계 규칙" 의 구현. 모든 목록·검색 도구는 같은 모양으로 돌려준다:

    {"total": 24, "returned": 16, "has_more": true, "next_cursor": "eyJvIjoxNi...", "truncated": true, ...}

페이지 정보가 **맨 앞**이다(fit_page). 다음 페이지는 ``cursor=next_cursor`` 로 다시 부른다. 커서는
불투명 문자열(base64url JSON {"o": offset, "q": 검색 조건 해시})이고, 옛 숫자 커서도 받는다.
응답 길이는 아래 "응답 길이 맞추기" 절 참고(예산 단위 = 글자).

오류는 ``err(code, message)`` 로 돌려준다. ``execute_tool`` 이 이를
``{"ok": false, "error": message, "error_code": code, "retryable": bool}`` 로 바꾼다.
"""

from __future__ import annotations

ERROR_CODES = frozenset({
    "invalid_argument", "not_found", "forbidden", "too_large", "unsupported",
    "unavailable", "conflict", "rate_limited", "timeout", "internal",
    "needs_approval", "response_too_large",
})
# 같은 호출을 잠시 뒤 다시 해 볼 만한 오류
RETRYABLE = frozenset({"unavailable", "rate_limited", "timeout"})


def err(code: str, message: str, **extra) -> dict:
    """도구 오류. ``code`` 는 ERROR_CODES 중 하나."""
    if code not in ERROR_CODES:
        code = "internal"
    out = {"error": message, "error_code": code}
    out.update(extra)
    return out


def parse_cursor(cursor: object) -> int:
    """불투명 커서 → offset. 잘못된 값은 처음(0)으로."""
    if cursor in (None, ""):
        return 0
    try:
        return max(0, int(str(cursor)))
    except (TypeError, ValueError):
        return 0


def clamp(v: object, lo: int, hi: int, default: int) -> int:
    try:
        n = int(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def page_meta(total: int | None, offset: int, returned: int) -> dict:
    """공통 페이지 정보. total 을 모르면(None) returned 가 꽉 찼는지로만 판단할 수 없으니
    호출자가 has_more 를 직접 넣어야 한다 — 그 경우 page_meta_unknown 을 쓴다."""
    t = int(total or 0)
    nxt = offset + returned
    more = nxt < t
    return {
        "total": t,
        "returned": returned,
        "has_more": more,
        "next_cursor": str(nxt) if more else None,
    }


def page_meta_unknown(offset: int, returned: int, has_more: bool) -> dict:
    """전체 건수를 싸게 알 수 없는 목록(채팅 등)."""
    return {
        "total": None,
        "returned": returned,
        "has_more": bool(has_more),
        "next_cursor": str(offset + returned) if has_more else None,
    }


# 도구 설명 끝에 붙이는 공통 문구 — 모델이 페이지 넘김을 알게 한다.
PAGINATION_HINT = (
    " Paginated: the response starts with `total`, `returned`, `has_more`, `next_cursor`, `truncated`; "
    "when `has_more` is true call again with the same arguments and `cursor` set to `next_cursor` "
    "(an opaque string — pass it back unchanged). `truncated: true` means fewer items than `limit` "
    "were returned to keep the response small; nothing is lost — keep following `next_cursor`. "
    "An item with `shortened` had those long fields cut."
)

CURSOR_PARAM = {
    "type": "string",
    "description": "Pagination cursor — pass `next_cursor` from the previous response unchanged (opaque; only valid with the same query/filters). Empty = first page.",
    "default": "",
}


# ── 쓰기 도구 공통(S3) ─────────────────────────────────────────
# 되돌리기 도구는 다른 쓰기 도구처럼 등록돼 모델에게도 보인다. 아무 항목이나 지우는 "승인 없는 삭제"
# 통로가 되지 않게, 만든 도구가 돌려준 서명(token) 이 있어야만 그 항목을 지운다.
UNDO_HINT = (
    " Undo helper: reverses only an item that a workspace write tool just created, and needs the "
    "`token` that tool returned. Do not call it for anything else — use the regular delete tool."
)


def undo_token(user_id: str, kind: str, ident: str, extra: str = "") -> str:
    """되돌리기 서명 — (사용자, 종류, 대상, 덧붙임) 에 대한 HMAC. 서버 비밀키로만 만들 수 있다."""
    import hashlib
    import hmac

    from app.config import get_settings

    key = (get_settings().secret_key or "").encode()
    msg = f"mcp-undo|{user_id}|{kind}|{ident}|{extra}".encode()
    return hmac.new(key, msg, hashlib.sha256).hexdigest()[:40]


def check_undo_token(token: object, user_id: str, kind: str, ident: str, extra: str = "") -> bool:
    import hmac

    if not isinstance(token, str) or not token:
        return False
    return hmac.compare_digest(token, undo_token(user_id, kind, ident, extra))


UNDO_TOKEN_PARAM = {"type": "string", "description": "`token` from the original write's undo info.",
                    "x-label": "되돌리기 서명", "x-hidden": True}


def path_shared(path: object, user=None) -> bool:
    """가상 경로가 남도 보는 영역인가 — shared/…·shared-with-me/…·남의 users/<id>/….
    my/… 와 본인 users/<내 id>/… 만 '나만 보는 곳'이고, 비었으면 판정 대상이 아니다(False).
    알 수 없는 뿌리는 조심스러운 쪽(보인다)으로."""
    parts = [p for p in str(path or "").replace("\\", "/").strip().strip("/").split("/") if p]
    if not parts:
        return False
    if parts[0] == "my":
        return False
    if parts[0] == "users":
        return not (user is not None and len(parts) > 1 and parts[1] == str(getattr(user, "id", "")))
    return True


def shared_target(*keys: str):
    """Tool.visible_for 용 — 인자 keys(문자열 또는 목록) 가운데 하나라도 공유 영역이면 '남에게 보이는 쓰기'."""
    def _fn(args: dict, user=None) -> bool:
        for k in keys:
            v = (args or {}).get(k)
            for p in (v if isinstance(v, (list, tuple)) else [v]):
                if path_shared(p, user):
                    return True
        return False
    return _fn


def http_err(e: Exception, fallback: str = "invalid_argument") -> dict | None:
    """라우터 함수가 던진 HTTPException → err(). HTTPException 이 아니면 None."""
    status = getattr(e, "status_code", None)
    if not isinstance(status, int):
        return None
    code = {400: "invalid_argument", 401: "forbidden", 403: "forbidden", 404: "not_found",
            409: "conflict", 413: "too_large", 415: "unsupported", 422: "invalid_argument",
            429: "rate_limited", 502: "unavailable", 503: "unavailable", 504: "timeout"}.get(status, fallback)
    detail = getattr(e, "detail", None)
    if isinstance(detail, dict):
        detail = detail.get("message") or str(detail)
    return err(code, str(detail or e))


# ══ 응답 길이 맞추기(도구 응답 잘림 대책) ══════════
#
# 예전엔 내장 AI 가 도구 결과 JSON 을 4,000자에서 그냥 잘라 넘겨 JSON 이 깨지고, 맨 뒤의
# 페이지 정보(total·has_more·next_cursor)부터 사라졌다. 이제는:
#
#   1) 목록 도구가 스스로 항목 단위로 예산에 맞춘다(fit_page) — 페이지 정보가 맨 앞,
#      항목은 통째로만 넣고, 다 못 넣으면 truncated=true + next_cursor = 실제로 담은 다음.
#   2) 그래도 넘는 결과는 구조를 지키며 줄인다(fit_payload) — 본문 창(content/body)을 줄이고
#      next_offset 을 고치거나, 목록 끝 항목을 빼고 커서를 고치거나, 긴 문자열을 줄인다.
#   3) 어떻게 해도 안 되면 반쯤 잘린 JSON 대신 올바른 오류(response_too_large).
#
# ★ 예산 단위는 **글자 수**(json.dumps(..., ensure_ascii=False) 의 len)다. 모델과 MCP 응답은 모두
#   ensure_ascii=False 텍스트로 나가므로 모델이 보는 길이와 같다. 바이트로 재면 한글이 3배로
#   잡혀 같은 예산에 1/3 만 담기고, ensure_ascii=True 로 재면 \uXXXX 6배가 된다.
#
# 예산은 고정 상수가 아니다:
#   - MCP(원격) 경로: 설정 ``mcp_response_max_chars``(보수적 기본값).
#   - 내장 AI 경로: 라우터가 모델 컨텍스트에 맞춘 예산을 ``fit_budget_scope(n)`` 으로 건다
#     (app.ai.tool_budget.tool_result_budget). 도구는 ``fit_budget()`` 으로 현재 예산을 읽는다.

import base64 as _b64
import contextlib as _contextlib
import contextvars as _contextvars
import copy as _copy
import hashlib as _hashlib
import json as _json
from datetime import datetime as _dt
from datetime import timezone as _tz

# 설정을 못 읽을 때의 MCP 바깥 상한(글자). 설정값이 우선한다.
DEFAULT_RESPONSE_MAX_CHARS = 40_000
# 목록 페이지를 맞출 때 바깥 상한에서 남겨 두는 여유(신뢰 경계 래퍼·도구 이름 줄 등)
FIT_MARGIN = 400
# 아무리 작아도 이 밑으로는 맞추지 않는다
MIN_BUDGET = 600

TOO_LARGE_HINT = "limit 을 줄여 다시 호출"

_budget_var: _contextvars.ContextVar[int | None] = _contextvars.ContextVar("mcp_fit_budget", default=None)


def jlen(obj) -> int:
    """모델·MCP 가 실제로 받는 텍스트 길이(글자)."""
    return len(_json.dumps(obj, ensure_ascii=False, default=str))


def response_max_chars() -> int:
    """MCP 응답 바깥 상한 — 설정 mcp_response_max_chars."""
    try:
        from app.config import get_settings

        v = int(getattr(get_settings(), "mcp_response_max_chars", 0) or 0)
        return v if v > 0 else DEFAULT_RESPONSE_MAX_CHARS
    except Exception:  # noqa: BLE001
        return DEFAULT_RESPONSE_MAX_CHARS


def outer_cap() -> int:
    """지금 호출의 바깥 상한. 내장 AI 가 예산을 걸었으면 그것, 아니면 MCP 설정값."""
    v = _budget_var.get()
    return max(MIN_BUDGET, int(v)) if v else response_max_chars()


def fit_budget() -> int:
    """목록 도구가 자기 응답을 맞출 예산(글자) — 바깥 상한에서 여유를 뺀 값."""
    return max(MIN_BUDGET, outer_cap() - FIT_MARGIN)


@_contextlib.contextmanager
def fit_budget_scope(chars: int | None):
    """이 블록 안에서 부르는 도구의 바깥 상한을 ``chars`` 로(내장 AI 가 모델별 예산을 건다)."""
    token = _budget_var.set(int(chars) if chars else None)
    try:
        yield
    finally:
        _budget_var.reset(token)


# ── 불투명 커서 ───────────────────────────────────────────────
# base64url(JSON {"o": offset, "q": 검색어·조건 해시}). 검색어가 바뀐 채 이전 커서를 쓰면 오류.
# 옛 클라이언트가 보내는 숫자 커서("16")는 그대로 받는다(해시가 없으니 검사 못 함).

def query_hash(*parts) -> str:
    raw = _json.dumps(parts, ensure_ascii=False, default=str, sort_keys=True)
    return _hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def make_cursor(offset: int, qhash: str = "") -> str:
    raw = _json.dumps({"o": int(offset), "q": qhash}, separators=(",", ":")).encode()
    return _b64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _decode_cursor(cursor: str) -> tuple[int, str] | None:
    s = str(cursor).strip()
    try:
        obj = _json.loads(_b64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode("utf-8"))
        o = int(obj["o"])
        q = str(obj.get("q") or "")
    except Exception:  # noqa: BLE001
        return None
    if o < 0:
        return None
    return o, q


def read_cursor(cursor: object, qhash: str = "") -> tuple[int, dict | None]:
    """커서 → (offset, 오류). 오류가 있으면 도구는 그 오류를 그대로 돌려준다."""
    if cursor in (None, ""):
        return 0, None
    s = str(cursor).strip()
    if s.isdigit():                       # 옛 숫자 커서(하위호환)
        return int(s), None
    dec = _decode_cursor(s)
    if dec is None:
        return 0, err("invalid_argument",
                      "cursor 형식이 잘못됐습니다 — 이전 응답의 next_cursor 를 그대로 넘기거나 비워 두세요")
    off, q = dec
    if q != qhash:
        return 0, err("invalid_argument",
                      "cursor 가 다른 검색(검색어·조건)에서 나왔습니다 — 같은 조건으로 다시 부르거나 "
                      "cursor 를 비우고 처음부터 부르세요")
    return off, None


# ── 항목 다듬기 ───────────────────────────────────────────────
PROTECTED_KEYS = frozenset({"id", "path", "channel_id", "message_id", "attachment_id", "board_id",
                            "space_id", "calendar_id", "next_cursor", "cursor", "sha256"})


def drop_empty(d: dict) -> dict:
    """None·빈 문자열·빈 목록 필드를 뺀다(항목마다 붙던 "snippet": null 같은 것)."""
    return {k: v for k, v in d.items() if v is not None and v != "" and v != []}


def shorten(s, n: int):
    """긴 문자열을 n 글자(말줄임 포함)로."""
    if not isinstance(s, str) or len(s) <= n:
        return s
    return s[: max(0, n - 1)] + "…"


def human_size(n) -> str | None:
    """바이트 → "2.6MB"(1024 단위)."""
    try:
        v = float(n)
    except (TypeError, ValueError):
        return None
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if v < 1024 or unit == "TB":
            return f"{int(v)}B" if unit == "B" else f"{v:.1f}{unit}"
        v /= 1024
    return None


DEFAULT_TZ = "Asia/Seoul"


def user_tz(user):
    from zoneinfo import ZoneInfo

    try:
        return ZoneInfo(getattr(user, "timezone", None) or DEFAULT_TZ)
    except Exception:  # noqa: BLE001
        return ZoneInfo(DEFAULT_TZ)


def local_time(v, tz) -> str | None:
    """datetime(또는 ISO 문자열) → 사용자 시간대 "YYYY-MM-DD HH:MM". 시간대 없는 값은 UTC 로 본다."""
    if v is None or v == "":
        return None
    if isinstance(v, str):
        try:
            v = _dt.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return v
    if not isinstance(v, _dt):
        return str(v)
    if v.tzinfo is None:
        v = v.replace(tzinfo=_tz.utc)
    return v.astimezone(tz).strftime("%Y-%m-%d %H:%M")


def shrink_item(item, avail: int):
    """항목 하나가 예산(avail 글자)보다 크면 긴 필드부터 줄이고 ``shortened`` 에 줄인 필드를 적는다.
    id·path 같은 식별 필드는 마지막까지 지킨다(그래도 넘치면 어쩔 수 없이 줄인다)."""
    if not isinstance(item, dict):
        if isinstance(item, str):
            return shorten(item, max(20, avail - 2))
        return item
    it = _copy.deepcopy(item)
    short: list[str] = []
    for _ in range(64):
        over = jlen(it) + 40 - avail
        if over <= 0:
            break
        cands = [(k, v) for k, v in it.items() if isinstance(v, str) and k != "shortened" and len(v) > 20]
        pick = [c for c in cands if c[0] not in PROTECTED_KEYS] or cands
        if not pick:
            # 문자열이 아닌 큰 필드(목록 등) — 통째로 뺀다
            big = [k for k, v in it.items() if k not in PROTECTED_KEYS and k != "shortened"
                   and isinstance(v, (list, dict))]
            if not big:
                break
            k = max(big, key=lambda kk: jlen(it[kk]))
            it.pop(k)
            short.append(k)
            continue
        k, v = max(pick, key=lambda kv: len(kv[1]))
        it[k] = shorten(v, max(20, len(v) - over - 8))
        if k not in short:
            short.append(k)
    if short:
        it["shortened"] = short
    return it


# ── 목록 페이지 맞추기 ────────────────────────────────────────
def fit_page(
    items: list,
    *,
    offset: int = 0,
    total: int | None = None,
    list_key: str = "results",
    budget: int | None = None,
    qhash: str = "",
    extras: dict | None = None,
    has_more: bool | None = None,
    keep: str = "head",
    cursor_of=None,
) -> dict:
    """항목을 하나씩 담으며 길이를 재고 예산 직전에 멈춘다.

    돌려주는 사전의 **첫 키**는 ``total, returned, has_more, next_cursor, truncated`` — 앞쪽만 받아도
    페이지 정보는 남는다. 그다음 ``list_key`` 목록, 그다음 ``extras``(hint 등).

    - ``keep="head"``(기본): 앞에서부터 담는다. offset 커서(불투명, ``qhash`` 포함).
      ``next_cursor`` = offset + 실제로 담은 수 → 따라가면 중복·누락이 없다.
    - ``keep="tail"``: 뒤(최신)부터 담는다(채팅처럼 오래된 쪽으로 넘기는 목록).
      ``cursor_of(kept)`` 가 다음 커서를 만든다(예: 담은 것 중 가장 오래된 메시지 id).
    - 하나도 못 담을 만큼 큰 항목이면 긴 필드를 줄여 최소 1개는 담는다(``shortened`` 표시).
    - ``truncated`` = 예산 때문에 덜 담았거나 줄였다.
    """
    budget = int(budget or fit_budget())
    extras = extras or {}
    items = list(items or [])
    n_all = len(items)

    def assemble(kept: list, cut: bool) -> dict:
        returned = len(kept)
        if keep == "tail":
            more = bool(has_more) or (returned < n_all)
            nxt = (cursor_of(kept) if cursor_of else None) if (more and kept) else None
        else:
            nxt_off = offset + returned
            if total is not None:
                more = nxt_off < int(total)
            else:
                more = bool(has_more) or (returned < n_all)
            nxt = make_cursor(nxt_off, qhash) if more else None
        out = {"total": total, "returned": returned, "has_more": more,
               "next_cursor": nxt, "truncated": bool(cut)}
        out[list_key] = kept
        out.update(extras)
        return out

    base = jlen(assemble([], True)) + 80     # 숫자 자리·커서 길이 여유
    avail = budget - base
    order = items if keep == "head" else list(reversed(items))
    kept: list = []
    used = 0
    for it in order:
        ln = jlen(it) + 2
        if used + ln > avail:
            break
        kept.append(it)
        used += ln
    shortened = False
    if not kept and order:
        kept = [shrink_item(order[0], max(200, avail))]
        shortened = True
    if keep == "tail":
        kept.reverse()
    out = assemble(kept, shortened or len(kept) < n_all)
    # 실제 길이로 한 번 더 확인 — 넘으면 먼 쪽 끝부터 하나씩 뺀다
    while jlen(out) > budget and len(kept) > 1:
        kept = kept[1:] if keep == "tail" else kept[:-1]
        out = assemble(kept, True)
    return out


# ── 바깥 안전장치: 구조를 지키며 줄이기 ──────────────────────
_LIST_KEYS = ("results", "items", "messages", "posts", "events", "tasks", "contacts", "channels",
              "pages", "boards", "calendars", "entries")
_WINDOW_KEYS = ("content", "body")


def too_large_error(size: int, cap: int) -> dict:
    return {"ok": False, "error_code": "response_too_large", "retryable": False,
            "error": f"도구 응답이 너무 커서 줄여도 상한에 맞지 않습니다({size}자 > {cap}자)",
            "hint": TOO_LARGE_HINT}


def _shrink_window(d: dict, over: int) -> bool:
    """본문 창(content/body)을 줄이고 next_offset·truncated 를 고친다 — 이어 읽기가 끊기지 않게."""
    for k in _WINDOW_KEYS:
        v = d.get(k)
        if isinstance(v, str) and len(v) > 200:
            new_len = max(100, len(v) - over - 50)
            if new_len >= len(v):
                continue
            d[k] = v[:new_len]
            d["truncated"] = True
            if isinstance(d.get("offset"), int):
                d["next_offset"] = d["offset"] + new_len
            if "returned_chars" in d:
                d["returned_chars"] = new_len
            return True
    return False


def _drop_list_item(d: dict) -> bool:
    """페이지 목록 끝 항목 하나를 빼고 페이지 정보를 고친다. 커서를 고칠 수 없으면 손대지 않는다."""
    lists = [(k, d[k]) for k in _LIST_KEYS if isinstance(d.get(k), list) and len(d[k]) > 1]
    if not lists or "returned" not in d:
        return False
    k, lst = max(lists, key=lambda kv: jlen(kv[1]))
    returned = int(d.get("returned") or len(lst))
    # 채팅: 오래된 쪽(앞)을 빼고 커서 = 남은 것 중 가장 오래된 id
    if k == "messages" and "channel_id" in d and isinstance(lst[1], dict) and lst[1].get("id"):
        d[k] = lst[1:]
        d["returned"] = returned - 1
        d["has_more"] = True
        d["next_cursor"] = d[k][0].get("id")
        d["truncated"] = True
        return True
    nc = d.get("next_cursor")
    start = None
    q = ""
    legacy = False
    if nc in (None, ""):
        if isinstance(d.get("total"), int):
            start = d["total"] - returned
    elif str(nc).isdigit():
        start, legacy = int(str(nc)) - returned, True
    else:
        dec = _decode_cursor(str(nc))
        if dec:
            start, q = dec[0] - returned, dec[1]
    if start is None or start < 0:
        return False
    d[k] = lst[:-1]
    d["returned"] = returned - 1
    d["has_more"] = True
    nxt = start + returned - 1
    d["next_cursor"] = str(nxt) if legacy else make_cursor(nxt, q)
    d["truncated"] = True
    return True


def _shrink_longest_string(obj, over: int) -> bool:
    best = None   # (len, container, key)

    def walk(o):
        nonlocal best
        if isinstance(o, dict):
            for kk, vv in o.items():
                if isinstance(vv, str):
                    if kk not in PROTECTED_KEYS and len(vv) > 40 and (best is None or len(vv) > best[0]):
                        best = (len(vv), o, kk)
                else:
                    walk(vv)
        elif isinstance(o, list):
            for i, vv in enumerate(o):
                if isinstance(vv, str):
                    if len(vv) > 40 and (best is None or len(vv) > best[0]):
                        best = (len(vv), o, i)
                else:
                    walk(vv)

    walk(obj)
    if best is None:
        return False
    ln, cont, key = best
    cont[key] = shorten(cont[key], max(40, ln - over - 8))
    return True


def fit_payload(payload, cap: int):
    """``payload`` 를 ``cap`` 글자 이하로(구조 유지). 돌려주는 값: (객체, 텍스트).
    신뢰 경계 래퍼({untrusted, source, data})는 그대로 두고 data 안을 줄인다.
    어떻게 해도 안 되면 too_large_error(...)."""
    text = _json.dumps(payload, ensure_ascii=False, default=str)
    if len(text) <= cap:
        return payload, text
    orig = len(text)
    p = _copy.deepcopy(payload)
    wrapped = isinstance(p, dict) and p.get("untrusted") is True and isinstance(p.get("data"), dict)
    tgt = p["data"] if wrapped else p
    for _ in range(5000):
        over = len(text) - cap
        if over <= 0:
            return p, text
        done = False
        if isinstance(tgt, dict):
            done = _shrink_window(tgt, over) or _drop_list_item(tgt)
        if not done:
            done = _shrink_longest_string(tgt, over)
            if done and isinstance(tgt, dict):
                tgt["fields_shortened"] = True
        if not done:
            break
        text = _json.dumps(p, ensure_ascii=False, default=str)
    if len(text) <= cap:
        return p, text
    e = too_large_error(orig, cap)
    return e, _json.dumps(e, ensure_ascii=False)


def fit_json_text(payload, cap: int) -> str:
    """모델에 넣을 도구 결과 텍스트 — 언제나 올바른 JSON, cap 글자 이하."""
    return fit_payload(payload, cap)[1]
