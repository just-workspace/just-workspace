// 관리 › 격리 브라우저 — 격리 규칙 상태(지금 걸린 목록·대기·사이드카 거부) · 대상 추가(추가 포트·강제 → 경고) · 거부 사유 ·
// 사용 스위치 · 출구 표시 · 세션 강제 종료(확인). $fetch 는 가짜.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({ calls: [] as { url: string; opts?: any }[], fail: null as string | null, warnings: [] as string[] }))
const dlg = vi.hoisted(() => ({ answer: true, asked: [] as string[] }))

const TARGET = {
  id: 't1', key: 'nas', name: 'NAS', url: 'http://nas.lan', host: 'nas.lan', enabled: true, mode: 'pixel', modes: ['pixel'],
  policy: { clipboard_to_browser: true, clipboard_from_browser: true, downloads: false, uploads: false, idle_minutes: 15, max_hours: 8 },
  allowed_hosts: ['nas.lan'], cpu: 2, memory_mb: 2048, allowed_group_ids: [], allowed_user_ids: [], private_ip: false,
  extra_ports: [], egress: [{ host: 'nas.lan', ip: '192.168.10.20', port: 80, forced: false }, { host: 'nas.lan', ip: '192.168.10.20', port: 443, forced: false }],
  egress_forced: false,
}
const OVERVIEW = () => ({
  targets: [TARGET],
  sessions: [{ id: 'f'.repeat(32), status: 'running', mode: 'pixel', modes: ['pixel'], target_id: 't1', target_key: 'nas', target_name: 'NAS', target_url: 'http://nas.lan',
    stream_url: '/rbi/x/', started_at: null, expires_at: null, idle_minutes: 15, max_hours: 8, last_seen_at: null, ended_at: null, end_reason: null, error: null, user_id: 'u9' }],
  status: {
    image: 'kasm', mirror_image: 'mirror', network: 'ws-rbi', subnet: '172.31.200.0/24', bridge: 'br-wsrbi', publish_ip: '172.28.0.1',
    max_sessions: 4, active_sessions: 1, public_origin: 'https://rbi.example',
    guard: { ok: true, reason: 'ok', age: 3, allow: ['192.168.10.70:80'], rules: 7, required: true, rejected: ['192.168.10.20:22 self-needs-force'], allow_rev: 'abc' },
    egress: { desired: ['192.168.10.20:443', '192.168.10.20:80'], pending: ['192.168.10.20:443', '192.168.10.20:80'], static: ['192.168.10.70:80'],
      ceiling: '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16', protected: '192.168.10.20', file: '/run/rbi-allow/allow.txt' },
  },
})

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const f = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    if (url === '/api/admin/rbi') return OVERVIEW()
    if (url.startsWith('/api/admin/rbi/targets') && api.fail) {
      throw Object.assign(new Error('400'), { status: 400, data: { detail: api.fail } })
    }
    if (url.startsWith('/api/admin/rbi/targets')) return { ...TARGET, warnings: api.warnings }
    return {}
  }
  const $fetch = Object.assign(f, { raw: f, native: fetch, create: () => f })
  return { ...real, $fetch }
})
vi.mock('~/composables/useDialog', () => ({ confirmBox: async (m: string) => { dlg.asked.push(m); return dlg.answer }, promptBox: async () => null, alertBox: async () => true }))

const { default: AdminRbiPage } = await import('~/pages/admin/rbi')
const { setUser } = await import('~/composables/useAuth')
const { toastStore } = await import('~/composables/useToast')

function renderPage() {
  const router = createMemoryRouter([{ path: '*', element: <AdminRbiPage /> }], { initialEntries: ['/admin/rbi'] })
  return render(<RouterProvider router={router} />)
}
const toasts = () => toastStore.getState().toasts.map((x: any) => `${x.type}:${x.message ?? x.title}`)

