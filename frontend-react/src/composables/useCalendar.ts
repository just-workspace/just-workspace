/**
 * 캘린더 상태·동작(모듈 싱글턴).
 *
 * React:
 *   const { calendars, selectedDate, viewMode, fetchEvents, openPopover, eventsOnDay, … } = useCalendar()
 *   - 값은 렌더 시점 값. 읽은 필드만 구독한다(useTrackedStore).
 *   - 바깥에서 바꾸는 상태(viewMode·selectedDate·showEventModal·showShareModal·mobileMenuOpen·icsMode)는
 *     setter 를 같이 내보낸다: setViewMode(동작 함수, 팝오버 닫기 포함) · selectDate · setShowEventModal ·
 *     setShowShareModal · setMobileMenuOpen · setIcsMode.
 * 컴포넌트 밖: calendarStore.getState() 또는 동작 함수 직접 import.
 */
import { createStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { i18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { useTrackedStore } from '~/composables/useTrackedStore'
import { useUserPrefs } from '~/composables/useUserPrefs'
import {
  startOfDay, startOfWeek, addDays, resolveWeekStart, shiftSeries, type WeekStartDay,
} from '~/utils/calendarLayout'
import type { Attendee, AttendeeResponse } from '~/utils/calendarAttendees'
import { eventRange, zAddDays, zAddMonths, zDate, zp } from '~/utils/calTz'
import { downloadApi } from '~/utils/apiDownload'
import { CAT_HEX, catForIndex, hatchedIds } from '~/utils/categoryColor'

export interface CalendarInfo {
  id: string
  name: string
  color: string | null
  is_visible: boolean
  sort_order: number
  /** 공유받은 캘린더(다른 사용자 소유). 서버가 주지 않으면 false */
  is_shared?: boolean
  can_write?: boolean
  /** 외부 .ics 구독(설정 › 캘린더) — 읽기 전용, 서버가 6시간마다 새로 받는다 */
  is_subscription?: boolean
  /** 앞 순번 캘린더와 같은 범주 색 → 빗금으로 구분(화면 계산값) */
  hatched?: boolean
}

export interface CalendarEvent {
  id: string
  calendar_id: string
  title: string
  description: string | null
  location: string | null
  start: string
  end: string
  all_day: boolean
  color: string | null
  status: string | null
  reminder_minutes: number | null
  recurrence_rule: string | null
  is_recurring: boolean
  is_occurrence: boolean
  original_event_id: string | null
  created: string | null
  updated: string | null
  // ── 추가 필드 ──
  timezone?: string | null
  meeting_url?: string | null
  exdates?: string[]
  attendees?: Attendee[]
  /** 내가 참석자면 내 응답 */
  my_response?: AttendeeResponse | string | null
  /** 회차 단일 수정(예외) 행이면 마스터 id — 독립 일정처럼 다룬다 */
  parent_event_id?: string | null
  recurrence_id?: string | null
  is_exception?: boolean
  /** 내 캘린더가 아니라 초대받아서 보이는 일정(읽기 전용, 내 응답만) */
  is_invited?: boolean
  /** 캘린더가 빗금 대상이면 일정 블록에도 빗금(화면 계산값) */
  hatched?: boolean
}

/** 일정 저장 본문의 참석자 */
export interface AttendeeIn { email: string; name?: string | null }

export interface CalendarShareInfo {
  email: string
  can_write: boolean
}

export type ViewMode = 'month' | 'week' | 'day' | 'agenda'
export type DeleteScope = 'this' | 'following' | 'all'

/** 팝오버를 붙일 기준 사각형(뷰포트 좌표) */
export interface AnchorRect { x: number; y: number; w: number; h: number }

/** 다른 모듈(연락처 "일정 잡기")이 새 일정 폼을 미리 채울 때 */
export interface EventPreset { title?: string; attendeeEmail?: string; attendeeName?: string }

export interface CalendarState {
  calendars: CalendarInfo[]
  events: CalendarEvent[]
  viewMode: ViewMode
  selectedDate: Date
  loadingCalendars: boolean
  loadingEvents: boolean
  eventsError: string
  /** 마지막으로 일정을 받아 온 시각(동기화 오류 띠 "마지막 성공 09:12") */
  lastSyncedAt: Date | null
  showEventModal: boolean
  editingEvent: CalendarEvent | null
  eventPreset: EventPreset | null
  showShareModal: boolean
  sharingCalendar: CalendarInfo | null
  /** 읽기 팝오버 */
  popoverEvent: CalendarEvent | null
  popoverAnchor: AnchorRect | null
  /** 모바일: 월 날짜 탭 → 그날 시트 */
  sheetDate: Date | null
  /** 모바일 상단 ⋯ → 캘린더 목록 시트 */
  mobileMenuOpen: boolean
  /** .ics 가져오기·내보내기 대화 상자(⋯ 메뉴·모바일 시트 공용) */
  icsMode: 'import' | 'export' | null
}

export const calendarStore = createStore<CalendarState>()(() => ({
  calendars: [],
  events: [],
  viewMode: 'month',
  selectedDate: new Date(),
  loadingCalendars: false,
  loadingEvents: false,
  eventsError: '',
  lastSyncedAt: null,
  showEventModal: false,
  editingEvent: null,
  eventPreset: null,
  showShareModal: false,
  sharingCalendar: null,
  popoverEvent: null,
  popoverAnchor: null,
  sheetDate: null,
  mobileMenuOpen: false,
  icsMode: null,
}))

const S = calendarStore.getState
const set = calendarStore.setState

// 팝오버를 바깥 클릭으로 닫은 바로 그 클릭이 빈 칸 "새 일정"으로 이어지지 않게
let popoverClosedAt = 0

// 기본 캘린더 색 = 범주 1…8. 저장은 hex(CalDAV 호환), 화면은 --cat-N 토큰으로 그린다.
export const CALENDAR_COLORS: string[] = [...CAT_HEX]

// ─── 파생 값 — 같은 입력이면 같은 결과 객체(렌더 안정) ───

let _visMemo: { events: CalendarEvent[]; calendars: CalendarInfo[]; out: CalendarEvent[] } | null = null
/** 표시 중 일정. 초대받은 일정은 내 캘린더 목록에 없으므로 캘린더 표시 토글과 상관없이 보인다 */
export function selectVisibleEvents(s: Pick<CalendarState, 'events' | 'calendars'>): CalendarEvent[] {
  if (_visMemo && _visMemo.events === s.events && _visMemo.calendars === s.calendars) return _visMemo.out
  const ids = new Set(s.calendars.filter(c => c.is_visible).map(c => c.id))
  const out = s.events.filter(e => e.is_invited || ids.has(e.calendar_id))
  _visMemo = { events: s.events, calendars: s.calendars, out }
  return out
}

/** 그날(캘린더 시간대)과 겹치는 표시 중 일정 — 종일 먼저, 그다음 시작 시각 순. 종일은 날짜 그대로(utils/calTz eventRange) */
export function eventsOnDayOf(visible: CalendarEvent[], day: Date): CalendarEvent[] {
  const ds = startOfDay(day), de = addDays(ds, 1)
  return visible
    .filter((e) => { const r = eventRange(e); return r.start < de && r.end > ds })
    .sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start.localeCompare(b.start))
}

// ─── Actions ───

export async function fetchCalendars() {
  set({ loadingCalendars: true })
  try {
    const data = await $fetch<{ calendars: CalendarInfo[] }>('/api/calendar/calendars')
    // 색 없는 캘린더는 순번대로 범주 1→8, 9번째부터 다시 1(+빗금)
    const withColor = data.calendars.map((c, i) => ({
      ...c,
      color: c.color || CAT_HEX[catForIndex(i).cat - 1],
    }))
    const hatched = hatchedIds(withColor)
    set({ calendars: withColor.map(c => ({ ...c, hatched: hatched.has(c.id) })) })
  } catch (e: any) {
    console.error('fetchCalendars error:', e)
  } finally {
    set({ loadingCalendars: false })
  }
}

// 달을 연달아 넘기면 늦게 온 이전 범위 응답이 지금 범위를 덮었다 — 마지막 요청만 반영한다
let eventsSeq = 0

export async function fetchEvents() {
  const my = ++eventsSeq
  set({ loadingEvents: true, eventsError: '' })
  try {
    // Fetch a wide range around the selected date
    const d = zp(S().selectedDate)
    // 일정 목록(agenda)이 선택한 날부터 60일을 보여 주므로 뒤로 두 달까지 받는다(캘린더 시간대 기준 달)
    const start = zDate(d.year, d.month - 1, 1)
    const end = zDate(d.year, d.month + 3, 0)

    const data = await $fetch<{ events: CalendarEvent[] }>('/api/calendar/events', {
      params: {
        start: start.toISOString(),
        end: end.toISOString(),
        include_invited: true,
      },
    })
    if (my !== eventsSeq) return
    // Attach calendar color
    const cals = S().calendars
    const colorMap = new Map(cals.map(c => [c.id, c.color]))
    const hatchMap = new Map(cals.map(c => [c.id, !!c.hatched]))
    set({
      events: data.events.map(e => ({
        ...e,
        color: e.color || colorMap.get(e.calendar_id) || CALENDAR_COLORS[0],
        hatched: hatchMap.get(e.calendar_id) ?? false,
      })),
      lastSyncedAt: new Date(),
    })
  } catch (e: any) {
    console.error('fetchEvents error:', e)
    if (my !== eventsSeq) return
    // 불러오기 실패는 그리드를 지우지 않고 커맨드 바 아래 띠로
    set({ eventsError: e?.data?.detail || e?.message || i18n.t('calendar.error.load') })
  } finally {
    if (my === eventsSeq) set({ loadingEvents: false })
  }
}

/** 서버가 준 오류 문장(문자열일 때만) */
function detailOf(e: any): string {
  return typeof e?.data?.detail === 'string' ? e.data.detail : ''
}

export async function createCalendar(name: string, color?: string) {
  try {
    await $fetch('/api/calendar/calendars', {
      method: 'POST',
      body: { name, color },
    })
    await fetchCalendars()
  } catch (e: any) {
    console.error('createCalendar error:', e)
    throw e
  }
}

export async function updateCalendar(id: string, updates: Partial<CalendarInfo>) {
  try {
    await $fetch(`/api/calendar/calendars/${id}`, {
      method: 'PATCH',
      body: updates,
    })
    await fetchCalendars()
  } catch (e: any) {
    console.error('updateCalendar error:', e)
    // 실패를 삼키면 바뀐 줄 안다 — 호출부가 여러 곳이라 여기서 알린다
    addToast('error', detailOf(e) || i18n.t('calendar.error.calendarUpdate', '캘린더를 바꾸지 못했습니다'))
  }
}

export async function deleteCalendar(id: string) {
  try {
    await $fetch(`/api/calendar/calendars/${id}`, { method: 'DELETE' })
    await fetchCalendars()
    await fetchEvents()
  } catch (e: any) {
    console.error('deleteCalendar error:', e)
    addToast('error', detailOf(e) || i18n.t('calendar.error.calendarDelete', '캘린더를 삭제하지 못했습니다'))
  }
}

export interface EventCreateData {
  calendar_id: string
  title: string
  description?: string
  location?: string
  start: string
  end: string
  all_day?: boolean
  reminder_minutes?: number | null
  recurrence_rule?: string | null
  recurrence_end?: string | null
  timezone?: string | null
  meeting_url?: string | null
  attendees?: AttendeeIn[]
}

export async function createEvent(data: EventCreateData) {
  try {
    await $fetch('/api/calendar/events', {
      method: 'POST',
      body: data,
    })
    await fetchEvents()
  } catch (e: any) {
    console.error('createEvent error:', e)
    throw e
  }
}

export async function updateEvent(id: string, data: Record<string, any>) {
  try {
    await $fetch(`/api/calendar/events/${id}`, {
      method: 'PATCH',
      body: data,
    })
    await fetchEvents()
  } catch (e: any) {
    console.error('updateEvent error:', e)
    throw e
  }
}

export async function deleteEvent(id: string) {
  try {
    await $fetch(`/api/calendar/events/${id}`, { method: 'DELETE' })
    set({ events: S().events.filter(e => e.id !== id && e.original_event_id !== id) })
  } catch (e: any) {
    console.error('deleteEvent error:', e)
    // 실패를 삼키면 "삭제됐다"로 보인다 — 호출부가 토스트로 알린다
    throw e
  }
}

/**
 * 반복 일정 삭제 범위 — 서버가 한 번에 처리한다(DELETE ?scope=&occurrence=&notify=).
 *  - 이 일정만: 회차 예외(EXDATE). 회차 예외 행이면 그 행 id 로.
 *  - 이후 모두: 서버가 규칙을 이 회차 직전에서 끊고 뒤 예외 행을 정리(첫 회차면 전체 삭제).
 *  - 반복 전체: 마스터째.
 * notify = 참석자(나 빼고)에게 취소 알림. 알린 사람 수를 돌려준다.
 */
export async function deleteEventScoped(
  ev: CalendarEvent,
  scope: DeleteScope,
  opts: { notify?: boolean } = {},
): Promise<number> {
  const recurring = ev.is_recurring || ev.is_occurrence || ev.is_exception
  const params: Record<string, string> = {}
  if (opts.notify) params.notify = 'true'
  let id = ev.original_event_id || ev.id
  if (!recurring) {
    id = ev.id
  } else if (ev.is_exception) {
    // 예외 행: 서버가 행의 원래 회차(recurrence_id)·마스터를 찾아 범위를 적용한다
    id = ev.id
    params.scope = scope
  } else {
    params.scope = scope
    if (scope !== 'all' || ev.is_occurrence) params.occurrence = new Date(ev.start).toISOString()
  }
  const r = await $fetch<{ ok: boolean; notified?: number }>(`/api/calendar/events/${id}`, { method: 'DELETE', params })
  await fetchEvents()
  return r?.notified ?? 0
}

/** RRULE 의 UNTIL(YYYYMMDD 또는 YYYYMMDDTHHMMSSZ) → ISO. 없으면 null */
export function rruleUntilIso(rule: string | null | undefined): string | null {
  const m = /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/.exec((rule || '').replace(/^RRULE:/, ''))
  if (!m) return null
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : 59)).toISOString()
}

