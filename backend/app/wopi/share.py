"""OnlyOffice 로 여는 두 가지 진입 경로 — 새 문서 생성, 공유 링크를 통한 공동 편집.

공유 링크
---------
수신자는 계정이 없다. `/s/<token>` 에서 이름을 입력받고 본 모듈의 `shared/{token}/open` 을 호출하면,
링크 생성자를 경로 소유자(owner_id)로, 게스트를 편집자(user_id = guest-xxxx)로 지정한
WOPI 토큰을 발급한다. 이후 OnlyOffice ↔ WOPI 엔드포인트는 일반 편집과 동일한 경로로 동작한다.
토큰에 포함된 경로는 링크가 가리키는 파일 하나뿐이므로 다른 파일로 변경하여 열 수 없다.
쓰기는 링크에 `can_edit` 가 활성화된 경우에만 허용한다.
"""

import logging
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import ShareLink, User
from app.db.session import get_db
from app.files.service import AccessDeniedError, PathSecurityError, invalidate_cache, resolve_path
from app.modules.registry import require_module
from app.wopi.router import (
    _ALL_OFFICE_EXTS,
    _build_editor_url,
    _check_editor_available,
    _encode_file_id,
    session_scope,
)
from app.wopi.schemas import EditorOpenResponse
from app.wopi.tokens import create_wopi_token

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/wopi", tags=["wopi"])

TEMPLATES = Path(__file__).parent / "templates"
_NEW = {
    "doc": ("제목 없는 문서", ".docx"),
    "sheet": ("제목 없는 스프레드시트", ".xlsx"),
    "slide": ("제목 없는 프레젠테이션", ".pptx"),
}


# ── 새 문서 ──────────────────────────────────────────────


class NewOfficeRequest(BaseModel):
    dir: str
    kind: Literal["doc", "sheet", "slide"] = "doc"


class NewOfficeResponse(BaseModel):
    path: str
    name: str


@router.post("/new", response_model=NewOfficeResponse)
@require_module("files")
async def new_office_file(req: NewOfficeRequest, user: User = Depends(get_current_user)):
    """빈 docx/xlsx/pptx 를 생성한다. 이름을 사전에 입력받지 않고 즉시 생성하여 연다(제목은 이후 변경한다)."""
    try:
        real_dir = resolve_path(req.dir, user)
    except (PathSecurityError, AccessDeniedError) as e:
        raise HTTPException(status_code=403, detail=str(e))
    if not real_dir.is_dir():
        raise HTTPException(status_code=404, detail="폴더가 없습니다")

    stem, ext = _NEW[req.kind]
    name = f"{stem}{ext}"
    n = 2
    while (real_dir / name).exists():
        name = f"{stem} ({n}){ext}"
        n += 1
    shutil.copyfile(TEMPLATES / f"new{ext}", real_dir / name)
    invalidate_cache(real_dir)
    return NewOfficeResponse(path=f"{req.dir.rstrip('/')}/{name}", name=name)


# ── 공유 링크 ────────────────────────────────────────────


class SharedOpenRequest(BaseModel):
    """게스트가 직접 입력하는 이름. 없으면 서버가 생성한다."""
    name: str = ""
    # 비밀번호 링크이면 둘 중 하나 필요: 비밀번호 원문, 또는 /api/files/shared/{token}/unlock 의 access
    password: str | None = None
    access: str | None = None


class SharedOpenResponse(EditorOpenResponse):
    can_edit: bool
    guest_name: str


async def _link_from_token(token: str, db: AsyncSession) -> ShareLink:
    link = (await db.execute(select(ShareLink).where(ShareLink.token == token))).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="링크를 찾을 수 없습니다")
    exp = link.expires_at
    if exp is not None and exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if exp and exp < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="만료된 링크입니다")
    return link


