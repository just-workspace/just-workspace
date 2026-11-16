# audiorelay 전송 프로토콜 v1

Just Workspace 음성채널의 **무손실** 음질 단계에서 사용하는 중계 프로토콜이다(구조와 활성화 절차는 [docs/voice-lossless.md](../docs/voice-lossless.md) 참조). 릴레이(`ws-audiorelay`)는 SFU 방식의 순수 포워더이다 —
**디코딩·트랜스코딩을 일절 수행하지 않으며**, 송신자의 프레임을 동일한 방의 다른 멤버에게 바이트 단위로 변경 없이 전달한다.
릴레이가 변경하는 바이트는 헤더의 `src`(송신 피어 번호) 2바이트와, 재전송 시 `flags` 의 1비트에 한정된다.

- 전송: **WebSocket**(`/audiorelay/ws`, ws-nginx 경유 — 모든 환경에서 동작) 또는 **WebTransport**(HTTP/3·UDP, 전용 포트 — 오디오를 데이터그램으로 전송).
- 인증: 백엔드가 발급한 단기 HMAC 토큰(§6). 릴레이는 DB 없이 서명만 검증한다.
- 손실 복구: XOR 패리티 4:1(송신자가 생성) + NACK 재전송(릴레이 캐시에서 수행, 송신자 업링크를 사용하지 않음) + 수신 측 PLC.

## 1. 공통 헤더 (24 B, big-endian)

모든 메시지(WebSocket 바이너리 메시지 1개 / WebTransport 데이터그램 1개 / 스트림 프레임 1개)는 이 헤더로 시작한다.

| 오프셋 | 크기 | 필드 | 설명 |
|---|---|---|---|
| 0 | u8 | `ver` | 항상 `1`. 다른 값은 폐기한다 |
| 1 | u8 | `type` | §2 |
| 2 | u8 | `codec` | `0` pcm_s16 · `1` pcm_s24 · `2` pcm_f32 · `3` flac · `4` opus(패스스루) · `5` pcm_s32(32-bit 정수 LE, 데스크톱 하이레조) |
| 3 | u8 | `flags` | bit0 `FEC`(이 스트림은 패리티를 전송한다) · bit1 `RETRANSMIT`(NACK 재전송) · bit2 `KEYFRAME`(코덱 셋업 동반, FLAC STREAMINFO) · bit3 `MUTED`(무음 프레임) |
| 4 | u8 | `channels` | 1~8 |
| 5 | u8 | `bits` | 16 / 24 / 32 |
| 6 | u16 | `frame` | 프레임 길이(채널당 샘플 수). 48 kHz 10 ms = 480 |
| 8 | u32 | `rate` | 샘플레이트 Hz |
| 12 | u32 | `seq` | 프레임 일련번호(프레임마다 +1, 단편은 동일 값). 패리티는 그룹 마지막 프레임의 seq |
| 16 | u32 | `ts` | 프레임 첫 샘플의 샘플 인덱스(랩어라운드). 지터·드리프트 추정용 |
| 20 | u16 | `src` | 송신 피어 번호. **클라이언트는 0 으로 전송하고 릴레이가 기록한다**. 0 = 릴레이 자신 |
| 22 | u8 | `frag_idx` | 단편 번호(0부터) |
| 23 | u8 | `frag_cnt` | 단편 수(1 = 단편 없음). `frag_idx < frag_cnt` 가 아니면 폐기 |
| 24 | … | payload | 길이는 메시지 길이에서 암시. 최대 메시지 64 KiB |

PCM 페이로드는 **interleaved little-endian**(s16/s24 packed 3 B/s32/f32)이며 채널 순서는 L R … 이다. 프레임 바이트 = `frame × channels × bits/8`
(48 kHz · 24-bit · 2ch · 10 ms = 2,880 B, 2.5 ms = 720 B).

### 단편화
WebTransport 데이터그램은 경로 MTU(통상 ~1,200 B)를 초과할 수 없다. 프레임이 `maxDatagramSize − 24` 보다 크면 송신자가 페이로드를
균등 분할해 `frag_idx/frag_cnt` 로 전송한다. 수신자는 `(src, seq)` 를 기준으로 단편을 수집하며, 전부 도착하면 프레임이 완성되고 하나라도 누락되면 해당 프레임을 손실로 처리한다.
WebSocket 은 메시지 경계가 있으므로 단편화하지 않는다(`frag_cnt=1`).

## 2. 메시지 종류 (`type`)

