"""Portal OIDC provider — exposes authorize/token/userinfo for Gitea etc."""

import base64
import binascii
import hashlib
import hmac
import json
import logging
import secrets
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from itsdangerous import BadSignature
import jwt
from jwt import PyJWTError as JWTError   # 기존 python-jose 의 JWTError 대체
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from urllib.parse import urlencode, quote, urlparse

from app.config import get_settings
from app.rate_limit import limiter
from app.db.models import OAuthConsent, OAuthDynamicClient, User
from app.db.session import get_db
from app.auth import backchannel
from app.auth import jwks as jwks_mod
from app.auth import sessions as sess_mod
from app.auth.deps import SESSION_COOKIE, signer, unsign_value
from app.auth.oauth_store import (
    CODE_TTL,
    REFRESH_TOKEN_TTL,
    AuthorizationCode,
    RefreshReuseError,
    consume_code_async,
    hash_client_secret,
    issue_refresh_token,
    rotate_refresh_token,
    store_code_async,
)

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/oauth", tags=["oauth-provider"])
# Root-level discovery routes (no prefix) — RFC 8414 / RFC 9728 require issuer
# to be the app root, so these are registered separately in main.py.
root_router = APIRouter(tags=["oauth-discovery"])

# 서명 알고리즘.
#   OIDC Discovery 1.0 은 id_token_signing_alg_values_supported 에 RS256 을
#   MUST 로 규정한다. 대칭키(HS256)로는 표준 RP 가 서명을 검증할 수 없다.
#   서명·검증 모두 RS256(app/auth/jwks.py 의 키)만 사용한다.
JWT_ALGORITHM = "RS256"
ACCESS_TOKEN_TTL = 3600  # 1 hour

# Scopes the provider advertises / recognises.
SUPPORTED_SCOPES = ["openid", "profile", "email", "groups", "mcp:read", "mcp:write"]
MCP_SCOPES = {"mcp:read", "mcp:write"}

# ID 토큰·UserInfo 가 반환할 수 있는 클레임(OIDC Discovery claims_supported).
CLAIMS_SUPPORTED = [
    "iss", "sub", "aud", "exp", "iat", "nonce", "sid",
    "preferred_username", "name", "email", "groups",
]

# 하위 호환용 관리자 표식. 기존부터 groups 는 ["admin"] 또는 [] 였으며, 기존 RP 가 이 값으로
# 관리자를 판별할 수 있다. 따라서 워크스페이스 그룹 중 이름이 이 값과 동일한 것은 반환하지
# 않는다. 비관리자가 "admin" 이라는 이름의 그룹에 속한 것만으로 관리자 표식이 생성되어서는 안 된다.
ADMIN_GROUP_MARKER = "admin"


def _mcp_resource(sub: str = "") -> str:
    """Canonical MCP resource URL. Must match the connector URL char-for-char
    (no trailing slash) — used both in metadata and as token ``aud``."""
    base = (settings.mcp_public_url or settings.app_url).rstrip("/")
    return f"{base}/api/mcp/{sub}" if sub else f"{base}/api/mcp"


def _authorization_server_metadata() -> dict:
    """Shared payload for all three discovery routes (root + legacy delegate)."""
    base = settings.app_url
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "userinfo_endpoint": f"{base}/oauth/userinfo",
        "revocation_endpoint": f"{base}/oauth/revoke",
        # RFC 7591 Dynamic Client Registration — claude.ai auto-registers here so
        # the user needs no manual Client ID/Secret (login-only UX).
        "registration_endpoint": f"{base}/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "subject_types_supported": ["public"],
        # OIDC Discovery 1.0: jwks_uri 는 REQUIRED, RS256 은 MUST.
        "jwks_uri": f"{base}/oauth/jwks.json",
        "id_token_signing_alg_values_supported": [JWT_ALGORITHM],
        "scopes_supported": SUPPORTED_SCOPES,
        "claims_supported": CLAIMS_SUPPORTED,
        "code_challenge_methods_supported": ["S256"],
        # OIDC Core §3.1.2.1 — 실제로 처리하는 값만 광고한다.
        "prompt_values_supported": ["none", "consent"],
        # RFC 9207 — authorization response 에 iss 를 포함한다.
        "authorization_response_iss_parameter_supported": True,
        # OpenID Connect Back-Channel Logout 1.0 §2.1 — 워크스페이스 세션 종료 시
        # 정적 클라이언트의 backchannel_logout_uri 로 logout_token 을 송신한다. sid 를 함께
        # 포함하므로 session_supported 도 참이다(ID 토큰에도 동일한 sid 를 포함한다).
        "backchannel_logout_supported": True,
        "backchannel_logout_session_supported": True,
        "token_endpoint_auth_methods_supported": [
            "client_secret_post",
            "client_secret_basic",
        ],
    }


# RFC 6749 §5.1 — 토큰 엔드포인트 응답에는 no-store 가 REQUIRED 이다.
# 누락 시 중간 프록시나 브라우저가 액세스/리프레시 토큰을 캐시할 수 있다.
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def _token_response(content: dict, status: int = 200) -> JSONResponse:
    """토큰 엔드포인트 전용 응답 — 항상 no-store 를 포함한다."""
    return JSONResponse(status_code=status, content=content, headers=NO_STORE)


def _oauth_error(error: str, description: str, status: int = 400) -> JSONResponse:
    """RFC 6749 §5.2 token-endpoint error response."""
    return _token_response(
        {"error": error, "error_description": description}, status
    )


# ── Helpers ──────────────────────────────────────────────────


# 코어와 함께 배포하는 1st-party 클라이언트. 사이트별로 .env 에 수동 등록하지 않아도
# 데스크톱 앱(apps/desktop)이 로그인할 수 있어야 한다. 동일 id 가 OAUTH_CLIENTS_JSON 에
# 있으면 해당 설정이 우선한다.
BUILTIN_CLIENTS = {
    "desktop-app": {
        "public": True,
        "trusted": True,
        "client_name": "Just Workspace 데스크톱",
        "scopes": ["openid", "profile", "email"],
        # 루프백: 포트는 앱이 매번 선택한다(RFC 8252 §7.3, _redirect_uri_allowed 가 포트를 무시)
        "redirect_uris": ["http://127.0.0.1/callback"],
    },
}


