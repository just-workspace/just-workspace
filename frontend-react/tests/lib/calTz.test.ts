// 캘린더 시간대 헬퍼(utils/calTz) + 그것을 거치는 calendarLayout — 자정·서머타임 전환일·주 경계.
// 테스트 기기 시간대와 상관없이 캘린더 시간대만 보게 _setCalendarZone 으로 고정한다.
import { describe, it, expect, afterEach } from 'vitest'
import {
  _setCalendarZone, allDayIso, allDayIsoFromInput, allDayYmd, eventRange, zAddDays, zAddMonths, zDate, zDayNumber,
  zFromInputs, zMinutesOfDay, zoneOffsetMs, zp, zStartOfDay,
} from '~/utils/calTz'
import {
  addDays, fmtTime, isSameDay, overlapsDay, startOfDay, startOfWeek, toDateInput, fromInputs,
} from '~/utils/calendarLayout'
import { zonedToDate, dateToZoned } from '~/utils/calendarAttendees'

const LA = 'America/Los_Angeles'
const SEOUL = 'Asia/Seoul'
const H = 3_600_000
const iso = (d: Date) => d.toISOString()

afterEach(() => { _setCalendarZone(null) })

describe('오프셋', () => {
  it('서울은 늘 +9, LA 는 겨울 −8 · 여름 −7', () => {
    expect(zoneOffsetMs(Date.parse('2026-01-15T00:00:00Z'), SEOUL)).toBe(9 * H)
    expect(zoneOffsetMs(Date.parse('2026-07-15T00:00:00Z'), SEOUL)).toBe(9 * H)
    expect(zoneOffsetMs(Date.parse('2026-01-15T00:00:00Z'), LA)).toBe(-8 * H)
    expect(zoneOffsetMs(Date.parse('2026-07-15T00:00:00Z'), LA)).toBe(-7 * H)
  })
  it('LA 전환 순간 앞뒤(2026-03-08 10:00Z · 2026-11-01 09:00Z)', () => {
    expect(zoneOffsetMs(Date.parse('2026-03-08T09:59:00Z'), LA)).toBe(-8 * H)
    expect(zoneOffsetMs(Date.parse('2026-03-08T10:00:00Z'), LA)).toBe(-7 * H)
    expect(zoneOffsetMs(Date.parse('2026-11-01T08:59:00Z'), LA)).toBe(-7 * H)
    expect(zoneOffsetMs(Date.parse('2026-11-01T09:00:00Z'), LA)).toBe(-8 * H)
  })
})

describe('자정', () => {
  it('같은 순간도 시간대마다 다른 날', () => {
    const t = new Date('2026-10-16T16:30:00Z')   // 서울 10/17 01:30 · LA 10/16 09:30
    expect(zp(t, SEOUL)).toMatchObject({ year: 2026, month: 9, date: 17, hours: 1, minutes: 30, day: 6 })
    expect(zp(t, LA)).toMatchObject({ year: 2026, month: 9, date: 16, hours: 9, minutes: 30, day: 5 })
    expect(iso(zStartOfDay(t, SEOUL))).toBe('2026-10-16T15:00:00.000Z')
    expect(iso(zStartOfDay(t, LA))).toBe('2026-10-16T07:00:00.000Z')
  })
  it('자정 직전·직후', () => {
    _setCalendarZone(SEOUL)
    const before = new Date('2026-10-16T14:59:59Z'), after = new Date('2026-10-16T15:00:00Z')
    expect(isSameDay(before, after)).toBe(false)
    expect(toDateInput(before)).toBe('2026-10-16')
    expect(toDateInput(after)).toBe('2026-10-17')
    expect(fmtTime(after)).toBe('00:00')
    // 그날 [00:00, 다음날 00:00) 과 겹침 — 끝이 자정이면 다음날과는 안 겹친다
    const day = fromInputs('2026-10-17')!
    expect(overlapsDay(new Date('2026-10-16T13:00:00Z'), after, day)).toBe(false)
    expect(overlapsDay(new Date('2026-10-16T13:00:00Z'), new Date('2026-10-16T15:00:01Z'), day)).toBe(true)
  })
  it('넘친 값 정리(월 12 → 다음해, 일 0 → 전달 말일)', () => {
    expect(iso(zDate(2026, 12, 1, 0, 0, 0, SEOUL))).toBe('2026-12-31T15:00:00.000Z')
    expect(zp(zDate(2026, 2, 0, 0, 0, 0, LA), LA)).toMatchObject({ month: 1, date: 28 })
  })
})

