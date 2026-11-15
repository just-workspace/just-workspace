# Third-Party Licenses

just-workspace 는 다음 오픈소스 프로젝트를 사용한다. 버전은 2026-10-21 기준 고정 버전(`backend/requirements.txt`, `frontend-react/package.json`,
`docker-compose.yml`)이고, 라이선스는 각 패키지의 배포 메타데이터(PyPI `license`/`License ::` 분류자, npm `license` 필드, 이미지 공식 저장소)로 확인했다.
의존성을 올리면 이 표도 같이 갱신한다.

**비-permissive 항목 요약** — 운영자가 알아야 할 것만:

| 구성요소 | 라이선스 | 위치 | 의미 |
|---|---|---|---|
| aioimaplib 2.0.3 | **GPL-3.0-only** | backend(코어, IMAP 클라이언트) | backend 이미지에 GPL 라이브러리가 들어간다. 자체 운영은 문제 없음. 수정 배포 시 GPL 조건 |
| ldap3 2.9.1 | LGPL-3.0 | backend(코어, 외부 LDAP 로그인) | 라이브러리 사용 — 수정하지 않으면 추가 의무 없음 |
| psycopg 3.3.6 | LGPL-3.0 | ws-ldap | 같음 |
| pywebpush 2.5.0 · py-vapid 1.9.6 | MPL-2.0 | backend(웹 푸시) | 파일 단위 카피레프트 — 수정하지 않으면 추가 의무 없음 |
| dompurify 3.4.17 | MPL-2.0 OR Apache-2.0 | frontend-react | Apache-2.0 선택 가능 |
| @livekit/krisp-noise-filter 0.4.5 | LiveKit 이용약관(비공개) | frontend-react(회의 노이즈 제거) | 오픈소스 아님. LiveKit 의 약관을 따른다 |
| Redis 8.8 | RSALv2 / SSPLv1 / AGPL-3.0 삼중 | 코어 컨테이너 | 자체 운영은 어느 쪽이든 무방 |
| ONLYOFFICE Docs CE 10.0 | AGPL-3.0 | `onlyoffice` 프로파일 | 별도 컨테이너(WOPI 호출) |
| SearXNG | AGPL-3.0 | `aitools` 프로파일 | 별도 컨테이너 |

