# Just Workspace 데스크톱 앱

Just Workspace 의 데스크톱 앱(Windows·macOS)이다. Electron 창 내부에 워크스페이스 서버의 웹 화면(`frontend-react`)을 그대로 표시한다.
**앱이 직접 렌더링하는 영역은 창 테두리 한 줄(이동·뒤로/앞으로/새로 고침·창 버튼)에 한정되며**, 사이드바·상단바·알림 패널·사용자 메뉴를 포함한
나머지 영역은 전부 웹이 브라우저와 동일하게 렌더링한다. 앱 전체 구성과 모바일 앱은 [../README.md](../README.md) 를 참조한다.

앱은 **단일 워크스페이스에 종속되어 빌드된다**(주소가 앱에 내장된다 — 아래 "개발"). 0.5.0 미만 버전의 앱은 사이드바를 자체 렌더링하였으므로,
웹은 해당 버전의 앱에서 열리는 경우 자체 사이드바를 숨긴다(`frontend-react/src/composables/useDesktopShell.ts` 의 `SHELL_WEB_CHROME_SINCE`).

데스크톱 앱 고유의 기능은 OS 기능에 한정된다: 트레이·알림 토스트(인라인 답장)·폴더 동기화·화면 공유 피커·회의 전용 창·하이레조 오디오·
원격 데스크톱 호스트·자동 시작·컨텍스트 메뉴(`src/main/contextMenu.ts`).

- 앱 → 웹 화면 이동(트레이 "회의"·알림 클릭)은 `window.jwShell.onNavigate`(`src/preload/webview.ts` ↔ `frontend-react/src/lib/desktopBridge.ts`)를 통해
  SPA 라우터에 전달한다. 페이지를 다시 로드하면 음성채널·통화가 끊기기 때문이다. 웹이 구독하기 전인 경우에는 페이지 재로드로 대체한다.
- 웹 사용자 메뉴의 "로그아웃"이 성공하면(`POST /api/auth/logout`, 본문 웹뷰에서 발생한 요청에 한함) 앱도 로그아웃한다.
- 이 앱의 소켓이 연결되어 있으면 서버가 웹 푸시를 발송하지 않으므로, 모든 알림 종류(작업·일정·회의·파일·메일·게시판)를 토스트로 표시한다.
  서버의 방해 금지 설정(지금 켜기·일정)은 실시간 이벤트의 `quiet` 로 수신해 적용한다.

## Electron 채택 사유

이 앱에 실제로 필요한 기능은 화면 공유(`desktopCapturer`)·시스템 트레이·OS 자격 증명 저장소이며, 세 기능 모두
Electron 이 내장 제공한다. Tauri 등 경량 프레임워크에서는 플러그인·네이티브 코드를 별도로 추가해야 한다.
설치 파일의 크기는 증가하나 유지 비용이 현저히 낮다.

## 구조

```
src/main/        메인 프로세스 — 창·트레이·IPC·인증·폴더 동기화(sync/)·하이레조 오디오(nativeAudio/)·원격 데스크톱 호스트(remote/)
  auth/
    pkce.ts        RFC 7636 code_verifier/challenge
    loopback.ts    RFC 8252 §7.3 루프백 콜백 (포트 0)
    keychain.ts    safeStorage(DPAPI/Keychain/libsecret)
    broker.ts      단일 갱신 브로커 — 아래 설명
    index.ts       로그인 흐름 조립
  windows/
    login.ts       600×700 프레임리스
    shell.ts       1440×900 + 서버 웹 WebContentsView(창 테두리 32px 아래 전부)
    그 밖           회의 창·화면 공유 고르기·알림·트레이 메뉴·설정
src/preload/     contextBridge 로 노출하는 좁은 표면(index.ts = 앱 자체 창들, webview.ts = 서버 웹 화면: jwNativeAudio·jwShell 둘만, remote.ts = 원격 데스크톱 창)
src/renderer/    앱이 직접 그리는 화면 — 로그인·창 테두리·트레이 메뉴·알림·설정·원격 데스크톱 동의 창과 막대
src/runner/      원격 지원용 포터블 프로그램(plugins/remote-desktop)
native/          Node-API 애드온 — 하이레조 오디오, 원격 데스크톱 입력
```

## 인증

RFC 8252(네이티브 앱 OAuth)를 준수한다. 앱 내 웹뷰에 로그인 폼을 표시하지 않고
**시스템 브라우저**를 열어 루프백으로 인가 코드를 수신한다. 공개 클라이언트이므로
client_secret 이 없으며 PKCE S256 으로만 증명한다.

