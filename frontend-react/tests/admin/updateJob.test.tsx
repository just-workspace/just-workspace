// 관리 › 업데이트 — 적용 진행(단계 네 상태, 이미지별 진행, 실패의 두 분기, 중간 버전, 예고 중 "지금 바로"),
// 롤백(자동 진행·완료·실패), 수동 복원(목록·확인 창·진행·완료·실패), 시험판 이전 상태로 복원, 서버 교체 중 상태 유지.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { api, on, seq, called, fakeFetch, renderUpdate, text, disabled, ADMIN } from './updateHarness'

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

const LOSS = '업데이트 이후에 작성한 메일·대화·일정이 사라집니다. 파일은 그대로입니다.'
const soon = () => new Date(Date.now() + 252_000).toISOString()
const stepStates = () => screen.getAllByTestId(/^step-/).map(el => `${el.getAttribute('data-testid')!.slice(5)}:${el.getAttribute('data-status')}`)
const title = async () => text(await screen.findByTestId('update-job-title'))
const button = (name: string | RegExp) => screen.getByRole('button', { name })

beforeEach(() => {
  api.calls = []
  api.routes = {}
  parts.updateTiming.pollMs = 20
  toastStore.setState({ toasts: [] } as any)
  setUser(ADMIN as any)
  on('GET', '/status', fx.statuses.latest())
})

