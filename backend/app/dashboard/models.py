"""대시보드 AI 브리핑("오늘의 포커스") 하루 캐시 — 사용자·날짜당 한 행(새 테이블, create_all 이 만든다)."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models import Base


class DashBriefing(Base):
    __tablename__ = "dash_briefings"
    # 인덱스는 여기 한 번만(컬럼 index=True 와 겹치면 create_all 이 같은 이름 인덱스 두 번으로 깨진다)
    __table_args__ = (Index("ix_dash_briefings_user_day", "user_id", "day", unique=True),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36))
    # 사용자 "오늘"(캘린더 시간대) YYYY-MM-DD
    day: Mapped[str] = mapped_column(String(10))
    # generating | ready | failed
    status: Mapped[str] = mapped_column(String(16), default="generating")
    # [{"text": str, "sources": [{"label": str, "to": str}]}] JSON
    items: Mapped[str] = mapped_column(Text, default="[]")
    # 회의 준비 — 지난 회의/관련 대화 요약 한 줄(없으면 NULL)
    prep_line: Mapped[str | None] = mapped_column(Text, nullable=True)
    prep_event_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 회의 준비 — 생성 때 센, 회의 제목이 들어간 안 읽은 메일 수
    prep_mail: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 이날 "다시 만들기" 횟수(첫 생성은 세지 않는다)
    regen_count: Mapped[int] = mapped_column(Integer, default=0)
    # helpful | not | NULL
    feedback: Mapped[str | None] = mapped_column(String(8), nullable=True)
    feedback_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
