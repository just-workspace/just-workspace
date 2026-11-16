// 관리 › 업데이트 — 현황(최신/새 버전/확인 중/확인 실패/대기/차단), 새 버전 안내, 설정, 앱 배포, 기록, 적용된 버전의 변경 내용,
// 야간 자동 업데이트 결과 띠와 "다시 활성화", 설치 관리자 없음/미지원 안내. $fetch 는 모의(mock), 응답은 계약에 맞춰 구성한 픽스처(fixtures).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { api, on, seq, called, fakeFetch, renderUpdate, text, disabled, checked, value, ADMIN, MEMBER } from './updateHarness'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const $fetch = Object.assign((u: string, o?: any) => fakeFetch(u, o), { raw: fakeFetch, native: fetch, create: () => fakeFetch })
  return { ...real, $fetch }
})

const fx = await import('~/components/admin/update/fixtures')
const parts = await import('~/components/admin/update/parts')
const sys = await import('~/composables/useSystemUpdate')
const { setUser } = await import('~/composables/useAuth')
const { toastStore } = await import('~/composables/useToast')

const toasts = () => toastStore.getState().toasts.map((x: any) => `${x.type}:${x.message ?? x.title}`)
const LOSS = '업데이트 이후에 작성한 메일·대화·일정이 사라집니다. 파일은 그대로입니다.'

beforeEach(() => {
  api.calls = []
  api.routes = {}
  parts.updateTiming.pollMs = 20
  toastStore.setState({ toasts: [] } as any)
  localStorage.clear()
  setUser(ADMIN as any)
  on('GET', '/status', fx.statuses.latest())
})

