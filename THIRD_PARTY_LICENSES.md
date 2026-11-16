# 제3자 라이선스 고지

본 소프트웨어(Just Workspace)의 소스에는 [AGPL-3.0-or-later](LICENSE) 가 적용된다(저작권 고지는 [NOTICE](NOTICE)). 본 문서는 본 소프트웨어와 함께 사용되는 제3자 소프트웨어를 **구성 요소별 포함 위치** 기준으로 기재한다.
의무와 해석은 [docs/licensing.md](docs/licensing.md) 에 기술한다.

- 버전은 리포에 고정된 값이다 — `*/requirements.txt`, `*/package.json`·`package-lock.json`, `audiorelay/go.mod`, `docker-compose.yml`, 각 `Dockerfile`.
- 라이선스 근거: 파이썬은 PyPI 배포 메타데이터(`License-Expression`·`License`·분류자), npm 은 패키지의 `license` 필드(`package-lock.json`·`node_modules`), 컨테이너 이미지와 데비안 패키지는 원 프로젝트의 공개 라이선스.
- 직접 의존성은 전부 기재하고, 전이 의존성은 허용적(permissive: MIT·BSD·Apache-2.0·ISC 등) 라이선스가 아닌 것만 기재한다.
- 의존성 버전을 변경하거나 Dockerfile 에 패키지를 추가하는 경우 본 문서를 함께 수정한다.

## 1. 개요 — 비허용적(non-permissive) 라이선스 구성 요소

### 1.1 자체 빌드 이미지에 포함되는 구성 요소

| 구성 요소 | 버전 | 라이선스 | 포함 이미지 | 용도 |
|---|---|---|---|---|
| aioimaplib | 2.0.3 | **GPL-3.0-only** | backend | 메일 IMAP 클라이언트 — backend 코드가 `import` |
| ldap3 | 2.9.1 | LGPL-3.0 | backend | 외부 LDAP/AD 로그인 — `import` |
| pywebpush · py-vapid | 2.5.0 · 1.9.6 | MPL-2.0 | backend | 웹 푸시 |
| certifi | 2026.10.23 | MPL-2.0 | backend · sso · installer | 루트 인증서 번들(전이 의존성) |
| pandoc (데비안 패키지) | 베이스 배포판 제공 버전 | GPL-2.0-or-later | backend | 문서 변환 — 별도 프로세스로 실행 |
| psycopg · psycopg-binary | 3.3.9 | LGPL-3.0-only | ldap | PostgreSQL 드라이버(libpq 를 포함한 바이너리 휠) |
| zope.interface | 8.7 | ZPL-2.1 (permissive, 참고) | ldap | Twisted 전이 의존성 |
| LibreOffice (데비안 backports 패키지) | 베이스 배포판 제공 버전 | MPL-2.0 (일부 LGPL-3.0+·Apache-2.0) | docconv | 오피스 문서 변환 — 별도 프로세스 |
| H2Orestart (LibreOffice 확장) | v0.8.0 | **GPL-3.0** | docconv | HWP·HWPX 읽기 — 이미지 빌드 시 다운로드하여 설치 |
| OpenJDK (`default-jre-headless`) | 베이스 배포판 제공 버전 | GPL-2.0 + Classpath 예외 | docconv | H2Orestart 실행 |
| iptables · iproute2 · procps | 베이스 배포판 제공 버전 | GPL-2.0-or-later · GPL-2.0 · GPL-2.0+/LGPL-2.1+ | rbi-netfilter | 격리 브라우저 네트워크 규칙 |
| libvips (`@img/sharp-libvips-linux-x64`) | 1.3.4 | LGPL-3.0-or-later | rbi-mirror | 이미지 재인코딩 — sharp 가 동적 링크 |
| iproute2 | 6.1.0-3 | GPL-2.0 | rbi-mirror | 준비 상태 확인(`ss`) |
| docker-mailserver 에 포함된 프로그램 | 16.0.1 | 아래 3.2 | mailserver | 원 이미지에 데비안 보안 업데이트를 적용한 **파생 이미지** |
| 베이스 이미지의 OS 구성 요소 | — | GPL·LGPL 다수 | 전 이미지 | 아래 3.3 |
| dompurify | 3.4.17 | MPL-2.0 OR Apache-2.0 | frontend-react(번들) | HTML 정화 — Apache-2.0 선택 가능 |

