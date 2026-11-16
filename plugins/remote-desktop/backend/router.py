"""원격 데스크톱 플러그인 API — /api/plugins/remote-desktop/*(로더가 manifest api_prefix 로 등록한다).

인증 방식 세 가지:
- 회원(세션 쿠키 또는 데스크톱 앱 OAuth Bearer) — 기기 관리·접속 요청·코드 입력·뷰어 토큰
- 호스트(X-Remote-Host: <기기 id>:<호스트 비밀>) — 내 기기 앱의 롱폴링·동의·종료
- 지원 프로그램(X-Remote-Support: <세션 id>:<호스트 비밀>) — 포터블 1회성 지원(계정 없음)

규칙(타 원격 도구의 사고 사례에서 도출 — plugins/remote-desktop/README.md):
- 단말은 포트를 개방하지 않는다. 비밀번호가 아닌 회원 권한·호스트 비밀·1회용 코드로만 접속한다.
- 모든 접속은 화면 앞 사용자의 동의를 거친다(내 기기의 "무인 접속"은 소유자 본인 요청 + 앱·서버 양쪽 동의일 때만 자동).
- 접속 코드는 HMAC 만 저장하며 5분·1회로 제한한다. 발급·입력 모두 레이트리밋을 적용한다.
- 모든 단계를 remote_audit 에 기록한다.
"""
# 주의: from __future__ import annotations 를 추가하지 않는다 — FastAPI 가 Pydantic 본문 모델을 쿼리로 오인한다.
import asyncio
import hmac
import importlib.util
import json
import logging
import sys
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.sessions import client_ip
from app.config import get_settings
from app.db.models import SystemSetting, User
from app.db.session import engine, get_db
from app.meetings import livekit as lk
from app.modules.registry import require_module
from app.rate_limit import limiter


def _load_sibling(mod_name: str, file_name: str):
    """플러그인 로더는 router.py 를 경로로 로드한다(패키지 아님) → 인접 파일도 경로로 로드한다."""
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(mod_name, Path(__file__).with_name(file_name))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


_models = _load_sibling("plugin_remote-desktop_models", "models.py")  # 로더가 이미 로드했으면 해당 모듈 사용
svc = _load_sibling("plugin_remote-desktop_service", "service.py")
PluginBase = _models.PluginBase
RemoteAudit, RemoteDevice, RemoteSession = _models.RemoteAudit, _models.RemoteDevice, _models.RemoteSession

logger = logging.getLogger(__name__)
settings = get_settings()
MODULE = "remote-desktop"
_tables_ready = False


async def _ensure_tables() -> None:
    """플러그인 테이블은 코어 init_db 의 대상이 아니다 — 첫 요청 시 1회 생성한다(sample-notes 와 동일한 방식)."""
    global _tables_ready
    if not _tables_ready:
        async with engine.begin() as conn:
            await conn.run_sync(PluginBase.metadata.create_all)
        _tables_ready = True


router = APIRouter(dependencies=[Depends(_ensure_tables)])
POLL_MAX = 25          # 롱폴링 최대 대기(초) — nginx proxy_read_timeout 60s 보다 짧게 설정
POLL_STEP = 1.0
JOIN_FAIL_LIMIT = 10   # 회원 1명이 10분 내에 오류 코드를 이 횟수만큼 입력하면 일시 차단
JOIN_FAIL_WINDOW = timedelta(minutes=10)


# ─── 공통 ───

async def _audit(db: AsyncSession, request: Request | None, action: str, *, session: RemoteSession | None = None,
                 device_id: str | None = None, actor_kind: str = "user", actor_id: str | None = None, **detail) -> None:
    db.add(RemoteAudit(
        action=action,
        session_id=session.id if session else None,
        device_id=device_id or (session.device_id if session else None),
        actor_kind=actor_kind, actor_id=actor_id,
        ip=client_ip(request) if request is not None else "",
        detail=json.dumps(detail, ensure_ascii=False) if detail else "",
    ))


async def _module_on(db: AsyncSession) -> None:
    """익명·호스트 엔드포인트용 모듈 검사(require_module 은 kwargs 의 db 를 참조한다)."""
    @require_module(MODULE)
    async def _check(db=None):  # noqa: ARG001
        return True
    await _check(db=db)


