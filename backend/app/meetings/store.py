"""회의실 메타데이터/참가신청 저장소 — Redis 기반 (멀티워커 공유 + TTL)."""

import json
import logging
import time
import uuid
from dataclasses import asdict, dataclass, field

from app.chat.redis_client import get_redis

logger = logging.getLogger(__name__)

ROOM_TTL = 86400  # 24h (회의는 휘발성)
_RKEY = "mtg:room:"
_TKEY = "mtg:token:"
_RECKEY = "mtg:rec:"  # 진행 중 녹화(egress) 상태
# 참가 신청 — 방마다 해시(필드 = 신청 id, 값 = JoinRequest JSON).
# 예전엔 방 메타 JSON 안(requests)에 넣어 "읽고-고치고-통째로 다시 쓰기"를 했다. 워커가 여럿이라
# 동시에 온 신청·승인 중 한쪽이 사라졌다(손님은 404, 호스트는 승인한 사람이 다시 대기로). 해시는
# 필드 단위로 쓰므로 서로 덮지 않는다. 배포 순간 진행 중인 회의의 예전 신청(메타 안)은 읽기만 계속한다.
_QKEY = "mtg:req:"
# 초대 링크로 입장 신청한 로그인 사용자 — 방마다 해시(필드 = user_id). 회의 목록은 호스트·초대 대상에게만
# 보이는데, 링크로 들어온 사람(초대 대상이 아님)도 자기가 들어가 있는 회의는 목록에서 보이게 하는 근거다.
# 링크를 이미 가진 사람만 여기 적히므로 새로 알려 주는 것은 없다.
_LKEY = "mtg:linkusers:"


async def remember_link_user(room: str, user_id: str) -> None:
    r = await get_redis()
    await r.hset(_LKEY + room, str(user_id), str(int(time.time())))
    await r.expire(_LKEY + room, ROOM_TTL)


async def is_link_user(room: str, user_id: str) -> bool:
    r = await get_redis()
    return bool(await r.hget(_LKEY + room, str(user_id)))


async def set_active_recording(room: str, egress_id: str, filename: str) -> None:
    r = await get_redis()
    await r.set(_RECKEY + room, json.dumps({"egress_id": egress_id, "filename": filename}), ex=ROOM_TTL)


async def get_active_recording(room: str) -> dict | None:
    r = await get_redis()
    v = await r.get(_RECKEY + room)
    if not v:
        return None
    try:
        return json.loads(v)
    except Exception:
        return None


async def clear_active_recording(room: str) -> None:
    r = await get_redis()
    await r.delete(_RECKEY + room)


@dataclass
class JoinRequest:
    id: str
    nickname: str
    status: str = "pending"  # pending | approved | denied
    created_at: float = field(default_factory=time.time)
    livekit_token: str | None = None


@dataclass
class RoomMeta:
    name: str
    host_user_id: str
    host_username: str
    host_display_name: str
    share_token: str = field(default_factory=lambda: uuid.uuid4().hex)  # full 32hex (brute-force 방지)
    created_at: float = field(default_factory=time.time)
    # 회의 비밀번호(Argon2id 해시). 맞히면 호스트 승인 없이 바로 들어온다.
    password_hash: str | None = None
    requests: dict[str, JoinRequest] = field(default_factory=dict)
    chat_channel_id: str | None = None
    # 예약 시각(ISO 8601, 시간대 포함)·길이(분) — 목록 "예정·진행 중·지난" 묶기와 초대 입장 화면 시각 표시용
    scheduled_at: str | None = None
    duration_minutes: int | None = None
    # 대기실 — 켜져 있으면(기본, 예전 동작) 비밀번호 없이 온 게스트는 호스트 승인을 기다린다.
    # 끄면 링크만 있으면 바로 들어온다(비밀번호가 걸린 방은 비밀번호는 맞혀야 한다).
    waiting_room: bool = True
    # DB 회의 행(app/meetings/repo.py). 예전에 만든 Redis 전용 방은 None.
    meeting_id: str | None = None
    max_participants: int = 10


