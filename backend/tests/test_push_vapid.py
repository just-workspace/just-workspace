"""GET /api/push/vapid-key 500 회귀 — py-vapid 1.9 에 없는 메서드를 불렀고, 키도 워커·재시작마다 새로 만들었다.

이제 env → DB 저장본 → 없으면 만들어 저장. 같은 DB 면 몇 번을 불러도 같은 키, 비공개 키는 pywebpush 가 읽는 형식."""

import base64
import json

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings
from app.db.models import Base, SystemSetting
from app.push import router as push


@pytest.fixture()
async def factory(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[SystemSetting.__table__]))
    monkeypatch.setattr(push, "_vapid_cache", None)
    s = get_settings()
    monkeypatch.setattr(s, "vapid_public_key", "")
    monkeypatch.setattr(s, "vapid_private_key", "")
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


def _dec(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


async def test_generates_once_and_persists(factory, monkeypatch):
    async with factory() as db:
        r = await push.get_vapid_key(db=db)
    pub = r["vapid_public_key"]
    raw = _dec(pub)
    assert len(raw) == 65 and raw[0] == 4          # 비압축 P-256 점(브라우저 applicationServerKey)
    # 다른 워커(캐시 없음)도 DB 저장본을 쓴다
    monkeypatch.setattr(push, "_vapid_cache", None)
    async with factory() as db:
        pub2, priv = await push.get_vapid_keys(db)
        row = await db.get(SystemSetting, push.VAPID_SETTING_KEY)
    assert pub2 == pub
    assert json.loads(row.value)["private"] == priv
    assert push.public_from_private(priv) == pub
    # pywebpush 가 쓰는 py_vapid 가 이 비공개 키를 읽는다
    from py_vapid import Vapid
    assert Vapid.from_string(priv).private_key is not None


async def test_lost_race_reads_winner(factory, monkeypatch):
    """다른 워커가 먼저 저장했으면(INSERT 충돌) 그 키를 쓴다."""
    winner = push.generate_vapid_keys()
    real_read_once = {"n": 0}
    orig_get = AsyncSession.get

    async def get_hides_first(self, cls, key, *a, **kw):
        # 첫 조회는 "없음" 으로 보이게 → 만들어 INSERT → PK 충돌 → 다시 읽기
        if cls is SystemSetting and real_read_once["n"] == 0:
            real_read_once["n"] += 1
            return None
        return await orig_get(self, cls, key, *a, **kw)

    async with factory() as db:
        db.add(SystemSetting(key=push.VAPID_SETTING_KEY, value=json.dumps({"public": winner[0], "private": winner[1]})))
        await db.commit()
    monkeypatch.setattr(AsyncSession, "get", get_hides_first)
    async with factory() as db:
        assert await push.get_vapid_keys(db) == winner


async def test_env_keys_win(factory, monkeypatch):
    pub, priv = push.generate_vapid_keys()
    s = get_settings()
    monkeypatch.setattr(s, "vapid_private_key", priv)
    async with factory() as db:
        assert await push.get_vapid_keys(db) == (pub, priv)     # 공개 키는 비공개 키에서 다시 만든다
        assert await db.get(SystemSetting, push.VAPID_SETTING_KEY) is None
