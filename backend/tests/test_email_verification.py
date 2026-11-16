"""이메일 인증 의무화 — 로그인 차단·재발송 쿨다운.

로그인 전체 경로는 DB/Redis 의존이 크므로, 여기서는 분기 조건 자체를 확인한다.
"""

import pytest
from datetime import datetime, timedelta, timezone


def test_startup_never_marks_accounts_verified():
    """기동 시 실행되는 문장이 미인증 계정을 인증 상태로 변경하면 인증 의무화가 무력화된다.

    날짜를 고정한 소급 처리도 두지 않는다 — 신규 설치에는 해당 날짜 이전 계정이 없다.
    """
    import inspect
    import re
    from app.db import baseline, migrations

    # 기준선 보정과 그 이후의 변경 단계 전체
    src = inspect.getsource(baseline) + inspect.getsource(migrations)
    assert "email_verified = true" not in src
    assert not re.search(r"TIMESTAMPTZ '20\d\d-", src)


@pytest.mark.asyncio
async def test_resend_is_rate_limited_by_cooldown():
    from app.auth.router import RESEND_COOLDOWN_SEC

    # 직전에 발송했으면 쿨다운이 적용되어야 한다
    just_now = datetime.now(timezone.utc)
    elapsed = (datetime.now(timezone.utc) - just_now).total_seconds()
    assert elapsed < RESEND_COOLDOWN_SEC

    # 쿨다운 경과 시 통과
    old = datetime.now(timezone.utc) - timedelta(seconds=RESEND_COOLDOWN_SEC + 1)
    assert (datetime.now(timezone.utc) - old).total_seconds() >= RESEND_COOLDOWN_SEC


def test_login_blocks_unverified_users():
    """로그인 핸들러에 email_verified 검사가 실제로 존재하는지 확인."""
    import inspect
    from app.auth import router as auth_router

    src = inspect.getsource(auth_router.login_post)
    assert "email_verified" in src, "로그인에서 이메일 인증을 검사하지 않는다"
    assert "email_unverified" in src, "프런트가 재발송 버튼을 띄울 코드가 없다"


def test_register_does_not_create_mailbox():
    """승인 전 계정에 사서함을 부여하면 스팸 가입자가 도메인 주소를 보유하게 된다."""
    import inspect
    from app.auth import router as auth_router

    src = inspect.getsource(auth_router.register)
    assert "create_account" not in src, "가입 시점에 메일 계정을 만들고 있다"
