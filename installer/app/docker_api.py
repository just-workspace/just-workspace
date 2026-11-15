"""docker·호스트 접근 — 설치 관리자가 바깥을 건드리는 유일한 문.

- 모든 호출은 `Runner.run(argv)` 하나로 나간다. argv 는 **인자 배열**이고 셸을 거치지 않는다.
- 테스트는 `Runner` 를 가짜로 바꿔 어떤 명령이 어떤 순서로 나갔는지 본다(tests/fakes.py).
- compose 는 늘 같은 앞머리로 부른다 — 경로 해석은 app/paths.py 와 docs/installer.md.

      docker compose -p just-workspace
          --project-directory <호스트의 스택 폴더>      # bind mount 의 상대 경로가 호스트 경로가 된다
          -f /data/stack/docker-compose.yml             # 설치 관리자 컨테이너 안에서 읽는 파일
          -f /data/stack/docker-compose.site.yml
          --env-file /data/stack/.env
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from dataclasses import dataclass
from typing import Callable, Protocol

from app.paths import NETWORK_NAME, PROJECT_NAME, SITE_COMPOSE, Paths



@dataclass
class Result:
    rc: int
    out: str = ""
    err: str = ""

    @property
    def ok(self) -> bool:
        return self.rc == 0

    @property
    def text(self) -> str:
        return (self.out + ("\n" if self.out and self.err else "") + self.err).strip()


class Runner(Protocol):
    def run(self, argv: list[str], *, input: str | None = None, timeout: float = 120.0,
            on_line: Callable[[str], None] | None = None) -> Result: ...


class SubprocessRunner:
    """실제 docker CLI. argv 의 첫 원소는 `docker` 다음에 오는 것(`["ps", "-a"]`)."""

    def __init__(self, binary: str = "docker"):
        self.binary = binary

    def run(self, argv, *, input=None, timeout=120.0, on_line=None) -> Result:
        cmd = [self.binary, *[str(a) for a in argv]]
        try:
            proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            )
        except OSError as e:
            return Result(127, "", f"docker 를 실행하지 못했습니다: {e}")

        out_lines: list[str] = []
        err_lines: list[str] = []

        def pump(stream, sink):
            for line in stream:
                sink.append(line)
                if on_line:
                    try:
                        on_line(line.rstrip("\n"))
                    except Exception:  # noqa: BLE001 — 진행 표시 실패가 명령을 깨면 안 된다
                        pass

        threads = [threading.Thread(target=pump, args=(proc.stdout, out_lines), daemon=True),
                   threading.Thread(target=pump, args=(proc.stderr, err_lines), daemon=True)]
        for t in threads:
            t.start()
        try:
            if input is not None:
                proc.stdin.write(input)
                proc.stdin.close()
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            for t in threads:
                t.join(2)
            return Result(124, "".join(out_lines), "".join(err_lines) + "\n시간 초과")
        except OSError as e:
            proc.kill()
            return Result(1, "".join(out_lines), f"{e}")
        for t in threads:
            t.join(5)
        return Result(proc.returncode or 0, "".join(out_lines), "".join(err_lines))


class Docker:
    def __init__(self, runner: Runner, paths: Paths, *, self_ref: str | None = None):
        self.runner = runner
        self.paths = paths
        # 설치 관리자 자신의 컨테이너(기본: 호스트 이름 = 컨테이너 id). 보조 컨테이너를 같은 이미지로 띄운다.
        self.self_ref = self_ref or os.environ.get("JW_SELF") or os.environ.get("HOSTNAME") or "jw-installer"
        self._self_image: str | None = None

    def run(self, argv: list[str], **kw) -> Result:
        return self.runner.run(argv, **kw)

    # ─── 데몬 ───

    def info(self) -> dict:
        r = self.run(["info", "--format", "{{json .}}"], timeout=30)
        if not r.ok:
            return {}
        try:
            return json.loads(r.out)
        except ValueError:
            return {}

    def compose_version(self) -> str:
        r = self.run(["compose", "version", "--short"], timeout=30)
        return r.out.strip() if r.ok else ""

    # ─── compose ───

    def compose_prefix(self) -> list[str]:
        stack = self.paths.stack
        argv = ["compose", "-p", PROJECT_NAME, "--project-directory", self.paths.host_stack,
                "-f", f"{stack.as_posix()}/docker-compose.yml"]
        # 사이트별 조각(렌더링)과, 파일로 들여온 이미지의 이름 조각(오프라인 업데이트 — app/update_engine.py)
        for extra in (SITE_COMPOSE, "docker-compose.pins.yml"):
            if (stack / extra).exists():
                argv += ["-f", f"{stack.as_posix()}/{extra}"]
        argv += ["--env-file", f"{stack.as_posix()}/.env"]
        return argv

    def compose(self, *args: str, timeout: float = 600.0, on_line=None, input=None) -> Result:
        return self.run([*self.compose_prefix(), *args], timeout=timeout, on_line=on_line, input=input)

    # ─── 컨테이너 ───

    def inspect(self, kind: str, name: str) -> dict | None:
        r = self.run([kind, "inspect", name], timeout=30)
        if not r.ok:
            return None
        try:
            data = json.loads(r.out)
        except ValueError:
            return None
        return data[0] if isinstance(data, list) and data else None

    def container_status(self, name: str) -> dict:
        """{"exists", "running", "health"} — health 는 healthcheck 가 없으면 ""."""
        data = self.inspect("container", name)
        if not data:
            return {"exists": False, "running": False, "health": ""}
        state = data.get("State", {})
        return {"exists": True, "running": bool(state.get("Running")),
                "health": (state.get("Health") or {}).get("Status", "")}

    def exec(self, container: str, argv: list[str], *, user: str | None = None, env_file: str | None = None,
             input: str | None = None, timeout: float = 120.0) -> Result:
        cmd = ["exec"]
        if input is not None:
            cmd.append("-i")
        if user:
            cmd += ["--user", user]
        if env_file:
            cmd += ["--env-file", env_file]
        return self.run([*cmd, container, *argv], input=input, timeout=timeout)

    def self_image(self) -> str:
        """설치 관리자 자신의 이미지 id — 보조 컨테이너에 쓴다(따로 받을 필요가 없다)."""
        if self._self_image is None:
            data = self.inspect("container", self.self_ref)
            self._self_image = (data or {}).get("Image") or os.environ.get("JW_SELF_IMAGE") or ""
        return self._self_image

    def helper(self, helper_args: list[str], *, mounts: list[str] | None = None, volumes: list[str] | None = None,
               network: str = "none", user: str | None = None, timeout: float = 120.0) -> Result:
        """설치 관리자 이미지로 일회용 보조 컨테이너를 띄워 `python -m app.helper …` 를 돌린다.

        mounts: `--mount` 값(bind — 출발지가 없으면 실패한다) / volumes: `-v` 값(이름 붙은 볼륨)
        """
        image = self.self_image()
        if not image:
            return Result(125, "", "설치 관리자 이미지를 찾지 못했습니다")
        argv = ["run", "--rm", "--network", network, "--security-opt", "no-new-privileges:true",
                "--entrypoint", "python"]
        if user:
            argv += ["--user", user]
        for m in mounts or []:
            argv += ["--mount", m]
        for vol in volumes or []:
            argv += ["-v", vol]
        return self.run([*argv, image, "-m", "app.helper", *helper_args], timeout=timeout)

    # ─── 이미지 · 볼륨 · 네트워크 ───

    def image_exists(self, ref: str) -> bool:
        return self.run(["image", "inspect", "--format", "{{.Id}}", ref], timeout=30).ok

    def pull(self, ref: str, on_line=None, timeout: float = 3600.0) -> Result:
        return self.run(["pull", ref], timeout=timeout, on_line=on_line)

    def volume_inspect(self, name: str) -> dict | None:
        return self.inspect("volume", name)

    def volume_create(self, name: str, opts: dict[str, str] | None = None, labels: dict[str, str] | None = None) -> Result:
        argv = ["volume", "create", "--driver", "local"]
        for key, value in (opts or {}).items():
            argv += ["--opt", f"{key}={value}"]
        for key, value in (labels or {}).items():
            argv += ["--label", f"{key}={value}"]
        return self.run([*argv, name], timeout=60)

    def volume_rm(self, name: str) -> Result:
        return self.run(["volume", "rm", name], timeout=60)

    def networks(self) -> list[dict]:
        """[{"name", "subnets": [...]}] — 내부 대역 충돌 점검용."""
        r = self.run(["network", "ls", "--format", "{{.Name}}"], timeout=30)
        out = []
        for name in [n for n in r.out.split() if n] if r.ok else []:
            data = self.inspect("network", name) or {}
            subnets = [c.get("Subnet") for c in ((data.get("IPAM") or {}).get("Config") or []) if c.get("Subnet")]
            out.append({"name": name, "subnets": subnets})
        return out

    def published_ports(self) -> dict[str, list[str]]:
        """{컨테이너 이름: ["0.0.0.0:80->80/tcp", …]} — 우리 컨테이너가 쓰는 포트인지 가릴 때."""
        r = self.run(["ps", "--format", "{{.Names}}\t{{.Ports}}"], timeout=30)
        out: dict[str, list[str]] = {}
        for line in r.out.splitlines() if r.ok else []:
            name, _, ports = line.partition("\t")
            out[name] = [p.strip() for p in ports.split(",") if p.strip()]
        return out

    def connect_self(self, alias: str) -> Result:
        """설치 관리자 자신을 워크스페이스 내부망에 붙인다(이미 붙어 있으면 그대로)."""
        data = self.inspect("container", self.self_ref) or {}
        if NETWORK_NAME in ((data.get("NetworkSettings") or {}).get("Networks") or {}):
            return Result(0, "already connected")
        return self.run(["network", "connect", "--alias", alias, NETWORK_NAME, self.self_ref], timeout=60)