async def _org_name(db: AsyncSession) -> str:
    v = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == "branding.site_name"))
    if v:
        try:
            v = json.loads(v)
        except Exception:
            pass
        if isinstance(v, str) and v.strip():
            return v.strip()
    return settings.app_name


def _livekit_ready() -> None:
    if not lk.is_configured():
        raise HTTPException(503, "원격 데스크톱 중계 서버(LiveKit)가 설정되지 않았습니다")


def _split_cred(raw: str | None) -> tuple[str, str]:
    if not raw or ":" not in raw:
        raise HTTPException(401, "인증 정보가 없습니다")
    a, b = raw.split(":", 1)
    if not a or not b or len(a) > 64 or len(b) > 128:
        raise HTTPException(401, "인증 정보가 올바르지 않습니다")
    return a, b


async def _host_device(db: AsyncSession, cred: str | None) -> RemoteDevice:
    did, secret = _split_cred(cred)
    dev = await db.get(RemoteDevice, did)
    # 기기가 없을 때도 비교를 1회 수행해 응답 시간 차이로 존재 여부가 노출되지 않도록 함
    ok = svc.secret_matches(secret, dev.host_secret_hash if dev else svc.sha256("x"))
    if not dev or not ok or dev.revoked_at is not None:
        raise HTTPException(401, "기기 인증 실패")
    return dev


async def _support_session(db: AsyncSession, cred: str | None) -> RemoteSession:
    sid, secret = _split_cred(cred)
    s = await db.get(RemoteSession, sid)
    ok = svc.secret_matches(secret, s.host_secret_hash if s else svc.sha256("x"))
    if not s or not ok or s.kind != "support":
        raise HTTPException(401, "지원 세션 인증 실패")
    return s


async def _expire_if_due(db: AsyncSession, s: RemoteSession, request: Request | None = None) -> None:
    """상태별 만료 시각을 경과한 세션을 정리한다(주기적 리퍼 없이 조회 시마다 수행)."""
    if s.status in ("ended", "denied", "expired"):
        return
    if svc.expired(s.expires_at):
        prev = s.status
        if prev == "active":
            await _end(db, s, "host_lost", request, actor_kind="system")
        else:
            s.status = "expired"
            s.ended_at = svc.now()
            s.end_reason = f"{prev}_timeout"
            await _audit(db, request, "session.expired", session=s, actor_kind="system", prev=prev)


class EndBody(BaseModel):
    """호스트(데스크톱 앱·지원 프로그램)가 자체 종료할 때의 사유 — 진단용(감사 기록 detail). 선택 항목."""
    reason: str | None = Field(None, max_length=40, pattern=r"^[a-z_]+$")
    detail: str | None = Field(None, max_length=300)


def _client_end(body: EndBody | None) -> dict:
    if not body:
        return {}
    out: dict = {}
    if body.reason:
        out["client_reason"] = body.reason
    if body.detail:
        out["client_detail"] = "".join(ch for ch in body.detail if ch.isprintable())[:300]
    return out


async def _end(db: AsyncSession, s: RemoteSession, reason: str, request: Request | None, *,
               actor_kind: str, actor_id: str | None = None, **detail) -> None:
    if s.status in ("ended", "denied", "expired"):
        return
    s.status = "ended"
    s.ended_at = svc.now()
    s.end_reason = reason
    await _audit(db, request, "session.ended", session=s, actor_kind=actor_kind, actor_id=actor_id, reason=reason, **detail)
    if s.room and lk.is_configured():
        try:
            await lk.delete_room(s.room)  # 방을 닫아 잔여 토큰으로 재접속해도 상대가 없도록 함
        except Exception as e:  # noqa: BLE001 — 종료 여부의 기준은 DB
            logger.warning("remote: LiveKit 방 닫기 실패 %s: %s", s.room, e)


def _org_domain() -> str:
    """동의 창의 "조직 · 도메인" — 이 워크스페이스 주소의 호스트 이름"""
    try:
        from urllib.parse import urlparse
        return urlparse(settings.app_url).hostname or ""
    except Exception:  # noqa: BLE001
        return ""


def _duration_s(s: RemoteSession) -> int | None:
    st, en = svc.aware(s.started_at), svc.aware(s.ended_at)
    if not st:
        return None
    return int(((en or svc.now()) - st).total_seconds())


