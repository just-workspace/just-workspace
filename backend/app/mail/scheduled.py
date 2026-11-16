"""예약 발송 — 대기열 저장과 백그라운드 발송 루프.

- 워커 8개가 동시에 실행되므로 주기마다 Redis 락(jobs.lock.try_acquire)으로 한 워커만 조회한다.
- 락 만료 후에도 동일 행을 중복 발송하지 않도록 행 단위로 pending → sending 조건부 UPDATE 로
  선점한다(rowcount 가 1 인 워커만 발송한다).
- 발송 중 중단된 행(sending 상태로 10분 초과)은 다음 주기에 failed 로 전환한다. 이중 발송보다
  "못 보냄" 표시가 적절하다(사용자가 재예약할 수 있다).
- 첨부는 예약 시점에 storage_root/mail_scheduled/<id>/ 로 이동해 둔다.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import MailScheduledSend, User

logger = logging.getLogger(__name__)

POLL_INTERVAL = 30
_MAX_ATTEMPTS = 3
_STUCK_AFTER = timedelta(minutes=10)


def _dir(scheduled_id: str) -> Path:
    return Path(get_settings().storage_root) / "mail_scheduled" / scheduled_id


def remove_files(scheduled_id: str) -> None:
    try:
        shutil.rmtree(_dir(scheduled_id), ignore_errors=True)
    except Exception:
        pass


async def enqueue(
    db: AsyncSession, user: User, account_id: str | None, payload: dict,
    attachments: list[dict] | None, send_at: datetime,
) -> MailScheduledSend:
    row = MailScheduledSend(
        user_id=user.id,
        account_id=account_id,
        subject=(payload.get("subject") or "")[:500],
        payload="{}",
        send_at=send_at,
        status="pending",
    )
    db.add(row)
    await db.flush()
    metas = []
    if attachments:
        d = _dir(row.id)
        d.mkdir(parents=True, exist_ok=True)
        for i, att in enumerate(attachments):
            (d / str(i)).write_bytes(att["data"])
            metas.append({"file": str(i), "name": att.get("name"), "type": att.get("type")})
    row.payload = json.dumps({**payload, "attachments": metas}, ensure_ascii=False)
    await db.commit()
    await db.refresh(row)
    return row


def _load_attachments(scheduled_id: str, metas: list[dict]) -> list[dict]:
    out = []
    d = _dir(scheduled_id)
    for m in metas:
        p = d / m["file"]
        if not p.is_file():
            raise FileNotFoundError(f"예약 첨부가 없습니다: {m.get('name')}")
        out.append({"data": p.read_bytes(), "name": m.get("name"), "type": m.get("type")})
    return out


async def _claim(db: AsyncSession, row_id: str) -> bool:
    res = await db.execute(
        update(MailScheduledSend)
        .where(MailScheduledSend.id == row_id, MailScheduledSend.status == "pending")
        .values(status="sending", attempts=MailScheduledSend.attempts + 1)
    )
    await db.commit()
    return res.rowcount == 1


async def send_due(db: AsyncSession, now: datetime | None = None, sender=None) -> int:
    """send_at 이 경과한 pending 을 발송한다. 발송 건수 반환.

    sender: 테스트용 주입(기본은 mail.router.perform_send).
    """
    from fastapi import HTTPException
    from app.mail import router as mail_router

    now = now or datetime.now(timezone.utc)
    send = sender or mail_router.perform_send

    # 발송 중 중단된 행 정리
    await db.execute(
        update(MailScheduledSend)
        .where(MailScheduledSend.status == "sending", MailScheduledSend.send_at < now - _STUCK_AFTER)
        .values(status="failed", error="발송 중 서버가 재시작돼 확인되지 않았습니다. 다시 예약해 주세요.")
    )
    await db.commit()

    res = await db.execute(
        select(MailScheduledSend.id)
        .where(MailScheduledSend.status == "pending", MailScheduledSend.send_at <= now)
        .order_by(MailScheduledSend.send_at)
        .limit(50)
    )
    ids = [r[0] for r in res.all()]
    sent = 0
    for rid in ids:
        if not await _claim(db, rid):
            continue
        row = await db.get(MailScheduledSend, rid)
        await db.refresh(row)
        try:
            payload = json.loads(row.payload)
            user = await db.get(User, row.user_id)
            if user is None or not user.is_active:
                raise RuntimeError("사용자를 찾을 수 없거나 비활성입니다")
            account = await mail_router._get_account(db, user, row.account_id)
            atts = _load_attachments(row.id, payload.pop("attachments", []) or [])
            await send(db, user, account, payload, atts)
        except Exception as e:  # noqa: BLE001
            detail = e.detail if isinstance(e, HTTPException) else str(e)
            row.error = str(detail)[:1000]
            # 일시 장애(SMTP 연결 등)는 다음 주기에 재시도, 횟수 초과 시 실패
            row.status = "pending" if (row.attempts or 0) < _MAX_ATTEMPTS and not isinstance(e, (HTTPException, FileNotFoundError)) else "failed"
            await db.commit()
            logger.warning("예약 메일 %s 발송 실패: %s", rid, detail)
            continue
        row.status = "sent"
        row.error = None
        row.sent_at = datetime.now(timezone.utc)
        await db.commit()
        remove_files(row.id)
        sent += 1
    return sent


async def run_scheduled_sender() -> None:
    from app.db.session import async_session
    from app.jobs.lock import try_acquire

    await asyncio.sleep(20)  # 기동 안정화
    while True:
        try:
            if await try_acquire("mail:scheduled", ttl=POLL_INTERVAL - 5):
                async with async_session() as db:
                    n = await send_due(db)
                    if n:
                        logger.info("예약 메일 %d건 발송", n)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.error("예약 메일 루프 오류: %s", e)
        await asyncio.sleep(POLL_INTERVAL)
