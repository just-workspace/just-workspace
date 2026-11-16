"""사전 점검 — 설치를 시작해도 되는 서버인지 본다.

항목마다 `{"id", "status": pass|warn|fail, "value", "fix": {"key", "vars"} | null}` 을 낸다.
문구는 화면이 가진다 — 여기서는 키와 값만. `fail` 이 하나라도 있으면 적용할 수 없다.

호스트 정보를 얻는 방법(설치 관리자는 컨테이너 안에 있다):

| 항목 | 얻는 방법 |
|---|---|
| Docker Engine 버전, CPU 수, 메모리, 아키텍처, SELinux | `docker info` (데몬이 호스트 값을 알려 준다) |
| Compose 버전 | `docker compose version --short` (이미지에 든 플러그인 — 실제로 쓰는 것) |
| 디스크 여유(도커 데이터) | 보조 컨테이너에 익명 볼륨을 붙여 `statvfs` — 볼륨은 도커 데이터 폴더와 같은 파일 시스템에 있다 |
| 디스크 여유(설치 폴더) | 설치 관리자 자신의 `/data` 에 `statvfs` |
| 시간 동기화 | `adjtimex()` — 커널 시계 상태는 컨테이너에서도 호스트 것이 보인다 |
| 포트 80·443·25 점유 | `--network host` 보조 컨테이너에서 직접 bind 해 본다. 우리 컨테이너가 쓰는 포트는 `docker ps` 로 가려낸다 |
| 내부 대역 충돌 | `docker network inspect`(기존 도커 네트워크) + `--network host` 보조 컨테이너의 `/proc/net/route`(호스트 경로표) |
| 인터넷·이미지 저장소 | 설치 관리자 컨테이너에서 HTTPS 요청(나가는 길은 호스트와 같다) |
"""

from __future__ import annotations

import ipaddress
import json
import re
import shutil
from typing import Callable

from app import answers as ans
from app import render
from app.catalog import MIN_MEMORY_MB, Catalog, nominal_memory_mb
from app.docker_api import Docker
from app.paths import NETWORK_NAME

DOCKER_MIN = (24, 0)
COMPOSE_MIN = (2, 20)
CPU_MIN = 2
DISK_FAIL_GB = 10
DISK_WARN_GB = 20
SUPPORTED_ARCH = ("x86_64", "amd64")
REGISTRY_PROBE = "https://registry-1.docker.io/v2/"
OWN_PREFIX = "ws-"

GB = 1024 ** 3


def parse_version(text: str) -> tuple[int, ...] | None:
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text or "")
    if not m:
        return None
    return tuple(int(g) for g in m.groups() if g is not None)


def item(check_id: str, status: str, value=None, fix: str | None = None, **fix_vars) -> dict:
    return {"id": check_id, "status": status, "value": value,
            "fix": {"key": fix, "vars": fix_vars} if fix else None}


# ─── 시간 동기화 ───


def clock_synchronized() -> bool | None:
    """커널 시계가 동기화돼 있는가(`adjtimex`). 알 수 없으면 None."""
    try:
        import ctypes
        import ctypes.util

        class Timeval(ctypes.Structure):
            _fields_ = [("tv_sec", ctypes.c_long), ("tv_usec", ctypes.c_long)]

        class Timex(ctypes.Structure):
            _fields_ = [
                ("modes", ctypes.c_uint), ("offset", ctypes.c_long), ("freq", ctypes.c_long),
                ("maxerror", ctypes.c_long), ("esterror", ctypes.c_long), ("status", ctypes.c_int),
                ("constant", ctypes.c_long), ("precision", ctypes.c_long), ("tolerance", ctypes.c_long),
                ("time", Timeval), ("tick", ctypes.c_long), ("ppsfreq", ctypes.c_long), ("jitter", ctypes.c_long),
                ("shift", ctypes.c_int), ("stabil", ctypes.c_long), ("jitcnt", ctypes.c_long),
                ("calcnt", ctypes.c_long), ("errcnt", ctypes.c_long), ("stbcnt", ctypes.c_long),
                ("tai", ctypes.c_int), ("_pad", ctypes.c_int * 11),
            ]

        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
        tx = Timex()
        state = libc.adjtimex(ctypes.byref(tx))
        if state < 0:
            return None
        sta_unsync = 0x0040
        return state != 5 and not (tx.status & sta_unsync)      # 5 = TIME_ERROR
    except Exception:  # noqa: BLE001
        return None


# ─── 대역 ───


def overlaps(a: str, b: str) -> bool:
    try:
        return ipaddress.ip_network(a, strict=False).overlaps(ipaddress.ip_network(b, strict=False))
    except ValueError:
        return False


