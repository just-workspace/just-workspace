# 설치 관리자

Just Workspace 를 "리눅스 + Docker Engine(x86_64)" 서버에 설치하는 컨테이너다. 단일 명령으로 기동하며, 이후 절차는 브라우저의 설치 마법사에서 수행한다. 동일한 엔진이 응답 파일 기반의 무인 설치도 수행한다.

> 본 문서는 설치 관리자의 **핵심부**(API 와 엔진)를 기술한다. 마법사 화면은 `frontend-react/src/installer-app/` 의 독립 번들이며,
> 설치 관리자 이미지에 포함되어 8443 의 `/` 로 제공된다.
> 설치 담당자용 안내(사전 준비·화면별 설명·문제 해결)는 [install.md](install.md), 설치 후 운영은 [operate.md](operate.md) 를 참조한다.
> `docker compose up` 을 직접 실행하는 수동 구성 절차는 유지된다 — [deployment.md](deployment.md).

## 1. 단일 명령 설치

```bash
docker run -d --name jw-installer --restart unless-stopped \
  -p 8443:8443 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/just-workspace:/data \
  -e JW_HOST_DIR=/opt/just-workspace \
  -e JW_INSTALLER_VERSION=<버전> \
  <설치 관리자 이미지>:<버전>

docker logs jw-installer
```

로그에 접속 주소와 인증서 지문이 출력된다.

```
 브라우저에서 여세요:  https://<서버 주소>:8443/?token=XXXXXXXXXXXX
 SHA-256 지문: AB:CD:…
```

- `-v <호스트 폴더>:/data` 와 `-e JW_HOST_DIR=<동일한 호스트 폴더>` 는 **반드시 동일한 경로**여야 한다(§3).
- `-e JW_INSTALLER_VERSION=<버전>` 은 설치 관리자가 자신(및 설치 대상 제품)의 버전으로 인식하는 값이다 — 이미지 태그와 동일하게 지정한다. 승격(Beta → Stable)한 이미지는 재빌드하지 않으므로 이미지 내 `VERSION` 이 Beta 의 버전 문자열이며, 이 값이 지정되지 않으면 해당 문자열을 버전으로 사용한다(기동 시 로그에 한 줄로 고지한다). 소스에서 빌드한 이미지는 이미지의 값이 곧 해당 버전이므로 생략해도 결과가 동일하다.
- 이미지 저장소는 `-e JW_REGISTRY=<저장소/네임스페이스>`, 이미지 태그는 `-e JW_IMAGE_TAG=<태그>` 로 변경한다. 기본값은 `ghcr.io/just-workspace` 와 제품 버전(`VERSION`)이다. `JW_REGISTRY=localhost` 를 지정하면 서버에 이미 존재하는(소스에서 빌드한) 이미지를 사용한다.
- `-e JW_PUBLIC_HOST=<서버 주소>` 를 지정하면 로그의 주소와 인증서 이름에 해당 값을 사용한다.
- 업데이트 확인 대상 채널 주소는 `-e JW_UPDATE_CHANNEL_URL=<주소>` 로 변경한다(기본값은 공식 채널). 서명 검증용 공개 키와 함께 16절에서 기술한다.

이미지 빌드(리포 루트에서 실행 — 빌드 컨텍스트는 리포 루트, 포함 대상은 `installer/Dockerfile.dockerignore` 참조).
첫 단계(Node)에서 마법사 화면을 빌드하며(`npm ci` + `npm run build:installer`), 그 결과물(`installer.html`·`assets/`·`icon.svg`)이 `/app/ui` 에 포함된다:

```bash
docker build -f installer/Dockerfile -t just-workspace-installer:$(cat VERSION) .
# 대상 이미지 저장소의 기본값을 변경해 빌드하는 경우: --build-arg JW_REGISTRY=<저장소/네임스페이스>
```

## 2. 구조

```
installer/
  Dockerfile                 (Node) 마법사 화면 빌드 → Python + FastAPI + docker CLI·compose 플러그인
  Dockerfile.dockerignore    빌드 컨텍스트(번들 원본, installer/, 화면의 원본 frontend-react/)
  app/
    answers.py     입력값 모델 · 검증(필드별 오류) · 비밀값 분리
    catalog.py     구역·메모리·포트 계산(zones.json 은 읽기 전용)
    render.py      입력값 → 스택 파일(순수 함수)
    envfile.py     .env 이스케이프
    validators.py  도메인·대역·경로·NFS export 등 입력 검증
    bundle.py      번들(빌드 시 리포에서 복사한 파일) 읽기
    paths.py       컨테이너 내부 경로 ↔ 호스트 경로
    docker_api.py  docker·호스트 접근의 단일 진입점(인자 배열)
    helper.py      보조 컨테이너 내부에서 실행되는 명령
    preflight.py   사전 점검
    probes.py      검증(DNS·메일 레코드·SMTP·AI·NFS·로컬 폴더)
    certs.py       자체 서명 인증서, 업로드한 인증서 검증
    dkim.py        DKIM 키(적용 전 사전 생성)
    tokens.py      설치 토큰 · 세션
    state.py       상태 파일
    engine.py      적용 엔진(단계)
    zones/         구역 훅(__init__.py = 기본 동작, git.py = Gitea)
    zonectl.py     설치 후 구역 활성화·비활성화·설정
    api.py         마법사 API(8443) · 내부 API(8444)
    api_update.py  업데이트 내부 API(/internal/update/*)
    cli.py         jw 명령
    server.py      서버 진입점
    update_*.py    업데이트 — 채널 확인, 적용·롤백, 오프라인 번들, 자기 교체(§16)
  tests/           docker 없이 실행되는 테스트
  e2e/             실서버 검수 — 시나리오 러너와 응답 파일 견본(§13)
```

단일 출처(single source)는 복제하지 않는다. 이미지 빌드 시 리포에서 **복사**해 번들(`/app/bundle`)에 포함한다.

| 번들 파일 | 리포 원본 | 용도 |
|---|---|---|
| `zones.json` | `backend/app/zones.json` | 구역 목록·메모리·포트·compose 프로파일 |
| `security_defaults.py` | `backend/app/security_defaults.py` | 비밀값 이름·길이·금지 문자, 대체 생성기 |
| `VERSION` | `VERSION` | 제품 버전(= pull 대상 이미지 태그) |
| `docker-compose.yml`, `nginx/*`, `init/*`, `scripts/certbot-entrypoint.sh`, `mailserver/config/*` | 동일 경로 | compose 및 compose 가 bind mount 하는 파일 |
| `frontend-react/public/maintenance.html` | 동일 경로 | 정적 점검 페이지 — nginx 가 직접 마운트해 제공한다(업데이트 중에는 프런트 컨테이너도 교체 중일 수 있다) |

개발·테스트 환경에서는 번들 폴더 없이 리포에서 직접 읽는다.

## 3. 경로 — 컨테이너 내부와 호스트

설치 관리자는 컨테이너 내부에서 실행되며, 설치 관리자가 `docker compose` 로 생성하는 컨테이너는 호스트에서 실행된다. 동일한 폴더가 두 개의 경로를 갖는다.

| 구분 | 설치 관리자 컨테이너 내부 | 호스트 |
|---|---|---|
| 데이터 루트 | `/data` | `$JW_HOST_DIR` (예 `/opt/just-workspace`) |
| 스택 — compose 파일, 설정 파일, `.env`(권한 600) | `/data/stack` | `$JW_HOST_DIR/stack` |
| 상태 — 입력값, 단계 상태, 로그, 토큰, 설치 관리자 인증서 | `/data/state` | `$JW_HOST_DIR/state` |

compose 는 항상 다음 형식으로 호출한다.

```
docker compose -p just-workspace
    --project-directory $JW_HOST_DIR/stack        ← 호스트 경로
    -f /data/stack/docker-compose.yml             ← 컨테이너 내부 경로(compose CLI 가 읽는다)
    -f /data/stack/docker-compose.site.yml
    --env-file /data/stack/.env
    <명령>
```

경로별 해석 주체:

- **compose 파일·`--env-file`** 은 compose CLI(설치 관리자 컨테이너 내부)가 읽는다 → 컨테이너 내부 경로.
- **bind mount 의 원본 경로**(`./nginx/nginx.conf` 등 상대 경로)는 `--project-directory` 를 기준으로 절대 경로로 변환되어 docker 데몬에 전달되며, 데몬은 이를 **호스트** 경로로 해석한다 → `--project-directory` 는 호스트 경로여야 한다.
- 서비스의 **`env_file: .env`** 도 `--project-directory` 기준이나, 이는 데몬이 아니라 **compose CLI 가** 읽는다. 따라서 호스트 경로 문자열이 설치 관리자 컨테이너 내부에서도 동일한 파일을 가리켜야 한다. 설치 관리자는 기동 시 컨테이너 내부에 `$JW_HOST_DIR → /data` 심볼릭 링크를 생성한다. `$JW_HOST_DIR` 와 동일한 경로가 컨테이너 내부에 이미 다른 용도로 존재하면(`/usr` 등) 기동하지 않는다.
- 프로젝트 이름은 `-p just-workspace` 로 고정한다(폴더 이름 `stack` 이 적용되지 않도록 하기 위함). 내부망 이름은 `just-workspace_workspace` 다.

## 4. 응답 파일

