"""수신인 자동완성 — 출처 병합과 중복 통합."""

import pytest

from app.contacts import suggest as sug


@pytest.mark.asyncio
async def test_merge_folds_duplicates_and_keeps_first_source(monkeypatch):
    """동일 주소가 여러 출처에 있으면 한 줄로 통합되고 출처는 모두 유지되어야 한다."""
    async def fake_recent(user_id, q, limit):
        return [{"email": "a@x.com", "name": "에이", "source": "recent"}]

    async def fake_users(db, viewer_id, q, limit):
        return [{"email": "a@x.com", "name": "에이 사용자", "username": "aa",
                 "user_id": "u1", "source": "user"}]

    async def fake_book(db, user_id, q, limit):
        return [{"email": "b@x.com", "name": "비", "source": "contact"}]

    monkeypatch.setattr(sug, "_recent", fake_recent)
    monkeypatch.setattr(sug, "_internal_users", fake_users)
    monkeypatch.setattr(sug, "_address_book", fake_book)

    out = await sug.suggest(None, "me", "", limit=10)
    assert len(out) == 2, "중복이 접히지 않았다"

    a = next(o for o in out if o["email"] == "a@x.com")
    assert a["sources"] == ["recent", "user"], "출처가 모두 남지 않았다"
    # 먼저 수신된 출처(recent)의 순위를 유지하되 빈 필드는 후순위 출처가 채운다
    assert a["name"] == "에이"
    assert a["user_id"] == "u1", "뒤 출처의 정보가 병합되지 않았다"

    assert out[0]["email"] == "a@x.com", "최근 수신인이 앞에 와야 한다"


@pytest.mark.asyncio
async def test_limit_is_respected(monkeypatch):
    async def many(*a, **k):
        return [{"email": f"{i}@x.com", "name": str(i), "source": "recent"} for i in range(50)]

    async def none(*a, **k):
        return []

    monkeypatch.setattr(sug, "_recent", many)
    monkeypatch.setattr(sug, "_internal_users", none)
    monkeypatch.setattr(sug, "_address_book", none)

    out = await sug.suggest(None, "me", "", limit=5)
    assert len(out) == 5


@pytest.mark.asyncio
async def test_record_recipients_never_raises(monkeypatch):
    """Redis 장애 시에도 메일 발송이 실패하면 안 된다."""
    async def boom():
        raise RuntimeError("redis down")

    monkeypatch.setattr(sug, "get_redis", boom)
    await sug.record_recipients("u1", [{"email": "a@x.com", "name": "A"}])  # 예외가 발생하지 않아야 통과


@pytest.mark.asyncio
async def test_record_skips_empty_addresses(monkeypatch):
    captured = {}

    class FakeRedis:
        async def zadd(self, key, mapping): captured["mapping"] = mapping
        async def zremrangebyrank(self, *a): pass
        async def expire(self, *a): pass

    async def fake_get_redis():
        return FakeRedis()

    monkeypatch.setattr(sug, "get_redis", fake_get_redis)
    await sug.record_recipients("u1", [{"email": "", "name": "빈값"}, {"email": "A@X.com", "name": "A"}])
    assert len(captured["mapping"]) == 1
    # 주소는 소문자로 정규화되어야 중복이 누적되지 않는다
    assert "a@x.com" in list(captured["mapping"].keys())[0]


def test_static_routes_are_declared_before_contact_id():
    """FastAPI 는 정의 순서로 매칭한다. /{contact_id} 가 앞에 있으면
    /suggest, /export-vcf 같은 정적 경로가 전부 동작하지 않는다(실제로 export-vcf 에서 발생했다)."""
    import inspect
    import re
    from app.contacts import router as contacts_router

    src = inspect.getsource(contacts_router)
    order = re.findall(r'@router\.(?:get|post|patch|delete)\("(/[^"]*)"', src)

    param_idx = order.index("/{contact_id}")
    for static in ("/suggest", "/external-accounts", "/export-vcf"):
        assert order.index(static) < param_idx, f"{static} 가 /{{contact_id}} 뒤에 있다"
