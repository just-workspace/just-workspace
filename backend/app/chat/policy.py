"""채팅 정책 토글(관리자가 사이트에서 선택) — 권한 엔진(app/chat/permissions.py)이 조회한다.

system_settings(관리 설정과 동일한 key/value 저장소, app/admin/settings.py)에 저장한다:
  chat.policy.admin_channel_privileges  "true"|"false"(기본 false)
      전역 관리자(users.is_admin)에게 채널 내부에서도 특권 부여 — DM·비공개 채널 열람·쓰기·타인의 글 삭제 등 전부.
      비활성화 시(기본) 현재 동작: 관리자도 채널 내부에서는 멤버 규칙을 그대로 적용(워크스페이스 범위 관리만 특권).
  chat.policy.owner_manage_messages     "true"|"false"(기본 false)
      채널 owner 에게 MANAGE_MESSAGES(타인의 글 삭제·미리보기 제거)를 부여한다.

권한 검사는 요청마다 거치는 경로이므로 프로세스 메모리에 CACHE_TTL 초 동안 캐시한다(auth/security_policy 와 동일 방식).
워커 8개 — 변경한 워커는 즉시, 다른 워커는 최대 CACHE_TTL 초 후에 반영된다.
"""

from __future__ import annotations

import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

KEYS = ("admin_channel_privileges", "owner_manage_messages")
PREFIX = "chat.policy."
DEFAULTS: dict[str, bool] = {k: False for k in KEYS}
CACHE_TTL = 30

_cache: dict[str, tuple[float, dict[str, bool]]] = {}


def invalidate() -> None:
    _cache.clear()


def _parse(v: str | None, default: bool) -> bool:
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "on", "yes")


async def _read(db: AsyncSession) -> dict[str, bool]:
    from app.db.models import SystemSetting
    rows = (await db.execute(
        select(SystemSetting.key, SystemSetting.value).where(SystemSetting.key.in_([PREFIX + k for k in KEYS]))
    )).all()
    vals = {k[len(PREFIX):]: v for k, v in rows}
    return {k: _parse(vals.get(k), DEFAULTS[k]) for k in KEYS}


async def get_policy(db: AsyncSession) -> dict[str, bool]:
    """현재 정책. 조회 실패(테이블 없음 등) 시 기본값 반환 — 권한 검사를 중단시키지 않는다."""
    hit = _cache.get("p")
    now = time.monotonic()
    if hit and now - hit[0] < CACHE_TTL:
        return dict(hit[1])
    try:
        from app.chat.permissions import guarded
        pol = await guarded(db, lambda: _read(db))
    except Exception:
        return dict(DEFAULTS)
    _cache["p"] = (now, pol)
    return dict(pol)


async def set_policy(db: AsyncSession, actor_id: str, changes: dict[str, bool]) -> dict[str, bool]:
    """부분 갱신 + 감사 로그(변경된 키마다 action 'chat.policy.<이름>', details {from, to})."""
    from app.admin.audit import log_action
    from app.db.models import SystemSetting
    invalidate()
    before = await _read(db)
    for k, v in changes.items():
        if k not in KEYS or v is None:
            continue
        row = await db.get(SystemSetting, PREFIX + k)
        if row is None:
            db.add(SystemSetting(key=PREFIX + k, value="true" if v else "false"))
        else:
            row.value = "true" if v else "false"
    await db.commit()
    after = await _read(db)
    for k in KEYS:
        if before[k] != after[k]:
            await log_action(db, actor_id, f"chat.policy.{k}", "chat_policy", k,
                             {"from": before[k], "to": after[k]})
    invalidate()
    return after