| 값 | 이름 | 방향 | payload |
|---|---|---|---|
| 0 | `AUDIO` | 송신자 → 릴레이 → 수신자 | 오디오 프레임(또는 단편) |
| 1 | `PARITY` | 송신자 → 릴레이 → 수신자 | §3 XOR 패리티 |
| 2 | `NACK` | 수신자 → 릴레이 | `src` = 재전송 대상 송신 피어, payload = `u32 seq` 목록(최대 64) |
| 3 | `PING` | 양방향 | 8 B 불투명 값(통상 송신 시각 µs). 수신 측은 **동일 경로로** 그대로 `PONG` 을 회신한다 |
| 4 | `PONG` | 양방향 | PING 의 payload 복사 |
| 5 | `CTRL` | 양방향 | UTF-8 JSON(§5) |

릴레이는 `AUDIO`/`PARITY` 만 팬아웃한다. `NACK`·`PING`·`CTRL` 은 릴레이가 소비한다.

## 3. 손실 복구

### 3.1 XOR 패리티 4:1 (`flags.FEC`)
송신자는 연속 4 프레임 `seq = 4g … 4g+3` 마다 패리티 1개를 전송한다(대역 +25%).
- `type=PARITY`, `seq = 4g+3`(수신자는 `seq & ~3` 으로 그룹 시작을 산출한다), 나머지 헤더는 오디오와 동일.
- payload = 4개 프레임 payload 의 XOR. **고정 길이 PCM 전용** — FLAC/Opus 와 같이 길이가 가변인 경우 패리티를 전송하지 않는다(`FEC` 비트 0).
- 수신: 그룹 내에서 정확히 1 프레임이 누락되면 나머지 3 + 패리티의 XOR 로 복원한다. 2개 이상 누락되면 NACK/PLC 로 처리한다.
- 패리티도 데이터그램 크기에 맞춰 단편화한다.

### 3.2 NACK 재전송
릴레이는 송신자별로 최근 오디오 프레임을 **512 슬롯 링 캐시**(2.5 ms 프레임 1.28 s, 10 ms 프레임 5.1 s — 보장 범위는 500 ms)에 보관한다.
수신자가 `(src, seq[])` 로 NACK 을 전송하면 릴레이는 캐시의 해당 단편 전부를 `flags|=RETRANSMIT` 로 표시하고 `src` 를 원 송신자로 기록하여 **신뢰 경로**
(WebTransport 스트림 / WebSocket)로 재전송한다. 송신자는 관여하지 않는다. 캐시에 없는 경우 응답하지 않는다.
NACK 은 수신 버퍼가 `RTT + 1 프레임` 이상인 경우에만 유효하다(그 미만이면 재생 시점이 먼저 경과한다) — 판단은 클라이언트가 수행한다.
WebSocket 은 TCP 기반이므로 전송 손실이 없으나, 릴레이가 (테스트 드롭 등으로) 누락한 프레임은 동일한 방식으로 재수신할 수 있다.

### 3.3 PLC(수신 측)
패리티·재전송으로 복구되지 않은 구간: 직전 프레임 반복 + 선형 페이드(JackTrip Regulator 방식), 연속 손실이 길어지면 무음으로 처리한다. 프로토콜 범위 외이며 클라이언트 구현 사항이다.

## 4. 전송

### 4.1 WebSocket — `GET /audiorelay/ws`
- 하위 프로토콜 `Sec-WebSocket-Protocol: jw.relay, jw.token.<base64url(token)>` (백엔드 채팅 WS 와 동일한 관례). 서버는 `jw.relay` 를 선택한다.
  비브라우저 클라이언트는 `Authorization: Bearer <token>` 도 사용할 수 있다. **쿼리스트링 토큰은 허용하지 않는다**(nginx error_log 평문 노출).
- 토큰이 유효하지 않으면 업그레이드 전에 `401` 을 반환한다.
- 모든 메시지는 바이너리이며, 메시지 1개 = 패킷 1개(헤더+payload)이다. 텍스트 메시지는 무시한다.
- 신뢰·순서 보장 전송이므로 `SendUnreliable`/`SendReliable` 모두 동일 소켓을 사용한다.

### 4.2 WebTransport — `https://<host>:<port>/audiorelay/wt`
- QUIC DATAGRAM: `AUDIO`·`PARITY`·(선택)`PING/PONG`. 패킷 1개 = 데이터그램 1개.
- 클라이언트가 **최초로 여는 양방향 스트림 1개** = 제어 채널: `CTRL`·`NACK`·재전송·통계 푸시.
  - 스트림 프레이밍: `u16 BE 길이 + 패킷`(최대 65,535 B).
  - **첫 프레임은 반드시** `CTRL {"t":"auth","token":"…"}` 이어야 한다 — 5 s 이내에 수신되지 않거나 서명이 유효하지 않으면 세션을 종료한다(코드 1/2).
    브라우저는 WebTransport 핸드셰이크에 헤더를 추가할 수 없으며, URL 에 토큰을 포함하는 방식은 허용하지 않는다.
