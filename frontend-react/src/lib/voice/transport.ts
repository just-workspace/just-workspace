/**
 * 음성 채널 전송 계층의 확장점.
 *
 * 음질 단계(VoiceTier)마다 소리의 송수신 방식이 상이하다.
 *  - voice · music  → LiveKit(WebRTC Opus)  — lib/voice/transports/livekit.ts (이번 단계)
 *  - lossless       → 자체 중계(PCM/FLAC, WebTransport·WebSocket) — lib/lossless/* 와 audiorelay/
 *  - hires          → 데스크톱 앱 네이티브(WASAPI exclusive) — 준비 중
 *
 * 세션(useVoice)은 본 인터페이스만 참조한다. 신규 단계는 registerVoiceTransport(tier, factory) 로 등록한다 —
 * 등록되지 않은 단계는 음질 선택에서 "준비 중"(비활성)으로 표시된다. 본 파일은 lib/lossless 가 import 할 수 있도록
 * livekit-client 를 import 하지 않는다(순수 타입·레지스트리).
 */

export type VoiceTier = 'voice' | 'music' | 'lossless' | 'hires'

/** 전송 계층에 전달하는 송신 설정(단계 + 해당 단계의 고급값) */
export interface VoiceSendConfig {
  tier: VoiceTier
  /** 음악 단계 Opus 목표 비트레이트(bps). 96k~510k */
  musicBitrate: number
  /** 마이크 장치. 미지정 시 기본 장치 */
  micDeviceId?: string
  /**
   * 음성 처리 — 음질 단계와 별개(디스코드와 동일). 미지정 시 활성화. Opus 단계(voice·music)만 참조한다.
   * 무손실·하이레조는 비트 보존이 목적이므로 항상 비활성화. 음악 단계에서 에코 제거를 활성화하면 브라우저가 모노로 병합하므로 모노로 송신한다.
   */
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  /**
   * 고급 — 무손실·하이레조 전송(lib/lossless)이 참조한다. Opus 단계는 무시(48k 고정).
   * 샘플레이트는 "요청"이다(장치가 지원하지 않으면 전송이 장치 값으로 낮추고 stats 에 실제 값을 기록한다).
   */
  sampleRate?: VoiceSampleRate
  /** 비트심도 — 무손실 단계부터 선택 가능 */
  bitDepth?: VoiceBitDepth
  /** 수신 버퍼 목표 — 'auto'(80–300 ms 자동) 또는 고정(안정화) ms */
  bufferTarget?: VoiceBufferTarget
}

export type VoiceSampleRate = 44100 | 48000 | 96000
export type VoiceBitDepth = 16 | 24
export type VoiceBufferTarget = 'auto' | 60 | 120 | 250
export const VOICE_SAMPLE_RATES: readonly VoiceSampleRate[] = [44100, 48000, 96000]
export const VOICE_BIT_DEPTHS: readonly VoiceBitDepth[] = [16, 24]
export const VOICE_BUFFER_TARGETS: readonly VoiceBufferTarget[] = ['auto', 60, 120, 250]

/** 접속 상태 — 미니 통화 창(useMeetings MeetingConnectionState)과 동일한 어휘 */
export type VoiceConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'rejoining'

/** 전송 계층 관점의 참가자(사용자 정보는 서버 presence 와 identity 로 대응시킨다) */
export interface VoicePeer {
  identity: string
  name: string
  isLocal: boolean
  isSpeaking: boolean
  /** 마이크 트랙 음소거(LiveKit publication) */
  micMuted: boolean
  /** 화면 공유 소리(음악 공유) 송신 중 */
  sharingAudio: boolean
}

/** "증명" 패널에 표시하는 실측치. 미확인 값은 null */
export interface VoiceStats {
  /** 송신 코덱(예: 'opus' · 'L16' · 'PCM 24/48') */
  codec: string | null
  /** 송신 채널 수(1·2) */
  channels: number | null
  /** 송신 샘플레이트(Hz) */
  sampleRate: number | null
  /** 송신 비트레이트(bps, 1초 이동 평균) */
  sendBitrate: number | null
  /** 수신 비트레이트 합(bps) */
  recvBitrate: number | null
  /** 왕복 지연(ms) */
  rttMs: number | null
  /** 상대가 관측한 본인 지터(ms) */
  jitterMs: number | null
  /** 상대가 관측한 본인 패킷 손실(누계) */
  packetsLost: number | null
  /** 본인 수신 측에서 PLC 로 은닉한 샘플(누계) */
  concealedSamples: number | null
  /** 본인 수신 측 손실 패킷(누계) */
  recvPacketsLost: number | null
  /** 수신 지터 버퍼 목표/실제(ms) */
  jitterBufferMs: number | null
  /** SDP fmtp 원문(예: 'minptime=10;useinbandfec=0;stereo=1;…') */
  fmtp: string | null
  /** 송신 패킷(누계) */
  packetsSent: number | null

  // ─── 무손실 티어(lib/lossless)가 추가하는 값 — LiveKit 티어는 미설정 ───
  /** 실제 전송: 'webtransport' | 'websocket' */
  transport?: 'webtransport' | 'websocket' | null
  /** WebSocket 으로 fallback 된 경우 그 사유(no_webtransport_api · handshake_timeout · udp_blocked · …) */
  fallbackReason?: string | null
  /** 송신 포맷 원문 — codec·sampleRate·bits·channels·frameMs·fec */
  format?: { codec: string; sampleRate: number; bits: number; channels: number; frameMs: number; fec: boolean } | null
  /** 수신 지터버퍼 목표(ms, 피어 중 최대) */
  bufferMs?: number | null
  /** 복구한 프레임(FEC + NACK 재전송, 누계) */
  recovered?: number | null
  /** 리샘플 없음(장치=스트림=재생 레이트) — "무손실 24/48" 배지는 이 값이 true 일 때만 표시 */
  bitExact?: boolean | null
  /** 추정 입-출 지연(ms) */
  latencyMs?: number | null

