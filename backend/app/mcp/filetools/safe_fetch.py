"""SSRF 방어 HTTP 가져오기 — web_fetch 전용.

막는 것:
  * http/https 외 스킴, URL 안 계정정보(user:pass@), 허용 밖 포트
  * 사설·루프백·링크로컬(클라우드 메타데이터 169.254.169.254 포함)·CGNAT·멀티캐스트·예약·문서용 대역,
    IPv6 ULA·사이트로컬, IPv4 매핑/6to4/Teredo 로 감싼 사설 주소
  * 이름 해석 결과 중 **하나라도** 막힌 주소면 거절(섞어 돌려주는 DNS 대응)
  * DNS 재바인딩: 검사한 주소로 **직접** 접속한다(Host 헤더·TLS SNI 는 원래 이름 — 인증서 검증도 원래 이름)
  * 리다이렉트는 자동으로 따르지 않고, 매 hop 마다 위 검사를 다시 한다(최대 5번)
  * 크기(압축 푼 뒤 바이트)·전체 시간 상한, 환경 프록시 무시(trust_env=False)
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

ALLOWED_PORTS = frozenset({80, 443, 8080, 8443})
MAX_REDIRECTS = 5
DEFAULT_TIMEOUT = 20.0
USER_AGENT = "Mozilla/5.0 (compatible; JustWorkspace-WebFetch/1.0; +AI assistant page reader)"

# ipaddress 의 is_global 이 놓치는(또는 버전마다 다른) 대역을 명시로 더 막는다
_EXTRA_BLOCKED = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
    "::/128", "::1/128", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32",
    "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
)]
_BLOCKED_NAMES = ("localhost", "localhost.localdomain", "metadata", "metadata.google.internal")
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa")


class FetchError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass
class FetchResult:
    url: str
    final_url: str
    status: int
    content_type: str
    charset: str | None
    body: bytes
    body_truncated: bool
    redirects: list[str] = field(default_factory=list)


def blocked_reason(ip_text: str) -> str | None:
    """주소가 막혀야 하면 이유, 괜찮으면 None."""
    try:
        ip = ipaddress.ip_address(ip_text.split("%", 1)[0])
    except ValueError:
        return "주소 형식이 아닙니다"
    if isinstance(ip, ipaddress.IPv6Address):
        inner = ip.ipv4_mapped or ip.sixtofour or (ip.teredo[1] if ip.teredo else None)
        if ip.teredo:
            return "Teredo 주소는 허용하지 않습니다"
        if inner is not None:
            r = blocked_reason(str(inner))
            if r:
                return r
    for net in _EXTRA_BLOCKED:
        if ip.version == net.version and ip in net:
            return f"내부·예약 대역({net})"
    if not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local \
            or ip.is_private or ip.is_unspecified:
        return "공인 주소가 아닙니다"
    return None


def check_url(url: str) -> tuple[str, str, int]:
    """(scheme, host, port) — 형식·스킴·포트·이름 검사. 실패는 FetchError."""
    if not isinstance(url, str) or not url.strip():
        raise FetchError("invalid_argument", "url 이 비었습니다")
    url = url.strip()
    if len(url) > 4096:
        raise FetchError("invalid_argument", "url 이 너무 깁니다")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as e:
        raise FetchError("invalid_argument", f"url 형식이 잘못됐습니다: {e}")
    scheme = (parts.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise FetchError("forbidden", "http·https 주소만 읽을 수 있습니다")
    if parts.username is not None or parts.password is not None or "@" in (parts.netloc or ""):
        raise FetchError("forbidden", "주소 안에 계정 정보를 넣을 수 없습니다")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise FetchError("invalid_argument", "url 에 호스트가 없습니다")
    port = port or (443 if scheme == "https" else 80)
    if port not in ALLOWED_PORTS:
        raise FetchError("forbidden", f"허용하지 않는 포트입니다({port}) — {sorted(ALLOWED_PORTS)} 만")
    try:
        ipaddress.ip_address(host)
        is_ip = True
    except ValueError:
        is_ip = False
    if not is_ip:
        if host in _BLOCKED_NAMES or host.endswith(_BLOCKED_SUFFIXES) or "." not in host:
            # 점 없는 이름 = 도커 서비스 이름(backend·postgres…)이나 사내 단일 이름
            raise FetchError("forbidden", f"내부 이름은 읽을 수 없습니다({host})")
        try:
            host.encode("idna")
        except UnicodeError:
            raise FetchError("invalid_argument", "호스트 이름이 잘못됐습니다")
    return scheme, host, port


async def _lookup(host: str, port: int) -> list[str]:
    """이름 해석(테스트가 바꿔 끼운다)."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    addrs: list[str] = []
    for info in infos:
        a = info[4][0]
        if a not in addrs:
            addrs.append(a)
    return addrs


