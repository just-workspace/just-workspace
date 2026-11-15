import { describe, it, expect } from 'vitest'
import { indexKeyOf, groupByIndex, initialsOf, INDEX_ORDER, groupDotColor } from '~/utils/contactsIndex'

describe('indexKeyOf — 초성 색인', () => {
  it('한글 음절은 초성으로', () => {
    expect(indexKeyOf('김서연')).toBe('ㄱ')
    expect(indexKeyOf('박민지')).toBe('ㅂ')
    expect(indexKeyOf('최수아')).toBe('ㅊ')
    expect(indexKeyOf('이도윤')).toBe('ㅇ')
  })
  it('쌍자음은 홑자음으로 접는다', () => {
    expect(indexKeyOf('까치')).toBe('ㄱ')
    expect(indexKeyOf('따옴표')).toBe('ㄷ')
  })
  it('라틴은 대문자, 나머지는 #', () => {
    expect(indexKeyOf('alice')).toBe('A')
    expect(indexKeyOf('Zed')).toBe('Z')
    expect(indexKeyOf('123')).toBe('#')
    expect(indexKeyOf('')).toBe('#')
    expect(indexKeyOf(null)).toBe('#')
  })
})

describe('groupByIndex', () => {
  const people = [
    { name: '최수아', org: 'Acme' },
    { name: '김서연', org: '제품팀' },
    { name: 'alice', org: 'Acme' },
    { name: '박준호', org: '개발팀' },
    { name: '박민지', org: '제품팀' },
  ]
  it('초성 순서대로 묶고 이름순 정렬', () => {
    const g = groupByIndex(people, p => p.name, p => p.org)
    expect(g.map(x => x.key)).toEqual(['ㄱ', 'ㅂ', 'ㅊ', 'A'])
    expect(g[1].items.map(p => p.name)).toEqual(['박민지', '박준호'])
  })
  it('INDEX_ORDER 는 ㄱ…ㅎ A…Z # 순', () => {
    expect(INDEX_ORDER[0]).toBe('ㄱ')
    expect(INDEX_ORDER[INDEX_ORDER.length - 1]).toBe('#')
    expect(INDEX_ORDER.indexOf('A')).toBeGreaterThan(INDEX_ORDER.indexOf('ㅎ'))
  })
  it('initialsOf', () => {
    expect(initialsOf('최수아')).toBe('최')
    expect(initialsOf('bob')).toBe('B')
    expect(initialsOf('')).toBe('?')
  })
})

describe('groupDotColor — 그룹 점 색', () => {
  it('같은 이름은 늘 같은 토큰', () => {
    expect(groupDotColor('고객사')).toBe(groupDotColor('고객사'))
    expect(groupDotColor('파트너')).toMatch(/^hsl\(var\(--cat-[1-8]\)\)$/)
  })
})
