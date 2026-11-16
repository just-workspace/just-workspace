"""Contacts API endpoints — PostgreSQL backend."""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import AddressBookDB, ContactDB, User
from app.db.session import get_db
from app.contacts import external_sync, service, suggest as suggest_service
from app.contacts.schemas import (
    AddressBook,
    AddressBookCreate,
    AddressBookListResponse,
    Contact,
    ContactCreate,
    ContactUpdate,
    ContactListResponse,
)
from app.dav.vcard_utils import contact_to_vcard, vcard_to_contact_data
from app.modules.registry import require_module

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/contacts", tags=["contacts"])


# ─── Address Books ───


@router.get("/address-books", response_model=AddressBookListResponse)
@require_module("contacts")
async def list_address_books(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    books = await service.get_address_books(db, user.id)
    return {"address_books": [AddressBook(**b) for b in books]}


@router.post("/address-books", response_model=AddressBook)
@require_module("contacts")
async def create_address_book(
    body: AddressBookCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await service.create_address_book(db, user.id, body.name)
    return AddressBook(**result)


@router.delete("/address-books/{book_id}", response_model=dict)
@require_module("contacts")
async def delete_address_book(
    book_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ok = await service.delete_address_book(db, user.id, book_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Address book not found")
    return {"ok": True}


# ─── Contacts ───


# ── 정적 경로는 /{contact_id} 보다 반드시 위에 정의한다 ──
# FastAPI 는 정의 순서대로 매칭하므로, 아래에 정의하면 "suggest" 같은 문자열이
# contact_id 로 매칭되어 404 가 발생한다. export-vcf 가 실제로 이 원인으로 동작하지 않았다.

# ── GET /api/contacts/suggest — 수신인 자동완성 ──────────────


@router.get("/suggest")
async def suggest_recipients(
    q: str = Query("", max_length=100),
    limit: int = Query(10, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """최근 발신 수신인 + 내부 사용자 + 주소록을 병합한 자동완성.

    회의 초대창과 메일 작성창이 동일한 질의를 수행하므로 출처를 여기서 병합한다.
    q 가 비어 있으면 최근 수신인 위주로 반환한다(입력 전 기본 목록).
    """
    return await suggest_service.suggest(db, user.id, q, limit)


# ── 외부 계정 주소록 가져오기 ────────────────────────────────


@router.get("/external-accounts")
async def list_external_accounts(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """연락처를 가져올 수 있는(= OAuth 로 연동된) 메일 계정 목록."""
    from app.db.models import MailAccount

    result = await db.execute(
        select(MailAccount).where(
            MailAccount.user_id == user.id,
            MailAccount.auth_method == "oauth",
        )
    )
    return [
        {"id": a.id, "email": a.email, "provider": a.oauth_provider,
         "display_name": a.display_name}
        for a in result.scalars().all()
    ]


@router.post("/external-accounts/{account_id}/sync")
async def sync_external_contacts(
    account_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """외부 계정의 주소록을 계정 전용 주소록으로 가져온다(upsert)."""
    from app.db.models import MailAccount

    account = await db.get(MailAccount, account_id)
    if not account or account.user_id != user.id:
        raise HTTPException(status_code=404, detail="계정을 찾을 수 없습니다")

    try:
        return await external_sync.sync_account(db, user.id, account)
    except external_sync.SyncError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("연락처 동기화 실패: %s", account.email)
        raise HTTPException(status_code=502, detail=f"연락처 동기화에 실패했습니다: {e}")


@router.get("/export-vcf")
@require_module("contacts")
async def export_vcf(
    book_id: str = Query(..., description="Address book ID to export"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Export all contacts in an address book as a single .vcf file."""
    # Verify address book ownership
    ab = await db.get(AddressBookDB, book_id)
    if not ab or ab.user_id != user.id:
        raise HTTPException(status_code=404, detail="Address book not found")

    # Fetch all contacts in the book
    result = await db.execute(
        select(ContactDB)
        .where(ContactDB.address_book_id == book_id)
        .order_by(ContactDB.full_name)
    )
    contacts = result.scalars().all()

    # Build combined vCard output
    vcf_parts = []
    for c in contacts:
        vcf_parts.append(contact_to_vcard(c))

    vcf_content = "\r\n".join(vcf_parts)
    safe_name = ab.name.replace('"', '').replace('\n', '').replace('\r', '')

    # 한글 등 비ASCII 주소록명: RFC 5987 (latin-1 헤더 인코딩 오류 방지)
    from urllib.parse import quote
    ascii_fallback = (safe_name.encode("ascii", "ignore").decode() or "contacts") + ".vcf"
    disposition = (
        f"attachment; filename=\"{ascii_fallback}\"; "
        f"filename*=UTF-8''{quote(safe_name + '.vcf')}"
    )
    return Response(
        content=vcf_content.encode("utf-8"),
        media_type="text/vcard; charset=utf-8",
        headers={"Content-Disposition": disposition},
    )


@router.get("/groups")
@require_module("contacts")
async def list_groups(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """호출 사용자의 연락처 그룹 [{name, count}]."""
    return {"groups": await service.list_groups(db, user.id)}


@router.get("/workspace-users")
@require_module("contacts")
async def workspace_users(
    q: str | None = Query(None, max_length=100),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """워크스페이스 사용자(연락처 사이드바 "구성원"). 활성 사용자만, 이름·이메일·아바타."""
    users, total = await service.workspace_users(db, q, limit, offset)
    return {"users": users, "total": total}


@router.get("/", response_model=ContactListResponse)
@require_module("contacts")
async def list_contacts(
    q: str | None = Query(None),
    book_id: str | None = Query(None),
    page: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    favorite: bool | None = Query(None, description="true=즐겨찾기만"),
    group: str | None = Query(None, max_length=100, description="이 그룹만"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    contacts, total = await service.get_contacts(db, user.id, q, book_id, page, limit,
                                                 favorite=favorite, group=group)
    return {"contacts": [Contact(**c) for c in contacts], "total": total}


@router.get("/{contact_id}/vcard")
@require_module("contacts")
async def export_one_vcard(
    contact_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """연락처 1건을 .vcf 로 내보낸다."""
    from urllib.parse import quote
    c = await db.get(ContactDB, contact_id)
    ab = await db.get(AddressBookDB, c.address_book_id) if c else None
    if not c or not ab or ab.user_id != user.id:
        raise HTTPException(status_code=404, detail="Contact not found")
    name = (c.full_name or "contact").replace('"', '').replace('\n', '').replace('\r', '')[:100]
    return Response(
        content=contact_to_vcard(c).encode("utf-8"),
        media_type="text/vcard; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=\"contact.vcf\"; filename*=UTF-8''{quote(name + '.vcf')}"},
    )


@router.get("/{contact_id}", response_model=Contact)
@require_module("contacts")
async def get_contact(
    contact_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    contact = await service.get_contact(db, user.id, contact_id)
    if not contact:
        raise HTTPException(status_code=404, detail="Contact not found")
    return Contact(**contact)


@router.post("/", response_model=Contact)
@require_module("contacts")
async def create_contact(
    body: ContactCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    data = body.model_dump()
    if data.get("emails"):
        data["emails"] = [{"type": v["type"], "value": v["value"]} for v in data["emails"]]
    if data.get("phones"):
        data["phones"] = [{"type": v["type"], "value": v["value"]} for v in data["phones"]]
    if data.get("addresses"):
        data["addresses"] = [{"type": v["type"], "value": v["value"]} for v in data["addresses"]]
    try:
        result = await service.create_contact(db, user.id, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not result:
        raise HTTPException(status_code=400, detail="Failed to create contact")
    return Contact(**result)


@router.patch("/{contact_id}", response_model=dict)
@require_module("contacts")
async def update_contact(
    contact_id: str,
    body: ContactUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 전송된 필드만 변경된다. exclude_none 사용 시 소속·메모·성·이름을 비운 값(null)이 제외되어 삭제되지 않았다.
    # 이름·목록·즐겨찾기·주소록의 null 은 서비스가 "변경 없음"으로 처리한다.
    data = body.model_dump(exclude_unset=True)
    for field in ["emails", "phones", "addresses"]:
        if data.get(field):
            data[field] = [{"type": v["type"], "value": v["value"]} for v in data[field]]
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")
    if body.photo == "":
        data["photo"] = None  # 사진 삭제
    try:
        ok = await service.update_contact(db, user.id, contact_id, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True}


@router.delete("/{contact_id}", response_model=dict)
@require_module("contacts")
async def delete_contact(
    contact_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ok = await service.delete_contact(db, user.id, contact_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True}


# ─── vCard Import / Export ───


@router.post("/import-vcf")
@require_module("contacts")
async def import_vcf(
    file: UploadFile = File(...),
    book_id: str = Query(..., description="Target address book ID"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Import contacts from a .vcf file into the specified address book."""
    import vobject

    # Verify address book ownership
    ab = await db.get(AddressBookDB, book_id)
    if not ab or ab.user_id != user.id:
        raise HTTPException(status_code=404, detail="Address book not found")

    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        # 구형 휴대폰·Outlook 내보내기는 CP949 — latin-1 로 읽으면 이름이 깨진 상태로 "성공" 저장되었음
        text = content.decode("cp949", errors="replace")

    # 동일 파일을 다시 업로드해도(중간 오류 후 재시도 포함) 중복되지 않도록 함 — 이름·이메일·전화가 모두 동일하면 제외한다
    def _key(name, emails, phones) -> tuple:
        vals = lambda items: tuple(sorted(str((x or {}).get("value") or "").strip().lower() for x in (items or [])))  # noqa: E731
        return ((name or "").strip(), vals(emails), vals(phones))

    existing = await db.execute(
        select(ContactDB.full_name, ContactDB.emails, ContactDB.phones)
        .where(ContactDB.address_book_id == book_id)
    )
    seen: set[tuple] = set()
    for full_name, emails_json, phones_json in existing.all():
        try:
            seen.add(_key(full_name, json.loads(emails_json) if emails_json else [],
                          json.loads(phones_json) if phones_json else []))
        except (ValueError, TypeError, AttributeError):
            continue

    imported = 0
    errors = 0
    skipped = 0
    components = vobject.readComponents(text)
    while True:
        # 파일 중간이 손상되어 있으면 파서가 예외를 발생시킨다 — 이전에는 앞부분만 저장된 채 500 이 발생했다.
        # 해당 지점에서 중단하고 그때까지 읽은 결과를 반환한다.
        try:
            component = next(components)
        except StopIteration:
            break
        except Exception:  # noqa: BLE001
            errors += 1
            break
        if component.name != "VCARD":
            continue
        try:
            data = vcard_to_contact_data(component.serialize())
        except Exception:  # noqa: BLE001
            data = None
        if not data:
            errors += 1
            continue
        data["address_book_id"] = book_id
        if not data.get("name"):
            data["name"] = data.get("first_name") or "Unknown"
        key = _key(data["name"], data.get("emails"), data.get("phones"))
        if key in seen:
            skipped += 1
            continue
        try:
            try:
                result = await service.create_contact(db, user.id, data)
            except ValueError:
                data.pop("photo", None)  # 과대·비정상 사진은 제외하고 나머지는 가져온다
                result = await service.create_contact(db, user.id, data)
        except Exception:  # noqa: BLE001
            await db.rollback()
            result = None
        if result:
            imported += 1
            seen.add(key)
        else:
            errors += 1

    return {"ok": True, "imported": imported, "errors": errors, "skipped": skipped}
