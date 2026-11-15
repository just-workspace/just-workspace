/**
 * Opus 레시피 — 순수 함수. 단위 테스트 대상(tests/voice/opus.test.ts).
 *
 *  음성: 48k mono ~32 kbps, AEC/NS/AGC 켬(Krisp 가 붙으면 브라우저 NS 는 끔), DTX 켬, RED 켬, 인밴드 FEC 켬.
 *  음악: 48k stereo 256~510 kbps, CBR, DTX 끔, RED 끔, FEC 끔(CELT 엔 인밴드 FEC 가 없다 — RFC 6716),
 *        forceStereo(stereo=1;sprop-stereo=1). Chrome 155 실측: maxaveragebitrate=510000;cbr=1 → ≈509 kbps.
 *
 *  음성 처리(AEC/NS/AGC)는 단계와 별개인 개인 설정(processingOf). 음악 단계에서 에코 제거를 켜면 모노(크롬이 다운믹스).
 *  음악 공유(화면 소리)는 늘 처리 끔·스테레오.
 *
 * livekit-client 가 해 주는 것: audioPreset.maxBitrate → 원격 SDP(answer)의 maxaveragebitrate · encodings.maxBitrate,
 * forceStereo → 로컬 stereo=1;sprop-stereo=1, dtx → 서버 answer 의 usedtx. 안 해 주는 것(cbr·useinbandfec)은
 * mungeOpusAnswer 로 answer 를 고친다(sdp.ts).
 */
import type { VoiceSendConfig, VoiceStats, VoiceTier } from './transport'

export const VOICE_BITRATE = 32_000
export const MUSIC_BITRATE_DEFAULT = 256_000
export const MUSIC_BITRATE_MIN = 96_000
export const MUSIC_BITRATE_MAX = 510_000   // RFC 7587 maxaveragebitrate 상한
export const MUSIC_BITRATE_STEP = 2_000

export function clampMusicBitrate(bps: number): number {
  if (!Number.isFinite(bps)) return MUSIC_BITRATE_DEFAULT
  const v = Math.round(bps / MUSIC_BITRATE_STEP) * MUSIC_BITRATE_STEP
  return Math.min(MUSIC_BITRATE_MAX, Math.max(MUSIC_BITRATE_MIN, v))
}

/** 이 단계가 LiveKit(Opus)으로 보내는 단계인가 */
export function isOpusTier(t: VoiceTier): t is 'voice' | 'music' {
  return t === 'voice' || t === 'music'
}

/** getUserMedia 제약(livekit-client AudioCaptureOptions 와 같은 이름) */
export interface OpusCapture {
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  channelCount: number
  sampleRate: number
  deviceId?: string
  /** 'voiceIsolation' 같은 브라우저 추가 제약은 쓰지 않는다 — 음악에서 소리를 바꾼다 */
}

/** livekit-client TrackPublishOptions 중 오디오에 관계된 것 */
export interface OpusPublish {
  audioPreset: { maxBitrate: number }
  dtx: boolean
  red: boolean
  forceStereo: boolean
  /** 접속 전 버퍼 — 음악엔 끔(지연) */
  preConnectBuffer: boolean
}

/** 원격 SDP(answer) 의 opus fmtp 에 강제할 값 */
export interface OpusFmtp {
  maxaveragebitrate: number
  stereo: 0 | 1
  cbr: 0 | 1
  usedtx: 0 | 1
  useinbandfec: 0 | 1
}

/** 음성 처리 실효값 — 비우면 켬 */
export function processingOf(cfg: Pick<VoiceSendConfig, 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'>) {
  return { aec: cfg.echoCancellation !== false, ns: cfg.noiseSuppression !== false, agc: cfg.autoGainControl !== false }
}

/** 음악 단계를 스테레오로 보내나 — 에코 제거를 켜면 브라우저가 모노로 합치니 모노 */
export function musicStereo(cfg: VoiceSendConfig): boolean {
  return cfg.tier === 'music' && !processingOf(cfg).aec
}

