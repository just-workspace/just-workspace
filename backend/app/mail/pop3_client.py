"""POP3 수신 클라이언트 — imap_client 와 동일한 인터페이스이며, 라우터가 protocol 로 분기해 호출.

POP3 는 서버측 폴더/플래그/검색이 없다:
- 메일함은 INBOX 하나뿐(list_mailboxes).
- 읽음/별표는 서버에 없으므로 DB(mail_pop3_state)에 UIDL 기준으로 저장.
- 메시지 식별자(uid)는 POP3 UIDL(세션 무관 안정적)을 사용한다.
- poplib 은 동기 API 이므로 asyncio.to_thread 로 래핑한다.
발신은 본 모듈과 무관 — POP3 계정도 SMTP(smtp_client)로 동일하게 발신한다.
"""
from __future__ import annotations

import asyncio
import email
import json
import logging
import poplib
import ssl

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError

from app.chat.redis_client import get_redis
from app.db.models import MailAccount, MailPop3State
from app.db.session import async_session
from app.mail import imap_client as _ic  # 파싱 헬퍼 재사용
from app.mail import threads

logger = logging.getLogger(__name__)
from app.mail import access_guard
from app.mail.crypto import decrypt_password

_TIMEOUT = 30


def _connect_sync(account: MailAccount):
    # 외부 계정은 내부망 접속 금지(등록 후 DNS 가 변경되어도 접속 직전마다 확인).
    access_guard.ensure_account_hosts_sync(account)
    host = account.imap_host
    sec = account.imap_security or "ssl"
    port = account.imap_port or (995 if sec == "ssl" else 110)
    if sec == "ssl":
        pop = poplib.POP3_SSL(host, port, timeout=_TIMEOUT, context=ssl.create_default_context())
    else:
        pop = poplib.POP3(host, port, timeout=_TIMEOUT)
        if sec == "starttls":
            pop.stls(context=ssl.create_default_context())
    pop.user(account.username)
    pop.pass_(decrypt_password(account.password_encrypted))
    return pop


def _uidl_list(pop) -> list[tuple[int, str]]:
    """[(msg_number, uidl), ...] — 오름차순(번호 큰 쪽이 최신)."""
    out: list[tuple[int, str]] = []
    for ln in pop.uidl()[1]:
        parts = ln.decode("ascii", "replace").split(None, 1)
        if len(parts) == 2:
            out.append((int(parts[0]), parts[1].strip()))
    return out


def _read_key(aid: str) -> str:
    return f"mail:pop3:read:{aid}"


def _flag_key(aid: str) -> str:
    return f"mail:pop3:flag:{aid}"


# ── 읽음·별표 ──
# DB(mail_pop3_state)에 저장한다. 이전에는 Redis 의 집합 두 개(`mail:pop3:read:<계정>`, `…:flag:<계정>`)에만
# 저장되어 백업에 포함되지 않았고, 복원 시 POP3 메일이 전부 읽지 않음 상태로 돌아갔다.
#
# - 계정마다 **1회** 이전 집합을 DB 로 이관한다(mail_accounts.pop3_state_imported). 이후에는 DB 만 조회한다.
#   "DB 에 행이 없다"는 "아직 안 옮겼다"가 아니라 "읽은 것이 없다"일 수 있어 표식을 별도로 둔다.
# - 변경 시 DB 에 기록하고 이전 집합에도 동일한 변경을 적용한다. 조회하지 않는 사본이다. 업데이트 실패로
#   이전 버전(해당 집합만 조회한다)으로 롤백되었을 때 읽음 표시를 유지하기 위함이다.

_imported: set[str] = set()   # 본 프로세스가 이관 완료를 확인한 계정(매번 DB 를 조회하지 않도록)


async def _legacy_members(key: str) -> set[str]:
    r = await get_redis()
    raw = await r.smembers(key)
    return {x.decode() if isinstance(x, (bytes, bytearray)) else x for x in (raw or [])}


