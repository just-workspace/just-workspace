#!/usr/bin/env python3
"""릴리스 도구 실행기 — 설치 없이 `python release/tools/jwrelease.py <명령>` 으로 실행한다.

`cd release && python -m jwrelease <명령>` 과 동일하다. 요구 사항: Python 3.10+, `cryptography`.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jwrelease.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