@router.post("/shared/{token}/open", response_model=SharedOpenResponse)
async def open_shared(token: str, body: SharedOpenRequest, request: Request = None,
                      db: AsyncSession = Depends(get_db)):
    link = await _link_from_token(token, db)
    if link.password_hash:
        from app.files.router import _unlock_ok, check_link_password
        # 비밀번호를 원문으로 전송한 경우에도 /unlock 과 동일한 시도 제한을 적용
        if not (_unlock_ok(token, body.access)
                or (body.password and await check_link_password(link, body.password, request))):
            raise HTTPException(status_code=401, detail="password_required")
    # 다운로드 링크의 제한은 편집기로 여는 경로에도 동일하게 적용한다 — 여기서 발급받은 토큰으로 WOPI GetFile 을 호출하면 원본을 그대로
    # 받을 수 있어, 이전에는 횟수를 소진한 1회용 링크·"다운로드 막음" 링크가 이 경로로 우회되었다.
    if link.max_downloads and (link.download_count or 0) >= link.max_downloads:
        raise HTTPException(status_code=410, detail="다운로드 횟수를 초과했습니다")
    if link.allow_download is False and not link.can_edit:
        raise HTTPException(status_code=403, detail="이 링크는 다운로드가 막혀 있습니다(미리보기만 가능)")
    if Path(link.file_path).suffix.lower() not in _ALL_OFFICE_EXTS:
        raise HTTPException(status_code=400, detail="이 링크는 같이 편집할 수 있는 문서가 아닙니다(다운로드 링크입니다)")

    owner = await db.get(User, link.created_by)
    if not owner or not owner.is_active:
        raise HTTPException(status_code=404, detail="링크를 만든 사용자를 찾을 수 없습니다")
    try:
        real_path = resolve_path(link.file_path, owner)
    except (PathSecurityError, AccessDeniedError):
        raise HTTPException(status_code=403, detail="열 수 없는 문서입니다")
    if not real_path.is_file():
        raise HTTPException(status_code=404, detail="문서가 삭제되었거나 이동되었습니다")
    if not await _check_editor_available("onlyoffice"):
        raise HTTPException(status_code=503, detail="편집기를 지금 사용할 수 없습니다")

    # 이름이 중복되어도 OnlyOffice 협업 표시에서 구분되도록 id 를 별도로 부여.
    guest_id = secrets.token_hex(4)
    guest_name = (body.name or "").strip()[:20] or f"게스트 {guest_id[:4]}"
    can_edit = bool(getattr(link, "can_edit", False))

    wopi_token = create_wopi_token(
        user_id=f"guest-{guest_id}",
        user_name=guest_name,
        virtual_path=link.file_path,
        permissions="edit" if can_edit else "view",
        owner_id=owner.id,
        scope=session_scope(link.file_path, owner.id),
        link_id=link.id,
    )
    wopi_src = f"{settings.app_url}/api/wopi/files/{_encode_file_id(link.file_path, session_scope(link.file_path, owner.id))}"
    logger.info("shared open: %s by guest %s (edit=%s)", link.file_path, guest_id, can_edit)
    return SharedOpenResponse(
        editor="onlyoffice",
        editor_url=await _build_editor_url("onlyoffice", wopi_src, wopi_token, real_path.name),
        token=wopi_token,
        token_ttl=settings.wopi_token_ttl,
        file_name=real_path.name,
        wopi_src=wopi_src,
        can_edit=can_edit,
        guest_name=guest_name,
    )


class SharedInfoResponse(BaseModel):
    """게스트 화면(/s/<token>)이 열기 전에 표시할 정보. 다운로드 횟수는 증가시키지 않는다."""
    name: str
    size: int | None = None
    is_office: bool = False
    can_edit: bool = False
    allow_download: bool = True
    requires_password: bool = False
    is_multi: bool = False
    is_folder: bool = False  # 단일 폴더 링크 — /api/files/shared/{token}/list 로 탐색
    item_count: int = 1
    expires_at: str | None = None
    downloads_left: int | None = None  # 횟수 제한이 없으면 null
    owner_name: str | None = None
    exists: bool = True
    # 다운로드가 차단된 링크에서 열람 가능한 대상의 유무 — 파일 하나이면 미리보기 가능 형식(files.router._preview_kind), 폴더이면 true,
    # 묶음(zip)은 false. 비밀번호 링크는 해제 전에는 알 수 없다(true) — /unlock 응답의 can_preview 로 전달된다.
    can_preview: bool = True


@router.get("/shared/{token}/info", response_model=SharedInfoResponse)
async def shared_info(token: str, db: AsyncSession = Depends(get_db)):
    """공유 링크 정보(인증 없음). 비밀번호 링크이면 이름·크기 등 내용 정보는 숨기고
    requires_password=true 만 반환한다. 다운로드 횟수는 변경하지 않는다."""
    import json as _json
    from app.files.router import is_folder_link, link_preview_kind
    link = await _link_from_token(token, db)
    owner = await db.get(User, link.created_by)
    left = None
    if link.max_downloads:
        left = max(0, link.max_downloads - (link.download_count or 0))
    exp = link.expires_at.isoformat() if link.expires_at else None
    if link.password_hash:
        return SharedInfoResponse(name="", requires_password=True, expires_at=exp, downloads_left=left,
                                  can_edit=bool(link.can_edit), allow_download=link.allow_download is not False)
    paths = []
    if link.paths:
        try:
            paths = _json.loads(link.paths)
        except ValueError:
            paths = []
    size = None
    exists = True
    if not paths and owner is not None:
        try:
            real = resolve_path(link.file_path, owner)
            exists = real.is_file()
            size = real.stat().st_size if exists else None
        except (PathSecurityError, AccessDeniedError):
            exists = False
    is_folder = bool(paths) and len(paths) == 1 and is_folder_link(link)
    return SharedInfoResponse(
        name=link.display_name,
        size=size,
        is_office=Path(link.file_path).suffix.lower() in _ALL_OFFICE_EXTS and not paths,
        can_edit=bool(link.can_edit),
        allow_download=link.allow_download is not False,
        requires_password=False,
        is_multi=bool(paths),
        is_folder=is_folder,
        can_preview=is_folder or link_preview_kind(link) is not None,
        item_count=len(paths) or 1,
        expires_at=exp,
        downloads_left=left,
        owner_name=(owner.display_name or owner.username) if owner else None,
        exists=exists,
    )
