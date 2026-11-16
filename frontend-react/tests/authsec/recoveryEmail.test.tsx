// 복구 이메일 변경 절차 — 설정 › 계정 폼(본인 확인 칸 · "확인 메일을 보냈습니다" · 요청 취소)과 확인 링크 도착 화면(/verify-email?change=…).
// 서버는 세션만으로 복구 이메일을 변경하지 않는다(PATCH /api/auth/profile 은 400) — 화면도 해당 경로로 전송해서는 안 된다.
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
    const h = api.routes[`${opts?.method ?? 'GET'} ${url}`] ?? api.routes[url]
    if (!h) return {}
    return h(opts)
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})
// 아래 카드(로그인된 기기)는 본 테스트의 대상이 아님
vi.mock('~/components/settings/SettingsDevices', () => ({ SettingsDevices: () => null }))

const { default: AccountPage } = await import('~/pages/settings/account')
const { default: VerifyPage } = await import('~/pages/verify-email')
const { authStore, _resetAuthProbe } = await import('~/composables/useAuth')
const { siteConfigStore } = await import('~/composables/useSiteConfig')
const { setAppRouter } = await import('~/lib/router')

const ME = { id: 'u1', username: 'kim', display_name: '김', email: 'kim@ws.example', primary_email: null, avatar_url: null, recovery_email: 'old@ex.com', is_admin: false, last_login_at: null }
const PENDING = 'GET /api/auth/recovery-email/pending'
const REQUEST = 'POST /api/auth/recovery-email/request'
const fail = (status: number, detail: string) => () => { throw Object.assign(new Error(detail), { statusCode: status, data: { detail } }) }
const callsTo = (url: string, method?: string) => api.calls.filter(c => c.url === url && (!method || (c.opts?.method ?? 'GET') === method))

function renderAt(Page: ComponentType, url: string) {
  const router = createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: [url] })
  setAppRouter(router)
  return { ...render(<RouterProvider router={router} />), router }
}
const emailInput = () => screen.getByLabelText('복구 이메일') as HTMLInputElement
const submit = () => fireEvent.submit(emailInput().closest('form')!)

beforeEach(() => {
  api.calls.length = 0
  api.routes = { '/api/auth/me': () => authStore.getState().user ?? ME }
  _resetAuthProbe()
  authStore.setState({ user: ME as any, loading: false })
  siteConfigStore.setState({ appName: 'Workspace', giteaUrl: '', registrationMode: 'approval', config: {}, loaded: true, demoMode: false } as any)
})

