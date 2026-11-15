/**
 * 음성 채널 송신 설정의 로컬 저장(localStorage `voice.quality`). 사람마다(내가 보내는 소리) 고르는 값이라 기기 설정.
 * 서버 prefs(useUserPrefs)에 올리지 않는다 — 장치 id 는 기기마다 다르고, 음질 단계도 기기 성능에 따른다.
 */
import { clampMusicBitrate, MUSIC_BITRATE_DEFAULT } from './opus'
import {
  VOICE_BIT_DEPTHS, VOICE_BUFFER_TARGETS, VOICE_SAMPLE_RATES,
  type VoiceBitDepth, type VoiceBufferTarget, type VoiceSampleRate, type VoiceSendConfig, type VoiceTier,
} from './transport'

export const VOICE_PREFS_KEY = 'voice.quality'

export interface VoicePrefs extends VoiceSendConfig {
  /** 음악 단계 이어폰 경고를 봤다(다시 보이지 않게) */
  earphoneAck: boolean
  /** 스피커(출력) 장치 */
  speakerDeviceId?: string
  /** 접속 바의 "증명" 패널을 펼쳐 둔 채로 */
  statsOpen: boolean
  /** 고급 — 무손실·하이레조 송신 샘플레이트 요청 */
  sampleRate: VoiceSampleRate
  /** 고급 — 비트심도(무손실부터) */
  bitDepth: VoiceBitDepth
  /** 고급 — 수신 버퍼 목표 */
  bufferTarget: VoiceBufferTarget
  /** 하이레조 장치 독점 확인창 "다음부터 묻지 않기" */
  hiresAskSkip: boolean
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  tier: 'voice',
  musicBitrate: MUSIC_BITRATE_DEFAULT,
  krisp: true,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  earphoneAck: false,
  statsOpen: false,
  sampleRate: 48000,
  bitDepth: 24,
  bufferTarget: 'auto',
  hiresAskSkip: false,
}

const TIERS: VoiceTier[] = ['voice', 'music', 'lossless', 'hires']

export function normalizeVoicePrefs(raw: unknown): VoicePrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const tier = TIERS.includes(o.tier as VoiceTier) ? (o.tier as VoiceTier) : 'voice'
  const sr = Number(o.sampleRate)
  const bd = Number(o.bitDepth)
  const bt = o.bufferTarget === 'auto' ? 'auto' : Number(o.bufferTarget)
  return {
    tier,
    musicBitrate: clampMusicBitrate(Number(o.musicBitrate ?? MUSIC_BITRATE_DEFAULT)),
    krisp: o.krisp !== false,
    echoCancellation: o.echoCancellation !== false,
    noiseSuppression: o.noiseSuppression !== false,
    autoGainControl: o.autoGainControl !== false,
    earphoneAck: o.earphoneAck === true,
    statsOpen: o.statsOpen === true,
    micDeviceId: typeof o.micDeviceId === 'string' && o.micDeviceId ? o.micDeviceId : undefined,
    speakerDeviceId: typeof o.speakerDeviceId === 'string' && o.speakerDeviceId ? o.speakerDeviceId : undefined,
    sampleRate: (VOICE_SAMPLE_RATES as readonly number[]).includes(sr) ? (sr as VoiceSampleRate) : DEFAULT_VOICE_PREFS.sampleRate,
    bitDepth: (VOICE_BIT_DEPTHS as readonly number[]).includes(bd) ? (bd as VoiceBitDepth) : DEFAULT_VOICE_PREFS.bitDepth,
    bufferTarget: (VOICE_BUFFER_TARGETS as readonly (string | number)[]).includes(bt) ? (bt as VoiceBufferTarget) : 'auto',
    hiresAskSkip: o.hiresAskSkip === true,
  }
}

export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(VOICE_PREFS_KEY)
    return normalizeVoicePrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_VOICE_PREFS }
  }
}

export function saveVoicePrefs(p: VoicePrefs) {
  try { localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(p)) } catch { /* 저장소 막힘 */ }
}
