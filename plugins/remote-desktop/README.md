# 원격 데스크톱 플러그인 (`remote-desktop`)

Just Workspace 에 함께 실려 오는 플러그인이다. 브라우저에서 내 PC 에 원격 접속하거나, 코드 하나로 다른 사람의 PC 를 한 번 도와준다.
화면·입력은 워크스페이스의 회의 기능이 쓰는 **LiveKit(WebRTC)** 방 하나로 흐르고,
이 플러그인은 기기 등록·권한·동의·세션 발급·감사만 한다. 화면을 내주는 쪽(이하 "호스트")은 데스크톱 앱(`apps/desktop`, 지금은 Windows 만)이다.

- **회의 구역이 설치돼 있어야 한다.** manifest 에 `"zones": ["meetings"]` 가 있어, 회의 구역이 없으면 백엔드가 이 플러그인을 올리지 않는다.
- React(v2) 프런트 계약의 견본이기도 하다 — 플러그인을 만드는 법은 [docs/extensions.md](../../docs/extensions.md).

```
[브라우저 뷰어 /p/remote-desktop] ──(LiveKit: 화면 영상 + 데이터 채널 입력)── [데스크톱 앱 호스트 | 포터블 지원 프로그램]
              │                                                              │ 롱폴링(아웃바운드만)
              └──────────── /api/plugins/remote-desktop/* ───────────────────┘
```

## 두 가지 모드

| | 내 기기 | 1회성 지원 |
|---|---|---|
| 호스트 | 데스크톱 앱(로그인) — 설정 › 원격 접속 › "원격 접속 허용" | 포터블 `RemoteSupport.exe`(계정 없음) |
| 누가 접속 | 소유자 또는 관리자(회원) | 코드를 받은 회원 |
| 여는 조건 | 화면 앞 사람의 [허용] 누름(30초 안). 무인 접속은 **소유자 본인 요청 + 앱 설정 + 서버 설정** 셋 다일 때만 | 지원 프로그램에 뜬 9자리 코드(5분·1회) + 피지원자 [허용] |
| 끝 | 막대 [끊기], 뷰어 [끊기], 앱 종료, 하트비트 끊김(90초) | 같음 + 프로그램을 닫으면 코드·세션 모두 무효 |

## 보안 결정

- **PC 는 포트를 열지 않는다.** 호스트는 서버 롱폴링과 LiveKit 으로 나가는 연결만 쓴다(VNC·RDP 포트를 인터넷에 내놓았다가 나는 사고를 막는다).
- **공유 비밀번호가 없다.** 접속 권한은 회원 계정 권한이고, 호스트는 등록 때 받은 호스트 비밀(SHA-256 만 저장, 재등록 = 교체)로만 인증한다.
- **접속 코드:** 9자리 숫자, 서버 비밀 키 HMAC 만 저장, 5분, 쓰는 순간 소모(1회). 발급 IP 당 10/시간, 입력 IP 당 20/분 +
  회원별 10분 10회 실패 시 잠금. 비교는 상수시간. 살아 있는 코드와 한 자리만 다른 틀린 코드가 5번 들어오면 그 코드를 바로 폐기(근접 대입 차단).
- **동의가 기본.** 동의 창 기본 포커스는 [거부](Enter 연타로 허용되지 않게), 30초 무응답 = 거부. 동의 창에 요청자 이름·이메일·조직·도메인, 허용하면 할 수 있는 일, 사기 경고, 남은 시간 막대.
- **접속 중 막대**는 항상 위·닫기 없음, [끊기]가 즉시 종료. 막대는 화면 송출에서 빠진다(setContentProtection).
- **LiveKit 토큰 범위:** 호스트 = `screen_share` 트랙만 송출 + 데이터, 뷰어 = 송출 금지·구독 + 데이터. 방 이름은 세션마다 무작위,
  토큰 10분. 종료하면 방을 닫고(남은 토큰으로 다시 붙어도 상대가 없음) 뷰어 토큰을 다시 내주지 않는다. 관리자도 **남의 세션 화면엔 못 들어간다**(요청자만).
- **데이터 채널 입력은 믿지 않는다.** 호스트가 모양·범위 검사, 키는 `KeyboardEvent.code` 허용목록 → 스캔코드 표로만,
  종류별 속도 제한(이동 240/초, 그 밖 60/초), 상대 정체성에서 온 메시지만 받는다. 끊길 때 눌린 키·버튼을 모두 뗀다.
- **호스트 클립보드는 자동으로 나가지 않는다.** 뷰어가 [클립보드 받기](`clipreq`)를 누를 때만 텍스트를 한 번 보낸다(10만 자까지, 초당 1회).
- **1회성 지원 프로그램은 세션이 한 번 끝나면(거부 포함) 새 코드를 주지 않는다** — 다시 받으려면 프로그램을 새로 실행.
- **로그인 없이 설정을 다시 여는 경로가 없다**(초기 설정 화면을 다시 불러 인증을 건너뛰는 류의 사고를 막는다): 익명으로 열린 길은 코드 발급·지원 프로그램 폴링/동의/종료·내려받기뿐이고
  모두 자기 세션 비밀이 있어야 한다.
- **모든 단계를 감사(`plugin_remote_audit`)에 남긴다** — 요청·코드 발급/실패·동의/거부·토큰 발급·종료(사유)·기기 등록/해지, IP 포함.
  관리자 API `GET /audit`.

## API (`/api/plugins/remote-desktop`)

회원(세션·데스크톱 OAuth): `GET /status` · `GET|POST /devices` · `PATCH|DELETE /devices/{id}` · `GET /devices/{id}/sessions?limit=3`(소유자) · `POST /devices/{id}/connect`
· `POST /support/join {code}` · `GET /sessions/{id}[?token=1]` · `POST /sessions/{id}/end` · `GET /audit`(관리자)

