"""비밀값 표 — 기동 검사와 생성기가 공용으로 참조한다.

제3자가 예시 파일을 그대로 복사해 기동하더라도 위험한 값으로는 기동되지 않도록 한다.

- `SECRETS`: 변수 이름·최소 길이·필수 여부·해당 비밀값을 사용하는 기능. 검사(`check`)와 생성기
  (`generate`, `python -m app.cli gen-secrets`)가 이 표 하나에서 파생되므로 양자 간 불일치가 발생하지 않는다.
- 검사는 기동 경로(entrypoint 의 `check-secrets`, lifespan)에서만 수행한다. import·단위 테스트는
  영향을 받지 않는다.
- 예외 경로: `JW_ALLOW_INSECURE_DEFAULTS=1` 이면 거부 대신 경고만 기록한다(개발·테스트 전용).

값은 어디에도 출력하지 않는다 — 변수 이름과 사유만 출력한다.

본 모듈은 표준 라이브러리만 사용한다(설정·구역은 호출 시점에 조회한다).
"""

from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping
from urllib.parse import unquote, urlsplit

logger = logging.getLogger(__name__)

ALLOW_ENV = "JW_ALLOW_INSECURE_DEFAULTS"

KEY_MIN = 32        # 서명·토큰 키
PASSWORD_MIN = 16   # 비밀번호류

# 자리표시자 접두어(대소문자·구분자 무시)
_PLACEHOLDER_PREFIXES = ("changeme", "replaceme", "yoursecret", "pleasechange")

# 예시·튜토리얼·이미지 기본값으로 널리 알려진 값(소문자 비교)
KNOWN_DEFAULTS = frozenset({
    "devkey", "secret", "changeme", "change-me", "change_me", "password", "passwd", "pass",
    "admin", "administrator", "root", "test", "testing", "default", "example", "demo",
    "workspace", "portal", "postgres", "redis", "livekit", "onlyoffice",
    "ultrasecretkey", "change-me-onlyoffice", "please-change-this-secret-key-32chars",
    "123456", "12345678", "1234567890", "qwerty", "letmein",
})

# 서로 다른 문자 수가 이 값 미만이면(동일 문자 반복 등) 난수로 간주하지 않음
_MIN_DISTINCT = 6


@dataclass(frozen=True)
class SecretSpec:
    env: str                    # 환경변수 이름
    min_len: int                # 최소 길이(0 = 길이 검사 생략 — 외부에서 발급받은 값)
    required: bool = False      # 해당 기능이 활성화된 상태에서 값이 비어 있으면 거부
    zone: str = "core"          # 이 비밀값을 사용하는 구역("chat+meetings" 처럼 결합 지정 가능)
    flag: str = ""              # 추가 기능 플래그(환경변수, 참일 때만 검사)
    generate: bool = True       # gen-secrets 의 기본 생성 대상 여부(False = --only 로 지정한 경우에만 생성)
    gen_len: int = 0            # 생성 길이(16진수 글자 수, 0 = 최소 길이 기준 기본값)
    forbid: str = ""            # 포함 불가 문자(해당 값을 다른 스크립트가 치환·삽입하는 경우)
    note: str = ""


