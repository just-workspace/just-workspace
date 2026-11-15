"""Contacts service — PostgreSQL CRUD (replaces JMAP)."""

import json

from sqlalchemy import select, and_, or_, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AddressBookDB, ContactDB


# ─── Address Book CRUD ───


async def get_address_books(db: AsyncSession, user_id: str) -> list[dict]:
    """Get all address books. Auto-creates a default one if none exist."""
    result = await db.execute(
        select(AddressBookDB)
        .where(AddressBookDB.user_id == user_id)
        .order_by(AddressBookDB.name)
    )
    books = [{"id": ab.id, "name": ab.name} for ab in result.scalars().all()]

    # Auto-create default address book if none exist
    if not books:
        default = await create_address_book(db, user_id, "내 연락처")
        books.append(default)

    return books


async def create_address_book(db: AsyncSession, user_id: str, name: str) -> dict:
    ab = AddressBookDB(user_id=user_id, name=name)
    db.add(ab)
    await db.commit()
    await db.refresh(ab)
    return {"id": ab.id, "name": ab.name}


async def delete_address_book(db: AsyncSession, user_id: str, book_id: str) -> bool:
    ab = await db.get(AddressBookDB, book_id)
    if not ab or ab.user_id != user_id:
        return False
    await db.delete(ab)
    await db.commit()
    return True


# ─── Contact CRUD ───


def _contact_to_dict(c: ContactDB) -> dict:
    return {
        "id": c.id,
        "address_book_id": c.address_book_id,
        "name": c.full_name,
        "first_name": c.given_name,
        "last_name": c.surname,
        "organization": c.organization,
        "emails": json.loads(c.emails) if c.emails else [],
        "phones": json.loads(c.phones) if c.phones else [],
        "addresses": json.loads(c.addresses) if c.addresses else [],
        "notes": c.notes,
        "created": c.created_at.isoformat() if c.created_at else None,
        "updated": c.updated_at.isoformat() if c.updated_at else None,
        "photo": c.photo,
        "is_favorite": bool(c.is_favorite),
        "groups": _groups(c.groups),
        "title": c.title,
    }


