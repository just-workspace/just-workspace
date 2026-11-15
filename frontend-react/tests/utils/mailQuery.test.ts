import { describe, it, expect } from 'vitest'
import { parseMailQuery, serverQuery, filterMailRows, swipeAction, formatBytes, previewKind, SWIPE_REVEAL, formatMailDate, summarizeRecipients, applyLabelChange, labelTone, threadLayout, toLocalInput, fromLocalInput, defaultScheduleTime } from '~/utils/mailQuery'

const row = (o: Partial<{ is_unread: boolean; is_flagged: boolean; has_attachment: boolean; from: string }>) => ({
  is_unread: !!o.is_unread,
  is_flagged: !!o.is_flagged,
  has_attachment: !!o.has_attachment,
  from_: [{ name: o.from || null, email: `${(o.from || 'x').toLowerCase()}@example.com` }],
})

describe('parseMailQuery', () => {
  it('평문만', () => {
    const p = parseMailQuery('  킥오프   자료 ')
    expect(p.text).toBe('킥오프 자료')
    expect(p.unread || p.starred || p.attachment).toBe(false)
  })
  it('구문 토큰을 떼어 낸다', () => {
    const p = parseMailQuery('from:minji is:unread 킥오프 has:attachment is:starred')
    expect(p).toMatchObject({ text: '킥오프', from: 'minji', unread: true, starred: true, attachment: true })
  })
  it('따옴표 값과 모르는 토큰', () => {
    const p = parseMailQuery('from:"박 민지" label:x')
    expect(p.from).toBe('박 민지')
    expect(p.text).toBe('label:x')
  })
  it('serverQuery 는 평문 우선, 없으면 from', () => {
    expect(serverQuery(parseMailQuery('from:minji'))).toBe('minji')
    expect(serverQuery(parseMailQuery('from:minji 자료'))).toBe('자료')
  })
})

describe('filterMailRows', () => {
  const rows = [row({ is_unread: true, from: 'Minji' }), row({ is_flagged: true }), row({ has_attachment: true, from: 'Seoyeon' })]
  it('칩 조합', () => {
    expect(filterMailRows(rows, { unread: true, starred: false, attachment: false })).toHaveLength(1)
    expect(filterMailRows(rows, { unread: false, starred: true, attachment: false })).toHaveLength(1)
    expect(filterMailRows(rows, { unread: true, starred: true, attachment: false })).toHaveLength(0)
    expect(filterMailRows(rows, { unread: false, starred: false, attachment: false })).toHaveLength(3)
  })
  it('from 거르기는 이름·주소 부분 일치', () => {
    expect(filterMailRows(rows, { unread: false, starred: false, attachment: false }, 'seoy')).toHaveLength(1)
  })
})

describe('swipeAction', () => {
  it('왼쪽 = 보관, 오른쪽 = 읽음 전환, 모자라면 없음', () => {
    expect(swipeAction(-SWIPE_REVEAL)).toBe('archive')
    expect(swipeAction(SWIPE_REVEAL + 5)).toBe('toggle-read')
    expect(swipeAction(-40)).toBeNull()
  })
  it('세로가 더 크면 스크롤', () => {
    expect(swipeAction(-120, 200)).toBeNull()
  })
})

describe('formatBytes / previewKind', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(2.4 * 1024 * 1024)).toBe('2.4 MB')
  })
  it('previewKind 는 서버 inline 허용 목록과 같다', () => {
    expect(previewKind('image/png')).toBe('image')
    expect(previewKind('application/pdf; name=a.pdf')).toBe('pdf')
    expect(previewKind('image/svg+xml')).toBeNull()
    expect(previewKind('text/html')).toBeNull()
  })
})

describe('formatMailDate / summarizeRecipients', () => {
  const now = new Date(2026, 9, 15, 12, 0)
  it('오늘·올해·작년', () => {
    expect(formatMailDate(new Date(2026, 9, 15, 9, 5).toISOString(), false, now)).toBe('09:05')
    expect(formatMailDate(new Date(2026, 9, 13, 9, 5).toISOString(), false, now)).toBe('10/13')
    expect(formatMailDate(new Date(2026, 9, 13, 9, 5).toISOString(), true, now)).toBe('10/13 09:05')
    expect(formatMailDate(new Date(2025, 0, 2).toISOString(), false, now)).toBe('2025/1/2')
    expect(formatMailDate(null)).toBe('')
  })
  it('받는 사람 요약', () => {
    const l = [{ name: '김서연', email: 's@x' }, { name: null, email: 'me@x' }, { name: 'A', email: 'a@x' }, { name: 'B', email: 'b@x' }, { name: 'C', email: 'c@x' }]
    expect(summarizeRecipients(l, 'ME@x')).toBe('나, 김서연 외 3명')
    expect(summarizeRecipients(l.slice(0, 3), 'me@x')).toBe('나, 김서연, A')
  })
})

describe('applyLabelChange', () => {
  it('붙이고 떼고 중복 없이', () => {
    expect(applyLabelChange(['a', 'b'], ['c', 'a'], ['b'])).toEqual(['a', 'c'])
    expect(applyLabelChange(undefined, ['x'], [])).toEqual(['x'])
    expect(applyLabelChange(['x'], ['x'], ['x'])).toEqual([])
  })
})

describe('labelTone', () => {
  it('같은 이름은 늘 같은 색', () => {
    expect(labelTone('프로젝트')).toBe(labelTone('프로젝트'))
    // 범주 색 cat-1…8
    expect(labelTone('고객')).toMatch(/^cat-[1-8]$/)
  })
})

describe('threadLayout', () => {
  const t = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }]
  it('첫 통만 보이고 나머지는 n개 더 보기', () => {
    expect(threadLayout(t, '4')).toEqual({ shown: [{ id: '1' }], hidden: 2 })
  })
  it('펼치면 전부, 하나뿐이면 접지 않음', () => {
    expect(threadLayout(t, '4', true).shown).toHaveLength(3)
    expect(threadLayout([{ id: '1' }, { id: '2' }], '2')).toEqual({ shown: [{ id: '1' }], hidden: 0 })
    expect(threadLayout([{ id: '1' }], '1')).toEqual({ shown: [], hidden: 0 })
  })
})

describe('예약 시각', () => {
  it('datetime-local 왕복', () => {
    const d = new Date(2026, 9, 16, 8, 5)
    expect(toLocalInput(d)).toBe('2026-10-16T08:05')
    expect(fromLocalInput('2026-10-16T08:05')).toBe(d.toISOString())
    expect(fromLocalInput('')).toBeNull()
  })
  it('기본값은 다음 날 8시, 새벽이면 오늘 8시', () => {
    const a = defaultScheduleTime(new Date(2026, 9, 15, 14, 0))
    expect([a.getDate(), a.getHours()]).toEqual([16, 8])
    const b = defaultScheduleTime(new Date(2026, 9, 15, 2, 0))
    expect([b.getDate(), b.getHours()]).toEqual([15, 8])
  })
})