describe('설정 › 계정 — 복구 이메일 변경', () => {
  it('주소를 고치면 현재 비밀번호 칸이 나타나고, 비밀번호 없이는 요청하지 않는다', async () => {
    renderAt(AccountPage, '/settings/account')
    await waitFor(() => expect(emailInput().value).toBe('old@ex.com'))
    expect(screen.queryByLabelText(/현재 비밀번호/)).toBeNull()

    fireEvent.change(emailInput(), { target: { value: 'new@ex.com' } })
    expect(screen.getByLabelText(/현재 비밀번호/)).toBeTruthy()
    submit()
    expect(await screen.findByText('현재 비밀번호를 입력하세요')).toBeTruthy()
    expect(callsTo('/api/auth/recovery-email/request')).toHaveLength(0)
    expect(callsTo('/api/auth/profile')).toHaveLength(0)
  })

  it('비밀번호와 함께 요청 → "확인 메일을 보냈습니다", 주소는 아직 그대로', async () => {
    api.routes[REQUEST] = () => ({ message: 'ok', pending_email: 'new@ex.com', expires_in: 3600 })
    renderAt(AccountPage, '/settings/account')
    await waitFor(() => expect(emailInput().value).toBe('old@ex.com'))
    fireEvent.change(emailInput(), { target: { value: ' new@ex.com ' } })
    fireEvent.change(screen.getByLabelText(/현재 비밀번호/), { target: { value: 'Correct-Horse-9' } })
    submit()

    const note = await screen.findByTestId('recovery-pending')
    expect(note.textContent).toContain('확인 메일을 보냈습니다')
    expect(note.textContent).toContain('new@ex.com')
    const sent = callsTo('/api/auth/recovery-email/request', 'POST')
    expect(sent).toHaveLength(1)
    expect(sent[0].opts?.body).toEqual({ recovery_email: 'new@ex.com', current_password: 'Correct-Horse-9' })
    // 프로필 저장 경로로는 복구 이메일을 전송하지 않음(이름을 수정하지 않았으므로 호출 자체가 없음)
    expect(callsTo('/api/auth/profile')).toHaveLength(0)
    // 폼은 현재 주소로 복원되고 비밀번호 칸은 제거됨
    expect(emailInput().value).toBe('old@ex.com')
    expect(screen.queryByLabelText(/현재 비밀번호/)).toBeNull()
  })

  it('이름과 주소를 같이 고치면 이름만 프로필로 간다', async () => {
    api.routes[REQUEST] = () => ({ message: 'ok', pending_email: 'new@ex.com', expires_in: 3600 })
    renderAt(AccountPage, '/settings/account')
    await waitFor(() => expect(emailInput().value).toBe('old@ex.com'))
    fireEvent.change(screen.getByLabelText('표시 이름'), { target: { value: '김민지' } })
    fireEvent.change(emailInput(), { target: { value: 'new@ex.com' } })
    fireEvent.change(screen.getByLabelText(/현재 비밀번호/), { target: { value: 'pw' } })
    submit()
    await waitFor(() => expect(callsTo('/api/auth/profile', 'PATCH')).toHaveLength(1))
    expect(callsTo('/api/auth/profile', 'PATCH')[0].opts?.body).toEqual({ display_name: '김민지' })
    expect(callsTo('/api/auth/recovery-email/request', 'POST')).toHaveLength(1)
  })

  it('비밀번호가 틀리면 그 칸에 오류, 고치던 주소는 남는다', async () => {
    api.routes[REQUEST] = fail(400, '현재 비밀번호가 올바르지 않습니다')
    renderAt(AccountPage, '/settings/account')
    await waitFor(() => expect(emailInput().value).toBe('old@ex.com'))
    fireEvent.change(emailInput(), { target: { value: 'new@ex.com' } })
    fireEvent.change(screen.getByLabelText(/현재 비밀번호/), { target: { value: 'wrong' } })
    submit()
    expect(await screen.findByText('현재 비밀번호가 올바르지 않습니다')).toBeTruthy()
    expect(screen.getByLabelText(/현재 비밀번호/).getAttribute('aria-invalid')).toBe('true')
    expect(emailInput().value).toBe('new@ex.com')
    expect(screen.queryByTestId('recovery-pending')).toBeNull()
  })

  it('확인 대기 중인 요청을 보여 주고 취소할 수 있다', async () => {
    api.routes[PENDING] = () => ({ pending_email: 'waiting@ex.com', expires_in: 1200, reauth: 'password' })
    renderAt(AccountPage, '/settings/account')
    const note = await screen.findByTestId('recovery-pending')
    expect(note.textContent).toContain('waiting@ex.com')
    fireEvent.click(screen.getByRole('button', { name: '요청 취소' }))
    await waitFor(() => expect(screen.queryByTestId('recovery-pending')).toBeNull())
    expect(callsTo('/api/auth/recovery-email/pending', 'DELETE')).toHaveLength(1)
  })

  it('비밀번호를 확인할 수 없는 계정 — 인증 앱 코드로, 수단이 없으면 잠근다', async () => {
    api.routes[PENDING] = () => ({ pending_email: null, expires_in: 0, reauth: 'totp' })
    api.routes[REQUEST] = () => ({ message: 'ok', pending_email: 'new@ex.com', expires_in: 3600 })
    const first = renderAt(AccountPage, '/settings/account')
    await waitFor(() => expect(callsTo('/api/auth/recovery-email/pending')).toHaveLength(1))
    fireEvent.change(emailInput(), { target: { value: 'new@ex.com' } })
    fireEvent.change(await screen.findByLabelText(/인증 앱 코드/), { target: { value: '123456' } })
    submit()
    await screen.findByTestId('recovery-pending')
    expect(callsTo('/api/auth/recovery-email/request', 'POST')[0].opts?.body).toEqual({ recovery_email: 'new@ex.com', code: '123456' })
    first.unmount()

    api.routes[PENDING] = () => ({ pending_email: null, expires_in: 0, reauth: 'none' })
    renderAt(AccountPage, '/settings/account')
    await waitFor(() => expect(emailInput().disabled).toBe(true))
  })
})

describe('설정 › 계정 — 복구 이메일 비우기', () => {
  it('주소를 지우고 본인 확인을 하면 바로 비워진다(확인 메일 대기 없음)', async () => {
    api.routes[REQUEST] = () => {
      authStore.setState({ user: { ...ME, recovery_email: null } as any })   // 서버가 값을 비움 → 다음 /me 가 빈 값
      return { message: 'ok', cleared: true, pending_email: null, expires_in: 0 }
    }
    renderAt(AccountPage, '/settings/account')
    await waitFor(() => expect(emailInput().value).toBe('old@ex.com'))
    fireEvent.change(emailInput(), { target: { value: '' } })
    expect(screen.getByText(/저장하면 바로 지워집니다/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/현재 비밀번호/), { target: { value: 'Correct-Horse-9' } })
    submit()
    await waitFor(() => expect(callsTo('/api/auth/recovery-email/request', 'POST')).toHaveLength(1))
    expect(callsTo('/api/auth/recovery-email/request', 'POST')[0].opts?.body).toEqual({ recovery_email: '', current_password: 'Correct-Horse-9' })
    await waitFor(() => expect(screen.queryByLabelText(/현재 비밀번호/)).toBeNull())
    expect(emailInput().value).toBe('')
    expect(screen.queryByTestId('recovery-pending')).toBeNull()
  })
})

