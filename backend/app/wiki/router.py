"""Wiki REST API endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.modules.registry import require_module
from app.wiki import service
from app.wiki.schemas import (
    MemberAdd, MemberUpdate, PageCreate, PageUpdate, SpaceCreate, SpaceUpdate,
)

router = APIRouter(prefix="/api/wiki", tags=["wiki"])


def _check_role(role: str | None, required: str):
    """Raise 403 if user lacks the required role."""
    levels = {"reader": 0, "writer": 1, "admin": 2}
    if role is None or levels.get(role, -1) < levels.get(required, 99):
        raise HTTPException(403, "접근 권한이 없습니다")


def _check_member_role(role: str):
    """멤버 역할은 지정된 세 가지만 허용한다 — 알 수 없는 값이 저장되면 해당 멤버는 권한이 전혀 없는 상태가 된다."""
    if role not in ("reader", "writer", "admin"):
        raise HTTPException(400, "역할은 reader · writer · admin 중 하나여야 합니다")


def _check_visibility(visibility: str | None):
    """공개 범위는 public · private 만 허용한다 — 알 수 없는 값이 저장되면 권한 검사에서 경고 없이 비공개로 처리된다."""
    if visibility is not None and visibility not in ("public", "private"):
        raise HTTPException(400, "공개 범위는 public · private 중 하나여야 합니다")


async def _member_target(db: AsyncSession, space_id: str, member_user_id: str):
    """멤버로 처리 가능한 대상인지 확인한다 — 스페이스가 존재하고, 소유자가 아니어야 한다.

    소유자는 멤버 표와 무관하게 항상 관리자이다(service.get_user_role). 멤버 행을 생성하거나 수정해도
    권한은 변경되지 않으나 화면에는 변경된 것으로 표시되므로 차단한다. 따라서 관리자가 0명이 되는 경우도 발생하지 않는다.
    """
    space = await service.get_space(db, space_id)
    if not space:
        raise HTTPException(404, "스페이스를 찾을 수 없습니다")
    if space.owner_id == member_user_id:
        raise HTTPException(400, "소유자의 권한은 바꿀 수 없습니다")
    return space


# ─── Spaces ───


@router.get("/spaces")
@require_module("wiki")
async def list_spaces(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.get_spaces(db, str(user.id))


@router.post("/spaces", status_code=201)
@require_module("wiki")
async def create_space(
    body: SpaceCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _check_visibility(body.visibility)
    existing = await service.get_space_by_slug(db, body.slug)
    if existing:
        raise HTTPException(400, "이미 사용 중인 슬러그입니다")
    return await service.create_space(db, str(user.id), **body.model_dump())


@router.get("/spaces/{space_id}")
@require_module("wiki")
async def get_space(
    space_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "reader")
    space = await service.get_space(db, space_id)
    if not space:
        raise HTTPException(404, "스페이스를 찾을 수 없습니다")
    return {
        "id": space.id, "name": space.name, "slug": space.slug,
        "description": space.description, "visibility": space.visibility,
        "icon": space.icon, "user_role": role,
        # 공유 창은 멤버 목록 최상단에 소유자를 표시함(소유자는 멤버 표에 없음)
        "owner": await service.get_space_owner(db, space),
    }


@router.patch("/spaces/{space_id}")
@require_module("wiki")
async def update_space(
    space_id: str,
    body: SpaceUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "admin")
    _check_visibility(body.visibility)
    await service.update_space(db, space_id, **body.model_dump(exclude_unset=True))
    return {"ok": True}


@router.delete("/spaces/{space_id}")
@require_module("wiki")
async def delete_space(
    space_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "admin")
    await service.delete_space(db, space_id)
    return {"ok": True}


# ─── Members ───


@router.get("/spaces/{space_id}/members")
@require_module("wiki")
async def list_members(
    space_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "reader")
    return await service.get_members(db, space_id)


@router.post("/spaces/{space_id}/members")
@require_module("wiki")
async def add_member(
    space_id: str,
    body: MemberAdd,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "admin")
    _check_member_role(body.role)
    await _member_target(db, space_id, body.user_id)
    # 존재하지 않거나 비활성인 사용자를 추가하면 외래 키 오류(500)가 발생하거나 이름 없는 유령 멤버가 생성됨
    if not await service.is_active_user(db, body.user_id):
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    await service.add_member(db, space_id, body.user_id, body.role)
    return {"ok": True}


@router.patch("/spaces/{space_id}/members/{member_user_id}")
@require_module("wiki")
async def update_member(
    space_id: str,
    member_user_id: str,
    body: MemberUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "admin")
    _check_member_role(body.role)
    await _member_target(db, space_id, member_user_id)
    # 멤버가 아닌 대상이면 변경 사항이 없는데도 성공으로 응답하던 문제 — 화면은 변경된 것으로 표시함
    if not await service.update_member(db, space_id, member_user_id, body.role):
        raise HTTPException(404, "멤버를 찾을 수 없습니다")
    return {"ok": True}


@router.delete("/spaces/{space_id}/members/{member_user_id}")
@require_module("wiki")
async def remove_member(
    space_id: str,
    member_user_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "admin")
    await service.remove_member(db, space_id, member_user_id)
    return {"ok": True}


# ─── Pages ───


@router.get("/spaces/{space_id}/pages")
@require_module("wiki")
async def list_pages(
    space_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "reader")
    return await service.get_page_tree(db, space_id)


@router.get("/pages/{page_id}")
@require_module("wiki")
async def get_page(
    page_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = await service.get_page(db, page_id)
    if not page:
        raise HTTPException(404, "페이지를 찾을 수 없습니다")
    role = await service.get_user_role(db, page["space_id"], str(user.id))
    if not user.is_admin:
        _check_role(role, "reader")
    page["user_role"] = role
    return page


@router.post("/spaces/{space_id}/pages", status_code=201)
@require_module("wiki")
async def create_page(
    space_id: str,
    body: PageCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "writer")
    try:
        return await service.create_page(db, space_id, str(user.id), **body.model_dump())
    except service.WikiMoveError as e:
        raise HTTPException(400, str(e))


@router.patch("/pages/{page_id}")
@require_module("wiki")
async def update_page(
    page_id: str,
    body: PageUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = await service.get_page(db, page_id)
    if not page:
        raise HTTPException(404)
    role = await service.get_user_role(db, page["space_id"], str(user.id))
    if not user.is_admin:
        _check_role(role, "writer")
    data = body.model_dump(exclude_unset=True)
    base_version = data.pop("base_version", None)
    # 본문·제목을 변경하는 저장만 검사(이동·고정은 버전과 무관)
    if base_version is not None and ("content" in data or "title" in data) and page["version"] != base_version:
        raise HTTPException(409, "다른 사람이 이 문서를 먼저 고쳤습니다")
    try:
        return await service.update_page(db, page_id, str(user.id), **data)
    except service.WikiMoveError as e:
        raise HTTPException(400, str(e))


@router.delete("/pages/{page_id}")
@require_module("wiki")
async def delete_page(
    page_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = await service.get_page(db, page_id)
    if not page:
        raise HTTPException(404)
    role = await service.get_user_role(db, page["space_id"], str(user.id))
    if not user.is_admin:
        _check_role(role, "writer")
    await service.delete_page(db, page_id)
    return {"ok": True}


# ─── Versions ───


@router.get("/pages/{page_id}/versions")
@require_module("wiki")
async def list_versions(
    page_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = await service.get_page(db, page_id)
    if not page:
        raise HTTPException(404)
    role = await service.get_user_role(db, page["space_id"], str(user.id))
    if not user.is_admin:
        _check_role(role, "reader")
    return await service.get_page_versions(db, page_id)


@router.post("/pages/{page_id}/versions/{version_number}/restore")
@require_module("wiki")
async def restore_version(
    page_id: str,
    version_number: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = await service.get_page(db, page_id)
    if not page:
        raise HTTPException(404)
    role = await service.get_user_role(db, page["space_id"], str(user.id))
    if not user.is_admin:
        _check_role(role, "writer")
    result = await service.restore_page_version(db, page_id, version_number, str(user.id))
    if result is None:
        raise HTTPException(404, "해당 버전을 찾을 수 없습니다")
    return result


# ─── Search ───


@router.get("/spaces/{space_id}/search")
@require_module("wiki")
async def search_pages(
    space_id: str,
    q: str = Query("", min_length=1),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    role = await service.get_user_role(db, space_id, str(user.id))
    if not user.is_admin:
        _check_role(role, "reader")
    return await service.search_pages(db, space_id, q)


# ─── 역링크 ───


@router.get("/pages/{page_id}/backlinks")
@require_module("wiki")
async def page_backlinks(
    page_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """이 페이지를 본문에서 링크한 페이지 목록. 본인이 읽을 수 있는 스페이스의 페이지만 포함한다."""
    page = await service.get_page(db, page_id)
    if not page:
        raise HTTPException(404, "페이지를 찾을 수 없습니다")
    if not user.is_admin:
        _check_role(await service.get_user_role(db, page["space_id"], str(user.id)), "reader")
    items = await service.get_backlinks(db, page_id, str(user.id), bool(user.is_admin))
    return {"items": items, "total": len(items)}
