# 설정 변수

Just Workspace 의 환경별 값은 스택의 `.env` 파일에 있다. 소스에 환경 고정값은 없다.

- **설치 관리자로 설치했다면 `.env` 를 손으로 고칠 일은 거의 없다.** 설치 관리자가 답변에서 만들고(`<설치 폴더>/stack/.env`, 권한 600), 구역을 켜고 끌 때와 업데이트할 때 다시 쓴다. 변수마다 어떤 값이 들어가는지는 [installer.md](installer.md) 8절의 표가 기준이다.
- 설치 관리자 없이 직접 띄울 때는 `.env.example` 을 복사해 채운다 — [deployment.md](deployment.md).
- 기준이 되는 코드: `backend/app/config.py`(backend 가 읽는 값), `docker-compose.yml`(compose 가 치환하는 값), `backend/app/security_defaults.py`(비밀값 규칙), `installer/app/render.py`(설치 관리자가 쓰는 값).

"출처" 열은 설치 관리자로 설치했을 때 그 값이 어디서 오는지다.

| 출처 | 뜻 |
|---|---|
| 생성 | 설치 관리자가 비밀값 생성기로 만든다 |
| 답변 | 설치 마법사·답변 파일의 답에서 그대로 |
| 파생 | 답변과 감지값에서 계산한다 |
| 고정 | 설치 관리자가 정한 값 |
| 구역 | 구역을 켤 때 설치 관리자가 채운다 |
| 수동 | 설치 관리자가 쓰지 않는다. 필요하면 `.env` 에 직접 적는다(비우면 기본값) |

## 1. `.env` 변수

