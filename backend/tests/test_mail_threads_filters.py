"""메일 스레드·서버 필터·라벨·첨부 zip·예약 발송·서명 중복 방지.

IMAP/SMTP/Redis 는 모의 객체로 대체한다. 검증 대상은
- 스레드 id 계산(헤더/서버 THREAD)과 스레드 조회
- 목록 필터가 IMAP SEARCH 조건·POP3 인덱스 필터로 변환되는지(POP3 회귀 없음)
- 라벨 ↔ IMAP 키워드
- 예약 발송 대기열·발송 루프(이중 발송 방지)·권한
- 서명 이중 부착 정리
"""

import email
import io
import json
import zipfile
from datetime import datetime, timedelta, timezone
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.db.models import MailDraft, MailScheduledSend, MailSignature, User
from app.mail import imap_client, pop3_client, threads
from app.mail import router as mail_router
from app.mail import scheduled
from app.mail.schemas import DraftSave, EmailAddress, MessageUpdateRequest, SendMessageRequest


# ─── 스레드 id ───


def test_header_thread_id_same_for_whole_conversation():
    root = threads.header_thread_id("<a@x>", None, None)
    reply = threads.header_thread_id("<b@x>", "<a@x>", "<a@x>")
    reply2 = threads.header_thread_id("<c@x>", "<b@x>", "<a@x> <b@x>")
    only_irt = threads.header_thread_id("<d@x>", "<a@x>", None)
    assert root and root == reply == reply2 == only_irt
    assert threads.header_thread_id("<z@x>", None, None) != root
    assert threads.header_thread_id(None, None, None) is None


def test_parse_thread_response():
    g = threads.parse_thread_response("THREAD (1 2)(3 (4)(5 6))(7)")
    assert g == [["1", "2"], ["3", "4", "5", "6"], ["7"]]
    m = threads.thread_map(g)
    assert m["6"] == ("u3", 4) and m["7"] == ("u7", 1)


def test_keyword_roundtrip_korean():
    for label in ("중요", "Project X", "견적&계약", "work"):
        kw = threads.encode_keyword(label)
        assert kw.isascii() and " " not in kw and "(" not in kw
        assert threads.decode_keyword(kw) == label
    assert threads.flags_to_labels("\\Seen $MDNSent " + threads.encode_keyword("중요")) == ["중요"]


def test_search_criteria():
    assert imap_client.build_search_criteria() == "ALL"
    assert imap_client.build_search_criteria(unread=True) == "UNSEEN"
    c = imap_client.build_search_criteria(query='a"b', unread=False, flagged=True, has_attachment=True, label="중요")
    assert c.startswith("(") and "SEEN" in c and "FLAGGED" in c and "multipart/mixed" in c
    assert "KEYWORD " + threads.encode_keyword("중요") in c
    assert '"' not in c.split("SUBJECT ")[1].split(" FROM")[0].strip('"')


def _hdr(uid, flags, msgid, irt=None, refs=None, ctype="text/plain", subject="s"):
    meta = f"{uid} FETCH (UID {uid} FLAGS ({flags}) BODY[HEADER] {{100}}".encode()
    lines = [f"Message-ID: {msgid}", f"Subject: {subject}", "From: A <a@x.io>", "To: b@x.io",
             "Date: Thu, 15 Oct 2026 01:00:00 +0000", f"Content-Type: {ctype}"]
    if irt:
        lines.append(f"In-Reply-To: {irt}")
    if refs:
        lines.append(f"References: {refs}")
    return [meta, bytearray("\r\n".join(lines).encode() + b"\r\n\r\n"), b")"]


def test_parse_header_fetch_threads_and_attachment():
    lines = _hdr(10, "\\Seen", "<a@x>") + _hdr(11, "", "<b@x>", "<a@x>", "<a@x>", ctype="multipart/mixed; boundary=x")
    out = imap_client._parse_header_fetch(lines, "INBOX")
    assert [m["id"] for m in out] == ["10", "11"]
    assert out[0]["thread_id"] == out[1]["thread_id"]
    assert out[0]["is_unread"] is False and out[1]["is_unread"] is True
    assert out[1]["has_attachment"] is True and out[0]["has_attachment"] is False


