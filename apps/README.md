# Just Workspace — 앱 (데스크탑 · 모바일)

디스코드/슬랙과 같은 "웹 감싸기" 방식. **서버의 웹(`frontend-react`)을 그대로 재사용**하고
네이티브 셸만 추가 — 별도 코드베이스 없음.

| 앱 | 스택 | 위치 | 비고 |
|----|------|------|------|
| 데스크탑 | **Electron 45** + electron-builder 26 | `apps/desktop` | 트레이·OS 알림·화면 공유 피커·OS 자격 증명 저장소. 자세한 것은 [desktop/README.md](desktop/README.md) |
| 모바일(Android/iOS) | **Capacitor 8** | `apps/mobile` | Android 는 서버에서 APK 빌드·게시, iOS 는 소스만 |
| (웹 자체) | **PWA** | `frontend-react` (vite-plugin-pwa) | "홈에 추가"로 즉시 설치형 |

## 연결 모델

앱은 **사이트 빌드형**이다 — 각 워크스페이스가 자기 주소로 빌드해 자기 서버에서 배포한다. 앱은 서버 웹을 원격으로 연다(번들 SPA 가 아니다).

- 데스크톱: 사이트 주소로 빌드해 게시 → `/api/apps/desktop` ([desktop/README.md](desktop/README.md))
- 모바일: 관리 › 앱 빌드 화면 "APK 빌드" → `/api/apps/android`.
  `apps/mobile/builder-build.sh` 가 주소·앱 ID(도메인 역순 + `.workspace`)·앱 이름을 굽고,
  사이트 서명 키(docker 볼륨 `jw-android-signing`, 첫 빌드 때 생성)로 release 서명한다.
  **서명 키를 잃으면 설치된 앱을 갱신할 수 없다** — `scripts/backup.sh` 가 함께 백업한다.
  `.env` 로 덮기: `ANDROID_SERVER_URL`, `ANDROID_APP_ID`, `ANDROID_APP_NAME`. 관리 화면 빌드는 `JW_HOST_REPO`(호스트 리포 경로)가 필요하다.
- 다운로드 랜딩: 대시보드 "다운로드" → `/api/apps`.

### 웹 UI — React

React 전환 뒤 서버 nginx 는 쿠키와 상관없이 전부 `frontend-react` 를 서빙한다. 앱의 빌드 값 **`JW_WEB`(기본 `react`)** 는
병행 기간 스위치의 잔재로 남아 있다 — 앱이 첫 로드 전에 `jw_ui` 쿠키를 심지만(데스크톱 `src/main/webUi.ts`, 안드로이드 `WebUiPlugin.java`),
지금 nginx 는 `/__ui/*` 요청에서 그 쿠키를 지우고 `/` 로 보낸다. Vue 프런트는 더 이상 없어서 `JW_WEB=vue` 로 빌드해도 React 가 열린다.

- **번들 모드(선택, 안드로이드만)**: `ANDROID_WEB_BUNDLE=1` 이면 `scripts/bundle-web.cjs` 가 `frontend-react` 를
  `VITE_API_BASE=<사이트 주소>` 로 빌드해 앱 안에 넣는다(`www-react/`, 서비스워커 없음). 앱 출처는 `https://localhost`, API·WS 만 서버로(Bearer).
  빌더를 직접 실행할 때만 지원(관리자 화면 빌드는 원격 모드). 웹 변경마다 앱을 다시 빌드해야 하고, 위키 동시편집처럼 쿠키에 기대는 곳은 아직 안 된다.

### 모바일 회의 (Android)

웹뷰의 LiveKit 은 그대로 두고, 회의를 OS 에 통화로 알린다(`MeetingPlugin.java`, 웹은 `useNativeMeeting.ts`).
- 포그라운드 서비스: 화면이 꺼지거나 앱을 내려도 회의 유지(마이크·카메라 타입, wake/wifi lock)
- Telecom self-managed 통화(Android 8+): 일반 전화가 오면 hold → 마이크 송출 정지, 끝나면 unhold → 복구.
  블루투스 헤드셋 통화 종료·알림 "나가기" → 회의 퇴장
- 실기기 검증 필요 항목: 통화 수신 보류/복귀, 화면 꺼짐 30분 유지, 블루투스 버튼

---

## 빌드

### 모바일 동기화(웹 변경 반영)
```bash
cd apps/mobile
npm install            # 최초 1회 (Node 22+)
npx cap sync           # www + 네이티브 플러그인 동기화
```

### Android APK
서버에서: 관리 › 앱 빌드 화면 "APK 빌드"(컨테이너 `apps/mobile/builder.Dockerfile`, eclipse-temurin 21 + Android SDK — 호스트에는 docker 만 있으면 된다).

손으로: JDK 21 + Android SDK(platforms;android-35, build-tools;35).
```bash
cd apps/mobile/android
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk (사이드로드 가능)
./gradlew assembleRelease        # 배포용(서명 필요)
```
> Android는 스토어 없이 **APK 직접 배포(사이드로드)** 가능. release는 keystore 서명 필요.

### iOS
필요: **macOS + Xcode + Apple 개발자 계정**(서명 없이는 실기기 설치 불가).
```bash
cd apps/mobile && npx cap open ios   # Xcode에서 서명/실행/Archive
```
> Windows/Linux에서는 빌드 불가(소스만 보관). iOS는 PWA(홈에 추가)로 갈음 가능.

### 데스크탑 (Electron)
```bash
cd apps/desktop && npm install && npm run dist   # JW_SERVER_URL 필수
```
→ [desktop/README.md](desktop/README.md)

### PWA (별도 빌드 없음)
웹을 배포하면 끝. 브라우저(Chrome/Edge/모바일)에서 **"앱 설치 / 홈 화면에 추가"** 로 설치형 앱. 웹 푸시(VAPID)는 backend 가 키를 만들어 준다.

---

## 네이티브 푸시(다음 단계)
Capacitor `@capacitor/push-notifications` 설치됨. 실제 동작엔 Android=FCM, iOS=APNs
키 설정 + 백엔드에 디바이스 토큰 등록 엔드포인트가 필요(웹푸시와 별개). 아직 연동하지 않았다.
