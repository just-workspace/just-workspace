"""격리 브라우저 테스트용 가짜 — Redis(일회용 코드·rbi 세션·워크스페이스 세션 레지스트리) · rbi 전용 출처 설정 · rbi 세션 쿠키."""
from __future__ import annotations

import json
import time

import pytest

from app.config import get_settings

RBI_ORIGIN = "https://rbi.test"
RBI_HOST = "rbi.test"
WS_ORIGIN = "https://ws.test"
WS_HOST = "ws.test"


class FakeRedis:
    def __init__(self):
        self.kv: dict[str, tuple[str, float | None]] = {}
        self.sets: dict[str, set[str]] = {}
        self.down = False

    def _chk(self):
        if self.down:
            raise ConnectionError("redis down")

    def _alive(self, k):
        v = self.kv.get(k)
        if not v:
            return None
        if v[1] is not None and v[1] < time.time():
            self.kv.pop(k, None)
            return None
        return v[0]

    async def set(self, k, v, ex=None, nx=False):
        self._chk()
        if nx and self._alive(k) is not None:
            return None
        self.kv[k] = (v, time.time() + ex if ex else None)
        return True

    async def setex(self, k, ttl, v):
        return await self.set(k, v, ex=ttl)

    async def get(self, k):
        self._chk()
        return self._alive(k)

    async def getdel(self, k):
        self._chk()
        v = self._alive(k)
        self.kv.pop(k, None)
        return v

    async def delete(self, *ks):
        self._chk()
        for k in ks:
            self.kv.pop(k, None)
        return len(ks)

    async def sadd(self, k, *vs):
        self.sets.setdefault(k, set()).update(vs)

    async def srem(self, k, *vs):
        self.sets.get(k, set()).difference_update(vs)

    async def smembers(self, k):
        return set(self.sets.get(k, set()))

    async def expire(self, k, ttl):
        return True

    def expire_now(self, k):
        if k in self.kv:
            self.kv[k] = (self.kv[k][0], time.time() - 1)


@pytest.fixture()
def fake_redis(monkeypatch):
    fr = FakeRedis()

    async def _get():
        return fr
    import app.chat.redis_client as rc
    from app.auth import sessions as sess_mod
    monkeypatch.setattr(rc, "get_redis", _get)
    monkeypatch.setattr(sess_mod, "get_redis", _get)
    return fr


@pytest.fixture()
def rbi_origin(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "rbi_public_origin", RBI_ORIGIN)
    monkeypatch.setattr(s, "app_url", WS_ORIGIN)
    return RBI_ORIGIN


async def ws_session(fr: FakeRedis, user_id: str, wsid: str = "wsid-1") -> str:
    """워크스페이스 세션 레지스트리에 기록하고 해당 sid 를 반환한다(sessions.create_session 과 동일한 키)."""
    await fr.set("sess:" + wsid, json.dumps({"user_id": user_id, "last_seen": int(time.time()), "ttl": 3600}), ex=3600)
    await fr.sadd("usess:" + user_id, wsid)
    return wsid


async def site_cookie(fr: FakeRedis, user_id: str, wsid: str | None = None, tv: int = 0) -> str:
    """rbi 세션 하나를 생성하고 Cookie 헤더 값("이름=값")을 반환한다(콜백이 생성하는 것과 동일한 형태)."""
    from app.rbi import site
    wsid = wsid or await ws_session(fr, user_id, f"ws-{user_id}")
    rsid = f"rs-{user_id}-{len(fr.kv)}"
    await site._site_put(rsid, {"uid": user_id, "wsid": wsid, "tv": tv, "created": int(time.time())})
    return f"{site.site_cookie_name()}={site._signer('site').dumps({'rsid': rsid, 'uid': user_id})}"
