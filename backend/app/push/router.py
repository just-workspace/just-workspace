"""Push notification API — VAPID key distribution + subscription management."""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.db.models import PushSubscription as PushSubModel, User
from app.db.session import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/push", tags=["push"])


class PushSubscription(BaseModel):
    endpoint: str
    keys: dict
    expirationTime: float | None = None


VAPID_SETTING_KEY = "push.vapid"
_vapid_cache: tuple[str, str] | None = None


def _b64url(b: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    import base64
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def generate_vapid_keys() -> tuple[str, str]:
    """(공개 키, 비공개 키) — 공개 = 비압축 점 65바이트, 비공개 = 32바이트 정수, 둘 다 base64url(패딩 없음).

    py_vapid 의 키 출력 메서드는 판마다 이름이 달라(1.9 엔 public_key_urlsafe_base64 가 없다 → 500)
    cryptography 로 직접 만든다. 비공개 키 형식은 pywebpush(py_vapid Vapid.from_string)가 그대로 읽는다."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    priv = _b64url(key.private_numbers().private_value.to_bytes(32, "big"))
    pub = _b64url(key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
    return pub, priv


def public_from_private(priv: str) -> str:
    """비공개 키(32바이트 base64url)에서 공개 키를 다시 만든다 — env 에 비공개 키만 있을 때."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.derive_private_key(int.from_bytes(_b64url_decode(priv), "big"), ec.SECP256R1())
    return _b64url(key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))


async def get_vapid_keys(db: AsyncSession) -> tuple[str, str]:
    """VAPID 키 — env(VAPID_PUBLIC_KEY/PRIVATE_KEY) → DB 저장본 → 없으면 만들어 DB 에 저장.

    워커 8개가 동시에 처음 부르면 각자 만들 수 있으므로 한 행(PK) INSERT 로 경쟁하고, 진 쪽은 저장된 것을 다시 읽는다.
    (예전엔 워커·재시작마다 다른 키를 만들어 구독이 깨지고, 그나마 없는 메서드를 불러 500 이었다.)"""
    global _vapid_cache
    from app.config import get_settings
    from app.db.models import SystemSetting
    from sqlalchemy.exc import IntegrityError

    settings = get_settings()
    priv = (settings.vapid_private_key or "").strip()
    if priv:
        pub = (settings.vapid_public_key or "").strip() or public_from_private(priv)
        return pub, priv
    if _vapid_cache:
        return _vapid_cache

    async def _read() -> tuple[str, str] | None:
        row = await db.get(SystemSetting, VAPID_SETTING_KEY)
        if row is None:
            return None
        try:
            d = json.loads(row.value)
            if d.get("public") and d.get("private"):
                return d["public"], d["private"]
        except (ValueError, AttributeError):
            pass
        logger.warning("저장된 VAPID 키(%s)를 읽지 못했습니다", VAPID_SETTING_KEY)
        return None

    got = await _read()
    if got is None:
        pub, priv = generate_vapid_keys()
        try:
            db.add(SystemSetting(key=VAPID_SETTING_KEY, value=json.dumps({"public": pub, "private": priv})))
            await db.commit()
            logger.info("VAPID 키를 만들어 DB(%s)에 저장했습니다", VAPID_SETTING_KEY)
            got = (pub, priv)
        except IntegrityError:
            await db.rollback()      # 다른 워커가 먼저 저장 — 그 키를 쓴다
            got = await _read()
    if got:
        _vapid_cache = got
        return got
    return "", ""


@router.get("/vapid-key")
async def get_vapid_key(db: AsyncSession = Depends(get_db)):
    """Return VAPID public key for client subscription."""
    try:
        pub, _ = await get_vapid_keys(db)
    except Exception:
        logger.exception("VAPID 키 준비 실패")
        pub = ""
    if not pub:
        raise HTTPException(status_code=503, detail="Push notifications not configured")
    return {"vapid_public_key": pub}


