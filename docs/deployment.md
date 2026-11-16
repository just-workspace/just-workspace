# 수동 설치 (설치 관리자 미사용)

`docker compose` 로 스택을 직접 기동하는 절차를 기술한다. 소스를 수정하면서 운영하거나, 기존 리버스 프록시 하단에 수동으로 구성하는 경우에 적용한다.

**대부분의 경우 설치 관리자의 사용을 권장한다** — [install.md](install.md). 본 절차로 기동한 서버에는 다음 제한이 적용된다.

- 관리 › 구역이 읽기 전용이다(활성화·비활성화는 `.env` 수정으로 수행한다).
- 관리 › 업데이트가 "여기서 업데이트할 수 없습니다"로 표시된다(`scripts/update.sh` 를 사용한다).
- 인증서 카드에서 재발급할 수 없다(직접 구성한 프록시에서 교체한다).
- 비밀값, 저장소 볼륨, 회의 서버 설정, 메일 서명 키를 관리자가 직접 생성한다.
- 저장소 마커 검사(단절된 저장소에 기록하는 사고의 방지)가 비활성화되어 있다.

실서버에서 검증된 범위는 **최소 구성(기본 구역만)을 평문 80 으로 기동하는 것**까지다([installer.md](installer.md) 13절의 `s8-manual`). 구역을 추가한 구성은 아래 표에 따라 관리자가 직접 구성해야 한다.

## 시스템 요구 사항 (System Requirements)

