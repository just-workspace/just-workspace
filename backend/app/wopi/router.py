"""WOPI host endpoints + editor session opener."""

import base64
import hashlib
import logging
import re
import time as _time
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.files.service import resolve_path, PathSecurityError, AccessDeniedError
from app.modules.registry import require_module
from app.wopi.locks import subject as lock_subject
from app.wopi.locks import (
    acquire_lock,
    get_current_lock_id,
    get_lock,
    refresh_lock,
    release_lock,
)
from app.wopi.schemas import (
    EditorOpenRequest,
    EditorOpenResponse,
    LockStatusResponse,
    WopiFileInfo,
)
from app.wopi.tokens import create_wopi_token, validate_wopi_token

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/wopi", tags=["wopi"])

# ── Helpers ──────────────────────────────────────────────

# Extension → editor preference
_MS_OFFICE_EXTS = {".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"}
_ODF_EXTS = {".odt", ".ods", ".odp"}
# .hwp 는 지원하지 않는다. LibreOffice(Collabora) 필터로만 열렸는데 그 편집기를 걷어냈고,
# hwpx 는 애초에 필터가 없었다.
_ALL_OFFICE_EXTS = _MS_OFFICE_EXTS | _ODF_EXTS


_FILE_ID_V2 = "o:"


def _encode_file_id(virtual_path: str, owner_id: str | None = None) -> str:
    """(소유자, 경로) → URL-safe file_id. 문서 서버는 WOPISrc(=file_id)로 편집 세션을 묶으므로
    소유자를 넣어 서로 다른 사용자의 같은 이름 문서가 한 세션으로 섞이지 않게 한다."""
    raw = f"{_FILE_ID_V2}{owner_id}|{virtual_path}" if owner_id else virtual_path
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_file_id_parts(file_id: str) -> tuple[str | None, str]:
    """file_id → (소유자 또는 None(예전 형식), 경로)."""
    padding = 4 - len(file_id) % 4
    if padding != 4:
        file_id += "=" * padding
    try:
        raw = base64.urlsafe_b64decode(file_id).decode()
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=404, detail="File not found")
    if raw.startswith(_FILE_ID_V2) and "|" in raw:
        owner, _, path = raw[len(_FILE_ID_V2):].partition("|")
        return owner or None, path
    return None, raw


def _decode_file_id(file_id: str) -> str:
    """Decode file_id back to virtual path."""
    return _decode_file_id_parts(file_id)[1]


SHARED_SCOPE = "shared"


def session_scope(virtual_path: str, owner_id: str) -> str:
    """편집 세션(file_id)·잠금을 묶는 키.

    내 파일(my/..)은 소유자 id — 사용자마다 같은 이름 문서가 있어도 섞이지 않는다(H9).
    팀 공유 폴더(shared/..)는 모두에게 같은 파일이라 고정값이다. 예전엔 여기에도 여는 사람 id 를 넣어
    두 사람이 같은 문서를 열면 편집 세션·잠금이 따로 잡혔고, 나중에 저장한 쪽이 앞사람 편집을 덮어썼다.
    """
    vp = (virtual_path or "").strip("/")
    return SHARED_SCOPE if vp.startswith("shared/") else owner_id


def _token_owner_id(token_data: dict) -> str:
    """세션·잠금 키. 옛 토큰(scope 없음)은 owner_id — 배포 전에 열린 세션은 옛 file_id·옛 잠금 키로 끝까지 간다."""
    return str(token_data.get("scope") or token_data.get("owner_id") or token_data["user_id"])


def _check_token_file(token_data: dict, file_id: str) -> str:
    """토큰이 이 file_id(소유자·경로)용인지 — 경로를 돌려준다."""
    owner, virtual_path = _decode_file_id_parts(file_id)
    if token_data.get("file_path") != virtual_path:
        raise HTTPException(status_code=403, detail="Token/path mismatch")
    if owner is not None and owner != _token_owner_id(token_data):
        raise HTTPException(status_code=403, detail="Token/path mismatch")
    return virtual_path


def _lock_subject(token_data: dict, virtual_path: str) -> str:
    return lock_subject(_token_owner_id(token_data), virtual_path)


