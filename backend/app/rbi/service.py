"""격리 브라우저 서비스 — 대상 권한 · 세션 수명(시작/종료/정리) · 스트림 인증 · 일회용 값 저장.

세션 흐름
  POST /api/rbi/sessions ─► 권한 ─► 격리 규칙(guard) 확인 ─► 네트워크 보장 ─► 컨테이너 create/cp/start
  ─► 게시 포트 ─► KasmVNC 응답 대기 ─► running. 실패 시 컨테이너를 삭제하고 error 로 기록한다.
  ws-nginx(rbi 전용 출처 server 블록)의 /rbi/<sid>/ 는 auth_request 로 /api/internal/rbi/auth 를 호출하고, 여기서 소유자 여부를 확인하여
  업스트림 주소와 basic auth 헤더를 반환한다. 사용자 브라우저에는 VNC 비밀번호가 전달되지 않는다.
정리(reaper, 30초): 컨테이너가 종료되었으면 ended · 최대 수명 경과 시 종료 · 핑이 끊기고 뷰어도 없으면 유휴 종료 · 고아 컨테이너 제거.
접근 회수(enforce_access): 대상이 비활성화되거나 삭제됨 · 허용 사용자/그룹에서 제외됨 · 계정이 비활성/삭제되면 열려 있는 세션도 종료한다.
  관리자 대상 API 는 저장 직후 즉시, 그 외 경로(그룹 멤버·모듈 권한·계정 상태 변경)는 정리 작업이 30초 이내에 처리한다.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.mail.crypto import decrypt_password, encrypt_password
from app.rbi import docker as dk
from app.rbi import egress as eg
from app.rbi import policy as pol
from app.rbi.models import RbiSession, RbiTarget

logger = logging.getLogger(__name__)

ACTIVE = ("starting", "running")
#: 핑(last_seen)이 끊긴 뒤 뷰어도 없을 때 유휴로 판정하는 유예 시간(분) — KasmVNC 자체 자동 종료가 먼저 동작하는 것이 정상
IDLE_GRACE_MIN = 2
#: 세션 시작 시 netfilter 하트비트가 ok 로 전환되기를 대기하는 최대 시간(초) — 브리지를 방금 생성한 경우
GUARD_WAIT_SECONDS = 15.0


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite 는 tz 를 보존하지 않는다 — 비교 전에 UTC 로 정규화한다."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _loads(s: str | None) -> list:
    try:
        v = json.loads(s or "[]")
        return v if isinstance(v, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


# ── 대상 ──

def target_mode(t: RbiTarget) -> str:
    """대상의 화면 방식(이전 행은 NULL → pixel)."""
    return t.mode if t.mode in pol.MODES else "pixel"


def session_mode(s: RbiSession) -> str:
    return s.mode if s.mode in pol.MODES else "pixel"


def target_policy(t: RbiTarget) -> pol.TargetPolicy:
    return pol.TargetPolicy(
        url=t.url, allowed_hosts=_loads(t.allowed_hosts),
        clipboard_to_browser=t.clipboard_to_browser, clipboard_from_browser=t.clipboard_from_browser,
        downloads=t.downloads, uploads=t.uploads, idle_minutes=t.idle_minutes, max_hours=t.max_hours,
        cpu=t.cpu, memory_mb=t.memory_mb, mode=target_mode(t),
    )


def allowed_modes(t: RbiTarget) -> list[str]:
    """사용자가 이 대상을 열 수 있는 방식 — mirror 대상은 pixel 로도 가능(fallback), pixel 대상은 pixel 만 가능."""
    return ["mirror", "pixel"] if target_mode(t) == "mirror" else ["pixel"]


def target_dict(t: RbiTarget, *, admin: bool = False) -> dict:
    d = {
        "id": t.id, "key": t.key, "name": t.name, "url": t.url, "host": pol.target_host(t.url),
        "enabled": t.enabled,
        "mode": target_mode(t),
        "modes": allowed_modes(t),
        "policy": {
            "clipboard_to_browser": t.clipboard_to_browser,
            "clipboard_from_browser": t.clipboard_from_browser,
            "downloads": t.downloads, "uploads": t.uploads,
            "idle_minutes": t.idle_minutes, "max_hours": t.max_hours,
        },
    }
    if admin:
        d.update({
            "allowed_hosts": _loads(t.allowed_hosts),
            "cpu": t.cpu, "memory_mb": t.memory_mb,
            "allowed_group_ids": _loads(t.allowed_group_ids),
            "allowed_user_ids": _loads(t.allowed_user_ids),
            "private_ip": pol.target_is_private_ip(t.url),
            "extra_ports": _loads(t.extra_ports),
            "egress": [e.as_dict() for e in eg.load_entries(t.egress)],
            "egress_forced": bool(t.egress_forced),
            "created_at": _aware(t.created_at).isoformat() if t.created_at else None,
            "updated_at": _aware(t.updated_at).isoformat() if t.updated_at else None,
        })
    return d


async def list_targets(db: AsyncSession) -> list[RbiTarget]:
    return list((await db.execute(select(RbiTarget).order_by(RbiTarget.created_at))).scalars().all())


async def get_target(db: AsyncSession, target_id: str) -> RbiTarget | None:
    return await db.get(RbiTarget, target_id)


def _base_host(url: str | None) -> str | None:
    if not url:
        return None
    from urllib.parse import urlsplit
    u = urlsplit(url)
    return f"{u.hostname}:{u.port}" if u.port else (u.hostname or None)


def apply_target_fields(t: RbiTarget, data: dict, *, creating: bool) -> None:
    """관리자 입력을 검증해 모델에 반영한다(ValueError 는 400)."""
    if creating or "key" in data:
        t.key = pol.validate_key(data.get("key") or "")
    if creating or "name" in data:
        name = (data.get("name") or "").strip()
        if not name or len(name) > 100:
            raise ValueError("이름은 1~100자")
        t.name = name
    old_base = None if creating else _base_host(t.url)
    if creating or "url" in data:
        t.url = pol.normalize_url(data.get("url") or "")
    if not creating and "url" in data and "allowed_hosts" not in data and old_base != _base_host(t.url):
        # 주소만 변경된 경우 — 이전 주소의 호스트를 허용 목록에서 제거하고 새 주소의 호스트로 대체한다(잔존 시 Chromium·출구에 이전 호스트가 남는다)
        rest = [h for h in _loads(t.allowed_hosts) if h != old_base]
        t.allowed_hosts = json.dumps(pol.normalize_hosts(rest, t.url))
    if creating or "allowed_hosts" in data:
        hosts = data.get("allowed_hosts") or []
        if not isinstance(hosts, list):
            raise ValueError("allowed_hosts 는 목록")
        t.allowed_hosts = json.dumps(pol.normalize_hosts([str(h) for h in hosts], t.url))
    for k in ("enabled", "clipboard_to_browser", "clipboard_from_browser", "downloads", "uploads"):
        if k in data:
            setattr(t, k, bool(data[k]))
    if creating or "mode" in data:
        t.mode = pol.validate_mode(data.get("mode"))
    if "idle_minutes" in data:
        v = int(data["idle_minutes"])
        if not (1 <= v <= 240):
            raise ValueError("유휴 시간은 1~240분")
        t.idle_minutes = v
    if "max_hours" in data:
        v = int(data["max_hours"])
        if not (1 <= v <= 24):
            raise ValueError("최대 수명은 1~24시간")
        t.max_hours = v
    if "cpu" in data:
        v = float(data["cpu"])
        if not (0.5 <= v <= 8):
            raise ValueError("CPU 는 0.5~8")
        t.cpu = v
    if "memory_mb" in data:
        v = int(data["memory_mb"])
        if not (512 <= v <= 8192):
            raise ValueError("메모리는 512~8192MB")
        t.memory_mb = v
    if creating or "extra_ports" in data:
        t.extra_ports = json.dumps(eg.validate_extra_ports(data.get("extra_ports") or []))
    for k in ("allowed_group_ids", "allowed_user_ids"):
        if k in data:
            ids = data[k] or []
            if not isinstance(ids, list) or not all(isinstance(i, str) and len(i) <= 36 for i in ids):
                raise ValueError(f"{k} 는 ID 목록")
            setattr(t, k, json.dumps(sorted(set(ids))))


async def refresh_egress(t: RbiTarget, *, force: bool = False) -> list[str]:
    """주소·허용 호스트·추가 포트가 확정된 뒤 호출 — 출구를 검증·고정하여 t.egress 에 저장한다. 경고 목록을 반환한다(ValueError 는 400)."""
    entries, warnings = await eg.compute_egress(t.url, _loads(t.allowed_hosts), _loads(t.extra_ports), force=force)
    t.egress = eg.dump_entries(entries)
    t.egress_forced = any(e.forced for e in entries)
    return warnings


async def user_can_use(db: AsyncSession, user, t: RbiTarget) -> bool:
    """관리자 · 허용 사용자 · 허용 그룹 멤버만 허용. 둘 다 비어 있으면 관리자만(모듈 grant 와 달리 기본 거부)."""
    if getattr(user, "is_admin", False):
        return True
    if not t.enabled:
        return False
    if user.id in _loads(t.allowed_user_ids):
        return True
    groups = set(_loads(t.allowed_group_ids))
    if not groups:
        return False
    from app.groups.service import user_group_ids
    return bool(groups & await user_group_ids(db, user.id))


# ── 세션 ──

def basic_auth_header(password: str, mode: str = "pixel") -> str:
    """세션 컨테이너가 수신하는 Authorization — 픽셀은 KasmVNC 의 kasm_user, 미러는 mirror-agent 의 mirror(값 자체를 비교한다)."""
    user = "mirror" if mode == "mirror" else "kasm_user"
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def session_dict(s: RbiSession, target: RbiTarget | None = None) -> dict:
    started = _aware(s.started_at)
    return {
        "id": s.id,
        "status": s.status,
        "mode": session_mode(s),
        "modes": allowed_modes(target) if target else [session_mode(s)],
        "target_id": s.target_id,
        "target_key": s.target_key,
        "target_name": target.name if target else s.target_key,
        "target_url": target.url if target else None,
        "stream_url": f"/rbi/{s.id}/" if s.status == "running" else None,
        "started_at": started.isoformat() if started else None,
        "expires_at": (started + timedelta(hours=s.max_hours)).isoformat() if started else None,
        "idle_minutes": s.idle_minutes,
        "max_hours": s.max_hours,
        "last_seen_at": _aware(s.last_seen_at).isoformat() if s.last_seen_at else None,
        "ended_at": _aware(s.ended_at).isoformat() if s.ended_at else None,
        "end_reason": s.end_reason,
        "error": s.error,
    }


async def active_sessions(db: AsyncSession, user_id: str | None = None) -> list[RbiSession]:
    q = select(RbiSession).where(RbiSession.status.in_(ACTIVE)).order_by(RbiSession.started_at.desc())
    if user_id:
        q = q.where(RbiSession.user_id == user_id)
    return list((await db.execute(q)).scalars().all())


async def recent_sessions(db: AsyncSession, limit: int = 50, user_id: str | None = None) -> list[RbiSession]:
    q = select(RbiSession).order_by(RbiSession.started_at.desc()).limit(limit)
    if user_id:
        q = q.where(RbiSession.user_id == user_id)
    return list((await db.execute(q)).scalars().all())


class SessionStartError(RuntimeError):
    def __init__(self, msg: str, status: int = 503):
        super().__init__(msg)
        self.status = status


async def _preflight(wait: float | None = None) -> dk.GuardState:
    """netfilter 하트비트가 ok 인 경우에만 통과. 브리지를 방금 생성한 경우 사이드카가 반영할 때까지(5초 주기) 단시간 대기한다."""
    deadline = asyncio.get_running_loop().time() + (GUARD_WAIT_SECONDS if wait is None else wait)
    while True:
        g = dk.read_guard_state()
        if g.ok:
            return g
        if asyncio.get_running_loop().time() >= deadline:
            raise SessionStartError(f"격리 규칙이 확인되지 않아 세션을 시작하지 않습니다 — {g.reason}", 503)
        await asyncio.sleep(1.0)


async def _await_target_allowed(t: RbiTarget, wait: float | None = None) -> None:
    """이 대상의 출구가 사이드카에 실제로 적용되었는지 여부(하트비트의 allow) — 방금 추가한 대상이면 다음 주기(기본 5초)까지 대기한다.
    빈 출구(이전 행·검증 실패)도 시작하지 않는다 — 차단된 화면 대신 사유를 통지한다."""
    want = {e.line() for e in eg.load_entries(t.egress)}
    if not want:
        raise SessionStartError("이 대상의 출구(허용 목적지)가 정해지지 않았습니다 — 관리 › 격리 브라우저에서 대상을 다시 저장하세요", 503)
    if not get_settings().rbi_require_guard:
        return
    deadline = asyncio.get_running_loop().time() + (GUARD_WAIT_SECONDS if wait is None else wait)
    while True:
        g = dk.read_guard_state()
        if g.ok and want <= set(g.allow or []):
            return
        if asyncio.get_running_loop().time() >= deadline:
            missing = sorted(want - set(g.allow or []))
            raise SessionStartError(f"격리 규칙이 아직 이 대상을 허용하지 않습니다({', '.join(missing)}) — 잠시 뒤 다시 시도하세요", 503)
        await asyncio.sleep(1.0)


async def start_session(db: AsyncSession, user, t: RbiTarget, client_ip: str | None, mode: str | None = None) -> RbiSession:
    """세션 하나를 기동한다. 동일 사용자의 활성 세션이 있으면 해당 세션을 반환한다(컨테이너는 사용자당 1개).

    mode: 사용자가 선택한 화면 방식(없으면 대상 기본값). mirror 대상은 pixel 로도 열 수 있다(fallback) — pixel 대상은 mirror 로 열 수 없다.
    """
    s_cfg = get_settings()
    want = pol.validate_mode(mode) if mode else target_mode(t)
    if want not in allowed_modes(t):
        raise SessionStartError("이 대상은 미러 모드로 열 수 없습니다(관리자가 정한 방식만)", 400)
    existing = await active_sessions(db, user.id)
    for e in existing:
        if e.target_id == t.id:
            return e
    if existing:
        raise SessionStartError("이미 다른 대상의 격리 브라우저가 열려 있습니다. 먼저 끝내 주세요", 409)
    if len(await active_sessions(db)) >= s_cfg.rbi_max_sessions:
        raise SessionStartError(f"동시 세션 상한({s_cfg.rbi_max_sessions})에 닿았습니다. 잠시 뒤 다시 시도하세요", 429)

    # 네트워크(브리지)를 먼저 보장한다 — 사이드카는 브리지가 있어야 규칙을 적용하고 하트비트를 ok 로 전환한다
    try:
        await dk.ensure_network()
    except dk.DockerError as e:
        raise SessionStartError(str(e), 503)
    await _preflight()
    await _await_target_allowed(t)

    sid = secrets.token_hex(16)
    pw = secrets.token_urlsafe(24)
    tp = target_policy(t)
    name = f"{s_cfg.rbi_container_prefix}{sid[:12]}"
    sess = RbiSession(
        id=sid, user_id=user.id, target_id=t.id, target_key=t.key, status="starting", mode=want,
        container_name=name, vnc_password_enc=encrypt_password(pw),
        idle_minutes=t.idle_minutes, max_hours=t.max_hours, client_ip=client_ip,
        started_at=_now(), last_seen_at=_now(),
    )
    db.add(sess)
    await db.commit()

    if want == "mirror":
        args = pol.mirror_docker_create_args(
            name=name, network=s_cfg.rbi_network, publish_ip=s_cfg.rbi_publish_ip, image=s_cfg.rbi_mirror_image,
            env=pol.mirror_container_env(tp, sid=sid, auth_header=basic_auth_header(pw, "mirror")), cpu=tp.cpu, memory_mb=tp.memory_mb,
            add_hosts=eg.add_host_args(eg.load_entries(t.egress)),
        )
    else:
        args = pol.docker_create_args(
            name=name, network=s_cfg.rbi_network, publish_ip=s_cfg.rbi_publish_ip, image=s_cfg.rbi_image,
            env=pol.container_env(tp, pw), cpu=tp.cpu, memory_mb=tp.memory_mb,
            add_hosts=eg.add_host_args(eg.load_entries(t.egress)),
        )
    try:
        cid = await dk.create_session_container(args)
        sess.container_id = cid
        await db.commit()
        upstream = await dk.published_upstream(cid)
        sess.upstream = upstream
        await db.commit()
        if not await dk.wait_ready(cid):
            running, code = await dk.container_state(cid)
            what = "미러 에이전트" if want == "mirror" else "KasmVNC"
            raise dk.DockerError(f"{what} 가 45초 안에 듣기 시작하지 않았습니다" if running else f"세션 컨테이너가 바로 끝났습니다(exit {code})")
        sess.status = "running"
        sess.last_seen_at = _now()
        await db.commit()
        logger.info("[rbi] session %s (%s) started for user %s → %s (%s)", sid[:8], want, user.id, t.key, upstream)
        return sess
    except Exception as e:  # noqa: BLE001
        logger.error("[rbi] session %s start failed: %s", sid[:8], e)
        if sess.container_id:
            await dk.remove_container(sess.container_id)
        sess.status = "error"
        sess.error = str(e)[:500]
        sess.ended_at = _now()
        sess.end_reason = "error"
        await db.commit()
        raise SessionStartError(f"격리 브라우저를 시작하지 못했습니다: {str(e)[:200]}", 503)


async def switch_mode(db: AsyncSession, user, sess: RbiSession, t: RbiTarget, mode: str, client_ip: str | None) -> RbiSession:
    """화면 방식 전환(미러 ↔ 픽셀) — 세션 컨테이너의 이미지가 상이하므로 현재 세션을 종료하고 동일 대상으로 새로 연다.
    격리 브라우저 내부 상태(로그인 등)는 유지되지 않는다 — 화면에서 사전 안내한다."""
    want = pol.validate_mode(mode)
    if want not in allowed_modes(t):
        raise SessionStartError("이 대상은 미러 모드로 열 수 없습니다(관리자가 정한 방식만)", 400)
    if session_mode(sess) == want and sess.status in ACTIVE:
        return sess
    await stop_session(db, sess, "mode_switch")
    return await start_session(db, user, t, client_ip, mode=want)


async def stop_session(db: AsyncSession, sess: RbiSession, reason: str) -> None:
    if sess.container_id:
        await dk.remove_container(sess.container_id)
    if sess.status in ACTIVE:
        sess.status = "ended"
        sess.ended_at = _now()
        sess.end_reason = reason
        await db.commit()
    logger.info("[rbi] session %s ended (%s)", sess.id[:8], reason)


# ── 접근 회수 — 이미 열린 세션에도 권한 변경을 적용 ──

async def access_denied_reason(db: AsyncSession, sess: RbiSession) -> str | None:
    """세션 소유자가 현재도 이 대상을 사용할 수 있으면 None, 아니면 사유(감사 로그용).

    module_disabled | user_removed | user_inactive | target_removed | target_disabled | module_revoked | access_revoked
    세션 시작 시 확인하는 항목(모듈 rbi 활성 · 계정 활성 · 모듈 rbi 그룹 권한 · 대상 활성 · 허용 사용자/그룹)을 동일하게 재확인한다.
    비활성 대상은 관리자 세션도 종료한다 — 출구(netfilter 허용)가 함께 제거되어 어차피 화면이 차단된다.
    """
    from app.db.models import SystemSetting, User
    from app.modules import registry
    # 모듈 자체를 비활성화한 경우 관리자 세션까지 전부 대상 — require_module 과 동일하게 DB 값이 권위 출처(워커마다 메모리 값이 상이할 수 있다)
    enabled = registry.is_module_enabled("rbi")
    raw = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == registry._module_key("rbi")))
    if raw is not None:
        try:
            enabled = bool(json.loads(raw))
        except (TypeError, json.JSONDecodeError):
            pass
    if not enabled:
        return "module_disabled"
    user = await db.get(User, sess.user_id)
    if user is None:
        return "user_removed"
    if not user.is_active:
        return "user_inactive"
    t = await db.get(RbiTarget, sess.target_id)
    if t is None:
        return "target_removed"
    if not t.enabled:
        return "target_disabled"
    if not user.is_admin:
        try:
            from app.groups.service import user_can_access
            if not await user_can_access(db, user.id, "rbi", False):
                return "module_revoked"
        except Exception as e:  # noqa: BLE001 — require_module 과 동일하게 권한 시스템 오류로는 차단하지 않는다
            logger.warning("[rbi] module grant check failed (keep): %s", e)
    if not await user_can_use(db, user, t):
        return "access_revoked"
    return None


async def enforce_access(
    db: AsyncSession, *, target_id: str | None = None, user_id: str | None = None,
    actor_id: str | None = None, ip: str | None = None,
) -> list[RbiSession]:
    """활성 세션(대상·사용자로 한정 가능)의 권한을 재확인하고, 권한을 상실한 세션을 종료한다. 종료한 세션 목록을 반환한다.

    종료 경로는 stop_session 과 동일하다(컨테이너 삭제 → 스트림 연결 종료 → 화면은 다음 상태 확인에서 종료를 인지한다).
    end_reason 은 관리자 강제 종료와 동일한 "admin" — 화면이 "관리자가 접근을 종료했습니다" 를 표시한다. 구체 사유는 감사 로그에 기록한다.
    """
    from app.admin import audit
    ended: list[RbiSession] = []
    for s in await active_sessions(db, user_id):
        if target_id and s.target_id != target_id:
            continue
        cause = await access_denied_reason(db, s)
        if cause is None:
            continue
        await stop_session(db, s, "admin")
        ended.append(s)
        await audit.log_action(db, actor_id, "rbi.session.stop", "rbi_session", s.id,
                               {"target": s.target_key, "by_owner": False, "owner": s.user_id, "cause": cause}, ip)
    return ended


async def enforce_access_quietly(db: AsyncSession, **kw) -> None:
    """계정·그룹 측 코드가 자체 커밋 직후에 호출하는 진입점 — 실패해도 본 동작(정지·삭제·멤버 제거)을 500 으로 만들지 않는다.
    여기서 종료하지 못한 세션은 정리 작업(reaper, 30초)이 다시 처리한다."""
    try:
        await enforce_access(db, **kw)
    except Exception as e:  # noqa: BLE001
        logger.warning("[rbi] enforce_access failed (reaper will retry): %s", e)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass


#: 스트림 인증(nginx auth_request — 자산 요청마다 호출된다)의 권한 재확인 결과를 세션별로 단시간 캐시한다(프로세스 메모리).
#: 회수가 스트림에 반영되는 지연은 이 시간 이내 — 그 사이에도 대상 API·계정·그룹 훅과 정리 작업(reaper)이 컨테이너를 삭제한다.
STREAM_ACCESS_TTL = 5.0
_stream_access_cache: dict[str, tuple[float, bool]] = {}


async def stream_access_denied(db: AsyncSession, sess: RbiSession) -> bool:
    """스트림 허용 여부의 반대값 — access_denied_reason 을 STREAM_ACCESS_TTL 초 캐시로 래핑한다."""
    now = time.monotonic()
    hit = _stream_access_cache.get(sess.id)
    if hit and hit[0] > now:
        return hit[1]
    denied = (await access_denied_reason(db, sess)) is not None
    if len(_stream_access_cache) > 256:   # 종료된 세션의 항목이 누적되지 않도록 함
        for k in [k for k, v in _stream_access_cache.items() if v[0] <= now]:
            _stream_access_cache.pop(k, None)
    _stream_access_cache[sess.id] = (now + STREAM_ACCESS_TTL, denied)
    return denied


async def touch(db: AsyncSession, sess: RbiSession) -> None:
    sess.last_seen_at = _now()
    await db.commit()


# ── 스트림 인증(ws-nginx auth_request) ──

#: 미러 에이전트 경로(nginx 미러 location 과 동일한 정규식) — 미러 세션은 이 경로만, 픽셀 세션은 이 경로 외만 허용
MIRROR_PATH_RE = re.compile(r"^/rbi/[0-9a-f]{32}/(view|mirror|asset/[0-9a-f]{64}|font/[a-z0-9-]{1,64}\.woff2|download/[0-9a-f]{32}|upload/[0-9a-f]{32})$")


def path_allowed(sess: RbiSession, uri: str) -> bool:
    """세션 방식과 경로의 일치 여부 — 픽셀 세션으로 미러 경로를, 미러 세션으로 KasmVNC 경로를 요청하지 못하도록 한다(상호 혼용 방지)."""
    path = uri.split("?", 1)[0]
    is_mirror = bool(MIRROR_PATH_RE.match(path))
    return is_mirror if session_mode(sess) == "mirror" else not is_mirror


def stream_auth(sess: RbiSession, user_id: str) -> tuple[str, str] | None:
    """소유자이고 running 이면 (upstream, Authorization 헤더 값)을 반환한다. 아니면 None."""
    if sess.status != "running" or sess.user_id != user_id or not sess.upstream:
        return None
    return sess.upstream, basic_auth_header(decrypt_password(sess.vnc_password_enc), session_mode(sess))


# ── 일회용 값(Redis) — rbi 출처 SSO 코드(app/rbi/site.py) ──
# 이전의 "입장 티켓 → 경로 한정 쿠키(ws_rbi_<sid>)" 는 rbi 전용 출처로 이전하면서 제거했다(해당 출처의 세션 쿠키가 스트림 경로까지 포함한다).
# 1회만 조회되는 저장 방식(SET NX EX + GETDEL)은 SSO 코드에 그대로 사용한다.

async def put_once(key: str, payload: dict, ttl: int) -> None:
    from app.chat.redis_client import get_redis
    r = await get_redis()
    await r.set(key, json.dumps(payload), ex=ttl, nx=True)


async def take_once(key: str) -> dict | None:
    """값을 1회만 사용한다 — GETDEL 로 조회하는 즉시 삭제된다."""
    from app.chat.redis_client import get_redis
    r = await get_redis()
    try:
        raw = await r.getdel(key)
    except Exception:  # noqa: BLE001 — 구버전 Redis(GETDEL 없음)
        raw = await r.get(key)
        if raw:
            await r.delete(key)
    if not raw:
        return None
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else None
    except (TypeError, json.JSONDecodeError):
        return None


# ── 정리(reaper) ──

async def reap_once(db: AsyncSession) -> dict:
    """활성 세션을 1회 순회 점검한다. 반환값은 로그·테스트용 집계."""
    stats = {"checked": 0, "ended": 0, "orphans": 0, "revoked": 0}
    now = _now()
    live_cids: set[str] = set()
    # 고아 판정에는 컨테이너 이름도 사용한다 — 세션 행은 컨테이너보다 먼저 생성되며 이름이 이미 확정되어 있다.
    # container_id 만 확인하면 `docker create` 와 container_id 커밋 사이에 실행되는 정리가 방금 생성한 컨테이너를 삭제한다.
    live_names: set[str] = set()
    sessions = await active_sessions(db)
    for s in sessions:
        stats["checked"] += 1
        if s.container_name:
            live_names.add(s.container_name)
        started = _aware(s.started_at) or now
        if not s.container_id:
            # starting 상태이나 컨테이너가 없다 — 시작 중인 워커가 보유하는 2분 이내이면 유지한다
            if now - started > timedelta(minutes=2):
                await stop_session(db, s, "error")
                stats["ended"] += 1
            continue
        live_cids.add(s.container_id[:12])
        running, _code = await dk.container_state(s.container_id)
        if not running:
            await stop_session(db, s, "container_exited")
            stats["ended"] += 1
            continue
        if now - started > timedelta(hours=s.max_hours):
            await stop_session(db, s, "max_lifetime")
            stats["ended"] += 1
            continue
        # 권한 재검증 — 그룹 제외·모듈 권한 회수·계정 비활성/삭제처럼 대상 API 를 경유하지 않는 회수를 여기서 처리한다
        try:
            cause = await access_denied_reason(db, s)
        except Exception as e:  # noqa: BLE001 — 확인 실패 시 종료하지 않는다(다음 주기에 재확인)
            logger.warning("[rbi] access recheck failed for %s: %s", str(inspect(s).identity[0])[:8], e)
            cause = None
            # 실패한 트랜잭션을 롤백한다 — 생략 시 동일 순회의 나머지 세션 처리(종료 커밋·조회)가 연쇄 실패한다.
            # rollback 은 로드된 행을 만료시키므로(비동기에서는 속성 접근이 곧 오류) 남은 세션을 다시 조회한다
            await db.rollback()
            for x in sessions:
                await db.refresh(x)
        if cause:
            from app.admin import audit
            await stop_session(db, s, "admin")
            await audit.log_action(db, None, "rbi.session.stop", "rbi_session", s.id,
                                   {"target": s.target_key, "by_owner": False, "owner": s.user_id, "cause": cause})
            stats["ended"] += 1
            stats["revoked"] += 1
            continue
        if s.status == "running":
            seen = _aware(s.last_seen_at) or started
            if now - seen > timedelta(minutes=s.idle_minutes + IDLE_GRACE_MIN):
                viewers = await dk.established_viewers(s.container_id)
                if viewers == 0:
                    await stop_session(db, s, "idle")
                    stats["ended"] += 1
                    continue
    # 고아 컨테이너(DB 에 활성 행이 없는 라벨 컨테이너) 제거 — 본 스택의 이름 접두어(RBI_CONTAINER_PREFIX)에 해당하는 것만.
    # 동일 도커 호스트의 다른 스택(시험 스택·타 설치)의 세션 컨테이너도 동일 라벨을 보유한다 — 타 스택의 컨테이너는 변경하지 않는다
    prefix = get_settings().rbi_container_prefix
    for cid, name in await dk.list_session_containers():
        if not name.lstrip("/").startswith(prefix):
            continue
        if cid[:12] in live_cids or name.lstrip("/") in live_names:
            continue
        # 위 목록 조회 이후에 시작된 세션일 수 있다 — 삭제 직전에 해당 이름의 활성 행이 생성되었는지 재확인한다
        fresh = (await db.execute(
            select(RbiSession.id).where(RbiSession.container_name == name.lstrip("/"), RbiSession.status.in_(ACTIVE))
        )).first()
        if fresh:
            continue
        await dk.remove_container(cid)
        stats["orphans"] += 1
    return stats


async def run_reaper(interval: int = 30) -> None:
    """백그라운드 루프 — 워커 8개 중 하나만 실행(Redis 락)."""
    from app.db.session import async_session
    from app.jobs.lock import try_acquire

    await asyncio.sleep(20)
    while True:
        try:
            if await try_acquire("rbi:reaper", ttl=max(5, interval - 5)):
                async with async_session() as db:
                    st = await reap_once(db)
                    if st["ended"] or st["orphans"]:
                        logger.info("[rbi] reaper: %s", st)
                    # 동적 허용 파일을 DB 와 동기화한다(관리 API 가 즉시 기록하지만, 다른 경로로 DB 가 변경되었거나 파일이 삭제된 경우의 안전망)
                    await eg.sync_allow_file(db)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.error("[rbi] reaper failed: %s", e)
        await asyncio.sleep(interval)


def _public_origin() -> str:
    from app.rbi.site import public_origin
    return public_origin()


async def status_summary(db: AsyncSession) -> dict:
    s = get_settings()
    g = dk.read_guard_state()
    act = await active_sessions(db)
    desired = sorted(eg.allow_set(eg.desired_lines(await list_targets(db))))
    return {
        "image": s.rbi_image,
        "mirror_image": s.rbi_mirror_image,
        "network": s.rbi_network, "subnet": s.rbi_subnet, "bridge": s.rbi_bridge,
        "publish_ip": s.rbi_publish_ip,
        "public_origin": _public_origin(),
        "max_sessions": s.rbi_max_sessions,
        "active_sessions": len(act),
        "guard": {"ok": g.ok, "reason": g.reason, "age": int(g.age) if g.age is not None else None,
                  "allow": g.allow, "rules": g.rules, "required": s.rbi_require_guard,
                  "rejected": g.rejected or [], "allow_rev": g.allow_rev},
        # 동적 허용 목록: DB(활성 대상)가 요구하는 항목 · 사이드카가 실제로 적용한 항목 · 아직 미적용 항목
        "egress": {
            "desired": desired, "pending": sorted(set(desired) - set(g.allow or [])),
            "static": [x.strip() for x in (os.environ.get("RBI_ALLOW") or "").split(",") if x.strip()],
            "ceiling": s.rbi_allow_ceiling or eg.DEFAULT_CEILING, "protected": s.rbi_protected,
            "file": s.rbi_allow_file,
        },
    }
