# Just Workspace

[English](README.en.md) · 한국어

## 개요 (Overview)

Just Workspace 는 자체 서버에 설치하여 운영하는 협업 워크스페이스이다. 파일, 메일, 채팅, 일정·연락처·할 일, 문서 편집·위키·게시판, 화상 회의, 코드 저장소, AI 도우미를 단일 계정과 단일 웹 화면으로 제공한다. Docker 가 설치된 리눅스 서버 1대에 설치하며, 필요한 기능만 "구역" 단위로 선택하여 활성화한다.

> **첫 릴리스(1.0.0)는 준비 단계에 있다.** 사전 빌드 이미지와 업데이트 채널은 아직 공개되지 않았다. 현재는 소스에서 이미지를 빌드하여 설치한다 — [프로젝트 상태](#프로젝트-상태-project-status).

## 주요 기능 (Features)

기능은 구역 단위로 구성된다. **기본** 구역은 항상 설치되며, 그 밖의 구역은 설치 시 선택하거나 설치 후 관리 화면에서 활성화·비활성화한다. 비활성화한 구역의 데이터는 삭제되지 않는다.

| 구역 | 내용 | 권장 메모리 | 개방 포트 |
|---|---|---|---|
| **기본** (항상) | 로그인, 관리, 대시보드, 파일 | 4 GB | 80, 443 |
| 메일 | 내장 메일 서버 또는 외부 발신 서버 | +1 GB | 25, 465, 587, 993 |
| 채팅 | 채널, 대화, 음성 채널(회의 구역 필요) | — | — |
| 일정·연락처·할 일 | 달력 동기화(CalDAV·CardDAV) 포함 | — | — |
| 문서 편집·위키·게시판 | 문서·시트·발표 자료 공동 편집 | +2 GB | — |
| 회의 | 화상 회의, 화면 공유, 녹화, 무손실 오디오 | +1 GB | 7881, 7882-7892/udp, 3478/udp, (무손실 오디오) 4433/udp |
| 코드 저장소 | Git 호스팅(Gitea) | +0.5 GB | 2222 |
| AI 도우미 | 외부 AI 서비스 연결, 웹 검색, 코드 실행, MCP 커넥터 | +1 GB | — |

선택 애드온:

| 애드온 | 내용 | 권장 메모리 | 개방 포트 |
|---|---|---|---|
| SSO·LDAP 제공 | 타 서비스에 본 워크스페이스 계정 기반 로그인 제공 | +0.5 GB | 636, (기본값은 이 서버 내부 한정) 389 |
| 격리 브라우저 | 내부 웹 화면을 격리된 브라우저로 열람 | +0.1 GB | — |

값의 출처는 [`backend/app/zones.json`](backend/app/zones.json) 이다. 설치 마법사는 세 가지 프리셋을 제공한다: **최소**(기본 구역 한정), **협업**(메일·채팅·일정·문서), **전체**(7개 구역 전부).

문서 편집기(OnlyOffice), 회의 서버(LiveKit), 코드 저장소(Gitea), 데이터베이스(PostgreSQL) 등 **제3자가 제작한 구성 요소는 본 프로젝트의 이미지에 포함하여 재배포하지 않는다.** 해당 구성 요소는 구역 활성화 시 원 배포처에서 직접 pull 하며, 대상 이미지는 다이제스트(digest)로 고정한다. 각 구성 요소에는 자체 라이선스가 적용된다 — [사용 및 배포에 관한 규정](#사용-및-배포에-관한-규정-license--distribution).

## 시스템 요구 사항 (System Requirements)

| 항목 | 최소 | 비고 |
|---|---|---|
| 운영 체제 | 리눅스, x86_64 | Windows·macOS 의 Docker Desktop 은 지원하지 않는다 |
| Docker Engine | 24.0 이상 | |
| 프로세서 | 2코어 | |
| 메모리 | 4 GB | 선택한 구역의 권장 메모리 합계가 서버 메모리 이내여야 설치가 진행된다 |
| 디스크 여유 공간 | 10 GB | 20 GB 미만인 경우 경고가 표시된다. 파일·메일 저장 용량은 별도로 산정한다 |
| 네트워크 | 80 포트(TLS 를 이 서버에서 직접 종단하는 경우 443 포함) 미사용 상태 | 인증서 자동 발급에는 접속 주소(도메인)가 이 서버를 가리켜야 한다 |

설치 관리자는 시작 시 위 조건을 검사한다(사전 점검). 메모리 기준은 구역 표의 권장값이다: 최소 프리셋 4 GB, 협업 프리셋 7 GB, 전체 프리셋 9.5 GB. 검수에서는 전체 프리셋에 SSO·LDAP 애드온을 추가한 구성을 메모리 12 GB 서버에서 기동하였다.

## 설치 및 구성 절차 (Installation & Configuration)

서버 터미널에서 설치 관리자를 기동한다.

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

로그에 출력된 주소(`https://<서버 주소>:8443/?token=…`)를 브라우저로 열면 설치 마법사가 시작된다. 설치 관리자의 인증서는 자체 서명 인증서이므로 브라우저에 경고가 표시된다 — 로그의 SHA-256 지문과 대조한 후 진행한다.

- `-v` 의 호스트 폴더와 `JW_HOST_DIR` 은 **동일한 경로**여야 한다. 이 폴더가 설치 폴더이다.
- `JW_INSTALLER_VERSION` 에는 이미지 태그와 동일한 버전을 지정한다 — 설치 관리자가 설치할 제품 버전이다.
- 위 이미지는 첫 릴리스와 함께 공개된다. 그 전까지는 소스에서 빌드한다 — [docs/install.md](docs/install.md#소스에서-빌드해-설치).
- 무인 설치에는 응답 파일을 사용한다: `docker exec jw-installer jw apply --answers /data/answers.json`.
- 설치 관리자를 사용하지 않고 `docker compose` 로 직접 기동하는 방법도 지원한다 — [docs/deployment.md](docs/deployment.md).

사전 준비 사항(도메인, 포트, 인증서, 저장소)과 화면별 설명은 [docs/install.md](docs/install.md) 에 기술한다.

## 운영 및 유지 관리 (Operation & Maintenance)

운영 작업은 모두 관리 화면에서 수행한다. 상세 내용은 [docs/operate.md](docs/operate.md) 에 기술한다.

- **구역 활성화·비활성화** — 관리 › 구역.
- **업데이트** — 관리 › 업데이트. 수동(기본값) 또는 자동이며, 채널은 안정판(Stable)·시험판(Beta)이다. 업데이트 직전에 백업이 자동 생성되며, 실패 시 롤백한다. 인터넷에 연결되지 않은 서버는 오프라인 번들(화면 표기: 묶음 파일)로 업데이트한다.
- **백업** — 관리 › 저장소·백업. 단일 백업 파일(`.jwbak`)로 신규 서버에 그대로 이전할 수 있다(설치 마법사의 "백업에서 복원").
- **인증서** — 관리 › 보안·SSL 의 인증서 카드에서 재발급하거나 보유한 인증서로 교체한다.

## 문서 (Documentation)

| 대상 | 문서 | 내용 |
|---|---|---|
| 설치 담당자 | [docs/install.md](docs/install.md) | 사전 준비 사항, 설치 마법사 단계, 빠른 설치, 무인 설치, 문제 해결 |
| | [docs/deployment.md](docs/deployment.md) | 설치 관리자를 사용하지 않는 수동 설치 |
| 운영자 | [docs/operate.md](docs/operate.md) | 구역, 업데이트, 백업·복원·서버 이전, 저장소, 인증서, 메일 레코드, 로그 |
| | [docs/update-system.md](docs/update-system.md) | 업데이트의 동작과 실패 시 처리 |
| | [docs/data-safety.md](docs/data-safety.md) | 스키마 버전, 백업 형식, 복원 |
| | [docs/CONFIG.md](docs/CONFIG.md) | 환경변수 |
| | [SECURITY.md](SECURITY.md) | 보안 모델, 취약점 신고 |
| 구조 검토자 | [docs/architecture.md](docs/architecture.md) | 구성 요소와 구조 |
| | [docs/installer.md](docs/installer.md) | 설치 관리자의 구조·API·검증 범위 |
| | [docs/update-api.md](docs/update-api.md) · [docs/releases.md](docs/releases.md) | 업데이트 내부 API · 릴리스와 채널, 이미지 빌드 |
| 기능별 | [docs/CONNECTOR.md](docs/CONNECTOR.md) | MCP 커넥터 |
| | [docs/chat-permissions.md](docs/chat-permissions.md) | 채팅 역할·권한 |
| | [docs/rbi.md](docs/rbi.md) | 격리 브라우저 |
| | [docs/voice-lossless.md](docs/voice-lossless.md) | 무손실 오디오 |
| | [apps/README.md](apps/README.md) · [apps/desktop/README.md](apps/desktop/README.md) | 모바일 · 데스크톱 앱 |
| 개발자 | [CONTRIBUTING.md](CONTRIBUTING.md) | 개발 환경, 테스트, 커밋·PR |
| | [docs/extensions.md](docs/extensions.md) · [docs/plugin-frontend.md](docs/plugin-frontend.md) · [frontend-react/docs/plugin-v2.md](frontend-react/docs/plugin-v2.md) | 플러그인 |
| 공통 | [docs/glossary.md](docs/glossary.md) | 용어 |
| | [CHANGELOG.md](CHANGELOG.md) | 변경 기록 |
| | [docs/licensing.md](docs/licensing.md) · [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) | 라이선스 |

## 프로젝트 상태 (Project Status)

첫 공개 릴리스(1.0.0)를 준비 중이며, 현재는 Beta 단계이다. 변경 사항은 [CHANGELOG.md](CHANGELOG.md) 에 기록한다.

**검수 전용 서버에서 전 과정을 검증한 항목** ([docs/installer.md](docs/installer.md) 13절):

- 응답 파일 및 설치 마법사를 통한 설치 — 최소·협업·전체 프리셋, SSO·LDAP 애드온, NFS 저장소, 프런트 프록시 하단 구성.
- 설치 후 구역 활성화·비활성화, 설치 실패 후 해당 단계부터의 재시도, 재설치, 전체 백업의 동일 서버 복원(`jw restore`).
- 사설 CA 발급 인증서: CA 인증서를 함께 업로드하거나 이후 CA 인증서만 업로드하는 경우 코드 저장소의 로그인 연동이 성립함.
- 격리 브라우저: 미러 방식과 픽셀 방식 모두에서 세션 화면에 대상 페이지가 렌더링됨. 회의의 노이즈 제거 토글이 마이크 트랙의 잡음 억제 설정을 실제로 변경함(Chromium).
- 업데이트 — 수동·자동·중간 버전 경유·실패 시 롤백·복원 지점 복원·Beta 채널·오프라인 번들. 릴리스 도구로 생성한 릴리스를 서버 내부의 시험용 채널로 제공하여 검증하였다.
- 설치 관리자를 사용하지 않고 직접 기동하는 최소 구성.

**미검증 항목:**

- 실제 배포 채널과 서명 키를 사용한 업데이트. 이미지 빌드 워크플로는 첫 Beta 태그에서 1회 실행되었으나, 이후 변경된 backend 이미지의 빌드 대상은 해당 워크플로에서 아직 실행되지 않았다([docs/releases.md](docs/releases.md)의 "알려진 한계").
- Let's Encrypt 의 실제 발급 및 갱신(발급 실패 → 임시 인증서로 계속 진행하는 흐름만 검증).
- 공개 CA 인증서 환경의 코드 저장소 로그인 연동, 사설 CA·임시 인증서 환경의 문서 편집기.
- 격리 브라우저의 입력(키보드·한글·클립보드)·다운로드·업로드 및 실제 LAN 대상, 노이즈 제거의 실제 음질과 Chromium 이외의 브라우저, 무손실 오디오, 외부 SMTP·AI 제공자 연결, 지정 폴더 저장소.
- 공유기(NAT) 하단 구성과 실제 프런트 프록시, SELinux 가 활성화된 배포판, x86_64 이외의 서버.

## 사용 및 배포에 관한 규정 (License & Distribution)

본 소프트웨어는 **GNU Affero General Public License 버전 3 또는 그 이후 버전**(`AGPL-3.0-or-later`)에 의거하여 배포된다. 라이선스 전문은 [LICENSE](LICENSE), 저작권 고지는 [NOTICE](NOTICE) 에 수록한다.

```
Copyright (C) 2026 Just-Workspace

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License as published by the Free Software Foundation, version 3 of the
License, or (at your option) any later version. This program is distributed WITHOUT ANY WARRANTY.
```

- **수정 없이 운영**하는 경우 추가 의무는 발생하지 않는다.
- **수정본을 타인에게 네트워크 서비스로 제공**하는 경우, 해당 이용자가 수정본의 소스 코드를 받을 수 있도록 하여야 한다. 제품의 "소스 코드" 링크가 이를 위한 수단이며, 주소는 `JW_SOURCE_URL` 로 변경한다.
- **플러그인에 대한 예외 조항은 없다.** 본 소프트웨어의 코드를 호출하는 플러그인을 배포하는 경우 AGPL 과 호환되는 조건이어야 한다는 것이 일반적인 해석이다.

본 소프트웨어와 함께 사용되는 제3자 소프트웨어에는 각각의 라이선스가 적용된다.

- **자체 빌드 이미지에 포함되는 구성 요소** — backend 이미지의 IMAP 클라이언트 `aioimaplib`(GPL-3.0)과 pandoc(GPL), 문서 변환 이미지의 LibreOffice 와 HWP 확장 H2Orestart(GPL-3.0), 메일 서버 이미지(docker-mailserver 의 파생 이미지 — GPL 프로그램 포함) 등. 이미지의 게시는 그 자체로 배포에 해당하므로 해당 라이선스의 의무가 적용된다.
- **원 배포처에서 직접 pull 하는 구성 요소(외부 이미지)** — OnlyOffice Document Server·SearXNG(AGPL-3.0), Redis 8(RSALv2 / SSPLv1 / AGPL-3.0 중 택일) 등. 이들은 자체 빌드 이미지에 포함하지 않는다.

이미지별 포함 구성 요소와 그에 따른 의무는 [docs/licensing.md](docs/licensing.md), 전체 목록은 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) 에 기술한다.

## 책임의 한계 (Limitation of Liability)

본 소프트웨어는 관련 법령이 허용하는 범위 내에서 명시적이거나 묵시적인 어떠한 형태의 보증도 없이 '있는 그대로(AS IS)' 제공된다(AGPL-3.0 제15조). 저작권자 및 본 소프트웨어를 수정·배포하는 자는 본 소프트웨어의 사용 또는 사용 불능으로 인하여 발생하는 손해에 대하여, 관련 법령이 요구하거나 서면으로 합의한 경우를 제외하고 책임을 지지 않는다(AGPL-3.0 제16조). 정확한 조건은 [LICENSE](LICENSE) 전문에 따른다.

## 기여 규정 (Contributing)

버그 신고, 기능 제안 및 코드 기여의 절차는 [CONTRIBUTING.md](CONTRIBUTING.md) 에 규정한다. 코드를 기여하는 자는 [기여 조건](CONTRIBUTING.md#기여-조건)(동일 라이선스로 제공, 프로젝트 저작권자에게 다른 조건으로도 배포할 수 있는 권한 부여)에 동의하여야 한다.

## 보안 취약점 신고 절차 (Security Reporting)

보안 취약점은 공개 이슈로 등록하지 아니하며, GitHub 의 비공개 취약점 신고 기능으로 접수한다. 절차는 [SECURITY.md](SECURITY.md) 에 규정한다.
