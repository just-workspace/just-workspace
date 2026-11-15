"""DAV-specific database queries."""

import hashlib
import json
from datetime import datetime

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.dav.ical_utils import event_to_ical
from app.db.models import (
    CalendarDB, CalendarEventDB,
    AddressBookDB, ContactDB, User,
)


# ── Helpers ──

# 직렬화 형식이 바뀌면 올린다 — ETag·ctag 가 한 번 전부 바뀌어 휴대폰이 다시 받아 간다.
# RRULE·EXDATE·RECURRENCE-ID·ATTENDEE·VTIMEZONE(캘린더), TITLE·CATEGORIES·PHOTO(연락처) 추가.
# 이게 없으면 이미 동기화된 반복 일정은 수정되기 전까지 휴대폰에서 계속 한 번짜리로 남는다.
# p5: 종일 DTSTART·DTEND·EXDATE·RECURRENCE-ID·UNTIL 을 가장 가까운 UTC 자정 기준으로(옛 기기 자정 행이 하루 앞당겨 보이던 것, R7 B1).
SERIAL_VERSION = "p5"


def compute_etag(row_id: str, updated_at: datetime | None) -> str:
    raw = f"{row_id}:{updated_at.isoformat() if updated_at else ''}:{SERIAL_VERSION}"
    return hashlib.md5(raw.encode()).hexdigest()


async def calendar_ctag(db: AsyncSession, calendar_id: str) -> str:
    result = await db.execute(
        select(func.max(CalendarEventDB.updated_at))
        .where(CalendarEventDB.calendar_id == calendar_id)
    )
    mx = result.scalar()
    if mx:
        return hashlib.md5(f"{mx.isoformat()}:{SERIAL_VERSION}".encode()).hexdigest()
    return "empty"


async def addressbook_ctag(db: AsyncSession, book_id: str) -> str:
    result = await db.execute(
        select(func.max(ContactDB.updated_at))
        .where(ContactDB.address_book_id == book_id)
    )
    mx = result.scalar()
    if mx:
        return hashlib.md5(f"{mx.isoformat()}:{SERIAL_VERSION}".encode()).hexdigest()
    return "empty"


# ── User lookup ──

async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
    result = await db.execute(select(User).where(User.username == username))
    return result.scalar_one_or_none()


# ── Calendar queries ──

async def get_user_calendars(db: AsyncSession, user_id: str) -> list[CalendarDB]:
    result = await db.execute(
        select(CalendarDB)
        .where(CalendarDB.user_id == user_id)
        .order_by(CalendarDB.sort_order, CalendarDB.name)
    )
    return list(result.scalars().all())


async def get_calendar(db: AsyncSession, cal_id: str) -> CalendarDB | None:
    return await db.get(CalendarDB, cal_id)


async def get_calendar_events(db: AsyncSession, cal_id: str) -> list[CalendarEventDB]:
    # 회차 단일 수정 행은 마스터 리소스(.ics) 안에 RECURRENCE-ID 로 들어간다 → 따로 내지 않는다
    result = await db.execute(
        select(CalendarEventDB)
        .where(CalendarEventDB.calendar_id == cal_id, CalendarEventDB.parent_event_id.is_(None))
        .order_by(CalendarEventDB.start)
    )
    return list(result.scalars().all())


async def event_ical_text(db: AsyncSession, ev: CalendarEventDB, cal: CalendarDB | None = None) -> str:
    """마스터 + 참석자 + 회차 예외(EXDATE·RECURRENCE-ID)를 한 VCALENDAR 로."""
    from app.calendar.service import ical_items_for
    if cal is None:
        cal = await db.get(CalendarDB, ev.calendar_id)
    items = await ical_items_for(db, [ev], cal)
    it = items[0]
    return event_to_ical(
        ev, it["attendees"], it["overrides"], it["organizer"], it["override_attendees"],
    )


async def get_event(db: AsyncSession, event_id: str) -> CalendarEventDB | None:
    return await db.get(CalendarEventDB, event_id)


async def get_events_by_ids(
    db: AsyncSession, ids: list[str],
) -> list[CalendarEventDB]:
    if not ids:
        return []
    result = await db.execute(
        select(CalendarEventDB).where(CalendarEventDB.id.in_(ids))
    )
    return list(result.scalars().all())


