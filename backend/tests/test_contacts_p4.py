"""연락처 보강 — 사진·즐겨찾기·그룹·직함, 그룹/즐겨찾기 필터, 워크스페이스 사용자, 한 건 vCard,
CardDAV 직렬화 왕복."""

import base64

import pytest
from fastapi import HTTPException

from app.contacts import router as c_router
from app.contacts import service
from app.contacts.schemas import ContactCreate, ContactUpdate
from app.dav import service as dav_svc
from app.dav.vcard_utils import contact_to_vcard, vcard_to_contact_data
from app.db.models import AddressBookDB, ContactDB, User

PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()


async def _seed(db):
    for uid in ("alice", "bob"):
        db.add(User(id=uid, username=uid, email=f"{uid}@x.io", password_hash="x", display_name=uid.title()))
    db.add(User(id="gone", username="gone", email="gone@x.io", password_hash="x", is_active=False))
    await db.commit()
    db.add(AddressBookDB(id="ab-a", user_id="alice", name="기본", is_default=True))
    db.add(AddressBookDB(id="ab-b", user_id="bob", name="기본", is_default=True))
    await db.commit()
    return await db.get(User, "alice"), await db.get(User, "bob")


@pytest.mark.asyncio
async def test_new_fields_filters_groups(db_session):
    db = db_session
    alice, bob = await _seed(db)
    a = await c_router.create_contact(body=ContactCreate(
        address_book_id="ab-a", name="김철수", title="팀장", is_favorite=True,
        groups=["거래처", "VIP", "거래처"], photo=PNG), user=alice, db=db)
    assert a.title == "팀장" and a.is_favorite and a.groups == ["거래처", "VIP"] and a.photo == PNG
    await c_router.create_contact(body=ContactCreate(address_book_id="ab-a", name="이영희", groups=["거래처사"]),
                                  user=alice, db=db)

    fav = await c_router.list_contacts(q=None, book_id=None, page=0, limit=50, favorite=True, group=None, user=alice, db=db)
    assert [c.name for c in fav["contacts"]] == ["김철수"]
    grp = await c_router.list_contacts(q=None, book_id=None, page=0, limit=50, favorite=None, group="거래처", user=alice, db=db)
    assert [c.name for c in grp["contacts"]] == ["김철수"]  # "거래처사" 와 혼동하지 않음
    groups = await c_router.list_groups(user=alice, db=db)
    assert groups["groups"] == [{"name": "VIP", "count": 1}, {"name": "거래처", "count": 1}, {"name": "거래처사", "count": 1}]
    assert (await c_router.list_groups(user=bob, db=db))["groups"] == []

    await c_router.update_contact(contact_id=a.id, body=ContactUpdate(is_favorite=False, photo="", groups=[]), user=alice, db=db)
    got = await c_router.get_contact(contact_id=a.id, user=alice, db=db)
    assert not got.is_favorite and got.photo is None and got.groups == [] and got.title == "팀장"

    with pytest.raises(HTTPException) as e:
        await c_router.create_contact(body=ContactCreate(address_book_id="ab-a", name="x", photo="https://evil/x.png"),
                                      user=alice, db=db)
    assert e.value.status_code == 400
    # 타 사용자의 연락처는 수정 불가
    with pytest.raises(HTTPException) as e:
        await c_router.update_contact(contact_id=a.id, body=ContactUpdate(is_favorite=True), user=bob, db=db)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_workspace_users(db_session):
    db = db_session
    alice, _ = await _seed(db)
    res = await c_router.workspace_users(q=None, limit=100, offset=0, user=alice, db=db)
    assert [u["username"] for u in res["users"]] == ["alice", "bob"] and res["total"] == 2
    assert set(res["users"][0]) >= {"id", "username", "display_name", "email", "avatar_url"}
    assert "password_hash" not in res["users"][0]
    res = await c_router.workspace_users(q="bo", limit=100, offset=0, user=alice, db=db)
    assert [u["username"] for u in res["users"]] == ["bob"]


@pytest.mark.asyncio
async def test_single_vcard_export_and_permission(db_session):
    db = db_session
    alice, bob = await _seed(db)
    a = await c_router.create_contact(body=ContactCreate(address_book_id="ab-a", name="김철수", title="팀장",
                                                         groups=["거래처"], photo=PNG), user=alice, db=db)
    resp = await c_router.export_one_vcard(contact_id=a.id, user=alice, db=db)
    text = resp.body.decode()
    assert "BEGIN:VCARD" in text and "TITLE:팀장" in text and "CATEGORIES:거래처" in text and "PHOTO" in text
    with pytest.raises(HTTPException) as e:
        await c_router.export_one_vcard(contact_id=a.id, user=bob, db=db)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_carddav_roundtrip(db_session):
    db = db_session
    await _seed(db)
    c = ContactDB(id="c1", address_book_id="ab-a", full_name="박민지", title="디자이너",
                  groups='["디자인", "사내"]', photo=PNG, is_favorite=True)
    db.add(c)
    await db.commit()
    text = contact_to_vcard(c)
    data = vcard_to_contact_data(text)
    assert data["title"] == "디자이너" and data["groups"] == ["디자인", "사내"]
    assert data["photo"].startswith("data:image/png;base64,")
    assert base64.b64decode(data["photo"].split(",", 1)[1]) == base64.b64decode(PNG.split(",", 1)[1])

    # 휴대폰이 사진 없이 PUT → 사진은 유지, 직함·그룹은 휴대폰 값 적용
    no_photo = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:박민지\r\nN:박;민지;;;\r\nTITLE:리드\r\nUID:c1\r\nEND:VCARD\r\n"
    row = await dav_svc.upsert_contact(db, "c1", "ab-a", vcard_to_contact_data(no_photo))
    assert row.photo == PNG and row.title == "리드" and row.groups is None
    assert row.is_favorite is True  # 서버 전용 필드는 유지
