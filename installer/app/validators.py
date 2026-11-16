"""사용자 입력 검증 — 명령 인자·경로·설정 파일에 포함되는 값은 모두 본 모듈을 거친다.

각 함수는 정규화된 값을 반환하고, 허용할 수 없으면 `Invalid(code)` 예외를 발생시킨다.
code 는 화면이 문구로 변환하는 키이다(문구는 화면이 보유한다).
"""

from __future__ import annotations

import ipaddress
import re


class Invalid(ValueError):
    def __init__(self, code: str, **vars):
        super().__init__(code)
        self.code = code
        self.vars = vars


_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_DOMAIN = re.compile(rf"(?:{_LABEL}\.)+[a-z](?:[a-z0-9-]{{0,61}}[a-z0-9])?")
_HOSTNAME = re.compile(rf"{_LABEL}(?:\.{_LABEL})*")
_USERNAME = re.compile(r"[a-z0-9][a-z0-9_.-]{2,31}")
_SAFE_PATH = re.compile(r"/[A-Za-z0-9._\-/]*")
_IMAGE_TAG = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/\-]{0,127}")

# 저장 폴더로 사용 불가한 호스트 경로(자체 및 하위 전부)
_FORBIDDEN_ROOTS = ("/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/bin", "/sbin", "/lib", "/lib64", "/usr")


def domain(value: str) -> str:
    """접속 주소로 사용하는 도메인 이름(소문자, 점 1개 이상)."""
    v = (value or "").strip().lower().rstrip(".")
    if not v:
        raise Invalid("required")
    if len(v) > 253 or not _DOMAIN.fullmatch(v):
        raise Invalid("domain_invalid")
    return v


def ipv4(value: str) -> str:
    v = (value or "").strip()
    try:
        addr = ipaddress.IPv4Address(v)
    except ValueError:
        raise Invalid("ip_invalid") from None
    return str(addr)


def address(value: str) -> str:
    """도메인 이름 또는 IPv4 주소."""
    v = (value or "").strip()
    if not v:
        raise Invalid("required")
    try:
        return ipv4(v)
    except Invalid:
        return domain(v)


def is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def hostname(value: str) -> str:
    """서버 이름(점 없는 내부 이름도 허용) 또는 IPv4 주소."""
    v = (value or "").strip().lower().rstrip(".")
    if not v:
        raise Invalid("required")
    try:
        return ipv4(v)
    except Invalid:
        pass
    if len(v) > 253 or not _HOSTNAME.fullmatch(v):
        raise Invalid("host_invalid")
    return v


def cidr(value: str) -> str:
    """IPv4 주소 또는 대역(단일 주소이면 /32 를 추가하지 않고 그대로 반환한다)."""
    v = (value or "").strip()
    if not v:
        raise Invalid("required")
    try:
        if "/" in v:
            return str(ipaddress.IPv4Network(v, strict=False))
        return str(ipaddress.IPv4Address(v))
    except ValueError:
        raise Invalid("cidr_invalid") from None


def subnet24(value: str) -> str:
    """내부 대역 — 사설 IPv4 /24 만 허용. 정규화한 `a.b.c.0/24` 를 반환한다."""
    v = (value or "").strip()
    try:
        net = ipaddress.IPv4Network(v, strict=False)
    except ValueError:
        raise Invalid("subnet_invalid") from None
    if net.prefixlen != 24:
        raise Invalid("subnet_not_24")
    if not net.is_private or net.is_loopback or net.is_link_local:
        raise Invalid("subnet_not_private")
    return str(net)


def net_prefix(subnet: str) -> str:
    """`172.28.0.0/24` → `172.28.0` (compose 의 JW_NET_PREFIX)."""
    return subnet24(subnet).rsplit(".", 1)[0]


def host_path(value: str) -> str:
    """호스트의 절대 경로(저장 폴더). 셸·마운트 옵션에서 특수 의미를 갖는 문자는 거부한다."""
    v = (value or "").strip()
    if not v:
        raise Invalid("required")
    if not _SAFE_PATH.fullmatch(v) or "//" in v:
        raise Invalid("path_invalid")
    segments = v.rstrip("/").split("/")[1:]
    if any(seg in (".", "..") for seg in segments):
        raise Invalid("path_invalid")
    norm = "/" + "/".join(segments)
    if norm == "/":
        raise Invalid("path_is_root")
    if any(norm == root or norm.startswith(root + "/") for root in _FORBIDDEN_ROOTS):
        raise Invalid("path_forbidden")
    return norm


def nfs_export(value: str) -> str:
    """NFS 내보내기 경로(`/export/share`). 마운트 옵션에 삽입될 수 있는 문자(쉼표·공백·콜론)는 거부한다."""
    v = (value or "").strip()
    if not v:
        raise Invalid("required")
    segments = v.rstrip("/").split("/")[1:]
    if not _SAFE_PATH.fullmatch(v) or "//" in v or any(seg in (".", "..") for seg in segments):
        raise Invalid("nfs_export_invalid")
    return "/" + "/".join(segments)


def username(value: str) -> str:
    v = (value or "").strip().lower()
    if not _USERNAME.fullmatch(v):
        raise Invalid("username_invalid")
    return v


def email(value: str) -> str:
    v = (value or "").strip()
    if not _EMAIL.fullmatch(v):
        raise Invalid("email_invalid")
    return v


def port(value) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise Invalid("port_invalid") from None
    if not 1 <= n <= 65535:
        raise Invalid("port_invalid")
    return n


def image_tag(value: str) -> str:
    v = (value or "").strip()
    if not _IMAGE_TAG.fullmatch(v):
        raise Invalid("image_tag_invalid")
    return v


def model_name(value: str) -> str:
    v = (value or "").strip()
    if not _MODEL.fullmatch(v):
        raise Invalid("model_invalid")
    return v


def http_url(value: str, *, https_only: bool = False) -> str:
    """기본 주소(base URL) — 스킴·호스트·포트·경로만 허용. 사용자 정보·쿼리는 거부한다."""
    from urllib.parse import urlsplit

    v = (value or "").strip()
    try:
        u = urlsplit(v)
        _ = u.port
    except ValueError:
        raise Invalid("url_invalid") from None
    if u.scheme not in (("https",) if https_only else ("http", "https")):
        raise Invalid("url_invalid")
    if not u.hostname or u.username or u.password or u.query or u.fragment:
        raise Invalid("url_invalid")
    hostname(u.hostname)
    if not re.fullmatch(r"[A-Za-z0-9._~/\-]*", u.path):
        raise Invalid("url_invalid")
    return v.rstrip("/")


def single_line(value: str, *, max_len: int = 200) -> str:
    """표시 이름 등 자유 형식의 한 줄 — 제어 문자·줄바꿈만 차단한다."""
    v = (value or "").strip()
    if len(v) > max_len or any(ord(ch) < 32 or ord(ch) == 127 for ch in v):
        raise Invalid("text_invalid")
    return v
