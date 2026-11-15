"""컨테이너 상태 조회와 재시작 — 관리 › 시스템 화면이 쓴다(docker 소켓).

구역을 켜고 끄는 일(컨테이너를 새로 만들고 지우는 일)은 compose 파일이 필요해 여기서 하지 않는다 —
설치 관리자가 한다. 여기서는 소켓만으로 되는 "상태 보기 + 재시작"만 한다.
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
    """ws-* 컨테이너 상태 목록."""
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
