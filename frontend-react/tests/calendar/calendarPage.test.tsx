// 캘린더 화면 렌더: 월 보기 칩(범주 색·빗금) → 칩 클릭 = 읽기 팝오버, 반복 일정 삭제 = 범위 확인(이 일정만 기본) → DELETE ?scope=,
// 불러오기 실패 = 동기화 오류 띠(그리드 유지), 보기 전환(주·일·일정 목록). ($fetch 는 가짜)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, waitFor, screen } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  failEvents: false,
}))

const day = (h: number, d = 15) => new Date(2026, 9, d, h).toISOString()

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => {
    api.calls.push({ url, opts })
    if (url === '/api/calendar/calendars') {
      return { calendars: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: `캘${i}`, color: null, is_visible: true, sort_order: i, can_write: true })) }
    }
    if (url === '/api/calendar/events' && !opts.method) {
      if (api.failEvents) throw Object.assign(new Error('x'), { data: { detail: '동기화 실패' } })
      return { events: [
        { id: 'e1', calendar_id: 'c0', title: '주간 회의', description: null, location: null, start: day(10), end: day(11), all_day: false, color: null, status: null, reminder_minutes: null, recurrence_rule: 'FREQ=WEEKLY', is_recurring: false, is_occurrence: true, original_event_id: 'm1', created: null, updated: null, attendees: [] },
        { id: 'e2', calendar_id: 'c8', title: '빗금 일정', description: null, location: null, start: day(13), end: day(14), all_day: false, color: null, status: null, reminder_minutes: null, recurrence_rule: null, is_recurring: false, is_occurrence: false, original_event_id: null, created: null, updated: null },
      ] }
    }
    return { ok: true }
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: CalendarPage } = await import('~/pages/calendar')
const { calendarStore } = await import('~/composables/useCalendar')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')
const { i18n } = await import('~/i18n')
const t = (k: string, a?: any) => i18n.t(k, a)
const initial = calendarStore.getState()

beforeEach(() => {
  api.calls = []
  api.failEvents = false
  isMobileStore.setState({ isMobile: false })
  calendarStore.setState({ ...initial, selectedDate: new Date(2026, 9, 15, 9) }, true)
  setUser({ id: 'u1', username: 'me', display_name: 'Me', email: 'me@x.test' } as any)
})

describe('캘린더 화면', () => {
  it('월 보기 칩: 범주 색 + 9번째 캘린더는 빗금, 클릭하면 읽기 팝오버', async () => {
    renderInRouter(<CalendarPage />, '/calendar')
    const chip = await screen.findByTitle('빗금 일정')
    expect(chip.className).toContain('bg-cat-hatch')
    expect(chip.getAttribute('style')).toContain('--cat-1')
    const weekly = await screen.findByTitle('주간 회의')
    expect(weekly.className).not.toContain('bg-cat-hatch')
    fireEvent.click(weekly)
    const dlg = await screen.findByRole('dialog', { name: '주간 회의' })
    expect(dlg.textContent).toContain('캘0')
  })

  it('반복 일정 삭제: 범위 확인(이 일정만 기본) → DELETE scope=this&occurrence=', async () => {
    renderInRouter(<CalendarPage />, '/calendar')
    fireEvent.click(await screen.findByTitle('주간 회의'))
    const dlg = await screen.findByRole('dialog', { name: '주간 회의' })
    fireEvent.click(dlg.querySelector(`button[aria-label="${t('common.delete')}"]`)!)
    const alert = await screen.findByRole('alertdialog')
    expect(alert.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toContain(t('calendar.scope.this'))
    const del = [...alert.querySelectorAll('button')].find(b => b.textContent === t('common.delete'))!
    await act(async () => { fireEvent.click(del) })
    await waitFor(() => expect(api.calls.some(c => c.opts.method === 'DELETE')).toBe(true))
    const call = api.calls.find(c => c.opts.method === 'DELETE')!
    expect(call.url).toBe('/api/calendar/events/m1')
    expect(call.opts.params).toEqual({ scope: 'this', occurrence: day(10) })
  })

  it('일정 불러오기 실패: 동기화 오류 띠(role=alert), 닫으면 숨김', async () => {
    api.failEvents = true
    renderInRouter(<CalendarPage />, '/calendar')
    const band = await screen.findByRole('alert')
    expect(band.textContent).toContain(t('calendar.sync.failedTitle'))
    fireEvent.click(band.querySelector(`button[aria-label="${t('common.close')}"]`)!)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('보기 전환: 주(시간 그리드 GMT 라벨) · 일정 목록(날짜 머리)', async () => {
    const { container } = renderInRouter(<CalendarPage />, '/calendar')
    await screen.findByTitle('주간 회의')
    const seg = container.querySelector(`[role="radiogroup"][aria-label="${t('calendar.viewMode.label')}"]`)!
    fireEvent.click([...seg.querySelectorAll('button')].find(b => b.textContent === t('calendar.viewMode.week'))!)
    expect(await screen.findByTitle(/주간 회의 · 10:00–11:00/)).toBeTruthy()
    fireEvent.click([...seg.querySelectorAll('button')].find(b => b.textContent === t('calendar.viewMode.agenda'))!)
    expect(await screen.findByText(t('calendar.agenda.dayLabel', { m: 10, d: 15, w: '목' }))).toBeTruthy()
  })

  it('시간대 불일치 띠(R13 #tz): 설정 ≠ 기기면 띠 + 툴바 mono 표시, "그대로" 는 닫고 그 조합을 기억', async () => {
    const { userPrefsStore } = await import('~/composables/useUserPrefs')
    const prev = userPrefsStore.getState().prefs
    localStorage.removeItem('jw:calendar:tzBandKept')
    userPrefsStore.setState({ prefs: { ...prev, timezone: 'Pacific/Kiritimati' } })   // UTC+14 — 테스트 기기와 다름
    try {
      const { unmount } = renderInRouter(<CalendarPage />, '/calendar')
      const band = await screen.findByRole('status')
      expect(band.textContent).toContain('Kiritimati (UTC+14)')
      expect(screen.getByText('UTC+14 Kiritimati')).toBeTruthy()
      // 한글 표에 없는 시간대 — 이름만 쓰는 버튼은 영문 + UTC 오프셋(핸드오프 15-2)
      fireEvent.click(screen.getByRole('button', { name: t('calendar.tzBand.keep', { city: 'Kiritimati (UTC+14)' }) }))
      await waitFor(() => expect(screen.queryByText(/Kiritimati \(UTC\+14\)/)).toBeNull())
      unmount()
      renderInRouter(<CalendarPage />, '/calendar')
      await screen.findByText('UTC+14 Kiritimati')
      expect(screen.queryByText(/Kiritimati \(UTC\+14\)/)).toBeNull()
    } finally {
      userPrefsStore.setState({ prefs: prev })
    }
  })
})
