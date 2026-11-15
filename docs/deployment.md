# 설치 관리자 없이 직접 설치

`docker compose` 로 스택을 직접 띄우는 방법이다. 소스를 고쳐 가며 쓰거나, 이미 있는 리버스 프록시 뒤에 손으로 붙이려는 경우에 쓴다.

**대부분은 설치 관리자를 쓰는 편이 낫다** — [install.md](install.md). 이 방법으로 띄운 서버는:

- 관리 › 구역이 읽기 전용이다(켜고 끄는 것은 `.env` 를 고쳐서 한다).
- 관리 › 업데이트가 "여기서 업데이트할 수 없습니다"로 나온다(`scripts/update.sh` 로 한다).
- 인증서 카드에서 다시 발급할 수 없다(직접 구성한 프록시에서 바꾼다).
- 비밀값, 저장소 볼륨, 회의 서버 설정, 메일 서명 키를 직접 만든다.
- 저장소 표식 확인(끊긴 저장소에 쓰는 사고 방지)이 꺼져 있다.

실서버에서 확인한 범위는 **최소 구성(기본 구역만)을 평문 80 으로 띄우는 것**까지다([installer.md](installer.md) 13절의 `s8-manual`). 구역을 더한 구성은 아래 표를 따라 직접 맞춰야 한다.

## 요구 사항

