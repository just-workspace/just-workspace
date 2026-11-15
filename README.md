# Just Workspace

[English](README.en.md) · 한국어

Just Workspace 는 내 서버에 설치해 쓰는 협업 워크스페이스입니다. 파일, 메일, 채팅, 일정·연락처·할 일, 문서 편집·위키·게시판, 화상 회의, 코드 저장소, AI 도우미를 하나의 계정과 하나의 웹 화면으로 씁니다. Docker 가 있는 리눅스 서버 한 대에 설치하고, 필요한 기능만 "구역" 단위로 골라 켭니다.

> **첫 릴리스(1.0.0) 준비 중입니다.** 미리 빌드한 이미지와 업데이트 채널은 아직 공개되지 않았습니다. 지금은 소스에서 이미지를 빌드해 설치합니다 — [프로젝트 상태](#프로젝트-상태).

## 무엇이 들어 있나

기능은 구역으로 나뉩니다. **기본** 구역은 항상 설치되고, 나머지는 설치할 때 고르거나 설치 후 관리 화면에서 켜고 끕니다. 끈 구역의 데이터는 지워지지 않습니다.

| 구역 | 내용 | 권장 메모리 | 여는 포트 |
|---|---|---|---|
| **기본** (항상) | 로그인, 관리, 대시보드, 파일 | 4 GB | 80, 443 |
| 메일 | 내장 메일 서버 또는 외부 발신 서버 | +1 GB | 25, 465, 587, 993 |
| 채팅 | 채널, 대화, 음성 채널(회의 구역 필요) | — | — |
| 일정·연락처·할 일 | 달력 동기화(CalDAV·CardDAV) 포함 | — | — |
| 문서 편집·위키·게시판 | 문서·시트·발표 자료 함께 편집 | +2 GB | — |
| 회의 | 화상 회의, 화면 공유, 녹화, 무손실 오디오 | +1 GB | 7881, 7882-7892/udp, 3478/udp, (무손실 오디오) 4433/udp |
| 코드 저장소 | Git 호스팅(Gitea) | +0.5 GB | 2222 |
| AI 도우미 | 외부 AI 서비스 연결, 웹 검색, 코드 실행, MCP 커넥터 | +1 GB | — |

선택 애드온:

| 애드온 | 내용 | 권장 메모리 | 여는 포트 |
|---|---|---|---|
| SSO·LDAP 제공 | 다른 서비스가 이 워크스페이스 계정으로 로그인 | +0.5 GB | 636, (기본은 이 서버 안에서만) 389 |
| 격리 브라우저 | 내부 웹 화면을 격리된 브라우저로 열기 | +0.1 GB | — |

값의 출처는 [`backend/app/zones.json`](backend/app/zones.json) 입니다. 설치 마법사는 묶음 세 가지를 줍니다: **최소**(기본만), **협업**(메일·채팅·일정·문서), **전체**(일곱 구역 모두).

문서 편집기(OnlyOffice), 회의 서버(LiveKit), 코드 저장소(Gitea), 데이터베이스(PostgreSQL) 같은 **다른 곳에서 만든 구성 요소는 이 프로젝트의 이미지에 담아 다시 배포하지 않습니다.** 구역을 켤 때 원 배포처에서 받으며, 받을 이미지는 다이제스트로 고정해 둡니다. 각 구성 요소는 자기 라이선스를 따릅니다 — [라이선스](#라이선스).

## 요구 사항

| 항목 | 최소 | 비고 |
|---|---|---|
| 운영 체제 | 리눅스, x86_64 | Windows·macOS 의 Docker Desktop 은 지원하지 않습니다 |
| Docker Engine | 24.0 이상 | |
| 프로세서 | 2코어 | |
| 메모리 | 4 GB | 고른 구역의 권장 메모리 합계가 서버 메모리 안에 들어와야 설치됩니다 |
| 디스크 여유 | 10 GB | 20 GB 미만이면 경고합니다. 파일·메일이 쌓일 공간은 따로 계산합니다 |
| 네트워크 | 80(직접 받을 때 443 도) 이 비어 있을 것 | 인증서 자동 발급에는 접속 주소(도메인)가 이 서버를 가리켜야 합니다 |

설치 관리자가 시작할 때 이 조건을 점검합니다(사전 점검). 메모리의 기준은 구역 표의 권장값입니다: 최소 묶음 4 GB, 협업 묶음 7 GB, 전체 묶음 9.5 GB. 검수에서는 전체 묶음에 SSO·LDAP 애드온을 더한 구성을 메모리 12 GB 서버에서 띄웠습니다.

## 빠른 시작

서버 터미널에서 설치 관리자를 띄웁니다.

```bash
docker run -d --name jw-installer --restart unless-stopped \
  -p 8443:8443 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/just-workspace:/data \
  -e JW_HOST_DIR=/opt/just-workspace \
  -e JW_INSTALLER_VERSION=1.0.0 \
  ghcr.io/just-workspace/just-workspace-installer:1.0.0

docker logs jw-installer
```

로그에 나온 주소(`https://<서버 주소>:8443/?token=…`)를 브라우저로 열면 설치 마법사가 시작됩니다. 설치 관리자의 인증서는 자체 서명이라 브라우저가 경고를 보여 줍니다 — 로그의 SHA-256 지문과 대조하고 진행합니다.

- `-v` 의 호스트 폴더와 `JW_HOST_DIR` 은 **같은 경로**여야 합니다. 이 폴더가 설치 폴더입니다.
- `JW_INSTALLER_VERSION` 에는 이미지 태그와 같은 버전을 적습니다 — 설치 관리자가 설치할 제품 버전입니다.
- 위 이미지는 첫 릴리스와 함께 공개됩니다. 그 전에는 소스에서 빌드합니다 — [docs/install.md](docs/install.md#소스에서-빌드해-설치).
- 화면 없이 설치하려면 답변 파일을 씁니다: `docker exec jw-installer jw apply --answers /data/answers.json`.
- 설치 관리자 없이 `docker compose` 로 직접 띄울 수도 있습니다 — [docs/deployment.md](docs/deployment.md).

자세한 준비물(도메인, 포트, 인증서, 저장소)과 화면별 설명은 [docs/install.md](docs/install.md).

## 설치한 뒤

모두 관리 화면에서 합니다. 자세한 것은 [docs/operate.md](docs/operate.md).

- **구역 켜고 끄기** — 관리 › 구역.
- **업데이트** — 관리 › 업데이트. 수동(기본) 또는 자동, 채널은 안정판(Stable)·시험판(Beta). 업데이트 직전에 자동으로 백업하고, 실패하면 되돌립니다. 인터넷이 없는 서버는 묶음 파일로 올립니다.
- **백업** — 관리 › 저장소·백업. 백업 파일 하나(`.jwbak`)로 새 서버에 그대로 옮길 수 있습니다(설치 마법사의 "백업에서 복원").
- **인증서** — 관리 › 보안·SSL 의 인증서 카드에서 다시 발급하거나 가진 인증서로 바꿉니다.

## 문서

| 읽는 사람 | 문서 | 내용 |
|---|---|---|
| 설치하는 사람 | [docs/install.md](docs/install.md) | 준비물, 설치 마법사 단계, 빠른 설치, 무인 설치, 문제 해결 |
| | [docs/deployment.md](docs/deployment.md) | 설치 관리자 없이 직접 설치 |
| 운영하는 사람 | [docs/operate.md](docs/operate.md) | 구역, 업데이트, 백업·복원·서버 이전, 저장소, 인증서, 메일 레코드, 로그 |
| | [docs/update-system.md](docs/update-system.md) | 업데이트가 하는 일과 실패했을 때 |
| | [docs/data-safety.md](docs/data-safety.md) | 스키마 버전, 백업 형식, 복원 |
| | [docs/CONFIG.md](docs/CONFIG.md) | 환경변수 |
| | [SECURITY.md](SECURITY.md) | 보안 모델, 취약점 신고 |
| 구조를 보는 사람 | [docs/architecture.md](docs/architecture.md) | 구성 요소와 구조 |
| | [docs/installer.md](docs/installer.md) | 설치 관리자의 구조·API·검증 범위 |
| | [docs/update-api.md](docs/update-api.md) · [docs/releases.md](docs/releases.md) | 업데이트 내부 API · 릴리스와 채널, 이미지 빌드 |
| 기능별 | [docs/CONNECTOR.md](docs/CONNECTOR.md) | MCP 커넥터 |
| | [docs/chat-permissions.md](docs/chat-permissions.md) | 채팅 역할·권한 |
| | [docs/rbi.md](docs/rbi.md) | 격리 브라우저 |
| | [docs/voice-lossless.md](docs/voice-lossless.md) | 무손실 오디오 |
| | [apps/README.md](apps/README.md) · [apps/desktop/README.md](apps/desktop/README.md) | 모바일 · 데스크톱 앱 |
| 만드는 사람 | [CONTRIBUTING.md](CONTRIBUTING.md) | 개발 환경, 테스트, 커밋·PR |
| | [docs/extensions.md](docs/extensions.md) · [docs/plugin-frontend.md](docs/plugin-frontend.md) · [frontend-react/docs/plugin-v2.md](frontend-react/docs/plugin-v2.md) | 플러그인 |
| 모두 | [docs/glossary.md](docs/glossary.md) | 용어 |
| | [CHANGELOG.md](CHANGELOG.md) | 변경 기록 |
| | [docs/licensing.md](docs/licensing.md) · [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) | 라이선스 |

## 프로젝트 상태

버전은 1.0.0 이고, 첫 공개 릴리스를 준비하고 있습니다.

**검수 전용 서버에서 처음부터 끝까지 확인한 것** ([docs/installer.md](docs/installer.md) 13절):

- 답변 파일과 설치 마법사로 하는 설치 — 최소·협업·전체 묶음, SSO·LDAP 애드온, NFS 저장소, 앞단 프록시 뒤 구성.
- 설치 후 구역 켜고 끄기, 설치 실패 뒤 그 단계부터 다시 하기, 다시 설치.
- 업데이트 — 수동·자동·중간 버전 거치기·실패 시 되돌림·복원 지점으로 복원·시험판 채널·오프라인 묶음. 릴리스 도구로 만든 릴리스를 서버 안의 시험용 채널로 돌렸습니다.
- 설치 관리자 없이 직접 띄우는 최소 구성.

**아직 확인하지 못한 것:**

- 실제 배포 채널과 서명 키로 하는 업데이트, 이미지 빌드 워크플로의 실제 실행.
- Let's Encrypt 의 실제 발급과 갱신(발급 실패 → 임시 인증서로 계속하는 흐름만 확인).
- 신뢰되는 인증서에서의 코드 저장소 로그인 연동, 격리 브라우저 애드온, 무손실 오디오, 외부 SMTP·AI 제공자 연결, 지정 폴더 저장소.
- 공유기 뒤 구성과 실제 앞단 프록시, SELinux 가 켜진 배포판, x86_64 가 아닌 서버.

## 라이선스

이 리포의 소스는 [MIT](LICENSE) 입니다. 다만 함께 쓰이는 것들 가운데 MIT 가 아닌 것이 있습니다.

- **우리 이미지에 들어가는 카피레프트 구성 요소** — backend 이미지의 IMAP 클라이언트 `aioimaplib`(GPL-3.0)과 pandoc·ffmpeg(GPL), 문서 변환 이미지의 LibreOffice 와 HWP 확장 H2Orestart(GPL-3.0), 메일 서버 이미지(docker-mailserver 에서 파생 — 안에 GPL 프로그램이 있습니다) 등. 이미지를 배포하는 것 자체가 배포이므로 그 라이선스의 의무가 따릅니다.
- **원 배포처에서 받아 쓰는 구성 요소** — OnlyOffice Document Server·SearXNG(AGPL-3.0), Redis 8(RSALv2 / SSPLv1 / AGPL-3.0 가운데 선택) 등. 이들은 우리 이미지에 담지 않습니다.
- **오픈소스가 아닌 의존성** — 회의의 소음 제거용 `@livekit/krisp-noise-filter` 는 오픈소스 라이선스가 아니며(LiveKit 의 약관을 따릅니다), 웹 화면 번들에 들어 있습니다.

무엇이 어느 이미지에 들어가고 어떤 의무가 따르는지는 [docs/licensing.md](docs/licensing.md), 전체 목록은 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) 에 있습니다.

## 기여와 보안 신고

- 버그 신고·기능 제안·코드 기여: [CONTRIBUTING.md](CONTRIBUTING.md)
- 보안 취약점은 공개 이슈로 올리지 말고 GitHub 의 비공개 취약점 신고로 알려 주세요: [SECURITY.md](SECURITY.md)
