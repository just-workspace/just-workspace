"""음성 채널 — 채널 깃발·토큰 권한·접속 상태(presence)·웹훅 분기·대조.

SQLite + 가짜 Redis·LiveKit. 라우터 함수를 직접 부른다.
"""

import json
import os
import sys
import types
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

from app.chat import router as chat_router  # noqa: E402
from app.chat import voice  # noqa: E402
from app.chat.schemas import ChannelCreate, VoiceLeave, VoiceStateUpdate  # noqa: E402
from app.db.models import Base, Channel, ChannelMember, User  # noqa: E402
from app.meetings import calls  # noqa: E402


class FakeRedis:
    def __init__(self):
        self.kv: dict[str, str] = {}
        self.h: dict[str, dict[str, str]] = {}
        self.published: list[tuple[str, dict]] = []

    async def get(self, k):
        return self.kv.get(k)

    async def set(self, k, v, ex=None, nx=False):
        if nx and k in self.kv:
            return False
        self.kv[k] = v
        return True

    async def mget(self, ks):
        return [self.kv.get(k) for k in ks]

    async def delete(self, *ks):
        for k in ks:
            self.kv.pop(k, None)

    async def hget(self, name, k):
        return self.h.get(name, {}).get(k)

    async def hset(self, name, k, v):
        self.h.setdefault(name, {})[k] = v

    async def hdel(self, name, k):
        self.h.get(name, {}).pop(k, None)

    async def hkeys(self, name):
        return list(self.h.get(name, {}).keys())

    async def hgetall(self, name):
        return dict(self.h.get(name, {}))

    async def publish(self, channel, payload):
        self.published.append((channel, json.loads(payload)))


class FakeLiveKit:
    """방 이름 → 참가자 목록. list_participants 는 방이 없으면 예외(실서버의 not_found 와 같다)."""

    def __init__(self):
        self.rooms: dict[str, list[dict]] = {}
        self.deleted: list[str] = []

    async def list_rooms(self):
        return [{"name": n, "num_participants": len(p)} for n, p in self.rooms.items()]

    async def list_participants(self, room):
        if room not in self.rooms:
            raise RuntimeError("not_found")
        return [dict(p) for p in self.rooms[room]]

    async def delete_room(self, name):
        self.deleted.append(name)
        self.rooms.pop(name, None)


@pytest.fixture()
async def env(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    redis = FakeRedis()

    async def _get_redis():
        return redis

    lk = FakeLiveKit()
    monkeypatch.setattr(voice, "get_redis", _get_redis)
    monkeypatch.setattr(calls, "get_redis", _get_redis)
    # emit_to_channel 은 자기 모듈의 get_redis 를 쓴다
    from app.realtime import events
    monkeypatch.setattr(events, "get_redis", _get_redis)
    monkeypatch.setattr(voice.livekit, "is_configured", lambda: True)
    monkeypatch.setattr(voice.livekit, "list_rooms", lk.list_rooms)
    monkeypatch.setattr(voice.livekit, "list_participants", lk.list_participants)
    monkeypatch.setattr(voice.livekit, "delete_room", lk.delete_room)
    monkeypatch.setattr(voice.livekit, "generate_token", lambda **kw: f"jwt:{kw['room']}:{kw['identity']}")
    monkeypatch.setattr(voice.livekit, "get_ws_url", lambda: "ws://x/livekit/")
    # 테스트에선 identity 를 예측 가능하게
    monkeypatch.setattr(voice.livekit, "session_identity", lambda uid: f"u-{uid}-s1")

    class _Mgr:
        async def notify_channels_changed(self, ids):
            pass
    monkeypatch.setattr(chat_router, "manager", _Mgr())

    async with factory() as db:
        for uid in ("alice", "bob", "eve"):
            db.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.title()))
        await db.commit()
        db.add(Channel(id="lounge", name="라운지", type="public", created_by="alice", is_voice=True))
        db.add(Channel(id="dev", name="개발", type="public", created_by="alice"))
        await db.commit()
        for ch in ("lounge", "dev"):
            db.add(ChannelMember(channel_id=ch, user_id="alice", role="owner"))
            db.add(ChannelMember(channel_id=ch, user_id="bob", role="member"))
        await db.commit()
        users = {u: await db.get(User, u) for u in ("alice", "bob", "eve")}
        yield SimpleNamespace(db=db, u=users, redis=redis, lk=lk)
    await engine.dispose()


