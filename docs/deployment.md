# Deployment Guide

## 요구사항

- Linux 호스트 — Ubuntu 22.04/24.04, Debian 12/13, Rocky/AlmaLinux 9·10
- Docker Engine 24+ & Docker Compose v2
- 코어만: 2 vCPU / 4GB. 풀스택(mailserver·gitea·livekit·onlyoffice): 4 vCPU / 8GB 이상 권장. 회의 녹화(egress)는 cpu 4 를 따로 요구한다
- 도메인 1개. 자체 메일 서버를 쓰면 고정 공인 IP + PTR

## 빠른 시작

> 설치 방식은 Docker 기반 웹 설치 마법사로 개편 중(문서 준비 중)

## 배포 모드 (`DEPLOY_MODE`)

| 모드 | 내장 nginx | TLS | 용도 |
|------|-----------|-----|------|
| `external_proxy` (기본) | :80 | 앞단 리버스 프록시가 종단 | 이미 RP/WAF 가 있는 환경 |
| `standalone` | :80 + :443 | certbot(Let's Encrypt) 자동 | 단독 서버 |
| `dev` | :80 | 없음 | 로컬 · IP 접속 |

`nginx/nginx.conf` 는 리포 정본을 그대로 쓴다. standalone 의 TLS 판(`nginx/standalone.conf`)과 `docker-compose.override.yml` 은 정본에서 파생한 사이트별 파일이다(git 미추적).

## 환경변수 (.env)

전체 목록은 [CONFIG.md](CONFIG.md).

### 필수

| 변수 | 설명 |
|------|------|
| `DB_PASSWORD` | PostgreSQL 비밀번호(16자 이상) — compose 가 검사 |
| `SECRET_KEY` | 세션 서명·Fernet 키 파생(32자 이상). **ws-sso 와 같은 값** — compose 가 검사 |
| `DOMAIN` · `APP_URL` | 서비스 도메인 · 외부 URL |

`.env.example` 의 비밀값은 비어 있다. 한 줄로 채운다(이미 값이 있는 줄은 건드리지 않는다):

```bash
docker run --rm -v "$PWD/.env:/work/.env" <backend 이미지> python -m app.cli gen-secrets --merge /work/.env --in-place
```

빈 값·예시 값·짧은 값으로는 백엔드가 뜨지 않는다 — 로그에 변수 이름과 사유가 나온다. 켠 프로파일의 비밀값(`LIVEKIT_API_SECRET`, `SEARXNG_SECRET` …)이 비어 있으면 그 컨테이너가 기동을 거부한다. 규칙 표와 생성기 사용법은 [CONFIG.md](CONFIG.md) 의 "비밀값" 절.

## 프로파일 (`COMPOSE_PROFILES`)

코어(postgres · redis · backend · frontend-react · nginx)는 항상 뜬다. `nginx` 프로파일은 없다 — 내장 nginx 가 유일한 진입점이다.

| 프로파일 | 컨테이너 | 비고 |
|----------|----------|------|
| `mailserver` | ws-mailserver (Postfix · Dovecot · Rspamd) | `FEATURE_BUILTIN_MAILSERVER=true` 와 함께. 25/465/587/143/993 |
| `gitea` | ws-gitea (Gitea 28) | `/git/` 서브패스, SSH `GIT_SSH_PORT`(2222). OIDC 자동 가입·연동이 env 로 사전 구성됨 |
| `livekit` | ws-livekit (1.13) | UDP 7882-7892, TCP 7881, TURN 3478/udp + 443/tcp(`LIVEKIT_TURN_TLS_PUBLISH`) |
| `egress` | ws-egress (1.15) | 회의 녹화. livekit 과 함께. cpu 4 / 4G |
| `onlyoffice` | ws-onlyoffice (10.0) | WOPI. AGPL. `ONLYOFFICE_JWT_SECRET`, `RP_LAN_IP` |
| `sso` | ws-sso + ws-ldap | SAML/SCIM + LDAP 디렉터리. 밖으로는 LDAPS 636 만 — 평문 389 는 `LDAP_PLAIN_BIND`(기본 127.0.0.1)에만 연다 |
| `aitools` | ws-searxng | AI 웹 검색 도구. AGPL |
| `certbot` | ws-certbot | 메일·TURN 인증서(standalone 은 웹 인증서까지). `ACME_DOMAINS`, `LETSENCRYPT_EMAIL` |
| `rbi` | ws-rbi-netfilter | 격리 브라우저 세션 브리지의 호스트 iptables 규칙(host 네트워크 + NET_ADMIN). `RBI_ALLOW`. 세션 컨테이너는 백엔드가 docker.sock 으로 띄운다 — [rbi.md](rbi.md) |
| `rbi-build` | (빌드 전용) rbi-mirror | 격리 브라우저 미러 모드 세션 이미지. `docker compose --profile rbi-build build rbi-mirror` 로만 쓴다(up 하지 않는다 — 세션마다 백엔드가 띄움) |

### 예시

```bash
# 최소 (코어만)
COMPOSE_PROFILES=

# 기본 권장
COMPOSE_PROFILES=mailserver,gitea,livekit
FEATURE_BUILTIN_MAILSERVER=true

# 외부 메일(Gmail/M365 등)만 — 사용자가 IMAP/SMTP/OAuth 로 직접 연결
COMPOSE_PROFILES=gitea,livekit

# 풀스택
COMPOSE_PROFILES=certbot,mailserver,gitea,livekit,egress,onlyoffice,sso
```

꺼진 프로파일의 `${VAR:?}` 도 compose 가 검사한다 — 필수 변수는 프로파일과 무관하게 채운다. `docker compose config --quiet` 가 누락을 알려 준다.

## 앞단 리버스 프록시 뒤에서 (external_proxy)

- RP 가 TLS 를 종단하고 `X-Real-IP`·`X-Forwarded-Proto` 를 넘긴다. `ws-nginx` 는 `set_real_ip_from` 에 적힌 RP 주소에서 온 연결만 믿는다 — 사이트의 RP 주소는 `nginx/private.d/` 가 아니라 `nginx/nginx.conf` 의 `set_real_ip_from` 을 바꿔야 한다.
- WebSocket(`/ws/`, `/livekit/`, `/git/`, `/onlyoffice/`) 업그레이드와 `/api/mcp` 스트리밍(버퍼링 off)을 RP 도 통과시켜야 한다.
- 대용량 업로드는 RP 의 `client_max_body_size` 도 풀어야 한다(내장 nginx 는 `/api/files/upload` 10G).
- 컨테이너(gitea · onlyoffice)가 공인 도메인으로 헤어핀 NAT 을 못 넘으면 `RP_LAN_IP` 로 우회한다(compose `extra_hosts`).
- 사이트 전용 nginx location 은 `nginx/private.d/*.conf`(git 미추적)에 둔다.

## DNS (자체 메일 서버 사용 시)

| 레코드 | 타입 | 값 |
|--------|------|------|
| `example.com` | A | 서버 IP |
| `mail.example.com` · `turn.example.com` | A | 서버 IP |
| `example.com` | MX | `mail.example.com` (우선순위 10) |
| `example.com` | TXT | `v=spf1 mx ~all` |
| `default._domainkey.example.com` | TXT | DKIM 공개키 (`scripts/generate-dkim.sh`) |
| `_dmarc.example.com` | TXT | `v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com` |

MCP 커넥터를 전용 서브도메인에 두려면 `mcp.example.com` A 레코드도 — [CONNECTOR.md](CONNECTOR.md).

## 업그레이드

```bash
bash scripts/update.sh           # git pull → 순차 재빌드 → 헬스체크 → 실패 시 --rollback
```

DB 스키마는 backend 기동 시 `init_db()` 가 advisory lock 안에서 맞춘다(워커 여럿 동시 기동 안전). 자세한 것은 [update-system.md](update-system.md).

## 플러그인 빌드

```bash
cd plugins && npm install          # 최초 1회
node build-plugin.mjs sample-notes # 단일 플러그인
node build-all.mjs                 # 전체
docker compose restart backend
```

관리 › 플러그인에서 .zip 업로드로도 설치된다 — [extensions.md](extensions.md).

## 백업

```bash
sudo bash scripts/backup.sh [백업디렉토리]   # PostgreSQL(pg_dump) + Redis(RDB) + 메일 데이터 + 안드로이드 서명 키, 30일 보존
sudo bash scripts/restore.sh <백업디렉토리>
```

파일 스토리지(`storage-vol`)와 Gitea 데이터(`gitea-data`), 녹화(`egress-out`)는 볼륨 자체를 백업한다. 관리 › 저장소·백업에서 앱 내 백업/복원도 된다.
