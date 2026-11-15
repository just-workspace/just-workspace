# 설정 변수 레퍼런스

Just-Workspace 의 환경별 값은 **`.env` 변수** 또는 **설치기가 생성하는 파일**로 외부화돼 있다.
설치 방식은 Docker 기반 웹 설치 마법사로 개편 중(문서 준비 중) — 아래 "설치기" 열은 그 설치기가 값을 다루는 방식이다.
소스에 환경 고정값은 없다. 정본은 `.env.example` 과 `backend/app/config.py` — 이 문서는 그 요약이다.

## 1. `.env` 변수

"설치기" 열: **자동생성** = 비밀값 생성기(`python -m app.cli gen-secrets`, 아래 "비밀값" 절)로 만들고 기존 값은 보존(멱등) / 자동 조합 = 도메인·모드에서 파생 / 입력 = 대화형 질문.

### 배포·앱

| 변수 | 기본/예시 | 설명 | 설치기 |
|---|---|---|---|
| `DEPLOY_MODE` | external_proxy | `standalone` / `external_proxy` / `dev` | 대화형 선택 |
| `COMPOSE_PROFILES` | mailserver,gitea,livekit | 활성 프로파일(쉼표). 사용 가능: mailserver gitea livekit audiorelay egress onlyoffice sso logging aitools certbot | 대화형 선택 |
| `JW_ZONES` | (비움) | 설치된 구역(쉼표): mail chat calendar docs meetings git ai monitoring sso rbi. 비우면 전부. 적지 않은 구역의 API 라우터·백그라운드 작업은 백엔드에 올라오지 않는다. 선언은 `backend/app/zones.json`, 라우터·루프 표는 `backend/app/zones.py` | 대화형 선택 |
| `STORAGE_VOLUME` | ws-storage-data | 파일 스토리지 볼륨명(외부 볼륨/NFS 가능) | 기본값 |
| `BACKUP_VOLUME` | backups-vol | 앱 내 백업 저장 볼륨 | 기본값 |
| `APP_NAME` | Workspace | 표시 이름(브랜딩) | 입력 |
| `APP_URL` | https://도메인 | 외부 접속 URL = OAuth issuer | 자동 조합 |
| `NETLAB_URL` | (비움) | NetLab 별도 출처 주소(https 만). 있으면 앱 내려받기 페이지(`/api/apps`)에 NetLab 콘솔 도우미 링크를 띄운다 | 선택 |
| `DOMAIN` | your-domain.com | 도메인/IP | 입력 |
| `DOMAIN_ALIAS` | (빈값) | 같은 앱을 다른 도메인으로도 서빙할 때(헤어핀 우회 대상 추가) | 수동 |
| `DEBUG` | false | 디버그 | 기본값 |
| `SECRET_KEY` | (랜덤) | 세션 서명·Fernet 키 파생. **ws-sso 와 같은 값** | **자동생성** |
| `INTERNAL_API_KEY` | (랜덤) | backend 내부 API(`/api/internal/*`) 키 — Dovecot 메일 로그인·ws-ldap 이 쓴다. 비우면 내부 API 가 닫힌다 | **자동생성** |
| `BACKEND_WORKERS` | (비움) | 백엔드 워커 수. 비우면 CPU 수 기준 `min(8, max(2, 코어 수))` | 기본값 |
| `BACKEND_CPUS` | (비움) | 백엔드 컨테이너 CPU 상한(예 `4.0`). 비우면 제한 없음 | 기본값 |
| `ALLOW_NATIVE_APP_ORIGINS` | false | 번들 빌드 모바일 앱의 출처(`https://localhost`·`capacitor://localhost`)를 CORS·CSRF·WebSocket 허용 목록에 넣는다. 번들 빌드 앱을 배포할 때만 true — 기본 허용 출처는 `APP_URL` 하나 | 수동 |
| `JW_ALLOW_INSECURE_DEFAULTS` | (비움) | `1` 이면 약한·기본 비밀값을 거부하지 않고 경고만 남긴다. **개발·테스트 전용** | 수동 |
| `BRAND_LOGO` / `BRAND_COLOR` | (빈값) / #3B82F6 | 로고 URL · 테마 색(관리 › 브랜딩에서 DB 로도 덮음) | 수동 |

### 비밀값 — 기동 검사와 생성기

