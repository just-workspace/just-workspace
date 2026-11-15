"""메일 구역 감사 수정 — IMAP 결과 확인·메일함 이름 인용·첨부 소모 시점·서명 자리.

고정하는 것
- 복사(COPY)가 NO/BAD 면 원본을 지우지 않는다(이동·삭제). 예전엔 결과를 안 보고 지워 메일이 사라졌다.
- 공백이 든 메일함 이름이 따옴표로 감싸져 나간다(aioimaplib 는 따옴표를 붙여 주지 않는다).
- 지울 때는 그 UID 만(UID EXPUNGE), UIDPLUS 가 없을 때만 전체 EXPUNGE.
- 라우터가 실패를 200 으로 돌려주지 않는다.
- 발송이 실패하면 임시 첨부가 남아 있다(다시 보낼 수 있다).
- 서명은 인용 머리줄·전달 구분선 앞에 들어간다.
"""

import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.db.models import User
from app.mail import imap_client
from app.mail import router as mail_router
from app.mail.schemas import AttachmentRef, BulkActionRequest, EmailAddress, SendMessageRequest


def _r(result="OK", lines=None):
    return SimpleNamespace(result=result, lines=lines or [])


class FakeImap:
    """명령을 적어 두고, 정해 둔 명령만 NO 로 답한다."""

    def __init__(self, fail=(), uidplus=True):
        self.fail = set(fail)
        self.uidplus = uidplus
        self.calls: list[tuple] = []

    def has_capability(self, cap):
        return self.uidplus and cap == "UIDPLUS"

    async def select(self, mailbox):
        self.calls.append(("select", mailbox))
        return _r("NO" if "select" in self.fail else "OK")

    async def uid(self, cmd, *args):
        self.calls.append((cmd, *args))
        return _r("NO" if cmd in self.fail else "OK")

    async def expunge(self):
        self.calls.append(("expunge-all",))
        return _r()

    async def logout(self):
        pass

    def names(self):
        return [c[0] for c in self.calls]


@pytest.fixture()
def fake(monkeypatch):
    box = {}

    def use(imap):
        box["imap"] = imap

        async def _connect(account):
            return imap

        monkeypatch.setattr(imap_client, "_connect", _connect)
        return imap

    return use


# ─── 메일함 이름 인용 ───


def test_quote_mailbox_name():
    assert imap_client._q("INBOX") == '"INBOX"'
    assert imap_client._q("Deleted Items") == '"Deleted Items"'
    assert imap_client._q('a"b\\c') == '"a\\"b\\\\c"'
    for bad in ("", "INBOX\r\nA1 DELETE x", "a\x00b"):
        with pytest.raises(ValueError):
            imap_client._q(bad)


@pytest.mark.asyncio
async def test_move_quotes_names_with_spaces(fake):
    imap = fake(FakeImap())
    assert await imap_client.move_message(SimpleNamespace(), "My Folder", "7", "전체 편지함") is True
    assert imap.calls[0] == ("select", '"My Folder"')
    assert imap.calls[1] == ("copy", "7", '"전체 편지함"')
    # 그 UID 만 지운다
    assert imap.calls[-1] == ("expunge", "7")
    assert "expunge-all" not in imap.names()


# ─── 복사 실패 = 원본 보존 ───


@pytest.mark.asyncio
async def test_move_keeps_original_when_copy_fails(fake):
    imap = fake(FakeImap(fail={"copy"}))
    assert await imap_client.move_message(SimpleNamespace(), "INBOX", "7", "Archive") is False
    assert imap.names() == ["select", "copy"]  # store(\Deleted)·expunge 가 없다


@pytest.mark.asyncio
async def test_move_does_nothing_when_select_fails(fake):
    imap = fake(FakeImap(fail={"select"}))
    assert await imap_client.move_message(SimpleNamespace(), "INBOX", "7", "Archive") is False
    assert imap.names() == ["select"]


