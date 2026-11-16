// 격리 브라우저 단독 앱(src/rbi-app — rbi 전용 출처): 홉 시작·홉 오류·대상 선택(딥 링크)·픽셀/미러 화면·신뢰 상단 줄·
// 단축키(상단 줄로/격리 화면으로)·방식 전환·끝내기·로그아웃. $fetch 와 MirrorClient 는 모의(mock).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

const SID = 'b'.repeat(32)
const NEW = 'c'.repeat(32)
const api = vi.hoisted(() => ({ calls: [] as { url: string; opts?: any }[], sessions: [] as any[], targets: [] as any[], me: null as any, recent: [] as any[] }))
const fake = vi.hoisted(() => ({ last: null as any, started: 0, stopped: 0, focused: 0 }))
const dlg = vi.hoisted(() => ({ answer: true, asked: [] as string[] }))

const POLICY = { clipboard_to_browser: true, clipboard_from_browser: false, downloads: false, uploads: false, idle_minutes: 15, max_hours: 8 }
const MIRROR = {
  id: SID, status: 'running', mode: 'mirror', modes: ['mirror', 'pixel'], target_id: 't1', target_key: 'portal', target_name: 'Portal', target_url: 'http://192.168.10.70',
  stream_url: `/rbi/${SID}/`, started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 8 * 3600e3).toISOString(),
  idle_minutes: 15, max_hours: 8, last_seen_at: null, ended_at: null, end_reason: null, error: null,
}
const PIXEL = { ...MIRROR, id: NEW, mode: 'pixel', stream_url: `/rbi/${NEW}/` }
const ME = { user: { id: 'u1', username: 'qa', display_name: '검수', is_admin: false }, workspace_url: 'https://ws.example' }

function err(status: number) { return Object.assign(new Error(String(status)), { status, statusCode: status, data: {} }) }

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const f = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    if (url === '/api/rbi/site/me') { if (!api.me) throw err(401); return api.me }
    if (url === '/api/rbi/site/logout') { api.me = null; return { ok: true } }
    if (url === '/api/rbi/targets') return { targets: api.targets, sessions: api.sessions, public_origin: 'https://rbi.example' }
    if (url === '/api/rbi/sessions/me') return { sessions: api.recent }
    if (url === '/api/rbi/sessions' && opts?.method === 'POST') { const s = opts.body?.mode === 'pixel' ? PIXEL : MIRROR; api.sessions = [s]; return s }
    if (url === `/api/rbi/sessions/${SID}/mode` && opts?.method === 'POST') { api.sessions = [PIXEL]; return PIXEL }
    if (url.endsWith('/ping')) return { status: 'running' }
    if (url.startsWith('/api/rbi/sessions/') && opts?.method === 'DELETE') { const s = api.sessions[0]; api.sessions = []; return { ...s, status: 'ended', stream_url: null, end_reason: 'user' } }
    if (url.startsWith('/api/rbi/sessions/')) return api.sessions[0]
    return {}
  }
  const $fetch = Object.assign(f, { raw: f, native: fetch, create: () => f })
  return { ...real, $fetch }
})
vi.mock('~/composables/useDialog', () => ({
  confirmBox: async (m: string) => { dlg.asked.push(m); return dlg.answer },
  promptBox: async () => null,
  alertBox: async () => true,
}))
vi.mock('~/lib/rbiMirror/mirror-client', () => ({
  MirrorClient: class {
    opt: any
    constructor(opt: any) { this.opt = opt; fake.last = this }
    start() { fake.started++ }
    stop() { fake.stopped++ }
    focusInput() { fake.focused++ }
    downloadUrl(id: string) { return `/rbi/${SID}/download/${id}` }
  },
}))

const { RbiApp, isBarShortcut } = await import('~/rbi-app/RbiApp')

const assign = vi.fn()
const origLocation = window.location
function setLocation(search: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...origLocation, pathname: '/', search, href: `https://rbi.example/${search}`, protocol: 'https:', host: 'rbi.example', assign },
  })
}

beforeEach(() => {
  api.calls = []; api.sessions = []; api.recent = []; api.me = ME
  api.targets = [
    { id: 't1', key: 'portal', name: 'Portal', url: 'http://192.168.10.70', host: '192.168.10.70', enabled: true, mode: 'mirror', modes: ['mirror', 'pixel'], policy: POLICY },
    { id: 't2', key: 'nas', name: 'NAS', url: 'http://192.168.10.20', host: '192.168.10.20', enabled: true, mode: 'pixel', modes: ['pixel'], policy: POLICY },
  ]
  fake.last = null; fake.started = 0; fake.stopped = 0; fake.focused = 0
  dlg.answer = true; dlg.asked = []
  assign.mockReset()
  setLocation('')
  window.history.replaceState = vi.fn()
})
afterEach(() => { Object.defineProperty(window, 'location', { configurable: true, value: origLocation }) })

