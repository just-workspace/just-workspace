// 음성 채널 접속 경쟁 — 연속 클릭·접속 중 나가기에서 전송이 남거나(고아) 새 세션이 깨지지 않는지
import { describe, it, expect, beforeEach, vi } from 'vitest'

const api = vi.hoisted(() => ({ calls: [] as string[], gate: null as null | Promise<void> }))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => {
    api.calls.push(url)
    if (url.endsWith('/voice/token')) { if (api.gate) await api.gate; return { token: 't', livekit_url: 'wss://x', room: 'r', identity: `id-${api.calls.length}` } }
    return {}
  }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

type Fake = { join: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn>; release: () => void; fail: (e: unknown) => void }
const made = vi.hoisted(() => ({ list: [] as any[], hold: false }))
vi.mock('~/lib/voice/transports/livekit', () => ({
  createLiveKitVoiceTransport: () => {
    let release = () => {}
    let fail: (e: unknown) => void = () => {}
    const pending = new Promise<void>((res, rej) => { release = res; fail = rej })
    const tr = {
      join: vi.fn(async () => { if (made.hold) await pending }), leave: vi.fn(async () => {}), setSend: vi.fn(async () => {}), setMuted: vi.fn(async () => {}),
      setDeafened: vi.fn(), setScreenAudio: vi.fn(async () => true), attachRemoteAudio: vi.fn(), getStats: vi.fn(async () => ({})),
      getLevels: vi.fn(() => ({ left: -100, right: -100 })), peers: vi.fn(() => []), on: vi.fn(() => () => {}),
      effectiveTier: vi.fn(() => 'voice'), micState: vi.fn(() => 'ok'), tiers: ['voice', 'music'], release, fail,
    }
    made.list.push(tr)
    return tr
  },
  LiveKitVoiceTransport: class {}, isMicUnavailable: () => false,
}))

const { voiceStore, joinVoice, leaveVoice } = await import('~/composables/useVoice')
const { EMPTY_STATS } = await import('~/lib/voice/stats')
const { DEFAULT_VOICE_PREFS } = await import('~/lib/voice/prefs')
const flush = () => new Promise<void>(r => setTimeout(r, 0))

beforeEach(async () => {
  await leaveVoice().catch(() => {})
  api.calls = []
  api.gate = null
  made.list = []
  made.hold = false
  voiceStore.setState({
    channelId: null, identity: null, connectionState: 'disconnected', peers: [], muted: false, deafened: false, statsOpen: false, qualityOpen: false,
    screenAudio: false, busy: false, listenOnly: false, reconnectSince: null, exclusiveError: null, hiresPrompt: null, barHosts: 0,
    prefs: { ...DEFAULT_VOICE_PREFS }, effectiveTier: 'voice', stats: { ...EMPTY_STATS },
  })
})

describe('음성 접속 경쟁', () => {
  it('채널을 옮기는 도중의 연속 클릭은 무시된다 — 전송은 채널당 하나', async () => {
    await joinVoice('a')
    expect(voiceStore.getState().channelId).toBe('a')
    const p1 = joinVoice('b')
    const p2 = joinVoice('c')   // 이동 중(busy) — 예전엔 teardown 이 busy 를 풀어 둘 다 접속했다
    await Promise.all([p1, p2])
    expect(voiceStore.getState().channelId).toBe('b')
    expect(made.list).toHaveLength(2)                       // a, b — c 는 만들지 않았다
    expect((made.list[0] as Fake).leave).toHaveBeenCalled()  // a 는 정리됐다
    expect(voiceStore.getState().busy).toBe(false)
  })

  it('접속 중에 나가면 그 전송을 남기지 않고, 뒤늦은 완료가 상태를 되살리지 않는다', async () => {
    made.hold = true
    const p = joinVoice('a')
    await flush()
    expect(voiceStore.getState().connectionState).toBe('connecting')
    await leaveVoice()
    expect(voiceStore.getState().channelId).toBeNull()
    ;(made.list[0] as Fake).release()
    await p
    expect(voiceStore.getState().channelId).toBeNull()
    expect(voiceStore.getState().connectionState).toBe('disconnected')
    expect((made.list[0] as Fake).leave).toHaveBeenCalled()
  })

  it('밀려난 접속의 실패가 새 세션을 끊지 않는다', async () => {
    made.hold = true
    const p1 = joinVoice('a')
    await flush()
    await leaveVoice()
    made.hold = false
    await joinVoice('b')
    expect(voiceStore.getState().channelId).toBe('b')
    ;(made.list[0] as Fake).fail(new Error('aborted'))
    await p1            // 조용히 끝난다(던지지 않는다)
    expect(voiceStore.getState().channelId).toBe('b')
    expect(voiceStore.getState().connectionState).toBe('connected')
    expect((made.list[1] as Fake).leave).not.toHaveBeenCalled()
  })

  it('토큰을 받는 중에 나가면 접속하지 않는다', async () => {
    let open = () => {}
    api.gate = new Promise<void>((r) => { open = r })
    const p = joinVoice('a')
    await flush()
    await leaveVoice()
    open()
    await p
    expect(made.list).toHaveLength(0)
    expect(voiceStore.getState().channelId).toBeNull()
    expect(voiceStore.getState().busy).toBe(false)
  })
})
