// 관리자 › AI 운영(시안 F1·F2·I1·I2): 탭 경로, 사용량 수치·표·실패/권한 상태, 쓰기 현황, 감사 필터·빈 상태·CSV,
// 정책 저장(바뀐 값만), 피드백 목록 → 첨부 대화 패널(열람 안내) → 스냅샷 삭제 확인 · 만료(410) · 빈 목록 · 실패.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  usageFail: 0 as number,
  auditItems: [] as any[],
  feedbackItems: [] as any[],
  feedbackFail: false,
  snapshot: {} as Record<string, any>,
  gov: { mask_pii: true, mcp_write_enabled: true, mcp_rate_limit_per_min: 30, audit_retention_years: 1, local_only: false } as any,
}))

const USAGE = {
  days: 30,
  totals: { tool_calls: 9870, tool_success_rate: 0.984, questions: 6420, connector_calls: 1310, builtin_calls: 8560, write_tool_calls: 640, tool_failures: 162, active_users: 74, users_total: 118, truncated: false },
  daily: [{ date: '2026-11-04', tool_calls: 10, questions: 342 }, { date: '2026-11-05', tool_calls: 12, questions: 296 }],
  users: [{ user_id: 'u1', name: '김하나', groups: ['인프라팀'], questions: 412, tool_calls: 890, tool_failures: 9 }],
  groups: [{ group: '인프라팀', users: 14, questions: 2410, tool_calls: 5120 }],
  tools: [{ tool: 'files_share_external', calls: 37, failures: 9, success_rate: 0.757, p50_ms: 160, p95_ms: 520 }],
  writes_summary: {
    low: { executed: 512, undone: 14, rejected: 0, canceled: 3, expired: 22, failed: 9, pending: 0 },
    high: { executed: 61, undone: 0, rejected: 17, canceled: 0, expired: 11, failed: 2, pending: 1 },
    low_after_untrusted: 8, untrusted_window_min: 15,
  },
  feedback: { up: 1284, down: 173, reasons: { inaccurate: 71, wrong_source: 22 } },
}

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    if (url === '/api/admin/ai/usage') {
      if (api.usageFail) throw Object.assign(new Error('x'), { statusCode: api.usageFail })
      return USAGE
    }
    if (url === '/api/admin/ai/audit') return { items: api.auditItems, has_more: false, next_cursor: null, retention_years: 2 }
    if (url.startsWith('/api/admin/ai/audit.csv')) return { _data: new Blob(['a']), headers: new Headers() }
    if (url === '/api/admin/ai/feedback') {
      if (api.feedbackFail) throw Object.assign(new Error('x'), { statusCode: 500 })
      const items = opts?.query?.attached_only ? api.feedbackItems.filter(i => i.snapshot === 'attached') : api.feedbackItems
      return { items, total: items.length, has_more: false, next_cursor: null, attached_total: 1, reason_counts: { wrong_source: 1 }, snapshot_ttl_days: 90 }
    }
    const m = url.match(/^\/api\/admin\/ai\/feedback\/([^/]+)\/snapshot$/)
    if (m) {
      if (opts?.method === 'DELETE') return { id: m[1], snapshot: 'admin_deleted' }
      const s = api.snapshot[m[1]]
      if (s === 410) throw Object.assign(new Error('gone'), { statusCode: 410, data: { detail: { code: 'expired' } } })
      return s
    }
    if (url === '/api/ai/config') return { governance: api.gov }
    if (url === '/api/ai/governance') { api.gov = { ...api.gov, ...opts.body }; return { governance: api.gov } }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: AiOpsPage } = await import('~/pages/admin/ai-ops')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { tabFromPath, niceMax, errorDetail, snapshotGoneCode } = await import('~/utils/aiOps')
const { parseRate } = await import('~/components/admin/aiOps/PolicyTab')
const { i18n } = await import('~/i18n')
const t = (k: string, v?: Record<string, unknown>) => i18n.t(k, v)

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: '/admin/ai-ops/*', element: <AiOpsPage /> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}
const callsTo = (u: string) => api.calls.filter(c => c.url === u)

beforeEach(() => {
  api.calls = []
  api.usageFail = 0
  api.auditItems = []
  api.feedbackItems = []
  api.feedbackFail = false
  api.snapshot = {}
  api.gov = { mask_pii: true, mcp_write_enabled: true, mcp_rate_limit_per_min: 30, audit_retention_years: 1, local_only: false }
  isMobileStore.setState({ isMobile: false })
})

