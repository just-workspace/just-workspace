"""격리 브라우저 모델 — 대상(관리자가 등록) · 세션(사용자가 띄운 컨테이너 1개).

세션 상태는 DB 가 권위다(uvicorn 워커 8개가 같은 표를 본다). 컨테이너 자체는 docker.sock 으로
다루고, 끝난 세션의 컨테이너는 지운다(세션 사이에 남는 것은 이 행과 감사 로그뿐).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RbiTarget(Base):
    """격리 브라우저로만 열 수 있는 내부 자산 하나."""

    __tablename__ = "rbi_targets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    #: 경로·컨테이너 이름에 쓰는 짧은 식별자(소문자·숫자·-), 고유
    key: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    #: 브라우저가 처음 여는 주소. http(s)://IP[:port][/path]
    url: Mapped[str] = mapped_column(String(500))
    #: Chrome URLAllowlist 에 넣는 호스트 목록(JSON 배열). 비우면 url 의 호스트 하나
    allowed_hosts: Mapped[str] = mapped_column(Text, default="[]")
    #: netfilter 가 허용하는 목적지(IP) — 규칙은 호스트 사이드카가 .env 로 받으므로 여기는 표시·검증용
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    #: 화면 방식 — pixel(KasmVNC 픽셀 스트림) | mirror(DOM 미러: 닫힌 어휘 + 픽셀 인셋). 비면(옛 행) pixel.
    #: mirror 대상에서도 사용자는 세션마다 pixel 로 바꿔 열 수 있다(폴백). pixel 대상은 mirror 로 열 수 없다.
    mode: Mapped[str | None] = mapped_column(String(8), nullable=True, default="pixel")

    # ── 정책 ──
    clipboard_to_browser: Mapped[bool] = mapped_column(Boolean, default=True)   # 내 PC → 격리 브라우저(AcceptCutText)
    clipboard_from_browser: Mapped[bool] = mapped_column(Boolean, default=True)  # 격리 브라우저 → 내 PC(SendCutText)
    downloads: Mapped[bool] = mapped_column(Boolean, default=False)
    uploads: Mapped[bool] = mapped_column(Boolean, default=False)
    idle_minutes: Mapped[int] = mapped_column(Integer, default=15)
    max_hours: Mapped[int] = mapped_column(Integer, default=8)
    cpu: Mapped[float] = mapped_column(Float, default=2.0)
    memory_mb: Mapped[int] = mapped_column(Integer, default=2048)
    #: 80·443 말고 열 포트(JSON 배열) — 관리자가 명시한 것만(app/rbi/egress.py)
    extra_ports: Mapped[str | None] = mapped_column(Text, nullable=True, default="[]")
    #: 저장할 때 검증·이름 풀이로 고정한 출구 [{"host","ip","port","forced"}](JSON). netfilter 허용 목록은 켜진 대상의 이것을 모은다
    egress: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 워크스페이스 자신의 주소를 강제로 연 대상(경고 표시·감사)
    egress_forced: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=False)

    # ── 접근 권한(비우면 관리자만) ──
    allowed_group_ids: Mapped[str] = mapped_column(Text, default="[]")  # JSON 배열
    allowed_user_ids: Mapped[str] = mapped_column(Text, default="[]")   # JSON 배열

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class RbiSession(Base):
    """사용자 한 명이 띄운 격리 브라우저 컨테이너 하나.

    id 는 32자리 16진수 난수 — 스트림 경로(/rbi/<id>/)의 비밀값이기도 하다(추측 불가).
    """

    __tablename__ = "rbi_sessions"
    __table_args__ = (
        Index("ix_rbi_sessions_user_id", "user_id"),
        Index("ix_rbi_sessions_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36))
    target_id: Mapped[str] = mapped_column(String(36))
    target_key: Mapped[str] = mapped_column(String(32))
    #: starting | running | ended | error
    status: Mapped[str] = mapped_column(String(16), default="starting")
    container_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    container_name: Mapped[str] = mapped_column(String(64))
    #: 이 세션의 화면 방식(pixel | mirror). 비면(옛 행) pixel
    mode: Mapped[str | None] = mapped_column(String(8), nullable=True, default="pixel")
    #: ws-nginx 가 proxy_pass 하는 주소 "IP:port"(workspace 브리지 게이트웨이에 게시된 포트)
    upstream: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: 세션 컨테이너의 basic auth 비밀번호(KasmVNC 또는 mirror-agent) — Fernet(SECRET_KEY) 암호문. 사용자에게는 절대 주지 않는다
    vnc_password_enc: Mapped[str] = mapped_column(Text)
    idle_minutes: Mapped[int] = mapped_column(Integer, default=15)
    max_hours: Mapped[int] = mapped_column(Integer, default=8)
    client_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    #: 스트림 인증(auth_request)·화면 핑이 마지막으로 닿은 시각 — 유휴 판정 보조
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: user | idle | max_lifetime | container_exited | admin | error | mode_switch
    end_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
