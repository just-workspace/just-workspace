import { describe, it, expect } from 'vitest'
import { parseGitRoute, gitPath, parseLineHash, lineHash } from '~/utils/gitRoute'

describe('parseGitRoute', () => {
  it('목록·코드 루트', () => {
    expect(parseGitRoute([])).toEqual({ view: 'repos' })
    expect(parseGitRoute(undefined)).toEqual({ view: 'repos' })
    expect(parseGitRoute(['just', 'ws'])).toMatchObject({ view: 'repo', owner: 'just', repo: 'ws', tab: 'code', path: '', kind: 'tree' })
  })
  it('tree·blob 경로', () => {
    expect(parseGitRoute(['just', 'ws', 'tree', 'frontend', 'pages'])).toMatchObject({ tab: 'code', kind: 'tree', path: 'frontend/pages' })
    expect(parseGitRoute(['just', 'ws', 'blob', 'README.md'])).toMatchObject({ tab: 'code', kind: 'blob', path: 'README.md' })
  })
  it('이슈·PR 목록과 상세', () => {
    expect(parseGitRoute(['o', 'r', 'issues'])).toMatchObject({ tab: 'issues', number: null })
    expect(parseGitRoute(['o', 'r', 'issues', '91'])).toMatchObject({ tab: 'issues', number: 91 })
    expect(parseGitRoute(['o', 'r', 'pulls', '3'])).toMatchObject({ tab: 'pulls', number: 3 })
    expect(parseGitRoute(['o', 'r', 'commits'])).toMatchObject({ tab: 'commits' })
  })
  it('잘못된 경로', () => {
    expect(parseGitRoute(['o'])).toEqual({ view: 'invalid' })
    expect(parseGitRoute(['o', 'r', 'issues', 'x'])).toEqual({ view: 'invalid' })
    expect(parseGitRoute(['o', 'r', 'issues', '0'])).toEqual({ view: 'invalid' })
    expect(parseGitRoute(['o', 'r', 'wiki'])).toEqual({ view: 'invalid' })
    expect(parseGitRoute(['o', 'r', 'commits', 'abc'])).toEqual({ view: 'invalid' })
  })
})

describe('gitPath', () => {
  it('왕복', () => {
    expect(gitPath({ owner: 'o', repo: 'r' })).toBe('/code/o/r')
    expect(gitPath({ owner: 'o', repo: 'r', path: 'a b/c.ts', kind: 'blob' })).toBe('/code/o/r/blob/a%20b/c.ts')
    expect(gitPath({ owner: 'o', repo: 'r', tab: 'issues', number: 9 })).toBe('/code/o/r/issues/9')
    expect(gitPath({ owner: 'o', repo: 'r', tab: 'commits' })).toBe('/code/o/r/commits')
  })
})

describe('줄 해시', () => {
  it('#L12 · #L20-L12', () => {
    expect(parseLineHash('#L12')).toEqual([12, 12])
    expect(parseLineHash('#L20-L12')).toEqual([12, 20])
    expect(parseLineHash('#foo')).toBeNull()
    expect(lineHash(5)).toBe('#L5')
    expect(lineHash(9, 3)).toBe('#L3-L9')
  })
})
