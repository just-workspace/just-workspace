# 원격 데스크톱 플러그인 (`remote-desktop`)

Just Workspace 에 기본 포함되어 배포되는 플러그인이다. 브라우저에서 사용자 본인의 PC 에 원격 접속하거나, 일회용 코드로 타인의 PC 를 1회 지원한다.
화면·입력은 워크스페이스의 회의 기능이 사용하는 **LiveKit(WebRTC)** 방 하나로 전송되며,
이 플러그인은 기기 등록·권한·동의·세션 발급·감사만 담당한다. 화면을 제공하는 측(이하 "호스트")은 데스크톱 앱(`apps/desktop`, 현재 Windows 한정)이다.

- **회의 구역의 설치가 필요하다.** manifest 에 `"zones": ["meetings"]` 가 선언되어 있어, 회의 구역이 없으면 백엔드가 이 플러그인을 로드하지 않는다.
- React(v2) 프런트 계약의 견본을 겸한다 — 플러그인 작성 방법은 [docs/extensions.md](../../docs/extensions.md) 를 참조한다.

```
[브라우저 뷰어 /p/remote-desktop] ──(LiveKit: 화면 영상 + 데이터 채널 입력)── [데스크톱 앱 호스트 | 포터블 지원 프로그램]
              │                                                              │ 롱폴링(아웃바운드만)
              └──────────── /api/plugins/remote-desktop/* ───────────────────┘
```

## 운영 모드

| | 내 기기 | 1회성 지원 |
|---|---|---|
| 호스트 | 데스크톱 앱(로그인) — 설정 › 원격 접속 › "원격 접속 허용" | 포터블 `RemoteSupport.exe`(계정 없음) |
| 접속 주체 | 소유자 또는 관리자(회원) | 코드를 전달받은 회원 |
| 접속 허용 조건 | 화면 앞 사용자의 [허용] 선택(30초 이내). 무인 접속은 **소유자 본인 요청 + 앱 설정 + 서버 설정**의 세 조건을 모두 충족하는 경우에 한함 | 지원 프로그램에 표시된 9자리 코드(5분·1회) + 피지원자의 [허용] |
| 종료 | 막대 [끊기], 뷰어 [끊기], 앱 종료, 하트비트 중단(90초) | 동일 + 프로그램을 종료하면 코드·세션 모두 무효 |

## 보안 설계 사항

- **PC 는 포트를 개방하지 않는다.** 호스트는 서버 롱폴링과 LiveKit 에 대한 아웃바운드 연결만 사용한다(VNC·RDP 포트의 인터넷 노출로 인한 사고를 방지한다).
- **공유 비밀번호를 사용하지 않는다.** 접속 권한은 회원 계정의 권한이며, 호스트는 등록 시 발급받은 호스트 비밀(SHA-256 만 저장, 재등록 = 교체)로만 인증한다.
- **접속 코드:** 9자리 숫자, 서버 비밀 키 HMAC 만 저장, 유효 기간 5분, 사용 즉시 소멸(1회). 발급 IP 당 10/시간, 입력 IP 당 20/분 +
  회원별 10분간 10회 실패 시 잠금. 비교는 상수시간. 유효한 코드와 한 자리만 다른 오입력이 5회 발생하면 해당 코드를 즉시 폐기한다(근접 대입 차단).
- **동의를 기본 원칙으로 한다.** 동의 창의 기본 포커스는 [거부](Enter 연속 입력으로 허용되지 않도록 함), 30초 무응답 = 거부. 동의 창에는 요청자 이름·이메일·조직·도메인, 허용 시 가능한 작업, 사기 경고, 잔여 시간 막대를 표시한다.
- **접속 중 막대**는 항상 위·닫기 없음이며, [끊기]가 즉시 종료를 수행한다. 막대는 화면 송출에서 제외된다(setContentProtection).
- **LiveKit 토큰 범위:** 호스트 = `screen_share` 트랙만 송출 + 데이터, 뷰어 = 송출 금지·구독 + 데이터. 방 이름은 세션마다 무작위로 생성하며,
  토큰의 유효 기간은 10분이다. 종료 시 방을 닫고(잔여 토큰으로 재접속하더라도 상대가 없음) 뷰어 토큰을 재발급하지 않는다. 관리자도 **타인의 세션 화면에는 접속할 수 없다**(요청자 한정).
- **데이터 채널 입력은 신뢰하지 않는다.** 호스트가 형식·범위를 검사하고, 키는 `KeyboardEvent.code` 허용 목록 → 스캔코드 표로만 변환하며,
  종류별 속도 제한(이동 240/초, 그 밖 60/초)을 적용하고, 상대 정체성에서 발신된 메시지만 수신한다. 연결 종료 시 눌린 상태의 키·버튼을 전부 해제한다.
- **호스트 클립보드는 자동으로 전송되지 않는다.** 뷰어가 [클립보드 받기](`clipreq`)를 선택한 경우에만 텍스트를 1회 전송한다(최대 10만 자, 초당 1회).
- **1회성 지원 프로그램은 세션이 1회 종료되면(거부 포함) 새 코드를 발급하지 않는다** — 재발급에는 프로그램의 재실행이 필요하다.
- **로그인 없이 설정을 재개하는 경로가 없다**(초기 설정 화면을 재호출해 인증을 우회하는 유형의 사고를 방지한다): 익명으로 접근 가능한 경로는 코드 발급·지원 프로그램 폴링/동의/종료·다운로드에 한정되며
  모두 해당 세션의 비밀을 요구한다.
