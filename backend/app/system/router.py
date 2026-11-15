"""관리 › 구역 · 저장소 API.

- `/api/admin/system/*`(관리자만): 구역 목록·켜기·끄기·설정, 작업 진행, 연결 확인, 저장소 상태.
  구역을 실제로 바꾸는 일은 설치 관리자가 한다 — 여기서는 권한을 확인하고 내부 API 를 대신 부른 뒤
  감사 로그를 남긴다(app/system/installer_client.py).
- `/api/system/storage-status`(로그인한 누구나): 파일 탭이 "저장소가 끊겼는가"만 묻는 가벼운 조회.

오류 응답은 `{"code", "vars", "detail"}` — 화면은 code 로 문구를 고른다.

설치 관리자 없이 구성한 설치에서는 `GET /zones` 가 선언(zones.json)과 `JW_ZONES` 만으로 읽기 전용 목록을
주고(`installer.available = false`), 나머지 구역 API 는 전부 503 `installer_unavailable` 이다.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

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

JOB_KEY_PREFIX = "system.zonejob."
DOWN_SINCE_KEY = "system.storage.down_since"
DONE_JOB_KEEP = timedelta(minutes=10)      # 끝난 작업을 목록에 "방금 켰습니다"로 남겨 두는 시간
SECRET_FIELDS = ("password", "api_key")
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
}


def _error_response(e: InstallerError) -> JSONResponse:
    return JSONResponse({**e.as_dict(), "detail": MESSAGES.get(e.code, e.code)}, status_code=e.status,
                        headers={"Cache-Control": "no-store"})


class SystemRoute(APIRoute):
    """InstallerError 를 `{code, vars, detail}` 응답으로 바꾼다."""

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


# ─── 가림 ───


def redact(value: Any) -> Any:
    """감사 로그에 남길 사본 — 비밀값은 가린다."""
    if isinstance(value, dict):
        return {k: (REDACTED if k in SECRET_FIELDS and v not in (None, "") else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def strip_secrets(settings: Any) -> Any:
    """조회 응답에서 비밀값을 뺀다 — 넣어 둔 것이 있는지만 `<이름>_set` 으로 알려 준다."""
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
    # 켜자마자 메뉴에 나타나는 모듈 — 기본으로 켜져 있는 것만
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
        "menu": bool(set(declared.get("modules", [])) & _menu_modules()),
        "job": None,
    }


def build_listing(listing: dict | None) -> dict:
    """선언(zones.json)에 설치 관리자의 상태를 얹는다. listing 이 None 이면 `JW_ZONES` 만으로."""
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
    return {k: job.get(k) for k in ("id", "kind", "zone", "status", "stages", "error", "warnings", "ports",
                                    "started_at", "finished_at")}


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def _track(db: AsyncSession, zone_id: str, job: dict, admin: User) -> None:
    await set_setting(db, JOB_KEY_PREFIX + zone_id, json.dumps(
        {"id": job.get("id"), "kind": job.get("kind"), "by": admin.id, "at": storage_status.now_iso()}))


async def _attach_jobs(db: AsyncSession, listing: dict) -> None:
    """이 화면에서 시작한 작업을 행에 붙인다 — 화면을 떠났다 돌아와도 진행을 이어 받게."""
    tracked: dict[str, dict] = {}
    for key, raw in (await get_settings_by_prefix(db, JOB_KEY_PREFIX)).items():
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        if isinstance(data, dict) and isinstance(data.get("id"), str):
            tracked[key[len(JOB_KEY_PREFIX):]] = data
        else:
            await delete_setting(db, key)
    if not tracked:
        return

    async def fetch(zone_id: str, ref: dict) -> tuple[str, dict | None, bool]:
        try:
            return zone_id, _job_view(await installer.request("GET", f"/internal/jobs/{ref['id']}")), False
        except InstallerError as e:
            if e.code == "job_unknown":
                return zone_id, None, True
            # 설치 관리자가 잠깐 안 닿는다(backend 를 다시 띄우는 중일 수 있다) — 지우지 않고 모름으로 둔다
            return zone_id, {"id": ref["id"], "kind": ref.get("kind"), "zone": zone_id, "status": "unknown",
                             "stages": [], "error": None, "warnings": [], "ports": [],
                             "started_at": ref.get("at"), "finished_at": None}, False

    rows = {r["id"]: r for r in (*listing["zones"], *listing["addons"])}
    now = datetime.now(timezone.utc)
    for zone_id, job, gone in await asyncio.gather(*(fetch(z, ref) for z, ref in tracked.items())):
        if job is not None and job.get("status") == "done":
            finished = _parse_time(job.get("finished_at")) or _parse_time(tracked[zone_id].get("at"))
            gone = finished is None or now - finished > DONE_JOB_KEEP
        if gone or zone_id not in rows:
            await delete_setting(db, JOB_KEY_PREFIX + zone_id)
            continue
        rows[zone_id]["job"] = job


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
    await _track(db, zone_id, job, admin)
    await audit.log_action(db, admin.id, "system.zone.enable", "zone", zone_id,
                           {"job": job.get("id"), "settings": redact(settings or {})}, _client_ip(request))
    return job


@router.post("/zones/{zone_id}/disable", status_code=202)
async def disable_zone(zone_id: str, request: Request, admin: User = Depends(require_admin),
                       db: AsyncSession = Depends(get_db)):
    _zone_or_404(zone_id)
    job = _job_view(await installer.request("POST", f"/internal/zones/{zone_id}/disable"))
    await _track(db, zone_id, job, admin)
    await audit.log_action(db, admin.id, "system.zone.disable", "zone", zone_id, {"job": job.get("id")},
                           _client_ip(request))
    return job


@router.delete("/zones/{zone_id}/job")
async def dismiss_zone_job(zone_id: str, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """끝난 작업(실패·완료 직후) 표시를 걷는다 — "꺼진 채로 두기"."""
    _zone_or_404(zone_id)
    await delete_setting(db, JOB_KEY_PREFIX + zone_id)
    return {"ok": True}


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
    await _track(db, zone_id, job, admin)
    await audit.log_action(db, admin.id, "system.zone.settings", "zone", zone_id,
                           {"job": job.get("id"), "settings": redact(body.settings or {})}, _client_ip(request))
    return job


# ─── 작업 ───


def _job_id(job_id: str) -> str:
    if not (0 < len(job_id) <= 64 and job_id.isalnum()):
        raise InstallerError(404, "job_unknown")
    return job_id


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
    """외부 발신 서버 로그인 확인. 비밀번호를 비우면 설치 관리자가 넣어 둔 값을 쓴다."""
    return await installer.request("POST", "/internal/probe/smtp", json=body or {}, timeout=installer.PROBE_TIMEOUT)


@router.post("/probe/ai")
async def probe_ai(body: dict[str, Any] | None = None, admin: User = Depends(require_admin)):
    """AI 제공자 키 확인. 키를 비우면 설치 관리자가 넣어 둔 값을 쓴다."""
    return await installer.request("POST", "/internal/probe/ai", json=body or {}, timeout=installer.PROBE_TIMEOUT)


@router.post("/probe/mail-records")
async def probe_mail_records(body: dict[str, Any] | None = None, admin: User = Depends(require_admin)):
    """메일 도메인에 등록할 레코드와 현재 값. 설치 관리자가 이 확인을 내부 API 로 열어 두지 않았으면 501."""
    return await installer.request("POST", "/internal/probe/mail-records", json=body or {},
                                   timeout=installer.PROBE_TIMEOUT)


@router.get("/probe/public-ip")
async def probe_public_ip(refresh: bool = False, admin: User = Depends(require_admin)):
    """공인 주소 감지값. 내부 API 에 감지 경로가 없으면 설치 때 감지해 둔 값을 준다."""
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


# ─── 저장소 ───

_seen_down: bool | None = None      # 이 프로세스가 마지막으로 본 상태(끊긴 시각을 바뀔 때만 적으려고)


async def _down_since(db: AsyncSession, down: bool, at: str | None) -> str | None:
    """끊긴 시각 — 끊긴 것을 처음 본 때 적고, 돌아오면 지운다."""
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
    """파일 탭·관리자 알림 띠용 — 저장소에 닿는가만. 표식 확인을 켜지 않은 설치는 늘 available 이다."""
    response.headers["Cache-Control"] = "no-store"
    prober = storage_status.light_prober
    if not prober.guarded:
        return {"guarded": False, "available": True, "reason": None}
    result = await prober.check()
    down = result.get("reason") is not None
    if _seen_down is not down:
        try:
            await _down_since(db, down, result.get("checked_at"))
        except Exception as e:  # noqa: BLE001 — 시각을 못 적어도 상태는 답한다
            logger.warning("[system] 저장소 끊긴 시각을 적지 못했습니다(%s)", type(e).__name__)
    return {"guarded": True, "available": not down, "reason": result.get("reason")}
