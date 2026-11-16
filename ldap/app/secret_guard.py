"""기동 전 비밀값 검사 — 취약한 값이나 기본값이면 기동하지 않는다.

규칙은 backend/app/security_defaults.py 와 동일하다(본 서비스는 backend 코드를 포함하지 않아
축약 사본을 둔다): 비어 있음 · 예시 자리표시자(CHANGE_ME…) · 널리 알려진 기본값 · 길이 미달
(키 32자, 비밀번호 16자). 값은 출력하지 않는다 — 변수 이름과 사유만 출력한다.

예외 경로: JW_ALLOW_INSECURE_DEFAULTS=1 이면 경고만 기록하고 계속 진행한다(개발·테스트 전용).
"""

from __future__ import annotations

import logging
import os
from urllib.parse import unquote, urlsplit

logger = logging.getLogger("secret-guard")

ALLOW_ENV = "JW_ALLOW_INSECURE_DEFAULTS"
KEY_MIN = 32
PASSWORD_MIN = 16

_PLACEHOLDER_PREFIXES = ("changeme", "replaceme", "yoursecret", "pleasechange")
_KNOWN_DEFAULTS = frozenset({
    "devkey", "secret", "changeme", "change-me", "change_me", "password", "passwd", "pass",
    "admin", "administrator", "root", "test", "testing", "default", "example", "demo",
    "workspace", "portal", "postgres", "123456", "12345678", "1234567890", "qwerty", "letmein",
})


def weakness(value: str, min_len: int, *, required: bool = True) -> str | None:
    """거부 사유(없으면 None)."""
    if not value:
        return "비어 있음" if required else None
    squashed = "".join(ch for ch in value.lower() if ch.isalnum())
    if squashed.startswith(_PLACEHOLDER_PREFIXES):
        return "예시 자리표시자(CHANGE_ME…) 그대로임"
    if value.lower() in _KNOWN_DEFAULTS:
        return "널리 알려진 기본값임"
    if len(value) < min_len:
        return f"너무 짧음({len(value)}자, 최소 {min_len}자)"
    if len(set(value)) < 6:
        return "같은 글자의 반복임"
    return None


def db_password(url: str) -> str | None:
    """DATABASE_URL 의 비밀번호. PostgreSQL 이 아니면 None."""
    try:
        p = urlsplit(url)
    except ValueError:
        return None
    if not p.scheme.startswith("postgres"):
        return None
    return unquote(p.password or "")


def enforce(checks: list[tuple[str, str, int, bool]]) -> bool:
    """checks: (변수 이름, 값, 최소 길이, 필수). 문제가 없거나 예외 경로가 활성화되어 있으면 True."""
    problems = [(name, reason) for name, value, min_len, required in checks
                if (reason := weakness(value, min_len, required=required))]
    if not problems:
        return True
    allowed = os.environ.get(ALLOW_ENV, "").strip().lower() in ("1", "true", "yes", "on")
    for name, reason in problems:
        if allowed:
            logger.warning("[security] 경고(무시하고 계속) — %s: %s", name, reason)
        else:
            logger.error("[security] 거부 — %s: %s", name, reason)
    if allowed:
        logger.warning("[security] %s 가 켜져 있어 위 값으로 계속합니다 — 운영에서는 끄세요", ALLOW_ENV)
        return True
    logger.error("[security] 약한·기본 비밀값으로는 시작하지 않습니다 — .env 를 고친 뒤 다시 띄우세요")
    return False
