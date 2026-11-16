"""users 테이블 → LDAP 디렉터리 트리 변환.

원장은 backend 의 users 테이블이다. 본 모듈은 **읽기만** 수행하며, 조회 결과를
inetOrgPerson 형태로 변환해 ldaptor 의 인메모리 트리에 적재한다.

사용자 수가 수십~수백 규모이므로 검색마다 트리를 재생성해도 무방하나, 검색이
잦은 장비(메일 클라이언트 주소록 등)를 고려해 짧은 TTL 캐시를 적용한다.
"""

from __future__ import annotations

import logging
import threading
import time

import psycopg
from ldaptor import inmemory
from ldaptor.protocols.ldap import distinguishedname

from app.config import settings

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "root": None}

# 조회 컬럼. ORM 을 복제하지 않고 필요한 컬럼만 조회한다.
_SQL = """
    SELECT id, username,
           coalesce(display_name, username) AS display_name,
           coalesce(email, '') AS email,
           is_admin
      FROM users
     WHERE is_active
     ORDER BY username
"""


_SQL_GROUPS = """
    SELECT g.id, g.name, coalesce(g.description, '') AS description,
           coalesce(
               array_agg(u.username) FILTER (WHERE u.username IS NOT NULL),
               '{}'
           ) AS members
      FROM groups g
      LEFT JOIN group_members m ON m.group_id = g.id
      LEFT JOIN users u ON u.id = m.user_id AND u.is_active
     GROUP BY g.id, g.name, g.description
     ORDER BY g.name
"""


def _fetch_users() -> list[dict]:
    # psycopg3 동기 드라이버 — Twisted 리액터를 차단하지 않도록 호출부에서
    # deferToThread 로 감싼다.
    with psycopg.connect(settings.database_url, connect_timeout=5) as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute(_SQL)
            return cur.fetchall()


def _fetch_groups() -> list[dict]:
    with psycopg.connect(settings.database_url, connect_timeout=5) as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute(_SQL_GROUPS)
            return cur.fetchall()


def _add_user(users_entry, u: dict) -> None:
    """inetOrgPerson + posixAccount 로 등재한다.

    objectClass 선택 이유:
      * inetOrgPerson — mail/displayName 을 표준 속성으로 포함할 수 있어 대부분의
        어플라이언스(NAS·하이퍼바이저·방화벽)가 이 형태를 기대한다.
      * posixAccount  — uidNumber/gidNumber 를 요구하는 장비가 있다. uidNumber 는
        원장에 없으므로 **안정적인 파생값**이 필요하다. username 해시는 충돌
        가능성이 있어, 추후 users 에 컬럼을 두는 편이 적절하다(TODO).
    """
    attrs = {
        "objectClass": ["top", "person", "organizationalPerson",
                        "inetOrgPerson", "posixAccount"],
        "uid": [u["username"]],
        "cn": [u["display_name"]],
        "sn": [u["display_name"]],
        "displayName": [u["display_name"]],
        # 원장의 UUID 를 그대로 포함해 SP 측에서 안정적인 식별자로 사용할 수 있게 한다.
        "employeeNumber": [str(u["id"])],
        "uidNumber": [str(_stable_uid_number(u["id"]))],
        "gidNumber": ["10000"],
        "homeDirectory": [f"/home/{u['username']}"],
        "loginShell": ["/sbin/nologin"],
    }
    if u["email"]:
        attrs["mail"] = [u["email"]]
    users_entry.addChild(f"uid={u['username']}", attrs)


def _stable_uid_number(user_id: str) -> int:
    """UUID → 안정적인 uidNumber.

    posixAccount 를 요구하는 장비 때문에 필요하다. 원장에 uidNumber 컬럼이 없어
    UUID 에서 파생하며, **충돌 가능성이 0 은 아니다**(2^31 공간에 해시).
    POSIX 계정을 실제로 사용하기 시작하면 users 에 컬럼을 추가해 고정해야 한다.
    """
    import hashlib

    h = hashlib.sha256(user_id.encode()).digest()
    # 10000 ~ 2^31-1 범위로 사상 (시스템 uid 대역 회피)
    return 10000 + (int.from_bytes(h[:4], "big") % (2**31 - 1 - 10000))


def _add_group(groups_entry, g: dict) -> None:
    """부서/그룹을 groupOfNames + posixGroup 으로 등재한다.

    두 objectClass 를 함께 부여하는 이유: 클라이언트마다 멤버 표기 해석이 상이하다.
      * groupOfNames.member    → 멤버의 **전체 DN**
      * posixGroup.memberUid   → 멤버의 **사용자명**
    동기화 클라이언트가 사용하는 쪽이 제품마다 상이하므로 둘 다 기록한다.

    주의: groupOfNames 는 스키마상 member 가 1개 이상이어야 하나, 빈 그룹도
    부서 목록에 포함되어야 하므로 member 없이 등재한다. 엄격한 클라이언트가
    거부하는 경우 플레이스홀더 멤버를 추가하는 방식으로 변경해야 한다.
    """
    attrs = {
        "objectClass": ["top", "groupOfNames", "posixGroup"],
        "cn": [g["name"]],
        "description": [g["description"] or g["name"]],
        "gidNumber": [str(_stable_uid_number(g["id"]))],
    }
    members = [m for m in (g["members"] or []) if m]
    if members:
        attrs["member"] = [
            f"uid={m},ou={settings.ldap_users_ou},{settings.ldap_base_dn}"
            for m in members
        ]
        attrs["memberUid"] = list(members)
    groups_entry.addChild(f"cn={g['name']}", attrs)


def build_tree():
    """DB 를 조회해 LDAP 트리를 생성한다."""
    base = distinguishedname.DistinguishedName(settings.ldap_base_dn)
    root = inmemory.ReadOnlyInMemoryLDAPEntry(
        base, {"objectClass": ["top", "dcObject", "organization"],
               "o": [settings.ldap_base_dn]}
    )
    users_entry = root.addChild(
        f"ou={settings.ldap_users_ou}",
        {"objectClass": ["top", "organizationalUnit"],
         "ou": [settings.ldap_users_ou]},
    )
    rows = _fetch_users()
    for u in rows:
        _add_user(users_entry, u)

    # 부서(그룹) — 외부 디렉터리 동기화(부서 동기화)가 이 서브트리를 조회한다.
    groups_entry = root.addChild(
        f"ou={settings.ldap_groups_ou}",
        {"objectClass": ["top", "organizationalUnit"],
         "ou": [settings.ldap_groups_ou]},
    )
    try:
        grows = _fetch_groups()
    except Exception:
        # 그룹 조회가 실패해도 사용자 인증은 중단하지 않는다.
        logger.exception("그룹 조회 실패 — 부서 서브트리를 비운 채로 진행한다")
        grows = []
    for g in grows:
        _add_group(groups_entry, g)

    logger.info("LDAP 트리 구성: 사용자 %d명, 부서 %d개", len(rows), len(grows))
    return root


def get_tree():
    """TTL 캐시된 트리."""
    now = time.time()
    with _lock:
        if _cache["root"] is not None and now - _cache["at"] < settings.ldap_cache_ttl:
            return _cache["root"]
    root = build_tree()
    with _lock:
        _cache["root"] = root
        _cache["at"] = now
    return root


def invalidate() -> None:
    with _lock:
        _cache["root"] = None
