import { describe, it, expect } from 'vitest'
import { viewOf, groupMeetings, meetingCounts, scheduleText, durationLabel } from '~/utils/meetingTime'

// 2026-10-15(목) 15:00 로컬
const NOW = new Date(2026, 9, 15, 15, 0, 0)
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString()
const epoch = (d: number, h: number, m = 0) => Math.floor(new Date(2026, 9, d, h, m).getTime() / 1000)

const room = (name: string, o: Partial<{ n: number; created: number; sched: string | null; dur: number | null }>) => ({
  name,
  num_participants: o.n ?? 0,
  creation_time: o.created ?? epoch(15, 9),
  scheduled_at: o.sched ?? null,
  duration_minutes: o.dur ?? null,
})

describe('viewOf', () => {
  it('진행 중: 시작 n분 · n분째, 참여 가능', () => {
    const v = viewOf(room('dev', { n: 3, created: epoch(15, 14, 48) }), NOW)
    expect(v.live).toBe(true)
    expect(v.durText).toBe('시작 12분')
    expect(v.durShort).toBe('12분째')
    expect(v.joinable).toBe(true)
  })
  it('예약: 10분 전부터 참여', () => {
    expect(viewOf(room('a', { sched: at(15, 15, 5), dur: 60 }), NOW).joinable).toBe(true)
    expect(viewOf(room('b', { sched: at(15, 15, 30), dur: 60 }), NOW).joinable).toBe(false)
    expect(viewOf(room('b', { sched: at(15, 15, 30), dur: 60 }), NOW).timeText).toBe('15:30')
  })
  it('예약 없이 만든 방은 언제든 참여', () => {
    expect(viewOf(room('x', {}), NOW).joinable).toBe(true)
  })
  it('날짜 표기', () => {
    expect(viewOf(room('y', { sched: at(14, 14), dur: 58 }), NOW).timeText).toBe('어제 14:00')
    expect(viewOf(room('z', { sched: at(20, 9), dur: 30 }), NOW).timeText).toBe('10/20 09:00')
  })
})

describe('groupMeetings', () => {
  it('진행 중 · 예정(날짜별) · 지난', () => {
    const g = groupMeetings([
      room('past', { sched: at(14, 14), dur: 58 }),
      room('live', { n: 2 }),
      room('later', { sched: at(16, 10), dur: 30 }),
      room('today', { sched: at(15, 17, 30), dur: 30 }),
      room('instant', {}),
    ], NOW)
    expect(g.map(x => x.label)).toEqual(['진행 중', '예정 · 오늘', '예정 · 내일', '지난 회의'])
    expect(g[1].items.map(x => x.room.name)).toEqual(['instant', 'today'])
  })
  it('집계', () => {
    expect(meetingCounts([room('l', { n: 1 }), room('t', { sched: at(15, 17), dur: 30 }), room('n', { sched: at(16, 9), dur: 30 })], NOW))
      .toEqual({ live: 1, today: 1 })
  })
})

describe('표기', () => {
  it('scheduleText', () => {
    expect(scheduleText(at(15, 15), 60, NOW)).toBe('오늘 15:00–16:00')
    expect(scheduleText(at(16, 14), 60, NOW)).toBe('내일 14:00–15:00')
    expect(scheduleText(at(20, 14), null, NOW)).toBe('10월 20일 (화) 14:00')
    expect(scheduleText(null, 60, NOW)).toBe('')
  })
  it('durationLabel', () => {
    expect(durationLabel(60)).toBe('1시간')
    expect(durationLabel(30)).toBe('30분')
    expect(durationLabel(90)).toBe('1시간 30분')
  })
})

describe('status(DB 회의 저장소)', () => {
  it('ended·cancelled 는 지난 묶음 · 참여 불가(예약 없이 만든 방도)', () => {
    const ended = { ...room('instant', { created: epoch(15, 9) }), status: 'ended' }
    const v = viewOf(ended, NOW)
    expect(v.ended).toBe(true)
    expect(v.joinable).toBe(false)
    const groups = groupMeetings([ended, room('next', { sched: at(15, 16), dur: 30 })], NOW)
    expect(groups.map(g => g.key)).toEqual(['예정 · 오늘', 'past'])
    expect(meetingCounts([ended], NOW)).toEqual({ live: 0, today: 0 })
  })
  it('status=live 라도 빈 방은 예약 시각으로 묶는다', () => {
    const r = { ...room('soon', { sched: at(16, 10), dur: 60 }), status: 'live' }
    expect(groupMeetings([r], NOW)[0].label).toBe('예정 · 내일')
  })
})
