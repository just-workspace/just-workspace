"""홈 대시보드 다시 그리기(handover 17) — 배치 저장 검사 · 오늘 브리핑 칩 조회 · 이어서 하기 · 팀 · AI 브리핑."""

import itertools
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.dashboard import home, sources
from app.dashboard.layout import CARD_KEYS, normalize_layout
from app.dashboard.models import DashBriefing
from app.db.models import (
    Base, Board, Channel, ChannelMember, Message, Post, PostBookmark, SystemSetting, TaskDB, User, UserPref,
    WikiPage, WikiPageVersion, WikiSpace, WikiSpaceMember,
)
from app.me import prefs as mp

TABLES = [t.__table__ for t in (
    User, UserPref, SystemSetting, Channel, ChannelMember, Message, TaskDB, Board, Post, PostBookmark,
    WikiSpace, WikiPage, WikiPageVersion, WikiSpaceMember, DashBriefing,
)]
_seq = itertools.count(1)
NOW = datetime.now(timezone.utc)


@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        for uid in ("alice", "bob", "carol", "dave"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.title()))
        await s.commit()
        yield s
    await engine.dispose()


def _msg(ch: str, who: str, ago_days: float = 0, content: str = "x") -> Message:
    return Message(id=str(uuid.uuid4()), seq=next(_seq), channel_id=ch, sender_id=who, content=content,
                   created_at=NOW - timedelta(days=ago_days))


# ─── 배치 모양 ───

def test_layout_normalize_drops_unknown_and_duplicates():
    v = normalize_layout({"order": ["inbox", "nope", "inbox", "today"], "hidden": ["store", 3],
                          "size": {"inbox": 1, "today": 3, "x": 2, "cont": True}, "locked": ["notice"]})
    assert v == {"v": 1, "order": ["inbox", "today"], "hidden": ["store"], "size": {"inbox": 1}}
    # 관리자 기본 배치만 고정 카드를 가진다
    assert normalize_layout({"locked": ["notice", "zzz"]}, allow_locked=True)["locked"] == ["notice"]
    with pytest.raises(ValueError):
        normalize_layout(["inbox"])
    assert "notice" in CARD_KEYS and "start" in CARD_KEYS


@pytest.mark.asyncio
async def test_prefs_accepts_dash_layout_and_normalizes(db):
    alice = await db.get(User, "alice")
    r = await mp.patch_prefs({"dash.layout": {"order": ["today", "bad"], "size": {"today": 2}}}, user=alice, db=db)
    assert r["prefs"]["dash.layout"] == {"v": 1, "order": ["today"], "hidden": [], "size": {"today": 2}}
    with pytest.raises(HTTPException) as e:
        await mp.patch_prefs({"dash.layout": "inbox"}, user=alice, db=db)
    assert e.value.status_code == 400
    # dash. 아래 다른 키도 규칙(접두사) 안
    assert mp.key_allowed("dash.layout") and not mp.key_allowed("dashx.layout")


def test_admin_default_layout_text():
    from app.admin.router import APPCFG_MAXLEN, normalize_dash_layout_text

    assert APPCFG_MAXLEN["dash.layout"] >= 1000
    out = json.loads(normalize_dash_layout_text('{"order":["notice","inbox"],"locked":["notice"],"hidden":["git"]}'))
    assert out["locked"] == ["notice"] and out["order"] == ["notice", "inbox"]
    with pytest.raises(HTTPException):
        normalize_dash_layout_text("{not json")
    with pytest.raises(HTTPException):
        normalize_dash_layout_text("[1,2]")


# ─── 오늘 브리핑 칩 ───

def test_parse_day_range_rejects_far_or_odd_ranges():
    s = NOW.replace(hour=15, minute=0, second=0, microsecond=0) - timedelta(days=1)
    e = s + timedelta(days=1)
    assert sources.parse_day_range(s.isoformat(), e.isoformat()) == (s, e)
    far = NOW + timedelta(days=5)
    ds, de = sources.parse_day_range(far.isoformat(), (far + timedelta(days=1)).isoformat())
    assert ds <= NOW < de   # 먼 날짜는 받지 않고 UTC 오늘
    ds, de = sources.parse_day_range(s.isoformat(), (s + timedelta(days=4)).isoformat())
    assert de - ds == timedelta(days=1)
    assert sources.parse_day_range(None, "x")[1] - sources.parse_day_range(None, "x")[0] == timedelta(days=1)


