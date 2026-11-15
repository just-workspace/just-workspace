// 승인 입구(사용자 결정): 레일 '승인'은 대기 건이 있을 때만 배지와 함께, 실시간 approvals.count 이벤트로 건수 갱신,
// 건수가 늘고 대기함 밖이면 토스트(B2-4), AI 사이드바 진입 칸.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({ count: 1, calls: [] as string[] }))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => {
    api.calls.push(url)
    if (url === '/api/approvals/count') return { pending: api.count }
    if (url === '/api/approvals' && opts?.query?.view === 'pending') {
      return { items: [{ id: 'apv_n', title: '외부 공유 링크 만들기', target_summary: '2026 랩실 구성안.pdf', source: 'mcp', client_name: 'Claude', status: 'pending' }], has_more: false, next_cursor: null, pending: api.count }
    }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { LayoutSidebar } = await import('~/components/layout/Sidebar')
const { ApprovalsEntry } = await import('~/components/approvals/ApprovalsEntry')
const { approvalsStore, ensureApprovals, _resetApprovals, setApprovalsCount } = await import('~/composables/useApprovals')
const { handleWSMessage } = await import('~/composables/useChat')
const { toastStore } = await import('~/composables/useToast')
const { platformStore } = await import('~/composables/usePlatform')
const { setUser } = await import('~/composables/useAuth')
const { i18n } = await import('~/i18n')
const t = (k: string, v?: Record<string, unknown>) => i18n.t(k, v)

const USER = { id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null }

function renderAt(path: string, el: React.ReactNode) {
  const router = createMemoryRouter([{ path: '*', element: el }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  _resetApprovals()
  api.count = 1
  api.calls = []
  toastStore.setState({ toasts: [] })
  setUser(USER as any)
  platformStore.setState({
    loaded: true,
    modules: [
      { id: 'files', name: '파일', icon: 'folder', route: '/files', type: 'builtin', requires: [], enabled: true, category: 'content' },
      { id: 'ai', name: 'AI', icon: 'sparkles', route: '/ai', type: 'builtin', requires: [], enabled: true, category: 'ai' },
    ] as any,
  })
  try { window.history.replaceState(null, '', '/') } catch { /* */ }
})

describe('레일 승인 항목', () => {
  it('대기 0 이면 없다', () => {
    approvalsStore.setState({ pending: 0 })
    const { container } = renderAt('/', <LayoutSidebar />)
    expect(container.querySelector('a[href="/ai"]')).not.toBeNull()
    expect(container.querySelector('a[href="/approvals"]')).toBeNull()
  })

  it('대기 > 0 이면 AI 뒤에 배지와 함께, 0 이 되면 사라진다', () => {
    approvalsStore.setState({ pending: 3 })
    const { container } = renderAt('/', <LayoutSidebar />)
    const link = container.querySelector('a[href="/approvals"]')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('aria-label')).toBe(t('approvals.railAria', { n: 3 }))
    expect(link!.textContent).toContain('3')
    // AI 바로 뒤
    const hrefs = [...container.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
    expect(hrefs.indexOf('/approvals')).toBe(hrefs.indexOf('/ai') + 1)
    act(() => { approvalsStore.setState({ pending: 0 }) })
    expect(container.querySelector('a[href="/approvals"]')).toBeNull()
  })

  it('대기함 화면에서는 활성', () => {
    approvalsStore.setState({ pending: 1 })
    const { container } = renderAt('/approvals', <LayoutSidebar />)
    expect(container.querySelector('a[href="/approvals"]')?.getAttribute('aria-current')).toBe('page')
  })
})

describe('실시간 건수', () => {
  it('처음 값은 /count, 소켓 approvals.count 로 갱신 → 레일 배지도 따라간다', async () => {
    ensureApprovals()
    await waitFor(() => expect(approvalsStore.getState().pending).toBe(1))
    expect(api.calls).toContain('/api/approvals/count')
    const { container } = renderAt('/', <LayoutSidebar />)
    expect(container.querySelector('a[href="/approvals"]')?.textContent).toContain('1')
    act(() => { handleWSMessage({ type: 'approvals.count', pending: 4 }) })
    expect(approvalsStore.getState().pending).toBe(4)
    expect(container.querySelector('a[href="/approvals"]')?.textContent).toContain('4')
    act(() => { handleWSMessage({ type: 'approvals.count', pending: 0 }) })
    expect(container.querySelector('a[href="/approvals"]')).toBeNull()
  })

  it('늘었고 대기함 밖이면 토스트(최근 요청 요약 + 열어서 확인)', async () => {
    ensureApprovals()
    await waitFor(() => expect(approvalsStore.getState().pending).toBe(1))
    act(() => { handleWSMessage({ type: 'approvals.count', pending: 2 }) })
    await waitFor(() => expect(toastStore.getState().toasts.length).toBe(1))
    const toast = toastStore.getState().toasts[0]
    expect(toast.message).toBe(t('approvals.toast.title', { n: 1 }))
    expect(toast.description).toContain('2026 랩실 구성안.pdf')
    expect(toast.action?.label).toBe(t('approvals.toast.open'))
  })

  it('줄었거나 대기함 화면이면 토스트 없음', async () => {
    approvalsStore.setState({ pending: 3 })
    setApprovalsCount(1, { notify: true, event: true })
    window.history.replaceState(null, '', '/approvals')
    setApprovalsCount(5, { notify: true, event: true })
    await new Promise(r => setTimeout(r, 20))
    expect(toastStore.getState().toasts.length).toBe(0)
    expect(approvalsStore.getState().pending).toBe(5)
  })
})

describe('AI 사이드바 진입 칸', () => {
  it('늘 보이고, 대기 건이 있으면 숫자', () => {
    approvalsStore.setState({ pending: 0 })
    renderAt('/ai', <ApprovalsEntry />)
    const link = screen.getByRole('link', { name: t('approvals.title') })
    expect(link.getAttribute('href')).toBe('/approvals')
    act(() => { approvalsStore.setState({ pending: 2 }) })
    expect(screen.getByRole('link', { name: t('approvals.entry.aria', { n: 2 }) }).textContent).toContain('2')
  })

  it('모바일 띠는 대기 건이 있을 때만', () => {
    approvalsStore.setState({ pending: 0 })
    const { container } = renderAt('/ai', <ApprovalsEntry variant="mobile" />)
    expect(container.querySelector('a')).toBeNull()
    act(() => { approvalsStore.setState({ pending: 1 }) })
    expect(container.querySelector('a[href="/approvals"]')).not.toBeNull()
  })
})
