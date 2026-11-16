"""File browser API endpoints."""

import asyncio
import logging
import os
import secrets
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse

from app.files import serve_safety
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import FileActivity, FileIndex, FileRecent, FileShare, FileStar, ShareLink, User
from app.db.session import get_db
from app.files import access as acc
from app.files import activity as act
from app.files import preview as pv
from app.files import indexer
from app.files import search as fsearch
from app.files import service as fs
from app.files import upload_sessions as us
from app.files.schemas import (
    ChannelShareRequest,
    FileListResponse,
    ShareLinkUpdate,
    ShareUnlockRequest,
    StarRequest,
    RecentRequest,
    MkdirRequest,
    MoveRequest,
    MultiDownloadRequest,
    RenameRequest,
    ShareLinkCreate,
    ShareLinkListItem,
    SearchResponse,
    ShareLinkResponse,
    StorageInfo,
    TrashItem,
    TrashListResponse,
    TrashRestoreRequest,
)

router = APIRouter(prefix="/api/files", tags=["files"])
settings = get_settings()
logger = logging.getLogger(__name__)

EXPIRES_MAP = {"1h": 1, "1d": 24, "7d": 168, "30d": 720}  # hours — 30d 는 메일 대용량 첨부


# ─── Helpers ───


def _check_path(virtual_path: str, user: User) -> Path:
    """Resolve + enforce security. Returns real Path or raises HTTP error."""
    try:
        return fs.resolve_path(virtual_path, user)
    except fs.PathSecurityError:
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    except fs.AccessDeniedError:
        raise HTTPException(status_code=403, detail="Access denied")


def _safe_filename(raw_name: str | None) -> str:
    """업로드 파일명 검증: 이름 전체가 `..`·널바이트·제어문자·숨김(. 시작)·NAS 시스템 이름(@Recycle 등) 차단. 실패 시 400."""
    # 규칙은 fs.validate_name 으로 단일화(새 폴더·이름 변경과 동일). 과거에는 이름 내 위치와 무관하게 '..' 가 있으면 차단하여
    # "v1..2.txt"·"결과...최종.pdf" 같은 정상 파일도 영문 "Invalid filename" 으로 실패했다.
    try:
        return fs.validate_name(os.path.basename(raw_name or "upload"))
    except fs.InvalidNameError as e:
        raise HTTPException(status_code=400, detail=f"업로드할 수 없는 파일 이름입니다 — {e}")


def _client_mtime(mtime: int | None, header: str | None) -> int | None:
    """클라이언트가 전송한 수정 시각(epoch ms). 쿼리 `mtime` 우선, 없으면 `X-File-Mtime`.

    범위를 벗어난 값(초 단위로 잘못 전송한 1970년대, 수백 년 후)은 무시한다 —
    동기화 엔진이 해당 값을 다시 읽어 비교하므로 잘못된 값은 사용하지 않는 편이 안전하다.
    """
    raw = mtime if mtime is not None else header
    if raw is None or raw == "":
        return None
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return None
    # 2001-09-09(1e12 ms) ~ 2286년(1e13 ms). 초 단위 오전송은 여기서 걸러진다.
    if v < 1_000_000_000_000 or v > 9_999_999_999_999:
        return None
    return v


def _file_response(real: Path, request: Request, *, filename: str | None = None,
                   media_type: str | None = None, inline: bool = False) -> Response:
    """ETag / If-None-Match(304) / Accept-Ranges / Range(206) 를 지원하는 파일 응답.

    헤더(형식·Content-Disposition·nosniff·sandbox CSP)는 serve_safety.safe_file_headers 가 결정한다 —
    inline 은 안전한 형식(이미지·PDF·미디어)일 때만 적용하고, 그 외는 attachment + octet-stream.

    Range·If-Range·Accept-Ranges·Last-Modified 는 Starlette FileResponse(1.x)가 처리한다.
    미지원 항목은 조건부 GET(304) 과 본 프로젝트 공식의 ETag 이다 — FileResponse 는 `etag` 를 setdefault
    로 설정하므로 여기서 먼저 지정하면 목록(`FileItem.etag`)과 동일한 값이 송신된다.
    """
    st = real.stat()
    etag = fs.compute_etag(st)
    media, safe_headers = serve_safety.safe_file_headers(
        filename or real.name, content_type=media_type, inline=inline)
    if fs.etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers={"ETag": etag, "Accept-Ranges": "bytes",
                                                  "X-Content-Type-Options": "nosniff"})
    return FileResponse(
        path=str(real),
        media_type=media,
        stat_result=st,
        headers={"ETag": etag, **safe_headers},
    )


# ─── Directory listing ───


