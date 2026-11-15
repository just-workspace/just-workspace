// 참가 전 화면(MeetingsDeviceSetup, handover 19): 권한 거부 · http · 정상 · 토글 · 장치 바 · 다른 앱 사용 중 · 끊김 · 블루투스 짝 · 손님 잠금 · 대기 띠
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { i18n } from '~/i18n'
import { mediaDevicesStore } from '~/composables/useMediaDevices'
import { siteConfigStore } from '~/composables/useSiteConfig'
import { MeetingsDeviceSetup } from '~/components/meetings/MeetingsDeviceSetup'
import { renderInRouter } from '../ui/helpers'

const t = (k: string, a?: Record<string, unknown>) => i18n.t(k, a)

type Listener = () => void
function fakeTrack(kind: 'video' | 'audio', deviceId: string) {
  const ls: Listener[] = []
  return {
    kind, stop: vi.fn(), getSettings: () => ({ deviceId }),
    addEventListener: (_: string, cb: Listener) => { ls.push(cb) },
    end: () => ls.forEach(cb => cb()),
  }
}
function fakeStream(video = true, audio = true, ids = { cam: 'cam1', mic: 'mic1' }) {
  const v = video ? [fakeTrack('video', ids.cam)] : []
  const a = audio ? [fakeTrack('audio', ids.mic)] : []
  return { getVideoTracks: () => v, getAudioTracks: () => a, getTracks: () => [...v, ...a] } as unknown as MediaStream & { getVideoTracks: () => ReturnType<typeof fakeTrack>[] }
}
const err = (name: string) => Object.assign(new Error(name), { name })

class FakeAudioContext {
  createAnalyser() { return { fftSize: 0, frequencyBinCount: 4, getByteTimeDomainData: (b: Uint8Array) => b.fill(128) } }
  createMediaStreamSource() { return { connect: () => {} } }
  resume() { return Promise.resolve() }
  close() { return Promise.resolve() }
}

const devices = [
  { deviceId: 'cam1', kind: 'videoinput', label: 'HD Webcam C920', groupId: 'g1' },
  { deviceId: 'cam2', kind: 'videoinput', label: 'Integrated Camera', groupId: 'g1b' },
  { deviceId: 'mic1', kind: 'audioinput', label: 'Microphone Array (Realtek(R) Audio)', groupId: 'g2' },
  { deviceId: 'bt-mic', kind: 'audioinput', label: 'WH-1000XM5 Hands-Free', groupId: 'g-bt' },
  { deviceId: 'spk1', kind: 'audiooutput', label: '스피커 (Realtek(R) Audio)', groupId: 'g3' },
  { deviceId: 'bt-spk', kind: 'audiooutput', label: 'WH-1000XM5 Stereo', groupId: 'g-bt' },
]

let getUserMedia: ReturnType<typeof vi.fn>
let secureDesc: PropertyDescriptor | undefined
let sinkDesc: PropertyDescriptor | undefined

beforeEach(() => {
  getUserMedia = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => devices),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
  ;(globalThis as any).AudioContext = FakeAudioContext
  ;(globalThis as any).MediaStream = undefined
  // happy-dom 의 srcObject 는 진짜 MediaStream 만 받는다
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get: () => null, set: () => {} })
  sinkDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'setSinkId')
  Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { configurable: true, writable: true, value: vi.fn(async () => {}) })
  secureDesc = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  mediaDevicesStore.setState({ cameras: [], microphones: [], speakers: [] })
  siteConfigStore.setState({ loaded: true, appName: 'acme' })
})
afterEach(() => {
  delete (navigator as any).mediaDevices
  if (secureDesc) Object.defineProperty(window, 'isSecureContext', secureDesc)
  else delete (window as any).isSecureContext
  if (sinkDesc) Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', sinkDesc)
  else delete (HTMLMediaElement.prototype as any).setSinkId
})

const joinBtn = () => screen.getByRole('button', { name: t('meetings.device.joinDefault') })
const micToggleOff = () => screen.getByRole('button', { name: t('meetings.prejoin.ariaMicOff') })
// 준비됨 = 마이크 토글이 눌릴 수 있을 때(권한 요청 중엔 비활성)
const ready = () => waitFor(() => expect(micToggleOff().hasAttribute('disabled')).toBe(false))

