# 설치 관리자

Just Workspace 를 "리눅스 + Docker Engine(x86_64)" 서버에 설치하는 컨테이너다. 터미널에서 한 줄로 띄우고, 나머지는 브라우저의 마법사에서 한다. 같은 엔진이 답변 파일로 무인 설치도 한다.

> 이 문서는 설치 관리자의 **핵심부**(API 와 엔진)를 다룬다. 마법사 화면은 `frontend-react/src/installer-app/` 의 독립 번들이고,
> 설치 관리자 이미지에 함께 실려 8443 의 `/` 에서 나온다.
> 설치하는 사람을 위한 안내(준비물·화면별 설명·문제 해결)는 [install.md](install.md), 설치 뒤의 운영은 [operate.md](operate.md).
> 손으로 `docker compose up` 하는 흐름은 그대로 남아 있다 — [deployment.md](deployment.md).

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
- 업데이트를 확인할 채널 주소는 `-e JW_UPDATE_CHANNEL_URL=<주소>` 로 바꾼다(기본은 공식 채널). 서명을 확인할 공개 키와 함께 16절.

이미지 빌드(리포 루트에서 — 문맥은 리포 루트, 무엇이 들어가는지는 `installer/Dockerfile.dockerignore`).
첫 단계(Node)가 마법사 화면을 빌드하고(`npm ci` + `npm run build:installer`), 그 결과(`installer.html`·`assets/`·`icon.svg`)가 `/app/ui` 에 실린다:

```bash
docker build -f installer/Dockerfile -t just-workspace-installer:$(cat VERSION) .
# 받을 이미지 저장소의 기본값을 바꿔 구우려면: --build-arg JW_REGISTRY=<저장소/네임스페이스>
```

## 2. 구조

```
installer/
  Dockerfile                 (Node) 마법사 화면 빌드 → Python + FastAPI + docker CLI·compose 플러그인
  Dockerfile.dockerignore    빌드 문맥(번들 원본, installer/, 화면의 원본 frontend-react/)
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
    api_update.py  업데이트 내부 API(/internal/update/*)
    cli.py         jw 명령
    server.py      서버 진입점
    update_*.py    업데이트 — 채널 확인, 적용·되돌림, 오프라인 묶음, 자기 교체(§16)
  tests/           docker 없이 도는 테스트
  e2e/             실서버 검수 — 시나리오 러너와 답변 파일 견본(§13)
```

단일 출처는 복제하지 않는다. 이미지 빌드 때 리포에서 **복사**해 번들(`/app/bundle`)에 싣는다.

| 번들 파일 | 리포 원본 | 쓰임 |
|---|---|---|
| `zones.json` | `backend/app/zones.json` | 구역 목록·메모리·포트·compose 프로파일 |
| `security_defaults.py` | `backend/app/security_defaults.py` | 비밀값 이름·길이·금지 문자, 대체 생성기 |
| `VERSION` | `VERSION` | 제품 버전(= 받을 이미지 태그) |
| `docker-compose.yml`, `nginx/*`, `init/*`, `scripts/certbot-entrypoint.sh`, `mailserver/config/*` | 같은 경로 | compose 와 compose 가 bind mount 하는 파일 |
| `frontend-react/public/maintenance.html` | 같은 경로 | 정적 점검 페이지 — nginx 가 직접 붙여 읽는다(업데이트 중에는 프런트 컨테이너도 바뀌는 중일 수 있다) |

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
| `mode` | `new` · `quick`(구역을 안 고르면 협업 묶음, 메모리가 모자라면 최소 묶음으로 내리고 사유를 남긴다) · `restore`(백업에서 복원 — §14) |
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
| `restore` | `mode: restore` 에서만 — `path`(서버에 있는 백업 파일·폴더의 절대 경로) · `password_file`(설정이 암호로 보호된 백업의 암호가 든 파일, `/data/` 아래) |

- 비밀(`admin.password`, `mail.password`, `ai.api_key`)은 저장할 때 따로 떼어 `answers.secret.json`(600)에 둔다. 관리자 비밀번호와 AI 키는 쓰고 나면 지운다.
- 무인 설치에서 비밀은 파일에 적거나 환경변수로 준다: `JW_ADMIN_PASSWORD`, `JW_MAIL_PASSWORD`, `JW_AI_API_KEY`.
- 꺼진 구역의 항목은 검사하지 않고 쓰지도 않는다. 모르는 항목은 거부한다.
- 검증은 필드별 오류를 낸다: `{"field": "access.cert", "code": "cert_not_proxy_behind_proxy", "vars": {…}}`. 문구는 화면이 가진다.
- 메모리 판정: 고른 구역의 `memory_mb.recommend` 합계(기본 포함)가 서버 메모리보다 크면 적용할 수 없다. 서버 메모리는 1GB 단위로 올림한 값과 실측의 차이가 8% 안이면 올림값으로 본다("4GB 서버"의 실측은 3.8GB 안팎이다). 4GB 미만은 사전 점검 실패.

## 5. 접속과 보안 모델

