"""Admin settings helpers — DB-backed key-value store + shared SMTP utility."""

import logging
import smtplib
import ssl as _ssl
from dataclasses import dataclass
from email.message import Message

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import SystemSetting

logger = logging.getLogger(__name__)


# ── DB key-value helpers ─────────────────────────────────────


async def get_setting(db: AsyncSession, key: str) -> str | None:
    result = await db.execute(select(SystemSetting.value).where(SystemSetting.key == key))
    return result.scalar_one_or_none()


async def set_setting(db: AsyncSession, key: str, value: str) -> None:
    existing = await db.get(SystemSetting, key)
    if existing:
        existing.value = value
    else:
        db.add(SystemSetting(key=key, value=value))
    await db.commit()


async def delete_setting(db: AsyncSession, key: str) -> None:
    await db.execute(delete(SystemSetting).where(SystemSetting.key == key))
    await db.commit()


async def get_settings_by_prefix(db: AsyncSession, prefix: str) -> dict[str, str]:
    result = await db.execute(
        select(SystemSetting.key, SystemSetting.value).where(
            SystemSetting.key.startswith(prefix)
        )
    )
    return {row[0]: row[1] for row in result.all()}


async def builtin_mailserver_enabled(db: AsyncSession) -> bool:
    """내장 메일서버를 쓰는가 — DB(feature.builtin_mailserver, 관리 › 메일의 웹 토글) 우선, env 폴백.

    메일 화면(app/mail/router.py)은 DB 값을 보는데 계정 경로(승인 시 사서함 생성·비밀번호 동기화)는
    env 만 봐서, 웹에서 "내장"으로 바꿔도 새 사용자 사서함이 안 생겼다(수신 550). 한 규칙으로 맞춘다.
    """
    from app.setup import config_store

    return await config_store.get_bool(
        db, "feature.builtin_mailserver", bool(getattr(get_settings(), "feature_builtin_mailserver", False))
    )


# ── SMTP utility ─────────────────────────────────────────────


@dataclass
class SmtpConfig:
    host: str
    port: int
    security: str  # "starttls" | "ssl" | "none"
    user: str
    password: str
    from_addr: str


async def get_smtp_config(db: AsyncSession) -> SmtpConfig:
    """Build SmtpConfig from DB settings, falling back to .env values."""
    settings = get_settings()
    db_vals = await get_settings_by_prefix(db, "smtp.")

    host = db_vals.get("smtp.host") or settings.smtp_host
    port_str = db_vals.get("smtp.port") or str(settings.smtp_port)
    security = db_vals.get("smtp.security") or "starttls"
    user = db_vals.get("smtp.user") or settings.smtp_user
    password = db_vals.get("smtp.password") or settings.smtp_password
    from_addr = db_vals.get("smtp.from") or settings.smtp_from

    return SmtpConfig(
        host=host,
        port=int(port_str),
        security=security,
        user=user,
        password=password,
        from_addr=from_addr,
    )


def send_system_email(config: SmtpConfig, msg: Message) -> None:
    """Send an email using the given SmtpConfig (blocking — call via asyncio.to_thread)."""
    if config.security == "ssl":
        context = _ssl.create_default_context()
        with smtplib.SMTP_SSL(config.host, config.port, context=context) as smtp:
            smtp.login(config.user, config.password)
            smtp.send_message(msg)
    elif config.security == "starttls":
        with smtplib.SMTP(config.host, config.port) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            smtp.login(config.user, config.password)
            smtp.send_message(msg)
    else:
        # plain / no encryption
        with smtplib.SMTP(config.host, config.port) as smtp:
            smtp.ehlo()
            if config.user and config.password:
                smtp.login(config.user, config.password)
            smtp.send_message(msg)