백엔드는 **약한·기본 비밀값으로는 뜨지 않는다.** 컨테이너 entrypoint(`python -m app.cli check-secrets`)와 앱 기동 경로가 같은 표(`backend/app/security_defaults.py`)로 검사하고, 거부한 변수마다 이름과 사유를 한 줄씩 로그에 남긴다(값은 찍지 않는다). ws-sso·ws-ldap 도 같은 규칙으로 자기 비밀값을 검사한다.

거부 조건: 비어 있음(필수인 것) · `CHANGE_ME…` 자리표시자 · 널리 알려진 기본값(`devkey`, `secret`, `changeme`, `password`, `admin` …) · 길이 미달 · 같은 글자 반복. 기능이 꺼져 있어(구역 `JW_ZONES`, 프로파일) 쓰지 않는 값은 보지 않는다.

| 변수 | 최소 길이 | 필수 | 검사하는 때 |
|---|---|---|---|
| `SECRET_KEY` | 32 | 예 | 항상 |
| `DB_PASSWORD`(`DATABASE_URL` 안의 비밀번호 포함) | 16 | 예 | PostgreSQL 일 때(항상) |
| `INTERNAL_API_KEY` | 32 | 아니오(비우면 내부 API 닫힘) | 값이 있을 때. 세로선·`&`·`/`·역슬래시·공백·따옴표 금지(메일 서버 스크립트가 치환한다) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | 16 / 32 | 아니오(비우면 회의 꺼짐) | 구역 `meetings` + 값이 있을 때 |
| `AUDIORELAY_SECRET` | 32 | 아니오 | 구역 `chat`+`meetings` + 값이 있을 때 |
| `DOVECOT_MASTER_PASSWORD` | 16 | 아니오 | 구역 `mail` + 값이 있을 때 |
| `ONLYOFFICE_JWT_SECRET` | 32 | 아니오 | 구역 `docs` + 값이 있을 때 |
| `SANDBOX_TOKEN` / `DOCCONV_TOKEN` / `SEARXNG_SECRET` | 32 | 아니오 | 구역 `ai` + 값이 있을 때 |
| `GRAFANA_ADMIN_PASSWORD` | 16 | 아니오 | `COMPOSE_PROFILES` 에 `logging` + 값이 있을 때(Grafana 컨테이너는 비어 있어도 거부) |
| `MCP_API_KEY` | 32 | 아니오 | 구역 `ai` + `MCP_INTERNAL_TOOLS_ENABLED=true` + 값이 있을 때 |
| `GITEA_WEBHOOK_SECRET` | 32 | 아니오 | 구역 `chat` + 값이 있을 때 |
| `LDAP_SERVICE_PASSWORD` | 16 | `LDAP_SERVICE_USER` 가 있으면(ws-ldap 이 검사) | 구역 `sso` + 값이 있을 때 |
| `SMTP_PASSWORD` | — | 아니오 | 자리표시자·알려진 기본값만 거부(외부 계정일 수 있어 길이는 보지 않는다) |

생성기 — 값은 16진수라 셸·`sed`·URL 어디에 넣어도 이스케이프가 필요 없다(키 48자, 비밀번호 32자):

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

기본 생성 대상은 표의 `SECRET_KEY` 부터 `GRAFANA_ADMIN_PASSWORD` 까지이고, 그 아래는 `--only` 로 지목했을 때만 만든다. 이미 값이 있는 줄은 건드리지 않는다. `DB_PASSWORD` 는 **DB 볼륨을 처음 만들 때만** 적용되므로, 이미 돌고 있는 설치에서 바꾸려면 PostgreSQL 쪽 비밀번호도 함께 바꿔야 한다.

### 관리자 계정

```bash
docker compose exec backend python -m app.cli seed-admin --username <아이디>      # 비밀번호는 물어본다(.env 에 남기지 않는다)
docker compose exec backend python -m app.cli reset-admin <아이디>                # 임시 비밀번호 발급 — 화면에 한 번만 나온다
docker compose exec backend python -m app.cli reset-admin <아이디> --disable-2fa  # 인증 앱도 잃어버렸을 때
```

