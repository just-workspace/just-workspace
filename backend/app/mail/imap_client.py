"""IMAP client for reading mail via aioimaplib.

aioimaplib strips the '* ' untagged response prefix from lines,
so parsing must NOT expect '* LIST', '* N FETCH', etc.
Body data is returned as bytearray, metadata lines as bytes.
"""

import asyncio
import base64
import unicodedata
import email
import email.header
import email.utils
import logging
import re
from datetime import datetime, timezone
from email.message import Message as EmailMessage
from typing import Any
from urllib.parse import unquote

import aioimaplib

from app.db.models import MailAccount
from app.mail import threads
from app.mail import access_guard
from app.mail.crypto import decrypt_password

logger = logging.getLogger(__name__)


# 선언된 charset이 없거나 잘못된 메일(특히 한국어 EUC-KR/CP949) 대비 다중 폴백.
# latin-1은 모든 바이트가 디코드되므로 반드시 마지막에 배치(정상 charset이 가려지지 않도록).
_FALLBACK_CHARSETS = ("utf-8", "cp949", "euc-kr", "iso-2022-kr", "gb18030", "shift_jis", "big5", "latin-1")


def _safe_decode(data: bytes, charset: str | None) -> str:
    """바이트를 charset→폴백 순으로 strict 디코드. 모두 실패 시 utf-8 replace."""
    if not isinstance(data, (bytes, bytearray)):
        return str(data)
    tried: list[str] = []
    if charset:
        tried.append(charset)
    tried += [c for c in _FALLBACK_CHARSETS if c.lower() != (charset or "").lower()]
    for cs in tried:
        try:
            return data.decode(cs)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", errors="replace")


def _decode_header(raw: str | None) -> str:
    """Decode RFC 2047 encoded header (charset 폴백 강화)."""
    if not raw:
        return ""
    decoded_parts = email.header.decode_header(raw)
    result = []
    for part, charset in decoded_parts:
        if isinstance(part, bytes):
            result.append(_safe_decode(part, charset))
        else:
            result.append(part)
    return "".join(result)


def _parse_address(raw: str | None) -> list[dict]:
    """Parse email address header into list of {name, email}."""
    if not raw:
        return []
    decoded = _decode_header(raw)
    addresses = email.utils.getaddresses([decoded])
    return [{"name": name or None, "email": addr} for name, addr in addresses if addr]


def _parse_date(raw: str | None) -> str | None:
    """Parse email date header to ISO 8601."""
    if not raw:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(raw)
        return parsed.isoformat()
    except (ValueError, TypeError) as e:
        logger.debug("Failed to parse email date '%s': %s", raw[:50] if raw else "", e)
        return raw


def _has_attachments(msg: EmailMessage) -> bool:
    """Check if message has attachments."""
    if msg.is_multipart():
        for part in msg.walk():
            disposition = part.get_content_disposition()
            if disposition == "attachment":
                return True
            ct = part.get_content_type()
            if disposition == "inline" and ct not in ("text/plain", "text/html"):
                return True
    return False


def _is_binary_type(content_type: str) -> bool:
    """Check if content type is binary (not text/html body)."""
    if content_type.startswith("text/"):
        return False
    if content_type in ("multipart/alternative", "multipart/mixed", "multipart/related",
                        "multipart/report", "message/rfc822"):
        return False
    return True


def _extract_body(msg: EmailMessage) -> tuple[str | None, str | None]:
    """Extract text and HTML body from email message."""
    text_body = None
    html_body = None

    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            disposition = part.get_content_disposition()
            if disposition == "attachment":
                continue
            # Skip binary content types (ZIP, images, etc.) even without disposition
            if _is_binary_type(ct):
                continue
            try:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                decoded = _safe_decode(payload, part.get_content_charset())
                if ct == "text/plain" and text_body is None:
                    text_body = decoded
                elif ct == "text/html" and html_body is None:
                    html_body = decoded
            except (LookupError, UnicodeDecodeError, TypeError) as e:
                logger.debug("Failed to decode multipart body part (type=%s): %s", ct, e)
                continue
    else:
        ct = msg.get_content_type()
        # Skip binary single-part messages (e.g. DMARC reports: application/zip)
        if not _is_binary_type(ct):
            try:
                payload = msg.get_payload(decode=True)
                if payload:
                    decoded = _safe_decode(payload, msg.get_content_charset())
                    if ct == "text/html":
                        html_body = decoded
                    else:
                        text_body = decoded
            except (LookupError, UnicodeDecodeError, TypeError) as e:
                logger.debug("Failed to decode single-part body (type=%s): %s", ct, e)

    return text_body, html_body


# 인라인 이미지(cid:) 치환 한도 — 본문 payload 비대화 방지
_INLINE_MAX_BYTES = 3 * 1024 * 1024      # 이미지 1개 최대 3MB
_INLINE_TOTAL_BYTES = 12 * 1024 * 1024   # 메일당 합계 최대 12MB
_CID_SRC_RE = re.compile(r"""(src\s*=\s*['"]?)cid:([^'">\s]+)""", re.IGNORECASE)


