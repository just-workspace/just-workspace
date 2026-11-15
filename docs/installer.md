# 설치 관리자

Just Workspace 를 "리눅스 + Docker Engine(x86_64)" 서버에 설치하는 컨테이너다. 터미널에서 한 줄로 띄우고, 나머지는 브라우저의 마법사에서 한다. 같은 엔진이 답변 파일로 무인 설치도 한다.

> 이 문서는 **화면 없는 핵심부**(API 와 엔진)를 다룬다. 마법사 화면은 다음 단계에서 이 API 위에 올라간다.
> 손으로 `docker compose up` 하는 기존 흐름은 그대로 남아 있다 — [deployment.md](deployment.md).

## 1. 한 줄 설치

```bash
docker run -d --name jw-installer --restart unless-stopped \
  -p 8443:8443 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/just-workspace:/data \
  -e JW_HOST_DIR=/opt/just-workspace \
  <설치 관리자 이미지>

docker logs jw-installer
```

로그에 접속 주소와 인증서 지문이 나온다.

```
 브라우저에서 여세요:  https://<서버 주소>:8443/?token=XXXXXXXXXXXX
 SHA-256 지문: AB:CD:…
```

- `-v <호스트 폴더>:/data` 와 `-e JW_HOST_DIR=<같은 호스트 폴더>` 는 **반드시 같은 경로**여야 한다(§3).
- 이미지 저장소는 `-e JW_REGISTRY=<저장소/네임스페이스>`, 이미지 태그는 `-e JW_IMAGE_TAG=<태그>` 로 바꾼다. 기본은 `ghcr.io/just-workspace` 와 제품 버전(`VERSION`). `JW_REGISTRY=localhost` 를 주면 서버에 이미 있는(소스에서 빌드한) 이미지를 쓴다.
- `-e JW_PUBLIC_HOST=<서버 주소>` 를 주면 로그의 주소와 인증서 이름에 그 값을 쓴다.

이미지 빌드(리포 루트에서 — 문맥은 리포 루트, 무엇이 들어가는지는 `installer/Dockerfile.dockerignore`):

```bash
docker build -f installer/Dockerfile -t just-workspace-installer:$(cat VERSION) .
# 받을 이미지 저장소의 기본값을 바꿔 구우려면: --build-arg JW_REGISTRY=<저장소/네임스페이스>
```

## 2. 구조

```
installer/
  Dockerfile                 Python + FastAPI + docker CLI·compose 플러그인
  Dockerfile.dockerignore    빌드 문맥(번들 원본과 installer/ 만)
  app/
    answers.py     답변 모델 · 검증(필드별 오류) · 비밀 분리
    catalog.py     구역·메모리·포트 계산(zones.json 을 읽기만 한다)
    render.py      답변 → 스택 파일(순수 함수)
    envfile.py     .env 이스케이프
    validators.py  도메인·대역·경로·NFS 내보내기 등 입력 검증
    bundle.py      번들(빌드 때 리포에서 복사한 파일) 읽기
    paths.py       컨테이너 안 경로 ↔ 호스트 경로
    docker_api.py  docker·호스트 접근의 유일한 문(인자 배열)
    helper.py      보조 컨테이너 안에서 도는 명령
    preflight.py   사전 점검
    probes.py      확인(DNS·메일 레코드·SMTP·AI·NFS·로컬 폴더)
    certs.py       자체 서명 인증서, 올린 인증서 검증
    dkim.py        DKIM 키(적용 전에 미리 만든다)
    tokens.py      설치 토큰 · 세션
    state.py       상태 파일
    engine.py      적용 엔진(단계)
    zones/         구역 훅(__init__.py = 기본 동작, git.py = Gitea)
    zonectl.py     설치 뒤 구역 켜기·끄기·설정
    api.py         마법사 API(8443) · 내부 API(8444)
    cli.py         jw 명령
    server.py      서버 진입점
  tests/           docker 없이 도는 테스트
```

단일 출처는 복제하지 않는다. 이미지 빌드 때 리포에서 **복사**해 번들(`/app/bundle`)에 싣는다.

| 번들 파일 | 리포 원본 | 쓰임 |
|---|---|---|
| `zones.json` | `backend/app/zones.json` | 구역 목록·메모리·포트·compose 프로파일 |
| `security_defaults.py` | `backend/app/security_defaults.py` | 비밀값 이름·길이·금지 문자, 대체 생성기 |
| `VERSION` | `VERSION` | 제품 버전(= 받을 이미지 태그) |
| `docker-compose.yml`, `nginx/*`, `init/*`, `scripts/certbot-entrypoint.sh`, `mailserver/config/*` | 같은 경로 | compose 와 compose 가 bind mount 하는 파일 |

개발·테스트에서는 번들 폴더 없이 리포에서 바로 읽는다.

## 3. 경로 — 컨테이너 안과 호스트

설치 관리자는 컨테이너 안에서 돌고, 그것이 `docker compose` 로 만드는 컨테이너는 호스트에서 돈다. 같은 폴더가 두 이름을 갖는다.

| 뜻 | 설치 관리자 컨테이너 안 | 호스트 |
|---|---|---|
| 데이터 뿌리 | `/data` | `$JW_HOST_DIR` (예 `/opt/just-workspace`) |
| 스택 — compose 파일, 설정 파일, `.env`(권한 600) | `/data/stack` | `$JW_HOST_DIR/stack` |
| 상태 — 답변, 단계 상태, 로그, 토큰, 설치 관리자 인증서 | `/data/state` | `$JW_HOST_DIR/state` |

compose 는 늘 이렇게 부른다.

