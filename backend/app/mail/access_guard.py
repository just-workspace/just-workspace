"""메일 서버 접속 경계.

두 가지를 한 곳에서 판정한다.

1. 마스터 인증(dovecot master user)은 "사용자 본인의 내장 메일함" 에서만 사용한다.
   판정 근거는 호스트 문자열이 아니라 `_builtin_account()` 가 메모리에서 생성한 객체에 부여한
   표식이다. DB 에서 조회한 계정 레코드나 요청 본문으로 생성한 객체에는 이 표식이 존재하지 않는다.
2. 사용자가 등록하는 외부 메일 계정은 내부망(서비스 이름·사설/루프백/링크로컬 대역)으로
   접속할 수 없다. 등록·수정 시 1회, 실제 접속 직전마다 1회 추가 확인한다(이미 저장된
   레코드·DNS 변경 대비).

사내망 메일 서버(예: 사내 Exchange)를 외부 계정으로 연결해야 하는 설치본은 관리자가
환경변수 `MAIL_PRIVATE_HOST_ALLOWLIST` 에 호스트 이름이나 CIDR 을 쉼표로 구분하여 지정한다.
내장 메일서버 이름은 허용 목록에 있어도 항상 거부한다.
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import socket

from app.chat.link_preview import ip_allowed

# 표식 속성 이름. MailAccount 의 컬럼이 아니므로 DB·요청 본문으로는 생성되지 않는다.
_BUILTIN_MARK = "_jw_builtin_owner_email"

# 컨테이너 내부 서비스 이름(도커 compose 서비스·컨테이너 이름). 점 없는 단일 이름은 원래 거부되지만
# 허용 목록으로도 해제되지 않도록 별도로 정의한다.
_ALWAYS_DENIED = frozenset({
    "mailserver", "ws-mailserver", "mail", "dovecot", "postfix",
})
_INTERNAL_SUFFIXES = (".local", ".localhost", ".internal", ".lan", ".home.arpa", ".docker")


class MailHostRejected(ValueError):
    """외부 메일 계정의 호스트가 내부망을 가리킨다."""


# ── 1. 내장 메일함 마스터 인증 ──

def mark_builtin(account, owner_email: str) -> None:
    """`_builtin_account()` 만 호출한다. 해당 사용자 본인 주소로만 표식을 부여한다."""
    object.__setattr__(account, _BUILTIN_MARK, (owner_email or "").strip().lower())


def is_builtin(account) -> bool:
    """사용자 본인의 내장 메일함 객체인지 여부(마스터 인증 대상)."""
    owner = getattr(account, "__dict__", {}).get(_BUILTIN_MARK)
    if not owner:
        return False
    if not str(getattr(account, "id", "") or "").startswith("builtin-"):
        return False
    username = (getattr(account, "username", "") or "").strip().lower()
    email = (getattr(account, "email", "") or "").strip().lower()
    return username == owner and email == owner


def login_credentials(account, decrypt) -> tuple[str, str, bool]:
    """(로그인 사용자, 비밀번호, 내장 여부). oauth 계정에는 호출하지 않는다.

    내장 메일함이면서 마스터 자격이 설정된 경우에만 `user*master` 로그인을 생성한다.
    그 외에는 계정 레코드에 저장된 사용자 본인의 비밀번호를 사용한다.
    """
    from app.config import get_settings

    s = get_settings()
    if is_builtin(account) and s.dovecot_master_user and s.dovecot_master_password:
        return f"{account.username}*{s.dovecot_master_user}", s.dovecot_master_password, True
    return account.username, decrypt(account.password_encrypted), False


# ── 2. 외부 계정 호스트 검사 ──

def _allowlist() -> tuple[set[str], list]:
    raw = os.environ.get("MAIL_PRIVATE_HOST_ALLOWLIST", "") or ""
    names: set[str] = set()
    nets: list = []
    for item in (x.strip().lower() for x in raw.split(",")):
        if not item:
            continue
        try:
            nets.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            names.add(item.rstrip("."))
    return names, nets


def _resolve(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(i[4][0] for i in infos))


def check_external_host(host: str | None, port: int | None) -> None:
    """외부 메일 계정의 접속 허용 호스트 여부 검사. 불허 시 MailHostRejected.

    - 점 없는 단일 이름(도커 서비스명 등)·localhost·내부 접미사 거부
    - DNS 조회 결과 주소가 하나라도 공인 주소가 아니면 거부(허용 목록 예외)
    - 조회되지 않는 이름도 거부
    """
    h = (host or "").strip().lower().rstrip(".")
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if not h or len(h) > 253 or any(c in h for c in "/\\@ \t\r\n"):
        raise MailHostRejected("invalid")
    if h in _ALWAYS_DENIED:
        raise MailHostRejected("internal")

    names, nets = _allowlist()
    is_ip = True
    try:
        ipaddress.ip_address(h.split("%", 1)[0])
    except ValueError:
        is_ip = False

    if not is_ip:
        if h == "localhost" or "." not in h or h.endswith(_INTERNAL_SUFFIXES):
            if h not in names:
                raise MailHostRejected("internal")
        try:
            ips = _resolve(h, int(port or 0))
        except (socket.gaierror, OSError, UnicodeError):
            raise MailHostRejected("dns")
    else:
        ips = [h]
    if not ips:
        raise MailHostRejected("dns")

    for ip in ips:
        if ip_allowed(ip):
            continue
        if h in names:
            continue
        try:
            addr = ipaddress.ip_address(ip.split("%", 1)[0])
        except ValueError:
            raise MailHostRejected("internal")
        if any(addr in n for n in nets if n.version == addr.version) and not addr.is_loopback \
                and not addr.is_unspecified:
            continue
        raise MailHostRejected("internal")


async def check_external_host_async(host: str | None, port: int | None) -> None:
    await asyncio.to_thread(check_external_host, host, port)


async def ensure_account_hosts(account) -> None:
    """실제 접속 직전 검사 — 내장 메일함은 통과, 외부 계정은 수신·발신 호스트 모두 확인."""
    if is_builtin(account):
        return
    await check_external_host_async(account.imap_host, account.imap_port)
    await check_external_host_async(account.smtp_host, account.smtp_port)


def ensure_account_hosts_sync(account) -> None:
    if is_builtin(account):
        return
    check_external_host(account.imap_host, account.imap_port)
    check_external_host(account.smtp_host, account.smtp_port)


REJECT_MESSAGE = "이 메일 서버 주소는 사용할 수 없습니다(내부망 주소는 외부 메일 계정으로 등록할 수 없습니다)"
