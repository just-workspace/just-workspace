---
name: 버그 신고 (Bug report)
about: 동작이 잘못됐거나 기대와 다를 때
title: ''
labels: bug
assignees: ''
---

<!--
보안 취약점은 여기에 올리지 말고 SECURITY.md 의 방법(비공개 취약점 신고)으로 알려 주세요.
Do not report security vulnerabilities here — see SECURITY.md. English is welcome.
-->

## 무슨 일이 일어났나

<!-- 본 것과 기대한 것을 적어 주세요. -->

## 재현 순서

1.
2.
3.

## 환경

- **버전**: <!-- 관리 › 업데이트 또는 https://<접속 주소>/api/health 의 version. 소스로 빌드했다면 커밋 -->
- **설치 방식**: <!-- 설치 마법사 / 답변 파일(무인) / 직접 설치(docker compose) -->
- **켜져 있는 구역과 애드온**: <!-- 관리 › 구역. 예: 메일, 채팅, 문서 편집 -->
- **연결 형태와 인증서**: <!-- 직접 연결 / 공유기 뒤 / 프록시 뒤 · 자동 발급 / 올린 인증서 / 임시 인증서 -->
- **파일 저장 위치**: <!-- 이 서버의 디스크 / NFS -->
- **서버**: <!-- 배포판과 버전, Docker Engine 버전(docker version), 메모리 -->
- **브라우저·앱**: <!-- 화면 문제일 때. 예: Chrome 142, 데스크톱 앱 -->

## 로그

<!--
관련 컨테이너의 로그 끝부분을 붙여 주세요. 주소·계정 이름·토큰 같은 것이 섞여 있지 않은지 확인하고 올립니다.

  docker ps --format '{{.Names}}\t{{.Status}}'
  docker logs --tail 200 ws-backend
  docker logs --tail 200 jw-installer        # 설치·구역·업데이트 문제

- 오류 화면에 "요청 번호"가 나왔다면 그 값도 적어 주세요.
- 설치 단계가 실패했다면 화면의 "기록 내려받기" 또는 <설치 폴더>/state/logs/<단계>.log
- 업데이트 문제는 관리 › 업데이트 › 기록에서 내려받은 기록

자세한 것: docs/operate.md 의 "로그"
-->

```
(로그)
```

## 더 알려 줄 것

<!-- 화면 갈무리, 최근에 바꾼 것(구역을 켰다, 업데이트했다, 서버를 옮겼다) 등 -->
