"""OpenID Connect Back-Channel Logout 1.0 — OP 측 구현.

워크스페이스 세션이 종료되면(로그아웃·세션 폐기·비밀번호 변경·계정 정지/삭제·유휴 만료)
해당 세션으로 ID 토큰을 발급받은 RP 에 ``logout_token`` 을 서버 간 POST 로 전송한다.
별도 출처 RP(lab.example.com 등)는 워크스페이스 Redis 에 접근할 수 없으므로, 본 기능이 없으면
워크스페이스에서 로그아웃해도 RP 세션이 유지된다.

설계
  * 대상 RP 는 정적 클라이언트(OAUTH_CLIENTS_JSON)에 ``backchannel_logout_uri`` 를 지정한 것으로 한정한다.
    DCR(RFC 7591) 클라이언트는 대상에서 제외한다 — 누구나 등록 가능한 URL 로 백엔드가 요청을
    전송하면 SSRF 경로가 된다.
  * 추적: ID 토큰 발급 시 Redis 에 (사용자, 클라이언트, 워크스페이스 sid) 를 기록한다.
        bclu:{user_id}  Set  "client_id\\tws_sid"
        bcls:{ws_sid}   Str  user_id   (세션 레코드가 먼저 삭제되어도 소유자를 식별하기 위함)
  * ``sid`` 클레임은 워크스페이스 sid 원본이 아닌 HMAC 파생값이다(RP 에 세션 식별자를
    노출하지 않는다). 동일 세션이면 모든 RP 에 동일한 값이다(Spec §2.1, 세션 단위 식별자).
  * 전송은 비동기(백그라운드 태스크)·짧은 타임아웃·제한된 재시도. **전송이 실패해도 로그아웃
    자체는 이미 완료된 상태다** — 본 모듈의 어떤 예외도 호출자에게 전파되지 않는다.
  * 백채널 RP 가 하나도 없으면 Redis 에 접근하지 않고 즉시 반환한다(기존 동작 유지).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import time
from urllib.parse import urlparse

import httpx
import jwt

from app.chat.redis_client import get_redis
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

EVENT = "http://schemas.openid.net/event/backchannel-logout"
LOGOUT_TOKEN_TYP = "logout+jwt"
LOGOUT_TOKEN_TTL = 120          # Spec §2.4 — 짧게 설정(2분)
SEND_TIMEOUT = httpx.Timeout(3.0, connect=2.0)
RETRY_DELAYS = (1.0, 3.0)       # 첫 시도 + 재시도 2회
TRACK_TTL = 86400 * 31          # 세션 레지스트리(usess:)와 동일한 보존 기간

_USER = "bclu:"
_SESS = "bcls:"

# 테스트에서 교체하는 지점.
_transport: httpx.AsyncBaseTransport | None = None
_session_factory = None          # None → app.db.session.async_session
_pending: set[asyncio.Task] = set()


# ── 클라이언트 설정 ──────────────────────────────────────────


def valid_logout_uri(uri: object) -> bool:
    """backchannel_logout_uri 검증.

    Spec §2.2: 절대 URI, fragment 금지. 공개망은 https 만 허용. http 는 사설·루프백 IP 리터럴 또는
    점이 없는 내부 호스트명(도커 서비스명)인 경우에만 허용한다 — 헤어핀 NAT 가 없어 공개 주소로
    RP 에 접속할 수 없는 구성을 지원하기 위함이다.
    """
    if not isinstance(uri, str) or not uri or len(uri) > 2048:
        return False
    try:
        u = urlparse(uri)
    except ValueError:
        return False
    if u.fragment or not u.hostname:
        return False
    if u.scheme == "https":
        return True
    if u.scheme != "http":
        return False
    host = u.hostname
    try:
        a = ipaddress.ip_address(host)
        return a.is_private or a.is_loopback
    except ValueError:
        return "." not in host


def bcl_clients() -> dict[str, dict]:
    """백채널 로그아웃 수신 대상 정적 클라이언트 {client_id: {uri, session_required}}."""
    from app.auth.oauth_provider import _get_clients  # 순환 import 회피

    out: dict[str, dict] = {}
    try:
        clients = _get_clients()
    except Exception as e:  # 잘못된 OAUTH_CLIENTS_JSON — 로그아웃을 차단하지 않는다
        logger.warning("[bcl] client config unreadable: %s", e)
        return out
    for cid, cfg in clients.items():
        uri = (cfg or {}).get("backchannel_logout_uri")
        if not uri:
            continue
        if not valid_logout_uri(uri):
            logger.warning("[bcl] client %s: invalid backchannel_logout_uri ignored", cid)
            continue
        out[cid] = {
            "uri": uri,
            "session_required": bool(cfg.get("backchannel_logout_session_required")),
        }
    return out


def oidc_sid(ws_sid: str) -> str:
    """워크스페이스 세션 sid → RP 에 전달할 sid (결정적 HMAC 파생, 22자 base64url)."""
    mac = hmac.new(settings.secret_key.encode(), b"oidc-sid:" + ws_sid.encode(),
                   hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac[:16]).rstrip(b"=").decode()


# ── 추적(ID 토큰 발급 시) ───────────────────────────────────


async def track(user_id: str, client_id: str, ws_sid: str | None) -> None:
    """본 세션이 해당 RP 에 로그인했음을 기록. 실패는 무시한다(로그인을 차단하지 않는다)."""
    if not ws_sid or client_id not in bcl_clients():
        return
    try:
        r = await get_redis()
        await r.sadd(_USER + user_id, f"{client_id}\t{ws_sid}")
        await r.expire(_USER + user_id, TRACK_TTL)
        await r.setex(_SESS + ws_sid, TRACK_TTL, user_id)
    except Exception as e:
        logger.warning("[bcl] track failed (RP logout won't propagate for this session): %s", e)


def _parse(entries) -> list[tuple[str, str]]:
    out = []
    for e in entries or ():
        cid, _, sid = str(e).partition("\t")
        if cid and sid:
            out.append((cid, sid))
    return out


# ── 로그아웃 이벤트(sessions.py 에서 호출) ───────────────────


async def on_session_revoked(ws_sid: str, user_id: str | None = None) -> None:
    """세션 1건 종료 → 해당 세션으로 로그인한 RP 에 통지한다."""
    try:
        clients = bcl_clients()
        if not clients or not ws_sid:
            return
        r = await get_redis()
        uid = user_id or await r.get(_SESS + ws_sid)
        if not uid:
            return
        pairs = [(c, s) for c, s in _parse(await r.smembers(_USER + uid)) if s == ws_sid]
        if pairs:
            await r.srem(_USER + uid, *[f"{c}\t{s}" for c, s in pairs])
        await r.delete(_SESS + ws_sid)
        jobs = [(c, uid, s) for c, s in pairs if c in clients]
        _schedule(jobs, clients)
    except Exception as e:
        logger.warning("[bcl] session logout propagation failed: %s", e)


async def on_user_revoked(user_id: str) -> None:
    """사용자의 전체 세션 종료(비밀번호 변경·강제 로그아웃·정지·삭제)."""
    try:
        clients = bcl_clients()
        if not clients or not user_id:
            return
        try:
            r = await get_redis()
            pairs = _parse(await r.smembers(_USER + user_id))
            keys = [_USER + user_id] + [_SESS + s for _, s in pairs]
            await r.delete(*keys)
        except Exception as e:
            # Redis 조회 실패 시 세션별 RP 대응 관계를 알 수 없다. sid 없이 sub 만으로
            # "이 사용자 전부 로그아웃"을 전송한다(Spec §2.4 — sub 만 있으면 RP 의 해당 사용자
            # 세션 전체가 대상). sid 필수 RP 에는 sid 없는 토큰을 전송할 수 없으므로 제외한다.
            logger.warning("[bcl] tracking unreadable, falling back to sub-only: %s", e)
            jobs = [(c, user_id, None) for c, cfg in clients.items()
                    if not cfg["session_required"]]
            _schedule(jobs, clients)
            return
        seen: set[tuple[str, str]] = set()
        jobs = []
        for c, s in pairs:
            if c in clients and (c, s) not in seen:
                seen.add((c, s))
                jobs.append((c, user_id, s))
        _schedule(jobs, clients)
    except Exception as e:
        logger.warning("[bcl] user logout propagation failed: %s", e)


async def on_all_revoked() -> None:
    """전체 강제 로그아웃 — 추적 기록이 있는 사용자만 순회한다."""
    try:
        if not bcl_clients():
            return
        r = await get_redis()
        users = []
        async for key in r.scan_iter(match=_USER + "*", count=500):
            users.append(str(key)[len(_USER):])
        for uid in users:
            await on_user_revoked(uid)
    except Exception as e:
        logger.warning("[bcl] logout-all propagation failed: %s", e)


# ── logout_token 생성·전송 ───────────────────────────────────


def build_claims(client_id: str, sub: str | None, ws_sid: str | None) -> dict:
    """Spec §2.4 logout_token 클레임. nonce 는 포함하지 않는다(MUST NOT)."""
    now = int(time.time())
    claims = {
        "iss": settings.app_url,
        "aud": client_id,
        "iat": now,
        "exp": now + LOGOUT_TOKEN_TTL,
        "jti": secrets.token_urlsafe(16),
        "events": {EVENT: {}},
    }
    if sub:
        claims["sub"] = sub
    if ws_sid:
        claims["sid"] = oidc_sid(ws_sid)
    return claims


async def make_logout_token(db, client_id: str, sub: str | None, ws_sid: str | None) -> str:
    from app.auth import jwks as jwks_mod

    key = await jwks_mod.get_active_key(db)
    return jwt.encode(
        build_claims(client_id, sub, ws_sid), key.private_pem, algorithm=key.algorithm,
        headers={"kid": key.kid, "typ": LOGOUT_TOKEN_TYP},
    )


def _schedule(jobs: list[tuple[str, str, str | None]], clients: dict) -> None:
    if not jobs:
        return
    try:
        task = asyncio.get_running_loop().create_task(_deliver_all(jobs, clients))
    except RuntimeError:
        logger.warning("[bcl] no running loop — %d logout notice(s) dropped", len(jobs))
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def _deliver_all(jobs, clients) -> None:
    factory = _session_factory
    if factory is None:
        from app.db.session import async_session as factory
    try:
        async with factory() as db:
            tokens = []
            for cid, sub, ws_sid in jobs:
                tokens.append((cid, clients[cid]["uri"],
                               await make_logout_token(db, cid, sub, ws_sid)))
    except Exception as e:
        logger.warning("[bcl] could not sign logout tokens: %s", e)
        return
    async with httpx.AsyncClient(timeout=SEND_TIMEOUT, transport=_transport,
                                 follow_redirects=False) as http:
        await asyncio.gather(*[_send(http, cid, uri, tok) for cid, uri, tok in tokens],
                             return_exceptions=True)


async def _send(http: httpx.AsyncClient, client_id: str, uri: str, token: str) -> bool:
    """Spec §2.5 — form POST ``logout_token``. 2xx 는 성공, 4xx 는 RP 의 거부이므로 재시도하지 않는다."""
    delays = (0.0, *RETRY_DELAYS)
    for attempt, delay in enumerate(delays, 1):
        if delay:
            await asyncio.sleep(delay)
        try:
            resp = await http.post(
                uri, data={"logout_token": token},
                headers={"Cache-Control": "no-store"},
            )
        except Exception as e:
            logger.info("[bcl] %s attempt %d failed: %s", client_id, attempt, type(e).__name__)
            continue
        if 200 <= resp.status_code < 300:
            logger.info("[bcl] %s notified (%d)", client_id, resp.status_code)
            return True
        if 400 <= resp.status_code < 500:
            logger.warning("[bcl] %s rejected logout_token: %d", client_id, resp.status_code)
            return False
        logger.info("[bcl] %s attempt %d: HTTP %d", client_id, attempt, resp.status_code)
    logger.warning("[bcl] %s unreachable after %d attempts — RP session may linger",
                   client_id, len(delays))
    return False


async def drain() -> None:
    """미완료 전송이 모두 끝날 때까지 대기한다(테스트·종료 훅용)."""
    while _pending:
        batch = list(_pending)
        await asyncio.gather(*batch, return_exceptions=True)
        # done 콜백은 다음 루프 턴에 실행된다 — 콜백을 대기하지 않고 직접 제거한다(생략 시 무한 루프).
        _pending.difference_update(batch)
