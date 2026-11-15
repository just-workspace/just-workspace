"""채팅 데이터 계층 — seq 부여·커서, 미읽음/멘션 카운트, 읽음 포인터.

SQLite(aiosqlite) 위에서 service 함수를 그대로 부른다. PostgreSQL 에서는 DB 시퀀스가
seq 를 주지만 SQLite 에는 시퀀스가 없어 models 의 before_insert 폴백(max+1)이 대신한다 —
그래서 "단조 증가·유니크" 라는 계약만 검증하고 값 자체는 가정하지 않는다.

채팅에 필요한 테이블만 만들어 빠르게 돈다.
"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.chat import service
from app.db.models import (
    Base, Channel, ChannelMember, ChatDraft, ChatMention, Message, Notification, Reaction,
    ThreadFollow, User, UserStatus,
)

CHAT_TABLES = [
    t.__table__
    for t in (User, Channel, ChannelMember, Message, Reaction, Notification, ChatMention,
              ThreadFollow, UserStatus, ChatDraft)
]


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=CHAT_TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        session.add(User(id="alice", username="alice", email="a@x", password_hash="x",
                         display_name="Alice"))
        session.add(User(id="bob", username="bob", email="b@x", password_hash="x",
                         display_name="Bob"))
        session.add(User(id="carol", username="carol", email="c@x", password_hash="x",
                         display_name="Carol"))
        await session.commit()
        yield session
    await engine.dispose()


async def _channel(db, members=("bob",)):
    return await service.create_channel(db, "general", "public", "alice", member_ids=list(members))


async def _chan_for(db, user_id, channel_id):
    return next(c for c in await service.get_user_channels(db, user_id) if c["id"] == channel_id)


# ─── seq ───


async def test_seq_is_strictly_increasing_and_in_dict(db):
    ch = await _channel(db)
    seqs = []
    for i in range(5):
        m = await service.create_message(db, ch.id, "alice", f"m{i}")
        assert m["seq"] is not None
        seqs.append(m["seq"])
    # 채널 생성 시 시스템 메시지가 먼저 seq 를 받으므로 그 뒤부터 단조 증가
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    assert all(b > a for a, b in zip(seqs, seqs[1:]))


async def test_get_messages_after_seq_and_before_seq(db):
    ch = await _channel(db)
    ms = [await service.create_message(db, ch.id, "alice", f"m{i}") for i in range(6)]

    after, has_more = await service.get_messages(db, ch.id, after_seq=ms[2]["seq"], limit=2)
    assert [m["content"] for m in after] == ["m3", "m4"]
    assert has_more is True

    before, _ = await service.get_messages(db, ch.id, before_seq=ms[2]["seq"], limit=50)
    # 시스템 메시지 + m0, m1 — 오래된 것부터
    assert [m["content"] for m in before][-2:] == ["m0", "m1"]

    # 기존 id 커서(after=) 도 seq 로 풀려 같은 결과
    after_id, _ = await service.get_messages(db, ch.id, after=ms[2]["id"], limit=2)
    assert [m["id"] for m in after_id] == [m["id"] for m in after]


async def test_get_messages_excludes_thread_replies_and_deleted(db):
    ch = await _channel(db)
    root = await service.create_message(db, ch.id, "alice", "root")
    await service.create_message(db, ch.id, "bob", "reply", parent_id=root["id"])
    gone = await service.create_message(db, ch.id, "alice", "gone")
    await service.soft_delete_message(db, gone["id"])

    msgs, _ = await service.get_messages(db, ch.id)
    contents = [m["content"] for m in msgs]
    assert "reply" not in contents and "gone" not in contents
    assert msgs[-1]["content"] == "root" and msgs[-1]["reply_count"] == 1


async def test_get_changes_since_scopes_to_my_channels_and_flags_too_many(db):
    mine = await _channel(db, members=("bob",))
    other = await service.create_channel(db, "secret", "private", "alice", member_ids=["carol"])

    base = await service.get_latest_seq(db)
    a = await service.create_message(db, mine.id, "alice", "visible")
    await service.create_message(db, other.id, "alice", "hidden")
    reply = await service.create_message(db, mine.id, "alice", "reply", parent_id=a["id"])

    res = await service.get_changes_since(db, "bob", base, limit=10)
    assert res["too_many"] is False
    assert [m["content"] for m in res["messages"]] == ["visible", "reply"]
    assert res["messages"][1]["parent_id"] == a["id"]
    assert res["latest_seq"] == reply["seq"]

    too = await service.get_changes_since(db, "bob", base, limit=1)
    assert too["too_many"] is True and too["messages"] == []
    assert too["latest_seq"] == res["latest_seq"]

    # 커서가 최신이면 빈 목록
    empty = await service.get_changes_since(db, "bob", res["latest_seq"])
    assert empty["messages"] == [] and empty["too_many"] is False


# ─── 미읽음 · 멘션 · 읽음 포인터 ───


async def test_unread_excludes_own_deleted_and_thread_replies(db):
    ch = await _channel(db)
    # 시스템 메시지 1건이 이미 있다(둘 다에게 미읽음)
    m1 = await service.create_message(db, ch.id, "alice", "one")
    await service.create_message(db, ch.id, "bob", "from bob")
    await service.create_message(db, ch.id, "alice", "reply", parent_id=m1["id"])
    gone = await service.create_message(db, ch.id, "alice", "gone")
    await service.soft_delete_message(db, gone["id"])

    bob = await _chan_for(db, "bob", ch.id)
    assert bob["unread_count"] == 2  # system + "one"
    alice = await _chan_for(db, "alice", ch.id)
    assert alice["unread_count"] == 2  # system + "from bob"


async def test_mark_read_is_monotonic_and_clears_unread(db):
    ch = await _channel(db)
    m1 = await service.create_message(db, ch.id, "alice", "one")
    m2 = await service.create_message(db, ch.id, "alice", "two")

    assert await service.mark_read(db, ch.id, "bob", m2["id"]) == m2["seq"]
    bob = await _chan_for(db, "bob", ch.id)
    assert bob["unread_count"] == 0 and bob["last_read_seq"] == m2["seq"]

    # 옛 메시지로 되돌리는 mark_read 는 무시된다
    assert await service.mark_read(db, ch.id, "bob", m1["id"]) is None
    bob = await _chan_for(db, "bob", ch.id)
    assert bob["last_read_seq"] == m2["seq"] and bob["unread_count"] == 0

    # 다른 채널 메시지 id · 없는 id 는 None
    assert await service.mark_read(db, ch.id, "bob", "nope") is None

    m3 = await service.create_message(db, ch.id, "alice", "three")
    bob = await _chan_for(db, "bob", ch.id)
    assert bob["unread_count"] == 1
    assert await service.mark_read(db, ch.id, "bob", m3["id"]) == m3["seq"]


async def test_read_by_uses_last_read_seq(db):
    ch = await _channel(db)
    m1 = await service.create_message(db, ch.id, "alice", "one")
    m2 = await service.create_message(db, ch.id, "alice", "two")
    await service.mark_read(db, ch.id, "bob", m1["id"])

    msgs, _ = await service.get_messages(db, ch.id)
    by_id = {m["id"]: [r["id"] for r in m["read_by"]] for m in msgs}
    assert by_id[m1["id"]] == ["bob"]   # 보낸 사람(alice)은 제외
    assert by_id[m2["id"]] == []


async def test_mentions_counted_until_read_and_dropped_on_delete(db):
    ch = await _channel(db, members=("bob", "carol"))
    m1 = await service.create_message(db, ch.id, "alice", "hey @bob look")
    notifs = await service.create_notifications_for_mentions(
        db, m1, ch.id, "alice", service.parse_mentions(m1["content"]),
    )
    assert [n["user_id"] for n in notifs] == ["bob"]
    assert notifs[0]["channel_id"] == ch.id and notifs[0]["seq"] == m1["seq"]

    # 같은 메시지를 재처리해도 행이 늘지 않는다
    assert await service.record_mentions(db, m1, ch.id, ["bob"]) == 0

    m2 = await service.create_message(db, ch.id, "alice", "@bob @carol @alice @nobody")
    await service.create_notifications_for_mentions(
        db, m2, ch.id, "alice", service.parse_mentions(m2["content"]),
    )

    bob = await _chan_for(db, "bob", ch.id)
    carol = await _chan_for(db, "carol", ch.id)
    alice = await _chan_for(db, "alice", ch.id)
    assert bob["mention_count"] == 2 and carol["mention_count"] == 1
    assert alice["mention_count"] == 0  # 자기 멘션은 안 센다
    assert await service.get_mention_count(db, "bob", ch.id) == 2

    # m1 까지 읽음 → m2 멘션만 남는다
    await service.mark_read(db, ch.id, "bob", m1["id"])
    assert (await _chan_for(db, "bob", ch.id))["mention_count"] == 1

    # 멘션 메시지가 삭제되면 배지에서 사라진다
    await service.soft_delete_message(db, m2["id"])
    assert (await _chan_for(db, "bob", ch.id))["mention_count"] == 0
    assert (await _chan_for(db, "carol", ch.id))["mention_count"] == 0


async def test_mentions_skip_non_members(db):
    ch = await _channel(db, members=("bob",))  # carol 은 비멤버
    m = await service.create_message(db, ch.id, "alice", "@carol @bob")
    notifs = await service.create_notifications_for_mentions(
        db, m, ch.id, "alice", service.parse_mentions(m["content"]),
    )
    assert [n["user_id"] for n in notifs] == ["bob"]


async def test_channel_last_message_denormalized_and_rewound_on_delete(db):
    ch = await _channel(db)
    m1 = await service.create_message(db, ch.id, "alice", "first")
    m2 = await service.create_message(db, ch.id, "bob", "second")
    # 스레드 답글은 채널의 마지막 메시지를 바꾸지 않는다
    await service.create_message(db, ch.id, "alice", "reply", parent_id=m1["id"])

    row = await _chan_for(db, "bob", ch.id)
    assert row["last_message_seq"] == m2["seq"]
    assert row["last_message"]["content"] == "second"
    assert row["last_message"]["sender_name"] == "Bob"

    await service.soft_delete_message(db, m2["id"])
    row = await _chan_for(db, "bob", ch.id)
    assert row["last_message_seq"] == m1["seq"]
    assert row["last_message"]["content"] == "first"

    refreshed = await db.get(Channel, ch.id)
    await db.refresh(refreshed)
    assert refreshed.last_preview == "first"


async def test_channels_sorted_by_last_activity(db):
    old = await _channel(db)
    new = await service.create_channel(db, "newer", "public", "alice", member_ids=["bob"])
    # old 채널에 더 최근 메시지 → 위로 올라와야 한다
    await service.create_message(db, old.id, "alice", "bump")
    ids = [c["id"] for c in await service.get_user_channels(db, "bob")]
    assert ids.index(old.id) < ids.index(new.id)
