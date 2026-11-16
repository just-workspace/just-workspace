"""Authentication dependencies."""

import time as _time

from fastapi import Cookie, Depends, HTTPException, Request, status
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import sessions as sess_mod
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db

settings = get_settings()
signer = URLSafeTimedSerializer(settings.secret_key)

SESSION_COOKIE = "ws_session"
PKCE_COOKIE = "ws_pkce"
SESSION_MAX_AGE_DEFAULT = 3600 * 8    # 8 hours
SESSION_MAX_AGE_REMEMBER = 86400 * 30  # 30 days
# 서명 검증 상한. 실제 수명은 쿠키 max-age 와 Redis 세션 TTL(관리자 설정)로 결정된다. 이전에는 30일
# 고정이어서, 관리 › 보안에서 "로그인 기억 기간"을 60·90일로 연장해도 31일째에 서명 만료로 로그아웃되었다.
# 설정의 허용 최댓값(365일)에 맞춘다.
SESSION_MAX_AGE = 86400 * 365

# ── Dynamic session durations (DB-backed, cached) ──────────
_session_cache: dict[str, tuple[float, int]] = {}
_SESSION_CACHE_TTL = 300  # 5 minutes


async def get_session_max_age_default(db: AsyncSession) -> int:
    """Return session max_age in seconds from DB (cached 5 min)."""
    entry = _session_cache.get("default")
    if entry and _time.monotonic() - entry[0] < _SESSION_CACHE_TTL:
        return entry[1]
    from app.admin.settings import get_setting
    val = await get_setting(db, "auth.session_hours")
    hours = int(val) if val else 8
    result = hours * 3600
    _session_cache["default"] = (_time.monotonic(), result)
    return result


async def get_session_max_age_remember(db: AsyncSession) -> int:
    """Return remember-me max_age in seconds from DB (cached 5 min)."""
    entry = _session_cache.get("remember")
    if entry and _time.monotonic() - entry[0] < _SESSION_CACHE_TTL:
        return entry[1]
    from app.admin.settings import get_setting
    val = await get_setting(db, "auth.session_remember_days")
    days = int(val) if val else 30
    result = days * 86400
    _session_cache["remember"] = (_time.monotonic(), result)
    return result


def sign_value(data: dict) -> str:
    return signer.dumps(data)


def unsign_value(token: str, max_age: int = SESSION_MAX_AGE) -> dict | None:
    try:
        return signer.loads(token, max_age=max_age)
    except BadSignature:
        return None


async def _user_from_first_party_oauth(db: AsyncSession, token: str) -> User | None:
    """OAuth 액세스 토큰을 일반 API 인증으로 허용할지 판정한다.

    데스크톱 앱(RFC 8252 네이티브 클라이언트)은 세션 쿠키를 사용하지 않는다. 따라서
    ``/api/devices`` 등 일반 API 요청도 Bearer 로 수신된다. 단, **임의의 OAuth 토큰**을
    허용해서는 안 된다 — 다음 세 조건을 모두 충족하는 경우에만 통과시킨다.

      1. ``type == "workspace_oauth"``  — 본 프로젝트가 발급한 액세스 토큰인지 여부.
      2. ``aud`` 가 없다               — resource 바인딩된 MCP 토큰은 MCP 엔드포인트
                                         전용이다. 일반 API 용으로 승격하지 않는다.
      3. ``client_id`` 가 정적·trusted  — OAUTH_CLIENTS_JSON 에 ``trusted: true`` 로
                                         지정된 1st-party 만 해당. DCR(RFC 7591) 로 누구나
                                         등록할 수 있는 동적 클라이언트는 영구 제외이며,
                                         Gitea SSO 등 비-trusted 정적 클라이언트도 제외.

    실패는 모두 ``None`` 을 반환한다 — 호출자가 401 로 변환한다.
    """
    # 순환 임포트 방지: oauth_provider 가 본 모듈을 임포트한다.
    from app.auth import oauth_provider as oauth

    try:
        payload = await oauth.verify_access_token(
            db, token, options={"verify_aud": False}
        )
    except Exception:
        return None

    if payload.get("type") != "workspace_oauth":
        return None
    if payload.get("aud"):
        return None

    client_id = payload.get("client_id")
    if not client_id:
        return None
    cfg = await oauth._lookup_client(db, client_id)
    if not cfg or not oauth._client_is_trusted(cfg):
        return None

    user = await db.get(User, payload.get("sub"))
    if not user or not user.is_active:
        return None
    # 발급 후 token_version 이 증가했으면(비밀번호 변경·강제 로그아웃·정지) 거부 — 웹 세션과 동일한 규칙.
    # tv 클레임이 없는 구 토큰은 허용한다(만료까지 최대 1시간, 리프레시는 동일 시점에 폐기된다).
    if "tv" in payload and payload.get("tv") != (user.token_version or 0):
        return None
    return user