def _inline_cid_map(msg: EmailMessage) -> dict[str, str]:
    """Content-ID(cid) → data: URI 매핑. 인라인 이미지만, 한도 내에서."""
    cid_map: dict[str, str] = {}
    if not msg.is_multipart():
        return cid_map
    total = 0
    for part in msg.walk():
        ct = part.get_content_type()
        if not ct.startswith("image/"):
            continue
        cid = part.get("Content-ID")
        if not cid:
            continue
        cid = cid.strip().strip("<>").strip()
        if not cid or cid in cid_map:
            continue
        try:
            data = part.get_payload(decode=True)
        except (LookupError, TypeError):
            continue
        if not isinstance(data, (bytes, bytearray)) or not data:
            continue
        if len(data) > _INLINE_MAX_BYTES:
            continue
        if total + len(data) > _INLINE_TOTAL_BYTES:
            break
        total += len(data)
        b64 = base64.b64encode(data).decode("ascii")
        cid_map[cid] = f"data:{ct};base64,{b64}"
    return cid_map


def _rewrite_cid_images(html: str, cid_map: dict[str, str]) -> str:
    """html_body 의 src="cid:..." 를 data: URI 로 치환(브라우저는 cid: 를 해석하지 못함)."""
    if not html or not cid_map:
        return html

    def _sub(m: re.Match) -> str:
        # Content-ID 는 URL 인코딩될 수 있어 원본·언쿼트 둘 다 조회
        ref = m.group(2)
        uri = cid_map.get(ref) or cid_map.get(unquote(ref))
        return f"{m.group(1)}{uri}" if uri else m.group(0)

    return _CID_SRC_RE.sub(_sub, html)


def _extract_attachments(msg: EmailMessage) -> list[dict]:
    """Extract attachment metadata from email message."""
    attachments = []

    # Handle single-part binary messages (e.g. DMARC: entire message is application/zip)
    if not msg.is_multipart():
        ct = msg.get_content_type()
        if _is_binary_type(ct):
            filename = msg.get_filename()
            if filename:
                filename = _decode_header(filename)
            payload_data = msg.get_payload(decode=True) or b""
            attachments.append({
                "part_index": 0,
                "name": filename or f"attachment_0.{ct.split('/')[-1]}",
                "type": ct,
                "size": len(payload_data),
            })
        return attachments

    for i, part in enumerate(msg.walk()):
        disposition = part.get_content_disposition()
        ct = part.get_content_type()
        # Explicit attachment disposition
        is_attachment = disposition == "attachment"
        # Inline non-text (images etc.)
        is_inline_binary = disposition == "inline" and ct not in ("text/plain", "text/html")
        # No disposition but binary content type (e.g. DMARC reports: application/zip, application/gzip)
        is_undeclared_binary = disposition is None and _is_binary_type(ct)

        if is_attachment or is_inline_binary or is_undeclared_binary:
            filename = part.get_filename()
            if filename:
                filename = _decode_header(filename)
            payload_data = part.get_payload(decode=True) or b""
            size = len(payload_data)
            attachments.append({
                "part_index": i,
                "name": filename or f"attachment_{i}.{ct.split('/')[-1]}",
                "type": ct,
                "size": size,
            })
    return attachments


def _line_to_str(line) -> str:
    """Convert a response line (bytes, bytearray, or str) to str."""
    if isinstance(line, (bytes, bytearray)):
        return line.decode("utf-8", errors="replace")
    return str(line)


def _q(mailbox: str) -> str:
    """메일함 이름 → IMAP quoted string.

    aioimaplib 는 인자를 공백으로 연결만 한다(따옴표를 추가하지 않는다). 따옴표 없이 전송하면
    공백이 포함된 이름("전체 편지함", "Deleted Items")이 두 인자로 분리되어 SELECT/COPY/APPEND 가 BAD 로 종료된다.
    줄바꿈이 포함된 이름은 명령 주입이므로 거부한다.
    """
    s = str(mailbox or "")
    if not s or any(c in s for c in "\r\n\x00"):
        raise ValueError("잘못된 메일함 이름")
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _ok(resp) -> bool:
    """aioimaplib 는 NO/BAD 를 예외로 발생시키지 않고 Response.result 로만 전달하므로 반드시 확인한다."""
    return getattr(resp, "result", None) == "OK"


async def _select(imap, mailbox: str) -> bool:
    return _ok(await imap.select(_q(mailbox)))


async def _expunge_uid(imap, uid: str) -> bool:
    """해당 UID 만 삭제한다(UIDPLUS). 일반 EXPUNGE 는 다른 앱이 삭제 표시한 메일까지 함께 삭제한다.
    UIDPLUS 미지원 서버에서만 기존 방식대로 전체 EXPUNGE."""
    if _supports(imap, "UIDPLUS"):
        return _ok(await imap.uid("expunge", uid))
    return _ok(await imap.expunge())


