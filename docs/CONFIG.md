# 환경 설정 (Configuration)

Just Workspace 의 환경별 설정값은 스택의 `.env` 파일에 정의한다. 소스에는 환경 종속 고정값을 두지 않는다.

- **설치 관리자로 설치한 경우 `.env` 를 수동으로 수정할 필요는 거의 없다.** 설치 관리자가 입력값으로부터 생성하며(`<설치 폴더>/stack/.env`, 권한 600), 구역 활성화·비활성화 및 업데이트 시 다시 기록한다. 변수별 설정값의 기준은 [installer.md](installer.md) 8절의 표다.
- 설치 관리자 없이 직접 구성하는 경우 `.env.example` 을 복사해 작성한다 — [deployment.md](deployment.md).
- 기준 코드: `backend/app/config.py`(backend 가 읽는 값), `docker-compose.yml`(compose 가 치환하는 값), `backend/app/security_defaults.py`(비밀값 규칙), `installer/app/render.py`(설치 관리자가 기록하는 값).

"출처" 열은 설치 관리자로 설치한 경우 해당 값의 출처를 나타낸다.

| 출처 | 의미 |
|---|---|
| 생성 | 설치 관리자가 비밀값 생성기로 생성한다 |
| 답변 | 설치 마법사의 입력값 또는 응답 파일의 값을 그대로 사용한다 |
| 파생 | 입력값과 감지값으로부터 산출한다 |
| 고정 | 설치 관리자가 지정한 값 |
| 구역 | 구역 활성화 시 설치 관리자가 설정한다 |
| 수동 | 설치 관리자가 기록하지 않는다. 필요한 경우 `.env` 에 직접 기재한다(비우면 기본값) |

## 1. `.env` 변수

