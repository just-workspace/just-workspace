// 승인 대기함: 목록 → 첫 요청 상세(데스크톱 자동 선택), ?id= 딥 링크, 승인·거부(사유) 호출,
// 외부 내용 경고, 빈 상태 · 오류 상태, 목록에 없는 ?id= 는 따로 불러온다(만료 상세), 모바일 목록 → 상세.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ApprovalRequest } from '~/utils/approvals'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  pending: [] as any[],
  history: [] as any[],
  byId: {} as Record<string, any>,
  failList: false,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    const now = new Date().toISOString()
    if (url === '/api/approvals') {
      if (api.failList) throw Object.assign(new Error('503'), { statusCode: 503 })
      const view = opts?.query?.view
      const items = view === 'history' ? api.history : api.pending
      return { items, has_more: false, next_cursor: null, pending: api.pending.length, server_now: now }
    }
    if (url === '/api/approvals/count') return { pending: api.pending.length }
    const m = url.match(/^\/api\/approvals\/([^/]+)(?:\/(\w+))?$/)
    if (m) {
      const [, id, action] = m
      const base = api.byId[id] || api.pending.find(p => p.id === id)
      if (!base) throw Object.assign(new Error('404'), { statusCode: 404 })
      if (action === 'approve') return { ...base, status: 'executed', decided_at: now, executed_at: now, server_now: now }
      if (action === 'reject') return { ...base, status: 'rejected', reject_reason: opts?.body?.reason ?? null, decided_at: now, server_now: now }
      return { ...base, server_now: now }
    }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: ApprovalsPage } = await import('~/pages/approvals')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')
const { approvalsStore } = await import('~/composables/useApprovals')
const { i18n } = await import('~/i18n')
const t = (k: string, v?: Record<string, unknown>) => i18n.t(k, v)

const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

function item(id: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = Date.now()
  return {
    id, tool: 'files_share_external', title: `요청 ${id}`, risk: 'high', status: 'pending', source: 'mcp',
    client_kind: 'claude_app', client_name: 'Claude', target_summary: `대상 ${id}`, conversation_id: null,
    after_untrusted: false, args: { path: `/프로젝트/${id}.pdf`, audience: 'anyone_with_link' },
    preview: [{ field: 'path', label: '경로', before: null, after: `/프로젝트/${id}.pdf` }], editable: [],
    read_external: null, result: null, error: null, reject_reason: null,
    created_at: iso(now - MIN), expires_at: iso(now + 20 * MIN), decided_at: null, executed_at: null,
    can_undo: false, undo_until: null, server_now: iso(now),
    ...over,
  }
}

function renderPage(path = '/approvals') {
  const router = createMemoryRouter([{ path: '/approvals', element: <ApprovalsPage /> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  api.calls = []
  api.failList = false
  api.pending = [
    item('apv_a', { after_untrusted: true, read_external: { kind: 'mail', at: iso(Date.now() - 2 * MIN), from: 'billing@quote-mailer.net', subject: '견적서 확인 요청', label: '받은 메일' } }),
    item('apv_b', { source: 'ai', client_kind: 'builtin_web', client_name: null, tool: 'mail_send', title: '메일 발송' }),
  ]
  api.history = []
  api.byId = {}
  isMobileStore.setState({ isMobile: false })
  approvalsStore.setState({ pending: null, seq: 0 })
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null })
})

