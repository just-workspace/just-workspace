"""LDAP 프로바이더.

**본 서비스가 LDAP 서버 역할을 한다.** backend 의 `auth/ldap_client.py` 는 반대 방향
(외부 LDAP 으로 로그인하는 컨슈머)이므로 혼동에 주의한다.

목적: NAS·하이퍼바이저·방화벽·메일 클라이언트처럼 LDAP 만 지원하는 장비가
워크스페이스 계정으로 인증하도록 한다.

설계상의 두 가지 선택:

1. **비밀번호 해시를 본 서비스에 두지 않는다.** simple bind 는 backend 의
   `/api/internal/verify-credentials` 에 위임한다. 해시 처리 코드가 한 곳에
   있어야 Argon2 재해시가 누락되지 않고 passlib 설정 불일치가 발생하지 않는다.

2. **Twisted 를 본 프로세스에 격리한다.** 파이썬에는 유지보수되는 asyncio LDAP *서버*
   라이브러리가 없어 ldaptor(Twisted)가 유일한 선택지이며, FastAPI(asyncio)와
   동일 프로세스에 두면 리액터가 혼재한다. 따라서 별도 컨테이너로 분리한다.
"""

from __future__ import annotations

import hmac
import json
import logging
import sys
import urllib.request

from ldaptor import interfaces as ldaptor_interfaces
from ldaptor.protocols import pureldap
from ldaptor.protocols.ldap import distinguishedname, ldaperrors, ldapserver
from twisted.internet import defer, protocol, reactor, threads
from twisted.python import log as twisted_log
from twisted.python.components import registerAdapter

from app.config import settings
from app.directory import get_tree
from app.tls import ensure_cert

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("ws-ldap")


