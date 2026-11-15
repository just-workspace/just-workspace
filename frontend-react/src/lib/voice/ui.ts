/**
 * 음성채널 화면의 상태 로직(handover-20 답) — 순수 함수만. 단위 테스트 대상(tests/voice/voiceUiLogic.test.ts).
 *
 *  · 단계 색(참고): 음성 neutral · 음악 primary · 무손실/하이레조 success(하이레조는 점에 링).
 *  · 접속 바 상태 글자 · 본문 띠(재연결/중계 실패/독점 실패/이어폰/권한 없음) 판정.
 *  · 스피커 출력 감지 휴리스틱(이어폰 권장 띠) — 라벨에 speaker/스피커… 가 있으면 스피커, 헤드폰 계열이면 이어폰, 모르면 unknown(띠 없음).
 *  · 레벨 미터 24칸 · dB 표기 · 무손실 비트레이트 · "안정화" 다음 값 · 실제 형식 글자.
 */
import { clampMusicBitrate, formatBitrate, VOICE_BITRATE } from './opus'
import type { VoiceBufferTarget, VoiceConnectionState, VoiceStats, VoiceTier } from './transport'

export type VoiceTone = 'neutral' | 'primary' | 'success'

export const TIER_TONE: Record<VoiceTier, VoiceTone> = { voice: 'neutral', music: 'primary', lossless: 'success', hires: 'success' }

/** 접속 바 음질 버튼의 점(시안 T[*].dotS) */
export function tierDotClass(tier: VoiceTier): string {
  switch (tier) {
    case 'music': return 'h-2 w-2 rounded-full bg-primary'
    case 'lossless': return 'h-2 w-2 rounded-full bg-success'
    case 'hires': return 'h-2 w-2 rounded-full bg-success ring-2 ring-success/40'
    default: return 'h-2 w-2 rounded-full bg-muted-foreground'
  }
}

/** 단계별 예상 지연(시안 tierDef.meta) */
export const TIER_LATENCY: Record<VoiceTier, string> = { voice: '~40 ms', music: '~60 ms', lossless: '100–300 ms', hires: '150–300 ms' }

/** 음악 이상이면 에코 제거가 꺼진다 → 이어폰 권장 */
export function isEarphoneTier(tier: VoiceTier): boolean {
  return tier !== 'voice'
}

// ─── 출력 장치 감지(이어폰 권장 띠) ───

export type SpeakerOutput = 'speaker' | 'headphones' | 'unknown'

const SPEAKER_RE = /\b(speaker|speakers|loudspeaker)\b|스피커|built-?in\s*(output|audio)|내장|realtek|hdmi|displayport|display\s*audio|monitor|nvidia high definition/i
const HEADPHONE_RE = /headphone|head-?set|earphone|ear-?bud|buds|airpods|헤드폰|헤드셋|이어폰|이어버드|bluetooth|블루투스|hands-?free|\bbt\b|wh-|wf-|audio-?technica|scarlett|interface/i

/**
 * 고른(또는 기본) 출력 장치 라벨로 스피커인지 판정. enumerateDevices 라벨은 권한이 없으면 비어 있다 → unknown.
 * 헤드폰 단서가 있으면 스피커 단서보다 우선한다("Speakers (Realtek) + Headphones" 같은 복합 라벨).
 */
export function detectSpeakerOutput(
  devices: ReadonlyArray<{ deviceId: string; label: string; isDefault?: boolean }>,
  selectedId?: string | null,
): SpeakerOutput {
  if (!devices.length) return 'unknown'
  const pick = (selectedId && devices.find(d => d.deviceId === selectedId)) || devices.find(d => d.isDefault) || devices[0]
  const label = (pick?.label || '').trim()
  if (!label) return 'unknown'
  if (HEADPHONE_RE.test(label)) return 'headphones'
  if (SPEAKER_RE.test(label)) return 'speaker'
  return 'unknown'
}

// ─── 접속 바 상태 ───

export type BarStatusKey = 'connected' | 'connecting' | 'reconnecting' | 'listenOnly' | 'disconnected'
export interface BarStatus { key: BarStatusKey; tone: 'success' | 'foreground' | 'warning'; dot: 'live' | 'connecting' | 'offline' }

export function barStatus(state: VoiceConnectionState, listenOnly: boolean): BarStatus {
  if (state === 'connecting') return { key: 'connecting', tone: 'foreground', dot: 'connecting' }
  if (state === 'reconnecting' || state === 'rejoining') return { key: 'reconnecting', tone: 'warning', dot: 'connecting' }
  if (state === 'disconnected') return { key: 'disconnected', tone: 'foreground', dot: 'offline' }
  if (listenOnly) return { key: 'listenOnly', tone: 'foreground', dot: 'live' }
  return { key: 'connected', tone: 'success', dot: 'live' }
}

/** 재연결 중 흐른 초("다시 연결하는 중… 3초") */
export function reconnectSeconds(since: number | null, now: number): number {
  if (!since) return 0
  return Math.max(0, Math.floor((now - since) / 1000))
}

// ─── 본문 띠 ───

export type VoiceBandKind = 'reconnect' | 'relayFail' | 'exclusiveFail' | 'earphone' | 'noPermission'
export interface VoiceBand { kind: VoiceBandKind; tone: 'warning' | 'danger'; icon: string }

