"""방해 금지 일정 — 요일·시간대 기준으로 웹푸시를 차단한다.

채팅의 방해 금지(app/chat/presence.py: 상태 dnd·dnd_until)는 "지금 켜기" 이고, 본 모듈은 "매일 밤 10시~
아침 8시" 같은 반복 일정이다. 둘 중 하나라도 해당하면 푸시를 전송하지 않는다(인앱 알림은 그대로 전달된다).

저장: user_prefs 의 서버 관리 키 `notify.dnd_schedule`
    {"enabled": true, "days": [0,1,2,3,4], "start": "22:00", "end": "08:00", "timezone": "Asia/Seoul"}
- days: 0=월 … 6=일. **시작 요일** 기준이다 — 금 22:00~08:00 이면 토요일 새벽까지 차단된다.
- end <= start 이면 자정을 넘긴다. start == end 이면 해당 요일 종일.
- timezone 이 없으면 개인 설정 timezone, 그것도 없으면 Asia/Seoul.

검사 지점: app/push/router.py send_push (모든 웹푸시의 경유 지점). 채팅 push_allowed 와 알림 서비스
_push 가 모두 send_push 를 호출하므로 채팅 모듈을 수정하지 않고도 양쪽에 적용된다.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

logger = logging.getLogger(__name__)

PREF_KEY = "notify.dnd_schedule"
DEFAULT_TZ = "Asia/Seoul"
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _tz(name: str | None):
    for n in (name, DEFAULT_TZ):
        if not n:
            continue
        try:
            return ZoneInfo(n)
        except (ZoneInfoNotFoundError, ValueError):
            continue
    return timezone(timedelta(hours=9))   # 시간대 DB(tzdata)가 없는 이미지 — 한국 시간 적용


def _t(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def validate(body: dict) -> dict:
    """요청 → 저장용 정규화 일정. 유효하지 않으면 400."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="객체를 보내야 합니다")
    enabled = bool(body.get("enabled", True))
    days = body.get("days", [0, 1, 2, 3, 4, 5, 6])
    if not isinstance(days, list) or any((not isinstance(d, int)) or d < 0 or d > 6 for d in days):
        raise HTTPException(status_code=400, detail="days 는 0(월)~6(일) 정수 목록입니다")
    start, end = body.get("start", "22:00"), body.get("end", "08:00")
    for v in (start, end):
        if not isinstance(v, str) or not _HHMM.match(v):
            raise HTTPException(status_code=400, detail="start·end 는 HH:MM(24시간) 형식입니다")
    tzname = body.get("timezone")
    if tzname is not None:
        try:
            ZoneInfo(tzname)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(status_code=400, detail="알 수 없는 시간대입니다")
    return {"enabled": enabled, "days": sorted(set(days)), "start": start, "end": end, "timezone": tzname}


def in_quiet_hours(schedule: dict | None, now: datetime | None = None, fallback_tz: str | None = None) -> bool:
    """현재 시각이 방해 금지 시간에 해당하는지 여부."""
    if not schedule or not schedule.get("enabled"):
        return False
    try:
        days = set(schedule.get("days") or [])
        start, end = _t(schedule["start"]), _t(schedule["end"])
    except Exception:
        return False
    if not days:
        return False
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(_tz(schedule.get("timezone") or fallback_tz))
    t, wd = local.time(), local.weekday()
    yesterday = (local - timedelta(days=1)).weekday()
    if start == end:                       # 종일
        return wd in days
    if start < end:                        # 동일 날짜 내
        return wd in days and start <= t < end
    # 자정 경과 — 당일 시작분(start 이후) 또는 전일 시작분(end 이전)
    return (wd in days and t >= start) or (yesterday in days and t < end)


async def schedule_blocks(user_id: str, now: datetime | None = None) -> bool:
    """해당 사용자에 대한 푸시를 현재 차단해야 하는지 여부(일정 기준). DB 조회 실패 시 차단하지 않는다."""
    try:
        from app.db.session import async_session
        from app.me.prefs import get_prefs

        async with async_session() as db:
            prefs = await get_prefs(db, user_id)
        return in_quiet_hours(prefs.get(PREF_KEY), now, prefs.get("timezone"))
    except Exception as e:
        logger.debug("방해 금지 일정 확인 실패(%s): %s", user_id, e)
        return False


async def push_allowed(user_id: str) -> bool:
    """채팅 방해 금지(지금 켜기)와 일정을 함께 확인하는 푸시 게이트."""
    from app.chat.presence import push_allowed as chat_push_allowed

    if not await chat_push_allowed(user_id):
        return False
    return not await schedule_blocks(user_id)
