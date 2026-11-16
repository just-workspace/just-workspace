from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Workspace"
    app_url: str = "http://localhost"
    # NetLab(별도 출처 랩 플랫폼) 주소 — 지정 시 앱 내려받기 페이지(/api/apps)에 콘솔 도우미 링크를 표시한다. 예: https://lab.example.com
    netlab_url: str = ""
    # 이 서버가 실행하는 프로그램의 소스 주소(환경변수 JW_SOURCE_URL). 미지정 시 원본 리포 — 수정하여 서비스하는 경우 수정된 소스의 주소를 지정(app/source.py)
    jw_source_url: str = ""
    debug: bool = False
    secret_key: str = "CHANGE_ME"

    # PostgreSQL
    database_url: str = "postgresql+asyncpg://workspace:workspace@postgres:5432/workspace"

    # Domain
    domain: str = "localhost"

    # File storage
    storage_root: str = "/storage"
    upload_max_size_mb: int = 5120
    # 번들 빌드 모바일 앱(화면을 앱 내부에 포함하는 빌드)의 웹뷰 출처(https://localhost · capacitor://localhost)를
    # CORS·CSRF·WebSocket 허용 목록에 포함할지 여부. 기본 앱은 서버 화면을 그대로 열어 동일 출처이므로 불필요 —
    # 번들 빌드 앱을 배포하는 경우에만 true 로 설정한다(app/auth/ws_auth.py 의 NATIVE_APP_ORIGINS).
    allow_native_app_origins: bool = False
    # 세션 쿠키로 인증된 상태 변경 요청(POST/PUT/PATCH/DELETE)의 Origin 검사(app/middleware/origin_check.py).
    # 동일 등록 도메인의 다른 하위 도메인에서 오는 요청은 SameSite 쿠키로 차단할 수 없어 적용한다. 문제 발생 시 false 로 비활성화한다.
    csrf_origin_check: bool = True
    # 추가로 신뢰할 출처(쉼표 구분, 예: "https://alt.example.com,https://10.0.0.5"). 공개 주소(APP_URL)·CORS 허용 목록·
    # 요청 Host 와 동일한 출처는 명시하지 않아도 통과한다.
    csrf_trusted_origins: str = ""

    # Built-in mail server (Postfix+Dovecot) — disabled by default
    feature_builtin_mailserver: bool = False
    # 헬스체크 대상 메일서버. 빌트인=mailserver 자동. IMAP 클라이언트 모드에서도 내부에 별도
    # 메일서버가 있으면 "host" 또는 "host:port" 지정 시 해당 서버를 모니터링한다. 빈 값이면 검사하지 않는다.
    mail_health_host: str = ""

    # 관리 개요 "SSL D-n" 확인 방법(TLS 를 프런트 리버스 프록시가 종단하는 구성용). 우선순위는 admin/users_ext.ssl_expiry 참고.
    # ssl_cert_path: 컨테이너에 읽기 전용으로 마운트한 인증서 파일(PEM, 예: certbot fullchain.pem) — 네트워크 없이 직접 읽는다.
    # ssl_check_host: 공개 주소 대신 접속할 내부 주소 "host" 또는 "host:port"(예: 리버스 프록시 사설 IP).
    #   SNI 는 app_url 의 호스트명으로 송신하여 동일한 인증서를 수신한다 — 헤어핀 NAT 가 없어 공개 주소로 접속할 수 없는 환경용.
    ssl_cert_path: str = ""
    ssl_check_host: str = ""

    # CalDAV/CardDAV 는 앱 비밀번호(설정 › 연결된 앱, 범위 dav)만 허용한다. 전환 기간에 계정 비밀번호도
    # 허용해야 하면 true — 이 경우에도 2단계 인증을 활성화했거나 정책상 필수인 계정은 거부하며, 실패는 로그인 잠금에 집계한다.
    dav_allow_account_password: bool = False

    # Dovecot master user (SSO: backend accesses any mailbox without per-user passwords)
    dovecot_master_user: str = ""
    dovecot_master_password: str = ""

    # SMTP (noreply sender)
    smtp_host: str = "mailserver"
    smtp_port: int = 587
    smtp_user: str = "noreply@localhost"
    smtp_password: str = ""
    smtp_from: str = "noreply@localhost"

    # Admin notification
    admin_emails: str = ""

    # Gitea
    gitea_url: str = "http://gitea:3000"
    gitea_external_url: str = ""  # browser-facing URL (empty → APP_URL/git/)
    gitea_token: str = ""
    gitea_webhook_secret: str = ""

    # Web Push(VAPID). 미지정 시 최초 사용 시점에 생성하여 DB(system_settings "push.vapid")에 저장한다 — 워커·재시작 간 동일한 키를 사용한다.
    # 공개 키 = P-256 비압축 점(65바이트) base64url, 비공개 키 = 32바이트 정수 base64url(py_vapid from_string 형식).
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    gitea_webhook_channel: str = ""  # empty → "git-notifications"

    # Redis
    redis_url: str = "redis://redis:6379/0"

    # 채팅 역할·권한 엔진(docs/chat-permissions.md) — legacy | shadow | enforce.
    # legacy: 기존 하드코딩 검사만 수행. shadow(기본): 기존 검사로 차단하고 새 엔진 결과를 병행 계산하여
    # 상이하면 구조화 로그(chat_perm_shadow_mismatch)만 기록한다. enforce: 새 엔진으로 차단한다.
    chat_permissions_engine: str = "shadow"

    # LiveKit
    livekit_url: str = "http://livekit:7880"
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    livekit_ws_url: str = ""  # 브라우저용 WS URL (빈값이면 app_url에서 자동 파생)

    # 무손실 음성 릴레이(ws-audiorelay, profiles: audiorelay). 시크릿은 릴레이 RELAY_SECRET 과 동일한 값.
    # 비어 있으면 relay-token 엔드포인트가 503 반환 → 클라이언트는 음악 티어로 fallback 한다.
    audiorelay_secret: str = ""
    audiorelay_url: str = "http://audiorelay:8090"  # 내부 주소(/audiorelay/info 조회)
    audiorelay_ws_path: str = "/audiorelay/ws"      # ws-nginx 가 릴레이로 전달하는 경로

    # Branding
    brand_logo: str = ""       # URL or path to logo image
    brand_color: str = "#3B82F6"  # Primary brand color (hex)

    # Portal OAuth Provider (for Gitea etc.)
    oauth_clients_json: str = "{}"
    # 내부 서비스(ws-ldap 등)가 backend 의 /api/internal/* 을 호출할 때 사용하는 키.
    # **비어 있으면 내부 API 는 404 로 완전히 차단된다**(기본 비활성).
    internal_api_key: str = ""
    # Max number of dynamically registered (RFC 7591 DCR) clients. /oauth/register
    # rejects with 400 once this cap is reached (abuse safeguard for open reg).
    oauth_dynamic_clients_max: int = 500

    # MCP remote connector (Streamable HTTP + legacy SSE).
    # Auth is OAuth Bearer by default. The static-key path below is an
    # OPT-IN internal-tools escape hatch, DISABLED by default. When
    # mcp_internal_tools_enabled=True AND mcp_api_key is non-empty, a bearer
    # equal to mcp_api_key (constant-time compared) is accepted for headless
    # internal callers. It carries NO user (there is no admin fallback anymore),
    # so only user-less tools (e.g. web_search) run under it.
    mcp_api_key: str = ""
    mcp_internal_tools_enabled: bool = False
    # Public URL of the MCP resource server (dedicated subdomain, e.g.
    # https://mcp.example.com). Drives the MCP resource/aud + protected-resource
    # metadata + WWW-Authenticate. Empty → falls back to app_url. OAuth
    # issuer/authorize/token stay on app_url regardless.
    mcp_public_url: str = ""
    # MCP 도구 응답 1건의 외부 상한(글자 수, json.dumps(ensure_ascii=False) 기준).
    # 원격 클라이언트(claude.ai 등) 측 한도를 알 수 없어 보수적으로 설정한다. 목록 도구는 이 범위에
    # 들도록 항목 단위로 축소하며(truncated/next_cursor), 그래도 초과하면 response_too_large.
    # 내장 AI 는 이 값 대신 모델 컨텍스트에 맞춘 예산(app.ai.tool_budget)을 사용한다.
    mcp_response_max_chars: int = 40_000

    # OnlyOffice Document Server
    onlyoffice_url: str = "http://onlyoffice:80"
    onlyoffice_jwt_secret: str = ""


    # WOPI
    # 편집 세션 1회를 포괄하면 충분하다. 24시간 토큰은 URL 유출 시
    # 하루 동안 타인의 파일을 읽고 쓸 수 있음을 의미하므로 과도했다.
    wopi_token_ttl: int = 7200  # 2 hours

    # ── 격리 브라우저(RBI, app/rbi) ──
    # 세션마다 KasmVNC 브라우저 컨테이너를 1개 기동한다(docker.sock). 네트워크·브리지 이름은
    # 호스트의 ws-rbi-netfilter(DOCKER-USER 규칙)와 동일한 값을 참조해야 한다 — docs/rbi.md.
    rbi_image: str = "kasmweb/chromium:1.18.0"
    # 미러 모드 세션 이미지(rbi/mirror — Chromium + mirror-agent, 사용자 PC 로는 닫힌 어휘만). compose 의 rbi-mirror 빌드 항목과 동일한 이름
    rbi_mirror_image: str = "localhost/just-workspace-rbi-mirror:latest"
    rbi_network: str = "ws-rbi"                  # 세션 컨테이너 전용 브리지(없으면 백엔드가 생성)
    rbi_subnet: str = "172.31.200.0/24"
    rbi_ip_range: str = "172.31.200.128/25"      # 세션 컨테이너 IP 대역(게이트웨이·예약 주소와 분리)
    rbi_bridge: str = "br-wsrbi"                 # 브리지 인터페이스 이름(netfilter 규칙이 이 이름을 참조)
    rbi_publish_ip: str = "172.28.0.1"           # ws-nginx 가 세션 스트림에 접속하는 주소(workspace 브리지 게이트웨이)
    rbi_guard_state: str = "/run/rbi-guard/state.json"  # netfilter 사이드카 하트비트(없거나 오래되면 세션 시작 거부)
    rbi_require_guard: bool = True
    rbi_guard_max_age: int = 180                 # 초. 사이드카는 60초마다 갱신
    rbi_max_sessions: int = 4                    # 동시 세션 상한(호스트 2CPU/2GB ×)
    rbi_container_prefix: str = "ws-rbi-s-"
    # 격리 브라우저 전용 출처(예 https://rbi.example.com). 화면·API·스트림이 모두 이 출처에서만 제공된다(워크스페이스와 상이한 출처 —
    # 쿠키가 상호 공유되지 않는다). 미지정 시 격리 브라우저 화면이 열리지 않는다(런처가 "설정 필요" 를 표시). docs/rbi.md §7
    rbi_public_origin: str = ""
    rbi_site_session_hours: int = 8
    # 동적 출구 허용 목록(app/rbi/egress.py) — 활성화된 대상으로부터 생성하여 이 파일(rbi-allow 볼륨)에 기록하며, ws-rbi-netfilter 가 이를 읽는다
    rbi_allow_file: str = "/run/rbi-allow/allow.txt"
    # 동적 출구로 허용 가능한 상한(CIDR, 쉼표 구분). 미지정 시 사설 대역(10/8·172.16/12·192.168/16). 사이드카도 동일한 값을 재검사한다
    rbi_allow_ceiling: str = ""
    # 워크스페이스 자체(대상으로 지정 시 거부 — 관리자가 강제하면 경고와 함께 허용). IP/CIDR 쉼표 구분. 예: 앱 호스트·LAN 게이트웨이
    rbi_protected: str = ""              # rbi 출처 세션(쿠키·Redis) 수명. 워크스페이스 로그아웃 시 그 전에 종료된다

    model_config = {"env_file": ".env", "extra": "ignore"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
