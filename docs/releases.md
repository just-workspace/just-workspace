# 릴리스와 채널

제품은 Docker 이미지 묶음으로 배포된다. 설치된 서버의 설치 관리자는 **채널 파일**을 주기적으로 받아 새 버전을 알아낸다.
이 문서는 채널·릴리스 목록의 형식, 서명 규칙, 릴리스를 내는 절차, 그 도구(`release/`)를 다룬다.

설치 관리자가 채널을 받아 적용하는 쪽은 [installer.md](installer.md) 16절과 [update-api.md](update-api.md)다. 그쪽이 쓰는 검증 함수는 [맨 아래](#설치-관리자가-가져다-쓰는-함수)에 있다.

## 한눈에

| 무엇 | 어디(기본값) |
|---|---|
| 소스 | `just-workspace/just-workspace` |
| 채널 파일·릴리스 목록 | 채널 리포 `just-workspace/releases` 의 정적 파일 |
| 이미지 | `ghcr.io/just-workspace/just-workspace-<이름>` |
| 설치 파일·오프라인 묶음 | 소스 리포의 GitHub Releases 첨부 |

주소는 전부 설정값이다([주소 설정값](#주소-설정값)). 다른 곳으로 옮겨도 도구는 바뀌지 않는다.

- **버전**: 제품 전체가 한 버전. Stable 은 `X.Y.Z`, Beta 는 `X.Y.Z-beta.N`(N ≥ 1). 단일 출처는 리포 루트 `VERSION`.
- **채널**: `stable`, `beta`. Beta 채널에는 Stable 릴리스도 들어 있다.
- **서명**: ECDSA P-256. 비공개 키는 릴리스를 내는 사람의 PC 에만 있다. 빌드 서버는 서명하지 않는다.

## 채널 리포의 배치

```
channels/stable.json        channels/stable.json.sig
channels/beta.json          channels/beta.json.sig
releases/<버전>/manifest.json   releases/<버전>/manifest.json.sig
```

## 채널 파일

`channels/<채널>.json` — 스키마 `release/schema/channel.schema.json`, 예시 `release/examples/channel-*.json`.

| 항목 | 뜻 |
|---|---|
| `format` | 형식 버전. 지금은 `1` |
| `channel` | `stable` 또는 `beta` |
| `sequence` | 순번. 파일을 새로 낼 때마다 1 씩 올라간다. 받는 쪽은 이전에 본 값보다 작으면 거부한다 |
| `generated` | 만든 시각(UTC, `YYYY-MM-DDTHH:MM:SSZ`) |
| `expires` | 만료 시각. 지나면 받는 쪽이 거부한다(옛 파일을 다시 내미는 공격 차단). 기본은 만든 때부터 90일 |
| `releases[]` | 릴리스 목록, 버전 오름차순 |
| `releases[].version` | 버전 |
| `releases[].published` | 공개 시각 |
| `releases[].min_upgrade_from` | 이 버전으로 **바로** 올라올 수 있는 최소 버전. 제약이 없으면 `null` |
| `releases[].manifest.path` | 릴리스 목록 파일의 상대 경로(`releases/<버전>/manifest.json`) |
| `releases[].manifest.sha256` | 그 파일 바이트의 SHA-256 |
| `releases[].summary` | 요약 한 줄 |

`stable` 채널에는 `X.Y.Z` 만 들어간다. 낸 릴리스는 목록에서 빼지 않는다 — 오래된 설치가 중간 버전을 거쳐 올라올 때 필요하다.

## 릴리스 목록 파일(manifest)

`releases/<버전>/manifest.json` — 스키마 `release/schema/manifest.schema.json`, 예시 `release/examples/manifest-*.json`.

| 항목 | 뜻 |
|---|---|
| `format` | 형식 버전. 지금은 `1` |
| `version`, `published`, `min_upgrade_from` | 채널 파일의 그 줄과 같은 값(받는 쪽이 대조한다) |
| `promoted_from` | Beta 에서 승격한 릴리스면 그 Beta 버전, 아니면 `null` |
| `db_schema` | DB 스키마 버전(정수) — backend 의 `python -m app.cli schema-version` 출력을 `make-manifest --db-schema` 로 넣는다. 안 넣으면 `null` |
| `images` | 우리가 빌드한 이미지: 이름 → `저장소@sha256:…` |
| `third_party` | 남의 이미지: 구역 id → (이름 → 원 배포처의 `저장소@sha256:…`). compose 에서 뽑는다 |
| `zones.content` | 구역 선언(`backend/app/zones.json`) 사본 |
| `zones.sha256` | `zones.content` 를 [결정적 직렬화](#서명-대상-바이트)한 바이트의 SHA-256 |
| `installer_bundle` | 설치 관리자 번들(compose·템플릿 묶음)의 주소·크기·SHA-256 — **자리**. 지금은 `null` 이다: 번들은 설치 관리자 **이미지**(`images.installer`) 안에 있고, 업데이트는 그 이미지에서 꺼내 쓴다 |
| `apps[]` | 앱 설치 파일: `kind`(`windows-desktop`, `android`), `filename`, `size`, `sha256`, `url` |
| `offline_bundle` | 오프라인 묶음의 주소·크기·SHA-256. 없으면 `null` |
| `changelog` | 변경 내용(마크다운) |
| `plugin_api` | 플러그인 호환 범위 — **자리**. 지금은 `null` |
| `download_bytes` | **선택.** 받을 이미지(우리 것 + 남의 것 전부)의 압축 크기 합(바이트, 0 이상의 정수). 모르면 `null` 이 아니라 **키를 싣지 않는다** — 받는 쪽은 그 줄을 보이지 않는다 |

이미지는 전부 다이제스트로 적는다. 태그는 가리키는 내용이 바뀔 수 있어서 싣지 않는다.
compose 의 남의 이미지는 전부 다이제스트로 고정해 둔다(`이름:태그@sha256:…` — 태그는 읽기 쉽게 남긴 것이고 받는 내용은 다이제스트가 정한다).
태그로만 고정된 남의 이미지가 생기면 `make-manifest` 는 **실패**한다. 채우는 방법은 둘이다.

- `--pins <파일>`: `{"저장소:태그": "sha256:…"}` 표를 준다(예시 `release/examples/pins.json`).
- `--resolve-digests`: 레지스트리에서 그 시점의 다이제스트를 조회해 채운다.

받을 용량(`download_bytes`)을 채우는 방법도 둘이다. 둘 다 안 주면 항목이 빠진다.

- `--download-bytes <바이트>`: 직접 준다.
- `--resolve-sizes`: 레지스트리에서 이미지마다 manifest 를 받아 `linux/amd64` 의 config + 계층 크기를 더한다(익명 조회). 하나라도 조회하지 못하면 경고만 내고 항목을 싣지 않는다 — manifest 는 그대로 만들어진다. 값은 "전부 새로 받을 때"의 크기다. 서버에 이미 있는 계층은 다시 받지 않으므로 실제로 받는 양은 이보다 적을 수 있다.

레지스트리 조회는 https 로 한다. 이 PC 자신의 레지스트리(`localhost`, `127.x.x.x`, `[::1]` — 포트가 붙어도 같다)만 docker 와 같이 평문 http 로 붙는다.

`release/examples/` 의 다이제스트는 형식을 보이기 위한 값이다. 우리 이미지의 것은 지어낸 값이고, 실제 릴리스의 값이 아니다.

## 서명 대상 바이트

채널 파일과 manifest 는 **결정적 직렬화**로 쓴다. 같은 내용이면 누가 만들어도 같은 바이트가 나온다.

1. JSON 객체의 키는 유니코드 코드포인트 순으로 정렬한다(모든 깊이).
2. 구분자는 `,` 와 `:` — 공백·들여쓰기·줄바꿈을 넣지 않는다.
3. UTF-8, BOM 없음. 비 ASCII 문자는 `\uXXXX` 로 바꾸지 않고 그대로 쓴다.
4. 값은 문자열·정수·불리언·null·배열·객체만 쓴다. 실수는 쓰지 않는다.
5. 파일 끝에 줄바꿈(LF) 하나.
6. 배열의 순서는 그대로 둔다.

서명은 **파일에 적힌 바이트 그대로**에 건다. 받는 쪽은 받은 바이트를 다시 직렬화하지 않고 그대로 검증한 다음에 해석한다.
그래서 채널 리포의 이 파일들은 사람이 손으로 고치거나 줄바꿈을 바꾸면 안 된다(채널 리포에서는 git 의 줄바꿈 자동 변환을 끈다).

`release/examples/` 의 파일은 읽기 쉽게 들여쓴 것이다. 실제 파일은 한 줄이다.

## 서명 형식과 cosign 호환

서명 파일 `<파일>.sig` 의 내용은 한 줄이다:

```
base64( ASN.1 DER 로 적은 ECDSA 서명 )      서명 대상 = 파일 바이트의 SHA-256, 곡선 P-256
```

이것은 `cosign sign-blob --key` 가 내는 형식과 같다. 공개 키는 SPKI PEM(`-----BEGIN PUBLIC KEY-----`)으로 `cosign.pub` 과 같은 형식이다.
따라서 다음이 서로 통해야 한다.

```bash
# 이 도구로 서명한 것을 cosign 으로 검증
cosign verify-blob --key release.pub --signature channels/stable.json.sig \
  --insecure-ignore-tlog=true channels/stable.json

# cosign 으로 서명한 것을 이 도구로 검증 (publish --no-sign 으로 파일만 만든 뒤)
cosign sign-blob --key cosign.key --tlog-upload=false \
  --output-signature channels/stable.json.sig channels/stable.json
python -m jwrelease verify --repo . --pubkey cosign.pub
```

- 투명성 로그(Rekor)에 올리지 않는 키 쌍 방식이라 위 플래그가 필요하다. cosign 판에 따라 플래그 이름·기본 출력 형식(번들)이 다르다 — 쓰는 판의 도움말을 확인한다.
- 이 도구가 읽는 비공개 키는 표준 PEM(PKCS#8 또는 SEC1, 암호화 가능)이다. `cosign generate-key-pair` 가 만드는 키 파일은 cosign 고유 포맷이라 읽지 못한다. 그 키로는 cosign 으로 서명한다. 표준 PEM 키를 cosign 에서 쓰려면 `cosign import-key-pair` 로 들여온다.
- **호환은 형식 기준으로 구현했고, 실제 cosign 실행 파일로 교차 검증하지는 못했다.** 첫 릴리스 전에 위 두 명령을 한 번 돌려 확인한다.

## 릴리스 절차

준비: Python 3.10 이상, `pip install -r release/requirements.txt`(`cryptography` 하나). 명령은 `release/` 에서 `python -m jwrelease …` 또는 어디서든 `python release/tools/jwrelease.py …`.

1. **버전 올리기** — `VERSION` 을 `1.1.0-beta.1` 처럼 고쳐 커밋한다.
2. **태그** — `git tag v1.1.0-beta.1 && git push <원격> v1.1.0-beta.1`. 태그와 `VERSION` 이 다르면 빌드가 멈춘다.
3. **빌드(CI)** — `.github/workflows/build-images.yml` 이 우리 이미지를 전부 빌드해 올리고 `digests.json` 을 산출물로 낸다. 수동 실행도 된다(버전 입력).
4. **다이제스트 받기** — 그 실행의 산출물 `digests` 를 내려받는다.
5. **manifest 만들기**
   ```bash
   python -m jwrelease make-manifest --digests digests.json \
     --changelog-file CHANGES.md --min-upgrade-from 1.0.0 --db-schema 3 --resolve-sizes \
     --apps-dir ./apps-out --pins pins.json -o work/manifest.json
   ```
   버전은 `VERSION` 에서 읽는다(`--version` 으로 덮을 수 있다). `digests.json` 의 버전과 다르면 멈춘다.
6. **Beta 게시** — 채널 리포를 받아 둔 작업 디렉터리에:
   ```bash
   python -m jwrelease publish --repo ../releases --manifest work/manifest.json --channel beta --key ~/keys/release.pem
   ```
   `releases/<버전>/` 을 넣고 `channels/beta.json` 을 갱신(순번 +1, 만료 갱신)·서명한다. **커밋·푸시는 하지 않는다** — 출력된 안내대로 `verify` 로 확인하고 직접 커밋·푸시한다.
7. **승격** — 시험이 끝나면:
   ```bash
   python -m jwrelease promote --repo ../releases --version 1.1.0-beta.1 --key ~/keys/release.pem
   ```
   이미지를 다시 빌드하지 않는다. 버전 문자열만 다른 manifest(`1.1.0`, `promoted_from` 기록)를 만들어 `stable.json` 과 `beta.json` 에 더하고, 같은 다이제스트에 Stable 태그를 붙이는 `docker buildx imagetools create` 명령을 **출력**한다(`--run` 을 주면 실행). 그 뒤 확인·커밋·푸시.
   승격한 버전의 git 태그(`v1.1.0`)를 푸시해도 CI 는 빌드하지 않는다(빌드 트리거는 Beta 태그와 수동 실행뿐이다).

Stable 을 Beta 없이 바로 내려면 6번에서 `--channel stable` 을 쓴다(그 릴리스는 beta 채널에도 들어간다).

비공개 키의 암호는 환경변수 `JWRELEASE_KEY_PASSWORD` 로 주거나, 없으면 물어본다.
다른 도구로 서명하려면 `--no-sign` 으로 파일만 만든다(서명할 파일 목록이 출력된다).

### 명령 요약

| 명령 | 하는 일 |
|---|---|
| `images` | compose 의 이미지 목록 — 우리 것, 남의 것, 다이제스트 없는 것 |
| `make-manifest` | `digests.json` + compose + `zones.json` (+ 앱 파일, 변경 내용, DB 스키마 버전, 받을 용량) → `manifest.json` |
| `sign` | 파일에 서명(`.sig`) |
| `publish` | 채널 리포 작업 디렉터리에 릴리스를 넣고 채널 파일 갱신·서명 |
| `promote` | Beta 릴리스를 Stable 로 |
| `verify` | 채널 디렉터리(`--repo`) 또는 주소(`--url`)의 채널·manifest 를 공개 키로 전부 검증 |
| `refresh` | 릴리스 없이 채널 파일의 만료만 갱신(순번 +1) |
| `bundle plan / index / pack / verify` | 오프라인 묶음 |

### 승격과 표시 버전

승격은 이미지를 다시 빌드하지 않으므로 **이미지 안에 구워진 버전 문자열은 승격 뒤에도 Beta 의 것**이다.
화면·API 에 보이는 버전은 실행할 때 환경변수로 넣어야 한다.

| 이미지 | 버전을 아는 방법 | 승격 뒤 |
|---|---|---|
| backend | 환경변수 `JW_APP_VERSION` → 없으면 이미지의 `/app/VERSION`(빌드 인자) → 개발 표기 | 실행 환경이 `JW_APP_VERSION` 을 넣으면 맞다. 안 넣으면 Beta 문자열이 보인다 |
| audiorelay | 환경변수 `JW_APP_VERSION` → 없으면 바이너리에 구운 값(빌드 인자 `VERSION`) | backend 와 같다 |
| 설치 관리자 | 환경변수 `JW_INSTALLER_VERSION` → 없으면 이미지의 번들에 든 `VERSION` | 업데이트로 바뀐 설치 관리자는 맞다(업데이트가 그 값을 넣어 띄운다). 승격한 이미지를 **처음 설치할 때**는 `docker run` 에 `-e JW_INSTALLER_VERSION=<버전>` 을 준다(문서의 설치 명령이 모두 그렇게 적혀 있다). 주지 않으면 Beta 문자열을 자신의 버전으로 알고, 시작할 때 로그에 한 줄로 알린다 |
| 그 밖의 이미지 | 제품 버전을 표시하지 않는다 | 영향 없음 |

## 만료 갱신

채널 파일은 만든 때부터 90일(설정 `expires_days`) 뒤에 만료된다. 릴리스가 없어도 **만료 전에** 갱신해야 한다 — 만료되면 설치된 서버가 채널을 받아들이지 않아 새 버전을 알 수 없게 된다(이미 돌고 있는 서비스에는 영향이 없다).

```bash
python -m jwrelease refresh --repo ../releases --key ~/keys/release.pem
```

두 채널 모두 순번이 1 올라가고 만료가 다시 90일 뒤로 간다. 두 달에 한 번을 권한다. 서명이 필요해서 자동화하려면 비공개 키를 자동화 환경에 둬야 하는데, 그것은 아래 원칙과 어긋나므로 사람이 한다.

## 키 관리

- **비공개 키는 릴리스를 내는 사람의 PC 에만 둔다.** 빌드 서버·리포·채널 리포에 두지 않는다. 암호를 걸고 오프라인 사본을 따로 보관한다.
- 리포에는 어떤 키도 커밋하지 않는다. 테스트는 실행할 때마다 임시 키를 만들어 쓴다.
- 받는 쪽(설치 관리자)은 **공개 키 자리 둘** — 현재 키와 다음 키 — 을 갖고, 어느 하나로 검증되면 통과시킨다.

키 만들기(표준 PEM, 암호 걸기):

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -aes256 -out release.pem
openssl pkey -in release.pem -pubout -out release.pub
```

교체 절차:

1. 새 키 쌍을 만든다.
2. 새 공개 키를 "다음 키" 자리에 넣은 설치 관리자를 릴리스한다(서명은 아직 옛 키로).
3. 설치들이 그 릴리스로 충분히 올라온 뒤부터 새 키로 서명한다. 그 전에 바꾸면 옛 설치는 채널을 검증하지 못한다.
4. 다음 설치 관리자 릴리스에서 새 키를 "현재 키" 자리로 옮기고 옛 키를 뺀다.

비공개 키가 새면 2~3단계를 기다릴 수 없다. 그때는 새 키를 넣은 설치 관리자를 다른 경로로 알려 손으로 올리게 해야 한다 — 그래서 "다음 키"를 미리 만들어 자리에 넣어 두는 편이 안전하다.

## 받는 쪽의 검증 순서

채널 파일: **서명 → 형식 → 만료 → 순번**(이전에 받아들인 순번보다 작으면 거부).
manifest: **해시**(채널 파일에 적힌 값) **→ 서명 → 내용**(버전·공개 시각·`min_upgrade_from` 이 채널의 줄과 일치).

버전 판정:

- 채널의 최신이 현재와 같다 → 할 일 없음.
- 최신이 더 높다 → 올린다. `min_upgrade_from` 때문에 바로 못 가면 그 사이 릴리스를 거친다(거치는 횟수가 가장 적은 경로).
- 최신이 더 낮다 → **기다린다**. Beta 를 쓰다가 Stable 로 바꾼 직후가 이렇다. 내려가지 않고, Stable 이 현재 버전 이상이 되면 올라간다(`1.2.0` 은 `1.2.0-beta.3` 보다 높다).
- 다운그레이드는 하지 않는다.

## 오프라인 묶음

인터넷이 없는 서버로 옮겨 설치하기 위한 tar 한 파일(`just-workspace-<버전>-offline.tar`).

```
bundle.json            색인: 형식 버전, 제품 버전, 만든 시각, 파일 목록(경로·크기·SHA-256), 이미지 표
bundle.json.sig        색인의 서명
manifest.json          릴리스 목록 파일 (offline_bundle 은 null)
manifest.json.sig
images/<이름>.tar      docker save 결과, 이미지마다 하나
```

검증 순서: **묶음 서명**(`bundle.json.sig`) **→ manifest**(색인의 해시와 일치, 자체 서명, 색인의 버전·이미지 표와 일치) **→ 파일별 해시**(색인의 모든 파일이 있고 크기·해시가 같으며 색인에 없는 파일이 없다).

만들기:

```bash
python -m jwrelease bundle plan  --manifest work/manifest.json --stage stage   # docker pull·tag·save 명령 출력(--run 이면 실행)
python -m jwrelease bundle index --stage stage --key ~/keys/release.pem        # bundle.json + 서명
python -m jwrelease bundle pack  --stage stage                                 # tar 한 파일
python -m jwrelease bundle verify just-workspace-1.1.0-offline.tar --pubkey release.pub
```

- 묶음 안의 manifest 는 `offline_bundle` 이 비어 있는 판이다(묶음이 자기 해시를 담을 수 없다). 묶음의 크기·해시를 실은 manifest 는 묶음을 만든 **뒤에** `make-manifest --offline-bundle <파일>` 로 다시 만들어 게시한다. 두 manifest 는 `offline_bundle` 만 다르다.
- `docker load` 는 레지스트리 다이제스트를 되살리지 못한다. 그래서 묶음의 이미지는 태그로 저장한다 — 우리 이미지는 `저장소:<버전>`, 남의 이미지(`--include-third-party`)는 `저장소:jw-<다이제스트 앞 12자>`. 오프라인 설치는 색인의 `images[].tag` 로 이미지를 가리킨다.
- **검수 서버에서 확인한 범위.** 릴리스 도구로 실제 `docker save` 묶음을 만들고(`bundle plan` → `index` → 서명 → `pack` → `verify`), 레지스트리와 채널을 끈 서버에 올려 검증·추가 이미지 판정을 거친 뒤 묶음과 이미지 파일만으로 업데이트를 끝냈다([installer.md](installer.md) 13절의 `u8`). 색인·묶기·검증의 형식은 테스트로도 고정돼 있다. 확인하지 못한 것은 실제 서명 키로 낸 묶음과 여러 GB 묶음을 앞단 프록시를 거쳐 올리는 경우다.

## 주소 설정값

기본값은 `release/jwrelease/config.py`. 설정 파일(`--config settings.json`, 예시 `release/examples/settings.json`)이나 환경변수로 덮는다. 우선순위는 환경변수 > 설정 파일 > 기본값.

| 설정 | 환경변수 | 기본값 | 쓰이는 곳 |
|---|---|---|---|
| `registry` | `JWRELEASE_REGISTRY` | `ghcr.io/just-workspace` | 우리 이미지의 저장소. compose 의 `JW_REGISTRY` 와 같은 값 |
| `image_prefix` | `JWRELEASE_IMAGE_PREFIX` | `just-workspace-` | 이미지 이름 앞머리(`<registry>/<prefix><이름>`) |
| `channel_base_url` | `JWRELEASE_CHANNEL_BASE_URL` | `https://raw.githubusercontent.com/just-workspace/releases/main` | 채널 파일·manifest 를 내려받는 기준 주소(`verify --url` 의 기본) |
| `channel_repo_url` | `JWRELEASE_CHANNEL_REPO_URL` | `https://github.com/just-workspace/releases` | 안내 출력 |
| `download_url_template` | `JWRELEASE_DOWNLOAD_URL_TEMPLATE` | `https://github.com/just-workspace/just-workspace/releases/download/v{version}/{filename}` | 앱 설치 파일·오프라인 묶음의 주소 |
| `expires_days` | `JWRELEASE_EXPIRES_DAYS` | `90` | 채널 파일 만료까지의 날 수 |

빌드 워크플로 쪽은 리포 Variables 로 정한다: `JW_REGISTRY`(기본 `ghcr.io`), `JW_IMAGE_NS`(기본 리포 소유자), `JW_IMAGE_PREFIX`(기본 `just-workspace-`). GHCR 가 아닌 레지스트리면 Secrets `REGISTRY_USER`·`REGISTRY_TOKEN` 을 넣는다.
두 쪽의 값이 어긋나면 `make-manifest` 가 "저장소가 다르다"로 멈춘다.

## 빌드 워크플로

`.github/workflows/build-images.yml` — Beta 태그(`v*-beta.*`) 푸시 또는 수동 실행. Stable 태그(`v1.1.0`)는 빌드를 일으키지 않는다 — Stable 은 승격으로만 만든다.

- 빌드하는 것: backend, frontend-react, sso, ldap, mailserver, audiorelay, docconv, sandbox, rbi-netfilter, rbi-mirror, 그리고 설치 관리자(`installer/Dockerfile`, 문맥은 리포 루트 — 받을 이미지 저장소를 빌드 인자 `JW_REGISTRY` 로 굽는다).
- `linux/amd64` 만. 태그는 버전 하나(`latest` 는 붙이지 않는다). 빌드 캐시는 GitHub Actions 캐시.
- 각 작업이 이름 → 다이제스트를 내고, 마지막 작업이 `digests.json` 으로 모아 산출물 `digests` 로 올린다(보존 90일).
- 서명·채널 갱신 단계는 없다. 비공개 키도 없다.
- 액션은 커밋 SHA 로 고정했다.
- 빌드 컨텍스트·Dockerfile·target 은 compose 의 `build` 설정과 같아야 한다. `release/tests/test_workflow.py` 가 대조한다.
- 모든 이미지에 라이선스 고지(`LICENSE`, `THIRD_PARTY_LICENSES.md`)가 `/licenses/` 로 들어간다. 두 파일은 각 이미지의 빌드 컨텍스트 밖(리포 루트)에 있어 **이름 붙인 컨텍스트 `licenses`** 로 받는다 — compose 는 `build.additional_contexts`, 워크플로는 `build-contexts: licenses=.`, 손으로 빌드할 때는 `docker build --build-context licenses=<리포 루트> …`. 리포 루트의 `.dockerignore` 가 그 컨텍스트로 두 파일만 보낸다. 설치 관리자 이미지는 컨텍스트가 리포 루트라 바로 복사한다.

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

docker·네트워크 없이 돈다. compose 의 이미지 구성이 바뀌면 `tests/test_compose.py` 의 스냅샷과 `tests/test_workflow.py` 가 깨진다 — 워크플로 매트릭스와 함께 고친다.

## 알려진 한계

- **cosign 교차 검증을 하지 않았다.** 형식은 맞췄지만 실제 cosign 으로 서명·검증해 보지 않았다.
- **빌드 워크플로를 실제로 돌려 보지 않았다.** YAML 문법과 구조만 확인했다.
- **수동 실행으로 Stable 버전을 빌드할 수 있다.** 트리거는 Beta 태그뿐이지만 수동 실행의 버전 입력은 `X.Y.Z` 도 받는다(첫 릴리스처럼 Beta 를 거치지 않는 경우를 위해). 이미 승격한 버전을 수동으로 다시 빌드하면 태그가 다른 다이제스트를 가리키게 되므로 하지 않는다.
- **compose 읽기는 필요한 범위만.** `image`·`build`·`profiles` 만 읽는다. 그 항목에 앵커·병합 키·여러 줄 값을 쓰면 멈춘다. `include`·`extends` 로 나눈 compose 는 읽지 못한다.
- **`--resolve-digests`·`--resolve-sizes` 는 익명 조회.** 인증이 필요한 레지스트리의 남의 이미지는 `--pins` 로 준다. 조회 값은 그 시점에 태그가 가리키던 것이라, 시험한 이미지와 같은지는 사람이 확인해야 한다 — compose 에서 다이제스트로 고정해 두는 편이 낫다.
- **여러 아키텍처 미지원.** `linux/amd64` 만 빌드한다.
- **앱 설치 파일은 사이트마다 따로 빌드하는 구조**라서 지금은 릴리스에 실을 공용 파일이 없다. `apps[]` 는 형식만 준비돼 있다.
- **같은 순번의 다른 파일**은 구별하지 않는다. 받는 쪽은 순번이 작아지는 것만 막는다.
- **시계.** 만료 판정은 받는 서버의 시계에 기댄다. 시계가 크게 틀린 서버는 채널을 거부하거나 만료된 파일을 받아들일 수 있다.

## 설치 관리자가 가져다 쓰는 함수

`release/jwrelease/` 의 `semver.py`, `model.py`, `verify.py` 세 파일(+ 오프라인 묶음의 `bundle.py`, 그것이 끌어오는 `sign.py`, 기본 주소의 `config.py`). 설치 관리자 이미지의 빌드가 이 파일들을 `/app/jwrelease` 로 **복사**한다 — 같은 코드를 두 벌 두지 않는다. 의존성은 `cryptography` 하나이고, 파일·네트워크·시계를 건드리지 않는다(바이트와 "지금 시각"을 인자로 받는다).

| 함수 | 하는 일 |
|---|---|
| `verify.load_public_keys(pems)` | 공개 키 PEM 1~2개 읽기 |
| `verify.verify_signature(data, sig, keys)` | 서명 검증(어느 한 키로 통과) |
| `verify.verify_channel(data, sig, keys, now=, expected_channel=, last_sequence=)` | 채널 파일 검증 → `Channel` |
| `verify.verify_manifest(data, sig, keys, entry)` | manifest 검증 → `Manifest` |
| `verify.verify_file_hash(data, sha256)` | 내려받은 파일의 해시 확인 |
| `verify.plan_update(current, channel)` | 무엇을 할지: `current` / `update`(+경로) / `wait` / `blocked` |
| `verify.upgrade_path(current, target, releases)` | 거쳐야 하는 버전 목록 |
| `verify.can_upgrade_directly(current, entry)` | 한 번에 갈 수 있는가 |
| `verify.latest_release(channel)` | 채널의 최신 릴리스 |
| `semver.parse` / `compare` / `is_stable` / `is_beta` | 버전 비교 |
| `model.Channel`, `ReleaseEntry`, `Manifest`, `FileRef`, `AppFile` | 해석한 내용 |
| `model.canonical_bytes`, `sha256_hex`, `parse_time` | 직렬화·해시·시각 |

오류는 `verify.VerifyError` 의 하위 종류로 나뉜다: `SignatureError`, `ExpiredError`, `RollbackError`, `HashMismatchError`, `ContentError`, `UpgradeError`.

받는 쪽이 지킬 것: 검증을 통과한 채널의 `sequence` 를 저장해 다음 검증의 `last_sequence` 로 넘긴다. 오프라인 묶음 검증(`bundle.verify_bundle`)은 `bundle.py` 에 있다.
