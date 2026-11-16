"""LDAP / Active Directory 인증 클라이언트.

로컬 인증 실패 시 폴백으로 사용(설정에서 enabled일 때만). ldap3는 동기 라이브러리라
executor에서 실행. bind 계정으로 사용자 검색 → 사용자 DN으로 재bind하여 비밀번호 검증.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from app.db.models import SystemSetting
from app.mail.crypto import decrypt_password, encrypt_password

logger = logging.getLogger(__name__)


async def _get(db, key: str, default: str = "") -> str:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    return s.value if s and s.value is not None else default


async def _set(db, key: str, value: str) -> None:
    r = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    s = r.scalar_one_or_none()
    if s:
        s.value = value
    else:
        db.add(SystemSetting(key=key, value=value))


async def get_config(db, *, reveal: bool = False) -> dict:
    enc = await _get(db, "auth.ldap.bind_password")
    pw = ""
    if enc:
        try:
            pw = decrypt_password(enc)
        except Exception:
            pw = ""
    return {
        "enabled": (await _get(db, "auth.ldap.enabled", "false")) == "true",
        "host": await _get(db, "auth.ldap.host"),
        "port": int(await _get(db, "auth.ldap.port", "389") or 389),
        "use_ssl": (await _get(db, "auth.ldap.use_ssl", "false")) == "true",
        "bind_dn": await _get(db, "auth.ldap.bind_dn"),
        "bind_password": pw if reveal else ("***" if pw else ""),
        "has_bind_password": bool(pw),
        "base_dn": await _get(db, "auth.ldap.base_dn"),
        "user_filter": await _get(db, "auth.ldap.user_filter", "(sAMAccountName={username})"),
        "attr_email": await _get(db, "auth.ldap.attr_email", "mail"),
        "attr_name": await _get(db, "auth.ldap.attr_name", "displayName"),
        "auto_provision": (await _get(db, "auth.ldap.auto_provision", "true")) == "true",
    }


async def set_config(db, body: dict) -> None:
    m = {
        "enabled": lambda v: "true" if v else "false",
        "host": str, "port": lambda v: str(int(v)),
        "use_ssl": lambda v: "true" if v else "false",
        "bind_dn": str, "base_dn": str, "user_filter": str,
        "attr_email": str, "attr_name": str,
        "auto_provision": lambda v: "true" if v else "false",
    }
    for k, conv in m.items():
        if body.get(k) is not None:
            await _set(db, f"auth.ldap.{k}", conv(body[k]))
    if body.get("bind_password"):
        await _set(db, "auth.ldap.bind_password", encrypt_password(body["bind_password"]))
    await db.commit()


async def is_enabled(db) -> bool:
    return (await _get(db, "auth.ldap.enabled", "false")) == "true"


async def auto_provision(db) -> bool:
    return (await _get(db, "auth.ldap.auto_provision", "true")) == "true"


class LdapUnavailable(Exception):
    """디렉터리 조회 불가(연결·서비스 계정·설정 문제) — "비밀번호가 틀렸다"와 구분된다."""


def _authenticate_sync(cfg: dict, username: str, password: str, strict: bool = False) -> dict | None:
    """동기 LDAP 인증. 성공 시 {email, name, dn} 반환, 실패 시 None.

    strict=True 이면 디렉터리 장애를 None(=틀림)으로 처리하지 않고 LdapUnavailable 예외를 발생시킨다 —
    본인 확인 실패 횟수를 집계하는 호출자(복구 이메일 변경)가 장애를 "틀림"으로 집계하지 않도록 하기 위함이다."""
    from ldap3 import Server, Connection, ALL, SUBTREE
    from ldap3.utils.conv import escape_filter_chars

    if not password:  # 익명 bind 방지
        return None
    try:
        server = Server(cfg["host"], port=cfg["port"], use_ssl=cfg["use_ssl"], get_info=ALL, connect_timeout=10)
        # 서비스 계정으로 bind(없으면 익명 검색 시도)
        if cfg["bind_dn"]:
            conn = Connection(server, user=cfg["bind_dn"], password=cfg["bind_password"], auto_bind=True, receive_timeout=10)
        else:
            conn = Connection(server, auto_bind=True, receive_timeout=10)
        flt = cfg["user_filter"].replace("{username}", escape_filter_chars(username))
        conn.search(cfg["base_dn"], flt, search_scope=SUBTREE,
                    attributes=[cfg["attr_email"], cfg["attr_name"]])
        if not conn.entries:
            conn.unbind()
            return None
        entry = conn.entries[0]
        dn = entry.entry_dn

        def _attr(name):
            try:
                v = entry[name].value
                return v[0] if isinstance(v, list) and v else v
            except Exception:
                return None

        email = _attr(cfg["attr_email"])
        name = _attr(cfg["attr_name"])
        conn.unbind()
        # 사용자 DN으로 재bind = 비밀번호 검증
        user_conn = Connection(server, user=dn, password=password, receive_timeout=10)
        if not user_conn.bind():
            return None
        user_conn.unbind()
        return {"dn": dn, "email": email, "name": name}
    except Exception as e:
        logger.warning("[ldap] auth error for %s: %s", username, e)
        if strict:
            raise LdapUnavailable(str(e)) from e
        return None


async def authenticate(db, username: str, password: str) -> dict | None:
    cfg = await get_config(db, reveal=True)
    if not cfg["enabled"] or not cfg["host"] or not cfg["base_dn"]:
        return None
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _authenticate_sync, cfg, username, password)


async def authenticate_strict(db, username: str, password: str) -> dict | None:
    """authenticate 와 동일하나 디렉터리 장애·미설정 시 LdapUnavailable 예외 발생. None 은 "계정 없음·비밀번호 틀림"에 한정."""
    cfg = await get_config(db, reveal=True)
    if not cfg["enabled"] or not cfg["host"] or not cfg["base_dn"]:
        raise LdapUnavailable("LDAP 설정이 완전하지 않습니다")
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _authenticate_sync, cfg, username, password, True)
