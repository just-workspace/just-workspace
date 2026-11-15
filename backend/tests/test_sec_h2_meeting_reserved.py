"""회귀 — 채널·DM 통화 방 이름(chan-<채널id>)을 선점해 게스트로 들어갈 수 없다.

- 사용자가 만드는 회의는 예약 접두(chan-)를 쓸 수 없다(대소문자·앞뒤 공백 무관)
- 예전에 선점된 메타가 Redis 에 남아 있어도 공유 링크(게스트) 입장은 거부
- 진행 중 방 목록·참여자 목록에서 chan- 방은 그 채널 멤버에게만 보인다
"""

import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.meetings import router as mr
from app.meetings import store
from app.meetings.schemas import JoinRequestCreate, RoomCreate
from tests.test_meetings_store_db import env, _u  # noqa: F401  (픽스처 재사용)


@pytest.mark.parametrize("name", ["chan-abc", "CHAN-abc", "  chan-x", "a/b", "x\ny", "", "a" * 101])
def test_reserved_or_bad_names_rejected(name):
    with pytest.raises(ValidationError):
        RoomCreate(name=name)


def test_normal_names_ok():
    assert RoomCreate(name="주간 회의").name == "주간 회의"
    assert RoomCreate(name="channel-sync").name == "channel-sync"


async def test_store_refuses_reserved_meta(env):
    with pytest.raises(ValueError):
        await store.create_room_meta("chan-c1", "alice", "alice", "Alice")


async def test_leftover_squatted_meta_cannot_admit_guests(env):
    # 예전 코드로 만들어진 선점 메타(대기실 꺼짐)가 Redis 에 남아 있는 상황
    meta = store.RoomMeta(name="chan-c1", host_user_id="carol", host_username="carol",
                          host_display_name="Carol", waiting_room=False)
    env["redis"].kv[store._RKEY + "chan-c1"] = store._serialize(meta)
    env["redis"].kv[store._TKEY + meta.share_token] = "chan-c1"
    assert await store.get_room_by_token(meta.share_token) is None
    assert await store.get_room_meta("chan-c1") is None
    with pytest.raises(HTTPException) as e:
        await mr.submit_join_request(meta.share_token, JoinRequestCreate(nickname="spy"))
    assert e.value.status_code == 404


async def test_channel_call_rooms_hidden_from_non_members(env, monkeypatch):
    from app.chat import service as chat_service

    async def is_member(_db, channel_id, user_id):
        return channel_id == "c1" and user_id == "bob"

    monkeypatch.setattr(chat_service, "is_channel_member", is_member)
    env["lk"]["rooms"]["chan-c1"] = {"name": "chan-c1", "num_participants": 2,
                                     "max_participants": 10, "creation_time": 1}
    env["lk"]["rooms"]["standup"] = {"name": "standup", "num_participants": 1,
                                     "max_participants": 10, "creation_time": 1}

    carol = await _u(env, "carol")
    res = await mr.get_rooms(user=carol, db=env["db"])
    names = [r.name for r in res.rooms]
    # standup 은 누구 회의인지 모르는 방(메타 없음) — 진행 중이어도 목록에 싣지 않는다
    assert "chan-c1" not in names and "standup" not in names

    bob = await _u(env, "bob")
    res = await mr.get_rooms(user=bob, db=env["db"])
    assert "chan-c1" in [r.name for r in res.rooms]

    async def parts(_room):
        return []
    monkeypatch.setattr(mr.livekit, "list_participants", parts)
    with pytest.raises(HTTPException) as e:
        await mr.get_participants("chan-c1", user=carol, db=env["db"])
    assert e.value.status_code == 404
    assert await mr.get_participants("chan-c1", user=bob, db=env["db"]) == []
