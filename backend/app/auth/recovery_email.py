"""복구 이메일 변경 — 본인 확인 → 새 주소 인증 → 교체 + 옛 주소 알림.

왜 따로 두나
  복구 이메일은 비밀번호 재설정 링크가 가는 주소다. 예전에는 로그인만 돼 있으면 PATCH /api/auth/profile 로
  바로 바꿀 수 있어서, 세션 하나를 탈취한 사람이 주소를 자기 것으로 바꾸고 "비밀번호 찾기" 로 계정을
  영구히 가져갈 수 있었다. 이제는

    1. POST /api/auth/recovery-email/request   현재 비밀번호(없는 계정은 2단계 코드)로 본인 확인
                                               → 새 주소로 확인 링크. 이 시점에는 아무것도 바뀌지 않는다.
                                               (주소를 비우는 요청은 확인할 새 주소가 없으니 본인 확인만으로 바로 비운다)
    2. POST /api/auth/recovery-email/check     링크 착지 화면용 — 토큰이 살아 있나(쓰지 않고 보기만)
    3. POST /api/auth/recovery-email/confirm   사용자가 화면의 확인 버튼을 눌렀을 때 → 실제 교체 + 알림 + 감사 로그
       (착지만으로는 바뀌지 않는다 — 메일 보안 장비가 링크를 미리 열어 봐도 확정되지 않게)

  보류 상태는 Redis 에만 둔다(TTL, DB 컬럼 없음). 관리자가 다른 사용자의 주소를 바꾸는 경로
  (app/admin/router.py)는 이 절차와 무관하다.

Redis 키
  recovery-email:tok:<sha256(token)>  → {"uid","new","old","tv"}   한 번만 쓴다(GETDEL)
  recovery-email:user:<uid>           → {"digest","new"}            화면의 "확인 대기 중" 표시·새 요청 시 이전 링크 폐기
  recovery-email:done:<sha256(token)> → {"at"}                      확정된 링크를 다시 열었을 때 "이미 적용됨" 안내용
  recovery-email:fail:<uid>           → 본인 확인 시도 수(INCR)      탈취한 세션으로 비밀번호를 대입하지 못하게
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
from datetime import datetime, timezone

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import password_policy
from app.auth.deps import get_current_user
from app.auth.password import verify_password
from app.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.rate_limit import limiter

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api/auth/recovery-email", tags=["auth"])

#: 확인 링크 수명(초). 비밀번호 재설정 링크(1시간)와 같게 — 길수록 가로챈 링크의 값어치가 커진다
PENDING_TTL = 3600
#: 본인 확인 연속 실패 허용 횟수·잠금 시간 — 로그인 2단계 잠금(security_policy)과 같은 값
REAUTH_MAX_FAILS = 5
REAUTH_LOCK_SECONDS = 600

_TOK = "recovery-email:tok:"
_USER = "recovery-email:user:"
_FAIL = "recovery-email:fail:"
_DONE = "recovery-email:done:"


async def _redis():
    from app.chat.redis_client import get_redis
    return await get_redis()


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def normalize_email(v: str | None) -> str:
    return (v or "").strip().lower()


# ── 본인 확인 ──


async def reauth_method(db: AsyncSession, user: User) -> str:
    """이 계정이 무엇으로 본인 확인을 하나 — "password" | "totp" | "none".

    - 로컬 비밀번호가 있고 써도 되는 계정, 그리고 LDAP 계정(디렉터리 비밀번호): password
    - 비밀번호를 확인할 길이 없는데 2단계 인증을 쓰는 계정: totp
    - 둘 다 없으면 none — 스스로 바꿀 수 없다(관리자에게 요청)
    """
    from app.auth.router import is_local_account, local_password_allowed

    if await local_password_allowed(db, user):
        if user.password_hash:
            return "password"
    elif not is_local_account(user):
        return "password"            # LDAP 이 켜져 있는 LDAP 계정 — 디렉터리에 묻는다
    return "totp" if user.totp_secret else "none"


async def _check_password(db: AsyncSession, user: User, password: str) -> bool:
    from app.auth.router import local_password_allowed

    if await local_password_allowed(db, user):
        return bool(user.password_hash) and verify_password(password, user.password_hash)
    # 디렉터리 장애(LdapUnavailable)는 여기서 삼키지 않는다 — "틀림"으로 세면 장애 때 사용자가 잠긴다
    from app.auth import ldap_client
    return bool(await ldap_client.authenticate_strict(db, user.username, password))


def _check_totp(user: User, code: str) -> bool:
    """인증 앱 코드만 받는다 — 복구 코드는 여기서 소모하지 않는다(로그인용으로 아껴 둔다)."""
    code = (code or "").replace(" ", "").strip()
    return bool(user.totp_secret) and bool(code) and pyotp.TOTP(user.totp_secret).verify(code, valid_window=1)


async def _reserve_attempt(user_id: str) -> None:
    """본인 확인 시도 한 번을 **먼저** 센다(INCR) — 확인(GET)과 기록(INCR)을 따로 하면 동시에 쏜 요청들이
    모두 "아직 안 잠김"을 보고 한도를 넘겨 대입할 수 있다. 한도를 넘었으면 429, 성공하면 _clear_fail 이 지운다.

    Redis 에 못 닿으면 503 — 잠금을 판정할 수 없는 채로 비밀번호 검증을 진행하지 않는다(fail-closed)."""
    try:
        r = await _redis()
        n = int(await r.incr(_FAIL + user_id))
        ttl = int(await r.ttl(_FAIL + user_id) or -1)
        if n == 1 or ttl < 0:
            await r.expire(_FAIL + user_id, REAUTH_LOCK_SECONDS)
            ttl = REAUTH_LOCK_SECONDS
    except Exception as e:  # noqa: BLE001
        logger.error("[recovery-email] attempt counter unavailable: %s", e)
        raise HTTPException(status_code=503, detail="잠시 후 다시 시도해주세요")
    if n > REAUTH_MAX_FAILS:
        mins = max(1, (ttl + 59) // 60)
        raise HTTPException(
            status_code=429,
            detail=f"본인 확인을 여러 번 틀렸습니다. {mins}분 뒤에 다시 시도하세요",
            headers={"Retry-After": str(max(1, ttl))},
        )


async def _release_attempt(user_id: str) -> None:
    """판정을 못 한 시도(디렉터리 장애)는 세지 않는다."""
    try:
        r = await _redis()
        await r.decr(_FAIL + user_id)
    except Exception:  # noqa: BLE001
        pass


async def _clear_fail(user_id: str) -> None:
    try:
        r = await _redis()
        await r.delete(_FAIL + user_id)
    except Exception:  # noqa: BLE001
        pass


# ── 보류 상태 ──


async def _pending_of(user_id: str) -> tuple[dict | None, int]:
    """(보류 기록, 남은 초). 없으면 (None, 0)."""
    r = await _redis()
    raw = await r.get(_USER + user_id)
    if not raw:
        return None, 0
    try:
        rec = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None, 0
    if not isinstance(rec, dict) or not rec.get("new"):
        return None, 0
    return rec, max(0, int(await r.ttl(_USER + user_id) or 0))


async def _drop_pending(user_id: str) -> None:
    r = await _redis()
    rec, _ = await _pending_of(user_id)
    keys = [_USER + user_id]
    if rec and rec.get("digest"):
        keys.append(_TOK + str(rec["digest"]))
    await r.delete(*keys)


# ── 메일 ──


async def _send(to_email: str, subject: str, body: str) -> None:
    from email.mime.text import MIMEText

    from app.admin.settings import get_smtp_config, send_system_email
    from app.db.session import async_session

    async with async_session() as db:
        cfg = await get_smtp_config(db)
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = cfg.from_addr
    msg["To"] = to_email
    await asyncio.to_thread(send_system_email, cfg, msg)


async def _send_confirm_mail(to_email: str, username: str, confirm_url: str) -> None:
    await _send(
        to_email,
        f"[{settings.domain}] 복구 이메일 확인",
        f"{username} 계정의 복구 이메일을 이 주소로 바꾸려는 요청이 있었습니다.\n"
        f"본인이 요청했다면 아래 링크를 눌러 확인해주세요:\n\n"
        f"{confirm_url}\n\n"
        f"이 링크는 {PENDING_TTL // 60}분 후 만료됩니다. 확인하기 전에는 아무것도 바뀌지 않습니다.\n"
        f"본인이 요청하지 않은 경우 이 메일을 무시하세요.",
    )


def _notice_target(user: User, old: str | None, new: str | None) -> str | None:
    """변경 알림을 받을 곳 — 옛 복구 주소, 없던 계정은 워크스페이스 메일함(user.email). 새 주소와 같으면 보내지 않는다."""
    to = normalize_email(old) or normalize_email(user.email)
    return to if to and to != normalize_email(new) else None


async def _send_changed_notice(to_email: str, username: str, ip: str, cleared: bool = False) -> None:
    """바뀐 사실만 알린다(새 주소는 싣지 않는다: 이 편지함이 남의 손에 있을 수도 있다)."""
    when = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    what = "삭제되었습니다" if cleared else "다른 주소로 변경되었습니다"
    after = ("이제 이 계정은 비밀번호 재설정 링크를 받을 주소가 없습니다." if cleared
             else "이제 비밀번호 재설정 링크는 새 주소로만 갑니다.")
    try:
        await _send(
            to_email,
            f"[{settings.domain}] 복구 이메일이 {'삭제' if cleared else '변경'}되었습니다",
            f"{username} 계정의 복구 이메일이 {what}.\n"
            f"{after}\n\n"
            f"시각: {when}\nIP: {ip or '-'}\n\n"
            f"본인이 바꾼 것이 아니라면 바로 {settings.app_url.rstrip('/')}/settings/security 에서 "
            f"비밀번호를 바꾸고 로그인된 기기를 확인한 뒤 관리자에게 알려주세요.",
        )
    except Exception as e:  # noqa: BLE001 — 알림 실패가 변경 자체를 되돌리지는 않는다
        logger.warning("[recovery-email] change notice failed for %s: %s", username, e)


# ── API ──


class RecoveryEmailRequest(BaseModel):
    # 빈 값 = 복구 이메일을 비운다(같은 본인 확인을 거쳐 바로 — 확인할 새 주소가 없다)
    recovery_email: str = Field(default="", max_length=320)
    current_password: str | None = Field(default=None, max_length=password_policy.MAX_LENGTH)
    # 비밀번호를 확인할 길이 없는 계정만 — 인증 앱 코드
    code: str | None = Field(default=None, max_length=16)

    @field_validator("recovery_email")
    @classmethod
    def validate_recovery_email(cls, v: str) -> str:
        v = normalize_email(v)
        if not v:
            return ""
        # 주소 하나만 — 쉼표·세미콜론·꺾쇠·공백·따옴표·@ 여러 개는 거부한다. To 헤더에 그대로 실리는 값이라
        # 여러 주소가 섞이면 확인 링크가 남에게도 간다. 판정은 파일 공유 메일과 같은 규칙(share_email)을 쓴다.
        from app.files.share_email import normalize_recipients
        good, _bad = normalize_recipients([v])
        if len(good) != 1:
            raise ValueError("올바른 이메일 주소를 하나만 입력해주세요")
        return good[0]


class RecoveryEmailConfirm(BaseModel):
    token: str = Field(..., min_length=16, max_length=256)


def _ip(request: Request) -> str:
    from app.auth import sessions as sess_mod
    return sess_mod.client_ip(request)


@router.get("/pending")
async def pending(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """설정 화면용 — 확인 대기 중인 새 주소와 이 계정의 본인 확인 수단."""
    method = await reauth_method(db, user)
    try:
        rec, ttl = await _pending_of(user.id)
    except Exception as e:  # noqa: BLE001 — 표시용이라 Redis 장애면 "없음"
        logger.debug("[recovery-email] pending lookup failed: %s", e)
        rec, ttl = None, 0
    return {"pending_email": rec["new"] if rec else None, "expires_in": ttl if rec else 0, "reauth": method}


@router.post("/request")
@limiter.limit("5/minute")
async def request_change(
    request: Request,
    body: RecoveryEmailRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """본인 확인 뒤 새 주소로 확인 링크를 보낸다. 링크를 누르기 전에는 복구 이메일이 바뀌지 않는다."""
    new = body.recovery_email
    old = normalize_email(user.recovery_email)
    if new == old:
        raise HTTPException(status_code=400, detail="지금 쓰는 복구 이메일과 같은 주소입니다" if new
                            else "등록된 복구 이메일이 없습니다")

    method = await reauth_method(db, user)
    if method == "none":
        raise HTTPException(
            status_code=400,
            detail="이 계정은 비밀번호나 2단계 인증으로 본인 확인을 할 수 없어 복구 이메일을 직접 바꿀 수 없습니다. 관리자에게 요청하세요",
        )
    # 시도를 먼저 센다(잠겼으면 429, Redis 가 없으면 503) — 비밀번호 검증은 그 뒤에만
    await _reserve_attempt(user.id)
    if method == "password":
        try:
            ok = bool(body.current_password) and await _check_password(db, user, body.current_password)
        except Exception as e:  # noqa: BLE001 — 디렉터리에 물어볼 수 없었다: 틀린 것이 아니다
            logger.warning("[recovery-email] reauth backend unavailable for %s: %s", user.username, e)
            await _release_attempt(user.id)
            raise HTTPException(status_code=503, detail="지금은 비밀번호를 확인할 수 없습니다. 잠시 후 다시 시도해주세요")
        fail_msg = "현재 비밀번호가 올바르지 않습니다"
    else:
        ok = _check_totp(user, body.code or "")
        fail_msg = "인증 코드가 올바르지 않습니다"
    if not ok:
        from app.admin import audit
        await audit.log_action(db, user.id, "user.recovery_email.reauth_failed", "user", user.id,
                               {"method": method}, _ip(request) or None)
        raise HTTPException(status_code=400, detail=fail_msg)
    await _clear_fail(user.id)

    if not new:
        # 비우기 — 본인 확인이 끝났으니 바로. 걸려 있던 변경 요청·옛 주소로 나간 재설정 링크도 같이 거둔다
        previous = user.recovery_email
        user.recovery_email = None
        user.password_reset_token = None
        await db.commit()
        try:
            await _drop_pending(user.id)
        except Exception:  # noqa: BLE001
            pass
        ip = _ip(request)
        from app.admin import audit
        await audit.log_action(db, user.id, "user.recovery_email.cleared", "user", user.id,
                               {"old": previous, "method": method}, ip or None)
        if previous:
            await _send_changed_notice(previous, user.username, ip, cleared=True)
        return {"message": "복구 이메일을 지웠습니다.", "cleared": True, "pending_email": None, "expires_in": 0}

    token = secrets.token_urlsafe(32)
    digest = _digest(token)
    try:
        r = await _redis()
        await _drop_pending(user.id)        # 이전 요청의 링크는 죽인다 — 살아 있는 링크는 늘 하나
        await r.set(_TOK + digest, json.dumps({"uid": user.id, "new": new, "old": old, "tv": user.token_version or 0}),
                    ex=PENDING_TTL)
        await r.set(_USER + user.id, json.dumps({"digest": digest, "new": new}), ex=PENDING_TTL)
    except Exception as e:  # noqa: BLE001 — 보류 상태를 둘 곳이 없으면 진행하지 않는다
        logger.error("[recovery-email] pending store failed: %s", e)
        raise HTTPException(status_code=503, detail="잠시 후 다시 시도해주세요")

    confirm_url = f"{settings.app_url.rstrip('/')}/verify-email?change={token}"
    try:
        await _send_confirm_mail(new, user.username, confirm_url)
    except Exception as e:  # noqa: BLE001 — 메일이 안 나갔으면 사용자가 기다리게 두지 않는다
        logger.warning("[recovery-email] confirm mail to %s failed: %s", new, e)
        try:
            await _drop_pending(user.id)
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(status_code=502, detail="확인 메일을 보내지 못했습니다. 주소를 확인하고 다시 시도해주세요")

    from app.admin import audit
    await audit.log_action(db, user.id, "user.recovery_email.change_requested", "user", user.id,
                           {"new": new, "method": method}, _ip(request) or None)
    return {"message": "새 주소로 확인 메일을 보냈습니다. 메일의 링크를 눌러야 변경이 끝납니다.",
            "pending_email": new, "expires_in": PENDING_TTL}


@router.delete("/pending")
async def cancel(request: Request, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """확인 대기 중인 변경을 거둔다(보낸 링크도 죽는다)."""
    try:
        rec, _ = await _pending_of(user.id)
        await _drop_pending(user.id)
    except Exception as e:  # noqa: BLE001
        logger.error("[recovery-email] cancel failed: %s", e)
        raise HTTPException(status_code=503, detail="잠시 후 다시 시도해주세요")
    if rec:
        from app.admin import audit
        await audit.log_action(db, user.id, "user.recovery_email.change_cancelled", "user", user.id,
                               {"new": rec.get("new")}, _ip(request) or None)
    return {"ok": True}


async def _done(digest: str) -> bool:
    try:
        r = await _redis()
        return bool(await r.get(_DONE + digest))
    except Exception:  # noqa: BLE001
        return False


@router.post("/check")
@limiter.limit("20/minute")
async def check(request: Request, body: RecoveryEmailConfirm):
    """착지 화면용 — 이 링크가 아직 확정을 기다리나(pending), 이미 적용됐나(done), 죽었나(invalid).
    토큰을 쓰지 않는다: 메일 보안 장비가 링크를 미리 열어도, 사용자가 새로고침해도 상태가 변하지 않는다."""
    digest = _digest(body.token)
    try:
        r = await _redis()
        if await r.get(_TOK + digest):
            return {"state": "pending"}
        if await r.get(_DONE + digest):
            return {"state": "done"}
    except Exception as e:  # noqa: BLE001
        logger.error("[recovery-email] check failed: %s", e)
        raise HTTPException(status_code=503, detail="잠시 후 다시 시도해주세요")
    return {"state": "invalid"}


@router.post("/confirm")
@limiter.limit("10/minute")
async def confirm(request: Request, body: RecoveryEmailConfirm, db: AsyncSession = Depends(get_db)):
    """확인 화면의 버튼 → 실제 교체. 로그인은 요구하지 않는다 — 메일을 다른 기기에서 여는 일이 흔하고,
    요청 단계에서 이미 본인 확인을 했으며 토큰(256비트)을 가졌다는 것이 새 주소의 소유 증명이다."""
    invalid = HTTPException(status_code=400, detail="유효하지 않거나 만료된 확인 링크입니다. 설정에서 다시 요청해주세요")
    digest = _digest(body.token)
    try:
        from app.rbi.service import take_once
        rec = await take_once(_TOK + digest)     # 한 번만 — 꺼내는 순간 사라진다
    except Exception as e:  # noqa: BLE001
        logger.error("[recovery-email] confirm lookup failed: %s", e)
        raise HTTPException(status_code=503, detail="잠시 후 다시 시도해주세요")
    if not rec or not rec.get("uid") or not rec.get("new"):
        # 이미 확정한 링크를 다시 눌렀다(두 번 클릭·새로고침) — 실패가 아니다
        if await _done(digest):
            return {"message": "복구 이메일이 이미 변경되었습니다.", "already": True}
        raise invalid
    user = await db.get(User, rec["uid"])
    if not user or not user.is_active:
        raise invalid
    # 요청 뒤 비밀번호 변경·강제 로그아웃·정지(token_version 증가)가 있었으면 그 요청은 무효 —
    # 탈취를 눈치채고 세션을 끊었는데 미리 받아 둔 링크로 주소가 바뀌면 안 된다.
    # 그 사이 주소가 달라졌어도(관리자 변경 등) 옛 요청으로 덮어쓰지 않는다.
    if rec.get("tv") != (user.token_version or 0) or normalize_email(user.recovery_email) != (rec.get("old") or ""):
        try:
            await _drop_pending(user.id)
        except Exception:  # noqa: BLE001
            pass
        raise invalid

    old = user.recovery_email
    user.recovery_email = rec["new"]
    # 옛 주소로 이미 나간 비밀번호 재설정 링크는 죽인다(주소를 바꾼 뜻이 없어진다)
    user.password_reset_token = None
    await db.commit()
    try:
        r = await _redis()
        await r.delete(_USER + user.id)
        # 같은 링크를 다시 열면 "이미 적용됨"으로 보이게(링크 수명만큼만 기억)
        await r.set(_DONE + digest, json.dumps({"at": int(datetime.now(timezone.utc).timestamp())}), ex=PENDING_TTL)
    except Exception:  # noqa: BLE001
        pass

    ip = _ip(request)
    from app.admin import audit
    await audit.log_action(db, user.id, "user.recovery_email.changed", "user", user.id,
                           {"old": old, "new": rec["new"]}, ip or None)
    # 옛 복구 주소로 알린다. 옛 주소가 없던 계정은 워크스페이스 메일함으로 — 어디에도 안 알리면
    # 탈취한 세션+비밀번호로 처음 주소를 심는 것을 계정 주인이 알 길이 없다
    to = _notice_target(user, old, rec["new"])
    if to:
        await _send_changed_notice(to, user.username, ip)
    return {"message": "복구 이메일이 변경되었습니다."}