def _session_out(s: RemoteSession) -> dict:
    return {
        "id": s.id, "kind": s.kind, "status": s.status, "device_id": s.device_id,
        "requester_name": s.requester_name, "requester_email": s.requester_email or "",
        "duration_s": _duration_s(s),
        "created_at": svc.aware(s.created_at).isoformat() if s.created_at else None,
        "expires_at": svc.aware(s.expires_at).isoformat() if s.expires_at else None,
        "started_at": svc.aware(s.started_at).isoformat() if s.started_at else None,
        "ended_at": svc.aware(s.ended_at).isoformat() if s.ended_at else None,
        "end_reason": s.end_reason,
    }


def _device_out(d: RemoteDevice, owner_name: str = "") -> dict:
    return {
        "id": d.id, "name": d.name, "platform": d.platform, "os_name": d.os_name or "", "owner_id": d.owner_id, "owner_name": owner_name,
        "allow_remote": bool(d.allow_remote), "unattended": bool(d.unattended),
        "online": svc.is_online(d.last_seen_at),
        "last_seen_at": svc.aware(d.last_seen_at).isoformat() if d.last_seen_at else None,
        "revoked": d.revoked_at is not None,
    }


def _issue(s: RemoteSession, *, host: bool, name: str) -> dict:
    """세션당 LiveKit 토큰. 방 이름은 활성화 시 결정한 무작위 값이며, 정체성은 세션에 귀속된다."""
    assert s.room
    if host:
        tok = svc.make_token(svc.host_identity(s.id), name, svc.host_grants(s.room), {"role": "host", "session": s.id})
    else:
        tok = svc.make_token(svc.viewer_identity(s.id), name, svc.viewer_grants(s.room), {"role": "viewer", "session": s.id})
    s.tokens_issued = (s.tokens_issued or 0) + 1
    return {
        "ws_url": lk.get_ws_url(), "token": tok, "room": s.room,
        # 상대 정체성 — 데이터 채널 메시지는 이 정체성에서 송신된 것만 수신한다
        "peer_identity": svc.viewer_identity(s.id) if host else svc.host_identity(s.id),
    }


async def _activate(db: AsyncSession, s: RemoteSession) -> None:
    s.status = "active"
    s.room = svc.new_room()
    s.started_at = svc.now()
    s.expires_at = svc.now() + svc.ACTIVE_HEARTBEAT
    if lk.is_configured():
        try:
            await lk.create_room(s.room, empty_timeout=60, max_participants=2)
        except Exception as e:  # noqa: BLE001 — auto_create 서버에서는 입장 시 생성됨
            logger.warning("remote: LiveKit 방 만들기 실패 %s: %s", s.room, e)


# ─── 상태 ───