async def _connect(account: MailAccount) -> aioimaplib.IMAP4_SSL | aioimaplib.IMAP4:
    """Connect and authenticate to IMAP server."""
    import ssl as _ssl
    from app.config import get_settings

    settings = get_settings()

    auth_method = getattr(account, "auth_method", "password") or "password"
    # 마스터 인증은 사용자 본인의 내장 메일함 객체에서만(access_guard). 외부 계정은 내부망 접속 금지.
    await access_guard.ensure_account_hosts(account)
    is_builtin = access_guard.is_builtin(account)
    login_user = account.username
    login_password = ""
    if auth_method != "oauth":
        login_user, login_password, is_builtin = access_guard.login_credentials(account, decrypt_password)

    # 내부 mailserver만 인증서 검증 생략. 외부 계정은 정상 검증(자격증명 MITM 방지).
    ssl_context = _ssl.create_default_context()
    if is_builtin:
        ssl_context.check_hostname = False
        ssl_context.verify_mode = _ssl.CERT_NONE

    if account.imap_security == "ssl":
        imap = aioimaplib.IMAP4_SSL(
            host=account.imap_host,
            port=account.imap_port,
            timeout=30,
            ssl_context=ssl_context,
        )
    else:
        imap = aioimaplib.IMAP4(
            host=account.imap_host,
            port=account.imap_port,
            timeout=30,
        )

    await imap.wait_hello_from_server()

    if account.imap_security == "starttls":
        await imap.starttls(ssl_context=ssl_context)

    if auth_method == "oauth":
        from app.mail import oauth as mail_oauth
        token = await mail_oauth.get_access_token(account)
        if not hasattr(imap, "xoauth2"):
            raise ConnectionError("이 서버는 IMAP XOAUTH2를 지원하지 않습니다(aioimaplib 업데이트 필요)")
        response = await imap.xoauth2(account.username, token)
    else:
        response = await imap.login(login_user, login_password)
    if response.result != "OK":
        raise ConnectionError(f"IMAP auth failed: {response.result}")

    return imap


def _imap_utf7_decode(s: str) -> str:
    """IMAP modified UTF-7(RFC 3501) 디코드 — 비ASCII 폴더명(네이버 한글 등) '&xxx-' 복원."""
    if "&" not in s:
        return s
    out, i, n = [], 0, len(s)
    while i < n:
        if s[i] == "&":
            j = s.find("-", i + 1)
            if j == -1:
                out.append(s[i:]); break
            chunk = s[i + 1:j]
            if chunk == "":
                out.append("&")
            else:
                b64 = chunk.replace(",", "/")
                b64 += "=" * ((-len(b64)) % 4)
                try:
                    out.append(base64.b64decode(b64).decode("utf-16-be"))
                except Exception:
                    out.append(s[i:j + 1])
            i = j + 1
        else:
            out.append(s[i]); i += 1
    return "".join(out)


def _imap_utf7_encode(s: str) -> str:
    """폴더명 → IMAP modified UTF-7. 한글은 NFC 로 정규화한 뒤 인코드한다. 맥은 NFD(자모 분리)로 전송하므로
    외관상 동일한 이름의 폴더가 두 개 생성된다."""
    s = unicodedata.normalize("NFC", s)
    out, buf = [], []

    def flush():
        if buf:
            b64 = base64.b64encode("".join(buf).encode("utf-16-be")).decode("ascii").rstrip("=").replace("/", ",")
            out.append(f"&{b64}-")
            buf.clear()

    for ch in s:
        if 0x20 <= ord(ch) <= 0x7E:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buf.append(ch)
    flush()
    return "".join(out)


# 디코드된 폴더명(소문자) → 표준 역할 (special-use 플래그 없을 때 폴백, 한글 포함)
_ROLE_BY_NAME = {
    "inbox": "inbox", "받은편지함": "inbox", "받은 편지함": "inbox", "받은메일함": "inbox",
    "sent": "sent", "sent mail": "sent", "sent items": "sent", "sent messages": "sent",
    "보낸편지함": "sent", "보낸 편지함": "sent", "보낸메일함": "sent",
    "drafts": "drafts", "draft": "drafts", "임시보관함": "drafts", "임시 보관함": "drafts", "쓰던메일함": "drafts",
    "junk": "junk", "spam": "junk", "bulk mail": "junk", "스팸": "junk", "스팸함": "junk", "스팸메일함": "junk",
    "trash": "trash", "deleted": "trash", "deleted items": "trash", "deleted messages": "trash",
    "휴지통": "trash", "지운편지함": "trash", "삭제된편지함": "trash",
    "archive": "archive", "all mail": "archive", "전체보관함": "archive", "전체 보관함": "archive", "보관함": "archive",
}
# 역할 → 통일된 표시 이름(시스템 폴더는 제공자/언어 무관 일관 표기)
_ROLE_DISPLAY = {
    "inbox": "받은편지함", "sent": "보낸편지함", "drafts": "임시보관함",
    "junk": "스팸함", "trash": "휴지통", "archive": "전체보관함",
}