- 인증서: 공인 CA 발급(LE) 인증서는 브라우저가 그대로 신뢰한다. 자가서명 모드(LAN/테스트)에서는 릴레이가 ECDSA P-256·유효 기간 13일의 인증서를 생성하고,
  클라이언트가 `GET /audiorelay/info` 의 `webtransport.cert_hash`(leaf DER sha-256 hex)를 `serverCertificateHashes` 로 지정한다.
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

`PeerStats`(릴레이 측정값): `peer uid name transport format{codec rate channels bits frame_samples frame_ms fec nominal_bps}`
`bitrate_in_bps bitrate_out_bps`(직전 1 s, 헤더 포함) `packets_in bytes_in loss_in`(릴레이가 수신하지 못한 업링크 프레임) `dup_in`
`packets_out bytes_out dropped_out nack_recv retx_sent bad_packets rtt_ms rtt_avg_ms`(릴레이가 1 s 마다 전송하는 PING 왕복) `client`(클라이언트 보고).

## 6. 릴레이 토큰

`base64url(JSON claims) "." base64url(HMAC-SHA256(secret, base64url(JSON claims)))`

claims: `{"room":"voice-<채널id>","uid":"<사용자id>","name":"<표시이름>","identity":"<LiveKit identity, 선택>","iat":…,"exp":…,"nonce":"…"}`.
`identity` 는 동일 세션의 LiveKit identity(음성채널 presence 키)이다. 릴레이는 이를 welcome/peer_joined/통계에 그대로 포함하며,
클라이언트는 이 값으로 릴레이 피어 ↔ LiveKit 참가자를 대응시켜 **동일 참가자의 Opus 호환 스트림을 비활성화하고 PCM 을 재생한다**.
- secret = `.env` 의 `AUDIORELAY_SECRET`(백엔드와 릴레이가 공유). 32 B 미만이면 릴레이가 기동을 거부한다(백엔드의 기동 검사도 동일한 길이를 요구한다).
- TTL 120 s(백엔드 `POST /api/chat/channels/{id}/voice/relay-token`), 릴레이는 5 s 의 시계 오차를 허용한다.
- 백엔드가 채널 멤버십을 확인한 후 발급하므로 릴레이는 DB 를 사용하지 않는다. 방 번호 = 토큰의 `room`.
- 동일 토큰으로 `GET /audiorelay/stats`(`Authorization: Bearer`)를 호출하면 **해당 방의** 통계만 반환된다.

## 7. HTTP

| 경로 | 설명 |
|---|---|
| `GET /audiorelay/health` | `{"ok":true,…}` — 컨테이너 헬스체크는 `audiorelay -check` |
| `GET /audiorelay/info` | `{version, protocol:1, ws_path, webtransport:{url, self_signed, cert_hash?, not_after?} \| null, summary:{rooms,peers}}` |
| `GET /audiorelay/stats` | 토큰 필요. 방 통계(§5 PeerStats) |
| `GET /audiorelay/ws` | WebSocket |
| `CONNECT /audiorelay/wt` | WebTransport(HTTP/3 포트) |

## 8. 한도·동작

- 방 256개, 방당 16명(env). 초과 시 접속을 거부한다(WS 1013 / WT 세션 종료 코드 3).
- 피어별 송신 큐: 비신뢰 256개(포화 시 **해당 피어에 한해** 드롭, `dropped_out` 증가), 신뢰 256개(포화 시 저속 소비자로 간주해 연결을 종료한다).
- 업링크 seq 간격(1024 이내)은 `loss_in` 으로 집계한다. 지연 도착한 프레임은 집계에서 차감한다. 간격이 1024 를 초과하면 송신자 재시작으로 간주한다.
- `RELAY_TEST_DROP_PERCENT`(테스트 전용): 팬아웃 직전에 해당 비율만큼 드롭하여 FEC/NACK 경로를 검증한다. 운영 compose 에서는 설정하지 않는다.

## 9. 버전 정책
`ver` 의 변경은 헤더 레이아웃의 변경을 의미한다. 동일 `ver` 내에서는 `flags` 비트·`codec` 값·`CTRL` 필드의 추가만 허용한다(미지원 비트·코덱·필드는 무시한다 — 미지원 코덱의 스트림은 재생하지 않는다).
`codec 5 pcm_s32` 는 데스크톱 앱의 하이레조 단계가 전송한다 — 릴레이는 코덱을 검사하지 않으며, 브라우저 클라이언트는 `frontend-react/src/lib/lossless/pcm.ts` 가 디코딩해 재생한다.