- `ADMIN_USERNAME`/`ADMIN_PASSWORD` 로 하는 자동 시드는 사용자가 한 명도 없을 때만 돈다. 그 뒤에는 값이 남아 있어도 아무것도 하지 않는다.
- 같은 이름의 일반 계정이 이미 있으면 관리자로 올리지 않고 경고만 남긴다. 서버에서 명시적으로 올리려면 `seed-admin --username <아이디> --promote`.
- `reset-admin` 은 관리자 계정에만 쓴다(일반 계정은 거부 — 관리 화면에서 재설정). 그 계정의 열린 세션과 앱 토큰은 모두 끊긴다.

### 데이터베이스·스토리지

| 변수 | 기본/예시 | 설명 | 설치기 |
|---|---|---|---|
| `DB_NAME` / `DB_USER` | workspace / workspace | PostgreSQL DB·유저 | 기본값 |
| `DB_PASSWORD` | (랜덤) | DB 비밀번호 | **자동생성** |
| `DATABASE_URL` | (비움) | 비우면 compose 가 `DB_USER`·`DB_PASSWORD`·`DB_NAME` 으로 조립한다. 외부 DB 를 쓸 때만 적는다 | 비움 |
| `JW_IMAGE_SOURCE` / `JW_REGISTRY` / `JW_VERSION` | build / localhost / latest | 소스 빌드 vs prebuilt pull — [IMAGES.md](IMAGES.md) | 기본값 |
| `JW_HOST_REPO` | (빈값) | 관리 화면 APK 빌드용 호스트 리포 경로(docker -v). 비우면 빌드 비활성 | 수동 |

파일 스토리지 백엔드(로컬/S3 호환)는 env 가 아니라 **관리 › 저장소**(`system_settings` `storage.*`)에서 바꾼다.

### 메일

| 변수 | 기본/예시 | 설명 | 설치기 |
|---|---|---|---|
| `FEATURE_BUILTIN_MAILSERVER` | false | 내장 메일서버 모드(가입 승인 시 메일 계정 자동 생성) | 프로파일 따라 |
| `DOVECOT_MASTER_USER` / `DOVECOT_MASTER_PASSWORD` | portal / (랜덤) | Dovecot 마스터 계정 | **자동생성** |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | mailserver / 587 / noreply@도메인 | 시스템 발신(noreply) SMTP | 일부 자동 |
| `ADMIN_EMAILS` | admin@도메인 | 관리자 이메일(권한 부여, 쉼표) | 자동 조합 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | (입력) | 첫 기동 관리자 시드 — **사용자가 한 명도 없을 때만** 만든다. 같은 이름의 계정이 있어도 관리자로 올리지 않는다. 만든 뒤 지울 것(아래 "관리자 계정" 절) | 입력 |

### 인증·연동

| 변수 | 기본/예시 | 설명 | 설치기 |
|---|---|---|---|
| `OAUTH_CLIENTS_JSON` | {} | 정적 OAuth 클라이언트 맵(§1.1) — Gitea SSO, `mcp:write` 가 필요한 고정 클라이언트 | 수동 |
| `OAUTH_DYNAMIC_CLIENTS_MAX` | 500 | 동적 등록(RFC 7591) 클라이언트 전역 상한. 넘으면 `/oauth/register` 400 | 기본값 |
| `MCP_PUBLIC_URL` | https://mcp.example.com | MCP 리소스 서버 공개 URL(전용 서브도메인). 비우면 `APP_URL` | 수동 |
| `MCP_INTERNAL_TOOLS_ENABLED` / `MCP_API_KEY` | false / (빈값) | 헤드리스 내부 도구용 정적키 모드(사용자 바인딩 없음). 둘 다 설정해야 활성 | 수동 |
| `DAV_ALLOW_ACCOUNT_PASSWORD` | false | CalDAV/CardDAV 에 계정 비밀번호 허용(기본은 앱 비밀번호만). 2단계 인증 사용자는 그래도 제외 | 수동(config.py) |
| `LDAP_PLAIN_BIND` | 127.0.0.1 | ws-ldap(프로파일 `sso`)의 평문 389 포트를 게시할 주소. 밖으로는 LDAPS(636)만 열고 평문은 기본으로 루프백에만 둔다. 평문만 되는 장비가 내부망에 있을 때만 그 망의 서버 주소(예 192.168.10.20)를 적는다 | 기본값 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | (빈값) | 웹 푸시 키. 비우면 backend 가 만들어 DB 에 저장 | 수동(config.py) |

