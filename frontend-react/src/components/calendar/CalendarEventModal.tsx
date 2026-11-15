/**
 * 일정 폼: UiModal(데스크톱 중앙 520 · 모바일 바텀시트).
 * 기본 5 — 제목(44, 16/600) · 시간(날짜 + 시작–끝 mono + 길이 + 종일 스위치) · 캘린더 / 화상 회의 · 참석자
 * + "자세히 ▾"(장소 · 반복 · 알림 · 설명 · 시간대). 푸터 [삭제(편집일 때, 왼쪽)] … [취소][저장].
 * 화상 회의: "링크 자동 생성" 을 켜고 저장하면 예약 회의(/api/meetings/rooms)를 만들어 그 참여 링크를 meeting_url 로 넣는다.
 *   다른 서비스 링크는 "자세히 › 회의 링크" 에 붙여 넣는다(있으면 칸에 링크가 보이고 ✕ 로 지운다).
 * 참석자: 워크스페이스 사용자 자동완성 + 외부 이메일. 시간·참석자가 바뀌면 free/busy 로 겹침을 칩·경고 줄로 알린다.
 * 시간대: 고른 시간대의 벽시계로 시각을 읽어 저장한다(기본 = 캘린더 시간대 = 설정 시간대, 일정에 저장된 값이 있으면 그것).
 * 종일 일정은 날짜만 — 시간대 변환 없이 그 날짜의 UTC 00:00 으로 저장한다(utils/calTz 규약, .ics/CalDAV 와 같음).
 * 반복 일정 저장·삭제는 범위 확인(CalendarScopeModal)을 거친다.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { useCalendar, calendarStore, type DeleteScope } from '~/composables/useCalendar'
import { userPrefsStore } from '~/composables/useUserPrefs'
import {
  durationParts, eventBar, toRRuleUtc, clampRecurrenceCount, safeRecurrenceFreq,
} from '~/utils/calendarLayout'
import { allDayIsoFromInput, allDayYmd, calendarZone, zAtTime, zDate, zp } from '~/utils/calTz'
import { tzSelectSearch, tzZoneNames } from '~/utils/timezoneBand'
import {
  tzGmtLabel, zonedToDate, dateToZoned, firstConflict,
  type BusyInterval,
} from '~/utils/calendarAttendees'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiSwitch } from '~/components/ui/Switch'
import { UiSelect } from '~/components/ui/Select'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiChip } from '~/components/ui/Chip'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiButton } from '~/components/ui/Button'
import { CalendarAttendeesInput, type AttendeeChip } from './CalendarAttendeesInput'
import { CalendarScopeModal } from './CalendarScopeModal'

interface EventForm {
  calendar_id: string
  title: string
  description: string
  location: string
  date: string
  endDate: string
  startTime: string
  endTime: string
  all_day: boolean
  reminder_minutes: number | null
  recurrence_type: 'none' | 'daily' | 'weekly' | 'monthly'
  /** 0=MO … 6=SU */
  recurrence_days: number[]
  recurrence_end_type: 'never' | 'date' | 'count'
  recurrence_end_date: string
  recurrence_count: number
  timezone: string
  meeting_url: string
  meeting_auto: boolean
  attendees: AttendeeChip[]
}

const initialForm = (): EventForm => ({
  calendar_id: '',
  title: '',
  description: '',
  location: '',
  date: '',
  endDate: '',
  startTime: '09:00',
  endTime: '10:00',
  all_day: false,
  reminder_minutes: null,
  recurrence_type: 'none',
  recurrence_days: [],
  recurrence_end_type: 'never',
  recurrence_end_date: '',
  recurrence_count: 10,
  timezone: calendarZone(),
  meeting_url: '',
  meeting_auto: false,
  attendees: [],
})

const RRULE_DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

function buildRRule(form: EventForm): string | null {
  if (form.recurrence_type === 'none') return null
  const freq = safeRecurrenceFreq(form.recurrence_type)
  if (!freq) return null
  const parts: string[] = [`FREQ=${freq}`]
  if (form.recurrence_type === 'weekly' && form.recurrence_days.length > 0) {
    parts.push(`BYDAY=${[...form.recurrence_days].sort((a, b) => a - b).map(i => RRULE_DAY_CODES[i]).join(',')}`)
  }
  const count = clampRecurrenceCount(form.recurrence_count)
  if (form.recurrence_end_type === 'count' && count) {
    parts.push(`COUNT=${count}`)
  } else if (form.recurrence_end_type === 'date' && form.recurrence_end_date) {
    parts.push(`UNTIL=${untilOf(form)}`)
  }
  return parts.join(';')
}

