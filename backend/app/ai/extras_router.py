"""내장 AI 화면 보강(시안 J1·J2·K1) — router.py 를 키우지 않으려고 따로 둔 엔드포인트. prefix 는 router.py 가 붙인다(/api/ai).

- GET /projects/{id}/share-check?group_ids=a,b — 공유 전 점검(못 읽는 지식 파일·구성원 수, 경고만). 주인만.
- GET /attachments/{id}/file[?download=1]      — 보낸 첨부 원본(7일 보관). 주인만, 안전 헤더(serve_safety).
- GET /attachments/{id}/text                   — 문서 첨부에서 뽑은 글자 앞부분(원본이 지워졌어도 미리보기).
- GET /model-choices                           — 설정 › AI 기본 모델 선택지별 모델 이름·이미지 읽기(vision) 여부.
"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import attachments as ai_att
from app.ai import config as ai_config
from app.ai import projects as ai_projects
from app.ai.providers import supports_vision
from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.modules.registry import require_module

router = APIRouter()

TEXT_PREVIEW_CHARS = 20_000


@router.get("/projects/{project_id}/share-check")
@require_module("ai")
async def project_share_check(project_id: str, group_ids: str = "", user: User = Depends(get_current_user),
                              db: AsyncSession = Depends(get_db)):
    """고른 그룹 구성원 중 지식 파일을 못 읽는 사람이 있으면 알려 준다(시안 J2-1). 공유는 막지 않는다."""
    p = await ai_projects.get_owned(db, user, project_id)
    gids = [g for g in dict.fromkeys(x.strip() for x in group_ids.split(",")) if g]
    if not gids:
        return {"members": 0, "blocked_members": 0, "sampled": False, "files": []}
    return await ai_projects.share_check(db, p, gids)


async def _owned_attachment(db: AsyncSession, user: User, att_id: str):
    from app.ai.models import AIAttachment

    a = await db.get(AIAttachment, att_id)
    if a is None or a.user_id != user.id:  # 남의 첨부는 있는지도 알리지 않는다
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다")
    return a


@router.get("/attachments/{att_id}/file")
@require_module("ai")
async def attachment_file(att_id: str, download: bool = False, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    """첨부 원본. 이미지·PDF 는 inline(미리보기), 그 밖은 늘 내려받기. 보관 기간(7일)이 지나면 410."""
    from app.files.serve_safety import safe_file_headers

    a = await _owned_attachment(db, user, att_id)
    path = ai_att.file_path(a.id)
    if path is None:
        raise HTTPException(status_code=410, detail={"code": "expired", "message": "보관 기간이 지나 원본을 열 수 없습니다"})
    media, headers = safe_file_headers(a.name, content_type=a.mime, inline=not download)
    headers["Cache-Control"] = "private, max-age=300"
    return FileResponse(path, media_type=media, headers=headers)


@router.get("/attachments/{att_id}/text")
@require_module("ai")
async def attachment_text(att_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """문서 첨부에서 뽑은 글자(앞 TEXT_PREVIEW_CHARS 자) — 미리보기 창에서 원본 대신 보여 준다."""
    a = await _owned_attachment(db, user, att_id)
    text = a.extracted_text or ""
    return {"id": a.id, "name": a.name, "kind": a.kind, "text": text[:TEXT_PREVIEW_CHARS],
            "truncated": len(text) > TEXT_PREVIEW_CHARS, "has_file": ai_att.has_file(a.id)}


@router.get("/model-choices")
@require_module("ai")
async def model_choices(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """설정 › AI 기본 모델 선택지(workspace · workspace_advanced · personal) — 고를 수 있는지·모델·vision.

    입력창이 "이미지 읽는 모델로 바꾸기"를 보여 줄지 정한다(고를 수 있는 것 중 vision 이 있을 때만).
    바꾸기는 기존 PUT /api/ai/my-settings {default_model}.
    """
    gcfg = await ai_config.get_ai_config(db)
    current_cfg, is_personal = await ai_config.resolve_provider_for_user(db, user)
    # 같은 세션이라 차례로(동시 실행 금지)
    ws = await ai_config.resolve_provider(db)
    adv = await ai_config.resolve_provider(db, advanced=True)
    personal = await ai_config.resolve_user_provider(db, user.id) if gcfg["governance"]["allow_user_keys"] else None
    has_adv = bool(gcfg.get("advanced_model"))

    def _row(key: str, cfg, available: bool) -> dict:
        return {"key": key, "available": bool(available and cfg is not None),
                "model": getattr(cfg, "model", "") if cfg else "",
                "vision": bool(cfg is not None and supports_vision(cfg))}

    rows = [_row("workspace", ws, True), _row("workspace_advanced", adv, has_adv), _row("personal", personal, personal is not None)]
    # 지금 쓰는 선택 — get_my_settings 의 effective_default_model 과 같은 규칙
    choice = (await ai_config.get_user_ai_prefs(db, user.id))["default_model"]
    if is_personal:
        current = "personal"
    elif choice == "workspace_advanced" and has_adv:
        current = "workspace_advanced"
    else:
        current = "workspace"
    for r in rows:
        r["current"] = r["key"] == current
    return {"choices": rows, "current": current, "vision": bool(current_cfg is not None and supports_vision(current_cfg))}

