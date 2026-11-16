"""채팅 알림 키워드 — 설정 › 채팅 "알림 키워드".

멘션·DM 외에도 사용자가 지정한 단어가 메시지에 포함되면 "나를 부른 것"으로 집계한다:
멘션 행(chat_mentions, 개인)과 멘션 알림(인앱·푸시)을 생성한다. 규칙은 멘션과 동일하다
(채널 알림 수준이 'none' 이거나 해당 채널의 기기 푸시를 비활성화한 사용자는 인앱만, DND 는 푸시 단계에서 제외한다).

- 키워드는 개인 설정 chat.keywords(app/me/prefs.py 가 최대 20개·40자로 정규화한다).
- 판정: 대소문자 무시(casefold) 부분 일치. 한국어는 조사가 결합되므로("배포했습니다") 단어 경계를 검사하지 않는다.
- 발신자 본인·이미 멘션으로 알림을 받은 사용자·채널 멤버가 아닌 사용자는 제외.
"""

from __future__ import annotations

import json
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, ChannelMember, User, UserPref
from app.me.prefs import KEYWORDS_KEY

logger = logging.getLogger(__name__)


def keyword_hit(content: str, keywords: list[str] | None) -> str | None:
    """content 에서 최초로 일치하는 키워드(원래 표기). 없으면 None."""
    if not content or not keywords:
        return None
    hay = content.casefold()
    for k in keywords:
        if isinstance(k, str) and k.strip() and k.strip().casefold() in hay:
            return k.strip()
    return None


async def keyword_targets(
    db: AsyncSession, channel_id: str, sender_id: str, content: str, exclude: set[str],
) -> list[tuple[str, str, bool]]:
    """키워드가 일치한 멤버 [(user_id, 일치한 키워드, 푸시 가능)]."""
    from app.chat.service import effective_notify_level
    from app.chat import server22
    await server22.refresh(db)

    if not content:
        return []
    ch = await db.get(Channel, channel_id)
    ch_type = ch.type if ch else "public"
    rows = (
        await db.execute(
            select(ChannelMember.user_id, ChannelMember.notify_level, ChannelMember.pref_push, UserPref.data)
            .join(UserPref, UserPref.user_id == ChannelMember.user_id)
            .join(User, User.id == ChannelMember.user_id)
            .where(
                ChannelMember.channel_id == channel_id,
                ChannelMember.user_id != sender_id,
                User.is_active == True,  # noqa: E712
            )
        )
    ).all()
    out: list[tuple[str, str, bool]] = []
    for uid, level, pref_push, data in rows:
        if uid in exclude or not data:
            continue
        try:
            kws = (json.loads(data) or {}).get(KEYWORDS_KEY)
        except (ValueError, AttributeError):
            continue
        hit = keyword_hit(content, kws if isinstance(kws, list) else None)
        if hit:
            push_ok = effective_notify_level(level, ch_type) != "none" and pref_push is not False
            out.append((uid, hit, push_ok))
    return out


async def create_notifications_for_keywords(
    db: AsyncSession, msg_dict: dict, channel_id: str, sender_id: str, content: str, exclude: set[str],
) -> list[dict]:
    """키워드 알림을 생성한다. 알림 dict 목록(멘션 알림과 동일 형태)."""
    from app.chat.service import record_mentions
    from app.notifications.service import create_notification

    targets = await keyword_targets(db, channel_id, sender_id, content, exclude)
    if not targets:
        return []
    await record_mentions(db, msg_dict, channel_id, [uid for uid, _k, _p in targets])
    ch = await db.get(Channel, channel_id)
    ch_label = f"#{ch.name}" if ch and ch.type != "dm" else "대화"
    sender = await db.get(User, sender_id)
    sender_name = (sender.display_name or sender.username) if sender else "알 수 없음"
    out = []
    for uid, kw, push_ok in targets:
        n = await create_notification(
            db,
            user_id=uid,
            type="mention",
            title=f"{ch_label} · {sender_name}님의 메시지에 '{kw}'",
            body=(msg_dict.get("content") or "")[:200],
            link=f"/chat?channel={channel_id}",
            push=push_ok,
        )
        n["channel_id"] = channel_id
        n["message_id"] = msg_dict.get("id")
        n["seq"] = msg_dict.get("seq")
        n["is_group"] = False
        n["keyword"] = kw
        out.append(n)
    return out