/** RRULE 의 COUNT(없으면 null) */
export function rruleCount(rule: string | null | undefined): number | null {
  const m = /(?:^|;)COUNT=(\d+)/.exec((rule || '').replace(/^RRULE:/, ''))
  return m ? parseInt(m[1], 10) : null
}

/**
 * 반복 일정 수정 범위.
 * - 반복 아님 / 회차 예외 행 / 마스터 자체 + 전체: 그대로 PATCH
 * - 회차 + 전체: 마스터를 받아 회차에서 옮긴 만큼만 옮긴다(회차 날짜가 시리즈 첫날이 되던 문제 방지)
 * - 회차 + 이후 모두: PATCH ?scope=following&occurrence= — 서버가 한 번에 시리즈를 둘로 나눈다(이후 구간의 지운 회차·개별 수정 보존)
 * - 이 일정만: PATCH ?occurrence=<회차 원래 시작> → 서버가 회차 예외(RECURRENCE-ID) 행을 만든다.
 *   반복 규칙·캘린더 이동은 예외에 담을 수 없어 뺀다.
 */
export async function updateEventScoped(
  ev: CalendarEvent,
  data: Record<string, any> & { start: string; end: string; calendar_id: string; title: string },
  scope: DeleteScope,
) {
  const masterId = ev.original_event_id || ev.id
  if (scope === 'this' && ev.recurrence_rule && !ev.is_exception) {
    const { recurrence_rule: _r, recurrence_end: _e, calendar_id: _c, ...rest } = data
    await $fetch(`/api/calendar/events/${masterId}`, {
      method: 'PATCH',
      params: { occurrence: new Date(ev.start).toISOString() },
      body: rest,
    })
    await fetchEvents()
    return
  }
  if (!ev.is_occurrence || !ev.recurrence_rule) {
    await updateEvent(masterId, data)
    return
  }
  const occStart = new Date(ev.start)
  if (scope === 'following') {
    // 서버가 한 트랜잭션으로 나눈다(PATCH ?scope=following): 옛 시리즈를 이 회차 직전에서 끊고 새 시리즈를 만들며,
    // 이후 구간의 지운 회차·"이 일정만" 수정 회차를 새 시리즈로 옮기고, 횟수(COUNT) 반복은 남은 회차만큼 줄인다.
    // 예전엔 여기서 요청 여러 개로 나눠 해서 중간 실패 때 반쯤 된 상태가 남았고, 이후 구간의 개별 수정이 버려졌다.
    try {
      await $fetch(`/api/calendar/events/${masterId}`, {
        method: 'PATCH',
        params: { scope: 'following', occurrence: occStart.toISOString() },
        body: data,
      })
    } catch (e) {
      console.error('updateEventScoped error:', e)
      throw e
    }
    await fetchEvents()
    return
  }
  // 전체
  const master = await $fetch<CalendarEvent>(`/api/calendar/events/${masterId}`)
  const moved = shiftSeries(
    { start: new Date(master.start), end: new Date(master.end) },
    occStart,
    { start: new Date(data.start), end: new Date(data.end) },
  )
  await updateEvent(masterId, { ...data, start: moved.start.toISOString(), end: moved.end.toISOString() })
}

