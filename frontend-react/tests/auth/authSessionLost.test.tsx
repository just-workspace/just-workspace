// 인증 구역 수정 고정 — 웹에서 세션이 끊긴 경우(401)에만 로그인으로 이동, 429·5xx·네트워크 오류는 일시 오류(상태 유지).
// + 로그인 2단계 화면의 복구 코드 입력.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ComponentType } from 'react'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: Record<string, any> }[],
  routes: {} as Record<string, (opts?: Record<string, any>) => unknown>,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: Record<string, any>) => {
    api.calls.push({ url, opts })
    const h = api.routes[url]
    if (!h) return {}
    return h(opts)
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch, _real$fetch: real.$fetch }
})

const apiMod = await import('~/lib/api') as typeof import('~/lib/api') & { _real$fetch: typeof import('~/lib/api').$fetch }
const { default: Login } = await import('~/pages/login')
const { authStore, fetchUser, handleAuthLost, authUncertain, isGuestPath, _resetAuthProbe } = await import('~/composables/useAuth')
const { authGuard, setupGuard, _resetGuards } = await import('~/router/guards')
const { siteConfigStore } = await import('~/composables/useSiteConfig')
const { setAppRouter } = await import('~/lib/router')
const { resetSharedState } = await import('~/lib/state')

const ME = { id: 'u1', username: 'qa', display_name: null, email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null }
const fail = (status?: number) => () => { throw Object.assign(new Error(String(status ?? 'network')), status ? { statusCode: status } : {}) }

function renderAt(Page: ComponentType, url: string) {
  const router = createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: [url] })
  setAppRouter(router)
  const r = render(<RouterProvider router={router} />)
  return { ...r, router }
}
function routerAt(url: string) {
  const router = createMemoryRouter([{ path: '*', element: <div /> }], { initialEntries: [url] })
  setAppRouter(router)
  return router
}

beforeEach(() => {
  api.calls.length = 0
  api.routes = {}
  _resetAuthProbe(); _resetGuards(); resetSharedState()
  authStore.setState({ user: null, loading: false })
  siteConfigStore.setState({ appName: 'Workspace', giteaUrl: '', registrationMode: 'approval', config: {}, loaded: true, demoMode: false } as any)
  window.history.replaceState(null, '', '/mail?folder=inbox')
})

describe('fetchUser — 401 만 미인증', () => {
  it('401 이면 사용자를 비운다', async () => {
    authStore.setState({ user: ME as any })
    api.routes['/api/auth/me'] = fail(401)
    await fetchUser()
    expect(authStore.getState().user).toBeNull()
    expect(authUncertain()).toBe(false)
  })

  it('429·5xx·네트워크 오류는 알고 있던 로그인 상태를 지우지 않는다', async () => {
    authStore.setState({ user: ME as any })
    for (const st of [429, 500, 503, undefined]) {
      api.routes['/api/auth/me'] = fail(st)
      await fetchUser()
      expect(authStore.getState().user?.id).toBe('u1')
    }
    expect(authUncertain()).toBe(false)
  })

  it('부팅 때 일시 오류면 "모름" — 가드는 다시 확인하고, 확인되면 통과', async () => {
    api.routes['/api/auth/me'] = fail(429)
    await fetchUser()
    expect(authStore.getState().user).toBeNull()
    expect(authUncertain()).toBe(true)
    // 여전히 실패 → 복귀 경로를 포함하여 로그인으로 이동
    expect(await authGuard({ path: '/mail', matched: true })).toBe('/login?redirect=%2Fmail')
    // 한도 해제 → 그대로 통과
    api.routes['/api/auth/me'] = () => ME
    expect(await authGuard({ path: '/mail', matched: true })).toBeNull()
    expect(authUncertain()).toBe(false)
  })
})

describe('setupGuard — 일시 오류를 기억하지 않는다', () => {
  it('실패한 답은 저장하지 않고 다음 이동에서 다시 묻는다', async () => {
    api.routes['/api/setup/status'] = fail(429)
    expect(await setupGuard({ path: '/mail', matched: true })).toBeNull()
    api.routes['/api/setup/status'] = () => ({ needs_setup: true })
    expect(await setupGuard({ path: '/mail', matched: true })).toBe('/setup')
  })
})

