"""Wiki business logic — space/page CRUD, versioning, access control."""

import re
from datetime import datetime, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    User, WikiPage, WikiPageVersion, WikiSpace, WikiSpaceMember,
)


def _slugify(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text.lower().strip())
    return re.sub(r"[-\s]+", "-", s) or "untitled"


# ─── Space ───


async def get_spaces(db: AsyncSession, user_id: str) -> list[dict]:
    """Return all spaces the user can see (public + member of)."""
    result = await db.execute(
        select(WikiSpace, User.username, User.display_name, User.avatar_url)
        .outerjoin(User, WikiSpace.owner_id == User.id)
        .where(
            (WikiSpace.visibility == "public")
            | (WikiSpace.owner_id == user_id)
            | (WikiSpace.id.in_(
                select(WikiSpaceMember.space_id)
                .where(WikiSpaceMember.user_id == user_id)
            ))
        )
        .order_by(WikiSpace.name)
    )
    rows = result.all()
    spaces = []
    for space, username, display, avatar in rows:
        page_count = await db.scalar(
            select(func.count(WikiPage.id)).where(WikiPage.space_id == space.id)
        )
        spaces.append({
            "id": space.id,
            "name": space.name,
            "slug": space.slug,
            "description": space.description,
            "visibility": space.visibility,
            "icon": space.icon,
            "owner": {"id": space.owner_id, "username": username, "display_name": display, "avatar_url": avatar},
            "page_count": page_count or 0,
            "created_at": space.created_at.isoformat(),
            "updated_at": space.updated_at.isoformat(),
        })
    return spaces


async def get_space(db: AsyncSession, space_id: str) -> WikiSpace | None:
    return (await db.execute(
        select(WikiSpace).where(WikiSpace.id == space_id)
    )).scalar_one_or_none()


async def get_space_by_slug(db: AsyncSession, slug: str) -> WikiSpace | None:
    return (await db.execute(
        select(WikiSpace).where(WikiSpace.slug == slug)
    )).scalar_one_or_none()


async def create_space(db: AsyncSession, owner_id: str, **kwargs) -> dict:
    space = WikiSpace(owner_id=owner_id, **kwargs)
    db.add(space)
    await db.commit()
    await db.refresh(space)
    return {"id": space.id, "name": space.name, "slug": space.slug}


async def update_space(db: AsyncSession, space_id: str, **kwargs) -> bool:
    # 설명·아이콘은 null 로 비울 수 있다(이름·공개 범위의 null 은 "안 바꿈")
    data = {k: v for k, v in kwargs.items() if v is not None or k in ("description", "icon")}
    if not data:
        return True
    await db.execute(update(WikiSpace).where(WikiSpace.id == space_id).values(**data))
    await db.commit()
    return True


async def delete_space(db: AsyncSession, space_id: str) -> bool:
    await db.execute(delete(WikiSpace).where(WikiSpace.id == space_id))
    await db.commit()
    return True


# ─── Access control ───


async def get_user_role(db: AsyncSession, space_id: str, user_id: str) -> str | None:
    """Return user's role in a space. Owner gets 'admin'. None if no access."""
    space = await get_space(db, space_id)
    if not space:
        return None
    if space.owner_id == user_id:
        return "admin"
    member = (await db.execute(
        select(WikiSpaceMember).where(
            WikiSpaceMember.space_id == space_id,
            WikiSpaceMember.user_id == user_id,
        )
    )).scalar_one_or_none()
    if member:
        return member.role
    if space.visibility == "public":
        return "reader"
    return None


async def add_member(db: AsyncSession, space_id: str, user_id: str, role: str = "reader"):
    # 이미 멤버면 역할만 바꾼다(같은 사람을 또 넣으면 유일 제약으로 500 이 났다)
    existing = (await db.execute(
        select(WikiSpaceMember).where(
            WikiSpaceMember.space_id == space_id,
            WikiSpaceMember.user_id == user_id,
        )
    )).scalar_one_or_none()
    if existing:
        existing.role = role
    else:
        db.add(WikiSpaceMember(space_id=space_id, user_id=user_id, role=role))
    await db.commit()


async def update_member(db: AsyncSession, space_id: str, user_id: str, role: str) -> bool:
    """역할 바꾸기. 그런 멤버가 없으면 False."""
    result = await db.execute(
        update(WikiSpaceMember)
        .where(WikiSpaceMember.space_id == space_id, WikiSpaceMember.user_id == user_id)
        .values(role=role)
    )
    await db.commit()
    return bool(result.rowcount)


