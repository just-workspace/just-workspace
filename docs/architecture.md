# Architecture Guide

## 시스템 구성

```
┌────────────────────────────────────────────────────────────────┐
│                        Docker Compose (단일 노드)                │
├────────────────────────────────────────────────────────────────┤
│  [코어 — 항상 실행]                                              │
│  nginx :80 ──┬─► frontend-react :3000  React 정적 빌드           │
│   (ws-nginx) │     (nginx-unprivileged)                          │
│              └─► backend :8000  FastAPI · uvicorn 멀티 워커       │
│                    인증 · 메일 · 캘린더 · 연락처 · 파일 · 채팅 ·    │
│                    회의 · 게시판 · 위키 · 할 일 · AI · Git API ·    │
│                    WebSocket · DAV · WOPI · MCP · 플러그인 로더     │
│                                                                  │
│  postgres :5432 (16)      redis :6379 (8)                        │
│                                                                  │
│  [선택 — COMPOSE_PROFILES]                                       │
│  mailserver · gitea · livekit · egress · onlyoffice · sso        │
│  (ws-sso + ws-ldap) · logging (vector · loki · grafana ·          │
│  healthprobe) · aitools (searxng) · certbot                      │
└────────────────────────────────────────────────────────────────┘
```

- 외부 진입점은 `ws-nginx` :80 하나다. TLS 는 앞단 리버스 프록시(external_proxy)나 certbot(standalone)이 종단한다.
- 컨테이너 버전은 `docker-compose.yml` 이 단일 출처다(이미지 digest 고정). 이 문서의 숫자는 그 요약이다.
- 컨테이너는 전부 `no-new-privileges`, backend 는 `gosu` 로 비루트(appuser) 강등, 프런트는 비특권 nginx(uid 101).

## 설계 원칙

- 단일 서버, `docker compose up` 한 번. 무거운 구성요소는 프로파일로 켠다.
- 자체 인증 — 외부 IdP 의존 없음. 반대로 **우리가 IdP 가 된다**(OAuth 2.0 / OIDC, 선택 SAML·SCIM·LDAP).
- 채팅·캘린더·연락처·게시판·위키·할 일·AI 는 backend 에 내장 — 추가 컨테이너 불필요.
- 메일은 IMAP/SMTP/POP3 클라이언트 모델. 자체 메일 서버는 선택 프로파일.
- 모듈 시스템 — 관리자가 기능별 on/off, 그룹별 접근 권한(RBAC).
- 플러그인 — 리빌드 없이 런타임 로딩(v1 Vue · v2 React).

## 프런트엔드

`frontend-react/` — React 19 · React Router 8 · Vite 8 · TypeScript 6 · Tailwind CSS 4(CSS-first, `src/assets/css/app.css`) ·
TipTap 3 + Yjs(위키 공동 편집) · zustand · TanStack Query · i18next(ko/en) · livekit-client(지연 로드) · vite-plugin-pwa.

- 정적 빌드를 컨테이너 안 nginx-unprivileged 가 서빙한다(`/assets/` immutable, HTML no-cache, SPA fallback). 보안 헤더·CSP 는 앞단 `ws-nginx` 가 붙인다.
- Vue(Nuxt 3) 에서 전환했다. Vue 컨테이너와 소스 폴더 `frontend/` 는 더 이상 없다. `ws-nginx` 는 `/_nuxt/` 에 404 를 돌려준다.
- 유동 레이아웃: 1280 ~ 8K 폭까지 본문 폭·대시보드 열 수가 따라간다. 설정 › 표시에서 화면 배율을 고를 수 있다(실효 폭 1280 미만이면 배율 비활성).
- 모바일은 `matchMedia('(max-width: 767px)')` 기준(`useIsMobile`), 하단 탭바, 셸 전환 애니메이션. 뷰포트는 `dvh` 기준(h-screen 금지).

## 백엔드

`backend/` — Python 3.14 · FastAPI 0.143 · Starlette · SQLAlchemy 2.1(asyncio) + asyncpg · pydantic 2 · Redis 8(redis-py) · uvicorn 0.54.

