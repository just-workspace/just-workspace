// 격리 브라우저 단독 앱 — 관리자가 접근을 끝냈을 때(강제 종료·권한 회수·대상 끄기/삭제 = end_reason "admin"):
// 화면이 대상 고르기로 돌아가며 "관리자가 접근을 종료했습니다" 를 알린다. 미러는 연결이 끊기는 즉시 상태를 다시 읽는다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

const SID = 'b'.repeat(32)
const api = vi.hoisted(() => ({ calls: [] as { url: string; opts?: any }[], sessions: [] as any[], targets: [] as any[], recent: [] as any[], current: null as any, ping: 'running' }))
const fake = vi.hoisted(() => ({ last: null as any }))

const POLICY = { clipboard_to_browser: true, clipboard_from_browser: false, downloads: false, uploads: false, idle_minutes: 15, max_hours: 8 }
const MIRROR = {
  id: SID, status: 'running', mode: 'mirror', modes: ['mirror', 'pixel'], target_id: 't1', target_key: 'portal', target_name: 'Portal', target_url: 'http://192.168.10.70',
  stream_url: `/rbi/${SID}/`, started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 8 * 3600e3).toISOString(),
  idle_minutes: 15, max_hours: 8, last_seen_at: null, ended_at: null, end_reason: null, error: null,
}
const ended = (reason: string) => ({ ...MIRROR, status: 'ended', stream_url: null, end_reason: reason, ended_at: new Date().toISOString() })
const ME = { user: { id: 'u1', username: 'qa', display_name: '검수', is_admin: false }, workspace_url: 'https://ws.example' }

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const f = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    if (url === '/api/rbi/site/me') return ME
    if (url === '/api/rbi/targets') return { targets: api.targets, sessions: api.sessions, public_origin: 'https://rbi.example' }
    if (url === '/api/rbi/sessions/me') return { sessions: api.recent }
    if (url.endsWith('/ping')) return { status: api.ping }
    if (url.startsWith('/api/rbi/sessions/')) return api.current
    return {}
  }
  const $fetch = Object.assign(f, { raw: f, native: fetch, create: () => f })
  return { ...real, $fetch }
})
vi.mock('~/composables/useDialog', () => ({ confirmBox: async () => true, promptBox: async () => null, alertBox: async () => true }))
vi.mock('~/lib/rbiMirror/mirror-client', () => ({
  MirrorClient: class {
    opt: any
    constructor(opt: any) { this.opt = opt; fake.last = this }
    start() {}
    stop() {}
    focusInput() {}
    downloadUrl(id: string) { return `/rbi/${SID}/download/${id}` }
  },
}))

const { RbiApp } = await import('~/rbi-app/RbiApp')
const { toastStore } = await import('~/composables/useToast')

const origLocation = window.location
const toasts = () => toastStore.getState().toasts.map(t => t.message)
const statusFetches = () => api.calls.filter(c => c.url === `/api/rbi/sessions/${SID}` && !c.opts?.method).length

beforeEach(() => {
  api.calls = []; api.recent = []; api.ping = 'running'
  api.sessions = [MIRROR]; api.current = MIRROR
  api.targets = [{ id: 't1', key: 'portal', name: 'Portal', url: 'http://192.168.10.70', host: '192.168.10.70', enabled: true, mode: 'mirror', modes: ['mirror', 'pixel'], policy: POLICY }]
  fake.last = null
  toastStore.setState({ toasts: [] })
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...origLocation, pathname: '/', search: '', href: 'https://rbi.example/', protocol: 'https:', host: 'rbi.example', assign: vi.fn() },
  })
  window.history.replaceState = vi.fn()
})
afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, 'location', { configurable: true, value: origLocation })
})

async function openMirror() {
  render(<RbiApp />)
  await screen.findByTitle('Portal — 미러')
  await waitFor(() => expect(fake.last).toBeTruthy())
  await act(async () => { fake.last.opt.onConnection(true) })
}

describe('격리 브라우저 — 관리자가 접근을 끝냈을 때', () => {
  it('미러 연결이 끊기면 핑 주기를 기다리지 않고 상태를 읽어, 끝났으면 대상 고르기 + 안내', async () => {
    await openMirror()
    expect(statusFetches()).toBe(0)
    // 서버가 세션을 끝냈다(권한 회수) — 컨테이너가 지워져 미러 연결이 끊긴다
    api.current = ended('admin'); api.sessions = []; api.recent = [ended('admin')]
    await act(async () => { fake.last.opt.onConnection(false, 'closed') })
    await waitFor(() => expect(statusFetches()).toBe(1))
    await waitFor(() => expect(screen.queryByTitle('Portal — 미러')).toBeNull())
    expect(toasts()).toContain('관리자가 접근을 종료했습니다')
    // 대상 고르기로 돌아오고 최근 목록에 사유
    const list = await screen.findByTestId('rbi-recent')
    await waitFor(() => expect(list.textContent).toContain('관리자 종료'))
  })

  it('연결만 잠깐 끊긴 것이면(세션은 살아 있음) 화면을 그대로 둔다 — 안내도 없다', async () => {
    await openMirror()
    await act(async () => { fake.last.opt.onConnection(false, 'network') })
    await waitFor(() => expect(statusFetches()).toBe(1))
    expect(screen.getByTitle('Portal — 미러')).toBeTruthy()
    expect(toasts()).not.toContain('관리자가 접근을 종료했습니다')
  })

  it('다른 사유(유휴 등)로 끝난 세션에는 관리자 안내를 띄우지 않는다', async () => {
    await openMirror()
    api.current = ended('idle'); api.sessions = []
    await act(async () => { fake.last.opt.onConnection(false, 'closed') })
    await waitFor(() => expect(screen.queryByTitle('Portal — 미러')).toBeNull())
    expect(toasts()).not.toContain('관리자가 접근을 종료했습니다')
  })

  it('핑(60초)이 끝난 세션을 보고해도 같은 안내 — 픽셀 화면처럼 끊김 신호가 없는 경우', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await openMirror()
    api.current = ended('admin'); api.sessions = []; api.ping = 'ended'
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    await waitFor(() => expect(screen.queryByTitle('Portal — 미러')).toBeNull())
    expect(toasts()).toContain('관리자가 접근을 종료했습니다')
  })
})
