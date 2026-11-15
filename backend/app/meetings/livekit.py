"""LiveKit API client wrapper."""

import hashlib
import hmac
import secrets
from datetime import timedelta

from livekit import api

from app.config import get_settings

settings = get_settings()

# 입장 토큰 유효시간. 들어간 뒤에는 LiveKit 서버가 연결 중인 클라이언트에 토큰을 갱신해 주므로
# 회의 길이와 상관없다. 이 시간은 "토큰을 받고 나서 입장(또는 끊긴 뒤 재입장)할 수 있는 기간"이다.
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
    """로그인 사용자의 LiveKit identity — 사용자명을 드러내지 않는 불투명 값 + 세션마다 다른 꼬리.

    identity 는 다른 참가자에게 그대로 보인다(SDK participant.identity). 사용자명을 넣으면
    회의에 들어온 외부 손님에게 계정 이름이 새어 나간다. 표시 이름은 name 으로 따로 준다.
    꼬리를 세션마다 바꾸는 이유는 같은 사람이 탭·기기 둘로 들어올 때 DUPLICATE_IDENTITY 로
    서로를 쫓아내지 않게 하려는 것(예전과 같다).
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
                # 이 토큰으로는 방을 만들거나 관리할 수 없다(서버 API 권한). 채널 통화의 방
                # 자동 생성은 입장 시 LiveKit 서버 설정(auto_create)이 하는 것이라 무관하다.
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
    """LiveKit 방을 닫는다. 아무도 안 들어와 이미 없는 방(not_found)은 지운 것으로 본다."""
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
                # 마이크 트랙이 음소거인가(음성 채널 presence 의 폴백 — 클라이언트 보고가 없을 때)
                "mic_muted": _mic_muted(p),
            }
            for p in resp.participants
        ]
    finally:
        await lk.aclose()


def _mic_muted(p) -> bool:
    """참가자의 마이크(source MICROPHONE) 오디오 트랙이 전부 음소거인가. 마이크 트랙이 없으면 True(소리를 안 보낸다)."""
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
