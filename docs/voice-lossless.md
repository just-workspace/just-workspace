# 음성채널 무손실 음질 — 구조, 활성화 절차 및 외부 공개 점검 항목

채팅의 음성채널은 음질 단계를 제공한다 — 음성·음악(LiveKit, Opus)과 **무손실**(PCM 24-bit · 장치 레이트(48 kHz), 비압축).
무손실 단계의 전송은 LiveKit 이 아닌 전용 중계 서버 `ws-audiorelay`(compose 서비스 `audiorelay`)가 담당한다. 본 문서는 그 구조와 활성화 절차를 기술한다.
프로토콜은 [`audiorelay/PROTOCOL.md`](../audiorelay/PROTOCOL.md), 서버 코드는 [`audiorelay/`](../audiorelay/README.md).

음성채널은 **채팅 구역과 회의 구역이 모두** 설치된 경우에만 사용할 수 있으며, 중계 서버는 회의 구역에 포함된다.
중계 서버가 없거나 연결할 수 없는 경우 무손실을 선택한 사용자는 음악 단계로 강등되며 통화는 유지된다.

## 1. 구조

```
브라우저(송신)                        ws-audiorelay (Go, 순수 포워더)                 브라우저(수신)
getUserMedia(처리 off, 2ch, 장치 레이트)   ┌──────────────────────────────┐   패킷 → 단편 재조립 → XOR 복원/NACK
→ AudioContext(트랙 레이트)               │ WebTransport :4433/udp (기본)  │   → PCM 언패킹 → 피어별 재생 워크릿
→ 캡처 워크릿(10 ms 프레임)              │ WebSocket  /audiorelay/ws (폴백)│   (스트림 레이트 AudioContext,
→ PCM s24 패킹 → XOR 패리티 4:1 ────────▶│ 방 단위 팬아웃, src 스탬프만    │──▶  적응 지터버퍼 20 ms~ + PLC)
                                          │ 재전송 캐시 512 슬롯, 통계 1 s  │
                                          └──────────────────────────────┘
                 ▲ 토큰(HMAC, 120 s)                                       ▲ 통계 GET /audiorelay/stats (토큰)
   backend POST /api/chat/channels/{id}/voice/relay-token  ←  음성 채널 멤버 + LiveKit identity 소유 확인
```

- **참가자 표시에는 LiveKit 을 그대로 사용한다.** 무손실 클라이언트(`frontend-react/src/lib/lossless/adapter.ts`)는 LiveKit 방에도 참가하여(음악 레시피 Opus 를 함께 publish)
  `/voice/state` 로 `tier=lossless` 를 통지한다. 음성·음악 단계 참가자는 해당 Opus 를 수신하고, 무손실 참가자 간에는 릴레이 PCM 을 수신한다
  (동일 참가자의 Opus 트랙은 identity 로 대응시켜 음소거한다). 릴레이 연결에 실패하면 음악 단계로 강등되며 LiveKit 연결은 유지된다.
- **전송 선택**(`transportSelector.ts`): 기본은 WebTransport. API 미지원 · 릴레이의 WT 주소 미제공 · 핸드셰이크 1.8 s 타임아웃/실패(UDP 차단) ·
  60 s 이내 3회 단절 시 WebSocket 으로 폴백. 폴백 후 60 s 주기로 WebTransport 를 재시도하며, 성공 시 전환한다. `stats.transport` / `stats.fallbackReason` 으로 노출.
- **비트퍼펙트 판정**: 장치 레이트 = 캡처 컨텍스트 레이트 = 스트림 레이트, 수신은 스트림 레이트 = 재생 컨텍스트 레이트. 하나라도 불일치하면
  `bitExact=false` + `warning` 이벤트 → 배지는 "무손실(리샘플)" 로 하향 표시하여야 한다(배지 규칙은 코드 가드: `VoiceStats.bitExact`).
- **대역**: 24/48 스테레오 = 2.3 Mbps/스트림(+헤더·패리티 ≈ 2.7 Mbps). 서버의 업로드 대역은 수신자 수에 비례하여 소요된다 — 방당 16명 상한.
- FLAC(코덱 3)·Opus 패스스루(4)는 프로토콜 헤더에 예약되어 있을 뿐 구현되어 있지 않다.

## 2. 활성화 절차 (서버)

