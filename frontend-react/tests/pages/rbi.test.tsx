// 워크스페이스 /rbi — 격리 브라우저 런처: rbi 전용 출처를 새 탭(noopener)으로 연다 · 대상 딥 링크 · 설정 없음 · 모듈 꺼짐.
// + 내비게이션(레일·탭·팔레트)에 격리 브라우저가 없다 · 사용자 메뉴 링크 조건 · 주소 도우미 · 단독 번들 격리 목록.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, renderHook, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({ calls: [] as string[], targets: [] as any[], origin: 'https://rbi.example' as string }))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => {
    api.calls.push(url)
    if (url === '/api/rbi/targets') return { targets: api.targets, sessions: [], public_origin: api.origin }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: RbiPage } = await import('~/pages/rbi')
const { platformStore } = await import('~/composables/usePlatform')
const { setUser } = await import('~/composables/useAuth')
const { rbiLauncherUrl, rbiLoginUrl, rbiReturnPath, loadRbiLauncher } = await import('~/composables/useRbi')
const { useNav } = await import('~/composables/useNav')
const { useRbiLauncher } = await import('~/composables/useRbiLauncher')

const MODS = (rbiOn: boolean) => [
  { id: 'mail', name: '메일', icon: 'mail', route: '/mail', type: 'builtin', requires: [], enabled: true },
  { id: 'rbi', name: '격리 브라우저', icon: 'shield', route: '/rbi', type: 'builtin', requires: [], enabled: rbiOn },
]

function renderPage() {
  const router = createMemoryRouter([{ path: '*', element: <RbiPage /> }], { initialEntries: ['/rbi'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  api.calls = []
  api.origin = 'https://rbi.example'
  api.targets = [{ id: 't1', key: 'portal', name: 'Portal', url: 'http://192.168.10.70', host: '192.168.10.70', enabled: true, mode: 'mirror', modes: ['mirror', 'pixel'],
    policy: { clipboard_to_browser: true, clipboard_from_browser: true, downloads: false, uploads: false, idle_minutes: 15, max_hours: 8 } }]
  platformStore.setState({ modules: MODS(true) as any, loaded: true })
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null })
})

describe('워크스페이스 /rbi 런처', () => {
  it('[격리 브라우저 열기] 는 rbi 출처를 새 탭(noopener)으로, 대상 단추는 ?target= 딥 링크로', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderPage()
    fireEvent.click(await screen.findByTestId('rbi-launch'))
    expect(open).toHaveBeenCalledWith('https://rbi.example/', '_blank', 'noopener,noreferrer')
    fireEvent.click(screen.getByRole('button', { name: 'Portal 바로 열기' }))
    expect(open).toHaveBeenLastCalledWith('https://rbi.example/?target=portal', '_blank', 'noopener,noreferrer')
    // 세션 화면(iframe)은 워크스페이스 출처에 없다
    expect(document.querySelector('iframe')).toBeNull()
    expect(api.calls.every(c => c === '/api/rbi/targets')).toBe(true)
    open.mockRestore()
  })

  it('저절로 새 창을 띄우지 않는다', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderPage()
    await screen.findByTestId('rbi-launch')
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('rbi 출처가 설정되지 않았으면 안내, 모듈이 꺼져 있으면 꺼짐 안내', async () => {
    api.origin = ''
    const { unmount } = renderPage()
    expect(await screen.findByText('격리 브라우저 주소가 설정되지 않았습니다')).toBeTruthy()
    unmount()
    platformStore.setState({ modules: MODS(false) as any, loaded: true })
    renderPage()
    expect(await screen.findByText('격리 브라우저 기능이 꺼져 있습니다')).toBeTruthy()
  })
})

describe('워크스페이스 내비게이션에서 격리 브라우저 제외', () => {
  it('레일·모바일 탭·팔레트(useNav)에 rbi 가 없다 — 관리자도', () => {
    for (const admin of [false, true]) {
      setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: admin, last_login_at: null })
      const { result } = renderHook(() => useNav())
      const ids = [...result.current.flat.map(i => i.id), ...result.current.railGroups.flatMap(g => g.items.map(i => i.id))]
      expect(ids).toContain('mail')
      expect(ids).not.toContain('rbi')
    }
  })

  it('사용자 메뉴 링크: 대상이 있으면 rbi 출처 주소, 없거나 모듈이 꺼지면 없음', async () => {
    await loadRbiLauncher(true)
    const a = renderHook(() => useRbiLauncher())
    await waitFor(() => expect(a.result.current).toBe('https://rbi.example/'))
    api.targets = []
    await loadRbiLauncher(true)
    const b = renderHook(() => useRbiLauncher())
    await new Promise(r => setTimeout(r, 10))
    expect(b.result.current).toBeNull()
    platformStore.setState({ modules: MODS(false) as any, loaded: true })
    const c = renderHook(() => useRbiLauncher())
    expect(c.result.current).toBeNull()
  })
})

describe('주소 도우미', () => {
  it('rbiLauncherUrl — 출처만 받는다(경로·자격증명·이상한 스킴 거부)', () => {
    expect(rbiLauncherUrl('https://rbi.example')).toBe('https://rbi.example/')
    expect(rbiLauncherUrl('https://rbi.example/', 'a b')).toBe('https://rbi.example/?target=a%20b')
    for (const bad of ['', null, undefined, 'javascript:alert(1)', 'https://u:p@rbi.example', 'https://rbi.example/x', 'https://rbi.example?x=1', 'ftp://rbi.example', 'nope']) {
      expect(rbiLauncherUrl(bad as any)).toBeNull()
    }
  })

  it('rbiLoginUrl·rbiReturnPath — 홉 오류 쿼리는 빼고 지금 경로로 돌아온다', () => {
    expect(rbiReturnPath({ pathname: '/', search: '?target=portal&sso_error=code' })).toBe('/?target=portal')
    expect(rbiLoginUrl({ pathname: '/', search: '' })).toBe('/auth/login?return=%2F')
  })
})

describe('단독 번들 격리 목록(rbi-bundle-guard)', () => {
  it('워크스페이스 화면·셸·무거운 모듈 경로를 잡아낸다', async () => {
    const { rbiForbiddenModules } = await import('../../rbi-bundle-guard')
    const ids = [
      'D:\\x\\frontend-react\\src\\pages\\mail.tsx', '/x/src/layouts/default.tsx', '/x/src/App.tsx', '/x/src/main.tsx', '/x/src/router/index.tsx',
      '/x/src/components/layout/Sidebar.tsx', '/x/node_modules/livekit-client/dist/x.js',
      '/x/src/rbi-app/RbiApp.tsx', '/x/src/components/ui/Button.tsx', '/x/src/components/rbi/RbiMirrorView.tsx', '/x/src/lib/rbiMirror/mirror-client.ts',
    ]
    expect(rbiForbiddenModules(ids).length).toBe(7)
  })
})
