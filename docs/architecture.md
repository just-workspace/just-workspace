# 시스템 구조 (Architecture)

본 문서는 Just Workspace 의 구성 요소와 구성 요소 간 연결 관계를 기술한다. 설치 절차는 [install.md](install.md), 용어 정의는 [glossary.md](glossary.md)를 참조한다.

## 개요 (Overview)

```
                         ┌──────────────────────────────────────────────────────────┐
  브라우저·앱 ── 80/443 ─►│ nginx (ws-nginx) — 유일한 웹 진입점                       │
                         │   ├─► frontend-react   React 정적 빌드                    │
                         │   └─► backend          FastAPI · 여러 워커                │
                         │         로그인 · 관리 · 파일 · 대시보드 · 실시간 소켓 ·      │
                         │         구역별 API · 플러그인                             │
                         │                                                          │
                         │   postgres            redis                              │
                         ├──────────────────────────────────────────────────────────┤
                         │ 구역이 켜는 컨테이너                                       │
                         │   메일      mailserver                                   │
                         │   문서 편집  onlyoffice                                   │
                         │   회의      livekit · egress · audiorelay                │
                         │   코드 저장소 gitea                                       │
                         │   AI 도우미  searxng · docconv · sandbox                  │
                         │   애드온     sso · ldap / rbi-netfilter                   │
                         │   (인증서 자동 발급) certbot                              │
                         └──────────────────────────────────────────────────────────┘
                                          ▲ docker compose · 내부 API(8444)
  설치할 때만 ── 8443 ──► 설치 관리자 (jw-installer) — 설치 · 구역 · 업데이트 · 인증서
```

- 단일 서버, 단일 Docker Compose 프로젝트(`just-workspace`)로 구성된다. 컨테이너 이름에는 접두사 `ws-` 를 사용한다.
- 웹 진입점은 내장 nginx 하나다. 이 서버가 TLS 를 직접 종단하거나(443), 프런트 프록시 하단에서 80 평문으로 수신한다. 메일·회의·Git SSH·LDAP 은 각자의 포트를 호스트에 직접 게시한다.
- 컨테이너는 내부 대역(기본 `172.28.0.0/24`)의 고정 주소를 사용한다.
- 이미지와 버전의 단일 출처는 `docker-compose.yml` 이다. 외부 이미지는 다이제스트(digest)로 고정한다.
- 컨테이너는 `no-new-privileges` 로 기동하며, backend 는 기동 후 비루트 사용자로 권한을 낮춘다. 프런트는 비특권 nginx 다.

## 설치 관리자

설치와 이후의 구성 변경을 담당하는 별도 컨테이너(`jw-installer`, 소스는 `installer/`)다. 호스트의 docker 소켓을 마운트해 compose 를 호출한다. 상세는 [installer.md](installer.md)를 참조한다.

- **설치 마법사**(8443, HTTPS, 설치 토큰): 입력값을 받아 스택 파일(`.env`, nginx 설정 조각, 회의 서버 설정 등)을 생성하고 단계별로 적용한다. 설치가 완료되면 잠긴다. 화면은 `frontend-react/src/installer-app/` 의 독립 번들이다.
- **내부 API**(8444, 호스트에 게시하지 않음): 설치 이후의 구역 활성화·비활성화, 업데이트, 인증서 재발급을 제공한다. backend(`backend/app/system/`)가 관리자 권한을 확인한 후 공유 키로 대리 호출한다. 브라우저는 이 포트에 접근할 수 없다.
- **단일 출처를 복제하지 않는다.** 구역 선언(`zones.json`), 비밀값 규칙(`security_defaults.py`), compose 와 nginx 설정은 이미지 빌드 시 리포에서 복사해 포함한다.
- 설치 관리자 없이 구성한 설치([deployment.md](deployment.md))에서는 backend 의 `JW_INSTALLER_URL` 이 비어 있으며, 관리 화면의 구역·업데이트·인증서 카드는 읽기 전용이다.

## 구역