- 리눅스 x86_64, Docker Engine 24.0 이상, Docker Compose 플러그인 2.20 이상.
- 기본 구역만: 2코어 / 4 GB. 구역별 권장 메모리는 [install.md](install.md#서버).
- 앞에 TLS 를 끝내 줄 리버스 프록시(아래 "앞단 프록시").

## 순서

리포 루트에서:

```bash
cp .env.example .env
# 1) .env 를 채운다: DOMAIN · APP_URL · COMPOSE_PROFILES · JW_ZONES(둘 다 비우면 기본 구역만 컨테이너가 뜬다 — 아래 "구역").
#    첫 관리자는 ADMIN_USERNAME · ADMIN_PASSWORD(12자 이상)를 적어 두면 첫 기동 때 만들어진다.

# 2) backend 이미지를 빌드한다 — 비밀값 생성기가 그 안에 있다.
#    비밀값이 아직 비어 있는 동안에는 `docker compose build` 가 필수 변수 검사(DB_PASSWORD · SECRET_KEY)에 걸리므로
#    docker build 로 직접 빌드한다.
docker build --build-context licenses=. -t localhost/just-workspace-backend:latest ./backend

# 3) 비어 있는 비밀값을 채운다(이미 값이 있는 줄은 건드리지 않는다).
docker run --rm -v "$PWD/.env:/work/.env" localhost/just-workspace-backend:latest \
  python -m app.cli gen-secrets --merge /work/.env --in-place

# 4) 파일 저장소 볼륨을 만든다. compose 는 이 이름(STORAGE_VOLUME, 기본 ws-storage-data)의 볼륨을
#    "이미 있는 것"으로 쓴다. 없으면 up 이 멈춘다.
docker volume create ws-storage-data

# 5) 띄운다(나머지 이미지는 이때 빌드된다).
docker compose config --quiet && docker compose up -d
```

- 프록시 없이 평문 80 으로 받아 보려면 `APP_URL=http://<서버 주소>`, `DOMAIN=<서버 주소>` 로 두고 `nginx/site.d/http.conf` 의 `set_real_ip_from` 줄을 지운다.
- 빈 값·예시 값·짧은 값의 비밀값으로는 backend 가 뜨지 않는다 — 로그에 변수 이름과 사유가 나온다([CONFIG.md](CONFIG.md)의 "비밀값").
- 관리자를 `.env` 에 적지 않고 만들려면 띄운 뒤 `docker compose exec backend python -m app.cli seed-admin --username <아이디>`.
- `.env` 의 `ADMIN_PASSWORD` 는 관리자가 만들어진 뒤 지운다.

## 앞단 프록시

리포의 nginx 설정(`nginx/nginx.conf` + `nginx/site.d/`)은 **"앞단 프록시 뒤, 80 평문"** 구성이다. 내장 nginx(`ws-nginx`)는 80 에서만 받고, TLS 는 앞의 프록시가 끝낸다.

- 프록시의 주소를 `nginx/site.d/http.conf` 의 `set_real_ip_from` 에 적는다(여러 개면 줄을 늘린다, CIDR 가능). `nginx/nginx.conf` 는 고치지 않는다.
- 프록시는 접속자의 주소를 `X-Real-IP` 로, 원래 프로토콜을 `X-Forwarded-Proto` 로 넘겨야 한다. `ws-nginx` 는 위에 적힌 주소에서 온 연결의 `X-Real-IP` 만 믿는다.
- WebSocket(`/ws/`, `/livekit/`, `/git/`, `/onlyoffice/`) 업그레이드와 `/api/mcp` 스트리밍(버퍼링 끔)을 프록시도 통과시켜야 한다.
- 큰 파일 올리기는 프록시의 본문 크기 제한도 풀어야 한다(내장 nginx 는 `/api/files/upload` 에 10 GB 까지 받는다).
- 컨테이너(코드 저장소·문서 편집기)가 접속 주소로 되돌아오는 길이 막혀 있으면 `.env` 의 `RP_LAN_IP` 에 프록시의 내부 주소를 적는다.
- 사이트 전용 nginx location 은 `nginx/private.d/*.conf`(git 이 추적하지 않는다)에 둔다.

**이 서버가 TLS 를 직접 끝내는 구성**(443 게시, 인증서 발급·갱신)은 설치 관리자가 `nginx/site.d/` 의 파일과 compose 조각을 만들어서 한다. 손으로 꾸리는 절차는 따로 문서화하지 않았다 — 필요하면 설치 관리자를 쓰거나, 설치 관리자가 무엇을 쓰는지([installer.md](installer.md) 8절)를 참고해 직접 만든다. `docker exec jw-installer jw render --answers <파일> --out <폴더>` 는 답변에서 나오는 파일을 폴더에 써 보여 준다.

## 구역 (`COMPOSE_PROFILES` 와 `JW_ZONES`)

두 변수를 **같이** 맞춘다. `COMPOSE_PROFILES` 는 어느 컨테이너를 띄울지, `JW_ZONES` 는 backend 가 어느 구역의 API 와 메뉴를 올릴지 정한다. `JW_ZONES` 를 비우면 모든 구역이 설치된 것으로 본다.

| 구역 (`JW_ZONES`) | 프로파일 (`COMPOSE_PROFILES`) | 컨테이너 | 함께 채울 것 |
|---|---|---|---|
| 기본 (항상) | — | ws-postgres · ws-redis · ws-backend · ws-frontend-react · ws-nginx | `SECRET_KEY`, `DB_PASSWORD` |
| `mail` | `mailserver` | ws-mailserver | `FEATURE_BUILTIN_MAILSERVER=true`, `DOVECOT_MASTER_PASSWORD`, `INTERNAL_API_KEY`, 인증서(아래). 호스트 포트 25·465·587·993 |
| `chat` | — | — | |
| `calendar` | — | — | |
| `docs` | `onlyoffice` | ws-onlyoffice | `ONLYOFFICE_JWT_SECRET`, (프록시 뒤) `RP_LAN_IP` |
| `meetings` | `livekit`, `egress`(녹화), `audiorelay`(무손실 오디오) | ws-livekit · ws-egress · ws-audiorelay | `LIVEKIT_API_KEY`·`LIVEKIT_API_SECRET`, `livekit/livekit.yaml`(아래), `AUDIORELAY_SECRET`. 호스트 포트 7881, 7882-7892/udp, 3478/udp, `LIVEKIT_TURN_TLS_PUBLISH`(기본 443), 4433/udp |
| `git` | `gitea` | ws-gitea | `GITEA_TOKEN`, `OAUTH_CLIENTS_JSON` 의 `gitea` 항목(아래). 호스트 포트 `GIT_SSH_PORT`(기본 2222) |
| `ai` | `aitools` | ws-searxng · ws-docconv · ws-sandbox | `SEARXNG_SECRET`, `SANDBOX_TOKEN`, `DOCCONV_TOKEN` |
| `sso` (애드온) | `sso` | ws-sso · ws-ldap | `INTERNAL_API_KEY`. 호스트 포트 636, 평문 389 는 `LDAP_PLAIN_BIND`(기본 127.0.0.1)에만 |
| `rbi` (애드온) | `rbi` | ws-rbi-netfilter | `RBI_PUBLIC_ORIGIN` 등 — [rbi.md](rbi.md) |
| — | `certbot` | ws-certbot | `ACME_DOMAINS`, `LETSENCRYPT_EMAIL` — 메일·회의 서버가 쓸 인증서를 받는다 |

비밀값은 3) 의 생성기가 한꺼번에 채운다. 예:

