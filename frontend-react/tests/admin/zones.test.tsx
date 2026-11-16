// 관리 › 구역 — 목록(설치 관리자 있음/없음), 켜기 창의 단계와 비활성 버튼·사유, 메모리 초과 차단, 연결 확인 상태,
// 진행·실패·완료 직후, 끄기 확인과 끄는 중, 설정 다시 열기, 서버 재시작 중 상태 유지. $fetch 는 모의(mock).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'


const api = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; body?: any }[],
  routes: {} as Record<string, (call: { url: string; method: string; body?: any }) => any>,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const f = async (url: string, opts: any = {}) => {
    const call = { url, method: (opts.method || 'GET').toUpperCase(), body: opts.body }
    api.calls.push(call)
    const handler = api.routes[`${call.method} ${url}`]
    if (!handler) return {}
    return handler(call)
  }
  const $fetch = Object.assign(f, { raw: f, native: fetch, create: () => f })
  return { ...real, $fetch }
})

const zonesPage = await import('~/pages/admin/zones')
const AdminZonesPage = zonesPage.default
const { setUser } = await import('~/composables/useAuth')
const { toastStore } = await import('~/composables/useToast')
const { platformStore } = await import('~/composables/usePlatform')
const { siteConfigStore } = await import('~/composables/useSiteConfig')
const sys = await import('~/composables/useSystemZones')

const B = '/api/admin/system'
const fail = (status: number, code: string, vars: Record<string, unknown> = {}) =>
  Object.assign(new Error(String(status)), { status, statusCode: status, data: { code, vars, detail: code } })

const row = (id: string, ko: string, o: Record<string, unknown> = {}) => ({
  id, kind: 'zone', name: { ko, en: id }, summary: { ko: `${ko} 설명`, en: '' }, recommend_mb: 1000, ports: [],
  enabled: false, has_settings: false, fits: true, menu: true, job: null, ...o,
})
const listing = (over: Record<string, Record<string, unknown>> = {}, top: Record<string, unknown> = {}) => ({
  installer: { available: true, reason: null },
  memory: { need_mb: 7000, have_mb: 15900, nominal_mb: 16384, ok: true },
  core: { name: { ko: '기본' }, recommend_mb: 4000 },
  zones: [
    row('mail', '메일', { enabled: true, has_settings: true, ports: ['25/tcp'], ...over.mail }),
    row('chat', '채팅', { enabled: true, recommend_mb: 0, ...over.chat }),
    row('docs', '문서 편집·위키·게시판', { enabled: true, recommend_mb: 2000, ...over.docs }),
    row('meetings', '회의', { has_settings: true, ...over.meetings }),
    row('git', '코드 저장소', { has_settings: true, recommend_mb: 500, ...over.git }),
    row('ai', 'AI 도우미', { has_settings: true, ...over.ai }),
  ],
  addons: [
    row('sso', 'SSO·LDAP 제공', { kind: 'addon', recommend_mb: 500, menu: false, ...over.sso }),
    row('rbi', '격리 브라우저', { kind: 'addon', recommend_mb: 100, menu: false, ...over.rbi }),
  ],
  ...top,
})
const job = (o: Record<string, unknown> = {}) => ({
  id: 'job1', kind: 'enable', zone: 'meetings', status: 'running', error: null, warnings: [], ports: [],
  stages: [{ id: 'pull', status: 'done' }, { id: 'configure', status: 'running' }, { id: 'connect', status: 'pending' }],
  started_at: '2026-01-01T00:00:00Z', finished_at: null, ...o,
})
const check = (o: Record<string, unknown> = {}) => ({
  zone: 'x', ok: true, errors: [], cautions: [], ports: [],
  memory: { need_mb: 8000, have_mb: 15900, nominal_mb: 16384, ok: true, below_minimum: false }, ...o,
})

function renderPage() {
  const router = createMemoryRouter([{ path: '*', element: <AdminZonesPage /> }], { initialEntries: ['/admin/zones'] })
  return render(<RouterProvider router={router} />)
}
const called = (method: string, url: string) => api.calls.filter(c => c.method === method && c.url === url)
const zoneRow = (id: string) => screen.getByTestId(`zone-${id}`)
const toggle = (name: string) => screen.getByRole('switch', { name: `${name} 활성화` })
const toasts = () => toastStore.getState().toasts.map((x: any) => `${x.type}:${x.message ?? x.title}`)
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => {
  api.calls = []
  api.routes = { [`GET ${B}/zones`]: () => listing() }
  zonesPage.zonesTiming.pollMs = 20
  toastStore.setState({ toasts: [] } as any)
  setUser({ id: 'a', username: 'admin', display_name: '관리자', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: true, last_login_at: null })
})

describe('관리 › 구역 — 목록', () => {
  it('서버가 준 구역과 애드온을 그린다: 이름·설명·권장 메모리·상태·합계', async () => {
    renderPage()
    expect(await screen.findByText('메일')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '선택 애드온' })).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(8)
    expect(screen.queryByText('상태 감시')).toBeNull()
    expect(zoneRow('mail').dataset.state).toBe('on')
    expect(screen.getByTestId('zone-mail-status').textContent).toBe('사용')
    expect(screen.getByTestId('zone-meetings-status').textContent).toBe('사용 안 함')
    expect(within(zoneRow('docs')).getByText('+2 GB')).toBeTruthy()
    expect(within(zoneRow('chat')).getByText('추가 없음')).toBeTruthy()
    expect(within(zoneRow('rbi')).getByText('+0.1 GB')).toBeTruthy()
    expect(screen.getByTestId('zones-memory').textContent).toBe('7 GB / 16 GB')
    expect(screen.getByRole('meter', { name: '권장 메모리' })).toBeTruthy()
    expect(toggle('메일').getAttribute('aria-checked')).toBe('true')
    expect(toggle('회의').getAttribute('aria-checked')).toBe('false')
    // 설정 버튼은 활성화되어 있고 설정이 있는 구역에만 표시
    expect(screen.getByRole('button', { name: '메일 설정' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '채팅 설정' })).toBeNull()
    expect(screen.queryByRole('button', { name: '회의 설정' })).toBeNull()
    expect(screen.queryByTestId('zones-readonly')).toBeNull()
  })

  it('설치 관리자 없이 구성한 설치: 안내와 읽기 전용 목록', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({}, {
      installer: { available: false, reason: 'not_configured' }, memory: { need_mb: 7000, have_mb: null, nominal_mb: null, ok: null } })
    renderPage()
    expect((await screen.findByTestId('zones-readonly')).textContent).toContain('이 설치는 설치 관리자 없이 구성돼 여기서 구역을 변경할 수 없습니다.')
    expect(screen.getAllByRole('switch').every(s => (s as HTMLButtonElement).disabled)).toBe(true)
    expect(toggle('메일').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('button', { name: '메일 설정' })).toBeNull()
    expect(screen.getByTestId('zones-memory').textContent).toBe('7 GB')
    expect(screen.queryByRole('meter')).toBeNull()
  })

  it('설치 관리자에 닿지 못하면 다른 안내와 [다시 확인]', async () => {
    let up = false
    api.routes[`GET ${B}/zones`] = () => (up ? listing() : listing({}, { installer: { available: false, reason: 'installer_unreachable' } }))
    renderPage()
    expect((await screen.findByTestId('zones-readonly')).textContent).toContain('설치 관리자에 연결하지 못했습니다.')
    up = true
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }))
    await waitFor(() => expect(screen.queryByTestId('zones-readonly')).toBeNull())
    expect((toggle('회의') as HTMLButtonElement).disabled).toBe(false)
  })

  it('목록을 못 받으면 오류와 다시 시도', async () => {
    let n = 0
    api.routes[`GET ${B}/zones`] = () => { if (n++ === 0) throw fail(500, 'x'); return listing() }
    renderPage()
    expect(await screen.findByText('구역 목록을 불러오지 못했습니다')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByText('메일')).toBeTruthy()
  })
})

