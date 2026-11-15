/**
 * 무손실 티어(Tier 3) 브라우저 클라이언트 — 공개 타입.
 *
 * 전송 규격은 audiorelay/PROTOCOL.md. 이 디렉터리는 음성채널 UI(다른 작업자)가 쓰는 라이브러리이고,
 * UI 는 `LosslessSession`(직접) 또는 `LosslessVoiceTransport`(티어 공통 `VoiceTransport` 어댑터)로 붙는다.
 */

/** pcm_s32 = 32-bit 정수(codec 5) — 데스크톱 하이레조가 보낸다. 브라우저는 받아서 재생만(송신은 f32 까지) */
export type LosslessCodec = 'pcm_s16' | 'pcm_s24' | 'pcm_f32' | 'flac' | 'opus' | 'pcm_s32'

export interface LosslessFormat {
  codec: LosslessCodec
  /** 스트림 샘플레이트. 송신은 장치(트랙) 레이트를 그대로 쓴다 — 리샘플 없음 */
  sampleRate: number
  channels: number
  bits: 16 | 24 | 32
  /** 프레임 길이(ms). 기본 10, 2.5·5·20 가능 */
  frameMs: number
  /** XOR 패리티 4:1 송신 여부(PCM 전용) */
  fec: boolean
}

/** 수신 버퍼: 자동(p95 지터 + 1프레임) 또는 "안정화" 고정 프리셋(ms) */
export type BufferPreset = 'auto' | 60 | 120 | 250

export type TransportKind = 'webtransport' | 'websocket'

export interface PeerInfo {
  peer: number
  uid: string
  name?: string
  /** 같은 세션의 LiveKit identity(음성 presence 키). 릴레이 토큰에 identity 를 실었을 때만 */
  identity?: string
  transport: TransportKind | string
}

/** 백엔드 `POST /api/chat/channels/{id}/voice/relay-token` 응답 */
export interface RelayGrant {
  token: string
  expires_in: number
  room: string
  /** 요청에 실어 보낸 LiveKit identity(검증됨) */
  identity?: string | null
  ws_url: string
  ws_path: string
  webtransport: { url: string; self_signed?: boolean; cert_hash?: string; not_after?: string } | null
  relay_version?: string
  protocol?: number
}

/** 수신 쪽(피어 1명) 통계 — 재생 워크릿의 지터버퍼 + 메인스레드 FEC/NACK 카운터 */
export interface PeerReceiveStats {
  peer: number
  format: LosslessFormat | null
  /** 수신 비트레이트(헤더 포함, 직전 1 s) */
  bitrateBps: number
  packets: number
  /** 지터버퍼 목표/실제 깊이 */
  targetMs: number
  depthMs: number
  jitterP95Ms: number
  jitterMeanMs: number
  /** 프레임 단위 */
  received: number
  lost: number
  recoveredFec: number
  recoveredNack: number
  nackSent: number
  plc: number
  late: number
  underruns: number
  dropped: number
  duplicates: number
  /** 이 피어 스트림이 자기 레이트로 재생되는가(컨텍스트 레이트 == 스트림 레이트) */
  bitExactPlayback: boolean
  level: { peak: number[]; rms: number[] }
}

export interface SessionStats {
  state: SessionState
  transport: TransportKind | null
  room: string | null
  peerId: number | null
  /** 송신 포맷(실제 장치 레이트 반영) */
  format: LosslessFormat | null
  capture: {
    requestedSampleRate: number
    deviceSampleRate: number
    deviceChannels: number
    contextSampleRate: number
    /** 트랙 레이트 == 컨텍스트 레이트 == 스트림 레이트 */
    bitExact: boolean
    level: { peak: number[]; rms: number[] }
  } | null
  /** 송신 비트레이트(헤더·패리티 포함, 직전 1 s) */
  bitrateOutBps: number
  framesSent: number
  /** 클라이언트가 재는 릴레이 왕복(오디오 경로) */
  rttMs: number
  /** 추정 입-출 지연 = 프레임 + RTT/2 + 버퍼 목표 + 출력 지연(대표 피어) */
  estimatedLatencyMs: number
  /** 위 추정의 구성 요소(ms) */
  latencyBreakdown: { frameMs: number; networkMs: number; bufferMs: number; outputMs: number }
  bufferPreset: BufferPreset
  peers: Record<number, PeerReceiveStats>
  /** 릴레이가 1 s 마다 보내는 방 통계(원문) */
  relay: RelayRoomStats | null
}

export type SessionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed'

export interface RelayPeerStats {
  peer: number
  uid: string
  name?: string
  transport: string
  format?: { codec: string; rate: number; channels: number; bits: number; frame_samples: number; frame_ms: number; fec: boolean; nominal_bps: number } | null
  bitrate_in_bps: number
  bitrate_out_bps: number
  packets_in: number
  bytes_in: number
  loss_in: number
  dup_in: number
  packets_out: number
  bytes_out: number
  dropped_out: number
  nack_recv: number
  retx_sent: number
  bad_packets: number
  rtt_ms: number
  rtt_avg_ms: number
  client?: unknown
}

export interface RelayRoomStats {
  t: 'stats'
  room: string
  server_time_ms: number
  peers: RelayPeerStats[]
}

export type LosslessEvent =
  | { type: 'state'; state: SessionState; reason?: string }
  | { type: 'connected'; transport: TransportKind; peerId: number; room: string; peers: PeerInfo[] }
  | { type: 'transport_fallback'; from: TransportKind; to: TransportKind; reason: string }
  | { type: 'peer_joined'; peer: PeerInfo }
  | { type: 'peer_left'; peer: number; uid: string }
  | { type: 'format'; format: LosslessFormat; capture: NonNullable<SessionStats['capture']> }
  | { type: 'peer_format'; peer: number; format: LosslessFormat }
  | { type: 'level'; peer: number | 'self'; peak: number[]; rms: number[] }
  | { type: 'stats'; stats: SessionStats }
  | { type: 'warning'; code: 'resampled_capture' | 'resampled_playback' | 'datagram_too_small' | 'unsupported_rate' | 'flac_unavailable'; message: string }
  | { type: 'error'; error: Error }

export type LosslessListener = (ev: LosslessEvent) => void

/*
 * 티어 공통 어댑터 규격은 lib/voice/transport.ts(`VoiceTransport`)가 정본이다.
 * 이 라이브러리는 adapter.ts 에서 그 인터페이스를 구현하고 register.ts 로 'lossless' 단계에 등록한다.
 */
