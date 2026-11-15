"""반복 일정 규칙(RRULE) 상한.

반복 규칙 하나로 서버가 회차를 끝없이 펼치지 않게 두 겹으로 막는다.

1. 저장할 때(check_rrule): 초·분 단위 빈도(SECONDLY·MINUTELY)를 거부하고, 하루 회차 수가
   24 를 넘는 조합(BYHOUR×BYMINUTE×BYSECOND)도 거부한다. 길이·COUNT·INTERVAL 상한.
2. 펼칠 때(iter_bounded): 이미 저장된 규칙이나 외부에서 들어온 규칙도 한 번에 훑는 횟수와
   내는 회차 수에 상한을 둔다.
"""
from __future__ import annotations

from datetime import datetime
from typing import Iterator

ALLOWED_FREQ = frozenset({"HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"})
MAX_RULE_LEN = 500
MAX_COUNT = 5000
MAX_INTERVAL = 1000
MAX_PER_DAY = 24

# 펼침 상한
MAX_OCCURRENCES = 1000     # 한 일정이 한 번의 조회에서 내는 회차
MAX_SCAN = 20000           # 규칙을 훑는 최대 횟수(조회 범위 앞쪽 회차 포함)


class RRuleRejected(ValueError):
    pass


def _parts(rule: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in rule.split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise RRuleRejected("반복 규칙 형식이 올바르지 않습니다")
        k, v = part.split("=", 1)
        k = k.strip().upper()
        if k in out:
            raise RRuleRejected("반복 규칙 형식이 올바르지 않습니다")
        out[k] = v.strip()
    return out


def _n(v: str | None) -> int:
    if not v:
        return 1
    return len([x for x in v.split(",") if x.strip()]) or 1


def check_rrule(rule: str | None) -> str | None:
    """저장해도 되는 규칙인지. 'RRULE:' 접두는 떼고 돌려준다. 안 되면 RRuleRejected."""
    if rule is None:
        return None
    r = rule.strip()
    if r.upper().startswith("RRULE:"):
        r = r[6:].strip()
    if not r:
        return None
    if len(r) > MAX_RULE_LEN or "\n" in r or "\r" in r:
        raise RRuleRejected("반복 규칙이 너무 깁니다")
    p = _parts(r)
    freq = (p.get("FREQ") or "").upper()
    if freq not in ALLOWED_FREQ:
        raise RRuleRejected("반복 주기는 매시간·매일·매주·매월·매년만 쓸 수 있습니다")
    try:
        interval = int(p.get("INTERVAL") or "1")
        count = int(p["COUNT"]) if "COUNT" in p else None
    except ValueError:
        raise RRuleRejected("반복 규칙 형식이 올바르지 않습니다")
    if interval < 1 or interval > MAX_INTERVAL:
        raise RRuleRejected("반복 간격이 범위를 벗어났습니다")
    if count is not None and (count < 1 or count > MAX_COUNT):
        raise RRuleRejected(f"반복 횟수는 1~{MAX_COUNT}회입니다")
    if "BYSETPOS" in p and _n(p["BYSETPOS"]) > 31:
        raise RRuleRejected("반복 규칙이 너무 많은 회차를 만듭니다")
    per_slot = _n(p.get("BYMINUTE")) * _n(p.get("BYSECOND"))
    if freq == "HOURLY":
        if per_slot > 1:
            raise RRuleRejected("매시간 반복은 한 시간에 한 번만 됩니다")
    else:
        if _n(p.get("BYHOUR")) * per_slot > MAX_PER_DAY:
            raise RRuleRejected("하루 반복 횟수가 너무 많습니다")
    # 실제로 해석되는지(dateutil)
    from datetime import timezone

    from dateutil.rrule import rrulestr

    from app.dav.ical_utils import normalize_rrule_for_aware
    try:
        rrulestr(normalize_rrule_for_aware(r), dtstart=datetime(2000, 1, 1, tzinfo=timezone.utc), ignoretz=False)
    except (ValueError, TypeError, KeyError):
        raise RRuleRejected("반복 규칙 형식이 올바르지 않습니다")
    return r


def sanitize_rrule(rule: str | None) -> str | None:
    """외부에서 들어온 규칙(DAV·가져오기·구독) — 허용 밖이면 반복 없음으로."""
    try:
        return check_rrule(rule)
    except RRuleRejected:
        return None


def iter_bounded(rule, start: datetime, end: datetime,
                 max_occ: int = MAX_OCCURRENCES, max_scan: int = MAX_SCAN) -> Iterator[datetime]:
    """[start, end] 회차 — 훑는 횟수·내는 회차 수에 상한."""
    produced = 0
    for i, occ in enumerate(rule):
        if i >= max_scan or occ > end:
            return
        if occ < start:
            continue
        yield occ
        produced += 1
        if produced >= max_occ:
            return


def next_after(rule, after: datetime, max_scan: int = MAX_SCAN) -> datetime | None:
    """after 다음 회차(상한 안에서 못 찾으면 None)."""
    for i, occ in enumerate(rule):
        if i >= max_scan:
            return None
        if occ > after:
            return occ
    return None