- 리눅스 x86_64, Docker Engine 24.0 이상, Docker Compose 플러그인 2.20 이상.
- 기본 구역만: 2코어 / 4 GB. 구역별 권장 메모리는 [install.md](install.md#서버).
- 전단에서 TLS 를 종단하는 리버스 프록시(아래 "프런트 프록시 구성").

## 설치 및 구성 절차 (Installation & Configuration)

리포 루트에서 실행한다.

```bash
cp .env.example .env
# 1) .env 를 작성한다: DOMAIN · APP_URL · COMPOSE_PROFILES · JW_ZONES(둘 다 비우면 기본 구역의 컨테이너만 기동한다 — 아래 "구역").
#    최초 관리자는 ADMIN_USERNAME · ADMIN_PASSWORD(12자 이상)를 지정해 두면 최초 기동 시 생성된다.

# 2) backend 이미지를 빌드한다 — 비밀값 생성기가 이 이미지에 포함되어 있다.
#    비밀값이 비어 있는 동안에는 `docker compose build` 가 필수 변수 검사(DB_PASSWORD · SECRET_KEY)에서 실패하므로
#    docker build 로 직접 빌드한다.
docker build --build-context licenses=. -t localhost/just-workspace-backend:latest ./backend

# 3) 비어 있는 비밀값을 생성한다(값이 이미 있는 줄은 변경하지 않는다).
docker run --rm -v "$PWD/.env:/work/.env" localhost/just-workspace-backend:latest \
  python -m app.cli gen-secrets --merge /work/.env --in-place

# 4) 파일 저장소 볼륨을 생성한다. compose 는 이 이름(STORAGE_VOLUME, 기본 ws-storage-data)의 볼륨을
#    외부(기존) 볼륨으로 참조한다. 없으면 up 이 중단된다.
docker volume create ws-storage-data

# 5) 기동한다(나머지 이미지는 이 시점에 빌드된다).
docker compose config --quiet && docker compose up -d
```

- 프록시 없이 평문 80 으로 시험하려면 `APP_URL=http://<서버 주소>`, `DOMAIN=<서버 주소>` 로 지정하고 `nginx/site.d/http.conf` 의 `set_real_ip_from` 줄을 삭제한다.
- 빈 값·예시 값·길이가 부족한 비밀값으로는 backend 가 기동하지 않는다 — 로그에 변수 이름과 사유가 출력된다([CONFIG.md](CONFIG.md)의 "비밀값").
- 관리자를 `.env` 에 지정하지 않고 생성하려면 기동 후 `docker compose exec backend python -m app.cli seed-admin --username <아이디>` 를 실행한다.
- `.env` 의 `ADMIN_PASSWORD` 는 관리자 생성 후 삭제한다.

### 최초 관리자 계정 생성

관리자 생성 방법은 세 가지다.

| 방법 | 절차 |
|---|---|
| 웹의 최초 설정 화면 | 관리자가 없는 서버에 접속하면 `/setup` 이 열린다. **설정 토큰**을 입력해야 계정을 생성할 수 있다 |
| 명령 | `docker compose exec backend python -m app.cli seed-admin --username <아이디>` (비밀번호는 프롬프트로 입력받는다) |
| `.env` | `ADMIN_USERNAME` · `ADMIN_PASSWORD` 를 지정하고 기동한다. 사용자가 한 명도 없는 경우에만 실행된다. 생성 후 `ADMIN_PASSWORD` 를 삭제한다 |

설정 토큰은 서버 터미널에 접근 가능한 자만 최초 관리자를 생성할 수 있도록 하는 일회용 값이다.

- backend 가 관리자 없이 기동할 때마다 새로 생성해 로그에 1회 출력한다 — `docker compose logs backend | grep "setup token"`. backend 를 재기동하면 값이 변경되므로 최신 값을 사용한다.
- 재발급: `docker compose exec backend python -m app.cli setup-token`(이전 값은 무효화된다).
- 서버에는 해시만 저장한다. 관리자가 생성되면(방법 무관) 토큰은 폐기되고 해당 화면은 닫힌다.
- 토큰이 없거나 일치하지 않으면 생성할 수 없다(403). 시도는 주소당 분당 5회로 제한된다.
- 이 화면에서 생성하는 관리자 비밀번호는 12자 이상이어야 한다.

설치 관리자로 설치한 서버에서는 웹의 최초 관리자 생성 기능이 차단되어 있다(관리자는 설치 관리자가 생성한다).

## 프런트 프록시 구성

리포의 nginx 설정(`nginx/nginx.conf` + `nginx/site.d/`)은 **"프런트 프록시 하단, 80 평문"** 구성이다. 내장 nginx(`ws-nginx`)는 80 에서만 수신하며, TLS 는 전단의 프록시가 종단한다.

- 프록시의 주소를 `nginx/site.d/http.conf` 의 `set_real_ip_from` 에 지정한다(복수인 경우 줄을 추가한다, CIDR 가능). `nginx/nginx.conf` 는 수정하지 않는다.
- 프록시는 접속자의 주소를 `X-Real-IP` 로, 원 프로토콜을 `X-Forwarded-Proto` 로 전달해야 한다. `ws-nginx` 는 위에 지정된 주소에서 수신한 연결의 `X-Real-IP` 만 신뢰한다.
- WebSocket(`/ws/`, `/livekit/`, `/git/`, `/onlyoffice/`) 업그레이드와 `/api/mcp` 스트리밍(버퍼링 비활성화)을 프록시에서도 통과시켜야 한다.
- 대용량 파일 업로드를 위해 프록시의 본문 크기 제한도 해제해야 한다(내장 nginx 는 `/api/files/upload` 에 10 GB 까지 허용한다).
- 컨테이너(코드 저장소·문서 편집기)에서 접속 주소로의 회귀 경로가 차단되어 있으면 `.env` 의 `RP_LAN_IP` 에 프록시의 내부 주소를 지정한다.
- 사이트 전용 nginx location 은 `nginx/private.d/*.conf`(git 추적 대상이 아니다)에 둔다.

**이 서버가 TLS 를 직접 종단하는 구성**(443 게시, 인증서 발급·갱신)은 설치 관리자가 `nginx/site.d/` 의 파일과 compose 조각을 생성해 구성한다. 수동 구성 절차는 별도로 문서화되어 있지 않다 — 필요한 경우 설치 관리자를 사용하거나, 설치 관리자가 생성하는 내용([installer.md](installer.md) 8절)을 참조해 직접 작성한다. `docker exec jw-installer jw render --answers <파일> --out <폴더>` 는 응답 파일로부터 생성되는 파일을 지정 폴더에 출력한다.

## 구역 (`COMPOSE_PROFILES` 와 `JW_ZONES`)

두 변수를 **함께** 지정한다. `COMPOSE_PROFILES` 는 기동할 컨테이너를, `JW_ZONES` 는 backend 가 제공할 구역의 API 와 메뉴를 결정한다. `JW_ZONES` 를 비우면 모든 구역이 설치된 것으로 간주한다.

| 구역 (`JW_ZONES`) | 프로파일 (`COMPOSE_PROFILES`) | 컨테이너 | 함께 지정할 항목 |
|---|---|---|---|
| 기본 (항상) | — | ws-postgres · ws-redis · ws-backend · ws-frontend-react · ws-nginx | `SECRET_KEY`, `DB_PASSWORD` |
| `mail` | `mailserver` | ws-mailserver | `FEATURE_BUILTIN_MAILSERVER=true`, `DOVECOT_MASTER_PASSWORD`, `INTERNAL_API_KEY`, 인증서(아래). 호스트 포트 25·465·587·993 |
| `chat` | — | — | |
| `calendar` | — | — | |
| `docs` | `onlyoffice` | ws-onlyoffice | `ONLYOFFICE_JWT_SECRET`, (프록시 하단) `RP_LAN_IP` |
| `meetings` | `livekit`, `egress`(녹화), `audiorelay`(무손실 오디오) | ws-livekit · ws-egress · ws-audiorelay | `LIVEKIT_API_KEY`·`LIVEKIT_API_SECRET`, `livekit/livekit.yaml`(아래), `AUDIORELAY_SECRET`. 호스트 포트 7881, 7882-7892/udp, 3478/udp, `LIVEKIT_TURN_TLS_PUBLISH`(기본 443), 4433/udp |
| `git` | `gitea` | ws-gitea | `GITEA_TOKEN`, `OAUTH_CLIENTS_JSON` 의 `gitea` 항목(아래). 호스트 포트 `GIT_SSH_PORT`(기본 2222) |
| `ai` | `aitools` | ws-searxng · ws-docconv · ws-sandbox | `SEARXNG_SECRET`, `SANDBOX_TOKEN`, `DOCCONV_TOKEN` |
| `sso` (애드온) | `sso` | ws-sso · ws-ldap | `INTERNAL_API_KEY`. 호스트 포트 636, 평문 389 는 `LDAP_PLAIN_BIND`(기본 127.0.0.1)에만 |
| `rbi` (애드온) | `rbi` | ws-rbi-netfilter | `RBI_PUBLIC_ORIGIN` 등 — [rbi.md](rbi.md) |
| — | `certbot` | ws-certbot | `ACME_DOMAINS`, `LETSENCRYPT_EMAIL` — 메일·회의 서버가 사용할 인증서를 발급받는다 |

비밀값은 3) 의 생성기가 일괄 생성한다. 예:

