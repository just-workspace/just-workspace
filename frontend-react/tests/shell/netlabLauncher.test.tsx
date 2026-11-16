// 레일 '도구' 묶음 — 네트워크 랩은 NETLAB 주소가 있을 때만 표시, 외부 출처 새 탭(external).
// 격리 브라우저도 동일 묶음(사용 가능한 대상 + rbi 출처가 있을 때). ($fetch 는 모의(mock) — tests/shell/shell.test.tsx 와 동일 방식)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router'

const apiMock = vi.hoisted(() => ({
  netlab: '' as string,
  rbi: false,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => {
    if (url === '/api/auth/me') return { id: 'u1', username: 'qa', display_name: 'QA', is_admin: true }
    if (url === '/api/setup/status') return { needs_setup: false }
    if (url === '/api/health') return { service: 'Workspace', config: {}, netlab_url: apiMock.netlab }
    if (url === '/api/platform/modules') {
      return { modules: [
        { id: 'mail', name: '메일', icon: 'mail', route: '/mail', type: 'builtin', requires: [], enabled: true, category: 'communication' },
        { id: 'files', name: '파일', icon: 'folder', route: '/files', type: 'builtin', requires: [], enabled: true, category: 'content' },
        ...(apiMock.rbi ? [{ id: 'rbi', name: '격리 브라우저', icon: 'shield', route: '/rbi', type: 'builtin', requires: [], enabled: true, category: 'system' }] : []),
      ] }
    }
    if (url === '/api/rbi/targets') return { targets: [{ key: 'portal', name: 'Portal' }], sessions: [], public_origin: 'https://rbi.example.com' }
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
const { setUser } = await import('~/composables/useAuth')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { platformStore } = await import('~/composables/usePlatform')
const { siteConfigStore, fetchAppConfig } = await import('~/composables/useSiteConfig')
const { _resetGuards } = await import('~/router/guards')
const { resetSharedState } = await import('~/lib/state')
const { netlabLaunchUrl, netlabHost } = await import('~/composables/useNetLab')
const { railToolItems } = await import('~/composables/useRailTools')

const t = (k: string) => i18n.t(k)

function shellRouter() {
  return createMemoryRouter([
    { Component: DefaultLayout, children: [{ path: '/files', element: <div data-testid="page-body">파일</div> }] },
  ], { initialEntries: ['/files'] })
}

async function renderShell() {
  // 앱 부팅(App.tsx)이 수행하는 /api/health 조회 — netlab_url → siteConfig.netlabUrl
  await fetchAppConfig()
  const router = shellRouter()
  const r = render(<RouterProvider router={router} />)
  await waitFor(() => expect(r.container.querySelector('aside a[href="/files"]')).not.toBeNull())
  return { ...r, done: () => { act(() => r.unmount()); router.dispose() } }
}

beforeEach(() => {
  _resetGuards()
  resetSharedState()
  platformStore.setState({ modules: [], loaded: false })
  siteConfigStore.setState({ loaded: false, netlabUrl: '' })
  isMobileStore.setState({ isMobile: false })
  apiMock.netlab = ''
  apiMock.rbi = false
  setUser({ id: 'u1', username: 'qa', display_name: 'QA', is_admin: true } as any)
})

describe('NetLab 주소', () => {
  it('https 만 쓰고 끝 / 를 뗀다 · 호스트 뽑기', () => {
    expect(netlabLaunchUrl('https://lab.example.com/')).toBe('https://lab.example.com')
    expect(netlabLaunchUrl('')).toBeNull()
    expect(netlabLaunchUrl('http://lab.example.com')).toBeNull()
    expect(netlabLaunchUrl('javascript:alert(1)')).toBeNull()
    expect(netlabHost('https://lab.example.com')).toBe('lab.example.com')
  })
  it('도구 항목: 격리 브라우저 → 네트워크 랩, 둘 다 external · server 아이콘', () => {
    const items = railToolItems({ rbiUrl: 'https://rbi.example.com/', netlabUrl: 'https://lab.example.com', rbiLabel: 'R', netlabLabel: 'N' })
    expect(items.map(i => i.id)).toEqual(['rbi', 'netlab'])
    expect(items.every(i => i.external)).toBe(true)
    expect(items[1]).toMatchObject({ icon: 'server', to: 'https://lab.example.com' })
    expect(railToolItems({ rbiUrl: null, netlabUrl: null, rbiLabel: 'R', netlabLabel: 'N' })).toEqual([])
  })
})

describe('레일 도구 묶음', () => {
  it('NETLAB 주소가 비면 네트워크 랩 항목이 없다', async () => {
    const { container, done } = await renderShell()
    const aside = container.querySelector('aside')!
    expect(aside.querySelector(`a[aria-label^="${t('nav.netlab')}"]`)).toBeNull()
    expect(aside.textContent).not.toContain(t('nav.netlab'))
    done()
  })

  it('주소가 있으면 새 탭 링크(target=_blank · rel noopener · aria "새 탭에서 열기") — 관리 묶음 앞', async () => {
    apiMock.netlab = 'https://lab.example.com'
    const { container, done } = await renderShell()
    const aside = container.querySelector('aside')!
    await waitFor(() => expect(aside.querySelector('a[href="https://lab.example.com"]')).not.toBeNull())
    const a = aside.querySelector('a[href="https://lab.example.com"]')!
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
    expect(a.getAttribute('aria-label')).toContain(t('nav.netlab'))
    expect(a.getAttribute('aria-label')).toContain('새 탭에서 열기')
    expect(a.getAttribute('title')).toBe(`새 탭에서 열기 · ${t('nav.netlab')}`)
    // 순서: 네트워크 랩이 관리(admin) 링크보다 앞
    const links = Array.from(aside.querySelectorAll('a'))
    const admin = links.findIndex(l => l.getAttribute('href') === '/admin/dashboard')
    expect(admin).toBeGreaterThan(links.indexOf(a as HTMLAnchorElement))
    done()
  })

  it('격리 브라우저(대상 있음)도 같은 묶음에서 네트워크 랩 앞, 새 탭', async () => {
    apiMock.netlab = 'https://lab.example.com'
    apiMock.rbi = true
    const { container, done } = await renderShell()
    const aside = container.querySelector('aside')!
    await waitFor(() => expect(aside.querySelector('a[href="https://rbi.example.com/"]')).not.toBeNull())
    const rbi = aside.querySelector('a[href="https://rbi.example.com/"]')!
    expect(rbi.getAttribute('target')).toBe('_blank')
    const links = Array.from(aside.querySelectorAll('a'))
    expect(links.indexOf(rbi as HTMLAnchorElement)).toBeLessThan(links.findIndex(l => l.getAttribute('href') === 'https://lab.example.com'))
    done()
  })
})
