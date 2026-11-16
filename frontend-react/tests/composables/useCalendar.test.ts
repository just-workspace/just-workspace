// 캘린더 store — 반복 일정 범위 삭제·수정 요청 모양, 표시 일정·혼자 보기, 이동, 범주 색·빗금, 팝오버 닫힘 직후 판정
import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_url: string, _opts: any): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const cal = await import('~/composables/useCalendar')
const { calendarStore } = cal
const initial = calendarStore.getState()

const ev = (id: string, o: Partial<import('~/composables/useCalendar').CalendarEvent> = {}): import('~/composables/useCalendar').CalendarEvent => ({
  id, calendar_id: 'c1', title: id, description: null, location: null,
  start: '2026-10-15T01:00:00.000Z', end: '2026-10-15T02:00:00.000Z', all_day: false, color: null, status: null,
  reminder_minutes: null, recurrence_rule: null, is_recurring: false, is_occurrence: false, original_event_id: null,
  created: null, updated: null, ...o,
})

beforeEach(() => {
  calendarStore.setState({ ...initial, selectedDate: new Date(2026, 9, 15, 9) }, true)
  api.calls = []
  api.handler = (url) => (url === '/api/calendar/events' ? { events: [] } : { ok: true })
})

describe('deleteEventScoped — 반복 일정 범위 삭제', () => {
  it('반복 아님: 그 id 로 DELETE, 범위 없음', async () => {
    await cal.deleteEventScoped(ev('e1'), 'all')
    expect(api.calls[0]).toMatchObject({ url: '/api/calendar/events/e1', opts: { method: 'DELETE', params: {} } })
    // 삭제 후 재조회
    expect(api.calls[1].url).toBe('/api/calendar/events')
  })

  it('회차 + 이 일정만: 마스터 id + scope=this + occurrence=회차 시작', async () => {
    await cal.deleteEventScoped(ev('m1_occ', { is_occurrence: true, original_event_id: 'm1', recurrence_rule: 'FREQ=WEEKLY' }), 'this')
    expect(api.calls[0]).toMatchObject({
      url: '/api/calendar/events/m1',
      opts: { method: 'DELETE', params: { scope: 'this', occurrence: '2026-10-15T01:00:00.000Z' } },
    })
  })

  it('마스터 + 반복 전체: occurrence 없이 scope=all, 알림 켜면 notify=true 와 알린 수', async () => {
    api.handler = (url) => (url === '/api/calendar/events/m1' ? { ok: true, notified: 3 } : { events: [] })
    const n = await cal.deleteEventScoped(ev('m1', { is_recurring: true, recurrence_rule: 'FREQ=DAILY' }), 'all', { notify: true })
    expect(api.calls[0].opts.params).toEqual({ notify: 'true', scope: 'all' })
    expect(n).toBe(3)
  })

  it('회차 예외 행: 그 행 id + scope 만(서버가 원래 회차를 찾는다)', async () => {
    await cal.deleteEventScoped(ev('x1', { is_exception: true, parent_event_id: 'm1', original_event_id: 'm1' }), 'following')
    expect(api.calls[0]).toMatchObject({ url: '/api/calendar/events/x1', opts: { params: { scope: 'following' } } })
    expect(api.calls[0].opts.params.occurrence).toBeUndefined()
  })
})

