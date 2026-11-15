"""백업 레코드 모델."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models import Base


class BackupRecord(Base):
    __tablename__ = "backup_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    status: Mapped[str] = mapped_column(String(16), default="running")   # running|success|partial|failed
    kind: Mapped[str] = mapped_column(String(16), default="manual")      # manual|scheduled
    components: Mapped[str] = mapped_column(Text, default="{}")          # {"postgres":"ok","storage":"ok",...}
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    path: Mapped[str] = mapped_column(String(512), default="")           # /backups/<ts>
    error: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(36), default="")