### Gitea · 회의 · 오피스 · 검색

| 변수 | 기본/예시 | 설명 | 설치기 |
|---|---|---|---|
| `GITEA_URL` / `GITEA_EXTERNAL_URL` / `GITEA_TOKEN` | http://gitea:3000 / APP_URL/git/ / (빈값) | 내부 주소 · 외부 URL · API 토큰 | 기본값 / 자동 조합 / 수동 |
| `GIT_SSH_PORT` | 2222 | Git SSH 호스트 포트 | 기본값 |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | (랜덤) | 회의 인증(egress 도 같은 값) | **자동생성** |
| `LIVEKIT_URL` | http://livekit:7880 | 내부 LiveKit(외부/클라우드 시 교체) | 기본값 |
| `LIVEKIT_TURN_TLS_PUBLISH` | 443 | 내장 TURN/TLS 를 게시할 호스트 포트. standalone(nginx 가 443)은 설치기가 `127.0.0.1:4443` | 모드 따라 |
| `ONLYOFFICE_JWT_SECRET` | (랜덤) | OnlyOffice ↔ backend JWT | **자동생성** |
| `AUDIORELAY_SECRET` | (랜덤, ≥32자) | 음성채널 무손실 티어 릴레이 토큰 HMAC. backend 와 ws-audiorelay(`RELAY_SECRET`) 공유. 비우면 `relay-token` 이 503 → 음악 티어로 강등 | **자동생성** |
| `AUDIORELAY_WT_PUBLIC_URL` | (빈값) | WebTransport(HTTP/3·UDP) 공개 URL `https://relay.도메인:4433/audiorelay/wt`. 비우면 WebSocket(`/audiorelay/ws`, nginx 경유)만 | 수동 |
| `AUDIORELAY_WT_PORT` | 4433 | 호스트에 게시하는 UDP 포트 | 기본값 |
| `AUDIORELAY_WT_CERT` / `AUDIORELAY_WT_KEY` | /etc/letsencrypt/live/${DOMAIN}/… | WebTransport TLS. 없으면 13일 자가서명 + `/audiorelay/info` 의 `cert_hash`(LAN 테스트 전용) | 기본값 |
| `AUDIORELAY_WT_SELF_SIGNED_HOSTS` | 127.0.0.1,localhost | 자가서명 SAN | 수동 |
| `CHAT_PERMISSIONS_ENGINE` | shadow | 채팅 역할·권한 엔진 모드 `legacy`/`shadow`/`enforce`. shadow = 예전 검사로 막고 새 엔진은 비교 로그만. 전환 절차는 [chat-permissions.md](chat-permissions.md) | 수동(config.py) |

무손실 티어의 구조·외부 공개(DNS·인증서·방화벽) 절차는 [voice-lossless.md](voice-lossless.md).
| `RP_LAN_IP` | (빈값) | 앞단 리버스 프록시의 LAN 주소. 컨테이너(gitea·onlyoffice)가 공인 도메인으로 헤어핀 NAT 을 못 넘을 때 우회 + OnlyOffice ipfilter 허용 | 수동 |
| `SEARXNG_SECRET` | (랜덤) | SearXNG(aitools) | **자동생성** |
| `GPU_HOST_IP` | (빈값) | GPU 작업 서버가 다른 머신일 때 `host.docker.internal` 이 가리킬 IP | 수동 |

### 격리 브라우저 RBI (`rbi` 프로파일)