describe('쓰는 도중 세션 끊김(웹)', () => {
  it('확인(/api/auth/me)도 401 이면 사용자를 비우고 돌아올 곳과 함께 로그인으로', async () => {
    const router = routerAt('/mail')
    authStore.setState({ user: ME as any })
    api.routes['/api/auth/me'] = fail(401)
    await handleAuthLost('unauthorized')
    expect(authStore.getState().user).toBeNull()
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.search).toContain('redirect=')
    expect(decodeURIComponent(router.state.location.search)).toContain('/mail?folder=inbox')
  })

  it('그 요청만의 401(세션은 살아 있음)·일시 오류면 아무것도 바꾸지 않는다', async () => {
    const router = routerAt('/mail')
    authStore.setState({ user: ME as any })
    api.routes['/api/auth/me'] = () => ME
    await handleAuthLost('unauthorized')
    api.routes['/api/auth/me'] = fail(429)
    await handleAuthLost('unauthorized')
    api.routes['/api/auth/me'] = fail(502)
    await handleAuthLost('unauthorized')
    expect(authStore.getState().user?.id).toBe('u1')
    expect(router.state.location.pathname).toBe('/mail')
  })

  it('로그인 전(로그인 시도·부팅 확인)의 401 은 대상이 아니다 — 확인 요청도 보내지 않는다', async () => {
    const router = routerAt('/login')
    await handleAuthLost('unauthorized')
    expect(api.calls.length).toBe(0)
    expect(router.state.location.pathname).toBe('/login')
  })

  it('손님·공개 화면에서는 로그인으로 보내지 않는다', async () => {
    for (const p of ['/login', '/register', '/s/abc', '/meetings/join/x', '/meetings/room/r', '/consent', '/reset-password']) expect(isGuestPath(p)).toBe(true)
    expect(isGuestPath('/files', '?share=tok')).toBe(true)
    expect(isGuestPath('/mail')).toBe(false)

    window.history.replaceState(null, '', '/s/abc')
    const router = routerAt('/s/abc')
    authStore.setState({ user: ME as any })
    api.routes['/api/auth/me'] = fail(401)
    await handleAuthLost('unauthorized')
    expect(authStore.getState().user).toBeNull()
    expect(router.state.location.pathname).toBe('/s/abc')
  })

  it('2단계 필수 정책이 도중에 켜졌으면 등록 화면으로', async () => {
    const router = routerAt('/mail')
    authStore.setState({ user: ME as any })
    api.routes['/api/auth/me'] = () => ({ ...ME, totp_setup_required: true })
    await handleAuthLost('totp')
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/security'))
  })
})

describe('lib/api — 웹에서 401 을 알린다(429·5xx 는 아님)', () => {
  it('401 → jw:auth-lost, 403+X-Totp-Setup-Required → totp, 429·500 → 없음', async () => {
    const seen: string[] = []
    const on = (e: Event) => { seen.push((e as CustomEvent).detail.kind) }
    window.addEventListener(apiMod.AUTH_LOST_EVENT, on)
    const respond = (status: number, headers: Record<string, string> = {}) =>
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'x' }), { status, headers: { 'content-type': 'application/json', ...headers } })))
    try {
      for (const [status, headers] of [[401, {}], [429, {}], [500, {}], [403, {}], [403, { 'X-Totp-Setup-Required': '1' }]] as const) {
        respond(status, headers)
        await apiMod._real$fetch('/api/anything', { retry: 0 }).catch(() => {})
      }
    } finally { window.removeEventListener(apiMod.AUTH_LOST_EVENT, on) }
    expect(seen).toEqual(['unauthorized', 'totp'])
  })
})

describe('로그인 2단계 — 복구 코드', () => {
  async function toOtpStep() {
    api.routes['/api/auth/login'] = () => ({ requires_2fa: true, temp_token: 'tmp' })
    renderAt(Login, '/login')
    fireEvent.change(document.getElementById('username')!, { target: { value: 'qa' } })
    fireEvent.change(document.getElementById('password')!, { target: { value: 'pw' } })
    fireEvent.submit(document.getElementById('username')!.closest('form')!)
    await waitFor(() => expect(document.getElementById('otp')).toBeTruthy())
  }

  it('복구 코드로 바꾸면 xxxx-xxxx 를 그대로 보낸다', async () => {
    await toOtpStep()
    expect((document.getElementById('otp') as HTMLInputElement).maxLength).toBe(6)
    fireEvent.click(screen.getByRole('button', { name: /복구 코드 사용/ }))
    const input = document.getElementById('otp') as HTMLInputElement
    expect(input.maxLength).toBeGreaterThanOrEqual(9)
    fireEvent.change(input, { target: { value: 'abcd-efgh' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/auth/2fa/verify')).toBe(true))
    expect(api.calls.find(c => c.url === '/api/auth/2fa/verify')!.opts!.body).toEqual({ temp_token: 'tmp', code: 'abcd-efgh' })
  })

  it('복구 코드 형식이 아니면 보내지 않는다 / 인증 앱 코드는 여전히 숫자 6자리만', async () => {
    await toOtpStep()
    fireEvent.change(document.getElementById('otp')!, { target: { value: 'abcd-efgh' } })
    fireEvent.submit(document.getElementById('otp')!.closest('form')!)
    fireEvent.click(screen.getByRole('button', { name: /복구 코드 사용/ }))
    fireEvent.change(document.getElementById('otp')!, { target: { value: 'abc' } })
    fireEvent.submit(document.getElementById('otp')!.closest('form')!)
    await new Promise(r => setTimeout(r, 20))
    expect(api.calls.some(c => c.url === '/api/auth/2fa/verify')).toBe(false)
  })
})
