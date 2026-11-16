# 보안 정책 (Security Policy)

## 보안 취약점 신고 절차

**보안 취약점은 공개 이슈로 등록하지 아니한다.** GitHub 의 비공개 취약점 신고 기능으로 접수한다.

- 본 리포의 **Security** 탭 → **Report a vulnerability**
  (<https://github.com/just-workspace/just-workspace/security/advisories/new>)

신고에는 가능한 범위에서 다음 사항을 기재한다.

- 영향을 받는 버전(관리 화면 또는 `/api/health` 에 표시되는 버전)과 설치 방식(설치 관리자 / 수동 설치)
- 활성화된 구역
- 재현 방법 및 그로 인한 영향
- 수정 방안(파악된 경우)

수정본이 배포되기 전까지 신고 내용을 공개하지 아니한다. 신고는 한국어 또는 영어로 접수한다.

Security vulnerabilities are not to be reported in public issues. They are to be submitted through GitHub's private vulnerability reporting (the **Security** tab → **Report a vulnerability**). Reports may be submitted in English.

## 지원 버전

| 버전 | 보안 수정 |
|---|---|
| 1.0.x | Stable 1.0.0 공개 이후 지원한다 |
| 1.0.0-beta.N | 최신 Beta 에 한하여 수정한다(Beta 채널) |
| 1.0.0 이전의 소스 | 지원하지 않는다 |

보안 수정은 최신 Stable 버전에 대하여 제공한다. 관리 › 업데이트에서 최신 버전으로 업데이트하여야 한다.

## 보안 모델

설치 담당자와 운영자가 숙지하여야 할 사항이다.

### 설치 관리자와 backend 의 docker 소켓 접근 권한

- **설치 관리자**(`jw-installer`)는 호스트의 docker 소켓을 통해 컨테이너를 생성·변경한다. 이 컨테이너가 탈취되면 서버 전체가 탈취된 것과 동일하다. 따라서 외부에는 설치 토큰으로 보호되는 8443 포트만 개방하고, 설치 완료 후에는 이 또한 잠그며, 설치 이후의 동작은 호스트에 게시하지 않는 내부 API(공유 키 + 내부 대역)로만 수신한다. 설치 완료 후에는 방화벽에서 8443 포트를 차단하여도 무방하다 — [docs/installer.md](docs/installer.md) 5절.
- **backend** 컨테이너에도 docker 소켓이 마운트된다(내장 메일 서버의 계정 생성, 백업, 격리 브라우저 세션 기동). 소켓을 읽기 전용으로 마운트하더라도 docker API 의 권한은 축소되지 않는다. **backend 에서 임의 코드 실행이 가능해지면 서버 전체가 탈취된 것으로 간주하여야 한다.**

### 플러그인 설치의 권한 범위

플러그인의 backend 코드는 backend 프로세스 내부에서 직접 실행된다. 격리 및 서명 검증은 적용되지 않는다. 상기 docker 소켓으로 인하여 플러그인은 사실상 서버 전체에 대한 접근 권한을 갖는다. **출처를 신뢰할 수 있고 내용을 검증한 플러그인만 설치한다.** 플러그인 설치 권한은 관리자에게만 부여된다 — 관리자 계정의 보호는 곧 서버의 보호에 해당한다([docs/extensions.md](docs/extensions.md)).

### 관리자 계정

- 관리자 계정에는 2단계 인증을 활성화한다(관리 화면에서 필수로 지정할 수 있다).
- 관리자 비밀번호를 분실한 경우 서버 터미널에서 재설정한다(`docker exec jw-installer jw reset-admin <아이디>`). 이는 서버 터미널 접근 권한을 가진 자가 관리자 권한을 획득할 수 있음을 의미한다.
- 최초 관리자는 서버 터미널에 접근할 수 있는 자만 생성할 수 있다. 설치 관리자로 설치한 서버에서는 설치 관리자가 생성하며, 웹의 최초 관리자 생성(`POST /api/setup/admin`)은 관리자가 존재하지 않는 동안에도 차단된다. 수동으로 기동한 서버에서는 backend 로그에 1회 출력되는 일회용 설정 토큰이 있어야 웹에서 생성할 수 있다(해시로만 저장, 관리자 생성 시 폐기, 시도 횟수 제한) — [docs/deployment.md](docs/deployment.md#최초-관리자-계정-생성). 로그를 수집·보관하는 체계가 있는 경우 해당 로그의 열람 권한을 가진 자도 관리자 생성 전까지 그 토큰을 확인할 수 있으므로, 수동으로 기동한 서버에서는 기동 직후 관리자를 생성하여야 한다.

### 비밀값

- 비밀값(암호화 키, DB 비밀번호, 구역 간 공유 키)은 설치 관리자가 생성한다. 스택의 `.env`(권한 600)에 저장되며 로그에 출력하지 않는다.
- backend 와 SSO·LDAP 컨테이너는 **취약하거나 기본값인 비밀값이 설정된 경우 기동하지 않는다**(공백, 자리표시자, 널리 알려진 값, 길이 미달). 규칙은 `backend/app/security_defaults.py`, 설명은 [docs/CONFIG.md](docs/CONFIG.md) 3절에 있다.
- `SECRET_KEY` 는 DB 에 저장되는 값(외부 메일 계정 비밀번호, 2단계 인증 비밀, 저장소·AI 키)의 암호화 키이다. 유출 시 해당 값이 유출되며, 분실 시 해당 값을 복호화할 수 없다.

### 백업 파일

백업에는 `.env`(암호화 키와 비밀번호)가 포함된다. **백업 파일을 보유한 자는 서버의 모든 데이터를 열람할 수 있다.** 접근이 통제된 위치에 보관하고, 필요한 경우 설정 항목을 암호로 보호한다 — [docs/data-safety.md](docs/data-safety.md).

### 네트워크

- 외부에 개방하는 포트는 선택한 구역에 필요한 포트로 한정된다([docs/install.md](docs/install.md#포트)). 데이터베이스·Redis·backend 는 호스트에 게시하지 않는다.
- backend 의 내부 API(`/api/internal/*`)는 nginx 가 외부 요청을 차단하며 키로 보호된다.
- 프런트 프록시 하단 구성에서 접속자 주소는 설정된 프록시 주소로부터 수신한 `X-Real-IP` 만 신뢰한다.
- SSO·LDAP 제공 애드온의 평문 LDAP(389)은 기본값으로 서버 자신에게만 개방된다.

### 업데이트

채널 파일과 릴리스 목록은 서명되어 있으며, 설치 관리자는 공개 키로 검증한 대상만 적용한다. 이미지는 다이제스트(digest)로 pull 한다. 업데이트 확인은 정적 파일의 조회에 한정되며 서버의 식별자나 통계를 전송하지 않는다 — [docs/releases.md](docs/releases.md).

### 미검증 항목

SELinux 가 활성화된 배포판에서의 동작, 격리 브라우저 애드온의 실서버 검수 등은 수행되지 않았다. 전체 목록은 [docs/installer.md](docs/installer.md) 13절에 있다.
