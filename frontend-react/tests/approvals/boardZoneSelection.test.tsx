// 승인 대기함 — 주소로 고르지 않은 상세(데스크톱 자동 선택)는 한 번 정하면 바뀌지 않는다.
// 읽는 중에 새 요청이 맨 위에 붙어도 상세·[승인] 대상이 그대로여야 한다(안 읽은 요청을 승인하는 사고 방지).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  pending: [] as any[],
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    const now = new Date().toISOString()
    if (url === '/api/approvals') return { items: api.pending, has_more: false, next_cursor: null, pending: api.pending.length, server_now: now }
    if (url === '/api/approvals/count') return { pending: api.pending.length }
    const m = url.match(/^\/api\/approvals\/([^/]+)(?:\/(\w+))?$/)
    if (m) {
      const base = api.pending.find(p => p.id === m[1])
      if (!base) throw Object.assign(new Error('404'), { statusCode: 404 })
      if (m[2] === 'approve') return { ...base, status: 'executed', decided_at: now, executed_at: now, server_now: now }
      return { ...base, server_now: now }
    }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: ApprovalsPage } = await import('~/pages/approvals')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')
const { approvalsStore } = await import('~/composables/useApprovals')
const { i18n } = await import('~/i18n')

const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
function item(id: string) {
  const now = Date.now()
  return {
    id, tool: 'files_share_external', title: `요청 ${id}`, risk: 'high', status: 'pending', source: 'mcp',
    client_kind: 'claude_app', client_name: 'Claude', target_summary: `대상 ${id}`, conversation_id: null,
    after_untrusted: false, args: {}, preview: [], editable: [], read_external: null, result: null, error: null, reject_reason: null,
    created_at: iso(now - MIN), expires_at: iso(now + 20 * MIN), decided_at: null, executed_at: null,
    can_undo: false, undo_until: null, server_now: iso(now),
  }
}
const rowOf = (id: string) => screen.getAllByRole('button').find(b => b.hasAttribute('aria-pressed') && b.textContent?.includes(`요청 ${id}`))

beforeEach(() => {
  api.calls = []
  api.pending = []
  isMobileStore.setState({ isMobile: false } as any)
  approvalsStore.setState({ pending: null, seq: 0 } as any)
  setUser({ id: 'u1', username: 'qa', display_name: '검수', is_admin: false } as any)
})

describe('승인 대기함 자동 선택', () => {
  it('새 요청이 맨 위에 와도 읽던 요청이 그대로 선택돼 있고, [승인]은 읽던 요청에 간다', async () => {
    api.pending = [item('a')]
    const router = createMemoryRouter([{ path: '/approvals', element: <ApprovalsPage /> }], { initialEntries: ['/approvals'] })
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(rowOf('a')?.getAttribute('aria-pressed')).toBe('true'))

    // 새 요청 b 가 도착(대기 건수 이벤트 → 조용한 새로 고침, 최신이 맨 위)
    api.pending = [item('b'), item('a')]
    await act(async () => { approvalsStore.setState({ seq: approvalsStore.getState().seq + 1 } as any) })
    await waitFor(() => expect(rowOf('b')).toBeTruthy())
    expect(rowOf('a')?.getAttribute('aria-pressed')).toBe('true')
    expect(rowOf('b')?.getAttribute('aria-pressed')).toBe('false')

    // 승인은 a 로 간다
    fireEvent.click(screen.getByRole('button', { name: i18n.t('approvals.detail.approve') }))
    await waitFor(() => expect(api.calls.some(c => /\/approve$/.test(c.url))).toBe(true))
    expect(api.calls.filter(c => /\/approve$/.test(c.url)).map(c => c.url)).toEqual(['/api/approvals/a/approve'])

    // 처리한 뒤에도 다음 대기 요청으로 넘어가지 않는다(사용자가 고를 때까지)
    api.pending = [item('b')]
    await act(async () => { approvalsStore.setState({ seq: approvalsStore.getState().seq + 1 } as any) })
    await waitFor(() => expect(rowOf('a')?.getAttribute('aria-pressed')).toBe('true'))
    expect(rowOf('b')?.getAttribute('aria-pressed')).toBe('false')
  })
})
