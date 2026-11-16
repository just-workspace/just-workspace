"""적용 엔진 테스트용 모의 서버 — 설치가 끝까지 완료되는 docker 응답 한 세트."""

from __future__ import annotations

import json
from pathlib import Path

from app import api, certs
from app.docker_api import Result
from tests.conftest import make_answers
from tests.fakes import FakeRunner, healthy_host, make_paths

IMAGES = ["postgres:16", "redis:8", "nginx:1.31", "localhost/just-workspace-backend:1.0.0"]


class FakeHttp:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.responses: dict[str, int] = {}

    def get(self, url, headers=None, timeout=10.0):
        self.calls.append((url, dict(headers or {})))
        for prefix, status in self.responses.items():
            if url.startswith(prefix):
                return status, ""
        return 200, ""


class Host:
    """모의 호스트 — 볼륨·인증서·컨테이너 상태를 유지한다."""

    def __init__(self, tmp_path: Path):
        self.runner = FakeRunner()
        self.paths = make_paths(tmp_path)
        self.http = FakeHttp()
        self.volumes: dict[str, dict] = {}
        self.cert: str | None = None
        self.running: set[str] = set()
        self.unhealthy: set[str] = set()
        self.certbot_ok = True
        self.marker = {"status": "written"}
        self.services = ["postgres", "redis", "backend", "frontend-react", "nginx"]
        healthy_host(self.runner)
        r = self.runner
        r.on("container", "inspect", fn=self._container)
        r.on("volume", "inspect", fn=self._volume_inspect)
        r.on("volume", "create", fn=self._volume_create)
        r.on("compose", "config", "--images", out="\n".join(IMAGES) + "\n")
        r.on("compose", "config", "--services", fn=lambda argv, i: "\n".join(self.services) + "\n")
        r.on("compose", "up", fn=self._up)
        r.on("compose", "stop", fn=self._stop)
        r.on("restart", fn=lambda argv, i: "")
        r.on("app.helper", "write-marker", fn=lambda argv, i: json.dumps(self.marker) + "\n")
        r.on("app.helper", "read-cert", fn=lambda argv, i: json.dumps({"cert": self.cert}) + "\n")
        r.on("app.helper", "place-cert", fn=self._place)
        r.on("compose", "run", "certbot", fn=self._certbot)
        r.on("compose", "run", "backend", "migrate", out="스키마 버전 1 → 3\n")
        r.on("exec", "ws-backend", "seed-admin", out="[SEED] Admin 'admin' created\n")

    def _container(self, argv, _):
        name = argv[-1]
        if name == "jw-self":
            return json.dumps([{"Image": "sha256:selfimage", "NetworkSettings": {"Networks": {}}}])
        if name not in self.running:
            return Result(1, "", "No such container")
        health = "unhealthy" if name in self.unhealthy else "healthy"
        return json.dumps([{"State": {"Running": True, "Health": {"Status": health}}}])

    def _volume_inspect(self, argv, _):
        vol = self.volumes.get(argv[-1])
        return json.dumps([vol]) if vol is not None else Result(1, "", "no such volume")

    def _volume_create(self, argv, _):
        opts = {}
        for i, a in enumerate(argv):
            if a == "--opt":
                k, _, val = argv[i + 1].partition("=")
                opts[k] = val
        self.volumes[argv[-1]] = {"Name": argv[-1], "Options": opts or None}
        return ""

    def _up(self, argv, _):
        names = argv[argv.index("up") + 1:]
        for svc in [n for n in names if not n.startswith("-")]:
            self.running.add(f"ws-{svc}")
        return ""

    def _stop(self, argv, _):
        for svc in argv[argv.index("stop") + 1:]:
            self.running.discard(f"ws-{svc}")
        return ""

    def _place(self, argv, stdin):
        if stdin:
            self.cert = json.loads(stdin)["cert"]
        return json.dumps({"status": "placed", "linked": [], "skipped": []}) + "\n"

    def _certbot(self, argv, _):
        if not self.certbot_ok:
            return Result(1, "", "Challenge failed for domain ws.example.com")
        names = [argv[i + 1] for i, a in enumerate(argv) if a == "-d"]
        issued, _key = certs.self_signed(names, days=90)
        # 실제 발급과 동일하게 보이려면 발급자가 다른 인증서가 필요하다 → 자체 서명 판정을 우회한다
        self.cert = issued
        self.issued_by_ca = True
        return "Successfully received certificate.\n"

    # ─── 조립 ───

    def services_obj(self, **kw) -> api.Services:
        kw.setdefault("http", self.http)
        kw.setdefault("sleep", lambda s: None)
        kw.setdefault("preflight_kwargs", {"reach": lambda url: True, "clock": lambda: True,
                                           "data_free_bytes": lambda: 300 * 1024 ** 3})
        svc = api.build_services(self.paths, runner=self.runner, registry="localhost", image_tag="1.0.0", **kw)
        svc.docker.self_ref = "jw-self"
        return svc

    def install(self, svc: api.Services | None = None, **answers) -> api.Services:
        """응답(answers)을 저장하고 감지값을 채운 서비스 집합."""
        svc = svc or self.services_obj()
        svc.store.save_answers(make_answers(**answers))
        svc.store.update_facts(memory_mb=16384, cpus=4, public_ip="203.0.113.10", dns_status="match")
        return svc