@router.get("/status")
@require_module(MODULE)
async def remote_status(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    exe = _support_exe()
    return {
        "livekit": lk.is_configured(),
        "org_name": await _org_name(db),
        "org_domain": _org_domain(),
        "support_download": SUPPORT_DOWNLOAD,
        "support_available": exe.is_file(),
        # 웹 "지원 프로그램 다운로드" 옆 안내 — 실제 파일 크기와 요구 사항(파일이 없으면 버튼 숨김)
        "support_size": exe.stat().st_size if exe.is_file() else None,
        "support_requirements": SUPPORT_REQUIREMENTS,
        "desktop_download": "/api/apps/desktop",
        "code_ttl_s": int(svc.CODE_TTL.total_seconds()),
        "is_admin": bool(user.is_admin),
    }


# ─── 1회성 지원 프로그램 다운로드(익명 — 피지원자는 계정이 없음) ───

SUPPORT_FILE = "remote-support.exe"
SUPPORT_REQUIREMENTS = "Windows 10 이상"
SUPPORT_DOWNLOAD = "/api/plugins/remote-desktop/support/download"


def _support_exe() -> Path:
    """apps/desktop `npm run dist:support` 산출물을 관리자가 이 위치에 배치한다(데스크톱 설치본과 동일한 apps 폴더)."""
    return Path(settings.storage_root) / "apps" / SUPPORT_FILE


@router.get("/support/download")
async def support_download(db: AsyncSession = Depends(get_db)):
    await _module_on(db)
    p = _support_exe()
    if not p.is_file():
        raise HTTPException(404, "지원 프로그램이 아직 업로드되지 않았습니다")
    return FileResponse(p, media_type="application/vnd.microsoft.portable-executable",
                        filename="RemoteSupport.exe", headers={"Cache-Control": "no-cache"})


# ─── 기기(회원) ───

class DeviceRegister(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    platform: str = Field(default="", max_length=32)
    os_name: str = Field(default="", max_length=64)


class DevicePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    allow_remote: bool | None = None
    unattended: bool | None = None


@router.get("/devices")
@require_module(MODULE)
async def list_devices(all: bool = Query(False), user: User = Depends(get_current_user),
                       db: AsyncSession = Depends(get_db)):
    q = select(RemoteDevice).where(RemoteDevice.revoked_at.is_(None))
    if not (all and user.is_admin):
        q = q.where(RemoteDevice.owner_id == user.id)
    devs = (await db.execute(q.order_by(RemoteDevice.name))).scalars().all()
    names: dict[str, str] = {}
    if devs:
        rows = (await db.execute(select(User.id, User.display_name, User.username)
                                 .where(User.id.in_({d.owner_id for d in devs})))).all()
        names = {r[0]: (r[1] or r[2]) for r in rows}
    return {"devices": [_device_out(d, names.get(d.owner_id, "")) for d in devs]}


@router.post("/devices", status_code=201)
@require_module(MODULE)
async def register_device(request: Request, body: DeviceRegister, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    """데스크톱 앱이 자신을 등록한다. 호스트 비밀은 이 응답에서 1회만 반환한다(재등록 = 비밀 교체)."""
    secret = svc.new_secret()
    existing = (await db.execute(select(RemoteDevice).where(
        RemoteDevice.owner_id == user.id, RemoteDevice.name == body.name,
        RemoteDevice.platform == body.platform))).scalar_one_or_none()
    if existing:
        dev = existing
        dev.host_secret_hash = svc.sha256(secret)
        dev.revoked_at = None
        if body.os_name:
            dev.os_name = body.os_name
        action = "device.rekeyed"
    else:
        dev = RemoteDevice(owner_id=user.id, name=body.name, platform=body.platform, os_name=body.os_name,
                           allow_remote=False, host_secret_hash=svc.sha256(secret))
        db.add(dev)
        await db.flush()
        action = "device.registered"
    await _audit(db, request, action, device_id=dev.id, actor_id=user.id, name=body.name, platform=body.platform)
    await db.commit()
    return {"device": _device_out(dev, user.display_name or user.username), "host_secret": secret}


async def _my_device(db: AsyncSession, device_id: str, user: User, *, admin_ok: bool) -> RemoteDevice:
    dev = await db.get(RemoteDevice, device_id)
    if not dev or dev.revoked_at is not None:
        raise HTTPException(404, "기기를 찾을 수 없습니다")
    if dev.owner_id != user.id and not (admin_ok and user.is_admin):
        raise HTTPException(404, "기기를 찾을 수 없습니다")
    return dev


@router.patch("/devices/{device_id}")
@require_module(MODULE)
async def patch_device(request: Request, device_id: str, body: DevicePatch, user: User = Depends(get_current_user),
                       db: AsyncSession = Depends(get_db)):
    dev = await _my_device(db, device_id, user, admin_ok=False)  # 설정 변경은 소유자만 가능
    changes = {}
    if body.name is not None:
        dev.name = body.name
        changes["name"] = body.name
    if body.allow_remote is not None:
        dev.allow_remote = body.allow_remote
        changes["allow_remote"] = body.allow_remote
    if body.unattended is not None:
        dev.unattended = body.unattended
        changes["unattended"] = body.unattended
    await _audit(db, request, "device.updated", device_id=dev.id, actor_id=user.id, **changes)
    await db.commit()
    return {"device": _device_out(dev)}


@router.delete("/devices/{device_id}")
@require_module(MODULE)
async def revoke_device(request: Request, device_id: str, user: User = Depends(get_current_user),
                        db: AsyncSession = Depends(get_db)):
    dev = await _my_device(db, device_id, user, admin_ok=True)
    dev.revoked_at = svc.now()
    dev.allow_remote = False
    live = (await db.execute(select(RemoteSession).where(
        RemoteSession.device_id == dev.id, RemoteSession.status.in_(("pending", "active"))))).scalars().all()
    for s in live:
        await _end(db, s, "device_revoked", request, actor_kind="user", actor_id=user.id)
    await _audit(db, request, "device.revoked", device_id=dev.id, actor_id=user.id)
    await db.commit()
    return {"ok": True}


@router.get("/devices/{device_id}/sessions")
@require_module(MODULE)
async def device_sessions(device_id: str, limit: int = Query(3, ge=1, le=50), user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    """이 기기의 접속 수신 기록(최근 순) — 소유자 전용. 관리자 감사는 /audit."""
    dev = await _my_device(db, device_id, user, admin_ok=False)
    rows = (await db.execute(select(RemoteSession).where(RemoteSession.device_id == dev.id)
                             .order_by(RemoteSession.created_at.desc()).limit(limit))).scalars().all()
    return {"sessions": [_session_out(r) for r in rows]}


@router.post("/devices/{device_id}/connect", status_code=201)
@require_module(MODULE)
@limiter.limit("20/minute")
async def connect_device(request: Request, device_id: str, user: User = Depends(get_current_user),
                         db: AsyncSession = Depends(get_db)):
    """접속 요청 — 소유자 또는 관리자. 호스트(화면 앞 사용자)가 동의해야 연결된다."""
    dev = await _my_device(db, device_id, user, admin_ok=True)
    if not dev.allow_remote:
        raise HTTPException(409, "이 기기는 원격 접속을 허용하지 않습니다")
    if not svc.is_online(dev.last_seen_at):
        raise HTTPException(409, "기기가 오프라인입니다")
    busy = await db.scalar(select(func.count()).select_from(RemoteSession).where(
        RemoteSession.device_id == dev.id, RemoteSession.status.in_(("pending", "active")),
        RemoteSession.expires_at > svc.now()))
    if busy:
        raise HTTPException(409, "이미 진행 중인 원격 접속이 있습니다")
    s = RemoteSession(kind="device", device_id=dev.id, requester_id=user.id,
                      requester_name=user.display_name or user.username, requester_email=user.email or "", status="pending",
                      expires_at=svc.now() + svc.CONSENT_TTL)
    db.add(s)
    await db.flush()
    await _audit(db, request, "session.requested", session=s, actor_id=user.id,
                 as_admin=bool(user.is_admin and dev.owner_id != user.id))
    await db.commit()
    return {"session": _session_out(s)}


# ─── 세션(뷰어) ───

async def _viewer_session(db: AsyncSession, session_id: str, user: User) -> RemoteSession:
    s = await db.get(RemoteSession, session_id)
    if not s or (s.requester_id != user.id and not user.is_admin):
        raise HTTPException(404, "세션을 찾을 수 없습니다")
    return s


@router.get("/sessions/{session_id}")
@require_module(MODULE)
async def get_session(request: Request, session_id: str, token: bool = Query(False),
                      user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """뷰어 상태 확인. active 이고 token=1 이면 뷰어 LiveKit 토큰을 반환한다(요청자 본인만)."""
    s = await _viewer_session(db, session_id, user)
    await _expire_if_due(db, s, request)
    out: dict = {"session": _session_out(s)}
    if token and s.status == "active":
        if s.requester_id != user.id:
            raise HTTPException(403, "요청자만 화면에 들어갈 수 있습니다")
        _livekit_ready()
        out["livekit"] = _issue(s, host=False, name=user.display_name or user.username)
        await _audit(db, request, "token.viewer", session=s, actor_id=user.id)
    await db.commit()
    return out


@router.post("/sessions/{session_id}/end")
@require_module(MODULE)
async def end_session_viewer(request: Request, session_id: str, user: User = Depends(get_current_user),
                             db: AsyncSession = Depends(get_db)):
    s = await _viewer_session(db, session_id, user)
    await _end(db, s, "viewer_end", request, actor_kind="user", actor_id=user.id)
    await db.commit()
    return {"session": _session_out(s)}


# ─── 1회성 지원: 회원이 코드 입력 ───

class JoinBody(BaseModel):
    code: str = Field(min_length=9, max_length=20)


@router.post("/support/join", status_code=201)
@require_module(MODULE)
@limiter.limit("20/minute")
async def support_join(request: Request, body: JoinBody, user: User = Depends(get_current_user),
                       db: AsyncSession = Depends(get_db)):
    fails = await db.scalar(select(func.count()).select_from(RemoteAudit).where(
        RemoteAudit.action == "support.join_failed", RemoteAudit.actor_id == user.id,
        RemoteAudit.at > svc.now() - JOIN_FAIL_WINDOW))
    if (fails or 0) >= JOIN_FAIL_LIMIT:
        raise HTTPException(429, "코드 입력을 너무 많이 틀렸습니다. 잠시 후 다시 시도하십시오")
    code = svc.normalize_code(body.code)
    s = None
    if code:
        h = svc.code_hash(code)
        cands = (await db.execute(select(RemoteSession).where(
            RemoteSession.code_hash == h, RemoteSession.kind == "support"))).scalars().all()
        for c in cands:
            if c.code_hash and hmac.compare_digest(c.code_hash, h):
                s = c
    if s is not None:
        await _expire_if_due(db, s, request)
    if s is None or s.status != "waiting_code":
        reason = "format" if not code else ("no_match" if s is None else "expired")
        burned = await _count_near_miss(db, request, code) if reason == "no_match" else 0
        await _audit(db, request, "support.join_failed", actor_id=user.id, reason=reason,
                     **({"burned_codes": burned} if burned else {}))
        await db.commit()
        msg = {
            "format": "9자리 숫자가 아닙니다. 코드를 다시 확인하십시오.",
            "no_match": "일치하는 지원 요청이 없습니다. 상대방 화면의 코드와 같은지 확인하십시오.",
            "expired": "만료된 코드입니다. 상대방에게 지원 프로그램에서 새 코드를 받으십시오.",
        }[reason]
        raise HTTPException(422 if reason == "format" else 404, {"code": reason, "message": msg})
    # 1회성: 코드 사용 시점에 소모(해시 삭제) — 동일 코드로 재접속 불가
    s.code_hash = None
    s.status = "pending"
    s.requester_id = user.id
    s.requester_name = user.display_name or user.username
    s.requester_email = user.email or ""
    s.expires_at = svc.now() + svc.CONSENT_TTL
    await _audit(db, request, "support.joined", session=s, actor_id=user.id)
    await db.commit()
    return {"session": _session_out(s)}


async def _count_near_miss(db: AsyncSession, request: Request, code: str | None) -> int:
    """오류 코드가 한 자리만 다른 유효 코드를 대상으로 한 것이면 해당 코드의 실패 횟수를 증가시키고,
    MAX_CODE_ATTEMPTS 에 도달하면 해당 코드를 즉시 폐기한다(소수의 오타는 허용하고, 근접 대입은 차단한다).
    폐기한 코드 수를 반환한다."""
    if not code:
        return 0
    hashes = [svc.code_hash(c) for c in svc.neighbor_codes(code)]
    rows = (await db.execute(select(RemoteSession).where(
        RemoteSession.kind == "support", RemoteSession.status == "waiting_code",
        RemoteSession.code_hash.in_(hashes)))).scalars().all()
    burned = 0
    for r in rows:
        r.code_attempts = (r.code_attempts or 0) + 1
        if r.code_attempts >= svc.MAX_CODE_ATTEMPTS:
            r.code_hash = None
            r.status = "expired"
            r.ended_at = svc.now()
            r.end_reason = "code_attempts"
            await _audit(db, request, "support.code_burned", session=r, actor_kind="system", attempts=r.code_attempts)
            burned += 1
    return burned


# ─── 1회성 지원: 포터블 프로그램(익명) ───

@router.post("/support/code", status_code=201)
@limiter.limit("10/hour")
async def support_code(request: Request, db: AsyncSession = Depends(get_db)):
    """지원 프로그램이 접속 코드를 발급받는다. 계정 없음 — IP 당 발급 한도로 제한한다."""
    await _module_on(db)
    _livekit_ready()
    code = svc.new_code()
    secret = svc.new_secret()
    s = RemoteSession(kind="support", code_hash=svc.code_hash(code), host_secret_hash=svc.sha256(secret),
                      status="waiting_code", expires_at=svc.now() + svc.CODE_TTL)
    db.add(s)
    await db.flush()
    await _audit(db, request, "support.code_issued", session=s, actor_kind="support")
    await db.commit()
    return {"session_id": s.id, "code": svc.format_code(code), "host_secret": secret,
            "expires_at": svc.aware(s.expires_at).isoformat(), "org_name": await _org_name(db), "org_domain": _org_domain()}


async def _wait(db: AsyncSession, check, wait: int):
    """롱폴링 — check() 가 값을 반환하거나 시간이 만료될 때까지 1초 간격으로 재확인한다."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max(0, min(wait, POLL_MAX))
    while True:
        res = await check()
        if res is not None or loop.time() >= deadline:
            return res
        await db.commit()       # 트랜잭션을 종료해야 다음 조회에서 다른 워커의 갱신이 반영된다
        db.expire_all()
        await asyncio.sleep(POLL_STEP)


@router.get("/support/poll")
async def support_poll(request: Request, wait: int = Query(0, ge=0, le=POLL_MAX), since: str = Query(""),
                       x_remote_support: str | None = Header(None), db: AsyncSession = Depends(get_db)):
    """지원 프로그램 상태 롱폴링. since(이전 상태)와 달라지면 즉시 반환한다. active 중에는 하트비트로 동작한다."""
    await _module_on(db)
    s = await _support_session(db, x_remote_support)

    async def check():
        await db.refresh(s)
        await _expire_if_due(db, s, request)
        if s.status == "active":
            s.expires_at = svc.now() + svc.ACTIVE_HEARTBEAT
        if s.status != since:
            return s
        return None

    await _wait(db, check, wait)
    out = {"session": _session_out(s)}
    if s.status == "pending":
        out["org_name"] = await _org_name(db)
        out["org_domain"] = _org_domain()
    await db.commit()
    return out


class Decision(BaseModel):
    allow: bool


@router.post("/support/decision")
async def support_decision(request: Request, body: Decision, x_remote_support: str | None = Header(None),
                           db: AsyncSession = Depends(get_db)):
    await _module_on(db)
    s = await _support_session(db, x_remote_support)
    await _expire_if_due(db, s, request)
    if s.status != "pending":
        await db.commit()
        raise HTTPException(409, "동의를 기다리는 요청이 없습니다")
    if not body.allow:
        s.status = "denied"
        s.ended_at = svc.now()
        s.end_reason = "denied"
        await _audit(db, request, "session.denied", session=s, actor_kind="support")
        await db.commit()
        return {"session": _session_out(s)}
    _livekit_ready()
    await _activate(db, s)
    lkinfo = _issue(s, host=True, name="지원 대상")
    await _audit(db, request, "session.approved", session=s, actor_kind="support")
    await db.commit()
    return {"session": _session_out(s), "livekit": lkinfo}


@router.post("/support/end")
async def support_end(request: Request, x_remote_support: str | None = Header(None),
                      body: EndBody | None = Body(None), db: AsyncSession = Depends(get_db)):
    """지원 프로그램 종료 또는 [끊기] — 코드·세션 모두 무효화."""
    await _module_on(db)
    s = await _support_session(db, x_remote_support)
    if s.status in ("waiting_code", "pending"):
        s.code_hash = None
        s.status = "expired" if s.status == "waiting_code" else "denied"
        s.ended_at = svc.now()
        s.end_reason = "host_closed"
        await _audit(db, request, "support.closed", session=s, actor_kind="support")
    else:
        await _end(db, s, "host_end", request, actor_kind="support", **_client_end(body))
    await db.commit()
    return {"session": _session_out(s)}


# ─── 내 기기 호스트(데스크톱 앱) ───

@router.get("/host/poll")
async def host_poll(request: Request, wait: int = Query(0, ge=0, le=POLL_MAX), known: str = Query(""),
                    x_remote_host: str | None = Header(None), db: AsyncSession = Depends(get_db)):
    """호스트 롱폴링 — 동의 대기 요청과 진행 중 세션. known(쉼표로 연결한 "id:status")와 달라지면 즉시 반환한다.

    호출 시마다 기기의 last_seen 과 active 세션 하트비트를 갱신한다.
    """
    await _module_on(db)
    dev = await _host_device(db, x_remote_host)
    known_set = set(filter(None, known.split(",")))

    async def snapshot():
        await db.refresh(dev)
        dev.last_seen_at = svc.now()
        rows = (await db.execute(select(RemoteSession).where(
            RemoteSession.device_id == dev.id, RemoteSession.status.in_(("pending", "active"))))).scalars().all()
        live = []
        for s in rows:
            await db.refresh(s)
            await _expire_if_due(db, s, request)
            if s.status == "active":
                s.expires_at = svc.now() + svc.ACTIVE_HEARTBEAT
            if s.status in ("pending", "active"):
                live.append(s)
        return live

    async def check():
        live = await snapshot()
        cur = {f"{s.id}:{s.status}" for s in live}
        return live if cur != known_set else None

    live = await _wait(db, check, wait)
    if live is None:
        live = await snapshot()
    sessions = []
    for s in live:
        d = _session_out(s)
        # 무인 접속: 소유자 본인 요청 + 서버 설정(unattended) — 앱도 자체 설정을 재확인한다
        d["auto_allow"] = bool(s.status == "pending" and s.requester_id == dev.owner_id and bool(dev.unattended))
        d["requester_is_owner"] = s.requester_id == dev.owner_id
        sessions.append(d)
    out = {"device": _device_out(dev), "sessions": sessions, "org_name": await _org_name(db), "org_domain": _org_domain()}
    await db.commit()
    return out


async def _host_session(db: AsyncSession, dev: RemoteDevice, session_id: str) -> RemoteSession:
    s = await db.get(RemoteSession, session_id)
    if not s or s.device_id != dev.id:
        raise HTTPException(404, "세션을 찾을 수 없습니다")
    return s


@router.post("/host/sessions/{session_id}/decision")
async def host_decision(request: Request, session_id: str, body: Decision,
                        x_remote_host: str | None = Header(None), db: AsyncSession = Depends(get_db)):
    await _module_on(db)
    dev = await _host_device(db, x_remote_host)
    s = await _host_session(db, dev, session_id)
    await _expire_if_due(db, s, request)
    if s.status != "pending":
        await db.commit()
        raise HTTPException(409, "동의를 기다리는 요청이 없습니다")
    if not dev.allow_remote:
        body = Decision(allow=False)
    if not body.allow:
        s.status = "denied"
        s.ended_at = svc.now()
        s.end_reason = "denied"
        await _audit(db, request, "session.denied", session=s, actor_kind="host")
        await db.commit()
        return {"session": _session_out(s)}
    _livekit_ready()
    await _activate(db, s)
    lkinfo = _issue(s, host=True, name=dev.name)
    await _audit(db, request, "session.approved", session=s, actor_kind="host")
    await db.commit()
    return {"session": _session_out(s), "livekit": lkinfo}


@router.post("/host/sessions/{session_id}/end")
async def host_end(request: Request, session_id: str, x_remote_host: str | None = Header(None),
                   body: EndBody | None = Body(None), db: AsyncSession = Depends(get_db)):
    await _module_on(db)
    dev = await _host_device(db, x_remote_host)
    s = await _host_session(db, dev, session_id)
    await _end(db, s, "host_end", request, actor_kind="host", **_client_end(body))
    await db.commit()
    return {"session": _session_out(s)}


# ─── 감사(관리자) ───

@router.get("/audit")
@require_module(MODULE)
async def audit_log(session_id: str | None = None, limit: int = Query(200, ge=1, le=1000),
                    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if not user.is_admin:
        raise HTTPException(403, "관리자만 볼 수 있습니다")
    q = select(RemoteAudit).order_by(RemoteAudit.at.desc()).limit(limit)
    if session_id:
        q = q.where(RemoteAudit.session_id == session_id)
    rows = (await db.execute(q)).scalars().all()
    return {"events": [{
        "at": svc.aware(r.at).isoformat(), "action": r.action, "session_id": r.session_id, "device_id": r.device_id,
        "actor_kind": r.actor_kind, "actor_id": r.actor_id, "ip": r.ip,
        "detail": json.loads(r.detail) if r.detail else {},
    } for r in rows]}