def test_next_meeting_and_link():
    ev = lambda i, st, en, **k: {"id": i, "title": i, "_start": NOW + timedelta(minutes=st), "_end": NOW + timedelta(minutes=en), **k}  # noqa: E731
    events = [
        ev("allday", -600, 600, all_day=True),
        ev("done", -120, -60),
        ev("later", 60, 90),
        ev("soon", 10, 40, location="회의실 https://ws.example/meetings/room/abc"),
    ]
    nm = sources.next_meeting(events, NOW)
    assert nm["title"] == "soon" and nm["join_url"] == "https://ws.example/meetings/room/abc"
    assert sources.meeting_link({"description": "링크 /meetings/room/x-1 입니다"}) == "/meetings/room/x-1"
    assert sources.next_meeting([ev("done", -60, -1)], NOW) is None


@pytest.mark.asyncio
async def test_task_counts_visible_open_top_level(db):
    s = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    e = s + timedelta(days=1)
    def t(**k):
        return TaskDB(id=str(uuid.uuid4()), title="t", **k)
    db.add_all([
        t(user_id="alice", due_date=s + timedelta(hours=10)),                    # 오늘
        t(user_id="bob", assignee_id="alice", due_date=s + timedelta(hours=11)),  # 담당 — 오늘
        t(user_id="alice", due_date=s - timedelta(days=2)),                      # 지남
        t(user_id="alice", due_date=s - timedelta(days=1), status="done"),       # 끝남 — 안 셈
        t(user_id="bob", due_date=s + timedelta(hours=10)),                      # 남의 것 — 안 셈
        t(user_id="alice", due_date=s + timedelta(days=3)),                      # 나중
    ])
    await db.commit()
    assert await sources.task_counts(db, "alice", s, e) == (2, 1)


# ─── 팀 ───

@pytest.mark.asyncio
async def test_frequent_people_dm_weighted_and_only_my_active_channels(db):
    db.add_all([
        Channel(id="dm-ab", name="alice,bob", type="dm", created_by="alice"),
        Channel(id="dev", name="개발", type="public", created_by="alice"),
        Channel(id="quiet", name="조용", type="public", created_by="alice"),
    ])
    for ch, who in (("dm-ab", "alice"), ("dm-ab", "bob"), ("dev", "alice"), ("dev", "carol"), ("quiet", "alice"), ("quiet", "dave")):
        db.add(ChannelMember(channel_id=ch, user_id=who))
    db.add_all([_msg("dm-ab", "bob"), _msg("dm-ab", "alice")])           # bob: DM 2 × 3 = 6
    db.add_all([_msg("dev", "alice")] + [_msg("dev", "carol") for _ in range(4)])  # carol: 4
    db.add_all([_msg("quiet", "dave") for _ in range(9)])                # 내가 안 쓴 채널 — 안 셈
    db.add_all([_msg("dev", "carol", ago_days=40) for _ in range(9)])    # 30일 밖
    await db.commit()
    assert await home.frequent_people(db, "alice") == [("bob", 6), ("carol", 4)]


# ─── 이어서 하기 ───

@pytest.mark.asyncio
async def test_recent_wiki_only_visible_and_touched_with_last_editor(db):
    db.add_all([
        WikiSpace(id="pub", name="공개", slug="pub", visibility="public", owner_id="bob"),
        WikiSpace(id="priv", name="비공개", slug="priv", visibility="private", owner_id="bob"),
    ])
    db.add_all([
        WikiPage(id="p1", space_id="pub", title="런북", slug="r", author_id="alice", updated_at=NOW),
        WikiPage(id="p2", space_id="pub", title="남의 글", slug="o", author_id="bob", updated_at=NOW),
        WikiPage(id="p3", space_id="priv", title="못 보는 글", slug="h", author_id="alice", updated_at=NOW),
    ])
    db.add_all([
        WikiPageVersion(id="v1", page_id="p1", title="런북", author_id="alice", version_number=1),
        WikiPageVersion(id="v2", page_id="p1", title="런북", author_id="bob", version_number=2),
    ])
    await db.commit()
    rows = await home._recent_wiki(db, "alice", 5)
    assert [(r["name"], r["reason"], r["actor"]) for r in rows] == [("런북", "edited_by", "Bob")]
    assert rows[0]["to"] == "/wiki?space=pub&page=p1"


