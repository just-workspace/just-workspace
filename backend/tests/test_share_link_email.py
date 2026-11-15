"""공유 링크 이메일로 보내기 — 발송은 가짜(_deliver 바꿔 끼움), 실제 메일은 나가지 않는다.

라우터 함수를 직접 부른다. 저장소 루트는 임시 폴더, DB 는 SQLite.
"""

import os
import sys
import types
from datetime import datetime, timedelta, timezone
from email import message_from_string
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

if os.name == "nt" and "resource" not in sys.modules:
    sys.modules["resource"] = types.ModuleType("resource")

from app.db.models import Base, FileShare, ShareLink, ShareLinkEmail, User  # noqa: E402
from app.files import router as fr  # noqa: E402
from app.files import service as fs  # noqa: E402
from app.files import share_email as se  # noqa: E402
from app.files.schemas import ShareLinkCreate  # noqa: E402


@pytest.fixture()
async def env(tmp_path: Path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(fr.settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(fs, "STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(se.settings, "domain", "corp.test")
    fs._dir_cache.clear()
    sent: list = []

    async def fake_deliver(cfg, msg):
        if msg["To"] == "boom@example.com":
            raise RuntimeError("smtp down")
        sent.append(msg)

    monkeypatch.setattr(se, "_deliver", fake_deliver)

    async with factory() as db:
        for uid in ("alice", "bob", "eve"):
            db.add(User(id=uid, username=uid, email=f"{uid}@corp.test", password_hash="x", display_name=uid.title()))
        await db.commit()
        home = tmp_path / "users" / "alice"
        home.mkdir(parents=True)
        (home / "보고서.txt").write_text("hello")
        users = {u: await db.get(User, u) for u in ("alice", "bob", "eve")}
        yield SimpleNamespace(db=db, u=users, sent=sent)
    await engine.dispose()


async def _link(env, **kw) -> str:
    r = await fr.create_share_link(ShareLinkCreate(path="my/보고서.txt", **kw), user=env.u["alice"], db=env.db)
    return r.id


def _body(msg) -> str:
    parts = [p.get_payload(decode=True).decode("utf-8") for p in msg.walk() if p.get_content_maintype() == "text"]
    return "\n".join(parts)


async def _send(env, link_id, emails, who="alice", **kw):
    return await fr.email_share_link(link_id, fr.ShareLinkEmailRequest(emails=emails, **kw), user=env.u[who], db=env.db)


@pytest.mark.asyncio
async def test_send_internal_and_external(env):
    lid = await _link(env, expires_in="7d")
    r = await _send(env, lid, ["Bob@corp.test", "guest@example.com", "bob@corp.test"], message="검토 부탁해요", tz="Asia/Seoul")
    assert r["sent"] == 2 and r["failed"] == 0          # 대소문자 중복 제거
    by = {x["email"]: x for x in r["results"]}
    assert by["bob@corp.test"]["external"] is False and by["bob@corp.test"]["user_id"] == "bob"
    assert by["guest@example.com"]["external"] is True
    assert len(env.sent) == 2
    m = env.sent[0]
    body = _body(m)
    link = await env.db.get(ShareLink, lid)
    assert f"/api/files/shared/{link.token}" in body
    assert "검토 부탁해요" in body and "Alice" in body and "보고서.txt" in body
    assert "(Asia/Seoul)" in body
    assert m["Reply-To"] == "alice@corp.test"
    # 기록 + 목록의 발송 수
    log = await fr.list_share_link_emails(lid, user=env.u["alice"], db=env.db)
    assert {i["email"] for i in log["items"]} == {"bob@corp.test", "guest@example.com"}
    assert log["limits"]["remaining"] == se.HOURLY_LIMIT - 2
    rows = await fr.list_share_links(user=env.u["alice"], db=env.db)
    assert rows[0].email_count == 2


@pytest.mark.asyncio
async def test_password_never_in_mail(env):
    lid = await _link(env, password="s3cret-pw")
    await _send(env, lid, ["guest@example.com"])
    body = _body(env.sent[0])
    assert "s3cret-pw" not in body
    assert "비밀번호는 보낸 사람이 따로 전달합니다" in body
    link = await env.db.get(ShareLink, lid)
    assert f"/s/{link.token}" in body            # 비밀번호 링크는 손님 화면


@pytest.mark.asyncio
async def test_english_template(env):
    lid = await _link(env, password="pw")
    await _send(env, lid, ["guest@example.com"], locale="en")
    m = env.sent[0]
    assert "shared" in str(m["Subject"]) or "shared" in _body(m)
    assert "password separately" in _body(m)
    assert "No expiry" in _body(m)


@pytest.mark.asyncio
async def test_validation(env):
    lid = await _link(env)
    for emails in (["not-an-email"], [], [f"u{i}@example.com" for i in range(21)]):
        with pytest.raises(HTTPException) as e:
            await _send(env, lid, emails)
        assert e.value.status_code == 400
    assert env.sent == []
    with pytest.raises(HTTPException) as e:
        await _send(env, lid, ["a@example.com"], message="x" * (se.MESSAGE_MAX + 1))
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_hourly_limit(env):
    lid = await _link(env)
    for i in range(se.HOURLY_LIMIT - 1):
        env.db.add(ShareLinkEmail(link_id=lid, sent_by="alice", recipient=f"x{i}@example.com", ok=True))
    # 한 시간 전 기록은 세지 않는다
    env.db.add(ShareLinkEmail(link_id=lid, sent_by="alice", recipient="old@example.com", ok=True,
                              created_at=datetime.now(timezone.utc) - timedelta(hours=2)))
    await env.db.commit()
    with pytest.raises(HTTPException) as e:
        await _send(env, lid, ["a@example.com", "b@example.com"])
    assert e.value.status_code == 429
    r = await _send(env, lid, ["a@example.com"])
    assert r["sent"] == 1 and r["limits"]["remaining"] == 0


@pytest.mark.asyncio
async def test_permission_owner_or_editor(env):
    lid = await _link(env)
    with pytest.raises(HTTPException) as e:
        await _send(env, lid, ["a@example.com"], who="eve")
    assert e.value.status_code == 404
    # 보기 권한 → 안 됨, 편집 권한 → 됨
    share = FileShare(owner_id="alice", file_path="my/보고서.txt", shared_with_user_id="bob", role="view", created_by="alice")
    env.db.add(share)
    await env.db.commit()
    with pytest.raises(HTTPException) as e:
        await _send(env, lid, ["a@example.com"], who="bob")
    assert e.value.status_code == 404
    share.role, share.can_write = "edit", True
    await env.db.commit()
    r = await _send(env, lid, ["a@example.com"], who="bob")
    assert r["sent"] == 1
    log = await fr.list_share_link_emails(lid, user=env.u["bob"], db=env.db)
    assert log["items"][0]["sent_by_name"] == "Bob"


@pytest.mark.asyncio
async def test_partial_failure_recorded(env):
    lid = await _link(env)
    r = await _send(env, lid, ["boom@example.com", "ok@example.com"])
    assert r["sent"] == 1 and r["failed"] == 1 and r["ok"] is False
    rows = (await env.db.execute(select(ShareLinkEmail).where(ShareLinkEmail.link_id == lid))).scalars().all()
    assert {x.recipient: x.ok for x in rows} == {"boom@example.com": False, "ok@example.com": True}
    assert (await fr.list_share_links(user=env.u["alice"], db=env.db))[0].email_count == 1


@pytest.mark.asyncio
async def test_expired_or_used_link_refused(env):
    lid = await _link(env, one_time=True)
    link = await env.db.get(ShareLink, lid)
    link.download_count = 1
    await env.db.commit()
    with pytest.raises(HTTPException) as e:
        await _send(env, lid, ["a@example.com"])
    assert e.value.status_code == 400
    link.download_count, link.max_downloads = 0, None
    link.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await env.db.commit()
    with pytest.raises(HTTPException) as e:
        await _send(env, lid, ["a@example.com"])
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_delete_link_clears_log(env):
    lid = await _link(env)
    await _send(env, lid, ["a@example.com"])
    await fr.delete_share_link(lid, user=env.u["alice"], db=env.db)
    left = (await env.db.execute(select(ShareLinkEmail))).scalars().all()
    assert left == []


def test_header_injection_safe():
    u = SimpleNamespace(display_name="Mal\r\nBcc: x@evil.test", username="m", email="m@corp.test")
    link = SimpleNamespace(display_name="a\nb.txt", token="t", can_edit=False, password_hash=None,
                           allow_download=True, expires_at=None, max_downloads=None)
    parts = se.render(link, u, message=None, lang="ko", tz=None)
    msg = se.build_message(parts, from_addr="noreply@corp.test", to="a@example.com", sender=u)
    raw = msg.as_string()
    parsed = message_from_string(raw)
    assert parsed["Bcc"] is None
    assert "\n" not in parts.subject


def test_normalize_recipients():
    good, bad = se.normalize_recipients([" A@Example.com ", "a@example.com", "bad@", "", "x@y.z"])
    assert good == ["a@example.com", "x@y.z"] and bad == ["bad@"]