describe('격리 브라우저 단독 앱 — 로그인', () => {
  it('rbi 세션이 없으면(401) SSO 홉(/auth/login?return=…)으로 바로 넘어간다', async () => {
    api.me = null
    setLocation('?target=portal')
    render(<RbiApp />)
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/auth/login?return=%2F%3Ftarget%3Dportal'))
    expect(await screen.findByText('워크스페이스 로그인으로 이동하는 중…')).toBeTruthy()
    // 워크스페이스 API 는 호출하지 않음(rbi 출처의 API 만)
    expect(api.calls.every(c => c.url.startsWith('/api/rbi/'))).toBe(true)
  })

  it('홉이 실패해 돌아오면(?sso_error=) 자동으로 다시 넘어가지 않고 사유 + [다시 로그인]', async () => {
    api.me = null
    setLocation('?sso_error=code')
    render(<RbiApp />)
    expect(await screen.findByText('로그인 코드가 만료됐거나 이미 쓰였습니다. 다시 로그인하세요.')).toBeTruthy()
    expect(assign).not.toHaveBeenCalled()
    expect(window.history.replaceState).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '워크스페이스로 로그인' }))
    expect(assign).toHaveBeenCalledWith('/auth/login?return=%2F')
  })
})

describe('격리 브라우저 단독 앱 — 대상 고르기', () => {
  it('딥 링크 ?target= 은 대상을 미리 고를 뿐 세션을 띄우지 않는다 — [열기] 를 눌러야 시작', async () => {
    setLocation('?target=nas')
    render(<RbiApp />)
    const card = await screen.findByTestId('rbi-target-nas')
    expect(card.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('rbi-target-portal').getAttribute('aria-pressed')).toBe('false')
    expect(api.calls.some(c => c.url === '/api/rbi/sessions' && c.opts?.method === 'POST')).toBe(false)
    const start = screen.getByRole('button', { name: 'NAS 열기' })
    await waitFor(() => expect(document.activeElement).toBe(start))
    fireEvent.click(start)
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/rbi/sessions' && c.opts?.method === 'POST' && c.opts.body.target_id === 't2')).toBe(true))
  })

  it('최근 세션 목록 — 끝난 세션은 사유, 진행 중은 [진행 중인 세션으로]', async () => {
    api.recent = [{ ...MIRROR, id: 'e'.repeat(32), status: 'ended', end_reason: 'idle', ended_at: new Date().toISOString() }]
    render(<RbiApp />)
    const list = await screen.findByTestId('rbi-recent')
    expect(list.textContent).toContain('Portal')
    expect(list.textContent).toContain('유휴')
  })

  it('미러 대상은 방식을 골라 열 수 있다(픽셀 선택 → mode=pixel 로 시작)', async () => {
    render(<RbiApp />)
    fireEvent.click(await screen.findByTestId('rbi-target-portal'))
    fireEvent.click(screen.getAllByRole('radio', { name: '픽셀' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Portal 열기' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/rbi/sessions' && c.opts?.body?.mode === 'pixel')).toBe(true))
    const frame = await screen.findByTitle('Portal') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toContain(`/rbi/${NEW}/?autoconnect=1`)
    expect(frame.getAttribute('src')).toContain(`path=rbi%2F${NEW}%2Fwebsockify`)
  })
})

