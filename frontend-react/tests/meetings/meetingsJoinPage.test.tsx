// 초대 링크 입장 화면 감사 수정 회귀:
//  - 대기 중 신청·링크가 없어지면(404) "승인 대기 중"으로 남지 않고 만료 화면으로 전환
//  - [취소]는 서버에도 통지(호스트 대기실에 유령 신청이 남지 않도록)
//  - 이 화면에서 입장하지 않은 통화(미니 창으로 내려 둔 다른 통화)는 화면을 떠나도 종료하지 않음
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { i18n } from '~/i18n'

vi.mock('livekit-client', () => ({ Room: class {}, RoomEvent: {}, Track: { Source: {} }, TrackEvent: {}, VideoPresets: {}, ParticipantKind: {}, DisconnectReason: {} }))
vi.mock('~/lib/api', async (orig) => {
  const mod = await orig<typeof import('~/lib/api')>()
  return { ...mod, $fetch: vi.fn() }
})
// 장치 확인 화면 대신: 호출부 입력(이름) + [신청] + 대기 중이면 [취소]
vi.mock('~/components/meetings/MeetingsDeviceSetup', () => ({
  MeetingsDeviceSetup: (p: { onJoin?: () => void; onCancel?: () => void; waiting?: boolean; children?: React.ReactNode }) => (
    <div>
      {p.children}
      {p.waiting
        ? <button data-testid="cancel" onClick={() => p.onCancel?.()}>waiting</button>
        : <button data-testid="request" onClick={() => p.onJoin?.()}>request</button>}
    </div>
  ),
}))

const { $fetch } = await import('~/lib/api')
const { meetingsStore } = await import('~/composables/useMeetings')
const { default: MeetingJoinPage } = await import('~/pages/meetings/join/[token]')

const t = (k: string, a?: Record<string, unknown>) => i18n.t(k, a)
const info = { name: '주간 회의', host_name: 'Alice', num_participants: 1, max_participants: 10, requires_password: false }
const httpErr = (status: number, detail: unknown) => Object.assign(new Error(String(status)), { status, data: { detail } })

function renderJoin() {
  const router = createMemoryRouter([{ path: '/meetings/join/:token', element: <MeetingJoinPage /> }], { initialEntries: ['/meetings/join/tok1'] })
  return render(<RouterProvider router={router} />)
}
async function requestJoin() {
  fireEvent.change(await screen.findByLabelText(t('meetings.join.displayName')), { target: { value: '손님' } })
  fireEvent.click(screen.getByTestId('request'))
  await screen.findByTestId('cancel')
}

beforeEach(() => {
  vi.mocked($fetch).mockReset()
  meetingsStore.setState({ inCall: false, connected: false, currentRoom: null, currentRoomName: null })
})

describe('초대 링크 입장 — 대기', () => {
  it('대기 중 회의가 끝나 신청이 없어지면 만료 화면으로 넘어간다', async () => {
    let ended = false
    vi.mocked($fetch).mockImplementation(async (url: any, opts: any) => {
      const u = String(url)
      if (u === '/api/meetings/join/tok1') {
        if (ended) throw httpErr(410, { code: 'ended', name: '주간 회의', host_name: 'Alice', ended_at: '2026-10-15T07:00:00+00:00' })
        return info as any
      }
      if (u.endsWith('/request') && opts?.method === 'POST') return { request_id: 'req1', status: 'pending' } as any
      if (u.endsWith('/request/req1/status')) { ended = true; throw httpErr(404, '유효하지 않은 초대 링크입니다') }
      return {} as any
    })
    renderJoin()
    await requestJoin()
    await waitFor(() => expect(screen.getByText(t('meetings.join.expiredTitle'))).toBeTruthy(), { timeout: 4000 })
    expect(screen.queryByTestId('cancel')).toBeNull()
  })

  it('[취소]는 서버에 취소를 알리고, 뒤늦은 "승인" 응답으로 입장하지 않는다', async () => {
    let releaseStatus: (v: unknown) => void = () => {}
    vi.mocked($fetch).mockImplementation(async (url: any, opts: any) => {
      const u = String(url)
      if (u === '/api/meetings/join/tok1') return info as any
      if (u.endsWith('/request') && opts?.method === 'POST') return { request_id: 'req1', status: 'pending' } as any
      if (u.endsWith('/request/req1/status')) return new Promise((resolve) => { releaseStatus = resolve }) as any
      return {} as any
    })
    renderJoin()
    await requestJoin()
    await waitFor(() => expect(vi.mocked($fetch).mock.calls.some(c => String(c[0]).endsWith('/status'))).toBe(true), { timeout: 3000 })
    fireEvent.click(screen.getByTestId('cancel'))
    expect(vi.mocked($fetch)).toHaveBeenCalledWith('/api/meetings/join/tok1/request/req1/cancel', { method: 'POST' })
    await act(async () => { releaseStatus({ status: 'approved', token: 'lk', livekit_url: 'wss://x/' }); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByTestId('request')).toBeTruthy()   // 입장 화면 그대로
    expect(meetingsStore.getState().inCall).toBe(false)
  })
})

describe('초대 링크 입장 — 떠날 때', () => {
  it('이 화면에서 들어가지 않은 통화는 끊지 않는다', async () => {
    vi.mocked($fetch).mockResolvedValue(info as any)
    const { unmount } = renderJoin()
    await screen.findByTestId('request')
    // 미니 창에 내려 둔 다른 통화
    act(() => { meetingsStore.setState({ inCall: true, connected: true, currentRoomName: '다른 회의' }) })
    unmount()
    await Promise.resolve()
    expect(meetingsStore.getState().inCall).toBe(true)
    expect(meetingsStore.getState().currentRoomName).toBe('다른 회의')
    meetingsStore.setState({ inCall: false, connected: false, currentRoomName: null })
  })
})
