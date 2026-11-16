"""최초 설정(`/api/setup/*`)과, 같은 접두사 아래의 관리자용 설정 API.

- 최초 설정: 관리자가 한 명도 없을 때만 `/setup` 화면이 열린다(`status`·`admin`·`complete`).
  설치 관리자는 관리자를 직접 만들므로(`seed-admin`) 이 화면을 거치지 않는다 — 설치 관리자 없이 띄우고
  관리자를 미리 만들지 않은 서버의 첫 화면이다.
  인증 없이 상태를 바꾸는 것은 `POST /admin` 하나뿐이고, 그것은 설치 관리자 설치에서는 닫혀 있으며 그 밖에서는
  서버 로그에 찍힌 일회용 설정 토큰을 요구한다(app/setup/token.py). 나머지는 전부 관리자 세션이 필요하다.
- 관리 화면이 쓰는 것: 로그인 순서(`auth-order`), 저장소 백엔드(`storage`), 내장 메일 플래그(`features`),
  컨테이너 상태·재시작(`services`).

백업에서 복원은 여기에 없다(실행 중인 backend 는 자기 DB 를 갈아 끼울 수 없다) — docs/data-safety.md 4절.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import audit
from app.auth.deps import get_current_user
from app.auth.sessions import client_ip
from app.auth import password_policy
from app.auth.password import hash_password
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.rate_limit import limiter
from app.setup import config_store as cfg
from app.setup import token as setup_token

router = APIRouter(prefix="/api/setup", tags=["setup"])
settings = get_settings()

# 첫 관리자 비밀번호 하한 — 설치 마법사(installer 의 ADMIN_PASSWORD_MIN)와 같다.
# 가입·비밀번호 변경의 하한(app/auth/password_policy.py)과는 따로다.
FIRST_ADMIN_PASSWORD_MIN = 12


def _ip(request: Request | None) -> str | None:
    return (client_ip(request) or None) if request is not None else None


async def has_admin(db: AsyncSession) -> bool:
    n = await db.scalar(select(func.count()).select_from(User).where(User.is_admin == True))  # noqa: E712
    return bool(n)


async def needs_setup(db: AsyncSession) -> bool:
    # 최초설정 강제는 '관리자 0명'(진짜 신규 설치)일 때만 — 기존 인스턴스 오작동 방지.
    return not await has_admin(db)


@router.get("/status")
async def status(db: AsyncSession = Depends(get_db)):
    """공개 — 프론트 미들웨어가 최초설정 필요 여부 판단용. 비밀값·토큰 유무는 내지 않는다.

    setup_mode: 첫 관리자를 웹에서 만드는 방식 — `installer`(닫힘, 설치 관리자가 만든다) | `token`(설정 토큰 필요).
    """
    admin = await has_admin(db)
    return {
        "setup_mode": setup_token.mode(),
        "needs_setup": await needs_setup(db),
        "has_admin": admin,
        "app_name": await cfg.get(db, "branding.site_name", getattr(settings, "app_name", "Workspace")),
        "setup_complete": (await cfg.get(db, "setup.complete")) == "1",
    }


class AdminCreate(BaseModel):
    username: str
    password: str
    display_name: str | None = None
    email: str | None = None
    setup_token: str | None = None


@router.post("/admin", status_code=201)
@limiter.limit("5/minute")
async def create_first_admin(request: Request, body: AdminCreate, db: AsyncSession = Depends(get_db)):
    """최초 관리자 생성 — 관리자가 0명이고, 설치 관리자 설치가 아니고, 설정 토큰이 맞을 때만.

    - 설치 관리자 설치: 항상 403(`setup_closed`) — 관리자는 설치 관리자가 CLI 로 만든다.
    - 그 밖: 서버 로그의 설정 토큰(`setup_token`)이 맞아야 한다. 맞으면 토큰은 계정과 한 트랜잭션에서 사라진다.
    - 시도 횟수는 주소당 분당 5회(틀린 토큰·맞는 토큰 구분 없이).
    """
    if setup_token.installer_managed():
        raise HTTPException(status_code=403, detail={
            "code": "setup_closed",
            "message": "이 서버의 관리자 계정은 설치 관리자가 만듭니다 — 웹에서는 만들 수 없습니다",
        })
    if await has_admin(db):
        raise HTTPException(status_code=403, detail={"code": "admin_exists", "message": "이미 관리자가 존재합니다"})
    # 토큰을 먼저 본다 — 토큰 없이 입력 검증 응답만으로 서버를 더듬지 못하게
    if not await setup_token.matches(db, body.setup_token):
        raise HTTPException(status_code=403, detail={
            "code": "setup_token_invalid",
            "message": "설정 토큰이 맞지 않습니다 — 서버 로그(docker compose logs backend)에서 확인하세요",
        })
    username = (body.username or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9_.-]{3,32}", username):
        raise HTTPException(status_code=400, detail="아이디는 3~32자 영소문자/숫자/._- 만 허용")
    password = password_policy.normalize(body.password or "")
    if len(password) < FIRST_ADMIN_PASSWORD_MIN:
        raise HTTPException(status_code=400, detail=f"비밀번호는 {FIRST_ADMIN_PASSWORD_MIN}자 이상")
    try:
        password_policy.validate(password, username)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    domain = await cfg.get(db, "general.domain", getattr(settings, "domain", "localhost"))
    if not await setup_token.consume(db, body.setup_token):
        # 같은 토큰으로 동시에 들어온 다른 요청이 먼저 썼다
        await db.rollback()
        raise HTTPException(status_code=403, detail={"code": "setup_token_invalid", "message": "설정 토큰이 이미 쓰였습니다"})
    user = User(
        username=username,
        password_hash=hash_password(password),
        display_name=(body.display_name or username).strip(),
        email=(body.email or f"{username}@{domain}").strip(),
        is_admin=True,
        is_active=True,
        email_verified=True,
    )
    db.add(user)
    await db.commit()
    try:
        await audit.log_action(db, user.id, "setup.first_admin", "user", str(user.id)[:36], {"username": username}, _ip(request))
    except Exception:  # noqa: BLE001 — 기록 실패로 만들어진 계정을 실패로 알리지 않는다
        pass
    return {"ok": True, "username": username}


@router.get("/features")
async def get_features(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """시스템 피처 플래그 (관리자) — DB 우선, env 폴백."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    return {
        "builtin_mailserver": await cfg.get_bool(db, "feature.builtin_mailserver", getattr(settings, "feature_builtin_mailserver", False)),
    }


