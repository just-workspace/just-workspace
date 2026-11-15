"""`.env` 읽기·쓰기 — docker compose 의 dotenv 규칙에 맞춘 이스케이프.

compose 는 따옴표 없는 값과 큰따옴표 값 안의 `${...}` 를 **치환**하고, 따옴표 없는 값의 ` #` 뒤를
주석으로 버린다. 그래서 값은 세 가지 꼴 중 하나로만 쓴다.

1. 안전한 글자뿐이면 그대로(`KEY=value`)
2. 그 밖에는 작은따옴표(`KEY='value'`) — 안쪽은 글자 그대로다(치환·이스케이프 없음)
3. 값에 작은따옴표가 들어 있으면 큰따옴표 + 역슬래시 이스케이프(`\\\\`, `\\"`, `\\$`)

줄바꿈·NUL 이 든 값은 받지 않는다(한 줄에 담을 수 없다).
"""

from __future__ import annotations

import re

_BARE = re.compile(r"[A-Za-z0-9_@%+=:,./\-]*")
_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class EnvValueError(ValueError):
    pass


def quote(value: str) -> str:
    """값 하나를 compose 가 원래대로 읽는 꼴로."""
    if not isinstance(value, str):
        value = str(value)
    if any(ch in value for ch in ("\n", "\r", "\x00")):
        raise EnvValueError("줄바꿈이 든 값은 .env 에 쓸 수 없습니다")
    if _BARE.fullmatch(value):
        return value
    if "'" not in value:
        return "'" + value + "'"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
    return '"' + escaped + '"'


def unquote(raw: str) -> str:
    """`quote` 의 역 — 이 모듈이 쓴 파일을 다시 읽을 때 쓴다."""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == "'":
        return raw[1:-1]
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        out, i, body = [], 0, raw[1:-1]
        while i < len(body):
            if body[i] == "\\" and i + 1 < len(body):
                out.append(body[i + 1])
                i += 2
            else:
                out.append(body[i])
                i += 1
        return "".join(out)
    return raw


def render(sections: list[tuple[str, list[tuple[str, str]]]]) -> str:
    """[(제목, [(키, 값), …]), …] → 파일 내용. 키 이름도 검사한다."""
    lines = [
        "# 설치 관리자가 만든 파일입니다. 손으로 고친 값은 다음 적용 때 덮어씁니다.",
        "# 값을 바꾸려면 설치 관리자(관리 화면)를 쓰세요.",
    ]
    seen: set[str] = set()
    for title, pairs in sections:
        if not pairs:
            continue
        lines.append("")
        lines.append(f"# ─── {title} ───")
        for key, value in pairs:
            if not _KEY.fullmatch(key):
                raise EnvValueError(f"변수 이름이 올바르지 않습니다: {key!r}")
            if key in seen:
                raise EnvValueError(f"변수가 두 번 나옵니다: {key}")
            seen.add(key)
            lines.append(f"{key}={quote(value)}")
    return "\n".join(lines) + "\n"


def parse(text: str) -> dict[str, str]:
    """파일 내용 → {키: 값}. 주석·빈 줄은 건너뛴다."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, raw = stripped.partition("=")
        key = key.strip()
        if _KEY.fullmatch(key):
            values[key] = unquote(raw)
    return values


def update(text: str, changes: dict[str, str]) -> str:
    """기존 내용에서 몇 개 값만 바꾼다 — 있는 줄은 그 자리에서, 없는 키는 끝에 덧붙인다."""
    remaining = dict(changes)
    out: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.partition("=")[0].strip()
            if key in remaining:
                out.append(f"{key}={quote(remaining.pop(key))}")
                continue
        out.append(line)
    for key, value in remaining.items():
        if not _KEY.fullmatch(key):
            raise EnvValueError(f"변수 이름이 올바르지 않습니다: {key!r}")
        out.append(f"{key}={quote(value)}")
    return "\n".join(out) + "\n"
