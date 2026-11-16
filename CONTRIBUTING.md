# 기여 안내

버그 신고, 기능 제안, 문서 수정, 코드 모두 환영합니다.

- 문서와 코드 주석은 **한국어가 기본**입니다. 영어로 쓴 이슈와 PR 도 환영합니다 — 번역은 함께 맞춰 가면 됩니다.
- Issues and pull requests in English are welcome. Docs and code comments are written in Korean by default; we can sort out translation together during review.
- **보안 취약점은 이슈로 올리지 말고** [SECURITY.md](SECURITY.md) 의 방법으로 알려 주세요.

## 이슈

- 버그: 버전, 설치 방식(설치 마법사 / 직접 설치), 켜져 있는 구역, 재현 순서, 관련 로그를 적어 주세요. 로그 보는 법은 [docs/operate.md](docs/operate.md#7-로그).
- 기능 제안: 무엇이 필요한지와 왜 필요한지를 먼저 적어 주세요. 큰 변경은 코드를 쓰기 전에 이슈로 이야기하는 편이 좋습니다.

## 리포 구조

| 폴더 | 내용 |
|---|---|
| `backend/` | 서버(FastAPI). 구역 선언 `app/zones.json`, 구역별 라우터 표 `app/zones.py` |
| `frontend-react/` | 웹 화면(React). 설치 마법사는 `src/installer-app/` |
| `installer/` | 설치 관리자(설치·구역·업데이트·인증서) |
| `release/` | 릴리스 도구(채널·목록 파일·서명·오프라인 묶음) |
| `sso/` · `ldap/` | SSO·LDAP 제공 애드온 |
| `docconv/` · `sandbox/` | AI 도우미 구역의 문서 변환·코드 실행 컨테이너 |
| `audiorelay/` | 무손실 오디오 릴레이(Go) |
| `rbi/` · `deploy/rbi-netfilter/` | 격리 브라우저 애드온 |
| `mailserver/` | 내장 메일 서버의 이미지와 설정 |
| `nginx/` · `init/` · `scripts/` · `livekit/` | compose 가 붙이는 설정과 스크립트 |
| `plugins/` | 플러그인 빌드 도구와 견본 |
| `apps/` | 데스크톱·모바일 앱 |
| `docs/` | 문서 |

구조는 [docs/architecture.md](docs/architecture.md), 낱말은 [docs/glossary.md](docs/glossary.md).

## 개발 환경과 테스트

**리포 안에 가상 환경·캐시를 만들지 않습니다.** 파이썬 가상 환경은 리포 밖에 둡니다. 아래의 `<venv>` 는 그 경로입니다.

### backend

Python 3.14(이미지 기준).

```bash
python -m venv <venv>
<venv>/bin/pip install -r backend/requirements-dev.txt
cd backend && <venv>/bin/python -m pytest -q
```

파이썬을 따로 깔지 않고 이미지로 돌릴 수도 있습니다. 테스트 도구는 운영 이미지(`runtime` 대상)에 없고 `test` 대상에만 있습니다. 테스트 코드는 이미지에 넣지 않으므로 리포를 붙여서 돌립니다(일부 테스트는 리포의 문서·다른 폴더를 읽습니다).

```bash
docker build --target test --build-context licenses=. -t just-workspace-backend-test backend
docker run --rm --entrypoint python -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$PWD:/src:ro" -w /src/backend just-workspace-backend-test -m pytest -q -p no:cacheprovider
```

DB 는 임시 SQLite 파일로 대신합니다(`backend/tests/conftest.py`). 실제 PostgreSQL 이 필요한 테스트는 환경변수 `JW_TEST_PG_URL` 이 있을 때만 돕니다.

### 프런트엔드

```bash
cd frontend-react
npm ci
npm run typecheck      # tsc
npm run lint           # eslint
npm test               # vitest
npm run build          # 워크스페이스 화면
npm run build:installer  # 설치 마법사 화면
```

개발 서버는 `npm run dev`(워크스페이스), `npm run dev:installer`(설치 마법사, 3002).

### 설치 관리자

```bash
<venv>/bin/pip install -r installer/requirements-dev.txt
cd installer && <venv>/bin/python -m pytest -q
```

docker 없이 돕니다(docker·DNS·HTTP 는 가짜로 바꿉니다). 답변에서 나오는 파일의 스냅샷은 `installer/tests/snapshots/` 에 있고, 의도한 변경이면 `JW_UPDATE_SNAPSHOTS=1` 로 다시 만듭니다. 실제 서버에서 하는 검수는 [docs/installer.md](docs/installer.md) 13절.

### 릴리스 도구

```bash
<venv>/bin/pip install -r release/requirements-dev.txt
cd release && <venv>/bin/python -m pytest
```

docker·네트워크 없이 돕니다. **compose 의 이미지 구성을 바꾸면** `release/tests/test_compose.py` 의 스냅샷과 `test_workflow.py` 가 깨집니다 — `.github/workflows/build-images.yml` 의 매트릭스와 함께 고칩니다([docs/releases.md](docs/releases.md)).

### 전체를 띄워 보기

- 소스로 이미지를 빌드해 설치 관리자로 설치: [docs/install.md](docs/install.md#소스에서-빌드해-설치)
- 설치 관리자 없이 compose 로: [docs/deployment.md](docs/deployment.md)

지원하는 환경은 리눅스 x86_64 + Docker Engine 입니다.

## 무엇을 고칠 때 무엇을 함께 고치나

| 바꾸는 것 | 함께 볼 것 |
|---|---|
| 구역 추가·변경 | `backend/app/zones.json`(선언) → `backend/app/zones.py`(라우터·루프 표) → `docker-compose.yml`(프로파일·서비스) → 필요하면 `installer/app/zones/<구역>.py`(구역 훅, [docs/installer.md](docs/installer.md) 10절) → 화면 문구(`frontend-react/src/installer-app/i18n/`, `src/i18n/locales/`). `backend/tests/test_zones.py` 와 설치 관리자의 스냅샷이 지킵니다 |
| 환경변수 추가 | `backend/app/config.py` 또는 `docker-compose.yml`, `.env.example`, 설치 관리자가 써야 하면 `installer/app/render.py` 와 [docs/installer.md](docs/installer.md) 8절의 표, [docs/CONFIG.md](docs/CONFIG.md) |
| 비밀값 추가 | `backend/app/security_defaults.py`(규칙과 생성 대상) |
| DB 구조 변경 | 번호 붙은 변경 단계로만 — [docs/data-safety.md](docs/data-safety.md) 1절의 "변경 단계 작성법" |
| compose 의 이미지·빌드 설정 | 빌드 워크플로의 매트릭스, `release/tests/` |
| 화면 문구 | 한국어(`ko.json`)와 영어(`en.json`)를 함께. 문서의 낱말은 화면과 같게([docs/glossary.md](docs/glossary.md)) |
| 플러그인 | [docs/extensions.md](docs/extensions.md) · [docs/plugin-frontend.md](docs/plugin-frontend.md) · [frontend-react/docs/plugin-v2.md](frontend-react/docs/plugin-v2.md). 견본은 `plugins/sample-notes`(v1, Vue)와 `plugins/remote-desktop`(v2, React — 새 플러그인의 기본) |

## 커밋과 PR

- 커밋 메시지는 **`영역: 무엇을 했는가`** 꼴로 씁니다. 영역은 "설치 관리자", "설치 마법사", "백엔드", "프런트", "문서", "테스트", "릴리스 도구"처럼 사람이 읽는 낱말입니다. 예:
  - `설치 관리자: 승격한 릴리스의 설치 관리자도 제품 버전을 알게`
  - `문서: 백업에서 복원(API·설정 병합 규칙·단계·무인 예시)`
- 한 커밋에는 한 가지 일을 담습니다. 동작을 바꾸면 테스트와 문서를 같은 PR 에서 함께 고칩니다.
- 줄바꿈은 LF 입니다.
- PR 에는 무엇을 왜 바꿨는지, 어떻게 확인했는지를 적습니다. **돌려 본 것과 돌려 보지 못한 것을 구분해 적어 주세요.**
- 비밀값, 실제 운영 주소·도메인·이름을 코드와 문서에 넣지 않습니다. 예시는 `workspace.example.com`, `192.168.10.x`, `203.0.113.x` 를 씁니다.
- 새 의존성을 넣을 때는 라이선스를 확인하고 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) 를 함께 고칩니다. AGPL-3.0 과 함께 배포할 수 없는 라이선스(오픈소스가 아닌 것, GPL-2.0 "만"인 라이브러리를 같은 프로세스에서 불러 쓰는 경우 등)의 의존성은 받지 않습니다. GPL·LGPL·MPL 계열은 PR 에 따로 적어 주세요([docs/licensing.md](docs/licensing.md)).

## 라이선스

이 리포는 [GNU Affero General Public License 버전 3 또는 그 이후 버전](LICENSE)(`AGPL-3.0-or-later`)으로 배포합니다.

## 기여 조건

PR 을 올릴 때 템플릿의 확인란("기여 조건을 읽었고 동의합니다")에 표시하면 아래에 동의한 것으로 봅니다.

1. **라이선스.** 기여물은 이 프로젝트의 라이선스(AGPL-3.0-or-later)로 제공됩니다.
2. **권리의 확인.** 기여자는 그 기여물을 제공할 권리가 있음을 확인합니다 — 직접 작성했거나 제공할 권한이 있고, 고용주 등 다른 사람이 권리를 가진 저작물이면 허락을 받았습니다.
3. **재허가 권한.** 기여자는 기여물의 저작권을 그대로 가집니다. 다만 프로젝트 저작권자(리포의 [LICENSE](LICENSE)·[NOTICE](NOTICE)에 적힌 Just-Workspace)에게, 그 기여물을 이 프로젝트의 일부로서 **다른 라이선스 조건으로도 배포하고 재허가할 수 있는** 전 세계적·영구적·비독점적·무상·취소 불가능한 권리를 줍니다. 기여물에 기여자의 특허가 걸려 있으면, 그 기여물을 쓰는 데 필요한 범위에서 같은 조건의 허락을 함께 줍니다.

이 권한을 받는 이유: 프로젝트가 나중에 라이선스 조건을 바꾸거나(예: 더 허용적인 라이선스로) 특정 대상에게 별도 조건으로 제공해야 할 때, 기여자 한 사람 한 사람에게 다시 동의를 구하지 않고도 할 수 있게 하기 위해서입니다. AGPL 로 공개된 판은 그대로 AGPL 로 남습니다.

**Contribution terms (English).** By ticking the box in the pull request template ("I have read and agree to the contribution terms"), you agree to the following. (1) Your contribution is provided under this project's license, AGPL-3.0-or-later. (2) You confirm that you have the right to provide it — you wrote it yourself or are otherwise entitled to contribute it, and if someone else such as your employer holds rights in it, you have their permission. (3) You keep the copyright in your contribution, and you grant the project's copyright holder (Just-Workspace, as named in [LICENSE](LICENSE) and [NOTICE](NOTICE)) a worldwide, perpetual, non-exclusive, royalty-free, irrevocable right to distribute and sublicense your contribution, as part of this project, **under other license terms as well**; where your contribution is covered by patents you hold, you grant a licence on the same terms to the extent needed to use the contribution. We ask for this so that the project can later change its license terms (for example to a more permissive license) or offer it to particular parties under separate terms without having to ask every contributor again. Versions already published under the AGPL remain under the AGPL.
