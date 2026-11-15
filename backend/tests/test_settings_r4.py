"""설정·보안 — 2단계 끄기(복구 코드) · 비밀번호 규칙 판정 · 채팅 알림 키워드 · 로그인 배경 순서."""

import json
import time

import pyotp
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from starlette.requests import Request

from app.auth import password_policy, security_policy, two_factor
from app.auth import router as auth_router
from app.auth.schemas import TwoFactorDisableRequest
from app.chat import keywords as kw
from app.db.models import Base, Channel, ChannelMember, ChatMention, Notification, User, UserPref
from app.me import prefs as mp
from app.rate_limit import limiter


def _request(path="/api/auth/2fa/disable"):
    return Request({
        "type": "http", "method": "POST", "path": path, "query_string": b"",
        "headers": [(b"user-agent", b"pytest")], "client": ("10.0.0.5", 1234),
        "server": ("test", 80), "scheme": "http",
    })


def _set_policy(**k):
    pol = {**security_policy.DEFAULTS, **k}
    security_policy._cache["p"] = (time.monotonic(), pol)


@pytest.fixture()
async def db(monkeypatch):
    monkeypatch.setattr(limiter, "enabled", False)
    security_policy.invalidate_cache()
    _set_policy()
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        for uid in ("alice", "bob", "carol", "dave"):
            s.add(User(id=uid, username=uid, email=f"{uid}@x.io", password_hash="x", display_name=uid.title()))
        await s.commit()
        yield s
    await engine.dispose()
    security_policy.invalidate_cache()


# ── 2단계 끄기: 인증 앱 코드 또는 복구 코드 ──


@pytest.mark.asyncio
async def test_disable_with_recovery_code(db):
    alice = await db.get(User, "alice")
    alice.totp_secret = pyotp.random_base32()
    codes = two_factor.issue_new_codes(alice)
    await db.commit()
    with pytest.raises(HTTPException):
        await auth_router.disable_2fa(_request(), TwoFactorDisableRequest(code="zzzz-zzzz"), user=alice, db=db)
    assert alice.totp_secret
    await auth_router.disable_2fa(_request(), TwoFactorDisableRequest(code=codes[2].upper()), user=alice, db=db)
    assert alice.totp_secret is None and alice.totp_recovery_codes is None


@pytest.mark.asyncio
async def test_disable_policy_checked_before_consuming_code(db):
    alice = await db.get(User, "alice")
    alice.totp_secret = pyotp.random_base32()
    codes = two_factor.issue_new_codes(alice)
    await db.commit()
    _set_policy(require_2fa="all")
    with pytest.raises(HTTPException) as e:
        await auth_router.disable_2fa(_request(), TwoFactorDisableRequest(code=codes[0]), user=alice, db=db)
    assert e.value.status_code == 400
    assert two_factor.remaining(alice) == 10  # 끌 수 없으면 코드도 안 쓴다


# ── 비밀번호 규칙 판정 ──


@pytest.mark.parametrize("pw,length,common,context", [
    ("short", False, False, False),
    ("password123", True, True, False),
    ("P@ssw0rd!", True, True, False),
    ("aaaaaaaaaa", True, True, False),
    ("12345678", True, True, False),
    ("alice2026", True, False, True),       # 아이디를 빼면 4자
    ("alice@x.io!!", True, False, True),
    ("가을-하늘-연필-바다", True, False, False),
])
def test_password_check_items(pw, length, common, context):
    r = password_policy.check(pw, "alice", "alice@x.io")
    assert (r["length"], r["common"], r["context"]) == (length, common, context)
    assert r["ok"] == (length and not common and not context)
    # validate 와 같은 기준 — ok 면 validate 도 통과
    if r["ok"]:
        password_policy.validate(pw, "alice", "alice@x.io")
    else:
        with pytest.raises(ValueError):
            password_policy.validate(pw, "alice", "alice@x.io")


@pytest.mark.asyncio
async def test_password_check_endpoint(db):
    alice = await db.get(User, "alice")
    r = await auth_router.password_check(_request("/api/auth/password-check"), {"password": "qwerty123"}, user=alice)
    assert r["common"] is True
    with pytest.raises(HTTPException):
        await auth_router.password_check(_request("/api/auth/password-check"), {"password": "x" * 300}, user=alice)
    with pytest.raises(HTTPException):
        await auth_router.password_check(_request("/api/auth/password-check"), {}, user=alice)


# ── 알림 키워드: 설정 저장 규칙 ──


