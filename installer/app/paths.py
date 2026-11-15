"""경로 — 컨테이너 안 경로와 호스트 경로를 한곳에서 정한다.

설치 관리자는 컨테이너 안에서 돌고, `docker compose` 가 만드는 컨테이너는 호스트에서 돈다.
같은 폴더를 두 이름으로 부르게 되므로 어느 쪽 이름인지 헷갈리지 않게 여기서만 만든다.

| 뜻 | 컨테이너 안 | 호스트 |
|---|---|---|
| 데이터 뿌리 | `/data` (`Paths.data`) | `$JW_HOST_DIR` (`Paths.host_dir`) |
| 스택(compose·설정·.env) | `/data/stack` (`Paths.stack`) | `$JW_HOST_DIR/stack` (`Paths.host_stack`) |
| 상태·로그·비밀 답변 | `/data/state` (`Paths.state`) | `$JW_HOST_DIR/state` |

- 설치 관리자 프로세스가 **파일을 읽고 쓸 때**는 컨테이너 안 경로를 쓴다.
- docker 데몬이 해석하는 값(bind mount 의 출발지, compose 의 `--project-directory`)에는 **호스트 경로**를 쓴다.
- compose 는 서비스의 `env_file: .env` 를 `--project-directory` 기준으로 **compose 를 실행한 쪽에서** 읽는다.
  그래서 기동할 때 컨테이너 안에 `$JW_HOST_DIR` → `/data` 심볼릭 링크를 만들어, 호스트 경로 문자열이
  컨테이너 안에서도 같은 파일을 가리키게 한다(`ensure_host_alias`).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

DEFAULT_DATA = "/data"
DEFAULT_BUNDLE = "/app/bundle"
PROJECT_NAME = "just-workspace"       # compose 프로젝트 이름(폴더 이름 stack 을 따르지 않게 고정)
NETWORK_NAME = f"{PROJECT_NAME}_workspace"
SITE_COMPOSE = "docker-compose.site.yml"   # 리포의 compose 에 덧붙이는 사이트별 조각(렌더링이 만든다)


@dataclass(frozen=True)
class Paths:
    data: Path              # 컨테이너 안 데이터 뿌리
    host_dir: str           # 같은 폴더의 호스트 경로(POSIX 문자열)
    bundle: Path | None     # 이미지에 든 번들. None 이면 리포에서 직접 읽는다(개발·테스트)

    @property
    def stack(self) -> Path:
        return self.data / "stack"

    @property
    def state(self) -> Path:
        return self.data / "state"

    @property
    def logs(self) -> Path:
        return self.state / "logs"

    @property
    def env_file(self) -> Path:
        return self.stack / ".env"

    @property
    def host_stack(self) -> str:
        return str(PurePosixPath(self.host_dir) / "stack")

    def ensure_dirs(self) -> None:
        for d in (self.stack, self.state, self.logs):
            d.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.state, 0o700)
            os.chmod(self.stack, 0o700)
        except OSError:
            pass


def from_env(env: dict[str, str] | None = None) -> Paths:
    env = dict(os.environ) if env is None else env
    data = Path(env.get("JW_DATA_DIR") or DEFAULT_DATA)
    host_dir = (env.get("JW_HOST_DIR") or str(data)).rstrip("/") or "/"
    bundle_dir = Path(env.get("JW_BUNDLE_DIR") or DEFAULT_BUNDLE)
    return Paths(data=data, host_dir=host_dir, bundle=bundle_dir if bundle_dir.is_dir() else None)


class HostAliasError(RuntimeError):
    pass


def ensure_host_alias(paths: Paths) -> None:
    """컨테이너 안에 `$JW_HOST_DIR` → 데이터 뿌리 심볼릭 링크를 만든다(이미 같으면 그대로).

    호스트 경로가 컨테이너 안에 이미 다른 것으로 있으면(예: `/usr`) 설치를 계속할 수 없다.
    """
    host = PurePosixPath(paths.host_dir)
    if not host.is_absolute():
        raise HostAliasError("JW_HOST_DIR 는 절대 경로여야 합니다")
    link = Path(str(host))
    target = paths.data
    if link == target:
        return
    try:
        if link.is_symlink():
            if Path(os.readlink(link)) == target:
                return
            raise HostAliasError(f"{link} 가 이미 다른 곳을 가리킵니다")
        if link.exists():
            if link.resolve() == target.resolve():
                return
            raise HostAliasError(
                f"JW_HOST_DIR({link}) 와 같은 경로가 설치 관리자 컨테이너 안에 이미 있습니다 — 다른 폴더를 쓰세요"
            )
        link.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, link, target_is_directory=True)
    except OSError as e:
        raise HostAliasError(f"{link} 링크를 만들지 못했습니다: {e}") from e