- **모든 단계를 감사 로그(`plugin_remote_audit`)에 기록한다** — 요청·코드 발급/실패·동의/거부·토큰 발급·종료(사유)·기기 등록/해지, IP 포함.
  관리자 API `GET /audit`.

## API (`/api/plugins/remote-desktop`)

회원(세션·데스크톱 OAuth): `GET /status` · `GET|POST /devices` · `PATCH|DELETE /devices/{id}` · `GET /devices/{id}/sessions?limit=3`(소유자) · `POST /devices/{id}/connect`
· `POST /support/join {code}` · `GET /sessions/{id}[?token=1]` · `POST /sessions/{id}/end` · `GET /audit`(관리자)

호스트(`X-Remote-Host: <기기 id>:<비밀>`): `GET /host/poll?wait&known` · `POST /host/sessions/{id}/decision {allow}` · `POST /host/sessions/{id}/end`

지원 프로그램(익명 → `X-Remote-Support: <세션 id>:<비밀>`): `POST /support/code` · `GET /support/poll?wait&since`
· `POST /support/decision {allow}` · `POST /support/end` · `GET /support/download`(익명 다운로드)

데이터 채널 프로토콜: 뷰어 `frontend/src/protocol.ts`, 호스트 `apps/desktop/src/main/remote/protocol.ts`(동일 형식, 호스트가 검증).

## 데이터 저장

플러그인 전용 DeclarativeBase 를 사용하며 최초 요청 시 `create_all` 을 수행한다 — `plugin_remote_devices` · `plugin_remote_sessions` · `plugin_remote_audit`.
코어 마이그레이션은 없다.

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

## 설치 및 구성 절차

1. 회의 구역이 설치되어 있으면 별도의 설치 작업이 없다 — 백엔드가 기동 시 `/api/plugins/remote-desktop` 을 등록하고, 테이블은 최초 요청 시 생성한다.
   nginx 설정의 변경도 불필요하다(`/api/plugins/` 공용 경로).
2. 회의(LiveKit)가 동작해야 한다(`LIVEKIT_API_KEY`·`LIVEKIT_API_SECRET`, 외부망에서 사용하려면 TURN 필요).
3. 관리 › 모듈·플러그인에서 "원격 데스크톱"의 활성화 여부를 확인한다(기본값은 활성화).
4. 데스크톱 앱을 빌드해 배포한다(`npm run native:build` 로 입력 애드온 `jw_remote_input.node` 가 포함되어야 한다 — [apps/desktop/README.md](../../apps/desktop/README.md)).
5. 1회성 지원을 사용하려면 `npm run dist:support` 산출물(`release-support/remote-support.exe`)을 서버 저장소의 `apps/remote-support.exe` 로 업로드한다
   (`docker cp … ws-backend:/storage/apps/remote-support.exe`) → 웹의 [지원 프로그램 다운로드]가 동작한다.

### 검증 절차

1. PC A 데스크톱 앱: 설정 › 원격 접속 › 허용 활성화 → 웹 /p/remote-desktop 의 내 기기에 온라인으로 표시되는지 확인.
2. 다른 PC 의 브라우저에서 [연결] → A 에 동의 창(요청자 이름) 표시 → [허용] → 화면 표시 여부, 마우스·키보드·휠·한/영·Alt+Tab, 클립보드 양방향 확인.
3. A 에서 UAC 창을 표시하여 뷰어에 "보안 화면" 안내가 표시되는지, Ctrl+Alt+Del 버튼이 "무인 모드 필요" 안내와 함께 거부되는지 확인.
4. 막대 [끊기] / 뷰어 [끊기] / A 앱 종료 각각에서 양측이 종료되고 감사 로그에 사유가 기록되는지 확인(`GET /audit`).
5. 포터블: 코드 발급 → 회원의 코드 입력 → [허용] → 지원 → 프로그램 종료 → 동일 코드 재사용 거부 확인.
6. 코드 5분 만료, 오입력 10회 후 잠금, 거부 시 상태 확인.

## 알려진 제한 사항 (미구현 기능)

- **무인 접속 서비스(Windows):** 로그인 전 화면·UAC 보안 데스크톱·Ctrl+Alt+Del. SYSTEM 서비스가 활성 콘솔 세션에 헬퍼를 실행하고
  헬퍼가 입력 데스크톱(Winlogon 포함)을 추적한다. Ctrl+Alt+Del 은 SendSAS. 서비스↔헬퍼 파이프는 상대 프로세스의 서명·경로를 검증.
- **캡처·인코딩:** DXGI Desktop Duplication + 하드웨어 인코더(동적 로드), 커서 별도 전송, 헤드리스 PC 용 가상 디스플레이(IddCx).
- 파일 전송(워크스페이스 파일 모듈 경유), 다중 모니터 동시 보기, 세션 녹화(선택·고지), 지연 측정 표시.
- macOS(CGEvent·화면 기록 권한)·Linux(XTest/uinput, Wayland 포털) 입력 주입 — 인터페이스만 정의되어 있으며 동작하지 않는다(호스트는 Windows 한정).
- 포터블 프로그램 코드 서명, 데스크톱 앱 자동 업데이트 서명 검증.
- 관리 화면(세션·감사 목록 UI), 기기별 접근 정책(그룹), 세션 최대 시간.
