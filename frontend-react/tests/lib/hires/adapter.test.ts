// 하이레조 어댑터(lib/hires) — 가짜 window.jwNativeAudio + 가짜 무손실 전송으로 확인창 → 독점 → 릴레이 흐름, 독점 실패 → danger 띠 + 무손실 24/48 강등,
// 취소 → 띠 없이 무손실, 통계 매핑(PCM 32/192 · 비트퍼펙트), 등록은 브리지가 있을 때만.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HiresVoiceTransport, setHiresUiHooks, mapHiresStats, hiresFormatLine, pickHiresRequest } from '~/lib/hires/adapter'
import type { HiresEvent, HiresStats, JwNativeAudio, HiresDevice } from '~/lib/hires/types'
import { _resetVoiceTransports, hasVoiceTransport, type VoiceSendConfig, type VoiceStats } from '~/lib/voice/transport'
import { EMPTY_STATS } from '~/lib/voice/stats'

vi.mock('~/lib/lossless/relayToken', () => ({
  requestRelayGrant: vi.fn(async (channelId: string) => ({ token: 'tok', expires_in: 120, room: `voice-${channelId}`, ws_url: 'ws://x/audiorelay/ws', ws_path: '/audiorelay/ws', webtransport: null })),
  RelayUnavailable: class extends Error {},
}))

const dev: HiresDevice = {
  id: 'cap-1', name: 'RME Fireface UCX II', isDefault: true, kind: 'capture', defaultFormat: { rate: 48000, bits: 24, validBits: 24, channels: 2, isFloat: false },
  exclusiveFormats: [
    { rate: 48000, bits: 24, validBits: 24, channels: 2, isFloat: false },
    { rate: 96000, bits: 32, validBits: 24, channels: 2, isFloat: false },
    { rate: 192000, bits: 32, validBits: 32, channels: 2, isFloat: false },
    { rate: 192000, bits: 32, validBits: 32, channels: 2, isFloat: true },
  ],
  sharedFormat: { format: 'f32', channels: 2, sampleRate: 48000 },
}

function fakeBridge(openResult: Partial<Awaited<ReturnType<JwNativeAudio['openHires']>>> = {}) {
  const listeners = new Map<string, Set<(ev: HiresEvent) => void>>()
  const calls: Record<string, unknown[]> = { open: [], connect: [], close: [], setMuted: [], setGrant: [] }
  const stats: HiresStats = {
    state: 'connected', transport: 'webtransport', fallbackReason: null, room: 'voice-c1', peerId: 1,
    capture: { name: dev.name, deviceId: dev.id, exclusive: true, format: 's32', bits: 32, rate: 192000, channels: 2, internalFormat: 's32', internalRate: 192000, bitPerfect: true, periodFrames: 1920, level: { peak: [0.5, 0.5], rms: [0.3, 0.3] }, overruns: 0 },
    playback: null, wire: { codec: 'pcm_s32', rate: 192000, bits: 32, channels: 2, frameMs: 10, frameSamples: 1920, fec: true }, formatLabel: 'PCM 32/192',
    exclusive: true, bitPerfect: true, playbackBitExact: true, resampling: false, bitrateOutBps: 15_672_000, framesSent: 1000, rttMs: 3.2, estimatedLatencyMs: 76,
    bufferPreset: 'auto', peers: { 2: { peer: 2, format: { codec: 'pcm_s32', rate: 192000, bits: 32, channels: 2, frameMs: 10, fec: true }, bitrateBps: 15_600_000, received: 990, lost: 5, recoveredFec: 5, recoveredNack: 0, nackSent: 0, plc: 3, targetMs: 40, depthMs: 30, jitterP95Ms: 8, bitExactPlayback: true, resampled: false } },
    muted: false, deafened: false,
  }
  const bridge: JwNativeAudio = {
    apiVersion: 1,
    available: async () => ({ available: true, version: {}, platform: 'win32' }),
    listDevices: async () => ({ capture: [dev], playback: [] }),
    openHires: async (o) => { calls.open.push(o); return { ok: true, exclusive: true, bitPerfect: true, capture: stats.capture, playback: null, wire: stats.wire, formatLabel: 'PCM 32/192', nominalBps: 15_672_000, device: dev.name, attempts: [], ...openResult } },
    connect: async (g) => { calls.connect.push(g); return { state: 'connected', peers: [{ peer: 2, uid: 'u2', identity: 'lk-u2', transport: 'webtransport' }] } },
    setGrant: async (g) => { calls.setGrant.push(g) },
    close: async () => { calls.close.push(1) },
    stats: async () => stats,
    levels: async () => ({ left: -6, right: -8 }),
    peers: async () => [],
    setMuted: async (m) => { calls.setMuted.push(m) },
    setDeafened: async () => {},
    setBufferPreset: async () => {},
    on: (type, fn) => { let s = listeners.get(type); if (!s) { s = new Set(); listeners.set(type, s) } s.add(fn); return () => { s!.delete(fn) } },
  }
  const emit = (ev: HiresEvent) => { listeners.get(ev.type)?.forEach((f) => f(ev)); listeners.get('*')?.forEach((f) => f(ev)) }
  return { bridge, calls, emit, stats }
}