async def resolve_public(host: str, port: int) -> list[str]:
    """이름 → 주소들. 하나라도 막힌 주소면 거절."""
    try:
        ipaddress.ip_address(host)
        addrs = [host]
    except ValueError:
        try:
            addrs = await asyncio.wait_for(_lookup(host, port), 5.0)
        except (socket.gaierror, UnicodeError, OSError):
            raise FetchError("not_found", f"주소를 찾을 수 없습니다: {host}")
        except asyncio.TimeoutError:
            raise FetchError("timeout", f"이름 해석 시간이 지났습니다: {host}")
    if not addrs:
        raise FetchError("not_found", f"주소를 찾을 수 없습니다: {host}")
    for a in addrs:
        r = blocked_reason(a)
        if r:
            raise FetchError("forbidden", f"내부망 주소로 가는 요청은 막혀 있습니다({host} → {a}: {r})")
    # IPv4 를 먼저(사내 망에 IPv6 출구가 없을 때가 많다)
    return sorted(addrs, key=lambda a: ":" in a)


def _pinned_url(url: str, ip: str) -> str:
    p = urlsplit(url)
    host = f"[{ip}]" if ":" in ip else ip
    netloc = host + (f":{p.port}" if p.port else "")
    return urlunsplit((p.scheme, netloc, p.path or "/", p.query, ""))


def _host_header(url: str) -> str:
    p = urlsplit(url)
    h = (p.hostname or "").rstrip(".")
    try:
        h = h.encode("idna").decode("ascii")
    except UnicodeError:
        pass
    if ":" in h:
        h = f"[{h}]"
    return h + (f":{p.port}" if p.port else "")


def _transport() -> httpx.AsyncBaseTransport:
    """테스트가 바꿔 끼운다(MockTransport)."""
    return httpx.AsyncHTTPTransport(retries=0)


def _parse_ct(value: str) -> tuple[str, str | None]:
    ct = (value or "").split(";")[0].strip().lower()
    charset = None
    for part in (value or "").split(";")[1:]:
        k, _, v = part.partition("=")
        if k.strip().lower() == "charset":
            charset = v.strip().strip('"').strip("'") or None
    return ct, charset


async def fetch(url: str, *, max_bytes: int, timeout: float = DEFAULT_TIMEOUT,
                accept: str = "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
                truncate_ok=lambda ct: ct.startswith("text/") or "html" in ct or "xml" in ct or "json" in ct,
                ) -> FetchResult:
    """URL 하나를 안전하게 가져온다. 본문이 max_bytes 를 넘으면: 텍스트류는 잘라서(body_truncated),
    그 밖(PDF 등)은 too_large 오류."""
    original = url.strip() if isinstance(url, str) else url
    current = original
    redirects: list[str] = []
    try:
        async with asyncio.timeout(timeout):
            async with httpx.AsyncClient(transport=_transport(), trust_env=False, follow_redirects=False,
                                         timeout=httpx.Timeout(timeout, connect=8.0)) as client:
                for _hop in range(MAX_REDIRECTS + 1):
                    scheme, host, port = check_url(current)
                    addrs = await resolve_public(host, port)
                    ip = addrs[0]
                    headers = {"Host": _host_header(current), "User-Agent": USER_AGENT, "Accept": accept,
                               "Accept-Language": "ko,en;q=0.8", "Accept-Encoding": "gzip, deflate"}
                    ext = {"sni_hostname": host} if scheme == "https" else {}
                    req = client.build_request("GET", _pinned_url(current, ip), headers=headers, extensions=ext)
                    resp = await client.send(req, stream=True)
                    try:
                        if resp.status_code in (301, 302, 303, 307, 308):
                            loc = resp.headers.get("location")
                            if not loc:
                                raise FetchError("unavailable", f"리다이렉트에 위치가 없습니다({resp.status_code})",
                                                 resp.status_code)
                            nxt = urljoin(current, loc.strip())
                            redirects.append(nxt)
                            current = nxt
                            continue
                        ct, charset = _parse_ct(resp.headers.get("content-type", ""))
                        clen = resp.headers.get("content-length")
                        if clen and clen.isdigit() and int(clen) > max_bytes and not truncate_ok(ct):
                            raise FetchError("too_large", f"본문이 너무 큽니다({int(clen)} bytes, 상한 {max_bytes})")
                        buf = bytearray()
                        truncated = False
                        async for chunk in resp.aiter_bytes():      # 압축 푼 뒤 바이트로 센다(압축 폭탄 대비)
                            room = max_bytes - len(buf)
                            if len(chunk) > room:
                                buf.extend(chunk[:room])
                                truncated = True
                                break
                            buf.extend(chunk)
                        if truncated and not truncate_ok(ct):
                            raise FetchError("too_large", f"본문이 너무 큽니다(상한 {max_bytes} bytes)")
                        return FetchResult(url=original, final_url=current, status=resp.status_code,
                                           content_type=ct, charset=charset, body=bytes(buf),
                                           body_truncated=truncated, redirects=redirects)
                    finally:
                        await resp.aclose()
                raise FetchError("unavailable", f"리다이렉트가 너무 많습니다(>{MAX_REDIRECTS})")
    except FetchError:
        raise
    except (TimeoutError, asyncio.TimeoutError, httpx.TimeoutException):
        raise FetchError("timeout", f"응답 시간이 지났습니다({int(timeout)}초)")
    except httpx.HTTPError as e:
        raise FetchError("unavailable", f"가져오지 못했습니다: {e.__class__.__name__}: {e}")
