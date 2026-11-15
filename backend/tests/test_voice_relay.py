"""음성채널 무손실 티어 — 릴레이 토큰(HMAC) + POST /api/chat/channels/{id}/voice/relay-token.

test_chat_p4.py 와 같은 방식(SQLite 채팅 테이블만, 라우터 함수 직접 호출). 릴레이 /info 는 monkeypatch.
"""

import json

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.chat import relay_token, voice, voice_relay
from app.db.models import Base, Channel, ChannelMember, User

SECRET = "0123456789abcdef0123456789abcdef"
TABLES = [t.__table__ for t in (User, Channel, ChannelMember)]


# ─── 토큰 ───

def test_known_vector_matches_go():
    """audiorelay/internal/token/token_test.go TestKnownVector 와 같은 벡터."""
    tok = relay_token.mint("shared-secret", room="voice-r1", uid="u1", name="A", ttl=120, now=1700000000, nonce="x")
    assert tok == (
        "eyJyb29tIjoidm9pY2UtcjEiLCJ1aWQiOiJ1MSIsIm5hbWUiOiJBIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAxMjAsIm5vbmNlIjoieCJ9."
        "V5oZ5LFHJ8gkvjprQ5xo_BMBvySbQGNkAc-tAedjw1o"
    )
    claims = relay_token.verify("shared-secret", tok, now=1700000100)
    assert claims["room"] == "voice-r1" and claims["uid"] == "u1" and claims["exp"] == 1700000120


def test_verify_rejects():
    tok = relay_token.mint(SECRET, room="r", uid="u", ttl=10, now=1000)
    assert relay_token.verify(SECRET, tok, now=1014)["uid"] == "u"  # 5 s 여유 안
    with pytest.raises(ValueError, match="expired"):
        relay_token.verify(SECRET, tok, now=1016)
    with pytest.raises(ValueError, match="bad signature"):
        relay_token.verify("x" * 32, tok, now=1000)
    with pytest.raises(ValueError, match="bad signature"):
        relay_token.verify(SECRET, "x" + tok[1:], now=1000)
    with pytest.raises(ValueError, match="malformed"):
        relay_token.verify(SECRET, "nodot", now=1000)
    with pytest.raises(ValueError):
        relay_token.mint("", room="r", uid="u")


def test_claims_shape_and_korean_name():
    tok = relay_token.mint(SECRET, room="voice-c1", uid="u1", name="홍길동")
    claims = relay_token.verify(SECRET, tok)
    assert list(claims) == ["room", "uid", "name", "iat", "exp", "nonce"]
    assert claims["name"] == "홍길동" and claims["exp"] - claims["iat"] == relay_token.TTL_SECONDS
    assert relay_token.room_for_channel("c1") == "voice-c1"


# ─── 엔드포인트 ───

@pytest.fixture()
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        for uid in ("alice", "bob"):
            session.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.title()))
        session.add(Channel(id="dev", name="개발", type="public", created_by="alice", is_voice=True))
        session.add(Channel(id="text", name="글만", type="public", created_by="alice"))
        await session.commit()
        session.add(ChannelMember(channel_id="dev", user_id="alice", role="owner"))
        session.add(ChannelMember(channel_id="text", user_id="alice", role="owner"))
        await session.commit()
        yield session
    await engine.dispose()


@pytest.fixture()
def relay(monkeypatch):
    """릴레이 설정 + /info 응답 가짜."""
    from app import config as cfg
    s = cfg.get_settings()
    monkeypatch.setattr(s, "audiorelay_secret", SECRET, raising=False)
    monkeypatch.setattr(s, "audiorelay_url", "http://audiorelay:8090", raising=False)
    monkeypatch.setattr(s, "app_url", "https://ws.example.test")
    state = {"info": {"version": "test", "protocol": 1, "ws_path": "/audiorelay/ws",
                      "webtransport": {"url": "https://relay.example.test:4433/audiorelay/wt", "self_signed": True, "cert_hash": "ab" * 32}}}

    async def _info():
        return state["info"]

    monkeypatch.setattr(voice_relay, "fetch_relay_info", _info)

    async def _owned(identity, user):
        if identity != f"lk-{user.id}":
            raise HTTPException(403, "내 접속이 아닙니다")
        return {"user_id": user.id}

    monkeypatch.setattr(voice, "_owned_identity", _owned)
    return state