describe('도우미', () => {
  it('경로 → 탭, 눈금, 오류 줄, 분당 한도 검사, 410 코드', () => {
    expect(tabFromPath('/admin/ai-ops')).toBe('usage')
    expect(tabFromPath('/admin/ai-ops/feedback')).toBe('feedback')
    expect(tabFromPath('/admin/ai-ops/owner/repo')).toBe('usage')
    expect(niceMax(342)).toBe(400)
    expect(niceMax(0)).toBe(10)
    expect(errorDetail({ path: '/api/admin/ai/usage', status: 504, at: new Date(2026, 10, 5, 11, 52) })).toBe('/api/admin/ai/usage · 504 · 11:52')
    expect(parseRate('30')).toBe(30)
    expect(parseRate('10001')).toBeNull()
    expect(parseRate('-1')).toBeNull()
    expect(snapshotGoneCode({ statusCode: 410, data: { detail: { code: 'conversation_deleted' } } })).toBe('conversation_deleted')
    expect(snapshotGoneCode({ statusCode: 500 })).toBeNull()
  })
})

describe('사용량', () => {
  it('핵심 수치·막대·표·한도 배분 비활성 탭', async () => {
    renderAt('/admin/ai-ops')
    expect(await screen.findByText('6,420')).toBeTruthy()
    expect(screen.getByText(t('aiOps.usage.toolCallsSub', { n: '640' }))).toBeTruthy()
    expect(screen.getByText('98.4%')).toBeTruthy()
    expect(screen.getByText(t('aiOps.usage.activeSub', { n: '118' }))).toBeTruthy()
    expect(screen.getByRole('img', { name: t('aiOps.usage.barAria', { date: '11-04', n: 342 }) })).toBeTruthy()
    expect(screen.getByText('김하나')).toBeTruthy()
    expect(screen.getByText('75.7%').className).toContain('text-warning') // 성공률 90% 미만
    expect(screen.getByText(t('aiOps.usage.quotaNext'))).toBeTruthy()
    expect(screen.getByRole('tab', { name: t('aiOps.tabs.quota') }).hasAttribute('disabled') || screen.getByRole('tab', { name: t('aiOps.tabs.quota') }).getAttribute('aria-disabled') === 'true').toBe(true)
    // 기간 바꾸면 다시 부른다
    fireEvent.click(screen.getByRole('radio', { name: t('aiOps.days', { n: 7 }) }))
    await waitFor(() => expect(callsTo('/api/admin/ai/usage').map(c => c.opts.query.days)).toEqual([30, 7]))
  })

  it('불러오기 실패 → 오류 타일 + 다시 시도, 403 → 권한 상태', async () => {
    api.usageFail = 504
    renderAt('/admin/ai-ops')
    expect(await screen.findByText(t('aiOps.usage.loadFailed'))).toBeTruthy()
    expect(screen.getByText(/\/api\/admin\/ai\/usage · 504 · /)).toBeTruthy()
    api.usageFail = 0
    fireEvent.click(screen.getByRole('button', { name: t('aiOps.retry') }))
    expect(await screen.findByText('6,420')).toBeTruthy()
  })

  it('403 이면 권한 안내(다시 시도 없음)', async () => {
    api.usageFail = 403
    renderAt('/admin/ai-ops')
    expect(await screen.findByText(t('aiOps.forbiddenTitle'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('aiOps.retry') })).toBeNull()
  })

  it('모바일 — 상위 5 목록 + 안내', async () => {
    isMobileStore.setState({ isMobile: true })
    renderAt('/admin/ai-ops')
    expect(await screen.findByText(t('aiOps.usage.mobileNote'))).toBeTruthy()
    expect(screen.getByText(t('aiOps.usage.topUsers'))).toBeTruthy()
  })
})

describe('쓰기 현황', () => {
  it('low 거부·high 되돌림은 —, 외부 내용 뒤 low 안내', async () => {
    renderAt('/admin/ai-ops/writes')
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows[1].textContent).toContain('512')
    expect(within(rows[1]).getAllByText('—').length).toBe(1)
    expect(rows[2].textContent).toContain('17')
    expect(screen.getByText((_, el) => el?.tagName === 'P' && /15.*8/.test(el.textContent || ''))).toBeTruthy()
  })
})

