import { describe, it, expect } from 'vitest'
import { boardDay, boardStamp, fileKind, fileSize, isUnreadPost, mentionQueryAt, splitMentions, splitResolvedMentions } from '~/utils/boardFormat'

describe('boardDay / boardStamp', () => {
  const now = new Date(2026, 9, 15, 12, 0)
  it('오늘은 시각, 그 밖은 MM/DD', () => {
    expect(boardDay(new Date(2026, 9, 15, 9, 5).toISOString(), now)).toBe('09:05')
    expect(boardDay(new Date(2026, 9, 1, 9, 5).toISOString(), now)).toBe('10/01')
    expect(boardStamp(new Date(2026, 9, 14, 18, 2).toISOString(), now)).toBe('10/14 18:02')
  })
})

describe('isUnreadPost', () => {
  it('서버 is_read 가 우선, 없으면 안 읽은 필독만 굵게', () => {
    const must = new Set(['a'])
    expect(isUnreadPost({ id: 'a' }, must)).toBe(true)
    expect(isUnreadPost({ id: 'b' }, must)).toBe(false)
    expect(isUnreadPost({ id: 'b', is_read: false }, must)).toBe(true)
    expect(isUnreadPost({ id: 'a', is_read: true }, must)).toBe(false)
  })
})

describe('splitMentions', () => {
  it('@이름 을 칩 조각으로 뗀다', () => {
    expect(splitMentions('@김서연 Git 은 영향 없습니다.')).toEqual([
      { mention: true, text: '@김서연' },
      { mention: false, text: ' Git 은 영향 없습니다.' },
    ])
  })
  it('메일 주소의 @ 는 언급이 아니다', () => {
    expect(splitMentions('a@b.com 으로').every(p => !p.mention)).toBe(true)
  })
})

describe('fileKind / fileSize', () => {
  it('유형 칩과 크기', () => {
    expect(fileKind('점검-상세-일정.pdf')).toEqual({ label: 'PDF', tone: 'danger' })
    expect(fileKind('표.xlsx').tone).toBe('success')
    expect(fileSize(320 * 1024)).toBe('320 KB')
    expect(fileSize(0)).toBe('')
  })
})

describe('splitResolvedMentions', () => {
  const ms = [{ id: 'u1', username: 'kim.sy', display_name: '김서연' }]
  it('서버가 해석한 사람만 칩, 나머지 @글자는 그대로', () => {
    expect(splitResolvedMentions('@kim.sy. 확인 부탁, @nobody 는 아님', ms)).toEqual([
      { mention: true, text: '@kim.sy', user: { id: 'u1', username: 'kim.sy', display_name: '김서연' } },
      { mention: false, text: '. 확인 부탁, @nobody 는 아님' },
    ])
  })
  it('mentions 가 비면 예전 규칙(글자 그대로)', () => {
    expect(splitResolvedMentions('@김서연 안녕', [])).toEqual([
      { mention: true, text: '@김서연' },
      { mention: false, text: ' 안녕' },
    ])
  })
})

describe('mentionQueryAt', () => {
  it('커서 앞 @검색어를 찾는다', () => {
    expect(mentionQueryAt('안녕 @ki', 6)).toEqual({ start: 3, query: 'ki' })
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQueryAt('mail@x', 6)).toBeNull()
    expect(mentionQueryAt('@kim 다음', 8)).toBeNull()
  })
})
