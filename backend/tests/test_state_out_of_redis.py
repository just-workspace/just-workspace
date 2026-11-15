"""Redis 에만 있던 값 셋이 DB 로 옮겨졌는가 — 개인 잠금 PIN, POP3 의 읽음·별표, 새 메일 감시의 마지막 UID.

보는 것:
- 이전: 예전 Redis 키에만 있던 값이 첫 접근 뒤 DB 에 있다.
- 복원 뒤: Redis 를 비워도(백업에는 Redis 가 없다) 값이 남는다.
- 옮긴 뒤에는 DB 가 기준이다 — Redis 의 낡은 값이 되살아나지 않는다.
- 이전 버전으로 되돌아갈 때를 위해 예전 키에도 같은 값을 써 둔다.
"""

import uuid
from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select, update

from app.auth.password import hash_password
from app.db.models import Base, MailAccount, MailPop3State, PrivacyPin, User
from app.db.session import async_session, engine
from app.mail import archive, imap_client, poller, pop3_client
from app.privacy import gate


class FakeRedis:
    """문자열·집합만 — 이 테스트가 쓰는 명령뿐이다."""

    def __init__(self):
        self.kv: dict[str, str] = {}
        self.sets: dict[str, set[str]] = {}
        self.published: list[tuple[str, str]] = []
        self.broken = False

    def _check(self):
        if self.broken:
            raise ConnectionError("redis 가 없다")

    async def get(self, key):
        self._check()
        return self.kv.get(key)

    async def set(self, key, value, **_kw):
        self._check()
        self.kv[key] = value
        return True

    async def delete(self, key):
        self._check()
        self.kv.pop(key, None)
        self.sets.pop(key, None)

    async def smembers(self, key):
        self._check()
        return set(self.sets.get(key, set()))

    async def sadd(self, key, *members):
        self._check()
        self.sets.setdefault(key, set()).update(members)

    async def srem(self, key, *members):
        self._check()
        self.sets.get(key, set()).difference_update(members)

    async def incr(self, key):
        self._check()
        self.kv[key] = str(int(self.kv.get(key, "0")) + 1)
        return int(self.kv[key])

    async def expire(self, key, _seconds):
        return True

    async def publish(self, channel, payload):
        self._check()
        self.published.append((channel, payload))

    def flush(self):
        """복원 뒤 — Redis 는 비어 있다."""
        self.kv.clear()
        self.sets.clear()


@pytest.fixture()
async def redis(monkeypatch):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    fake = FakeRedis()

    async def _get():
        return fake

    monkeypatch.setattr(gate, "get_redis", _get)
    monkeypatch.setattr(pop3_client, "get_redis", _get)
    monkeypatch.setattr(poller, "get_redis", _get)
    pop3_client._imported.clear()
    return fake


async def _user() -> str:
    uid = str(uuid.uuid4())
    async with async_session() as db:
        db.add(User(id=uid, username=f"u-{uid[:8]}", email=f"{uid[:8]}@example.com",
                    password_hash="x", display_name="u"))
        await db.commit()
    return uid


async def _account(protocol: str = "pop3") -> MailAccount:
    uid = await _user()
    acc = MailAccount(
        id=str(uuid.uuid4()), user_id=uid, display_name="밖", email=f"{uid[:8]}@example.net", protocol=protocol,
        imap_host="mail.example.net", smtp_host="mail.example.net", username="u", password_encrypted="x",
    )
    async with async_session() as db:
        db.add(acc)
        await db.commit()
    return acc


async def _reload(acc: MailAccount) -> MailAccount:
    async with async_session() as db:
        return (await db.execute(select(MailAccount).where(MailAccount.id == acc.id))).scalar_one()


# ─── 개인 잠금 PIN ───


async def _pin_row(uid: str) -> str | None:
    async with async_session() as db:
        row = await db.get(PrivacyPin, uid)
        return row.pin_hash if row else None


async def test_pin_set_goes_to_db_and_survives_empty_redis(redis):
    uid = await _user()
    assert await gate.has_pin(uid) is False
    await gate.set_pin(uid, "4321")
    assert await _pin_row(uid)
    redis.flush()                                            # 복원 뒤
    assert await gate.has_pin(uid) is True
    assert await gate.verify_pin(uid, "4321") is True
    assert await gate.verify_pin(uid, "0000") is False


async def test_pin_in_redis_only_moves_to_db_on_first_access(redis):
    uid = await _user()
    legacy = hash_password("2468")
    redis.kv[gate._pin_key(uid)] = legacy                    # 업데이트 전의 상태
    assert await _pin_row(uid) is None

    assert await gate.has_pin(uid) is True
    assert await _pin_row(uid) == legacy                     # 첫 접근에 옮겨졌다
    assert redis.kv[gate._pin_key(uid)] == legacy            # 예전 키는 그대로(이전 버전으로 되돌아갈 때)
    redis.flush()
    assert await gate.verify_pin(uid, "2468") is True


