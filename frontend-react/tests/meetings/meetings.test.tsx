// 회의 모듈: 그리드 배치 계산 · 예약 창 페이로드(만들기/수정 diff) · 목록 ⋮ 메뉴 · 컨트롤 바 · 사이드바 · 결과 화면
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { i18n } from '~/i18n'
import { gridLayoutFor } from '~/composables/useGridLayout'
import { meetingsStore, toggleRecording, deleteRoom, type MeetingRoomInfo } from '~/composables/useMeetings'
import { toastStore } from '~/composables/useToast'
import { MeetingsRecordingsModal } from '~/components/meetings/MeetingsRecordingsModal'
import { MeetingsInviteModal } from '~/components/meetings/MeetingsInviteModal'
import { MeetingsList } from '~/components/meetings/MeetingsList'
import { MeetingsControls } from '~/components/meetings/MeetingsControls'
import { MeetingsSidebar } from '~/components/meetings/MeetingsSidebar'
import { MeetingsResultScreen } from '~/components/meetings/MeetingsResultScreen'
import { renderInRouter } from '../ui/helpers'

vi.mock('~/lib/api', async (orig) => {
  const mod = await orig<typeof import('~/lib/api')>()
  return { ...mod, $fetch: vi.fn() }
})
import { $fetch } from '~/lib/api'

const t = (k: string, a?: Record<string, unknown>) => i18n.t(k, a)

function room(p: Partial<MeetingRoomInfo> = {}): MeetingRoomInfo {
  return {
    name: 'r1', num_participants: 0, max_participants: 10, creation_time: 0, share_token: 'tok',
    is_host: true, pending_count: 0, status: 'scheduled', ...p,
  }
}

describe('gridLayoutFor (useGridLayout)', () => {
  it('측정 전에는 단계식 폴백', () => {
    expect(gridLayoutFor(1, 0, 0)).toEqual({ cols: 1, rows: 1 })
    expect(gridLayoutFor(4, 0, 0)).toEqual({ cols: 2, rows: 2 })
    expect(gridLayoutFor(7, 0, 0)).toEqual({ cols: 3, rows: 3 })
  })
  it('넓은 화면 2명은 가로로, 세로로 긴 화면 2명은 세로로', () => {
    expect(gridLayoutFor(2, 1600, 450)).toEqual({ cols: 2, rows: 1 })
    expect(gridLayoutFor(2, 400, 900)).toEqual({ cols: 1, rows: 2 })
  })
  it('6명 16:9 컨테이너 → 3×2', () => {
    expect(gridLayoutFor(6, 1600, 900)).toEqual({ cols: 3, rows: 2 })
  })
})

describe('MeetingsInviteModal', () => {
  beforeEach(() => { vi.mocked($fetch).mockReset() })

  it('이름 없으면 오류, 지금 시작은 scheduled_at null', () => {
    const onCreate = vi.fn()
    render(<MeetingsInviteModal mode="now" onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: t('meetings.invite.startBtn') }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByText(t('meetings.invite.nameRequired'))).toBeTruthy()
    fireEvent.change(screen.getByLabelText(t('meetings.invite.meetingName')), { target: { value: ' 주간 ' } })
    expect(screen.queryByText(t('meetings.invite.nameRequired'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('meetings.invite.startBtn') }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: '주간', scheduled_at: null, duration_minutes: 60, password: null, waiting_room: true, add_to_calendar: false, invitees: [],
    }))
  })

  it('외부 이메일 Enter 로 칩 추가 → 페이로드에 external', () => {
    const onCreate = vi.fn()
    render(<MeetingsInviteModal mode="schedule" onCreate={onCreate} />)
    fireEvent.change(screen.getByLabelText(t('meetings.invite.meetingName')), { target: { value: 'A' } })
    const inp = screen.getByPlaceholderText(t('meetings.invite.peoplePlaceholder'))
    fireEvent.change(inp, { target: { value: 'x@ex.com' } })
    fireEvent.keyDown(inp, { key: 'Enter' })
    expect(screen.getByText('x@ex.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('meetings.invite.scheduleBtn') }))
    const p = onCreate.mock.calls[0][0]
    expect(p.invitees).toEqual([{ type: 'external', email: 'x@ex.com' }])
    expect(typeof p.scheduled_at).toBe('string')
    expect(p.add_to_calendar).toBe(true)
  })

  it('서버 409 이름 오류를 이름 칸에 보여 준다', () => {
    const { rerender } = render(<MeetingsInviteModal mode="now" />)
    rerender(<MeetingsInviteModal mode="now" serverNameError="이미 있음" />)
    expect(screen.getByText('이미 있음')).toBeTruthy()
  })

  it('수정: 바뀐 것만 보내고, 뺀 초대는 remove_invitee_ids', async () => {
    vi.mocked($fetch).mockResolvedValueOnce({
      invitees: [{ id: 'inv1', user_id: 'u1', email: 'a@x', display_name: '가', response: 'accepted', responded_at: null }],
    } as any)
    const onUpdate = vi.fn(); const onClose = vi.fn()
    render(<MeetingsInviteModal mode="edit" room={room({ meeting_id: 'm1', title: '원래', duration_minutes: 60 })} onUpdate={onUpdate} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('가')).toBeTruthy())
    // 아무것도 안 바꾸고 저장 → 닫기만
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))
    expect(onClose).toHaveBeenCalled()
    expect(onUpdate).not.toHaveBeenCalled()
    // 초대 빼고 제목 바꾸기
    fireEvent.click(screen.getByRole('button', { name: t('meetings.invite.removeInvitee', { name: '가' }) }))
    fireEvent.change(screen.getByLabelText(t('meetings.invite.meetingName')), { target: { value: '새 제목' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))
    expect(onUpdate).toHaveBeenCalledWith({ title: '새 제목', remove_invitee_ids: ['inv1'] })
  })
})