| 변수 | 기본/예시 | 설명 | 설치기 |
|---|---|---|---|
| `RBI_PUBLIC_ORIGIN` | (없음) | 격리 브라우저 전용 출처(예 `https://rbi.example.com`). 화면·API·스트림이 이 출처에서만 열린다 — 비우면 격리 브라우저를 쓸 수 없다(런처가 "설정 필요"). 호스트는 `rbi.` 로 시작(ws-nginx `server_name ~^rbi\.`) — [rbi.md](rbi.md) §7 | 수동 |
| `RBI_SITE_SESSION_HOURS` | 8 | rbi 출처 세션 수명(시간). 워크스페이스 로그아웃·강제 로그아웃이면 그 전에 끝난다 | 기본값 |
| `RBI_ALLOW` | (없음) | **고정** 허용 목적지(IP:포트, 쉼표) — 늘 허용. 대상은 관리 화면에서 더하면 동적 목록으로 따라오므로 보통 비운다 — [rbi.md](rbi.md) §8 | 선택 |
| `RBI_ALLOW_CEILING` | (사설 대역) | 동적 출구가 들어갈 수 있는 상한 CIDR(쉼표). 비면 10/8·172.16/12·192.168/16. 백엔드(대상 저장)와 사이드카(줄 재검사)가 같은 값을 쓴다 | 선택 |
| `RBI_PROTECTED` | (없음) | 워크스페이스 자신의 주소(IP/CIDR 쉼표 — 앱 호스트·LAN 게이트웨이). 대상으로 거부, 관리자가 강제하면 경고·감사와 함께 허용. APP_URL·RBI_PUBLIC_ORIGIN 이 풀리는 IP(RP)는 자동 포함 | 권장 |
| `RBI_DENY` | (없음) | 사이드카가 동적 목록에서 언제나 거부할 CIDR 추가(루프백·링크로컬·멀티캐스트·세션 대역·도커 브리지 대역은 기본으로 거부) | 선택 |
| `RBI_ALLOW_FILE` | /run/rbi-allow/allow.txt | 동적 허용 파일(`ws-rbi-allow` 볼륨 — 백엔드 쓰기, 사이드카 읽기 전용) | 기본값 |
| `RBI_IMAGE` | kasmweb/chromium:1.18.0 | 세션 브라우저 이미지(KasmVNC). 백엔드가 `docker create`·`cp`·`start` 로 띄운다 | 기본값 |
| `RBI_MIRROR_IMAGE` | localhost/just-workspace-rbi-mirror:latest | 미러 모드 세션 이미지(`docker compose --profile rbi-build build rbi-mirror`). compose 는 `${JW_REGISTRY:-localhost}/just-workspace-rbi-mirror:${JW_VERSION:-latest}` 를 준다 — [rbi.md](rbi.md) §6 | 기본값 |
| `RBI_NETWORK` / `RBI_SUBNET` / `RBI_IP_RANGE` | ws-rbi / 172.31.200.0/24 / 172.31.200.128/25 | 세션 전용 브리지. 없으면 백엔드가 만든다(icc 끔) | 기본값 |
| `RBI_BRIDGE` | br-wsrbi | 브리지 인터페이스 이름 — 백엔드(네트워크 생성)와 사이드카(규칙)가 같은 값을 봐야 한다 | 기본값 |
| `RBI_PUBLISH_IP` | 172.28.0.1 | 세션의 6901 을 게시할 호스트 주소(workspace 브리지 게이트웨이). ws-nginx 출발지만 netfilter 가 통과시킨다 | 기본값 |
| `RBI_MAX_SESSIONS` | 4 | 동시 세션 상한 | 기본값 |
| `RBI_REQUIRE_GUARD` | true | 사이드카 하트비트(`ws-rbi-guard` 볼륨의 state.json, 180초)가 없으면 세션 시작 거부. 격리 없는 시험에서만 false | 기본값 |
| `RBI_GUARD_STATE` / `RBI_GUARD_MAX_AGE` / `RBI_CONTAINER_PREFIX` | /run/rbi-guard/state.json / 180 / ws-rbi-s- | 하트비트 경로·허용 나이(초)·세션 컨테이너 이름 접두어 | 기본값 |

구조·보안 모델·격리 검증은 [rbi.md](rbi.md).

### 관제 (logging)

| 변수 | 기본/예시 | 설명 | 설치기 |
|---|---|---|---|
| `GRAFANA_ADMIN_PASSWORD` | (랜덤) | logging 프로파일을 켤 때 필수(16자 이상). 비어 있거나 짧으면 Grafana 가 뜨지 않는다 | **자동생성** |
| `GRAFANA_BIND` | 127.0.0.1 | 포트를 게시할 주소 — 공인 인터페이스에 열지 말 것(LAN IP 또는 127.0.0.1) | 기본값 |
| `ALERT_EMAIL` | admin@도메인 | Grafana 알림 수신 | 자동 조합 |
| `PROBE_INTERVAL` | 300 | 헬스 프로브 주기(초) | 기본값 |
| `RP_IP` / `TUNNEL_IP` / `TUNNEL_PROBE_HOST` | (빈값) | 사이트 전용 점검(앞단 리버스 프록시 인증서 만료, 터널 경유 경로). 비우면 건너뜀 | 수동 |

