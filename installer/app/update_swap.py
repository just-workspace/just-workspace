"""설치 관리자 자기 교체 — 일회용 보조 컨테이너에서 돈다(`python -m app.update_swap …`).

컨테이너는 자기 자신을 바꿀 수 없다. 그래서 설치 관리자는 **자기 이미지로** 보조 컨테이너를 하나 띄우고(docker 소켓과
데이터 폴더를 붙여서), 그 컨테이너가 다음을 한다.

1. 옛 컨테이너의 구성을 읽는다(이름, 재시작 정책, 게시 포트, 볼륨, 사용자가 준 환경변수, 붙은 네트워크와 별칭).
2. 옛 컨테이너를 멈추고 이름을 `<이름>-prev` 로 바꾼다.
3. 같은 구성으로 새 이미지의 컨테이너를 만들고 네트워크를 붙여 시작한다.
4. 새 컨테이너가 정상(healthy)이고 번들 버전이 기대한 값인지 본다.
5. 맞으면 옛 컨테이너를 지운다. 아니면 새 컨테이너를 지우고 옛 컨테이너를 제 이름으로 되살려 다시 시작한다.

결과는 `--result` 파일에 JSON 으로 남긴다. 옮기는 구성은 위 목록이 전부다 — 그 밖의 `docker run` 옵션(자원 제한,
레이블 등)을 직접 붙여 띄운 설치 관리자라면 교체 뒤 다시 붙여야 한다.
환경변수는 "옛 이미지가 정한 것"을 빼고 옮긴다(새 이미지의 기본값이 살아야 한다). `JW_IMAGE_TAG` 도 옮기지 않는다 —
업데이트 뒤에는 이미지 태그가 곧 제품 버전이다. 새 컨테이너에는 `JW_INSTALLER_VERSION=<제품 버전>` 을 넣는다: 승격한
릴리스의 이미지는 Beta 때 빌드한 것이라 이미지 안의 버전 글자가 Beta 의 것이다.

표준 라이브러리만 쓴다.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

DROP_ENV = ("JW_IMAGE_TAG", "JW_INSTALLER_VERSION", "JW_APP_VERSION", "JW_VERSION", "HOSTNAME", "HOME", "PATH")
WAIT_SECONDS = 180


def docker(*argv: str, timeout: float = 120.0) -> tuple[int, str, str]:
    try:
        p = subprocess.run(["docker", *argv], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)
    return p.returncode, p.stdout, p.stderr


def inspect(kind: str, name: str) -> dict | None:
    rc, out, _ = docker(kind, "inspect", name)
    if rc != 0:
        return None
    try:
        data = json.loads(out)
    except ValueError:
        return None
    return data[0] if isinstance(data, list) and data else None


def user_env(container: dict, image: dict | None) -> list[str]:
    """컨테이너의 환경변수 중 사용자가 준 것 — 그 이미지가 정한 값과 같은 것, 버전을 가리키는 것은 뺀다."""
    image_env = set((image or {}).get("Config", {}).get("Env") or [])
    return [item for item in (container.get("Config") or {}).get("Env") or []
            if item not in image_env and item.split("=", 1)[0] not in DROP_ENV]


def plan_create(container: dict, old_image: dict | None, new_image: str, version: str | None = None,
                env: list[str] | None = None) -> tuple[list[str], list[tuple[str, list[str]]]]:
    """옛 컨테이너의 구성 → (`docker create` 인자, 나중에 붙일 네트워크 [(이름, 별칭들)]).

    version 을 주면 `JW_INSTALLER_VERSION` 으로 넣는다 — 새 설치 관리자가 자신을 그 제품 버전으로 안다(app/bundle.py)."""
    name = str(container.get("Name") or "").lstrip("/")
    config = container.get("Config") or {}
    host = container.get("HostConfig") or {}
    argv = ["create", "--name", name]

    policy = host.get("RestartPolicy") or {}
    if policy.get("Name") and policy["Name"] != "no":
        value = policy["Name"]
        if value == "on-failure" and policy.get("MaximumRetryCount"):
            value += f":{policy['MaximumRetryCount']}"
        argv += ["--restart", value]

    for port, bindings in sorted((host.get("PortBindings") or {}).items()):
        for b in bindings or []:
            ip = b.get("HostIp") or ""
            spec = f"{b.get('HostPort', '')}:{port}"
            argv += ["-p", f"{ip}:{spec}" if ip and ip not in ("0.0.0.0", "::") else spec]

    for bind in host.get("Binds") or []:
        argv += ["-v", bind]

    for item in (user_env(container, old_image) if env is None else env):
        if item.split("=", 1)[0] not in DROP_ENV:
            argv += ["-e", item]
    if version:
        argv += ["-e", f"JW_INSTALLER_VERSION={version}"]

    for opt in host.get("SecurityOpt") or []:
        argv += ["--security-opt", opt]
    for extra in host.get("ExtraHosts") or []:
        argv += ["--add-host", extra]

    short_id = str(container.get("Id") or "")[:12]
    hostname = str(config.get("Hostname") or "")
    networks = []
    for net, settings in sorted(((container.get("NetworkSettings") or {}).get("Networks") or {}).items()):
        aliases = [a for a in (settings.get("Aliases") or []) if a not in (short_id, hostname)]
        networks.append((net, aliases))
    first = next((n for n in networks if n[0] == "bridge"), networks[0] if networks else None)
    if first is not None:
        argv += ["--network", first[0]]
        if first[0] != "bridge":
            for alias in first[1]:
                argv += ["--network-alias", alias]
    argv.append(new_image)
    return argv, [n for n in networks if n is not first]


def swap(container_ref: str, new_image: str, expect_version: str, log, env: list[str] | None = None) -> str | None:
    """교체한다. 성공하면 None, 실패하면 이유(옛 컨테이너는 되살려 둔다)."""
    old = inspect("container", container_ref)
    if old is None:
        return "container not found"
    name = str(old.get("Name") or "").lstrip("/")
    if inspect("image", new_image) is None:
        return "image not found"
    argv, networks = plan_create(old, inspect("image", old.get("Image") or ""), new_image, expect_version, env)
    prev = f"{name}-prev"
    docker("rm", "-f", prev)
    log(f"옛 설치 관리자({name})를 멈춥니다")
    docker("stop", "-t", "20", old["Id"], timeout=90)
    rc, _, err = docker("rename", old["Id"], prev)
    if rc != 0:
        docker("start", old["Id"])
        return f"rename failed: {err.strip()[-200:]}"

    def restore(reason: str) -> str:
        log(f"교체 실패 — {reason}. 옛 설치 관리자를 되살립니다")
        docker("rm", "-f", name)
        docker("rename", prev, name)
        docker("start", name)
        return reason

    rc, _, err = docker(*argv)
    if rc != 0:
        return restore(f"create failed: {err.strip()[-200:]}")
    for net, aliases in networks:
        args = ["network", "connect"]
        for alias in aliases:
            args += ["--alias", alias]
        rc, _, err = docker(*args, net, name)
        if rc != 0:
            return restore(f"network connect failed: {err.strip()[-200:]}")
    rc, _, err = docker("start", name)
    if rc != 0:
        return restore(f"start failed: {err.strip()[-200:]}")
    log("새 설치 관리자를 시작했습니다 — 준비를 기다립니다")
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        state = (inspect("container", name) or {}).get("State") or {}
        health = (state.get("Health") or {}).get("Status", "")
        if state.get("Running") and health in ("", "healthy"):
            rc, out, _ = docker("exec", name, "python", "-c",
                                "from pathlib import Path;from app.bundle import Bundle;"
                                "print(Bundle(Path('/app/bundle')).version)")
            if rc == 0 and out.strip() == expect_version:
                docker("rm", "-f", prev)
                log(f"설치 관리자를 {expect_version} 으로 바꿨습니다")
                return None
            if rc == 0:
                return restore(f"version mismatch: {out.strip()[:40]}")
        if state and not state.get("Running") and not state.get("Restarting"):
            return restore("new container exited")
        time.sleep(2)
    return restore("new container not ready")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="update_swap")
    p.add_argument("--container", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--expect-version", required=True)
    p.add_argument("--result", required=True)
    p.add_argument("--log")
    p.add_argument("--env-json")
    args = p.parse_args(argv)

    def log(text: str) -> None:
        line = f"{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} [swap] {text}"
        print(line, flush=True)
        if args.log:
            try:
                with open(args.log, "a", encoding="utf-8", newline="") as f:
                    f.write(line + "\n")
            except OSError:
                pass

    time.sleep(1)      # 부른 쪽이 상태를 디스크에 다 쓸 틈
    env = None
    if args.env_json:
        try:
            with open(args.env_json, encoding="utf-8") as f:
                env = [str(x) for x in json.load(f)]
        except (OSError, ValueError):
            env = None
    error = swap(args.container, args.image, args.expect_version, log, env)
    try:
        with open(args.result, "w", encoding="utf-8") as f:
            json.dump({"ok": error is None, "error": error, "version": args.expect_version}, f)
    except OSError:
        pass
    return 0 if error is None else 1


if __name__ == "__main__":
    sys.exit(main())
