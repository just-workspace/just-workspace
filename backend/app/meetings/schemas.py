from pydantic import BaseModel, Field, field_validator

# 시스템이 쓰는 방 이름 접두 — 채널·DM 통화(chan-<채널id>)·음성 채널(voice-<채널id>, app/chat/voice.py).
# 사용자가 만드는 회의는 쓸 수 없다. voice- 가 빠져 있던 동안에는 그 이름으로 회의를 만들어 호스트가 되면
# 멤버가 아닌 음성 채널 방의 토큰을 받을 수 있었다.
CHANNEL_CALL_PREFIX = "chan-"
RESERVED_ROOM_PREFIXES = (CHANNEL_CALL_PREFIX, "voice-")


def is_reserved_room_name(name: str | None) -> bool:
    n = (name or "").strip().lower()
    return any(n.startswith(p) for p in RESERVED_ROOM_PREFIXES)


def is_channel_call_room(name: str | None) -> bool:
    """채널·DM 통화 방(chan-<채널id>)인가 — 예약 이름 중 회의 API 가 멤버에게 열어 주는 것은 이것뿐이다."""
    return (name or "").startswith(CHANNEL_CALL_PREFIX)


def validate_room_name(name: str) -> str:
    n = (name or "").strip()
    if not n or len(n) > 100:
        raise ValueError("회의 이름은 1~100자여야 합니다")
    if any(ord(c) < 32 or ord(c) == 127 for c in n) or any(c in n for c in "/\\"):
        raise ValueError("회의 이름에 쓸 수 없는 문자가 있습니다")
    if n in (".", "..") or is_reserved_room_name(n):
        raise ValueError("이 이름은 회의 이름으로 쓸 수 없습니다")
    return n


# ─── 참가자 초대 ───

class InviteeItem(BaseModel):
    type: str  # "internal" | "external"
    user_id: str | None = None
    username: str | None = None
    display_name: str | None = None
    email: str | None = None  # external일 때


# ─── 인증 사용자 (로비) ───