/** 가짜 LosslessVoiceTransport — 호출만 기록 */
function fakeInner() {
  const calls: { join: unknown[]; setSend: VoiceSendConfig[]; leave: number; muted: Array<[string, boolean]> } = { join: [], setSend: [], leave: 0, muted: [] }
  let tier: 'music' | 'lossless' = 'music'
  const inner = {
    inner: { setParticipantAudioMuted: (id: string, m: boolean) => { calls.muted.push([id, m]) } },
    on: () => () => {},
    join: async (p: unknown) => { calls.join.push(p) },
    leave: async () => { calls.leave++ },
    setSend: async (c: VoiceSendConfig) => { calls.setSend.push(c); tier = c.tier === 'lossless' ? 'lossless' : 'music' },
    effectiveTier: () => tier,
    setMuted: async () => {},
    setDeafened: () => {},
    setScreenAudio: async () => true,
    attachRemoteAudio: () => {},
    peers: () => [],
    getLevels: () => ({ left: -100, right: -100 }),
    getStats: async (): Promise<VoiceStats> => ({ ...EMPTY_STATS }),
  }
  return { inner: inner as unknown as ConstructorParameters<typeof HiresVoiceTransport>[1], calls }
}

const join = { token: 'h.' + btoa(JSON.stringify({ video: { room: 'voice-c1' } })).replace(/=+$/, '') + '.s', url: 'wss://lk', identity: 'lk-me', muted: false, send: { tier: 'hires' as const, musicBitrate: 320_000 } }

describe('HiresVoiceTransport', () => {
  beforeEach(() => { setHiresUiHooks(null) })

  it('확인 → 독점 열기 → 릴레이 접속 → effectiveTier hires, 릴레이 피어의 LiveKit 트랙은 끈다', async () => {
    const b = fakeBridge()
    const li = fakeInner()
    const confirm = vi.fn(async () => true)
    const report = vi.fn()
    setHiresUiHooks({ confirmExclusive: confirm, reportExclusiveError: report })
    const t = new HiresVoiceTransport(b.bridge, li.inner)
    await t.join(join)
    // LiveKit 은 음악 레시피로 들어간다(presence), 브라우저 무손실은 켜지 않는다
    expect((li.calls.join[0] as { send: VoiceSendConfig }).send.tier).toBe('music')
    expect(li.calls.setSend.find((c) => c.tier === 'lossless')).toBeUndefined()
    expect(confirm).toHaveBeenCalledWith(dev.name, expect.stringMatching(/^PCM 32\/192 · .+ · 12\.3 Mbps$/))
    expect(b.calls.open[0]).toMatchObject({ captureDevice: 'cap-1', rate: 192000, bits: 32, channels: 2, allowShared: false })
    expect(b.calls.connect.length).toBe(1)
    expect(t.effectiveTier()).toBe('hires')
    expect(report).toHaveBeenCalledWith(null)
    expect(li.calls.muted).toContainEqual(['lk-u2', true])
    // 통계: 포맷·비트퍼펙트·exclusive
    const s = await t.getStats()
    expect(s.codec).toBe('PCM 32/192')
    expect(s.sampleRate).toBe(192000)
    expect(s.sendBitrate).toBe(15_672_000)
    expect(s.exclusive).toBe(true)
    expect(s.bitPerfect).toBe(true)
    expect(s.bitExact).toBe(true)
    expect(s.recovered).toBe(5)
    expect(s.transport).toBe('webtransport')
    // 피어가 나가면 LiveKit 트랙을 되살린다
    b.emit({ type: 'peer_left', peer: 2, uid: 'u2' })
    expect(li.calls.muted).toContainEqual(['lk-u2', false])
    await t.leave()
    expect(b.calls.close.length).toBe(1)
    expect(li.calls.leave).toBe(1)
  })

  it('독점 실패(다른 앱 점유) → danger 띠 + 무손실 24/48 로 강등, [다시 시도]=setSend(hires) 는 확인 없이 다시 연다', async () => {
    const b = fakeBridge({ ok: false, exclusive: false, reason: 'device_in_use', code: 'device_in_use', app: 'foobar2000', device: dev.name })
    const li = fakeInner()
    const confirm = vi.fn(async () => true)
    const report = vi.fn()
    setHiresUiHooks({ confirmExclusive: confirm, reportExclusiveError: report })
    const t = new HiresVoiceTransport(b.bridge, li.inner)
    await t.join(join)
    expect(report).toHaveBeenCalledWith({ app: 'foobar2000', device: dev.name })
    const fb = li.calls.setSend.find((c) => c.tier === 'lossless')
    expect(fb).toMatchObject({ tier: 'lossless', sampleRate: 48000, bitDepth: 24 })
    expect(t.effectiveTier()).toBe('lossless')
    expect(b.calls.close.length).toBe(1)
    // 다시 시도: 이번엔 성공 — 확인창은 다시 묻지 않는다
    b.bridge.openHires = async () => ({ ok: true, exclusive: true, bitPerfect: true, capture: null, playback: null, wire: b.stats.wire, formatLabel: 'PCM 32/192', nominalBps: 1, device: dev.name, attempts: [] })
    await t.setSend({ ...join.send })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenLastCalledWith(null)
    expect(t.effectiveTier()).toBe('hires')
  })

  it('확인창 취소 → 띠 없이 무손실로', async () => {
    const b = fakeBridge()
    const li = fakeInner()
    const report = vi.fn()
    setHiresUiHooks({ confirmExclusive: async () => false, reportExclusiveError: report })
    const t = new HiresVoiceTransport(b.bridge, li.inner)
    await t.join(join)
    expect(b.calls.open.length).toBe(0)
    expect(report).not.toHaveBeenCalled()
    expect(t.effectiveTier()).toBe('lossless')
  })

  it('exclusive 는 됐지만 shared 로 열렸다고 오면(ok=true, exclusive=false) 실패로 본다', async () => {
    const b = fakeBridge({ ok: true, exclusive: false, bitPerfect: false, reason: 'unsupported_format', app: null, device: dev.name })
    const li = fakeInner()
    const report = vi.fn()
    setHiresUiHooks({ confirmExclusive: async () => true, reportExclusiveError: report })
    const t = new HiresVoiceTransport(b.bridge, li.inner)
    await t.join(join)
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ device: dev.name }))
    expect(t.effectiveTier()).toBe('lossless')
  })

  it('다른 단계로 setSend 하면 네이티브를 닫고 inner 로 넘긴다', async () => {
    const b = fakeBridge()
    const li = fakeInner()
    setHiresUiHooks({ confirmExclusive: async () => true, reportExclusiveError: () => {} })
    const t = new HiresVoiceTransport(b.bridge, li.inner)
    await t.join(join)
    await t.setSend({ tier: 'music', musicBitrate: 256_000 })
    expect(b.calls.close.length).toBe(1)
    expect(li.calls.setSend.at(-1)?.tier).toBe('music')
    expect(t.effectiveTier()).toBe('music')
  })

  it('음소거는 네이티브와 LiveKit 둘 다', async () => {
    const b = fakeBridge()
    const li = fakeInner()
    setHiresUiHooks({ confirmExclusive: async () => true, reportExclusiveError: () => {} })
    const t = new HiresVoiceTransport(b.bridge, li.inner)
    await t.join(join)
    await t.setMuted(true)
    expect(b.calls.setMuted.at(-1)).toBe(true)
    expect(t.getLevels()).toEqual({ left: -100, right: -100 })
  })
})