서버 측 전제 조건:

- OAuth 클라이언트 `desktop-app`(공개·신뢰 클라이언트)은 백엔드에 **기본 내장되어 있다**(`backend/app/auth/oauth_provider.py` 의 `BUILTIN_CLIENTS`) —
  워크스페이스별 등록은 불필요하다
- `redirect_uris` 는 `http://127.0.0.1/callback` 이다 — 포트는 무시하고 스킴·호스트·경로만
  대조한다(RFC 8252 §7.3)
- 일반 API(`/api/devices` 등)는 1st-party OAuth Bearer 를 허용한다
  (`backend/app/auth/deps.py:_user_from_first_party_oauth`). WebSocket 은 토큰을
  `Sec-WebSocket-Protocol: jw.bearer, jw.token.<base64url>` 로 전송한다(쿼리스트링 금지)

### 토큰 갱신의 단일화

서버는 리프레시 토큰에 회전 및 재사용 탐지를 적용한다. 앱 내에서 토큰을 사용하는 주체가
다수(웹 뷰·회의 창·동기화)이므로, 동시에 갱신을 시도하면 후행 요청이 이미 회전된 토큰을
전송하게 되고 서버는 이를 탈취로 판단해 **패밀리 전체를 폐기**한다. 증상은 간헐적인 원인 불명의
로그아웃이며 재현되지 않는다.

따라서 갱신은 `broker.ts` 만 수행한다. 진행 중인 갱신이 있으면 후행 호출자는
동일한 프로미스에 합류한다. 같은 이유로 **인스턴스도 하나만** 실행된다
(`app.requestSingleInstanceLock`).

## 개발

```bash
npm install
npm run build     # tsc + 렌더러 정적 파일 복사
npm start         # electron .
npm run dist      # electron-builder
```

앱은 단일 워크스페이스에 종속되며, **접속 대상 서버는 빌드 시점에 결정된다.**
`scripts/site.mjs` 가 환경변수를 `dist/site.json` 으로 기록하고, 런타임(`src/main/config.ts`)과
패키징(`electron-builder.config.cjs`)이 해당 파일을 읽는다.

| 변수 | 기본 | 용도 |
|---|---|---|
| `JW_SERVER_URL` | 개발 빌드 `http://localhost`, `npm run dist` 는 필수 | 워크스페이스 주소 |
| `JW_APP_ID` | 호스트를 역순으로 배열하고 `.just-workspace` 를 덧붙인 값 (`ws.example.com` → `com.example.ws.just-workspace`) | 설치·업데이트 식별자. **배포 이후 변경 금지** |
| `JW_PRODUCT_NAME` | `just-workspace` | 설치 폴더·바로가기 이름. 지정하면 사용자 데이터 폴더도 분리된다(동일 PC 에 두 사이트의 앱 설치) |

개발 중에는 실행 시 `JW_SERVER_URL` 을 지정해 빌드에 내장된 값을 재정의할 수 있다.

런타임·도구 버전 참고(Electron 45 / electron-builder 26 / TypeScript 7):
- `npm install` 은 Electron 바이너리를 다운로드하지 않는다(Electron 42 부터 postinstall 폐지). 최초로
  `electron .` 을 실행할 때 다운로드하며, `electron-builder` 는 자체 캐시로 별도 다운로드한다. 오프라인 빌드 머신에서는
  `npx install-electron` 을 먼저 실행한다.
- 지원 OS: Windows 64비트 한정(ia32 빌드 폐지), macOS 13 이상.
- `@types/node` 는 Electron 에 내장된 Node 메이저(45 → Node 24)에 맞춘다. 더 높은 버전을 지정하면 런타임에 존재하지 않는
  API 가 타입 검사만 통과한다.
- `tsconfig` 의 `module` 은 `node16`(CommonJS 출력)이다. TypeScript 7 에서 `moduleResolution: node` 가 제거되었다.
- `safeStorage` 는 비동기 API 만 사용한다(동기 API 는 Electron 46 에서 제거). 기존 설치의 암호문은 그대로 복호화된다.

## 하이레조 네이티브 오디오

음성채널 "하이레조" 단계 — **WASAPI exclusive** 로 장치를 독점하여 장치 네이티브 포맷(최대 32-bit/192 kHz)의 PCM 을 리샘플·변환 없이
무손실 릴레이(`audiorelay`, PROTOCOL v1)로 송수신한다. 브라우저 무손실 피어(PCM 24/48)와 동일한 방에서 상호 청취가 가능하다.

