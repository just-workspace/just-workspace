"""결과물 — AI 가 생성한 파일·묶음 작업. 신규 테이블이므로 create_all 이 생성한다.

파일 바이트는 임시 디렉터리(app.ai.artifacts.ARTIFACT_DIR)에 저장하고 24시간 후 삭제한다. 행(입력 spec 포함)은
[다시 만들기]를 위해 30일간 보존한다. FK 는 설정하지 않는다 — 대화를 삭제해도 내려받기·내 파일 저장 기록은 독립적으로 유지된다.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models import Base


def _now():
    return datetime.now(timezone.utc)


class AIArtifact(Base):
    __tablename__ = "ai_artifacts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # 묶음 작업에서 생성된 파일이면 작업 id·순번(zip 자체는 item_index NULL)
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    item_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    format: Mapped[str] = mapped_column(String(8))          # docx|xlsx|pptx|pdf|zip
    name: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(120), default="application/octet-stream")
    size: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="ready")   # ready | failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    spec: Mapped[str | None] = mapped_column(Text, nullable=True)      # JSON — docgen.normalize 결과(재생성용)
    info: Mapped[str | None] = mapped_column(Text, nullable=True)      # JSON {pages|sheets|slides|files}
    saved_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)   # 내 파일에 저장된 가상 경로
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AIArtifactJob(Base):
    """복수 파일 묶음(문서 묶음·파일 압축) — 서버 작업(화면 이탈 후에도 계속 수행). 완료 시 zip 을 생성하고 실시간 이벤트·알림을 발송한다."""

    __tablename__ = "ai_artifact_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(255))          # zip 이름
    # docs = AI 가 생성한 문서 묶음 / files_zip = 내 파일·검색 결과 압축(항목 = 원본 파일)
    kind: Mapped[str] = mapped_column(String(16), default="docs")
    meta: Mapped[str | None] = mapped_column(Text, nullable=True)   # JSON — files_zip 입력(paths·query)·제외 건수 등
    status: Mapped[str] = mapped_column(String(16), default="running")   # running|done|partial|failed
    total: Mapped[int] = mapped_column(Integer, default=0)
    items: Mapped[str] = mapped_column(Text, default="[]")  # JSON [{index,name,format,status,artifact_id,size,error}]
    specs: Mapped[str] = mapped_column(Text, default="[]")  # JSON — 항목별 정규화된 입력([이것만 다시])
    zip_artifact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    saved_folder: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