- **멀티워커**: `uvicorn --workers N`(`BACKEND_WORKERS`, 기본은 CPU 수 기준 2~8). 프로세스 메모리에 상태를 두지 않는다 — 세션 레지스트리·회의 메타·메일 첨부·OAuth 코드·헬스 결과·파일 잠금은 Redis.
- `init_db()` 는 PostgreSQL **세션 advisory lock** 안에서 돈다 — 워커 8개가 동시에 `create_all`·`ALTER` 를 돌려 충돌하던 것을 막는다(채팅 마이그레이션은 별도 트랜잭션 락).
- 서비스 헬스 체크(`/api/services`)는 락을 잡은 워커 하나만 점검하고 결과를 Redis 에 올린다. 나머지 워커는 저장본을 읽는다.
- 웹 푸시 VAPID 키는 env(`VAPID_PUBLIC_KEY/PRIVATE_KEY`) → DB(`system_settings` `push.vapid`) 순으로 찾고, 없으면 만들어 DB 에 저장한다 — 워커마다 다른 키가 생기지 않는다.
- 클라이언트 IP 신뢰 경계: `--proxy-headers --forwarded-allow-ips 172.28.0.2`(ws-nginx 고정 IP). nginx 는 앞단 RP 연결일 때만 `X-Real-IP` 를 승격하고 XFF 를 **덮어써** 넘긴다.
- 백그라운드 작업(한 워커가 락을 잡고 실행): 파일 색인, 캘린더 리마인더, 메일 폴러/아카이브, 접속 로그 플러시, 휴지통 보존 정리.

## 모듈 시스템

모든 기능은 **모듈**로 등록된다(`backend/app/modules/registry.py`). 관리자가 개별 on/off 할 수 있다.

```
GET   /api/platform/modules        → 활성 모듈 + 플러그인 목록 (인증 불필요, Redis 60초 캐시)
PATCH /api/admin/modules/{id}      → 모듈 on/off (admin)
```

내장 모듈(12): `mail` `chat` `ai` `meetings` `files` `calendar` `contacts` `git` `board` `tasks` `wiki` `rbi`.
오피스(WOPI)는 파일 모듈 안에 있고 `onlyoffice` 프로파일이 있을 때 동작한다. `rbi`(격리 브라우저)는 기본 꺼짐 —
`rbi` 프로파일(호스트 netfilter 사이드카)과 함께 켠다([rbi.md](rbi.md)).

**구역(zone)**: 설치 단위는 모듈보다 큰 구역이다 — 선언은 `backend/app/zones.json`(구역 id·소유 모듈·compose 프로파일),
어느 라우터·백그라운드 루프가 어느 구역 것인지는 `backend/app/zones.py` 의 표. 환경변수 `JW_ZONES`(쉼표 구분, 비우면 전부)에
없는 구역은 라우터와 루프가 아예 올라오지 않고(API 404), 그 구역의 모듈은 목록에서 빠져 켤 수도 없다. 모듈 on/off 는
설치된 구역 안에서의 표시·접근 제어다. 설치된 구역 목록은 `GET /api/health` 의 `zones` 로 내려간다.

비활성 모듈은 네비게이션에서 숨고, API 는 `403 이 기능은 비활성화되어 있습니다`, 페이지 진입은 대시보드로 보낸다.

```
1. 앱 시작 → init_db() → load_module_states(db)
2. 프런트 부팅 → GET /api/platform/modules → platformStore
3. 사이드바 레일 → enabledModules 기반 동적 메뉴 (플러그인은 manifest order 순)
4. 라우터 가드(src/router/guards.ts) → 비활성 모듈 페이지 차단
5. @require_module 데코레이터 → API 레벨 차단
6. 그룹 권한(RBAC) → 모듈·플러그인별 접근 그룹 (관리 › 그룹/권한)
```

## 인증

