# Just Workspace 데스크톱 앱

Just Workspace 의 데스크톱 앱(Windows·macOS)이다. Electron 창 안에 워크스페이스 서버의 웹 화면(`frontend-react`)을 그대로 연다.
**앱이 직접 그리는 것은 창 테두리 한 줄(이동·뒤로/앞으로/새로 고침·창 버튼)뿐이고**, 사이드바·상단바·알림 패널·사용자 메뉴를 포함한
나머지는 전부 웹이 브라우저와 똑같이 그린다. 앱 전체 그림과 모바일 앱은 [../README.md](../README.md).

앱은 **워크스페이스 하나에 묶여 빌드된다**(주소가 앱 안에 구워진다 — 아래 "개발"). 0.5.0 보다 낮은 버전의 앱은 사이드바를 스스로 그렸기 때문에,
웹은 그런 앱에서 열리면 자기 사이드바를 숨긴다(`frontend-react/src/composables/useDesktopShell.ts` 의 `SHELL_WEB_CHROME_SINCE`).

데스크톱만 하는 일은 OS 기능뿐이다: 트레이·알림 토스트(인라인 답장)·폴더 동기화·화면 공유 피커·회의 전용 창·하이레조 오디오·
원격 데스크톱 호스트·자동 시작·오른쪽 클릭 메뉴(`src/main/contextMenu.ts`).

- 앱 → 웹 화면 이동(트레이 "회의"·알림 클릭)은 `window.jwShell.onNavigate`(`src/preload/webview.ts` ↔ `frontend-react/src/lib/desktopBridge.ts`)로
  SPA 라우터에 넘긴다. 새로 불러오면 음성채널·통화가 끊기기 때문이다. 웹이 구독 전이면 새로 불러오기로 대신한다.
- 웹 사용자 메뉴의 "로그아웃"이 성공하면(`POST /api/auth/logout`, 본문 웹뷰에서 온 것만) 앱도 로그아웃한다.
- 이 앱의 소켓이 붙어 있으면 서버는 웹푸시를 보내지 않으므로, 모든 알림 종류(작업·일정·회의·파일·메일·게시판)를 토스트로 띄운다.
  서버 방해 금지(지금 켜기·일정)는 실시간 이벤트의 `quiet` 로 받아 따른다.

## 왜 Electron 인가

이 앱에 실제로 필요한 것은 화면 공유(`desktopCapturer`)·시스템 트레이·OS 자격 증명 저장소인데, 셋 다
Electron 이 내장으로 갖고 있다. Tauri 같은 더 가벼운 틀에서는 플러그인·네이티브 코드를 따로 붙여야 한다.
설치 파일은 커지지만 유지 비용이 훨씬 싸다.

## 구조

```
src/main/        메인 프로세스 — 창·트레이·IPC·인증·폴더 동기화(sync/)·하이레조 오디오(nativeAudio/)·원격 데스크톱 호스트(remote/)
  auth/
    pkce.ts        RFC 7636 code_verifier/challenge
    loopback.ts    RFC 8252 §7.3 루프백 콜백 (포트 0)
    keychain.ts    safeStorage(DPAPI/Keychain/libsecret)
    broker.ts      ★ 단일 갱신 브로커 — 아래 설명
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

RFC 8252(네이티브 앱 OAuth) 를 따른다. 앱 안 웹뷰에 로그인 폼을 띄우지 않고
**시스템 브라우저**를 열어 루프백으로 코드를 받는다. 공개 클라이언트라
client_secret 이 없고 PKCE S256 으로만 증명한다.

서버 쪽 전제:

- OAuth 클라이언트 `desktop-app`(공개·신뢰 클라이언트)은 백엔드에 **기본으로 들어 있다**(`backend/app/auth/oauth_provider.py` 의 `BUILTIN_CLIENTS`) —
  워크스페이스마다 등록할 필요가 없다
- `redirect_uris` 는 `http://127.0.0.1/callback` — 포트는 무시되고 스킴·호스트·경로만
  대조한다(RFC 8252 §7.3)
- 일반 API(`/api/devices` 등)는 1st-party OAuth Bearer 를 받는다
  (`backend/app/auth/deps.py:_user_from_first_party_oauth`). WebSocket 은 토큰을
  `Sec-WebSocket-Protocol: jw.bearer, jw.token.<base64url>` 로 보낸다(쿼리스트링 금지)

### 갱신은 반드시 한 곳에서

서버는 리프레시 토큰에 회전 + 재사용 탐지를 건다. 앱 안에서 토큰을 쓰는 주체가
여럿(웹 뷰·회의 창·동기화)이라 동시에 갱신하면 뒤늦은 요청이 이미 회전된 토큰을
보내고, 서버는 이를 탈취로 보고 **패밀리 전체를 폐기**한다. 증상은 "가끔 이유 없이
로그아웃" 이고 재현이 안 된다.

