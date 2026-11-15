# 음성채널 무손실 티어(Tier 3) — 구조·운영·외부 공개 체크리스트

음성채널의 "무손실" 단계: **PCM 24-bit · 장치 레이트(48 kHz) · 자체 중계**. 프로토콜은 [`audiorelay/PROTOCOL.md`](../audiorelay/PROTOCOL.md).

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

- **presence 는 LiveKit 음성 단계와 같다.** 무손실 클라이언트(`lib/lossless/adapter.ts`)는 LiveKit 방에도 들어가(음악 레시피 Opus 를 함께 publish)
  `/voice/state` 로 `tier=lossless` 를 알린다. 음성·음악 단계 참가자는 그 Opus 를 듣고, 무손실 참가자끼리는 릴레이 PCM 을 듣는다
  (같은 사람의 Opus 트랙은 identity 로 짝지어 끈다). 릴레이에 못 붙으면 음악 단계로 강등되고 LiveKit 쪽은 끊기지 않는다.
- **전송 선택**(`transportSelector.ts`): WebTransport 가 기본. API 없음 · 릴레이가 WT 주소를 안 줌 · 핸드셰이크 1.8 s 타임아웃/실패(UDP 차단) ·
  60 s 안 3회 단절이면 WebSocket. 폴백 뒤 60 s 마다 WebTransport 재시도, 되면 갈아탄다. `stats.transport` / `stats.fallbackReason` 으로 노출.
- **비트퍼펙트 판정**: 장치 레이트 = 캡처 컨텍스트 레이트 = 스트림 레이트, 수신은 스트림 레이트 = 재생 컨텍스트 레이트. 하나라도 다르면
  `bitExact=false` + `warning` 이벤트 → 배지는 "무손실(리샘플)" 로 낮춰야 한다(배지 규칙은 코드 가드: `VoiceStats.bitExact`).
- **대역**: 24/48 스테레오 = 2.3 Mbps/스트림(+헤더·패리티 ≈ 2.7 Mbps). 수신자 수만큼 홈서버 업로드가 든다 — 방당 16명 상한(env).
- FLAC(코덱 3)·Opus 패스스루(4)는 헤더에 자리만 있다. 브라우저 WebCodecs 는 FLAC 인코더가 없어 wasm(libflac.js, MIT/BSD-3)이 필요한데
  PCM 이 LAN·광랜 예산에 들어와 이번 단계에선 넣지 않았다.

## 2. 켜기 (서버)

```
COMPOSE_PROFILES=…,audiorelay
AUDIORELAY_SECRET=$(openssl rand -hex 24)        # backend·릴레이 공유, 16자 이상
AUDIORELAY_WT_PUBLIC_URL=https://audio.<도메인>:4433/audiorelay/wt   # 비우면 WebSocket 만
AUDIORELAY_WT_CERT=/etc/letsencrypt/live/audio.<도메인>/fullchain.pem
AUDIORELAY_WT_KEY=/etc/letsencrypt/live/audio.<도메인>/privkey.pem
docker compose up -d audiorelay backend
docker compose restart nginx        # nginx.conf 는 파일 bind 마운트 — reload 로는 /audiorelay/ 가 안 들어간다
```

확인: `docker compose exec backend python -c "import urllib.request;print(urllib.request.urlopen('http://audiorelay:8090/audiorelay/info').read())"`,
`curl -s https://<도메인>/audiorelay/health`(앞단 프록시 경유), 접속 뒤 증명 패널의 `transport: webtransport`.

LAN 테스트만 하려면 인증서 없이 앱 서버의 사설 주소로(예: `AUDIORELAY_WT_PUBLIC_URL=https://192.168.10.20:4433/audiorelay/wt`,
`AUDIORELAY_WT_SELF_SIGNED_HOSTS=192.168.10.20`) — 릴레이가 13일짜리 ECDSA 자가서명을 만들고 `/audiorelay/info` 에 `cert_hash` 를 게시하며
클라이언트가 `serverCertificateHashes` 로 넣는다(브라우저 규칙상 ECDSA · 14일 이내만 허용).

## 3. 외부 공개 체크리스트 (WebTransport = UDP 직결)

WebSocket 폴백은 앞단 리버스 프록시의 443 → ws-nginx `/audiorelay/` 로 어디서나 된다. WebTransport 를 외부에서 쓰려면 아래가 전부 필요하다.
주소·이름은 예시다(`audio.example.com`, 앱 서버 `192.168.10.20`).

