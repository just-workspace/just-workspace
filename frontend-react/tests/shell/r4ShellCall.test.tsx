// 셸·통화: 상태 메시지 펼침 패널 · 미니 통화 창 · 500 서비스 상태·오피스 미리보기 · 회의 결과 요약
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act, render } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({
  handler: (_url: string, _opts?: any): any => ({}),
  calls: [] as Array<{ url: string; opts?: any }>,
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { i18n } = await import('~/i18n')
const { statusClearAt, statusClearFrom, dndLeft, dndSegmentValue } = await import('~/utils/myStatus')
const { miniCallTone, newLobbyIds, isMinimizeShortcut, miniCallLeaveSummary } = await import('~/utils/miniCall')
const { mergeSeenPeople } = await import('~/composables/useMeetingSessionStats')
const { serviceRows, serviceMsText } = await import('~/components/auth/ServerErrorScreen')
const { LayoutUserMenu } = await import('~/components/layout/UserMenu')
const { LayoutMiniCall } = await import('~/components/layout/MiniCall')
const { MeetingsEndSummary } = await import('~/components/meetings/MeetingsEndSummary')
const { chatStore } = await import('~/composables/useChat')
const { platformStore } = await import('~/composables/usePlatform')
const { meetingsStore } = await import('~/composables/useMeetings')
const { meetingCallStore } = await import('~/composables/useMeetingCall')
const { setUser } = await import('~/composables/useAuth')
const { toastStore } = await import('~/composables/useToast')

const t = (k: string, a?: Record<string, unknown>) => i18n.t(k, a)

beforeEach(() => {
  api.calls = []
  api.handler = () => ({})
})

describe('상태 메시지 값', () => {
  const now = new Date(2026, 9, 17, 14, 0, 0).getTime()
  it('지우기 선택 → 지울 시각', () => {
    expect(statusClearAt('never', '', now)).toBeNull()
    expect(statusClearAt('30m', '', now)!.getTime()).toBe(now + 30 * 60_000)
    expect(statusClearAt('1h', '', now)!.getTime()).toBe(now + 60 * 60_000)
    const today = statusClearAt('today', '', now)!
    expect([today.getDate(), today.getHours(), today.getMinutes()]).toEqual([17, 23, 59])
    const later = statusClearAt('time', '15:00', now)!
    expect([later.getDate(), later.getHours()]).toEqual([17, 15])
    // 이미 경과한 시각이면 내일
    expect(statusClearAt('time', '09:30', now)!.getDate()).toBe(18)
    expect(statusClearAt('time', '25:00', now)).toBeNull()
  })
  it('처음 값 · 방해 금지 남은 시간 · 세그먼트', () => {
    expect(statusClearFrom(null)).toEqual({ choice: 'never', time: '' })
    expect(statusClearFrom(new Date(2026, 9, 17, 15, 0))).toEqual({ choice: 'time', time: '15:00' })
    expect(dndLeft(new Date(now + 60 * 60_000), now)).toEqual({ n: 1, unit: 'h' })
    expect(dndLeft(new Date(now + 20 * 60_000), now)).toEqual({ n: 20, unit: 'm' })
    expect(dndLeft(null, now)).toBeNull()
    expect(dndSegmentValue(false, null, now)).toBe(0)
    expect(dndSegmentValue(true, null, now)).toBeNull()
    expect(dndSegmentValue(true, new Date(now + 55 * 60_000), now)).toBe(60)
    expect(dndSegmentValue(true, new Date(now + 25 * 60_000), now)).toBe(30)
    expect(dndSegmentValue(true, new Date(now + 200 * 60_000), now)).toBe(240)
  })
})

describe('사용자 메뉴 상태 메시지 패널', () => {
  beforeEach(() => {
    setUser({ id: 'u1', username: 'hanul', display_name: '정하늘', email: 'h@x', primary_email: 'h@x', avatar_url: null, is_admin: false } as any)
    platformStore.setState({ modules: [{ id: 'chat', enabled: true }] as any })
    chatStore.setState({ myStatus: { mode: 'auto', custom_text: '집중 작업 중', custom_emoji: '🎧', custom_expires_at: null, dnd_until: null, state: 'online' } as any })
  })

  it('줄을 누르면 왼쪽 패널(문구·글자 수·칩·지우기·방해 금지), 저장하면 문구·이모지·만료를 한 번에 보낸다', async () => {
    api.handler = (url, opts) => (url === '/api/chat/me/status' && opts?.method === 'PUT' ? { mode: 'auto', state: 'online', ...opts.body } : {})
    const docClick = vi.fn()
    document.addEventListener('click', docClick)
    renderInRouter(<LayoutUserMenu />)
    const row = screen.getByRole('menuitem', { name: /집중 작업 중/ })
    fireEvent.click(row)
    const panel = await screen.findByRole('menu', { name: t('shell.userMenu.statusTitle') })
    const input = panel.querySelector('input[aria-label]') as HTMLInputElement
    expect(input.value).toBe('집중 작업 중')
    expect(panel.textContent).toContain('7 / 60')
    expect(panel.textContent).toContain(t('shell.userMenu.presetSick'))
    expect(panel.textContent).toContain(t('shell.userMenu.dndSchedule'))
    expect(panel.textContent).toContain(t('shell.userMenu.appearOffline'))
    // 패널 내부 클릭은 문서까지 전파되지 않음(상단바 바깥 클릭 처리로 사용자 메뉴가 닫히지 않도록)
    docClick.mockClear()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('shell.userMenu.presetMeeting')) }))
    expect(docClick).not.toHaveBeenCalled()
    expect(input.value).toBe(t('shell.userMenu.presetMeeting'))
    // 지우기: 1시간 뒤(네이티브 선택)
    fireEvent.change(panel.querySelector('select')!, { target: { value: '1h' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))
    await waitFor(() => expect(api.calls.some(c => c.opts?.method === 'PUT')).toBe(true))
    const body = api.calls.find(c => c.opts?.method === 'PUT')!.opts.body
    expect(body.custom_text).toBe(t('shell.userMenu.presetMeeting'))
    expect(body.custom_emoji).toBe('🗓')
    expect(Date.parse(body.custom_expires_at) - Date.now()).toBeGreaterThan(55 * 60_000)
    document.removeEventListener('click', docClick)
  })

  it('방해 금지 중이면 줄 둘째 줄에 "방해 금지 n시간"', () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString()
    chatStore.setState({ myStatus: { mode: 'dnd', custom_text: '집중', custom_emoji: null, custom_expires_at: until, dnd_until: until, state: 'dnd' } as any })
    renderInRouter(<LayoutUserMenu />)
    const row = screen.getByRole('menuitem', { name: /집중/ })
    expect(row.textContent).toContain(t('shell.userMenu.until'))
    expect(row.textContent).toContain(`${t('ui.status.dnd')} 1${t('shell.userMenu.unitHour')}`)
  })
})