### TLS

| 변수 | 기본/예시 | 설명 | 설치기 |
|---|---|---|---|
| `LETSENCRYPT_EMAIL` | admin@도메인 | 인증서 발급 메일 | 자동 조합 |
| `ACME_DOMAINS` | (빈값 = mail.·turn.·도메인) | certbot 이 받을 이름(쉼표). 인증서 디렉터리는 첫 이름. DNS 없는 이름이 섞이면 전체 실패 | 자동 조합 |

### 클라이언트 앱 빌드

| 변수 | 기본/예시 | 설명 |
|---|---|---|
| `DESKTOP_SERVER_URL` / `DESKTOP_APP_ID` / `DESKTOP_PRODUCT_NAME` | APP_URL / 도메인 역순 / just-workspace | 데스크톱 앱 빌드. 앱 ID 는 한 번 배포하면 바꾸지 말 것 |
| `DESKTOP_CSC_LINK` / `DESKTOP_CSC_KEY_PASSWORD` | (빈값) | 코드 서명 인증서 |
| `ANDROID_SERVER_URL` / `ANDROID_APP_ID` / `ANDROID_APP_NAME` | APP_URL / 도메인 역순 + .workspace / APP_NAME | 관리 화면 APK 빌드 |
| `JW_WEB` | react | 앱이 여는 웹 UI(`vue`·`react`). 기본 react — Vue 프런트는 더 이상 없어 `vue` 는 쓰지 않는다 |
| `ANDROID_WEB_BUNDLE` | (빈값) | `1` 이면 React 판을 APK 안에 번들(API 만 서버로). 빌더를 직접 실행할 때만 |

### 1.1 `OAUTH_CLIENTS_JSON` — 정적 클라이언트 스키마

OAuth 제공자(Gitea SSO · claude.ai MCP 커넥터 · 데스크톱 앱)가 인식하는 사전 등록 클라이언트 맵.
**동적 클라이언트 등록(DCR, RFC 7591)은 구현돼 있다** — discovery 가 `registration_endpoint`(`APP_URL/oauth/register`)를 광고하고,
claude.ai 같은 MCP 클라이언트는 커넥터 URL 만 넣고 로그인하면 자동 등록된다. 동적 클라이언트는 `mcp:read` 전용 + https 정확일치
redirect_uri 로 강제되고 시크릿은 해시 저장된다. 정적 맵은 Gitea SSO 나 `mcp:write` 가 필요한 고정 클라이언트에 쓴다.
데스크톱 앱 클라이언트(`desktop-app`, public + 루프백 리다이렉트)는 backend 에 내장돼 있어 넣지 않아도 된다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `secret` | ✔ | 클라이언트 시크릿. 상수시간 비교 |
| `redirect_uris` | ✔ | 콜백 화이트리스트. **정확 일치만**(와일드카드/prefix 금지). public 클라이언트의 루프백은 포트 무시(RFC 8252) |
| `scopes` | 권장 | 요청 가능한 최대 스코프. 초과 요청은 `/authorize` 에서 거부. 생략 시 레거시(OIDC 전용) 클라이언트 |
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
  "netlab": {
    "secret": "<openssl rand -hex 24>",
    "client_name": "네트워크 랩",
    "trusted": true,
    "redirect_uris": ["https://lab.example.com/auth/callback"],
    "scopes": ["openid", "profile", "email", "groups"],
    "backchannel_logout_uri": "https://lab.example.com/auth/backchannel-logout",
    "backchannel_logout_session_required": true
  }
}
```

- `groups` 스코프를 받은 토큰의 ID 토큰·UserInfo `groups` 에는 실제 워크스페이스 그룹 **이름**(정렬)이 들어간다. 관리자면 맨 앞에 `"admin"`.
  스코프를 안 받은 클라이언트는 예전과 같이 `["admin"]` 또는 `[]` 만 본다. 이름이 `admin`(대소문자 무시)인 그룹은 관리자 표식과 섞이지 않게 빠진다.
  그룹 이름을 바꾸면 RP 쪽 매핑도 바뀐다.
- ID 토큰에 `sid`(워크스페이스 세션에서 HMAC 으로 파생한 값 — 원래 세션 id 는 나가지 않는다)가 들어간다. `logout_token` 의 `sid` 와 같다.
- `logout_token`: RS256(JWKS 와 같은 키), 헤더 `typ: logout+jwt`, 클레임 `iss`·`aud`(client_id)·`iat`·`exp`(2분)·`jti`·`events`(`http://schemas.openid.net/event/backchannel-logout`)·`sub`·`sid`, `nonce` 없음.
  `application/x-www-form-urlencoded` 의 `logout_token=` 으로 POST. 타임아웃 3초, 실패(네트워크·5xx) 시 1초·3초 뒤 두 번 더, 4xx 는 RP 거부로 보고 재시도 안 함. 리다이렉트 따라가지 않음.
  전송은 백그라운드라 **실패해도 워크스페이스 로그아웃은 그대로 끝난다**. 백엔드 컨테이너가 이 주소로 나갈 수 있어야 한다(DNS·방화벽·헤어핀).
