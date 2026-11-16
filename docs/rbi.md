# 격리 브라우저 (RBI, Remote Browser Isolation)

패치가 불가능하거나 인터넷에 직접 공개하기 곤란한 내부 웹 자산(이하 "대상")을 **인터넷에서 분리하고**,
외부 사용자에게는 LAN 내부에서 세션마다 신규 기동하는 **일회용 브라우저 컨테이너**의 화면만 제공하는 모듈이다.

- 인증 전의 공격자는 대상에 요청을 전송할 수 없다 — 워크스페이스 로그인 + 관리자 허용 + 세션 소유자 검사를 통과한 후에만 "화면" 이 제공된다.
- 사용자 PC 와 대상 간에는 HTTP 통신이 발생하지 않는다. 사용자 PC 에는 KasmVNC 픽셀 스트림(WebSocket) 또는 미러 어휘만 전달된다.
- 세션 컨테이너가 침해되더라도 도달 가능한 경로가 없다 — 호스트 netfilter 가 세션 브리지의 출구(egress)를 허용 목록(대상의 80/443 과 명시한 포트)으로 제한한다.

화면 방식은 대상별로 두 가지를 지원한다 — **픽셀**(KasmVNC 화면, §1~5)과 **미러**(원격 페이지를 폐쇄형 어휘로 재구성, §6). 미러 대상은 사용자가 세션 단위로 픽셀 방식으로 전환할 수 있다.

격리 브라우저는 **워크스페이스와 다른 출처**(`RBI_PUBLIC_ORIGIN`, 예: `https://rbi.example.com`)의 단독 전체 화면 앱이다(§7). 워크스페이스 셸에는 포함되지 않는다 —
사용자는 해당 주소로 직접 접속하고(또는 사용자 메뉴 "격리 브라우저 열기"), 관리자는 관리 › 격리 브라우저에서 관리한다. 대상의 출구 허용 목록은 관리 화면에서 추가한 대상을 기준으로 **동적으로** 생성된다(§8).

별도의 Kasm Workspaces 설치가 아닌 워크스페이스의 **내장 기능**이다(`backend/app/rbi`). 설치 단위는 애드온 구역 "격리 브라우저"(`rbi`)이며,
해당 구역의 모듈 `rbi` 는 초기 상태가 비활성이다 — 구역 설치 후 관리 › 모듈·플러그인에서 활성화한다(§5).

**전제 조건**: 전용 출처로 사용할 호스트 이름(`rbi.` 로 시작)과 해당 이름의 HTTPS 인증서가 추가로 필요하다 — 본 문서는 워크스페이스 전단의
리버스 프록시(프런트 프록시)가 TLS 를 종단하는 구성을 기준으로 기술한다. 앱 서버는 리눅스여야 한다(호스트 iptables·도커 브리지 사용). 세션 1개당 CPU 2개·메모리 2 GB 까지 사용한다.

본 문서의 주소는 모두 예시다 — 워크스페이스 `example.com`, 전용 출처 `rbi.example.com`, 앱 서버 `192.168.10.20`, LAN 게이트웨이 `192.168.10.1`, 대상 `192.168.10.30`.

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

| 구성 요소 | 역할 |
|---|---|
| `backend/app/rbi/policy.py` | Chromium 관리 정책 JSON · kasmvnc.yaml · 컨테이너 env · `docker create` 인자(순수 함수) |
| `backend/app/rbi/docker.py` | docker CLI 어댑터 — 전용 네트워크 보장, create/start/rm, 게시 포트, 컨테이너 내부 준비 상태 확인(`docker exec` TCP), 뷰어 수, 하트비트 조회 |
| `backend/app/rbi/service.py` | 대상 권한(기본 거부) · 세션 시작(fail-closed, 출구 규칙 적용 여부 확인) · 종료 · reaper · 스트림 인증 · 일회용 값 저장 |
| `backend/app/rbi/site.py` | 전용 출처 — SSO 홉(`/auth/login` · `/rbi-login` · `/auth/callback`) · rbi 세션 쿠키 · 사용자 API 인증 · rbi 호스트 경로 제한(§7) |
| `backend/app/rbi/egress.py` | 대상 출구 검증·이름 고정(pinning) · 동적 허용 파일(§8) |
| `backend/app/rbi/router.py` | `/api/rbi/*`, `/api/internal/rbi/auth`, `/api/admin/rbi/*` |
| `nginx/nginx.conf` | rbi server 블록(앱·홉·`/api/rbi/*`·`/rbi/<sid>/…` 한정, 그 외 404, 엄격 CSP) · 워크스페이스 측 `/rbi-login` |
| `deploy/rbi-netfilter/` | 사이드카 이미지(debian + iptables-nft) + `apply.sh` + 행 단위 검사 `rbi-allow-check.awk` + 전파 시험 `test-propagation.sh` |
| `docker-compose.yml` | `rbi-netfilter` 서비스(profiles: rbi), `rbi-mirror`(빌드 전용, profiles: rbi-build), `rbi-guard`·`rbi-allow` 볼륨, backend 마운트, frontend-react 3001 |
| `frontend-react/rbi.html` · `src/rbi-app/` · `vite.rbi.config.ts` | 단독 앱(rbi 출처 전용 번들 `dist-rbi`) — 대상 선택·세션 화면·신뢰 상단 바 |
| `frontend-react/src/pages/rbi.tsx` · `pages/admin/rbi.tsx` · `composables/useRbi.ts` | 워크스페이스 런처 · 관리 화면 |

### 세션 컨테이너 — 이미지와 라이선스

- `kasmweb/chromium:1.18.0` (Ubuntu 22.04 + Chromium + KasmVNC). 레시피 리포 kasmtech/workspaces-images 는 **MIT**,
  내장 KasmVNC 는 **GPL-2.0**, Chromium 은 BSD-3-Clause 다. 이미지를 수정·재배포하지 않고 원본 그대로 실행하므로 추가 의무는 발생하지 않는다(THIRD_PARTY_LICENSES.md).
- 대안으로 검토한 linuxserver/chromium(KasmVNC 베이스, GPL-3.0)은 s6 가 **루트 권한으로 기동**한 후 PUID 로 권한을 강등하는 구조이므로 `--user 1000`·`cap_drop ALL`·읽기 전용 루트의 적용이
  곤란하다. kasmweb 이미지는 초기부터 uid 1000 으로 동작하며 보조 서비스를 env 로 비활성화할 수 있어 채택하였다.
- 실행 조건(`policy.docker_create_args`): `--user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 2 --memory 2g
  --memory-swap 2g --pids-limit 512 --shm-size 512m --dns 0.0.0.0 --sysctl net.ipv6.conf.all.disable_ipv6=1`, 쓰기는 tmpfs(홈·/tmp·/var/run·/var/log·시작 로그·정책 폴더 2개)에 한정한다.
- 보조 서비스는 전부 비활성화한다: 오디오(입·출력)·업로드 서버·프린터·스마트카드·웹캠·게임패드·녹화. `KASMVNC_AUTO_RECOVER=false` 이므로 KasmVNC 가 자동 종료되면 컨테이너도 종료된다.
- 정책 파일 2개는 `RBI_POLICY_JSON`·`RBI_KASMVNC_YAML` env 로 전달하며, 시작 셸이 이를 tmpfs 에 기록한 후 이미지 본래의 시작 체인을 exec 한다
  (읽기 전용 루트에서는 start 전의 컨테이너 파일 복사도 거부되며, 백엔드는 컨테이너 내부에서 동작하므로 호스트 경로 바인드를 사용할 수 없다).