def subnet_conflicts(subnet: str, networks: list[dict], routes: list[dict]) -> list[dict]:
    """고른 내부 대역과 겹치는 것 — 기존 도커 네트워크, 호스트 경로표(도커 브리지 것은 제외)."""
    found: list[dict] = []
    docker_subnets: set[str] = set()
    for net in networks:
        for sub in net.get("subnets", []):
            if ":" in sub:
                continue
            docker_subnets.add(str(ipaddress.ip_network(sub, strict=False)))
            if net.get("name") != NETWORK_NAME and overlaps(subnet, sub):
                found.append({"kind": "docker_network", "name": net.get("name"), "subnet": sub})
    for route in routes:
        dest = route.get("dest", "")
        try:
            normalized = str(ipaddress.ip_network(dest, strict=False))
        except ValueError:
            continue
        if normalized in docker_subnets:
            continue                      # 도커 브리지가 만든 경로 — 위에서 이미 봤다
        if overlaps(subnet, dest):
            found.append({"kind": "host_route", "name": route.get("iface"), "subnet": dest})
    return found


# ─── 실행 ───


def _helper_json(result) -> dict:
    if not result.ok:
        return {}
    try:
        return json.loads(result.out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {}


def run(docker: Docker, answers: ans.Answers, catalog: Catalog, *, registry: str = "localhost",
        reach: Callable[[str], bool] | None = None, clock: Callable[[], bool | None] = clock_synchronized,
        data_free_bytes: Callable[[], int | None] | None = None) -> dict:
    """사전 점검을 돌린다. {"ok", "items", "facts": {"memory_mb", "cpus"}}"""
    items: list[dict] = []
    info = docker.info()

    # Docker Engine
    version = parse_version(info.get("ServerVersion", ""))
    if not info:
        items.append(item("docker_engine", "fail", None, "docker_unreachable"))
    elif version is None or version[:2] < DOCKER_MIN:
        items.append(item("docker_engine", "fail", info.get("ServerVersion"), "docker_too_old",
                          min=".".join(map(str, DOCKER_MIN))))
    else:
        items.append(item("docker_engine", "pass", info.get("ServerVersion")))

    # Compose
    compose_raw = docker.compose_version()
    compose = parse_version(compose_raw)
    if compose is None:
        items.append(item("docker_compose", "fail", None, "compose_missing"))
    elif compose[:2] < COMPOSE_MIN:
        items.append(item("docker_compose", "fail", compose_raw, "compose_too_old", min=".".join(map(str, COMPOSE_MIN))))
    else:
        items.append(item("docker_compose", "pass", compose_raw))

    # CPU · 메모리 · 아키텍처
    cpus = int(info.get("NCPU") or 0)
    if cpus and cpus < CPU_MIN:
        items.append(item("cpu", "fail", cpus, "cpu_too_few", min=CPU_MIN))
    elif cpus:
        items.append(item("cpu", "pass", cpus))
    else:
        items.append(item("cpu", "warn", None, "unknown"))

    memory_mb = int(info.get("MemTotal") or 0) // (1024 * 1024)
    chosen = ans.selected_zones(answers, catalog)
    if not memory_mb:
        items.append(item("memory", "warn", None, "unknown"))
    else:
        verdict = catalog.judge(chosen, memory_mb)
        if nominal_memory_mb(memory_mb) < MIN_MEMORY_MB:
            items.append(item("memory", "fail", memory_mb, "memory_below_minimum", min_mb=MIN_MEMORY_MB))
        elif not verdict.ok:
            items.append(item("memory", "fail", memory_mb, "memory_insufficient", need_mb=verdict.need_mb))
        else:
            items.append(item("memory", "pass", memory_mb))

    arch = info.get("Architecture", "")
    if arch in SUPPORTED_ARCH:
        items.append(item("arch", "pass", arch))
    elif arch:
        items.append(item("arch", "fail", arch, "arch_unsupported", supported="x86_64"))
    else:
        items.append(item("arch", "warn", None, "unknown"))

    # 디스크 — 도커 데이터 폴더(이미지·볼륨)와 설치 폴더 중 작은 쪽
    docker_free = _helper_json(docker.helper(["disk", "/probe"], volumes=["/probe"], timeout=60)).get("free_bytes")
    if data_free_bytes is None:
        def data_free_bytes():
            try:
                return shutil.disk_usage(docker.paths.data).free
            except OSError:
                return None
    data_free = data_free_bytes()
    frees = [f for f in (docker_free, data_free) if isinstance(f, int)]
    if not frees:
        items.append(item("disk", "warn", None, "unknown"))
    else:
        free_gb = round(min(frees) / GB, 1)
        value = {"free_gb": free_gb, "docker_gb": round(docker_free / GB, 1) if isinstance(docker_free, int) else None,
                 "data_gb": round(data_free / GB, 1) if isinstance(data_free, int) else None}
        if free_gb < DISK_FAIL_GB:
            items.append(item("disk", "fail", value, "disk_too_small", min_gb=DISK_FAIL_GB))
        elif free_gb < DISK_WARN_GB:
            items.append(item("disk", "warn", value, "disk_low", recommend_gb=DISK_WARN_GB))
        else:
            items.append(item("disk", "pass", value))

    # 시간 동기화
    synced = clock()
    if synced is True:
        items.append(item("time_sync", "pass", "synchronized"))
    elif synced is False:
        items.append(item("time_sync", "warn", "unsynchronized", "time_not_synchronized"))
    else:
        items.append(item("time_sync", "warn", None, "unknown"))

    # 포트 · 경로표
    probe = _helper_json(docker.helper(["host-probe", "--ports", "80,443,25"], network="host", timeout=60))
    ports = probe.get("ports", {})
    published = docker.published_ports()

    def owned_by_us(port: int) -> bool:
        needle = f":{port}->"
        return any(name.startswith(OWN_PREFIX) and any(needle in p for p in plist)
                   for name, plist in published.items())

    plan = render.derive(answers, ans.Facts(), catalog) if answers.access.domain else None
    needs_443 = plan is None or "443/tcp" in plan.ports
    needs_25 = plan is not None and "25/tcp" in plan.ports
    for port, needed, fix in ((80, True, "port_in_use"), (443, needs_443, "port_in_use"), (25, needs_25, "port_25_in_use")):
        state = ports.get(str(port))
        check_id = f"port_{port}"
        if state == "free":
            items.append(item(check_id, "pass", "free"))
        elif state == "used" and owned_by_us(port):
            items.append(item(check_id, "pass", "own"))
        elif state == "used":
            if port == 25:
                items.append(item(check_id, "warn", "used", fix, port=port, needed=needed))
            elif needed:
                items.append(item(check_id, "fail", "used", fix, port=port))
            else:
                items.append(item(check_id, "pass", "used_not_needed"))
        else:
            items.append(item(check_id, "warn", None, "unknown"))

    # 내부 대역
    subnet = answers.advanced.subnet
    try:
        conflicts = subnet_conflicts(subnet, docker.networks(), probe.get("routes", []))
    except ValueError:
        conflicts = []
    if conflicts:
        items.append(item("subnet", "fail", subnet, "subnet_conflict", conflicts=conflicts))
    else:
        items.append(item("subnet", "pass", subnet))

    # 인터넷 · 이미지 저장소(오프라인 설치일 수 있어 경고까지만)
    if reach is None:
        reach = _reach
    internet = reach(REGISTRY_PROBE)
    items.append(item("internet", "pass", "reachable") if internet
                 else item("internet", "warn", "unreachable", "internet_unreachable"))
    host = registry.split("/")[0]
    if host in ("localhost", ""):
        items.append(item("registry", "pass", "local"))
    else:
        ok = reach(f"https://{host}/v2/")
        items.append(item("registry", "pass", host) if ok else item("registry", "warn", host, "registry_unreachable", host=host))

    # SELinux(정보)
    selinux = probe.get("selinux") or ("enabled" if any("selinux" in str(o) for o in info.get("SecurityOptions", [])) else "disabled")
    items.append(item("selinux", "pass", selinux))

    return {
        "ok": not any(i["status"] == "fail" for i in items),
        "items": items,
        "facts": {"memory_mb": memory_mb or None, "cpus": cpus or None,
                  "outbound_address": probe.get("outbound_address") or None,
                  "gateway": probe.get("gateway") or None},
    }



# 사전 점검이 감지한 값 가운데 facts 로 남기는 것 — {사전 점검의 이름: facts 의 이름}
PREFLIGHT_FACTS = {"memory_mb": "memory_mb", "cpus": "cpus", "outbound_address": "host_address", "gateway": "gateway"}


def preflight_facts(report: dict) -> dict:
    """사전 점검 결과에서 facts 로 옮길 값(감지하지 못한 것은 뺀다 — 예전에 감지한 값을 지우지 않는다)."""
    got = report.get("facts") or {}
    return {PREFLIGHT_FACTS[k]: val for k, val in got.items() if val and k in PREFLIGHT_FACTS}


def _reach(url: str) -> bool:
    """그 주소에 HTTPS 로 닿는가 — 응답 코드는 보지 않는다(저장소는 인증 없이 401 을 준다)."""
    try:
        import httpx

        with httpx.Client(timeout=8.0, follow_redirects=False) as client:
            client.get(url)
        return True
    except Exception:  # noqa: BLE001
        return False