describe('확인 링크 착지 — /verify-email?change=…', () => {
  const CHECK = 'POST /api/auth/recovery-email/check'
  it('착지만으로는 확정하지 않는다 — 버튼을 눌러야 확인 API 를 부른다', async () => {
    api.routes[CHECK] = () => ({ state: 'pending' })
    api.routes['POST /api/auth/recovery-email/confirm'] = () => ({ message: '복구 이메일이 변경되었습니다.' })
    renderAt(VerifyPage, '/verify-email?change=tok-123')
    const button = await screen.findByRole('button', { name: '복구 이메일 변경 확인' })
    expect(callsTo('/api/auth/recovery-email/check', 'POST')[0].opts?.body).toEqual({ token: 'tok-123' })
    expect(callsTo('/api/auth/recovery-email/confirm')).toHaveLength(0)      // 메일 보안 장비의 자동 열람은 이 단계까지만 도달
    fireEvent.click(button)
    expect(await screen.findByText('복구 이메일을 바꿨습니다')).toBeTruthy()
    expect(screen.getByText('복구 이메일이 변경되었습니다.')).toBeTruthy()
    const sent = callsTo('/api/auth/recovery-email/confirm', 'POST')
    expect(sent).toHaveLength(1)
    expect(sent[0].opts?.body).toEqual({ token: 'tok-123' })
    // 가입 인증 API 는 호출하지 않음. 로그인 상태이므로 내 정보를 재조회
    expect(callsTo('/api/auth/verify-email')).toHaveLength(0)
    expect(callsTo('/api/auth/me').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: '계정 설정으로' }).getAttribute('href')).toBe('/settings/account')
  })

  it('확정한 뒤 새로고침 — "이미 바꿨습니다"(실패 화면이 아니다)', async () => {
    api.routes[CHECK] = () => ({ state: 'done' })
    renderAt(VerifyPage, '/verify-email?change=tok-123')
    expect(await screen.findByText('복구 이메일을 바꿨습니다')).toBeTruthy()
    expect(screen.getByText(/이미 바꿨습니다/)).toBeTruthy()
    expect(callsTo('/api/auth/recovery-email/confirm')).toHaveLength(0)
  })

  it('만료·폐기된 링크는 버튼 없이 실패 화면', async () => {
    authStore.setState({ user: null, loading: false })
    api.routes[CHECK] = () => ({ state: 'invalid' })
    renderAt(VerifyPage, '/verify-email?change=old')
    expect(await screen.findByText('복구 이메일을 바꾸지 못했습니다')).toBeTruthy()
    expect(screen.getByText(/만료된 확인 링크/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '복구 이메일 변경 확인' })).toBeNull()
    expect(callsTo('/api/auth/recovery-email/confirm')).toHaveLength(0)
    expect(callsTo('/api/auth/me')).toHaveLength(0)
  })

  it('버튼을 눌렀는데 그 사이 무효가 됐으면 서버 안내를 보인다', async () => {
    api.routes[CHECK] = () => ({ state: 'pending' })
    api.routes['POST /api/auth/recovery-email/confirm'] = fail(400, '유효하지 않거나 만료된 확인 링크입니다. 설정에서 다시 요청해주세요')
    renderAt(VerifyPage, '/verify-email?change=old')
    fireEvent.click(await screen.findByRole('button', { name: '복구 이메일 변경 확인' }))
    expect(await screen.findByText('복구 이메일을 바꾸지 못했습니다')).toBeTruthy()
    expect(screen.getByText(/만료된 확인 링크/)).toBeTruthy()
  })

  it('가입 인증 링크(token)는 예전 그대로', async () => {
    api.routes['/api/auth/verify-email'] = () => ({ message: '이메일 인증이 완료되었습니다.' })
    renderAt(VerifyPage, '/verify-email?token=signup')
    expect(await screen.findByText('이메일 인증이 완료되었습니다.')).toBeTruthy()
    expect(callsTo('/api/auth/recovery-email/confirm')).toHaveLength(0)
  })
})