async def _user(db, uid):
    return await db.get(User, uid)


async def test_member_gets_token_and_relay_info(db, relay):
    out = await voice_relay.issue_relay_token("dev", user=await _user(db, "alice"), db=db)
    claims = relay_token.verify(SECRET, out["token"])
    assert claims["room"] == "voice-dev" and claims["uid"] == "alice" and claims["name"] == "Alice"
    assert out["room"] == "voice-dev" and out["expires_in"] == 120
    assert out["ws_url"] == "wss://ws.example.test/audiorelay/ws" and out["ws_path"] == "/audiorelay/ws"
    assert out["webtransport"]["cert_hash"] == "ab" * 32 and out["relay_version"] == "test"
    assert "identity" not in claims and out["identity"] is None


async def test_identity_claim_requires_ownership(db, relay):
    out = await voice_relay.issue_relay_token("dev", body=voice_relay.RelayTokenRequest(identity="lk-alice"), user=await _user(db, "alice"), db=db)
    claims = relay_token.verify(SECRET, out["token"])
    assert claims["identity"] == "lk-alice" and out["identity"] == "lk-alice"
    assert list(claims) == ["room", "uid", "name", "identity", "iat", "exp", "nonce"]
    with pytest.raises(HTTPException) as e:
        await voice_relay.issue_relay_token("dev", body=voice_relay.RelayTokenRequest(identity="lk-bob"), user=await _user(db, "alice"), db=db)
    assert e.value.status_code == 403


async def test_webtransport_null_passthrough(db, relay):
    relay["info"]["webtransport"] = None
    out = await voice_relay.issue_relay_token("dev", user=await _user(db, "alice"), db=db)
    assert out["webtransport"] is None


async def test_non_member_404_not_voice(db, relay):
    with pytest.raises(HTTPException) as e:
        await voice_relay.issue_relay_token("dev", user=await _user(db, "bob"), db=db)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await voice_relay.issue_relay_token("nope", user=await _user(db, "alice"), db=db)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await voice_relay.issue_relay_token("text", user=await _user(db, "alice"), db=db)
    assert e.value.status_code == 400


async def test_503_when_unconfigured_or_relay_down(db, relay, monkeypatch):
    async def _down():
        return None
    monkeypatch.setattr(voice_relay, "fetch_relay_info", _down)
    with pytest.raises(HTTPException) as e:
        await voice_relay.issue_relay_token("dev", user=await _user(db, "alice"), db=db)
    assert e.value.status_code == 503

    from app import config as cfg
    monkeypatch.setattr(cfg.get_settings(), "audiorelay_secret", "", raising=False)
    assert not voice_relay.is_configured()
    with pytest.raises(HTTPException) as e:
        await voice_relay.issue_relay_token("dev", user=await _user(db, "alice"), db=db)
    assert e.value.status_code == 503


async def test_route_registered(client):
    # 라우터가 앱에 붙어 있으면 인증 없는 호출은 404 가 아니라 401 이다
    r = await client.post("/api/chat/channels/dev/voice/relay-token")
    assert r.status_code == 401
    # 토큰 payload 는 JSON 이고 사용자 비밀을 담지 않는다
    tok = relay_token.mint(SECRET, room="voice-x", uid="u")
    body = json.loads(relay_token._unb64(tok.split(".")[0]))
    assert set(body) == {"room", "uid", "name", "iat", "exp", "nonce"}