class FakeImap:
    """aioimaplib 모사 — select/uid fetch/uid_search/THREAD."""

    def __init__(self, thread_capable: bool):
        self.thread_capable = thread_capable
        self.store = {
            "INBOX": {"1": ("<a@x>", None, None), "2": ("<b@x>", "<a@x>", "<a@x>"), "3": ("<z@x>", None, None)},
            "Sent": {"7": ("<s@x>", "<b@x>", "<a@x> <b@x>")},
        }
        self.cur = "INBOX"
        self.searches = []
        self.protocol = SimpleNamespace(new_tag=lambda: "T1", loop=None, execute=self._exec)

    def has_capability(self, cap):
        return self.thread_capable and cap == "THREAD=REFERENCES"

    async def _exec(self, cmd):
        return SimpleNamespace(result="OK", lines=[b"THREAD (1 2)(3)"])

    async def select(self, mb):
        self.cur = mb.strip('"')  # 메일함 이름은 따옴표로 감싸져 전달됨
        return SimpleNamespace(result="OK", lines=[])

    async def uid(self, cmd, uids, what):
        lines = []
        for u in uids.split(","):
            h = self.store[self.cur].get(u)
            if h:
                lines += _hdr(u, "\\Seen", h[0], h[1], h[2])
        return SimpleNamespace(result="OK", lines=lines)

    async def uid_search(self, crit):
        self.searches.append((self.cur, crit))
        root = crit.split('"')[1]
        hits = [u for u, (mid, irt, refs) in self.store[self.cur].items()
                if root in (mid, irt) or (refs and root in refs)]
        return SimpleNamespace(result="OK", lines=[" ".join(hits).encode()])

    async def logout(self):
        pass


@pytest.mark.asyncio
@pytest.mark.parametrize("capable", [True, False])
async def test_fetch_thread(monkeypatch, capable):
    fake = FakeImap(capable)

    async def _connect(account):
        return fake

    monkeypatch.setattr(imap_client, "_connect", _connect)
    res = await imap_client.fetch_thread(SimpleNamespace(), "INBOX", "2", ["Sent"])
    ids = [(m["mailbox_ids"][0], m["id"]) for m in res["messages"]]
    assert ("INBOX", "1") in ids and ("INBOX", "2") in ids and ("Sent", "7") in ids
    assert ("INBOX", "3") not in ids
    assert res["thread_id"] == ("u1" if capable else threads.header_thread_id("<a@x>", None, None))
    assert all(m["thread_id"] == res["thread_id"] for m in res["messages"])


# ─── 라우터: 필터 전달 · POP3 회귀 ───


async def _seed_user(db, uid="u1"):
    u = User(id=uid, username=uid, email=f"{uid}@x.io", password_hash="x", display_name=uid)
    db.add(u)
    await db.commit()
    return u


@pytest.mark.asyncio
async def test_list_messages_passes_filters(db_session, monkeypatch):
    user = await _seed_user(db_session)
    seen = {}

    class Client:
        async def fetch_messages(self, account, mailbox, page, limit, query=None, **kw):
            seen.update(kw, query=query)
            return [{"id": "5", "thread_id": "u5", "thread_count": 3, "labels": ["중요"],
                     "from_": [], "to": [], "has_attachment": True}], 1

    acct = SimpleNamespace(protocol="imap")

    async def _get_account(db, user, account_id=None):
        return acct

    monkeypatch.setattr(mail_router, "_get_account", _get_account)
    monkeypatch.setattr(mail_router, "_incoming", lambda a: Client())
    res = await mail_router.list_messages(
        mailbox_id="INBOX", page=0, limit=50, q=None, account_id=None,
        unread=True, flagged=None, has_attachment=True, label="중요", user=user, db=db_session,
    )
    assert seen == {"unread": True, "has_attachment": True, "label": "중요", "query": None}
    m = res.messages[0]
    assert m.thread_id == "u5" and m.thread_count == 3 and m.labels == ["중요"]

    # 필터 미지정 시 기존과 동일하게 호출(추가 인자 없음)
    seen.clear()
    await mail_router.list_messages(
        mailbox_id="INBOX", page=0, limit=50, q="x", account_id=None,
        unread=None, flagged=None, has_attachment=None, label=None, user=user, db=db_session,
    )
    assert seen == {"query": "x"}


