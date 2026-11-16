"""메일 스레드·라벨·서명 보조 함수(순수 함수 — IMAP/POP3 클라이언트와 라우터가 공용으로 사용한다).

스레드
  - 서버가 IMAP THREAD=REFERENCES 를 지원하면 서버가 구성한 묶음 결과를 사용한다(제목 없는 답장·단절된
    References 도 서버가 묶는다). thread_id = "u<루트 UID>" (메일함 단위).
  - 미지원 시 헤더로 계산: References 의 첫 항목(대화의 최초 메일) → 없으면 In-Reply-To →
    없으면 자신의 Message-ID. thread_id = "h<루트 Message-ID 의 sha1 앞 16자>".
    동일 대화이면 어느 메일함에서 계산해도 값이 동일하다.

라벨
  IMAP 키워드(사용자 정의 플래그)로 저장한다. 키워드는 ASCII atom 이어야 하므로 한글 라벨은
  메일함 이름과 동일한 수정 UTF-7 로 인코딩하고, 공백은 '_' 로 치환한다.

서명 이중 부착
  웹 작성기는 발송 시 `<div class="signature"><p>--</p>…</div>` / "\\n\\n--\\n…" 를 부착한다.
  기존 초안 본문에 서명이 이미 포함된 경우 이어 쓰기 후 발송 시 서명이 2회 부착된다.
  → 발송 시 서명 블록이 둘 이상이면 마지막 하나만 유지하고, 초안 응답에는 서명을 제거한 본문을
    함께 반환한다(프런트가 이를 기준으로 이어 쓰면 중복이 발생하지 않는다).
"""

from __future__ import annotations

import base64
import hashlib
import html as _html
import re

_MSGID_RE = re.compile(r"<[^<>\s]+>")


def _ids(raw: str | None) -> list[str]:
    if not raw:
        return []
    found = _MSGID_RE.findall(str(raw))
    if found:
        return found
    s = str(raw).strip()
    return [s] if s else []


def thread_root(message_id: str | None, in_reply_to: str | None, references: str | None) -> str | None:
    refs = _ids(references)
    if refs:
        return refs[0]
    irt = _ids(in_reply_to)
    if irt:
        return irt[0]
    own = _ids(message_id)
    return own[0] if own else None


def header_thread_id(message_id: str | None, in_reply_to: str | None, references: str | None) -> str | None:
    root = thread_root(message_id, in_reply_to, references)
    if not root:
        return None
    return "h" + hashlib.sha1(root.strip().lower().encode("utf-8", "replace")).hexdigest()[:16]


# ─── IMAP THREAD 응답 파싱 ───


def parse_thread_response(text: str) -> list[list[str]]:
    """'THREAD (1 2)(3 (4)(5))' → [['1','2'], ['3','4','5']] (각 묶음의 첫 UID 가 루트)."""
    s = text
    i = s.upper().find("THREAD")
    if i >= 0:
        s = s[i + 6:]
    groups: list[list[str]] = []
    depth = 0
    cur: list[str] = []
    num = ""
    for ch in s:
        if ch.isdigit():
            num += ch
            continue
        if num:
            if depth > 0:
                cur.append(num)
            num = ""
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                if cur:
                    groups.append(cur)
                cur = []
    if num and depth > 0:
        cur.append(num)
    if cur:
        groups.append(cur)
    return groups


def thread_map(groups: list[list[str]]) -> dict[str, tuple[str, int]]:
    """UID → (thread_id, 묶음 크기)."""
    out: dict[str, tuple[str, int]] = {}
    for g in groups:
        tid = "u" + g[0]
        for uid in g:
            out[uid] = (tid, len(g))
    return out


# ─── 라벨 ↔ IMAP 키워드 ───

_SYSTEM_KEYWORDS = {
    "$mdnsent", "$forwarded", "$junk", "$notjunk", "nonjunk", "junk", "$phishing",
    "$submitpending", "$submitted", "$hasattachment", "$hasnoattachment", "$important",
    "$answered", "$label1", "$label2", "$label3", "$label4", "$label5", "$recent",
}


def _b64_imap(s: str) -> str:
    return base64.b64encode(s.encode("utf-16-be")).decode("ascii").rstrip("=").replace("/", ",")


