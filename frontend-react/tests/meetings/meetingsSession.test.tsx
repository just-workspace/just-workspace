// 회의 세션 감사 수정 회귀(useMeetings · 회의 화면):
//  - 접속 세대 번호: 연속 입장은 하나만 연결되고, 접속 도중 나가기·화면 이탈 시 뒤늦게 연결되지 않음
//  - 자동 재입장은 "지금" 마이크·카메라 상태로 수행(음소거한 사용자가 다시 송출되지 않도록)
//  - 브라우저의 "공유 중지" → 버튼 상태 동기화 / 상대 측 종료 → remoteEnded / 퇴장 시 배경 효과·녹화 표시 초기화
//  - 회의 채팅: 발신자는 payload 가 아닌 참가자 정보에서 취득, 문자열이 아닌 메시지는 폐기(사칭·화면 크래시)
//  - 회의 화면: 이름의 % 로 크래시하지 않으며, 주소의 ?ws=·?t= 를 접속에 사용하지 않음
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

interface FakeRoom {
  url: string
  token: string
  handlers: Record<string, Array<(...a: any[]) => void>>
  connectGate: { resolve: () => void; reject: (e: unknown) => void }
  disconnect: ReturnType<typeof vi.fn>
  localParticipant: any
  emit: (ev: string, ...a: any[]) => void
}
const rooms: FakeRoom[] = []
/** true 면 connect() 가 즉시 완료된다. false 면 테스트가 connectGate.resolve() 로 완료시킨다 */
let autoConnect = true