def _serialize(meta: RoomMeta) -> str:
    return json.dumps({
        "name": meta.name,
        "host_user_id": meta.host_user_id,
        "host_username": meta.host_username,
        "host_display_name": meta.host_display_name,
        "share_token": meta.share_token,
        "created_at": meta.created_at,
        "password_hash": meta.password_hash,
        "chat_channel_id": meta.chat_channel_id,
        "scheduled_at": meta.scheduled_at,
        "duration_minutes": meta.duration_minutes,
        "waiting_room": meta.waiting_room,
        "meeting_id": meta.meeting_id,
        "max_participants": meta.max_participants,
        "requests": {rid: asdict(r) for rid, r in meta.requests.items()},
    })


def _deserialize(s: str) -> RoomMeta:
    d = json.loads(s)
    reqs = {rid: JoinRequest(**rd) for rid, rd in (d.get("requests") or {}).items()}
    return RoomMeta(
        name=d["name"],
        host_user_id=d["host_user_id"],
        host_username=d["host_username"],
        host_display_name=d["host_display_name"],
        share_token=d["share_token"],
        created_at=d["created_at"],
        password_hash=d.get("password_hash"),
        requests=reqs,
        chat_channel_id=d.get("chat_channel_id"),
        scheduled_at=d.get("scheduled_at"),
        duration_minutes=d.get("duration_minutes"),
        waiting_room=d.get("waiting_room", True) is not False,
        meeting_id=d.get("meeting_id"),
        max_participants=d.get("max_participants") or 10,
    )


async def _save(meta: RoomMeta) -> None:
    r = await get_redis()
    await r.setex(_RKEY + meta.name, ROOM_TTL, _serialize(meta))
    await r.setex(_TKEY + meta.share_token, ROOM_TTL, meta.name)


async def create_room_meta(name, host_user_id, host_username, host_display_name,
                           password_hash: str | None = None,
                           scheduled_at: str | None = None,
                           duration_minutes: int | None = None,
                           waiting_room: bool = True,
                           meeting_id: str | None = None,
                           max_participants: int = 10,
                           share_token: str | None = None,
                           chat_channel_id: str | None = None) -> RoomMeta:
    from app.meetings.schemas import is_reserved_room_name
    if is_reserved_room_name(name):
        # 채널·DM 통화 방 이름은 회의 메타(공유 링크·게스트 입장)를 가질 수 없다
        raise ValueError("reserved room name")
    meta = RoomMeta(name=name, host_user_id=host_user_id,
                    host_username=host_username, host_display_name=host_display_name,
                    password_hash=password_hash,
                    scheduled_at=scheduled_at, duration_minutes=duration_minutes,
                    waiting_room=waiting_room, meeting_id=meeting_id,
                    max_participants=max_participants, chat_channel_id=chat_channel_id)
    if share_token:
        meta.share_token = share_token
    await _save(meta)
    # 같은 이름으로 새로 만든 회의다(링크도 새것) — 이전 회의에 링크로 들어왔던 사람 기록은 버린다
    r = await get_redis()
    await r.delete(_LKEY + name)
    return meta


async def save_room_meta(meta: RoomMeta) -> None:
    """회의 수정(PATCH) 뒤 Redis 메타를 같이 고친다."""
    await _save(meta)


async def _restore(name: str | None = None, token: str | None = None) -> RoomMeta | None:
    """Redis 에 없으면 DB 회의 행으로 되살린다(24시간 TTL 이 지난 예약 회의).

    DB 를 못 읽으면 예전처럼 "없음" 으로 둔다 — 회의 입장 경로가 DB 장애로 500 이 되지 않게.
    """
    from app.meetings.schemas import is_reserved_room_name
    if name and is_reserved_room_name(name):
        return None   # 채널 통화·음성 채널 방은 DB 회의가 아니다
    try:
        from app.meetings import repo
        kw = await repo.load_for_restore(name=name, token=token)
    except Exception as e:
        logger.debug("회의 메타 복원 실패(%s/%s): %s", name, token, e)
        return None
    if not kw:
        return None
    meta = RoomMeta(**kw)
    try:
        await _save(meta)
    except Exception:
        pass
    return meta


