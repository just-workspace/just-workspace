// 캘린더 구역 전수조사 수정 고정($fetch 는 모의(mock)):
//  - 예외 회차(이 일정만 수정한 행) 삭제는 범위를 확인한 뒤 scope=this 로 전송(기존: 확인만 받고 scope=all → 시리즈 전체 삭제)
//  - "이 일정과 이후" 수정: 요청 1건(PATCH ?scope=following) — 분할·예외 회차·EXDATE 이동은 서버가 일괄 처리
//  - 빠른 이동: 지연 도착한 이전 응답이 현재 일정을 덮어쓰지 않음
//  - 수정에서 설명·장소를 비우면 "" 로 전송. 참석자 칸 Enter 는 폼을 제출하지 않음(한글 조합 중 Enter 는 무시)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_u: string, _o: any): any => undefined,
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => {
    api.calls.push({ url, opts })
    const r = await api.handler(url, opts)
    if (r !== undefined) return r
    if (url === '/api/calendar/calendars') return { calendars: [] }
    if (url === '/api/calendar/events' && !opts.method) return { events: [] }
    if (url.startsWith('/api/contacts/workspace-users')) return { users: [], total: 0 }
    return { ok: true }
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { calendarStore, updateEventScoped, fetchEvents, rruleUntilIso } = await import('~/composables/useCalendar')
const { CalendarEventModal } = await import('~/components/calendar/CalendarEventModal')
const { CalendarEventPopover } = await import('~/components/calendar/CalendarEventPopover')
const { setUser } = await import('~/composables/useAuth')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { _setCalendarZone } = await import('~/utils/calTz')
const { i18n } = await import('~/i18n')
const t = (k: string, a?: any) => i18n.t(k, a)
const initial = calendarStore.getState()
const cals = [{ id: 'c1', name: '내 일정', color: '#2c6ddd', is_visible: true, sort_order: 0, can_write: true }]
const ev = (id: string, start: string, end: string, o: Record<string, unknown> = {}): any => ({
  id, calendar_id: 'c1', title: id, description: null, location: null, start, end, all_day: false, color: '#2c6ddd', status: null,
  reminder_minutes: null, recurrence_rule: null, is_recurring: false, is_occurrence: false, original_event_id: null,
  created: null, updated: null, timezone: 'Asia/Seoul', ...o,
})

beforeEach(() => {
  api.calls = []
  api.handler = () => undefined
  isMobileStore.setState({ isMobile: false })
  setUser({ id: 'u1', username: 'me', display_name: 'Me', email: 'me@x.test' } as any)
  _setCalendarZone('Asia/Seoul')
})
afterEach(() => {
  _setCalendarZone(null)
  calendarStore.setState({ ...initial }, true)
})

describe('예외 회차 삭제', () => {
  it('팝오버: 범위 확인(이 일정만 기본)을 거쳐 DELETE scope=this — 시리즈 전체(scope=all)로 가지 않는다', async () => {
    const ex = ev('ex1', '2026-10-16T06:00:00Z', '2026-10-16T07:00:00Z', {
      title: '옮긴 회차', parent_event_id: 'm1', recurrence_id: '2026-10-15T06:00:00Z', is_exception: true,
    })
    calendarStore.setState({ ...initial, calendars: cals as any, events: [ex], popoverEvent: ex, popoverAnchor: null }, true)
    renderInRouter(<CalendarEventPopover />)
    const dlg = await screen.findByRole('dialog', { name: '옮긴 회차' })
    fireEvent.click(dlg.querySelector(`button[aria-label="${t('common.delete')}"]`)!)
    const alert = await screen.findByRole('alertdialog')
    expect(alert.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toContain(t('calendar.scope.this'))
    // 범위 대화 상자가 표시된 동안 팝오버(z-overlay)는 숨김 처리됨
    expect(dlg.className).toContain('z-overlay')
    expect(dlg.className).toContain('invisible')
    const del = [...alert.querySelectorAll('button')].find(b => b.textContent === t('common.delete'))!
    await act(async () => { fireEvent.click(del) })
    await waitFor(() => expect(api.calls.some(c => c.opts.method === 'DELETE')).toBe(true))
    const call = api.calls.find(c => c.opts.method === 'DELETE')!
    expect(call.url).toBe('/api/calendar/events/ex1')
    expect(call.opts.params).toEqual({ scope: 'this' })
  })
})

describe('"이 일정과 이후" 수정', () => {
  const rule = 'FREQ=WEEKLY;UNTIL=20261231T145959Z'
  const occ = () => ev('m_20261015T060000', '2026-10-15T06:00:00Z', '2026-10-15T07:00:00Z', {
    recurrence_rule: rule, is_occurrence: true, original_event_id: 'm',
  })
  const data = { calendar_id: 'c1', title: '새 제목', start: '2026-10-15T07:00:00Z', end: '2026-10-15T08:00:00Z', recurrence_rule: rule }

  // 분할(절단·새 시리즈·예외 회차·EXDATE 이동)은 서버가 단일 트랜잭션으로 수행한다(backend/tests/calsplit_following.py).
  // 프런트는 요청 1건만 전송한다 — 기존처럼 절단 PATCH·POST·DELETE 를 개별 전송하면 중간 실패 시 부분 적용 상태가 남는다.
  it('실패하면 오류를 올리고 다른 쓰기 요청(되돌리기·뒷정리)은 보내지 않는다', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/calendar/events/m' && opts.method === 'PATCH') throw Object.assign(new Error('boom'), { data: { detail: '실패' } })
      return undefined
    }
    await expect(updateEventScoped(occ(), { ...data }, 'following')).rejects.toThrow('boom')
    const writes = api.calls.filter(c => c.opts.method)
    expect(writes).toHaveLength(1)
    expect(writes[0].opts.params).toEqual({ scope: 'following', occurrence: '2026-10-15T06:00:00.000Z' })
    expect(rruleUntilIso('FREQ=WEEKLY;COUNT=5')).toBeNull()
  })

  it('성공하면 PATCH 하나 뒤 일정을 다시 받는다 — 예외 행 DELETE·EXDATE PATCH 를 따로 보내지 않는다', async () => {
    await updateEventScoped(occ(), { ...data }, 'following')
    const writes = api.calls.filter(c => c.opts.method)
    expect(writes.map(c => [c.opts.method, c.url])).toEqual([['PATCH', '/api/calendar/events/m']])
    expect(writes[0].opts.body).toEqual(data)
    expect(api.calls[api.calls.length - 1]).toMatchObject({ url: '/api/calendar/events' })
  })
})

