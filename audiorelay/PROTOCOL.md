# audiorelay 전송 프로토콜 v1

just-workspace 음성채널 **무손실 티어(Tier 3)** 의 중계 프로토콜. 릴레이(`ws-audiorelay`)는 SFU 식 순수 포워더다 —
**디코딩·트랜스코딩을 절대 하지 않고**, 보낸 사람의 프레임을 같은 방의 다른 멤버에게 바이트 그대로 넘긴다.
릴레이가 손대는 바이트는 헤더의 `src`(송신 피어 번호) 2바이트와, 재전송일 때 `flags` 의 비트 하나뿐이다.

- 전송: **WebSocket**(`/audiorelay/ws`, ws-nginx 경유 — 어디서나 동작) 또는 **WebTransport**(HTTP/3·UDP, 전용 포트 — 데이터그램으로 오디오).
- 인증: 백엔드가 발급한 짧은 HMAC 토큰(§6). 릴레이는 DB 없이 서명만 검증한다.
- 손실 복구: XOR 패리티 4:1(송신자가 생성) + NACK 재전송(릴레이 캐시에서, 송신자 업링크를 안 쓴다) + 수신 측 PLC.

## 1. 공통 헤더 (24 B, big-endian)

모든 메시지(WebSocket 바이너리 메시지 1개 / WebTransport 데이터그램 1개 / 스트림 프레임 1개)는 이 헤더로 시작한다.

| 오프셋 | 크기 | 필드 | 설명 |
|---|---|---|---|
| 0 | u8 | `ver` | 항상 `1`. 다른 값은 버린다 |
| 1 | u8 | `type` | §2 |
| 2 | u8 | `codec` | `0` pcm_s16 · `1` pcm_s24 · `2` pcm_f32 · `3` flac · `4` opus(패스스루) · `5` pcm_s32(32-bit 정수 LE, 데스크톱 하이레조) |
| 3 | u8 | `flags` | bit0 `FEC`(이 스트림은 패리티를 보낸다) · bit1 `RETRANSMIT`(NACK 재전송) · bit2 `KEYFRAME`(코덱 셋업 동반, FLAC STREAMINFO) · bit3 `MUTED`(무음 프레임) |
| 4 | u8 | `channels` | 1~8 |
| 5 | u8 | `bits` | 16 / 24 / 32 |
| 6 | u16 | `frame` | 프레임 길이(채널당 샘플 수). 48 kHz 10 ms = 480 |
| 8 | u32 | `rate` | 샘플레이트 Hz |
| 12 | u32 | `seq` | 프레임 일련번호(프레임마다 +1, 단편은 같은 값). 패리티는 그룹 마지막 프레임의 seq |
| 16 | u32 | `ts` | 프레임 첫 샘플의 샘플 인덱스(랩어라운드). 지터·드리프트 추정용 |
| 20 | u16 | `src` | 송신 피어 번호. **클라이언트는 0 으로 보내고 릴레이가 찍는다**. 0 = 릴레이 자신 |
| 22 | u8 | `frag_idx` | 단편 번호(0부터) |
| 23 | u8 | `frag_cnt` | 단편 수(1 = 단편 없음). `frag_idx < frag_cnt` 아니면 폐기 |
| 24 | … | payload | 길이는 메시지 길이에서 암시. 최대 메시지 64 KiB |

PCM 페이로드는 **interleaved little-endian**(s16/s24 packed 3 B/s32/f32), 채널 순서 L R …. 프레임 바이트 = `frame × channels × bits/8`
(48 kHz · 24-bit · 2ch · 10 ms = 2,880 B, 2.5 ms = 720 B).

### 단편화
WebTransport 데이터그램은 경로 MTU(보통 ~1,200 B)를 넘을 수 없다. 프레임이 `maxDatagramSize − 24` 보다 크면 송신자가 페이로드를
균등 분할해 `frag_idx/frag_cnt` 로 보낸다. 수신자는 `(src, seq)` 로 모아 전부 도착하면 프레임 완성, 하나라도 빠지면 그 프레임은 손실로 본다.
WebSocket 은 메시지 경계가 있으므로 단편화하지 않는다(`frag_cnt=1`).

## 2. 메시지 종류 (`type`)

| 값 | 이름 | 방향 | payload |
|---|---|---|---|
| 0 | `AUDIO` | 송신자 → 릴레이 → 수신자 | 오디오 프레임(또는 단편) |
| 1 | `PARITY` | 송신자 → 릴레이 → 수신자 | §3 XOR 패리티 |
| 2 | `NACK` | 수신자 → 릴레이 | `src` = 재전송을 원하는 송신 피어, payload = `u32 seq` 목록(최대 64) |
| 3 | `PING` | 양방향 | 8 B 불투명 값(보통 송신 시각 µs). 받은 쪽은 **같은 경로로** 그대로 `PONG` |
| 4 | `PONG` | 양방향 | PING 의 payload 복사 |
| 5 | `CTRL` | 양방향 | UTF-8 JSON(§5) |

