# 기여 규정 (Contributing)

본 프로젝트는 버그 신고, 기능 제안, 문서 수정 및 코드 기여를 접수한다.

- 문서와 코드 주석은 **한국어를 기본**으로 한다. 영어로 작성한 이슈와 PR 도 접수하며, 번역은 검토 과정에서 조정한다.
- Issues and pull requests may be submitted in English. Documentation and code comments are written in Korean by default; translation is settled during review.
- **보안 취약점은 이슈로 등록하지 아니하며**, [SECURITY.md](SECURITY.md) 에 규정한 절차로 신고한다.

## 이슈 등록

- 버그: 버전, 설치 방식(설치 마법사 / 수동 설치), 활성화된 구역, 재현 절차, 관련 로그를 기재한다. 로그 확인 방법은 [docs/operate.md](docs/operate.md#7-로그) 에 기술한다.
- 기능 제안: 요구 사항과 그 사유를 우선 기재한다. 규모가 큰 변경은 구현에 앞서 이슈로 협의할 것을 권장한다.

## 리포 구조

| 폴더 | 내용 |
|---|---|
| `backend/` | 서버(FastAPI). 구역 선언 `app/zones.json`, 구역별 라우터 표 `app/zones.py` |
| `frontend-react/` | 웹 화면(React). 설치 마법사는 `src/installer-app/` |
| `installer/` | 설치 관리자(설치·구역·업데이트·인증서) |
| `release/` | 릴리스 도구(채널·목록 파일·서명·오프라인 번들) |
| `sso/` · `ldap/` | SSO·LDAP 제공 애드온 |
| `docconv/` · `sandbox/` | AI 도우미 구역의 문서 변환·코드 실행 컨테이너 |
| `audiorelay/` | 무손실 오디오 릴레이(Go) |
| `rbi/` · `deploy/rbi-netfilter/` | 격리 브라우저 애드온 |
| `mailserver/` | 내장 메일 서버의 이미지와 설정 |
| `nginx/` · `init/` · `scripts/` · `livekit/` | compose 가 마운트하는 설정과 스크립트 |
| `plugins/` | 플러그인 빌드 도구와 예제 |
| `apps/` | 데스크톱·모바일 앱 |
| `docs/` | 문서 |

구조는 [docs/architecture.md](docs/architecture.md), 용어는 [docs/glossary.md](docs/glossary.md) 에 기술한다.

## 개발 환경 및 테스트

**리포 내부에 가상 환경·캐시를 생성하지 않는다.** 파이썬 가상 환경은 리포 외부에 둔다. 아래의 `<venv>` 는 해당 경로를 가리킨다.

### backend

Python 3.14(이미지 기준).

```bash
python -m venv <venv>
<venv>/bin/pip install -r backend/requirements-dev.txt
cd backend && <venv>/bin/python -m pytest -q
```

파이썬을 별도로 설치하지 않고 이미지로 실행하는 방법도 있다. 테스트 도구는 운영 이미지(`runtime` 대상)에 포함되지 않으며 `test` 대상에만 포함된다. 테스트 코드는 이미지에 포함하지 않으므로 리포를 마운트하여 실행한다(일부 테스트는 리포의 문서와 다른 폴더를 읽는다).

```bash
docker build --target test --build-context licenses=. -t just-workspace-backend-test backend
docker run --rm --user 1000:1000 --entrypoint python -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$PWD:/src:ro" -w /src/backend just-workspace-backend-test -m pytest -q -p no:cacheprovider
```

`--user 1000:1000` 은 이미지의 실행 사용자이다. 생략하면 root 로 실행되어, 파일 권한을 검사하는 테스트 1건이 건너뛰어진다.

DB 는 임시 SQLite 파일로 대체한다(`backend/tests/conftest.py`). 실제 PostgreSQL 이 필요한 테스트는 환경변수 `JW_TEST_PG_URL`(관리용 접속, 예: `postgresql+asyncpg://postgres:<비밀번호>@<호스트>:5432/postgres`)이 설정된 경우에만 실행되며, 미설정 시 건너뛴다.

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

개발 서버는 `npm run dev`(워크스페이스), `npm run dev:installer`(설치 마법사, 3002)로 기동한다.

### 설치 관리자

```bash
<venv>/bin/pip install -r installer/requirements-dev.txt
cd installer && <venv>/bin/python -m pytest -q
```

docker 없이 실행된다(docker·DNS·HTTP 는 모의 객체로 대체한다). 응답 파일로부터 생성되는 파일의 스냅샷은 `installer/tests/snapshots/` 에 있으며, 의도한 변경인 경우 `JW_UPDATE_SNAPSHOTS=1` 로 재생성한다. 실제 서버에서 수행하는 검수는 [docs/installer.md](docs/installer.md) 13절에 기술한다.

### 릴리스 도구

```bash
<venv>/bin/pip install -r release/requirements-dev.txt
cd release && <venv>/bin/python -m pytest
```

docker·네트워크 없이 실행된다. **compose 의 이미지 구성을 변경하면** `release/tests/test_compose.py` 의 스냅샷과 `test_workflow.py` 가 실패한다 — `.github/workflows/build-images.yml` 의 매트릭스와 함께 수정한다([docs/releases.md](docs/releases.md)).

### 전체 스택 기동

- 소스에서 이미지를 빌드하여 설치 관리자로 설치: [docs/install.md](docs/install.md#소스에서-빌드해-설치)
- 설치 관리자를 사용하지 않고 compose 로 기동: [docs/deployment.md](docs/deployment.md)

지원 환경은 리눅스 x86_64 + Docker Engine 이다.

## 변경 시 동반 수정 대상

| 변경 대상 | 동반 확인 대상 |
|---|---|
| 구역 추가·변경 | `backend/app/zones.json`(선언) → `backend/app/zones.py`(라우터·루프 표) → `docker-compose.yml`(프로파일·서비스) → 필요 시 `installer/app/zones/<구역>.py`(구역 훅, [docs/installer.md](docs/installer.md) 10절) → 화면 문구(`frontend-react/src/installer-app/i18n/`, `src/i18n/locales/`). `backend/tests/test_zones.py` 와 설치 관리자의 스냅샷이 정합성을 검증한다 |
| 환경변수 추가 | `backend/app/config.py` 또는 `docker-compose.yml`, `.env.example`, 설치 관리자가 기록해야 하는 경우 `installer/app/render.py` 와 [docs/installer.md](docs/installer.md) 8절의 표, [docs/CONFIG.md](docs/CONFIG.md) |
| 비밀값 추가 | `backend/app/security_defaults.py`(규칙과 생성 대상) |
| DB 구조 변경 | 번호가 부여된 변경 단계로만 수행 — [docs/data-safety.md](docs/data-safety.md) 1절의 "변경 단계 작성법" |
| compose 의 이미지·빌드 설정 | 빌드 워크플로의 매트릭스, `release/tests/` |
| 화면 문구 | 한국어(`ko.json`)와 영어(`en.json`)를 함께 수정. 문서의 용어는 [docs/glossary.md](docs/glossary.md) 를 따른다 |
| 플러그인 | [docs/extensions.md](docs/extensions.md) · [docs/plugin-frontend.md](docs/plugin-frontend.md) · [frontend-react/docs/plugin-v2.md](frontend-react/docs/plugin-v2.md). 예제는 `plugins/sample-notes`(v1, Vue)와 `plugins/remote-desktop`(v2, React — 신규 플러그인의 기본) |

## 커밋 및 PR 규칙

- 커밋 메시지는 **`영역: 수행 내용`** 형식으로 작성한다. 영역은 "설치 관리자", "설치 마법사", "백엔드", "프런트", "문서", "테스트", "릴리스 도구" 등 식별 가능한 명칭으로 한다. 예:
  - `설치 관리자: 승격한 릴리스의 설치 관리자도 제품 버전을 알게`
  - `문서: 백업에서 복원(API·설정 병합 규칙·단계·무인 예시)`
- 하나의 커밋에는 하나의 변경 사항만 포함한다. 동작을 변경하는 경우 테스트와 문서를 동일 PR 에서 함께 수정한다.
- 줄바꿈은 LF 로 한다.
- PR 에는 변경 내용과 사유, 검증 방법을 기재한다. **실행하여 검증한 항목과 검증하지 못한 항목을 구분하여 기재한다.**
- 비밀값 및 실제 운영 주소·도메인·이름을 코드와 문서에 포함하지 않는다. 예시에는 `workspace.example.com`, `192.168.10.x`, `203.0.113.x` 를 사용한다.
- 의존성을 추가하는 경우 라이선스를 확인하고 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) 를 함께 수정한다. AGPL-3.0 과 결합하여 배포할 수 없는 라이선스(비오픈소스, GPL-2.0 "한정" 라이브러리를 동일 프로세스에서 호출하는 경우 등)의 의존성은 접수하지 않는다. GPL·LGPL·MPL 계열은 PR 에 별도로 명시한다([docs/licensing.md](docs/licensing.md)).

## 라이선스

본 리포는 [GNU Affero General Public License 버전 3 또는 그 이후 버전](LICENSE)(`AGPL-3.0-or-later`)에 의거하여 배포된다.

## 기여 조건

PR 제출 시 템플릿의 확인란("기여 조건을 확인하였으며 이에 동의함")에 표시하는 것으로 아래 조건에 동의한 것으로 본다.

1. **라이선스.** 기여물은 본 프로젝트의 라이선스(AGPL-3.0-or-later)로 제공된다.
2. **권리의 확인.** 기여자는 해당 기여물을 제공할 권리가 있음을 확인한다 — 직접 작성하였거나 제공할 권한을 보유하며, 고용주 등 제3자가 권리를 보유한 저작물인 경우 그 허락을 받았음을 확인한다.
3. **재허가 권한.** 기여자는 기여물의 저작권을 계속 보유한다. 다만 프로젝트 저작권자(리포의 [LICENSE](LICENSE)·[NOTICE](NOTICE)에 명시된 Just-Workspace)에게, 해당 기여물을 본 프로젝트의 일부로서 **다른 라이선스 조건으로도 배포하고 재허가할 수 있는** 전 세계적·영구적·비독점적·무상·취소 불가능한 권리를 부여한다. 기여물에 기여자가 보유한 특허가 적용되는 경우, 해당 기여물의 사용에 필요한 범위에서 동일한 조건의 실시 허락을 함께 부여한다.

본 권한을 요구하는 사유: 프로젝트가 향후 라이선스 조건을 변경하거나(예: 더 허용적인 라이선스로의 전환) 특정 대상에게 별도 조건으로 제공하여야 하는 경우, 기여자 개개인의 재동의 없이 이를 수행할 수 있도록 하기 위함이다. AGPL 로 공개된 버전은 계속 AGPL 의 적용을 받는다.

**Contribution terms (English).** By ticking the box in the pull request template ("I have read and agree to the contribution terms"), the contributor agrees to the following. (1) The contribution is provided under this project's license, AGPL-3.0-or-later. (2) The contributor confirms the right to provide it — the contributor is its author or is otherwise entitled to contribute it, and where a third party such as an employer holds rights in it, that party's permission has been obtained. (3) The contributor retains the copyright in the contribution and grants the project's copyright holder (Just-Workspace, as named in [LICENSE](LICENSE) and [NOTICE](NOTICE)) a worldwide, perpetual, non-exclusive, royalty-free, irrevocable right to distribute and sublicense the contribution, as part of this project, **under other license terms as well**; where the contribution is covered by patents held by the contributor, a licence on the same terms is granted to the extent needed to use the contribution. This grant is requested so that the project can later change its license terms (for example to a more permissive license) or offer the software to particular parties under separate terms without obtaining renewed consent from every contributor. Versions already published under the AGPL remain under the AGPL.