class RoomCreate(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def _name_ok(cls, v: str) -> str:
        return validate_room_name(v)
    max_participants: int = 10
    # 설정하면 게스트가 비밀번호로 호스트 승인 없이 즉시 입장한다
    password: str | None = Field(default=None, min_length=1, max_length=64)
    invitees: list[InviteeItem] = []
    scheduled_at: str | None = None  # ISO 8601 (없으면 즉시)
    duration_minutes: int = 60
    # 대기실 — 끄면 비밀번호 없는 방은 링크만으로 바로 입장(기본 켜짐 = 예전 동작)
    waiting_room: bool = True
    description: str | None = Field(default=None, max_length=5000)
    # 예약 시각이 있으면 호스트 캘린더에도 일정을 만든다
    add_to_calendar: bool = True
    # 채널에 묶기(채널 탭 "회의"). 내가 멤버인 채널만
    channel_id: str | None = None


class RoomInfo(BaseModel):
    name: str
    num_participants: int
    max_participants: int
    creation_time: int
    share_token: str = ""
    is_host: bool = False
    pending_count: int = 0
    has_password: bool = False
    # 목록 "호스트 이름"·예정/진행 중/지난 묶기(시안 MT1). 예약 없이 만든 방은 scheduled_at 이 없다.
    host_name: str = ""
    scheduled_at: str | None = None
    duration_minutes: int | None = None
    # ── DB 회의 저장소(예약 회의) — 예전 Redis 전용 방은 meeting_id 가 없다 ──
    meeting_id: str | None = None
    # live(진행 중, LiveKit 에 방이 있음) | scheduled(예정) | ended(지난) | cancelled
    status: str = "live"
    title: str = ""
    description: str | None = None
    waiting_room: bool = True
    # 초대받은 사람으로서 내 응답(pending/accepted/declined/tentative). 호스트·초대 아님이면 None
    my_response: str | None = None
    invitee_count: int = 0
    accepted_count: int = 0
    started_at: str | None = None
    ended_at: str | None = None


class RoomListResponse(BaseModel):
    rooms: list[RoomInfo]


class TokenRequest(BaseModel):
    room: str


class TokenResponse(BaseModel):
    token: str
    livekit_url: str
    is_host: bool = False   # 발급 경로가 호스트 직접 참여였는지 — 프런트가 녹화/대기실 UI 판정에 씀


class ParticipantInfo(BaseModel):
    identity: str
    name: str
    joined_at: int


# ─── 공유링크 (외부인) ───

class JoinRoomInfo(BaseModel):
    name: str
    host_name: str
    num_participants: int
    max_participants: int
    requires_password: bool = False
    # 초대 입장 화면 "오늘 15:00–16:00"(시안 MT4)
    scheduled_at: str | None = None
    duration_minutes: int | None = None
    # 대기실이 꺼져 있으면 승인 없이 바로 들어간다(입장 화면 문구용)
    waiting_room: bool = True
    # 회의에 묶인 채팅 채널 이름(회의 종료 화면 "공유된 파일과 채팅은 #채널에 남아 있습니다") — 없으면 None
    channel_name: str | None = None


class JoinNotifyHost(BaseModel):
    """만료된 초대 링크 화면의 "호스트에게 알리기" — 손님 이름(선택)."""
    nickname: str | None = None


class JoinRequestCreate(BaseModel):
    nickname: str
    password: str | None = None


class JoinRequestResponse(BaseModel):
    request_id: str
    # 비밀번호가 맞으면 승인 대기 없이 여기서 바로 토큰이 온다
    status: str = "pending"
    token: str | None = None
    livekit_url: str | None = None


class JoinRequestStatus(BaseModel):
    status: str  # pending | approved | denied
    token: str | None = None
    livekit_url: str | None = None


# ─── 호스트 — 참가 신청 관리 ───

class PendingRequest(BaseModel):
    id: str
    nickname: str
    created_at: float


class MeetingSummary(BaseModel):
    """회의 종료 화면 "이번 회의" 카드의 서버 쪽 값(시안 R12Misc meetEnd).

    참가자 수·채팅 수는 서버에 참석 기록이 없어 회의를 본 화면이 센다 — 여기는 회의 자체의 정보만.
    """
    name: str
    title: str
    host_name: str = ""
    is_host: bool = False
    # 회의에 묶인 채팅 채널(채널 통화·채널에서 잡은 회의) — [회의 채팅 보기]. DM 이면 이름은 비운다
    chat_channel_id: str | None = None
    channel_name: str | None = None
    # 호스트 캘린더 일정 id — 호스트에게만 [캘린더 일정]
    calendar_event_id: str | None = None
    scheduled_at: str | None = None
    started_at: str | None = None
    ended_at: str | None = None


# ─── 회의 저장소 — 수정·참석 응답·상세 ───

class RoomUpdate(BaseModel):
    """호스트가 회의를 고친다. 보낸 필드만 바뀐다."""
    title: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=5000)
    scheduled_at: str | None = None
    duration_minutes: int | None = Field(default=None, ge=1, le=24 * 60)
    # 빈 문자열이면 비밀번호 해제
    password: str | None = Field(default=None, max_length=64)
    waiting_room: bool | None = None
    max_participants: int | None = Field(default=None, ge=1, le=500)
    add_invitees: list[InviteeItem] = []
    remove_invitee_ids: list[str] = []


class RsvpRequest(BaseModel):
    response: str  # accepted | declined | tentative


class InviteeInfo(BaseModel):
    id: str
    user_id: str | None = None
    email: str | None = None
    display_name: str = ""
    response: str = "pending"
    responded_at: str | None = None


class MeetingDetail(RoomInfo):
    invitees: list[InviteeInfo] = []
    join_url: str = ""