describe('서머타임 전환일(LA)', () => {
  it('봄(03-08)은 23시간, 가을(11-01)은 25시간', () => {
    _setCalendarZone(LA)
    const spring = startOfDay(new Date('2026-03-08T20:00:00Z'))
    expect(iso(spring)).toBe('2026-03-08T08:00:00.000Z')
    expect(addDays(spring, 1).getTime() - spring.getTime()).toBe(23 * H)
    const fall = startOfDay(new Date('2026-11-01T20:00:00Z'))
    expect(iso(fall)).toBe('2026-11-01T07:00:00.000Z')
    expect(addDays(fall, 1).getTime() - fall.getTime()).toBe(25 * H)
  })
  it('하루 더하기는 벽시계 기준(전환을 건너도 09:00 은 09:00)', () => {
    _setCalendarZone(LA)
    const sat9 = zDate(2026, 2, 7, 9)
    const sun9 = addDays(sat9, 1)
    expect(fmtTime(sun9)).toBe('09:00')
    expect(sun9.getTime() - sat9.getTime()).toBe(23 * H)
    expect(fmtTime(zAddDays(zDate(2026, 9, 31, 9), 1))).toBe('09:00')
    expect(zp(zAddMonths(zDate(2026, 1, 15, 9), 1))).toMatchObject({ month: 2, date: 15, hours: 9 })
  })
  it('없는 시각(봄 02:30)은 03:30, 두 번 있는 시각(가을 01:30)은 앞의 것(PDT)', () => {
    const gap = zDate(2026, 2, 8, 2, 30, 0, LA)
    expect(iso(gap)).toBe('2026-03-08T10:30:00.000Z')
    expect(zp(gap, LA)).toMatchObject({ hours: 3, minutes: 30 })
    const dup = zDate(2026, 10, 1, 1, 30, 0, LA)
    expect(iso(dup)).toBe('2026-11-01T08:30:00.000Z')
    expect(iso(zFromInputs('2026-11-01', '01:30', LA)!)).toBe('2026-11-01T08:30:00.000Z')
    // 일정 폼(일정별 시간대)도 같은 계산
    expect(iso(zonedToDate('2026-03-08', '02:30', LA)!)).toBe('2026-03-08T10:30:00.000Z')
    expect(dateToZoned(new Date('2026-11-01T09:30:00Z'), LA)).toEqual({ date: '2026-11-01', time: '01:30' })
  })
  it('벽시계 분 — 전환일 03:00 은 180분(경과 시간 120분이 아님)', () => {
    _setCalendarZone(LA)
    const three = zDate(2026, 2, 8, 3)
    expect(zMinutesOfDay(three)).toBe(180)
    expect(three.getTime() - startOfDay(three).getTime()).toBe(2 * H)
  })
  it('서울은 전환이 없다', () => {
    _setCalendarZone(SEOUL)
    const d = startOfDay(new Date('2026-03-08T05:00:00Z'))
    expect(addDays(d, 1).getTime() - d.getTime()).toBe(24 * H)
    expect(iso(zDate(2026, 2, 8, 2, 30))).toBe('2026-03-07T17:30:00.000Z')
  })
})

