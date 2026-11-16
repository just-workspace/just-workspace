// 관리 › 보안 — 인증서 카드: 상태(임시·자동·만료 임박), 다시 발급과 진행·완료·실패, 인증서 올리기와 검증 실패 항목,
// 화면을 새로 열었을 때의 최근 작업, 프록시가 맡는 설치, 설치 관리자 없는 설치(예전 카드로). $fetch 는 가짜.
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

const card = await import('~/components/admin/AdminCertCard')
const { AdminCertCard } = card
const certLib = await import('~/composables/useSystemCert')
const AdminSecurityPage = (await import('~/pages/admin/security')).default
const { setUser } = await import('~/composables/useAuth')

const B = '/api/admin/system'
const fail = (status: number, code: string, vars: Record<string, unknown> = {}) =>
  Object.assign(new Error(String(status)), { status, statusCode: status, data: { code, vars, detail: code } })

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()
const cert = (o: Record<string, unknown> = {}) => ({
  managed: true, mode: 'temporary', temporary: true, domain: 'ws.example.com', names: ['ws.example.com'],
  not_after: days(300), days_left: 300, issuer: 'ws.example.com', self_signed: true, pending: ['git'], job: null, ...o,
})
const issued = (o: Record<string, unknown> = {}) => cert({
  mode: 'auto', temporary: false, names: ['ws.example.com', 'mail.example.com'], not_after: days(80), days_left: 80,
  issuer: "Let's Encrypt", self_signed: false, pending: [], ...o,
})
const job = (o: Record<string, unknown> = {}) => ({
  id: 'cert1', kind: 'cert', zone: null, status: 'running', error: null, warnings: [], ports: [],
  stages: [{ id: 'issue', status: 'running' }, { id: 'reload', status: 'pending' }, { id: 'reconnect', status: 'pending' }],
  started_at: new Date().toISOString(), finished_at: null, ...o,
})
const doneStages = [{ id: 'issue', status: 'done' }, { id: 'reload', status: 'done' }, { id: 'reconnect', status: 'done' }]
const called = (method: string, url: string) => api.calls.filter(c => c.method === method && c.url === url)
const file = (name: string, text: string) => new File([text], name, { type: 'application/x-pem-file' })
const pick = (label: string, f: File) => fireEvent.change(screen.getByLabelText(label), { target: { files: [f] } })

beforeEach(() => {
  api.calls = []
  api.routes = { [`GET ${B}/cert`]: () => cert(), [`GET ${B}/jobs`]: () => ({ jobs: [] }) }
  card.certTiming.pollMs = 20
  setUser({ id: 'a', username: 'admin', display_name: '관리자', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: true, last_login_at: null })
})