describe('관리 › 구역 — 켜기 창', () => {
  it('회의: 설정(1/3) → 메모리와 포트 확인(2/3) → 켜면 창이 닫히고 행에서 진행', async () => {
    api.routes[`GET ${B}/zones/meetings/settings`] = () => ({ zone: 'meetings', enabled: false, settings: { turn: true, lossless_audio: false, public_ip: null }, detected: { public_ip: '203.0.113.24' } })
    api.routes[`POST ${B}/zones/meetings/check`] = () => check({ ports: ['7881/tcp', '7882-7892/udp', '4433/udp'] })
    api.routes[`POST ${B}/zones/meetings/enable`] = () => job()
    api.routes[`GET ${B}/jobs/job1`] = () => job()
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '회의 활성화' }))
    expect(await screen.findByRole('heading', { name: '회의 활성화 · 1/3 설정' })).toBeTruthy()
    expect((await screen.findByTestId('meet-ip')).textContent).toContain('203.0.113.24')
    // 중계를 비활성화하고 무손실을 활성화 — 선택 값이 그대로 전송됨
    fireEvent.click(screen.getByRole('radio', { name: /사용 안 함/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /무손실 오디오/ }))
    fireEvent.click(screen.getByRole('button', { name: '다음' }))
    expect(await screen.findByRole('heading', { name: '회의 활성화 · 2/3 메모리와 포트 확인' })).toBeTruthy()
    expect(called('POST', `${B}/zones/meetings/check`)[0].body).toEqual({ settings: { turn: false, lossless_audio: true } })
    expect(screen.getByTestId('zone-dialog-memory').textContent).toBe('7 GB → 8 GB · 서버 16 GB 이내입니다')
    expect(screen.getByTestId('zone-dialog-ports').textContent).toBe('TCP 7881 · UDP 7882-7892 · UDP 4433')
    // 이전 단계로 복귀해도 선택 값 유지
    fireEvent.click(screen.getByRole('button', { name: '이전' }))
    expect(screen.getByRole('radio', { name: /사용 안 함/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '다음' }))
    fireEvent.click(await screen.findByRole('button', { name: '활성화' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(called('POST', `${B}/zones/meetings/enable`)[0].body).toEqual({ settings: { turn: false, lossless_audio: true } })
    // 행 안에서 받기·설정·연결
    await waitFor(() => expect(zoneRow('meetings').dataset.state).toBe('busy'))
    expect(screen.getByTestId('zone-meetings-status').textContent).toBe('활성화 중')
    expect(screen.getByTestId('zone-meetings-stage-pull').textContent).toContain('다운로드')
    expect(screen.getByTestId('zone-meetings-stage-pull').textContent).toContain('완료')
    expect(screen.getByTestId('zone-meetings-stage-configure').textContent).toContain('진행 중')
    expect(screen.getByTestId('zone-meetings-stage-connect').textContent).toContain('대기')
    expect(toggle('회의').getAttribute('aria-checked')).toBe('true')
    // 동시 1건 — 다른 구역 스위치는 잠김
    expect((toggle('코드 저장소') as HTMLButtonElement).disabled).toBe(true)
    expect((toggle('회의') as HTMLButtonElement).disabled).toBe(true)
  })

  it('회의: 공인 주소를 감지하지 못했으면 직접 입력해야 [다음]이 켜진다', async () => {
    api.routes[`GET ${B}/zones/meetings/settings`] = () => ({ zone: 'meetings', enabled: false, settings: {}, detected: { public_ip: null } })
    api.routes[`POST ${B}/zones/meetings/check`] = () => check()
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '회의 활성화' }))
    expect((await screen.findByTestId('meet-ip')).textContent).toContain('공인 주소를 확인하지 못했습니다.')
    const next = screen.getByRole('button', { name: '다음' }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(screen.getByTestId('zone-dialog-reason').textContent).toBe('공인 주소가 있어야 다음 단계로 진행할 수 있습니다.')
    type('공인 주소', '203.0.113')
    expect(next.disabled).toBe(true)
    type('공인 주소', '203.0.113.9')
    expect(next.disabled).toBe(false)
    expect(screen.queryByTestId('zone-dialog-reason')).toBeNull()
    fireEvent.click(next)
    await waitFor(() => expect(called('POST', `${B}/zones/meetings/check`)[0]?.body).toEqual({ settings: { turn: true, lossless_audio: false, public_ip: '203.0.113.9' } }))
  })

  it('메모리를 넘으면 [켜기]가 꺼지고 이유가 보인다', async () => {
    api.routes[`POST ${B}/zones/sso/check`] = () => check({ ports: ['389/tcp', '636/tcp'], memory: { need_mb: 17500, have_mb: 15900, nominal_mb: 16384, ok: false } })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: 'SSO·LDAP 제공 활성화' }))
    // 설정이 없는 애드온은 두 단계 — 즉시 메모리와 포트 확인
    expect(await screen.findByRole('heading', { name: 'SSO·LDAP 제공 활성화 · 1/2 메모리와 포트 확인' })).toBeTruthy()
    expect((await screen.findByTestId('zone-dialog-memory')).textContent).toBe('활성화하면 17.5 GB · 이 서버의 메모리 16 GB를 초과하여 활성화할 수 없습니다')
    expect((screen.getByRole('button', { name: '활성화' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '이전' })).toBeNull()
    expect(called('POST', `${B}/zones/sso/enable`)).toHaveLength(0)
  })

  it('격리 브라우저도 설정 없이 두 단계: 열 포트 없음 → 켜기', async () => {
    api.routes[`POST ${B}/zones/rbi/check`] = () => check()
    api.routes[`POST ${B}/zones/rbi/enable`] = () => job({ zone: 'rbi' })
    api.routes[`GET ${B}/jobs/job1`] = () => job({ zone: 'rbi' })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '격리 브라우저 활성화' }))
    expect(await screen.findByRole('heading', { name: '격리 브라우저 활성화 · 1/2 메모리와 포트 확인' })).toBeTruthy()
    expect((await screen.findByTestId('zone-dialog-ports')).textContent).toBe('없음')
    expect(screen.getByText('새로 열 포트가 없습니다')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '활성화' }))
    await waitFor(() => expect(called('POST', `${B}/zones/rbi/enable`)[0]?.body).toEqual({ settings: null }))
    await waitFor(() => expect(zoneRow('rbi').dataset.state).toBe('busy'))
  })

  it('메일(외부 발신 서버): 연결 확인 전에는 [다음]이 꺼져 있고, 실패·확인됨 상태를 갖고, 값을 바꾸면 다시 확인해야 한다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ mail: { enabled: false } })
    api.routes[`GET ${B}/zones/mail/settings`] = () => ({ zone: 'mail', enabled: false, settings: { kind: 'builtin' }, detected: {} })
    let status = 'auth_failed'
    api.routes[`POST ${B}/probe/smtp`] = () => ({ status, detail: null })
    api.routes[`POST ${B}/zones/mail/check`] = () => check({ ports: [] })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '메일 활성화' }))
    // 내장: 메일 도메인 필수
    const next = await screen.findByRole('button', { name: '다음' }) as HTMLButtonElement
    await waitFor(() => expect(screen.getByTestId('zone-dialog-reason').textContent).toBe('메일 도메인을 입력해야 다음 단계로 진행할 수 있습니다.'))
    expect(next.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /외부 발신 서버/ }))
    expect(screen.getByTestId('zone-dialog-reason').textContent).toBe('발신 서버 연결이 확인되어야 다음 단계로 진행할 수 있습니다.')
    type('서버 주소', 'smtp.example.com')
    type('계정', 'sender@example.com')
    type('비밀번호', 'pw-1')
    fireEvent.click(screen.getByRole('radio', { name: 'SSL/TLS' }))
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }))
    expect((await screen.findByTestId('verify-status')).textContent).toBe('계정이나 비밀번호가 맞지 않습니다.')
    expect(next.disabled).toBe(true)
    expect(called('POST', `${B}/probe/smtp`)[0].body).toEqual({ host: 'smtp.example.com', port: 587, security: 'ssl', username: 'sender@example.com', password: 'pw-1' })
    status = 'ok'
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }))
    await waitFor(() => expect(screen.getByTestId('verify-status').textContent).toBe('발신 서버 연결 확인됨'))
    expect(next.disabled).toBe(false)
    // 확인 후 값을 변경하면 처음으로 복귀
    type('비밀번호', 'pw-2')
    expect(next.disabled).toBe(true)
    expect(screen.queryByTestId('verify-status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }))
    await waitFor(() => expect(next.disabled).toBe(false))
    fireEvent.click(next)
    await waitFor(() => expect(called('POST', `${B}/zones/mail/check`)[0]?.body).toEqual({
      settings: { kind: 'external', host: 'smtp.example.com', port: 587, security: 'ssl', username: 'sender@example.com', password: 'pw-2' } }))
  })

  it('메일(내장): 등록할 레코드를 확인해 상태를 보여 주고, 레코드가 빠져도 다음으로 갈 수 있다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ mail: { enabled: false } })
    api.routes[`GET ${B}/zones/mail/settings`] = () => ({ zone: 'mail', enabled: false, settings: { kind: 'builtin', mail_domain: 'example.com' }, detected: {} })
    api.routes[`POST ${B}/probe/mail-records`] = () => ({ mail_domain: 'example.com', ok: false, records: [
      { id: 'mx', name: 'example.com', type: 'MX', expected: '10 mail.example.com', current: ['10 mail.example.com'], status: 'ok' },
      { id: 'dkim', name: 'default._domainkey.example.com', type: 'TXT', expected: 'v=DKIM1; k=rsa; p=AAAA', current: [], status: 'missing' },
      { id: 'spf', name: 'example.com', type: 'TXT', expected: 'v=spf1 mx ~all', current: ['v=spf1 -all'], status: 'different' },
    ] })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '메일 활성화' }))
    expect(await screen.findByText('메일 주소는 이름@example.com 형태가 됩니다.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }))
    expect(await screen.findByText('아직 없음')).toBeTruthy()
    expect(screen.getByText('확인됨')).toBeTruthy()
    expect(screen.getByText('값이 다름')).toBeTruthy()
    expect(screen.getByText('v=DKIM1; k=rsa; p=AAAA')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'default._domainkey.example.com 값 복사' })).toBeTruthy()
    expect(called('POST', `${B}/probe/mail-records`)[0].body).toEqual({ mail_domain: 'example.com' })
    expect((screen.getByRole('button', { name: '다음' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('메일(내장): 설치 관리자가 레코드 확인을 지원하지 않으면 그렇게 알린다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ mail: { enabled: false } })
    api.routes[`GET ${B}/zones/mail/settings`] = () => ({ zone: 'mail', enabled: false, settings: { kind: 'builtin', mail_domain: 'example.com' }, detected: {} })
    api.routes[`POST ${B}/probe/mail-records`] = () => { throw fail(501, 'installer_unsupported') }
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '메일 활성화' }))
    fireEvent.click(await screen.findByRole('button', { name: '다시 확인' }))
    expect(await screen.findByText('이 설치 관리자에서는 레코드를 여기서 확인할 수 없습니다.')).toBeTruthy()
  })

  it('AI 도우미: 지금 연결은 키 확인이 통과해야 하고, 나중에는 바로 다음으로', async () => {
    api.routes[`GET ${B}/zones/ai/settings`] = () => ({ zone: 'ai', enabled: false, settings: {}, detected: {} })
    api.routes[`POST ${B}/probe/ai`] = () => ({ status: 'ok', http_status: 200, models: [] })
    api.routes[`POST ${B}/zones/ai/check`] = () => check()
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: 'AI 도우미 활성화' }))
    const next = await screen.findByRole('button', { name: '다음' }) as HTMLButtonElement
    await waitFor(() => expect(screen.getByTestId('zone-dialog-reason').textContent).toBe('키 연결이 확인되어야 다음 단계로 진행할 수 있습니다.'))
    expect(next.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'OpenAI' }))
    type('API 키', 'sk-test')
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }))
    await waitFor(() => expect(screen.getByTestId('verify-status').textContent).toBe('키 연결 확인됨'))
    expect(called('POST', `${B}/probe/ai`)[0].body).toEqual({ provider: 'openai', api_key: 'sk-test' })
    expect(next.disabled).toBe(false)
    // 나중에 — 키 없이 진행
    fireEvent.click(screen.getByRole('radio', { name: /나중에/ }))
    expect(screen.queryByLabelText('API 키')).toBeNull()
    expect(next.disabled).toBe(false)
    fireEvent.click(next)
    await waitFor(() => expect(called('POST', `${B}/zones/ai/check`)[0]?.body).toEqual({ settings: { mode: 'later' } }))
  })

  it('코드 저장소: 직접 지정은 버전을 적어야 하고, 검증된 버전이 아니면 경고', async () => {
    api.routes[`GET ${B}/zones/git/settings`] = () => ({ zone: 'git', enabled: false, settings: { version: 'tested', custom_version: null }, detected: {} })
    api.routes[`POST ${B}/zones/git/check`] = () => check({ ports: ['2222/tcp'] })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '코드 저장소 활성화' }))
    const next = await screen.findByRole('button', { name: '다음' }) as HTMLButtonElement
    await waitFor(() => expect(next.disabled).toBe(false))
    expect(screen.queryByText('연동을 확인하지 않은 버전')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /직접 지정/ }))
    expect(screen.getByText('연동을 확인하지 않은 버전')).toBeTruthy()
    expect(next.disabled).toBe(true)
    expect(screen.getByTestId('zone-dialog-reason').textContent).toBe('다운로드할 버전을 입력해야 다음 단계로 진행할 수 있습니다.')
    type('버전', '1.25.3')
    fireEvent.click(next)
    await waitFor(() => expect(called('POST', `${B}/zones/git/check`)[0]?.body).toEqual({ settings: { version: 'custom', custom_version: '1.25.3' } }))
    expect((await screen.findByTestId('zone-dialog-ports')).textContent).toBe('TCP 2222')
  })

  it('서버가 설정을 거부하면 1단계에 남아 이유를 보여 준다', async () => {
    api.routes[`GET ${B}/zones/git/settings`] = () => ({ zone: 'git', enabled: false, settings: { version: 'latest' }, detected: {} })
    api.routes[`POST ${B}/zones/git/check`] = () => { throw fail(422, 'settings_invalid', { errors: [{ field: 'version', code: 'invalid_value' }] }) }
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '코드 저장소 활성화' }))
    const next = await screen.findByRole('button', { name: '다음' }) as HTMLButtonElement
    await waitFor(() => expect(next.disabled).toBe(false))
    fireEvent.click(next)
    expect((await screen.findByTestId('zone-dialog-error')).textContent).toContain('version: invalid_value')
    expect(screen.getByRole('heading', { name: '코드 저장소 활성화 · 1/3 설정' })).toBeTruthy()
  })
})