### 1.2 비오픈소스 구성 요소

웹·서버 이미지에 포함되는 의존성 중 비오픈소스 구성 요소는 없다. 모바일 앱의 Android 푸시(Firebase·Google Play 서비스)에 한하여 Google 약관이 적용된다(`google-services.json` 을 포함하여 빌드하는 경우).

### 1.3 외부 이미지(재배포하지 않음) 중 해당 항목

| 이미지 | 라이선스 | 사용 구역 |
|---|---|---|
| `redis:8.8.4-alpine` | RSALv2 / SSPLv1 / AGPL-3.0 삼중(8.0 부터. 이용자가 택일) | 기본 |
| `onlyoffice/documentserver` 10.0.0.1 | **AGPL-3.0** | 문서 편집 구역 |
| `searxng/searxng` 2026.11.13 | **AGPL-3.0** | AI 도우미 구역 |
| `kasmweb/chromium:1.18.0` | 이미지 레시피 MIT · 내장 KasmVNC **GPL-2.0** · Chromium BSD-3-Clause 외 | 격리 브라우저(compose 프로파일 `rbi`) |

## 2. 자체 빌드 이미지 — 언어 의존성

### 2.1 backend (`backend/requirements.txt`, 베이스 `python:3.14-slim`)

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| fastapi | 0.162.7 | MIT | 웹 프레임워크 |
| starlette | 1.10.0 | BSD-3-Clause | ASGI 툴킷 |
| uvicorn[standard] | 0.54.0 | BSD-3-Clause | ASGI 서버(+ uvloop MIT/Apache-2.0, httptools MIT, websockets BSD-3-Clause, watchfiles MIT) |
| httpx | 0.28.1 | BSD-3-Clause | HTTP 클라이언트 |
| PyJWT[crypto] | 2.15.1 | MIT | 토큰 서명·검증 |
| SQLAlchemy[asyncio] | 2.1.8 | MIT | ORM |
| greenlet | 3.5.6 | MIT AND PSF-2.0 | SQLAlchemy 비동기 |
| asyncpg | 0.32.0 | Apache-2.0 | PostgreSQL 드라이버 |
| itsdangerous | 2.2.0 | BSD-3-Clause | 서명 |
| pydantic · pydantic-settings | 2.14.3 · 2.16.3 | MIT | 스키마·설정 |
| python-multipart | 0.0.33 | Apache-2.0 | 업로드 파싱 |
| Pillow | 13.0.0 | MIT-CMU | 이미지 처리 |
| slowapi | 0.1.10 | MIT | 요청 수 제한 |
| libpass[bcrypt,argon2] | 1.9.4 | BSD | 비밀번호 해시(import 이름 `passlib`) |
| argon2-cffi | 25.1.0 | MIT | Argon2 |
| bcrypt | 5.0.0 | Apache-2.0 | bcrypt |
| livekit-api | 1.2.3 | Apache-2.0 | LiveKit 서버 API·토큰 |
| redis[hiredis] | 8.1.0 | MIT | Redis 클라이언트(서버의 라이선스와 상이함) |
| aioimaplib | 2.0.3 | **GPL-3.0-only** | IMAP 클라이언트 |
| aiosmtplib | 5.1.3 | MIT | SMTP 클라이언트 |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause | 암호 |
| ldap3 | 2.9.1 | LGPL-3.0 | 외부 LDAP/AD 로그인 |
| python-dateutil | 2.9.0.post0 | Apache-2.0 / BSD-3-Clause 이중 | 날짜 |
| icalendar | 7.3.0 | BSD-2-Clause | iCalendar |
| vobject | 0.9.9 | Apache-2.0 | vCard |
| pyotp | 2.10.0 | MIT | TOTP |
| qrcode[pil] | 8.2 | BSD | 2단계 인증 QR |
| boto3 | 1.44.3 | Apache-2.0 | S3 호환 저장소 |
| pywebpush · py-vapid | 2.5.0 · 1.9.6 | MPL-2.0 | 웹 푸시(+ http-ece MIT, aiohttp Apache-2.0 AND MIT, requests Apache-2.0) |
| pypdf | 7.1.0 | BSD-3-Clause | PDF 읽기 |
| python-docx · python-pptx | 1.2.0 · 1.0.2 | MIT | docx·pptx |
| openpyxl | 3.1.5 | MIT | xlsx |
| olefile | 0.47 | BSD | HWP 5.0 컨테이너 읽기 |
| reportlab | 5.1.0 | BSD | PDF 생성 |
| mcp | 2.3.0 | MIT | MCP 서버 SDK |
| sse-starlette | 3.7.0 | BSD-3-Clause | SSE 전송 |
| pytest · pytest-asyncio · pytest-cov · aiosqlite | 9.2.0 · 1.5.0 · 7.1.0 · 0.22.1 | MIT · Apache-2.0 · MIT · MIT | 테스트 — 배포 이미지에는 포함되지 않는다(`backend/requirements-dev.txt`, Dockerfile 의 `test` 대상) |

