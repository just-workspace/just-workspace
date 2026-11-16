"""메시지 생성 이후 처리 — 실시간 전달·멘션 알림·푸시·스레드 팔로워 알림·임시글 정리.
REST 와 WS 두 경로가 공용으로 사용한다.

과거에는 동일 처리(parse_mentions → 알림 → 발행)가 라우터와 WebSocket 에 각각 존재했고,
웹푸시(app/push/router.py `send_push`)는 정의만 있고 어디에서도 호출되지 않았다.

푸시 규칙(채널별 알림 설정 ChannelMember.notify_level · muted, 사용자 상태 DND)
  - 멘션: 'none' 이 아니면 푸시(접속 중이면 미발송). 인앱 알림·배지는 수준과 무관.
  - 'all'(DM 기본): 일반 메시지도 오프라인 멤버에게 푸시. muted 이면 미발송.
  - DND 상태인 사용자는 어떤 푸시도 수신하지 않는다(_push 내부 push_allowed).
  - 스레드 답글은 "채널에도 보내기" 한 것만 채널 메시지로 간주한다.
  - 알림 키워드(app/chat/keywords.py)가 일치한 멤버는 멘션과 동일하게 집계한다(멘션 행 + 멘션 알림).
  - 인라인 답장(chat22) reply_ping 이면 원문 작성자를 멘션과 동일하게 집계한다(멘션 행 + 알림, 본인 제외).
  - @silent(chat22): 멘션 행·배지·실시간 전달은 유지하고, 알림(인앱 알림함·푸시)은 생성하지 않는다.
"""

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import service
from app.realtime.events import connected_users, emit_to_channel, emit_to_user

logger = logging.getLogger(__name__)


async def after_message_created(
    db: AsyncSession, msg: dict, channel_id: str, sender_id: str, content: str,
) -> None:
    mentioned_ids: set[str] = set()
    silent = bool(msg.get("silent"))
    usernames = service.parse_mentions(content or "")   # 그룹 멘션 단어 포함
    if usernames:
        try:
            # 알림을 생성하면 app/notifications/service.py 가 실시간 전달과(오프라인이면) 푸시까지 수행한다
            notifs = await service.create_notifications_for_mentions(
                db, msg, channel_id, sender_id, usernames, silent=silent,
            )
            mentioned_ids = {n["user_id"] for n in notifs}
        except Exception as e:
            logger.warning("멘션 알림 실패(%s): %s", channel_id, e)

    # 인라인 답장 — 원문 작성자에게 알림(답장 대상 멘션 활성화). 이미 이름으로 멘션된 경우 1회만 알림.
    try:
        rid = await notify_reply_ping(db, msg, channel_id, sender_id, mentioned_ids, silent)
        if rid:
            mentioned_ids.add(rid)
    except Exception as e:
        logger.warning("답장 알림 실패(%s): %s", channel_id, e)

    # 알림 키워드(설정 › 채팅) — 멘션과 동일하게 "나를 부른 것"으로 집계한다. 이미 멘션된 사용자는 건너뛴다.
    # @silent 이면 키워드 알림도 생성하지 않는다(배지만 — 키워드는 알림 기능이므로 행도 기록하지 않는다).
    if not silent:
        try:
            from app.chat.keywords import create_notifications_for_keywords
            kw_notifs = await create_notifications_for_keywords(
                db, msg, channel_id, sender_id, content or "", mentioned_ids,
            )
            mentioned_ids |= {n["user_id"] for n in kw_notifs}
        except Exception as e:
            logger.warning("키워드 알림 실패(%s): %s", channel_id, e)

    await emit_to_channel(channel_id, {"type": "new_message", "message": msg})

    # 링크 미리보기 — 첫 외부 링크의 카드를 백그라운드로 생성하고 완료 시 link_preview 이벤트 발행
    from app.chat.link_preview import schedule_for_message
    schedule_for_message(msg)

    # 채널 멘션 배지 — 알림함 이벤트와 별개로, 해당 채널의 미읽음 멘션 수를 즉시 갱신
    for uid in mentioned_ids:
        try:
            count, group = await service.get_mention_state(db, uid, channel_id)
            await emit_to_user(uid, {
                "type": "mention_count", "channel_id": channel_id, "count": count, "group": group,
            })
        except Exception as e:
            logger.debug("mention_count 전달 실패(%s): %s", uid, e)

    parent_id = msg.get("parent_id")

    # 스레드 답글 → 팔로워(발신자 제외)에게 thread_update 전달. 미읽음 수는 팔로워마다 상이하다.
    # 오프라인 팔로워에게는 푸시 발송(채널 알림 설정·DND 준수).
    thread_pushed: set[str] = set()
    if parent_id:
        try:
            followers = await notify_thread_followers(db, msg, parent_id, channel_id, sender_id)
            if not silent:
                thread_pushed = await push_thread_reply(
                    db, msg, parent_id, channel_id, sender_id, content, followers, mentioned_ids,
                )
        except Exception as e:
            logger.debug("thread_update 전달 실패(%s): %s", parent_id, e)

    # 전송 완료이므로 해당 위치의 임시글 삭제 — 다른 기기의 입력창도 초기화
    try:
        if sender_id and await service.delete_draft(db, sender_id, channel_id, parent_id):
            await emit_to_user(sender_id, {
                "type": "draft_update", "channel_id": channel_id, "parent_id": parent_id,
                "content": None, "updated_at": None,
            })
    except Exception as e:
        logger.debug("임시글 정리 실패(%s): %s", channel_id, e)

    # 채널 알림 수준이 'all' 인 오프라인 멤버에게 푸시(DM 기본). 멘션된 사용자에게는 이미 알림이 발송되었다.
    # 메인 타임라인에 표시되는 메시지만 대상 — 일반 답글은 팔로워가 thread_update 로 수신한다.
    if parent_id and not msg.get("thread_broadcast"):
        return
    if silent:
        return
    try:
        await push_channel_message(db, msg, channel_id, sender_id, content, mentioned_ids | thread_pushed)
    except Exception as e:
        logger.debug("채널 푸시 판단 실패(%s): %s", channel_id, e)


