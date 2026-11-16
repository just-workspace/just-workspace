// 음성 채널: Opus 레시피 · SDP 가공 · 통계 요약 · 로컬 설정 · 전송 레지스트리 — 순수 함수
import { describe, it, expect, beforeEach } from 'vitest'
import {
  captureFor, publishFor, fmtpFor, clampMusicBitrate, tierBadge, formatBitrate, isDegraded, screenAudioConfig,
  MUSIC_BITRATE_MAX, MUSIC_BITRATE_MIN, VOICE_BITRATE,
} from '~/lib/voice/opus'
import { mungeOpusAnswer, parseFmtpLine } from '~/lib/voice/sdp'
import { summarizeStats, rms, rmsToDb, dbToMeter, opusChannels } from '~/lib/voice/stats'
import { normalizeVoicePrefs, loadVoicePrefs, saveVoicePrefs, VOICE_PREFS_KEY, DEFAULT_VOICE_PREFS } from '~/lib/voice/prefs'
import { registerVoiceTransport, hasVoiceTransport, getVoiceTransportFactory, _resetVoiceTransports, type VoiceTransport } from '~/lib/voice/transport'

const words = { mono: '모노', stereo: '스테레오' }

describe('Opus 레시피(음성·음악)', () => {
  it('음성 — 모노 32k, AEC/NS/AGC 켬, DTX·RED 켬, FEC 켬', () => {
    const cfg = { tier: 'voice' as const, musicBitrate: 256_000 }
    expect(captureFor(cfg)).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48_000 })
    expect(publishFor(cfg)).toEqual({ audioPreset: { maxBitrate: VOICE_BITRATE }, dtx: true, red: true, forceStereo: false, preConnectBuffer: false })
    expect(fmtpFor(cfg)).toEqual({ maxaveragebitrate: 32_000, stereo: 0, cbr: 0, usedtx: 1, useinbandfec: 1 })
  })
  it('음악 + 음성 처리 기본(켬) — 에코 제거 때문에 모노, 처리 켬, CBR 유지', () => {
    const cfg = { tier: 'music' as const, musicBitrate: 320_000, micDeviceId: 'mic1' }
    expect(captureFor(cfg)).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48_000, deviceId: 'mic1' })
    expect(publishFor(cfg)).toEqual({ audioPreset: { maxBitrate: 320_000 }, dtx: false, red: false, forceStereo: false, preConnectBuffer: false })
    expect(fmtpFor(cfg)).toEqual({ maxaveragebitrate: 320_000, stereo: 0, cbr: 1, usedtx: 0, useinbandfec: 0 })
  })
  it('음성 단계도 처리를 끌 수 있다(단계와 별개)', () => {
    const cfg = { tier: 'voice' as const, musicBitrate: 256_000, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    expect(captureFor(cfg)).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 })
  })
  it('음악 + 처리 끔 — 스테레오, CBR, DTX·RED·FEC 끔, forceStereo', () => {
    const cfg = { tier: 'music' as const, musicBitrate: 510_000, micDeviceId: 'mic1', echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    expect(captureFor(cfg)).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48_000, deviceId: 'mic1' })
    expect(publishFor(cfg)).toEqual({ audioPreset: { maxBitrate: 510_000 }, dtx: false, red: false, forceStereo: true, preConnectBuffer: false })
    expect(fmtpFor(cfg)).toEqual({ maxaveragebitrate: 510_000, stereo: 1, cbr: 1, usedtx: 0, useinbandfec: 0 })
    // 화면 공유 오디오는 항상 음악 레시피, 장치는 제외
    expect(screenAudioConfig({ tier: 'voice', musicBitrate: 320_000, micDeviceId: 'x' })).toEqual({ tier: 'music', musicBitrate: 320_000, micDeviceId: undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false })
    // 음악 공유는 마이크 처리 설정과 무관하게 항상 스테레오·처리 비활성
    expect(fmtpFor(screenAudioConfig({ tier: 'voice', musicBitrate: 320_000, echoCancellation: true }))).toMatchObject({ stereo: 1 })
  })
  it('비트레이트 범위·2k 단위·표기', () => {
    expect(clampMusicBitrate(1)).toBe(MUSIC_BITRATE_MIN)
    expect(clampMusicBitrate(9_999_999)).toBe(MUSIC_BITRATE_MAX)
    expect(clampMusicBitrate(257_300)).toBe(258_000)
    expect(clampMusicBitrate(Number.NaN)).toBe(256_000)
    expect(formatBitrate(509_312)).toBe('509 kbps')
    expect(formatBitrate(2_304_000)).toBe('2.3 Mbps')
    expect(formatBitrate(1_234)).toBe('1.2 kbps')
    expect(formatBitrate(null)).toBe('—')
  })
  it('배지 — 목표값 + 실측 채널, 하향 판정은 음악에서만', () => {
    expect(tierBadge('voice', { musicBitrate: 256_000 }, null, words)).toBe('Opus 32k · 모노')
    expect(tierBadge('music', { musicBitrate: 510_000, echoCancellation: false }, null, words)).toBe('Opus 510k · 스테레오')
    expect(tierBadge('music', { musicBitrate: 510_000 }, null, words)).toBe('Opus 510k · 모노')
    expect(tierBadge('music', { musicBitrate: 256_000 }, { codec: 'audio/opus', channels: 1, sendBitrate: 1 }, words)).toBe('Opus 256k · 모노')
    expect(tierBadge('lossless', { musicBitrate: 0 }, null, words)).toBe('PCM 24/48')
    expect(isDegraded('music', 510_000, 300_000)).toBe(true)
    expect(isDegraded('music', 510_000, 500_000)).toBe(false)
    expect(isDegraded('voice', 32_000, 1_000)).toBe(false)
    expect(isDegraded('music', 510_000, null)).toBe(false)
  })
})

