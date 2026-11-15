"""AI 쓰기 도구 확인 토큰.

모델이 쓰기 도구를 부르면 서버는 실행하지 않고 이 토큰을 화면에 넘긴다. 사용자가 승인하면
화면이 POST /api/ai/tools/confirm 으로 토큰을 돌려보내고, 그때 한 번만 실행된다.

- 서명(itsdangerous, 전용 salt) — 사용자·대화·도구·인자를 묶는다(인자를 바꾸면 무효)
- 수명 TTL 초
- 한 번만 — Redis 에 jti 를 SET NX. Redis 를 못 쓰면 실행하지 않는다(fail-closed)
"""
from __future__ import annotations

import hashlib
import json
import secrets

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import get_settings

TTL = 600
_SALT = "ai-tool-confirm-v1"


class ConfirmError(Exception):
    pass


def _signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt=_SALT)


def _args_hash(args: dict) -> str:
    return hashlib.sha256(json.dumps(args or {}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


async def issue(user_id: str, conv_id: str, name: str, args: dict) -> str:
    return _signer().dumps({
        "u": str(user_id), "c": str(conv_id), "n": name, "h": _args_hash(args),
        "a": args or {}, "j": secrets.token_hex(12),
    })


async def _redis():
    from app.chat.redis_client import get_redis
    return await get_redis()


async def consume(token: str, user_id: str) -> dict:
    """검증 + 1회 소모 → {"conv_id", "name", "args"}."""
    try:
        data = _signer().loads(token, max_age=TTL)
    except SignatureExpired:
        raise ConfirmError("확인 시간이 지났습니다 — 다시 요청하세요")
    except BadSignature:
        raise ConfirmError("잘못된 확인 요청입니다")
    if not isinstance(data, dict) or data.get("u") != str(user_id):
        raise ConfirmError("잘못된 확인 요청입니다")
    args = data.get("a") or {}
    if not isinstance(args, dict) or _args_hash(args) != data.get("h"):
        raise ConfirmError("잘못된 확인 요청입니다")
    try:
        r = await _redis()
        ok = await r.set(f"ai:toolconfirm:{data.get('j')}", "1", ex=TTL, nx=True)
    except Exception:
        raise ConfirmError("지금은 확인을 처리할 수 없습니다 — 잠시 뒤 다시 시도하세요")
    if not ok:
        raise ConfirmError("이미 처리된 확인 요청입니다")
    return {"conv_id": data.get("c"), "name": data.get("n"), "args": args}
