"""POP3 계정 — 서버 폴더가 필요한 동작(이동·스팸·폴더 관리·필터 적용)은 500 이 아니라 400(이유 문구)으로 거절하고,
POP3 가 로컬 상태로 지원하는 동작(읽음·별표·삭제)은 그대로 된다.

IMAP/POP3 서버는 부르지 않는다(_get_account·_incoming 을 가짜로 바꾼다).
"""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.db.models import User
from app.mail import pop3_client
from app.mail import router as mail_router
from app.mail.schemas import BulkActionRequest, MailboxCreateRequest, MailboxRenameRequest, MessageUpdateRequest


async def _seed_user(db, uid="u1"):
    u = User(id=uid, username=uid, email=f"{uid}@x.io", password_hash="x", display_name=uid)
    db.add(u)
    await db.commit()
    return u


class _Spy:
    """pop3_client 자리에 서서 무엇이 불렸는지 적는다 — 폴더 동작은 불리면 안 된다."""

    def __init__(self):
        self.calls: list[str] = []

    async def list_mailboxes(self, account):
        return await pop3_client.list_mailboxes(account)

    async def update_flags(self, account, mailbox, uid, add_flags=None, remove_flags=None):
        self.calls.append(f"flags:{uid}:{add_flags}:{remove_flags}")
        return True

    async def delete_message(self, account, mailbox, uid, trash_mailbox=None):
        self.calls.append(f"delete:{uid}:{trash_mailbox}")
        return {"ok": True, "permanent": True}

    async def fetch_messages(self, *a, **kw):
        self.calls.append("fetch")
        return [], 0

    def __getattr__(self, name):  # create_mailbox · rename_mailbox · delete_mailbox · move_message
        async def _f(*a, **kw):
            self.calls.append(name)
            return False
        return _f


@pytest.fixture()
def pop3(monkeypatch):
    spy = _Spy()

    async def _get_account(db, user, account_id=None):
        return SimpleNamespace(id="acc", protocol="pop3")

    monkeypatch.setattr(mail_router, "_get_account", _get_account)
    monkeypatch.setattr(mail_router, "_incoming", lambda a: spy)
    return spy


def _is_pop3_400(e) -> bool:
    return e.value.status_code == 400 and "POP3" in e.value.detail and e.value.detail == mail_router.POP3_NO_FOLDERS


@pytest.mark.asyncio
async def test_pop3_folder_management_is_400(db_session, pop3):
    user = await _seed_user(db_session)
    with pytest.raises(HTTPException) as e:
        await mail_router.create_mailbox(body=MailboxCreateRequest(name="프로젝트"), account_id=None, user=user, db=db_session)
    assert _is_pop3_400(e)
    with pytest.raises(HTTPException) as e:
        await mail_router.rename_mailbox(body=MailboxRenameRequest(old_name="a", new_name="b"), account_id=None, user=user, db=db_session)
    assert _is_pop3_400(e)
    with pytest.raises(HTTPException) as e:
        await mail_router.delete_mailbox(mailbox_name="a", account_id=None, user=user, db=db_session)
    assert _is_pop3_400(e)
    assert pop3.calls == []  # 서버 쪽 함수는 부르지도 않는다


@pytest.mark.asyncio
async def test_pop3_move_is_400_and_does_not_half_apply(db_session, pop3):
    user = await _seed_user(db_session)
    # 읽음 + 이동이 같이 온 요청 — 이동을 못 하므로 읽음도 바꾸지 않는다
    with pytest.raises(HTTPException) as e:
        await mail_router.update_message(
            message_uid="A", body=MessageUpdateRequest(is_unread=False, mailbox_ids=["Archive"]),
            mailbox_id="INBOX", account_id=None, user=user, db=db_session,
        )
    assert _is_pop3_400(e) and pop3.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("action,target", [("spam", None), ("move", "Archive")])
async def test_pop3_bulk_spam_move_is_400(db_session, pop3, action, target):
    user = await _seed_user(db_session)
    with pytest.raises(HTTPException) as e:
        await mail_router.bulk_action(
            body=BulkActionRequest(message_ids=["A", "B"], action=action, mailbox_id=target),
            mailbox_id="INBOX", user=user, db=db_session,
        )
    assert _is_pop3_400(e) and pop3.calls == []


