"""격리 브라우저 — docker CLI 어댑터(docker.sock, backend 컨테이너의 docker-ce-cli).

백엔드의 역할은 네 가지이다: 전용 네트워크 보장 · 세션 컨테이너 생성(정책 파일 복사 → 시작) ·
상태 조회(실행 여부, 뷰어 연결 여부, 게시된 포트) · 제거. 호스트 iptables 는 변경하지 않는다 —
이는 ws-rbi-netfilter 사이드카의 역할이며, 본 모듈은 해당 사이드카의 하트비트 파일만 읽어 "격리 규칙이
유효한가" 를 판정한다(없으면 세션을 시작하지 않는다 — fail-closed).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass

from app.config import get_settings

logger = logging.getLogger(__name__)

SESSION_LABEL = "app.just-workspace.rbi=session"


class DockerError(RuntimeError):
    pass


async def _docker(*args: str, timeout: float = 30.0, stdin: bytes | None = None) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", *args,
            stdin=asyncio.subprocess.PIPE if stdin is not None else None,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(stdin), timeout=timeout)
        return proc.returncode or 0, (out or b"").decode("utf-8", "replace")
    except FileNotFoundError:
        return 127, "docker CLI 가 없습니다"
    except asyncio.TimeoutError:
        return 124, "docker 명령 시간 초과"
    except Exception as e:  # noqa: BLE001
        return 1, str(e)


def _must(rc: int, out: str, what: str) -> str:
    if rc != 0:
        raise DockerError(f"{what} 실패: {out.strip()[-400:]}")
    return out


# ── 네트워크 ──

async def ensure_network() -> None:
    """세션 전용 브리지가 없으면 생성한다(있으면 설정 일치 여부만 확인한다).

    enable_icc=false: 세션 컨테이너 간 상호 접근 불가(도커가 br_netfilter 를 로드하여 강제한다).
    bridge.name 을 고정하여 netfilter 사이드카가 인터페이스 이름으로 규칙을 적용한다.
    """
    s = get_settings()
    rc, out = await _docker("network", "inspect", s.rbi_network, "--format", "{{json .}}")
    if rc == 0:
        try:
            info = json.loads(out)
            opts = info.get("Options") or {}
            cfgs = (info.get("IPAM") or {}).get("Config") or []
            subnet_ok = any(c.get("Subnet") == s.rbi_subnet for c in cfgs)
            if opts.get("com.docker.network.bridge.name") != s.rbi_bridge or not subnet_ok:
                raise DockerError(
                    f"네트워크 {s.rbi_network} 가 있지만 설정이 다릅니다(bridge={opts.get('com.docker.network.bridge.name')}, "
                    f"subnet={[c.get('Subnet') for c in cfgs]}). 삭제하고 다시 만들거나 RBI_* 를 맞추십시오"
                )
        except json.JSONDecodeError:
            pass
        return
    # 게이트웨이를 명시한다 — 생략 시 도커가 ip-range 의 첫 주소를 게이트웨이로 할당하여 세션 대역이 한 칸 밀린다
    import ipaddress
    gateway = str(next(ipaddress.ip_network(s.rbi_subnet, strict=False).hosts()))
    rc, out = await _docker(
        "network", "create", "--driver", "bridge",
        "--subnet", s.rbi_subnet, "--ip-range", s.rbi_ip_range, "--gateway", gateway,
        "--opt", f"com.docker.network.bridge.name={s.rbi_bridge}",
        "--opt", "com.docker.network.bridge.enable_icc=false",
        "--opt", "com.docker.network.bridge.enable_ip_masquerade=true",
        "--label", "app.just-workspace.rbi=network",
        s.rbi_network,
    )
    _must(rc, out, "격리 네트워크 생성")
    logger.info("[rbi] network %s created (%s, bridge %s)", s.rbi_network, s.rbi_subnet, s.rbi_bridge)


# ── netfilter 사이드카 하트비트 ──

@dataclass
class GuardState:
    ok: bool
    reason: str
    applied_at: float | None = None
    age: float | None = None
    bridge: str | None = None
    allow: list[str] | None = None
    rules: int | None = None
    #: 사이드카가 재검사하여 거부한 동적 줄("IP:포트 이유")
    rejected: list[str] | None = None
    #: 사이드카가 마지막으로 읽은 동적 허용 파일 rev
    allow_rev: str | None = None


def read_guard_state() -> GuardState:
    """ws-rbi-netfilter 가 60초마다 기록하는 state.json 을 읽는다. 없거나 오래되었거나 브리지가 상이하면 ok=False."""
    s = get_settings()
    path = s.rbi_guard_state
    if not s.rbi_require_guard:
        return GuardState(ok=True, reason="guard-not-required")
    try:
        with open(path, encoding="utf-8") as f:
            st = json.load(f)
    except FileNotFoundError:
        return GuardState(ok=False, reason="netfilter 사이드카 상태 파일이 없습니다(ws-rbi-netfilter 가 실행 중인지 확인하십시오)")
    except Exception as e:  # noqa: BLE001
        return GuardState(ok=False, reason=f"상태 파일을 읽지 못했습니다: {e}")
    applied = float(st.get("applied_at") or 0)
    age = time.time() - applied
    if age > s.rbi_guard_max_age:
        return GuardState(ok=False, reason=f"netfilter 하트비트가 {int(age)}초 전입니다(한도 {s.rbi_guard_max_age}초)",
                          applied_at=applied, age=age, bridge=st.get("bridge"))
    if st.get("bridge") != s.rbi_bridge:
        return GuardState(ok=False, reason=f"netfilter 가 다른 브리지({st.get('bridge')})를 지키고 있습니다",
                          applied_at=applied, age=age, bridge=st.get("bridge"))
    if not st.get("ok", False):
        return GuardState(ok=False, reason=f"netfilter 규칙 적용 실패: {st.get('error') or '원인 미상'}",
                          applied_at=applied, age=age, bridge=st.get("bridge"))
    return GuardState(ok=True, reason="ok", applied_at=applied, age=age, bridge=st.get("bridge"),
                      allow=st.get("allow"), rules=st.get("rules"), rejected=st.get("rejected"), allow_rev=st.get("allow_rev"))


# ── 세션 컨테이너 ──

async def create_session_container(create_args: list[str]) -> str:
    """create → start. 컨테이너 ID 를 반환한다. start 실패 시 컨테이너를 삭제하고 예외를 발생시킨다.

    정책 파일은 create 인자(환경변수 + 시작 셸)에 포함된다 — 읽기 전용 루트는 start 전 `docker cp` 도 거부하기 때문이다.
    """
    rc, out = await _docker(*create_args, timeout=60)
    cid = _must(rc, out, "세션 컨테이너 생성").strip().splitlines()[-1].strip()
    try:
        rc, out = await _docker("start", cid, timeout=60)
        _must(rc, out, "세션 컨테이너 시작")
    except Exception:
        await remove_container(cid)
        raise
    return cid


async def published_upstream(cid: str) -> str:
    """게시된 6901/tcp 의 호스트 주소 "IP:port"."""
    rc, out = await _docker("port", cid, "6901/tcp")
    out = _must(rc, out, "게시 포트 조회").strip()
    # "172.28.0.1:32768" (IPv6 줄이 혼재하면 IPv4 줄만 사용)
    for ln in out.splitlines():
        ln = ln.strip()
        if ln and not ln.startswith("["):
            return ln
    raise DockerError(f"게시 포트를 찾지 못했습니다: {out}")


async def container_state(cid: str) -> tuple[bool, int | None]:
    """(실행 여부, 종료 코드). 컨테이너가 없으면 (False, None)."""
    rc, out = await _docker("inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", cid)
    if rc != 0:
        return False, None
    parts = out.strip().split()
    running = parts[0] == "true" if parts else False
    code = int(parts[1]) if len(parts) > 1 and parts[1].lstrip("-").isdigit() else None
    return running, code


async def established_viewers(cid: str) -> int | None:
    """컨테이너 내부 6901 에 연결된 TCP 연결 수(뷰어). ss 가 없거나 실패하면 None(판정 보류)."""
    rc, out = await _docker("exec", cid, "ss", "-Htn", "state", "established", "( sport = :6901 )", timeout=15)
    if rc != 0:
        return None
    return len([ln for ln in out.splitlines() if ln.strip()])


async def remove_container(cid: str) -> None:
    rc, out = await _docker("rm", "-f", "-v", cid, timeout=60)
    if rc != 0 and "No such container" not in out:
        logger.warning("[rbi] container rm failed (%s): %s", cid[:12], out.strip()[-200:])


async def list_session_containers() -> list[tuple[str, str]]:
    """라벨이 붙은 세션 컨테이너 (id, name) 목록 — 고아 정리용."""
    rc, out = await _docker("ps", "-a", "--filter", f"label={SESSION_LABEL}", "--format", "{{.ID}}\t{{.Names}}")
    if rc != 0:
        return []
    res = []
    for ln in out.splitlines():
        parts = ln.split("\t")
        if len(parts) == 2:
            res.append((parts[0], parts[1]))
    return res


async def wait_ready(cid: str, timeout: float = 45.0) -> bool:
    """KasmVNC(6901)가 컨테이너 내부에서 수신 대기를 시작할 때까지 대기한다.

    외부에서 접속을 시도하지 않는다 — 세션 브리지로 유입되는 신규 연결은 netfilter 가 ws-nginx 출발지만 허용하므로 백엔드는
    도달할 수 없다(의도된 동작). 대신 `docker exec` 로 컨테이너 내부에서 127.0.0.1:6901 에 TCP 연결을 시도한다(bash /dev/tcp).
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        running, _ = await container_state(cid)
        if not running:
            return False
        rc, _out = await _docker("exec", cid, "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/6901", timeout=10)
        if rc == 0:
            return True
        await asyncio.sleep(1.0)
    return False
