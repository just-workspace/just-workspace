# 릴리스 및 채널

본 제품은 Docker 이미지 집합으로 배포된다. 설치된 서버의 설치 관리자는 **채널 파일**을 주기적으로 수신하여 신규 버전의 존재 여부를 확인한다.
본 문서는 채널·릴리스 목록의 형식, 서명 규칙, 릴리스 절차 및 해당 도구(`release/`)를 기술한다.

설치 관리자가 채널을 수신하여 적용하는 절차는 [installer.md](installer.md) 16절과 [update-api.md](update-api.md)에 기술한다. 해당 절차에서 사용하는 검증 함수는 [본 문서 말미](#설치-관리자가-사용하는-함수)에 기술한다.

## 개요 (Overview)

| 대상 | 위치(기본값) |
|---|---|
| 소스 | `just-workspace/just-workspace` |
| 채널 파일·릴리스 목록 | 채널 리포 `just-workspace/releases` 의 정적 파일 |
| 이미지 | `ghcr.io/just-workspace/just-workspace-<이름>` |
| 설치 파일·오프라인 번들 | 소스 리포의 GitHub Releases 첨부 |

주소는 전부 설정값이다([주소 설정값](#주소-설정값)). 위치를 이전하더라도 도구의 변경은 필요하지 않다.

- **버전**: 제품 전체가 단일 버전을 가진다. Stable 은 `X.Y.Z`, Beta 는 `X.Y.Z-beta.N`(N ≥ 1). 단일 출처는 리포 루트 `VERSION`.
- **채널**: `stable`, `beta`. Beta 채널에는 Stable 릴리스도 포함된다.
- **서명**: ECDSA P-256. 비공개 키는 릴리스 담당자의 PC 에만 보관한다. 빌드 서버는 서명을 수행하지 않는다.

## 채널 리포의 파일 구성

```
channels/stable.json        channels/stable.json.sig
channels/beta.json          channels/beta.json.sig
releases/<버전>/manifest.json   releases/<버전>/manifest.json.sig
```

## 채널 파일

`channels/<채널>.json` — 스키마 `release/schema/channel.schema.json`, 예시 `release/examples/channel-*.json`.

| 항목 | 정의 |
|---|---|
| `format` | 형식 버전. 현재 `1` |
| `channel` | `stable` 또는 `beta` |
| `sequence` | 순번. 파일을 새로 게시할 때마다 1 씩 증가한다. 수신 측은 이전에 확인한 값보다 작으면 거부한다 |
| `generated` | 생성 시각(UTC, `YYYY-MM-DDTHH:MM:SSZ`) |
| `expires` | 만료 시각. 경과하면 수신 측이 거부한다(과거 파일의 재전송 공격 차단). 기본값은 생성 시각으로부터 90일 |
| `releases[]` | 릴리스 목록, 버전 오름차순 |
| `releases[].version` | 버전 |
| `releases[].published` | 공개 시각 |
| `releases[].min_upgrade_from` | 해당 버전으로 **직접** 업데이트할 수 있는 최소 버전. 제약이 없으면 `null` |
| `releases[].manifest.path` | 릴리스 목록 파일의 상대 경로(`releases/<버전>/manifest.json`) |
| `releases[].manifest.sha256` | 해당 파일 바이트의 SHA-256 |
| `releases[].summary` | 한 줄 요약 |

`stable` 채널에는 `X.Y.Z` 만 포함된다. 게시한 릴리스는 목록에서 삭제하지 않는다 — 구버전 설치가 중간 버전을 경유하여 업데이트할 때 필요하다.

## 릴리스 목록 파일(manifest)

`releases/<버전>/manifest.json` — 스키마 `release/schema/manifest.schema.json`, 예시 `release/examples/manifest-*.json`.

| 항목 | 정의 |
|---|---|
| `format` | 형식 버전. 현재 `1` |
| `version`, `published`, `min_upgrade_from` | 채널 파일의 해당 항목과 동일한 값(수신 측이 대조한다) |
| `promoted_from` | Beta 에서 승격한 릴리스인 경우 해당 Beta 버전, 그 외에는 `null` |
| `db_schema` | DB 스키마 버전(정수) — backend 의 `python -m app.cli schema-version` 출력을 `make-manifest --db-schema` 로 지정한다. 지정하지 않으면 `null` |
| `images` | 자체 빌드 이미지: 이름 → `저장소@sha256:…` |
| `third_party` | 외부 이미지: 구역 id → (이름 → 원 배포처의 `저장소@sha256:…`). compose 에서 추출한다 |
| `zones.content` | 구역 선언(`backend/app/zones.json`) 사본 |
| `zones.sha256` | `zones.content` 를 [결정적 직렬화](#서명-대상-바이트)한 바이트의 SHA-256 |
| `installer_bundle` | 설치 관리자 번들(compose·템플릿 집합)의 주소·크기·SHA-256 — **예약 항목**. 현재는 `null` 이다: 번들은 설치 관리자 **이미지**(`images.installer`)에 포함되어 있으며, 업데이트는 해당 이미지에서 추출하여 사용한다 |
| `apps[]` | 앱 설치 파일: `kind`(`windows-desktop`, `android`), `filename`, `size`, `sha256`, `url` |
| `offline_bundle` | 오프라인 번들의 주소·크기·SHA-256. 없으면 `null` |
| `changelog` | 변경 내용(마크다운). 관리 › 업데이트의 해당 버전 항목에 표시된다. 리포의 `CHANGELOG.md` 에서 해당 버전의 절만 싣는다([변경 내용](#변경-내용)) |
| `plugin_api` | 플러그인 호환 범위 — **예약 항목**. 현재는 `null` |
| `download_bytes` | **선택.** pull 대상 이미지(자체 빌드 이미지 + 외부 이미지 전체)의 압축 크기 합(바이트, 0 이상의 정수). 값을 알 수 없는 경우 `null` 이 아니라 **키 자체를 포함하지 않는다** — 수신 측은 해당 항목을 표시하지 않는다 |

이미지는 전부 다이제스트로 기록한다. 태그는 가리키는 내용이 변경될 수 있으므로 기록하지 않는다.
compose 의 외부 이미지는 전부 다이제스트로 고정한다(`이름:태그@sha256:…` — 태그는 가독성을 위해 유지한 것이며, pull 되는 내용은 다이제스트가 결정한다).
태그로만 고정된 외부 이미지가 존재하면 `make-manifest` 는 **실패**한다. 다이제스트를 지정하는 방법은 다음 두 가지다.

- `--pins <파일>`: `{"저장소:태그": "sha256:…"}` 표를 지정한다(예시 `release/examples/pins.json`).
- `--resolve-digests`: 레지스트리에서 해당 시점의 다이제스트를 조회하여 기록한다.

다운로드 용량(`download_bytes`)을 지정하는 방법도 두 가지다. 둘 다 지정하지 않으면 해당 항목은 생략된다.

- `--download-bytes <바이트>`: 값을 직접 지정한다.
- `--resolve-sizes`: 레지스트리에서 이미지별 manifest 를 조회하여 `linux/amd64` 의 config + 계층 크기를 합산한다(익명 조회). 하나라도 조회에 실패하면 경고만 출력하고 해당 항목을 포함하지 않는다 — manifest 는 정상적으로 생성된다. 값은 전체를 신규로 pull 하는 경우의 크기다. 서버에 이미 존재하는 계층은 재수신하지 않으므로 실제 수신량은 이보다 적을 수 있다.

레지스트리 조회는 https 로 수행한다. 로컬 레지스트리(`localhost`, `127.x.x.x`, `[::1]` — 포트가 지정된 경우도 동일)에 한하여 docker 와 동일하게 평문 http 로 접속한다.

`release/examples/` 의 다이제스트는 형식을 예시하기 위한 값이다. 자체 빌드 이미지의 다이제스트는 임의로 작성한 값이며 실제 릴리스의 값이 아니다.

## 서명 대상 바이트

채널 파일과 manifest 는 **결정적 직렬화**로 기록한다. 내용이 동일하면 생성 주체와 무관하게 동일한 바이트가 산출된다.

1. JSON 객체의 키는 유니코드 코드포인트 순으로 정렬한다(모든 깊이).
2. 구분자는 `,` 와 `:` — 공백·들여쓰기·줄바꿈을 삽입하지 않는다.
3. UTF-8, BOM 없음. 비 ASCII 문자는 `\uXXXX` 로 변환하지 않고 그대로 기록한다.
4. 값은 문자열·정수·불리언·null·배열·객체만 사용한다. 실수는 사용하지 않는다.
5. 파일 끝에 줄바꿈(LF) 하나.
6. 배열의 순서는 유지한다.

서명은 **파일에 기록된 바이트 자체**를 대상으로 한다. 수신 측은 수신한 바이트를 재직렬화하지 않고 그대로 검증한 후 해석한다.
따라서 채널 리포의 해당 파일은 수작업으로 수정하거나 줄바꿈을 변경해서는 안 된다(채널 리포에서는 git 의 줄바꿈 자동 변환을 비활성화한다).

`release/examples/` 의 파일은 가독성을 위해 들여쓰기를 적용한 것이다. 실제 파일은 한 줄이다.

## 서명 형식 및 cosign 호환성

서명 파일 `<파일>.sig` 의 내용은 한 줄이다:

```
base64( ASN.1 DER 로 적은 ECDSA 서명 )      서명 대상 = 파일 바이트의 SHA-256, 곡선 P-256
```

이는 `cosign sign-blob --key` 의 출력 형식과 동일하다. 공개 키는 SPKI PEM(`-----BEGIN PUBLIC KEY-----`)으로 `cosign.pub` 과 동일한 형식이다.
따라서 다음 두 경우가 상호 호환되어야 한다.

```bash
# 이 도구로 서명한 것을 cosign 으로 검증
cosign verify-blob --key release.pub --signature channels/stable.json.sig \
  --insecure-ignore-tlog=true channels/stable.json

# cosign 으로 서명한 것을 이 도구로 검증 (publish --no-sign 으로 파일만 만든 뒤)
cosign sign-blob --key cosign.key --tlog-upload=false \
  --output-signature channels/stable.json.sig channels/stable.json
python -m jwrelease verify --repo . --pubkey cosign.pub
```

- 투명성 로그(Rekor)에 등록하지 않는 키 쌍 방식이므로 위 플래그가 필요하다. cosign 버전에 따라 플래그 이름·기본 출력 형식(번들)이 상이하다 — 사용하는 버전의 도움말을 확인한다.
- 본 도구가 지원하는 비공개 키는 표준 PEM(PKCS#8 또는 SEC1, 암호화 가능)이다. `cosign generate-key-pair` 가 생성하는 키 파일은 cosign 고유 형식이므로 지원하지 않는다. 해당 키로는 cosign 으로 서명한다. 표준 PEM 키를 cosign 에서 사용하려면 `cosign import-key-pair` 로 가져온다.
- **호환성은 형식 기준으로 구현하였으며, 실제 cosign 실행 파일을 이용한 교차 검증은 수행하지 못하였다.** 최초 릴리스 이전에 위 두 명령을 1회 실행하여 확인한다.

## 릴리스 절차

준비 사항: Python 3.10 이상, `pip install -r release/requirements.txt`(`cryptography` 하나). 명령은 `release/` 에서 `python -m jwrelease …` 또는 임의의 위치에서 `python release/tools/jwrelease.py …` 로 실행한다.

1. **버전 상향** — `CHANGELOG.md` 에 해당 버전의 절(`## 1.1.0-beta.1`)을 작성하고, `VERSION` 을 `1.1.0-beta.1` 과 같이 수정하여 커밋한다.
2. **태그** — `git tag v1.1.0-beta.1 && git push <원격> v1.1.0-beta.1`. 태그와 `VERSION` 이 불일치하면 빌드가 중단된다.
3. **빌드(CI)** — `.github/workflows/build-images.yml` 이 자체 빌드 이미지를 전부 빌드하여 게시하고 `digests.json` 을 산출물로 생성한다. 수동 실행도 가능하다(버전 입력).
4. **다이제스트 수령** — 해당 실행의 산출물 `digests` 를 내려받는다.
5. **manifest 생성**
   ```bash
   python -m jwrelease make-manifest --digests digests.json \
     --changelog-file ../CHANGELOG.md --changelog-section --min-upgrade-from 1.0.0 --db-schema 3 --resolve-sizes \
     --apps-dir ./apps-out --pins pins.json -o work/manifest.json
   ```
   버전은 `VERSION` 에서 읽는다(`--version` 으로 재지정할 수 있다). `digests.json` 의 버전과 불일치하면 중단된다.
   `--changelog-section` 은 변경 기록에서 이 릴리스 버전의 절만 싣는다(값을 지정하면 해당 버전의 절). 지정하지 않으면 파일 전체를 싣는다 — 변경 기록 전체를 지정하는 경우에는 반드시 함께 지정한다.
6. **Beta 게시** — 채널 리포를 복제한 작업 디렉터리에서:
   ```bash
   python -m jwrelease publish --repo ../releases --manifest work/manifest.json --channel beta --key ~/keys/release.pem
   ```
   `releases/<버전>/` 을 추가하고 `channels/beta.json` 을 갱신(순번 +1, 만료 갱신)·서명한다. **커밋·푸시는 수행하지 않는다** — 출력된 안내에 따라 `verify` 로 검증한 후 직접 커밋·푸시한다.
7. **승격** — 시험이 완료되면:
   ```bash
   python -m jwrelease promote --repo ../releases --version 1.1.0-beta.1 --key ~/keys/release.pem \
     --changelog-file ../CHANGELOG.md --changelog-section
   ```
   `--changelog-file` 을 지정하지 않으면 Beta 의 변경 내용을 그대로 사용한다. `--changelog-section` 의 값을 생략하면 승격 후의 Stable 버전(`1.1.0`)의 절을 싣는다.
   이미지를 재빌드하지 않는다. 버전 문자열만 상이한 manifest(`1.1.0`, `promoted_from` 기록)를 생성하여 `stable.json` 과 `beta.json` 에 추가하고, 동일 다이제스트에 Stable 태그를 부여하는 `docker buildx imagetools create` 명령을 **출력**한다(`--run` 을 지정하면 실행). 이후 검증·커밋·푸시를 수행한다.
   승격한 버전의 git 태그(`v1.1.0`)를 푸시하더라도 CI 는 빌드를 수행하지 않는다(빌드 트리거는 Beta 태그와 수동 실행에 한정된다).

Beta 를 거치지 않고 Stable 을 직접 게시하려면 6번에서 `--channel stable` 을 사용한다(해당 릴리스는 beta 채널에도 포함된다).

비공개 키의 암호는 환경변수 `JWRELEASE_KEY_PASSWORD` 로 지정하며, 지정하지 않으면 입력을 요구한다.
다른 도구로 서명하려면 `--no-sign` 으로 파일만 생성한다(서명 대상 파일 목록이 출력된다).

### 변경 내용

리포 루트의 `CHANGELOG.md` 는 **버전별 절**로 구성한다. 릴리스 도구는 해당 버전의 절만 manifest 의 `changelog` 에 싣는다.

- 절의 제목은 `## <버전>` 이다(2단계 제목, 제목의 첫 낱말이 버전과 정확히 일치). 제목 뒤에 날짜 등을 덧붙일 수 있다(`## 1.1.0 (2027-01-10)`).
- 절은 다음 1·2단계 제목 직전에서 끝난다. 하위 제목(`###`)은 절에 포함된다. 제목 줄 자체는 싣지 않는다 — 화면이 버전을 별도로 표시한다.
- 절의 첫 줄은 한 문장의 요약으로 작성한다. `publish`·`promote` 는 `--summary` 를 지정하지 않으면 이 줄을 채널 파일의 `summary` 로 사용한다.
- 해당 버전의 절이 없거나 비어 있으면 `make-manifest`·`promote` 는 중단된다.
- Stable(`X.Y.Z`)의 절은 해당 Stable 의 전체 요약(주요 기능·설치·업데이트·데이터 안전 등)이며, Beta(`X.Y.Z-beta.N`)의 절은 직전 버전 이후의 변경 사항이다.

### 명령 요약

| 명령 | 기능 |
|---|---|
| `images` | compose 의 이미지 목록 — 자체 빌드 이미지, 외부 이미지, 다이제스트 미지정 이미지 |
| `make-manifest` | `digests.json` + compose + `zones.json` (+ 앱 파일, 변경 내용 — `--changelog-section` 으로 해당 버전의 절, DB 스키마 버전, 다운로드 용량) → `manifest.json` |
| `sign` | 파일에 서명(`.sig`) |
| `publish` | 채널 리포 작업 디렉터리에 릴리스를 추가하고 채널 파일 갱신·서명 |
| `promote` | Beta 릴리스를 Stable 로 승격 |
| `verify` | 채널 디렉터리(`--repo`) 또는 주소(`--url`)의 채널·manifest 를 공개 키로 전부 검증 |
| `refresh` | 릴리스 없이 채널 파일의 만료만 갱신(순번 +1) |
| `bundle plan / index / pack / verify` | 오프라인 번들 |

### 승격 및 표시 버전

승격은 이미지를 재빌드하지 않으므로 **이미지에 내장된 버전 문자열은 승격 이후에도 Beta 의 값**이다.
화면·API 에 표시되는 버전은 실행 시 환경변수로 지정하여야 한다.

| 이미지 | 버전 확인 방법 | 승격 이후 |
|---|---|---|
| backend | 환경변수 `JW_APP_VERSION` → 없으면 이미지의 `/app/VERSION`(빌드 인자) → 개발 표기 | 실행 환경이 `JW_APP_VERSION` 을 지정하면 정확하다. 지정하지 않으면 Beta 문자열이 표시된다 |
| audiorelay | 환경변수 `JW_APP_VERSION` → 없으면 바이너리에 내장된 값(빌드 인자 `VERSION`) | backend 와 동일 |
| 설치 관리자 | 환경변수 `JW_INSTALLER_VERSION` → 없으면 이미지의 번들에 포함된 `VERSION` | 업데이트로 교체된 설치 관리자는 정확하다(업데이트가 해당 값을 지정하여 기동한다). 승격한 이미지를 **신규 설치하는 경우**에는 `docker run` 에 `-e JW_INSTALLER_VERSION=<버전>` 을 지정한다(문서의 설치 명령은 모두 이와 같이 기재되어 있다). 지정하지 않으면 Beta 문자열을 자신의 버전으로 인식하며, 기동 시 로그에 한 줄로 통지한다 |
| 그 밖의 이미지 | 제품 버전을 표시하지 않는다 | 영향 없음 |

## 만료 갱신

채널 파일은 생성 시각으로부터 90일(설정 `expires_days`) 후에 만료된다. 릴리스가 없더라도 **만료 이전에** 갱신하여야 한다 — 만료되면 설치된 서버가 채널을 수용하지 않아 신규 버전을 확인할 수 없게 된다(실행 중인 서비스에는 영향이 없다).

```bash
python -m jwrelease refresh --repo ../releases --key ~/keys/release.pem
```

두 채널 모두 순번이 1 증가하고 만료가 다시 90일 후로 설정된다. 2개월 주기의 갱신을 권장한다. 서명이 필요하므로 자동화하려면 비공개 키를 자동화 환경에 배치하여야 하나, 이는 아래 원칙에 위배되므로 담당자가 수동으로 수행한다.

## 키 관리

- **비공개 키는 릴리스 담당자의 PC 에만 보관한다.** 빌드 서버·리포·채널 리포에 보관하지 않는다. 암호를 설정하고 오프라인 사본을 별도로 보관한다.
- 리포에는 어떠한 키도 커밋하지 않는다. 테스트는 실행 시마다 임시 키를 생성하여 사용한다.
- 수신 측(설치 관리자)은 **공개 키 슬롯 2개** — 현재 키와 다음 키 — 를 보유하며, 둘 중 하나로 검증되면 통과시킨다.

키 생성(표준 PEM, 암호 설정):

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -aes256 -out release.pem
openssl pkey -in release.pem -pubout -out release.pub
```

교체 절차:

1. 신규 키 쌍을 생성한다.
2. 신규 공개 키를 "다음 키" 슬롯에 포함한 설치 관리자를 릴리스한다(서명은 기존 키를 유지한다).
3. 설치된 서버들이 해당 릴리스로 충분히 업데이트된 이후부터 신규 키로 서명한다. 그 이전에 전환하면 구버전 설치는 채널을 검증하지 못한다.
4. 다음 설치 관리자 릴리스에서 신규 키를 "현재 키" 슬롯으로 이동하고 기존 키를 제거한다.

비공개 키가 유출된 경우에는 2~3단계를 대기할 수 없다. 이 경우 신규 키를 포함한 설치 관리자를 별도 경로로 공지하여 수동으로 업데이트하도록 하여야 한다 — 따라서 "다음 키"를 사전에 생성하여 슬롯에 포함해 두는 것이 안전하다.

## 수신 측 검증 순서

채널 파일: **서명 → 형식 → 만료 → 순번**(이전에 수용한 순번보다 작으면 거부).
manifest: **해시**(채널 파일에 기록된 값) **→ 서명 → 내용**(버전·공개 시각·`min_upgrade_from` 이 채널의 해당 항목과 일치).

버전 판정:

- 채널의 최신 버전이 현재 버전과 동일 → 조치 없음.
- 최신 버전이 상위 → 업데이트한다. `min_upgrade_from` 으로 인해 직접 업데이트할 수 없는 경우 중간 릴리스를 경유한다(경유 횟수가 최소인 경로).
- 최신 버전이 하위 → **대기한다**. Beta 사용 중 Stable 로 전환한 직후가 이에 해당한다. 하위 버전으로 내려가지 않으며, Stable 이 현재 버전 이상이 되면 업데이트한다(`1.2.0` 은 `1.2.0-beta.3` 보다 상위다).
- 다운그레이드는 수행하지 않는다.

## 오프라인 번들

인터넷에 연결되지 않은 서버로 전송하여 설치하기 위한 단일 tar 파일(`just-workspace-<버전>-offline.tar`).

```
bundle.json            색인: 형식 버전, 제품 버전, 만든 시각, 파일 목록(경로·크기·SHA-256), 이미지 표
bundle.json.sig        색인의 서명
manifest.json          릴리스 목록 파일 (offline_bundle 은 null)
manifest.json.sig
images/<이름>.tar      docker save 결과, 이미지마다 하나
```

검증 순서: **번들 서명**(`bundle.json.sig`) **→ manifest**(색인의 해시와 일치, 자체 서명, 색인의 버전·이미지 표와 일치) **→ 파일별 해시**(색인의 모든 파일이 존재하고 크기·해시가 일치하며 색인에 없는 파일이 없을 것).

생성:

```bash
python -m jwrelease bundle plan  --manifest work/manifest.json --stage stage   # docker pull·tag·save 명령 출력(--run 이면 실행)
python -m jwrelease bundle index --stage stage --key ~/keys/release.pem        # bundle.json + 서명
python -m jwrelease bundle pack  --stage stage                                 # tar 한 파일
python -m jwrelease bundle verify just-workspace-1.1.0-offline.tar --pubkey release.pub
```

- 번들 내 manifest 는 `offline_bundle` 이 비어 있는 판이다(번들은 자신의 해시를 포함할 수 없다). 번들의 크기·해시를 기록한 manifest 는 번들 생성 **이후에** `make-manifest --offline-bundle <파일>` 로 재생성하여 게시한다. 두 manifest 의 차이는 `offline_bundle` 뿐이다.
- `docker load` 는 레지스트리 다이제스트를 복원하지 못한다. 따라서 번들의 이미지는 태그로 저장한다 — 자체 빌드 이미지는 `저장소:<버전>`, 외부 이미지(`--include-third-party`)는 `저장소:jw-<다이제스트 앞 12자>`. 오프라인 설치는 색인의 `images[].tag` 로 이미지를 참조한다.
- **검수 서버에서의 검증 범위.** 릴리스 도구로 실제 `docker save` 번들을 생성하고(`bundle plan` → `index` → 서명 → `pack` → `verify`), 레지스트리와 채널을 차단한 서버에 업로드하여 검증·추가 이미지 판정을 거친 후 번들과 이미지 파일만으로 업데이트를 완료하였다([installer.md](installer.md) 13절의 `u8`). 색인·패키징·검증의 형식은 테스트로도 고정되어 있다. 검증하지 못한 항목은 실제 서명 키로 생성한 번들과, 수 GB 규모의 번들을 프런트 프록시를 경유하여 업로드하는 경우다.

## 주소 설정값

기본값은 `release/jwrelease/config.py` 에 정의되어 있다. 설정 파일(`--config settings.json`, 예시 `release/examples/settings.json`) 또는 환경변수로 재지정한다. 우선순위는 환경변수 > 설정 파일 > 기본값.

| 설정 | 환경변수 | 기본값 | 용도 |
|---|---|---|---|
| `registry` | `JWRELEASE_REGISTRY` | `ghcr.io/just-workspace` | 자체 빌드 이미지의 저장소. compose 의 `JW_REGISTRY` 와 동일한 값 |
| `image_prefix` | `JWRELEASE_IMAGE_PREFIX` | `just-workspace-` | 이미지 이름 접두어(`<registry>/<prefix><이름>`) |
| `channel_base_url` | `JWRELEASE_CHANNEL_BASE_URL` | `https://raw.githubusercontent.com/just-workspace/releases/main` | 채널 파일·manifest 의 다운로드 기준 주소(`verify --url` 의 기본값) |
| `channel_repo_url` | `JWRELEASE_CHANNEL_REPO_URL` | `https://github.com/just-workspace/releases` | 안내 출력 |
| `download_url_template` | `JWRELEASE_DOWNLOAD_URL_TEMPLATE` | `https://github.com/just-workspace/just-workspace/releases/download/v{version}/{filename}` | 앱 설치 파일·오프라인 번들의 주소 |
| `expires_days` | `JWRELEASE_EXPIRES_DAYS` | `90` | 채널 파일의 만료까지의 일수 |

빌드 워크플로의 값은 리포 Variables 로 지정한다: `JW_REGISTRY`(기본 `ghcr.io`), `JW_IMAGE_NS`(기본 리포 소유자), `JW_IMAGE_PREFIX`(기본 `just-workspace-`). GHCR 이외의 레지스트리를 사용하는 경우 Secrets `REGISTRY_USER`·`REGISTRY_TOKEN` 을 등록한다.
양측의 값이 불일치하면 `make-manifest` 가 "저장소가 다르다"로 중단된다.

## 빌드 워크플로

`.github/workflows/build-images.yml` — Beta 태그(`v*-beta.*`) 푸시 또는 수동 실행으로 기동된다. Stable 태그(`v1.1.0`)는 빌드를 유발하지 않는다 — Stable 은 승격으로만 생성한다.

- 빌드 대상: backend, frontend-react, sso, ldap, mailserver, audiorelay, docconv, sandbox, rbi-netfilter, rbi-mirror 및 설치 관리자(`installer/Dockerfile`, 컨텍스트는 리포 루트 — pull 대상 이미지 저장소를 빌드 인자 `JW_REGISTRY` 로 내장한다).
- `linux/amd64` 에 한정한다. 태그는 버전 하나(`latest` 는 부여하지 않는다). 빌드 캐시는 GitHub Actions 캐시를 사용한다.
- 각 작업이 이름 → 다이제스트를 출력하고, 최종 작업이 이를 `digests.json` 으로 취합하여 산출물 `digests` 로 게시한다(보존 90일).
- 서명·채널 갱신 단계는 없다. 비공개 키도 보유하지 않는다.
- 액션은 커밋 SHA 로 고정되어 있다.
- 빌드 컨텍스트·Dockerfile·target 은 compose 의 `build` 설정과 일치하여야 한다. `release/tests/test_workflow.py` 가 이를 대조한다.
- 모든 이미지의 `/licenses/` 에 라이선스 고지(`LICENSE`, `THIRD_PARTY_LICENSES.md`)가 포함된다. 두 파일은 각 이미지의 빌드 컨텍스트 외부(리포 루트)에 있으므로 **명명된 컨텍스트 `licenses`** 로 전달한다 — compose 는 `build.additional_contexts`, 워크플로는 `build-contexts: licenses=.`, 수동 빌드 시에는 `docker build --build-context licenses=<리포 루트> …`. 리포 루트의 `.dockerignore` 가 해당 컨텍스트로 두 파일만 전달한다. 설치 관리자 이미지는 컨텍스트가 리포 루트이므로 직접 복사한다.

`digests.json`:

```json
{
  "format": 1,
  "version": "1.1.0-beta.1",
  "registry": "ghcr.io/just-workspace",
  "commit": "<커밋 SHA>",
  "images": { "backend": { "repository": "ghcr.io/just-workspace/just-workspace-backend", "digest": "sha256:…" } }
}
```

## 테스트

```bash
python -m venv <리포 밖 경로>/venv && <venv>/bin/pip install -r release/requirements-dev.txt
cd release && <venv>/bin/python -m pytest
```

docker·네트워크 없이 실행된다. compose 의 이미지 구성이 변경되면 `tests/test_compose.py` 의 스냅샷과 `tests/test_workflow.py` 가 실패한다 — 워크플로 매트릭스와 함께 수정한다.

## 알려진 제한 사항

- **cosign 교차 검증 미수행.** 형식은 일치시켰으나 실제 cosign 으로 서명·검증을 수행하지는 않았다.
- **빌드 워크플로는 Beta 태그(`v1.0.0-beta.1` 이후)마다 실제로 실행되었다.** 매트릭스의 11개 이미지(자체 빌드 이미지 10개 + 설치 관리자)가 빌드되어 레지스트리에 게시되었으며, backend 이미지의 `runtime` 대상(테스트 도구 제외)도 1.0.0-beta.2 부터 CI 에서 빌드되었다. 공개 이미지로 설치·업데이트를 검증하였다([installer.md](installer.md) 13절).
- **수동 실행으로 Stable 버전의 빌드가 가능하다.** 트리거는 Beta 태그에 한정되나 수동 실행의 버전 입력은 `X.Y.Z` 도 허용한다(최초 릴리스와 같이 Beta 를 거치지 않는 경우를 위함). 이미 승격한 버전을 수동으로 재빌드하면 태그가 다른 다이제스트를 가리키게 되므로 수행하지 않는다.
- **compose 해석은 필요한 범위에 한정된다.** `image`·`build`·`profiles` 만 해석한다. 해당 항목에 앵커·병합 키·여러 줄 값을 사용하면 중단된다. `include`·`extends` 로 분할한 compose 는 지원하지 않는다.
- **`--resolve-digests`·`--resolve-sizes` 는 익명 조회다.** 인증이 필요한 레지스트리의 외부 이미지는 `--pins` 로 지정한다. 조회 값은 해당 시점에 태그가 가리키던 값이므로, 시험한 이미지와의 동일 여부는 담당자가 확인하여야 한다 — compose 에서 다이제스트로 고정하는 방식을 권장한다.
- **다중 아키텍처 미지원.** `linux/amd64` 만 빌드한다.
- **앱 설치 파일은 사이트별로 개별 빌드하는 구조**이므로 현재는 릴리스에 포함할 공용 파일이 없다. `apps[]` 는 형식만 정의되어 있다.
- **동일 순번의 상이한 파일**은 구별하지 않는다. 수신 측은 순번의 감소만 차단한다.
- **시각.** 만료 판정은 수신 서버의 시계에 의존한다. 시각 오차가 큰 서버는 채널을 거부하거나 만료된 파일을 수용할 수 있다.

## 설치 관리자가 사용하는 함수

`release/jwrelease/` 의 `semver.py`, `model.py`, `verify.py` 세 파일(+ 오프라인 번들의 `bundle.py`, 그 의존 모듈인 `sign.py`, 기본 주소의 `config.py`). 설치 관리자 이미지의 빌드가 해당 파일들을 `/app/jwrelease` 로 **복사**한다 — 동일 코드를 이중으로 유지하지 않는다. 의존성은 `cryptography` 하나이며, 파일·네트워크·시계에 접근하지 않는다(바이트와 "현재 시각"을 인자로 받는다).

| 함수 | 기능 |
|---|---|
| `verify.load_public_keys(pems)` | 공개 키 PEM 1~2개 로드 |
| `verify.verify_signature(data, sig, keys)` | 서명 검증(둘 중 하나의 키로 통과) |
| `verify.verify_channel(data, sig, keys, now=, expected_channel=, last_sequence=)` | 채널 파일 검증 → `Channel` |
| `verify.verify_manifest(data, sig, keys, entry)` | manifest 검증 → `Manifest` |
| `verify.verify_file_hash(data, sha256)` | 다운로드한 파일의 해시 검증 |
| `verify.plan_update(current, channel)` | 수행할 동작의 판정: `current` / `update`(+경로) / `wait` / `blocked` |
| `verify.upgrade_path(current, target, releases)` | 경유 버전 목록 |
| `verify.can_upgrade_directly(current, entry)` | 직접 업데이트 가능 여부 |
| `verify.latest_release(channel)` | 채널의 최신 릴리스 |
| `semver.parse` / `compare` / `is_stable` / `is_beta` | 버전 비교 |
| `model.Channel`, `ReleaseEntry`, `Manifest`, `FileRef`, `AppFile` | 해석 결과 모델 |
| `model.canonical_bytes`, `sha256_hex`, `parse_time` | 직렬화·해시·시각 |

오류는 `verify.VerifyError` 의 하위 유형으로 구분된다: `SignatureError`, `ExpiredError`, `RollbackError`, `HashMismatchError`, `ContentError`, `UpgradeError`.

수신 측 준수 사항: 검증을 통과한 채널의 `sequence` 를 저장하여 다음 검증의 `last_sequence` 로 전달한다. 오프라인 번들 검증(`bundle.verify_bundle`)은 `bundle.py` 에 있다.
