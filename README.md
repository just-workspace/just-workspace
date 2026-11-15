# Just-Workspace

> Self-hosted all-in-one workspace — Mail, Meetings, Chat, Docs/Sheets/Slides, Files, Calendar, Contacts, Git, AI

자체 서버에서 운영하는 올인원 협업 워크스페이스입니다. 메일·화상회의·채팅·문서·파일·일정·연락처·Git·AI 를
하나의 계정과 하나의 웹 앱으로 묶습니다. 배포는 Docker Compose 단일 노드이며, 무거운 구성요소는
프로파일로 골라 켭니다.

## 빠른 시작

> 설치 방식은 Docker 기반 웹 설치 마법사로 개편 중(문서 준비 중)

| 배포 모드 | 용도 |
|-----------|------|
| **External Proxy** | 앞단 리버스 프록시가 TLS 종단, 워크스페이스는 HTTP :80 |
| **Standalone** | Let's Encrypt 자동 — 인증서가 나오면 HTTPS(:443)로 전환 |
| **Development** | HTTP, TLS 없음 (IP·localhost) |

### 수동 설치

```bash
cp .env.example .env
# 도메인 등을 채우고, 비어 있는 비밀값(SECRET_KEY, DB_PASSWORD …)은 생성기로 채운다.
# 빈 값·예시 값·짧은 값으로는 백엔드가 뜨지 않는다(docs/CONFIG.md "비밀값").
# backend 이미지를 먼저 빌드한다(비밀값 생성기가 그 안에 있다). 비밀값이 아직 비어 있는 동안에는
# `docker compose build` 가 필수 변수 검사에 걸리므로 docker build 로 직접 빌드한다.
docker build -t localhost/just-workspace-backend:latest ./backend
docker run --rm -v "$PWD/.env:/work/.env" localhost/just-workspace-backend:latest \
  python -m app.cli gen-secrets --merge /work/.env --in-place
# 파일 저장소 볼륨 — compose 는 이 이름(STORAGE_VOLUME)의 볼륨을 이미 있는 것으로 쓴다(NFS 등으로 바꿔 만들 수 있게).
docker volume create ws-storage-data
cp livekit/livekit.example.yaml livekit/livekit.yaml   # livekit 프로파일을 쓸 때
docker compose config --quiet && docker compose up -d
```

## 구성

**코어 (항상 실행)** — `nginx` (유일한 진입점 :80) · `frontend-react` (React 정적 빌드, nginx-unprivileged) · `backend` (FastAPI, uvicorn 멀티 워커) · `postgres` 16 · `redis` 8

**선택 (`COMPOSE_PROFILES`)**

| 프로파일 | 내용 |
|----------|------|
| `mailserver` | 자체 메일 서버 (docker-mailserver 16 — Postfix · Dovecot · Rspamd). 워크스페이스 비밀번호가 곧 메일 비밀번호 |
| `gitea` | Git 호스팅 (Gitea 28, `/git/` 서브패스, 워크스페이스 OIDC 자동 가입) |
| `livekit` | 화상회의 SFU (LiveKit 1.13) + 내장 TURN (UDP 3478 · TLS 443) |
| `egress` | 회의 녹화 (LiveKit Egress 1.15, cpu 4) |
| `onlyoffice` | docx/xlsx/pptx 공동 편집 (OnlyOffice Docs 10.0, WOPI, AGPL) |
| `sso` | SAML/SCIM (`ws-sso`) + LDAP 디렉터리 (`ws-ldap`, LDAPS 636) |
| `aitools` | SearXNG 웹 검색 (AGPL) |
| `certbot` | 메일/TURN 인증서 (standalone 은 웹 인증서까지) |

채팅·캘린더·연락처·문서·게시판·위키·할 일·AI 는 backend 에 내장되어 추가 컨테이너가 필요 없습니다.

## 기능