### 구성

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `COMPOSE_PROFILES` | (비움) | 기동할 컨테이너의 compose 프로파일(쉼표 구분): `mailserver` `gitea` `livekit` `egress` `audiorelay` `onlyoffice` `aitools` `sso` `rbi` `certbot`. 구역과의 대응은 [deployment.md](deployment.md#구역-compose_profiles-와-jw_zones) | 파생 |
| `JW_ZONES` | (비움 = 전체) | 설치된 구역(쉼표 구분): `mail` `chat` `calendar` `docs` `meetings` `git` `ai`, 애드온 `sso` `rbi`. 명시하지 않은 구역은 API 가 404 를 반환하며 메뉴에 표시되지 않는다. 선언은 `backend/app/zones.json` | 파생(`core,<구역들>`) |
| `APP_URL` | `http://localhost` | 접속 주소(`https://<접속 주소>`). OAuth 발급자 주소로도 사용된다 | 파생 |
| `DOMAIN` | `localhost` | 계정의 메일 주소에 사용되는 도메인(`<아이디>@DOMAIN`). 내장 메일인 경우 메일 도메인, 그 외에는 접속 주소 | 파생 |
| `APP_NAME` | `Workspace` | 표시 이름(관리 › 브랜딩에서 변경한다) | 고정 |
| `DEBUG` | `false` | 디버그 | 고정 |
| `STORAGE_VOLUME` | `ws-storage-data` | 파일 저장소 볼륨 이름. compose 는 이 볼륨을 기존 볼륨(`external`)으로 사용한다 | 고정 |
| `STORAGE_MARKER_REQUIRED` | (비움) | `1` 이면 저장소 마커(`.jw-storage`)가 확인되지 않을 때 파일 쓰기를 503 으로 거부한다 | 고정(`1`) |
| `JW_INSTALL_ID` | (비움) | 설치 id — 저장소 마커와 일치하여야 한다 | 고정 |
| `JW_NET_PREFIX` | `172.28.0` | 내부 대역(/24)의 상위 세 옥텟 | 답변 |
| `JW_REGISTRY` / `JW_VERSION` | `localhost` / `latest` | 자체 빌드 이미지의 저장소와 태그(`<JW_REGISTRY>/just-workspace-<이름>:<JW_VERSION>`) | 고정 |
| `JW_APP_VERSION` | (비움) | 화면에 표시되는 제품 버전. 이미지에 내장된 값보다 우선한다 | 고정 |
| `JW_INSTALLER_URL` / `JW_INSTALLER_KEY` | (비움) | backend 가 설치 관리자의 내부 API 를 호출하는 주소와 키. 비어 있으면 관리 › 구역·업데이트가 읽기 전용이다 | 고정 / 생성 |
| `JW_MIGRATE_ON_START` | (비움 = 활성) | `0` 이면 backend 가 기동 시 DB 스키마를 변경하지 않고 버전만 확인한다 — [data-safety.md](data-safety.md) | 수동 |
| `BACKEND_WORKERS` | (비움) | backend 워커 수. 비우면 `min(8, max(2, 코어 수))` | 파생(메모리 6 GB 미만이면 2) |
| `BACKEND_CPUS` | (비움) | backend 컨테이너의 CPU 상한(예 `4.0`). 비우면 제한 없음 | 수동 |
| `BACKUP_VOLUME` | `backups-vol` | 백업 저장 볼륨(실제 이름 `ws-backups`). 호스트 경로를 지정해 다른 디스크로 변경할 수 있다 | 수동 |
| `DEPLOY_MODE` | — | 설치 관리자가 `.env` 에 기록하는 표시값(`standalone`/`external_proxy`). compose 와 backend 는 읽지 않는다 — 직접 구성하는 경우 기재하지 않는다(`.env.example` 에 없다) | 파생 |
| `COMPOSE_PROJECT_NAME` | — | compose 프로젝트 이름 | 고정(`just-workspace`) |

### 접속 및 보안

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `SECRET_KEY` | — | 세션 서명 및 DB 내 값의 암호화 키. **변경하면 암호화된 값을 복호화할 수 없다.** SSO 컨테이너와 동일한 값을 사용한다 | 생성 |
| `INTERNAL_API_KEY` | (비움) | backend 내부 API(`/api/internal/*`) 키 — 메일 서버의 로그인 검증과 LDAP 컨테이너가 사용한다. 비우면 내부 API 가 비활성화된다 | 생성 |
| `JW_ALLOW_INSECURE_DEFAULTS` | (비움) | `1` 이면 취약하거나 기본값인 비밀값을 거부하지 않고 경고만 기록한다. **개발·테스트 전용** | 수동 |
| `RP_LAN_IP` / `HAIRPIN_HOST` | (비움) | 컨테이너(코드 저장소·문서 편집기)가 접속 주소로 헤어핀 접속할 때 사용할 주소와 호스트 이름. 문서 편집기의 허용 주소에도 포함된다 | 파생 |
| `DOMAIN_ALIAS` | (비움) | 동일한 앱을 다른 도메인으로도 수신하는 경우의 도메인 이름 | 수동 |
| `ALLOW_NATIVE_APP_ORIGINS` | `false` | 화면을 앱에 내장해 빌드한 모바일 앱의 출처를 허용 목록에 추가한다 | 수동 |
| `CSRF_ORIGIN_CHECK` | `true` | 쿠키로 인증된 변경 요청의 출처 검사 | 수동 |
| `CSRF_TRUSTED_ORIGINS` | (비움) | 추가로 신뢰할 출처(쉼표 구분) | 수동 |
| `SSL_CERT_PATH` / `SSL_CHECK_HOST` | (비움) | 관리 개요의 인증서 만료 표시가 참조할 인증서 파일 / 대신 접속해 확인할 내부 주소(프런트 프록시 구성용) | 수동 |
| `LETSENCRYPT_EMAIL` | — | 인증서 발급 연락처 | 답변 또는 파생(`admin@DOMAIN`) |
| `ACME_DOMAINS` | (비움 = `mail.`·`turn.`·도메인) | 인증서에 포함할 이름(쉼표 구분, 첫 번째 이름이 접속 주소). DNS 에 등록되지 않은 이름이 포함되면 발급 전체가 실패한다 | 파생 |

### 데이터베이스

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `DB_NAME` / `DB_USER` | `workspace` | PostgreSQL 데이터베이스·사용자 | 고정 |
| `DB_PASSWORD` | — | DB 비밀번호. **DB 볼륨의 최초 생성 시에만 적용된다** | 생성 |
| `DATABASE_URL` | (비움) | 비우면 compose 가 위 세 값으로 구성한다. 외부 DB 를 사용하는 경우에만 기재한다 | 고정(비움) |
| `REDIS_URL` | `redis://redis:6379/0` | compose 가 설정한다 | — |

파일 저장 위치(이 서버의 디스크·NFS)는 변수가 아니라 저장소 볼륨의 생성 방식으로 결정된다([installer.md](installer.md) 8절). S3 호환 저장소는 관리 › 저장소·백업에서 설정한다.

### 관리자

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `ADMIN_EMAILS` | (비움) | 해당 메일 주소의 계정에 관리자 권한을 부여한다(쉼표 구분) | 파생(`<관리자 아이디>@DOMAIN`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | (비움) | 최초 기동 시의 관리자 생성 — **사용자가 한 명도 없는 경우에만** 실행된다. 생성 후 삭제한다. 비워 두면 웹의 최초 설정 화면에서 설정 토큰으로 생성한다([deployment.md](deployment.md#최초-관리자-계정-생성)) | 사용하지 않음(설치 관리자는 `seed-admin` 으로 생성한다) |

### 메일

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `FEATURE_BUILTIN_MAILSERVER` | `false` | 내장 메일 서버를 사용한다(계정 승인 시 메일함이 함께 생성된다) | 파생 |
| `DOVECOT_MASTER_USER` / `DOVECOT_MASTER_PASSWORD` | (비움) | 내장 메일 서버의 마스터 계정 | 고정(`portal`) / 생성 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | `mailserver` / `587` / … | 시스템 메일(초대, 비밀번호 재설정)의 발송 서버. 내장인 경우 `noreply@<메일 도메인>` 과 생성된 비밀번호, 외부인 경우 입력값 | 파생·답변·생성 |
| `MAIL_SSL_TYPE` | `letsencrypt` | 메일 서버의 인증서 탐색 방식 | 고정 |
| `MAIL_MESSAGE_SIZE_LIMIT` | `104857600` | 메일 1통의 크기 상한(바이트) | 수동 |
| `MAIL_HEALTH_HOST` | (비움) | 서비스 상태가 점검할 외부 메일 서버(`host` 또는 `host:port`) | 수동 |
| `MAIL_POLL_INTERVAL` | `120` | 외부 메일 계정의 새 메일 확인 주기(초) | 수동 |
| `MAIL_PRIVATE_HOST_ALLOWLIST` | (비움) | 사용자가 외부 메일 계정으로 연결할 수 있는 사설 주소(호스트 이름·CIDR, 쉼표 구분). 기본적으로 사설 주소로의 연결은 차단된다 | 수동 |

### 구역별 설정

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `GITEA_URL` / `GITEA_EXTERNAL_URL` | `http://gitea:3000` / `APP_URL/git/` | 코드 저장소의 내부 주소 / 브라우저 접속 주소 | 고정 / 파생 |
| `GITEA_TOKEN` | (비움) | backend 가 코드 저장소 API 를 호출하는 관리 토큰 | 구역 |
| `GITEA_IMAGE` | (비움 = compose 에 고정한 검증된 버전) | 코드 저장소 이미지 | 답변 |
| `GIT_SSH_PORT` / `GIT_SSH_DOMAIN` | `2222` / `DOMAIN` | Git SSH 의 호스트 포트 / 주소에 표시할 이름 | 고정 / 파생 |
| `GITEA_DATA_PATH` | `gitea-data` 볼륨 | 코드 저장소 데이터를 저장할 볼륨 또는 호스트 경로 | 수동 |
| `GITEA_WEBHOOK_SECRET` / `GITEA_WEBHOOK_CHANNEL` | (비움) / `git-notifications` | 코드 저장소 웹훅을 채팅 채널로 수신하는 경우의 서명 키와 채널 | 수동 |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | (비움) | 회의 서버 인증. 비우면 회의가 비활성화된다 | 생성 |
| `LIVEKIT_URL` / `LIVEKIT_WS_URL` | `http://livekit:7880` / (`APP_URL` 에서 파생) | 회의 서버의 내부 주소 / 브라우저 접속 주소 | 고정 / 수동 |
| `LIVEKIT_TURN_TLS_PUBLISH` | `443` | 회의 중계의 보안 연결(TURN/TLS)을 게시할 호스트 포트 | 파생(프록시 하단 443, 그 외 5349) |
| `AUDIORELAY_SECRET` | (비움) | 무손실 오디오 릴레이의 토큰 서명 키 | 생성 |
| `AUDIORELAY_WT_PUBLIC_URL` | (비움) | WebTransport 공개 주소. 비우면 WebSocket 만 사용한다 — [voice-lossless.md](voice-lossless.md) | 파생 |
| `AUDIORELAY_WT_PORT` / `AUDIORELAY_WT_CERT` / `AUDIORELAY_WT_KEY` | `4433` / 인증서 볼륨의 경로 | WebTransport 의 UDP 포트와 인증서 | 고정 / 파생 |
| `AUDIORELAY_WT_SELF_SIGNED_HOSTS` | `127.0.0.1,localhost` | 인증서가 없는 경우 생성하는 자체 서명 인증서의 이름(시험용) | 수동 |
| `ONLYOFFICE_JWT_SECRET` | (비움) | 문서 편집기와 backend 간의 서명 키 | 생성 |
| `ONLYOFFICE_URL` / `WOPI_TOKEN_TTL` | `http://onlyoffice:80` / `7200` | 문서 편집기의 내부 주소 / 편집 토큰 유효 기간(초) | 수동 |
| `SEARXNG_SECRET` | (비움) | 웹 검색 컨테이너의 비밀값 | 생성 |
| `SEARXNG_URL` | `http://searxng:8080` | 웹 검색 컨테이너의 내부 주소 | 수동 |
| `SANDBOX_TOKEN` / `DOCCONV_TOKEN` | (비움) | 코드 실행·문서 변환 컨테이너와 backend 가 공유하는 비밀값 | 생성 |
| `SANDBOX_CONCURRENCY` / `SANDBOX_MAX_TIMEOUT` / `SANDBOX_MEM_MB` | `2` / `120` / `1536` | 코드 실행의 동시 실행 수 · 최대 실행 시간(초) · 실행당 메모리(MB) | 수동 |
| `DOCCONV_CONCURRENCY` / `DOCCONV_TIMEOUT` / `DOCCONV_MAX_MB` | `2` / `120` / `100` | 문서 변환의 동시 실행 수 · 제한 시간(초) · 파일 크기(MB) | 수동 |
| `CHAT_PERMISSIONS_ENGINE` | `shadow` | 채팅 역할·권한 엔진 `legacy`/`shadow`/`enforce` — [chat-permissions.md](chat-permissions.md) | 수동 |
| `LDAP_PLAIN_BIND` | `127.0.0.1` | LDAP 컨테이너의 평문 389 를 게시할 주소. 외부에는 LDAPS(636)만 개방한다. 평문만 지원하는 장비가 내부망에 있는 경우에 한해 해당 망의 서버 주소(예 `192.168.10.20`)를 기재한다 | 고정 |
| `LDAP_SERVICE_USER` / `LDAP_SERVICE_PASSWORD` | (비움) | LDAP 디렉터리를 조회하는 서비스 계정(LDAP 컨테이너가 읽는다) | 수동 |

격리 브라우저(`RBI_*`) 변수는 항목이 많아 [rbi.md](rbi.md)에 별도로 기술한다. 설치 관리자는 `RBI_PUBLIC_ORIGIN`(`https://rbi.<접속 주소>`), `RBI_PUBLISH_IP`(내부 대역의 `.1`), `RBI_PROTECTED`(감지한 이 서버의 주소와 기본 게이트웨이)를 설정하고 나머지는 기본값을 사용한다.

### 인증·연동

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `OAUTH_CLIENTS_JSON` | `{}` | 사전 등록 OAuth 클라이언트([4절](#4-oauth_clients_json--정적-클라이언트)). 코드 저장소 구역을 활성화하면 `gitea` 항목이 추가된다 | 구역 |
| `OAUTH_DYNAMIC_CLIENTS_MAX` | `500` | 동적 등록(RFC 7591) 클라이언트의 전체 상한 | 수동 |
| `MCP_PUBLIC_URL` | (비움 = `APP_URL`) | MCP 리소스 서버의 공개 주소(전용 하위 도메인을 사용하는 경우) — [CONNECTOR.md](CONNECTOR.md) | 고정(비움) |
| `MCP_INTERNAL_TOOLS_ENABLED` / `MCP_API_KEY` | `false` / (비움) | 사용자 없이 동작하는 내부 도구용 고정 키 방식. 두 값이 모두 설정되어야 활성화된다 | 수동 |
| `MCP_RESPONSE_MAX_CHARS` | `40000` | MCP 도구 응답 1건의 상한(글자 수) | 수동 |
| `DAV_ALLOW_ACCOUNT_PASSWORD` | `false` | CalDAV·CardDAV 에 계정 비밀번호도 허용한다(기본은 앱 비밀번호만 허용). 2단계 인증 사용자는 이 경우에도 제외된다 | 수동 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | (비움) | 웹 푸시 키. 비우면 backend 가 생성해 DB 에 저장한다 | 수동 |

### 기타

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `BRAND_LOGO` / `BRAND_COLOR` | (비움) / `#3B82F6` | 로고 주소 · 테마 색(관리 › 브랜딩의 값이 우선한다) | 수동 |
| `UPLOAD_MAX_SIZE_MB` | `5120` | 파일 1개의 업로드 상한(MB) | 수동 |
| `JW_HOST_REPO` | (비움) | 관리 › 앱 빌드가 사용할 호스트의 리포 경로. 비우면 앱 빌드가 비활성화된다 | 수동 |
| `ANDROID_APP_ID` | (비움 = 접속 주소에서 생성한다) | 관리 › 앱 빌드의 안드로이드 앱 ID — [apps/README.md](../apps/README.md) | 수동 |
| `GPU_HOST_IP` | (비움) | backend 컨테이너의 `host.docker.internal` 이 가리킬 주소(플러그인이 다른 장비의 서비스를 호출하는 경우) | 수동 |
| `JW_SOURCE_URL` | (비움 = 원래 리포) | 화면의 "소스 코드" 링크가 가리키는 주소(http·https). 로그인 화면 바닥글, 설정 › 계정, 관리 › 서비스 상태에 표시되며 `/api/health` 의 `source_url` 로 제공된다. **수정본으로 서비스를 제공하는 경우 수정된 소스 코드의 주소로 변경한다**(AGPL-3.0-or-later 13조) | 설치 관리자에 지정한 값(`-e JW_SOURCE_URL`). 지정하지 않으면 해당 줄을 기록하지 않는다(= 원래 리포) |
| `JW_SITE_CA_FILE` | `/etc/ssl/certs/jw-site-ca.pem` | backend 컨테이너 내의 파일 경로. 이 파일(PEM 인증서)이 존재하면 backend 가 기동 시 시스템 CA 번들에 추가해 `SSL_CERT_FILE` 로 사용한다 — 사설 CA 가 발급한 인증서를 사용하는 주소로의 HTTPS 요청을 신뢰하도록 구성하기 위함이다. `SSL_CERT_FILE` 을 직접 지정한 경우에는 변경하지 않는다 | 업로드한 인증서의 발급 CA 가 확인되는 경우 해당 파일을 이 경로에 마운트한다([installer.md](installer.md) 15절) |
| `NETLAB_URL` | (비움) | 별도 출처의 실습 환경(NetLab) 주소(https). 설정하면 대시보드와 앱 다운로드 화면에 연결 항목이 표시된다 | 수동 |

데스크톱·모바일 앱 빌드 시의 변수는 [apps/README.md](../apps/README.md) 와 [apps/desktop/README.md](../apps/desktop/README.md)를 참조한다.

## 2. 설치 관리자 컨테이너의 환경변수

`docker run … -e <이름>=<값>` 으로 설치 관리자에 지정하는 값이다. 상세는 [installer.md](installer.md)를 참조한다.

| 변수 | 기본 | 설명 |
|---|---|---|
| `JW_HOST_DIR` | (필수) | 설치 폴더의 호스트 경로. `-v <폴더>:/data` 와 동일한 경로여야 한다 |
| `JW_REGISTRY` | `ghcr.io/just-workspace` | 자체 빌드 이미지를 pull 할 저장소. `localhost` 이면 서버에 이미 존재하는 이미지를 사용한다 |
| `JW_INSTALLER_VERSION` | 이미지에 포함된 `VERSION` | 설치 관리자가 자신과 설치 대상 제품의 버전으로 인식하는 값. 이미지 태그와 동일하게 지정한다 — 승격한(Beta → Stable) 이미지는 내부의 `VERSION` 이 Beta 의 문자열이다 |
| `JW_IMAGE_TAG` | 제품 버전 | pull 할 이미지의 태그 |
| `JW_SOURCE_URL` | 원래 리포 | "소스 코드" 링크의 주소. 설치 마법사에 표시되며, 스택의 `.env` 로 전달되어 워크스페이스 화면에도 사용된다. 수정본으로 서비스를 제공하는 경우 수정된 소스 코드의 주소를 지정한다. 한 번 지정한 값은 설치 폴더에 저장되어 업데이트·구역 작업·백업에서 복원 이후에도 유지된다(다른 값을 지정하면 변경된다. 원래 리포로 복원하려면 해당 주소를 직접 지정한다) |
| `JW_PUBLIC_HOST` | (비움) | 로그의 주소와 설치 관리자의 인증서에 사용할 서버 주소 |
| `JW_UPDATE_CHANNEL_URL` | 공식 채널 | 업데이트 채널 파일을 조회하는 기준 주소 |
| `JW_UPDATE_OFFLINE_URL` | 릴리스 도구의 기본값 | 오프라인 번들을 다운로드하는 주소 템플릿(`{version}`·`{filename}`) |
| `JW_UPDATE_UPLOAD_MAX` | 64 GB | 오프라인 번들·이미지 파일의 업로드 상한(바이트) |
| `JW_ADMIN_PASSWORD` · `JW_MAIL_PASSWORD` · `JW_AI_API_KEY` | — | 무인 설치(`jw apply`)에서 응답 파일에 기재하지 않는 비밀값. `docker exec --env-file` 로 전달한다 |
| `JW_BACKUP_PASSWORD` | — | 설정이 암호로 보호된 백업의 복원 시 사용하는 암호 |

## 3. 비밀값 — 기동 검사와 생성기

backend 는 **취약하거나 기본값인 비밀값으로는 기동하지 않는다.** 컨테이너 시작 시(`python -m app.cli check-secrets`)와 앱 기동 시 동일한 규칙표(`backend/app/security_defaults.py`)로 검사하며, 거부한 변수마다 이름과 사유를 한 줄씩 로그에 기록한다(값은 출력하지 않는다). SSO·LDAP 컨테이너도 동일한 규칙으로 자체 비밀값을 검사한다.

거부 조건: 빈 값(필수 항목) · `CHANGE_ME…` 자리표시자 · 널리 알려진 기본값(`devkey`, `secret`, `changeme`, `password`, `admin` …) · 길이 미달 · 동일 문자 반복. 구역이 비활성화되어 사용되지 않는 값은 검사하지 않는다.

| 변수 | 최소 길이 | 필수 | 검사 시점 |
|---|---|---|---|
| `SECRET_KEY` | 32 | 예 | 항상 |
| `DB_PASSWORD`(`DATABASE_URL` 내의 비밀번호 포함) | 16 | 예 | 항상 |
| `INTERNAL_API_KEY` | 32 | 아니오(비우면 내부 API 비활성화) | 값이 있는 경우. 세로선·`&`·`/`·역슬래시·공백·따옴표 금지(메일 서버 스크립트가 치환한다) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | 16 / 32 | 아니오(비우면 회의 비활성화) | 구역 `meetings` + 값이 있는 경우 |
| `AUDIORELAY_SECRET` | 32 | 아니오 | 구역 `chat`+`meetings` + 값이 있는 경우 |
| `DOVECOT_MASTER_PASSWORD` | 16 | 아니오 | 구역 `mail` + 값이 있는 경우 |
| `ONLYOFFICE_JWT_SECRET` | 32 | 아니오 | 구역 `docs` + 값이 있는 경우 |
| `SANDBOX_TOKEN` / `DOCCONV_TOKEN` / `SEARXNG_SECRET` | 32 | 아니오 | 구역 `ai` + 값이 있는 경우 |
| `MCP_API_KEY` | 32 | 아니오 | 구역 `ai` + `MCP_INTERNAL_TOOLS_ENABLED=true` + 값이 있는 경우 |
| `GITEA_WEBHOOK_SECRET` | 32 | 아니오 | 구역 `chat` + 값이 있는 경우 |
| `LDAP_SERVICE_PASSWORD` | 16 | `LDAP_SERVICE_USER` 가 설정된 경우(LDAP 컨테이너가 검사) | 구역 `sso` + 값이 있는 경우 |
| `SMTP_PASSWORD` | — | 아니오 | 자리표시자·알려진 기본값만 거부(외부 계정일 수 있으므로 길이는 검사하지 않는다) |

생성기 — 값은 16진수이므로 셸·URL 어디에 사용하더라도 이스케이프가 필요하지 않다(키 48자, 비밀번호 32자). 설치 관리자도 이 생성기를 호출한다.

```bash
python -m app.cli gen-secrets                         # 기본 생성 대상 전부를 KEY=value 로 출력
python -m app.cli gen-secrets --format json
python -m app.cli gen-secrets --only SECRET_KEY DB_PASSWORD
python -m app.cli gen-secrets --merge .env            # .env 의 빈(또는 CHANGE_ME) 비밀값만 채운 내용을 출력
python -m app.cli gen-secrets --merge .env --in-place # 파일에 바로 쓴다(값은 화면에 찍지 않는다)
python -m app.cli check-secrets                       # 기동 검사와 같은 판정, 문제가 있으면 종료 코드 1

# 컨테이너를 띄우기 전(이미지만 있을 때)
docker run --rm -v "$PWD/.env:/work/.env" <backend 이미지> python -m app.cli gen-secrets --merge /work/.env --in-place
```

기본 생성 대상은 표의 `SECRET_KEY` 부터 `SEARXNG_SECRET` 까지이며, 그 이하의 항목은 `--only` 로 지정한 경우에만 생성한다. 이미 값이 있는 줄은 변경하지 않는다. `DB_PASSWORD` 는 DB 볼륨의 최초 생성 시에만 적용되므로, 운영 중인 설치에서 변경하려면 PostgreSQL 측 비밀번호도 함께 변경하여야 한다.

### 관리자 계정 명령

설치 관리자로 설치한 서버에서는 `docker exec jw-installer jw reset-admin <아이디> [--disable-2fa]` 를 사용한다. 직접 구성한 서버에서는 다음 명령을 사용한다.

```bash
docker compose exec backend python -m app.cli seed-admin --username <아이디>      # 비밀번호는 물어본다(.env 에 남기지 않는다)
docker compose exec backend python -m app.cli reset-admin <아이디>                # 임시 비밀번호 발급 — 화면에 한 번만 나온다
docker compose exec backend python -m app.cli reset-admin <아이디> --disable-2fa  # 인증 앱도 잃어버렸을 때
```

- `ADMIN_USERNAME`/`ADMIN_PASSWORD` 에 의한 자동 생성은 사용자가 한 명도 없는 경우에만 실행된다. 이후에는 값이 남아 있더라도 어떠한 동작도 수행하지 않는다.
- 동일한 이름의 일반 계정이 이미 존재하면 관리자로 승격하지 않고 경고만 기록한다. 서버에서 명시적으로 승격하려면 `seed-admin --username <아이디> --promote` 를 사용한다.
- `reset-admin` 은 관리자 계정에만 사용한다(일반 계정은 거부한다 — 관리 화면에서 재설정한다). 해당 계정의 활성 세션과 앱 토큰은 모두 무효화된다.

## 4. `OAUTH_CLIENTS_JSON` — 정적 클라이언트

backend 의 OAuth 제공자에 사전 등록하는 클라이언트 맵이다(코드 저장소 로그인 · claude.ai MCP 커넥터 등).
**동적 클라이언트 등록(DCR, RFC 7591)은 구현되어 있다** — discovery 가 `registration_endpoint`(`APP_URL/oauth/register`)를 광고하며,
claude.ai 등의 MCP 클라이언트는 커넥터 URL 을 입력하고 로그인하면 자동 등록된다. 동적 클라이언트는 `mcp:read` 전용 및 https 정확 일치
redirect_uri 로 제한되며 시크릿은 해시로 저장된다. 정적 맵은 코드 저장소 로그인 또는 `mcp:write` 가 필요한 고정 클라이언트에 사용한다.
데스크톱 앱 클라이언트(`desktop-app`, public + 루프백 리다이렉트)는 backend 에 내장되어 있으므로 등록할 필요가 없다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `secret` | 예 | 클라이언트 시크릿. 상수 시간 비교 |
| `redirect_uris` | 예 | 콜백 허용 목록. **정확 일치만 허용**(와일드카드/prefix 금지). public 클라이언트의 루프백은 포트를 무시한다(RFC 8252) |
| `scopes` | 권장 | 요청 가능한 최대 스코프. 초과 요청은 `/authorize` 에서 거부한다. 생략하면 OIDC 전용 클라이언트로 취급한다 |
| `public` / `trusted` | 아니오 | public = 시크릿 없이 PKCE 만 사용, trusted = 동의 화면 생략(1st-party) |
| `backchannel_logout_uri` | 아니오 | OpenID Connect Back-Channel Logout 1.0. 워크스페이스 세션이 종료되면(로그아웃·기기 연결 해제·비밀번호 변경/재설정·강제 로그아웃·정지·삭제·유휴 만료) 이 주소로 `logout_token` 을 POST 한다. https 만 허용한다(http 는 사설 IP·점이 없는 내부 호스트명인 경우에 한함). **정적 클라이언트 전용** — DCR 클라이언트에는 허용하지 않는다(SSRF 방지) |
| `backchannel_logout_session_required` | 아니오 | `true` 이면 RP 가 `sid` 를 요구함을 의미한다. 본 소프트웨어는 항상 `sub`+`sid` 를 함께 포함한다. Redis 장애로 세션 추적 정보를 조회할 수 없으면 `sub` 만 포함한 토큰으로 폴백하나, 이 값이 `true` 인 RP 에는 해당 폴백을 전송하지 않는다 |

claude.ai 커넥터 고정 등록 예(읽기 전용):

```json
{
  "claude-mcp": {
    "secret": "<openssl rand -hex 24>",
    "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
    "scopes": ["mcp:read"]
  }
}
```

별도 출처 앱(`lab.example.com`, 그룹별 할당량 + 로그아웃 전파) 예:

```json
{
  "lab-app": {
    "secret": "<openssl rand -hex 24>",
    "client_name": "실습 환경",
    "trusted": true,
    "redirect_uris": ["https://lab.example.com/auth/callback"],
    "scopes": ["openid", "profile", "email", "groups"],
    "backchannel_logout_uri": "https://lab.example.com/auth/backchannel-logout",
    "backchannel_logout_session_required": true
  }
}
```

- `groups` 스코프가 부여된 토큰의 ID 토큰·UserInfo `groups` 에는 실제 워크스페이스 그룹 **이름**(정렬됨)이 포함된다. 관리자인 경우 선두에 `"admin"` 이 추가된다.
  해당 스코프가 부여되지 않은 클라이언트에는 `["admin"]` 또는 `[]` 만 제공된다. 이름이 `admin`(대소문자 무시)인 그룹은 관리자 표시와의 혼동을 방지하기 위해 제외된다.
  그룹 이름을 변경하면 RP 측 매핑도 변경된다.
- ID 토큰에는 `sid`(워크스페이스 세션에서 HMAC 으로 파생한 값 — 원래 세션 id 는 노출되지 않는다)가 포함된다. `logout_token` 의 `sid` 와 동일하다.
- `logout_token`: RS256(JWKS 와 동일한 키), 헤더 `typ: logout+jwt`, 클레임 `iss`·`aud`(client_id)·`iat`·`exp`(2분)·`jti`·`events`(`http://schemas.openid.net/event/backchannel-logout`)·`sub`·`sid`, `nonce` 없음.
  `application/x-www-form-urlencoded` 의 `logout_token=` 으로 POST 한다. 타임아웃 3초, 실패(네트워크·5xx) 시 1초·3초 후 2회 재시도, 4xx 는 RP 의 거부로 간주해 재시도하지 않는다. 리다이렉트는 추적하지 않는다.
  전송은 백그라운드로 수행되므로 **실패하더라도 워크스페이스 로그아웃은 정상 완료된다**. 백엔드 컨테이너에서 이 주소로의 아웃바운드 연결이 가능하여야 한다(DNS·방화벽·헤어핀).
- RP 는 서명·`iss`·`aud`·`iat`·`events`·`typ` 을 검증하고 `jti` 재사용을 거부한 후 해당 `sid`(없으면 해당 `sub` 전체) 세션을 종료하고 200 을 반환한다.

읽기+쓰기는 `"scopes": ["mcp:read", "mcp:write"]` 로 지정한다. Gitea 항목과 단일 JSON 으로 병합할 수 있다.

- access token 은 MCP 플로우인 경우 `aud`(리소스 URL, RFC 8707)와 `scope` 클레임을 포함한다. 코드 저장소 로그인용 토큰에는 `aud` 가 없다. MCP 스코프 요청에는 PKCE(S256)가 필수다.
- ID 토큰은 RS256 이며 키는 `/oauth/jwks.json` 으로 제공된다. discovery 는 `claims_supported`·`backchannel_logout_supported`·`backchannel_logout_session_supported` 도 광고한다.
- 디스커버리: `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`(루트), `/oauth/.well-known/openid-configuration`(코드 저장소가 사용한다),
  보호 리소스 메타데이터(RFC 9728) `/.well-known/oauth-protected-resource[/api/mcp/read]`.

## 5. 리포 제외 대상 (`.gitignore`)

- `.env` 와 그 사본(비밀값)
- 직접 작성한 플러그인(`plugins/<이름>/`), `nginx/private.d/*`
- 설치 시 환경별로 생성되는 파일 — `livekit/livekit.yaml`, `nginx/state/`, `mailserver/config/` 의 계정·키