/** 'YYYY-MM-DD' 에 n일(순수 날짜 계산 — 시간대·서머타임 무관) */
export function ymdAdd(date: string, n: number): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return date
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 두 'YYYY-MM-DD' 사이 날짜 수 */
export function ymdDiff(a: string, b: string): number {
  const p = (x: string) => { const m = x.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN }
  return Math.round((p(b) - p(a)) / 86400000)
}

/** 반복 끝 날짜의 마지막 순간 — 시각 일정은 그 일정 시간대의 23:59:59, 종일은 그 날짜(UTC) 23:59:59 */
function untilInstant(form: EventForm): Date | null {
  const e = form.recurrence_end_date
  if (!e) return null
  if (form.all_day) {
    const iso = allDayIsoFromInput(e)
    return iso ? new Date(Date.parse(iso) + 86399000) : null
  }
  const d = zonedToDate(e, '23:59', form.timezone)
  return d ? new Date(d.getTime() + 59000) : null
}
function untilOf(form: EventForm): string {
  const d = untilInstant(form)
  return d ? toRRuleUtc(d) : `${form.recurrence_end_date.replace(/-/g, '')}T235959Z`
}

/** RRULE UNTIL(YYYYMMDD 또는 YYYYMMDDTHHMMSSZ) → 그 순간. 없으면 null */
export function rruleUntilInstant(rrule: string | null | undefined): Date | null {
  const m = /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/.exec((rrule || '').replace(/^RRULE:/, ''))
  if (!m) return null
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : 59))
}

