"""내 로그인 기기 — 목록(현재 기기 표시·UA 해석)·단건 종료·나머지 종료·타인 세션 차단. Redis 는 모의 객체."""

import json

import pytest
from fastapi import HTTPException

from app.auth import me_sessions as ms
from app.auth import sessions as sess_mod
from app.auth.deps import sign_value

CHROME_WIN = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/141.0.0.0 Safari/537.36")
SAFARI_IOS = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
              "Version/18.0 Mobile/15E148 Safari/604.1")


class FakeRedis:
    def __init__(self):
        self.kv, self.sets = {}, {}

    async def setex(self, k, ttl, v):
        self.kv[k] = v

    async def get(self, k):
        return self.kv.get(k)

    async def delete(self, *ks):
        for k in ks:
            self.kv.pop(k, None)
            self.sets.pop(k, None)

    async def sadd(self, k, *v):
        self.sets.setdefault(k, set()).update(v)

    async def srem(self, k, *v):
        self.sets.get(k, set()).difference_update(v)

    async def smembers(self, k):
        return set(self.sets.get(k, set()))

    async def expire(self, k, ttl):
        return True


class _Req:
    def __init__(self, token=None):
        self.headers = {"authorization": f"Bearer {token}"} if token else {}


class _User:
    def __init__(self, uid):
        self.id = uid


@pytest.fixture()
async def redis(monkeypatch):
    r = FakeRedis()

    async def _get():
        return r

    monkeypatch.setattr(sess_mod, "get_redis", _get)
    return r


async def _login(uid, ua, ip="10.0.0.5"):
    sid = await sess_mod.create_session(uid, ip, "", ua, 3600)
    return sid, sign_value({"user_id": uid, "tv": 0, "sid": sid})


def test_parse_ua():
    assert ms.parse_ua(CHROME_WIN)["browser"] == "Chrome" and ms.parse_ua(CHROME_WIN)["os"] == "Windows"
    ios = ms.parse_ua(SAFARI_IOS)
    assert ios["browser"] == "Safari" and ios["os"] == "iOS" and ios["device_type"] == "mobile"
    assert ms.parse_ua("")["device_type"] == "unknown"


@pytest.mark.asyncio
async def test_list_marks_current_and_hides_raw_sid(redis):
    sid_a, cookie_a = await _login("alice", CHROME_WIN)
    sid_b, _ = await _login("alice", SAFARI_IOS, ip="1.2.3.4")
    await _login("bob", CHROME_WIN)

    res = await ms.my_sessions(_Req(), ws_session=cookie_a, user=_User("alice"))
    rows = res["sessions"]
    assert len(rows) == 2 and rows[0]["current"] is True               # 현재 기기가 최상단
    assert rows[0]["device"] == "Chrome · Windows" and rows[0]["ip"] == "10.0.0.5"
    assert rows[1]["os"] == "iOS" and rows[1]["last_seen_at"]
    assert sid_a not in json.dumps(res) and sid_b not in json.dumps(res)

    # Bearer(번들 앱)로 요청해도 현재 기기 식별
    res = await ms.my_sessions(_Req(cookie_a), ws_session=None, user=_User("alice"))
    assert [r["current"] for r in res["sessions"]].count(True) == 1


@pytest.mark.asyncio
async def test_revoke_one_and_others(redis):
    sid_a, cookie_a = await _login("alice", CHROME_WIN)
    sid_b, _ = await _login("alice", SAFARI_IOS)
    sid_c, _ = await _login("alice", SAFARI_IOS)
    sid_bob, _ = await _login("bob", CHROME_WIN)

    # 타인의 세션 id 로는 종료 불가
    with pytest.raises(HTTPException) as e:
        await ms.revoke_my_session(ms.public_id(sid_bob), _Req(), ws_session=cookie_a, user=_User("alice"))
    assert e.value.status_code == 404
    assert await sess_mod.get_session(sid_bob) is not None

    res = await ms.revoke_my_session(ms.public_id(sid_b), _Req(), ws_session=cookie_a, user=_User("alice"))
    assert res == {"ok": True, "was_current": False}
    assert await sess_mod.get_session(sid_b) is None

    res = await ms.revoke_other_sessions(_Req(), ws_session=cookie_a, user=_User("alice"))
    assert res["revoked"] == 1 and res["kept_current"] is True
    assert await sess_mod.get_session(sid_a) is not None and await sess_mod.get_session(sid_c) is None
    assert await sess_mod.get_session(sid_bob) is not None
