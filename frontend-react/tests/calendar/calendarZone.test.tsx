// 캘린더 화면이 설정 시간대로 렌더링되는지 검증 — 주 보기 칸 위치(서머타임 날 포함)·현재 시각 선·월 보기 종일·
// 일정 폼(편집·새 일정·저장 값)·이동·대시보드 "오늘". 기기 시간대와 무관하게 _setCalendarZone 으로 고정.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  events: [] as any[],
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => {
    api.calls.push({ url, opts })
    if (url === '/api/calendar/calendars') return { calendars: [{ id: 'c1', name: '내 일정', color: null, is_visible: true, sort_order: 0, can_write: true }] }
    if (url === '/api/calendar/events' && !opts.method) return { events: api.events }
    return { ok: true }
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { calendarStore, navigateNext, eventsOnDayOf } = await import('~/composables/useCalendar')
const { CalendarWeekView } = await import('~/components/calendar/CalendarWeekView')
const { CalendarMonthView } = await import('~/components/calendar/CalendarMonthView')
const { CalendarEventModal } = await import('~/components/calendar/CalendarEventModal')
const { DashboardToday } = await import('~/components/dashboard/DashboardToday')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')
const { _setCalendarZone, zDate } = await import('~/utils/calTz')
const { i18n } = await import('~/i18n')
const t = (k: string, a?: any) => i18n.t(k, a)

const LA = 'America/Los_Angeles'
const SEOUL = 'Asia/Seoul'
const initial = calendarStore.getState()

const ev = (id: string, start: string, end: string, o: Record<string, unknown> = {}) => ({
  id, calendar_id: 'c1', title: id, description: null, location: null, start, end, all_day: false, color: '#2c6ddd', status: null,
  reminder_minutes: null, recurrence_rule: null, is_recurring: false, is_occurrence: false, original_event_id: null,
  created: null, updated: null, ...o,
})
const cals = [{ id: 'c1', name: '내 일정', color: '#2c6ddd', is_visible: true, sort_order: 0, can_write: true }]

beforeEach(() => {
  api.calls = []
  api.events = []
  isMobileStore.setState({ isMobile: false })
  setUser({ id: 'u1', username: 'me', display_name: 'Me', email: 'me@x.test' } as any)
})
afterEach(() => {
  _setCalendarZone(null)
  vi.useRealTimers()
  calendarStore.setState({ ...initial }, true)
})

describe('주·일 보기', () => {
  it('LA 서머타임 시작일: 03:00–04:00 일정은 03:00 줄(위 145px), 01:00 은 01:00 줄', () => {
    _setCalendarZone(LA)
    calendarStore.setState({
      ...initial, calendars: cals as any, selectedDate: zDate(2026, 2, 8, 12),
      events: [
        ev('새벽', '2026-03-08T09:00:00Z', '2026-03-08T10:30:00Z'),   // 01:00 PST – 03:30 PDT
        ev('세시', '2026-03-08T10:00:00Z', '2026-03-08T11:00:00Z'),   // 03:00 – 04:00 PDT
      ] as any,
    }, true)
    renderInRouter(<CalendarWeekView days={1} />)
    const three = screen.getByTitle(/^세시 · /)
    expect(three.title).toBe('세시 · 03:00–04:00')
    expect(three.style.top).toBe(`${3 * 48 + 1}px`)
    expect(three.style.height).toBe(`${48 - 3}px`)
    const early = screen.getByTitle(/^새벽 · /)
    expect(early.title).toBe('새벽 · 01:00–03:30')
    expect(early.style.top).toBe(`${48 + 1}px`)
    // 벽시계 기준 01:00 → 03:30 = 2.5칸(경과 1.5시간이 아님)
    expect(early.style.height).toBe(`${2.5 * 48 - 3}px`)
  })

  it('같은 일정이 서울에서는 다음날 칸 — 요일 머리도 캘린더 시간대', () => {
    _setCalendarZone(SEOUL)
    calendarStore.setState({
      ...initial, calendars: cals as any, selectedDate: zDate(2026, 9, 17, 12),
      events: [ev('회의', '2026-10-16T16:00:00Z', '2026-10-16T17:00:00Z')] as any,  // 서울 10/17 01:00
    }, true)
    renderInRouter(<CalendarWeekView days={1} />)
    expect(screen.getByTitle(/^회의 · /).title).toBe('회의 · 01:00–02:00')
  })

  it('현재 시각 선 = 캘린더 시간대 벽시계(기기 시간대 아님)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T16:30:00Z'))   // LA 09:30 · 서울 10/18 01:30
    _setCalendarZone(LA)
    calendarStore.setState({ ...initial, calendars: cals as any, selectedDate: new Date(), events: [] }, true)
    const { container } = renderInRouter(<CalendarWeekView days={1} />)
    const line = container.querySelector('.bg-danger.h-0\\.5') as HTMLElement
    expect(line).toBeTruthy()
    expect(line.style.top).toBe(`${9.5 * 48}px`)
    expect(container.textContent).toContain('09:30')
    expect(container.textContent).toContain('GMT-7')
  })
})