async def _ensure_imported(aid: str) -> None:
    if aid in _imported:
        return
    async with async_session() as db:
        done = (await db.execute(
            select(MailAccount.pop3_state_imported).where(MailAccount.id == aid)
        )).scalar_one_or_none()
    if done:
        _imported.add(aid)
        return
    if done is None:
        # 계정 행 없음(삭제 중이거나 해당 값이 비어 있는 이전 행). 이관할 위치가 없으면 중단한다.
        async with async_session() as db:
            exists = (await db.execute(select(MailAccount.id).where(MailAccount.id == aid))).scalar_one_or_none()
        if exists is None:
            return
    try:
        read_set = await _legacy_members(_read_key(aid))
        flag_set = await _legacy_members(_flag_key(aid))
    except Exception as e:  # noqa: BLE001 — 표식을 기록하지 않는다. 다음 접근 시 재이관한다.
        logger.warning("[pop3] 예전 읽음·별표 위치를 읽지 못했습니다(%s): %s", aid, e)
        return
    async with async_session() as db:
        # 표식을 먼저 선점한다. 여러 워커가 동시에 진입해도 이 행을 변경한 하나만 이관한다(나머지는 0행).
        claimed = await db.execute(
            update(MailAccount)
            .where(MailAccount.id == aid, MailAccount.pop3_state_imported.isnot(True))
            .values(pop3_state_imported=True, updated_at=MailAccount.updated_at)
        )
        if claimed.rowcount:
            for uidl in sorted(read_set | flag_set):
                if not uidl or len(uidl) > 255:
                    continue
                db.add(MailPop3State(
                    account_id=aid, uidl=uidl, is_read=uidl in read_set, is_flagged=uidl in flag_set,
                ))
            try:
                await db.commit()
            except IntegrityError:   # 표식이 없으나 행이 이미 존재한 경우 — 표식만 기록
                await db.rollback()
                await db.execute(
                    update(MailAccount).where(MailAccount.id == aid)
                    .values(pop3_state_imported=True, updated_at=MailAccount.updated_at)
                )
                await db.commit()
            if read_set or flag_set:
                logger.info("[pop3] 읽음 %d·별표 %d 건을 DB 로 옮겼습니다(%s)", len(read_set), len(flag_set), aid)
    _imported.add(aid)


async def _state(aid: str) -> tuple[set[str], set[str]]:
    """(읽은 UIDL, 별표한 UIDL)."""
    await _ensure_imported(aid)
    async with async_session() as db:
        rows = (await db.execute(
            select(MailPop3State.uidl, MailPop3State.is_read, MailPop3State.is_flagged)
            .where(MailPop3State.account_id == aid)
        )).all()
    return {u for u, rd, _ in rows if rd}, {u for u, _, fl in rows if fl}


async def _set_state(aid: str, uidl: str, *, read: bool | None = None, flagged: bool | None = None) -> None:
    """읽음·별표를 변경한다(None = 유지). 둘 다 해제되면 행을 삭제한다."""
    await _ensure_imported(aid)
    for _ in range(2):
        async with async_session() as db:
            row = await db.get(MailPop3State, (aid, uidl))
            if row is None:
                if not (read or flagged):
                    break
                db.add(MailPop3State(account_id=aid, uidl=uidl, is_read=bool(read), is_flagged=bool(flagged)))
            else:
                if read is not None:
                    row.is_read = read
                if flagged is not None:
                    row.is_flagged = flagged
                if not (row.is_read or row.is_flagged):
                    await db.delete(row)
            try:
                await db.commit()
                break
            except IntegrityError:   # 동일 메시지를 두 요청이 동시에 최초 표시한 경우 — 재조회 후 갱신
                await db.rollback()
    # 이전 집합의 사본
    try:
        r = await get_redis()
        if read is not None:
            await (r.sadd if read else r.srem)(_read_key(aid), uidl)
        if flagged is not None:
            await (r.sadd if flagged else r.srem)(_flag_key(aid), uidl)
    except Exception:  # noqa: BLE001
        pass


async def _forget(aid: str, uidl: str) -> None:
    """삭제된 메시지의 표시를 제거한다."""
    await _ensure_imported(aid)
    async with async_session() as db:
        await db.execute(delete(MailPop3State).where(
            MailPop3State.account_id == aid, MailPop3State.uidl == uidl))
        await db.commit()
    try:
        r = await get_redis()
        await r.srem(_read_key(aid), uidl)
        await r.srem(_flag_key(aid), uidl)
    except Exception:  # noqa: BLE001
        pass