describe('관리 › 구역 — 진행 · 실패 · 완료 직후', () => {
  it('돌아오면 목록이 알려 준 진행 중 작업을 이어 받고, 끝나면 메뉴를 새로 받는다', async () => {
    let current = job()
    let done = false
    api.routes[`GET ${B}/zones`] = () => (done
      ? listing({ meetings: { enabled: true, job: current } })
      : listing({ meetings: { job: current } }))
    api.routes[`GET ${B}/jobs/job1`] = () => current
    api.routes['GET /api/platform/modules'] = () => ({ modules: [{ id: 'meetings', enabled: true }] })
    api.routes['GET /api/health'] = () => ({ service: 'Workspace', zones: ['mail', 'meetings'] })
    platformStore.setState({ modules: [], loaded: false })
    const view = renderPage()
    await waitFor(() => expect(zoneRow('meetings').dataset.state).toBe('busy'))
    await waitFor(() => expect(called('GET', `${B}/jobs/job1`).length).toBeGreaterThan(1))

    done = true
    current = job({ status: 'done', ports: ['7881/tcp', '7882-7892/udp'], finished_at: '2026-01-01T00:01:00Z',
      stages: [{ id: 'pull', status: 'done' }, { id: 'configure', status: 'done' }, { id: 'connect', status: 'done' }] })
    await waitFor(() => expect(zoneRow('meetings').dataset.state).toBe('fresh'))
    const fresh = zoneRow('meetings').textContent || ''
    expect(fresh).toContain('방금 활성화했습니다. 왼쪽 메뉴에 추가됐습니다.')
    expect(fresh).toContain('TCP 7881 · UDP 7882-7892 포트를 공유기나 방화벽에서 열었는지 확인합니다.')
    expect(screen.getByTestId('zone-meetings-status').textContent).toBe('사용')
    // 모듈 목록과 설치된 구역을 재조회하여 메뉴에 반영
    await waitFor(() => expect(platformStore.getState().modules).toEqual([{ id: 'meetings', enabled: true }]))
    await waitFor(() => expect(siteConfigStore.getState().zones).toEqual(['mail', 'meetings']))
    // 종료 후에는 추가 조회 없음
    const n = called('GET', `${B}/jobs/job1`).length
    await new Promise(r => setTimeout(r, 80))
    expect(called('GET', `${B}/jobs/job1`).length).toBe(n)
    // 닫으면 제거됨
    fireEvent.click(within(zoneRow('meetings')).getByRole('button', { name: '닫기' }))
    await waitFor(() => expect(zoneRow('meetings').dataset.state).toBe('on'))
    expect(called('DELETE', `${B}/zones/meetings/job`)).toHaveLength(1)
    view.unmount()
  })

  it('메뉴가 생기지 않는 애드온은 "왼쪽 메뉴" 문구가 없고, 열 포트가 없으면 포트 안내도 없다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ rbi: { enabled: true, job: job({ zone: 'rbi', status: 'done', stages: [] }) } })
    renderPage()
    await waitFor(() => expect(zoneRow('rbi').dataset.state).toBe('fresh'))
    expect(zoneRow('rbi').textContent).toContain('방금 활성화했습니다.')
    expect(zoneRow('rbi').textContent).not.toContain('왼쪽 메뉴')
    expect(zoneRow('rbi').textContent).not.toContain('포트를 공유기')
  })

  it('화면을 떠나면 진행 읽기를 멈춘다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ meetings: { job: job() } })
    api.routes[`GET ${B}/jobs/job1`] = () => job()
    const view = renderPage()
    await waitFor(() => expect(called('GET', `${B}/jobs/job1`).length).toBeGreaterThan(0))
    view.unmount()
    const n = called('GET', `${B}/jobs/job1`).length
    await new Promise(r => setTimeout(r, 80))
    expect(called('GET', `${B}/jobs/job1`).length).toBe(n)
  })

  it('서버가 다시 뜨는 동안 읽기가 실패하면 "다시 연결 중"으로 두고, 돌아오면 이어 간다', async () => {
    let up = true
    api.routes[`GET ${B}/zones`] = () => listing({ meetings: { job: job() } })
    api.routes[`GET ${B}/jobs/job1`] = () => { if (!up) throw fail(502, ''); return job() }
    renderPage()
    await waitFor(() => expect(zoneRow('meetings').dataset.state).toBe('busy'))
    up = false
    expect(await screen.findByTestId('zones-reconnecting')).toBeTruthy()
    expect(screen.getByTestId('zone-meetings-status').textContent).toBe('다시 연결 중')
    expect(zoneRow('meetings').dataset.state).toBe('busy')
    up = true
    await waitFor(() => expect(screen.queryByTestId('zones-reconnecting')).toBeNull())
    expect(screen.getByTestId('zone-meetings-status').textContent).toBe('활성화 중')
  })

  it('켜기 실패: 꺼진 채로 남고, 기록 보기·다시 시도·꺼진 채로 두기', async () => {
    const failed = job({ status: 'failed', error: { cause: 'pull_failed', fix: 'see_log', vars: {} }, finished_at: '2026-01-01T00:01:00Z',
      stages: [{ id: 'pull', status: 'failed' }, { id: 'configure', status: 'pending' }, { id: 'connect', status: 'pending' }] })
    api.routes[`GET ${B}/zones`] = () => listing({ meetings: { job: failed } })
    api.routes[`GET ${B}/jobs/job1/log`] = () => ({ lines: ['── meetings 켜기 ──', '실패: pull_failed'] })
    api.routes[`GET ${B}/zones/meetings/settings`] = () => ({ zone: 'meetings', enabled: false, settings: {}, detected: { public_ip: '203.0.113.24' } })
    renderPage()
    await waitFor(() => expect(zoneRow('meetings').dataset.state).toBe('failed'))
    const r = within(zoneRow('meetings'))
    expect(screen.getByTestId('zone-meetings-status').textContent).toBe('활성화 실패')
    expect(r.getByText('회의에 필요한 이미지를 다운로드하지 못했습니다.')).toBeTruthy()
    expect(zoneRow('meetings').textContent).toContain('이 구역은 비활성화된 상태로 유지되고, 다른 구역은 그대로 동작합니다. 서버가 인터넷에 연결할 수 있는지 확인하고 다시 시도합니다.')
    expect(zoneRow('meetings').textContent).not.toContain('오프라인 업데이트')
    expect(toggle('회의').getAttribute('aria-checked')).toBe('false')
    // 기록 보기
    const logBtn = r.getByRole('button', { name: '로그 보기' })
    expect(logBtn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(logBtn)
    await waitFor(() => expect(screen.getByTestId('zone-meetings-log').textContent).toContain('실패: pull_failed'))
    expect(logBtn.getAttribute('aria-expanded')).toBe('true')
    expect(r.getByRole('button', { name: '로그 다운로드' })).toBeTruthy()
    // 다시 시도 — 입력해 둔 설정이 없으므로(화면 재진입 후) 창부터 표시
    fireEvent.click(r.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByRole('heading', { name: '회의 활성화 · 1/3 설정' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    // 꺼진 채로 두기
    fireEvent.click(r.getByRole('button', { name: '비활성화 상태로 두기' }))
    await waitFor(() => expect(zoneRow('meetings').dataset.state).toBe('off'))
    expect(called('DELETE', `${B}/zones/meetings/job`)).toHaveLength(1)
  })

  it('설정이 없는 구역의 다시 시도는 바로 다시 켠다', async () => {
    const failed = job({ zone: 'sso', status: 'failed', stages: [{ id: 'pull', status: 'done' }, { id: 'configure', status: 'failed' }, { id: 'connect', status: 'pending' }] })
    api.routes[`GET ${B}/zones`] = () => listing({ sso: { job: failed } })
    api.routes[`POST ${B}/zones/sso/enable`] = () => job({ id: 'job2', zone: 'sso' })
    api.routes[`GET ${B}/jobs/job2`] = () => job({ id: 'job2', zone: 'sso' })
    renderPage()
    await waitFor(() => expect(zoneRow('sso').dataset.state).toBe('failed'))
    expect(zoneRow('sso').textContent).toContain('SSO·LDAP 제공 설정을 적용하지 못했습니다.')
    expect(zoneRow('sso').textContent).not.toContain('인터넷')
    fireEvent.click(within(zoneRow('sso')).getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(zoneRow('sso').dataset.state).toBe('busy'))
    expect(called('POST', `${B}/zones/sso/enable`)[0].body).toEqual({ settings: null })
  })
})

describe('관리 › 구역 — 끄기', () => {
  it('확인 창을 거쳐 끄고, 끄는 중과 끄기 완료를 행에서 보여 준다', async () => {
    let current: any = null
    api.routes[`GET ${B}/zones`] = () => listing({ docs: current?.status === 'done' ? { enabled: false, job: current } : {} })
    api.routes[`POST ${B}/zones/docs/disable`] = () => { current = job({ id: 'job9', kind: 'disable', zone: 'docs', stages: [{ id: 'disconnect', status: 'running' }, { id: 'configure', status: 'pending' }] }); return current }
    api.routes[`GET ${B}/jobs/job9`] = () => current
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '문서 편집·위키·게시판 활성화' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('문서 편집·위키·게시판 구역을 비활성화하시겠습니까?')).toBeTruthy()
    expect(screen.getByTestId('zones-off-body').textContent).toBe('메뉴에서 이 구역의 화면이 사라집니다. 메모리 2 GB가 비워집니다. 데이터는 남아 있고, 다시 활성화하면 그대로 표시됩니다.')
    // 취소 시 변화 없음
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(called('POST', `${B}/zones/docs/disable`)).toHaveLength(0)
    expect(toggle('문서 편집·위키·게시판').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle('문서 편집·위키·게시판'))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '비활성화' }))
    await waitFor(() => expect(zoneRow('docs').dataset.state).toBe('busy'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByTestId('zone-docs-status').textContent).toBe('비활성화 중')
    expect(zoneRow('docs').textContent).toContain('열려 있는 화면을 닫고 구역을 중지하는 중입니다. 데이터는 그대로 둡니다.')
    expect(toggle('문서 편집·위키·게시판').getAttribute('aria-checked')).toBe('false')
    expect((toggle('문서 편집·위키·게시판') as HTMLButtonElement).disabled).toBe(true)

    current = { ...current, status: 'done', stages: [{ id: 'disconnect', status: 'done' }, { id: 'configure', status: 'done' }] }
    await waitFor(() => expect(zoneRow('docs').dataset.state).toBe('fresh'))
    expect(zoneRow('docs').textContent).toContain('비활성화했습니다. 데이터는 그대로 있고, 다시 활성화하면 그대로 표시됩니다.')
    expect(screen.getByTestId('zone-docs-status').textContent).toBe('사용 안 함')
  })

  it('메뉴도 메모리도 없는 구역은 그 문장을 뺀다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ chat: { menu: false } })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '채팅 활성화' }))
    expect((await screen.findByTestId('zones-off-body')).textContent).toBe('데이터는 남아 있고, 다시 활성화하면 그대로 표시됩니다.')
  })

  it('끄기 실패: 켜진 채로 남는다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ docs: { job: job({ kind: 'disable', zone: 'docs', status: 'failed', stages: [{ id: 'disconnect', status: 'failed' }, { id: 'configure', status: 'pending' }] }) } })
    renderPage()
    await waitFor(() => expect(zoneRow('docs').dataset.state).toBe('failed'))
    expect(screen.getByTestId('zone-docs-status').textContent).toBe('비활성화 실패')
    expect(zoneRow('docs').textContent).toContain('문서 편집·위키·게시판 구역을 비활성화하지 못했습니다.')
    expect(zoneRow('docs').textContent).toContain('이 구역은 활성화된 상태로 유지됩니다.')
    expect(toggle('문서 편집·위키·게시판').getAttribute('aria-checked')).toBe('true')
    expect(within(zoneRow('docs')).queryByRole('button', { name: '비활성화 상태로 두기' })).toBeNull()
  })

  it('다른 작업이 진행 중이면 알린다', async () => {
    api.routes[`POST ${B}/zones/docs/disable`] = () => { throw fail(409, 'busy') }
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '문서 편집·위키·게시판 활성화' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '비활성화' }))
    await waitFor(() => expect(toasts()).toContain('error:다른 작업이 진행 중입니다. 완료된 뒤 다시 시도하십시오.'))
  })
})

