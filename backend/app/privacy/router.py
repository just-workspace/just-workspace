"""Content-lock endpoints: set PIN, unlock (mint in-memory token), status."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.auth.deps import get_current_user
from app.auth.password import verify_password
from app.db.models import User
from app.privacy import gate

router = APIRouter(prefix="/api/privacy", tags=["privacy"])

_MAX_FAILS = 5


class SetPinRequest(BaseModel):
    account_password: str   # 본인 인증 — 게스트·어깨너머 관찰자가 금고 열쇠를 생성하지 못하도록 함
    new_pin: str


class UnlockRequest(BaseModel):
    pin: str


@router.get("/status")
async def status(request: Request, user: User = Depends(get_current_user)):
    """has_pin: 금고 설정 여부 / unlocked: 본 요청의 해제 토큰 보유 여부."""
    return {
        "has_pin": await gate.has_pin(user.id),
        "unlocked": gate.is_unlocked(request, user),
    }


@router.post("/set-pin")
async def set_pin(body: SetPinRequest, user: User = Depends(get_current_user)):
    if not user.password_hash or not verify_password(body.account_password, user.password_hash):
        raise HTTPException(status_code=403, detail="계정 비밀번호가 올바르지 않습니다")
    pin = (body.new_pin or "").strip()
    if not (pin.isdigit() and gate.PIN_MIN <= len(pin) <= gate.PIN_MAX):
        raise HTTPException(status_code=400, detail=f"PIN은 숫자 {gate.PIN_MIN}~{gate.PIN_MAX}자리여야 합니다")
    await gate.set_pin(user.id, pin)
    return {"ok": True}


@router.post("/unlock")
async def unlock(body: UnlockRequest, user: User = Depends(get_current_user)):
    if not await gate.has_pin(user.id):
        raise HTTPException(status_code=400, detail="PIN이 설정되지 않았습니다")
    if await gate.fail_count(user.id) >= _MAX_FAILS:
        raise HTTPException(status_code=429, detail="시도 횟수 초과 — 잠시 후 다시 시도하십시오")
    if not await gate.verify_pin(user.id, (body.pin or "").strip()):
        n = await gate.register_fail(user.id)
        raise HTTPException(status_code=403, detail=f"PIN이 올바르지 않습니다 (남은 시도 {max(0, _MAX_FAILS - n)})")
    await gate.clear_fails(user.id)
    return {"token": gate.make_unlock_token(user.id)}
