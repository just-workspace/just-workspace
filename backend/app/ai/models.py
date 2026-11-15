"""빌트인 AI 채팅 — 대화/메시지 모델 (Phase C)."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models import Base


class AIConversation(Base):
    __tablename__ = "ai_conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    title: Mapped[str] = mapped_column(String(200), default="새 대화")
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    tools_enabled: Mapped[bool] = mapped_column(default=False)
    # S6b — 임시 대화(기록·메모리·프로젝트 지식 안 씀, 나가면 삭제 + 24시간 지나면 서버가 정리).
    # 기존 행은 NULL(= 일반 대화). 자동 마이그레이션이 nullable 로 추가한다.
    temporary: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # S6b — 프로젝트에 묶인 대화(ai_projects.id). FK 는 걸지 않는다(프로젝트를 지워도 대화는 남고 묶음만 풀린다).
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class AIMessage(Base):
    __tablename__ = "ai_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("ai_conversations.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    role: Mapped[str] = mapped_column(String(16))  # user | assistant
    content: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    # S6a — 답변 메타. 기존 행은 NULL(자동 마이그레이션이 nullable 로 추가)이라 읽을 때 기본값으로 본다.
    # model: 답한 모델 이름(AI 생성 표시). status: streaming|complete|interrupted|stopped (NULL = complete).
    # meta: JSON {steps:[...], citations:[...], started_at, ended_at} — 진행 단계·출처.
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    meta: Mapped[str | None] = mapped_column(Text, nullable=True)
    # S6b — 질문 수정 → 답변 버전(가지). parent_id = 같은 가지에서 바로 앞 메시지 id, 대화 첫 메시지는 대화 id.
    # NULL = S6b 이전 행(읽을 때 created_at 순서로 한 줄 가지로 채운다 — app.ai.branches.backfill).
    # inactive = 같은 부모를 둔 형제(같은 질문의 다른 버전) 가운데 지금 안 보이는 쪽. NULL/False = 보이는 쪽.
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    inactive: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class AIMessageFeedback(Base):
    """답변 👍/👎 (S6a). 기본은 평가·이유·한 줄 의견만 — 대화 내용은 사용자가 켰을 때만(conversation_snapshot).

    메시지를 지워도(다시 생성·대화 삭제·보관 기간) 통계가 남도록 FK 를 걸지 않는다.
    대화를 지우면 그 대화의 스냅샷은 비운다(router._clear_feedback_snapshots).
    """

    __tablename__ = "ai_message_feedback"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    message_id: Mapped[str] = mapped_column(String(36), index=True)
    conversation_id: Mapped[str] = mapped_column(String(36), index=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    rating: Mapped[str] = mapped_column(String(8))  # up | down
    reasons: Mapped[str] = mapped_column(Text, default="[]")  # JSON 배열(이유 키)
    comment: Mapped[str] = mapped_column(Text, default="")
    conversation_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON — include_conversation=true 일 때만
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 첨부 스냅샷이 사라진 까닭(관리자 화면 시안 I2) — NULL = 첨부 안 함(또는 지금 첨부 있음).
    # conversation_deleted(사용자가 대화를 지움) · expired(90일 지나 정리) · admin_deleted(관리자가 지움).
    # 자동 마이그레이션이 nullable 로 추가한다.
    snapshot_state: Mapped[str | None] = mapped_column(String(24), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc), index=True,
    )


class AIProject(Base):
    """S6b 프로젝트 — 지침 + 지식 파일(워크스페이스 파일 경로 참조) + 대화 묶음.

    share_group_id 가 있으면 그 그룹 구성원이 **읽기 전용**으로 쓴다(대화 만들기·지식 사용). 고치기는 주인만.
    """

    __tablename__ = "ai_projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(120))
    instructions: Mapped[str] = mapped_column(Text, default="")
    share_group_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class AIProjectFile(Base):
    """프로젝트 지식 파일 — 파일 바이트는 복사하지 않고 가상 경로(my/… · shared/…)만 둔다.
    읽을 때마다 **지금 대화하는 사람의 권한**으로 연다(못 읽으면 건너뜀)."""

    __tablename__ = "ai_project_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("ai_projects.id", ondelete="CASCADE"), index=True)
    # 저장 영역 주인 기준 경로: 개인 파일은 'my/…'(storage_owner_id 의 영역), 팀 폴더는 'shared/…'(storage_owner_id NULL).
    # 공유받은 파일(shared-with-me/…)은 추가할 때 원 소유자 기준 'my/…' 로 바꿔 둔다.
    path: Mapped[str] = mapped_column(String(1024))
    storage_owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    added_by: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class AIProjectShare(Base):
    """프로젝트 공유 대상 그룹(여러 개). 구성원은 읽기 전용. 옛 ai_projects.share_group_id 도 계속 읽는다(합집합)."""

    __tablename__ = "ai_project_shares"
    __table_args__ = (UniqueConstraint("project_id", "group_id", name="uq_ai_project_share"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("ai_projects.id", ondelete="CASCADE"), index=True)
    group_id: Mapped[str] = mapped_column(String(36), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class AIMemory(Base):
    """S6b 메모리 — 사용자별. kind: preference|work|person. 비밀번호·토큰·주민번호·카드번호는 저장 거부(app.ai.memory)."""

    __tablename__ = "ai_memories"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)
    # 출처 대화(직접 추가면 NULL). 대화를 지워도 메모리는 남는다(링크만 끊김).
    source_conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class AIAttachment(Base):
    """S6b 대화 첨부 — 메타데이터만. 파일 바이트는 임시 디렉터리(app.ai.attachments.ATTACH_DIR)에 7일(원본 미리보기·
    내려받기용), 문서는 뽑은 글자(extracted_text, 상한 있음)를 행에 둔다(모델 맥락은 글자만 쓴다).
    올리고 보내지 않은 첨부는 24시간 뒤, 바이트는 7일 뒤 정리한다."""

    __tablename__ = "ai_attachments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    message_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(120), default="application/octet-stream")
    size: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(16))  # document | image
    extracted_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON — docread meta(쪽·시트·note)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
