"""그룹/팀 + 모듈권한 관리 API (admin)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import audit
from app.auth.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.groups import service as groups_service
from app.groups.models import Group, GroupMember, ModuleGrant

router = APIRouter(prefix="/api/admin/groups", tags=["groups"])


def _admin(user: User) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="관리자만 가능합니다")


class GroupBody(BaseModel):
    name: str
    description: str = ""


class GroupPatch(BaseModel):
    name: str | None = None
    description: str | None = None


class MemberBody(BaseModel):
    user_id: str
    role: str = "member"


class ModulesBody(BaseModel):
    module_ids: list[str]


@router.get("")
async def list_groups(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    groups = (await db.execute(select(Group).order_by(Group.name))).scalars().all()
    # 멤버 수
    counts = dict((await db.execute(
        select(GroupMember.group_id, func.count(GroupMember.id)).group_by(GroupMember.group_id)
    )).all())
    # grant 모듈
    grants: dict[str, list[str]] = {}
    for gid, mid in (await db.execute(select(ModuleGrant.group_id, ModuleGrant.module_id))).all():
        grants.setdefault(gid, []).append(mid)
    return {"groups": [{
        "id": g.id, "name": g.name, "description": g.description,
        "member_count": counts.get(g.id, 0), "modules": grants.get(g.id, []),
    } for g in groups]}


@router.post("", status_code=201)
async def create_group(body: GroupBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    if (await db.execute(select(Group).where(Group.name == body.name))).scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 존재하는 그룹명")
    g = Group(name=body.name.strip(), description=body.description or "")
    db.add(g)
    await db.commit()
    await audit.log_action(db, user.id, "group.create", "group", g.id, {"name": g.name})
    return {"id": g.id, "name": g.name, "description": g.description, "member_count": 0, "modules": []}


@router.patch("/{group_id}")
async def update_group(group_id: str, body: GroupPatch, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    g = await db.get(Group, group_id)
    if not g:
        raise HTTPException(status_code=404, detail="그룹 없음")
    if body.name is not None:
        g.name = body.name.strip()
    if body.description is not None:
        g.description = body.description
    await db.commit()
    await audit.log_action(db, user.id, "group.update", "group", g.id, {"name": g.name})
    return {"ok": True}


@router.delete("/{group_id}", status_code=204)
async def delete_group(group_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    g = await db.get(Group, group_id)
    if not g:
        raise HTTPException(status_code=404, detail="그룹 없음")
    await db.execute(delete(GroupMember).where(GroupMember.group_id == group_id))
    await db.execute(delete(ModuleGrant).where(ModuleGrant.group_id == group_id))
    name = g.name
    await db.delete(g)
    await db.commit()
    await groups_service.load_grants(db)
    # 이 그룹으로 격리 브라우저를 사용하던 사용자의 열린 세션을 즉시 종료한다(실패해도 삭제는 유지)
    from app.rbi.service import enforce_access_quietly
    await enforce_access_quietly(db, actor_id=user.id)
    await audit.log_action(db, user.id, "group.delete", "group", group_id, {"name": name})
    return None


@router.get("/{group_id}/members")
async def list_members(group_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    rows = (await db.execute(
        select(GroupMember, User).join(User, User.id == GroupMember.user_id)
        .where(GroupMember.group_id == group_id)
    )).all()
    return {"members": [{
        "user_id": m.user_id, "role": m.role,
        "username": u.username, "display_name": u.display_name, "email": u.email,
    } for m, u in rows]}


@router.post("/{group_id}/members", status_code=201)
async def add_member(group_id: str, body: MemberBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    if not await db.get(Group, group_id):
        raise HTTPException(status_code=404, detail="그룹 없음")
    if not await db.get(User, body.user_id):
        raise HTTPException(status_code=404, detail="사용자 없음")
    exists = (await db.execute(select(GroupMember).where(
        GroupMember.group_id == group_id, GroupMember.user_id == body.user_id))).scalar_one_or_none()
    if exists:
        exists.role = body.role
    else:
        db.add(GroupMember(group_id=group_id, user_id=body.user_id, role=body.role))
    await db.commit()
    # 그룹 소속이 곧 모듈 접근 권한(module_grants)이므로 권한 변경으로 기록
    await audit.log_action(
        db, user.id, "group.member_add", "group", group_id, {"user_id": body.user_id, "role": body.role},
    )
    return {"ok": True}


@router.delete("/{group_id}/members/{user_id}", status_code=204)
async def remove_member(group_id: str, user_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    await db.execute(delete(GroupMember).where(
        GroupMember.group_id == group_id, GroupMember.user_id == user_id))
    await db.commit()
    # 그룹으로 부여된 격리 브라우저 권한이 소멸한 경우 열린 세션을 즉시 종료한다(실패해도 제거는 유지)
    from app.rbi.service import enforce_access_quietly
    await enforce_access_quietly(db, user_id=user_id, actor_id=user.id)
    await audit.log_action(db, user.id, "group.member_remove", "group", group_id, {"user_id": user_id})
    return None


@router.put("/{group_id}/modules")
async def set_modules(group_id: str, body: ModulesBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    _admin(user)
    if not await db.get(Group, group_id):
        raise HTTPException(status_code=404, detail="그룹 없음")
    await db.execute(delete(ModuleGrant).where(ModuleGrant.group_id == group_id))
    for mid in dict.fromkeys(body.module_ids):
        db.add(ModuleGrant(group_id=group_id, module_id=mid))
    await db.commit()
    await groups_service.load_grants(db)
    # 모듈 권한 변경 시 rbi 권한을 상실한 사용자의 열린 격리 브라우저 세션을 즉시 종료한다(실패해도 저장은 유지)
    from app.rbi.service import enforce_access_quietly
    await enforce_access_quietly(db, actor_id=user.id)
    await audit.log_action(
        db, user.id, "group.modules_set", "group", group_id, {"modules": list(dict.fromkeys(body.module_ids))},
    )
    return {"ok": True, "modules": list(dict.fromkeys(body.module_ids))}