# 순서 = gen-secrets 출력 순서
SECRETS: tuple[SecretSpec, ...] = (
    SecretSpec("SECRET_KEY", KEY_MIN, required=True, note="세션·토큰 서명 키"),
    # 비우면 내부 API 전체가 차단된다(안전한 방향) — 따라서 필수가 아니다. 설정하는 경우 강한 값이어야 한다.
    # 메일 서버 패치 스크립트가 sed 로 치환하므로 구분자·역참조 문자를 금지한다.
    SecretSpec("INTERNAL_API_KEY", KEY_MIN, forbid="|&\\/ \t'\"", note="내부 서비스(메일 로그인·LDAP) → 백엔드"),
    SecretSpec("DB_PASSWORD", PASSWORD_MIN, required=True, note="PostgreSQL 비밀번호"),
    SecretSpec("LIVEKIT_API_KEY", 16, zone="meetings", gen_len=16, note="회의 서버 API 키(식별자)"),
    SecretSpec("LIVEKIT_API_SECRET", KEY_MIN, zone="meetings", note="회의 서버 API 비밀값"),
    SecretSpec("AUDIORELAY_SECRET", KEY_MIN, zone="chat+meetings", note="무손실 음성 릴레이 토큰 키"),
    SecretSpec("DOVECOT_MASTER_PASSWORD", PASSWORD_MIN, zone="mail", note="내장 메일 서버 마스터 비밀번호"),
    SecretSpec("ONLYOFFICE_JWT_SECRET", KEY_MIN, zone="docs", note="오피스 편집기 JWT"),
    SecretSpec("SANDBOX_TOKEN", KEY_MIN, zone="ai", note="분석 샌드박스 공유 비밀"),
    SecretSpec("DOCCONV_TOKEN", KEY_MIN, zone="ai", note="문서 변환 공유 비밀"),
    SecretSpec("SEARXNG_SECRET", KEY_MIN, zone="ai", note="웹 검색 컨테이너 비밀값"),
    # ── 이하는 해당 기능 사용 시에만 설정(기본 생성 대상 아님, --only 로 생성 가능) ──
    SecretSpec("MCP_API_KEY", KEY_MIN, zone="ai", flag="MCP_INTERNAL_TOOLS_ENABLED", generate=False,
               note="MCP 내부 도구 정적 키"),
    SecretSpec("GITEA_WEBHOOK_SECRET", KEY_MIN, zone="chat", generate=False, note="Git 웹훅 서명 키"),
    SecretSpec("LDAP_SERVICE_PASSWORD", PASSWORD_MIN, zone="sso", generate=False, note="LDAP 동기화 서비스 계정"),
    # 외부 SMTP 계정일 수 있어 길이는 검사하지 않음(자리표시자·알려진 기본값만 거부)
    SecretSpec("SMTP_PASSWORD", 0, generate=False, note="발신 SMTP 계정 비밀번호"),
)

_BY_ENV = {s.env: s for s in SECRETS}


def spec(name: str) -> SecretSpec:
    return _BY_ENV[name]


def names(*, default_only: bool = False) -> list[str]:
    return [s.env for s in SECRETS if s.generate or not default_only]


# ─── 단일 값 판정 ───


def is_placeholder(value: str) -> bool:
    """예시 파일의 자리표시자(CHANGE_ME…) 여부."""
    squashed = "".join(ch for ch in value.lower() if ch.isalnum())
    return squashed.startswith(_PLACEHOLDER_PREFIXES)


def weakness(s: SecretSpec, value: str) -> str | None:
    """값의 거부 사유(없으면 None). 사유 문구에 값은 포함하지 않는다."""
    if not value:
        return "비어 있음" if s.required else None
    if value != value.strip():
        return "앞뒤에 공백이 있음"
    if is_placeholder(value):
        return "예시 자리표시자(CHANGE_ME…) 그대로임"
    if value.lower() in KNOWN_DEFAULTS:
        return "널리 알려진 기본값임"
    if s.min_len and len(value) < s.min_len:
        return f"너무 짧음({len(value)}자, 최소 {s.min_len}자)"
    if s.min_len and len(set(value)) < _MIN_DISTINCT:
        return "같은 글자의 반복임"
    bad = sorted({ch for ch in value if ch in s.forbid})
    if bad:
        shown = " ".join("공백" if ch in " \t" else ch for ch in bad)
        return f"사용할 수 없는 문자가 들어 있음({shown})"
    return None


# ─── 기동 검사 ───


@dataclass(frozen=True)
class Problem:
    env: str
    reason: str

    def line(self) -> str:
        return f"{self.env}: {self.reason}"


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