@router.get("/auth-order")
async def get_auth_order(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """인증 소스 우선순위 (관리자). 기본 local,ldap."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    raw = await cfg.get(db, "auth.order", "local,ldap") or "local,ldap"
    return {"order": [s.strip() for s in raw.split(",") if s.strip()]}


class AuthOrderUpdate(BaseModel):
    order: list[str]


@router.patch("/auth-order")
async def set_auth_order(body: AuthOrderUpdate, request: Request = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """인증 소스 우선순위 변경 (관리자). 예: ['ldap','local'] = 외부 디렉터리 우선."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    allowed = {"local", "ldap"}
    order = [s for s in body.order if s in allowed]
    if not order:
        order = ["local", "ldap"]
    await cfg.set(db, "auth.order", ",".join(order))
    await db.commit()
    await audit.log_action(db, user.id, "settings.auth_order.update", "settings", "auth_order", {"order": order}, _ip(request))
    return {"ok": True, "order": order}


@router.get("/storage")
async def get_storage(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """스토리지 백엔드 설정 (관리자). 시크릿은 set 여부만 노출."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    s = await cfg.get_by_prefix(db, "storage.s3.")
    return {
        "backend": await cfg.get(db, "storage.backend", "filesystem"),
        "s3": {
            "endpoint": s.get("storage.s3.endpoint", ""), "region": s.get("storage.s3.region", ""),
            "bucket": s.get("storage.s3.bucket", ""), "access_key": s.get("storage.s3.access_key", ""),
            "prefix": s.get("storage.s3.prefix", ""), "secret_set": bool(s.get("storage.s3.secret_key")),
        },
    }


class StorageUpdate(BaseModel):
    backend: str
    s3: dict | None = None


@router.patch("/storage")
async def set_storage(body: StorageUpdate, request: Request = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """스토리지 백엔드 변경 (관리자). filesystem(로컬/NFS/SMB) | s3. 시크릿 암호화 저장."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    if body.backend not in ("filesystem", "s3"):
        raise HTTPException(status_code=400, detail="backend는 filesystem | s3")
    await cfg.set(db, "storage.backend", body.backend)
    if body.s3:
        for k in ("endpoint", "region", "bucket", "access_key", "prefix"):
            if body.s3.get(k) is not None:
                await cfg.set(db, f"storage.s3.{k}", str(body.s3[k]))
        sk = body.s3.get("secret_key")
        if sk:
            from app.mail.crypto import encrypt_password
            await cfg.set(db, "storage.s3.secret_key", encrypt_password(sk))
    await db.commit()
    await audit.log_action(db, user.id, "settings.storage.update", "settings", "storage", {"backend": body.backend}, _ip(request))
    return {"ok": True}


class StorageTest(BaseModel):
    backend: str = "s3"
    s3: dict | None = None


@router.post("/storage/test")
async def test_storage(body: StorageTest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """스토리지 연결 테스트 (관리자) — 입력값으로 put/get/delete."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    from app.storage import backend as st
    if body.backend == "s3":
        p = body.s3 or {}
        secret = p.get("secret_key")
        if not secret:  # 저장된 시크릿 사용
            saved = await cfg.get(db, "storage.s3.secret_key")
            if saved:
                try:
                    from app.mail.crypto import decrypt_password
                    secret = decrypt_password(saved)
                except Exception:
                    secret = ""
        try:
            b = st.S3Backend(endpoint=p.get("endpoint", ""), region=p.get("region", ""), bucket=p.get("bucket", ""),
                             access_key=p.get("access_key", ""), secret_key=secret or "", prefix=p.get("prefix", ""))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"S3 초기화 실패: {e}")
    else:
        b = st.FilesystemBackend()
    ok, msg = await st.test_backend(b)
    return {"ok": ok, "message": msg}


class FeaturesUpdate(BaseModel):
    builtin_mailserver: bool | None = None


@router.patch("/features")
async def update_features(body: FeaturesUpdate, request: Request = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """피처 플래그 변경 (관리자, 라이브 — 재시작 불필요)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    if body.builtin_mailserver is not None:
        await cfg.set(db, "feature.builtin_mailserver", "1" if body.builtin_mailserver else "0")
    await db.commit()
    await audit.log_action(
        db, user.id, "settings.features.update", "settings", "features",
        {"builtin_mailserver": body.builtin_mailserver}, _ip(request),
    )
    return {"ok": True}


@router.get("/services")
async def services(user: User = Depends(get_current_user)):
    """서비스 상태 (관리자)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    from app.setup import orchestrator
    return {"services": await orchestrator.service_status()}


@router.post("/services/{service}/restart")
async def restart_service(
    service: str,
    request: Request = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """서비스 재시작 (관리자)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    from app.setup import orchestrator
    # 재시작 전에 남긴다 — backend 자신을 재시작하면 응답도 기록도 못 남긴다
    await audit.log_action(db, user.id, "service.restart", "service", service[:36], None, _ip(request))
    ok, msg = await orchestrator.restart_service(service)
    if not ok:
        raise HTTPException(status_code=500, detail=msg or "재시작 실패")
    return {"ok": True}


@router.post("/complete")
async def complete_setup(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """최초설정 완료 표시 (관리자만)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    await cfg.set(db, "setup.complete", "1")
    await db.commit()
    return {"ok": True}