릴레이는 `AUDIO`/`PARITY` 만 팬아웃한다. `NACK`·`PING`·`CTRL` 은 릴레이가 소비한다.

## 3. 손실 복구

### 3.1 XOR 패리티 4:1 (`flags.FEC`)
송신자는 연속 4 프레임 `seq = 4g … 4g+3` 마다 패리티 1개를 보낸다(대역 +25%).
- `type=PARITY`, `seq = 4g+3`(수신자는 `seq & ~3` 으로 그룹 시작을 찾는다), 나머지 헤더는 오디오와 동일.
- payload = 4개 프레임 payload 의 XOR. **고정 길이 PCM 전용** — FLAC/Opus 처럼 길이가 변하면 패리티를 보내지 않는다(`FEC` 비트 0).
- 수신: 그룹 안에서 정확히 1 프레임이 빠지면 나머지 3 + 패리티의 XOR 로 복원. 2개 이상 빠지면 NACK/PLC.
- 패리티도 데이터그램 크기에 맞춰 단편화한다.

### 3.2 NACK 재전송
릴레이는 송신자별로 최근 오디오 프레임을 **512 슬롯 링 캐시**(2.5 ms 프레임 1.28 s, 10 ms 프레임 5.1 s — 약속은 500 ms)에 보관한다.
수신자가 `(src, seq[])` 로 NACK 을 보내면 릴레이가 캐시의 단편 전부를 `flags|=RETRANSMIT`, `src` 를 원 송신자로 찍어 **신뢰 경로**
(WebTransport 스트림 / WebSocket)로 되돌려 준다. 송신자는 관여하지 않는다. 캐시에 없으면 무응답.
NACK 은 수신 버퍼가 `RTT + 1 프레임` 이상일 때만 의미가 있다(그 전에 재생 시점이 지난다) — 클라이언트가 판단한다.
WebSocket 은 TCP 라 손실이 없지만 릴레이가 (테스트 드롭 등으로) 빠뜨린 프레임은 같은 식으로 받을 수 있다.

### 3.3 PLC(수신 측)
패리티·재전송으로 못 채운 자리: 직전 프레임 반복 + 선형 페이드(JackTrip Regulator 식), 연속 손실이 길어지면 무음. 프로토콜 밖, 클라이언트 구현.

## 4. 전송

### 4.1 WebSocket — `GET /audiorelay/ws`
- 하위 프로토콜 `Sec-WebSocket-Protocol: jw.relay, jw.token.<base64url(token)>` (백엔드 채팅 WS 와 같은 관례). 서버는 `jw.relay` 를 선택한다.
  비브라우저 클라이언트는 `Authorization: Bearer <token>` 도 된다. **쿼리스트링 토큰은 받지 않는다**(nginx error_log 평문 노출).
- 토큰이 틀리면 업그레이드 전에 `401`.
- 모든 메시지는 바이너리, 메시지 1개 = 패킷 1개(헤더+payload). 텍스트 메시지는 무시.
- 신뢰·순서 보장이라 `SendUnreliable`/`SendReliable` 둘 다 같은 소켓.

### 4.2 WebTransport — `https://<host>:<port>/audiorelay/wt`
- QUIC DATAGRAM: `AUDIO`·`PARITY`·(선택)`PING/PONG`. 패킷 1개 = 데이터그램 1개.
- 클라이언트가 **먼저 여는 양방향 스트림 1개** = 제어 채널: `CTRL`·`NACK`·재전송·통계 푸시.
  - 스트림 프레이밍: `u16 BE 길이 + 패킷`(최대 65,535 B).
  - **첫 프레임은 반드시** `CTRL {"t":"auth","token":"…"}` — 5 s 안에 안 오거나 서명이 틀리면 세션 종료(코드 1/2).
    브라우저는 WebTransport 핸드셰이크에 헤더를 못 붙이고, URL 에 토큰을 싣는 것은 거부한다.
- 인증서: 공인 CA 발급(LE)이면 브라우저가 그대로 신뢰. 자가서명 모드(LAN/테스트)는 ECDSA P-256·13일짜리를 릴레이가 만들고
  `GET /audiorelay/info` 의 `webtransport.cert_hash`(leaf DER sha-256 hex)를 클라이언트가 `serverCertificateHashes` 로 넣는다.
- QUIC 설정: datagram 활성, idle 30 s, keep-alive 10 s.

## 5. CTRL JSON

릴레이 → 클라이언트 (`src=0`):