```
native/                        Node-API 애드온(C/C++) — npm run native:build
  src/addon.cpp                 Device(캡처·재생, 링버퍼, TSFN 알림, 테스트 신호) · Resampler(speex) · RingTest · listDevices/probeExclusive/sessions
  src/wasapi_probe.cpp          WASAPI 직접 호출: exclusive 포맷 매트릭스(IsFormatSupported), 장치를 쓰는 프로세스(세션 열거), 기본 형식·주기
  src/ring_buffer.h             SPSC 락프리 링버퍼(오디오 스레드 ↔ JS)
  src/miniaudio_impl.c          miniaudio 구현(WASAPI + null 백엔드만)
  vendor/miniaudio/             miniaudio 0.11.25 + apply-patch.py — exclusive 에서 요청 포맷을 먼저 시험, 실패 HRESULT 보존
  vendor/speexdsp/              리샘플러(BSD) — 수신 레이트 ≠ 장치 레이트일 때만
  binding.gyp · index.js · index.d.ts
src/main/nativeAudio/
  engine.ts                     애드온 로드, 장치 목록(+exclusive 매트릭스·기본 형식), 협상 열기(후보 순회 → 이유 → shared 폴백)
  negotiate.ts                  순수 함수: 후보 순서(비트↓→레이트↓→48k)·probe 필터·실패 분류·가로막은 앱·표기·비트레이트
  session.ts                    HiresSession: 캡처 링 → 프레임 → 와이어(장치 포맷 그대로) → XOR 4:1 → 릴레이 / 수신 → 지터버퍼 → 믹스 → 재생 링
  relay/                        PROTOCOL v1 Node 포팅(protocol·fec·jitter(바이트 프레임)·codec), 전송(ws + @fails-components WebTransport)
  ipc.ts                        native-audio:* 핸들러 — 등록된 웹뷰 webContents + 서버 origin 만 허용
src/preload/webview.ts          임베드 웹뷰 전용 프리로드 — window.jwNativeAudio 하나만 노출
```

### 설계 근거

- **miniaudio**(public domain/MIT-0, 단일 헤더). RtAudio·cpal 은 WASAPI shared 전용이고, PortAudio 는 exclusive 를 지원하나 ASIO 의존성이 수반된다.
  ASIO 는 2025-10 부터 GPLv3/독점 이중 라이선스이므로 보류하였다. 단, miniaudio 원본은 exclusive 에서 **Windows 기본 형식만**
  사용하므로, 요청 포맷(24/96·32/192)을 먼저 `IsFormatSupported(EXCLUSIVE)` 로 시험하는 패치를 적용하였다(`vendor/miniaudio/apply-patch.py`, 멱등).
- **네트워크·장치 I/O 는 전부 메인 프로세스에서 수행한다.** 렌더러(서버 웹)는 IPC 로 열기/통계/이벤트만 접근한다. 렌더러→메인으로 전달되는 토큰은
  120 s 릴레이 토큰에 한정된다(OAuth 토큰은 메인 프로세스 외부로 노출되지 않는다).
- **Node 는 WebTransport 를 제공하지 않는다** → 후보: (a) 숨김 BrowserWindow 의 Chromium WebTransport(렌더러에서 네트워크 수행 — 배제), (b) `@fails-components/webtransport`
  (BSD-3, libquiche 프리빌드 N-API v6 win32-x64 5.3 MB, cmake 불필요), (c) WebSocket 한정. **(b) 를 기본, (c) 를 폴백**으로 채택하였다.
  이 라이브러리는 공인 인증서 검증 경로에서 "Non serverCertificateHashes verification is experimental" 경고를 출력한다 — 알려진 위험이다.
  폴백·재시도 정책은 브라우저 측(`frontend-react/src/lib/lossless/transportSelector.ts`)과 동일하다.
- **와이어 코덱 = 장치 포맷 그대로**: s16→pcm_s16, s24→pcm_s24, s32→**pcm_s32(codec 5)**, f32→pcm_f32. 32-bit 정수는 float32 로
  표현할 수 없으므로 지터버퍼·재생 경로는 전부 바이트 단위로 처리한다(Float64 는 믹스·리샘플 시에만 사용).
- **비트퍼펙트 판정**: 캡처 = exclusive + 내부 포맷·레이트·채널 == 요청(24-in-32 컨테이너 → s24 `>>8` 은 무손실로 인정).
  재생 = exclusive + 피어 하나 + 레이트 동일 + 정수 상향 변환만. 레이트가 다르면 speex 리샘플 + `bitPerfect=false`(통계·배지에 "리샘플").