설치 관리자(또는 관리 › 구역)의 회의 구역 설정에서 **무손실 오디오**를 활성화하면 `audiorelay` 프로파일과 `AUDIORELAY_SECRET` 이 자동으로 설정된다(채팅 구역이 설치되어 있어야 활성화할 수 있다) — 이 상태에서 **WebSocket 전송은 즉시 사용할 수 있다**
(워크스페이스 주소의 `/audiorelay/` 경로, 추가 포트 불필요). 이하는 `.env` 를 직접 편집하는 경우와, 지연이 더 짧은 WebTransport(UDP)를 개방하는 경우의 절차다.

```
COMPOSE_PROFILES=…,audiorelay
AUDIORELAY_SECRET=<openssl rand -hex 24 의 출력>   # backend 와 릴레이가 같은 값을 읽는다. 32자 이상(짧으면 backend 가 기동 검사에서 멈춘다)
# 아래 셋은 WebTransport 를 쓸 때만. 비우면 WebSocket 만 쓴다
AUDIORELAY_WT_PUBLIC_URL=https://audio.example.com:4433/audiorelay/wt
AUDIORELAY_WT_CERT=/etc/letsencrypt/live/audio.example.com/fullchain.pem
AUDIORELAY_WT_KEY=/etc/letsencrypt/live/audio.example.com/privkey.pem
```

```
docker compose up -d audiorelay backend
```

인증서 경로는 릴레이 컨테이너 내부의 경로다(`certbot-data` 볼륨이 `/etc/letsencrypt` 에 읽기 전용으로 마운트된다). 두 변수를 비워 두면 워크스페이스 도메인의
인증서(`live/${DOMAIN}/`)를 사용한다. `AUDIORELAY_WT_PORT`(기본 4433)는 호스트에 개방하는 UDP 포트다.

확인: `docker compose exec backend python -c "import urllib.request;print(urllib.request.urlopen('http://audiorelay:8090/audiorelay/info').read())"`,
`curl -s https://<도메인>/audiorelay/health`(프런트 프록시 경유), 접속 후 증명 패널의 `transport: webtransport`.

LAN 테스트만 수행하는 경우 인증서 없이 앱 서버의 사설 주소를 지정한다(예: `AUDIORELAY_WT_PUBLIC_URL=https://192.168.10.20:4433/audiorelay/wt`,
`AUDIORELAY_WT_SELF_SIGNED_HOSTS=192.168.10.20`). 이 경우 릴레이가 유효 기간 13일의 ECDSA 자체 서명 인증서를 생성하여 `/audiorelay/info` 에 `cert_hash` 를 게시하며,
클라이언트는 이를 `serverCertificateHashes` 로 지정한다(브라우저 규칙상 ECDSA · 14일 이내만 허용).

## 3. 외부 공개 점검 항목 (WebTransport = UDP 직결)

WebSocket 폴백은 프런트 프록시의 443 → ws-nginx `/audiorelay/` 경로로 위치와 무관하게 동작한다. WebTransport 를 외부에서 사용하려면 아래 항목이 모두 충족되어야 한다.
주소·이름은 예시다(`audio.example.com`, 앱 서버 `192.168.10.20`).