async def is_active_user(db: AsyncSession, user_id: str) -> bool:
    return bool(await db.scalar(
        select(User.id).where(User.id == user_id, User.is_active.is_(True))
    ))


async def get_space_owner(db: AsyncSession, space: WikiSpace) -> dict:
    """소유자 표시 정보(목록 get_spaces 의 owner 와 같은 모양)."""
    row = (await db.execute(
        select(User.username, User.display_name, User.avatar_url).where(User.id == space.owner_id)
    )).first()
    username, display, avatar = row if row else (None, None, None)
    return {"id": space.owner_id, "username": username, "display_name": display, "avatar_url": avatar}


async def remove_member(db: AsyncSession, space_id: str, user_id: str):
    await db.execute(
        delete(WikiSpaceMember)
        .where(WikiSpaceMember.space_id == space_id, WikiSpaceMember.user_id == user_id)
    )
    await db.commit()


async def get_members(db: AsyncSession, space_id: str) -> list[dict]:
    result = await db.execute(
        select(WikiSpaceMember, User.username, User.display_name, User.avatar_url)
        .outerjoin(User, WikiSpaceMember.user_id == User.id)
        .where(WikiSpaceMember.space_id == space_id)
    )
    return [
        {
            "user_id": m.user_id,
            "role": m.role,
            "username": username,
            "display_name": display,
            "avatar_url": avatar,
        }
        for m, username, display, avatar in result.all()
    ]


# ─── Pages ───


async def get_page_tree(db: AsyncSession, space_id: str) -> list[dict]:
    """Return flat list of pages for building a tree on the client."""
    result = await db.execute(
        select(WikiPage, User.username, User.display_name)
        .outerjoin(User, WikiPage.author_id == User.id)
        .where(WikiPage.space_id == space_id)
        .order_by(WikiPage.sort_order, WikiPage.title)
    )
    return [
        {
            "id": p.id,
            "parent_id": p.parent_id,
            "title": p.title,
            "slug": p.slug,
            "sort_order": p.sort_order,
            "is_pinned": p.is_pinned,
            "version": p.version,
            "author": {"username": username, "display_name": display},
            "updated_at": p.updated_at.isoformat(),
        }
        for p, username, display in result.all()
    ]


async def get_page(db: AsyncSession, page_id: str) -> dict | None:
    result = await db.execute(
        select(WikiPage, User.username, User.display_name, User.avatar_url)
        .outerjoin(User, WikiPage.author_id == User.id)
        .where(WikiPage.id == page_id)
    )
    row = result.first()
    if not row:
        return None
    p, username, display, avatar = row
    return {
        "id": p.id,
        "space_id": p.space_id,
        "parent_id": p.parent_id,
        "title": p.title,
        "slug": p.slug,
        "content": p.content,
        "sort_order": p.sort_order,
        "is_pinned": p.is_pinned,
        "version": p.version,
        "author": {"id": p.author_id, "username": username, "display_name": display, "avatar_url": avatar},
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
    }


class WikiMoveError(ValueError):
    """페이지를 자기 자신·자기 하위·다른 스페이스 아래로 두려 할 때."""


async def _check_parent_space(db: AsyncSession, space_id: str, parent_id: str | None) -> None:
    """부모는 같은 스페이스의 페이지여야 한다 — 아니면 트리 어디에도 안 보이는 페이지가 된다."""
    if not parent_id:
        return
    parent_space = (await db.execute(
        select(WikiPage.space_id).where(WikiPage.id == parent_id)
    )).scalar_one_or_none()
    if parent_space != space_id:
        raise WikiMoveError("같은 스페이스의 페이지 아래로만 둘 수 있습니다")


async def create_page(db: AsyncSession, space_id: str, author_id: str, **kwargs) -> dict:
    await _check_parent_space(db, space_id, kwargs.get("parent_id"))
    page = WikiPage(space_id=space_id, author_id=author_id, **kwargs)
    db.add(page)
    await db.commit()
    await db.refresh(page)
    # Save initial version
    v = WikiPageVersion(
        page_id=page.id,
        title=page.title,
        content=page.content,
        author_id=author_id,
        version_number=1,
    )
    db.add(v)
    await db.commit()
    return await get_page(db, page.id)


# 같은 사람이 이 시간 안에 연달아 저장하면 새 버전을 만들지 않고 직전 버전을 갱신한다
# (편집 화면이 몇 초마다 자동 저장하므로, 저장마다 버전을 쌓으면 기록이 금방 수백 개가 된다)
VERSION_COALESCE_SECONDS = 600