describe('MeetingsDeviceSetup — 상태', () => {
  it('권한 거부 → 자물쇠 안내(role=alert) + 브라우저별 한 줄 + [다시 시도], 참가 버튼은 잠기지 않고 아래 경고 한 줄, 참여는 카메라·마이크 끔', async () => {
    getUserMedia.mockRejectedValue(err('NotAllowedError'))
    const onJoin = vi.fn()
    renderInRouter(<MeetingsDeviceSetup roomName="방" onJoin={onJoin} />)
    await waitFor(() => expect((screen.getByRole('alert')).textContent).toContain(t('meetings.prejoin.denied.title')))
    expect((screen.getByRole('alert')).textContent).toContain(t('meetings.prejoin.denied.title'))
    // happy-dom UA 는 Chrome 계열이 아니다 → "그 밖" 한 줄
    expect(screen.getByRole('alert').textContent).toMatch(/다시 시도/)
    expect(screen.getByRole('button', { name: t('common.retry') })).toBeTruthy()
    expect(screen.getAllByText(`${t('meetings.device.mic')} · ${t('meetings.prejoin.stNoPerm')}`).length).toBe(1)
    expect(screen.getByText(t('meetings.prejoin.denied.note'))).toBeTruthy()
    const b = joinBtn()
    expect((b as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(b)
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ cameraEnabled: false, micEnabled: false }))
  })

  it('[다시 시도] → 다시 묻고, 허용되면 정상 화면으로', async () => {
    getUserMedia.mockRejectedValue(err('NotAllowedError'))
    renderInRouter(<MeetingsDeviceSetup roomName="방" />)
    await waitFor(() => expect((screen.getByRole('alert')).textContent).toContain(t('meetings.prejoin.denied.title')))
    getUserMedia.mockReset().mockResolvedValue(fakeStream())
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }))
    await ready()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('http(비보안) → 장치 바 대신 한 줄 상자, https 주소 + [https로 다시 열기], 참여는 카메라·마이크 끔', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    const onJoin = vi.fn()
    renderInRouter(<MeetingsDeviceSetup roomName="방" onJoin={onJoin} />)
    await waitFor(() => expect((screen.getByRole('alert')).textContent).toContain(t('meetings.prejoin.http.title')))
    expect(screen.getByRole('button', { name: t('meetings.prejoin.http.open') })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/^.*https:\/\//)
    expect(screen.queryByRole('group', { name: t('meetings.prejoin.group') })).toBeNull()
    expect(screen.getByText(t('meetings.prejoin.http.bar'))).toBeTruthy()
    expect(getUserMedia).not.toHaveBeenCalled()
    fireEvent.click(joinBtn())
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ cameraEnabled: false, micEnabled: false }))
  })

  it('허용 → 3칸 장치 바(이름 · 기본), 선택값으로 참여, 처음엔 스트림을 한 번만 받는다', async () => {
    getUserMedia.mockResolvedValue(fakeStream())
    const onJoin = vi.fn()
    renderInRouter(<MeetingsDeviceSetup roomName="방" onJoin={onJoin} cancelable selfName="하늘" />)
    await ready()
    const group = screen.getByRole('group', { name: t('meetings.prejoin.group') })
    expect(group.textContent).toContain('Microphone Array (Realtek(R) Audio)')
    expect(group.textContent).toContain('HD Webcam C920')
    expect(group.textContent).toContain('스피커 (Realtek(R) Audio)')
    expect(screen.getByText(t('meetings.prejoin.selfTag', { name: '하늘' }))).toBeTruthy()
    // Tab 순서: 마이크 토글 → 마이크 선택 → 카메라 토글 → 카메라 선택 → 스피커 테스트 → 스피커 선택
    const order = Array.from(group.querySelectorAll('button')).map(b => b.getAttribute('aria-label'))
    expect(order).toEqual([
      t('meetings.prejoin.ariaMicOff'), t('meetings.prejoin.ariaMicSelect'),
      t('meetings.prejoin.ariaCamOff'), t('meetings.prejoin.ariaCamSelect'),
      t('meetings.prejoin.ariaSpkTest'), t('meetings.prejoin.ariaSpkSelect'),
    ])
    expect(micToggleOff().getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(joinBtn())
    expect(onJoin).toHaveBeenCalledWith({
      cameraEnabled: true, micEnabled: true, selectedCameraId: 'cam1', selectedMicId: 'mic1', selectedSpeakerId: 'spk1',
    })
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: t('common.cancel') })).toBeTruthy()
  })

  it('브랜드는 사이트 설정이 오기 전엔 비워 둔다', async () => {
    siteConfigStore.setState({ loaded: false, appName: 'Workspace' })
    getUserMedia.mockResolvedValue(fakeStream())
    renderInRouter(<MeetingsDeviceSetup roomName="방" />)
    await ready()
    expect(screen.queryByText('Workspace')).toBeNull()
    act(() => { siteConfigStore.setState({ loaded: true, appName: 'acme' }) })
    expect(screen.getByText('acme')).toBeTruthy()
  })

  it('카메라 끄기 → 아바타 "카메라 꺼짐" + 칸 "꺼짐"(aria 카메라 켜기) → 다시 켜면 그 카메라만 새로 받는다', async () => {
    getUserMedia.mockResolvedValue(fakeStream())
    renderInRouter(<MeetingsDeviceSetup roomName="방" />)
    await waitFor(() => expect(screen.getByRole('button', { name: t('meetings.prejoin.ariaCamOff') })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: t('meetings.prejoin.ariaCamOff') }))
    expect(screen.getByText(t('meetings.prejoin.cameraOff'))).toBeTruthy()
    const on = screen.getByRole('button', { name: t('meetings.prejoin.ariaCamOn') })
    expect(on.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText(t('meetings.prejoin.off.noteCam'))).toBeTruthy()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    fireEvent.click(on)
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2))
    expect(getUserMedia.mock.calls[1][0]).toEqual({ video: { deviceId: { exact: 'cam1' } } })
  })

  it('마이크 끄기 → 좌상단 "마이크 꺼짐" 배지, 둘 다 끄면 "끈 채로 들어갑니다"', async () => {
    getUserMedia.mockResolvedValue(fakeStream())
    const onJoin = vi.fn()
    renderInRouter(<MeetingsDeviceSetup roomName="방" onJoin={onJoin} />)
    await ready()
    fireEvent.click(micToggleOff())
    expect(screen.getByText(t('meetings.prejoin.micOffBadge'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('meetings.prejoin.ariaCamOff') }))
    expect(screen.getByText(t('meetings.prejoin.off.noteBoth'))).toBeTruthy()
    fireEvent.click(joinBtn())
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ cameraEnabled: false, micEnabled: false }))
  })

  it('다른 앱이 카메라를 쓰면(NotReadableError) 마이크는 정상, 카메라 칸 "다른 앱이 사용 중" + 안내 + [다시 시도]', async () => {
    getUserMedia.mockRejectedValueOnce(err('NotReadableError')).mockResolvedValueOnce(fakeStream(false, true))
    const onJoin = vi.fn()
    renderInRouter(<MeetingsDeviceSetup roomName="방" onJoin={onJoin} />)
    await waitFor(() => expect((screen.getByRole('alert')).textContent).toContain(t('meetings.prejoin.inuse.title')))
    expect(screen.getByText(`${t('meetings.device.camera')} · ${t('meetings.prejoin.stInUse')}`)).toBeTruthy()
    expect(micToggleOff()).toBeTruthy()
    expect(screen.getByText(t('meetings.prejoin.nodev.noteCam'))).toBeTruthy()
    fireEvent.click(joinBtn())
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ cameraEnabled: false, micEnabled: true, selectedMicId: 'mic1' }))
    // 다시 시도 → 카메라만 다시 잡는다
    getUserMedia.mockResolvedValueOnce(fakeStream(true, false))
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(getUserMedia.mock.calls[2][0]).toEqual({ video: { deviceId: { exact: 'cam1' } } })
  })

  it('카메라만 없으면(NotFoundError) 아바타 + "연결된 카메라가 없습니다", 칸 "연결된 장치 없음"', async () => {
    getUserMedia.mockRejectedValueOnce(err('NotFoundError')).mockResolvedValueOnce(fakeStream(false, true))
    renderInRouter(<MeetingsDeviceSetup roomName="방" />)
    await waitFor(() => expect(screen.getByText(t('meetings.prejoin.noCameraAvatar'))).toBeTruthy())
    expect(screen.getByText(`${t('meetings.device.camera')} · ${t('meetings.prejoin.stNoDevice')}`)).toBeTruthy()
    expect(screen.getByText(t('meetings.prejoin.nameNoCamera'))).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('카메라 트랙이 끊기면(ended) "카메라 연결이 끊겼습니다" + [다시 연결]', async () => {
    const s = fakeStream()
    getUserMedia.mockResolvedValue(s)
    renderInRouter(<MeetingsDeviceSetup roomName="방" />)
    await ready()
    act(() => { (s.getVideoTracks()[0] as unknown as { end: () => void }).end() })
    expect((screen.getByRole('alert')).textContent).toContain(t('meetings.prejoin.lost.title'))
    expect(screen.getByText(`${t('meetings.device.camera')} · ${t('meetings.prejoin.stLost')}`)).toBeTruthy()
    getUserMedia.mockResolvedValueOnce(fakeStream(true, false))
    fireEvent.click(screen.getByRole('button', { name: t('meetings.prejoin.lost.reconnect') }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('출력 선택 미지원(setSinkId 없음) → 스피커 칸 "고를 수 없음" + 알림 줄, 테스트는 가능', async () => {
    delete (HTMLMediaElement.prototype as any).setSinkId
    getUserMedia.mockResolvedValue(fakeStream())
    renderInRouter(<MeetingsDeviceSetup roomName="방" />)
    await ready()
    expect(screen.getByText(`${t('meetings.device.speaker')} · ${t('meetings.prejoin.stNoSink')}`)).toBeTruthy()
    expect(screen.getByText(t('meetings.prejoin.nosink.notice'))).toBeTruthy()
    expect((screen.getByRole('button', { name: t('meetings.prejoin.ariaSpkSelect') }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: t('meetings.prejoin.ariaSpkTest') }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('MeetingsDeviceSetup — 장치 목록 · 짝 스피커', () => {
  it('마이크 ▾ → listbox(항목마다 레벨), 블루투스 헤드셋을 고르면 스피커도 따라가고 "함께 바뀜" + 되돌리기', async () => {
    getUserMedia.mockResolvedValue(fakeStream())
    const onJoin = vi.fn()
    renderInRouter(<MeetingsDeviceSetup roomName="방" onJoin={onJoin} />)
    await ready()
    const sel = screen.getByRole('button', { name: t('meetings.prejoin.ariaMicSelect') })
    expect(sel.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(sel)
    expect(sel.getAttribute('aria-expanded')).toBe('true')
    const list = screen.getByRole('listbox', { name: t('meetings.prejoin.ariaMicSelect') })
    const opts = Array.from(list.querySelectorAll('[role="option"]'))
    expect(opts.length).toBe(2)
    expect(opts[0].getAttribute('aria-selected')).toBe('true')
    expect(opts[1].textContent).toContain(`WH-1000XM5 Hands-Free (${t('meetings.device.bluetooth')})`)
    // 다른 마이크도 레벨을 보려고 잡는다
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'bt-mic' } } }))
    getUserMedia.mockResolvedValueOnce(fakeStream(false, true, { cam: 'cam1', mic: 'bt-mic' }))
    fireEvent.click(opts[1])
    expect(screen.queryByRole('listbox')).toBeNull()
    await waitFor(() => expect(screen.getByText(`${t('meetings.device.speaker')} · ${t('meetings.prejoin.stPaired')}`)).toBeTruthy())
    expect((screen.getByRole('status')).textContent).toContain(t('meetings.prejoin.bt.notice', { name: 'WH-1000XM5 Stereo' }))
    fireEvent.click(joinBtn())
    expect(onJoin).toHaveBeenLastCalledWith(expect.objectContaining({ selectedMicId: 'bt-mic', selectedSpeakerId: 'bt-spk' }))
    // 되돌리기 → 이전 스피커, 알림 사라짐
    fireEvent.click(screen.getByRole('button', { name: t('meetings.prejoin.bt.undo') }))
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(joinBtn())
    expect(onJoin).toHaveBeenLastCalledWith(expect.objectContaining({ selectedMicId: 'bt-mic', selectedSpeakerId: 'spk1' }))
  })

  it('목록 키보드: Esc 닫고 선택 버튼으로 포커스, 스피커를 직접 고르면 짝 자동 변경이 멈춘다', async () => {
    getUserMedia.mockResolvedValue(fakeStream())
    const onJoin = vi.fn()
    renderInRouter(<MeetingsDeviceSetup roomName="방" onJoin={onJoin} />)
    await ready()
    const spkSel = screen.getByRole('button', { name: t('meetings.prejoin.ariaSpkSelect') })
    fireEvent.click(spkSel)
    const list = screen.getByRole('listbox', { name: t('meetings.prejoin.ariaSpkSelect') })
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(spkSel)
    fireEvent.click(spkSel)
    fireEvent.click(screen.getAllByRole('option')[1])
    // 이제 헤드셋 마이크를 골라도 스피커는 그대로
    fireEvent.click(screen.getByRole('button', { name: t('meetings.prejoin.ariaMicSelect') }))
    getUserMedia.mockResolvedValueOnce(fakeStream(false, true, { cam: 'cam1', mic: 'bt-mic' }))
    fireEvent.click(screen.getAllByRole('option')[1])
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'bt-mic' } } }))
    expect(screen.queryByText(t('meetings.prejoin.stPaired'))).toBeNull()
    fireEvent.click(joinBtn())
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ selectedSpeakerId: 'bt-spk', selectedMicId: 'bt-mic' }))
  })

  it('스피커 [테스트] → 누르는 동안 "재생 중", 고른 출력으로 setSinkId', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const setSink = vi.fn(async () => {})
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { configurable: true, writable: true, value: setSink })
    ;(globalThis as any).AudioContext = class extends FakeAudioContext {
      currentTime = 0
      destination = {}
      createMediaStreamDestination() { return { stream: {} } }
      createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} } }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
    }
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    getUserMedia.mockResolvedValue(fakeStream())
    renderInRouter(<MeetingsDeviceSetup roomName="방" />)
    await ready()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('meetings.prejoin.ariaSpkTest') })) })
    expect(screen.getByText(t('meetings.prejoin.tgPlaying'))).toBeTruthy()
    expect(setSink).toHaveBeenCalledWith('spk1')
    expect(play).toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(screen.queryByText(t('meetings.prejoin.tgPlaying'))).toBeNull()
    expect(pause).toHaveBeenCalled()
    play.mockRestore(); pause.mockRestore()
    vi.useRealTimers()
  })
})

