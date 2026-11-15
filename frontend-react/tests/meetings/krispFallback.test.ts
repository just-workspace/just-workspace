// 셀프호스팅 LiveKit 에선 Krisp 가 늘 실패한다 — 한 번 실패하면 "쓸 수 없음"으로 두고 안내 1회,
// 브라우저 기본 잡음 억제를 다시 켠다(예전엔 조용히 실패하고 버튼이 계속 살아 있었다).
import { describe, it, expect, vi } from 'vitest'

vi.mock('livekit-client', () => ({ Room: class {}, RoomEvent: {}, Track: { Source: { Microphone: 'microphone' } }, TrackEvent: {}, VideoPresets: {}, ParticipantKind: {}, DisconnectReason: {} }))
vi.mock('@livekit/krisp-noise-filter', () => ({ KrispNoiseFilter: () => ({}), isKrispNoiseFilterSupported: () => true }))

const m = await import('~/composables/useMeetings')
const { toastStore } = await import('~/composables/useToast')

describe('Krisp 실패 폴백', () => {
  it('실패하면 noiseSupported=false · 토스트 1회 · 브라우저 잡음 억제 켬 · 다시 시도 안 함', async () => {
    await m.loadLivekit()
    const applyConstraints = vi.fn(async () => {})
    const setProcessor = vi.fn(async () => { throw new Error('Could not authenticate. Server responded with status 404') })
    const track = { setProcessor, stopProcessor: vi.fn(), mediaStreamTrack: { applyConstraints } }
    const room = { localParticipant: { getTrackPublication: () => ({ track }) } }
    m.meetingsStore.setState({ currentRoom: room as any, noiseEnabled: false, noiseSupported: true, noiseBusy: false })
    toastStore.setState({ toasts: [] })

    await m.toggleNoiseCancellation()
    const s = m.meetingsStore.getState()
    expect(s.noiseSupported).toBe(false)
    expect(s.noiseEnabled).toBe(false)
    expect(applyConstraints).toHaveBeenCalledWith({ noiseSuppression: true })
    expect(toastStore.getState().toasts).toHaveLength(1)
    expect(sessionStorage.getItem('meet.krisp.unavailable')).toBe('1')

    await m.toggleNoiseCancellation()
    expect(setProcessor).toHaveBeenCalledTimes(1)
    expect(toastStore.getState().toasts).toHaveLength(1)
  })
})
