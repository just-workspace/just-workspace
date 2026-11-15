from fastapi import APIRouter, Depends

from app.auth.deps import get_current_user
from app.db.models import User
from app.services.health import build_public_status, get_cached_status
from app.services.schemas import ServiceStatus

router = APIRouter(prefix="/api/services", tags=["services"])


@router.get("/status", response_model=list[ServiceStatus])
async def service_status(user: User = Depends(get_current_user)):
    """Return all service health statuses (authenticated)."""
    return get_cached_status()


@router.get("/public-status")
async def public_service_status():
    """공개 서비스 상태(인증 불요 — 500 화면). 사용자 쪽 묶음 key·상태·응답 ms 와 확인 시각만.

    내부 서비스 이름·주소·버전은 내지 않는다. 값은 60초 주기 점검의 캐시라 이 요청이 점검을 일으키지 않는다.
    """
    return build_public_status()