| 영역 | 내용 |
|------|------|
| **계정·인증** | 자체 인증 — Argon2id (레거시 bcrypt 는 로그인 시 자동 이관), 이메일 인증 + 관리자 승인제 가입, 재설정 링크, TOTP 2FA (관리자가 필수 지정), 기기별 세션 관리·원격 로그아웃, 앱 비밀번호 (DAV) |
| **권한** | 그룹/팀 + 모듈·플러그인별 접근 권한(RBAC), 관리자가 모듈 on/off |
| **ID 제공자** | OAuth 2.0 / OpenID Connect (RS256·JWKS, 동의 화면, 동적 클라이언트 등록 RFC 7591), LDAP/AD 인증 연동, SAML/SCIM + LDAP 서버 (선택 `sso`) |
| **메일** | 내장 메일 서버 또는 외부 IMAP/POP3/SMTP (Gmail·M365 OAuth2, 자동 서버 감지), 멀티 계정, 스레드·예약 발송·필터 규칙, 외부 메일 .eml 보관 + 파일 검색 편입 |
| **화상회의** | LiveKit, 화면 공유, 노이즈 제거, 비밀번호 입장, 게스트 승인(대기실), 미니 통화 창, 자동 재접속, 녹화 (선택 `egress`) |
| **채팅** | 채널·DM·스레드, 멘션·리액션·키워드 알림, 파일 첨부, 채널 탭(파일·위키·회의·작업), 웹훅, 실시간 (WebSocket + Redis Pub/Sub) |
| **문서·시트·슬라이드** | OnlyOffice (WOPI) — docx·xlsx·pptx 공동 편집, 새 문서 만들기, 공유 링크로 로그인 없이 같이 편집 |
| **파일** | 웹 파일 브라우저, 공유 링크(비밀번호·만료), 파일 댓글·4단계 권한, 활동 로그, 할당량·휴지통 보존, 전문 색인 검색, S3 호환 스토리지(선택) |
| **캘린더·연락처** | 반복 일정(RRULE)·리마인더·공유·.ics 구독, 주소록 + 외부 계정 동기화·vCard, CalDAV/CardDAV (앱 비밀번호) |
| **협업** | 게시판, 위키 (Yjs 공동 편집), 할 일 (하위 작업·체크리스트), 홈 대시보드 (카드 배치 편집·AI 브리핑), 활동 피드 |
| **Git** | Gitea 연동 (저장소·이슈·라벨·PR·코드 뷰어) |
| **AI** | 내장 AI 채팅 (Ollama / OpenAI 호환 / Anthropic), 사용자별 API 키, 도구 호출 확인 게이트, MCP 서버 — claude.ai 커스텀 커넥터로 노출 ([docs/CONNECTOR.md](docs/CONNECTOR.md)) |
| **검색** | Ctrl+K 커맨드 팔레트, 7개 모듈 통합 검색 |
| **플러그인** | 런타임 로딩 (리빌드 없이 추가/제거), v1 Vue · v2 React 계약, 패키지 업로드 설치, SDK ([docs/extensions.md](docs/extensions.md)) |
| **운영** | 웹 최초 설정 마법사, 앱 내 백업/복원, 관리자 패널(감사 로그·보안 정책·저장소·서비스 상태) |
| **클라이언트** | PWA, 모바일 (Capacitor 8, Android APK 서버 빌드·게시 / iOS 소스), 데스크톱 (Electron 44) — [apps/](apps/README.md) |
| **화면** | 전 페이지 다크 UI, 1280~8K 유동 레이아웃, 화면 배율, 한/영 |

## 기술 스택

| 분류 | 기술 |
|------|------|
| 프론트엔드 | React 19, React Router 8, Vite 8, TypeScript 6, Tailwind CSS 4, TipTap 3 + Yjs, zustand, TanStack Query, livekit-client — nginx-unprivileged 정적 서빙 |
| 백엔드 | Python 3.14, FastAPI 0.143, SQLAlchemy 2.1 (async) + asyncpg, pydantic 2, uvicorn 멀티 워커, libpass(Argon2id), PyJWT, MCP SDK 2 |
| 데이터 | PostgreSQL 16, Redis 8 (세션·Pub/Sub·잠금·캐시) |
| 실시간 | WebSocket (토큰은 `Sec-WebSocket-Protocol`) + Redis Pub/Sub, Yjs 릴레이 |
| 화상회의 | LiveKit (WebRTC SFU) + Egress 녹화, 내장 TURN |
| 배포 | Docker Compose |

## 운영

미리 빌드한 이미지로 설치: `JW_IMAGE_SOURCE=pull JW_REGISTRY=<registry> JW_VERSION=<tag>` — [docs/IMAGES.md](docs/IMAGES.md)

## 문서

| 문서 | 내용 |
|------|------|
| [docs/CONFIG.md](docs/CONFIG.md) | 설정 변수 |
| [docs/deployment.md](docs/deployment.md) | 배포 |
| [docs/architecture.md](docs/architecture.md) | 구조 |
| [docs/IMAGES.md](docs/IMAGES.md) | 미리 빌드한 이미지 |
| [docs/update-system.md](docs/update-system.md) | 업데이트 |
| [docs/extensions.md](docs/extensions.md) · [docs/plugin-frontend.md](docs/plugin-frontend.md) · [frontend-react/docs/plugin-v2.md](frontend-react/docs/plugin-v2.md) | 플러그인 (백엔드 SDK · 프런트 제약 · v2 React 계약) |
| [docs/CONNECTOR.md](docs/CONNECTOR.md) | claude.ai MCP 커넥터 |
| [docs/rbi.md](docs/rbi.md) | 격리 브라우저(RBI) — 구조·보안 모델·설정·격리 검증 |
| [apps/README.md](apps/README.md) · [apps/desktop/README.md](apps/desktop/README.md) | 모바일 · 데스크톱 앱 |
| [docs/licensing.md](docs/licensing.md) | 라이선스 |

## 라이선스

[MIT](LICENSE). 코어 소스는 MIT 이고 대부분의 의존성은 permissive(MIT·BSD·Apache) 입니다. 예외는 명시합니다:
backend 의 IMAP 클라이언트 `aioimaplib` 은 GPL-3.0, `ldap3`·`psycopg` 는 LGPL-3.0, Redis 8 은 RSALv2/SSPL/AGPL 삼중.
ONLYOFFICE·SearXNG(AGPL) 는 선택 프로파일로 기본 비활성이며 켜면 각자의 라이선스를 따릅니다.
→ [docs/licensing.md](docs/licensing.md) · [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