describe('적용 진행', () => {
  it('진행 중: 제목·진행 줄·단계 상태, 이미지별 진행', async () => {
    on('GET', '/jobs/job1', fx.jobs.pulling())
    await renderUpdate('/admin/update/apply/job1')
    expect(await title()).toBe('1.1.0 버전으로 업데이트하는 중입니다')
    expect(text(screen.getByTestId('update-progress-text'))).toBe('전체 6단계 중 2단계 완료')
    expect(screen.getByRole('progressbar', { name: '업데이트 진행' }).getAttribute('aria-valuenow')).toBe('2')
    expect(stepStates()).toEqual(['preflight:done', 'backup:done', 'pull:running', 'migrate:pending', 'switch:pending', 'verify:pending'])
    // 상태는 아이콘과 텍스트로도 구분됨
    expect(text(screen.getByTestId('step-backup'))).toBe('자동 백업완료')
    expect(text(screen.getByTestId('step-migrate'))).toBe('DB 변경대기')
    expect(text(screen.getByTestId('step-pull'))).toContain('이미지 다운로드진행 중')
    // 이미지별 진행
    const backend = screen.getByTestId('image-backend')
    expect(within(backend).getByRole('progressbar', { name: 'backend' }).getAttribute('aria-valuenow')).toBe('62')
    expect(text(backend)).toBe('backend62%')
    expect(text(screen.getByTestId('image-frontend'))).toBe('frontend완료')
    expect(text(screen.getByTestId('image-mailserver'))).toBe('mailserver0%')
    expect(screen.getByText(/이 창을 닫아도 계속 진행됩니다/)).toBeTruthy()
    expect(screen.queryByTestId('update-version-index')).toBeNull()
    expect(screen.queryByTestId('update-failure')).toBeNull()
  })

  it('migrate 전 실패: "이 단계부터 다시"와 "되돌리기" 둘 중 고른다', async () => {
    on('GET', '/jobs/job1', fx.jobs.failedBeforeMigrate())
    on('POST', '/jobs/job1/action', () => { on('GET', '/jobs/job1', fx.jobs.pulling()); return fx.jobs.pulling() })
    await renderUpdate('/admin/update/apply/job1')
    expect(await title()).toBe('업데이트가 중단되었습니다')
    expect(stepStates()).toEqual(['preflight:done', 'backup:done', 'pull:failed', 'migrate:pending', 'switch:pending', 'verify:pending'])
    const failure = screen.getByTestId('update-failure')
    expect(text(failure)).toContain('새 버전의 이미지를 다운로드하던 중 중단되었습니다.')
    expect(text(failure)).toContain('아직 데이터베이스는 변경하지 않았습니다. 이 단계부터 다시 시도하거나, 중단하고 이전 버전(1.0.0)으로 롤백합니다.')
    expect(text(screen.getByTestId('update-error-detail'))).toBe('registry timeout')
    expect(within(failure).getByRole('button', { name: '롤백' })).toBeTruthy()
    expect(within(failure).queryByRole('button', { name: '롤백 진행 보기' })).toBeNull()
    expect(text(failure)).not.toContain('자동으로')

    fireEvent.click(within(failure).getByRole('button', { name: '이 단계부터 다시' }))
    await waitFor(() => expect(called('POST', '/jobs/job1/action')[0]?.body).toEqual({ action: 'retry' }))
    await waitFor(() => expect(screen.queryByTestId('update-failure')).toBeNull())
    expect(await title()).toBe('1.1.0 버전으로 업데이트하는 중입니다')
  })

  it('migrate 전 실패에서 "되돌리기"를 고르면 되돌림 진행으로 간다', async () => {
    on('GET', '/jobs/job1', fx.jobs.failedBeforeMigrate())
    on('POST', '/jobs/job1/action', { ...fx.jobs.failedBeforeMigrate(), choices: [], rollback_job: 'jobrb1' })
    on('GET', '/jobs/jobrb1', fx.jobs.rollbackRunning())
    const page = await renderUpdate('/admin/update/apply/job1')
    fireEvent.click(await screen.findByRole('button', { name: '롤백' }))
    await waitFor(() => expect(page.path()).toBe('/admin/update/rollback/jobrb1'))
    expect(called('POST', '/jobs/job1/action')[0].body).toEqual({ action: 'rollback' })
    await waitFor(async () => expect(await title()).toBe('이전 버전으로 롤백하는 중입니다'))
  })

  it('migrate 부터 실패: 선택 없이 자동 되돌림 — 다시 시도 버튼이 없다', async () => {
    on('GET', '/jobs/job1', fx.jobs.failedAtMigrate())
    on('GET', '/jobs/jobrb1', fx.jobs.rollbackRunning())
    const page = await renderUpdate('/admin/update/apply/job1')
    const failure = await screen.findByTestId('update-failure')
    expect(stepStates()).toEqual(['preflight:done', 'backup:done', 'pull:done', 'migrate:failed', 'switch:pending', 'verify:pending'])
    expect(text(failure)).toContain('데이터베이스 구조를 새 버전에 맞게 변경하던 중 중단되었습니다.')
    expect(text(failure)).toContain('이 단계부터는 다시 시도하지 않고, 시작할 때 만든 백업(DB·설정·암호화 키)으로 이전 버전(1.0.0)으로 자동으로 롤백합니다.')
    expect(within(failure).queryByRole('button', { name: '이 단계부터 다시' })).toBeNull()
    expect(within(failure).queryByRole('button', { name: '롤백' })).toBeNull()
    expect(within(failure).getByRole('button', { name: '로그 다운로드' })).toBeTruthy()

    fireEvent.click(within(failure).getByRole('button', { name: '롤백 진행 보기' }))
    await waitFor(() => expect(page.path()).toBe('/admin/update/rollback/jobrb1'))
    expect(called('POST', '/jobs/job1/action')).toHaveLength(0)
  })

  it('자동 업데이트는 migrate 전이어도 자동 되돌림이다', async () => {
    on('GET', '/jobs/job1', fx.jobs.autoFailedEarly())
    await renderUpdate('/admin/update/apply/job1')
    const failure = await screen.findByTestId('update-failure')
    expect(text(failure)).toContain('자동 업데이트는 어느 단계에서 실패하든 다시 시도하지 않고, 이전 버전(1.0.0)으로 자동으로 롤백합니다.')
    expect(within(failure).queryByRole('button', { name: '이 단계부터 다시' })).toBeNull()
    expect(within(failure).getByRole('button', { name: '롤백 진행 보기' })).toBeTruthy()
  })

  it('"기록 보기"를 누르면 그 작업의 기록이 펼쳐진다', async () => {
    on('GET', '/jobs/job1', fx.jobs.failedBeforeMigrate())
    on('GET', '/jobs/job1/log', { lines: ['[pull] 시작', '[pull] 실패: registry timeout'] })
    await renderUpdate('/admin/update/apply/job1')
    const view = await screen.findByRole('button', { name: '로그 보기' })
    expect(view.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view)
    await waitFor(() => expect(text(screen.getByTestId('update-log'))).toContain('[pull] 실패: registry timeout'))
    expect(view.getAttribute('aria-expanded')).toBe('true')
  })

  it('중간 버전: 지금 몇 번째 버전인지 보인다', async () => {
    on('GET', '/jobs/job1', fx.jobs.hopFirst())
    const page = await renderUpdate('/admin/update/apply/job1')
    expect(text(await screen.findByTestId('update-version-index'))).toBe('1/2번째 버전 · 1.1.0')
    expect(await title()).toBe('1.1.0 버전으로 업데이트하는 중입니다')
    expect(screen.getByLabelText('거칠 버전')).toBeTruthy()
    page.unmount()

    on('GET', '/jobs/job1', fx.jobs.hopDone())
    await renderUpdate('/admin/update/apply/job1')
    expect(text(await screen.findByTestId('update-version-index'))).toBe('2/2번째 버전 · 1.2.0')
    expect(text(screen.getByTestId('update-job-done'))).toContain('1.2.0 버전으로 업데이트했습니다.')
  })

  it('예고 중: 남은 시간, "지금 바로 시작"을 누르면 곧바로 진행으로', async () => {
    on('GET', '/jobs/job1', fx.jobs.countdown(soon()))
    on('POST', '/jobs/job1/action', () => { on('GET', '/jobs/job1', fx.jobs.pulling()); return fx.jobs.pulling() })
    await renderUpdate('/admin/update/apply/job1')
    expect(await title()).toBe('곧 업데이트를 시작합니다')
    const box = screen.getByTestId('update-job-countdown')
    expect(text(box)).toMatch(/사용자에게 곧 업데이트를 시작한다고 알리고 있습니다\. 남은 시간 04:1\d/)
    expect(text(box)).toContain('사용자 화면 위쪽에 저장을 안내하는 배너가 표시되어 있습니다.')
    expect(text(screen.getByTestId('update-progress-text'))).toBe('전체 6단계 중 0단계 완료')
    fireEvent.click(within(box).getByRole('button', { name: '지금 바로 시작' }))
    await waitFor(() => expect(called('POST', '/jobs/job1/action')[0]?.body).toEqual({ action: 'start_now' }))
    await waitFor(() => expect(screen.queryByTestId('update-job-countdown')).toBeNull())
    expect(await title()).toBe('1.1.0 버전으로 업데이트하는 중입니다')
  })

  it('예고 중 취소', async () => {
    on('GET', '/jobs/job1', fx.jobs.countdown(soon()))
    on('POST', '/jobs/job1/action', () => { on('GET', '/jobs/job1', fx.jobs.cancelled()); return fx.jobs.cancelled() })
    const page = await renderUpdate('/admin/update/apply/job1')
    fireEvent.click(within(await screen.findByTestId('update-job-countdown')).getByRole('button', { name: '취소' }))
    await waitFor(async () => expect(await title()).toBe('업데이트를 취소했습니다'))
    expect(called('POST', '/jobs/job1/action')[0].body).toEqual({ action: 'cancel' })
    expect(screen.queryAllByTestId(/^step-/)).toHaveLength(0)
    fireEvent.click(screen.getAllByRole('button', { name: '현황으로' }).pop()!)
    await waitFor(() => expect(page.path()).toBe('/admin/update'))
  })

  it('완료: 모든 단계가 끝나고 결과와 현황으로 가는 길', async () => {
    on('GET', '/jobs/job1', fx.jobs.done())
    await renderUpdate('/admin/update/apply/job1')
    expect(await title()).toBe('업데이트가 완료되었습니다')
    expect(new Set(stepStates().map(s => s.split(':')[1]))).toEqual(new Set(['done']))
    expect(text(screen.getByTestId('update-progress-text'))).toBe('전체 6단계 중 6단계 완료')
    expect(text(screen.getByTestId('update-job-done'))).toContain('1.1.0 버전으로 업데이트했습니다. 사용자는 다시 접속할 수 있습니다.')
    expect(screen.queryByText(/이 창을 닫아도 계속 진행됩니다/)).toBeNull()
  })

  it('서버가 바뀌는 동안: 읽기가 실패해도 "다시 연결 중"으로 견디고, 돌아오면 이어서 보인다', async () => {
    const down = () => { throw fx.errors.down() }
    on('GET', '/jobs/job1', seq(fx.jobs.pulling(), down, down, down, fx.jobs.done()))
    await renderUpdate('/admin/update/apply/job1')
    expect(await title()).toBe('1.1.0 버전으로 업데이트하는 중입니다')
    expect(text(await screen.findByTestId('update-reconnecting'))).toContain('다시 연결 중')
    // 마지막으로 확인된 단계는 그대로 유지
    expect(screen.getByTestId('step-pull').getAttribute('data-status')).toBe('running')
    await waitFor(async () => expect(await title()).toBe('업데이트가 완료되었습니다'))
    expect(screen.queryByTestId('update-reconnecting')).toBeNull()
  })

  it('화면을 처음 열 때 서버가 내려가 있어도 계속 읽는다', async () => {
    const down = () => { throw fx.errors.down() }
    on('GET', '/jobs/job1', seq(down, down, fx.jobs.pulling()))
    await renderUpdate('/admin/update/apply/job1')
    expect(await screen.findByTestId('update-reconnecting')).toBeTruthy()
    expect(await title()).toBe('1.1.0 버전으로 업데이트하는 중입니다')
  })

  it('없는 작업', async () => {
    on('GET', '/jobs/nope', () => { throw fx.apiError(404, 'job_unknown') })
    await renderUpdate('/admin/update/apply/nope')
    expect(await screen.findByText('이 작업의 기록을 찾을 수 없습니다')).toBeTruthy()
  })

  it('작업 id 없이 들어오면 진행 중인 것으로, 없으면 현황으로 보낸다', async () => {
    on('GET', '/status', fx.status({ job: fx.jobs.pulling() }))
    on('GET', '/jobs/job1', fx.jobs.pulling())
    const page = await renderUpdate('/admin/update/apply')
    await waitFor(() => expect(page.path()).toBe('/admin/update/apply/job1'))
    page.unmount()
    on('GET', '/status', fx.statuses.latest())
    const again = await renderUpdate('/admin/update/apply')
    await waitFor(() => expect(again.path()).toBe('/admin/update'))
  })
})

