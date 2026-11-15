"""채팅 링크 미리보기(R5 B12) — SSRF 방어·파싱·캐시·썸네일 프록시·보낸 사람 지우기.

외부 접속은 httpx.MockTransport, DNS 는 가짜 resolver 로 대신한다(네트워크 없이 돈다).
"""

import asyncio
import gzip
import io
import json

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.chat import link_preview as lp
from app.chat import router as chat_router
from app.chat import service
from app.db.models import (
    Base, Channel, ChannelMember, ChatDraft, ChatMention, LinkPreviewCache, LinkPreviewImage, Message,
    Notification, Reaction, SavedMessage, SystemSetting, ThreadFollow, User,
)

PUBLIC = "93.184.216.34"
PUBLIC6 = "2606:4700:4700::1111"


def _resolver(table: dict[str, list]):
    """호스트 → 주소 목록. 값이 목록의 목록이면 부를 때마다 다음 것을 준다(리바인딩 흉내)."""
    calls: list[str] = []

    async def resolve(host, port):
        calls.append(host)
        v = table.get(host)
        if v is None:
            raise OSError("nxdomain")
        if v and isinstance(v[0], list):
            return v.pop(0) if len(v) > 1 else v[0]
        return v

    resolve.calls = calls
    return resolve


def _transport(handler):
    seen: list[httpx.Request] = []

    async def h(req: httpx.Request):
        seen.append(req)
        r = handler(req)
        if asyncio.iscoroutine(r):
            r = await r
        return r

    t = httpx.MockTransport(h)
    t.seen = seen
    return t


HTML = (
    '<html><head><meta charset="utf-8"><title>무시되는 제목</title>'
    '<meta property="og:site_name" content="예시 블로그">'
    '<meta property="og:title" content="무중단 Postgres 마이그레이션 체크리스트">'
    '<meta property="og:description" content="잠금 없는 인덱스 생성, 컬럼 추가 순서.">'
    '<meta property="og:image" content="/img/cover.png">'
    '</head><body>본문</body></html>'
)


def _png(w=640, h=320, color=(200, 30, 30)) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


# ── 주소 판정 ──

@pytest.mark.parametrize("ip", [
    "10.0.0.1", "172.16.5.4", "192.168.10.120", "127.0.0.1", "127.8.8.8", "0.0.0.0",
    "169.254.169.254",            # 클라우드 메타데이터
    "169.254.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "192.0.2.10",
    "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254",   # IPv4-mapped
    "2002:7f00:0001::1",                            # 6to4 안의 127.0.0.1
    "64:ff9b::a9fe:a9fe",                           # NAT64 안의 169.254.169.254
    "64:ff9b::c0a8:1",                              # NAT64 안의 192.168.10.1
    "::127.0.0.1",                                  # IPv4 호환(폐기 형식)
    "fe80::1%eth0", "not-an-ip",
])
def test_ip_blocked(ip):
    assert lp.ip_allowed(ip) is False


@pytest.mark.parametrize("ip", [PUBLIC, "1.1.1.1", PUBLIC6, "64:ff9b::808:808"])
def test_ip_public_allowed(ip):
    assert lp.ip_allowed(ip) is True


@pytest.mark.parametrize("url,code", [
    ("ftp://example.com/x", "scheme"),
    ("file:///etc/passwd", "scheme"),
    ("javascript:alert(1)", "scheme"),
    ("gopher://example.com:70/", "scheme"),
    ("http://user:pw@example.com/", "invalid_url"),
    ("http://example.com:22/", "port"),
    ("http://example.com:6379/", "port"),
    ("http://" + "a" * 2100 + ".com/", "invalid_url"),
    ("http:///nohost", "invalid_url"),
])
def test_normalize_rejects(url, code):
    with pytest.raises(lp.PreviewError) as e:
        lp.normalize_url(url)
    assert e.value.code == code


# ── 사설·루프백·링크로컬·메타데이터: 접속 전에 막힌다 ──