전이 의존성 중 비허용적 라이선스: certifi(MPL-2.0). 그 밖(aiohappyeyeballs·typing_extensions PSF-2.0 등)은 허용적 라이선스이다.

apt 로 설치하는 패키지: `docker-ce-cli`(Apache-2.0), `gosu`(Apache-2.0), `curl`(curl 라이선스), `ca-certificates`(MPL-2.0·GPL-2.0+), **`pandoc`(GPL-2.0-or-later)**. pandoc 은 backend 코드에 링크되지 않고 별도 프로세스로 실행된다.

### 2.2 sso (`sso/requirements.txt`, 베이스 `python:3.14-slim`)

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| pysaml2 | 7.5.5 | Apache-2.0 | SAML IdP(+ pyOpenSSL Apache-2.0, xmlschema·elementpath MIT, defusedxml PSF-2.0, requests Apache-2.0) |
| scim2-models · scim2-filter-parser | 0.12.4 · 0.7.0 | Apache-2.0 · MIT | SCIM |
| fastapi · starlette · uvicorn[standard] · SQLAlchemy[asyncio] · greenlet · asyncpg · pydantic · pydantic-settings · itsdangerous · httpx | backend 와 동일 버전 | 위 표 | |

apt: `xmlsec1` · `libxmlsec1-openssl`(MIT), `ca-certificates`. 전이 의존성 중 비허용적 라이선스: certifi(MPL-2.0).

### 2.3 ldap (`ldap/requirements.txt`, 베이스 `python:3.14-slim`)

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| ldaptor | 21.2.0 | MIT | LDAP 서버(+ passlib 1.7.4 BSD, pyparsing MIT) |
| Twisted[tls] | 26.10.0 | MIT | 비동기 네트워킹(+ zope.interface ZPL-2.1, pyOpenSSL Apache-2.0, service-identity MIT) |
| psycopg[binary] | 3.3.9 | **LGPL-3.0-only** | PostgreSQL 드라이버. `psycopg-binary` 휠은 libpq(PostgreSQL License)와 OpenSSL(Apache-2.0)을 포함한다 |
| pydantic-settings | 2.16.3 | MIT | 설정 |

### 2.4 sandbox (`sandbox/requirements.txt`, 베이스 `python:3.14-slim`) — AI 도우미 구역