@pytest.mark.asyncio
async def test_pop3_filters_and_thread(monkeypatch):
    index = [
        {"uidl": "A", "num": 3, "subject": "re: hi", "from": [{"email": "a@x"}], "date": "2026-10-03",
         "msgid": "<b@x>", "irt": "<a@x>", "refs": "<a@x>", "ctype": "multipart/mixed; b=1"},
        {"uidl": "B", "num": 2, "subject": "other", "from": [{"email": "c@x"}], "date": "2026-10-02",
         "msgid": "<z@x>", "ctype": "text/plain"},
        # 이전 캐시(스레드 필드 없음)
        {"uidl": "C", "num": 1, "subject": "hi", "from": [{"email": "a@x"}], "date": "2026-10-01"},
    ]

    async def _build_index(account):
        return list(index)

    async def _state(account_id):
        return {"B"}, {"A"}          # (읽은 항목, 별표 항목)

    monkeypatch.setattr(pop3_client, "_build_index", _build_index)
    monkeypatch.setattr(pop3_client, "_state", _state)
    acct = SimpleNamespace(id="acc")

    out, total = await pop3_client.fetch_messages(acct, "INBOX")
    assert total == 3 and out[2]["thread_id"] is None  # 이전 캐시도 정상 처리
    out, total = await pop3_client.fetch_messages(acct, "INBOX", unread=True)
    assert [m["id"] for m in out] == ["A", "C"]
    out, _ = await pop3_client.fetch_messages(acct, "INBOX", flagged=True)
    assert [m["id"] for m in out] == ["A"]
    out, _ = await pop3_client.fetch_messages(acct, "INBOX", has_attachment=True)
    assert [m["id"] for m in out] == ["A"] and out[0]["has_attachment"]

    t = await pop3_client.fetch_thread(acct, "INBOX", "A")
    assert [m["id"] for m in t["messages"]] == ["A"]
    assert t["thread_id"] == threads.header_thread_id("<a@x>", None, None)


@pytest.mark.asyncio
async def test_pop3_labels_rejected(db_session, monkeypatch):
    user = await _seed_user(db_session)

    async def _get_account(db, user, account_id=None):
        return SimpleNamespace(protocol="pop3")

    monkeypatch.setattr(mail_router, "_get_account", _get_account)
    with pytest.raises(HTTPException) as e:
        await mail_router.update_message(
            message_uid="A", body=MessageUpdateRequest(add_labels=["중요"]),
            mailbox_id="INBOX", account_id=None, user=user, db=db_session,
        )
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_labels_become_keywords(db_session, monkeypatch):
    user = await _seed_user(db_session)
    calls = {}

    class Client:
        async def update_flags(self, account, mailbox, uid, add_flags=None, remove_flags=None):
            calls.update(add=add_flags, remove=remove_flags)
            return True

    async def _get_account(db, user, account_id=None):
        return SimpleNamespace(protocol="imap")

    monkeypatch.setattr(mail_router, "_get_account", _get_account)
    monkeypatch.setattr(mail_router, "_incoming", lambda a: Client())
    await mail_router.update_message(
        message_uid="5", body=MessageUpdateRequest(add_labels=["중요"], remove_labels=["todo"], is_flagged=True),
        mailbox_id="INBOX", account_id=None, user=user, db=db_session,
    )
    assert calls["add"] == ["\\Flagged", threads.encode_keyword("중요")]
    assert calls["remove"] == ["todo"]


# ─── 첨부 zip ───


