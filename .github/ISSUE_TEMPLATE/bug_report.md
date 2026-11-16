---
name: 버그 신고 (Bug report)
about: 오동작 또는 기대와 상이한 동작의 신고
title: ''
labels: bug
assignees: ''
---

<!--
보안 취약점은 본 양식으로 등록하지 아니하며, SECURITY.md 에 규정한 절차(비공개 취약점 신고)로 접수한다.
Security vulnerabilities are not to be reported here — see SECURITY.md. Reports may be submitted in English.
-->

## 현상

<!-- 관찰된 동작과 기대한 동작을 기재한다. -->

## 재현 절차

1.
2.
3.

## 환경

- **버전**: <!-- 관리 › 업데이트 또는 https://<접속 주소>/api/health 의 version. 소스에서 빌드한 경우 커밋 -->
- **설치 방식**: <!-- 설치 마법사 / 응답 파일(무인 설치) / 수동 설치(docker compose) -->
- **활성화된 구역 및 애드온**: <!-- 관리 › 구역. 예: 메일, 채팅, 문서 편집 -->
- **네트워크 구성 및 인증서**: <!-- 직접 연결 / 공유기(NAT) 하단 / 프록시 하단 · 자동 발급 / 업로드한 인증서 / 임시 인증서 -->
- **파일 저장 위치**: <!-- 이 서버의 디스크 / NFS -->
- **서버**: <!-- 배포판 및 버전, Docker Engine 버전(docker version), 메모리 -->
- **브라우저·앱**: <!-- 화면 관련 문제인 경우. 예: Chrome 142, 데스크톱 앱 -->

## 로그

<!--
관련 컨테이너 로그의 마지막 부분을 첨부한다. 주소·계정 이름·토큰 등의 포함 여부를 확인한 후 등록한다.

  docker ps --format '{{.Names}}\t{{.Status}}'
  docker logs --tail 200 ws-backend
  docker logs --tail 200 jw-installer        # 설치·구역·업데이트 문제

- 오류 화면에 "요청 번호"가 표시된 경우 해당 값을 함께 기재한다.
- 설치 단계가 실패한 경우 화면의 "기록 내려받기" 또는 <설치 폴더>/state/logs/<단계>.log
- 업데이트 문제는 관리 › 업데이트 › 기록에서 내려받은 기록

상세 내용: docs/operate.md 의 "로그"
-->

```
(로그)
```

## 추가 정보

<!-- 화면 캡처, 최근 변경 사항(구역 활성화, 업데이트, 서버 이전) 등 -->