export function captureFor(cfg: VoiceSendConfig, krispActive: boolean): OpusCapture {
  const dev = cfg.micDeviceId ? { deviceId: cfg.micDeviceId } : {}
  const p = processingOf(cfg)
  // Krisp 가 붙으면 브라우저 NS 는 이중 처리라 끈다(useMeetings 와 같은 규칙)
  return { echoCancellation: p.aec, noiseSuppression: p.ns && !krispActive, autoGainControl: p.agc, channelCount: musicStereo(cfg) ? 2 : 1, sampleRate: 48_000, ...dev }
}

export function publishFor(cfg: VoiceSendConfig): OpusPublish {
  if (cfg.tier === 'music') {
    return { audioPreset: { maxBitrate: clampMusicBitrate(cfg.musicBitrate) }, dtx: false, red: false, forceStereo: musicStereo(cfg), preConnectBuffer: false }
  }
  return { audioPreset: { maxBitrate: VOICE_BITRATE }, dtx: true, red: true, forceStereo: false, preConnectBuffer: false }
}

export function fmtpFor(cfg: VoiceSendConfig): OpusFmtp {
  if (cfg.tier === 'music') {
    return { maxaveragebitrate: clampMusicBitrate(cfg.musicBitrate), stereo: musicStereo(cfg) ? 1 : 0, cbr: 1, usedtx: 0, useinbandfec: 0 }
  }
  return { maxaveragebitrate: VOICE_BITRATE, stereo: 0, cbr: 0, usedtx: 1, useinbandfec: 1 }
}

/** 화면 공유 소리(음악 공유)는 늘 음악 레시피 — 비트레이트는 음악 설정값 */
export function screenAudioConfig(cfg: VoiceSendConfig): VoiceSendConfig {
  return { ...cfg, tier: 'music', micDeviceId: undefined, krisp: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
}

/**
 * 단계 배지 글자. 예: 'Opus 32k · 모노' / 'Opus 256k · 스테레오' / 'PCM 24/48'. 실측(stats)이 있으면 그걸 우선.
 * 글자 조립만 — 번역이 필요한 단어(모노·스테레오)는 호출자가 넣는다.
 */
export function tierBadge(tier: VoiceTier, cfg: { musicBitrate: number; echoCancellation?: boolean }, stats: Pick<VoiceStats, 'codec' | 'channels' | 'sendBitrate'> | null, words: { mono: string; stereo: string }): string {
  if (tier === 'lossless') return stats?.codec && /^PCM/.test(stats.codec) ? stats.codec : 'PCM 24/48'
  if (tier === 'hires') return 'PCM 24/192'
  const codec = (stats?.codec || 'opus').replace(/^audio\//i, '')
  const name = codec.toLowerCase() === 'opus' ? 'Opus' : codec
  const target = tier === 'music' ? clampMusicBitrate(cfg.musicBitrate) : VOICE_BITRATE
  const kb = Math.round(target / 1000)
  const ch = stats?.channels ?? (tier === 'music' && cfg.echoCancellation === false ? 2 : 1)
  return `${name} ${kb}k · ${ch >= 2 ? words.stereo : words.mono}`
}

/** 비트레이트 표기 — 1234 → '1.2 kbps', 509_312 → '509 kbps', 2.3M → '2.3 Mbps' */
export function formatBitrate(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '—'
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`
  if (bps >= 10_000) return `${Math.round(bps / 1000)} kbps`
  return `${(bps / 1000).toFixed(1)} kbps`
}

/**
 * 목표 대비 실측이 많이 낮으면(70% 아래) 배지 색을 바꾼다(Teams 의 128→48 하향 고지 모델).
 * 음성은 DTX 로 침묵 때 0 에 가까우니 판단하지 않는다.
 */
export function isDegraded(tier: VoiceTier, targetBps: number, actualBps: number | null): boolean {
  if (tier !== 'music' || actualBps == null) return false
  return actualBps < targetBps * 0.7
}
