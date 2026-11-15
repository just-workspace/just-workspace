"""이메일 인증 의무화 — 로그인 차단·재발송 쿨다운·백필 조건.

로그인 전체 경로는 DB/Redis 의존이 커서, 여기서는 분기 조건 자체를 본다.
"""

import pytest
from datetime import datetime, timedelta, timezone


def test_backfill_sql_only_touches_old_active_accounts():
    """백필 SQL 이 '가입 후' 계정을 건드리면 인증 의무화가 무력화된다."""
    from app.db.session import _run_legacy_migrations  # noqa: F401
    import inspect
    from app.db import session as sess

    src = inspect.getsource(sess._run_legacy_migrations)
    stmt = [line for line in src.splitlines() if "UPDATE users" in line]
    assert stmt, "백필 문이 사라졌다"
    # 세 조건이 모두 있어야 안전하다: 미인증만 / 활성만 / 컷오프 이전만
    assert "email_verified = false" in src
    assert "is_active = true" in src
    assert "created_at <" in src


@pytest.mark.asyncio
async def test_resend_is_rate_limited_by_cooldown():
    from app.auth.router import RESEND_COOLDOWN_SEC

    # 방금 보냈으면 쿨다운에 걸려야 한다
    just_now = datetime.now(timezone.utc)
    elapsed = (datetime.now(timezone.utc) - just_now).total_seconds()
    assert elapsed < RESEND_COOLDOWN_SEC

    # 쿨다운이 지났으면 통과
    old = datetime.now(timezone.utc) - timedelta(seconds=RESEND_COOLDOWN_SEC + 1)
    assert (datetime.now(timezone.utc) - old).total_seconds() >= RESEND_COOLDOWN_SEC


def test_login_blocks_unverified_users():
    """로그인 핸들러에 email_verified 검사가 실제로 있는지."""
    import inspect
    from app.auth import router as auth_router

    src = inspect.getsource(auth_router.login_post)
    assert "email_verified" in src, "로그인에서 이메일 인증을 검사하지 않는다"
    assert "email_unverified" in src, "프런트가 재발송 버튼을 띄울 코드가 없다"


def test_register_does_not_create_mailbox():
    """승인 전 계정에 사서함을 주면 스팸 가입자가 도메인 주소를 갖는다."""
    import inspect
    from app.auth import router as auth_router

    src = inspect.getsource(auth_router.register)
    assert "create_account" not in src, "가입 시점에 메일 계정을 만들고 있다"