### 빌드 도구(Windows)

| 도구 | 확인한 버전 | 설치 |
|---|---|---|
| Visual Studio Build Tools 2022 — "C++ 데스크톱 개발"(MSVC v143 + Windows 11 SDK) | MSVC 14.44 · SDK 10.0.26100 | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| Python 3 | 3.12 | node-gyp 가 사용한다 |
| node-gyp 13 / node-addon-api 8 | devDependencies | `npm install` |
| cmake | **불필요**(node-gyp = MSBuild) | — |

```bash
npm install
npm run native:build          # Electron 헤더(devDependencies.electron)로 빌드 → native/build/Release/jw_native_audio.node (N-API 8, ~450 KB)
npm run native:build:node     # 이 Node 로 빌드(테스트 하네스). N-API 라 결과 바이너리는 Electron·Node 양쪽에서 로드된다
npm run build && npm test     # tsc + node --test(프로토콜 벡터·링버퍼·협상·코덱·FEC·지터)
node scripts/native-smoke.mjs --exclusive-try   # 장치 목록·exclusive 매트릭스·실제 장치 exclusive 시도·null 백엔드 왕복·리샘플러
```

네이티브 애드온을 빌드하지 않은 환경에서 `npm test` 를 실행하면, 애드온이 필요한 링버퍼 테스트(`tests/ring.test.mjs`)는 사유와 함께
**건너뜀**으로 표시된다(실패가 아니다). 빌드하였으나 로드에 실패하면 테스트가 실패한다. 애드온이 필수인 환경(릴리스 빌드)에서는
`JW_REQUIRE_NATIVE=1 npm test` 로 건너뜀을 실패로 처리한다.

CI: `npm ci && npm run native:build && npm run build && npm test`(windows-latest 러너에 VS Build Tools 기본 포함). `npm run dist` 는
`npmRebuild: false` 로 electron-builder 의 재빌드를 비활성화하고 `asarUnpack: ['**/*.node']` 로 두 바이너리(jw_native_audio·quiche)를 asar 외부에 배치한다.

### 웹 측 인터페이스 계약 — `window.jwNativeAudio`

정본은 `src/preload/webview.ts`(JwNativeAudio), 웹 측 사본은 `frontend-react/src/lib/hires/types.ts` 이다. 브라우저(일반 탭)에는 제공되지 않는다 → `lib/hires/register`
가 `'hires'` 단계를 등록하지 않으므로 음질 패널의 하이레조가 "데스크톱 앱에서만"으로 유지된다.

- `available()` · `listDevices()`(exclusive 매트릭스·기본 형식 포함) · `openHires({captureDevice?, playbackDevice?, rate, bits, channels, frameMs?, allowShared?, fec?, bufferPreset?})`
  → `{ok, exclusive, bitPerfect, capture, playback, wire, formatLabel:'PCM 32/192', nominalBps, reason?, code?, app?, device, attempts}`
- `connect(grant)`(= `/voice/relay-token` 응답) · `setGrant(grant)`(`needGrant` 이벤트에 대한 응답) · `close()` · `stats()` · `levels()` · `peers()` · `setMuted/ setDeafened/ setBufferPreset`
- 이벤트 `on(type|'*', fn)`: `started{result}` · `failed{reason, code?, app?, device}` · `downgraded{from, to, reason}` · `state` · `connected` · `transport_fallback` · `peer_joined/left/format` · `needGrant` · `warning` · `stats` · `error`
- 실패 사유 `reason`: `device_in_use`(다른 앱이 독점, `app` 에 프로세스 이름 — Windows 세션 열거로 확인되는 경우에 한함) · `exclusive_not_allowed`(소리 설정의 "독점 모드 허용" 비활성) ·
  `unsupported_format` · `access_denied` · `no_device` · `addon_unavailable`
- 어댑터(`frontend-react/src/lib/hires/adapter.ts`)는 UI 훅 `useVoice.confirmHiresExclusive(device, 'PCM 32/192 · 비트퍼펙트 · 12.3 Mbps')`(최초 1회,
  "다음부터 묻지 않기") 와 `useVoice.reportExclusiveError({app, device})`(danger 띠, [다시 시도]=`retryHires`) 를 지연 import 로 호출한다.
  실패·취소 시 해당 기간에는 **브라우저 무손실 24/48** 로 전송한다(`LosslessVoiceTransport.setSend(tier 'lossless')`).

### 검증