호스트(`X-Remote-Host: <기기 id>:<비밀>`): `GET /host/poll?wait&known` · `POST /host/sessions/{id}/decision {allow}` · `POST /host/sessions/{id}/end`

지원 프로그램(익명 → `X-Remote-Support: <세션 id>:<비밀>`): `POST /support/code` · `GET /support/poll?wait&since`
· `POST /support/decision {allow}` · `POST /support/end` · `GET /support/download`(익명 내려받기)

데이터 채널 프로토콜: 뷰어 `frontend/src/protocol.ts`, 호스트 `apps/desktop/src/main/remote/protocol.ts`(같은 모양, 호스트가 검증).

## 저장

플러그인 전용 DeclarativeBase, 첫 요청 때 `create_all` — `plugin_remote_devices` · `plugin_remote_sessions` · `plugin_remote_audit`.
코어 마이그레이션 없음.

## 빌드·테스트

```bash
# 백엔드(코어 backend 이미지 안에서)
docker run --rm -v $PWD/plugins/remote-desktop:/plug:ro -e PYTHONPATH=/app --entrypoint sh <backend 이미지> \
  -c 'cd /tmp && python -m pytest -q -p no:cacheprovider -o asyncio_mode=auto /plug/backend/tests'
# 프런트 번들(dist/plugin.mjs 를 커밋한다 — 코어 frontend-react/node_modules 의 esbuild·typescript·livekit-client 를 빌려 씀)
node plugins/remote-desktop/frontend/build.mjs
# 프로토콜 테스트
cd frontend-react && npx vitest run --root ../plugins/remote-desktop/frontend --environment node src/protocol.test.ts
# 데스크톱 호스트
cd apps/desktop && npm run native:build && npm run build && node --test tests/*.test.mjs
# 포터블 지원 프로그램(서명 없음) → release-support/remote-support.exe
cd apps/desktop && JW_SERVER_URL=https://<도메인> npm run dist:support
```

## 쓰기 시작하기

1. 회의 구역이 설치돼 있으면 따로 설치할 것이 없다 — 백엔드가 뜰 때 `/api/plugins/remote-desktop` 을 붙이고, 테이블은 첫 요청 때 만든다.
   nginx 설정도 바꿀 것이 없다(`/api/plugins/` 공용 경로).
2. 회의(LiveKit)가 동작해야 한다(`LIVEKIT_API_KEY`·`LIVEKIT_API_SECRET`, 바깥에서 쓰려면 TURN).
3. 관리 › 모듈·플러그인에서 "원격 데스크톱"이 켜져 있는지 확인한다(처음부터 켜져 있다).
4. 데스크톱 앱을 빌드해 배포한다(`npm run native:build` 로 입력 애드온 `jw_remote_input.node` 가 들어가야 한다 — [apps/desktop/README.md](../../apps/desktop/README.md)).
5. 1회성 지원을 쓰려면 `npm run dist:support` 산출물(`release-support/remote-support.exe`)을 서버 저장소의 `apps/remote-support.exe` 로 올린다
   (`docker cp … ws-backend:/storage/apps/remote-support.exe`) → 웹의 [지원 프로그램 받기]가 동작한다.

### 확인 순서

1. PC A 데스크톱 앱: 설정 › 원격 접속 › 허용 켬 → 웹 /p/remote-desktop 내 기기에 온라인으로 뜨는지.
2. 다른 PC 브라우저에서 [연결] → A 에 동의 창(요청자 이름) → [허용] → 화면이 보이는지, 마우스·키보드·휠·한/영·Alt+Tab, 클립보드 양방향.
3. A 에서 UAC 창을 띄워 뷰어에 "보안 화면" 안내가 뜨는지, Ctrl+Alt+Del 버튼이 "무인 모드 필요" 안내로 거절되는지.
4. 막대 [끊기] / 뷰어 [끊기] / A 앱 종료 각각에서 양쪽이 끝나고 감사에 사유가 남는지(`GET /audit`).
5. 포터블: 코드 발급 → 회원이 코드 입력 → [허용] → 지원 → 프로그램 닫기 → 같은 코드 재사용 거절.
6. 코드 5분 만료, 틀린 코드 10회 후 잠금, 거부 시 상태.

## 아직 없는 것

- **무인 접속 서비스(Windows):** 로그인 전 화면·UAC 보안 데스크톱·Ctrl+Alt+Del. SYSTEM 서비스가 활성 콘솔 세션에 헬퍼를 띄우고
  헬퍼가 입력 데스크톱(Winlogon 포함)을 따라간다. Ctrl+Alt+Del 은 SendSAS. 서비스↔헬퍼 파이프는 상대 프로세스의 서명·경로를 검증.
- **캡처·인코딩:** DXGI Desktop Duplication + 하드웨어 인코더(동적 로드), 커서 별도 전송, 헤드리스 PC 용 가상 디스플레이(IddCx).
- 파일 전송(워크스페이스 파일 모듈 경유), 다중 모니터 동시 보기, 세션 녹화(선택·고지), 지연 측정 표시.
- macOS(CGEvent·화면 기록 권한)·Linux(XTest/uinput, Wayland 포털) 입력 주입 — 자리만 있고 동작하지 않는다(호스트는 Windows 만).
- 포터블 프로그램 코드 서명, 데스크톱 앱 자동 업데이트 서명 검증.
- 관리 화면(세션·감사 목록 UI), 기기별 접근 정책(그룹), 세션 최대 시간.
