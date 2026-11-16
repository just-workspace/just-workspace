"""CLI utilities for just-workspace.

Usage:
    python -m app.cli gen-secrets                       # 비밀값 전부를 KEY=value 로 출력
    python -m app.cli gen-secrets --format json
    python -m app.cli gen-secrets --only SECRET_KEY DB_PASSWORD
    python -m app.cli gen-secrets --merge .env          # .env 의 빈 비밀값만 채운 내용을 출력
    python -m app.cli gen-secrets --merge .env --in-place   # 파일에 바로 쓴다
    python -m app.cli check-secrets                     # 기동 검사와 같은 판정(문제 있으면 종료 코드 1)
    python -m app.cli seed-admin --username admin       # 관리자 계정 만들기(비밀번호는 물어본다)
    python -m app.cli reset-admin admin [--disable-2fa] # 관리자 임시 비밀번호 발급(한 번만 출력)
    python -m app.cli setup-token                       # 첫 관리자 만들기용 설정 토큰 재발급(관리자가 없을 때만)
    python -m app.cli configure < settings.json         # DB 에 저장되는 설정 넣기(설치 관리자용, 표준 입력 JSON)
    python -m app.cli migrate                           # DB 스키마 변경 단계 적용(실패하면 종료 코드 1)
    python -m app.cli migrate --check                   # 적용할 것이 있으면 종료 코드 1 과 목록
    python -m app.cli migrate --status [--json]         # 현재 버전·대기 단계·기록
    python -m app.cli schema-version                    # 이 코드가 요구하는 스키마 버전(숫자만)
    python -m app.cli backup create|list|inspect|verify …  # 백업(app/backup/cli.py)
    python -m app.cli restore <백업>                    # 복원 — backend 밖에서(scripts/restore.sh)

gen-secrets · check-secrets · schema-version 은 DB 없이 돈다(설치 관리자가 컨테이너를 띄우기 전에 부른다).
스키마 버전과 변경 단계는 docs/data-safety.md.
"""

import argparse
import asyncio
import json
import os
import secrets
import sys
from datetime import datetime, timezone


def _log(message: str) -> None:
    print(message, flush=True)


async def seed_admin(
    username: str,
    password: str,
    display_name: str | None = None,
    *,
    only_if_empty: bool = False,
    promote: bool = False,
) -> str:
    """관리자 계정을 만든다. 돌려주는 값: created | exists | skipped | conflict | promoted.

    - only_if_empty(기동 때 자동 시드): 사용자가 한 명이라도 있으면 아무것도 하지 않는다.
      매 기동마다 계정을 건드리지 않고, 나중에 같은 이름으로 가입한 일반 계정이 관리자가 되지도 않는다.
    - 같은 이름의 계정이 이미 있으면 **승격하지 않는다** — 경고만 남긴다. 운영자가 서버에서
      `seed-admin --promote` 로 명시했을 때만 승격한다(비밀번호는 바꾸지 않는다).
    """
    from sqlalchemy import func, select

    from app.auth.password import hash_password
    from app.db.models import Base, User
    from app.db.session import async_session, engine

    # Ensure tables exist
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    domain = os.environ.get("DOMAIN", "localhost")
    email = f"{username}@{domain}"

    async with async_session() as session:
        if only_if_empty:
            total = (await session.execute(select(func.count()).select_from(User))).scalar_one()
            if total:
                existing = (await session.execute(
                    select(User).where(User.username == username)
                )).scalar_one_or_none()
                if existing is not None and not existing.is_admin:
                    _log(f"[SEED] 경고: '{username}' 계정이 이미 있지만 관리자가 아닙니다 — 승격하지 않습니다. "
                         "관리 화면에서 직접 권한을 주거나 python -m app.cli seed-admin --promote 를 쓰세요")
                    return "conflict"
                _log("[SEED] 이미 사용자가 있어 관리자 시드를 건너뜁니다 "
                     "(.env 의 ADMIN_USERNAME / ADMIN_PASSWORD 는 지워도 됩니다)")
                return "skipped"

        user = (await session.execute(
            select(User).where(User.username == username)
        )).scalar_one_or_none()

        if user:
            if user.is_admin:
                _log(f"[SEED] Admin '{username}' already exists — skipped")
                return "exists"
            if not promote:
                _log(f"[SEED] 경고: '{username}' 계정이 이미 있지만 관리자가 아닙니다 — 승격하지 않습니다 "
                     "(승격하려면 --promote)")
                return "conflict"
            user.is_admin = True
            await _drop_setup_token(session)
            await session.commit()
            _log(f"[SEED] User '{username}' promoted to admin")
            return "promoted"

        session.add(User(
            username=username,
            password_hash=hash_password(password),
            display_name=display_name or username,
            email=email,
            is_admin=True,
            is_active=True,
            email_verified=True,
        ))
        await _drop_setup_token(session)
        await session.commit()
        _log(f"[SEED] Admin '{username}' created ({email})")
        return "created"


