"""OnlyOffice 로 여는 두 가지 입구 — 새 문서 만들기, 공유 링크로 같이 편집.

공유 링크
---------
받는 사람은 계정이 없다. `/s/<token>` 에서 이름을 받고 여기 `shared/{token}/open` 을 부르면,
링크를 만든 사람을 경로 소유자(owner_id)로, 손님을 편집자(user_id = guest-xxxx)로 삼은
WOPI 토큰을 준다. 그 뒤로는 OnlyOffice ↔ WOPI 엔드포인트가 일반 편집과 같은 길을 탄다.
토큰에 담긴 경로는 링크가 가리키는 파일 하나뿐이라 다른 파일로 바꿔 열 수 없다.
쓰기는 링크에 `can_edit` 가 켜져 있을 때만.
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
    """빈 docx/xlsx/pptx 를 만든다. 이름을 먼저 묻지 않고 바로 만들어 연다(제목은 나중에 바꾼다)."""
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
    """손님이 스스로 밝히는 이름. 없으면 서버가 지어 준다."""
    name: str = ""
    # 비밀번호 링크면 둘 중 하나(p4): 비밀번호 그대로, 또는 /api/files/shared/{token}/unlock 의 access
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
        # 비밀번호를 그대로 보낸 경우에도 /unlock 과 같은 시도 제한을 건다
        if not (_unlock_ok(token, body.access)
                or (body.password and await check_link_password(link, body.password, request))):
            raise HTTPException(status_code=401, detail="password_required")
    # 내려받기 링크의 제한은 편집기로 여는 길에도 같다 — 여기서 받은 토큰이면 WOPI GetFile 로 원본을 그대로
    # 받을 수 있어서, 예전엔 횟수를 다 쓴 1회용 링크·"다운로드 막음" 링크가 이 길로 뚫렸다.
    if link.max_downloads and (link.download_count or 0) >= link.max_downloads:
        raise HTTPException(status_code=410, detail="다운로드 횟수를 초과했습니다")
    if link.allow_download is False and not link.can_edit:
        raise HTTPException(status_code=403, detail="이 링크는 내려받기가 막혀 있습니다(미리보기만 가능)")
    if Path(link.file_path).suffix.lower() not in _ALL_OFFICE_EXTS:
        raise HTTPException(status_code=400, detail="이 링크는 같이 편집할 수 있는 문서가 아닙니다(내려받기 링크입니다)")

    owner = await db.get(User, link.created_by)
    if not owner or not owner.is_active:
        raise HTTPException(status_code=404, detail="링크를 만든 사용자를 찾을 수 없습니다")
    try:
        real_path = resolve_path(link.file_path, owner)
    except (PathSecurityError, AccessDeniedError):
        raise HTTPException(status_code=403, detail="열 수 없는 문서입니다")
    if not real_path.is_file():
        raise HTTPException(status_code=404, detail="문서가 지워졌거나 옮겨졌습니다")
    if not await _check_editor_available("onlyoffice"):
        raise HTTPException(status_code=503, detail="편집기를 지금 쓸 수 없습니다")

    # 이름이 겹쳐도 OnlyOffice 협업 표시에서 구분되게 id 를 따로 둔다.
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
    """손님 화면(/s/<token>)이 열기 전에 보여 줄 정보. 다운로드 횟수는 늘리지 않는다."""
    name: str
    size: int | None = None
    is_office: bool = False
    can_edit: bool = False
    allow_download: bool = True
    requires_password: bool = False
    is_multi: bool = False
    is_folder: bool = False  # 폴더 하나짜리 링크 — /api/files/shared/{token}/list 로 둘러본다
    item_count: int = 1
    expires_at: str | None = None
    downloads_left: int | None = None  # 횟수 제한이 없으면 null
    owner_name: str | None = None
    exists: bool = True
    # 내려받기가 막힌 링크에서 볼 것이 있나 — 파일 하나면 미리보기 가능 형식(files.router._preview_kind), 폴더면 true,
    # 묶음(zip)은 false. 비밀번호 링크는 풀기 전엔 모른다(true) — /unlock 응답의 can_preview 가 알려 준다.
    can_preview: bool = True


@router.get("/shared/{token}/info", response_model=SharedInfoResponse)
async def shared_info(token: str, db: AsyncSession = Depends(get_db)):
    """공유 링크 정보(인증 없음). 비밀번호 링크면 이름·크기 등 내용 정보는 숨기고
    requires_password=true 만 알려 준다. 다운로드 횟수는 건드리지 않는다."""
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