describe('미니 통화 창 값', () => {
  it('연결 상태 · 새 대기 신청 · 단축키 · 나간 뒤 요약', () => {
    expect(miniCallTone('connected')).toBe('live')
    expect(miniCallTone('reconnecting')).toBe('reconnecting')
    expect(miniCallTone('rejoining')).toBe('reconnecting')
    expect(miniCallTone('disconnected')).toBe('lost')
    expect(newLobbyIds(new Set(['a']), [{ id: 'a' }, { id: 'b' }])).toEqual(['b'])
    expect(isMinimizeShortcut({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code: 'KeyM', key: 'µ' })).toBe(true)
    expect(isMinimizeShortcut({ altKey: true, ctrlKey: true, metaKey: false, shiftKey: false, code: 'KeyM' })).toBe(false)
    expect(isMinimizeShortcut({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, code: 'KeyM' })).toBe(false)
    expect(miniCallLeaveSummary(3, 12)).toEqual({ ended: false, minutes: 12, others: 3 })
    expect(miniCallLeaveSummary(0, 12).ended).toBe(true)
  })
  it('본 사람 합치기 — 손님 표시, 이름 갱신, 바뀐 게 없으면 같은 배열', () => {
    const a = mergeSeenPeople([], [{ identity: 'u1', name: '나' }, { identity: 'guest-r1', name: '최수아' }])
    expect(a).toEqual([{ id: 'u1', name: '나', guest: false }, { id: 'guest-r1', name: '최수아', guest: true }])
    expect(mergeSeenPeople(a, [{ identity: 'u1', name: '나' }])).toBe(a)
    expect(mergeSeenPeople(a, [{ identity: 'u1', name: '정하늘' }])[0].name).toBe('정하늘')
  })
})

