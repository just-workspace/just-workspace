"""세션 쿠키로 인증된 상태 변경 요청의 출처(Origin) 검사 — CSRF 방어.

필요 사유
  세션 쿠키(ws_session)는 SameSite=Lax 이므로 **타 사이트**에서 전송한 POST 에는 포함되지 않는다. 그러나
  SameSite 는 "사이트"(등록 도메인) 단위이다 — 동일 등록 도메인의 다른 하위 도메인(타 서비스·사용자 콘텐츠가
  게시되는 출처)에서 전송한 요청에는 쿠키가 그대로 포함된다. 해당 출처 하나가 침해되면 로그인한 사용자의 권한으로
  워크스페이스 API 를 호출할 수 있다. 따라서 쿠키가 포함된 POST/PUT/PATCH/DELETE 는 Origin(없으면 Referer)이
  본 프로젝트의 출처인 경우에만 허용한다.

검사 제외 요청
  - 안전한 메서드(GET/HEAD/OPTIONS 등) — 상태를 변경하지 않는다.
  - ws_session 쿠키가 없는 요청 — 쿠키로 인증되지 않으므로 CSRF 대상이 아니다(OAuth 토큰 교환, WOPI,
    웹훅, 공유 링크 게스트, 내부 서비스 호출이 모두 이에 해당한다).
    Bearer 로 인증하는 데스크톱·모바일 앱, MCP, API 클라이언트도 쿠키를 전송하지 않으므로 이에 해당한다.
    **쿠키가 포함되어 있으면 Authorization: Bearer 가 함께 전달되어도 검사한다** — 인증(app/auth/deps.py)이 쿠키를
    Bearer 보다 우선 사용하므로, 쿠키 + 임의의 Bearer 로 검사를 우회하도록 허용해서는 안 된다. 쿠키와 Bearer 를 함께
    전송할 수 있는 번들 앱(Tauri/Capacitor)의 출처는 CORS 허용 목록에 있어 그대로 통과한다.
  - Origin·Referer 가 모두 없는 요청 — 브라우저가 아니다(브라우저의 교차 출처 POST 는 Origin 을 항상 전송한다).
  - 격리 브라우저 전용 출처(Host = RBI_PUBLIC_ORIGIN) — 워크스페이스 쿠키가 전송되지 않으며, 자체 Origin 검사
    (app/rbi/site.py _check_origin)가 별도로 존재한다.
  - EXEMPT_PREFIXES — 쿠키가 아닌 자체 토큰·키로 인증하며 외부에서 호출되는 엔드포인트. 동일 사이트의
    다른 출처에서 호출할 때 브라우저가 쿠키를 추가로 전송해도 오동작하지 않도록 한다.

허용 출처
  설정의 공개 주소(APP_URL) · CORS 허용 목록(main.py 가 전달한다 — 디버그의 vite 개발 서버, 네이티브 앱 셸) ·
  CSRF_TRUSTED_ORIGINS(쉼표) · 요청의 Host 와 동일한 출처(동일 출처 요청 — 사설 IP·다른 이름으로 접속한 경우).

비활성화: CSRF_ORIGIN_CHECK=false (기본 활성).
"""
from __future__ import annotations

import json
import logging
from urllib.parse import urlsplit

from app.config import get_settings

logger = logging.getLogger(__name__)

SESSION_COOKIE = "ws_session"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

#: 쿠키가 아닌 자체 인증(토큰·키·서명)으로 동작하며 외부에서 호출되는 경로
EXEMPT_PREFIXES = (
    "/api/internal/",     # 내부 서비스(메일서버·ws-ldap·nginx auth_request) — 내부 키
    "/api/webhooks/",     # 수신 웹훅(Gitea 등) — 웹훅 시크릿
    # WOPI 프로토콜(문서 편집기 → 백엔드, access_token). /api/wopi/open·/new 는 본 프로젝트 화면이 세션 쿠키로
    # 호출하므로 포함하지 않는다 — 검사 대상이다.
    "/api/wopi/files/",
    "/api/mcp/",          # MCP(Streamable HTTP·SSE) — Bearer. 마운트 루트(/api/mcp)는 EXEMPT_EXACT
    "/dav/",              # CalDAV/CardDAV — 앱 비밀번호(Basic)
)
#: OAuth/OIDC 클라이언트가 호출하는 엔드포인트(클라이언트 인증·PKCE). 동의 결정(/oauth/consent/decide)은
#: 세션 쿠키로 인증되는 본 프로젝트 화면의 요청이므로 포함하지 않는다 — 검사 대상이다.
EXEMPT_EXACT = frozenset({
    "/oauth/token", "/oauth/revoke", "/oauth/register", "/oauth/introspect", "/oauth/userinfo",
    "/api/meetings/livekit/webhook",      # LiveKit 서버 → 서명 검증
    "/api/mcp",                           # 접두 일치는 경계까지만 적용 — "/api/mcpx…" 같은 인접 경로가 예외에 포함되지 않도록 함
})