@router.post("/subscribe")
async def subscribe(
    sub: PushSubscription,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Store push subscription for the current user."""
    user_id = str(user.id)

    # 같은 브라우저(endpoint)에 남아 있는 다른 사용자의 구독은 지운다 — 공용 PC 에서 앞 사람이 구독을
    # 풀지 않고 떠났어도 그 사람 알림이 지금 사용자 화면에 뜨지 않게.
    await db.execute(
        delete(PushSubModel).where(
            PushSubModel.endpoint == sub.endpoint,
            PushSubModel.user_id != user_id,
        )
    )

    # Avoid duplicates
    existing = await db.execute(
        select(PushSubModel).where(
            PushSubModel.user_id == user_id,
            PushSubModel.endpoint == sub.endpoint,
        )
    )
    if existing.scalars().first():
        await db.commit()
        return {"ok": True}

    row = PushSubModel(
        user_id=user_id,
        endpoint=sub.endpoint,
        keys_json=json.dumps(sub.keys),
        expiration_time=sub.expirationTime,
    )
    db.add(row)
    await db.commit()
    logger.info("Push subscription added for user %s", user_id)
    return {"ok": True}


@router.post("/unsubscribe")
async def unsubscribe(
    sub: PushSubscription,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove push subscription for the current user."""
    await db.execute(
        delete(PushSubModel).where(
            PushSubModel.user_id == str(user.id),
            PushSubModel.endpoint == sub.endpoint,
        )
    )
    await db.commit()
    return {"ok": True}


def _is_gone(exc: Exception) -> bool:
    """푸시 서버가 "이 구독은 없다" 고 답했나(404 Not Found · 410 Gone)."""
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status in (404, 410)


async def send_push(user_id: str, title: str, body: str, url: str | None = None,
                    bypass_dnd: bool = False) -> int:
    """Send push notification to all subscriptions of a user. 보낸 구독 수를 돌려준다.

    방해 금지 일정(app/notifications/dnd.py)에 걸리면 보내지 않는다 — 모든 웹푸시가 여기를 지나므로
    채팅 멘션·알림 센터 푸시 모두에 적용된다. 시험 푸시만 bypass_dnd=True 로 건너뛴다.
    """
    from app.db.session import async_session

    if not bypass_dnd:
        from app.notifications.dnd import schedule_blocks
        if await schedule_blocks(user_id):
            return 0

    async with async_session() as db:
        result = await db.execute(
            select(PushSubModel).where(PushSubModel.user_id == user_id)
        )
        subs = result.scalars().all()

    if not subs:
        return 0

    async with async_session() as db:
        _, priv = await get_vapid_keys(db)
    if not priv:
        return 0

    try:
        from pywebpush import webpush
    except ImportError:
        logger.warning("pywebpush not installed — cannot send push")
        return 0

    from app.config import get_settings
    settings = get_settings()
    claims = {"sub": f"mailto:{settings.smtp_from or 'noreply@localhost'}"}

    payload = json.dumps({
        "title": title,
        "body": body,
        "url": url or "/",
    })

    import asyncio

    dead_ids = []
    sent = 0
    for sub in subs:
        try:
            sub_info = {"endpoint": sub.endpoint, "keys": json.loads(sub.keys_json)}
            # webpush 는 동기 HTTP 호출이다 — 이벤트 루프(다른 요청·웹소켓)를 막지 않게 스레드에서.
            # vapid_claims 는 호출마다 aud 가 채워지므로 구독마다 사본을 준다.
            await asyncio.to_thread(
                webpush,
                subscription_info=sub_info,
                data=payload,
                vapid_private_key=priv,
                vapid_claims=dict(claims),
            )
            sent += 1
        except Exception as e:
            logger.debug("Push send failed for %s: %s", sub.endpoint[:50], e)
            # 구독이 정말 사라졌을 때(404·410)만 지운다. 타임아웃·5xx·429 같은 일시 오류에 지우면
            # 사용자가 앱을 다시 열 때까지 푸시가 끊긴다.
            if _is_gone(e):
                dead_ids.append(sub.id)

    # Clean up expired/dead subscriptions
    if dead_ids:
        async with async_session() as db:
            await db.execute(
                delete(PushSubModel).where(PushSubModel.id.in_(dead_ids))
            )
            await db.commit()
    return sent
