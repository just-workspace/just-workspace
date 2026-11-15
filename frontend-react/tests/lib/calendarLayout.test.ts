import { describe, it, expect } from 'vitest'
import {
  layoutOverlaps, rruleUntilBefore, startOfWeek, resolveWeekStart, eventBg, eventBar, overlapsDay, toRRuleUtc,
  clampRecurrenceCount, safeRecurrenceFreq, MAX_RECURRENCE_COUNT,
} from '~/utils/calendarLayout'

const H = 60 * 60 * 1000

describe('layoutOverlaps — 주·일 보기 겹침 열', () => {
  it('겹치지 않으면 모두 1열', () => {
    const out = layoutOverlaps([
      { id: 'a', start: 9 * H, end: 10 * H },
      { id: 'b', start: 10 * H, end: 11 * H },
    ])
    expect(out.every(b => b.cols === 1 && b.col === 0)).toBe(true)
  })

  it('겹치는 둘은 2열, 각각 다른 col', () => {
    const out = layoutOverlaps([
      { id: 'a', start: 9 * H, end: 12 * H },
      { id: 'b', start: 10 * H, end: 11 * H },
    ])
    const a = out.find(b => b.id === 'a')!, b = out.find(b => b.id === 'b')!
    expect(a.cols).toBe(2); expect(b.cols).toBe(2)
    expect(a.col).not.toBe(b.col)
  })

  it('묶음이 끝나면 열 수가 초기화된다', () => {
    const out = layoutOverlaps([
      { id: 'a', start: 9 * H, end: 10 * H },
      { id: 'b', start: 9.5 * H, end: 10.5 * H },
      { id: 'c', start: 15 * H, end: 16 * H },
    ])
    expect(out.find(b => b.id === 'c')!.cols).toBe(1)
  })

  it('짧은 일정도 최소 15분으로 본다', () => {
    const out = layoutOverlaps([
      { id: 'a', start: 9 * H, end: 9 * H + 60000 },
      { id: 'b', start: 9 * H + 5 * 60000, end: 9 * H + 10 * 60000 },
    ])
    expect(out[0].cols).toBe(2)
  })
})

describe('rruleUntilBefore — 이후 모두 삭제', () => {
  it('COUNT 를 버리고 회차 직전 UNTIL 을 넣는다', () => {
    const occ = new Date(Date.UTC(2026, 9, 15, 6, 0, 0))
    const r = rruleUntilBefore('FREQ=WEEKLY;BYDAY=TH;COUNT=10', occ)
    expect(r).toBe('FREQ=WEEKLY;BYDAY=TH;UNTIL=20261015T055959Z')
  })
  it('기존 UNTIL 은 교체한다', () => {
    const occ = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
    const r = rruleUntilBefore('FREQ=DAILY;UNTIL=20271231T000000Z', occ)
    expect(r).toBe('FREQ=DAILY;UNTIL=20251231T235959Z')
  })
  it('toRRuleUtc 형식', () => {
    expect(toRRuleUtc(new Date(Date.UTC(2026, 9, 5, 1, 2, 3)))).toBe('20261005T010203Z')
  })
})

describe('주 시작', () => {
  it('월요일 시작: 수요일 → 그 주 월요일', () => {
    const s = startOfWeek(new Date(2026, 9, 14), 1) // 2026-10-14 수
    expect(s.getDate()).toBe(12); expect(s.getDay()).toBe(1)
  })
  it('일요일 시작: 수요일 → 그 주 일요일', () => {
    const s = startOfWeek(new Date(2026, 9, 14), 0)
    expect(s.getDate()).toBe(11); expect(s.getDay()).toBe(0)
  })
  it('설정값이 우선', () => {
    expect(resolveWeekStart('mon', 'ko-KR')).toBe(1)
    expect(resolveWeekStart('sun', 'ko-KR')).toBe(0)
    expect([0, 1]).toContain(resolveWeekStart('locale', 'ko-KR'))
  })
})