그래서 갱신은 `broker.ts` 하나만 한다. 진행 중인 갱신이 있으면 나중에 온 호출자는
같은 프로미스에 합류한다. 같은 이유로 **인스턴스도 하나만** 뜬다
(`app.requestSingleInstanceLock`).

## 개발

```bash
npm install
npm run build     # tsc + 렌더러 정적 파일 복사
npm start         # electron .
npm run dist      # electron-builder
```

앱은 워크스페이스 하나에 묶이고, **어느 서버에 붙을지는 빌드할 때 정한다.**
`scripts/site.mjs` 가 환경변수를 `dist/site.json` 으로 굽고, 런타임(`src/main/config.ts`)과
패키징(`electron-builder.config.cjs`)이 그 파일을 읽는다.

| 변수 | 기본 | 용도 |
|---|---|---|
| `JW_SERVER_URL` | 개발 빌드 `http://localhost`, `npm run dist` 는 필수 | 워크스페이스 주소 |
| `JW_APP_ID` | 호스트를 뒤집고 `.just-workspace` (`ws.example.com` → `com.example.ws.just-workspace`) | 설치·업데이트 식별자. **한 번 배포하면 바꾸지 말 것** |
| `JW_PRODUCT_NAME` | `just-workspace` | 설치 폴더·바로가기 이름. 주면 사용자 데이터 폴더도 갈린다(한 PC 에 두 사이트 앱) |

개발 중에는 실행할 때 `JW_SERVER_URL` 을 줘서 구운 값을 덮을 수 있다.

런타임·도구 버전 메모(Electron 45 / electron-builder 26 / TypeScript 7):
- `npm install` 은 Electron 바이너리를 내려받지 않는다(Electron 42 부터 postinstall 폐지). 처음
  `electron .` 을 돌릴 때 받고, `electron-builder` 는 자기 캐시로 따로 받는다. 오프라인 빌드 머신이면
  `npx install-electron` 을 먼저 돌린다.
- 지원 OS: Windows 64비트만(ia32 빌드 폐지), macOS 13 이상.
- `@types/node` 는 Electron 이 품은 Node 메이저(45 → Node 24)에 맞춘다. 더 높이면 런타임에 없는
  API 가 타입만 통과한다.
- `tsconfig` 의 `module` 은 `node16`(CommonJS 출력). TypeScript 7 이 `moduleResolution: node` 를 없앴다.
- `safeStorage` 는 비동기 API 만 쓴다(동기 API 는 Electron 46 에서 제거). 기존 설치의 암호문은 그대로 읽힌다.

## 하이레조 네이티브 오디오

음성채널 "하이레조" 단계 — **WASAPI exclusive** 로 장치를 독점해 장치 네이티브 포맷(최대 32-bit/192 kHz) PCM 을 리샘플·변환 없이
무손실 릴레이(`audiorelay`, PROTOCOL v1)로 보내고 받는다. 브라우저 무손실 피어(PCM 24/48)와 같은 방에서 서로 들린다.

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

### 왜 이렇게

- **miniaudio**(public domain/MIT-0, 단일 헤더). RtAudio·cpal 은 WASAPI shared 전용, PortAudio 는 exclusive 가 되지만 ASIO 를 끌어들인다.
  ASIO 는 2025-10 부터 GPLv3/독점 이중 라이선스라 보류. 단, miniaudio 원본은 exclusive 에서 **Windows 기본 형식만**
  쓰므로 요청 포맷(24/96·32/192)을 먼저 `IsFormatSupported(EXCLUSIVE)` 로 시험하는 패치를 넣었다(`vendor/miniaudio/apply-patch.py`, 멱등).
- **네트워크·장치 I/O 는 전부 메인 프로세스.** 렌더러(서버 웹)는 IPC 로 열기/통계/이벤트만 본다. 토큰 중 렌더러→메인으로 넘어오는 것은
  120 s 릴레이 토큰만(OAuth 토큰은 여전히 메인 밖으로 안 나간다).
- **WebTransport 는 Node 에 없다** → 후보: (a) 숨은 BrowserWindow 의 Chromium WebTransport(렌더러에서 네트워크 — 배제), (b) `@fails-components/webtransport`
  (BSD-3, libquiche 프리빌드 N-API v6 win32-x64 5.3 MB, cmake 불필요), (c) WebSocket 만. **(b) 를 기본, (c) 를 폴백**으로 골랐다.
  이 라이브러리는 공인 인증서 검증 경로에 "Non serverCertificateHashes verification is experimental" 경고를 낸다 — 알려진 위험이다.
  폴백·재시도 정책은 브라우저 쪽(`frontend-react/src/lib/lossless/transportSelector.ts`)과 같다.