@router.get("/list", response_model=FileListResponse)
async def list_files(
    path: str = Query("my/", description="Virtual path"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    vp = path.strip("/")

    # Root listing: return virtual roots
    if not vp or vp in ("", "."):
        roots = [
            {"name": "내 파일", "path": "my", "is_dir": True, "size": 0, "modified_at": None, "mime_type": None},
            {"name": "공유 파일", "path": "shared", "is_dir": True, "size": 0, "modified_at": None, "mime_type": None},
        ]
        if user.is_admin:
            roots.append(
                {"name": "전체 사용자", "path": "users", "is_dir": True, "size": 0, "modified_at": None, "mime_type": None}
            )
        return FileListResponse(path="", items=roots)

    # 공유받은 폴더 내부(이동 대화상자 트리 등) — 공유 탐색과 동일 규칙
    parsed = acc.parse_shared(vp)
    if parsed:
        res = await list_shared_folder(share_id=parsed[0], path=parsed[1], user=user, db=db)
        return FileListResponse(path=res["path"], items=res["items"])

    # Ensure user directory exists for "my" paths
    if vp == "my" or vp.startswith("my/"):
        fs.ensure_user_dir(user)
    if vp == "shared" or vp.startswith("shared/"):
        fs.ensure_shared_dir()

    real = _check_path(vp, user)
    if not real.exists():
        # 루트(my/, shared/)는 앞에서 ensure_*_dir 로 이미 보장했다.
        # 그 하위 경로까지 자동 생성하면, 이름이 불일치한 요청 한 번으로
        # 빈 디렉터리가 새로 생성되어 저장소가 오염된다(예:
        # 파일명이 손상된 폴더를 정상 이름으로 조회 → 빈 폴더가 생성되어
        # "이 폴더는 비어 있습니다"로 표시된다).
        raise HTTPException(status_code=404, detail="경로를 찾을 수 없습니다")

    items = await asyncio.to_thread(fs.list_directory, real, vp)
    items = await _decorate_items(db, user, vp, items)
    return FileListResponse(path=vp, items=items)


async def _decorate_items(db: AsyncSession, user: User, vp: str, items: list) -> list:
    """목록 항목에 소유자·즐겨찾기 표시를 추가한다(캐시된 객체는 변경하지 않고 복사본에 적용).

    소유자: my/ 는 요청 사용자, users/<id>/ 는 해당 사용자, shared/ 는 최초 업로드 사용자(활동 기록 기준 —
    기록 도입 이전에 업로드된 파일은 알 수 없어 null).
    """
    if not items:
        return items
    try:
        paths = [it.path for it in items]
        starred = set((await db.execute(
            select(FileStar.path).where(FileStar.user_id == user.id, FileStar.path.in_(paths))
        )).scalars().all())
        owner_ids: dict[str, str | None] = {}
        if vp == "my" or vp.startswith("my/"):
            owner_ids = {it.path: user.id for it in items}
        elif vp.startswith("users/"):
            parts = vp.split("/")
            for it in items:
                owner_ids[it.path] = parts[1] if len(parts) > 1 else it.name
        elif vp == "shared" or vp.startswith("shared/"):
            creators = await act.first_creators(db, paths)
            owner_ids = {pth: creators.get(pth) for pth in paths}
        names = await act.user_names(db, {i for i in owner_ids.values() if i})
        out = []
        for it in items:
            oid = owner_ids.get(it.path)
            out.append(it.model_copy(update={
                "is_starred": it.path in starred,
                "owner": {"id": oid, "name": names.get(oid, "?")} if oid else None,
            }))
        return out
    except Exception:
        # 신규 테이블이 아직 없거나 조회 실패 — 목록 자체는 그대로 반환한다
        return items


# ─── 검색 ───
#
# 과거에는 요청마다 os.walk 로 트리를 순회하고 파일명 부분일치만 확인했다. 현재는
# 색인(file_index)을 조회한다 — 내용 검색, 점수 기준 정렬, 연산자를 통한 범위
# 한정이 가능하다. 색인은 app/files/indexer.py 가 주기적으로 갱신한다.


def _search_scopes(user: User, path: str | None) -> list[str]:
    """해당 사용자가 검색 가능한 scope 목록. path 가 주어지면 그에 맞춰 범위를 한정한다."""
    vp = (path or "").strip("/")
    root = vp.split("/", 1)[0] if vp else ""
    if root == "my":
        return [user.id]
    if root == "shared":
        return ["shared"]
    if root == "users" and user.is_admin:
        rest = vp.split("/", 2)
        return [rest[1]] if len(rest) > 1 else []
    return [user.id, "shared"]          # 범위 미지정 시 본인 영역 + 공유


@router.get("/search", response_model=SearchResponse)
async def search_files(
    q: str = Query(..., description="검색어. ext:/kind:/in:/after:/size: 연산자와 \"구\" 지원"),
    path: str | None = Query(None, description="이 가상폴더 아래로 한정(생략하면 내 파일+공유 전체)"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    scopes = _search_scopes(user, path)
    if not scopes:
        return SearchResponse(query=q, total=0, items=[])

    # path 가 폴더까지 지정하면 그 하위로 한정한다(in: 연산자와 동일한 효과)
    vp = (path or "").strip("/")
    parts = vp.split("/", 1)
    sub = parts[1] if len(parts) > 1 and parts[0] in ("my", "shared") else ""
    if vp.startswith("users/"):
        seg = vp.split("/", 2)
        sub = seg[2] if len(seg) > 2 else ""
    query = f'{q} in:{sub}' if sub else q

    res = await fsearch.search(db, query, scopes, user.id, limit=limit, offset=offset)
    return SearchResponse(**res)


@router.post("/search/reindex")
async def reindex(user: User = Depends(get_current_user)):
    """색인을 즉시 재생성한다(관리자)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")
    stats = await indexer.reindex_all()
    return {"scopes": stats}


@router.get("/search/status")
async def search_status(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """색인 현황 — 전체 항목 수와 본문 보유 항목 수."""
    scopes = _search_scopes(user, None)
    total = (await db.execute(
        select(func.count()).select_from(FileIndex).where(FileIndex.scope.in_(scopes))
    )).scalar() or 0
    with_text = (await db.execute(
        select(func.count()).select_from(FileIndex).where(
            FileIndex.scope.in_(scopes), FileIndex.content.isnot(None)
        )
    )).scalar() or 0
    last = (await db.execute(
        select(func.max(FileIndex.indexed_at)).where(FileIndex.scope.in_(scopes))
    )).scalar()
    return {"indexed": total, "with_content": with_text, "last_indexed_at": last}


# ─── Download ───


@router.get("/download")
async def download_file(
    request: Request,
    path: str = Query(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """내려받기. 공유받은 경로(shared-with-me/..)는 보기 권한 이상."""
    real = (await acc.resolve(db, user, path, "view")).real
    if not real.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return _file_response(real, request, filename=real.name)


# ─── Download folder as ZIP ───


def _stream_zip(entries):
    """Yield a ZIP archive built on the fly from (abs_path, arcname) pairs.

    Writes into a non-seekable in-memory sink so each compressed chunk is flushed
    to the client immediately (per-entry data descriptors). Memory stays flat and
    the client's progress bar advances from the first byte instead of stalling
    while a whole temp archive is pre-built.
    """
    import zipfile

    # Already-compressed formats: DEFLATE-ing them is pure wasted CPU (single
    # threaded) and shrinks ~nothing, so store them uncompressed and let the
    # transfer run at disk-read speed. Everything else gets cheap level-1 DEFLATE.
    _STORED_EXT = {
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".avif", ".bmp",
        ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv",
        ".mp3", ".aac", ".ogg", ".oga", ".flac", ".opus", ".m4a", ".wav",
        ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".lz4",
        ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".epub", ".apk",
    }

    class _Sink:
        __slots__ = ("buf",)

        def __init__(self):
            self.buf = bytearray()

        def write(self, data):
            self.buf.extend(data)
            return len(data)

        def flush(self):
            pass

    sink = _Sink()
    # compresslevel=1: fast DEFLATE for compressible files; media is STORED below.
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED, allowZip64=True, compresslevel=1) as zf:
        for abs_path, arcname in entries:
            try:
                zi = zipfile.ZipInfo.from_file(abs_path, arcname)
            except OSError:
                continue
            ext = os.path.splitext(arcname)[1].lower()
            zi.compress_type = zipfile.ZIP_STORED if ext in _STORED_EXT else zipfile.ZIP_DEFLATED
            with zf.open(zi, "w") as dest, open(abs_path, "rb") as src:
                while True:
                    chunk = src.read(262144)
                    if not chunk:
                        break
                    dest.write(chunk)
                    if sink.buf:
                        yield bytes(sink.buf)
                        sink.buf.clear()
            if sink.buf:
                yield bytes(sink.buf)
                sink.buf.clear()
    if sink.buf:
        yield bytes(sink.buf)
        sink.buf.clear()


@router.get("/download-zip")
async def download_zip(
    path: str = Query(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    real = (await acc.resolve(db, user, path, "view")).real
    if not real.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    from urllib.parse import quote

    zip_name = f"{real.name}.zip"
    # 한글 등 비ASCII 파일명: RFC 5987 (filename*=UTF-8''..) — latin-1 헤더 인코딩 오류 방지
    ascii_fallback = (real.name.encode("ascii", "ignore").decode() or "download") + ".zip"
    disposition = (
        f"attachment; filename=\"{ascii_fallback}\"; "
        f"filename*=UTF-8''{quote(zip_name)}"
    )
    # zip을 **온더플라이 스트리밍** 생성 — temp파일로 전체를 빌드한 후 송신하면 빌드 동안
    # 클라이언트 진행률이 0B에서 정지한다. 압축 바이트를 생성 즉시 송신하여 진행률이 바로 갱신된다.
    file_paths = ((p, str(p.relative_to(real))) for p in sorted(real.rglob("*")) if p.is_file())
    return StreamingResponse(
        _stream_zip(file_paths),
        media_type="application/zip",
        headers={"Content-Disposition": disposition},
    )


# ─── Download multiple selected files/folders as a single ZIP ───


@router.post("/download-multi")
async def download_multi(
    body: MultiDownloadRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not body.paths:
        raise HTTPException(status_code=400, detail="No paths given")
    # 권한은 스트리밍 전에 전부 확인(공유받은 경로는 보기 이상)
    reals = [(await acc.resolve(db, user, vp, "view")).real for vp in body.paths]

    # 선택 항목들을 하나의 zip 아카이브로 스트리밍. 각 항목의 arcname은 최상위 이름
    # 기준(폴더는 하위 트리 보존)이므로 여러 항목이 zip 루트에 병렬로 포함된다.
    def _collect():
        for real in reals:
            if not real.exists():
                continue
            if real.is_file():
                yield (real, real.name)
            elif real.is_dir():
                base = real.parent
                for p in sorted(real.rglob("*")):
                    if p.is_file():
                        yield (p, str(p.relative_to(base)))

    from urllib.parse import quote

    zip_name = "files.zip"
    disposition = (
        f"attachment; filename=\"{zip_name}\"; "
        f"filename*=UTF-8''{quote(zip_name)}"
    )
    return StreamingResponse(
        _stream_zip(_collect()),
        media_type="application/zip",
        headers={"Content-Disposition": disposition},
    )


# ─── Upload ───


async def _upload_max_bytes(db: AsyncSession) -> tuple[int, int]:
    """(max_mb, max_bytes) — DB 설정 우선, 없으면 .env."""
    from app.admin.settings import get_setting
    db_max = await get_setting(db, "general.upload_max_size_mb")
    max_mb = int(db_max) if db_max else settings.upload_max_size_mb
    return max_mb, max_mb * 1024 * 1024


async def _upload_target(db: AsyncSession, path: str, user: User) -> tuple[str, Path, "acc.Access"]:
    """업로드 대상 디렉터리 (가상경로, 실제경로, 접근). 없으면 생성한다.

    공유받은 폴더(shared-with-me/..)는 편집 권한 이상만 허용 — 파일은 원 소유자 영역에 저장된다.
    """
    vp = path.strip("/") or "my"
    if vp == "my" or vp.startswith("my/"):
        fs.ensure_user_dir(user)
    if vp == "shared" or vp.startswith("shared/"):
        fs.ensure_shared_dir()
    a = await acc.resolve(db, user, vp, "edit")
    real_dir = a.real
    if real_dir.exists() and not real_dir.is_dir():
        raise HTTPException(status_code=400, detail="Target is not a directory")
    real_dir.mkdir(parents=True, exist_ok=True)
    if not real_dir.is_dir():
        raise HTTPException(status_code=400, detail="Target is not a directory")
    return a.vp, real_dir, a


async def _quota_subject(db: AsyncSession, a: "acc.Access", user: User) -> tuple[User, str]:
    """할당 집계 대상 사용자·경로. 공유받은 폴더에 업로드하면 원 소유자의 내 파일 할당에서 집계한다."""
    if a.via_share and a.owner_id and a.owner_vpath:
        owner = await db.get(User, a.owner_id)
        if owner is not None:
            return owner, a.owner_vpath
    return user, a.vp


def _child_key(a: "acc.Access", name: str) -> str | None:
    return f"{a.key}/{name}" if a.key else None


def _snapshot_before_overwrite(a: "acc.Access", target: Path, name: str) -> None:
    """덮어쓰기인 경우 이전본을 버전 스냅샷으로 보관(소유자 기준 my/ 파일만 — 공유받은 경로도 소유자 버전으로 보관)."""
    if not a.owner_id or not a.owner_vpath or not target.is_file():
        return
    rel = fs.owner_relpath_from_my(f"{a.owner_vpath}/{name}")
    if not rel:
        return
    try:
        fs.snapshot_version(target, a.owner_id, rel)
    except Exception:
        pass


def _upload_result(vp: str, target: Path) -> dict:
    st = target.stat()
    return {
        "ok": True,
        "name": target.name,
        "size": st.st_size,
        "path": f"{vp}/{target.name}",
        "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        "etag": fs.compute_etag(st),
    }


@router.post("/upload")
async def upload_file(
    file: UploadFile,
    path: str = Query("my/", description="Target directory virtual path"),
    upload_id: str | None = Query(None, description="클라이언트 생성 ID(디스크 기록 진행률 폴링용)"),
    size: int = Query(0, description="총 바이트(클라이언트가 아는 file.size)"),
    mtime: int | None = Query(None, description="원본 수정 시각(epoch ms) — 보존한다"),
    x_file_mtime: str | None = Header(None, alias="X-File-Mtime"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    max_mb, max_bytes = await _upload_max_bytes(db)
    vp, real_dir, a = await _upload_target(db, path, user)
    # 사용자 기본 할당(관리 › 저장소·백업) — 선언 크기로 사전 검사하고, 기록 중에도 초과하면 중단한다
    from app.files import quota as file_quota
    q_user, q_vp = await _quota_subject(db, a, user)
    room = await file_quota.ensure_room(db, q_user, q_vp, size)
    safe_name = _safe_filename(file.filename)
    client_mtime = _client_mtime(mtime, x_file_mtime)
    target = real_dir / safe_name
    if target.is_dir():
        # 동일 이름의 폴더 위에는 업로드 불가(과거에는 open() 이 IsADirectoryError → 500)
        raise HTTPException(status_code=409, detail="같은 이름의 폴더가 있습니다")

    _overwrite = target.is_file()
    # 대상에 직접 쓰지 않는다 — 과거에는 open(target, "wb") 가 원본을 먼저 비워, 상한 초과·디스크 용량 부족·
    # 중단 시 동일 이름의 기존 파일이 삭제되거나 잘린 상태로 남았다. 숨김 임시 파일에 기록한 후 완료 시 교체한다.
    tmp = real_dir / f".upload-{secrets.token_hex(8)}.part"

    # 디스크 기록 진행률(멀티워커 공유 → Redis). upload_id 있을 때만 보고.
    r = None
    if upload_id:
        try:
            from app.chat.redis_client import get_redis
            r = await get_redis()
        except Exception:
            r = None
    rkey = f"upl:{upload_id}" if upload_id else None

    # Stream write with size check
    written = 0
    last_report = 0
    try:
        with open(tmp, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                over_quota = room is not None and written > room
                if written > max_bytes or over_quota:
                    if r and rkey:
                        try:
                            await r.delete(rkey)
                        except Exception:
                            pass
                    if over_quota:
                        raise file_quota.quota_error(await file_quota.get_user_quota_gb(db))
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds {max_mb}MB limit",
                    )
                f.write(chunk)
                # 4MB마다 기록 진행률 갱신
                if r and rkey and written - last_report >= 4 * 1024 * 1024:
                    last_report = written
                    try:
                        await r.set(rkey, f"{written}:{size}", ex=120)
                    except Exception:
                        pass
            # NFS 등 저속 스토리지의 실제 기록 완료 보장(여기서 디스크 쓰기 완료)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        # 덮어쓰기인 경우 이전본을 버전 스냅샷으로 보관(소유자 my/ 파일만) — 수신 완료 후 수행(실패한 업로드는 버전을 남기지 않음)
        _snapshot_before_overwrite(a, target, safe_name)
        os.replace(tmp, target)
    except BaseException:
        # 실패·취소 — 임시 파일만 삭제한다. 원본은 변경되지 않는다.
        tmp.unlink(missing_ok=True)
        raise

    fs.apply_mtime(target, client_mtime)      # 클라이언트 mtime 보존

    if r and rkey:
        try:
            await r.set(rkey, f"{written}:{size or written}:done", ex=30)
        except Exception:
            pass

    fs.invalidate_cache(real_dir)
    indexer.schedule_quick_index(add=[target])
    await act.record(_child_key(a, safe_name), user.id,
                     "edit" if _overwrite else "upload", {"size": written})
    return _upload_result(vp, target)


@router.get("/upload-progress/{upload_id}")
async def upload_progress(upload_id: str, user: User = Depends(get_current_user)):
    """서버가 실제 디스크에 기록한 바이트(Redis) — 클라이언트의 디스크 기록 진행 표시용."""
    v = None
    try:
        from app.chat.redis_client import get_redis
        r = await get_redis()
        v = await r.get(f"upl:{upload_id}")
    except Exception:
        v = None
    if not v:
        return {"written": 0, "total": 0, "done": False}
    parts = str(v).split(":")
    written = int(parts[0]) if parts and parts[0].isdigit() else 0
    total = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    done = len(parts) > 2 and parts[2] == "done"
    return {"written": written, "total": total, "done": done}


# ─── 청크 업로드 세션 (재개 가능) ───
#
# 프로토콜과 디스크 레이아웃은 app/files/upload_sessions.py 머리말 참고.
# 세션 상태는 전부 디스크(STORAGE_ROOT/.uploads/<id>/)에 저장되므로 어느 워커가 수신해도 무방하다.


class UploadSessionCreate(BaseModel):
    path: str = "my/"             # 대상 디렉터리 가상경로
    name: str                     # 파일명
    size: int = 0                 # 총 바이트(0 = 미상, commit 시 검사 생략)
    mtime: int | None = None      # 원본 수정 시각(epoch ms)


def _sessions_root() -> Path:
    return us.sessions_root(Path(settings.storage_root))


def _load_session(session_id: str, user: User) -> tuple[Path, dict]:
    try:
        d, meta = us.read_meta(_sessions_root(), session_id)
    except us.SessionError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if meta.get("user_id") != user.id:
        # 타 사용자의 세션은 존재 여부도 노출하지 않는다
        raise HTTPException(status_code=404, detail="세션이 없거나 만료되었습니다")
    return d, meta


@router.post("/upload/sessions")
async def create_upload_session(
    body: UploadSessionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    max_mb, max_bytes = await _upload_max_bytes(db)
    if body.size < 0 or body.size > max_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds {max_mb}MB limit")
    vp, _real_dir, a = await _upload_target(db, body.path, user)   # 대상 경로 권한을 이 시점에 확인
    from app.files import quota as file_quota
    q_user, q_vp = await _quota_subject(db, a, user)
    await file_quota.ensure_room(db, q_user, q_vp, body.size)      # 사용자 기본 할당(공유받은 폴더면 소유자)
    safe_name = _safe_filename(body.name)
    meta = await asyncio.to_thread(
        us.create_session, _sessions_root(),
        user_id=user.id, target_vpath=vp, name=safe_name,
        total_size=body.size, mtime_ms=_client_mtime(body.mtime, None),
    )
    return {
        "id": meta["id"],
        "chunk_size": us.CHUNK_SIZE,
        "max_chunk_bytes": us.MAX_CHUNK_BYTES,
        "expires_at": us.expires_at_iso(meta),
    }


@router.get("/upload/sessions/{session_id}")
async def get_upload_session(session_id: str, user: User = Depends(get_current_user)):
    """수신한 청크 목록 — 중단 후 재개 시 누락된 번호만 재전송한다."""
    d, meta = _load_session(session_id, user)
    chunks = await asyncio.to_thread(us.list_chunks, d)
    return {
        "id": meta["id"],
        "name": meta["name"],
        "path": meta["target_vpath"],
        "total_size": meta["total_size"],
        "received": [n for n, _ in chunks],
        "received_bytes": sum(sz for _, sz in chunks),
        "expires_at": us.expires_at_iso(meta),
    }


@router.put("/upload/sessions/{session_id}/{n}")
async def put_upload_chunk(
    session_id: str,
    n: int,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """n번째(1부터) 청크. 본문은 raw 바이트. 동일 번호를 재전송하면 덮어쓴다."""
    d, meta = _load_session(session_id, user)
    try:
        target = us.chunk_path(d, n)
    except us.SessionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _max_mb, max_bytes = await _upload_max_bytes(db)
    declared = int(meta.get("total_size") or 0)
    # 이미 수신한 다른 청크 + 이번 청크가 상한을 초과하면 거부(선언 크기를 신뢰하지 않음)
    others = sum(sz for k, sz in await asyncio.to_thread(us.list_chunks, d) if k != n)

    tmp = target.with_name(target.name + ".part")
    written = 0
    try:
        with open(tmp, "wb") as f:
            async for chunk in request.stream():
                written += len(chunk)
                if written > us.MAX_CHUNK_BYTES or others + written > max_bytes:
                    raise HTTPException(status_code=413, detail="청크 또는 전체 크기 상한 초과")
                if declared and others + written > declared:
                    raise HTTPException(status_code=413, detail="선언한 총 크기를 넘었습니다")
                f.write(chunk)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, target)
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    except Exception:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="청크 저장 실패")
    return {"ok": True, "n": n, "size": written, "received_bytes": others + written}


@router.post("/upload/sessions/{session_id}/commit")
async def commit_upload_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """청크를 연결하여 대상 경로에 배치한다(동일 마운트이므로 원자적 rename). 세션은 삭제한다."""
    d, meta = _load_session(session_id, user)
    vp, real_dir, a = await _upload_target(db, meta["target_vpath"], user)   # 권한 재확인(세션 사이 공유 변동 대비)
    safe_name = _safe_filename(meta["name"])
    target = real_dir / safe_name
    if target.is_dir():
        raise HTTPException(status_code=409, detail="같은 이름의 폴더가 있습니다")
    # 할당은 선언 크기가 아니라 실제 수신 합계로 재검사한다 — 세션을 size=0 으로 생성하면
    # 생성 시의 ensure_room(…, 0) 을 통과하여 할당을 초과해 업로드할 수 있었다.
    from app.files import quota as file_quota
    q_user, q_vp = await _quota_subject(db, a, user)
    await file_quota.ensure_room(db, q_user, q_vp, await asyncio.to_thread(us.received_bytes, d))

    try:
        assembled = await asyncio.to_thread(us.assemble, d, int(meta.get("total_size") or 0) or None)
    except us.SessionError as e:
        raise HTTPException(status_code=409, detail=str(e))

    # 덮어쓰기면 이전본을 버전 스냅샷으로 보관(소유자 my/ 파일만) — 단일 업로드와 동일
    _overwrite = target.is_file()
    await asyncio.to_thread(_snapshot_before_overwrite, a, target, safe_name)

    def _place() -> None:
        try:
            os.replace(assembled, target)
        except OSError:
            # 다른 마운트(예: 임시 영역만 로컬 디스크) 폴백 — 복사 후 세션 정리
            shutil.copyfile(assembled, target)
        fs.apply_mtime(target, meta.get("mtime_ms"))
        us.discard(_sessions_root(), meta["id"])

    await asyncio.to_thread(_place)
    fs.invalidate_cache(real_dir)
    indexer.schedule_quick_index(add=[target])
    await act.record(_child_key(a, safe_name), user.id,
                     "edit" if _overwrite else "upload", {"size": int(meta.get("total_size") or 0)})
    return _upload_result(vp, target)


@router.delete("/upload/sessions/{session_id}")
async def abort_upload_session(session_id: str, user: User = Depends(get_current_user)):
    _load_session(session_id, user)
    await asyncio.to_thread(us.discard, _sessions_root(), session_id)
    return {"ok": True}


# ─── Mkdir ───


@router.post("/mkdir")
async def mkdir(
    body: MkdirRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """새 폴더. 공유받은 폴더 안은 편집 권한 이상."""
    vp = body.path.strip("/")
    parent_vp = "/".join(vp.rsplit("/", 1)[:-1]) if "/" in vp else vp.split("/")[0]
    new_name = vp.rsplit("/", 1)[-1] if "/" in vp else ""

    if not new_name:
        raise HTTPException(status_code=400, detail="Invalid path for mkdir")
    try:
        # 숨김(. 시작)·NAS 시스템 이름·제어문자 등 — 생성 후 목록에 표시되지 않는 폴더를 차단한다
        checked = fs.validate_name(new_name)
    except fs.InvalidNameError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if checked != new_name:        # 앞뒤 공백을 제거한 경우 반환 경로도 일치시킨다
        new_name = checked
        vp = f"{parent_vp}/{new_name}"

    # Ensure base dirs
    if parent_vp == "my" or parent_vp.startswith("my/"):
        fs.ensure_user_dir(user)

    parent = await acc.resolve(db, user, parent_vp, "edit")
    parent_real = parent.real
    parent_real.mkdir(parents=True, exist_ok=True)

    target = parent_real / new_name
    if not target.resolve().is_relative_to(parent_real.resolve()):
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    if target.exists():
        raise HTTPException(status_code=409, detail="Already exists")

    target.mkdir(parents=True)
    fs.invalidate_cache(parent_real)
    indexer.schedule_quick_index(add=[target])
    await act.record(_child_key(parent, new_name), user.id, "mkdir")
    return {"ok": True, "path": vp}


# ─── Delete (soft → trash) ───


def _uid(user: "User | str") -> str:
    return user if isinstance(user, str) else user.id


def _trash_dir(user: "User | str") -> Path:
    """Return the .trash/ directory for the user's storage. (공동 소유자의 삭제는 원 소유자 휴지통으로 이동 — id 도 허용)"""
    trash = Path(settings.storage_root) / "users" / _uid(user) / ".trash"
    trash.mkdir(parents=True, exist_ok=True)
    return trash


def _trash_meta_path(user: "User | str") -> Path:
    """Path to the JSON file mapping trash names → original virtual paths."""
    return Path(settings.storage_root) / "users" / _uid(user) / ".trash_meta.json"


def _load_trash_meta(user: "User | str") -> dict:
    import json
    meta_path = _trash_meta_path(user)
    if meta_path.exists():
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_trash_meta(user: "User | str", meta: dict) -> None:
    import json
    meta_path = _trash_meta_path(user)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


_ROOTS = {"my", "shared", "users"}


def _share_detail(a: "acc.Access") -> dict:
    """공유 경로를 통한 조작인 경우 활동 기록에 남길 정보(실행자는 기록의 user_id)."""
    return {"via_share": a.share.id, "owner_id": a.owner_id} if a.share is not None else {}


@router.delete("/delete")
async def delete_file(
    path: str = Query(...),
    permanent: bool = Query(False, description="Skip trash, delete permanently"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """삭제(기본은 휴지통). 공유받은 경로는 공동 소유자만 가능 — 원 소유자의 휴지통으로 이동하며 실행자를 기록한다."""
    if path.strip("/") in _ROOTS:
        raise HTTPException(status_code=400, detail="최상위 폴더는 삭제할 수 없습니다")
    a = await acc.resolve(db, user, path, "owner")
    real = a.real
    if not real.exists():
        raise HTTPException(status_code=404, detail="Not found")
    # 공유 경로인 경우 저장 영역 소유자(원 소유자) 기준으로 휴지통·원래 경로를 결정한다
    trash_owner = a.owner_id if a.via_share else user.id
    original = a.owner_vpath if a.via_share else path.strip("/")
    link_at = acc.link_scope(a)       # 이 항목에 설정된 공유 링크(생성자, 경로)

    if permanent:
        fs.delete_path(real)
        fs.invalidate_cache(real.parent)
        indexer.schedule_quick_index(forget=[real])
        await asyncio.to_thread(fs.drop_versions, a.owner_id, a.owner_vpath)
        await acc.purge(db, a.owner_id, a.owner_vpath)
        if link_at:
            await acc.purge_links(db, *link_at)
        await act.record(a.key, user.id, "delete", {"permanent": True, **_share_detail(a)})
        return {"ok": True}

    # Soft delete: move to .trash/
    import json
    trash = _trash_dir(trash_owner)
    # Create unique trash name to avoid collisions
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    trash_name = f"{ts}_{real.name}"
    target = trash / trash_name

    # Avoid collision (unlikely but safe)
    counter = 1
    while target.exists():
        trash_name = f"{ts}_{counter}_{real.name}"
        target = trash / trash_name
        counter += 1

    await asyncio.to_thread(shutil.move, str(real), str(target))

    # Save metadata (original virtual path + trashed_at + 삭제 실행자)
    meta = await asyncio.to_thread(_load_trash_meta, trash_owner)
    meta[trash_name] = {
        "original_path": original,
        "trashed_at": datetime.now(timezone.utc).isoformat(),
        "deleted_by": user.id,
    }
    await asyncio.to_thread(_save_trash_meta, trash_owner, meta)

    # 공유·댓글은 휴지통 위치(trash/<이름>)로 이전해 둔다 — 동일 이름의 새 파일에 연결되지 않으며, 복원 시 원위치된다
    if a.owner_id == trash_owner:
        await acc.repoint(db, a.owner_id, a.owner_vpath, acc.trash_key(trash_name))
    # 공유 링크도 휴지통 위치로 이전 — 동일 이름으로 새로 업로드한 파일이 기존 링크로 노출되지 않도록 한다(복원 시 원위치)
    if link_at:
        await acc.repoint_links(db, link_at[0], link_at[1], acc.link_trash_key(trash_owner, trash_name))

    fs.invalidate_cache(real.parent)
    indexer.schedule_quick_index(forget=[real])
    await act.record(a.key, user.id, "delete", {"trash_name": trash_name, **_share_detail(a)})
    return {"ok": True, "trash_name": trash_name}


# ─── Trash: list ───


def _trash_display_name(trash_name: str, info: dict) -> str:
    """휴지통 항목의 원래 이름. 메타의 원래 경로 마지막 조각을 기준으로 하며, 메타가 없으면 "<시각>_" 접두어만 제거한다.

    과거에는 split("_", 2)[-1] 을 사용하여 "보고서_최종.docx" 가 "최종.docx" 로 표시되었다(복원·영구 삭제 확인창 포함).
    """
    orig = (info.get("original_path") or "").strip("/") if isinstance(info, dict) else ""
    if orig:
        return orig.rsplit("/", 1)[-1]
    head, sep, rest = trash_name.partition("_")
    return rest if sep and head.isdigit() and rest else trash_name


@router.get("/trash", response_model=TrashListResponse)
async def list_trash(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    trash = _trash_dir(user)
    meta = await asyncio.to_thread(_load_trash_meta, user)

    items: list[TrashItem] = []
    if trash.exists():
        for entry in sorted(trash.iterdir(), key=lambda e: e.name, reverse=True):
            info = meta.get(entry.name, {})
            stat = entry.stat()
            items.append(TrashItem(
                name=_trash_display_name(entry.name, info),
                original_path=info.get("original_path", ""),
                size=stat.st_size if entry.is_file() else 0,
                trashed_at=info.get("trashed_at"),
                trash_name=entry.name,
            ))

    from app.files.retention import trash_retention_days
    return TrashListResponse(items=items, retention_days=await trash_retention_days(db))


# ─── Trash: restore ───


@router.post("/restore")
async def restore_from_trash(
    body: TrashRestoreRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    trash = _trash_dir(user)
    source = trash / body.trash_name

    # Security: ensure the trash_name doesn't escape .trash/
    if not str(source.resolve()).startswith(str(trash.resolve())):
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    if not source.exists():
        raise HTTPException(status_code=404, detail="Trashed file not found")

    meta = await asyncio.to_thread(_load_trash_meta, user)
    info = meta.get(body.trash_name, {})
    original_vpath = info.get("original_path", "")

    if not original_vpath:
        raise HTTPException(status_code=400, detail="Original path unknown, cannot restore")

    # Resolve the original destination
    try:
        dest = fs.resolve_path(original_vpath, user)
    except (fs.PathSecurityError, fs.AccessDeniedError):
        raise HTTPException(status_code=400, detail="Cannot restore to original path")

    # Ensure parent directory exists
    dest.parent.mkdir(parents=True, exist_ok=True)

    # If destination already exists, add a suffix
    if dest.exists():
        stem = dest.stem
        suffix = dest.suffix
        counter = 1
        while dest.exists():
            dest = dest.parent / f"{stem} ({counter}){suffix}"
            counter += 1

    await asyncio.to_thread(shutil.move, str(source), str(dest))

    # Remove from meta
    meta.pop(body.trash_name, None)
    await asyncio.to_thread(_save_trash_meta, user, meta)

    # 휴지통 위치로 이전해 둔 공유·댓글을 복원된 경로(이름이 변경되었으면 변경된 이름)로 복원한다
    ov = original_vpath.strip("/")
    if ov.startswith("my/"):
        restored = ov.rsplit("/", 1)[0] + "/" + dest.name
        await acc.repoint(db, user.id, acc.trash_key(body.trash_name), restored)
    back = acc.vpath_link_scope(ov.rsplit("/", 1)[0] + "/" + dest.name if "/" in ov else ov, user)
    if back:
        await acc.repoint_links(db, None, acc.link_trash_key(user.id, body.trash_name), back[1], new_creator=back[0])

    fs.invalidate_cache(dest.parent)
    indexer.schedule_quick_index(add=[dest])
    await act.record(act.canonical_key(original_vpath, user), user.id, "restore")
    return {"ok": True, "restored_path": original_vpath}


# ─── Trash: empty (permanent delete all) ───


@router.delete("/trash/empty")
async def empty_trash(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    trash = _trash_dir(user)
    # 휴지통 항목들의 원래 경로 버전 스냅샷도 삭제한다
    for info in (await asyncio.to_thread(_load_trash_meta, user)).values():
        if isinstance(info, dict) and info.get("original_path"):
            await asyncio.to_thread(fs.drop_versions, user.id, info["original_path"])
    if trash.exists():
        for entry in trash.iterdir():
            if entry.is_dir():
                await asyncio.to_thread(shutil.rmtree, str(entry))
            else:
                await asyncio.to_thread(entry.unlink)

    # Clear meta
    await asyncio.to_thread(_save_trash_meta, user, {})
    await acc.purge(db, user.id, acc.TRASH_PREFIX)     # 휴지통 위치로 이전해 둔 공유·댓글도 삭제
    await acc.purge_links(db, None, f"{acc.TRASH_PREFIX}/{user.id}")   # 공유 링크도 삭제
    return {"ok": True}


# ─── Rename ───


@router.patch("/rename")
async def rename_file(
    body: RenameRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이름 변경. 공유받은 경로는 공동 소유자만 가능. 공유·댓글·활동 기록의 경로도 새 이름으로 갱신된다."""
    if body.path.strip("/") in _ROOTS:
        raise HTTPException(status_code=400, detail="최상위 폴더 이름은 변경할 수 없습니다")
    a = await acc.resolve(db, user, body.path, "owner")
    real = a.real
    if not real.exists():
        raise HTTPException(status_code=404, detail="Not found")

    try:
        new_path = fs.rename_path(real, body.new_name)
    except fs.PathSecurityError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))

    fs.invalidate_cache(real.parent)
    indexer.schedule_quick_index(add=[new_path], forget=[real])
    old_vp = body.path.strip("/")
    if a.via_share and not acc.parse_shared(old_vp)[1]:
        new_vp = old_vp            # 공유 루트 자체 — 수신 측 경로(shared-with-me/<id>)는 유지
    else:
        new_vp = old_vp.rsplit("/", 1)[0] + "/" + new_path.name if "/" in old_vp else new_path.name
    new_owner_vp = (a.owner_vpath.rsplit("/", 1)[0] + "/" + new_path.name) if a.owner_vpath else None
    await acc.repoint(db, a.owner_id, a.owner_vpath, new_owner_vp)
    link_at = acc.link_scope(a)
    if link_at:      # 공유 링크도 새 이름으로 갱신(my/ 는 소유자 기준, shared/ 는 해당 경로 그대로)
        await acc.repoint_links(db, link_at[0], link_at[1],
                                link_at[1].rsplit("/", 1)[0] + "/" + new_path.name, new_creator=link_at[0])
    await asyncio.to_thread(fs.move_versions, a.owner_id, a.owner_vpath, new_owner_vp)
    new_key = (a.key.rsplit("/", 1)[0] + "/" + new_path.name) if a.key else None
    await act.move_prefix(user, old_vp, new_vp, old_key=a.key, new_key=new_key)
    await act.record(new_key, user.id, "rename",
                     {"from": real.name, "to": new_path.name, **_share_detail(a)})
    return {"ok": True, "new_name": new_path.name, "path": new_vp}


# ─── Move / Copy ───


@router.patch("/move")
async def move_file(
    body: MoveRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이동(copy=false) 또는 복사(copy=true).

    - 복사 대상 폴더에 동일 이름이 있으면 "이름 (사본).ext" 로 생성한다(동일 폴더 내 복사 포함).
      이동은 기존과 같이 409.
    - 폴더를 자기 자신·하위 폴더로 이동하거나 복사하면 400(무한 복사·shutil 오류 방지).
    - 공유받은 경로: 이동은 원본 공동 소유 + 대상 편집 이상이며 동일 소유자 영역 내에서만 허용한다.
      복사는 원본 보기 + 대상 편집 이상이면 영역 간에도 허용한다(내려받은 후 업로드하는 것과 동일).
      공유·댓글은 이동한 위치로 갱신된다(소유자 영역 밖으로 나가면 삭제).
    """
    if not body.copy and body.src.strip("/") in _ROOTS:
        raise HTTPException(status_code=400, detail="최상위 폴더는 이동할 수 없습니다")
    src = await acc.resolve(db, user, body.src, "view" if body.copy else "owner")
    src_real = src.real
    if not src_real.exists():
        raise HTTPException(status_code=404, detail="Source not found")

    dst = await acc.resolve(db, user, body.dst, "edit")
    if not body.copy and (src.via_share or dst.via_share) and src.owner_id != dst.owner_id:
        raise HTTPException(status_code=400, detail="다른 사람 영역으로는 이동할 수 없습니다(복사는 가능합니다)")
    dst_real = dst.real
    if src_real.is_dir() and (dst_real == src_real or dst_real.is_relative_to(src_real)):
        raise HTTPException(status_code=400, detail="폴더를 자기 안으로 이동하거나 복사할 수 없습니다")
    if not body.copy and dst_real == src_real.parent:
        return {"ok": True, "path": body.src.strip("/")}   # 동일 위치 이동 — no-op
    if dst_real.exists() and not dst_real.is_dir():
        raise HTTPException(status_code=400, detail="대상이 폴더가 아닙니다")
    if body.copy:
        # 복사도 할당을 사용한다 — 과거에는 검사가 없어 동일 파일을 반복 복사하면 할당을 초과할 수 있었다
        from app.files import quota as file_quota
        q_user, q_vp = await _quota_subject(db, dst, user)
        incoming = (src_real.stat().st_size if src_real.is_file()
                    else await asyncio.to_thread(fs.get_dir_size, src_real))
        await file_quota.ensure_room(db, q_user, q_vp, incoming)
    dst_real.mkdir(parents=True, exist_ok=True)

    new_name = None
    if body.copy and (dst_real / src_real.name).exists():
        stem, suffix = (src_real.stem, src_real.suffix) if src_real.is_file() else (src_real.name, "")
        n = 1
        while True:
            cand = f"{stem} (사본){suffix}" if n == 1 else f"{stem} (사본 {n}){suffix}"
            if not (dst_real / cand).exists():
                new_name = cand
                break
            n += 1

    try:
        if new_name:
            target = dst_real / new_name
            if src_real.is_dir():
                await asyncio.to_thread(shutil.copytree, src_real, target)
            else:
                await asyncio.to_thread(shutil.copy2, src_real, target)
        else:
            target = await asyncio.to_thread(fs.move_path, src_real, dst_real, body.copy)
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))

    fs.invalidate_cache(src_real.parent)
    fs.invalidate_cache(dst_real)
    indexer.schedule_quick_index(add=[target], forget=[] if body.copy else [src_real])
    dst_vp = body.dst.strip("/") + "/" + target.name
    new_key = _child_key(dst, target.name)
    detail = {"from": body.src.strip("/"), **_share_detail(src if src.via_share else dst)}
    if body.copy:
        await act.record(new_key, user.id, "copy", detail)
    else:
        new_owner_vp = f"{dst.owner_vpath}/{target.name}" if dst.owner_vpath else None
        if src.owner_id and src.owner_id == dst.owner_id and new_owner_vp:
            await acc.repoint(db, src.owner_id, src.owner_vpath, new_owner_vp)
            await asyncio.to_thread(fs.move_versions, src.owner_id, src.owner_vpath, new_owner_vp)
        else:
            await acc.purge(db, src.owner_id, src.owner_vpath)   # 소유자 영역 밖으로 이동(예: 팀 공유 폴더)
            await asyncio.to_thread(fs.drop_versions, src.owner_id, src.owner_vpath)
        src_link, dst_link = acc.link_scope(src), acc.link_scope(dst)
        if src_link and dst_link:      # 공유 링크도 이동한 위치로 갱신(타 사용자의 my/ 로 들어가면 해당 링크는 삭제된다)
            await acc.repoint_links(db, src_link[0], src_link[1], f"{dst_link[1]}/{target.name}",
                                    new_creator=dst_link[0])
        elif src_link:
            await acc.purge_links(db, *src_link)
        await act.move_prefix(user, body.src.strip("/"), dst_vp, old_key=src.key, new_key=new_key)
        await act.record(new_key, user.id, "move", detail)
    return {"ok": True, "path": dst_vp}


# ─── Preview ───


@router.get("/preview")
async def preview_file(
    request: Request,
    path: str = Query(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """미리보기. 공유받은 경로(shared-with-me/..)는 보기 권한 이상."""
    real = (await acc.resolve(db, user, path, "view")).real
    if not real.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    ptype = pv.can_preview(real)
    if not ptype and real.suffix.lower() in pv.OFFICE_TEXT_EXTENSIONS:
        # 오피스 문서는 텍스트만 제공(편집기 대신 "미리보기로 열기")
        text = await asyncio.to_thread(pv.get_office_text, real)
        omitted = await asyncio.to_thread(pv.get_office_omitted, real)
        return {"type": "office", "content": text, "name": real.name, "omitted": omitted}
    if not ptype:
        raise HTTPException(status_code=415, detail="Preview not supported")

    if ptype == "image":
        if real.suffix.lower() == ".svg":
            data = await asyncio.to_thread(real.read_bytes)
            # SVG는 JS 삽입 가능 → <img> 용으로만 제공(직접 열면 내려받기, sandbox CSP)
            media, headers = serve_safety.svg_image_headers(real.name)
            return Response(content=data, media_type=media, headers=headers)
        data = await asyncio.to_thread(pv.generate_thumbnail, real)
        if not data:
            raise HTTPException(status_code=500, detail="Thumbnail generation failed")
        return Response(content=data, media_type="image/jpeg")

    if ptype == "text":
        text = await asyncio.to_thread(pv.get_text_preview, real)
        return {"type": "text", "content": text, "name": real.name}

    if ptype == "pdf":
        return _file_response(real, request, media_type="application/pdf", inline=True)

    raise HTTPException(status_code=415)


# ─── Storage info ───


@router.get("/info", response_model=StorageInfo)
async def storage_info(user: User = Depends(get_current_user)):
    fs.ensure_user_dir(user)
    personal_path = Path(settings.storage_root) / "users" / user.id
    shared_path = Path(settings.storage_root) / "shared"
    personal, shared = await asyncio.gather(
        asyncio.to_thread(fs.get_dir_size, personal_path),
        asyncio.to_thread(fs.get_dir_size, shared_path),
    )
    # Disk capacity via shutil (instant, no tree walk)
    import shutil
    try:
        usage = shutil.disk_usage(settings.storage_root)
        total_capacity = usage.total
        disk_used = usage.used
    except OSError:
        total_capacity = 0
        disk_used = 0
    return StorageInfo(
        personal_used=personal,
        shared_used=shared,
        total_available=0,
        total_capacity=total_capacity,
        disk_used=disk_used,
    )


# ─── Share links ───


@router.post("/share", response_model=ShareLinkResponse)
async def create_share_link(
    body: ShareLinkCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """공유 링크 생성.

    - paths 에 둘 이상을 지정하면 묶음 링크(수신 측은 zip 하나로 내려받는다). 폴더도 가능하다.
    - password 를 지정하면 수신 측이 /shared/{token}/unlock 으로 해제해야 내려받을 수 있다.
    - allow_download=false 이면 내려받기를 차단하고 미리보기(이미지·PDF·텍스트)만 허용한다.
    """
    import json as _json

    multi = [p.strip("/") for p in (body.paths or []) if p and p.strip("/")]
    if not multi and not body.path:
        raise HTTPException(status_code=400, detail="path 또는 paths 가 필요합니다")
    # path 와 paths 를 함께 전송하면 병합하여 처리한다(중복 제거). 과거에는 path 를 무시하여, 파일 하나가 paths 로만 남으면
    # 단일 파일 판정(미리보기 가능·같이 편집)을 생략한 "항목 1개짜리 묶음"이 되었다.
    if multi and body.path and body.path.strip("/"):
        multi = [body.path.strip("/")] + multi
    multi = list(dict.fromkeys(multi))
    if len(multi) == 1 and _check_path(multi[0], user).is_file():
        body.path, multi = multi[0], []        # 파일 하나는 일반 링크, 폴더 하나는 묶음 링크(zip)
    if multi:
        # 묶음(zip)은 미리보기가 없다 — 내려받기까지 차단하면 수신자가 어떤 동작도 할 수 없는 무효 링크가 된다. 폴더 하나(둘러보기)는 허용.
        if body.allow_download is False and not (len(multi) == 1 and _check_path(multi[0], user).is_dir()):
            raise HTTPException(status_code=400, detail=BUNDLE_BLOCK_DETAIL)
        if body.can_edit:
            raise HTTPException(status_code=400, detail="여러 항목 링크는 같이 편집할 수 없습니다")
        if len(multi) > 200:
            raise HTTPException(status_code=400, detail="한 링크에 200개까지 묶을 수 있습니다")
        for vp in multi:
            if not _check_path(vp, user).exists():
                raise HTTPException(status_code=404, detail=f"찾을 수 없습니다: {vp}")
        root = multi[0].split("/", 1)[0]
        if any(vp.split("/", 1)[0] != root for vp in multi) or root not in ("my", "shared"):
            raise HTTPException(status_code=400, detail="모음 링크는 내 파일 또는 공유 파일 한쪽에서만 만들 수 있습니다")
        file_path = multi[0]
        display_name = (f"{_check_path(multi[0], user).name}.zip" if len(multi) == 1
                        else f"{_check_path(multi[0], user).name} 외 {len(multi) - 1}개.zip")
    else:
        real = _check_path(body.path, user)
        if not real.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        if body.can_edit:
            from app.wopi.router import _ALL_OFFICE_EXTS
            if real.suffix.lower() not in _ALL_OFFICE_EXTS:
                raise HTTPException(status_code=400, detail="같이 편집하는 링크는 Office 문서에만 만들 수 있습니다")
        # 내려받기를 차단하면 수신자는 미리보기만 가능하다 — 미리보기 불가 형식이면 아무것도 볼 수 없는 무효 링크가 된다.
        # (같이 편집 링크는 편집기로 열리므로 해당 없음. 폴더 링크는 내부의 다른 파일을 볼 수 있어 허용.)
        if body.allow_download is False and not body.can_edit and _preview_kind(real) is None:
            raise HTTPException(status_code=400, detail=NO_PREVIEW_BLOCK_DETAIL)
        file_path = body.path
        display_name = real.name

    token = secrets.token_urlsafe(32)

    expires_at = None
    if body.expires_in and body.expires_in in EXPIRES_MAP:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=EXPIRES_MAP[body.expires_in])

    max_downloads = 1 if body.one_time else None

    from app.auth.password import hash_password
    link = ShareLink(
        token=token,
        file_path=file_path,
        display_name=display_name[:255],
        created_by=user.id,
        expires_at=expires_at,
        max_downloads=max_downloads,
        can_edit=bool(body.can_edit),
        password_hash=hash_password(body.password) if body.password else None,
        allow_download=body.allow_download,
        paths=_json.dumps(multi, ensure_ascii=False) if multi else None,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)
    for vp in (multi or [file_path]):
        await act.record(act.canonical_key(vp, user), user.id, "share_link",
                         {"link_id": link.id, "can_edit": bool(body.can_edit)})

    # 같이 편집 링크는 내려받기 주소가 아니라 편집기로 연결한다.
    folder_link = bool(multi) and len(multi) == 1 and _check_path(multi[0], user).is_dir()
    url = (f"{settings.app_url}/s/{token}" if body.can_edit or folder_link
           else f"{settings.app_url}/api/files/shared/{token}")
    return ShareLinkResponse(
        token=token,
        url=url,
        display_name=link.display_name,
        expires_at=link.expires_at,
        max_downloads=link.max_downloads,
        created_at=link.created_at,
        id=link.id,
        has_password=bool(link.password_hash),
        allow_download=link.allow_download is not False,
        item_count=len(multi) if multi else 1,
        is_folder=folder_link,
    )


@router.get("/share/list", response_model=list[ShareLinkListItem])
async def list_share_links(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ShareLink).where(ShareLink.created_by == user.id).order_by(ShareLink.created_at.desc())
    result = await db.execute(stmt)
    links = result.scalars().all()
    from app.db.models import ShareLinkEmail
    sent: dict[str, int] = {}
    if links:
        sent = {lid: int(n) for lid, n in (await db.execute(
            select(ShareLinkEmail.link_id, func.count()).where(
                ShareLinkEmail.link_id.in_([l.id for l in links]), ShareLinkEmail.ok == True,  # noqa: E712
            ).group_by(ShareLinkEmail.link_id)
        )).all()}
    return [
        ShareLinkListItem(
            id=l.id,
            token=l.token,
            display_name=l.display_name,
            file_path=l.file_path,
            expires_at=l.expires_at,
            max_downloads=l.max_downloads,
            download_count=l.download_count,
            created_at=l.created_at,
            can_edit=bool(l.can_edit),
            has_password=bool(l.password_hash),
            allow_download=l.allow_download is not False,
            paths=_link_paths(l),
            email_count=sent.get(l.id, 0),
            is_folder=is_folder_link(l),
            can_block_download=link_can_block_download(l),
        )
        for l in links
    ]


def _link_paths(link: ShareLink) -> list[str]:
    import json as _json
    if not link.paths:
        return [link.file_path]
    try:
        v = _json.loads(link.paths)
        return [str(x) for x in v] if isinstance(v, list) else [link.file_path]
    except ValueError:
        return [link.file_path]


@router.patch("/share/{link_id}", response_model=ShareLinkListItem)
async def update_share_link(
    link_id: str,
    body: ShareLinkUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """공유 링크 설정 변경 — 비밀번호(""=해제), 내려받기 허용, 만료, 횟수 제한."""
    link = await db.get(ShareLink, link_id)
    if not link or (link.created_by != user.id and not user.is_admin):
        raise HTTPException(status_code=404, detail="Not found")
    from app.auth.password import hash_password
    if body.password is not None:
        link.password_hash = hash_password(body.password) if body.password else None
    if body.allow_download is not None:
        # 허용 → 차단으로 변경할 때만 검사한다(이미 차단 상태였던 기존 링크는 다른 설정을 수정할 수 있도록 유지)
        refusal = link_block_refusal(link)
        if body.allow_download is False and link.allow_download is not False and refusal:
            raise HTTPException(status_code=400, detail=refusal)
        link.allow_download = body.allow_download
    if body.expires_in is not None:
        if body.expires_in in ("", "never"):
            link.expires_at = None
        elif body.expires_in in EXPIRES_MAP:
            link.expires_at = datetime.now(timezone.utc) + timedelta(hours=EXPIRES_MAP[body.expires_in])
        else:
            raise HTTPException(status_code=400, detail="expires_in 은 1h|1d|7d|never")
    if body.expires_at is not None:
        try:
            at = datetime.fromisoformat(body.expires_at.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="expires_at 은 ISO 8601")
        link.expires_at = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
    if body.max_downloads is not None:
        link.max_downloads = body.max_downloads or None
    await db.commit()
    await db.refresh(link)
    return ShareLinkListItem(
        id=link.id, token=link.token, display_name=link.display_name, file_path=link.file_path,
        expires_at=link.expires_at, max_downloads=link.max_downloads,
        download_count=link.download_count, created_at=link.created_at,
        can_edit=bool(link.can_edit), has_password=bool(link.password_hash),
        allow_download=link.allow_download is not False, paths=_link_paths(link),
        is_folder=is_folder_link(link), can_block_download=link_can_block_download(link),
    )


@router.get("/share/preview-kind")
async def share_preview_kind(path: str = Query(...), user: User = Depends(get_current_user)):
    """이 파일의 손님 화면 미리보기 가능 여부 — 링크 생성 창이 "내려받기 막음"을 활성화할 수 있는지 사전 조회한다.

    판정은 손님 화면과 동일한 함수(_preview_kind)를 사용한다. {"preview": "image"|"pdf"|"text"|null}. 폴더는 null.
    """
    real = _check_path(path, user)
    if not real.is_file():
        return {"preview": None, "is_file": False}
    return {"preview": _preview_kind(real), "is_file": True}


@router.delete("/share/{link_id}")
async def delete_share_link(
    link_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    link = await db.get(ShareLink, link_id)
    if not link or (link.created_by != user.id and not user.is_admin):
        raise HTTPException(status_code=404, detail="Not found")
    # 이메일 발송 기록도 삭제(FK CASCADE 가 없는 기존 DB·SQLite 대비 명시 삭제)
    from sqlalchemy import delete as _sa_delete
    from app.db.models import ShareLinkEmail
    await db.execute(_sa_delete(ShareLinkEmail).where(ShareLinkEmail.link_id == link.id))
    await db.delete(link)
    await db.commit()
    return {"ok": True}


# ─── 공유 링크 이메일 발송 — 규칙은 app/files/share_email.py ───


class ShareLinkEmailRequest(BaseModel):
    emails: list[str]
    message: str | None = None
    # 메일 언어(발신자 화면 언어) ko|en, 만료 시각 표기에 사용할 시간대(IANA, 예: Asia/Seoul)
    locale: str | None = None
    tz: str | None = None


async def _mailable_link(db: AsyncSession, link_id: str, user: User) -> ShareLink:
    """링크 소유자(생성자) 또는 링크 대상(내 파일 my/..)에 편집 이상 권한이 있는 사용자만 허용. 그 외는 404."""
    link = await db.get(ShareLink, link_id)
    if not link:
        raise HTTPException(status_code=404, detail="Not found")
    if link.created_by == user.id:
        return link
    paths = _link_paths(link)
    if paths and all(p.startswith("my/") for p in paths):
        for p in paths:
            role, _ = await acc.role_on(db, user, link.created_by, p)
            if not acc.at_least(role, "edit"):
                break
        else:
            return link
    raise HTTPException(status_code=404, detail="Not found")


async def _email_log(db: AsyncSession, link_id: str) -> list[dict]:
    from app.db.models import ShareLinkEmail
    from app.files import share_email as se
    rows = (await db.execute(
        select(ShareLinkEmail).where(ShareLinkEmail.link_id == link_id).order_by(ShareLinkEmail.created_at.desc())
    )).scalars().all()
    sender_ids = list({r.sent_by for r in rows})
    names: dict[str, str] = {}
    if sender_ids:
        for uid, dn, un in (await db.execute(
            select(User.id, User.display_name, User.username).where(User.id.in_(sender_ids))
        )).all():
            names[uid] = dn or un
    return [se.log_entry(r, names) for r in rows]


def _email_limits(se, used: int) -> dict:
    return {"per_send": se.MAX_RECIPIENTS, "per_hour": se.HOURLY_LIMIT, "remaining": max(0, se.HOURLY_LIMIT - used)}


@router.get("/share/{link_id}/emails")
async def list_share_link_emails(
    link_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이 링크의 메일 발송 이력(수신자·시각, 최신순) + 현재 1시간 구간의 잔여 발송 수."""
    from app.files import share_email as se
    await _mailable_link(db, link_id, user)
    used = await se.sent_last_hour(db, user.id)
    return {"items": await _email_log(db, link_id), "limits": _email_limits(se, used)}


@router.post("/share/{link_id}/email")
async def email_share_link(
    link_id: str,
    body: ShareLinkEmailRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """공유 링크 이메일 발송 — 시스템 메일(SMTP) 경로로 수신자마다 한 통씩 송신한다.

    - emails: 1~20개(형식 검사·중복 제거). 형식이 잘못된 주소가 하나라도 있으면 400(전체 미발송).
    - 발신자당 1시간 50명(실패한 시도도 집계) — 초과 시 429.
    - 만료되었거나 횟수를 소진한 링크는 400. 비밀번호는 메일에 포함하지 않는다(본문에 "따로 전달" 안내).
    - 결과: 수신자별 ok·external(워크스페이스 외부 주소) + 갱신된 발송 기록.
    """
    from app.admin.settings import get_smtp_config
    from app.db.models import ShareLinkEmail
    from app.files import share_email as se

    link = await _mailable_link(db, link_id, user)
    emails, bad = se.normalize_recipients(body.emails or [])
    if bad:
        raise HTTPException(status_code=400, detail=f"이메일 형식이 아닙니다: {bad[0]}")
    if not emails:
        raise HTTPException(status_code=400, detail="받는 사람 이메일을 입력하십시오")
    if len(emails) > se.MAX_RECIPIENTS:
        raise HTTPException(status_code=400, detail=f"한 번에 {se.MAX_RECIPIENTS}명까지 보낼 수 있습니다")
    message = (body.message or "").strip()
    if len(message) > se.MESSAGE_MAX:
        raise HTTPException(status_code=400, detail=f"메시지는 {se.MESSAGE_MAX}자까지입니다")
    now = datetime.now(timezone.utc)
    exp = link.expires_at
    if exp is not None and (exp if exp.tzinfo else exp.replace(tzinfo=timezone.utc)) < now:
        raise HTTPException(status_code=400, detail="만료된 링크는 보낼 수 없습니다")
    if link.max_downloads and (link.download_count or 0) >= link.max_downloads:
        raise HTTPException(status_code=400, detail="이미 모두 사용한 링크는 보낼 수 없습니다")
    used = await se.sent_last_hour(db, user.id, now)
    if used + len(emails) > se.HOURLY_LIMIT:
        left = max(0, se.HOURLY_LIMIT - used)
        raise HTTPException(status_code=429, detail=f"1시간에 {se.HOURLY_LIMIT}명까지 보낼 수 있습니다(지금 {left}명 남음)")

    lang = "en" if (body.locale or "").lower().startswith("en") else "ko"
    parts = se.render(link, user, message=message or None, lang=lang, tz=body.tz)
    kinds = await se.classify(db, emails)
    cfg = await get_smtp_config(db)
    results = []
    for to in emails:
        uid, external = kinds[to]
        ok, err = True, None
        try:
            await se._deliver(cfg, se.build_message(parts, from_addr=cfg.from_addr, to=to, sender=user))
        except Exception as e:  # 수신자 한 명의 실패가 나머지 발송을 차단하지 않는다
            ok, err = False, str(e)[:255]
            logger.warning("share link email to %s failed: %s", to, e)
        db.add(ShareLinkEmail(link_id=link.id, sent_by=user.id, recipient=to, recipient_user_id=uid,
                              external=external, ok=ok, error=err))
        results.append({"email": to, "ok": ok, "external": external, "user_id": uid})
    await db.commit()
    sent = sum(1 for r in results if r["ok"])
    try:
        # 활동 기록 키는 링크 소유자 기준(편집 권한자가 발송한 경우 my/.. 는 소유자 영역)
        owner = user if link.created_by == user.id else await db.get(User, link.created_by)
        await act.record(act.canonical_key(link.file_path, owner) if owner else None, user.id, "share_link_email",
                         {"link_id": link.id, "count": len(emails), "sent": sent})
    except Exception:
        pass
    used = await se.sent_last_hour(db, user.id)
    return {
        "ok": sent == len(results),
        "sent": sent,
        "failed": len(results) - sent,
        "results": results,
        "items": await _email_log(db, link.id),
        "limits": _email_limits(se, used),
    }


# ─── 버전 관리 (my/ 파일) ───


@router.get("/versions")
async def list_versions(
    path: str = Query(..., description="my/ 아래 파일 가상경로"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """버전 목록. 각 버전에 author(해당 내용의 작성자 — 활동 기록 기준, 기록 이전 버전은 null)와
    download_url, 응답에 current_author(현재본 작성자)를 포함한다."""
    from urllib.parse import quote
    rel = fs.owner_relpath_from_my(path)
    if rel is None:
        raise HTTPException(status_code=400, detail="내 파일(my/)만 버전 관리됩니다")
    _check_path(path, user)  # 경로 보안 검증
    versions = fs.list_versions(user.id, rel)
    current_author = None
    try:
        authors, current_author = await act.version_authors(
            db, act.canonical_key(path, user), [int(v["version"]) for v in versions]
        )
    except Exception:
        authors = {}
    for v in versions:
        v["author"] = authors.get(int(v["version"]))
        v["download_url"] = f"/api/files/versions/download?path={quote(path)}&version={v['version']}"
    return {"versions": versions, "count": len(versions), "current_author": current_author}


class RestoreVersionRequest(BaseModel):
    path: str
    version: str


@router.post("/versions/restore")
async def restore_version(
    body: RestoreVersionRequest,
    user: User = Depends(get_current_user),
):
    rel = fs.owner_relpath_from_my(body.path)
    if rel is None:
        raise HTTPException(status_code=400, detail="내 파일(my/)만 버전 관리됩니다")
    real = _check_path(body.path, user)
    ok = fs.restore_version(real, user.id, rel, body.version)
    if not ok:
        raise HTTPException(status_code=404, detail="해당 버전을 찾을 수 없습니다")
    fs.invalidate_cache(real.parent)
    await act.record(act.canonical_key(body.path, user), user.id, "version_restore", {"version": body.version})
    return {"ok": True}


# ─── 사용자 간 공유(ACL) ───
#
# 권한 4단계("보기 · 댓글 · 편집 · 공동 소유") — 규칙은 app/files/access.py.
# 공동 소유자는 공유 경로(shared-with-me/<id>/..)로 재공유·권한 변경·해제를 수행할 수 있다. 단,
#   - 원 소유자가 생성한 공유는 변경·해제 불가(원 소유자 보호)
#   - 공동 소유 지정·해제는 원 소유자만 가능


_ROLE_LABEL = {"view": "보기 가능", "comment": "댓글 가능", "edit": "편집 가능", "owner": "공동 소유"}


class ShareUserCreate(BaseModel):
    # 내 파일(my/..) 또는 공동 소유로 받은 경로(shared-with-me/<share_id>/..)
    path: str
    user_ids: list[str] = []
    # 채널 공유 — 해당 채널 멤버 전원(본인이 멤버인 채널만)
    channel_ids: list[str] = []
    # 구버전 클라이언트 호환: role 이 없을 때만 참조한다(true=편집, false=보기)
    can_write: bool = False
    # view | comment | edit | owner(공동 소유 — 원 소유자만 지정)
    role: str | None = None
    # "채팅으로 알리고 메시지 남기기" — 사용자는 DM, 채널은 해당 채널에 메시지 한 줄(+ 추가 메시지)
    notify: bool = False
    message: str | None = None


class ShareUserUpdate(BaseModel):
    role: str


# 기존 이름 유지(테스트·다른 함수가 호출) — 실제 규칙은 access 모듈
_my_channel_ids = acc.my_channel_ids
_accessible_share = acc.accessible_share
_owner_real = acc.owner_real


async def _manage_target(db: AsyncSession, user: User, path: str) -> "acc.Access":
    """공유 관리 대상 — 내 파일(my/..) 또는 공동 소유로 받은 경로. owner_vpath 가 공유 식별 경로이다."""
    vp = (path or "").strip("/")
    if not acc.parse_shared(vp) and fs.owner_relpath_from_my(vp) is None:
        raise HTTPException(status_code=400, detail="내 파일(my/)만 공유할 수 있습니다")
    a = await acc.resolve(db, user, vp, "owner")
    if not a.owner_id or not a.owner_vpath or fs.owner_relpath_from_my(a.owner_vpath) is None:
        raise HTTPException(status_code=400, detail="공유할 수 없는 경로입니다")
    return a


def _can_manage_row(row: FileShare, user: User) -> bool:
    """이 공유 행의 변경·해제 가능 여부(경로에 대한 공동 소유 권한은 호출자가 이미 확인).

    원 소유자는 항상 가능. 공동 소유자는 공동 소유자가 생성한 행만 가능 — 원 소유자가 생성한 행(created_by 가 비었거나 원 소유자)과
    공동 소유 행은 변경 불가.
    """
    if row.owner_id == user.id:
        return True
    if acc.share_role(row) == "owner":
        return False
    return bool(row.created_by) and row.created_by != row.owner_id


async def _row_for_manager(db: AsyncSession, share_id: str, user: User) -> FileShare:
    """관리(권한 변경·해제) 대상 공유 행. 볼 수 없는 사용자에게는 존재를 노출하지 않으며(404), 보호된 행은 403."""
    row = await db.get(FileShare, share_id)
    if not row:
        raise HTTPException(status_code=404, detail="공유를 찾을 수 없습니다")
    if row.owner_id == user.id or user.is_admin:
        return row
    role, _ = await acc.role_on(db, user, row.owner_id, row.file_path)
    if role != "owner":
        raise HTTPException(status_code=404, detail="공유를 찾을 수 없습니다")
    if not _can_manage_row(row, user):
        raise HTTPException(status_code=403, detail="원 소유자가 준 공유·공동 소유는 원 소유자만 변경할 수 있습니다")
    return row


async def _notify_share_in_chat(
    db: AsyncSession, user: User, name: str, role: str,
    user_ids: list[str], channel_ids: list[str], message: str | None,
) -> int:
    """공유 알림의 채팅 송신 — 사용자는 1:1 DM, 채널은 해당 채널. 실패한 대상은 생략한다. 송신 대상 수 반환."""
    from app.modules.registry import is_module_enabled
    if not is_module_enabled("chat"):
        return 0   # 채팅이 비활성화 상태이면 아무도 볼 수 없는 DM 을 생성하지 않는다 — 공유 알림(벨)은 별도로 송신된다
    from app.chat import service as chat_service
    from app.chat.router import _broadcast_message
    perm = _ROLE_LABEL.get(role, _ROLE_LABEL["view"])
    link = f"{settings.app_url.rstrip('/')}/files?view=shared-with-me"
    text = f"\"{name}\" 을(를) 공유했습니다({perm}) — {link}"
    note = (message or "").strip()[:2000]
    if note:
        text = f"{text}\n{note}"
    sent = 0
    targets: list[str] = []
    for uid in user_ids:
        try:
            ch = await chat_service.get_or_create_dm(db, user.id, uid)
            targets.append(ch.id)
        except Exception:
            continue
    targets += channel_ids
    for cid in targets:
        try:
            msg = await chat_service.create_message(db, cid, user.id, content=text)
            await _broadcast_message(db, cid, user.id, text, msg)
            sent += 1
        except Exception:
            continue
    return sent


@router.post("/share-user")
async def share_with_users(
    body: ShareUserCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """파일/폴더를 사용자·채널에 공유(ACL). 이미 존재하면 권한 갱신.

    - path: 내 파일(my/..) 또는 공동 소유로 받은 경로(shared-with-me/..) — 공동 소유자의 재공유는 원 소유자 영역에 행을 생성한다.
    - role: view|comment|edit|owner(없으면 can_write). owner(공동 소유)는 원 소유자만 지정한다.
    - 공동 소유자는 원 소유자가 생성한 공유를 변경할 수 없다(403).
    - channel_ids: 본인이 멤버인 채널만(아니면 403). notify=true 이면 채팅으로 통지한다(사용자 DM · 채널 메시지 + message).
    """
    a = await _manage_target(db, user, body.path)
    role = acc.normalize_role(body.role, body.can_write)
    is_owner = a.owner_id == user.id
    if role == "owner" and not is_owner:
        raise HTTPException(status_code=403, detail="공동 소유 지정은 원 소유자만 할 수 있습니다")
    if not body.user_ids and not body.channel_ids:
        raise HTTPException(status_code=400, detail="공유할 사람이나 채널을 선택하십시오")
    real = a.real
    if not real.exists():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    from app.modules.registry import is_module_enabled
    if body.channel_ids and not is_module_enabled("chat"):
        raise HTTPException(status_code=404, detail="채팅을 사용하지 않는 설치입니다 — 채널에는 공유할 수 없습니다")
    from app.chat import service as chat_service
    channel_ids = list(dict.fromkeys(body.channel_ids))
    for cid in channel_ids:
        if not await chat_service.is_channel_member(db, cid, user.id):
            raise HTTPException(status_code=403, detail="멤버인 채널에만 공유할 수 있습니다")
    owner_id, owner_vp = a.owner_id, a.owner_vpath
    rows = (await db.execute(
        select(FileShare).where(FileShare.owner_id == owner_id, FileShare.file_path == owner_vp)
    )).scalars().all()
    by_user = {s.shared_with_user_id: s for s in rows if s.shared_with_user_id}
    by_channel = {s.shared_with_channel_id: s for s in rows if s.shared_with_channel_id}
    # 본인·원 소유자에게는 공유하지 않는다
    user_ids = [u for u in dict.fromkeys(body.user_ids) if u not in (user.id, owner_id)]
    existing = [by_user[u] for u in user_ids if u in by_user] + [by_channel[c] for c in channel_ids if c in by_channel]
    if any(not _can_manage_row(r, user) for r in existing):
        raise HTTPException(status_code=403, detail="원 소유자가 준 공유·공동 소유는 원 소유자만 변경할 수 있습니다")
    created = 0
    new_users: list[str] = []
    new_channels: list[str] = []
    for uid in user_ids:
        row = by_user.get(uid)
        if row:
            acc.apply_role(row, role)
        else:
            row = FileShare(owner_id=owner_id, file_path=owner_vp, shared_with_user_id=uid, created_by=user.id)
            acc.apply_role(row, role)
            db.add(row)
            created += 1
            new_users.append(uid)
    for cid in channel_ids:
        row = by_channel.get(cid)
        if row:
            acc.apply_role(row, role)
            # 공유 창에서 직접 재설정함 = 사용자가 의도한 공유 → 채널 폴더 연결을 해제해도 유지한다
            row.origin = None
        else:
            row = FileShare(owner_id=owner_id, file_path=owner_vp, shared_with_channel_id=cid, created_by=user.id)
            acc.apply_role(row, role)
            db.add(row)
            created += 1
            new_channels.append(cid)
    await db.commit()
    await act.record(a.key, user.id, "share_user",
                     {"user_ids": user_ids, "channel_ids": channel_ids, "role": role,
                      "can_write": role in ("edit", "owner"), **_share_detail(a)})
    notified = 0
    if body.notify:
        notified = await _notify_share_in_chat(
            db, user, real.name, role, user_ids, channel_ids, body.message,
        )
    return {"ok": True, "created": created, "notified": notified}


@router.get("/share-user/list")
async def list_user_shares(
    path: str = Query(..., description="공유 조회할 경로(my/.. 또는 공동 소유로 받은 shared-with-me/..)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """특정 경로의 공유 목록(수신자 + 권한). 원 소유자·공동 소유자만 조회 가능.

    행: role · can_write(호환) · created_by · can_manage(요청 사용자의 변경·해제 가능 여부). 채널 행은 채널 이름·멤버 수.
    owner: 원 소유자(공동 소유자 화면의 "소유자" 줄), my_role: 요청 사용자의 권한.
    """
    from app.db.models import Channel, ChannelMember
    a = await _manage_target(db, user, path)
    rows = (await db.execute(
        select(FileShare).where(FileShare.owner_id == a.owner_id, FileShare.file_path == a.owner_vpath)
        .order_by(FileShare.created_at.asc())
    )).scalars().all()
    out = []
    for r in rows:
        role = acc.share_role(r)
        d = {"id": r.id, "user_id": r.shared_with_user_id, "channel_id": r.shared_with_channel_id,
             "role": role, "can_write": role in ("edit", "owner"), "created_by": r.created_by,
             "origin": r.origin, "can_manage": _can_manage_row(r, user)}
        if r.shared_with_channel_id:
            ch = await db.get(Channel, r.shared_with_channel_id)
            d["channel_name"] = ch.name if ch else None
            d["member_count"] = (await db.execute(
                select(func.count()).select_from(ChannelMember).where(ChannelMember.channel_id == r.shared_with_channel_id)
            )).scalar_one() if ch else 0
        out.append(d)
    owner = await db.get(User, a.owner_id)
    return {
        "shares": out,
        "owner": ({"id": owner.id, "username": owner.username, "display_name": owner.display_name or owner.username,
                   "email": owner.email, "avatar_url": getattr(owner, "avatar_url", None)} if owner else None),
        "my_role": a.role,
    }


@router.get("/share-user/counts")
async def user_share_counts(
    path: str = Query("my/", description="디렉터리 경로 — 하위 항목별 공유 수 집계"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """디렉터리 내 각 항목의 사용자공유 수 + 공개링크 유무 (목록 오버레이용)."""
    prefix = path.strip("/").rstrip("/")
    shares = (await db.execute(
        select(FileShare.file_path).where(
            FileShare.owner_id == user.id, FileShare.file_path.like(f"{prefix}/%")
        )
    )).scalars().all()
    links = (await db.execute(
        select(ShareLink.file_path).where(
            ShareLink.created_by == user.id, ShareLink.file_path.like(f"{prefix}/%")
        )
    )).scalars().all()
    users_count: dict[str, int] = {}
    for fp in shares:
        child = fp[len(prefix) + 1:].split("/")[0]
        users_count[child] = users_count.get(child, 0) + 1
    link_set = {fp[len(prefix) + 1:].split("/")[0] for fp in links}
    names = set(users_count) | link_set
    return {"items": {n: {"users": users_count.get(n, 0), "link": n in link_set} for n in names}}


@router.patch("/share-user/{share_id}")
async def update_user_share(
    share_id: str,
    body: ShareUserUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """공유 행 하나의 권한 변경. 원 소유자·관리자, 또는 해당 경로의 공동 소유자(원 소유자가 생성한 행·공동 소유 행 제외).
    공동 소유(owner)로의 승격·강등은 원 소유자만 가능."""
    row = await _row_for_manager(db, share_id, user)
    role = acc.normalize_role(body.role)
    if (role == "owner" or acc.share_role(row) == "owner") and row.owner_id != user.id:
        raise HTTPException(status_code=403, detail="공동 소유 지정·해제는 원 소유자만 할 수 있습니다")
    acc.apply_role(row, role)
    await db.commit()
    await act.record(act.owner_key(row.owner_id, row.file_path), user.id, "share_user",
                     {"share_id": row.id, "role": role, "can_write": role in ("edit", "owner")})
    return {"ok": True, "id": row.id, "role": role, "can_write": row.can_write}


@router.delete("/share-user/{share_id}")
async def delete_user_share(
    share_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """공유 해제. 원 소유자·관리자, 또는 해당 경로의 공동 소유자(원 소유자가 생성한 공유·공동 소유는 해제 불가)."""
    row = await _row_for_manager(db, share_id, user)
    key = act.owner_key(row.owner_id, row.file_path)
    await db.delete(row)
    await db.commit()
    await act.record(key, user.id, "unshare_user", {"share_id": share_id})
    return {"ok": True}


@router.get("/shared-with-me")
async def shared_with_me(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """본인에게 공유된 파일/폴더 목록(직접 + 본인이 멤버인 채널에 공유된 것). 원본이 없는 항목은 생략.

    동일 항목이 사용자·채널로 중복되면 한 번만 포함 — 직접 공유를 우선하고, 권한이 높은 쪽을 선택한다.
    role: 해당 항목에 대한 요청 사용자의 권한(view|comment|edit|owner), can_write 는 호환용(edit 이상).
    """
    my_channels = await _my_channel_ids(db, user.id)
    cond = FileShare.shared_with_user_id == user.id
    if my_channels:
        cond = or_(cond, and_(FileShare.shared_with_channel_id.in_(my_channels), FileShare.owner_id != user.id))
    rows = (await db.execute(
        select(FileShare, User.username, User.display_name)
        .outerjoin(User, FileShare.owner_id == User.id)
        .where(cond)
        .order_by(FileShare.created_at.desc())
    )).all()
    # (소유자, 경로) 하나에 행 하나: 직접 공유 > 높은 권한 > 최신
    picked: dict[tuple[str, str], tuple] = {}

    def _rank(s: FileShare) -> tuple:
        return (bool(s.shared_with_user_id), acc.RANK[acc.share_role(s)])

    for row in rows:
        s = row[0]
        k = (s.owner_id, s.file_path)
        cur = picked.get(k)
        if cur is None or _rank(s) > _rank(cur[0]):
            picked[k] = row
    # 동일 항목이 사용자·채널로 중복되면 권한은 둘 중 높은 것(접근 규칙과 동일)
    best_role: dict[tuple[str, str], str] = {}
    for row in rows:
        s = row[0]
        k = (s.owner_id, s.file_path)
        r = acc.share_role(s)
        if k not in best_role or acc.RANK[r] > acc.RANK[best_role[k]]:
            best_role[k] = r
    rows = [r for r in rows if picked.get((r[0].owner_id, r[0].file_path)) is r]
    channel_names: dict[str, str] = {}
    if any(r[0].shared_with_channel_id for r in rows):
        from app.db.models import Channel
        ids = {r[0].shared_with_channel_id for r in rows if r[0].shared_with_channel_id}
        channel_names = {c.id: c.name for c in (await db.execute(select(Channel).where(Channel.id.in_(ids)))).scalars().all()}
    out = []
    for s, username, display in rows:
        try:
            real = _owner_real(s.owner_id, s.file_path)
        except HTTPException:
            continue
        if not real.exists():
            continue
        st = real.stat()
        role = best_role.get((s.owner_id, s.file_path), acc.share_role(s))
        out.append({
            "share_id": s.id,
            "name": real.name,
            "owner_path": s.file_path,
            "owner": {"id": s.owner_id, "display_name": display or username or "?"},
            "role": role,
            "can_write": role in ("edit", "owner"),
            # 채널로 받은 공유이면 해당 채널(공유받음 목록 "#개발 에서")
            "via_channel": ({"id": s.shared_with_channel_id, "name": channel_names.get(s.shared_with_channel_id, "")}
                            if s.shared_with_channel_id else None),
            "is_dir": real.is_dir(),
            "size": st.st_size if real.is_file() else 0,
            "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            "etag": fs.compute_etag(st) if real.is_file() else None,
            # 수신일(공유 생성 시점) — 공유받음 목록 "받은 날" 열
            "shared_at": (s.created_at if s.created_at.tzinfo else s.created_at.replace(tzinfo=timezone.utc)).isoformat()
            if s.created_at else None,
        })
    return {"items": out}


@router.get("/shared-with-me/{share_id}/download")
async def download_shared_with_me(
    share_id: str,
    request: Request,
    path: str | None = Query(None, description="공유 폴더 안 파일의 하위 경로(공유된 게 폴더일 때)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """본인에게 공유된 파일 다운로드(권한 확인). 공유 대상이 폴더이면 path 로 그 내부의 파일을 내려받는다."""
    s = await _accessible_share(db, share_id, user)
    if not s:
        raise HTTPException(status_code=404, detail="공유를 찾을 수 없습니다")
    real = _shared_sub_real(s, path) if path else _owner_real(s.owner_id, s.file_path)
    if not real.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    return _file_response(real, request, filename=real.name)


# ─── Public shared download (no auth) ───


def _unlock_sig(token: str, exp: int) -> str:
    import hashlib
    import hmac
    return hmac.new(settings.secret_key.encode(), f"share-unlock:{token}:{exp}".encode(),
                    hashlib.sha256).hexdigest()[:32]


def make_unlock_access(token: str, ttl: int = 3600) -> str:
    """비밀번호 해제 후 사용하는 단기 접근 키(쿼리 ?access=). 브라우저 내려받기 링크에 부가한다."""
    import time as _t
    exp = int(_t.time()) + ttl
    return f"{exp}.{_unlock_sig(token, exp)}"


def _unlock_ok(token: str, access: str | None) -> bool:
    import hmac
    import time as _t
    if not access or "." not in access:
        return False
    exp_s, sig = access.split(".", 1)
    if not exp_s.isdigit() or int(exp_s) < _t.time():
        return False
    return hmac.compare_digest(sig, _unlock_sig(token, int(exp_s)))


def _password_ok(link: ShareLink, request: Request | None, access: str | None) -> bool:
    if not link.password_hash:
        return True
    if _unlock_ok(link.token, access):
        return True
    if request is not None:
        pw = request.headers.get("x-share-password")
        if pw:
            from app.auth.password import verify_password
            return verify_password(pw, link.password_hash)
    return False


# 링크 비밀번호 시도 제한(19) — 과거에는 잠금 집계가 없어 nginx 한도(초당 30회)까지 그대로 대입 시도가 가능했다.
# 링크+IP 별로 10분에 10회 실패 시 429. 워커가 여러 개이므로 Redis 에 집계한다. Redis 가 없으면 차단하지 않는다
# (제한 장치의 장애로 정상 손님의 접근까지 차단하지 않는다).
UNLOCK_MAX_FAILS = 10
UNLOCK_WINDOW_S = 600


def _unlock_key(token: str, request: Request | None) -> str:
    import hashlib
    ip = ""
    if request is not None:
        try:
            from app.auth.sessions import client_ip
            ip = client_ip(request) or ""
        except Exception:
            ip = ""
    return "share:unlock-fail:" + hashlib.sha256(f"{token}|{ip}".encode()).hexdigest()[:40]


async def _unlock_redis():
    try:
        from app.chat.redis_client import get_redis
        return await get_redis()
    except Exception:
        return None


async def unlock_guard(token: str, request: Request | None) -> None:
    """이미 실패 횟수가 한도를 초과했으면 429(비밀번호 대조 전에 호출한다)."""
    r = await _unlock_redis()
    if r is None:
        return
    try:
        n = int(await r.get(_unlock_key(token, request)) or 0)
    except Exception:
        return
    if n >= UNLOCK_MAX_FAILS:
        raise HTTPException(status_code=429, detail="비밀번호를 여러 번 틀렸습니다. 10분 후에 다시 시도하십시오")


async def unlock_failed(token: str, request: Request | None) -> None:
    r = await _unlock_redis()
    if r is None:
        return
    try:
        key = _unlock_key(token, request)
        n = await r.incr(key)
        if int(n) == 1:
            await r.expire(key, UNLOCK_WINDOW_S)
    except Exception:
        pass


async def unlock_succeeded(token: str, request: Request | None) -> None:
    r = await _unlock_redis()
    if r is None:
        return
    try:
        await r.delete(_unlock_key(token, request))
    except Exception:
        pass


async def check_link_password(link: ShareLink, password: str | None, request: Request | None) -> bool:
    """비밀번호 대조 + 시도 제한. 일치하면 True, 불일치하면 False(횟수 +1), 이미 한도를 초과했으면 429."""
    from app.auth.password import verify_password
    await unlock_guard(link.token, request)
    if password and verify_password(password, link.password_hash):
        await unlock_succeeded(link.token, request)
        return True
    await unlock_failed(link.token, request)
    return False


async def _password_gate(link: ShareLink, request: Request | None, access: str | None) -> bool:
    """_password_ok 와 동일한 판정이되 X-Share-Password 로 전송된 비밀번호에는 시도 제한을 적용한다."""
    if not link.password_hash:
        return True
    if _unlock_ok(link.token, access):
        return True
    pw = request.headers.get("x-share-password") if request is not None else None
    if pw:
        return await check_link_password(link, pw, request)
    return False


async def load_public_link(db: AsyncSession, token: str) -> ShareLink:
    """토큰 → 유효한 링크(만료이면 404). 횟수·비밀번호는 호출부가 확인한다."""
    link = (await db.execute(select(ShareLink).where(ShareLink.token == token))).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found or expired")
    exp = link.expires_at
    if exp is not None and exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if exp and datetime.now(timezone.utc) > exp:
        raise HTTPException(status_code=404, detail="Link expired")
    return link


def resolve_link_path(link: ShareLink, vp: str | None = None) -> Path:
    """링크 생성자 기준 가상경로 → 실제 경로(트래버설 차단)."""
    storage_root = Path(settings.storage_root).resolve()
    vp = (vp or link.file_path).strip("/")
    parts = vp.split("/", 1)
    root_segment = parts[0]
    rest = parts[1] if len(parts) > 1 else ""

    if root_segment == "my":
        # ShareLink stores the creator's virtual path; resolve via their user id
        base = storage_root / "users" / link.created_by
    elif root_segment == "shared":
        base = storage_root / "shared"
    elif root_segment == acc.TRASH_PREFIX:
        # 원본이 휴지통에 있음(복원 시 링크 재사용 가능)
        raise HTTPException(status_code=404, detail="File no longer exists")
    else:
        raise HTTPException(status_code=403, detail="Access denied")

    real = (base / rest).resolve() if rest else base.resolve()
    if not real.is_relative_to(base.resolve()):
        raise HTTPException(status_code=403, detail="Access denied")
    return real


# ─── 폴더 링크 탐색(OneDrive식 보기 전용) ───
# 폴더 하나로 생성한 링크(paths 에 폴더 1개)는 손님이 해당 폴더 내부를 탐색하며 파일별로 미리보기·내려받기를 할 수 있다.
# 범위는 링크 폴더 하위로 한정 — 숨김(fs.is_hidden_name: . 시작·NAS 시스템 이름)·`..`·심볼릭 링크로 외부를 가리키는 항목은 목록에서 제외하고 요청도 404.

_LINK_LIST_MAX = 2000


def link_folder_root(link: ShareLink) -> Path | None:
    """폴더 하나짜리 링크이면 해당 폴더의 실제 경로, 아니면 None."""
    if not getattr(link, "paths", None):
        return None
    ps = _link_paths(link)
    if len(ps) != 1:
        return None
    try:
        r = resolve_link_path(link, ps[0])
    except HTTPException:
        return None
    return r if r.is_dir() else None


def is_folder_link(link: ShareLink) -> bool:
    return link_folder_root(link) is not None


def link_browse_target(root: Path, sub: str) -> Path:
    """링크 폴더 기준 하위 경로 → 실제 경로. 범위 밖·숨김·부재는 모두 404(존재 여부를 노출하지 않음)."""
    parts = [p for p in sub.replace("\\", "/").split("/") if p]
    if any(fs._is_hidden(p) for p in parts):     # '.', '..', '.versions', '@Recycle' …
        raise HTTPException(status_code=404, detail="찾을 수 없습니다")
    base = root.resolve()
    real = base.joinpath(*parts).resolve()
    if not real.is_relative_to(base) or not real.exists():
        raise HTTPException(status_code=404, detail="찾을 수 없습니다")
    return real


def _preview_kind(p: Path) -> str | None:
    """손님 화면 미리보기 — 텍스트이거나 브라우저 내에서 열어도 안전한 이미지·PDF 만 허용.

    미리보기 가능 형식의 단일 출처: 손님 화면(/s/<token> 의 [미리보기]·폴더 링크 목록의 preview),
    내려받기가 차단된 링크의 inline 응답, "내려받기 막음" 설정 가능 여부(create/update_share_link)가 모두 이 함수를 사용한다.
    """
    t = pv.can_preview(p)
    if t == "text":
        return t
    if t in ("image", "pdf") and serve_safety.inline_allowed(serve_safety.guess_type(p.name)):
        return t
    return None


NO_PREVIEW_BLOCK_DETAIL = ("이 형식은 미리 볼 수 없어 다운로드를 막을 수 없습니다"
                           "(막으면 받는 사람이 아무것도 볼 수 없습니다). 미리보기는 이미지·PDF·텍스트만 지원합니다")


def link_single_file(link: ShareLink) -> Path | None:
    """파일 하나짜리 링크이면 해당 파일의 실제 경로(없거나 폴더·묶음 링크이면 None)."""
    if getattr(link, "paths", None):
        return None
    try:
        real = resolve_link_path(link)
    except HTTPException:
        return None
    return real if real.is_file() else None


BUNDLE_BLOCK_DETAIL = ("모음 링크는 미리보기가 없어 다운로드를 막을 수 없습니다"
                       "(막으면 받는 사람이 아무것도 볼 수 없습니다). 폴더 하나 또는 파일 하나로 링크를 만드십시오")


def link_block_refusal(link: ShareLink) -> str | None:
    """이 링크에 "내려받기 막음(미리보기만)"을 설정할 수 없는 사유(설정 가능하면 None).

    - 파일 하나짜리 보기 링크가 미리보기 불가 형식 → NO_PREVIEW_BLOCK_DETAIL
    - 묶음(zip) 링크 — 항목 둘 이상, 또는 과거에 paths 로 생성된 파일 하나 → BUNDLE_BLOCK_DETAIL
    - 폴더 하나(둘러보기)·같이 편집 링크, 원본이 없는 링크는 판정 대상이 아니다(None).
    """
    if link.can_edit:
        return None
    if getattr(link, "paths", None):
        ps = _link_paths(link)
        if len(ps) > 1:
            return BUNDLE_BLOCK_DETAIL
        try:
            r = resolve_link_path(link, ps[0])
        except HTTPException:
            return None
        return BUNDLE_BLOCK_DETAIL if r.is_file() else None
    real = link_single_file(link)
    return NO_PREVIEW_BLOCK_DETAIL if real is not None and _preview_kind(real) is None else None


def link_can_block_download(link: ShareLink) -> bool:
    return link_block_refusal(link) is None


def link_target_exists(link: ShareLink) -> bool:
    """링크 원본의 존재 여부(묶음은 하나라도 존재하면 참). 휴지통·삭제·이동이면 False."""
    for vp in _link_paths(link):
        try:
            if resolve_link_path(link, vp).exists():
                return True
        except HTTPException:
            continue
    return False


def link_preview_kind(link: ShareLink) -> str | None:
    """손님 화면용 — 파일 하나짜리 링크의 미리보기 종류. 볼 수 없으면(형식·묶음·폴더·원본 없음) None."""
    real = link_single_file(link)
    return _preview_kind(real) if real is not None else None


def _scan_link_folder(real: Path, base: Path, sub: str) -> tuple[list[dict], bool]:
    items: list[dict] = []
    truncated = False
    try:
        entries = sorted(real.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    except (PermissionError, FileNotFoundError):
        return [], False
    for e in entries:
        if fs._is_hidden(e.name):
            continue
        try:
            if not e.resolve().is_relative_to(base):   # 심볼릭 링크를 통한 범위 이탈
                continue
            st = e.stat()
        except OSError:
            continue
        is_dir = e.is_dir()
        if not is_dir and not e.is_file():
            continue
        if len(items) >= _LINK_LIST_MAX:
            truncated = True
            break
        mime = None
        if not is_dir:
            import mimetypes
            mime, _ = mimetypes.guess_type(e.name)
        items.append({
            "name": e.name,
            "path": f"{sub}/{e.name}".strip("/"),
            "is_dir": is_dir,
            "size": 0 if is_dir else st.st_size,
            "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            "mime_type": mime,
            "preview": None if is_dir else _preview_kind(e),
        })
    return items, truncated


@router.get("/shared/{token}/list")
async def list_shared_link_folder(
    token: str,
    request: Request,
    sub: str = Query("", description="링크 폴더 안 하위 경로(비우면 링크 폴더)"),
    access: str | None = Query(None, description="unlock 으로 받은 접근 키(비밀번호 링크)"),
    db: AsyncSession = Depends(get_db),
):
    """폴더 링크 내부 목록(인증 없음, 횟수 미집계). 항목 path 는 링크 폴더 기준 상대 경로."""
    link = await load_public_link(db, token)
    if not await _password_gate(link, request, access):
        raise HTTPException(status_code=401, detail="password_required")
    if link.max_downloads and link.download_count >= link.max_downloads:
        raise HTTPException(status_code=410, detail="다운로드 횟수를 초과했습니다")
    root = link_folder_root(link)
    if root is None:
        raise HTTPException(status_code=400, detail="폴더 링크가 아닙니다")
    sub = sub.strip("/") if isinstance(sub, str) else ""
    real = link_browse_target(root, sub) if sub else root.resolve()
    if not real.is_dir():
        raise HTTPException(status_code=404, detail="폴더가 아닙니다")
    items, truncated = await asyncio.to_thread(_scan_link_folder, real, root.resolve(), sub)
    return {"name": root.name, "sub": sub, "allow_download": link.allow_download is not False,
            "items": items, "truncated": truncated}


@router.post("/shared/{token}/unlock")
async def unlock_shared(token: str, body: ShareUnlockRequest, request: Request = None,
                        db: AsyncSession = Depends(get_db)):
    """비밀번호 링크 해제 → {access} (1시간). 내려받기 주소에 ?access= 로 부가한다.

    동일 링크를 동일 주소에서 10분에 10회 실패하면 429(시도 제한)."""
    link = await load_public_link(db, token)
    if not link.password_hash:
        return {"ok": True, "access": None}
    if not await check_link_password(link, body.password or "", request):
        raise HTTPException(status_code=401, detail="비밀번호가 맞지 않습니다")
    # 비밀번호 링크는 info 가 내용을 숨기므로, 해제 후 손님 화면이 안내를 표시할 수 있도록 여기서 전달한다.
    #   exists      — 원본이 삭제되었으면 false("삭제됨" 안내가 우선한다. 없는 파일을 "미리 볼 수 없는 형식"으로 안내하면 오류)
    #   can_preview — 내려받기가 차단된 링크에서 볼 수 있는 내용의 존재 여부(원본이 없으면 판정하지 않고 true)
    exists = link_target_exists(link)
    return {"ok": True, "access": make_unlock_access(token), "exists": exists,
            "can_preview": (not exists) or link_folder_root(link) is not None or link_preview_kind(link) is not None}


@router.get("/shared/{token}")
async def download_shared(
    token: str,
    request: Request,
    access: str | None = Query(None, description="unlock 으로 받은 접근 키(비밀번호 링크)"),
    inline: bool = Query(False, description="미리보기(내려받기 막힌 링크도 이미지·PDF·텍스트는 허용)"),
    sub: str | None = Query(None, description="폴더 링크 안 하위 경로 — 파일이면 그 파일, 폴더면 그 폴더 zip"),
    db: AsyncSession = Depends(get_db),
):
    # 함수를 직접 호출하면(테스트) 기본값이 Query 객체이므로 문자열일 때만 사용한다
    sub = sub.strip("/") if isinstance(sub, str) and sub.strip("/") else None
    link = await load_public_link(db, token)

    if not await _password_gate(link, request, access):
        raise HTTPException(status_code=401, detail="password_required")

    blocked = link.allow_download is False
    if blocked and not inline:
        raise HTTPException(status_code=403, detail="이 링크는 다운로드가 막혀 있습니다(미리보기만 가능)")

    # Check download limit
    if link.max_downloads and link.download_count >= link.max_downloads:
        raise HTTPException(status_code=410, detail="다운로드 횟수를 초과했습니다")

    folder = link_folder_root(link)
    target = None
    if sub is not None:
        if folder is None:
            raise HTTPException(status_code=400, detail="폴더 링크가 아닙니다")
        target = link_browse_target(folder, sub)
    zip_name = None
    multi = _link_paths(link) if link.paths else None
    if target is not None and target.is_dir():
        if blocked:
            raise HTTPException(status_code=403, detail="이 링크는 다운로드가 막혀 있습니다")
        multi, entries_src, real = [sub], [target], None
        zip_name = f"{target.name}.zip"
    elif target is not None:
        real = target
        if not real.is_file():
            raise HTTPException(status_code=404, detail="찾을 수 없습니다")
        multi = None
    elif multi:
        if blocked:
            raise HTTPException(status_code=403, detail="이 링크는 다운로드가 막혀 있습니다")
        entries_src = []
        for vp in multi:
            try:
                r = resolve_link_path(link, vp)
            except HTTPException:
                continue
            if r.exists():
                entries_src.append(r)
        if not entries_src:
            raise HTTPException(status_code=404, detail="File no longer exists")
        real = None
    else:
        real = resolve_link_path(link)
    if real is not None:
        if not real.is_file():
            raise HTTPException(status_code=404, detail="File no longer exists")
        if blocked:
            # 미리보기는 텍스트(JSON)이거나 브라우저 내에서 열어도 안전한 형식(이미지·PDF)만 허용 — svg·html 등은 불가
            if _preview_kind(real) is None:
                raise HTTPException(status_code=403, detail="이 형식은 미리 볼 수 없고 다운로드가 막혀 있습니다")

    # 다운로드 횟수 원자적 증가 (TOCTOU 방지 — 동시요청 한도 우회 차단)
    # 폴더 링크 내부 파일 미리보기는 내려받기가 아니므로 집계하지 않는다(탐색만으로 1회 링크가 소진되지 않도록 함).
    from sqlalchemy import update as _sa_update
    if target is not None and inline and real is not None:
        pass
    elif link.max_downloads:
        res = await db.execute(
            _sa_update(ShareLink)
            .where(ShareLink.token == token,
                   ShareLink.download_count < link.max_downloads)
            .values(download_count=ShareLink.download_count + 1)
        )
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=410, detail="다운로드 횟수를 초과했습니다")
    else:
        await db.execute(
            _sa_update(ShareLink).where(ShareLink.token == token)
            .values(download_count=ShareLink.download_count + 1)
        )
        await db.commit()

    owner = await db.get(User, link.created_by)
    if owner is not None:
        vp_key = f"{link.file_path.rstrip('/')}/{sub}" if sub else link.file_path
        await act.record(act.canonical_key(vp_key, owner), None, "link_download",
                         {"link_id": link.id}, actor_name="공유 링크")

    if multi:
        from urllib.parse import quote
        fence = folder.resolve() if folder is not None else None

        def _entries():
            for r in entries_src:
                if r.is_file():
                    yield r, r.name
                else:
                    for p in sorted(r.rglob("*")):
                        if not p.is_file() or any(fs._is_hidden(part) for part in p.relative_to(r).parts):
                            continue
                        if fence is not None and not p.resolve().is_relative_to(fence):   # 심볼릭 링크를 통한 범위 이탈
                            continue
                        yield p, f"{r.name}/{p.relative_to(r)}"

        if zip_name is None:
            zip_name = link.display_name if link.display_name.endswith(".zip") else link.display_name + ".zip"
        return StreamingResponse(
            _stream_zip(_entries()),
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename=\"shared.zip\"; filename*=UTF-8''{quote(zip_name)}"},
        )

    if blocked:
        # 내려받기 차단 — 브라우저 내에서만 표시(inline + no-store). 완전한 복제 방지는 아니다.
        ptype = pv.can_preview(real)
        if ptype == "text":
            text = await asyncio.to_thread(pv.get_text_preview, real)
            return {"type": "text", "content": text, "name": real.name if target is not None else link.display_name}
        media, headers = serve_safety.safe_file_headers(real.name, inline=True)
        headers["Cache-Control"] = "no-store"
        return FileResponse(path=str(real), media_type=media, headers=headers)

    # 횟수 차감 이후이므로 304 를 반환해도 1회로 집계한다 — 공유 링크는 캐시 재검증보다 한도를 우선한다.
    # inline=1 이어도 안전한 형식만 inline(나머지는 내려받기) — serve_safety
    return _file_response(real, request, filename=real.name if target is not None else link.display_name, inline=inline)


# ─── 버전: 이전 버전 내려받기 ───


@router.get("/versions/download")
async def download_version(
    request: Request,
    path: str = Query(..., description="my/ 아래 파일 가상경로"),
    version: str = Query(..., description="list_versions 의 version(epoch ms)"),
    user: User = Depends(get_current_user),
):
    rel = fs.owner_relpath_from_my(path)
    if rel is None:
        raise HTTPException(status_code=400, detail="내 파일(my/)만 버전 관리됩니다")
    _check_path(path, user)
    if not version.isdigit():
        raise HTTPException(status_code=400, detail="잘못된 버전")
    try:
        snap = fs._version_dir(user.id, rel) / version
    except fs.PathSecurityError:
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    if not snap.is_file():
        raise HTTPException(status_code=404, detail="해당 버전을 찾을 수 없습니다")
    name = Path(rel).name
    stamp = datetime.fromtimestamp(int(version) / 1000, tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
    stem, dot, ext = name.rpartition(".")
    fname = f"{stem} ({stamp}).{ext}" if dot else f"{name} ({stamp})"
    return _file_response(snap, request, filename=fname)


# ─── 휴지통: 한 건 영구 삭제 ───


@router.delete("/trash/{trash_name}")
async def delete_trash_item(
    trash_name: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    trash = _trash_dir(user)
    target = trash / trash_name
    if "/" in trash_name or "\\" in trash_name or not target.resolve().is_relative_to(trash.resolve()) \
            or target.resolve() == trash.resolve():
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    if not target.exists() and not target.is_symlink():
        raise HTTPException(status_code=404, detail="Trashed file not found")
    if target.is_dir() and not target.is_symlink():
        await asyncio.to_thread(shutil.rmtree, str(target))
    else:
        await asyncio.to_thread(target.unlink)
    meta = await asyncio.to_thread(_load_trash_meta, user)
    info = meta.pop(trash_name, {})
    await asyncio.to_thread(_save_trash_meta, user, meta)
    if info.get("original_path"):
        await asyncio.to_thread(fs.drop_versions, user.id, info["original_path"])
    await acc.purge(db, user.id, acc.trash_key(trash_name))
    await acc.purge_links(db, None, acc.link_trash_key(user.id, trash_name))
    if info.get("original_path"):
        await act.record(act.canonical_key(info["original_path"], user), user.id, "purge")
    return {"ok": True}


# ─── 파일별 활동 기록 ───


@router.get("/activity")
async def file_activity(
    path: str = Query(..., description="파일·폴더 가상경로(my/.., shared/..)"),
    limit: int = Query(50, ge=1, le=200),
    include_children: bool = Query(False, description="폴더면 하위 항목 기록도"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이 파일(폴더)의 활동 기록(최신순). 접근 권한이 있는 경로만(공유받은 경로는 보기 이상)."""
    import json as _json
    key = (await acc.resolve(db, user, path, "view")).key
    if not key:
        raise HTTPException(status_code=400, detail="활동 기록을 볼 수 없는 경로입니다")
    cond = FileActivity.path_key == key
    if include_children:
        cond = cond | FileActivity.path_key.like(key + "/%")
    rows = (await db.execute(
        select(FileActivity).where(cond).order_by(FileActivity.created_at.desc()).limit(limit)
    )).scalars().all()
    names = await act.user_names(db, {r.user_id for r in rows if r.user_id})
    prefix_len = len(key) + 1
    return {"items": [{
        "id": r.id,
        "action": r.action,
        "user": ({"id": r.user_id, "name": names.get(r.user_id) or r.actor_name or r.user_id}
                 if r.user_id else ({"id": None, "name": r.actor_name} if r.actor_name else None)),
        "detail": _json.loads(r.detail) if r.detail else None,
        "sub_path": r.path_key[prefix_len:] if r.path_key != key else None,
        "created_at": r.created_at.isoformat(),
    } for r in rows]}


# ─── 즐겨찾기 ───


def _stat_item(vp: str, real: Path) -> dict:
    import mimetypes as _mt
    st = real.stat()
    return {
        "name": real.name,
        "path": vp,
        "is_dir": real.is_dir(),
        "size": st.st_size if real.is_file() else 0,
        "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        "mime_type": _mt.guess_type(real.name)[0] if real.is_file() else None,
        "etag": fs.compute_etag(st) if real.is_file() else None,
    }


@router.get("/stars")
async def list_stars(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """즐겨찾기 목록(최근 추가 순). 원본이 없는 항목은 exists=false 로 함께 반환한다."""
    rows = (await db.execute(
        select(FileStar).where(FileStar.user_id == user.id).order_by(FileStar.created_at.desc())
    )).scalars().all()
    out = []
    for r in rows:
        try:
            real = fs.resolve_path(r.path, user)
        except (fs.PathSecurityError, fs.AccessDeniedError):
            continue
        if real.exists():
            out.append({**_stat_item(r.path, real), "exists": True, "starred_at": r.created_at.isoformat()})
        else:
            out.append({"name": r.path.rsplit("/", 1)[-1], "path": r.path, "exists": False,
                        "starred_at": r.created_at.isoformat()})
    return {"items": out}


@router.post("/stars")
async def add_star(
    body: StarRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    vp = body.path.strip("/")
    real = _check_path(vp, user)
    if not real.exists():
        raise HTTPException(status_code=404, detail="Not found")
    exists = (await db.execute(
        select(FileStar.id).where(FileStar.user_id == user.id, FileStar.path == vp)
    )).first()
    if not exists:
        db.add(FileStar(user_id=user.id, path=vp))
        await db.commit()
    return {"ok": True, "path": vp, "starred": True}


@router.delete("/stars")
async def remove_star(
    path: str = Query(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    vp = path.strip("/")
    rows = (await db.execute(
        select(FileStar).where(FileStar.user_id == user.id, FileStar.path == vp)
    )).scalars().all()
    for r in rows:
        await db.delete(r)
    await db.commit()
    return {"ok": True, "path": vp, "starred": False}


# ─── 최근(열람 기록) ───


def _recent_real(path: str, user: User, shares: dict) -> Path | None:
    if path.startswith("shared-with-me/"):
        rest = path[len("shared-with-me/"):]
        sid, _, sub = rest.partition("/")
        s = shares.get(sid)
        if not s:
            return None
        try:
            return _shared_sub_real(s, sub)
        except HTTPException:
            return None
    try:
        return fs.resolve_path(path, user)
    except (fs.PathSecurityError, fs.AccessDeniedError):
        return None


@router.get("/recent")
async def list_recent(
    limit: int = Query(30, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """최근 연 파일(최신순). 삭제되었거나 권한이 없어진 항목은 제외한다."""
    rows = (await db.execute(
        select(FileRecent).where(FileRecent.user_id == user.id)
        .order_by(FileRecent.accessed_at.desc()).limit(limit * 2)
    )).scalars().all()
    share_ids = {r.path[len("shared-with-me/"):].split("/", 1)[0] for r in rows if r.path.startswith("shared-with-me/")}
    shares = {}
    for sid in share_ids:
        srow = await _accessible_share(db, sid, user)
        if srow is not None:
            shares[srow.id] = srow
    out = []
    for r in rows:
        real = _recent_real(r.path, user, shares)
        if real is None or not real.exists():
            continue
        out.append({**_stat_item(r.path, real), "accessed_at": r.accessed_at.isoformat()})
        if len(out) >= limit:
            break
    return {"items": out}


@router.post("/recent")
async def add_recent(
    body: RecentRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """파일 열람을 기록한다(프런트가 미리보기·편집기를 열 때 호출). 활동 기록에도 '열람'으로 기록한다."""
    vp = body.path.strip("/")
    if vp.startswith("shared-with-me/"):
        sid, _, sub = vp[len("shared-with-me/"):].partition("/")
        s = await _accessible_share(db, sid, user)
        if not s:
            raise HTTPException(status_code=404, detail="공유를 찾을 수 없습니다")
        real = _shared_sub_real(s, sub)
        key = act.owner_key(s.owner_id, s.file_path.strip("/") + (f"/{sub}" if sub else ""))
    else:
        real = _check_path(vp, user)
        key = act.canonical_key(vp, user)
    if not real.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    await act.touch_recent(user.id, vp, real.name, db=db)
    await act.record(key, user.id, "view", db=db)
    return {"ok": True}


# ─── 공유받은 폴더 내부 탐색 ───


_shared_sub_real = acc.shared_sub_real   # 공유 루트 아래 sub 경로(범위 밖·숨김 차단) — 규칙은 access 모듈


@router.get("/shared-with-me/{share_id}/list")
async def list_shared_folder(
    share_id: str,
    path: str = Query("", description="공유 폴더 안 하위 경로(비우면 공유 루트)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """본인에게 공유된 폴더 내부를 탐색. 항목 path 는 'shared-with-me/<share_id>/<하위경로>'.

    role: 이 폴더에 대한 요청 사용자의 권한(조상 폴더 공유까지 포함한 최고 권한), can_write 는 호환용.
    """
    sub_q = path.strip("/")
    a = await acc.resolve(db, user, f"{acc.SHARED_ROOT}/{share_id}" + (f"/{sub_q}" if sub_q else ""), "view")
    s = a.share
    real = a.real
    if not real.is_dir():
        raise HTTPException(status_code=404, detail="폴더가 아닙니다")
    sub = path.strip("/")
    prefix = f"shared-with-me/{share_id}" + (f"/{sub}" if sub else "")
    # list_directory 캐시는 실제 경로만 키로 사용하여 소유자의 가상경로(my/..)가 혼입된다 → 캐시 없이 읽는다
    items = await asyncio.to_thread(fs._scan_directory, real, prefix)
    owner = await db.get(User, s.owner_id)
    oname = (owner.display_name or owner.username) if owner else "?"
    items = [it.model_copy(update={"owner": {"id": s.owner_id, "name": oname}}) for it in items]
    return {"path": prefix, "share_id": share_id, "role": a.role, "can_write": a.role in ("edit", "owner"),
            "owner": {"id": s.owner_id, "name": oname}, "items": items}


# ─── 채널로 공유(채팅 파일 메시지) ───

_CHANNEL_SHARE_MAX = 50 * 1024 * 1024  # 채팅 첨부 한도와 동일


@router.post("/share-channel", status_code=201)
async def share_to_channel(
    body: ChannelShareRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """파일을 채팅 채널에 첨부 메시지로 게시한다(파일은 채팅 저장소로 복사 — 원본이 변경되어도 메시지는 유지).

    대용량 파일(50MB 초과)은 413 — 공유 링크를 생성하여 첨부하는 방식을 사용해야 함을 의미한다.
    """
    import json as _json
    import mimetypes as _mt
    import uuid as _uuid
    from app.modules.registry import is_module_enabled
    if not is_module_enabled("chat"):
        raise HTTPException(status_code=404, detail="채팅을 사용하지 않는 설치입니다 — 채널에는 공유할 수 없습니다")
    from app.chat import service as chat_service

    if not await chat_service.is_channel_member(db, body.channel_id, user.id):
        raise HTTPException(status_code=403, detail="채널 멤버가 아닙니다")
    if not body.paths:
        raise HTTPException(status_code=400, detail="paths 가 비었습니다")
    if len(body.paths) > 10:
        raise HTTPException(status_code=400, detail="한 번에 10개까지 보낼 수 있습니다")
    reals = []
    for vp in body.paths:
        real = _check_path(vp, user)
        if not real.is_file():
            raise HTTPException(status_code=400, detail=f"파일만 보낼 수 있습니다: {vp}")
        if real.stat().st_size > _CHANNEL_SHARE_MAX:
            raise HTTPException(status_code=413, detail=f"50MB 를 넘는 파일은 공유 링크로 보내십시오: {real.name}")
        reals.append((vp, real))

    from app.chat.router import _broadcast_message
    chat_dir = Path(settings.storage_root) / "chat_files" / body.channel_id
    chat_dir.mkdir(parents=True, exist_ok=True)
    messages = []
    if body.message and body.message.strip():
        msg = await chat_service.create_message(db, body.channel_id, user.id, content=body.message.strip())
        await _broadcast_message(db, body.channel_id, user.id, body.message.strip(), msg)
        messages.append(msg)
    for vp, real in reals:
        disk_name = f"{_uuid.uuid4().hex[:8]}_{real.name}"
        await asyncio.to_thread(shutil.copy2, real, chat_dir / disk_name)
        size = (chat_dir / disk_name).stat().st_size
        file_meta = _json.dumps({
            "filename": real.name,
            "size": size,
            "mime_type": _mt.guess_type(real.name)[0] or "application/octet-stream",
            "url": f"/api/chat/channels/{body.channel_id}/files/{disk_name}",
            "disk_name": disk_name,
            "source_path": vp.strip("/"),
        }, ensure_ascii=False)
        msg = await chat_service.create_message(
            db, body.channel_id, user.id, content=real.name, message_type="file", file_meta=file_meta,
        )
        await _broadcast_message(db, body.channel_id, user.id, real.name, msg)
        messages.append(msg)
        await act.record(act.canonical_key(vp, user), user.id, "share_channel", {"channel_id": body.channel_id})
    return {"ok": True, "messages": messages}