describe('되돌림 — 자동', () => {
  it('진행 중: 다섯 단계와 무엇을 되돌리는지', async () => {
    on('GET', '/jobs/jobrb1', fx.jobs.rollbackRunning())
    await renderUpdate('/admin/update/rollback/jobrb1')
    expect(await title()).toBe('이전 버전으로 롤백하는 중입니다')
    expect(screen.getByText('업데이트가 실패하여, 시작할 때 만든 백업으로 자동으로 롤백합니다.')).toBeTruthy()
    expect(stepStates()).toEqual(['stop:done', 'images:done', 'restore_db:running', 'start:pending', 'verify:pending'])
    expect(text(screen.getByTestId('step-images'))).toBe('이전 이미지로 변경완료')
    expect(text(screen.getByTestId('update-progress-text'))).toBe('전체 5단계 중 2단계 완료')
    expect(screen.getByText(/복원 대상은 데이터베이스, 설정, 암호화 키입니다\. 파일은 백업하지 않았으며 변경하지도 않습니다\./)).toBeTruthy()
    expect(screen.getByRole('tab', { name: '롤백' }).getAttribute('aria-selected')).toBe('true')
  })

  it('완료', async () => {
    on('GET', '/jobs/jobrb1', fx.jobs.rollbackDone())
    await renderUpdate('/admin/update/rollback/jobrb1')
    expect(await title()).toBe('이전 버전으로 롤백했습니다')
    expect(text(screen.getByTestId('update-job-done'))).toContain('이전 버전(1.0.0)으로 롤백했습니다. 업데이트를 시작하기 직전 상태이고, 파일은 그대로입니다. 사용자는 다시 접속할 수 있습니다.')
  })

  it('실패: 워크스페이스가 멈춰 있다는 것, 백업 위치, 문서, 다시 시도 — 지원 창구 문구는 없다', async () => {
    on('GET', '/jobs/jobrb1', fx.jobs.rollbackFailed())
    on('POST', '/jobs/jobrb1/action', () => { on('GET', '/jobs/jobrb1', fx.jobs.rollbackRunning()); return fx.jobs.rollbackRunning() })
    await renderUpdate('/admin/update/rollback/jobrb1')
    expect(await title()).toBe('롤백이 중단되었습니다')
    expect(screen.getByText('자동 롤백이 한 단계에서 중단되었습니다.')).toBeTruthy()
    const failure = screen.getByTestId('update-failure')
    expect(text(failure)).toContain('백업에서 데이터베이스를 복원하지 못했습니다.')
    expect(text(failure)).toContain('워크스페이스는 중지된 상태입니다.')
    expect(text(failure)).toContain('백업 파일은 /data/backups/pre-update-20260112.jwbak에 그대로 있습니다.')
    expect(within(failure).getByRole('link', { name: '데이터 안전 문서의 복원 절차' }).getAttribute('href')).toBe(sys.UPDATE_DOCS_URL)
    expect(within(failure).queryByRole('button', { name: '롤백' })).toBeNull()
    expect(text(failure)).not.toMatch(/문의|지원/)
    expect(within(failure).getByRole('button', { name: '로그 다운로드' })).toBeTruthy()
    fireEvent.click(within(failure).getByRole('button', { name: '이 단계부터 다시' }))
    await waitFor(() => expect(called('POST', '/jobs/jobrb1/action')[0]?.body).toEqual({ action: 'retry' }))
    await waitFor(async () => expect(await title()).toBe('이전 버전으로 롤백하는 중입니다'))
  })
})

