"""대시보드 카드 조회 — 자주 쓰는 채널(내 메시지 수 순·내 채널만·DM/보관 제외) · 최근 위키(볼 수 있는 공간만)."""

import itertools
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.dashboard import cards
from app.db.models import Base, Channel, ChannelMember, Message, User, WikiPage, WikiSpace, WikiSpaceMember

TABLES = [t.__table__ for t in (User, Channel, ChannelMember, Message, WikiSpace, WikiPage, WikiSpaceMember)]


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        for uid in ("alice", "bob"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x"))
        await s.commit()
        yield s
    await engine.dispose()


_seq = itertools.count(1)   # sqlite 에는 서버 시퀀스가 없다 — 고유 순번을 직접 준다


def _msg(ch: str, who: str, ago_days: float = 0, deleted: bool = False) -> Message:
    return Message(id=str(uuid.uuid4()), seq=next(_seq), channel_id=ch, sender_id=who, content="x", is_deleted=deleted,
                   created_at=datetime.now(timezone.utc) - timedelta(days=ago_days))


@pytest.mark.asyncio
async def test_frequent_channels_ranks_my_messages_in_my_channels(db):
    db.add_all([
        Channel(id="dev", name="개발", type="public", created_by="alice"),
        Channel(id="ops", name="운영", type="private", created_by="alice"),
        Channel(id="old", name="보관", type="public", created_by="alice", is_archived=True),
        Channel(id="dm1", name="dm", type="dm", created_by="alice"),
        Channel(id="left", name="나간 채널", type="public", created_by="bob"),
    ])
    for ch in ("dev", "ops", "old", "dm1"):
        db.add(ChannelMember(channel_id=ch, user_id="alice"))
    db.add(ChannelMember(channel_id="left", user_id="bob"))
    db.add_all([_msg("dev", "alice") for _ in range(3)])
    db.add_all([_msg("ops", "alice") for _ in range(5)])
    db.add(_msg("ops", "alice", deleted=True))          # 지운 건 안 센다
    db.add_all([_msg("dev", "bob") for _ in range(10)])  # 남의 메시지는 안 센다
    db.add_all([_msg("old", "alice") for _ in range(9)])  # 보관 채널 제외
    db.add_all([_msg("dm1", "alice") for _ in range(9)])  # DM 제외
    db.add_all([_msg("left", "alice") for _ in range(9)])  # 멤버가 아닌 채널 제외
    db.add_all([_msg("dev", "alice", ago_days=40) for _ in range(9)])  # 30일 밖
    await db.commit()

    items = await cards.frequent_channels(db, "alice")
    assert [(i["id"], i["count"]) for i in items] == [("ops", 5), ("dev", 3)]
    assert items[0]["name"] == "운영" and items[0]["type"] == "private"
    assert await cards.frequent_channels(db, "bob") == []   # bob 은 dev 멤버가 아니다


@pytest.mark.asyncio
async def test_frequent_channels_limit(db):
    for i in range(4):
        db.add(Channel(id=f"c{i}", name=f"c{i}", type="public", created_by="alice"))
        db.add(ChannelMember(channel_id=f"c{i}", user_id="alice"))
        db.add_all([_msg(f"c{i}", "alice") for _ in range(i + 1)])
    await db.commit()
    assert [i["id"] for i in await cards.frequent_channels(db, "alice", limit=2)] == ["c3", "c2"]


@pytest.mark.asyncio
async def test_recent_wiki_only_visible_spaces_newest_first(db):
    now = datetime.now(timezone.utc)
    db.add_all([
        WikiSpace(id="pub", name="공개", slug="pub", owner_id="bob", visibility="public"),
        WikiSpace(id="mine", name="내 공간", slug="mine", owner_id="alice", visibility="private"),
        WikiSpace(id="team", name="팀", slug="team", owner_id="bob", visibility="private"),
        WikiSpace(id="secret", name="비밀", slug="secret", owner_id="bob", visibility="private"),
    ])
    db.add(WikiSpaceMember(space_id="team", user_id="alice", role="reader"))
    for pid, sid, ago in (("p1", "pub", 3), ("p2", "mine", 1), ("p3", "team", 2), ("p4", "secret", 0)):
        db.add(WikiPage(id=pid, space_id=sid, title=f"쪽 {pid}", slug=pid, author_id="bob",
                        updated_at=now - timedelta(hours=ago)))
    await db.commit()

    items = await cards.recent_wiki_pages(db, "alice")
    assert [i["id"] for i in items] == ["p2", "p3", "p1"]          # 비밀 공간(p4)은 안 보인다
    assert items[0]["space_name"] == "내 공간" and items[0]["space_id"] == "mine"
    assert items[0]["updated_at"].endswith("+00:00")
    assert [i["id"] for i in await cards.recent_wiki_pages(db, "alice", limit=1)] == ["p2"]