async def notify_reply_ping(
    db: AsyncSession, msg: dict, channel_id: str, sender_id: str | None,
    already: set[str], silent: bool,
) -> str | None:
    """reply_ping 인 답장 → 원문 작성자에게 멘션 행 + 알림. 대상 user_id(배지 갱신용) 또는 None.

    본인 글에 답장·원문 작성자가 채널에서 나감·원문이 삭제됨/없음 → 없음. silent 이면 멘션 행만 생성(알림 없음).
    """
    rt = msg.get("reply_to") or {}
    if not msg.get("reply_ping") or rt.get("state") != "ok" or not rt.get("sender"):
        return None
    target = rt["sender"]["id"]
    if not target or target == sender_id:
        return None
    if target in already:
        return target
    if not await service.is_channel_member(db, channel_id, target):
        return None
    await service.record_mentions(db, msg, channel_id, [target])
    if silent:
        return target
    from app.db.models import User
    from app.notifications.service import create_notification
    ch = await service.get_channel(db, channel_id)
    members = await service.get_members_for_notify(db, channel_id)
    me = next((m for m in members if m["user_id"] == target), None)
    push_ok = bool(me) and me["notify_level"] != "none" and me.get("push", True)
    sender = await db.get(User, sender_id) if sender_id else None
    sender_name = (sender.display_name or sender.username) if sender else "알 수 없음"
    link = f"/chat?channel={channel_id}"
    if msg.get("parent_id"):
        link += f"&thread={msg['parent_id']}"
    n = await create_notification(
        db,
        user_id=target,
        type="mention",
        title=f"{sender_name}님이 회원님 글에 답장했습니다" + (f" · #{ch.name}" if ch and ch.type != "dm" else ""),
        body=(msg.get("content") or "")[:200],
        link=link,
        push=push_ok,
    )
    n["channel_id"] = channel_id
    n["message_id"] = msg.get("id")
    return target