describe('관리 › 구역 — 켜진 구역의 설정 다시 열기', () => {
  it('AI 도우미: 나중에 → 지금 연결. 바꾼 내용이 없으면 [저장]이 꺼져 있다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ ai: { enabled: true } })
    api.routes[`GET ${B}/zones/ai/settings`] = () => ({ zone: 'ai', enabled: true, settings: { mode: 'later', provider: null, api_key_set: false }, detected: {} })
    api.routes[`POST ${B}/probe/ai`] = () => ({ status: 'ok' })
    api.routes[`PUT ${B}/zones/ai/settings`] = () => job({ id: 'job5', kind: 'update', zone: 'ai', stages: [{ id: 'configure', status: 'running' }, { id: 'connect', status: 'pending' }] })
    api.routes[`GET ${B}/jobs/job5`] = () => job({ id: 'job5', kind: 'update', zone: 'ai', stages: [{ id: 'configure', status: 'running' }, { id: 'connect', status: 'pending' }] })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'AI 도우미 설정' }))
    expect(await screen.findByRole('heading', { name: 'AI 도우미 설정' })).toBeTruthy()
    const save = await screen.findByRole('button', { name: '저장' }) as HTMLButtonElement
    await waitFor(() => expect(screen.getByTestId('zone-dialog-reason').textContent).toBe('변경한 내용이 없습니다.'))
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /지금 연결/ }))
    expect(screen.getByTestId('zone-dialog-reason').textContent).toBe('키 연결이 확인되어야 다음 단계로 진행할 수 있습니다.')
    type('API 키', 'sk-new')
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }))
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(called('PUT', `${B}/zones/ai/settings`)[0]?.body).toEqual({ settings: { mode: 'now', provider: 'anthropic', api_key: 'sk-new' } }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.getByTestId('zone-ai-status').textContent).toBe('설정 적용 중'))
    expect(screen.getByTestId('zone-ai-stage-configure').textContent).toContain('진행 중')
    expect(screen.queryByTestId('zone-ai-stage-pull')).toBeNull()
    expect(toggle('AI 도우미').getAttribute('aria-checked')).toBe('true')
  })

  it('메일: 열자마자 레코드를 다시 확인한다', async () => {
    api.routes[`GET ${B}/zones/mail/settings`] = () => ({ zone: 'mail', enabled: true, settings: { kind: 'builtin', mail_domain: 'example.com' }, detected: {} })
    api.routes[`POST ${B}/probe/mail-records`] = () => ({ mail_domain: 'example.com', ok: true, records: [
      { id: 'mx', name: 'example.com', type: 'MX', expected: '10 mail.example.com', current: [], status: 'ok' }] })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '메일 설정' }))
    expect(await screen.findByText('10 mail.example.com')).toBeTruthy()
    expect(called('POST', `${B}/probe/mail-records`)).toHaveLength(1)
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('메일(외부): 저장된 비밀번호는 돌려받지 않고, 비워 두면 보내지 않는다', async () => {
    api.routes[`GET ${B}/zones/mail/settings`] = () => ({ zone: 'mail', enabled: true, detected: {},
      settings: { kind: 'external', host: 'smtp.example.com', port: 587, security: 'starttls', username: 'u@example.com', password_set: true } })
    api.routes[`POST ${B}/probe/smtp`] = () => ({ status: 'ok' })
    api.routes[`PUT ${B}/zones/mail/settings`] = () => job({ id: 'job6', kind: 'update', zone: 'mail', stages: [] })
    api.routes[`GET ${B}/jobs/job6`] = () => job({ id: 'job6', kind: 'update', zone: 'mail', stages: [] })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '메일 설정' }))
    const pw = await screen.findByLabelText('비밀번호') as HTMLInputElement
    expect(pw.value).toBe('')
    expect(pw.placeholder).toBe('저장된 비밀번호를 사용합니다')
    type('서버 주소', 'smtp2.example.com')
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }))
    await waitFor(() => expect(screen.getByTestId('verify-status').textContent).toBe('발신 서버 연결 확인됨'))
    expect(called('POST', `${B}/probe/smtp`)[0].body).toEqual({ host: 'smtp2.example.com', port: 587, security: 'starttls', username: 'u@example.com' })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(called('PUT', `${B}/zones/mail/settings`)[0]?.body).toEqual({
      settings: { kind: 'external', host: 'smtp2.example.com', port: 587, security: 'starttls', username: 'u@example.com' } }))
  })

  it('코드 저장소: 버전 변경', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ git: { enabled: true } })
    api.routes[`GET ${B}/zones/git/settings`] = () => ({ zone: 'git', enabled: true, settings: { version: 'tested', custom_version: null }, detected: {} })
    api.routes[`PUT ${B}/zones/git/settings`] = () => job({ id: 'job7', kind: 'update', zone: 'git', stages: [] })
    api.routes[`GET ${B}/jobs/job7`] = () => job({ id: 'job7', kind: 'update', zone: 'git', stages: [] })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '코드 저장소 설정' }))
    fireEvent.click(await screen.findByRole('radio', { name: /최신/ }))
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(called('PUT', `${B}/zones/git/settings`)[0]?.body).toEqual({ settings: { version: 'latest', custom_version: null } }))
  })
})