- RP 는 서명·`iss`·`aud`·`iat`·`events`·`typ` 을 검증하고 `jti` 재사용을 거부한 뒤 해당 `sid`(없으면 그 `sub` 전체) 세션을 끊고 200 을 돌려준다.

읽기+쓰기는 `"scopes": ["mcp:read", "mcp:write"]`. Gitea 항목과 한 JSON 에 병합 가능.

- access token 은 MCP 플로우일 때 `aud`(리소스 URL, RFC 8707)와 `scope` 클레임을 담는다. Gitea SSO 토큰은 하위호환으로 `aud` 없음. MCP 스코프 요청은 PKCE(S256) 필수.
- ID 토큰은 RS256, 키는 `/oauth/jwks.json`. discovery 는 `claims_supported`·`backchannel_logout_supported`·`backchannel_logout_session_supported` 도 광고한다.
- 디스커버리: `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`(루트), `/oauth/.well-known/openid-configuration`(레거시, Gitea 용 유지),
  보호 리소스 메타데이터(RFC 9728) `/.well-known/oauth-protected-resource[/api/mcp/read]`.

## 2. 설치기가 생성하는 파일 (env 로 못 받는 마운트 설정)

| 파일 | 분기 기준 | 내용 |
|---|---|---|
| `nginx/standalone.conf` + `docker-compose.override.yml` | DEPLOY_MODE=standalone | 리포 정본 `nginx/nginx.conf` 에서 파생한 443 TLS + 80 리다이렉트 판. **정본 nginx.conf 는 생성하지 않는다** |
| `livekit/livekit.yaml` | livekit 프로파일 + 공인 IP 탐지 | IP 가 잡히면 `node_ip` 고정, 실패 시 `use_external_ip`(STUN) + `tcp_port 7881`. 내장 TURN(`turn.<도메인>`, tls_port 443, udp 3478). 이미 있으면 건드리지 않음(`JW_FORCE=1` 로 재생성) |
| `mailserver/config/dovecot-masters.cf` | mailserver 프로파일 | 마스터 계정(자동 비번) |
| DKIM 키 | mailserver 프로파일 | `scripts/generate-dkim.sh` |

## 3. 코어에 남기지 않는 것 (.gitignore)

- `.env` 와 그 백업(시크릿)
- 직접 만든 플러그인 · `nginx/private.d/*` — 리포 밖에서 관리(추적하지 않음)
- 생성 파일(`livekit/livekit.yaml`, `nginx/standalone.conf`, `docker-compose.override.yml`) — 설치 시 생성

## 4. 남은 변수화 항목

- [x] 오피스 편집 = ONLYOFFICE(선택, 자체 편집기는 2026-10-15 폐기). ONLYOFFICE/SearXNG 는 AGPL → 기본 off (Collabora 제거됨)
- [x] 이미지 태그 고정(digest + 버전 주석) — `docker-compose.yml` 이 단일 출처
- [x] 브랜딩 sweep → just-workspace(프로젝트명은 폴더명 기반 자동, 컨테이너 `ws-` 유지)
- [x] 시크릿 자동 생성(설치기) · GPU 호스트 분리(`GPU_HOST_IP`)
- [ ] `LIVEKIT_MODE`(udp/tcp/external) 분기 — Linux 기본 설치는 UDP 정상이라 보류
- [ ] 스토리지/DB external 분기 대화형(현재는 `.env` 직접 편집)
