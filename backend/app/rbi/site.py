"""격리 브라우저 전용 출처(RBI_PUBLIC_ORIGIN, 예 https://rbi.example.com) — 자체 세션 쿠키 · 워크스페이스 SSO 홉.

분리 사유
  격리 브라우저 화면(KasmVNC 클라이언트 스크립트 · 미러 문서 · 세션 컨테이너가 제공하는 모든 응답)이 워크스페이스 출처
  (example.com)에서 제공되면, 세션 컨테이너 침해 시 해당 출처의 쿠키·API 가 동일 출처 범위에 노출된다.
  rbi 출처는 워크스페이스와 **상이한 출처**이다 — 워크스페이스 세션 쿠키(host-only, example.com)는 rbi 출처로 전송되지 않고,
  rbi 출처의 세션 쿠키(__Host-, host-only, rbi.example.com)는 워크스페이스로 전송되지 않는다.

SSO 홉(OAuth 인가 코드와 동일한 형태, 두 출처 사이에서만 사용)
  1. rbi  GET /auth/login?return=/x        → state 난수를 서명 쿠키(__Host-jw_rbi_state, Lax, 10분)에 저장하고
                                              302 https://<워크스페이스>/rbi-login?state=…&return=/x
  2. ws   GET /rbi-login?state&return      → 워크스페이스 로그인 확인(미로그인 시 /login?redirect=… 경유 후 복귀)
                                              → 일회용 코드(60초, Redis, 사용자·워크스페이스 세션·state 결합)
                                              → 302 <RBI_PUBLIC_ORIGIN>/auth/callback?code&state   (목적지는 설정값 — 요청으로 변경 불가)
  3. rbi  GET /auth/callback?code&state    → state 쿠키 == 쿼리 state == 코드의 state, 코드는 GETDEL(1회 한정)
                                              → rbi 세션(Redis rbi:site:<rsid>, 8시간) + __Host-jw_rbi(Strict, HttpOnly, Secure, Path=/)
                                              → 302 return(rbi 출처 내 경로만 허용)
  로그아웃(rbi)은 rbi 세션만 삭제한다. 워크스페이스 로그아웃·강제 로그아웃(token_version)·기기 세션 취소는
  rbi 세션이 매 요청 확인하는 "워크스페이스 세션 에포크"(해당 sid 의 존재 여부 + tv 일치 여부)에 의해 연동 종료된다.

rbi 출처의 요청은 RbiHostGuard 가 /api/rbi/* 와 nginx 내부 인증(/api/internal/rbi/auth)을 제외하고 404 로 차단한다(ws-nginx 도 동일 목록만 허용한다).
"""
from __future__ import annotations

import hmac
import json
import logging
import re
import secrets
import time
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import sessions as sess_mod
from app.auth.deps import SESSION_COOKIE, SessionInvalid, get_current_user, unsign_value, verify_session_data
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db

logger = logging.getLogger(__name__)

#: 일회용 코드 수명(초). 리디렉트 2회로 완료되는 구간
CODE_TTL = 60
#: 홉 이전 state 쿠키 수명(초). 워크스페이스 로그인(2단계 인증 포함)을 거쳐 복귀하는 데 필요한 시간
STATE_TTL = 600
CODE_PREFIX = "rbi:sso:"
SITE_PREFIX = "rbi:site:"
_STATE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
#: rbi 출처에서 허용하는 백엔드 경로(그 외는 404). ws-nginx 의 rbi server 블록과 동일 목록
RBI_HOST_PATHS = ("/api/rbi/",)
RBI_HOST_EXACT = ("/api/internal/rbi/auth",)


# ── 설정 ──

def public_origin() -> str:
    """RBI_PUBLIC_ORIGIN 을 "scheme://host[:port]" 형식으로 정규화한다(경로·쿼리 제외, 소문자). 빈 값이거나 잘못된 값이면 ""(기능 비활성화)."""
    raw = (get_settings().rbi_public_origin or "").strip()
    if not raw:
        return ""
    u = urlsplit(raw)
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password \
            or (u.path not in ("", "/")) or u.query or u.fragment:
        logger.warning("[rbi.site] RBI_PUBLIC_ORIGIN 이 올바르지 않습니다: %r — 전용 출처를 끕니다", raw)
        return ""
    return f"{u.scheme}://{u.netloc}".lower()


