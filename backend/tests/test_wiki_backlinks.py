"""위키 역링크 — 본문 내부 링크(주소·data-page-id·[[제목]])를 파싱하여 대상 페이지 목록을 반환한다."""

import pytest
from fastapi import HTTPException

from app.db.models import User, WikiPage, WikiSpace, WikiSpaceMember
from app.wiki import router as wiki_router
from app.wiki import service


def test_parse_internal_links():
    pid = "123e4567-e89b-12d3-a456-426614174000"
    ids, titles = service.parse_internal_links(
        f'<a href="https://ws.example/wiki?space=s1&page={pid}">x</a> '
        f'[[배포 절차]] [[Runbook|런북]] <span data-page-id="{pid.upper()}"></span>'
    )
    assert ids == {pid}
    assert titles == {"배포 절차", "runbook"}


async def _seed(db):
    for uid in ("alice", "bob", "carol"):
        db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x"))
    await db.commit()
    s1 = WikiSpace(id="s1", name="개발", slug="dev", owner_id="alice", visibility="private")
    s2 = WikiSpace(id="s2", name="비밀", slug="secret", owner_id="alice", visibility="private")
    db.add_all([s1, s2])
    await db.commit()
    db.add(WikiSpaceMember(space_id="s1", user_id="bob", role="reader"))
    await db.commit()
    target = WikiPage(id="11111111-1111-1111-1111-111111111111", space_id="s1", title="배포 절차",
                      slug="deploy", content="본문", author_id="alice")
    by_url = WikiPage(id="22222222-2222-2222-2222-222222222222", space_id="s1", title="온보딩", slug="onb",
                      content=f"[배포](/wiki?space=s1&page={target.id}) 를 보세요", author_id="alice")
    by_title = WikiPage(id="33333333-3333-3333-3333-333333333333", space_id="s1", title="FAQ", slug="faq",
                        content="자세한 건 [[배포 절차]] 참고", author_id="alice")
    secret = WikiPage(id="44444444-4444-4444-4444-444444444444", space_id="s2", title="비밀", slug="sec",
                      content=f'<a href="/wiki?space=s1&page={target.id}">링크</a>', author_id="alice")
    other_space_title = WikiPage(id="55555555-5555-5555-5555-555555555555", space_id="s2", title="동명",
                                 slug="x", content="[[배포 절차]]", author_id="alice")
    unrelated = WikiPage(id="66666666-6666-6666-6666-666666666666", space_id="s1", title="기타", slug="etc",
                         content="배포 절차 라는 글자만", author_id="alice")
    db.add_all([target, by_url, by_title, secret, other_space_title, unrelated])
    await db.commit()
    return target


@pytest.mark.asyncio
async def test_backlinks_permissions(db_session):
    target = await _seed(db_session)
    alice = await db_session.get(User, "alice")
    bob = await db_session.get(User, "bob")
    carol = await db_session.get(User, "carol")

    res = await wiki_router.page_backlinks(page_id=target.id, user=alice, db=db_session)
    got = {i["title"]: i["link_type"] for i in res["items"]}
    # 다른 스페이스의 [[같은 제목]] 은 이 페이지에 해당하지 않음
    assert got == {"온보딩": "id", "FAQ": "title", "비밀": "id"}

    res = await wiki_router.page_backlinks(page_id=target.id, user=bob, db=db_session)
    assert {i["title"] for i in res["items"]} == {"온보딩", "FAQ"}  # 비밀 스페이스는 미표시
    assert res["items"][0]["url"].startswith("/wiki?space=s1&page=")

    with pytest.raises(HTTPException) as e:
        await wiki_router.page_backlinks(page_id=target.id, user=carol, db=db_session)
    assert e.value.status_code == 403