describe('격리 브라우저 단독 앱 — 세션 화면', () => {
  it('미러: 스크립트 없는 iframe 이 화면을 채우고, 신뢰 줄에 주소(글자)·정책·연결/지연', async () => {
    api.sessions = [MIRROR]
    render(<RbiApp />)
    const frame = await screen.findByTitle('Portal — 미러') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(`/rbi/${SID}/view`)
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(frame.hasAttribute('allow')).toBe(false)
    await waitFor(() => expect(fake.started).toBe(1))
    expect(fake.last.opt.wsUrl).toBe(`wss://rbi.example/rbi/${SID}/mirror`)
    await act(async () => {
      fake.last.opt.onDoc({ cw: 1, ch: 1, vw: 1, vh: 1, sx: 0, sy: 0, url: 'http://192.168.10.70/legacy/labs', title: 'Portal' })
      fake.last.opt.onPolicy({ ci: true, co: false, dl: false, ul: false })
      fake.last.opt.onConnection(true)
      fake.last.opt.onStats({ connected: true, rttMs: 23.4 })
    })
    const url = screen.getByTestId('rbi-bar-url')
    expect(url.textContent).toBe('http://192.168.10.70/legacy/labs')
    expect(url.closest('a')).toBeNull()
    expect(screen.getByTestId('rbi-bar-title').textContent).toBe('Portal')
    expect(screen.getByText('클립보드: 내 PC → 브라우저만')).toBeTruthy()
    expect(screen.getByTestId('rbi-bar-status').textContent).toContain('연결됨')
    expect(screen.getByTestId('rbi-bar-status').textContent).toContain('23ms')
    // 세션이 열리면 포커스는 격리 화면(숨은 입력칸)
    await waitFor(() => expect(fake.focused).toBeGreaterThan(0))
  })

  it('Ctrl+Alt+B 는 격리 화면으로 보내지 않고 상단 줄로, 상단 줄에서 Esc 면 다시 격리 화면', async () => {
    api.sessions = [MIRROR]
    render(<RbiApp />)
    await screen.findByTitle('Portal — 미러')
    await waitFor(() => expect(fake.focused).toBeGreaterThan(0))
    const remote = vi.fn()
    // 미러의 숨은 입력칸 위치(원격으로 키를 전송하는 쪽) — 단축키는 여기까지 도달해서는 안 됨
    const ime = document.createElement('input')
    ime.addEventListener('keydown', remote)
    document.body.appendChild(ime)
    ime.focus()
    fireEvent.keyDown(ime, { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true })
    expect(remote).not.toHaveBeenCalled()
    const bar = document.querySelector('[data-rbi-bar]')!
    expect(bar.contains(document.activeElement)).toBe(true)
    const before = fake.focused
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(fake.focused).toBe(before + 1)
    // 다른 키는 그대로 원격으로 전달
    fireEvent.keyDown(ime, { key: 'b', code: 'KeyB', ctrlKey: true })
    expect(remote).toHaveBeenCalledTimes(1)
    ime.remove()
  })

  it('isBarShortcut — 물리 키 B + Ctrl+Alt 만(한글 자판에서도 code 로)', () => {
    expect(isBarShortcut({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, code: 'KeyB' })).toBe(true)
    expect(isBarShortcut({ ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: 'KeyB' })).toBe(false)
    expect(isBarShortcut({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: false, code: 'KeyB' })).toBe(false)
    expect(isBarShortcut({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, code: 'KeyN' })).toBe(false)
  })

  it('방식 전환(미러 → 픽셀): 확인 뒤 POST /mode, 새 세션은 KasmVNC iframe(같은 출처)', async () => {
    api.sessions = [MIRROR]
    render(<RbiApp />)
    await screen.findByTitle('Portal — 미러')
    fireEvent.click(screen.getByRole('radio', { name: '픽셀' }))
    await waitFor(() => expect(api.calls.some(c => c.url === `/api/rbi/sessions/${SID}/mode` && c.opts?.body?.mode === 'pixel')).toBe(true))
    const frame = await screen.findByTitle('Portal') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toContain(`/rbi/${NEW}/?autoconnect=1`)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms')
    await waitFor(() => expect(fake.stopped).toBe(1))
  })

  it('세션 끝내기 → 대상 고르기로 돌아온다', async () => {
    api.sessions = [PIXEL]
    render(<RbiApp />)
    await screen.findByTitle('Portal')
    fireEvent.click(screen.getByRole('button', { name: /세션 끝내기/ }))
    await waitFor(() => expect(api.calls.some(c => c.opts?.method === 'DELETE')).toBe(true))
    expect(await screen.findByTestId('rbi-target-portal')).toBeTruthy()
    expect(screen.queryByTitle('Portal')).toBeNull()
  })

  it('로그아웃: 열린 세션을 끝내고 rbi 세션만 지운 뒤 로그아웃 화면(자동 재로그인 없음)', async () => {
    api.sessions = [PIXEL]
    render(<RbiApp />)
    await screen.findByTitle('Portal')
    fireEvent.click(screen.getByRole('button', { name: /검수/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /로그아웃/ }))
    expect(await screen.findByText('로그아웃했습니다')).toBeTruthy()
    const urls = api.calls.map(c => `${c.opts?.method ?? 'GET'} ${c.url}`)
    expect(urls).toContain(`DELETE /api/rbi/sessions/${NEW}`)
    expect(urls).toContain('POST /api/rbi/site/logout')
    expect(urls.indexOf(`DELETE /api/rbi/sessions/${NEW}`)).toBeLessThan(urls.indexOf('POST /api/rbi/site/logout'))
    expect(assign).not.toHaveBeenCalled()
    expect(dlg.asked).toContain('진행 중인 세션을 끝내고 로그아웃할까요? 워크스페이스 로그인은 그대로입니다.')
  })
})
