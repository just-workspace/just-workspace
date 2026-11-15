# 격리 브라우저 (RBI, Remote Browser Isolation)

패치할 수 없거나 인터넷에 직접 내놓기 어려운 내부 웹 자산(이하 "대상")을 **인터넷에서 떼어 내고**,
바깥 사용자는 LAN 안에서 세션마다 새로 띄우는 **일회용 브라우저 컨테이너**의 화면만 받게 하는 모듈이다.

- 인증 전 공격자는 대상에 요청을 보낼 수 없다 — 워크스페이스 로그인 + 관리자 허용 + 세션 소유자 검사 뒤에야 "화면" 이 열린다.
- 사용자 PC 와 대상 사이에 HTTP 가 흐르지 않는다. 사용자 PC 에는 KasmVNC 픽셀 스트림(WebSocket) 또는 미러 어휘만 온다.
- 세션 컨테이너가 뚫려도 갈 곳이 없다 — 호스트 netfilter 가 세션 브리지의 출구를 허용 목록(대상의 80/443 과 명시한 포트)으로만 묶는다.

화면 방식은 대상마다 둘 — **픽셀**(KasmVNC 화면, §1~5)과 **미러**(원격 페이지를 닫힌 어휘로 다시 그림, §6). 미러 대상은 사용자가 세션마다 픽셀로 바꿀 수 있다.

격리 브라우저는 **워크스페이스와 다른 출처**(`RBI_PUBLIC_ORIGIN`, 예: `https://rbi.example.com`)의 단독 전체 화면 앱이다(§7). 워크스페이스 셸 안에는 없다 —
사용자는 그 주소로 바로(또는 사용자 메뉴 "격리 브라우저 열기"), 관리자는 관리 › 격리 브라우저. 대상의 출구 허용 목록은 관리 화면에서 더한 대상으로 **동적으로** 만들어진다(§8).

별도 Kasm Workspaces 설치가 아니라 워크스페이스에 **내장된 기능**이다(`backend/app/rbi`). 설치 단위로는 애드온 구역 "격리 브라우저"(`rbi`)이고,
그 안의 모듈 `rbi` 는 처음에 꺼져 있다 — 구역을 설치한 뒤 관리 › 모듈·플러그인에서 켠다(§5).

**전제**: 전용 출처로 쓸 호스트 이름(`rbi.` 로 시작)과 그 이름의 HTTPS 인증서가 하나 더 필요하다 — 이 문서는 TLS 를 워크스페이스 앞단의
리버스 프록시가 끝내는 구성을 기준으로 쓴다. 앱 서버는 리눅스여야 한다(호스트 iptables·도커 브리지를 쓴다). 세션 하나가 CPU 2개·메모리 2 GB 까지 쓴다.

이 문서의 주소는 모두 예시다 — 워크스페이스 `example.com`, 전용 출처 `rbi.example.com`, 앱 서버 `192.168.10.20`, LAN 게이트웨이 `192.168.10.1`, 대상 `192.168.10.30`.

## 1. 구조

```
[사용자 브라우저]  ─ https://rbi.example.com/rbi/<sid>/ (HTTP + WebSocket) ─►  앞단 리버스 프록시  ─►  ws-nginx(rbi server 블록)
                                                                                             │ auth_request → backend /api/internal/rbi/auth
                                                                                             │   (rbi 세션 쿠키 → 세션 소유자? → 204 + X-Rbi-Upstream, X-Rbi-Authorization)
                                                                                             ▼
                                                   172.28.0.1:<세션포트>  ──DNAT──►  세션 컨테이너 ws-rbi-s-<sid12> : 6901 (KasmVNC, https, basic auth)
                                                   (workspace 브리지 게이트웨이,          │ Chromium(정책 잠금) ─► 대상의 80/443 만 (netfilter)
                                                    ws-nginx 출발지만 통과)               │ 브리지 br-wsrbi (172.31.200.0/24, icc 끔)
backend ── docker.sock ── docker create/start/rm (세션마다)                                 │
ws-rbi-netfilter(host net, NET_ADMIN) ── iptables WS-RBI 체인 ── 하트비트 state.json ──► backend(세션 시작 전 확인)
backend ── 켜진 대상의 출구 ── allow.txt(rbi-allow 볼륨) ──► ws-rbi-netfilter(5초마다 읽고 다시 검사 → 체인 재구성)  (§8)
```

| 조각 | 역할 |
|---|---|
| `backend/app/rbi/policy.py` | Chromium 관리 정책 JSON · kasmvnc.yaml · 컨테이너 env · `docker create` 인자(순수 함수) |
| `backend/app/rbi/docker.py` | docker CLI 어댑터 — 전용 네트워크 보장, create/start/rm, 게시 포트, 컨테이너 안 준비 확인(`docker exec` TCP), 뷰어 수, 하트비트 읽기 |
| `backend/app/rbi/service.py` | 대상 권한(기본 거부) · 세션 시작(fail-closed, 출구가 걸렸는지 확인) · 종료 · reaper · 스트림 인증 · 일회용 값 저장 |
| `backend/app/rbi/site.py` | 전용 출처 — SSO 홉(`/auth/login` · `/rbi-login` · `/auth/callback`) · rbi 세션 쿠키 · 사용자 API 인증 · rbi 호스트 경로 제한(§7) |
| `backend/app/rbi/egress.py` | 대상 출구 검증·이름 고정 · 동적 허용 파일(§8) |
| `backend/app/rbi/router.py` | `/api/rbi/*`, `/api/internal/rbi/auth`, `/api/admin/rbi/*` |
| `nginx/nginx.conf` | rbi server 블록(앱·홉·`/api/rbi/*`·`/rbi/<sid>/…` 만, 나머지 404, 엄격 CSP) · 워크스페이스 쪽 `/rbi-login` |
| `deploy/rbi-netfilter/` | 사이드카 이미지(debian + iptables-nft) + `apply.sh` + 줄 검사 `rbi-allow-check.awk` + 전파 시험 `test-propagation.sh` |
| `docker-compose.yml` | `rbi-netfilter` 서비스(profiles: rbi), `rbi-mirror`(빌드 전용, profiles: rbi-build), `rbi-guard`·`rbi-allow` 볼륨, backend 마운트, frontend-react 3001 |
| `frontend-react/rbi.html` · `src/rbi-app/` · `vite.rbi.config.ts` | 단독 앱(rbi 출처 전용 번들 `dist-rbi`) — 대상 고르기·세션 화면·신뢰 상단 줄 |
| `frontend-react/src/pages/rbi.tsx` · `pages/admin/rbi.tsx` · `composables/useRbi.ts` | 워크스페이스 런처 · 관리 화면 |

### 세션 컨테이너 — 이미지와 라이선스

- `kasmweb/chromium:1.18.0` (Ubuntu 22.04 + Chromium + KasmVNC). 레시피 리포 kasmtech/workspaces-images 는 **MIT**,
  안의 KasmVNC 는 **GPL-2.0**, Chromium BSD-3-Clause. 이미지를 수정·재배포하지 않고 그대로 띄우므로 추가 의무 없음(THIRD_PARTY_LICENSES.md).
- 대안으로 본 linuxserver/chromium(KasmVNC 베이스, GPL-3.0)은 s6 로 **루트로 시작**해 PUID 강등하는 구조라 `--user 1000`·`cap_drop ALL`·읽기 전용 루트가
  어렵다. kasmweb 이미지는 처음부터 uid 1000 이고 보조 서비스를 env 로 끌 수 있어 골랐다.
