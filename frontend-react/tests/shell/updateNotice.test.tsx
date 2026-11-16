// 업데이트 사전 공지 띠(일반/관리자)와 점검 화면 — 소켓 이벤트·최초 조회·API 실패 감지로 수신되는 상태,
// 카운트다운 종료 시 점검으로 전환, 점검 종료 시 자동 재연결, 관리자의 진행 화면은 덮지 않음, 정적 점검 페이지의 문구.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; body?: any }[],
  notice: null as any,          // /api/system/update-notice 의 응답(null 이면 실패)
  action: null as any,
}))
const chat = vi.hoisted(() => ({ listeners: [] as ((d: any) => void)[] }))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const f = async (url: string, opts: any = {}) => {
    api.calls.push({ url, method: (opts.method || 'GET').toUpperCase(), body: opts.body })
    if (url === '/api/system/update-notice') { if (api.notice == null) throw new Error('down'); return api.notice }
    if (url.includes('/jobs/') && url.endsWith('/action')) { if (api.action instanceof Error) throw api.action; return api.action ?? {} }
    return {}
  }
  const $fetch = Object.assign(f, { raw: f, native: fetch, create: () => f })
  return { ...real, $fetch }
})
vi.mock('~/composables/useChat', () => ({
  onChatEvent: (fn: (d: any) => void) => { chat.listeners.push(fn); return () => { chat.listeners = chat.listeners.filter(x => x !== fn) } },
}))

const notice = await import('~/composables/useUpdateNotice')
const realApi = await vi.importActual<typeof import('~/lib/api')>('~/lib/api')
const { LayoutUpdateCountdownBanner } = await import('~/components/layout/UpdateCountdownBanner')
const { UpdateNoticeHost } = await import('~/components/layout/MaintenanceScreen')
const { setUser } = await import('~/composables/useAuth')
const { i18n } = await import('~/i18n')

const USER = { id: 'm', username: 'member', display_name: '구성원', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null }
const ADMIN = { ...USER, id: 'a', username: 'admin', display_name: '관리자', is_admin: true }
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const at = (ms: number) => new Date(Date.now() + ms).toISOString()
const emit = (d: any) => act(() => { for (const fn of chat.listeners) fn(d) })
const NONE = { state: 'none', job: null, kind: null, ends_at: null, started_at: null, expected_seconds: null, contact: null }

/** 공개 점검 상태(/maintenance/status)와 /api/health 를 모의한다 */
const net = { status: null as any, health: true, hits: [] as string[] }
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    net.hits.push(String(url))
    if (String(url).endsWith('/maintenance/status')) {
      if (net.status == null) throw new Error('unreachable')
      if (net.status === 'html') return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
      return new Response(JSON.stringify(net.status), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).endsWith('/api/health')) return new Response('{}', { status: net.health ? 200 : 502 })
    return new Response('{}', { status: 404 })
  }))
}

function Shell() {
  return <><LayoutUpdateCountdownBanner /><UpdateNoticeHost /></>
}
const renderShell = async () => {
  const view = render(<Shell />)
  await waitFor(() => expect(chat.listeners.length).toBe(1))
  return view
}
const band = () => screen.queryByTestId('update-countdown')
const maint = () => screen.queryByTestId('maintenance-screen')
const reload = vi.fn()

beforeEach(() => {
  notice._resetUpdateNotice()
  notice.updateNoticeTiming.pollMs = 20
  notice.updateNoticeTiming.checkGapMs = 0
  notice.updateNoticeEnv.reload = reload
  reload.mockClear()
  api.calls = []; api.notice = NONE; api.action = null
  chat.listeners = []
  net.status = null; net.health = true; net.hits = []
  stubFetch()
  setUser(USER as any)
})
afterEach(() => { notice._resetUpdateNotice() })