@pytest.mark.asyncio
async def test_pop3_filter_apply_is_400(db_session, pop3):
    user = await _seed_user(db_session)
    with pytest.raises(HTTPException) as e:
        await mail_router.apply_filter_rules(account_id=None, mailbox_id="INBOX", user=user, db=db_session)
    assert _is_pop3_400(e) and pop3.calls == []


@pytest.mark.asyncio
async def test_pop3_supported_actions_still_work(db_session, pop3):
    """읽음·별표·삭제는 POP3 도 된다(읽음·별표는 로컬 상태, 삭제는 서버 DELE) — 막지 않는다."""
    user = await _seed_user(db_session)
    r = await mail_router.update_message(
        message_uid="A", body=MessageUpdateRequest(is_unread=False, is_flagged=True),
        mailbox_id="INBOX", account_id=None, user=user, db=db_session,
    )
    assert r == {"ok": True}
    # 같은 편지함을 가리키는 mailbox_ids 는 이동이 아니다
    r = await mail_router.update_message(
        message_uid="A", body=MessageUpdateRequest(is_unread=True, mailbox_ids=["INBOX"]),
        mailbox_id="INBOX", account_id=None, user=user, db=db_session,
    )
    assert r == {"ok": True}
    for action in ("read", "unread", "star", "unstar", "delete"):
        r = await mail_router.bulk_action(
            body=BulkActionRequest(message_ids=["A"], action=action), mailbox_id="INBOX", user=user, db=db_session,
        )
        assert r == {"ok": True, "count": 1}, action
    r = await mail_router.delete_message(message_uid="B", mailbox_id="INBOX", account_id=None, user=user, db=db_session)
    assert r["ok"] and r["permanent"]
    assert "delete:A:None" in pop3.calls and "delete:B:None" in pop3.calls
    assert not any(c in ("move_message", "create_mailbox", "rename_mailbox", "delete_mailbox") for c in pop3.calls)


@pytest.mark.asyncio
async def test_imap_folder_ops_unaffected(db_session, monkeypatch):
    """IMAP 계정은 그대로 — 가드가 프로토콜만 본다."""
    user = await _seed_user(db_session)
    spy = _Spy()

    async def _move(account, mailbox, uid, dest):
        spy.calls.append(f"move:{uid}:{dest}")
        return True

    async def _create(account, name):
        spy.calls.append(f"create:{name}")
        return True

    spy.move_message = _move
    spy.create_mailbox = _create

    async def _get_account(db, user, account_id=None):
        return SimpleNamespace(id="acc", protocol="imap")

    monkeypatch.setattr(mail_router, "_get_account", _get_account)
    monkeypatch.setattr(mail_router, "_incoming", lambda a: spy)
    r = await mail_router.update_message(
        message_uid="7", body=MessageUpdateRequest(mailbox_ids=["Archive"]),
        mailbox_id="INBOX", account_id=None, user=user, db=db_session,
    )
    assert r == {"ok": True}
    r = await mail_router.bulk_action(
        body=BulkActionRequest(message_ids=["8"], action="move", mailbox_id="Archive"), mailbox_id="INBOX", user=user, db=db_session,
    )
    assert r["ok"]
    r = await mail_router.create_mailbox(body=MailboxCreateRequest(name="프로젝트"), account_id=None, user=user, db=db_session)
    assert r["ok"]
    assert spy.calls == ["move:7:Archive", "move:8:Archive", "create:프로젝트"]


def test_account_response_carries_protocol():
    """화면이 POP3 를 알아보는 근거 — 계정 목록 응답에 protocol 이 실린다(옛 행은 imap)."""
    base = dict(id="a1", display_name="d", email="a@x", imap_host="h", imap_port=110, imap_security="ssl",
                smtp_host="s", smtp_port=465, smtp_security="ssl", username="u", is_default=True,
                archive_enabled=False, last_sync_at=None, sync_error=None)
    assert mail_router._account_response(SimpleNamespace(**base, protocol="pop3"))["protocol"] == "pop3"
    assert mail_router._account_response(SimpleNamespace(**base, protocol=None))["protocol"] == "imap"
