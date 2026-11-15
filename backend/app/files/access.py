"""파일 접근 권한 — 내 영역(my/·shared/·관리자 users/)과 공유받은 경로(shared-with-me/)를 한 규칙으로.

공유 권한 4단계("보기 · 댓글 · 편집 · 공동 소유"):

- view    보기 — 목록·미리보기·내려받기·댓글 읽기
- comment 댓글 — 위 + 댓글 쓰기
- edit    편집 — 위 + 내용 쓰기(업로드·덮어쓰기·새 폴더·오피스 저장)
- owner   공동 소유 — 위 + 이름 변경·이동·삭제(원 소유자 휴지통)·재공유·권한 변경

저장 위치는 언제나 원 소유자 영역(users/<owner_id>/..)이고, 공유받은 사람은
'shared-with-me/<share_id>/<하위경로>' 가상경로로 조작한다. 권한은 그 경로를 덮는(같거나 조상인)
나의 모든 공유(직접 + 내가 멤버인 채널) 중 가장 높은 것이다.

예전 행(role NULL)은 can_write 로 읽는다(편집/보기). can_write 는 role in (edit, owner) 로 늘 맞춘다.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import FileComment, FileShare, ShareLink, User
from app.files import activity as act
from app.files import service as fs

ROLES = ("view", "comment", "edit", "owner")
RANK = {r: i for i, r in enumerate(ROLES)}
SHARED_ROOT = "shared-with-me"
# 휴지통으로 간 항목의 공유·댓글을 잠시 옮겨 두는 가짜 경로 접두어('my/' 가 아니라 절대 열리지 않는다)
TRASH_PREFIX = "trash"

_NEED_LABEL = {"view": "보기", "comment": "댓글", "edit": "편집", "owner": "공동 소유"}


def share_role(s: FileShare) -> str:
    """행의 권한. role 이 비어 있으면(예전 행) can_write 로."""
    r = getattr(s, "role", None)
    if r in RANK:
        return r
    return "edit" if s.can_write else "view"


def normalize_role(role: str | None, can_write: bool | None = None) -> str:
    """요청 본문의 role(없으면 can_write) → 4단계 중 하나. 모르는 값은 400."""
    if role is None or role == "":
        return "edit" if can_write else "view"
    if role not in RANK:
        raise HTTPException(status_code=400, detail="권한은 view·comment·edit·owner 중 하나입니다")
    return role


def apply_role(s: FileShare, role: str) -> None:
    s.role = role
    s.can_write = role in ("edit", "owner")


def at_least(role: str | None, need: str) -> bool:
    return role is not None and RANK.get(role, -1) >= RANK[need]


def deny(need: str) -> HTTPException:
    return HTTPException(status_code=403, detail=f"권한이 없습니다({_NEED_LABEL[need]} 권한 이상 필요)")


def _covers(share_path: str, target: str) -> bool:
    share_path, target = share_path.strip("/"), target.strip("/")
    return target == share_path or target.startswith(share_path + "/")


def owner_real(owner_id: str, owner_vpath: str) -> Path:
    """소유자 'my/..' 가상경로 → 실제 경로(users/<owner_id>/rest). 트래버설·my 밖 경로 차단."""
    vp = (owner_vpath or "").strip("/")
    if not vp.startswith("my/"):
        # 'my' 통째·휴지통 가짜 경로(trash/..)·모르는 루트는 공유 경로로 열 수 없다
        raise HTTPException(status_code=404, detail="공유를 찾을 수 없습니다")
    rel = vp[len("my/"):]
    base = (fs.STORAGE_ROOT / "users" / owner_id).resolve()
    real = (base / rel).resolve()
    if not real.is_relative_to(base) or real == base:
        raise HTTPException(status_code=400, detail="잘못된 경로")
    return real


def shared_sub_real(s: FileShare, sub: str | None) -> Path:
    """공유 루트(소유자 경로) 아래 sub 경로. 공유 범위 밖으로 못 나간다."""
    base = owner_real(s.owner_id, s.file_path)
    sub = (sub or "").strip("/")
    if not sub:
        return base
    real = (base / sub).resolve()
    if not real.is_relative_to(base.resolve()):
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    if any(fs.is_hidden_name(part) for part in Path(sub).parts):   # 숨김 판정은 service 한 곳
        raise HTTPException(status_code=404, detail="Not found")
    return real


async def my_channel_ids(db: AsyncSession, user_id: str) -> list[str]:
    from app.db.models import ChannelMember
    return list((await db.execute(
        select(ChannelMember.channel_id).where(ChannelMember.user_id == user_id)
    )).scalars().all())


async def accessible_share(db: AsyncSession, share_id: str, user: User) -> FileShare | None:
    """받는 사람이 열 수 있는 공유 — 나에게 직접 공유했거나, 내가 멤버인 채널에 공유한 것(소유자 본인 제외)."""
    s = await db.get(FileShare, share_id)
    if s is None or s.owner_id == user.id:
        return None
    if s.shared_with_user_id and s.shared_with_user_id == user.id:
        return s
    if s.shared_with_channel_id:
        from app.chat import service as chat_service
        if await chat_service.is_channel_member(db, s.shared_with_channel_id, user.id):
            return s
    return None


async def role_on(db: AsyncSession, user: User, owner_id: str, owner_vpath: str) -> tuple[str | None, FileShare | None]:
    """owner 의 'my/..' 경로에 대한 user 의 권한. 본인이면 owner. 덮는 공유가 없으면 (None, None)."""
    if user.id == owner_id:
        return "owner", None
    chans = await my_channel_ids(db, user.id)
    cond = FileShare.shared_with_user_id == user.id
    if chans:
        cond = or_(cond, FileShare.shared_with_channel_id.in_(chans))
    rows = (await db.execute(
        select(FileShare).where(FileShare.owner_id == owner_id, cond)
    )).scalars().all()
    best: tuple[str | None, FileShare | None] = (None, None)
    for s in rows:
        if not _covers(s.file_path, owner_vpath):
            continue
        r = share_role(s)
        if best[0] is None or RANK[r] > RANK[best[0]]:
            best = (r, s)
    return best


@dataclass
class Access:
    """가상경로 하나를 푼 결과."""
    vp: str                    # 요청 가상경로(정규화)
    real: Path                 # 실제 경로
    role: str                  # 이 경로에 대한 내 권한(내 영역은 owner)
    owner_id: str | None       # 저장 영역 주인(shared/ 팀 폴더는 None)
    owner_vpath: str | None    # 소유자 기준 'my/..'(댓글·공유 식별자). shared/ 는 None
    share: FileShare | None    # 공유 경로로 들어왔으면 그 공유(경로 해석 기준)
    key: str | None            # 활동 기록 정규 키

    @property
    def via_share(self) -> bool:
        return self.share is not None

    @property
    def owner_rel(self) -> str | None:
        """버전 스냅샷 상대경로(소유자 기준). my/ 아래가 아니면 None."""
        return fs.owner_relpath_from_my(self.owner_vpath) if self.owner_vpath else None


def parse_shared(vp: str) -> tuple[str, str] | None:
    """'shared-with-me/<sid>[/<sub>]' → (sid, sub). 아니면 None."""
    vp = vp.strip("/")
    if not vp.startswith(SHARED_ROOT + "/"):
        return None
    sid, _, sub = vp[len(SHARED_ROOT) + 1:].partition("/")
    if not sid:
        return None
    return sid, sub.strip("/")


async def resolve(db: AsyncSession, user: User, vp: str, need: str = "view") -> Access:
    """가상경로 → Access. 권한이 need 미만이면 403, 모르는 공유는 404."""
    vp = (vp or "").strip("/")
    parsed = parse_shared(vp)
    if parsed:
        sid, sub = parsed
        s = await accessible_share(db, sid, user)
        if not s:
            raise HTTPException(status_code=404, detail="공유를 찾을 수 없습니다")
        real = shared_sub_real(s, sub)
        owner_vpath = s.file_path.strip("/") + (f"/{sub}" if sub else "")
        role, _ = await role_on(db, user, s.owner_id, owner_vpath)
        role = role or share_role(s)
        if not at_least(role, need):
            raise deny(need)
        return Access(vp=vp, real=real, role=role, owner_id=s.owner_id, owner_vpath=owner_vpath,
                      share=s, key=act.owner_key(s.owner_id, owner_vpath))
    if vp == SHARED_ROOT:
        raise HTTPException(status_code=400, detail="공유받은 항목을 고르세요")
    try:
        real = fs.resolve_path(vp, user)
    except fs.PathSecurityError:
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    except fs.AccessDeniedError:
        raise HTTPException(status_code=403, detail="Access denied")
    owner_id: str | None = None
    owner_vpath: str | None = None
    if vp == "my" or vp.startswith("my/"):
        owner_id, owner_vpath = user.id, vp
    elif vp.startswith("users/"):          # 관리자 전체 사용자 보기
        parts = vp.split("/", 2)
        if len(parts) >= 2:
            owner_id = parts[1]
            owner_vpath = "my" + (f"/{parts[2]}" if len(parts) > 2 else "")
    return Access(vp=vp, real=real, role="owner", owner_id=owner_id, owner_vpath=owner_vpath,
                  share=None, key=act.canonical_key(vp, user))


# ─── 이름 변경·이동·삭제 뒤 공유·댓글 따라가기 ───


async def repoint(db: AsyncSession, owner_id: str | None, old_vp: str | None, new_vp: str | None) -> None:
    """owner 의 old_vp(와 그 아래)를 가리키던 공유·댓글을 new_vp 로 옮긴다.

    옮길 자리(new_vp 아래)에 남아 있던 옛 공유·댓글(같은 경로에 있다 지워진 항목 것)은 먼저 지운다 —
    안 그러면 고유 인덱스가 깨지고, 예전 수신자에게 새 파일이 열린다.
    """
    if not owner_id or not old_vp or not new_vp:
        return
    old_vp, new_vp = old_vp.strip("/"), new_vp.strip("/")
    if old_vp == new_vp:
        return
    for model in (FileShare, FileComment):
        await db.execute(delete(model).where(
            model.owner_id == owner_id,
            or_(model.file_path == new_vp, model.file_path.like(_like_prefix(new_vp), escape="\\")),
        ))
        rows = (await db.execute(select(model).where(
            model.owner_id == owner_id,
            or_(model.file_path == old_vp, model.file_path.like(_like_prefix(old_vp), escape="\\")),
        ))).scalars().all()
        for r in rows:
            r.file_path = new_vp + r.file_path[len(old_vp):]
    await db.commit()


async def purge(db: AsyncSession, owner_id: str | None, vp: str | None) -> None:
    """owner 의 vp(와 그 아래)에 걸린 공유·댓글을 지운다(영구 삭제)."""
    if not owner_id or not vp:
        return
    vp = vp.strip("/")
    for model in (FileShare, FileComment):
        await db.execute(delete(model).where(
            model.owner_id == owner_id,
            or_(model.file_path == vp, model.file_path.like(_like_prefix(vp), escape="\\")),
        ))
    await db.commit()


# ─── 공유 링크(ShareLink)도 따라간다 ───
#
# 링크는 만든 사람 기준 가상경로(my/.. 또는 shared/..)를 그대로 저장한다. 예전엔 이름을 바꾸거나 옮기면
# 링크가 죽고, 지운 뒤 같은 이름으로 새 파일을 올리면 **옛 링크로 새 파일이 열렸다**. 그래서 FileShare 와
# 같은 규칙으로 따라가게 한다. 휴지통에 있는 동안은 열리지 않는 가짜 경로(link_trash_key)로 옮겨 둔다.
#
# creator_id: my/.. 경로는 만든 사람이 곧 영역 주인이라 꼭 준다. shared/..·휴지통 키는 None(누가 만든 링크든).


def link_scope(a: "Access") -> tuple[str | None, str] | None:
    """Access → 링크가 저장한 (만든 사람, 경로). 링크를 걸 수 없는 경로면 None."""
    if a.owner_id and a.owner_vpath:
        return a.owner_id, a.owner_vpath.strip("/")
    if a.vp == "shared" or a.vp.startswith("shared/"):
        return None, a.vp
    return None


def vpath_link_scope(vp: str, user: User) -> tuple[str | None, str] | None:
    """사용자 가상경로(my/.., shared/.., 관리자 users/<id>/..) → (만든 사람, 링크 경로)."""
    vp = (vp or "").strip("/")
    if vp.startswith("my/"):
        return user.id, vp
    if vp.startswith("shared/"):
        return None, vp
    if vp.startswith("users/"):
        parts = vp.split("/", 2)
        if len(parts) == 3:
            return parts[1], "my/" + parts[2]
    return None


def link_trash_key(trash_owner: str, trash_name: str) -> str:
    return f"{TRASH_PREFIX}/{trash_owner}/{trash_name}"


def _under(path: str, base: str) -> bool:
    return path == base or path.startswith(base + "/")


def _link_path_list(link: ShareLink) -> tuple[list[str], bool]:
    """(경로들, 묶음 링크인가)."""
    import json
    if link.paths:
        try:
            v = json.loads(link.paths)
            if isinstance(v, list):
                return [str(x).strip("/") for x in v], True
        except ValueError:
            pass
    return [(link.file_path or "").strip("/")], False


async def _links_touching(db: AsyncSession, creator_id: str | None, *bases: str) -> list[ShareLink]:
    stmt = select(ShareLink)
    if creator_id:
        stmt = stmt.where(ShareLink.created_by == creator_id)
    rows = (await db.execute(stmt)).scalars().all()
    return [l for l in rows if any(_under(p, b) for p in _link_path_list(l)[0] for b in bases)]


async def repoint_links(db: AsyncSession, creator_id: str | None, old_vp: str | None, new_vp: str | None,
                        new_creator: str | None = None) -> None:
    """old_vp(와 그 아래)를 가리키던 링크를 new_vp 로. new_vp 아래에 남아 있던 옛 링크 경로는 지운다
    (같은 자리에 있다 사라진 항목 것 — 안 지우면 옛 링크로 새 파일이 열린다).

    new_vp 가 my/.. 인데 링크를 만든 사람이 그 영역 주인(new_creator)이 아니면 따라가지 않고 그 경로를 뺀다
    (my/ 는 만든 사람 영역으로 풀리므로 엉뚱한 사람 파일을 가리키게 된다). 경로가 하나도 안 남으면 링크를 지운다.
    """
    import json
    if not old_vp or not new_vp:
        return
    old_vp, new_vp = old_vp.strip("/"), new_vp.strip("/")
    if old_vp == new_vp:
        return
    to_my = new_vp.startswith("my/")
    # 같은 사람 영역 안(my→my, my→휴지통)이면 그 사람 링크만 읽는다. shared/ 가 끼면 누가 만든 링크든 본다.
    dest_owner = new_creator or creator_id
    same_area = bool(creator_id) and (new_vp.startswith(TRASH_PREFIX + "/") or (to_my and dest_owner == creator_id))
    for link in await _links_touching(db, creator_id if same_area else None, old_vp, new_vp):
        paths, multi = _link_path_list(link)
        out: list[str] = []
        changed = False
        for p in paths:
            if _under(p, old_vp) and (not creator_id or link.created_by == creator_id):
                changed = True
                if to_my and (new_creator or creator_id) != link.created_by:
                    continue
                out.append(new_vp + p[len(old_vp):])
            elif _under(p, new_vp) and (not to_my or link.created_by == (new_creator or creator_id)):
                changed = True              # 옮길 자리에 남아 있던 옛 경로
            else:
                out.append(p)
        if not changed:
            continue
        if not out:
            await db.delete(link)
            continue
        if not multi and out[0] != paths[0] and not out[0].startswith(TRASH_PREFIX + "/"):
            # 파일 하나짜리 링크의 표시 이름(= 받는 쪽 파일 이름)도 새 이름으로
            link.display_name = out[0].rsplit("/", 1)[-1][:255]
        link.file_path = out[0]
        if multi:
            link.paths = json.dumps(out, ensure_ascii=False)
    await db.commit()


async def purge_links(db: AsyncSession, creator_id: str | None, vp: str | None) -> None:
    """vp(와 그 아래)를 가리키는 링크 경로를 지운다(영구 삭제). 묶음 링크는 그 항목만 빼고, 다 빠지면 링크를 지운다."""
    import json
    if not vp:
        return
    vp = vp.strip("/")
    for link in await _links_touching(db, creator_id, vp):
        paths, multi = _link_path_list(link)
        out = [p for p in paths if not _under(p, vp)]
        if not out:
            await db.delete(link)
            continue
        link.file_path = out[0]
        if multi:
            link.paths = json.dumps(out, ensure_ascii=False)
    await db.commit()


def _like_prefix(vp: str) -> str:
    """LIKE 'vp/%' — 경로 속 %, _ 는 글자 그대로."""
    esc = vp.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return esc + "/%"


def trash_key(trash_name: str) -> str:
    return f"{TRASH_PREFIX}/{trash_name}"