def _atomic_write(real_path: Path, body: bytes) -> None:
    """임시 파일에 쓰고 바꿔치기 — 쓰다 실패해도(디스크 가득·중단) 원본이 잘리지 않는다."""
    import os
    import secrets
    real_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = real_path.parent / f".wopi-{secrets.token_hex(8)}.part"
    try:
        with open(tmp, "wb") as f:
            f.write(body)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, real_path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _file_hash(file_path: Path) -> str:
    """SHA256 of file content (for WOPI Version)."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


async def _check_editor_available(editor: str) -> bool:
    """Check if an editor service is reachable."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            if editor == "onlyoffice" and settings.onlyoffice_jwt_secret:
                resp = await client.get(f"{settings.onlyoffice_url}/healthcheck")
                return resp.status_code == 200 and resp.text.strip() == "true"
    except Exception:
        pass
    return False


def _select_editor(filename: str, preferred: str) -> str | None:
    """이 파일을 열 편집기. 지금은 OnlyOffice 하나다.

    예전에는 Collabora 를 함께 두고 골랐는데, OnlyOffice 가 안 되던 건 OnlyOffice 문제가
    아니라 우리 쪽 두 가지 버그였다(변수 proxy_pass 가 경로를 통째로 대체 + access_token 을
    POST 본문이 아니라 쿼리로 보냄). 둘 다 고친 뒤로 Collabora 는 켜지지 않는 채로 남아
    있었고, 편집기가 둘이면 잠금·버전·저장 경로를 두 벌 검증해야 해서 걷어냈다.
    한글(.hwp)은 어차피 포기한 포맷이라 남길 이유도 없었다.

    `preferred` 는 옛 API 호환을 위해 받기만 하고 무시한다.
    """
    ext = Path(filename).suffix.lower()
    if ext not in _ALL_OFFICE_EXTS:
        return None
    return "onlyoffice" if settings.onlyoffice_jwt_secret else None


# OnlyOffice WOPI app 경로 (확장자 → word/cell/slide). 경로는 버전 무관 안정적.
_ONLYOFFICE_APP_BY_EXT = {
    "doc": "word", "docx": "word", "docm": "word", "dot": "word", "dotx": "word",
    "odt": "word", "rtf": "word", "txt": "word",
    "xls": "cell", "xlsx": "cell", "xlsm": "cell", "ods": "cell", "csv": "cell",
    "ppt": "slide", "pptx": "slide", "pps": "slide", "ppsx": "slide", "odp": "slide",
}
async def _build_editor_url(editor: str, wopi_src: str, token: str, filename: str) -> str:
    """WOPI 액션 URL (nginx 프록시 경로)."""
    ext = Path(filename).suffix.lower().lstrip(".")
    app = _ONLYOFFICE_APP_BY_EXT.get(ext, "word")
    # OnlyOffice 는 WOPI 표준대로 access_token 을 **POST 폼 본문**으로만 받는다.
    # 쿼리스트링에 붙여 GET 하면 404 다. 토큰은 응답의 token/token_ttl 로 따로 내려가고,
    # 프론트가 폼으로 제출한다.
    path = f"/onlyoffice/hosting/wopi/{app}/edit"
    return f"{path}?WOPISrc={quote(wopi_src, safe='')}"


# ── Token-based auth for WOPI endpoints ──────────────────


async def _token_owner(token_data: dict, db: AsyncSession) -> User:
    """경로를 풀 기준 사용자. 옛 토큰(owner_id 없음)은 user_id 가 곧 소유자다."""
    owner = await db.get(User, token_data.get("owner_id") or token_data["user_id"])
    if not owner:
        raise HTTPException(status_code=401, detail="User not found")
    return owner


