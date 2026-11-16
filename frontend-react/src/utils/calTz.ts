/**
 * 캘린더 시간대("일정은 ○○ 기준으로 보입니다" 문구와 실제 동작의 일치를 보장).
 *
 * 캘린더 화면 전체(주·일·월·목록·상세·편집·오늘 표시·현재 시각 선·대시보드 "오늘")는 **설정 시간대**
 * (설정 › 캘린더/표시 timezone, 빈 값 = 기기 시간대)의 벽시계 기준으로 표시한다. 기기 시간대(Date 의 getHours 등)는 사용하지 않는다.
 *
 * 규칙
 *  - 값은 항상 Date(= 순간)이다. "그날"·"그 시각"을 읽거나 생성할 때만 본 파일의 함수를 경유한다.
 *    읽기: zp(d).year·month(0~11)·date·day(요일 0=일)·hours·minutes  /  생성: zDate(y, m, d, h, mi)
 *  - 날짜 이동은 벽시계 기준(zAddDays: 서머타임 전환일에도 "다음날 같은 시각", 24시간 가산이 아님).
 *  - 종일 일정은 날짜만 의미한다 → 시간대 변환 없이 날짜를 그대로 사용(allDayYmd · eventRange).
 *    서버 규약(.ics/CalDAV)은 해당 날짜의 UTC 00:00. 이전 웹 화면이 기기 자정으로 저장한 행(예: 서울 = 전날 15:00Z)도
 *    가장 가까운 UTC 자정으로 읽어 동일한 날짜가 된다(UTC−12~+12 에서 정확).
 *  - 오프셋 계산은 Intl(IANA tz) — 15분 단위로 캐시하므로 주·월 보기에서 수천 회 호출되어도 부하가 작다.
 */
import { userPrefsStore } from '~/composables/useUserPrefs'

const DAY_MS = 86_400_000

let override: string | null = null

/** 기기(브라우저) 시간대 IANA 이름. 알 수 없으면 'UTC' */
export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

const validity = new Map<string, boolean>()
function validZone(tz: string): boolean {
  let ok = validity.get(tz)
  if (ok === undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = true } catch { ok = false }
    validity.set(tz, ok)
  }
  return ok
}

let deviceZone: string | null = null

/** 현재 캘린더가 사용하는 시간대 — 설정 시간대, 비어 있거나 유효하지 않으면 기기 시간대 */
export function calendarZone(): string {
  if (override) return override
  const pref = userPrefsStore.getState().prefs.timezone
  if (pref && validZone(pref)) return pref
  return deviceZone ?? (deviceZone = deviceTimeZone())
}

/** 테스트용 — 캘린더 시간대 강제 지정(null 이면 해제) */
export function _setCalendarZone(tz: string | null) { override = tz }

// ── 오프셋 ──

const fmts = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    fmts.set(tz, f)
  }
  return f
}

const BUCKET = 15 * 60_000
const cache = new Map<string, Map<number, number>>()