describe('관리 › 구역 — 검증된 버전 · 켜기 전 주의', () => {
  it('코드 저장소: "검증된 버전" 옆에 실제 버전 글자가 보인다(설정이 알려 준 값이 우선, 없으면 목록의 값)', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({}, { git_verified_version: '1.25.3' })
    api.routes[`GET ${B}/zones/git/settings`] = () => ({ zone: 'git', enabled: false, settings: { version: 'tested' }, detected: {}, verified_version: '1.25.4' })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '코드 저장소 활성화' }))
    const tested = await screen.findByRole('radio', { name: /검증된 버전/ })
    await waitFor(() => expect(tested.textContent).toContain('1.25.4'))
    expect(screen.getByRole('radio', { name: /최신/ }).textContent).not.toContain('1.25')
  })

  it('코드 저장소: 설정을 못 읽어도 목록이 알려 준 버전을 쓰고, 아무도 모르면 적지 않는다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({}, { git_verified_version: '1.25.3' })
    api.routes[`GET ${B}/zones/git/settings`] = () => { throw fail(502, 'installer_error') }
    const first = renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '코드 저장소 활성화' }))
    expect((await screen.findByRole('radio', { name: /검증된 버전/ })).textContent).toContain('1.25.3')
    first.unmount()

    api.routes[`GET ${B}/zones`] = () => listing()
    api.routes[`GET ${B}/zones/git/settings`] = () => ({ zone: 'git', enabled: false, settings: { version: 'tested' }, detected: {} })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '코드 저장소 활성화' }))
    expect((await screen.findByRole('radio', { name: /검증된 버전/ })).textContent).toBe('검증된 버전이 워크스페이스 버전과 연동을 확인한 버전입니다')
  })

  it('메모리·포트 확인 단계에 서버가 준 주의를 문구로 보여 준다(값 채움, 모르는 키는 키째로)', async () => {
    api.routes[`GET ${B}/zones/git/settings`] = () => ({ zone: 'git', enabled: false, settings: { version: 'tested' }, detected: {} })
    api.routes[`POST ${B}/zones/git/check`] = () => check({
      ports: ['2222/tcp'],
      cautions: [
        { key: 'git_sso_needs_trusted_cert', vars: {} },
        { key: 'router_port_forward', vars: { ports: ['2222/tcp', '7882-7892/udp'] } },
        { key: 'proxy_side_certs_self_signed', vars: { names: ['mail.example.com', 'meet.example.com'] } },
        { key: 'account_domain_is_mail_domain', vars: { mail_domain: 'example.com' } },
        { key: 'something_new', vars: {} },
      ],
    })
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '코드 저장소 활성화' }))
    fireEvent.click(await screen.findByRole('button', { name: '다음' }))
    const box = await screen.findByTestId('zone-dialog-cautions')
    expect(box.textContent).toContain('활성화 전 확인 사항')
    const items = [...box.querySelectorAll('li')].map(li => li.textContent)
    expect(items).toEqual([
      '임시 인증서로는 코드 저장소의 로그인 연동이 동작하지 않습니다. 활성화는 되지만 연동이 보류되고, 인증서를 발급한 뒤 다시 연결할 수 있습니다.',
      '공유기에서 이 서버로 포트 포워딩을 설정해야 외부에서 접속됩니다: TCP 2222 · UDP 7882-7892',
      '프록시를 거치지 않는 이름(mail.example.com, meet.example.com)에는 자체 서명 인증서를 사용합니다. 메일 앱에서 인증서 경고가 표시될 수 있습니다.',
      '계정의 메일 주소는 아이디@example.com 형식이 됩니다.',
      '확인이 필요한 항목이 있습니다. (something_new)',
    ])
    // 주의는 차단하지 않음 — 켜기 가능
    expect((screen.getByRole('button', { name: '활성화' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('주의가 없으면 그 상자를 그리지 않는다', async () => {
    api.routes[`POST ${B}/zones/rbi/check`] = () => check()
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: '격리 브라우저 활성화' }))
    await screen.findByTestId('zone-dialog-memory')
    expect(screen.queryByTestId('zone-dialog-cautions')).toBeNull()
  })

  it('주의 문구는 서버가 아는 키마다 한국어·영어가 있다', async () => {
    const { default: ko } = await import('~/i18n/locales/ko.json')
    const { default: en } = await import('~/i18n/locales/en.json')
    for (const key of [...sys.CAUTION_KEYS, 'other']) {
      expect((ko as any).admin.zones.caution[key], `ko ${key}`).toBeTruthy()
      expect((en as any).admin.zones.caution[key], `en ${key}`).toBeTruthy()
    }
    expect(sys.cautionText({ key: 'turn_tls_alternate_port', vars: { port: 5349 } })).toEqual({ key: 'admin.zones.caution.turn_tls_alternate_port', values: { key: 'turn_tls_alternate_port', port: '5349' } })
    expect(sys.cautionText({ key: 'nope' }).key).toBe('admin.zones.caution.other')
  })
})

