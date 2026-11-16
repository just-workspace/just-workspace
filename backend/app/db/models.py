import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Sequence,
    String,
    Text,
    UniqueConstraint,
    event,
    func,
    select,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    username: Mapped[str] = mapped_column(String(150), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    password_reset_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    password_reset_sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 마지막 비밀번호 변경 시각 — 프로필 보안 "마지막 변경 N개월 전" 표시용. null이면 미기록.
    password_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    recovery_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    email_verify_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    email_verify_sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    totp_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 2단계 복구 코드 — HMAC 해시의 JSON 배열(평문 미저장). app/auth/two_factor.py
    totp_recovery_codes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # 인증 소스 — "local"(기본) | "ldap"(AD/LDAP). external_id는 외부 디렉토리의 식별자.
    auth_source: Mapped[str] = mapped_column(String(16), default="local", server_default="local")
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 세션 무효화 토큰 — 쿠키의 tv가 이 값과 다르면 거부. +1 하면 해당 사용자의 전 세션 로그아웃.
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    # 관리자가 정지한 시각 — 값이 있으면 status=suspended(승인 대기와 구분). 재승인 시 비움.
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 채팅 프로필 팝아웃(chat22) — 소개(디스코드 190자)·시간대(IANA 이름, 예: Asia/Seoul). NULL = 없음.
    bio: Mapped[str | None] = mapped_column(String(190), nullable=True)
    timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)


