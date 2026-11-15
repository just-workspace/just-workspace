"""메일 인박스 폴러 — 새 INBOX 메일 감지 → AI 소비자용 이벤트 발행 (Part 3: 폴링 + 이벤트훅).

- 8워커 중 매 주기 1개만 폴링(Redis 락).
- 계정별 마지막 UID는 DB(mail_accounts.last_seen_uid)에 둔다. 첫 폴은 baseline만 잡고 이벤트 미발행(과거메일 폭주 방지).
  예전에는 Redis 에만 있었다(`mail:lastuid:<계정>`) — DB 에 값이 없을 때 한 번 읽어 옮긴다.
- 새 메일 → Redis pub 채널 `mail:new` 로 발행. AI 처리는 별도 소비자(플러그인)가 구독.
  (코어는 "감지 → 이벤트"까지만 = 확장 유연. 소비 예: 플러그인이 LLM 으로 분류/요약.)

소비자 예시:
    redis = await get_redis()
    ps = redis.pubsub(); await ps.subscribe("mail:new")
    async for msg in ps.listen(): ... json.loads(msg["data"]) ...
"""
from __future__ import annotations

import asyncio
import json
import logging
import os

from sqlalchemy import select, update

from app.chat.redis_client import get_redis
from app.db.models import MailAccount
from app.db.session import async_session
from app.mail import archive, imap_client

logger = logging.getLogger(__name__)

POLL_INTERVAL = int(os.getenv("MAIL_POLL_INTERVAL", "120"))  # 초
EVENT_CHANNEL = "mail:new"
_LOCK_KEY = "mail:poll:lock"


def _lastuid_key(account_id: str) -> str:
    """예전 저장 위치(Redis). 읽는 것은 DB 에 값이 없을 때 한 번뿐이다."""
    return f"mail:lastuid:{account_id}"


async def _load_last_seen(redis, account: MailAccount) -> int:
    """마지막으로 본 UID. 0 = 아직 기준을 잡지 않았다."""
    current = getattr(account, "last_seen_uid", None)
    if current:
        return int(current)
    # DB 에 없다 — 예전 위치에 있으면 옮겨 온다(업데이트 직후 한 번).
    try:
        raw = await redis.get(_lastuid_key(account.id))
    except Exception as e:  # noqa: BLE001
        logger.warning("[mailpoll] %s 예전 위치를 읽지 못했습니다: %s", account.email, e)
        return 0
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode()
    try:
        legacy = int(raw) if raw else 0
    except ValueError:
        legacy = 0
    if legacy:
        await _save_last_seen(redis, account, legacy, mirror=False)
    return legacy


async def _save_last_seen(redis, account: MailAccount, uid: int, *, mirror: bool = True) -> None:
    async with async_session() as db:
        await db.execute(
            update(MailAccount)
            .where(MailAccount.id == account.id)
            # 계정 설정을 고친 것이 아니다 — 수정 시각은 그대로 둔다.
            .values(last_seen_uid=uid, updated_at=MailAccount.updated_at)
        )
        await db.commit()
    account.last_seen_uid = uid
    if not mirror:
        return
    # 예전 위치에도 같은 값을 써 둔다(읽지 않는 사본). 업데이트가 실패해 이전 버전으로 되돌아가면
    # 그 버전은 이 키만 읽는다 — 낡은 값이 남아 있으면 그 사이의 메일을 새 메일로 다시 알린다.
    try:
        await redis.set(_lastuid_key(account.id), str(uid))
    except Exception:  # noqa: BLE001
        pass


async def _poll_account(redis, account: MailAccount) -> None:
    # POP3 계정은 서버측 UID/푸시 개념이 없어 폴러 대상 제외(열 때 on-demand 조회).
    if getattr(account, "protocol", "imap") == "pop3":
        return
    try:
        messages, _total = await imap_client.fetch_messages(account, "INBOX", page=0, limit=30)
    except Exception as e:
        logger.warning("[mailpoll] %s INBOX fetch 실패: %s", account.email, e)
        return

    last_seen = await _load_last_seen(redis, account)

    uids: list[tuple[int, dict]] = []
    for m in messages:
        try:
            uids.append((int(m["id"]), m))
        except (ValueError, TypeError, KeyError):
            continue
    if not uids:
        return
    max_uid = max(u for u, _ in uids)

    # 첫 폴: baseline만 기록(과거 메일을 새 메일로 오인해 폭주하는 것 방지)
    if last_seen == 0:
        await _save_last_seen(redis, account, max_uid)
        logger.info("[mailpoll] %s baseline uid=%s", account.email, max_uid)
        return

    new = sorted((u, m) for u, m in uids if u > last_seen)
    for uid, m in new:
        evt = {
            "account_id": account.id,
            "user_id": account.user_id,
            "email": account.email,
            "uid": str(uid),
            "from": m.get("from_") or [],
            "subject": m.get("subject"),
            "received_at": m.get("received_at"),
            "is_unread": m.get("is_unread", True),
        }
        await redis.publish(EVENT_CHANNEL, json.dumps(evt, ensure_ascii=False))
        logger.info("[mailpoll] NEW %s uid=%s subj=%r", account.email, uid, (m.get("subject") or "")[:60])

        # 아카이브가 켜진 계정이면 원본을 남긴다. 실패해도 조용히 넘어간다 —
        # 백업 때문에 새 메일 감지가 멈추면 안 된다.
        await archive.archive_message(
            account, str(uid), m.get("subject"), m.get("received_at"), "INBOX"
        )

    if max_uid > last_seen:
        await _save_last_seen(redis, account, max_uid)


async def _poll_once() -> None:
    async with async_session() as db:
        accounts = list((await db.execute(select(MailAccount))).scalars().all())
    if not accounts:
        return
    redis = await get_redis()
    for acc in accounts:
        try:
            await _poll_account(redis, acc)
        except Exception:
            logger.exception("[mailpoll] account %s poll error", getattr(acc, "email", "?"))


async def run_poller() -> None:
    """매 주기 Redis 락을 잡은 워커 1개만 폴링한다."""
    await asyncio.sleep(15)  # 기동 안정화 대기
    while True:
        try:
            redis = await get_redis()
            got = await redis.set(_LOCK_KEY, "1", nx=True, ex=max(30, POLL_INTERVAL - 5))
            if got:
                await _poll_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[mailpoll] cycle error")
        await asyncio.sleep(POLL_INTERVAL)
