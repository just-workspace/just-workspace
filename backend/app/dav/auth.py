"""HTTP Basic Auth for WebDAV clients.

CalDAV/CardDAV 는 앱 비밀번호(설정 › 연결된 앱, 범위 dav)만 받는다. 계정(메인) 비밀번호는
2단계 인증·로그인 잠금을 거치지 않는 우회로가 되기 때문이다. 전환 기간 설정
(DAV_ALLOW_ACCOUNT_PASSWORD=true)에서만 계정 비밀번호를 받되, 2단계 인증을 켰거나 정책상
필수인 계정은 거부한다. 어느 쪽이든 실패는 메인 로그인과 같은 잠금 집계(security_policy)에 들어간다.
"""

import base64

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.password import verify_password
from app.config import get_settings
from app.db.models import User


async def authenticate_dav(
    authorization: str | None, db: AsyncSession, ip: str = ""
) -> User | None:
    """Validate HTTP Basic Auth header and return User or None."""
    if not authorization or not authorization.startswith("Basic "):
        return None
    try:
        decoded = base64.b64decode(authorization[6:]).decode("utf-8")
        username, password = decoded.split(":", 1)
    except Exception:
        return None
    if not username or not password:
        return None

    from app.auth import security_policy
    pol = await security_policy.get_policy_cached()
    if await security_policy.check_lockout(pol, username, ip):
        return None

    result = await db.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        await security_policy.record_failure(pol, username, ip)
        return None

    from app.auth.me_security import verify_app_password
    if await verify_app_password(db, user, password, "dav"):
        await security_policy.clear_failures(username)
        return user

    if _account_password_allowed(pol, user) and user.password_hash \
            and verify_password(password, user.password_hash):
        await security_policy.clear_failures(username)
        return user

    await security_policy.record_failure(pol, username, ip)
    return None


def _account_password_allowed(pol: dict, user: User) -> bool:
    if not getattr(get_settings(), "dav_allow_account_password", False):
        return False
    from app.auth import security_policy
    if getattr(user, "totp_secret", None) or security_policy.totp_required_for(pol, user):
        return False
    return True
