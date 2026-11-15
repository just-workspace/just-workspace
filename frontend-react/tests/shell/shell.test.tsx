// 셸 렌더: 로그인 사용자로 기본 레이아웃(데스크톱·모바일 폭)이 사이드바·상단바·탭바를 그리고,
// 로그인 전 404 는 인증 틀, 로그인 후 404 는 셸 안에 뜨는지. ($fetch 는 가짜 — tests/router/routes.test.tsx 와 같은 방식)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router'

const apiMock = vi.hoisted(() => ({
  user: { id: 'u1', username: 'admin', display_name: 'Admin', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: true, last_login_at: null } as Record<string, unknown> | null,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => {
    if (url === '/api/auth/me') { if (!apiMock.user) throw Object.assign(new Error('401'), { statusCode: 401 }); return apiMock.user }
    if (url === '/api/setup/status') return { needs_setup: false }
    if (url === '/api/health') return { service: 'Workspace', config: {} }
    if (url === '/api/platform/modules') {
      return { modules: [
        { id: 'mail', name: '메일', icon: 'mail', route: '/mail', type: 'builtin', requires: [], enabled: true, category: 'communication' },
        { id: 'chat', name: '채팅', icon: 'chat', route: '/chat', type: 'builtin', requires: [], enabled: true, category: 'communication' },
        { id: 'files', name: '파일', icon: 'folder', route: '/files', type: 'builtin', requires: [], enabled: true, category: 'content' },
      ] }
    }
    if (url === '/api/chat/channels' || url === '/api/chat/users') return []
    if (url === '/api/chat/drafts' || url === '/api/chat/saved') return { items: [] }
    if (url === '/api/notifications/') return { notifications: [], total: 0 }
    if (url === '/api/notifications/unread-count') return { count: 0 }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { i18n } = await import('~/i18n')
const { DefaultLayout } = await import('~/layouts/default')
const { createTestRouter } = await import('~/router')
const { authStore, setUser } = await import('~/composables/useAuth')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { platformStore } = await import('~/composables/usePlatform')
const { _resetGuards } = await import('~/router/guards')
const { resetSharedState } = await import('~/lib/state')
const { setTitle, clearAllTitles } = await import('~/composables/useShellTitle')

const t = (k: string) => i18n.t(k)

function shellRouter(path: string) {
  return createMemoryRouter([
    {
      Component: DefaultLayout,
      children: [
        { path: '/', element: <div data-testid="page-body">본문</div> },
        { path: '/files', element: <div data-testid="page-body">파일</div> },
      ],
    },
  ], { initialEntries: [path] })
}

beforeEach(() => {
  _resetGuards()
  resetSharedState()
  platformStore.setState({ modules: [], loaded: false })
  isMobileStore.setState({ isMobile: false })
})

describe('기본 셸(로그인 사용자)', () => {
  beforeEach(() => { setUser(apiMock.user as any) })

  it('데스크톱 폭: 사이드바(레일)·상단바(3단 경로)·탭바(md:hidden) · 본문', async () => {
    const router = shellRouter('/files')
    const { container, unmount } = render(<RouterProvider router={router} />)
    await waitFor(() => expect(container.querySelector('[data-testid="page-body"]')).not.toBeNull())
    // 사이드바: 모듈 목록을 받으면 레일에 항목이 생긴다
    await waitFor(() => expect(container.querySelector('aside a[href="/files"]')).not.toBeNull())
    const aside = container.querySelector('aside')!
    expect(aside.querySelector(`a[aria-label="${t('shell.tab.home')}"]`)).not.toBeNull()
    expect(aside.querySelector('a[href="/files"]')?.getAttribute('aria-current')).toBe('page')
    // 상단바: 워크스페이스 / 파일
    const crumb = container.querySelector(`header nav[aria-label="${t('shell.topbar.breadcrumb')}"]`)
    expect(crumb).not.toBeNull()
    expect(crumb!.textContent).toContain(t('shell.topbar.workspace'))
    expect(crumb!.textContent).toContain(t('nav.files'))
    // 벨(활동)·사용자 메뉴 단추
    expect(container.querySelector(`header button[aria-label="${i18n.t('shell.topbar.userMenuFor', { name: 'Admin' })}"]`)).not.toBeNull()
    // 하단 탭바는 그려지되 CSS(md:hidden)로 데스크톱에서 숨는다
    const tabbar = container.querySelector(`nav[aria-label="${t('shell.tab.mainMenu')}"]`)
    expect(tabbar).not.toBeNull()
    expect(tabbar!.className).toContain('md:hidden')
    act(() => unmount())
    router.dispose()
  })

  it('모바일 폭: 사이드바 없음 · 상단바 제목 한 줄 · 하단 탭바(홈·채팅·활동·메일·전체)', async () => {
    isMobileStore.setState({ isMobile: true })
    const router = shellRouter('/')
    const { container, unmount } = render(<RouterProvider router={router} />)
    await waitFor(() => expect(container.querySelector('[data-testid="page-body"]')).not.toBeNull())
    expect(container.querySelector('aside')).toBeNull()
    // 상단바: 3단 경로 대신 제목(h1) — 홈
    expect(container.querySelector(`header nav[aria-label="${t('shell.topbar.breadcrumb')}"]`)).toBeNull()
    expect(container.querySelector('header h1')?.textContent).toBe(t('shell.tab.home'))
    const tabbar = container.querySelector(`nav[aria-label="${t('shell.tab.mainMenu')}"]`)!
    expect(tabbar).not.toBeNull()
    await waitFor(() => {
      const labels = Array.from(tabbar.querySelectorAll('button')).map(b => b.textContent)
      expect(labels).toEqual([t('shell.tab.home'), t('nav.chat'), t('shell.activity.title'), t('nav.mail'), t('common.all')])
    })
    // 홈 탭이 활성
    expect(tabbar.querySelector('button[aria-current="page"]')?.textContent).toBe(t('shell.tab.home'))
    act(() => unmount())
    router.dispose()
  })
})

describe('상단바 제목 덮어쓰기(__WS_SHELL__.setTitle)', () => {
  beforeEach(() => { setUser(apiMock.user as any); clearAllTitles() })

  it('데스크톱: 경로 마지막 칸 · 모바일: 머리 제목 — 풀면 원래대로', async () => {
    const router = shellRouter('/files')
    const { container, unmount } = render(<RouterProvider router={router} />)
    await waitFor(() => expect(container.querySelector('[data-testid="page-body"]')).not.toBeNull())
    const crumb = () => container.querySelector(`header nav[aria-label="${t('shell.topbar.breadcrumb')}"]`)!
    act(() => { setTitle('보고서 초안') })
    expect(crumb().textContent).toContain(t('nav.files'))
    expect(crumb().lastElementChild?.textContent).toContain('보고서 초안')
    act(() => { isMobileStore.setState({ isMobile: true }) })
    expect(container.querySelector('header h1')?.textContent).toBe('보고서 초안')
    act(() => { setTitle(null) })
    await waitFor(() => expect(container.querySelector('header h1')?.textContent).not.toBe('보고서 초안'))
    act(() => { isMobileStore.setState({ isMobile: false }) })
    expect(crumb().textContent).not.toContain('보고서 초안')
    act(() => unmount())
    router.dispose()
  })
})

describe('404', () => {
  it('로그인 전: 인증 틀(AuthShell) 위 404 — 셸 없음', async () => {
    const saved = apiMock.user
    apiMock.user = null
    authStore.setState({ user: null, loading: true })
    try {
      const router = createTestRouter(['/no-such-page'])
      const { container, unmount } = render(<RouterProvider router={router} />)
      await waitFor(() => expect(container.textContent).toContain('404'))
      expect(router.state.location.pathname).toBe('/no-such-page')
      expect(container.querySelector('.auth-brand-panel')).not.toBeNull()
      expect(container.querySelector('h1')?.textContent).toBe(t('error.404.title'))
      expect(container.querySelector('header')).toBeNull()
      expect(container.querySelector('aside')).toBeNull()
      act(() => unmount())
      router.dispose()
    } finally {
      apiMock.user = saved
    }
  })

  it('로그인 후: 셸(사이드바·상단바) 안 404 · 상단바 위치 "찾을 수 없음"', async () => {
    authStore.setState({ user: null, loading: true })
    const router = createTestRouter(['/no-such-page'])
    const { container, unmount } = render(<RouterProvider router={router} />)
    await waitFor(() => expect(container.textContent).toContain('404'))
    expect(container.querySelector('.auth-brand-panel')).toBeNull()
    expect(container.querySelector('aside')).not.toBeNull()
    const crumb = container.querySelector(`header nav[aria-label="${t('shell.topbar.breadcrumb')}"]`)
    expect(crumb).not.toBeNull()
    await waitFor(() => expect(crumb!.textContent).toContain(t('error.404.crumb')))
    expect(container.querySelector('main h1')?.textContent).toBe(t('error.404.title'))
    // (경로 줄은 토대 NotFound 가 window.location 을 넘겨 메모리 라우터에선 '/' — 여기서는 보지 않는다)
    act(() => unmount())
    router.dispose()
  })
})
