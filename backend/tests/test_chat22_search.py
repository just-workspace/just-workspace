"""chat22 — 검색 필터(GET /search): from·mentions·in·has·before/after/during(서울 하루)·pinned·sort·offset·total."""

import io
import json
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import update

from app.chat import notify, router22, service
from app.db.models import Message
from tests.chat22_fixtures import db, events, flush_tasks, u  # noqa: F401


async def _s(db, uid="bob", **kw):
    args = dict(q="", from_=None, mentions=None, in_=None, has=None, before=None, after=None, during=None,
                pinned=None, sort="new", offset=0, limit=25)
    args.update(kw)
    return await router22.search(user=await u(db, uid), db=db, **args)


async def _send(db, cid, uid, text, **kw):
    m = await service.create_message(db, cid, uid, text, **kw)
    await notify.after_message_created(db, m, cid, uid, text)
    await flush_tasks()
    return m


@pytest.mark.asyncio
async def test_filters(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob", "carol"])
    other = await service.create_channel(db, "dev", "public", "alice", member_ids=["bob"])
    secret = await service.create_channel(db, "secret", "private", "alice")
    m1 = await _send(db, ch.id, "alice", "배포 링크 https://example.com @bob")
    m2 = await _send(db, ch.id, "carol", "배포 끝")
    img = json.dumps([{"id": "1", "filename": "a.png", "mime_type": "image/png", "url": "/x", "size": 1}])
    m3 = await _send(db, other.id, "alice", "스크린샷", message_type="file", attachments=img)
    await _send(db, secret.id, "alice", "배포 비밀")
    await service.set_pinned(db, m2["id"], "alice", True)

    r = await _s(db, q="배포")
    assert r["total"] == 2 and {x["id"] for x in r["items"]} == {m1["id"], m2["id"]}   # 비멤버 채널 제외
    assert all("channel_name" in x and "channel_type" in x for x in r["items"])
    assert {x["id"] for x in (await _s(db, from_="carol"))["items"]} == {m2["id"]}
    assert {x["id"] for x in (await _s(db, mentions="bob"))["items"]} == {m1["id"]}
    assert {x["id"] for x in (await _s(db, in_=other.id))["items"]} == {m3["id"]}
    assert {x["id"] for x in (await _s(db, has="link"))["items"]} == {m1["id"]}
    assert {x["id"] for x in (await _s(db, has="image"))["items"]} == {m3["id"]}
    assert {x["id"] for x in (await _s(db, has="image,file"))["items"]} == {m3["id"]}
    assert (await _s(db, has="video"))["total"] == 0
    assert {x["id"] for x in (await _s(db, pinned=True))["items"]} == {m2["id"]}
    # 정렬·건너뛰기 — 시스템 줄("채널이 생성되었습니다")은 제외
    all_new = await _s(db)
    assert all_new["total"] == 3
    old = await _s(db, sort="old", limit=1, offset=1)
    assert [x["id"] for x in old["items"]] == [m2["id"]] and old["offset"] == 1 and old["limit"] == 1
    with pytest.raises(HTTPException) as e:
        await _s(db, has="poll")
    assert e.value.detail["code"] == "bad_filter"
    with pytest.raises(HTTPException):
        await _s(db, before="2026/10/01")


@pytest.mark.asyncio
async def test_dates_use_seoul_day(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    a = await _send(db, ch.id, "alice", "새벽 글")   # 서울 10-05 01:00 = UTC 10-04 16:00
    b = await _send(db, ch.id, "alice", "낮 글")     # 서울 10-05 15:00
    c = await _send(db, ch.id, "alice", "다음날")    # 서울 10-06 09:00
    for mid, ts in ((a["id"], datetime(2026, 10, 4, 16, 0, tzinfo=timezone.utc)),
                    (b["id"], datetime(2026, 10, 5, 6, 0, tzinfo=timezone.utc)),
                    (c["id"], datetime(2026, 10, 6, 0, 0, tzinfo=timezone.utc))):
        await db.execute(update(Message).where(Message.id == mid).values(created_at=ts))
    await db.commit()
    assert {x["id"] for x in (await _s(db, during="2026-10-05"))["items"]} == {a["id"], b["id"]}
    assert {x["id"] for x in (await _s(db, after="2026-10-05"))["items"]} == {c["id"]}
    assert {x["id"] for x in (await _s(db, before="2026-10-05", q="글"))["items"]} == set()
    assert {x["id"] for x in (await _s(db, before="2026-10-06", q="글"))["items"]} == {a["id"], b["id"]}
    # 사용자 시간대가 있으면 해당 시간대 적용(UTC 기준으로 a 는 10-04)
    bob = await u(db, "bob")
    bob.timezone = "UTC"
    await db.commit()
    assert {x["id"] for x in (await _s(db, during="2026-10-04"))["items"]} == {a["id"]}
