// livekit-client 는 메인 번들에서 제외되어 통화 시작·회의 화면 진입 시에만 로드된다.
import { describe, it, expect, vi } from 'vitest'

const loaded = vi.hoisted(() => ({ n: 0 }))
vi.mock('livekit-client', () => {
  loaded.n++
  return { Room: class {}, RoomEvent: {}, Track: { Source: {} }, TrackEvent: {}, VideoPresets: {}, ParticipantKind: {}, DisconnectReason: {} }
})

// 무거운 모듈 그래프는 수집 단계에서 로드(테스트 5초 제한 초과 방지)
const m = await import('~/composables/useMeetings')
await import('~/components/layout/MiniCall')
const loadedAfterImport = loaded.n

describe('livekit-client 지연 로드', () => {
  it('useMeetings 를 import 해도(셸·미니 통화 창) livekit-client 는 로드되지 않는다', async () => {
    expect(loadedAfterImport).toBe(0)
    const lk = await m.loadLivekit()
    expect(loaded.n).toBe(1)
    expect(lk.Room).toBeTypeOf('function')
    // 두 번째 호출은 동일 모듈(재로드 없음)
    expect(await m.loadLivekit()).toBe(lk)
    expect(loaded.n).toBe(1)
  })
})