def _get_clients() -> dict:
    return {**BUILTIN_CLIENTS, **json.loads(settings.oauth_clients_json)}


# Scopes a DCR (RFC 7591) client may ever hold. mcp:write 는 관리자가 AI 쓰기를 허용한 경우로 한정한다
# (app.mcp.access.write_enabled). 쓰기 도구는 토큰 aud 가 /api/mcp/write 일 때만 노출되며,
# high 위험 작업은 승인 대기함을 경유한다. 읽기 커넥터(/api/mcp/read)는 쓰기 스코프가 있어도 읽기 도구만 노출한다.
DCR_ALLOWED_SCOPES = {"mcp:read"}
DCR_WRITE_SCOPES = {"mcp:read", "mcp:write"}


async def _lookup_client(db: AsyncSession, client_id: str) -> dict | None:
    """Resolve a client_id against the static map first, then the dynamic
    (RFC 7591 DCR) table. Returns a normalized cfg dict, or None if unknown.

    Normalized shape (both sources):
      - ``redirect_uris``: list[str] (exact-match whitelist, no wildcards)
      - ``scopes``: list[str] | None  (None = legacy client, unrestricted)
      - ``secret``: plaintext secret (static clients only)
      - ``secret_hash``: SHA-256 hex (dynamic clients only)
      - ``dynamic``: bool
    """
    cfg = _get_clients().get(client_id)
    if cfg is not None:
        return {
            "redirect_uris": cfg.get("redirect_uris", []),
            "scopes": cfg.get("scopes"),
            "secret": cfg.get("secret"),
            "secret_hash": None,
            "dynamic": False,
            # 1st-party 클라이언트만 동의를 생략한다(OAUTH_CLIENTS_JSON 에 명시).
            "trusted": bool(cfg.get("trusted")),
            "client_name": cfg.get("client_name") or client_id,
            # 공개 클라이언트 = 비밀키를 안전하게 보관할 수 없는 네이티브 앱(RFC 8252).
            # PKCE 로만 증명한다.
            "public": bool(cfg.get("public")),
        }

    row = (
        await db.execute(
            select(OAuthDynamicClient).where(
                OAuthDynamicClient.client_id == client_id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    return {
        "redirect_uris": json.loads(row.redirect_uris),
        "scopes": json.loads(row.scopes),
        "secret": None,
        "secret_hash": row.client_secret_hash,
        "dynamic": True,
        # DCR 클라이언트는 누구나 등록할 수 있으므로 절대 신뢰하지 않는다.
        "trusted": False,
        # DCR 은 누구나 등록할 수 있으므로 공개 클라이언트로 승격하지 않는다.
        "public": False,
        "client_name": row.client_name or client_id,
        "logo_uri": row.logo_uri,
        "client_uri": row.client_uri,
        "policy_uri": row.policy_uri,
        "tos_uri": row.tos_uri,
    }


async def _touch_dynamic_client(db: AsyncSession, client_id: str) -> None:
    """Best-effort last_used_at bump for a dynamic client (on token issuance)."""
    await db.execute(
        update(OAuthDynamicClient)
        .where(OAuthDynamicClient.client_id == client_id)
        .values(last_used_at=datetime.now(timezone.utc))
    )
    await db.commit()


async def _sign(db: AsyncSession, payload: dict) -> str:
    """활성 RSA 키로 서명한다. ``kid`` 헤더가 있어야 RP 가 JWKS 에서 키를 선택할 수 있다."""
    key = await jwks_mod.get_active_key(db)
    return jwt.encode(
        payload, key.private_pem, algorithm=key.algorithm,
        headers={"kid": key.kid},
    )


async def _create_access_token(
    db: AsyncSession, user_id: str, scope: str | None = None,
    aud: str | None = None, client_id: str | None = None,
    tv: int | None = None,
) -> str:
    payload = {
        "sub": user_id,
        "iss": settings.app_url,
        "iat": int(time.time()),
        "exp": int(time.time()) + ACCESS_TOKEN_TTL,
        "type": "workspace_oauth",
    }
    # aud/scope are only added for resource-bound (MCP) tokens. Gitea SSO tokens
    # stay aud-less for backward compat; MCP endpoints require aud.
    if aud:
        payload["aud"] = aud
    if scope:
        payload["scope"] = scope
    # RFC 9068 §2.2 — 발급 대상 클라이언트를 기록한다(감사/철회에 필요).
    if client_id:
        payload["client_id"] = client_id
    # 발급 시점의 사용자 token_version. 비밀번호 변경·강제 로그아웃으로 값이 증가하면 해당 토큰을
    # 일반 API 에서 거부한다(app.auth.deps). 클레임이 없는 기존 토큰은 그대로 허용한다. 배포 시점에
    # 기발급된 토큰(데스크톱 앱·MCP 커넥터)이 일괄 무효화되는 것을 방지하기 위함이다.
    if tv is not None:
        payload["tv"] = tv
    return await _sign(db, payload)


async def verify_access_token(db: AsyncSession, token: str, **kw) -> dict:
    """발행한 서명 키(RS256, 교체 중이면 복수)로 검증한다. 일치하는 키가 없으면 JWTError."""
    keys = await jwks_mod.get_all_keys(db)
    last: Exception | None = None
    for k in keys:
        try:
            return jwt.decode(token, k.public_pem, algorithms=[k.algorithm], **kw)
        except JWTError as e:
            last = e
    raise last or JWTError("no usable key")


def _parse_basic_auth(header: str) -> tuple[str, str] | None:
    if not header.startswith("Basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:]).decode()
        client_id, client_secret = decoded.split(":", 1)
        return client_id, client_secret
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None


# ── Consent ──────────────────────────────────────────────────
#
# /oauth/authorize 가 세션만 확인하고 즉시 code 를 발급하면, 공개 DCR(/oauth/register)과
# 결합해 "링크 한 번 클릭 → 무음 인가" 가 성립한다. 공격자가 클라이언트 본인이므로
# PKCE 와 state 모두 방어 수단이 되지 않는다. 따라서 코드 발급 전에 사용자 동의를 받는다.

# 동의 요청 토큰의 서명 salt — 세션 쿠키와 동일한 serializer 를 사용하되 salt 로 용도를
# 분리하여, 한쪽 토큰을 다른 쪽에 사용할 수 없게 한다.
CONSENT_SALT = "oauth-consent-request"
CONSENT_REQUEST_TTL = 600  # 10분

# 사용자가 읽을 수 있는 스코프 설명(동의 화면에 그대로 표시된다).
SCOPE_DESCRIPTIONS = {
    "openid": "로그인 정보(사용자 식별자)",
    "profile": "이름·표시이름",
    "email": "이메일 주소",
    "groups": "소속 그룹 이름",
    "mcp:read": "파일·메일·노트 등 워크스페이스 데이터 읽기",
    "mcp:write": "워크스페이스 데이터 쓰기·수정",
}


def _client_is_trusted(client_cfg: dict) -> bool:
    """동의를 생략할 수 있는 1st-party 클라이언트 여부.

    정적 클라이언트(OAUTH_CLIENTS_JSON)에 ``"trusted": true`` 가 있는 경우에만 참.
    DCR 클라이언트는 누구나 등록할 수 있으므로 **절대** 신뢰하지 않는다.
    """
    return bool(client_cfg.get("trusted")) and not client_cfg.get("dynamic")


async def _has_consent(db: AsyncSession, user_id: str, client_id: str,
                       requested: list[str]) -> bool:
    """요청 스코프가 기존 동의에 모두 포함되는지 여부."""
    row = (
        await db.execute(
            select(OAuthConsent).where(
                OAuthConsent.user_id == user_id,
                OAuthConsent.client_id == client_id,
                OAuthConsent.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return False
    granted = set((row.scopes or "").split())
    return all(s in granted for s in requested)


async def _record_consent(db: AsyncSession, user_id: str, client_id: str,
                          requested: list[str]) -> None:
    """동의를 저장한다. 기존 동의가 있으면 스코프를 합집합으로 확장한다."""
    row = (
        await db.execute(
            select(OAuthConsent).where(
                OAuthConsent.user_id == user_id,
                OAuthConsent.client_id == client_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        db.add(OAuthConsent(user_id=user_id, client_id=client_id,
                            scopes=" ".join(sorted(set(requested)))))
    else:
        merged = set((row.scopes or "").split()) | set(requested)
        row.scopes = " ".join(sorted(merged))
        row.revoked_at = None
        row.granted_at = datetime.now(timezone.utc)
    await db.commit()


def _client_display_name(client_id: str, client_cfg: dict) -> str:
    return client_cfg.get("client_name") or client_id


# ── OIDC / OAuth Discovery ───────────────────────────────────


@router.get("/.well-known/openid-configuration")
async def openid_configuration_legacy():
    """Legacy path — kept as a thin delegate so existing Gitea SSO config that
    points here keeps working."""
    return _authorization_server_metadata()


@root_router.get("/.well-known/oauth-authorization-server")
async def oauth_authorization_server():
    return _authorization_server_metadata()


@root_router.get("/.well-known/openid-configuration")
async def openid_configuration_root():
    return _authorization_server_metadata()


@router.get("/jwks.json")
async def jwks(db: AsyncSession = Depends(get_db)):
    """RFC 7517 JWK Set — 공개키만 반환한다.

    회전된 키도 함께 포함한다. 이전 키로 서명된 토큰이 아직 유효한 상태에서 JWKS 에서
    제거하면 RP 가 검증에 실패한다.
    """
    return await jwks_mod.jwks_document(db)


# ── Protected Resource Metadata (RFC 9728) ───────────────────


def _protected_resource_metadata(resource: str, scopes: list[str]) -> dict:
    return {
        "resource": resource,
        "authorization_servers": [settings.app_url],
        "scopes_supported": scopes,
        "bearer_methods_supported": ["header"],
    }


@root_router.get("/.well-known/oauth-protected-resource")
async def protected_resource_root():
    return _protected_resource_metadata(
        _mcp_resource(), ["mcp:read", "mcp:write"]
    )


@root_router.get("/.well-known/oauth-protected-resource/api/mcp/read")
async def protected_resource_read():
    return _protected_resource_metadata(_mcp_resource("read"), ["mcp:read"])


@root_router.get("/.well-known/oauth-protected-resource/api/mcp/write")
async def protected_resource_write():
    # 쓰기 커넥터는 읽기 도구도 함께 사용한다 → 두 스코프를 모두 광고한다
    return _protected_resource_metadata(_mcp_resource("write"), ["mcp:read", "mcp:write"])


# ── Dynamic Client Registration (RFC 7591) ───────────────────


class ClientRegistrationRequest(BaseModel):
    """RFC 7591 §2 client metadata. Only the fields we honour are declared;
    unknown members are ignored (``extra`` not forbidden)."""

    redirect_uris: list[str]
    client_name: str | None = None
    grant_types: list[str] | None = None
    token_endpoint_auth_method: str | None = None
    scope: str | None = None
    # RFC 7591 §2 가 "동의 화면 표시용"으로 정의한 필드. 수신하지 않으면
    # 사용자는 client_id 문자열만으로 승인 여부를 판단해야 한다.
    logo_uri: str | None = None
    client_uri: str | None = None
    policy_uri: str | None = None
    tos_uri: str | None = None


def _safe_display_uri(uri: str | None) -> str | None:
    """동의 화면에 렌더링할 URI 는 https 만 허용한다.

    logo_uri 는 <img src> 로, 나머지는 <a href> 로 출력된다. javascript:/data: 를
    허용하면 동의 화면 자체가 공격면이 된다. 클라이언트가 등록 시 임의로
    지정하는 값이므로 여기서 차단해야 한다.
    """
    if not uri or not isinstance(uri, str) or len(uri) > 1024:
        return None
    try:
        parsed = urlparse(uri)
    except ValueError:
        return None
    return uri if parsed.scheme == "https" and parsed.netloc else None


_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "[::1]"}


def _redirect_uri_allowed(uri: str, allowed: list[str]) -> bool:
    """등록된 redirect_uri 목록과 대조한다.

    기본은 완전 일치. 루프백만 포트를 무시한다(RFC 8252 §7.3) — 네이티브 앱은
    사용 가능한 임의 포트를 열어 콜백을 수신하기 때문이다. 스킴·호스트·경로는 그대로
    비교하므로 ``http://127.0.0.1:*/callback`` 이외의 주소로는 절대 전달되지 않는다.
    """
    if uri in allowed:
        return True
    try:
        u = urlparse(uri)
    except ValueError:
        return False
    if u.hostname not in _LOOPBACK_HOSTS:
        return False
    for a in allowed:
        try:
            b = urlparse(a)
        except ValueError:
            continue
        if (b.hostname in _LOOPBACK_HOSTS
                and u.scheme == b.scheme
                and (u.path or "/") == (b.path or "/")):
            return True
    return False


def _valid_redirect_uri(uri: str) -> bool:
    """https-only, no wildcards, must have a host (exact-match whitelist entry)."""
    if not isinstance(uri, str) or "*" in uri:
        return False
    try:
        parsed = urlparse(uri)
    except ValueError:
        return False
    return parsed.scheme == "https" and bool(parsed.netloc)


@router.post("/register", status_code=201)
@limiter.limit("10/minute")
async def register_client(
    request: Request,
    body: ClientRegistrationRequest,
    db: AsyncSession = Depends(get_db),
):
    """RFC 7591 Dynamic Client Registration — public, open registration.

    Safeguards: rate-limited (10/min per IP), global cap on dynamic clients,
    https-only exact-match redirect_uris, and scope clamped to ``mcp:read``
    (DCR can NEVER grant mcp:write, §DCR). Secret is returned once, stored hashed.
    """
    # Global cap (abuse safeguard for open registration).
    count = (
        await db.execute(select(func.count()).select_from(OAuthDynamicClient))
    ).scalar_one()
    if count >= settings.oauth_dynamic_clients_max:
        return _oauth_error(
            "invalid_client_metadata",
            "Dynamic client registration limit reached",
            400,
        )

    # redirect_uris — REQUIRED, https-only, no wildcard (RFC 7591 §3.2.2).
    if not body.redirect_uris:
        return _oauth_error(
            "invalid_redirect_uri", "redirect_uris is required", 400
        )
    for uri in body.redirect_uris:
        if not _valid_redirect_uri(uri):
            return _oauth_error(
                "invalid_redirect_uri",
                f"redirect_uri must be https and non-wildcard: {uri}",
                400,
            )

    # Scope — clamp to the DCR allowlist (mcp:read only). Default mcp:read.
    from app.mcp.access import write_enabled

    allowed_scopes = DCR_WRITE_SCOPES if await write_enabled(db) else DCR_ALLOWED_SCOPES
    # scope 를 전송하지 않는 클라이언트(claude.ai 등)는 허용 범위 전부를 등록한다. 실제 토큰 스코프는
    # authorize 시 요청·리소스로 결정되며, 사용자 동의 화면에 쓰기 권한이 표시된다.
    requested = [s for s in (body.scope or " ".join(sorted(allowed_scopes))).split() if s]
    granted = [s for s in requested if s in allowed_scopes]
    if not granted:
        granted = ["mcp:read"]

    grant_types = body.grant_types or ["authorization_code", "refresh_token"]
    auth_method = body.token_endpoint_auth_method or "client_secret_post"

    client_id = "dcr_" + secrets.token_urlsafe(24)
    client_secret = secrets.token_urlsafe(32)
    issued_at = int(time.time())

    row = OAuthDynamicClient(
        client_id=client_id,
        client_secret_hash=hash_client_secret(client_secret),
        redirect_uris=json.dumps(body.redirect_uris),
        scopes=json.dumps(granted),
        client_name=body.client_name,
        grant_types=json.dumps(grant_types),
        token_endpoint_auth_method=auth_method,
        logo_uri=_safe_display_uri(body.logo_uri),
        client_uri=_safe_display_uri(body.client_uri),
        policy_uri=_safe_display_uri(body.policy_uri),
        tos_uri=_safe_display_uri(body.tos_uri),
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    await db.commit()

    logger.info("DCR: registered dynamic client %s (%s)", client_id, body.client_name)

    resp_body = {
        "client_id": client_id,
        "client_secret": client_secret,
        "client_id_issued_at": issued_at,
        "client_secret_expires_at": 0,  # never expires
        "redirect_uris": body.redirect_uris,
        "grant_types": grant_types,
        "token_endpoint_auth_method": auth_method,
        "scope": " ".join(granted),
    }
    if body.client_name:
        resp_body["client_name"] = body.client_name
    return JSONResponse(status_code=201, content=resp_body)


# ── Authorization Endpoint ───────────────────────────────────


@router.get("/authorize")
async def authorize(
    request: Request,
    response_type: str,
    client_id: str,
    redirect_uri: str,
    state: str = "",
    scope: str = "openid",
    nonce: str | None = None,
    code_challenge: str | None = None,
    code_challenge_method: str | None = None,
    resource: str | None = None,
    prompt: str | None = None,
    ws_session: str | None = Cookie(None),
    db: AsyncSession = Depends(get_db),
):
    # Validate client — static map first, then dynamic (DCR) table (§DCR).
    client_cfg = await _lookup_client(db, client_id)
    if not client_cfg:
        raise HTTPException(status_code=400, detail="Unknown client")

    # redirect_uri whitelist — exact match only (no wildcard/prefix, 금지사항 7)
    # 예외: 루프백(127.0.0.1 / [::1])은 **포트를 무시하고** 비교한다.
    # RFC 8252 §7.3 — 네이티브 앱은 임의 포트를 열어 콜백을 수신하므로 포트를 사전에
    # 등록할 수 없다. 포트를 고정하면 해당 포트가 이미 사용 중인 기기에서 로그인이 불가하다.
    # 호스트는 여전히 엄격히 검사하므로 외부로 유출되는 경로는 발생하지 않는다.
    if not _redirect_uri_allowed(redirect_uri, client_cfg.get("redirect_uris", [])):
        raise HTTPException(status_code=400, detail="Invalid redirect_uri")

    # ── 이 지점부터는 client_id 와 redirect_uri 가 검증된 상태이다 ──
    # RFC 6749 §4.1.2.1: 이 시점 이후의 오류는 **redirect_uri 로 error 를 반환해야**
    # 한다. 400 JSON 을 반환하면 사용자에게는 빈 화면이 표시되고 클라이언트는 어떤 통보도
    # 수신하지 못한다. (redirect_uri 자체가 잘못된 경우에만 위와 같이 400 으로 차단한다)
    def _redirect_error(err: str, desc: str = ""):
        params = {"error": err}
        if desc:
            params["error_description"] = desc
        if state:
            params["state"] = state
        # RFC 9207 — 응답을 발급한 AS 를 명시하여 믹스업 공격을 방지한다.
        params["iss"] = settings.app_url
        return RedirectResponse(
            url=f"{redirect_uri}?{urlencode(params)}", status_code=302
        )

    if response_type != "code":
        return _redirect_error(
            "unsupported_response_type", "only 'code' is supported"
        )

    # Per-client scope restriction — reject scopes exceeding the client's
    # allowlist. Absent/empty "scopes" means legacy client (OIDC only) → allow.
    requested_scopes = [s for s in scope.split() if s]
    allowed_scopes = client_cfg.get("scopes")
    if allowed_scopes is not None:
        excess = [s for s in requested_scopes if s not in allowed_scopes]
        if excess:
            return _redirect_error(
                "invalid_scope", f"not allowed for client: {' '.join(excess)}"
            )

    # PKCE: only S256 is accepted; MCP scope requests MUST use PKCE.
    if code_challenge_method is not None and code_challenge_method != "S256":
        return _redirect_error(
            "invalid_request", "only S256 code_challenge_method is supported"
        )
    wants_mcp = any(s in MCP_SCOPES for s in requested_scopes)
    if wants_mcp and not code_challenge:
        return _redirect_error("invalid_request", "PKCE required for MCP scopes")
    # 공개 클라이언트는 secret 이 없으므로 PKCE 가 유일한 증명 수단이다.
    # 누락 시 인가 코드를 가로챈 측이 그대로 토큰으로 교환할 수 있다.
    if client_cfg.get("public") and not code_challenge:
        return _redirect_error("invalid_request", "PKCE required for public clients")

    # OIDC Core §3.1.2.1 prompt 파라미터.
    #   none    → UI 를 일절 표시하지 않는다. 로그인/동의가 필요하면 오류를 반환한다.
    #   consent → 기존 동의가 있어도 재확인한다.
    prompts = {p for p in (prompt or "").split() if p}
    silent = "none" in prompts

    def _prompt_error(err: str):
        """prompt=none 인데 상호작용이 필요한 경우 — redirect_uri 로 오류를 반환한다."""
        return _redirect_error(err)

    # Check session
    current_url = f"/oauth/authorize?{request.url.query}"

    if not ws_session:
        if silent:
            return _prompt_error("login_required")
        return RedirectResponse(
            url=f"/login?redirect={quote(current_url)}", status_code=302
        )

    data = unsign_value(ws_session)
    if not data or "user_id" not in data:
        if silent:
            return _prompt_error("login_required")
        return RedirectResponse(
            url=f"/login?redirect={quote(current_url)}", status_code=302
        )

    user = await db.get(User, data["user_id"])
    if not user or not user.is_active:
        if silent:
            return _prompt_error("login_required")
        return RedirectResponse(
            url=f"/login?redirect={quote(current_url)}", status_code=302
        )

    # 세션 무효화 검사 — get_current_user 와 동일한 규칙을 적용한다.
    # 이 검사가 누락되어, 비밀번호 변경이나 강제 로그아웃으로 token_version 을
    # 증가시켜도 **OAuth 인가는 계속 통과**했다(폐기된 쿠키로 새 토큰 발급 가능).
    # sid 레지스트리가 Redis 장애 시 fail-open 이라는 점까지 동일하게 적용한다.
    if data.get("tv") != user.token_version:
        if silent:
            return _prompt_error("login_required")
        return RedirectResponse(
            url=f"/login?redirect={quote(current_url)}", status_code=302
        )

    sid = data.get("sid")
    if not sid:
        if silent:
            return _prompt_error("login_required")
        return RedirectResponse(
            url=f"/login?redirect={quote(current_url)}", status_code=302
        )
    try:
        _rec = await sess_mod.get_session(sid)
    except Exception:
        _rec = "__failopen__"
    if _rec is None:
        if silent:
            return _prompt_error("login_required")
        return RedirectResponse(
            url=f"/login?redirect={quote(current_url)}", status_code=302
        )

    # ── 동의 게이트 ──
    # 이 지점 도달은 "로그인된 사용자" 임을 의미할 뿐, "이 클라이언트에게 권한을
    # 주겠다" 는 의사 표시는 아니다. 둘을 구분하지 않으면 로그인 상태에서 링크를
    # 클릭하게 하는 것만으로 인가가 완료된다(공개 DCR 과 결합 시 계정 데이터 유출).
    force_consent = "consent" in prompts
    if not _client_is_trusted(client_cfg) and (
        force_consent
        or not await _has_consent(db, user.id, client_id, requested_scopes)
    ):
        if silent:
            return _prompt_error("consent_required")
        rq = signer.dumps(
            {
                "user_id": user.id,
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "scope": scope,
                # 원본 authorize 쿼리를 그대로 보관하고 승인 후 해당 요청으로 복귀한다.
                "q": request.url.query,
            },
            salt=CONSENT_SALT,
        )
        return RedirectResponse(
            # 프런트엔드 라우트는 /consent 이다 — nginx 가 /oauth/ 를 백엔드로 전달하므로
            # 그 하위에는 프런트엔드 페이지를 둘 수 없다.
            url=f"/consent?rq={quote(rq)}", status_code=302
        )

    # Generate authorization code
    code = secrets.token_urlsafe(32)
    await store_code_async(
        code,
        AuthorizationCode(
            user_id=user.id,
            client_id=client_id,
            redirect_uri=redirect_uri,
            scope=scope,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
            nonce=nonce,
            resource=resource,
            expires_at=time.time() + CODE_TTL,
            # 백채널 로그아웃: 이 코드를 발급한 워크스페이스 세션 식별용.
            session_id=sid,
        ),
    )

    # RFC 9207 — authorization response 에 iss 를 포함하여 믹스업 공격을 방지한다.
    # 복수의 AS 를 사용하는 클라이언트가 응답의 발급처를 확인할 수 있어야 한다.
    params = {"code": code, "iss": settings.app_url}
    if state:
        params["state"] = state
    return RedirectResponse(
        url=f"{redirect_uri}?{urlencode(params)}", status_code=302
    )


# ── Consent Endpoints ────────────────────────────────────────


def _load_consent_request(rq: str) -> dict | None:
    try:
        return signer.loads(rq, salt=CONSENT_SALT, max_age=CONSENT_REQUEST_TTL)
    except BadSignature:
        return None


async def _consent_user(rq_data: dict, ws_session: str | None,
                        db: AsyncSession) -> User | None:
    """동의 요청 토큰의 주체와 현재 세션이 동일 사용자인지 확인.

    토큰만 신뢰하면 타인의 동의 요청을 대신 승인하게 할 수 있으므로 세션과 대조한다.
    """
    if not ws_session:
        return None
    data = unsign_value(ws_session)
    if not data or data.get("user_id") != rq_data.get("user_id"):
        return None
    user = await db.get(User, rq_data["user_id"])
    if not user or not user.is_active:
        return None
    # authorize 와 동일한 세션 무효화 검사.
    if data.get("tv") != user.token_version:
        return None
    return user


@router.get("/consent/info")
async def consent_info(
    rq: str,
    ws_session: str | None = Cookie(None),
    db: AsyncSession = Depends(get_db),
):
    """동의 화면에 표시할 내용 — 요청 앱과 해당 앱이 요구하는 권한."""
    data = _load_consent_request(rq)
    if not data:
        raise HTTPException(status_code=400, detail="만료되었거나 유효하지 않은 요청입니다")
    user = await _consent_user(data, ws_session, db)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")

    client_cfg = await _lookup_client(db, data["client_id"])
    if not client_cfg:
        raise HTTPException(status_code=400, detail="알 수 없는 클라이언트입니다")

    scopes = [x for x in (data.get("scope") or "").split() if x]
    return {
        "client_id": data["client_id"],
        "client_name": _client_display_name(data["client_id"], client_cfg),
        # 동적 등록 클라이언트는 화면에서 명확히 경고한다.
        "dynamic": bool(client_cfg.get("dynamic")),
        "redirect_uri": data["redirect_uri"],
        "scopes": [
            {"name": s, "description": SCOPE_DESCRIPTIONS.get(s, s)} for s in scopes
        ],
        "username": user.username,
        # RFC 7591 표시용 메타데이터 — 저장 시 https 로 검증된 값만 포함된다.
        "logo_uri": client_cfg.get("logo_uri"),
        "client_uri": client_cfg.get("client_uri"),
        "policy_uri": client_cfg.get("policy_uri"),
        "tos_uri": client_cfg.get("tos_uri"),
    }


class ConsentDecision(BaseModel):
    rq: str
    approve: bool


@router.post("/consent/decide")
@limiter.limit("30/minute")
async def consent_decide(
    request: Request,
    body: ConsentDecision,
    ws_session: str | None = Cookie(None),
    db: AsyncSession = Depends(get_db),
):
    """동의/거부 처리. 승인 시 원래 authorize URL 을 반환하며 프런트엔드가 이동한다."""
    data = _load_consent_request(body.rq)
    if not data:
        raise HTTPException(status_code=400, detail="만료되었거나 유효하지 않은 요청입니다")
    user = await _consent_user(data, ws_session, db)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")

    if not body.approve:
        # RFC 6749 §4.1.2.1 — 거부 시 redirect_uri 로 access_denied 를 반환한다.
        params = {"error": "access_denied",
                  "error_description": "User denied the request"}
        return {"redirect": f"{data['redirect_uri']}?{urlencode(params)}"}

    scopes = [x for x in (data.get("scope") or "").split() if x]
    await _record_consent(db, user.id, data["client_id"], scopes)
    logger.info(
        "OAuth consent granted: user=%s client=%s scopes=%s",
        user.username, data["client_id"], " ".join(scopes),
    )
    # 동의가 기록되었으므로 동일한 authorize 요청을 재실행하면 통과한다.
    return {"redirect": f"/oauth/authorize?{data['q']}"}


# ── groups 클레임 ────────────────────────────────────────────


async def _groups_claim(db: AsyncSession, user: User | None, scopes: set[str]) -> list[str]:
    """``groups`` 클레임 값.

    - 관리자이면 항상 "admin" 을 맨 앞에 둔다(기존 RP 호환 — 기존 값과 동일).
    - ``groups`` 스코프가 부여된 토큰에만 실제 워크스페이스 그룹 이름을 추가한다.
      해당 스코프를 요청하지 않은 기존 클라이언트(Gitea·MCP·데스크톱)는 기존과 동일한 값을 수신한다.
    - 그룹 이름이 "admin"(대소문자 무시)인 것은 제외하여 관리자 표식과 혼동되지 않게 한다.
    """
    if not user:
        return []
    out = [ADMIN_GROUP_MARKER] if user.is_admin else []
    if "groups" not in scopes:
        return out
    from app.groups.models import Group, GroupMember

    names = (
        await db.execute(
            select(Group.name)
            .join(GroupMember, GroupMember.group_id == Group.id)
            .where(GroupMember.user_id == user.id)
        )
    ).scalars().all()
    for n in sorted(set(names)):
        if n and n.strip().lower() != ADMIN_GROUP_MARKER:
            out.append(n)
    return out


# ── Token Endpoint ───────────────────────────────────────────


async def _authenticate_client(
    request: Request, data: dict, db: AsyncSession
) -> tuple[str, dict] | None:
    """Validate client credentials from form body or Basic auth.

    Resolves static clients first, then dynamic (RFC 7591 DCR) clients. Secret
    verification is constant-time: static clients compare plaintext, dynamic
    clients compare the SHA-256 hash of the presented secret against the stored
    hash. Returns (client_id, client_cfg) on success, or None on auth failure
    (caller responds with invalid_client / 401).
    """
    client_id = data.get("client_id", "")
    client_secret = data.get("client_secret", "")
    if not client_id or not client_secret:
        parsed = _parse_basic_auth(request.headers.get("authorization", ""))
        if parsed:
            client_id, client_secret = parsed

    client_cfg = await _lookup_client(db, client_id)
    if not client_cfg:
        return None

    # ── 공개 클라이언트 (RFC 8252 · OAuth 2.1) ──
    # 데스크톱/모바일 앱은 비밀키를 안전하게 보관할 수 없다. 배포본을 분해하면
    # 누구나 추출할 수 있으므로 비밀키의 기밀성이 성립하지 않는다. 따라서 secret 을 요구하지
    # 않고 **PKCE 로 대신 증명**한다(코드 교환 시 code_verifier 검증).
    # 해당 클라이언트는 정적 설정에 "public": true 로 표시한다.
    if client_cfg.get("public"):
        if client_secret:
            # 공개 클라이언트가 secret 을 전송하면 설정 오류이다. 로그 없이 통과시키면
            # 이후 secret 이 무시되는 원인을 파악하기 어렵다.
            logger.info("공개 클라이언트가 client_secret 을 보냈다 — 무시: %s", client_id)
        return client_id, client_cfg

    if client_cfg["dynamic"]:
        ok = hmac.compare_digest(
            str(client_cfg.get("secret_hash") or ""),
            hash_client_secret(str(client_secret or "")),
        )
    else:
        ok = hmac.compare_digest(
            str(client_cfg.get("secret") or ""), str(client_secret or "")
        )
    if not ok:
        return None
    return client_id, client_cfg


def _issues_refresh(scope: str, client_cfg: dict | None = None) -> bool:
    """리프레시 토큰 발급 여부를 판정한다.

    다음 두 경우에만 발급한다.

    1. MCP 스코프 — 장기 유지되는 커넥터이므로 갱신이 필요하다.
    2. **1st-party 네이티브 앱** — 데스크톱 클라이언트가 해당한다. 액세스 토큰의
       수명이 1시간이므로, 리프레시가 없으면 사용자가 1시간마다 브라우저로 이동하여
       재로그인해야 한다. RFC 8252 가 네이티브 앱에 리프레시 토큰을
       권장하는 이유이며(§6), 공개 클라이언트라도 **강제 회전 + 재사용 탐지**
       가 적용되어 있으면 된다는 것이 RFC 9700 의 요구이다 — 본 프로젝트는 둘 다 적용한다.

    Gitea SSO(portal-gitea) 같은 비-trusted 정적 클라이언트와 DCR 클라이언트는
    그대로 제외한다. 응답 형태를 변경하면 기존 연동이 동작하지 않는다.
    """
    if any(s in MCP_SCOPES for s in (scope or "").split()):
        return True
    return bool(client_cfg) and _client_is_trusted(client_cfg)


@router.post("/token")
async def token(request: Request, db: AsyncSession = Depends(get_db)):
    # Parse body (form-encoded per OAuth spec — keep request.form())
    form = await request.form()
    data = dict(form)

    grant_type = data.get("grant_type")

    # Client authentication (shared by both grants). Failure → invalid_client/401.
    authed = await _authenticate_client(request, data, db)
    if authed is None:
        return _oauth_error("invalid_client", "Invalid client credentials", 401)
    client_id, client_cfg = authed

    if grant_type == "authorization_code":
        resp = await _grant_authorization_code(db, data, client_id, client_cfg)
    elif grant_type == "refresh_token":
        resp = await _grant_refresh_token(db, data, client_id)
    else:
        return _oauth_error(
            "unsupported_grant_type", f"Unsupported grant_type: {grant_type}"
        )

    # Track usage of dynamic (DCR) clients on successful token issuance.
    if client_cfg.get("dynamic") and resp.status_code == 200:
        await _touch_dynamic_client(db, client_id)
    return resp


async def _grant_authorization_code(
    db: AsyncSession, data: dict, client_id: str, client_cfg: dict
) -> JSONResponse:
    code = data.get("code", "")
    redirect_uri = data.get("redirect_uri", "")
    code_verifier = data.get("code_verifier")

    # Consume authorization code (one-time)
    auth_code = await consume_code_async(code)
    if not auth_code:
        return _oauth_error("invalid_grant", "Code expired or invalid")

    if auth_code.client_id != client_id:
        return _oauth_error("invalid_grant", "Client mismatch")

    # 인가 시 저장한 값과 **정확히** 일치해야 한다. 루프백 포트 완화는 화이트리스트
    # 대조에만 적용되며, 여기서는 동일 요청 여부를 확인하므로 완전 일치를 요구한다.
    if auth_code.redirect_uri != redirect_uri:
        return _oauth_error("invalid_grant", "redirect_uri mismatch")

    # PKCE verification (only S256 accepted — enforced at /authorize)
    if auth_code.code_challenge:
        if not code_verifier:
            return _oauth_error("invalid_grant", "code_verifier required for PKCE")
        digest = hashlib.sha256(code_verifier.encode()).digest()
        computed = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
        if not hmac.compare_digest(computed, auth_code.code_challenge or ""):
            return _oauth_error("invalid_grant", "Invalid code_verifier")

    # aud/scope bound to the code. aud is None for legacy Gitea flow.
    aud = auth_code.resource
    scope = auth_code.scope
    user = await db.get(User, auth_code.user_id)
    access_token = await _create_access_token(
        db, auth_code.user_id, scope=scope, aud=aud, client_id=client_id,
        tv=(user.token_version or 0) if user else None,
    )

    # Build id_token (OpenID Connect)
    now = int(time.time())
    granted_scopes = set((scope or "").split())
    id_claims = {
        "iss": settings.app_url,
        "sub": auth_code.user_id,
        "aud": client_id,
        "iat": now,
        "exp": now + ACCESS_TOKEN_TTL,
        "preferred_username": user.username if user else "",
        "name": (user.display_name or user.username) if user else "",
        "email": user.email if user else "",
        "groups": await _groups_claim(db, user, granted_scopes),
    }
    if auth_code.nonce:
        id_claims["nonce"] = auth_code.nonce
    # Back-Channel Logout §2.1 — 세션 식별자. logout_token 의 sid 와 동일한 값이다.
    if auth_code.session_id:
        id_claims["sid"] = backchannel.oidc_sid(auth_code.session_id)
    id_token = await _sign(db, id_claims)
    await backchannel.track(auth_code.user_id, client_id, auth_code.session_id)

    body = {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_TTL,
        "scope": scope,
        "id_token": id_token,
    }
    if _issues_refresh(scope, client_cfg):
        refresh = await issue_refresh_token(
            db,
            user_id=auth_code.user_id,
            client_id=client_id,
            scope=scope,
            resource=aud,
        )
        await db.commit()
        body["refresh_token"] = refresh
    return _token_response(body)


async def _grant_refresh_token(
    db: AsyncSession, data: dict, client_id: str
) -> JSONResponse:
    presented = data.get("refresh_token", "")
    if not presented:
        return _oauth_error("invalid_grant", "Missing refresh_token")

    try:
        old = await rotate_refresh_token(db, presented)
    except RefreshReuseError:
        await db.commit()  # chain revocation must persist
        return _oauth_error("invalid_grant", "Refresh token reuse detected")

    if old is None:
        await db.commit()
        return _oauth_error("invalid_grant", "Refresh token expired or invalid")

    if old.client_id != client_id:
        await db.commit()
        return _oauth_error("invalid_grant", "Client mismatch")

    # Verify the user is still active (deactivated/deleted → invalid_grant).
    user = await db.get(User, old.user_id)
    if not user or not user.is_active:
        await db.commit()
        return _oauth_error("invalid_grant", "User inactive")

    # Optionally allow narrowing scope on refresh (RFC 6749 §6); default = same.
    requested = data.get("scope")
    scope = old.scope
    if requested:
        req_set = [s for s in requested.split() if s]
        granted = set(old.scope.split())
        if any(s not in granted for s in req_set):
            await db.commit()
            return _oauth_error("invalid_scope", "Requested scope exceeds grant")
        scope = " ".join(req_set)

    # Mandatory rotation — mint successor linked to the consumed token.
    new_refresh = await issue_refresh_token(
        db,
        user_id=old.user_id,
        client_id=client_id,
        scope=scope,
        resource=old.resource,
        rotated_from=old.token_hash,
    )
    await db.commit()

    access_token = await _create_access_token(
        db, old.user_id, scope=scope, aud=old.resource, client_id=client_id,
        tv=user.token_version or 0,
    )
    return _token_response({
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_TTL,
        "scope": scope,
        "refresh_token": new_refresh,
    })


# ── Revocation Endpoint (RFC 7009) ───────────────────────────


@router.post("/revoke")
async def revoke(request: Request, db: AsyncSession = Depends(get_db)):
    """Revoke a refresh token (RFC 7009). Always returns 200 per spec, even for
    unknown tokens, to avoid leaking token validity."""
    form = await request.form()
    data = dict(form)

    authed = await _authenticate_client(request, data, db)
    if authed is None:
        return _oauth_error("invalid_client", "Invalid client credentials", 401)
    client_id, _ = authed

    presented = data.get("token", "")
    if presented:
        from datetime import datetime, timezone

        from sqlalchemy import select as _select

        from app.db.models import OAuthRefreshToken
        from app.auth.oauth_store import hash_refresh_token

        row = (
            await db.execute(
                _select(OAuthRefreshToken).where(
                    OAuthRefreshToken.token_hash == hash_refresh_token(presented)
                )
            )
        ).scalar_one_or_none()
        # Only the owning client may revoke; silently ignore mismatches.
        if row is not None and row.client_id == client_id and row.revoked_at is None:
            row.revoked_at = datetime.now(timezone.utc)
            await db.commit()
            # MCP 는 해제 시각 이전에 발급된 액세스 토큰도 거부한다(app.mcp.revocation — Redis 부재 시 생략)
            from app.mcp import revocation

            await revocation.mark(row.user_id, client_id)

    return _token_response({})


# ── UserInfo Endpoint ────────────────────────────────────────


@router.get("/userinfo")
async def userinfo(request: Request, db: AsyncSession = Depends(get_db)):
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")

    # aud 검증을 비활성화하여 수신한다. 기존에는 audience 를 전달하지 않아 JWT 라이브러리가
    # "aud 클레임은 있는데 기대값이 없다" 는 JWTClaimsError 를 발생시켰고, 그 결과
    # **aud 를 가진 MCP 토큰이 전부 401** 이었다(Gitea SSO 토큰만 통과).
    try:
        payload = await verify_access_token(
            db, auth_header[7:], options={"verify_aud": False}
        )
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid token")

    # OIDC Core §5.3.1 — UserInfo 는 openid 스코프를 가진 토큰에만 응답한다.
    scopes = set((payload.get("scope") or "").split())
    if scopes and "openid" not in scopes:
        raise HTTPException(status_code=403, detail="openid scope required")

    user = await db.get(User, payload["sub"])
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return {
        "sub": user.id,
        "preferred_username": user.username,
        "name": user.display_name or user.username,
        "email": user.email,
        "groups": await _groups_claim(db, user, scopes),
    }