async def _recheck_share_edit(token_data: dict, virtual_path: str, db: AsyncSession) -> None:
    """공유받은 사람(계정 있음)이 연 편집 토큰이면 저장할 때 권한을 다시 본다(p9).

    토큰은 열 때 한 번 발급돼 TTL 동안 살아 있다 — 그 사이 권한이 보기·댓글로 내려가거나 공유가 해제되면
    저장을 거부한다. 소유자 본인 토큰은 해당 없음.

    공유 링크 손님(guest-…)은 그 링크를 다시 본다 — 예전엔 건너뛰어, 편집 링크를 회수·만료시켜도
    이미 받은 토큰으로 TTL(2시간) 동안 계속 저장할 수 있었다. 링크가 없거나(회수) 만료됐거나
    같이 편집이 꺼졌거나 다른 파일을 가리키면 거부한다. link_id 가 없는 옛 토큰(배포 전 발급)은 그대로 둔다.
    """
    editor_id = str(token_data.get("user_id") or "")
    owner_id = token_data.get("owner_id")
    if editor_id.startswith("guest-"):
        link_id = token_data.get("link_id")
        if not link_id:
            return
        from datetime import datetime, timezone
        from app.db.models import ShareLink
        link = await db.get(ShareLink, link_id)
        exp = link.expires_at if link is not None else None
        if exp is not None and exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if (link is None or not link.can_edit or (exp is not None and exp < datetime.now(timezone.utc))
                or (link.file_path or "").strip("/") != (virtual_path or "").strip("/")):
            raise HTTPException(status_code=403, detail="공유 링크가 회수되었거나 만료되었습니다")
        return
    if not owner_id or owner_id == editor_id:
        return
    from app.files import access as acc
    editor = await db.get(User, editor_id)
    role = None
    if editor is not None and getattr(editor, "is_active", True):
        role, _ = await acc.role_on(db, editor, owner_id, virtual_path)
    if not acc.at_least(role, "edit"):
        raise HTTPException(status_code=403, detail="편집 권한이 없습니다")


def _get_token_data(access_token: str = Query(...)) -> dict:
    """Validate WOPI access token from query parameter."""
    data = validate_wopi_token(access_token)
    if not data:
        raise HTTPException(status_code=401, detail="Invalid or expired WOPI token")
    return data


# ── Session-authenticated: editor opener ─────────────────