@pytest.mark.parametrize("url", [
    "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5:8080/", "http://192.168.10.120/", "http://[::ffff:127.0.0.1]/",
    "http://0.0.0.0/", "http://[fe80::1]/", "https://100.64.1.1/",
])
async def test_literal_internal_ips_blocked_before_connect(url):
    t = _transport(lambda r: httpx.Response(200, html=HTML))
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get(url, transport=t, resolver=_resolver({}))
    assert e.value.code == "blocked"
    assert t.seen == []


@pytest.mark.parametrize("url", [
    "http://2130706433/",      # 10진 정수 = 127.0.0.1
    "http://0x7f000001/",      # 16진
    "http://127.1/",           # 줄임 표기
    "http://localhost/",
])
async def test_numeric_and_localhost_forms_blocked(url):
    """ip_address() 가 못 읽는 표기는 실제 getaddrinfo 가 127.0.0.1 로 푼다 — 그 결과로 막혀야 한다."""
    t = _transport(lambda r: httpx.Response(200, html=HTML))
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get(url, transport=t)   # 시스템 resolver(숫자 표기·localhost 는 네트워크 없이 풀린다)
    assert e.value.code in ("blocked", "dns")
    assert t.seen == []


async def test_hostname_resolving_private_blocked():
    t = _transport(lambda r: httpx.Response(200, html=HTML))
    for ips in (["10.1.2.3"], ["169.254.169.254"], ["::1"], [PUBLIC, "192.168.10.10"]):
        with pytest.raises(lp.PreviewError) as e:
            await lp.safe_get("http://evil.test/", transport=t, resolver=_resolver({"evil.test": ips}))
        assert e.value.code == "blocked"   # 하나라도 사설이면 거부(섞어 두기 수법)
    assert t.seen == []


async def test_dns_failure():
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://nx.test/", transport=_transport(lambda r: httpx.Response(200)),
                          resolver=_resolver({}))
    assert e.value.code == "dns"


# ── 리다이렉트 우회 ──

async def test_redirect_to_internal_literal_blocked():
    def h(req):
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})
    t = _transport(h)
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://example.com/", transport=t, resolver=_resolver({"example.com": [PUBLIC]}))
    assert e.value.code == "blocked"
    assert len(t.seen) == 1                      # 메타데이터 주소로는 한 번도 안 갔다


async def test_redirect_to_hostname_resolving_private_blocked():
    def h(req):
        return httpx.Response(301, headers={"Location": "https://internal.test/admin"})
    t = _transport(h)
    res = _resolver({"example.com": [PUBLIC], "internal.test": ["10.0.0.7"]})
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://example.com/", transport=t, resolver=res)
    assert e.value.code == "blocked"
    assert res.calls == ["example.com", "internal.test"]   # 리다이렉트마다 다시 풀어 검사
    assert len(t.seen) == 1


async def test_redirect_to_other_scheme_and_too_many():
    t = _transport(lambda r: httpx.Response(302, headers={"Location": "file:///etc/passwd"}))
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://example.com/", transport=t, resolver=_resolver({"example.com": [PUBLIC]}))
    assert e.value.code == "scheme"

    t = _transport(lambda r: httpx.Response(302, headers={"Location": "/again"}))
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://example.com/", transport=t, resolver=_resolver({"example.com": [PUBLIC]}))
    assert e.value.code == "network"
    assert len(t.seen) == lp.MAX_REDIRECTS + 1


async def test_redirect_followed_when_public():
    def h(req):
        if req.url.path == "/":
            return httpx.Response(302, headers={"Location": "https://cdn.example.net/post"})
        return httpx.Response(200, html=HTML)
    t = _transport(h)
    got = await lp.safe_get("http://example.com/", transport=t,
                            resolver=_resolver({"example.com": [PUBLIC], "cdn.example.net": ["1.1.1.1"]}))
    assert got.url == "https://cdn.example.net/post"
    assert [r.url.host for r in t.seen] == [PUBLIC, "1.1.1.1"]