async def list_mailboxes(account: MailAccount) -> list[dict]:
    """List IMAP mailboxes with unread counts."""
    imap = await _connect(account)
    try:
        response = await imap.list('""', "*")
        if response.result != "OK":
            return []

        mailboxes = []
        role_order = {"inbox": 0, "drafts": 1, "sent": 2, "junk": 3, "trash": 4, "archive": 5}

        seen_roles: set[str] = set()

        for line in response.lines:
            if not line or line == b")" or line == b"":
                continue
            line_str = _line_to_str(line)

            # aioimaplib strips "* LIST " prefix.
            # Lines: (\flags) "delimiter" name  OR  * LIST (\flags) "delimiter" name
            match = re.match(r'(?:\* LIST )?\(([^)]*)\) "([^"]*)" (.+)', line_str)
            if not match:
                continue

            flags = match.group(1)
            name = match.group(3).strip('"')   # 원본(modified UTF-7) — SELECT/STATUS 용

            # \Noselect 컨테이너(예: Gmail '[Gmail]') / 레거시 별칭 건너뛰기
            if "\\Noselect" in flags or "\\NonExistent" in flags or name.startswith("_"):
                continue

            decoded = unicodedata.normalize("NFC", _imap_utf7_decode(name))
            seg = decoded.split("/")[-1] if "/" in decoded else decoded
            seg_lower = seg.lower()

            # 역할: special-use 플래그 우선, 없으면 (디코드된) 이름 매핑
            role = None
            if "\\Inbox" in flags or seg_lower == "inbox":
                role = "inbox"
            elif "\\Sent" in flags:
                role = "sent"
            elif "\\Drafts" in flags:
                role = "drafts"
            elif "\\Junk" in flags:
                role = "junk"
            elif "\\Trash" in flags:
                role = "trash"
            elif "\\Archive" in flags or "\\All" in flags:
                role = "archive"
            else:
                role = _ROLE_BY_NAME.get(seg_lower)

            if role and role in seen_roles:
                continue
            if role:
                seen_roles.add(role)

            # Get message counts
            total = 0
            unread = 0
            try:
                status_resp = await imap.status(_q(name), "(MESSAGES UNSEEN)")
                if status_resp.result == "OK":
                    status_line = _line_to_str(status_resp.lines[0])
                    m_total = re.search(r"MESSAGES (\d+)", status_line)
                    m_unseen = re.search(r"UNSEEN (\d+)", status_line)
                    if m_total:
                        total = int(m_total.group(1))
                    if m_unseen:
                        unread = int(m_unseen.group(1))
            except Exception:
                pass

            sort_order = role_order.get(role, 99) if role else 99
            display = _ROLE_DISPLAY.get(role) or seg

            mailboxes.append({
                "id": name,
                "name": display,
                "role": role,
                "unread_count": unread,
                "total_count": total,
                "sort_order": sort_order,
            })

        mailboxes.sort(key=lambda m: (m["sort_order"], m["name"]))
        return mailboxes
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


def _summary_from_header(uid: str, flags: str, header_data: bytes, mailbox: str) -> dict:
    msg = email.message_from_bytes(header_data)
    ctype = (msg.get("Content-Type") or "").lower()
    return {
        "id": uid,
        "thread_id": threads.header_thread_id(
            msg.get("Message-ID"), msg.get("In-Reply-To"), msg.get("References")
        ),
        "mailbox_ids": [mailbox],
        "from_": _parse_address(msg.get("From")),
        "to": _parse_address(msg.get("To")),
        "subject": _decode_header(msg.get("Subject")),
        "preview": None,
        "received_at": _parse_date(msg.get("Date")),
        "is_unread": "\\Seen" not in flags,
        "is_flagged": "\\Flagged" in flags,
        # 헤더만 수신하므로 추정: multipart/mixed 면 첨부가 있는 메일(서버 필터와 동일 기준)
        "has_attachment": ctype.startswith("multipart/mixed"),
        "labels": threads.flags_to_labels(flags),
        "message_id": (msg.get("Message-ID") or "").strip() or None,
        "_root": threads.thread_root(msg.get("Message-ID"), msg.get("In-Reply-To"), msg.get("References")),
    }


