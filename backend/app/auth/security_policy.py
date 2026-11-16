"""로그인 보호 정책 — 관리 › 보안·SSL 의 "로그인 보호"·"세션" 카드.

SystemSetting(key/value)에 저장한다(별도 테이블 없음):
  auth.require_2fa          off | admins | all   — 2단계 인증 필수 대상
  auth.lockout_enabled      true | false         — 비밀번호 연속 오류 시 잠금
  auth.new_device_alert     true | false         — 기록에 없는 기기에서 로그인 시 메일 알림
  auth.idle_timeout_minutes 0(사용 안 함) | 분   — 해당 시간 동안 요청이 없던 세션은 종료한다

집행 위치
- 잠금: /api/auth/login 이 비밀번호 검증 전에 check_lockout, 실패 시 record_failure.
  계정 기준 LOCKOUT_THRESHOLD 회, IP 기준은 그 IP_FACTOR 배(사무실 NAT 뒤의 여러 사용자가
  동일 IP 로 식별되므로 IP 만으로 즉시 잠그면 무관한 사용자까지 함께 잠긴다).
- 2단계 필수: 로그인은 차단하지 않는다(인증 앱 등록을 위해 로그인이 필요하므로). 대신
  get_current_user 가 등록 전 사용자의 요청을 ALLOW_PREFIXES 밖에서는 403 으로 차단하고,
  프런트엔드가 /api/auth/me 의 totp_setup_required 를 확인하여 설정 › 보안으로 이동시킨다.
- 유휴 로그아웃: get_current_user 가 세션 last_seen 을 확인하여 종료한다.
- 새 기기 알림: 로그인 성공 직후 note_login_device.

get_current_user 는 모든 요청이 경유하는 경로이므로 정책을 프로세스 메모리에 CACHE_TTL 초 캐시한다
(워커 8개 — 변경된 정책의 전파에 최대 CACHE_TTL 초 소요).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

REQUIRE_2FA_VALUES = ("off", "admins", "all")
IDLE_CHOICES = (0, 15, 30, 60, 120, 240, 480)  # 분
LOCKOUT_THRESHOLD = 5
LOCKOUT_MINUTES = 10
IP_FACTOR = 4
KNOWN_DEVICE_TTL = 86400 * 180
CACHE_TTL = 30

DEFAULTS = {
    "require_2fa": "off",
    "lockout_enabled": False,
    "new_device_alert": False,
    "idle_timeout_minutes": 0,
}

# 2단계 등록 전에도 사용할 수 있는 API — 인증 자체(me·2fa·logout·세션·비밀번호)와 개인 설정·공개 설정.
ALLOW_PREFIXES = (
    "/api/auth/",
    "/api/me/prefs",
    "/api/app-config",
    "/api/setup/status",
)

_cache: dict[str, tuple[float, dict]] = {}


def _parse(vals: dict[str, str]) -> dict:
    req = vals.get("auth.require_2fa") or "off"
    try:
        idle = int(vals.get("auth.idle_timeout_minutes") or 0)
    except ValueError:
        idle = 0
    return {
        "require_2fa": req if req in REQUIRE_2FA_VALUES else "off",
        "lockout_enabled": (vals.get("auth.lockout_enabled") or "false") == "true",
        "new_device_alert": (vals.get("auth.new_device_alert") or "false") == "true",
        "idle_timeout_minutes": max(0, idle),
    }


async def get_policy(db: AsyncSession) -> dict:
    from app.admin.settings import get_settings_by_prefix

    return _parse(await get_settings_by_prefix(db, "auth."))


async def get_policy_cached(db: AsyncSession | None = None) -> dict:
    hit = _cache.get("p")
    if hit and time.monotonic() - hit[0] < CACHE_TTL:
        return hit[1]
    try:
        if db is not None:
            pol = await get_policy(db)
        else:
            from app.db.session import async_session

            async with async_session() as s:
                pol = await get_policy(s)
    except Exception as e:  # DB 장애 시 정책 조회 실패로 전체 인증이 중단되지 않도록 기본값 사용
        logger.warning("[security-policy] load failed, using defaults: %s", e)
        pol = dict(DEFAULTS)
    _cache["p"] = (time.monotonic(), pol)
    return pol


def invalidate_cache() -> None:
    _cache.clear()


async def set_policy(db: AsyncSession, *, require_2fa=None, lockout_enabled=None,
                     new_device_alert=None, idle_timeout_minutes=None) -> dict:
    from app.admin.settings import set_setting

    if require_2fa is not None:
        if require_2fa not in REQUIRE_2FA_VALUES:
            raise ValueError("require_2fa 는 off·admins·all 중 하나여야 합니다")
        await set_setting(db, "auth.require_2fa", require_2fa)
    if lockout_enabled is not None:
        await set_setting(db, "auth.lockout_enabled", "true" if lockout_enabled else "false")
    if new_device_alert is not None:
        await set_setting(db, "auth.new_device_alert", "true" if new_device_alert else "false")
    if idle_timeout_minutes is not None:
        if idle_timeout_minutes not in IDLE_CHOICES:
            raise ValueError(f"유휴 로그아웃은 {IDLE_CHOICES} 분 중 하나여야 합니다")
        await set_setting(db, "auth.idle_timeout_minutes", str(idle_timeout_minutes))
    invalidate_cache()
    return await get_policy(db)


# ── 2단계 필수 ─────────────────────────────────────────────


def totp_required_for(pol: dict, user) -> bool:
    req = pol.get("require_2fa") or "off"
    if req == "all":
        return True
    if req == "admins":
        return bool(getattr(user, "is_admin", False))
    return False


def totp_setup_required(pol: dict, user) -> bool:
    """정책상 필수이나 인증 앱이 미등록된 상태."""
    return totp_required_for(pol, user) and not getattr(user, "totp_secret", None)


def path_blocked(path: str) -> bool:
    """2단계 미등록 사용자에게 차단하는 경로 여부(인증·개인 설정 API 밖)."""
    return not any((path or "").startswith(p) for p in ALLOW_PREFIXES)


def totp_setup_blocks(pol: dict, user, path: str) -> bool:
    """본 요청을 2단계 미등록 사유로 차단해야 하는지 여부."""
    return totp_setup_required(pol, user) and path_blocked(path)


# ── 유휴 로그아웃 ───────────────────────────────────────────


def idle_expired(pol: dict, rec: dict | None, now: float | None = None) -> bool:
    minutes = int(pol.get("idle_timeout_minutes") or 0)
    if minutes <= 0 or not isinstance(rec, dict):
        return False
    last = int(rec.get("last_seen") or rec.get("created") or 0)
    if not last:
        return False
    return (now or time.time()) - last > minutes * 60


# ── 잠금 ───────────────────────────────────────────────────


async def _redis():
    from app.chat.redis_client import get_redis

    return await get_redis()


def _ukey(username: str) -> str:
    return "lockout:u:" + hashlib.sha256((username or "").strip().lower().encode()).hexdigest()[:32]


def _ikey(ip: str) -> str:
    return "lockout:ip:" + (ip or "-")


async def check_lockout(pol: dict, username: str, ip: str) -> int:
    """잠금 상태이면 남은 초, 아니면 0. Redis 장애 시 0(fail-open)."""
    if not pol.get("lockout_enabled"):
        return 0
    try:
        r = await _redis()
        u = int(await r.get(_ukey(username)) or 0)
        i = int(await r.get(_ikey(ip)) or 0)
        if u >= LOCKOUT_THRESHOLD:
            return max(1, int(await r.ttl(_ukey(username)) or 1))
        if ip and i >= LOCKOUT_THRESHOLD * IP_FACTOR:
            return max(1, int(await r.ttl(_ikey(ip)) or 1))
    except Exception as e:
        logger.debug("[lockout] check failed (fail-open): %s", e)
    return 0


async def record_failure(pol: dict, username: str, ip: str) -> None:
    if not pol.get("lockout_enabled"):
        return
    ttl = LOCKOUT_MINUTES * 60
    try:
        r = await _redis()
        for k in (_ukey(username), _ikey(ip) if ip else None):
            if not k:
                continue
            n = await r.incr(k)
            if int(n) == 1 or int(await r.ttl(k) or -1) < 0:
                await r.expire(k, ttl)
    except Exception as e:
        logger.debug("[lockout] record failed: %s", e)


async def clear_failures(username: str) -> None:
    try:
        r = await _redis()
        await r.delete(_ukey(username))
    except Exception:
        pass


# ── 2단계 코드 대입 방지 ─────────────────────────────────────
# 로그인 잠금(위)은 비밀번호 실패만 집계하며 관리자가 활성화해야 동작한다. 2단계 코드는 6자리이므로, 비밀번호를
# 아는 공격자가 임시 토큰을 반복 발급받아 대입하면 IP 한도(3/분)만으로는 차단할 수 없다(IP 를 늘리면 선형).
# 계정 기준으로 항상 집계한다 — TWO_FA_MAX_FAILS 회 실패 시 TWO_FA_LOCK_MINUTES 분 동안 2단계 검증을 거부한다.
TWO_FA_MAX_FAILS = 5
TWO_FA_LOCK_MINUTES = 10


def _tfkey(user_id: str) -> str:
    return "2fa:fail:" + str(user_id)


async def check_2fa_lock(user_id: str) -> int:
    """2단계 검증이 잠금 상태이면 남은 초, 아니면 0. Redis 장애 시 0(fail-open)."""
    try:
        r = await _redis()
        if int(await r.get(_tfkey(user_id)) or 0) >= TWO_FA_MAX_FAILS:
            return max(1, int(await r.ttl(_tfkey(user_id)) or 1))
    except Exception as e:
        logger.debug("[2fa-lock] check failed (fail-open): %s", e)
    return 0


async def record_2fa_failure(user_id: str) -> None:
    try:
        r = await _redis()
        k = _tfkey(user_id)
        n = await r.incr(k)
        if int(n) == 1 or int(await r.ttl(k) or -1) < 0:
            await r.expire(k, TWO_FA_LOCK_MINUTES * 60)
    except Exception as e:
        logger.debug("[2fa-lock] record failed: %s", e)


async def clear_2fa_failures(user_id: str) -> None:
    try:
        r = await _redis()
        await r.delete(_tfkey(user_id))
    except Exception:
        pass


# ── 새 기기 알림 ────────────────────────────────────────────


def device_fingerprint(ua: str, ip: str) -> str:
    """브라우저·OS·앱 + IP 의 앞 세 자리(/24). 동일 사무실 내 IP 변동은 동일 기기로 간주한다."""
    from app.auth.me_sessions import parse_ua

    p = parse_ua(ua or "")
    net = ".".join((ip or "").split(".")[:3]) if "." in (ip or "") else (ip or "")[:19]
    raw = f"{p.get('browser')}|{p.get('os')}|{p.get('app')}|{net}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


async def note_login_device(pol: dict, user, ua: str, ip: str) -> bool:
    """로그인 기기를 기록하고, 기록에 없는 기기이며 알림이 활성화된 경우 메일을 송신한다.

    최초 로그인(기록이 전혀 없음)은 알리지 않는다. 반환: 새 기기 알림 송신 여부.
    """
    fp = device_fingerprint(ua, ip)
    key = f"knowndev:{user.id}"
    try:
        r = await _redis()
        known = await r.smembers(key)
        known = {k.decode() if isinstance(k, bytes) else k for k in (known or set())}
        await r.sadd(key, fp)
        await r.expire(key, KNOWN_DEVICE_TTL)
    except Exception as e:
        logger.debug("[new-device] redis failed: %s", e)
        return False
    if not known or fp in known or not pol.get("new_device_alert"):
        return False
    to = getattr(user, "recovery_email", None) or getattr(user, "email", None)
    if not to:
        return False
    asyncio.create_task(_send_new_device_mail(to, user.username, ua, ip))
    return True


async def _send_new_device_mail(to: str, username: str, ua: str, ip: str) -> None:
    from email.mime.text import MIMEText

    from app.admin.settings import get_smtp_config, send_system_email
    from app.auth.me_sessions import parse_ua
    from app.config import get_settings
    from app.db.session import async_session

    s = get_settings()
    p = parse_ua(ua or "")
    device = " · ".join(x for x in (p.get("browser"), p.get("os")) if x) or "알 수 없는 기기"
    when = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    body = (
        f"{username} 계정이 새 기기에서 로그인했습니다.\n\n"
        f"기기: {device}\nIP: {ip or '-'}\n시각: {when}\n\n"
        f"본인이 아니라면 {s.app_url.rstrip('/')}/settings/security 에서 그 기기를 로그아웃하고 "
        f"비밀번호를 변경하십시오."
    )
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = f"[{s.app_name}] 새 기기 로그인 알림"
    msg["To"] = to
    try:
        async with async_session() as db:
            cfg = await get_smtp_config(db)
        msg["From"] = cfg.from_addr
        await asyncio.to_thread(send_system_email, cfg, msg)
    except Exception as e:
        logger.warning("[new-device] mail failed: %s", e)
