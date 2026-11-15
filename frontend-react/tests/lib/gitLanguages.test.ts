import { describe, it, expect } from 'vitest'
import { languageSegments } from '~/utils/gitLanguages'

describe('languageSegments', () => {
  it('큰 순 셋은 시안 색, 나머지는 기타로 묶는다', () => {
    const out = languageSegments([
      { name: 'Go', percent: 27 }, { name: 'Vue', percent: 58 }, { name: 'TypeScript', percent: 10 },
      { name: 'Shell', percent: 3.2 }, { name: 'CSS', percent: 1.8 },
    ], '기타')
    expect(out).toEqual([
      { name: 'Vue', percent: 58, tone: 'primary' },
      { name: 'Go', percent: 27, tone: 'success' },
      { name: 'TypeScript', percent: 10, tone: 'warning' },
      { name: '기타', percent: 5, tone: 'muted' },
    ])
  })
  it('1% 미만 언어는 기타로, 빈 목록은 빈 막대', () => {
    expect(languageSegments([{ name: 'Vue', percent: 99.5 }, { name: 'Shell', percent: 0.5 }], '기타'))
      .toEqual([{ name: 'Vue', percent: 99.5, tone: 'primary' }, { name: '기타', percent: 0.5, tone: 'muted' }])
    expect(languageSegments([], '기타')).toEqual([])
  })
})