def _parse_header_fetch(lines, mailbox: str) -> list[dict]:
    """FETCH (UID FLAGS BODY.PEEK[HEADER]) 응답 → 요약 dict 목록(서버 반환 순서)."""
    messages = []
    current_uid = None
    current_flags = ""
    current_header_data = b""
    for line in lines:
        line_str = _line_to_str(line)
        # aioimaplib strips "* " prefix.
        # Lines: N FETCH (UID xxx FLAGS (...) BODY[HEADER] {size})
        fetch_match = re.match(r"\d+ FETCH \(.*?UID (\d+).*?FLAGS \(([^)]*)\)", line_str)
        if not fetch_match:
            # 서버에 따라 FLAGS 가 UID 앞에 위치
            m2 = re.match(r"\d+ FETCH \(.*?FLAGS \(([^)]*)\).*?UID (\d+)", line_str)
            if m2:
                fetch_match = m2
                uid_g, flags_g = 2, 1
            else:
                uid_g, flags_g = 1, 2
        else:
            uid_g, flags_g = 1, 2
        if fetch_match:
            if current_uid and current_header_data:
                messages.append(_summary_from_header(current_uid, current_flags, current_header_data, mailbox))
            current_uid = fetch_match.group(uid_g)
            current_flags = fetch_match.group(flags_g)
            current_header_data = b""
        elif isinstance(line, (bytes, bytearray)) and current_uid:
            current_header_data += bytes(line) + b"\r\n"
    if current_uid and current_header_data:
        messages.append(_summary_from_header(current_uid, current_flags, current_header_data, mailbox))
    return messages


def _supports(imap, cap: str) -> bool:
    try:
        return bool(imap.has_capability(cap))
    except Exception:
        return False


async def _server_threads(imap) -> dict[str, tuple[str, int]] | None:
    """UID THREAD REFERENCES UTF-8 ALL → UID → (thread_id, 개수). 미지원·실패면 None."""
    if not _supports(imap, "THREAD=REFERENCES"):
        return None
    try:
        proto = imap.protocol
        cmd = aioimaplib.Command("THREAD", proto.new_tag(), "REFERENCES", "UTF-8", "ALL",
                                 prefix="UID", loop=proto.loop)
        resp = await asyncio.wait_for(proto.execute(cmd), 30)
        if resp.result != "OK":
            return None
        text = " ".join(_line_to_str(l) for l in resp.lines if "THREAD" in _line_to_str(l).upper())
        return threads.thread_map(threads.parse_thread_response(text))
    except Exception as e:
        logger.debug("IMAP THREAD 실패 — 헤더 계산으로: %s", e)
        return None


def build_search_criteria(
    query: str | None = None,
    unread: bool | None = None,
    flagged: bool | None = None,
    has_attachment: bool | None = None,
    label: str | None = None,
) -> str:
    """목록 필터 → IMAP SEARCH 조건 문자열."""
    parts: list[str] = []
    if query:
        safe_q = query.replace('"', '').replace('(', '').replace(')', '').replace('\\', '')
        parts.append(f'(OR SUBJECT "{safe_q}" FROM "{safe_q}")')
    if unread is True:
        parts.append("UNSEEN")
    elif unread is False:
        parts.append("SEEN")
    if flagged is True:
        parts.append("FLAGGED")
    elif flagged is False:
        parts.append("UNFLAGGED")
    if has_attachment is True:
        # IMAP 에는 "첨부 있음" 검색이 없으므로 multipart/mixed 로 근사(대부분의 첨부 메일)
        parts.append('HEADER Content-Type "multipart/mixed"')
    elif has_attachment is False:
        parts.append('NOT HEADER Content-Type "multipart/mixed"')
    if label:
        parts.append(f"KEYWORD {threads.encode_keyword(label)}")
    if not parts:
        return "ALL"
    if len(parts) == 1:
        return parts[0]
    return "(" + " ".join(parts) + ")"


