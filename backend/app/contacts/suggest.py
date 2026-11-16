"""수신인 자동완성 — 여러 출처를 한 번에 조회하여 병합한다.

회의 초대창과 메일 작성창이 동일한 질의를 수행한다: "이 글자로 시작하는 사람 누구".
후보 출처가 셋이므로 호출부마다 개별 구현하면 화면마다 결과가 달라진다.
따라서 여기서 병합하여 단일 결과로 반환한다.

  1. 최근 발신 수신인 — 실제 사용 빈도가 가장 높은 후보이다. 주소록에 없어도 포함된다.
  2. 내부 사용자 — 워크스페이스 계정.
  3. 주소록 — 직접 입력했거나 vCard/외부계정에서 가져온 연락처.

동일 주소가 여러 출처에 있으면 하나로 병합하고, 출처는 배지로 함께 반환한다.
"""

from __future__ import annotations

import json
import logging
import time

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.redis_client import get_redis
from app.db.models import AddressBookDB, ContactDB, User

logger = logging.getLogger(__name__)

# 최근 수신인은 Redis sorted set 에 저장한다. 점수 = 마지막 사용 시각(epoch).
# 영구 보관할 가치가 있는 데이터가 아니며, 발송 시마다 다시 누적된다.
_RECENT_KEY = "mail:recent-recipients:{user_id}"
_RECENT_MAX = 300          # 사용자당 보관 개수
_RECENT_TTL = 60 * 60 * 24 * 365


async def record_recipients(user_id: str, addresses: list[dict]) -> None:
    """메일 발송 후 수신인을 기록한다. 실패해도 발송에 영향을 주어서는 안 된다."""
    if not addresses:
        return
    try:
        redis = await get_redis()
        key = _RECENT_KEY.format(user_id=user_id)
        now = time.time()
        mapping = {}
        for a in addresses:
            email = (a.get("email") or "").strip().lower()
            if not email:
                continue
            # 이름이 변경될 수 있으므로 주소를 키로 사용하고 이름은 값에 포함한다
            mapping[json.dumps({"email": email, "name": a.get("name") or ""},
                               ensure_ascii=False, sort_keys=True)] = now
        if not mapping:
            return
        await redis.zadd(key, mapping)
        # 오래된 항목부터 제거한다(0 ~ -(MAX+1) 구간 제거)
        await redis.zremrangebyrank(key, 0, -(_RECENT_MAX + 1))
        await redis.expire(key, _RECENT_TTL)
    except Exception as e:
        logger.warning("최근 수신인 기록 실패 (user=%s): %s", user_id, e)


async def _recent(user_id: str, q: str, limit: int) -> list[dict]:
    try:
        redis = await get_redis()
        key = _RECENT_KEY.format(user_id=user_id)
        # 최근 순으로 전부 읽어 메모리에서 필터링한다. 최대 300건이므로 부담이 없다.
        raw = await redis.zrevrange(key, 0, _RECENT_MAX)
    except Exception:
        return []

    out = []
    ql = q.lower()
    for item in raw:
        try:
            d = json.loads(item)
        except (ValueError, TypeError):
            continue
        email = d.get("email") or ""
        name = d.get("name") or ""
        if ql and ql not in email.lower() and ql not in name.lower():
            continue
        out.append({
            "email": email,
            "name": name or email.split("@")[0],
            "source": "recent",
        })
        if len(out) >= limit:
            break
    return out


async def _internal_users(db: AsyncSession, viewer_id: str, q: str, limit: int) -> list[dict]:
    safe_q = q.replace("%", r"\%").replace("_", r"\_")
    pattern = f"%{safe_q}%"
    conds = [User.is_active.is_(True), User.id != viewer_id]
    if q:
        conds.append(or_(
            User.username.ilike(pattern, escape="\\"),
            User.display_name.ilike(pattern, escape="\\"),
            User.email.ilike(pattern, escape="\\"),
        ))
    result = await db.execute(select(User).where(and_(*conds)).limit(limit))
    return [
        {
            "email": u.email or "",
            "name": u.display_name or u.username,
            "username": u.username,
            "user_id": u.id,
            "source": "user",
        }
        for u in result.scalars().all()
        if u.email
    ]


async def _address_book(db: AsyncSession, user_id: str, q: str, limit: int) -> list[dict]:
    ab = await db.execute(select(AddressBookDB.id).where(AddressBookDB.user_id == user_id))
    ab_ids = [r[0] for r in ab.all()]
    if not ab_ids:
        return []

    conds = [ContactDB.address_book_id.in_(ab_ids)]
    if q:
        safe_q = q.replace("%", r"\%").replace("_", r"\_")
        pattern = f"%{safe_q}%"
        conds.append(or_(
            ContactDB.full_name.ilike(pattern, escape="\\"),
            ContactDB.organization.ilike(pattern, escape="\\"),
            ContactDB.emails.ilike(pattern, escape="\\"),
        ))
    result = await db.execute(
        select(ContactDB).where(and_(*conds)).order_by(ContactDB.full_name).limit(limit * 2)
    )

    out = []
    ql = q.lower()
    for c in result.scalars().all():
        try:
            emails = json.loads(c.emails) if c.emails else []
        except (ValueError, TypeError):
            emails = []
        for e in emails:
            addr = (e.get("email") if isinstance(e, dict) else e) or ""
            if not addr:
                continue
            # 연락처가 이름으로 일치했으면 주소 전부, 주소로 일치했으면 일치하는 주소만 포함
            if ql and ql not in addr.lower() and ql not in (c.full_name or "").lower() \
                    and ql not in (c.organization or "").lower():
                continue
            out.append({
                "email": addr,
                "name": c.full_name,
                "organization": c.organization,
                "contact_id": c.id,
                "source": "contact",
            })
            if len(out) >= limit:
                return out
    return out


async def suggest(db: AsyncSession, user_id: str, q: str, limit: int = 10) -> list[dict]:
    """세 출처를 병합하여 중복을 제거한 목록. 최근 → 내부 사용자 → 주소록 순으로 우선한다."""
    q = (q or "").strip()
    per = max(limit, 10)

    recent = await _recent(user_id, q, per)
    users = await _internal_users(db, user_id, q, per)
    contacts = await _address_book(db, user_id, q, per)

    merged: dict[str, dict] = {}
    for group in (recent, users, contacts):
        for item in group:
            key = item["email"].strip().lower()
            if not key:
                continue
            if key in merged:
                # 이미 있으면 정보만 보충한다(먼저 처리된 출처의 순위 유지)
                for k, v in item.items():
                    if k != "source" and v and not merged[key].get(k):
                        merged[key][k] = v
                srcs = merged[key].setdefault("sources", [merged[key]["source"]])
                if item["source"] not in srcs:
                    srcs.append(item["source"])
                continue
            entry = dict(item)
            entry["sources"] = [item["source"]]
            merged[key] = entry

    return list(merged.values())[:limit]
