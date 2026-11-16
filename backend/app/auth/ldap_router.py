"""LDAP/AD 설정 관리 API (admin)."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import audit
from app.auth import ldap_client
from app.auth.sessions import client_ip
from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db

router = APIRouter(prefix="/api/admin/auth/ldap", tags=["ldap"])


def _admin(user: User) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")


class LdapConfig(BaseModel):
    enabled: bool | None = None
    host: str | None = None
    port: int | None = None
    use_ssl: bool | None = None
    bind_dn: str | None = None
    bind_password: str | None = None
    base_dn: str | None = None
    user_filter: str | None = None
    attr_email: str | None = None
    attr_name: str | None = None
    auto_provision: bool | None = None


class LdapTest(BaseModel):
    username: str
    password: str


@router.get("")
async def get_ldap(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    return await ldap_client.get_config(db)


@router.put("")
async def put_ldap(
    body: LdapConfig,
    request: Request = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _admin(user)
    changed = body.model_dump(exclude_none=True)
    await ldap_client.set_config(db, changed)
    # 로그인 경로를 변경하는 설정(서버 주소·검색 필터·자동 가입) — 값은 기록하지 않고 변경된 항목만 기록
    await audit.log_action(
        db, user.id, "settings.ldap.update", "settings", "ldap",
        {"keys": sorted(changed), **({"enabled": changed["enabled"]} if "enabled" in changed else {})},
        (client_ip(request) or None) if request is not None else None,
    )
    return await ldap_client.get_config(db)


@router.post("/test")
async def test_ldap(body: LdapTest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    attrs = await ldap_client.authenticate(db, body.username, body.password)
    if not attrs:
        return {"ok": False, "message": "인증 실패 — 설정/자격증명 확인"}
    return {"ok": True, "dn": attrs.get("dn"), "email": attrs.get("email"), "name": attrs.get("name")}