async def fetch_messages(
    account: MailAccount,
    mailbox: str,
    page: int = 0,
    limit: int = 50,
    query: str | None = None,
    unread: bool | None = None,
    flagged: bool | None = None,
    has_attachment: bool | None = None,
    label: str | None = None,
) -> tuple[list[dict], int]:
    """Fetch message summaries from a mailbox. Returns (messages, total)."""
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return [], 0

        # Search (returns sequence numbers)
        criteria = build_search_criteria(query, unread, flagged, has_attachment, label)
        search_resp = await imap.search(criteria)

        if search_resp.result != "OK":
            return [], 0

        # Parse sequence numbers
        seq_line = _line_to_str(search_resp.lines[0])
        seqs = seq_line.strip().split() if seq_line.strip() else []
        seqs = [x for x in seqs if x.isdigit()]

        total = len(seqs)
        if total == 0:
            return [], 0

        # Reverse for newest first, paginate
        seqs.reverse()
        start = page * limit
        end = start + limit
        page_seqs = seqs[start:end]

        if not page_seqs:
            return [], total

        seq_range = ",".join(page_seqs)
        # Request UID so we can use it as stable message ID
        fetch_resp = await imap.fetch(seq_range, "(UID FLAGS BODY.PEEK[HEADER])")
        if fetch_resp.result != "OK":
            return [], total

        messages = _parse_header_fetch(fetch_resp.lines, mailbox)

        # 스레드: 서버가 THREAD=REFERENCES 를 지원하면 서버 계산, 아니면 헤더 계산(이미 설정됨)
        tmap = await _server_threads(imap)
        for m in messages:
            m.pop("_root", None)
            if tmap and m["id"] in tmap:
                m["thread_id"], m["thread_count"] = tmap[m["id"]]

        # IMAP FETCH returns messages in ascending sequence order,
        # but we want newest first — reverse to match page_seqs order.
        messages.reverse()

        return messages, total
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def fetch_thread(
    account: MailAccount, mailbox: str, uid: str, extra_mailboxes: list[str] | None = None,
) -> dict | None:
    """한 메일이 속한 스레드의 메일 목록(오래된 순). 메일이 없으면 None.

    기준 메일함은 THREAD=REFERENCES 지원 시 서버 계산, 아니면 루트 Message-ID 로 헤더 검색.
    extra_mailboxes(예: 보낸편지함)는 헤더 검색으로 동일 대화를 추가한다.
    """
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return None
        head = await imap.uid("fetch", uid, "(UID FLAGS BODY.PEEK[HEADER])")
        if head.result != "OK":
            return None
        base = _parse_header_fetch(head.lines, mailbox)
        if not base:
            return None
        me = base[0]
        root = me.get("_root")

        uids: list[str] = []
        thread_id = me["thread_id"]
        tmap = await _server_threads(imap)
        if tmap and uid in tmap:
            thread_id = tmap[uid][0]
            uids = [u for u, (tid, _) in tmap.items() if tid == thread_id]
        elif root:
            safe = root.replace('"', "")
            r = await imap.uid_search(
                f'OR OR HEADER Message-ID "{safe}" HEADER References "{safe}" HEADER In-Reply-To "{safe}"'
            )
            if r.result == "OK" and r.lines:
                uids = [x for x in _line_to_str(r.lines[0]).split() if x.isdigit()]
        if uid not in uids:
            uids.append(uid)
        uids = sorted(set(uids), key=int)[-200:]

        items: list[dict] = []
        if uids:
            fr = await imap.uid("fetch", ",".join(uids), "(UID FLAGS BODY.PEEK[HEADER])")
            if fr.result == "OK":
                items = _parse_header_fetch(fr.lines, mailbox)

        roots = {root} if root else set()
        roots |= {m.get("_root") for m in items if m.get("_root")}
        for mb in extra_mailboxes or []:
            if not mb or mb == mailbox or not roots:
                continue
            try:
                if not await _select(imap, mb):
                    continue
                found: set[str] = set()
                for rt in list(roots)[:5]:
                    safe = rt.replace('"', "")
                    r = await imap.uid_search(
                        f'OR OR HEADER Message-ID "{safe}" HEADER References "{safe}" HEADER In-Reply-To "{safe}"'
                    )
                    if r.result == "OK" and r.lines:
                        found |= {x for x in _line_to_str(r.lines[0]).split() if x.isdigit()}
                if found:
                    fr = await imap.uid("fetch", ",".join(sorted(found, key=int)[-100:]), "(UID FLAGS BODY.PEEK[HEADER])")
                    if fr.result == "OK":
                        items += _parse_header_fetch(fr.lines, mb)
            except Exception as e:
                logger.debug("스레드 추가 메일함 %s 검색 실패: %s", mb, e)

        for m in items:
            m.pop("_root", None)
            m["thread_id"] = thread_id
        items.sort(key=lambda m: m.get("received_at") or "")
        return {"thread_id": thread_id, "messages": items}
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def list_labels(account: MailAccount, mailbox: str = "INBOX") -> dict:
    """메일함에 정의된 키워드(라벨)와 서버의 새 키워드 허용 여부(PERMANENTFLAGS \\*)."""
    imap = await _connect(account)
    try:
        resp = await imap.select(_q(mailbox))
        labels: list[str] = []
        supported = False
        for line in resp.lines:
            t = _line_to_str(line)
            m = re.search(r"PERMANENTFLAGS \(([^)]*)\)", t)
            if m:
                supported = "\\*" in m.group(1)
                labels += threads.flags_to_labels(m.group(1))
                continue
            m = re.match(r"FLAGS \(([^)]*)\)", t.strip())
            if m:
                labels += threads.flags_to_labels(m.group(1))
        seen: list[str] = []
        for l in labels:
            if l not in seen:
                seen.append(l)
        return {"labels": seen, "supported": supported}
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def fetch_message(account: MailAccount, mailbox: str, uid: str) -> dict | None:
    """Fetch full message detail by UID."""
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return None
        fetch_resp = await imap.uid("fetch", uid, "(UID FLAGS BODY[])")
        if fetch_resp.result != "OK":
            return None

        # Parse: first bytes line has metadata, bytearray has body, ')' closes
        raw_data = b""
        flags = ""
        found_uid = None
        for line in fetch_resp.lines:
            line_str = _line_to_str(line)
            # Metadata line: N FETCH (UID xxx FLAGS (...) BODY[] {size})
            uid_match = re.search(r"UID (\d+)", line_str)
            flag_match = re.search(r"FLAGS \(([^)]*)\)", line_str)
            if uid_match:
                found_uid = uid_match.group(1)
            if flag_match:
                flags = flag_match.group(1)
            if isinstance(line, bytearray):
                raw_data += bytes(line)

        if not raw_data:
            return None

        msg = email.message_from_bytes(raw_data)
        text_body, html_body = _extract_body(msg)
        if html_body and "cid:" in html_body.lower():
            html_body = _rewrite_cid_images(html_body, _inline_cid_map(msg))
        attachments = _extract_attachments(msg)

        is_unread = "\\Seen" not in flags
        is_flagged = "\\Flagged" in flags

        msg_uid = found_uid or uid

        # Mark as read
        if is_unread:
            await imap.uid("store", uid, "+FLAGS", "(\\Seen)")

        # MDN: extract Disposition-Notification-To and $MDNSent flag
        dnt = msg.get("Disposition-Notification-To")
        if dnt:
            dnt = _decode_header(dnt).strip()
        mdn_sent = "$MDNSent" in flags

        return {
            "id": msg_uid,
            "thread_id": None,
            "mailbox_ids": [mailbox],
            "from_": _parse_address(msg.get("From")),
            "to": _parse_address(msg.get("To")),
            "cc": _parse_address(msg.get("Cc")),
            "bcc": _parse_address(msg.get("Bcc")),
            "reply_to": _parse_address(msg.get("Reply-To")),
            "subject": _decode_header(msg.get("Subject")),
            "text_body": text_body,
            "html_body": html_body,
            "preview": (text_body or "")[:200] if text_body else None,
            "received_at": _parse_date(msg.get("Date")),
            "is_unread": False,  # Just marked as read
            "is_flagged": is_flagged,
            "attachments": [
                {
                    "blob_id": f"{msg_uid}:{att['part_index']}",
                    "name": att["name"],
                    "type": att["type"],
                    "size": att["size"],
                }
                for att in attachments
            ],
            "in_reply_to": msg.get("In-Reply-To"),
            "references": msg.get("References"),
            "disposition_notification_to": dnt or None,
            "mdn_sent": mdn_sent,
        }
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def fetch_raw(account: MailAccount, mailbox: str, uid: str) -> bytes | None:
    """원본 바이트 그대로. 아카이브(.eml 저장)용이므로 플래그를 변경하지 않는다.

    fetch_message 는 읽음 처리까지 수행하므로 재사용할 수 없다. 백업으로 인해 읽지 않은
    메일이 읽음으로 변경되어서는 안 된다. BODY.PEEK[] 를 사용하는 이유이다.
    """
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return None
        resp = await imap.uid("fetch", uid, "(BODY.PEEK[])")
        if resp.result != "OK":
            return None
        raw = b""
        for line in resp.lines:
            if isinstance(line, bytearray):
                raw += bytes(line)
        return raw or None
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def fetch_raw_many(
    account: MailAccount, mailbox: str, uids: list[str]
) -> dict[str, bytes]:
    """여러 UID 의 원본을 단일 연결로 조회한다.

    fetch_raw 를 반복 호출하면 메일마다 접속·로그인·로그아웃을 반복하여
    수십 건만으로도 게이트웨이 타임아웃(504)이 발생한다.
    """
    if not uids:
        return {}
    out: dict[str, bytes] = {}
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return out
        for uid in uids:
            try:
                resp = await imap.uid("fetch", uid, "(BODY.PEEK[])")
                if resp.result != "OK":
                    continue
                raw = b""
                for line in resp.lines:
                    if isinstance(line, bytearray):
                        raw += bytes(line)
                if raw:
                    out[uid] = raw
            except Exception as e:
                logger.warning("fetch_raw_many uid=%s 실패: %s", uid, e)
    finally:
        try:
            await imap.logout()
        except Exception:
            pass
    return out


