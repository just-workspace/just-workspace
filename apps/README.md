# Just Workspace — 앱 (데스크톱 · 모바일)

본 문서는 Just Workspace 의 데스크톱·모바일 앱을 기술한다. 앱은 별도의 화면을 구현하지 않고 **워크스페이스 서버의 웹 화면(`frontend-react`)을 그대로 표시**하며,
알림·트레이·화면 공유 등 OS 기능을 부가한 경량 네이티브 셸이다. 따라서 웹 화면의 변경은 앱 화면에 그대로 반영된다.

| 앱 | 스택 | 위치 | 비고 |
|----|------|------|------|
| 데스크톱 | **Electron 45** + electron-builder 26 | `apps/desktop` | 트레이·OS 알림·화면 공유 피커·OS 자격 증명 저장소. 상세는 [desktop/README.md](desktop/README.md) |
| 모바일(Android/iOS) | **Capacitor 8** | `apps/mobile` | Android 는 서버에서 APK 를 빌드해 다운로드로 제공한다. iOS 는 소스만 제공한다(macOS 에서 직접 빌드) |
| (웹 자체) | **PWA** | `frontend-react` (vite-plugin-pwa) | "홈에 추가"로 즉시 설치 가능 |

## 연결 모델

공용 앱(스토어에서 설치한 뒤 서버 주소를 입력하는 형태)은 제공하지 않는다. 앱은 **워크스페이스별로 접속 주소를 지정해 빌드**하며 해당 서버에서 다운로드로 제공한다 —
주소가 앱에 내장되므로 사용자는 서버 주소를 입력하지 않는다.

- **데스크톱**: 워크스페이스 주소를 지정해 빌드한 설치 파일을 서버 저장소에 업로드하면 `/api/apps/desktop` 으로 제공된다 → [desktop/README.md](desktop/README.md)
- **모바일(Android)**: 관리 › 앱 빌드의 "브랜드 APK 빌드"로 서버에서 빌드한다 → `/api/apps/android`.
  - 사전 준비(1회): 서버에서 빌더 이미지를 생성한다 — `docker build -f apps/mobile/builder.Dockerfile -t jw-android-builder apps/mobile`.
    또한 `.env` 의 `JW_HOST_REPO` 에 서버의 리포 경로를 지정한다(미지정 시 빌드 버튼이 동작하지 않는다).
  - 앱의 접속 주소와 앱 이름은 관리 › 앱 빌드 화면에서 지정한다(기본값: `APP_URL`, "Just Workspace").
  - 앱 ID 는 주소의 호스트를 역순으로 배열하고 `.workspace` 를 덧붙인 값이다(`ws.example.com` → `com.example.ws.workspace`). 변경은 `.env` 의 `ANDROID_APP_ID` 로 한다.
    **배포 이후에는 변경하지 않는다** — 변경하면 별개의 앱으로 취급된다.
  - 서명 키는 최초 빌드 시 도커 볼륨 `jw-android-signing` 에 생성되어 이후 계속 사용된다. **이 키를 분실하면 기설치된 앱을 업데이트할 수 없다.**
    워크스페이스의 내장 백업(관리 › 저장소·백업)은 이 볼륨을 포함한다.
- **다운로드 안내 페이지**: `/api/apps`(Android QR + 데스크톱 설치 파일 링크). 대시보드의 "데스크톱·모바일 앱 설치" 항목이 이 페이지로 연결된다.

### 앱의 표시 화면

기본은 **원격 모드**이다 — 앱이 서버의 웹 화면을 그대로 표시한다. 서버를 업데이트하면 앱을 재빌드하지 않아도 화면이 변경된다.

- **번들 모드(선택, Android 한정)**: 빌더를 직접 실행하면서 `JW_WEB_BUNDLE=1` 을 지정하면 `apps/mobile/scripts/bundle-web.cjs` 가 `frontend-react` 를
  `VITE_API_BASE=<워크스페이스 주소>` 로 빌드해 앱에 내장한다(`www-react/`, 서비스워커 없음). 앱 출처는 `https://localhost` 이며 API·WebSocket 요청만 서버로 전송된다(Bearer 인증).
  관리 화면의 빌드는 원격 모드만 생성한다. 번들 모드는 웹이 변경될 때마다 앱의 재빌드가 필요하며, 위키 동시 편집 등 쿠키에 의존하는 기능은 동작하지 않는다.

### 모바일 회의 (Android)

웹뷰의 LiveKit 은 변경하지 않고, 회의를 OS 에 통화로 등록한다(`MeetingPlugin.java`, 웹은 `useNativeMeeting.ts`).
- 포그라운드 서비스: 화면이 꺼지거나 앱이 백그라운드로 전환되어도 회의를 유지한다(마이크·카메라 타입, wake/wifi lock)
- Telecom self-managed 통화(Android 8+): 일반 전화 수신 시 hold → 마이크 송출 정지, 종료 시 unhold → 복구.
  블루투스 헤드셋 통화 종료·알림 "나가기" → 회의 퇴장
- 기기·제조사에 따라 동작이 상이할 수 있는 항목: 통화 수신 시 보류/복귀, 화면이 꺼진 상태의 장시간 유지, 블루투스 버튼. 배포 전에 대상 기기에서 검증한다

---

## 빌드

### 모바일 동기화(웹 변경 반영)
```bash
cd apps/mobile
npm install            # 처음 한 번
npx cap sync           # www + 네이티브 플러그인 동기화
```

### Android APK
서버 빌드: 관리 › 앱 빌드의 "브랜드 APK 빌드"(빌더 이미지 `apps/mobile/builder.Dockerfile` — JDK 21 + Node 24 + Android SDK 36. 호스트에는 docker 만 필요하다. 사전 준비는 위 "연결 모델" 참조).

수동 빌드: JDK 21 + Android SDK(`platforms;android-36`, `build-tools;36.0.0`).
```bash
cd apps/mobile/android
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk (사이드로드 가능)
./gradlew assembleRelease        # 배포용(서명 필요)
```
> Android 는 스토어를 거치지 않는 **APK 직접 배포(사이드로드)**가 가능하다. release 빌드에는 keystore 서명이 필요하다.

### iOS
요구 사항: **macOS + Xcode + Apple 개발자 계정**(서명 없이는 실기기 설치 불가).
```bash
cd apps/mobile && npx cap open ios   # Xcode에서 서명/실행/Archive
```
> Windows/Linux 에서는 빌드할 수 없다(소스만 보관). iOS 는 PWA(홈에 추가)로 대체할 수 있다.

### 데스크톱 (Electron)
```bash
cd apps/desktop && npm install && JW_SERVER_URL=https://workspace.example.com npm run dist
```
→ [desktop/README.md](desktop/README.md)

### PWA (별도 빌드 없음)
별도의 빌드 절차가 없다. 브라우저(Chrome/Edge/모바일)에서 워크스페이스에 접속해 **"앱 설치 / 홈 화면에 추가"** 를 선택하면 설치형 앱으로 등록된다. 웹 푸시 키(VAPID)는 backend 가 최초 사용 시 생성해 보관한다.

---

## 알림

- 데스크톱 앱: 서버와의 실시간 연결로 수신해 OS 알림으로 표시한다.
- 웹·PWA: 웹 푸시.
- 모바일 앱: **네이티브 푸시(FCM·APNs)는 연동되어 있지 않다.** `@capacitor/push-notifications` 패키지는 포함되어 있으나 서버 측 기기 토큰 등록과 발송 기능이 없다 —
  앱이 종료된 상태에서는 알림이 수신되지 않는다.
