"""가짜 docker — 어떤 명령이 어떤 순서로 나갔는지 기록하고, 정해 둔 답을 돌려준다."""

from __future__ import annotations

import json
from pathlib import Path

from app.docker_api import Docker, Result
from app.paths import Paths


def seq(*tokens: str):
    """argv 안에 tokens 가 이 순서로 나오면 참(사이에 다른 인자가 있어도 된다)."""
    def match(argv: list[str]) -> bool:
        i = 0
        for arg in argv:
            if i < len(tokens) and arg == tokens[i]:
                i += 1
        return i == len(tokens)
    return match


class FakeRunner:
    def __init__(self):
        self.calls: list[list[str]] = []
        self.inputs: list[str | None] = []
        self.rules: list[tuple] = []

    def on(self, *tokens: str, out: str = "", rc: int = 0, err: str = "", fn=None, lines: list[str] | None = None):
        """tokens 가 순서대로 든 명령에 대한 답. 나중에 건 규칙이 먼저 본다(덮어쓰기)."""
        self.rules.insert(0, (seq(*tokens), out, rc, err, fn, lines))
        return self

    def run(self, argv, *, input=None, timeout=120.0, on_line=None) -> Result:
        argv = [str(a) for a in argv]
        self.calls.append(argv)
        self.inputs.append(input)
        for match, out, rc, err, fn, lines in self.rules:
            if match(argv):
                if fn is not None:
                    result = fn(argv, input)
                    if isinstance(result, Result):
                        return result
                    return Result(0, result or "", "")
                for line in lines or []:
                    if on_line:
                        on_line(line)
                return Result(rc, out, err)
        return Result(0, "", "")

    # ─── 기록 조회 ───

    def find(self, *tokens: str) -> list[list[str]]:
        match = seq(*tokens)
        return [c for c in self.calls if match(c)]

    def index(self, *tokens: str) -> int:
        match = seq(*tokens)
        for i, c in enumerate(self.calls):
            if match(c):
                return i
        raise AssertionError(f"명령이 나가지 않았습니다: {tokens}\n" + "\n".join(" ".join(c) for c in self.calls))

    def joined(self) -> list[str]:
        return [" ".join(c) for c in self.calls]


def make_paths(tmp_path: Path, host_dir: str = "/opt/just-workspace") -> Paths:
    paths = Paths(data=tmp_path / "data", host_dir=host_dir, bundle=None)
    paths.ensure_dirs()
    return paths


def make_docker(tmp_path: Path, runner: FakeRunner | None = None) -> tuple[Docker, FakeRunner, Paths]:
    runner = runner or FakeRunner()
    paths = make_paths(tmp_path)
    runner.on("container", "inspect", "jw-self", out=json.dumps([{"Image": "sha256:selfimage", "NetworkSettings": {"Networks": {}}}]))
    docker = Docker(runner, paths, self_ref="jw-self")
    return docker, runner, paths


DOCKER_INFO = {
    "ServerVersion": "27.3.1", "NCPU": 4, "MemTotal": 16 * 1024 ** 3, "Architecture": "x86_64",
    "SecurityOptions": ["name=seccomp,profile=builtin"], "DockerRootDir": "/var/lib/docker", "OSType": "linux",
}


def healthy_host(runner: FakeRunner, *, info: dict | None = None, ports: dict | None = None,
                 routes: list | None = None, networks: dict | None = None, free_gb: float = 200) -> FakeRunner:
    """사전 점검이 전부 통과하는 서버."""
    runner.on("info", "--format", out=json.dumps({**DOCKER_INFO, **(info or {})}))
    runner.on("compose", "version", "--short", out="2.29.7\n")
    runner.on("app.helper", "disk", out=json.dumps({"free_bytes": int(free_gb * 1024 ** 3)}) + "\n")
    runner.on("app.helper", "host-probe", out=json.dumps({
        "ports": ports or {"80": "free", "443": "free", "25": "free"},
        "routes": routes if routes is not None else [{"dest": "192.168.10.0/24", "iface": "eth0"},
                                                    {"dest": "172.17.0.0/16", "iface": "docker0"}],
        "outbound_address": "192.168.10.20", "selinux": "",
    }) + "\n")
    nets = networks if networks is not None else {"bridge": ["172.17.0.0/16"], "host": [], "none": []}
    runner.on("network", "ls", out="\n".join(nets) + "\n")
    for name, subnets in nets.items():
        runner.on("network", "inspect", name, out=json.dumps([{"IPAM": {"Config": [{"Subnet": s} for s in subnets]}}]))
    runner.on("ps", "--format", out="")
    return runner