/** 순간 → 그 시간대의 'YYYY-MM-DD' */
function ymdInZone(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

export function parseRRuleToForm(rrule: string | null, tz?: string): Pick<EventForm, 'recurrence_type' | 'recurrence_days' | 'recurrence_end_type' | 'recurrence_end_date' | 'recurrence_count'> {
  const out: Pick<EventForm, 'recurrence_type' | 'recurrence_days' | 'recurrence_end_type' | 'recurrence_end_date' | 'recurrence_count'> = {
    recurrence_type: 'none',
    recurrence_days: [],
    recurrence_end_type: 'never',
    recurrence_end_date: '',
    recurrence_count: 10,
  }
  if (!rrule) return out
  const params = new Map<string, string>()
  for (const part of rrule.split(';')) {
    const [key, val] = part.split('=')
    if (key && val) params.set(key, val)
  }
  const freq = params.get('FREQ')
  if (freq === 'DAILY') out.recurrence_type = 'daily'
  else if (freq === 'WEEKLY') out.recurrence_type = 'weekly'
  else if (freq === 'MONTHLY') out.recurrence_type = 'monthly'
  else return out
  const byday = params.get('BYDAY')
  if (byday) out.recurrence_days = byday.split(',').map(d => RRULE_DAY_CODES.indexOf(d)).filter(i => i >= 0)
  const count = params.get('COUNT')
  if (count) { out.recurrence_end_type = 'count'; out.recurrence_count = parseInt(count, 10) || 10 }
  const until = params.get('UNTIL')
  if (until) {
    out.recurrence_end_type = 'date'
    // UTC 순간이면 일정 시간대의 날짜로(서버가 "직전 1초"로 끊은 UNTIL 이 UTC 날짜로 하루 어긋나지 않게)
    const at = /T\d{6}Z$/.test(until) ? rruleUntilInstant(`UNTIL=${until}`) : null
    out.recurrence_end_date = at && tz ? ymdInZone(at, tz) : `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
  }
  return out
}

const ymdText = (y: { year: number; month: number; date: number }) => `${y.year}-${String(y.month + 1).padStart(2, '0')}-${String(y.date).padStart(2, '0')}`

/** 시각 입력 칸 묶음 — tz 기준 벽시계로 채운다. 종일은 저장된 날짜 그대로(시간대 변환 없음) */
function rangeToFields(s: Date, e: Date, allDay: boolean, tz: string): Pick<EventForm, 'all_day' | 'date' | 'endDate' | 'startTime' | 'endTime'> {
  if (allDay) {
    // 종일은 끝이 "다음날 00:00"(배타) — 폼에는 마지막 날을 보여 준다
    const date = ymdText(allDayYmd(s))
    const endExcl = ymdText(allDayYmd(e))
    const last = ymdAdd(endExcl, -1)
    return { all_day: true, date, endDate: last < date ? date : last, startTime: '09:00', endTime: '10:00' }
  }
  // 시각 일정은 고른 시간대의 벽시계로 보여 준다
  const a = dateToZoned(s, tz), b = dateToZoned(e, tz)
  return { all_day: false, date: a.date, startTime: a.time, endDate: b.date < a.date ? a.date : b.date, endTime: b.time }
}

/** 저장할 [start, end] — 종일은 [시작일, 마지막날+1) 의 UTC 00:00(날짜만, 시간대 변환 없음) */
function rangeOf(form: EventForm): { start: Date; end: Date } | null {
  if (form.all_day) {
    const s = allDayIsoFromInput(form.date), e = allDayIsoFromInput(form.endDate || form.date, 1)
    if (!s || !e) return null
    return { start: new Date(s), end: new Date(e) }
  }
  const s = zonedToDate(form.date, form.startTime, form.timezone)
  let e = zonedToDate(form.endDate || form.date, form.endTime, form.timezone)
  if (!s || !e) return null
  // 같은 날 끝 시각이 시작보다 이르면 다음날로 넘어가는 일정으로 본다(23:00–01:00)
  if (form.endDate === form.date && e <= s) e = zonedToDate(ymdAdd(form.date, 1), form.endTime, form.timezone) ?? e
  return { start: s, end: e }
}

function is409(e: any) { return e?.statusCode === 409 || e?.status === 409 || e?.response?.status === 409 }

const fieldLabel = 'text-xs font-semibold text-muted-foreground'
const boxInput = 'h-10 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-hidden transition-[box-shadow,border-color] focus:border-ring focus:ring-2 focus:ring-ring/35'

/** 일정 만들기·고치기 폼(showEventModal 일 때 열린다) */
export function CalendarEventModal() {
  const {
    calendars, showEventModal, editingEvent,
    createEvent, updateEventScoped, deleteEventScoped, closeModal,
  } = useCalendar()
  const { user } = useAuth()
  const { t, tm, rt } = useI18n()

  const [form, setForm] = useState<EventForm>(initialForm)
  const upd = (patch: Partial<EventForm>) => setForm(f => ({ ...f, ...patch }))
  const formRef = useRef(form)
  formRef.current = form
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [scopeFor, setScopeFor] = useState<'edit' | 'delete' | null>(null)
  const [conflicts, setConflicts] = useState<Record<string, { start: Date; end: Date } | null>>({})

  const raw = (tm('calendar.weekdaysShort') as any[]).map(m => rt(m))
  const weekdayLabels = [...raw.slice(1), raw[0]] // [월 … 일]

  const writableCalendars = calendars.filter(c => c.can_write !== false)
  const calendarOptions = writableCalendars.map(c => ({ value: c.id, label: c.name, swatch: eventBar(c.color) }))

  const isEditing = !!editingEvent
  const isRecurringEdit = !!editingEvent && !!(editingEvent.is_recurring || editingEvent.is_occurrence)
  const modalTitle = isEditing ? t('calendar.event.editTitle') : t('calendar.event.createTitle')

  const recurrenceOptions = [
    { value: 'none', label: t('calendar.recurrence.none') },
    { value: 'daily', label: t('calendar.recurrence.daily') },
    { value: 'weekly', label: t('calendar.recurrence.weekly') },
    { value: 'monthly', label: t('calendar.recurrence.monthly') },
  ]
  const recurrenceEndOptions = [
    { value: 'never', label: t('calendar.recurrence.endNever') },
    { value: 'date', label: t('calendar.recurrence.endOnDate') },
    { value: 'count', label: t('calendar.recurrence.endAfterCount') },
  ]
  // UiSelect 는 null 을 "선택 안 함"으로 쓰므로 알림 없음은 '' 로 주고받는다
  const reminderOptions = [
    { value: '', label: t('calendar.reminder.none') },
    { value: 0, label: t('calendar.reminder.atStart') },
    { value: 5, label: t('calendar.reminder.minutesBefore', { n: 5 }) },
    // 설정 › 캘린더 "기본 알림"의 10분 전도 고를 수 있게
    { value: 10, label: t('calendar.reminder.minutesBefore', { n: 10 }) },
    { value: 15, label: t('calendar.reminder.minutesBefore', { n: 15 }) },
    { value: 30, label: t('calendar.reminder.minutesBefore', { n: 30 }) },
    { value: 60, label: t('calendar.reminder.hourBefore') },
    { value: 1440, label: t('calendar.reminder.dayBefore') },
  ]
  const reminderModel = form.reminder_minutes ?? ''
  function setReminder(v: string | number | null) { upd({ reminder_minutes: v === '' || v === null ? null : Number(v) }) }

  // 설정 › 표시와 같은 목록 · 같은 찾기 규칙. 모바일은 UiSelect 가 OS 선택기로 그린다(찾기 칸 없음)
  const tzOptions = useMemo(() => {
    return tzZoneNames(form.timezone).map(z => ({ value: z, label: `${z.replace(/_/g, ' ')} (${tzGmtLabel(z)})` }))
  }, [form.timezone])
  const tzSearch = useMemo(() => tzSelectSearch(t), [t])
  function setTz(v: string | number | null) { if (v) upd({ timezone: String(v) }) }

  // 편집 중인 일정의 원래 반복 규칙과, 그 규칙을 폼으로 옮겼다 다시 만든 값
  const origRecur = useRef<{ rule: string; built: string | null } | null>(null)

  // watch(showEventModal) — 열릴 때 폼을 채운다(immediate 아님)
  const firstShow = useRef(true)
  useEffect(() => {
    if (firstShow.current) { firstShow.current = false; return }
    if (!showEventModal) { setScopeFor(null); return }
    setError('')
    setSubmitting(false)
    setConflicts({})
    const st = calendarStore.getState()
    const e = st.editingEvent
    if (e) {
      const tz = e.timezone || calendarZone()
      setForm(f => ({
        ...f,
        meeting_auto: false,
        calendar_id: e.calendar_id,
        title: e.title,
        description: e.description || '',
        location: e.location || '',
        timezone: tz,
        meeting_url: e.meeting_url || '',
        attendees: (e.attendees || []).map(a => ({ email: a.email, name: a.name, user_id: a.user_id, response: a.response })),
        ...rangeToFields(new Date(e.start), new Date(e.end), e.all_day, tz),
        reminder_minutes: e.reminder_minutes,
        ...parseRRuleToForm(e.recurrence_rule, tz),
      }))
      // 반복 칸을 건드리지 않고 저장하면 원래 규칙 문자열을 그대로 보낸다 — 폼(날짜 단위)으로 다시 만들면
      // 서버가 "이후 모두 삭제"로 끊은 UNTIL(직전 1초)이 그날 23:59:59 로 늘어나 지운 회차가 되살아났다.
      {
        const filled: EventForm = { ...initialForm(), ...rangeToFields(new Date(e.start), new Date(e.end), e.all_day, tz), timezone: tz, ...parseRRuleToForm(e.recurrence_rule, tz) }
        origRecur.current = e.recurrence_rule ? { rule: e.recurrence_rule, built: buildRRule(filled) } : null
      }
      setShowMore(!!(e.location || e.description || e.recurrence_rule || e.reminder_minutes != null
        || (e.timezone && e.timezone !== calendarZone())))
    } else {
      // 캘린더 시간대 기준 — 고른 날의 00:00 이면 09:00 으로
      const sel = new Date(st.selectedDate)
      const sp = zp(sel)
      // 분 단위가 남아 있으면(사이드바 [새 일정] = 페이지를 연 시각) 다음 30분으로 올린다
      const start = sp.hours === 0 && sp.minutes === 0
        ? zAtTime(sel, 9)
        : (sp.minutes % 30 || sp.seconds) ? zDate(sp.year, sp.month, sp.date, sp.hours, Math.ceil((sp.minutes + (sp.seconds ? 1 : 0)) / 30) * 30) : sel
      const p = zp(start)
      const end = zDate(p.year, p.month, p.date, p.hours + 1, p.minutes)
      const writable = st.calendars.filter(c => c.can_write !== false)
      // 연락처 "일정 잡기"가 그 사람을 참석자로 넘긴다
      const pe = st.eventPreset?.attendeeEmail?.trim().toLowerCase()
      // 설정 › 캘린더: 시간대(= 캘린더 시간대, 비우면 기기) · 기본 알림
      const { calendarDefaultReminder } = userPrefsStore.getState().prefs
      const tz = calendarZone()
      setForm(f => ({
        ...f,
        meeting_auto: false,
        calendar_id: writable[0]?.id || '',
        title: st.eventPreset?.title || '',
        description: '',
        location: '',
        timezone: tz,
        meeting_url: '',
        attendees: pe ? [{ email: pe, name: st.eventPreset?.attendeeName || null }] : [],
        ...rangeToFields(start, end, false, tz),
        reminder_minutes: calendarDefaultReminder,
        ...parseRRuleToForm(null),
      }))
      origRecur.current = null
      setShowMore(false)
    }
  }, [showEventModal])

  // 시작 날짜를 바꾸면 끝 날짜도 같이 민다(끝이 시작보다 앞서지 않게).
  // 사용자가 시작 날짜 칸을 바꿀 때만 — 모달을 열며 폼을 채울 때(다른 일정·새 일정)는 밀지 않는다.
  // (예전엔 form.date 변화를 effect 로 봐서, 직전에 연 일정과의 날짜 차이만큼 끝 날짜가 밀려 저장됐다.)
  function setStartDate(d: string) {
    setForm((f) => {
      const prev = f.date
      if (!d || !prev || d === prev || !f.endDate) return { ...f, date: d }
      const n = ymdDiff(prev, d)
      return { ...f, date: d, endDate: Number.isFinite(n) ? ymdAdd(f.endDate, n) : f.endDate }
    })
  }

  const range = useMemo(() => rangeOf(form), [form])
  const multiDayTimed = !form.all_day && !!form.endDate && form.endDate !== form.date

  const durationText = (() => {
    if (!range || form.all_day) return ''
    const { h, m } = durationParts(range.start.getTime(), range.end.getTime())
    if (h && m) return t('calendar.form.durationHM', { h, m })
    if (h) return t('calendar.form.durationH', { h })
    return t('calendar.form.durationM', { m })
  })()

  // ── 겹침 경고(free/busy) ──
  const availability: Record<string, 'free' | 'busy'> = {}
  for (const [email, c] of Object.entries(conflicts)) availability[email] = c ? 'busy' : 'free'

  const fbTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fbSeq = useRef(0)
  const emailsKey = form.attendees.map(a => a.email).join(',')
  const rStart = range?.start.getTime(), rEnd = range?.end.getTime()
  useEffect(() => {
    if (fbTimer.current) clearTimeout(fbTimer.current)
    if (!showEventModal) return
    const r = rStart !== undefined && rEnd !== undefined ? { start: new Date(rStart), end: new Date(rEnd) } : null
    const emails = formRef.current.attendees.map(a => a.email.toLowerCase())
    // 서버 조회 한도 62일 — 그보다 긴 일정은 겹침을 보지 않는다
    if (!r || !emails.length || r.end <= r.start || r.end.getTime() - r.start.getTime() > 60 * 86400000) { setConflicts({}); return }
    fbTimer.current = setTimeout(async () => {
      const my = ++fbSeq.current
      try {
        const res = await $fetch<{ users: { email: string; known: boolean; busy: BusyInterval[]; tentative: BusyInterval[] }[] }>(
          '/api/calendar/freebusy', { params: { emails: emails.join(','), start: r.start.toISOString(), end: r.end.toISOString() } })
        if (my !== fbSeq.current) return
        /** 수정 중인 이 일정 자신(참석자 바쁜 구간에 섞여 있다) — 겹침에서 뺀다 */
        const ed = calendarStore.getState().editingEvent
        const ownRange = ed ? { start: new Date(ed.start), end: new Date(ed.end) } : null
        const out: Record<string, { start: Date; end: Date } | null> = {}
        for (const u of res.users) {
          if (!u.known) continue
          out[u.email.toLowerCase()] = firstConflict(u.busy, r.start, r.end, ownRange)
        }
        setConflicts(out)
      } catch { if (my === fbSeq.current) setConflicts({}) }
    }, 400)
  }, [showEventModal, emailsKey, rStart, rEnd])
  useEffect(() => () => { if (fbTimer.current) clearTimeout(fbTimer.current) }, [])

  const conflictText = (() => {
    const busy = form.attendees.filter(a => conflicts[a.email.toLowerCase()])
    if (!busy.length) return ''
    const first = busy[0]
    const c = conflicts[first.email.toLowerCase()]!
    const s = dateToZoned(c.start, form.timezone).time, e = dateToZoned(c.end, form.timezone).time
    const name = first.name || first.email
    return busy.length > 1
      ? t('calendar.form.conflictMany', { name, s, e, n: busy.length - 1 })
      : t('calendar.form.conflictOne', { name, s, e })
  })()

  /** 새로 초대하는 사람이 있으면 저장 버튼이 "저장하고 초대 보내기" */
  const hasNewInvitees = (() => {
    const before = new Set((editingEvent?.attendees || []).map(a => a.email.toLowerCase()))
    return form.attendees.some(a => !before.has(a.email.toLowerCase()))
  })()

  const tzLabel = tzGmtLabel(form.timezone)
  const meetingLabel = (() => {
    const u = form.meeting_url.trim()
    if (!u) return ''
    try { const x = new URL(u); return x.pathname.split('/').filter(Boolean).pop() || x.host } catch { return u }
  })()

  /** "링크 자동 생성" — 예약 회의를 만들고 참여 링크를 돌려준다. 같은 이름의 회의가 있으면 날짜를 붙여 한 번 더 */
  async function createMeetingLink(f: EventForm, r: { start: Date; end: Date }): Promise<string> {
    const minutes = Math.max(15, Math.min(24 * 60, Math.round((r.end.getTime() - r.start.getTime()) / 60000)))
    const base = f.title.trim().slice(0, 80)
    const stamp = dateToZoned(r.start, f.timezone)
    const names = [base, `${base} ${stamp.date.slice(5)} ${stamp.time}`]
    let lastErr: any = null
    for (const name of names) {
      try {
        const room = await $fetch<{ share_token: string; meeting_id?: string | null }>('/api/meetings/rooms', {
          method: 'POST',
          body: {
            name,
            scheduled_at: f.all_day ? null : r.start.toISOString(),
            duration_minutes: f.all_day ? 60 : minutes,
            description: f.description.trim() || null,
            // 일정은 이 폼이 만든다 — 회의 쪽에서 캘린더 일정을 또 만들지 않게
            add_to_calendar: false,
            invitees: [],
          },
        })
        if (room.meeting_id) {
          try {
            const d = await $fetch<{ join_url: string }>(`/api/meetings/by-id/${room.meeting_id}`)
            if (d.join_url) return d.join_url
          } catch { /* 아래 기본 주소 */ }
        }
        return `${window.location.origin}/meetings/join/${room.share_token}`
      } catch (e: any) {
        lastErr = e
        if (!is409(e)) break
      }
    }
    throw lastErr
  }

  function recurrenceFields(f: EventForm): { recurrence_rule: string | null; recurrence_end: string | null } {
    const built = buildRRule(f)
    const o = origRecur.current
    if (o && built === o.built) {
      return { recurrence_rule: o.rule, recurrence_end: rruleUntilInstant(o.rule)?.toISOString() ?? null }
    }
    return {
      recurrence_rule: built,
      recurrence_end: (f.recurrence_type !== 'none' && f.recurrence_end_type === 'date' && f.recurrence_end_date)
        ? (untilInstant(f)?.toISOString() ?? null)
        : null,
    }
  }

  function payload(f: EventForm) {
    const r = rangeOf(f)!
    return {
      calendar_id: f.calendar_id,
      title: f.title.trim(),
      // 비운 값도 보낸다("" = 지움) — undefined 로 빼면 수정에서 설명·장소가 지워지지 않았다
      description: f.description.trim(),
      location: f.location.trim(),
      start: r.start.toISOString(),
      end: r.end.toISOString(),
      all_day: f.all_day,
      reminder_minutes: f.reminder_minutes,
      ...recurrenceFields(f),
      timezone: f.timezone,
      meeting_url: f.meeting_url.trim(),
      attendees: f.attendees.map(a => ({ email: a.email, name: a.name || null })),
    }
  }

  function validate(): boolean {
    const f = formRef.current
    const r = rangeOf(f)
    if (!f.title.trim()) { setError(t('calendar.event.titleRequired')); return false }
    if (!f.calendar_id) { setError(t('calendar.event.calendarRequired')); return false }
    if (!r) { setError(t('calendar.event.timeRequired')); return false }
    if (r.end <= r.start) { setError(t('calendar.form.endBeforeStart')); return false }
    return true
  }

  const submittingRef = useRef(false)
  async function save(scope: DeleteScope = 'all') {
    submittingRef.current = true
    setSubmitting(true)
    setError('')
    let f = formRef.current
    try {
      if (f.meeting_auto && !f.meeting_url.trim()) {
        try {
          const url = await createMeetingLink(f, rangeOf(f)!)
          f = { ...f, meeting_url: url, meeting_auto: false }
          formRef.current = f
          setForm(prev => ({ ...prev, meeting_url: url }))
        } catch (e: any) {
          setError(is409(e)
            ? t('calendar.form.meetingNameTaken')
            : ((typeof e?.data?.detail === 'string' && e.data.detail) || t('calendar.form.meetingCreateError')))
          return
        }
        setForm(prev => ({ ...prev, meeting_auto: false }))
      }
      const body = payload(f)
      const ed = calendarStore.getState().editingEvent
      if (ed) await updateEventScoped(ed, body, scope)
      else {
        // 새 일정: 빈 값은 보내지 않는다
        const { meeting_url, attendees, ...rest } = body
        await createEvent({ ...rest, ...(meeting_url ? { meeting_url } : {}), ...(attendees.length ? { attendees } : {}) })
      }
      closeModal()
    } catch (e: any) {
      setError((typeof e?.data?.detail === 'string' && e.data.detail) || t('calendar.event.saveError'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  function handleSubmit(e?: FormEvent) {
    e?.preventDefault()
    if (submittingRef.current || !validate()) return
    if (isRecurringEdit) { setScopeFor('edit'); return }
    save('all')
  }

  async function handleDelete() {
    const ev = calendarStore.getState().editingEvent
    if (!ev) return
    // 예외 회차(이 일정만 수정한 행)도 범위를 묻는다 — 확인만 받고 지우면 시리즈 전체가 지워졌다
    if (ev.is_recurring || ev.is_occurrence || ev.is_exception) { setScopeFor('delete'); return }
    if (!await confirmBox(t('calendar.event.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') })) return
    await doDelete('all')
  }

  async function doDelete(scope: DeleteScope, notify = false) {
    const ev = calendarStore.getState().editingEvent
    if (!ev) return
    try {
      const n = await deleteEventScoped(ev, scope, { notify })
      closeModal()
      if (n) addToast('success', t('calendar.scope.notified', { n }))
    } catch { addToast('error', t('calendar.event.deleteError')) }
  }

  function onScope(scope: DeleteScope, notify = false) {
    const kind = scopeFor
    setScopeFor(null)
    if (kind === 'edit') save(scope)
    else if (kind === 'delete') doDelete(scope, notify)
  }

  function toggleDay(i: number) {
    setForm((f) => {
      const k = f.recurrence_days.indexOf(i)
      return { ...f, recurrence_days: k === -1 ? [...f.recurrence_days, i] : f.recurrence_days.filter((_, j) => j !== k) }
    })
  }

  return (
    <>
      {showEventModal && (
        <UiModal
          title={modalTitle}
          size="520"
          onClose={closeModal}
          footer={(
            <>
              {isEditing && (
                <UiButton variant="ghost" size="sm" className="mr-auto text-danger hover:bg-danger/10 hover:text-danger" onClick={handleDelete}>
                  {t('common.delete')}
                </UiButton>
              )}
              <UiButton variant="outline" size="sm" onClick={closeModal}>{t('common.cancel')}</UiButton>
              <UiButton type="submit" form="cal-event-form" size="sm" className="font-semibold" disabled={submitting}>
                {submitting ? t('common.saving') : hasNewInvitees ? t('calendar.form.saveAndInvite') : t('common.save')}
              </UiButton>
            </>
          )}
        >
          <form id="cal-event-form" className="flex flex-col gap-3.5" noValidate onSubmit={handleSubmit}>
            {/* 제목 */}
            <UiInput
              modelValue={form.title}
              onUpdateModelValue={v => upd({ title: v })}
              size="lg"
              aria-label={t('calendar.event.titleLabel')}
              placeholder={t('calendar.event.titlePlaceholder')}
              inputClass="text-base font-semibold"
              data-autofocus
            />

            {/* 시간 */}
            <div className="flex flex-col gap-1.5">
              <span id="cal-form-time" className={fieldLabel}>{t('calendar.form.time')}</span>
              <div className="flex flex-wrap items-center gap-2 text-[13px]" role="group" aria-labelledby="cal-form-time">
                <input value={form.date} onChange={e => setStartDate(e.target.value)} type="date" className={boxInput} aria-label={t('calendar.event.startLabel')} />
                {!form.all_day
                  ? (
                    <>
                      <input value={form.startTime} onChange={e => upd({ startTime: e.target.value })} type="time" className={cn(boxInput, 'font-mono')} aria-label={t('calendar.form.startTime')} />
                      <span aria-hidden="true">–</span>
                      {multiDayTimed && <input value={form.endDate} onChange={e => upd({ endDate: e.target.value })} type="date" className={boxInput} aria-label={t('calendar.event.endLabel')} />}
                      <input value={form.endTime} onChange={e => upd({ endTime: e.target.value })} type="time" className={cn(boxInput, 'font-mono')} aria-label={t('calendar.form.endTime')} />
                      {durationText && <span className="text-xs text-muted-foreground">{durationText}</span>}
                    </>
                  )
                  : (
                    <>
                      <span aria-hidden="true">–</span>
                      <input value={form.endDate} onChange={e => upd({ endDate: e.target.value })} type="date" className={boxInput} aria-label={t('calendar.event.endLabel')} />
                    </>
                  )}
                <span className="flex-1" />
                <UiSwitch modelValue={form.all_day} onUpdateModelValue={v => upd({ all_day: v })} label={t('calendar.allDay')} />
              </div>
            </div>

            {/* 캘린더 · 화상 회의 */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t('calendar.event.calendarLabel')}</span>
                <UiSelect modelValue={form.calendar_id} onUpdateModelValue={v => upd({ calendar_id: String(v ?? '') })} options={calendarOptions} aria-label={t('calendar.event.calendarLabel')} className="min-w-0" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={fieldLabel}>{t('calendar.form.meeting')}</span>
                {form.meeting_url.trim()
                  ? (
                    <div className="flex h-10 items-center gap-2 rounded-md border border-input bg-background pl-3 pr-0.5 text-[13px]">
                      <UiIcon name="video" className="h-[15px] w-[15px] shrink-0 text-muted-foreground" />
                      <a href={form.meeting_url} target="_blank" rel="noopener" className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline" title={form.meeting_url}>{meetingLabel}</a>
                      <UiIconButton label={t('calendar.form.meetingRemove')} icon="close" onClick={() => upd({ meeting_url: '' })} />
                    </div>
                  )
                  : (
                    <div className="flex h-10 items-center gap-2 rounded-md border border-input bg-background px-3 text-[13px]">
                      <UiSwitch modelValue={form.meeting_auto} onUpdateModelValue={v => upd({ meeting_auto: v })} label={t('calendar.form.meetingAuto')} labelFirst={false} className="min-w-0 flex-1" />
                    </div>
                  )}
              </div>
            </div>

            {/* 참석자 + 겹침 경고 */}
            <div className="flex flex-col gap-1.5">
              <span id="cal-form-attendees" className={fieldLabel}>{t('calendar.form.attendees')}</span>
              <CalendarAttendeesInput
                modelValue={form.attendees}
                onUpdateModelValue={v => upd({ attendees: v })}
                availability={availability}
                excludeEmail={user?.email}
                labelledby="cal-form-attendees"
              />
              {conflictText && <span className="text-xs text-warning" role="status">{conflictText}</span>}
            </div>

            {/* 자세히 */}
            <button
              type="button"
              className="flex items-center gap-2 self-start rounded-sm text-[13px] font-semibold text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={showMore}
              aria-controls="cal-form-more"
              onClick={() => setShowMore(!showMore)}
            >
              {t('calendar.form.more')}
              <UiIcon name={showMore ? 'chevron-up' : 'chevron-down'} className="h-3.5 w-3.5" />
              {!showMore && <span className="font-normal text-muted-foreground">{t('calendar.form.moreHint')}</span>}
            </button>

            {showMore && (
              <div id="cal-form-more" className="flex flex-col gap-3.5">
                <UiInput modelValue={form.location} onUpdateModelValue={v => upd({ location: v })} label={t('calendar.event.locationLabel')} placeholder={t('calendar.event.locationPlaceholder')} />
                <UiInput modelValue={form.meeting_url} onUpdateModelValue={v => upd({ meeting_url: v })} type="url" mono label={t('calendar.form.meetingUrl')} placeholder={t('calendar.form.meetingUrlPlaceholder')} />

                <div className="flex flex-col gap-2">
                  <UiSelect modelValue={form.recurrence_type} onUpdateModelValue={v => upd({ recurrence_type: v as EventForm['recurrence_type'] })} options={recurrenceOptions} label={t('calendar.recurrence.label')} />
                  {form.recurrence_type === 'weekly' && (
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('calendar.recurrence.label')}>
                      {weekdayLabels.map((label, idx) => (
                        <UiChip
                          key={idx}
                          modelValue={form.recurrence_days.includes(idx)}
                          label={label}
                          size="sm"
                          surface="raised"
                          onClick={() => toggleDay(idx)}
                        />
                      ))}
                    </div>
                  )}
                  {form.recurrence_type !== 'none' && (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <UiSelect modelValue={form.recurrence_end_type} onUpdateModelValue={v => upd({ recurrence_end_type: v as EventForm['recurrence_end_type'] })} options={recurrenceEndOptions} aria-label={t('calendar.recurrence.endLabel')} />
                      {form.recurrence_end_type === 'date'
                        ? (
                          <input
                            value={form.recurrence_end_date}
                            onChange={e => upd({ recurrence_end_date: e.target.value })}
                            type="date"
                            className={boxInput}
                            aria-label={t('calendar.recurrence.endOnDate')}
                          />
                        )
                        : form.recurrence_end_type === 'count'
                          ? (
                            <div className="flex items-center gap-2">
                              <input
                                value={Number.isNaN(form.recurrence_count) ? '' : form.recurrence_count}
                                onChange={(e) => {
                                  // v-model.number: 숫자로 읽히면 숫자, 아니면 글자 그대로(빈 칸 = '')
                                  const n = parseFloat(e.target.value)
                                  upd({ recurrence_count: Number.isNaN(n) ? (e.target.value as unknown as number) : n })
                                }}
                                type="number"
                                min="1"
                                max="365"
                                className={cn(boxInput, 'w-20 font-mono')}
                                aria-label={t('calendar.recurrence.endAfterCount')}
                              />
                              <span className="text-[13px] text-muted-foreground">{t('calendar.recurrence.occurrences')}</span>
                            </div>
                          )
                          : null}
                    </div>
                  )}
                </div>

                <UiSelect modelValue={reminderModel} onUpdateModelValue={setReminder} options={reminderOptions} label={t('calendar.reminder.label')} />
                <UiTextarea modelValue={form.description} onUpdateModelValue={v => upd({ description: v })} rows={3} label={t('calendar.event.descriptionLabel')} placeholder={t('calendar.event.descriptionPlaceholder')} />

                {/* 시간대: 위 시각을 이 시간대의 시각으로 읽어 저장 */}
                <UiSelect
                  modelValue={form.timezone}
                  onUpdateModelValue={setTz}
                  options={tzOptions}
                  search={tzSearch}
                  label={t('calendar.form.timezone')}
                  hint={t('calendar.form.timezoneHint', { gmt: tzLabel })}
                />
              </div>
            )}

            {error && (
              <p role="alert" className="flex items-center gap-1.5 text-xs text-danger">
                <UiIcon name="alert-circle" className="h-3.5 w-3.5 shrink-0" />{error}
              </p>
            )}
          </form>
        </UiModal>
      )}

      {scopeFor && editingEvent && (
        <CalendarScopeModal
          mode={scopeFor}
          isOccurrence={!!editingEvent.is_occurrence}
          event={editingEvent}
          myEmail={user?.email}
          onClose={() => setScopeFor(null)}
          onConfirm={onScope}
        />
      )}
    </>
  )
}

export default CalendarEventModal