async def _drop_setup_token(session) -> None:
    """관리자가 생겼으니 웹의 첫 관리자 만들기용 설정 토큰을 지운다(같은 트랜잭션)."""
    from app.setup import token as setup_token

    await setup_token.revoke(session)


class SetupTokenRefused(Exception):
    """setup-token 을 거부한 사유."""


async def issue_setup_token() -> str:
    """첫 관리자 만들기용 설정 토큰을 새로 발급한다(이전 토큰은 못 쓰게 된다). 저장은 해시만.

    관리자가 이미 있거나 설치 관리자가 꾸린 설치면 거부한다(`SetupTokenRefused`).
    """
    from app.db.session import async_session
    from app.setup import token as setup_token

    if setup_token.installer_managed():
        raise SetupTokenRefused("설치 관리자가 꾸린 서버입니다 — 웹의 첫 관리자 만들기는 닫혀 있습니다. "
                                "관리자는 seed-admin 으로 만듭니다")
    async with async_session() as session:
        if await setup_token.has_admin(session):
            await setup_token.revoke(session)
            await session.commit()
            raise SetupTokenRefused("이미 관리자가 있습니다 — 설정 토큰은 필요 없습니다")
        return await setup_token.issue(session)


class ResetRefused(Exception):
    """reset-admin 을 거부한 사유."""


def generate_temp_password() -> str:
    """임시 비밀번호 — URL-safe 24자(144비트). 화면에 한 번만 보여 준다."""
    return secrets.token_urlsafe(18)


async def reset_admin(username: str, *, disable_2fa: bool = False) -> str:
    """관리자 계정에 새 임시 비밀번호를 걸고 그 값을 돌려준다(저장은 해시만).

    - 관리자가 아닌 계정·없는 계정은 거부한다(`ResetRefused`).
    - 열린 세션·앱 토큰을 전부 끊는다(비밀번호를 잃어버린 게 아니라 빼앗긴 경우일 수 있다).
    - disable_2fa: 2단계 인증과 복구 코드를 지운다(인증 앱까지 잃어버렸을 때).
    """
    from sqlalchemy import select

    from app.auth import two_factor
    from app.auth.oauth_store import revoke_user_refresh_tokens
    from app.auth.password import hash_password
    from app.db.models import User
    from app.db.session import async_session

    async with async_session() as session:
        user = (await session.execute(
            select(User).where(User.username == username)
        )).scalar_one_or_none()
        if user is None:
            raise ResetRefused(f"'{username}' 계정이 없습니다")
        if not user.is_admin:
            raise ResetRefused(f"'{username}' 은(는) 관리자 계정이 아닙니다 — 일반 계정은 관리 화면에서 재설정하세요")
        if user.totp_secret and not disable_2fa:
            _log("[RESET] 이 계정은 2단계 인증이 켜져 있습니다 — 인증 앱도 없으면 --disable-2fa 를 붙여 다시 실행하세요")

        password = generate_temp_password()
        user.password_hash = hash_password(password)
        user.password_changed_at = datetime.now(timezone.utc)
        user.password_reset_token = None
        if not user.is_active:
            _log("[RESET] 참고: 이 계정은 비활성 상태입니다 — 비밀번호만 바꿨고 활성화하지는 않았습니다")
        if disable_2fa and user.totp_secret:
            user.totp_secret = None
            two_factor.clear_codes(user)
            _log("[RESET] 2단계 인증을 해제했습니다 — 로그인한 뒤 다시 등록하세요")
        user.token_version = (user.token_version or 0) + 1
        await revoke_user_refresh_tokens(session, user.id)
        await session.commit()
        user_id, source = user.id, (user.auth_source or "local")

    # 세션 레지스트리·로그인 잠금은 Redis 에 있다 — 못 닿아도 token_version 으로 이미 끊겼다
    try:
        from app.auth import security_policy
        from app.auth import sessions as sess_mod

        await sess_mod.revoke_user_sessions(user_id)
        await security_policy.clear_failures(username)
        await security_policy.clear_2fa_failures(user_id)
    except Exception as e:  # noqa: BLE001
        _log(f"[RESET] 세션 레지스트리 정리는 건너뜀({type(e).__name__}) — 기존 세션은 이미 무효입니다")

    if source != "local":
        _log(f"[RESET] 참고: 이 계정은 외부 디렉터리({source}) 계정입니다 — 디렉터리 연동이 켜져 있는 동안은 "
             "로컬 비밀번호로 로그인할 수 없습니다")
    return password