describe('승인 대기함 — 데스크톱', () => {
  it('목록을 받고 첫 요청을 상세로, 인자·외부 내용 경고, 대기 수를 스토어에', async () => {
    renderPage()
    const list = await screen.findByRole('list', { name: t('approvals.list.label') })
    expect(list.querySelectorAll('li').length).toBe(2)
    const detail = await screen.findByRole('region', { name: t('approvals.detail.label') })
    expect(detail.textContent).toContain('요청 apv_a')
    expect(detail.textContent).toContain('"audience": "anyone_with_link"')
    expect(screen.getByRole('note').textContent).toContain('billing@quote-mailer.net')
    expect(approvalsStore.getState().pending).toBe(2)
    expect(api.calls.find(c => c.url === '/api/approvals')?.opts?.query?.view).toBe('pending')
  })

  it('?id= 딥 링크는 그 요청을 고른다', async () => {
    renderPage('/approvals?id=apv_b')
    const detail = await screen.findByRole('region', { name: t('approvals.detail.label') })
    await waitFor(() => expect(detail.textContent).toContain('메일 발송'))
    expect(detail.textContent).toContain(t('approvals.source.ai'))
  })

  it('거부: 사유를 실어 POST /reject', async () => {
    renderPage()
    await screen.findByRole('region', { name: t('approvals.detail.label') })
    fireEvent.change(screen.getByLabelText(t('approvals.detail.reasonLabel')), { target: { value: '외부 수신자 빼고 다시' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('approvals.detail.reject') })) })
    const call = api.calls.find(c => c.url === '/api/approvals/apv_a/reject')
    expect(call?.opts?.method).toBe('POST')
    expect(call?.opts?.body).toEqual({ reason: '외부 수신자 빼고 다시' })
    await waitFor(() => expect(screen.getByRole('region', { name: t('approvals.detail.label') }).textContent).toContain(t('approvals.status.rejected')))
  })

  it('승인: POST /approve → 상세는 처리됨', async () => {
    renderPage('/approvals?id=apv_b')
    const detail = await screen.findByRole('region', { name: t('approvals.detail.label') })
    await waitFor(() => expect(detail.textContent).toContain('메일 발송'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('approvals.detail.approve') })) })
    expect(api.calls.some(c => c.url === '/api/approvals/apv_b/approve' && c.opts?.method === 'POST')).toBe(true)
    await waitFor(() => expect(screen.queryByRole('button', { name: t('approvals.detail.approve') })).toBeNull())
    expect(screen.getByRole('region', { name: t('approvals.detail.label') }).textContent).toContain(t('approvals.status.approved'))
  })

  it('목록에 없는 ?id=(만료된 것)는 따로 불러 만료 상세로', async () => {
    api.byId.apv_old = item('apv_old', { status: 'expired', title: '게시글 삭제', decided_at: iso(Date.now() - 5 * MIN) })
    renderPage('/approvals?id=apv_old')
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/approvals/apv_old')).toBe(true))
    const detail = await screen.findByRole('region', { name: t('approvals.detail.label') })
    await waitFor(() => expect(detail.textContent).toContain('게시글 삭제'))
    expect(detail.textContent).toContain(t('approvals.detail.expiredNoteHigh'))
    expect(screen.queryByRole('button', { name: t('approvals.detail.approve') })).toBeNull()
  })

  it('빈 상태 → [처리 기록 보기]가 기록 탭(표)', async () => {
    api.pending = []
    api.history = [item('apv_h', { status: 'executed', decided_at: iso(Date.now()), title: '파일 삭제' })]
    renderPage()
    const action = await screen.findByRole('button', { name: t('approvals.empty.action') })
    expect(screen.getByText(t('approvals.empty.title'))).toBeTruthy()
    await act(async () => { fireEvent.click(action) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/approvals' && c.opts?.query?.view === 'history')).toBe(true))
    const table = await screen.findByRole('table')
    expect(table.textContent).toContain('파일 삭제')
    expect(table.textContent).toContain(t('approvals.status.approved'))
  })

  it('불러오기 실패 → 오류 타일 + 다시 시도', async () => {
    api.failList = true
    renderPage()
    expect(await screen.findByText(t('approvals.errors.loadPending'))).toBeTruthy()
    api.failList = false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.retry') })) })
    expect(await screen.findByRole('list', { name: t('approvals.list.label') })).toBeTruthy()
  })
})

describe('승인 대기함 — 모바일 390', () => {
  it('목록만 → 행을 누르면 상세(아래 [거부][승인] 2칸)', async () => {
    isMobileStore.setState({ isMobile: true })
    const router = renderPage()
    const list = await screen.findByRole('list', { name: t('approvals.list.label') })
    expect(screen.queryByRole('region', { name: t('approvals.detail.label') })).toBeNull()
    await act(async () => { fireEvent.click(list.querySelectorAll('button')[1]) })
    expect(router.state.location.search).toBe('?id=apv_b')
    const detail = await screen.findByRole('region', { name: t('approvals.detail.label') })
    const approve = screen.getByRole('button', { name: t('approvals.detail.approveShort') })
    expect(approve.parentElement?.className).toContain('grid-cols-2')
    expect(detail.textContent).toContain('mail_send')
  })
})