describe('현황', () => {
  it('최신: 현재 버전·채널·적용 방식·마지막 확인과 "최신 버전입니다"', async () => {
    await renderUpdate()
    expect(text(await screen.findByTestId('update-latest'))).toContain('최신 버전입니다.')
    expect(text(screen.getByTestId('update-current'))).toContain('1.0.0')
    expect(screen.getByText('안정판')).toBeTruthy()
    expect(screen.getByText('검증을 마친 버전만 받습니다')).toBeTruthy()
    expect(screen.getByText(/새 버전이 나오면 알리고, 관리자가 시작합니다/)).toBeTruthy()
    expect(screen.queryByTestId('update-available')).toBeNull()
    expect(screen.queryByTestId('update-paused')).toBeNull()
    // 탭은 정해진 순서를 유지하며 서로 연결됨
    expect(screen.getAllByRole('tab').map(x => x.textContent)).toEqual(['현황', '설정', '롤백', '앱 배포', '기록', '오프라인 업데이트'])
  })

  it('새 버전: 버전·받을 용량·예상 중단 시간, "내용 보기"는 새 버전 안내로', async () => {
    on('GET', '/status', fx.statuses.available())
    const page = await renderUpdate()
    const card = await screen.findByTestId('update-available')
    expect(text(card)).toContain('새 버전 1.1.0')
    expect(text(card)).toContain('다운로드 용량 1.2 GB')
    expect(text(card)).toContain('예상 중단 시간 4분')
    expect(screen.queryByTestId('update-latest')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: '내용 보기' }))
    expect(await screen.findByTestId('update-view-notes')).toBeTruthy()
    expect(page.path()).toBe('/admin/update/notes')
  })

  it('확인 중: 버튼이 꺼지고, 끝날 때까지 다시 읽어 결과를 보인다', async () => {
    on('GET', '/status', seq(fx.statuses.checking(), fx.statuses.checking(), fx.statuses.available()))
    await renderUpdate()
    expect(text(await screen.findByTestId('update-checking'))).toContain('확인 중')
    expect(disabled(screen.getByRole('button', { name: '지금 확인' }))).toBe(true)
    expect(await screen.findByTestId('update-available')).toBeTruthy()
    expect(screen.queryByTestId('update-checking')).toBeNull()
  })

  it('"지금 확인"을 누르면 확인을 시작하고 확인 중이 된다', async () => {
    on('POST', '/check', fx.statuses.checking())
    await renderUpdate()
    fireEvent.click(await screen.findByRole('button', { name: '지금 확인' }))
    expect(await screen.findByTestId('update-checking')).toBeTruthy()
    expect(called('POST', '/check')).toHaveLength(1)
  })

  it('확인 실패: 원인과 시각, "다시 확인", 오프라인 업데이트로 가는 길', async () => {
    on('GET', '/status', fx.statuses.checkFailed())
    on('POST', '/check', fx.statuses.checking())
    const page = await renderUpdate()
    const tile = await screen.findByTestId('update-check-failed')
    expect(text(tile)).toContain('업데이트 서버에 연결하지 못했습니다')
    expect(text(tile)).toContain(`connect timeout · ${sys.formatTime('2026-01-12T00:00:04Z')}`)
    expect(screen.queryByTestId('update-latest')).toBeNull()
    expect(screen.getByRole('link', { name: '오프라인 업데이트' }).getAttribute('href')).toBe('/admin/update/offline')
    fireEvent.click(within(tile).getByRole('button', { name: '다시 확인' }))
    await waitFor(() => expect(called('POST', '/check')).toHaveLength(1))
    expect(page.path()).toBe('/admin/update')
  })

  it('확인 실패의 오프라인 업데이트 링크는 그 탭으로 간다', async () => {
    on('GET', '/status', fx.statuses.checkFailed())
    on('GET', '/offline', fx.offlines.empty())
    const page = await renderUpdate()
    fireEvent.click(await screen.findByRole('link', { name: '오프라인 업데이트' }))
    await waitFor(() => expect(page.path()).toBe('/admin/update/offline'))
  })

  it('대기: 안정판으로 돌아온 뒤 어느 버전부터 다시 받는지 보인다', async () => {
    on('GET', '/status', fx.statuses.wait())
    await renderUpdate()
    const box = await screen.findByTestId('update-wait')
    expect(text(box)).toContain('1.2.0-beta.3')
    expect(text(box)).toContain('안정판이 1.2.0 버전 이상이 되면 그때부터 다시 받습니다')
    expect(screen.queryByTestId('update-latest')).toBeNull()
  })

  it('막힘: 새 버전은 있지만 갈 경로가 없다', async () => {
    on('GET', '/status', fx.statuses.blocked())
    await renderUpdate()
    const box = await screen.findByTestId('update-blocked')
    expect(text(box)).toContain('2.0.0 버전이 출시되었지만 현재 버전에서 바로 업데이트할 수 없습니다')
    expect(text(box)).toContain('1.5.0 버전 이상에서만')
    expect(screen.queryByTestId('update-available')).toBeNull()
  })

  it('자동: 시간대와 유예 기간을 서버 값으로 보인다', async () => {
    on('GET', '/status', fx.statuses.auto())
    await renderUpdate()
    await screen.findByTestId('update-latest')
    expect(screen.getByText('03:00~05:00')).toBeTruthy()
    expect(screen.getByText(/나온 지 3일 지난 릴리스만/)).toBeTruthy()
  })

  it('확인한 적이 없으면 시각 대신 그렇게 적는다', async () => {
    on('GET', '/status', fx.statuses.neverChecked())
    await renderUpdate()
    expect(await screen.findByText('아직 확인하지 않았습니다')).toBeTruthy()
  })

  it('진행 중인 작업이 있으면 진행 화면으로 가는 안내가 뜨고 확인은 막힌다', async () => {
    on('GET', '/status', fx.status({ job: fx.jobs.pulling() }))
    on('GET', '/jobs/job1', fx.jobs.pulling())
    const page = await renderUpdate()
    const box = await screen.findByTestId('update-live-job')
    expect(text(box)).toContain('업데이트가 진행 중입니다')
    expect(disabled(screen.getByRole('button', { name: '지금 확인' }))).toBe(true)
    fireEvent.click(within(box).getByRole('button', { name: '진행 화면 보기' }))
    await waitFor(() => expect(page.path()).toBe('/admin/update/apply/job1'))
  })

  it('상태를 못 읽으면 다시 시도할 수 있다', async () => {
    on('GET', '/status', seq(() => { throw fx.apiError(502, 'installer_error') }, fx.statuses.latest()))
    await renderUpdate()
    expect(await screen.findByText('업데이트 상태를 불러오지 못했습니다')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByTestId('update-latest')).toBeTruthy()
  })

  it('관리자가 아니면 아무것도 그리지 않는다', async () => {
    setUser(MEMBER as any)
    const page = await renderUpdate()
    expect(page.container.querySelector('[data-testid^="update-view"]')).toBeNull()
    expect(called('GET', '/status')).toHaveLength(0)
  })
})

