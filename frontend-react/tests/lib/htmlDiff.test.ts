import { describe, it, expect } from 'vitest'
import { diffSeq, diffWordsHtml, diffHtml, diffStats } from '~/utils/htmlDiff'
import { extractToc, withHeadingIds } from '~/utils/htmlToc'

describe('diffSeq', () => {
  it('같은 수열은 전부 equal', () => {
    expect(diffSeq([1, 2, 3], [1, 2, 3]).every(o => o.type === 'equal')).toBe(true)
  })
  it('삽입·삭제를 찾는다', () => {
    const ops = diffSeq(['a', 'b', 'c'], ['a', 'x', 'c'])
    expect(ops.map(o => o.type)).toEqual(['equal', 'delete', 'insert', 'equal'])
  })
})

describe('diffWordsHtml', () => {
  it('바뀐 단어만 del/ins 로 감싼다', () => {
    const r = diffWordsHtml('저장소는 GitHub 에서 받습니다.', '저장소는 사내 Git 에서 받습니다.')
    expect(r.html).toContain('<del>GitHub</del>')
    expect(r.html).toMatch(/<ins>사내 Git\s?<\/ins>/)
    expect(r.removed).toBe(1)
    expect(r.added).toBe(2)
  })
  it('HTML 특수문자를 이스케이프한다', () => {
    expect(diffWordsHtml('a', '<b>').html).toContain('&lt;b&gt;')
  })
})

describe('diffHtml', () => {
  it('같은 문단은 원래 HTML 을 유지한다', () => {
    const html = '<p>그대로 <strong>굵게</strong></p>'
    expect(diffHtml(html, html).html).toBe(html)
  })
  it('수정된 문단은 단어 단위로, 새 문단은 통째로 ins', () => {
    const r = diffHtml('<p>하나 둘</p>', '<p>하나 셋</p><p>새 문단</p>')
    expect(r.html).toContain('<p>하나 <del>둘</del><ins>셋</ins></p>')
    expect(r.html).toContain('<p><ins>새 문단</ins></p>')
    expect(r.added).toBe(3)
    expect(r.removed).toBe(1)
  })
  it('목록 항목 하나만 바뀌면 목록 전체를 교체로 보지 않는다', () => {
    const r = diffHtml('<ul><li>가</li><li>나</li></ul>', '<ul><li>가</li><li>다</li></ul>')
    expect(r.html).toContain('<li>가</li>')
    expect(r.html).toContain('<del>나</del><ins>다</ins>')
  })
  it('diffStats 는 단어 수를 센다', () => {
    expect(diffStats('<p>a b</p>', '<p>a b c d</p>')).toEqual({ added: 2, removed: 0 })
  })
})

describe('htmlToc', () => {
  it('h1~h3 를 순서대로 뽑고 id 를 붙인다', () => {
    const toc = extractToc('<h2>첫 주에 할 일</h2><p>x</p><h3>개발 환경</h3><h4>무시</h4>')
    expect(toc.map(t => [t.level, t.text])).toEqual([[2, '첫 주에 할 일'], [3, '개발 환경']])
    const html = withHeadingIds('<h2>첫 주에 할 일</h2>')
    expect(html).toContain(`id="${toc[0].id}"`)
  })
})