const ANSWER = [
  'v=0', 'o=- 1 1 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63', 'a=mid:0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1', 'a=rtpmap:63 red/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', 'a=rtpmap:96 VP9/90000', 'a=fmtp:96 profile-id=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:2', 'a=rtpmap:111 opus/48000/2',
].join('\r\n') + '\r\n'

describe('SDP 손질(answer opus fmtp)', () => {
  it('음악 값을 모든 오디오 구간에 같은 값으로 쓴다(BUNDLE payload type 일치), 영상은 건드리지 않는다', () => {
    const out = mungeOpusAnswer(ANSWER, { maxaveragebitrate: 510_000, stereo: 1, cbr: 1, usedtx: 0, useinbandfec: 0 })
    const fmtps = out.split('\r\n').filter(l => l.startsWith('a=fmtp:111'))
    expect(fmtps).toHaveLength(2)
    for (const f of fmtps) {
      const p = parseFmtpLine(f.replace('a=fmtp:111 ', ''))!
      expect(p).toMatchObject({ maxaveragebitrate: '510000', stereo: '1', 'sprop-stereo': '1', cbr: '1', usedtx: '0', useinbandfec: '0' })
    }
    // 기존 값(minptime)은 유지
    expect(parseFmtpLine(fmtps[0].replace('a=fmtp:111 ', ''))!.minptime).toBe('10')
    // 두 번째 구간(fmtp 없음)은 rtpmap 뒤에 신규 삽입됨
    expect(out).toMatch(/a=mid:2\r\na=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 /)
    expect(out).toContain('a=fmtp:96 profile-id=0')
    expect(out).toContain('a=rtpmap:63 red/48000/2')
    expect(out.endsWith('\r\n')).toBe(true)
  })
  it('음성 값 — DTX·FEC 켬, 모노', () => {
    const out = mungeOpusAnswer(ANSWER, { maxaveragebitrate: 32_000, stereo: 0, cbr: 0, usedtx: 1, useinbandfec: 1 })
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=32000;stereo=0;sprop-stereo=0;cbr=0')
  })
  it('opus 가 없는 SDP 는 그대로', () => {
    const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP9/90000\r\n'
    expect(mungeOpusAnswer(sdp, fmtpFor({ tier: 'music', musicBitrate: 256_000 }))).toBe(sdp)
    expect(parseFmtpLine(null)).toBeNull()
  })
})