## 코어 — backend (Python 3.14, `backend/requirements.txt`)

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| FastAPI | 0.143.5 | MIT | 웹 프레임워크 |
| Starlette | 1.8.0 | BSD-3-Clause | ASGI 툴킷(MCP 가 직접 import) |
| uvicorn[standard] | 0.54.0 | BSD-3-Clause | ASGI 서버 |
| httpx | 0.28.1 | BSD-3-Clause | HTTP 클라이언트 |
| PyJWT[crypto] | 2.15.1 | MIT | OAuth/OIDC 토큰(RS256) — python-jose 대체 |
| SQLAlchemy[asyncio] | 2.1.5 | MIT | ORM |
| greenlet | 3.5.6 | MIT AND PSF-2.0 | SQLAlchemy asyncio |
| asyncpg | 0.32.0 | Apache-2.0 | PostgreSQL 드라이버 |
| itsdangerous | 2.2.0 | BSD-3-Clause | 세션 쿠키 서명 |
| pydantic / pydantic-settings | 2.14.1 / 2.16.0 | MIT | 스키마·설정 |
| aiofiles | 25.1.0 | Apache-2.0 | 비동기 파일 I/O |
| python-multipart | 0.0.32 | Apache-2.0 | 업로드 파싱 |
| Pillow | 13.0.0 | MIT-CMU (HPND 계열) | 이미지 처리 |
| slowapi | 0.1.10 | MIT | 레이트 리밋 |
| libpass[bcrypt,argon2] | 1.9.4 | BSD-3-Clause | 비밀번호 해시(passlib 유지 포크, Argon2id) |
| argon2-cffi | 25.1.0 | MIT | Argon2 |
| bcrypt | 5.0.0 | Apache-2.0 | 레거시 해시 검증 |
| livekit-api | 1.2.2 | Apache-2.0 | LiveKit 서버 API·토큰 |
| redis[hiredis] | 8.1.0 | MIT | Redis 클라이언트 |
| aioimaplib | 2.0.3 | **GPL-3.0-only** | IMAP 클라이언트 |
| aiosmtplib | 5.1.3 | MIT | SMTP 클라이언트 |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause | Fernet·TLS·JWK |
| ldap3 | 2.9.1 | LGPL-3.0 | 외부 LDAP/AD 로그인 |
| python-dateutil | 2.9.0.post0 | Apache-2.0 / BSD-3-Clause | 날짜 |
| icalendar | 7.3.0 | BSD-2-Clause | iCalendar |
| vobject | 0.9.9 | Apache-2.0 | vCard |
| pyotp | 2.10.0 | MIT | TOTP |
| qrcode[pil] | 8.2 | BSD-3-Clause | 2FA QR |
| boto3 | 1.43.114 | Apache-2.0 | S3 호환 스토리지 |
| pywebpush / py-vapid | 2.5.0 / 1.9.6 | MPL-2.0 | 웹 푸시 |
| pypdf | 6.21.1 | BSD-3-Clause | PDF 텍스트 추출(색인·첨부) |
| python-docx | 1.2.0 | MIT | docx 텍스트 추출 |
| mcp | 2.3.0 | MIT | MCP 서버 SDK |
| sse-starlette | 3.5.0 | BSD-3-Clause | SSE 전송 |
| pytest · pytest-asyncio · pytest-cov · aiosqlite | 9.1.1 · 1.4.0 · 7.1.0 · 0.22.1 | MIT | 테스트(이미지에 포함되나 런타임 미사용) |

backend 이미지(`python:3.14-slim`, PSF/Debian)에는 Docker CLI(Apache-2.0), gosu(Apache-2.0), pandoc(GPL-2.0+, 문서 변환 외부 프로세스), ffmpeg(LGPL-2.1+/GPL, 미디어 변환 외부 프로세스)가 들어간다.

## ws-sso / ws-ldap (`sso/requirements.txt`, `ldap/requirements.txt`)

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| pysaml2 | 7.5.5 | Apache-2.0 | SAML IdP |
| scim2-models / scim2-filter-parser | 0.12.2 / 0.7.0 | Apache-2.0 / MIT | SCIM |
| ldaptor | 21.2.0 | MIT | LDAP 서버 |
| Twisted[tls] | 26.4.0 | MIT | 비동기 네트워킹(ldaptor) |
| psycopg[binary] | 3.3.6 | LGPL-3.0 | PostgreSQL(ws-ldap) |
| FastAPI · Starlette · uvicorn · SQLAlchemy · asyncpg · pydantic · itsdangerous · httpx | backend 와 동일 버전 | 위 표 | |

## ws-audiorelay — 음성채널 무손실 릴레이 (Go 1.27, `audiorelay/go.mod`)

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| github.com/coder/websocket | 1.8.15 | ISC | WebSocket 전송(폴백) |
| github.com/quic-go/quic-go | 0.62.0 | MIT | QUIC/HTTP3 |
| github.com/quic-go/webtransport-go | 0.13.0 | MIT | WebTransport 서버 |
| github.com/quic-go/qpack | 0.6.0 | MIT | HTTP/3 헤더 압축(간접) |
| github.com/dunglas/httpsfv | 1.1.1 | BSD-3-Clause | 구조화 헤더(간접) |
| golang.org/x/{crypto,net,sys,text} | 0.54 / 0.56 / 0.47 / 0.40 | BSD-3-Clause | 표준 확장(간접) |

