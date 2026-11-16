"""내장 AI 화면 보강 — router.py 의 비대화를 방지하기 위해 분리한 엔드포인트. prefix 는 router.py 가 부여한다(/api/ai).

- GET /projects/{id}/share-check?group_ids=a,b — 공유 전 점검(읽기 불가 지식 파일·구성원 수, 경고만). 소유자만.
- GET /attachments/{id}/file[?download=1]      — 전송된 첨부 원본(7일 보관). 소유자만, 안전 헤더(serve_safety).
- GET /attachments/{id}/text                   — 문서 첨부에서 추출한 텍스트 앞부분(원본이 삭제된 경우에도 미리보기 가능).
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
    """선택한 그룹 구성원 중 지식 파일을 읽을 수 없는 구성원이 있으면 통지한다. 공유는 차단하지 않는다."""
    p = await ai_projects.get_owned(db, user, project_id)
    gids = [g for g in dict.fromkeys(x.strip() for x in group_ids.split(",")) if g]
    if not gids:
        return {"members": 0, "blocked_members": 0, "sampled": False, "files": []}
    return await ai_projects.share_check(db, p, gids)


async def _owned_attachment(db: AsyncSession, user: User, att_id: str):
    from app.ai.models import AIAttachment

    a = await db.get(AIAttachment, att_id)
    if a is None or a.user_id != user.id:  # 타 사용자의 첨부는 존재 여부도 노출하지 않는다
        raise HTTPException(status_code=404, detail="첨부를 찾을 수 없습니다")
    return a


@router.get("/attachments/{att_id}/file")
@require_module("ai")
async def attachment_file(att_id: str, download: bool = False, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    """첨부 원본. 이미지·PDF 는 inline(미리보기), 그 외는 항상 내려받기. 보관 기간(7일) 경과 시 410."""
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
    """문서 첨부에서 추출한 텍스트(앞 TEXT_PREVIEW_CHARS 자) — 미리보기 창에서 원본 대신 표시한다."""
    a = await _owned_attachment(db, user, att_id)
    text = a.extracted_text or ""
    return {"id": a.id, "name": a.name, "kind": a.kind, "text": text[:TEXT_PREVIEW_CHARS],
            "truncated": len(text) > TEXT_PREVIEW_CHARS, "has_file": ai_att.has_file(a.id)}


@router.get("/model-choices")
@require_module("ai")
async def model_choices(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """설정 › AI 기본 모델 선택지(workspace · workspace_advanced · personal) — 선택 가능 여부·모델·vision.

    입력창의 "이미지 읽는 모델로 바꾸기" 표시 여부를 결정한다(선택 가능한 항목 중 vision 지원이 있는 경우에만).
    변경은 기존 PUT /api/ai/my-settings {default_model} 을 사용한다.
    """
    gcfg = await ai_config.get_ai_config(db)
    current_cfg, is_personal = await ai_config.resolve_provider_for_user(db, user)
    # 동일 세션이므로 순차 실행(동시 실행 금지)
    ws = await ai_config.resolve_provider(db)
    adv = await ai_config.resolve_provider(db, advanced=True)
    personal = await ai_config.resolve_user_provider(db, user.id) if gcfg["governance"]["allow_user_keys"] else None
    has_adv = bool(gcfg.get("advanced_model"))

    def _row(key: str, cfg, available: bool) -> dict:
        return {"key": key, "available": bool(available and cfg is not None),
                "model": getattr(cfg, "model", "") if cfg else "",
                "vision": bool(cfg is not None and supports_vision(cfg))}

    rows = [_row("workspace", ws, True), _row("workspace_advanced", adv, has_adv), _row("personal", personal, personal is not None)]
    # 현재 선택 — get_my_settings 의 effective_default_model 과 동일한 규칙
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