설치 및 활성화·비활성화의 단위다. 선언은 `backend/app/zones.json` 단일 파일이며 설치 마법사·설치 관리자·backend 가 동일한 파일을 읽는다.

| 항목 | 위치 |
|---|---|
| 구역 id, 이름, 소유 모듈, compose 프로파일·서비스, 권장 메모리, 포트, 프리셋 | `backend/app/zones.json` |
| API 라우터·백그라운드 루프·소켓 처리기의 구역 귀속 | `backend/app/zones.py` 의 `ROUTERS` · `LOOPS` · `SOCKET_HANDLERS` |
| 설치된 구역 | 환경변수 `JW_ZONES`(쉼표 구분, 비우면 전체). `GET /api/health` 의 `zones` 로 제공된다 |
| 구역의 컨테이너 | `COMPOSE_PROFILES`(구역의 `compose_profiles` 합집합) |
| 구역 활성화 시의 설치·연동 동작 | `installer/app/zones/` 의 구역 훅([installer.md](installer.md) 10절) |

- 설치되지 않은 구역의 라우터와 루프는 **등록되지 않는다**(API 404). 해당 구역의 모듈은 목록에서 제외된다.
- 채팅·일정과 같이 컨테이너가 없는 구역은 backend 내부 기능이다.
- 음성 채널은 채팅과 회의가 모두 설치된 경우에만 등록된다(표의 `chat+meetings`).
- 구역을 활성화·비활성화하면 설치 관리자가 `.env` 의 `JW_ZONES`·`COMPOSE_PROFILES` 를 변경하고 backend 를 재기동한다.

### 모듈

구역 내의 화면 단위다(`backend/app/modules/registry.py`). 내장 모듈은 `mail` `chat` `ai` `meetings` `files` `calendar` `contacts` `git` `board` `tasks` `wiki` `rbi` 다. 관리자는 모듈을 비활성화하거나 그룹별로 접근을 제한할 수 있다 — 설치된 구역 범위 내의 표시·접근 제어다.

```
GET   /api/platform/modules        켜진 모듈 + 플러그인 목록
PATCH /api/admin/modules/{id}      모듈 켜고 끄기(관리자)
```

비활성화된 모듈은 메뉴에 표시되지 않으며, API 는 403 을 반환하고 페이지 진입은 대시보드로 리다이렉트된다.

## 프런트엔드

`frontend-react/` — React 19 · React Router 8 · Vite 8 · TypeScript 6 · Tailwind CSS 4 · TipTap 3 + Yjs(위키 공동 편집) · zustand · TanStack Query · i18next(한국어·영어) · livekit-client.

- 정적 빌드를 컨테이너 내의 비특권 nginx 가 제공한다. 보안 헤더와 CSP 는 전단의 `ws-nginx` 가 추가한다.
- 빌드 대상은 세 가지다: 워크스페이스(`npm run build`), 격리 브라우저 단독 화면(`build:rbi`), 설치 마법사(`build:installer` — 설치 관리자 이미지에 포함된다).
- 화면 문구는 `src/i18n/locales/`(본 앱)와 `src/installer-app/i18n/`(설치 마법사)에 있다.
- 모바일 폭은 `matchMedia('(max-width: 767px)')` 를 기준으로 하며 높이에는 `dvh` 를 사용한다.

## 백엔드

`backend/` — Python 3.14 · FastAPI · SQLAlchemy 2(asyncio) + asyncpg · pydantic 2 · Redis. 버전은 `backend/requirements.txt`(전부 고정)에 명시한다.