async def test_pin_db_wins_over_stale_redis_and_new_pin_is_mirrored(redis):
    uid = await _user()
    redis.kv[gate._pin_key(uid)] = hash_password("1111")
    assert await gate.verify_pin(uid, "1111") is True        # 옮김
    await gate.set_pin(uid, "2222")
    assert redis.kv[gate._pin_key(uid)] == await _pin_row(uid)   # 사본도 새 값
    redis.kv[gate._pin_key(uid)] = hash_password("9999")     # 누가 Redis 를 옛 값으로 되돌려도
    assert await gate.verify_pin(uid, "2222") is True
    assert await gate.verify_pin(uid, "9999") is False


async def test_pin_works_without_redis_and_concurrent_import_is_quiet(redis):
    uid = await _user()
    legacy = hash_password("1357")
    redis.kv[gate._pin_key(uid)] = legacy
    # 다른 워커가 먼저 옮긴 상황: DB 에 이미 행이 있는데 한 번 더 넣으려 한다
    async with async_session() as db:
        db.add(PrivacyPin(user_id=uid, pin_hash=legacy))
        await db.commit()
    real = gate._db_hash
    calls = {"n": 0}

    async def first_miss(u):
        calls["n"] += 1
        return None if calls["n"] == 1 else await real(u)

    gate._db_hash, saved = first_miss, gate._db_hash
    try:
        assert await gate.verify_pin(uid, "1357") is True    # 유니크 충돌이 예외로 새지 않는다
    finally:
        gate._db_hash = saved

    redis.broken = True                                      # Redis 가 죽어도 DB 의 PIN 은 통한다
    assert await gate.has_pin(uid) is True
    await gate.set_pin(uid, "8642")                          # 사본 쓰기 실패는 삼킨다
    assert await gate.verify_pin(uid, "8642") is True
    assert await gate.has_pin(await _user()) is False


# ─── POP3 읽음·별표 ───


async def _rows(acc) -> dict[str, tuple[bool, bool]]:
    async with async_session() as db:
        rows = (await db.execute(select(MailPop3State).where(MailPop3State.account_id == acc.id))).scalars().all()
    return {r.uidl: (bool(r.is_read), bool(r.is_flagged)) for r in rows}


async def test_pop3_flags_go_to_db_and_survive_empty_redis(redis):
    acc = await _account()
    await pop3_client.update_flags(acc, "INBOX", "m1", add_flags=["\\Seen"])
    await pop3_client.update_flags(acc, "INBOX", "m2", add_flags=["\\Seen", "\\Flagged"])
    await pop3_client.update_flags(acc, "INBOX", "m3", add_flags=["\\Flagged"])
    assert await _rows(acc) == {"m1": (True, False), "m2": (True, True), "m3": (False, True)}
    # 예전 집합의 사본(이전 버전으로 되돌아갈 때)
    assert redis.sets[pop3_client._read_key(acc.id)] == {"m1", "m2"}
    assert redis.sets[pop3_client._flag_key(acc.id)] == {"m2", "m3"}

    redis.flush()                                            # 복원 뒤
    pop3_client._imported.clear()                            # 서버도 새로 떴다
    assert await pop3_client._state(acc.id) == ({"m1", "m2"}, {"m2", "m3"})

    await pop3_client.update_flags(acc, "INBOX", "m2", remove_flags=["\\Seen"])
    await pop3_client.update_flags(acc, "INBOX", "m3", remove_flags=["\\Flagged"])
    assert await _rows(acc) == {"m1": (True, False), "m2": (False, True)}      # 둘 다 꺼진 행은 지운다


async def test_pop3_flags_in_redis_only_move_once(redis):
    acc = await _account()
    redis.sets[pop3_client._read_key(acc.id)] = {"a", "b"}
    redis.sets[pop3_client._flag_key(acc.id)] = {"b", "c"}
    assert await _rows(acc) == {}

    assert await pop3_client._state(acc.id) == ({"a", "b"}, {"b", "c"})        # 첫 접근에 옮겨졌다
    assert await _rows(acc) == {"a": (True, False), "b": (True, True), "c": (False, True)}
    assert (await _reload(acc)).pop3_state_imported is True

    # 전부 안 읽음으로 되돌린 뒤 Redis 에 낡은 집합이 남아 있어도 다시 옮기지 않는다
    for uidl in ("a", "b"):
        await pop3_client.update_flags(acc, "INBOX", uidl, remove_flags=["\\Seen"])
    for uidl in ("b", "c"):
        await pop3_client.update_flags(acc, "INBOX", uidl, remove_flags=["\\Flagged"])
    redis.sets[pop3_client._read_key(acc.id)] = {"a", "b"}
    pop3_client._imported.clear()
    assert await pop3_client._state(acc.id) == (set(), set())