# ── DNS 리바인딩: 검사한 IP 로 접속을 고정 ──

async def test_connects_to_checked_ip_with_original_host_header():
    t = _transport(lambda r: httpx.Response(200, html=HTML))
    await lp.safe_get("https://example.com/post?x=1", transport=t,
                      resolver=_resolver({"example.com": [PUBLIC]}))
    req = t.seen[0]
    assert req.url.host == PUBLIC                    # 이름이 아니라 검사한 IP 로 접속
    assert req.headers["host"] == "example.com"      # 가상 호스트는 원래 이름
    assert req.extensions.get("sni_hostname") == "example.com"   # TLS SNI·인증서 검증도 원래 이름
    assert req.url.query == b"x=1"


async def test_rebinding_second_resolution_private_is_blocked():
    """첫 풀이는 공인, 같은 이름의 다음 풀이(리다이렉트 뒤)는 사설 — 다시 풀 때 막혀야 한다."""
    def h(req):
        return httpx.Response(302, headers={"Location": "http://rebind.test/next"})
    t = _transport(h)
    res = _resolver({"rebind.test": [[PUBLIC], ["127.0.0.1"]]})
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://rebind.test/", transport=t, resolver=res)
    assert e.value.code == "blocked"
    assert [r.url.host for r in t.seen] == [PUBLIC]   # 사설 IP 로는 접속하지 않았다


async def test_ipv6_pinned_url_brackets():
    t = _transport(lambda r: httpx.Response(200, html=HTML))
    await lp.safe_get("http://v6.example.com/", transport=t, resolver=_resolver({"v6.example.com": [PUBLIC6]}))
    assert t.seen[0].url.host == PUBLIC6
    assert t.seen[0].headers["host"] == "v6.example.com"


# ── 크기·시간 제한 ──

async def test_body_over_1mb_rejected():
    big = b"a" * (lp.MAX_BYTES + 1)
    t = _transport(lambda r: httpx.Response(200, content=big, headers={"content-type": "text/html"}))
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://example.com/", transport=t, resolver=_resolver({"example.com": [PUBLIC]}))
    assert e.value.code == "too_large"


async def test_declared_length_over_1mb_rejected():
    t = _transport(lambda r: httpx.Response(200, content=b"x", headers={"content-length": str(50 * 1024 * 1024)}))
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://example.com/", transport=t, resolver=_resolver({"example.com": [PUBLIC]}))
    assert e.value.code == "too_large"


async def test_gzip_bomb_rejected_by_decoded_size():
    bomb = gzip.compress(b"\0" * (lp.MAX_BYTES * 3))
    assert len(bomb) < lp.MAX_BYTES
    t = _transport(lambda r: httpx.Response(200, content=bomb, headers={
        "content-type": "text/html", "content-encoding": "gzip"}))
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://example.com/", transport=t, resolver=_resolver({"example.com": [PUBLIC]}))
    assert e.value.code == "too_large"


async def test_total_timeout():
    async def slow(req):
        await asyncio.sleep(2)
        return httpx.Response(200, html=HTML)
    t = _transport(slow)
    with pytest.raises(lp.PreviewError) as e:
        await lp.safe_get("http://example.com/", transport=t, resolver=_resolver({"example.com": [PUBLIC]}),
                          timeout=0.2)
    assert e.value.code == "timeout"


def test_limits_match_brief():
    assert lp.MAX_BYTES == 1024 * 1024 and lp.TOTAL_TIMEOUT == 5.0


# ── 파싱·링크 고르기 ──

