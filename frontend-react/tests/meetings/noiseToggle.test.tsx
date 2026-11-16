// 회의의 "노이즈 제거" 토글 — 브라우저 기본 잡음 억제(noiseSuppression)를 활성화/비활성화한다.
//  - 현재 마이크 트랙의 제약을 변경 / 즉시 변경이 불가한 브라우저에서는 트랙을 재획득
//  - 둘 다 실패하면 상태를 유지하고 알림 / 마이크가 꺼져 있으면 다음 활성화 시 적용되도록 기본값만 변경
//  - 컨트롤 바의 버튼
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('livekit-client', () => ({
  Room: class {}, RoomEvent: {}, Track: { Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share' } },
  TrackEvent: { Ended: 'ended' }, VideoPresets: {}, ParticipantKind: {}, DisconnectReason: {},
}))
const toasts = vi.hoisted(() => ({ list: [] as Array<[string, string]> }))
vi.mock('~/composables/useToast', async (orig) => {
  const real = await orig<typeof import('~/composables/useToast')>()
  return { ...real, addToast: (kind: string, text: string) => { toasts.list.push([kind, text]) } }
})

const m = await import('~/composables/useMeetings')
const { MeetingsControls } = await import('~/components/meetings/MeetingsControls')
const { setLocale } = await import('~/i18n')

interface FakeTrack {
  mediaStreamTrack: { applyConstraints: ReturnType<typeof vi.fn>; getSettings: () => { noiseSuppression?: boolean } }
  restartTrack: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
}

function setup(opts: { track?: boolean; applies?: 'ok' | 'ignored' | 'throws'; restartFails?: boolean } = {}) {
  let live = true
  const track: FakeTrack = {
    mediaStreamTrack: {
      applyConstraints: vi.fn(async (c: { noiseSuppression: boolean }) => {
        if (opts.applies === 'throws') throw new Error('OverconstrainedError')
        if (opts.applies !== 'ignored') live = c.noiseSuppression
      }),
      getSettings: () => ({ noiseSuppression: live }),
    },
    restartTrack: vi.fn(async () => { if (opts.restartFails) throw new Error('NotReadableError') }),
    on: vi.fn(), off: vi.fn(),
  }
  const room = {
    options: { audioCaptureDefaults: { deviceId: 'mic-1', echoCancellation: true, autoGainControl: true, noiseSuppression: true } },
    localParticipant: { getTrackPublication: () => (opts.track === false ? undefined : { track }) },
  }
  m.meetingsStore.setState({ currentRoom: room as any, micEnabled: opts.track !== false, noiseEnabled: true, noiseBusy: false })
  return { track, room }
}

beforeAll(async () => {
  await setLocale('ko')
  await m.loadLivekit()
})
beforeEach(() => { toasts.list.length = 0 })

describe('잡음 제거 토글', () => {
  it('기본은 켬이고, 끄면 지금 트랙의 브라우저 잡음 억제를 끈다 — 다시 켜면 켠다', async () => {
    const { track, room } = setup()
    expect(m.meetingsStore.getState().noiseEnabled).toBe(true)
    await m.toggleNoiseCancellation()
    expect(track.mediaStreamTrack.applyConstraints).toHaveBeenLastCalledWith({ noiseSuppression: false })
    expect(track.restartTrack).not.toHaveBeenCalled()
    expect(m.meetingsStore.getState()).toMatchObject({ noiseEnabled: false, noiseBusy: false })
    expect(room.options.audioCaptureDefaults.noiseSuppression).toBe(false)      // 마이크를 다시 켜도 동일 값 유지
    await m.toggleNoiseCancellation()
    expect(track.mediaStreamTrack.applyConstraints).toHaveBeenLastCalledWith({ noiseSuppression: true })
    expect(m.meetingsStore.getState().noiseEnabled).toBe(true)
    expect(room.options.audioCaptureDefaults.noiseSuppression).toBe(true)
    expect(toasts.list).toEqual([])
  })

  it.each(['ignored', 'throws'] as const)('그 자리에서 못 바꾸는 브라우저(%s)면 같은 장치로 트랙을 다시 잡는다', async (applies) => {
    const { track } = setup({ applies })
    await m.toggleNoiseCancellation()
    expect(track.restartTrack).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'mic-1', echoCancellation: true, noiseSuppression: false }))
    expect(m.meetingsStore.getState().noiseEnabled).toBe(false)
  })

  it('바꾸지 못하면 상태와 기본값을 그대로 두고 알린다', async () => {
    const { room } = setup({ applies: 'throws', restartFails: true })
    await m.toggleNoiseCancellation()
    expect(m.meetingsStore.getState()).toMatchObject({ noiseEnabled: true, noiseBusy: false })
    expect(room.options.audioCaptureDefaults.noiseSuppression).toBe(true)
    expect(toasts.list).toEqual([['error', '잡음 제거를 변경하지 못했습니다']])
  })

  it('마이크가 꺼져 있으면 다음에 켤 때 쓰일 값만 바꾼다', async () => {
    const { track, room } = setup({ track: false })
    await m.toggleNoiseCancellation()
    expect(track.mediaStreamTrack.applyConstraints).not.toHaveBeenCalled()
    expect(m.meetingsStore.getState().noiseEnabled).toBe(false)
    expect(room.options.audioCaptureDefaults.noiseSuppression).toBe(false)
  })
})

describe('컨트롤 바의 노이즈 제거 버튼', () => {
  it('켜짐 상태를 보이고 누르면 알린다 — 마이크가 꺼져 있거나 바꾸는 중이면 못 누른다', () => {
    const onToggleNoise = vi.fn()
    const view = render(<MeetingsControls cameraEnabled={false} screenShareEnabled={false} micEnabled noiseEnabled onToggleNoise={onToggleNoise} />)
    const on = screen.getByTitle('노이즈 제거') as HTMLButtonElement
    expect(on.getAttribute('aria-pressed')).toBe('true')
    expect(on.disabled).toBe(false)
    fireEvent.click(on)
    expect(onToggleNoise).toHaveBeenCalledTimes(1)
    view.rerender(<MeetingsControls cameraEnabled={false} screenShareEnabled={false} micEnabled={false} noiseEnabled={false} onToggleNoise={onToggleNoise} />)
    const off = screen.getByTitle('노이즈 제거') as HTMLButtonElement
    expect(off.getAttribute('aria-pressed')).toBe('false')
    expect(off.disabled).toBe(true)
    view.rerender(<MeetingsControls cameraEnabled={false} screenShareEnabled={false} micEnabled noiseBusy onToggleNoise={onToggleNoise} />)
    expect((screen.getByTitle('노이즈 제거') as HTMLButtonElement).disabled).toBe(true)
  })
})