describe('관리 › 구역 — 연결 보류 · 다시 연결', () => {
  const pendingGit = { git: { enabled: true, pending: true, pending_reason: 'cert_untrusted' } }
  const connJob = (o: Record<string, unknown> = {}) => job({ id: 'conn1', kind: 'reconnect', zone: 'git', stages: [{ id: 'connect', status: 'running' }], ...o })

  it('켜져 있지만 연동이 보류된 구역: 배지와 한 줄 설명, [다시 연결]', async () => {
    api.routes[`GET ${B}/zones`] = () => listing(pendingGit)
    renderPage()
    await waitFor(() => expect(zoneRow('git').dataset.state).toBe('pending'))
    expect(screen.getByTestId('zone-git-status').textContent).toBe('연동 보류')
    const line = screen.getByTestId('zone-git-pending')
    expect(line.textContent).toContain('연동 보류')
    expect(line.textContent).toContain('접속 주소의 인증서가 신뢰되는 인증서로 변경되면 다시 연결할 수 있습니다.')
    expect(within(line).getByRole('button', { name: '코드 저장소 다시 연결' })).toBeTruthy()
    expect(toggle('코드 저장소').getAttribute('aria-checked')).toBe('true')      // 활성화된 구역
    expect(screen.queryByTestId('zone-mail-pending')).toBeNull()
  })

  it('[다시 연결] → 행에서 진행 → 연결되면 보류 표시가 걷힌다', async () => {
    let connected = false
    const doneJob = connJob({ status: 'done', stages: [{ id: 'connect', status: 'done' }] })
    // 종료 후의 목록에는 서버가 방금 종료된 작업을 행에 첨부함
    api.routes[`GET ${B}/zones`] = () => listing(connected ? { git: { enabled: true, job: doneJob } } : pendingGit)
    api.routes[`POST ${B}/zones/git/reconnect`] = () => connJob()
    api.routes[`GET ${B}/jobs/conn1`] = () => connJob()
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '코드 저장소 다시 연결' }))
    await waitFor(() => expect(zoneRow('git').dataset.state).toBe('busy'))
    expect(called('POST', `${B}/zones/git/reconnect`)).toHaveLength(1)
    expect(screen.getByTestId('zone-git-status').textContent).toBe('다시 연결 중')
    expect(screen.getByTestId('zone-git-stage-connect').textContent).toContain('워크스페이스와 연결')
    expect(screen.queryByTestId('zone-git-pending')).toBeNull()                 // 진행 중에는 진행 상태만 표시
    expect((toggle('메일') as HTMLButtonElement).disabled).toBe(true)           // 동시 1건

    connected = true
    api.routes[`GET ${B}/jobs/conn1`] = () => doneJob
    await waitFor(() => expect(zoneRow('git').dataset.state).toBe('fresh'))
    expect(zoneRow('git').textContent).toContain('다시 연결했습니다.')
    expect(screen.queryByTestId('zone-git-pending')).toBeNull()
  })

  it('여전히 안 걸리면 실패로 남고, [다시 시도]가 다시 연결을 부른다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing({ git: { ...pendingGit.git, job: connJob({ status: 'failed', stages: [{ id: 'connect', status: 'failed' }], error: { cause: 'connection_still_pending', vars: { zone: 'git', reason: 'cert_untrusted' } } }) } })
    api.routes[`POST ${B}/zones/git/reconnect`] = () => connJob({ id: 'conn2' })
    api.routes[`GET ${B}/jobs/conn2`] = () => connJob({ id: 'conn2' })
    renderPage()
    await waitFor(() => expect(zoneRow('git').dataset.state).toBe('failed'))
    expect(screen.getByTestId('zone-git-status').textContent).toBe('연결 실패')
    expect(zoneRow('git').textContent).toContain('코드 저장소의 로그인 연동을 아직 연결하지 못했습니다.')
    expect(zoneRow('git').textContent).toContain('이 구역은 활성화된 상태로 유지됩니다.')
    expect(screen.queryByTestId('zone-git-pending')).toBeNull()                 // 실패 행이 대신 안내
    expect(screen.queryByRole('button', { name: '비활성화 상태로 두기' })).toBeNull()
    fireEvent.click(within(zoneRow('git')).getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(called('POST', `${B}/zones/git/reconnect`)).toHaveLength(1))
    await waitFor(() => expect(zoneRow('git').dataset.state).toBe('busy'))
    expect(called('POST', `${B}/zones/git/enable`)).toHaveLength(0)
  })

  it('그사이 연결됐으면(not_pending) 목록만 새로 받고, 다른 작업 중이면 알린다', async () => {
    let state: 'pending' | 'ok' = 'pending'
    api.routes[`GET ${B}/zones`] = () => listing(state === 'pending' ? pendingGit : { git: { enabled: true } })
    api.routes[`POST ${B}/zones/git/reconnect`] = () => { throw fail(409, 'busy') }
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '코드 저장소 다시 연결' }))
    await waitFor(() => expect(toasts()).toEqual(['error:다른 작업이 진행 중입니다. 완료된 뒤 다시 시도하십시오.']))

    state = 'ok'
    api.routes[`POST ${B}/zones/git/reconnect`] = () => { throw fail(409, 'not_pending') }
    fireEvent.click(screen.getByRole('button', { name: '코드 저장소 다시 연결' }))
    await waitFor(() => expect(zoneRow('git').dataset.state).toBe('on'))
    expect(toasts()).toHaveLength(1)
  })

  it('설치 관리자가 없는 설치에서는 [다시 연결]이 없다', async () => {
    api.routes[`GET ${B}/zones`] = () => listing(pendingGit, { installer: { available: false, reason: 'not_configured' } })
    renderPage()
    await screen.findByTestId('zone-git-pending')
    expect(screen.queryByRole('button', { name: '코드 저장소 다시 연결' })).toBeNull()
  })
})