def workspace_origin() -> str:
    u = urlsplit(get_settings().app_url)
    return f"{u.scheme}://{u.netloc}".lower()


def rbi_hostname() -> str:
    o = public_origin()
    return (urlsplit(o).hostname or "") if o else ""


def _host_only(host: str) -> str:
    h = (host or "").strip().lower()
    if h.startswith("["):
        return h.split("]", 1)[0] + "]"
    return h.split(":", 1)[0]


def is_rbi_host_header(host: str) -> bool:
    rh = rbi_hostname()
    return bool(rh) and _host_only(host) == rh


def is_rbi_host(request: Request) -> bool:
    return is_rbi_host_header(request.headers.get("host", ""))


def _secure() -> bool:
    return public_origin().startswith("https://")


def site_cookie_name() -> str:
    # __Host- 접두어: Secure + Path=/ + Domain 미지정을 브라우저가 강제함(하위 도메인의 덮어쓰기 불가). https 에서만 사용 가능
    return "__Host-jw_rbi" if _secure() else "jw_rbi"


def state_cookie_name() -> str:
    return "__Host-jw_rbi_state" if _secure() else "jw_rbi_state"


def session_ttl() -> int:
    return max(1, int(get_settings().rbi_site_session_hours)) * 3600


def _signer(kind: str) -> URLSafeTimedSerializer:
    # 워크스페이스 세션 서명(app.auth.deps.signer)과 salt 가 상이함. 이 쿠키를 워크스페이스 세션으로 제출하면 서명 검증 단계에서 실패
    return URLSafeTimedSerializer(get_settings().secret_key, salt=f"jw.rbi.{kind}.v1")


# ── 복귀 경로(open redirect 방지) ──

def safe_return(value: str | None) -> str:
    """복귀 경로를 rbi 출처 내 경로로 제한한다. 절대 URL 은 출처가 RBI_PUBLIC_ORIGIN 과 동일할 때만 경로로 변환한다. 그 외는 "/"."""
    v = (value or "").strip()
    if not v or len(v) > 1024:
        return "/"
    if any(ord(c) < 0x20 or ord(c) == 0x7F or c == "\\" for c in v):
        return "/"
    if "://" in v.split("?", 1)[0]:
        u = urlsplit(v)
        origin = public_origin()
        if not origin or f"{u.scheme}://{u.netloc}".lower() != origin:
            return "/"
        v = urlunsplit(("", "", u.path or "/", u.query, ""))
    if not v.startswith("/") or v.startswith("//"):
        return "/"
    # 인증 경로로 복귀하면 리디렉트 루프 발생
    if v.split("?", 1)[0].startswith("/auth/"):
        return "/"
    return v


# ── 일회용 저장소(Redis) ──

async def _redis():
    from app.chat.redis_client import get_redis
    return await get_redis()


async def issue_code(payload: dict) -> str:
    """일회용 코드(CODE_TTL 초). 조회와 동시에 삭제된다(take_once)."""
    from app.rbi.service import put_once
    code = secrets.token_urlsafe(32)
    await put_once(CODE_PREFIX + code, payload, CODE_TTL)
    return code


async def redeem_code(code: str) -> dict | None:
    from app.rbi.service import take_once
    if not code or not _CODE_RE.match(code):
        return None
    return await take_once(CODE_PREFIX + code)


async def _site_put(rsid: str, rec: dict) -> None:
    r = await _redis()
    await r.set(SITE_PREFIX + rsid, json.dumps(rec), ex=session_ttl(), nx=True)


async def _site_get(rsid: str) -> dict | None:
    r = await _redis()
    raw = await r.get(SITE_PREFIX + rsid)
    if not raw:
        return None
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else None
    except (TypeError, json.JSONDecodeError):
        return None


async def _site_del(rsid: str) -> None:
    try:
        r = await _redis()
        await r.delete(SITE_PREFIX + rsid)
    except Exception as e:  # noqa: BLE001
        logger.warning("[rbi.site] logout delete failed: %s", e)


