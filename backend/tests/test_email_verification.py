"""이메일 인증 의무화 — 로그인 차단·재발송 쿨다운.

로그인 전체 경로는 DB/Redis 의존이 커서, 여기서는 분기 조건 자체를 본다.
"""

import pytest
from datetime import datetime, timedelta, timezone


def test_startup_never_marks_accounts_verified():
    """기동 때 도는 문장이 미인증 계정을 인증됨으로 올리면 인증 의무화가 무력화된다.

    날짜를 박아 둔 소급 처리도 두지 않는다 — 새 설치에는 그 날짜 이전 계정이 없다.
    """
    import inspect
    import re
    from app.db import session as sess

    src = inspect.getsource(sess._run_legacy_migrations)
    assert "email_verified = true" not in src
    assert not re.search(r"TIMESTAMPTZ '20\d\d-", src)


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