async def update_flags(
    account: MailAccount, mailbox: str, uid: str,
    add_flags: list[str] | None = None,
    remove_flags: list[str] | None = None,
) -> bool:
    """Update IMAP flags on a message."""
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return False
        if add_flags:
            flags_str = " ".join(add_flags)
            if not _ok(await imap.uid("store", uid, "+FLAGS", f"({flags_str})")):
                return False
        if remove_flags:
            flags_str = " ".join(remove_flags)
            if not _ok(await imap.uid("store", uid, "-FLAGS", f"({flags_str})")):
                return False
        return True
    except Exception:
        return False
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def delete_message(
    account: MailAccount, mailbox: str, uid: str, trash_mailbox: str | None = None
) -> dict:
    """Delete or move message to trash.

    휴지통으로의 복사가 실패하면(NO/BAD) 원본을 삭제하지 않고 ok=False 로 종료한다. 이전에는 복사 결과를 확인하지 않고
    즉시 삭제 표시 + EXPUNGE 를 수행하여, 휴지통 이름에 공백이 있거나 용량이 초과된 경우 메일이 영구 소실되었다.
    """
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return {"ok": False, "permanent": False}

        permanent = not (trash_mailbox and mailbox.lower() != trash_mailbox.lower())
        if not permanent:
            # Move to trash
            if not _ok(await imap.uid("copy", uid, _q(trash_mailbox))):
                logger.warning("IMAP COPY → 휴지통 실패 — 원본을 지우지 않는다 (uid=%s)", uid)
                return {"ok": False, "permanent": False}

        if not _ok(await imap.uid("store", uid, "+FLAGS", "(\\Deleted)")):
            return {"ok": False, "permanent": False}
        await _expunge_uid(imap, uid)
        return {"ok": True, "permanent": permanent}
    except Exception as e:
        logger.warning("IMAP delete_message 실패: %s", e)
        return {"ok": False, "permanent": False}
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def move_message(
    account: MailAccount, mailbox: str, uid: str, target_mailbox: str
) -> bool:
    """Move message to another mailbox.

    복사가 성공(OK)한 경우에만 원본을 삭제한다. 대상 폴더가 없거나 이름이 손상되었거나 용량이 초과되면 False — 원본은 유지.
    """
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return False
        if not _ok(await imap.uid("copy", uid, _q(target_mailbox))):
            logger.warning("IMAP COPY 실패 — 원본을 지우지 않는다 (uid=%s)", uid)
            return False
        if not _ok(await imap.uid("store", uid, "+FLAGS", "(\\Deleted)")):
            return False
        await _expunge_uid(imap, uid)
        return True
    except Exception:
        return False
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def download_attachment(
    account: MailAccount, mailbox: str, uid: str, part_index: int
) -> tuple[bytes, str, str] | None:
    """Download attachment by part index. Returns (data, content_type, filename)."""
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return None
        fetch_resp = await imap.uid("fetch", uid, "(BODY[])")
        if fetch_resp.result != "OK":
            return None

        raw_data = b""
        for line in fetch_resp.lines:
            if isinstance(line, bytearray):
                raw_data += bytes(line)

        if not raw_data:
            return None

        msg = email.message_from_bytes(raw_data)
        for i, part in enumerate(msg.walk()):
            if i == part_index:
                data = part.get_payload(decode=True)
                ct = part.get_content_type()
                filename = _decode_header(part.get_filename() or f"attachment_{i}")
                return data or b"", ct, filename

        return None
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def create_mailbox(account: MailAccount, name: str) -> bool:
    """Create a new IMAP mailbox."""
    imap = await _connect(account)
    try:
        resp = await imap.create(_q(_imap_utf7_encode(name)))
        return resp.result == "OK"
    except Exception:
        return False
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def rename_mailbox(account: MailAccount, old_name: str, new_name: str) -> bool:
    """Rename an IMAP mailbox."""
    imap = await _connect(account)
    try:
        # old_name 은 목록의 id(이미 인코드된 원본), new_name 은 사용자 입력 이름
        resp = await imap.rename(_q(old_name), _q(_imap_utf7_encode(new_name)))
        return resp.result == "OK"
    except Exception:
        return False
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def delete_mailbox(account: MailAccount, name: str) -> bool:
    """Delete an IMAP mailbox."""
    imap = await _connect(account)
    try:
        resp = await imap.delete(_q(name))
        return resp.result == "OK"
    except Exception:
        return False
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def fetch_raw_headers(account: MailAccount, mailbox: str, uid: str) -> str | None:
    """Fetch raw RFC headers for a message by UID."""
    imap = await _connect(account)
    try:
        if not await _select(imap, mailbox):
            return None
        fetch_resp = await imap.uid("fetch", uid, "(BODY.PEEK[HEADER])")
        if fetch_resp.result != "OK":
            return None

        raw_data = b""
        for line in fetch_resp.lines:
            if isinstance(line, (bytes, bytearray)):
                raw_data += bytes(line)

        if not raw_data:
            return None

        return raw_data.decode("utf-8", errors="replace")
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def append_to_sent(account: MailAccount, raw_message: bytes) -> bool:
    """Append a sent message to the Sent mailbox."""
    imap = await _connect(account)
    try:
        # Find the Sent mailbox name (could be "Sent", localized, etc.)
        sent_name = "Sent"
        list_resp = await imap.list('""', "*")
        if list_resp.result == "OK":
            for line in list_resp.lines:
                if not line:
                    continue
                line_str = _line_to_str(line)
                if "\\Sent" in line_str:
                    match = re.match(
                        r'(?:\* LIST )?\(([^)]*)\) "([^"]*)" (.+)', line_str
                    )
                    if match:
                        sent_name = match.group(3).strip('"')
                    break

        resp = await imap.append(
            raw_message,
            mailbox=_q(sent_name),
            flags="(\\Seen)",
        )
        return resp.result == "OK"
    except Exception as e:
        logger.error("IMAP APPEND to Sent failed: %s", e)
        return False
    finally:
        try:
            await imap.logout()
        except Exception:
            pass


async def test_connection(account: MailAccount) -> tuple[bool, str]:
    """Test IMAP connection. Returns (success, message)."""
    try:
        imap = await _connect(account)
        await imap.logout()
        return True, "연결 성공"
    except access_guard.MailHostRejected:
        return False, access_guard.REJECT_MESSAGE
    except Exception as e:
        return False, str(e)
