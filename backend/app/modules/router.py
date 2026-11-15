"""Platform module API — module listing + admin toggle."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.modules.registry import get_enabled_modules, set_module_enabled

router = APIRouter(tags=["platform"])


# ─── GET /api/platform/modules (public, soft-auth → 접근 가능 모듈만) ───


@router.get("/api/platform/modules")
async def list_modules(request: Request, db: AsyncSession = Depends(get_db)):
    """Return modules with enabled status. 로그인 시 그룹 권한으로 제한 모듈 필터(nav 숨김)."""
    modules = await get_enabled_modules(db)
    from app.middleware.access_log import _extract_user_id
    from app.groups import service as gs
    uid = _extract_user_id(request)
    is_admin = False
    if uid:
        u = await db.get(User, uid)
        is_admin = bool(u and u.is_admin)
    modules = await gs.filter_modules(db, uid, is_admin, modules)
    return {"modules": modules}


# ─── GET /api/platform/capabilities (public, 인증 없음) ───


def _server_features() -> list[str]:
    """모듈 on/off 와 별개로 서버 코드·설정이 결정하는 기능 플래그.

    규칙: **추가만 한다**(Nextcloud OCS capabilities 식). 한 번 내보낸 이름을 빼거나
    의미를 바꾸면 그 이름을 보고 분기한 옛 클라이언트가 깨진다. 외부 서비스 플래그
    (livekit·onlyoffice)는 "설정돼 있는가" 만 말하고 URL·키는 절대 싣지 않는다.
    """
    from app.config import get_settings
    from app.meetings.livekit import is_configured as livekit_configured

    s = get_settings()
    flags: list[str] = [
        # 같은 사용자의 WS 를 여러 개(탭·데스크톱·모바일 동시) 받는다 — chat/presence.py 가
        # 연결 수를 세어 첫/마지막 연결만 온라인/오프라인으로 바꾼다.
        "realtime.multi_connection",
        # 다운로드 ETag/304·Range(206) — app/files/router.py _file_response
        "files.ranges",
        # 분할·이어 올리기 세션 /api/files/upload/sessions — app/files/upload_sessions.py
        "files.chunked_upload",
        # 재접속 복구 커서 /api/chat/changes?since_seq= (메시지 seq)
        "chat.seq_resume",
    ]
    if livekit_configured():
        flags.append("meetings.livekit")
    if s.onlyoffice_jwt_secret:
        # wopi/router.py 의 편집기 선택 기준과 같다 — 시크릿이 있으면 OnlyOffice 가 붙어 있다.
        flags.append("office.onlyoffice")
    return flags


@router.get("/api/platform/capabilities")
async def capabilities(response: Response, db: AsyncSession = Depends(get_db)):
    """클라이언트(데스크톱·모바일 런처)가 서버를 알아보는 최소 정보.

    사이트별로 따로 빌드되는 데스크톱과 서명 APK 가 배포되면서 서버/클라이언트 버전이
    섞이는 게 현실이 됐다. 로그인 전에도 읽을 수 있어야 하므로(런처는 주소만 안다) 인증이
    없고, 그래서 **민감한 것은 하나도 싣지 않는다** — 도메인·URL·관리자 설정값 금지.
    모듈은 익명 사용자 기준으로 거른다(`/api/platform/modules` 비로그인과 같은 결과).
    """
    from app.main import APP_VERSION  # main 이 이 라우터를 import 하므로 지연 import
    from app.groups import service as gs

    modules = await gs.filter_modules(db, None, False, await get_enabled_modules(db))
    enabled = sorted(m["id"] for m in modules if m.get("enabled"))
    features = sorted({*_server_features(), *(f"module.{mid}" for mid in enabled)})
    # 모듈 토글이 바로 반영돼야 하지만 런처가 매번 때리는 것도 막는다.
    response.headers["Cache-Control"] = "public, max-age=60"
    return {
        "product": "just-workspace",
        "version": APP_VERSION,
        "features": features,
        "modules": enabled,
    }


# ─── PATCH /api/admin/modules/{module_id} (admin only) ───


class ModuleToggleRequest(BaseModel):
    enabled: bool


@router.patch("/api/admin/modules/{module_id}")
async def toggle_module(
    module_id: str,
    body: ModuleToggleRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Enable or disable a module. Admin only."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")

    ok = await set_module_enabled(db, module_id, body.enabled)
    if not ok:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다")

    status = "활성화" if body.enabled else "비활성화"
    return {"ok": True, "message": f"{module_id} 모듈이 {status}되었습니다"}