```bash
# 기본 구역만
COMPOSE_PROFILES=
JW_ZONES=core

# 협업: 메일(내장) · 채팅 · 일정 · 문서
COMPOSE_PROFILES=certbot,mailserver,onlyoffice
JW_ZONES=core,mail,chat,calendar,docs
FEATURE_BUILTIN_MAILSERVER=true
```

구역마다 손으로 해야 하는 것(설치 관리자가 대신 해 주는 일이다):

- **회의**: `cp livekit/livekit.example.yaml livekit/livekit.yaml` 한 뒤 키와 서버의 공인 주소를 채운다.
- **메일**: 메일 서명 키를 만든다(`bash scripts/generate-dkim.sh`). 메일 도메인의 DNS 레코드는 [operate.md](operate.md#6-메일-dns-레코드).
- **코드 저장소**: Gitea 를 띄운 뒤 관리 토큰(`GITEA_TOKEN`), 워크스페이스 쪽 OAuth 클라이언트(`OAUTH_CLIENTS_JSON`), Gitea 쪽 로그인 원본을 직접 등록한다. 설치 관리자가 하는 순서는 [installer.md](installer.md) 10절의 "코드 저장소(Gitea)".
- **격리 브라우저**: 세션 이미지를 따로 빌드한다 — `docker compose --profile rbi-build build rbi-mirror`.

## 운영

### 업데이트

```bash
sudo bash scripts/backup.sh --kind pre-update     # 먼저 DB 와 설정을 백업한다
bash scripts/update.sh                            # git pull → 켜진 우리 이미지 빌드 → 다시 띄우기 → 상태 확인
bash scripts/update.sh --rollback                 # 직전 업데이트 때 적어 둔 이미지로 되돌린다
```

`update.sh` 는 직접 띄운 서버 전용이다(설치 관리자로 설치한 서버는 관리 › 업데이트). DB 를 백업하지 않고, 실패해도 **스스로 되돌리지 않는다**(`--rollback` 을 안내한다). 다시 뜨는 동안 접속이 잠깐 끊긴다. 스키마 버전이 올라간 뒤에는 이미지만 되돌리면 backend 가 뜨지 않으므로 DB 도 직전 백업으로 복원해야 한다 — [update-system.md](update-system.md)의 "수동 설치", [data-safety.md](data-safety.md) 5절.

### 백업과 복원

```bash
sudo bash scripts/backup.sh [받을-폴더]              # 전체 백업을 .jwbak 한 개로(받을-폴더에서 30일 보존)
sudo bash scripts/backup.sh --include-files          # 파일 저장소도 넣는다(로컬 저장소일 때만)
sudo bash scripts/restore.sh <백업 파일> --inspect   # 내용만 본다
sudo bash scripts/restore.sh <백업 파일>             # 검증 → 정지 → DB → 스키마 → 나머지 → 시작 → 확인
```

관리 › 저장소·백업에서도 같은 형식의 백업을 만든다. 무엇이 들어가고 빠지는지, 복원의 단계는 [data-safety.md](data-safety.md).

### 상태 점검

```bash
bash scripts/health.sh          # Docker · 컨테이너 · DB · Redis · API · 디스크 · 인증서 만료 (--json)
```

로그·디스크·흔한 문제는 [operate.md](operate.md) 7~9절이 그대로 맞는다.

### 플러그인

`plugins/` 폴더가 backend 에 읽기 전용으로 붙는다. 빌드와 설치는 [extensions.md](extensions.md).

## 설치 관리자로 옮기기

직접 띄운 서버에서 전체 백업을 만들어(`scripts/backup.sh --include-files`), 새 서버의 설치 마법사에서 "백업에서 복원"으로 옮길 수 있다 — [operate.md](operate.md#3-백업과-복원-서버-이전).