# ── 워크스페이스 세션(홉 2단계·에포크) ──

async def _workspace_session_alive(wsid: str | None) -> bool:
    """워크스페이스 세션(sid)의 유효 여부 — 로그아웃·기기 취소 시 False. Redis 장애 시 워크스페이스와 동일하게 통과 처리(fail-open)."""
    if not wsid:
        return False
    try:
        return await sess_mod.get_session(wsid) is not None
    except Exception:  # noqa: BLE001
        return True


async def workspace_user(request: Request, db: AsyncSession) -> tuple[User, str] | None:
    """워크스페이스 출처 요청의 세션 쿠키 → (user, sid). 쿠키가 없거나 무효이면 None(2단계 인증 등록이 필요한 사용자도 None)."""
    tok = request.cookies.get(SESSION_COOKIE)
    data = unsign_value(tok) if tok else None
    if not data or "user_id" not in data:
        return None
    try:
        user, sid, _rec, pol = await verify_session_data(db, data)
    except SessionInvalid:
        return None
    from app.auth import security_policy
    if security_policy.totp_setup_required(pol, user):
        return None
    return user, sid


# ── rbi 세션 ──

async def site_user(request: Request, db: AsyncSession) -> User | None:
    """rbi 출처의 세션 쿠키 → 사용자. 서명·Redis 레코드·사용자 활성 여부·token_version·워크스페이스 세션 유효 여부를 모두 검증한다."""
    tok = request.cookies.get(site_cookie_name())
    if not tok or len(tok) > 512:
        return None
    try:
        data = _signer("site").loads(tok, max_age=session_ttl())
    except BadSignature:
        return None
    if not isinstance(data, dict) or not data.get("rsid") or not data.get("uid"):
        return None
    try:
        rec = await _site_get(data["rsid"])
    except Exception as e:  # noqa: BLE001 — rbi 세션 저장소 접근 불가 시 거부(fail-closed)
        logger.warning("[rbi.site] session lookup failed (deny): %s", e)
        return None
    if not rec or rec.get("uid") != data["uid"]:
        return None
    user = await db.get(User, data["uid"])
    if not user or not user.is_active or rec.get("tv") != user.token_version:
        await _site_del(data["rsid"])
        return None
    if not await _workspace_session_alive(rec.get("wsid")):
        # 워크스페이스 로그아웃(또는 해당 기기 세션 취소) 시 rbi 세션도 종료
        await _site_del(data["rsid"])
        return None
    return user


