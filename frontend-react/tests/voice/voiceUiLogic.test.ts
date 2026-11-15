// 음성채널 화면 상태 로직(handover-20 답) — lib/voice/ui 순수 함수 · prefs 고급값 · 무손실 어댑터 고급 옵션
import { describe, it, expect } from 'vitest'
import {
  actualFormat, bandsFor, barStatus, browserKind, detectSpeakerOutput, formatDb, formatRtt, losslessBitrate, lossPercent,
  meterSegments, reconnectSeconds, stabilizeNext, tierDotClass, TIER_TONE,
} from '~/lib/voice/ui'
import { normalizeVoicePrefs } from '~/lib/voice/prefs'
import { advancedOf } from '~/lib/lossless/adapter'

const words = { mono: '모노', stereo: '스테레오' }

describe('스피커 출력 감지(이어폰 권장 띠)', () => {
  const dev = (label: string, id = 'd1', isDefault = true) => ({ deviceId: id, label, isDefault })
  it('라벨에 스피커 단서 → speaker', () => {
    expect(detectSpeakerOutput([dev('Speakers (Realtek(R) Audio)')])).toBe('speaker')
    expect(detectSpeakerOutput([dev('스피커 (Realtek High Definition Audio)')])).toBe('speaker')
    expect(detectSpeakerOutput([dev('DELL U2723QE (NVIDIA High Definition Audio)')])).toBe('speaker')
    expect(detectSpeakerOutput([dev('MacBook Pro Speakers')])).toBe('speaker')
  })
  it('헤드폰·이어폰·블루투스 단서 → headphones(스피커 단서보다 우선)', () => {
    expect(detectSpeakerOutput([dev('Headphones (Realtek(R) Audio)')])).toBe('headphones')
    expect(detectSpeakerOutput([dev('WH-1000XM5 Hands-Free AG Audio')])).toBe('headphones')
    expect(detectSpeakerOutput([dev('AirPods Pro')])).toBe('headphones')
    expect(detectSpeakerOutput([dev('Speakers + Headphones (Realtek)')])).toBe('headphones')
    expect(detectSpeakerOutput([dev('Scarlett 2i2 USB')])).toBe('headphones')
  })
  it('라벨이 없거나(권한 전) 단서가 없으면 unknown — 띠를 띄우지 않는다', () => {
    expect(detectSpeakerOutput([])).toBe('unknown')
    expect(detectSpeakerOutput([dev('')])).toBe('unknown')
    expect(detectSpeakerOutput([dev('USB Audio Device')])).toBe('unknown')
  })
  it('고른 장치가 있으면 그 라벨로, 없으면 기본 장치, 그것도 없으면 첫 항목', () => {
    const list = [dev('Speakers (Realtek)', 'spk', false), dev('Headphones (USB)', 'hp', true)]
    expect(detectSpeakerOutput(list, 'spk')).toBe('speaker')
    expect(detectSpeakerOutput(list)).toBe('headphones')
    expect(detectSpeakerOutput(list, 'missing')).toBe('headphones')
    expect(detectSpeakerOutput([dev('Speakers (Realtek)', 'spk', false)])).toBe('speaker')
  })
})