describe('MeetingsDeviceSetup — 손님', () => {
  it('이름 비면 참가 버튼만 잠기고 이유가 버튼 아래', async () => {
    getUserMedia.mockResolvedValue(fakeStream())
    renderInRouter(
      <MeetingsDeviceSetup roomName="방" joinLabel="참가 신청" joinDisabled joinDisabledReason={t('meetings.prejoin.guestNameLock')}>
        <input aria-label="표시 이름" />
      </MeetingsDeviceSetup>,
    )
    await ready()
    const b = screen.getByRole('button', { name: '참가 신청' }) as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(screen.getByText(t('meetings.prejoin.guestNameLock'))).toBeTruthy()
    // 장치 토글은 그대로 조작 가능
    expect((micToggleOff() as HTMLButtonElement).disabled).toBe(false)
  })

  it('승인 대기 → 참가 버튼 자리에 띠(스피너 · 문구 · 경과 · 취소), 미리보기·장치는 그대로', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getUserMedia.mockResolvedValue(fakeStream())
    const onCancel = vi.fn()
    renderInRouter(<MeetingsDeviceSetup roomName="방" waiting waitingSince={Date.now() - 42_000} onCancel={onCancel} />)
    await ready()
    expect(screen.queryByRole('button', { name: t('meetings.device.joinDefault') })).toBeNull()
    const band = screen.getByRole('status')
    expect((band).textContent).toContain(t('meetings.prejoin.waiting.title'))
    expect(band.querySelector('.font-mono')?.textContent).toBe('0:42')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(band.querySelector('.font-mono')?.textContent).toBe('0:44')
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }))
    expect(onCancel).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