```
로그인 폼 → POST /api/auth/login
  → Argon2id 검증 (libpass CryptContext: argon2 기본, bcrypt_sha256·bcrypt 는 검증만·deprecated)
  → 레거시 bcrypt 해시는 verify_and_update 로 로그인 시 Argon2id 로 자동 이관
  → TOTP 2단계 (pyotp, 복구 코드, 관리자가 필수 대상을 off/admins/all 로 지정)
  → 서명 세션 쿠키 ws_session (itsdangerous, httponly·SameSite=lax) + Redis 세션 레지스트리
     (sid 별 IP/UA/last-seen, per-user token_version — 원격 로그아웃 즉시 반영, Redis 장애 시 fail-open)
```

- **OAuth 2.0 / OIDC 제공자**(`app/auth/oauth_provider.py`): 인가 코드 + PKCE, 리프레시 토큰 회전·재사용 탐지, 동의 화면,
  RS256 ID 토큰 + JWKS(`/oauth/jwks.json`), 루트 `/.well-known/openid-configuration`·`oauth-authorization-server`,
  **동적 클라이언트 등록**(RFC 7591, `/oauth/register`, `OAUTH_DYNAMIC_CLIENTS_MAX`). 정적 클라이언트는 `OAUTH_CLIENTS_JSON`.
  Gitea SSO 와 claude.ai MCP 커넥터, 데스크톱 앱(public client + 루프백 리다이렉트, 내장 `desktop-app`)이 이걸 쓴다.
- **LDAP/AD 로그인**(`ldap_client.py`, ldap3): 외부 디렉터리로 인증하는 컨슈머. `ws-ldap` 과 방향이 반대다.
- **ws-sso**(profiles: sso, `sso/`): SAML IdP · SCIM. 사용자를 소유하지 않고 backend 의 `ws_session` 을 검증해 재발행만 한다.
  별도 컨테이너인 이유는 pysaml2 → `cryptography<44` 의존성 충돌.
- **ws-ldap**(profiles: sso, `ldap/`): 우리가 LDAP **서버**가 되는 쪽(ldaptor/Twisted, 389/636 LDAPS 자체 서명 인증서 보존).
  비밀번호 검증은 backend `/api/internal/*` 에 `INTERNAL_API_KEY` 로 위임. `/api/internal/` 은 nginx 가 외부에서 404 로 막는다.
- **앱 비밀번호**: DAV(CalDAV/CardDAV) 는 앱 비밀번호만 받는다. `DAV_ALLOW_ACCOUNT_PASSWORD=true` 일 때만 계정 비밀번호를 허용하되
  2단계 인증을 켠 사용자는 제외된다. 메일(Dovecot) 로그인은 `/api/internal/mail-auth` 로 워크스페이스 비밀번호를 그대로 쓴다.
- 비밀번호 정책(`password_policy.py`, 흔한 비밀번호 목록), 로그인 보호·세션 정책(`security_policy.py`), nginx `limit_req`(auth 5r/s).

## 실시간

- 채팅·알림 WebSocket `/ws/chat` — 워커 간 전파는 Redis Pub/Sub.
- **인증 토큰은 쿼리스트링이 아니라 `Sec-WebSocket-Protocol` 헤더**로 보낸다(`jw.bearer, jw.token.<base64url>`; 서버는 `jw.bearer` 로 응답).
  쿠키 세션도 그대로 받는다. 쿼리 토큰은 nginx error_log·Loki 에 평문으로 남아서 폐기했다.
- 알림은 소켓 이벤트가 실시간을 맡고, 5분 폴링은 끊김 보정용이다.
- 위키 공동 편집 `/ws/wiki/collab` — Yjs 릴레이(`app/collab/relay.py`), 워커를 가로질러 Redis 로 중계.

## 메일

- 기본은 클라이언트 모델: `mail_accounts` 에 계정별 IMAP/SMTP/POP3 정보(Fernet 암호화, `SECRET_KEY` 파생), 멀티 계정,
  Gmail·M365 OAuth2(`mail/oauth.py`), 자동 서버 감지(Outlook식 추가), 스레드, 예약 발송, 필터 규칙, 외부 메일 `.eml` 아카이브 → 파일 검색 편입.
