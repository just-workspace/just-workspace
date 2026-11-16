"""채팅 링크 미리보기.

메시지 본문의 **첫 외부 링크 하나**를 서버가 대신 조회하여 OG/meta 카드(사이트 · 제목 · 설명 · 썸네일)를 생성한다.

흐름
  메시지 생성/수정 → schedule_for_message() 가 백그라운드 작업을 기동한다(전송 응답을 지연시키지 않는다)
  → 캐시(link_preview_cache)에 있으면 그대로 사용, 없으면 safe_get() 으로 수신하여 파싱
  → 썸네일은 서버가 수신·축소·재인코딩하여 link_preview_images 에 저장한다
    (수신 측 브라우저가 외부로 직접 요청하지 않도록 함 — /api/chat/link-preview/images/{id})
  → messages.link_preview 에 저장 + 채널에 실시간 이벤트 `link_preview` {message_id, channel_id, parent_id, link_preview}
  수신 실패 시 카드 없이 링크만 표시한다(이벤트도 없음).

SSRF 방어(서버가 사용자를 대신해 외부에 접속하는 동작이므로)
  · http/https 만 허용, 아이디·비밀번호가 포함된 주소 거부, 포트는 80·443·8080·8443 만 허용
  · 호스트를 직접 해석하여 **모든** 주소가 인터넷 공인이어야 한다 — 사설·루프백·링크 로컬(169.254.169.254 메타데이터 포함)·
    CGNAT·벤치마크·예약·멀티캐스트·미지정 거부, IPv6 에 내장된 IPv4(::ffff: · 6to4 · Teredo · NAT64)는 내부 주소로 판정
  · 검사한 해당 IP 로 직접 접속(Host 헤더·TLS SNI·인증서 검증은 원래 이름) — 검사와 접속 사이 DNS 리바인딩 차단
  · 리다이렉트는 3회까지, 매회 동일한 검사를 처음부터 재수행
  · 응답 1MB · 전체 5초 제한, 프록시 환경변수 무시(trust_env=False)
  · 워크스페이스 자체 주소(설정 domain·app_url 호스트와 그 하위)는 미리보기를 생성하지 않는다 — 내부 링크는 기존 파일 카드·멘션 칩
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import ipaddress
import json
import logging
import re
import socket
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Awaitable, Callable
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

MAX_BYTES = 1024 * 1024          # 페이지·이미지 각각 1MB
TOTAL_TIMEOUT = 5.0              # 1회 수신(리다이렉트 포함) 전체 5초
MAX_REDIRECTS = 3
MAX_URL_LEN = 2000
ALLOWED_PORTS = {80, 443, 8080, 8443}
OK_TTL = timedelta(hours=24)
FAIL_TTL = timedelta(hours=1)
THUMB_MAX = 448                  # 카드 썸네일 112px 의 4배(고해상도 화면)까지 허용
MAX_IMAGE_PIXELS = 40_000_000    # 압축 폭탄 방지 — 이보다 큰 이미지는 열지 않음
TITLE_MAX = 300
DESC_MAX = 500
SITE_MAX = 100
USER_AGENT = "Mozilla/5.0 (compatible; JustWorkspace-LinkPreview/1.0)"
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


class PreviewError(Exception):
    """수신 실패. code: invalid_url · scheme · port · blocked · dns · timeout · too_large · network · status · not_html"""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code


# ── 주소 검사 ──

_BLOCKED_NETS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    "::/128", "::1/128", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8", "100::/64", "2001:db8::/32",
)]
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_NAT64_LOCAL = ipaddress.ip_network("64:ff9b:1::/48")


def ip_allowed(ip: str) -> bool:
    """인터넷 공인 주소만 True. IPv6 에 내장된 IPv4 는 내부 IPv4 로 판정한다."""
    try:
        addr = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address):
        if addr in _NAT64_LOCAL:
            return False
        inner = addr.ipv4_mapped or addr.sixtofour or (addr.teredo[1] if addr.teredo else None)
        if inner is None and addr in _NAT64:
            inner = ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)
        if inner is None and int(addr) >> 32 == 0:      # ::a.b.c.d (IPv4 호환, 폐기된 형식)
            inner = ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)
        if inner is not None:
            addr = inner
    if any(addr in n for n in _BLOCKED_NETS if n.version == addr.version):
        return False
    if (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast
            or addr.is_reserved or addr.is_unspecified):
        return False
    return addr.is_global


def normalize_url(raw: str) -> str:
    """수신용 주소로 정규화. 규칙 위반 시 PreviewError."""
    url = (raw or "").strip()
    if not url or len(url) > MAX_URL_LEN:
        raise PreviewError("invalid_url")
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https"):
        raise PreviewError("scheme")
    if not parts.hostname:
        raise PreviewError("invalid_url")
    if parts.username or parts.password or "@" in parts.netloc:
        raise PreviewError("invalid_url")
    try:
        port = parts.port
    except ValueError:
        raise PreviewError("invalid_url")
    if port is not None and port not in ALLOWED_PORTS:
        raise PreviewError("port")
    scheme = parts.scheme.lower()
    host = parts.hostname.lower().rstrip(".")
    if not host:
        raise PreviewError("invalid_url")
    host_part = f"[{host}]" if ":" in host else host
    netloc = f"{host_part}:{port}" if port is not None else host_part
    return urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))


Resolver = Callable[[str, int], Awaitable[list[str]]]


async def system_resolve(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(i[4][0] for i in infos))


async def resolve_public(host: str, port: int, resolver: Resolver | None = None) -> str:
    """호스트를 해석하여 접속할 IP 하나를 반환한다. 해석된 주소 중 하나라도 공인이 아니면 거부(혼합 응답을 이용한 리바인딩 수법 차단)."""
    try:
        ipaddress.ip_address(host)
        ips = [host]
    except ValueError:
        try:
            ips = await (resolver or system_resolve)(host, port)
        except (socket.gaierror, OSError, UnicodeError):
            raise PreviewError("dns")
    if not ips:
        raise PreviewError("dns")
    if not all(ip_allowed(ip) for ip in ips):
        raise PreviewError("blocked")
    return ips[0]


# ── 수신 ──


@dataclass
class Fetched:
    url: str           # 리다이렉트 이후 최종 주소
    content_type: str  # 소문자, 매개변수 제외
    charset: str | None
    body: bytes


async def _get_once(client: httpx.AsyncClient, url: str, accept: str,
                    resolver: Resolver | None) -> tuple[int, httpx.Headers, bytes]:
    parts = urlsplit(url)
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    ip = await resolve_public(host, port, resolver)
    ip_host = f"[{ip}]" if ":" in ip else ip
    netloc = f"{ip_host}:{parts.port}" if parts.port else ip_host
    pinned = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
    req = client.build_request(
        "GET", pinned,
        headers={"Host": parts.netloc, "Accept": accept, "User-Agent": USER_AGENT,
                 "Accept-Language": "ko,en;q=0.8"},
        # TLS 는 원래 이름으로 수행(SNI·인증서 검증) — 해석해 둔 IP 로 접속해도 인증서는 호스트 이름과 대조
        extensions={"sni_hostname": host} if parts.scheme == "https" else {},
    )
    resp = await client.send(req, stream=True)
    try:
        if resp.status_code != 200:
            return resp.status_code, resp.headers, b""
        declared = resp.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BYTES:
            raise PreviewError("too_large")
        buf = bytearray()
        # aiter_bytes 는 압축 해제된 바이트를 반환 — 해제 후 크기로 측정하므로 압축 폭탄도 1MB 에서 중단
        async for chunk in resp.aiter_bytes():
            buf.extend(chunk)
            if len(buf) > MAX_BYTES:
                raise PreviewError("too_large")
        return 200, resp.headers, bytes(buf)
    finally:
        await resp.aclose()


async def safe_get(raw_url: str, *, accept: str = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
                   transport: httpx.AsyncBaseTransport | None = None,
                   resolver: Resolver | None = None,
                   timeout: float | None = None) -> Fetched:
    """SSRF 를 차단하며 주소 하나를 수신한다(리다이렉트마다 재검사, 1MB·5초). 실패 시 PreviewError."""
    url = normalize_url(raw_url)
    total = timeout if timeout is not None else TOTAL_TIMEOUT

    async def run() -> Fetched:
        nonlocal url
        async with httpx.AsyncClient(timeout=httpx.Timeout(total), follow_redirects=False,
                                     transport=transport, trust_env=False) as client:
            for _ in range(MAX_REDIRECTS + 1):
                status, headers, body = await _get_once(client, url, accept, resolver)
                if status in (301, 302, 303, 307, 308):
                    loc = headers.get("location")
                    if not loc:
                        raise PreviewError("status")
                    url = normalize_url(urljoin(url, loc))
                    continue
                if status != 200:
                    raise PreviewError("status", str(status))
                ctype = headers.get("content-type", "")
                main = ctype.split(";", 1)[0].strip().lower()
                m = re.search(r"charset=([\w\-]+)", ctype, re.I)
                return Fetched(url=url, content_type=main, charset=m.group(1) if m else None, body=body)
            raise PreviewError("network", "리다이렉트가 너무 많습니다")

    try:
        return await asyncio.wait_for(run(), timeout=total)
    except PreviewError:
        raise
    except (asyncio.TimeoutError, httpx.TimeoutException):
        raise PreviewError("timeout")
    except httpx.HTTPError as e:
        raise PreviewError("network", type(e).__name__)


# ── HTML 에서 OG/meta 추출 ──


class _MetaParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag, attrs):
        if self.done:
            return
        a = {k.lower(): (v or "") for k, v in attrs if k}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").strip().lower()
            content = a.get("content", "").strip()
            if key and content and key not in self.meta:
                self.meta[key] = content
        elif tag == "title":
            self._in_title = True
        elif tag == "body":
            self.done = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data):
        if self._in_title and not self.done and len(self.title) < 1000:
            self.title += data


def _clean(s: str | None, limit: int) -> str | None:
    if not s:
        return None
    s = " ".join(s.split())
    return s[:limit] if s else None


def _decode_html(f: Fetched) -> str:
    charset = f.charset
    if not charset:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w\-]+)", f.body[:4096], re.I)
        if m:
            charset = m.group(1).decode("ascii", "ignore")
    try:
        return f.body.decode(charset or "utf-8", errors="replace")
    except LookupError:
        return f.body.decode("utf-8", errors="replace")


def parse_meta(html: str, base_url: str) -> dict | None:
    """OG/트위터/기본 meta 에서 카드 값을 추출한다. 제목이 없으면 None(카드를 생성하지 않는다)."""
    p = _MetaParser()
    try:
        p.feed(html)
    except Exception:
        pass
    m = p.meta
    title = _clean(m.get("og:title") or m.get("twitter:title") or p.title, TITLE_MAX)
    if not title:
        return None
    desc = _clean(m.get("og:description") or m.get("twitter:description") or m.get("description"), DESC_MAX)
    host = urlsplit(base_url).hostname or ""
    site = _clean(m.get("og:site_name"), SITE_MAX) or (host[4:] if host.startswith("www.") else host)
    image = None
    raw_img = m.get("og:image:secure_url") or m.get("og:image") or m.get("og:image:url") or m.get("twitter:image")
    if raw_img:
        try:
            cand = urljoin(base_url, raw_img.strip())
            if urlsplit(cand).scheme in ("http", "https"):
                image = cand
        except ValueError:
            image = None
    return {"site": site, "title": title, "description": desc, "image_src": image}


# ── 썸네일 ──


def _sniff(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def make_thumbnail(data: bytes) -> tuple[bytes, str] | None:
    """원본을 축소하여 재인코딩(JPEG 또는 투명이면 PNG). SVG·미지원 형식·과대 이미지는 None."""
    if _sniff(data) is None:
        return None
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
            if w <= 0 or h <= 0 or w * h > MAX_IMAGE_PIXELS:
                return None
            im.seek(0)
            im.draft("RGB", (THUMB_MAX, THUMB_MAX))
            im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
            im.thumbnail((THUMB_MAX, THUMB_MAX))
            out = io.BytesIO()
            if im.mode == "RGBA" and im.getextrema()[3][0] < 255:
                im.save(out, "PNG", optimize=True)
                return out.getvalue(), "image/png"
            im.convert("RGB").save(out, "JPEG", quality=82, optimize=True)
            return out.getvalue(), "image/jpeg"
    except Exception:
        return None


# ── 메시지 본문에서 링크 선택 ──

_URL_RE = re.compile(r"https?://[^\s<>\"'`]+", re.I)
_CODE_BLOCK = re.compile(r"```.*?```", re.S)
_CODE_SPAN = re.compile(r"`[^`\n]*`")


def _internal_hosts() -> set[str]:
    s = get_settings()
    hosts = {(s.domain or "").lower()}
    try:
        hosts.add((urlsplit(s.app_url).hostname or "").lower())
    except ValueError:
        pass
    return {h for h in hosts if h and h != "localhost"}


def is_internal(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in _internal_hosts())


def first_external_url(content: str | None) -> str | None:
    """본문(마크다운)의 첫 외부 링크. 코드 안 링크·워크스페이스 내부 링크는 건너뛴다."""
    if not content:
        return None
    text = _CODE_SPAN.sub(" ", _CODE_BLOCK.sub(" ", content))
    for m in _URL_RE.finditer(text):
        url = m.group(0)
        # 문장 끝 구두점·마크다운 링크의 닫는 괄호 제거
        while url and url[-1] in ".,!?;:'\"]>":
            url = url[:-1]
        while url.endswith(")") and url.count(")") > url.count("("):
            url = url[:-1]
        try:
            norm = normalize_url(url)
        except PreviewError:
            continue
        if is_internal(norm):
            continue
        return norm
    return None


def url_hash(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def image_path(image_id: str) -> str:
    return f"/api/chat/link-preview/images/{image_id}"


# ── 저장 형식 ──


def public_preview(raw: str | None) -> dict | None:
    """messages.link_preview → API 로 반환할 카드. 삭제된 것·형식이 잘못된 것은 None."""
    if not raw:
        return None
    try:
        d = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(d, dict) or d.get("dismissed") or not d.get("title") or not d.get("url"):
        return None
    return {
        "url": d["url"], "site": d.get("site"), "title": d["title"],
        "description": d.get("description"), "image": d.get("image"),
    }


def stored_url(raw: str | None) -> str | None:
    try:
        d = json.loads(raw) if raw else None
    except ValueError:
        return None
    return d.get("url") if isinstance(d, dict) else None


def is_dismissed(raw: str | None) -> bool:
    try:
        d = json.loads(raw) if raw else None
    except ValueError:
        return False
    return isinstance(d, dict) and bool(d.get("dismissed"))


# ── 생성(캐시 → 수신 → 파싱 → 썸네일) ──

_sem = asyncio.Semaphore(4)
_inflight: dict[str, asyncio.Future] = {}
_tasks: set[asyncio.Task] = set()


def _session_factory():
    from app.db.session import async_session
    return async_session


async def build_preview(url: str, session_factory=None, *, transport=None, resolver=None) -> dict | None:
    """주소 하나의 카드(캐시 우선). 생성 실패 시 None."""
    from app.db.models import LinkPreviewCache, LinkPreviewImage
    factory = session_factory or _session_factory()
    key = url_hash(url)
    now = datetime.now(timezone.utc)

    async with factory() as db:
        row = await db.get(LinkPreviewCache, key)
        if row is not None:
            at = row.fetched_at if row.fetched_at.tzinfo else row.fetched_at.replace(tzinfo=timezone.utc)
            fresh = now - at < (OK_TTL if row.data else FAIL_TTL)
            if fresh:
                return json.loads(row.data) if row.data else None

    data: dict | None = None
    try:
        async with _sem:
            page = await safe_get(url, transport=transport, resolver=resolver)
        if page.content_type not in ("text/html", "application/xhtml+xml"):
            raise PreviewError("not_html")
        meta = parse_meta(_decode_html(page), page.url)
        if meta:
            image = None
            src = meta.pop("image_src", None)
            if src:
                image = await _store_image(src, factory, LinkPreviewImage, transport=transport, resolver=resolver)
            data = {"url": url, **meta, "image": image}
    except PreviewError as e:
        logger.info("링크 미리보기 실패 %s: %s", urlsplit(url).hostname, e.code)
    except Exception as e:  # 파싱 등 예기치 못한 오류 — 카드 없이 링크만 표시
        logger.warning("링크 미리보기 오류 %s: %s", urlsplit(url).hostname, e)

    async with factory() as db:
        row = await db.get(LinkPreviewCache, key)
        if row is None:
            row = LinkPreviewCache(url_hash=key, url=url)
            db.add(row)
        row.data = json.dumps(data, ensure_ascii=False) if data else None
        row.fetched_at = now
        await db.commit()
    return data


async def _store_image(src: str, factory, model, *, transport=None, resolver=None) -> str | None:
    iid = url_hash(src)
    async with factory() as db:
        if await db.get(model, iid) is not None:
            return image_path(iid)
    try:
        async with _sem:
            got = await safe_get(src, accept="image/png,image/jpeg,image/gif,image/webp;q=0.9",
                                 transport=transport, resolver=resolver)
    except PreviewError:
        return None
    thumb = await asyncio.to_thread(make_thumbnail, got.body)
    if thumb is None:
        return None
    body, ctype = thumb
    async with factory() as db:
        if await db.get(model, iid) is None:
            db.add(model(id=iid, content_type=ctype, data=body))
            await db.commit()
    return image_path(iid)


async def _shared_build(url: str, factory, **kw) -> dict | None:
    """동일 주소를 여러 메시지가 동시에 요청하면 1회만 수신한다(동일 워커 내)."""
    fut = _inflight.get(url)
    if fut is not None:
        return await asyncio.shield(fut)
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    _inflight[url] = fut
    try:
        res = await build_preview(url, factory, **kw)
        fut.set_result(res)
        return res
    except Exception as e:
        fut.set_result(None)
        logger.warning("링크 미리보기 작업 실패: %s", e)
        return None
    finally:
        _inflight.pop(url, None)


async def attach_to_message(message_id: str, url: str, session_factory=None, emit=None, **kw) -> dict | None:
    """카드를 생성하여 메시지에 저장하고 채널에 통지한다. 그 사이 본문이 변경되었거나 삭제되었으면 중단한다."""
    from app.db.models import Message
    factory = session_factory or _session_factory()
    preview = await _shared_build(url, factory, **kw)
    if not preview:
        return None
    async with factory() as db:
        msg = await db.get(Message, message_id)
        if msg is None or msg.is_deleted or first_external_url(msg.content) != url:
            return None
        if is_dismissed(msg.link_preview) and stored_url(msg.link_preview) == url:
            return None
        msg.link_preview = json.dumps(preview, ensure_ascii=False)
        await db.commit()
        channel_id, parent_id = msg.channel_id, msg.parent_id
    card = public_preview(json.dumps(preview))
    if emit is None:
        from app.realtime.events import emit_to_channel as emit
    try:
        await emit(channel_id, {
            "type": "link_preview", "message_id": message_id, "channel_id": channel_id,
            "parent_id": parent_id, "link_preview": card,
        })
    except Exception as e:
        logger.debug("link_preview 전달 실패: %s", e)
    return card


def schedule_for_message(msg: dict) -> asyncio.Task | None:
    """메시지 dict(_message_to_dict)를 확인하여 미리보기 작업을 기동한다. 텍스트 메시지만 대상."""
    try:
        if msg.get("message_type", "text") != "text" or msg.get("is_deleted"):
            return None
        url = first_external_url(msg.get("content"))
        if not url:
            return None
        task = asyncio.get_running_loop().create_task(attach_to_message(msg["id"], url))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
        return task
    except Exception as e:
        logger.debug("링크 미리보기 예약 실패: %s", e)
        return None