def _verify_credentials(username: str, password: str) -> dict:
    """backend 내부 API 로 자격증명을 검증한다(블로킹 — 스레드에서 호출해야 한다)."""
    req = urllib.request.Request(
        f"{settings.backend_url.rstrip('/')}/api/internal/verify-credentials",
        data=json.dumps({"username": username, "password": password}).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Internal-Key": settings.internal_api_key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:  # 네트워크/키 오류를 인증 실패와 구분해 로그에 기록한다
        logger.warning("자격증명 검증 호출 실패: %s", e)
        return {"ok": False, "reason": "backend_unreachable"}


class WorkspaceLDAPServer(ldapserver.LDAPServer):
    """simple bind 를 backend 에 위임하는 LDAP 서버."""

    def _dn_to_username(self, dn_str: str) -> str | None:
        """bind DN 에서 uid 를 추출한다.

        장비마다 전송 형태가 상이하다:
          uid=alice,ou=users,dc=…   (표준)
          cn=alice,ou=users,dc=…    (일부 어플라이언스)
          alice                         (일부는 사용자명만 전송)
        세 형태 모두 허용한다 — 여기서 엄격하게 거부하면 장비 측에서 원인 파악이 매우 어렵다.
        """
        if not dn_str:
            return None
        if "=" not in dn_str:
            return dn_str.strip()
        try:
            dn = distinguishedname.DistinguishedName(dn_str)
        except Exception:
            return None
        for rdn in dn.split():
            for av in rdn.split():
                if av.attributeType.lower() in ("uid", "cn"):
                    return av.value
        return None

    def handle_LDAPBindRequest(self, request, controls, reply):
        # 익명 bind — 검색 허용 여부는 설정에 따른다.
        if not request.dn:
            if settings.ldap_allow_anonymous_search:
                self.boundUser = None
                return defer.succeed(
                    pureldap.LDAPBindResponse(resultCode=ldaperrors.Success.resultCode)
                )
            return defer.fail(ldaperrors.LDAPInvalidCredentials())

        dn_str = request.dn.decode() if isinstance(request.dn, bytes) else str(request.dn)
        password = request.auth.decode() if isinstance(request.auth, bytes) else str(request.auth or "")

        # ── 동기화 전용 서비스 계정 ──
        # 디렉터리 동기화 에이전트 등의 클라이언트가 사용하는 bind 계정. 워크스페이스 사용자가
        # 아니므로 이 계정으로는 워크스페이스 로그인이 불가하다.
        if settings.ldap_service_user:
            svc = self._dn_to_username(dn_str)
            if svc == settings.ldap_service_user:
                if hmac.compare_digest(password, settings.ldap_service_password):
                    logger.info("서비스 계정 bind 성공: %s", svc)
                    self.boundUser = svc
                    return defer.succeed(
                        pureldap.LDAPBindResponse(
                            resultCode=ldaperrors.Success.resultCode
                        )
                    )
                logger.info("서비스 계정 bind 실패: %s", svc)
                return defer.fail(ldaperrors.LDAPInvalidCredentials())

        username = self._dn_to_username(dn_str)
        if not username or not password:
            # 빈 비밀번호는 "unauthenticated bind"(RFC 4513 §5.1.2)로 해석될 수 있다.
            # 본 서비스는 항상 실패로 처리한다 — 익명 접근은 위 분기에서만 허용한다.
            logger.info("bind 거부: dn=%r (사용자명/비번 없음)", dn_str)
            return defer.fail(ldaperrors.LDAPInvalidCredentials())

        d = threads.deferToThread(_verify_credentials, username, password)

        def _done(result):
            if not result.get("ok"):
                logger.info("bind 실패: user=%s reason=%s", username, result.get("reason"))
                raise ldaperrors.LDAPInvalidCredentials()
            logger.info("bind 성공: user=%s", username)
            self.boundUser = username
            return pureldap.LDAPBindResponse(resultCode=ldaperrors.Success.resultCode)

        d.addCallback(_done)
        return d

    def handle_LDAPSearchRequest(self, request, controls, reply):
        # 미인증 검색 차단(설정으로 완화 가능). 차단하지 않으면 사용자 목록이
        # 인증 없이 노출된다 — 대부분의 장비는 서비스 계정으로 bind 하므로 기본값은 금지.
        if getattr(self, "boundUser", None) is None and not settings.ldap_allow_anonymous_search:
            return defer.fail(ldaperrors.LDAPInsufficientAccessRights())
        return super().handle_LDAPSearchRequest(request, controls, reply)


class WorkspaceLDAPFactory(protocol.ServerFactory):
    protocol = WorkspaceLDAPServer

    def buildProtocol(self, addr):
        proto = self.protocol()
        proto.debug = False
        proto.factory = self
        # ldaptor 는 검색 시 factory.root 를 참조한다. 연결마다 최신 트리를 제공한다.
        return proto

    @property
    def root(self):
        return get_tree()


# ldaptor 의 검색 핸들러는 factory 를 IConnectedLDAPEntry 로 **어댑트**해 트리를
# 획득한다(ldapserver.py: interfaces.IConnectedLDAPEntry(self.factory)). 어댑터를
# 등록하지 않으면 bind 는 성공하나 검색만 "Could not adapt" 로 실패한다.
registerAdapter(
    lambda factory: factory.root,
    WorkspaceLDAPFactory,
    ldaptor_interfaces.IConnectedLDAPEntry,
)


def main() -> int:
    # 취약한 값이나 기본값인 비밀값으로는 기동하지 않는다. INTERNAL_API_KEY 가 없으면 backend 의 내부 API 가 차단되어
    # bind 가 전부 실패하고, 서비스 계정 비밀번호가 비어 있으면 해당 계정으로 누구나 디렉터리를 조회할 수 있다.
    from app import secret_guard

    db_pw = secret_guard.db_password(settings.database_url)
    if not secret_guard.enforce([
        ("INTERNAL_API_KEY", settings.internal_api_key, secret_guard.KEY_MIN, True),
        ("LDAP_SERVICE_PASSWORD", settings.ldap_service_password, secret_guard.PASSWORD_MIN,
         bool(settings.ldap_service_user)),
        ("DB_PASSWORD", db_pw or "", secret_guard.PASSWORD_MIN, db_pw is not None),
    ]):
        return 1

    twisted_log.PythonLoggingObserver(loggerName="ws-ldap.twisted").start()
    try:
        tree = get_tree()  # 기동 시 DB 연결과 트리 구성을 사전 확인한다
        logger.info("디렉터리 준비 완료: base=%s", settings.ldap_base_dn)
        del tree
    except Exception:
        logger.exception("디렉터리 구성 실패 — DB 연결을 확인할 것")
        return 1

    factory = WorkspaceLDAPFactory()
    reactor.listenTCP(settings.ldap_port, factory,
                      interface=settings.ldap_bind_host)
    logger.info("LDAP  대기: %s:%d (평문)",
                settings.ldap_bind_host, settings.ldap_port)

    if settings.ldaps_enabled:
        pair = ensure_cert()
        if pair:
            from twisted.internet import ssl

            cert_file, key_file = pair
            reactor.listenSSL(
                settings.ldaps_port, factory,
                ssl.DefaultOpenSSLContextFactory(key_file, cert_file),
                interface=settings.ldap_bind_host,
            )
            logger.info("LDAPS 대기: %s:%d (TLS)",
                        settings.ldap_bind_host, settings.ldaps_port)
        else:
            logger.warning("LDAPS 비활성 — 인증서를 준비하지 못했다")

    logger.info("base=%s", settings.ldap_base_dn)
    reactor.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