async def notify_thread_followers(
    db: AsyncSession, reply: dict, root_id: str, channel_id: str, sender_id: str | None,
) -> list[str]:
    """팔로워에게 thread_update 전달. 수신한 팔로워 id 목록을 반환한다(푸시 판단용)."""
    unread_map = await service.get_thread_followers_unread(db, root_id, exclude_user_id=sender_id)
    for uid, unread in unread_map.items():
        await emit_to_user(uid, {
            "type": "thread_update",
            "root_id": root_id,
            "channel_id": channel_id,
            "reply": reply,
            "unread_replies": unread,
        })
    return list(unread_map)


def thread_push_targets(members: list[dict], followers: list[str], sender_id: str | None,
                        already_notified: set[str]) -> list[str]:
    """스레드 답글 푸시 대상 — 팔로워 중
    - 발신자·이미 멘션 알림을 받은 사용자 제외
    - 채널 알림 수준이 'none' 이거나 음소거이면 제외
    - 해당 채널의 기기 푸시(push)·스레드 답글(thread_replies) 을 비활성화한 사용자 제외
    (DND·접속 여부는 호출부/_push 에서 판정)
    """
    by_id = {m["user_id"]: m for m in members}
    out = []
    for uid in followers:
        m = by_id.get(uid)
        if not m or uid == sender_id or uid in already_notified:
            continue
        if m["notify_level"] == "none" or m["muted"]:
            continue
        if not m.get("push", True) or not m.get("thread_replies", True):
            continue
        out.append(uid)
    return out


async def push_thread_reply(
    db: AsyncSession, msg: dict, root_id: str, channel_id: str, sender_id: str | None,
    content: str, followers: list[str], already_notified: set[str],
) -> set[str]:
    """오프라인 스레드 팔로워에게 웹푸시. 푸시를 발송한(발송을 시도한) 사용자 집합을 반환한다."""
    if not followers:
        return set()
    ch = await service.get_channel(db, channel_id)
    if ch is None:
        return set()
    members = await service.get_members_for_notify(db, channel_id)
    targets = thread_push_targets(members, followers, sender_id, already_notified)
    if not targets:
        return set()
    online = await connected_users(targets)
    sender = next((m for m in members if m["user_id"] == sender_id), None)
    sender_name = (sender or {}).get("display_name") or (sender or {}).get("username") or "새 답글"
    title = f"{sender_name} · 스레드 답글" if ch.type == "dm" else f"#{ch.name} · {sender_name}님의 스레드 답글"
    sent: set[str] = set()
    for uid in targets:
        if uid in online:
            continue
        sent.add(uid)
        asyncio.create_task(_push(uid, title, (content or "")[:120],
                                  f"/chat?channel={channel_id}&thread={root_id}"))
    return sent


async def push_channel_message(
    db: AsyncSession, msg: dict, channel_id: str, sender_id: str, content: str,
    already_notified: set[str],
) -> None:
    """notify_level == 'all' 이고 muted 가 아닌 오프라인 멤버에게 웹푸시. 멤버·접속 조회는 각 1회."""
    ch = await service.get_channel(db, channel_id)
    if ch is None:
        return
    members = await service.get_members_for_notify(db, channel_id)
    sender = next((m for m in members if m["user_id"] == sender_id), None)
    sender_name = (sender or {}).get("display_name") or (sender or {}).get("username") or "새 메시지"
    title = sender_name if ch.type == "dm" else f"#{ch.name} · {sender_name}"

    candidates = [
        m["user_id"] for m in members
        if m["user_id"] != sender_id
        and m["user_id"] not in already_notified
        and m["notify_level"] == "all"
        and not m["muted"]
        and m.get("push", True)
    ]
    if not candidates:
        return
    online = await connected_users(candidates)
    for uid in candidates:
        if uid in online:
            continue
        asyncio.create_task(_push(uid, title, (content or "")[:120], f"/chat?channel={channel_id}"))


async def _push(user_id: str, title: str, body: str, url: str) -> None:
    try:
        from app.chat.presence import push_allowed
        if not await push_allowed(user_id):
            return   # 방해 금지
        from app.push.router import send_push
        await send_push(user_id, title, body, url)
    except Exception as e:
        logger.debug("push 실패(%s): %s", user_id, e)
