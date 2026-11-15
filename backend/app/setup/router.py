"""First-Time-Setup-Wizard (웹 최초설정) + 설정 상태.

목표: 설치 후 CLI 없이 웹에서 끝까지. 최초 관리자 생성은 관리자가 0명일 때만 공개 허용.
나머지 설정 단계(브랜딩/메일/모듈/LDAP)는 관리자 로그인 후 기존 admin API 재사용.
"""
from __future__ import annotations

import re

from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import audit
from app.auth.deps import get_current_user
from app.auth.sessions import client_ip
from app.auth.password import hash_password
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.setup import config_store as cfg

router = APIRouter(prefix="/api/setup", tags=["setup"])
settings = get_settings()


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
    """공개 — 프론트 미들웨어가 최초설정 필요 여부 판단용."""
    admin = await has_admin(db)
    return {
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


@router.post("/admin", status_code=201)
async def create_first_admin(body: AdminCreate, db: AsyncSession = Depends(get_db)):
    """최초 관리자 생성 — 관리자가 0명일 때만 허용(이후 403). CLI seed-admin 없이 웹에서."""
    if await has_admin(db):
        raise HTTPException(status_code=403, detail="이미 관리자가 존재합니다")
    username = (body.username or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9_.-]{3,32}", username):
        raise HTTPException(status_code=400, detail="아이디는 3~32자 영소문자/숫자/._- 만 허용")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="비밀번호는 8자 이상")
    domain = await cfg.get(db, "general.domain", getattr(settings, "domain", "localhost"))
    user = User(
        username=username,
        password_hash=hash_password(body.password),
        display_name=(body.display_name or username).strip(),
        email=(body.email or f"{username}@{domain}").strip(),
        is_admin=True,
        is_active=True,
        email_verified=True,
    )
    db.add(user)
    await db.commit()
    return {"ok": True, "username": username}


class CompleteBody(BaseModel):
    pass


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


@router.post("/restore")
async def restore(file: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    """마이그레이션 — 업로드한 백업(.tar.gz)으로 복원. 신규 인스턴스(관리자 0명)에서만.

    복원 후 백엔드가 자동 재시작되어 복원된 데이터/관리자로 전환됨.
    """
    if await has_admin(db):
        raise HTTPException(status_code=403, detail="이미 설정된 인스턴스입니다. 마이그레이션은 신규 인스턴스에서만 가능합니다.")
    from app.backup import service as backup_service
    dest = Path("/backups") / "_upload_restore.tar.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(dest, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
        result = await backup_service.restore_from_archive(dest)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"복원 실패: {e}")
    finally:
        try:
            dest.unlink()
        except OSError:
            pass
    await backup_service.schedule_backend_restart(3.0)
    return {"ok": True, "restored": result, "restarting": True}


@router.get("/services")
async def services(user: User = Depends(get_current_user)):
    """서비스 상태 (관리자) — 단일 웹 컨트롤 플레인 가시성."""
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