/** 내 응답(RSVP). 회차 id 를 보내도 서버가 마스터에 기록한다 → 같은 시리즈 회차 전부 갱신 */
export async function rsvpEvent(ev: CalendarEvent, response: AttendeeResponse) {
  const r = await $fetch<{ ok: boolean; event_id: string; email: string; response: string }>(
    `/api/calendar/events/${ev.id}/rsvp`, { method: 'POST', body: { response } })
  const seriesId = r.event_id
  const patch = (e: CalendarEvent): CalendarEvent => ({
    ...e,
    my_response: r.response,
    attendees: (e.attendees || []).map(a => a.email.toLowerCase() === r.email.toLowerCase() ? { ...a, response: r.response } : a),
  })
  set({ events: S().events.map(e => (e.id === ev.id || e.id === seriesId || e.original_event_id === seriesId) ? patch(e) : e) })
  const pe = S().popoverEvent
  if (pe && (pe.id === ev.id || pe.original_event_id === seriesId || pe.id === seriesId)) {
    set({ popoverEvent: patch(pe) })
  }
}

/** 알림 링크(/calendar?event=<id>) — 일정을 받아 그날로 옮기고 읽기 팝오버를 연다. 못 찾으면 false */
export async function openEventById(id: string): Promise<boolean> {
  try {
    const ev = await $fetch<CalendarEvent>(`/api/calendar/events/${encodeURIComponent(id)}`)
    const cals = S().calendars
    const colorMap = new Map(cals.map(c => [c.id, c.color]))
    const hatched = cals.find(c => c.id === ev.calendar_id)?.hatched ?? false
    set({
      selectedDate: eventRange(ev).start,
      popoverAnchor: null,
      popoverEvent: { ...ev, color: ev.color || colorMap.get(ev.calendar_id) || CALENDAR_COLORS[0], hatched },
    })
    return true
  } catch { return false }
}