# ─── 하위 명령 ───


def _cmd_gen_secrets(args) -> int:
    from app import security_defaults as sd

    only = args.only or None
    try:
        if args.merge:
            with open(args.merge, encoding="utf-8", newline="") as f:
                text = f.read()
            merged, filled = sd.merge_env(text, only)
            if args.in_place:
                with open(args.merge, "w", encoding="utf-8", newline="") as f:
                    f.write(merged)
                # 값은 찍지 않는다 — 이름만
                print(f"{args.merge}: {len(filled)}개 채움" + (f" ({', '.join(filled)})" if filled else ""),
                      file=sys.stderr)
            elif args.format == "json":
                print(json.dumps({"filled": filled, "env": merged}, ensure_ascii=False))
            else:
                sys.stdout.write(merged)
            return 0
        if args.in_place:
            print("ERROR: --in-place 는 --merge <파일> 과 함께 씁니다", file=sys.stderr)
            return 2
        values = sd.generate(only)
    except KeyError as e:
        print(f"ERROR: 모르는 비밀값 이름: {e.args[0]}\n쓸 수 있는 이름: {', '.join(sd.names())}", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    if args.format == "json":
        print(json.dumps(values, indent=2))
    else:
        for key, value in values.items():
            print(f"{key}={value}")
    return 0


def _cmd_check_secrets(args) -> int:
    from app import security_defaults as sd

    try:
        sd.enforce(emit=lambda line: print(line, file=sys.stderr, flush=True))
    except sd.InsecureDefaults:
        return 1
    return 0


def _cmd_seed_admin(args) -> int:
    username = args.username or os.environ.get("ADMIN_USERNAME", "")
    password = args.password or os.environ.get("ADMIN_PASSWORD", "")
    if not username:
        print("ERROR: --username 이 필요합니다(또는 ADMIN_USERNAME)", file=sys.stderr)
        return 1
    if not password and not args.promote:
        if sys.stdin.isatty():
            import getpass
            password = getpass.getpass("관리자 비밀번호: ")
            if password != getpass.getpass("한 번 더: "):
                print("ERROR: 두 입력이 다릅니다", file=sys.stderr)
                return 1
        if not password:
            print("ERROR: --password 가 필요합니다(또는 ADMIN_PASSWORD, 터미널이면 물어봅니다)", file=sys.stderr)
            return 1
    result = asyncio.run(seed_admin(username, password, args.display_name, promote=args.promote))
    return 1 if result == "conflict" else 0


def _cmd_reset_admin(args) -> int:
    try:
        password = asyncio.run(reset_admin(args.username, disable_2fa=args.disable_2fa))
    except ResetRefused as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    print(f"[RESET] '{args.username}' 의 임시 비밀번호(지금 한 번만 보입니다 — 로그인한 뒤 바로 바꾸세요):")
    print(password)
    return 0


def _cmd_setup_token(args) -> int:
    try:
        token = asyncio.run(issue_setup_token())
    except SetupTokenRefused as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    print("[SETUP] 새 설정 토큰(지금 한 번만 보입니다 — 이전 토큰은 더 쓸 수 없습니다). /setup 화면에 넣으세요:")
    print(token)
    return 0


# 설치 관리자가 넣을 수 있는 설정 키(그 밖은 거부한다)
CONFIGURE_SETTINGS = {"smtp.security": ("starttls", "ssl", "none")}


async def configure(payload: dict) -> list[str]:
    """DB 에 저장되는 설정을 넣는다(환경변수로는 줄 수 없는 것). 돌려주는 값: 넣은 항목 이름.

    payload: {"settings": {"smtp.security": "ssl"}, "ai": {"kind", "model", "base_url", "api_key"}}
    값은 표준 입력으로만 받는다 — API 키가 명령 인자나 환경변수에 남지 않게.
    """
    from app.admin.settings import set_setting
    from app.db.models import Base
    from app.db.session import async_session, engine

    settings = payload.get("settings") or {}
    for key, value in settings.items():
        if key not in CONFIGURE_SETTINGS or value not in CONFIGURE_SETTINGS[key]:
            raise ValueError(f"넣을 수 없는 설정: {key}")
    ai = payload.get("ai")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    done: list[str] = []
    async with async_session() as db:
        for key, value in settings.items():
            await set_setting(db, key, value)
            done.append(key)
        if ai:
            from app.ai.config import set_ai_config

            await set_ai_config(db, kind=ai.get("kind") or "", model=ai.get("model") or "",
                                base_url=ai.get("base_url") or "", api_key=ai.get("api_key") or "")
            done.append("ai")
        await db.commit()
    return done


def _cmd_configure(args) -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            raise ValueError("JSON 객체가 아닙니다")
        done = asyncio.run(configure(payload))
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    print("configured: " + (", ".join(done) if done else "(없음)"))   # 값은 찍지 않는다
    return 0


# ─── 스키마 ───

# migrate 종료 코드
MIGRATE_OK = 0          # 적용했거나 할 일이 없다
MIGRATE_FAILED = 1      # 단계 실패 / --check 에서 대기 단계 있음
MIGRATE_TOO_NEW = 3     # DB 가 코드보다 새것 — 백업에서 복원해야 한다
MIGRATE_DRIFT = 4       # 버전은 맞는데 빠진 테이블·컬럼이 있다(--repair)


async def _migrate_async(args) -> int:
    from app.db import migrate as mg
    from app.db.session import engine

    err = lambda line: print(line, file=sys.stderr, flush=True)  # noqa: E731
    try:
        if args.status or args.check:
            info = await mg.status(engine)
            if args.json:
                print(json.dumps(info, ensure_ascii=False, indent=2))
            else:
                names = {"empty": "빈 DB", "legacy": "버전 기록 이전의 설치", "versioned": "버전 기록 있음"}
                print(f"코드가 요구하는 스키마 버전: {info['required']}")
                print(f"DB 스키마 버전: {info['current']} ({names[info['state']]})")
                for row in info["applied"]:
                    print(f"  적용됨 {row['version']:>3}  {row['name']}  ({row['applied_at']}, 제품 {row['app_version'] or '?'})")
                    for note in filter(None, row["notes"].splitlines()):
                        print(f"        경고: {note}")
                for row in info["pending"]:
                    print(f"  대기   {row['version']:>3}  {row['name']}")
                if info["missing"]:
                    print("  빠진 테이블·컬럼: " + ", ".join(info["missing"]))
            if info["too_new"]:
                err(f"ERROR: {mg.SchemaTooNew(info['current'], info['required'])}")
                return MIGRATE_TOO_NEW
            if args.check:
                if info["pending"]:
                    return MIGRATE_FAILED
                if info["missing"]:
                    return MIGRATE_DRIFT
            return MIGRATE_OK

        if args.on_start:
            await mg.ensure_schema(engine, verify=True)
            return MIGRATE_OK

        result = await mg.migrate(engine, repair=args.repair)
        if result.applied:
            print(f"[DB] 스키마 {result.from_version} → {result.to_version}: "
                  + ", ".join(f"{v}({n})" for v, n in result.applied))
        else:
            print(f"[DB] 적용할 단계가 없습니다(스키마 {result.to_version})")
        if result.warnings:
            print(f"[DB] 경고 {len(result.warnings)}건 — python -m app.cli migrate --status 로 볼 수 있습니다")
        return MIGRATE_OK
    except mg.SchemaTooNew as e:
        err(f"ERROR: {e}")
        return MIGRATE_TOO_NEW
    except mg.SchemaDrift as e:
        err(f"ERROR: {e}")
        return MIGRATE_DRIFT
    except (mg.MigrationError, mg.SchemaOutdated) as e:
        err(f"ERROR: {e}")
        cause = getattr(e, "cause", None)
        if isinstance(cause, BaseException):
            err(f"  원인: {type(cause).__name__}: {str(cause).strip()[:2000]}")
        return MIGRATE_FAILED
    except Exception as e:  # noqa: BLE001 — DB 에 못 닿는 경우 등: 원인을 그대로 보여 주고 실패로 끝낸다
        err(f"ERROR: 스키마 작업 실패 — {type(e).__name__}: {str(e).strip()[:2000]}")
        return MIGRATE_FAILED
    finally:
        await engine.dispose()


def _cmd_migrate(args) -> int:
    return asyncio.run(_migrate_async(args))


def _cmd_schema_version(args) -> int:
    from app.db.schema_version import SCHEMA_VERSION

    if args.fingerprint:
        from app.db.migrate import models_fingerprint

        print(models_fingerprint())
        return 0
    print(SCHEMA_VERSION)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="app.cli", description="Workspace CLI")
    sub = parser.add_subparsers(dest="command")

    gen = sub.add_parser("gen-secrets", help="비밀값을 안전한 난수로 만든다")
    gen.add_argument("--format", choices=("env", "json"), default="env")
    gen.add_argument("--only", nargs="+", metavar="NAME", help="이 이름들만")
    gen.add_argument("--merge", metavar="FILE", help=".env 파일을 읽어 비어 있는 비밀값만 채운다")
    gen.add_argument("--in-place", action="store_true", help="--merge 결과를 그 파일에 쓴다(기본은 화면 출력)")
    gen.set_defaults(func=_cmd_gen_secrets)

    chk = sub.add_parser("check-secrets", help="기동 검사와 같은 판정(문제가 있으면 종료 코드 1)")
    chk.set_defaults(func=_cmd_check_secrets)

    seed = sub.add_parser("seed-admin", help="관리자 계정을 만든다")
    seed.add_argument("--username", default="", help="관리자 아이디 (기본: $ADMIN_USERNAME)")
    seed.add_argument("--password", default="", help="비밀번호 (기본: $ADMIN_PASSWORD, 없으면 물어본다)")
    seed.add_argument("--display-name", default=None, help="표시 이름 (기본: 아이디)")
    seed.add_argument("--promote", action="store_true",
                      help="같은 이름의 일반 계정이 있으면 관리자로 올린다(비밀번호는 그대로)")
    seed.set_defaults(func=_cmd_seed_admin)

    reset = sub.add_parser("reset-admin", help="관리자 계정에 임시 비밀번호를 발급한다(한 번만 출력)")
    reset.add_argument("username", help="관리자 아이디")
    reset.add_argument("--disable-2fa", action="store_true", help="2단계 인증·복구 코드도 해제한다")
    reset.set_defaults(func=_cmd_reset_admin)

    st = sub.add_parser("setup-token", help="첫 관리자 만들기용 설정 토큰을 다시 발급한다(관리자가 없을 때만)")
    st.set_defaults(func=_cmd_setup_token)

    conf = sub.add_parser("configure", help="DB 에 저장되는 설정을 표준 입력(JSON)으로 넣는다 — 설치 관리자용")
    conf.set_defaults(func=_cmd_configure)

    mig = sub.add_parser("migrate", help="DB 스키마 변경 단계를 적용한다(실패하면 종료 코드 1)")
    mode = mig.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="적용하지 않고, 적용할 것이 있으면 종료 코드 1")
    mode.add_argument("--status", action="store_true", help="현재 버전·대기 단계·기록을 보여 준다")
    mode.add_argument("--repair", action="store_true",
                      help="기준선 보정(빠진 테이블·컬럼·인덱스 채우기)을 다시 돌린 뒤 대기 단계를 적용한다")
    mode.add_argument("--on-start", action="store_true",
                      help="컨테이너 기동용 — JW_MIGRATE_ON_START 를 따르고, 끝나면 모델과 DB 를 대조한다")
    mig.add_argument("--json", action="store_true", help="--status/--check 결과를 JSON 으로")
    mig.set_defaults(func=_cmd_migrate)

    sv = sub.add_parser("schema-version", help="이 코드가 요구하는 DB 스키마 버전(숫자만, DB 없이)")
    sv.add_argument("--fingerprint", action="store_true", help="버전 대신 모델 지문을 출력(개발용)")
    sv.set_defaults(func=_cmd_schema_version)

    # backup · restore — app/backup/cli.py
    from app.backup.cli import add_parsers as add_backup_parsers

    add_backup_parsers(sub)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