- **다중 워커.** `uvicorn --workers N`(`BACKEND_WORKERS`, 기본은 코어 수 기준 2~8). 프로세스 메모리에 상태를 보관하지 않는다 — 세션, 회의 상태, OAuth 코드, 잠금은 Redis 에 저장한다.
- **백그라운드 작업**(파일 색인, 일정 알림, 메일 확인, 휴지통 정리 등)은 잠금을 획득한 단일 워커가 수행한다. 구역 소속 작업은 해당 구역이 설치된 경우에만 등록된다.
- **접속자 주소.** backend 는 `ws-nginx`(내부 대역의 `.2`)에서 수신한 연결의 `X-Forwarded-For` 만 신뢰한다. nginx 는 설정된 프록시 주소에서 수신한 연결에 한해 `X-Real-IP` 를 접속자 주소로 채택한다.
- **비밀값 검사.** 취약하거나 기본값인 비밀값으로는 기동하지 않는다(`backend/app/security_defaults.py`, [CONFIG.md](CONFIG.md) 3절).
- **docker 소켓.** backend 컨테이너에 docker 소켓이 마운트된다 — 내장 메일 서버의 계정 생성, 백업, 격리 브라우저 세션 기동에 사용한다([SECURITY.md](../SECURITY.md)).

### 스키마 버전

DB 구조에는 버전 번호가 부여된다(`schema_migrations` 표, 코드가 요구하는 번호는 `backend/app/db/schema_version.py`). 변경은 번호가 부여된 단계로만 수행한다(`backend/app/db/migrations.py`) — 단계 하나가 하나의 트랜잭션이며 역방향 단계는 두지 않는다.

- 적용 명령은 `python -m app.cli migrate` 다. PostgreSQL 의 세션 잠금을 획득한 단일 프로세스만 수행한다.
- 컨테이너 기동 시 워커보다 먼저 1회 적용한다. 적용에 실패했거나 DB 가 코드보다 최신 버전이면 **서버가 기동하지 않는다.**
- 설치·업데이트 시에는 설치 관리자가 일회용 컨테이너로 먼저 적용한다. 업데이트가 실패하면 이전 이미지와 직전 백업의 DB 로 롤백한다.

상세와 백업 형식은 [data-safety.md](data-safety.md)를 참조한다.

## 실시간 전송

- **실시간 소켓 `/ws/chat`** 하나로 알림·배지·통화 상태·채팅 등 모든 실시간 이벤트를 전달한다(`backend/app/realtime/socket.py`). 경로 이름과 달리 **기본 구역 소속**이므로 채팅 구역이 없어도 등록된다.
- 이벤트 발행 지점은 `backend/app/realtime/events.py` 하나다(`emit_to_user`, `emit_to_channel`). 워커 간 전달에는 Redis Pub/Sub 을 사용한다.
- 클라이언트가 송신하는 프레임은 `type` 으로 구분한다. `ping` 은 소켓이 처리하고 나머지는 구역이 등록한 처리기로 전달한다(`zones.py` 의 `SOCKET_HANDLERS` — 현재는 채팅). 처리기가 없는 종류에는 오류 프레임으로 응답한다.
- 인증 토큰은 주소가 아니라 `Sec-WebSocket-Protocol` 헤더로 전송한다(`jw.bearer, jw.token.<base64url>`). 쿠키 세션도 허용한다.
- 위키 공동 편집은 `/ws/wiki/collab`(Yjs 릴레이, `backend/app/collab/`)이며 워커 간 전달은 Redis 로 중계한다.
- 무손실 오디오는 별도 릴레이 컨테이너(`audiorelay`, Go)가 WebTransport(UDP 4433) 또는 WebSocket 으로 전송한다 — [voice-lossless.md](voice-lossless.md).

## 인증

