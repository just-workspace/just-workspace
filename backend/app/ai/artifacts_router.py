"""S4 결과물 API — 카드(미리보기·내려받기·내 파일 저장·다시 만들기)·묶음 작업·파일 화면 [압축해서 내려받기].

모듈 게이트 없음(MCP 로 만든 결과물도 같은 링크로 받는다). 모든 요청은 로그인한 **소유자**만.
내려받기는 서명(exp·sig, 24시간)까지 맞아야 한다. 내 파일 저장·파일 압축은 쓰기 체계(request_write)를 지난다.
"""
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import artifacts as arts
from app.ai import docgen
from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db

router = APIRouter(prefix="/api/ai/artifacts", tags=["ai-artifacts"])


def _http(e: arts.ArtifactError) -> HTTPException:
    return HTTPException(status_code=e.status, detail={"code": e.code, "message": e.message, **e.extra})


async def _write(db, user: User, tool: str, args: dict, client: str) -> dict:
    """사람이 누른 쓰기 — internal 출처로 request_write(감사·기록·되돌리기는 같다)."""
    from app.mcp import writes

    out = await writes.request_write(db, user, tool, args, ctx=writes.CallContext(
        source="internal", client_name=client, client_kind="internal"))
    if out.get("status") != "executed":
        msg = out.get("error") or out.get("message") or out.get("status") or "실패"
        code = 413 if ("할당" in msg or "상한" in msg) else (403 if "권한" in msg else 400)
        raise HTTPException(status_code=code, detail={"code": "quota" if code == 413 else "failed", "message": msg})
    res = dict(out.get("result") or {})
    res["request_id"] = out.get("request_id")
    res["can_undo"] = bool(out.get("can_undo"))
    return res


async def _quota_check(db, user: User, items: list) -> None:
    room = await arts.quota_room(db, user)
    need = sum(int(a.size or 0) for a in items)
    if room is not None and need > room:
        raise HTTPException(status_code=413, detail={
            "code": "quota", "room_bytes": room, "need_bytes": need,
            "message": "저장 공간이 부족해 저장하지 못했습니다"})


# ── 파일 하나 ─────────────────────────────────────────────────
@router.get("/{aid}")
async def get_artifact(aid: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        a = await arts.get_owned(db, user, aid)
    except arts.ArtifactError as e:
        raise _http(e)
    await arts.sweep(db)
    return arts.artifact_out(a)


@router.get("/{aid}/download")
async def download_artifact(aid: str, request: Request, exp: str = "", sig: str = "",
                            user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.files.router import _file_response

    a = await db.get(arts.AIArtifact, aid)
    if a is None or a.user_id != user.id:
        raise HTTPException(status_code=404, detail="결과물이 없습니다")
    if not arts.check_sig(a, user.id, exp, sig) or arts.state(a) != "ready":
        raise HTTPException(status_code=410, detail={"code": "expired", "message": "내려받기 링크가 만료됐습니다"})
    real = Path(arts.real_path(a))
    if a.saved_path and (arts._uj(a.info, {}) or {}).get("source") == "files":
        # 내 파일에 둔 zip — 지금 권한으로 다시 연다(옮겼거나 지웠으면 만료로)
        from app.files import access as acc

        gone = HTTPException(status_code=410, detail={"code": "expired", "message": "파일이 옮겨졌거나 지워졌습니다"})
        try:
            real = (await acc.resolve(db, user, a.saved_path, "view")).real
        except HTTPException:
            raise gone
        if not real.is_file():
            raise gone
    return _file_response(real, request, filename=a.name, media_type=a.mime)


@router.get("/{aid}/preview")
async def preview_artifact(aid: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        a = await arts.get_owned(db, user, aid)
    except arts.ArtifactError as e:
        raise _http(e)
    spec = arts._uj(a.spec)
    return {"artifact": arts.artifact_out(a), "preview": docgen.preview(spec) if spec else None}


@router.post("/{aid}/save")
async def save_artifact(aid: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        items = await arts.artifacts_for(db, user, [aid])
    except arts.ArtifactError as e:
        raise _http(e)
    await _quota_check(db, user, items)
    res = await _write(db, user, "artifacts_save_to_files", {"artifact_id": aid}, "결과물 카드")
    a = await arts.get_owned(db, user, aid)
    await db.refresh(a)          # 저장은 도구가 다른 세션에서 했다
    return {**res, "artifact": arts.artifact_out(a)}


@router.post("/{aid}/rebuild")
async def rebuild_artifact(aid: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        a = await arts.rebuild(db, user, aid)
    except arts.ArtifactError as e:
        raise _http(e)
    return arts.artifact_out(a)


# ── 묶음 작업 ─────────────────────────────────────────────────
@router.get("/jobs/{job_id}")
async def get_job(job_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        job = await arts.get_job(db, user, job_id)
    except arts.ArtifactError as e:
        raise _http(e)
    return await arts.job_view(db, job)


@router.post("/jobs/{job_id}/items/{index}/retry")
async def retry_job_item(job_id: str, index: int, user: User = Depends(get_current_user),
                         db: AsyncSession = Depends(get_db)):
    try:
        job = await arts.retry_item(db, user, job_id, index)
    except arts.ArtifactError as e:
        raise _http(e)
    return await arts.job_view(db, job)


@router.post("/jobs/{job_id}/rebuild")
async def rebuild_job(job_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        job = await arts.rebuild_job(db, user, job_id)
    except arts.ArtifactError as e:
        raise _http(e)
    return await arts.job_view(db, job)


@router.post("/jobs/{job_id}/save")
async def save_job(job_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        items = await arts.artifacts_for(db, user, None, job_id)
    except arts.ArtifactError as e:
        raise _http(e)
    await _quota_check(db, user, items)
    res = await _write(db, user, "artifacts_save_to_files", {"job_id": job_id}, "결과물 카드")
    job = await arts.get_job(db, user, job_id)
    await db.refresh(job)
    return {**res, "job": await arts.job_view(db, job)}


# ── 파일 화면 [압축해서 내려받기] ────────────────────────────
class ZipBody(BaseModel):
    paths: list[str] = []
    folder: str = ""
    query: str = ""
    path: str = ""
    name_only: bool = False
    zip_name: str = ""


@router.post("/zip", status_code=202)
async def start_zip(body: ZipBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """files_zip 과 같은 작업 — 작업 id 를 돌려주고 화면은 GET /jobs/{id} 로 진행을 본다."""
    if not (body.paths or body.folder.strip("/") or body.query.strip()):
        raise HTTPException(status_code=400, detail="paths·folder·query 중 하나는 있어야 합니다")
    from app.mcp import writes

    out = await writes.request_write(db, user, "files_zip", body.model_dump(), ctx=writes.CallContext(
        source="internal", client_name="파일 화면", client_kind="internal"))
    if out.get("status") != "executed":
        msg = out.get("error") or "압축을 시작하지 못했습니다"
        code = 413 if "상한" in msg else (403 if "권한" in msg else (404 if "없습니다" in msg else 400))
        raise HTTPException(status_code=code, detail={"code": "failed", "message": msg})
    res = out.get("result") or {}
    return res.get("job") or res