describe('설치 관리자 없음 · 미지원', () => {
  it('설치 관리자 없이 구성한 설치', async () => {
    on('GET', '/status', () => { throw fx.errors.noInstaller() })
    await renderUpdate()
    const box = await screen.findByTestId('update-unavailable')
    expect(text(box)).toContain('이 설치는 설치 관리자 없이 구성돼 여기서 업데이트할 수 없습니다')
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button', { name: '지금 확인' })).toBeNull()
  })

  it('업데이트를 모르는 설치 관리자', async () => {
    on('GET', '/status', () => { throw fx.errors.unsupported() })
    await renderUpdate('/admin/update/settings')
    expect(text(await screen.findByTestId('update-unavailable'))).toContain('이 설치 관리자는 업데이트를 지원하지 않습니다')
  })
})

describe('밤사이 자동 업데이트 결과', () => {
  it('성공 띠: 버전·끝난 시각·중단 시간, 변경 내용 보기, 닫으면 다시 뜨지 않는다', async () => {
    on('GET', '/status', fx.statuses.autoOk())
    on('GET', '/releases/1.1.0', fx.releases.plain())
    const page = await renderUpdate()
    const band = await screen.findByTestId('update-auto-ok')
    expect(text(band)).toContain('밤사이 1.1.0 버전으로 업데이트했습니다.')
    expect(text(band)).toContain(`자동 업데이트 · ${sys.formatTime('2026-01-11T18:21:40Z')}에 완료 · 중단 3분 32초`)
    fireEvent.click(within(band).getByRole('button', { name: '닫기' }))
    expect(screen.queryByTestId('update-auto-ok')).toBeNull()
    page.unmount()
    await renderUpdate()
    await screen.findByTestId('update-latest')
    expect(screen.queryByTestId('update-auto-ok')).toBeNull()
  })

  it('성공 띠의 "이 버전의 변경 내용"은 시작 버튼이 없는 보기로 간다', async () => {
    on('GET', '/status', fx.statuses.autoOk())
    on('GET', '/releases/1.1.0', fx.releases.plain())
    const page = await renderUpdate()
    fireEvent.click(within(await screen.findByTestId('update-auto-ok')).getByRole('button', { name: '이 버전의 변경 내용' }))
    expect(await screen.findByTestId('update-applied')).toBeTruthy()
    expect(page.path()).toBe('/admin/update/changes/1.1.0')
    expect(screen.queryByRole('button', { name: '업데이트 시작' })).toBeNull()
  })

  it('실패 띠: 어디서 멈췄는지, 지금 버전, 멈춤 표시 — "다시 활성화"를 누르면 다시 켠 안내로 바뀐다', async () => {
    on('GET', '/status', seq(fx.statuses.autoFailed(), fx.status({ ...fx.statuses.autoFailed(), auto: { paused: false, paused_at: null, reason: null } })))
    on('POST', '/auto/resume', { auto: { paused: false, paused_at: null, reason: null }, window: { start: '03:00', end: '05:00' } })
    await renderUpdate()
    const band = await screen.findByTestId('update-auto-failed')
    expect(band.getAttribute('role')).toBe('alert')
    expect(text(band)).toContain('밤사이 자동 업데이트가 실패하여 이전 버전으로 롤백했습니다.')
    expect(text(band)).toContain('DB 변경 단계에서 중단되었습니다.')
    expect(text(band)).toContain('지금은 1.0.0 버전으로 정상 동작합니다.')
    expect(text(band)).toContain('다시 활성화를 눌러야 다음 시간대부터 다시 시도합니다')
    expect(text(screen.getByTestId('update-paused'))).toContain('중지됨')
    expect(screen.getByText(/실패 후 중지되어 있습니다/)).toBeTruthy()

    fireEvent.click(within(band).getByRole('button', { name: '자동 업데이트 다시 활성화' }))
    const ok = await screen.findByTestId('update-auto-resumed')
    expect(text(ok)).toContain('자동 업데이트를 다시 활성화했습니다.')
    expect(text(ok)).toContain('다음 적용 시간대(03:00~05:00)에 다시 시도합니다')
    expect(called('POST', '/auto/resume')).toHaveLength(1)
    await waitFor(() => expect(screen.queryByTestId('update-paused')).toBeNull())
  })

  it('실패 띠를 닫아도 멈춤 표시 옆에서 다시 켤 수 있다', async () => {
    on('GET', '/status', fx.statuses.autoFailed())
    on('POST', '/auto/resume', { auto: { paused: false } })
    await renderUpdate()
    fireEvent.click(within(await screen.findByTestId('update-auto-failed')).getByRole('button', { name: '닫기' }))
    expect(screen.queryByTestId('update-auto-failed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '다시 활성화' }))
    await waitFor(() => expect(called('POST', '/auto/resume')).toHaveLength(1))
  })
})

describe('새 버전 안내', () => {
  it('일반: 버전 경로·용량·중단 시간·영향받는 구역·변경 내용, 시작하면 적용 화면으로', async () => {
    on('GET', '/status', fx.statuses.available())
    on('POST', '/apply', fx.jobs.countdown(new Date(Date.now() + 300_000).toISOString()))
    on('GET', '/jobs/job1', fx.jobs.countdown(new Date(Date.now() + 300_000).toISOString()))
    const page = await renderUpdate('/admin/update/notes')
    expect(text(await screen.findByTestId('update-path'))).toContain('1.0.0 → 1.1.0')
    expect(screen.getByText('1.2 GB')).toBeTruthy()
    expect(screen.getByText(/이 동안 모든 사용자가 점검 중 화면을 봅니다/)).toBeTruthy()
    expect(text(screen.getByTestId('update-zones'))).toContain('기본, 메일')
    expect(within(screen.getByTestId('update-changelog')).getAllByRole('listitem').map(x => x.textContent)).toEqual([
      '메일 검색이 빨라졌습니다', '일정 초대 메일의 시간대 표기를 고쳤습니다', '보안 수정'])
    expect(screen.queryByTestId('update-plugin-warning')).toBeNull()
    expect(screen.queryByTestId('update-hop')).toBeNull()
    expect(screen.getByText(/파일은 백업하지 않으며 변경하지도 않습니다/)).toBeTruthy()
    // 현황 탭이 선택된 상태 유지
    expect(screen.getByRole('tab', { name: '현황' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '업데이트 시작' }))
    await waitFor(() => expect(page.path()).toBe('/admin/update/apply/job1'))
    expect(called('POST', '/apply')[0].body).toEqual({ target: '1.1.0', start: 'countdown' })
  })

  it('플러그인 경고: 꺼진 채로 시작하는 플러그인의 이름', async () => {
    on('GET', '/status', fx.statuses.pluginWarning())
    await renderUpdate('/admin/update/notes')
    const box = await screen.findByTestId('update-plugin-warning')
    expect(text(box)).toContain('플러그인 1개가 새 버전과 맞는지 확인되지 않았습니다.')
    expect(text(box)).toContain('샘플 플러그인 · 업데이트 후 이 플러그인은 비활성화된 상태로 시작합니다')
  })

  it('중간 버전: 거칠 버전을 모두 보이고 몇 번에 걸치는지 알린다', async () => {
    on('GET', '/status', fx.statuses.viaIntermediate())
    await renderUpdate('/admin/update/notes')
    expect(text(await screen.findByTestId('update-path'))).toContain('1.0.0 → 1.1.0 → 1.2.0')
    const box = screen.getByTestId('update-hop')
    expect(text(box)).toContain('중간 버전(1.1.0)을 거쳐 2번에 걸쳐 업데이트합니다.')
    expect(text(box)).toContain('버전마다 백업을 따로 만들고')
  })

  it('서버가 주지 않은 값의 줄은 그리지 않는다', async () => {
    on('GET', '/status', fx.statuses.sparse())
    await renderUpdate('/admin/update/notes')
    await screen.findByTestId('update-path')
    expect(screen.queryByText('다운로드 용량')).toBeNull()
    expect(screen.queryByText('예상 중단 시간')).toBeNull()
    expect(screen.queryByText('영향받는 구역')).toBeNull()
    expect(screen.queryByTestId('update-changelog')).toBeNull()
    expect(document.body.textContent).not.toMatch(/\[[^\]]+\]/)
  })

  it('다른 작업이 돌고 있으면 시작하지 못하고 알린다', async () => {
    on('GET', '/status', fx.statuses.available())
    on('POST', '/apply', () => { throw fx.errors.busy() })
    const page = await renderUpdate('/admin/update/notes')
    fireEvent.click(await screen.findByRole('button', { name: '업데이트 시작' }))
    await waitFor(() => expect(toasts()).toEqual(['error:다른 작업이 진행 중입니다. 완료된 뒤 다시 시도하십시오.']))
    expect(page.path()).toBe('/admin/update/notes')
  })

  it('받을 버전이 없으면 그렇게 알린다', async () => {
    await renderUpdate('/admin/update/notes')
    expect(await screen.findByText('지금은 받을 수 있는 새 버전이 없습니다')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '업데이트 시작' })).toBeNull()
  })
})

