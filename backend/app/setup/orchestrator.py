"""오케스트레이션 어댑터 — 서비스 라이프사이클(단일 웹 컨트롤 플레인).

지금: docker(컨테이너 상태/재시작, docker.sock). 차후: k8s 어댑터(동일 인터페이스로 교체).
서비스 '시작/중지'(프로파일 신규 기동)는 compose 파일 접근이 필요해 여기서 다루지 않고,
여기선 sock만으로 가능한 '상태 조회 + 재시작'을 제공(안전).
"""
from __future__ import annotations

import asyncio

# 관리 대상 서비스(컨테이너 ws-<service>)
WS_SERVICES = [
    "postgres", "redis", "backend", "frontend-react", "nginx",
    "mailserver", "gitea", "livekit", "searxng", "onlyoffice", "sso",
]


async def _docker(*args: str, timeout: float = 20.0) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", *args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, (out or b"").decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 1, str(e)


async def service_status() -> list[dict]:
    """ws-* 컨테이너 상태 목록 (Catalyst식 어슈어런스)."""
    rc, out = await _docker("ps", "-a", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}")
    found: dict[str, dict] = {}
    if rc == 0:
        for ln in out.splitlines():
            parts = ln.split("\t")
            if len(parts) >= 2 and parts[0].startswith("ws-"):
                found[parts[0]] = {"state": parts[1], "status": parts[2] if len(parts) > 2 else ""}
    result = []
    for s in WS_SERVICES:
        name = f"ws-{s}"
        info = found.get(name)
        result.append({
            "service": s,
            "name": name,
            "present": bool(info),
            "running": bool(info and info["state"] == "running"),
            "status": info["status"] if info else "미설치",
        })
    return result


async def restart_service(service: str) -> tuple[bool, str]:
    if service not in WS_SERVICES:
        return False, "알 수 없는 서비스"
    rc, out = await _docker("restart", f"ws-{service}", timeout=60.0)
    return rc == 0, out.strip()[-300:]
