"""비밀값 기동 검사 · 생성기(app/security_defaults.py, `python -m app.cli gen-secrets`).

- 예시 파일의 값 그대로이거나 알려진 기본값·짧은 값이면 거부한다.
- 비활성화된 기능의 비밀값은 검사하지 않는다.
- 생성기가 생성한 값은 검사를 통과한다(양쪽이 동일한 표에서 파생된다).
- 사유 문구·로그에 값이 노출되지 않는다.
"""

import json
import re
from pathlib import Path

import pytest

from app import cli
from app import security_defaults as sd

PG_URL = "postgresql+asyncpg://workspace:{pw}@postgres:5432/workspace"
REPO = Path(__file__).resolve().parents[2]
# backend/ 만 분리하여 실행하는 환경에는 리포 루트 파일이 없다 — 해당 둘만 생략한다
needs_repo = pytest.mark.skipif(
    not (REPO / ".env.example").is_file() or not (REPO / "docker-compose.yml").is_file(),
    reason="리포 루트(.env.example, docker-compose.yml)가 없다",
)


def _all_zones(_requirement: str) -> bool:
    return True


def _good_env(**over) -> dict[str, str]:
    env = sd.generate(sd.names())          # 표의 전체 항목(기본 생성 대상이 아닌 항목 포함)
    env["COMPOSE_PROFILES"] = "mailserver"
    env["MCP_INTERNAL_TOOLS_ENABLED"] = "true"
    env.update(over)
    return env


def _check(env, zone_ok=_all_zones):
    return sd.check(env, database_url=PG_URL.format(pw=env.get("DB_PASSWORD", "")), zone_ok=zone_ok)


def _names(problems) -> set[str]:
    return {p.env for p in problems}


# ─── 거부 ───


def test_generated_values_pass():
    assert _check(_good_env()) == []


def test_example_placeholders_rejected():
    env = _good_env(
        SECRET_KEY="CHANGE_ME_TO_RANDOM_SECRET",
        INTERNAL_API_KEY="CHANGE_ME",
        DB_PASSWORD="CHANGE_ME_TO_STRONG_PASSWORD",
        AUDIORELAY_SECRET="change-me-to-random-secret-please-0123456789",
    )
    assert _names(_check(env)) == {"SECRET_KEY", "INTERNAL_API_KEY", "DB_PASSWORD", "AUDIORELAY_SECRET"}


@pytest.mark.parametrize("name,value", [
    ("LIVEKIT_API_KEY", "devkey"),
    ("LIVEKIT_API_SECRET", "secret"),
    ("SECRET_KEY", "changeme"),
    ("DB_PASSWORD", "password"),
    ("DOVECOT_MASTER_PASSWORD", "admin"),
    ("DB_PASSWORD", "workspace"),
    ("SEARXNG_SECRET", "please-change-this-secret-key-32chars"),
    ("ONLYOFFICE_JWT_SECRET", "change-me-onlyoffice"),
    ("SMTP_PASSWORD", "CHANGE_ME"),
])
def test_known_defaults_rejected(name, value):
    assert name in _names(_check(_good_env(**{name: value})))


