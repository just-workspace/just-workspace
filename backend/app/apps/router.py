"""앱(모바일 APK) 브랜드 빌드 — 이 워크스페이스 URL로 server.url을 박은 APK 자동 생성.

빌드는 backend가 docker(소켓)로 jw-android-builder 이미지를 실행해 수행. 산출물은
ws-storage-data 볼륨의 /storage/apps/workspace-android.apk → 기존 /api/apps/android 로 배포.
"""
import asyncio
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import SystemSetting, User
from app.db.session import async_session, get_db

router = APIRouter(prefix="/api/admin/apps", tags=["apps-build"])
settings = get_settings()


def _admin(user: User) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")


async def _get(db, key: str, default: str = "") -> str:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    return s.value if s and s.value is not None else default


async def _set(db, key: str, value: str) -> None:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    if s:
        s.value = value
    else:
        db.add(SystemSetting(key=key, value=value))


class AppConfig(BaseModel):
    target_url: str | None = None
    app_name: str | None = None


@router.get("/config")
async def get_config(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    return {
        "target_url": await _get(db, "app.target_url") or settings.app_url,
        "app_name": await _get(db, "app.app_name", "Just Workspace"),
        "build_status": await _get(db, "app.build.status", "idle"),  # idle|building|success|failed
        "build_finished": await _get(db, "app.build.finished"),
        "build_error": await _get(db, "app.build.error"),
        "builder_ready": bool(os.getenv("JW_HOST_REPO")),
    }


@router.put("/config")
async def put_config(body: AppConfig, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    if body.target_url is not None:
        await _set(db, "app.target_url", body.target_url.strip())
    if body.app_name is not None:
        await _set(db, "app.app_name", body.app_name.strip() or "Just Workspace")
    await db.commit()
    return {"ok": True}


@router.post("/build", status_code=202)
async def build(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    repo = os.getenv("JW_HOST_REPO")
    if not repo:
        raise HTTPException(status_code=400, detail="JW_HOST_REPO 미설정 — compose에 호스트 리포 경로를 지정하세요")
    url = (await _get(db, "app.target_url") or settings.app_url).rstrip("/")
    app_name = await _get(db, "app.app_name", "Just Workspace")

    async def _job():
        async with async_session() as bdb:
            await _set(bdb, "app.build.status", "building")
            await _set(bdb, "app.build.error", "")
            await bdb.commit()
        # 빌드 스크립트는 이미지에 구운 사본이 아니라 리포의 것을 쓴다(코드와 함께 갱신되게).
        # 서명 키는 별도 볼륨에 영구 보관 — 바뀌면 설치된 앱이 갱신 설치를 거부한다.
        cmd = [
            "docker", "run", "--rm",
            "-v", f"{repo}/apps/mobile:/src:ro",
            "-v", f"{os.getenv('STORAGE_VOLUME') or 'ws-storage-data'}:/out",
            "-v", "jw-android-signing:/signing",
            "-e", f"WS_URL={url}",
            "-e", f"APP_NAME={app_name}",
            "-e", f"APP_ID={os.getenv('ANDROID_APP_ID', '')}",
            # 앱이 여는 서버 웹 UI(vue|react). 빈값이면 builder-build.sh 기본(react). 번들 모드는 빌더를 직접 실행할 때만.
            "-e", f"JW_WEB={os.getenv('JW_WEB', '')}",
            "--entrypoint", "sh",
            "jw-android-builder", "/src/builder-build.sh",
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=900)
            tail = (out or b"").decode("utf-8", "replace")[-800:]
            ok = proc.returncode == 0 and "BUILD_OK" in tail
            async with async_session() as bdb:
                await _set(bdb, "app.build.status", "success" if ok else "failed")
                await _set(bdb, "app.build.finished", datetime.now(timezone.utc).isoformat())
                if not ok:
                    await _set(bdb, "app.build.error", tail[-500:])
                await bdb.commit()
        except Exception as e:  # noqa: BLE001
            async with async_session() as bdb:
                await _set(bdb, "app.build.status", "failed")
                await _set(bdb, "app.build.error", str(e)[:500])
                await bdb.commit()

    asyncio.create_task(_job())
    return {"ok": True, "building": True, "target_url": url}


@router.get("/build")
async def build_status(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    return {
        "status": await _get(db, "app.build.status", "idle"),
        "finished": await _get(db, "app.build.finished"),
        "error": await _get(db, "app.build.error"),
    }


# ─── 배포 산출물(관리 › 앱 빌드 "빌드" 목록) ───
_ARTIFACTS = (
    # platform, 파일명(storage_root/apps/), 공개 내려받기 주소
    ("android", "workspace-android.apk", "/api/apps/android"),
    ("desktop", "workspace-desktop-setup.exe", "/api/apps/desktop"),
)


def _artifact_info(platform: str, filename: str, url: str) -> dict:
    from pathlib import Path

    p = Path(settings.storage_root) / "apps" / filename
    if not p.is_file():
        return {"platform": platform, "available": False, "size_bytes": 0, "modified_at": None, "download_url": url}
    st = p.stat()
    return {
        "platform": platform,
        "available": True,
        "size_bytes": st.st_size,
        "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        "download_url": url,
    }


@router.get("/artifacts")
async def artifacts(user: User = Depends(get_current_user)):
    """지금 배포 중인 앱 파일(있으면 크기·수정 시각). iOS 빌드는 지원하지 않는다."""
    _admin(user)
    return {"artifacts": [_artifact_info(*a) for a in _ARTIFACTS]}