# ── 인터페이스 (imap_client 와 동일 시그니처) ──

async def test_connection(account: MailAccount) -> tuple[bool, str]:
    try:
        def _t():
            pop = _connect_sync(account)
            try:
                pop.stat()
            finally:
                try:
                    pop.quit()
                except Exception:
                    pass
            return True
        await asyncio.to_thread(_t)
        return True, "POP3 연결 성공"
    except Exception as e:  # noqa: BLE001
        return False, f"POP3 연결 실패: {e}"


async def list_mailboxes(account: MailAccount) -> list[dict]:
    # POP3 = INBOX 전용
    return [{
        "id": "INBOX", "name": "받은편지함", "role": "inbox",
        "unread_count": 0, "total_count": 0, "sort_order": 0,
    }]


_INDEX_TTL = 60           # 헤더 인덱스 캐시(초) — 페이지 이동은 캐시로 즉시 처리, 이후 새 메일 반영
_INDEX_CAP = 500          # 전체 헤더 조회 상한(구형 POP3 계정 보호). 초과 시 번호 최신 500개.


def _index_key(aid: str) -> str:
    return f"mail:pop3:index:{aid}"


async def _build_index(account: MailAccount) -> list[dict]:
    """전체 메시지 헤더 인덱스(날짜 최신순 정렬). Redis 캐시(_INDEX_TTL).

    번호 순서에 의존하지 않고 헤더 Date 로 전역 정렬 → 서버의 번호 부여 방식과 무관하게 최신순.
    """
    r = await get_redis()
    cached = await r.get(_index_key(account.id))
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            pass

    def _work():
        pop = _connect_sync(account)
        try:
            uidls = _uidl_list(pop)
            uidls.sort(key=lambda t: t[0], reverse=True)   # 번호 큰(대개 최신) 순 — 상한 컷용
            uidls = uidls[:_INDEX_CAP]
            items = []
            for num, uidl in uidls:
                try:
                    raw = b"\r\n".join(pop.top(num, 0)[1])   # 헤더만
                except Exception:
                    try:
                        raw = b"\r\n".join(pop.retr(num)[1])
                    except Exception:
                        continue
                m = email.message_from_bytes(raw)
                items.append({
                    "uidl": uidl, "num": num,
                    "from": _ic._parse_address(m.get("From")),
                    "to": _ic._parse_address(m.get("To")),
                    "subject": _ic._decode_header(m.get("Subject")),
                    "date": _ic._parse_date(m.get("Date")),
                    # 스레드·첨부 필터용. 이전 캐시에는 없을 수 있다.
                    "msgid": m.get("Message-ID"),
                    "irt": m.get("In-Reply-To"),
                    "refs": m.get("References"),
                    "ctype": (m.get("Content-Type") or "").lower()[:100],
                })
            return items
        finally:
            try:
                pop.quit()
            except Exception:
                pass

    items = await asyncio.to_thread(_work)
    # 날짜(ISO8601 문자열) 최신순, 날짜 없으면 번호로 보정
    items.sort(key=lambda x: (x.get("date") or "", x.get("num", 0)), reverse=True)
    try:
        await r.set(_index_key(account.id), json.dumps(items), ex=_INDEX_TTL)
    except Exception:
        pass
    return items


async def fetch_messages(
    account: MailAccount, mailbox: str, page: int = 0, limit: int = 50,
    query: str | None = None,
    unread: bool | None = None,
    flagged: bool | None = None,
    has_attachment: bool | None = None,
    label: str | None = None,
) -> tuple[list[dict], int]:
    """label 은 POP3 에 저장소가 없어 무시한다(라벨 미지원)."""
    index = await _build_index(account)
    read_set, flag_set = await _state(account.id)
    q = (query or "").strip().lower()
    if q:
        def _hit(it):
            hay = ((it.get("subject") or "") + " "
                   + " ".join(a.get("email", "") for a in (it.get("from") or []))).lower()
            return q in hay
        index = [it for it in index if _hit(it)]
    if unread is not None:
        index = [it for it in index if (it["uidl"] not in read_set) == unread]
    if flagged is not None:
        index = [it for it in index if (it["uidl"] in flag_set) == flagged]
    if has_attachment is not None:
        index = [it for it in index if _has_att(it) == has_attachment]
    total = len(index)
    page_items = index[page * limit:(page + 1) * limit]
    out = [{
        "id": it["uidl"],
        "thread_id": threads.header_thread_id(it.get("msgid"), it.get("irt"), it.get("refs")),
        "mailbox_ids": ["INBOX"],
        "from_": it.get("from") or [], "to": it.get("to") or [],
        "subject": it.get("subject") or "", "preview": None,
        "received_at": it.get("date"),
        "is_unread": it["uidl"] not in read_set,
        "is_flagged": it["uidl"] in flag_set,
        "has_attachment": _has_att(it),
        "labels": [],
    } for it in page_items]
    return out, total


