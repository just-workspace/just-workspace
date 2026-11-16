"""외부 계정(Google / Microsoft)에서 주소록을 가져온다.

메일 연동에 사용하는 OAuth refresh token 을 그대로 재사용한다. 재로그인을 요구하지
않으나, **연락처 스코프는 메일 스코프와 별개이므로 기존 연동 계정은 1회 재연동이
필요하다** — 따라서 403 수신 시 해당 사실을 그대로 사용자에게 반환한다.

가져온 연락처는 계정별 전용 주소록에 저장하고 external_id 로 upsert 한다.
사용자가 직접 생성한 주소록은 변경하지 않으며, 반복 실행해도 중복이 누적되지 않는다.
"""

from __future__ import annotations

import json
import logging

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AddressBookDB, ContactDB, MailAccount
from app.mail.oauth import get_access_token

logger = logging.getLogger(__name__)

GOOGLE_PEOPLE = "https://people.googleapis.com/v1/people/me/connections"
GOOGLE_FIELDS = "names,emailAddresses,phoneNumbers,organizations"
GRAPH_CONTACTS = "https://graph.microsoft.com/v1.0/me/contacts"

# 1회 조회량이 과도하면 메모리 사용량과 응답시간이 함께 급증한다
PAGE_SIZE = 200
MAX_CONTACTS = 5000


class SyncError(Exception):
    """사용자에게 그대로 표시할 수 있는 실패."""


async def _book_for_account(db: AsyncSession, user_id: str, account: MailAccount) -> AddressBookDB:
    """계정 전용 주소록. 사용자가 생성한 주소록과 혼재되지 않도록 분리한다."""
    name = f"{account.email} 연락처"
    result = await db.execute(
        select(AddressBookDB).where(
            AddressBookDB.user_id == user_id, AddressBookDB.name == name
        )
    )
    book = result.scalar_one_or_none()
    if book:
        return book
    book = AddressBookDB(user_id=user_id, name=name, is_default=False)
    db.add(book)
    await db.flush()
    return book


def _parse_google(person: dict) -> dict | None:
    names = person.get("names") or []
    emails = person.get("emailAddresses") or []
    phones = person.get("phoneNumbers") or []
    orgs = person.get("organizations") or []

    addrs = [{"email": e["value"], "type": e.get("type", "other")}
             for e in emails if e.get("value")]
    full_name = (names[0].get("displayName") if names else "") or ""
    if not full_name and addrs:
        full_name = addrs[0]["email"].split("@")[0]
    # 이름과 주소가 모두 없으면 저장할 의미 없음
    if not full_name and not addrs:
        return None

    return {
        "external_id": person.get("resourceName") or "",
        "full_name": full_name,
        "given_name": (names[0].get("givenName") if names else None) or None,
        "surname": (names[0].get("familyName") if names else None) or None,
        "organization": (orgs[0].get("name") if orgs else None) or None,
        "emails": addrs,
        "phones": [{"number": p["value"], "type": p.get("type", "other")}
                   for p in phones if p.get("value")],
    }


def _parse_microsoft(c: dict) -> dict | None:
    emails = [{"email": e["address"], "type": "other"}
              for e in (c.get("emailAddresses") or []) if e.get("address")]
    full_name = c.get("displayName") or ""
    if not full_name and emails:
        full_name = emails[0]["email"].split("@")[0]
    if not full_name and not emails:
        return None

    phones = []
    for key in ("mobilePhone",):
        if c.get(key):
            phones.append({"number": c[key], "type": "mobile"})
    for num in (c.get("businessPhones") or []):
        phones.append({"number": num, "type": "work"})

    return {
        "external_id": c.get("id") or "",
        "full_name": full_name,
        "given_name": c.get("givenName") or None,
        "surname": c.get("surname") or None,
        "organization": c.get("companyName") or None,
        "emails": emails,
        "phones": phones,
    }