@router.post("/open", response_model=EditorOpenResponse)
@require_module("files")
async def open_editor(
    req: EditorOpenRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get editor URL and WOPI token for opening a document.

    공유받은 경로(shared-with-me/..)는 보기 권한 이상이면 열고, 편집 권한 이상일 때만 쓰기 토큰(p9).
    토큰의 경로·owner 는 원 소유자 기준('my/..', owner_id=소유자) — 원 소유자와 같은 문서 세션에서 같이 편집한다.
    """
    from app.files import access as acc
    token_path, owner_id, permissions = req.path.strip("/"), None, "edit"
    if acc.parse_shared(req.path):
        a = await acc.resolve(db, user, req.path, "view")
        real_path = a.real
        token_path, owner_id = a.owner_vpath, a.owner_id
        permissions = "edit" if acc.at_least(a.role, "edit") else "view"
    else:
        # Resolve path to validate access
        try:
            real_path = resolve_path(req.path, user)
        except (PathSecurityError, AccessDeniedError) as e:
            raise HTTPException(status_code=403, detail=str(e))

    if not real_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    if owner_id is None and token_path.startswith("users/") and user.is_admin:
        # 관리자가 "전체 사용자"에서 연 문서 — 소유자가 my/.. 로 연 것과 같은 세션·잠금이 되게 맞춘다
        seg = token_path.split("/", 2)
        if len(seg) == 3 and await db.get(User, seg[1]) is not None:
            owner_id, token_path = seg[1], "my/" + seg[2]

    filename = real_path.name
    editor = _select_editor(filename, req.editor)
    if not editor:
        raise HTTPException(
            status_code=400,
            detail="No office editor available for this file type",
        )

    if not await _check_editor_available(editor):
        raise HTTPException(
            status_code=503,
            detail=f"Editor service '{editor}' is not available",
        )

    # Create WOPI token
    token = create_wopi_token(
        user_id=user.id,
        user_name=user.display_name or user.username,
        virtual_path=token_path,
        permissions=permissions,
        owner_id=owner_id,
        scope=session_scope(token_path, owner_id or user.id),
    )

    file_id = _encode_file_id(token_path, session_scope(token_path, owner_id or user.id))
    wopi_src = f"{settings.app_url}/api/wopi/files/{file_id}"
    editor_url = await _build_editor_url(editor, wopi_src, token, filename)

    return EditorOpenResponse(
        editor=editor,
        editor_url=editor_url,
        token=token,
        token_ttl=settings.wopi_token_ttl,
        file_name=filename,
        wopi_src=wopi_src,
    )


# ── Session-authenticated: lock status for UI ────────────


@router.get("/lock-status", response_model=LockStatusResponse)
@require_module("files")
async def lock_status(
    path: str = Query(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Check if a file is currently locked (for UI indicators).

    볼 수 있는 파일만, 소유자 기준 잠금으로 조회한다(남의 같은 이름 문서 잠금을 보지 않는다).
    """
    from app.files import access as acc
    if acc.parse_shared(path):
        a = await acc.resolve(db, user, path, "view")
        owner_id, owner_vpath = a.owner_id, a.owner_vpath
    else:
        try:
            resolve_path(path, user)
        except (PathSecurityError, AccessDeniedError) as e:
            raise HTTPException(status_code=403, detail=str(e))
        owner_id, owner_vpath = user.id, path.strip("/")
        if owner_vpath.startswith("users/") and user.is_admin:
            seg = owner_vpath.split("/", 2)
            if len(seg) == 3:
                owner_id, owner_vpath = seg[1], "my/" + seg[2]
    lock = await get_lock(lock_subject(session_scope(owner_vpath, owner_id), owner_vpath))
    if not lock:
        return LockStatusResponse(locked=False)
    return LockStatusResponse(
        locked=True,
        user_id=lock.get("user_id"),
        user_name=lock.get("user_name"),
        editor=lock.get("editor"),
    )


# ── WOPI File endpoints (token-authenticated) ────────────


@router.get("/files/{file_id}")
async def wopi_check_file_info(
    file_id: str,
    access_token: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """WOPI CheckFileInfo — returns file metadata."""
    token_data = _get_token_data(access_token)
    virtual_path = _check_token_file(token_data, file_id)

    user = await _token_owner(token_data, db)

    try:
        real_path = resolve_path(virtual_path, user)
    except (PathSecurityError, AccessDeniedError):
        raise HTTPException(status_code=403, detail="Access denied")

    if not real_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    stat = real_path.stat()

    info = WopiFileInfo(
        BaseFileName=real_path.name,
        Size=stat.st_size,
        OwnerId=token_data["user_id"],
        UserId=token_data["user_id"],
        UserFriendlyName=token_data.get("user_name", "User"),
        Version=str(int(stat.st_mtime * 1000)),
        UserCanWrite=token_data["permissions"] == "edit",
        PostMessageOrigin=settings.app_url,
        HostEditUrl=f"{settings.app_url}/files",
        HostViewUrl=f"{settings.app_url}/files",
    )
    return JSONResponse(content=info.model_dump())


@router.get("/files/{file_id}/contents")
async def wopi_get_file(
    file_id: str,
    access_token: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """WOPI GetFile — returns raw file bytes."""
    token_data = _get_token_data(access_token)
    virtual_path = _check_token_file(token_data, file_id)

    user = await _token_owner(token_data, db)

    try:
        real_path = resolve_path(virtual_path, user)
    except (PathSecurityError, AccessDeniedError):
        raise HTTPException(status_code=403, detail="Access denied")

    if not real_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    # media_type 을 안 주면 Starlette 가 파일명으로 추측하는데, 슬림 이미지엔 mime
    # 데이터베이스가 없어 xlsx/docx/pptx 가 전부 "text/plain; charset=utf-8" 로 나간다.
    # WOPI GetFile 은 원시 바이트를 그대로 줘야 하므로 octet-stream 으로 고정한다.
    return FileResponse(
        path=str(real_path),
        filename=real_path.name,
        media_type="application/octet-stream",
        headers={"X-WOPI-ItemVersion": str(int(real_path.stat().st_mtime * 1000))},
    )


@router.post("/files/{file_id}/contents")
async def wopi_put_file(
    file_id: str,
    request: Request,
    access_token: str = Query(...),
    x_wopi_lock: str = Header("", alias="X-WOPI-Lock"),
    db: AsyncSession = Depends(get_db),
):
    """WOPI PutFile — save edited file content."""
    token_data = _get_token_data(access_token)
    virtual_path = _check_token_file(token_data, file_id)
    if token_data["permissions"] != "edit":
        raise HTTPException(status_code=403, detail="Read-only token")

    user = await _token_owner(token_data, db)
    await _recheck_share_edit(token_data, virtual_path, db)

    try:
        real_path = resolve_path(virtual_path, user)
    except (PathSecurityError, AccessDeniedError):
        raise HTTPException(status_code=403, detail="Access denied")

    # Check lock
    current_lock = await get_current_lock_id(_lock_subject(token_data, virtual_path))
    if current_lock and current_lock != x_wopi_lock:
        return JSONResponse(
            status_code=409,
            content={"detail": "Lock mismatch"},
            headers={"X-WOPI-Lock": current_lock},
        )

    # Stream body to file
    body = await request.body()
    _atomic_write(real_path, body)

    # Invalidate file listing cache
    from app.files.service import invalidate_cache
    invalidate_cache(real_path.parent)

    logger.info("WOPI PutFile: %s by %s", virtual_path, token_data["user_id"])
    try:
        from app.files import activity as _act
        await _act.record(_act.canonical_key(virtual_path, user), token_data["user_id"], "edit",
                          {"via": "office"}, actor_name=token_data.get("user_name"))
    except Exception:
        pass

    return JSONResponse(
        content={"status": "ok"},
        headers={"X-WOPI-ItemVersion": str(int(real_path.stat().st_mtime * 1000))},
    )


@router.post("/files/{file_id}")
async def wopi_lock_operations(
    file_id: str,
    request: Request,
    access_token: str = Query(...),
    x_wopi_override: str = Header(..., alias="X-WOPI-Override"),
    x_wopi_lock: str = Header("", alias="X-WOPI-Lock"),
    x_wopi_old_lock: str = Header("", alias="X-WOPI-OldLock"),
    db: AsyncSession = Depends(get_db),
):
    """WOPI Lock/Unlock/RefreshLock operations."""
    token_data = _get_token_data(access_token)
    virtual_path = _check_token_file(token_data, file_id)

    op = x_wopi_override.upper()
    subj = _lock_subject(token_data, virtual_path)
    can_edit = token_data.get("permissions") == "edit"

    if op == "GET_LOCK" and not can_edit:
        # 보기 전용 토큰에는 현재 잠금 id 를 알려 주지 않는다(남의 잠금을 풀 재료가 된다)
        return Response(status_code=200, headers={"X-WOPI-Lock": ""})
    if op in ("LOCK", "UNLOCK", "REFRESH_LOCK") and not can_edit:
        raise HTTPException(status_code=403, detail="Read-only token")

    if op == "LOCK":
        if x_wopi_old_lock:
            # Unlock and relock
            await release_lock(subj, x_wopi_old_lock)

        success, existing = await acquire_lock(
            virtual_path=subj,
            lock_id=x_wopi_lock,
            user_id=token_data["user_id"],
            user_name=token_data.get("user_name", ""),
            editor=token_data.get("editor", ""),
        )
        if not success and existing:
            return JSONResponse(
                status_code=409,
                content={"detail": "Lock conflict"},
                headers={"X-WOPI-Lock": existing.get("lock_id", "")},
            )
        return Response(status_code=200, headers={"X-WOPI-ItemVersion": ""})

    elif op == "GET_LOCK":
        lock_id = await get_current_lock_id(subj)
        return Response(
            status_code=200,
            headers={"X-WOPI-Lock": lock_id},
        )

    elif op == "REFRESH_LOCK":
        ok = await refresh_lock(subj, x_wopi_lock)
        if not ok:
            current = await get_current_lock_id(subj)
            return JSONResponse(
                status_code=409,
                content={"detail": "Lock mismatch"},
                headers={"X-WOPI-Lock": current},
            )
        return Response(status_code=200)

    elif op == "UNLOCK":
        ok = await release_lock(subj, x_wopi_lock)
        if not ok:
            current = await get_current_lock_id(subj)
            return JSONResponse(
                status_code=409,
                content={"detail": "Lock mismatch"},
                headers={"X-WOPI-Lock": current},
            )
        return Response(status_code=200, headers={"X-WOPI-Lock": ""})

    else:
        raise HTTPException(status_code=501, detail=f"Unsupported WOPI operation: {op}")
