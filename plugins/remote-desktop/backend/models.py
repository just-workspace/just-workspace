"""원격 데스크톱 플러그인 모델 — 기기 · 세션 · 감사(플러그인 전용 Base, 테이블 접두사 plugin_remote_).

세션 상태의 기준은 DB 이다(uvicorn 워커 여러 개가 동일 테이블을 조회한다). 비밀값(호스트 비밀, 접속 코드)은
해시만 저장한다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class PluginBase(DeclarativeBase):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class RemoteDevice(PluginBase):
    """원격 접속을 수신할 수 있는 사용자 PC(데스크톱 앱 설치본) 1대."""

    __tablename__ = "plugin_remote_devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(100))
    platform: Mapped[str] = mapped_column(String(32), default="")
    #: 사람이 읽는 OS 이름(앱이 전송) — 예: "Windows 11", "Windows Server 2022"
    os_name: Mapped[str] = mapped_column(String(64), default="")
    #: 소유자가 앱에서 활성화한 "원격 접속 허용" — 비활성 상태면 접속 요청 자체를 수신하지 않음
    allow_remote: Mapped[bool] = mapped_column(Boolean, default=False)
    #: 무인 접속 — 소유자 본인이 요청하면 동의 창 없이 연결(앱의 동일 이름 설정도 활성화 필요)
    unattended: Mapped[bool] = mapped_column(Boolean, default=False)
    #: 호스트 비밀(앱만 보유)의 SHA-256. 롱폴링·동의 API 인증
    host_secret_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RemoteSession(PluginBase):
    """접속 한 번. kind=device(내 기기) | support(1회성 지원)."""

    __tablename__ = "plugin_remote_sessions"
    __table_args__ = (
        Index("ix_plugin_remote_sessions_code", "code_hash"),
        Index("ix_plugin_remote_sessions_device_status", "device_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(16))
    device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    #: 1회성 지원: 접속 코드의 HMAC(서버 비밀 키) — 원문은 저장하지 않는다
    code_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: 1회성 지원: 포터블 프로그램이 보유한 비밀의 SHA-256(익명 호스트 인증)
    host_secret_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: 지원자(회원) — 코드 입력 전에는 미지정
    requester_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    requester_name: Mapped[str] = mapped_column(String(200), default="")
    #: 동의 창에 표시되는 요청자 이메일(사칭 판별용)
    requester_email: Mapped[str] = mapped_column(String(255), default="")
    #: waiting_code → pending → active → ended | denied | expired
    status: Mapped[str] = mapped_column(String(16), index=True)
    room: Mapped[str | None] = mapped_column(String(64), nullable=True)
    code_attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    #: 현재 상태의 만료 시각(코드 5분, 동의 대기 30초). active 에서는 호스트 하트비트 만료 시각
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_reason: Mapped[str] = mapped_column(String(32), default="")
    #: LiveKit 토큰 발급 횟수(감사·남용 탐지)
    tokens_issued: Mapped[int] = mapped_column(Integer, default=0)


class RemoteAudit(PluginBase):
    """모든 단계의 기록 — 행위자(회원/호스트/지원 프로그램/시스템)·행위·시각·위치."""

    __tablename__ = "plugin_remote_audit"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    action: Mapped[str] = mapped_column(String(40))
    session_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    actor_kind: Mapped[str] = mapped_column(String(16))   # user | host | support | system
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    ip: Mapped[str] = mapped_column(String(64), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
