"""실시간 이벤트 발행 — 단일 진입점.

브라우저·데스크톱 셸은 실시간 소켓(`/ws/chat`) 하나로 모든 실시간 이벤트를 수신한다.
발행은 Redis Pub/Sub 을 거쳐 해당 사용자(또는 채널 구독자)의 소켓을 보유한 워커가 전달한다
(app/realtime/socket.py `ConnectionManager._subscribe_loop`).

본 모듈의 함수만 사용하고 Redis 채널 이름을 직접 사용하지 않는다 — 이름이 분산되면 타 모듈(메일·캘린더·
파일·플러그인)의 이벤트 연동이 어려워진다.

이벤트 종류(type)
-----------------
사용자 대상(emit_to_user)
  notification      알림 1건 생성 {notification}
  channel_update    채널 멤버십 변경 — 수신한 워커가 구독 채널을 재조회한다
  channel_read      본인의 다른 기기에서 읽음 처리 {channel_id, seq}
  channel_unread    본인의 다른 기기에서 "읽지 않음으로 표시" 수행 {channel_id, seq, unread_count, mention_count, group_mention}
  channel_prefs     채널별 알림 설정 변경 {channel_id, notify_level, muted}
  mention_count     채널 멘션 배지 {channel_id, count, group}
  thread_update     팔로우한 스레드에 답글 등록 {root_id, channel_id, reply, unread_replies}
  thread_read       본인의 다른 기기에서 스레드 읽음 처리 {root_id, seq}
  thread_follow     팔로우 활성화/비활성화 {root_id, channel_id, followed}
  draft_update      임시글 저장/삭제 {channel_id, parent_id, content(null=삭제), updated_at}
  call_*            채널 통화 상태(app/meetings) {channel_id, ...}
채널 대상(emit_to_channel)
  new_message, reaction_update, message_read, message_update(핀 등 {message}), message_delete …
  voice_state       음성 채널 접속 상태(app/chat/voice.py) {channel_id, participants, since}
전체 대상(socket.py publish_presence)
  presence          {user_id, username, status(online|offline 하위호환), state, emoji, text}
전체 대상(emit_to_all)
  system.update_countdown   업데이트 사전 공지 {job, kind, ends_at, expected_seconds}
  system.update_cancelled   사전 공지 취소 {job}
  system.maintenance        점검 모드 시작·종료 {active, kind, started_at, expected_seconds, result}
플러그인은 `plugin:<id>:<event>` 형식을 사용한다.
"""

import json
import logging
from typing import Iterable

from fastapi.encoders import jsonable_encoder

from app.chat.redis_client import get_redis

logger = logging.getLogger(__name__)

USER_CHANNEL = "chat:notification:{}"
CHAT_CHANNEL = "chat:channel:{}"
ALL_CHANNEL = "chat:presence"     # 접속 중인 모든 소켓에 그대로 전달되는 채널(socket.py — 접속 상태 발행에 사용하는 동일 채널)
CONN_KEY = "chat:user:{}:conns"   # app/chat/presence.py 가 관리하는 연결 수(전체 워커 합산)


def _dump(event: dict) -> str:
    # 알림 dict 의 created_at 등 datetime 값을 변환 없이 전달할 수 있도록 직렬화
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


async def emit_to_all(event: dict) -> None:
    """접속 중인 모든 사용자에게 발행한다 — 업데이트 사전 공지·점검 모드처럼 워크스페이스 전체 공지 대상에 한정한다."""
    r = await get_redis()
    await r.publish(ALL_CHANNEL, _dump(event))


async def is_connected(user_id: str) -> bool:
    """해당 사용자가 현재 실시간 소켓을 1개 이상 연결 중인지 여부(탭·데스크톱 셸 포함)."""
    try:
        r = await get_redis()
        return int(await r.get(CONN_KEY.format(user_id)) or 0) > 0
    except Exception:
        return False


async def connected_users(user_ids: Iterable[str]) -> set[str]:
    """여러 사용자의 접속 여부를 MGET 1회로 조회한다 — 대규모 채널의 푸시 판단용. 실패 시 빈 집합을 반환한다."""
    ids = [u for u in dict.fromkeys(user_ids) if u]
    if not ids:
        return set()
    try:
        r = await get_redis()
        vals = await r.mget([CONN_KEY.format(u) for u in ids])
        return {u for u, v in zip(ids, vals) if int(v or 0) > 0}
    except Exception:
        return set()
