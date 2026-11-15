"""Plugin admin API — list/enable/disable, serve bundles, 업로드 설치/삭제(플러그앤플레이)."""

import asyncio
import io
import json
import logging
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.plugins.loader import (
    PLUGINS_DIR, UPLOADED_DIR, get_loaded_plugins, get_skipped_plugins, run_plugin_hook, _installed_flag,
)
from app.modules.registry import is_module_enabled, set_module_enabled

logger = logging.getLogger(__name__)
router = APIRouter(tags=["plugins"])


async def _schedule_restart(delay: float = 2.0) -> None:
    """응답 후 backend 컨테이너 재시작(워커 전체가 새 플러그인 로드)."""
    await asyncio.sleep(delay)
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "restart", "ws-backend",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
    except Exception as e:
        logger.error("[Plugins] backend restart failed: %s", e)


@router.get("/api/admin/plugins")
async def list_plugins(user: User = Depends(get_current_user)):
    """Return installed plugins with their enabled status."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")

    plugins = get_loaded_plugins()
    result = []
    for p in plugins:
        result.append({
            "id": p["id"],
            "name": p["name"],
            "name_en": p.get("name_en", p["name"]),
            "icon": p["icon"],
            "route": p["route"],
            "api_prefix": p["api_prefix"],
            "version": p.get("version", "0.0.0"),
            "description": p.get("description", ""),
            "author": p.get("author", ""),
            "order": p.get("order"),
            "enabled": is_module_enabled(p["id"]),
            "removable": str(p.get("_dir", "")).startswith(str(UPLOADED_DIR)),
        })
    # skipped: 폴더는 있지만 올리지 않은 플러그인과 사유(필요한 구역 미설치 등)
    return {"plugins": result, "skipped": get_skipped_plugins()}


class PluginToggleRequest(BaseModel):
    enabled: bool


@router.patch("/api/admin/plugins/{plugin_id}")
async def toggle_plugin(
    plugin_id: str,
    body: PluginToggleRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Enable or disable a plugin. Admin only."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")

    # Check plugin is actually loaded
    plugins = get_loaded_plugins()
    found = any(p["id"] == plugin_id for p in plugins)
    if not found:
        raise HTTPException(status_code=404, detail="플러그인을 찾을 수 없습니다")

    ok = await set_module_enabled(db, plugin_id, body.enabled)
    if not ok:
        raise HTTPException(status_code=500, detail="상태 변경에 실패했습니다")

    status = "활성화" if body.enabled else "비활성화"
    return {"ok": True, "message": f"{plugin_id} 플러그인이 {status}되었습니다"}


@router.get("/api/plugin-assets/{plugin_id}/bundle.mjs")
async def serve_plugin_bundle(plugin_id: str, request: Request):
    """Serve a pre-built plugin frontend bundle (no auth — public static asset).

    ★ 조건부 요청을 직접 처리한다.
    Starlette 의 FileResponse 는 ETag/Last-Modified 를 **헤더로 내보내기만 하고**
    If-None-Match 를 검사하지 않아서, 브라우저가 재검증을 걸어도 매번 본문 전체를
    다시 내려준다. 플러그인 번들은 30KB(gzip)/150KB 라 모바일에서 페이지를 열 때마다
    이 비용을 물었다. 여기서 304 를 돌려주면 재방문이 수백 바이트로 끝난다.
    """
    plugins = get_loaded_plugins()
    plugin = next((p for p in plugins if p["id"] == plugin_id), None)
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")

    base = Path(plugin.get("_dir") or (PLUGINS_DIR / plugin.get("_folder", plugin_id)))
    bundle_path = base / "frontend" / "dist" / "plugin.mjs"
    if not bundle_path.is_file():
        raise HTTPException(status_code=404, detail="No frontend bundle")

    st = bundle_path.stat()
    # 파일이 바뀌면(플러그인 재빌드) 값이 바뀌므로 갱신이 자동으로 전파된다.
    etag = f'"{int(st.st_mtime)}-{st.st_size}"'
    cache_headers = {"Cache-Control": "no-cache, must-revalidate", "ETag": etag}

    # nginx 가 gzip 압축을 하면 ETag 를 weak(`W/"..."`)로 바꿔서 돌려보낸다.
    # 브라우저는 그 값을 그대로 If-None-Match 로 보내므로 W/ 접두사를 떼고 비교해야 한다.
    def _norm(v: str) -> str:
        v = v.strip()
        return v[2:] if v.startswith("W/") else v

    inm = request.headers.get("if-none-match", "")
    if inm and any(_norm(part) == _norm(etag) for part in inm.split(",") if part.strip()):
        return Response(status_code=304, headers=cache_headers)

    return FileResponse(
        bundle_path,
        media_type="application/javascript",
        headers=cache_headers,
    )


# ─── 플러그앤플레이: 패키지 업로드 설치 / 삭제 ───
def _valid_pid(pid: str) -> bool:
    return bool(pid) and pid.replace("-", "").replace("_", "").isalnum()


# 압축 폭탄·과대 패키지 방지. 정상 플러그인(백엔드 소스 + 프런트 번들 1개)은 수 MB 수준이다.
MAX_UPLOAD_BYTES = 100 * 1024 * 1024      # 올리는 zip 자체
MAX_UNPACKED_BYTES = 300 * 1024 * 1024    # 풀었을 때 합계
MAX_ENTRIES = 5000
MAX_RATIO = 200                           # 항목 하나의 압축률 상한(정상 텍스트도 수십 배 안쪽)


def _check_zip_limits(zf: zipfile.ZipFile) -> None:
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        raise HTTPException(status_code=400, detail=f"패키지 항목이 너무 많습니다(최대 {MAX_ENTRIES}개)")
    total = 0
    for i in infos:
        total += i.file_size
        if total > MAX_UNPACKED_BYTES:
            raise HTTPException(status_code=400, detail="풀었을 때 크기가 너무 큽니다(최대 300MB)")
        if i.compress_size and i.file_size / i.compress_size > MAX_RATIO and i.file_size > 1024 * 1024:
            raise HTTPException(status_code=400, detail=f"비정상적으로 압축된 항목이 있습니다: {i.filename}")


@router.post("/api/admin/plugins/install", status_code=202)
async def install_plugin(file: UploadFile = File(...), user: User = Depends(get_current_user)):
    """플러그인 패키지(.zip: manifest.json + backend/ + frontend/dist/plugin.mjs) 업로드 설치."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="패키지가 너무 큽니다(최대 100MB)")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except Exception:
        raise HTTPException(status_code=400, detail="유효한 zip 파일이 아닙니다")
    # 기존 설치본을 지우기 전에 검사한다(거부되면 이전 버전이 그대로 남는다)
    _check_zip_limits(zf)

    names = zf.namelist()
    manifest_name = next((n for n in names if n.endswith("manifest.json") and n.count("/") <= 1), None)
    if not manifest_name:
        raise HTTPException(status_code=400, detail="manifest.json을 찾을 수 없습니다(루트 또는 단일 폴더)")
    try:
        manifest = json.loads(zf.read(manifest_name))
    except Exception:
        raise HTTPException(status_code=400, detail="manifest.json 파싱 실패")

    pid = manifest.get("id", "")
    if not _valid_pid(pid):
        raise HTTPException(status_code=400, detail="manifest id가 유효하지 않습니다")
    if not manifest.get("route") or not str(manifest.get("api_prefix", "")).startswith("/api/plugins/"):
        raise HTTPException(status_code=400, detail="route/api_prefix(=/api/plugins/...) 필수")

    root = manifest_name[: -len("manifest.json")]  # "" 또는 "folder/"
    if not any(n == root + "backend/router.py" for n in names):
        raise HTTPException(status_code=400, detail="backend/router.py가 패키지에 없습니다")

    target = UPLOADED_DIR / pid
    try:
        UPLOADED_DIR.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        troot = target.resolve()
        for n in names:
            if root and not n.startswith(root):
                continue
            rel = n[len(root):]
            if not rel or rel.endswith("/"):
                continue
            dest = (target / rel).resolve()
            # path traversal 방지. 접두어 비교(startswith)는 형제 폴더(<id>2/...)를 통과시킨다.
            if not dest.is_relative_to(troot):
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(n))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"압축 해제 실패: {e}")

    await _installed_flag(pid, False)  # 재시작 후 on_install 실행되도록
    asyncio.create_task(_schedule_restart())
    logger.info("[Plugins] installed package: %s", pid)
    return {"ok": True, "id": pid, "restarting": True,
            "message": f"{pid} 설치됨 — 백엔드 재시작 중(~20초). 완료 후 자동 표시됩니다."}


@router.delete("/api/admin/plugins/{plugin_id}", status_code=202)
async def uninstall_plugin(plugin_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """업로드 설치된 플러그인 삭제(번들 플러그인은 삭제 불가)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")
    target = UPLOADED_DIR / plugin_id
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="삭제 가능한 업로드 플러그인이 아닙니다(번들 플러그인은 삭제 불가)")
    try:
        await run_plugin_hook(plugin_id, "on_uninstall")
    except Exception:
        pass
    try:
        await set_module_enabled(db, plugin_id, False)
    except Exception:
        pass
    shutil.rmtree(target, ignore_errors=True)
    await _installed_flag(plugin_id, False)
    asyncio.create_task(_schedule_restart())
    logger.info("[Plugins] uninstalled: %s", plugin_id)
    return {"ok": True, "restarting": True, "message": f"{plugin_id} 삭제됨 — 백엔드 재시작 중"}