async def test_pop3_import_is_claimed_by_one_worker_and_waits_for_redis(redis):
    acc = await _account()
    redis.sets[pop3_client._read_key(acc.id)] = {"a"}
    redis.broken = True                                      # Redis 를 못 읽으면 옮겼다고 적지 않는다
    assert await pop3_client._state(acc.id) == (set(), set())
    assert not (await _reload(acc)).pop3_state_imported
    redis.broken = False
    assert await pop3_client._state(acc.id) == ({"a"}, set())

    # 두 번째 워커: 이미 옮긴 계정 — 행을 다시 넣으려 들지 않는다
    pop3_client._imported.clear()
    redis.sets[pop3_client._read_key(acc.id)] = {"a", "zzz"}
    assert await pop3_client._state(acc.id) == ({"a"}, set())


async def test_pop3_forget_removes_state(redis):
    acc = await _account()
    await pop3_client.update_flags(acc, "INBOX", "gone", add_flags=["\\Seen", "\\Flagged"])
    await pop3_client._forget(acc.id, "gone")
    assert await _rows(acc) == {}
    assert redis.sets[pop3_client._read_key(acc.id)] == set()


async def test_pop3_state_for_unknown_account_is_empty(redis):
    assert await pop3_client._state("no-such-account") == (set(), set())


# ─── 새 메일 감시의 마지막 UID ───


@pytest.fixture()
def inbox(monkeypatch):
    box = {"uids": [10, 11, 12]}
    archived: list[str] = []

    async def fetch_messages(account, mailbox, page=0, limit=30):
        return [{"id": str(u), "subject": f"s{u}", "from_": []} for u in box["uids"]], len(box["uids"])

    async def archive_message(account, uid, *_a, **_kw):
        archived.append(uid)

    monkeypatch.setattr(imap_client, "fetch_messages", fetch_messages)
    monkeypatch.setattr(archive, "archive_message", archive_message)
    box["archived"] = archived
    return box


async def test_poller_keeps_last_uid_in_db_and_survives_empty_redis(redis, inbox):
    acc = await _account("imap")
    await poller._poll_account(redis, acc)                   # 첫 폴: 기준만 잡는다
    assert redis.published == [] and (await _reload(acc)).last_seen_uid == 12
    assert redis.kv[poller._lastuid_key(acc.id)] == "12"     # 예전 키의 사본

    redis.flush()                                            # 복원 뒤
    async with async_session() as db:                        # 계정의 수정 시각은 감시가 건드리지 않는다
        await db.execute(update(MailAccount).where(MailAccount.id == acc.id).values(updated_at=datetime(2026, 1, 1)))
        await db.commit()
    inbox["uids"] = [11, 12, 13, 14]
    await poller._poll_account(redis, await _reload(acc))
    assert inbox["archived"] == ["13", "14"]                 # 기준을 잃지 않았다 — 새 메일만 알린다
    after = await _reload(acc)
    assert len(redis.published) == 2 and after.last_seen_uid == 14
    assert after.updated_at.replace(tzinfo=None) == datetime(2026, 1, 1)

    await poller._poll_account(redis, after)                 # 새 메일이 없으면 그대로
    assert len(redis.published) == 2


async def test_poller_moves_last_uid_from_redis_once(redis, inbox):
    acc = await _account("imap")
    redis.kv[poller._lastuid_key(acc.id)] = "11"             # 업데이트 전의 상태
    await poller._poll_account(redis, acc)
    assert inbox["archived"] == ["12"]                       # 기준을 다시 잡지 않고 이어서 본다
    assert (await _reload(acc)).last_seen_uid == 12

    redis.kv[poller._lastuid_key(acc.id)] = "5"              # 낡은 값이 남아 있어도 DB 가 기준
    await poller._poll_account(redis, await _reload(acc))
    assert inbox["archived"] == ["12"]


async def test_poller_skips_pop3_and_tolerates_broken_redis_on_import(redis, inbox):
    pop = await _account("pop3")
    await poller._poll_account(redis, pop)
    assert (await _reload(pop)).last_seen_uid is None

    acc = SimpleNamespace(id="x", email="x@example.net", last_seen_uid=None)
    redis.broken = True
    assert await poller._load_last_seen(redis, acc) == 0