/** .ics 가져오기 → {created, updated, skipped} */
export async function importIcs(calendarId: string, file: File) {
  const fd = new FormData()
  fd.append('file', file)
  const r = await $fetch<{ ok: boolean; created: number; updated: number; skipped: number }>(
    `/api/calendar/calendars/${calendarId}/import`, { method: 'POST', body: fd })
  await fetchEvents()
  return r
}

/** .ics 내보내기(캘린더 전체 또는 일정 하나) — 파일 다운로드 */
export async function exportIcs(target: { calendarId?: string; eventId?: string }) {
  const url = target.eventId
    ? `/api/calendar/events/${encodeURIComponent(target.eventId)}/export.ics`
    : `/api/calendar/calendars/${target.calendarId}/export.ics`
  await downloadApi(url, 'calendar.ics')
}

export function toggleCalendarVisibility(id: string) {
  // 제자리에서 고치지 않고 새 객체로 바꿔 넣는다
  set({ calendars: S().calendars.map(c => c.id === id ? { ...c, is_visible: !c.is_visible } : c) })
}

export function soloCalendar(id: string) {
  const cals = S().calendars
  const allVisible = cals.every(c => c.id === id ? c.is_visible : !c.is_visible)
  if (allVisible) {
    // Already solo — restore all to visible
    set({ calendars: cals.map(c => ({ ...c, is_visible: true })) })
  } else {
    // Solo mode — hide everything except the clicked one
    set({ calendars: cals.map(c => ({ ...c, is_visible: c.id === id })) })
  }
}