@pytest.mark.asyncio
async def test_attachments_zip(db_session, monkeypatch):
    user = await _seed_user(db_session)
    m = MIMEMultipart("mixed")
    m["Subject"] = "견적서"
    m.attach(MIMEText("본문", "plain", "utf-8"))
    for name, data in (("a.pdf", b"%PDF-1"), ("a.pdf", b"%PDF-2"), ("표.xlsx", b"PK")):
        part = MIMEApplication(data)
        part.add_header("Content-Disposition", "attachment", filename=name)
        m.attach(part)
    raw = m.as_bytes()

    class Client:
        async def fetch_raw_many(self, account, mailbox, uids):
            return {"9": raw} if uids == ["9"] else {}

    async def _get_account(db, user, account_id=None):
        return SimpleNamespace(protocol="imap")

    monkeypatch.setattr(mail_router, "_get_account", _get_account)
    monkeypatch.setattr(mail_router, "_incoming", lambda a: Client())
    resp = await mail_router.download_all_attachments(
        message_uid="9", mailbox_id="INBOX", account_id=None, user=user, db=db_session,
    )
    z = zipfile.ZipFile(io.BytesIO(resp.body))
    assert sorted(z.namelist()) == ["a (1).pdf", "a.pdf", "표.xlsx"]
    assert z.read("a (1).pdf") == b"%PDF-2"
    with pytest.raises(HTTPException) as e:
        await mail_router.download_all_attachments(
            message_uid="404", mailbox_id="INBOX", account_id=None, user=user, db=db_session,
        )
    assert e.value.status_code == 404


# ─── 서명 이중 부착 ───


def test_signature_dedupe_html_and_text():
    sig = '<div class="signature"><p>--</p><div><b>홍길동</b></div></div>'
    html = "<p>본문</p>" + sig + sig + "<blockquote>인용</blockquote>"
    out = threads.dedupe_signature_html(html)
    assert out.count('class="signature"') == 1 and "<blockquote>" in out
    assert threads.strip_signature_html(html) == "<p>본문</p><blockquote>인용</blockquote>"

    text = "본문\n\n--\n홍길동\n\n--\n홍길동\n\n> 인용"
    out = threads.dedupe_signature_text(text, ["홍길동"])
    assert out.count("--\n홍길동") == 1 and out.endswith("> 인용")


def test_insert_signature_single_and_before_quote():
    html, text = mail_router._insert_signature(
        '<p>안녕</p><div class="signature"><p>--</p>옛 서명</div><blockquote>q</blockquote>',
        "안녕\n\n--\n옛 서명", "<b>새 서명</b>", "새 서명", ["옛 서명"],
    )
    assert html.count('class="signature"') == 1 and "옛 서명" not in html
    assert html.index("새 서명") < html.index("<blockquote>")
    assert text == "안녕\n\n--\n새 서명"
    html, _ = mail_router._insert_signature("<p>x</p><blockquote>q</blockquote>", "x", "S", "S", [])
    assert html == '<p>x</p><div class="signature"><p>--</p>S</div><blockquote>q</blockquote>'


@pytest.mark.asyncio
async def test_draft_response_has_clean_body(db_session):
    user = await _seed_user(db_session)
    db_session.add(MailSignature(user_id=user.id, name="기본", html_content="<p>홍길동</p>"))
    await db_session.commit()
    res = await mail_router.save_draft(
        body=DraftSave(subject="s", body_html='<p>hi</p><div class="signature"><p>--</p><p>홍길동</p></div>',
                       body_text="hi\n\n--\n홍길동", signature_id="sig-1"),
        user=user, db=db_session,
    )
    assert res.has_signature is True and res.signature_id == "sig-1"
    assert res.body_html_without_signature == "<p>hi</p>"
    assert res.body_text_without_signature == "hi"
    other = await _seed_user(db_session, "u2")
    with pytest.raises(HTTPException):
        await mail_router.get_draft(draft_id=res.id, user=other, db=db_session)


# ─── 예약 발송 ───


@pytest.fixture()
def mail_env(monkeypatch, tmp_path):
    monkeypatch.setattr(scheduled, "_dir", lambda sid: tmp_path / sid)
    acct = SimpleNamespace(protocol="imap", email="u1@x.io")

    async def _get_account(db, user, account_id=None):
        return acct

    monkeypatch.setattr(mail_router, "_get_account", _get_account)
    sent = []

    async def fake_send(db, user, account, payload, atts):
        sent.append((user.id, payload, atts))

    monkeypatch.setattr(mail_router, "perform_send", fake_send)
    return sent


