"""LiveKit API client wrapper."""

import hashlib
import hmac
import secrets
from datetime import timedelta

from livekit import api

from app.config import get_settings

settings = get_settings()

# 입장 토큰 유효 시간. 입장 이후에는 LiveKit 서버가 연결 중인 클라이언트의 토큰을 갱신하므로
# 회의 길이와 무관하다. 이 시간은 "토큰 수신 후 입장(또는 연결 종료 후 재입장)이 가능한 기간"이다.
TOKEN_TTL = timedelta(hours=6)


def is_configured() -> bool:
    return bool(settings.livekit_api_key and settings.livekit_api_secret)


def get_ws_url() -> str:
    """브라우저가 접속할 공개 WebSocket URL."""
    if settings.livekit_ws_url:
        return settings.livekit_ws_url
    url = settings.app_url.rstrip("/")
    if url.startswith("https://"):
        return url.replace("https://", "wss://", 1) + "/livekit/"
    return url.replace("http://", "ws://", 1) + "/livekit/"


def session_identity(user_id: str) -> str:
    """로그인 사용자의 LiveKit identity — 사용자명을 노출하지 않는 불투명 값 + 세션별로 상이한 접미부.

    identity 는 다른 참가자에게 그대로 노출된다(SDK participant.identity). 사용자명을 포함하면
    회의에 참가한 외부 게스트에게 계정 이름이 노출된다. 표시 이름은 name 으로 별도 전달한다.
    접미부를 세션별로 변경하는 이유는 동일 사용자가 탭·기기 2개로 입장할 때 DUPLICATE_IDENTITY 로
    상호 퇴장시키는 것을 방지하기 위함이다(기존과 동일).
    """
    digest = hmac.new(settings.secret_key.encode(), f"lk-identity:{user_id}".encode(), hashlib.sha256)
    return f"u-{digest.hexdigest()[:12]}-{secrets.token_hex(3)}"


def generate_token(room: str, identity: str, name: str = "") -> str:
    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(name or identity)
        .with_ttl(TOKEN_TTL)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                # 이 토큰으로는 방을 생성하거나 관리할 수 없다(서버 API 권한). 채널 통화의 방
                # 자동 생성은 입장 시 LiveKit 서버 설정(auto_create)이 수행하므로 무관하다.
                room_create=False,
                room_admin=False,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        .to_jwt()
    )
    return token


def _get_api() -> api.LiveKitAPI:
    return api.LiveKitAPI(
        settings.livekit_url,
        api_key=settings.livekit_api_key,
        api_secret=settings.livekit_api_secret,
    )


async def create_room(
    name: str,
    empty_timeout: int = 300,
    max_participants: int = 10,
) -> dict:
    lk = _get_api()
    try:
        room = await lk.room.create_room(
            api.CreateRoomRequest(
                name=name,
                empty_timeout=empty_timeout,
                max_participants=max_participants,
            )
        )
        return {
            "name": room.name,
            "num_participants": room.num_participants,
            "max_participants": room.max_participants,
            "creation_time": room.creation_time,
        }
    finally:
        await lk.aclose()


async def list_rooms() -> list[dict]:
    lk = _get_api()
    try:
        resp = await lk.room.list_rooms(api.ListRoomsRequest())
        return [
            {
                "name": r.name,
                "num_participants": r.num_participants,
                "max_participants": r.max_participants,
                "creation_time": r.creation_time,
            }
            for r in resp.rooms
        ]
    finally:
        await lk.aclose()


async def delete_room(name: str) -> None:
    """LiveKit 방을 닫는다. 입장자가 없어 이미 존재하지 않는 방(not_found)은 삭제된 것으로 간주한다."""
    lk = _get_api()
    try:
        await lk.room.delete_room(api.DeleteRoomRequest(room=name))
    except Exception as e:  # twirp ServerError(code=not_found)
        if getattr(e, "code", None) == "not_found" or "does not exist" in str(e):
            return
        raise
    finally:
        await lk.aclose()


async def list_participants(room: str) -> list[dict]:
    lk = _get_api()
    try:
        resp = await lk.room.list_participants(
            api.ListParticipantsRequest(room=room)
        )
        return [
            {
                "identity": p.identity,
                "name": p.name,
                "joined_at": p.joined_at,
                # 마이크 트랙의 음소거 여부(음성 채널 presence 의 fallback — 클라이언트 보고가 없는 경우)
                "mic_muted": _mic_muted(p),
            }
            for p in resp.participants
        ]
    finally:
        await lk.aclose()


def _mic_muted(p) -> bool:
    """참가자의 마이크(source MICROPHONE) 오디오 트랙이 전부 음소거인지 여부. 마이크 트랙이 없으면 True(오디오 미송신)."""
    # livekit.protocol.models.TrackSource: UNKNOWN 0 · CAMERA 1 · MICROPHONE 2 · SCREEN_SHARE 3 · SCREEN_SHARE_AUDIO 4
    mic_source = int(getattr(getattr(api, "TrackSource", None), "MICROPHONE", 2))
    try:
        mics = [t for t in getattr(p, "tracks", []) if int(getattr(t, "source", 0)) == mic_source]
    except Exception:
        return False
    if not mics:
        return True
    return all(bool(getattr(t, "muted", False)) for t in mics)


# ─── Egress (회의 녹화) — egress 컨테이너가 /out 볼륨에 mp4 저장 ───

async def start_recording(room: str) -> dict:
    """룸 컴포지트 녹화 시작. egress 컨테이너의 /out(=egress-out 볼륨)에 mp4 저장."""
    import time as _t
    ts = _t.strftime("%Y%m%d-%H%M%S")
    filename = f"{room}_{ts}.mp4"
    lk = _get_api()
    try:
        info = await lk.egress.start_room_composite_egress(
            api.RoomCompositeEgressRequest(
                room_name=room,
                layout="grid",
                file_outputs=[api.EncodedFileOutput(filepath=f"/out/{filename}")],
            )
        )
        return {"egress_id": info.egress_id, "filename": filename}
    finally:
        await lk.aclose()


async def stop_recording(egress_id: str) -> dict:
    lk = _get_api()
    try:
        info = await lk.egress.stop_egress(api.StopEgressRequest(egress_id=egress_id))
        return {"egress_id": egress_id, "status": int(info.status)}
    finally:
        await lk.aclose()