describe('통계 요약(getStats → 패널 값)', () => {
  const send1 = [
    { id: 'c1', type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10;stereo=1;cbr=1' },
    { id: 'o1', type: 'outbound-rtp', kind: 'audio', codecId: 'c1', bytesSent: 10_000, packetsSent: 100 },
    { id: 'r1', type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: 0.042, jitter: 0.0031, packetsLost: 3 },
    { id: 'p1', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.05 },
  ]
  const send2 = send1.map(s => (s.id === 'o1' ? { ...s, bytesSent: 10_000 + 63_750, packetsSent: 150 } : s))
  const recv = [
    { id: 'i1', type: 'inbound-rtp', kind: 'audio', bytesReceived: 4_000, packetsLost: 1, concealedSamples: 960, jitterBufferDelay: 2.4, jitterBufferEmittedCount: 48_000 },
  ]
  it('코덱·채널·레이트·fmtp 는 바로, 비트레이트는 두 번째 표본부터(1초에 63,750B → 510 kbps)', () => {
    const a = summarizeStats([send1], [recv], null, 1000)
    expect(a.stats).toMatchObject({ codec: 'opus', channels: 2, sampleRate: 48000, fmtp: 'minptime=10;stereo=1;cbr=1', sendBitrate: null, rttMs: 42, packetsLost: 3, packetsSent: 100 })
    expect(a.stats.jitterMs).toBeCloseTo(3.1, 5)
    expect(a.stats.concealedSamples).toBe(960)
    expect(a.stats.recvPacketsLost).toBe(1)
    expect(a.stats.jitterBufferMs).toBeCloseTo(0.05, 5)
    const b = summarizeStats([send2], [recv], a.snap, 2000)
    expect(b.stats.sendBitrate).toBe(510_000)
    expect(b.stats.recvBitrate).toBe(0)
  })
  it('RTCStatsReport(Map) 형태도 읽고, remote-inbound 가 없으면 candidate-pair RTT 를 쓴다', () => {
    const map = new Map(send1.filter(s => s.type !== 'remote-inbound-rtp').map(s => [s.id, s]))
    const r = summarizeStats([map as unknown as RTCStatsReport], [], null, 0)
    expect(r.stats.rttMs).toBe(50)
    expect(r.stats.packetsLost).toBeNull()
  })
  it('채널 수는 opus fmtp stereo 로 — RTP 코덱은 늘 /2 로 광고된다', () => {
    expect(opusChannels('opus', 'minptime=10;useinbandfec=1', 2)).toBe(1)
    expect(opusChannels('opus', 'stereo=1;sprop-stereo=1', 2)).toBe(2)
    expect(opusChannels('opus', 'sprop-stereo=1', 2)).toBe(1)
    expect(opusChannels('opus', null, 2)).toBe(1)
    expect(opusChannels('L16', null, 2)).toBe(2)
    const mono = send1.map(s => (s.id === 'c1' ? { ...s, sdpFmtpLine: 'minptime=10;usedtx=1' } : s))
    expect(summarizeStats([mono], [], null, 0).stats.channels).toBe(1)
  })
  it('레벨 — RMS·dB·미터 폭', () => {
    expect(rms([0, 0, 0])).toBe(0)
    expect(rmsToDb(0)).toBe(-100)
    expect(rmsToDb(1)).toBe(0)
    expect(rmsToDb(0.1)).toBeCloseTo(-20, 5)
    expect(dbToMeter(0)).toBe(1)
    expect(dbToMeter(-30)).toBe(0.5)
    expect(dbToMeter(-90)).toBe(0)
  })
})

describe('로컬 설정(voice.quality)', () => {
  beforeEach(() => { localStorage.clear() })
  it('없으면 기본(음성 · 256k), 깨진 값은 바로잡는다', () => {
    expect(loadVoicePrefs()).toEqual(DEFAULT_VOICE_PREFS)
    expect(normalizeVoicePrefs({ tier: 'bogus', musicBitrate: '9999999', micDeviceId: '' })).toMatchObject({ tier: 'voice', musicBitrate: MUSIC_BITRATE_MAX, micDeviceId: undefined })
    localStorage.setItem(VOICE_PREFS_KEY, '{not json')
    expect(loadVoicePrefs()).toEqual(DEFAULT_VOICE_PREFS)
  })
  it('저장 → 읽기 왕복', () => {
    saveVoicePrefs({ ...DEFAULT_VOICE_PREFS, tier: 'music', musicBitrate: 510_000, earphoneAck: true, micDeviceId: 'm1' })
    expect(loadVoicePrefs()).toMatchObject({ tier: 'music', musicBitrate: 510_000, earphoneAck: true, micDeviceId: 'm1' })
  })
})

describe('전송 레지스트리(확장점)', () => {
  beforeEach(() => _resetVoiceTransports())
  it('등록 안 된 단계는 "준비 중", 등록하면 팩토리를 준다', () => {
    expect(hasVoiceTransport('lossless')).toBe(false)
    const fake = {} as VoiceTransport
    registerVoiceTransport(['lossless', 'hires'], () => fake)
    expect(hasVoiceTransport('lossless')).toBe(true)
    expect(hasVoiceTransport('hires')).toBe(true)
    expect(hasVoiceTransport('voice')).toBe(false)
    expect(getVoiceTransportFactory('hires')!()).toBe(fake)
    expect(getVoiceTransportFactory('music')).toBeNull()
  })
})