- `aioimaplib`(IMAP) · `aiosmtplib`(SMTP) · 자체 `pop3_client.py`.
- 자체 메일 서버(`mailserver` 프로파일, docker-mailserver 기반 Postfix·Dovecot·Rspamd): `FEATURE_BUILTIN_MAILSERVER=true` 면 가입 승인 시
  계정 자동 생성(`docker exec`, 소켓 읽기전용), Dovecot 은 lua passdb 로 backend 에 비밀번호를 물어본다 — 워크스페이스 비밀번호가 곧 메일 비밀번호.

## 파일·오피스

- 스토리지 백엔드는 로컬 파일시스템(기본) 또는 S3 호환(`storage.backend=s3`, boto3). 스트리밍 업로드(1MB 청크, nginx `proxy_request_buffering off`, 10GB 상한),
  공유 링크(비밀번호·만료·횟수), 파일 댓글·4단계 권한, 활동 로그, 사용자 할당량, 휴지통 보존 기간, 전문 색인(`files/indexer.py`).
- 오피스 편집은 **OnlyOffice Document Server(WOPI)** 하나다(2026-10-15 자체 .jwdoc/.jwsheet 편집기 폐기, Collabora 는 그 전에 제거).
  - backend 가 WOPI Host(`/api/wopi/*`, 토큰 TTL `WOPI_TOKEN_TTL`), 잠금은 Redis(TTL 30분), 잠금 키·file_id 에 소유자 포함, 보기 토큰은 잠금 조작 불가.
  - 에디터 URL 은 WOPI discovery 로 동적 생성, 같은 출처 iframe(`/onlyoffice/` 서브패스, CSP `frame-ancestors 'self'`).
  - "새 문서"는 빈 docx/xlsx/pptx 템플릿(`POST /api/wopi/new`). 공유 링크 같이 편집: `/s/<token>` → `POST /api/wopi/shared/{token}/open`(손님 `guest-xxxx`).
  - OnlyOffice 10.0 부터 WOPI 되가져오기는 사설 주소가 **ipfilter 규칙에 명시**돼야 한다 — compose 가 `IP_FILTER_RULES="allow ${RP_LAN_IP};allow all"` 로 넣는다.

## 화상회의

- LiveKit SFU(`livekit` 프로파일): UDP 7882-7892, ICE TCP 7881 폴백, 내장 TURN(UDP 3478 + **TLS 443**). LiveKit 은 클라이언트에 `turns:<domain>:443` 으로 광고하므로
  `tls_port` 는 반드시 443 — standalone(nginx 가 443)에서는 `LIVEKIT_TURN_TLS_PUBLISH=127.0.0.1:4443` 으로 비켜 둔다.
- 녹화는 **LiveKit Egress**(`egress` 프로파일, 헤드리스 크롬 룸 합성 → `egress-out` 볼륨 mp4, backend 가 `/recordings` 로 서빙). 합성 녹화 1건이 cpu 4 를 요구해 compose 한도는 cpu 4 / 4G.
- 비밀번호 입장, 게스트 승인(대기실), 호스트 검증 토큰, 미니 통화 창, 노이즈 제거(krisp), 안드로이드 Telecom 통화 연동.

## 플러그인 시스템

런타임 플러그앤플레이 — 프런트 리빌드 없이 추가/제거. 자세한 계약은 [extensions.md](extensions.md), [plugin-frontend.md](plugin-frontend.md), [frontend-react/docs/plugin-v2.md](../frontend-react/docs/plugin-v2.md).

```
1. plugins/<name>/ 에 manifest.json + backend/router.py (+ models.py) + frontend/dist/plugin.mjs
2. backend 기동 → 자동 발견 → api_prefix 에 라우터 마운트 + 모듈 등록(order 로 메뉴 순서)
3. 프런트 → /api/plugin-assets/{id}/bundle.mjs 를 ETag 캐시로 import()
4. v1(Vue) 번들은 window.__VUE__ 를 지연 로드해 마운트, v2(React) 번들은 window.__REACT__ 와 호스트 UI 키트 window.__WS_UI__('@jw/ui') 를 쓴다
5. 상단바 확장 window.__WS_SHELL__ (버튼·칩·제목), SDK app.plugins.sdk (라우터·DB·사용자·MCP 도구 등록)
6. 관리 › 플러그인에서 .zip 업로드 설치(/plugins-data 볼륨) → backend 자동 재시작
```