- **와이어 코덱 = 장치 포맷 그대로**: s16→pcm_s16, s24→pcm_s24, s32→**pcm_s32(codec 5)**, f32→pcm_f32. 32-bit 정수는 float32 가
  못 담으므로 지터버퍼·재생 경로가 전부 바이트 단위(Float64 는 믹스·리샘플 때만).
- **비트퍼펙트 판정**: 캡처 = exclusive + 내부 포맷·레이트·채널 == 요청(24-in-32 컨테이너 → s24 `>>8` 은 무손실로 인정).
  재생 = exclusive + 피어 하나 + 레이트 같음 + 정수 상향 변환만. 레이트가 다르면 speex 리샘플 + `bitPerfect=false`(통계·배지에 "리샘플").

### 빌드 도구(Windows)

| 도구 | 확인한 버전 | 설치 |
|---|---|---|
| Visual Studio Build Tools 2022 — "C++ 데스크톱 개발"(MSVC v143 + Windows 11 SDK) | MSVC 14.44 · SDK 10.0.26100 | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| Python 3 | 3.12 | node-gyp 가 쓴다 |
| node-gyp 13 / node-addon-api 8 | devDependencies | `npm install` |
| cmake | **불필요**(node-gyp = MSBuild) | — |

```bash
npm install
npm run native:build          # Electron 헤더(devDependencies.electron)로 빌드 → native/build/Release/jw_native_audio.node (N-API 8, ~450 KB)
npm run native:build:node     # 이 Node 로 빌드(테스트 하네스). N-API 라 결과 바이너리는 Electron·Node 양쪽에서 로드된다
npm run build && npm test     # tsc + node --test(프로토콜 벡터·링버퍼·협상·코덱·FEC·지터)
node scripts/native-smoke.mjs --exclusive-try   # 장치 목록·exclusive 매트릭스·실제 장치 exclusive 시도·null 백엔드 왕복·리샘플러
```

네이티브 애드온을 빌드하지 않은 곳에서 `npm test` 를 돌리면, 애드온이 있어야 하는 링버퍼 테스트(`tests/ring.test.mjs`)는 이유와 함께
**건너뜀**으로 표시된다(실패가 아니다). 빌드했는데 불러오지 못하면 실패한다. 애드온이 반드시 있어야 하는 곳(릴리스 빌드)에서는
`JW_REQUIRE_NATIVE=1 npm test` 로 건너뛰기를 실패로 바꾼다.

CI: `npm ci && npm run native:build && npm run build && npm test`(windows-latest 러너에 VS Build Tools 기본 포함). `npm run dist` 는
`npmRebuild: false` 로 electron-builder 의 재빌드를 끄고 `asarUnpack: ['**/*.node']` 로 두 바이너리(jw_native_audio·quiche)를 asar 밖에 둔다.

### 웹 쪽 계약 — `window.jwNativeAudio`

정본 `src/preload/webview.ts`(JwNativeAudio), 웹 복제 `frontend-react/src/lib/hires/types.ts`. 브라우저(일반 탭)에는 없다 → `lib/hires/register`
가 `'hires'` 단계를 등록하지 않아 음질 패널의 하이레조가 "데스크톱 앱에서만"으로 남는다.

- `available()` · `listDevices()`(exclusive 매트릭스·기본 형식 포함) · `openHires({captureDevice?, playbackDevice?, rate, bits, channels, frameMs?, allowShared?, fec?, bufferPreset?})`
  → `{ok, exclusive, bitPerfect, capture, playback, wire, formatLabel:'PCM 32/192', nominalBps, reason?, code?, app?, device, attempts}`
- `connect(grant)`(= `/voice/relay-token` 응답) · `setGrant(grant)`(`needGrant` 이벤트에 답) · `close()` · `stats()` · `levels()` · `peers()` · `setMuted/ setDeafened/ setBufferPreset`
- 이벤트 `on(type|'*', fn)`: `started{result}` · `failed{reason, code?, app?, device}` · `downgraded{from, to, reason}` · `state` · `connected` · `transport_fallback` · `peer_joined/left/format` · `needGrant` · `warning` · `stats` · `error`
- 실패 이유 `reason`: `device_in_use`(다른 앱이 독점, `app` 에 프로세스 이름 — Windows 세션 열거로 보일 때만) · `exclusive_not_allowed`(소리 설정의 "독점 모드 허용" 꺼짐) ·
  `unsupported_format` · `access_denied` · `no_device` · `addon_unavailable`