  // ─── 하이레조 티어(lib/hires, 데스크톱 앱)가 추가하는 값 ───
  /** 장치를 WASAPI exclusive 로 점유 중 */
  exclusive?: boolean | null
  /** exclusive + 장치 네이티브 포맷 그대로(변환·리샘플 없음) — "비트퍼펙트" 배지는 이 값이 true 일 때만 표시 */
  bitPerfect?: boolean | null
  /** 캡처 장치 이름(하이레조) */
  deviceName?: string | null
}

/** L/R 레벨 미터 값(dBFS, -100 = 무음) */
export interface VoiceLevels { left: number; right: number }

export interface VoiceTransportEvents {
  /** 접속 상태 변화 */
  state: (s: VoiceConnectionState) => void
  /** 참가자 목록(말하는 중·음소거 포함) 변경 */
  peers: (peers: VoicePeer[]) => void
  /** 상대 종료·재접속 실패 — 세션이 정리한다 */
  ended: (reason: string) => void
}

export interface VoiceJoinParams {
  /** 백엔드 토큰 응답 그대로 */
  token: string
  url: string
  identity: string
  /** 채널 id — 무손실 전송이 릴레이 토큰(…/voice/relay-token)을 발급받을 때 사용한다. 없으면 LiveKit 토큰의 room 에서 추출한다 */
  channelId?: string
  /** 입장과 동시에 음소거 */
  muted: boolean
  send: VoiceSendConfig
}

/**
 * 한 단계(또는 여러 단계)의 실제 송수신을 담당하는 구현. 세션(useVoice)이 join → 조작 → leave 순으로 사용한다.
 * 구현은 "자기 단계가 아닌 send.tier" 를 받으면 가장 가까운 단계로 강등하고 effectiveTier() 로 통지한다
 * (예: 무손실 중계 연결 실패로 음악으로 강등).
 */
export interface VoiceTransport {
  /** 본 전송이 송신 가능한 단계 */
  readonly tiers: readonly VoiceTier[]
  join(params: VoiceJoinParams): Promise<void>
  leave(): Promise<void>
  /** 송신 설정 변경(단계·비트레이트·장치). 접속 중이면 트랙을 재생성한다 */
  setSend(cfg: VoiceSendConfig): Promise<void>
  /** 현재 실제 송신 단계(강등 반영) */
  effectiveTier(): VoiceTier
  setMuted(muted: boolean): Promise<void>
  /** 듣기 끔 — 수신한 소리를 재생하지 않는다 */
  setDeafened(deafened: boolean): void
  /** 화면 공유 소리(음악 공유) 활성화/비활성화. 활성화 불가 시(소리 없이 공유한 경우) false */
  setScreenAudio(on: boolean): Promise<boolean>
  /** 수신한 참가자 오디오를 연결할 요소를 세션이 전달한다(없으면 전송이 자체 재생) */
  attachRemoteAudio(container: HTMLElement | null): void
  /** 1초 주기로 호출된다 */
  getStats(): Promise<VoiceStats>
  /** 내 송신 레벨 L/R */
  getLevels(): VoiceLevels
  peers(): VoicePeer[]
  on<K extends keyof VoiceTransportEvents>(ev: K, fn: VoiceTransportEvents[K]): () => void
  /**
   * (선택) 본인 마이크 상태 — 'denied' 이면 권한이 없어 수신 전용인 상태(상태 "권한 없음").
   * join 은 마이크가 없어도 성공해야 한다(입장은 차단하지 않는다). 재시도는 setSend 로 수행한다.
   */
  micState?(): 'ok' | 'denied'
  /** (선택) 한 참가자의 수신 음량(0..1) — 음악 공유 띠의 [공유 음량] */
  setParticipantVolume?(identity: string, volume: number): void
  /** (선택) 사용자별 음량(0..2 = 0–200%) — 본인에게만 적용되는 음량. setParticipantVolume 과 곱한다 */
  setParticipantGain?(identity: string, gain: number): void
}

export type VoiceTransportFactory = () => VoiceTransport

const registry = new Map<VoiceTier, VoiceTransportFactory>()

/** 단계에 전송 구현을 등록한다(한 팩토리를 여러 단계에 등록 가능) */
export function registerVoiceTransport(tiers: readonly VoiceTier[], factory: VoiceTransportFactory) {
  for (const t of tiers) registry.set(t, factory)
}

/** 해당 단계를 송신할 전송의 존재 여부(없으면 선택기에 "준비 중") */
export function hasVoiceTransport(tier: VoiceTier): boolean {
  return registry.has(tier)
}

export function getVoiceTransportFactory(tier: VoiceTier): VoiceTransportFactory | null {
  return registry.get(tier) ?? null
}

/** 테스트용 */
export function _resetVoiceTransports() { registry.clear() }

/** 단계 설명·표시 메타(문구 키는 i18n chat.voice.tier.*) */
export const VOICE_TIERS: readonly VoiceTier[] = ['voice', 'music', 'lossless', 'hires']

/** 모바일(폰)에서는 표시하지 않는 단계 — 장치 독점은 데스크톱 앱 전용 */
export const VOICE_TIERS_MOBILE_HIDDEN: readonly VoiceTier[] = ['hires']
