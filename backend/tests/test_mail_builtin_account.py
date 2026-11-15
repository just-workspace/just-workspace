"""내장 메일 가상 계정 — 이메일 없는 사용자는 계정 없음(404)이어야 한다(서버 오류 502 로 보이면 안 됨)."""

import pytest
from fastapi import HTTPException

from app.mail import router as mail_router


class _User:
    def __init__(self, email):
        self.id = "u-1"
        self.email = email


class _EmptyResult:
    def scalar_one_or_none(self):
        return None


class _DB:
    async def execute(self, *_a, **_k):
        return _EmptyResult()

    async def get(self, *_a, **_k):
        return None


def test_builtin_account_requires_email():
    assert mail_router._builtin_account(_User(None), True) is None
    assert mail_router._builtin_account(_User(""), True) is None
    assert mail_router._builtin_account(_User("   "), True) is None


def test_builtin_account_with_email():
    acc = mail_router._builtin_account(_User("qa@example.com"), True)
    assert acc is not None
    assert acc.id == "builtin-u-1"
    assert acc.email == "qa@example.com"


def test_builtin_account_disabled():
    assert mail_router._builtin_account(_User("qa@example.com"), False) is None


@pytest.mark.asyncio
async def test_get_account_without_email_is_404(monkeypatch):
    async def _on(_db):
        return True

    monkeypatch.setattr(mail_router, "_builtin_enabled", _on)
    user = _User(None)
    # 기본 계정 해석: 내장 계정 없음 + DB 계정 없음 → 404(설정 안내)
    with pytest.raises(HTTPException) as e:
        await mail_router._get_account(_DB(), user, None)
    assert e.value.status_code == 404
    # 예전 목록이 기억하던 builtin-<id> 로 물어도 404
    with pytest.raises(HTTPException) as e2:
        await mail_router._get_account(_DB(), user, "builtin-u-1")
    assert e2.value.status_code == 404
