"""서버측 세션 레지스트리 (Redis) — per-device 추적/원격 로그아웃.

각 로그인마다 고유 sid 발급 + IP/hostname/UA/타임스탬프를 Redis에 기록.
- sess:{sid}      -> JSON 세션 레코드 (TTL = 세션 수명, 슬라이딩)
- usess:{user_id} -> 해당 유저의 sid Set (목록 조회/일괄 취소용)

get_current_user가 매 요청 sid 존재를 확인 → 없으면(취소/만료) 401.
Redis 장애 시에는 fail-open (tv 검사만으로 통과)하여 전체 다운 방지.
"""

import asyncio
import ipaddress
import json
import logging
import secrets
import socket
import time

from fastapi import Request

from app.chat.redis_client import get_redis

logger = logging.getLogger(__name__)

_SESS = "sess:"
_USESS = "usess:"
_TOUCH_INTERVAL = 60          # last_seen 갱신 최소 간격(초) — 매 요청 쓰기 방지
_USET_TTL = 86400 * 31        # 유저 sid Set 보존 기간


def _bcl():
    """app.auth.backchannel — 지연 import(이 모듈은 가볍게 유지)."""
    from app.auth import backchannel
    return backchannel


def client_ip(request: Request) -> str:
    """실제 클라이언트 IP — 백엔드 전체가 쓰는 단일 규칙(세션·접속 로그·감사 로그·레이트리밋).

    헤더는 **읽지 않는다.** 신뢰 경계는 앞단이 지킨다:
    - ws-nginx 는 앞단 리버스 프록시 연결일 때만 X-Real-IP 를 승격(realip)하고, 뒤로는
      X-Forwarded-For 를 그 값 하나로 **덮어써** 보낸다.
    - uvicorn 은 `--proxy-headers --forwarded-allow-ips 172.28.0.2`(ws-nginx 고정 IP)라
      그 연결에서 온 XFF 만 `request.client` 에 반영한다.
    그래서 여기서 X-Real-IP/XFF 를 다시 읽으면 LAN·도커망에서 nginx 를 거치지 않고 온
    요청이 헤더로 IP 를 위조할 수 있게 된다. slowapi 의
    `get_remote_address` 도 같은 `request.client.host` 를 쓰므로 키가 자동으로 맞는다.
    """
    return request.client.host if request.client else ""


def _is_non_public(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return a.is_private or a.is_loopback or a.is_link_local or a.is_unspecified


async def resolve_hostname(ip: str) -> str:
    """역방향 DNS(PTR)로 hostname. 실패/사설망이면 빈 문자열. 블로킹이라 executor+타임아웃.

    사설·루프백은 조회하지 않는다 — 컨테이너 /etc/hosts 의 `host.docker.internal`
    같은 내부 별칭이 세션 목록에 기기 이름처럼 찍히는 것을 막는다.
    """
    if not ip or _is_non_public(ip):
        return ""
    try:
        loop = asyncio.get_running_loop()
        res = await asyncio.wait_for(
            loop.run_in_executor(None, socket.gethostbyaddr, ip), timeout=1.5
        )
        return res[0]
    except Exception:
        return ""


async def create_session(user_id: str, ip: str, hostname: str, ua: str, ttl: int) -> str:
    """세션 레코드 생성 후 sid 반환. Redis 장애 시 sid만 반환(레지스트리 없이 동작)."""
    sid = secrets.token_urlsafe(18)
    now = int(time.time())
    rec = {
        "user_id": user_id, "ip": ip, "hostname": hostname,
        "ua": ua[:300], "created": now, "last_seen": now, "ttl": ttl,
    }
    try:
        r = await get_redis()
        await r.setex(_SESS + sid, ttl, json.dumps(rec))
        await r.sadd(_USESS + user_id, sid)
        await r.expire(_USESS + user_id, _USET_TTL)
    except Exception as e:
        logger.warning("[sessions] create failed (fail-open): %s", e)
    return sid


async def get_session(sid: str) -> dict | None:
    """세션 레코드 조회. (None=취소/만료).  Redis 장애는 예외로 전파(호출측 fail-open 판단)."""
    r = await get_redis()
    v = await r.get(_SESS + sid)
    return json.loads(v) if v else None


async def touch_session(sid: str, rec: dict, ip: str) -> None:
    """last_seen/ip 갱신 + TTL 슬라이딩. _TOUCH_INTERVAL 이내면 스킵."""
    try:
        now = int(time.time())
        if now - int(rec.get("last_seen", 0)) < _TOUCH_INTERVAL and ip == rec.get("ip"):
            return
        rec["last_seen"] = now
        if ip:
            rec["ip"] = ip
        ttl = int(rec.get("ttl") or 86400)
        r = await get_redis()
        await r.setex(_SESS + sid, ttl, json.dumps(rec))
    except Exception as e:
        logger.debug("[sessions] touch failed: %s", e)


async def revoke_session(sid: str) -> bool:
    """단일 세션(기기) 원격 로그아웃."""
    try:
        r = await get_redis()
        rec = await get_session(sid)
        await r.delete(_SESS + sid)
        if rec and rec.get("user_id"):
            await r.srem(_USESS + rec["user_id"], sid)
        ok = True
    except Exception as e:
        logger.warning("[sessions] revoke failed: %s", e)
        rec, ok = None, False
    # OIDC Back-Channel Logout — 이 세션으로 로그인한 외부 RP 에도 알린다(비동기, 실패 무시).
    await _bcl().on_session_revoked(sid, (rec or {}).get("user_id"))
    return ok


async def revoke_user_sessions(user_id: str) -> int:
    """해당 유저의 레지스트리 세션 전부 삭제 (token_version 증가와 병행 사용)."""
    try:
        r = await get_redis()
        sids = await r.smembers(_USESS + user_id)
        if sids:
            await r.delete(*[_SESS + s for s in sids])
        await r.delete(_USESS + user_id)
        n = len(sids)
    except Exception as e:
        logger.warning("[sessions] revoke_user failed: %s", e)
        n = 0
    await _bcl().on_user_revoked(user_id)
    return n


async def revoke_all_sessions() -> int:
    """전체 레지스트리 정리 (logout-all 시 token_version 일괄 증가와 병행)."""
    try:
        r = await get_redis()
        n = 0
        async for key in r.scan_iter(match=_SESS + "*", count=500):
            await r.delete(key)
            n += 1
        async for key in r.scan_iter(match=_USESS + "*", count=500):
            await r.delete(key)
    except Exception as e:
        logger.warning("[sessions] revoke_all failed: %s", e)
        n = 0
    await _bcl().on_all_revoked()
    return n


async def list_user_sessions(user_id: str) -> list[dict]:
    """유저의 활성 세션 목록 (IP/hostname/UA/last_seen). 만료된 sid는 set에서 정리."""
    r = await get_redis()
    sids = await r.smembers(_USESS + user_id)
    out: list[dict] = []
    stale: list[str] = []
    for sid in sids:
        rec = await get_session(sid)
        if rec:
            out.append({**rec, "sid": sid})
        else:
            stale.append(sid)
    if stale:
        await r.srem(_USESS + user_id, *stale)
    out.sort(key=lambda x: x.get("last_seen", 0), reverse=True)
    return out