describe('인증서 카드 — 상태', () => {
  it('임시 인증서: 종류·주소·만료·발급자·이름과 경고, 보류된 구역 연결 수', async () => {
    render(<AdminCertCard />)
    const box = await screen.findByTestId('cert-card')
    expect(box.dataset.state).toBe('temporary')
    expect(screen.getByTestId('cert-mode').textContent).toBe('임시 인증서 (자체 서명)')
    expect(screen.getByTestId('cert-expiry').textContent).toContain('300일 남음')
    expect(screen.getByTestId('cert-names').textContent).toBe('ws.example.com')
    expect(box.textContent).toContain('접속 주소')
    expect(box.textContent).toContain('발급자')
    const warn = screen.getByTestId('cert-temporary')
    expect(warn.textContent).toContain('지금은 임시 인증서라 브라우저가 경고를 보여 줍니다.')
    expect(warn.textContent).toContain('보류된 구역 연결 1건을 다시 시도합니다.')
    expect((screen.getByRole('button', { name: '다시 발급' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '인증서 올리기' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('발급된 인증서: 경고가 없고, 만료가 가까우면 "갱신 필요", 지났으면 "만료됨"', async () => {
    api.routes[`GET ${B}/cert`] = () => issued()
    const first = render(<AdminCertCard />)
    const box = await screen.findByTestId('cert-card')
    expect(box.dataset.state).toBe('ok')
    expect(screen.getByTestId('cert-mode').textContent).toBe("자동 발급 (Let's Encrypt)")
    expect(screen.getByTestId('cert-names').textContent).toBe('ws.example.com, mail.example.com')
    expect(screen.queryByTestId('cert-temporary')).toBeNull()
    expect(box.textContent).not.toContain('갱신 필요')
    first.unmount()

    api.routes[`GET ${B}/cert`] = () => issued({ not_after: days(12), days_left: 12 })
    const second = render(<AdminCertCard />)
    expect((await screen.findByTestId('cert-card')).textContent).toContain('갱신 필요')
    expect(screen.getByTestId('cert-expiry').textContent).toContain('12일 남음')
    second.unmount()

    api.routes[`GET ${B}/cert`] = () => issued({ mode: 'upload', not_after: days(-3), days_left: -3 })
    render(<AdminCertCard />)
    await screen.findByTestId('cert-card')
    expect(screen.getByTestId('cert-mode').textContent).toBe('올린 인증서')
    expect(screen.getByTestId('cert-expiry').textContent).toContain('만료됨')
  })

  it('앞단 프록시가 맡는 설치: 안내만 있고 버튼이 없다', async () => {
    api.routes[`GET ${B}/cert`] = () => cert({ managed: false, mode: 'proxy', temporary: false, names: [], not_after: null, days_left: null, issuer: null, pending: [] })
    const onLegacy = vi.fn()
    render(<AdminCertCard onLegacy={onLegacy} />)
    const box = await screen.findByTestId('cert-card')
    expect(box.dataset.state).toBe('proxy')
    expect(box.textContent).toContain('이 설치의 인증서는 앞단 프록시가 맡습니다.')
    expect(screen.queryByRole('button', { name: '다시 발급' })).toBeNull()
    expect(screen.queryByRole('button', { name: '인증서 올리기' })).toBeNull()
    expect(onLegacy).toHaveBeenLastCalledWith(false)
  })

  it('설치 관리자 없이 구성한 설치 · 인증서 경로가 없는 설치 관리자: 안내 한 줄, 그 밖의 실패는 다시 시도', async () => {
    api.routes[`GET ${B}/cert`] = () => { throw fail(503, 'installer_unavailable') }
    const onLegacy = vi.fn()
    const first = render(<AdminCertCard onLegacy={onLegacy} />)
    expect((await screen.findByTestId('cert-legacy')).textContent).toContain('이 설치는 설치 관리자 없이 구성돼 여기서 인증서를 다시 발급할 수 없습니다.')
    expect(onLegacy).toHaveBeenLastCalledWith(true)
    first.unmount()

    api.routes[`GET ${B}/cert`] = () => { throw fail(501, 'installer_unsupported') }
    const second = render(<AdminCertCard onLegacy={onLegacy} />)
    expect((await screen.findByTestId('cert-legacy')).textContent).toContain('이 설치 관리자는 인증서 다시 발급을 지원하지 않습니다.')
    second.unmount()

    onLegacy.mockClear()
    api.routes[`GET ${B}/cert`] = () => { throw fail(503, 'installer_unreachable') }
    render(<AdminCertCard onLegacy={onLegacy} />)
    expect(await screen.findByText('인증서 상태를 불러오지 못했습니다')).toBeTruthy()
    expect(onLegacy).toHaveBeenLastCalledWith(false)
    api.routes[`GET ${B}/cert`] = () => issued()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByTestId('cert-card')).toBeTruthy()
  })
})

describe('인증서 카드 — 다시 발급', () => {
  it('[다시 발급] → 발급·다시 읽히기·구역 다시 연결 진행 → 끝나면 상태를 새로 읽고 남은 주의를 알린다', async () => {
    let state = cert()
    api.routes[`GET ${B}/cert`] = () => state
    api.routes[`POST ${B}/cert/reissue`] = () => job()
    api.routes[`GET ${B}/jobs/cert1`] = () => job()
    render(<AdminCertCard />)
    fireEvent.click(await screen.findByRole('button', { name: '다시 발급' }))
    const progress = await screen.findByTestId('cert-job')
    expect(called('POST', `${B}/cert/reissue`)[0].body).toEqual({ mode: 'auto' })
    expect(progress.textContent).toContain('인증서를 바꾸는 중입니다.')
    expect(screen.getByTestId('cert-stage-issue').textContent).toContain('발급')
    expect(screen.getByTestId('cert-stage-issue').textContent).toContain('진행 중')
    expect(screen.getByTestId('cert-stage-reload').textContent).toContain('다시 읽히기')
    expect(screen.getByTestId('cert-stage-reconnect').textContent).toContain('구역 다시 연결')
    expect(screen.getByTestId('cert-card').dataset.state).toBe('busy')
    expect((screen.getByRole('button', { name: '다시 발급' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '인증서 올리기' }) as HTMLButtonElement).disabled).toBe(true)

    const finished = job({ status: 'done', stages: doneStages, finished_at: new Date().toISOString(), warnings: [{ key: 'git_sso_pending', vars: {} }] })
    state = issued()
    api.routes[`GET ${B}/jobs`] = () => ({ jobs: [finished] })
    api.routes[`GET ${B}/jobs/cert1`] = () => finished
    const done = await screen.findByTestId('cert-done')
    expect(done.textContent).toContain('인증서를 바꿨습니다.')
    expect(done.textContent).toContain('코드 저장소의 로그인 연동은 아직 연결되지 않았습니다.')
    await waitFor(() => expect(screen.getByTestId('cert-mode').textContent).toBe("자동 발급 (Let's Encrypt)"))
    expect(screen.queryByTestId('cert-temporary')).toBeNull()
    expect(screen.queryByTestId('cert-job')).toBeNull()
    fireEvent.click(within(done).getByRole('button', { name: '닫기' }))
    expect(screen.queryByTestId('cert-done')).toBeNull()
  })

  it('발급 실패: 사유와 "쓰던 인증서는 그대로"를 보여 주고 다시 시도할 수 있다', async () => {
    const failed = job({ status: 'failed', finished_at: new Date().toISOString(), stages: [{ id: 'issue', status: 'failed' }, { id: 'reload', status: 'pending' }, { id: 'reconnect', status: 'pending' }], error: { cause: 'cert_issue_failed', fix: 'open_port_80', vars: { domain: 'ws.example.com' } } })
    api.routes[`POST ${B}/cert/reissue`] = () => job()
    api.routes[`GET ${B}/jobs/cert1`] = () => failed
    api.routes[`GET ${B}/jobs`] = () => ({ jobs: [failed] })
    render(<AdminCertCard />)
    fireEvent.click(await screen.findByRole('button', { name: '다시 발급' }))
    const box = await screen.findByTestId('cert-failed')
    expect(box.textContent).toContain('인증서를 바꾸지 못했습니다.')
    expect(box.textContent).toContain('ws.example.com의 인증서를 발급받지 못했습니다.')
    expect(box.textContent).not.toContain('80번')
    expect(box.textContent).toContain('쓰던 인증서는 그대로 있습니다.')
    expect(screen.getByTestId('cert-mode').textContent).toBe('임시 인증서 (자체 서명)')
    await waitFor(() => expect((screen.getByRole('button', { name: '다시 발급' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('실패 원인별 문구 — 컨테이너 기동 실패를 80번 포트 문제로 안내하지 않는다', async () => {
    for (const [cause, text] of [
      ['service_start_failed', '컨테이너를 시작하지 못했습니다.'],
      ['cert_service_start_failed', '인증서 발급용 컨테이너를 시작하지 못했습니다.'],
      ['cert_acme_challenge_failed', '인증 기관이 ws.example.com의 80번 포트에서 확인 파일을 받지 못했습니다.'],
      ['cert_rate_limited', '인증 기관의 발급 한도를 넘었습니다.'],
      ['cert_dns_mismatch', 'ws.example.com의 DNS가 없거나 이 서버를 가리키지 않습니다.'],
    ]) {
      const failed = job({ status: 'failed', finished_at: new Date().toISOString(), error: { cause, vars: {} } })
      api.routes[`GET ${B}/cert`] = () => cert({ job: null })
      api.routes[`GET ${B}/jobs`] = () => ({ jobs: [failed] })
      const view = render(<AdminCertCard />)
      const box = await screen.findByTestId('cert-failed')
      expect(box.textContent).toContain(text)
      expect(screen.getByTestId('cert-fail-code').textContent).toContain(cause)
      view.unmount()
    }
  })

  it('자동 갱신 상태 — 자동 발급 설치에서만 보이고, 항목이 없는 응답에서도 깨지지 않는다', async () => {
    api.routes[`GET ${B}/cert`] = () => issued({ renewal: { applicable: true, service: 'running', last_run_at: '2026-01-12T00:00:04Z', last_result: 'ok', next_renewal_at: days(50) } })
    let view = render(<AdminCertCard />)
    let row = await screen.findByTestId('cert-renewal')
    expect(row.getAttribute('data-service')).toBe('running')
    expect(row.textContent).toContain('동작 중')
    expect(row.textContent).toContain('(정상)')
    expect(row.textContent).toContain('다음 갱신 예정')
    view.unmount()

    api.routes[`GET ${B}/cert`] = () => issued({ renewal: { applicable: true, service: 'missing', last_run_at: null, last_result: null, next_renewal_at: null } })
    view = render(<AdminCertCard />)
    row = await screen.findByTestId('cert-renewal')
    expect(row.textContent).toContain('없음')
    expect(row.textContent).toContain('갱신 서비스가 동작하지 않으면')
    view.unmount()

    api.routes[`GET ${B}/cert`] = () => cert({ renewal: { applicable: false, service: 'missing', last_run_at: null, last_result: null, next_renewal_at: null } })
    view = render(<AdminCertCard />)
    await screen.findByTestId('cert-mode')
    expect(screen.queryByTestId('cert-renewal')).toBeNull()
    view.unmount()

    api.routes[`GET ${B}/cert`] = () => issued()
    render(<AdminCertCard />)
    await screen.findByTestId('cert-mode')
    expect(screen.queryByTestId('cert-renewal')).toBeNull()
  })

  it('모르는 실패 원인은 일반 문구로(코드는 자세히 안에), 시작하지 못한 요청은 이유를 알린다', async () => {
    const failed = job({ status: 'failed', finished_at: new Date().toISOString(), error: { cause: 'something_new', vars: {} } })
    api.routes[`GET ${B}/cert`] = () => cert({ job: null })
    api.routes[`GET ${B}/jobs`] = () => ({ jobs: [failed] })
    render(<AdminCertCard />)
    expect((await screen.findByTestId('cert-failed')).textContent).toContain('기록을 확인하고 다시 시도합니다.')
    expect(screen.getByTestId('cert-fail-code').textContent).toContain('something_new')

    for (const [code, text] of [
      ['busy', '다른 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.'],
      ['cert_auto_needs_domain', '인증서 자동 발급은 접속 주소가 도메인일 때만 됩니다.'],
      ['cert_managed_by_proxy', '이 설치의 인증서는 앞단 프록시가 맡아 여기서 바꿀 수 없습니다.'],
    ] as const) {
      api.routes[`POST ${B}/cert/reissue`] = () => { throw fail(code === 'cert_auto_needs_domain' ? 422 : 409, code) }
      fireEvent.click(screen.getByRole('button', { name: '다시 발급' }))
      await waitFor(() => expect(screen.getByTestId('cert-error').textContent).toBe(text))
    }
  })

  it('인증서를 다시 읽히는 동안 읽기가 실패해도 계속 읽고, 돌아오면 이어 간다', async () => {
    let down = true
    api.routes[`POST ${B}/cert/reissue`] = () => job()
    api.routes[`GET ${B}/jobs/cert1`] = () => { if (down) throw new Error('network'); return job({ stages: [{ id: 'issue', status: 'done' }, { id: 'reload', status: 'done' }, { id: 'reconnect', status: 'running' }] }) }
    render(<AdminCertCard />)
    fireEvent.click(await screen.findByRole('button', { name: '다시 발급' }))
    await waitFor(() => expect(screen.getByTestId('cert-job').textContent).toContain('다시 연결 중'))
    down = false
    await waitFor(() => expect(screen.getByTestId('cert-job').textContent).toContain('인증서를 바꾸는 중입니다.'))
    expect(screen.getByTestId('cert-stage-reconnect').textContent).toContain('진행 중')
  })
})

describe('인증서 카드 — 화면을 새로 열었을 때', () => {
  it('진행 중인 작업을 이어 받는다', async () => {
    api.routes[`GET ${B}/cert`] = () => cert({ job: job({ id: 'cert9' }) })
    api.routes[`GET ${B}/jobs/cert9`] = () => job({ id: 'cert9', stages: [{ id: 'issue', status: 'done' }, { id: 'reload', status: 'running' }, { id: 'reconnect', status: 'pending' }] })
    render(<AdminCertCard />)
    await screen.findByTestId('cert-job')
    await waitFor(() => expect(screen.getByTestId('cert-stage-reload').textContent).toContain('진행 중'))
    expect(called('GET', `${B}/jobs/cert9`).length).toBeGreaterThan(0)
  })

  it('최근 작업 목록의 인증서 작업만 본다: 하루 안의 실패는 보이고, 오래된 것·구역 작업은 보이지 않는다', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
    const zoneFail = { ...job({ id: 'z1', kind: 'enable', zone: 'git', status: 'failed', finished_at: hoursAgo(1) }) }
    api.routes[`GET ${B}/jobs`] = () => ({ jobs: [zoneFail, job({ id: 'c2', status: 'failed', finished_at: hoursAgo(2), error: { cause: 'cert_dir_managed', vars: {} } })] })
    const first = render(<AdminCertCard />)
    expect((await screen.findByTestId('cert-failed')).textContent).toContain('인증서를 두는 자리를 다른 도구가 관리하고 있어 바꾸지 못했습니다.')
    first.unmount()

    api.routes[`GET ${B}/jobs`] = () => ({ jobs: [zoneFail, job({ id: 'c3', status: 'failed', finished_at: hoursAgo(30) })] })
    const second = render(<AdminCertCard />)
    await screen.findByTestId('cert-card')
    await waitFor(() => expect(called('GET', `${B}/jobs`).length).toBe(2))
    expect(screen.queryByTestId('cert-failed')).toBeNull()
    second.unmount()

    api.routes[`GET ${B}/jobs`] = () => { throw fail(502, 'installer_error') }      // 목록을 못 읽어도 카드는 뜬다
    render(<AdminCertCard />)
    expect(await screen.findByTestId('cert-card')).toBeTruthy()
  })

  it('보여 줄 작업 고르기', () => {
    const now = Date.parse('2026-01-02T00:00:00Z')
    const at = (iso: string, o: Record<string, unknown> = {}) => job({ finished_at: iso, ...o }) as any
    expect(certLib.shownCertJob(null, now)).toBeNull()
    expect(certLib.shownCertJob(job() as any, now)?.id).toBe('cert1')
    expect(certLib.shownCertJob(at('2026-01-01T23:55:00Z', { status: 'done' }), now)?.id).toBe('cert1')
    expect(certLib.shownCertJob(at('2026-01-01T23:00:00Z', { status: 'done' }), now)).toBeNull()
    expect(certLib.shownCertJob(at('2026-01-01T01:00:00Z', { status: 'failed' }), now)?.id).toBe('cert1')
    expect(certLib.shownCertJob(at('2025-12-30T00:00:00Z', { status: 'failed' }), now)).toBeNull()
    expect(certLib.shownCertJob(at('2026-01-01T23:59:00Z', { status: 'failed', kind: 'enable' }), now)).toBeNull()
  })
})

describe('인증서 카드 — 인증서 올리기', () => {
  it('파일 두 개를 골라야 올릴 수 있고, 파일의 글자를 그대로 보낸다', async () => {
    api.routes[`POST ${B}/cert/reissue`] = () => job({ id: 'cert5' })
    api.routes[`GET ${B}/jobs/cert5`] = () => job({ id: 'cert5' })
    render(<AdminCertCard />)
    fireEvent.click(await screen.findByRole('button', { name: '인증서 올리기' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('인증서 파일과 개인 키 파일, 두 개가 필요합니다.')
    expect(dialog.textContent).toContain('개인 키는 이 서버에만 저장됩니다.')
    const submit = screen.getByRole('button', { name: '올리고 바꾸기' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(dialog.textContent).toContain('파일 두 개를 골라야 올릴 수 있습니다.')
    pick('인증서', file('fullchain.pem', 'CERT-PEM-TEXT'))
    expect(submit.disabled).toBe(true)
    pick('개인 키', file('privkey.pem', 'KEY-PEM-TEXT'))
    expect(submit.disabled).toBe(false)
    expect(dialog.textContent).toContain('fullchain.pem')
    fireEvent.click(submit)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(called('POST', `${B}/cert/reissue`)[0].body).toEqual({ mode: 'upload', cert: 'CERT-PEM-TEXT', key: 'KEY-PEM-TEXT' })
    expect(await screen.findByTestId('cert-job')).toBeTruthy()
  })

  it('검증을 통과하지 못하면 통과하지 못한 항목을 창 안에 보여 주고, 파일을 바꾸면 걷힌다', async () => {
    api.routes[`POST ${B}/cert/reissue`] = () => {
      throw fail(422, 'cert_invalid', { checks: [
        { id: 'cert_readable', status: 'pass', value: 2, fix: null },
        { id: 'key_matches', status: 'fail', value: null, fix: { key: 'key_mismatch', vars: {} } },
        { id: 'domain_covered', status: 'fail', value: ['other.example.com'], fix: { key: 'cert_domain_missing', vars: { domain: 'ws.example.com' } } },
        { id: 'issuer', status: 'warn', value: 'x', fix: { key: 'cert_self_signed', vars: {} } },
        { id: 'future', status: 'fail', value: null, fix: { key: 'brand_new_reason', vars: {} } },
      ] })
    }
    render(<AdminCertCard />)
    fireEvent.click(await screen.findByRole('button', { name: '인증서 올리기' }))
    pick('인증서', file('a.crt', 'A'))
    pick('개인 키', file('a.key', 'B'))
    fireEvent.click(screen.getByRole('button', { name: '올리고 바꾸기' }))
    const box = await screen.findByTestId('cert-upload-error')
    expect(box.textContent).toContain('이 파일로는 바꿀 수 없습니다. 쓰던 인증서는 그대로 있습니다.')
    const items = [...box.querySelectorAll('li')]
    expect(items.map(li => li.getAttribute('data-check'))).toEqual(['key_matches', 'domain_covered', 'future'])      // 실패한 것만
    expect(items[0].textContent).toContain('개인 키가 이 인증서와 짝이 맞지 않습니다.')
    expect(items[1].textContent).toContain('접속 주소 ws.example.com 이(가) 들어 있는 인증서를 올립니다.')
    expect(items[2].textContent).toContain('이 파일은 쓸 수 없습니다.')
    expect(items[2].textContent).toContain('(brand_new_reason)')
    expect(screen.getByRole('dialog')).toBeTruthy()                            // 창은 열린 채다
    expect(screen.queryByTestId('cert-job')).toBeNull()
    pick('개인 키', file('b.key', 'C'))
    expect(screen.queryByTestId('cert-upload-error')).toBeNull()
  })

  it('너무 큰 파일은 보내지 않고, 그 밖의 거부는 이유를 알린다', async () => {
    render(<AdminCertCard />)
    fireEvent.click(await screen.findByRole('button', { name: '인증서 올리기' }))
    pick('인증서', file('big.pem', 'x'.repeat(certLib.CERT_FILE_MAX + 1)))
    pick('개인 키', file('a.key', 'B'))
    fireEvent.click(screen.getByRole('button', { name: '올리고 바꾸기' }))
    expect((await screen.findByTestId('cert-upload-error')).textContent).toContain('파일이 너무 큽니다.')
    expect(called('POST', `${B}/cert/reissue`)).toHaveLength(0)

    api.routes[`POST ${B}/cert/reissue`] = () => { throw fail(409, 'busy') }
    pick('인증서', file('ok.pem', 'A'))
    fireEvent.click(screen.getByRole('button', { name: '올리고 바꾸기' }))
    await waitFor(() => expect(screen.getByTestId('cert-upload-error').textContent).toContain('다른 작업이 진행 중입니다.'))
  })

  it('CA 인증서(선택)를 함께 고르면 그 글자도 보내고, 안 고르면 보내지 않는다', async () => {
    api.routes[`POST ${B}/cert/reissue`] = () => job({ id: 'cert6' })
    api.routes[`GET ${B}/jobs/cert6`] = () => job({ id: 'cert6' })
    render(<AdminCertCard />)
    fireEvent.click(await screen.findByRole('button', { name: '인증서 올리기' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('CA 인증서 (선택)')
    expect(screen.getByTestId('cert-ca-note').textContent).toContain('공개 인증 기관이 내준 인증서면 비워 둡니다.')
    expect(screen.getByTestId('cert-ca-note').textContent).toContain('코드 저장소의 로그인 연동')
    pick('인증서', file('server.crt', 'LEAF'))
    pick('개인 키', file('server.key', 'KEY'))
    pick('CA 인증서 (선택)', file('ca.crt', 'CA-PEM'))
    fireEvent.click(screen.getByRole('button', { name: '올리고 바꾸기' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(called('POST', `${B}/cert/reissue`)[0].body).toEqual({ mode: 'upload', cert: 'LEAF', key: 'KEY', ca: 'CA-PEM' })
  })

  it('올린 인증서에 발급 CA 가 없어 연결이 보류면 그 사실을 알리고, CA 인증서만 따로 올릴 수 있다', async () => {
    const uploaded = (o: Record<string, unknown> = {}) => issued({ mode: 'upload', issuer: 'Example Private CA', site_ca: false, ca_uploadable: true, pending: ['git'], ...o })
    api.routes[`GET ${B}/cert`] = () => uploaded()
    api.routes[`POST ${B}/cert/ca`] = () => job({ id: 'ca1' })
    api.routes[`GET ${B}/jobs/ca1`] = () => job({ id: 'ca1' })
    render(<AdminCertCard />)
    const notice = await screen.findByTestId('cert-ca-needed')
    expect(notice.textContent).toContain('코드 저장소의 로그인 연동이 보류돼 있습니다.')
    expect(notice.textContent).toContain('사설 CA 가 내준 인증서라면 그 CA 인증서를 올리세요')
    expect(notice.textContent).toContain('공개 인증 기관의 인증서라면 중간 인증서까지 이어 붙인 파일로')
    expect(screen.getByTestId('cert-ca').textContent).toBe('올리지 않았습니다')
    fireEvent.click(within(notice).getByRole('button', { name: 'CA 인증서 올리기' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('인증서와 개인 키는 그대로 둡니다.')
    expect(screen.queryByLabelText('개인 키')).toBeNull()                       // CA 만 받는다
    const submit = screen.getByRole('button', { name: '올리기' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(dialog.textContent).toContain('CA 인증서 파일을 골라야 올릴 수 있습니다.')
    pick('CA 인증서 (선택)', file('ca.pem', 'ROOT-CA'))
    fireEvent.click(submit)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(called('POST', `${B}/cert/ca`)[0].body).toEqual({ ca: 'ROOT-CA' })
    expect(called('POST', `${B}/cert/reissue`)).toHaveLength(0)
    expect(await screen.findByTestId('cert-job')).toBeTruthy()
  })

  it('CA 인증서만 올릴 때의 거부: 내준 CA 가 아니면 이유를 창 안에, 믿게 한 뒤에는 안내가 사라진다', async () => {
    let trusted = false
    api.routes[`GET ${B}/cert`] = () => issued({ mode: 'upload', issuer: 'Example Private CA', site_ca: trusted, ca_uploadable: true, pending: trusted ? [] : ['git'] })
    api.routes[`POST ${B}/cert/ca`] = () => {
      throw fail(422, 'cert_invalid', { checks: [
        { id: 'ca_readable', status: 'pass', value: 1, fix: null },
        { id: 'ca_issues_cert', status: 'fail', value: 'CN=Example Private CA', fix: { key: 'ca_not_issuer', vars: {} } },
      ] })
    }
    const view = render(<AdminCertCard />)
    fireEvent.click(within(await screen.findByTestId('cert-ca-needed')).getByRole('button', { name: 'CA 인증서 올리기' }))
    pick('CA 인증서 (선택)', file('other.pem', 'OTHER'))
    fireEvent.click(screen.getByRole('button', { name: '올리기' }))
    const box = await screen.findByTestId('cert-upload-error')
    expect(box.textContent).toContain('이 파일은 쓸 수 없습니다. 바뀐 것은 없습니다.')
    expect(box.textContent).toContain('이 CA 는 지금 인증서를 내준 CA 가 아닙니다.')
    view.unmount()

    trusted = true
    render(<AdminCertCard />)
    expect((await screen.findByTestId('cert-ca')).textContent).toContain('이 서버의 코드 저장소가 이 인증서를 믿습니다.')
    expect(screen.queryByTestId('cert-ca-needed')).toBeNull()
    expect(screen.getByTestId('cert-upload-ca')).toBeTruthy()                  // 바꿔 올릴 수는 있다
  })

  it('자동 발급·임시 인증서에는 CA 를 올리는 자리가 없다', async () => {
    api.routes[`GET ${B}/cert`] = () => issued()
    const view = render(<AdminCertCard />)
    await screen.findByTestId('cert-card')
    expect(screen.queryByTestId('cert-ca')).toBeNull()
    expect(screen.queryByRole('button', { name: 'CA 인증서 올리기' })).toBeNull()
    view.unmount()
    api.routes[`GET ${B}/cert`] = () => cert()                                  // 임시 인증서 + 보류 — 안내는 임시 인증서 쪽이 한다
    render(<AdminCertCard />)
    await screen.findByTestId('cert-temporary')
    expect(screen.queryByTestId('cert-ca-needed')).toBeNull()
  })

  it('검증 실패 사유와 실패 원인마다 한국어·영어 문구가 있다', async () => {
    const { default: ko } = await import('~/i18n/locales/ko.json')
    const { default: en } = await import('~/i18n/locales/en.json')
    for (const m of [ko, en] as any[]) {
      const c = m.admin.certCard
      for (const key of [...certLib.CERT_FIX_KEYS, 'other']) expect(c.msg[key].title && c.msg[key].body, key).toBeTruthy()
      for (const key of ['cert_issue_failed', 'cert_dir_managed', 'cert_invalid', 'other']) expect(c.fail[key], key).toBeTruthy()
      for (const key of ['busy', 'cert_managed_by_proxy', 'not_installed', 'cert_auto_needs_domain', 'file_too_large', 'cert_invalid', 'cert_ca_needs_upload', 'generic']) expect(c.error[key], key).toBeTruthy()
      for (const key of ['caSlot', 'caHint', 'caNote', 'caTitle', 'caLead', 'caOnlyHint', 'caSubmit', 'needCa', 'caChecksTitle']) expect(c.modal[key], key).toBeTruthy()
      expect(c.row.ca && c.ca.trusted && c.ca.none && c.caNeeded.title && c.caNeeded.body && c.uploadCa).toBeTruthy()
      for (const key of ['issue', 'reload', 'reconnect']) expect(c.stage[key], key).toBeTruthy()
    }
    expect(certLib.failedChecks({ data: { vars: { checks: 'nope' } } })).toEqual([])
    expect(certLib.fixKey({ id: 'x', status: 'fail', fix: null })).toBe('other')
  })
})

describe('관리 › 보안 — 인증서 카드와 예전 SSL 카드', () => {
  function renderPage() {
    const router = createMemoryRouter([{ path: '*', element: <AdminSecurityPage /> }], { initialEntries: ['/admin/security'] })
    return render(<RouterProvider router={router} />)
  }

  it('설치 관리자가 인증서를 맡으면 인증서 카드만 보인다', async () => {
    renderPage()
    expect(await screen.findByTestId('cert-card')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'SSL 인증서' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '인증서 올리기' })).toHaveLength(1)
  })

  it('설치 관리자 없이 구성한 설치는 안내와 함께 예전 SSL 카드가 보인다', async () => {
    api.routes[`GET ${B}/cert`] = () => { throw fail(503, 'installer_unavailable') }
    renderPage()
    expect(await screen.findByTestId('cert-legacy')).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'SSL 인증서' })).toBeTruthy()
    expect(screen.queryByTestId('cert-card')).toBeNull()
  })
})