describe('감사 로그', () => {
  it('행·출처 라벨·인자 값 없음 안내, 실패만 필터는 쿼리로', async () => {
    api.auditItems = [
      { at: '2026-11-05T02:48:02Z', user_id: 'u1', user_name: '김하나', action: 'ai_write.executed', tool: 'mail_send', source: 'mcp', client: 'Claude', kind: 'claude_app', result: 'executed', code: null },
      { at: '2026-11-05T02:31:15Z', user_id: 'u2', user_name: '박준호', action: 'ai_tool.call', tool: 'files_read', source: 'ai', client: '내장 AI', kind: 'builtin_web', result: 'failed', code: 'forbidden' },
    ]
    renderAt('/admin/ai-ops/audit')
    expect(await screen.findByText('mail_send')).toBeTruthy()
    expect(screen.getByText('claude.ai · Claude')).toBeTruthy()
    expect(screen.getByText(t('aiOps.audit.src.builtinWeb'))).toBeTruthy()
    expect(screen.getByText('forbidden')).toBeTruthy()
    expect(screen.getByText(t('aiOps.audit.privacy'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('aiOps.audit.failedOnly') }))
    await waitFor(() => expect(callsTo('/api/admin/ai/audit').at(-1)!.opts.query.failed_only).toBe('true'))
    expect(callsTo('/api/admin/ai/audit').at(-1)!.opts.query.days).toBe(30)
  })

  it('결과 없음 — 보관 연수 안내 + 필터 풀기, CSV 내보내기', async () => {
    renderAt('/admin/ai-ops/audit')
    expect(await screen.findByText(t('aiOps.audit.emptyTitle'))).toBeTruthy()
    expect(screen.getByText(t('aiOps.audit.emptyDesc', { n: 2 }))).toBeTruthy()
    const createObjectURL = vi.fn(() => 'blob:x')
    ;(URL as any).createObjectURL = createObjectURL
    ;(URL as any).revokeObjectURL = vi.fn()
    fireEvent.click(screen.getByRole('button', { name: t('aiOps.audit.csv') }))
    await waitFor(() => expect(api.calls.some(c => c.url.startsWith('/api/admin/ai/audit.csv?days=30'))).toBe(true))
  })
})

describe('정책', () => {
  it('바뀐 값만 저장, 되돌리기, 분당 한도 검사', async () => {
    renderAt('/admin/ai-ops/policy')
    const sel = await screen.findByText(t('aiOps.policy.retention'))
    expect(sel).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: t('aiOps.period') })).toBeNull() // 정책엔 기간 없음
    const save = screen.getByRole('button', { name: t('aiOps.policy.save') })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: new RegExp(t('aiOps.policy.localOnly')) }))
    expect((save as HTMLButtonElement).disabled).toBe(false)
    const rate = screen.getByLabelText(t('aiOps.policy.rate')) as HTMLInputElement
    fireEvent.change(rate, { target: { value: '20000' } })
    expect(screen.getByText(t('aiOps.policy.rateInvalid'))).toBeTruthy()
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(rate, { target: { value: '60' } })
    fireEvent.click(save)
    await waitFor(() => expect(callsTo('/api/ai/governance').length).toBe(1))
    expect(callsTo('/api/ai/governance')[0].opts.body).toEqual({ local_only: true, mcp_rate_limit_per_min: 60 })
    expect(screen.getByText(/2026-01-22/)).toBeTruthy()
  })
})