```
docker compose -p just-workspace
    --project-directory $JW_HOST_DIR/stack        ← 호스트 경로
    -f /data/stack/docker-compose.yml             ← 컨테이너 안 경로(compose CLI 가 읽는다)
    -f /data/stack/docker-compose.site.yml
    --env-file /data/stack/.env
    <명령>
```

누가 어떤 경로를 해석하는가:

- **compose 파일·`--env-file`** 은 compose CLI(설치 관리자 컨테이너 안)가 읽는다 → 컨테이너 안 경로.
- **bind mount 의 출발지**(`./nginx/nginx.conf` 같은 상대 경로)는 `--project-directory` 를 기준으로 절대 경로가 되어 docker 데몬에 전달되고, 데몬은 그것을 **호스트** 경로로 해석한다 → `--project-directory` 는 호스트 경로여야 한다.
- 서비스의 **`env_file: .env`** 도 `--project-directory` 기준인데, 이것은 데몬이 아니라 **compose CLI 가** 읽는다. 그래서 호스트 경로 문자열이 설치 관리자 컨테이너 안에서도 같은 파일을 가리켜야 한다. 설치 관리자는 기동할 때 컨테이너 안에 `$JW_HOST_DIR → /data` 심볼릭 링크를 만든다. `$JW_HOST_DIR` 와 같은 경로가 컨테이너 안에 이미 다른 것으로 있으면(`/usr` 등) 시작하지 않는다.
- 프로젝트 이름은 `-p just-workspace` 로 고정한다(폴더 이름 `stack` 을 따르지 않게). 내부망 이름은 `just-workspace_workspace`.

## 4. 답변 파일

마법사의 상태와 답변 파일은 같은 형식이다(JSON). 화면의 "답변 파일 내려받기"(`GET /api/answers/export`)는 **비밀을 뺀** 내용을 준다.

```json
{
  "version": 1,
  "mode": "new",
  "access": {
    "domain": "ws.example.com",
    "network": "direct",
    "proxy_addresses": [],
    "cert": "auto"
  },
  "storage": { "kind": "local" },
  "preset": "collab",
  "addons": [],
  "mail": { "kind": "builtin", "mail_domain": "example.com" },
  "meetings": { "public_ip": null, "turn": true, "lossless_audio": false },
  "ai": { "mode": "later" },
  "git": { "version": "verified" },
  "advanced": { "subnet": "172.28.0.0/24" },
  "admin": { "name": "관리자", "username": "admin" }
}
```

