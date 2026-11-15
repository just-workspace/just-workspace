"""내장 AI 답변의 진행 단계·출처 (S6a, "S6·S7 설계 확정", 시안 C1·C2).

- 진행 단계(SSE ``step``): ``{id, kind, label, status, detail, started_at, ended_at}``.
  kind = search|read|tool|write|think, status = running|done|failed. 같은 id 가 running → done/failed.
  한 번의 도구 묶음(모델이 한 차례에 부른 도구들) 안에서 같은 도구를 여러 번 부르면 한 단계로 묶는다
  ("파일 3개 읽기" — 시안 C1).
- 출처(SSE ``citation``): ``{n, kind, id, title, url, snippet, author?, date?}``.
  kind = mail|file|wiki|board|chat|event|web. url 은 앱 안 링크(웹은 원래 주소), 깊은 링크가 없으면 None.
  성공한 읽기 도구 결과에서만 만든다. 같은 자료는 같은 번호.

화면 문구는 한국어로 만든다(서버가 라벨을 만들어 보내는 계약 — 저장된 대화를 다시 열어도 같은 글이 보이게).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

MAX_CITATIONS = 20       # 답변 하나의 출처 상한
_SNIPPET = 240
_EVENTS_PER_CALL = 5     # 일정 목록 한 번에서 출처로 삼을 일정 수
_WEB_PER_CALL = 5


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def unwrap(result: Any) -> Any:
    """신뢰 경계 래퍼({untrusted, source, data})를 벗긴다."""
    if isinstance(result, dict) and result.get("untrusted") is True and "data" in result:
        return result.get("data")
    return result


def _short(v: Any, n: int = 40) -> str:
    s = " ".join(str(v or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _snippet(v: Any) -> str:
    return _short(v, _SNIPPET)


def _base(path: str) -> str:
    return os.path.basename(str(path or "").rstrip("/")) or str(path or "")


# ── 단계 종류·라벨 ────────────────────────────────────────────
def step_kind(name: str, *, is_write: bool = False) -> str:
    if is_write:
        return "write"
    if "search" in name:
        return "search"
    if any(k in name for k in ("read", "list", "stat", "recent", "context", "status")):
        return "read"
    return "tool"


def _q(args: dict) -> str:
    return _short((args or {}).get("query"), 30)


# 단건 라벨
def _label_one(name: str, a: dict, title: str | None) -> str:
    q = _q(a)
    m = {
        "mail_search": (f"메일 검색 “{q}”" if q else "최근 메일 보기"),
        "mail_read": "메일 읽기",
        "mail_read_attachment": "메일 첨부 읽기",
        "files_search": (f"파일 검색 “{q}”" if q else "파일 검색"),
        "files_read": f"파일 읽기 — {_short(_base(a.get('path', '')), 40)}" if a.get("path") else "파일 읽기",
        "files_list": f"폴더 보기 — {_short(a.get('path') or '내 파일', 40)}",
        "files_stat": f"파일 {len(a.get('paths') or [])}개 정보 확인" if a.get("paths") else "파일 정보 확인",
        "files_recent": "최근 파일 보기",
        "notes_search": (f"위키 검색 “{q}”" if q else "위키 검색"),
        "notes_read": "위키 읽기",
        "notes_list": "위키 목록 보기",
        "board_search": (f"게시판 검색 “{q}”" if q else "게시판 검색"),
        "board_list_posts": "게시글 목록 보기",
        "board_read_post": "게시글 읽기",
        "chat_list_channels": "채팅방 목록 보기",
        "chat_read_messages": "채팅 읽기",
        "calendar_list_events": "일정 보기",
        "calendar_list_calendars": "캘린더 목록 보기",
        "contacts_search": (f"연락처 검색 “{q}”" if q else "연락처 보기"),
        "tasks_list": "할 일 보기",
        "web_search": (f"웹 검색 “{q}”" if q else "웹 검색"),
        "workspace_context": "워크스페이스 정보 확인",
        "approvals_status": "승인 상태 확인",
    }
    if name in m:
        return m[name]
    return f"{title or name} 요청" if title else name


_PLURAL = {
    "files_read": "파일 {n}개 읽기",
    "mail_read": "메일 {n}통 읽기",
    "mail_read_attachment": "메일 첨부 {n}개 읽기",
    "notes_read": "위키 {n}개 읽기",
    "board_read_post": "게시글 {n}개 읽기",
    "chat_read_messages": "채팅방 {n}곳 읽기",
    "mail_search": "메일 검색 {n}번",
    "files_search": "파일 검색 {n}번",
    "notes_search": "위키 검색 {n}번",
    "board_search": "게시판 검색 {n}번",
    "web_search": "웹 검색 {n}번",
}


def step_label(name: str, calls: list[dict], title: str | None = None) -> str:
    calls = calls or [{}]
    if len(calls) == 1:
        return _label_one(name, calls[0], title)
    tpl = _PLURAL.get(name)
    if tpl:
        return tpl.format(n=len(calls))
    return f"{_label_one(name, calls[0], title)} 외 {len(calls) - 1}건"


# ── 단계 결과 요약 ────────────────────────────────────────────
_LIST_KEYS = ("messages", "results", "events", "tasks", "contacts", "posts", "channels", "pages", "items",
              "spaces", "calendars", "entries")


def _count(data: Any) -> int | None:
    if not isinstance(data, dict):
        return None
    if isinstance(data.get("returned"), int):
        return data["returned"]
    for k in _LIST_KEYS:
        if isinstance(data.get(k), list):
            return len(data[k])
    if isinstance(data.get("count"), int):
        return data["count"]
    return None


def _mmdd(v: Any) -> str | None:
    try:
        s = str(v or "")
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d.strftime("%m-%d")
    except Exception:  # noqa: BLE001
        return None


def _one_detail(name: str, args: dict, data: Any) -> str:
    n = _count(data)
    if name == "mail_search":
        box = (data or {}).get("mailbox") if isinstance(data, dict) else None
        where = "받은 메일" if (not box or str(box).upper() == "INBOX") else str(box)
        out = f"{where} {n or 0}건"
        days = sorted(filter(None, (_mmdd(m.get("received_at")) for m in (data or {}).get("messages") or []
                                    if isinstance(m, dict))))
        if days:
            out += f" · {days[0]}" + (f" ~ {days[-1]}" if days[-1] != days[0] else "")
        return out
    if name in ("mail_read", "mail_read_attachment"):
        return _short((data or {}).get("subject") or (data or {}).get("name") or "", 60)
    if name == "files_read":
        return _base((data or {}).get("path") or args.get("path") or "")
    if name in ("notes_read", "board_read_post"):
        return _short((data or {}).get("title") or "", 60)
    if name == "chat_read_messages":
        return f"메시지 {n or 0}개"
    if name == "calendar_list_events":
        return f"일정 {n or 0}개"
    if name == "tasks_list":
        return f"할 일 {n or 0}개"
    if isinstance(data, dict) and data.get("status") in _STATUS_LABELS:
        return _STATUS_LABELS[data["status"]]
    if n is not None:
        return f"{n}건"
    return ""


_STATUS_LABELS = {
    "pending_confirmation": "확인 대기 — 아래 카드에서 실행",
    "pending_approval": "승인 대기함으로 보냄",
    "executed": "실행됨",
    "canceled": "취소함",
    "rejected": "거절함",
    "expired": "만료됨 — 실행 안 함",
    "undone": "되돌림",
    "failed": "실패",
}
# 선승인 — 카드 결정을 기다리는 동안 단계에 보이는 말
WAITING_DETAIL = "승인 대기 — 아래 카드에서 실행하거나 취소하세요"


def status_label(status: str) -> str:
    return _STATUS_LABELS.get(status, status)


def step_outcome(name: str, outcomes: list[tuple[dict, dict]]) -> tuple[str, str]:
    """(status, detail). outcomes = [(args, execute 결과)]. 전부 실패면 failed, 하나라도 되면 done."""
    oks = [(a, r) for a, r in outcomes if r.get("ok") or r.get("needs_confirmation")]
    fails = [(a, r) for a, r in outcomes if not (r.get("ok") or r.get("needs_confirmation"))]
    if not oks:
        err = str((fails[0][1].get("error") if fails else "") or "실패")
        return "failed", _short(err, 160)
    if len(oks) == 1:
        a, r = oks[0]
        detail = _one_detail(name, a, unwrap(r.get("result")))
    elif name in ("files_read", "mail_read", "notes_read", "board_read_post", "mail_read_attachment"):
        first = _one_detail(name, oks[0][0], unwrap(oks[0][1].get("result")))
        detail = f"{first} 외 {len(oks) - 1}개" if first else f"{len(oks)}개"
    else:
        total = sum((_count(unwrap(r.get("result"))) or 0) for _a, r in oks)
        detail = f"{total}건"
    if fails:
        detail = (detail + " · " if detail else "") + f"{len(fails)}개 실패"
    return "done", detail


# ── 출처 ─────────────────────────────────────────────────────
def _mail_url(mid: Any, mailbox: Any) -> str | None:
    if not mid:
        return None
    return f"/mail/{quote(str(mid), safe='')}?mailbox={quote(str(mailbox or 'INBOX'), safe='')}"


def _parent(path: str) -> str:
    p = str(path or "").strip("/")
    return p.rsplit("/", 1)[0] if "/" in p else p


def citations_for(name: str, args: dict, result: Any) -> list[dict]:
    """성공한 읽기 도구 결과 → 출처 후보(번호 없음)."""
    d = unwrap(result)
    if not isinstance(d, dict):
        return []
    args = args or {}
    out: list[dict] = []
    if name == "mail_read":
        frm = d.get("from") or []
        out.append({"kind": "mail", "id": str(d.get("id") or args.get("message_id") or ""),
                    "title": d.get("subject") or "(제목 없음)",
                    "url": _mail_url(d.get("id") or args.get("message_id"), d.get("mailbox") or args.get("mailbox")),
                    "snippet": _snippet(d.get("body")), "author": (frm[0] if frm else None),
                    "date": d.get("received_at")})
    elif name == "mail_read_attachment":
        mid = d.get("message_id") or args.get("message_id")
        out.append({"kind": "mail", "id": f"{mid}#{d.get('attachment_id') or args.get('attachment_id')}",
                    "title": d.get("name") or "첨부", "url": _mail_url(mid, args.get("mailbox")),
                    "snippet": _snippet(d.get("content"))})
    elif name == "files_read":
        path = d.get("path") or args.get("path") or ""
        if path:
            out.append({"kind": "file", "id": path, "title": _base(path),
                        "url": f"/files?path={quote(_parent(path), safe='/')}" if _parent(path) else "/files",
                        "snippet": _snippet(d.get("content"))})
    elif name == "notes_read":
        pid, sid = d.get("id") or args.get("page_id"), d.get("space_id")
        if pid:
            out.append({"kind": "wiki", "id": str(pid), "title": d.get("title") or "위키 문서",
                        "url": (f"/wiki?space={quote(str(sid), safe='')}&page={quote(str(pid), safe='')}" if sid else None),
                        "snippet": _snippet(d.get("content")), "author": d.get("author"),
                        "date": d.get("updated_at") or None})
    elif name == "board_read_post":
        pid, bid = d.get("id") or args.get("post_id"), d.get("board_id")
        if pid:
            out.append({"kind": "board", "id": str(pid), "title": d.get("title") or "게시글",
                        "url": (f"/board/{quote(str(bid), safe='')}/{quote(str(pid), safe='')}" if bid else None),
                        "snippet": _snippet(d.get("content")), "author": d.get("author"),
                        "date": d.get("created_at")})
    elif name == "chat_read_messages":
        cid = d.get("channel_id") or args.get("channel_id")
        msgs = [m for m in (d.get("messages") or []) if isinstance(m, dict)]
        if cid:
            last = msgs[-1] if msgs else {}
            out.append({"kind": "chat", "id": str(cid), "title": d.get("channel_name") or "채팅 메시지",
                        "url": f"/chat?channel={quote(str(cid), safe='')}",
                        "snippet": _snippet(last.get("content")), "author": last.get("sender"),
                        "date": last.get("created_at")})
    elif name == "calendar_list_events":
        for e in (d.get("events") or [])[:_EVENTS_PER_CALL]:
            if isinstance(e, dict) and e.get("id"):
                out.append({"kind": "event", "id": str(e["id"]), "title": e.get("title") or "일정",
                            "url": f"/calendar?event={quote(str(e['id']), safe='')}",
                            "snippet": _snippet(" · ".join(filter(None, [str(e.get("location") or ""),
                                                                           str(e.get("description") or "")]))),
                            "date": e.get("start")})
    elif name == "web_fetch":
        u = str(d.get("final_url") or d.get("url") or "")
        if u.startswith(("http://", "https://")):
            out.append({"kind": "web", "id": u, "title": d.get("title") or u, "url": u,
                        "snippet": _snippet(d.get("description") or d.get("content"))})
    elif name == "web_search":
        for r in (d.get("results") or [])[:_WEB_PER_CALL]:
            u = str((r or {}).get("url") or "")
            if u.startswith(("http://", "https://")):
                out.append({"kind": "web", "id": u, "title": r.get("title") or u, "url": u,
                            "snippet": _snippet(r.get("snippet"))})
    for c in out:
        c["title"] = _short(c.get("title"), 120)
        for k in ("author", "date"):
            if not c.get(k):
                c.pop(k, None)
    return out


class CitationTracker:
    """답변 하나의 출처 번호표 — 같은 (kind, id) 는 같은 번호."""

    def __init__(self, existing: list[dict] | None = None):
        self.items: list[dict] = []
        self._by_key: dict[tuple, int] = {}
        for c in existing or []:
            if isinstance(c, dict) and isinstance(c.get("n"), int):
                self.items.append(c)
                self._by_key[(c.get("kind"), c.get("id"))] = c["n"]

    def add(self, c: dict) -> tuple[int | None, bool]:
        key = (c.get("kind"), c.get("id"))
        if key in self._by_key:
            return self._by_key[key], False
        if len(self.items) >= MAX_CITATIONS:
            return None, False
        n = len(self.items) + 1
        item = {"n": n, **c}
        self.items.append(item)
        self._by_key[key] = n
        return n, True

    def get(self, n: int) -> dict:
        return self.items[n - 1]
