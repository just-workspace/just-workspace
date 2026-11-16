// 작업: 목록 상태 규칙(upsert·remove), 화면 렌더 — 마감 묶음·집계, 빠른 입력(@담당 → 사용자), 칩 필터 = 서버 재조회,
// 완료 토글(낙관적), 행 선택 = ?task= + 상세 패널(하위 작업). ($fetch 는 모의(mock))
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, waitFor, screen } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
}))

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const task = (id: string, o: Record<string, unknown> = {}) => ({
  id, user_id: 'u1', title: id, description: null, due_date: null, priority: 'medium', status: 'todo', sort_order: 0, parent_id: null,
  subtask_count: 0, completed_subtask_count: 0, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  assignee_id: 'u1', assignee_name: 'Me', tags: [], project: null, ...o,
})

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => {
    api.calls.push({ url, opts })
    if (url.startsWith('/api/tasks/?')) {
      return { tasks: [task('오늘 할 일', { due_date: today() }), task('나중 일')], total: 2 }
    }
    if (url === '/api/chat/users') return [{ id: 'u2', username: 'kim', display_name: '김철수', avatar_url: null }]
    if (url === '/api/tasks/facets') return { projects: [], tags: [] }
    if (url === '/api/tasks/' && opts.method === 'POST') return task('new1', { title: opts.body.title, assignee_id: opts.body.assignee_id })
    if (/\/api\/tasks\/[^/]+\/toggle$/.test(url)) return task('나중 일', { status: 'done' })
    if (/\/subtasks/.test(url)) return { tasks: [task('하위1', { parent_id: '나중 일', status: 'done' })], total: 1 }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: TasksPage } = await import('~/pages/tasks')
const { upsertInto, removeFrom } = await import('~/composables/useTasks')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')
const { i18n } = await import('~/i18n')
const t = (k: string, a?: any) => i18n.t(k, a)

beforeEach(() => {
  api.calls = []
  isMobileStore.setState({ isMobile: false })
  setUser({ id: 'u1', username: 'me', display_name: 'Me', email: 'me@x.test' } as any)
})

describe('useTasks 목록 규칙', () => {
  const s0 = { tasks: [task('a'), task('b')] as any[], total: 2, loading: false, error: false }
  it('있으면 제자리 교체, 없으면 최상위만 앞에 넣고 total+1, 하위 작업은 넣지 않는다', () => {
    expect(upsertInto(s0, task('b', { title: 'B' }) as any).tasks.map((x: any) => x.title)).toEqual(['a', 'B'])
    const s1 = upsertInto(s0, task('c') as any)
    expect(s1.tasks[0].id).toBe('c'); expect(s1.total).toBe(3)
    expect(upsertInto(s0, task('d', { parent_id: 'a' }) as any)).toBe(s0)
  })
  it('remove 는 total 을 0 아래로 내리지 않는다', () => {
    expect(removeFrom({ ...s0, total: 0 }, 'a').total).toBe(0)
    expect(removeFrom(s0, 'zz')).toBe(s0)
  })
})

describe('작업 화면', () => {
  it('목록·묶음·집계, 빠른 입력 @담당 → 사용자로 저장', async () => {
    renderInRouter(<TasksPage />, '/tasks')
    expect(await screen.findByRole('button', { name: '오늘 할 일' })).toBeTruthy()
    expect(api.calls.find(c => c.url.startsWith('/api/tasks/?'))!.url).toBe('/api/tasks/?sort_by=created_at&sort_dir=desc&limit=200')
    expect(screen.getByRole('region', { name: `${t('common.today')} 1` })).toBeTruthy()
    const input = screen.getAllByLabelText(t('tasks.new.inputLabel'))[0]
    fireEvent.change(input, { target: { value: '보고서 쓰기 @김철수' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await waitFor(() => expect(api.calls.some(c => c.opts.method === 'POST')).toBe(true))
    const post = api.calls.find(c => c.opts.method === 'POST')!
    expect(post.opts.body).toMatchObject({ title: '보고서 쓰기', assignee_id: 'u2', priority: 'medium' })
  })

  it('브라우저 탭 제목은 화면·내비와 같은 "작업"(옛 "할 일" 아님)', async () => {
    renderInRouter(<TasksPage />, '/tasks')
    await screen.findByRole('button', { name: '오늘 할 일' })
    await waitFor(() => expect(document.title.startsWith(`${t('tasks.heading')} |`)).toBe(true))
  })

  it('"진행 중" 칩 = 서버 재조회(status=in_progress)', async () => {
    renderInRouter(<TasksPage />, '/tasks')
    await screen.findByRole('button', { name: '오늘 할 일' })
    fireEvent.click(screen.getByRole('button', { name: t('tasks.statusInProgress'), pressed: false }))
    await waitFor(() => expect(api.calls.some(c => c.url.includes('status=in_progress'))).toBe(true))
  })

  it('완료 토글은 낙관적으로 줄을 긋고 /toggle 을 부른다', async () => {
    renderInRouter(<TasksPage />, '/tasks')
    const row = await screen.findByRole('button', { name: '나중 일' })
    const check = row.querySelector('[role="checkbox"]') as HTMLElement
    await act(async () => { fireEvent.click(check) })
    expect(api.calls.some(c => c.url === '/api/tasks/나중 일/toggle')).toBe(true)
    // 완료로 변경되면 "완료" 묶음으로 이동(행이 다시 렌더링됨)
    await waitFor(() => expect(screen.getByRole('button', { name: '나중 일' }).querySelector('[role="checkbox"]')!.getAttribute('aria-checked')).toBe('true'))
    expect(screen.getByRole('region', { name: `${t('tasks.statusDone')} 1` })).toBeTruthy()
  })

  it('?task= 링크 → 상세 패널(제목·하위 작업 1/1), 선택 행 aria-current', async () => {
    renderInRouter(<TasksPage />, '/tasks?task=' + encodeURIComponent('나중 일'))
    expect((await screen.findByRole('button', { name: '나중 일' })).getAttribute('aria-current')).toBe('true')
    const panel = await screen.findByRole('complementary', { name: t('tasks.detailLabel') })
    expect((panel.querySelector('textarea') as HTMLTextAreaElement).value).toBe('나중 일')
    await waitFor(() => expect(panel.textContent).toContain('1 / 1'))
  })
})
