"""원격 데스크톱 — 비밀·코드·LiveKit 토큰 같은 순수 로직(라우터와 테스트가 같이 쓴다)."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone

from livekit import api

from app.config import get_settings

settings = get_settings()

CODE_TTL = timedelta(minutes=5)        # 접속 코드 유효 시간
CONSENT_TTL = timedelta(seconds=30)    # 피지원자/소유자 동의 대기
ACTIVE_HEARTBEAT = timedelta(seconds=90)  # active 세션: 호스트 롱폴링이 이 안에 다시 와야 산다
ONLINE_WINDOW = timedelta(seconds=60)  # 기기 온라인 판정(마지막 롱폴링)
TOKEN_TTL = timedelta(minutes=10)      # LiveKit 입장 토큰 — 들어간 뒤엔 서버가 갱신
MAX_CODE_ATTEMPTS = 5                  # 같은 코드를 노린 틀린 입력(한 자리만 다른 코드) 상한 — 넘으면 그 코드 폐기

HOST_PREFIX = "rd-host-"
VIEW_PREFIX = "rd-view-"


def now() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    """SQLite 는 tz 를 잃는다 — 비교 전에 UTC 로 맞춘다."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def secret_matches(value: str, stored_hash: str | None) -> bool:
    if not value or not stored_hash:
        return False
    return hmac.compare_digest(sha256(value), stored_hash)


def new_code() -> str:
    """9자리 숫자(앞자리 0 허용). 표시는 123-456-789."""
    return f"{secrets.randbelow(10**9):09d}"


def normalize_code(raw: str) -> str | None:
    digits = "".join(ch for ch in (raw or "") if ch.isdigit())
    return digits if len(digits) == 9 else None


def code_hash(code: str) -> str:
    """서버 비밀 키로 HMAC — DB 가 새도 9자리 전수 대입으로 원문을 못 되돌린다."""
    return hmac.new(settings.secret_key.encode(), f"remote-code:{code}".encode(), hashlib.sha256).hexdigest()


def neighbor_codes(code: str) -> list[str]:
    """한 자리만 다른 코드 81개 — 틀린 입력이 어느 살아 있는 코드를 노린 것인지(오타·근접 대입) 찾는 데 쓴다.
    코드 원문은 저장하지 않으므로, 입력값 주변을 HMAC 으로 바꿔 대조한다."""
    out = []
    for i in range(len(code)):
        for d in "0123456789":
            if d != code[i]:
                out.append(code[:i] + d + code[i + 1:])
    return out


def format_code(code: str) -> str:
    return f"{code[:3]}-{code[3:6]}-{code[6:]}"


def new_room() -> str:
    return f"rd-{secrets.token_hex(12)}"


def host_identity(session_id: str) -> str:
    return f"{HOST_PREFIX}{session_id}"


def viewer_identity(session_id: str) -> str:
    return f"{VIEW_PREFIX}{session_id}"


def host_grants(room: str) -> api.VideoGrants:
    """호스트: 화면 공유 트랙만 송출 + 데이터(클립보드·상태). 구독은 데이터 수신 때문에 켠다
    (뷰어는 트랙을 송출하지 못하므로 받을 영상·음성은 없다)."""
    return api.VideoGrants(
        room_join=True, room=room, room_create=False, room_admin=False, room_list=False,
        can_publish=True, can_publish_sources=["screen_share"],
        can_subscribe=True, can_publish_data=True, hidden=False,
    )


def viewer_grants(room: str) -> api.VideoGrants:
    """뷰어: 트랙 송출 금지(카메라·마이크·화면 모두), 구독 + 데이터(입력 이벤트)만."""
    return api.VideoGrants(
        room_join=True, room=room, room_create=False, room_admin=False, room_list=False,
        can_publish=False, can_subscribe=True, can_publish_data=True, hidden=False,
    )


def make_token(identity: str, name: str, grants: api.VideoGrants, meta: dict | None = None) -> str:
    t = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(name or identity)
        .with_ttl(TOKEN_TTL)
        .with_grants(grants)
    )
    if meta:
        t = t.with_metadata(json.dumps(meta, ensure_ascii=False))
    return t.to_jwt()


def is_online(last_seen: datetime | None, at: datetime | None = None) -> bool:
    ls = aware(last_seen)
    return bool(ls and (at or now()) - ls <= ONLINE_WINDOW)


def expired(expires_at: datetime | None, at: datetime | None = None) -> bool:
    e = aware(expires_at)
    return e is None or (at or now()) > e