describe('updateEventScoped — 반복 일정 범위 수정', () => {
  const body = { calendar_id: 'c2', title: 'T', start: '2026-10-15T03:00:00.000Z', end: '2026-10-15T04:00:00.000Z', recurrence_rule: 'FREQ=WEEKLY', recurrence_end: null }

  it('이 일정만: PATCH ?occurrence= 에 반복 규칙·캘린더 빼고 보낸다', async () => {
    await cal.updateEventScoped(ev('m1_occ', { is_occurrence: true, original_event_id: 'm1', recurrence_rule: 'FREQ=WEEKLY' }), body, 'this')
    expect(api.calls[0].url).toBe('/api/calendar/events/m1')
    expect(api.calls[0].opts.params).toEqual({ occurrence: '2026-10-15T01:00:00.000Z' })
    expect(api.calls[0].opts.body).toEqual({ title: 'T', start: body.start, end: body.end })
  })

  it('회차 + 이후 모두: 요청 하나(PATCH ?scope=following&occurrence=) — 나누기는 서버가 한다', async () => {
    await cal.updateEventScoped(ev('m1_occ', { is_occurrence: true, original_event_id: 'm1', recurrence_rule: 'FREQ=WEEKLY' }), body, 'following')
    const writes = api.calls.filter(c => c.opts?.method)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      url: '/api/calendar/events/m1',
      opts: { method: 'PATCH', params: { scope: 'following', occurrence: '2026-10-15T01:00:00.000Z' }, body },
    })
    // 저장 후 재조회
    expect(api.calls[api.calls.length - 1].url).toBe('/api/calendar/events')
  })

  it('마스터(첫 회차) + 이후 모두: 시리즈 전체 수정과 같다 — 그대로 PATCH', async () => {
    await cal.updateEventScoped(ev('m1', { is_recurring: true, recurrence_rule: 'FREQ=WEEKLY' }), body, 'following')
    expect(api.calls[0]).toMatchObject({ url: '/api/calendar/events/m1', opts: { method: 'PATCH', body } })
    expect(api.calls[0].opts.params).toBeUndefined()
  })

  it('회차 + 전체: 마스터를 받아 옮긴 만큼만 옮긴다', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/calendar/events/m1' && !opts.method) return ev('m1', { start: '2026-10-01T01:00:00.000Z', end: '2026-10-01T02:00:00.000Z' })
      return url === '/api/calendar/events' ? { events: [] } : { ok: true }
    }
    await cal.updateEventScoped(ev('m1_occ', { is_occurrence: true, original_event_id: 'm1', recurrence_rule: 'FREQ=WEEKLY' }), body, 'all')
    const patch = api.calls.find(c => c.opts.method === 'PATCH')!
    expect(patch.url).toBe('/api/calendar/events/m1')
    expect(patch.opts.body.start).toBe('2026-10-01T03:00:00.000Z')
    expect(patch.opts.body.end).toBe('2026-10-01T04:00:00.000Z')
  })
})

describe('표시·이동·색', () => {
  it('fetchCalendars: 색 없는 캘린더는 순번 범주색, 9번째부터 빗금', async () => {
    api.handler = () => ({ calendars: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, color: null, is_visible: true, sort_order: i })) })
    await cal.fetchCalendars()
    const cs = calendarStore.getState().calendars
    expect(cs[0].color).toBe(cs[8].color)
    expect(cs[0].hatched).toBe(false)
    expect(cs[8].hatched).toBe(true)
  })

  it('숨긴 캘린더 일정은 빠지고 초대받은 일정은 남는다 · 혼자 보기 토글', () => {
    calendarStore.setState({
      calendars: [{ id: 'c1', name: 'A', color: null, is_visible: true, sort_order: 0 }, { id: 'c2', name: 'B', color: null, is_visible: true, sort_order: 1 }],
      events: [ev('a', { calendar_id: 'c1' }), ev('b', { calendar_id: 'c2' }), ev('i', { calendar_id: 'zz', is_invited: true })],
    })
    cal.toggleCalendarVisibility('c2')
    expect(cal.selectVisibleEvents(calendarStore.getState()).map(e => e.id)).toEqual(['a', 'i'])
    cal.soloCalendar('c2')
    expect(calendarStore.getState().calendars.map(c => c.is_visible)).toEqual([false, true])
    cal.soloCalendar('c2')
    expect(calendarStore.getState().calendars.map(c => c.is_visible)).toEqual([true, true])
  })

  it('이동: 월 ±1달, 주·일정 목록 ±7일, 일 ±1일', () => {
    cal.setViewMode('month'); cal.navigateNext()
    expect(calendarStore.getState().selectedDate.getMonth()).toBe(10)
    cal.setViewMode('agenda'); cal.navigatePrev()
    expect(calendarStore.getState().selectedDate.getDate()).toBe(8)
    cal.setViewMode('day'); cal.navigatePrev()
    expect(calendarStore.getState().selectedDate.getDate()).toBe(7)
  })

  it('fetchEvents 실패는 오류 띠 문구로, 목록은 지우지 않는다', async () => {
    calendarStore.setState({ events: [ev('keep')] })
    api.handler = () => { throw Object.assign(new Error('boom'), { data: { detail: '서버 오류' } }) }
    await cal.fetchEvents()
    expect(calendarStore.getState().eventsError).toBe('서버 오류')
    expect(calendarStore.getState().events.map(e => e.id)).toEqual(['keep'])
  })

  it('openEditModal: 초대받은 일정·읽기 전용 캘린더는 열지 않는다', () => {
    calendarStore.setState({ calendars: [{ id: 'c1', name: 'A', color: null, is_visible: true, sort_order: 0, can_write: false }] })
    cal.openEditModal(ev('a'))
    expect(calendarStore.getState().showEventModal).toBe(false)
    cal.openEditModal(ev('b', { calendar_id: 'c1', is_invited: true }))
    expect(calendarStore.getState().showEventModal).toBe(false)
  })

  it('팝오버를 닫은 직후 400ms 동안 popoverJustClosed', () => {
    cal.openPopover(ev('a'))
    cal.closePopover()
    expect(cal.popoverJustClosed()).toBe(true)
  })
})