마법사의 상태와 응답 파일은 동일한 형식(JSON)이다. 화면의 "답변 파일 내려받기"(`GET /api/answers/export`)는 **비밀값을 제외한** 내용을 반환한다.

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
| `mode` | `new` · `quick`(구역을 선택하지 않으면 협업 프리셋, 메모리가 부족하면 최소 프리셋으로 하향하고 사유를 기록한다) · `restore`(백업에서 복원 — §14) |
| `access.domain` | 접속 주소(도메인 이름, 또는 임시 인증서와 함께 IP 주소) |
| `access.network` | `direct`(이 서버가 직접 수신) · `router`(공유기 하단 — 포트 포워딩 안내) · `proxy`(프런트 프록시 하단) |
| `access.proxy_addresses` | `proxy` 인 경우 프록시 주소(IPv4 또는 CIDR) 목록 |
| `access.cert` | `auto`(Let's Encrypt) · `upload` · `temporary`(자체 서명 — 접속 주소가 서버를 가리키지 않거나 확인이 불가한 경우, 또는 발급 실패 후에만 허용) · `proxy`(프록시가 처리) |
| `access.cert_path` / `key_path` | 무인 설치에서 `upload` 인 경우의 파일(`/data/` 하위) |
| `access.ca_path` | (선택) 사설 CA 가 발급한 인증서인 경우 해당 CA 인증서 파일(`/data/` 하위) — 인증서 파일에 발급 CA 가 연결(체인)되어 있지 않은 경우에만 필요하다(§15의 "사설 CA") |
| `storage` | `{"kind":"local"}`(도커 볼륨) · `{"kind":"local","path":"/srv/files"}`(호스트의 기존 폴더) · `{"kind":"nfs","server":"…","export":"/…"}`. DB·메일함은 항상 로컬 |
| `preset` / `zones` / `addons` | `zones`(활성화할 구역 id 목록)가 있으면 해당 값, 없으면 `preset`(`minimal`·`collab`·`full` — `zones.json` 의 presets). `addons` 는 부가 구역(`sso`, `rbi`) |
| `mail` | `builtin` + `mail_domain`, 또는 `external` + `host`·`port`·`security`(`starttls`/`ssl`/`none`)·`username`·`password` |
| `meetings` | `public_ip`(비우면 감지값) · `turn`(중계) · `lossless_audio`(UDP 4433, 채팅 구역 필요) |
| `ai` | `{"mode":"later"}` 또는 `{"mode":"provider","provider":"anthropic\|openai\|gemini\|ollama\|compatible","api_key":"…","model":"…","base_url":"…"}` |
| `git.version` | `verified`(compose 에 고정된 이미지) · `latest` · 이미지 태그 |
| `advanced.subnet` | 내부 대역(사설 IPv4 /24, 기본 `172.28.0.0/24`) |
| `admin` | `name` · `username` · `password`(12자 이상) |
| `restore` | `mode: restore` 에서만 유효 — `path`(서버에 있는 백업 파일·폴더의 절대 경로) · `password_file`(설정이 암호로 보호된 백업의 암호를 담은 파일, `/data/` 하위) |

- 비밀값(`admin.password`, `mail.password`, `ai.api_key`)은 저장 시 분리해 `answers.secret.json`(600)에 보관한다. 관리자 비밀번호와 AI 키는 사용 후 삭제한다.
- 무인 설치에서 비밀값은 파일에 기재하거나 환경변수로 전달한다: `JW_ADMIN_PASSWORD`, `JW_MAIL_PASSWORD`, `JW_AI_API_KEY`.
- 비활성 구역의 항목은 검증하지 않으며 사용하지도 않는다. 정의되지 않은 항목은 거부한다.
- 검증은 필드별 오류를 반환한다: `{"field": "access.cert", "code": "cert_not_proxy_behind_proxy", "vars": {…}}`. 문구는 화면 측에서 관리한다.
- 메모리 판정: 선택한 구역의 `memory_mb.recommend` 합계(기본 구역 포함)가 서버 메모리를 초과하면 적용이 불가하다. 서버 메모리는 1GB 단위로 올림한 값과 실측값의 차이가 8% 이내이면 올림값으로 간주한다("4GB 서버"의 실측값은 약 3.8GB 이다). 4GB 미만은 사전 점검 실패로 처리한다.

## 5. 접속 및 보안 모델

- **HTTPS 8443, 자체 서명 인증서.** 최초 기동 시 생성해 `/data/state/tls/` 에 보관하고 SHA-256 지문을 로그에 출력한다. 브라우저의 경고 화면에서 지문을 대조한다.
- **화면.** `/` 와 정적 자산(`/assets/*`, `/icon.svg`)은 세션 없이도 제공한다 — 토큰 입력 화면과 잠금 안내는 화면 측에서 렌더링한다. 세션이 필요한 대상은 `/api/*` 뿐이다. `installer.html` 은 `no-cache`, 자산(파일 이름에 내용 해시 포함)은 `immutable` 이다. 모든 응답에 `Content-Security-Policy`(`script-src 'self'` — 인라인 스크립트 없음, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`(주소에 토큰이 포함될 수 있다)를 부여한다. API 응답은 `no-store` 다.
- **설치 토큰.** 영문 대문자·숫자 12자리(0/O/1/I 제외), 유효 기간 24시간. 주소의 `?token=` 으로 접근하면 검증 후 토큰이 없는 주소로 리다이렉트한다(302). 일치하면 세션 쿠키(`HttpOnly`·`Secure`·`SameSite=Strict`)를 발급하고, 불일치하면 `/?token_status=wrong|expired|locked` 로 리다이렉트해 화면에 사유를 표시한다. API 의 경우 불일치는 `token_wrong`, 만료는 `token_expired` 를 반환한다. 5회 불일치 시 30초간 요청을 거부한다(`token_locked`). `docker exec jw-installer jw token` 으로 재발급하면 기존 토큰은 무효화되며, 입력된 값과 열린 세션은 유지된다.
- **잠금.** 설치가 완료되면 토큰과 세션을 폐기하고 마법사 API 는 `423 locked` 만 반환한다. 화면(`/`)과 `GET /api/state` 만 유지된다(설치 완료 표시, 워크스페이스 주소, 재설치·관리자 비밀번호 재설정 명령).
- **내부 API.** 설치 후의 관리 작업은 `/internal/*` 로만 수신한다. 별도 포트(8444)에서 평문으로 제공하며 **호스트에 게시하지 않는다.** 설치 관리자는 적용 중에 자신을 워크스페이스 내부망에 `jw-installer` 라는 이름으로 연결한다. 요청은 공유 키(`X-JW-Installer-Key`, 설치 시 생성해 backend 의 `JW_INSTALLER_KEY` 로 전달)와 내부 대역의 출발지 주소를 모두 충족해야 하며, 그렇지 않으면 404 를 반환한다. 브라우저에서는 이 포트에 접근할 수 없다.
- **docker.sock.** 설치 관리자는 호스트의 docker 소켓을 보유한다 — 이 컨테이너가 탈취되면 서버 전체가 탈취된 것과 동일하다. 이에 따라 (1) 외부에는 토큰으로 보호되는 8443 포트 하나만 개방하고, (2) 설치가 완료되면 해당 포트도 잠그며, (3) 사용자 입력은 전부 검증하고 명령은 인자 배열로만 구성한다(셸을 경유하지 않는다). 설치 완료 후 8443 게시를 방화벽에서 차단해도 무방하다(내부 API 는 영향을 받지 않는다).
- **비밀값.** 생성 규칙의 단일 출처는 backend 의 `security_defaults` 다. 설치 관리자는 backend 이미지를 1회 실행해(`python -m app.cli gen-secrets --format json`) 결과를 사용하며, 해당 이미지를 사용할 수 없는 경우에만 번들에 포함된 동일한 표로 생성한다. 비밀값은 로그에 출력하지 않으며(식별된 값은 마스킹한다), 명령 인자에도 포함하지 않는다(`--env-file`·표준 입력). 예외는 Gitea 의 `auth add-oauth --secret` 하나다 — Gitea CLI 가 다른 전달 방식을 제공하지 않는다.

## 6. API

오류 응답은 모두 `{"code": "…", "vars": {…}}` 형식이다. 세션이 없으면 `401 auth_required`, 설치 후에는 `423 locked` 를 반환한다.

### 마법사 API (8443, 세션 필요)

| 메서드·경로 | 기능 |
|---|---|
| `GET /` · `/assets/*` · `/icon.svg` | 마법사 화면(세션 없이) |
| `GET /?token=…` | 토큰 검증 → 세션 쿠키 → `/` 로 리다이렉트(302). 불일치 시 `/?token_status=…` |
| `POST /api/session` `{"token"}` | 토큰을 직접 입력한 경우 |
| `GET /api/state` | 진행 상태(단계 `wizard`/`applying`/`installed`, 입력값 유무, 사전 점검 통과 여부, 적용 상태·오류·대안, 토큰 만료 시각) + 재개할 화면 `step` + 감지값 `facts` + 화면 표시용 값 `info`(아래) |
| `GET /api/answers` · `PUT /api/answers[?step=<화면 id>]` | 입력값 조회 · 부분 저장(병합, `null` 은 기본값으로 복귀). `step` 을 지정하면 재개할 화면으로 기록한다. 응답: `{"answers", "secrets_set", "errors"}` |
| `GET /api/answers/export` | 비밀값을 제외한 응답 파일 |
| `POST /api/preflight` | 사전 점검(§7) |
| `GET /api/zones` | `zones.json` + 고른 구역 + 서버 메모리 대비 판정(`fits`, `preset_fits`, `memory`) |
| `GET /api/probe/public-ip` | 공인 주소 감지 |
| `POST /api/probe/dns` | 접속 주소가 이 서버를 가리키는지 여부: `match`/`mismatch`(가리키는 주소 포함)/`unknown` |
| `POST /api/probe/mail-records` | MX·A·SPF·DKIM·DMARC 의 기대값과 현재값: `ok`/`missing`/`different`/`unknown` |
| `POST /api/probe/cert` `{"cert","key","ca"?}` | 업로드한 인증서 검증(도메인·키 쌍 일치·만료·발급자·발급 CA 유무·메일 호스트 이름). `ca` 는 사설 CA 의 인증서(선택) — 지정하면 CA 인증서 여부와 업로드한 인증서의 발급 CA 여부도 검증한다. 통과하면 보관한다. 응답의 `trust`: `included`(발급 CA 확인됨)·`none`(서버 인증서 1장만 존재)·`self_signed` |
| `POST /api/probe/smtp` · `/ai` | 외부 SMTP 로그인 · AI 키 검증 |
| `POST /api/probe/nfs` · `/local-path` | NFS 5단계 검증 · 로컬 폴더(존재 여부, 쓰기 가능 여부) |
| `GET /api/summary` | 요약 + 주의 항목 + 개방되는 포트 + 단계 목록 + `ready` |
| `POST /api/apply` | 적용 시작(202) |
| `GET /api/apply` | 단계 상태(폴링용) |
| `GET /api/apply/stream` | 동일 내용의 SSE(`event: status`, 종료 시 `event: end`) |
| `POST /api/apply/retry` `{"use_temporary_cert"?}` | 실패한 단계부터 재실행 |
| `GET /api/apply/log?step=&tail=` | 단계 로그 |
| `/api/restore/*` | 백업에서 복원 — §14 |

`GET /api/state` 의 `facts` 와 `info`:

| 값 | 의미 |
|---|---|
| `facts.memory_mb` · `public_ip` · `disk_free_gb` | 감지한 메모리 · 공인 주소 · 여유 공간(사전 점검 실행 후 설정된다. 미확인 시 `null`) |
| `facts.lan_ip` | 서버의 아웃바운드 경로 주소 |
| `facts.detected_network` | 해당 주소가 공인이면 `direct`, 사설이면 `router`, 미확인이면 `null`. 프런트 프록시 하단 여부는 판별할 수 없다 |
| `info.git_verified_version` | 코드 저장소의 검증된 버전(compose 의 고정 이미지 옆 주석) |
| `info.default_storage_path` | 기본 저장소(도커 볼륨)가 위치하는 호스트 폴더 |
| `info.source_url` | 본 제품의 소스 위치 — 화면 모서리의 "소스 코드" 링크. 설치 관리자의 환경변수 `JW_SOURCE_URL`, 없으면 릴리스 도구의 `source_repo_url`. 잠금 후에도 제공한다 |
| `info.commands` | 서버 터미널에서 실행하는 명령(`reissue_token`·`reset_admin`·`install_from_answers`·`reinstall`) — 실제 컨테이너 이름으로 생성한다. 잠금 후에는 `reinstall`·`reset_admin` 만 제공한다 |

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

실패 시 `status: "failed"`, `error: {"step", "cause", "fix", "vars"}` 를 반환한다. `cause`·`fix` 는 문구 키다. 인증서 발급에 실패하면 `alternatives: [{"key": "use_temporary_cert"}]` 가 추가된다. `zones` 단계의 `detail.zones` 는 구역별 상태(`pending`→`installing`→`installed`→`connecting`→`done`)다.

### 내부 API (8444, 공유 키 + 내부 대역)

| 메서드·경로 | 기능 |
|---|---|
| `GET /internal/health` | 키 불필요 — 버전, 설치 여부 |
| `GET /internal/zones` | 구역 목록(활성화 여부, 메모리 판정, 설정 유무) + `git_verified_version` |
| `POST /internal/zones/<id>/check` `{"settings"}` | 활성화 가능 여부 — 설정 오류, 메모리, 신규 개방 포트, 주의 항목(변경은 수행하지 않는다) |
| `POST /internal/zones/<id>/enable` `{"settings"}` | 활성화(202 + 작업). 메모리 부족 시 `409 memory_insufficient`, 설정 오류 시 `422 settings_invalid` |
| `POST /internal/zones/<id>/disable` | 비활성화(연동 해제 + 컨테이너 중지, 데이터 볼륨은 유지된다) |
| `GET /internal/zones/<id>/settings` | 활성 구역의 설정 조회(비밀값은 `…_set` 여부만 제공). 코드 저장소는 `verified_version`(검증된 버전 문자열)도 포함 |
| `PUT /internal/zones/<id>/settings` `{"settings"}` | 설정 변경(202 + 작업) |
| `GET /internal/jobs/<id>` · `/log` | 작업 진행·로그 |
| `POST /internal/probe/smtp` · `/ai` | 구역 활성화 창의 "연결 확인" |
| `POST /internal/probe/mail-records` `{"mail_domain"?}` | 메일 레코드(MX·A·SPF·DKIM·DMARC)의 기대값과 현재값 — DKIM 은 설치 시 생성한 키 |
| `GET /internal/probe/public-ip[?refresh=true]` | 공인 주소(캐시된 값, `refresh` 지정 시 재감지) |
| `GET /internal/jobs` | 구역 작업 목록 — 진행 중인 작업과 최근 작업(최신순, 20개) |
| `GET /internal/storage` | 파일 저장소: `{"kind": local\|nfs, "location", "volume", "install_id"}` |
| `/internal/update/*` | 업데이트 — 상태·설정·적용·작업·복원 지점·오프라인·기록. 경로와 응답은 [update-api.md](update-api.md) 참조. `GET /internal/update/maintenance`(공개 점검 상태)만 키 없이 접근할 수 있다 |
| `GET /internal/cert` | 현재 사용 중인 인증서 — §15 |
| `POST /internal/cert/reissue` | 인증서 재발급 / 업로드한 인증서로 교체(202 + 작업) — §15 |
| `POST /internal/cert/ca` | 업로드한 인증서의 발급 CA 인증서만 추가 또는 제거한다(202 + 작업) — §15 |
| `POST /internal/zones/<id>/reconnect` | 보류된 구역 연동을 재시도(202 + 작업) — §15 |

구역별 `settings`:

| 구역 | 값 |
|---|---|
| `mail` | `kind`: `builtin` + `mail_domain` / `external` + `host`·`port`·`security`·`username`·`password` |
| `meetings` | `turn`(중계), `lossless_audio` — 공인 주소는 `GET …/settings` 의 `detected.public_ip` |
| `ai` | `mode`: `now` + `provider`(`openai`/`anthropic`/`google`)·`api_key`(·`model`·`base_url`) / `later` |
| `git` | `version`: `tested`/`latest`/`custom` + `custom_version` |
| 그 밖 | 없음 |

`GET /internal/zones` 의 구역 행에는 `pending`(활성 상태이나 연동이 보류됨)·`pending_reason` 이 포함된다(§15).

작업의 형식은 `{"id", "kind": enable|disable|update|reconnect|cert, "zone", "status": running|done|failed, "stages": [{"id", "status"}], "ports", "error", "warnings"}` 다. 활성화의 단계는 `pull`(이미지 pull) → `configure`(설정) → `connect`(연동) 순이다. 실패하면 입력값·`.env`·컨테이너를 롤백해 **비활성 상태**로 유지한다. 성공하면 `.env` 의 `JW_ZONES`·`COMPOSE_PROFILES` 가 변경되고 backend 가 재기동된다. 작업은 동시에 하나만 실행된다(`409 busy`).

### 명령(`docker exec jw-installer jw …`)

| 명령 | 기능 |
|---|---|
| `jw token` | 설치 토큰 재발급 |
| `jw status [--json]` | 단계별 상태 |
| `jw apply --answers <파일> [--dry-run]` | 응답 파일로 설치. `--dry-run` 은 검증·렌더링까지만 수행하고 산출물 요약을 출력한다(변경은 수행하지 않는다) |
| `jw render --answers <파일> --out <폴더>` | 산출물을 지정 폴더에 출력한다(비밀값은 견본) |
| `jw reset-admin <계정> [--disable-2fa]` | backend 의 `python -m app.cli reset-admin` 호출 |
| `jw reinstall [--yes]` | 재설치가 가능하도록 초기화한다. `--yes` 없이는 삭제 대상 목록만 출력한다(아래) |
| `jw restore <백업> [--items a,b] [--password-file F] [--allow-key-mismatch] [--yes] [--json]` · `jw restore --list` | 설치된 서버의 데이터를 백업 시점으로 복원한다. `--yes` 없이는 내용만 출력한다(아래) |
| `jw update-key [list \| add <파일\|-> [--name N] \| remove <이름>]` | 업데이트 채널의 서명 검증용 공개 키(§16) |
| `jw update-channel [<주소> \| --reset]` | 업데이트 채널 주소 조회·변경(§16) |

**재설치.** `docker exec jw-installer jw reinstall` 은 삭제 대상(워크스페이스의 컨테이너·볼륨·내부망, 설치 폴더의 `stack`·`state`)을 출력하고 종료한다. `--yes` 를 지정하면 삭제 후 설치 관리자를 재시작한다 — 신규 설치 토큰이 `docker logs jw-installer` 의 마지막에 출력된다. **계정·파일·메일·대화가 전부 삭제된다.** 설치 관리자 자신의 인증서(지문)는 유지된다. 파일 저장소가 NFS·지정 폴더인 경우 저장소 내 파일은 삭제하지 않고 저장소 마커만 삭제한다(잔존 파일은 신규 설치의 계정과 연계되지 않는다).

**동일 서버로의 복원.** `jw restore <백업>` 은 backend 의 `python -m app.cli restore`([data-safety.md](data-safety.md) 4절)를 backend 이미지의 일회용 컨테이너(`compose run`, 내부망의 고정 주소 없이)로 실행한다. 코드는 `installer/app/restore_local.py` 다.

- `<백업>` 은 서버의 절대 경로(파일 `.jwbak` 또는 폴더 — 읽기 전용으로 마운트한다. `/data/…` 로 지정하면 설치 폴더의 경로로 변환한다)이거나, `/` 가 포함되지 않은 경우 백업 볼륨 내의 이름이다(`jw restore --list`).
- 먼저 `backup inspect` 로 내용을 읽어 생성 서버·버전·복원 대상 항목을 출력한다. `--yes` 가 없으면 이 단계에서 종료한다.
- **설정 항목(`config`)은 복원하지 않는다.** `.env` 와 사이트 파일은 설치 관리자가 입력값에서 생성한 것이다. 따라서 암호화 키가 다른 백업(다른 설치의 백업)은 backend 가 `compat` 단계에서 거부한다 — 해당 백업은 신규 설치의 "백업에서 복원"(§14)으로 처리한다. `--password-file` 은 backend 로 전달되나, 암호는 설정 항목에만 적용되므로 이 명령에서는 생략할 수 있다.
- 실행 중에는 점검 마커(`nginx/state/maintenance.on`)를 생성해 전단(nginx)에서 쓰기를 차단하고, 종료 시(성공·실패 무관) 삭제한다. 서비스의 중지·시작과 DB 복원은 backend 의 복원 절차가 수행한다.
- 결과는 backend 의 출력을 그대로 전달한다: 성공 시 복원된 항목·스키마 버전 변화·복원 전 DB 덤프의 위치, 실패 시 단계 이름·원인·이후의 DB 상태. 종료 후 backend 가 준비 상태가 아니면 성공으로 처리하지 않는다(종료 코드 1).
- 설치·업데이트·구역 작업이 실행 중이면 시작하지 않는다.

## 7. 사전 점검

`fail` 항목이 하나라도 있으면 적용이 불가하다. 적용 시작 시에도 1회 재실행한다.

| id | 통과 조건 | 실패 | 측정 방법 |
|---|---|---|---|
| `docker_engine` | 24.0 이상 | fail | `docker info` 의 `ServerVersion` |
| `docker_compose` | 2.20 이상 | fail | `docker compose version --short` — 이미지에 포함된 플러그인(실제 사용 대상) |
| `cpu` | 2 이상. 회의 구역을 선택한 경우 4 미만이면 warn(`cpu_below_recording` — 회의 녹화의 권장 사양 미달) | fail/warn | `docker info` 의 `NCPU` |
| `memory` | 4GB 이상, 선택한 구역의 권장 합계 이상 | fail | `docker info` 의 `MemTotal` |
| `arch` | `x86_64` | fail | `docker info` 의 `Architecture` |
| `disk` | 10GB 이상(20GB 미만은 warn) | fail/warn | 도커 데이터: 익명 볼륨을 마운트한 보조 컨테이너에서 여유 공간 측정(볼륨은 도커 데이터 폴더와 동일한 파일 시스템). 설치 폴더: 설치 관리자의 `/data` |
| `time_sync` | 커널 시계 동기화 | warn | `adjtimex()` — 커널 시계 상태는 컨테이너에서도 호스트의 값이 조회된다 |
| `port_80` · `port_443` | 미사용(본 소프트웨어의 컨테이너가 점유한 경우는 통과, 443 은 필요한 경우에만 검사) | fail | `--network host` 보조 컨테이너에서 직접 bind. 점유 주체는 `docker ps` 의 게시 포트로 판별한다 |
| `port_25` | 미사용 | warn | 동일한 방법 — 내장 메일 사용 시에만 해당 |
| `subnet` | 내부 대역이 기존 도커 네트워크·호스트 라우팅 테이블과 중복되지 않음 | fail | `docker network inspect` + `--network host` 보조 컨테이너의 `/proc/net/route` |
| `internet` · `registry` | 도달 가능 | warn | 설치 관리자 컨테이너에서 HTTPS 요청(오프라인 설치일 수 있으므로 경고로 한정) |
| `selinux` | (정보) | — | 보조 컨테이너의 `/sys/fs/selinux/enforce`, 없으면 `docker info` 의 `SecurityOptions` |

보조 컨테이너는 설치 관리자 **자신의 이미지**로 기동한다(`python -m app.helper …`) — 별도로 pull 할 이미지가 없다.

항목 형식: `{"id", "status": "pass|warn|fail", "value", "fix": {"key", "vars"} | null}`.

### 검증(probe)

- **공인 주소**: 서버의 아웃바운드 주소가 공인 주소이면 해당 주소를 사용한다. 그렇지 않으면 외부 서비스 4곳에 순차적으로 질의하고 **동일한 응답이 2건 이상**인 경우에만 채택한다. 그 외에는 `unknown` 으로 처리한다.
- **NFS**: ① 서버 도달 여부(TCP 2049) ② 마운트 가능 여부 ③ 쓰기·읽기·삭제(backend 가 사용하는 uid/gid `1000:1000` 으로) ④ 파일 잠금 ⑤ 여유 공간(10GB 미만은 warn). NFS 옵션의 임시 도커 볼륨을 생성해 보조 컨테이너에서 검사한 후 삭제한다. 실패 원인: `unreachable`(서버 도달 불가), `export_not_found`(도달하였으나 해당 경로를 마운트할 수 없음 — NFSv4 서버는 존재하지 않는 경로와 이 서버에 허용되지 않은 export 에 대해 동일하게 응답한다), `permission_denied`(uid 1000 의 쓰기 불가), `read_only`, `no_locking`. 옵션은 `rw,nfsvers=4.1,hard,noatime` 으로 고정한다. 볼륨은 `nocopy` 로 마운트해 export 루트의 소유자·권한을 변경하지 않는다 — 루트는 uid/gid `1000:1000` 이 쓸 수 있도록 저장소 측에서 사전에 설정해야 한다.
- **로컬 폴더**: `--mount type=bind` 로 마운트해 검사한다(`-v` 는 존재하지 않는 폴더를 생성한다). `ok`/`not_found`/`not_writable`.
- **DKIM**: 메일 레코드 화면에 표시해야 하므로 검증 시점에 키를 생성해 `/data/state/dkim/` 에 보관한다. 서버 구성에는 적용 시 반영된다.

## 8. 렌더링 — 입력값에서 생성되는 파일

`render(answers, secrets, facts, bundle)` 는 순수 함수다. 스택 폴더 기준 경로 → 내용의 대응이다.

| 파일 | 내용 |
|---|---|
| `docker-compose.yml`, `nginx/nginx.conf`, `nginx/security-headers.conf`, `init/init-db.sh`, `scripts/certbot-entrypoint.sh`, `mailserver/config/{user-patches.sh,auth-workspace.lua,dovecot.cf}`, `frontend-react/public/maintenance.html` | 번들의 파일을 **수정 없이** 사용 |
| `.env` (600) | 아래 표 |
| `docker-compose.site.yml` | 사이트별 오버라이드 — TLS 를 직접 종단하는 경우 nginx 의 `443:443`, 업로드한 인증서의 발급 CA 가 확인된 경우 코드 저장소·backend 컨테이너에 해당 CA 파일을 마운트하는 항목(§15의 "사설 CA") |
| `nginx/site.d/{http,listen-main,listen-rbi,headers}.conf` | 아래 "nginx" |
| `livekit/livekit.yaml` | 회의 구역이 활성화된 경우 |
| `mailserver/config/postfix-accounts.cf`, `dovecot-masters.cf`, `rspamd/…`, `user-patches.d/10-dkim.sh` | 내장 메일인 경우 |
| `nginx/private.d/.keep`, `plugins/.keep` | compose 가 폴더 단위로 마운트하는 위치 |

### nginx

리포의 `nginx/nginx.conf` 는 모든 설치에서 동일하다. 사이트별로 상이한 부분은 `nginx/site.d/` 의 4개 파일로 분리하였으며, `nginx.conf` 와 `security-headers.conf` 가 이를 include 한다. 리포에 포함된 기본 파일은 "프런트 프록시 하단, 80 평문" 구성이므로 **수동 구성 절차는 변경 없이 유지된다**(프록시 주소는 `nginx/site.d/http.conf` 에서 변경한다). 설치 관리자는 해당 4개 파일만 재생성한다.

| 경우 | `http.conf` | `listen-*.conf` | `headers.conf` |
|---|---|---|---|
| `direct`/`router` + `auto`/`upload` | 인증서 경로·TLS 설정 + 80 서버(인증서 검증 요청 처리, 그 외는 https 로 리다이렉트) | `listen 443 ssl` | HSTS |
| `direct`/`router` + `temporary` | 위와 동일 | `listen 443 ssl` | (없음 — 자체 서명 인증서에 HSTS 를 적용하면 브라우저 경고를 우회할 수 없다) |
| `proxy` | `set_real_ip_from <프록시 주소>` 지시문 | `listen 80` | (없음) |

### 인증서 배치

서비스별로 참조하는 폴더 이름이 상이하다. 인증서는 **1건**(필요한 이름을 모두 포함)을 발급받아 각 서비스의 참조 위치에 링크로 배치한다. 인증서 볼륨(`ws-certbot-data` = 컨테이너의 `/etc/letsencrypt`) 내부:

```
live/<접속 주소>/                 nginx · 무손실 음성 릴레이
live/mail.<메일 도메인>  → <접속 주소>     메일 서버
live/turn.<접속 주소>    → <접속 주소>     회의 서버(TURN/TLS)
jw/<접속 주소>/                   업로드한 파일·임시 인증서의 실제 파일(live/<접속 주소> 가 이 위치를 가리킨다)
```

- 인증서에 포함되는 이름: 접속 주소, `mail.<메일 도메인>`(내장 메일), `turn.<접속 주소>`(회의 중계), `rbi.<접속 주소>`(격리 브라우저).
- `auto`: nginx 가 아직 기동되지 않았으면 certbot 이 80 을 직접 수신하고(standalone), 이미 기동 중이면 webroot 방식으로 발급받는다. 갱신은 certbot 컨테이너(`ws-certbot`)가 12시간 주기로 수행한다(webroot). 갱신 컨테이너는 `zones` 단계에서 nginx 기동 후 기동하며, 설치 관리자가 기동 직후와 1시간 주기로 실행 여부를 확인하여 실행 중이 아니면 재기동한다. 기동 실패는 주의(`cert_renewal_not_started`)로 기록한다.
- 인증 기관의 ACME 디렉터리 주소는 설치 관리자의 환경변수 `JW_ACME_SERVER`(https 주소)로 변경할 수 있다. 미지정 시 Let's Encrypt 운영 서버를 사용한다. 갱신은 발급 시 기록된 주소를 사용한다.
- 무손실 음성 릴레이는 비루트(gid 65532)로 실행되므로 개인 키에 그룹 읽기 권한을 부여한다.
- **갱신 후 재적용**은 설치 관리자가 담당한다: 1시간마다(`JW_CERT_WATCH_SECONDS` 로 조정) 인증서 지문을 확인하고, 변경된 경우 권한을 재설정한 후 nginx 를 reload 하고 회의 서버를 재시작한다(메일 서버와 음성 릴레이는 자체적으로 다시 읽는다).
- 갱신 컨테이너는 갱신 시도마다 시각과 종료 코드를 인증서 볼륨의 `jw-renew-status.json` 에 기록한다. `GET /internal/cert` 의 `renewal` 과 `jw status` 가 이를 표시한다(15절).
- `proxy`: 웹 인증서는 프록시가 담당한다. 메일·회의 서버의 참조 위치에는 **자체 서명** 인증서를 배치한다(주의 `proxy_side_certs_self_signed`).

### 회의의 TURN/TLS 포트

회의 서버는 TURN/TLS 를 항상 `turns:<이름>:443` 으로 광고한다. 동일 서버에서 nginx 가 443 을 사용하면 충돌하므로, 직접 수신하는 구성(`direct`/`router`)에서는 TURN/TLS 를 호스트의 **5349** 에 게시한다(`LIVEKIT_TURN_TLS_PUBLISH=5349`). 이 경우 외부에서 `turn.<접속 주소>:443` 을 5349 로 전달하는 별도 장비가 없으면 TURN/TLS 는 사용되지 않으며, 회의는 UDP 3478(TURN)·UDP 7882-7892·TCP 7881 로 연결된다. `proxy` 구성에서는 이 서버의 443 이 미사용이므로 443 에 게시한다.

### 내부망 주소 배정

내부망(`just-workspace_workspace`, 기본 `172.28.0.0/24`)의 호스트 번호는 다음과 같이 배정한다.

| 구간 | 용도 |
|---|---|
| 2~99 | compose 서비스의 고정 주소(nginx = 2, certbot = 35 등 — `docker-compose.yml`) |
| 100~104 | 설치 관리자(100 을 사용하며, 점유된 경우 다음 번호) |
| 그 밖 | 미사용 |

- 도커는 주소를 지정하지 않은 컨테이너에 가장 낮은 빈 주소를 배정한다. 상주 컨테이너가 동적 주소를 받으면 아직 기동하지 않은 서비스의 고정 주소를 선점할 수 있으므로, 상주 서비스와 설치 관리자는 전부 주소를 지정한다.
- 설치 관리자는 `docker network connect --ip` 로 예약 주소에 연결한다. 동적 주소로 연결된 상태(1.0.0-beta.2 이하가 연결한 것 — 통상 3번)이면 기동 시 연결을 해제하고 예약 주소로 재연결한다. 네트워크는 재생성하지 않는다.
- 3번은 비워 둔다. 1.0.0-beta.2 이하에서는 certbot 의 고정 주소가 3번이었고 설치 관리자가 이를 동적으로 점유하여 갱신 컨테이너가 기동되지 않았다. 해당 버전에서 업데이트하는 경우 `switch` 단계를 이전 버전의 설치 관리자(3번 점유 상태)가 수행하므로, certbot 의 주소를 35번으로 변경하여 충돌을 제거하였다.
- 일회용 실행(`compose run` — DB 변경 단계, 복원, 인증서 발급)은 서비스의 고정 주소를 승계하지 않는다. 설치 관리자가 `networks: !override` 조각(`state/run/run-network-<서비스>.yml`)을 추가하여 실행하며, 일회용 컨테이너는 실행 동안에만 동적 주소를 사용한다.
- 이 네트워크에 다른 컨테이너를 직접 연결하는 경우 `--ip` 로 105번 이상의 주소를 지정한다.

### 저장소

compose 는 저장소 볼륨(`ws-storage-data`)을 `external` 로 사용한다. 설치 관리자가 해당 이름의 볼륨을 입력값에 따라 생성한다 — compose 파일은 변경되지 않는다.

| 입력값 | 볼륨 |
|---|---|
| `local` | 옵션 없는 도커 볼륨 |
| `local` + `path` | local 드라이버 `type=none,o=bind,device=<호스트 폴더>` |
| `nfs` | local 드라이버 `type=nfs,o=addr=<서버>,rw,nfsvers=4.1,hard,noatime,device=:<export 경로>` |

생성 후 저장소 루트에 **마커 파일** `.jw-storage`(설치 id 포함)를 기록한다. backend 는 `STORAGE_MARKER_REQUIRED=1` 인 경우 이 파일이 확인되지 않으면(또는 설치 id 가 불일치하면) 파일 쓰기 API(`/api/files…`, `/api/wopi/files…`)를 `503 storage_unavailable` 로 거부하고 관리자에게 통지한다 — 연결이 끊긴 저장소 마운트 지점의 빈 폴더에 기록되는 사고를 방지한다. NFS 서버가 응답하지 않는 경우(`hard` 마운트이므로 읽기가 대기 상태가 된다)는 3초 이내에 사유 `unresponsive` 로 거부한다. 동일한 이름의 볼륨이 다른 옵션으로 이미 존재하거나 마커가 다른 설치의 것이면 변경 없이 중단한다.

### `.env` 변수의 출처

"생성" = backend 의 비밀값 생성기, "입력" = 입력값을 그대로 사용, "파생" = 입력값·감지값에서 계산, "고정" = 설치 관리자가 지정한 값, "훅" = 구역 훅이 설정, "—" = 설치 관리자가 기록하지 않음(compose·backend 의 기본값).

| 변수 | 출처 | 값 |
|---|---|---|
| `DEPLOY_MODE` | 파생 | `proxy` → `external_proxy`, 그 밖 → `standalone` |
| `COMPOSE_PROFILES` | 파생 | 선택한 구역의 `compose_profiles` 합집합. 외부 메일이면 `mailserver` 제외, 무손실 오디오가 비활성이면 `audiorelay` 제외, `cert=auto` 이면 `certbot` 추가 |
| `JW_ZONES` | 파생 | `core,<구역들>` — 선두의 `core` 는 "빈 값 = 전체" 규칙을 회피하기 위해 항상 기재한다 |
| `STORAGE_VOLUME` | 고정 | `ws-storage-data` |
| `APP_NAME` | 고정 | `Workspace`(관리 화면에서 변경한다) |
| `APP_URL` | 파생 | `https://<접속 주소>` |
| `DOMAIN` | 파생 | 내장 메일이면 메일 도메인(계정의 메일 주소가 `<계정>@DOMAIN`), 그 외에는 접속 주소 |
| `DEBUG` | 고정 | `false` |
| `SECRET_KEY`, `INTERNAL_API_KEY`, `DB_PASSWORD` | 생성 | |
| `BACKEND_WORKERS` | 파생 | `min(8, max(2, CPU 수))`, 메모리 6GB 미만이면 2 |
| `BACKEND_CPUS`, `DATABASE_URL`, `DOMAIN_ALIAS`, `MCP_PUBLIC_URL` | 고정 | 빈 값 |
| `ALLOW_NATIVE_APP_ORIGINS`, `BRAND_*`, `OAUTH_DYNAMIC_CLIENTS_MAX`, `MCP_INTERNAL_TOOLS_ENABLED`, `MCP_API_KEY`, `GPU_HOST_IP`, `DESKTOP_*`, `RBI_ALLOW*`, `RBI_IMAGE`, `RBI_NETWORK`, `RBI_SUBNET`, `RBI_IP_RANGE`, `RBI_BRIDGE`, `RBI_MAX_SESSIONS`, `RBI_REQUIRE_GUARD`, `AUDIORELAY_WT_SELF_SIGNED_HOSTS`, `SANDBOX_*`·`DOCCONV_*` 상한 | — | |
| `DB_NAME`, `DB_USER` | 고정 | `workspace` |
| `FEATURE_BUILTIN_MAILSERVER` | 파생 | 메일 구역 + `builtin` 인 경우에만 `true` |
| `DOVECOT_MASTER_USER` / `…_PASSWORD` | 고정 / 생성 | 내장 메일인 경우 `portal` |
| `MAIL_SSL_TYPE` | 고정 | `letsencrypt`(= `live/mail.<도메인>/` 에서 읽는다) |
| `SMTP_HOST`·`PORT`·`USER`·`PASSWORD`·`FROM` | 파생/입력/생성 | 내장: `mailserver`·587·`noreply@<메일 도메인>`·생성. 외부: 입력값. 메일 구역이 없으면 빈 값 |
| `ADMIN_EMAILS` | 파생 | `<관리자 계정>@DOMAIN` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | 사용하지 않는다. 관리자는 `seed-admin` 으로 생성하며 비밀번호는 파일에 기록하지 않는다 |
| `GITEA_URL` / `GITEA_EXTERNAL_URL` | 고정 / 파생 | `http://gitea:3000` / `APP_URL/git/` |
| `GITEA_TOKEN`, `OAUTH_CLIENTS_JSON` | 훅 | 코드 저장소 구역 훅 |
| `GITEA_IMAGE` | 입력 | `git.version` |
| `GIT_SSH_PORT` / `GIT_SSH_DOMAIN` | 고정 / 파생 | 2222 / 접속 주소 |
| `LIVEKIT_API_KEY`·`SECRET`, `AUDIORELAY_SECRET`, `ONLYOFFICE_JWT_SECRET`, `SANDBOX_TOKEN`, `DOCCONV_TOKEN`, `SEARXNG_SECRET` | 생성 | 해당 구역이 활성화된 경우에만 기록한다 |
| `LIVEKIT_URL` | 고정 | `http://livekit:7880` |
| `LIVEKIT_TURN_TLS_PUBLISH` | 파생 | `proxy` → 443, 그 외 → 5349 |
| `EGRESS_CPUS` / `EGRESS_ROOM_CPU_COST` | 파생 | 회의 녹화 컨테이너의 CPU 상한 / 룸 합성 녹화 1건의 CPU 요구량. 코어 4개 이상이면 4 / 4, 미만이면 코어 수 / (코어 수 - 1, 최소 1). 상한이 코어 수를 초과하면 도커가 컨테이너 생성을 거부한다 |
| `ONLYOFFICE_ALLOW_UNTRUSTED_CERT` | 파생 | 문서 편집기가 접속 주소로 회귀 접속할 때의 인증서 검증 생략. 내장 nginx 가 임시 인증서 또는 발급 CA 가 확인된 사설 CA 인증서를 제공하는 구성에서만 `true` |
| `AUDIORELAY_WT_PUBLIC_URL` | 파생 | 무손실 오디오 + 신뢰되는 인증서인 경우 `https://<접속 주소>:4433/audiorelay/wt` |
| `AUDIORELAY_WT_PORT` / `…_CERT` / `…_KEY` | 고정 / 파생 | 4433 / `live/<접속 주소>/…` |
| `RBI_PUBLIC_ORIGIN` | 파생 | 격리 브라우저인 경우 `https://rbi.<접속 주소>` |
| `RBI_PUBLISH_IP` | 파생 | 내부 대역의 `.1` |
| `RBI_PROTECTED` | 감지 | 격리 브라우저인 경우 이 서버의 주소와 기본 게이트웨이(사전 점검이 감지한 값, 사설 주소만), 프런트 프록시의 내부 주소가 확인되면 해당 주소도 포함. 감지하지 못하면 빈 값 |
| `LDAP_PLAIN_BIND` | 고정 | `127.0.0.1` |
| `LETSENCRYPT_EMAIL` | 입력/파생 | `access.acme_email` 또는 `admin@DOMAIN` |
| `ACME_DOMAINS` | 파생 | 인증서에 포함될 이름(첫 번째 이름 = 접속 주소) |
| `RP_LAN_IP` / `HAIRPIN_HOST` | 파생 | 컨테이너가 접속 주소로 회귀 접속(hairpin)할 때의 우회 경로. 직접 수신하는 구성: 내장 nginx(`<내부 대역>.2`). `proxy`: 프록시 주소가 단일 주소이면 해당 주소, 그 외에는 비활성(`hairpin-off.invalid`) |
| `JW_NET_PREFIX` | 입력 | `advanced.subnet` 의 앞 세 옥텟 |
| `JW_REGISTRY` / `JW_VERSION` | 고정 | 설치 관리자의 `JW_REGISTRY` / 제품 버전(또는 `JW_IMAGE_TAG`) |
| `JW_APP_VERSION` | 고정 | 제품 버전(번들의 `VERSION`) — 화면에 표시되는 버전. 이미지에 빌드 시 포함된 값보다 우선한다 |
| `JW_SOURCE_URL` | 고정 | 설치 관리자에 지정한 `JW_SOURCE_URL`(http·https 주소인 경우에만), 없으면 저장된 값. **값이 없으면 해당 줄 자체를 기록하지 않는다** — backend 는 변수가 없는 경우와 빈 값인 경우 모두 원 리포의 주소를 사용한다. 화면의 "소스 코드" 링크에 해당한다. 한 번 지정한 값은 상태 폴더(`facts.json` 의 `source_url`)에 저장되어, 환경변수 없이 스택 파일을 재생성하는 경우(업데이트의 `switch` 단계 — 신규 이미지의 일회용 컨테이너, 설치 관리자를 다른 옵션으로 재기동한 후의 구역 작업)에도 유지된다. 이 저장 기능이 없던 버전에서 업데이트된 설치는 현재 `.env` 에 기록된 값을 승계한다. 원 리포로 복귀하려면 해당 주소를 직접 지정한다 |
| `COMPOSE_PROJECT_NAME` | 고정 | `just-workspace` |
| `STORAGE_MARKER_REQUIRED` / `JW_INSTALL_ID` | 고정 | `1` / 설치 id |
| `JW_INSTALLER_URL` / `JW_INSTALLER_KEY` | 고정 / 생성 | `http://jw-installer:8444` / 내부 API 키 |

값은 compose 의 dotenv 규칙에 따라 이스케이프한다: 안전한 문자만으로 구성된 값은 그대로, 그 외에는 작은따옴표(치환 없음), 작은따옴표가 포함된 값만 큰따옴표 + 역슬래시를 적용한다. 줄바꿈이 포함된 값은 허용하지 않는다.

## 9. 적용 단계

| 단계 | 수행 내용 | 대표 실패 원인 |
|---|---|---|
| `config` | 비밀값 생성(기존 값은 유지 — backend 이미지가 없으면 이 단계에서 pull 하며 진행을 `detail.images` 로 제공) → 스택 파일 기록 → `compose config -q` → 현재 구성에서 활성화되지 않는 서비스의 컨테이너와 잔존 일회용 컨테이너 삭제(실패 후 구역을 제외하고 재적용하는 경우 — 데이터 볼륨은 보존). 도커 볼륨 저장소인 경우 이 단계에서 볼륨·마커까지 생성 | `compose_invalid` |
| `storage` | (NFS·지정 폴더인 경우에만) 볼륨 생성 + 마커 기록 | `unreachable`, `export_not_found`, `permission_denied`, `read_only`, `storage_other_install`, `storage_volume_mismatch` |
| `pull` | `compose config --images` 의 이미지를 순차적으로 pull 한다(이미지별 진행률 제공). pull 에 실패하더라도 서버에 이미 존재하면 경고로 처리한다 | `image_pull_failed` |
| `database` | postgres·redis 기동, healthy 대기 → backend 이미지의 일회용 컨테이너로 `python -m app.cli migrate`(DB 스키마를 해당 버전에 맞춘다 — [data-safety.md](data-safety.md)). 종료 코드가 0 이 아니면 backend 를 기동하지 않고 중단한다 | `database_not_ready`, `database_migrate_failed` |
| `cert` | (프록시가 담당하고 별도로 필요한 이름도 없으면 생략) 발급·배치 | 자동 발급 실패(대안: 임시 인증서) — 발급 명령의 출력으로 분류: `cert_service_start_failed`(발급 컨테이너 기동 실패), `cert_acme_challenge_failed`(인증 기관의 검증 실패), `cert_rate_limited`(발급 한도 초과), `cert_dns_mismatch`(DNS 없음·불일치), 분류 불가 시 `cert_issue_failed`. 그 밖: `cert_invalid`, `cert_upload_missing` |
| `zones` | backend·frontend·nginx 기동 → 설치 관리자를 내부망에 연결 → (자동 발급이면) 갱신 컨테이너 기동 → 구역별 `install` → 구역별 `connect` → 연동 값이 변경되었으면 backend 재기동 → DB 에 저장되는 설정 반영 | `service_not_ready`, `git_*` |
| `admin` | `seed-admin`(비밀번호는 env 파일로 전달 후 삭제한다). 웹의 최초 관리자 생성(`POST /api/setup/admin`)은 설치 관리자가 구성한 설치(`JW_INSTALLER_KEY` 가 설정됨)에서 항상 차단되므로, `zones` 단계에서 backend 가 기동된 후 이 단계가 완료되기 전까지도 외부에서 관리자를 생성할 수 없다 | `admin_username_taken` |
| `lock` | 단계 `installed`, 토큰·세션 폐기 | |

- 시작 전에 입력값 검증과 사전 점검을 수행한다. 실패하면 단계 진입 없이 `failed`(`answers_invalid`, `preflight_failed`)로 처리한다.
- 단계는 멱등하다. `POST /api/apply/retry` 는 실패한 단계부터 재실행하며, 완료된 단계는 변경하지 않는다.
- 상태는 단계 전환 시마다 `/data/state/apply.json` 에 기록한다. 브라우저를 닫아도 계속 실행되며, 설치 관리자가 재시작되면 중단된 단계부터 재개한다(해당 단계에 `interrupted: true` 가 기록된다).
- `POST /api/apply`·`/retry` 는 응답 전에 상태를 `running` 으로 기록한다 — 202 수신 직후의 조회에서 이전의 `failed` 가 반환되지 않도록 하기 위함이다.
- 로그는 `/data/state/logs/<단계>.log` 에 기록된다. 식별된 비밀값은 `***` 로 마스킹한다.

## 10. 구역 훅 작성 방법

`installer/app/zones/<구역 id>.py` 에 필요한 함수만 정의한다. 정의하지 않은 함수에는 기본 동작이 적용된다.

```python
from app.engine import StepError
from app.zones import default_install, default_remove

def install(ctx, zone_id):      # 컨테이너 기동 및 초기 설정
    default_install(ctx, zone_id)

def connect(ctx, zone_id):      # 워크스페이스와 연동
    ctx.set_env(SOME_TOKEN="…")           # .env 에 기록할 값 — 완료 후 backend 가 1회 재기동된다

def remove(ctx, zone_id):       # 연동 해제 및 중지(데이터 볼륨은 유지)
    default_remove(ctx, zone_id)
```

- 기본 동작: `zones.json` 의 `services` 중 현재 프로파일에서 활성화되는 서비스를 `compose up -d` 하고 준비 상태가 될 때까지 대기한다. `remove` 는 `stop` + `rm -f`(볼륨 옵션 없음)를 수행한다.
- `ctx` 가 제공하는 항목: `zone_services()`, `up()`, `wait_ready()`, `stop()`, `docker.exec(container, argv, user=, env_file=, input=)`, `http.get(url, headers)`, `set_env()`, `secrets()`, `answers`, `plan`, `log()`, `warn(key, **vars)`, `redact(value)`.
- 실패는 `StepError(cause, fix, **vars)` 로 보고한다. 설치를 중단할 사유가 아니면 `ctx.warn()` 으로 기록하고 계속 진행한다.
- 반복 호출되어도 동일한 결과가 보장되어야 한다(멱등성). 명령은 인자 배열로만 구성하고, 비밀값은 `env_file`·`input` 으로 전달한다.

### 코드 저장소(Gitea)

| 순서 | 수행 내용 |
|---|---|
| 1 | 이미지: `GITEA_IMAGE`(렌더링이 `git.version` 에서 결정한다) |
| 2 | 컨테이너 기동, `/api/healthz` 대기 |
| 3 | `environment-to-ini` 로 `app.ini` 의 DB 를 워크스페이스의 PostgreSQL(`gitea` 데이터베이스)로 설정하고 재시작 |
| 4 | 관리 계정 `jw-admin`(무작위 비밀번호 — backend 전용) |
| 5 | 관리 토큰 발급 → `GITEA_TOKEN`(backend 는 이 토큰 + `Sudo` 헤더로 사용자 권한을 대행한다). 유효한 토큰이 존재하면 재발급하지 않는다 |
| 6 | 워크스페이스 OAuth 클라이언트 `gitea` → `OAUTH_CLIENTS_JSON`(리다이렉트 `APP_URL/git/user/oauth2/workspace/callback`) |
| 7 | Gitea 의 인증 소스 `workspace`(OpenID Connect, `APP_URL/oauth/.well-known/openid-configuration`) |
| 8 | 프런트 경로 `/git/` 검증 |

7번은 Gitea 가 접속 주소로 회귀 접속해 구성 문서(discovery)를 읽으므로 **신뢰되는 인증서**가 필요하다. 임시 인증서에서는 실패하며, 설치는 주의(`git_sso_pending`)를 기록하고 계속 진행한다 — 해당 구역은 "연결 보류"로 기록되고(`state/pending.json`), 인증서를 교체하면 재시도한다(§15). 인증 소스가 이미 존재하면 현재 주소로 갱신한다(`update-oauth` — 서버 이전으로 접속 주소가 변경된 경우). 비활성화 시에는 인증 소스를 삭제하고 토큰·클라이언트를 설정에서 제거한 후 컨테이너를 중지한다. 데이터 볼륨(`ws-gitea-data`)은 유지된다.

## 11. 테스트

```bash
cd installer
python -m venv <리포 외부 폴더>/venv && <해당 venv>/bin/pip install -r requirements-dev.txt
<해당 venv>/bin/python -m pytest -q
```

docker 없이 실행된다. docker·DNS·HTTP·SMTP 는 모의 객체(fake)로 대체한다(`tests/fakes.py`, `tests/harness.py`). 렌더링 스냅샷은 `tests/snapshots/` 에 있으며, 의도한 변경인 경우 `JW_UPDATE_SNAPSHOTS=1` 로 재생성한다.

## 12. 알려진 제한 사항

- **backend 측 호출부**는 `backend/app/system/` 이다. 관리자 권한을 검증하고 내부 API 를 대행 호출하며(`/api/admin/system/zones…`, `/jobs/<id>`, `/probe/…`), 활성화·비활성화·설정 변경을 감사 로그에 기록한다. 화면은 관리 › 구역(`/admin/zones`)이다. `JW_INSTALLER_URL`·`JW_INSTALLER_KEY` 가 비어 있으면(설치 관리자 없이 구성한 설치) 목록은 읽기 전용이며 그 외 요청은 `503 installer_unavailable` 을 반환한다.
- **코드 저장소의 로그인 연동**(Gitea 의 OpenID Connect 인증 소스)은 접속 주소의 인증서를 **Gitea 컨테이너가** 신뢰할 수 있어야 등록된다. 임시 인증서로 설치하면 "연결 보류" 상태로 유지되며, 신뢰되는 인증서로 교체하면(§15) 재시도한다. 공개 CA 가 아닌 **사설 CA** 가 발급한 인증서는 **발급 CA 가 제공된 경우에만** 연동된다 — 인증서 파일에 체인으로 포함하거나, "CA 인증서(선택)" 항목에 별도로 업로드하거나, 이후에 CA 인증서만 업로드한다(§15의 "사설 CA"). 서버 인증서 1장만 업로드하면 신뢰 대상 CA 를 식별할 수 없어 보류 상태로 유지되며, 화면에 해당 사실과 조치 사항이 표시된다. 해당 CA 를 신뢰하게 되는 대상은 코드 저장소와 backend 컨테이너다 — **문서 편집기**(접속 주소로 회귀 접속해 문서를 읽고 쓴다)의 사설 CA·임시 인증서 환경 동작은 검증되지 않았다.
- **인증서 자동 발급(Let's Encrypt)의 실제 발급**은 외부에서 80 포트로 도달 가능한 서버에서만 가능하다. 발급 실패 시의 처리 흐름(실패 → 임시 인증서로 계속)만 실서버에서 검증하였다.
- **TURN/TLS**: 직접 수신하는 구성에서는 5349 에 게시되므로, 443 을 전달하는 장비가 없으면 사용되지 않는다(§8).
- **프런트 프록시 구성**: 프록시는 클라이언트 주소를 `X-Real-IP` 로 전달해야 한다(`X-Forwarded-For` 만으로는 클라이언트 주소로 인정하지 않는다). 메일·회의 인증서는 자체 서명이다 — 신뢰되는 인증서가 필요한 경우 현재는 수동으로 배치해야 한다.
- **메일 도메인과 접속 주소가 상이한 경우** `DOMAIN` 은 메일 도메인이 된다. backend 가 `DOMAIN` 을 표시 용도로도 사용하는 위치(메일 제목 접두어 등)에는 메일 도메인이 표시된다.
- **외부 SMTP 의 보안 방식**과 **AI 제공자**는 DB 설정이므로 backend 기동 후 `python -m app.cli configure` 로 반영한다. 실패하면 주의(`backend_settings_not_applied`)만 기록된다.
- **NFS** 는 v4.1 만 지원한다(잠금이 프로토콜에 포함된 버전). v3 만 지원하는 서버는 마운트할 수 없다. `hard` 로 마운트하므로 서버 연결이 끊긴 동안 저장소를 **읽는** 요청(파일 목록·다운로드)은 복구 시까지 대기한다 — 쓰기만 503 으로 즉시 거부한다. 단절을 감지하기 전(마커 확인 결과를 5초간 재사용한다)에 시작된 쓰기도 서버 복구 시까지 대기한 후 완료된다.
- **저장소 마커**는 `/api/files`·`/api/wopi/files` 의 쓰기만 차단한다. 채팅 첨부·메일 보관 등 다른 경로로 저장소에 기록하는 기능은 현재 차단하지 않는다.
- **pull 대상 이미지의 용량**은 제공하지 않는다(레지스트리에 질의하지 않는다) — 요약의 해당 항목은 표시되지 않는다.
- **인증서 방식 변경**은 임시 → 자동·업로드, 자동 → 업로드만 지원한다(§15). 프런트 프록시가 담당하는 설치의 메일·회의용 인증서는 계속 자체 서명이다.
- **복원 시 파일 저장소의 이중 읽기**: 데이터 복원(backend CLI)은 백업 아카이브를 작업 폴더(백업 볼륨)에 전체 추출한 후 적재한다 — 백업 크기만큼의 여유 공간이 도커 데이터 폴더에 추가로 필요하다. 업로드한 백업은 설치 폴더에 사본이 1부 더 생성된다(완료 후 삭제한다). 대용량 백업은 서버로 먼저 전송한 후 경로를 지정하는 방식을 권장한다.
- **복원 시 재지정하지 않는 항목**: 지정 폴더 저장소(화면은 도커 볼륨·NFS 만 제시한다 — 응답 파일로는 `storage.path` 를 지정할 수 있다), 인증서 업로드(화면에서는 자동·임시만 제공 — 복원 후 관리 화면에서 업로드한다).
- **업데이트**: 플러그인 호환 판정 및 호환이 확인되지 않은 플러그인의 비활성화 동작은 미구현이다(manifest 의 `plugin_api` 는 예약 필드다). 사전 공지 시간(5분)은 고정이며, 업로드가 중단된 오프라인 번들의 업로드 재개(resume)는 지원하지 않는다 — 16절.

### 주의(`cautions`)의 키

요약(`GET /api/summary`)과 구역 검사(`POST /internal/zones/<id>/check`)는 동일한 키를 사용한다. 문구는 화면 측에서 관리한다(마법사: `frontend-react/src/installer-app/i18n/*.json` 의 `summary.caution.<키>`).

| 키 | 값(`vars`) | 의미 |
|---|---|---|
| `cert_temporary` | `domain` | 임시(자체 서명) 인증서로 설치한다 |
| `git_sso_needs_trusted_cert` | | 임시 인증서로는 코드 저장소의 로그인 연동이 등록되지 않는다 |
| `router_port_forward` | `ports` | 공유기에서 해당 포트를 이 서버로 포워딩해야 한다 |
| `proxy_side_certs_self_signed` | `names` | 프록시를 경유하지 않는 이름(메일·회의)에는 자체 서명 인증서를 사용한다 |
| `hairpin_not_configured` | `domain` | 프록시 주소가 단일 주소로 특정되지 않아 컨테이너가 접속 주소로 회귀 접속할 경로가 없다(문서 편집·코드 저장소 연동) |
| `turn_tls_alternate_port` | `port` | 회의 중계의 보안 연결은 해당 포트(5349)로 제공된다 |
| `mail_needs_dns_and_port25` | `mail_domain` | 내장 메일의 수신에는 메일 레코드와 외부로부터의 25 포트 인바운드가 필요하다 |
| `account_domain_is_mail_domain` | `mail_domain` | 계정의 메일 주소는 `<아이디>@<메일 도메인>` 이 된다 |
| `no_system_mail` | | 메일 구역이 없어 초대·비밀번호 재설정 메일을 발송할 수 없다 |
| `meetings_public_ip_unknown` | | 회의에 사용할 공인 주소가 확인되지 않는다 |
| `meetings_recording_low_cpu` | `cpus`, `recommend` | 코어 수가 회의 녹화의 권장 수(4) 미만이다 — 녹화가 지연되거나 거절될 수 있다 |
| `lossless_needs_udp_4433` | | 무손실 오디오는 UDP 4433 이 외부에서 도달 가능해야 한다 |
| `rbi_needs_dns` | `name` | 격리 브라우저의 전용 이름도 이 서버를 가리켜야 한다 |
| `dns_mismatch_cert_will_fail` | `domain` | 접속 주소가 이 서버를 가리키지 않아 자동 발급이 실패한다 |

적용·구역 작업이 기록하는 주의(`warnings`): `git_sso_pending`, `git_front_path_unverified`, `side_certs_self_signed`, `image_not_refreshed`, `installer_not_on_network`, `backend_settings_not_applied`. 복원이 기록하는 주의: `restore_dkim_regenerated`(백업에 메일 서명 키가 없어 신규 생성함), `restore_front_unverified`, `restore_users_mismatch`, `restore_check_skipped`.

## 13. 실서버 검수

단위 테스트는 docker 를 모의 객체로 대체한다. 실제 docker 환경에서의 전 과정 동작은 `installer/e2e/` 의 시나리오로 검증한다 — 검수 **전용** 서버에서만 실행한다(컨테이너·볼륨·설치 폴더를 삭제하며, NFS 시나리오는 호스트에 NFS 서버 패키지를 설치한다).

```bash
installer/e2e/remote.sh <ssh 대상> push                 # 커밋된 상태를 서버에 전송한다
installer/e2e/remote.sh <ssh 대상> build                # 서버에서 이미지를 소스로 빌드(localhost/just-workspace-<이름>:<VERSION>)
installer/e2e/remote.sh <ssh 대상> run s1-minimal api   # 시나리오 하나
installer/e2e/remote.sh <ssh 대상> run s9-operate       # 설치 후의 jw 명령(복원·채널 키)과 사설 CA 인증서
installer/e2e/remote.sh <ssh 대상> run s10-rbi          # 격리 브라우저 + 회의(설치와 대상 웹 서버를 유지한다) → 아래 두 화면 검수 → run s10-rbi post → run s10-rbi down
node installer/e2e/rbi-session-ui.cjs --url https://<접속 주소> --addr <서버 주소> --password-file <파일>     # 세션 화면(미러·픽셀)
node installer/e2e/meeting-noise-ui.cjs --url https://<접속 주소> --addr <서버 주소> --password-file <파일>   # 노이즈 제거 토글
# 화면 조작 방식(Playwright — 로컬 PC 에서 실행):
node installer/e2e/wizard-ui.cjs --url https://<서버 주소>:8443 --token <설치 토큰> [--flow quick] [--width 390]
node installer/e2e/admin-zones-ui.cjs --url https://<접속 주소> --addr <서버 주소> --password-file <파일>
installer/e2e/remote.sh <ssh 대상> run u-update setup u9 u1 u7 u2 u3     # 업데이트(모의 릴리스 환경 — 16절). 후속 단계: r103 u5 u4 u6 u8
node installer/e2e/admin-update-ui.cjs --url https://<접속 주소> --addr <서버 주소> --password-file <파일>
```

요구 사항: 리눅스 x86_64, Docker Engine 24+, compose 플러그인 2.20+, 4코어·메모리 12GB·디스크 40GB 이상, 인터넷 아웃바운드 연결(인바운드 경로는 불필요). 접속 주소는 DNS 에 등록되지 않은 이름을 사용하고 서버 주소로 직접 접속한다.

| 시나리오 | 실서버 검증 내용 |
|---|---|
| `s1-minimal` (응답 파일 · API) | 최소 프리셋 설치 완료, 컨테이너 준비, 프런트·`/api/health`, 관리자 로그인, 파일 업로드·다운로드, 잠금(423), 관리자가 0명인 경우와 존재하는 경우 모두 웹의 최초 관리자 API 가 차단됨(403 `setup_closed`), 설치 관리자 재시작 후 상태 유지, `jw status`·`jw reset-admin` |
| `s2-collab` (응답 파일 · API) | 내장 메일(IMAP 993 로그인, 내부 발송·수신, DKIM 서명 — 사전 생성한 키와 서버의 키가 일치), 문서 편집기 discovery, 채팅 웹소켓, 일정 생성, 요약의 포트 = 실제 게시 포트(143 은 개방되지 않음) |
| `s3-full-sso` (응답 파일 · API) | 전체 프리셋 + SSO·LDAP 가 12GB 에서 기동(유휴 시 실측 약 1.9GB). 회의 토큰 발급·UDP 게시, Gitea 구역 훅(고정 이미지, PostgreSQL 연결, 관리 계정, 토큰의 backend 주입, OAuth 클라이언트, `/git/`·`/api/git/repos`), LDAPS 636·평문 389 는 루프백 한정. 인증 소스 등록은 임시 인증서이므로 보류됨(주의) — 명령 자체는 내부 주소로 시험 등록해 검증 |
| `s4-nfs` | 검증 5개 항목 통과, 실패 분류(`unreachable`·`export_not_found`·`permission_denied`·`read_only`), 검증이 export 루트의 소유자를 변경하지 않음, root squash 가 적용된 export 에 설치, 마커·업로드가 NFS 에 기록됨, 서버 중지 시 쓰기 503(`storage_unavailable`, 3초 이내)·다른 API 는 정상, 재기동 시 복구. `no_locking` 은 재현하지 못하였다(NFSv4.1 은 잠금을 비활성화할 수 없다) |
| `s5-proxy` | 80 평문만 제공(443 미게시, HSTS 없음), 프록시 주소에서 수신한 `X-Real-IP` 만 클라이언트 주소로 인정하고 다른 출발지의 헤더는 무시, backend 의 세션 기록에도 해당 주소가 기록됨 |
| `s6-zone-toggle` | 내부 API 로 채팅 → 문서 → 코드 저장소 활성화, 문서·코드 저장소 비활성화. `.env` 의 `JW_ZONES`·`COMPOSE_PROFILES`, `/api/health` 의 zones, 비활성화한 구역의 볼륨 유지. 8443·호스트에서는 내부 API 에 접근 불가, 잘못된 키·내부 대역 외부는 404 |
| `s7-failure-retry` | 토큰(불일치·재발급·만료·5회 잠금), 존재하지 않는 이미지 → `pull` 실패·원인 키 → 수정 후 해당 단계부터 재개, 적용 도중 설치 관리자 재시작 → 재개 후 완료, 인증서 자동 발급 실패 → 임시 인증서로 계속 |
| `s8-manual` | 설치 관리자 없이 [deployment.md](deployment.md) 의 절차에 따라 최소 구성 기동, 설정 토큰으로 최초 관리자 생성(로그의 토큰은 1개, 토큰 없이 또는 이전 토큰으로는 403, 11자 비밀번호 400, 생성 후 폐기), `scripts/update.sh --no-pull` 로 재빌드 후 교체 및 `--rollback`(업데이트 전에 부여한 태그의 이미지로 이름을 복원한다) |
| `s9-operate` | 기본 + 코드 저장소 구성에서: 버전 환경변수 없이 기동한 경우의 로그 고지, `jw update-key`(이미지에 포함된 공개 키를 사용하지 않도록 기동해 "키가 없는 설치"에서 검증 — 비공개 키·무관한 파일 거부, 등록하면 확인 결과가 `unconfigured` → 채널 조회로 전환)·`jw update-channel`, `jw restore`(목록, `--yes` 없이는 내용만 출력, 백업 볼륨의 이름·서버 경로, 복원 후 백업 시점의 파일만 존재하고 쓰기 가능, 존재하지 않는 파일·잘못된 경로 거부), 사설 CA 인증서 — 서버 인증서만 업로드하면 코드 저장소 연동이 보류 상태로 유지되고 backend 도 해당 인증서를 신뢰하지 못함 → **CA 인증서만 이후에 업로드하면**(무관한 CA·서버 인증서는 거부) 두 컨테이너에 CA 가 마운트되고 인증 소스가 등록되며 backend 가 접속 주소의 인증서를 신뢰함(공개 CA 번들은 유지) → 제거하면 다시 신뢰하지 못함 → 인증서와 CA 를 두 항목으로 분리해 업로드 → 인증서 파일에 CA 를 체인으로 포함해 업로드(CA 는 1회만 포함됨) |
| `s10-rbi` + `rbi-session-ui.cjs` | 기본 + 회의 + 격리 브라우저 구성에서: `.env`·backend 의 `RBI_PROTECTED` = 이 서버의 주소·기본 게이트웨이, 서버 자신을 가리키는 대상은 강제 옵션 없이 거부, 다른 호스트(별도로 생성한 네트워크 네임스페이스의 웹 서버)를 가리키는 대상 저장. 화면: 전용 출처로 로그인 홉 → **미러 방식** 세션의 화면에 대상 페이지의 텍스트와 색상이 렌더링됨(미러 문서의 텍스트를 읽고, 캡처에서 대상의 색상 비율을 측정한다) → **픽셀 방식** 세션(외부 세션 이미지)의 화면에 대상 페이지가 렌더링됨(캡처의 색상 비율 — 캡처는 담당자가 1회 육안으로 확인하였다) → 종료한 세션의 화면 경로 403. 이후(`s10-rbi.sh post`): 격리 규칙 상태·출구 규칙에 대상이 포함됨·세션 컨테이너가 잔존하지 않음·호스트 INPUT 의 세션 브리지 차단 |
| `s11-acme-local` | 임시 인증서로 설치한 서버에서 ACME 시험 서버(Pebble, 내부망에 기동)를 인증 기관으로 지정해: [다시 발급](auto) 작업 성공, nginx 가 신규 인증서 제공, 갱신 컨테이너가 고정 주소(35번)로 실행, `certbot renew --dry-run`, 강제 갱신 후 설치 관리자가 지문 변경을 감지해 nginx 를 reload, 인증서 상태·`jw status` 의 갱신 정보, 중지된 갱신 컨테이너의 재기동 |
| `s12-low-cpu` | 코어 4개 미만 서버에서 회의 구역 포함 설치: 사전 점검의 `cpu` 경고(`cpu_below_recording`)·요약의 주의, `EGRESS_CPUS` = 코어 수, 녹화 컨테이너의 CPU 상한과 기동 유지, 회의 토큰 발급 |
| `u-from-public` | 공개된 이전 버전(기본 1.0.0-beta.2)의 이미지로 자동 발급 구성을 설치한 뒤 현재 소스의 빌드로 업데이트: 네트워크 미재생성(id 동일), 설치 관리자가 예약 주소(100번)로 재연결, 갱신 컨테이너가 35번으로 실행, 주소 중복 없음, 데이터 보존, 실행 중인 backend 와 일회용 실행의 공존, 도커 재시작 후 주소 유지 |
| `meeting-noise-ui.cjs` | 가상 마이크를 사용하는 Chromium 으로 회의에 참가해: "노이즈 제거" 토글을 전환할 때마다 **송신 중인 마이크 트랙**의 `getSettings().noiseSuppression` 이 변경됨(Chromium 은 즉시 변경할 수 없어 트랙을 재획득한다 — 트랙 id 가 변경된다), 반향 제거는 유지, 마이크를 껐다 켜도 선택한 값 유지, 마이크가 꺼지면 토글 잠금 |
| `wizard-ui.cjs` | 화면 조작으로 일반 설치(협업 프리셋·임시 인증서)와 빠른 설치를 완료 화면까지 수행 — 1280 폭과 390 폭. 토큰이 없는 주소·잘못된 토큰, 사전 점검 14항목, 구역·메모리 합계, 메일 레코드 표, 이어 하기, 요약, 적용, 잠금 화면. 콘솔 오류 없음 |
| `jw reinstall` | 설치된 서버에서 목록 확인 → `--yes` 로 삭제 후 신규 토큰으로 재시작 |
| `restore` + `restore-ui.cjs` | 서버 이전: 협업 프리셋에 계정 2·파일·채팅·메일·일정·암호화된 값을 입력하고 전체 백업 → 서버를 체크포인트로 복원한 후 화면에서 업로드해 복원 → 기존 계정 로그인, 파일 해시, 채팅·메일·일정, DKIM 키, 암호화 값 복호, 설치 id, 잠금. 서버 경로 + 응답 파일(무인, 접속 주소 변경). 거부 경로(형식 불일치·손상·전송 중단·암호 없음/불일치/일치·상위 버전). 데이터 복원 중 DB 중지 → 실패 → 재시도로 완료. NFS: 로컬 선택·빈 공유·다른 설치의 공유 거부, 동일 공유 재연결 후 파일 유지 |
| `admin-cert-ui.cjs` | 관리 › 보안의 인증서 카드(임시 인증서 경고 → 사설 CA 인증서 업로드 → nginx 가 신규 인증서를 제공 → 서버 인증서 1장만 업로드한 경우의 보류 안내 → "CA 인증서 올리기" 창에서 무관한 파일 거부 → CA 인증서만 업로드해 연동이 완료되고 안내가 해제됨), 관리 › 구역의 연결 보류·다시 연결, 관리 › 저장소의 상태 카드(설치 관리자 값, NFS 서버를 중지한 경우의 카드·알림 배너·파일 탭 안내와 복구) |

업데이트(`scenarios/u-update.sh` — 서버 내부의 모의 릴리스 환경에서, 릴리스 도구로 생성한 릴리스를 사용):

| 단계 | 실서버 검증 내용 |
|---|---|
| `setup` | 릴리스 도구로 1.0.0 과 1.0.1-beta.1 을 릴리스하고(이미지 push → `make-manifest --resolve-sizes --db-schema` → `publish` → `verify`) Beta 를 Stable 로 승격. 검수 채널은 임시 키로 서명한다 — 설치 폴더에 해당 공개 키를 등록하기 전에는 이미지에 포함된 키로 서명이 검증되지 않아 `channel_invalid`(이미지에 키가 없으면 `unconfigured`), 등록하면 확인이 성공하며, Beta 릴리스는 stable 채널에 노출되지 않다가 승격 후 노출된다 |
| `u9` | 변조한 채널 파일·다른 키로 서명한 채널·만료된 채널·순번이 역행한 채널·변조한 manifest·도달 불가한 채널을 각각 거부하며, 마지막으로 성공한 결과는 유지한다 |
| `u1` | 수동 업데이트 1.0.0 → 1.0.1(승격한 릴리스): 사전 공지(backend 의 공지 조회·공개 점검 상태에 반영)와 취소, "지금 바로 시작", 점검 모드(일반 API 503 + `Retry-After`, 진행 조회·로그인은 통과), 6개 단계, 설치 관리자 자기 교체(신규 이미지·동일 이름·8443 응답·이전 컨테이너 없음), `/api/health` 의 버전·스키마, 검수용 변경 단계 적용, 사전 입력한 데이터(계정·파일·대화·메일) 보존, 기록·기록 다운로드·복원 지점. 프런트가 없는 경우의 정적 점검 페이지, `/maintenance/status` 는 GET 만 허용, 내부 API 는 외부에서 접근 불가 |
| `u7` | 복원 지점으로 수동 복원(1.0.1 → 1.0.0): 5개 단계, DB 복원(검수용 테이블이 제거됨), 설치 관리자도 이전 이미지·이전 환경으로 복원, 데이터 보존, 재업데이트 가능 |
| `u2` | 레지스트리에서 이미지를 삭제해 `pull` 실패 → `failed` + `retry`·`rollback` → 롤백(변경 사항이 없어 3개 단계 생략) / 이미지를 복구한 후 재시도 → 완료 |
| `u3` | 두 번째 변경 단계가 실패하는 릴리스: `migrate` 실패 → 선택 절차 없이 롤백 → 이전 버전, DB 스키마 버전 원복(선행 적용된 단계의 흔적도 없음), 데이터 보존 |
| `admin-update-ui.cjs` | 화면 조작으로 1회(1.0.1 → 1.0.3): 현황의 신규 버전 → 내용 보기 → 업데이트 시작 → 일반 사용자 창의 사전 공지 배너 → "지금 바로 시작" → 진행 화면의 단계와 "다시 연결 중" → 일반 사용자 창의 점검 화면과 복귀 → 완료 → 기록. 콘솔 오류 없음 |
| `u5` | 중간 버전 1.0.0 → 1.0.1 → 1.0.3 을 단일 작업으로 수행: 버전별 백업·자기 교체·기록 |
| `u4` | 자동: 공개 후 3일 미만이면 허용 시간대 내에서도 시작하지 않음, 3일 경과 후에도 허용 시간대 외에는 시작하지 않음, 두 조건을 모두 충족하면 5분 사전 공지 후 시작, `pull` 실패도 선택 절차 없이 롤백 후 정지(관리자 통지), 정지 상태에서는 재시도하지 않음, 다시 활성화하면 다음 확인 시 적용 |
| `u6` | Beta 채널로 업데이트(시험판 이전 백업을 별도 보관) → Stable 로 전환: 대기(`wait`, 적용 거부) / "시험판 이전 상태로 복원"(그 사이에 작성된 대화는 소실되고 채널은 stable) |
| `u8` | 레지스트리·채널을 차단한 상태에서: 하위 버전·다른 키·존재하지 않는 파일·1바이트를 변조한 번들을 각각 거부, 오프라인 번들 업로드(nginx → backend → 설치 관리자), 추가 이미지 판정(없음·불일치·있음·불필요), 오프라인 번들과 이미지 파일만으로 적용 |

업데이트에서 검증하지 못한 항목: 실제 배포 채널·실제 서명 키, 인터넷 경유 레지스트리에서의 pull 소요 시간(검수 서버에는 이미지 레이어가 대부분 이미 존재하였다), 수 GB 규모 오프라인 번들의 프런트 프록시 경유 업로드, 플러그인 호환 판정, 설치 관리자를 `docker run` 의 다른 옵션(자원 제한 등)과 함께 기동한 경우의 자기 교체.

모든 시나리오의 기본 구성 확인(`check_core`)은 내부망 주소도 확인한다: 설치 관리자 = 예약 주소(100번), nginx = 2번, 연결된 컨테이너 간 주소 중복 없음.

검증하지 못한 항목: 공개 CA 인증서 환경의 Gitea 로그인 연동(사설 CA 는 발급 CA 를 제공해 연동되는 것까지 검증 — `s9-operate`), 사설 CA·임시 인증서 환경의 문서 편집기(편집기가 접속 주소로 회귀 접속해 문서를 읽는 경로 — 발급 CA 를 편집기 컨테이너에는 마운트하지 않는다), 로컬 백업을 NFS 로 이전하는 복원, 수 GB 이상의 백업 업로드, 격리 브라우저의 입력(키보드·한글·클립보드)·다운로드·업로드와 유휴 종료·다중 사용자의 동시 세션(세션 화면에 대상이 렌더링되는 것은 미러·픽셀 방식 모두 검증하였다 — `s10-rbi`), 격리 브라우저의 실제 LAN 대상(검수의 대상은 동일 서버의 다른 네트워크 네임스페이스다), 노이즈 제거의 실제 음질(토글이 트랙의 설정을 변경하는 것까지 검증하였다. Chromium 이외의 브라우저는 검증하지 않았다), 무손실 오디오, 외부 SMTP·AI 제공자 연결, 지정 폴더 저장소, 공유기 하단·실제 프런트 프록시, x86_64 이외의 서버, SELinux 가 활성화된 배포판.

## 14. 백업에서 복원

다른 서버에서 생성한 백업(`.jwbak` 또는 백업 폴더 — [data-safety.md](data-safety.md))으로 이 서버에 동일한 환경을 이전한다. 마법사의 시작 방식 "백업에서 복원" 또는 응답 파일의 `"mode": "restore"` 로 수행한다. 코드는 `installer/app/restore.py`(흐름·단계), `restore_config.py`(설정 병합), `api_restore.py`(경로)다.

설치 관리자는 백업을 직접 열지 않는다. backend 이미지의 일회용 컨테이너에 **읽기 전용으로 마운트해** `python -m app.cli backup inspect|verify|extract-config` 와 `restore` 를 호출한다 — 형식의 단일 출처는 backend 다. 이미지가 아직 없으면 해당 이미지 하나만 먼저 pull 한다.

### 백업 지정 방식

| 방식 | 처리 |
|---|---|
| 업로드 | 브라우저가 전송한 본문을 `/data/state/restore/upload/backup.jwbak` 에 스트리밍으로 기록한다(메모리·임시 파일에 버퍼링하지 않는다). 시작 시 `Content-Length` 와 여유 공간을 비교하며, 업로드가 중단되면 불완전한 파일을 삭제한다. 업로드 재개는 지원하지 않는다 |
| 서버 경로 | 호스트의 절대 경로를 입력받는다(설치 폴더 하위 여부 무관). 복사하지 않고 해당 경로를 일회용 컨테이너에 `--mount type=bind,…,readonly` 로 마운트해 읽는다. 경로 검증은 저장 폴더와 동일하다(절대 경로, `..`·셸 문자·시스템 폴더 거부) |

검증은 3단계다: 형식(`inspect`) → 무결성(`verify` — 전체 파일의 크기·SHA-256) → 설정 추출(`extract-config` → `/data/state/restore/config/`, 600). 결과(`status`):

| `status` | 의미 |
|---|---|
| `ok` | 복원 가능 |
| `invalid` | `reason`: `not_a_backup`(백업 파일이 아님) · `format_unsupported`(지원하지 않는 형식 버전) · `no_config`(설정 항목이 없어 신규 서버로 이전할 수 없음) · `path_invalid` |
| `corrupt` | 전송 중 손상(해시 불일치·전송 중단) |
| `password_required` · `password_wrong` | 설정이 암호로 보호된 백업 — 암호는 `/data/state/restore/password`(600)에 보관하고 파일로 전달한다(명령 인자·환경변수에 포함하지 않는다) |
| `not_found` | 해당 경로에 파일이 없음 |
| `none` | 지정된 백업이 없음 |

`state` 값은 `none`·`uploading`·`checking`·`ready`·`failed` 다.

### API (8443, 세션 필요)

| 메서드·경로 | 기능 |
|---|---|
| `POST /api/restore/upload` (multipart `file`) | 업로드 및 검증 완료 후 응답한다(대용량 파일은 수 분 소요). `507 no_space`, `409 apply_running`, `400 upload_invalid` |
| `POST /api/restore/path` `{"path"}` | 서버에 있는 백업 지정 |
| `POST /api/restore/password` `{"password"}` | 암호 입력 후 재검증(해시는 재계산하지 않는다) |
| `GET` · `DELETE /api/restore/file` | 지정된 백업의 상태 조회 · 폐기(서버 경로의 원본은 변경하지 않는다) |
| `GET /api/restore/review` | 내용 검토(아래). 준비된 백업이 없으면 `409 restore_no_backup` |
| `POST /api/restore/apply` `{"domain", "storage", "network"?, "proxy_addresses"?, "cert"?, "subnet"?}` | 복원 시작(202). 오류가 있으면 `422 restore_invalid` + `vars.errors` |
| `GET /api/restore/apply` · `/apply/stream` · `POST /api/restore/apply/retry` | 진행·재시도 — 설치 적용과 동일한 엔진·동일한 형식. 로그는 `GET /api/apply/log?step=` |

`review`: `source_url`·`created_at`(생성 서버·시각), `backup_version`·`schema_version` 과 `installer_version`·`installer_schema_version`, `version_status`(`ok`/`newer`)·`version_reason`(`schema`/`product`), `zones`, `users`, `data_bytes`, `storage`(원 저장소 — `local` 또는 `nfs` + `server`·`export`), `files_included`·`files_bytes`, `domain`(접속 주소 기본값), `mail_domain`, `install_id`, `network`·`subnet`(기본값), `blockers`(차단 사유).

**버전 판정**: 백업의 스키마 버전(또는 제품 버전)이 이 설치 관리자의 버전보다 **높으면 차단한다**(`version_newer`). 낮거나 같으면 진행하며, 복원 후 스키마 변경 단계가 차이를 보정한다. 이 설치 관리자의 스키마 버전은 backend 이미지에 질의한다(`schema-version`). 백업의 구역 구성이 서버 메모리를 초과하는 경우에도 차단한다(`memory_insufficient`).

### 신규 서버에서 재지정하는 항목

| 항목 | 규칙 |
|---|---|
| 접속 주소 | 기본값은 백업의 주소. DNS 가 아직 원 서버를 가리키더라도 **차단하지 않는다** — 인증서 방식을 지정하지 않은 경우 임시 인증서를 적용한다(이 서버를 가리키면 자동 발급) |
| 네트워크 구성·프록시 주소·인증서 | 설치와 동일하다. `cert` 를 비우면 프록시 → `proxy`, 주소가 IP → `temporary`, DNS 일치 → `auto`, 그 외 → `temporary` |
| 파일 저장 위치 | 백업의 저장소가 **NFS** 였으면 NFS 만 허용한다(`storage_must_be_nfs`) — 파일은 백업에 포함되지 않고 해당 공유에 존재한다. 연결 검증 5개 항목에 더해 **마커 파일의 설치 id 가 백업의 값과 일치하는지** 검증한다: 마커가 없으면 `marker_missing`(다른 공유이거나 빈 공유), 다른 설치의 마커이면 `other_install`. 백업의 저장소가 로컬이고 파일이 포함되어 있으면 도커 볼륨·NFS 모두 선택할 수 있다. 로컬이나 파일이 포함되지 않은 경우 파일 없이 복원한다(화면에 경고를 표시한다) |
| 내부 대역 | 기본값은 백업의 대역 |

구역·메일·회의·코드 저장소 버전·관리자 계정은 **입력받지 않는다** — 백업의 설정(`config` 항목의 `.env`)에서 가져온다.

### 설정 병합 규칙

| 구분 | 대상 |
|---|---|
| **백업에서 승계한다** | 비밀값 전체 — 암호화 키 `SECRET_KEY`(변경되면 DB 내 암호화된 값을 복호화할 수 없다), `INTERNAL_API_KEY`, `DB_PASSWORD`(코드 저장소의 설정 파일에도 기록되어 있다), 구역별 키·토큰, `SMTP_PASSWORD`, `GITEA_TOKEN`, `OAUTH_CLIENTS_JSON`. **소스 주소**(`JW_SOURCE_URL` — 수정본의 소스를 가리키던 서버는 이전 후에도 해당 주소를 가리켜야 한다. 신규 설치 관리자에 `-e JW_SOURCE_URL` 을 지정한 경우 그 값이 우선한다). **설치 id**(`JW_INSTALL_ID` — 저장소 마커와 일치해야 한다. 설치 관리자의 `install.json` 도 이 값으로 변경한다). 구역 목록, 메일 종류·메일 도메인(`DOMAIN` — 계정의 메일 주소), 외부 SMTP, 코드 저장소 이미지, `ADMIN_EMAILS`, `APP_NAME`, 인증서 연락처. 또한 설치 관리자가 관리하지 않는 변수(브랜드·기능 플래그·상한 등)는 `.env` 말미의 "백업에서 옮겨 온 설정"에 그대로 기록한다 |
| **신규 입력값으로 대체한다** | `APP_URL`, `GITEA_EXTERNAL_URL`, `GIT_SSH_DOMAIN`, `RBI_PUBLIC_ORIGIN`, `ACME_DOMAINS`, `DEPLOY_MODE`, `COMPOSE_PROFILES`, `HAIRPIN_HOST`·`RP_LAN_IP`, `JW_NET_PREFIX`, `BACKEND_WORKERS`, `JW_REGISTRY`·`JW_VERSION`, nginx `site.d`, 회의 서버 설정(신규 서버의 공인 주소), 저장소 볼륨. 원 서버에 종속된 값(`GPU_HOST_IP`, `JW_HOST_REPO`, `BACKUP_VOLUME`, `GITEA_DATA_PATH`, `MCP_PUBLIC_URL`, `DOMAIN_ALIAS`, `DATABASE_URL` 등)은 이전하지 않는다 |
| **신규 생성한다** | 설치 관리자 내부 API 키(`JW_INSTALLER_KEY`), 설치 토큰·세션·설치 관리자의 인증서, 백업에 없던 비밀값 |

메일 서명 키(DKIM)는 데이터와 함께 복원된 키를 계속 사용한다(등록된 DNS 레코드와 일치해야 한다).

### 단계

| 단계 | 수행 내용 | 대표 실패 원인 |
|---|---|---|
| `unpack` | 백업 설정 + 신규 입력값으로 스택 파일 기록(위 병합 규칙), `compose config -q`. 도커 볼륨 저장소인 경우 볼륨·마커까지 생성 | `restore_backup_missing`, `restore_config_failed`, `compose_invalid` |
| `storage` | (NFS·지정 폴더인 경우에만) 마커 대조 → 볼륨 생성 | `storage_marker_missing`, `storage_other_install`, NFS 관련 원인 |
| `pull` | 이미지 pull | `image_pull_failed` |
| `database` | postgres·redis 기동(빈 DB) → 메일·코드 저장소 컨테이너를 **생성만** 하고(볼륨이 생성된다) → `compose run backend python -m app.cli restore <백업> --yes --json --items db,mail,gitea,plugins-data,app-signing[,certs]` → 메일 서명 키 승계, 스택 파일 재생성 → `migrate` | `database_not_ready`, `restore_database_failed`(`stage`·`detail`·`state` — backend 의 복원 단계 이름과 이후의 DB 상태), `database_migrate_failed` |
| `files` | (백업에 파일이 포함된 경우에만) 백업 내 `files.tar` 를 저장소에 추출한다 — 보조 컨테이너가 root 로 백업을 연 후 backend 의 사용자(1000:1000)로 권한을 낮춰 기록한다(root squash 가 적용된 NFS export 에서도 동작한다). 저장소의 기존 내용은 삭제한다 | `restore_files_failed` |
| `cert` | 인증서(설치와 동일) | `cert_issue_failed`(대안: 임시 인증서) |
| `zones` | 구역 기동·연동(코드 저장소의 인증 소스·OAuth 클라이언트를 신규 주소로 재등록) → 검증(전단(nginx) 경유 `/api/health`, 계정 수 = 백업의 계정 수) → 잠금 → 추출한 설정·암호·업로드 사본 삭제 | `service_not_ready`, `git_*` |

- 인증서 항목(`certs`)은 접속 주소가 백업과 동일하고 자동 발급인 경우에만 복원한다(기존에 발급받은 인증서를 계속 사용한다). 주소가 변경되었거나 임시 인증서인 경우 생략한다.
- 관리자 계정은 생성하지 않는다. DB 에 저장되는 설정(외부 SMTP 의 보안 방식·AI 제공자)도 덮어쓰지 않는다 — 백업에 포함되어 복원된다.
- 실패하면 해당 단계부터 재실행한다(`retry`). 상태에는 `mode: "restore"` 와 완료 화면용 `restore: {"files": restored|not_included|nfs, "storage_kind", "cert", "domain_changed"}` 가 추가된다.

### 무인 복원(응답 파일)

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
docker exec jw-installer jw apply --answers /data/restore.json --dry-run   # 백업 확인·검증·단계 목록(변경은 수행하지 않는다)
docker exec jw-installer jw apply --answers /data/restore.json
```

`access.domain` 을 비우면 백업의 주소, `advanced.subnet` 을 지정하지 않으면 기본 대역이 적용된다. 접속 주소가 아직 이 서버를 가리키지 않는 경우 `"cert": "temporary"` 로 지정한다. 암호로 보호된 백업은 `restore.password_file` 또는 `-e JW_BACKUP_PASSWORD` 로 암호를 전달한다.

### 완료 후 조치

접속 주소의 DNS 레코드를 이 서버로 변경하고, 임시 인증서인 경우 관리 › 보안의 인증서 카드에서 발급하며(§15), 검증 후 원 서버를 중지한다(두 서버를 병행 운영하면 데이터가 분기된다). 세션은 백업에 포함되지 않는다 — 전체 사용자의 재로그인이 필요하다.

## 15. 인증서 재발급 · 보류된 구역 연동

임시(자체 서명) 인증서로 설치·복원한 서버를 신뢰되는 인증서로 전환하는 절차다. 화면은 관리 › 보안의 "인증서" 카드이며, backend 의 `/api/admin/system/cert…` 가 아래 API 를 대행 호출한다. 코드는 `installer/app/certctl.py` 다.

| 메서드·경로 | 기능 |
|---|---|
| `GET /internal/cert` | `{"managed"(이 서버가 TLS 를 종단하는지 여부), "mode": auto\|upload\|temporary\|proxy, "temporary", "domain", "names", "wanted_names", "not_after", "days_left", "issuer", "self_signed", "site_ca", "ca_uploadable", "pending": [구역 id], "renewal", "job"}`. `renewal = {"applicable"(자동 발급 설치 여부), "service": running\|stopped\|missing(갱신 컨테이너), "last_run_at", "last_result": ok\|failed(갱신 컨테이너가 기록한 최종 갱신 시도), "next_renewal_at"(추정 — 유효 기간의 1/3 이 남는 시점)}` |
| `POST /internal/cert/reissue` `{"mode": "auto"}` | Let's Encrypt 에 재요청한다(접속 주소가 이 서버를 가리키고 80 포트가 외부에서 도달 가능해야 한다) |
| `POST /internal/cert/reissue` `{"mode": "upload", "cert", "key", "ca"?}` | 보유한 인증서로 교체한다. `ca` 는 사설 CA 의 인증서(선택). 검증은 마법사의 인증서 검증과 동일하며, 실패 시 `422 cert_invalid` + `checks` |
| `POST /internal/cert/ca` `{"ca"}` | 업로드한 인증서를 사용하는 설치에 **발급 CA 인증서만** 추가한다 — 인증서·개인 키는 유지된다. `{"ca": ""}` 는 별도로 업로드한 CA 를 제거한다. 해당 인증서의 발급 CA 가 아니거나 CA 인증서가 아니면 `422 cert_invalid` + `checks`, 업로드한 인증서를 사용하지 않는 설치이면 `409 cert_ca_needs_upload` |
| `POST /internal/zones/<id>/reconnect` | 보류된 연동을 재시도한다. 여전히 실패하면 작업이 `failed`(`connection_still_pending`) |

작업(`kind: "cert"`, `zone: null`)의 단계는 `issue`(입력값·설정 변경 후 발급·배치) → `reload`(nginx 재시작, 회의 서버 재시작, 자동 발급이면 갱신 컨테이너 기동·그 외 방식이면 제거, 문서 편집기·backend 재생성) → `reconnect`(보류된 구역의 `connect` 훅 — 코드 저장소의 로그인 연동) 순이다. `issue` 가 실패하면 입력값·설정을 롤백하고 **기존 인증서를 재배치한다**(자동 발급 시도 과정에서 임시 인증서의 링크가 해제되었을 수 있다). 거부: `409 cert_managed_by_proxy`(프런트 프록시가 담당하는 설치), `422 cert_auto_needs_domain`, `409 busy`.

**사설 CA.** 공개 CA 가 아닌 CA(사내 CA 등)가 발급한 인증서는, 이 서버의 다른 컨테이너가 접속 주소로 회귀 접속할 때 신뢰되지 않는다. 발급 CA 를 제공하는 방법은 3가지이며 결과는 동일하다.

| 방법 | 처리 |
|---|---|
| 인증서 파일에 체인으로 포함 | 서버 인증서 뒤에 중간·루트 CA 를 연결한 PEM 을 업로드한다. 첫 번째 인증서를 제외한 나머지를 발급 CA 로 간주한다 |
| "CA 인증서(선택)" 항목 | 마법사의 인증서 화면, 관리 › 보안의 인증서 올리기 창. API 로는 `ca`, 응답 파일로는 `access.ca_path` |
| 이후 CA 만 추가 | 관리 › 보안의 인증서 카드의 "CA 인증서 올리기"(`POST /internal/cert/ca`) — 서버 인증서 1장만 업로드해 연동이 보류된 경우에 사용한다. 인증서·개인 키는 재업로드하지 않는다 |

- 별도로 업로드한 CA 는 다음을 검증한다: PEM 인증서 여부(`ca_not_pem`, 개인 키이면 `ca_is_private_key`), CA 인증서 여부(`ca_not_a_ca` — 서버 인증서를 잘못 업로드한 경우), 업로드한 인증서 또는 함께 제공된 체인의 인증서를 직접 발급한 CA 인지 여부(`ca_not_issuer`). 인증서 파일에 발급 CA 가 없고 CA 도 업로드하지 않은 경우 차단하지 않고 주의(`cert_chain_missing`)로 고지한다 — 공개 CA 의 인증서일 수 있기 때문이다.
- 확인된 발급 CA(체인에 포함된 것 + 별도로 업로드한 것, 중복은 1회만 포함)를 `stack/site-ca/ca.pem` 에 보관하며, 사이트 오버라이드(`docker-compose.site.yml`)가 해당 파일을 **코드 저장소와 backend** 컨테이너의 `/etc/ssl/certs/jw-site-ca.pem` 으로 마운트한다. 별도로 업로드한 CA 의 원본은 `state/upload/ca.pem` 에 보관한다.
- Gitea(Go)는 시스템 CA 번들에 더해 해당 폴더의 파일을 읽는다. backend 는 기동 시(`entrypoint.sh`) 시스템 CA 번들과 해당 파일을 병합한 번들을 생성해 `SSL_CERT_FILE` 로 지정한다 — 파이썬의 기본 TLS 설정과 httpx 가 이를 신뢰 저장소로 사용한다. 두 경우 모두 공개 CA 에 대한 신뢰는 유지된다.
- `reload` 단계가 두 컨테이너를 재생성하고, 후속 `reconnect` 단계가 보류된 로그인 연동을 등록한다. 자동 발급으로 전환하면 제거한다.
- `GET /internal/cert` 의 `site_ca`(신뢰하도록 구성한 발급 CA 의 존재 여부)·`ca_uploadable`(CA 를 별도로 업로드할 수 있는 설치인지 여부 — 업로드한 인증서를 사용하며 자체 서명이 아님)로 화면이 판단한다: 업로드한 인증서 + `site_ca` 아님 + 보류된 연동이 있으면 "CA 인증서를 올리세요" 안내를 표시한다.
- 신뢰 구성의 적용 범위는 **코드 저장소와 backend 컨테이너**다. backend 는 설치 관리자가 구성한 환경에서 자신의 접속 주소로 HTTPS 요청을 보내지 않으나(내부 이름으로 호출한다), 관리자가 등록한 동일 CA 의 주소(로그아웃 통지 수신 주소, 외부 메일·LDAP 서버 등)로 향하는 요청은 이 CA 를 신뢰하게 된다. **문서 편집기 등 다른 컨테이너와 사용자의 브라우저는 적용 대상이 아니다.**

구역 연동이 보류되는 경우는 현재 1가지다: 코드 저장소의 인증 소스 등록(Gitea 가 접속 주소의 인증서를 신뢰하지 못하는 경우). `GET /internal/zones` 의 해당 구역 행에 `pending: true` 가 포함되며, 관리 › 구역에 "연결 보류"와 "다시 연결"이 표시된다.

## 16. 업데이트

설치 후의 업데이트도 설치 관리자가 수행한다. 화면은 관리 › 업데이트이며, backend 가 내부 API(`/internal/update/*`)를 대행 호출한다 — 응답 형식과 오류 코드는 [update-api.md](update-api.md), 사용자 관점의 설명은 [update-system.md](update-system.md), 채널·릴리스의 형식은 [releases.md](releases.md) 를 참조한다.

| 파일 | 기능 |
|---|---|
| `app/update_release.py` | 채널을 조회·검증하고 계획을 수립한다. 검증에는 릴리스 도구의 모듈(`release/jwrelease` 의 `semver`·`model`·`verify`·`bundle`)을 그대로 사용한다 — 이미지 빌드 시 `/app/jwrelease` 로 복사된다 |
| `app/update_engine.py` | 작업(적용·롤백·복원), 사전 공지와 점검 모드, 자동 업데이트, 복원 지점, 기록 |
| `app/update_offline.py` | 오프라인 번들과 추가 이미지 |
| `app/update_restack.py` | 스택 파일을 해당 이미지의 번들로 재생성한다(신규 버전 이미지의 일회용 컨테이너에서 실행된다) |
| `app/update_swap.py` | 설치 관리자 자기 교체(보조 컨테이너에서 실행된다) |
| `app/api_update.py` | 내부 API 경로 |

### 채널 및 공개 키

| 설정 | 지정 위치 | 기본값 |
|---|---|---|
| 채널 주소 | `jw update-channel <주소>` 로 지정한 값(`<설치 폴더>/state/update/channel-url`) → 환경변수 `JW_UPDATE_CHANNEL_URL`(동일한 이름의 이미지 빌드 인자로 기본값을 내장한다) | 릴리스 도구의 `channel_base_url`(`release/jwrelease/config.py`) |
| 공개 키 | `<설치 폴더>/state/update/keys/*.pub` — 존재하면 이 키만 사용한다(`jw update-key add` 가 검증 후 등록한다). 없으면 이미지의 `/app/keys/*.pub`(빌드 시 `installer/keys/` 에 배치한 키) | 리포의 `installer/keys/release.pub` |
| 오프라인 번들 다운로드 주소 | `JW_UPDATE_OFFLINE_URL`(`{version}`·`{filename}`) | 릴리스 도구의 `download_url_template` |

- **수신 채널의 기본값은 설치된 버전의 채널이다.** Beta 버전(`-beta.N`)으로 설치한 서버는 Beta 채널을, Stable 버전으로 설치한 서버는 Stable 채널을 수신한다. 관리 › 업데이트에서 채널을 선택하면 그 값이 저장되어 우선한다. 응답의 `current.channel`(설치된 버전이 속한 채널)과 `settings.channel`(수신 채널)은 별개의 값이다.
- 채널 파일이 없으면(HTTP 404) 확인은 `channel_empty` 로 종료된다 — 해당 채널에 공개된 릴리스가 아직 없는 상태이며, 화면은 이를 연결 실패(`channel_unreachable`)와 구분하여 표시한다.
- 공개 키는 **최대 2개**(현재·차기, 파일 이름순)를 허용하며 그중 하나로 검증되면 통과로 처리한다 — 키 교체 절차는 releases.md 의 "키 관리" 참조.
- 키가 하나도 없으면 확인은 `unconfigured` 로 종료된다(채널을 조회하지 않는다). `installer/keys/` 를 비운 채 빌드한 이미지가 이에 해당한다 — `docker exec -i jw-installer jw update-key add - < release.pub` 로 등록한다(PEM 공개 키 여부를 검증하고 지문을 출력한다. 비공개 키는 거부한다).
- `jw update-channel <주소>` 는 채널 주소를 변경하고, 이전 채널에서 저장한 확인 결과와 순번을 삭제한다(다른 발행자의 채널은 순번이 더 낮을 수 있다). `--reset` 은 환경변수·이미지의 값으로 복원한다.
- 확인 주기는 6시간 + 0~30분의 지터(jitter)다. 채널 서버에는 정적 파일에 대한 GET 요청만 전송하며 식별자·버전·통계를 전송하지 않는다. 수락한 채널의 순번(`sequence`)을 저장해, 그보다 낮은 순번의 파일은 거부한다.
- 검증을 통과한 manifest 는 `state/update/manifests/` 에 서명과 함께 보관하며, **사용 시마다 서명을 재검증한다.**

### 적용 단계 및 번들

| 단계 | 수행 내용 |
|---|---|
| `preflight` | manifest 서명 재검증, 다른 작업의 유무, backend 기동 여부, 여유 공간(pull 대상 용량의 2배 + 1GB), 스키마 버전의 하향 여부(`migrate --status` 와 manifest 의 `db_schema`), 플러그인 호환 |
| `backup` | backend 컨테이너에서 `backup create --kind pre-update --json` → 현재의 스택 파일을 `state/update/snapshots/<복원 지점>/stack/` 에 복사 → 복원 지점으로 등록 |
| `pull` | **설치 관리자 이미지부터** 다이제스트로 pull 해 번들을 `state/update/bundles/<버전>/` 에 추출한다 → 해당 compose 로 활성화되는 서비스를 식별해, 자체 빌드 이미지와 활성 구역의 외부 이미지를 다이제스트로 pull 한다. 자체 빌드 이미지에는 `<JW_REGISTRY>/just-workspace-<이름>:<버전>` 태그를 부여한다(compose 가 해당 이름으로 참조한다) |
| `migrate` | `.env` 에 `JW_VERSION=<신규 버전>` 만 오버라이드해 신규 backend 이미지의 일회용 컨테이너로 `python -m app.cli migrate` |
| `switch` | 신규 설치 관리자 이미지의 일회용 컨테이너가 스택 파일을 재생성한다 → 구역의 컨테이너 → 프런트 → nginx(재생성) → **backend(최후)** → 설치 관리자 자신 |
| `verify` | 전체 컨테이너의 준비 여부, backend 가 해당 버전의 이미지인지 여부, `/api/health`, DB 스키마 버전 = 코드가 요구하는 버전 = manifest 의 값, 설치 관리자의 버전 |

**번들.** 신규 버전의 compose·nginx 템플릿·구역 선언은 신규 설치 관리자 이미지에 포함되어 있으며, 입력값을 `.env`·설정 파일로 변환하는 코드도 해당 이미지의 것이다. 따라서 스택 파일은 기존 설치 관리자가 아니라 신규 이미지가 생성한다(`docker run --rm … <새 이미지> python -m app.update_restack`). 입력값·비밀값·감지값은 상태 폴더의 값을 그대로 사용한다.

**자기 교체.** 컨테이너는 자기 자신을 교체할 수 없다. `switch` 의 마지막에서 다음을 수행한다:

1. 작업 상태를 디스크에 기록한다(`ctx.handoff = {to, image, step, state: "pending"}`).
2. 자신의 이미지로 보조 컨테이너를 기동한다(docker 소켓과 설치 폴더를 마운트한다). 보조 컨테이너는 기존 컨테이너의 구성을 읽고, 중지하고, 이름을 `<이름>-prev` 로 변경한 후, 동일한 이름·재시작 정책·게시 포트·볼륨·사용자 지정 환경변수·네트워크(별칭 포함)로 신규 이미지의 컨테이너를 생성해 기동한다.
3. 신규 설치 관리자는 기동 시 진행 중인 작업을 읽는다. 자신의 버전이 `handoff.to` 와 일치하면 해당 단계를 완료로 처리하고 `verify` 로 진행한다.
4. 신규 컨테이너가 정상이 아니거나 버전이 불일치하면 보조 컨테이너가 이를 삭제하고 기존 컨테이너를 복구한다. 복구된 기존 설치 관리자는 자신의 버전이 `handoff.to` 와 불일치함을 확인하고 해당 단계를 `installer_replace_failed` 로 실패 처리한다(→ 자동 롤백). 보조 컨테이너의 기동에 실패하였거나 5분 이내에 진행이 없는 경우에도 동일하게 처리한다.

- 승계되는 구성은 위 목록이 전부다. 그 외의 옵션(자원 제한, 레이블 등)을 직접 지정해 기동한 설치 관리자는 교체 후 재지정해야 한다.
- 환경변수는 "기존 이미지가 정의한 값"을 제외하고 승계한다(신규 이미지의 기본값이 적용되어야 한다). `JW_IMAGE_TAG` 는 승계하지 않는다 — 업데이트 후에는 이미지 태그가 곧 제품 버전이다.
- 신규 컨테이너에는 `JW_INSTALLER_VERSION=<제품 버전>` 을 지정한다. 승격(Beta → Stable)은 이미지를 재빌드하지 않으므로 이미지 내 `VERSION` 은 Beta 의 버전 문자열이다 — 설치 관리자는 이 환경변수가 있으면 해당 값을 자신의 버전으로 인식한다.
- 롤백·복원이 설치 관리자의 버전을 변경해야 하는 경우에도 동일한 방법을 사용한다(`start` 단계의 마지막, 이미지는 복원 지점에 기록된 것). 이때의 환경변수는 현재 컨테이너에서 추출하지 않고 **복원 지점에 기록된 값**(해당 버전 운영 시 사용자가 지정한 값)을 그대로 사용한다 — 신규 이미지의 기본값과 동일해 업데이트 시 제외된 값(예: 채널 주소)이 기존 이미지로 복귀하면서 소실되지 않도록 하기 위함이다.
- backend 이미지의 일회용 컨테이너(`migrate`, 복원)는 내부망의 고정 주소 없이 기동한다 — 실행 중인 backend 가 해당 주소를 점유하고 있다(`compose run` 에 오버라이드를 하나 추가한다).

### 실패 처리 및 롤백

- `migrate` 이전(`preflight`·`backup`·`pull`)의 실패: 작업이 `failed` 로 정지하고 `choices = ["retry", "rollback"]` 을 제공한다. 이 경우의 롤백은 변경 사항이 없으므로 `stop`·`images`·`restore_db` 를 생략한다(`detail.skipped`).
- `migrate` 단계부터의 실패 및 자동 업데이트의 모든 실패: 롤백 작업을 즉시 생성한다.
- 롤백·복원의 단계: `stop`(DB·캐시·nginx 를 제외한 컨테이너를 중지한다) → `images`(스택 파일을 복원 지점의 것으로 복원한다) → `restore_db`(해당 버전 backend 이미지의 일회용 컨테이너에서 `restore <백업> --items db --yes`. DB 변경을 시작하지 않았으면 생략한다. 백업의 스키마 버전이 복원 지점의 기록과 불일치하면 시작하지 않는다) → `start`(backend 를 최후에 기동, 이후 설치 관리자 교체) → `verify`.
- 롤백이 실패하면 해당 작업이 `failed` + `choices = ["retry"]` 로 유지되며 점검 모드는 해제되지 않는다. `error.vars.backup_location` 이 백업의 위치다.
- 중간 버전을 경유하는 도중 실패하면 **해당 버전의 직전**으로 롤백한다. 이미 완료된 선행 버전은 유지된다.

### 점검 모드

점검 모드가 시작되면(사전 공지 종료 시점, `backup` 이전) 설치 관리자가 `stack/nginx/state/maintenance.on` 을 생성한다. nginx 는 이 파일이 존재하면 관리자의 진행 화면이 사용하는 경로(`/api/auth/`, `/api/admin/system/update/`, `/api/system/update-notice`, `/api/health`)만 통과시키고 그 외의 API·소켓·구역 프록시를 `503 {"code": "maintenance"}`(+ `Retry-After`)로 차단한다. 파일은 요청마다 확인하므로 nginx 의 reload 가 필요하지 않다. 작업이 종료되면(성공·롤백 무관) 삭제한다. 관리자의 선택을 대기하는 동안과 롤백 실패로 정지한 동안에는 유지된다.

### 복원 지점 보관 정책

- `pre-update`(업데이트 직전 백업): **최근 3개**. 업데이트가 성공으로 종료될 때 초과분을 삭제한다 — 백업 폴더, 스택 사본, 그리고 어느 복원 지점에서도 참조하지 않게 된 이전 버전의 자체 빌드 이미지 태그.
- `pre-beta`(Stable 에서 Beta 로 최초 전환하기 직전): 위 3개와 별도로 **1개**를 기한 없이 보관한다. Stable 채널로 복귀해 현재 버전이 Stable 이 되거나 "시험판 이전 상태로 복원"을 완료하면 삭제한다.
- 복원 지점은 백업의 위치·크기·스키마 버전, 당시의 버전, 스택 사본, 당시 실행 중이던 설치 관리자의 이미지와 환경변수를 기록한다. 해당 버전의 이미지가 서버에 남아 있어야 복원이 가능하다(위 규칙이 이를 보장한다).

### 오프라인 업데이트

1. 오프라인 번들을 업로드하거나(`POST …/offline/bundle`, 본문을 디스크에 스트리밍으로 기록한다 — `state/update/offline/bundle.tar`) 서버의 경로를 지정한다(설치 폴더 하위만 허용. `<설치 폴더>/…` 와 `/data/…` 표기를 모두 허용한다. 복사하지 않고 해당 위치에서 직접 읽는다).
2. 검증: 오프라인 번들 서명 → manifest → 파일별 해시(`jwrelease.bundle.verify_bundle`) → 버전(현재보다 높고 단일 작업으로 도달 가능해야 한다).
3. 추가로 필요한 이미지: manifest 의 외부 이미지 중 오프라인 번들에 포함되지 않은 것. 현재 프로파일에서 활성화되지 않는 것은 `not_needed`. 서버에 해당 다이제스트(또는 `저장소:jw-<다이제스트 앞 12자>` 이름)가 존재하면 `present`.
4. 이미지 파일을 업로드하면 `docker load` 후 위 이름의 생성 여부를 확인한다. 생성되지 않았으면 `hash_mismatch`.
5. 적용: `pull` 단계가 pull 대신 오프라인 번들에서 이미지를 추출해 `docker load` 한다. 다이제스트로 식별할 수 없는(이름으로만 적재된) 외부 이미지는 `stack/docker-compose.pins.yml` 로 해당 이름을 참조한다.

업로드 파일의 상한은 64GB(`JW_UPDATE_UPLOAD_MAX`, 바이트)다. 업로드 재개는 지원하지 않는다 — 대용량 파일은 경로 지정 방식을 권장한다.

### 실서버 검수

`installer/e2e/scenarios/u-update.sh <단계…>` — 서버 내부에 모의 릴리스 환경(루프백의 `registry:2`, 정적 채널 서버, 현장에서 생성한 임시 키)을 구성하고 릴리스 도구로 실제 형식의 릴리스를 생성해 실행한다(`update-lib.sh`). 최초 설치도 해당 환경의 릴리스(1.0.0)로 수행한다 — 리포의 `VERSION`(개발 중인 버전)으로 빌드한 이미지는 다른 이미지의 베이스로만 사용하므로, `VERSION` 값과 무관하게 동일한 결과가 산출된다. 검증 내용은 13절의 표를 참조한다.
