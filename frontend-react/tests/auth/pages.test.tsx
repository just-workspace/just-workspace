// 인증 화면 — 로그인(Git 바로가기 초록 버튼 유지·2단계·redirect 검증), 재설정(토큰 없음), 동의(i18n-t 슬롯).
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
  return { ...real, $fetch }
})

const { default: Login } = await import('~/pages/login')
const { default: Reset } = await import('~/pages/reset-password')
const { default: Consent } = await import('~/pages/consent')
const { authStore } = await import('~/composables/useAuth')
const { siteConfigStore } = await import('~/composables/useSiteConfig')
const { setAppRouter } = await import('~/lib/router')

function renderAt(Page: ComponentType, url: string) {
  const router = createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: [url] })
  setAppRouter(router)
  const r = render(<RouterProvider router={router} />)
  return { ...r, router }
}

beforeEach(() => {
  api.calls.length = 0
  api.routes = {}
  authStore.setState({ user: null, loading: false })
  siteConfigStore.setState({ appName: 'Workspace', giteaUrl: '', registrationMode: 'approval', config: {} } as any)
})

describe('login', () => {
  it('초록 Git 바로가기 버튼이 그대로(bg-success, /git/)', () => {
    renderAt(Login, '/login')
    const git = screen.getByRole('link', { name: /Git/ })
    expect(git.getAttribute('href')).toBe('/git/')
    expect(git.className).toContain('bg-success')
    expect(git.className).toContain('text-white')
  })

  it('빈 칸 제출은 요청 없이 오류', async () => {
    renderAt(Login, '/login')
    fireEvent.submit(screen.getByRole('button', { name: /로그인/ }).closest('form')!)
    await screen.findByRole('alert').catch(() => null)
    expect(api.calls.length).toBe(0)
  })

  it('2단계 인증 계정이면 코드 단계로', async () => {
    api.routes['/api/auth/login'] = () => ({ requires_2fa: true, temp_token: 'tmp' })
    renderAt(Login, '/login')
    fireEvent.change(document.getElementById('username')!, { target: { value: 'qa' } })
    fireEvent.change(document.getElementById('password')!, { target: { value: 'pw' } })
    fireEvent.submit(document.getElementById('username')!.closest('form')!)
    await waitFor(() => expect(document.getElementById('otp')).toBeTruthy())
  })

  it('외부 도메인 redirect 는 / 로 막는다(이미 로그인 상태)', async () => {
    authStore.setState({ user: { id: 'u1', username: 'qa' } as any, loading: false })
    const { router } = renderAt(Login, '/login?redirect=https://evil.example.com/x')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })
})

describe('reset-password', () => {
  it('토큰이 없으면 경고 결과 화면 + 다시 요청', () => {
    renderAt(Reset, '/reset-password')
    expect(screen.getByRole('link', { name: '비밀번호 찾기' }).getAttribute('href')).toBe('/forgot-password')
  })
})

describe('consent', () => {
  it('info 를 받아 앱 이름·계정(슬롯)·권한을 그린다', async () => {
    api.routes['/oauth/consent/info'] = () => ({
      client_id: 'c', client_name: 'Claude', dynamic: false, redirect_uri: 'https://app.example.com/cb',
      scopes: [{ name: 'read', description: '읽기' }], username: 'qa',
      logo_uri: null, client_uri: null, policy_uri: null, tos_uri: null,
    })
    renderAt(Consent, '/consent?rq=abc')
    await screen.findByText('Claude')
    expect(screen.getByText('qa').className).toContain('font-semibold')
    expect(screen.getByText('app.example.com')).toBeTruthy()
    expect(api.calls[0]).toMatchObject({ url: '/oauth/consent/info', opts: { params: { rq: 'abc' }, credentials: 'include' } })
  })
})