이미지: `golang:1.27-alpine` 빌드 → `gcr.io/distroless/static-debian12:nonroot`(Apache-2.0). 모두 permissive.
FLAC 코덱(헤더에 자리만 있음)을 넣을 때 후보는 libflac.js(MIT, libFLAC BSD-3-Clause) — 아직 번들하지 않았다.

## 데스크톱 앱 네이티브 오디오 — 하이레조(`apps/desktop/native`, `apps/desktop/package.json`)

| 구성요소 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| miniaudio (`native/vendor/miniaudio/miniaudio.h`) | 0.11.25 (+ `apply-patch.py` JW_PATCH_R19: exclusive 요청 포맷 우선·실패 HRESULT 보존) | public domain(Unlicense) / MIT-0 이중 — 수정·재배포 자유, 고지 불필요 | WASAPI exclusive/shared 캡처·재생, null 백엔드(테스트) |
| speexdsp 리샘플러 (`native/vendor/speexdsp/resample.c` 외) | git master 2026-10 (xiph/speexdsp) | BSD-3-Clause(`COPYING`) | 수신 스트림 레이트 ≠ 재생 장치 레이트일 때만(비트퍼펙트 아님으로 표시) |
| node-addon-api | 8.9.2 | MIT | Node-API C++ 래퍼(빌드 시) |
| node-gyp | 13.1.0 | MIT | 빌드 도구(배포물에 없음) |
| @fails-components/webtransport | 1.6.11 | BSD-3-Clause | 메인 프로세스 WebTransport 클라이언트(ESM, dynamic import) |
| @fails-components/webtransport-transport-http3-quiche | 1.6.11 (프리빌드 `webtransport.node`, N-API v6, win32-x64 5.3 MB) | BSD-3-Clause(패키지) + Google quiche(BSD-3-Clause, `LICENSE.chromium`) + BoringSSL(OpenSSL/ISC 계열) + envoy 일부(Apache-2.0, `LICENSE.envoy`) | HTTP/3·QUIC 데이터그램 |
| ws | 8.22.0 | MIT | WebSocket 폴백(이미 의존) |

Windows SDK(WASAPI·MMDevice·AudioPolicy 헤더)와 MSVC 런타임은 Microsoft 소프트웨어 라이선스 조건의 재배포 허용 범위(정적 CRT 미사용, 시스템 DLL 의존)에서 쓴다.
ASIO 는 넣지 않았다 — Steinberg ASIO SDK 가 2025-10 GPLv3/독점 이중 라이선스로 바뀌어 비공개 배포 앱은 독점 계약이 필요하다.

## 코어 — frontend-react (`frontend-react/package.json`)