export function setViewMode(mode: ViewMode) {
  set({ viewMode: mode })
  closePopover()
}

let _defaultViewApplied = false
/**
 * 설정 › 캘린더 "기본 보기" — 앱을 연 뒤 캘린더에 처음 들어올 때 한 번만 적용한다
 * (그 뒤 사용자가 바꾼 보기는 이 세션 동안 유지). 모바일에는 일 보기가 없어 그때는 건너뛴다.
 */
export function applyDefaultViewOnce(view: ViewMode, isMobile: boolean) {
  if (_defaultViewApplied) return
  _defaultViewApplied = true
  if (isMobile && view === 'day') return
  set({ viewMode: view })
}
/** 테스트용 */
export function _resetDefaultView() { _defaultViewApplied = false }

export function goToToday() {
  set({ selectedDate: new Date() })
}

export function navigatePrev() {
  const { selectedDate, viewMode } = S()
  const d = viewMode === 'month' ? zAddMonths(selectedDate, -1)
    : viewMode === 'week' || viewMode === 'agenda' ? zAddDays(selectedDate, -7)
      : zAddDays(selectedDate, -1)
  set({ selectedDate: d })
}

export function navigateNext() {
  const { selectedDate, viewMode } = S()
  const d = viewMode === 'month' ? zAddMonths(selectedDate, 1)
    : viewMode === 'week' || viewMode === 'agenda' ? zAddDays(selectedDate, 7)
      : zAddDays(selectedDate, 1)
  set({ selectedDate: d })
}

