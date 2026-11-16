/**
 * 캘린더 순수 계산 함수 모음(컴포넌트·테스트 공용).
 *
 * - 주 시작 요일(설정›표시 → 로케일 기본)
 * - 주·일 보기 절대 배치: 겹치는 일정을 열(column)로 분할한다
 * - 반복 일정 "이후 모두 삭제" = RRULE 의 UNTIL 을 해당 회차 직전으로 변경
 * - 일정 색 → 범주 토큰(--cat-N) 바탕 /0.2 + 3px 바. 규칙은 utils/categoryColor
 * - 날짜·시각 함수(startOfDay·addDays·isSameDay·startOfWeek·overlapsDay·fmtTime·toDateInput·toTimeInput·fromInputs)는
 *   전부 **캘린더 시간대**(utils/calTz — 설정 시간대, 빈 값 = 기기) 벽시계 기준이다. 기기 시간대 getter 직접 사용 금지.
 */

import { catColor } from './categoryColor'
import {
  calendarZone, zAddDays, zDate, zDateInput, zFmtTime, zFromInputs, zIsSameDay, zp, zStartOfDay,
} from './calTz'
import { tzGmtLabel } from './calendarAttendees'

export type WeekStartPref = 'locale' | 'mon' | 'sun' | 'sat'
/** 0 = 일요일, 1 = 월요일, 6 = 토요일(설정 › 캘린더 "주 시작 요일") */
export type WeekStartDay = 0 | 1 | 6

/** 0 = 일요일, 1 = 월요일 */
export function resolveWeekStart(pref: WeekStartPref, locale: string): WeekStartDay {
  if (pref === 'sat') return 6
  if (pref === 'mon') return 1
  if (pref === 'sun') return 0
  try {
    const L: any = (Intl as any).Locale ? new (Intl as any).Locale(locale) : null
    const info = L?.weekInfo ?? (typeof L?.getWeekInfo === 'function' ? L.getWeekInfo() : null)
    const first = info?.firstDay
    if (first === 7) return 0
    if (first === 1) return 1
  } catch { /* Intl.Locale 미지원 */ }
  return 0
}

/** 그날 00:00(캘린더 시간대) */
export function startOfDay(d: Date): Date {
  return zStartOfDay(d)
}

/** n일 뒤 같은 벽시계 시각(캘린더 시간대, 서머타임 전환일에도 24시간 가산이 아님) */
export function addDays(d: Date, n: number): Date {
  return zAddDays(d, n)
}

export function isSameDay(a: Date, b: Date): boolean {
  return zIsSameDay(a, b)
}

/** 주 시작일 00:00 */
export function startOfWeek(d: Date, weekStart: WeekStartDay): Date {
  const s = startOfDay(d)
  const diff = (zp(s).day - weekStart + 7) % 7
  return addDays(s, -diff)
}

/** [day 00:00, 다음날 00:00) 과의 겹침 여부 */
export function overlapsDay(start: Date, end: Date, day: Date): boolean {
  const ds = startOfDay(day)
  const de = addDays(ds, 1)
  return start < de && end > ds
}

export interface LayoutItem { id: string; start: number; end: number }
export interface LayoutBox { id: string; col: number; cols: number }

/** 겹침 배치에서 매우 짧은 일정에도 적용하는 최소 길이(ms) */
const MIN_SPAN = 15 * 60 * 1000

/**
 * 같은 날의 일정을 겹침 묶음(cluster)으로 분할하고, 묶음 내에서 열을 배정한다.
 * 결과의 col/cols 로 left = col/cols, width = 1/cols 를 계산한다.
 */
export function layoutOverlaps(items: LayoutItem[]): LayoutBox[] {
  const sorted = items
    .map(i => ({ ...i, end: Math.max(i.end, i.start + MIN_SPAN) }))
    .sort((a, b) => a.start - b.start || b.end - a.end)

  const out: LayoutBox[] = []
  let cluster: { id: string; col: number }[] = []
  let colEnds: number[] = []
  let clusterEnd = -Infinity

  const flush = () => {
    const cols = Math.max(1, colEnds.length)
    for (const c of cluster) out.push({ id: c.id, col: c.col, cols })
    cluster = []
    colEnds = []
  }

  for (const it of sorted) {
    if (it.start >= clusterEnd) {
      flush()
      clusterEnd = it.end
    } else {
      clusterEnd = Math.max(clusterEnd, it.end)
    }
    let col = colEnds.findIndex(e => e <= it.start)
    if (col === -1) { col = colEnds.length; colEnds.push(it.end) }
    else colEnds[col] = it.end
    cluster.push({ id: it.id, col })
  }
  flush()
  return out
}

function pad(n: number) { return String(n).padStart(2, '0') }

