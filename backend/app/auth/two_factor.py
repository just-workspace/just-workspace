"""2단계 인증 복구 코드 + 상태 API.

복구 코드는 인증 앱 분실 시 각 1회 사용하는 일회용 코드이다(10개).
- 평문은 발급 직후 1회만 반환하고 저장하지 않는다. DB(users.totp_recovery_codes)에는
  SECRET_KEY 를 키로 한 HMAC-SHA256 값의 JSON 배열만 저장한다. 40비트의 짧은 코드이므로
  키 없는 해시는 DB 유출 시 오프라인 대입이 가능하다 — HMAC 키로 이를 방지한다.
- 로그인 2단계(/api/auth/2fa/verify)에서 TOTP 대신 사용할 수 있으며, 사용한 코드는 삭제된다.
- 화면의 "복구 코드 보기"는 저장된 평문이 없으므로 **신규 발급**(기존 코드 폐기)이다.
  인증 앱 코드를 재입력받아 본인 확인을 수행한 후에만 발급한다.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.rate_limit import limiter

router = APIRouter(prefix="/api/auth/2fa", tags=["auth"])

RECOVERY_COUNT = 10
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # 혼동하기 쉬운 문자(i l o 0 1) 제외


def _normalize(code: str) -> str:
    return "".join(ch for ch in (code or "").lower() if ch.isalnum())


def _digest(code: str) -> str:
    key = get_settings().secret_key.encode()
    return hmac.new(key, f"2fa-recovery:{_normalize(code)}".encode(), hashlib.sha256).hexdigest()


def generate_codes(n: int = RECOVERY_COUNT) -> list[str]:
    """xxxx-xxxx 형식 평문 코드 n개."""
    out = []
    for _ in range(n):
        raw = "".join(secrets.choice(_ALPHABET) for _ in range(8))
        out.append(f"{raw[:4]}-{raw[4:]}")
    return out


def _load(user: User) -> list[str]:
    try:
        v = json.loads(getattr(user, "totp_recovery_codes", None) or "[]")
        return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []
    except ValueError:
        return []


def set_codes(user: User, codes: list[str]) -> None:
    """평문 코드 목록을 해시로 변환하여 사용자에 기록(커밋은 호출자)."""
    user.totp_recovery_codes = json.dumps([_digest(c) for c in codes])


def clear_codes(user: User) -> None:
    user.totp_recovery_codes = None


def remaining(user: User) -> int:
    return len(_load(user))


def consume(user: User, code: str) -> bool:
    """복구 코드가 일치하면 삭제 후 True(커밋은 호출자). 형식이 TOTP(숫자 6자리)이면 대조를 생략한다."""
    norm = _normalize(code)
    if len(norm) != 8:
        return False
    d = _digest(norm)
    hashes = _load(user)
    for h in hashes:
        if hmac.compare_digest(h, d):
            hashes.remove(h)
            user.totp_recovery_codes = json.dumps(hashes)
            return True
    return False


def issue_new_codes(user: User) -> list[str]:
    codes = generate_codes()
    set_codes(user, codes)
    return codes


# ── API ──────────────────────────────────────────────────


class CodeBody(BaseModel):
    code: str


@router.get("/status")
async def two_factor_status(user: User = Depends(get_current_user)):
    """본인 2단계 인증 상태 — 활성화 여부, 잔여 복구 코드, 관리자 정책상 필수 여부."""
    from app.auth import security_policy

    pol = await security_policy.get_policy_cached()
    return {
        "enabled": bool(user.totp_secret),
        "recovery_total": RECOVERY_COUNT,
        "recovery_remaining": remaining(user) if user.totp_secret else 0,
        "required": security_policy.totp_required_for(pol, user),
    }


@router.post("/recovery-codes")
@limiter.limit("5/minute")
async def regenerate_recovery_codes(
    request: Request,
    body: CodeBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """복구 코드 신규 발급 — 인증 앱 코드로 본인 확인 후, 기존 코드는 모두 폐기."""
    if not user.totp_secret:
        raise HTTPException(status_code=400, detail="2단계 인증이 켜져 있지 않습니다")
    if not pyotp.TOTP(user.totp_secret).verify((body.code or "").strip(), valid_window=1):
        raise HTTPException(status_code=400, detail="인증 코드가 올바르지 않습니다")
    codes = issue_new_codes(user)
    await db.commit()
    return {"recovery_codes": codes, "recovery_remaining": len(codes)}