export function selectDate(date: Date) {
  set({ selectedDate: date })
}

export async function fetchCalendarShares(calendarId: string): Promise<CalendarShareInfo[]> {
  try {
    const data = await $fetch<CalendarShareInfo[]>(`/api/calendar/calendars/${calendarId}/shares`)
    return data
  } catch (e: any) {
    console.error('fetchCalendarShares error:', e)
    return []
  }
}

export async function setCalendarShares(calendarId: string, shares: CalendarShareInfo[]) {
  try {
    await $fetch(`/api/calendar/calendars/${calendarId}/shares`, {
      method: 'POST',
      body: { shares },
    })
  } catch (e: any) {
    console.error('setCalendarShares error:', e)
    throw e
  }
}

export async function removeCalendarShare(calendarId: string, email: string) {
  try {
    await $fetch(`/api/calendar/calendars/${calendarId}/shares/${encodeURIComponent(email)}`, {
      method: 'DELETE',
    })
  } catch (e: any) {
    console.error('removeCalendarShare error:', e)
    throw e
  }
}

export function openShareModal(cal: CalendarInfo) {
  set({ sharingCalendar: cal, showShareModal: true })
}

export function closeShareModal() {
  set({ showShareModal: false, sharingCalendar: null })
}

export function openCreateModal(date?: Date, preset?: EventPreset) {
  closePopover()
  set({
    editingEvent: null,
    eventPreset: preset ?? null,
    ...(date ? { selectedDate: date } : {}),
    showEventModal: true,
  })
}

export function openEditModal(event: CalendarEvent) {
  // 초대받은 일정·읽기 전용 공유 캘린더는 고칠 수 없다(더블클릭 등으로 와도 무시)
  const cal = S().calendars.find(c => c.id === event.calendar_id)
  if (event.is_invited || !cal || cal.can_write === false) return
  closePopover()
  set({ editingEvent: event, eventPreset: null, showEventModal: true })
}

export function closeModal() {
  set({ showEventModal: false, editingEvent: null, eventPreset: null })
}

// ─── 읽기 팝오버 ───

export function openPopover(event: CalendarEvent, anchorEl?: Element | null) {
  const r = anchorEl?.getBoundingClientRect()
  set({
    popoverAnchor: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
    popoverEvent: event,
  })
}

export function closePopover() {
  if (S().popoverEvent) popoverClosedAt = Date.now()
  if (S().popoverEvent === null && S().popoverAnchor === null) return
  set({ popoverEvent: null, popoverAnchor: null })
}

