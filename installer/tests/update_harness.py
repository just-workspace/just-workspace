"""업데이트 엔진 테스트용 — 가짜 채널(실행할 때마다 만든 임시 키로 서명)과 설치가 끝난 가짜 서버.

키는 테스트마다 새로 만든다. 리포에는 어떤 키도 두지 않는다.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app import api, api_update
from app import update_release as rel
from app.docker_api import Result
from app.update_engine import UpdateManager
from jwrelease import bundle as jwbundle
from jwrelease import sign
from jwrelease.model import Manifest, ReleaseEntry, format_time, manifest_rel_path, new_channel, sha256_hex
from tests.conftest import SECRETS
from tests.harness import Host

T0 = datetime(2026, 1, 12, 1, 30, 0, tzinfo=timezone.utc)
BASE = "https://releases.example.com"
REG = "registry.example.com/jw"
DIGEST = "sha256:" + "ab" * 32
OUR = ("backend", "frontend-react", "mailserver", "installer")
THIRD = {"core": {"postgres": f"postgres@sha256:{'11' * 32}", "redis": f"redis@sha256:{'22' * 32}",
                  "nginx": f"nginx@sha256:{'33' * 32}"},
         "docs": {"onlyoffice": f"onlyoffice/documentserver@sha256:{'44' * 32}"},
         "git": {"gitea": f"gitea/gitea@sha256:{'55' * 32}"}}


class Killed(BaseException):
    """설치 관리자 프로세스가 (자기 교체로) 멈춘 것을 흉내 낸다."""


class Releases:
    """가짜 채널 리포 — 주소 → 바이트."""

    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.files: dict[str, bytes] = {}
        self.channels = {"stable": new_channel("stable"), "beta": new_channel("beta")}
        self.manifests: dict[str, Manifest] = {}
        self.fetched: list[str] = []
        self.down = False

    @property
    def public_pem(self) -> bytes:
        return sign.public_key_pem(self.key)

    def manifest(self, version: str, published: datetime, **over) -> Manifest:
        images = {n: f"{REG}/just-workspace-{n}@sha256:{sha256_hex((n + version).encode())}" for n in OUR}
        fields = dict(version=version, published=format_time(published), images=images,
                      third_party={z: dict(m) for z, m in THIRD.items()}, zones_sha256="0" * 64, zones_content={},
                      changelog=f"- {version} 의 변경", db_schema=1)
        fields.update(over)
        return Manifest(**fields)

    def publish(self, version: str, *, channels=("stable", "beta"), published: datetime | None = None,
                now: datetime = T0, key=None, **over) -> Manifest:
        manifest = self.manifest(version, published or now - timedelta(days=10), **over)
        raw = manifest.to_bytes()
        path = manifest_rel_path(version)
        self.files[f"{BASE}/{path}"] = raw
        self.files[f"{BASE}/{path}.sig"] = sign.sign_bytes(raw, key or self.key)
        self.manifests[version] = manifest
        entry = ReleaseEntry(version, manifest.published, path, sha256_hex(raw), manifest.min_upgrade_from,
                             f"{version} 요약")
        for name in channels:
            self.channels[name] = self.channels[name].with_release(entry)
            self.write_channel(name, now, key=key)
        return manifest

    def write_channel(self, name: str, now: datetime = T0, *, key=None, expires_days: int = 90) -> None:
        self.channels[name] = self.channels[name].bumped(now, expires_days)
        raw = self.channels[name].to_bytes()
        self.files[f"{BASE}/channels/{name}.json"] = raw
        self.files[f"{BASE}/channels/{name}.json.sig"] = sign.sign_bytes(raw, key or self.key)

    def fetch(self, url: str) -> bytes:
        self.fetched.append(url)
        if self.down or url not in self.files:
            raise rel.FetchError("unreachable")
        return self.files[url]

    def bundle(self, folder: Path, version: str, *, key=None, published: datetime | None = None, **over) -> Path:
        """오프라인 묶음 파일(우리 이미지만 — 내용은 가짜)."""
        manifest = self.manifest(version, published or T0 - timedelta(days=10), **over)
        self.manifests[version] = manifest
        stage = folder / f"stage-{version}"
        (stage / "images").mkdir(parents=True)
        raw = manifest.to_bytes()
        (stage / "manifest.json").write_bytes(raw)
        (stage / "manifest.json.sig").write_bytes(sign.sign_bytes(raw, key or self.key))
        for name in manifest.images:
            (stage / "images" / f"{name}.tar").write_bytes(f"image {name} {version}".encode())
        index = jwbundle.write_index(stage, T0)
        (stage / "bundle.json.sig").write_bytes(sign.sign_bytes(index, key or self.key))
        out = folder / jwbundle.bundle_filename(version)
        jwbundle.pack(stage, out)
        return out


class UpdateHost(Host):
    """설치가 끝난 가짜 서버(1.0.0, 협업 묶음)."""

    def __init__(self, tmp_path: Path, monkeypatch, *, version: str = "1.0.0"):
        super().__init__(tmp_path)
        monkeypatch.setenv("JW_UPDATE_CHANNEL_URL", BASE)
        monkeypatch.setenv("JW_UPDATE_PUBKEY_DIR", str(tmp_path / "no-keys"))
        self.releases = Releases()
        self.clock = T0
        self.posts: list[dict] = []
        self.images: dict[str, str] = {}
        self.schema = 1
        self.schema_required = 1
        self.backups: list[str] = []
        self.backup_schema: dict[str, int] = {}
        self.fail_pull: set[str] = set()
        self.fail_migrate = False
        self.fail_restore = False
        self.swap = "kill"            # kill(교체 성공 — 프로세스가 멈춘다) | none(보조 컨테이너가 아무것도 못 했다)
        self.swap_started = False
        self.flag_seen: list[bool] = []
        self.services = ["postgres", "redis", "backend", "frontend-react", "nginx", "mailserver", "onlyoffice"]
        self.running = {f"ws-{s}" for s in self.services}
        self.svc = self.install(self.services_obj())
        self.svc.store.update_env_secrets(dict(SECRETS))
        self.svc.store.set_phase("installed")
        self.write_env(version)
        (self.paths.stack / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
        for name in OUR:
            self.images[f"localhost/just-workspace-{name}:{version}"] = f"sha256:{name}-{version}"
        self.images["sha256:selfimage"] = "sha256:selfimage"       # 지금 도는 설치 관리자의 이미지
        r = self.runner
        r.on("image", "inspect", fn=self._image_inspect)
        r.on("pull", fn=self._pull)
        r.on("tag", fn=self._tag)
        r.on("load", "-i", fn=self._load)
        r.on("image", "ls", fn=lambda a, i: "\n".join(self.images) + "\n")
        r.on("image", "rm", fn=self._image_rm)
        r.on("exec", "ws-backend", "backup", "create", fn=self._backup)
        r.on("exec", "ws-backend", "migrate", "--status", fn=lambda a, i: json.dumps(
            {"required": self.schema_required, "current": self.schema, "pending": []}))
        r.on("compose", "run", "backend", "migrate", fn=self._migrate)
        r.on("compose", "run", "backend", "restore", fn=self._restore)
        r.on("compose", "run", "backend", "backup", "inspect", fn=lambda a, i: json.dumps(
            {"schema_version": self.backup_schema.get(a[a.index("inspect") + 1], 1)}))
        r.on("run", "cp -a /app/bundle/. /out/", fn=self._extract)
        r.on("run", "app.update_restack", fn=self._restack)
        r.on("run", "app.update_swap", fn=self._swap)
        r.on("run", "/etc/localtime:/etc/localtime:ro", out="32400\n")      # 서버 시간 = UTC+9

    # ─── 시계 ───

    def now(self) -> datetime:
        return self.clock

    def sleep(self, seconds: float) -> None:
        self.clock += timedelta(seconds=seconds)
        if self.swap_started and self.swap == "kill":
            self.swap_started = False
            raise Killed

    # ─── 가짜 docker ───

    def write_env(self, version: str) -> None:
        (self.paths.stack / ".env").write_text(
            f"JW_REGISTRY=localhost\nJW_VERSION={version}\nJW_APP_VERSION={version}\n", encoding="utf-8")

    def env_version(self) -> str:
        return re.search(r"^JW_VERSION=(.*)$", (self.paths.stack / ".env").read_text(encoding="utf-8"), re.M).group(1)

    def _image_inspect(self, argv, _):
        ref = argv[-1]
        if ref not in self.images:
            return Result(1, "", "No such image")
        return self.images[ref] + "\n" if "--format" in argv else json.dumps([{"Id": self.images[ref]}])

    def _pull(self, argv, _):
        ref = argv[-1]
        if any(part in ref for part in self.fail_pull):
            return Result(1, "", "manifest unknown")
        self.images[ref] = "sha256:" + sha256_hex(ref.encode())
        return ""

    def _tag(self, argv, _):
        self.images[argv[-1]] = self.images.get(argv[-2], "sha256:unknown")
        return ""

    def _load(self, argv, _):
        text = Path(argv[-1]).read_bytes().decode()
        m = re.fullmatch(r"image (\S+) (\S+)", text)
        if m:       # 묶음 안의 우리 이미지
            self.images[f"{REG}/just-workspace-{m.group(1)}:{m.group(2)}"] = f"sha256:{m.group(1)}-{m.group(2)}"
        elif text.startswith("tag "):       # 추가 이미지 파일 — 들어 있는 이름
            self.images[text[4:].strip()] = "sha256:loaded"
        return "Loaded image\n"

    def _image_rm(self, argv, _):
        self.images.pop(argv[-1], None)
        return ""

    def _backup(self, argv, _):
        self.flag_seen.append((self.paths.stack / "nginx/state/maintenance.on").exists())
        path = f"/backups/20260112_0130{len(self.backups):02d}-pre-update"
        self.backups.append(path)
        self.backup_schema[path] = self.schema
        return json.dumps({"path": path, "status": "success", "items": ["db", "config"], "size_bytes": 73400320,
                           "schema_version": self.schema, "product_version": self.env_version()})

    def _migrate(self, argv, _):
        if self.fail_migrate:
            self.schema += 1          # 앞 단계는 적용된 채 남는다
            return Result(1, "", "단계 3 실패: column does not exist")
        assert any(a.endswith("run-network.yml") for a in argv)      # 돌고 있는 backend 의 고정 주소와 겹치지 않게
        override = Path(argv[[i for i, a in enumerate(argv) if a == "--env-file"][-1] + 1]).read_text(encoding="utf-8")
        version = re.search(r"JW_VERSION=(.*)", override).group(1)
        self.schema = self.schema_required = int(self.releases.manifests[version].db_schema or self.schema)
        return "스키마 버전 적용\n"

    def _restore(self, argv, _):
        if self.fail_restore:
            return Result(1, json.dumps({"ok": False, "stage": "db-load", "error": "boom"}), "ERROR: 복원 실패")
        path = argv[argv.index("restore") + 1]
        self.schema = self.schema_required = self.backup_schema[path]
        return json.dumps({"ok": True, "items": ["db"]}) + "\n"

    def _extract(self, argv, _):
        version = argv[argv.index("-v") + 1].split(":")[0].rsplit("/", 1)[-1]
        dest = self.paths.state / "update" / "bundles" / version
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
        return ""

    def _restack(self, argv, _):
        version = next(a.split("=", 1)[1] for a in argv if a.startswith("JW_IMAGE_TAG="))
        self.write_env(version)
        return json.dumps({"version": version})

    def _swap(self, argv, _):
        self.swap_started = True
        return "container-id\n"

    # ─── 조립 ───

    def post(self, url: str, headers: dict, body: dict) -> int:
        self.posts.append({**body, "_key": headers.get("X-JW-Installer-Key")})
        return 200

    def install_keys(self, pem: bytes | None = None, name: str = "release.pub") -> None:
        folder = self.paths.state / "update" / "keys"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(pem or self.releases.public_pem)

    def manager(self, *, own_version: str | None = None, **kw) -> UpdateManager:
        """새 설치 관리자 프로세스의 엔진(상태는 디스크에서 이어진다)."""
        self.svc.cache.pop("updates", None)
        self.svc.cache.pop("offline", None)
        self.svc.cache["update_kwargs"] = dict(fetch=self.releases.fetch, post=self.post, now=self.now,
                                               sleep=self.sleep, free_bytes=lambda: 100 * 1024 ** 3,
                                               background=False, **kw)
        mgr = api_update.manager(self.svc)
        if own_version:
            mgr.own_version = own_version
        return mgr

    def event_types(self) -> list[str]:
        return [p["type"] for p in self.posts]


def run_to_end(host: UpdateHost, mgr: UpdateManager, call, *, final_version: str | None = None):
    """작업을 시작하고, 자기 교체로 프로세스가 멈출 때마다 새 설치 관리자로 이어받아 끝까지 돌린다.

    (마지막 엔진, 처음 만든 작업의 id) 를 돌려준다.
    """
    job_id = None
    try:
        job_id = call(mgr)["id"]
    except Killed:
        pass
    for _ in range(6):
        active = mgr.active()
        if active is None or active["status"] != "running":
            break
        handoff = active["ctx"].get("handoff") or {}
        if handoff.get("state") != "pending":
            break
        job_id = job_id or active.get("parent_job") or active["id"]
        mgr = host.manager(own_version=handoff["to"])
        try:
            mgr.resume()
        except Killed:
            pass
    if job_id is None:
        job_id = mgr.history_raw()[0]["id"]
    return mgr, job_id


def internal_client(host: UpdateHost):
    from starlette.testclient import TestClient

    client = TestClient(api.create_internal_app(host.svc), client=("172.28.0.20", 5000))
    client.headers[api.KEY_HEADER] = SECRETS["JW_INSTALLER_KEY"]
    return client