describe('주 경계', () => {
  it('LA: 전환일이 낀 주 — 일요일 시작이면 03-08(일) 00:00, 월요일 시작이면 03-02', () => {
    _setCalendarZone(LA)
    const wed = zDate(2026, 2, 11, 12)
    expect(iso(startOfWeek(wed, 0))).toBe('2026-03-08T08:00:00.000Z')
    expect(iso(startOfWeek(wed, 1))).toBe('2026-03-09T07:00:00.000Z')
    const sunEarly = zDate(2026, 2, 8, 0, 30)
    expect(iso(startOfWeek(sunEarly, 1))).toBe('2026-03-02T08:00:00.000Z')
    // 7칸이 각각 그날 00:00
    const s = startOfWeek(sunEarly, 0)
    const days = Array.from({ length: 7 }, (_, i) => toDateInput(addDays(s, i)))
    expect(days).toEqual(['2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14'])
    expect(zDayNumber(addDays(s, 6)) - zDayNumber(s)).toBe(6)
  })
  it('서울: 토요일 23:30 과 일요일 00:30 은 다른 주(일요일 시작)', () => {
    _setCalendarZone(SEOUL)
    const sat = zDate(2026, 9, 17, 23, 30), sun = zDate(2026, 9, 18, 0, 30)
    expect(toDateInput(startOfWeek(sat, 0))).toBe('2026-10-11')
    expect(toDateInput(startOfWeek(sun, 0))).toBe('2026-10-18')
    expect(toDateInput(startOfWeek(sat, 6))).toBe('2026-10-17')
  })
  it('같은 순간이 LA 와 서울에서 다른 주에 든다', () => {
    const t = new Date('2026-10-17T16:00:00Z')   // 서울 10/18(일) 01:00 · LA 10/17(토) 09:00
    _setCalendarZone(SEOUL)
    expect(toDateInput(startOfWeek(t, 0))).toBe('2026-10-18')
    _setCalendarZone(LA)
    expect(toDateInput(startOfWeek(t, 0))).toBe('2026-10-11')
  })
})

describe('종일 일정은 날짜만(시간대 변환 없음)', () => {
  it('UTC 00:00 저장값 = 그 날짜, 서울·LA 모두 같은 날짜 칸', () => {
    const ev = { start: '2026-10-09T00:00:00+00:00', end: '2026-10-10T00:00:00+00:00', all_day: true }
    expect(allDayYmd(ev.start)).toEqual({ year: 2026, month: 9, date: 9 })
    for (const tz of [SEOUL, LA]) {
      _setCalendarZone(tz)
      const r = eventRange(ev)
      expect(toDateInput(r.start)).toBe('2026-10-09')
      expect(fmtTime(r.start)).toBe('00:00')
      expect(overlapsDay(r.start, r.end, fromInputs('2026-10-09')!)).toBe(true)
      expect(overlapsDay(r.start, r.end, fromInputs('2026-10-10')!)).toBe(false)
      expect(overlapsDay(r.start, r.end, fromInputs('2026-10-08')!)).toBe(false)
    }
  })
  it('예전 웹 화면이 기기 자정으로 저장한 값도 같은 날짜(서울 = 전날 15:00Z, LA = 07:00Z)', () => {
    expect(allDayYmd('2026-10-08T15:00:00Z')).toEqual({ year: 2026, month: 9, date: 9 })
    expect(allDayYmd('2026-10-09T07:00:00Z')).toEqual({ year: 2026, month: 9, date: 9 })
  })
  it('서머타임 날의 종일도 그 하루 칸(LA 03-08)', () => {
    _setCalendarZone(LA)
    const r = eventRange({ start: allDayIso(2026, 2, 8), end: allDayIso(2026, 2, 9), all_day: true })
    expect(iso(r.start)).toBe('2026-03-08T08:00:00.000Z')
    expect(r.end.getTime() - r.start.getTime()).toBe(23 * H)
  })
  it('저장 값 — 날짜의 UTC 00:00, 끝은 다음날(배타)', () => {
    expect(allDayIsoFromInput('2026-10-09')).toBe('2026-10-09T00:00:00.000Z')
    expect(allDayIsoFromInput('2026-12-31', 1)).toBe('2027-01-01T00:00:00.000Z')
    expect(allDayIsoFromInput('nope')).toBeNull()
  })
  it('끝이 시작보다 같거나 이르면 하루짜리로', () => {
    _setCalendarZone(SEOUL)
    const r = eventRange({ start: '2026-10-09T00:00:00Z', end: '2026-10-09T00:00:00Z', all_day: true })
    expect(toDateInput(r.end)).toBe('2026-10-10')
  })
})