| 패키지 | 버전 | 라이선스 |
|---|---|---|
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| pandas · scipy · scikit-learn · statsmodels · seaborn | 3.1.1 · 1.18.1 · 1.9.1 · 0.15.0 · 0.13.2 | BSD-3-Clause |
| pyarrow | 26.0.1 | Apache-2.0 |
| matplotlib | 3.11.2 | matplotlib 라이선스(PSF 계열, permissive) |
| openpyxl · python-docx · python-pptx · tabulate | 3.1.5 · 1.2.0 · 1.0.2 · 0.10.0 | MIT |
| XlsxWriter | 3.3.1 | BSD-2-Clause |
| reportlab · pypdf | 5.1.0 · 7.1.0 | BSD · BSD-3-Clause |
| pillow | 13.0.0 | MIT-CMU |

apt: `fonts-nanum`(OFL-1.1), `fonts-noto-cjk`(OFL-1.1). GPL 계열 파이썬 패키지는 없다. numpy·scipy 휠은 OpenBLAS(BSD-3-Clause)와 libgfortran(GPL-3.0 + GCC 런타임 예외)을 포함한다.

### 2.5 docconv (`docconv/Dockerfile`, 베이스 `debian:trixie-slim`) — AI 도우미 구역

파이썬 패키지는 없다(표준 라이브러리만 사용). apt 및 다운로드로 설치하는 구성 요소:

| 구성 요소 | 라이선스 | 비고 |
|---|---|---|
| LibreOffice (`libreoffice-core-nogui`·`writer`·`calc`·`impress`·`java-common`, trixie-backports) | MPL-2.0 (일부 LGPL-3.0+·Apache-2.0) | 별도 프로세스(`soffice`) |
| H2Orestart v0.8.0 (`H2Orestart.oxt`) | **GPL-3.0** | LibreOffice 확장. 빌드 시 GitHub 릴리스에서 다운로드하여 공용 확장으로 설치한다 |
| `default-jre-headless` (OpenJDK) | GPL-2.0 + Classpath 예외 | |
| `python3` | PSF-2.0 | |
| `fonts-noto-cjk` · `fonts-nanum` · `fonts-liberation2` · `fonts-crosextra-carlito` | OFL-1.1 | |
| `fonts-dejavu-core` | Bitstream Vera 계열 자유 라이선스 | |
| `fonts-crosextra-caladea` | Apache-2.0 | |

### 2.6 installer — 설치 관리자 (`installer/requirements.txt`, 베이스 `python:3.14-slim`)

| 패키지 | 버전 | 라이선스 |
|---|---|---|
| fastapi · starlette · uvicorn · pydantic · httpx · cryptography · python-multipart | backend 와 동일 버전 | 위 표 |
| dnspython | 2.9.2 | ISC |

apt: `docker-ce-cli` · `docker-compose-plugin`(Apache-2.0), `ca-certificates`. 설치 마법사 화면은 frontend-react 소스에서 별도로 빌드한 산출물(`build:installer`)이 포함된다. `release/jwrelease` 의 일부 파일도 복사되며 그 의존성은 `cryptography` 1건이다(`release/requirements.txt`). GPL·LGPL 파이썬 패키지는 없다. 전이 의존성 중 비허용적 라이선스: certifi(MPL-2.0).

### 2.7 audiorelay (`audiorelay/go.mod`, Go 1.27.4) — 회의 구역

| 모듈 | 버전 | 라이선스 |
|---|---|---|
| github.com/coder/websocket | 1.8.15 | ISC |
| github.com/quic-go/quic-go | 0.64.1 | MIT |
| github.com/quic-go/webtransport-go | 0.13.0 | MIT |
| github.com/quic-go/qpack (간접) | 0.6.0 | MIT |
| github.com/dunglas/httpsfv (간접) | 1.1.2 | BSD-3-Clause |
| golang.org/x/{crypto,net,sys,text} (간접) | 0.59.0 · 0.62.0 · 0.50.0 · 0.44.0 | BSD-3-Clause |

`golang:1.27.4-alpine` 에서 정적 빌드(`CGO_ENABLED=0`)하여 `gcr.io/distroless/static-debian13:nonroot` 에 실행 파일 1개만 포함한다. 전부 허용적 라이선스이며, 최종 이미지에 GPL 프로그램은 없다. Go 표준 라이브러리는 BSD-3-Clause 이다.