def test_parse_meta_og_and_fallbacks():
    m = lp.parse_meta(HTML, "https://blog.example.dev/post/1")
    assert m == {
        "site": "예시 블로그", "title": "무중단 Postgres 마이그레이션 체크리스트",
        "description": "잠금 없는 인덱스 생성, 컬럼 추가 순서.",
        "image_src": "https://blog.example.dev/img/cover.png",
    }
    m = lp.parse_meta("<html><head><title> Release  process </title></head></html>", "https://www.docs.example.org/r")
    assert m["title"] == "Release process" and m["site"] == "docs.example.org"
    assert m["description"] is None and m["image_src"] is None
    assert lp.parse_meta("<html><body>no title</body></html>", "https://x.example/") is None
    # 이미지가 javascript: 같은 엉뚱한 주소면 버린다
    m = lp.parse_meta('<title>t</title><meta property="og:image" content="javascript:alert(1)">', "https://x.example/")
    assert m["image_src"] is None


def test_first_external_url(monkeypatch):
    monkeypatch.setattr(lp, "_internal_hosts", lambda: {"ws.example.com"})
    f = lp.first_external_url
    assert f("읽어 주세요 https://blog.example.dev/zero-downtime.") == "https://blog.example.dev/zero-downtime"
    assert f("[글](https://a.example/x_(y)) 그리고 https://b.example") == "https://a.example/x_(y)"
    assert f("`https://code.example/` 다음 https://real.example/p") == "https://real.example/p"
    assert f("```\nhttps://block.example/\n```") is None
    assert f("내부 https://ws.example.com/files/1 와 https://sub.ws.example.com/x") is None
    assert f("내부 다음 외부 https://ws.example.com/a https://out.example/b") == "https://out.example/b"
    assert f("ftp://x.example/ 없음") is None
    assert f("") is None and f(None) is None