- **자체 로그인.** Argon2id 비밀번호 해시, TOTP 2단계 인증과 복구 코드, 서명된 세션 쿠키 + Redis 의 세션 목록(기기별 조회·원격 로그아웃).
- **OAuth 2.0 / OpenID Connect 제공자**(`backend/app/auth/oauth_provider.py`): 인가 코드 + PKCE, 리프레시 토큰 교체, 동의 화면, RS256 ID 토큰과 JWKS, 동적 클라이언트 등록(RFC 7591). 코드 저장소의 로그인 연동, MCP 커넥터, 데스크톱 앱이 이를 사용한다. 사전 등록 클라이언트는 `OAUTH_CLIENTS_JSON` 으로 지정한다([CONFIG.md](CONFIG.md) 4절).
- **외부 LDAP/AD 로그인**(`ldap_client.py`): 외부 디렉터리로 인증하는 기능이다.
- **SSO·LDAP 제공 애드온**: `sso` 컨테이너(SAML IdP · SCIM — backend 의 세션을 확인해 재발행한다)와 `ldap` 컨테이너(이 워크스페이스가 LDAP 서버로 동작한다. 비밀번호 검증은 backend 의 내부 API 에 위임한다).
- **backend 내부 API** `/api/internal/*`: 메일 서버의 로그인 검증, LDAP 컨테이너, 설치 관리자의 알림이 사용한다. `INTERNAL_API_KEY` 로 보호하며, nginx 가 외부에서 유입되는 요청을 404 로 차단한다.
- **앱 비밀번호.** CalDAV·CardDAV 는 앱 비밀번호만 허용한다. 내장 메일 서버의 로그인에는 워크스페이스 비밀번호를 그대로 사용한다.

## 구역별 구성

### 파일 (기본)

- 저장소는 backend 컨테이너의 `/storage` 에 마운트되는 볼륨이다. 해당 볼륨이 로컬 디스크인지 NFS 인지는 설치 관리자가 볼륨 생성 시 결정한다(compose 는 해당 볼륨을 `external` 로 사용한다). S3 호환 저장소는 관리 화면에서 설정한다.
- 설치 관리자는 저장소 루트에 저장소 마커 파일을 기록하며, backend 는 마커가 확인되지 않으면 파일 쓰기를 거부한다([installer.md](installer.md) 8절).
- 업로드는 스트리밍 방식이다(nginx 가 본문을 버퍼링하지 않는다). 공유 링크, 댓글, 권한, 활동 기록, 할당량, 휴지통, 본문 색인을 제공한다.

### 메일

- 기본은 클라이언트 방식이다: 사용자가 외부 메일 계정(IMAP/POP3/SMTP, OAuth2)을 연결한다. 계정의 비밀번호는 `SECRET_KEY` 에서 파생한 키로 암호화해 DB 에 저장한다.
- 내장 메일 서버(`mailserver` 컨테이너 — docker-mailserver 에서 파생한 이미지: Postfix · Dovecot · Rspamd)를 사용하면 계정 승인 시 메일함이 함께 생성되며, Dovecot 이 backend 에 비밀번호 검증을 요청한다.

### 문서 편집·위키·게시판

- 문서·시트·발표 자료 편집은 **OnlyOffice Document Server** 가 담당한다. backend 가 WOPI 호스트(`/api/wopi/*`)이며, 편집기는 동일 출처의 `/onlyoffice/` 경로에서 제공된다.
- 위키(Yjs 공동 편집)와 게시판은 backend 내부 기능이다.

### 회의

- LiveKit 서버: UDP 7882-7892(미디어), TCP 7881(UDP 가 차단된 참가자용), 내장 TURN(UDP 3478 + TLS).
- TURN/TLS 는 클라이언트에 항상 443 으로 광고한다. 이 서버의 nginx 가 443 을 사용하는 구성에서는 호스트의 5349 에 게시된다([installer.md](installer.md) 8절).
- 녹화는 LiveKit Egress, 무손실 오디오는 `audiorelay` 가 담당한다.

### 코드 저장소

- Gitea 는 `/git/` 경로에서 제공되며 SSH 는 호스트의 2222 를 사용한다. DB 는 워크스페이스 PostgreSQL 내의 별도 데이터베이스(`gitea`)다.
- 로그인은 워크스페이스의 OpenID Connect 로 수행한다. backend 는 관리 토큰으로 Gitea API 를 호출한다.

### AI 도우미