describe('되돌림 — 수동 복원', () => {
  const open = async (status = fx.statuses.latest()) => {
    on('GET', '/status', status)
    on('GET', '/restore-points', { points: fx.restorePoints() })
    const page = await renderUpdate('/admin/update/rollback')
    await screen.findByRole('table')
    return page
  }

  it('복원 지점 목록: 버전·백업 시각·크기, 사라지는 것과 남는 것', async () => {
    await open()
    expect(screen.getByText(`업데이트 직전에 만든 백업(DB·설정·암호화 키)으로 복원합니다. ${LOSS}`)).toBeTruthy()
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map(r => within(r).getAllByRole('cell').slice(0, 3).map(c => c.textContent))).toEqual([
      ['1.0.0', sys.formatTime('2026-01-10T18:00:02Z'), '70 MB'],
      ['1.1.4', sys.formatTime('2026-01-05T02:00:00Z'), '67 MB'],
    ])
    expect(screen.getByText(/업데이트가 실패하면 여기서 선택하지 않아도 자동으로 롤백합니다/)).toBeTruthy()
  })

  it('확인 창: 제목은 고른 버전, 본문은 확정 문구 — 취소하면 아무 일도 없다', async () => {
    await open()
    fireEvent.click(button(/^1\.0\.0 버전.*복원$/))
    const dialog = await screen.findByRole('alertdialog')
    expect(text(dialog)).toContain('1.0.0 버전으로 복원하시겠습니까?')
    const body = within(dialog).getByTestId('update-restore-body')
    expect(text(body)).toContain(LOSS)
    expect(text(body)).toContain('복원하는 동안 사용자는 점검 중 화면을 봅니다. 시작하면 사용자 화면에 5분간 사전 공지가 먼저 표시됩니다.')
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(called('POST', '/restore')).toHaveLength(0)

    // 다른 행 선택 시 제목이 해당 버전으로 변경
    fireEvent.click(button(/^1\.1\.4 버전.*복원$/))
    expect(text(await screen.findByRole('alertdialog'))).toContain('1.1.4 버전으로 복원하시겠습니까?')
  })

  it('복원 시작 → 예고 → 진행 → 완료', async () => {
    const page = await open()
    on('POST', '/restore', fx.jobs.restoreCountdown(soon()))
    on('GET', '/jobs/jobrs1', seq(fx.jobs.restoreCountdown(soon()), fx.jobs.restoreRunning(), fx.jobs.restoreRunning(), fx.jobs.restoreDone()))
    fireEvent.click(button(/^1\.0\.0 버전.*복원$/))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '복원 시작' }))
    await waitFor(() => expect(page.path()).toBe('/admin/update/rollback/jobrs1'))
    expect(called('POST', '/restore')[0].body).toEqual({ point: 'rp-1', start: 'countdown' })
    await waitFor(async () => expect(await title()).toBe('1.0.0 버전으로 복원하는 중입니다'))
    expect(screen.getByText('관리자가 선택한 이전 버전으로 복원합니다.')).toBeTruthy()
    await waitFor(async () => expect(await title()).toBe('1.0.0 버전으로 복원했습니다'))
    expect(text(screen.getByTestId('update-job-done'))).toContain('1.0.0 버전으로 복원했습니다. 업데이트 이후에 작성한 메일·대화·일정은 사라졌고, 파일은 그대로입니다. 사용자는 다시 접속할 수 있습니다.')
  })

  it('복원의 예고는 복원이라고 말한다', async () => {
    on('GET', '/jobs/jobrs1', fx.jobs.restoreCountdown(soon()))
    await renderUpdate('/admin/update/rollback/jobrs1')
    expect(await title()).toBe('곧 복원을 시작합니다')
    expect(text(screen.getByTestId('update-job-countdown'))).toContain('사용자에게 곧 복원을 시작한다고 알리고 있습니다.')
  })

  it('수동 복원 실패: 복원이 멈췄다는 것과 다시 시도', async () => {
    on('GET', '/jobs/jobrs1', fx.jobs.restoreFailed())
    await renderUpdate('/admin/update/rollback/jobrs1')
    expect(await title()).toBe('복원이 중단되었습니다')
    expect(screen.getByText('복원이 한 단계에서 중단되었습니다.')).toBeTruthy()
    const failure = screen.getByTestId('update-failure')
    expect(text(failure)).toContain('구역을 다시 시작하지 못했습니다.')
    expect(text(failure)).toContain('워크스페이스는 중지된 상태입니다.')
    expect(text(failure)).not.toContain('백업 파일은')          // 위치를 수신하지 못한 경우 해당 문장 없음
    expect(within(failure).getByRole('button', { name: '이 단계부터 다시' })).toBeTruthy()
    expect(stepStates()).toEqual(['stop:done', 'images:done', 'restore_db:done', 'start:failed', 'verify:pending'])
  })

  it('시험판 이전 상태로 복원: 진행·완료·실패의 문구', async () => {
    on('GET', '/jobs/jobrs2', fx.jobs.betaRestoreRunning())
    const a = await renderUpdate('/admin/update/rollback/jobrs2')
    expect(await title()).toBe('시험판 이전 상태로 복원하는 중입니다')
    expect(screen.getByText('시험판으로 변경하기 직전의 백업으로 복원하고, 채널을 안정판으로 변경합니다.')).toBeTruthy()
    a.unmount()

    on('GET', '/jobs/jobrs2', fx.jobs.betaRestoreDone())
    const b = await renderUpdate('/admin/update/rollback/jobrs2')
    expect(await title()).toBe('시험판 이전 상태로 복원했습니다')
    expect(text(screen.getByTestId('update-job-done'))).toContain('안정판 1.1.4 버전으로 돌아왔습니다. 시험판으로 변경한 이후에 작성한 메일·대화·일정은 사라졌고, 파일은 그대로입니다. 채널은 안정판입니다.')
    b.unmount()

    on('GET', '/jobs/jobrs2', fx.jobs.betaRestoreFailed())
    await renderUpdate('/admin/update/rollback/jobrs2')
    expect(await title()).toBe('복원이 중단되었습니다')
    expect(screen.getByText('시험판 이전 상태로 복원하던 중 한 단계에서 중단되었습니다.')).toBeTruthy()
    expect(text(screen.getByTestId('update-failure'))).toContain('백업에서 데이터베이스를 복원하지 못했습니다.')
  })

  it('복원 지점이 없으면 빈 안내', async () => {
    on('GET', '/restore-points', { points: [] })
    await renderUpdate('/admin/update/rollback')
    expect(text(await screen.findByTestId('update-restore-empty'))).toContain('복원할 수 있는 백업이 없습니다.')
  })

  it('다른 작업이 진행 중이면 고를 수 없고 그 진행으로 가는 길이 있다', async () => {
    await open(fx.status({ job: fx.jobs.rollbackRunning() }))
    expect(text(await screen.findByTestId('update-live-job'))).toContain('이전 버전으로 롤백하는 중입니다')
    expect(disabled(button(/^1\.0\.0 버전.*복원$/))).toBe(true)
  })

  it('시작하지 못하면 알리고 목록에 남는다', async () => {
    const page = await open()
    on('POST', '/restore', () => { throw fx.errors.busy() })
    fireEvent.click(button(/^1\.0\.0 버전.*복원$/))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '복원 시작' }))
    await waitFor(() => expect(toastStore.getState().toasts).toHaveLength(1))
    expect(page.path()).toBe('/admin/update/rollback')
  })
})

describe('진행 조회와 제어가 엇갈릴 때', () => {
  it('제어의 응답보다 먼저 떠난 조회의 답은 버린다', async () => {
    let release: (v: any) => void = () => {}
    let hold = false
    on('GET', '/jobs/job1', () => (hold ? new Promise((r) => { release = r }) : fx.jobs.countdown(soon())))
    on('POST', '/jobs/job1/action', fx.jobs.cancelled())
    await renderUpdate('/admin/update/apply/job1')
    await screen.findByTestId('update-job-countdown')
    hold = true
    await waitFor(() => expect(called('GET', '/jobs/job1').length).toBeGreaterThan(1))      // 조회 1건이 진행 중
    fireEvent.click(within(screen.getByTestId('update-job-countdown')).getByRole('button', { name: '취소' }))
    await waitFor(async () => expect(await title()).toBe('업데이트를 취소했습니다'))
    release(fx.jobs.countdown(soon()))                                                        // 지연 도착한 이전 응답
    await new Promise(r => setTimeout(r, 60))
    expect(await title()).toBe('업데이트를 취소했습니다')
  })
})