async def get_room_meta(name: str) -> RoomMeta | None:
    from app.meetings.schemas import is_reserved_room_name
    if is_reserved_room_name(name):
        return None   # 채널 통화 방은 회의 메타가 없다(예전에 선점된 값이 남아 있어도 무시)
    r = await get_redis()
    s = await r.get(_RKEY + name)
    if s:
        return _deserialize(s)
    return await _restore(name=name)


async def get_room_by_token(token: str) -> RoomMeta | None:
    r = await get_redis()
    name = await r.get(_TKEY + token)
    if name:
        s = await r.get(_RKEY + name)
        if s:
            meta = _deserialize(s)
            return None if _reserved(meta) else meta
    meta = await _restore(token=token)
    return None if _reserved(meta) else meta


def _reserved(meta: RoomMeta | None) -> bool:
    """게스트(공유 링크) 입장은 명시적으로 만든 회의 방만 — 채널·DM 통화 방 이름이면 거부."""
    from app.meetings.schemas import is_reserved_room_name
    return meta is not None and is_reserved_room_name(meta.name)


async def delete_room_meta(name: str) -> None:
    r = await get_redis()
    s = await r.get(_RKEY + name)
    meta = _deserialize(s) if s else None
    await r.delete(_RKEY + name)
    await r.delete(_QKEY + name)
    await r.delete(_LKEY + name)
    if meta:
        await r.delete(_TKEY + meta.share_token)


def _load_request(raw) -> JoinRequest | None:
    try:
        return JoinRequest(**json.loads(raw))
    except Exception:
        return None


async def _put_request(room_name: str, req: JoinRequest) -> None:
    r = await get_redis()
    await r.hset(_QKEY + room_name, req.id, json.dumps(asdict(req)))
    await r.expire(_QKEY + room_name, ROOM_TTL)


async def _all_requests(meta: RoomMeta) -> dict[str, JoinRequest]:
    """방의 신청 전부 — 해시가 기준이고, 예전 방식(메타 안)으로 남아 있는 신청을 밑에 깐다."""
    out: dict[str, JoinRequest] = dict(meta.requests)
    r = await get_redis()
    for rid, raw in ((await r.hgetall(_QKEY + meta.name)) or {}).items():
        req = _load_request(raw)
        if req is not None:
            out[rid if isinstance(rid, str) else rid.decode()] = req
    return out


async def create_join_request(room_name: str, nickname: str) -> JoinRequest | None:
    meta = await get_room_meta(room_name)
    if not meta:
        return None
    # 방당 대기 신청 수 제한 (스팸 방지)
    pending = [r for r in (await _all_requests(meta)).values() if r.status == "pending"]
    if len(pending) >= 50:
        return None
    req = JoinRequest(id=uuid.uuid4().hex[:8], nickname=nickname)
    await _put_request(room_name, req)
    return req


async def get_join_request(room_name: str, request_id: str) -> JoinRequest | None:
    meta = await get_room_meta(room_name)
    if not meta:
        return None
    r = await get_redis()
    raw = await r.hget(_QKEY + room_name, request_id)
    if raw:
        return _load_request(raw)
    return meta.requests.get(request_id)   # 배포 전에 받은 신청(메타 안)


async def get_pending_requests(room_name: str) -> list[JoinRequest]:
    meta = await get_room_meta(room_name)
    if not meta:
        return []
    reqs = sorted((await _all_requests(meta)).values(), key=lambda q: q.created_at)
    return [r for r in reqs if r.status == "pending"]


async def set_join_request_status(
    room_name: str, request_id: str, status: str, livekit_token: str | None = None
) -> JoinRequest | None:
    """참가신청 상태 갱신 후 영속화 (approve/deny).

    메타 안에 있던 예전 신청도 여기서 해시로 옮겨 쓴다 — 해시가 메타보다 우선이라 그 뒤로는 해시 값만 읽힌다.
    """
    req = await get_join_request(room_name, request_id)
    if not req:
        return None
    req.status = status
    if livekit_token is not None:
        req.livekit_token = livekit_token
    await _put_request(room_name, req)
    return req
