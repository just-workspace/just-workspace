"""격리 브라우저 전용 출처(RBI_PUBLIC_ORIGIN, 예 https://rbi.example.com) — 자체 세션 쿠키 · 워크스페이스 SSO 홉.

왜 따로 떼나
  격리 브라우저 화면(KasmVNC 클라이언트 스크립트 · 미러 문서 · 세션 컨테이너가 내주는 모든 것)이 워크스페이스 출처
  (example.com)에 실리면, 세션 컨테이너가 뚫렸을 때 그 출처의 쿠키·API 가 같은 출처 범위 안에 놓인다.
  rbi 출처는 워크스페이스와 **다른 출처**다 — 워크스페이스 세션 쿠키(host-only, example.com)는 여기로 오지 않고,
  여기의 세션 쿠키(__Host-, host-only, rbi.example.com)는 워크스페이스로 가지 않는다.

SSO 홉(OAuth 인가 코드와 같은 모양, 우리 둘 사이에서만)
  1. rbi  GET /auth/login?return=/x        → state 난수를 서명 쿠키(__Host-jw_rbi_state, Lax, 10분)에 두고
                                              302 https://<워크스페이스>/rbi-login?state=…&return=/x
  2. ws   GET /rbi-login?state&return      → 워크스페이스 로그인 확인(없으면 /login?redirect=… 뒤 되돌아옴)
                                              → 일회용 코드(60초, Redis, 사용자·워크스페이스 세션·state 묶음)
                                              → 302 <RBI_PUBLIC_ORIGIN>/auth/callback?code&state   (목적지는 설정값 — 요청이 못 바꾼다)
  3. rbi  GET /auth/callback?code&state    → state 쿠키 == 쿼리 state == 코드의 state, 코드는 GETDEL(한 번만)
                                              → rbi 세션(Redis rbi:site:<rsid>, 8시간) + __Host-jw_rbi(Strict, HttpOnly, Secure, Path=/)
                                              → 302 return(rbi 출처 안 경로만)
  로그아웃(rbi)은 rbi 세션만 지운다. 워크스페이스 로그아웃·강제 로그아웃(token_version)·기기 세션 취소는
  rbi 세션이 매 요청 확인하는 "워크스페이스 세션 에포크"(그 sid 가 아직 있나 + tv 가 같나)로 따라 끊긴다.

rbi 출처의 요청은 RbiHostGuard 가 /api/rbi/* 와 nginx 내부 인증(/api/internal/rbi/auth) 말고는 404 로 끊는다(ws-nginx 도 같은 목록만 연다).
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

#: 일회용 코드 수명(초) — 리디렉트 두 번이면 끝나는 거리
CODE_TTL = 60
#: 홉 전 state 쿠키 수명(초) — 워크스페이스 로그인(2단계 인증 포함)을 거쳐 돌아올 시간
STATE_TTL = 600
CODE_PREFIX = "rbi:sso:"
SITE_PREFIX = "rbi:site:"
_STATE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
#: rbi 출처에서 열어 두는 백엔드 경로(그 밖은 404) — ws-nginx 의 rbi server 블록과 같은 목록
RBI_HOST_PATHS = ("/api/rbi/",)
RBI_HOST_EXACT = ("/api/internal/rbi/auth",)


# ── 설정 ──

def public_origin() -> str:
    """RBI_PUBLIC_ORIGIN 을 "scheme://host[:port]" 로(경로·쿼리 없이, 소문자). 비었거나 잘못이면 ""(기능 꺼짐)."""
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
    # __Host- 접두어: Secure + Path=/ + Domain 없음을 브라우저가 강제한다(하위 도메인이 덮어쓰지 못한다). https 에서만 쓸 수 있다
    return "__Host-jw_rbi" if _secure() else "jw_rbi"


def state_cookie_name() -> str:
    return "__Host-jw_rbi_state" if _secure() else "jw_rbi_state"


def session_ttl() -> int:
    return max(1, int(get_settings().rbi_site_session_hours)) * 3600


def _signer(kind: str) -> URLSafeTimedSerializer:
    # 워크스페이스 세션 서명(app.auth.deps.signer)과 salt 가 다르다 — 이 쿠키를 워크스페이스 세션으로 내밀면 서명부터 틀린다
    return URLSafeTimedSerializer(get_settings().secret_key, salt=f"jw.rbi.{kind}.v1")


# ── 돌아갈 곳(열린 리디렉트 방지) ──

def safe_return(value: str | None) -> str:
    """돌아갈 곳 → rbi 출처 안의 경로만. 절대 URL 은 출처가 RBI_PUBLIC_ORIGIN 과 같을 때만 경로로 바꾼다. 그 밖은 "/"."""
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
    # 인증 경로로 되돌아가면 고리가 된다
    if v.split("?", 1)[0].startswith("/auth/"):
        return "/"
    return v


# ── 일회용 저장소(Redis) ──

async def _redis():
    from app.chat.redis_client import get_redis
    return await get_redis()


async def issue_code(payload: dict) -> str:
    """일회용 코드(CODE_TTL 초). 꺼내는 순간 사라진다(take_once)."""
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
    """워크스페이스 세션(sid)이 아직 살아 있나 — 로그아웃·기기 취소면 False. Redis 장애는 워크스페이스와 같게 통과(fail-open)."""
    if not wsid:
        return False
    try:
        return await sess_mod.get_session(wsid) is not None
    except Exception:  # noqa: BLE001
        return True


async def workspace_user(request: Request, db: AsyncSession) -> tuple[User, str] | None:
    """워크스페이스 출처 요청의 세션 쿠키 → (user, sid). 없거나 무효면 None(2단계 인증 등록이 필요한 사용자도 None)."""
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
    """rbi 출처의 세션 쿠키 → 사용자. 서명·Redis 레코드·사용자 활성·token_version·워크스페이스 세션 생존을 모두 본다."""
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
    except Exception as e:  # noqa: BLE001 — rbi 세션 저장소가 없으면 닫는다(fail-closed)
        logger.warning("[rbi.site] session lookup failed (deny): %s", e)
        return None
    if not rec or rec.get("uid") != data["uid"]:
        return None
    user = await db.get(User, data["uid"])
    if not user or not user.is_active or rec.get("tv") != user.token_version:
        await _site_del(data["rsid"])
        return None
    if not await _workspace_session_alive(rec.get("wsid")):
        # 워크스페이스에서 로그아웃(또는 이 기기 세션 취소) — rbi 세션도 끝
        await _site_del(data["rsid"])
        return None
    return user


def _check_origin(request: Request) -> None:
    """rbi 출처의 상태 바꾸는 요청은 Origin 이 rbi 출처여야 한다 — 같은 사이트(하위 도메인)에서 오는 CSRF 는 SameSite 로 못 막는다."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    if (request.headers.get("origin") or "").lower() != public_origin():
        raise HTTPException(status_code=403, detail="출처가 맞지 않습니다")


