"""ws-sso — SSO 프로토콜 계층 (SAML 2.0 IdP · SCIM 2.0).

경계: 이 서비스는 **인증을 수행하지 않는다.** 사용자 원장과 로그인 UI 는 backend 에
그대로 두고, 여기서는 backend 가 발급한 세션을 검증해 신원을 확인한 뒤 각 프로토콜
형식으로 재발행한다. 자세한 이유는 app/identity.py 참고.

현재 단계: 골격 + 신원 조회 경계 검증. SAML/SCIM 은 이 위에 얹는다.
"""

import logging

from fastapi import Cookie, Depends, FastAPI, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.identity import SESSION_COOKIE, Session, list_users, resolve_session

logging.basicConfig(level=settings.log_level)
logger = logging.getLogger(__name__)

app = FastAPI(title="just-workspace SSO", docs_url=None, redoc_url=None)


async def get_db():
    async with Session() as db:
        yield db


@app.get("/sso/health")
async def health(db: AsyncSession = Depends(get_db)):
    """DB 연결과 users 가시성까지 확인한다 — 프로세스 생존만 보면 의미가 없다."""
    users = await list_users(db)
    return {
        "status": "ok",
        "entity_id": settings.entity_id,
        "users_visible": len(users),
    }


@app.get("/sso/whoami")
async def whoami(
    ws_session: str | None = Cookie(None, alias=SESSION_COOKIE),
    db: AsyncSession = Depends(get_db),
):
    """backend 세션 쿠키로 신원을 확인한다 — 서비스 경계가 실제로 도는지 보는 창구."""
    identity = await resolve_session(db, ws_session)
    if identity is None:
        raise HTTPException(status_code=401, detail="유효한 세션이 없습니다")
    return {
        "id": identity.id,
        "username": identity.username,
        "display_name": identity.display_name,
        "email": identity.email,
        "is_admin": identity.is_admin,
    }