describe('예고 띠', () => {
  it('일반 사용자: 저장하라는 안내와 남은 시간 — 관리 버튼은 없다', async () => {
    await renderShell()
    expect(band()).toBeNull()
    emit({ type: 'system.update_countdown', job: 'j1', kind: 'update', ends_at: at(252_000), expected_seconds: 240 })
    const el = band()!
    expect(text(el)).toContain('5분 뒤 업데이트를 시작합니다. 진행 중인 작업을 저장하십시오.')
    expect(text(el)).toContain('진행하는 동안 약 4분 접속할 수 없습니다.')
    expect(text(screen.getByTestId('update-countdown-clock'))).toMatch(/^04:1\d$/)
    expect(el.querySelectorAll('button')).toHaveLength(0)
    expect(text(el)).not.toMatch(/관리|구성원/)
    expect(maint()).toBeNull()
  })

  it('남은 시간 숫자는 낭독되지 않고, 낭독되는 문장은 분이 바뀔 때만 바뀐다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    render(<LayoutUpdateCountdownBanner />)
    act(() => { notice.handleUpdateEvent({ type: 'system.update_countdown', job: 'j1', kind: 'update', ends_at: at(250_000), expected_seconds: 240 }) })
    const live = band()!.querySelector('[aria-live]')!
    expect(live.getAttribute('role')).toBe('status')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('update-countdown-clock').getAttribute('aria-hidden')).toBe('true')
    expect(live.contains(screen.getByTestId('update-countdown-clock'))).toBe(false)

    const before = text(live)
    const clock0 = text(screen.getByTestId('update-countdown-clock'))
    act(() => { vi.advanceTimersByTime(3000) })
    expect(text(screen.getByTestId('update-countdown-clock'))).not.toBe(clock0)     // 숫자는 매초 변경되고
    expect(text(live)).toBe(before)                                                  // 문장은 유지됨
    act(() => { vi.advanceTimersByTime(12_000) })                                    // 4분대로 진입하면
    expect(text(live)).toBe('4분 뒤 업데이트를 시작합니다. 진행 중인 작업을 저장하십시오.')
  })

  it('1분 안쪽이면 지금 저장하라고 한다', async () => {
    await renderShell()
    emit({ type: 'system.update_countdown', job: 'j1', kind: 'update', ends_at: at(58_000), expected_seconds: 240 })
    expect(text(band())).toContain('곧 업데이트를 시작합니다. 지금 저장하십시오.')
    expect(text(screen.getByTestId('update-countdown-clock'))).toMatch(/^00:5\d$/)
  })

  it('예상 중단 시간을 모르면 그 문장은 없다. 복원이면 복원이라고 말한다', async () => {
    await renderShell()
    emit({ type: 'system.update_countdown', job: 'j1', kind: 'restore', ends_at: at(252_000), expected_seconds: null })
    expect(text(band())).toContain('5분 뒤 이전 버전으로 복원을 시작합니다. 진행 중인 작업을 저장하십시오.')
    expect(text(band())).not.toContain('접속할 수 없습니다')
  })

  it('관리자: "지금 바로 시작"과 "취소"', async () => {
    setUser(ADMIN as any)
    await renderShell()
    emit({ type: 'system.update_countdown', job: 'j1', kind: 'update', ends_at: at(252_000), expected_seconds: 240 })
    fireEvent.click(screen.getByRole('button', { name: '지금 바로 시작' }))
    await waitFor(() => expect(api.calls.find(c => c.url.endsWith('/jobs/j1/action'))?.body).toEqual({ action: 'start_now' }))
    expect(band()).toBeTruthy()                 // 시작 여부는 서버의 알림으로 확인

    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    await waitFor(() => expect(band()).toBeNull())
    expect(api.calls.filter(c => c.url.endsWith('/jobs/j1/action')).map(c => c.body.action)).toEqual(['start_now', 'cancel'])
    expect(maint()).toBeNull()
  })

  it('취소 알림이 오면 띠가 걷힌다', async () => {
    await renderShell()
    emit({ type: 'system.update_countdown', job: 'j1', kind: 'update', ends_at: at(252_000), expected_seconds: 240 })
    expect(band()).toBeTruthy()
    emit({ type: 'system.update_cancelled', job: 'j1' })
    expect(band()).toBeNull()
  })

  it('새로 접속한 화면은 조회로 지금의 예고를 안다', async () => {
    api.notice = { ...NONE, state: 'countdown', job: 'j1', kind: 'update', ends_at: at(200_000), expected_seconds: 240 }
    await renderShell()
    await waitFor(() => expect(band()).toBeTruthy())
    expect(text(band())).toContain('4분 뒤 업데이트를 시작합니다.')
    expect(api.calls.filter(c => c.url === '/api/system/update-notice')).toHaveLength(1)
  })

  it('로그인하지 않았으면 묻지 않는다', async () => {
    setUser(null)
    render(<Shell />)
    await new Promise(r => setTimeout(r, 30))
    expect(api.calls).toHaveLength(0)
    expect(chat.listeners).toHaveLength(0)
  })
})