### Chromium 잠금(관리 정책, `/etc/chromium/policies/managed/zz-rbi-policy.json`)

`URLBlocklist: ["*"]` + `URLAllowlist: [대상 호스트(:포트), chrome://newtab, about:blank]` — 대상 호스트 외의 주소는 일절 열리지 않는다(file://·chrome:// 포함).
확장 전체 차단, 개발자도구 금지(2), 원격 디버깅 금지, 비밀번호 저장·자동완성·로그인·동기화·게스트·새 프로필·방문기록 저장 비활성화, 시크릿 창 금지,
측정·세이프브라우징·번역·맞춤법·제안·프리페치 비활성화, 마이크·카메라·화면공유·위치·알림·USB·BT·시리얼·파일시스템 API 차단.
정책 스위치: `DownloadRestrictions`(3=전부 차단 / 0) · `AllowFileSelectionDialogs`(업로드) · `PrintingEnabled`(다운로드 허용 여부와 연동 — "PDF 로 저장" 이 우회 경로가 되기 때문이다).

### KasmVNC 설정(`/etc/kasmvnc/kasmvnc.yaml`)

- 클립보드 DLP: `server_to_client.enabled`(브라우저→사용자 PC) · `client_to_server.enabled`(사용자 PC→브라우저). 동일한 값을 Xvnc 명령줄(`-SendCutText/-AcceptCutText`, env `KASM_SVC_*_CUT_TEXT`)에도 적용한다.
- 자동 종료: `no_user_session_timeout`(뷰어 없음) · `inactive_user_session_timeout`(입력 없음) = 유휴 분 × 60. 만료 시 Xvnc 종료 → 컨테이너 종료.
- 기본값 유지: 자체 서명 pem, `runtime_configuration.allow_override_list: [pointer.enabled]`.

## 2. 보안 모델

| 경계 | 통제 수단 |
|---|---|
| 인터넷 → 대상 | 대상은 인터넷에 공개하지 않는다 — 프런트 프록시·방화벽·공인 DNS 에 대상의 이름·규칙을 두지 않는다(§5). 대상은 LAN 에서만 응답한다 |
| 출처 | 화면·API·스트림은 rbi 전용 출처에서만 제공한다. 워크스페이스 출처에는 `/rbi/<sid>/` 가 존재하지 않는다 — 세션 컨테이너가 제공하는 콘텐츠(KasmVNC 스크립트·미러 문서)는 워크스페이스 출처에서 로드되지 않는다. rbi 출처는 워크스페이스 API 를 일절 노출하지 않는다(nginx·백엔드 이중 404) |
| 인터넷 → 스트림 | `/rbi/<sid>/` 는 요청마다 `auth_request` 를 거친다. sid 는 32hex 난수다. **rbi 세션 쿠키**(`__Host-jw_rbi`)의 사용자가 소유자인 경우에만 204(워크스페이스 세션 쿠키는 인정하지 않는다). 다른 사용자·익명·종료된 세션 → 403 |
| 스트림 → 컨테이너 | nginx 가 업스트림 주소·basic auth(`kasm_user:<세션별 난수>`)를 **백엔드 응답 헤더**에서 수신하여 설정한다. 사용자 브라우저에는 비밀번호와 주소가 모두 노출되지 않는다. 쿠키·Authorization 은 컨테이너로 전달하지 않는다(`proxy_set_header Cookie ""`) |
| 세션 컨테이너 → 외부 | 호스트 iptables `WS-RBI` 체인(DOCKER-USER 최상단): ESTABLISHED 통과 · 허용 목록(`RBI_ALLOW` 고정 ∪ 활성 대상의 동적 출구, §8) NEW 통과 · **그 외 전부 DROP**(인터넷·LAN·다른 도커 브리지·게시 포트 DNAT) + `INPUT -i br-wsrbi DROP`(호스트 자신) + `--dns 0.0.0.0`(이름 해석 불가) + IPv6 비활성화 + `enable_icc=false`(세션 간 통신) |
| 외부 → 세션 컨테이너 | 6901 은 `172.28.0.1`(workspace 브리지 게이트웨이)에만 게시한다. `WS-RBI`: ws-nginx(172.28.0.2) 출발지의 NEW 만 통과, 그 외 DROP. LAN·다른 컨테이너에서 게시 포트로 접근하면 DNAT 후 FORWARD 에서 DROP 된다(타임아웃으로 관측된다) |
| 세션 시작 | 사이드카 하트비트(`/run/rbi-guard/state.json`, 180초 이내, 동일 브리지, ok=true)가 유효하지 않으면 **시작 거부**(503). `RBI_REQUIRE_GUARD=false` 는 시험용이다 |
| 컨테이너 자체 | 비루트·읽기 전용·cap 없음·no-new-privileges·자원 상한·pids 상한. 홈은 tmpfs 이므로 세션 종료와 함께 소멸한다 |
| 감사 | `rbi.session.start / start_failed / stop / mode`, `rbi.target.create / update / delete`, `rbi.allow.add / remove`(출구 증감), `rbi.site.login`(rbi 출처 로그인) (관리 › 접근 로그) |

권한: 대상별로 `allowed_user_ids`·`allowed_group_ids` 를 지정한다. **둘 다 비어 있으면 관리자만** 접근할 수 있다(모듈 grant 의 "비어 있으면 전체 허용" 과 반대 — 기본 거부).
모듈 `rbi` 가 비활성 상태이면 사용자 API 전체가 403 을 반환한다.

세션 수명: 사용자당 활성 1개, 전체 `RBI_MAX_SESSIONS`. 종료 사유: 사용자 종료 · 관리자 강제 종료 · 유휴(KasmVNC 자동 종료 → `container_exited`, 보조 수단으로 reaper 의
"핑 중단 + 뷰어 0" → `idle`) · 최대 수명(`max_lifetime`) · 오류. reaper(30초 주기, Redis 락으로 단일 워커)는 고아 컨테이너(라벨은 있으나 활성 행이 없는 것)도 삭제한다 —
**이름이 `RBI_CONTAINER_PREFIX` 로 시작하는 것에 한한다**(라벨만으로 판정하면 동일 호스트의 다른 스택 세션까지 삭제하게 된다).

유휴: 유휴 타이머는 최종 입력 시점을 기준으로 한다 — 열어 둔 채 입력이 없는 세션도 종료되며, 뷰어가 없는 시간도 산입된다. 컨테이너의 자체 종료와 별개로
백엔드 reaper 가 `last_seen`·수명을 기준으로 추가 회수한다.

### 알려진 제한 사항 및 위험

- **Chromium 샌드박스 비활성**(`--no-sandbox`, kasm 이미지 기본값). 컨테이너 내부에서 userns 를 사용할 수 없기 때문이다. 브라우저 취약점이 컨테이너 내부의 코드 실행으로 이어질 수 있으나,
  후속 공격 경로는 차단되어 있다(비루트·읽기 전용·cap 없음·출구 없음·DNS 없음). 필요한 경우 커스텀 seccomp 로 userns 를 허용한 후 `--no-sandbox` 제거를 검토한다.
- **KasmVNC 자체의 취약점**이 곧 보안 경계다. 이미지 태그를 고정하였으므로(1.18.0) 주기적으로 태그를 갱신한다(`RBI_IMAGE`).
- 스트림은 **픽셀**이다 — 화면에 표시되는 기밀 정보(콘솔 출력 등)는 그대로 노출된다. 클립보드는 양방향 허용이 기본값이므로 문자열 반출이 가능하다(대상 정책에서 비활성화할 수 있다).
- 업로드 "허용" 은 파일 선택 대화상자만 허용한다. 독립 KasmVNC 1.18 웹 클라이언트에는 파일 전송 UI 가 없으므로 픽셀 모드에서 사용자 PC 의 파일을 컨테이너로 업로드하는 경로는 없다(정책 항목만 예약됨).
  다운로드 "허용" 시 컨테이너의 `~/Downloads` 가 `/rbi/<sid>/Downloads/` 로 노출된다(KasmVNC httpd).
- 세션당 2 CPU/2 GB, 기본 상한 4 세션(`RBI_MAX_SESSIONS`) — 호스트 자원에 맞추어 조정한다. 세션 시작 소요 시간은 2~10초다(이미지가 로컬에 존재하는 경우).
- 호스트 iptables 를 관리하는 사이드카가 중단되면(또는 docker 재시작으로 체인이 비워지면) 신규 세션은 차단되며, **기동 중인 세션은 reaper 가 하트비트 만료를 사유로 종료하지 않는다** —
  사이드카는 멱등 재구성(5초/60초) 방식이므로 통상 자동 복구된다. `docker compose ps rbi-netfilter` 와 관리 화면 "격리 규칙 상태" 를 확인한다.
- 커널의 br_netfilter 로드는 도커의 `enable_icc=false` 에 의존한다(Docker 29 는 필요한 경우에만 로드한다). 네트워크를 수동으로 생성할 때 이 옵션을 누락하면 세션 간 통신이 허용된다.

## 3. 네트워크 격리 검증

배포 후 격리의 실제 적용 여부는 아래 절차로 검증한다. 세션 1개를 기동하고 세션 컨테이너(`ws-rbi-s-<sid12>`) 내부에서 `curl -m 5` 를 실행한다
(코드 000 + rc≠0 = 도달 불가).

| 목적지 | 기대 결과 |
|---|---|
| 대상의 80 · 443 | **응답(rc=0, 도달)** |
| 인터넷(예: 1.1.1.1:443 · :80) | 000 rc=28(타임아웃) |
| 앱 서버의 LAN 주소(ws-nginx 80 과 다른 게시 포트) | 000 rc=28 |
| 프런트 프록시 · LAN 게이트웨이 · 대상이 아닌 다른 LAN 호스트 | 000 rc=28 |
| 다른 도커 브리지의 컨테이너(ws-nginx 172.28.0.2, ws-backend 등) | 000 rc=28 |
| 세션 브리지 게이트웨이(= 호스트 INPUT, 게시 포트 DNAT 포함) | 000 rc=7 |
| DNS 이름(외부 이름 · 컨테이너 이름) | rc=2(해석 불가) |

스트림 접근(`GET /rbi/<sid>/`): 소유자 200 · 다른 사용자 403 · 익명 403 · 다른 사용자의 `websockify` 403 · 다른 사용자의 `/api/rbi/sessions/<sid>` 404(존재 여부 비노출).
LAN 호스트에서 게시 포트 `172.28.0.1:<port>` 로 직접 접근 → 타임아웃. 다른 컨테이너(nginx 제외)에서 접근 → 타임아웃.

컨테이너(`docker inspect`): `user=1000:1000 ro=true capdrop=[ALL] secopt=[no-new-privileges] cpus=2 mem=2GiB shm=512MiB pids=512 dns=[0.0.0.0]`.

iptables(`docker compose exec rbi-netfilter iptables -S WS-RBI`): established 2 · 허용 목록의 목적지당 1 · egress DROP · nginx→6901 RETURN · ingress DROP,
그리고 `DOCKER-USER -j WS-RBI`, `INPUT -i <브리지> -j DROP`. 대상이 1개(80·443)인 경우 사이드카 로그에 `ok=1 rules=7` 이 기록된다.

유휴: 대상의 유휴 분을 짧게 설정하고 세션을 열어 둔 채 입력하지 않으면 KasmVNC 가 자체 종료되어 컨테이너가 삭제되며, reaper 가 해당 세션을 `ended/container_exited` 로 기록한다.

## 4. API

사용자 API(모듈 rbi 활성 + 대상 허용). rbi 출처에서는 rbi 세션 쿠키로만 인증하고, 워크스페이스 출처에서는 워크스페이스 세션으로 인증한다(런처가 목록만 조회한다).
rbi 출처의 POST·DELETE 는 `Origin` 이 rbi 출처여야 한다(불일치 시 403).
```
GET    /api/rbi/targets                 → { targets:[{id,key,name,url,host,mode,modes,policy}], sessions:[내 활성 세션], public_origin }
POST   /api/rbi/sessions                {target_id, mode?} → 201 세션 { id, status, mode, stream_url:"/rbi/<id>/", … }   (쿠키를 심지 않는다)
GET    /api/rbi/sessions/me[?recent=1]  (recent: 끝난 것까지 최근 10건) · GET /api/rbi/sessions/{id} · POST …/{id}/ping · DELETE …/{id}
POST   /api/rbi/sessions/{id}/mode      {mode}
```
전용 출처 세션(§7): `GET /auth/login?return=` · `GET /rbi-login?state&return`(워크스페이스) · `GET /auth/callback?code&state` · `GET /api/rbi/site/me` · `POST /api/rbi/site/logout`.
내부(ws-nginx 전용, `/api/internal/` 은 nginx 가 외부 요청에 404 를 반환): `GET /api/internal/rbi/auth` (Host=rbi 출처, X-Original-URI, Cookie) → 204 + `X-Rbi-Upstream`, `X-Rbi-Authorization` / 401 / 403.
관리자: `GET /api/admin/rbi`(대상·활성 세션·상태/guard·egress) · `POST /api/admin/rbi/targets` · `PUT|DELETE /api/admin/rbi/targets/{id}`
(`extra_ports`·`force` — §8, 응답에 `egress`·`warnings`) · `GET /api/admin/rbi/sessions` · `DELETE /api/admin/rbi/sessions/{id}`.

스트림 URL 규칙: KasmVNC 클라이언트는 웹소켓을 페이지 경로가 아닌 **출처 루트 기준 `path`** 로 연결한다. `?path=rbi/<sid>/websockify` 를 반드시 지정하여야 한다(`useRbi.rbiStreamSrc`).

데스크톱·모바일 앱에서의 동작은 §7 "데스크톱·모바일 앱" 을 참조한다.

## 5. 설정 및 운영

### 환경변수

전체 표는 [CONFIG.md](CONFIG.md), 예시는 `.env.example` 의 "격리 브라우저 RBI" 항목을 참조한다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `RBI_PUBLIC_ORIGIN` | (없음) | 전용 출처(예: `https://rbi.example.com`). 비우면 격리 브라우저를 사용할 수 없다. 호스트 이름은 `rbi.` 로 시작하여야 한다(§7) |
| `RBI_SITE_SESSION_HOURS` | 8 | rbi 출처 세션 수명(시간) |
| `RBI_PROTECTED` | (없음) | 워크스페이스 자체의 주소(앱 서버·LAN 게이트웨이, 예: `192.168.10.20,192.168.10.1`) — 대상 등록 거부(§8) |
| `RBI_ALLOW` | (없음) | 고정 허용 목적지(`IP:포트`, 쉼표 구분). 통상 비워 둔다(§8) |
| `RBI_ALLOW_CEILING` · `RBI_DENY` | (사설 대역) · (없음) | 동적 출구의 상한 CIDR · 사이드카가 항상 거부하는 CIDR(§8) |
| `RBI_IMAGE` · `RBI_MIRROR_IMAGE` | `kasmweb/chromium:1.18.0` · `localhost/just-workspace-rbi-mirror:latest` | 픽셀·미러 세션 이미지 |
| `RBI_NETWORK` · `RBI_SUBNET` · `RBI_IP_RANGE` · `RBI_BRIDGE` | `ws-rbi` · `172.31.200.0/24` · `172.31.200.128/25` · `br-wsrbi` | 세션 전용 브리지. 백엔드와 사이드카가 동일한 값을 참조하여야 한다 |
| `RBI_PUBLISH_IP` | `172.28.0.1` | 세션의 6901 을 게시할 주소(workspace 브리지 게이트웨이) |
| `RBI_MAX_SESSIONS` | 4 | 동시 세션 상한 |
| `RBI_REQUIRE_GUARD` | true | 사이드카 하트비트가 없으면 세션 시작을 거부한다. 격리 없이 시험하는 경우에만 false |

### 활성화 절차

1. `.env`: `RBI_PUBLIC_ORIGIN=https://rbi.example.com`, `RBI_PROTECTED=<앱 서버 IP>,<LAN 게이트웨이>`, `COMPOSE_PROFILES` 에 `rbi` 추가
   (`JW_ZONES` 를 사용하는 경우 해당 변수에도 `rbi` 추가). `RBI_ALLOW` 는 비워 둘 수 있다(대상은 관리 화면에서 등록 — §8).
2. 프런트 프록시와 DNS 를 전용 출처에 맞추어 구성한다(§7 "프런트 프록시 구성 요건").
3. 이미지: `docker pull kasmweb/chromium:1.18.0` (1.3 GB — 최초 세션 시점에 pull 하면 45초 이내에 기동하지 못한다), `docker compose build rbi-netfilter`.
   미러 모드를 사용하는 경우 §6 "운영" 의 미러 이미지도 빌드한다.
4. `docker compose up -d backend frontend-react rbi-netfilter` (backend 는 `rbi-guard`·`rbi-allow` 마운트로 인해 재생성된다).
5. `nginx/nginx.conf` 를 수정한 경우(예: 전용 출처 호스트가 `rbi.` 로 시작하지 않아 `server_name` 을 변경한 경우) `docker compose restart nginx` 를 실행한다 —
   단일 파일 bind 마운트이므로 reload 로는 변경 내용이 반영되지 않는다.
6. 관리 › 모듈·플러그인에서 **격리 브라우저** 활성화 → 관리 › 격리 브라우저: "격리 규칙 적용됨" 확인 → 대상 추가(예: 식별자 `lab`, 주소 `http://192.168.10.30`) → 허용 그룹/사용자 지정.
7. 확인: 세션 1개를 열어 대상 화면이 표시되는지, 관리 화면 "활성 세션" 에 표시되는지, 종료 후 `docker ps` 에 `ws-rbi-s-*` 가 남아 있지 않은지 확인한다. 격리는 §3 의 절차로 검증한다.

네트워크 `ws-rbi`(브리지 `br-wsrbi`)는 백엔드가 최초 세션 시점에 `docker network create --subnet 172.31.200.0/24 --ip-range 172.31.200.128/25 --gateway 172.31.200.1
--opt com.docker.network.bridge.name=br-wsrbi --opt com.docker.network.bridge.enable_icc=false` 로 생성한다. compose 에 포함하지 않는 사유: compose 가 라벨 불일치를 이유로 거부한다.

### 대상의 인터넷 공개 경로 차단

격리 브라우저로 이관한 대상은 직접 공개 경로를 차단하여야 격리의 효과가 있다.

1. 프런트 프록시: 대상 이름의 서버 블록을 삭제한다(또는 `return 404`). 웹 방화벽(WAF)을 사용하는 경우 자산 목록에서도 제외한다. 인증서 발급 목록에서도 해당 이름을 제외한다.
2. 방화벽: 대상 전용 인바운드 규칙/NAT 이 있는 경우 비활성화한다(프런트 프록시 대상 443 은 유지).
3. DNS: 대상의 공인 레코드를 삭제한다. LAN 사용자의 직접 접속이 필요한 경우 내부 DNS 에만 유지한다.
4. 대상 자체: 호스트 방화벽으로 80/443 을 앱 서버(세션 NAT 출발지)와 관리 PC 대역에 한하여 허용하면 LAN 내부의 횡적 이동(lateral movement)도 억제된다.
5. 사용자 안내: `https://rbi.<도메인>` (또는 워크스페이스 사용자 메뉴 "격리 브라우저 열기") → 워크스페이스 로그인으로 자동 로그인 → 대상.

### 문제 해결

| 증상 | 확인 사항 |
|---|---|
| "격리 규칙이 확인되지 않아 세션을 시작하지 않습니다" | `docker compose logs rbi-netfilter` — `ok=1` 이어야 한다. 브리지가 없으면 최초 세션이 생성한다(15초 이내에 규칙 반영). 하트비트 파일: `docker run --rm -v ws-rbi-guard:/g alpine cat /g/state.json` |
| 세션 503 "KasmVNC 가 45초 안에 듣기 시작하지 않았습니다" | 이미지 사전 pull 여부, 호스트 메모리. `docker logs ws-rbi-s-<sid12>` 는 reaper 의 삭제 전 30초 이내에만 조회 가능 |
| 화면이 "서버 연결에 실패했습니다" | 스트림 URL 의 `path=rbi/<sid>/websockify` 포함 여부. nginx 로그의 `/rbi/<sid>/websockify` 응답이 101 인지 여부. 프런트 프록시의 WebSocket 전달 여부 |
| 403 | 다른 사용자·만료·종료된 세션. 관리 › 접근 로그의 `rbi.*` |
| 세션이 수 분 내에 종료됨 | 대상의 유휴 분 설정이 짧음 — 뷰어가 없는 시간도 산입된다(시작 직후 열지 않은 경우) |

규칙 제거(긴급): `docker compose stop rbi-netfilter`(SIGTERM 수신 시 체인·점프 제거) — 기동 중인 세션은 출구 제한이 해제되므로 사전에 `관리 › 격리 브라우저` 에서 강제 종료한다.

## 6. 미러 모드(DOM 재구성, `mode = mirror`)

픽셀 스트림 대신 **원격 페이지를 폐쇄형 어휘(closed vocabulary)로 재구성한다**. 원격 Chromium 의 렌더링 결과(상자·글자·벡터·재인코딩 이미지)를 JSON 어휘로 전송하고,
사용자 PC 는 이를 **스크립트가 없는** 문서에 절대 위치 요소로 조립한다. 원격 페이지의 HTML·JS·CSS·URL·폰트·원본 이미지 바이트는 사용자 PC 에 전달되지 않는다.
픽셀 방식 대비 글자가 선명하며(사용자 PC 가 글자를 렌더링) 입력 응답이 빠르다(로컬 에코). 정상 표시되지 않는 화면이 있는 경우 사용자가 해당 세션만 픽셀 방식으로 전환할 수 있다.

### 구조

```
[사용자 브라우저 — 단독 앱 세션 화면]
  ├ 신뢰 크롬 바(주소 읽기 전용·정책 배지·방식 전환·끝내기·연결/지연) — 호스트 React
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

| 구성 요소 | 역할 |
|---|---|
| `rbi/mirror/protocol/vocab.ts` | 어휘 v1 정의·`LIMITS`·검증기(클라이언트는 엄격 검증 `validateServerMsg`, 에이전트는 완화 검증 `validateNode` 로 정리) |
| `rbi/mirror/agent/src/*` | 수집기(`collector`)·변환(`convert`·`background`·`fonts`·`raster`)·스크린샷 큐(`capture-queue`)·인셋·입력·세션·HTTP/WS 서버·상한 |
| `rbi/mirror/client/src/*` | 미러 클라이언트(문서 조립·로컬 에코·IME·검증) — `scripts/sync-client.mjs` 가 `frontend-react/src/lib/rbiMirror/` 로 복사(직접 수정 금지) |
| `rbi/mirror/fonts/build_fonts.py` · `Dockerfile` | 고정 폰트 번들(데비안 Liberation2·DejaVu·Noto CJK → WOFF2 168개, KS X 1001 상용/희귀/한자 unicode-range 조각) · 세션 이미지(stage build·fonts·base·dev·prod) |
| `backend/app/rbi/policy.py` | `mirror_chromium_policy`·`mirror_agent_policy`·`mirror_container_env`·`mirror_docker_create_args` |
| `backend/app/rbi/service.py` | 대상·세션 `mode`, `allowed_modes`, `switch_mode`, `path_allowed`(미러 세션은 미러 경로만, 픽셀 세션은 그 외 경로만 허용) |
| `nginx/nginx.conf` | `/rbi/<sid>/(view|mirror|asset/…|font/…|download/…)` GET 전용 · `/rbi/<sid>/upload/<id>` POST 전용(50m) |
| `frontend-react/src/components/rbi/RbiMirrorView.tsx` · `pages/admin/rbi.tsx` | 뷰어·신뢰 크롬 바 · 관리 화면 "화면 방식" |

### 보안 모델(픽셀 모드 대비 추가 사항)

| 경계 | 통제 수단 |
|---|---|
| 원격 코드 → 사용자 PC | 미러 문서는 `script-src 'none'`·`sandbox allow-same-origin`(스크립트·폼·팝업 불가)·`default-src 'none'`. img/font 는 **해당 세션의 `asset/`·`font/` 경로만** 허용한다(Host + `X-Rbi-Prefix` 로 한정). 부모(호스트 앱)가 생성하는 요소는 `div`/`span`/`img`/`svg` 등 소수 종류와 고정 속성에 한정된다 — `on*`·`href`·`src` 에는 원격 문자열이 포함되지 않는다 |
| 어휘 | 서버 메시지는 클라이언트가 **엄격 검증**(타입·범위·정규식: 색·경로 d·transform·그림자·그라디언트, `url()` 없음, 양방향 제어문자 제거). 하나라도 위반하면 해당 메시지를 폐기하고 재동기화한다 |
| 이미지 | 원본 바이트를 그대로 전달하지 않는다 — 디코드 후 WebP 재인코딩(EXIF/ICC/XMP 제거, 폴리글랏 무력화). SVG 는 래스터화한다(버퍼 입력, 외부 참조 미추적) |
| 폰트 | 원격 웹폰트는 전달하지 않는다. 계산된 글꼴을 고정 번들의 키(lsans·lserif·lmono·dsans·dserif·dmono·cjks·cjkm·cjkr)로 치환하여 전송한다. 아이콘 폰트(PUA 문자·아이콘 패밀리)는 인셋 이미지로 처리한다 |
| 비밀번호 | 값은 수집기 외부로 전달되지 않는다(길이만 전달 → 점으로 표시) |
| 정책 게이트(에이전트가 강제) | `MIRROR_POLICY` `{ci, co, dl, ul}` — 붙여넣기(사용자 PC→원격)·복사(원격→사용자 PC, 미러 선택 복사 포함: 비활성 시 문서 전체 `user-select:none`)·다운로드(`/download/<id>`, attachment+octet-stream+nosniff)·업로드(파일 선택 대화상자가 열린 경우에만 일회용 id 발급). 차단 시 신뢰 바에 알림을 표시한다 |
| 상한(세션당) | 클라→서버 메시지 64KB(초과 시 1009 로 해당 연결만 종료 — 세션은 유지)·초당 400(버스트 1200, 초과분은 폐기)·붙여넣기 조각 16000자/전체 200000자·업로드 50MB·노드 40000(초과 시 절단 전송 및 "픽셀 모드 권고")·서버→클라 초당 240 |
| 이동 | URL 허용 목록은 Chromium 정책으로 적용한다(픽셀과 동일). 차단된 이동·팝업은 에이전트가 신뢰 바에 통지한다. alert/confirm/prompt 는 원격 대화상자가 아닌 호스트 앱의 대화상자로 표시한다 |
| 경로 혼용 | 백엔드 auth 가 세션 방식과 경로의 일치를 검사한다 — 픽셀 세션으로 `/view` 를, 미러 세션으로 KasmVNC 경로를 열 수 없다(403) |
| 컨테이너 | 픽셀과 동일한 잠금(`--user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges`, cpus·memory·pids 512·`--dns 0.0.0.0`·IPv6 비활성화, tmpfs 는 /tmp·홈·정책 폴더에 한정). KasmVNC 미포함 |

Chromium 정책은 픽셀 모드의 정책과 **3개 항목만** 상이하다: `RemoteDebuggingAllowed: true`(에이전트가 파이프로 연결한다 — 포트는 개방하지 않는다),
`DeveloperToolsAvailability: 1`(2 인 경우 CDP 가 페이지 타깃에 연결할 수 없다. 헤드리스이므로 UI 를 여는 주체가 없다), `DownloadDirectory: /home/node/Downloads`.

알려진 제한 사항(미러 — 사용자가 픽셀 방식으로 전환하면 해소되는 항목 포함):
셰도 DOM·교차 출처 iframe·캔버스·영상/오디오는 인셋(이미지)으로 처리된다 · 정적 스크롤 상자 내부의 absolute 자식은 위치가 어긋날 수 있다 · 쌓임 순서·의사 요소의 글자 위치는 근사치다 ·
KS X 1001 범위 밖의 한자는 번들에 포함되지 않는다(대체 글꼴 사용) · 양방향 제어문자는 제거된다 · Windows(DirectWrite)와 리눅스(FreeType)의 래스터 차이로 인하여 픽셀 단위로 일치하지는 않는다(글자 폭은 동일) ·
차단 이벤트는 신뢰 바 알림으로만 표시되며 백엔드 감사 로그에는 기록되지 않는다 · 세션당 뷰어 1개 · 캔버스 기반 HTML5 콘솔 화면은 인셋(약 15fps)으로 처리된다.

### API(추가)

```
POST /api/rbi/sessions            {target_id, mode?}   mode=pixel 은 mirror 대상의 폴백(pixel 대상에 mirror 는 400)
POST /api/rbi/sessions/{id}/mode  {mode}               방식 바꾸기 — 지금 세션을 끝내고 같은 대상으로 새로(원격 로그인 상태는 이어지지 않음). 감사 rbi.session.mode
POST /api/admin/rbi/targets · PUT …/{id}   {…, mode: "pixel"|"mirror"}
```
세션 응답에는 `mode`, 대상 응답에는 `mode`·`modes`(사용 가능한 방식)가 포함된다. 미러 세션의 스트림 경로: `/rbi/<sid>/view`(문서) · `/rbi/<sid>/mirror`(WS) · `asset/<sha256>` · `font/<file>.woff2` · `download/<id32>` · `upload/<id32>`.

### 운영

활성화 절차(픽셀 모드 §5 의 구성을 완료한 것을 전제로 한다):
1. 이미지: `docker compose --profile rbi-build build rbi-mirror` (또는 `sh rbi/mirror/build-image.sh`) → `localhost/just-workspace-rbi-mirror:latest`(약 1.6 GB).
   이미지 이름이 다른 경우 `.env` 에 `RBI_MIRROR_IMAGE` 를 지정한다. compose 의 `rbi-mirror` 항목은 빌드 전용(entrypoint `true`, 네트워크 없음)이므로 `up` 대상이 아니다.
2. 업로드를 허용하는 대상인 경우 프런트 프록시의 `client_max_body_size` 가 50m 이상인지 확인한다.
3. 관리 › 격리 브라우저 › 대상 편집 → **화면 방식: 미러** → 저장. 다음 세션부터 적용된다(기동 중인 세션은 변경되지 않는다).
4. 확인: 세션 열기 → 신뢰 바 "연결됨" 표시 · 글자 선명도 · 한글 입력 · `docker ps` 의 `ws-rbi-s-*` 이미지가 `just-workspace-rbi-mirror` 인지 여부 · 종료 후 컨테이너 삭제 여부.

이미지 갱신: Chromium·폰트·베이스는 Dockerfile `ARG` 로 고정한다(`NODE_IMAGE` 다이제스트, `CHROMIUM_VERSION`, `FONTS_*`, `IPROUTE2`, `CA_CERTS`).
데비안 보안 업데이트로 구 버전이 저장소에서 제거되면 빌드가 실패한다 — `apt-cache policy chromium` 으로 신규 버전을 확인하고 `BUILD_ARGS="--build-arg CHROMIUM_VERSION=…"` 로 재빌드한다.
Chromium 은 **보안 업데이트마다** 갱신한다(세션 브라우저가 보안 경계다). 폰트 버전을 변경하면 글자 폭이 달라질 수 있으므로 미러 화면을 점검한다.

유휴: 뷰어 없음/입력 없음 상태가 `MIRROR_IDLE_SECONDS`(= 대상 유휴 분 × 60, 최소 60)를 초과하면 에이전트가 종료되고 컨테이너도 종료된다 → reaper 가 `ended/container_exited` 로 기록한다.

원복:
- 개별 대상: 관리 화면에서 화면 방식을 **픽셀**로 변경한다 — 다음 세션부터 KasmVNC 가 사용된다. 사용자도 신뢰 바의 "픽셀 모드로 전환" 으로 해당 세션만 전환할 수 있다.
- 기능 전체: 모든 대상을 픽셀로 설정하면 미러 경로·이미지는 사용되지 않는다(nginx 미러 location 은 미러 세션이 아닌 경우 403).

문제 해결:

| 증상 | 확인 사항 |
|---|---|
| 세션 503 "45초 안에 듣기 시작하지 않았습니다" | 미러 이미지 존재 여부(`docker image ls just-workspace-rbi-mirror`), `RBI_MIRROR_IMAGE` 이름 |
| 화면이 흰색·"연결 중" 상태에서 정지 | 브라우저 개발자도구에서 `/rbi/<sid>/mirror` 응답이 101 인지 여부, `docker logs ws-rbi-s-<sid12>` 의 `listening :6901`·`fonts: 168 faces` |
| 글자가 겹치거나 굵게 표시됨 | 폰트 번들 누락(`fonts: 0 faces`) — 이미지를 prod 타깃으로 재빌드한다 |
| 특정 화면이 정상 표시되지 않음 | 신뢰 바 "픽셀 모드로 전환"(해당 세션 한정). 반복되는 경우 대상의 화면 방식을 픽셀로 변경 |
| 한글 이름 파일의 업로드가 오류 표시 없이 실패 | 컨테이너 env `LANG=C.UTF-8`(이미지·env 이중 설정) |
| 붙여넣기·복사·다운로드가 "정책으로 막힘" 으로 표시됨 | 대상의 클립보드·다운로드·업로드 설정(정상 동작) |

## 7. 전용 출처(`RBI_PUBLIC_ORIGIN`)

격리 브라우저는 워크스페이스(예: `example.com`)와 **다른 출처**(예: `https://rbi.example.com`)의 단독 전체 화면 앱이다.

### 도입 배경

세션 화면은 세션 컨테이너가 제공하는 콘텐츠를 본 소프트웨어의 출처에서 로드한다 — 픽셀 모드는 KasmVNC 클라이언트 스크립트(`allow-scripts allow-same-origin` iframe),
미러 모드는 원격 페이지로부터 생성한 문서가 이에 해당한다. 해당 콘텐츠가 워크스페이스 출처에 위치하면, 세션 컨테이너가 침해되어 응답이 변조될 수 있는 경우 워크스페이스
쿠키·API 와 동일한 출처에 놓이게 된다. 출처를 분리하면 최악의 경우에도 피해 범위는 rbi 출처(격리 브라우저 기능)로 한정된다.

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
실패 시 `/?sso_error=state|code|user|store` 로 리디렉트되며, 앱은 사유와 [다시 로그인] 만 표시한다(자동 재시도 루프 없음).

### 보안 결정

| 항목 | 결정 |
|---|---|
| rbi 세션 쿠키 | `__Host-jw_rbi` — Secure·HttpOnly·Path=/·Domain 없음(host-only, 하위 도메인의 덮어쓰기 불가)·**SameSite=Strict**(rbi 페이지 자체의 요청에 한정). 값은 `{rsid, uid}` 를 **워크스페이스와 상이한 salt** 로 서명한 것이다 — 워크스페이스 세션을 제시하면 서명 검증 단계에서 거부된다(쿠키·Bearer 모두 401) |
| 워크스페이스 쿠키 | host-only 이므로 rbi 출처로 전송되지 않으며, 전송되더라도 rbi 출처는 이를 참조하지 않는다(쿠키·Bearer 무시) |
| state(로그인 CSRF) | 홉 전 쿠키(`__Host-jw_rbi_state`, Lax — 다른 사이트에서 시작한 홉의 복귀를 허용하기 위함) == 쿼리 == 코드에 결합된 값. 다른 브라우저가 수신한 코드는 사용할 수 없다 |
| 코드 | 32B 난수 · 60초 · `GETDEL` 1회 한정 · 사용자·워크스페이스 sid·tv·state 에 결합 |
| 오픈 리디렉트 | 홉 목적지는 `RBI_PUBLIC_ORIGIN` 설정값으로 고정된다. `return` 은 rbi 출처 내부의 상대 경로만 허용한다(절대 URL 은 동일 출처인 경우에 한하여 경로로 변환, `//`·`\`·제어문자·`/auth/` 거부 → `/`) |
| 동일 사이트 CSRF | `example.com` 과 `rbi.example.com` 은 동일 사이트(same-site)이므로 SameSite 로는 차단할 수 없다 → rbi 출처의 POST·DELETE 는 `Origin == RBI_PUBLIC_ORIGIN` 이 아니면 403(워크스페이스 페이지에서 전송한 no-cors POST 는 무효) |
| 로그아웃 | rbi 로그아웃은 rbi 세션(레코드·쿠키)만 종료하며, 열려 있는 격리 세션은 앱이 선행 종료한다. 워크스페이스 로그아웃·기기 세션 취소·강제 로그아웃(token_version) → rbi 세션이 요청마다 검사하는 **에포크**(워크스페이스 sid 유효성·tv)에 의해 즉시 종료된다. 워크스페이스 Redis 장애 시에는 워크스페이스와 동일하게 통과(fail-open), rbi 세션 저장소 장애 시에는 거부(fail-closed) |
| 출처 CSP | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss://$host; frame-src 'self'; … frame-ancestors 'none'` — 제3자 출처 없음, `unsafe-inline` 없음. 번들은 글꼴을 data: 로 인라인하지 않는다(`assetsInlineLimit 0`). XFO DENY · Referrer-Policy no-referrer · COOP/CORP same-origin · Permissions-Policy 전체 비활성(클립보드만 self). 스트림 location 은 별도의 헤더를 사용하며(미러 view 의 CSP 는 에이전트 nonce, 픽셀은 `frame-ancestors 'self'`), 세션 컨테이너의 `Set-Cookie` 는 폐기한다 |
| 번들 격리 | `vite.rbi.config.ts` 가 `src/pages|layouts|router|plugins`, 셸 컴포넌트, vue·livekit·tiptap·yjs·shiki·chart.js 가 포함되면 빌드를 실패 처리한다(`rbi-bundle-guard.ts`). i18n 은 `rbi`·`common`·`ui` 에 한정한다 |
| 단독 앱 키보드 | 세션이 열리면 포커스는 격리 화면에 위치한다(미러: 숨김 입력 필드, 픽셀: iframe). `Ctrl+Alt+B`(물리 키 B) → 신뢰 상단 바(원격으로 전달하지 않음 — 앱 문서와 픽셀 iframe 창 모두 capture 단계에서 처리), 상단 바에서 `Esc` → 격리 화면 |
| 딥 링크 | `?target=<key>` 는 대상을 사전 선택할 뿐이다 — 링크만으로 컨테이너를 기동하지 않는다 |
| 워크스페이스 `/rbi/<sid>/` | 존재하지 않는다. 세션 화면은 rbi 출처에서만 제공된다 |

### 데스크톱·모바일 앱

- 데스크톱(Electron): 웹뷰의 `window.open` → `shell.openExternal`, 워크스페이스 외부로의 최상위 이동 → 차단 후 `openExternal`. 런처·사용자 메뉴가 여는 rbi 출처는 **시스템 브라우저**에서 열리며,
  해당 브라우저에서 홉(브라우저의 워크스페이스 로그인)을 수행한다. 앱 웹뷰에는 격리 화면이 로드되지 않는다.
- 모바일(Capacitor): `allowNavigation: ['*']` 이므로 웹뷰 내부에서 열릴 수 있다. 앱 웹뷰는 워크스페이스 쿠키 대신 Bearer 를 사용하는 경우가 있어 홉 과정에서 워크스페이스 로그인이 재차 요구될 수 있다 — 잔존 위험으로 분류한다.

### 프런트 프록시 구성 요건

ws-nginx 는 80 포트에서 평문으로 수신한다. TLS 는 프런트 프록시가 종단한다.

1. DNS: 전용 출처 이름(예: `rbi.example.com`)을 워크스페이스와 동일한 공인 IP 로 등록한다. 인증서도 해당 이름으로 발급한다.
2. 해당 이름의 443 서버 블록에서 모든 요청을 ws-nginx 로 전달한다. nginx 의 경우(예시 — `<앱 서버>` 는 ws-nginx 가 게시된 주소):
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
3. 전단에 웹 방화벽(WAF)을 두는 경우, 이 출처는 웹소켓과 대용량 바이너리 프레임의 비중이 높다는 점을 고려하여 적용 여부를 결정한다.
4. `.env` 의 `RBI_PUBLIC_ORIGIN`·`RBI_PROTECTED` 를 설정하고 §5 "활성화 절차" 에 따라 기동한다.

확인:
- `docker run --rm -v ws-rbi-allow:/a alpine cat /a/allow.txt` → 활성 대상의 `IP:80`·`IP:443`
- `docker run --rm -v ws-rbi-guard:/g alpine cat /g/state.json` → `"ok":true`, `allow` 에 위 항목, `rejected:[]`
- 관리 › 격리 브라우저 "격리 규칙 상태" — 대기 없음, 전용 출처 표시
- 브라우저 `https://rbi.example.com` → 워크스페이스 로그인(로그인 상태인 경우 생략) → 대상 → 세션
- `https://rbi.example.com/api/auth/me` → 404, `https://example.com/rbi/<sid>/view` → 세션으로 연결되지 않음

`RBI_PUBLIC_ORIGIN` 을 비우면 격리 브라우저 화면은 제공되지 않는다(런처에 "설정 필요" 가 표시된다) — 워크스페이스 출처에서 스트림을 여는 방식은 지원하지 않는다.

### 알려진 위험

- 픽셀 모드의 KasmVNC 클라이언트 스크립트는 rbi 출처에서 실행된다(동일 출처 iframe). 세션 컨테이너가 침해되어 해당 스크립트가 변조되면 rbi 출처 API(대상 목록·세션 시작/종료)를
  사용자 권한으로 호출할 수 있다 — 워크스페이스로는 확산되지 않는다(출처 분리의 목적). 미러 모드에는 스크립트가 없다.
- `server_name ~^rbi\.` — RBI_PUBLIC_ORIGIN 의 호스트가 `rbi.` 로 시작하지 않으면 nginx.conf 를 수정하여야 한다. 다른 `rbi.*` 이름으로 접근하더라도 백엔드는 이를 rbi 출처로 인정하지 않으므로(Host 비교) 인증·스트림이 모두 거부된다.
- rbi 세션은 워크스페이스 세션을 갱신하지 않는다 — 워크스페이스 유휴 로그아웃 정책은 rbi 사용을 활동으로 산입하지 않는다(8시간 상한).
- 모바일 앱 웹뷰(상기 "데스크톱·모바일 앱" 참조).

## 8. 동적 출구 허용 목록

관리 › 격리 브라우저에서 대상을 추가하면 `.env` 수정·재시작 없이 netfilter 규칙에 반영된다.

```
관리자 저장 ─► egress.compute_egress(검증 · 이름 → IPv4 고정) ─► rbi_targets.egress
            ─► allow.txt(ws-rbi-allow 볼륨, 백엔드만 씀, 원자적·바뀔 때만)  + 감사 rbi.allow.add/remove
ws-rbi-netfilter ─ RBI_POLL(5초)마다 읽기 ─ 줄마다 재검사(rbi-allow-check.awk) ─► 체인 재구성(목록이 바뀔 때만) ─► state.json(allow·rejected·allow_rev)
세션 시작 ─ 이 대상의 출구가 state.json allow 에 실제로 있나(최대 15초 대기) ─ 아니면 503(이유)
```

| 검증(대상 저장 — 백엔드) | |
|---|---|
| 호스트 | 사설/LAN IP 또는 이름. 이름은 저장 시점에 IPv4 로 해석하여 **고정**한다(규칙과 세션 컨테이너 `--add-host 이름:IP` — 세션에는 DNS 가 없다). 해석 실패 시 거부. IPv6 거부 |
| 상한 | `RBI_ALLOW_CEILING`(비어 있으면 사설 대역) 범위 밖 → 거부(강제 불가 — 공인 주소는 허용하지 않는다) |
| 금지 | 루프백·링크로컬·멀티캐스트, 이 호스트의 **도커 네트워크 대역 전부**(ws-* 컨테이너·세션 대역) → 거부(강제 불가) |
| 워크스페이스 자체 | `RBI_PROTECTED`(앱 서버·게이트웨이) + APP_URL·RBI_PUBLIC_ORIGIN 이 해석되는 IP(= 프런트 프록시) → 거부. 관리자가 **강제**하는 경우 경고 토스트와 함께 허용(`force` 행, 감사 `forced`) |
| 포트 | 80·443 + 대상에 명시한 `extra_ports` 에 한정. 포트를 지정하지 않은 호스트는 80·443 모두 허용 |
| 주소 변경 | 이전 주소의 호스트를 허용 호스트에서 제외한다(Chromium 허용 목록·출구에 이전 호스트가 잔존하지 않도록 하기 위함) |

| 사이드카 재검사(파일 행 단위) | |
|---|---|
| 형식 | `IPv4:포트[ force]  # 주석` — 불일치 시 `format` |
| 금지 | 루프백·링크로컬·멀티캐스트·세션 대역·이 호스트의 `docker0`/`br-*` 대역·`RBI_DENY` → `denied` |
| 상한 | `RBI_ALLOW_CEILING`(비어 있으면 사설 대역) 범위 밖 → `outside-ceiling` |
| 자체 주소 | 이 호스트의 IP·기본 게이트웨이는 `force` 행만 허용 → 그 외 `self-needs-force` |
| (참고) | backend 가 "자체 주소"로 인식하는 것은 `RBI_PROTECTED` 와 접속 주소가 해석되는 IP 에 한정된다. 서버의 LAN 주소가 `RBI_PROTECTED` 에 포함되어 있지 않으면 backend 는 이를 수락하나 사이드카가 `self-needs-force` 로 거부한다 — 관리 화면의 "격리 규칙 상태"에 표시되며, 해당 대상을 **강제**로 다시 저장하면 `force` 가 부여되어 허용된다. 설치 관리자는 사전 점검에서 감지한 이 서버의 주소와 기본 게이트웨이를 `RBI_PROTECTED` 에 기록한다(서버의 주소가 복수인 경우 외부로 향하는 주소 1개만 기록하므로 나머지는 직접 추가한다) |
| (참고) | **강제하더라도 이 서버가 직접 수신하는 포트는 허용되지 않는다.** 허용 목록은 세션 브리지에서 **다른 호스트로 전달되는** 경로(FORWARD)만 허용한다. 이 서버 자체로 향하는 경로는 `INPUT -i <세션 브리지> -j DROP` 이 별도로 차단하며(§2), 이는 허용 목록과 무관하다 — 호스트에서 직접 수신하는 서비스와 도커가 게시한 포트 모두 세션에서 도달할 수 없다(검수 환경에서 확인: 세션은 기동되나 화면이 비어 있다). 강제가 유효한 대상은 기본 게이트웨이나 프런트 프록시와 같은 **다른 장비**의 주소다. 이 서버에서 실행되는 웹 화면을 대상으로 등록하려면 해당 서비스를 다른 호스트로 이전하여야 한다 |

`RBI_ALLOW` 는 **고정 허용**으로 유지된다(검사 없이 항상 허용 — 운영자가 .env 에 지정한 값). 상한은 `RBI_ALLOW_CEILING` 이다.
볼륨을 2개로 분리한 사유: 사이드카는 host 네트워크에서 동작하므로 내부 HTTP 엔드포인트를 사용하면 새로운 노출면이 발생한다. `rbi-allow`(백엔드 → 사이드카 ro)·`rbi-guard`(사이드카 → 백엔드 ro)로
방향을 분리하면 백엔드는 하트비트를 위조할 수 없으며, 사이드카는 백엔드가 기록한 행을 신뢰하지 않고 재검사한다.

관리 화면 "격리 규칙 상태" 의 표시 항목: 하트비트(경과 시간) · 현재 적용된 목록 · 대상이 요구하는 출구 · 미적용 항목(사이드카 대기) · 사이드카가 거부한 행(사유) · 고정 허용 · 상한·보호 주소 · 전용 출처.

사이드카가 파일을 읽어 체인에 적용하는 과정은 전파 시험 `deploy/rbi-netfilter/test-propagation.sh` 로 검증한다(§9).

## 9. 시험

- backend pytest: `test_rbi.py`(대상·세션·정책) · `test_rbi_site.py`(홉·쿠키·리디렉트·CSRF·호스트 제한) · `test_rbi_egress.py`(검증 거부·강제·이름 고정·API→파일→감사·세션 대기)
- frontend vitest: 단독 앱 · 런처/내비/번들 격리 · 관리 화면
- nginx: `nginx -t`
- 사이드카 전파(`deploy/rbi-netfilter/test-propagation.sh`, 별도 체인·브리지 이름의 임시 컨테이너): 대상 추가 → 2초 이내 규칙 적용 + 세션 대역에서의 실제 연결 · 금지 행 5종 거부(사유) · 제거 → 2초 이내 규칙 삭제 + 차단 · 종료 시 체인·점프 정리
- 미러: 단위 시험 `rbi/mirror/test/`(어휘 검증·수집·변환·로컬 에코), 시험 페이지 `rbi/mirror/devpages/`(세션 이미지의 `dev` 타깃에만 포함된다)

사이드카 시험은 운영 환경과 상이한 체인·브리지 이름을 사용한다. `apply.sh` 는 `RBI_TEST_STACK=1` 인 경우 운영 이름(`WS-RBI`·`br-wsrbi`)을 거부하고,
인자를 받지 않으며, `RBI_CHAIN` 이 지정되지 않으면 시작하지 않는다(exit 64, 운영 compose 는 `WS-RBI` 를 지정한다) — 따라서 시험이 운영 체인을 변경할 수 없다.