@pytest.mark.asyncio
async def test_delete_keeps_original_when_copy_to_trash_fails(fake):
    imap = fake(FakeImap(fail={"copy"}))
    res = await imap_client.delete_message(SimpleNamespace(), "INBOX", "7", "Deleted Items")
    assert res["ok"] is False
    assert imap.calls == [("select", '"INBOX"'), ("copy", "7", '"Deleted Items"')]


@pytest.mark.asyncio
async def test_delete_moves_to_trash_then_expunges_only_that_uid(fake):
    imap = fake(FakeImap())
    res = await imap_client.delete_message(SimpleNamespace(), "INBOX", "7", "Trash")
    assert res == {"ok": True, "permanent": False}
    assert imap.names() == ["select", "copy", "store", "expunge"]
    # 휴지통 안에서 지우면 영구 삭제(복사 없음)
    imap = fake(FakeImap())
    res = await imap_client.delete_message(SimpleNamespace(), "Trash", "7", "Trash")
    assert res == {"ok": True, "permanent": True}
    assert "copy" not in imap.names()


@pytest.mark.asyncio
async def test_expunge_falls_back_without_uidplus(fake):
    imap = fake(FakeImap(uidplus=False))
    assert await imap_client.move_message(SimpleNamespace(), "INBOX", "7", "Archive") is True
    assert imap.names()[-1] == "expunge-all"


@pytest.mark.asyncio
async def test_update_flags_reports_failure(fake):
    fake(FakeImap(fail={"store"}))
    assert await imap_client.update_flags(SimpleNamespace(), "INBOX", "7", add_flags=["\\Seen"]) is False
    fake(FakeImap())
    assert await imap_client.update_flags(SimpleNamespace(), "INBOX", "7", add_flags=["\\Seen"]) is True


# ─── 라우터: 실패를 200 으로 돌려주지 않는다 ───


async def _seed_user(db, uid="u1"):
    u = User(id=uid, username=uid, email=f"{uid}@x.io", password_hash="x", display_name=uid)
    db.add(u)
    await db.commit()
    return u


def _client(monkeypatch, **impl):
    acct = SimpleNamespace(protocol="imap", email="u1@x.io")

    async def _get_account(db, user, account_id=None):
        return acct

    class Client:
        async def list_mailboxes(self, account):
            if impl.get("list_fail"):
                raise ConnectionError("down")
            return [{"id": "Trash", "role": "trash"}, {"id": "Junk", "role": "junk"}]

        async def move_message(self, account, mailbox, uid, target):
            return impl.get("move", True)

        async def delete_message(self, account, mailbox, uid, trash):
            return {"ok": impl.get("delete", True), "permanent": False}

        async def update_flags(self, account, mailbox, uid, add_flags=None, remove_flags=None):
            return impl.get("flags", True)

    monkeypatch.setattr(mail_router, "_get_account", _get_account)
    monkeypatch.setattr(mail_router, "_incoming", lambda a: Client())


@pytest.mark.asyncio
@pytest.mark.parametrize("action,key", [("move", "move"), ("spam", "move"), ("delete", "delete"), ("read", "flags")])
async def test_bulk_fails_when_any_item_fails(db_session, monkeypatch, action, key):
    user = await _seed_user(db_session)
    _client(monkeypatch, **{key: False})
    with pytest.raises(HTTPException) as e:
        await mail_router.bulk_action(
            body=BulkActionRequest(message_ids=["1", "2"], action=action, mailbox_id="Archive"),
            mailbox_id="INBOX", user=user, db=db_session,
        )
    assert e.value.status_code == 500
    _client(monkeypatch)
    res = await mail_router.bulk_action(
        body=BulkActionRequest(message_ids=["1", "2"], action=action, mailbox_id="Archive"),
        mailbox_id="INBOX", user=user, db=db_session,
    )
    assert res == {"ok": True, "count": 2}