describe('hires 순수 함수', () => {
  it('pickHiresRequest — probe 에서 요청 이하 최고 포맷(float 제외, 24-in-32 는 24)', () => {
    expect(pickHiresRequest(dev, { rate: 192000, bits: 32, channels: 2 })).toMatchObject({ rate: 192000, bits: 32, label: 'PCM 32/192' })
    expect(pickHiresRequest(dev, { rate: 96000, bits: 32, channels: 2 })).toMatchObject({ rate: 96000, bits: 24, label: 'PCM 24/96' })
    expect(pickHiresRequest(dev, { rate: 48000, bits: 24, channels: 2 })).toMatchObject({ rate: 48000, bits: 24, label: 'PCM 24/48' })
    expect(pickHiresRequest({ ...dev, exclusiveFormats: [] }, { rate: 96000, bits: 24, channels: 2 })).toMatchObject({ rate: 96000, bits: 24 })
    expect(pickHiresRequest(null, { rate: 44100, bits: 16, channels: 1 }).label).toBe('PCM 16/44.1')
  })
  it('hiresFormatLine · mapHiresStats', () => {
    expect(hiresFormatLine({ label: 'PCM 32/192', rate: 192000, bits: 32, channels: 2, bitPerfect: true, exclusive: true })).toMatch(/^PCM 32\/192 · .+ · 12\.3 Mbps$/)
    const s = fakeBridge().stats
    const m = mapHiresStats({ ...EMPTY_STATS }, { ...s, resampling: true })
    expect(m.bitPerfect).toBe(false)
    expect(m.bitExact).toBe(false)
    expect(m.format).toEqual({ codec: 'pcm_s32', sampleRate: 192000, bits: 32, channels: 2, frameMs: 10, fec: true })
    expect(m.jitterBufferMs).toBe(40)
    expect(m.concealedSamples).toBe(3 * 1920)
    expect(m.deviceName).toBe(dev.name)
  })
  it('register 는 브리지가 없으면 등록하지 않는다', async () => {
    _resetVoiceTransports()
    delete (window as { jwNativeAudio?: unknown }).jwNativeAudio
    await import('~/lib/hires/register')
    expect(hasVoiceTransport('hires')).toBe(false)
  })
})