async def update_page(
    db: AsyncSession, page_id: str, editor_id: str, *, force_new_version: bool = False, **kwargs
) -> dict | None:
    """force_new_version: 10분 묶기 규칙을 건너뛰고 항상 새 버전을 만든다(버전 복원 —
    묶으면 직전 최신 버전을 복원 내용으로 덮어써 복원 전 본문이 기록에서 사라진다)."""
    data = {k: v for k, v in kwargs.items() if v is not None}
    # parent_id 는 null 이 "최상위로 옮기기" 라는 뜻이라 명시적으로 왔으면 남긴다
    move_to_root = "parent_id" in kwargs and kwargs["parent_id"] is None
    if move_to_root:
        data["parent_id"] = None
    if not data:
        return await get_page(db, page_id)

    # Get current page for versioning
    page = (await db.execute(
        select(WikiPage).where(WikiPage.id == page_id)
    )).scalar_one_or_none()
    if not page:
        return None

    # 순환 방지 — 새 부모가 자기 자신이거나 자기 하위면 거절
    new_parent = data.get("parent_id")
    if new_parent:
        await _check_parent_space(db, page.space_id, new_parent)
        cur = new_parent
        seen: set[str] = set()
        while cur and cur not in seen:
            if cur == page_id:
                raise WikiMoveError("자기 자신이나 하위 페이지 아래로는 옮길 수 없습니다")
            seen.add(cur)
            cur = (await db.execute(
                select(WikiPage.parent_id).where(WikiPage.id == cur)
            )).scalar_one_or_none()

    # 내용이 실제로 바뀐 경우만 버전 대상(같은 본문 재저장은 무시)
    content_changed = (
        ("content" in data and data["content"] != page.content)
        or ("title" in data and data["title"] != page.title)
    )

    # 직전 버전이 같은 작성자·최근이면 그 버전을 덮어쓴다
    last = None
    if content_changed:
        last = (await db.execute(
            select(WikiPageVersion)
            .where(WikiPageVersion.page_id == page_id)
            .order_by(WikiPageVersion.version_number.desc())
            .limit(1)
        )).scalar_one_or_none()
        if last is not None:
            created = last.created_at
            if created is not None and created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            recent = created is not None and (datetime.now(timezone.utc) - created).total_seconds() < VERSION_COALESCE_SECONDS
            # 첫 버전(생성 시점)은 원본으로 남긴다
            if force_new_version or not (last.author_id == editor_id and recent and last.version_number > 1
                                         and last.version_number == page.version):
                last = None
        if last is None:
            data["version"] = page.version + 1
        data["author_id"] = editor_id

    await db.execute(update(WikiPage).where(WikiPage.id == page_id).values(**data))
    await db.commit()

    # Save version snapshot
    if content_changed:
        await db.refresh(page)
        if last is not None:
            last.title = page.title
            last.content = page.content
        else:
            db.add(WikiPageVersion(
                page_id=page_id,
                title=page.title,
                content=page.content,
                author_id=editor_id,
                version_number=page.version,
            ))
        await db.commit()

    return await get_page(db, page_id)


async def delete_page(db: AsyncSession, page_id: str) -> bool:
    # Re-parent children to the deleted page's parent
    page = (await db.execute(
        select(WikiPage).where(WikiPage.id == page_id)
    )).scalar_one_or_none()
    if not page:
        return False
    await db.execute(
        update(WikiPage).where(WikiPage.parent_id == page_id).values(parent_id=page.parent_id)
    )
    await db.execute(delete(WikiPage).where(WikiPage.id == page_id))
    await db.commit()
    return True


async def get_page_versions(db: AsyncSession, page_id: str) -> list[dict]:
    result = await db.execute(
        select(WikiPageVersion, User.username, User.display_name)
        .outerjoin(User, WikiPageVersion.author_id == User.id)
        .where(WikiPageVersion.page_id == page_id)
        .order_by(WikiPageVersion.version_number.desc())
    )
    return [
        {
            "id": v.id,
            "version_number": v.version_number,
            "title": v.title,
            "content": v.content,
            "author": {"username": username, "display_name": display},
            "created_at": v.created_at.isoformat(),
        }
        for v, username, display in result.all()
    ]


