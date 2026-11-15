# Just Workspace — 앱 (데스크탑 · 모바일)

Just Workspace 의 데스크톱·모바일 앱이다. 화면을 따로 만들지 않고 **워크스페이스 서버의 웹 화면(`frontend-react`)을 그대로 열고**,
그 둘레에 알림·트레이·화면 공유 같은 OS 기능을 붙인 얇은 네이티브 셸이다. 그래서 웹이 바뀌면 앱 화면도 함께 바뀐다.

| 앱 | 스택 | 위치 | 비고 |
|----|------|------|------|
| 데스크탑 | **Electron 45** + electron-builder 26 | `apps/desktop` | 트레이·OS 알림·화면 공유 피커·OS 자격 증명 저장소. 자세한 것은 [desktop/README.md](desktop/README.md) |
| 모바일(Android/iOS) | **Capacitor 8** | `apps/mobile` | Android 는 서버에서 APK 를 빌드해 내려받게 한다. iOS 는 소스만 있다(맥에서 직접 빌드) |
| (웹 자체) | **PWA** | `frontend-react` (vite-plugin-pwa) | "홈에 추가"로 즉시 설치형 |

## 연결 모델

공용 앱(스토어에서 받아 서버 주소를 입력하는 앱)은 없다. 앱은 **워크스페이스마다 자기 주소를 넣어 빌드**하고 자기 서버에서 내려받게 한다 —
주소가 앱 안에 구워지므로 사용자는 서버 주소를 입력하지 않는다.

- **데스크톱**: 워크스페이스 주소를 넣어 빌드한 설치 파일을 서버 저장소에 올리면 `/api/apps/desktop` 으로 내려간다 → [desktop/README.md](desktop/README.md)
- **모바일(Android)**: 관리 › 앱 빌드의 "브랜드 APK 빌드"로 서버에서 빌드한다 → `/api/apps/android`.
  - 준비(한 번): 서버에서 빌더 이미지를 만든다 — `docker build -f apps/mobile/builder.Dockerfile -t jw-android-builder apps/mobile`.
    그리고 `.env` 의 `JW_HOST_REPO` 에 서버의 리포 경로를 적는다(비어 있으면 빌드 버튼이 동작하지 않는다).
  - 앱이 붙을 주소와 앱 이름은 관리 › 앱 빌드 화면에서 정한다(기본: `APP_URL`, "Just Workspace").
  - 앱 ID 는 주소의 호스트를 뒤집고 `.workspace` 를 붙인 값이다(`ws.example.com` → `com.example.ws.workspace`). 바꾸려면 `.env` 의 `ANDROID_APP_ID`.
    **한 번 배포한 뒤에는 바꾸지 않는다** — 바꾸면 다른 앱이 된다.
  - 서명 키는 첫 빌드 때 도커 볼륨 `jw-android-signing` 에 만들어지고 계속 쓰인다. **이 키를 잃으면 이미 설치된 앱을 갱신할 수 없다.**
    워크스페이스의 내장 백업(관리 › 저장소·백업)이 이 볼륨을 함께 담는다.
- **내려받기 안내 페이지**: `/api/apps`(안드로이드 QR + 데스크톱 설치 파일 링크). 대시보드의 "데스크톱·모바일 앱 설치" 항목이 여기로 간다.

### 앱이 여는 화면

기본은 **원격 모드** — 앱이 서버의 웹 화면을 그대로 연다. 서버를 업데이트하면 앱을 다시 빌드하지 않아도 화면이 바뀐다.

- **번들 모드(선택, 안드로이드만)**: 빌더를 직접 실행하면서 `JW_WEB_BUNDLE=1` 을 주면 `apps/mobile/scripts/bundle-web.cjs` 가 `frontend-react` 를
  `VITE_API_BASE=<워크스페이스 주소>` 로 빌드해 앱 안에 넣는다(`www-react/`, 서비스워커 없음). 앱 출처는 `https://localhost` 이고 API·WebSocket 만 서버로 간다(Bearer 인증).
  관리 화면의 빌드는 원격 모드만 만든다. 번들 모드는 웹이 바뀔 때마다 앱을 다시 빌드해야 하고, 위키 동시 편집처럼 쿠키에 기대는 기능은 동작하지 않는다.
- 빌드 값 `JW_WEB`(`react`·`vue`, 기본 `react`)은 지금 효과가 없다 — 서버가 React 화면 하나만 내보낸다.

### 모바일 회의 (Android)

웹뷰의 LiveKit 은 그대로 두고, 회의를 OS 에 통화로 알린다(`MeetingPlugin.java`, 웹은 `useNativeMeeting.ts`).
- 포그라운드 서비스: 화면이 꺼지거나 앱을 내려도 회의 유지(마이크·카메라 타입, wake/wifi lock)
- Telecom self-managed 통화(Android 8+): 일반 전화가 오면 hold → 마이크 송출 정지, 끝나면 unhold → 복구.
  블루투스 헤드셋 통화 종료·알림 "나가기" → 회의 퇴장
- 기기·제조사마다 동작이 다를 수 있는 부분: 통화 수신 시 보류/복귀, 화면이 꺼진 채 오래 유지, 블루투스 버튼. 배포 전에 쓰는 기기에서 확인한다

---

## 빌드

### 모바일 동기화(웹 변경 반영)
```bash
cd apps/mobile
npm install            # 처음 한 번
npx cap sync           # www + 네이티브 플러그인 동기화
```

### Android APK
서버에서: 관리 › 앱 빌드의 "브랜드 APK 빌드"(빌더 이미지 `apps/mobile/builder.Dockerfile` — JDK 21 + Node 24 + Android SDK 36. 호스트에는 docker 만 있으면 된다. 준비는 위 "연결 모델").

손으로: JDK 21 + Android SDK(`platforms;android-36`, `build-tools;36.0.0`).
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
cd apps/desktop && npm install && JW_SERVER_URL=https://workspace.example.com npm run dist
```
→ [desktop/README.md](desktop/README.md)

### PWA (별도 빌드 없음)
따로 할 일이 없다. 브라우저(Chrome/Edge/모바일)에서 워크스페이스를 열고 **"앱 설치 / 홈 화면에 추가"** 를 누르면 설치형 앱이 된다. 웹 푸시 키(VAPID)는 backend 가 처음 쓸 때 만들어 보관한다.

---

## 알림

- 데스크톱 앱: 서버와의 실시간 연결로 받아 OS 알림으로 띄운다.
- 웹·PWA: 웹 푸시.
- 모바일 앱: **네이티브 푸시(FCM·APNs)는 연동돼 있지 않다.** `@capacitor/push-notifications` 패키지는 들어 있지만 서버 쪽 기기 토큰 등록과 발송이 없다 —
  앱이 꺼져 있을 때는 알림이 오지 않는다.
