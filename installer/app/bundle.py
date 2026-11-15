"""번들 — 이미지에 실어 온 compose·설정 파일·구역 선언·비밀값 표.

단일 출처를 복제하지 않는다. 번들의 파일은 **빌드할 때 리포에서 복사**한 것이고(`MANIFEST`,
`python -m app.bundle build`), 개발·테스트에서는 번들 폴더 없이 리포에서 바로 읽는다.

- `zones.json` ← `backend/app/zones.json` (구역 id·메모리·포트·compose 프로파일)
- `security_defaults.py` ← `backend/app/security_defaults.py` (비밀값 이름·길이·금지 문자, 생성기)
- `VERSION` ← 리포 루트 `VERSION`
- 나머지는 compose 가 bind mount 하는 파일들
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from functools import cached_property
from pathlib import Path

# 번들 안 경로 → 리포 안 경로
MANIFEST: dict[str, str] = {
    "docker-compose.yml": "docker-compose.yml",
    "VERSION": "VERSION",
    "zones.json": "backend/app/zones.json",
    "security_defaults.py": "backend/app/security_defaults.py",
    "nginx/nginx.conf": "nginx/nginx.conf",
    "nginx/security-headers.conf": "nginx/security-headers.conf",
    "init/init-db.sh": "init/init-db.sh",
    "scripts/certbot-entrypoint.sh": "scripts/certbot-entrypoint.sh",
    "mailserver/config/user-patches.sh": "mailserver/config/user-patches.sh",
    "mailserver/config/auth-workspace.lua": "mailserver/config/auth-workspace.lua",
    "mailserver/config/dovecot.cf": "mailserver/config/dovecot.cf",
}

# 번들에서 스택으로 **그대로** 복사하는 파일(렌더링이 내용을 바꾸지 않는다)
STACK_COPIES: tuple[str, ...] = (
    "docker-compose.yml",
    "nginx/nginx.conf",
    "nginx/security-headers.conf",
    "init/init-db.sh",
    "scripts/certbot-entrypoint.sh",
    "mailserver/config/user-patches.sh",
    "mailserver/config/auth-workspace.lua",
    "mailserver/config/dovecot.cf",
)

DEV_VERSION = "0.0.0-dev"


def repo_root() -> Path:
    """리포 루트(installer/app/bundle.py 기준 두 단계 위)."""
    return Path(__file__).resolve().parents[2]


class BundleError(RuntimeError):
    pass


class Bundle:
    """번들 폴더(이미지) 또는 리포(개발)에서 파일을 읽는다."""

    def __init__(self, root: Path | None = None, repo: Path | None = None):
        self.root = root
        self.repo = repo or repo_root()

    def path(self, name: str) -> Path:
        if name not in MANIFEST:
            raise BundleError(f"번들에 없는 파일: {name}")
        if self.root is not None:
            return self.root / name
        return self.repo / MANIFEST[name]

    def read(self, name: str) -> str:
        try:
            return self.path(name).read_text(encoding="utf-8")
        except OSError as e:
            raise BundleError(f"번들 파일을 읽지 못했습니다: {name} ({e})") from e

    @cached_property
    def zones(self) -> dict:
        return json.loads(self.read("zones.json"))

    @cached_property
    def version(self) -> str:
        try:
            value = self.read("VERSION").strip()
        except BundleError:
            return DEV_VERSION
        return value or DEV_VERSION

    @cached_property
    def security_defaults(self):
        """backend 의 비밀값 표 모듈(표준 라이브러리만 쓴다) — 파일에서 바로 불러온다."""
        path = self.path("security_defaults.py")
        spec = importlib.util.spec_from_file_location("jw_bundle_security_defaults", path)
        if spec is None or spec.loader is None:
            raise BundleError("비밀값 표를 불러오지 못했습니다")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module      # dataclass 가 모듈을 찾을 수 있어야 한다
        spec.loader.exec_module(module)
        return module

    @cached_property
    def gitea_verified_image(self) -> str:
        """compose 에 고정한 Gitea 이미지(검증한 버전) — `${GITEA_IMAGE:-<이것>}` 에서 읽는다."""
        import re

        m = re.search(r"\$\{GITEA_IMAGE:-([^}\s]+)\}", self.read("docker-compose.yml"))
        if not m:
            raise BundleError("compose 에서 Gitea 고정 이미지를 찾지 못했습니다")
        return m.group(1)


def build(repo: Path, dest: Path) -> list[str]:
    """리포에서 번들 폴더를 만든다(이미지 빌드 때 한 번)."""
    written = []
    for name, src in MANIFEST.items():
        source = repo / src
        if not source.is_file():
            raise BundleError(f"리포에 없는 파일: {src}")
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        written.append(name)
    return written


def _main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[0] == "build":
        names = build(Path(argv[1]), Path(argv[2]))
        print(f"bundle: {len(names)} files → {argv[2]}")
        return 0
    print("usage: python -m app.bundle build <리포 경로> <번들 폴더>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
