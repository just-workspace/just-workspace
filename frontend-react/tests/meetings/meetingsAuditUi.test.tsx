// 회의 화면 감사 수정 회귀(컴포넌트):
//  - 장치 확인 화면이 내려간 뒤 도착한 카메라·마이크 스트림은 바로 끈다(표시등이 켜진 채 남지 않게)
//  - 채팅 탭으로 바로 열어도, 열어 둔 동안 새 글이 와도 안 읽음 배지가 지워진다
//  - 초대 입력: 한글 조합 중 Enter 는 칩을 넣거나 폼을 제출하지 않는다
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { i18n } from '~/i18n'
import { meetingsStore } from '~/composables/useMeetings'
import { mediaDevicesStore } from '~/composables/useMediaDevices'
import { siteConfigStore } from '~/composables/useSiteConfig'
import { MeetingsDeviceSetup } from '~/components/meetings/MeetingsDeviceSetup'
import { MeetingsSidebar } from '~/components/meetings/MeetingsSidebar'
import { MeetingsInviteModal } from '~/components/meetings/MeetingsInviteModal'
import { renderInRouter } from '../ui/helpers'

const t = (k: string, a?: Record<string, unknown>) => i18n.t(k, a)

function fakeStream() {
  const mk = (kind: string) => ({ kind, stop: vi.fn(), getSettings: () => ({ deviceId: kind }), addEventListener: () => {} })
  const v = [mk('video')]
  const a = [mk('audio')]
  return { getVideoTracks: () => v, getAudioTracks: () => a, getTracks: () => [...v, ...a] }
}

describe('MeetingsDeviceSetup — 떠난 뒤 도착한 스트림', () => {
  let secureDesc: PropertyDescriptor | undefined
  beforeEach(() => {
    ;(globalThis as any).AudioContext = class {
      createAnalyser() { return { fftSize: 0, frequencyBinCount: 4, getByteTimeDomainData: () => {} } }
      createMediaStreamSource() { return { connect: () => {} } }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    ;(globalThis as any).MediaStream = undefined
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get: () => null, set: () => {} })
    secureDesc = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    mediaDevicesStore.setState({ cameras: [], microphones: [], speakers: [] })
    siteConfigStore.setState({ loaded: true, appName: 'acme' })
  })
  afterEach(() => {
    delete (navigator as any).mediaDevices
    if (secureDesc) Object.defineProperty(window, 'isSecureContext', secureDesc)
    else delete (window as any).isSecureContext
  })

  it('권한 요청이 끝나기 전에 화면이 내려가면, 뒤늦게 온 스트림의 트랙을 전부 끈다', async () => {
    let release: (s: unknown) => void = () => {}
    const getUserMedia = vi.fn(() => new Promise((resolve) => { release = resolve }))
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn(async () => []), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    })
    const { unmount } = renderInRouter(<MeetingsDeviceSetup roomName="방" />)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    unmount()   // [참여하기]·[취소]로 화면이 내려감
    const stream = fakeStream()
    await act(async () => { release(stream); await Promise.resolve(); await Promise.resolve() })
    for (const tr of stream.getTracks()) expect(tr.stop).toHaveBeenCalled()
  })
})

describe('MeetingsSidebar — 채팅 읽음', () => {
  it('채팅 탭으로 바로 열면 안 읽음이 지워지고, 열어 둔 동안 온 글도 쌓이지 않는다', () => {
    act(() => { meetingsStore.setState({ isHost: false, unreadChat: 3, pendingRequests: [], participants: [], chatMessages: [] }) })
    render(<MeetingsSidebar activeTab="chat" />)
    expect(meetingsStore.getState().unreadChat).toBe(0)
    act(() => { meetingsStore.setState({ unreadChat: 1 }) })
    expect(meetingsStore.getState().unreadChat).toBe(0)
  })

  it('다른 탭을 보고 있으면 안 읽음은 그대로', () => {
    act(() => { meetingsStore.setState({ isHost: false, unreadChat: 2, pendingRequests: [], participants: [], chatMessages: [] }) })
    render(<MeetingsSidebar activeTab="participants" />)
    expect(meetingsStore.getState().unreadChat).toBe(2)
    act(() => { meetingsStore.setState({ unreadChat: 0 }) })
  })
})

describe('MeetingsInviteModal — 한글 조합 중 Enter', () => {
  it('조합 중 Enter 는 칩을 넣지 않고 기본 동작(폼 제출)도 막는다. 조합이 끝난 Enter 는 예전대로', () => {
    const onCreate = vi.fn()
    render(<MeetingsInviteModal mode="now" onCreate={onCreate} />)
    fireEvent.change(screen.getByLabelText(t('meetings.invite.meetingName')), { target: { value: 'A' } })
    const inp = screen.getByPlaceholderText(t('meetings.invite.peoplePlaceholder'))
    fireEvent.change(inp, { target: { value: 'x@ex.com' } })
    // 윈도우 크롬: key "Process" · keyCode 229 / 맥: key "Enter" · isComposing
    const notPrevented1 = fireEvent.keyDown(inp, { key: 'Process', code: 'Enter', keyCode: 229 })
    const notPrevented2 = fireEvent.keyDown(inp, { key: 'Enter', code: 'Enter', isComposing: true })
    expect(notPrevented1).toBe(false)
    expect(notPrevented2).toBe(false)
    expect(screen.queryByText('x@ex.com')).toBeNull()
    expect(onCreate).not.toHaveBeenCalled()
    fireEvent.keyDown(inp, { key: 'Enter', code: 'Enter' })
    expect(screen.getByText('x@ex.com')).toBeTruthy()
  })
})
