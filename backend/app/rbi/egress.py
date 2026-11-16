"""격리 브라우저 출구(egress) 허용 목록 — DB 의 활성 대상에서 생성한다(관리 화면에서 대상을 추가하면 즉시 반영된다).

흐름
  관리자 대상 저장 → compute_egress(검증 + 이름 해석 → IP 고정) → rbi_targets.egress(JSON) 에 저장
  → sync_allow_file: 활성 대상들의 egress 를 수집하여 RBI_ALLOW_FILE(기본 /run/rbi-allow/allow.txt, 백엔드만 쓰는 볼륨)에 원자적으로 기록한다
  → ws-rbi-netfilter 가 매 주기(RBI_POLL, 기본 5초) 해당 파일을 읽어 체인을 재생성한다(재시작 없음). 결과(적용된 목록·거부한 줄)는
    하트비트 state.json(사이드카만 쓰는 볼륨)에 포함되어 관리 화면 "격리 규칙 상태" 와 세션 시작 전 확인에 사용된다.

파일 방식을 사용하는 이유(내부 HTTP 엔드포인트 대신)
  사이드카는 host 네트워크이므로 백엔드(도커 네트워크 내부)에 접근하려면 포트를 호스트로 개방하거나 ws-nginx 를 경유해야 한다 — 신규 노출면이다.
  파일은 볼륨 두 개로 방향을 분리한다: rbi-allow(백엔드 쓰기 → 사이드카 읽기 전용) · rbi-guard(사이드카 쓰기 → 백엔드 읽기 전용).
  백엔드는 하트비트를 위조할 수 없고, 사이드카는 백엔드가 기록한 줄을 재검증한다(형식·상한 CIDR·도커 브리지·루프백 거부).

검증(대상 저장 시)
  · 호스트는 사설/LAN IP 또는 이름. 이름은 저장 시 IPv4 로 해석하여 해당 IP 를 규칙과 세션 컨테이너(--add-host)에 고정한다
    (세션 컨테이너에는 DNS 가 없다 — 이름 해석이 외부로 유출되지 않는다).
  · 모든 IP 는 RBI_ALLOW_CEILING(기본 10/8·172.16/12·192.168/16) 범위 내여야 한다 — 공인 주소는 강제 옵션으로도 허용되지 않는다.
  · 루프백·링크로컬·멀티캐스트·도커 브리지 대역(본 호스트의 모든 도커 네트워크)·세션 대역은 거부(강제 불가).
  · 워크스페이스 자신(RBI_PROTECTED, APP_URL·RBI_PUBLIC_ORIGIN 이 해석되는 IP = RP, 게시 주소)은 거부 — force=True 이면 경고와 함께 허용.
  · 포트는 80/443 + 대상에 명시한 extra_ports 만 허용. 포트를 지정하지 않은 호스트는 80·443 모두.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import socket
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from app.config import get_settings

logger = logging.getLogger(__name__)

DEFAULT_PORTS = (80, 443)
DEFAULT_CEILING = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
_HARD_DENY = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
)]
_NAME_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")


@dataclass
class EgressEntry:
    host: str           # 관리자가 입력한 호스트(IP 또는 이름)
    ip: str             # 고정한 IPv4
    port: int
    forced: bool = False

    def line(self) -> str:
        return f"{self.ip}:{self.port}"

    def as_dict(self) -> dict:
        return {"host": self.host, "ip": self.ip, "port": self.port, "forced": self.forced}


def _nets(csv: str) -> list[ipaddress.IPv4Network]:
    out = []
    for part in (csv or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            n = ipaddress.ip_network(part, strict=False)
        except ValueError:
            logger.warning("[rbi.egress] CIDR 형식 오류 무시: %s", part)
            continue
        if n.version == 4:
            out.append(n)
    return out


def ceiling() -> list[ipaddress.IPv4Network]:
    return _nets(get_settings().rbi_allow_ceiling or DEFAULT_CEILING)


async def resolve_ipv4(host: str) -> list[str]:
    """이름 → IPv4 목록(정렬). 실패 시 []. (테스트에서 대체한다)"""
    try:
        infos = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(host, None, family=socket.AF_INET, type=socket.SOCK_STREAM), timeout=5)
    except Exception:  # noqa: BLE001
        return []
    return sorted({i[4][0] for i in infos})


async def docker_networks() -> list[ipaddress.IPv4Network]:
    """본 호스트의 도커 네트워크 대역(세션이 도달해서는 안 되는 ws-* 컨테이너들). 실패 시 설정값으로 확인 가능한 대역만 반환."""
    s = get_settings()
    out = _nets(f"{s.rbi_subnet},172.17.0.0/16,{s.rbi_publish_ip}/24")
    from app.rbi import docker as dk
    try:
        rc, txt = await dk._docker("network", "ls", "-q")
        ids = txt.split() if rc == 0 else []
        if ids:
            rc, txt = await dk._docker("network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}},{{end}}", *ids)
            if rc == 0:
                out += _nets(txt.replace("\n", ","))
    except Exception as e:  # noqa: BLE001
        logger.warning("[rbi.egress] docker network 조회 실패: %s", e)
    return out


async def protected_ips() -> dict[str, str]:
    """워크스페이스 자신(강제로만 허용) — {IP: 이유}."""
    s = get_settings()
    out: dict[str, str] = {}
    for part in (s.rbi_protected or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            n = ipaddress.ip_network(part, strict=False)
        except ValueError:
            continue
        out[str(n.network_address) if n.num_addresses == 1 else str(n)] = "RBI_PROTECTED"
    for label, url in (("APP_URL", s.app_url), ("RBI_PUBLIC_ORIGIN", s.rbi_public_origin)):
        h = urlsplit(url or "").hostname
        if not h:
            continue
        try:
            out.setdefault(str(ipaddress.ip_address(h)), label)
        except ValueError:
            for ip in await resolve_ipv4(h):
                out.setdefault(ip, f"{label}({h})")
    return out


def _in_protected(ip: str, prot: dict[str, str]) -> str | None:
    a = ipaddress.ip_address(ip)
    for k, why in prot.items():
        try:
            if a in ipaddress.ip_network(k, strict=False):
                return why
        except ValueError:
            continue
    return None


def _split_host(entry: str) -> tuple[str, int | None]:
    e = entry.strip().lower()
    if e.count(":") == 1:
        h, p = e.split(":", 1)
        if not p.isdigit():
            raise ValueError(f"포트 형식 오류: {entry}")
        return h, int(p)
    return e, None


def host_specs(url: str, allowed_hosts: list[str]) -> list[tuple[str, int | None]]:
    """대상 주소 + 허용 호스트 → (호스트, 포트|None). 주소의 포트가 없으면 None(=80·443)."""
    u = urlsplit(url)
    specs: list[tuple[str, int | None]] = [((u.hostname or "").lower(), u.port)]
    for h in allowed_hosts or []:
        sp = _split_host(h)
        if sp not in specs:
            specs.append(sp)
    return [s for s in specs if s[0]]


def validate_extra_ports(ports) -> list[int]:
    if ports is None:
        return []
    if not isinstance(ports, list):
        raise ValueError("extra_ports 는 포트 목록")
    out: list[int] = []
    for p in ports:
        try:
            v = int(p)
        except (TypeError, ValueError):
            raise ValueError(f"포트가 올바르지 않습니다: {p}")
        if not (1 <= v <= 65535):
            raise ValueError(f"포트가 올바르지 않습니다: {p}")
        if v not in DEFAULT_PORTS and v not in out:
            out.append(v)
    if len(out) > 16:
        raise ValueError("추가 포트는 16개까지")
    return sorted(out)


async def compute_egress(url: str, allowed_hosts: list[str], extra_ports: list[int], *, force: bool = False) -> tuple[list[EgressEntry], list[str]]:
    """대상 → 고정 출구 목록 + 경고. 허용 불가 시 ValueError(관리 API 가 400 으로 변환)."""
    allowed_ports = set(DEFAULT_PORTS) | set(extra_ports or [])
    ceil = ceiling()
    dockers = await docker_networks()
    prot = await protected_ips()
    warnings: list[str] = []
    entries: list[EgressEntry] = []
    for host, port in host_specs(url, allowed_hosts):
        if port is not None and port not in allowed_ports:
            raise ValueError(f"{host}:{port} — 포트는 80·443 또는 추가 포트로 명시한 것만 열 수 있습니다")
        ports = [port] if port is not None else list(DEFAULT_PORTS)
        try:
            literal = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            literal = None
        if literal is not None:
            if literal.version != 4:
                raise ValueError(f"{host} — IPv6 대상은 받지 않습니다(세션 컨테이너는 IPv6 를 끈다)")
            ips = [str(literal)]
        else:
            if not _NAME_RE.match(host):
                raise ValueError(f"{host} — 호스트 이름 형식이 올바르지 않습니다")
            ips = await resolve_ipv4(host)
            if not ips:
                raise ValueError(f"{host} — 이름을 풀지 못했습니다(저장할 때 IP 로 고정합니다 — DNS 를 확인하세요)")
            ips = ips[:1]  # 세션 컨테이너의 --add-host 와 동일한 하나로 고정
        for ip in ips:
            a = ipaddress.ip_address(ip)
            if any(a in n for n in _HARD_DENY):
                raise ValueError(f"{host} → {ip} — 루프백·링크로컬·멀티캐스트 주소는 대상이 될 수 없습니다")
            if any(a in n for n in dockers):
                raise ValueError(f"{host} → {ip} — 도커 브리지 대역(워크스페이스 컨테이너·세션 대역)은 대상이 될 수 없습니다")
            if not any(a in n for n in ceil):
                raise ValueError(f"{host} → {ip} — 허용 상한(RBI_ALLOW_CEILING) 밖입니다. 사설/LAN 주소만 열 수 있습니다")
            why = _in_protected(ip, prot)
            if why and not force:
                raise ValueError(f"{host} → {ip} — 워크스페이스 자신의 주소입니다({why}). 꼭 열어야 하면 강제(force)로 저장하세요")
            if why:
                warnings.append(f"{host} → {ip}: 워크스페이스 자신의 주소({why})를 강제로 엽니다")
            elif force:
                # backend 가 인지하는 "자신의 주소"는 설정(RBI_PROTECTED)과 접속 주소가 해석되는 IP 뿐이다. 서버의 LAN 주소·기본
                # 게이트웨이는 사이드카만 인지하며, 사이드카는 force 가 지정된 줄만 통과시킨다 — 강제 저장 의도를 그대로 전달한다.
                warnings.append(f"{host} → {ip}: 강제로 저장했습니다 — 이 서버 자신의 주소나 기본 게이트웨이여도 엽니다")
            for p in ports:
                e = EgressEntry(host=host, ip=ip, port=p, forced=bool(why) or force)
                if all(x.line() != e.line() for x in entries):
                    entries.append(e)
    if len(entries) > 64:
        raise ValueError("대상 하나의 출구는 64개까지")
    return entries, warnings


def load_entries(raw: str | None) -> list[EgressEntry]:
    try:
        items = json.loads(raw or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    out = []
    for d in items if isinstance(items, list) else []:
        try:
            out.append(EgressEntry(host=str(d["host"]), ip=str(ipaddress.IPv4Address(d["ip"])), port=int(d["port"]), forced=bool(d.get("forced"))))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def dump_entries(entries: list[EgressEntry]) -> str:
    return json.dumps([e.as_dict() for e in entries])


def add_host_args(entries: list[EgressEntry]) -> list[str]:
    """이름으로 지정한 호스트 → 세션 컨테이너 --add-host 이름:고정IP(DNS 없이 동일 IP 로 접속한다)."""
    seen: dict[str, str] = {}
    for e in entries:
        try:
            ipaddress.ip_address(e.host)
            continue
        except ValueError:
            seen.setdefault(e.host, e.ip)
    out: list[str] = []
    for h, ip in sorted(seen.items()):
        out += ["--add-host", f"{h}:{ip}"]
    return out


# ── 허용 파일(사이드카가 읽는다) ──

def desired_lines(targets) -> list[str]:
    """활성 대상들의 출구 → 사이드카 줄 "IP:포트[ force]  # 대상키"(정렬·중복 제거)."""
    rows: dict[str, tuple[bool, set[str]]] = {}
    for t in targets:
        if not t.enabled:
            continue
        for e in load_entries(t.egress):
            forced, keys = rows.get(e.line(), (False, set()))
            rows[e.line()] = (forced or e.forced, keys | {t.key})
    return [f"{k}{' force' if f else ''}  # {','.join(sorted(keys))}" for k, (f, keys) in sorted(rows.items())]


def allow_set(lines: list[str]) -> set[str]:
    return {ln.split()[0] for ln in lines if ln.strip() and not ln.startswith("#")}


def render_file(lines: list[str]) -> str:
    body = "\n".join(lines)
    rev = hashlib.sha256(body.encode()).hexdigest()[:16]
    return (f"# ws-rbi-netfilter 동적 허용 목록 — 백엔드가 켜진 격리 브라우저 대상에서 만든다(손으로 고치지 말 것)\n"
            f"# rev={rev} generated_at={int(time.time())}\n" + (body + "\n" if body else ""))


def read_allow_file() -> list[str]:
    try:
        with open(get_settings().rbi_allow_file, encoding="utf-8") as f:
            return [ln.rstrip("\n") for ln in f if ln.strip() and not ln.startswith("#")]
    except OSError:
        return []


def write_allow_file(lines: list[str]) -> bool:
    """내용이 변경된 경우에만 원자적으로 기록한다. 변경 시 True."""
    path = get_settings().rbi_allow_file
    if read_allow_file() == lines and os.path.exists(path):
        return False
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(render_file(lines))
    os.replace(tmp, path)
    return True


async def fill_missing(db, targets) -> int:
    """이전 행(egress 없음)의 출구를 채운다 — 이 브랜치 이전에 생성된 대상. 실패한 대상은 건너뛴다(로그)."""
    n = 0
    for t in targets:
        if t.egress:
            continue
        try:
            from app.rbi.service import _loads
            entries, _w = await compute_egress(t.url, _loads(t.allowed_hosts), _loads(t.extra_ports), force=bool(t.egress_forced))
        except ValueError as e:
            logger.warning("[rbi.egress] 대상 %s 출구를 만들지 못했습니다(관리 화면에서 고치세요): %s", t.key, e)
            t.egress = "[]"
            continue
        t.egress = dump_entries(entries)
        n += 1
    if n:
        await db.commit()
    return n


async def sync_allow_file(db) -> list[str]:
    """DB → 허용 파일. 반환값은 현재 요구되는 줄 목록."""
    from app.rbi.service import list_targets
    targets = await list_targets(db)
    await fill_missing(db, targets)
    lines = desired_lines(targets)
    try:
        if write_allow_file(lines):
            logger.info("[rbi.egress] 허용 목록 갱신: %s", [ln.split()[0] for ln in lines])
    except OSError as e:
        logger.error("[rbi.egress] 허용 파일을 쓰지 못했습니다(%s): %s", get_settings().rbi_allow_file, e)
    return lines