async def _fetch_google(token: str) -> list[dict]:
    out: list[dict] = []
    page = None
    async with httpx.AsyncClient(timeout=30) as client:
        while len(out) < MAX_CONTACTS:
            params = {"personFields": GOOGLE_FIELDS, "pageSize": PAGE_SIZE}
            if page:
                params["pageToken"] = page
            r = await client.get(
                GOOGLE_PEOPLE, params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code == 403:
                raise SyncError(
                    "연락처 읽기 권한이 없습니다. 메일 설정에서 이 계정을 한 번 다시 연동해주세요 "
                    "(연락처 스코프는 메일 스코프와 별개라 재동의가 필요합니다)."
                )
            if r.status_code >= 400:
                raise SyncError(f"Google 연락처를 가져오지 못했습니다 ({r.status_code})")
            data = r.json()
            out.extend(data.get("connections") or [])
            page = data.get("nextPageToken")
            if not page:
                break
    return out


async def _fetch_microsoft(token: str) -> list[dict]:
    out: list[dict] = []
    url = f"{GRAPH_CONTACTS}?$top={PAGE_SIZE}"
    async with httpx.AsyncClient(timeout=30) as client:
        while url and len(out) < MAX_CONTACTS:
            r = await client.get(url, headers={"Authorization": f"Bearer {token}"})
            if r.status_code in (401, 403):
                raise SyncError(
                    "연락처 읽기 권한이 없습니다. 메일 설정에서 이 계정을 한 번 다시 연동해주세요."
                )
            if r.status_code >= 400:
                raise SyncError(f"Microsoft 연락처를 가져오지 못했습니다 ({r.status_code})")
            data = r.json()
            out.extend(data.get("value") or [])
            url = data.get("@odata.nextLink")
    return out


async def sync_account(db: AsyncSession, user_id: str, account: MailAccount) -> dict:
    """계정 하나의 주소록을 가져와 upsert 한다. 반환값은 요약 통계."""
    if account.auth_method != "oauth" or not account.oauth_provider:
        raise SyncError("OAuth 로 연동한 계정만 연락처를 가져올 수 있습니다")

    token = await get_access_token(account)
    provider = account.oauth_provider

    if provider == "google":
        raw = await _fetch_google(token)
        parsed = [p for p in (_parse_google(x) for x in raw) if p]
    elif provider == "microsoft":
        raw = await _fetch_microsoft(token)
        parsed = [p for p in (_parse_microsoft(x) for x in raw) if p]
    else:
        raise SyncError(f"지원하지 않는 제공자입니다: {provider}")

    book = await _book_for_account(db, user_id, account)

    existing = await db.execute(
        select(ContactDB).where(ContactDB.address_book_id == book.id)
    )
    by_ext = {c.external_id: c for c in existing.scalars().all() if c.external_id}

    created = updated = 0
    for p in parsed:
        ext = p["external_id"]
        emails_json = json.dumps(p["emails"], ensure_ascii=False) if p["emails"] else None
        phones_json = json.dumps(p["phones"], ensure_ascii=False) if p["phones"] else None

        c = by_ext.get(ext) if ext else None
        if c:
            c.full_name = p["full_name"]
            c.given_name = p["given_name"]
            c.surname = p["surname"]
            c.organization = p["organization"]
            c.emails = emails_json
            c.phones = phones_json
            updated += 1
        else:
            db.add(ContactDB(
                address_book_id=book.id,
                full_name=p["full_name"],
                given_name=p["given_name"],
                surname=p["surname"],
                organization=p["organization"],
                emails=emails_json,
                phones=phones_json,
                external_id=ext or None,
                external_source=provider,
            ))
            created += 1

    await db.commit()
    logger.info("연락처 동기화 %s: 신규 %d, 갱신 %d", account.email, created, updated)
    return {
        "account": account.email,
        "provider": provider,
        "address_book": book.name,
        "fetched": len(parsed),
        "created": created,
        "updated": updated,
    }