describe('MeetingsList', () => {
  const now = new Date('2026-10-17T10:00:00')

  it('진행 중 행: 참여 버튼 · ⋮ 메뉴(호스트: 수정·종료·삭제)', () => {
    const onJoin = vi.fn(); const onEnd = vi.fn()
    const live = room({ num_participants: 2, status: 'live', meeting_id: 'm1', title: '라이브', scheduled_at: '2026-10-17T09:30:00', duration_minutes: 60 })
    renderInRouter(<MeetingsList rooms={[live]} now={now} onJoin={onJoin} onEnd={onEnd} />)
    fireEvent.click(screen.getByRole('button', { name: t('meetings.list.join') }))
    expect(onJoin).toHaveBeenCalledWith(live)
    fireEvent.click(screen.getByRole('button', { name: t('meetings.list.rowMenu', { name: '라이브' }) }))
    expect(screen.getByText(t('common.edit'))).toBeTruthy()
    expect(screen.getByText(t('common.delete'))).toBeTruthy()
    fireEvent.click(screen.getByText(t('meetings.list.end')))
    expect(onEnd).toHaveBeenCalledWith(live)
  })

  it('초대받은 회의: 내 응답 RSVP 항목', () => {
    const onRsvp = vi.fn()
    const inv = room({ is_host: false, my_response: 'pending', meeting_id: 'm2', title: '초대', scheduled_at: '2026-10-18T10:00:00', duration_minutes: 30 })
    renderInRouter(<MeetingsList rooms={[inv]} now={now} onRsvp={onRsvp} />)
    expect(screen.getByText(t('meetings.rsvp.state.pending'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('meetings.list.rowMenu', { name: '초대' }) }))
    expect(screen.queryByText(t('common.delete'))).toBeNull()
    fireEvent.click(screen.getByText(t('meetings.rsvp.accepted')))
    expect(onRsvp).toHaveBeenCalledWith(inv, 'accepted')
  })
  it('끝난 회의 ⋮ "녹화 파일" → onRecordings(초대받은 사람도)', () => {
    const onRecordings = vi.fn()
    const done = room({ is_host: false, status: 'ended', meeting_id: 'm3', title: '지난', scheduled_at: '2026-10-16T10:00:00', duration_minutes: 30 })
    renderInRouter(<MeetingsList rooms={[done]} now={now} onRecordings={onRecordings} />)
    fireEvent.click(screen.getByRole('button', { name: t('meetings.list.rowMenu', { name: '지난' }) }))
    fireEvent.click(screen.getByText(t('meetings.recordings.menu')))
    expect(onRecordings).toHaveBeenCalledWith(done)
  })

  it('진행 중·예정 회의에는 "녹화 파일" 항목이 없다', () => {
    const live = room({ num_participants: 2, status: 'live', meeting_id: 'm1', title: '라이브', scheduled_at: '2026-10-17T09:30:00', duration_minutes: 60 })
    renderInRouter(<MeetingsList rooms={[live]} now={now} onRecordings={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: t('meetings.list.rowMenu', { name: '라이브' }) }))
    expect(screen.queryByText(t('meetings.recordings.menu'))).toBeNull()
  })
})

describe('MeetingsRecordingsModal', () => {
  beforeEach(() => { vi.mocked($fetch).mockReset() })

  it('그 방 녹화만 묻고 시각·내려받기 링크를 그린다', async () => {
    vi.mocked($fetch).mockResolvedValue({ recordings: [{ filename: 'r1_20261018-210512.mp4', size: 2048, mtime: 0 }] } as any)
    render(<MeetingsRecordingsModal room="r1" title="주간" onClose={vi.fn()} />)
    await screen.findByText('2026-10-18 21:05')
    expect(vi.mocked($fetch)).toHaveBeenCalledWith('/api/meetings/recordings', { query: { room: 'r1' } })
    const a = screen.getByRole('link', { name: t('meetings.recordings.downloadName', { name: '2026-10-18 21:05' }) })
    expect(a.getAttribute('href')).toBe('/api/meetings/recordings/r1_20261018-210512.mp4')
  })

  it('없으면 안내', async () => {
    vi.mocked($fetch).mockResolvedValue({ recordings: [] } as any)
    render(<MeetingsRecordingsModal room="r1" onClose={vi.fn()} />)
    await screen.findByText(t('meetings.recordings.empty'))
  })
})