def _check_origin(request: Request) -> None:
    """rbi 출처의 상태 변경 요청은 Origin 이 rbi 출처여야 한다 — 동일 사이트(하위 도메인)에서 발생하는 CSRF 는 SameSite 로 차단되지 않는다."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    if (request.headers.get("origin") or "").lower() != public_origin():
        raise HTTPException(status_code=403, detail="출처가 맞지 않습니다")


async def get_rbi_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    """격리 브라우저 사용자 API 의 인증.

    rbi 출처: rbi 세션 쿠키만 사용(워크스페이스 세션 쿠키·Bearer 는 확인하지 않음) + 상태 변경 요청은 Origin 검사.
    워크스페이스 출처: 기존 워크스페이스 인증(런처가 대상 목록을 조회).
    """
    if is_rbi_host(request):
        _check_origin(request)
        user = await site_user(request, db)
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return user
    return await get_current_user(request, request.cookies.get(SESSION_COOKIE), db)


# ── 라우터 ──

router = APIRouter(tags=["rbi"])


def _no_store(resp):
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


def _set_cookie(resp, name: str, value: str, max_age: int, samesite: str) -> None:
    resp.set_cookie(name, value, max_age=max_age, path="/", httponly=True, secure=_secure(), samesite=samesite)


def _clear_cookie(resp, name: str) -> None:
    resp.delete_cookie(name, path="/", secure=_secure(), httponly=True, samesite="lax")


def _require_rbi_host(request: Request) -> None:
    if not public_origin() or not is_rbi_host(request):
        raise HTTPException(status_code=404)


def _client_ip(request: Request) -> str:
    return sess_mod.client_ip(request)


async def _module_on(db: AsyncSession) -> bool:
    """모듈 활성화 여부 — require_module 과 동일하게 DB 를 기준으로 한다(워커 8개의 메모리 값 불일치 방지)."""
    from sqlalchemy import select
    from app.db.models import SystemSetting
    from app.modules import registry
    enabled = registry.is_module_enabled("rbi")
    try:
        v = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == registry._module_key("rbi")))
        if v is not None:
            enabled = bool(json.loads(v))
    except Exception:  # noqa: BLE001
        pass
    return enabled


@router.get("/api/rbi/site/login")
async def site_login(request: Request, db: AsyncSession = Depends(get_db)):
    """[rbi 출처, nginx /auth/login] 홉 시작 — state 쿠키를 설정하고 워크스페이스 /rbi-login 으로 리디렉트한다."""
    _require_rbi_host(request)
    ret = safe_return(request.query_params.get("return"))
    if await site_user(request, db):
        return _no_store(RedirectResponse(ret, status_code=302))
    state = secrets.token_urlsafe(24)
    q = urlencode({"state": state, "return": ret})
    resp = RedirectResponse(f"{workspace_origin()}/rbi-login?{q}", status_code=302)
    _set_cookie(resp, state_cookie_name(), _signer("state").dumps({"s": state, "r": ret}), STATE_TTL, "lax")
    return _no_store(resp)


@router.get("/api/rbi/site/sso")
async def site_sso(request: Request, db: AsyncSession = Depends(get_db)):
    """[워크스페이스 출처, nginx /rbi-login] 로그인 확인 → 일회용 코드 → rbi 출처 /auth/callback.

    목적지는 RBI_PUBLIC_ORIGIN(설정값)으로 고정되며 쿼리로 변경할 수 없다. return 은 rbi 출처 내 경로로 정규화하며, state 쿠키 측 값과 별도로 재검증된다.
    """
    origin = public_origin()
    if not origin or is_rbi_host(request):
        raise HTTPException(status_code=404)
    ret = safe_return(request.query_params.get("return"))
    state = request.query_params.get("state") or ""
    if not _STATE_RE.match(state):
        # state 없이 진입한 경우(북마크·런처). rbi 출처에서 정식 절차로 시작하도록 리디렉트
        return _no_store(RedirectResponse(f"{origin}/auth/login?{urlencode({'return': ret})}", status_code=302))
    got = await workspace_user(request, db)
    if not got:
        back = f"/rbi-login?{urlencode({'state': state, 'return': ret})}"
        return _no_store(RedirectResponse(f"/login?redirect={quote(back, safe='')}", status_code=302))
    user, wsid = got
    if not await _module_on(db):
        return _no_store(PlainTextResponse("격리 브라우저 기능이 꺼져 있습니다", status_code=403))
    code = await issue_code({"uid": user.id, "wsid": wsid, "tv": user.token_version, "state": state, "iat": int(time.time())})
    q = urlencode({"code": code, "state": state})
    return _no_store(RedirectResponse(f"{origin}/auth/callback?{q}", status_code=302))


def _sso_fail(reason: str):
    """홉 실패 — 앱 첫 화면에 사유를 표시하고(자동 재시도 루프 없음) state 쿠키를 삭제한다."""
    resp = RedirectResponse(f"/?{urlencode({'sso_error': reason})}", status_code=302)
    _clear_cookie(resp, state_cookie_name())
    return _no_store(resp)


@router.get("/api/rbi/site/callback")
async def site_callback(request: Request, db: AsyncSession = Depends(get_db)):
    """[rbi 출처, nginx /auth/callback] 코드 → rbi 세션. state 3중 일치 · 코드 1회 한정 · 워크스페이스 세션 유효."""
    _require_rbi_host(request)
    code = request.query_params.get("code") or ""
    state = request.query_params.get("state") or ""
    raw = request.cookies.get(state_cookie_name())
    try:
        st = _signer("state").loads(raw, max_age=STATE_TTL) if raw else None
    except BadSignature:
        st = None
    if not isinstance(st, dict) or not st.get("s") or not _STATE_RE.match(state) \
            or not hmac.compare_digest(str(st["s"]), state):
        # 해당 브라우저가 시작한 홉이 아님(로그인 CSRF·쿠키 만료). 코드는 소비하지 않음
        return _sso_fail("state")
    rec = await redeem_code(code)
    if not rec or not hmac.compare_digest(str(rec.get("state", "")), state):
        return _sso_fail("code")
    user = await db.get(User, rec.get("uid"))
    if not user or not user.is_active or rec.get("tv") != user.token_version \
            or not await _workspace_session_alive(rec.get("wsid")):
        return _sso_fail("user")
    rsid = secrets.token_urlsafe(24)
    ip = _client_ip(request)
    try:
        await _site_put(rsid, {"uid": user.id, "wsid": rec.get("wsid"), "tv": user.token_version,
                               "created": int(time.time()), "ip": ip})
    except Exception as e:  # noqa: BLE001
        logger.error("[rbi.site] session store failed: %s", e)
        return _sso_fail("store")
    resp = RedirectResponse(safe_return(st.get("r")), status_code=302)
    # Strict: 세션 쿠키는 rbi 페이지 자체가 발생시키는 요청에만 포함됨(타 사이트 링크로 진입한 첫 문서 요청에는 미포함 — 문서는 정적이므로 불필요)
    _set_cookie(resp, site_cookie_name(), _signer("site").dumps({"rsid": rsid, "uid": user.id}), session_ttl(), "strict")
    _clear_cookie(resp, state_cookie_name())
    from app.admin import audit
    await audit.log_action(db, user.id, "rbi.site.login", "user", user.id, {"origin": public_origin()}, ip)
    return _no_store(resp)


@router.get("/api/rbi/site/me")
async def site_me(request: Request, db: AsyncSession = Depends(get_db)):
    """[rbi 출처] 현재 rbi 세션의 사용자. 없으면 401 — 앱이 /auth/login 으로 홉을 시작한다."""
    _require_rbi_host(request)
    user = await site_user(request, db)
    if not user:
        raise HTTPException(status_code=401)
    return _no_store(JSONResponse({
        "user": {"id": user.id, "username": user.username, "display_name": user.display_name or user.username,
                 "is_admin": bool(user.is_admin)},
        "workspace_url": workspace_origin(),
    }))


@router.post("/api/rbi/site/logout")
async def site_logout(request: Request):
    """[rbi 출처] rbi 세션만 종료한다(워크스페이스 로그인은 유지). 격리 세션 컨테이너는 종료하지 않는다 — 앱이 사전에 종료한다."""
    _require_rbi_host(request)
    _check_origin(request)
    tok = request.cookies.get(site_cookie_name())
    if tok:
        try:
            data = _signer("site").loads(tok, max_age=session_ttl())
            if isinstance(data, dict) and data.get("rsid"):
                await _site_del(data["rsid"])
        except BadSignature:
            pass
    resp = JSONResponse({"ok": True})
    _clear_cookie(resp, site_cookie_name())
    return _no_store(resp)


# ── rbi 출처 경로 제한(ASGI) ──

class RbiHostGuard:
    """Host 가 rbi 출처이면 /api/rbi/* · /api/internal/rbi/auth 외의 경로는 404 — 워크스페이스 API 가 이 출처로 노출되지 않도록 차단한다(ws-nginx 와 이중 적용)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            host = ""
            for k, v in scope.get("headers") or []:
                if k == b"host":
                    host = v.decode("latin-1")
                    break
            if is_rbi_host_header(host):
                path = scope.get("path") or ""
                if not (path.startswith(RBI_HOST_PATHS) or path in RBI_HOST_EXACT):
                    if scope["type"] == "websocket":
                        await send({"type": "websocket.close", "code": 1008})
                        return
                    await send({"type": "http.response.start", "status": 404,
                                "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
                    await send({"type": "http.response.body", "body": b'{"detail":"Not Found"}'})
                    return
        await self.app(scope, receive, send)
