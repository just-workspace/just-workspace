"""ws-sso 설정. backend 와 공유해야 하는 값은 env 로 주입받는다."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # backend 와 **동일한 값**이어야 한다. ws_session 쿠키 서명 검증에 쓴다.
    # (나중에 OIDC 까지 이관하면 이 공유를 끊고 내부 API 로 바꾸는 게 낫다)
    secret_key: str = "change-me"

    # 같은 postgres. users 는 읽기만 하고, ws-sso 전용 테이블은 따로 만든다.
    database_url: str = "postgresql+asyncpg://portal:portal@postgres:5432/workspace"

    # 공개 진입점. SAML 메타데이터의 entityID 와 각 엔드포인트 URL 의 기준이 된다.
    public_url: str = "http://localhost"   # compose 가 APP_URL 로 넣는다

    # SAML IdP entityID. 관례상 메타데이터 URL 을 쓴다.
    saml_entity_id: str = ""

    log_level: str = "INFO"

    @property
    def entity_id(self) -> str:
        return self.saml_entity_id or f"{self.public_url.rstrip('/')}/sso/saml/metadata"


settings = Settings()