def encode_keyword(label: str) -> str:
    """사용자가 지정한 라벨 → IMAP 키워드 atom (수정 UTF-7, 공백은 '_')."""
    label = (label or "").strip()
    out: list[str] = []
    buf = ""
    for ch in label:
        o = ord(ch)
        if 0x20 <= o <= 0x7E and ch not in '&(){%*"\\] ':
            if buf:
                out.append("&" + _b64_imap(buf) + "-")
                buf = ""
            out.append(ch)
        elif ch == "&":
            if buf:
                out.append("&" + _b64_imap(buf) + "-")
                buf = ""
            out.append("&-")
        elif ch == " ":
            if buf:
                out.append("&" + _b64_imap(buf) + "-")
                buf = ""
            out.append("_")
        else:
            buf += ch
    if buf:
        out.append("&" + _b64_imap(buf) + "-")
    return "".join(out)[:200]


def decode_keyword(kw: str) -> str:
    res: list[str] = []
    i = 0
    while i < len(kw):
        ch = kw[i]
        if ch == "&":
            j = kw.find("-", i)
            if j < 0:
                res.append(kw[i:])
                break
            chunk = kw[i + 1:j]
            if chunk == "":
                res.append("&")
            else:
                b = chunk.replace(",", "/")
                b += "=" * (-len(b) % 4)
                try:
                    res.append(base64.b64decode(b).decode("utf-16-be"))
                except Exception:
                    res.append(kw[i:j + 1])
            i = j + 1
        elif ch == "_":
            res.append(" ")
            i += 1
        else:
            res.append(ch)
            i += 1
    return "".join(res)


def flags_to_labels(flags: str) -> list[str]:
    """FETCH 의 FLAGS 문자열 → 사용자 라벨 목록(시스템 플래그·잘 알려진 키워드 제외)."""
    out: list[str] = []
    for f in (flags or "").split():
        if not f or f.startswith("\\"):
            continue
        if f.lower() in _SYSTEM_KEYWORDS:
            continue
        out.append(decode_keyword(f))
    return out


# ─── 서명 이중 부착 방지 ───

_SIG_OPEN_RE = re.compile(r"""<div\b[^>]*\bclass\s*=\s*["'][^"']*\bsignature\b[^"']*["'][^>]*>""", re.IGNORECASE)
_DIV_TAG_RE = re.compile(r"<(/?)div\b[^>]*>", re.IGNORECASE)


def _signature_spans(html: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    pos = 0
    while True:
        m = _SIG_OPEN_RE.search(html, pos)
        if not m:
            break
        depth = 1
        end = None
        for t in _DIV_TAG_RE.finditer(html, m.end()):
            depth += -1 if t.group(1) else 1
            if depth == 0:
                end = t.end()
                break
        if end is None:
            break
        spans.append((m.start(), end))
        pos = end
    return spans


def strip_signature_html(html: str | None) -> str | None:
    """`<div class="signature">…</div>` 블록을 모두 제거한다."""
    if not html:
        return html
    spans = _signature_spans(html)
    for s, e in reversed(spans):
        html = html[:s] + html[e:]
    return html


def dedupe_signature_html(html: str | None) -> str | None:
    """서명 블록이 둘 이상이면 마지막 하나만 유지한다(뒤쪽이 이번에 부착한 서명)."""
    if not html:
        return html
    spans = _signature_spans(html)
    if len(spans) < 2:
        return html
    for s, e in reversed(spans[:-1]):
        html = html[:s] + html[e:]
    return html


def html_to_text(html: str) -> str:
    t = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    t = re.sub(r"</p\s*>", "\n", t, flags=re.IGNORECASE)
    t = re.sub(r"<[^>]+>", "", t)
    return _html.unescape(t).strip()


def _sig_text_variants(signature_texts: list[str]) -> list[str]:
    return [s.strip() for s in signature_texts if s and s.strip()]


def strip_signature_text(text: str | None, signature_texts: list[str]) -> str | None:
    """'\\n--\\n<서명>' 형식으로 포함된 알려진 서명을 모두 제거한다."""
    if not text:
        return text
    for sig in _sig_text_variants(signature_texts):
        for delim in ("\n\n--\n", "\n-- \n", "\n--\n"):
            text = text.replace(delim + sig, "")
    return text


def dedupe_signature_text(text: str | None, signature_texts: list[str]) -> str | None:
    """동일 서명이 2회 이상 포함된 경우 마지막 것만 유지한다."""
    if not text:
        return text
    for sig in _sig_text_variants(signature_texts):
        for delim in ("\n\n--\n", "\n-- \n", "\n--\n"):
            block = delim + sig
            n = text.count(block)
            if n > 1:
                last = text.rfind(block)
                head = text[:last].replace(block, "")
                text = head + text[last:]
    return text


def has_signature(html: str | None, text: str | None, signature_texts: list[str]) -> bool:
    if html and _signature_spans(html):
        return True
    if text:
        for sig in _sig_text_variants(signature_texts):
            if ("--\n" + sig) in text or ("-- \n" + sig) in text:
                return True
    return False