class MailSignature(Base):
    __tablename__ = "mail_signatures"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    html_content: Mapped[str] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ShareLink(Base):
    __tablename__ = "share_links"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    file_path: Mapped[str] = mapped_column(String(1024))
    display_name: Mapped[str] = mapped_column(String(255))
    created_by: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    max_downloads: Mapped[int | None] = mapped_column(Integer, nullable=True)
    download_count: Mapped[int] = mapped_column(Integer, default=0)
    # 활성화 시 링크 수신자가 로그인 없이 공동 편집 가능(Office 문서만 — OnlyOffice, app/wopi/share.py).
    can_edit: Mapped[bool] = mapped_column(Boolean, default=False)
    # 비밀번호(argon2 해시, 없으면 공개) · 다운로드 허용 · 다중 항목 묶음(JSON 경로 배열)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    allow_download: Mapped[bool] = mapped_column(Boolean, default=True)
    paths: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ShareLinkEmail(Base):
    """공유 링크 이메일 발송 기록 — 수신자 1명당 한 행. 링크 삭제 시 함께 삭제한다(FK CASCADE + 라우터 명시 삭제).
    비밀번호는 메일에 포함하지 않는다. 시간당 발송 제한은 sent_by·created_at 으로 집계한다(실패한 시도도 포함)."""
    __tablename__ = "share_link_emails"
    # 컬럼 index=True 중복 선언 금지 — 인덱스는 여기서만.
    __table_args__ = (
        Index("ix_share_link_emails_link", "link_id"),
        Index("ix_share_link_emails_sender_time", "sent_by", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    link_id: Mapped[str] = mapped_column(String(36), ForeignKey("share_links.id", ondelete="CASCADE"))
    sent_by: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    recipient: Mapped[str] = mapped_column(String(320))
    # 워크스페이스 사용자이면 해당 id(이메일 일치), 아니면 NULL
    recipient_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 워크스페이스 외부 주소(사용자 이메일도 아니고 워크스페이스 도메인도 아님)
    external: Mapped[bool] = mapped_column(Boolean, default=True)
    ok: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class FileShare(Base):
    """특정 사용자 또는 채널에 본인 파일/폴더 공유(ACL). file_path=소유자 가상경로('my/...').
    수신자는 'shared-with-me/' 루트에서 열람. 권한은 role(보기·댓글·편집·공동 소유), can_write 는 호환용.
    채널 공유(shared_with_channel_id)는 해당 채널 멤버 전원 대상 — 가입·탈퇴가 즉시 반영됨.
    한 행은 사용자 또는 채널 하나(둘 중 하나만 지정)."""
    __tablename__ = "file_shares"
    # 컬럼 index=True 중복 선언 금지(동일 이름 인덱스 2회 생성 → create_all 롤백. mcp_personal_tokens 사례).
    # 기존 DB 의 채널 인덱스·NOT NULL 해제는 session._run_legacy_migrations 가 수행한다.
    __table_args__ = (
        Index("ix_file_shares_owner_path", "owner_id", "file_path"),
        Index("ix_file_shares_target", "shared_with_user_id"),
        Index("ix_file_shares_unique", "owner_id", "file_path", "shared_with_user_id", unique=True),
        Index("ix_file_shares_channel", "shared_with_channel_id"),
        Index("ix_file_shares_unique_channel", "owner_id", "file_path", "shared_with_channel_id", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    file_path: Mapped[str] = mapped_column(String(1024))  # 소유자 가상경로 (my/..)
    shared_with_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    shared_with_channel_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("channels.id", ondelete="CASCADE"), nullable=True
    )
    can_write: Mapped[bool] = mapped_column(Boolean, default=False)
    # 권한 4단계("보기 · 댓글 · 편집 · 공동 소유"): view|comment|edit|owner.
    # 기존 행(NULL)은 can_write 로 판정한다(편집/보기) — session._run_legacy_migrations 가 1회 채운다.
    # can_write 는 role in (edit, owner) 와 항상 동일하게 유지한다(채널 탭 등 기존 조회 코드 호환).
    role: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # 이 공유의 생성자. NULL = 원 소유자(기존 행). 공동 소유자가 재공유하면 해당 사용자 id.
    # 원 소유자 보호: 공동 소유자는 원 소유자가 생성한 공유를 변경하거나 해제할 수 없다.
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 이 공유의 생성 경위. NULL = 사용자가 공유 창에서 직접 설정(또는 기존 행), 'channel_folder' = 채널 폴더 연결로 생성.
    # 채널에서 폴더 연결을 해제하면 'channel_folder' 행만 회수한다(app/chat/tabs.py). 기존 행 추정 규칙도 해당 파일에 있다.
    origin: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class FileComment(Base):
    """파일 댓글. 파일은 공유와 동일한 방식으로 식별한다 — (소유자 id, 소유자 가상경로 'my/..').
    이름 변경·이동 시 file_path 를 함께 갱신하고, 휴지통 이동 시 'trash/<휴지통 이름>..' 으로 변경해 두었다가
    복원 시 되돌린다(영구 삭제 시 삭제한다). 작성은 댓글 권한 이상·소유자, 수정·삭제는 작성자만 가능하다."""
    __tablename__ = "file_comments"
    __table_args__ = (
        Index("ix_file_comments_owner_path", "owner_id", "file_path"),
        Index("ix_file_comments_author", "author_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    file_path: Mapped[str] = mapped_column(String(1024))
    author_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text)
    # @멘션으로 해석된 사용자 [{id, username, display_name}] (게시판 댓글과 같은 모양)
    mentions: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_edited: Mapped[bool] = mapped_column(Boolean, default=False)
    # 답글(최상위 댓글 id) · 위치 조각("시트 3 · D14") · 해결.
    # auto-migrate 가 컬럼을 추가한다(기존 행은 NULL = 최상위·위치 없음·열림).
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    anchor: Mapped[str | None] = mapped_column(String(200), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class Channel(Base):
    __tablename__ = "channels"
    __table_args__ = (
        Index("ix_channels_type", "type"),
        Index("ix_channels_created_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(100))
    type: Mapped[str] = mapped_column(String(10))  # public, private, dm
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id")
    )
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # 채널 탭 — 연결된 폴더(소유자 'my/..' 가상경로, 채널 공유를 통해 멤버가 열람)·위키 페이지.
    # auto-migrate 가 컬럼을 추가한다. 비어 있으면 탭은 "연결 안 됨".
    linked_folder_owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    linked_folder_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    linked_wiki_page_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 채널 탭 — 위키 탭은 스페이스 단위로 연결(비어 있으면 연결 페이지의 스페이스),
    # 탭 순서·숨김 = JSON {"order": [...], "hidden": [...]}(메시지는 항상 첫 번째이므로 저장하지 않음). auto-migrate 가 컬럼 추가.
    linked_wiki_space_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    tab_layout: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 음성 채널 — 디스코드 방식의 "들어가 있으면 말하는 방". type(public/private)은 그대로 유지하고
    # 플래그 하나로 구분한다: 멤버십·권한은 텍스트 채널과 동일하며, LiveKit 방 `voice-<채널id>` 하나가 연결된다.
    # auto-migrate 가 NULL 허용 컬럼으로 추가한다(NULL = 일반 채널).
    is_voice: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # 마지막 메시지 비정규화. 채널 목록 표시 시마다 DISTINCT ON 으로 메시지
    # 테이블을 스캔하지 않도록 create_message 가 갱신한다(스레드 답글·삭제분 제외).
    # Matrix 의 sliding_sync_joined_rooms.bump_stamp 와 동일한 역할.
    last_message_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    last_message_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_preview: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 카테고리·정렬. auto-migrate 가 NULL 허용 컬럼으로 추가하고
    # FK(ON DELETE SET NULL)는 session._run_chat_roles_migration 이 NOT VALID 로 추가한다. NULL = 카테고리 없음.
    category_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("chat_categories.id", ondelete="SET NULL"), nullable=True
    )
    position: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    # chat22 — 새 스레드 자동 보관 기본값(분, NULL = 4320 = 3일) · 포럼 채널 = 게시판(boards.id) 연결
    default_thread_auto_archive_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    forum_board_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


# ─── 채팅 역할·권한 — 계산은 app/chat/permissions.py 단일 위치 ───


class ChatCategory(Base):
    """채널 묶음(디스코드 카테고리). 워크스페이스 단위(설치 1개 = 디스코드 서버 1개)."""
    __tablename__ = "chat_categories"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(100))
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ChatRole(Base):
    """역할. is_default=True 인 행 하나가 @everyone(position 0, 삭제 불가).

    color 는 hex 가 아니라 본 프로젝트 팔레트의 토큰 키(permissions.ROLE_COLOR_TOKENS). group_id 가 있으면
    "관리되는 역할" — 멤버는 해당 그룹(group_members)에서 계산하며 chat_member_roles 행을 두지 않는다.
    groups 테이블은 별도 모듈이므로 FK 를 설정하지 않는다(그룹이 삭제되면 멤버 0 인 역할로 남는다).
    """
    __tablename__ = "chat_roles"
    __table_args__ = (Index("ix_chat_roles_group_id", "group_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str | None] = mapped_column(String(32), nullable=True)
    icon: Mapped[str | None] = mapped_column(String(64), nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    permissions: Mapped[int] = mapped_column(BigInteger, default=0)
    hoist: Mapped[bool] = mapped_column(Boolean, default=False)
    mentionable: Mapped[bool] = mapped_column(Boolean, default=False)
    group_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class ChatMemberRole(Base):
    """사용자 ↔ 역할(워크스페이스 단위). @everyone 과 관리되는 역할은 행을 두지 않는다."""
    __tablename__ = "chat_member_roles"
    __table_args__ = (
        UniqueConstraint("user_id", "role_id", name="uq_chat_member_role"),
        Index("ix_chat_member_roles_role_id", "role_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    role_id: Mapped[str] = mapped_column(String(36), ForeignKey("chat_roles.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ChatPermissionOverwrite(Base):
    """채널/카테고리 권한 덮어쓰기. target = channel|category, subject = role|user.

    대상·주체가 여러 테이블이므로 FK 가 없다 — 채널·카테고리·역할 삭제 시 코드에서 함께 삭제한다.
    """
    __tablename__ = "chat_permission_overwrites"
    __table_args__ = (
        UniqueConstraint("target_kind", "target_id", "subject_kind", "subject_id", name="uq_chat_perm_overwrite"),
        Index("ix_chat_perm_overwrites_target", "target_kind", "target_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    target_kind: Mapped[str] = mapped_column(String(10))   # channel | category
    target_id: Mapped[str] = mapped_column(String(36))
    subject_kind: Mapped[str] = mapped_column(String(10))  # role | user
    subject_id: Mapped[str] = mapped_column(String(36))
    allow: Mapped[int] = mapped_column(BigInteger, default=0)
    deny: Mapped[int] = mapped_column(BigInteger, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class ChannelMember(Base):
    __tablename__ = "channel_members"
    __table_args__ = (
        Index("ix_channel_members_user_channel", "user_id", "channel_id", unique=True),
        Index("ix_channel_members_channel_id", "channel_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.id", ondelete="CASCADE")
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(String(10), default="member")  # owner, admin, member
    last_read_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 읽음 포인터를 seq 로 관리. 미읽음 = 이 값보다 큰 seq 의 메시지 수. created_at
    # 환산보다 정확하며, 메시지 테이블 조인 없이 직접 비교할 수 있다. NULL = 읽은 이력 없음.
    # "안 읽음으로 표시" 는 이 값을 이전으로 되돌린다(mark_unread) — mark_read 만 단조 증가.
    last_read_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # 채널별 알림 수준: 'all'(모든 메시지 푸시) | 'mentions'(멘션만) | 'none'(푸시 없음).
    # NULL = 기본값(DM 은 'all', 그 외 'mentions') — 기존 행은 auto-migrate 로 NULL 이 되므로
    # 조회 측(service.effective_notify_level)이 채널 종류로 결정한다. 인앱 배지는 수준과 무관.
    notify_level: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # 음소거 — 서버 동작은 'all' 푸시 차단뿐이며, 나머지는 프런트가 배지를 회색으로 표시한다.
    muted: Mapped[bool] = mapped_column(Boolean, default=False)
    # ── 채널별 기기 알림 세부 ── 기존 행은 auto-migrate 의 DEFAULT 로 채워진다.
    # desktop: 데스크톱 앱 알림(클라이언트가 조회하여 표시 여부 판단) · push: 웹/모바일 푸시
    # email: 메일 알림(저장만 — 채팅 메일 발송기는 미구현) · thread_replies: 팔로우한 스레드 답글 푸시
    pref_desktop: Mapped[bool] = mapped_column(Boolean, default=True)
    pref_push: Mapped[bool] = mapped_column(Boolean, default=True)
    pref_email: Mapped[bool] = mapped_column(Boolean, default=False)
    pref_thread_replies: Mapped[bool] = mapped_column(Boolean, default=True)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    # 음소거 기간(chat22) — muted 이고 이 시각이 지났으면 음소거 아님으로 판정(지연 판정). NULL = 해제 시까지.
    muted_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# 메시지 전역 순번 시퀀스. 워커 8개가 동시에 INSERT 해도 DB 가 단조 증가를 보장한다.
# 기존 테이블에는 session.py 의 채팅 마이그레이션이 동일한 이름으로 생성하고 백필한다.
MESSAGE_SEQ = Sequence("messages_seq_seq")


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_channel_created", "channel_id", "created_at"),
        Index("ix_messages_parent_id", "parent_id"),
        Index("ix_messages_channel_deleted_created", "channel_id", "is_deleted", "created_at"),
        # seq 커서 — 전역 유니크 + 채널별 범위 스캔(미읽음 카운트·after_seq)
        Index("ix_messages_seq", "seq", unique=True),
        Index("ix_messages_channel_seq", "channel_id", "seq"),
        # 인라인 답장 원문 역참조(chat22). 기존 DB 는 session._run_chat22_migration 이 생성
        Index("ix_messages_reply_to_id", "reply_to_id"),
        # 본문 검색 인덱스는 pg_trgm GIN(ix_messages_content_trgm) — db/session.py 가 생성
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # 전역 단조 순번. uuid4 id 와 created_at 은 동일 ms 에 충돌할 수 있어
    # 재접속 복구 커서("since 이후 전부")로 사용할 수 없다. 모델상 nullable 인 이유는
    # 기존 행 백필 전까지 NULL 이 존재하기 때문 — PG 에서는 백필 후 NOT NULL 로 변경한다.
    seq: Mapped[int | None] = mapped_column(BigInteger, MESSAGE_SEQ, nullable=True)
    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.id", ondelete="CASCADE")
    )
    sender_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text)
    message_type: Mapped[str] = mapped_column(String(10), default="text")  # text, file, system
    file_meta: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    is_edited: Mapped[bool] = mapped_column(Boolean, default=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    # 스레드 답글 중 "채널에도 보내기" 를 선택한 것. 메인 타임라인·미읽음 계산은
    # `parent_id IS NULL OR thread_broadcast` 를 기준으로 한다(Slack 의 also_send_to_channel).
    thread_broadcast: Mapped[bool] = mapped_column(Boolean, default=False)
    # 핀. pinned_at 이 NULL 이면 핀 아님. 채널 핀 목록은 (channel_id, pinned_at) 으로 조회한다.
    pinned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    pinned_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # 링크 미리보기 — 본문 첫 외부 링크의 OG 카드 JSON. 서버가 비동기로 채운다(app/chat/link_preview.py).
    # NULL = 없음(링크 없음·수신 실패·미도착). {"dismissed": true, "url": …} = 발신자가 제거함.
    link_preview: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    # ── chat22 ── 전부 NULL 허용(auto-migrate). 조회 측이 NULL 을 기본값으로 해석한다.
    # 인라인 답장 원문 — parent_id(스레드)와 별개. FK 없음: 원문 행이 삭제되면 state='unavailable' 로 표시된다.
    reply_to_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 비트(chat/messages22.py MSG_FLAG_*): SILENT 1 · SUPPRESS_EMBEDS 2(예약) · REPLY_PING 32
    flags: Mapped[int | None] = mapped_column(Integer, nullable=True, default=0)
    # 다중 첨부 JSON 배열 [{id, filename, size, mime_type, url, disk_name, width, height, duration, spoiler, alt}]
    # NULL 이면 기존 file_meta(단일)를 1개 항목으로 변환하여 표시한다.
    attachments: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 스레드(루트 메시지에만) — 이름·명시 시작·명시 보관·자동 보관(분)·마지막 활동(답글·보관 해제)
    thread_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    thread_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    thread_archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    thread_auto_archive_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    thread_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class LinkPreviewCache(Base):
    """링크 미리보기 캐시 — 주소(정규화) 하나당 한 행. 동일 링크를 여러 번 전송해도 외부 요청은 1회만 발생한다.

    data 가 NULL 이면 "가져오지 못함"(단기 캐시하여 동일한 실패 주소로의 반복 요청을 방지한다).
    """

    __tablename__ = "link_preview_cache"

    url_hash: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256(정규화 주소)
    url: Mapped[str] = mapped_column(Text)
    data: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON {url, site, title, description, image}
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class LinkPreviewImage(Base):
    """링크 미리보기 썸네일 — 서버가 수신하여 축소 후 재인코딩한 것. 수신 측 브라우저는 외부가 아닌 이곳에서 수신한다."""

    __tablename__ = "link_preview_images"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256(원본 이미지 주소)
    content_type: Mapped[str] = mapped_column(String(32))
    data: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


@event.listens_for(Message, "before_insert")
def _message_seq_fallback(mapper, connection, target) -> None:
    """시퀀스를 지원하지 않는 DB(SQLite 테스트)에서만 seq 를 max+1 로 채운다.

    PostgreSQL 은 MESSAGE_SEQ 가 INSERT 시 nextval 로 부여하므로 이 분기에 진입하지
    않는다. 동시성 보장이 없는 폴백이므로 실제 서비스에서는 실행되어서는 안 된다.
    """
    if target.seq is None and not connection.dialect.supports_sequences:
        target.seq = connection.execute(
            select(func.coalesce(func.max(Message.__table__.c.seq), 0) + 1)
        ).scalar()


class Reaction(Base):
    __tablename__ = "reactions"
    __table_args__ = (
        Index("ix_reactions_message_id", "message_id"),
        Index("ix_reactions_unique", "message_id", "user_id", "emoji", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    message_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="CASCADE")
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    emoji: Mapped[str] = mapped_column(String(64))  # 유니코드 또는 커스텀 ":name:"(chat22 — 10→64, PG 는 session 이 ALTER)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ChatMention(Base):
    """채널 안에서 사용자를 @멘션한 메시지 1건 = 1행.

    Notification(type='mention') 을 재사용하지 않는 이유: 알림함은 여러 종류가 혼재하는 수신함이고
    is_read 가 "알림을 확인했다" 는 의미이므로 채널을 읽어도 해제되지 않는다. 채널별 멘션 배지는
    "채널의 last_read_seq 보다 뒤에 있는 멘션 수" 이므로 (user, channel, seq) 로 직접 집계해야
    한다. Rocket.Chat ISubscription.userMentions, Zulip UserMessage.mentioned 플래그와 동일한 역할.
    """

    __tablename__ = "chat_mentions"
    __table_args__ = (
        # 멘션 카운트 쿼리: user_id = 본인 AND channel_id AND seq > last_read_seq
        Index("ix_chat_mentions_user_channel_seq", "user_id", "channel_id", "seq"),
        Index("ix_chat_mentions_message", "message_id"),
        # 동일 메시지가 동일 사용자를 두 번 멘션해도 1행 — 재전송·재처리에 안전
        Index("ix_chat_mentions_unique", "user_id", "message_id", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.id", ondelete="CASCADE")
    )
    message_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="CASCADE")
    )
    seq: Mapped[int] = mapped_column(BigInteger)
    # @채널·@전체 처럼 채널 전원을 대상으로 한 멘션. 배지가 상이하다(개인 = 채운 숫자, 그룹 = 테두리 @).
    # 동일 메시지에 본인 이름도 있으면 개인(False)이 우선한다.
    is_group: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class SavedMessage(Base):
    """사용자가 저장(북마크)한 메시지.

    동일 메시지를 두 번 저장해도 한 건만 남도록 유니크 인덱스를 설정한다 — 저장 버튼은
    토글이므로 중복 요청이 실제로 발생한다.
    """

    __tablename__ = "saved_messages"
    __table_args__ = (
        Index("ix_saved_messages_user", "user_id", "created_at"),
        Index("ix_saved_messages_unique", "user_id", "message_id", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    message_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="CASCADE")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ThreadFollow(Base):
    """스레드 구독 1건 = (사용자, 원 메시지) 1행.

    루트 작성자·답글 작성자·답글에서 멘션된 사용자는 자동으로 팔로우된다(Slack 과 동일).
    `followed=False` 행은 "명시적으로 해제했다" 는 기록 — 삭제하지 않고 유지해야 다음 답글이
    자동 팔로우를 다시 활성화하지 않는다(답글을 직접 작성하면 다시 활성화된다). last_read_seq 는 이
    스레드 안에서 읽은 마지막 답글의 seq — 스레드 미읽음 = 그보다 큰 seq 의 답글 수.
    """

    __tablename__ = "thread_follows"
    __table_args__ = (
        Index("ix_thread_follows_unique", "user_id", "root_message_id", unique=True),
        # 내 스레드 목록·총 미읽음: user_id = 본인 AND followed
        Index("ix_thread_follows_user_followed", "user_id", "followed"),
        # 새 답글 → 팔로워 전원에게 thread_update
        Index("ix_thread_follows_root", "root_message_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    root_message_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="CASCADE")
    )
    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.id", ondelete="CASCADE")
    )
    last_read_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    followed: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class UserStatus(Base):
    """프레즌스 설정 — 사용자당 1행(PK = user_id). 행이 없으면 전부 기본(auto).

    연결 여부는 Redis(chat/presence.py)가 관리하고, 여기에는 사용자가 선택한 값만 저장한다.
    실효 상태 = 연결 없음 → offline, invisible → offline 로 표시, dnd(또는 dnd_until 이
    미래) → dnd, away → away, auto → online. 만료된 커스텀 상태·DND 는 조회 시 무시한다
    (배치 정리 없음). DND 중에는 웹푸시를 송신하지 않는다 — 인앱 알림·배지는 유지한다.
    """

    __tablename__ = "user_statuses"

    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    mode: Mapped[str] = mapped_column(String(10), default="auto")  # auto, away, dnd, invisible
    custom_emoji: Mapped[str | None] = mapped_column(String(16), nullable=True)
    custom_text: Mapped[str | None] = mapped_column(String(100), nullable=True)
    custom_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    dnd_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class ChatDraft(Base):
    """입력창 임시글 — (사용자, 채널, 스레드 루트) 당 1행. 기기 간 이어 쓰기 용도.

    parent_id 가 NULL 이면 채널 입력창, 아니면 해당 스레드의 답글 입력창. PG 유니크 인덱스는
    NULL 을 서로 다른 값으로 취급하므로 채널 입력창의 유일성은 service.upsert_draft 가
    select-then-update 로 보장한다. 메시지를 전송하면 해당 위치의 임시글은 삭제한다.
    """

    __tablename__ = "chat_drafts"
    __table_args__ = (
        Index("ix_chat_drafts_unique", "user_id", "channel_id", "parent_id", unique=True),
        Index("ix_chat_drafts_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    channel_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("channels.id", ondelete="CASCADE")
    )
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="CASCADE"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_user_id", "user_id"),
        Index("ix_notifications_is_read", "is_read"),
        Index("ix_notifications_created_at", "created_at"),
        Index("ix_notifications_user_read_created", "user_id", "is_read", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    type: Mapped[str] = mapped_column(
        String(20)
    )  # mention, task_assigned, file_shared, calendar_invite, system
    title: Mapped[str] = mapped_column(String(255))
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    link: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    # 발신자(활동 수신함 아바타·이름). 시스템 알림은 비어 있음.
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    actor_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 동작 — 선택 시 이동할 위치(action_url)와 버튼 목록(actions_json: [{id,label,method,url,body}] JSON)
    action_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    actions_json: Mapped[str | None] = mapped_column(Text, nullable=True)


class NotificationPref(Base):
    """알림 채널 선호 — user×type별 in_app/push/email on/off.
    행이 없으면 전체 on(하위호환). 프로필 '알림' 탭에서 편집."""
    __tablename__ = "notification_prefs"
    # NOTE: 컬럼에 index=True 를 중복 지정하지 말 것 — 동일 이름 인덱스 2회 생성 시
    # create_all 이 DuplicateTable 로 트랜잭션 롤백됨(mcp_personal_tokens 사례).
    __table_args__ = (
        Index("ix_notification_prefs_user_type", "user_id", "type", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    type: Mapped[str] = mapped_column(String(20))  # mention/task_assigned/file_shared/calendar_invite/system
    in_app: Mapped[bool] = mapped_column(Boolean, default=True)
    push: Mapped[bool] = mapped_column(Boolean, default=True)
    email: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class MailAccount(Base):
    __tablename__ = "mail_accounts"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    display_name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str] = mapped_column(String(255))
    # 수신 프로토콜: imap(기본) | pop3. POP3는 서버 측 폴더/플래그가 없어 INBOX 전용이며
    # 읽음/별표를 로컬(mail_pop3_state 테이블)에 저장한다. 아래 imap_* 필드를 POP3에서는 '수신 서버'로 재사용한다.
    protocol: Mapped[str] = mapped_column(String(10), default="imap", server_default="imap")
    # IMAP (POP3면 수신 서버)
    imap_host: Mapped[str] = mapped_column(String(255))
    imap_port: Mapped[int] = mapped_column(Integer, default=993)
    imap_security: Mapped[str] = mapped_column(String(10), default="ssl")  # ssl, starttls, none
    # SMTP
    smtp_host: Mapped[str] = mapped_column(String(255))
    smtp_port: Mapped[int] = mapped_column(Integer, default=587)
    smtp_security: Mapped[str] = mapped_column(String(10), default="starttls")  # ssl, starttls, none
    # Auth
    username: Mapped[str] = mapped_column(String(255))
    password_encrypted: Mapped[str] = mapped_column(Text)
    # OAuth2 (XOAUTH2 — Gmail/Microsoft365). auth_method="password"|"oauth"
    auth_method: Mapped[str] = mapped_column(String(16), default="password")
    oauth_provider: Mapped[str | None] = mapped_column(String(20), nullable=True)  # google|microsoft
    oauth_refresh_token: Mapped[str | None] = mapped_column(Text, nullable=True)   # 암호화 저장
    oauth_access_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    oauth_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 외부 메일 아카이브 — 활성화 시 새 메일을 .eml 원본으로 파일 스토리지에 보존한다.
    # 계정이 정지/해지되어도 원본이 유지되며, 파일 색인기가 본문·첨부까지 검색에 포함한다.
    # 기본값은 비활성화: 활성화 여부는 사용자가 결정한다.
    archive_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # State
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    last_sync_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    sync_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # 새 메일 감시(app/mail/poller.py)가 마지막으로 확인한 INBOX UID. NULL = 기준 미설정.
    last_seen_uid: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # POP3 의 읽음·별표(mail_pop3_state)를 기존 저장 위치(Redis)에서 이전했는지 여부 — 1회만 이전한다.
    pop3_state_imported: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class MailPop3State(Base):
    """POP3 계정의 메시지별 읽음·별표. POP3 서버에는 플래그가 없으므로 여기에 저장한다(식별자는 UIDL).

    둘 다 해제된 메시지는 행을 두지 않는다.
    """

    __tablename__ = "mail_pop3_state"

    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("mail_accounts.id", ondelete="CASCADE"), primary_key=True
    )
    uidl: Mapped[str] = mapped_column(String(255), primary_key=True)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    is_flagged: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")


class PrivacyPin(Base):
    """개인 잠금 PIN 의 해시(app/privacy/gate.py). 사용자 테이블과 분리한다 — 사용자 행을 조회하는 코드를 통해 함께 노출되지 않도록 하기 위함이다."""

    __tablename__ = "privacy_pins"

    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    pin_hash: Mapped[str] = mapped_column(String(255))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class CalendarDB(Base):
    __tablename__ = "calendars"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    is_visible: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    # ── 외부 캘린더 구독(.ics, 설정 › 캘린더) ── auto-migrate 가 컬럼 추가.
    # source_url 이 있으면 "구독 캘린더" — 읽기 전용(일정 쓰기·CalDAV PUT/DELETE 금지),
    # 6시간마다 app/calendar/subscriptions.py 가 재수신하여 일정을 동기화한다.
    source_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    # 마지막 수신 성공 시각 / 마지막 시도 시각 / 마지막 실패 사유(성공 시 비움)
    source_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source_error: Mapped[str | None] = mapped_column(String(200), nullable=True)


class CalendarEventDB(Base):
    __tablename__ = "calendar_events"
    __table_args__ = (
        Index("ix_calendar_events_calendar_id", "calendar_id"),
        Index("ix_calendar_events_start", "start"),
        Index("ix_calendar_events_range", "calendar_id", "start", "end"),
        Index("ix_calendar_events_parent", "parent_event_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    calendar_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("calendars.id", ondelete="CASCADE")
    )
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    location: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="confirmed")
    recurrence_rule: Mapped[str | None] = mapped_column(String(500), nullable=True)
    recurrence_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    reminder_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reminder_sent: Mapped[bool] = mapped_column(Boolean, default=False)
    # 반복 일정용 — 마지막으로 리마인더를 발송한 occurrence 시작 시각 (per-occurrence 중복 방지)
    reminder_last_sent_for: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # ── 참석자·회차 예외·시간대·회의 링크 ──
    # IANA 시간대(예: Asia/Seoul). 반복 전개·CalDAV TZID 에 사용한다. 없으면 UTC 로 간주한다.
    timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    meeting_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    # 반복 일정에서 제외한 회차(EXDATE) — UTC ISO 문자열 JSON 배열
    exdates: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 회차 단일 수정(RECURRENCE-ID) 행이면 마스터 id 와 원래 회차 시작(UTC)
    parent_event_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    recurrence_id: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 외부(휴대폰·.ics)에서 수신한 일정의 원래 UID. 없으면 id 를 UID 로 사용한다.
    ical_uid: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class CalendarShareDB(Base):
    __tablename__ = "calendar_shares"
    __table_args__ = (
        Index("ix_calendar_shares_unique", "calendar_id", "shared_with_user_id", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    calendar_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("calendars.id", ondelete="CASCADE")
    )
    shared_with_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    can_write: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class AddressBookDB(Base):
    __tablename__ = "address_books"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ContactDB(Base):
    __tablename__ = "contacts"
    __table_args__ = (
        Index("ix_contacts_address_book_id", "address_book_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    address_book_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("address_books.id", ondelete="CASCADE")
    )
    full_name: Mapped[str] = mapped_column(String(255))
    given_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    surname: Mapped[str | None] = mapped_column(String(100), nullable=True)
    organization: Mapped[str | None] = mapped_column(String(255), nullable=True)
    emails: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    phones: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    addresses: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 사진(data URI, 상한 있음) · 즐겨찾기 · 그룹(JSON 문자열 배열 = vCard CATEGORIES) · 직함
    photo: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    groups: Mapped[str | None] = mapped_column(Text, nullable=True)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 외부 계정(Google/Microsoft)에서 가져온 연락처의 원본 식별자.
    # 재동기화 시 중복 생성하지 않고 덮어쓰기 위한 키.
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    external_source: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class Board(Base):
    __tablename__ = "boards"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(100))
    slug: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    categories: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON array
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    write_permission: Mapped[str] = mapped_column(String(20), default="all")  # all, admin
    notice_permission: Mapped[str] = mapped_column(String(20), default="admin")  # all, admin
    comment_permission: Mapped[str] = mapped_column(String(20), default="all")  # all, admin
    allow_comments: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_reactions: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class Post(Base):
    __tablename__ = "posts"
    __table_args__ = (
        Index("ix_posts_board_id", "board_id"),
        Index("ix_posts_author_id", "author_id"),
        Index("ix_posts_created_at", "created_at"),
        Index("ix_posts_board_pinned", "board_id", "is_pinned"),
        Index("ix_posts_board_pinned_created", "board_id", "is_pinned", "created_at"),
        # 제목·본문 검색 인덱스는 pg_trgm GIN(ix_posts_{title,content}_trgm) — db/session.py 가 생성
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    board_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("boards.id", ondelete="CASCADE")
    )
    author_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    title: Mapped[str] = mapped_column(String(255))
    content: Mapped[str] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(50), nullable=True)
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    is_must_read: Mapped[bool] = mapped_column(Boolean, default=False)
    must_read_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    view_count: Mapped[int] = mapped_column(Integer, default=0)
    comment_count: Mapped[int] = mapped_column(Integer, default=0)
    attachments: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    is_edited: Mapped[bool] = mapped_column(Boolean, default=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class PostComment(Base):
    __tablename__ = "post_comments"
    __table_args__ = (
        Index("ix_post_comments_post_id", "post_id"),
        Index("ix_post_comments_author_id", "author_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    post_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("posts.id", ondelete="CASCADE")
    )
    author_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("post_comments.id", ondelete="CASCADE"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text)
    attachments: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    is_edited: Mapped[bool] = mapped_column(Boolean, default=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    # @멘션으로 해석된 사용자 [{id, username, display_name}]
    mentions: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class PostReaction(Base):
    __tablename__ = "post_reactions"
    __table_args__ = (
        Index("ix_post_reactions_post_id", "post_id"),
        Index("ix_post_reactions_unique", "post_id", "user_id", "emoji", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    post_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("posts.id", ondelete="CASCADE")
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    emoji: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class PostBookmark(Base):
    __tablename__ = "post_bookmarks"
    __table_args__ = (
        Index("ix_post_bookmarks_unique", "post_id", "user_id", unique=True),
        Index("ix_post_bookmarks_user_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    post_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("posts.id", ondelete="CASCADE")
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class PostReadLog(Base):
    __tablename__ = "post_read_logs"
    __table_args__ = (
        Index("ix_post_read_logs_unique", "post_id", "user_id", unique=True),
        Index("ix_post_read_logs_user_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    post_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("posts.id", ondelete="CASCADE")
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    read_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class TaskDB(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        Index("ix_tasks_user_id", "user_id"),
        Index("ix_tasks_due_date", "due_date"),
        Index("ix_tasks_parent_id", "parent_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    due_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    priority: Mapped[str] = mapped_column(String(10), default="medium")  # low, medium, high, urgent
    status: Mapped[str] = mapped_column(String(20), default="todo")  # todo, in_progress, review, done
    calendar_event_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    # 담당자(다른 사용자에게 배정). user_id 는 생성자(소유자). 둘 다 이 작업을 열람·수정할 수 있다.
    assignee_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 채널에 연결된 작업 — 채널 탭 "작업"(멤버 전원이 목록 열람 가능). auto-migrate 가 컬럼 추가
    channel_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 태그 목록(JSON 문자열 배열)·프로젝트 이름 — 목록 필터용
    tags_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    project: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class MailDraft(Base):
    __tablename__ = "mail_drafts"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    account_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    subject: Mapped[str | None] = mapped_column(String(500), nullable=True)
    to_addresses: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    cc_addresses: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    bcc_addresses: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    body_html: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 초안에서 선택한 서명 — 본문에 서명을 삽입하지 않고 별도로 저장하여 이중 부착을 방지한다
    signature_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # AI 가 첨부한 워크스페이스 파일(JSON [{path,name,size,type}]). 바이트는 복사하지 않으며, 작성 창이 초안을
    # 열 때 해당 사용자 권한으로 다시 열어 임시 첨부로 변환한다(app.mail.file_attach). 기존 행은 NULL.
    file_attachments: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class MailFilterRule(Base):
    __tablename__ = "mail_filter_rules"
    __table_args__ = (
        Index("ix_mail_filter_rules_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36))
    account_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    name: Mapped[str] = mapped_column(String(255))
    field: Mapped[str] = mapped_column(String(20))  # from, to, subject, any
    match_type: Mapped[str] = mapped_column(String(20), default="contains")  # contains, equals, starts_with
    value: Mapped[str] = mapped_column(String(500))
    action: Mapped[str] = mapped_column(String(20), default="move")  # move
    target_folder: Mapped[str] = mapped_column(String(255))
    priority: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class AccessLog(Base):
    __tablename__ = "access_logs"
    __table_args__ = (
        Index("ix_access_logs_created_at", "created_at"),
        Index("ix_access_logs_user_id", "user_id"),
        Index("ix_access_logs_created_service", "created_at", "service"),
        Index("ix_access_logs_ip_address", "ip_address"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    ip_address: Mapped[str] = mapped_column(String(45))
    method: Mapped[str] = mapped_column(String(10))
    path: Mapped[str] = mapped_column(String(2048))
    status_code: Mapped[int] = mapped_column(Integer)
    response_time_ms: Mapped[int] = mapped_column(Integer)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    browser: Mapped[str | None] = mapped_column(String(100), nullable=True)
    os: Mapped[str | None] = mapped_column(String(100), nullable=True)
    device: Mapped[str | None] = mapped_column(String(100), nullable=True)
    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True
    )
    service: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # 요청 번호(X-Request-ID) — 오류 화면의 "요청 번호"로 해당 행을 조회한다(auto-migrate 가 컬럼 추가)
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_actor_id", "actor_id"),
        Index("ix_audit_logs_created_at", "created_at"),
        Index("ix_audit_logs_action", "action"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    actor_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(100))  # e.g. "user.approve", "module.enable"
    resource_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    details: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    __table_args__ = (
        Index("ix_push_subs_user_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=False
    )
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    keys_json: Mapped[str] = mapped_column(Text, nullable=False)  # JSON: {p256dh, auth}
    expiration_time: Mapped[float | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


# ─── Wiki ───


class WikiSpace(Base):
    __tablename__ = "wiki_spaces"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(200), unique=True, index=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=False
    )
    visibility: Mapped[str] = mapped_column(
        String(20), default="private"
    )  # public, private
    icon: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class WikiPage(Base):
    __tablename__ = "wiki_pages"
    __table_args__ = (
        Index("ix_wiki_pages_space_id", "space_id"),
        Index("ix_wiki_pages_parent_id", "parent_id"),
        Index("ix_wiki_pages_slug", "space_id", "slug"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    space_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("wiki_spaces.id", ondelete="CASCADE"), nullable=False
    )
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("wiki_pages.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    slug: Mapped[str] = mapped_column(String(500), nullable=False)
    content: Mapped[str] = mapped_column(Text, default="")
    author_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=False
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class WikiPageVersion(Base):
    __tablename__ = "wiki_page_versions"
    __table_args__ = (
        Index("ix_wiki_versions_page_id", "page_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    page_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("wiki_pages.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    content: Mapped[str] = mapped_column(Text, default="")
    author_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class WikiSpaceMember(Base):
    __tablename__ = "wiki_space_members"
    __table_args__ = (
        Index("ix_wiki_members_space_user", "space_id", "user_id", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    space_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("wiki_spaces.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=False
    )
    role: Mapped[str] = mapped_column(
        String(20), default="reader"
    )  # reader, writer, admin


class OAuthRefreshToken(Base):
    """Refresh tokens for the portal OAuth provider (MCP connectors etc.).

    Stored in Postgres so they survive restarts/container refreshes (Redis 단독
    금지). Only the SHA-256 hash of the token is persisted — never plaintext.
    Rotation is mandatory: each use revokes the row and issues a successor whose
    ``rotated_from`` points back here, forming a chain. Reuse of an already
    rotated/revoked token revokes the whole chain.
    """

    __tablename__ = "oauth_refresh_tokens"
    __table_args__ = (
        Index("ix_oauth_refresh_rotated_from", "rotated_from"),
        Index("ix_oauth_refresh_user_client", "user_id", "client_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # SHA-256 hex digest of the opaque refresh token (never plaintext).
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    client_id: Mapped[str] = mapped_column(String(255))
    scope: Mapped[str] = mapped_column(String(500), default="")
    # Bound resource/audience (RFC 8707) — may be empty for non-MCP clients.
    resource: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # token_hash of the predecessor this token was rotated from (chain link).
    rotated_from: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Set when consumed (rotated) or revoked. NULL = live.
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class OAuthDynamicClient(Base):
    """Dynamically registered OAuth clients (RFC 7591 Dynamic Client Registration).

    claude.ai and other MCP clients self-register at ``POST /oauth/register`` so
    the user only enters the connector URL and logs in — no manual Client ID /
    Secret. Only the SHA-256 hash of the client secret is persisted, never
    plaintext (mirrors :class:`OAuthRefreshToken`). DCR clients are clamped to
    ``mcp:read`` scope and an exact-match redirect_uri whitelist — they can never
    obtain ``mcp:write``. Static clients (portal-gitea, claude-mcp) live in
    settings.oauth_clients_json and are unaffected.
    """

    __tablename__ = "oauth_dynamic_clients"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # Public identifier, e.g. "dcr_<token_urlsafe>". Unique.
    client_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # SHA-256 hex digest of the client secret (never plaintext).
    client_secret_hash: Mapped[str] = mapped_column(String(64))
    redirect_uris: Mapped[str] = mapped_column(Text)  # JSON array (exact-match whitelist)
    scopes: Mapped[str] = mapped_column(Text, default='["mcp:read"]')  # JSON array
    client_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    grant_types: Mapped[str] = mapped_column(
        Text, default='["authorization_code", "refresh_token"]'
    )  # JSON array
    token_endpoint_auth_method: Mapped[str] = mapped_column(
        String(32), default="client_secret_post"
    )
    # ── RFC 7591 §2 표시용 메타데이터 ──
    # 스펙이 "동의 화면에서 사용자에게 보여주기 위한 값"으로 정의한 필드이다.
    # 등록 시 https 인 것만 허용한다(logo_uri 는 <img src> 로 렌더링되므로
    # javascript:/data: 를 허용해서는 안 된다).
    logo_uri: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    client_uri: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    policy_uri: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    tos_uri: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class McpPersonalToken(Base):
    """Personal Access Token (PAT) — a non-expiring-by-default bearer credential a
    user mints for the MCP connector as a fallback to the interactive OAuth flow.

    The plaintext token (``wsmcp_<token_urlsafe>``) is shown to the user exactly
    once at creation and never stored — only its SHA-256 hash is persisted
    (mirrors :class:`OAuthRefreshToken` / :class:`OAuthDynamicClient`). PATs are
    clamped to ``mcp:read`` and are user+scope bound: :func:`authenticate` in
    ``app.mcp.http_server`` recognises the ``wsmcp_`` prefix, looks the hash up
    here, and binds every tool call to ``user_id`` — no ``aud`` check needed.
    """

    __tablename__ = "mcp_personal_tokens"
    # NOTE: no explicit Index() for user_id here — the column below already
    # declares index=True, which auto-creates ix_mcp_personal_tokens_user_id.
    # Declaring both produces two same-named indexes → create_all raises
    # DuplicateTable and rolls back the whole table (table never gets created).

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # SHA-256 hex digest of the opaque PAT (never plaintext).
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(255))
    # 토큰 끝 4자(목록에 "wsmcp_…7c2e" 로 표시하여 구분하는 용도 — 비밀로 사용할 수 없는 길이). 기존 행은 NULL.
    token_hint: Mapped[str | None] = mapped_column(String(8), nullable=True)
    # JSON array of scopes; clamped to ["mcp:read"].
    scopes: Mapped[str] = mapped_column(Text, default='["mcp:read"]')
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Set when the user revokes the token. NULL = live.
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class OAuthConsent(Base):
    """사용자가 특정 OAuth 클라이언트에 부여한 스코프 동의 기록.

    이 테이블 도입 이전에는 ``/oauth/authorize`` 가 **세션만 확인하고 곧바로
    authorization code 를 발급**했다. ``/oauth/register`` 가 인증 없이 공개되어 있어
    (RFC 7591 DCR), 누구나 자신의 redirect_uri 로 클라이언트를 등록한 뒤 로그인된
    사용자가 authorize 링크를 클릭하도록 유도하면 동의 절차 없이 해당 사용자의 mcp:read
    토큰을 획득할 수 있었다. PKCE 와 state 로도 차단할 수 없다 — 공격자가 곧 클라이언트이므로
    code_verifier 와 client_secret 을 모두 보유하기 때문이다.

    정적 클라이언트 중 ``trusted: true`` 인 것(자사 Gitea 등)은 동의를 생략한다.
    DCR 클라이언트는 **항상** 동의를 받는다.
    """

    __tablename__ = "oauth_consents"
    __table_args__ = (
        UniqueConstraint("user_id", "client_id", name="uq_oauth_consent_user_client"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    # 공백 구분 스코프 문자열. 재동의 시 합집합으로 갱신한다.
    scopes: Mapped[str] = mapped_column(Text, default="")
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    # 사용자가 프로필에서 연결을 해제하면 기록된다. NULL = 유효.
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class OAuthSigningKey(Base):
    """OIDC 토큰 서명용 비대칭 키쌍.

    OpenID Connect Discovery 1.0 은 ``jwks_uri`` 를 REQUIRED 로, 그리고
    ``id_token_signing_alg_values_supported`` 에 **RS256 을 MUST** 로 요구한다.
    이전에는 HS256(대칭키, settings.secret_key)만 사용했으므로 표준 OIDC
    클라이언트가 서명을 검증할 방법이 없었다(RP 가 서버 비밀키를 알아야 함).

    비대칭으로 전환하면 부수적으로 **리소스 서버가 공개키만으로 검증**할 수 있어,
    향후 SSO 를 별도 컨테이너로 분리할 때 비밀키를 공유하지 않아도 된다.

    파일이 아닌 DB 에 저장하는 이유: uvicorn 워커가 8개이므로 파일 생성이 경합한다.
    ``retired_at IS NULL`` 에 대한 부분 유니크 인덱스로 활성 키를 하나로 강제한다.
    """

    __tablename__ = "oauth_signing_keys"
    __table_args__ = (
        Index(
            "ix_oauth_signing_keys_active",
            "purpose",
            unique=True,
            postgresql_where=text("retired_at IS NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # JWKS 의 "kid" — JWT 헤더에 포함되며 RP 가 이 값으로 키를 선택한다.
    kid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # 용도 구분. 현재는 "oidc" 하나이나 SAML 서명키 추가에 대비한 필드이다.
    purpose: Mapped[str] = mapped_column(String(32), default="oidc")
    algorithm: Mapped[str] = mapped_column(String(16), default="RS256")
    private_pem: Mapped[str] = mapped_column(Text)
    public_pem: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    # 회전 시 기록한다. 폐기된 키도 JWKS 에 일정 기간 유지해야 기존 토큰 검증이 가능하다.
    retired_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AppPassword(Base):
    """앱 비밀번호 — 로그인 화면이 없는 프로그램(메일 앱 IMAP/SMTP, CalDAV/CardDAV)용 별도 비밀번호.

    평문(xxxx-xxxx-xxxx-xxxx, 약 79비트 난수)은 발급 직후 1회만 표시하고, DB 에는
    정규화(소문자·영숫자만)한 값의 SHA-256 만 저장한다(OAuthRefreshToken·McpPersonalToken 과 동일한 방식).
    scopes 는 "mail,dav" 와 같은 쉼표 구분 목록 — mail = /api/internal/mail-auth, dav = DAV Basic 인증.
    2단계 인증 사용자도 OTP 없이 사용할 수 있도록 하는 것이 목적이므로 범위를 좁게 설정하며, 삭제하면 즉시 차단된다.
    """

    __tablename__ = "app_passwords"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(100))
    scopes: Mapped[str] = mapped_column(String(64), default="mail,dav")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class UserDevice(Base):
    """데스크톱/모바일 클라이언트 기기 등록.

    데스크톱 앱을 세션 쿠키에서 분리하여 OAuth 로 전환하는 이유는 다음과 같다.
    쿠키는 **기기 하나만 선택하여 해지할 방법이 없다** — token_version 을 올리면 해당
    사용자의 모든 세션이 함께 종료된다. 기기를 별도로 기록해야 "노트북 분실" 시
    해당 기기만 해지하는 대응이 가능하다.

    리프레시 토큰과의 연결(``refresh_token_hash``)이 핵심이다. 기기를 해지하면
    해당 토큰 패밀리를 폐기해야 실제로 접근이 차단된다 — 행만 삭제하면 토큰은 계속 유효하다.
    """

    __tablename__ = "user_devices"
    __table_args__ = (
        Index("ix_user_devices_user", "user_id"),
        Index("ix_user_devices_last_seen", "last_seen_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    # 사용자가 목록에서 식별하기 위한 이름. 클라이언트가 호스트명을 전송한다.
    name: Mapped[str] = mapped_column(String(200))
    platform: Mapped[str] = mapped_column(String(32), default="")     # win32 | darwin | linux
    app_version: Mapped[str] = mapped_column(String(32), default="")
    # 이 기기에 발급된 리프레시 토큰. 해지 시 이 값으로 토큰 패밀리를 조회하여 폐기한다.
    refresh_token_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 사용자가 해지하면 기록한다. 행을 삭제하지 않는 이유는 감사 추적 때문이다.
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class FileIndex(Base):
    """파일 검색 색인.

    기존 검색은 질의마다 os.walk 로 트리를 순회하며 파일명 부분 일치만 확인했다.
    현재 폴더 하위만, 이름만, 랭킹 없이 검색했다. 본 색인이 이를 대체한다.

    - scope: 권한 경계. 사용자 id 또는 'shared'. 질의 시 이 값으로 먼저 필터링한다.
    - rel_path: scope 루트 기준 상대경로. 폴더 한정 검색을 prefix 로 처리한다.
    - content: 추출한 본문(상한 있음). 한글은 형태소 분석기 없이는 FTS 가
      정상 동작하지 않으므로, tsvector 대신 **pg_trgm** 으로 부분 일치를 처리한다.
      따라서 여기에는 tsvector 컬럼이 없다.

    trigram GIN 인덱스는 세션 초기화(db/session.py)에서 생성한다 — SQLAlchemy
    모델만으로는 연산자 클래스(gin_trgm_ops)를 지정할 수 없다.
    """
    __tablename__ = "file_index"
    __table_args__ = (
        Index("ix_file_index_unique", "scope", "rel_path", unique=True),
        Index("ix_file_index_scope_dir", "scope", "parent_dir"),
        Index("ix_file_index_mtime", "mtime"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    scope: Mapped[str] = mapped_column(String(64))           # 사용자 id 또는 'shared'
    rel_path: Mapped[str] = mapped_column(String(1024))      # scope 루트 기준 상대경로
    parent_dir: Mapped[str] = mapped_column(String(1024), default="")  # rel_path 의 상위 폴더
    name: Mapped[str] = mapped_column(String(512))
    ext: Mapped[str] = mapped_column(String(32), default="")
    is_dir: Mapped[bool] = mapped_column(Boolean, default=False)
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    mtime: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    mime: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # 추출 본문. 없으면 이름만으로 검색된다.
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 재추출 여부 판단용 — (size, mtime) 이 동일하면 건너뛴다.
    stamp: Mapped[str] = mapped_column(String(64), default="")
    indexed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


# ════════════════════════════════════════════════════════════════
# 사람·설정·회의 백엔드 — 이 브랜치에서 신규 생성한 테이블은 여기에 모은다.
# (다른 브랜치와의 models.py 충돌을 줄이기 위해 파일 끝의 한 블록에 둔다)
# ════════════════════════════════════════════════════════════════


class MeetingDB(Base):
    """예약 회의 저장소.

    LiveKit 방은 비어 있으면 5분 후 삭제되고 Redis 메타는 24시간 후 삭제된다. 이로 인해 다음 날 회의를
    당일에 예약하면 링크가 무효화되었다. 회의 자체(제목·시각·비밀번호 해시·대기실·공유 토큰)는 여기에
    저장하고, Redis 메타가 없으면 이 행으로 복원한다(app/meetings/store.py).

    status: scheduled(예정) | live(참가자 접속 중) | ended(종료) | cancelled(시작 전 취소)
    """

    __tablename__ = "meetings"
    __table_args__ = (
        Index("ix_meetings_room_name", "room_name"),
        Index("ix_meetings_host", "host_user_id"),
        Index("ix_meetings_share_token", "share_token", unique=True),
        Index("ix_meetings_scheduled_at", "scheduled_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    room_name: Mapped[str] = mapped_column(String(200))          # LiveKit 방 이름(= 기존 API 의 name)
    title: Mapped[str] = mapped_column(String(255), default="")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    host_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE")
    )
    host_display_name: Mapped[str] = mapped_column(String(255), default="")
    share_token: Mapped[str] = mapped_column(String(64))
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    waiting_room: Mapped[bool] = mapped_column(Boolean, default=True)
    max_participants: Mapped[int] = mapped_column(Integer, default=10)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="scheduled")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 호스트 캘린더에 생성한 일정 id — 시각 변경·취소 시 함께 수정한다
    host_calendar_event_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 호스트가 "지난 회의" 목록에서 삭제한 시각 — 목록에서만 제외한다(녹화 권한 판단·기록은 유지)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 채널에 연결된 회의 — 채널 탭 "회의"·회의 종료 화면 "#채널에 남아 있습니다". auto-migrate 가 컬럼 추가
    chat_channel_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class MeetingInvitee(Base):
    """회의 초대 대상과 참석 응답. 내부 사용자는 user_id, 외부 참석자는 email 만 보유한다.

    response: pending | accepted | declined | tentative
    """

    __tablename__ = "meeting_invitees"
    __table_args__ = (
        Index("ix_meeting_invitees_meeting", "meeting_id"),
        Index("ix_meeting_invitees_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE")
    )
    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    display_name: Mapped[str] = mapped_column(String(255), default="")
    response: Mapped[str] = mapped_column(String(16), default="pending")
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class MeetingRecording(Base):
    """회의 녹화 파일 ↔ 회의. 목록·다운로드 권한(호스트·초대 대상·채널 멤버) 판정에 사용한다."""

    __tablename__ = "meeting_recordings"
    __table_args__ = (
        Index("ix_meeting_recordings_filename", "filename", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    filename: Mapped[str] = mapped_column(String(255))
    room_name: Mapped[str] = mapped_column(String(200), default="")
    meeting_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    host_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    chat_channel_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class UserPref(Base):
    """개인 설정(서버 저장) — 사용자당 JSON 한 행.

    밀도·테마·언어·시간대·주 시작·탭바 고정 탭·메일 어둡게 보기·읽음 확인 기본값 등의 화면 설정을
    기기 간에 공유하기 위해 저장한다. 키 규칙·크기 제한은 app/me/prefs.py. 방해 금지 일정
    (notify.dnd_schedule)과 시작 체크리스트 닫음(dashboard.checklist_dismissed_at)도 여기에 포함된다.
    """

    __tablename__ = "user_prefs"

    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    data: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class UserInvite(Base):
    """관리자 초대 링크. 토큰 원문은 저장하지 않는다(sha256 만 저장). 사용되면 used_at·used_by 를 기록한다.

    초대 링크로 가입하면 가입 방식(승인제·닫힘)과 무관하게 즉시 승인된다(app/auth/router.py register).
    """

    __tablename__ = "user_invites"
    __table_args__ = (
        Index("ix_user_invites_token", "token_hash", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    token_hash: Mapped[str] = mapped_column(String(64))
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    group_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    invited_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    used_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


# ════════════════════════════════════════════════════════════════════
# 콘텐츠 모듈 보강(캘린더·메일·연락처·파일·게시판·채팅·위키)
# 다른 작업과의 충돌을 줄이기 위해 신규 클래스는 이 블록에 모은다.
# ════════════════════════════════════════════════════════════════════


class CalendarEventAttendee(Base):
    """일정 참석자. 이메일 기준(워크스페이스 사용자이면 user_id 도 지정한다)."""
    __tablename__ = "calendar_event_attendees"
    __table_args__ = (
        Index("ix_cal_attendees_event_email", "event_id", "email", unique=True),
        Index("ix_cal_attendees_email", "email"),
        Index("ix_cal_attendees_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    event_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("calendar_events.id", ondelete="CASCADE")
    )
    email: Mapped[str] = mapped_column(String(255))  # 소문자로 저장
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # needs-action | accepted | declined | tentative
    response: Mapped[str] = mapped_column(String(20), default="needs-action")
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class MailScheduledSend(Base):
    """예약 발송 대기열. 백그라운드 루프(app/mail/scheduled.py)가 send_at 경과 시 발송한다.

    payload: 발송 내용(JSON — to/cc/bcc/subject/text_body/html_body/in_reply_to/references…).
    첨부는 예약 시점에 디스크(storage_root/mail_scheduled/<id>/)로 이동해 둔다
    (작성기 업로드는 30분 TTL 임시 파일이므로 그대로 두면 삭제된다).
    """
    __tablename__ = "mail_scheduled_sends"
    __table_args__ = (
        Index("ix_mail_scheduled_due", "status", "send_at"),
        Index("ix_mail_scheduled_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    account_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    subject: Mapped[str | None] = mapped_column(String(500), nullable=True)
    payload: Mapped[str] = mapped_column(Text)
    send_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # pending | sending | sent | failed | cancelled
    status: Mapped[str] = mapped_column(String(16), default="pending")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FileStar(Base):
    """파일 즐겨찾기. path 는 해당 사용자 기준 가상경로(my/.., shared/..)."""
    __tablename__ = "file_stars"
    __table_args__ = (
        Index("ix_file_stars_user_path", "user_id", "path", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    path: Mapped[str] = mapped_column(String(1024))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class FileRecent(Base):
    """최근 연 파일(열람 기록). 사용자·경로당 한 행, 열 때마다 accessed_at 갱신.

    path: 가상경로. 공유받은 항목은 'shared-with-me/<share_id>[/<하위경로>]'.
    """
    __tablename__ = "file_recents"
    __table_args__ = (
        Index("ix_file_recents_user_path", "user_id", "path", unique=True),
        Index("ix_file_recents_user_time", "user_id", "accessed_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    path: Mapped[str] = mapped_column(String(1024))
    name: Mapped[str] = mapped_column(String(512))
    accessed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class FileActivity(Base):
    """파일별 활동 기록(업로드·편집·이름 변경·이동·복사·삭제·복원·공유·열람).

    path_key: 소유자 기준 정규 경로 — 'users/<소유자id>/<상대경로>' 또는 'shared/<상대경로>'.
    수신자가 공유를 통해 열어도 동일한 키이므로 한 파일의 기록이 한곳에 집계된다.
    """
    __tablename__ = "file_activities"
    __table_args__ = (
        Index("ix_file_activities_path_time", "path_key", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    path_key: Mapped[str] = mapped_column(String(1024))
    user_id: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 손님 편집이면 guest-xxxx
    actor_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    action: Mapped[str] = mapped_column(String(32))
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class BoardReadMark(Base):
    """게시판 "모두 읽음" 표시 — 이 시각 이전 글은 읽은 것으로 간주한다(사용자·게시판당 한 행)."""
    __tablename__ = "board_read_marks"
    __table_args__ = (
        Index("ix_board_read_marks_user_board", "user_id", "board_id", unique=True),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    board_id: Mapped[str] = mapped_column(String(36), ForeignKey("boards.id", ondelete="CASCADE"))
    read_before: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# ─── chat22 — 커스텀 이모지(디스코드 서버 이모지와 동일한 역할, 워크스페이스 1개 단위) ───


class ChatEmoji(Base):
    """커스텀 이모지 1개. 이미지는 DB 에 저장한다(≤256KB · 상한 200개 → 최대 약 50MB) — 워커 8개·볼륨 공유와 무관.

    리액션·본문에서는 `:name:` 문자열로 사용한다(reactions.emoji). 이름을 변경하면 기존 `:옛이름:` 리액션은 문자열로 남는다.
    """

    __tablename__ = "chat_emojis"
    __table_args__ = (Index("ix_chat_emojis_name", "name", unique=True),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(32))
    content_type: Mapped[str] = mapped_column(String(32))
    data: Mapped[bytes] = mapped_column(LargeBinary)
    animated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class McpWriteRequest(Base):
    """AI 쓰기 요청 — MCP(claude.ai 등)·내장 AI 공통.

    쓰기 도구를 호출하면 즉시 실행하지 않고 여기에 한 행을 생성한다.
      - low  : 내장 AI 는 채팅 카드에서 [실행]해야 하며(5분), claude.ai 는 자체 승인 후 즉시 실행한다.
      - high : 어느 경우든 승인 대기함에서 사용자가 승인해야(30분) 서버가 실행한다.
    실행 결과·롤백 역연산·거부 사유를 함께 기록하여 감사 기록으로 사용한다.
    인덱스는 컬럼 index=True 로만 선언한다(Index() 중복 선언 금지 — mcp_personal_tokens 사례).
    """

    __tablename__ = "mcp_write_requests"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)          # wr_xxxxxxxx
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    tool: Mapped[str] = mapped_column(String(64))
    args: Mapped[str] = mapped_column(Text, default="{}")                   # JSON
    risk: Mapped[str] = mapped_column(String(8))                            # low | high
    # pending → executed | failed | rejected | canceled | expired ; executed → undone
    status: Mapped[str] = mapped_column(String(16), index=True)
    source: Mapped[str] = mapped_column(String(16))                         # mcp | ai
    # claude_app | personal_token | builtin_web | builtin_desktop | internal
    client_kind: Mapped[str | None] = mapped_column(String(24), nullable=True)
    client_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 요청을 생성한 연결(MCP=OAuth client_id 또는 "pat:<토큰 id>") — 연결 해제 시 대기 요청을 '연결 해제됨'으로 거부
    client_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    after_untrusted: Mapped[bool] = mapped_column(Boolean, default=False)
    untrusted_hint: Mapped[str | None] = mapped_column(Text, nullable=True)   # JSON {kind,at,from,subject,label}
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    result: Mapped[str | None] = mapped_column(Text, nullable=True)         # JSON
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    undo: Mapped[str | None] = mapped_column(Text, nullable=True)           # JSON {"tool","args"}
    reject_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    undo_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
