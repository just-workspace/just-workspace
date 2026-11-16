"""ws-ldap 설정."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # 워크스페이스 도메인(.env 의 DOMAIN). 아래 두 값의 기본값 생성에 사용한다.
    domain: str = "localhost"

    # 디렉터리 루트. NAS·하이퍼바이저 등에 입력하는 Base DN 이다.
    # 미지정 시 DOMAIN 에서 생성한다: ws.example.com → dc=ws,dc=example,dc=com
    ldap_base_dn: str = ""
    ldap_users_ou: str = "users"
    ldap_groups_ou: str = "groups"

    ldap_port: int = 1389          # 컨테이너 내부 포트(비루트 실행이므로 389 사용 불가)
    ldap_bind_host: str = "0.0.0.0"

    # 비밀번호 검증은 backend 에 위임한다 — 해시를 본 서비스로 확산시키지 않는다.
    backend_url: str = "http://backend:8000"
    internal_api_key: str = ""

    # 사용자 목록 조회용(읽기 전용).
    database_url: str = "postgresql://workspace@postgres:5432/workspace"

    # 익명 SEARCH 허용 여부. 대부분의 장비는 서비스 계정으로 bind 한 후 검색하므로
    # 기본값은 금지다. 활성화하면 사용자 목록이 인증 없이 노출된다.
    ldap_allow_anonymous_search: bool = False

    # 사용자 목록 캐시(초). 검색마다 DB 를 조회하지 않기 위한 설정.
    ldap_cache_ttl: int = 30

    # ── 동기화 전용 서비스 계정 ──
    # IDaaS 동기화 에이전트 등의 클라이언트가 사용하는 bind 계정.
    # **워크스페이스 사용자로 생성하지 않는다** — 생성하면 해당 계정으로 워크스페이스
    # 로그인도 가능해지기 때문이다. 여기 정의한 계정은 LDAP bind/search 만 가능하다.
    # 미지정 시 서비스 계정 기능이 비활성화된다(일반 사용자 bind 만 가능).
    ldap_service_user: str = ""      # 예: dirsync
    ldap_service_password: str = ""

    @property
    def service_dn(self) -> str:
        return f"cn={self.ldap_service_user},ou=services,{self.ldap_base_dn}"

    # ── LDAPS (636) ──
    # ldaptor 는 StartTLS 를 지원하지 않는다 → 암호화 경로는 LDAPS 가 유일하다.
    # 장비에서 "389 + StartTLS" 로 설정하면 평문으로 접속되므로 반드시 636/SSL 로 설정한다.
    ldaps_port: int = 1636          # 컨테이너 내부(비루트). 외부 636 으로 매핑.
    ldaps_enabled: bool = True
    # 외부 인증서 사용 시 지정(예: Let's Encrypt 마운트). 미지정 시 자체 서명.
    ldap_tls_cert: str = ""
    ldap_tls_key: str = ""
    # 자체 서명 인증서 보관 위치 — **볼륨이어야 한다.** 기동마다 재생성하면
    # 인증서를 신뢰 목록에 등록한 장비가 재기동마다 접속에 실패한다.
    ldap_tls_dir: str = "/certs"
    # 미지정 시 ldap.<DOMAIN>,<DOMAIN>,127.0.0.1. LAN IP 로 접속하는 장비가 있으면 .env 에 추가한다.
    ldap_tls_sans: str = ""

    def model_post_init(self, __context) -> None:
        if not self.ldap_base_dn:
            self.ldap_base_dn = ",".join(f"dc={p}" for p in self.domain.split(".") if p)
        if not self.ldap_tls_sans:
            self.ldap_tls_sans = f"ldap.{self.domain},{self.domain},127.0.0.1"

    log_level: str = "INFO"

    @property
    def users_dn(self) -> str:
        return f"ou={self.ldap_users_ou},{self.ldap_base_dn}"

    @property
    def groups_dn(self) -> str:
        return f"ou={self.ldap_groups_ou},{self.ldap_base_dn}"


settings = Settings()
