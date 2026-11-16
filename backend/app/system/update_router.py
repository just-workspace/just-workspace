"""관리 › 업데이트 API.

- `/api/admin/system/update/*`(관리자 전용): 설치 관리자의 업데이트 내부 API(`/internal/update/*`)를 대리 호출한다.
  업데이트의 실제 수행 주체는 설치 관리자이다 — 본 모듈은 권한을 확인하고, 수행 주체(`actor`)를 포함해 전달하며,
  감사 로그를 기록한다. 계약은 docs/update-api.md.
- `/api/internal/system/update-event`(설치 관리자 전용): 카운트다운·점검 모드의 시작과 종료를 수신하면 실시간 소켓으로
  전체 사용자에게 발행하고, 신규 접속 화면이 조회할 수 있도록 저장한다.
- `/api/system/update-notice`(로그인한 모든 사용자): 현재의 사전 공지·점검 모드 상태.

오류 응답은 `{"code", "vars", "detail"}`. 설치 관리자 없이 구성했거나(수동 설치) 설치 관리자가 업데이트 API 를
지원하지 않으면 `update_unavailable`(`vars.reason` = `no_installer` | `unsupported`)이다.
"""

# 주의: from __future__ import annotations 를 추가하지 않는다 — FastAPI 가 본문 인자를 쿼리로 오인한다(app/auth/internal_router.py 참조).
import hmac
import json
import logging
import re
from typing import Any, Callable
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import audit
from app.admin.router import _client_ip, require_admin
from app.admin.settings import delete_setting, get_setting, set_setting
from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.realtime import events
from app.system import installer_client as installer
from app.system.installer_client import InstallerError

logger = logging.getLogger(__name__)

NOTICE_KEY = "system.update.notice"       # 현재의 사전 공지·점검 모드(JSON) — 워커가 복수이므로 DB 에 저장
CONTACT_KEY = "system.update.contact"     # 점검 화면에 표시할 관리자 연락처 한 줄
CONTACT_MAX = 200
UPLOAD_TIMEOUT = 3600.0                   # 오프라인 번들·이미지 업로드
MAINTENANCE_TIMEOUT = 3.0                 # 저장된 사전 공지의 유효 여부를 조회할 때

ACTIONS = ("start_now", "cancel", "retry", "rollback")
EVENT_TYPES = ("countdown", "cancelled", "maintenance", "finished")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+(-beta\.\d+)?$")

MESSAGES = {
    "update_unavailable": "이 설치에서는 여기서 업데이트할 수 없습니다.",
    "installer_unreachable": "설치 관리자에 연결하지 못했습니다.",
    "installer_timeout": "설치 관리자가 제때 응답하지 않았습니다.",
    "installer_rejected": "설치 관리자가 요청을 받아들이지 않았습니다.",
    "installer_error": "설치 관리자에서 오류가 났습니다.",
    "busy": "다른 작업이 진행 중입니다.",
    "action_not_allowed": "지금은 할 수 없는 동작입니다.",
    "not_available": "받을 수 있는 버전이 없습니다.",
    "target_stale": "그 사이 받을 버전이 바뀌었습니다. 다시 확인하세요.",
    "offline_incomplete": "묶음 파일이 검증되지 않았거나 필요한 이미지가 빠져 있습니다.",
    "restore_point_missing": "시험판 이전 백업이 없습니다.",
    "restore_point_unknown": "없는 복원 지점입니다.",
    "job_unknown": "작업을 찾을 수 없습니다.",
    "history_unknown": "기록을 찾을 수 없습니다.",
    "image_unknown": "없는 이미지입니다.",
    "settings_invalid": "설정 값을 확인하세요.",
    "invalid": "요청 형식이 맞지 않습니다.",
    "too_large": "파일이 너무 큽니다.",
    "no_space": "서버에 받을 자리가 모자랍니다.",
}