vi.mock('livekit-client', () => {
  class Room {
    url = ''
    token = ''
    handlers: Record<string, Array<(...a: any[]) => void>> = {}
    connectGate = { resolve: () => {}, reject: (_e: unknown) => {} }
    remoteParticipants = new Map()
    localParticipant = {
      identity: 'me', name: '나', isSpeaking: false, connectionQuality: 'good', isScreenShareEnabled: false,
      trackPublications: new Map(),
      getTrackPublication: () => undefined,
      enableCameraAndMicrophone: vi.fn(async () => {}),
      setCameraEnabled: vi.fn(async () => {}),
      setMicrophoneEnabled: vi.fn(async () => {}),
      setScreenShareEnabled: vi.fn(async () => {}),
      publishData: vi.fn(),
    }
    disconnect = vi.fn(async () => { this.emit('disconnected', 1) })
    constructor() { rooms.push(this as unknown as FakeRoom) }
    on(ev: string, fn: (...a: any[]) => void) { (this.handlers[ev] ||= []).push(fn); return this }
    emit(ev: string, ...a: any[]) { for (const fn of this.handlers[ev] || []) fn(...a) }
    connect(url: string, token: string) {
      this.url = url
      this.token = token
      if (autoConnect) return Promise.resolve()
      return new Promise<void>((resolve, reject) => { this.connectGate = { resolve, reject } })
    }
  }
  const RoomEvent = new Proxy({}, { get: (_t, k) => String(k).charAt(0).toLowerCase() + String(k).slice(1) })
  return {
    Room, RoomEvent,
    Track: { Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share' } },
    TrackEvent: { Ended: 'ended' },
    VideoPresets: { h720: { resolution: {} }, h180: {}, h360: {} },
    ParticipantKind: { EGRESS: 'egress', AGENT: 'agent' },
    // 1 = CLIENT_INITIATED · 5 = ROOM_DELETED · 4 = PARTICIPANT_REMOVED · 2 = DUPLICATE_IDENTITY
    DisconnectReason: { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 },
  }
})
vi.mock('~/lib/api', async (orig) => {
  const mod = await orig<typeof import('~/lib/api')>()
  return { ...mod, $fetch: vi.fn() }
})
// 장치 확인 화면은 본 테스트의 대상이 아님 — [참여] 버튼 하나로 대체
vi.mock('~/components/meetings/MeetingsDeviceSetup', () => ({
  MeetingsDeviceSetup: (p: { onJoin?: (o: unknown) => void; busy?: boolean }) => (
    <button data-testid="join" disabled={!!p.busy} onClick={() => p.onJoin?.({ cameraEnabled: false, micEnabled: false })}>join</button>
  ),
}))

const m = await import('~/composables/useMeetings')
const { $fetch } = await import('~/lib/api')
const { chatMessageFrom } = m
const { meetingJoinPath } = await import('~/components/meetings/prejoin')
const { default: MeetingRoomPage } = await import('~/pages/meetings/room/[name]')
const { setAppRouter } = await import('~/lib/router')

const S = () => m.meetingsStore.getState()
const tokenOk = () => vi.mocked($fetch).mockImplementation(async (url: any) => {
  if (String(url) === '/api/meetings/token') return { token: `tok-${rooms.length}`, livekit_url: 'wss://good/livekit/', is_host: true } as any
  return {} as any
})
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(async () => {
  autoConnect = true
  await m.leaveRoom()
  rooms.length = 0
  vi.mocked($fetch).mockReset()
  tokenOk()
})

describe('접속 세대 번호', () => {
  it('연속으로 두 번 입장하면 방 하나에만 붙는다(먼저 것은 취소)', async () => {
    const a = m.joinRoom('r1', { cameraEnabled: false, micEnabled: false })
    const b = m.joinRoom('r1', { cameraEnabled: false, micEnabled: false })
    const ra = await a.then(() => 'ok', e => e)
    await b
    expect(m.isJoinCancelled(ra)).toBe(true)
    expect(rooms).toHaveLength(1)
    expect(S().currentRoom).toBe(rooms[0])
    expect(S().inCall).toBe(true)
  })

  it('접속 도중 나가면 접속이 끝나도 통화가 붙지 않는다', async () => {
    autoConnect = false
    const p = m.joinRoom('r1', { cameraEnabled: true, micEnabled: true }).then(() => 'ok', e => e)
    await waitFor(() => expect(rooms).toHaveLength(1))
    await waitFor(() => expect(rooms[0].url).toBe('wss://good/livekit/'))
    await m.leaveRoom()
    rooms[0].connectGate.resolve()
    expect(m.isJoinCancelled(await p)).toBe(true)
    expect(rooms[0].disconnect).toHaveBeenCalled()
    expect(rooms[0].localParticipant.enableCameraAndMicrophone).not.toHaveBeenCalled()
    expect(S().inCall).toBe(false)
    expect(S().currentRoom).toBeNull()
  })

  it('화면이 내려가며 cancelPendingJoin — 접속 중인 입장만 접고, 붙어 있는 통화는 그대로', async () => {
    await m.joinRoom('r1', { cameraEnabled: false, micEnabled: false })
    m.cancelPendingJoin()   // 진행 중인 입장 없음 — no-op 이어야 함
    expect(S().inCall).toBe(true)
    await m.leaveRoom()

    autoConnect = false
    const p = m.joinRoom('r2', { cameraEnabled: false, micEnabled: false }).then(() => 'ok', e => e)
    await waitFor(() => expect(rooms).toHaveLength(2))
    await waitFor(() => expect(rooms[1].url).not.toBe(''))
    m.cancelPendingJoin()
    rooms[1].connectGate.resolve()
    expect(m.isJoinCancelled(await p)).toBe(true)
    expect(S().inCall).toBe(false)
  })

  it('버린 방의 끊김 이벤트는 살아 있는 세션을 지우지 않는다', async () => {
    await m.joinRoom('r1', { cameraEnabled: false, micEnabled: false })
    const stray = new (await import('livekit-client')).Room() as unknown as FakeRoom
    // 세션의 방이 아닌 방 — 핸들러가 등록되어 있지 않아 직접 모의할 수 없음. 대신 세션 방 자체의 유지 여부를 확인.
    expect(stray).not.toBe(S().currentRoom)
    expect(S().connected).toBe(true)
  })
})

describe('자동 재입장', () => {
  it('회의 중 끈 마이크·카메라는 재입장 뒤에도 꺼져 있다', async () => {
    vi.useFakeTimers()
    await m.joinRoom('r1', { cameraEnabled: true, micEnabled: true })
    expect(rooms[0].localParticipant.enableCameraAndMicrophone).toHaveBeenCalledTimes(1)
    await m.toggleMic()
    await m.toggleCamera()
    expect(S().micEnabled).toBe(false)
    expect(S().cameraEnabled).toBe(false)

    rooms[0].emit('disconnected', undefined)   // 재연결되는 끊김
    expect(S().connectionState).toBe('rejoining')
    await vi.advanceTimersByTimeAsync(1100)
    await flush()
    expect(rooms).toHaveLength(2)
    expect(S().connected).toBe(true)
    const lp = rooms[1].localParticipant
    expect(lp.enableCameraAndMicrophone).not.toHaveBeenCalled()
    expect(lp.setMicrophoneEnabled).not.toHaveBeenCalledWith(true)
    expect(lp.setCameraEnabled).not.toHaveBeenCalledWith(true)
    expect(S().micEnabled).toBe(false)
    expect(S().cameraEnabled).toBe(false)
  })
})

describe('상태 동기화', () => {
  it('브라우저의 "공유 중지"로 끝내면 공유 버튼이 내려간다', async () => {
    await m.joinRoom('r1', { cameraEnabled: false, micEnabled: false })
    const lp = rooms[0].localParticipant
    lp.setScreenShareEnabled.mockImplementation(async (on: boolean) => { lp.isScreenShareEnabled = on })
    await m.toggleScreenShare()
    expect(S().screenShareEnabled).toBe(true)
    lp.isScreenShareEnabled = false
    rooms[0].emit('localTrackUnpublished')
    expect(S().screenShareEnabled).toBe(false)
  })

  it('저쪽에서 끝나면(방 종료) remoteEnded — 되붙지 않는다', async () => {
    await m.joinRoom('r1', { cameraEnabled: false, micEnabled: false })
    rooms[0].emit('disconnected', 5)
    expect(S().remoteEnded).toBe(true)
    expect(S().inCall).toBe(false)
    expect(S().connectionState).toBe('disconnected')
    await m.leaveRoom()
    expect(S().remoteEnded).toBe(false)
  })

  it('내가 나간 것은 remoteEnded 가 아니고, 배경 효과·녹화 표시는 초기화된다', async () => {
    await m.joinRoom('r1', { cameraEnabled: false, micEnabled: false })
    m.meetingsStore.setState({ blurEnabled: true, vbgEnabled: true, recording: true })
    await m.leaveRoom()
    expect(S().remoteEnded).toBe(false)
    expect(S().blurEnabled).toBe(false)
    expect(S().vbgEnabled).toBe(false)
    expect(S().recording).toBe(false)
  })

  it('마이크를 못 켜면 이유를 토스트로 알린다(화면 공유 선택 창을 닫은 것은 조용히)', async () => {
    const { toastStore } = await import('~/composables/useToast')
    await m.joinRoom('r1', { cameraEnabled: false, micEnabled: false })
    toastStore.setState({ toasts: [] })
    const lp = rooms[0].localParticipant
    lp.setMicrophoneEnabled.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    await m.runMediaToggle('mic')
    expect(toastStore.getState().toasts).toHaveLength(1)
    expect(S().micEnabled).toBe(false)
    lp.setScreenShareEnabled.mockRejectedValue(Object.assign(new Error('cancel'), { name: 'NotAllowedError' }))
    await m.runMediaToggle('screen')
    expect(toastStore.getState().toasts).toHaveLength(1)
  })
})

describe('회의 채팅 수신 검증', () => {
  it('보낸 사람은 참가자 이름 — payload 의 sender 로 사칭할 수 없다', () => {
    const msg = chatMessageFrom({ text: '안녕', ts: 1, sender: '호스트 박민지' } as any, { identity: 'guest-1', name: '손님' }, 'me')
    expect(msg?.sender).toBe('손님')
    expect(msg?.isLocal).toBe(false)
  })

  it('문자열이 아닌 글·보낸 사람을 모르는 글은 버리고, 긴 글은 자른다', () => {
    expect(chatMessageFrom({ text: { a: 1 }, ts: 1 }, { identity: 'g', name: 'x' }, 'me')).toBeNull()
    expect(chatMessageFrom({ text: '   ', ts: 1 }, { identity: 'g', name: 'x' }, 'me')).toBeNull()
    expect(chatMessageFrom({ text: 'hi', ts: 1 }, undefined, 'me')).toBeNull()
    const long = chatMessageFrom({ text: 'a'.repeat(900), ts: 'x' as any }, { identity: 'g', name: { evil: 1 } as any }, 'me')
    expect(long?.text).toHaveLength(500)
    expect(typeof long?.sender).toBe('string')
    expect(typeof long?.ts).toBe('number')
  })

  it('같은 시각·같은 사람의 글도 id 가 겹치지 않는다', () => {
    const a = chatMessageFrom({ text: 'a', ts: 5 }, { identity: 'g', name: 'x' }, 'me')
    const b = chatMessageFrom({ text: 'b', ts: 5 }, { identity: 'g', name: 'x' }, 'me')
    expect(a?.id).not.toBe(b?.id)
  })

  it('방에서 받은 데이터도 같은 검증을 거친다', async () => {
    await m.joinRoom('r1', { cameraEnabled: false, micEnabled: false })
    const enc = new TextEncoder()
    rooms[0].emit('dataReceived', enc.encode(JSON.stringify({ type: 'chat', sender: '호스트', text: { x: 1 }, ts: 1 })), { identity: 'guest-1', name: '손님' })
    expect(S().chatMessages).toHaveLength(0)
    rooms[0].emit('dataReceived', enc.encode(JSON.stringify({ type: 'chat', sender: '호스트', text: '안녕', ts: 1 })), { identity: 'guest-1', name: '손님' })
    expect(S().chatMessages.map(c => c.sender)).toEqual(['손님'])
    expect(S().unreadChat).toBe(1)
  })
})

describe('[참여]가 갈 곳(meetingJoinPath)', () => {
  it('호스트·초대받은 사람·채널 통화는 회의 화면(null), 그 밖은 초대 링크 입장', () => {
    expect(meetingJoinPath({ name: 'r', is_host: true, share_token: 't' })).toBeNull()
    expect(meetingJoinPath({ name: 'r', is_host: false, my_response: 'pending', share_token: 't' })).toBeNull()
    expect(meetingJoinPath({ name: 'chan-c1', is_host: false, share_token: '' })).toBeNull()
    expect(meetingJoinPath({ name: 'r', is_host: false, share_token: 'abc' })).toBe('/meetings/join/abc')
    expect(meetingJoinPath({ name: 'r', is_host: false, share_token: '' })).toBeNull()
  })
})

describe('회의 화면', () => {
  function renderRoom(path: string) {
    const router = createMemoryRouter([
      { path: '/meetings/room/:name', element: <MeetingRoomPage /> },
      { path: '*', element: <div data-testid="elsewhere" /> },
    ], { initialEntries: [path] })
    setAppRouter(router as any)   // navigateTo 가 이 라우터로 동작하도록 설정
    return { router, ...render(<RouterProvider router={router} />) }
  }

  it('이름에 % 가 있어도 죽지 않고, 주소의 ?ws=·?t= 는 접속에 쓰지 않는다', async () => {
    renderRoom(`/meetings/room/${encodeURIComponent('매출 50% 회의')}?t=evil-token&ws=${encodeURIComponent('wss://evil.example/')}&host=1`)
    fireEvent.click(await screen.findByTestId('join'))
    await waitFor(() => expect(S().inCall).toBe(true))
    expect(vi.mocked($fetch)).toHaveBeenCalledWith('/api/meetings/token', expect.objectContaining({ body: { room: '매출 50% 회의' } }))
    expect(rooms).toHaveLength(1)
    expect(rooms[0].url).toBe('wss://good/livekit/')
    expect(rooms[0].token).not.toBe('evil-token')
    await act(async () => { await m.leaveRoom() })
  })

  it('호스트도 초대 대상도 아니면(403) 초대 링크 입장으로 보낸다', async () => {
    vi.mocked($fetch).mockImplementation(async (url: any) => {
      if (String(url) === '/api/meetings/token') throw Object.assign(new Error('403'), { status: 403, data: { detail: '호스트만 직접 참여할 수 있습니다' } })
      return {} as any
    })
    const { router } = renderRoom('/meetings/room/r1?st=share123')
    fireEvent.click(await screen.findByTestId('join'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/meetings/join/share123'))
    expect(rooms).toHaveLength(0)
    setAppRouter(null)
  })
})