describe('점검 화면', () => {
  it('점검 알림이 오면 화면을 덮는다: 문구, 시작 시각, 예상 시간 — 관리 메뉴·이름은 없다', async () => {
    net.status = { active: true, phase: 'running', kind: 'update', started_at: at(-10_000), expected_seconds: 240, contact: null }
    await renderShell()
    emit({ type: 'system.maintenance', active: true, kind: 'update', started_at: at(-10_000), expected_seconds: 240 })
    const el = maint()!
    expect(text(el)).toContain('업데이트 중입니다')
    expect(text(el)).toContain('관리자가 워크스페이스를 새 버전으로 변경하고 있습니다. 완료되면 이 화면이 자동으로 다시 열립니다.')
    expect(text(el)).toContain('시작')
    expect(text(el)).toContain('예상 시간4분')
    expect(screen.getByRole('button', { name: '지금 다시 연결' })).toBeTruthy()
    expect(screen.queryByTestId('maintenance-late')).toBeNull()
    expect(el.querySelectorAll('nav, a')).toHaveLength(0)
    expect(text(el)).not.toMatch(/구성원|member|관리 메뉴/)
    expect(el.className).not.toMatch(/h-screen|100vh/)
    expect(band()).toBeNull()
  })

  it('예상보다 길어지면 알리고, 연락처는 넣어 두었을 때만 보인다', async () => {
    net.status = { active: true, phase: 'running', kind: 'update', started_at: at(-600_000), expected_seconds: 240, contact: null }
    await renderShell()
    emit({ type: 'system.maintenance', active: true, kind: 'update', started_at: at(-600_000), expected_seconds: 240 })
    const late = screen.getByTestId('maintenance-late')
    expect(text(late)).toContain('예상보다 오래 걸리고 있습니다.')
    expect(text(late)).toContain('이 화면이 계속 표시되면 관리자에게 알려 주십시오.')
    expect(screen.queryByTestId('maintenance-contact')).toBeNull()

    // 다음 조회에서 연락처가 수신되면 표시됨
    net.status = { ...net.status, contact: '내선 1234' }
    expect(text(await screen.findByTestId('maintenance-contact'))).toBe('내선 1234')
  })

  it('복원·되돌림 중이면 그렇게 말한다', async () => {
    net.status = { active: true, phase: 'running', kind: 'restore', started_at: at(0), expected_seconds: null, contact: null }
    await renderShell()
    emit({ type: 'system.maintenance', active: true, kind: 'restore', started_at: at(0), expected_seconds: null })
    expect(text(maint())).toContain('점검 중입니다')
    expect(text(maint())).toContain('이전 버전으로 복원하고 있습니다.')
    expect(text(maint())).not.toContain('예상 시간')
  })

  it('카운트다운이 끝나면 점검 화면으로 바뀐다 — 서버에 물을 수 없어도', async () => {
    api.notice = null            // 서버가 이미 중지됨
    net.status = null
    await renderShell()
    emit({ type: 'system.update_countdown', job: 'j1', kind: 'update', ends_at: at(300), expected_seconds: 240 })
    expect(band()).toBeTruthy()
    await waitFor(() => expect(maint()).toBeTruthy(), { timeout: 3000 })
    expect(band()).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('API 가 실패하면 공개 점검 상태를 물어 점검 화면을 띄운다(서버가 내려가 있어도)', async () => {
    api.notice = null
    net.status = { active: true, phase: 'running', kind: 'update', started_at: at(-5000), expected_seconds: 240, contact: null }
    await renderShell()
    expect(maint()).toBeNull()
    act(() => { window.dispatchEvent(new CustomEvent(realApi.API_DOWN_EVENT, { detail: { status: 502 } })) })
    await waitFor(() => expect(maint()).toBeTruthy())
    expect(net.hits.some(u => u.endsWith('/maintenance/status'))).toBe(true)
  })

  it('API 가 실패해도 점검 중이 아니면(또는 물을 수 없으면) 화면을 덮지 않는다', async () => {
    await renderShell()
    for (const status of [{ active: false, phase: 'idle' }, 'html', null]) {
      net.status = status
      act(() => { window.dispatchEvent(new CustomEvent(realApi.API_DOWN_EVENT, { detail: { status: 0 } })) })
      await new Promise(r => setTimeout(r, 20))
      expect(maint()).toBeNull()
    }
  })

  it('점검이 끝나고 서버가 답하면 스스로 다시 연결한다', async () => {
    net.status = { active: true, phase: 'running', kind: 'update', started_at: at(-5000), expected_seconds: 240, contact: null }
    await renderShell()
    emit({ type: 'system.maintenance', active: true, kind: 'update', started_at: at(-5000), expected_seconds: 240 })
    expect(maint()).toBeTruthy()
    await new Promise(r => setTimeout(r, 60))
    expect(reload).not.toHaveBeenCalled()

    net.status = { active: false, phase: 'idle' }
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(maint()).toBeNull()
  })

  it('끝났지만 서버가 아직 답하지 않으면 "다시 연결 중"으로 기다린다', async () => {
    net.status = { active: false, phase: 'idle' }
    net.health = false
    await renderShell()
    emit({ type: 'system.maintenance', active: true, kind: 'update', started_at: at(-5000), expected_seconds: 240 })
    await waitFor(() => expect(text(maint())).toContain('다시 연결 중입니다'))
    expect(reload).not.toHaveBeenCalled()
    net.health = true
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('끝났다는 알림이 소켓으로 와도 다시 연결한다', async () => {
    net.status = { active: true, phase: 'running', kind: 'update', started_at: at(0), expected_seconds: 240, contact: null }
    notice.updateNoticeTiming.pollMs = 60_000
    await renderShell()
    emit({ type: 'system.maintenance', active: true, kind: 'update', started_at: at(0), expected_seconds: 240 })
    emit({ type: 'system.maintenance', active: false, result: 'success' })
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('"지금 다시 연결"은 기다리지 않고 바로 묻는다', async () => {
    net.status = { active: true, phase: 'running', kind: 'update', started_at: at(0), expected_seconds: 240, contact: null }
    notice.updateNoticeTiming.pollMs = 60_000
    await renderShell()
    emit({ type: 'system.maintenance', active: true, kind: 'update', started_at: at(0), expected_seconds: 240 })
    net.status = { active: false, phase: 'idle' }
    fireEvent.click(screen.getByRole('button', { name: '지금 다시 연결' }))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('공개 점검 상태를 물을 수 없는 설치는 서버의 조회로 끝을 안다', async () => {
    net.status = null
    api.notice = { ...NONE, state: 'maintenance', kind: 'update', started_at: at(-5000), expected_seconds: 240 }
    await renderShell()
    await waitFor(() => expect(maint()).toBeTruthy())
    api.notice = NONE
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('취소를 놓친 예고는 화면을 새로 열지 않고 조용히 걷힌다', async () => {
    net.status = { active: false, phase: 'idle' }
    await renderShell()
    emit({ type: 'system.update_countdown', job: 'j1', kind: 'update', ends_at: at(200), expected_seconds: 240 })
    await waitFor(() => expect(band()).toBeNull(), { timeout: 3000 })
    expect(maint()).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('관리자의 업데이트 진행 화면이 떠 있는 동안에는 덮지 않는다', async () => {
    net.status = { active: true, phase: 'running', kind: 'update', started_at: at(0), expected_seconds: 240, contact: null }
    function Progress() { notice.useMaintenanceExempt(); return <div data-testid="progress" /> }
    const view = render(<><Shell /><Progress /></>)
    await waitFor(() => expect(chat.listeners.length).toBe(1))
    emit({ type: 'system.maintenance', active: true, kind: 'update', started_at: at(0), expected_seconds: 240 })
    expect(maint()).toBeNull()
    expect(screen.getByTestId('progress')).toBeTruthy()
    // 해당 화면을 떠나면 점검 화면 표시
    view.rerender(<Shell />)
    await waitFor(() => expect(maint()).toBeTruthy())
  })
})

describe('API 실패 신호', () => {
  const heard = () => {
    const seen: number[] = []
    const fn = (e: Event) => { seen.push((e as CustomEvent).detail.status) }
    window.addEventListener(realApi.API_DOWN_EVENT, fn)
    return { seen, off: () => window.removeEventListener(realApi.API_DOWN_EVENT, fn) }
  }
  const resp = (status: number) => ({ response: { status } as Response })

  it('연결 실패와 502·503·504 만 알린다', () => {
    const h = heard()
    realApi.notifyApiDown(new Error('network'))
    realApi.notifyApiDown(resp(502)); realApi.notifyApiDown(resp(503)); realApi.notifyApiDown(resp(504))
    realApi.notifyApiDown(resp(500)); realApi.notifyApiDown(resp(404)); realApi.notifyApiDown(resp(401))
    h.off()
    expect(h.seen).toEqual([0, 502, 503, 504])
  })

  it('저장소 끊김과 호출부가 끊은 요청은 알리지 않는다', () => {
    const h = heard()
    realApi.notifyApiDown({ ...resp(503), data: { code: 'storage_unavailable' } })
    realApi.notifyApiDown(Object.assign(new Error('x'), { name: 'AbortError' }))
    realApi.notifyApiDown({ cause: { name: 'AbortError' } })
    h.off()
    expect(h.seen).toEqual([])
  })
})

describe('정적 점검 페이지(public/maintenance.html)', () => {
  const html = readFileSync(join(__dirname, '..', '..', 'public', 'maintenance.html'), 'utf8')
  const t = (k: string) => i18n.t(k)

  it('앱 안의 점검 화면과 같은 문구를 쓴다', () => {
    for (const key of ['title', 'body', 'titleRestore', 'bodyRestore', 'started', 'expected', 'late', 'lateBody', 'reconnect']) {
      expect(html, key).toContain(t(`shell.update.maint.${key}`))
    }
  })

  it('혼자 뜬다: 바깥 자원 없음, 공개 점검 상태를 묻고, 스크립트가 막혀도 새로 고친다', () => {
    expect(html).toMatch(/<meta http-equiv="refresh" content="30">/)
    expect(html).toContain("'/maintenance/status'")
    expect(html).toContain("'/api/health'")
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\//)
    expect(html).not.toMatch(/100vh/)
    expect(html).toMatch(/prefers-color-scheme: dark/)
    expect(html).toMatch(/prefers-reduced-motion/)
  })
})