describe('월 보기 · 종일', () => {
  it('UTC 00:00 공휴일은 서울에서도 LA 에서도 그 하루 칸에만', () => {
    const holiday = ev('한글날', '2026-10-09T00:00:00+00:00', '2026-10-10T00:00:00+00:00', { all_day: true })
    for (const tz of [SEOUL, LA]) {
      _setCalendarZone(tz)
      const on = (d: number) => eventsOnDayOf([holiday] as any, zDate(2026, 9, d, 12)).length
      expect([on(8), on(9), on(10)]).toEqual([0, 1, 0])
    }
    _setCalendarZone(LA)
    calendarStore.setState({ ...initial, calendars: cals as any, selectedDate: zDate(2026, 9, 15, 12), events: [holiday] as any }, true)
    const { unmount } = renderInRouter(<CalendarMonthView />)
    expect(screen.getAllByTitle('한글날')).toHaveLength(1)
    unmount()
  })

  it('달 이동도 캘린더 시간대의 달(같은 순간 = 서울 10/01 01:00 · LA 09/30 09:00)', () => {
    const at = new Date('2026-09-30T16:00:00Z')
    _setCalendarZone(LA)
    calendarStore.setState({ ...initial, viewMode: 'month', selectedDate: at }, true)
    navigateNext()
    expect(calendarStore.getState().selectedDate.toISOString()).toBe('2026-10-30T16:00:00.000Z')   // LA 10/30 09:00
    _setCalendarZone(SEOUL)
    calendarStore.setState({ selectedDate: at })
    navigateNext()
    expect(calendarStore.getState().selectedDate.toISOString()).toBe('2026-10-31T16:00:00.000Z')   // 서울 11/01 01:00
  })
})

describe('일정 폼', () => {
  async function openModal(state: Record<string, unknown>) {
    calendarStore.setState({ ...initial, calendars: cals as any, ...state }, true)
    renderInRouter(<CalendarEventModal />)
    await act(async () => { calendarStore.setState({ showEventModal: true }) })
  }

  it('편집: 시각 일정은 캘린더 시간대 벽시계, 종일은 날짜 그대로', async () => {
    _setCalendarZone(LA)
    await openModal({ editingEvent: ev('여름 회의', '2026-07-01T16:00:00Z', '2026-07-01T17:00:00Z') })
    expect((screen.getByLabelText(t('calendar.event.startLabel')) as HTMLInputElement).value).toBe('2026-07-01')
    expect((screen.getByLabelText(t('calendar.form.startTime')) as HTMLInputElement).value).toBe('09:00')
  })

  it('편집: 종일(UTC 00:00)은 LA 에서도 그 날짜', async () => {
    _setCalendarZone(LA)
    await openModal({ editingEvent: ev('휴가', '2026-10-09T00:00:00Z', '2026-10-12T00:00:00Z', { all_day: true }) })
    expect((screen.getByLabelText(t('calendar.event.startLabel')) as HTMLInputElement).value).toBe('2026-10-09')
    expect((screen.getByLabelText(t('calendar.event.endLabel')) as HTMLInputElement).value).toBe('2026-10-11')
  })

  it('새 일정: 고른 날 00:00 이면 캘린더 시간대 09:00, 저장은 그 순간 · 종일은 UTC 00:00', async () => {
    _setCalendarZone(SEOUL)
    await openModal({ selectedDate: zDate(2026, 9, 17), editingEvent: null })
    expect((screen.getByLabelText(t('calendar.event.startLabel')) as HTMLInputElement).value).toBe('2026-10-17')
    expect((screen.getByLabelText(t('calendar.form.startTime')) as HTMLInputElement).value).toBe('09:00')
    fireEvent.change(screen.getByLabelText(t('calendar.event.titleLabel')), { target: { value: '점심' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.save') })) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/calendar/events' && c.opts.method === 'POST')).toBe(true))
    const body = api.calls.find(c => c.url === '/api/calendar/events' && c.opts.method === 'POST')!.opts.body
    expect(body.start).toBe('2026-10-17T00:00:00.000Z')   // 서울 09:00
    expect(body.end).toBe('2026-10-17T01:00:00.000Z')
    expect(body.timezone).toBe(SEOUL)
  })

  it('다른 날짜 일정을 연달아 열어도 끝 날짜가 밀리지 않는다(직전 일정과의 날짜 차이 회귀)', async () => {
    _setCalendarZone(SEOUL)
    await openModal({ editingEvent: ev('20일', '2026-10-20T01:00:00Z', '2026-10-20T02:00:00Z') })
    await act(async () => { calendarStore.setState({ showEventModal: false }) })
    await act(async () => { calendarStore.setState({ editingEvent: ev('25일', '2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z') as any, showEventModal: true }) })
    expect((screen.getByLabelText(t('calendar.event.startLabel')) as HTMLInputElement).value).toBe('2026-10-25')
    expect(screen.queryByLabelText(t('calendar.event.endLabel'))).toBeNull()   // 같은 날 = 끝 날짜 칸 없음
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.save') })) })
    await waitFor(() => expect(api.calls.some(c => c.opts?.method === 'PATCH' || c.opts?.method === 'PUT')).toBe(true))
    const body = api.calls.find(c => c.opts?.method === 'PATCH' || c.opts?.method === 'PUT')!.opts.body
    expect(body.end).toBe('2026-10-25T02:00:00.000Z')
  })

  it('사용자가 시작 날짜를 바꾸면 끝 날짜도 같은 만큼 민다', async () => {
    _setCalendarZone(SEOUL)
    await openModal({ editingEvent: ev('이틀', '2026-10-20T01:00:00Z', '2026-10-21T02:00:00Z') })
    fireEvent.change(screen.getByLabelText(t('calendar.event.startLabel')), { target: { value: '2026-10-22' } })
    expect((screen.getByLabelText(t('calendar.event.endLabel')) as HTMLInputElement).value).toBe('2026-10-23')
  })

  it('새 일정: 고른 시각에 분이 남아 있으면(21:06) 다음 30분(21:30)으로', async () => {
    _setCalendarZone(SEOUL)
    await openModal({ selectedDate: zDate(2026, 9, 17, 21, 6), editingEvent: null })
    expect((screen.getByLabelText(t('calendar.form.startTime')) as HTMLInputElement).value).toBe('21:30')
    expect((screen.getByLabelText(t('calendar.form.endTime')) as HTMLInputElement).value).toBe('22:30')
  })

  it('새 종일 일정 저장 = 날짜의 UTC 00:00 ~ 다음날(시간대 변환 없음)', async () => {
    _setCalendarZone(LA)
    await openModal({ selectedDate: zDate(2026, 9, 17), editingEvent: null })
    fireEvent.change(screen.getByLabelText(t('calendar.event.titleLabel')), { target: { value: '워크숍' } })
    fireEvent.click(screen.getByRole('switch', { name: t('calendar.allDay') }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.save') })) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/calendar/events' && c.opts.method === 'POST')).toBe(true))
    const body = api.calls.find(c => c.url === '/api/calendar/events' && c.opts.method === 'POST')!.opts.body
    expect(body).toMatchObject({ all_day: true, start: '2026-10-17T00:00:00.000Z', end: '2026-10-18T00:00:00.000Z' })
  })
})