describe('설정', () => {
  const open = async (settings = fx.settings(), contact: string | null = null, status = fx.statuses.latest()) => {
    on('GET', '/status', status)
    on('GET', '/settings', settings)
    on('GET', '/contact', { contact })
    const page = await renderUpdate('/admin/update/settings')
    await screen.findByRole('radio', { name: /수동/ })
    return page
  }
  const radio = (name: RegExp) => screen.getByRole('radio', { name })

  it('수동이 기본이고, 바꾸기 전에는 저장할 것이 없다', async () => {
    await open()
    expect(checked(radio(/수동/))).toBe(true)
    expect(checked(radio(/안정판 \(Stable\)/))).toBe(true)
    expect(screen.queryByTestId('update-auto-window')).toBeNull()
    expect(disabled(screen.getByRole('button', { name: '저장' }))).toBe(true)
  })

  it('자동: 시간대 기본값(03:00~05:00)과 3일 안내, 저장하면 방식과 시간대를 보낸다', async () => {
    await open()
    on('PUT', '/settings', (c: any) => fx.settingsReply(fx.settings({ mode: c.body.mode, window: c.body.window })))
    fireEvent.click(radio(/자동/))
    const box = screen.getByTestId('update-auto-window')
    expect(value(within(box).getByLabelText('적용 시작'))).toBe('03:00')
    expect(value(within(box).getByLabelText('이 시각까지만 시작'))).toBe('05:00')
    expect(text(screen.getByTestId('update-auto-note'))).toContain('서버 시간 기준입니다. 자동 적용은 나온 지 3일이 지난 릴리스만 대상으로 합니다.')
    expect(text(screen.getByTestId('update-auto-note'))).toContain('실패하면 어느 단계든 이전 버전으로 롤백하고 자동 업데이트를 중지합니다.')
    expect(screen.getByText('변경한 내용이 아직 저장되지 않았습니다.')).toBeTruthy()

    fireEvent.change(within(box).getByLabelText('적용 시작'), { target: { value: '01:00' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(called('PUT', '/settings')).toHaveLength(1))
    expect(called('PUT', '/settings')[0].body).toEqual({ mode: 'auto', window: { start: '01:00', end: '05:00' }, channel: 'stable' })
    await waitFor(() => expect(disabled(screen.getByRole('button', { name: '저장' }))).toBe(true))
    expect(toasts()).toEqual(['success:저장했습니다'])
  })

  it('시작과 끝이 같으면 저장하지 못한다', async () => {
    await open()
    fireEvent.click(radio(/자동/))
    fireEvent.change(screen.getByLabelText('이 시각까지만 시작'), { target: { value: '03:00' } })
    expect(screen.getByText('시작과 끝이 같을 수 없습니다')).toBeTruthy()
    expect(disabled(screen.getByRole('button', { name: '저장' }))).toBe(true)
  })

  it('취소하면 바꾸기 전으로 돌아간다', async () => {
    await open()
    fireEvent.click(radio(/자동/))
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    expect(checked(radio(/수동/))).toBe(true)
    expect(screen.queryByTestId('update-auto-window')).toBeNull()
  })

  it('시험판으로 바꾸면 경고가 뜬다', async () => {
    await open()
    on('PUT', '/settings', fx.settingsReply(fx.settings({ channel: 'beta' }), { channel: 'to_beta' }))
    fireEvent.click(radio(/시험판 \(Beta\)/))
    const box = screen.getByTestId('update-to-beta')
    expect(text(box)).toContain('시험판은 검증이 끝나지 않은 버전입니다.')
    expect(text(box)).toContain('다음 확인 때부터 시험판 버전을 받습니다')
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(called('PUT', '/settings')[0]?.body.channel).toBe('beta'))
    await waitFor(() => expect(screen.queryByTestId('update-to-beta')).toBeNull())
  })

  it('안정판 복귀 — 기다리기: 어느 버전부터 다시 받는지 보인다', async () => {
    const beta = fx.statuses.beta()
    await open(beta.settings, null, beta)
    on('PUT', '/settings', fx.settingsReply(fx.settings({ channel: 'stable', beta: beta.settings.beta }), { channel: 'to_stable_wait', wait: { channel_latest: '1.1.4', resume_from: '1.2.0' } }))
    fireEvent.click(radio(/안정판 \(Stable\)/))
    const box = screen.getByTestId('update-to-stable')
    expect(text(box)).toContain('안정판으로 돌아오는 방법을 선택합니다.')
    expect(checked(within(box).getByRole('radio', { name: /다음 안정판까지 기다리기/ }))).toBe(true)
    expect(text(box)).toContain('시험판으로 변경한 이후에 작성한 메일·대화·일정이 사라집니다. 파일은 그대로입니다')

    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(called('PUT', '/settings')).toHaveLength(1))
    expect(called('PUT', '/settings')[0].body).toMatchObject({ channel: 'stable', stable_return: 'wait' })
    const wait = await screen.findByTestId('update-stable-wait')
    expect(text(wait)).toContain('안정판이 1.2.0 버전 이상이 되면 그때부터 다시 받습니다')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('안정판 복귀 — 시험판 이전 상태로 복원: 확인 창의 문구, 시작하면 복원 진행 화면으로', async () => {
    const beta = fx.statuses.beta()
    const page = await open(beta.settings, null, beta)
    on('PUT', '/settings', fx.settingsReply(beta.settings, { channel: 'to_stable_restore', job: fx.jobs.betaRestoreRunning() }))
    on('GET', '/jobs/jobrs2', fx.jobs.betaRestoreRunning())
    fireEvent.click(radio(/안정판 \(Stable\)/))
    fireEvent.click(screen.getByRole('radio', { name: /시험판 이전 상태로 복원/ }))
    fireEvent.click(screen.getByRole('button', { name: '저장' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(text(dialog)).toContain('시험판 이전 상태로 복원하시겠습니까?')
    expect(text(within(dialog).getByTestId('update-beta-restore-body'))).toContain(LOSS)
    expect(text(dialog)).toContain(`시험판으로 변경한 때: ${sys.formatTime('2026-01-05T02:00:00Z')}`)
    expect(text(dialog)).toContain('복원하는 동안 사용자는 점검 중 화면을 봅니다.')
    expect(called('PUT', '/settings')).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: '복원 시작' }))
    await waitFor(() => expect(page.path()).toBe('/admin/update/rollback/jobrs2'))
    expect(called('PUT', '/settings')[0].body).toMatchObject({ channel: 'stable', stable_return: 'restore' })
    expect(text(await screen.findByTestId('update-job-title'))).toContain('시험판 이전 상태로 복원하는 중입니다')
  })

  it('시험판 이전 백업이 없으면 복원은 고를 수 없다', async () => {
    const beta = fx.statuses.beta()
    await open(fx.settings({ channel: 'beta', beta: { since: '2026-01-05T02:00:00Z', restore_point: null } }), null, beta)
    fireEvent.click(radio(/안정판 \(Stable\)/))
    expect(disabled(screen.getByRole('radio', { name: /시험판 이전 상태로 복원/ }))).toBe(true)
    expect(screen.getByText('시험판으로 변경하기 직전의 백업이 없어 복원할 수 없습니다')).toBeTruthy()
  })

  it('이미 안정판으로 돌아와 기다리는 중이면 그 안내가 계속 보인다', async () => {
    const waiting = fx.statuses.wait()
    await open(fx.settings(), null, waiting)
    expect(text(await screen.findByTestId('update-stable-wait'))).toContain('1.2.0')
  })

  it('점검 화면의 연락처만 바꾸면 연락처만 저장한다', async () => {
    await open(fx.settings(), '내선 1000')
    on('PUT', '/contact', (c: any) => ({ contact: c.body.contact, synced: true }))
    const input = screen.getByLabelText('관리자 연락처')
    expect(value(input)).toBe('내선 1000')
    fireEvent.change(input, { target: { value: ' 내선 1234 ' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(called('PUT', '/contact')).toHaveLength(1))
    expect(called('PUT', '/contact')[0].body).toEqual({ contact: '내선 1234' })
    expect(called('PUT', '/settings')).toHaveLength(0)
  })
})

describe('앱 배포', () => {
  it('실린 것이 없는 버전: 빈 상태와 안내', async () => {
    on('GET', '/apps', fx.apps.none())
    await renderUpdate('/admin/update/apps')
    expect(text(await screen.findByTestId('update-apps-empty'))).toContain('이 버전에는 앱 설치 파일이 포함되어 있지 않습니다')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByLabelText('사용자에게 알릴 다운로드 주소')).toBeNull()
    expect(text(screen.getByText(/서버 버전/))).toContain('서버 버전 1.0.0에 함께 포함된 설치 파일입니다.')
  })

  it('실린 것만 줄로: 행 이름이 들어간 복사·내려받기, 사용자에게 알릴 주소', async () => {
    on('GET', '/apps', fx.apps.both())
    await renderUpdate('/admin/update/apps')
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map(r => within(r).getAllByRole('cell').slice(0, 4).map(c => c.textContent))).toEqual([
      ['데스크톱', 'Windows', '1.1.0', 'JustWorkspace-Setup-1.1.0.exe'],
      ['모바일', 'Android', '1.1.0', 'just-workspace-1.1.0.apk'],
    ])
    expect(screen.getByRole('button', { name: 'Windows 데스크톱 앱 다운로드 주소 복사' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Android 모바일 앱 다운로드' })).toBeTruthy()
    expect(value(screen.getByLabelText('사용자에게 알릴 다운로드 주소'))).toBe(`${location.origin}/settings/apps`)
    // 좁은 화면에서는 표가 가로로 넘침
    expect(table.className).toMatch(/min-w-\[620px\]/)
  })

  it('하나만 실렸으면 그 줄만', async () => {
    on('GET', '/apps', fx.apps.desktopOnly())
    await renderUpdate('/admin/update/apps')
    expect(within(await screen.findByRole('table')).getAllByRole('row')).toHaveLength(2)
    expect(screen.queryByText('Android')).toBeNull()
  })
})

describe('기록', () => {
  const open = async () => {
    on('GET', '/history', fx.history())
    for (const id of Object.keys(fx.historyDetails)) on('GET', `/history/${id}`, fx.historyDetails[id]())
    await renderUpdate('/admin/update/history')
    return screen.findByRole('table')
  }

  it('목록: 버전·시각·방식·결과·누가·걸린 시간', async () => {
    const table = await open()
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(5)
    expect(within(rows[0]).getAllByRole('cell').map(c => c.textContent)).toEqual([
      '1.3.0', sys.formatTime('2026-01-12T01:39:00Z'), '자동', '성공', '자동', '9분'])
    expect(rows.map(r => within(r).getAllByRole('cell')[3].textContent)).toEqual(['성공', '실패 · 롤백', '성공', '이전 버전 복원', '성공'])
    expect(text(within(rows[4]).getAllByRole('cell')[2])).toContain('오프라인')
    expect(text(within(rows[2]).getAllByRole('cell')[4])).toContain('관리자')
    expect(screen.getByText(/기록은 1년 동안 보관합니다/)).toBeTruthy()
    expect(screen.queryByTestId('update-history-detail')).toBeNull()
  })

  it('결과를 누르면 단계별 기록이 펼쳐진다 — 실패한 단계의 원인과 되돌림', async () => {
    await open()
    const button = screen.getByTestId('history-h4')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const detail = await screen.findByTestId('update-history-detail')
    expect(text(detail)).toContain('1.3.0 · 실패 · 롤백 · 단계별 기록')
    const failed = await within(detail).findByTestId('step-migrate')
    expect(failed.getAttribute('data-status')).toBe('failed')
    expect(text(failed)).toContain('DB 변경')
    expect(text(failed)).toContain('ERROR: relation exists')
    expect(within(detail).getByTestId('step-switch').getAttribute('data-status')).toBe('pending')
    expect(text(within(detail).getByTestId('step-preflight'))).toContain('4초')
    expect(text(within(detail).getByTestId('step-restore_db'))).toContain('백업에서 DB 복원')
    expect(within(detail).getByRole('button', { name: '로그 다운로드' })).toBeTruthy()
    // 재클릭 시 접힘
    fireEvent.click(button)
    expect(screen.queryByTestId('update-history-detail')).toBeNull()
  })

  it('중간 버전을 거친 업데이트는 버전마다 묶어 보인다', async () => {
    await open()
    fireEvent.click(screen.getByTestId('history-h3'))
    const detail = await screen.findByTestId('update-history-detail')
    expect(await within(detail).findByText('1/2번째 버전')).toBeTruthy()
    expect(within(detail).getByText('2/2번째 버전')).toBeTruthy()
  })

  it('복원 기록은 복원의 단계를 보인다', async () => {
    await open()
    fireEvent.click(screen.getByTestId('history-h2'))
    const detail = await screen.findByTestId('update-history-detail')
    expect(text(await within(detail).findByTestId('step-stop'))).toContain('구역 중지')
    expect(within(detail).queryByTestId('step-preflight')).toBeNull()
  })

  it('기록이 없으면 빈 안내', async () => {
    on('GET', '/history', { items: [], retention_days: 365, more: false })
    await renderUpdate('/admin/update/history')
    expect(text(await screen.findByTestId('update-history-empty'))).toContain('아직 기록이 없습니다')
  })
})

describe('적용된 버전의 변경 내용', () => {
  it('언제·어떻게 적용됐는지와 이전 버전, 변경 내용 — 시작 버튼은 없다', async () => {
    on('GET', '/releases/1.1.0', fx.releases.plain())
    await renderUpdate('/admin/update/changes/1.1.0')
    expect(text(await screen.findByTestId('update-applied'))).toContain(`${sys.formatTime('2026-01-11T18:21:40Z')} · 자동 업데이트 · 중단 3분 32초`)
    expect(screen.getByText('이전 버전')).toBeTruthy()
    expect(within(screen.getByTestId('update-changelog')).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByTestId('update-disabled-plugins')).toBeNull()
    expect(screen.queryByRole('button', { name: '업데이트 시작' })).toBeNull()
    expect(screen.getByRole('button', { name: '기록 보기' })).toBeTruthy()
  })

  it('올라오면서 꺼 둔 플러그인을 알린다', async () => {
    on('GET', '/releases/1.1.0', fx.releases.withDisabledPlugins())
    await renderUpdate('/admin/update/changes/1.1.0')
    expect(text(await screen.findByTestId('update-disabled-plugins'))).toContain('샘플 플러그인 · 이 버전으로 업데이트하면서 비활성화했습니다')
  })

  it('처음 설치한 버전은 적용 기록과 이전 버전 줄이 없다', async () => {
    on('GET', '/releases/1.0.0', fx.releases.firstInstall())
    await renderUpdate('/admin/update/changes/1.0.0')
    await screen.findByTestId('update-changelog')
    expect(screen.queryByTestId('update-applied')).toBeNull()
    expect(screen.queryByText('이전 버전')).toBeNull()
  })
})

describe('순수 계산', () => {
  it('경로 → 화면', () => {
    expect(sys.viewFromPath('/admin/update')).toEqual({ view: 'home', arg: null })
    expect(sys.viewFromPath('/admin/update/')).toEqual({ view: 'home', arg: null })
    expect(sys.viewFromPath('/admin/update/apply/job1')).toEqual({ view: 'apply', arg: 'job1' })
    expect(sys.viewFromPath('/admin/update/changes/1.2.0-beta.3')).toEqual({ view: 'changes', arg: '1.2.0-beta.3' })
    expect(sys.viewFromPath('/admin/update/nope/x')).toEqual({ view: 'home', arg: null })
  })
  it('용량·시간·시계·변경 내용', () => {
    expect(sys.formatBytes(1288490188)).toBe('1.2 GB')
    expect(sys.formatBytes(73400320)).toBe('70 MB')
    expect(sys.formatBytes(null)).toBe('')
    expect(sys.splitDuration(212)).toEqual({ m: 3, s: 32 })
    expect(sys.splitDuration(null)).toBeNull()
    expect(sys.clock(252)).toBe('04:12')
    expect(sys.clock(-3)).toBe('00:00')
    expect(sys.changelogLines('## 1.1.0\n- a\n* b\n\n1. c\n')).toEqual(['1.1.0', 'a', 'b', 'c'])
    expect(sys.formatTime('nope')).toBe('')
  })
  it('끝나지 않은 작업과 진행 화면 경로', () => {
    expect(sys.isLive(fx.jobs.pulling())).toBe(true)
    expect(sys.isLive(fx.jobs.failedBeforeMigrate())).toBe(true)      // 관리자의 선택 대기
    expect(sys.isLive(fx.jobs.failedAtMigrate())).toBe(false)         // 롤백 작업이 인계함
    expect(sys.isLive(fx.jobs.done())).toBe(false)
    expect(sys.jobPath(fx.jobs.pulling())).toBe('/admin/update/apply/job1')
    expect(sys.jobPath(fx.jobs.rollbackRunning())).toBe('/admin/update/rollback/jobrb1')
  })
})