function p(identity: string, name: string, o: Record<string, unknown> = {}) {
  return { identity, name, videoTrack: null, audioTrack: null, screenTrack: null, isMuted: false, isLocal: false, isSpeaking: false, connectionQuality: 'good', ...o }
}

describe('미니 통화 창', () => {
  beforeEach(() => {
    toastStore.setState({ toasts: [] })
    meetingCallStore.setState({ returnPath: '/meetings/room/r1', corner: 'br', lastSpeaker: null, roomPanel: null })
    meetingsStore.setState({
      inCall: true, connected: true, connectionState: 'connected', currentRoomName: 'r1', isHost: false, currentRoom: null,
      callStartedAt: Date.now() - 60_000, participants: [p('me', '나', { isLocal: true }), p('u2', '김서연')] as any,
      pendingRequests: [], micEnabled: true, cameraEnabled: false, screenShareEnabled: false, chatMessages: [],
    })
  })

  it('알약: 이름 + 경과 / 인원, 나가면 "아직 n명" 토스트에 [다시 참여]', async () => {
    renderInRouter(<LayoutMiniCall mobile={false} />, '/mail')
    const region = screen.getByRole('region')
    expect(region.textContent).toContain('r1')
    expect(region.textContent).toContain(t('meetings.mini.people', { n: 2 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('meetings.controls.leave') })) })
    const toast = toastStore.getState().toasts[0]
    expect(toast.message).toBe(t('meetings.mini.leftTitle', { name: 'r1' }))
    expect(toast.description).toContain('1')
    expect(toast.action?.label).toBe(t('meetings.rejoin'))
  })

  it('마지막 사람이면 "통화가 종료되었습니다", 행동 없음', async () => {
    meetingsStore.setState({ participants: [p('me', '나', { isLocal: true })] as any })
    renderInRouter(<LayoutMiniCall mobile={false} />, '/mail')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('meetings.controls.leave') })) })
    const toast = toastStore.getState().toasts[0]
    expect(toast.action).toBeUndefined()
  })

  it('재연결 = role=status, 끊김 = role=alert + [다시 참여]·닫기', () => {
    meetingsStore.setState({ connectionState: 'reconnecting' })
    const r = renderInRouter(<LayoutMiniCall mobile={false} />, '/mail')
    expect(screen.getByRole('status').textContent).toContain(t('meetings.mini.reconnecting'))
    r.unmount()
    meetingsStore.setState({ connectionState: 'disconnected' })
    renderInRouter(<LayoutMiniCall mobile={false} />, '/mail')
    expect(screen.getByRole('alert').textContent).toContain(t('meetings.mini.lost'))
    expect(screen.getByRole('button', { name: t('meetings.rejoin') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('common.close') })).toBeTruthy()
  })

  it('호스트: 대기실 요청 띠(+n · 들이기 · 거절) — 미니 창에서도 신청을 받아 온다', async () => {
    const list = [{ id: 'q1', nickname: '최수아', created_at: 0 }, { id: 'q2', nickname: '도윤', created_at: 1 }]
    api.handler = (url) => (url.endsWith('/requests') ? list : {})
    meetingsStore.setState({ isHost: true })
    renderInRouter(<LayoutMiniCall mobile={false} />, '/mail')
    const band = await screen.findByRole('alert')
    expect(band.textContent).toContain('최수아')
    expect(band.textContent).toContain('+1')
    expect(api.calls.some(c => c.url === '/api/meetings/rooms/r1/requests')).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('meetings.mini.lobbyAdmit') })) })
    expect(api.calls.some(c => c.url === '/api/meetings/rooms/r1/requests/q1/approve')).toBe(true)
  })

  it('영상 + 화면 공유 중 = 공유 버튼 채움·aria-pressed, 영상 위 "내 화면을 공유하는 중"', () => {
    meetingsStore.setState({ screenShareEnabled: true, participants: [p('me', '나', { isLocal: true, screenTrack: { attach() {}, detach() {} } })] as any })
    renderInRouter(<LayoutMiniCall mobile={false} />, '/mail')
    const share = screen.getByRole('button', { name: t('meetings.mini.screenStop') })
    expect(share.getAttribute('aria-pressed')).toBe('true')
    expect(share.className).toContain('bg-primary')
    expect(screen.getByRole('region').textContent).toContain(t('meetings.mini.sharingMine'))
  })
})

