"""HTML → 본문 텍스트(경량 마크다운). 표준 라이브러리 html.parser 만 사용한다.

* script·style·svg·form 등 비본문은 제거하고, nav·footer·aside 와 바깥 header 등 틀 요소도 제외한다.
* <article>/<main> 이 있고 본문이 충분하면 그 내부만 사용한다.
* 제목(h1~h6)은 ``#``, 목록은 ``- ``, 코드 블록은 펜스, 표는 ``|`` 로 구분한다.
* 링크는 본문에 삽입하지 않고 별도로 수집한다(모델이 다음 페이지로 이동할 때 사용한다).
"""

from __future__ import annotations

import re
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin

_SKIP = {"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
         "form", "button", "select", "option", "textarea", "head", "math", "dialog"}
_CHROME = {"nav", "footer", "aside"}
_BLOCK = {"p", "div", "section", "article", "main", "header", "ul", "ol", "dl", "dt", "dd", "table",
          "tr", "blockquote", "figure", "figcaption", "address", "details", "summary", "hr", "br", "body"}
_VOID = {"br", "hr", "img", "meta", "link", "input", "source", "wbr", "area", "base", "col", "embed",
         "param", "track"}
_MAIN_MIN_CHARS = 200
MAX_LINKS = 60


class _Extractor(HTMLParser):
    def __init__(self, base_url: str = ""):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.title = ""
        self.description = ""
        self.all: list[str] = []
        self.main: list[str] = []
        self.links: list[dict] = []
        self._seen_links: set[str] = set()
        self._stack: list[str] = []
        self._skip = 0
        self._chrome = 0
        self._main_depth = 0
        self._pre = 0
        self._in_title = False
        self._link_href: str | None = None
        self._link_text: list[str] = []
        self._cell_open = False

    # ── 출력 ──
    def _emit(self, s: str) -> None:
        if self._skip or (self._chrome and not self._main_depth):
            return
        self.all.append(s)
        if self._main_depth:
            self.main.append(s)

    def _nl(self, n: int = 1) -> None:
        self._emit("\n" * n)

    # ── 파서 콜백 ──
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            name = (a.get("name") or a.get("property") or "").lower()
            if name in ("description", "og:description") and not self.description:
                self.description = (a.get("content") or "").strip()
            return
        if tag == "title":
            self._in_title = True
            return
        if tag in _VOID:
            if tag == "br":
                self._emit("\n")
            elif tag == "hr":
                self._nl(2)
            elif tag == "img" and a.get("alt") and not self._skip:
                alt = a["alt"].strip()
                if alt:
                    self._emit(f"[이미지: {alt}]")
            return
        self._stack.append(tag)
        if tag in _SKIP:
            self._skip += 1
            return
        if tag in _CHROME or (tag == "header" and not self._main_depth):
            self._chrome += 1
        if tag in ("main", "article"):
            self._main_depth += 1
        if tag == "pre":
            self._pre += 1
            self._nl(2)
            self._emit("```\n")
        elif re.fullmatch(r"h[1-6]", tag):
            self._nl(2)
            self._emit("#" * int(tag[1]) + " ")
        elif tag == "li":
            self._nl()
            depth = sum(1 for t in self._stack if t in ("ul", "ol")) - 1
            self._emit("  " * max(0, depth) + "- ")
        elif tag in ("td", "th"):
            self._emit(" | " if self._cell_open else "| ")
            self._cell_open = True
        elif tag == "tr":
            self._nl()
            self._cell_open = False
        elif tag == "blockquote":
            self._nl(2)
            self._emit("> ")
        elif tag in _BLOCK:
            self._nl(2 if tag in ("p", "table", "ul", "ol", "section", "article") else 1)
        if tag == "a":
            href = (a.get("href") or "").strip()
            if href and not href.startswith(("javascript:", "mailto:", "tel:", "#", "data:")):
                self._link_href = urljoin(self.base, href) if self.base else href
                self._link_text = []

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
            return
        if tag in _VOID:
            return
        # 짝이 맞지 않는 태그 허용: 스택에서 해당 태그까지 닫는다
        if tag not in self._stack:
            return
        while self._stack:
            t = self._stack.pop()
            self._close(t)
            if t == tag:
                break

    def _close(self, tag: str) -> None:
        if tag in _SKIP:
            self._skip = max(0, self._skip - 1)
            return
        if tag == "a" and self._link_href:
            text = re.sub(r"\s+", " ", "".join(self._link_text)).strip()
            href = self._link_href
            self._link_href = None
            if text and href not in self._seen_links and len(self.links) < MAX_LINKS \
                    and href.startswith(("http://", "https://")):
                self._seen_links.add(href)
                self.links.append({"text": text[:120], "url": href})
        if tag == "pre":
            self._pre = max(0, self._pre - 1)
            self._emit("\n```")
            self._nl(2)
        elif re.fullmatch(r"h[1-6]", tag):
            self._nl(2)
        elif tag == "tr":
            if self._cell_open:
                self._emit(" |")
            self._cell_open = False
        elif tag in _BLOCK or tag == "li":
            self._nl()
        if tag in ("main", "article"):
            self._main_depth = max(0, self._main_depth - 1)
        if tag in _CHROME or (tag == "header" and self._chrome and not self._main_depth):
            self._chrome = max(0, self._chrome - 1)

    def handle_data(self, data):
        if self._in_title:
            self.title += data
            return
        if self._skip:
            return
        if self._link_href is not None:
            self._link_text.append(data)
        if self._pre:
            self._emit(data)
        else:
            t = re.sub(r"\s+", " ", data)
            if t.strip() or (t == " "):
                self._emit(t)


def _tidy(parts: list[str]) -> str:
    text = "".join(parts)
    lines = []
    in_code = False
    for line in text.split("\n"):
        if line.strip().startswith("```"):
            in_code = not in_code
            lines.append(line.strip())
            continue
        lines.append(line.rstrip() if in_code else re.sub(r"[ \t]+", " ", line).strip())
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 내용 없는 머리 기호·표 줄 제거
    text = re.sub(r"(?m)^(-|#+|>|\|)\s*$\n?", "", text)
    return text.strip()


def html_to_text(html: str, base_url: str = "") -> dict:
    """{title, description, text, links}."""
    p = _Extractor(base_url)
    try:
        p.feed(html)
        p.close()
    except Exception:  # noqa: BLE001 — 손상된 HTML 은 파싱된 지점까지만 사용
        pass
    main = _tidy(p.main)
    text = main if len(main) >= _MAIN_MIN_CHARS else _tidy(p.all)
    return {
        "title": re.sub(r"\s+", " ", unescape(p.title)).strip()[:300],
        "description": p.description[:500],
        "text": text,
        "links": p.links,
    }


_META_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-]+)""", re.I)


def decode_body(body: bytes, charset: str | None) -> str:
    """응답 바이트 → 문자열. 헤더 charset → <meta charset> → utf-8 → cp949(한국 사이트) 순."""
    cands = []
    if charset:
        cands.append(charset)
    m = _META_CHARSET.search(body[:4096])
    if m:
        cands.append(m.group(1).decode("ascii", "ignore"))
    if body.startswith(b"\xef\xbb\xbf"):
        cands.insert(0, "utf-8-sig")
    cands += ["utf-8", "cp949"]
    for enc in cands:
        enc = {"euc-kr": "cp949", "ks_c_5601-1987": "cp949", "x-windows-949": "cp949"}.get(enc.lower(), enc)
        try:
            return body.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", "replace")
