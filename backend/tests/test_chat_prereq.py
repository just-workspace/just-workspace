"""채팅 시안 전제 기능 — 안 읽음 표시 · 스레드 팔로우 · 프레즌스 상태 · 채널 알림 설정 · 핀 · 임시글.

test_chat_seq_unread.py 와 같은 방식(SQLite, 채팅 테이블만)으로 service 함수를 직접 부른다.
Redis 가 없으므로 notify.py 의 발행·접속 조회는 monkeypatch 로 기록만 한다.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.chat import notify, presence, service
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
        for uid in ("alice", "bob", "carol"):
            session.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x",
                             display_name=uid.capitalize()))
        await session.commit()
        yield session
    await engine.dispose()


@pytest.fixture()
def events(monkeypatch):
    """notify.py 가 내보내는 이벤트·푸시를 기록한다(Redis 없음)."""
    sent = {"user": [], "channel": [], "push": [], "online": set()}

    async def _to_user(uid, ev):
        sent["user"].append((uid, ev))

    async def _to_channel(cid, ev):
        sent["channel"].append((cid, ev))

    async def _connected(ids):
        return {u for u in ids if u in sent["online"]}

    async def _push(uid, title, body, url):
        sent["push"].append((uid, title))

    async def _is_connected(uid):
        return uid in sent["online"]

    monkeypatch.setattr(notify, "emit_to_user", _to_user)
    monkeypatch.setattr(notify, "emit_to_channel", _to_channel)
    monkeypatch.setattr(notify, "connected_users", _connected)
    monkeypatch.setattr(notify, "_push", _push)
    # 멘션 알림(app/notifications/service.py)의 실시간·푸시도 막는다
    from app.notifications import service as nsvc
    import app.realtime.events as ev
    monkeypatch.setattr(ev, "emit_to_user", _to_user)
    monkeypatch.setattr(ev, "is_connected", _is_connected)
    monkeypatch.setattr(nsvc, "_push", lambda d: _push(d["user_id"], d["title"], "", ""))
    return sent


async def _channel(db, members=("bob",), name="general", type="public", owner="alice"):
    return await service.create_channel(db, name, type, owner, member_ids=list(members))


async def _chan_for(db, user_id, channel_id):
    return next(c for c in await service.get_user_channels(db, user_id) if c["id"] == channel_id)


async def _settle():
    """asyncio.create_task 로 띄운 푸시 코루틴이 돌 틈을 준다."""
    import asyncio
    await asyncio.sleep(0)
    await asyncio.sleep(0)


# ─── 1. 안 읽음으로 표시 ───


async def test_mark_unread_rewinds_pointer_and_recounts(db, events):
    ch = await _channel(db, members=("bob", "carol"))
    m1 = await service.create_message(db, ch.id, "alice", "one")
    m2 = await service.create_message(db, ch.id, "alice", "@bob two")
    await service.create_notifications_for_mentions(db, m2, ch.id, "alice", ["bob"])
    m3 = await service.create_message(db, ch.id, "alice", "three")
    await service.mark_read(db, ch.id, "bob", m3["id"])
    assert (await _chan_for(db, "bob", ch.id))["unread_count"] == 0

    # m2 부터 안 읽음 → m2, m3 미읽음, 멘션 1
    assert await service.mark_unread(db, ch.id, "bob", m2["id"]) == m2["seq"] - 1
    row = await _chan_for(db, "bob", ch.id)
    assert row["unread_count"] == 2 and row["mention_count"] == 1
    assert row["last_read_seq"] == m2["seq"] - 1

    state = await service.get_unread_state(db, "bob", ch.id)
    assert state == {"unread_count": 2, "mention_count": 1, "group_mention": False}

    # 더 앞(m1)으로도 되감긴다 — mark_read 와 달리 뒤로 가는 게 목적
    assert await service.mark_unread(db, ch.id, "bob", m1["id"]) == m1["seq"] - 1
    assert (await _chan_for(db, "bob", ch.id))["unread_count"] == 3
    # 이미 그보다 앞이면 아무것도 안 바뀐다
    assert await service.mark_unread(db, ch.id, "bob", m3["id"]) is None
    # 다른 채널 메시지·없는 id
    assert await service.mark_unread(db, ch.id, "bob", "nope") is None

    # 그 뒤 mark_read 는 여전히 단조 증가로 동작
    assert await service.mark_read(db, ch.id, "bob", m3["id"]) == m3["seq"]
    assert (await _chan_for(db, "bob", ch.id))["unread_count"] == 0


# ─── 2. 스레드 ───


async def test_reply_autofollows_root_author_and_replier(db, events):
    ch = await _channel(db, members=("bob", "carol"))
    root = await service.create_message(db, ch.id, "alice", "root")
    r1 = await service.create_message(db, ch.id, "bob", "reply1", parent_id=root["id"])

    threads_alice = await service.get_my_threads(db, "alice")
    threads_bob = await service.get_my_threads(db, "bob")
    assert [t["id"] for t in threads_alice] == [root["id"]]
    assert [t["id"] for t in threads_bob] == [root["id"]]
    # 루트 작성자는 답글을 아직 안 읽었고, 답글 작성자는 자기 답글을 읽은 것
    assert threads_alice[0]["unread_replies"] == 1 and threads_alice[0]["followed"] is True
    assert threads_bob[0]["unread_replies"] == 0
    assert threads_alice[0]["last_reply"]["id"] == r1["id"]
    assert threads_alice[0]["last_reply"]["sender_name"] == "Bob"
    assert threads_alice[0]["reply_count"] == 1
    # carol 은 참여하지 않았다
    assert await service.get_my_threads(db, "carol") == []

    # 답글 안에서 멘션된 사람도 자동 팔로우
    r2 = await service.create_message(db, ch.id, "alice", "@carol look", parent_id=root["id"])
    await service.create_notifications_for_mentions(db, r2, ch.id, "alice", ["carol"])
    carol = await service.get_my_threads(db, "carol")
    assert len(carol) == 1 and carol[0]["unread_replies"] == 2

    # 총 미읽음. alice 는 r2 를 직접 썼으니 그 앞의 r1 까지 읽은 것으로 친다
    assert await service.get_thread_unread_count(db, "carol") == {"threads": 1, "replies": 2}
    assert await service.get_thread_unread_count(db, "alice") == {"threads": 0, "replies": 0}
    assert await service.get_thread_unread_count(db, "bob") == {"threads": 1, "replies": 1}

    # 읽음 → 0, 그리고 포인터는 마지막 답글 seq
    assert await service.mark_thread_read(db, "carol", root["id"]) == r2["seq"]
    assert await service.get_thread_unread_count(db, "carol") == {"threads": 0, "replies": 0}
    st = await service.get_thread_follow_state(db, "carol", root["id"])
    assert st == {"followed": True, "unread_replies": 0, "last_read_seq": r2["seq"]}
    # 이미 더 앞까지 읽은 사람에게 옛 seq 로 읽음이 오면 포인터는 그대로
    assert await service.mark_thread_read(db, "carol", root["id"], up_to_seq=r1["seq"]) == r2["seq"]
    # 답글이 없는 스레드는 None
    lonely = await service.create_message(db, ch.id, "alice", "lonely")
    assert await service.mark_thread_read(db, "bob", lonely["id"]) is None


async def test_unfollow_sticks_until_user_replies(db):
    ch = await _channel(db, members=("bob",))
    root = await service.create_message(db, ch.id, "alice", "root")
    await service.create_message(db, ch.id, "bob", "r1", parent_id=root["id"])

    res = await service.set_thread_follow(db, "alice", root["id"], False)
    assert res == {"root_id": root["id"], "channel_id": ch.id, "followed": False}
    assert await service.get_my_threads(db, "alice") == []
    # 남의 답글은 끊긴 팔로우를 되살리지 않는다
    await service.create_message(db, ch.id, "bob", "r2", parent_id=root["id"])
    assert await service.get_my_threads(db, "alice") == []
    assert await service.get_thread_unread_count(db, "alice") == {"threads": 0, "replies": 0}
    # 본인이 답글을 쓰면 다시 켜진다
    await service.create_message(db, ch.id, "alice", "r3", parent_id=root["id"])
    assert [t["id"] for t in await service.get_my_threads(db, "alice")] == [root["id"]]
    # 다시 끊고 명시적으로 켜기
    await service.set_thread_follow(db, "alice", root["id"], False)
    await service.set_thread_follow(db, "alice", root["id"], True)
    assert (await service.get_thread_follow_state(db, "alice", root["id"]))["followed"] is True
    # 답글은 팔로우 대상이 아니다
    reply = (await service.get_thread_messages(db, root["id"]))[0]
    assert await service.set_thread_follow(db, "bob", reply["id"], True) is None


async def test_my_threads_ordered_by_last_reply(db):
    ch = await _channel(db, members=("bob",))
    a = await service.create_message(db, ch.id, "alice", "A")
    b = await service.create_message(db, ch.id, "alice", "B")
    await service.create_message(db, ch.id, "bob", "rb", parent_id=b["id"])
    await service.create_message(db, ch.id, "bob", "ra", parent_id=a["id"])
    assert [t["id"] for t in await service.get_my_threads(db, "alice")] == [a["id"], b["id"]]


async def test_also_to_channel_shows_reply_in_timeline_and_unread(db):
    ch = await _channel(db, members=("bob",))
    root = await service.create_message(db, ch.id, "alice", "root")
    await service.mark_read(db, ch.id, "bob", root["id"])
    quiet = await service.create_message(db, ch.id, "alice", "quiet", parent_id=root["id"])
    loud = await service.create_message(
        db, ch.id, "alice", "loud", parent_id=root["id"], thread_broadcast=True,
    )
    assert quiet["thread_broadcast"] is False and loud["thread_broadcast"] is True
    # 원 메시지에 also_to_channel 이 와도 무시
    plain = await service.create_message(db, ch.id, "alice", "plain", thread_broadcast=True)
    assert plain["thread_broadcast"] is False

    msgs, _ = await service.get_messages(db, ch.id)
    contents = [m["content"] for m in msgs]
    assert "loud" in contents and "quiet" not in contents
    assert msgs[-2]["parent_id"] == root["id"]   # loud 는 parent_id 를 유지한 채 타임라인에 보인다

    bob = await _chan_for(db, "bob", ch.id)
    assert bob["unread_count"] == 2   # loud + plain
    # 스레드 패널엔 둘 다 있다
    assert [m["content"] for m in await service.get_thread_messages(db, root["id"])] == ["quiet", "loud"]

    # 채널의 마지막 메시지 포인터도 브로드캐스트 답글을 친다
    await service.soft_delete_message(db, plain["id"])
    assert (await _chan_for(db, "bob", ch.id))["last_message"]["content"] == "loud"


async def test_thread_update_goes_to_followers_except_sender(db, events):
    ch = await _channel(db, members=("bob", "carol"))
    root = await service.create_message(db, ch.id, "alice", "root")
    r1 = await service.create_message(db, ch.id, "bob", "r1", parent_id=root["id"])
    await notify.after_message_created(db, r1, ch.id, "bob", "r1")

    ups = [(u, e) for u, e in events["user"] if e["type"] == "thread_update"]
    assert [u for u, _ in ups] == ["alice"]
    assert ups[0][1]["root_id"] == root["id"] and ups[0][1]["channel_id"] == ch.id
    assert ups[0][1]["reply"]["id"] == r1["id"] and ups[0][1]["unread_replies"] == 1
    # 일반 답글은 채널 'all' 푸시 대상이 아니다 — 오프라인 스레드 팔로워(alice) 답글 푸시만 간다
    assert [(u, t) for u, t in events["push"]] == [("alice", "#general · Bob님의 스레드 답글")]
    # 새 메시지 이벤트는 여전히 채널로
    assert events["channel"][0][1]["type"] == "new_message"


# ─── 3. 프레즌스 상태 ───


def _status(**kw):
    s = UserStatus(user_id="u", mode=kw.pop("mode", "auto"), **kw)
    return s


def test_effective_state_matrix():
    now = datetime.now(timezone.utc)
    future = now + timedelta(hours=1)
    past = now - timedelta(hours=1)
    assert presence.effective_state(None, connected=False) == "offline"
    assert presence.effective_state(None, connected=True) == "online"
    assert presence.effective_state(_status(mode="invisible"), True) == "offline"
    assert presence.effective_state(_status(mode="away"), True) == "away"
    assert presence.effective_state(_status(mode="away"), False) == "offline"
    assert presence.effective_state(_status(mode="dnd"), True) == "dnd"
    # dnd_until 이 미래면 모드가 auto 라도 dnd, 지났으면 풀린다
    assert presence.effective_state(_status(mode="auto", dnd_until=future), True, now) == "dnd"
    assert presence.effective_state(_status(mode="dnd", dnd_until=past), True, now) == "online"
    assert presence.is_dnd(_status(mode="dnd", dnd_until=future), now) is True
    assert presence.is_dnd(_status(mode="dnd", dnd_until=past), now) is False
    assert presence.is_dnd(_status(mode="away"), now) is False


def test_custom_status_expiry_ignored_on_read():
    now = datetime.now(timezone.utc)
    live = _status(custom_emoji="🏖", custom_text="휴가", custom_expires_at=now + timedelta(days=1))
    dead = _status(custom_emoji="🏖", custom_text="휴가", custom_expires_at=now - timedelta(seconds=1))
    assert presence.custom_status(live, now) == ("🏖", "휴가")
    assert presence.custom_status(dead, now) == (None, None)
    assert presence.presence_entry(dead, True, now) == {"state": "online", "emoji": None, "text": None}
    assert presence.presence_entry(_status(mode="dnd", custom_text="집중"), True, now) == {
        "state": "dnd", "emoji": None, "text": "집중",
    }


async def test_set_status_roundtrip_and_push_gate(db, monkeypatch):
    row = await presence.set_status(db, "alice", mode="dnd", custom_text="집중 중", custom_emoji="🎧")
    d = presence.status_to_dict(row, connected=True)
    assert d["mode"] == "dnd" and d["state"] == "dnd" and d["custom_text"] == "집중 중"
    # 잘못된 모드는 무시
    row = await presence.set_status(db, "alice", mode="bogus")
    assert row.mode == "dnd"
    # 비우기
    row = await presence.set_status(db, "alice", custom_text=None, custom_emoji=None)
    assert presence.status_to_dict(row, False)["custom_text"] is None
    assert presence.status_to_dict(row, False)["state"] == "offline"

    # push_allowed 는 자기 세션을 열어 DND 를 본다 — 테스트 DB 로 바꿔 끼운다
    import app.db.session as sess
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _fake_session():
        yield db

    monkeypatch.setattr(sess, "async_session", _fake_session)
    assert await presence.push_allowed("alice") is False
    assert await presence.push_allowed("bob") is True   # 행 없음 = auto
    await presence.set_status(db, "alice", mode="auto")
    assert await presence.push_allowed("alice") is True


# ─── 4. 채널별 알림 설정 ───


async def test_notify_level_defaults_and_update(db):
    pub = await _channel(db, members=("bob",))
    dm = await service.get_or_create_dm(db, "alice", "bob")
    assert (await _chan_for(db, "bob", pub.id))["notify_level"] == "mentions"
    assert (await _chan_for(db, "bob", dm.id))["notify_level"] == "all"
    assert (await _chan_for(db, "bob", pub.id))["muted"] is False

    res = await service.update_channel_prefs(db, pub.id, "bob", notify_level="all", muted=True)
    assert {k: res[k] for k in ("channel_id", "notify_level", "muted")} ==         {"channel_id": pub.id, "notify_level": "all", "muted": True}
    # 기기 알림 세부 기본값이 같이 온다
    assert res["push"] is True and res["thread_replies"] is True and res["email"] is False
    row = await _chan_for(db, "bob", pub.id)
    assert row["notify_level"] == "all" and row["muted"] is True
    # 비멤버
    assert await service.update_channel_prefs(db, pub.id, "carol", muted=True) is None
    # 한 쿼리 멤버 목록
    members = {m["user_id"]: m for m in await service.get_members_for_notify(db, pub.id)}
    assert members["bob"]["notify_level"] == "all" and members["bob"]["muted"] is True
    assert members["alice"]["notify_level"] == "mentions"


async def test_push_rules_all_mentions_none_muted(db, events):
    ch = await _channel(db, members=("bob", "carol"))
    await service.update_channel_prefs(db, ch.id, "bob", notify_level="all")
    await service.update_channel_prefs(db, ch.id, "carol", notify_level="none")

    # 일반 메시지: 'all' 인 bob 만(오프라인) 푸시, 'mentions' 기본인 alice 는 보낸 사람
    m = await service.create_message(db, ch.id, "alice", "hello")
    await notify.after_message_created(db, m, ch.id, "alice", "hello")
    await _settle()
    assert [p[0] for p in events["push"]] == ["bob"]
    assert events["push"][0][1] == "#general · Alice"

    # 접속 중이면 안 간다
    events["push"].clear()
    events["online"].add("bob")
    m = await service.create_message(db, ch.id, "alice", "hello again")
    await notify.after_message_created(db, m, ch.id, "alice", "hello again")
    await _settle()
    assert events["push"] == []
    events["online"].clear()

    # muted 면 'all' 이어도 안 간다
    await service.update_channel_prefs(db, ch.id, "bob", muted=True)
    m = await service.create_message(db, ch.id, "alice", "muted?")
    await notify.after_message_created(db, m, ch.id, "alice", "muted?")
    await _settle()
    assert events["push"] == []

    # 멘션: 'none' 인 carol 은 인앱 알림·배지는 받고 푸시는 안 받는다
    m = await service.create_message(db, ch.id, "alice", "@carol @bob ping")
    await notify.after_message_created(db, m, ch.id, "alice", "@carol @bob ping")
    await _settle()
    assert sorted(p[0] for p in events["push"]) == ["bob"]   # muted 는 멘션 푸시를 막지 않는다
    notifs = [u for u, e in events["user"] if e["type"] == "notification"]
    assert sorted(notifs) == ["bob", "carol"]
    assert (await _chan_for(db, "carol", ch.id))["mention_count"] == 1


async def test_dm_push_respects_none(db, events):
    dm = await service.get_or_create_dm(db, "alice", "bob")
    m = await service.create_message(db, dm.id, "alice", "hi")
    await notify.after_message_created(db, m, dm.id, "alice", "hi")
    await _settle()
    assert [p for p in events["push"]] == [("bob", "Alice")]

    events["push"].clear()
    await service.update_channel_prefs(db, dm.id, "bob", notify_level="none")
    m = await service.create_message(db, dm.id, "alice", "hi2")
    await notify.after_message_created(db, m, dm.id, "alice", "hi2")
    await _settle()
    assert events["push"] == []


# ─── 5. 핀 ───


async def test_pin_unpin_and_list(db):
    ch = await _channel(db, members=("bob",))
    m1 = await service.create_message(db, ch.id, "alice", "one")
    m2 = await service.create_message(db, ch.id, "alice", "two")
    assert m1["pinned_at"] is None and m1["pinned_by"] is None

    d = await service.set_pinned(db, m1["id"], "bob", True)
    assert d["pinned_at"] is not None and d["pinned_by"] == "bob"
    await service.set_pinned(db, m2["id"], "alice", True)
    # 다시 핀해도 처음 핀한 사람·시각 유지
    again = await service.set_pinned(db, m1["id"], "alice", True)
    assert again["pinned_by"] == "bob" and again["pinned_at"] == d["pinned_at"]

    pins = await service.get_pinned_messages(db, ch.id)
    assert [p["id"] for p in pins] == [m2["id"], m1["id"]]   # 최근 핀 순
    assert pins[1]["pinned_by_name"] == "Bob"

    msgs, _ = await service.get_messages(db, ch.id)
    assert {m["id"]: m["pinned_by"] for m in msgs if m["pinned_at"]} == {m1["id"]: "bob", m2["id"]: "alice"}

    un = await service.set_pinned(db, m1["id"], "alice", False)
    assert un["pinned_at"] is None and un["pinned_by"] is None
    assert [p["id"] for p in await service.get_pinned_messages(db, ch.id)] == [m2["id"]]

    # 삭제된 메시지는 핀 목록에서 빠지고 핀도 못 한다
    await service.soft_delete_message(db, m2["id"])
    assert await service.get_pinned_messages(db, ch.id) == []
    assert await service.set_pinned(db, m2["id"], "alice", True) is None
    assert await service.set_pinned(db, "nope", "alice", True) is None


# ─── 6. 임시글 ───


async def test_draft_upsert_delete_and_cleared_on_send(db, events):
    ch = await _channel(db, members=("bob",))
    root = await service.create_message(db, ch.id, "alice", "root")

    d = await service.upsert_draft(db, "bob", ch.id, None, "쓰는 중")
    assert d["channel_id"] == ch.id and d["parent_id"] is None and d["content"] == "쓰는 중"
    d2 = await service.upsert_draft(db, "bob", ch.id, None, "쓰는 중...")
    assert d2["content"] == "쓰는 중..."
    t = await service.upsert_draft(db, "bob", ch.id, root["id"], "스레드 답글 초안")
    assert t["parent_id"] == root["id"]
    drafts = await service.get_drafts(db, "bob")
    assert len(drafts) == 2   # 채널 입력창 1 + 스레드 1 (채널 쪽은 갱신됐을 뿐)
    assert await service.get_drafts(db, "alice") == []

    # 빈 content 는 삭제
    assert await service.upsert_draft(db, "bob", ch.id, root["id"], "   ") is None
    assert [x["parent_id"] for x in await service.get_drafts(db, "bob")] == [None]

    # 메시지를 보내면 그 자리 임시글이 지워지고 draft_update(content null) 가 내 기기로
    m = await service.create_message(db, ch.id, "bob", "쓰는 중...")
    await notify.after_message_created(db, m, ch.id, "bob", m["content"])
    assert await service.get_drafts(db, "bob") == []
    du = [e for u, e in events["user"] if e["type"] == "draft_update" and u == "bob"]
    assert du == [{"type": "draft_update", "channel_id": ch.id, "parent_id": None,
                   "content": None, "updated_at": None}]

    # 없는 걸 지우면 False
    assert await service.delete_draft(db, "bob", ch.id, None) is False