### 구성

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `COMPOSE_PROFILES` | (비움) | 띄울 컨테이너의 compose 프로파일(쉼표): `mailserver` `gitea` `livekit` `egress` `audiorelay` `onlyoffice` `aitools` `sso` `rbi` `certbot`. 구역과의 대응은 [deployment.md](deployment.md#구역-compose_profiles-와-jw_zones) | 파생 |
| `JW_ZONES` | (비움 = 전부) | 설치된 구역(쉼표): `mail` `chat` `calendar` `docs` `meetings` `git` `ai`, 애드온 `sso` `rbi`. 적지 않은 구역은 API 가 404 이고 메뉴에 나오지 않는다. 선언은 `backend/app/zones.json` | 파생(`core,<구역들>`) |
| `APP_URL` | `http://localhost` | 접속 주소(`https://<접속 주소>`). OAuth 발급자 주소이기도 하다 | 파생 |
| `DOMAIN` | `localhost` | 계정의 메일 주소에 붙는 도메인(`<아이디>@DOMAIN`). 내장 메일이면 메일 도메인, 아니면 접속 주소 | 파생 |
| `APP_NAME` | `Workspace` | 표시 이름(관리 › 브랜딩에서 바꾼다) | 고정 |
| `DEBUG` | `false` | 디버그 | 고정 |
| `STORAGE_VOLUME` | `ws-storage-data` | 파일 저장소 볼륨 이름. compose 는 이 볼륨을 이미 있는 것(`external`)으로 쓴다 | 고정 |
| `STORAGE_MARKER_REQUIRED` | (비움) | `1` 이면 저장소 표식(`.jw-storage`)이 안 보일 때 파일 쓰기를 503 으로 거부한다 | 고정(`1`) |
| `JW_INSTALL_ID` | (비움) | 설치 id — 저장소 표식과 맞아야 한다 | 고정 |
| `JW_NET_PREFIX` | `172.28.0` | 내부 대역(/24)의 앞 세 자리 | 답변 |
| `JW_REGISTRY` / `JW_VERSION` | `localhost` / `latest` | 우리 이미지의 저장소와 태그(`<JW_REGISTRY>/just-workspace-<이름>:<JW_VERSION>`) | 고정 |
| `JW_APP_VERSION` | (비움) | 화면에 보이는 제품 버전. 이미지에 구운 값보다 우선한다 | 고정 |
| `JW_INSTALLER_URL` / `JW_INSTALLER_KEY` | (비움) | backend 가 설치 관리자의 내부 API 를 부르는 주소와 키. 비어 있으면 관리 › 구역·업데이트가 읽기 전용이다 | 고정 / 생성 |
| `JW_MIGRATE_ON_START` | (비움 = 켬) | `0` 이면 backend 가 뜰 때 DB 스키마를 건드리지 않고 버전만 확인한다 — [data-safety.md](data-safety.md) | 수동 |
| `BACKEND_WORKERS` | (비움) | backend 워커 수. 비우면 `min(8, max(2, 코어 수))` | 파생(메모리 6 GB 미만이면 2) |
| `BACKEND_CPUS` | (비움) | backend 컨테이너의 CPU 상한(예 `4.0`). 비우면 제한 없음 | 수동 |
| `BACKUP_VOLUME` | `backups-vol` | 백업이 쌓이는 볼륨(실제 이름 `ws-backups`). 호스트 경로를 적어 다른 디스크로 돌릴 수 있다 | 수동 |
| `DEPLOY_MODE` | — | 설치 관리자가 `.env` 에 적어 두는 표시값(`standalone`/`external_proxy`). compose 와 backend 는 읽지 않는다 — 직접 띄울 때는 적지 않는다(`.env.example` 에 없다) | 파생 |
| `COMPOSE_PROJECT_NAME` | — | compose 프로젝트 이름 | 고정(`just-workspace`) |

### 접속과 보안

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `SECRET_KEY` | — | 세션 서명, DB 안 값의 암호화 키. **바꾸면 암호화된 값을 풀 수 없다.** SSO 컨테이너와 같은 값 | 생성 |
| `INTERNAL_API_KEY` | (비움) | backend 내부 API(`/api/internal/*`) 키 — 메일 서버의 로그인 확인과 LDAP 컨테이너가 쓴다. 비우면 내부 API 가 닫힌다 | 생성 |
| `JW_ALLOW_INSECURE_DEFAULTS` | (비움) | `1` 이면 약한·기본 비밀값을 거부하지 않고 경고만 남긴다. **개발·테스트 전용** | 수동 |
| `RP_LAN_IP` / `HAIRPIN_HOST` | (비움) | 컨테이너(코드 저장소·문서 편집기)가 접속 주소로 되돌아올 때 쓸 주소와 그 이름. 문서 편집기의 허용 주소에도 들어간다 | 파생 |
| `DOMAIN_ALIAS` | (비움) | 같은 앱을 다른 도메인으로도 받을 때 그 이름 | 수동 |
| `ALLOW_NATIVE_APP_ORIGINS` | `false` | 화면을 앱 안에 넣어 빌드한 모바일 앱의 출처를 허용 목록에 넣는다 | 수동 |
| `CSRF_ORIGIN_CHECK` | `true` | 쿠키로 인증된 변경 요청의 출처 검사 | 수동 |
| `CSRF_TRUSTED_ORIGINS` | (비움) | 추가로 믿을 출처(쉼표) | 수동 |
| `SSL_CERT_PATH` / `SSL_CHECK_HOST` | (비움) | 관리 개요의 인증서 만료 표시가 볼 인증서 파일 / 대신 붙어 볼 내부 주소(앞단 프록시 구성용) | 수동 |
| `LETSENCRYPT_EMAIL` | — | 인증서 발급 연락처 | 답변 또는 파생(`admin@DOMAIN`) |
| `ACME_DOMAINS` | (비움 = `mail.`·`turn.`·도메인) | 인증서에 들어갈 이름(쉼표, 첫 이름이 접속 주소). DNS 에 없는 이름이 섞이면 발급 전체가 실패한다 | 파생 |

### 데이터베이스

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `DB_NAME` / `DB_USER` | `workspace` | PostgreSQL 데이터베이스·사용자 | 고정 |
| `DB_PASSWORD` | — | DB 비밀번호. **DB 볼륨을 처음 만들 때만 적용된다** | 생성 |
| `DATABASE_URL` | (비움) | 비우면 compose 가 위 세 값으로 조립한다. 바깥 DB 를 쓸 때만 적는다 | 고정(비움) |
| `REDIS_URL` | `redis://redis:6379/0` | compose 가 넣는다 | — |

파일을 어디에 저장할지(이 서버의 디스크·NFS)는 변수가 아니라 저장소 볼륨을 어떻게 만들었느냐로 정해진다([installer.md](installer.md) 8절). S3 호환 저장소는 관리 › 저장소·백업에서 설정한다.

### 관리자

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `ADMIN_EMAILS` | (비움) | 이 메일 주소의 계정에 관리자 권한을 준다(쉼표) | 파생(`<관리자 아이디>@DOMAIN`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | (비움) | 첫 기동 때의 관리자 만들기 — **사용자가 한 명도 없을 때만** 돈다. 만든 뒤 지운다. 비워 두면 웹의 최초 설정 화면에서 설정 토큰으로 만든다([deployment.md](deployment.md#첫-관리자-만들기)) | 쓰지 않음(설치 관리자는 `seed-admin` 으로 만든다) |

### 메일

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `FEATURE_BUILTIN_MAILSERVER` | `false` | 내장 메일 서버를 쓴다(계정을 승인하면 메일함이 함께 만들어진다) | 파생 |
| `DOVECOT_MASTER_USER` / `DOVECOT_MASTER_PASSWORD` | (비움) | 내장 메일 서버의 마스터 계정 | 고정(`portal`) / 생성 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | `mailserver` / `587` / … | 시스템 메일(초대, 비밀번호 재설정)을 보내는 서버. 내장이면 `noreply@<메일 도메인>` 과 생성한 비밀번호, 외부면 답변 | 파생·답변·생성 |
| `MAIL_SSL_TYPE` | `letsencrypt` | 메일 서버가 인증서를 찾는 방식 | 고정 |
| `MAIL_MESSAGE_SIZE_LIMIT` | `104857600` | 메일 한 통의 크기 상한(바이트) | 수동 |
| `MAIL_HEALTH_HOST` | (비움) | 서비스 상태가 살펴볼 바깥 메일 서버(`host` 또는 `host:port`) | 수동 |
| `MAIL_POLL_INTERVAL` | `120` | 외부 메일 계정의 새 메일 확인 간격(초) | 수동 |
| `MAIL_PRIVATE_HOST_ALLOWLIST` | (비움) | 사용자가 외부 메일 계정으로 연결할 수 있는 사설 주소(호스트 이름·CIDR, 쉼표). 기본은 사설 주소로의 연결을 막는다 | 수동 |

### 구역별

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `GITEA_URL` / `GITEA_EXTERNAL_URL` | `http://gitea:3000` / `APP_URL/git/` | 코드 저장소의 내부 주소 / 브라우저가 여는 주소 | 고정 / 파생 |
| `GITEA_TOKEN` | (비움) | backend 가 코드 저장소 API 를 부르는 관리 토큰 | 구역 |
| `GITEA_IMAGE` | (비움 = compose 에 고정한 검증된 버전) | 코드 저장소 이미지 | 답변 |
| `GIT_SSH_PORT` / `GIT_SSH_DOMAIN` | `2222` / `DOMAIN` | Git SSH 의 호스트 포트 / 주소에 표시할 이름 | 고정 / 파생 |
| `GITEA_DATA_PATH` | `gitea-data` 볼륨 | 코드 저장소 데이터를 둘 볼륨 또는 호스트 경로 | 수동 |
| `GITEA_WEBHOOK_SECRET` / `GITEA_WEBHOOK_CHANNEL` | (비움) / `git-notifications` | 코드 저장소 웹훅을 채팅 채널로 받을 때의 서명 키와 채널 | 수동 |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | (비움) | 회의 서버 인증. 비우면 회의가 꺼진다 | 생성 |
| `LIVEKIT_URL` / `LIVEKIT_WS_URL` | `http://livekit:7880` / (`APP_URL` 에서 파생) | 회의 서버의 내부 주소 / 브라우저가 붙는 주소 | 고정 / 수동 |
| `LIVEKIT_TURN_TLS_PUBLISH` | `443` | 회의 중계의 보안 연결(TURN/TLS)을 게시할 호스트 포트 | 파생(프록시 뒤 443, 그 밖 5349) |
| `AUDIORELAY_SECRET` | (비움) | 무손실 오디오 릴레이의 토큰 서명 키 | 생성 |
| `AUDIORELAY_WT_PUBLIC_URL` | (비움) | WebTransport 공개 주소. 비우면 WebSocket 만 쓴다 — [voice-lossless.md](voice-lossless.md) | 파생 |
| `AUDIORELAY_WT_PORT` / `AUDIORELAY_WT_CERT` / `AUDIORELAY_WT_KEY` | `4433` / 인증서 볼륨의 경로 | WebTransport 의 UDP 포트와 인증서 | 고정 / 파생 |
| `AUDIORELAY_WT_SELF_SIGNED_HOSTS` | `127.0.0.1,localhost` | 인증서가 없을 때 만드는 자체 서명 인증서의 이름(시험용) | 수동 |
| `ONLYOFFICE_JWT_SECRET` | (비움) | 문서 편집기와 backend 사이의 서명 키 | 생성 |
| `ONLYOFFICE_URL` / `WOPI_TOKEN_TTL` | `http://onlyoffice:80` / `7200` | 문서 편집기의 내부 주소 / 편집 토큰 수명(초) | 수동 |
| `SEARXNG_SECRET` | (비움) | 웹 검색 컨테이너의 비밀값 | 생성 |
| `SEARXNG_URL` | `http://searxng:8080` | 웹 검색 컨테이너의 내부 주소 | 수동 |
| `SANDBOX_TOKEN` / `DOCCONV_TOKEN` | (비움) | 코드 실행·문서 변환 컨테이너와 backend 가 나누는 비밀값 | 생성 |
| `SANDBOX_CONCURRENCY` / `SANDBOX_MAX_TIMEOUT` / `SANDBOX_MEM_MB` | `2` / `120` / `1536` | 코드 실행의 동시 실행 수 · 최대 초 · 실행당 메모리(MB) | 수동 |
| `DOCCONV_CONCURRENCY` / `DOCCONV_TIMEOUT` / `DOCCONV_MAX_MB` | `2` / `120` / `100` | 문서 변환의 동시 수 · 초 · 파일 크기(MB) | 수동 |
| `CHAT_PERMISSIONS_ENGINE` | `shadow` | 채팅 역할·권한 엔진 `legacy`/`shadow`/`enforce` — [chat-permissions.md](chat-permissions.md) | 수동 |
| `LDAP_PLAIN_BIND` | `127.0.0.1` | LDAP 컨테이너의 평문 389 를 게시할 주소. 밖으로는 LDAPS(636)만 연다. 평문만 되는 장비가 내부망에 있을 때만 그 망의 서버 주소(예 `192.168.10.20`)를 적는다 | 고정 |
| `LDAP_SERVICE_USER` / `LDAP_SERVICE_PASSWORD` | (비움) | LDAP 디렉터리를 읽어 가는 서비스 계정(LDAP 컨테이너가 읽는다) | 수동 |

격리 브라우저(`RBI_*`)는 변수가 많아 [rbi.md](rbi.md)에 따로 있다. 설치 관리자는 `RBI_PUBLIC_ORIGIN`(`https://rbi.<접속 주소>`), `RBI_PUBLISH_IP`(내부 대역의 `.1`), `RBI_PROTECTED`(감지한 이 서버의 주소와 기본 게이트웨이)를 채우고 나머지는 기본값을 쓴다.

### 인증·연동

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `OAUTH_CLIENTS_JSON` | `{}` | 미리 등록한 OAuth 클라이언트([4절](#4-oauth_clients_json--정적-클라이언트)). 코드 저장소 구역을 켜면 `gitea` 항목이 들어간다 | 구역 |
| `OAUTH_DYNAMIC_CLIENTS_MAX` | `500` | 동적 등록(RFC 7591) 클라이언트의 전체 상한 | 수동 |
| `MCP_PUBLIC_URL` | (비움 = `APP_URL`) | MCP 리소스 서버의 공개 주소(전용 하위 도메인을 쓸 때) — [CONNECTOR.md](CONNECTOR.md) | 고정(비움) |
| `MCP_INTERNAL_TOOLS_ENABLED` / `MCP_API_KEY` | `false` / (비움) | 사용자 없이 도는 내부 도구용 고정 키 방식. 둘 다 있어야 켜진다 | 수동 |
| `MCP_RESPONSE_MAX_CHARS` | `40000` | MCP 도구 응답 하나의 상한(글자 수) | 수동 |
| `DAV_ALLOW_ACCOUNT_PASSWORD` | `false` | CalDAV·CardDAV 에 계정 비밀번호도 받는다(기본은 앱 비밀번호만). 2단계 인증 사용자는 그래도 제외 | 수동 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | (비움) | 웹 푸시 키. 비우면 backend 가 만들어 DB 에 둔다 | 수동 |

### 그 밖

| 변수 | 기본 | 설명 | 출처 |
|---|---|---|---|
| `BRAND_LOGO` / `BRAND_COLOR` | (비움) / `#3B82F6` | 로고 주소 · 테마 색(관리 › 브랜딩의 값이 우선한다) | 수동 |
| `UPLOAD_MAX_SIZE_MB` | `5120` | 파일 하나의 올리기 상한(MB) | 수동 |
| `JW_HOST_REPO` | (비움) | 관리 › 앱 빌드가 쓸 호스트의 리포 경로. 비우면 앱 빌드가 꺼진다 | 수동 |
| `ANDROID_APP_ID` | (비움 = 접속 주소에서 만든다) | 관리 › 앱 빌드의 안드로이드 앱 ID — [apps/README.md](../apps/README.md) | 수동 |
| `GPU_HOST_IP` | (비움) | backend 컨테이너의 `host.docker.internal` 이 가리킬 주소(다른 머신의 서비스를 플러그인이 부를 때) | 수동 |
| `JW_SOURCE_URL` | (비움 = 원래 리포) | 화면의 "소스 코드" 링크가 가리키는 주소(http·https). 로그인 화면 바닥글, 설정 › 계정, 관리 › 서비스 상태에 보이고 `/api/health` 의 `source_url` 로 나간다. **고쳐서 서비스하면 고친 소스의 주소로 바꾼다**(AGPL-3.0-or-later 13조) | 설치 관리자에 준 값(`-e JW_SOURCE_URL`), 없으면 비움 |
| `NETLAB_URL` | (비움) | 별도 출처의 실습 환경(NetLab) 주소(https). 있으면 대시보드와 앱 내려받기 화면에 연결 항목이 보인다 | 수동 |

데스크톱·모바일 앱을 빌드할 때의 변수는 [apps/README.md](../apps/README.md) 와 [apps/desktop/README.md](../apps/desktop/README.md).

## 2. 설치 관리자 컨테이너의 환경변수

`docker run … -e <이름>=<값>` 으로 설치 관리자에 주는 값이다. 자세한 것은 [installer.md](installer.md).

| 변수 | 기본 | 설명 |
|---|---|---|
| `JW_HOST_DIR` | (필수) | 설치 폴더의 호스트 경로. `-v <폴더>:/data` 와 같은 경로여야 한다 |
| `JW_REGISTRY` | `ghcr.io/just-workspace` | 우리 이미지를 받을 저장소. `localhost` 면 서버에 이미 있는 이미지를 쓴다 |
| `JW_INSTALLER_VERSION` | 이미지에 든 `VERSION` | 설치 관리자가 자신과 설치할 제품의 버전으로 아는 값. 이미지 태그와 같게 적는다 — 승격한(Beta → Stable) 이미지는 안의 `VERSION` 이 Beta 의 글자다 |
| `JW_IMAGE_TAG` | 제품 버전 | 받을 이미지의 태그 |
| `JW_SOURCE_URL` | 원래 리포 | "소스 코드" 링크의 주소. 설치 마법사에 보이고, 스택의 `.env` 로 넘겨 워크스페이스 화면에도 쓰인다. 고쳐서 서비스하면 고친 소스의 주소로 |
| `JW_PUBLIC_HOST` | (비움) | 로그의 주소와 설치 관리자의 인증서에 쓸 서버 주소 |
| `JW_UPDATE_CHANNEL_URL` | 공식 채널 | 업데이트 채널 파일을 받는 기준 주소 |
| `JW_UPDATE_OFFLINE_URL` | 릴리스 도구의 기본값 | 오프라인 묶음을 받는 주소 틀(`{version}`·`{filename}`) |
| `JW_UPDATE_UPLOAD_MAX` | 64 GB | 오프라인 묶음·이미지 파일을 올릴 때의 상한(바이트) |
| `JW_ADMIN_PASSWORD` · `JW_MAIL_PASSWORD` · `JW_AI_API_KEY` | — | 무인 설치(`jw apply`)에서 답변 파일에 적지 않는 비밀. `docker exec --env-file` 로 넘긴다 |
| `JW_BACKUP_PASSWORD` | — | 설정이 암호로 보호된 백업을 복원할 때의 암호 |

## 3. 비밀값 — 기동 검사와 생성기

backend 는 **약한·기본 비밀값으로는 뜨지 않는다.** 컨테이너가 시작할 때(`python -m app.cli check-secrets`)와 앱이 뜰 때 같은 표(`backend/app/security_defaults.py`)로 검사하고, 거부한 변수마다 이름과 사유를 한 줄씩 로그에 남긴다(값은 찍지 않는다). SSO·LDAP 컨테이너도 같은 규칙으로 자기 비밀값을 검사한다.

거부 조건: 비어 있음(필수인 것) · `CHANGE_ME…` 자리표시자 · 널리 알려진 기본값(`devkey`, `secret`, `changeme`, `password`, `admin` …) · 길이 미달 · 같은 글자 반복. 구역이 꺼져 있어 쓰지 않는 값은 보지 않는다.

| 변수 | 최소 길이 | 필수 | 검사하는 때 |
|---|---|---|---|
| `SECRET_KEY` | 32 | 예 | 항상 |
| `DB_PASSWORD`(`DATABASE_URL` 안의 비밀번호 포함) | 16 | 예 | 항상 |
| `INTERNAL_API_KEY` | 32 | 아니오(비우면 내부 API 닫힘) | 값이 있을 때. 세로선·`&`·`/`·역슬래시·공백·따옴표 금지(메일 서버 스크립트가 치환한다) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | 16 / 32 | 아니오(비우면 회의 꺼짐) | 구역 `meetings` + 값이 있을 때 |
| `AUDIORELAY_SECRET` | 32 | 아니오 | 구역 `chat`+`meetings` + 값이 있을 때 |
| `DOVECOT_MASTER_PASSWORD` | 16 | 아니오 | 구역 `mail` + 값이 있을 때 |
| `ONLYOFFICE_JWT_SECRET` | 32 | 아니오 | 구역 `docs` + 값이 있을 때 |
| `SANDBOX_TOKEN` / `DOCCONV_TOKEN` / `SEARXNG_SECRET` | 32 | 아니오 | 구역 `ai` + 값이 있을 때 |
| `MCP_API_KEY` | 32 | 아니오 | 구역 `ai` + `MCP_INTERNAL_TOOLS_ENABLED=true` + 값이 있을 때 |
| `GITEA_WEBHOOK_SECRET` | 32 | 아니오 | 구역 `chat` + 값이 있을 때 |
| `LDAP_SERVICE_PASSWORD` | 16 | `LDAP_SERVICE_USER` 가 있으면(LDAP 컨테이너가 검사) | 구역 `sso` + 값이 있을 때 |
| `SMTP_PASSWORD` | — | 아니오 | 자리표시자·알려진 기본값만 거부(외부 계정일 수 있어 길이는 보지 않는다) |

생성기 — 값은 16진수라 셸·URL 어디에 넣어도 이스케이프가 필요 없다(키 48자, 비밀번호 32자). 설치 관리자도 이 생성기를 부른다.

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

기본 생성 대상은 표의 `SECRET_KEY` 부터 `SEARXNG_SECRET` 까지이고, 그 아래는 `--only` 로 지목했을 때만 만든다. 이미 값이 있는 줄은 건드리지 않는다. `DB_PASSWORD` 는 DB 볼륨을 처음 만들 때만 적용되므로, 이미 돌고 있는 설치에서 바꾸려면 PostgreSQL 쪽 비밀번호도 함께 바꿔야 한다.

### 관리자 계정 명령

설치 관리자로 설치한 서버에서는 `docker exec jw-installer jw reset-admin <아이디> [--disable-2fa]` 를 쓴다. 직접 띄운 서버에서는:

```bash
docker compose exec backend python -m app.cli seed-admin --username <아이디>      # 비밀번호는 물어본다(.env 에 남기지 않는다)
docker compose exec backend python -m app.cli reset-admin <아이디>                # 임시 비밀번호 발급 — 화면에 한 번만 나온다
docker compose exec backend python -m app.cli reset-admin <아이디> --disable-2fa  # 인증 앱도 잃어버렸을 때
```

- `ADMIN_USERNAME`/`ADMIN_PASSWORD` 로 하는 자동 만들기는 사용자가 한 명도 없을 때만 돈다. 그 뒤에는 값이 남아 있어도 아무것도 하지 않는다.
- 같은 이름의 일반 계정이 이미 있으면 관리자로 올리지 않고 경고만 남긴다. 서버에서 명시적으로 올리려면 `seed-admin --username <아이디> --promote`.
- `reset-admin` 은 관리자 계정에만 쓴다(일반 계정은 거부 — 관리 화면에서 재설정). 그 계정의 열린 세션과 앱 토큰은 모두 끊긴다.

## 4. `OAUTH_CLIENTS_JSON` — 정적 클라이언트

backend 의 OAuth 제공자가 아는, 미리 등록한 클라이언트 맵이다(코드 저장소 로그인 · claude.ai MCP 커넥터 등).
**동적 클라이언트 등록(DCR, RFC 7591)은 구현돼 있다** — discovery 가 `registration_endpoint`(`APP_URL/oauth/register`)를 광고하고,
claude.ai 같은 MCP 클라이언트는 커넥터 URL 만 넣고 로그인하면 자동 등록된다. 동적 클라이언트는 `mcp:read` 전용 + https 정확일치
redirect_uri 로 강제되고 시크릿은 해시 저장된다. 정적 맵은 코드 저장소 로그인이나 `mcp:write` 가 필요한 고정 클라이언트에 쓴다.
데스크톱 앱 클라이언트(`desktop-app`, public + 루프백 리다이렉트)는 backend 에 내장돼 있어 넣지 않아도 된다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `secret` | ✔ | 클라이언트 시크릿. 상수시간 비교 |
| `redirect_uris` | ✔ | 콜백 화이트리스트. **정확 일치만**(와일드카드/prefix 금지). public 클라이언트의 루프백은 포트 무시(RFC 8252) |
| `scopes` | 권장 | 요청 가능한 최대 스코프. 초과 요청은 `/authorize` 에서 거부. 생략하면 OIDC 전용 클라이언트로 본다 |
| `public` / `trusted` | X | public = 시크릿 없이 PKCE 만, trusted = 동의 화면 생략(1st-party) |
| `backchannel_logout_uri` | X | OpenID Connect Back-Channel Logout 1.0. 워크스페이스 세션이 끝나면(로그아웃·기기 끊기·비밀번호 변경/재설정·강제 로그아웃·정지·삭제·유휴 만료) 이 주소로 `logout_token` 을 POST. https 만(http 는 사설 IP·점 없는 내부 호스트명일 때만). **정적 클라이언트 전용** — DCR 클라이언트는 받지 않는다(SSRF 방지) |
| `backchannel_logout_session_required` | X | `true` 면 RP 가 `sid` 를 요구한다는 뜻. 우리는 항상 `sub`+`sid` 를 같이 싣는다. Redis 장애로 세션 추적을 못 읽으면 `sub` 만 담은 토큰으로 폴백하는데, 이 값이 `true` 인 RP 에는 그 폴백을 보내지 않는다 |

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

- `groups` 스코프를 받은 토큰의 ID 토큰·UserInfo `groups` 에는 실제 워크스페이스 그룹 **이름**(정렬)이 들어간다. 관리자면 맨 앞에 `"admin"`.
  스코프를 받지 않은 클라이언트는 `["admin"]` 또는 `[]` 만 본다. 이름이 `admin`(대소문자 무시)인 그룹은 관리자 표식과 섞이지 않게 빠진다.
  그룹 이름을 바꾸면 RP 쪽 매핑도 바뀐다.
- ID 토큰에 `sid`(워크스페이스 세션에서 HMAC 으로 파생한 값 — 원래 세션 id 는 나가지 않는다)가 들어간다. `logout_token` 의 `sid` 와 같다.
- `logout_token`: RS256(JWKS 와 같은 키), 헤더 `typ: logout+jwt`, 클레임 `iss`·`aud`(client_id)·`iat`·`exp`(2분)·`jti`·`events`(`http://schemas.openid.net/event/backchannel-logout`)·`sub`·`sid`, `nonce` 없음.
  `application/x-www-form-urlencoded` 의 `logout_token=` 으로 POST. 타임아웃 3초, 실패(네트워크·5xx) 시 1초·3초 뒤 두 번 더, 4xx 는 RP 거부로 보고 재시도 안 함. 리다이렉트 따라가지 않음.
  전송은 백그라운드라 **실패해도 워크스페이스 로그아웃은 그대로 끝난다**. 백엔드 컨테이너가 이 주소로 나갈 수 있어야 한다(DNS·방화벽·헤어핀).
- RP 는 서명·`iss`·`aud`·`iat`·`events`·`typ` 을 검증하고 `jti` 재사용을 거부한 뒤 해당 `sid`(없으면 그 `sub` 전체) 세션을 끊고 200 을 돌려준다.

읽기+쓰기는 `"scopes": ["mcp:read", "mcp:write"]`. Gitea 항목과 한 JSON 에 병합 가능.

- access token 은 MCP 플로우일 때 `aud`(리소스 URL, RFC 8707)와 `scope` 클레임을 담는다. 코드 저장소 로그인용 토큰에는 `aud` 가 없다. MCP 스코프 요청은 PKCE(S256) 필수.
- ID 토큰은 RS256, 키는 `/oauth/jwks.json`. discovery 는 `claims_supported`·`backchannel_logout_supported`·`backchannel_logout_session_supported` 도 광고한다.
- 디스커버리: `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`(루트), `/oauth/.well-known/openid-configuration`(코드 저장소가 쓴다),
  보호 리소스 메타데이터(RFC 9728) `/.well-known/oauth-protected-resource[/api/mcp/read]`.

## 5. 리포에 넣지 않는 것 (`.gitignore`)

- `.env` 와 그 사본(비밀값)
- 직접 만든 플러그인(`plugins/<이름>/`), `nginx/private.d/*`
- 설치할 때 환경별로 만들어지는 파일 — `livekit/livekit.yaml`, `nginx/state/`, `mailserver/config/` 의 계정·키