describe('대시보드 "오늘"', () => {
  it('캘린더 시간대의 오늘 범위로 받고 시각도 그 기준', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T16:30:00Z'))   // LA 10/17 09:30
    _setCalendarZone(LA)
    api.events = [
      ev('스탠드업', '2026-10-17T17:00:00Z', '2026-10-17T17:15:00Z'),                         // LA 10:00
      ev('어제', '2026-10-17T05:00:00Z', '2026-10-17T06:00:00Z'),                            // LA 10/16 22:00
      ev('공휴일', '2026-10-17T00:00:00Z', '2026-10-18T00:00:00Z', { all_day: true }),        // 10/17 종일
      ev('내일 종일', '2026-10-18T00:00:00Z', '2026-10-19T00:00:00Z', { all_day: true }),
    ]
    renderInRouter(<DashboardToday />)
    await screen.findByText('스탠드업')
    expect(screen.getByText('10:00')).toBeTruthy()
    expect(screen.getByText('공휴일')).toBeTruthy()
    expect(screen.queryByText('어제')).toBeNull()
    expect(screen.queryByText('내일 종일')).toBeNull()
    const q = api.calls.find(c => c.url === '/api/calendar/events')!.opts.params
    expect(q.start).toBe('2026-10-16T07:00:00.000Z')   // 오늘 00:00 PDT 에서 하루 앞
    expect(q.end).toBe('2026-10-19T07:00:00.000Z')
  })
})

describe('일정 폼 시간대 고르기', () => {
  async function openMore() {
    calendarStore.setState({ ...initial, calendars: cals as any, editingEvent: ev('회의', '2026-07-01T16:00:00Z', '2026-07-01T17:00:00Z') }, true)
    renderInRouter(<CalendarEventModal />)
    await act(async () => { calendarStore.setState({ showEventModal: true }) })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('calendar.form.more')) }))
  }
  it('데스크톱: 설정과 같은 찾기 칸 — 한글 도시명으로 찾는다', async () => {
    _setCalendarZone(SEOUL)
    await openMore()
    fireEvent.click(screen.getByRole('combobox', { name: t('calendar.form.timezone') }))
    const box = screen.getByRole('searchbox') as HTMLInputElement
    expect(box.placeholder).toBe(t('common.tzSearch'))
    fireEvent.change(box, { target: { value: '뉴욕' } })
    const names = screen.getAllByRole('option').map(o => o.textContent || '')
    expect(names.length).toBeGreaterThan(0)
    expect(names.every(n => n.startsWith('America/New York'))).toBe(true)
  })
  it('모바일: OS 선택기(찾기 칸 없음)', async () => {
    isMobileStore.setState({ isMobile: true })
    _setCalendarZone(SEOUL)
    await openMore()
    const sel = screen.getByLabelText(t('calendar.form.timezone'))
    expect(sel.tagName).toBe('SELECT')
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
})