- 내장 AI 채팅(`backend/app/ai`)은 외부 AI 제공자에 연결한다. 도구 호출은 사용자의 확인을 거친다.
- 웹 검색은 `searxng`, 문서 변환은 `docconv`(LibreOffice), 코드 실행은 `sandbox` 컨테이너가 담당한다. `docconv` 와 `sandbox` 는 네트워크가 없으며 backend 와 유닉스 소켓으로만 통신한다.
- MCP 서버(`backend/app/mcp`)는 워크스페이스의 데이터를 외부 AI 클라이언트에 도구로 제공한다 — [CONNECTOR.md](CONNECTOR.md).

### 격리 브라우저 (애드온)

backend 가 세션마다 일회용 브라우저 컨테이너를 기동하며, `rbi-netfilter` 가 호스트의 방화벽 규칙으로 해당 세션의 외부 송신(egress)을 제한한다 — [rbi.md](rbi.md).

## 플러그인

`plugins/<이름>/` 의 `manifest.json`, backend 라우터, 프런트 번들로 구성되는 확장 모듈이다. backend 가 기동 시 탐색해 라우터를 등록하며, 프런트는 번들을 런타임에 로드한다. 관리 › 모듈·플러그인에서 패키지 파일을 업로드해 설치할 수도 있다. **플러그인은 backend 프로세스 내에서 서버 권한으로 실행된다.**

프런트 번들의 계약은 두 가지다: v2(React — 신규 플러그인의 기본, 견본은 `plugins/remote-desktop`)와 v1(Vue — 견본 `plugins/sample-notes`). manifest 의 `zones` 에 명시한 구역이 설치되어 있지 않으면 해당 플러그인은 등록되지 않는다.

계약은 [extensions.md](extensions.md), [plugin-frontend.md](plugin-frontend.md), [frontend-react/docs/plugin-v2.md](../frontend-react/docs/plugin-v2.md)를 참조한다.

## 업데이트 및 릴리스

- 릴리스는 이미지 집합과 그 목록 파일(manifest)이다. 서명된 채널 파일이 최신 버전을 고지한다 — [releases.md](releases.md).
- 설치 관리자가 채널을 주기적으로 조회하며, 관리자가 시작하면(또는 자동으로) 백업 → 이미지 pull → DB 변경 → 교체 → 검증 순으로 적용한다. 설치 관리자 자신도 새 이미지로 교체된다 — [update-system.md](update-system.md), [installer.md](installer.md) 16절.
- 업데이트 진행 중에는 nginx 가 마커 파일을 확인해 일반 요청을 차단한다(점검 모드).

## 클라이언트 앱

- 데스크톱: Electron 셸(`apps/desktop`)이 서버의 웹 화면을 그대로 표시한다.
- 모바일: Capacitor(`apps/mobile`).

→ [apps/README.md](../apps/README.md)

## 포트

| 포트 | 용도 | 사용 조건 |
|---|---|---|
| 80 | nginx | 항상 |
| 443 | nginx(TLS) | 이 서버가 TLS 를 직접 종단하는 경우. 프런트 프록시 하단 구성에서는 회의의 TURN/TLS 가 사용한다 |
| 25, 465, 587, 993 | 메일 서버(IMAP 은 TLS 인 993 만 게시한다) | 메일 구역(내장 메일 서버) |
| 2222 (`GIT_SSH_PORT`) | Git SSH | 코드 저장소 구역 |
| 7882-7892/udp, 7881, 3478/udp | 회의 미디어 · TCP 대체 경로 · TURN | 회의 구역 |
| 5349 | 회의의 TURN/TLS | 회의 구역 + 이 서버가 TLS 를 직접 종단하는 경우 |
| 4433/udp | 무손실 오디오(WebTransport) | 회의 구역 + 무손실 오디오 |
| 636, (`LDAP_PLAIN_BIND`)389 | LDAPS, 평문 LDAP(기본은 서버 자신에 한정) | SSO·LDAP 제공 애드온 |
| 8443 | 설치 마법사 | 설치 관리자(설치가 완료되면 잠긴다) |
| 내부 전용 | backend 8000 · 프런트 3000 · postgres 5432 · redis 6379 · 설치 관리자 내부 API 8444 등 | — |

## 라이선스

→ [licensing.md](licensing.md) · [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md)
