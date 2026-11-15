"""주소 설정값 — 릴리스가 놓이는 곳을 한 군데에서 정한다.

기본값은 GitHub 조직 `just-workspace` 기준이다. 다른 곳으로 옮기면 설정 파일(JSON, `--config`)이나
환경변수(`JWRELEASE_<대문자 이름>`)로 덮는다 — 도구의 코드는 바뀌지 않는다.
우선순위: 환경변수 > 설정 파일 > 기본값.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Mapping

ENV_PREFIX = "JWRELEASE_"


@dataclass(frozen=True)
class Settings:
    # 우리 이미지가 올라가는 레지스트리(호스트/네임스페이스). compose 의 JW_REGISTRY 와 같은 값.
    registry: str = "ghcr.io/just-workspace"
    # 이미지 이름 앞머리 — `<registry>/<image_prefix><서비스>`. compose 의 이미지 이름과 맞춘다.
    image_prefix: str = "just-workspace-"
    # 채널 파일·manifest 를 내려받는 기준 주소(채널 리포의 정적 파일). 뒤에 `channels/stable.json` 등이 붙는다.
    channel_base_url: str = "https://raw.githubusercontent.com/just-workspace/releases/main"
    # 채널 리포(사람이 커밋·푸시하는 곳) — 안내 출력에만 쓴다.
    channel_repo_url: str = "https://github.com/just-workspace/releases"
    # 소스 리포 — 제품 화면의 "소스 코드" 링크가 가리키는 기본 주소(backend/app/source.py 와 같은 값).
    source_repo_url: str = "https://github.com/just-workspace/just-workspace"
    # 설치 파일·오프라인 묶음 첨부의 기준 주소. `{version}` 과 `{filename}` 이 채워진다.
    download_url_template: str = "https://github.com/just-workspace/just-workspace/releases/download/v{version}/{filename}"
    # 채널 파일 만료까지의 날 수.
    expires_days: int = 90

    def image_repository(self, service: str) -> str:
        return f"{self.registry.rstrip('/')}/{self.image_prefix}{service}"

    def download_url(self, version: str, filename: str) -> str:
        return self.download_url_template.format(version=version, filename=filename)

    def channel_url(self, rel_path: str) -> str:
        return f"{self.channel_base_url.rstrip('/')}/{rel_path}"


def load_settings(config_file: Path | None = None, env: Mapping[str, str] | None = None) -> Settings:
    settings = Settings()
    names = {f.name: f.type for f in fields(Settings)}
    if config_file is not None:
        raw = json.loads(config_file.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("설정 파일은 JSON 객체여야 한다")
        unknown = sorted(set(raw) - set(names))
        if unknown:
            raise ValueError(f"설정 파일에 모르는 항목: {unknown}")
        settings = replace(settings, **{k: _coerce(k, v) for k, v in raw.items()})
    for name in names:
        value = (env or {}).get(ENV_PREFIX + name.upper())
        if value:
            settings = replace(settings, **{name: _coerce(name, value)})
    if settings.expires_days < 1:
        raise ValueError("expires_days 는 1 이상이어야 한다")
    return settings


def _coerce(name: str, value):
    if name == "expires_days":
        return int(value)
    if not isinstance(value, str) or not value:
        raise ValueError(f"설정 `{name}` 은 비어 있지 않은 문자열이어야 한다")
    return value
