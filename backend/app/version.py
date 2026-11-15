"""제품 버전 — 단일 출처는 리포 루트의 `VERSION` 파일.

읽는 순서:
1. 환경변수 `JW_APP_VERSION`(빌드·배포가 주입한 값)
2. 이미지에 구워 넣은 `/app/VERSION`(Dockerfile 의 빌드 인자 `JW_APP_VERSION`)
3. 소스 체크아웃의 리포 루트 `VERSION`(개발·테스트)
4. 아무것도 없으면 개발 표기 `0.0.0-dev`

설치 관리자(installer/)도 같은 `VERSION` 파일을 번들에 실어 쓴다.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

DEV_VERSION = "0.0.0-dev"
_VALID = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+\-]{0,63}")


def _clean(raw: str | None) -> str:
    value = (raw or "").strip()
    if value.startswith("v") and len(value) > 1 and value[1].isdigit():
        value = value[1:]          # 태그 이름(v1.0.0)을 그대로 넘겨도 된다
    return value if _VALID.fullmatch(value) else ""


def read_version(env: dict[str, str] | None = None, here: Path | None = None) -> str:
    env = os.environ if env is None else env
    value = _clean(env.get("JW_APP_VERSION"))
    if value:
        return value
    here = Path(__file__).resolve() if here is None else here
    # here = <root>/app/version.py → 이미지에서는 /app/VERSION, 체크아웃에서는 <리포>/VERSION
    for candidate in (here.parents[1] / "VERSION", here.parents[2] / "VERSION"):
        try:
            value = _clean(candidate.read_text(encoding="utf-8"))
        except OSError:
            continue
        if value:
            return value
    return DEV_VERSION


APP_VERSION = read_version()