```jsonc
{"t":"welcome","room":"voice-<채널id>","peer":3,"uid":"…","transport":"webtransport","server_time_ms":…,
 "peers":[{"peer":1,"uid":"…","name":"…","identity":"u-…","transport":"websocket"}]}
{"t":"peer_joined","peer":4,"uid":"…","name":"…","identity":"u-…","transport":"…"}
{"t":"peer_left","peer":4,"uid":"…"}
{"t":"stats","room":"…","server_time_ms":…,"peers":[ PeerStats… ]}   // 1 s 마다
```

클라이언트 → 릴레이:

```jsonc
{"t":"auth","token":"…"}                   // WebTransport 스트림 첫 프레임만
{"t":"stats", …임의 필드(≤4 KiB)… }         // 수신 측 통계 보고. 릴레이가 PeerStats.client 로 그대로 재배포
```

`PeerStats`(릴레이가 재는 값): `peer uid name transport format{codec rate channels bits frame_samples frame_ms fec nominal_bps}`
`bitrate_in_bps bitrate_out_bps`(직전 1 s, 헤더 포함) `packets_in bytes_in loss_in`(릴레이가 못 받은 업링크 프레임) `dup_in`
`packets_out bytes_out dropped_out nack_recv retx_sent bad_packets rtt_ms rtt_avg_ms`(릴레이가 1 s 마다 보내는 PING 왕복) `client`(클라이언트 보고).

## 6. 릴레이 토큰

`base64url(JSON claims) "." base64url(HMAC-SHA256(secret, base64url(JSON claims)))`

claims: `{"room":"voice-<채널id>","uid":"<사용자id>","name":"<표시이름>","identity":"<LiveKit identity, 선택>","iat":…,"exp":…,"nonce":"…"}`.
`identity` 는 같은 세션의 LiveKit identity(음성채널 presence 키). 릴레이는 welcome/peer_joined/통계에 그대로 실어 주고,
클라이언트는 이것으로 릴레이 피어 ↔ LiveKit 참가자를 짝지어 **같은 사람의 Opus 호환 스트림을 끄고 PCM 을 듣는다**.
- secret = `.env` 의 `AUDIORELAY_SECRET`(백엔드와 릴레이가 공유). 16 B 미만이면 릴레이가 기동을 거부한다.
- TTL 120 s(백엔드 `POST /api/chat/channels/{id}/voice/relay-token`), 릴레이는 5 s 시계 오차 허용.
- 백엔드가 채널 멤버십을 확인한 뒤 발급하므로 릴레이는 DB 가 없다. 방 번호 = 토큰의 `room`.
- 같은 토큰으로 `GET /audiorelay/stats`(`Authorization: Bearer`)를 부르면 **그 방의** 통계만 돌아온다.

## 7. HTTP

| 경로 | 설명 |
|---|---|
| `GET /audiorelay/health` | `{"ok":true,…}` — 컨테이너 헬스체크는 `audiorelay -check` |
| `GET /audiorelay/info` | `{version, protocol:1, ws_path, webtransport:{url, self_signed, cert_hash?, not_after?} \| null, summary:{rooms,peers}}` |
| `GET /audiorelay/stats` | 토큰 필요. 방 통계(§5 PeerStats) |
| `GET /audiorelay/ws` | WebSocket |
| `CONNECT /audiorelay/wt` | WebTransport(HTTP/3 포트) |

## 8. 한도·동작

- 방 256개, 방당 16명(env). 넘으면 접속 거부(WS 1013 / WT 세션 종료 코드 3).
- 피어별 송신 큐: 비신뢰 256개(가득 차면 **그 피어에게만** 드롭, `dropped_out` 증가), 신뢰 256개(가득 차면 느린 소비자로 간주해 끊는다).
- 업링크 seq 간격(1024 이내)은 `loss_in` 으로 센다. 늦게 온 프레임은 다시 뺀다. 1024 넘게 튀면 송신자 재시작으로 본다.
- `RELAY_TEST_DROP_PERCENT`(테스트 전용): 팬아웃 직전에 그 비율을 떨어뜨려 FEC/NACK 경로를 검증한다. 운영 compose 는 설정하지 않는다.

## 9. 버전 정책
`ver` 가 바뀌면 헤더 레이아웃이 바뀐 것이다. 같은 `ver` 안에서는 `flags` 비트·`codec` 값·`CTRL` 필드 추가만 허용(모르는 비트·코덱·필드는 무시 — 모르는 코덱의 스트림은 재생하지 않는다).
`codec 5 pcm_s32` 는 데스크톱 하이레조에서 더해졌다 — 릴레이는 보지 않고, 브라우저 무손실 클라이언트는 lib/lossless/pcm.ts 가 풀어 재생한다.
