// 전역 가드 — Vue middleware(auth.global · module-guard.global · setup.global) 와 같은 판정인지.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({
  calls: [] as string[],
  setup: { needs_setup: false } as { needs_setup: boolean } | Error,
  demo: false,
  demoLogin: 'ok' as 'ok' | 'fail',
  me: null as Record<string, unknown> | null,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => {
    api.calls.push(url)
    if (url === '/api/setup/status') { if (api.setup instanceof Error) throw api.setup; return api.setup }
    if (url === '/api/health') return { service: 'WS', demo_mode: api.demo, config: {} }
    if (url === '/api/auth/demo-login') { if (api.demoLogin === 'fail') throw new Error('no'); api.me = { id: 'd', is_admin: false }; return {} }
    if (url === '/api/auth/me') { if (!api.me) throw Object.assign(new Error('401'), { statusCode: 401 }); return api.me }
    return {}
  }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { authGuard, moduleGuard, setupGuard, runGuards, _resetGuards } = await import('~/router/guards')
const { authStore } = await import('~/composables/useAuth')
const { platformStore } = await import('~/composables/usePlatform')
const { siteConfigStore } = await import('~/composables/useSiteConfig')
const { resetSharedState } = await import('~/lib/state')

const user = (extra: Record<string, unknown> = {}) => ({ id: 'u', username: 'a', display_name: null, email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null, ...extra })

beforeEach(() => {
  api.calls = []; api.setup = { needs_setup: false }; api.demo = false; api.demoLogin = 'ok'; api.me = null
  _resetGuards(); resetSharedState()
  authStore.setState({ user: null, loading: false })
  platformStore.setState({ modules: [], loaded: false })
  siteConfigStore.setState({ loaded: false, demoMode: false })
})

describe('auth.global', () => {
  it('공개 화면·회의 참가·공유 링크·없는 주소는 그대로', async () => {
    for (const p of ['/login', '/register', '/setup', '/forgot-password', '/reset-password', '/verify-email', '/meetings/join/x', '/meetings/room/r', '/s/t']) {
      expect(await authGuard({ path: p, matched: true })).toBeNull()
    }
    expect(await authGuard({ path: '/nope', matched: false })).toBeNull()
  })

  it('로그인 안 했으면 /login', async () => {
    expect(await authGuard({ path: '/mail', matched: true })).toBe('/login')
  })

  it('데모 모드면 자동 로그인 후 통과, 실패하면 /login', async () => {
    api.demo = true
    expect(await authGuard({ path: '/mail', matched: true })).toBeNull()
    expect(api.calls).toContain('/api/auth/demo-login')
    expect(authStore.getState().user).not.toBeNull()

    authStore.setState({ user: null }); siteConfigStore.setState({ loaded: false }); api.demoLogin = 'fail'
    expect(await authGuard({ path: '/mail', matched: true })).toBe('/login')
  })

  it('2단계 인증 필수 미등록이면 설정 › 보안(enroll=1), 그 화면은 통과', async () => {
    authStore.setState({ user: user({ totp_setup_required: true }) })
    expect(await authGuard({ path: '/mail', matched: true })).toBe('/settings/security?enroll=1')
    expect(await authGuard({ path: '/settings/security', matched: true })).toBeNull()
  })
})

describe('module-guard.global', () => {
  it('모듈 목록을 받기 전에는 막지 않는다', () => {
    expect(moduleGuard({ path: '/mail', matched: true })).toBeNull()
  })
  it('꺼진 모듈·플러그인 화면은 /', () => {
    platformStore.setState({ loaded: true, modules: [
      { id: 'mail', name: 'm', icon: '', route: '/mail', type: 'core', requires: [], enabled: false },
      { id: 'git', name: 'g', icon: '', route: '/code', type: 'core', requires: [], enabled: false },
      { id: 'notes', name: 'n', icon: '', route: '/p/notes', type: 'plugin', requires: [], enabled: false },
    ] })
    expect(moduleGuard({ path: '/mail/12', matched: true })).toBe('/')
    expect(moduleGuard({ path: '/mailbox', matched: true })).toBeNull()
    expect(moduleGuard({ path: '/code/a/b', matched: true })).toBe('/')
    expect(moduleGuard({ path: '/p/notes', matched: true })).toBe('/')
    expect(moduleGuard({ path: '/chat', matched: true })).toBeNull() // 목록에 없으면 켜짐
  })
})

describe('setup.global', () => {
  it('최초 설정 전이면 /setup, 끝났으면 /setup → /', async () => {
    api.setup = { needs_setup: true }
    expect(await setupGuard({ path: '/', matched: true })).toBe('/setup')
    expect(await setupGuard({ path: '/setup', matched: true })).toBeNull()
    resetSharedState(); api.setup = { needs_setup: false }
    expect(await setupGuard({ path: '/setup', matched: true })).toBe('/')
  })
  it('상태는 한 번만 묻고, 실패하면 설정 끝난 것으로', async () => {
    api.setup = new Error('down')
    expect(await setupGuard({ path: '/setup', matched: true })).toBe('/')
    // 실패한 답은 기억하지 않는다(일시 오류일 수 있다) — 다음 이동에서 다시 묻는다
    await setupGuard({ path: '/', matched: true })
    expect(api.calls.filter(c => c === '/api/setup/status').length).toBe(2)
  })
})

describe('순서(Nuxt 파일 이름 순: auth → module → setup)', () => {
  it('첫 이동에서 사용자 정보를 먼저 읽는다(plugins/auth.ts)', async () => {
    api.me = user()
    authStore.setState({ user: null, loading: true })
    expect(await runGuards({ path: '/mail', matched: true })).toBeNull()
    expect(api.calls[0]).toBe('/api/auth/me')
  })
  it('로그인 안 한 상태로 최초 설정 전이면: /mail → /login, 그다음 /login → /setup', async () => {
    api.setup = { needs_setup: true }
    expect(await runGuards({ path: '/mail', matched: true })).toBe('/login')
    expect(await runGuards({ path: '/login', matched: true })).toBe('/setup')
  })
})
