"""채팅 역할·카테고리·권한 덮어쓰기 API(P1-1, 백엔드만 — 관리 화면은 handover-22).

계산은 app/chat/permissions.py. 여기는 CRUD·계층 검사·감사 로그·멤버 목록 묶음.

관리 권한 판정(manage_*): 전역 관리자 → 됨 · 워크스페이스 범위 비트(@everyone ∪ 내 역할) → 됨 ·
채널 일이면 그 채널의 실효 비트 → 됨. 엔진 모드(legacy/shadow/enforce)와 무관하다 — 역할·덮어쓰기는
새 기능이라 예전 동작이 없다.

계층(디스코드와 같다): 전역 관리자·ADMINISTRATOR 가 아니면 내 최고 역할보다 낮은 역할만 만들고·고치고·
지우고·부여할 수 있고, 내가 가진 비트만 남에게 줄 수 있다. @everyone 은 position 0, 이름·삭제 불가.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.chat import permissions as P
from app.db.models import (
    Channel, ChannelMember, ChatCategory, ChatMemberRole, ChatPermissionOverwrite, ChatRole, User,
)
from app.db.session import get_db

router = APIRouter(prefix="/api/chat", tags=["chat-roles"])

INF = 1 << 30
RESERVED_NAMES = frozenset({"everyone", "here", "channel", "all", "채널", "전체", "모두"})


# ─── 공통 ───

def mention_key(name: str) -> str:
    """@역할 멘션에 쓰는 이름 — 공백은 '-' 로(MENTION_RE 가 공백을 못 받는다), 대소문자 무시."""
    return re.sub(r"\s+", "-", (name or "").strip()).lower()


def _bits(value: Any, field: str) -> int:
    try:
        return P.bits_of(value)
    except ValueError as e:
        raise HTTPException(400, f"{field}: {e}")


def role_dict(r: ChatRole, member_count: int | None = None) -> dict:
    perms = int(r.permissions or 0)
    out = {
        "id": r.id, "name": r.name, "color": r.color, "icon": r.icon, "position": r.position or 0,
        "permissions": perms, "permission_names": P.names_of(perms),
        "hoist": bool(r.hoist), "mentionable": bool(r.mentionable),
        "managed": r.group_id is not None, "group_id": r.group_id,
        "is_default": bool(r.is_default), "mention": None if r.is_default else mention_key(r.name),
        "created_at": r.created_at, "updated_at": r.updated_at,
    }
    if member_count is not None:
        out["member_count"] = member_count
    return out


async def get_or_create_everyone(db: AsyncSession) -> ChatRole:
    """@everyone 행. 운영(PG)은 init_db 가 만든다 — 없으면(테스트·SQLite) 여기서 만든다."""
    ev = await P.everyone_role(db)
    if ev is None:
        ev = ChatRole(id=str(uuid.uuid4()), name="everyone", position=0, permissions=P.DEFAULT_EVERYONE,
                      is_default=True, hoist=False, mentionable=False)
        db.add(ev)
        await db.commit()
        await db.refresh(ev)
    return ev


async def _audit(db: AsyncSession, user, action: str, rtype: str, rid: str | None, details: dict) -> None:
    from app.admin.audit import log_action
    await log_action(db, str(user.id), f"chat.{action}", rtype, rid, details)


async def actor_top(db: AsyncSession, user) -> int:
    """계층 비교용 내 높이. 전역 관리자·ADMINISTRATOR = 무한대."""
    if getattr(user, "is_admin", False):
        return INF
    ws = await P.workspace_permissions(db, user)
    if ws & P.ADMINISTRATOR:
        return INF
    roles = await P.user_role_rows(db, str(user.id))
    return max((r.position or 0 for r in roles), default=0)


async def _ws_perms(db: AsyncSession, user) -> int:
    return await P.workspace_permissions(db, user)


async def require_ws(db: AsyncSession, user, bit: int) -> int:
    """워크스페이스 범위 비트가 있어야 한다. 내 실효 비트를 돌려준다(부여 제한 검사용)."""
    perms = await _ws_perms(db, user)
    if not perms & bit:
        raise HTTPException(403, "권한이 없습니다")
    return perms


async def require_channel(db: AsyncSession, user, ch: Channel, bit: int) -> int:
    """채널 일 — 워크스페이스 비트 또는 그 채널의 실효 비트. 내 비트(둘의 합)를 돌려준다."""
    ws = await _ws_perms(db, user)
    if ws & (bit | P.ADMINISTRATOR):
        return ws if not ws & P.ADMINISTRATOR else P.ALL_PERMISSIONS
    chp = await P.effective_permissions(db, user, ch)
    if not chp & bit:
        raise HTTPException(403, "권한이 없습니다")
    return chp | ws


def _check_grant(granted: int, holder: int, user) -> None:
    if getattr(user, "is_admin", False) or holder & P.ADMINISTRATOR:
        return
    extra = granted & ~holder
    if extra:
        raise HTTPException(403, f"내가 가진 권한만 줄 수 있습니다: {', '.join(P.names_of(extra))}")


async def _role_or_404(db: AsyncSession, role_id: str) -> ChatRole:
    r = await db.get(ChatRole, role_id)
    if r is None:
        if role_id == "everyone":
            return await get_or_create_everyone(db)
        raise HTTPException(404, "역할을 찾을 수 없습니다")
    return r


async def _below_me(db: AsyncSession, user, role: ChatRole) -> None:
    if role.is_default:
        return   # @everyone 은 MANAGE_ROLES 가 있으면 누구나 편집(디스코드와 같다)
    if (role.position or 0) >= await actor_top(db, user):
        raise HTTPException(403, "내 최고 역할보다 낮은 역할만 다룰 수 있습니다")


async def _check_name(db: AsyncSession, name: str, exclude_id: str | None = None) -> str:
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "이름이 비었습니다")
    key = mention_key(name)
    if key in RESERVED_NAMES:
        raise HTTPException(400, "예약된 이름입니다")
    for r in (await db.execute(select(ChatRole).where(ChatRole.is_default == False))).scalars():  # noqa: E712
        if r.id != exclude_id and mention_key(r.name) == key:
            raise HTTPException(409, "같은 이름(멘션)의 역할이 있습니다")
    return name


def _check_color(color: str | None) -> str | None:
    if color is None or color == "":
        return None
    if color not in P.ROLE_COLOR_TOKENS:
        raise HTTPException(400, f"색은 팔레트 토큰만: {', '.join(P.ROLE_COLOR_TOKENS)}")
    return color


async def _check_group(db: AsyncSession, group_id: str | None) -> str | None:
    if not group_id:
        return None
    from app.groups.models import Group
    if await db.get(Group, group_id) is None:
        raise HTTPException(404, "그룹을 찾을 수 없습니다")
    taken = (await db.execute(select(ChatRole.id).where(ChatRole.group_id == group_id))).scalar_one_or_none()
    if taken:
        raise HTTPException(409, "이미 이 그룹과 연동된 역할이 있습니다")
    return group_id


async def role_member_ids(db: AsyncSession, role: ChatRole) -> list[str]:
    if role.group_id:
        from app.groups.models import GroupMember
        return list((await db.execute(
            select(GroupMember.user_id).where(GroupMember.group_id == role.group_id)
        )).scalars().all())
    return list((await db.execute(
        select(ChatMemberRole.user_id).where(ChatMemberRole.role_id == role.id)
    )).scalars().all())


async def _member_counts(db: AsyncSession, roles: list[ChatRole]) -> dict[str, int]:
    direct = dict((await db.execute(
        select(ChatMemberRole.role_id, func.count(ChatMemberRole.id)).group_by(ChatMemberRole.role_id)
    )).all())
    out: dict[str, int] = {}
    group_ids = [r.group_id for r in roles if r.group_id]
    by_group: dict[str, int] = {}
    if group_ids:
        from app.groups.models import GroupMember
        by_group = dict((await db.execute(
            select(GroupMember.group_id, func.count(GroupMember.id))
            .where(GroupMember.group_id.in_(group_ids)).group_by(GroupMember.group_id)
        )).all())
    total_users = None
    for r in roles:
        if r.is_default:
            if total_users is None:
                total_users = (await db.execute(
                    select(func.count(User.id)).where(User.is_active == True)  # noqa: E712
                )).scalar_one()
            out[r.id] = int(total_users)
        elif r.group_id:
            out[r.id] = int(by_group.get(r.group_id, 0))
        else:
            out[r.id] = int(direct.get(r.id, 0))
    return out


# ─── 스키마 ───

PermValue = list[str] | int | None


class RoleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    color: str | None = Field(None, max_length=32)
    icon: str | None = Field(None, max_length=64)
    hoist: bool = False
    mentionable: bool = False
    permissions: PermValue = None
    group_id: str | None = None


class RolePatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    color: str | None = Field(None, max_length=32)
    icon: str | None = Field(None, max_length=64)
    hoist: bool | None = None
    mentionable: bool | None = None
    permissions: PermValue = None
    group_id: str | None = None


class RoleOrder(BaseModel):
    role_ids: list[str]   # 위(높음) → 아래. @everyone 은 넣지 않는다


class UserRoles(BaseModel):
    role_ids: list[str]


class SyncGroups(BaseModel):
    group_ids: list[str] | None = None   # 비우면 아직 역할이 없는 그룹 전부


class OverwriteBody(BaseModel):
    allow: PermValue = 0
    deny: PermValue = 0


class CategoryCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    position: int | None = None


class CategoryPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    position: int | None = None


class LayoutCategory(BaseModel):
    id: str
    position: int


class LayoutChannel(BaseModel):
    id: str
    category_id: str | None = None
    position: int | None = None


class LayoutBody(BaseModel):
    categories: list[LayoutCategory] = []
    channels: list[LayoutChannel] = []


# ─── 권한 목록 · 실효 권한 ───

@router.get("/permissions/catalog")
async def permissions_catalog(user: User = Depends(get_current_user)):
    """권한 비트표(이름·값·묶음·위험) · @everyone 기본값 · 색 토큰 · 엔진 모드."""
    return {
        "permissions": [{"name": n, "value": v, "dangerous": bool(v & P.DANGEROUS)} for n, v in P.PERMISSIONS.items()],
        "groups": P.GROUPS,
        "default_everyone": P.DEFAULT_EVERYONE,
        "channel_role_implicit": P.CHANNEL_ROLE_IMPLICIT,
        "color_tokens": list(P.ROLE_COLOR_TOKENS),
        "mode": P.engine_mode(),
    }


def _perm_payload(bits: int) -> dict:
    return {"permissions": bits, "permission_names": P.names_of(bits)}


@router.get("/channels/{channel_id}/permissions/me")
async def my_channel_permissions(
    channel_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    ch = await db.get(Channel, channel_id)
    if ch is None:
        raise HTTPException(404, "채널을 찾을 수 없습니다")
    bits = await P.effective_permissions(db, user, ch)
    role = (await db.execute(select(ChannelMember.role).where(
        ChannelMember.channel_id == channel_id, ChannelMember.user_id == user.id))).scalar_one_or_none()
    return {"channel_id": channel_id, "user_id": user.id, "channel_role": role, "mode": P.engine_mode(),
            **_perm_payload(bits)}


@router.get("/permissions/effective")
async def effective_for(
    user_id: str = Query(...), channel_id: str | None = Query(None),
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    """(사용자, 채널)의 실효 권한. 남의 것은 전역 관리자 또는 MANAGE_ROLES."""
    if user_id != user.id and not user.is_admin:
        await require_ws(db, user, P.MANAGE_ROLES)
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    ch = None
    if channel_id:
        ch = await db.get(Channel, channel_id)
        if ch is None:
            raise HTTPException(404, "채널을 찾을 수 없습니다")
    bits = await P.effective_permissions(db, target, ch) if ch else await P.workspace_permissions(db, target)
    return {"user_id": user_id, "channel_id": channel_id, "mode": P.engine_mode(), **_perm_payload(bits)}


@router.get("/permissions/shadow-stats")
async def shadow_stats(
    days: int = Query(7, ge=1, le=40), user: User = Depends(get_current_user),
):
    """그림자 모드 불일치 집계(전환 판단용) — 전역 관리자만."""
    if not user.is_admin:
        raise HTTPException(403, "관리자만 볼 수 있습니다")
    return await P.shadow_stats(days)


# ─── 역할 CRUD ───

@router.get("/roles")
async def list_roles(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await get_or_create_everyone(db)
    roles = list((await db.execute(
        select(ChatRole).order_by(ChatRole.position.desc(), ChatRole.created_at)
    )).scalars().all())
    counts = await _member_counts(db, roles)
    return {"items": [role_dict(r, counts.get(r.id, 0)) for r in roles]}


@router.post("/roles", status_code=201)
async def create_role(body: RoleCreate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    holder = P.ALL_PERMISSIONS if user.is_admin else await require_ws(db, user, P.MANAGE_ROLES)
    bits = _bits(body.permissions, "permissions")
    _check_grant(bits, holder, user)
    name = await _check_name(db, body.name)
    group_id = await _check_group(db, body.group_id)
    await get_or_create_everyone(db)
    # 새 역할은 @everyone 바로 위(position 1) — 나머지를 한 칸씩 올린다(디스코드와 같다)
    await db.execute(update(ChatRole).where(ChatRole.is_default == False).values(position=ChatRole.position + 1))  # noqa: E712
    r = ChatRole(id=str(uuid.uuid4()), name=name, color=_check_color(body.color), icon=body.icon,
                 position=1, permissions=bits, hoist=body.hoist, mentionable=body.mentionable,
                 group_id=group_id, is_default=False)
    db.add(r)
    await db.commit()
    await db.refresh(r)
    await _audit(db, user, "role.create", "chat_role", r.id,
                 {"name": r.name, "permissions": P.names_of(bits), "group_id": group_id})
    return role_dict(r, 0)


@router.patch("/roles/{role_id}")
async def update_role(role_id: str, body: RolePatch, user: User = Depends(get_current_user),
                      db: AsyncSession = Depends(get_db)):
    holder = P.ALL_PERMISSIONS if user.is_admin else await require_ws(db, user, P.MANAGE_ROLES)
    r = await _role_or_404(db, role_id)
    await _below_me(db, user, r)
    fields = body.model_fields_set
    before = role_dict(r)
    if r.is_default and fields - {"permissions"}:
        raise HTTPException(400, "@everyone 은 권한만 바꿀 수 있습니다")
    if "name" in fields and body.name is not None:
        r.name = await _check_name(db, body.name, exclude_id=r.id)
    if "color" in fields:
        r.color = _check_color(body.color)
    if "icon" in fields:
        r.icon = body.icon or None
    if "hoist" in fields and body.hoist is not None:
        r.hoist = body.hoist
    if "mentionable" in fields and body.mentionable is not None:
        r.mentionable = body.mentionable
    if "permissions" in fields:
        bits = _bits(body.permissions, "permissions")
        # 바뀌는 비트만 검사 — 내가 없는 비트가 이미 켜져 있어도 다른 걸 고칠 수는 있다
        _check_grant(bits ^ int(r.permissions or 0), holder, user)
        r.permissions = bits
    if "group_id" in fields:
        if body.group_id != r.group_id:
            r.group_id = await _check_group(db, body.group_id)
            if r.group_id:   # 관리되는 역할로 바꾸면 직접 부여 행은 의미가 없다
                await db.execute(delete(ChatMemberRole).where(ChatMemberRole.role_id == r.id))
    r.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(r)
    after = role_dict(r)
    changed = {k: {"from": before[k], "to": after[k]} for k in
               ("name", "color", "icon", "hoist", "mentionable", "permission_names", "group_id")
               if before[k] != after[k]}
    if changed:
        await _audit(db, user, "role.update", "chat_role", r.id, {"name": r.name, "changes": changed})
    return after


@router.delete("/roles/{role_id}")
async def delete_role(role_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if not user.is_admin:
        await require_ws(db, user, P.MANAGE_ROLES)
    r = await _role_or_404(db, role_id)
    if r.is_default:
        raise HTTPException(400, "@everyone 은 지울 수 없습니다")
    await _below_me(db, user, r)
    name = r.name
    await db.execute(delete(ChatMemberRole).where(ChatMemberRole.role_id == r.id))
    await db.execute(delete(ChatPermissionOverwrite).where(
        ChatPermissionOverwrite.subject_kind == "role", ChatPermissionOverwrite.subject_id == r.id))
    await db.delete(r)
    await db.commit()
    await _audit(db, user, "role.delete", "chat_role", role_id, {"name": name})
    return {"ok": True}


@router.put("/roles/order")
async def reorder_roles(body: RoleOrder, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """역할 순서 일괄(위 → 아래). 목록에 없는 역할은 그 아래에 지금 순서대로 붙는다."""
    if not user.is_admin:
        await require_ws(db, user, P.MANAGE_ROLES)
    roles = list((await db.execute(
        select(ChatRole).where(ChatRole.is_default == False).order_by(ChatRole.position.desc())  # noqa: E712
    )).scalars().all())
    by_id = {r.id: r for r in roles}
    if len(set(body.role_ids)) != len(body.role_ids) or any(i not in by_id for i in body.role_ids):
        raise HTTPException(400, "역할 목록이 올바르지 않습니다")
    ordered = [by_id[i] for i in body.role_ids] + [r for r in roles if r.id not in set(body.role_ids)]
    top = await actor_top(db, user)
    new_pos = {r.id: len(ordered) - i for i, r in enumerate(ordered)}
    for r in ordered:
        old = r.position or 0
        if new_pos[r.id] != old and (old >= top or new_pos[r.id] >= top):
            raise HTTPException(403, "내 최고 역할보다 낮은 역할만 옮길 수 있습니다")
    for r in ordered:
        r.position = new_pos[r.id]
    await db.commit()
    await _audit(db, user, "role.reorder", "chat_role", None, {"order": [r.id for r in ordered]})
    return {"items": [role_dict(r) for r in ordered]}


# ─── 역할 부여 ───

@router.get("/roles/{role_id}/members")
async def list_role_members(role_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    r = await _role_or_404(db, role_id)
    if r.is_default:
        raise HTTPException(400, "@everyone 은 전원입니다")
    ids = await role_member_ids(db, r)
    users = (await db.execute(select(User).where(User.id.in_(ids)))).scalars().all() if ids else []
    return {"items": [{"user_id": u.id, "username": u.username, "display_name": u.display_name,
                       "avatar_url": u.avatar_url} for u in users], "managed": r.group_id is not None}


async def _assign(db: AsyncSession, user, r: ChatRole, target_id: str, add: bool) -> bool:
    if r.is_default:
        raise HTTPException(400, "@everyone 은 부여·해제할 수 없습니다")
    if r.group_id:
        raise HTTPException(409, "그룹과 연동된 역할입니다 — 그룹 멤버십을 바꾸세요")
    await _below_me(db, user, r)
    if await db.get(User, target_id) is None:
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    row = (await db.execute(select(ChatMemberRole).where(
        ChatMemberRole.role_id == r.id, ChatMemberRole.user_id == target_id))).scalar_one_or_none()
    if add and row is None:
        db.add(ChatMemberRole(id=str(uuid.uuid4()), role_id=r.id, user_id=target_id))
        return True
    if not add and row is not None:
        await db.delete(row)
        return True
    return False


@router.put("/roles/{role_id}/members/{target_user_id}")
async def assign_role(role_id: str, target_user_id: str, user: User = Depends(get_current_user),
                      db: AsyncSession = Depends(get_db)):
    if not user.is_admin:
        await require_ws(db, user, P.MANAGE_ROLES)
    r = await _role_or_404(db, role_id)
    changed = await _assign(db, user, r, target_user_id, True)
    await db.commit()
    if changed:
        await _audit(db, user, "role.assign", "chat_role", r.id, {"user_id": target_user_id, "name": r.name})
    return {"ok": True, "changed": changed}


@router.delete("/roles/{role_id}/members/{target_user_id}")
async def unassign_role(role_id: str, target_user_id: str, user: User = Depends(get_current_user),
                        db: AsyncSession = Depends(get_db)):
    if not user.is_admin:
        await require_ws(db, user, P.MANAGE_ROLES)
    r = await _role_or_404(db, role_id)
    changed = await _assign(db, user, r, target_user_id, False)
    await db.commit()
    if changed:
        await _audit(db, user, "role.unassign", "chat_role", r.id, {"user_id": target_user_id, "name": r.name})
    return {"ok": True, "changed": changed}


@router.get("/users/{target_user_id}/roles")
async def get_user_roles(target_user_id: str, user: User = Depends(get_current_user),
                         db: AsyncSession = Depends(get_db)):
    roles = await P.user_role_rows(db, target_user_id)
    return {"items": [role_dict(r) for r in roles]}


@router.put("/users/{target_user_id}/roles")
async def set_user_roles(target_user_id: str, body: UserRoles, user: User = Depends(get_current_user),
                         db: AsyncSession = Depends(get_db)):
    """직접 부여 역할을 이 목록으로 맞춘다(관리되는 역할은 건드리지 않음 — 넣으면 409)."""
    if not user.is_admin:
        await require_ws(db, user, P.MANAGE_ROLES)
    want = set(body.role_ids)
    have = set((await db.execute(select(ChatMemberRole.role_id).where(
        ChatMemberRole.user_id == target_user_id))).scalars().all())
    added, removed = [], []
    for rid in want - have:
        r = await _role_or_404(db, rid)
        if await _assign(db, user, r, target_user_id, True):
            added.append(r.id)
    for rid in have - want:
        r = await db.get(ChatRole, rid)
        if r is not None and await _assign(db, user, r, target_user_id, False):
            removed.append(r.id)
    await db.commit()
    if added or removed:
        await _audit(db, user, "role.set_user", "user", target_user_id, {"added": added, "removed": removed})
    roles = await P.user_role_rows(db, target_user_id)
    return {"items": [role_dict(r) for r in roles], "added": added, "removed": removed}


@router.post("/roles/sync-groups")
async def sync_groups(body: SyncGroups, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """워크스페이스 그룹 → 관리되는 역할(권한 0, 색 없음). 이미 연동된 그룹은 건너뛴다.

    멤버는 따로 복사하지 않는다 — 계산 때 group_members 를 직접 본다(이중 관리 없음).
    """
    if not user.is_admin:
        await require_ws(db, user, P.MANAGE_ROLES)
    from app.groups.models import Group
    q = select(Group)
    if body.group_ids:
        q = q.where(Group.id.in_(body.group_ids))
    groups = (await db.execute(q)).scalars().all()
    linked = set((await db.execute(select(ChatRole.group_id).where(ChatRole.group_id.is_not(None)))).scalars().all())
    await get_or_create_everyone(db)
    created = []
    for g in groups:
        if g.id in linked:
            continue
        name = g.name
        key = mention_key(name)
        exists = any(mention_key(r.name) == key for r in (await db.execute(
            select(ChatRole).where(ChatRole.is_default == False))).scalars())  # noqa: E712
        if exists or key in RESERVED_NAMES:
            name = f"{g.name} (그룹)"
        await db.execute(update(ChatRole).where(ChatRole.is_default == False).values(position=ChatRole.position + 1))  # noqa: E712
        r = ChatRole(id=str(uuid.uuid4()), name=name[:100], position=1, permissions=0, group_id=g.id)
        db.add(r)
        await db.flush()
        created.append(r)
    await db.commit()
    for r in created:
        await _audit(db, user, "role.sync_group", "chat_role", r.id, {"name": r.name, "group_id": r.group_id})
    return {"created": [role_dict(r) for r in created]}


# ─── 덮어쓰기 ───

def _ow_dict(ow: ChatPermissionOverwrite) -> dict:
    return {"id": ow.id, "target_kind": ow.target_kind, "target_id": ow.target_id,
            "subject_kind": ow.subject_kind, "subject_id": ow.subject_id,
            "allow": int(ow.allow or 0), "deny": int(ow.deny or 0),
            "allow_names": P.names_of(int(ow.allow or 0)), "deny_names": P.names_of(int(ow.deny or 0))}


async def _list_ows(db: AsyncSession, kind: str, target_id: str) -> list[dict]:
    rows = (await db.execute(select(ChatPermissionOverwrite).where(
        ChatPermissionOverwrite.target_kind == kind, ChatPermissionOverwrite.target_id == target_id))).scalars()
    return [_ow_dict(o) for o in rows]


async def _resolve_subject(db: AsyncSession, subject_kind: str, subject_id: str) -> str:
    if subject_kind == "role":
        r = await _role_or_404(db, subject_id)
        return r.id
    if subject_kind == "user":
        if await db.get(User, subject_id) is None:
            raise HTTPException(404, "사용자를 찾을 수 없습니다")
        return subject_id
    raise HTTPException(400, "subject 는 role 또는 user")


async def _put_ow(db: AsyncSession, user, kind: str, target_id: str, subject_kind: str, subject_id: str,
                  body: OverwriteBody, holder: int) -> dict:
    allow = _bits(body.allow, "allow")
    deny = _bits(body.deny, "deny")
    if allow & deny:
        raise HTTPException(400, "같은 권한을 허용과 거부에 함께 둘 수 없습니다")
    sid = await _resolve_subject(db, subject_kind, subject_id)
    ow = (await db.execute(select(ChatPermissionOverwrite).where(
        ChatPermissionOverwrite.target_kind == kind, ChatPermissionOverwrite.target_id == target_id,
        ChatPermissionOverwrite.subject_kind == subject_kind, ChatPermissionOverwrite.subject_id == sid,
    ))).scalar_one_or_none()
    old_allow, old_deny = (int(ow.allow or 0), int(ow.deny or 0)) if ow else (0, 0)
    _check_grant((allow ^ old_allow) | (deny ^ old_deny), holder, user)
    if ow is None:
        ow = ChatPermissionOverwrite(id=str(uuid.uuid4()), target_kind=kind, target_id=target_id,
                                     subject_kind=subject_kind, subject_id=sid)
        db.add(ow)
    ow.allow, ow.deny = allow, deny
    await db.commit()
    await db.refresh(ow)
    await _audit(db, user, f"{kind}.permission", kind, target_id, {
        "subject_kind": subject_kind, "subject_id": sid,
        "allow": P.names_of(allow), "deny": P.names_of(deny),
        "prev_allow": P.names_of(old_allow), "prev_deny": P.names_of(old_deny),
    })
    return _ow_dict(ow)


async def _del_ow(db: AsyncSession, user, kind: str, target_id: str, subject_kind: str, subject_id: str) -> dict:
    if subject_kind == "role" and subject_id == "everyone":
        ev = await get_or_create_everyone(db)
        subject_id = ev.id
    res = await db.execute(delete(ChatPermissionOverwrite).where(
        ChatPermissionOverwrite.target_kind == kind, ChatPermissionOverwrite.target_id == target_id,
        ChatPermissionOverwrite.subject_kind == subject_kind, ChatPermissionOverwrite.subject_id == subject_id))
    await db.commit()
    if res.rowcount:
        await _audit(db, user, f"{kind}.permission_delete", kind, target_id,
                     {"subject_kind": subject_kind, "subject_id": subject_id})
    return {"ok": True, "deleted": bool(res.rowcount)}


async def _channel_for_perms(db: AsyncSession, channel_id: str) -> Channel:
    ch = await db.get(Channel, channel_id)
    if ch is None:
        raise HTTPException(404, "채널을 찾을 수 없습니다")
    if ch.type == "dm":
        raise HTTPException(400, "1:1 대화에는 권한 덮어쓰기가 없습니다")
    return ch


async def _channel_holder(db: AsyncSession, user, ch: Channel) -> int:
    if user.is_admin:
        return P.ALL_PERMISSIONS
    return await require_channel(db, user, ch, P.MANAGE_ROLES)


@router.get("/channels/{channel_id}/permissions")
async def list_channel_overwrites(channel_id: str, user: User = Depends(get_current_user),
                                  db: AsyncSession = Depends(get_db)):
    ch = await _channel_for_perms(db, channel_id)
    await _channel_holder(db, user, ch)
    cat = await _list_ows(db, "category", ch.category_id) if ch.category_id else []
    return {"channel_id": ch.id, "category_id": ch.category_id,
            "overwrites": await _list_ows(db, "channel", ch.id), "category_overwrites": cat}


@router.put("/channels/{channel_id}/permissions/{subject_kind}/{subject_id}")
async def put_channel_overwrite(channel_id: str, subject_kind: str, subject_id: str, body: OverwriteBody,
                                user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    ch = await _channel_for_perms(db, channel_id)
    holder = await _channel_holder(db, user, ch)
    return await _put_ow(db, user, "channel", ch.id, subject_kind, subject_id, body, holder)


@router.delete("/channels/{channel_id}/permissions/{subject_kind}/{subject_id}")
async def delete_channel_overwrite(channel_id: str, subject_kind: str, subject_id: str,
                                   user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    ch = await _channel_for_perms(db, channel_id)
    await _channel_holder(db, user, ch)
    return await _del_ow(db, user, "channel", ch.id, subject_kind, subject_id)


async def _category_or_404(db: AsyncSession, category_id: str) -> ChatCategory:
    c = await db.get(ChatCategory, category_id)
    if c is None:
        raise HTTPException(404, "카테고리를 찾을 수 없습니다")
    return c


async def _ws_holder(db: AsyncSession, user, bit: int) -> int:
    if user.is_admin:
        return P.ALL_PERMISSIONS
    return await require_ws(db, user, bit)


@router.get("/categories/{category_id}/permissions")
async def list_category_overwrites(category_id: str, user: User = Depends(get_current_user),
                                   db: AsyncSession = Depends(get_db)):
    c = await _category_or_404(db, category_id)
    await _ws_holder(db, user, P.MANAGE_ROLES)
    return {"category_id": c.id, "overwrites": await _list_ows(db, "category", c.id)}


@router.put("/categories/{category_id}/permissions/{subject_kind}/{subject_id}")
async def put_category_overwrite(category_id: str, subject_kind: str, subject_id: str, body: OverwriteBody,
                                 user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _category_or_404(db, category_id)
    holder = await _ws_holder(db, user, P.MANAGE_ROLES)
    return await _put_ow(db, user, "category", c.id, subject_kind, subject_id, body, holder)


@router.delete("/categories/{category_id}/permissions/{subject_kind}/{subject_id}")
async def delete_category_overwrite(category_id: str, subject_kind: str, subject_id: str,
                                    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    c = await _category_or_404(db, category_id)
    await _ws_holder(db, user, P.MANAGE_ROLES)
    return await _del_ow(db, user, "category", c.id, subject_kind, subject_id)


# ─── 카테고리 ───

def _cat_dict(c: ChatCategory, archive_id: str | None = None) -> dict:
    # system = 보관 시스템 카테고리(chat22, app/chat/archive22.py) — 이름만 바꿀 수 있고 삭제·순서 변경 불가
    return {"id": c.id, "name": c.name, "position": c.position or 0, "created_at": c.created_at,
            "system": bool(archive_id) and c.id == archive_id}


async def _archive_id(db: AsyncSession) -> str | None:
    from app.chat.archive22 import get_archive_category_id
    return await get_archive_category_id(db)


@router.get("/categories")
async def list_categories(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.chat.archive22 import ensure_archive_category
    arc = await ensure_archive_category(db)
    rows = (await db.execute(select(ChatCategory).order_by(ChatCategory.position, ChatCategory.created_at))).scalars()
    return {"items": [_cat_dict(c, arc) for c in rows]}


@router.post("/categories", status_code=201)
async def create_category(body: CategoryCreate, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    await _ws_holder(db, user, P.MANAGE_CHANNELS)
    pos = body.position
    if pos is None:
        pos = ((await db.execute(select(func.max(ChatCategory.position)))).scalar() or -1) + 1
    c = ChatCategory(id=str(uuid.uuid4()), name=body.name.strip(), position=pos, created_by=user.id)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    await _audit(db, user, "category.create", "chat_category", c.id, {"name": c.name})
    return _cat_dict(c, await _archive_id(db))


@router.patch("/categories/{category_id}")
async def update_category(category_id: str, body: CategoryPatch, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    await _ws_holder(db, user, P.MANAGE_CHANNELS)
    c = await _category_or_404(db, category_id)
    arc = await _archive_id(db)
    before = _cat_dict(c, arc)
    if body.name is not None:
        c.name = body.name.strip()
    if body.position is not None and c.id != arc:   # 시스템 카테고리 순서는 고정(무시)
        c.position = body.position
    await db.commit()
    await db.refresh(c)
    await _audit(db, user, "category.update", "chat_category", c.id,
                 {"from": {k: before[k] for k in ("name", "position")}, "to": {"name": c.name, "position": c.position}})
    return _cat_dict(c, arc)


@router.delete("/categories/{category_id}")
async def delete_category(category_id: str, user: User = Depends(get_current_user),
                          db: AsyncSession = Depends(get_db)):
    """채널은 지우지 않는다 — 카테고리 없음으로 옮기고, 그 카테고리의 덮어쓰기는 지운다."""
    await _ws_holder(db, user, P.MANAGE_CHANNELS)
    c = await _category_or_404(db, category_id)
    if c.id == await _archive_id(db):
        raise HTTPException(400, {"code": "system_category", "message": "보관 카테고리는 지울 수 없습니다"})
    name = c.name
    await db.execute(update(Channel).where(Channel.category_id == c.id).values(category_id=None))
    await db.execute(delete(ChatPermissionOverwrite).where(
        ChatPermissionOverwrite.target_kind == "category", ChatPermissionOverwrite.target_id == c.id))
    await db.delete(c)
    await db.commit()
    await _audit(db, user, "category.delete", "chat_category", category_id, {"name": name})
    return {"ok": True}


@router.patch("/layout")
async def update_layout(body: LayoutBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """카테고리 순서·채널의 카테고리/순서 일괄(드래그 정렬).

    카테고리 순서 = 워크스페이스 MANAGE_CHANNELS. 채널 옮기기 = 그 채널의 MANAGE_CHANNELS
    (채널 owner/admin 은 암묵 보유). DM 은 옮길 수 없다.
    """
    if body.categories:
        await _ws_holder(db, user, P.MANAGE_CHANNELS)
    cats: dict[str, ChatCategory] = {}
    for item in body.categories:
        cats[item.id] = await _category_or_404(db, item.id)
    for item in body.channels:
        if item.category_id and item.category_id not in cats:
            cats[item.category_id] = await _category_or_404(db, item.category_id)
    chans: list[tuple[Channel, LayoutChannel]] = []
    for item in body.channels:
        ch = await db.get(Channel, item.id)
        if ch is None:
            raise HTTPException(404, "채널을 찾을 수 없습니다")
        if ch.type == "dm":
            raise HTTPException(400, "1:1 대화는 카테고리에 넣을 수 없습니다")
        if not user.is_admin:
            await require_channel(db, user, ch, P.MANAGE_CHANNELS)
        chans.append((ch, item))
    arc = await _archive_id(db) if body.categories else None
    for item in body.categories:
        if item.id != arc:   # 시스템(보관) 카테고리 순서 변경은 무시 — 늘 DM 바로 위
            cats[item.id].position = item.position
    for ch, item in chans:
        ch.category_id = item.category_id
        ch.position = item.position
    await db.commit()
    if body.categories or body.channels:
        await _audit(db, user, "layout.update", "chat_layout", None, {
            "categories": [c.model_dump() for c in body.categories],
            "channels": [c.model_dump() for c in body.channels],
        })
    return {"ok": True}


# ─── 멤버 목록 역할별 묶음 ───

@router.get("/channels/{channel_id}/members/by-role")
async def members_by_role(channel_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """채널 멤버를 hoist 역할별로 묶는다(높은 역할 먼저, 사람은 자기 최고 hoist 역할 한 곳에만).

    hoist 역할이 없는 사람은 마지막 묶음(role=null). 온라인/오프라인 분리는 프런트가 presence 로 한다.
    사람마다 color = 색이 있는 최고 역할의 토큰, roles = 내 역할 id(높은 순).
    """
    ch = await db.get(Channel, channel_id)
    if ch is None:
        raise HTTPException(404, "채널을 찾을 수 없습니다")
    if not await P.allowed(db, user, "channel.view", ch):
        raise HTTPException(403, "채널 멤버가 아닙니다")
    from app.chat import service
    members = await service.get_channel_members(db, channel_id)
    ids = [m["user_id"] for m in members]
    roles = list((await db.execute(
        select(ChatRole).where(ChatRole.is_default == False).order_by(ChatRole.position.desc())  # noqa: E712
    )).scalars().all())
    holders: dict[str, set[str]] = {}
    if roles and ids:
        for rid, uid in (await db.execute(select(ChatMemberRole.role_id, ChatMemberRole.user_id).where(
                ChatMemberRole.user_id.in_(ids)))).all():
            holders.setdefault(rid, set()).add(uid)
        gids = {r.group_id: r.id for r in roles if r.group_id}
        if gids:
            from app.groups.models import GroupMember
            for gid, uid in (await db.execute(select(GroupMember.group_id, GroupMember.user_id).where(
                    GroupMember.group_id.in_(list(gids)), GroupMember.user_id.in_(ids)))).all():
                holders.setdefault(gids[gid], set()).add(uid)
    groups: list[dict] = []
    placed: set[str] = set()
    for m in members:
        mine = [r for r in roles if m["user_id"] in holders.get(r.id, set())]
        m["roles"] = [r.id for r in mine]
        m["color"] = next((r.color for r in mine if r.color), None)
    for r in roles:
        if not r.hoist:
            continue
        rows = [m for m in members if m["user_id"] not in placed and r.id in m["roles"]]
        placed |= {m["user_id"] for m in rows}
        if rows:
            groups.append({"role": role_dict(r), "members": rows})
    rest = [m for m in members if m["user_id"] not in placed]
    if rest:
        groups.append({"role": None, "members": rest})
    return {"groups": groups, "member_count": len(members)}


# ─── @역할 멘션 ───

async def resolve_role_mentions(
    db: AsyncSession, names: list[str], channel: Channel, sender_id: str,
) -> list[tuple[ChatRole, list[str]]]:
    """멘션 이름 중 역할을 찾아 (역할, 받을 채널 멤버 id) 목록. 보낸 사람은 뺀다.

    멘션 가능(mentionable) 역할만 — 아니면 보낸 사람에게 MENTION_EVERYONE 이 있어야 한다(디스코드와 같다).
    legacy 모드에서는 끈다(예전 동작 = 역할 없음).
    """
    if not names or P.engine_mode() == "legacy" or channel is None:
        return []
    wanted = {n.lower() for n in names}
    roles = [r for r in (await db.execute(select(ChatRole).where(ChatRole.is_default == False))).scalars()  # noqa: E712
             if mention_key(r.name) in wanted]
    if not roles:
        return []
    sender_bits: int | None = None
    member_ids = set((await db.execute(select(ChannelMember.user_id).where(
        ChannelMember.channel_id == channel.id))).scalars().all())
    out = []
    for r in roles:
        if not r.mentionable:
            if sender_bits is None:
                sender_bits = await P.effective_permissions(db, P.system_user(sender_id), channel)
            if not sender_bits & P.MENTION_EVERYONE:
                continue
        targets = [u for u in await role_member_ids(db, r) if u in member_ids and u != sender_id]
        out.append((r, targets))
    return out
