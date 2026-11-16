"""Chat Pydantic schemas."""

from datetime import datetime

from pydantic import BaseModel, Field


# ─── Channel ───

class ChannelCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    type: str = Field("public", pattern=r"^(public|private)$")
    description: str | None = Field(None, max_length=500)
    member_ids: list[str] = Field(default_factory=list)
    # 음성 채널로 생성. 종류(public/private)는 유지 — 멤버십 규칙 동일.
    voice: bool = False
    # 포럼 채널(chat22) — 게시판 데이터의 채팅 보기. board_id 가 있으면 해당 게시판 연결, 없으면 동일 이름의 게시판 생성
    forum: bool = False
    board_id: str | None = None


class ChannelUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = None
    is_archived: bool | None = None
    # 새 스레드 자동 보관 기본값(분) — 60·1440·4320·10080 (chat22)
    default_thread_auto_archive_minutes: int | None = Field(None)


class ChannelResponse(BaseModel):
    id: str
    name: str
    type: str
    description: str | None
    created_by: str
    is_archived: bool
    created_at: datetime
    updated_at: datetime
    member_count: int = 0
    unread_count: int = 0
    is_voice: bool = False


# ─── Message ───

class MessageCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=10000)
    message_type: str = Field("text", pattern=r"^(text|file|system)$")
    file_meta: str | None = None
    parent_id: str | None = None
    # 답글을 채널 타임라인에도 표시("채널에도 보내기"). parent_id 가 없으면 무시.
    also_to_channel: bool = False
    # 인라인 답장(chat22) — 동일 채널(스레드 내부이면 동일 스레드)의 메시지. reply_ping = 원문 작성자에게 알림
    reply_to_id: str | None = None
    reply_ping: bool = True
    # @silent — 푸시·멘션 알림 없음. 본문이 "@silent " 로 시작하는 경우에도 서버가 해당 접두를 제거하고 활성화한다
    silent: bool = False


class MarkUnreadRequest(BaseModel):
    message_id: str


class ChannelPrefsUpdate(BaseModel):
    notify_level: str | None = Field(None, pattern=r"^(all|mentions|none)$")
    muted: bool | None = None
    # ── 기기 알림 세부 ──
    desktop: bool | None = None
    push: bool | None = None
    email: bool | None = None
    thread_replies: bool | None = None
    # 음소거 기간(chat22) — 15·60·180·480·1440, null 명시 = 사용자가 직접 해제할 때까지(필드 미전송 시 변경 없음)
    muted_minutes: int | None = None


MUTE_MINUTES = (15, 60, 180, 480, 1440)


class ThreadReadRequest(BaseModel):
    # 미지정 시 마지막 답글까지
    seq: int | None = Field(None, ge=0)


class UserStatusUpdate(BaseModel):
    """PUT /me/status — 전송된 필드만 변경된다. null 을 명시하면 해당 값을 비운다."""
    mode: str | None = Field(None, pattern=r"^(auto|away|dnd|invisible)$")
    custom_emoji: str | None = Field(None, max_length=16)
    custom_text: str | None = Field(None, max_length=100)
    custom_expires_at: datetime | None = None
    dnd_until: datetime | None = None


class DraftUpsert(BaseModel):
    channel_id: str
    parent_id: str | None = None
    # 빈 문자열이면 삭제
    content: str = Field("", max_length=10000)


class MessageUpdate(BaseModel):
    content: str = Field(..., min_length=1, max_length=10000)


class MessageSender(BaseModel):
    id: str
    username: str
    display_name: str | None
    avatar_url: str | None


class MessageResponse(BaseModel):
    id: str
    channel_id: str
    sender: MessageSender | None
    content: str
    message_type: str
    file_meta: str | None
    parent_id: str | None = None
    reply_count: int = 0
    is_edited: bool
    is_deleted: bool
    created_at: datetime
    updated_at: datetime


class MessageListResponse(BaseModel):
    messages: list[MessageResponse]
    has_more: bool


# ─── Member ───

class MemberAdd(BaseModel):
    user_ids: list[str] = Field(..., min_length=1)


# ─── DM ───

class DMRequest(BaseModel):
    user_id: str


# ─── Notifications ───

# ─── Reactions ───

class ReactionToggle(BaseModel):
    # 유니코드 이모지 또는 커스텀 ":name:"(chat22 — 10→64)
    emoji: str = Field(..., min_length=1, max_length=64)


# ─── chat22 ───

THREAD_ARCHIVE_MINUTES = (60, 1440, 4320, 10080)


class ThreadStart(BaseModel):
    name: str | None = Field(None, max_length=100)


class ThreadPatch(BaseModel):
    """전송된 필드만 변경된다(name: null 명시 시 이름 삭제)."""
    name: str | None = Field(None, max_length=100)
    archived: bool | None = None
    auto_archive_minutes: int | None = None


class EmojiRename(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)


class ProfileUpdate(BaseModel):
    """PATCH /me/profile — 전송된 필드만 변경. null/빈 문자열 = 비우기."""
    bio: str | None = Field(None, max_length=190)
    timezone: str | None = Field(None, max_length=64)


class ChatPolicyUpdate(BaseModel):
    admin_channel_privileges: bool | None = None
    owner_manage_messages: bool | None = None


class NotificationReadRequest(BaseModel):
    notification_ids: list[str] | None = None


# ─── Voice channel ───

class VoiceStateUpdate(BaseModel):
    """호출 사용자의 음성 상태 — 토큰 발급 시 수신한 identity 로 본인을 식별한다."""
    identity: str = Field(..., min_length=1, max_length=64)
    muted: bool = False
    deafened: bool = False
    # 송신 음질 단계(voice|music|lossless|hires) — 다른 사용자 화면의 배지용. 서버는 검증만 수행한다.
    tier: str = Field("voice", pattern=r"^(voice|music|lossless|hires)$")


class VoiceLeave(BaseModel):
    identity: str = Field(..., min_length=1, max_length=64)


class ChatServerSettingsUpdate(BaseModel):
    """PUT /server-settings — 전송된 필드만 변경. null/빈 문자열 = 비우기(default_notify_level 은 기본값 mentions 로 설정)."""
    name: str | None = Field(None, max_length=100)
    description: str | None = Field(None, max_length=500)
    default_notify_level: str | None = Field(None, pattern=r"^(all|mentions|none)$")