### 2.8 frontend-react (`frontend-react/package.json`)

`node:26.13.1-alpine` 에서 빌드하여 정적 파일만 `nginxinc/nginx-unprivileged:1.30.6-alpine` 에 포함한다. `dependencies` 는 웹 번들에 포함되어 브라우저로 전송되며, `devDependencies` 는 빌드에만 사용되어 이미지에 포함되지 않는다.

| 패키지 (`dependencies`) | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| react · react-dom | 19.3.1 | MIT | UI |
| react-router | 8.5.1 | MIT | 라우팅 |
| @tanstack/react-query | 5.107.1 | MIT | 서버 상태 |
| zustand | 5.1.0 | MIT | 상태 |
| i18next · react-i18next | 27.1.1 · 18.0.1 | MIT | 다국어 |
| @tiptap/* (core·react·pm·starter-kit·extensions·extension-*) | 3.34.0 | MIT | 편집기 |
| @tiptap/y-tiptap | 3.3.0 | MIT | 공동 편집 바인딩 |
| yjs · y-websocket · y-protocols | 13.6.33 · 3.1.0 · 1.0.7 | MIT | 공동 편집 |
| livekit-client · @livekit/track-processors | 2.24.0 · 0.8.3 | Apache-2.0 | 회의·배경 처리 |
| chart.js · react-chartjs-2 | 4.6.1 · 5.3.1 | MIT | 차트 |
| dompurify | 3.4.17 | MPL-2.0 OR Apache-2.0 | HTML 정화 |
| markdown-it | 15.0.3 | MIT | 마크다운(+ argparse 3.0.4 Python-2.0) |
| shiki | 4.6.0 | MIT | 코드 강조 |
| katex | 0.19.1 | MIT (글꼴 OFL-1.1) | 수식 |
| emojibase-data | 18.0.0 | MIT | 이모지 이름·분류 |
| ofetch | 1.5.1 | MIT | HTTP 클라이언트 |
| clsx · tailwind-merge | 2.1.1 · 3.7.0 | MIT | 클래스 유틸 |
| class-variance-authority | 0.7.1 | Apache-2.0 | 클래스 유틸 |
| vue | 3.5.45 | MIT | Vue 기반 플러그인 화면 실행 |
| @fontsource/ibm-plex-sans-kr · @fontsource/jetbrains-mono | 5.3.0 | **OFL-1.1** | 글꼴 — 4 |

| 패키지 (`devDependencies`, 이미지에 미포함) | 버전 | 라이선스 |
|---|---|---|
| vite · @vitejs/plugin-react · vite-plugin-pwa · vitest | 8.3.8 · 6.3.0 · 2.0.0 · 5.1.0 | MIT |
| tailwindcss · @tailwindcss/vite · @tailwindcss/cli · @tailwindcss/typography | 4.3.5 · 4.3.5 · 4.3.5 · 0.5.20 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| esbuild · eslint · @eslint/js · typescript-eslint · eslint-plugin-react-hooks · globals | 0.28.2 · 10.15.0 · 10.0.1 · 8.72.2 · 7.1.1 · 17.14.0 | MIT |
| @testing-library/dom · react · user-event · happy-dom · @types/* | 10.4.2 · 16.3.3 · 14.6.10 · 21.0.4 | MIT |
| lightningcss (전이) | 1.33.0 | MPL-2.0 — 빌드 도구, 배포물에 미포함 |

`package-lock.json` 의 774개 항목을 전수 확인한 결과 GPL·LGPL·AGPL·SSPL 은 없다. 비허용적 라이선스는 dompurify, lightningcss, 글꼴 2종에 한정된다.

### 2.9 rbi-mirror — 격리 브라우저 미러 모드 세션 이미지 (`rbi/mirror/`)

상세 내용은 [rbi/mirror/THIRD_PARTY.md](rbi/mirror/THIRD_PARTY.md) 에 기술한다. 베이스 `node:22.23.5-bookworm-slim`(다이제스트 고정).

| 구성 요소 | 버전 | 라이선스 | 비고 |
|---|---|---|---|
| playwright-core | 1.65.1 | Apache-2.0 | |
| sharp · @img/sharp-linux-x64 | 0.35.5 | Apache-2.0 | |
| @img/sharp-libvips-linux-x64 | 1.3.4 | **LGPL-3.0-or-later** | libvips 및 이에 포함된 libwebp(BSD-3-Clause)·librsvg(LGPL-2.1+) 등. 별도 공유 라이브러리 |
| ws | 8.23.0 | MIT | |
| chromium · chromium-common (데비안) | 156.0.8078.79-1~deb12u1 | BSD-3-Clause 외 Chromium 고지(내장 FFmpeg 는 LGPL-2.1+) | |
| fonts-liberation2 · fonts-noto-cjk | 2.1.5-1 · 1:20220127+repack1-1 | OFL-1.1 | WOFF2 로 변환·서브셋하여 포함한다 |
| fonts-dejavu-core | 2.37-6 | Bitstream Vera 계열 자유 라이선스 | 〃 |
| iproute2 | 6.1.0-3 | **GPL-2.0** | 별도 실행 파일 |
| ca-certificates | 20250419~deb12u2 | MPL-2.0 · GPL-2.0+ | |

빌드 단계에만 사용되며 최종 이미지에 포함되지 않는 구성 요소: python3-fonttools·python3-brotli(MIT), typescript 7.0.2(Apache-2.0), esbuild 0.28.2·tsx 4.23.15(MIT). `devpages/vendor/` 의 jsPlumb·Bootstrap·Font Awesome 은 `dev` 타깃에만 포함되며 배포 대상인 `prod` 이미지에는 포함되지 않는다.

### 2.10 rbi-netfilter (`deploy/rbi-netfilter/Dockerfile`, 베이스 `debian:13-slim`)

`iptables`(GPL-2.0-or-later), `iproute2`(GPL-2.0), `procps`(GPL-2.0+/LGPL-2.1+) 및 본 프로젝트의 셸·awk 스크립트.

## 3. 컨테이너 이미지

### 3.1 외부 이미지(재배포하지 않음) (`docker-compose.yml`)

전부 원 배포처에서 다이제스트(digest) 고정으로 직접 pull 한다(kasmweb/chromium 만 태그 고정).

| 이미지 | 버전 | 라이선스 | 사용 구역 |
|---|---|---|---|
| `postgres` (alpine) | 16.16 | PostgreSQL License | 기본 |
| `redis` (alpine) | 8.8.4 | RSALv2 / SSPLv1 / AGPL-3.0 삼중 | 기본 |
| `nginx` (alpine) | 1.31.8 | BSD-2-Clause | 기본 |
| `certbot/certbot` | 5.10.0 | Apache-2.0 | 기본(compose 프로파일 `certbot`) |
| `gitea/gitea` | compose 주석 기준 28.3.0 | MIT | 코드 저장소 구역 |
| `livekit/livekit-server` | 1.13.11 | Apache-2.0 | 회의 구역 |
| `livekit/egress` | 1.15.0 | Apache-2.0 (Chrome·GStreamer(LGPL) 등 내장) | 회의 구역 |
| `onlyoffice/documentserver` | 10.0.0.1 | **AGPL-3.0** | 문서 편집 구역 |
| `searxng/searxng` | 2026.11.13 | **AGPL-3.0** | AI 도우미 구역 |
| `kasmweb/chromium` | 1.18.0 | 레시피 MIT · KasmVNC **GPL-2.0** · Chromium BSD-3-Clause 외 · Ubuntu 패키지는 각 라이선스 | 격리 브라우저 픽셀 모드 — compose 에 포함되지 않으며 backend 가 세션마다 기동한다(`RBI_IMAGE`) |

"Kasm" 은 Kasm Technologies 의 상표이며, 본 프로젝트는 Kasm Workspaces 제품을 포함하지 않는다.

### 3.2 mailserver — 외부 이미지의 파생 이미지(재배포)

`mailserver/image/Dockerfile` 은 `mailserver/docker-mailserver` 16.0.1(다이제스트 고정) 에 데비안 보안 업데이트와 Rspamd 업데이트만 적용한다. 결과물은 **본 프로젝트의 레지스트리에 `just-workspace-mailserver` 로 게시되는 파생 이미지**이다.

| 포함 구성 요소 | 라이선스 |
|---|---|
| docker-mailserver 스크립트·설정 | MIT |
| Postfix | IBM Public License 1.0 / EPL-2.0 |
| Dovecot | MIT · LGPL-2.1 |
| Rspamd | Apache-2.0 |
| ClamAV · Amavis · Fail2ban · Postgrey · Fetchmail · getmail | GPL-2.0 계열 |
| SpamAssassin | Apache-2.0 |
| OpenDKIM · OpenDMARC | BSD 계열 |
| Debian 13 OS 구성 요소 | 각 라이선스(3.3) |

원 이미지의 구성 목록은 원 프로젝트 문서에 근거하며, 이미지 내부를 패키지 단위로 대조하지는 않았다.

### 3.3 베이스 이미지

| 베이스 | 사용 이미지 | 포함된 카피레프트 구성 요소 |
|---|---|---|
| `python:3.14-slim` (Debian) | backend · sso · ldap · sandbox · installer | glibc(LGPL-2.1+), bash·coreutils(GPL-3.0+), dpkg·apt(GPL-2.0+) 등. Python 자체는 PSF-2.0 |
| `debian:trixie-slim` · `debian:13-slim` | docconv · rbi-netfilter | 〃 |
| `node:22.23.5-bookworm-slim` (Debian 12) | rbi-mirror | 〃. Node.js 는 MIT |
| `nginxinc/nginx-unprivileged:1.30.6-alpine` | frontend-react | BusyBox(GPL-2.0-only). nginx 는 BSD-2-Clause, musl 은 MIT |
| `gcr.io/distroless/static-debian13:nonroot` | audiorelay | 없음(인증서·시간대 데이터만 포함) |
| `node:26.13.1-alpine` · `golang:1.27.4-alpine` | 빌드 단계 한정 | 최종 이미지에 미포함 |

## 4. 글꼴·아이콘·데이터

| 자산 | 라이선스 | 위치 |
|---|---|---|
| IBM Plex Sans KR (`@fontsource/ibm-plex-sans-kr` 5.3.0) | OFL-1.1 — Copyright 2018 IBM Corp. | 웹 번들(`frontend-react/src/assets/css/main.css`) |
| JetBrains Mono (`@fontsource/jetbrains-mono` 5.3.0) | OFL-1.1 — Copyright 2020 The JetBrains Mono Project Authors | 〃 |
| KaTeX 글꼴 (`katex` 0.19.1) | OFL-1.1 | 웹 번들(수식 렌더링 시 지연 로드) |
| 이모지 데이터 (`emojibase-data` 18.0.0) | MIT (유니코드 CLDR 데이터 포함) | 웹 번들 |
| Nanum · Noto CJK · Liberation · Carlito · DejaVu · Caladea | OFL-1.1 · OFL-1.1 · OFL-1.1 · OFL-1.1 · Bitstream Vera 계열 · Apache-2.0 | sandbox · docconv · rbi-mirror 이미지(데비안 패키지) |
| 선 아이콘 일부 — Lucide 의 도형을 이식한 SVG 경로(Lucide 는 ISC, Feather 유래 부분은 MIT) | ISC · MIT | `frontend-react/src/utils/icons.ts` 에 소스로 포함된다(패키지 의존성이 아님). 아이콘별 출처는 해당 파일의 주석에 기재 |
| 앱 아이콘(`frontend-react/public/icon.svg`, `apps/*/` 의 아이콘·시작 화면) | 본 프로젝트 저작물(MIT) | |

음향 파일은 리포에 없다. 글꼴 파일은 `rbi/mirror/devpages/vendor/fonts/`(Font Awesome 4.7 — OFL-1.1, Bootstrap 3 Glyphicons — MIT 배포물에 포함)에만 있으며, 시험 페이지 전용이므로 배포 이미지에 포함되지 않는다.

## 5. 클라이언트 앱과 플러그인 빌드 도구

컨테이너 이미지가 아닌 설치 파일 형태로 배포된다.

### 5.1 데스크톱 (`apps/desktop/`)

| 구성 요소 | 버전 | 라이선스 | 비고 |
|---|---|---|---|
| electron | 45.3.2 | MIT | 실행 파일에 Chromium(BSD-3-Clause 외)과 FFmpeg(LGPL-2.1+, 별도 공유 라이브러리)이 포함된다 |
| electron-builder · @electron/fuses | 26.18.0 · 2.1.3 | MIT | 빌드 도구 |
| livekit-client | 2.24.0 | Apache-2.0 | |
| ws | ^8.23.0 | MIT | |
| @fails-components/webtransport · webtransport-transport-http3-quiche | 1.6.11 | BSD-3-Clause | 프리빌드 바이너리에 Google quiche(BSD-3-Clause)·BoringSSL(OpenSSL/ISC 계열)·envoy 일부(Apache-2.0) |
| miniaudio (`native/vendor/miniaudio/`, 패치 적용) | 0.11.25 | Unlicense 또는 MIT-0 | 소스를 리포에 포함한다 |
| speexdsp 리샘플러 (`native/vendor/speexdsp/`) | xiph/speexdsp 소스 일부 | BSD-3-Clause(`COPYING`) | 〃 |
| node-addon-api · node-gyp · esbuild · typescript | 8.9.2 · 13.1.0 · 0.28.2 · 7.0.2 | MIT · MIT · MIT · Apache-2.0 | 빌드 도구 |

`package-lock.json` 388개 항목에 GPL·LGPL·MPL 은 없다. Windows SDK 헤더와 MSVC 런타임은 Microsoft 의 재배포 조건이 적용된다. ASIO SDK 는 사용하지 않는다.

### 5.2 모바일 (`apps/mobile/`)

| 구성 요소 | 버전 | 라이선스 |
|---|---|---|
| @capacitor/core · android · ios · cli | ^8.6.2 | MIT |
| @capacitor/preferences · @capacitor/push-notifications | ^8.0.1 · ^8.1.3 | MIT |
| typescript | ^7.0.2 | Apache-2.0 |

`package-lock.json` 122개 항목에 GPL·LGPL·MPL 은 없다. Android 빌드는 `google-services.json` 이 존재하는 경우에만 Google 서비스 Gradle 플러그인(Apache-2.0)을 적용하며, 이 경우 푸시에 사용되는 Firebase·Google Play 서비스 라이브러리에는 Google 의 약관이 적용된다(비오픈소스 부분 포함). 빌드용 이미지(`apps/mobile/builder.Dockerfile` — Temurin JDK, Node.js, Android SDK)는 배포하지 않는다. Android SDK 에는 Google 의 SDK 약관이 적용된다.

### 5.3 플러그인 빌드 도구 (`plugins/package.json`)

marked 18.1.1 · vite ^8.3.4 · vue ^3.5.44 · @vitejs/plugin-vue ^6.0.10 — 전부 MIT.

## 6. 미확인 사항

- 데비안 패키지의 정확한 버전과 패키지별 저작권 파일. Dockerfile 에서 버전을 고정하지 않은 패키지(pandoc, LibreOffice, OpenJDK, iptables 등)는 빌드 시점의 배포판 제공 버전이 설치된다.
- 외부 이미지에 포함된 패키지 목록(docker-mailserver, OnlyOffice, SearXNG, LiveKit Egress, kasmweb/chromium). 이미지 내부를 대조하지 않았다.
- 파이썬 전이 의존성은 리눅스 x86-64 휠 기준으로 해석하여 확인하였다. 다른 아키텍처에서의 차이는 확인하지 않았다.