| # | 항목 | 조치 | 확인 |
|---|---|---|---|
| 1 | **포트** | UDP **4433**(`AUDIORELAY_WT_PORT`)을 앱 서버에서 개방한다. 443/udp 는 사용하지 않는다 — 프런트 프록시·LiveKit TURN TLS 가 443/tcp 를 사용하며, HTTPS 검사 보안 장비의 QUIC 처리와 충돌한다 | 앱 서버에서 `ss -lun \| grep 4433` |
| 2 | **호스트명** | 공인 DNS 에 `audio.example.com` A 레코드 → 공인 IP | `nslookup audio.example.com 1.1.1.1` |
| 3 | **스플릿 DNS** | 내부 DNS 에서는 `audio.example.com` → 앱 서버의 사설 주소. LAN 사용자가 공인 IP 를 경유하는 헤어핀 NAT 에 의존하지 않는다 | LAN 에서 `nslookup` → 사설 주소 |
| 4 | **인증서** | 공인 인증서(Let's Encrypt 등), SAN `audio.example.com`. HTTP-01 로 발급하는 경우 2번 DNS 가 공인 IP 를 가리키므로 `/.well-known/acme-challenge/` 는 80 포트를 수신하는 프런트 프록시가 응답하여야 한다. 인증서를 앱 서버가 아닌 장비에서 발급하는 경우 **갱신(deploy) 훅**으로 앱 서버의 `certbot-data` 볼륨 `live/audio.example.com/` 에 `fullchain.pem`·`privkey.pem` 을 전달한다(권한 0644/0600). 릴레이는 1시간 이내에 인증서를 다시 로드하므로 재시작은 불필요하다. 대안: 워크스페이스 도메인 인증서에 SAN 으로 추가하면 기본 경로(`live/${DOMAIN}`)를 그대로 사용할 수 있다 | 릴레이 로그 `webtransport certificate loaded` · `/audiorelay/info` 에 `self_signed:false` |
| 5 | **방화벽 인바운드 DNAT** | NAT: 공인 IP **udp/4433 → 앱 서버:4433**. 접근 규칙: Any → 앱 서버 udp/4433 허용(로그 기록) | 방화벽 로그에 udp/4433 허용, 외부 폰 LTE 로 접속 → `transport: webtransport` |
| 6 | **QUIC/UDP 를 차단하는 보안 장비** | ① HTTPS 검사 장비는 QUIC 을 복호화할 수 없어 **QUIC 차단**(브라우저의 TCP 폴백 유도)이 기본값인 경우가 많다 — 해당 규칙이 443/udp 만 대상으로 하는지, UDP 전체 또는 애플리케이션 식별("QUIC")로 4433 까지 차단하는지 확인한다. 차단되는 경우 1.8 s 후 WebSocket 으로 폴백하며 패널에 `handshake_timeout` 이 기록된다. ② IPS 에 QUIC 관련 보호 기능이 있는 경우 앱 서버 목적지에 예외를 설정한다. ③ 방화벽의 UDP 세션 타임아웃은 QUIC idle 30 s(keep-alive 10 s)보다 길어야 세션이 유지된다. ④ UDP 레이트 제한(DoS 보호)을 사용하는 경우 앱 서버의 udp/4433 이 한도를 초과하지 않도록 설정한다(스트림 1개 ≈ 초당 100~400 패킷). ⑤ 스트림당 ≈2.7 Mbps 업로드 — 수신자 n 명이면 n 배 | 외부에서 `webtransport` 로 연결되고 `rtt_ms` 가 공인 구간 왕복 지연과 유사 |
| 7 | **프런트 프록시의 WebSocket 폴백** | 프런트 프록시가 `/audiorelay/` 도 `/ws/` 와 동일하게 Upgrade 헤더·긴 read timeout 으로 전달하는지, 웹 방화벽(WAF)이 있는 경우 바이너리 WS 프레임을 변조하지 않는지 확인한다 | 외부에서 WT 주소를 비운 상태로 `websocket` 연결 후 음성 수신 확인 |

권장 적용 순서: 2·3(DNS) → 4(인증서 — HTTP-01 발급은 DNS 에 의존) → `.env` + `compose up` → 5·6(방화벽) → 7 확인.

## 4. 참고 측정값 (헤드리스 Chrome 2개, 동일 LAN — 환경에 따라 상이함)

- 비트퍼펙트: 전 시나리오(WT 10 ms·2.5 ms·s16, WS nginx 경유, 폴백) 송신 해시 = 수신 해시 **불일치 0**.
- 네트워크 지연(캡처 → 상대 수신, 동일 머신 wall clock): p50 ≈ 1 ms, p95 ≈ 1~2 ms(LAN). 입-출 추정 = 프레임 10 + RTT/2 + 버퍼 20 + 출력지연.
- 비트레이트: s24 2ch 44.1 kHz(가상 장치) 2.72 Mbps(헤더·패리티 포함, 명목 2.12), s16 1.81 Mbps.
- 손실 복구: 릴레이가 5% 드롭 → FEC 로 ~95% 복원, 잔여분은 NACK 재전송, 최종 손실 ≤0.05%.
- 폴백: WT 포트 닫힘 → 즉시(ERR_CONNECTION_RESET) WebSocket, `handshake_failed`; 블랙홀 → 1.8 s 타임아웃 후 WebSocket, `handshake_timeout`.
- 96 kHz: 시험에 사용한 가상 장치는 48 kHz 까지만 지원하므로 브라우저의 96 kHz 캡처는 검증되지 않았다. 48 kHz 를 초과하는 레이트는 데스크톱 앱의 하이레조 단계([apps/desktop/README.md](../apps/desktop/README.md))에서 다룬다.
