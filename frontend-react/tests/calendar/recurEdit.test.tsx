// 반복 일정 편집 회귀: 반복 칸을 안 건드리면 원래 규칙 그대로(UNTIL 재확장 금지),
// "이 일정과 이후" 는 남은 회차만(COUNT 재시작 금지).
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
    const r = api.handler(url, opts)
    if (r !== undefined) return r
    if (url === '/api/calendar/calendars') return { calendars: [] }
    if (url === '/api/calendar/events' && !opts.method) return { events: [] }
    return { ok: true }
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { calendarStore, updateEventScoped, rruleCount } = await import('~/composables/useCalendar')
const { CalendarEventModal, parseRRuleToForm, rruleUntilInstant } = await import('~/components/calendar/CalendarEventModal')
const { setUser } = await import('~/composables/useAuth')
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
  setUser({ id: 'u1', username: 'me', display_name: 'Me', email: 'me@x.test' } as any)
  _setCalendarZone('Asia/Seoul')
})
afterEach(() => {
  _setCalendarZone(null)
  calendarStore.setState({ ...initial }, true)
})

describe('UNTIL 보존', () => {
  it('UTC UNTIL 은 일정 시간대 날짜로 폼에 넣는다', () => {
    expect(parseRRuleToForm('FREQ=DAILY;UNTIL=20261022T155959Z', 'Asia/Seoul').recurrence_end_date).toBe('2026-10-23')
    expect(rruleUntilInstant('FREQ=DAILY;UNTIL=20261023T005959Z')!.toISOString()).toBe('2026-10-23T00:59:59.000Z')
  })

  it('반복 칸을 안 건드리고 "모든 일정"으로 저장하면 원래 규칙 문자열 그대로', async () => {
    const rule = 'FREQ=DAILY;UNTIL=20261023T005959Z'
    calendarStore.setState({ ...initial, calendars: cals as any, editingEvent: ev('s', '2026-10-20T01:00:00Z', '2026-10-20T02:00:00Z', { recurrence_rule: rule, is_recurring: true }) }, true)
    renderInRouter(<CalendarEventModal />)
    await act(async () => { calendarStore.setState({ showEventModal: true }) })
    fireEvent.change(screen.getByLabelText(t('calendar.event.titleLabel')), { target: { value: '새 제목' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.save') })) })
    fireEvent.click(screen.getByLabelText(t('calendar.scope.all')))
    const saves = screen.getAllByRole('button', { name: t('common.save') })
    await act(async () => { fireEvent.click(saves[saves.length - 1]) })
    const isEv = (c: any) => c.url.startsWith('/api/calendar/events/') && c.opts?.method === 'PATCH'
    await waitFor(() => expect(api.calls.some(isEv)).toBe(true))
    const patch = api.calls.find(isEv)!
    const body = patch.opts.body
    expect(body.recurrence_rule).toBe(rule)
    expect(body.recurrence_end).toBe('2026-10-23T00:59:59.000Z')
    expect(body.title).toBe('새 제목')
  })
})

describe('"이 일정과 이후" COUNT', () => {
  // 남은 회차 계산은 서버로 옮겼다(backend/tests/calsplit_following.py 의 COUNT 테스트) — 프런트는 규칙을 그대로 보낸다
  it('횟수 반복을 "이 일정과 이후"로 바꾸면 규칙 그대로 PATCH ?scope=following 하나', async () => {
    expect(rruleCount('RRULE:FREQ=DAILY;COUNT=5')).toBe(5)
    const rule = 'FREQ=DAILY;COUNT=5'
    const occ = ev('m1_20261022T010000', '2026-10-22T01:00:00Z', '2026-10-22T02:00:00Z', { recurrence_rule: rule, is_occurrence: true, original_event_id: 'm1' })
    await updateEventScoped(occ, { calendar_id: 'c1', title: '바뀜', start: '2026-10-22T01:00:00Z', end: '2026-10-22T02:00:00Z', recurrence_rule: rule }, 'following')
    const writes = api.calls.filter(c => c.opts?.method)
    expect(writes).toHaveLength(1)
    expect(writes[0].url).toBe('/api/calendar/events/m1')
    expect(writes[0].opts.params).toEqual({ scope: 'following', occurrence: '2026-10-22T01:00:00.000Z' })
    expect(writes[0].opts.body.recurrence_rule).toBe(rule)
  })
})
