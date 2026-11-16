"""첫 관리자 만들기를 지키는 일회용 설정 토큰.

관리자가 한 명도 없는 서버에서 `POST /api/setup/admin` 은 인증할 계정이 없다. 그래서 "서버 터미널을
볼 수 있는 사람"만 아는 값을 요구한다.

- 설치 관리자가 꾸린 설치(`JW_INSTALLER_KEY` 가 있다)에서는 그 API 가 아예 닫혀 있다 — 관리자는 설치
  관리자가 `seed-admin` 으로 만든다. 이 모듈은 토큰을 만들지 않는다.
- 그 밖의 설치(compose 로 직접 띄움)에서는 backend 가 관리자 0명으로 뜰 때마다 토큰을 새로 만들어
  컨테이너 로그에 한 번 찍는다. `python -m app.cli setup-token` 으로 다시 발급할 수 있다.
- 저장은 DB(`system_settings` 의 `setup.token_hash`)에 SHA-256 해시로만 한다. 워커가 여럿이어도, backend 밖에서
  도는 CLI 도 같은 값을 본다. 토큰이 256비트 난수라 느린 해시는 필요 없다.
- 관리자가 만들어지면 지운다. 웹 경로에서는 "토큰 행 지우기"와 "계정 넣기"가 한 트랜잭션이라 같은 토큰으로
  두 번 만들 수 없다.
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

MODE_INSTALLER = "installer"   # 웹의 첫 관리자 만들기는 닫혀 있다
MODE_TOKEN = "token"           # 설정 토큰이 있어야 만든다


def installer_managed() -> bool:
    """설치 관리자가 꾸린 설치인가 — 설치 관리자가 `.env` 에 넣는 내부 API 키로 구분한다."""
    return bool(os.environ.get(INSTALLER_ENV, "").strip())


def mode() -> str:
    return MODE_INSTALLER if installer_managed() else MODE_TOKEN


def digest(token: str) -> str:
    return hashlib.sha256(token.strip().encode("utf-8")).hexdigest()


async def has_admin(db: AsyncSession) -> bool:
    n = await db.scalar(select(func.count()).select_from(User).where(User.is_admin == True))  # noqa: E712
    return bool(n)


async def issue(db: AsyncSession) -> str:
    """새 토큰을 만들어 해시를 저장하고(이전 토큰은 못 쓰게 된다) 평문을 돌려준다. 커밋까지 한다."""
    token = secrets.token_urlsafe(TOKEN_BYTES)
    row = await db.get(SystemSetting, KEY)
    if row:
        row.value = digest(token)
    else:
        db.add(SystemSetting(key=KEY, value=digest(token)))
    await db.commit()
    return token


async def matches(db: AsyncSession, candidate: str | None) -> bool:
    """받은 값이 저장된 토큰과 같은가(상수 시간 비교). 토큰이 없으면 항상 False."""
    stored = await db.scalar(select(SystemSetting.value).where(SystemSetting.key == KEY))
    given = digest(candidate or "")
    # 저장된 값이 없어도 비교는 한 번 한다 — 응답 시간으로 "토큰이 있는지"를 가르지 못하게
    ok = hmac.compare_digest(given, stored or ("0" * len(given)))
    return bool(stored) and bool(candidate) and ok


async def consume(db: AsyncSession, candidate: str | None) -> bool:
    """토큰이 맞으면 그 행을 지우고 True(커밋은 호출한 쪽이 계정과 함께 한다).

    지우기는 해시까지 조건에 넣은 DELETE 한 번이다 — 같은 토큰으로 동시에 들어온 두 요청 가운데 하나만
    행을 지우고, 다른 하나는 0행이라 거부된다.
    """
    if not await matches(db, candidate):
        return False
    result = await db.execute(
        delete(SystemSetting).where(SystemSetting.key == KEY, SystemSetting.value == digest(candidate or ""))
    )
    return (result.rowcount or 0) == 1


async def revoke(db: AsyncSession) -> None:
    """남은 토큰을 지운다(커밋은 호출한 쪽)."""
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
    """기동 때 한 번 — 관리자가 없고 설치 관리자 설치가 아니면 토큰을 새로 만들어 로그에 찍는다.

    워커가 여럿 동시에 뜨므로 락을 잡은 워커 하나만 한다. 돌려주는 값은 찍은 토큰(안 찍었으면 None).
    """
    from app.db.session import async_session

    if installer_managed():
        return None
    async with async_session() as db:
        if await has_admin(db):
            await revoke(db)   # 관리자가 CLI·env 시드로 만들어진 경우 남은 토큰 정리
            await db.commit()
            return None
        from app.jobs.lock import try_acquire

        if not await try_acquire("startup:setup-token", ttl=20):
            return None
        token = await issue(db)
    print(banner(token), flush=True)
    return token
