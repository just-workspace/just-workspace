"""docker·호스트 접근 — 설치 관리자가 외부에 접근하는 유일한 경로.

- 모든 호출은 `Runner.run(argv)` 하나를 경유한다. argv 는 **인자 배열**이며 셸을 거치지 않는다.
- 테스트는 `Runner` 를 모의 객체로 교체하여 명령의 내용과 호출 순서를 검증한다(tests/fakes.py).
- compose 는 항상 동일한 접두 인자로 호출한다 — 경로 해석은 app/paths.py 와 docs/installer.md.

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



# docker CLI 에 전달하지 않는 환경변수. compose 는 `--env-file` 보다 실행 측의 환경변수를 우선한다 — 설치 관리자
# 컨테이너의 값이 스택의 `.env`(버전·저장소·프로파일)를 덮어써서는 안 된다.
COMPOSE_SHADOWED = ("JW_REGISTRY", "JW_VERSION", "JW_APP_VERSION", "COMPOSE_PROFILES", "COMPOSE_FILE")


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
    """실제 docker CLI. argv 의 첫 원소는 `docker` 다음에 오는 인자(`["ps", "-a"]`)."""

    def __init__(self, binary: str = "docker"):
        self.binary = binary

    def run(self, argv, *, input=None, timeout=120.0, on_line=None) -> Result:
        cmd = [self.binary, *[str(a) for a in argv]]
        env = {k: v for k, v in os.environ.items() if k not in COMPOSE_SHADOWED}
        try:
            proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=env,
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
                    except Exception:  # noqa: BLE001 — 진행 표시 실패가 명령 실패로 이어져서는 안 됨
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
        # 설치 관리자 자체 컨테이너(기본: 호스트 이름 = 컨테이너 id). 보조 컨테이너를 동일 이미지로 기동한다.
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
        # 사이트별 조각(렌더링)과, 파일로 반입한 이미지의 이름 조각(오프라인 업데이트 — app/update_engine.py)
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
        """설치 관리자 자체 이미지 id — 보조 컨테이너에 사용한다(별도 pull 불필요)."""
        if self._self_image is None:
            data = self.inspect("container", self.self_ref)
            self._self_image = (data or {}).get("Image") or os.environ.get("JW_SELF_IMAGE") or ""
        return self._self_image

    def helper(self, helper_args: list[str], *, mounts: list[str] | None = None, volumes: list[str] | None = None,
               network: str = "none", user: str | None = None, timeout: float = 120.0) -> Result:
        """설치 관리자 이미지로 일회용 보조 컨테이너를 기동하여 `python -m app.helper …` 를 실행한다.

        mounts: `--mount` 값(bind — 원본 경로가 없으면 실패) / volumes: `-v` 값(이름 있는 볼륨)
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
        """{컨테이너 이름: ["0.0.0.0:80->80/tcp", …]} — 본 프로젝트 컨테이너가 사용하는 포트인지 판별할 때 사용."""
        r = self.run(["ps", "--format", "{{.Names}}\t{{.Ports}}"], timeout=30)
        out: dict[str, list[str]] = {}
        for line in r.out.splitlines() if r.ok else []:
            name, _, ports = line.partition("\t")
            out[name] = [p.strip() for p in ports.split(",") if p.strip()]
        return out

    def connect_self(self, alias: str) -> Result:
        """설치 관리자 자신을 워크스페이스 내부망에 연결한다(이미 연결되어 있으면 유지)."""
        data = self.inspect("container", self.self_ref) or {}
        if NETWORK_NAME in ((data.get("NetworkSettings") or {}).get("Networks") or {}):
            return Result(0, "already connected")
        return self.run(["network", "connect", "--alias", alias, NETWORK_NAME, self.self_ref], timeout=60)