@pytest.mark.asyncio
async def test_favorites_include_board_bookmarks(db, monkeypatch):
    monkeypatch.setattr(home, "is_module_enabled", lambda m: m == "board")
    db.add(Board(id="b1", name="자유게시판", slug="free"))
    db.add_all([Post(id="po1", board_id="b1", author_id="bob", title="워크숍 투표", content="x"),
                Post(id="po2", board_id="b1", author_id="bob", title="지운 글", content="x", is_deleted=True)])
    db.add_all([PostBookmark(post_id="po1", user_id="alice"), PostBookmark(post_id="po2", user_id="alice"),
                PostBookmark(post_id="po1", user_id="bob")])
    await db.commit()
    alice = await db.get(User, "alice")
    rows = await home._favorites(db, alice, 8)
    assert [(r["name"], r["reason"], r["to"]) for r in rows] == [("워크숍 투표", "bookmarked", "/board/b1/po1")]


@pytest.mark.asyncio
async def test_unread_chat_messages_only_my_channels_after_read_pointer(db, monkeypatch):
    monkeypatch.setattr(sources, "is_module_enabled", lambda m: True)
    db.add_all([Channel(id="dev", name="개발", type="public", created_by="bob"),
                Channel(id="other", name="남의 채널", type="public", created_by="bob")])
    old = _msg("dev", "bob", content="읽은 것")
    db.add_all([old, ChannelMember(channel_id="dev", user_id="alice", last_read_seq=old.seq),
                ChannelMember(channel_id="other", user_id="bob")])
    db.add_all([_msg("dev", "bob", content="새 글"), _msg("dev", "alice", content="내 글"), _msg("other", "bob", content="못 보는 글")])
    await db.commit()
    rows = await sources.unread_chat_messages(db, "alice")
    assert [r["content"] for r in rows] == ["새 글"] and rows[0]["channel_name"] == "개발"


@pytest.mark.asyncio
async def test_discover_channels_public_not_joined_and_join_only_public(db, monkeypatch):
    monkeypatch.setattr(home, "is_module_enabled", lambda m: True)
    db.add_all([
        Channel(id="pub1", name="개발", type="public", created_by="bob"),
        Channel(id="pub2", name="랜덤", type="public", created_by="bob"),
        Channel(id="mine", name="내 채널", type="public", created_by="alice"),
        Channel(id="priv", name="비공개", type="private", created_by="bob"),
        Channel(id="arch", name="보관", type="public", created_by="bob", is_archived=True),
    ])
    for ch, who in (("pub1", "bob"), ("pub1", "carol"), ("pub2", "bob"), ("mine", "alice"), ("priv", "bob"), ("arch", "bob")):
        db.add(ChannelMember(channel_id=ch, user_id=who))
    db.add_all([_msg("pub2", "bob"), _msg("pub2", "bob")])
    await db.commit()
    items = await home.discover_channels(db, "alice")
    assert [(i["id"], i["members"]) for i in items] == [("pub1", 2), ("pub2", 1)]
    assert items[1]["messages_today"] == 2

    alice = await db.get(User, "alice")
    with pytest.raises(HTTPException) as e:
        await home.join_discover_channel("priv", user=alice, db=db)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException):
        await home.join_discover_channel("arch", user=alice, db=db)
    r = await home.join_discover_channel("pub1", user=alice, db=db)
    assert r["joined"] is True
    assert [i["id"] for i in await home.discover_channels(db, "alice")] == ["pub2"]
    assert (await home.join_discover_channel("pub1", user=alice, db=db))["joined"] is False