describe('피드백', () => {
  const rows = () => [
    { id: 'f1', at: '2026-11-05T03:41:00Z', rating: 'down', reasons: ['inaccurate'], comment: '끊김은 3회가 아니라 4회', model: null, tools: ['mail_search'], snapshot: 'none', snapshot_expires_at: null, who: 'A' },
    { id: 'f2', at: '2026-11-05T02:20:00Z', rating: 'down', reasons: ['wrong_source'], comment: '인용한 메일이 다른 건', model: null, tools: ['mail_search', 'files_read'], snapshot: 'attached', snapshot_expires_at: null, who: 'B' },
    { id: 'f3', at: '2026-10-02T05:20:00Z', rating: 'down', reasons: ['wrong_source'], comment: '', model: null, tools: [], snapshot: 'expired', snapshot_expires_at: null, who: 'A' },
  ]

  it('통계 카드 + 목록(첨부 안 함 · 대화 보기 · 만료) → 패널 열람 안내 → 삭제 확인 → 삭제됨', async () => {
    api.feedbackItems = rows()
    api.snapshot.f2 = { id: 'f2', at: '2026-11-05T02:20:00Z', reasons: ['wrong_source'], comment: '인용한 메일이 다른 건', model: null, expires_at: null,
      messages: [{ role: 'user', content: '지난주 VPN 장애 보고서 초안 만들어 줘' }, { role: 'assistant', content: '11월 3일 VPN 장애는…' }] }
    renderAt('/admin/ai-ops/feedback')
    expect(await screen.findByText('끊김은 3회가 아니라 4회')).toBeTruthy()
    expect(screen.getByText('1,284')).toBeTruthy() // 좋아요
    expect(screen.getByText(t('aiOps.feedback.notAttached'))).toBeTruthy()
    expect(screen.getByText(t('aiOps.feedback.state.expired'))).toBeTruthy()
    expect(screen.getByText('mail_search · files_read')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('aiOps.feedback.view') }))
    const panel = await screen.findByRole('complementary', { name: t('aiOps.feedback.panelTitle') })
    expect(await within(panel).findByText('지난주 VPN 장애 보고서 초안 만들어 줘')).toBeTruthy()
    expect(within(panel).getByText(t('aiOps.feedback.privacy'))).toBeTruthy()
    expect(within(panel).getByText(t('aiOps.feedback.note', { note: '인용한 메일이 다른 건' }))).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: t('aiOps.feedback.deleteSnapshot') }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText(t('aiOps.feedback.confirmBody'))).toBeTruthy()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: t('aiOps.feedback.confirm') })) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/admin/ai/feedback/f2/snapshot' && c.opts?.method === 'DELETE')).toBe(true))
    expect(await within(panel).findByText(t('aiOps.feedback.goneAdminTitle'))).toBeTruthy()
    expect(screen.getByText(t('aiOps.feedback.state.admin_deleted'))).toBeTruthy()
  })

  it('보관 기간 지남(410) → 만료 상태로 바뀜', async () => {
    api.feedbackItems = rows()
    api.snapshot.f2 = 410
    renderAt('/admin/ai-ops/feedback')
    fireEvent.click(await screen.findByRole('button', { name: t('aiOps.feedback.view') }))
    expect(await screen.findByText(t('aiOps.feedback.goneExpiredTitle'))).toBeTruthy()
    expect(screen.getAllByText(t('aiOps.feedback.state.expired')).length).toBe(2)
  })

  it('대화 첨부만 → 쿼리, 빈 목록 · 실패', async () => {
    renderAt('/admin/ai-ops/feedback')
    expect(await screen.findByText(t('aiOps.feedback.emptyTitle'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('aiOps.feedback.attachedOnly') }))
    await waitFor(() => expect(callsTo('/api/admin/ai/feedback').at(-1)!.opts.query.attached_only).toBe('true'))
    expect(await screen.findByText(t('aiOps.feedback.emptyFilteredTitle'))).toBeTruthy()
  })

  it('불러오기 실패 → 오류 타일', async () => {
    api.feedbackFail = true
    renderAt('/admin/ai-ops/feedback')
    expect(await screen.findByText(t('aiOps.feedback.loadFailed'))).toBeTruthy()
    expect(screen.getByText(/\/api\/admin\/ai\/feedback · 500 · /)).toBeTruthy()
  })

  it('모바일 — 대화 보기는 전체 화면 시트, 열람 안내 고정', async () => {
    isMobileStore.setState({ isMobile: true })
    api.feedbackItems = rows()
    api.snapshot.f2 = { id: 'f2', at: null, reasons: [], comment: '', model: null, expires_at: null, messages: [{ role: 'user', content: '질문' }] }
    renderAt('/admin/ai-ops/feedback')
    fireEvent.click(await screen.findByRole('button', { name: t('aiOps.feedback.view') }))
    const dlg = await screen.findByRole('dialog', { name: t('aiOps.feedback.panelTitle') })
    expect(within(dlg).getByText(t('aiOps.feedback.privacy'))).toBeTruthy()
    expect(await within(dlg).findByText('질문')).toBeTruthy()
  })
})