def allow_insecure(env: Mapping[str, str] | None = None) -> bool:
    return _truthy((os.environ if env is None else env).get(ALLOW_ENV))


def _db_password_from_url(url: str) -> str | None:
    """DATABASE_URL 의 비밀번호. PostgreSQL 이 아니면(테스트용 SQLite 등) None."""
    try:
        p = urlsplit(url)
    except ValueError:
        return None
    if not p.scheme.startswith("postgres"):
        return None
    return unquote(p.password or "")


def _applies(s: SecretSpec, env: Mapping[str, str], zone_ok: Callable[[str], bool]) -> bool:
    if not zone_ok(s.zone):
        return False
    if s.flag and not _truthy(env.get(s.flag)):
        return False
    return True


def check(
    env: Mapping[str, str] | None = None,
    *,
    database_url: str | None = None,
    zone_ok: Callable[[str], bool] | None = None,
) -> list[Problem]:
    """사용 중인 비밀값 가운데 거부 대상 목록. 비활성화된 기능의 비밀값은 검사하지 않는다.

    env: 변수 → 값(기본: 프로세스 환경 + 설정 파일에서 읽은 값).
    database_url: PostgreSQL 이면 포함된 비밀번호를 DB_PASSWORD 로 검사한다.
    zone_ok: 구역 조건("mail", "chat+meetings")의 충족 여부(기본: app.zones).
    """
    if env is None:
        env, database_url = _runtime_env()
    if zone_ok is None:
        from app import zones
        zone_ok = zones.requirement_met

    problems: list[Problem] = []
    for s in SECRETS:
        if not _applies(s, env, zone_ok):
            continue
        if s.env == "DB_PASSWORD":
            url_pw = _db_password_from_url(database_url or "")
            if url_pw is None:
                continue  # PostgreSQL 이 아님 — 비밀번호 없음
            values = {url_pw, env.get(s.env, "") or url_pw}
        else:
            values = {env.get(s.env, "")}
        for value in values:
            reason = weakness(s, value)
            if reason:
                problems.append(Problem(s.env, reason))
                break
    return problems


def _runtime_env() -> tuple[dict[str, str], str]:
    """프로세스 환경 + 설정(.env 파일로만 읽힌 값 포함)."""
    from app.config import get_settings

    settings = get_settings()
    env = dict(os.environ)
    for s in SECRETS:
        if not env.get(s.env):
            value = getattr(settings, s.env.lower(), "")
            if isinstance(value, str) and value:
                env[s.env] = value
    if not env.get("MCP_INTERNAL_TOOLS_ENABLED") and getattr(settings, "mcp_internal_tools_enabled", False):
        env["MCP_INTERNAL_TOOLS_ENABLED"] = "true"
    return env, settings.database_url


class InsecureDefaults(RuntimeError):
    """위험한 기본값·취약한 비밀값으로 인한 기동 거부."""

    def __init__(self, problems: list[Problem]):
        self.problems = problems
        super().__init__(
            "위험한 비밀값으로는 시작하지 않습니다: " + ", ".join(p.env for p in problems)
        )


HELP = (
    "비밀값 만들기: python -m app.cli gen-secrets --merge .env --in-place "
    "(컨테이너 밖이면 docker run --rm -v \"$PWD/.env:/work/.env\" <backend 이미지> "
    "python -m app.cli gen-secrets --merge /work/.env --in-place)"
)


def enforce(problems: list[Problem] | None = None, *, emit: Callable[[str], None] | None = None) -> list[Problem]:
    """문제가 있으면 변수별로 한 줄씩 기록하고 `InsecureDefaults` 예외를 발생시킨다.

    `JW_ALLOW_INSECURE_DEFAULTS=1` 이면 동일한 줄을 경고로만 기록하고 반환한다.
    """
    if problems is None:
        problems = check()
    if not problems:
        return problems
    allowed = allow_insecure()
    out = emit or (logger.warning if allowed else logger.error)
    prefix = "[security] 경고(무시하고 계속)" if allowed else "[security] 거부"
    for p in problems:
        out(f"{prefix} — {p.line()}")
    if allowed:
        out(f"[security] {ALLOW_ENV} 가 켜져 있어 위 값으로 계속합니다 — 운영에서는 끄세요")
        return problems
    out(f"[security] {HELP}")
    raise InsecureDefaults(problems)