| 항목 | 값 |
|---|---|
| `mode` | `new` · `quick`(구역을 안 고르면 협업 묶음, 메모리가 모자라면 최소 묶음으로 내리고 사유를 남긴다) · `restore`(이번 단계에는 없음) |
| `access.domain` | 접속 주소(도메인 이름, 또는 임시 인증서와 함께 IP 주소) |
| `access.network` | `direct`(이 서버가 직접 받는다) · `router`(공유기 뒤 — 포트 넘김 안내) · `proxy`(앞단 프록시 뒤) |
| `access.proxy_addresses` | `proxy` 일 때 프록시 주소(IPv4 또는 CIDR) 목록 |
| `access.cert` | `auto`(Let's Encrypt) · `upload` · `temporary`(자체 서명 — 접속 주소가 서버를 안 가리키거나 확인할 수 없을 때, 또는 발급이 실패한 뒤에만) · `proxy`(프록시가 처리) |
| `access.cert_path` / `key_path` | 무인 설치에서 `upload` 일 때의 파일(`/data/` 아래) |
| `storage` | `{"kind":"local"}`(도커 볼륨) · `{"kind":"local","path":"/srv/files"}`(호스트에 이미 있는 폴더) · `{"kind":"nfs","server":"…","export":"/…"}`. DB·메일함은 늘 로컬 |
| `preset` / `zones` / `addons` | `zones`(켤 구역 id 목록)가 있으면 그것, 없으면 `preset`(`minimal`·`collab`·`full` — `zones.json` 의 presets). `addons` 는 부가 구역(`sso`, `rbi`) |
| `mail` | `builtin` + `mail_domain`, 또는 `external` + `host`·`port`·`security`(`starttls`/`ssl`/`none`)·`username`·`password` |
| `meetings` | `public_ip`(비우면 감지값) · `turn`(중계) · `lossless_audio`(UDP 4433, 채팅 구역도 필요) |
| `ai` | `{"mode":"later"}` 또는 `{"mode":"provider","provider":"anthropic\|openai\|gemini\|ollama\|compatible","api_key":"…","model":"…","base_url":"…"}` |
| `git.version` | `verified`(compose 에 고정한 이미지) · `latest` · 이미지 태그 |
| `advanced.subnet` | 내부 대역(사설 IPv4 /24, 기본 `172.28.0.0/24`) |
| `admin` | `name` · `username` · `password`(12자 이상) |

- 비밀(`admin.password`, `mail.password`, `ai.api_key`)은 저장할 때 따로 떼어 `answers.secret.json`(600)에 둔다. 관리자 비밀번호와 AI 키는 쓰고 나면 지운다.
- 무인 설치에서 비밀은 파일에 적거나 환경변수로 준다: `JW_ADMIN_PASSWORD`, `JW_MAIL_PASSWORD`, `JW_AI_API_KEY`.
- 꺼진 구역의 항목은 검사하지 않고 쓰지도 않는다. 모르는 항목은 거부한다.
- 검증은 필드별 오류를 낸다: `{"field": "access.cert", "code": "cert_not_proxy_behind_proxy", "vars": {…}}`. 문구는 화면이 가진다.
- 메모리 판정: 고른 구역의 `memory_mb.recommend` 합계(기본 포함)가 서버 메모리보다 크면 적용할 수 없다. 서버 메모리는 1GB 단위로 올림한 값과 실측의 차이가 8% 안이면 올림값으로 본다("4GB 서버"의 실측은 3.8GB 안팎이다). 4GB 미만은 사전 점검 실패.

## 5. 접속과 보안 모델

- **HTTPS 8443, 자체 서명 인증서.** 첫 기동 때 만들어 `/data/state/tls/` 에 두고 SHA-256 지문을 로그에 찍는다. 브라우저의 경고 화면에서 지문을 대조한다.
- **설치 토큰.** 영문 대문자·숫자 12자리(0/O/1/I 없음), 24시간. 주소의 `?token=` 으로 들어오면 확인 뒤 토큰 없는 주소로 넘기고 세션 쿠키(`HttpOnly`·`Secure`·`SameSite=Strict`)를 준다. 틀리면 `token_wrong`, 만료면 `token_expired`. 5번 틀리면 30초 동안 받지 않는다(`token_locked`). `docker exec jw-installer jw token` 으로 다시 발급하면 옛 토큰은 무효가 되고, 입력해 둔 답과 열린 세션은 그대로다.
- **잠금.** 설치가 끝나면 토큰과 세션을 없애고 마법사 API 는 `423 locked` 만 답한다. `GET /api/state` 만 남는다(설치됨 표시와 워크스페이스 주소).
- **내부 API.** 설치 뒤의 관리 동작은 `/internal/*` 로만 받는다. 다른 포트(8444)에서 평문으로 뜨고 **호스트에 게시하지 않는다.** 설치 관리자는 적용 중에 자신을 워크스페이스 내부망에 `jw-installer` 라는 이름으로 붙인다. 요청은 공유 키(`X-JW-Installer-Key`, 설치 때 만들어 backend 의 `JW_INSTALLER_KEY` 로 전달)와 내부 대역의 출발지 주소를 둘 다 만족해야 하고, 아니면 404 다. 브라우저는 이 포트에 닿지 못한다.
- **docker.sock.** 설치 관리자는 호스트의 docker 소켓을 쥔다 — 이 컨테이너를 장악하면 서버를 장악한 것과 같다. 그래서 (1) 밖으로는 토큰으로 막은 8443 하나만 열고, (2) 설치가 끝나면 그 문도 잠그며, (3) 사용자 입력은 모두 검증하고 명령은 인자 배열로만 만든다(셸을 거치지 않는다). 설치가 끝난 뒤 8443 게시를 방화벽에서 닫아도 된다(내부 API 는 영향받지 않는다).
- **비밀값.** 생성 규칙의 단일 출처는 backend 의 `security_defaults` 다. 설치 관리자는 backend 이미지를 한 번 실행해(`python -m app.cli gen-secrets --format json`) 받아 쓰고, 그 이미지를 쓸 수 없을 때만 번들에 실린 같은 표로 만든다. 비밀값은 로그에 찍지 않으며(알고 있는 값은 가린다), 명령 인자에도 싣지 않는다(`--env-file`·표준 입력). 예외는 Gitea 의 `auth add-oauth --secret` 하나다 — Gitea CLI 가 다른 길을 주지 않는다.

## 6. API

오류 응답은 모두 `{"code": "…", "vars": {…}}`. 세션이 없으면 `401 auth_required`, 설치 뒤에는 `423 locked`.

### 마법사 API (8443, 세션 필요)

| 메서드·경로 | 하는 일 |
|---|---|
| `GET /?token=…` | 토큰 확인 → 세션 쿠키 → `/` 로 넘김 |
| `POST /api/session` `{"token"}` | 토큰을 직접 입력했을 때 |
| `GET /api/state` | 어디까지 했는지(단계 `wizard`/`applying`/`installed`, 답변 유무, 사전 점검 통과 여부, 적용 상태·오류·대안, 토큰 만료 시각) |
| `GET /api/answers` · `PUT /api/answers` | 답변 조회 · 부분 저장(겹쳐 합친다, `null` 은 기본값으로). 응답: `{"answers", "secrets_set", "errors"}` |
| `GET /api/answers/export` | 비밀을 뺀 답변 파일 |
| `POST /api/preflight` | 사전 점검(§7) |
| `GET /api/zones` | `zones.json` + 고른 구역 + 서버 메모리 대비 판정(`fits`, `preset_fits`, `memory`) |
| `GET /api/probe/public-ip` | 공인 주소 감지 |
| `POST /api/probe/dns` | 접속 주소가 이 서버를 가리키는가: `match`/`mismatch`(가리키는 주소 포함)/`unknown` |
| `POST /api/probe/mail-records` | MX·A·SPF·DKIM·DMARC 의 기대값과 현재값: `ok`/`missing`/`different`/`unknown` |
| `POST /api/probe/cert` `{"cert","key"}` | 올린 인증서 검증(도메인·키 짝·만료·발급자·메일 호스트 이름). 통과하면 보관 |
| `POST /api/probe/smtp` · `/ai` | 외부 SMTP 로그인 · AI 키 확인 |
| `POST /api/probe/nfs` · `/local-path` | NFS 다섯 단계 · 로컬 폴더(있는가, 쓸 수 있는가) |
| `GET /api/summary` | 요약 + 주의 모음 + 열리는 포트 + 단계 목록 + `ready` |
| `POST /api/apply` | 적용 시작(202) |
| `GET /api/apply` | 단계 상태(폴링용) |
| `GET /api/apply/stream` | 같은 내용의 SSE(`event: status`, 끝나면 `event: end`) |
| `POST /api/apply/retry` `{"use_temporary_cert"?}` | 실패한 단계부터 다시 |
| `GET /api/apply/log?step=&tail=` | 단계 로그 |
| `POST /api/restore…` | 501(이번 단계 범위 밖) |

적용 상태(`GET /api/apply`):

```json
{
  "status": "running",
  "current": "pull",
  "steps": [
    {"id": "config", "status": "done", "started_at": "…", "finished_at": "…", "error": null, "detail": {}},
    {"id": "pull", "status": "running", "detail": {"images": [{"image": "…", "status": "pulling", "progress": "…"}]}}
  ],
  "error": null,
  "warnings": [], "notes": [], "alternatives": []
}
```

실패하면 `status: "failed"`, `error: {"step", "cause", "fix", "vars"}`. `cause`·`fix` 는 문구 키다. 인증서 발급이 실패하면 `alternatives: [{"key": "use_temporary_cert"}]` 가 붙는다. `zones` 단계의 `detail.zones` 는 구역별 상태(`pending`→`installing`→`installed`→`connecting`→`done`).

### 내부 API (8444, 공유 키 + 내부 대역)

| 메서드·경로 | 하는 일 |
|---|---|
| `GET /internal/health` | 키 없이 — 버전, 설치 여부 |
| `GET /internal/zones` | 구역 목록(켜짐 여부, 메모리 판정, 설정 유무) |
| `POST /internal/zones/<id>/check` `{"settings"}` | 켜도 되는가 — 설정 오류, 메모리, 새로 열리는 포트, 주의(아무것도 바꾸지 않는다) |
| `POST /internal/zones/<id>/enable` `{"settings"}` | 켜기(202 + 작업). 메모리가 모자라면 `409 memory_insufficient`, 설정이 틀리면 `422 settings_invalid` |
| `POST /internal/zones/<id>/disable` | 끄기(연결 해제 + 컨테이너 정지, 데이터 볼륨은 남는다) |
| `GET /internal/zones/<id>/settings` | 켜진 구역의 설정 다시 열기(비밀은 `…_set` 여부만) |
| `PUT /internal/zones/<id>/settings` `{"settings"}` | 설정 바꾸기(202 + 작업) |
| `GET /internal/jobs/<id>` · `/log` | 작업 진행·로그 |
| `POST /internal/probe/smtp` · `/ai` | 구역 켜기 창의 "연결 확인" |

구역별 `settings`:

| 구역 | 값 |
|---|---|
| `mail` | `kind`: `builtin` + `mail_domain` / `external` + `host`·`port`·`security`·`username`·`password` |
| `meetings` | `turn`(중계), `lossless_audio` — 공인 주소는 `GET …/settings` 의 `detected.public_ip` |
| `ai` | `mode`: `now` + `provider`(`openai`/`anthropic`/`google`)·`api_key`(·`model`·`base_url`) / `later` |
| `git` | `version`: `tested`/`latest`/`custom` + `custom_version` |
| 그 밖 | 없음 |

작업은 `{"id", "kind": enable|disable|update, "zone", "status": running|done|failed, "stages": [{"id", "status"}], "ports", "error", "warnings"}`. 켜기의 단계는 `pull`(받기) → `configure`(설정) → `connect`(연결). 실패하면 답변·`.env`·컨테이너를 되돌려 **꺼진 채**로 둔다. 성공하면 `.env` 의 `JW_ZONES`·`COMPOSE_PROFILES` 가 바뀌고 backend 가 다시 뜬다. 한 번에 한 작업만 돈다(`409 busy`).

### 명령(`docker exec jw-installer jw …`)

| 명령 | 하는 일 |
|---|---|
| `jw token` | 설치 토큰 다시 발급 |
| `jw status [--json]` | 단계별 상태 |
| `jw apply --answers <파일> [--dry-run]` | 답변 파일로 설치. `--dry-run` 은 검증·렌더링까지만 하고 산출물 요약을 낸다(아무것도 바꾸지 않는다) |
| `jw render --answers <파일> --out <폴더>` | 산출물을 폴더에 써 본다(비밀값은 견본) |
| `jw reset-admin <계정> [--disable-2fa]` | backend 의 `python -m app.cli reset-admin` 호출 |

## 7. 사전 점검

`fail` 이 하나라도 있으면 적용할 수 없다. 적용을 시작할 때도 한 번 더 돈다.

| id | 통과 조건 | 실패 | 얻는 방법 |
|---|---|---|---|
| `docker_engine` | 24.0 이상 | fail | `docker info` 의 `ServerVersion` |
| `docker_compose` | 2.20 이상 | fail | `docker compose version --short` — 이미지에 든 플러그인(실제로 쓰는 것) |
| `cpu` | 2 이상 | fail | `docker info` 의 `NCPU` |
| `memory` | 4GB 이상, 고른 구역의 권장 합계 이상 | fail | `docker info` 의 `MemTotal` |
| `arch` | `x86_64` | fail | `docker info` 의 `Architecture` |
| `disk` | 10GB 이상(20GB 미만은 warn) | fail/warn | 도커 데이터: 익명 볼륨을 붙인 보조 컨테이너에서 여유 공간(볼륨은 도커 데이터 폴더와 같은 파일 시스템). 설치 폴더: 설치 관리자의 `/data` |
| `time_sync` | 커널 시계 동기화 | warn | `adjtimex()` — 커널 시계 상태는 컨테이너에서도 호스트 것이 보인다 |
| `port_80` · `port_443` | 비어 있음(우리 컨테이너가 쓰는 것은 통과, 443 은 필요할 때만) | fail | `--network host` 보조 컨테이너에서 직접 bind. 소유는 `docker ps` 의 게시 포트로 가린다 |
| `port_25` | 비어 있음 | warn | 같은 방법 — 내장 메일을 쓸 때만 문제 |
| `subnet` | 내부 대역이 기존 도커 네트워크·호스트 경로표와 안 겹침 | fail | `docker network inspect` + `--network host` 보조 컨테이너의 `/proc/net/route` |
| `internet` · `registry` | 닿음 | warn | 설치 관리자 컨테이너에서 HTTPS 요청(오프라인 설치일 수 있어 경고까지만) |
| `selinux` | (정보) | — | 보조 컨테이너의 `/sys/fs/selinux/enforce`, 없으면 `docker info` 의 `SecurityOptions` |

보조 컨테이너는 설치 관리자 **자신의 이미지**로 띄운다(`python -m app.helper …`) — 따로 받을 이미지가 없다.

항목 형태: `{"id", "status": "pass|warn|fail", "value", "fix": {"key", "vars"} | null}`.

### 확인(probe)

- **공인 주소**: 서버의 나가는 주소가 공인 주소면 그것. 아니면 바깥 서비스 네 곳에 차례로 묻고 **같은 답이 둘 이상**일 때만 믿는다. 아니면 `unknown`.
- **NFS**: ① 서버에 닿는가(TCP 2049) ② 붙일 수 있는가 ③ 쓰기·읽기·지우기(backend 가 쓰는 uid/gid `1000:1000` 으로) ④ 파일 잠금 ⑤ 여유 공간(10GB 미만은 warn). NFS 옵션의 임시 도커 볼륨을 만들어 보조 컨테이너에서 검사하고 지운다. 실패 원인: `unreachable`, `permission_denied`, `read_only`, `no_locking`. 옵션은 `rw,nfsvers=4.1,hard,noatime` 고정.
- **로컬 폴더**: `--mount type=bind` 로 붙여 본다(`-v` 는 없는 폴더를 만들어 버린다). `ok`/`not_found`/`not_writable`.
- **DKIM**: 메일 레코드 화면에서 보여 줘야 하므로 확인할 때 키를 만들어 `/data/state/dkim/` 에 둔다. 서버 구성에는 적용 때 들어간다.

## 8. 렌더링 — 답변에서 나오는 파일

`render(answers, secrets, facts, bundle)` 는 순수 함수다. 스택 폴더 기준 경로 → 내용.

| 파일 | 내용 |
|---|---|
| `docker-compose.yml`, `nginx/nginx.conf`, `nginx/security-headers.conf`, `init/init-db.sh`, `scripts/certbot-entrypoint.sh`, `mailserver/config/{user-patches.sh,auth-workspace.lua,dovecot.cf}` | 번들에서 **그대로** |
| `.env` (600) | 아래 표 |
| `docker-compose.site.yml` | 사이트별 조각 — TLS 를 직접 끝낼 때 nginx 의 `443:443` |
| `nginx/site.d/{http,listen-main,listen-rbi,headers}.conf` | 아래 "nginx" |
| `livekit/livekit.yaml` | 회의 구역일 때 |
| `mailserver/config/postfix-accounts.cf`, `dovecot-masters.cf`, `rspamd/…`, `user-patches.d/10-dkim.sh` | 내장 메일일 때 |
| `nginx/private.d/.keep`, `plugins/.keep` | compose 가 폴더째 붙이는 자리 |

### nginx

리포의 `nginx/nginx.conf` 는 어느 설치에서나 같다. 사이트마다 다른 부분은 `nginx/site.d/` 의 네 파일로 뺐고, `nginx.conf` 와 `security-headers.conf` 가 그것을 include 한다. 리포에 든 기본 파일은 "앞단 프록시 뒤, 80 평문" 구성이라 **손으로 띄우는 흐름은 그대로**다(프록시 주소는 `nginx/site.d/http.conf` 에서 바꾼다). 설치 관리자는 그 네 파일만 새로 쓴다.

| 경우 | `http.conf` | `listen-*.conf` | `headers.conf` |
|---|---|---|---|
| `direct`/`router` + `auto`/`upload` | 인증서 경로·TLS 설정 + 80 서버(인증서 확인 요청, 나머지는 https 로 넘김) | `listen 443 ssl` | HSTS |
| `direct`/`router` + `temporary` | 위와 같음 | `listen 443 ssl` | (없음 — 자체 서명에 HSTS 를 붙이면 경고를 넘길 수 없다) |
| `proxy` | `set_real_ip_from <프록시 주소>` 줄들 | `listen 80` | (없음) |

### 인증서 배치

서비스마다 찾는 폴더 이름이 다르다. 인증서는 **하나**(필요한 이름을 모두 담는다)를 받아 각자 찾는 자리에 링크로 놓는다. 인증서 볼륨(`ws-certbot-data` = 컨테이너의 `/etc/letsencrypt`) 안:

```
live/<접속 주소>/                 nginx · 무손실 음성 릴레이
live/mail.<메일 도메인>  → <접속 주소>     메일 서버
live/turn.<접속 주소>    → <접속 주소>     회의 서버(TURN/TLS)
jw/<접속 주소>/                   올린 파일·임시 인증서의 실제 파일(live/<접속 주소> 가 여기를 가리킨다)
```

- 인증서에 들어가는 이름: 접속 주소, `mail.<메일 도메인>`(내장 메일), `turn.<접속 주소>`(회의 중계), `rbi.<접속 주소>`(격리 브라우저).
- `auto`: nginx 가 아직 없으면 certbot 이 80 을 직접 듣고(standalone), 이미 떠 있으면 webroot 로 받는다. 갱신은 certbot 컨테이너가 한다.
- 무손실 음성 릴레이는 비루트(gid 65532)라 개인 키를 그룹 읽기로 열어 준다.
- **갱신 뒤 다시 읽히기**는 설치 관리자가 맡는다: 한 시간마다 인증서 지문을 보고, 달라졌으면 권한을 다시 맞추고 nginx 를 reload, 회의 서버를 재시작한다(메일 서버와 음성 릴레이는 스스로 다시 읽는다).
- `proxy`: 웹 인증서는 프록시 몫이다. 메일·회의 서버가 찾는 자리에는 **자체 서명** 인증서를 둔다(주의 `proxy_side_certs_self_signed`).

### 회의의 TURN/TLS 포트

회의 서버는 TURN/TLS 를 늘 `turns:<이름>:443` 으로 알린다. 한 서버에서 nginx 가 443 을 쓰면 겹치므로, 직접 받는 구성(`direct`/`router`)에서는 TURN/TLS 를 호스트의 **5349** 에 게시한다(`LIVEKIT_TURN_TLS_PUBLISH=5349`). 이 경우 밖에서 `turn.<접속 주소>:443` 을 5349 로 넘겨 주는 장치가 따로 없으면 TURN/TLS 는 쓰이지 않고, 회의는 UDP 3478(TURN)·UDP 7882-7892·TCP 7881 로 붙는다. `proxy` 구성에서는 이 서버의 443 이 비어 있으므로 443 에 게시한다.

### 저장소

compose 는 저장소 볼륨(`ws-storage-data`)을 `external` 로 쓴다. 설치 관리자가 그 이름의 볼륨을 답변대로 만든다 — compose 파일은 바뀌지 않는다.

| 답변 | 볼륨 |
|---|---|
| `local` | 옵션 없는 도커 볼륨 |
| `local` + `path` | local 드라이버 `type=none,o=bind,device=<호스트 폴더>` |
| `nfs` | local 드라이버 `type=nfs,o=addr=<서버>,rw,nfsvers=4.1,hard,noatime,device=:<내보내기 경로>` |

만든 뒤 저장소 뿌리에 **표식 파일** `.jw-storage`(설치 id 포함)를 쓴다. backend 는 `STORAGE_MARKER_REQUIRED=1` 일 때 이 파일이 안 보이면(또는 설치 id 가 다르면) 파일 쓰기 API(`/api/files…`, `/api/wopi/files…`)를 `503 storage_unavailable` 로 거부하고 관리자에게 알린다 — 끊긴 저장소 자리의 빈 폴더에 쓰는 사고를 막는다. 같은 이름의 볼륨이 다른 옵션으로 이미 있거나, 표식이 다른 설치의 것이면 건드리지 않고 멈춘다.

### `.env` 변수의 출처

"생성" = backend 의 비밀값 생성기, "답변" = 답변에서 그대로, "파생" = 답변·감지값에서 계산, "고정" = 설치 관리자가 정한 값, "훅" = 구역 훅이 채움, "—" = 설치 관리자가 쓰지 않음(compose·backend 의 기본값).

| 변수 | 출처 | 값 |
|---|---|---|
| `DEPLOY_MODE` | 파생 | `proxy` → `external_proxy`, 그 밖 → `standalone` |
| `COMPOSE_PROFILES` | 파생 | 고른 구역의 `compose_profiles` 합집합. 외부 메일이면 `mailserver` 제외, 무손실 오디오가 꺼져 있으면 `audiorelay` 제외, `cert=auto` 면 `certbot` 추가 |
| `JW_ZONES` | 파생 | `core,<구역들>` — 맨 앞의 `core` 는 "빈 값 = 전부" 규칙을 피하려고 늘 적는다 |
| `STORAGE_VOLUME` | 고정 | `ws-storage-data` |
| `APP_NAME` | 고정 | `Workspace`(관리 화면에서 바꾼다) |
| `APP_URL` | 파생 | `https://<접속 주소>` |
| `DOMAIN` | 파생 | 내장 메일이면 메일 도메인(계정의 메일 주소가 `<계정>@DOMAIN`), 아니면 접속 주소 |
| `DEBUG` | 고정 | `false` |
| `SECRET_KEY`, `INTERNAL_API_KEY`, `DB_PASSWORD` | 생성 | |
| `BACKEND_WORKERS` | 파생 | `min(8, max(2, CPU 수))`, 메모리 6GB 미만이면 2 |
| `BACKEND_CPUS`, `DATABASE_URL`, `DOMAIN_ALIAS`, `MCP_PUBLIC_URL` | 고정 | 빈 값 |
| `ALLOW_NATIVE_APP_ORIGINS`, `BRAND_*`, `OAUTH_DYNAMIC_CLIENTS_MAX`, `MCP_INTERNAL_TOOLS_ENABLED`, `MCP_API_KEY`, `GPU_HOST_IP`, `DESKTOP_*`, `RBI_ALLOW*`, `RBI_PROTECTED`, `RBI_IMAGE`, `RBI_NETWORK`, `RBI_SUBNET`, `RBI_IP_RANGE`, `RBI_BRIDGE`, `RBI_MAX_SESSIONS`, `RBI_REQUIRE_GUARD`, `AUDIORELAY_WT_SELF_SIGNED_HOSTS`, `SANDBOX_*`·`DOCCONV_*` 상한 | — | |
| `DB_NAME`, `DB_USER` | 고정 | `workspace` |
| `FEATURE_BUILTIN_MAILSERVER` | 파생 | 메일 구역 + `builtin` 일 때만 `true` |
| `DOVECOT_MASTER_USER` / `…_PASSWORD` | 고정 / 생성 | 내장 메일일 때 `portal` |
| `MAIL_SSL_TYPE` | 고정 | `letsencrypt`(= `live/mail.<도메인>/` 에서 읽는다) |
| `SMTP_HOST`·`PORT`·`USER`·`PASSWORD`·`FROM` | 파생/답변/생성 | 내장: `mailserver`·587·`noreply@<메일 도메인>`·생성. 외부: 답변. 메일 구역이 없으면 빈 값 |
| `ADMIN_EMAILS` | 파생 | `<관리자 계정>@DOMAIN` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | 쓰지 않는다. 관리자는 `seed-admin` 으로 만들고 비밀번호는 파일에 남기지 않는다 |
| `GITEA_URL` / `GITEA_EXTERNAL_URL` | 고정 / 파생 | `http://gitea:3000` / `APP_URL/git/` |
| `GITEA_TOKEN`, `OAUTH_CLIENTS_JSON` | 훅 | 코드 저장소 구역 훅 |
| `GITEA_IMAGE` | 답변 | `git.version` |
| `GIT_SSH_PORT` / `GIT_SSH_DOMAIN` | 고정 / 파생 | 2222 / 접속 주소 |
| `LIVEKIT_API_KEY`·`SECRET`, `AUDIORELAY_SECRET`, `ONLYOFFICE_JWT_SECRET`, `SANDBOX_TOKEN`, `DOCCONV_TOKEN`, `SEARXNG_SECRET` | 생성 | 그 구역이 켜져 있을 때만 싣는다 |
| `LIVEKIT_URL` | 고정 | `http://livekit:7880` |
| `LIVEKIT_TURN_TLS_PUBLISH` | 파생 | `proxy` → 443, 그 밖 → 5349 |
| `AUDIORELAY_WT_PUBLIC_URL` | 파생 | 무손실 오디오 + 신뢰되는 인증서일 때 `https://<접속 주소>:4433/audiorelay/wt` |
| `AUDIORELAY_WT_PORT` / `…_CERT` / `…_KEY` | 고정 / 파생 | 4433 / `live/<접속 주소>/…` |
| `RBI_PUBLIC_ORIGIN` | 파생 | 격리 브라우저일 때 `https://rbi.<접속 주소>` |
| `RBI_PUBLISH_IP` | 파생 | 내부 대역의 `.1` |
| `LDAP_PLAIN_BIND` | 고정 | `127.0.0.1` |
| `LETSENCRYPT_EMAIL` | 답변/파생 | `access.acme_email` 또는 `admin@DOMAIN` |
| `ACME_DOMAINS` | 파생 | 인증서에 들어갈 이름(첫 이름 = 접속 주소) |
| `RP_LAN_IP` / `HAIRPIN_HOST` | 파생 | 컨테이너가 접속 주소로 되돌아올 때의 우회. 직접 받는 구성: 내장 nginx(`<내부 대역>.2`). `proxy`: 프록시 주소가 하나(단일 주소)면 그 주소, 아니면 끔(`hairpin-off.invalid`) |
| `JW_NET_PREFIX` | 답변 | `advanced.subnet` 의 앞 세 자리 |
| `JW_REGISTRY` / `JW_VERSION` | 고정 | 설치 관리자의 `JW_REGISTRY` / 제품 버전(또는 `JW_IMAGE_TAG`) |
| `JW_APP_VERSION` | 고정 | 제품 버전(번들의 `VERSION`) — 화면에 보이는 버전. 이미지에 구운 값보다 우선한다 |
| `COMPOSE_PROJECT_NAME` | 고정 | `just-workspace` |
| `STORAGE_MARKER_REQUIRED` / `JW_INSTALL_ID` | 고정 | `1` / 설치 id |
| `JW_INSTALLER_URL` / `JW_INSTALLER_KEY` | 고정 / 생성 | `http://jw-installer:8444` / 내부 API 키 |

값은 compose 의 dotenv 규칙에 맞춰 이스케이프한다: 안전한 글자뿐이면 그대로, 그 밖에는 작은따옴표(치환 없음), 작은따옴표가 든 값만 큰따옴표 + 역슬래시. 줄바꿈이 든 값은 받지 않는다.

## 9. 적용 단계

| 단계 | 하는 일 | 대표 실패 원인 |
|---|---|---|
| `config` | 비밀값 생성(이미 있는 것은 유지) → 스택 파일 쓰기 → `compose config -q`. 도커 볼륨 저장소면 여기서 볼륨·표식까지 | `compose_invalid` |
| `storage` | (NFS·지정 폴더일 때만) 볼륨 만들기 + 표식 | `unreachable`, `permission_denied`, `read_only`, `storage_other_install`, `storage_volume_mismatch` |
| `pull` | `compose config --images` 의 이미지를 하나씩 받는다(이미지별 진행). 받지 못해도 서버에 이미 있으면 경고만 | `image_pull_failed` |
| `database` | postgres·redis 시작, healthy 대기 | `database_not_ready` |
| `cert` | (프록시가 맡고 따로 필요한 이름도 없으면 생략) 발급·배치 | `cert_issue_failed`(대안: 임시 인증서), `cert_invalid`, `cert_upload_missing` |
| `zones` | backend·frontend·nginx 시작 → 설치 관리자를 내부망에 연결 → 구역마다 `install` → 구역마다 `connect` → 연동 값이 바뀌었으면 backend 다시 시작 → DB 에 저장되는 설정 넣기 | `service_not_ready`, `git_*` |
| `admin` | `seed-admin`(비밀번호는 env 파일로 넘기고 지운다) | `admin_username_taken` |
| `lock` | 단계 `installed`, 토큰·세션 폐기 | |

- 시작 전에 답변 검증과 사전 점검을 한다. 걸리면 단계 없이 `failed`(`answers_invalid`, `preflight_failed`).
- 단계는 멱등하다. `POST /api/apply/retry` 는 실패한 단계부터 다시 돌고, 끝난 단계는 건드리지 않는다.
- 상태는 단계가 바뀔 때마다 `/data/state/apply.json` 에 쓴다. 브라우저를 닫아도 계속 돌고, 설치 관리자가 재시작하면 끊긴 단계부터 잇는다.
- 로그는 `/data/state/logs/<단계>.log`. 알고 있는 비밀값은 `***` 로 가린다.

## 10. 구역 훅 쓰는 법

`installer/app/zones/<구역 id>.py` 에 필요한 함수만 둔다. 없는 함수는 기본 동작을 쓴다.

```python
from app.engine import StepError
from app.zones import default_install, default_remove

def install(ctx, zone_id):      # 컨테이너를 띄우고 초기 설정
    default_install(ctx, zone_id)

def connect(ctx, zone_id):      # 워크스페이스와 잇는다
    ctx.set_env(SOME_TOKEN="…")           # .env 에 넣을 값 — 끝나면 backend 가 한 번 다시 뜬다

def remove(ctx, zone_id):       # 연결을 끊고 멈춘다(데이터 볼륨은 남긴다)
    default_remove(ctx, zone_id)
```

- 기본 동작: `zones.json` 의 `services` 중 지금 프로파일에서 켜지는 것을 `compose up -d` 하고 준비될 때까지 기다린다. `remove` 는 `stop` + `rm -f`(볼륨 옵션 없음).
- `ctx` 가 주는 것: `zone_services()`, `up()`, `wait_ready()`, `stop()`, `docker.exec(container, argv, user=, env_file=, input=)`, `http.get(url, headers)`, `set_env()`, `secrets()`, `answers`, `plan`, `log()`, `warn(key, **vars)`, `redact(value)`.
- 실패는 `StepError(cause, fix, **vars)`. 설치를 막을 일이 아니면 `ctx.warn()` 으로 남기고 계속한다.
- 여러 번 불려도 같은 결과가 나와야 한다. 명령은 인자 배열로만, 비밀값은 `env_file`·`input` 으로.

### 코드 저장소(Gitea)

| 순서 | 하는 일 |
|---|---|
| 1 | 이미지: `GITEA_IMAGE`(렌더링이 `git.version` 에서 정한다) |
| 2 | 컨테이너 시작, `/api/healthz` 대기 |
| 3 | `environment-to-ini` 로 `app.ini` 의 DB 를 워크스페이스의 PostgreSQL(`gitea` 데이터베이스)로 맞추고 재시작 |
| 4 | 관리 계정 `jw-admin`(무작위 비밀번호 — backend 전용) |
| 5 | 관리 토큰 발급 → `GITEA_TOKEN`(backend 는 이 토큰 + `Sudo` 헤더로 사용자 권한을 대신한다). 살아 있는 토큰이 있으면 다시 만들지 않는다 |
| 6 | 워크스페이스 OAuth 클라이언트 `gitea` → `OAUTH_CLIENTS_JSON`(리다이렉트 `APP_URL/git/user/oauth2/workspace/callback`) |
| 7 | Gitea 의 로그인 원본 `workspace`(OpenID Connect, `APP_URL/oauth/.well-known/openid-configuration`) |
| 8 | 앞단 경로 `/git/` 확인 |

7 은 Gitea 가 접속 주소로 되돌아가 설정 문서를 읽으므로 **신뢰되는 인증서**가 필요하다. 임시 인증서에서는 실패하고, 설치는 주의(`git_sso_pending`)를 남기고 계속한다. 끌 때는 로그인 원본을 지우고 토큰·클라이언트를 설정에서 뺀 뒤 컨테이너를 멈춘다. 데이터 볼륨(`ws-gitea-data`)은 남는다.

## 11. 테스트

```bash
cd installer
python -m venv <리포 밖 폴더>/venv && <그 venv>/bin/pip install -r requirements-dev.txt
<그 venv>/bin/python -m pytest -q
```

docker 없이 돈다. docker·DNS·HTTP·SMTP 는 가짜로 바꾼다(`tests/fakes.py`, `tests/harness.py`). 렌더링 스냅샷은 `tests/snapshots/` — 의도한 변경이면 `JW_UPDATE_SNAPSHOTS=1` 로 다시 만든다.

## 12. 알려진 한계

- **마법사 화면이 없다.** `/` 는 안내 문구만 낸다.
- **복원**(`mode: restore`)은 없다(501).
- **backend 쪽 호출부가 없다.** 내부 API 는 준비돼 있지만 워크스페이스 관리 화면이 그것을 부르는 코드는 다음 단계다. backend 에는 `JW_INSTALLER_URL`·`JW_INSTALLER_KEY` 만 전달된다.
- **TURN/TLS**: 직접 받는 구성에서는 5349 에 게시되므로, 443 을 넘겨 주는 장치가 없으면 쓰이지 않는다(§8).
- **앞단 프록시 구성의 메일·회의 인증서**는 자체 서명이다. 신뢰되는 인증서가 필요하면 지금은 손으로 넣어야 한다.
- **메일 도메인과 접속 주소가 다르면** `DOMAIN` 은 메일 도메인이 된다. backend 가 `DOMAIN` 을 표시용으로도 쓰는 자리(메일 제목 머리말 등)에는 메일 도메인이 나온다.
- **외부 SMTP 의 보안 방식**과 **AI 제공자**는 DB 설정이라 backend 가 뜬 뒤 `python -m app.cli configure` 로 넣는다. 실패하면 주의(`backend_settings_not_applied`)만 남는다.
- **NFS** 는 v4.1 만 쓴다(잠금이 프로토콜에 든 버전). v3 만 되는 서버는 붙지 않는다.
- **저장소 표식**은 `/api/files`·`/api/wopi/files` 의 쓰기만 막는다. 채팅 첨부·메일 보관처럼 다른 경로로 저장소에 쓰는 기능은 아직 막지 않는다.
- **인증서 방식 바꾸기**(임시 → 자동 등)를 설치 뒤에 하는 API 는 없다.
- **업데이트**(이미지 교체·채널 검증)는 다음 단계다.