def _groups(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
        return [str(x) for x in v] if isinstance(v, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


PHOTO_MAX_CHARS = 700_000  # data URI 기준 약 512KB 이미지


def clean_photo(v: str | None) -> str | None:
    """data:image/*;base64,… 만 받는다(외부 URL 은 추적·SSRF 우려로 저장하지 않음)."""
    if not v:
        return None
    v = v.strip()
    if not v.startswith("data:image/") or ";base64," not in v:
        raise ValueError("사진은 data:image/...;base64, 형식이어야 합니다")
    if len(v) > PHOTO_MAX_CHARS:
        raise ValueError("사진이 너무 큽니다(최대 약 512KB)")
    return v


def clean_groups(groups: list[str] | None) -> str | None:
    if not groups:
        return None
    out = []
    for g in groups:
        g = str(g).strip()[:100]
        if g and g not in out:
            out.append(g)
    return json.dumps(out[:50], ensure_ascii=False) if out else None


async def get_contacts(
    db: AsyncSession, user_id: str,
    q: str | None = None, book_id: str | None = None,
    page: int = 0, limit: int = 50,
    favorite: bool | None = None, group: str | None = None,
) -> tuple[list[dict], int]:
    """Query contacts with optional search/filter. Returns (contacts, total)."""
    # Get user's address book IDs
    ab_result = await db.execute(
        select(AddressBookDB.id).where(AddressBookDB.user_id == user_id)
    )
    ab_ids = [row[0] for row in ab_result.all()]
    if not ab_ids:
        return [], 0

    conditions = [ContactDB.address_book_id.in_(ab_ids)]
    if book_id:
        conditions.append(ContactDB.address_book_id == book_id)
    if q:
        safe_q = q.replace('%', '\\%').replace('_', '\\_')
        pattern = f"%{safe_q}%"
        conditions.append(
            or_(
                ContactDB.full_name.ilike(pattern, escape='\\'),
                ContactDB.organization.ilike(pattern, escape='\\'),
                ContactDB.emails.ilike(pattern, escape='\\'),
            )
        )
    if favorite is not None:
        conditions.append(ContactDB.is_favorite == favorite)
    if group:
        # JSON 배열 문자열 안에서 정확히 그 이름("…") 을 찾는다
        g = json.dumps(group, ensure_ascii=False).replace('%', '\\%').replace('_', '\\_')
        conditions.append(ContactDB.groups.like(f"%{g}%", escape='\\'))

    where = and_(*conditions)

    # Total count
    count_result = await db.execute(select(func.count(ContactDB.id)).where(where))
    total = count_result.scalar() or 0

    # Fetch page
    result = await db.execute(
        select(ContactDB)
        .where(where)
        .order_by(ContactDB.full_name, ContactDB.id)   # id 2차 기준(동명이인 페이지 경계)
        .offset(page * limit)
        .limit(limit)
    )
    contacts = [_contact_to_dict(c) for c in result.scalars().all()]
    return contacts, total


async def get_contact(db: AsyncSession, user_id: str, contact_id: str) -> dict | None:
    contact = await db.get(ContactDB, contact_id)
    if not contact:
        return None
    # Verify ownership
    ab = await db.get(AddressBookDB, contact.address_book_id)
    if not ab or ab.user_id != user_id:
        return None
    return _contact_to_dict(contact)


async def create_contact(db: AsyncSession, user_id: str, data: dict) -> dict | None:
    # Verify address book ownership
    ab = await db.get(AddressBookDB, data["address_book_id"])
    if not ab or ab.user_id != user_id:
        return None

    contact = ContactDB(
        address_book_id=data["address_book_id"],
        full_name=data.get("name", ""),
        given_name=data.get("first_name") or None,
        surname=data.get("last_name") or None,
        organization=data.get("organization") or None,
        emails=json.dumps(data.get("emails", []), ensure_ascii=False) if data.get("emails") else None,
        phones=json.dumps(data.get("phones", []), ensure_ascii=False) if data.get("phones") else None,
        addresses=json.dumps(data.get("addresses", []), ensure_ascii=False) if data.get("addresses") else None,
        notes=data.get("notes") or None,
        photo=clean_photo(data.get("photo")),
        is_favorite=bool(data.get("is_favorite")),
        groups=clean_groups(data.get("groups")),
        title=data.get("title"),
    )
    db.add(contact)
    await db.commit()
    await db.refresh(contact)
    return _contact_to_dict(contact)


async def update_contact(
    db: AsyncSession, user_id: str, contact_id: str, data: dict
) -> bool:
    contact = await db.get(ContactDB, contact_id)
    if not contact:
        return False
    ab = await db.get(AddressBookDB, contact.address_book_id)
    if not ab or ab.user_id != user_id:
        return False

    if "name" in data and data["name"] is not None:
        contact.full_name = data["name"]
    # 비울 수 있는 칸 — 보낸 null·"" 은 "없음"
    if "first_name" in data:
        contact.given_name = data.get("first_name") or None
    if "last_name" in data:
        contact.surname = data.get("last_name") or None
    if "organization" in data:
        contact.organization = data.get("organization") or None
    if "emails" in data and data["emails"] is not None:
        contact.emails = json.dumps(data["emails"], ensure_ascii=False)
    if "phones" in data and data["phones"] is not None:
        contact.phones = json.dumps(data["phones"], ensure_ascii=False)
    if "addresses" in data and data["addresses"] is not None:
        contact.addresses = json.dumps(data["addresses"], ensure_ascii=False)
    if "notes" in data:
        contact.notes = data.get("notes") or None
    if "photo" in data:
        contact.photo = clean_photo(data.get("photo"))
    if "is_favorite" in data and data["is_favorite"] is not None:
        contact.is_favorite = bool(data["is_favorite"])
    if "groups" in data and data["groups"] is not None:
        contact.groups = clean_groups(data["groups"])
    if "title" in data:
        contact.title = data.get("title") or None
    if "address_book_id" in data and data["address_book_id"] is not None:
        # IDOR 방지 — 이동 대상 주소록이 본인 소유인지 검증
        new_ab = await db.get(AddressBookDB, data["address_book_id"])
        if not new_ab or new_ab.user_id != user_id:
            return False
        contact.address_book_id = data["address_book_id"]

    await db.commit()
    return True


async def delete_contact(db: AsyncSession, user_id: str, contact_id: str) -> bool:
    contact = await db.get(ContactDB, contact_id)
    if not contact:
        return False
    ab = await db.get(AddressBookDB, contact.address_book_id)
    if not ab or ab.user_id != user_id:
        return False
    await db.delete(contact)
    await db.commit()
    return True


async def list_groups(db: AsyncSession, user_id: str) -> list[dict]:
    """내 주소록들의 그룹 이름과 연락처 수."""
    res = await db.execute(
        select(ContactDB.groups)
        .join(AddressBookDB, AddressBookDB.id == ContactDB.address_book_id)
        .where(AddressBookDB.user_id == user_id, ContactDB.groups.isnot(None))
    )
    counts: dict[str, int] = {}
    for (raw,) in res.all():
        for g in _groups(raw):
            counts[g] = counts.get(g, 0) + 1
    return [{"name": k, "count": v} for k, v in sorted(counts.items())]


async def workspace_users(db: AsyncSession, q: str | None = None, limit: int = 100, offset: int = 0) -> tuple[list[dict], int]:
    """연락처 사이드바용 워크스페이스 사용자 목록(활성 사용자만, 공개해도 되는 필드만)."""
    from app.db.models import User
    cond = [User.is_active == True]  # noqa: E712
    if q:
        safe = q.replace('%', '\\%').replace('_', '\\_')
        pat = f"%{safe}%"
        cond.append(or_(
            User.username.ilike(pat, escape='\\'),
            User.display_name.ilike(pat, escape='\\'),
            User.email.ilike(pat, escape='\\'),
        ))
    total = (await db.execute(select(func.count(User.id)).where(*cond))).scalar() or 0
    rows = (await db.execute(
        select(User).where(*cond).order_by(User.display_name, User.username).offset(offset).limit(limit)
    )).scalars().all()
    out = []
    for u in rows:
        d = {
            "id": u.id,
            "username": u.username,
            "display_name": u.display_name or u.username,
            "email": u.email,
            "avatar_url": u.avatar_url,
        }
        # 사용자 프로필에 부서·직함·전화가 생기면 그대로 싣는다(다른 작업에서 추가 예정)
        for extra in ("department", "position", "job_title", "phone"):
            if hasattr(u, extra):
                d[extra] = getattr(u, extra)
        out.append(d)
    return out, total