- 자동 시험: `tests/*.test.mjs`(`npm test`) · `frontend-react/tests/lib/hires/adapter.test.ts`. 두 앱을 실제 릴레이에 접속시켜 프레임 해시를 비교하는 종단 시험 스크립트는 리포에 포함되어 있지 않다.
- 오디오 장치가 없는 머신에서는 null 백엔드 + 결정적 신호(`testSignal: 'sweep'`)로 전체 경로를 시험한다. **exclusive 자체(장치 점유·포맷 협상)는 실제 오디오 인터페이스가 있어야 검증할 수 있다** —
  배포 전에 대상 장치에서 `node scripts/native-smoke.mjs --exclusive-try` 를 실행하여 확인한다.

## 배포

설치 파일은 `/api/apps/desktop` 으로 제공된다(다운로드 안내 페이지는 `/api/apps`).
백엔드는 저장소의 `apps/workspace-desktop-setup.exe` 를 그대로 제공하므로, 새로 빌드한 파일로 해당 파일을 교체하는 것으로 배포가 완료된다.

```bash
JW_SERVER_URL=https://workspace.example.com npm run dist   # release/workspace-desktop-setup.exe
scp release/workspace-desktop-setup.exe <user>@<서버>:/tmp/
ssh <user>@<서버> 'docker cp /tmp/workspace-desktop-setup.exe ws-backend:/storage/apps/workspace-desktop-setup.exe && rm /tmp/workspace-desktop-setup.exe'
```

설치 파일은 워크스페이스(주소)별로 상이하므로 각 워크스페이스가 자체 주소로 빌드한다.

### 코드 서명

서명 설정은 포함되어 있으며, 인증서는 빌드 주체가 준비한다. 환경변수 지정으로 충분하며 코드 변경은 불필요하다.

```bash
# Windows — OV 인증서(.pfx)
CSC_LINK=/path/to/cert.pfx CSC_KEY_PASSWORD=... npm run dist

# macOS — Developer ID + 공증
CSC_LINK=/path/to/cert.p12 CSC_KEY_PASSWORD=... APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... npm run dist
```

인증서가 없으면 electron-builder 는 경고 없이 서명을 생략한다. 서명되지 않은 설치 파일의 동작은 다음과 같다.
- Windows: SmartScreen 경고가 표시된다. OV 인증서는 평판이 축적될 때까지 경고가 유지되며, EV 는
  즉시 해소되나 USB 토큰/HSM 방식이므로 위 방식이 아닌 signtool 훅이 필요하다.
- macOS: Gatekeeper 가 실행을 차단하므로 **우클릭 → 열기** 를 1회 수행해야 한다.

`build/entitlements.mac.plist` 는 hardenedRuntime 용이다. JIT 관련 항목 3개가 없으면
공증된 앱이 실행 직후 종료된다 — Electron 이 JIT 를 사용하기 때문이다.

### macOS

`.dmg` 는 **macOS 에서만 생성할 수 있다.** Apple 도구 체인이 필요하므로 electron-builder 도
mac 타깃에 macOS 호스트를 요구한다. 코드는 동일하며 패키징만 macOS 에서 수행한다:

```bash
git clone <리포 URL> && cd just-workspace/apps/desktop
npm install
JW_SERVER_URL=https://workspace.example.com npm run dist        # release/*.dmg (arm64 + x64)
```

공증(notarization)에는 Apple Developer 계정이 필요하다. 계정이 없으면 Gatekeeper 가 실행을 차단하므로
사용자가 **우클릭 → 열기** 를 1회 수행해야 한다.

macOS 에서 동작이 상이한 항목은 다음 세 가지이다.
- 트레이 아이콘: 메뉴 막대는 색상 아이콘을 사용하지 않는다 → `trayTemplate.png`(알파만)
- 창 버튼: 앱이 직접 렌더링하지 않고 `titleBarStyle: 'hiddenInset'` 로 OS 의 창 제어 버튼을 사용한다
- 읽지 않음 배지: `setOverlayIcon`(Windows) 대신 Dock 배지(`app.setBadgeCount`)

화면 기록 권한은 최초 공유 시 OS 가 요청한다(`Info.plist` 설명 문구 포함).

## UI

앱이 직접 렌더링하는 화면(`src/renderer/`)의 색상·타이포그래피·간격은 `src/renderer/tokens.css` 에서 일괄 정의하며, 화면 파일에서는 리터럴 색상 값을 사용하지 않는다.
라이트/다크 테마는 **색상만** 상이하고 레이아웃은 동일하다. 라이트 테마에서는 본문 굵기 400 미만과
10px 이하의 글자를 사용하지 않는다.
