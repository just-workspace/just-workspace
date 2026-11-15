"""메일 인박스 폴러 — 새 INBOX 메일 감지 → AI 소비자용 이벤트 발행 (Part 3: 폴링 + 이벤트훅).

- 8워커 중 매 주기 1개만 폴링(Redis 락).
- 계정별 마지막 UID를 Redis에 저장. 첫 폴은 baseline만 잡고 이벤트 미발행(과거메일 폭주 방지).
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

from sqlalchemy import select

from app.chat.redis_client import get_redis
from app.db.models import MailAccount
from app.db.session import async_session
from app.mail import archive, imap_client

logger = logging.getLogger(__name__)

POLL_INTERVAL = int(os.getenv("MAIL_POLL_INTERVAL", "120"))  # 초
EVENT_CHANNEL = "mail:new"
_LOCK_KEY = "mail:poll:lock"


def _lastuid_key(account_id: str) -> str:
    return f"mail:lastuid:{account_id}"


async def _poll_account(redis, account: MailAccount) -> None:
    # POP3 계정은 서버측 UID/푸시 개념이 없어 폴러 대상 제외(열 때 on-demand 조회).
    if getattr(account, "protocol", "imap") == "pop3":
        return
    try:
        messages, _total = await imap_client.fetch_messages(account, "INBOX", page=0, limit=30)
    except Exception as e:
        logger.warning("[mailpoll] %s INBOX fetch 실패: %s", account.email, e)
        return

    key = _lastuid_key(account.id)
    raw = await redis.get(key)
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode()
    last_seen = int(raw) if raw else 0

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
        await redis.set(key, str(max_uid))
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
        await redis.set(key, str(max_uid))


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
