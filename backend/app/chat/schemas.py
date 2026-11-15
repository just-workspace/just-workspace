"""Chat Pydantic schemas."""

from datetime import datetime

from pydantic import BaseModel, Field


# ─── Channel ───

class ChannelCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    type: str = Field("public", pattern=r"^(public|private)$")
    description: str | None = Field(None, max_length=500)
    member_ids: list[str] = Field(default_factory=list)
    # 음성 채널로 만들기(handover-20). 종류(public/private)는 그대로 — 멤버십 규칙이 같다.
    voice: bool = False
    # 포럼 채널(chat22) — 게시판 데이터의 채팅 보기. board_id 가 있으면 그 게시판 연결, 없으면 같은 이름 게시판 생성
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
    # 답글을 채널 타임라인에도 보이게("채널에도 보내기"). parent_id 가 없으면 무시.
    also_to_channel: bool = False
    # 인라인 답장(chat22) — 같은 채널(스레드 안이면 같은 스레드) 메시지. reply_ping = 원문 작성자에게 알림
    reply_to_id: str | None = None
    reply_ping: bool = True
    # @silent — 푸시·멘션 알림 없음. 본문이 "@silent " 로 시작해도 서버가 떼고 켠다
    silent: bool = False


class MarkUnreadRequest(BaseModel):
    message_id: str


class ChannelPrefsUpdate(BaseModel):
    notify_level: str | None = Field(None, pattern=r"^(all|mentions|none)$")
    muted: bool | None = None
    # ── 기기 알림 세부(p4) ──
    desktop: bool | None = None
    push: bool | None = None
    email: bool | None = None
    thread_replies: bool | None = None
    # 음소거 기간(chat22) — 15·60·180·480·1440, null 을 명시 = 내가 끌 때까지(필드를 안 보내면 그대로)
    muted_minutes: int | None = None


MUTE_MINUTES = (15, 60, 180, 480, 1440)


class ThreadReadRequest(BaseModel):
    # 비우면 마지막 답글까지
    seq: int | None = Field(None, ge=0)


class UserStatusUpdate(BaseModel):
    """PUT /me/status — 보낸 필드만 바뀐다. null 을 명시하면 그 값을 비운다."""
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
    """보낸 필드만 바뀐다(name: null 을 명시하면 이름 지우기)."""
    name: str | None = Field(None, max_length=100)
    archived: bool | None = None
    auto_archive_minutes: int | None = None


class EmojiRename(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)


class ProfileUpdate(BaseModel):
    """PATCH /me/profile — 보낸 필드만. null/빈 문자열 = 비우기."""
    bio: str | None = Field(None, max_length=190)
    timezone: str | None = Field(None, max_length=64)


class ChatPolicyUpdate(BaseModel):
    admin_channel_privileges: bool | None = None
    owner_manage_messages: bool | None = None


class NotificationReadRequest(BaseModel):
    notification_ids: list[str] | None = None


# ─── Voice channel (handover-20) ───

class VoiceStateUpdate(BaseModel):
    """내 음성 상태 — 토큰 발급 때 받은 identity 로 나를 가리킨다."""
    identity: str = Field(..., min_length=1, max_length=64)
    muted: bool = False
    deafened: bool = False
    # 보내는 음질 단계(voice|music|lossless|hires) — 다른 사람 화면의 배지용. 서버는 검증만 한다.
    tier: str = Field("voice", pattern=r"^(voice|music|lossless|hires)$")


class VoiceLeave(BaseModel):
    identity: str = Field(..., min_length=1, max_length=64)


class ChatServerSettingsUpdate(BaseModel):
    """PUT /server-settings — 보낸 필드만. null/빈 문자열 = 비우기(default_notify_level 은 기본 mentions 로)."""
    name: str | None = Field(None, max_length=100)
    description: str | None = Field(None, max_length=500)
    default_notify_level: str | None = Field(None, pattern=r"^(all|mentions|none)$")
