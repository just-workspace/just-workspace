"""회귀 — WebSocket(채팅·위키 협업) 인증이 REST 와 같은 세션 검증을 거친다.

- 2단계 인증 전 임시 토큰(purpose=2fa) 거부
- 강제 로그아웃(token_version 증가)·폐기된 세션(sid) 거부
- 교차 출처 Origin 의 쿠키 핸드셰이크 거부
- 위키 협업: 스페이스 권한 없으면 입장 불가, reader 는 문서 변경 프레임을 못 보낸다
"""

from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth import deps, security_policy, sessions as sess_mod, ws_auth
from app.db.models import Base, User, WikiPage, WikiPageVersion, WikiSpace, WikiSpaceMember
from app.wiki import collab, service

TABLES = [t.__table__ for t in (User, WikiSpace, WikiSpaceMember, WikiPage, WikiPageVersion)]


@pytest.fixture()
async def db(monkeypatch):
    live = {"sid-ok"}

    async def _get_session(sid):
        return {"created": 0, "last_seen": 0} if sid in live else None

    async def _pol(*_a, **_k):
        return {}

    monkeypatch.setattr(sess_mod, "get_session", _get_session)
    monkeypatch.setattr(security_policy, "get_policy_cached", _pol)
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        for uid in ("alice", "bob", "carol"):
            session.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x",
                             display_name=uid, token_version=1))
        await session.commit()
        sp = WikiSpace(name="s", slug="s", owner_id="alice", visibility="private")
        session.add(sp)
        await session.commit()
        await session.refresh(sp)
        session.add(WikiSpaceMember(space_id=sp.id, user_id="bob", role="reader"))
        await session.commit()
        page = await service.create_page(session, sp.id, "alice", title="p", slug="p", content="x")
        session.info["page_id"] = page["id"]
        yield session
    await engine.dispose()


def _ws(cookie=None, token=None, origin=None, host="test"):
    headers = {"host": host}
    if origin:
        headers["origin"] = origin
    return SimpleNamespace(
        cookies={"ws_session": cookie} if cookie else {},
        query_params={"token": token} if token else {},
        headers=headers,
    )


def _sess(**kw):
    data = {"user_id": "alice", "tv": 1, "sid": "sid-ok"}
    data.update(kw)
    return deps.sign_value(data)


async def test_valid_session_accepted(db):
    u = await ws_auth.authenticate_ws(_ws(cookie=_sess(), origin="http://test"), db)
    assert u is not None and u.id == "alice"
    u = await ws_auth.authenticate_ws(_ws(token=_sess()), db)
    assert u is not None


async def test_two_factor_temp_token_rejected(db):
    temp = deps.sign_value({"user_id": "alice", "purpose": "2fa"})
    assert await ws_auth.authenticate_ws(_ws(token=temp), db) is None
    assert await ws_auth.authenticate_ws(_ws(cookie=temp), db) is None
    # purpose 가 붙은 값은 tv/sid 를 흉내 내도 세션이 아니다
    forged = deps.sign_value({"user_id": "alice", "tv": 1, "sid": "sid-ok", "purpose": "2fa"})
    assert await ws_auth.authenticate_ws(_ws(token=forged), db) is None


async def test_revoked_or_logged_out_session_rejected(db):
    assert await ws_auth.authenticate_ws(_ws(token=_sess(sid="sid-revoked")), db) is None
    assert await ws_auth.authenticate_ws(_ws(token=_sess(tv=0)), db) is None
    assert await ws_auth.authenticate_ws(_ws(token=_sess(sid=None)), db) is None


async def test_cross_origin_cookie_rejected(db):
    assert await ws_auth.authenticate_ws(_ws(cookie=_sess(), origin="https://evil.example"), db) is None


async def test_wiki_collab_page_permission(db):
    pid = db.info["page_id"]
    alice = await db.get(User, "alice")
    bob = await db.get(User, "bob")
    carol = await db.get(User, "carol")
    assert await collab._page_access(alice, pid, db) == "write"
    assert await collab._page_access(bob, pid, db) == "read"
    assert await collab._page_access(carol, pid, db) is None
    assert await collab._page_access(alice, "no-such-page", db) is None


def test_reader_cannot_send_document_updates():
    assert collab.frame_allowed("read", bytes([collab.MSG_SYNC_REQUEST, 1]))
    assert collab.frame_allowed("read", bytes([collab.MSG_AWARENESS, 1]))
    assert not collab.frame_allowed("read", bytes([collab.MSG_UPDATE, 1]))
    assert not collab.frame_allowed("read", bytes([collab.MSG_SYNC_RESPONSE, 1]))
    assert collab.frame_allowed("write", bytes([collab.MSG_UPDATE, 1]))
    assert not collab.frame_allowed("write", b"")


def _b64(s: str) -> str:
    import base64
    return base64.urlsafe_b64encode(s.encode()).rstrip(b"=").decode()


async def test_token_via_websocket_protocol_header(db):
    """토큰을 쿼리 대신 Sec-WebSocket-Protocol 로 — nginx error_log 에 평문으로 남지 않게(L-3)."""
    ws = _ws()
    ws.headers["sec-websocket-protocol"] = f"jw.bearer, jw.token.{_b64(_sess())}"
    u = await ws_auth.authenticate_ws(ws, db)
    assert u is not None and u.id == "alice"
    assert ws_auth.accept_subprotocol(ws) == "jw.bearer"
    # jw.bearer 없이 토큰만 오면 무시, 깨진 base64 도 무시
    bad = _ws()
    bad.headers["sec-websocket-protocol"] = f"jw.token.{_b64(_sess())}"
    assert await ws_auth.authenticate_ws(bad, db) is None
    assert ws_auth.accept_subprotocol(bad) is None
    broken = _ws()
    broken.headers["sec-websocket-protocol"] = "jw.bearer, jw.token.%%%"
    assert ws_auth.token_from_protocol(broken) is None
    # 프로토콜 헤더로 온 2단계 임시 토큰도 거부(같은 검증)
    temp = _ws()
    temp.headers["sec-websocket-protocol"] = f"jw.bearer, jw.token.{_b64(deps.sign_value({'user_id': 'alice', 'purpose': '2fa'}))}"
    assert await ws_auth.authenticate_ws(temp, db) is None