@pytest.mark.asyncio
async def test_keywords_pref_normalized_and_limited(db):
    alice = await db.get(User, "alice")
    r = await mp.patch_prefs({"chat.keywords": [" 배포 ", "장애", "배포", "HOTFIX", "hotfix", ""]}, user=alice, db=db)
    assert r["prefs"]["chat.keywords"] == ["배포", "장애", "HOTFIX"]
    # 나머지 캘린더·채팅 설정은 접두사 규칙으로 그대로
    r = await mp.patch_prefs({"calendar.default_view": "week", "calendar.default_reminder": 10,
                              "chat.enter_key": "newline", "chat.link_preview": False,
                              "chat.media_autoexpand": True}, user=alice, db=db)
    assert r["prefs"]["calendar.default_view"] == "week"
    for bad in (["x"] * 0 + [f"k{i}" for i in range(21)], "배포", [1, 2], ["x" * 41]):
        with pytest.raises(HTTPException) as e:
            await mp.patch_prefs({"chat.keywords": bad}, user=alice, db=db)
        assert e.value.status_code == 400


def test_keyword_hit():
    assert kw.keyword_hit("오늘 배포했습니다", ["장애", "배포"]) == "배포"
    assert kw.keyword_hit("Prod HOTFIX now", ["hotfix"]) == "hotfix"
    assert kw.keyword_hit("아무 일 없음", ["배포"]) is None
    assert kw.keyword_hit("", ["배포"]) is None
    assert kw.keyword_hit("배포", None) is None
    assert kw.keyword_hit("배포", ["  "]) is None


# ── 알림 키워드: 멘션처럼 센다 ──


@pytest.mark.asyncio
async def test_keyword_notifications(db, monkeypatch):
    from app.notifications import service as ns

    async def _no_deliver(*a, **k):
        return None

    monkeypatch.setattr(ns, "_deliver", _no_deliver)
    db.add(Channel(id="ch1", name="개발", type="public", created_by="alice"))
    await db.commit()
    for uid in ("alice", "bob", "carol"):
        db.add(ChannelMember(channel_id="ch1", user_id=uid))
    # dave 는 키워드가 있어도 채널 멤버가 아니다
    db.add(UserPref(user_id="bob", data=json.dumps({"chat.keywords": ["배포"]})))
    db.add(UserPref(user_id="carol", data=json.dumps({"chat.keywords": ["장애"]})))
    db.add(UserPref(user_id="dave", data=json.dumps({"chat.keywords": ["배포"]})))
    db.add(UserPref(user_id="alice", data=json.dumps({"chat.keywords": ["배포"]})))
    await db.commit()

    msg = {"id": "m1", "seq": 1, "content": "오늘 저녁 배포합니다", "channel_id": "ch1"}
    notifs = await kw.create_notifications_for_keywords(db, msg, "ch1", "alice", msg["content"], set())
    assert [n["user_id"] for n in notifs] == ["bob"]          # 보낸 사람·비멤버·안 걸린 사람 제외
    assert notifs[0]["keyword"] == "배포"
    mentions = (await db.execute(select(ChatMention.user_id))).scalars().all()
    assert mentions == ["bob"]
    rows = (await db.execute(select(Notification).where(Notification.user_id == "bob"))).scalars().all()
    assert len(rows) == 1 and rows[0].type == "mention" and "배포" in rows[0].title

    # 이미 멘션으로 알림 받은 사람은 건너뛴다
    msg2 = {"id": "m2", "seq": 2, "content": "배포 장애", "channel_id": "ch1"}
    notifs = await kw.create_notifications_for_keywords(db, msg2, "ch1", "alice", msg2["content"], {"bob"})
    assert [n["user_id"] for n in notifs] == ["carol"]


# ── 로그인 배경: 4장까지 · 끌어서 순서 ──


def test_wallpaper_reorder(tmp_path, monkeypatch):
    from app.admin import router as admin_router

    monkeypatch.setattr(admin_router, "LOGO_DIR", tmp_path)
    for n in ("wallpaper-0-111.jpg", "wallpaper-1-222.png", "wallpaper-2-333.mp4", "logo.png"):
        (tmp_path / n).write_bytes(n.encode())
    assert admin_router._next_wallpaper_index() == 3
    out = admin_router.reorder_wallpapers(["wallpaper-2-333.mp4", "wallpaper-0-111.jpg", "wallpaper-1-222.png"])
    assert out == ["wallpaper-0-333.mp4", "wallpaper-1-111.jpg", "wallpaper-2-222.png"]
    assert (tmp_path / "wallpaper-0-333.mp4").read_bytes() == b"wallpaper-2-333.mp4"   # 내용은 그대로
    assert (tmp_path / "logo.png").exists()
    with pytest.raises(HTTPException):   # 빠진 것·없는 것은 거부
        admin_router.reorder_wallpapers(["wallpaper-0-333.mp4"])
    with pytest.raises(HTTPException):
        admin_router.reorder_wallpapers(["wallpaper-0-333.mp4", "wallpaper-0-333.mp4", "wallpaper-2-222.png"])
