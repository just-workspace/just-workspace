"""WebSocket 핸드셰이크 인증 — REST 와 동일한 세션 검증(app.auth.deps.verify_session_data).

토큰 출처
1. ``ws_session`` 쿠키 — 웹. 쿠키는 브라우저가 자동으로 첨부하므로 Origin 이 본 서비스 출처
   (APP_URL·같은 Host·번들 앱 출처)일 때만 허용한다(교차 사이트 WebSocket 차단).
2. ``Sec-WebSocket-Protocol: jw.bearer, jw.token.<base64url(토큰)>`` — 번들 클라이언트(서명 세션값)
   · 데스크톱 앱(1st-party OAuth 액세스 토큰). 서버는 ``jw.bearer`` 를 선택하여 응답한다(accept_subprotocol).
3. ``?token=`` — 구 클라이언트 호환. 쿼리에 포함되면 nginx error_log 의 ``request:`` 필드에 평문으로 기록되므로
   (access_log 는 $uri 만 사용하나 error_log 형식은 변경할 수 없다) 신규 클라이언트는 2번을 사용한다.
"""
from __future__ import annotations

from urllib.parse import urlsplit

from starlette.websockets import WebSocket

from app.config import get_settings
from app.db.models import User

# 번들 빌드 모바일 앱의 웹뷰 출처(ALLOW_NATIVE_APP_ORIGINS=true 일 때만 허용 — CORS·CSRF·WebSocket 이 공용한다).
#   https://localhost      안드로이드(apps/mobile/capacitor.config.ts 의 androidScheme: 'https')
#   capacitor://localhost  iOS
# http://localhost 는 포함하지 않는다 — 앱은 https 스킴으로 기동하며, 포함 시 사용자 PC 의 임의 로컬 웹 서버가
# 쿠키를 포함한 요청을 송신할 수 있게 된다.
NATIVE_APP_ORIGINS = ("https://localhost", "capacitor://localhost")
_NATIVE_ORIGINS = NATIVE_APP_ORIGINS


WS_AUTH_PROTOCOL = "jw.bearer"
_TOKEN_PREFIX = "jw.token."


def _offered_protocols(ws: WebSocket) -> list[str]:
    raw = ws.headers.get("sec-websocket-protocol") or ""
    return [p.strip() for p in raw.split(",") if p.strip()]


def token_from_protocol(ws: WebSocket) -> str | None:
    """Sec-WebSocket-Protocol 에 포함된 토큰(jw.token.<base64url>) — 없거나 손상된 경우 None."""
    import base64
    offered = _offered_protocols(ws)
    if WS_AUTH_PROTOCOL not in offered:
        return None
    for p in offered:
        if p.startswith(_TOKEN_PREFIX):
            enc = p[len(_TOKEN_PREFIX):]
            try:
                tok = base64.b64decode(enc + "=" * (-len(enc) % 4), altchars=b"-_", validate=True).decode()
                return tok or None
            except (ValueError, UnicodeDecodeError):
                return None
    return None


def accept_subprotocol(ws: WebSocket) -> str | None:
    """클라이언트가 jw.bearer 를 제시한 경우 이를 선택한다 — 선택하지 않으면 브라우저가 핸드셰이크를 종료한다."""
    return WS_AUTH_PROTOCOL if WS_AUTH_PROTOCOL in _offered_protocols(ws) else None


def _origin_of(url: str) -> str:
    try:
        p = urlsplit(url)
    except ValueError:
        return ""
    if not p.scheme or not p.netloc:
        return ""
    return f"{p.scheme.lower()}://{p.netloc.lower()}"


def origin_allowed(ws: WebSocket) -> bool:
    origin = (ws.headers.get("origin") or "").strip().lower()
    if not origin:
        # 브라우저는 WebSocket 에 항상 Origin 을 포함한다. 없으면 비브라우저 클라이언트 — 쿠키 위조 위험 없음.
        return True
    s = get_settings()
    allowed = {_origin_of(s.app_url)}
    host = (ws.headers.get("host") or "").strip().lower()
    if host:
        allowed |= {f"https://{host}", f"http://{host}"}
    if getattr(s, "allow_native_app_origins", False):
        allowed |= set(_NATIVE_ORIGINS)
    if getattr(s, "debug", False):
        allowed |= {"http://localhost:3000", "http://localhost:8000"}
    return origin in allowed


async def authenticate_ws(ws: WebSocket, db=None) -> User | None:
    from app.auth.deps import user_from_ws_token

    cookie = ws.cookies.get("ws_session")
    if cookie and not origin_allowed(ws):
        cookie = None
    token = cookie or token_from_protocol(ws) or ws.query_params.get("token")
    if not token:
        return None
    if db is not None:
        return await user_from_ws_token(db, token)
    from app.db.session import async_session
    async with async_session() as session:
        return await user_from_ws_token(session, token)