- 어댑터(`frontend-react/src/lib/hires/adapter.ts`)는 UI 훅 `useVoice.confirmHiresExclusive(device, 'PCM 32/192 · 비트퍼펙트 · 12.3 Mbps')`(처음 한 번,
  "다음부터 묻지 않기") 와 `useVoice.reportExclusiveError({app, device})`(danger 띠, [다시 시도]=`retryHires`) 를 늦은 import 로 부른다.
  실패·취소 시 그동안 **브라우저 무손실 24/48** 로 보낸다(`LosslessVoiceTransport.setSend(tier 'lossless')`).

### 검증

- 자동 시험: `tests/*.test.mjs`(`npm test`) · `frontend-react/tests/lib/hires/adapter.test.ts`. 두 앱을 실제 릴레이에 붙여 프레임 해시를 견주는 종단 시험 스크립트는 리포에 없다.
- 오디오 장치가 없는 머신에서는 null 백엔드 + 결정적 신호(`testSignal: 'sweep'`)로 전체 경로를 돈다. **exclusive 자체(장치 점유·포맷 협상)는 실제 오디오 인터페이스가 있어야 확인된다** —
  배포 전에 쓰는 장치에서 `node scripts/native-smoke.mjs --exclusive-try` 를 돌려 본다.

## 배포

설치 파일은 `/api/apps/desktop` 으로 내려간다(내려받기 안내 페이지는 `/api/apps`).
백엔드는 저장소의 `apps/workspace-desktop-setup.exe` 를 그대로 내줄 뿐이라, 새로 빌드한 파일을 그 자리에 덮으면 끝이다.

```bash
JW_SERVER_URL=https://workspace.example.com npm run dist   # release/workspace-desktop-setup.exe
scp release/workspace-desktop-setup.exe <user>@<서버>:/tmp/
ssh <user>@<서버> 'docker cp /tmp/workspace-desktop-setup.exe ws-backend:/storage/apps/workspace-desktop-setup.exe && rm /tmp/workspace-desktop-setup.exe'
```

설치 파일은 워크스페이스(주소)마다 다르므로 각 워크스페이스가 자기 주소로 빌드한다.

### 코드 서명

서명 설정은 들어 있고, 인증서는 빌드하는 쪽이 준비한다. 환경변수만 주면 되고 코드는 안 바꾼다.

```bash
# Windows — OV 인증서(.pfx)
CSC_LINK=/path/to/cert.pfx CSC_KEY_PASSWORD=... npm run dist

# macOS — Developer ID + 공증
CSC_LINK=/path/to/cert.p12 CSC_KEY_PASSWORD=... APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... npm run dist
```

인증서가 없으면 electron-builder 가 서명을 조용히 건너뛴다. 서명하지 않은 설치 파일은:
- Windows: SmartScreen 경고. OV 인증서는 평판이 쌓일 때까지 경고가 남고, EV 는
  즉시 사라지지만 USB 토큰/HSM 이라 위 방식이 아니라 signtool 훅이 필요하다.
- macOS: Gatekeeper 가 막아 **우클릭 → 열기** 를 한 번 해야 한다.

`build/entitlements.mac.plist` 는 hardenedRuntime 용이다. JIT 관련 셋이 없으면
공증한 앱이 실행되자마자 죽는다 — Electron 이 JIT 를 쓰기 때문이다.

### macOS

`.dmg` 는 **맥에서만 만들 수 있다.** Apple 도구 체인이 필요해서 electron-builder 도
mac 타깃은 macOS 호스트를 요구한다. 코드는 그대로 쓰고 패키징만 맥에서 돌린다:

```bash
git clone <리포 URL> && cd just-workspace/apps/desktop
npm install
JW_SERVER_URL=https://workspace.example.com npm run dist        # release/*.dmg (arm64 + x64)
```

공증(notarization)에는 Apple Developer 계정이 필요하다. 없으면 Gatekeeper 가 막아
사용자가 **우클릭 → 열기** 를 한 번 해야 한다.

맥에서 다르게 도는 곳은 셋이다:
- 트레이 아이콘: 메뉴 막대는 색 아이콘을 쓰지 않는다 → `trayTemplate.png`(알파만)
- 창 버튼: 우리가 그리지 않고 `titleBarStyle: 'hiddenInset'` 로 OS 신호등을 쓴다
- 안 읽음 뱃지: `setOverlayIcon`(Windows) 대신 Dock 뱃지(`app.setBadgeCount`)

화면 기록 권한은 첫 공유 시 OS 가 묻는다(`Info.plist` 설명 문구 포함).

## UI

앱이 직접 그리는 화면(`src/renderer/`)의 색·타이포·간격은 `src/renderer/tokens.css` 한 곳에 모여 있고 화면 파일에서 리터럴 색을 쓰지 않는다.
라이트/다크는 **색만** 다르고 레이아웃은 같다. 라이트에서는 본문 굵기 400 미만과
10px 이하 글자를 쓰지 않는다.
