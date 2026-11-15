import { describe, expect, it } from 'vitest'
import { CAT_HEX, catColor, catForIndex, catOf, hatchedIds } from '~/utils/categoryColor'

describe('범주 색', () => {
  it('저장 hex·토큰 이름·옛 팔레트를 범주 번호로', () => {
    expect(catOf(CAT_HEX[0])).toBe(1)
    expect(catOf('#8B6C18')).toBe(8)
    expect(catOf('cat-5')).toBe(5)
    expect(catOf('#ef4444')).toBe(4)
    expect(catOf('#123456')).toBeNull()
    expect(catOf(null)).toBeNull()
  })
  it('CSS 색 — 범주는 테마 토큰, 그 밖의 hex 는 그대로', () => {
    expect(catColor('#ae5c13')).toBe('hsl(var(--cat-3))')
    expect(catColor('#ae5c13', 0.2)).toBe('hsl(var(--cat-3) / 0.2)')
    expect(catColor('#123456')).toBe('#123456')
    expect(catColor(undefined)).toBe('hsl(var(--primary))')
  })
  it('순번 1→8 순환, 9번째부터 빗금', () => {
    expect(catForIndex(0)).toEqual({ cat: 1, hatched: false })
    expect(catForIndex(7)).toEqual({ cat: 8, hatched: false })
    expect(catForIndex(8)).toEqual({ cat: 1, hatched: true })
  })
  it('앞 순번이 같은 범주를 쓰면 빗금', () => {
    const ids = hatchedIds([
      { id: 'a', color: CAT_HEX[0] },
      { id: 'b', color: '#123456' },
      { id: 'c', color: '#3b82f6' },
      { id: 'd', color: CAT_HEX[1] },
    ])
    expect([...ids]).toEqual(['c'])
  })
})