@pytest.mark.asyncio
async def test_delete_endpoint_reports_failure(db_session, monkeypatch):
    user = await _seed_user(db_session)
    _client(monkeypatch, delete=False)
    with pytest.raises(HTTPException) as e:
        await mail_router.delete_message(message_uid="1", mailbox_id="INBOX", account_id=None, user=user, db=db_session)
    assert e.value.status_code == 500
    # 메일함 목록을 못 받으면 "휴지통 없음 = 영구 삭제"로 가지 않는다
    _client(monkeypatch, list_fail=True)
    with pytest.raises(HTTPException) as e:
        await mail_router.delete_message(message_uid="1", mailbox_id="INBOX", account_id=None, user=user, db=db_session)
    assert e.value.status_code == 502
    _client(monkeypatch)
    res = await mail_router.delete_message(message_uid="1", mailbox_id="INBOX", account_id=None, user=user, db=db_session)
    assert res["ok"] is True


# ─── 임시 첨부는 발송이 끝난 뒤에 지운다 ───


class FakeRedis:
    def __init__(self):
        self.kv = {}

    async def get(self, k):
        return self.kv.get(k)

    async def delete(self, k):
        self.kv.pop(k, None)


@pytest.mark.asyncio
async def test_attachment_survives_failed_send(db_session, monkeypatch, tmp_path):
    user = await _seed_user(db_session)
    _client(monkeypatch)
    redis = FakeRedis()

    async def get_redis():
        return redis

    import app.chat.redis_client as rc
    monkeypatch.setattr(rc, "get_redis", get_redis)
    monkeypatch.setattr(mail_router, "_ATTACH_DIR", str(tmp_path))
    (tmp_path / "b1").write_bytes(b"data")
    redis.kv["mailatt:b1"] = json.dumps({"name": "a.txt", "type": "text/plain", "size": 4, "user_id": user.id})

    got = []
    state = {"fail": True}

    async def send(db, user, account, payload, atts):
        if state["fail"]:
            raise ConnectionError("smtp down")
        got.append(atts)

    monkeypatch.setattr(mail_router, "perform_send", send)
    body = SendMessageRequest(to=[EmailAddress(email="b@x.io")], subject="s", text_body="hi",
                              attachments=[AttachmentRef(blobId="b1", name="a.txt")])
    with pytest.raises(HTTPException) as e:
        await mail_router.send_message(body=body, user=user, db=db_session)
    assert e.value.status_code == 502
    assert (tmp_path / "b1").is_file() and "mailatt:b1" in redis.kv  # 다시 보낼 수 있다

    state["fail"] = False
    assert (await mail_router.send_message(body=body, user=user, db=db_session))["ok"] is True
    assert got[0][0]["data"] == b"data"
    assert not (tmp_path / "b1").exists() and "mailatt:b1" not in redis.kv  # 보낸 뒤에 정리


# ─── 서명 자리 ───


def test_signature_goes_before_quote_head_and_forward_mark():
    reply = "<p>답장</p><p>2026. 11. 14. 오후 3:00:00, 홍길동:</p><blockquote><p>원문</p></blockquote>"
    html, _ = mail_router._insert_signature(reply, "답장", "S", "S", [])
    assert html.index('class="signature"') < html.index("홍길동:") < html.index("<blockquote")

    fwd = "<p>참고</p><p>---------- Forwarded message ----------</p><p>From: a</p><p>본문</p>"
    html, _ = mail_router._insert_signature(fwd, "참고", "S", "S", [])
    assert html.index("참고") < html.index('class="signature"') < html.index("Forwarded message")

    # 머리줄이 없는 인용은 예전처럼 blockquote 앞, 인용이 없으면 끝
    html, _ = mail_router._insert_signature("<p>x</p><blockquote>q</blockquote>", "x", "S", "S", [])
    assert html.index('class="signature"') < html.index("<blockquote")
    html, _ = mail_router._insert_signature("<p>x</p>", "x", "S", "S", [])
    assert html.endswith("</div>")