## AI · MCP

- 내장 AI 채팅(`app/ai`): Ollama · OpenAI 호환 · Anthropic 프로바이더, 사용자별 API 키, 도구 호출 확인 게이트(`tool_confirm.py`), SearXNG 웹 검색(`aitools` 프로파일).
- MCP 서버(`app/mcp`): Streamable HTTP(`/api/mcp`, `/api/mcp/read`) + 레거시 SSE, OAuth Bearer(`aud`·`scope`) 또는 PAT(`wsmcp_…`, `mcp:read` 한정).
  읽기 도구 18개(파일·메모·메일·채팅·게시판·캘린더·연락처·할 일·웹 검색), `mcp:write` 는 `notes_create` 하나이고 `/api/mcp/write` 는 아직 404. → [CONNECTOR.md](CONNECTOR.md)

## 관제 (logging 프로파일)

```
컨테이너 stdout ─▶ Vector(docker_logs) ─▶ Loki ─▶ Grafana (LAN 포트 3001 에만 게시)
healthprobe(alpine, 5분) ─▶ JSON 한 줄 stdout ─▶ 같은 경로
```

Grafana 는 공인 경로에 두지 않는다 — `GRAFANA_BIND`(기본 127.0.0.1) 로 네트워크 레벨에서 막는다.

## 클라이언트 앱

- 데스크톱: Electron 44 셸(`apps/desktop`), 서버 웹을 `WebContentsView` 로 얹고 트레이·알림·화면 공유·OS 자격 증명 저장소만 네이티브. RFC 8252 시스템 브라우저 로그인.
- 모바일: Capacitor 8(`apps/mobile`), Android APK 는 서버에서 빌드·게시(`/api/apps/android`), iOS 는 소스만. → [apps/README.md](../apps/README.md)

## 데이터베이스

단일 PostgreSQL 16: `workspace` DB(앱 전체) + `gitea` DB(같은 인스턴스, 별도 database). 스키마는 기동 시 `init_db()` 가 `create_all` + 경량 마이그레이션으로 맞춘다.

## 포트 맵

| 포트 | 서비스 | 조건 |
|------|--------|------|
| 80 | ws-nginx (유일한 웹 진입점) | 항상 |
| 443 | standalone 모드의 nginx TLS / external_proxy 모드의 LiveKit TURN-TLS | DEPLOY_MODE 에 따라 |
| 25, 465, 587 | Postfix | `mailserver` |
| 143, 993 | Dovecot | `mailserver` |
| 2222 (`GIT_SSH_PORT`) | Gitea SSH | `gitea` |
| 7882-7892/udp, 7881/tcp, 3478/udp | LiveKit 미디어 · ICE TCP · TURN UDP | `livekit` |
| 636 (+ `LDAP_PLAIN_BIND`:389) | ws-ldap (컨테이너 안은 1636/1389). 평문 389 는 기본으로 루프백에만 게시 | `sso` |
| 3001 (`GRAFANA_BIND`) | Grafana — LAN 전용 | `logging` |
| 172.28.0.1:임시포트 (`RBI_PUBLISH_IP`) | 격리 브라우저 세션의 KasmVNC 6901 — workspace 브리지 게이트웨이에만 게시, ws-nginx 출발지만 통과(netfilter). 공인·LAN 포트 없음 | 모듈 `rbi` |
| 내부만 | backend 8000 · frontend(-react) 3000 · postgres 5432 · redis 6379 · gitea 3000 · onlyoffice 80 · searxng 8080 · sso 8000 · livekit 7880 · loki 3100 | — |

## 의존성 라이선스

→ [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) · [licensing.md](licensing.md)