/** RRULE 의 UNTIL(UTC) 형식 */
export function toRRuleUtc(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

/**
 * "이후 모두 삭제": 해당 회차 시작 1초 전을 UNTIL 로 설정하고 COUNT 는 제거한다.
 * (백엔드에 회차 예외(EXDATE)가 없어 "이 일정만" 은 불가 — 백엔드 갭)
 */
export function rruleUntilBefore(rrule: string, occurrenceStart: Date): string {
  const until = new Date(occurrenceStart.getTime() - 1000)
  const parts = rrule.split(';').map(p => p.trim()).filter(Boolean)
    .filter(p => !/^(UNTIL|COUNT)=/i.test(p))
  parts.push(`UNTIL=${toRRuleUtc(until)}`)
  return parts.join(';')
}

/** 일정 블록 바탕: 범주 색 / 0.2. 범주이면 테마 토큰, 사용자 지정 hex 는 알파 적용, 없으면 primary */
export function eventBg(color: string | null | undefined, alpha = 0.2): string {
  return catColor(color, alpha)
}

/** 일정 블록 왼쪽 3px 바·색 견본 */
export function eventBar(color: string | null | undefined): string {
  return catColor(color)
}

/** "HH:MM"(캘린더 시간대) */
export function fmtTime(d: Date): string {
  return zFmtTime(d)
}

/** "1시간" · "30분" · "1시간 30분" (ko 기준 — 라벨 조각은 호출부가 i18n 으로 전달) */
export function durationParts(startMs: number, endMs: number): { h: number; m: number } {
  const mins = Math.max(0, Math.round((endMs - startMs) / 60000))
  return { h: Math.floor(mins / 60), m: mins % 60 }
}

/** 캘린더 시간대 오프셋 라벨: GMT+9 · GMT-5:30 */
export function gmtLabel(d = new Date()): string {
  return tzGmtLabel(calendarZone(), d)
}

// ── 반복 규칙 상한(서버 app/calendar/rrule_guard.py 와 동일 규칙) ──

/** 폼에서 선택 가능한 반복 주기 — 초·분 단위 없음 */
export const RECURRENCE_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const
/** 반복 횟수 입력 상한(폼 input max 와 동일) */
export const MAX_RECURRENCE_COUNT = 365

/** 반복 횟수 → 1..MAX_RECURRENCE_COUNT 정수(숫자가 아니면 null = 횟수 미지정) */
export function clampRecurrenceCount(n: unknown): number | null {
  const v = typeof n === 'number' ? n : parseInt(String(n ?? ''), 10)
  if (!Number.isFinite(v) || v < 1) return null
  return Math.min(MAX_RECURRENCE_COUNT, Math.floor(v))
}

/** 폼이 생성하는 주기만 RRULE FREQ 로 변환 — 그 밖은 null(반복 없음) */
export function safeRecurrenceFreq(type: string | null | undefined): typeof RECURRENCE_FREQS[number] | null {
  const f = String(type || '').toUpperCase()
  return (RECURRENCE_FREQS as readonly string[]).includes(f) ? f as typeof RECURRENCE_FREQS[number] : null
}

// ── 반복 규칙 요약(읽기 팝오버 "매주 목요일") ──

const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

export interface RRuleSummary {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | null
  interval: number
  /** 0 = 일요일 … 6 = 토요일 */
  byday: number[]
  count: number | null
  until: Date | null
}

export function parseRRule(rule: string | null | undefined): RRuleSummary | null {
  if (!rule) return null
  const map = new Map<string, string>()
  for (const part of rule.replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = part.split('=')
    if (k && v) map.set(k.trim().toUpperCase(), v.trim())
  }
  const f = map.get('FREQ')?.toUpperCase()
  const freq = f === 'DAILY' || f === 'WEEKLY' || f === 'MONTHLY' || f === 'YEARLY' ? f : null
  const byday = (map.get('BYDAY') || '').split(',')
    .map(d => RRULE_DAYS.indexOf(d.replace(/^[+-]?\d+/, '').toUpperCase()))
    .filter(i => i >= 0)
  const u = map.get('UNTIL')
  let until: Date | null = null
  if (u) {
    const m = u.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/)
    if (m) {
      until = m[4]
        ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
        : zDate(+m[1], +m[2] - 1, +m[3])
    }
  }
  return {
    freq,
    interval: Math.max(1, parseInt(map.get('INTERVAL') || '1', 10) || 1),
    byday,
    count: map.has('COUNT') ? (parseInt(map.get('COUNT')!, 10) || null) : null,
    until,
  }
}

// ── 일정 폼: 날짜·시각 입력 ↔ Date ──

export function toDateInput(d: Date): string {
  return zDateInput(d)
}

export function toTimeInput(d: Date): string {
  return zFmtTime(d)
}

/** 'YYYY-MM-DD' + 'HH:MM' → 순간(캘린더 시간대 벽시계). 형식 불일치 시 null */
export function fromInputs(date: string, time = '00:00'): Date | null {
  return zFromInputs(date, time)
}

/**
 * 반복 일정을 회차에서 "전체" 로 수정할 때: 회차에서 이동한 만큼(시작 시각 차이) 마스터를 이동하고,
 * 길이는 새 길이로 설정한다. (이전에는 회차의 날짜가 그대로 마스터 시작이 되어 시리즈 첫날이 변경되었다.)
 */
export function shiftSeries(
  master: { start: Date; end: Date },
  occurrenceStart: Date,
  next: { start: Date; end: Date },
): { start: Date; end: Date } {
  const delta = next.start.getTime() - occurrenceStart.getTime()
  const start = new Date(master.start.getTime() + delta)
  const end = new Date(start.getTime() + Math.max(0, next.end.getTime() - next.start.getTime()))
  return { start, end }
}
