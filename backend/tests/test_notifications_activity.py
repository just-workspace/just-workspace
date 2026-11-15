"""알림 — 보낸 사람·행동 필드, 타입·안읽음 필터, 타입별 설정(NotificationPref) 반영, 방해 금지 일정, 시험 푸시."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base, Notification, NotificationPref, PushSubscription, User, UserPref
from app.notifications import dnd
from app.notifications import router as nr
from app.notifications import service as nsvc

TABLES = [t.__table__ for t in (User, Notification, NotificationPref, UserPref, PushSubscription)]


@pytest.fixture()
async def db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    import app.db.session as dbs
    monkeypatch.setattr(dbs, "async_session", factory)   # dnd.schedule_blocks 가 쓰는 세션
    async with factory() as s:
        for uid in ("alice", "bob"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.capitalize()))
        await s.commit()
        yield s
    await engine.dispose()


@pytest.fixture()
def delivered(monkeypatch):
    sent = {"realtime": [], "push": []}
    import app.realtime.events as ev

    async def emit(uid, payload):
        sent["realtime"].append(uid)

    async def connected(uid):
        return False

    async def push(d):
        sent["push"].append(d["user_id"])

    monkeypatch.setattr(ev, "emit_to_user", emit)
    monkeypatch.setattr(ev, "is_connected", connected)
    monkeypatch.setattr(nsvc, "_push", push)
    return sent


@pytest.mark.asyncio
async def test_actor_and_actions_roundtrip(db, delivered):
    d = await nsvc.create_notification(
        db, "bob", "meeting_invite", "회의 초대", actor_id="alice", actor_name="Alice",
        action_url="/meetings",
        actions=[{"id": "accept", "label": "수락", "url": "/api/meetings/by-id/1/rsvp", "body": {"response": "accepted"}},
                 {"id": "evil", "label": "x", "url": "https://evil.example/"}],
    )
    assert d["type"] == "meeting_invite" and d["actor_name"] == "Alice"
    assert [a["id"] for a in d["actions"]] == ["accept"]          # 외부 URL 행동은 버린다
    assert d["actions"][0]["method"] == "POST"
    # 예전 호출(추가 인자 없음)도 그대로
    old = await nsvc.create_notification(db, "bob", "mention", "멘션")
    assert old["actor_id"] is None and old["actions"] is None and old["action_url"] is None


@pytest.mark.asyncio
async def test_type_and_unread_filters_only_mine(db, delivered):
    await nsvc.create_notification(db, "bob", "mention", "a")
    await nsvc.create_notification(db, "bob", "task_assigned", "b")
    x = await nsvc.create_notification(db, "bob", "thread_reply", "c")
    await nsvc.create_notification(db, "alice", "mention", "남의 것")
    await nsvc.mark_as_read(db, "bob", x["id"])
    bob = await db.get(User, "bob")

    res = await nr.list_notifications(unread_only=False, limit=20, offset=0, type="mention,thread_reply",
                                      unread=None, user=bob, db=db)
    assert {n.title for n in res["notifications"]} == {"a", "c"}
    res = await nr.list_notifications(unread_only=False, limit=20, offset=0, type="mention,thread_reply",
                                      unread=True, user=bob, db=db)
    assert [n.title for n in res["notifications"]] == ["a"]
    # 남의 알림은 섞이지 않는다
    res = await nr.list_notifications(unread_only=False, limit=20, offset=0, type=None, unread=None, user=bob, db=db)
    assert "남의 것" not in {n.title for n in res["notifications"]}


@pytest.mark.asyncio
async def test_new_types_are_kept_and_unknown_falls_back(db, delivered):
    for t in ("thread_reply", "new_mail", "board_must_read", "meeting_invite"):
        assert (await nsvc.create_notification(db, "bob", t, t))["type"] == t
    assert (await nsvc.create_notification(db, "bob", "whatever", "?"))["type"] == "system"
    prefs = await nr.get_prefs(user=await db.get(User, "bob"), db=db)
    assert [p["type"] for p in prefs["prefs"]] == nsvc.NOTIFICATION_TYPES


@pytest.mark.asyncio
async def test_type_prefs_gate_push_and_in_app(db, delivered):
    db.add(NotificationPref(user_id="bob", type="task_assigned", in_app=True, push=False, email=True))
    db.add(NotificationPref(user_id="bob", type="new_mail", in_app=False, push=True, email=True))
    await db.commit()
    a = await nsvc.create_notification(db, "bob", "task_assigned", "푸시 끔")
    b = await nsvc.create_notification(db, "bob", "new_mail", "인앱 끔")
    await nsvc.create_notification(db, "bob", "mention", "기본")
    import asyncio
    await asyncio.sleep(0)
    assert a["is_read"] is False
    assert b["is_read"] is True                       # 인앱 끔 → 배지에 안 잡힌다
    assert delivered["realtime"].count("bob") == 2    # 인앱 끈 것은 실시간도 없음
    assert await nsvc.get_unread_count(db, "bob") == 2


def test_quiet_hours_cross_midnight():
    sched = {"enabled": True, "days": [4], "start": "22:00", "end": "08:00", "timezone": "Asia/Seoul"}
    def kst(y, m, d, h, mi=0):
        return datetime(y, m, d, h, mi, tzinfo=timezone(timedelta(hours=9)))
    # 2026-10-16 은 금요일
    assert dnd.in_quiet_hours(sched, kst(2026, 10, 16, 23)) is True      # 금 23시
    assert dnd.in_quiet_hours(sched, kst(2026, 10, 17, 7)) is True       # 토 07시(금요일 밤 연장)
    assert dnd.in_quiet_hours(sched, kst(2026, 10, 17, 9)) is False      # 토 09시
    assert dnd.in_quiet_hours(sched, kst(2026, 10, 15, 23)) is False     # 목 23시(목요일은 일정 없음)
    assert dnd.in_quiet_hours({**sched, "enabled": False}, kst(2026, 10, 16, 23)) is False
    same_day = {"enabled": True, "days": [0, 1, 2, 3, 4], "start": "12:00", "end": "13:00", "timezone": "Asia/Seoul"}
    assert dnd.in_quiet_hours(same_day, kst(2026, 10, 16, 12, 30)) is True
    assert dnd.in_quiet_hours(same_day, kst(2026, 10, 17, 12, 30)) is False   # 토요일


def test_validate_schedule():
    assert dnd.validate({"days": [1, 1, 0], "start": "09:00", "end": "18:00"})["days"] == [0, 1]
    for bad in ({"start": "25:00"}, {"days": [7]}, {"timezone": "Mars/Base"}, {"days": "mon"}):
        with pytest.raises(HTTPException):
            dnd.validate(bad)


@pytest.mark.asyncio
async def test_dnd_schedule_endpoints_and_push_gate(db, monkeypatch):
    bob = await db.get(User, "bob")
    res = await nr.get_dnd_schedule(user=bob, db=db)
    assert res["schedule"]["enabled"] is False
    # 하루 종일 매일 → 지금 막힌다
    res = await nr.put_dnd_schedule({"enabled": True, "days": list(range(7)), "start": "00:00", "end": "00:00"},
                                    user=bob, db=db)
    assert res["active"] is True
    assert await dnd.schedule_blocks("bob") is True
    assert await dnd.schedule_blocks("alice") is False

    # send_push 가 일정에 걸리면 구독 조회 전에 0 을 돌려준다
    from app.push import router as pr
    assert await pr.send_push("bob", "t", "b") == 0

    # 개인 설정 PATCH 로는 일정 키를 못 덮어쓴다
    from app.me import prefs as mp
    with pytest.raises(HTTPException):
        await mp.patch_prefs({"notify.dnd_schedule": {"enabled": False}}, user=bob, db=db)


@pytest.mark.asyncio
async def test_test_push_reports_subscriptions(db, monkeypatch):
    bob = await db.get(User, "bob")
    res = await nr.test_push(user=bob, db=db)
    assert res["subscriptions"] == 0 and res["ok"] is False and res["detail"]

    db.add(PushSubscription(user_id="bob", endpoint="https://push.example/1", keys_json="{}"))
    await db.commit()
    calls = []

    async def fake_send(uid, title, body, url=None, bypass_dnd=False):
        calls.append((uid, bypass_dnd))
        return 1

    import app.push.router as pr
    monkeypatch.setattr(pr, "send_push", fake_send)
    res = await nr.test_push(user=bob, db=db)
    assert res["ok"] is True and res["sent"] == 1
    assert calls == [("bob", True)]                   # 시험 푸시는 방해 금지 일정을 건너뛴다
