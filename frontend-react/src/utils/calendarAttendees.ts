// 캘린더 참석자·시간대·빈 시간 도우미(순수 함수 — 테스트 대상). 시간대 계산은 utils/calTz.
import { deviceTimeZone, zDateInput, zFmtTime, zFromInputs, zoneOffsetMs } from './calTz'

export type AttendeeResponse = 'needs-action' | 'accepted' | 'declined' | 'tentative'

export interface Attendee {
  email: string
  name: string | null
  response: AttendeeResponse | string
  user_id: string | null
}

export interface BusyInterval { start: string; end: string }

/** 참석자 응답 집계(팝오버 "참석자 6 · 수락 4 · 미정 1 · 거절 1") */
export function countResponses(list: readonly { response?: string | null }[]) {
  const out = { total: list.length, accepted: 0, tentative: 0, declined: 0, pending: 0 }
  for (const a of list) {
    if (a.response === 'accepted') out.accepted++
    else if (a.response === 'tentative') out.tentative++
    else if (a.response === 'declined') out.declined++
    else out.pending++
  }
  return out
}

/** 이름 첫 글자(칩·아바타 이니셜) */
export function attendeeInitial(name: string | null | undefined, email = ''): string {
  const s = (name || email || '?').trim()
  return (Array.from(s)[0] || '?').toUpperCase()
}

/**
 * [start, end) 와 겹치는 첫 바쁜 구간(겹친 부분만 잘라 반환). 없으면 null.
 * ignore 와 정확히 일치하는 구간(수정 중인 해당 일정 자체)은 건너뛴다.
 */
export function firstConflict(
  busy: readonly BusyInterval[],
  start: Date,
  end: Date,
  ignore?: { start: Date; end: Date } | null,
): { start: Date; end: Date } | null {
  const s = start.getTime(), e = end.getTime()
  for (const b of busy) {
    const bs = new Date(b.start).getTime(), be = new Date(b.end).getTime()
    if (Number.isNaN(bs) || Number.isNaN(be)) continue
    if (ignore && Math.abs(bs - ignore.start.getTime()) < 1000 && Math.abs(be - ignore.end.getTime()) < 1000) continue
    if (bs < e && be > s) return { start: new Date(Math.max(bs, s)), end: new Date(Math.min(be, e)) }
  }
  return null
}


// ── 시간대 ──

/** 브라우저 시간대(IANA). 알 수 없으면 'UTC' */
export function browserTimeZone(): string {
  return deviceTimeZone()
}

/** 선택 가능한 IANA 시간대 목록(미지원 브라우저에서는 일부만 제공) */
export function timeZoneList(): string[] {
  try {
    const fn = (Intl as any).supportedValuesOf
    if (typeof fn === 'function') return fn('timeZone') as string[]
  } catch { /* 아래 기본 목록 */ }
  return ['UTC', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles']
}

/** 그 순간 tz 의 UTC 오프셋(분, 동쪽 +). tz 를 알 수 없으면 0 — 계산은 utils/calTz 로 일원화 */
export function tzOffsetMinutes(tz: string, at: Date): number {
  try { return zoneOffsetMs(at.getTime(), tz) / 60000 } catch { return 0 }
}

/** 'GMT+9' 형식 표기(tz 기준) */
export function tzGmtLabel(tz: string, at = new Date()): string {
  const off = tzOffsetMinutes(tz, at)
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off), h = Math.floor(a / 60), m = a % 60
  return `GMT${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`
}

/**
 * tz 의 벽시계 'YYYY-MM-DD' + 'HH:MM' → 실제 순간(Date). 형식 불일치 시 null.
 * 서머타임: 존재하지 않는 시각은 이후 시각으로, 중복되는 시각은 앞선 쪽(utils/calTz zDate).
 */
export function zonedToDate(date: string, time: string, tz: string): Date | null {
  try { return zFromInputs(date, time, tz) } catch { return null }
}

/** 순간 → tz 의 벽시계 { date: 'YYYY-MM-DD', time: 'HH:MM' } */
export function dateToZoned(d: Date, tz: string): { date: string; time: string } {
  return { date: zDateInput(d, tz), time: zFmtTime(d, tz) }
}