def unavailable(e: InstallerError) -> InstallerError:
    """설치 관리자 부재·미지원을 화면이 단일 사유로 처리하도록 변환한다. 그 외의 오류는 그대로 반환한다."""
    if e.code == "installer_unavailable":
        return InstallerError(503, "update_unavailable", {"reason": "no_installer"})
    if e.code == "installer_unsupported" or (e.code == "installer_error" and e.vars.get("status") == 501):
        return InstallerError(501, "update_unavailable", {"reason": "unsupported"})
    return e


def _error_response(e: InstallerError) -> JSONResponse:
    e = unavailable(e)
    return JSONResponse({**e.as_dict(), "detail": MESSAGES.get(e.code, e.code)}, status_code=e.status,
                        headers={"Cache-Control": "no-store"})


class UpdateRoute(APIRoute):
    """InstallerError 를 `{code, vars, detail}` 응답으로 변환한다."""

    def get_route_handler(self) -> Callable:
        handler = super().get_route_handler()

        async def wrapped(request: Request) -> Response:
            try:
                return await handler(request)
            except InstallerError as e:
                return _error_response(e)

        return wrapped


router = APIRouter(prefix="/api/admin/system/update", tags=["system"], route_class=UpdateRoute)
public_router = APIRouter(prefix="/api/system", tags=["system"])
internal_router = APIRouter(prefix="/api/internal/system", tags=["internal"])

P = "/internal/update"


def _actor(admin: User) -> dict:
    return {"id": admin.id, "name": admin.display_name or admin.username}


def _safe(value: str, code: str) -> str:
    if not _ID.match(value or ""):
        raise InstallerError(404, code)
    return value


def _dict(body: Any) -> dict:
    return dict(body) if isinstance(body, dict) else {}


async def _audit(db: AsyncSession, admin: User, request: Request, action: str, resource_id: str | None,
                 details: dict) -> None:
    await audit.log_action(db, admin.id, f"system.update.{action}", "update", resource_id, details,
                           _client_ip(request))


# ─── 상태 · 확인 · 설정 ───


@router.get("/status")
async def get_status(admin: User = Depends(require_admin)):
    return await installer.request("GET", f"{P}/status")


@router.post("/check", status_code=202)
async def check_now(admin: User = Depends(require_admin)):
    return await installer.request("POST", f"{P}/check", timeout=installer.PROBE_TIMEOUT)


@router.get("/releases/{version}")
async def get_release(version: str, admin: User = Depends(require_admin)):
    if not _VERSION.match(version):
        raise InstallerError(404, "history_unknown")
    return await installer.request("GET", f"{P}/releases/{version}")


@router.get("/settings")
async def get_update_settings(admin: User = Depends(require_admin)):
    return await installer.request("GET", f"{P}/settings")