export interface BandInput {
  connectionState: VoiceConnectionState
  /** 내가 고른 단계 */
  wantTier: VoiceTier
  /** 지금 실제로 보내는 단계 */
  effectiveTier: VoiceTier
  listenOnly: boolean
  speakerOutput: SpeakerOutput
  /** 하이레조 장치 독점 실패(데스크톱 앱) */
  exclusiveFailed: boolean
}

/** 보일 띠(위→아래 순). 같은 종류는 하나만 */
export function bandsFor(i: BandInput): VoiceBand[] {
  const out: VoiceBand[] = []
  if (i.connectionState === 'reconnecting' || i.connectionState === 'rejoining') out.push({ kind: 'reconnect', tone: 'warning', icon: 'wifi-off' })
  if (i.exclusiveFailed) out.push({ kind: 'exclusiveFail', tone: 'danger', icon: 'ban' })
  if (i.connectionState === 'connected' && i.wantTier === 'lossless' && i.effectiveTier === 'music') out.push({ kind: 'relayFail', tone: 'warning', icon: 'server' })
  if (i.listenOnly && i.connectionState === 'connected') out.push({ kind: 'noPermission', tone: 'warning', icon: 'lock' })
  if (i.speakerOutput === 'speaker' && isEarphoneTier(i.effectiveTier) && i.connectionState === 'connected') out.push({ kind: 'earphone', tone: 'warning', icon: 'alert-triangle' })
  return out
}

/** 권한 안내는 브라우저별 한 줄 — UA 로 가른다 */
export type BrowserKind = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other'
export function browserKind(ua: string): BrowserKind {
  if (/Edg\//.test(ua)) return 'edge'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

// ─── 레벨 미터 · 표기 ───

export type MeterSeg = 'on' | 'warn' | 'off'

/** 24칸 미터 — -60 dB 아래 0칸, 0 dB 24칸. 마지막 4칸(20~)은 warning */
export function meterSegments(db: number, n = 24): MeterSeg[] {
  const lit = Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * n)
  return Array.from({ length: n }, (_, i) => (i < lit ? (i >= n - 4 ? 'warn' : 'on') : 'off'))
}

/** '−9.4 dB' · 무음은 '−∞ dB' */
export function formatDb(db: number): string {
  if (db <= -99) return '−∞ dB'
  const v = Math.abs(db).toFixed(1)
  return `${db < 0 ? '−' : ''}${v} dB`
}

/** PCM 비트레이트(bps) = 레이트 × 비트 × 채널 */
export function losslessBitrate(sampleRate: number, bits: number, channels = 2): number {
  return sampleRate * bits * channels
}

/** [안정화] — 자동이면 120 고정, 고정이면 한 단계 올린다(끊김이 줄고 지연은 늘어난다) */
export function stabilizeNext(cur: VoiceBufferTarget): VoiceBufferTarget {
  if (cur === 'auto' || cur === 60) return 120
  return 250
}

/** 손실률(%) 표기 — 받은 패킷 대비 */
export function lossPercent(lost: number | null, total: number | null): string {
  if (lost == null || !total) return '—'
  return `${((lost / Math.max(1, total + lost)) * 100).toFixed(2)}%`
}

/**
 * 타일·접속 바의 "실제 형식" 한 줄.
 *  내 것(stats 있음): 'Opus 스테레오 509 kbps' / 'PCM 24/48 · 2.3 Mbps' — 실측 우선.
 *  남의 것(presence 단계만): 'Opus 모노 32 kbps' / 'Opus 스테레오' / 'PCM 24/48' / 'PCM 32/192'.
 */
export function actualFormat(
  tier: VoiceTier,
  stats: Pick<VoiceStats, 'codec' | 'channels' | 'sendBitrate' | 'sampleRate'> | null,
  cfg: { musicBitrate: number; sampleRate?: number; bitDepth?: number } | null,
  words: { mono: string; stereo: string },
): string {
  if (tier === 'lossless' || tier === 'hires') {
    const codec = stats?.codec && /^PCM/i.test(stats.codec)
      ? stats.codec
      : tier === 'hires' ? 'PCM 32/192' : `PCM ${cfg?.bitDepth ?? 24}/${Math.round((cfg?.sampleRate ?? 48000) / 1000)}`
    const m = codec.match(/(\d+)\/(\d+)/)
    const bps = stats?.sendBitrate ?? (m ? losslessBitrate(Number(m[2]) * 1000, Number(m[1])) : null)
    return bps ? `${codec} · ${formatBitrate(bps)}` : codec
  }
  const ch = stats?.channels ?? (tier === 'music' ? 2 : 1)
  const chWord = ch >= 2 ? words.stereo : words.mono
  if (tier === 'voice') return `Opus ${chWord} ${formatBitrate(VOICE_BITRATE)}`
  if (!cfg) return `Opus ${chWord}`
  const bps = stats?.sendBitrate && stats.sendBitrate > 0 ? stats.sendBitrate : clampMusicBitrate(cfg.musicBitrate)
  return `Opus ${chWord} ${formatBitrate(bps)}`
}

/** 왕복 지연 글자 — '142ms' / '—' */
export function formatRtt(ms: number | null | undefined): string {
  return ms == null || !Number.isFinite(ms) ? '—' : `${Math.round(ms)}ms`
}
