/**
 * Git 라우트(결정 Git 2): /code/:owner/:repo/(tree|blob|issues|pulls|commits).
 *  /code                               → 저장소 목록
 *  /code/o/r                            → 코드(루트)
 *  /code/o/r/tree/a/b                   → 코드(폴더)
 *  /code/o/r/blob/a/b.ts#L12-L20        → 파일 보기(줄 링크는 해시)
 *  /code/o/r/issues · /issues/91        → 이슈 목록 · 상세
 *  /code/o/r/pulls · /pulls/12          → PR 목록 · 상세
 *  /code/o/r/commits                    → 커밋
 * 브랜치는 경로가 아니라 ?ref= 로 둔다(브랜치 이름에 / 가 들어갈 수 있어 경로와 섞이면 모호하다).
 */

export type GitTab = 'code' | 'issues' | 'pulls' | 'commits'

export type GitRoute =
  | { view: 'repos' }
  | {
      view: 'repo'
      owner: string
      repo: string
      tab: GitTab
      /** code: 폴더/파일 경로 */
      path: string
      /** code: tree(폴더) | blob(파일) */
      kind: 'tree' | 'blob'
      /** issues/pulls 상세 번호 */
      number: number | null
    }
  | { view: 'invalid' }

export function parseGitRoute(slug: string[] | string | undefined): GitRoute {
  const parts = (Array.isArray(slug) ? slug : slug ? [slug] : []).filter(Boolean)
  if (parts.length === 0) return { view: 'repos' }
  if (parts.length === 1) return { view: 'invalid' }
  const [owner, repo, seg, ...rest] = parts
  const base = { view: 'repo' as const, owner, repo, path: '', kind: 'tree' as const, number: null }
  if (!seg) return { ...base, tab: 'code' }
  if (seg === 'tree' || seg === 'blob') {
    return { ...base, tab: 'code', kind: seg, path: rest.join('/') }
  }
  if (seg === 'issues' || seg === 'pulls') {
    if (rest.length > 1) return { view: 'invalid' }
    const n = rest[0] ? Number(rest[0]) : null
    if (rest[0] && (!Number.isInteger(n) || (n as number) <= 0)) return { view: 'invalid' }
    return { ...base, tab: seg, number: n }
  }
  if (seg === 'commits' && rest.length === 0) return { ...base, tab: 'commits' }
  return { view: 'invalid' }
}

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')

export function gitPath(opts: { owner: string; repo: string; tab?: GitTab; path?: string; kind?: 'tree' | 'blob'; number?: number | null }): string {
  const root = `/code/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`
  const tab = opts.tab ?? 'code'
  if (tab === 'code') {
    if (!opts.path) return root
    return `${root}/${opts.kind ?? 'tree'}/${enc(opts.path)}`
  }
  if ((tab === 'issues' || tab === 'pulls') && opts.number) return `${root}/${tab}/${opts.number}`
  return `${root}/${tab}`
}

/** #L12 · #L12-L20 → [12, 20] */
export function parseLineHash(hash: string | undefined | null): [number, number] | null {
  const m = /^#L(\d+)(?:-L(\d+))?$/.exec(hash || '')
  if (!m) return null
  const a = Number(m[1])
  const b = m[2] ? Number(m[2]) : a
  return a <= b ? [a, b] : [b, a]
}

export function lineHash(a: number, b?: number | null): string {
  return b && b !== a ? `#L${Math.min(a, b)}-L${Math.max(a, b)}` : `#L${a}`
}
