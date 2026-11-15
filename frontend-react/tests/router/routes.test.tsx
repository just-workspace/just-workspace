// 라우트 표(옛 주소 57개 + 전환 뒤 새 화면)가 온전하고, 각각 렌더(자리 표시 포함)되는지.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { RouterProvider } from 'react-router'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const apiMock = vi.hoisted(() => ({
  needsSetup: false,
  user: { id: 'u1', username: 'admin', display_name: 'Admin', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: true, last_login_at: null } as Record<string, unknown> | null,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => {
    if (url === '/api/auth/me') { if (!apiMock.user) throw Object.assign(new Error('401'), { statusCode: 401 }); return apiMock.user }
    if (url === '/api/setup/status') return { needs_setup: apiMock.needsSetup }
    if (url === '/api/health') return { service: 'Workspace', config: {} }
    if (url === '/api/platform/modules') return { modules: [] }
    // 셸(기본 레이아웃)이 여는 실시간·알림 — 목록 응답은 빈 목록 모양으로
    if (url === '/api/chat/channels' || url === '/api/chat/users') return []
    if (url === '/api/chat/drafts' || url === '/api/chat/saved') return { items: [] }
    if (url === '/api/notifications/') return { notifications: [], total: 0 }
    if (url === '/api/notifications/unread-count') return { count: 0 }
    // /code/owner/repo — 저장소 상세는 owner.login 이 있어야 한다(Vue 와 같게 없으면 던짐)
    if (url === '/api/git/repos/owner/repo') return { name: 'repo', full_name: 'owner/repo', owner: { login: 'owner' }, default_branch: 'main' }
    // 파일 모듈(r1/files-office): 목록은 { path, items } 모양
    if (url === '/api/files/list') return { path: 'my', items: [] }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { ROUTES } = await import('~/router/routes')
const { createTestRouter } = await import('~/router')
const { authStore } = await import('~/composables/useAuth')
const { _resetGuards } = await import('~/router/guards')
const { resetSharedState } = await import('~/lib/state')

function samplePath(path: string) {
  return path.replace(/:(\w+)/g, (_m, p) => `${p}-1`).replace(/\*$/, 'owner/repo')
}

const pagesDir = join(__dirname, '..', '..', 'src', 'pages')

describe('라우트 표', () => {
  it('옛 주소 57개(Vue 시절부터 이어 온 URL) + 전환 뒤 새로 만든 화면', () => {
    // 옛 Vue pages/** 와 1:1 이던 주소 — 북마크·링크가 걸려 있어 수가 줄면 안 된다(Vue 소스는 2026-11-14 삭제)
    const shared = ROUTES.filter(r => !r.reactOnly)
    expect(shared.length).toBe(57)
    // 전환 뒤 새로 만든 화면
    expect(ROUTES.filter(r => r.reactOnly).map(r => r.path).sort()).toEqual(['/admin/ai-ops/*', '/admin/dashboard-layout', '/admin/rbi', '/approvals', '/rbi', '/settings/ai/mcp', '/settings/ai/memory', '/settings/calendar', '/settings/chat'])
    // 경로는 겹치지 않는다
    expect(new Set(ROUTES.map(r => r.path)).size).toBe(ROUTES.length)
  })

  it('표의 file 은 모두 src/pages 아래에 실제로 있다', () => {
    expect(ROUTES.filter(r => !existsSync(join(pagesDir, r.file))).map(r => r.file)).toEqual([])
  })
})

describe('모든 라우트가 렌더된다', () => {
  beforeEach(() => {
    _resetGuards()
    resetSharedState()
    authStore.setState({ user: null, loading: true })
  })

  for (const def of ROUTES) {
    it(`${def.path} (${def.file})`, async () => {
      const url = samplePath(def.path)
      // /setup 은 최초 설정 전에만 열린다(완료 후엔 / 로 — setup 가드)
      apiMock.needsSetup = def.path === '/setup'
      const router = createTestRouter([url])
      const { container, unmount } = render(<RouterProvider router={router} />)
      await waitFor(() => {
        expect(router.state.navigation.state).toBe('idle')
        expect(router.state.initialized).toBe(true)
      }, { timeout: 5000 })
      // 리다이렉트 메타가 있는 옛 주소는 그쪽으로
      if (def.redirect) {
        await waitFor(() => expect(router.state.location.pathname).toBe(def.redirect))
      } else {
        expect(router.state.location.pathname).toBe(url)
        expect(router.state.errors).toBeNull()
        const ph = container.querySelector('[data-testid="not-ported-yet"]')
        if (ph) expect(ph.getAttribute('data-vue-path')).toBe(`pages/${def.file.replace(/\.tsx$/, '.vue')}`)
        else await waitFor(() => expect(container.innerHTML.length).toBeGreaterThan(0))
      }
      act(() => unmount())
      router.dispose()
    })
  }

  it('없는 주소는 404 화면', async () => {
    const router = createTestRouter(['/no-such-page'])
    const { container } = render(<RouterProvider router={router} />)
    await waitFor(() => expect(router.state.navigation.state).toBe('idle'))
    expect(router.state.location.pathname).toBe('/no-such-page')
    await waitFor(() => expect(container.textContent).toContain('404'))
    router.dispose()
  })

  it('로그인 안 했으면 보호된 화면은 /login 으로', async () => {
    apiMock.user = null
    try {
      const router = createTestRouter(['/mail'])
      render(<RouterProvider router={router} />)
      await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
      router.dispose()
    } finally {
      apiMock.user = { id: 'u1', username: 'admin', display_name: 'Admin', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: true, last_login_at: null }
    }
  })
})