@pytest.mark.asyncio
async def test_schedule_send_and_loop(db_session, mail_env):
    user = await _seed_user(db_session)
    at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    res = await mail_router.send_message(
        body=SendMessageRequest(to=[EmailAddress(email="b@x.io")], subject="예약", text_body="hi", send_at=at),
        user=user, db=db_session,
    )
    assert res["scheduled"] is True and mail_env == []

    lst = await mail_router.list_scheduled(include_done=False, user=user, db=db_session)
    assert [r.subject for r in lst] == ["예약"] and lst[0].status == "pending"

    # 예약 시각 전에는 발송하지 않음
    assert await scheduled.send_due(db_session) == 0
    # 예약 시각 경과 후 1회만 발송(2회 실행해도 동일)
    later = datetime.now(timezone.utc) + timedelta(hours=2)
    assert await scheduled.send_due(db_session, now=later) == 1
    assert await scheduled.send_due(db_session, now=later) == 0
    assert len(mail_env) == 1 and mail_env[0][1]["subject"] == "예약"
    row = await db_session.get(MailScheduledSend, res["id"])
    assert row.status == "sent" and row.sent_at

    # 발송 완료 건은 취소 불가
    with pytest.raises(HTTPException) as e:
        await mail_router.cancel_scheduled(scheduled_id=res["id"], user=user, db=db_session)
    assert e.value.status_code == 409


@pytest.mark.asyncio
async def test_schedule_cancel_permissions(db_session, mail_env):
    user = await _seed_user(db_session)
    other = await _seed_user(db_session, "u2")
    at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    res = await mail_router.send_message(
        body=SendMessageRequest(to=[EmailAddress(email="b@x.io")], subject="예약", text_body="hi", send_at=at),
        user=user, db=db_session,
    )
    with pytest.raises(HTTPException) as e:
        await mail_router.cancel_scheduled(scheduled_id=res["id"], user=other, db=db_session)
    assert e.value.status_code == 404
    assert await mail_router.list_scheduled(include_done=True, user=other, db=db_session) == []
    assert (await mail_router.cancel_scheduled(scheduled_id=res["id"], user=user, db=db_session))["ok"]
    later = datetime.now(timezone.utc) + timedelta(hours=2)
    assert await scheduled.send_due(db_session, now=later) == 0
    assert mail_env == []


@pytest.mark.asyncio
async def test_schedule_failure_retries_then_fails(db_session, mail_env, monkeypatch):
    user = await _seed_user(db_session)

    async def boom(db, user, account, payload, atts):
        raise ConnectionError("smtp down")

    monkeypatch.setattr(mail_router, "perform_send", boom)
    row = await scheduled.enqueue(db_session, user, None, {"from_name": "u", "to": [{"email": "b@x.io"}]},
                                  [{"data": b"abc", "name": "a.txt", "type": "text/plain"}],
                                  datetime.now(timezone.utc) - timedelta(minutes=1))
    for _ in range(3):
        await scheduled.send_due(db_session)
    await db_session.refresh(row)
    assert row.status == "failed" and "smtp down" in row.error and row.attempts == 3


@pytest.mark.asyncio
async def test_send_now_dedupes_signature(db_session, mail_env):
    user = await _seed_user(db_session)
    sig = '<div class="signature"><p>--</p>S</div>'
    await mail_router.send_message(
        body=SendMessageRequest(to=[EmailAddress(email="b@x.io")], subject="s",
                                text_body="hi", html_body="<p>hi</p>" + sig + sig),
        user=user, db=db_session,
    )
    payload = mail_env[0][1]
    assert payload["html_body"].count('class="signature"') == 1


@pytest.mark.asyncio
async def test_reply_headers_resolved_from_uid(monkeypatch):
    class Client:
        async def fetch_raw_headers(self, account, mailbox, uid):
            assert mailbox == "INBOX" and uid == "42"
            return "Message-ID: <orig@x>\r\nReferences: <root@x>\r\n\r\n"

    monkeypatch.setattr(mail_router, "_incoming", lambda a: Client())
    irt, refs = await mail_router._resolve_reply_headers(SimpleNamespace(), "42", [], None)
    assert irt == "<orig@x>" and refs == ["<root@x>", "<orig@x>"]
    irt, refs = await mail_router._resolve_reply_headers(SimpleNamespace(), "<m@x>", ["<r@x>"], None)
    assert irt == "<m@x>" and refs == ["<r@x>"]