```bash
# 기본 구역만
COMPOSE_PROFILES=
JW_ZONES=core

# 협업: 메일(내장) · 채팅 · 일정 · 문서
COMPOSE_PROFILES=certbot,mailserver,onlyoffice
JW_ZONES=core,mail,chat,calendar,docs
FEATURE_BUILTIN_MAILSERVER=true
```

구역별 수동 작업(설치 관리자 사용 시 자동 처리되는 항목):

- **회의**: `cp livekit/livekit.example.yaml livekit/livekit.yaml` 실행 후 키와 서버의 공인 주소를 지정한다.
- **메일**: 메일 서명 키를 생성한다(`bash scripts/generate-dkim.sh`). 메일 도메인의 DNS 레코드는 [operate.md](operate.md#6-메일-dns-레코드).
- **코드 저장소**: Gitea 기동 후 관리 토큰(`GITEA_TOKEN`), 워크스페이스 측 OAuth 클라이언트(`OAUTH_CLIENTS_JSON`), Gitea 측 인증 소스를 직접 등록한다. 설치 관리자의 처리 순서는 [installer.md](installer.md) 10절의 "코드 저장소(Gitea)".
- **격리 브라우저**: 세션 이미지를 별도로 빌드한다 — `docker compose --profile rbi-build build rbi-mirror`.

## 운영

### 업데이트

```bash
sudo bash scripts/backup.sh --kind pre-update     # 사전에 DB 와 설정을 백업한다
bash scripts/update.sh                            # git pull → 활성화된 자체 빌드 이미지 빌드 → 재기동 → 상태 확인
bash scripts/update.sh --rollback                 # 직전 업데이트 시 기록한 이미지로 롤백한다
```

`update.sh` 는 직접 기동한 서버 전용이다(설치 관리자로 설치한 서버는 관리 › 업데이트를 사용한다). DB 를 백업하지 않으며, 실패하더라도 **자동으로 롤백하지 않는다**(`--rollback` 을 안내한다). 재기동 중에는 접속이 일시 중단된다. 스키마 버전이 상향된 이후에는 이미지만 롤백하면 backend 가 기동하지 않으므로 DB 도 직전 백업으로 복원해야 한다 — [update-system.md](update-system.md)의 "수동 설치", [data-safety.md](data-safety.md) 5절.

### 백업 및 복원

```bash
sudo bash scripts/backup.sh [받을-폴더]              # 전체 백업을 .jwbak 단일 파일로 생성(받을-폴더에서 30일 보존)
sudo bash scripts/backup.sh --include-files          # 파일 저장소도 포함한다(로컬 저장소인 경우에 한함)
sudo bash scripts/restore.sh <백업 파일> --inspect   # 내용만 확인한다
sudo bash scripts/restore.sh <백업 파일>             # 검증 → 중지 → DB → 스키마 → 나머지 → 기동 → 확인
```

관리 › 저장소·백업에서도 동일한 형식의 백업을 생성할 수 있다. 포함·제외 항목과 복원 단계는 [data-safety.md](data-safety.md).

### 상태 점검

```bash
bash scripts/health.sh          # Docker · 컨테이너 · DB · Redis · API · 디스크 · 인증서 만료 (--json)
```

로그·디스크·문제 해결은 [operate.md](operate.md) 7~9절이 동일하게 적용된다.

### 플러그인

`plugins/` 폴더가 backend 에 읽기 전용으로 마운트된다. 빌드와 설치는 [extensions.md](extensions.md).

## 설치 관리자 기반 설치로의 이전

직접 기동한 서버에서 전체 백업을 생성해(`scripts/backup.sh --include-files`), 신규 서버의 설치 마법사에서 "백업에서 복원"으로 이전할 수 있다 — [operate.md](operate.md#3-백업-복원-및-서버-이전).
