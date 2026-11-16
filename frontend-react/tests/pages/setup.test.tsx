// 최초 설정(/setup) — 첫 관리자 생성: 설정 토큰 칸·안내, 12자 하한, 토큰을 본문에 포함하여 전송, 오류 문구,
// 설치 관리자가 구성한 서버(setup_mode = installer)에서는 폼 없이 안내만 표시.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: Record<string, any> }[],
  status: { needs_setup: true, has_admin: false, setup_mode: 'token' } as Record<string, any>,
  admin: (() => ({ ok: true })) as (opts?: Record<string, any>) => unknown,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: Record<string, any>) => {
    api.calls.push({ url, opts })
    if (url === '/api/setup/status') return api.status
    if (url === '/api/setup/admin') return api.admin(opts)
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const login = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('~/composables/useAuth', async (orig) => {
  const real = await orig<typeof import('~/composables/useAuth')>()
  return { ...real, nativeLogin: async (...a: unknown[]) => { login.calls.push(a) } }
})

const { default: SetupPage } = await import('~/pages/setup')
const { resetSharedState, setSharedState } = await import('~/lib/state')
const { checkPasswordRules, passwordRulesPass, FIRST_ADMIN_PASSWORD_MIN, PASSWORD_MIN } = await import('~/utils/passwordRules')

function renderPage() {
  const router = createMemoryRouter([{ path: '*', element: <SetupPage /> }], { initialEntries: ['/setup'] })
  return render(<RouterProvider router={router} />)
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => fireEvent.change(input(id), { target: { value } })
const submit = () => screen.getByRole('button', { name: '다음 — 브랜딩' }) as HTMLButtonElement
const posts = () => api.calls.filter(c => c.url === '/api/setup/admin')

async function openAdminStep() {
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: '새로 설치' }))
  await screen.findByText('관리자 계정 만들기')
}

beforeEach(async () => {
  api.calls = []
  login.calls = []
  api.status = { needs_setup: true, has_admin: false, setup_mode: 'token' }
  api.admin = () => ({ ok: true })
  resetSharedState()
})

describe('최초 설정 — 설정 토큰', () => {
  it('토큰 칸과 "어디서 보는지" 안내가 있다', async () => {
    await openAdminStep()
    expect(input('setup-token')).toBeTruthy()
    expect(screen.getByText('설정 토큰')).toBeTruthy()
    expect(screen.getByText('docker compose logs backend')).toBeTruthy()
    expect(screen.getByText('docker compose exec backend python -m app.cli setup-token')).toBeTruthy()
  })

  it('토큰이 비어 있으면 보낼 수 없다', async () => {
    await openAdminStep()
    type('setup-admin-user', 'root1')
    type('setup-admin-pass', 'first-admin-pass-7')
    expect(submit().disabled).toBe(true)
    type('setup-token', '   ')
    expect(submit().disabled).toBe(true)
    type('setup-token', 'tok-123')
    expect(submit().disabled).toBe(false)
  })

  it('비밀번호는 12자부터 — 11자는 막고 화면에 12자를 안내한다', async () => {
    await openAdminStep()
    type('setup-token', 'tok-123')
    type('setup-admin-user', 'root1')
    type('setup-admin-pass', 'eleven-ch-1')
    expect(screen.getByText('12자 이상 (지금 11자)')).toBeTruthy()
    expect(submit().disabled).toBe(true)
    type('setup-admin-pass', 'twelve-chr-1')
    expect(screen.getByText('12자 이상')).toBeTruthy()
    expect(submit().disabled).toBe(false)
  })

  it('토큰을 본문에 실어 보내고(앞뒤 공백 제거) 만들어지면 로그인해 다음 단계로', async () => {
    await openAdminStep()
    type('setup-token', '  tok-123 \n')
    type('setup-admin-user', 'root1')
    type('setup-admin-pass', 'first-admin-pass-7')
    fireEvent.click(submit())
    await screen.findByText('서비스 이름')
    expect(posts()).toHaveLength(1)
    expect(posts()[0].opts?.method).toBe('POST')
    expect(posts()[0].opts?.body).toEqual({ username: 'root1', password: 'first-admin-pass-7', display_name: undefined, setup_token: 'tok-123' })
    expect(login.calls).toEqual([['root1', 'first-admin-pass-7', true]])
  })

  it('토큰이 틀리면 그 사유를 보여 주고 단계에 머문다', async () => {
    api.admin = () => { throw Object.assign(new Error('403'), { statusCode: 403, data: { detail: { code: 'setup_token_invalid', message: 'x' } } }) }
    await openAdminStep()
    type('setup-token', 'wrong')
    type('setup-admin-user', 'root1')
    type('setup-admin-pass', 'first-admin-pass-7')
    fireEvent.click(submit())
    expect((await screen.findByRole('alert')).textContent).toContain('설정 토큰이 맞지 않습니다')
    expect(screen.getByText('관리자 계정 만들기')).toBeTruthy()
    expect(login.calls).toHaveLength(0)
  })

  it('시도가 너무 많으면(429) 기다리라고 알린다', async () => {
    api.admin = () => { throw Object.assign(new Error('429'), { statusCode: 429, data: { detail: 'Too many requests' } }) }
    await openAdminStep()
    type('setup-token', 'wrong')
    type('setup-admin-user', 'root1')
    type('setup-admin-pass', 'first-admin-pass-7')
    fireEvent.click(submit())
    expect((await screen.findByRole('alert')).textContent).toContain('시도가 너무 많습니다')
  })

  it('서버의 입력 검증 문구(문자열)는 그대로 보여 준다', async () => {
    api.admin = () => { throw Object.assign(new Error('400'), { statusCode: 400, data: { detail: '너무 흔하거나 유출된 적이 있는 비밀번호입니다' } }) }
    await openAdminStep()
    type('setup-token', 'tok')
    type('setup-admin-user', 'root1')
    type('setup-admin-pass', 'password123!')
    fireEvent.click(submit())
    expect((await screen.findByRole('alert')).textContent).toContain('너무 흔하거나')
  })
})