async def get_current_user(
    request: Request,
    ws_session: str | None = Cookie(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    # 토큰 출처: 쿠키(웹/SSR, same-origin) 또는 Authorization: Bearer(번들 SPA 앱, cross-origin).
    # 둘 다 동일한 서명 세션값(sign_value)이라 검증 로직 공유.
    token = ws_session
    if not token:
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    data = unsign_value(token)
    if not data or "user_id" not in data:
        # 서명 세션값이 아님 → 1st-party OAuth 액세스 토큰 여부를 확인한다.
        # 데스크톱 앱은 쿠키 없이 OAuth 로만 인증한다.
        user = await _user_from_first_party_oauth(db, token)
        if user is not None:
            return user
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    try:
        user, sid, rec, pol = await verify_session_data(db, data)
    except SessionInvalid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    from app.auth import security_policy
    if security_policy.totp_setup_required(pol, user) and security_policy.path_blocked(request.url.path):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="2단계 인증을 먼저 설정하세요 (설정 › 보안)",
            headers={"X-Totp-Setup-Required": "1"},
        )

    # 화면이 자동 수행하는 폴링(메일 안 읽음·알림 보정, X-Background: 1)은 "활동"으로 집계하지 않는다.
    # 이를 포함하여 last_seen 을 갱신하면 탭이 열려 있는 것만으로 5분마다 갱신되어 유휴 로그아웃이 적용되지 않는다.
    if rec != "__failopen__" and request.headers.get("x-background") != "1":
        await sess_mod.touch_session(sid, rec, sess_mod.client_ip(request))

    return user


class SessionInvalid(Exception):
    """서명은 유효하나 세션으로 허용할 수 없다(폐기·만료·임시 토큰 등)."""


async def verify_session_data(db: AsyncSession, data: dict):
    """서명 검증을 통과한 세션값 → (user, sid, rec, policy). REST·WebSocket 공용.

    - 목적 토큰(2단계 인증 임시 토큰 등, purpose 있음)은 세션으로 취급하지 않는다
    - token_version 불일치(강제 로그아웃·비밀번호 변경) 거부
    - sid 레지스트리에서 취소·만료된 세션 거부(Redis 장애 시 tv 검사만으로 통과)
    - 유휴 로그아웃 정책
    """
    if not isinstance(data, dict) or not data.get("user_id") or data.get("purpose"):
        raise SessionInvalid()
    user = await db.get(User, data["user_id"])
    if not user or not user.is_active:
        raise SessionInvalid()

    # 세션 무효화 검사 — 쿠키의 tv가 현재 user.token_version과 다르면 거부.
    # (전체/개별 강제 로그아웃 시 token_version을 +1 → 기존 쿠키 전부 무효, 8워커 즉시 반영)
    if data.get("tv") != user.token_version:
        raise SessionInvalid()

    # per-device 세션 레지스트리 검사 — sid가 취소/만료됐으면 거부.
    # Redis 장애 시에는 fail-open(tv 검사만으로 통과)하여 전체 인증 다운 방지.
    sid = data.get("sid")
    if not sid:
        raise SessionInvalid()
    try:
        rec = await sess_mod.get_session(sid)
    except Exception:
        rec = "__failopen__"
    if rec is None:
        raise SessionInvalid()

    # 로그인 보호 정책(관리 › 보안·SSL) — 유휴 로그아웃
    from app.auth import security_policy
    pol = await security_policy.get_policy_cached()
    if rec != "__failopen__" and security_policy.idle_expired(pol, rec):
        await sess_mod.revoke_session(sid)
        raise SessionInvalid()
    return user, sid, rec, pol


async def user_from_ws_token(db: AsyncSession, token: str | None) -> User | None:
    """WebSocket 핸드셰이크 인증 — REST(get_current_user)와 동일한 세션 검증.

    서명 세션값이면 verify_session_data 를 동일하게 적용하고, 2단계 인증 필수 정책 대상이면서
    미등록 상태인 사용자는 거부한다(REST 에서 인증 API 외 경로가 차단되는 것과 동일).
    서명 세션값이 아니면 1st-party OAuth 액세스 토큰(데스크톱 앱)만 허용한다.
    """
    if not token:
        return None
    data = unsign_value(token)
    if data and "user_id" in data:
        try:
            user, sid, rec, pol = await verify_session_data(db, data)
        except SessionInvalid:
            return None
        from app.auth import security_policy
        if security_policy.totp_setup_required(pol, user):
            return None
        return user
    return await _user_from_first_party_oauth(db, token)