def _has_att(it: dict) -> bool:
    return (it.get("ctype") or "").startswith("multipart/mixed")


async def fetch_thread(
    account: MailAccount, mailbox: str, uid: str, extra_mailboxes: list[str] | None = None,
) -> dict | None:
    """POP3 는 받은편지함 하나뿐이므로 인덱스의 헤더로 동일 대화를 그룹화한다."""
    index = await _build_index(account)
    me = next((it for it in index if it["uidl"] == uid), None)
    if me is None:
        return None
    tid = threads.header_thread_id(me.get("msgid"), me.get("irt"), me.get("refs"))
    read_set, flag_set = await _state(account.id)
    members = [it for it in index if it is me or (
        tid and threads.header_thread_id(it.get("msgid"), it.get("irt"), it.get("refs")) == tid)]
    members.sort(key=lambda it: it.get("date") or "")
    return {"thread_id": tid, "messages": [{
        "id": it["uidl"], "thread_id": tid, "mailbox_ids": ["INBOX"],
        "from_": it.get("from") or [], "to": it.get("to") or [],
        "subject": it.get("subject") or "", "preview": None,
        "received_at": it.get("date"),
        "is_unread": it["uidl"] not in read_set,
        "is_flagged": it["uidl"] in flag_set,
        "has_attachment": _has_att(it),
        "labels": [],
    } for it in members[-200:]]}


async def list_labels(account: MailAccount, mailbox: str = "INBOX") -> dict:
    return {"labels": [], "supported": False}


def _find_raw_sync(account: MailAccount, uid: str) -> bytes | None:
    pop = _connect_sync(account)
    try:
        num = next((n for n, u in _uidl_list(pop) if u == uid), None)
        if num is None:
            return None
        return b"\r\n".join(pop.retr(num)[1])
    finally:
        try:
            pop.quit()
        except Exception:
            pass


async def fetch_message(account: MailAccount, mailbox: str, uid: str) -> dict | None:
    raw = await asyncio.to_thread(_find_raw_sync, account, uid)
    if not raw:
        return None
    m = email.message_from_bytes(raw)
    text_body, html_body = _ic._extract_body(m)
    if html_body and "cid:" in html_body.lower():
        html_body = _ic._rewrite_cid_images(html_body, _ic._inline_cid_map(m))
    attachments = _ic._extract_attachments(m)
    await _set_state(account.id, uid, read=True)  # 열면 읽음 처리(로컬)
    _read_set, flag_set = await _state(account.id)
    return {
        "id": uid, "thread_id": None, "mailbox_ids": ["INBOX"],
        "from_": _ic._parse_address(m.get("From")), "to": _ic._parse_address(m.get("To")),
        "cc": _ic._parse_address(m.get("Cc")), "bcc": _ic._parse_address(m.get("Bcc")),
        "reply_to": _ic._parse_address(m.get("Reply-To")),
        "subject": _ic._decode_header(m.get("Subject")),
        "text_body": text_body, "html_body": html_body,
        "preview": (text_body or "")[:200] if text_body else None,
        "received_at": _ic._parse_date(m.get("Date")),
        "is_unread": False, "is_flagged": uid in flag_set,
        "attachments": [
            {"blob_id": f"{uid}:{att['part_index']}", "name": att["name"],
             "type": att["type"], "size": att["size"]}
            for att in attachments
        ],
        "in_reply_to": m.get("In-Reply-To"), "references": m.get("References"),
        "disposition_notification_to": None, "mdn_sent": False,
    }