- 실행 조건(`policy.docker_create_args`): `--user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 2 --memory 2g
  --memory-swap 2g --pids-limit 512 --shm-size 512m --dns 0.0.0.0 --sysctl net.ipv6.conf.all.disable_ipv6=1`, 쓰기는 tmpfs(홈·/tmp·/var/run·/var/log·시작 로그·정책 두 폴더)만.
- 보조 서비스 전부 끔: 오디오(입·출력)·업로드 서버·프린터·스마트카드·웹캠·게임패드·녹화. `KASMVNC_AUTO_RECOVER=false` 라 KasmVNC 가 자동 종료되면 컨테이너도 끝난다.
- 정책 파일 두 개는 `RBI_POLICY_JSON`·`RBI_KASMVNC_YAML` env 로 넘기고 시작 셸이 tmpfs 에 쓴 뒤 이미지 원래 시작 체인을 exec 한다
  (읽기 전용 루트는 start 전에 컨테이너로 파일을 복사해 넣는 것도 거부하고, 백엔드는 컨테이너 안이라 호스트 경로 바인드를 못 쓴다).

### Chromium 잠금(관리 정책, `/etc/chromium/policies/managed/zz-rbi-policy.json`)

`URLBlocklist: ["*"]` + `URLAllowlist: [대상 호스트(:포트), chrome://newtab, about:blank]` — 대상 호스트 말고는 아무 주소도 안 열린다(file://·chrome:// 포함).
확장 전부 차단, 개발자도구 금지(2), 원격 디버깅 금지, 비밀번호 저장·자동완성·로그인·동기화·게스트·새 프로필·방문기록 저장 끔, 시크릿 창 금지,
측정·세이프브라우징·번역·맞춤법·제안·프리페치 끔, 마이크·카메라·화면공유·위치·알림·USB·BT·시리얼·파일시스템 API 차단.
정책 스위치: `DownloadRestrictions`(3=전부 차단 / 0) · `AllowFileSelectionDialogs`(업로드) · `PrintingEnabled`(=다운로드 허용과 같이 — "PDF 로 저장" 이 우회 경로라서).

### KasmVNC 설정(`/etc/kasmvnc/kasmvnc.yaml`)

- 클립보드 DLP: `server_to_client.enabled`(브라우저→내 PC) · `client_to_server.enabled`(내 PC→브라우저). 같은 값을 Xvnc 명령줄(`-SendCutText/-AcceptCutText`, env `KASM_SVC_*_CUT_TEXT`)에도 건다.
- 자동 종료: `no_user_session_timeout`(뷰어 없음) · `inactive_user_session_timeout`(입력 없음) = 유휴 분 × 60. 끝나면 Xvnc 종료 → 컨테이너 종료.
- 기본값 유지: 자가서명 pem, `runtime_configuration.allow_override_list: [pointer.enabled]`.

## 2. 보안 모델

| 경계 | 무엇이 막나 |
|---|---|
| 인터넷 → 대상 | 대상은 인터넷에 공개하지 않는다 — 앞단 프록시·방화벽·공인 DNS 에 대상의 이름·규칙을 두지 않는다(§5). 대상은 LAN 에서만 응답한다 |
| 출처 | 화면·API·스트림은 rbi 전용 출처에서만. 워크스페이스 출처에는 `/rbi/<sid>/` 가 없다 — 세션 컨테이너가 내주는 것(KasmVNC 스크립트·미러 문서)이 워크스페이스 출처에 실리지 않는다. rbi 출처는 워크스페이스 API 를 하나도 열지 않는다(nginx·백엔드 두 겹 404) |
| 인터넷 → 스트림 | `/rbi/<sid>/` 는 매 요청 `auth_request`. sid 는 32hex 난수. **rbi 세션 쿠키**(`__Host-jw_rbi`)의 사용자가 소유자일 때만 204(워크스페이스 세션 쿠키는 받지 않는다). 다른 사용자·익명·끝난 세션 → 403 |
| 스트림 → 컨테이너 | nginx 가 업스트림 주소·basic auth(`kasm_user:<세션별 난수>`)를 **백엔드 응답 헤더**에서 받아 붙인다. 사용자 브라우저는 비밀번호도 주소도 모른다. 쿠키·Authorization 은 컨테이너로 넘기지 않는다(`proxy_set_header Cookie ""`) |
| 세션 컨테이너 → 바깥 | 호스트 iptables `WS-RBI` 체인(DOCKER-USER 맨 앞): ESTABLISHED 통과 · 허용 목록(`RBI_ALLOW` 고정 ∪ 켜진 대상의 동적 출구, §8) NEW 통과 · **나머지 전부 DROP**(인터넷·LAN·다른 도커 브리지·게시 포트 DNAT) + `INPUT -i br-wsrbi DROP`(호스트 자신) + `--dns 0.0.0.0`(이름 풀이 불가) + IPv6 끔 + `enable_icc=false`(세션끼리) |
| 바깥 → 세션 컨테이너 | 6901 은 `172.28.0.1`(workspace 브리지 게이트웨이)에만 게시. `WS-RBI`: ws-nginx(172.28.0.2) 출발지 NEW 만 통과, 그 외 DROP. LAN·다른 컨테이너에서 게시 포트로 가면 DNAT 뒤 FORWARD 에서 DROP(타임아웃으로 보인다) |
| 세션 시작 | 사이드카 하트비트(`/run/rbi-guard/state.json`, 180초 안, 같은 브리지, ok=true)가 아니면 **시작 거부**(503). `RBI_REQUIRE_GUARD=false` 는 시험용 |
| 컨테이너 자체 | 비루트·읽기 전용·cap 없음·no-new-privileges·자원 상한·pids 상한. 홈은 tmpfs 라 세션과 함께 사라진다 |
| 감사 | `rbi.session.start / start_failed / stop / mode`, `rbi.target.create / update / delete`, `rbi.allow.add / remove`(출구 증감), `rbi.site.login`(rbi 출처 로그인) (관리 › 접근 로그) |

권한: 대상마다 `allowed_user_ids`·`allowed_group_ids`. **둘 다 비면 관리자만** 열 수 있다(모듈 grant 의 "비면 전체 허용" 과 반대 — 기본 거부).
모듈 `rbi` 가 꺼져 있으면 사용자 API 전체가 403.

세션 수명: 사용자당 활성 1개, 전체 `RBI_MAX_SESSIONS`. 끝: 사용자 종료 · 관리자 강제 종료 · 유휴(KasmVNC 자동 종료 → `container_exited`, 보조로 reaper 의
"핑 끊김 + 뷰어 0" → `idle`) · 최대 수명(`max_lifetime`) · 오류. reaper(30초, Redis 락으로 한 워커)는 고아 컨테이너(라벨은 있는데 활성 행 없음)도 지운다 —
**이름이 `RBI_CONTAINER_PREFIX` 로 시작하는 것만**(라벨만 보면 같은 호스트의 다른 스택 세션까지 지우게 된다).

유휴: 유휴 타이머는 마지막 입력 기준이다 — 열어만 두고 손대지 않은 세션도 끝나고, 뷰어가 없는 시간도 센다. 컨테이너가 스스로 끝나는 것과 별개로
백엔드 reaper 가 `last_seen`·수명으로 한 번 더 거둔다.

### 알려진 한계·위험

- **Chromium 샌드박스 꺼짐**(`--no-sandbox`, kasm 이미지 기본). 컨테이너 안에서 userns 를 못 쓰기 때문. 브라우저 취약점이 컨테이너 안 코드 실행으로 이어질 수 있지만,
  그 다음이 없다(비루트·읽기 전용·cap 없음·출구 없음·DNS 없음). 필요하면 커스텀 seccomp 로 userns 허용 뒤 `--no-sandbox` 제거를 검토.
- **KasmVNC 자체의 취약점**이 곧 경계다. 이미지 태그를 고정했으니(1.18.0) 주기적으로 태그를 올린다(`RBI_IMAGE`).
- 스트림은 **픽셀**이다 — 화면에 보이는 비밀(콘솔 출력 등)은 당연히 보인다. 클립보드 양방향이 기본이라 문자열 반출은 가능(대상 정책에서 끌 수 있다).
- 업로드 "허용" 은 파일 선택 대화상자만 연다. 독립 KasmVNC 1.18 웹 클라이언트에는 파일 전송 UI 가 없어 픽셀 모드에서 내 PC 의 파일을 컨테이너로 올리는 길은 없다(정책 자리만 둠).
  다운로드 "허용" 은 컨테이너의 `~/Downloads` 가 `/rbi/<sid>/Downloads/` 로 보인다(KasmVNC httpd).
- 세션당 2 CPU/2 GB, 기본 상한 4 세션(`RBI_MAX_SESSIONS`) — 호스트 자원에 맞춰 조정한다. 세션 시작은 2~10초(이미지가 이미 있을 때).
- 호스트 iptables 를 만지는 사이드카가 죽으면(또는 docker 재시작으로 체인이 비면) 새 세션은 막히고, **이미 뜬 세션은 reaper 가 하트비트 만료로 끊지 않는다** —
  사이드카는 멱등 재구성(5초/60초)이라 보통 스스로 복구한다. `docker compose ps rbi-netfilter` 와 관리 화면 "격리 규칙 상태" 를 본다.
- 커널이 br_netfilter 를 올리는 건 도커의 `enable_icc=false` 덕분이다(Docker 29 는 필요할 때만 올린다). 네트워크를 손으로 만들 때 이 옵션을 빼면 세션끼리 통신이 열린다.

## 3. 네트워크 격리 검증

배포한 뒤 격리가 실제로 걸렸는지는 아래로 확인한다. 세션을 하나 띄우고 세션 컨테이너(`ws-rbi-s-<sid12>`) 안에서 `curl -m 5` 를 돌린다
(코드 000 + rc≠0 = 못 감).

| 목적지 | 기대 결과 |
|---|---|
| 대상의 80 · 443 | **응답(rc=0, 닿음)** |
| 인터넷(예: 1.1.1.1:443 · :80) | 000 rc=28(타임아웃) |
| 앱 서버의 LAN 주소(ws-nginx 80 과 다른 게시 포트) | 000 rc=28 |
| 앞단 프록시 · LAN 게이트웨이 · 대상이 아닌 다른 LAN 호스트 | 000 rc=28 |
| 다른 도커 브리지의 컨테이너(ws-nginx 172.28.0.2, ws-backend 등) | 000 rc=28 |
| 세션 브리지 게이트웨이(= 호스트 INPUT, 게시 포트 DNAT 포함) | 000 rc=7 |
| DNS 이름(외부 이름 · 컨테이너 이름) | rc=2(풀이 불가) |

스트림 접근(`GET /rbi/<sid>/`): 소유자 200 · 다른 사용자 403 · 익명 403 · 다른 사용자의 `websockify` 403 · 다른 사용자의 `/api/rbi/sessions/<sid>` 404(존재 자체를 숨김).
LAN 호스트에서 게시 포트 `172.28.0.1:<port>` 직접 → 타임아웃. 다른 컨테이너(nginx 아님)에서 → 타임아웃.

컨테이너(`docker inspect`): `user=1000:1000 ro=true capdrop=[ALL] secopt=[no-new-privileges] cpus=2 mem=2GiB shm=512MiB pids=512 dns=[0.0.0.0]`.

iptables(`docker compose exec rbi-netfilter iptables -S WS-RBI`): established 2 · 허용 목록의 목적지마다 1 · egress DROP · nginx→6901 RETURN · ingress DROP,
그리고 `DOCKER-USER -j WS-RBI`, `INPUT -i <브리지> -j DROP`. 대상 하나(80·443)면 사이드카 로그가 `ok=1 rules=7` 을 찍는다.

유휴: 대상의 유휴 분을 짧게 두고 세션을 열어 둔 채 입력하지 않으면 KasmVNC 가 스스로 끝나 컨테이너가 사라지고, reaper 가 그 세션을 `ended/container_exited` 로 적는다.

## 4. API

사용자(모듈 rbi 켜짐 + 대상 허용). rbi 출처에서는 rbi 세션 쿠키로만, 워크스페이스 출처에서는 워크스페이스 세션으로(런처가 목록만 읽는다).
rbi 출처의 POST·DELETE 는 `Origin` 이 rbi 출처여야 한다(아니면 403).
```
GET    /api/rbi/targets                 → { targets:[{id,key,name,url,host,mode,modes,policy}], sessions:[내 활성 세션], public_origin }
POST   /api/rbi/sessions                {target_id, mode?} → 201 세션 { id, status, mode, stream_url:"/rbi/<id>/", … }   (쿠키를 심지 않는다)
GET    /api/rbi/sessions/me[?recent=1]  (recent: 끝난 것까지 최근 10건) · GET /api/rbi/sessions/{id} · POST …/{id}/ping · DELETE …/{id}
POST   /api/rbi/sessions/{id}/mode      {mode}
```
전용 출처 세션(§7): `GET /auth/login?return=` · `GET /rbi-login?state&return`(워크스페이스) · `GET /auth/callback?code&state` · `GET /api/rbi/site/me` · `POST /api/rbi/site/logout`.
내부(ws-nginx 전용, `/api/internal/` 은 nginx 가 바깥에 404): `GET /api/internal/rbi/auth` (Host=rbi 출처, X-Original-URI, Cookie) → 204 + `X-Rbi-Upstream`, `X-Rbi-Authorization` / 401 / 403.
관리자: `GET /api/admin/rbi`(대상·활성 세션·상태/guard·egress) · `POST /api/admin/rbi/targets` · `PUT|DELETE /api/admin/rbi/targets/{id}`
(`extra_ports`·`force` — §8, 응답에 `egress`·`warnings`) · `GET /api/admin/rbi/sessions` · `DELETE /api/admin/rbi/sessions/{id}`.

스트림 URL 규칙: KasmVNC 클라이언트는 웹소켓을 페이지 경로가 아니라 **출처 루트 기준 `path`** 로 연다. 반드시 `?path=rbi/<sid>/websockify` 를 붙인다(`useRbi.rbiStreamSrc`).

데스크톱·모바일 앱에서의 동작은 §7 "데스크톱·모바일 앱".

## 5. 설정·운영

### 환경변수

전체 표는 [CONFIG.md](CONFIG.md), 예시는 `.env.example` 의 "격리 브라우저 RBI" 묶음.

| 변수 | 기본 | 뜻 |
|---|---|---|
| `RBI_PUBLIC_ORIGIN` | (없음) | 전용 출처(예: `https://rbi.example.com`). 비우면 격리 브라우저를 쓸 수 없다. 호스트는 `rbi.` 로 시작(§7) |
| `RBI_SITE_SESSION_HOURS` | 8 | rbi 출처 세션 수명(시간) |
| `RBI_PROTECTED` | (없음) | 워크스페이스 자신의 주소(앱 서버·LAN 게이트웨이, 예: `192.168.10.20,192.168.10.1`) — 대상으로 거부(§8) |
| `RBI_ALLOW` | (없음) | 고정 허용 목적지(`IP:포트` 쉼표). 보통 비운다(§8) |
| `RBI_ALLOW_CEILING` · `RBI_DENY` | (사설 대역) · (없음) | 동적 출구의 상한 CIDR · 사이드카가 언제나 거부할 CIDR(§8) |
| `RBI_IMAGE` · `RBI_MIRROR_IMAGE` | `kasmweb/chromium:1.18.0` · `localhost/just-workspace-rbi-mirror:latest` | 픽셀·미러 세션 이미지 |
| `RBI_NETWORK` · `RBI_SUBNET` · `RBI_IP_RANGE` · `RBI_BRIDGE` | `ws-rbi` · `172.31.200.0/24` · `172.31.200.128/25` · `br-wsrbi` | 세션 전용 브리지. 백엔드와 사이드카가 같은 값을 봐야 한다 |
| `RBI_PUBLISH_IP` | `172.28.0.1` | 세션의 6901 을 게시할 주소(workspace 브리지 게이트웨이) |
| `RBI_MAX_SESSIONS` | 4 | 동시 세션 상한 |
| `RBI_REQUIRE_GUARD` | true | 사이드카 하트비트가 없으면 세션 시작 거부. 격리 없이 시험할 때만 false |

### 켜기

1. `.env`: `RBI_PUBLIC_ORIGIN=https://rbi.example.com`, `RBI_PROTECTED=<앱 서버 IP>,<LAN 게이트웨이>`, `COMPOSE_PROFILES` 에 `rbi` 추가
   (`JW_ZONES` 를 쓰고 있다면 거기에도 `rbi`). `RBI_ALLOW` 는 비워도 된다(대상은 관리 화면에서 — §8).
2. 앞단 리버스 프록시와 DNS 를 전용 출처에 맞춘다(§7 "앞단 프록시가 해야 할 일").
3. 이미지: `docker pull kasmweb/chromium:1.18.0` (1.3 GB — 첫 세션 때 받으면 45초 안에 못 뜬다), `docker compose build rbi-netfilter`.
   미러 모드를 쓸 거면 §6 "운영" 의 미러 이미지도 굽는다.
4. `docker compose up -d backend frontend-react rbi-netfilter` (backend 는 `rbi-guard`·`rbi-allow` 마운트 때문에 재생성된다).
5. `nginx/nginx.conf` 를 고쳤다면(예: 전용 출처 호스트가 `rbi.` 로 시작하지 않아 `server_name` 을 바꾼 경우) `docker compose restart nginx` —
   파일 하나를 bind 마운트한 것이라 reload 로는 바뀐 내용이 안 들어간다.
6. 관리 › 모듈·플러그인에서 **격리 브라우저** 켜기 → 관리 › 격리 브라우저: "격리 규칙 적용됨" 확인 → 대상 추가(예: 식별자 `lab`, 주소 `http://192.168.10.30`) → 허용 그룹/사용자.
7. 확인: 세션 하나 열어 대상 화면이 보이는지, 관리 화면 "활성 세션" 에 보이는지, 끝내기 뒤 `docker ps` 에 `ws-rbi-s-*` 가 없는지. 격리는 §3 으로 확인한다.

네트워크 `ws-rbi`(브리지 `br-wsrbi`)는 백엔드가 첫 세션 때 `docker network create --subnet 172.31.200.0/24 --ip-range 172.31.200.128/25 --gateway 172.31.200.1
--opt com.docker.network.bridge.name=br-wsrbi --opt com.docker.network.bridge.enable_icc=false` 로 만든다. compose 에 넣지 않는 이유: compose 가 라벨 불일치로 거부한다.

### 대상을 인터넷에서 떼기

격리 브라우저로 옮긴 대상은 직접 공개 경로를 닫아야 의미가 있다.

1. 앞단 리버스 프록시: 대상 이름의 서버 블록을 없앤다(또는 `return 404`). 웹 방화벽(WAF)을 쓰면 자산 목록에서도 뺀다. 인증서 발급 목록에서도 이름을 뺀다.
2. 방화벽: 대상 전용 인바운드 규칙/NAT 이 있으면 끈다(앞단 프록시로 가는 443 은 그대로).
3. DNS: 대상의 공인 레코드를 지운다. LAN 사용자가 직접 써야 하면 내부 DNS 에만 남긴다.
4. 대상 자체: 호스트 방화벽으로 80/443 을 앱 서버(세션 NAT 출발지)와 관리 PC 대역만 허용하면 LAN 안 횡이동도 줄어든다.
5. 사용자 안내: `https://rbi.<도메인>` (또는 워크스페이스 사용자 메뉴 "격리 브라우저 열기") → 워크스페이스 로그인으로 자동 로그인 → 대상.

### 문제 해결

| 증상 | 보기 |
|---|---|
| "격리 규칙이 확인되지 않아 세션을 시작하지 않습니다" | `docker compose logs rbi-netfilter` — `ok=1` 이어야. 브리지가 없으면 첫 세션이 만든다(15초 안에 따라붙음). 하트비트 파일: `docker run --rm -v ws-rbi-guard:/g alpine cat /g/state.json` |
| 세션 503 "KasmVNC 가 45초 안에 듣기 시작하지 않았습니다" | 이미지 미리 pull 했나, 호스트 메모리. `docker logs ws-rbi-s-<sid12>` 는 reaper 가 지우기 전 30초 안에만 |
| 화면이 "서버 연결에 실패했습니다" | 스트림 URL 에 `path=rbi/<sid>/websockify` 가 있나. nginx 로그의 `/rbi/<sid>/websockify` 가 101 인지. 앞단 프록시가 WebSocket 을 넘기는지 |
| 403 | 다른 사용자·만료·끝난 세션. 관리 › 접근 로그의 `rbi.*` |
| 세션이 몇 분 만에 끊김 | 대상의 유휴 분이 짧다 — 뷰어가 없는 시간도 센다(시작 뒤 바로 열지 않으면) |

규칙 걷기(긴급): `docker compose stop rbi-netfilter`(SIGTERM 에 체인·점프 제거) — 뜬 세션은 출구가 열리므로 먼저 `관리 › 격리 브라우저` 에서 강제 종료.

## 6. 미러 모드(DOM 재구성, `mode = mirror`)

픽셀 스트림 대신 **원격 페이지를 닫힌 어휘로 다시 그린다**. 원격 Chromium 의 렌더 결과(상자·글자·벡터·재인코딩 이미지)를 JSON 어휘로 보내고,
사용자 PC 는 그것을 **스크립트 없는** 문서에 절대 위치 요소로 조립한다. 원격 페이지의 HTML·JS·CSS·URL·폰트·원본 이미지 바이트는 사용자 PC 에 오지 않는다.
픽셀보다 글자가 선명하고(내 PC 가 글자를 그림) 입력 반응이 빠르다(로컬 에코). 깨지는 화면이 있으면 사용자가 그 세션만 픽셀로 바꿀 수 있다.

### 구조

```
[사용자 브라우저 — 단독 앱 세션 화면]
  ├ 신뢰 크롬 바(주소 읽기 전용·정책 배지·방식 전환·끝내기·연결/지연) — 우리 React
  ├ <iframe sandbox="allow-same-origin" src=/rbi/<sid>/view>  CSP script-src 'none' — 미러 문서(부모가 contentDocument 를 조립)
  └ WebSocket /rbi/<sid>/mirror  ── 어휘(snapshot·patch·tick·focus·val·clip·notice·dialog…) / 입력(mouse·key·text·comp·paste·scroll…)
        │  ws-nginx: 같은 auth_request(+ 세션 방식↔경로 검사) → 172.28.0.1:<포트> → 세션 컨테이너 6901
        ▼
세션 컨테이너 ws-rbi-s-<sid12> (이미지 just-workspace-rbi-mirror, uid 1000, 읽기 전용, cap 없음)
  mirror-agent(Node 22) ── --remote-debugging-pipe ──► Chromium(헤드리스, 관리 정책) ─► 대상만(netfilter, 픽셀과 같은 브리지·체인)
     · 격리 월드 수집기(MutationObserver·단계 틱: 구조→스타일→기하→글자) → 어휘 변환 → 엄격 검증 → 전송
     · 이미지: 원본 바이트 → sharp(libvips) 디코드 → WebP 재인코딩(메타데이터 제거) → /asset/<sha256>
     · 캔버스·영상·교차 출처 iframe·셰도 DOM·아이콘 폰트: 직렬 스크린샷 큐 → "인셋"(WebP 프레임)
     · 입력: CDP Input.*(IME 는 imeSetComposition/insertText), 하나의 잠금으로 입력과 수집 순서를 고정(iseq)
```

| 조각 | 역할 |
|---|---|
| `rbi/mirror/protocol/vocab.ts` | 어휘 v1 정의·`LIMITS`·검증기(클라이언트는 엄격 `validateServerMsg`, 에이전트는 관대 `validateNode` 로 정리) |
| `rbi/mirror/agent/src/*` | 수집기(`collector`)·변환(`convert`·`background`·`fonts`·`raster`)·스크린샷 큐(`capture-queue`)·인셋·입력·세션·HTTP/WS 서버·상한 |
| `rbi/mirror/client/src/*` | 미러 클라이언트(문서 조립·로컬 에코·IME·검증) — `scripts/sync-client.mjs` 가 `frontend-react/src/lib/rbiMirror/` 로 복사(손대지 말 것) |
| `rbi/mirror/fonts/build_fonts.py` · `Dockerfile` | 고정 폰트 묶음(데비안 Liberation2·DejaVu·Noto CJK → WOFF2 168개, KS X 1001 상용/희귀/한자 unicode-range 조각) · 세션 이미지(stage build·fonts·base·dev·prod) |
| `backend/app/rbi/policy.py` | `mirror_chromium_policy`·`mirror_agent_policy`·`mirror_container_env`·`mirror_docker_create_args` |
| `backend/app/rbi/service.py` | 대상·세션 `mode`, `allowed_modes`, `switch_mode`, `path_allowed`(미러 세션은 미러 경로만, 픽셀 세션은 그 밖만) |
| `nginx/nginx.conf` | `/rbi/<sid>/(view|mirror|asset/…|font/…|download/…)` GET 전용 · `/rbi/<sid>/upload/<id>` POST 전용(50m) |
| `frontend-react/src/components/rbi/RbiMirrorView.tsx` · `pages/admin/rbi.tsx` | 뷰어·신뢰 크롬 바 · 관리 화면 "화면 방식" |

### 보안 모델(픽셀 모드에 더해)

| 경계 | 무엇이 막나 |
|---|---|
| 원격 코드 → 내 PC | 미러 문서는 `script-src 'none'`·`sandbox allow-same-origin`(스크립트·폼·팝업 불가)·`default-src 'none'`. img/font 는 **이 세션의 `asset/`·`font/` 경로만**(Host + `X-Rbi-Prefix` 로 좁힘). 부모(우리 앱)가 만드는 요소는 `div`/`span`/`img`/`svg` 몇 종과 고정 속성뿐 — `on*`·`href`·`src` 에 원격 문자열이 들어가지 않는다 |
| 어휘 | 서버 메시지는 클라이언트가 **엄격 검증**(타입·범위·정규식: 색·경로 d·transform·그림자·그라디언트, `url()` 없음, 양방향 제어문자 제거). 하나라도 틀리면 그 메시지를 버리고 재동기화 |
| 이미지 | 원본 바이트를 그대로 넘기지 않는다 — 디코드 후 WebP 재인코딩(EXIF/ICC/XMP 제거, 폴리글랏 무력화). SVG 는 래스터(버퍼 입력, 외부 참조 안 따라감) |
| 폰트 | 원격 웹폰트는 넘기지 않는다. 계산된 글꼴을 고정 묶음의 키(lsans·lserif·lmono·dsans·dserif·dmono·cjks·cjkm·cjkr)로 바꿔 보낸다. 아이콘 폰트(PUA 문자·아이콘 패밀리)는 인셋 그림 |
| 비밀번호 | 값은 수집기 밖으로 나가지 않는다(길이만 → 점으로 표시) |
| 정책 게이트(에이전트가 강제) | `MIRROR_POLICY` `{ci, co, dl, ul}` — 붙여넣기(내 PC→원격)·복사(원격→내 PC, 미러 선택 복사 포함: 꺼지면 문서 전체 `user-select:none`)·다운로드(`/download/<id>`, attachment+octet-stream+nosniff)·업로드(파일 선택 대화상자가 열렸을 때만 일회 id). 막히면 신뢰 바에 알림 |
| 상한(세션마다) | 클라→서버 메시지 64KB(넘으면 1009 로 그 연결만 끊음 — 세션은 유지)·초당 400(버스트 1200, 넘는 것은 버림)·붙여넣기 조각 16000자/전체 200000자·업로드 50MB·노드 40000(넘으면 잘라 보내고 "픽셀 모드 권고")·서버→클라 초당 240 |
| 이동 | URL 허용목록은 Chromium 정책(픽셀과 같음). 막힌 이동·팝업은 에이전트가 신뢰 바에 알린다. alert/confirm/prompt 는 원격 대화상자가 아니라 우리 대화상자로 |
| 경로 섞임 | 백엔드 auth 가 세션 방식과 경로를 맞춘다 — 픽셀 세션으로 `/view` 를, 미러 세션으로 KasmVNC 경로를 열 수 없다(403) |
| 컨테이너 | 픽셀과 같은 잠금(`--user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges`, cpus·memory·pids 512·`--dns 0.0.0.0`·IPv6 끔, tmpfs 는 /tmp·홈·정책 폴더만). KasmVNC 없음 |

Chromium 정책은 픽셀 모드 것에서 **세 개만** 다르다: `RemoteDebuggingAllowed: true`(에이전트가 파이프로 붙는다 — 포트는 열지 않는다),
`DeveloperToolsAvailability: 1`(2 면 CDP 가 페이지 타깃에 못 붙는다, 헤드리스라 UI 를 열 사람이 없다), `DownloadDirectory: /home/node/Downloads`.

알려진 한계(미러 → 사용자가 픽셀로 바꾸면 해결되는 것 포함):
셰도 DOM·교차 출처 iframe·캔버스·영상/오디오는 인셋(그림)이다 · 정적 스크롤 상자 안의 absolute 자식은 위치가 어긋날 수 있다 · 쌓임 순서·의사 요소 글자 위치는 근사 ·
KS X 1001 밖 한자는 묶음에 없다(대체 글꼴) · 양방향 제어문자는 지운다 · Windows(DirectWrite)와 리눅스(FreeType) 래스터 차이로 픽셀 단위 일치는 아니다(글자 폭은 같다) ·
차단 이벤트는 신뢰 바 알림뿐, 백엔드 감사 로그로는 안 간다 · 한 세션에 뷰어 하나 · 캔버스 기반 HTML5 콘솔 화면은 인셋(약 15fps)이다.

### API(추가)

```
POST /api/rbi/sessions            {target_id, mode?}   mode=pixel 은 mirror 대상의 폴백(pixel 대상에 mirror 는 400)
POST /api/rbi/sessions/{id}/mode  {mode}               방식 바꾸기 — 지금 세션을 끝내고 같은 대상으로 새로(원격 로그인 상태는 이어지지 않음). 감사 rbi.session.mode
POST /api/admin/rbi/targets · PUT …/{id}   {…, mode: "pixel"|"mirror"}
```
세션 응답에 `mode`, 대상 응답에 `mode`·`modes`(열 수 있는 방식). 미러 세션의 스트림 경로: `/rbi/<sid>/view`(문서) · `/rbi/<sid>/mirror`(WS) · `asset/<sha256>` · `font/<file>.woff2` · `download/<id32>` · `upload/<id32>`.

### 운영

켜기(픽셀 모드 §5 를 이미 했다는 전제):
1. 이미지: `docker compose --profile rbi-build build rbi-mirror` (또는 `sh rbi/mirror/build-image.sh`) → `localhost/just-workspace-rbi-mirror:latest`(약 1.6 GB).
   다른 이름이면 `.env` 에 `RBI_MIRROR_IMAGE`. compose 의 `rbi-mirror` 항목은 빌드 전용(entrypoint `true`, 네트워크 없음) — `up` 하지 않는다.
2. 업로드를 허용할 대상이면 앞단 리버스 프록시의 `client_max_body_size` 가 50m 이상인지 확인한다.
3. 관리 › 격리 브라우저 › 대상 편집 → **화면 방식: 미러** → 저장. 다음 세션부터 적용(뜬 세션은 그대로).
4. 확인: 세션 열기 → 신뢰 바 "연결됨" · 글자가 선명한지 · 한글 입력 · `docker ps` 의 `ws-rbi-s-*` 가 `just-workspace-rbi-mirror` 인지 · 끝내기 뒤 사라지는지.

이미지 갱신: Chromium·폰트·베이스는 Dockerfile `ARG` 로 고정(`NODE_IMAGE` 다이제스트, `CHROMIUM_VERSION`, `FONTS_*`, `IPROUTE2`, `CA_CERTS`).
데비안 보안 갱신으로 옛 버전이 저장소에서 빠지면 빌드가 실패한다 — `apt-cache policy chromium` 으로 새 버전을 보고 `BUILD_ARGS="--build-arg CHROMIUM_VERSION=…"` 로 다시 굽는다.
Chromium 은 **보안 갱신마다** 올린다(세션 브라우저가 경계다). 폰트 버전을 바꾸면 글자 폭이 바뀔 수 있으니 미러 화면을 한 번 본다.

유휴: 에이전트가 뷰어 없음/입력 없음이 `MIRROR_IDLE_SECONDS`(= 대상 유휴 분 × 60, 최소 60)를 넘으면 끝나고 컨테이너도 끝난다 → reaper 가 `ended/container_exited`.

되돌리기:
- 대상 하나: 관리 화면에서 화면 방식을 **픽셀**로 — 다음 세션부터 KasmVNC. 사용자도 신뢰 바의 "픽셀 모드로 전환" 으로 그 세션만 바꿀 수 있다.
- 기능 전체: 모든 대상을 픽셀로 두면 미러 경로·이미지는 쓰이지 않는다(nginx 미러 location 은 미러 세션이 아니면 403).

문제 해결:

| 증상 | 보기 |
|---|---|
| 세션 503 "45초 안에 듣기 시작하지 않았습니다" | 미러 이미지가 있나(`docker image ls just-workspace-rbi-mirror`), `RBI_MIRROR_IMAGE` 이름 |
| 화면이 흰색·"연결 중" 에서 멈춤 | 브라우저 개발자도구에서 `/rbi/<sid>/mirror` 가 101 인지, `docker logs ws-rbi-s-<sid12>` 의 `listening :6901`·`fonts: 168 faces` |
| 글자가 겹치거나 굵게 보임 | 폰트 묶음 누락(`fonts: 0 faces`) — 이미지를 prod 타깃으로 다시 굽는다 |
| 특정 화면이 깨짐 | 신뢰 바 "픽셀 모드로 전환"(그 세션만). 반복되면 대상 방식을 픽셀로 |
| 한글 이름 파일 올리기가 조용히 실패 | 컨테이너 env `LANG=C.UTF-8`(이미지·env 두 겹) |
| 붙여넣기·복사·다운로드가 "정책으로 막힘" | 대상의 클립보드·다운로드·업로드 설정(정상 동작) |

## 7. 전용 출처(`RBI_PUBLIC_ORIGIN`)

격리 브라우저는 워크스페이스(예: `example.com`)와 **다른 출처**(예: `https://rbi.example.com`)의 단독 전체 화면 앱이다.

### 왜

세션 화면은 세션 컨테이너가 내주는 것을 우리 출처에 싣는다 — 픽셀 모드는 KasmVNC 클라이언트 스크립트(`allow-scripts allow-same-origin` iframe),
미러 모드는 원격 페이지에서 만든 문서. 이게 워크스페이스 출처에 있으면, 세션 컨테이너가 뚫려 그 응답을 바꿀 수 있을 때 워크스페이스
쿠키·API 와 같은 출처가 된다. 출처를 떼면 최악의 경우도 rbi 출처(격리 브라우저 기능)에 갇힌다.

### 구조

```
https://rbi.example.com ─► 앞단 리버스 프록시 location / → http://<앱 서버>:80 (Host $host) ─► ws-nginx  server_name ~^rbi\.
   /  · /assets/* · /icon.svg      → frontend-react:3001  (dist-rbi — 단독 앱 번들만. 워크스페이스 셸·화면·모듈 없음)
   /auth/login · /auth/callback    → backend /api/rbi/site/login · /callback   (SSO 홉 rbi 쪽)
   /api/rbi/*                      → backend (rbi 세션 쿠키로만 인증)
   /rbi/<sid>/…                    → auth_request → 세션 컨테이너(픽셀 KasmVNC · 미러 mirror-agent)
   그 밖 전부                      → 404 (워크스페이스 API·/oauth·/ws·/dav·/git·내부 API)   + 백엔드 RbiHostGuard 가 같은 목록으로 한 번 더
https://example.com
   /rbi-login                      → backend /api/rbi/site/sso   (SSO 홉 워크스페이스 쪽)
   /rbi                            → 런처(새 탭으로 rbi 출처, 대상 딥 링크 ?target=<key>) — 레일·모바일 탭·팔레트에는 없다
   /rbi/<sid>/                     → 없음(스트림 경로 없음 — SPA 404)
   /admin/rbi                      → 관리(관리 메뉴의 "격리 브라우저" 묶음)
```

### SSO 홉

```
브라우저(rbi)              rbi 백엔드                          워크스페이스                         Redis
GET /?target=lab   ─► 앱: GET /api/rbi/site/me → 401
GET /auth/login?return=/?target=lab
                    ─► state=난수(24B) · Set-Cookie __Host-jw_rbi_state={state,return}(서명·Lax·HttpOnly·10분)
                       302 https://example.com/rbi-login?state&return
                                                    ─► 워크스페이스 세션? 없으면 302 /login?redirect=/rbi-login?… (로그인·2단계 인증 뒤 되돌아옴)
                                                       모듈 rbi 켜짐? → code=난수(32B)  ───────────────────► SET rbi:sso:<code> {uid, wsid, tv, state} EX 60 NX
                                                       302 <RBI_PUBLIC_ORIGIN>/auth/callback?code&state   (목적지는 설정값 — 쿼리로 못 바꾼다)
GET /auth/callback?code&state
                    ─► state 쿠키 서명·10분 · 쿠키 state == 쿼리 state
                       GETDEL rbi:sso:<code> ─────────────────────────────────────────────────────────────────► (한 번만)
                       코드의 state == state · 사용자 활성 · tv 같음 · 워크스페이스 sid 살아 있음
                       rsid=난수 → SET rbi:site:<rsid> {uid, wsid, tv, created, ip} EX 8h
                       Set-Cookie __Host-jw_rbi=<서명{rsid,uid}>; Secure; HttpOnly; SameSite=Strict; Path=/   · state 쿠키 지움
                       302 return(rbi 출처 안 경로만) · 감사 rbi.site.login
```
실패하면 `/?sso_error=state|code|user|store` 로 돌아오고, 앱은 사유와 [다시 로그인] 만 보인다(자동 재시도 고리 없음).

### 보안 결정

| 항목 | 결정 |
|---|---|
| rbi 세션 쿠키 | `__Host-jw_rbi` — Secure·HttpOnly·Path=/·Domain 없음(host-only, 하위 도메인이 덮어쓰지 못함)·**SameSite=Strict**(rbi 페이지 자신의 요청에만). 값은 `{rsid, uid}` 를 **워크스페이스와 다른 salt** 로 서명 — 워크스페이스 세션으로 내밀면 서명부터 틀린다(쿠키·Bearer 둘 다 401) |
| 워크스페이스 쿠키 | host-only 라 rbi 로 오지 않고, 와도 rbi 출처는 보지 않는다(쿠키·Bearer 무시) |
| state(로그인 CSRF) | 홉 전 쿠키(`__Host-jw_rbi_state`, Lax — 다른 사이트에서 시작한 홉도 돌아올 수 있게) == 쿼리 == 코드에 묶인 값. 다른 브라우저가 받은 코드는 못 쓴다 |
| 코드 | 32B 난수 · 60초 · `GETDEL` 한 번만 · 사용자·워크스페이스 sid·tv·state 묶음 |
| 열린 리디렉트 | 홉 목적지는 `RBI_PUBLIC_ORIGIN` 설정값 고정. `return` 은 rbi 출처 안 상대 경로만(절대 URL 은 같은 출처일 때만 경로로, `//`·`\`·제어문자·`/auth/` 거부 → `/`) |
| 같은 사이트 CSRF | `example.com` 과 `rbi.example.com` 은 같은 사이트라 SameSite 로는 못 막는다 → rbi 출처의 POST·DELETE 는 `Origin == RBI_PUBLIC_ORIGIN` 아니면 403(워크스페이스 페이지에서 보낸 no-cors POST 무효) |
| 로그아웃 | rbi 로그아웃은 rbi 세션만(레코드·쿠키), 열린 격리 세션은 앱이 먼저 끝낸다. 워크스페이스 로그아웃·기기 세션 취소·강제 로그아웃(token_version) → rbi 세션이 매 요청 보는 **에포크**(워크스페이스 sid 생존·tv)로 바로 끝. 워크스페이스 Redis 장애면 그쪽처럼 통과(fail-open), rbi 세션 저장소 장애면 거부(fail-closed) |
| 출처 CSP | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss://$host; frame-src 'self'; … frame-ancestors 'none'` — 제3자 없음, `unsafe-inline` 없음. 번들은 글꼴을 data: 로 넣지 않는다(`assetsInlineLimit 0`). XFO DENY · Referrer-Policy no-referrer · COOP/CORP same-origin · Permissions-Policy 전부 끔(클립보드만 self). 스트림 location 은 자기 헤더(미러 view 의 CSP 는 에이전트 nonce, 픽셀은 `frame-ancestors 'self'`), 세션 컨테이너의 `Set-Cookie` 는 버린다 |
| 번들 격리 | `vite.rbi.config.ts` 가 `src/pages|layouts|router|plugins`, 셸 컴포넌트, vue·livekit·tiptap·yjs·shiki·chart.js 가 섞이면 빌드 실패(`rbi-bundle-guard.ts`). i18n 은 `rbi`·`common`·`ui` 만 |
| 단독 앱 키보드 | 세션이 열리면 포커스는 격리 화면(미러: 숨은 입력칸, 픽셀: iframe). `Ctrl+Alt+B`(물리 키 B) → 신뢰 상단 줄(원격으로 보내지 않음 — 앱 문서와 픽셀 iframe 창 둘 다 capture 단계), 줄에서 `Esc` → 격리 화면 |
| 딥 링크 | `?target=<key>` 는 대상을 미리 고를 뿐 — 링크만으로 컨테이너를 띄우지 않는다 |
| 워크스페이스 `/rbi/<sid>/` | 없다. 세션 화면은 rbi 출처에서만 열린다 |

### 데스크톱·모바일 앱

- 데스크톱(Electron): 웹뷰의 `window.open` → `shell.openExternal`, 워크스페이스 밖 최상위 이동 → 막고 `openExternal`. 런처·사용자 메뉴가 여는 rbi 출처는 **시스템 브라우저**에서 열리고,
  거기서 홉(브라우저의 워크스페이스 로그인)을 탄다. 앱 웹뷰 안에는 격리 화면이 실리지 않는다.
- 모바일(Capacitor): `allowNavigation: ['*']` 라 웹뷰 안에서 열릴 수 있다. 앱 웹뷰에는 워크스페이스 쿠키 대신 Bearer 를 쓰는 경우가 있어 홉의 워크스페이스 로그인이 다시 뜰 수 있다 — 위험으로 남김.

### 앞단 프록시가 해야 할 일

ws-nginx 는 80 에서 평문으로 듣는다. TLS 는 앞단 리버스 프록시가 끝낸다.

1. DNS: 전용 출처 이름(예: `rbi.example.com`)을 워크스페이스와 같은 공인 IP 로. 인증서도 이 이름으로 받는다.
2. 그 이름의 443 서버 블록에서 전부 ws-nginx 로 넘긴다. nginx 라면(예시 — `<앱 서버>` 는 ws-nginx 가 게시된 주소):
   ```nginx
       client_max_body_size 50m;          # 미러 올리기 한 파일 상한과 같게
       location / {
           proxy_pass http://<앱 서버>:80;
           proxy_request_buffering off;
           proxy_http_version 1.1;
           proxy_set_header Host $host;                      # ws-nginx 가 Host 로 rbi server 블록을 고른다
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $remote_addr;    # 이어 붙이지 않고 덮어쓴다
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header Upgrade $http_upgrade;           # WebSocket(KasmVNC · 미러)
           proxy_set_header Connection $connection_upgrade;  # http 레벨 map: $http_upgrade → upgrade / close
           proxy_buffering off;
           proxy_read_timeout 86400s;
           proxy_send_timeout 86400s;
           proxy_connect_timeout 10s;
       }
   ```
3. 앞단에 웹 방화벽(WAF)을 둔다면 이 출처는 웹소켓과 큰 바이너리 프레임이 많다는 점을 감안해 적용 여부를 정한다.
4. `.env` 의 `RBI_PUBLIC_ORIGIN`·`RBI_PROTECTED` 를 넣고 §5 "켜기" 대로 올린다.

확인:
- `docker run --rm -v ws-rbi-allow:/a alpine cat /a/allow.txt` → 켜진 대상의 `IP:80`·`IP:443`
- `docker run --rm -v ws-rbi-guard:/g alpine cat /g/state.json` → `"ok":true`, `allow` 에 위 줄, `rejected:[]`
- 관리 › 격리 브라우저 "격리 규칙 상태" — 대기 없음, 전용 출처 표시
- 브라우저 `https://rbi.example.com` → 워크스페이스 로그인(이미 로그인이면 바로) → 대상 → 세션
- `https://rbi.example.com/api/auth/me` → 404, `https://example.com/rbi/<sid>/view` → 세션으로 안 감

`RBI_PUBLIC_ORIGIN` 을 비우면 격리 브라우저 화면이 열리지 않는다(런처가 "설정 필요" 를 보인다) — 워크스페이스 출처에서 스트림을 여는 방식은 없다.

### 알려진 위험

- 픽셀 모드의 KasmVNC 클라이언트 스크립트는 rbi 출처에서 돈다(같은 출처 iframe). 세션 컨테이너가 뚫려 그 스크립트를 바꾸면 rbi 출처 API(대상 목록·세션 시작/끝)를
  사용자 이름으로 부를 수 있다 — 워크스페이스로는 못 넘어간다(출처 분리의 목적). 미러 모드는 스크립트가 없다.
- `server_name ~^rbi\.` — RBI_PUBLIC_ORIGIN 의 호스트가 `rbi.` 로 시작하지 않으면 nginx.conf 를 고쳐야 한다. 다른 `rbi.*` 이름으로 와도 백엔드는 rbi 출처로 보지 않아(Host 비교) 인증·스트림이 모두 거부된다.
- rbi 세션은 워크스페이스 세션을 "만지지" 않는다 — 워크스페이스 유휴 로그아웃 정책은 rbi 사용을 활동으로 세지 않는다(8시간 상한).
- 모바일 앱 웹뷰(위).

## 8. 동적 출구 허용 목록

관리 › 격리 브라우저에서 대상을 더하면 `.env` 수정·재시작 없이 netfilter 가 따라온다.

```
관리자 저장 ─► egress.compute_egress(검증 · 이름 → IPv4 고정) ─► rbi_targets.egress
            ─► allow.txt(ws-rbi-allow 볼륨, 백엔드만 씀, 원자적·바뀔 때만)  + 감사 rbi.allow.add/remove
ws-rbi-netfilter ─ RBI_POLL(5초)마다 읽기 ─ 줄마다 재검사(rbi-allow-check.awk) ─► 체인 재구성(목록이 바뀔 때만) ─► state.json(allow·rejected·allow_rev)
세션 시작 ─ 이 대상의 출구가 state.json allow 에 실제로 있나(최대 15초 대기) ─ 아니면 503(이유)
```

| 검증(대상 저장 — 백엔드) | |
|---|---|
| 호스트 | 사설/LAN IP 또는 이름. 이름은 저장할 때 IPv4 로 풀어 **고정**(규칙과 세션 컨테이너 `--add-host 이름:IP` — 세션은 DNS 가 없다). 못 풀면 거부. IPv6 거부 |
| 상한 | `RBI_ALLOW_CEILING`(비면 사설 대역) 밖 → 거부(강제 불가 — 공인 주소는 안 된다) |
| 금지 | 루프백·링크로컬·멀티캐스트, 이 호스트의 **도커 네트워크 대역 전부**(ws-* 컨테이너·세션 대역) → 거부(강제 불가) |
| 워크스페이스 자신 | `RBI_PROTECTED`(앱 서버·게이트웨이) + APP_URL·RBI_PUBLIC_ORIGIN 이 풀리는 IP(= 앞단 프록시) → 거부, 관리자가 **강제**하면 경고 토스트와 함께 허용(`force` 줄, 감사 `forced`) |
| 포트 | 80·443 + 대상에 명시한 `extra_ports` 만. 포트를 안 적은 호스트는 80·443 둘 다 |
| 주소만 바꿈 | 예전 주소의 호스트를 허용 호스트에서 뺀다(Chromium 허용·출구에 옛 호스트가 남지 않게) |

| 사이드카 재검사(파일 줄) | |
|---|---|
| 형식 | `IPv4:포트[ force]  # 주석` — 아니면 `format` |
| 금지 | 루프백·링크로컬·멀티캐스트·세션 대역·이 호스트의 `docker0`/`br-*` 대역·`RBI_DENY` → `denied` |
| 상한 | `RBI_ALLOW_CEILING`(비면 사설 대역) 밖 → `outside-ceiling` |
| 자기 주소 | 이 호스트의 IP·기본 게이트웨이는 `force` 줄만 → 아니면 `self-needs-force` |

`RBI_ALLOW` 는 **고정 허용**으로 남는다(검사 없이 늘 허용 — 운영자가 .env 에 적은 것). 상한은 `RBI_ALLOW_CEILING`.
볼륨을 둘로 나눈 이유: 사이드카는 host 네트워크라 내부 HTTP 엔드포인트를 쓰려면 새 노출면이 생긴다. `rbi-allow`(백엔드 → 사이드카 ro)·`rbi-guard`(사이드카 → 백엔드 ro)로
방향을 나누면 백엔드는 하트비트를 위조할 수 없고, 사이드카는 백엔드가 쓴 줄을 믿지 않는다.

관리 화면 "격리 규칙 상태": 하트비트(나이) · 지금 걸린 목록 · 대상이 원하는 출구 · 아직 안 걸린 것(사이드카 대기) · 사이드카가 거부한 줄(이유) · 고정 허용 · 상한·보호 주소 · 전용 출처.

사이드카가 파일을 읽어 체인에 거는 과정은 전파 시험 `deploy/rbi-netfilter/test-propagation.sh` 가 본다(§9).

## 9. 시험

- backend pytest: `test_rbi.py`(대상·세션·정책) · `test_rbi_site.py`(홉·쿠키·리디렉트·CSRF·호스트 제한) · `test_rbi_egress.py`(검증 거부·강제·이름 고정·API→파일→감사·세션 대기)
- frontend vitest: 단독 앱 · 런처/내비/번들 격리 · 관리 화면
- nginx: `nginx -t`
- 사이드카 전파(`deploy/rbi-netfilter/test-propagation.sh`, 별도 체인·브리지 이름의 임시 컨테이너): 대상 추가 → 2초 안에 규칙 + 세션 대역에서 실제 연결 · 금지 줄 5종 거부(이유) · 제거 → 2초 안에 규칙 소멸 + 차단 · 종료 시 체인·점프 정리
- 미러: 단위 시험 `rbi/mirror/test/`(어휘 검증·수집·변환·로컬 에코), 시험 페이지 `rbi/mirror/devpages/`(세션 이미지의 `dev` 타깃에만 들어간다)

사이드카 시험은 운영과 다른 체인·브리지 이름을 쓴다. `apply.sh` 는 `RBI_TEST_STACK=1` 이면 운영 이름(`WS-RBI`·`br-wsrbi`)을 거부하고,
인자를 받지 않으며, `RBI_CHAIN` 이 없으면 시작하지 않는다(exit 64, 운영 compose 는 `WS-RBI` 를 준다) — 시험이 운영 체인을 건드릴 수 없다.