async def restore_page_version(
    db: AsyncSession, page_id: str, version_number: int, editor_id: str
) -> dict | None:
    """Restore a page to an earlier version's content.

    Loads the target version and re-applies its title/content via update_page,
    which snapshots the current state and bumps to a new version number
    (non-destructive — the restore itself becomes the latest version)."""
    v = (await db.execute(
        select(WikiPageVersion).where(
            WikiPageVersion.page_id == page_id,
            WikiPageVersion.version_number == version_number,
        )
    )).scalar_one_or_none()
    if not v:
        return None
    return await update_page(db, page_id, editor_id, title=v.title, content=v.content, force_new_version=True)


async def search_pages(db: AsyncSession, space_id: str, query: str) -> list[dict]:
    """Simple ILIKE search on title and content."""
    pattern = f"%{query}%"
    result = await db.execute(
        select(WikiPage)
        .where(
            WikiPage.space_id == space_id,
            (WikiPage.title.ilike(pattern) | WikiPage.content.ilike(pattern)),
        )
        .order_by(WikiPage.updated_at.desc())
        .limit(50)
    )
    return [
        {
            "id": p.id,
            "title": p.title,
            "slug": p.slug,
            "parent_id": p.parent_id,
            "updated_at": p.updated_at.isoformat(),
        }
        for p in result.scalars().all()
    ]


# ─── 역링크 ───
#
# 본문 안 내부 링크 형식(어느 것이든 잡는다):
#   - 위키 화면 주소: /wiki?space=<id>&page=<id> (절대 URL·마크다운 링크·HTML href 모두)
#   - data-page-id="<id>" (편집기 노드)
#   - [[페이지 제목]] (같은 스페이스, 대소문자 무시)

_PAGE_PARAM_RE = re.compile(r"/wiki[^\s\"'<>)]*?[?&]page=([0-9a-fA-F-]{36})")
_DATA_ID_RE = re.compile(r"data-page-id=[\"']([0-9a-fA-F-]{36})[\"']")
_WIKILINK_RE = re.compile(r"\[\[([^\[\]|#]{1,500})(?:[|#][^\[\]]*)?\]\]")


def parse_internal_links(content: str) -> tuple[set[str], set[str]]:
    """본문 → (가리키는 페이지 id 들, [[제목]] 들(소문자))."""
    content = content or ""
    ids = {m.lower() for m in _PAGE_PARAM_RE.findall(content)}
    ids |= {m.lower() for m in _DATA_ID_RE.findall(content)}
    titles = {m.strip().lower() for m in _WIKILINK_RE.findall(content) if m.strip()}
    return ids, titles


def _snippet(content: str, needle: str, width: int = 60) -> str:
    text = re.sub(r"<[^>]+>", " ", content or "")
    i = text.lower().find(needle.lower())
    if i < 0:
        return text[: width * 2].strip()
    return text[max(0, i - width): i + len(needle) + width].strip()


async def get_backlinks(db: AsyncSession, page_id: str, user_id: str, is_admin: bool = False) -> list[dict]:
    """이 페이지를 가리키는 페이지 목록(읽을 수 있는 스페이스만, 최근 수정 순)."""
    target = await db.get(WikiPage, page_id)
    if not target:
        return []
    title_l = (target.title or "").strip().lower()
    esc = lambda s: s.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")  # noqa: E731
    conds = [WikiPage.content.ilike(f"%{esc(page_id)}%", escape="\\")]
    if title_l:
        conds.append(WikiPage.content.ilike(f"%[[{esc(target.title.strip())}%", escape="\\"))
    from sqlalchemy import or_
    rows = (await db.execute(
        select(WikiPage, WikiSpace.name)
        .join(WikiSpace, WikiSpace.id == WikiPage.space_id)
        .where(WikiPage.id != page_id, or_(*conds))
        .order_by(WikiPage.updated_at.desc())
        .limit(500)
    )).all()
    roles: dict[str, str | None] = {}
    out = []
    for p, space_name in rows:
        ids, titles = parse_internal_links(p.content)
        by_id = page_id.lower() in ids
        by_title = p.space_id == target.space_id and title_l and title_l in titles
        if not (by_id or by_title):
            continue
        if not is_admin:
            if p.space_id not in roles:
                roles[p.space_id] = await get_user_role(db, p.space_id, user_id)
            if roles[p.space_id] is None:
                continue
        out.append({
            "id": p.id,
            "title": p.title,
            "space_id": p.space_id,
            "space_name": space_name,
            "url": f"/wiki?space={p.space_id}&page={p.id}",
            "link_type": "id" if by_id else "title",
            "snippet": _snippet(p.content, page_id if by_id else f"[[{target.title}"),
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        })
    return out