describe('접속 바 상태 · 띠 판정', () => {
  it('상태 글자·색·점 — 연결/연결 중/재연결/듣기만', () => {
    expect(barStatus('connected', false)).toEqual({ key: 'connected', tone: 'success', dot: 'live' })
    expect(barStatus('connecting', false)).toEqual({ key: 'connecting', tone: 'foreground', dot: 'connecting' })
    expect(barStatus('reconnecting', false)).toEqual({ key: 'reconnecting', tone: 'warning', dot: 'connecting' })
    expect(barStatus('rejoining', false).key).toBe('reconnecting')
    expect(barStatus('connected', true)).toEqual({ key: 'listenOnly', tone: 'foreground', dot: 'live' })
    expect(reconnectSeconds(1000, 4300)).toBe(3)
    expect(reconnectSeconds(null, 4300)).toBe(0)
  })
  const base = { connectionState: 'connected' as const, wantTier: 'voice' as const, effectiveTier: 'voice' as const, listenOnly: false, speakerOutput: 'unknown' as const, exclusiveFailed: false }
  it('평상시엔 띠 없음', () => {
    expect(bandsFor(base)).toEqual([])
  })
  it('재연결 → warning 띠(다른 띠보다 위)', () => {
    const b = bandsFor({ ...base, connectionState: 'reconnecting', listenOnly: true })
    expect(b[0].kind).toBe('reconnect')
    // 권한 없음 띠는 연결된 뒤에만
    expect(b.find(x => x.kind === 'noPermission')).toBeUndefined()
  })
  it('무손실을 골랐는데 음악으로 보내는 중 = 중계 실패 띠', () => {
    expect(bandsFor({ ...base, wantTier: 'lossless', effectiveTier: 'music' }).map(x => x.kind)).toEqual(['relayFail'])
    expect(bandsFor({ ...base, wantTier: 'lossless', effectiveTier: 'lossless' })).toEqual([])
    // 아직 연결 중이면 판단하지 않는다
    expect(bandsFor({ ...base, connectionState: 'connecting', wantTier: 'lossless', effectiveTier: 'music' })).toEqual([])
  })
  it('장치 독점 실패 = danger · 권한 없음 · 스피커 + 음악 이상 = 이어폰 권장', () => {
    expect(bandsFor({ ...base, exclusiveFailed: true })[0]).toMatchObject({ kind: 'exclusiveFail', tone: 'danger' })
    expect(bandsFor({ ...base, listenOnly: true }).map(x => x.kind)).toEqual(['noPermission'])
    expect(bandsFor({ ...base, speakerOutput: 'speaker', effectiveTier: 'music' }).map(x => x.kind)).toEqual(['earphone'])
    // 음성 단계는 에코 제거가 켜져 있어 스피커라도 띠 없음 · 감지 못 하면 띠 없음
    expect(bandsFor({ ...base, speakerOutput: 'speaker', effectiveTier: 'voice' })).toEqual([])
    expect(bandsFor({ ...base, speakerOutput: 'unknown', effectiveTier: 'lossless' })).toEqual([])
  })
  it('브라우저 판별(권한 안내 한 줄)', () => {
    expect(browserKind('Mozilla/5.0 Chrome/140.0 Safari/537.36')).toBe('chrome')
    expect(browserKind('Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('edge')
    expect(browserKind('Mozilla/5.0 Gecko/20100101 Firefox/131.0')).toBe('firefox')
    expect(browserKind('Mozilla/5.0 Version/17.0 Safari/605.1.15')).toBe('safari')
    expect(browserKind('curl/8')).toBe('other')
  })
})

describe('표기 · 미터 · 고급값', () => {
  it('단계 색 — 음성 neutral · 음악 primary · 무손실/하이레조 success(하이레조는 링)', () => {
    expect(TIER_TONE).toEqual({ voice: 'neutral', music: 'primary', lossless: 'success', hires: 'success' })
    expect(tierDotClass('hires')).toContain('ring-2')
    expect(tierDotClass('music')).toContain('bg-primary')
  })
  it('24칸 미터 — -60 dB 아래 0칸, 0 dB 24칸, 마지막 4칸 warning', () => {
    expect(meterSegments(-100).every(s => s === 'off')).toBe(true)
    const s = meterSegments(-30)
    expect(s.filter(x => x !== 'off')).toHaveLength(12)
    expect(meterSegments(0).filter(x => x === 'warn')).toHaveLength(4)
    expect(formatDb(-9.4)).toBe('−9.4 dB')
    expect(formatDb(-100)).toBe('−∞ dB')
  })
  it('무손실 비트레이트 = 레이트 × 비트 × 2 · 안정화 다음 값 · 손실률 · RTT', () => {
    expect(losslessBitrate(48000, 24)).toBe(2_304_000)
    expect(losslessBitrate(96000, 24)).toBe(4_608_000)
    expect(stabilizeNext('auto')).toBe(120)
    expect(stabilizeNext(60)).toBe(120)
    expect(stabilizeNext(120)).toBe(250)
    expect(stabilizeNext(250)).toBe(250)
    expect(lossPercent(2, 9998)).toBe('0.02%')
    expect(lossPercent(null, 10)).toBe('—')
    expect(formatRtt(141.6)).toBe('142ms')
    expect(formatRtt(null)).toBe('—')
  })
  it('실제 형식 글자 — 내 것은 실측, 남의 것은 단계 기본', () => {
    expect(actualFormat('voice', null, null, words)).toBe('Opus 모노 32 kbps')
    expect(actualFormat('music', null, null, words)).toBe('Opus 스테레오')
    expect(actualFormat('music', { codec: 'opus', channels: 2, sendBitrate: 509_000, sampleRate: 48000 }, { musicBitrate: 510_000 }, words)).toBe('Opus 스테레오 509 kbps')
    expect(actualFormat('music', null, { musicBitrate: 510_000 }, words)).toBe('Opus 스테레오 510 kbps')
    expect(actualFormat('lossless', null, null, words)).toBe('PCM 24/48 · 2.3 Mbps')
    expect(actualFormat('lossless', { codec: 'PCM 24/96', channels: 2, sendBitrate: 4_700_000, sampleRate: 96000 }, { musicBitrate: 0 }, words)).toBe('PCM 24/96 · 4.7 Mbps')
    expect(actualFormat('lossless', null, { musicBitrate: 0, sampleRate: 44100, bitDepth: 16 }, words)).toBe('PCM 16/44 · 1.4 Mbps')
    expect(actualFormat('hires', null, null, words)).toBe('PCM 32/192 · 12.3 Mbps')
  })
  it('prefs 고급값 — 기본 48k·24bit·auto, 깨진 값은 바로잡고 "다음부터 묻지 않기"는 남는다', () => {
    const d = normalizeVoicePrefs(null)
    expect(d).toMatchObject({ sampleRate: 48000, bitDepth: 24, bufferTarget: 'auto', hiresAskSkip: false })
    expect(normalizeVoicePrefs({ sampleRate: 96000, bitDepth: 16, bufferTarget: 120, hiresAskSkip: true })).toMatchObject({ sampleRate: 96000, bitDepth: 16, bufferTarget: 120, hiresAskSkip: true })
    expect(normalizeVoicePrefs({ sampleRate: 11025, bitDepth: 32, bufferTarget: 999 })).toMatchObject({ sampleRate: 48000, bitDepth: 24, bufferTarget: 'auto' })
    expect(normalizeVoicePrefs({ bufferTarget: '250' })).toMatchObject({ bufferTarget: 250 })
  })
  it('무손실 어댑터 — 송신 설정의 고급값을 세션 옵션(format·bufferPreset)으로', () => {
    expect(advancedOf(null)).toEqual({ format: {}, bufferPreset: undefined })
    expect(advancedOf({ tier: 'lossless', musicBitrate: 0, krisp: false, sampleRate: 96000, bitDepth: 16, bufferTarget: 120 }))
      .toEqual({ format: { sampleRate: 96000, bits: 16, codec: 'pcm_s16' }, bufferPreset: 120 })
    expect(advancedOf({ tier: 'lossless', musicBitrate: 0, krisp: false, bitDepth: 24, bufferTarget: 'auto' }).format).toEqual({ bits: 24, codec: 'pcm_s24' })
  })
})