/** 방금(400ms 안) 팝오버가 닫혔는가 — 빈 칸 클릭 핸들러가 새 일정 열기를 건너뛴다 */
export function popoverJustClosed() { return Date.now() - popoverClosedAt < 400 }

// ─── 모바일 시트 ───

export function openDaySheet(date: Date) {
  set({ sheetDate: startOfDay(date), selectedDate: date })
}

export function closeDaySheet() { if (S().sheetDate !== null) set({ sheetDate: null }) }

// ─── 바깥에서 바꾸는 상태의 setter ───
export function setShowEventModal(v: boolean) { set({ showEventModal: v }) }
export function setShowShareModal(v: boolean) { set({ showShareModal: v }) }
export function setMobileMenuOpen(v: boolean) { set({ mobileMenuOpen: v }) }
export function setIcsMode(v: 'import' | 'export' | null) { set({ icsMode: v }) }

/** 주 시작 요일: 설정›표시(useUserPrefs) → 로케일 기본 */
export function useWeekStart(): WeekStartDay {
  const { prefs } = useUserPrefs()
  return resolveWeekStart(prefs.weekStart, navigator.language)
}

export function useCalendar() {
  const { track } = useTrackedStore(calendarStore)
  const weekStart = useWeekStart()

  const visibleEvents = () => selectVisibleEvents({ events: track('events'), calendars: track('calendars') })
  const calendarById = () => new Map(track('calendars').map(c => [c.id, c]))

  return {
    // State
    get calendars() { return track('calendars') },
    get events() { return track('events') },
    get viewMode() { return track('viewMode') },
    get selectedDate() { return track('selectedDate') },
    get loadingCalendars() { return track('loadingCalendars') },
    get loadingEvents() { return track('loadingEvents') },
    get eventsError() { return track('eventsError') },
    get lastSyncedAt() { return track('lastSyncedAt') },
    get showEventModal() { return track('showEventModal') },
    get editingEvent() { return track('editingEvent') },
    get eventPreset() { return track('eventPreset') },
    get showShareModal() { return track('showShareModal') },
    get sharingCalendar() { return track('sharingCalendar') },
    get popoverEvent() { return track('popoverEvent') },
    get popoverAnchor() { return track('popoverAnchor') },
    get sheetDate() { return track('sheetDate') },
    get mobileMenuOpen() { return track('mobileMenuOpen') },
    get icsMode() { return track('icsMode') },
    // Computed
    get visibleEvents() { return visibleEvents() },
    get currentMonth() { return zp(track('selectedDate')).month },
    get currentYear() { return zp(track('selectedDate')).year },
    weekStart,
    /** 선택한 날짜가 속한 주 [시작, 끝] (주 보기 · 미니 달력 강조) */
    get weekRange() {
      const s = startOfWeek(track('selectedDate'), weekStart)
      return { start: s, end: addDays(s, 6) }
    },
    // Actions
    fetchCalendars,
    fetchEvents,
    createCalendar,
    updateCalendar,
    deleteCalendar,
    createEvent,
    updateEvent,
    deleteEvent,
    deleteEventScoped,
    updateEventScoped,
    rsvpEvent,
    openEventById,
    importIcs,
    exportIcs,
    toggleCalendarVisibility,
    soloCalendar,
    setViewMode,
    goToToday,
    navigatePrev,
    navigateNext,
    selectDate,
    openCreateModal,
    openEditModal,
    closeModal,
    openPopover,
    closePopover,
    popoverJustClosed,
    openDaySheet,
    closeDaySheet,
    /** 그날과 겹치는 표시 중 일정 — 종일 먼저, 그다음 시작 시각 순 */
    eventsOnDay: (day: Date) => eventsOnDayOf(visibleEvents(), day),
    calendarName: (id: string) => calendarById().get(id)?.name ?? '',
    calendarColor: (id: string) => calendarById().get(id)?.color ?? null,
    fetchCalendarShares,
    setCalendarShares,
    removeCalendarShare,
    openShareModal,
    closeShareModal,
    setShowEventModal,
    setShowShareModal,
    setMobileMenuOpen,
    setIcsMode,
    CALENDAR_COLORS,
  }
}
