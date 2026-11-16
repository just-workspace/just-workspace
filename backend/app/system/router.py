"""관리 › 구역 · 저장소 · 인증서 API.

- `/api/admin/system/*`(관리자 전용): 구역 목록·활성화·비활성화·설정·재연결, 작업 목록·진행, 연결 확인, 저장소 상태,
  인증서 상태·재발급.
  구역의 실제 변경은 설치 관리자가 수행한다 — 본 모듈은 권한을 확인하고 내부 API 를 대리 호출한 뒤
  감사 로그를 기록한다(app/system/installer_client.py).
- `/api/system/storage-status`(로그인한 모든 사용자): 파일 탭이 "저장소가 끊겼는가"만 확인하는 경량 조회.

오류 응답은 `{"code", "vars", "detail"}` — 화면은 code 로 문구를 선택한다.

설치 관리자 없이 구성한 설치에서는 `GET /zones` 가 선언(zones.json)과 `JW_ZONES` 만으로 읽기 전용 목록을
반환하고(`installer.available = false`), 나머지 구역 API 는 전부 503 `installer_unavailable` 이다.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app import zones as zone_decl
from app.admin import audit
from app.admin.router import _client_ip, require_admin
from app.admin.settings import delete_setting, get_setting, get_settings_by_prefix, set_setting
from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.modules.registry import BUILTIN_MODULES
from app.system import installer_client as installer
from app.system import storage_status
from app.system.installer_client import InstallerError

logger = logging.getLogger(__name__)

JOB_KEY_PREFIX = "system.zonejob."         # 이전에 작업 id 를 기록하던 키 — 잔여 항목은 목록 조회 시 삭제
DISMISSED_KEY_PREFIX = JOB_KEY_PREFIX + "dismissed."      # 구역별 표시 해제 작업 id(종료된 작업의 표시를 닫은 경우)
DOWN_SINCE_KEY = "system.storage.down_since"
DONE_JOB_KEEP = timedelta(minutes=10)      # 종료된 작업을 목록에 "방금 켰습니다"로 유지하는 시간
SECRET_FIELDS = ("password", "api_key")
CERT_PEM_MAX = 1024 * 1024                 # 업로드하는 인증서·개인 키 문자 수의 상한(각각)
REDACTED = "***"

MESSAGES = {
    "installer_unavailable": "이 설치는 설치 관리자 없이 구성돼 여기서 구역을 바꿀 수 없습니다.",
    "installer_unreachable": "설치 관리자에 연결하지 못했습니다.",
    "installer_timeout": "설치 관리자가 제때 응답하지 않았습니다.",
    "installer_rejected": "설치 관리자가 요청을 받아들이지 않았습니다.",
    "installer_unsupported": "이 설치 관리자는 이 확인을 지원하지 않습니다.",
    "installer_error": "설치 관리자에서 오류가 났습니다.",
    "zone_unknown": "없는 구역입니다.",
    "busy": "다른 작업이 진행 중입니다.",
    "memory_insufficient": "서버 메모리가 모자라 켤 수 없습니다.",
    "settings_invalid": "설정 값을 확인하세요.",
    "already_enabled": "이미 켜져 있습니다.",
    "not_enabled": "꺼져 있는 구역입니다.",
    "job_unknown": "작업을 찾을 수 없습니다.",
    "not_pending": "보류된 연결이 없습니다.",
    "not_installed": "설치가 끝나지 않았습니다.",
    "cert_managed_by_proxy": "이 설치의 인증서는 앞단 프록시가 맡습니다.",
    "cert_invalid": "올린 인증서를 쓸 수 없습니다.",
    "cert_auto_needs_domain": "인증서 자동 발급은 접속 주소가 도메인일 때만 됩니다.",
    "cert_ca_needs_upload": "CA 인증서는 올린 인증서를 쓰는 설치에서만 더할 수 있습니다.",
    "file_too_large": "파일이 너무 큽니다.",
}


def _error_response(e: InstallerError) -> JSONResponse:
    return JSONResponse({**e.as_dict(), "detail": MESSAGES.get(e.code, e.code)}, status_code=e.status,
                        headers={"Cache-Control": "no-store"})


class SystemRoute(APIRoute):
    """InstallerError 를 `{code, vars, detail}` 응답으로 변환한다."""

    def get_route_handler(self) -> Callable:
        handler = super().get_route_handler()

        async def wrapped(request: Request) -> Response:
            try:
                return await handler(request)
            except InstallerError as e:
                return _error_response(e)

        return wrapped


router = APIRouter(prefix="/api/admin/system", tags=["system"], route_class=SystemRoute)
public_router = APIRouter(prefix="/api/system", tags=["system"])


class SettingsBody(BaseModel):
    settings: dict[str, Any] | None = None


# ─── 마스킹 ───


def redact(value: Any) -> Any:
    """감사 로그에 기록할 사본 — 비밀값은 마스킹한다."""
    if isinstance(value, dict):
        return {k: (REDACTED if k in SECRET_FIELDS and v not in (None, "") else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def strip_secrets(settings: Any) -> Any:
    """조회 응답에서 비밀값을 제외한다 — 설정 여부만 `<이름>_set` 으로 전달한다."""
    if not isinstance(settings, dict):
        return settings
    out = dict(settings)
    for name in SECRET_FIELDS:
        if name in out:
            value = out.pop(name)
            out[f"{name}_set"] = bool(out.get(f"{name}_set")) or bool(value)
    return out


# ─── 구역 목록 ───


def _zone_or_404(zone_id: str) -> str:
    if zone_id not in zone_decl.all_zone_ids():
        raise InstallerError(404, "zone_unknown", {"zone": zone_id})
    return zone_id


def _menu_modules() -> set[str]:
    # 활성화 즉시 메뉴에 표시되는 모듈 — 기본 활성화 대상만 해당
    return {m["id"] for m in BUILTIN_MODULES if m.get("route") and m.get("default_enabled")}


def _row(declared: dict, kind: str, live: dict | None, enabled: bool) -> dict:
    live = live or {}
    memory = live.get("memory_mb") or declared.get("memory_mb") or {}
    return {
        "id": declared["id"],
        "kind": kind,
        "name": live.get("name") or declared.get("name") or {},
        "summary": live.get("summary") or declared.get("summary") or {},
        "recommend_mb": int(memory.get("recommend") or 0),
        "ports": list(live.get("ports", declared.get("ports", []))),
        "enabled": enabled,
        "has_settings": bool(live.get("has_settings")),
        "fits": live.get("fits"),
        # 활성화되어 있으나 로그인 연동이 보류된 구역(신뢰되는 인증서가 확보되면 재연결 가능)
        "pending": bool(live.get("pending")),
        "pending_reason": live.get("pending_reason") if isinstance(live.get("pending_reason"), str) else None,
        "menu": bool(set(declared.get("modules", [])) & _menu_modules()),
        "job": None,
    }


def build_listing(listing: dict | None) -> dict:
    """선언(zones.json)에 설치 관리자의 상태를 병합한다. listing 이 None 이면 `JW_ZONES` 만 사용한다."""
    declared = zone_decl.load_zones()
    installed = zone_decl.installed_zones()
    live = {r["id"]: r for r in ((listing or {}).get("zones", []) + (listing or {}).get("addons", []))
            if isinstance(r, dict) and "id" in r}

    def rows(key: str, kind: str) -> list[dict]:
        out = []
        for z in declared.get(key, []):
            found = live.get(z["id"])
            enabled = bool(found.get("enabled")) if found is not None else z["id"] in installed
            out.append(_row(z, kind, found, enabled))
        return out

    zone_rows, addon_rows = rows("zones", "zone"), rows("addons", "addon")
    core_mb = int(declared["core"].get("memory_mb", {}).get("recommend") or 0)
    memory = (listing or {}).get("memory")
    if not isinstance(memory, dict):
        need = core_mb + sum(r["recommend_mb"] for r in (*zone_rows, *addon_rows) if r["enabled"])
        memory = {"need_mb": need, "have_mb": None, "nominal_mb": None, "ok": None}
    return {
        "core": {"name": declared["core"].get("name", {}), "recommend_mb": core_mb},
        "memory": {k: memory.get(k) for k in ("need_mb", "have_mb", "nominal_mb", "ok")},
        "zones": zone_rows,
        "addons": addon_rows,
    }


def _job_view(job: dict) -> dict:
    out = {k: job.get(k) for k in ("id", "kind", "zone", "status", "stages", "error", "warnings", "ports",
                                   "started_at", "finished_at")}
    for key in ("stages", "warnings", "ports"):      # 인증서 작업처럼 포트가 없는 작업도 동일 형태로 정규화
        if not isinstance(out[key], list):
            out[key] = []
    return out


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def _recent_jobs() -> list[dict]:
    """설치 관리자가 보관하는 작업 — 진행 중인 작업과 최근 작업, 최신순."""
    data = await installer.request("GET", "/internal/jobs")
    jobs = data.get("jobs") if isinstance(data, dict) else None
    if not isinstance(jobs, list):
        return []
    views = [_job_view(j) for j in jobs if isinstance(j, dict) and isinstance(j.get("id"), str)]
    return sorted(views, key=lambda j: j.get("started_at") or "", reverse=True)


def _latest_by_zone(jobs: list[dict]) -> dict[str, dict]:
    latest: dict[str, dict] = {}
    for job in jobs:
        zone = job.get("zone")
        if isinstance(zone, str) and zone not in latest:      # 인증서 작업(zone 없음)은 구역 행에 연결하지 않음
            latest[zone] = job
    return latest


async def _attach_jobs(db: AsyncSession, listing: dict) -> None:
    """구역별 최신 작업을 행에 병합한다 — 화면을 다시 열어도 진행 중인 작업과 직전에 종료된 작업이 표시되도록 한다.

    작업은 설치 관리자가 보관한다. 본 모듈이 보관하는 것은 표시 해제한 작업 id 뿐이다.
    """
    try:
        latest = _latest_by_zone(await _recent_jobs())
    except InstallerError as e:
        logger.info("[system] 작업 목록을 읽지 못했습니다(%s)", e.code)
        return
    dismissed: dict[str, str] = {}
    for key, value in (await get_settings_by_prefix(db, JOB_KEY_PREFIX)).items():
        if key.startswith(DISMISSED_KEY_PREFIX):
            dismissed[key[len(DISMISSED_KEY_PREFIX):]] = value
        else:
            await delete_setting(db, key)
    now = datetime.now(timezone.utc)
    for row in (*listing["zones"], *listing["addons"]):
        job = latest.get(row["id"])
        if job is None or dismissed.get(row["id"]) == job["id"]:
            continue
        if job.get("status") == "done":
            finished = _parse_time(job.get("finished_at")) or _parse_time(job.get("started_at"))
            if finished is None or now - finished > DONE_JOB_KEEP:
                continue
        row["job"] = job
    for zone_id, job_id in dismissed.items():      # 해당 구역에 새 작업이 생성되었으면 표시 해제 기록은 불필요
        if zone_id not in latest or latest[zone_id]["id"] != job_id:
            await delete_setting(db, DISMISSED_KEY_PREFIX + zone_id)


@router.get("/zones")
async def list_zones(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    reason = None
    listing = None
    if not installer.configured():
        reason = "not_configured"
    else:
        try:
            listing = await installer.request("GET", "/internal/zones")
        except InstallerError as e:
            reason = e.code
    out = build_listing(listing if isinstance(listing, dict) else None)
    out["installer"] = {"available": reason is None, "reason": reason}
    verified = listing.get("git_verified_version") if isinstance(listing, dict) else None
    out["git_verified_version"] = verified if isinstance(verified, str) and verified else None
    if reason is None:
        await _attach_jobs(db, out)
    return out


@router.post("/zones/{zone_id}/check")
async def check_zone(zone_id: str, body: SettingsBody | None = None, admin: User = Depends(require_admin)):
    _zone_or_404(zone_id)
    return await installer.request("POST", f"/internal/zones/{zone_id}/check",
                                   json={"settings": body.settings if body else None})


@router.post("/zones/{zone_id}/enable", status_code=202)
async def enable_zone(zone_id: str, request: Request, body: SettingsBody | None = None,
                      admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    _zone_or_404(zone_id)
    settings = body.settings if body else None
    job = _job_view(await installer.request("POST", f"/internal/zones/{zone_id}/enable", json={"settings": settings}))
    await audit.log_action(db, admin.id, "system.zone.enable", "zone", zone_id,
                           {"job": job.get("id"), "settings": redact(settings or {})}, _client_ip(request))
    return job


@router.post("/zones/{zone_id}/disable", status_code=202)
async def disable_zone(zone_id: str, request: Request, admin: User = Depends(require_admin),
                       db: AsyncSession = Depends(get_db)):
    _zone_or_404(zone_id)
    job = _job_view(await installer.request("POST", f"/internal/zones/{zone_id}/disable"))
    await audit.log_action(db, admin.id, "system.zone.disable", "zone", zone_id, {"job": job.get("id")},
                           _client_ip(request))
    return job


@router.delete("/zones/{zone_id}/job")
async def dismiss_zone_job(zone_id: str, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """종료된 작업(실패·완료 직후)의 표시를 해제한다 — "꺼진 채로 두기"."""
    _zone_or_404(zone_id)
    job = _latest_by_zone(await _recent_jobs()).get(zone_id)
    if job is not None and job.get("status") != "running":
        await set_setting(db, DISMISSED_KEY_PREFIX + zone_id, job["id"])
    return {"ok": True}


@router.post("/zones/{zone_id}/reconnect", status_code=202)
async def reconnect_zone(zone_id: str, request: Request, admin: User = Depends(require_admin),
                         db: AsyncSession = Depends(get_db)):
    """보류된 연결(코드 저장소의 로그인 연동)을 재시도한다."""
    _zone_or_404(zone_id)
    job = _job_view(await installer.request("POST", f"/internal/zones/{zone_id}/reconnect"))
    await audit.log_action(db, admin.id, "system.zone.reconnect", "zone", zone_id, {"job": job.get("id")},
                           _client_ip(request))
    return job


@router.get("/zones/{zone_id}/settings")
async def get_zone_settings(zone_id: str, admin: User = Depends(require_admin)):
    _zone_or_404(zone_id)
    data = await installer.request("GET", f"/internal/zones/{zone_id}/settings")
    if isinstance(data, dict):
        data["settings"] = strip_secrets(data.get("settings"))
    return data


@router.put("/zones/{zone_id}/settings", status_code=202)
async def put_zone_settings(zone_id: str, body: SettingsBody, request: Request,
                            admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    _zone_or_404(zone_id)
    job = _job_view(await installer.request("PUT", f"/internal/zones/{zone_id}/settings",
                                            json={"settings": body.settings or {}}))
    await audit.log_action(db, admin.id, "system.zone.settings", "zone", zone_id,
                           {"job": job.get("id"), "settings": redact(body.settings or {})}, _client_ip(request))
    return job


# ─── 작업 ───


def _job_id(job_id: str) -> str:
    if not (0 < len(job_id) <= 64 and job_id.isalnum()):
        raise InstallerError(404, "job_unknown")
    return job_id


@router.get("/jobs")
async def list_jobs(admin: User = Depends(require_admin)):
    """진행 중인 작업과 최근 작업(구역 활성화·비활성화·설정·재연결, 인증서) — 최신순."""
    return {"jobs": await _recent_jobs()}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, admin: User = Depends(require_admin)):
    return _job_view(await installer.request("GET", f"/internal/jobs/{_job_id(job_id)}"))


@router.get("/jobs/{job_id}/log")
async def get_job_log(job_id: str, tail: int = Query(default=300, ge=1, le=5000),
                      admin: User = Depends(require_admin)):
    data = await installer.request("GET", f"/internal/jobs/{_job_id(job_id)}/log", params={"tail": tail})
    lines = data.get("lines") if isinstance(data, dict) else None
    return {"lines": [str(x) for x in lines] if isinstance(lines, list) else []}


# ─── 연결 확인 ───


@router.post("/probe/smtp")
async def probe_smtp(body: dict[str, Any] | None = None, admin: User = Depends(require_admin)):
    """외부 발신 서버 로그인 확인. 비밀번호가 비어 있으면 설치 관리자에 저장된 값을 사용한다."""
    return await installer.request("POST", "/internal/probe/smtp", json=body or {}, timeout=installer.PROBE_TIMEOUT)


@router.post("/probe/ai")
async def probe_ai(body: dict[str, Any] | None = None, admin: User = Depends(require_admin)):
    """AI 제공자 키 확인. 키가 비어 있으면 설치 관리자에 저장된 값을 사용한다."""
    return await installer.request("POST", "/internal/probe/ai", json=body or {}, timeout=installer.PROBE_TIMEOUT)


@router.post("/probe/mail-records")
async def probe_mail_records(body: dict[str, Any] | None = None, admin: User = Depends(require_admin)):
    """메일 도메인에 등록할 레코드와 현재 값. 설치 관리자가 해당 확인을 내부 API 로 제공하지 않으면 501."""
    return await installer.request("POST", "/internal/probe/mail-records", json=body or {},
                                   timeout=installer.PROBE_TIMEOUT)


@router.get("/probe/public-ip")
async def probe_public_ip(refresh: bool = False, admin: User = Depends(require_admin)):
    """공인 주소 감지값. 내부 API 에 감지 경로가 없으면 설치 시 감지한 값을 반환한다."""
    try:
        return await installer.request("GET", "/internal/probe/public-ip", params={"refresh": str(refresh).lower()},
                                       timeout=installer.PROBE_TIMEOUT)
    except InstallerError as e:
        if e.code != "installer_unsupported":
            raise
    data = await installer.request("GET", "/internal/zones/meetings/settings")
    detected = data.get("detected") if isinstance(data, dict) else None
    ip = detected.get("public_ip") if isinstance(detected, dict) else None
    return {"status": "detected" if ip else "unknown", "ip": ip or None, "source": "cached"}


# ─── 인증서 ───

CERT_FIELDS = ("managed", "mode", "temporary", "domain", "names", "not_after", "days_left", "issuer", "self_signed",
               "site_ca", "ca_uploadable", "pending", "renewal")


class CertReissueBody(BaseModel):
    mode: Literal["auto", "upload"]
    cert: str | None = None      # PEM 문자열(mode = upload)
    key: str | None = None
    ca: str | None = None        # (선택) 사설 CA 가 발급한 인증서일 때 해당 CA 인증서 — 인증서 파일에 체인이 없을 때만 필요


class CertCaBody(BaseModel):
    ca: str = ""                 # PEM 문자열. 빈 값이면 별도 업로드한 CA 인증서를 제거


def _cert_view(data: Any) -> dict:
    data = data if isinstance(data, dict) else {}
    out = {k: data.get(k) for k in CERT_FIELDS}
    for key in ("names", "pending"):
        out[key] = [str(x) for x in out[key]] if isinstance(out[key], list) else []
    for key in ("site_ca", "ca_uploadable"):          # 구버전 설치 관리자는 이 값을 반환하지 않음
        out[key] = bool(out[key])
    job = data.get("job")
    out["job"] = _job_view(job) if isinstance(job, dict) else None
    return out


@router.get("/cert")
async def get_cert(admin: User = Depends(require_admin)):
    """접속 주소의 인증서 — 종류, 만료, 발급자, 포함된 이름, 인증서로 인해 연결이 보류된 구역, 진행 중인 작업."""
    return _cert_view(await installer.request("GET", "/internal/cert"))


@router.post("/cert/reissue", status_code=202)
async def reissue_cert(body: CertReissueBody, request: Request, admin: User = Depends(require_admin),
                       db: AsyncSession = Depends(get_db)):
    """재발급(auto) 또는 업로드한 인증서로 교체(upload). 실패 시 기존 인증서가 유지된다."""
    payload: dict[str, Any] = {"mode": body.mode}
    if body.mode == "upload":
        cert, key, ca = body.cert or "", body.key or "", body.ca or ""
        if len(cert) > CERT_PEM_MAX or len(key) > CERT_PEM_MAX or len(ca) > CERT_PEM_MAX:
            raise InstallerError(413, "file_too_large", {"max_bytes": CERT_PEM_MAX})
        payload.update(cert=cert, key=key)
        if ca.strip():
            payload["ca"] = ca
    job = _job_view(await installer.request("POST", "/internal/cert/reissue", json=payload))
    # 변경 주체와 시각만 기록(인증서·개인 키 내용은 기록하지 않음)
    await audit.log_action(db, admin.id, "system.cert.reissue", "cert", None,
                           {"job": job.get("id"), "mode": body.mode}, _client_ip(request))
    return job


@router.post("/cert/ca", status_code=202)
async def set_cert_ca(body: CertCaBody, request: Request, admin: User = Depends(require_admin),
                      db: AsyncSession = Depends(get_db)):
    """업로드한 인증서의 발급 CA 인증서만 추가한다(빈 값이면 제거한다) — 사설 CA 가 발급한 인증서를 한 장만 업로드하여
    코드 저장소의 로그인 연동이 보류로 남은 경우에 사용한다. 인증서·개인 키는 변경하지 않는다."""
    if len(body.ca) > CERT_PEM_MAX:
        raise InstallerError(413, "file_too_large", {"max_bytes": CERT_PEM_MAX})
    job = _job_view(await installer.request("POST", "/internal/cert/ca", json={"ca": body.ca}))
    await audit.log_action(db, admin.id, "system.cert.ca", "cert", None,
                           {"job": job.get("id"), "removed": not body.ca.strip()}, _client_ip(request))
    return job


# ─── 저장소 ───

_seen_down: bool | None = None      # 이 프로세스가 마지막으로 확인한 상태(단절 시각을 상태 변경 시에만 기록하기 위함)


async def _down_since(db: AsyncSession, down: bool, at: str | None) -> str | None:
    """단절 시각 — 단절을 최초 확인한 시점에 기록하고, 복구되면 삭제한다."""
    global _seen_down
    stored = await get_setting(db, DOWN_SINCE_KEY)
    if down and not stored:
        stored = at or storage_status.now_iso()
        await set_setting(db, DOWN_SINCE_KEY, stored)
    elif not down and stored:
        await delete_setting(db, DOWN_SINCE_KEY)
        stored = None
    _seen_down = down
    return stored


async def _storage(db: AsyncSession, force: bool) -> dict:
    status = await storage_status.prober.status(force=force)
    # 종류·위치는 설치 관리자가 보유한 값이 정확함(호스트 폴더, NFS 주소). 수신 실패 시 마운트 정보에서 읽은 값을 유지
    status.update(await storage_status.installed_description(force=force))
    status["down_since"] = await _down_since(db, status["state"] == "down", status.get("checked_at"))
    return status


@router.get("/storage")
async def get_storage(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    return await _storage(db, force=False)


@router.post("/storage/recheck")
async def recheck_storage(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    return await _storage(db, force=True)


@public_router.get("/storage-status")
async def storage_status_public(response: Response, user: User = Depends(get_current_user),
                                db: AsyncSession = Depends(get_db)):
    """파일 탭·관리자 알림 띠용 — 저장소 접근 가능 여부만 확인한다. 저장소 마커 확인을 활성화하지 않은 설치는 항상 available 이다."""
    response.headers["Cache-Control"] = "no-store"
    prober = storage_status.light_prober
    if not prober.guarded:
        return {"guarded": False, "available": True, "reason": None}
    result = await prober.check()
    down = result.get("reason") is not None
    if _seen_down is not down:
        try:
            await _down_since(db, down, result.get("checked_at"))
        except Exception as e:  # noqa: BLE001 — 시각 기록에 실패해도 상태는 응답
            logger.warning("[system] 저장소 끊긴 시각을 적지 못했습니다(%s)", type(e).__name__)
    return {"guarded": True, "available": not down, "reason": result.get("reason")}
