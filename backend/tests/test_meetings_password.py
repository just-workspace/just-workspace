"""비밀번호로 들어오는 게스트 참가 신청 — 정답/오답/미입력/시도제한.

Redis·LiveKit·룸 저장소는 전부 가짜로 갈아끼운다. 여기서 보고 싶은 것은
`submit_join_request` 의 분기이지 인프라가 아니다.
"""

import pytest

from app.auth.password import hash_password
from app.meetings import router as meetings_router
from app.meetings import store
from app.meetings.schemas import JoinRequestCreate


class FakeRedis:
    def __init__(self):
        self.values: dict[str, int] = {}

    async def get(self, k):
        v = self.values.get(k)
        return str(v) if v is not None else None

    async def incr(self, k):
        self.values[k] = self.values.get(k, 0) + 1
        return self.values[k]

    async def expire(self, k, ttl):
        return True


@pytest.fixture()
def room(monkeypatch):
    """비밀번호가 걸린 방 하나와, 그 방을 돌려주는 가짜 저장소."""
    meta = store.RoomMeta(
        name="pw-room",
        host_user_id="1",
        host_username="host",
        host_display_name="Host",
        password_hash=hash_password("4454"),
    )
    created: list[store.JoinRequest] = []
    statuses: dict[str, str] = {}

    async def fake_get_room_by_token(token):
        return meta if token == "tok" else None

    async def fake_create_join_request(room_name, nickname):
        req = store.JoinRequest(id=f"r{len(created)}", nickname=nickname)
        created.append(req)
        return req

    async def fake_set_status(room_name, req_id, status, livekit_token=None):
        statuses[req_id] = status

    fake_redis = FakeRedis()

    monkeypatch.setattr(meetings_router.store, "get_room_by_token", fake_get_room_by_token)
    monkeypatch.setattr(meetings_router.store, "create_join_request", fake_create_join_request)
    monkeypatch.setattr(meetings_router.store, "set_join_request_status", fake_set_status)
    monkeypatch.setattr(meetings_router, "get_redis", lambda: _async(fake_redis))
    monkeypatch.setattr(meetings_router.livekit, "generate_token", lambda **kw: "lk-token")
    monkeypatch.setattr(meetings_router.livekit, "get_ws_url", lambda: "wss://example/livekit/")
    monkeypatch.setattr(meetings_router, "_check_configured", lambda: None)
    return {"meta": meta, "statuses": statuses, "redis": fake_redis}


async def _async(v):
    return v


@pytest.mark.asyncio
async def test_correct_password_joins_immediately(room):
    res = await meetings_router.submit_join_request(
        "tok", JoinRequestCreate(nickname="게스트", password="4454")
    )
    assert res.status == "approved"
    assert res.token == "lk-token"
    assert res.livekit_url == "wss://example/livekit/"
    assert room["statuses"][res.request_id] == "approved"


@pytest.mark.asyncio
async def test_wrong_password_is_rejected_and_counted(room):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        await meetings_router.submit_join_request(
            "tok", JoinRequestCreate(nickname="게스트", password="0000")
        )
    assert e.value.status_code == 403
    assert room["redis"].values["mtg:pwfail:tok"] == 1


@pytest.mark.asyncio
async def test_no_password_falls_back_to_host_approval(room):
    """비밀번호가 걸린 방이어도 입력하지 않으면 기존 승인 대기 경로."""
    res = await meetings_router.submit_join_request(
        "tok", JoinRequestCreate(nickname="게스트")
    )
    assert res.status == "pending"
    assert res.token is None
    assert res.request_id not in room["statuses"]


@pytest.mark.asyncio
async def test_too_many_failures_locks_out(room):
    from fastapi import HTTPException

    room["redis"].values["mtg:pwfail:tok"] = 10
    with pytest.raises(HTTPException) as e:
        await meetings_router.submit_join_request(
            "tok", JoinRequestCreate(nickname="게스트", password="4454")
        )
    assert e.value.status_code == 429