describe('toggleRecording 실패', () => {
  beforeEach(() => { vi.mocked($fetch).mockReset() })

  it('서버 detail 을 오류 토스트로 보여 주고 버튼을 푼다', async () => {
    const detail = '녹화를 시작하지 못했습니다. 녹화 서버가 꺼져 있거나 자원이 부족합니다'
    vi.mocked($fetch).mockRejectedValue(Object.assign(new Error('x'), { data: { detail } }))
    act(() => { meetingsStore.setState({ currentRoomName: 'r1', recording: false, recordingBusy: false }) })
    await act(async () => { await toggleRecording() })
    expect(toastStore.getState().toasts.some(x => x.type === 'error' && x.message === detail)).toBe(true)
    expect(meetingsStore.getState().recordingBusy).toBe(false)
    expect(meetingsStore.getState().recording).toBe(false)
  })
})

describe('MeetingsControls', () => {
  it('호스트만 녹화, 대기 n·안 읽은 채팅 배지, 사이드바 토글', () => {
    act(() => { meetingsStore.setState({ pendingRequests: [{ id: '1', nickname: 'n', created_at: 0 }], unreadChat: 120 }) })
    const onToggleSidebar = vi.fn()
    const { rerender } = render(<MeetingsControls cameraEnabled micEnabled screenShareEnabled={false} onToggleSidebar={onToggleSidebar} />)
    expect(screen.queryByTitle(t('meetings.controls.recStart'))).toBeNull()
    expect(screen.getByText('99+')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    fireEvent.click(screen.getByTitle(t('meetings.controls.chat')))
    expect(onToggleSidebar).toHaveBeenCalledWith('chat')
    rerender(<MeetingsControls cameraEnabled micEnabled screenShareEnabled={false} isHost sidebarOpen sidebarTab="chat" />)
    expect(screen.getByTitle(t('meetings.controls.recStart'))).toBeTruthy()
    expect(screen.queryByText('99+')).toBeNull()
    act(() => { meetingsStore.setState({ pendingRequests: [], unreadChat: 0 }) })
  })

  it('가상 배경이 켜져 있으면 누를 때 해제(null)', () => {
    const onSetBackground = vi.fn()
    render(<MeetingsControls cameraEnabled micEnabled screenShareEnabled={false} vbgEnabled onSetBackground={onSetBackground} />)
    fireEvent.click(screen.getByTitle(t('meetings.controls.vbg')))
    expect(onSetBackground).toHaveBeenCalledWith(null)
  })

  it('노이즈 제거 미지원이면 비활성 + 안내 툴팁', () => {
    render(<MeetingsControls cameraEnabled micEnabled screenShareEnabled={false} noiseSupported={false} />)
    const b = screen.getByTitle(t('meetings.controls.noiseUnsupported')) as HTMLButtonElement
    expect(b.disabled).toBe(true)
  })
})

describe('MeetingsSidebar', () => {
  it('대기실: 호스트가 아니면 안내, 채팅 탭으로 바꾸면 읽음 처리', () => {
    act(() => { meetingsStore.setState({ isHost: false, unreadChat: 3, pendingRequests: [], participants: [] }) })
    let tab: 'participants' | 'waitingRoom' | 'chat' = 'waitingRoom'
    const { rerender } = render(<MeetingsSidebar activeTab={tab} onUpdateActiveTab={(v) => { tab = v }} />)
    expect(screen.getByText(t('meetings.sidebar.hostOnly'))).toBeTruthy()
    fireEvent.click(screen.getByText(t('meetings.sidebar.chat')))
    expect(tab).toBe('chat')
    rerender(<MeetingsSidebar activeTab={tab} />)
    expect(meetingsStore.getState().unreadChat).toBe(0)
    expect(screen.getByText(t('meetings.sidebar.noMessages'))).toBeTruthy()
  })
})

describe('MeetingsResultScreen', () => {
  it('제목·설명·버튼, 머리 기본 "회의"', () => {
    render(<MeetingsResultScreen title="끝" description="설명" tone="muted"><button>목록</button></MeetingsResultScreen>)
    expect(screen.getByText('끝')).toBeTruthy()
    expect(screen.getByText('설명')).toBeTruthy()
    expect(screen.getByText(t('meetings.join.resultHeader'))).toBeTruthy()
    expect(screen.getByRole('button', { name: '목록' })).toBeTruthy()
  })
})

describe('deleteRoom', () => {
  beforeEach(() => { vi.mocked($fetch).mockReset(); vi.mocked($fetch).mockResolvedValue({ rooms: [] } as any) })
  it('지난 회의 행은 meeting_id 로 그 행만 지운다', async () => {
    await deleteRoom('r1', 'm9')
    expect(vi.mocked($fetch).mock.calls[0]).toEqual(['/api/meetings/rooms/r1', expect.objectContaining({ method: 'DELETE', query: { meeting_id: 'm9' } })])
  })
})
