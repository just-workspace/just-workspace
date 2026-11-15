# 보안

## 취약점 신고

**보안 취약점은 공개 이슈로 올리지 말아 주세요.** GitHub 의 비공개 취약점 신고 기능으로 알려 주세요.

- 이 리포의 **Security** 탭 → **Report a vulnerability**
  (<https://github.com/just-workspace/just-workspace/security/advisories/new>)

신고에는 가능하면 다음을 적어 주세요.

- 영향받는 버전(관리 화면이나 `/api/health` 에 나오는 버전)과 설치 방식(설치 관리자 / 직접 설치)
- 켜져 있는 구역
- 재현 방법과, 그것으로 무엇을 할 수 있는지
- 알고 있다면 고치는 방법

수정이 나오기 전에는 내용을 공개하지 말아 주세요. 신고는 한국어와 영어 모두 받습니다.

Please do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting (the **Security** tab → **Report a vulnerability**). Reports in English are welcome.

## 지원 버전

| 버전 | 보안 수정 |
|---|---|
| 1.0.x | 첫 공개 릴리스 준비 중 — 릴리스되면 지원합니다 |
| 1.0.0 이전의 소스 | 지원하지 않습니다 |

보안 수정은 가장 최근의 안정판(Stable)에 냅니다. 관리 › 업데이트에서 최신 버전으로 올려 주세요.

## 설치하는 사람이 알아야 할 보안 모델

### 설치 관리자와 backend 는 docker 소켓을 쥔다

- **설치 관리자**(`jw-installer`)는 호스트의 docker 소켓으로 컨테이너를 만들고 바꾼다. 이 컨테이너를 장악하면 서버를 장악한 것과 같다. 그래서 밖으로는 설치 토큰으로 막은 8443 하나만 열고, 설치가 끝나면 그것도 잠그며, 설치 뒤의 동작은 호스트에 게시하지 않는 내부 API(공유 키 + 내부 대역)로만 받는다. 설치가 끝나면 8443 을 방화벽에서 닫아도 된다 — [docs/installer.md](docs/installer.md) 5절.
- **backend** 컨테이너에도 docker 소켓이 붙어 있다(내장 메일 서버의 계정 만들기, 백업, 격리 브라우저 세션 띄우기). 소켓을 읽기 전용으로 붙여도 docker API 의 권한은 줄지 않는다. **backend 에서 임의 코드를 실행할 수 있게 되면 서버 전체가 넘어간다**고 봐야 한다.

### 플러그인 설치는 서버 권한과 같다

플러그인의 backend 코드는 backend 프로세스 안에 그대로 들어와 실행된다. 격리도 서명 검사도 없다. 위의 docker 소켓 때문에 플러그인은 사실상 서버 전체에 닿는다. **출처를 믿을 수 있고 내용을 확인한 플러그인만 설치한다.** 플러그인을 올릴 수 있는 것은 관리자뿐이다 — 관리자 계정을 지키는 것이 곧 서버를 지키는 것이다 ([docs/extensions.md](docs/extensions.md)).

### 관리자 계정

- 관리자에게는 2단계 인증을 켠다(관리 화면에서 필수로 정할 수 있다).
- 관리자 비밀번호를 잃으면 서버 터미널에서 다시 정한다(`docker exec jw-installer jw reset-admin <아이디>`). 서버 터미널에 들어올 수 있는 사람은 관리자가 될 수 있다는 뜻이기도 하다.

### 비밀값

- 비밀값(암호화 키, DB 비밀번호, 구역끼리 쓰는 키)은 설치 관리자가 만든다. 스택의 `.env`(권한 600)에 있고 로그에 찍지 않는다.
- backend 와 SSO·LDAP 컨테이너는 **약한·기본 비밀값이면 뜨지 않는다**(비어 있음, 자리표시자, 널리 알려진 값, 길이 미달). 규칙은 `backend/app/security_defaults.py`, 설명은 [docs/CONFIG.md](docs/CONFIG.md) 3절.
- `SECRET_KEY` 는 DB 안의 값(외부 메일 계정 비밀번호, 2단계 인증 비밀, 저장소·AI 키)을 암호화하는 키다. 새면 그 값들이 새고, 잃으면 그 값들을 풀 수 없다.

### 백업 파일

백업에는 `.env`(암호화 키와 비밀번호)가 들어 있다. **백업 파일을 가진 사람은 서버의 모든 데이터를 읽을 수 있다.** 접근이 제한된 곳에 두고, 필요하면 설정 항목을 암호로 보호한다 — [docs/data-safety.md](docs/data-safety.md).

### 네트워크

- 밖에서 여는 포트는 고른 구역에 필요한 것뿐이다([docs/install.md](docs/install.md#포트)). 데이터베이스·Redis·backend 는 호스트에 게시하지 않는다.
- backend 의 내부 API(`/api/internal/*`)는 nginx 가 밖에서 오는 요청을 막고 키로 지킨다.
- 앞단 프록시 뒤 구성에서 접속자 주소는 설정한 프록시 주소에서 온 `X-Real-IP` 만 믿는다.
- SSO·LDAP 제공 애드온의 평문 LDAP(389)은 기본으로 서버 자신에게만 열린다.

### 업데이트

채널 파일과 릴리스 목록은 서명돼 있고, 설치 관리자는 공개 키로 확인한 것만 적용한다. 이미지는 다이제스트로 받는다. 업데이트 확인은 정적 파일을 받을 뿐이고 서버의 식별자나 통계를 보내지 않는다 — [docs/releases.md](docs/releases.md).

### 아직 확인하지 못한 것

SELinux 가 켜진 배포판에서의 동작, 격리 브라우저 애드온의 실서버 검수 등은 아직 하지 못했다. 전체 목록은 [docs/installer.md](docs/installer.md) 13절.
