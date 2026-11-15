"""회귀 — 회의 녹화 목록·다운로드는 그 회의의 호스트·초대 대상(또는 채널 멤버)·관리자만."""

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import Base, MeetingDB, MeetingInvitee, MeetingRecording, User
from app.meetings import router as mr

TABLES = [t.__table__ for t in (User, MeetingDB, MeetingInvitee, MeetingRecording)]


@pytest.fixture()
async def env(tmp_path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(mr, "RECORDINGS_DIR", str(tmp_path))
    from app.chat import service as chat_service

    async def is_member(_db, channel_id, user_id):
        return channel_id == "c1" and user_id == "dave"
    monkeypatch.setattr(chat_service, "is_channel_member", is_member)

    for fn in ("board_20261001-100000.mp4", "legacy_20261002-100000.mp4",
               "chan-c1_20261003-100000.mp4", "orphan_20261004-100000.mp4"):
        (tmp_path / fn).write_bytes(b"x")
    async with factory() as db:
        for uid, admin in (("alice", False), ("bob", False), ("carol", False), ("dave", False), ("root", True)):
            db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid, is_admin=admin))
        await db.commit()
        m = MeetingDB(room_name="board", title="board", host_user_id="alice", share_token="t1")
        legacy = MeetingDB(room_name="legacy", title="legacy", host_user_id="carol", share_token="t2")
        db.add_all([m, legacy])
        await db.commit()
        db.add(MeetingInvitee(meeting_id=m.id, user_id="bob", display_name="bob"))
        db.add(MeetingRecording(filename="board_20261001-100000.mp4", room_name="board",
                                meeting_id=m.id, host_user_id="alice"))
        await db.commit()
        yield db
    await engine.dispose()


async def _names(db, uid):
    u = await db.get(User, uid)
    return {x["filename"] for x in (await mr.list_recordings(user=u, db=db))["recordings"]}


async def test_list_is_filtered_per_user(env):
    assert await _names(env, "alice") == {"board_20261001-100000.mp4"}
    assert await _names(env, "bob") == {"board_20261001-100000.mp4"}       # 초대 대상
    assert await _names(env, "carol") == {"legacy_20261002-100000.mp4"}    # 기록 없는 예전 파일 → 방 이름으로 회의 찾음
    assert await _names(env, "dave") == {"chan-c1_20261003-100000.mp4"}    # 채널 멤버
    assert len(await _names(env, "root")) == 4                             # 관리자
    # 어떤 회의에도 묶이지 않는 파일은 관리자만
    for uid in ("alice", "bob", "carol", "dave"):
        assert "orphan_20261004-100000.mp4" not in await _names(env, uid)


async def test_download_denied_to_outsider(env):
    carol = await env.get(User, "carol")
    with pytest.raises(HTTPException) as e:
        await mr.download_recording("board_20261001-100000.mp4", user=carol, db=env)
    assert e.value.status_code == 404
    bob = await env.get(User, "bob")
    resp = await mr.download_recording("board_20261001-100000.mp4", user=bob, db=env)
    assert resp.status_code == 200


async def test_list_filters_by_room(env):
    root = await env.get(User, "root")
    r = await mr.list_recordings(room="board", user=root, db=env)
    assert [x["filename"] for x in r["recordings"]] == ["board_20261001-100000.mp4"]
    r = await mr.list_recordings(room="nope", user=root, db=env)
    assert r["recordings"] == []