beforeEach(() => {
  api.calls = []; api.fail = null; api.warnings = []
  dlg.answer = true; dlg.asked = []
  toastStore.setState({ toasts: [] } as any)
  setUser({ id: 'a', username: 'admin', display_name: '관리자', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: true, last_login_at: null })
})

describe('관리 › 격리 브라우저', () => {
  it('격리 규칙 상태: 지금 걸린 목록 · 사이드카 대기 · 거부한 줄 · 고정 허용 · 전용 출처', async () => {
    renderPage()
    expect((await screen.findByTestId('rbi-allow-applied')).textContent).toBe('192.168.10.70:80')
    expect(screen.getByTestId('rbi-allow-pending').textContent).toContain('192.168.10.20:443, 192.168.10.20:80')
    expect(screen.getByTestId('rbi-allow-rejected').textContent).toContain('192.168.10.20:22 self-needs-force')
    expect(screen.getByText('https://rbi.example')).toBeTruthy()
    expect(screen.getByTestId('rbi-egress-nas').textContent).toContain('nas.lan → 192.168.10.20:80')
  })

  it('대상 추가: 추가 포트·강제를 보내고, 서버 경고는 경고 토스트로', async () => {
    api.warnings = ['192.168.10.50: 워크스페이스 자신의 주소(RP)를 강제로 엽니다']
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '대상 추가' }))
    const form = screen.getByRole('form', { name: '대상 편집' })
    const inputs = form.querySelectorAll('input')
    fireEvent.change(inputs[0], { target: { value: 'rp' } })
    fireEvent.change(inputs[1], { target: { value: 'RP' } })
    fireEvent.change(inputs[2], { target: { value: 'http://rp.lan:8443' } })
    fireEvent.change(screen.getByLabelText('추가 포트'), { target: { value: '8443, 9000' } })
    fireEvent.click(screen.getByRole('switch', { name: '워크스페이스 자신의 주소도 대상으로 강제' }))
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/admin/rbi/targets' && c.opts?.method === 'POST')).toBe(true))
    const body = api.calls.find(c => c.opts?.method === 'POST')!.opts.body
    expect(body).toMatchObject({ key: 'rp', url: 'http://rp.lan:8443', extra_ports: [8443, 9000], force: true })
    await waitFor(() => expect(toasts()).toContain('warning:192.168.10.50: 워크스페이스 자신의 주소(RP)를 강제로 엽니다'))
  })

  it('거부 사유는 서버 문구 그대로', async () => {
    api.fail = '8.8.8.8 — 허용 상한(RBI_ALLOW_CEILING) 밖입니다. 사설/LAN 주소만 열 수 있습니다'
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '대상 추가' }))
    const inputs = screen.getByRole('form', { name: '대상 편집' }).querySelectorAll('input')
    fireEvent.change(inputs[0], { target: { value: 'pub' } })
    fireEvent.change(inputs[1], { target: { value: 'Pub' } })
    fireEvent.change(inputs[2], { target: { value: 'http://8.8.8.8' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(toasts()).toContain(`error:${api.fail}`))
    // 폼은 닫히지 않는다(고쳐서 다시 저장)
    expect(screen.getByRole('form', { name: '대상 편집' })).toBeTruthy()
  })

  it('사용 스위치 → PUT enabled · 세션 강제 종료는 확인 뒤 DELETE', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: 'NAS 사용' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/admin/rbi/targets/t1' && c.opts?.method === 'PUT' && c.opts.body.enabled === false)).toBe(true))
    dlg.answer = false
    fireEvent.click(screen.getByRole('button', { name: '강제 종료' }))
    await waitFor(() => expect(dlg.asked.length).toBe(1))
    expect(api.calls.some(c => c.url.startsWith('/api/admin/rbi/sessions/'))).toBe(false)
    dlg.answer = true
    fireEvent.click(screen.getByRole('button', { name: '강제 종료' }))
    await waitFor(() => expect(api.calls.some(c => c.url === `/api/admin/rbi/sessions/${'f'.repeat(32)}` && c.opts?.method === 'DELETE')).toBe(true))
  })
})