describe('기타', () => {
  it('eventBg: 범주 색은 토큰 / 0.2, 그 밖의 hex 는 알파를 붙인다', () => {
    // 토큰 이전 기본 파랑 → 범주 1
    expect(eventBg('#3b82f6')).toBe('hsl(var(--cat-1) / 0.2)')
    expect(eventBg('#2c6ddd')).toBe('hsl(var(--cat-1) / 0.2)')
    expect(eventBar('#21835f')).toBe('hsl(var(--cat-2))')
    expect(eventBg('#123456')).toBe('#12345633')
    expect(eventBg('blue')).toContain('var(--primary)')
    expect(eventBg(null)).toContain('var(--primary)')
  })
  it('overlapsDay', () => {
    const day = new Date(2026, 9, 15)
    expect(overlapsDay(new Date(2026, 9, 15, 9), new Date(2026, 9, 15, 10), day)).toBe(true)
    expect(overlapsDay(new Date(2026, 9, 14, 9), new Date(2026, 9, 15, 0), day)).toBe(false)
    expect(overlapsDay(new Date(2026, 9, 14), new Date(2026, 9, 17), day)).toBe(true)
  })
})

import { parseRRule, fromInputs, toDateInput, toTimeInput, shiftSeries } from '~/utils/calendarLayout'

describe('parseRRule — 팝오버 반복 요약', () => {
  it('매주 목요일', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=TH')!
    expect(r.freq).toBe('WEEKLY'); expect(r.byday).toEqual([4]); expect(r.interval).toBe(1)
  })
  it('INTERVAL·COUNT·UNTIL', () => {
    const r = parseRRule('RRULE:FREQ=DAILY;INTERVAL=2;COUNT=5')!
    expect(r.interval).toBe(2); expect(r.count).toBe(5)
    const u = parseRRule('FREQ=MONTHLY;UNTIL=20261231T235959Z')!
    expect(u.until?.toISOString()).toBe('2026-12-31T23:59:59.000Z')
  })
  it('없거나 모르는 FREQ', () => {
    expect(parseRRule(null)).toBeNull()
    expect(parseRRule('FREQ=HOURLY')!.freq).toBeNull()
  })
})

describe('폼 입력 변환', () => {
  it('왕복', () => {
    const d = new Date(2026, 9, 16, 14, 5)
    expect(toDateInput(d)).toBe('2026-10-16')
    expect(toTimeInput(d)).toBe('14:05')
    expect(fromInputs('2026-10-16', '14:05')!.getTime()).toBe(d.getTime())
  })
  it('형식 오류는 null', () => {
    expect(fromInputs('2026/10/16', '14:05')).toBeNull()
    expect(fromInputs('2026-10-16', '')).toBeNull()
  })
})

describe('shiftSeries — 반복 "전체" 수정', () => {
  it('회차에서 1시간 늦추면 마스터도 1시간, 길이는 새 길이', () => {
    const master = { start: new Date(2026, 0, 1, 9), end: new Date(2026, 0, 1, 10) }
    const occ = new Date(2026, 9, 15, 9)
    const r = shiftSeries(master, occ, { start: new Date(2026, 9, 15, 10), end: new Date(2026, 9, 15, 12) })
    expect(r.start.getTime()).toBe(new Date(2026, 0, 1, 10).getTime())
    expect(r.end.getTime()).toBe(new Date(2026, 0, 1, 12).getTime())
  })
})

describe('반복 규칙 상한(보안 H5)', () => {
  it('초·분 단위 주기는 만들지 않는다', () => {
    expect(safeRecurrenceFreq('secondly')).toBeNull()
    expect(safeRecurrenceFreq('MINUTELY')).toBeNull()
    expect(safeRecurrenceFreq('hourly')).toBeNull()
    expect(safeRecurrenceFreq('weekly')).toBe('WEEKLY')
  })
  it('반복 횟수는 1..상한 정수', () => {
    expect(clampRecurrenceCount(999999)).toBe(MAX_RECURRENCE_COUNT)
    expect(clampRecurrenceCount(0)).toBeNull()
    expect(clampRecurrenceCount('abc')).toBeNull()
    expect(clampRecurrenceCount(10.7)).toBe(10)
  })
})
