import { describe, it, expect } from 'vitest'
import {
  countResponses, firstConflict, zonedToDate, dateToZoned, tzOffsetMinutes, tzGmtLabel,
  attendeeInitial,
} from '~/utils/calendarAttendees'
import { filenameFromDisposition } from '~/utils/apiDownload'

describe('countResponses — 팝오버 참석자 집계', () => {
  it('수락·미정·거절·대기를 센다', () => {
    const c = countResponses([
      { response: 'accepted' }, { response: 'accepted' }, { response: 'tentative' },
      { response: 'declined' }, { response: 'needs-action' }, { response: null },
    ])
    expect(c).toEqual({ total: 6, accepted: 2, tentative: 1, declined: 1, pending: 2 })
  })
})

describe('firstConflict — 겹침 경고', () => {
  const s = new Date('2026-10-16T05:00:00Z'), e = new Date('2026-10-16T06:00:00Z')
  it('겹친 부분만 잘라 돌려준다', () => {
    const c = firstConflict([{ start: '2026-10-16T05:30:00Z', end: '2026-10-16T07:00:00Z' }], s, e)
    expect(c?.start.toISOString()).toBe('2026-10-16T05:30:00.000Z')
    expect(c?.end.toISOString()).toBe('2026-10-16T06:00:00.000Z')
  })
  it('맞닿기만 하면 겹침이 아니다', () => {
    expect(firstConflict([{ start: '2026-10-16T06:00:00Z', end: '2026-10-16T07:00:00Z' }], s, e)).toBeNull()
    expect(firstConflict([{ start: '2026-10-16T04:00:00Z', end: '2026-10-16T05:00:00Z' }], s, e)).toBeNull()
  })
  it('수정 중인 이 일정 자신은 건너뛴다', () => {
    const own = { start: s, end: e }
    expect(firstConflict([{ start: s.toISOString(), end: e.toISOString() }], s, e, own)).toBeNull()
  })
})

describe('시간대 변환', () => {
  it('Asia/Seoul 오프셋은 +540분', () => {
    expect(tzOffsetMinutes('Asia/Seoul', new Date('2026-10-16T00:00:00Z'))).toBe(540)
    expect(tzGmtLabel('Asia/Seoul')).toBe('GMT+9')
  })
  it('벽시계 ↔ 순간 왕복', () => {
    const d = zonedToDate('2026-10-16', '14:00', 'Asia/Seoul')!
    expect(d.toISOString()).toBe('2026-10-16T05:00:00.000Z')
    expect(dateToZoned(d, 'Asia/Seoul')).toEqual({ date: '2026-10-16', time: '14:00' })
  })
  it('서머타임 지역도 맞춘다(뉴욕 여름 -4, 겨울 -5)', () => {
    expect(zonedToDate('2026-07-01', '09:00', 'America/New_York')!.toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(zonedToDate('2026-12-01', '09:00', 'America/New_York')!.toISOString()).toBe('2026-12-01T14:00:00.000Z')
  })
  it('형식이 틀리면 null', () => {
    expect(zonedToDate('2026/10/16', '14:00', 'UTC')).toBeNull()
  })
})

describe('기타', () => {
  it('Content-Disposition 의 UTF-8 이름을 푼다', () => {
    expect(filenameFromDisposition(`attachment; filename="calendar.ics"; filename*=UTF-8''%EC%97%85%EB%AC%B4.ics`, 'x.ics')).toBe('업무.ics')
    expect(filenameFromDisposition('attachment; filename="a.vcf"', 'x')).toBe('a.vcf')
    expect(filenameFromDisposition(null, 'x.ics')).toBe('x.ics')
  })
  it('이니셜', () => {
    expect(attendeeInitial('김서연')).toBe('김')
    expect(attendeeInitial(null, 'park@x.io')).toBe('P')
  })
})