describe('최초 설정 — 설치 관리자가 꾸린 서버', () => {
  it('폼 없이 안내만 보여 준다(가드가 받아 둔 상태)', async () => {
    api.status = { needs_setup: true, has_admin: false, setup_mode: 'installer' }
    setSharedState('setup-status', api.status)
    renderPage()
    expect(await screen.findByText('관리자 계정을 준비하는 중입니다')).toBeTruthy()
    expect(screen.getByText(/설치 관리자 화면\(https:\/\/<서버 주소>:8443\)/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '새로 설치' })).toBeNull()
    expect(input('setup-token')).toBeNull()
    expect(posts()).toHaveLength(0)
  })

  it('상태를 직접 물어서도 안내로 바뀐다', async () => {
    api.status = { needs_setup: true, has_admin: false, setup_mode: 'installer' }
    renderPage()
    expect(await screen.findByText('관리자 계정을 준비하는 중입니다')).toBeTruthy()
  })

  it('만들기를 눌렀는데 서버가 닫혔다고 답하면 안내로 바뀐다', async () => {
    api.admin = () => { throw Object.assign(new Error('403'), { statusCode: 403, data: { detail: { code: 'setup_closed', message: 'x' } } }) }
    await openAdminStep()
    type('setup-token', 'tok')
    type('setup-admin-user', 'root1')
    type('setup-admin-pass', 'first-admin-pass-7')
    fireEvent.click(submit())
    await waitFor(() => expect(screen.getByText('관리자 계정을 준비하는 중입니다')).toBeTruthy())
  })

  it('새 문구는 ko·en 양쪽에 같은 키로 있다', async () => {
    const ko = (await import('~/i18n/locales/ko.json')).default as any
    const en = (await import('~/i18n/locales/en.json')).default as any
    for (const group of ['token', 'closed', 'errors']) {
      expect(Object.keys(en.setup[group]).sort()).toEqual(Object.keys(ko.setup[group]).sort())
    }
    expect(en.setup.closed.title).toBe('The admin account is being prepared')
    expect(en.setup.token.label).toBe('Setup token')
  })
})

describe('비밀번호 규칙 — 하한을 바꿔도 다른 화면은 그대로', () => {
  it('기본 하한은 8자, 첫 관리자는 12자', () => {
    expect(PASSWORD_MIN).toBe(8)
    expect(FIRST_ADMIN_PASSWORD_MIN).toBe(12)
    expect(passwordRulesPass(checkPasswordRules('nine-ch-1'))).toBe(true)
    expect(passwordRulesPass(checkPasswordRules('nine-ch-1', [], FIRST_ADMIN_PASSWORD_MIN))).toBe(false)
    expect(passwordRulesPass(checkPasswordRules('twelve-chr-1', [], FIRST_ADMIN_PASSWORD_MIN))).toBe(true)
  })
})