def _voice_events(redis: FakeRedis, channel_id: str):
    return [p for c, p in redis.published if c == f"chat:channel:{channel_id}" and p.get("type") == "voice_state"]


@pytest.mark.asyncio
async def test_create_voice_channel_flag_in_list(env):
    r = await chat_router.create_channel(ChannelCreate(name="음악방", voice=True), user=env.u["alice"], db=env.db)
    assert r["is_voice"] is True
    lst = await chat_router.list_channels(user=env.u["alice"], db=env.db)
    by = {c["id"]: c for c in lst}
    assert by[r["id"]]["is_voice"] is True
    assert by["dev"]["is_voice"] is False
    # 상세도 깃발을 준다
    one = await chat_router.get_channel(r["id"], user=env.u["alice"], db=env.db)
    assert one["is_voice"] is True


@pytest.mark.asyncio
async def test_token_requires_member_and_voice_channel(env):
    with pytest.raises(HTTPException) as e:
        await voice.voice_token("lounge", user=env.u["eve"], db=env.db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await voice.voice_token("dev", user=env.u["alice"], db=env.db)
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        await voice.voice_token("nope", user=env.u["alice"], db=env.db)
    assert e.value.status_code == 404

    tok = await voice.voice_token("lounge", user=env.u["bob"], db=env.db)
    assert tok["room"] == "voice-lounge" and tok["identity"] == "u-bob-s1"
    assert tok["token"] == "jwt:voice-lounge:u-bob-s1" and tok["livekit_url"] == "ws://x/livekit/"
    # identity → 사람 정보가 적혔다(presence 가 사람으로 바꿀 때 쓴다)
    info = json.loads(env.redis.kv["voice:ident:u-bob-s1"])
    assert info["user_id"] == "bob" and info["name"] == "Bob"


@pytest.mark.asyncio
async def test_state_builds_presence_and_emits_once_per_change(env):
    await voice.voice_token("lounge", user=env.u["alice"], db=env.db)
    await voice.voice_token("lounge", user=env.u["bob"], db=env.db)
    env.lk.rooms["voice-lounge"] = [
        {"identity": "u-alice-s1", "name": "Alice", "joined_at": 10, "mic_muted": False},
        {"identity": "u-bob-s1", "name": "Bob", "joined_at": 20, "mic_muted": True},
        {"identity": "EG_rec", "name": "", "joined_at": 1, "mic_muted": True},
    ]
    st = await voice.voice_state("lounge", VoiceStateUpdate(identity="u-alice-s1", muted=False, deafened=False, tier="music"),
                                 user=env.u["alice"], db=env.db)
    ps = st["participants"]
    assert [p["user_id"] for p in ps] == ["alice", "bob"]        # 녹화 봇 제외, 입장 순
    assert ps[0]["tier"] == "music" and ps[0]["muted"] is False
    # bob 은 보고가 없다 → LiveKit 트랙 음소거를 따른다, 단계는 기본
    assert ps[1]["muted"] is True and ps[1]["tier"] == "voice" and ps[1]["name"] == "Bob"
    assert len(_voice_events(env.redis, "lounge")) == 1

    # 같은 상태를 다시 보고하면 이벤트가 안 난다
    await voice.voice_state("lounge", VoiceStateUpdate(identity="u-alice-s1", muted=False, deafened=False, tier="music"),
                            user=env.u["alice"], db=env.db)
    assert len(_voice_events(env.redis, "lounge")) == 1

    # 듣기 끔 → 바뀐 것만 알림
    st = await voice.voice_state("lounge", VoiceStateUpdate(identity="u-alice-s1", muted=True, deafened=True, tier="music"),
                                 user=env.u["alice"], db=env.db)
    assert st["participants"][0]["deafened"] is True and st["participants"][0]["muted"] is True
    ev = _voice_events(env.redis, "lounge")
    assert len(ev) == 2 and ev[-1]["participants"][0]["deafened"] is True

    # 전체 상태 조회 — 내 음성 채널만
    allst = await voice.voice_states(user=env.u["alice"], db=env.db)
    assert set(allst) == {"lounge"} and len(allst["lounge"]["participants"]) == 2
    assert await voice.voice_states(user=env.u["eve"], db=env.db) == {}


@pytest.mark.asyncio
async def test_state_rejects_foreign_identity(env):
    await voice.voice_token("lounge", user=env.u["alice"], db=env.db)
    with pytest.raises(HTTPException) as e:
        await voice.voice_state("lounge", VoiceStateUpdate(identity="u-alice-s1"), user=env.u["bob"], db=env.db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await voice.voice_state("lounge", VoiceStateUpdate(identity="ghost"), user=env.u["alice"], db=env.db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await voice.voice_state("lounge", VoiceStateUpdate(identity="u-alice-s1"), user=env.u["eve"], db=env.db)
    assert e.value.status_code == 403


@pytest.mark.asyncio
async def test_leave_and_webhook_and_reconcile(env):
    await voice.voice_token("lounge", user=env.u["alice"], db=env.db)
    env.lk.rooms["voice-lounge"] = [{"identity": "u-alice-s1", "name": "Alice", "joined_at": 10, "mic_muted": False}]
    await voice.voice_state("lounge", VoiceStateUpdate(identity="u-alice-s1"), user=env.u["alice"], db=env.db)
    assert "lounge" in env.redis.h["voice:state"]

    # 나감 — LiveKit 에서도 빠졌다
    env.lk.rooms["voice-lounge"] = []
    await voice.voice_leave("lounge", VoiceLeave(identity="u-alice-s1"), user=env.u["alice"], db=env.db)
    assert "lounge" not in env.redis.h.get("voice:state", {})
    assert "voice:flags:u-alice-s1" not in env.redis.kv
    ev = _voice_events(env.redis, "lounge")
    assert ev[-1]["participants"] == [] and ev[-1]["since"] is None

    # 웹훅 분기 — refresh_room 이 참가자를 다시 읽는다
    env.lk.rooms["voice-lounge"] = [{"identity": "u-alice-s1", "name": "Alice", "joined_at": 30, "mic_muted": False}]
    await voice.refresh_room("voice-lounge")
    assert json.loads(env.redis.h["voice:state"]["lounge"])["participants"][0]["user_id"] == "alice"
    await voice.clear_room("voice-lounge")
    assert "lounge" not in env.redis.h.get("voice:state", {})
    # voice- 가 아닌 방은 무시
    await voice.refresh_room("chan-dev")
    assert env.redis.h.get("voice:state", {}) == {}

    # 대조 — LiveKit 엔 없는데 남은 상태는 지우고, 있는 방은 채운다
    env.redis.h["voice:state"]["stale"] = json.dumps({"participants": [{"identity": "x"}], "since": 1})
    await voice.reconcile()
    assert set(env.redis.h["voice:state"]) == {"lounge"}


@pytest.mark.asyncio
async def test_delete_voice_channel_closes_room(env):
    env.lk.rooms["voice-lounge"] = [{"identity": "u-alice-s1", "name": "Alice", "joined_at": 1, "mic_muted": False}]
    env.redis.h["voice:state"] = {"lounge": json.dumps({"participants": [{"identity": "u-alice-s1"}], "since": 1})}
    await chat_router.delete_channel("lounge", user=env.u["alice"], db=env.db)
    assert env.lk.deleted == ["voice-lounge"]
    assert "lounge" not in env.redis.h["voice:state"]