async def upsert_event(
    db: AsyncSession, event_id: str, cal_id: str, data: dict,
) -> CalendarEventDB:
    """CalDAV PUT. data 는 ical_to_event_bundle 결과({"master", "overrides"}) 또는
    옛 형식(마스터 필드 dict)."""
    from app.calendar.service import save_ical_bundle
    bundle = data if "master" in data else {"master": data, "overrides": []}
    return await save_ical_bundle(db, cal_id, bundle, event_id=event_id)


async def delete_event(db: AsyncSession, event_id: str) -> bool:
    ev = await db.get(CalendarEventDB, event_id)
    if not ev:
        return False
    from app.calendar.service import _delete_rows
    res = await db.execute(
        select(CalendarEventDB).where(CalendarEventDB.parent_event_id == ev.id)
    )
    await _delete_rows(db, list(res.scalars().all()) + [ev])
    await db.commit()
    return True


# ── Address Book queries ──

async def get_user_address_books(db: AsyncSession, user_id: str) -> list[AddressBookDB]:
    result = await db.execute(
        select(AddressBookDB)
        .where(AddressBookDB.user_id == user_id)
        .order_by(AddressBookDB.name)
    )
    return list(result.scalars().all())


async def get_address_book(db: AsyncSession, book_id: str) -> AddressBookDB | None:
    return await db.get(AddressBookDB, book_id)


async def get_book_contacts(db: AsyncSession, book_id: str) -> list[ContactDB]:
    result = await db.execute(
        select(ContactDB)
        .where(ContactDB.address_book_id == book_id)
        .order_by(ContactDB.full_name)
    )
    return list(result.scalars().all())


async def get_contact(db: AsyncSession, contact_id: str) -> ContactDB | None:
    return await db.get(ContactDB, contact_id)


async def get_contacts_by_ids(
    db: AsyncSession, ids: list[str],
) -> list[ContactDB]:
    if not ids:
        return []
    result = await db.execute(
        select(ContactDB).where(ContactDB.id.in_(ids))
    )
    return list(result.scalars().all())


async def upsert_contact(
    db: AsyncSession, contact_id: str, book_id: str, data: dict,
) -> ContactDB:
    c = await db.get(ContactDB, contact_id)
    if c:
        if "name" in data:
            c.full_name = data["name"]
        if "first_name" in data:
            c.given_name = data["first_name"]
        if "last_name" in data:
            c.surname = data["last_name"]
        if "organization" in data:
            c.organization = data["organization"]
        if "emails" in data:
            c.emails = json.dumps(data["emails"], ensure_ascii=False) if data["emails"] else None
        if "phones" in data:
            c.phones = json.dumps(data["phones"], ensure_ascii=False) if data["phones"] else None
        if "addresses" in data:
            c.addresses = json.dumps(data["addresses"], ensure_ascii=False) if data["addresses"] else None
        if "notes" in data:
            c.notes = data["notes"]
        if "title" in data:
            c.title = data["title"]
        if "groups" in data:
            c.groups = json.dumps(data["groups"], ensure_ascii=False) if data["groups"] else None
        if data.get("photo"):
            c.photo = data["photo"]
    else:
        c = ContactDB(
            id=contact_id,
            address_book_id=book_id,
            full_name=data.get("name", ""),
            given_name=data.get("first_name"),
            surname=data.get("last_name"),
            organization=data.get("organization"),
            emails=json.dumps(data["emails"], ensure_ascii=False) if data.get("emails") else None,
            phones=json.dumps(data["phones"], ensure_ascii=False) if data.get("phones") else None,
            addresses=json.dumps(data["addresses"], ensure_ascii=False) if data.get("addresses") else None,
            notes=data.get("notes"),
            title=data.get("title"),
            groups=json.dumps(data["groups"], ensure_ascii=False) if data.get("groups") else None,
            photo=data.get("photo"),
        )
        db.add(c)
    await db.commit()
    await db.refresh(c)
    return c


async def delete_contact(db: AsyncSession, contact_id: str) -> bool:
    c = await db.get(ContactDB, contact_id)
    if not c:
        return False
    await db.delete(c)
    await db.commit()
    return True