async def get_rbi_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    """격리 브라우저 사용자 API 의 인증.

    rbi 출처: rbi 세션 쿠키만(워크스페이스 세션 쿠키·Bearer 는 보지 않는다) + 상태 바꾸는 요청은 Origin 검사.
    워크스페이스 출처: 기존 워크스페이스 인증(런처가 대상 목록을 읽는다).
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
    """모듈 켜짐 — require_module 과 같게 DB 가 권위(워커 8개 메모리 값 어긋남 방지)."""
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
    """[rbi 출처, nginx /auth/login] 홉 시작 — state 쿠키를 심고 워크스페이스 /rbi-login 으로."""
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

    목적지는 RBI_PUBLIC_ORIGIN(설정값) 고정 — 쿼리로 못 바꾼다. return 은 rbi 출처 안 경로로만 다듬어 state 쿠키 쪽 값과 별도로 다시 검사된다.
    """
    origin = public_origin()
    if not origin or is_rbi_host(request):
        raise HTTPException(status_code=404)
    ret = safe_return(request.query_params.get("return"))
    state = request.query_params.get("state") or ""
    if not _STATE_RE.match(state):
        # state 없이 들어왔다(북마크·런처) — rbi 출처에서 정식으로 시작하게 돌려보낸다
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
    """홉 실패 — 앱 첫 화면에 사유를 보이고(자동 재시도 고리 없음) state 쿠키는 지운다."""
    resp = RedirectResponse(f"/?{urlencode({'sso_error': reason})}", status_code=302)
    _clear_cookie(resp, state_cookie_name())
    return _no_store(resp)


@router.get("/api/rbi/site/callback")
async def site_callback(request: Request, db: AsyncSession = Depends(get_db)):
    """[rbi 출처, nginx /auth/callback] 코드 → rbi 세션. state 3중 일치 · 코드 한 번만 · 워크스페이스 세션 생존."""
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
        # 이 브라우저가 시작한 홉이 아니다(로그인 CSRF·쿠키 만료) — 코드는 건드리지 않는다
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
    # Strict: 세션 쿠키는 rbi 페이지 자신이 부르는 요청에만 붙는다(다른 사이트 링크로 온 첫 문서 요청에는 안 붙는다 — 문서는 정적이라 필요 없다)
    _set_cookie(resp, site_cookie_name(), _signer("site").dumps({"rsid": rsid, "uid": user.id}), session_ttl(), "strict")
    _clear_cookie(resp, state_cookie_name())
    from app.admin import audit
    await audit.log_action(db, user.id, "rbi.site.login", "user", user.id, {"origin": public_origin()}, ip)
    return _no_store(resp)


@router.get("/api/rbi/site/me")
async def site_me(request: Request, db: AsyncSession = Depends(get_db)):
    """[rbi 출처] 지금 rbi 세션의 사용자. 없으면 401 — 앱이 /auth/login 으로 홉을 시작한다."""
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
    """[rbi 출처] rbi 세션만 끝낸다(워크스페이스 로그인은 그대로). 격리 세션 컨테이너는 끝내지 않는다 — 앱이 먼저 끝낸다."""
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
    """Host 가 rbi 출처면 /api/rbi/* · /api/internal/rbi/auth 밖은 404 — 워크스페이스 API 가 이 출처로 새지 않게(ws-nginx 와 이중)."""

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