describe('구역 계산', () => {
  it('포트·메모리 표기', () => {
    expect(sys.formatPorts(['7881/tcp', '7882-7892/udp'])).toBe('TCP 7881 · UDP 7882-7892')
    expect(sys.formatPorts([])).toBe('')
    expect(sys.recommendGb(1500)).toBe('1.5')
    expect(sys.recommendGb(100)).toBe('0.1')
    expect(sys.gb(16384)).toBe('16')
    expect(sys.gb(null)).toBe('0')
  })
  it('다음을 막는 이유', () => {
    const b = sys.blockReason
    expect(b('mail', { kind: 'builtin', mail_domain: ' ' }, false, null)).toBe('admin.zones.mail.needDomain')
    expect(b('mail', { kind: 'external' }, false, null)).toBe('admin.zones.mail.needVerify')
    expect(b('mail', { kind: 'external' }, true, null)).toBeNull()
    expect(b('meetings', { public_ip: '' }, false, null)).toBe('admin.zones.meet.needIp')
    expect(b('meetings', { public_ip: '' }, false, '203.0.113.1')).toBeNull()
    expect(b('meetings', { public_ip: '999.1.1.1' }, false, '203.0.113.1')).toBe('admin.zones.meet.needIp')
    expect(b('ai', { mode: 'later' }, false, null)).toBeNull()
    expect(b('git', { version: 'custom', custom_version: '' }, false, null)).toBe('admin.zones.git.needVersion')
    expect(b('chat', {}, false, null)).toBeNull()
  })
  it('비운 비밀값은 보내지 않는다', () => {
    expect(sys.toPayload('ai', { mode: 'now', provider: 'openai', api_key: '' })).toEqual({ mode: 'now', provider: 'openai' })
    expect(sys.toPayload('sso', {})).toBeNull()
    expect(sys.errorCode({ data: { code: 'busy' } })).toBe('busy')
    expect(sys.errorCode(new Error('x'))).toBe('')
    expect(sys.localized({ en: 'Mail' }, 'ko')).toBe('Mail')
  })
})