| 패키지 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| React / react-dom | 19.3.1 | MIT | UI |
| react-router | 8.5.1 | MIT | 라우팅 |
| Vite / @vitejs/plugin-react | 8.3.8 / 6.3.0 | MIT | 빌드 |
| TypeScript | 6.0.3 | Apache-2.0 | 타입 |
| Tailwind CSS / @tailwindcss/vite / @tailwindcss/typography | 4.3.5 / 0.5.20 | MIT | 스타일 |
| TipTap (@tiptap/*) / @tiptap/y-tiptap | 3.34.0 / 3.3.0 | MIT | 리치 에디터·공동 편집 바인딩 |
| Yjs / y-websocket / y-protocols | 13.6.33 / 3.1.0 / 1.0.7 | MIT | CRDT 공동 편집 |
| zustand | 5.1.0 | MIT | 상태 |
| @tanstack/react-query | 5.107.1 | MIT | 서버 상태 |
| i18next / react-i18next | 27.1.1 / 18.0.1 | MIT | 다국어 |
| livekit-client / @livekit/track-processors | 2.24.0 / 0.8.3 | Apache-2.0 | WebRTC 클라이언트·배경 처리 |
| @livekit/krisp-noise-filter | 0.4.6 | **LiveKit 이용약관** | 노이즈 제거(비공개 라이선스) |
| chart.js / react-chartjs-2 | 4.6.1 / 5.3.1 | MIT | 관리 차트 |
| dompurify | 3.4.17 | MPL-2.0 OR Apache-2.0 | HTML 새니타이즈 |
| markdown-it | 15.0.3 | MIT | 마크다운 |
| shiki | 4.6.0 | MIT | 코드 하이라이트 |
| ofetch | 1.5.1 | MIT | HTTP 클라이언트 |
| clsx / tailwind-merge / class-variance-authority | 2.1.1 / 3.7.0 / 0.7.1 | MIT / MIT / Apache-2.0 | 클래스 유틸 |
| vite-plugin-pwa | 2.0.0 | MIT | PWA(Workbox) |
| @fontsource/ibm-plex-sans-kr · @fontsource/jetbrains-mono | 5.3.0 | OFL-1.1 | 자체 호스팅 글꼴 |
| vue | 3.5.45 | MIT | v1(Vue) 플러그인 호환 런타임(지연 로드) |
| vitest · @testing-library/* · happy-dom · eslint · typescript-eslint | 5.1.0 · … | MIT | 개발·테스트 |

프런트 컨테이너: `node:26-alpine`(빌드, MIT) → `nginxinc/nginx-unprivileged:1.30-alpine`(BSD-2-Clause).

## 클라이언트 앱 (`apps/`)

| 패키지 | 버전 | 라이선스 |
|---|---|---|
| Electron / electron-builder | 44.9.0 / 26.15.3 | MIT |
| Capacitor (@capacitor/core·android·ios·cli) | 8.5.3 | MIT |
| 플러그인 빌드 도구 (vite 8, vue 3.5, @vitejs/plugin-vue 6, marked 18) | | MIT |

## 컨테이너 (`docker-compose.yml`)

| 이미지 | 버전 | 라이선스 | 활성화 |
|---|---|---|---|
| postgres (alpine) | 16.15 | PostgreSQL License | 항상 |
| redis (alpine) | 8.8.3 | RSALv2 / SSPLv1 / AGPL-3.0 | 항상 |
| nginx (alpine) | 1.31.7 | BSD-2-Clause | 항상 |
| certbot/certbot | 5.8.0 | Apache-2.0 | `certbot` |
| mailserver/docker-mailserver (Postfix · Dovecot · Rspamd) | 16.0.1 기반 자체 빌드 | MIT (Postfix IBM PL / EPL-2.0, Dovecot MIT·LGPL-2.1, Rspamd Apache-2.0) | `mailserver` |
| gitea/gitea | 28.1.0 | MIT | `gitea` |
| livekit/livekit-server | 1.13.10 | Apache-2.0 | `livekit` |
| livekit/egress | 1.15.0 | Apache-2.0 | `egress` |
| onlyoffice/documentserver | 10.0.0 | **AGPL-3.0** | `onlyoffice` |
| searxng/searxng | 2026.10.17 | **AGPL-3.0** | `aitools` |
| just-workspace-audiorelay (자체 빌드, distroless static) | — | MIT(코어) + 위 Go 의존성 | `audiorelay` |
| kasmweb/chromium (격리 브라우저 세션 컨테이너 — 백엔드가 세션마다 띄움, compose 에 없음) | 1.18.0 | 이미지 레시피(kasmtech/workspaces-images) MIT · 안의 KasmVNC **GPL-2.0** · Chromium BSD-3-Clause · Ubuntu 22.04 패키지 각자 | 모듈 `rbi` |
| just-workspace-rbi-netfilter (자체 빌드, debian:13-slim + iptables) | — | iptables GPL-2.0(별도 컨테이너, 호스트 규칙만 적용) | `rbi` |
| just-workspace-rbi-mirror (자체 빌드, 미러 모드 세션 이미지 — 백엔드가 세션마다 띄움, `rbi/mirror/Dockerfile`) | — | 아래 표 | `rbi`(`rbi-build` 로 빌드) |

### 격리 브라우저 미러 모드 세션 이미지 (`rbi/mirror/`, 상세 `rbi/mirror/THIRD_PARTY.md`)

| 구성요소 | 버전 | 라이선스 | 비고 |
|---|---|---|---|
| node (베이스 `node:22.23.5-bookworm-slim`, 다이제스트 고정) | 22.23.5 | MIT · Debian 12 패키지 각자 | 런타임 |
| playwright-core | 1.65.1 | Apache-2.0 | Chromium 소유(CDP 파이프) |
| ws | 8.23.0 | MIT | WebSocket 서버 |
| sharp · @img/sharp-linux-x64 | 0.35.5 | Apache-2.0 | 이미지 WebP 재인코딩 |
| @img/sharp-libvips-linux-x64 (libvips + libwebp BSD-3 · librsvg LGPL-2.1+ 등) | 1.3.4 | **LGPL-3.0-or-later** | 별도 공유 라이브러리로 동적 링크(교체 가능) — 고지 의무만 |
| chromium (Debian 패키지) | 156.0.8078.79-1~deb12u1 | BSD-3-Clause 외 Chromium 고지 | 세션 브라우저(헤드리스) |
| fonts-liberation2 | 2.1.5-1 | OFL-1.1 | 고정 폰트 묶음(WOFF2 로 변환·서브셋 — OFL 은 변환 배포 허용, 예약 이름 없음) |
| fonts-dejavu-core | 2.37-6 | Bitstream Vera / Arev 계열 자유 라이선스 | 〃 |
| fonts-noto-cjk | 1:20220127+repack1-1 | OFL-1.1 | 〃(한글·한자) |
| iproute2 | 6.1.0-3 | GPL-2.0 | 별도 실행 파일(`ss`, 준비 확인용) |
| ca-certificates | 20250419~deb12u2 | MPL-2.0 · GPL-2.0+ | |
| (빌드 단계만) python3-fonttools 4.38 · python3-brotli 1.0.9 | — | MIT · MIT | 폰트 변환, 최종 이미지에 없음 |
| (dev 타깃·시험 페이지만) jsPlumb 2.15.6 · Bootstrap 3.4.1 · Font Awesome 4.7 | — | MIT(jsPlumb 은 MIT/GPL 이중 중 MIT) · MIT · OFL-1.1(폰트)/MIT(CSS) | `rbi/mirror/devpages/vendor/` — prod 이미지에 없음 |

## 호환성 정리

- Just-Workspace 코어 소스는 **MIT**. 다른 컨테이너는 네트워크/WOPI/LDAP 으로만 호출하는 별도 프로세스라 코어의 라이선스에 영향을 주지 않는다 — 단 그 컨테이너를 켜고 배포하는 것은 운영자의 선택이자 책임이다.
- backend 이미지 자체는 GPL(aioimaplib) · LGPL(ldap3) · MPL(pywebpush) 라이브러리를 포함한다. **"코어는 permissive 라이선스만" 이라는 표현은 맞지 않다.** 내부 운영에는 제약이 없고, 수정한 backend 이미지를 재배포한다면 GPL-3.0 조건(소스 제공)을 따라야 한다.
- AGPL(ONLYOFFICE · SearXNG) 컨테이너를 쓰지 않으면 선택 프로파일은 permissive 로만 구성된다(`mailserver`·`gitea`·`livekit`·`audiorelay`·`egress`·`sso`·`certbot`).
- 격리 브라우저(`rbi`)는 kasmweb/chromium 이미지를 **수정 없이** 세션마다 띄우고(KasmVNC 는 GPL-2.0, 네트워크로만 화면을 받는다) 정책 파일 두 개(Chromium 관리 정책 JSON · kasmvnc.yaml)만 컨테이너에 넣는다. 이미지를 재배포하지 않으므로 추가 의무가 없다. 상표: "Kasm" 은 Kasm Technologies 의 상표이며 이 프로젝트는 Kasm Workspaces 제품을 포함하지 않는다.