@pytest.mark.parametrize("name,value", [
    ("SECRET_KEY", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d"),      # 31자
    ("DB_PASSWORD", "a1b2c3d4e5f6a7b"),                       # 15자
    ("LIVEKIT_API_SECRET", "x9k2m4p7q1"),
    ("SECRET_KEY", "a" * 64),                                 # 길지만 동일 문자 반복
])
def test_short_or_trivial_rejected(name, value):
    assert name in _names(_check(_good_env(**{name: value})))


def test_required_empty_rejected_optional_empty_ok():
    env = _good_env(SECRET_KEY="", DB_PASSWORD="", INTERNAL_API_KEY="", LIVEKIT_API_KEY="", LIVEKIT_API_SECRET="",
                    ONLYOFFICE_JWT_SECRET="", SANDBOX_TOKEN="")
    # 필수 2개만 거부 — 나머지는 비어 있으면 해당 기능이 비활성화된다(안전한 방향)
    assert _names(_check(env)) == {"SECRET_KEY", "DB_PASSWORD"}


def test_database_url_password_is_checked_even_if_env_is_strong():
    env = _good_env()
    problems = sd.check(env, database_url=PG_URL.format(pw="workspace"), zone_ok=_all_zones)
    assert _names(problems) == {"DB_PASSWORD"}


def test_non_postgres_database_has_no_password_to_check():
    env = _good_env(DB_PASSWORD="")
    assert sd.check(env, database_url="sqlite+aiosqlite:///x.db", zone_ok=_all_zones) == []


def test_internal_key_rejects_characters_the_mail_patch_cannot_take():
    for bad in ("|", "&", "/", "\\", " "):
        value = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" + bad + "ff"
        assert "INTERNAL_API_KEY" in _names(_check(_good_env(INTERNAL_API_KEY=value)))


# ─── 비활성화된 기능은 검사하지 않음 ───


def test_disabled_zone_secrets_are_ignored():
    env = _good_env(LIVEKIT_API_KEY="devkey", LIVEKIT_API_SECRET="secret", AUDIORELAY_SECRET="short",
                    ONLYOFFICE_JWT_SECRET="CHANGE_ME", SANDBOX_TOKEN="x", DOVECOT_MASTER_PASSWORD="CHANGE_ME")
    only_core = lambda requirement: requirement == "core"  # noqa: E731
    assert _check(env, zone_ok=only_core) == []
    assert _names(_check(env)) == {"LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "AUDIORELAY_SECRET",
                                   "ONLYOFFICE_JWT_SECRET", "SANDBOX_TOKEN", "DOVECOT_MASTER_PASSWORD"}


def test_flag_gate():
    env = _good_env(MCP_API_KEY="short", MCP_INTERNAL_TOOLS_ENABLED="false")
    assert _check(env) == []
    env["MCP_INTERNAL_TOOLS_ENABLED"] = "true"
    assert _names(_check(env)) == {"MCP_API_KEY"}


def test_zone_gate_uses_installed_zones(monkeypatch):
    from app import zones

    env = _good_env(LIVEKIT_API_SECRET="secret")
    monkeypatch.setenv(zones.ENV_VAR, "mail,chat")
    assert sd.check(env, database_url=PG_URL.format(pw=env["DB_PASSWORD"])) == []
    monkeypatch.setenv(zones.ENV_VAR, "mail,meetings")
    assert _names(sd.check(env, database_url=PG_URL.format(pw=env["DB_PASSWORD"]))) == {"LIVEKIT_API_SECRET"}


# ─── 기동 중단 · 탈출구 · 값 비노출 ───


def test_enforce_raises_and_never_prints_values(monkeypatch):
    monkeypatch.delenv(sd.ALLOW_ENV, raising=False)
    secret = "CHANGE_ME_TO_RANDOM_SECRET"
    problems = _check(_good_env(SECRET_KEY=secret, LIVEKIT_API_SECRET="secret-value-too-short"))
    lines: list[str] = []
    with pytest.raises(sd.InsecureDefaults) as exc:
        sd.enforce(problems, emit=lines.append)
    text = "\n".join(lines) + str(exc.value)
    assert "SECRET_KEY" in text and "LIVEKIT_API_SECRET" in text
    assert secret not in text and "secret-value-too-short" not in text
    # 변수당 한 줄
    assert sum("거부 — SECRET_KEY" in line for line in lines) == 1
    assert sum("거부 — LIVEKIT_API_SECRET" in line for line in lines) == 1


def test_enforce_escape_hatch_only_warns(monkeypatch):
    problems = _check(_good_env(SECRET_KEY="x"))
    monkeypatch.setenv(sd.ALLOW_ENV, "1")
    lines: list[str] = []
    assert sd.enforce(problems, emit=lines.append) == problems
    assert any(sd.ALLOW_ENV in line for line in lines)
    monkeypatch.setenv(sd.ALLOW_ENV, "0")
    with pytest.raises(sd.InsecureDefaults):
        sd.enforce(problems, emit=lines.append)


def test_runtime_check_reads_settings_and_rejects_shipped_defaults(monkeypatch):
    """값을 채우지 않은 설정(코드 기본값)은 거부된다 — 운영 기본은 '거부'."""
    from app.config import Settings

    for name in sd.names():
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    defaults = Settings(_env_file=None)
    monkeypatch.setattr("app.config.get_settings", lambda: defaults)
    assert {"SECRET_KEY", "DB_PASSWORD"} <= _names(sd.check())


# ─── 생성기 ───


def test_generated_values_are_shell_and_sed_safe():
    values = sd.generate(sd.names())
    assert list(values) == sd.names()
    for name, value in values.items():
        assert re.fullmatch(r"[0-9a-f]+", value), name
        spec = sd.spec(name)
        assert len(value) >= max(spec.min_len, 16), name
        assert sd.weakness(spec, value) is None
    assert len(set(values.values())) == len(values)


def test_generate_defaults_and_only():
    default = sd.generate()
    assert "SECRET_KEY" in default and "DB_PASSWORD" in default and "SEARXNG_SECRET" in default
    assert "SMTP_PASSWORD" not in default and "MCP_API_KEY" not in default
    assert list(sd.generate(["MCP_API_KEY", "SECRET_KEY"])) == ["MCP_API_KEY", "SECRET_KEY"]
    with pytest.raises(KeyError):
        sd.generate(["NOPE"])


def test_merge_fills_only_empty_or_placeholder():
    keep = "0123456789abcdef0123456789abcdef0123456789abcdef"
    text = "\n".join([
        "# 주석",
        "APP_URL=https://ws.example.com",
        f"SECRET_KEY={keep}",
        "INTERNAL_API_KEY=",
        "DB_PASSWORD=CHANGE_ME_TO_STRONG_PASSWORD",
        "DATABASE_URL=postgresql+asyncpg://workspace:CHANGE_ME_TO_STRONG_PASSWORD@postgres:5432/workspace",
        "LIVEKIT_API_KEY=devkey",          # 값이 존재 — 변경하지 않음(검사에서 거부될 뿐)
        "",
    ])
    merged, filled = sd.merge_env(text)
    env = dict(line.split("=", 1) for line in merged.splitlines() if "=" in line and not line.startswith("#"))

    assert env["APP_URL"] == "https://ws.example.com"
    assert env["SECRET_KEY"] == keep and "SECRET_KEY" not in filled
    assert env["LIVEKIT_API_KEY"] == "devkey" and "LIVEKIT_API_KEY" not in filled
    assert {"INTERNAL_API_KEY", "DB_PASSWORD", "LIVEKIT_API_SECRET", "SEARXNG_SECRET"} <= set(filled)
    assert sd.weakness(sd.spec("INTERNAL_API_KEY"), env["INTERNAL_API_KEY"]) is None
    # DATABASE_URL 에 포함되어 있던 자리표시자도 동일한 비밀번호로 갱신
    assert env["DATABASE_URL"] == f"postgresql+asyncpg://workspace:{env['DB_PASSWORD']}@postgres:5432/workspace"
    assert "# 주석" in merged
    # 재실행 시 변경 없음(멱등)
    again, filled_again = sd.merge_env(merged)
    assert again == merged and filled_again == []


def test_merge_only_and_line_endings():
    merged, filled = sd.merge_env("SECRET_KEY=\r\nDB_PASSWORD=\r\n", ["SECRET_KEY"])
    assert filled == ["SECRET_KEY"]
    assert merged.endswith("\r\n") and "\r\nDB_PASSWORD=\r\n" in merged


@needs_repo
def test_env_example_ships_no_secret_values_and_merge_makes_it_pass():
    """예시 파일: 비밀값은 비어 있고, 그대로는 거부되며, 생성기로 채우면 통과한다."""
    text = (REPO / ".env.example").read_text(encoding="utf-8")
    assert "CHANGE_ME" not in text and "devkey" not in text

    def parse(body: str) -> dict[str, str]:
        return dict(line.split("=", 1) for line in body.splitlines()
                    if "=" in line and not line.lstrip().startswith("#"))

    raw = parse(text)
    for name in sd.names():
        assert raw.get(name, "") == "", name
    url = raw.get("DATABASE_URL") or PG_URL.format(pw=raw.get("DB_PASSWORD", ""))
    assert {"SECRET_KEY", "DB_PASSWORD"} <= _names(sd.check(raw, database_url=url, zone_ok=_all_zones))

    merged, _ = sd.merge_env(text)
    env = parse(merged)
    env["COMPOSE_PROFILES"] += ",sso,aitools,onlyoffice,audiorelay"
    url = env.get("DATABASE_URL") or PG_URL.format(pw=env["DB_PASSWORD"])
    assert sd.check(env, database_url=url, zone_ok=_all_zones) == []


@needs_repo
def test_compose_has_no_weak_fallbacks():
    text = (REPO / "docker-compose.yml").read_text(encoding="utf-8")
    for weak in (":-devkey", ":-secret", "change-me", "please-change"):
        assert weak not in text, weak


# ─── CLI ───


def test_cli_gen_secrets_env_and_json(capsys):
    assert cli.main(["gen-secrets"]) == 0
    out = capsys.readouterr().out
    env = dict(line.split("=", 1) for line in out.splitlines())
    assert list(env) == sd.names(default_only=True)

    assert cli.main(["gen-secrets", "--format", "json", "--only", "SECRET_KEY", "DB_PASSWORD"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert list(data) == ["SECRET_KEY", "DB_PASSWORD"] and len(data["SECRET_KEY"]) >= 32

    assert cli.main(["gen-secrets", "--only", "NOPE"]) == 2


def test_cli_gen_secrets_merge(tmp_path, capsys):
    env_file = tmp_path / ".env"
    env_file.write_text("APP_URL=https://ws.example.com\nSECRET_KEY=\nDB_PASSWORD=keep-this-password-0123\n",
                        encoding="utf-8")

    # 기본: 화면 출력, 파일은 미변경
    assert cli.main(["gen-secrets", "--merge", str(env_file)]) == 0
    printed = capsys.readouterr().out
    assert "DB_PASSWORD=keep-this-password-0123" in printed and "SECRET_KEY=\n" not in printed
    assert "SECRET_KEY=\n" in env_file.read_text(encoding="utf-8")

    # --in-place: 파일에 기록하고 값은 출력하지 않음
    assert cli.main(["gen-secrets", "--merge", str(env_file), "--in-place"]) == 0
    captured = capsys.readouterr()
    body = env_file.read_text(encoding="utf-8")
    secret = re.search(r"^SECRET_KEY=(\w+)$", body, re.M).group(1)
    assert len(secret) >= 32 and "DB_PASSWORD=keep-this-password-0123" in body
    assert secret not in captured.out and secret not in captured.err

    assert cli.main(["gen-secrets", "--merge", str(tmp_path / "missing.env")]) == 2


def test_cli_check_secrets_exit_code(monkeypatch, capsys):
    monkeypatch.delenv(sd.ALLOW_ENV, raising=False)
    monkeypatch.setattr(sd, "check", lambda *a, **k: [sd.Problem("SECRET_KEY", "비어 있음")])
    assert cli.main(["check-secrets"]) == 1
    assert "SECRET_KEY: 비어 있음" in capsys.readouterr().err
    monkeypatch.setattr(sd, "check", lambda *a, **k: [])
    assert cli.main(["check-secrets"]) == 0