- **HTTPS 8443, 자체 서명 인증서.** 첫 기동 때 만들어 `/data/state/tls/` 에 두고 SHA-256 지문을 로그에 찍는다. 브라우저의 경고 화면에서 지문을 대조한다.
- **화면.** `/` 와 정적 자산(`/assets/*`, `/icon.svg`)은 세션이 없어도 내준다 — 토큰 입력 화면과 잠김 안내를 화면이 그린다. 세션이 필요한 것은 `/api/*` 뿐이다. `installer.html` 은 `no-cache`, 자산(파일 이름에 내용 해시)은 `immutable`. 모든 응답에 `Content-Security-Policy`(`script-src 'self'` — 인라인 스크립트 없음, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`(주소에 토큰이 실려 올 수 있다)를 붙인다. API 응답은 `no-store`.
- **설치 토큰.** 영문 대문자·숫자 12자리(0/O/1/I 없음), 24시간. 주소의 `?token=` 으로 들어오면 확인 뒤 토큰 없는 주소로 넘긴다(302). 맞으면 세션 쿠키(`HttpOnly`·`Secure`·`SameSite=Strict`)를 주고, 틀리면 `/?token_status=wrong|expired|locked` 로 넘겨 화면이 사유를 알린다. API 로는 틀리면 `token_wrong`, 만료면 `token_expired`. 5번 틀리면 30초 동안 받지 않는다(`token_locked`). `docker exec jw-installer jw token` 으로 다시 발급하면 옛 토큰은 무효가 되고, 입력해 둔 답과 열린 세션은 그대로다.
- **잠금.** 설치가 끝나면 토큰과 세션을 없애고 마법사 API 는 `423 locked` 만 답한다. 화면(`/`)과 `GET /api/state` 만 남는다(설치됨 표시, 워크스페이스 주소, 다시 설치·관리자 비밀번호 재설정 명령).
- **내부 API.** 설치 뒤의 관리 동작은 `/internal/*` 로만 받는다. 다른 포트(8444)에서 평문으로 뜨고 **호스트에 게시하지 않는다.** 설치 관리자는 적용 중에 자신을 워크스페이스 내부망에 `jw-installer` 라는 이름으로 붙인다. 요청은 공유 키(`X-JW-Installer-Key`, 설치 때 만들어 backend 의 `JW_INSTALLER_KEY` 로 전달)와 내부 대역의 출발지 주소를 둘 다 만족해야 하고, 아니면 404 다. 브라우저는 이 포트에 닿지 못한다.
- **docker.sock.** 설치 관리자는 호스트의 docker 소켓을 쥔다 — 이 컨테이너를 장악하면 서버를 장악한 것과 같다. 그래서 (1) 밖으로는 토큰으로 막은 8443 하나만 열고, (2) 설치가 끝나면 그 문도 잠그며, (3) 사용자 입력은 모두 검증하고 명령은 인자 배열로만 만든다(셸을 거치지 않는다). 설치가 끝난 뒤 8443 게시를 방화벽에서 닫아도 된다(내부 API 는 영향받지 않는다).
- **비밀값.** 생성 규칙의 단일 출처는 backend 의 `security_defaults` 다. 설치 관리자는 backend 이미지를 한 번 실행해(`python -m app.cli gen-secrets --format json`) 받아 쓰고, 그 이미지를 쓸 수 없을 때만 번들에 실린 같은 표로 만든다. 비밀값은 로그에 찍지 않으며(알고 있는 값은 가린다), 명령 인자에도 싣지 않는다(`--env-file`·표준 입력). 예외는 Gitea 의 `auth add-oauth --secret` 하나다 — Gitea CLI 가 다른 길을 주지 않는다.

## 6. API

오류 응답은 모두 `{"code": "…", "vars": {…}}`. 세션이 없으면 `401 auth_required`, 설치 뒤에는 `423 locked`.

### 마법사 API (8443, 세션 필요)

| 메서드·경로 | 하는 일 |
|---|---|
| `GET /` · `/assets/*` · `/icon.svg` | 마법사 화면(세션 없이) |
| `GET /?token=…` | 토큰 확인 → 세션 쿠키 → `/` 로 넘김(302). 틀리면 `/?token_status=…` |
| `POST /api/session` `{"token"}` | 토큰을 직접 입력했을 때 |
| `GET /api/state` | 어디까지 했는지(단계 `wizard`/`applying`/`installed`, 답변 유무, 사전 점검 통과 여부, 적용 상태·오류·대안, 토큰 만료 시각) + 이어 할 화면 `step` + 감지값 `facts` + 화면에 보일 값 `info`(아래) |
| `GET /api/answers` · `PUT /api/answers[?step=<화면 id>]` | 답변 조회 · 부분 저장(겹쳐 합친다, `null` 은 기본값으로). `step` 을 주면 이어 할 화면으로 기억한다. 응답: `{"answers", "secrets_set", "errors"}` |
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
| `/api/restore/*` | 백업에서 복원 — §14 |

`GET /api/state` 의 `facts` 와 `info`:

| 값 | 뜻 |
|---|---|
| `facts.memory_mb` · `public_ip` · `disk_free_gb` | 감지한 메모리 · 공인 주소 · 여유 공간(사전 점검을 돌린 뒤에 찬다. 모르면 `null`) |
| `facts.lan_ip` | 서버의 나가는 경로 주소 |
| `facts.detected_network` | 그 주소가 공인이면 `direct`, 사설이면 `router`, 모르면 `null`. 앞단 프록시 뒤인지는 알 수 없다 |
| `info.git_verified_version` | 코드 저장소의 검증한 버전(compose 의 고정 이미지 옆 주석) |
| `info.default_storage_path` | 기본 저장소(도커 볼륨)가 놓이는 호스트 폴더 |
| `info.commands` | 서버 터미널에서 치는 명령(`reissue_token`·`reset_admin`·`install_from_answers`·`reinstall`) — 실제 컨테이너 이름으로 만든다. 잠긴 뒤에는 `reinstall`·`reset_admin` 만 |

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
| `GET /internal/zones` | 구역 목록(켜짐 여부, 메모리 판정, 설정 유무) + `git_verified_version` |
| `POST /internal/zones/<id>/check` `{"settings"}` | 켜도 되는가 — 설정 오류, 메모리, 새로 열리는 포트, 주의(아무것도 바꾸지 않는다) |
| `POST /internal/zones/<id>/enable` `{"settings"}` | 켜기(202 + 작업). 메모리가 모자라면 `409 memory_insufficient`, 설정이 틀리면 `422 settings_invalid` |
| `POST /internal/zones/<id>/disable` | 끄기(연결 해제 + 컨테이너 정지, 데이터 볼륨은 남는다) |
| `GET /internal/zones/<id>/settings` | 켜진 구역의 설정 다시 열기(비밀은 `…_set` 여부만). 코드 저장소는 `verified_version`(검증한 버전 글자)도 |
| `PUT /internal/zones/<id>/settings` `{"settings"}` | 설정 바꾸기(202 + 작업) |
| `GET /internal/jobs/<id>` · `/log` | 작업 진행·로그 |
| `POST /internal/probe/smtp` · `/ai` | 구역 켜기 창의 "연결 확인" |
| `POST /internal/probe/mail-records` `{"mail_domain"?}` | 메일 레코드(MX·A·SPF·DKIM·DMARC)의 기대값과 현재값 — DKIM 은 설치 때 만든 키 |
| `GET /internal/probe/public-ip[?refresh=true]` | 공인 주소(기억해 둔 값, `refresh` 면 다시 감지) |
| `GET /internal/jobs` | 구역 작업 목록 — 진행 중인 것과 최근 것(새것부터, 20개) |
| `GET /internal/storage` | 파일 저장소: `{"kind": local\|nfs, "location", "volume", "install_id"}` |
| `/internal/update/*` | 업데이트 — 상태·설정·적용·작업·복원 지점·오프라인·기록. 경로와 응답은 [update-api.md](update-api.md). `GET /internal/update/maintenance`(공개 점검 상태)만 키 없이 열린다 |
| `GET /internal/cert` | 지금 쓰는 인증서 — §15 |
| `POST /internal/cert/reissue` | 인증서 다시 발급 / 올린 인증서로 교체(202 + 작업) — §15 |
| `POST /internal/zones/<id>/reconnect` | 보류된 구역 연결을 다시 시도(202 + 작업) — §15 |

구역별 `settings`:

| 구역 | 값 |
|---|---|
| `mail` | `kind`: `builtin` + `mail_domain` / `external` + `host`·`port`·`security`·`username`·`password` |
| `meetings` | `turn`(중계), `lossless_audio` — 공인 주소는 `GET …/settings` 의 `detected.public_ip` |
| `ai` | `mode`: `now` + `provider`(`openai`/`anthropic`/`google`)·`api_key`(·`model`·`base_url`) / `later` |
| `git` | `version`: `tested`/`latest`/`custom` + `custom_version` |
| 그 밖 | 없음 |

`GET /internal/zones` 의 구역 행에는 `pending`(켜져 있지만 연결이 보류됨)·`pending_reason` 이 붙는다(§15).

작업은 `{"id", "kind": enable|disable|update|reconnect|cert, "zone", "status": running|done|failed, "stages": [{"id", "status"}], "ports", "error", "warnings"}`. 켜기의 단계는 `pull`(받기) → `configure`(설정) → `connect`(연결). 실패하면 답변·`.env`·컨테이너를 되돌려 **꺼진 채**로 둔다. 성공하면 `.env` 의 `JW_ZONES`·`COMPOSE_PROFILES` 가 바뀌고 backend 가 다시 뜬다. 한 번에 한 작업만 돈다(`409 busy`).

### 명령(`docker exec jw-installer jw …`)

| 명령 | 하는 일 |
|---|---|
| `jw token` | 설치 토큰 다시 발급 |
| `jw status [--json]` | 단계별 상태 |
| `jw apply --answers <파일> [--dry-run]` | 답변 파일로 설치. `--dry-run` 은 검증·렌더링까지만 하고 산출물 요약을 낸다(아무것도 바꾸지 않는다) |
| `jw render --answers <파일> --out <폴더>` | 산출물을 폴더에 써 본다(비밀값은 견본) |
| `jw reset-admin <계정> [--disable-2fa]` | backend 의 `python -m app.cli reset-admin` 호출 |
| `jw reinstall [--yes]` | 처음부터 다시 설치할 수 있게 지운다. `--yes` 없이는 지울 목록만 보여 준다(아래) |

**다시 설치.** `docker exec jw-installer jw reinstall` 은 지울 것(워크스페이스의 컨테이너·볼륨·내부망, 설치 폴더의 `stack`·`state`)을 보여 주고 멈춘다. `--yes` 를 붙이면 지우고 설치 관리자를 다시 시작한다 — 새 설치 토큰이 `docker logs jw-installer` 끝에 나온다. **계정·파일·메일·대화가 모두 지워진다.** 설치 관리자 자신의 인증서(지문)는 남는다. 파일 저장소가 NFS·지정 폴더면 그 안의 파일은 지우지 않고 저장소 표식만 지운다(남은 파일은 새 설치의 계정과 이어지지 않는다).

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
- **NFS**: ① 서버에 닿는가(TCP 2049) ② 붙일 수 있는가 ③ 쓰기·읽기·지우기(backend 가 쓰는 uid/gid `1000:1000` 으로) ④ 파일 잠금 ⑤ 여유 공간(10GB 미만은 warn). NFS 옵션의 임시 도커 볼륨을 만들어 보조 컨테이너에서 검사하고 지운다. 실패 원인: `unreachable`(서버에 닿지 않음), `export_not_found`(닿았는데 그 경로를 붙일 수 없음 — NFSv4 서버는 없는 경로와 이 서버에 허용하지 않은 내보내기를 같게 답한다), `permission_denied`(uid 1000 이 쓸 수 없음), `read_only`, `no_locking`. 옵션은 `rw,nfsvers=4.1,hard,noatime` 고정. 볼륨은 `nocopy` 로 붙여 내보내기 뿌리의 소유자·권한을 건드리지 않는다 — 뿌리는 uid/gid `1000:1000` 이 쓸 수 있게 저장소 쪽에서 맞춰 둬야 한다.
- **로컬 폴더**: `--mount type=bind` 로 붙여 본다(`-v` 는 없는 폴더를 만들어 버린다). `ok`/`not_found`/`not_writable`.
- **DKIM**: 메일 레코드 화면에서 보여 줘야 하므로 확인할 때 키를 만들어 `/data/state/dkim/` 에 둔다. 서버 구성에는 적용 때 들어간다.

## 8. 렌더링 — 답변에서 나오는 파일

`render(answers, secrets, facts, bundle)` 는 순수 함수다. 스택 폴더 기준 경로 → 내용.

| 파일 | 내용 |
|---|---|
| `docker-compose.yml`, `nginx/nginx.conf`, `nginx/security-headers.conf`, `init/init-db.sh`, `scripts/certbot-entrypoint.sh`, `mailserver/config/{user-patches.sh,auth-workspace.lua,dovecot.cf}`, `frontend-react/public/maintenance.html` | 번들에서 **그대로** |
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

만든 뒤 저장소 뿌리에 **표식 파일** `.jw-storage`(설치 id 포함)를 쓴다. backend 는 `STORAGE_MARKER_REQUIRED=1` 일 때 이 파일이 안 보이면(또는 설치 id 가 다르면) 파일 쓰기 API(`/api/files…`, `/api/wopi/files…`)를 `503 storage_unavailable` 로 거부하고 관리자에게 알린다 — 끊긴 저장소 자리의 빈 폴더에 쓰는 사고를 막는다. NFS 서버가 응답하지 않을 때(`hard` 마운트라 읽기가 멈춘다)는 3초 안에 사유 `unresponsive` 로 거부한다. 같은 이름의 볼륨이 다른 옵션으로 이미 있거나, 표식이 다른 설치의 것이면 건드리지 않고 멈춘다.

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
| `storage` | (NFS·지정 폴더일 때만) 볼륨 만들기 + 표식 | `unreachable`, `export_not_found`, `permission_denied`, `read_only`, `storage_other_install`, `storage_volume_mismatch` |
| `pull` | `compose config --images` 의 이미지를 하나씩 받는다(이미지별 진행). 받지 못해도 서버에 이미 있으면 경고만 | `image_pull_failed` |
| `database` | postgres·redis 시작, healthy 대기 → backend 이미지의 일회용 컨테이너로 `python -m app.cli migrate`(DB 스키마를 이 버전에 맞춘다 — [data-safety.md](data-safety.md)). 종료 코드가 0 이 아니면 backend 를 띄우지 않고 멈춘다 | `database_not_ready`, `database_migrate_failed` |
| `cert` | (프록시가 맡고 따로 필요한 이름도 없으면 생략) 발급·배치 | `cert_issue_failed`(대안: 임시 인증서), `cert_invalid`, `cert_upload_missing` |
| `zones` | backend·frontend·nginx 시작 → 설치 관리자를 내부망에 연결 → 구역마다 `install` → 구역마다 `connect` → 연동 값이 바뀌었으면 backend 다시 시작 → DB 에 저장되는 설정 넣기 | `service_not_ready`, `git_*` |
| `admin` | `seed-admin`(비밀번호는 env 파일로 넘기고 지운다) | `admin_username_taken` |
| `lock` | 단계 `installed`, 토큰·세션 폐기 | |

- 시작 전에 답변 검증과 사전 점검을 한다. 걸리면 단계 없이 `failed`(`answers_invalid`, `preflight_failed`).
- 단계는 멱등하다. `POST /api/apply/retry` 는 실패한 단계부터 다시 돌고, 끝난 단계는 건드리지 않는다.
- 상태는 단계가 바뀔 때마다 `/data/state/apply.json` 에 쓴다. 브라우저를 닫아도 계속 돌고, 설치 관리자가 재시작하면 끊긴 단계부터 잇는다(그 단계에 `interrupted: true` 가 남는다).
- `POST /api/apply`·`/retry` 는 응답을 주기 전에 상태를 `running` 으로 써 둔다 — 202 를 받은 직후의 조회가 옛 `failed` 를 보는 일이 없다.
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

7 은 Gitea 가 접속 주소로 되돌아가 설정 문서를 읽으므로 **신뢰되는 인증서**가 필요하다. 임시 인증서에서는 실패하고, 설치는 주의(`git_sso_pending`)를 남기고 계속한다 — 그 구역은 "연결 보류"로 적히고(`state/pending.json`), 인증서를 바꾸면 다시 건다(§15). 로그인 원본이 이미 있으면 지금 주소로 고쳐 쓴다(`update-oauth` — 서버를 옮겨 접속 주소가 바뀐 경우). 끌 때는 로그인 원본을 지우고 토큰·클라이언트를 설정에서 뺀 뒤 컨테이너를 멈춘다. 데이터 볼륨(`ws-gitea-data`)은 남는다.

## 11. 테스트

```bash
cd installer
python -m venv <리포 밖 폴더>/venv && <그 venv>/bin/pip install -r requirements-dev.txt
<그 venv>/bin/python -m pytest -q
```

docker 없이 돈다. docker·DNS·HTTP·SMTP 는 가짜로 바꾼다(`tests/fakes.py`, `tests/harness.py`). 렌더링 스냅샷은 `tests/snapshots/` — 의도한 변경이면 `JW_UPDATE_SNAPSHOTS=1` 로 다시 만든다.

## 12. 알려진 한계

- **backend 쪽 호출부**는 `backend/app/system/` 이다. 관리자 권한을 확인하고 내부 API 를 대신 부르며(`/api/admin/system/zones…`, `/jobs/<id>`, `/probe/…`), 켜기·끄기·설정 변경을 감사 로그에 남긴다. 화면은 관리 › 구역(`/admin/zones`). `JW_INSTALLER_URL`·`JW_INSTALLER_KEY` 가 비어 있으면(설치 관리자 없이 구성한 설치) 목록은 읽기 전용이고 나머지는 `503 installer_unavailable` 이다.
- **코드 저장소의 로그인 연동**(Gitea 의 OpenID Connect 로그인 원본)은 접속 주소의 인증서를 **Gitea 컨테이너가** 믿을 수 있어야 걸린다. 임시 인증서로 설치하면 "연결 보류"로 남고, 신뢰되는 인증서로 바꾸면(§15) 다시 건다. 공개 CA 가 아닌 **사설 CA** 가 내준 인증서는 올려도 Gitea 가 믿지 못해 보류로 남는다 — Gitea 컨테이너의 신뢰 저장소에 그 CA 를 넣는 일은 설치 관리자가 하지 않는다.
- **인증서 자동 발급(Let's Encrypt)의 실제 발급**은 밖에서 80 으로 닿는 서버에서만 된다. 발급이 실패했을 때의 흐름(실패 → 임시 인증서로 계속)만 실서버에서 확인했다.
- **TURN/TLS**: 직접 받는 구성에서는 5349 에 게시되므로, 443 을 넘겨 주는 장치가 없으면 쓰이지 않는다(§8).
- **앞단 프록시 구성**: 프록시는 클라이언트 주소를 `X-Real-IP` 로 넘겨야 한다(`X-Forwarded-For` 만으로는 클라이언트 주소로 쓰지 않는다). 메일·회의 인증서는 자체 서명이다 — 신뢰되는 인증서가 필요하면 지금은 손으로 넣어야 한다.
- **메일 도메인과 접속 주소가 다르면** `DOMAIN` 은 메일 도메인이 된다. backend 가 `DOMAIN` 을 표시용으로도 쓰는 자리(메일 제목 머리말 등)에는 메일 도메인이 나온다.
- **외부 SMTP 의 보안 방식**과 **AI 제공자**는 DB 설정이라 backend 가 뜬 뒤 `python -m app.cli configure` 로 넣는다. 실패하면 주의(`backend_settings_not_applied`)만 남는다.
- **NFS** 는 v4.1 만 쓴다(잠금이 프로토콜에 든 버전). v3 만 되는 서버는 붙지 않는다. `hard` 로 붙이므로 서버가 끊긴 동안 저장소를 **읽는** 요청(파일 목록·내려받기)은 돌아올 때까지 기다린다 — 쓰기만 503 으로 바로 거부한다. 끊긴 것을 알아채기 전(표식 확인 결과를 5초 재사용한다)에 시작된 쓰기도 서버가 돌아올 때까지 기다렸다가 끝난다.
- **저장소 표식**은 `/api/files`·`/api/wopi/files` 의 쓰기만 막는다. 채팅 첨부·메일 보관처럼 다른 경로로 저장소에 쓰는 기능은 아직 막지 않는다.
- **받을 이미지 용량**은 알려 주지 않는다(레지스트리에 묻지 않는다) — 요약의 그 줄은 보이지 않는다.
- **인증서 방식 바꾸기**는 임시 → 자동·올리기, 자동 → 올리기만 된다(§15). 앞단 프록시가 맡는 설치의 메일·회의용 인증서는 여전히 자체 서명이다.
- **복원에서 파일 저장소의 두 번 읽기**: 데이터 되돌리기(backend CLI)는 백업 묶음을 작업 폴더(백업 볼륨)에 통째로 푼 뒤 올린다 — 백업 크기만큼의 여유 공간이 도커 데이터 폴더에 더 필요하다. 올린 백업은 설치 폴더에 한 벌 더 놓인다(끝나면 지운다). 큰 백업은 서버에 먼저 옮겨 두고 경로를 알려 주는 편이 낫다.
- **복원에서 다시 정하지 않는 것**: 지정 폴더 저장소(화면은 도커 볼륨·NFS 만 묻는다 — 답변 파일로는 `storage.path` 를 줄 수 있다), 인증서 올리기(화면에서는 자동·임시만 — 복원 뒤 관리 화면에서 올린다).
- **업데이트**: 플러그인 호환 판정과 호환이 확인되지 않은 플러그인을 끄는 동작은 아직 없다(manifest 의 `plugin_api` 가 자리뿐이다). 예고 시간(5분)은 고정이고, 올리다 끊긴 묶음 파일을 이어 올리지 못한다 — 16절.

### 주의(`cautions`)의 키

요약(`GET /api/summary`)과 구역 확인(`POST /internal/zones/<id>/check`)이 같은 키를 쓴다. 문구는 화면이 가진다(마법사: `frontend-react/src/installer-app/i18n/*.json` 의 `summary.caution.<키>`).

| 키 | 값(`vars`) | 뜻 |
|---|---|---|
| `cert_temporary` | `domain` | 임시(자체 서명) 인증서로 설치한다 |
| `git_sso_needs_trusted_cert` | | 임시 인증서로는 코드 저장소의 로그인 연동이 걸리지 않는다 |
| `router_port_forward` | `ports` | 공유기에서 이 포트들을 이 서버로 넘겨야 한다 |
| `proxy_side_certs_self_signed` | `names` | 프록시를 거치지 않는 이름(메일·회의)에는 자체 서명 인증서를 쓴다 |
| `hairpin_not_configured` | `domain` | 프록시 주소가 하나로 정해지지 않아 컨테이너가 접속 주소로 되돌아오는 길이 없다(문서 편집·코드 저장소 연동) |
| `turn_tls_alternate_port` | `port` | 회의 중계의 보안 연결은 이 포트(5349)에 열린다 |
| `mail_needs_dns_and_port25` | `mail_domain` | 내장 메일은 메일 레코드와 밖에서 들어오는 25 가 있어야 받는다 |
| `account_domain_is_mail_domain` | `mail_domain` | 계정의 메일 주소는 `<아이디>@<메일 도메인>` 이 된다 |
| `no_system_mail` | | 메일 구역이 없어 초대·비밀번호 재설정 메일을 보내지 못한다 |
| `meetings_public_ip_unknown` | | 회의에 쓸 공인 주소를 모른다 |
| `lossless_needs_udp_4433` | | 무손실 오디오는 UDP 4433 이 밖에서 닿아야 한다 |
| `rbi_needs_dns` | `name` | 격리 브라우저의 전용 이름도 이 서버를 가리켜야 한다 |
| `dns_mismatch_cert_will_fail` | `domain` | 접속 주소가 이 서버를 가리키지 않아 자동 발급이 실패한다 |

적용·구역 작업이 남기는 주의(`warnings`): `git_sso_pending`, `git_front_path_unverified`, `side_certs_self_signed`, `image_not_refreshed`, `installer_not_on_network`, `backend_settings_not_applied`. 복원이 남기는 것: `restore_dkim_regenerated`(백업에 메일 서명 키가 없어 새로 만들었다), `restore_front_unverified`, `restore_users_mismatch`, `restore_check_skipped`.

## 13. 실서버 검수

단위 테스트는 docker 를 가짜로 바꾼다. 실제 docker 로 처음부터 끝까지 도는지는 `installer/e2e/` 의 시나리오로 본다 — 검수 **전용** 서버에서만 돌린다(컨테이너·볼륨·설치 폴더를 지우고, NFS 시나리오는 호스트에 NFS 서버 패키지를 깐다).

```bash
installer/e2e/remote.sh <ssh 대상> push                 # 커밋된 상태를 서버에 올린다
installer/e2e/remote.sh <ssh 대상> build                # 서버에서 이미지를 소스로 빌드(localhost/just-workspace-<이름>:<VERSION>)
installer/e2e/remote.sh <ssh 대상> run s1-minimal api   # 시나리오 하나
# 화면을 눌러서(Playwright — 이 PC 에서):
node installer/e2e/wizard-ui.cjs --url https://<서버 주소>:8443 --token <설치 토큰> [--flow quick] [--width 390]
node installer/e2e/admin-zones-ui.cjs --url https://<접속 주소> --addr <서버 주소> --password-file <파일>
installer/e2e/remote.sh <ssh 대상> run u-update setup u9 u1 u7 u2 u3     # 업데이트(가짜 릴리스 환경 — 16절). 단계를 이어서: r103 u5 u4 u6 u8
node installer/e2e/admin-update-ui.cjs --url https://<접속 주소> --addr <서버 주소> --password-file <파일>
```

요건: 리눅스 x86_64, Docker Engine 24+, compose 플러그인 2.20+, 4코어·메모리 12GB·디스크 40GB 이상, 인터넷으로 나갈 수 있을 것(밖에서 들어오는 길은 없어도 된다). 접속 주소는 DNS 에 없는 이름을 쓰고 서버 주소로 직접 붙는다.

| 시나리오 | 실제 서버에서 확인한 것 |
|---|---|
| `s1-minimal` (답변 파일 · API) | 최소 묶음 설치 완료, 컨테이너 준비, 프런트·`/api/health`, 관리자 로그인, 파일 올리기·내려받기, 잠금(423), 설치 관리자 재시작 뒤 상태 유지, `jw status`·`jw reset-admin` |
| `s2-collab` (답변 파일 · API) | 내장 메일(IMAP 993 로그인, 내부 발송·수신, DKIM 서명 — 미리 만든 키와 서버의 키가 같음), 문서 편집기 discovery, 채팅 웹소켓, 일정 만들기, 요약의 포트 = 실제 게시 포트(143 은 열리지 않음) |
| `s3-full-sso` (답변 파일 · API) | 전체 묶음 + SSO·LDAP 가 12GB 에서 기동(유휴 실측 약 1.9GB). 회의 토큰 발급·UDP 게시, Gitea 구역 훅(고정 이미지, PostgreSQL 연결, 관리 계정, 토큰이 backend 에 주입, OAuth 클라이언트, `/git/`·`/api/git/repos`), LDAPS 636·평문 389 는 루프백만. 로그인 원본 등록은 임시 인증서라 미뤄짐(주의) — 명령 자체는 내부 주소로 시험 등록해 확인 |
| `s4-nfs` | 확인 다섯 항목 통과, 실패 분류(`unreachable`·`export_not_found`·`permission_denied`·`read_only`), 확인이 내보내기 뿌리의 소유자를 바꾸지 않음, root 를 낮추는 내보내기에 설치, 표식·업로드가 NFS 에 쓰임, 서버를 멈추면 쓰기 503(`storage_unavailable`, 3초 안)·다른 API 는 정상, 다시 띄우면 복구. `no_locking` 은 재현하지 못했다(NFSv4.1 은 잠금을 끌 수 없다) |
| `s5-proxy` | 80 평문만(443 미게시, HSTS 없음), 프록시 주소에서 온 `X-Real-IP` 만 클라이언트 주소로 쓰고 다른 출발지의 머리말은 무시, backend 의 세션 기록에도 그 주소 |
| `s6-zone-toggle` | 내부 API 로 채팅 → 문서 → 코드 저장소 켜기, 문서·코드 저장소 끄기. `.env` 의 `JW_ZONES`·`COMPOSE_PROFILES`, `/api/health` 의 zones, 끈 구역의 볼륨 유지. 8443·호스트에서는 내부 API 에 닿지 않고, 틀린 키·내부 대역 밖은 404 |
| `s7-failure-retry` | 토큰(틀림·재발급·만료·5회 잠금), 없는 이미지 → `pull` 실패·원인 키 → 고친 뒤 그 단계부터, 적용 도중 설치 관리자 재시작 → 이어서 완료, 인증서 자동 발급 실패 → 임시 인증서로 계속 |
| `s8-manual` | 설치 관리자 없이 [deployment.md](deployment.md) 의 절차대로 최소 구성 기동 |
| `wizard-ui.cjs` | 화면을 눌러 일반 설치(협업 묶음·임시 인증서)와 빠른 설치를 완료 화면까지 — 1280 폭과 390 폭. 토큰 없는 주소·틀린 토큰, 사전 점검 14항목, 구역·메모리 합계, 메일 레코드 표, 이어 하기, 요약, 적용, 잠김 화면. 콘솔 오류 없음 |
| `jw reinstall` | 설치된 서버에서 목록 확인 → `--yes` 로 지우고 새 토큰으로 다시 시작 |
| `restore` + `restore-ui.cjs` | 서버 이전: 협업 묶음에 계정 2·파일·채팅·메일·일정·암호화된 값을 넣고 전체 백업 → 서버를 체크포인트로 되돌린 뒤 화면으로 올려 복원 → 옛 계정 로그인, 파일 해시, 채팅·메일·일정, DKIM 키, 암호화 값 복호, 설치 id, 잠금. 서버 경로 + 답변 파일(무인, 접속 주소 변경). 거부 경로(형식 아님·손상·끊김·암호 없음/틀림/맞음·더 높은 버전). 데이터 되돌리기 중 DB 정지 → 실패 → 재시도로 완료. NFS: 로컬 선택·빈 공유·다른 설치의 공유 거부, 같은 공유 재연결 뒤 파일 그대로 |
| `admin-cert-ui.cjs` | 관리 › 보안의 인증서 카드(임시 인증서 경고 → 사설 CA 인증서 올리기 → nginx 가 새 인증서를 냄), 관리 › 구역의 연결 보류·다시 연결, 관리 › 저장소의 상태 카드(설치 관리자 값, NFS 서버를 멈췄을 때 카드·알림 띠·파일 탭 안내와 복구) |

업데이트(`scenarios/u-update.sh` — 서버 안의 가짜 릴리스 환경에서, 릴리스 도구로 낸 릴리스로):

| 단계 | 실제 서버에서 확인한 것 |
|---|---|
| `setup` | 릴리스 도구로 1.0.0 과 1.0.1-beta.1 을 내고(이미지 올리기 → `make-manifest --resolve-sizes --db-schema` → `publish` → `verify`) Beta 를 Stable 로 승격. 공개 키가 없으면 `unconfigured`, 키를 넣으면 확인이 되고, Beta 릴리스는 stable 채널에 보이지 않다가 승격 뒤에 보인다 |
| `u9` | 변조한 채널 파일·다른 키로 서명한 채널·만료된 채널·순번이 뒤로 간 채널·변조한 manifest·닿지 않는 채널을 각각 거부하고, 마지막으로 성공한 결과는 그대로 둔다 |
| `u1` | 수동 업데이트 1.0.0 → 1.0.1(승격한 릴리스): 예고(backend 의 예고 조회·공개 점검 상태에 반영)와 취소, "지금 바로 시작", 점검 모드(일반 API 503 + `Retry-After`, 진행 조회·로그인은 통과), 여섯 단계, 설치 관리자 자기 교체(새 이미지·같은 이름·8443 응답·옛 컨테이너 없음), `/api/health` 의 버전·스키마, 검수용 변경 단계 적용, 넣어 둔 데이터(계정·파일·대화·메일) 보존, 기록·기록 내려받기·복원 지점. 프런트가 없을 때의 정적 점검 페이지, `/maintenance/status` 는 GET 만, 내부 API 는 밖에서 닿지 않음 |
| `u7` | 복원 지점으로 수동 복원(1.0.1 → 1.0.0): 다섯 단계, DB 복원(검수용 표가 사라짐), 설치 관리자도 이전 이미지·이전 환경으로, 데이터 보존, 다시 받을 수 있음 |
| `u2` | 레지스트리에서 이미지를 지워 `pull` 실패 → `failed` + `retry`·`rollback` → 되돌리기(바뀐 것이 없어 세 단계 건너뜀) / 이미지를 되살린 뒤 다시 시도 → 완료 |
| `u3` | 둘째 변경 단계가 깨지는 릴리스: `migrate` 실패 → 선택 없이 되돌림 → 이전 버전, DB 스키마 버전 원복(앞서 적용된 단계의 흔적도 없음), 데이터 보존 |
| `admin-update-ui.cjs` | 화면으로 한 번(1.0.1 → 1.0.3): 현황의 새 버전 → 내용 보기 → 업데이트 시작 → 일반 사용자 창의 예고 띠 → "지금 바로 시작" → 진행 화면의 단계와 "다시 연결 중" → 일반 사용자 창의 점검 화면과 복귀 → 완료 → 기록. 콘솔 오류 없음 |
| `u5` | 중간 버전 1.0.0 → 1.0.1 → 1.0.3 을 한 작업으로: 버전마다 백업·자기 교체·기록 |
| `u4` | 자동: 공개 3일 전에는 시간대 안이어도 시작하지 않음, 3일 뒤에도 시간대 밖이면 시작하지 않음, 둘 다 맞으면 5분 예고로 시작, `pull` 실패도 선택 없이 되돌린 뒤 멈춤(관리자 알림), 멈춘 동안 다시 시도하지 않음, 다시 켜면 다음 확인에서 적용 |
| `u6` | Beta 채널로 올림(시험판 이전 백업을 따로 보관) → Stable 로: 기다리기(`wait`, 적용 거부) / "시험판 이전 상태로 복원"(그 사이에 쓴 대화는 사라지고 채널은 stable) |
| `u8` | 레지스트리·채널을 끈 채로: 낮은 버전·다른 키·없는 파일·한 바이트 바꾼 묶음을 각각 거부, 묶음 올리기(nginx → backend → 설치 관리자), 추가 이미지 판정(없음·불일치·있음·필요 없음), 묶음과 이미지 파일만으로 적용 |

업데이트에서 확인하지 못한 것: 실제 배포 채널·실제 서명 키, 인터넷 너머의 레지스트리에서 받는 시간(검수 서버에서는 이미지 계층이 대부분 이미 있었다), 여러 GB 묶음을 앞단 프록시를 거쳐 올리기, 플러그인 호환 판정, 설치 관리자를 `docker run` 의 다른 옵션(자원 제한 등)과 함께 띄운 경우의 자기 교체.

확인하지 못한 것: 실제 Let's Encrypt 발급과 갱신(다시 발급의 `auto` 포함), 공개 CA 인증서에서의 Gitea 로그인 연동(사설 CA 를 Gitea 컨테이너에 손으로 믿게 한 뒤 다시 연결되는 것까지는 확인), 로컬 백업을 NFS 로 옮기는 복원, 수 GB 이상의 백업 올리기, 격리 브라우저 애드온(`rbi`), 무손실 오디오, 외부 SMTP·AI 제공자 연결, 지정 폴더 저장소, 공유기 뒤·실제 앞단 프록시, x86_64 가 아닌 서버, SELinux 가 켜진 배포판.

## 14. 백업에서 복원

다른 서버에서 만든 백업(`.jwbak` 또는 백업 폴더 — [data-safety.md](data-safety.md))으로 이 서버에 그대로 옮긴다. 마법사의 시작 방식 "백업에서 복원", 또는 답변 파일의 `"mode": "restore"`. 코드는 `installer/app/restore.py`(흐름·단계), `restore_config.py`(설정 병합), `api_restore.py`(경로).

설치 관리자는 백업을 직접 열지 않는다. backend 이미지의 일회용 컨테이너에 **읽기 전용으로 붙여** `python -m app.cli backup inspect|verify|extract-config` 와 `restore` 를 부른다 — 형식의 단일 출처는 backend 다. 이미지가 아직 없으면 그 이미지 하나만 먼저 받는다.

### 백업 받기

| 길 | 어떻게 |
|---|---|
| 올리기 | 브라우저가 보낸 본문을 `/data/state/restore/upload/backup.jwbak` 에 바로 흘려 쓴다(메모리·임시 파일에 모으지 않는다). 시작할 때 `Content-Length` 와 여유 공간을 견주고, 올리다 끊기면 반쪽 파일을 지운다. 이어 올리기는 없다 |
| 서버 경로 | 호스트의 절대 경로를 받는다(설치 폴더 아래든 다른 곳이든). 복사하지 않고 그 경로를 일회용 컨테이너에 `--mount type=bind,…,readonly` 로 붙여 읽는다. 경로 검증은 저장 폴더와 같다(절대 경로, `..`·셸 문자·시스템 폴더 거부) |

확인은 세 단계다: 형식(`inspect`) → 손상(`verify` — 모든 파일의 크기·SHA-256) → 설정 꺼내기(`extract-config` → `/data/state/restore/config/`, 600). 결과(`status`):

| `status` | 뜻 |
|---|---|
| `ok` | 복원할 수 있다 |
| `invalid` | `reason`: `not_a_backup`(백업 파일이 아님) · `format_unsupported`(모르는 형식 버전) · `no_config`(설정 항목이 없어 새 서버로 옮길 수 없다) · `path_invalid` |
| `corrupt` | 옮기는 중 손상(해시 불일치·중간에 끊김) |
| `password_required` · `password_wrong` | 설정이 암호로 보호된 백업 — 암호는 `/data/state/restore/password`(600)에 두고 파일로 넘긴다(명령 인자·환경에 싣지 않는다) |
| `not_found` | 그 경로에 파일이 없다 |
| `none` | 받은 백업이 없다 |

`state` 는 `none`·`uploading`·`checking`·`ready`·`failed`.

### API (8443, 세션 필요)

| 메서드·경로 | 하는 일 |
|---|---|
| `POST /api/restore/upload` (multipart `file`) | 올리고 확인까지 한 뒤 답한다(큰 파일은 수 분). `507 no_space`, `409 apply_running`, `400 upload_invalid` |
| `POST /api/restore/path` `{"path"}` | 서버에 있는 백업 |
| `POST /api/restore/password` `{"password"}` | 암호를 넣고 다시 확인(해시는 다시 세지 않는다) |
| `GET` · `DELETE /api/restore/file` | 받은 백업의 상태 · 버리기(서버 경로의 원본은 건드리지 않는다) |
| `GET /api/restore/review` | 내용 확인(아래). 준비된 백업이 없으면 `409 restore_no_backup` |
| `POST /api/restore/apply` `{"domain", "storage", "network"?, "proxy_addresses"?, "cert"?, "subnet"?}` | 복원 시작(202). 문제가 있으면 `422 restore_invalid` + `vars.errors` |
| `GET /api/restore/apply` · `/apply/stream` · `POST /api/restore/apply/retry` | 진행·재시도 — 설치 적용과 같은 엔진·같은 형태. 로그는 `GET /api/apply/log?step=` |

`review`: `source_url`·`created_at`(만든 서버·시각), `backup_version`·`schema_version` 과 `installer_version`·`installer_schema_version`, `version_status`(`ok`/`newer`)·`version_reason`(`schema`/`product`), `zones`, `users`, `data_bytes`, `storage`(원래 저장소 — `local` 또는 `nfs` + `server`·`export`), `files_included`·`files_bytes`, `domain`(접속 주소 기본값), `mail_domain`, `install_id`, `network`·`subnet`(기본값), `blockers`(막는 사유).

**버전 판정**: 백업의 스키마 버전(또는 제품 버전)이 이 설치 관리자의 것보다 **높으면 막는다**(`version_newer`). 낮거나 같으면 진행하고, 복원 뒤 스키마 변경 단계가 차이를 메운다. 이 설치 관리자의 스키마 버전은 backend 이미지에 묻는다(`schema-version`). 백업의 구역이 서버 메모리에 안 들어가도 막는다(`memory_insufficient`).

### 새 서버에서 다시 정하는 것

| 항목 | 규칙 |
|---|---|
| 접속 주소 | 기본값은 백업의 주소. DNS 가 아직 원래 서버를 가리켜도 **막지 않는다** — 인증서를 정하지 않았으면 그 경우 임시 인증서로 간다(가리키면 자동 발급) |
| 연결 형태·프록시 주소·인증서 | 설치와 같다. `cert` 를 비우면 프록시 → `proxy`, 주소가 IP → `temporary`, DNS 일치 → `auto`, 그 밖 → `temporary` |
| 파일 저장 위치 | 백업이 **NFS** 였으면 NFS 만(`storage_must_be_nfs`) — 파일은 백업에 없고 그 공유에 있다. 연결 확인 다섯 항목에 더해 **표식 파일의 설치 id 가 백업의 것과 같은지** 본다: 표식이 없으면 `marker_missing`(다른 공유이거나 빈 공유), 다른 설치의 것이면 `other_install`. 백업이 로컬이고 파일이 들어 있으면 도커 볼륨·NFS 어느 쪽이든 된다. 로컬인데 파일이 없으면 파일 없이 복원한다(화면이 경고) |
| 내부 대역 | 기본값은 백업의 대역 |

구역·메일·회의·코드 저장소 버전·관리자 계정은 **묻지 않는다** — 백업의 설정(`config` 항목의 `.env`)에서 온다.

### 설정 병합 규칙

| 갈래 | 무엇 |
|---|---|
| **백업에서 가져온다** | 비밀값 전부 — 암호화 키 `SECRET_KEY`(바뀌면 DB 안의 암호화된 값을 풀 수 없다), `INTERNAL_API_KEY`, `DB_PASSWORD`(코드 저장소의 설정 파일에도 적혀 있다), 구역별 키·토큰, `SMTP_PASSWORD`, `GITEA_TOKEN`, `OAUTH_CLIENTS_JSON`. **설치 id**(`JW_INSTALL_ID` — 저장소 표식과 맞아야 한다. 설치 관리자의 `install.json` 도 이 값으로 바꾼다). 구역 목록, 메일 종류·메일 도메인(`DOMAIN` — 계정의 메일 주소), 외부 SMTP, 코드 저장소 이미지, `ADMIN_EMAILS`, `APP_NAME`, 인증서 연락처. 그리고 설치 관리자가 다루지 않는 변수(브랜드·기능 플래그·상한 등)는 `.env` 끝의 "백업에서 옮겨 온 설정"에 그대로 |
| **새 답변으로 덮는다** | `APP_URL`, `GITEA_EXTERNAL_URL`, `GIT_SSH_DOMAIN`, `RBI_PUBLIC_ORIGIN`, `ACME_DOMAINS`, `DEPLOY_MODE`, `COMPOSE_PROFILES`, `HAIRPIN_HOST`·`RP_LAN_IP`, `JW_NET_PREFIX`, `BACKEND_WORKERS`, `JW_REGISTRY`·`JW_VERSION`, nginx `site.d`, 회의 서버 설정(새 서버의 공인 주소), 저장소 볼륨. 원래 서버에 딸린 값(`GPU_HOST_IP`, `JW_HOST_REPO`, `BACKUP_VOLUME`, `GITEA_DATA_PATH`, `MCP_PUBLIC_URL`, `DOMAIN_ALIAS`, `DATABASE_URL` 등)은 옮기지 않는다 |
| **새로 만든다** | 설치 관리자 내부 API 키(`JW_INSTALLER_KEY`), 설치 토큰·세션·설치 관리자의 인증서, 백업에 없던 비밀값 |

메일 서명 키(DKIM)는 데이터와 함께 돌아온 것을 이어 쓴다(등록해 둔 DNS 레코드와 맞아야 한다).

### 단계

| 단계 | 하는 일 | 대표 실패 원인 |
|---|---|---|
| `unpack` | 백업 설정 + 새 답변으로 스택 파일 쓰기(위 병합), `compose config -q`. 도커 볼륨 저장소면 볼륨·표식까지 | `restore_backup_missing`, `restore_config_failed`, `compose_invalid` |
| `storage` | (NFS·지정 폴더일 때만) 표식 대조 → 볼륨 만들기 | `storage_marker_missing`, `storage_other_install`, NFS 원인들 |
| `pull` | 이미지 받기 | `image_pull_failed` |
| `database` | postgres·redis 시작(빈 DB) → 메일·코드 저장소 컨테이너를 **만들기만** 하고(볼륨이 생긴다) → `compose run backend python -m app.cli restore <백업> --yes --json --items db,mail,gitea,plugins-data,app-signing[,certs]` → 메일 서명 키 이어 쓰기, 스택 파일 다시 쓰기 → `migrate` | `database_not_ready`, `restore_database_failed`(`stage`·`detail`·`state` — backend 의 복원 단계 이름과 그 뒤 DB 상태), `database_migrate_failed` |
| `files` | (백업에 파일이 있을 때만) 백업 안의 `files.tar` 를 저장소에 푼다 — 보조 컨테이너가 root 로 백업을 연 뒤 backend 의 사용자(1000:1000)로 권한을 내려 쓴다(root 를 낮추는 NFS 내보내기에도 된다). 저장소의 기존 내용은 비운다 | `restore_files_failed` |
| `cert` | 인증서(설치와 같다) | `cert_issue_failed`(대안: 임시 인증서) |
| `zones` | 구역 시작·연결(코드 저장소의 로그인 원본·OAuth 클라이언트를 새 주소로 다시 등록) → 확인(앞단으로 `/api/health`, 계정 수 = 백업의 계정 수) → 잠금 → 꺼내 둔 설정·암호·올린 사본 지우기 | `service_not_ready`, `git_*` |

- 인증서 항목(`certs`)은 접속 주소가 백업과 같고 자동 발급일 때만 되돌린다(받아 둔 인증서를 이어 쓴다). 주소가 바뀌었거나 임시 인증서면 건너뛴다.
- 관리자 계정은 만들지 않는다. DB 에 저장되는 설정(외부 SMTP 의 보안 방식·AI 제공자)도 덮어쓰지 않는다 — 백업과 함께 온다.
- 실패하면 그 단계부터 다시(`retry`). 상태에는 `mode: "restore"` 와 완료 화면용 `restore: {"files": restored|not_included|nfs, "storage_kind", "cert", "domain_changed"}` 가 붙는다.

### 무인(답변 파일)

```json
{
  "version": 1,
  "mode": "restore",
  "restore": { "path": "/srv/backups/20260101_030000-full.jwbak" },
  "access": { "domain": "ws.example.com", "network": "direct", "cert": "temporary" },
  "storage": { "kind": "local" }
}
```

```bash
docker exec jw-installer jw apply --answers /data/restore.json --dry-run   # 백업 확인·검증·단계 목록(아무것도 남기지 않는다)
docker exec jw-installer jw apply --answers /data/restore.json
```

`access.domain` 을 비우면 백업의 주소, `advanced.subnet` 을 안 적으면 기본 대역이다. 접속 주소가 아직 이 서버를 가리키지 않으면 `"cert": "temporary"` 로 적는다. 암호 보호 백업은 `restore.password_file` 또는 `-e JW_BACKUP_PASSWORD`.

### 끝난 뒤

접속 주소의 레코드를 이 서버로 옮기고, 임시 인증서였으면 관리 › 보안의 인증서 카드에서 발급하고(§15), 확인한 뒤 원래 서버를 끈다(두 서버를 같이 쓰면 데이터가 갈라진다). 세션은 백업에 없다 — 모두 다시 로그인한다.

## 15. 인증서 다시 발급 · 보류된 구역 연결

임시(자체 서명) 인증서로 설치·복원한 서버를 신뢰되는 인증서로 바꾸는 길이다. 화면은 관리 › 보안의 "인증서" 카드, backend 는 `/api/admin/system/cert…` 가 아래를 대신 부른다. 코드는 `installer/app/certctl.py`.

| 메서드·경로 | 하는 일 |
|---|---|
| `GET /internal/cert` | `{"managed"(이 서버가 TLS 를 끝내는가), "mode": auto\|upload\|temporary\|proxy, "temporary", "domain", "names", "wanted_names", "not_after", "days_left", "issuer", "self_signed", "pending": [구역 id], "job"}` |
| `POST /internal/cert/reissue` `{"mode": "auto"}` | Let's Encrypt 에 다시 요청한다(접속 주소가 이 서버를 가리키고 80 이 밖에서 닿아야 한다) |
| `POST /internal/cert/reissue` `{"mode": "upload", "cert", "key"}` | 가진 인증서로 바꾼다. 검증은 마법사의 인증서 확인과 같고, 걸리면 `422 cert_invalid` + `checks` |
| `POST /internal/zones/<id>/reconnect` | 보류된 연결을 다시 시도. 여전히 안 되면 작업이 `failed`(`connection_still_pending`) |

작업(`kind: "cert"`, `zone: null`)의 단계는 `issue`(답변·설정을 바꾸고 발급·배치) → `reload`(nginx 재시작, 회의 서버 재시작, 자동 발급이면 갱신 컨테이너 시작, backend 다시 만들기) → `reconnect`(보류된 구역의 `connect` 훅 — 코드 저장소의 로그인 연동). `issue` 가 실패하면 답변·설정을 되돌리고 **쓰던 인증서를 다시 놓는다**(자동 발급을 시도하며 임시 인증서의 링크를 뗐을 수 있다). 거부: `409 cert_managed_by_proxy`(앞단 프록시가 맡는 설치), `422 cert_auto_needs_domain`, `409 busy`.

구역 연결이 보류되는 경우는 지금 하나다: 코드 저장소의 로그인 원본 등록(Gitea 가 접속 주소의 인증서를 믿지 못할 때). `GET /internal/zones` 의 그 구역 행에 `pending: true` 가 붙고, 관리 › 구역에 "연결 보류"와 "다시 연결"이 보인다.

## 16. 업데이트

설치 뒤의 업데이트도 설치 관리자가 한다. 화면은 관리 › 업데이트이고, backend 가 내부 API(`/internal/update/*`)를 대신 부른다 — 응답의 모양과 오류 코드는 [update-api.md](update-api.md), 사용자 쪽 설명은 [update-system.md](update-system.md), 채널·릴리스의 형식은 [releases.md](releases.md).

| 파일 | 하는 일 |
|---|---|
| `app/update_release.py` | 채널을 받아 검증하고 계획을 세운다. 검증은 릴리스 도구의 모듈(`release/jwrelease` 의 `semver`·`model`·`verify`·`bundle`)을 그대로 쓴다 — 이미지 빌드가 `/app/jwrelease` 로 복사한다 |
| `app/update_engine.py` | 작업(적용·되돌림·복원), 예고와 점검, 자동 업데이트, 복원 지점, 기록 |
| `app/update_offline.py` | 오프라인 묶음과 추가 이미지 |
| `app/update_restack.py` | 스택 파일을 이 이미지의 번들로 다시 쓴다(새 버전 이미지의 일회용 컨테이너에서 돈다) |
| `app/update_swap.py` | 설치 관리자 자기 교체(보조 컨테이너에서 돈다) |
| `app/api_update.py` | 내부 API 경로 |

### 채널과 공개 키

| 설정 | 어디서 | 기본 |
|---|---|---|
| 채널 주소 | 환경변수 `JW_UPDATE_CHANNEL_URL`(이미지 빌드 인자 같은 이름으로 기본값을 굽는다) | 릴리스 도구의 `channel_base_url`(`release/jwrelease/config.py`) |
| 공개 키 | `<설치 폴더>/state/update/keys/*.pub` — 있으면 이것만 쓴다. 없으면 이미지의 `/app/keys/*.pub`(빌드할 때 `installer/keys/` 에 넣은 것) | 리포에는 키가 없다 |
| 오프라인 묶음을 받는 주소 | `JW_UPDATE_OFFLINE_URL`(`{version}`·`{filename}`) | 릴리스 도구의 `download_url_template` |

- 공개 키는 **둘까지**(현재·다음, 파일 이름순) 받고 어느 하나로 검증되면 통과시킨다 — 키 교체 절차는 releases.md 의 "키 관리".
- 키가 하나도 없으면 확인은 `unconfigured` 로 끝난다(채널을 받으러 가지 않는다).
- 확인은 여섯 시간마다 + 0~30분의 흔들림. 채널 서버에는 정적 파일을 GET 할 뿐이고 식별자·버전·통계를 보내지 않는다. 받아들인 채널의 순번(`sequence`)을 기억해, 그보다 낮은 파일은 거부한다.
- 검증을 통과한 manifest 는 `state/update/manifests/` 에 서명과 함께 두고, **쓸 때마다 서명을 다시 확인한다.**

### 적용 단계와 번들

| 단계 | 하는 일 |
|---|---|
| `preflight` | manifest 서명 재확인, 다른 작업 유무, backend 가 떠 있는가, 여유 공간(받을 용량의 2배 + 1GB), 스키마 버전이 내려가지 않는가(`migrate --status` 와 manifest 의 `db_schema`), 플러그인 호환 |
| `backup` | backend 컨테이너에서 `backup create --kind pre-update --json` → 지금의 스택 파일을 `state/update/snapshots/<복원 지점>/stack/` 에 복사 → 복원 지점으로 등록 |
| `pull` | **설치 관리자 이미지부터** 다이제스트로 받아 번들을 `state/update/bundles/<버전>/` 에 꺼낸다 → 그 compose 로 켜지는 서비스를 알아내, 우리 이미지와 켜진 구역의 남의 이미지를 다이제스트로 받는다. 우리 이미지에는 `<JW_REGISTRY>/just-workspace-<이름>:<버전>` 태그를 붙인다(compose 가 그 이름으로 가리킨다) |
| `migrate` | `.env` 위에 `JW_VERSION=<새 버전>` 만 덮어 새 backend 이미지의 일회용 컨테이너로 `python -m app.cli migrate` |
| `switch` | 새 설치 관리자 이미지의 일회용 컨테이너가 스택 파일을 다시 쓴다 → 구역의 컨테이너 → 프런트 → nginx(다시 만든다) → **backend(맨 마지막)** → 설치 관리자 자신 |
| `verify` | 컨테이너가 전부 준비됐는가, backend 가 그 버전의 이미지인가, `/api/health`, DB 스키마 버전 = 코드가 요구하는 버전 = manifest 의 값, 설치 관리자의 버전 |

**번들.** 새 버전의 compose·nginx 템플릿·구역 선언은 새 설치 관리자 이미지 안에 있고, 답변을 `.env`·설정 파일로 바꾸는 코드도 그 이미지의 것이다. 그래서 스택 파일은 옛 설치 관리자가 쓰지 않고 새 이미지가 쓴다(`docker run --rm … <새 이미지> python -m app.update_restack`). 답변·비밀값·감지값은 상태 폴더의 것을 그대로 쓴다.

**자기 교체.** 컨테이너는 자신을 바꿀 수 없다. `switch` 의 끝에서:

1. 작업 상태를 디스크에 쓴다(`ctx.handoff = {to, image, step, state: "pending"}`).
2. 자기 이미지로 보조 컨테이너를 띄운다(docker 소켓과 설치 폴더를 붙여서). 보조 컨테이너는 옛 컨테이너의 구성을 읽고, 멈추고, 이름을 `<이름>-prev` 로 바꾼 뒤, 같은 이름·재시작 정책·게시 포트·볼륨·사용자가 준 환경변수·네트워크(별칭 포함)로 새 이미지의 컨테이너를 만들어 시작한다.
3. 새 설치 관리자는 기동할 때 진행 중인 작업을 읽는다. 자신의 버전이 `handoff.to` 와 같으면 그 단계를 끝난 것으로 치고 `verify` 로 넘어간다.
4. 새 컨테이너가 정상이 아니거나 버전이 다르면 보조 컨테이너가 그것을 지우고 옛 컨테이너를 되살린다. 되살아난 옛 설치 관리자는 자신의 버전이 `handoff.to` 와 다른 것을 보고 그 단계를 `installer_replace_failed` 로 실패 처리한다(→ 자동 되돌림). 보조 컨테이너를 띄우지 못했거나 5분 안에 아무 일도 일어나지 않아도 같다.

- 옮기는 구성은 위 목록이 전부다. 그 밖의 옵션(자원 제한, 레이블 등)을 직접 붙여 띄운 설치 관리자는 교체 뒤 다시 붙여야 한다.
- 환경변수는 "옛 이미지가 정한 값"을 빼고 옮긴다(새 이미지의 기본값이 살아야 한다). `JW_IMAGE_TAG` 는 옮기지 않는다 — 업데이트 뒤에는 이미지 태그가 곧 제품 버전이다.
- 새 컨테이너에는 `JW_INSTALLER_VERSION=<제품 버전>` 을 넣는다. 승격(Beta → Stable)은 이미지를 다시 빌드하지 않아서 이미지 안의 `VERSION` 은 Beta 의 글자다 — 설치 관리자는 이 환경변수가 있으면 그것을 자신의 버전으로 안다.
- 되돌림·복원이 설치 관리자의 버전을 바꿔야 할 때도 같은 방법을 쓴다(`start` 단계의 끝, 이미지는 복원 지점에 적어 둔 것). 이때의 환경변수는 지금 컨테이너에서 추리지 않고 **복원 지점에 적어 둔 것**(그 버전이 돌 때 사용자가 준 값)을 그대로 쓴다 — 새 이미지의 기본값과 같아서 올라올 때 빠진 값(예: 채널 주소)이 옛 이미지로 돌아가면서 사라지지 않게.
- backend 이미지의 일회용 컨테이너(`migrate`, 복원)는 내부망의 고정 주소 없이 띄운다 — 돌고 있는 backend 가 그 주소를 쥐고 있다(`compose run` 에 조각을 하나 덧붙인다).

### 실패와 되돌림

- `migrate` 전(`preflight`·`backup`·`pull`)의 실패: 작업이 `failed` 로 멈추고 `choices = ["retry", "rollback"]`. 이때의 되돌림은 바꾼 것이 없으므로 `stop`·`images`·`restore_db` 를 건너뛴다(`detail.skipped`).
- `migrate` 부터의 실패, 그리고 자동 업데이트의 모든 실패: 되돌림 작업을 바로 만든다.
- 되돌림·복원의 단계: `stop`(DB·캐시·nginx 를 뺀 컨테이너를 멈춘다) → `images`(스택 파일을 복원 지점의 것으로 되돌린다) → `restore_db`(그 버전 backend 이미지의 일회용 컨테이너에서 `restore <백업> --items db --yes`. DB 변경을 시작하지 않았으면 건너뛴다. 백업의 스키마 버전이 복원 지점의 기록과 다르면 시작하지 않는다) → `start`(backend 를 맨 마지막에, 그 뒤 설치 관리자 교체) → `verify`.
- 되돌림이 실패하면 그 작업이 `failed` + `choices = ["retry"]` 로 남고 점검은 풀리지 않는다. `error.vars.backup_location` 이 백업의 위치다.
- 중간 버전을 거치다 실패하면 **그 버전의 직전**으로 되돌린다. 이미 끝낸 앞 버전은 그대로다.

### 점검 모드

점검이 시작되면(예고가 끝난 때, `backup` 전) 설치 관리자가 `stack/nginx/state/maintenance.on` 을 놓는다. nginx 는 이 파일이 있으면 관리자의 진행 화면이 쓰는 경로(`/api/auth/`, `/api/admin/system/update/`, `/api/system/update-notice`, `/api/health`)만 지나가게 하고 그 밖의 API·소켓·구역 프록시를 `503 {"code": "maintenance"}`(+ `Retry-After`)로 막는다. 파일은 요청마다 보므로 nginx 를 다시 읽힐 필요가 없다. 작업이 끝나면(성공이든 되돌림이든) 지운다. 관리자의 선택을 기다리는 동안과 되돌림이 실패해 멈춘 동안에는 남는다.

### 복원 지점의 보관

- `pre-update`(업데이트 직전 백업): **최근 3개**. 업데이트가 성공으로 끝날 때 넘치는 것을 지운다 — 백업 폴더, 스택 사본, 그리고 어느 복원 지점도 가리키지 않게 된 옛 버전의 우리 이미지 태그.
- `pre-beta`(Stable 에서 Beta 로 처음 올리기 직전): 위 3개와 따로 **하나**를 기한 없이 둔다. Stable 채널로 돌아와 지금 버전이 Stable 이 되거나, "시험판 이전 상태로 복원"을 마치면 지운다.
- 복원 지점은 백업의 위치·크기·스키마 버전, 그때의 버전, 스택 사본, 그때 돌던 설치 관리자의 이미지와 환경변수를 기억한다. 그 버전의 이미지가 서버에 남아 있어야 복원할 수 있다(위 규칙이 지키는 것).

### 오프라인

1. 묶음을 올리거나(`POST …/offline/bundle`, 본문을 디스크로 흘려 받는다 — `state/update/offline/bundle.tar`) 서버의 경로를 지정한다(설치 폴더 아래만. `<설치 폴더>/…` 로 적어도 `/data/…` 로 적어도 된다. 복사하지 않고 그 자리에서 읽는다).
2. 검증: 묶음 서명 → manifest → 파일별 해시(`jwrelease.bundle.verify_bundle`) → 버전(현재보다 높고 한 번에 갈 수 있어야 한다).
3. 추가로 필요한 이미지: manifest 의 남의 이미지 중 묶음에 없는 것. 지금 프로파일에서 켜지지 않는 것은 `not_needed`. 서버에 그 다이제스트(또는 `저장소:jw-<다이제스트 앞 12자>` 이름)가 있으면 `present`.
4. 이미지 파일을 올리면 `docker load` 한 뒤 위 이름이 생겼는지 본다. 안 생겼으면 `hash_mismatch`.
5. 적용: `pull` 단계가 받는 대신 묶음에서 이미지를 꺼내 `docker load` 한다. 다이제스트로 찾을 수 없는(이름으로만 들어온) 남의 이미지는 `stack/docker-compose.pins.yml` 로 그 이름을 가리킨다.

올리는 파일의 상한은 64GB(`JW_UPDATE_UPLOAD_MAX`, 바이트). 이어 올리기는 없다 — 큰 파일은 경로 방식이 낫다.

### 실서버 검수

`installer/e2e/scenarios/u-update.sh <단계…>` — 서버 안에 가짜 릴리스 환경(루프백의 `registry:2`, 정적 채널 서버, 그 자리에서 만든 임시 키)을 만들고 릴리스 도구로 진짜 형식의 릴리스를 내서 돌린다(`update-lib.sh`). 무엇을 확인했는지는 13절의 표.
