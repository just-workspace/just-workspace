// Git store — 요청 주소·매개변수, 지연 도착 응답 폐기, 이슈 수정 시 목록·상세·열린 수 동기화
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_url: string, _opts: any): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const git = await import('~/composables/useGit')
const { gitStore } = git

const repo = (o: Record<string, unknown> = {}) => ({
  id: 1, name: 'r', full_name: 'o/r', description: '', owner: { login: 'o', avatar_url: '' }, html_url: 'http://g/o/r',
  default_branch: 'main', stars_count: 2, forks_count: 0, open_issues_count: 3, updated_at: '', language: 'Go', private: false,
  readme: null, size: 1, created_at: '', ...o,
})
const issue = (n: number, o: Record<string, unknown> = {}) => ({
  number: n, title: `#${n}`, body: '', state: 'open', user: null, labels: [], comments: 0, created_at: '', updated_at: '', ...o,
})

beforeEach(() => {
  git._resetGitStore()
  api.calls = []
  api.handler = () => ({})
})

describe('useGit', () => {
  it('ensureRepo: 저장소를 받고 기본 브랜치·부가 정보를 부른다, 같은 저장소면 다시 받지 않는다', async () => {
    api.handler = (url) => {
      if (url === '/api/git/repos/o/r') return repo()
      if (url.endsWith('/commits')) return [{ sha: 'abc' }]
      if (url.endsWith('/languages')) return { languages: [] }
      return []
    }
    await git.ensureRepo('o', 'r')
    const s = gitStore.getState()
    expect(s.selectedRepo?.name).toBe('r')
    expect(s.currentBranch).toBe('main')
    expect(s.latestCommit).toEqual({ sha: 'abc' })
    const urls = api.calls.map(c => c.url)
    expect(urls).toContain('/api/git/repos/o/r/branches')
    expect(urls).toContain('/api/git/repos/o/r/labels')
    expect(urls).toContain('/api/git/repos/o/r/stats')

    api.calls = []
    await git.ensureRepo('O', 'R', 'dev')
    expect(api.calls.map(c => c.url)).toEqual(['/api/git/repos/o/r/commits'])
    expect(api.calls[0].opts.params).toEqual({ sha: 'dev', page: 1 })
    expect(gitStore.getState().currentBranch).toBe('dev')
  })

  it('fetchContents: 폴더 먼저·이름순, 뒤이어 with_commits 로 마지막 커밋을 채운다', async () => {
    gitStore.setState({ selectedRepo: repo() as any, currentBranch: 'main' })
    api.handler = (_url, opts) => opts.params.with_commits
      ? [{ path: 'b.ts', last_commit: { sha: '1', message: 'm', author_name: 'a', date: 'd' } }]
      : [{ name: 'b.ts', path: 'b.ts', type: 'file' }, { name: 'z', path: 'z', type: 'dir' }, { name: 'a.ts', path: 'a.ts', type: 'file' }]
    await git.fetchContents('')
    await new Promise(r => setTimeout(r, 0))
    const c = gitStore.getState().contents
    expect(c.map(e => e.name)).toEqual(['z', 'a.ts', 'b.ts'])
    expect(c[2].last_commit?.message).toBe('m')
    expect(c[0].last_commit).toBeNull()
    expect(api.calls[0].opts.params).toEqual({ ref: 'main' })
  })

  it('늦게 온 이전 응답은 버린다', async () => {
    gitStore.setState({ selectedRepo: repo() as any })
    let release!: (v: unknown) => void
    api.handler = (_url, opts) => opts.params.page === 1 && opts.params.state === 'open' && !gitStore.getState().issues.length && !release
      ? new Promise(r => { release = r })
      : [issue(2)]
    const first = git.fetchIssues()
    await git.fetchIssues()
    release([issue(1)])
    await first
    expect(gitStore.getState().issues.map(i => i.number)).toEqual([2])
    expect(gitStore.getState().issuesLoading).toBe(false)
  })

  it('updateIssue: 닫으면 열린 목록에서 빠지고 열린 이슈 수가 준다', async () => {
    gitStore.setState({ selectedRepo: repo() as any, issues: [issue(1), issue(2)] as any, selectedIssue: issue(1) as any })
    api.handler = (url, opts) => (url.endsWith('/stats') ? { open_issues: 2 } : opts.method === 'PATCH' ? issue(1, { state: 'closed' }) : {})
    await git.updateIssue(1, { state: 'closed' })
    const s = gitStore.getState()
    expect(s.issues.map(i => i.number)).toEqual([2])
    expect(s.selectedIssue?.state).toBe('closed')
    expect(s.selectedRepo?.open_issues_count).toBe(2)
    expect(api.calls[0]).toMatchObject({ url: '/api/git/repos/o/r/issues/1', opts: { method: 'PATCH', body: { state: 'closed' } } })
  })

  it('labelCounts: 열린 이슈의 라벨만 센다 · labelById 는 모르는 id 에 ? 라벨', () => {
    const l1 = { id: 1, name: 'bug', color: 'f00' }
    gitStore.setState({ issues: [issue(1, { labels: [l1] }), issue(2, { labels: [l1], state: 'closed' }), issue(3, { labels: [l1] })] as any })
    const { result } = renderHook(() => git.useGit())
    expect(result.current.labelCounts.get(1)).toBe(2)
    expect(git.labelById(9)).toEqual({ id: 9, name: '?', color: '888888' })
  })

  it('toggleStar: 409 면 unavailable', async () => {
    gitStore.setState({ selectedRepo: repo() as any, starred: false })
    api.handler = () => { throw Object.assign(new Error('x'), { status: 409 }) }
    expect(await git.toggleStar()).toBe('unavailable')
    expect(gitStore.getState().starUnavailable).toBe(true)
  })
})
