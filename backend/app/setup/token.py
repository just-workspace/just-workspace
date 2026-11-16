"""첫 관리자 생성을 보호하는 일회용 설정 토큰.

관리자가 한 명도 없는 서버에서 `POST /api/setup/admin` 은 인증할 계정이 없다. 따라서 "서버 터미널을
볼 수 있는 사람"만 아는 값을 요구한다.

- 설치 관리자가 구성한 설치(`JW_INSTALLER_KEY` 존재)에서는 해당 API 가 차단되어 있다 — 관리자는 설치
  관리자가 `seed-admin` 으로 생성한다. 본 모듈은 토큰을 생성하지 않는다.
- 그 외의 설치(compose 로 직접 기동)에서는 backend 가 관리자 0명 상태로 기동할 때마다 토큰을 새로 생성하여
  컨테이너 로그에 1회 출력한다. `python -m app.cli setup-token` 으로 재발급할 수 있다.
- 저장은 DB(`system_settings` 의 `setup.token_hash`)에 SHA-256 해시로만 한다. 워커가 복수여도, backend 외부에서
  실행되는 CLI 도 동일 값을 조회한다. 토큰이 256비트 난수이므로 느린 해시는 불필요하다.
- 관리자가 생성되면 삭제한다. 웹 경로에서는 "토큰 행 삭제"와 "계정 삽입"이 한 트랜잭션이므로 동일 토큰으로
  두 번 생성할 수 없다.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import SystemSetting, User

KEY = "setup.token_hash"
INSTALLER_ENV = "JW_INSTALLER_KEY"
TOKEN_BYTES = 32

MODE_INSTALLER = "installer"   # 웹의 첫 관리자 생성 차단
MODE_TOKEN = "token"           # 설정 토큰이 있어야 생성 가능


def installer_managed() -> bool:
    """설치 관리자가 구성한 설치인지 여부 — 설치 관리자가 `.env` 에 기록하는 내부 API 키로 판별한다."""
    return bool(os.environ.get(INSTALLER_ENV, "").strip())


def mode() -> str:
    return MODE_INSTALLER if installer_managed() else MODE_TOKEN


def digest(token: str) -> str:
    return hashlib.sha256(token.strip().encode("utf-8")).hexdigest()


async def has_admin(db: AsyncSession) -> bool:
    n = await db.scalar(select(func.count()).select_from(User).where(User.is_admin == True))  # noqa: E712
    return bool(n)


async def issue(db: AsyncSession) -> str:
    """새 토큰을 생성해 해시를 저장하고(이전 토큰은 무효화된다) 평문을 반환한다. 커밋까지 수행한다."""
    token = secrets.token_urlsafe(TOKEN_BYTES)
    row = await db.get(SystemSetting, KEY)
    if row:
        row.value = digest(token)
    else:
        db.add(SystemSetting(key=KEY, value=digest(token)))
    await db.commit()
    return token


async def matches(db: AsyncSession, candidate: str | None) -> bool:
    """수신한 값과 저장된 토큰의 일치 여부(상수 시간 비교). 토큰이 없으면 항상 False."""
    stored = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == KEY))
    given = digest(candidate or "")
    # 저장된 값이 없어도 비교는 1회 수행 — 응답 시간으로 토큰 존재 여부를 판별하지 못하도록 함
    ok = hmac.compare_digest(given, stored or ("0" * len(given)))
    return bool(stored) and bool(candidate) and ok


async def consume(db: AsyncSession, candidate: str | None) -> bool:
    """토큰이 일치하면 해당 행을 삭제하고 True 를 반환한다(커밋은 호출자가 계정 생성과 함께 수행한다).

    삭제는 해시까지 조건에 포함한 DELETE 1회이다 — 동일 토큰으로 동시에 수신된 두 요청 중 하나만
    행을 삭제하고, 다른 하나는 0행이므로 거부된다.
    """
    if not await matches(db, candidate):
        return False
    result = await db.execute(
        delete(SystemSetting).where(SystemSetting.key == KEY, SystemSetting.value == digest(candidate or ""))
    )
    return (result.rowcount or 0) == 1


async def revoke(db: AsyncSession) -> None:
    """잔여 토큰을 삭제한다(커밋은 호출자가 수행)."""
    await db.execute(delete(SystemSetting).where(SystemSetting.key == KEY))


def banner(token: str) -> str:
    line = "=" * 72
    return (
        f"\n{line}\n"
        "[SETUP] 관리자 계정이 아직 없습니다 — 웹의 최초 설정 화면(/setup)에서 아래 설정 토큰을 넣어야\n"
        "        첫 관리자를 만들 수 있습니다. 이 값은 지금 한 번만 보입니다.\n"
        "[SETUP] No admin account yet. Enter this setup token on the /setup page to create the first admin.\n\n"
        f"        설정 토큰 / setup token: {token}\n\n"
        "        다시 발급: docker compose exec backend python -m app.cli setup-token\n"
        f"{line}\n"
    )


async def announce_on_start() -> str | None:
    """기동 시 1회 — 관리자가 없고 설치 관리자 설치가 아니면 토큰을 새로 생성하여 로그에 출력한다.

    여러 워커가 동시에 기동하므로 락을 획득한 워커 하나만 수행한다. 반환값은 출력한 토큰(출력하지 않았으면 None).
    """
    from app.db.session import async_session

    if installer_managed():
        return None
    async with async_session() as db:
        if await has_admin(db):
            await revoke(db)   # 관리자가 CLI·env 시드로 생성된 경우 잔여 토큰 삭제
            await db.commit()
            return None
        from app.jobs.lock import try_acquire

        if not await try_acquire("startup:setup-token", ttl=20):
            return None
        token = await issue(db)
    print(banner(token), flush=True)
    return token