def _origin_of(url: str) -> str | None:
    """URL → "scheme://host[:port]"(소문자). 파싱 불가 시 None."""
    try:
        p = urlsplit(url.strip())
    except ValueError:
        return None
    if not p.scheme or not p.netloc:
        return None
    return f"{p.scheme.lower()}://{p.netloc.lower()}"


def _has_session_cookie(cookie_header: str) -> bool:
    for part in cookie_header.split(";"):
        if part.strip().startswith(SESSION_COOKIE + "="):
            return True
    return False


class CookieOriginGuard:
    """순수 ASGI 미들웨어(스트리밍 응답·업로드 본문을 변경하지 않는다)."""

    def __init__(self, app, allowed_origins=None, enabled: bool | None = None):
        self.app = app
        s = get_settings()
        self.enabled = s.csrf_origin_check if enabled is None else enabled
        self.https = s.app_url.lower().startswith("https://")
        self.debug = bool(s.debug)
        allowed = {_origin_of(s.app_url)}
        allowed |= {_origin_of(o) for o in (allowed_origins or [])}
        allowed |= {_origin_of(o) for o in (s.csrf_trusted_origins or "").split(",") if o.strip()}
        allowed.discard(None)
        self.allowed = frozenset(allowed)

    def origin_allowed(self, origin: str, host: str) -> bool:
        if origin in self.allowed:
            return True
        host = (host or "").strip().lower()
        if host:
            # 동일 출처 요청(공격자는 피해자 브라우저의 Host 를 변경할 수 없다). 공개 주소가 https 인 설치본은
            # https 만 허용한다 — http 로 강등된 동일 이름의 출처는 중간자가 위조할 수 있다.
            if origin == f"https://{host}" or (not self.https and origin == f"http://{host}"):
                return True
        if self.debug:
            # 개발: vite 개발 서버(포트 무관) — 프록시가 Host 를 백엔드 주소로 변경하여 전달하므로 위 비교에 일치하지 않는다
            try:
                h = urlsplit(origin).hostname or ""
            except ValueError:      # 파싱 불가 출처 — 허용 출처 아님
                return False
            if h in ("localhost", "127.0.0.1", "::1"):
                return True
        return False

    def verdict(self, method: str, path: str, headers: dict[str, str]) -> str | None:
        """차단 대상이면 거부된 출처 문자열, 통과이면 None 을 반환한다. headers 키는 소문자."""
        if method not in UNSAFE_METHODS:
            return None
        if not _has_session_cookie(headers.get("cookie", "")):
            return None
        if path in EXEMPT_EXACT or path.startswith(EXEMPT_PREFIXES):
            return None
        raw = headers.get("origin", "").strip()
        if raw:
            # "null"(샌드박스 iframe·불투명 출처)은 허용 출처가 아니다 — Referer 로 fallback 하지 않고 차단한다
            origin = _origin_of(raw) or raw.lower()
        else:
            ref = headers.get("referer", "").strip()
            if not ref:
                return None
            origin = _origin_of(ref) or "(읽을 수 없는 Referer)"
        host = headers.get("host", "")
        from app.rbi.site import is_rbi_host_header
        if is_rbi_host_header(host):
            return None
        return None if self.origin_allowed(origin, host) else origin

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not self.enabled:
            return await self.app(scope, receive, send)
        method = (scope.get("method") or "").upper()
        if method not in UNSAFE_METHODS:
            return await self.app(scope, receive, send)
        headers: dict[str, str] = {}
        for k, v in scope.get("headers") or []:
            name = k.decode("latin-1").lower()
            if name in ("cookie", "authorization", "origin", "referer", "host"):
                val = v.decode("latin-1")
                # 쿠키 헤더는 HTTP/2 에서 여러 줄로 수신될 수 있다
                headers[name] = f"{headers[name]}; {val}" if name == "cookie" and name in headers else val
        path = scope.get("path") or ""
        try:
            bad = self.verdict(method, path, headers)
        except Exception as e:  # noqa: BLE001 — 판정 중 예외 발생 시(비정상 Origin/Referer 등) 500 이 아닌 거부로 처리
            logger.warning("[csrf] 출처 판정 실패(거부): %s", e)
            bad = "(판정 실패)"
        if bad is None:
            return await self.app(scope, receive, send)
        client = scope.get("client") or ("", 0)
        logger.warning("[csrf] 출처 불일치로 거부: %s %s origin=%s host=%s ip=%s",
                       method, path, bad[:200], headers.get("host", "")[:200], client[0] or "-")
        body = json.dumps({"detail": "요청 출처가 올바르지 않습니다"}, ensure_ascii=False).encode()
        await send({"type": "http.response.start", "status": 403, "headers": [
            (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
            (b"cache-control", b"no-store"),
        ]})
        await send({"type": "http.response.body", "body": body})
