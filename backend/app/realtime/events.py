"""실시간 이벤트 발행 — 단일 진입점.

브라우저·데스크톱 셸은 실시간 소켓(`/ws/chat`) 하나로 모든 실시간 이벤트를 받는다.
발행은 Redis Pub/Sub 을 거쳐 그 사용자(또는 채널 구독자)의 소켓을 가진 워커가 전달한다
(app/realtime/socket.py `ConnectionManager._subscribe_loop`).

여기 함수만 쓰고 Redis 채널 이름을 직접 쓰지 않는다 — 이름이 흩어지면 다른 모듈(메일·캘린더·
파일·플러그인)이 이벤트를 붙이기 어려워진다.

이벤트 종류(type)
-----------------
사용자 대상(emit_to_user)
  notification      알림 하나가 생겼다 {notification}
  channel_update    채널 멤버십이 바뀌었다 — 받은 워커가 구독 채널을 다시 읽는다
  channel_read      내 다른 기기가 읽었다 {channel_id, seq}
  channel_unread    내 다른 기기가 "안 읽음으로 표시" 했다 {channel_id, seq, unread_count, mention_count, group_mention}
  channel_prefs     채널별 알림 설정이 바뀌었다 {channel_id, notify_level, muted}
  mention_count     채널 멘션 배지 {channel_id, count, group}
  thread_update     팔로우한 스레드에 답글 {root_id, channel_id, reply, unread_replies}
  thread_read       내 다른 기기가 스레드를 읽었다 {root_id, seq}
  thread_follow     팔로우 켬/끔 {root_id, channel_id, followed}
  draft_update      임시글 저장/삭제 {channel_id, parent_id, content(null=삭제), updated_at}
  call_*            채널 통화 상태(app/meetings) {channel_id, ...}
채널 대상(emit_to_channel)
  new_message, reaction_update, message_read, message_update(핀 등 {message}), message_delete …
  voice_state       음성 채널 접속 상태(app/chat/voice.py) {channel_id, participants, since}
전체 대상(socket.py publish_presence)
  presence          {user_id, username, status(online|offline 하위호환), state, emoji, text}
플러그인은 `plugin:<id>:<event>` 형식을 쓴다.
"""

import json
import logging
from typing import Iterable

from fastapi.encoders import jsonable_encoder

from app.chat.redis_client import get_redis

logger = logging.getLogger(__name__)

USER_CHANNEL = "chat:notification:{}"
CHAT_CHANNEL = "chat:channel:{}"
CONN_KEY = "chat:user:{}:conns"   # app/chat/presence.py 가 관리하는 연결 수(모든 워커 합산)


def _dump(event: dict) -> str:
    # 알림 dict 의 created_at 같은 datetime 을 그대로 넘겨도 되게
    return json.dumps(jsonable_encoder(event))


async def emit_to_user(user_id: str, event: dict) -> None:
    r = await get_redis()
    await r.publish(USER_CHANNEL.format(user_id), _dump(event))


async def emit_to_users(user_ids: Iterable[str], event: dict) -> None:
    for uid in {u for u in user_ids if u}:
        await emit_to_user(uid, event)


async def emit_to_channel(channel_id: str, event: dict) -> None:
    r = await get_redis()
    await r.publish(CHAT_CHANNEL.format(channel_id), _dump(event))


async def is_connected(user_id: str) -> bool:
    """이 사용자가 지금 실시간 소켓을 하나라도 열고 있나(탭·데스크톱 셸 포함)."""
    try:
        r = await get_redis()
        return int(await r.get(CONN_KEY.format(user_id)) or 0) > 0
    except Exception:
        return False


async def connected_users(user_ids: Iterable[str]) -> set[str]:
    """여러 사용자의 접속 여부를 MGET 한 번으로 — 큰 채널의 푸시 판단용. 실패하면 빈 집합."""
    ids = [u for u in dict.fromkeys(user_ids) if u]
    if not ids:
        return set()
    try:
        r = await get_redis()
        vals = await r.mget([CONN_KEY.format(u) for u in ids])
        return {u for u, v in zip(ids, vals) if int(v or 0) > 0}
    except Exception:
        return set()
