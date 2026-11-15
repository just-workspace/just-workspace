"""통합 검색 — 위키 결과 링크는 실제 위키 화면 주소(/wiki?space=&page=)여야 한다."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base, User, WikiPage, WikiSpace, WikiSpaceMember
from app.search.router import global_search

TABLES = [t.__table__ for t in (User, WikiSpace, WikiSpaceMember, WikiPage)]


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def test_wiki_result_url_uses_space_and_page_ids(db):
    alice = User(id="alice", username="alice", email="alice@x", password_hash="x", display_name="alice")
    db.add(alice)
    await db.commit()
    sp = WikiSpace(name="팀", slug="team", owner_id="alice", visibility="public")
    db.add(sp)
    await db.commit()
    await db.refresh(sp)
    page = WikiPage(space_id=sp.id, title="배포 절차", slug="deploy", content="배포 순서", author_id="alice")
    db.add(page)
    await db.commit()
    await db.refresh(page)

    out = await global_search(q="배포", modules="wiki", user=alice, db=db)

    wiki = [r for r in out["results"] if r["type"] == "wiki"]
    assert len(wiki) == 1
    assert wiki[0]["url"] == f"/wiki?space={sp.id}&page={page.id}"
