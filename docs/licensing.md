# 라이선스 안내

이 문서는 Just Workspace 를 **받아서 운영하는 사람**과 **이미지를 빌드해 다시 배포하는 사람**이 알아야 할 것을 적는다.
패키지·버전 단위 목록은 [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) 에 있다.

사실(무엇이 어디에 들어가고 라이선스가 무엇인지)과 해석이 필요한 것을 나눠 적었다. **해석 부분은 법률 자문이 아니다.** 이미지를 공개 배포하기 전에 [5. 배포 전 확인 필요](#5-배포-전-확인-필요)를 처리해야 한다.

## 1. 우리 코드

이 리포의 소스는 [MIT License](../LICENSE) 다. 사용·복사·수정·배포·판매가 자유롭고, 사본에 저작권 고지와 라이선스 전문을 넣는 것이 유일한 의무다. 보증은 없다.

MIT 는 **우리가 쓴 코드**에만 해당한다. 배포물은 코드만이 아니라 컨테이너 이미지이고, 이미지에는 남의 소프트웨어가 함께 들어간다. 아래가 그 이야기다.

## 2. 받아 쓰기만 하는 남의 이미지

| 이미지 | 라이선스 | 켜지는 곳 |
|---|---|---|
| PostgreSQL | PostgreSQL License | 기본 |
| Redis 8.8 | RSALv2 / SSPLv1 / AGPL-3.0 삼중(받는 쪽이 하나를 고른다) | 기본 |
| nginx | BSD-2-Clause | 기본 |
| certbot | Apache-2.0 | 기본(인증서 자동 발급을 쓸 때) |
| Gitea | MIT | 코드 저장소 구역 |
| LiveKit server · egress | Apache-2.0 | 회의 구역 |
| OnlyOffice Document Server | **AGPL-3.0** | 문서 편집 구역 |
| SearXNG | **AGPL-3.0** | AI 도우미 구역 |
| kasmweb/chromium | 레시피 MIT · 안의 KasmVNC **GPL-2.0** | 격리 브라우저 |

사실:

- 이 이미지들은 우리 레지스트리에 올리지 않는다. `docker-compose.yml` 이 **원 배포처의 주소와 다이제스트**를 적어 두고, 설치 관리자가 거기서 직접 받는다. 릴리스 목록 파일(manifest)도 원 배포처의 `저장소@sha256:…` 를 싣는다([releases.md](releases.md)). kasmweb/chromium 만 compose 에 없고 backend 가 세션마다 태그로 받아 띄운다.
- 수정하지 않는다. 설정 파일과 환경 변수만 넣는다.
- 우리 코드와는 네트워크(HTTP·WOPI·Redis 프로토콜 등)로만 통신하는 별도 프로세스다.
- **예외 — 오프라인 묶음.** `jwrelease bundle` 에 `--include-third-party` 를 주면 남의 이미지를 `docker save` 한 파일이 묶음에 들어간다([releases.md](releases.md)의 "오프라인 묶음"). 그렇게 만든 묶음을 게시하면 남의 이미지를 **우리가 재배포**하는 것이 된다. 옵션을 주지 않으면 우리 이미지만 담긴다.
- **예외 — 메일 서버.** `mailserver` 는 받아 쓰는 이미지가 아니라 docker-mailserver 위에 보안 갱신을 얹어 우리 이름으로 다시 배포하는 파생 이미지다. 3절에서 다룬다.

해석:

- 원 배포처에서 수정 없이 받아 띄우는 한, 그 이미지의 배포자는 원 배포처이고 운영자는 사용자다. 각 라이선스의 "배포할 때" 의무는 보통 운영자에게 생기지 않는다.
- **AGPL 의 네트워크 조항**은 프로그램을 *수정해서* 네트워크로 서비스할 때 그 수정본의 소스를 이용자에게 제공하라는 것이다. OnlyOffice 와 SearXNG 를 수정 없이 원 이미지로 띄우면 이 조항이 요구하는 것은 없다는 해석이 일반적이다. 운영자가 그 이미지를 고쳐 쓰면 달라진다.
- Redis 는 세 라이선스 가운데 하나를 고르면 된다. RSALv2 와 SSPLv1 은 Redis 자체를 관리형 서비스로 남에게 파는 경우를 제한한다. 워크스페이스의 내부 저장소로 쓰는 것은 해당하지 않는다는 해석이 일반적이다.
- 문서·시트·발표 자료 편집은 OnlyOffice 가 맡는다. 문서 편집 구역을 켜지 않으면 오피스 파일은 올리기·내려받기·검색만 되고 편집은 안 된다. AGPL 구성 요소 없이 운영하려면 문서 편집 구역과 AI 도우미 구역(SearXNG)을 끄면 된다 — 3절의 구성 요소는 그래도 남는다.

## 3. 우리 이미지에 넣어 배포하는 카피레프트 구성 요소

**이미지를 레지스트리에 올려 남이 받게 하는 것 자체가 배포다.** "수정해서 배포할 때만" 의무가 생기는 것이 아니다. 수정하지 않았어도 GPL·LGPL 프로그램의 바이너리를 넘겨주면 그 라이선스의 배포 조건이 적용된다.

### 3.1 무엇이 어디에 들어가는가 (사실)

| 이미지 | 구성 요소 | 라이선스 | 우리 코드와의 관계 |
|---|---|---|---|
| backend | aioimaplib 2.0.3 | **GPL-3.0-only** | `backend/app/mail/imap_client.py` 가 `import` — 같은 파이썬 프로세스 |
| backend | ldap3 2.9.1 | LGPL-3.0 | `backend/app/auth/ldap_client.py` 가 `import` |
| backend | pywebpush 2.5.0 · py-vapid 1.9.6 · certifi | MPL-2.0 | `import`(수정 없음) |
| backend | pandoc | GPL-2.0-or-later | 별도 프로세스로 실행 |
| backend | ffmpeg 와 코덱 라이브러리 | GPL-2.0-or-later(데비안 빌드) | 별도 프로세스로 실행 |
| ldap | psycopg · psycopg-binary 3.3.9 | LGPL-3.0-only | `import` |
| docconv | LibreOffice | MPL-2.0 (일부 LGPL-3.0+) | 별도 프로세스 |
| docconv | H2Orestart v0.8.0 | **GPL-3.0** | LibreOffice 확장 — LibreOffice 프로세스 안에서 돈다. 우리 코드와는 별도 프로세스 |
| docconv | OpenJDK | GPL-2.0 + Classpath 예외 | H2Orestart 실행 환경 |
| rbi-netfilter | iptables · iproute2 · procps | GPL-2.0 계열 | 우리 셸 스크립트가 실행 |
| rbi-mirror | libvips (`@img/sharp-libvips-linux-x64` 1.3.4) | LGPL-3.0-or-later | sharp 가 동적 링크하는 별도 공유 라이브러리 |
| rbi-mirror | iproute2 | GPL-2.0 | 별도 실행 파일 |
| mailserver | ClamAV · Amavis · Fail2ban · Postgrey 등 | GPL-2.0 계열 | 원 이미지(docker-mailserver)에 든 것. 우리는 보안 갱신만 얹는다 |
| mailserver | Postfix · Dovecot | IPL-1.0/EPL-2.0 · MIT/LGPL-2.1 | 〃 |
| 전 이미지 | 베이스 OS(glibc, bash, coreutils, BusyBox 등) | LGPL·GPL | 운영체제 구성 요소 |

sso, sandbox, installer, audiorelay, frontend-react 에는 우리가 고른 의존성 가운데 GPL·LGPL 이 없다(베이스 OS 는 별개, certifi 의 MPL-2.0 은 있다).

### 3.2 GPL 프로그램을 이미지에 담아 배포할 때의 의무

GPL-2.0·GPL-3.0 프로그램의 바이너리를 배포하면 수정 여부와 관계없이 다음이 필요하다.

- 받는 사람에게 **해당 프로그램의 라이선스 전문**을 함께 준다.
- **해당 프로그램의 소스**를 함께 주거나, 받을 수 있는 방법을 제공한다(GPL-2.0 은 3년간 유효한 서면 제공 약속, GPL-3.0 은 같은 곳에서의 내려받기 제공 등).
- 저작권 고지와 무보증 고지를 지우지 않는다.

데비안 패키지로 넣은 것은 이미지 안 `/usr/share/doc/<패키지>/copyright` 에 고지가 남아 있고 소스는 데비안이 공개한다. 다만 **"상위 배포처가 공개하고 있다"는 것만으로 배포자의 소스 제공 의무가 채워지는지는 판단이 필요하다** — 5절.

별도 프로세스로 실행만 하는 GPL 프로그램(pandoc, ffmpeg, iptables, LibreOffice 확장 등)은 같은 이미지에 함께 담겨 있어도 우리 코드의 라이선스에 영향을 주지 않는다는 해석이 일반적이다(GPL 의 "단순 집합").

### 3.3 aioimaplib(GPL-3.0-only)과 backend

사실: backend 는 aioimaplib 을 같은 프로세스에서 `import` 해 호출한다. aioimaplib 은 수정하지 않고 PyPI 배포본을 그대로 설치한다.

해석:

- 파이썬 `import` 로 GPL 라이브러리를 쓰는 프로그램은 그 라이브러리와 **결합 저작물**을 이룬다고 보는 것이 자유 소프트웨어 재단과 다수의 해석이다. 반대 견해도 있고, 법원이 정리한 문제는 아니다.
- MIT 는 GPL-3.0 과 호환된다. 그래서 MIT 코드와 GPL 라이브러리를 **함께 배포하는 것은 가능**하다.
- 다만 결합 저작물로 본다면 **backend 이미지 전체는 GPL-3.0 조건으로 배포되는 것**이 된다. 우리 소스 파일 하나하나는 여전히 MIT 로도 쓸 수 있지만, aioimaplib 이 든 이미지를 받은 사람은 그 결합물에 대해 GPL-3.0 의 권리(전체 소스를 받을 권리 포함)를 가진다. backend 소스가 공개 리포에 있으므로 소스 제공 자체는 충족하기 쉽다.
- 영향이 큰 경우: 누군가 backend 를 고쳐 **소스 비공개로** 이미지를 재배포하려 할 때. MIT 만 보면 가능해 보이지만 aioimaplib 이 들어 있는 한 GPL-3.0 이 이를 막는다. "전체가 MIT" 라는 설명은 이 지점에서 정확하지 않다.
- 직접 설치해 내부에서만 운영하는 것은 배포가 아니므로 GPL 의 배포 조건이 적용되지 않는다. GPL-3.0 에는 AGPL 같은 네트워크 조항이 없다.

같은 기능을 하는 permissive 라이선스 IMAP 라이브러리로 바꾸면 이 문제는 사라진다. 결정 사항이다 — 5절.

### 3.4 LGPL 라이브러리 (ldap3, psycopg, libvips)

LGPL 은 라이브러리를 **쓰는** 프로그램에 자기 조건을 요구하지 않는다. 대신 배포자에게 다음을 요구한다.

- 라이브러리의 라이선스 전문과 저작권 고지를 함께 준다.
- 라이브러리의 소스를 받을 수 있게 한다.
- 받는 사람이 **라이브러리를 고친 판으로 바꿔 끼울 수 있어야** 한다.

파이썬 패키지는 소스 그대로(`site-packages` 의 `.py`) 설치되어 바꿔 끼울 수 있고, `psycopg-binary` 는 `psycopg` 순수 파이썬 판이나 다시 빌드한 휠로 대체할 수 있다. libvips 는 sharp 가 별도 공유 라이브러리로 불러온다. 그래서 교체 가능성 조건은 충족된다는 해석이 일반적이다. 고지와 소스 제공은 배포자가 따로 챙겨야 한다.

### 3.5 MPL-2.0 (pywebpush, py-vapid, certifi, LibreOffice, dompurify)

파일 단위 카피레프트다. MPL 파일을 **고쳐서** 배포하면 그 파일의 소스를 공개해야 한다. 고치지 않고 쓰면 라이선스 고지와 소스 위치를 알리는 것으로 충분하다. dompurify 는 Apache-2.0 을 고를 수 있다.

### 3.6 mailserver 이미지

`mailserver/image/Dockerfile` 은 docker-mailserver 원 이미지 위에서 `apt-get install --only-upgrade` 만 실행한다. 프로그램을 고치지는 않지만 결과물은 **우리가 배포하는 이미지**다. 그 안의 GPL 프로그램(ClamAV 등)에 대해 3.2 의 의무가 우리에게 생긴다. 원 이미지를 그대로 받게 하는 다른 남의 이미지들과 다른 점이다.

## 4. 오픈소스가 아닌 의존성

웹·서버 이미지에는 오픈소스가 아닌 의존성이 없다.

모바일 앱의 Android 푸시(Firebase·Google Play 서비스)와 Android SDK 에는 Google 약관을 따르는 비오픈소스 부분이 있다. `google-services.json` 을 넣어 빌드할 때만 해당한다.

## 5. 배포 전 확인 필요

이미지를 공개 레지스트리에 올리기 전에 사람이 결정하거나 확인해야 하는 것이다. 지금 리포에는 아래를 처리하는 장치가 없다.

1. **이미지 안의 고지가 충분한가.** 우리가 빌드하는 이미지는 모두 `LICENSE` 와 `THIRD_PARTY_LICENSES.md` 를 `/licenses/` 에 담는다(rbi-mirror 는 `THIRD_PARTY-rbi-mirror.md` 도). pip·npm 으로 넣은 패키지의 라이선스 파일은 `site-packages`·`node_modules` 에 남는다(파이썬 이미지, rbi-mirror). 다만 `THIRD_PARTY_LICENSES.md` 는 목록이지 **라이선스 전문 모음이 아니고**, 웹 번들(frontend-react)은 빌드 과정에서 라이선스 주석이 빠질 수 있다. MIT·BSD·Apache-2.0·ISC·OFL 도 저작권 고지와 라이선스 전문의 동봉을 요구하므로, 전문까지 이미지에 넣을지는 정해야 한다.
2. **GPL·LGPL 구성 요소의 소스 제공 방법.** 대상: aioimaplib, ldap3, psycopg, H2Orestart, pandoc, ffmpeg, iptables·iproute2·procps, libvips, OpenJDK, mailserver 이미지 안의 GPL 프로그램, 베이스 OS. 상위 배포처(PyPI·데비안·GitHub) 주소를 안내하는 것으로 충분한지, 해당 버전의 소스를 직접 보관·제공해야 하는지, 서면 제공 약속을 둘지 정해야 한다.
3. **aioimaplib 을 유지할지.** 유지하면 backend 이미지가 GPL-3.0 조건으로 배포된다는 점을 README 와 이 문서에 계속 밝혀야 한다. 바꾸면 3.3 이 없어진다.
4. **H2Orestart(GPL-3.0)를 docconv 이미지에 넣어 배포할지.** 빌드 인자 `H2ORESTART_VERSION` 을 비우면 넣지 않고 빌드된다(HWP 변환을 잃는다).
5. **오프라인 묶음에 남의 이미지를 담을지.** 담으면 OnlyOffice·SearXNG(AGPL-3.0), Redis(삼중 라이선스), kasmweb/chromium(GPL-2.0 인 KasmVNC 포함) 등을 우리가 재배포하는 것이 되고, 각 라이선스의 배포 의무와 상표 사용 조건이 우리에게 생긴다.
6. **mailserver 파생 이미지.** 원 이미지를 그대로 받게 하고 보안 갱신은 다른 방법으로 할지, 파생 이미지를 계속 배포하면서 2번을 처리할지.
7. **버전이 고정되지 않은 데비안 패키지.** pandoc, ffmpeg, LibreOffice 등은 빌드 시점의 판이 들어가므로, 배포한 이미지에 들어간 정확한 버전(소스 제공의 기준)을 빌드 때 기록해 둘 필요가 있다.
8. **아이콘 고지.** `frontend-react/src/utils/icons.ts` 에 Lucide(ISC)에서 옮긴 SVG 경로가 있다. ISC 는 저작권 고지 유지를 요구한다.
10. **데스크톱·모바일 앱.** Electron 설치 파일에는 Chromium 과 FFmpeg(LGPL-2.1+)이 들어간다. 설치 파일에 제3자 고지를 넣는지 확인한다.

## 6. 운영자가 알아 둘 것

- 받은 이미지를 **수정 없이 자기 서버에서 운영**하는 것은 어느 구성 요소에서도 추가 의무를 만들지 않는다는 해석이 일반적이다.
- 이미지를 고치거나 다시 빌드해 **남에게 넘기면** 이 문서의 3절이 그대로 그 사람에게 적용된다. backend 이미지는 aioimaplib 때문에 소스 비공개 재배포가 안 된다.
- AGPL 이미지(OnlyOffice, SearXNG)를 **고쳐서** 이용자에게 서비스하면 그 수정본의 소스를 이용자에게 제공해야 한다.