describe('빠른 이동', () => {
  it('늦게 온 이전 응답은 버린다', async () => {
    const waits: ((v: any) => void)[] = []
    api.handler = (url, opts) => (url === '/api/calendar/events' && !opts.method ? new Promise((res) => { waits.push(res) }) : undefined)
    calendarStore.setState({ ...initial, calendars: cals as any }, true)
    const first = fetchEvents()
    const second = fetchEvents()
    waits[1]({ events: [ev('new', '2026-12-01T01:00:00Z', '2026-12-01T02:00:00Z')] })
    await second
    expect(calendarStore.getState().loadingEvents).toBe(false)
    waits[0]({ events: [ev('old', '2026-10-01T01:00:00Z', '2026-10-01T02:00:00Z')] })
    await first
    expect(calendarStore.getState().events.map(e => e.id)).toEqual(['new'])
  })
})

describe('일정 폼', () => {
  async function openEdit() {
    calendarStore.setState({
      ...initial, calendars: cals as any,
      editingEvent: ev('e1', '2026-10-20T01:00:00Z', '2026-10-20T02:00:00Z', { title: '회의', description: '안건', location: '3층', reminder_minutes: 10 }),
    }, true)
    renderInRouter(<CalendarEventModal />)
    await act(async () => { calendarStore.setState({ showEventModal: true }) })
  }
  const isPatch = (c: any) => c.url === '/api/calendar/events/e1' && c.opts?.method === 'PATCH'

  it('설명·장소를 비우면 "" 로 보낸다(지움)', async () => {
    await openEdit()
    fireEvent.change(screen.getByLabelText(t('calendar.event.locationLabel')), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(t('calendar.event.descriptionLabel')), { target: { value: '  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.save') })) })
    await waitFor(() => expect(api.calls.some(isPatch)).toBe(true))
    const body = api.calls.find(isPatch)!.opts.body
    expect(body.description).toBe('')
    expect(body.location).toBe('')
    expect(body.reminder_minutes).toBe(10)
  })

  it('참석자 칸: 이름만 치고 Enter 를 눌러도 폼이 제출되지 않는다 · 조합 중 Enter 는 무시 · 목록은 body 포털(z-overlay)', async () => {
    api.handler = (url) => (url.startsWith('/api/contacts/workspace-users')
      ? { users: [{ id: 'u2', username: 'hong', display_name: '홍길동', email: 'hong@x.test' }], total: 1 }
      : undefined)
    await openEdit()
    const input = screen.getByRole('combobox', { name: t('calendar.form.attendees') })
    fireEvent.change(input, { target: { value: '홍길' } })
    // 목록 표시 전 Enter — 기본 동작(폼 제출) 차단
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    expect(api.calls.some(isPatch)).toBe(false)

    const opt = await screen.findByRole('option', { name: /홍길동/ })
    const list = opt.closest('[role="listbox"]') as HTMLElement
    expect(list.className).toContain('z-overlay')
    expect(list.parentElement).toBe(document.body)
    // 조합 중 Enter 는 선택으로 처리하지 않음
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(screen.queryByTitle('hong@x.test')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByTitle('hong@x.test')).toBeTruthy()
    expect(api.calls.some(isPatch)).toBe(false)
  })
})