function computeOffset(ms: number, tz: string): number {
  const p: Record<string, number> = {}
  for (const part of fmt(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000) * 60_000
}

/** 그 순간 tz 의 UTC 오프셋(ms, 동쪽 +) */
export function zoneOffsetMs(ms: number, tz = calendarZone()): number {
  if (tz === 'UTC' || tz === 'Etc/UTC') return 0
  let byTz = cache.get(tz)
  if (!byTz) { byTz = new Map(); cache.set(tz, byTz) }
  const b = Math.floor(ms / BUCKET)
  let off = byTz.get(b)
  if (off === undefined) {
    // 버킷 시작 기준으로 계산한다(동일 버킷은 동일 값 — 전환은 15분 경계에서만 발생)
    off = computeOffset(b * BUCKET, tz)
    if (byTz.size > 50_000) byTz.clear()
    byTz.set(b, off)
  }
  return off
}

// ── 읽기 ──

export interface ZParts {
  year: number
  /** 0~11 */
  month: number
  /** 1~31 */
  date: number
  /** 요일 0=일 … 6=토 */
  day: number
  hours: number
  minutes: number
  seconds: number
}

/** 순간 → 캘린더 시간대 벽시계 */
export function zp(d: Date | number, tz = calendarZone()): ZParts {
  const ms = typeof d === 'number' ? d : d.getTime()
  const w = new Date(ms + zoneOffsetMs(ms, tz))
  return {
    year: w.getUTCFullYear(), month: w.getUTCMonth(), date: w.getUTCDate(), day: w.getUTCDay(),
    hours: w.getUTCHours(), minutes: w.getUTCMinutes(), seconds: w.getUTCSeconds(),
  }
}

/** 그날의 일 번호(1970-01-01 = 0) — 날짜 차이 계산용 */
export function zDayNumber(d: Date | number, tz = calendarZone()): number {
  const p = zp(d, tz)
  return Math.floor(Date.UTC(p.year, p.month, p.date) / DAY_MS)
}

/** 자정 이후 경과한 벽시계 분(0~1439) */
export function zMinutesOfDay(d: Date | number, tz = calendarZone()): number {
  const p = zp(d, tz)
  return p.hours * 60 + p.minutes
}

/** 현재(순간). 화면의 "오늘"·현재 시각 선은 이 값을 zp 로 읽는다 */
export function zNow(): Date { return new Date() }

// ── 생성 ──

/**
 * 캘린더 시간대 벽시계 → 순간. 범위를 벗어난 값은 Date 와 동일하게 정규화(월 12 → 다음해 1월, 일 0 → 전달 말일).
 * 서머타임으로 존재하지 않는 시각(봄 02:30)은 이후 시각으로 이동하고(03:30), 중복되는 시각(가을 01:30)은 앞선 쪽을 선택한다.
 */
export function zDate(year: number, month: number, date = 1, hours = 0, minutes = 0, seconds = 0, tz = calendarZone()): Date {
  const local = Date.UTC(year, month, date, hours, minutes, seconds)
  const before = zoneOffsetMs(local - DAY_MS, tz)
  const after = zoneOffsetMs(local + DAY_MS, tz)
  const cands = before === after ? [local - before] : [local - before, local - after].sort((a, b) => a - b)
  for (const c of cands) if (c + zoneOffsetMs(c, tz) === local) return new Date(c)
  // 존재하지 않는 시각(봄 전환) — 전환 전 오프셋으로 계산하면 벽시계가 이후 시각으로 이동한다
  return new Date(local - before)
}

/** 그날 00:00 */
export function zStartOfDay(d: Date, tz = calendarZone()): Date {
  const p = zp(d, tz)
  return zDate(p.year, p.month, p.date, 0, 0, 0, tz)
}

/** n일 뒤 같은 벽시계 시각(서머타임 전환일 포함) */
export function zAddDays(d: Date, n: number, tz = calendarZone()): Date {
  const p = zp(d, tz)
  return zDate(p.year, p.month, p.date + n, p.hours, p.minutes, p.seconds, tz)
}

/** n개월 뒤 같은 날·시각(Date.setMonth 와 같이 초과 시 다음달로 이월) */
export function zAddMonths(d: Date, n: number, tz = calendarZone()): Date {
  const p = zp(d, tz)
  return zDate(p.year, p.month + n, p.date, p.hours, p.minutes, p.seconds, tz)
}

/** 그날 h:mi */
export function zAtTime(d: Date, hours: number, minutes = 0, tz = calendarZone()): Date {
  const p = zp(d, tz)
  return zDate(p.year, p.month, p.date, hours, minutes, 0, tz)
}

export function zIsSameDay(a: Date, b: Date, tz = calendarZone()): boolean {
  const x = zp(a, tz), y = zp(b, tz)
  return x.year === y.year && x.month === y.month && x.date === y.date
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "HH:MM" */
export function zFmtTime(d: Date, tz = calendarZone()): string {
  const p = zp(d, tz)
  return `${pad(p.hours)}:${pad(p.minutes)}`
}

/** 'YYYY-MM-DD' */
export function zDateInput(d: Date, tz = calendarZone()): string {
  const p = zp(d, tz)
  return `${p.year}-${pad(p.month + 1)}-${pad(p.date)}`
}

/** 'YYYY-MM-DD' + 'HH:MM' → 순간. 형식 불일치 시 null */
export function zFromInputs(date: string, time = '00:00', tz = calendarZone()): Date | null {
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const tm = time.match(/^(\d{2}):(\d{2})$/)
  if (!dm || !tm) return null
  return zDate(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], 0, tz)
}

// ── 종일 일정(날짜만) ──

export interface Ymd { year: number; month: number; date: number }

/** 종일 일정의 저장 순간 → 날짜. 가장 가까운 UTC 자정의 날짜(시간대 변환 없음) */
export function allDayYmd(iso: string | Date): Ymd {
  const ms = typeof iso === 'string' ? Date.parse(iso) : iso.getTime()
  const d = new Date(Math.floor((ms + DAY_MS / 2) / DAY_MS) * DAY_MS)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate() }
}

/** 날짜 → 종일 일정 저장 값(그날 UTC 00:00, 서버·CalDAV 규약) */
export function allDayIso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m, d)).toISOString()
}

/** 'YYYY-MM-DD' → 종일 저장 값. 형식 불일치 시 null */
export function allDayIsoFromInput(date: string, addDays = 0): string | null {
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!dm) return null
  return allDayIso(+dm[1], +dm[2] - 1, +dm[3] + addDays)
}

const rangeMemo = new WeakMap<object, { zone: string; start: string; end: string; allDay: boolean; r: { start: Date; end: Date } }>()

/**
 * 화면 배치용 [시작, 끝) 순간. 시각 일정은 그대로 두고, 종일 일정은 해당 날짜들을 캘린더 시간대의 자정으로 변환한다
 * (서울과 LA 어디에서도 동일한 날짜 칸에 배치된다).
 */
export function eventRange(ev: { start: string; end: string; all_day?: boolean }): { start: Date; end: Date } {
  const zone = calendarZone()
  const hit = rangeMemo.get(ev)
  if (hit && hit.zone === zone && hit.start === ev.start && hit.end === ev.end && hit.allDay === !!ev.all_day) return hit.r
  let r: { start: Date; end: Date }
  if (!ev.all_day) r = { start: new Date(ev.start), end: new Date(ev.end) }
  else {
    const s = allDayYmd(ev.start)
    let e = allDayYmd(ev.end)
    if (Date.UTC(e.year, e.month, e.date) <= Date.UTC(s.year, s.month, s.date)) e = { year: s.year, month: s.month, date: s.date + 1 }
    r = { start: zDate(s.year, s.month, s.date, 0, 0, 0, zone), end: zDate(e.year, e.month, e.date, 0, 0, 0, zone) }
  }
  rangeMemo.set(ev, { zone, start: ev.start, end: ev.end, allDay: !!ev.all_day, r })
  return r
}
