"""격리 브라우저 API.

사용자(모듈 rbi 활성 + 대상별 허용 사용자/그룹). 인증은 site.get_rbi_user — rbi 전용 출처(RBI_PUBLIC_ORIGIN)에서는
해당 출처의 세션 쿠키만, 워크스페이스 출처에서는 워크스페이스 세션을 사용한다(런처가 대상 목록을 조회한다). SSO 홉은 app/rbi/site.py.
  GET    /api/rbi/targets                 사용 가능한 대상 + 본인의 활성 세션 + public_origin
  POST   /api/rbi/sessions                {target_id, mode?} → 세션(컨테이너 기동, 최대 ~50초). mode: mirror 대상을 pixel 로(fallback)
  POST   /api/rbi/sessions/{id}/mode      {mode} → 화면 방식 전환(현재 세션을 종료하고 동일 대상으로 신규 생성)
  GET    /api/rbi/sessions/me[?recent=1]  본인의 활성 세션(recent=1: 종료된 세션까지 최근 10건)
  GET    /api/rbi/sessions/{id}           상태(소유자·관리자)
  POST   /api/rbi/sessions/{id}/ping      화면이 열려 있음(유휴 판정 보조)
  DELETE /api/rbi/sessions/{id}           종료(컨테이너 삭제)
  (이전의 입장 티켓 /ticket·/enter 와 경로 한정 쿠키 ws_rbi_<sid> 는 제거했다 — rbi 출처의 세션 쿠키가 스트림까지 포함한다)
내부(ws-nginx auth_request 전용 — /api/internal/ 은 nginx 가 외부에 404)
  GET    /api/internal/rbi/auth           rbi 출처에서만: X-Original-URI 의 세션을 rbi 세션 쿠키의 사용자로 검사 → 204 + X-Rbi-Upstream/X-Rbi-Authorization
관리자
  GET    /api/admin/rbi                   대상 전체 + 활성 세션 + 상태(이미지·네트워크·netfilter guard)
  POST   /api/admin/rbi/targets · PUT/DELETE /api/admin/rbi/targets/{id}
  GET    /api/admin/rbi/sessions          최근 세션 50건
  DELETE /api/admin/rbi/sessions/{id}     강제 종료
  대상을 비활성화하거나 삭제하거나 허용 사용자/그룹을 축소하면 해당 대상의 열린 세션 중 권한을 상실한 세션을 즉시 종료한다(svc.enforce_access).
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import audit
from app.admin.router import _client_ip, require_admin
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.modules.registry import require_module
from app.rbi import egress as eg
from app.rbi import service as svc
from app.rbi import site
from app.rbi.site import get_rbi_user
from app.rbi.models import RbiSession, RbiTarget

router = APIRouter(tags=["rbi"])
settings = get_settings()

_SID_RE = re.compile(r"^/rbi/([0-9a-f]{32})(?:/|$)")


class StartBody(BaseModel):
    target_id: str
    mode: str | None = None


class ModeBody(BaseModel):
    mode: str


class TargetBody(BaseModel):
    """관리자 대상 생성/수정 — 전송된 필드만 반영(PUT 도 부분 갱신)."""
    key: str | None = None
    name: str | None = None
    url: str | None = None
    allowed_hosts: list[str] | None = None
    enabled: bool | None = None
    mode: str | None = None
    clipboard_to_browser: bool | None = None
    clipboard_from_browser: bool | None = None
    downloads: bool | None = None
    uploads: bool | None = None
    idle_minutes: int | None = None
    max_hours: int | None = None
    cpu: float | None = None
    memory_mb: int | None = None
    allowed_group_ids: list[str] | None = None
    allowed_user_ids: list[str] | None = None
    #: 80·443 외에 개방할 포트(명시한 것만)
    extra_ports: list[int] | None = None
    #: 워크스페이스 자신의 주소(RP·앱 호스트·게이트웨이 등)를 대상으로 강제 — 경고와 함께 저장(감사에 기록된다)
    force: bool | None = None


async def _owned_session(db: AsyncSession, sid: str, user: User) -> RbiSession:
    sess = await db.get(RbiSession, sid)
    if not sess or (sess.user_id != user.id and not user.is_admin):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")
    return sess


# ── 사용자 ──

@router.get("/api/rbi/targets")
@require_module("rbi")
async def list_targets(user: User = Depends(get_rbi_user), db: AsyncSession = Depends(get_db)):
    out = []
    for t in await svc.list_targets(db):
        if not t.enabled and not user.is_admin:
            continue
        if await svc.user_can_use(db, user, t):
            out.append(svc.target_dict(t))
    mine = await svc.active_sessions(db, user.id)
    by_id = {t.id: t for t in await svc.list_targets(db)}
    return {
        "targets": out,
        "sessions": [svc.session_dict(s, by_id.get(s.target_id)) for s in mine],
        # 런처(워크스페이스 /rbi)가 새 탭으로 여는 주소. 비어 있으면 전용 출처 미설정
        "public_origin": site.public_origin(),
    }


@router.post("/api/rbi/sessions", status_code=201)
@require_module("rbi")
async def start_session(
    body: StartBody, request: Request,
    user: User = Depends(get_rbi_user), db: AsyncSession = Depends(get_db),
):
    t = await svc.get_target(db, body.target_id)
    if not t or not await svc.user_can_use(db, user, t):
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없거나 권한이 없습니다")
    ip = _client_ip(request)
    try:
        sess = await svc.start_session(db, user, t, ip, mode=body.mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except svc.SessionStartError as e:
        await audit.log_action(db, user.id, "rbi.session.start_failed", "rbi_target", t.id,
                               {"target": t.key, "error": str(e)[:300], "mode": body.mode}, ip)
        raise HTTPException(status_code=e.status, detail=str(e))
    await audit.log_action(db, user.id, "rbi.session.start", "rbi_session", sess.id,
                           {"target": t.key, "url": t.url, "container": sess.container_name, "mode": svc.session_mode(sess)}, ip)
    return svc.session_dict(sess, t)


@router.post("/api/rbi/sessions/{sid}/mode")
@require_module("rbi")
async def switch_session_mode(
    sid: str, body: ModeBody, request: Request,
    user: User = Depends(get_rbi_user), db: AsyncSession = Depends(get_db),
):
    """화면 방식 전환 — 미러가 정상 표시되지 않는 화면에서 픽셀로(또는 다시 미러로). 소유자만 가능. 세션을 새로 기동한다."""
    sess = await _owned_session(db, sid, user)
    if sess.user_id != user.id:
        raise HTTPException(status_code=403, detail="내 세션만 변경할 수 있습니다")
    t = await svc.get_target(db, sess.target_id)
    if not t or not await svc.user_can_use(db, user, t):
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없거나 권한이 없습니다")
    ip = _client_ip(request)
    old_mode = svc.session_mode(sess)
    try:
        new = await svc.switch_mode(db, user, sess, t, body.mode, ip)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except svc.SessionStartError as e:
        await audit.log_action(db, user.id, "rbi.session.start_failed", "rbi_target", t.id,
                               {"target": t.key, "error": str(e)[:300], "mode": body.mode}, ip)
        raise HTTPException(status_code=e.status, detail=str(e))
    await audit.log_action(db, user.id, "rbi.session.mode", "rbi_session", new.id,
                           {"target": t.key, "from": old_mode, "to": svc.session_mode(new), "previous": sess.id}, ip)
    return svc.session_dict(new, t)


@router.get("/api/rbi/sessions/me")
@require_module("rbi")
async def my_sessions(recent: bool = False, user: User = Depends(get_rbi_user), db: AsyncSession = Depends(get_db)):
    """본인의 활성 세션. recent=1 이면 종료된 세션까지 최근 10건(단독 앱의 세션 목록)."""
    by_id = {t.id: t for t in await svc.list_targets(db)}
    rows = await svc.recent_sessions(db, 10, user_id=user.id) if recent else await svc.active_sessions(db, user.id)
    return {"sessions": [svc.session_dict(s, by_id.get(s.target_id)) for s in rows]}


@router.get("/api/rbi/sessions/{sid}")
@require_module("rbi")
async def session_status(sid: str, user: User = Depends(get_rbi_user), db: AsyncSession = Depends(get_db)):
    sess = await _owned_session(db, sid, user)
    return svc.session_dict(sess, await svc.get_target(db, sess.target_id))


@router.post("/api/rbi/sessions/{sid}/ping")
@require_module("rbi")
async def session_ping(sid: str, user: User = Depends(get_rbi_user), db: AsyncSession = Depends(get_db)):
    sess = await _owned_session(db, sid, user)
    if sess.status in svc.ACTIVE:
        await svc.touch(db, sess)
    return {"status": sess.status}


@router.delete("/api/rbi/sessions/{sid}")
@require_module("rbi")
async def end_session(
    sid: str, request: Request,
    user: User = Depends(get_rbi_user), db: AsyncSession = Depends(get_db),
):
    sess = await _owned_session(db, sid, user)
    was_active = sess.status in svc.ACTIVE
    await svc.stop_session(db, sess, "user" if sess.user_id == user.id else "admin")
    if was_active:
        await audit.log_action(db, user.id, "rbi.session.stop", "rbi_session", sess.id,
                               {"target": sess.target_key, "by_owner": sess.user_id == user.id}, _client_ip(request))
    return svc.session_dict(sess, await svc.get_target(db, sess.target_id))


# ── 내부: ws-nginx auth_request ──

@router.get("/api/internal/rbi/auth")
async def stream_auth(request: Request, db: AsyncSession = Depends(get_db)):
    """nginx(rbi 출처 server 블록)가 /rbi/<sid>/… 요청마다 호출한다. 소유자이면 204 + 업스트림/인증 헤더, 아니면 401/403.

    rbi 출처에서만 허용한다(Host — nginx 가 $host 를 전달한다). 소유자 판정은 rbi 세션 쿠키(__Host-jw_rbi)의 사용자 기준 —
    워크스페이스 세션 쿠키는 확인하지 않는다(해당 쿠키는 본 출처로 전송되지 않는다).
    업스트림 주소·basic auth 는 응답 헤더로만 nginx 에 전달되며 사용자에게는 전달되지 않는다.
    """
    # nginx auth_request 는 401/403 만 그대로 전달하고 그 외(404 포함)는 500 으로 변환한다 — 존재하지 않는 세션도 403
    if not site.public_origin() or not site.is_rbi_host(request):
        raise HTTPException(status_code=403)
    uri = request.headers.get("x-original-uri", "")
    m = _SID_RE.match(uri)
    if not m:
        raise HTTPException(status_code=403)
    sid = m.group(1)
    sess = await db.get(RbiSession, sid)
    if not sess:
        raise HTTPException(status_code=403)
    user = await site.site_user(request, db)
    if not user:
        raise HTTPException(status_code=401)
    got = svc.stream_auth(sess, user.id)
    if not got:
        raise HTTPException(status_code=403)
    # 권한이 회수된 경우 정리 작업(reaper, 30초)이 컨테이너를 삭제하기 전이라도 신규 연결(재접속·자산 요청)은 허용하지 않는다
    # (요청마다 호출되므로 결과는 세션별로 수 초간 캐시 — svc.STREAM_ACCESS_TTL)
    if await svc.stream_access_denied(db, sess):
        raise HTTPException(status_code=403)
    # 방식과 경로가 일치해야 한다 — 픽셀 세션의 KasmVNC 로 미러 경로를, 미러 세션으로 KasmVNC 경로를 전달하지 않는다
    if not svc.path_allowed(sess, uri):
        raise HTTPException(status_code=403)
    upstream, authz = got
    # 스트림 트래픽 자체가 "쓰고 있다" 는 신호 — 핑과 동일한 효과(웹소켓은 1회만 기록된다)
    await svc.touch(db, sess)
    return Response(status_code=204, headers={"X-Rbi-Upstream": upstream, "X-Rbi-Authorization": authz})


# ── 관리자 ──

async def _admin_view(db: AsyncSession) -> dict:
    targets = await svc.list_targets(db)
    by_id = {t.id: t for t in targets}
    return {
        "targets": [svc.target_dict(t, admin=True) for t in targets],
        "sessions": [svc.session_dict(s, by_id.get(s.target_id)) | {"user_id": s.user_id, "client_ip": s.client_ip}
                     for s in await svc.active_sessions(db)],
        "status": await svc.status_summary(db),
    }


@router.get("/api/admin/rbi")
async def admin_overview(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    return await _admin_view(db)


async def _sync_allow(db: AsyncSession, admin: User, ip: str, key: str, *, before: set[str]) -> None:
    """DB → 동적 허용 파일(사이드카가 다음 주기에 적용한다). 출구가 추가되거나 제거된 경우 감사에 기록한다(rbi.allow.add / rbi.allow.remove)."""
    after = eg.allow_set(await eg.sync_allow_file(db))
    added, removed = sorted(after - before), sorted(before - after)
    if added:
        await audit.log_action(db, admin.id, "rbi.allow.add", "rbi_target", key, {"target": key, "entries": added}, ip)
    if removed:
        await audit.log_action(db, admin.id, "rbi.allow.remove", "rbi_target", key, {"target": key, "entries": removed}, ip)


@router.post("/api/admin/rbi/targets", status_code=201)
async def admin_create_target(
    body: TargetBody, request: Request,
    admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db),
):
    before_allow = eg.allow_set(eg.desired_lines(await svc.list_targets(db)))
    t = RbiTarget()
    data = body.model_dump(exclude_none=True)
    force = bool(data.pop("force", False))
    try:
        svc.apply_target_fields(t, data, creating=True)
        warnings = await svc.refresh_egress(t, force=force)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    if any(x.key == t.key for x in await svc.list_targets(db)):
        raise HTTPException(status_code=409, detail="같은 식별자의 대상이 있습니다")
    if t.enabled is None:
        t.enabled = True
    db.add(t)
    await db.commit()
    ip = _client_ip(request)
    await audit.log_action(db, admin.id, "rbi.target.create", "rbi_target", t.id,
                           {"key": t.key, "url": t.url, "forced": force and bool(t.egress_forced), "warnings": warnings}, ip)
    await _sync_allow(db, admin, ip, t.key, before=before_allow)
    return svc.target_dict(t, admin=True) | {"warnings": warnings}


@router.put("/api/admin/rbi/targets/{target_id}")
async def admin_update_target(
    target_id: str, body: TargetBody, request: Request,
    admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db),
):
    t = await svc.get_target(db, target_id)
    if not t:
        raise HTTPException(status_code=404, detail="대상이 없습니다")
    data = body.model_dump(exclude_none=True)
    force = bool(data.pop("force", False))
    before_allow = eg.allow_set(eg.desired_lines(await svc.list_targets(db)))
    warnings: list[str] = []
    try:
        svc.apply_target_fields(t, data, creating=False)
        # 출구에 영향을 주는 값이 변경되었거나 강제로 재저장하면 재검증·재고정한다(이름 → IP 도 재해석한다)
        if {"url", "allowed_hosts", "extra_ports"} & set(data) or force or not t.egress:
            warnings = await svc.refresh_egress(t, force=force)
    except (ValueError, TypeError) as e:
        await db.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    if "key" in data and any(x.key == t.key and x.id != t.id for x in await svc.list_targets(db)):
        await db.rollback()
        raise HTTPException(status_code=409, detail="같은 식별자의 대상이 있습니다")
    await db.commit()
    ip = _client_ip(request)
    await audit.log_action(db, admin.id, "rbi.target.update", "rbi_target", t.id,
                           {"key": t.key, "changed": sorted(data.keys()), "forced": force and bool(t.egress_forced), "warnings": warnings}, ip)
    await _sync_allow(db, admin, ip, t.key, before=before_allow)
    # 비활성화하거나 허용 사용자/그룹을 축소한 경우 — 이미 열려 있는 세션도 즉시 종료한다(이전에는 최대 수명까지 계속 사용할 수 있었다)
    if {"enabled", "allowed_user_ids", "allowed_group_ids"} & set(data):
        await svc.enforce_access(db, target_id=t.id, actor_id=admin.id, ip=ip)
    return svc.target_dict(t, admin=True) | {"warnings": warnings}


@router.delete("/api/admin/rbi/targets/{target_id}")
async def admin_delete_target(
    target_id: str, request: Request,
    admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db),
):
    t = await svc.get_target(db, target_id)
    if not t:
        raise HTTPException(status_code=404, detail="대상이 없습니다")
    ip = _client_ip(request)
    for s in await svc.active_sessions(db):
        if s.target_id == t.id:
            await svc.stop_session(db, s, "admin")
            # 대상 삭제로 종료된 세션의 사용자를 기록한다(이전에는 세션 종료가 감사에 기록되지 않았다)
            await audit.log_action(db, admin.id, "rbi.session.stop", "rbi_session", s.id,
                                   {"target": s.target_key, "by_owner": False, "owner": s.user_id, "cause": "target_removed"}, ip)
    before_allow = eg.allow_set(eg.desired_lines(await svc.list_targets(db)))
    await db.delete(t)
    await db.commit()
    await audit.log_action(db, admin.id, "rbi.target.delete", "rbi_target", t.id, {"key": t.key}, ip)
    await _sync_allow(db, admin, ip, t.key, before=before_allow)
    return {"ok": True}


@router.get("/api/admin/rbi/sessions")
async def admin_sessions(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    by_id = {t.id: t for t in await svc.list_targets(db)}
    return {"sessions": [svc.session_dict(s, by_id.get(s.target_id)) | {"user_id": s.user_id, "client_ip": s.client_ip}
                         for s in await svc.recent_sessions(db)]}


@router.delete("/api/admin/rbi/sessions/{sid}")
async def admin_stop_session(
    sid: str, request: Request,
    admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db),
):
    sess = await db.get(RbiSession, sid)
    if not sess:
        raise HTTPException(status_code=404, detail="세션이 없습니다")
    was_active = sess.status in svc.ACTIVE
    await svc.stop_session(db, sess, "admin")
    if was_active:
        await audit.log_action(db, admin.id, "rbi.session.stop", "rbi_session", sess.id,
                               {"target": sess.target_key, "by_owner": False, "owner": sess.user_id}, _client_ip(request))
    return svc.session_dict(sess, await svc.get_target(db, sess.target_id))
