"""채팅 서버(워크스페이스) 설정("개요"·"알림 기본값") — system_settings 에 둔다.

  chat.server.name                  채팅 사이드바 머리 이름(없으면 프런트가 사이트 이름)
  chat.server.description           설명
  chat.server.default_notify_level  all|mentions|none — DM 이 아닌 채널에서 멤버행 notify_level 이 NULL 일 때의 기본
                                    (없으면 'mentions' = 지금 동작). DM 은 늘 'all'.

effective_notify_level(동기 함수, 여러 곳에서 부른다)이 읽을 수 있게 프로세스 캐시에 둔다. 값을 쓰는 서비스 함수가
먼저 `await refresh(db)` 를 부른다(CACHE_TTL 안이면 쿼리 없음). 워커 8개 — 바꾼 워커는 즉시, 나머지는 최대 CACHE_TTL 초.
"""

from __future__ import annotations

import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

PREFIX = "chat.server."
KEYS = ("name", "description", "default_notify_level")
LEVELS = ("all", "mentions", "none")
DEFAULT_LEVEL = "mentions"
CACHE_TTL = 30

_state: dict = {"at": 0.0, "values": {"name": None, "description": None, "default_notify_level": DEFAULT_LEVEL}}


def invalidate() -> None:
    _state["at"] = 0.0
    _state["values"] = {"name": None, "description": None, "default_notify_level": DEFAULT_LEVEL}


def default_level() -> str:
    """캐시된 비 DM 채널 기본 알림 수준(동기)."""
    v = _state["values"].get("default_notify_level")
    return v if v in LEVELS else DEFAULT_LEVEL


async def _read(db: AsyncSession) -> dict:
    from app.db.models import SystemSetting
    rows = (await db.execute(
        select(SystemSetting.key, SystemSetting.value).where(SystemSetting.key.in_([PREFIX + k for k in KEYS]))
    )).all()
    vals = {k[len(PREFIX):]: v for k, v in rows}
    lvl = vals.get("default_notify_level")
    return {
        "name": vals.get("name") or None,
        "description": vals.get("description") or None,
        "default_notify_level": lvl if lvl in LEVELS else DEFAULT_LEVEL,
    }


async def refresh(db: AsyncSession) -> dict:
    now = time.monotonic()
    if now - _state["at"] < CACHE_TTL:
        return dict(_state["values"])
    try:
        from app.chat.permissions import guarded
        vals = await guarded(db, lambda: _read(db))
    except Exception:
        return dict(_state["values"])   # 테이블 없음 등 — 마지막 값(처음엔 기본) 그대로
    _state["values"] = vals
    _state["at"] = now
    return dict(vals)


async def update(db: AsyncSession, actor_id: str, changes: dict) -> dict:
    """부분 갱신(None/빈 문자열 = 비우기) + 바뀐 키마다 감사 로그 'chat.server.<키>' {from, to}."""
    from app.admin.audit import log_action
    from app.db.models import SystemSetting
    before = await _read(db)
    for k, v in changes.items():
        if k not in KEYS:
            continue
        row = await db.get(SystemSetting, PREFIX + k)
        if v in (None, ""):
            if row is not None:
                await db.delete(row)
            continue
        if row is None:
            db.add(SystemSetting(key=PREFIX + k, value=str(v)))
        else:
            row.value = str(v)
    await db.commit()
    after = await _read(db)
    for k in KEYS:
        if before[k] != after[k]:
            await log_action(db, actor_id, f"chat.server.{k}", "chat_server", k, {"from": before[k], "to": after[k]})
    _state["values"] = after
    _state["at"] = time.monotonic()
    return after