def test_thumbnail_reencodes_and_rejects_svg():
    out = lp.make_thumbnail(_png(1200, 600))
    assert out is not None
    body, ctype = out
    assert ctype == "image/jpeg" and body[:3] == b"\xff\xd8\xff"
    from PIL import Image
    assert max(Image.open(io.BytesIO(body)).size) <= lp.THUMB_MAX
    assert lp.make_thumbnail(b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') is None
    assert lp.make_thumbnail(b"GIF89a" + b"\0" * 10) is None   # 깨진 그림


# ── 캐시·메시지 붙이기·지우기 ──

TABLES = [t.__table__ for t in (User, Channel, ChannelMember, Message, Reaction, ChatMention,
                                ThreadFollow, ChatDraft, SavedMessage, LinkPreviewCache, LinkPreviewImage,
                                Notification, SystemSetting)]


@pytest.fixture()
async def factory():
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=TABLES))
    f = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with f() as s:
        for uid in ("alice", "bob"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x", password_hash="x", display_name=uid))
        await s.commit()
    yield f
    await engine.dispose()


def _site():
    png = _png()

    def h(req):
        if req.url.path == "/img/cover.png":
            return httpx.Response(200, content=png, headers={"content-type": "image/png"})
        return httpx.Response(200, html=HTML)
    return _transport(h)


async def test_attach_end_to_end_cache_and_image_proxy(factory):
    events = []

    async def emit(cid, ev):
        events.append((cid, ev))

    res = _resolver({"blog.example.dev": [PUBLIC]})
    t = _site()
    async with factory() as db:
        ch = await service.create_channel(db, "dev", "public", "alice", member_ids=["bob"])
        msg = await service.create_message(db, ch.id, "alice", "읽어 주세요 https://blog.example.dev/post")
    url = lp.first_external_url(msg["content"])
    card = await lp.attach_to_message(msg["id"], url, factory, emit, transport=t, resolver=res)

    assert card["title"] == "무중단 Postgres 마이그레이션 체크리스트"
    assert card["site"] == "예시 블로그"
    assert card["image"].startswith("/api/chat/link-preview/images/")   # 외부 주소가 아니라 서버 프록시
    assert "blog.example.dev/img" not in json.dumps(card)
    assert events and events[0][1]["type"] == "link_preview" and events[0][1]["message_id"] == msg["id"]
    assert len(t.seen) == 2   # 페이지 + 이미지

    async with factory() as db:
        m = await db.get(Message, msg["id"])
        assert service._message_to_dict(m, None)["link_preview"] == card
        img_id = card["image"].rsplit("/", 1)[1]
        img = await db.get(LinkPreviewImage, img_id)
        assert img.content_type == "image/jpeg" and img.data[:3] == b"\xff\xd8\xff"

        # 썸네일 엔드포인트 — 다시 인코딩된 것만, 안전 헤더
        bob = await db.get(User, "bob")
        resp = await chat_router.link_preview_image(image_id=img_id, user=bob, db=db)
        assert resp.media_type == "image/jpeg"
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert "sandbox" in resp.headers["content-security-policy"]
        with pytest.raises(HTTPException):
            await chat_router.link_preview_image(image_id="../../etc/passwd", user=bob, db=db)

        # 같은 링크의 두 번째 메시지 — 캐시로, 외부에 다시 가지 않는다
        msg2 = await service.create_message(db, ch.id, "bob", "저도 https://blog.example.dev/post")
    card2 = await lp.attach_to_message(msg2["id"], url, factory, emit, transport=t, resolver=res)
    assert card2 == card and len(t.seen) == 2


async def test_failed_fetch_gives_no_card(factory):
    events = []

    async def emit(cid, ev):
        events.append(ev)

    async with factory() as db:
        ch = await service.create_channel(db, "dev", "public", "alice")
        msg = await service.create_message(db, ch.id, "alice", "http://intranet.test/x")
    res = _resolver({"intranet.test": ["10.0.0.9"]})
    t = _transport(lambda r: httpx.Response(200, html=HTML))
    card = await lp.attach_to_message(msg["id"], "http://intranet.test/x", factory, emit, transport=t, resolver=res)
    assert card is None and events == [] and t.seen == []
    async with factory() as db:
        assert (await db.get(Message, msg["id"])).link_preview is None
        row = await db.get(LinkPreviewCache, lp.url_hash("http://intranet.test/x"))
        assert row is not None and row.data is None    # 실패도 잠깐 캐시


async def test_svg_image_dropped_card_kept(factory):
    def h(req):
        if req.url.path.endswith(".svg"):
            return httpx.Response(200, content=b"<svg/>", headers={"content-type": "image/svg+xml"})
        return httpx.Response(200, html='<title>T</title><meta property="og:image" content="/a.svg">')
    async with factory() as db:
        ch = await service.create_channel(db, "dev", "public", "alice")
        msg = await service.create_message(db, ch.id, "alice", "https://svg.example/p")

    async def emit(cid, ev):
        pass
    card = await lp.attach_to_message(msg["id"], "https://svg.example/p", factory, emit,
                                      transport=_transport(h), resolver=_resolver({"svg.example": [PUBLIC]}))
    assert card["title"] == "T" and card["image"] is None    # 썸네일 칸 없음


async def test_dismiss_only_sender_and_not_recreated(factory, monkeypatch):
    events = []

    async def emit(cid, ev):
        events.append(ev)
    monkeypatch.setattr(chat_router, "emit_to_channel", emit)

    async with factory() as db:
        ch = await service.create_channel(db, "dev", "public", "alice", member_ids=["bob"])
        msg = await service.create_message(db, ch.id, "alice", "https://blog.example.dev/post")
    url = "https://blog.example.dev/post"
    await lp.attach_to_message(msg["id"], url, factory, emit, transport=_site(),
                               resolver=_resolver({"blog.example.dev": [PUBLIC]}))

    async with factory() as db:
        bob = await db.get(User, "bob")
        alice = await db.get(User, "alice")
        with pytest.raises(HTTPException) as e:
            await chat_router.dismiss_link_preview(message_id=msg["id"], user=bob, db=db)
        assert e.value.status_code == 403
        assert await chat_router.dismiss_link_preview(message_id=msg["id"], user=alice, db=db) == {"ok": True}
        assert events[-1] == {"type": "link_preview", "message_id": msg["id"], "channel_id": ch.id,
                              "parent_id": None, "link_preview": None}
        m = await db.get(Message, msg["id"])
        assert service._message_to_dict(m, None)["link_preview"] is None

    # 같은 링크로는 다시 만들지 않는다
    again = await lp.attach_to_message(msg["id"], url, factory, emit, transport=_site(),
                                       resolver=_resolver({"blog.example.dev": [PUBLIC]}))
    assert again is None

    # 본문 링크를 바꾸면 "지움" 표시가 풀린다
    async with factory() as db:
        await service.update_message(db, msg["id"], "https://other.example/x")
        assert (await db.get(Message, msg["id"])).link_preview is None


async def test_message_edited_meanwhile_is_not_overwritten(factory):
    async with factory() as db:
        ch = await service.create_channel(db, "dev", "public", "alice")
        msg = await service.create_message(db, ch.id, "alice", "https://blog.example.dev/post")
        await service.update_message(db, msg["id"], "링크 없앰")

    async def emit(cid, ev):
        raise AssertionError("보내면 안 된다")
    card = await lp.attach_to_message(msg["id"], "https://blog.example.dev/post", factory, emit,
                                      transport=_site(), resolver=_resolver({"blog.example.dev": [PUBLIC]}))
    assert card is None


def test_schedule_skips_non_text_and_no_link():
    assert lp.schedule_for_message({"id": "m", "message_type": "file", "content": "https://a.example"}) is None
    assert lp.schedule_for_message({"id": "m", "message_type": "text", "content": "링크 없음"}) is None


def test_public_preview_shapes():
    assert lp.public_preview(None) is None
    assert lp.public_preview("not json") is None
    assert lp.public_preview(json.dumps({"dismissed": True, "url": "https://a"})) is None
    assert lp.public_preview(json.dumps({"url": "https://a", "title": "T", "site": "a", "description": None,
                                         "image": None, "extra": 1})) == {
        "url": "https://a", "site": "a", "title": "T", "description": None, "image": None}


async def test_edit_and_delete_broadcast_and_thread_returns_parent_latest(factory, monkeypatch):
    """수정·삭제는 채널 전원에게 알리고, 스레드 응답은 원문과 최신 답글을 준다."""
    events = []

    async def emit(cid, ev):
        events.append((cid, ev))
    monkeypatch.setattr(chat_router, "emit_to_channel", emit)

    async with factory() as db:
        ch = await service.create_channel(db, "dev", "public", "alice", member_ids=["bob"])
        root = await service.create_message(db, ch.id, "alice", "원문")
        replies = [await service.create_message(db, ch.id, "bob", f"답글 {i}", parent_id=root["id"]) for i in range(5)]
        alice = await db.get(User, "alice")
        bob = await db.get(User, "bob")

        from app.chat.schemas import MessageUpdate
        updated = await chat_router.edit_message(message_id=root["id"], body=MessageUpdate(content="고친 원문"), user=alice, db=db)
        kinds = [(c, e["type"]) for c, e in events]
        assert (ch.id, "message_update") in kinds
        ev = next(e for _c, e in events if e["type"] == "message_update")
        assert ev["message"]["id"] == root["id"] and ev["message"]["content"] == "고친 원문" and updated["is_edited"]

        # 스레드: 원문 포함, limit 를 넘으면 최신 것부터(순서는 오래된 → 최신)
        res = await chat_router.get_thread(message_id=root["id"], limit=2, user=alice, db=db)
        assert res["parent"]["id"] == root["id"] and res["parent"]["reply_count"] == 5
        assert [r["id"] for r in res["replies"]] == [replies[3]["id"], replies[4]["id"]]

        events.clear()
        assert await chat_router.delete_message(message_id=replies[4]["id"], user=bob, db=db) == {"ok": True}
        assert events == [(ch.id, {"type": "message_delete", "message_id": replies[4]["id"],
                                   "channel_id": ch.id, "parent_id": root["id"]})]