@router.put("/settings")
async def put_update_settings(request: Request, response: Response, body: dict = Body(...),
                              admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    sent = {k: body[k] for k in ("mode", "window", "channel", "stable_return") if k in body}
    out = await installer.request("PUT", f"{P}/settings", json={**sent, "actor": _actor(admin)})
    effect = _dict(_dict(out).get("effect"))
    job = _dict(effect.get("job"))
    await _audit(db, admin, request, "settings", None, {**sent, "effect": effect.get("channel")})
    if job.get("id"):
        # 시험판 이전 상태로 복원 — 설정 저장이 곧 복원의 시작임
        await _audit(db, admin, request, "restore", str(job["id"]), {"reason": "beta"})
        response.status_code = 202
    return out


# ─── 적용 · 작업 ───


@router.post("/apply", status_code=202)
async def apply_update(request: Request, body: dict = Body(...), admin: User = Depends(require_admin),
                       db: AsyncSession = Depends(get_db)):
    sent = {"target": body.get("target"), "start": body.get("start") or "countdown"}
    job = await installer.request("POST", f"{P}/apply", json={**sent, "actor": _actor(admin)})
    await _audit(db, admin, request, "apply", str(_dict(job).get("id") or "") or None, sent)
    return job


@router.get("/jobs/{job_id}")
async def get_update_job(job_id: str, admin: User = Depends(require_admin)):
    return await installer.request("GET", f"{P}/jobs/{_safe(job_id, 'job_unknown')}")


@router.post("/jobs/{job_id}/action")
async def job_action(job_id: str, request: Request, body: dict = Body(...), admin: User = Depends(require_admin),
                     db: AsyncSession = Depends(get_db)):
    _safe(job_id, "job_unknown")
    action = body.get("action")
    if action not in ACTIONS:
        raise InstallerError(422, "invalid", {"field": "action"})
    job = await installer.request("POST", f"{P}/jobs/{job_id}/action", json={"action": action, "actor": _actor(admin)})
    await _audit(db, admin, request, action, job_id, {"rollback_job": _dict(job).get("rollback_job")})
    return job


@router.get("/jobs/{job_id}/log")
async def get_update_job_log(job_id: str, tail: int = Query(default=300, ge=1, le=5000),
                             admin: User = Depends(require_admin)):
    data = await installer.request("GET", f"{P}/jobs/{_safe(job_id, 'job_unknown')}/log", params={"tail": tail})
    lines = data.get("lines") if isinstance(data, dict) else None
    return {"lines": [str(x) for x in lines] if isinstance(lines, list) else []}


@router.get("/jobs/{job_id}/log/download")
async def download_update_job_log(job_id: str, admin: User = Depends(require_admin)):
    """기록 다운로드 — 원문 그대로의 전체 기록."""
    _safe(job_id, "job_unknown")
    text = await _raw("GET", f"{P}/jobs/{job_id}/log", params={"format": "text"}, expect_json=False)
    return PlainTextResponse(text, headers={
        "Content-Disposition": f'attachment; filename="update-{job_id}.log"', "Cache-Control": "no-store"})


@router.post("/auto/resume")
async def resume_auto(request: Request, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    out = await installer.request("POST", f"{P}/auto/resume", json={"actor": _actor(admin)})
    await _audit(db, admin, request, "auto_resume", None, {})
    return out


# ─── 복원 지점 ───


@router.get("/restore-points")
async def restore_points(admin: User = Depends(require_admin)):
    return await installer.request("GET", f"{P}/restore-points")


@router.post("/restore", status_code=202)
async def start_restore(request: Request, body: dict = Body(...), admin: User = Depends(require_admin),
                        db: AsyncSession = Depends(get_db)):
    sent = {"point": body.get("point"), "start": body.get("start") or "countdown"}
    if not isinstance(sent["point"], str) or not _ID.match(sent["point"]):
        raise InstallerError(404, "restore_point_unknown")
    job = await installer.request("POST", f"{P}/restore", json={**sent, "actor": _actor(admin)})
    await _audit(db, admin, request, "restore", str(_dict(job).get("id") or "") or None, {**sent, "reason": "manual"})
    return job


# ─── 오프라인 ───


async def _raw(method: str, path: str, *, params: dict | None = None, content: Any = None,
               headers: dict | None = None, timeout: float = installer.DEFAULT_TIMEOUT, expect_json: bool = True):
    """JSON 이 아닌 본문을 송수신하는 호출(파일 업로드, 기록 다운로드). 오류 변환은 installer_client 와 동일하다."""
    if not installer.configured():
        raise InstallerError(503, "installer_unavailable")
    try:
        async with httpx.AsyncClient(base_url=installer.base_url(), timeout=timeout, transport=installer.transport,
                                     follow_redirects=False) as client:
            response = await client.request(method, path, params=params, content=content,
                                            headers={installer.KEY_HEADER: installer.shared_key(), **(headers or {})})
    except httpx.TimeoutException:
        logger.warning("[update] 설치 관리자 응답 없음 — %s %s", method, path)
        raise InstallerError(504, "installer_timeout") from None
    except httpx.HTTPError as e:
        logger.warning("[update] 설치 관리자에 닿지 못함 — %s %s (%s)", method, path, type(e).__name__)
        raise InstallerError(503, "installer_unreachable") from None
    if response.status_code >= 400 or expect_json:
        try:
            parsed = response.json()
        except ValueError:
            parsed = None
        if response.status_code >= 400:
            raise installer._convert(response.status_code, parsed)
        if parsed is None:
            raise InstallerError(502, "installer_error", {"status": response.status_code})
        return parsed
    return response.text


def _upload_headers(request: Request, filename: str) -> dict:
    headers = {"Content-Type": "application/octet-stream", "X-JW-Filename": quote(filename, safe="")}
    length = request.headers.get("content-length")
    if length and length.isdigit():
        headers["Content-Length"] = length
    return headers


def _filename(request: Request) -> str:
    name = request.headers.get("x-jw-filename") or request.query_params.get("filename") or ""
    name = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name or len(name) > 255 or any(ord(c) < 32 for c in name):
        raise InstallerError(422, "invalid", {"field": "filename"})
    return name


@router.get("/offline")
async def offline_state(admin: User = Depends(require_admin)):
    return await installer.request("GET", f"{P}/offline")


@router.post("/offline/bundle", status_code=202)
async def offline_upload_bundle(request: Request, admin: User = Depends(require_admin),
                                db: AsyncSession = Depends(get_db)):
    """오프라인 번들 업로드 — 본문을 메모리에 적재하지 않고 스트림으로 전달한다."""
    name = _filename(request)
    out = await _raw("POST", f"{P}/offline/bundle", content=request.stream(), headers=_upload_headers(request, name),
                     timeout=UPLOAD_TIMEOUT)
    await _audit(db, admin, request, "offline_bundle", None, {"source": "upload", "filename": name})
    return out


@router.post("/offline/bundle-path", status_code=202)
async def offline_bundle_path(request: Request, body: dict = Body(...), admin: User = Depends(require_admin),
                              db: AsyncSession = Depends(get_db)):
    path = body.get("path")
    if not isinstance(path, str) or not path.strip() or len(path) > 4096 or "\x00" in path:
        raise InstallerError(422, "invalid", {"field": "path"})
    out = await installer.request("POST", f"{P}/offline/bundle-path", json={"path": path.strip(), "actor": _actor(admin)},
                                  timeout=installer.PROBE_TIMEOUT)
    await _audit(db, admin, request, "offline_bundle", None, {"source": "path", "path": path.strip()})
    return out


@router.delete("/offline/bundle")
async def offline_clear(request: Request, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    out = await installer.request("DELETE", f"{P}/offline/bundle")
    await _audit(db, admin, request, "offline_clear", None, {})
    return out


@router.post("/offline/images/{image_id}", status_code=202)
async def offline_upload_image(image_id: str, request: Request, admin: User = Depends(require_admin),
                               db: AsyncSession = Depends(get_db)):
    _safe(image_id, "image_unknown")
    name = _filename(request)
    out = await _raw("POST", f"{P}/offline/images/{image_id}", content=request.stream(),
                     headers=_upload_headers(request, name), timeout=UPLOAD_TIMEOUT)
    await _audit(db, admin, request, "offline_image", image_id, {"filename": name})
    return out


@router.post("/offline/apply", status_code=202)
async def offline_apply(request: Request, body: dict | None = Body(default=None), admin: User = Depends(require_admin),
                        db: AsyncSession = Depends(get_db)):
    sent = {"start": _dict(body).get("start") or "countdown"}
    job = await installer.request("POST", f"{P}/offline/apply", json={**sent, "actor": _actor(admin)})
    await _audit(db, admin, request, "offline_apply", str(_dict(job).get("id") or "") or None, sent)
    return job


# ─── 기록 · 앱 ───


@router.get("/history")
async def history(limit: int = Query(default=50, ge=1, le=200), before: str | None = None,
                  admin: User = Depends(require_admin)):
    params: dict = {"limit": limit}
    if before:
        params["before"] = _safe(before, "history_unknown")
    return await installer.request("GET", f"{P}/history", params=params)


@router.get("/history/{entry_id}")
async def history_entry(entry_id: str, admin: User = Depends(require_admin)):
    return await installer.request("GET", f"{P}/history/{_safe(entry_id, 'history_unknown')}")


@router.get("/apps")
async def apps(admin: User = Depends(require_admin)):
    return await installer.request("GET", f"{P}/apps")


# ─── 점검 화면의 연락처 ───


def clean_contact(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise InstallerError(422, "invalid", {"field": "contact"})
    text = " ".join(value.split())
    if len(text) > CONTACT_MAX:
        raise InstallerError(422, "invalid", {"field": "contact", "max": CONTACT_MAX})
    return text or None


@router.get("/contact")
async def get_contact(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    return {"contact": await get_setting(db, CONTACT_KEY) or None}


@router.put("/contact")
async def put_contact(request: Request, body: dict = Body(...), admin: User = Depends(require_admin),
                      db: AsyncSession = Depends(get_db)):
    """연락처는 본 모듈(DB)에 저장하고 설치 관리자에도 전달한다 — backend 가 중지된 동안의 점검 화면이 설치 관리자에서 조회한다."""
    contact = clean_contact(body.get("contact"))
    if contact:
        await set_setting(db, CONTACT_KEY, contact)
    else:
        await delete_setting(db, CONTACT_KEY)
    synced = True
    try:
        await installer.request("PUT", f"{P}/maintenance/contact", json={"contact": contact})
    except InstallerError as e:
        synced = False
        logger.info("[update] 연락처를 설치 관리자에 넘기지 못했습니다(%s)", unavailable(e).code)
    await _audit(db, admin, request, "contact", None, {"set": bool(contact), "synced": synced})
    return {"contact": contact, "synced": synced}


# ─── 사전 공지 · 점검 모드 상태(로그인한 모든 사용자) ───


NONE_NOTICE = {"state": "none", "job": None, "kind": None, "ends_at": None, "started_at": None,
               "expected_seconds": None}


async def _stored_notice(db: AsyncSession) -> dict | None:
    raw = await get_setting(db, NOTICE_KEY)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    if not isinstance(data, dict) or data.get("state") not in ("countdown", "maintenance"):
        await delete_setting(db, NOTICE_KEY)
        return None
    return data


async def _still_active() -> bool | None:
    """저장된 사전 공지·점검 모드의 유효 여부 — 설치 관리자의 공개 점검 상태. 조회할 수 없으면 None."""
    try:
        live = await installer.request("GET", f"{P}/maintenance", timeout=MAINTENANCE_TIMEOUT)
    except InstallerError:
        return None
    if not isinstance(live, dict):
        return None
    return bool(live.get("active")) or live.get("phase") == "countdown"


@public_router.get("/update-notice")
async def update_notice(response: Response, user: User = Depends(get_current_user),
                        db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    contact = await get_setting(db, CONTACT_KEY) or None
    notice = await _stored_notice(db)
    if notice is not None and await _still_active() is False:
        # 종료 알림을 수신하지 못한 경우 — 화면이 고착되지 않도록 삭제
        await delete_setting(db, NOTICE_KEY)
        notice = None
    if notice is None:
        return {**NONE_NOTICE, "contact": contact}
    return {**NONE_NOTICE, **{k: notice.get(k) for k in NONE_NOTICE}, "contact": contact}


# ─── 설치 관리자 → backend 알림 ───


def _require_installer_key(key: str | None) -> None:
    expected = installer.shared_key()
    if not expected:
        # 설치 관리자 없이 구성한 설치 — 이 경로는 존재하지 않는 것으로 처리
        raise HTTPException(status_code=404, detail="Not found")
    if not key or not hmac.compare_digest(key.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Invalid installer key")


def _text(value: Any, limit: int = 64) -> str | None:
    return value[:limit] if isinstance(value, str) and value else None


def _seconds(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None


RESULT_TITLES = {
    "success": "자동 업데이트를 마쳤습니다",
    "rolled_back": "자동 업데이트가 실패해 이전 버전으로 되돌렸습니다",
    "rollback_failed": "자동 업데이트와 되돌림이 모두 실패했습니다",
}


async def _notify_admins(db: AsyncSession, result: str, version: str | None, from_version: str | None) -> int:
    """야간 자동 업데이트의 결과를 관리자 전원의 알림에 1건씩 기록한다."""
    from app.notifications.service import create_notification

    title = RESULT_TITLES.get(result)
    if title is None:
        return 0
    if result == "success":
        body = f"{version} 으로 업데이트했습니다." if version else None
    else:
        now = f"지금은 {from_version} 입니다. " if from_version else ""
        body = f"{now}자동 업데이트는 멈춰 있습니다. 관리 › 업데이트에서 기록을 확인하고 다시 켭니다."
    admin_ids = (await db.execute(
        select(User.id).where(User.is_admin == True, User.is_active == True)  # noqa: E712
    )).scalars().all()
    for user_id in admin_ids:
        await create_notification(db, user_id, "system", title, body=body, link="/admin/update")
    return len(admin_ids)


@internal_router.post("/update-event")
async def update_event(body: dict = Body(...), x_jw_installer_key: str | None = Header(default=None),
                       db: AsyncSession = Depends(get_db)):
    _require_installer_key(x_jw_installer_key)
    kind = body.get("type")
    if kind not in EVENT_TYPES:
        raise HTTPException(status_code=422, detail="unknown event type")
    job, job_kind = _text(body.get("job")), _text(body.get("kind"), 16)
    expected = _seconds(body.get("expected_seconds"))

    if kind == "countdown":
        ends_at = _text(body.get("ends_at"), 40)
        if not ends_at:
            raise HTTPException(status_code=422, detail="ends_at required")
        notice = {"state": "countdown", "job": job, "kind": job_kind, "ends_at": ends_at, "started_at": None,
                  "expected_seconds": expected}
        await set_setting(db, NOTICE_KEY, json.dumps(notice))
        event = {"type": "system.update_countdown", "job": job, "kind": job_kind, "ends_at": ends_at,
                 "expected_seconds": expected}
    elif kind == "cancelled":
        await delete_setting(db, NOTICE_KEY)
        event = {"type": "system.update_cancelled", "job": job}
    elif kind == "maintenance":
        started_at = _text(body.get("started_at"), 40)
        notice = {"state": "maintenance", "job": job, "kind": job_kind, "ends_at": None, "started_at": started_at,
                  "expected_seconds": expected}
        await set_setting(db, NOTICE_KEY, json.dumps(notice))
        event = {"type": "system.maintenance", "active": True, "kind": job_kind, "started_at": started_at,
                 "expected_seconds": expected}
    else:
        result = _text(body.get("result"), 32)
        await delete_setting(db, NOTICE_KEY)
        event = {"type": "system.maintenance", "active": False, "result": result}
        if body.get("trigger") == "auto" and result:
            try:
                await _notify_admins(db, result, _text(body.get("version"), 40), _text(body.get("from_version"), 40))
            except Exception as e:  # noqa: BLE001 — 알림 기록에 실패해도 발행은 수행
                logger.warning("[update] 관리자 알림을 남기지 못했습니다(%s)", type(e).__name__)

    delivered = True
    try:
        await events.emit_to_all(event)
    except Exception as e:  # noqa: BLE001 — 발행에 실패해도 저장된 상태는 조회로 전달됨
        delivered = False
        logger.warning("[update] 실시간 방송 실패(%s)", type(e).__name__)
    logger.info("[update] 알림 %s job=%s", kind, job)
    return {"ok": True, "delivered": delivered}