describe('회의 결과 요약', () => {
  const people = [{ id: 'u1', name: '박민지', guest: false }, { id: 'guest-1', name: '최수아', guest: true }]
  it('로그인 사용자: 호스트·참가(손님 n)·채팅 + 버튼', () => {
    const chat = vi.fn()
    render(<MeetingsEndSummary hostName="박민지" participants={2} people={people} chats={14} onOpenChat={chat} />)
    expect(screen.getByText(t('meetings.summary.title'))).toBeTruthy()
    const text = document.body.textContent!
    expect(text).toContain('박민지')
    expect(text).toContain(t('meetings.summary.chat'))
    expect(text.replace(/\s+/g, '')).toContain(t('meetings.summary.guestsVal', { num: 1 }).replace(/\s+/g, ''))
    fireEvent.click(screen.getByRole('button', { name: t('meetings.summary.openChat') }))
    expect(chat).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: t('meetings.summary.calendar') })).toBeNull()
  })
  it('손님: 참가·시각만, 버튼 없음', () => {
    render(<MeetingsEndSummary guest hostName="박민지" participants={2} people={people} chats={14} timeRange="15:00–15:58" onOpenChat={() => {}} />)
    const text = document.body.textContent!
    expect(text).toContain('15:00–15:58')
    expect(text).not.toContain(t('meetings.summary.host'))
    expect(text).not.toContain(t('meetings.summary.chat'))
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('500 서비스 상태', () => {
  it('웹·API 는 이 요청으로 재고, 실패면 웹·API 중단 한 줄', () => {
    const rows = serviceRows({ checked_at: null, services: [{ key: 'auth', status: 'ok', response_ms: 38 }, { key: 'git', status: 'off', response_ms: 12 }] }, 1200)
    expect(rows.map(r => [r.key, r.status, r.ms])).toEqual([['web', 'slow', 1200], ['auth', 'ok', 38], ['git', 'off', null]])
    expect(serviceRows(null, null)).toEqual([{ key: 'web', status: 'down', ms: null }])
    expect(serviceMsText(38)).toBe('38 ms')
    expect(serviceMsText(1200)).toBe('1.2 s')
    expect(serviceMsText(null)).toBe('—')
  })
  it('펼치면 공개 상태를 받아 행 40(이름·상태·응답 시간)', async () => {
    api.handler = (url) => (url === '/api/services/public-status'
      ? { checked_at: '2026-10-17T01:42:08Z', services: [{ key: 'chat', status: 'slow', response_ms: 1200 }] }
      : {})
    const { AuthServerErrorScreen } = await import('~/components/auth/ServerErrorScreen')
    renderInRouter(<AuthServerErrorScreen error={{ statusCode: 500 }} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('error.500.status')) }))
    const card = await screen.findByRole('status')
    await waitFor(() => expect(card.textContent).toContain(t('error.500.svc.chat')))
    expect(card.textContent).toContain(t('ui.status.slow'))
    expect(card.textContent).toContain('1.2 s')
    expect(card.textContent).toContain(t('error.500.svc.web'))
    expect(api.calls.some(c => c.url === '/api/services/status')).toBe(false)
  })
})

describe('오피스 글자 미리보기', () => {
  it('warning 띠 + 종이 + "[표 1개 · 이미지 2개 생략됨]"', async () => {
    api.handler = (url) => {
      if (url === '/api/wopi/open') return new Promise(() => {})
      if (url === '/api/files/preview') return { type: 'office', content: '첫 줄\n둘째 줄', omitted: { tables: 1, images: 2 } }
      return {}
    }
    const Page = (await import('~/pages/office/open')).default
    renderInRouter(<Page />, '/office/open?path=my%2Fa.docx')
    fireEvent.click(await screen.findByText(t('office.open.openPreview')))
    expect(await screen.findByText(/첫 줄/)).toBeTruthy()
    const omitted = t('office.open.omitted', { items: `${t('office.open.omitTables', { n: 1 })} · ${t('office.open.omitImages', { n: 2 })}` })
    expect(screen.getByText(omitted)).toBeTruthy()
    expect(screen.getByRole('status').className).toContain('bg-warning/10')
    expect(screen.getByText(t('office.open.previewBadge'))).toBeTruthy()
  })
})