async def update_flags(
    account: MailAccount, mailbox: str, uid: str,
    add_flags: list[str] | None = None, remove_flags: list[str] | None = None,
) -> bool:
    read: bool | None = None
    flagged: bool | None = None
    for f in (add_flags or []):
        if f == "\\Seen":
            read = True
        elif f == "\\Flagged":
            flagged = True
    for f in (remove_flags or []):
        if f == "\\Seen":
            read = False
        elif f == "\\Flagged":
            flagged = False
    if read is not None or flagged is not None:
        await _set_state(account.id, uid, read=read, flagged=flagged)
    return True


async def delete_message(
    account: MailAccount, mailbox: str, uid: str, trash_mailbox: str | None = None,
) -> dict:
    # POP3 는 휴지통이 없다. DELE 는 서버에서 영구 삭제한다.
    def _work():
        pop = _connect_sync(account)
        try:
            num = next((n for n, u in _uidl_list(pop) if u == uid), None)
            if num is None:
                return False
            pop.dele(num)
            pop.quit()
            return True
        except Exception:
            try:
                pop.quit()
            except Exception:
                pass
            return False
    ok = await asyncio.to_thread(_work)
    if ok:
        await _forget(account.id, uid)
        r = await get_redis()
        await r.delete(_index_key(account.id))  # 인덱스 캐시 무효화 → 다음 조회에 반영
    return {"ok": ok, "permanent": True}


async def download_attachment(
    account: MailAccount, mailbox: str, uid: str, part_index: int,
) -> tuple[bytes, str, str] | None:
    raw = await asyncio.to_thread(_find_raw_sync, account, uid)
    if not raw:
        return None
    m = email.message_from_bytes(raw)
    parts = list(m.walk()) if m.is_multipart() else [m]
    if part_index >= len(parts):
        return None
    part = parts[part_index]
    data = part.get_payload(decode=True) or b""
    ct = part.get_content_type()
    filename = part.get_filename()
    if filename:
        filename = _ic._decode_header(filename)
    return data, ct, filename or f"attachment_{part_index}"


async def fetch_raw_headers(account: MailAccount, mailbox: str, uid: str) -> str | None:
    def _work():
        pop = _connect_sync(account)
        try:
            num = next((n for n, u in _uidl_list(pop) if u == uid), None)
            if num is None:
                return None
            return b"\r\n".join(pop.top(num, 0)[1]).decode("utf-8", "replace")
        finally:
            try:
                pop.quit()
            except Exception:
                pass
    return await asyncio.to_thread(_work)


# ── POP3 미지원 동작(no-op) — 폴더/이동/보낸함복사 없음 ──

async def create_mailbox(account: MailAccount, name: str) -> bool:
    return False


async def rename_mailbox(account: MailAccount, old_name: str, new_name: str) -> bool:
    return False


async def delete_mailbox(account: MailAccount, name: str) -> bool:
    return False


async def move_message(account: MailAccount, mailbox: str, uid: str, dest: str) -> bool:
    return False


async def append_to_sent(account: MailAccount, raw_message: bytes) -> bool:
    return False  # POP3 계정은 서버 보낸함이 없으므로 무시


def _fetch_raw_many_sync(account: MailAccount, uids: list[str]) -> dict[str, bytes]:
    """여러 UID 의 원본을 단일 연결로 조회한다. POP3 는 UIDL 목록을 매번 다시 수신해야 하므로
    건별로 접속하면 동일 목록을 N번 수신한다(백필이 수백 통이면 타임아웃 발생)."""
    out: dict[str, bytes] = {}
    if not uids:
        return out
    want = set(uids)
    pop = _connect_sync(account)
    try:
        for num, u in _uidl_list(pop):
            if u not in want:
                continue
            try:
                out[u] = b"\r\n".join(pop.retr(num)[1])
            except Exception as e:
                logger.warning("[pop3] retr 실패 uid=%s: %s", u, e)
    finally:
        try:
            pop.quit()
        except Exception:
            pass
    return out


async def fetch_raw_many(
    account: MailAccount, mailbox: str, uids: list[str]
) -> dict[str, bytes]:
    """imap_client.fetch_raw_many 와 동일한 인터페이스(아카이브가 프로토콜을 구분하지 않도록)."""
    return await asyncio.to_thread(_fetch_raw_many_sync, account, uids)
