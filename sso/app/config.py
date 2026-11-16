"""ws-sso 설정. backend 와 공유해야 하는 값은 env 로 주입받는다."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # backend 와 **동일한 값**이어야 한다. ws_session 쿠키 서명 검증에 사용한다.
    # (향후 OIDC 까지 이관하면 이 공유를 제거하고 내부 API 로 전환하는 것이 바람직하다)
    # 기본값 없음 — 비어 있거나 약하면 기동을 거부한다(app/secret_guard.py).
    secret_key: str = ""

    # 동일한 postgres. users 는 읽기 전용이며, ws-sso 전용 테이블은 별도로 생성한다.
    database_url: str = "postgresql+asyncpg://workspace@postgres:5432/workspace"

    # 공개 진입점. SAML 메타데이터의 entityID 와 각 엔드포인트 URL 의 기준이다.
    public_url: str = "http://localhost"   # compose 가 APP_URL 로 주입

    # SAML IdP entityID. 관례상 메타데이터 URL 을 사용한다.
    saml_entity_id: str = ""

    log_level: str = "INFO"

    @property
    def entity_id(self) -> str:
        return self.saml_entity_id or f"{self.public_url.rstrip('/')}/sso/saml/metadata"


settings = Settings()