| # | 항목 | 할 일 | 확인 |
|---|---|---|---|
| 1 | **포트** | UDP **4433**(`AUDIORELAY_WT_PORT`)을 앱 서버에서 연다. 443/udp 를 쓰지 않는다 — 앞단 프록시·LiveKit TURN TLS 가 443/tcp 를 쓰고, HTTPS 를 검사하는 보안장비의 QUIC 처리와 섞인다 | 앱 서버에서 `ss -lun \| grep 4433` |
| 2 | **호스트명** | 공인 DNS 에 `audio.example.com` A 레코드 → 공인 IP | `nslookup audio.example.com 1.1.1.1` |
| 3 | **스플릿 DNS** | 내부 DNS 에서는 `audio.example.com` → 앱 서버의 사설 주소. LAN 사용자가 공인 IP 로 돌아 들어오는 헤어핀 NAT 에 기대지 않는다 | LAN 에서 `nslookup` → 사설 주소 |
| 4 | **인증서** | 공인 인증서(Let's Encrypt 등), SAN `audio.example.com`. HTTP-01 로 받는다면 2번 DNS 가 공인 IP 를 가리키므로 `/.well-known/acme-challenge/` 는 80 을 받는 앞단 프록시가 응답해야 한다. 인증서를 앱 서버가 아닌 장비에서 발급한다면 **갱신(deploy) 훅**으로 앱 서버의 `certbot-data` 볼륨 `live/audio.example.com/` 에 `fullchain.pem`·`privkey.pem` 을 전달한다(권한 0644/0600). 릴레이는 1시간 안에 다시 읽으므로 재시작 불필요. 대안: 워크스페이스 도메인 인증서에 SAN 으로 추가하면 기본 경로(`live/${DOMAIN}`) 그대로 | 릴레이 로그 `webtransport certificate loaded` · `/audiorelay/info` 에 `self_signed:false` |
| 5 | **방화벽 인바운드 DNAT** | NAT: 공인 IP **udp/4433 → 앱 서버:4433**. 접근 규칙: Any → 앱 서버 udp/4433 허용(로그 남김) | 방화벽 로그에 udp/4433 허용, 외부 폰 LTE 로 접속 → `transport: webtransport` |
| 6 | **QUIC/UDP 를 막는 보안장비** | ① HTTPS 를 검사하는 장비는 QUIC 을 열어보지 못해 **QUIC 차단**(브라우저가 TCP 로 떨어지게)이 기본인 경우가 많다 — 그 규칙이 443/udp 만 보는지, UDP 전체·애플리케이션 식별("QUIC")로 4433 까지 막는지 확인한다. 막히면 1.8 s 뒤 WebSocket 으로 떨어지고 패널에 `handshake_timeout` 이 찍힌다. ② IPS 에 QUIC 관련 보호가 있으면 앱 서버 목적지에 예외를 둔다. ③ 방화벽의 UDP 세션 타임아웃이 QUIC idle 30 s(keep-alive 10 s)보다 길어야 유지된다. ④ UDP 레이트 제한(DoS 보호)을 쓰고 있으면 앱 서버의 udp/4433 이 한도에 걸리지 않게(스트림 1개 ≈ 초당 100~400 패킷). ⑤ 스트림당 ≈2.7 Mbps 업로드 — 수신자 n 명이면 n 배 | 외부에서 `webtransport` 로 붙고 `rtt_ms` 가 공인 왕복과 비슷 |
| 7 | **앞단 프록시의 WebSocket 폴백** | 앞단 프록시가 `/audiorelay/` 도 `/ws/` 처럼 Upgrade 헤더·긴 read timeout 으로 넘기는지, 웹 방화벽(WAF)이 있으면 바이너리 WS 프레임을 건드리지 않는지 | 외부에서 WT 주소를 비운 채 `websocket` 으로 붙어 소리 확인 |

적용 순서 권장: 2·3(DNS) → 4(인증서 — HTTP-01 발급은 DNS 에 의존) → `.env` 4줄 + `compose up` → 5·6(방화벽) → 7 확인.

## 4. 측정 요약 (헤드리스 Chrome, LAN)

- 비트퍼펙트: 전 시나리오(WT 10 ms·2.5 ms·s16, WS nginx 경유, 폴백) 송신 해시 = 수신 해시 **불일치 0**.
- 네트워크 지연(캡처 → 상대 수신, 같은 머신 wall clock): p50 ≈ 1 ms, p95 ≈ 1~2 ms(LAN). 입-출 추정 = 프레임 10 + RTT/2 + 버퍼 20 + 출력지연.
- 비트레이트: s24 2ch 44.1 kHz(가짜 장치) 2.72 Mbps(헤더·패리티 포함, 명목 2.12), s16 1.81 Mbps.
- 손실 복구: 릴레이가 5% 드롭 → FEC 로 ~95% 복원, 나머지 NACK 재전송, 최종 손실 ≤0.05%.
- 폴백: WT 포트 닫힘 → 즉시(ERR_CONNECTION_RESET) WebSocket, `handshake_failed`; 블랙홀 → 1.8 s 타임아웃 뒤 WebSocket, `handshake_timeout`.
- 96 kHz: 가짜 장치는 `sampleRate 44100 / sampleSize 16`, capabilities max 48000 — 96 k 요청은 무시된다. 실기기는 미검증.
