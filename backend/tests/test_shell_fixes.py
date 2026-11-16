"""셸 구역 감사 수정 — 통합 검색 링크·파일 색인 검색, 알림 읽음 실시간 반영, 푸시 구독 정리, Git 바이너리 판정."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import (
    Base, Board, Channel, ChannelMember, FileIndex, Message, Notification, NotificationPref, Post,
    PushSubscription, User, UserPref,
)
from app.git import gitea
from app.notifications import router as nr
from app.notifications import service as nsvc
from app.push import router as pr
from app.search.router import global_search

TABLES = [t.__table__ for t in (
    User, Board, Post, Channel, ChannelMember, Message, FileIndex, Notification, NotificationPref, UserPref, PushSubscription,
)]


@pytest.fixture()
async def db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    import app.db.session as dbs
    monkeypatch.setattr(dbs, "async_session", factory)
    async with factory() as s:
        for uid in ("alice", "bob"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid.capitalize()))
        await s.commit()
        yield s
    await engine.dispose()


# ── 통합 검색 ──

async def test_search_urls_point_to_real_screens(db):
    alice = await db.get(User, "alice")
    db.add(Board(id="b1", name="공지", slug="notice"))
    db.add(Post(id="p1", board_id="b1", author_id="alice", title="배포 공지", content="배포 일정"))
    db.add(Channel(id="c1", name="dev", type="public", created_by="alice"))
    db.add(ChannelMember(channel_id="c1", user_id="alice"))
    db.add(Message(id="m1", channel_id="c1", sender_id="alice", content="배포 끝"))
    await db.commit()

    out = await global_search(q="배포", modules="board,chat", user=alice, db=db)
    by = {r["type"]: r for r in out["results"]}
    assert by["post"]["url"] == "/board/b1/p1"
    assert by["message"]["url"] == "/chat?channel=c1"


async def test_search_files_uses_index_scoped_to_user_and_shared(db):
    alice = await db.get(User, "alice")
    now = datetime.now(timezone.utc)

    def row(scope, rel, parent, name, is_dir=False):
        return FileIndex(scope=scope, rel_path=rel, parent_dir=parent, name=name, is_dir=is_dir, mtime=now)

    db.add_all([
        row("alice", "문서/보고서.txt", "문서", "보고서.txt"),
        row("alice", "보고서 모음", "", "보고서 모음", is_dir=True),
        row("alice", "보고서-루트.txt", "", "보고서-루트.txt"),
        row("shared", "팀/보고서-공용.txt", "팀", "보고서-공용.txt"),
        row("bob", "보고서-남의것.txt", "", "보고서-남의것.txt"),
        row("alice", ".trash/보고서-지움.txt", ".trash", "보고서-지움.txt"),
    ])
    await db.commit()

    out = await global_search(q="보고서", modules="files", user=alice, db=db)
    urls = {r["title"]: r["url"] for r in out["results"]}
    assert set(urls) == {"보고서.txt", "보고서 모음", "보고서-루트.txt", "보고서-공용.txt"}   # 타 사용자 항목·휴지통 제외
    assert urls["보고서-루트.txt"] == "/files?path=my"            # 루트 파일 — 이전에는 my/. 이었음
    assert urls["보고서-공용.txt"].startswith("/files?path=shared/")
    assert all(r["id"].split("/")[0] in ("my", "shared") for r in out["results"])


# ── 알림 읽음 → 다른 탭·기기 ──

async def test_mark_read_emits_unread_count(db, monkeypatch):
    sent = []
    import app.realtime.events as ev

    async def emit(uid, payload):
        sent.append((uid, payload))

    async def connected(uid):
        return True

    monkeypatch.setattr(ev, "emit_to_user", emit)
    monkeypatch.setattr(ev, "is_connected", connected)
    bob = await db.get(User, "bob")
    a = await nsvc.create_notification(db, "bob", "mention", "하나")
    await nsvc.create_notification(db, "bob", "mention", "둘")
    sent.clear()

    await nr.mark_read(a["id"], user=bob, db=db)
    assert sent == [("bob", {"type": "notification_read", "unread": 1})]
    await nr.mark_all_read(user=bob, db=db)
    assert sent[-1] == ("bob", {"type": "notification_read", "unread": 0})


# ── 푸시 구독 ──

async def test_subscribe_moves_endpoint_to_current_user(db):
    alice, bob = await db.get(User, "alice"), await db.get(User, "bob")
    sub = pr.PushSubscription(endpoint="https://push.example/abc", keys={"p256dh": "k", "auth": "a"})
    await pr.subscribe(sub, user=alice, db=db)
    await pr.subscribe(sub, user=bob, db=db)      # 동일 브라우저에 다른 사용자가 로그인
    await pr.subscribe(sub, user=bob, db=db)      # 멱등
    rows = (await db.execute(select(PushSubscription))).scalars().all()
    assert [(r.user_id, r.endpoint) for r in rows] == [("bob", "https://push.example/abc")]


def test_only_gone_subscriptions_are_dead():
    class Resp:
        def __init__(self, code):
            self.status_code = code

    class Err(Exception):
        def __init__(self, code=None):
            self.response = Resp(code) if code else None

    assert pr._is_gone(Err(410)) and pr._is_gone(Err(404))
    assert not pr._is_gone(Err(429)) and not pr._is_gone(Err(503)) and not pr._is_gone(Err())
    assert not pr._is_gone(TimeoutError())


# ── Git 파일 ──

def test_looks_binary():
    assert gitea._looks_binary(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
    assert gitea._looks_binary(bytes(range(128, 256)) * 20)
    assert not gitea._looks_binary("한글 주석이 있는 코드\nprint('x')\n".encode())
    assert not gitea._looks_binary(b"")
    assert not gitea._looks_binary("caf\xe9 latin-1 text with one odd byte\n".encode("latin-1") * 5)


async def test_get_file_does_not_decode_binary(monkeypatch):
    import base64

    async def fake_get(path, params=None):
        return {"name": "logo.png", "path": "logo.png", "size": 12, "sha": "s", "encoding": "base64",
                "content": base64.b64encode(b"\x89PNG\x00\x00\x01\x02").decode()}

    monkeypatch.setattr(gitea, "_get", fake_get)
    data = await gitea.get_file("o", "r", "logo.png")
    assert data["decoded_content"] is None and data["binary"] is True and not data.get("too_large")