# ─── 생성기 ───


def _hex(length: int) -> str:
    """16진수 문자 `length` 개 — 셸·sed·URL 어디에 삽입해도 이스케이프가 불필요하다."""
    return secrets.token_hex((length + 1) // 2)[:length]


def generate_one(name: str) -> str:
    s = _BY_ENV[name]
    # 최소 길이의 1.5배(키 48자 = 192비트, 비밀번호 32자 = 128비트). 길이 제한이 없는 값은 비밀번호 기준 적용.
    length = s.gen_len or max((s.min_len or PASSWORD_MIN) * 3 // 2, 32)
    while True:
        value = _hex(length)
        if weakness(s, value) is None:   # 드물게 문자 종류가 부족하게 생성되면 재생성
            return value


def generate(only: Iterable[str] | None = None) -> dict[str, str]:
    """비밀값을 신규 생성한다. only 가 없으면 기본 생성 대상 전체(표 순서)."""
    wanted = list(only) if only else names(default_only=True)
    unknown = [n for n in wanted if n not in _BY_ENV]
    if unknown:
        raise KeyError(", ".join(unknown))
    return {n: generate_one(n) for n in wanted}


# ─── .env 병합 ───


def _parse_line(line: str) -> tuple[str, str] | None:
    """`KEY=value` 줄 → (KEY, value). 주석·빈 줄·그 밖은 None."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, _, value = stripped.partition("=")
    key = key.strip()
    if key.startswith("export "):
        key = key[len("export "):].strip()
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return key, value


def merge_env(text: str, only: Iterable[str] | None = None) -> tuple[str, list[str]]:
    """.env 내용에서 **비어 있는(또는 자리표시자인) 비밀값만** 채운다.

    이미 값이 있는 줄은 변경하지 않는다. 파일에 없는 변수는 끝에 추가한다.
    반환값: (새 내용, 채운 변수 이름 목록).
    """
    wanted = list(only) if only else names(default_only=True)
    unknown = [n for n in wanted if n not in _BY_ENV]
    if unknown:
        raise KeyError(", ".join(unknown))

    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines()
    filled: dict[str, str] = {}
    replaced: dict[str, str] = {}   # 기존 자리표시자 값 → 새 값(다른 줄에 포함되어 있으면 함께 치환)
    seen: set[str] = set()

    for i, line in enumerate(lines):
        parsed = _parse_line(line)
        if parsed is None:
            continue
        key, value = parsed
        if key not in wanted or key in seen:
            continue
        seen.add(key)
        if value and not is_placeholder(value):
            continue
        new = generate_one(key)
        lines[i] = f"{key}={new}"
        filled[key] = new
        if value and key == "DB_PASSWORD":
            replaced[value] = new

    # DATABASE_URL 처럼 비밀번호 자리표시자가 그대로 포함된 줄 — 동일 값으로 치환
    if replaced:
        for i, line in enumerate(lines):
            parsed = _parse_line(line)
            if parsed is None or parsed[0] in filled:
                continue
            for old, new in replaced.items():
                if f":{old}@" in line:
                    lines[i] = line.replace(f":{old}@", f":{new}@")

    missing = [n for n in wanted if n not in seen]
    if missing:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("# ─── gen-secrets 가 덧붙인 비밀값 ───")
        for name in missing:
            new = generate_one(name)
            lines.append(f"{name}={new}")
            filled[name] = new

    return newline.join(lines) + newline, list(filled)
