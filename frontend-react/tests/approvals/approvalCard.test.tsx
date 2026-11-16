// 채팅 승인 카드: 상태 전이(대기 → 실행 → 되돌리기 · 취소 · 수정 → PATCH → 실행),
// 서버 시각 offset 으로 만료·남은 시간을 계산(클라이언트 시계에만 의존하지 않음), high 는 대기함 링크.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ApprovalRequest } from '~/utils/approvals'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  respond: (_url: string, _opts?: any): any => ({}),
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return api.respond(url, opts) }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { ApprovalCard } = await import('~/components/approvals/ApprovalCard')
const { serverOffset, remainingMs, effectiveStatus, canUndoNow, formatCountdown } = await import('~/utils/approvals')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { i18n } = await import('~/i18n')
const t = (k: string, v?: Record<string, unknown>) => i18n.t(k, v)

const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

function req(over: Partial<ApprovalRequest> = {}, serverAhead = 0): ApprovalRequest {
  const sNow = Date.now() + serverAhead
  return {
    id: 'wr_1', tool: 'notes_create', title: '위키 문서 만들기', risk: 'low', status: 'pending', source: 'ai',
    client_kind: 'builtin_web', client_name: '내장 AI(웹)', target_summary: '랩실 장비', conversation_id: 'c1',
    after_untrusted: false, args: { title: '랩실 장비', content: '본문' },
    preview: [{ field: 'title', label: '제목', before: null, after: '랩실 장비' }],
    editable: [{ field: 'title', label: '제목', type: 'string', enum: null, multiline: false }],
    read_external: null, result: null, error: null, reject_reason: null,
    created_at: iso(sNow), expires_at: iso(sNow + 5 * MIN), decided_at: null, executed_at: null,
    can_undo: false, undo_until: null, server_now: iso(sNow),
    ...over,
  }
}

function renderCard(r: ApprovalRequest, props: Record<string, unknown> = {}) {
  const router = createMemoryRouter([{ path: '*', element: <ApprovalCard request={r} userName="검수" {...props} /> }], { initialEntries: ['/ai'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  api.calls = []
  api.respond = () => ({})
  isMobileStore.setState({ isMobile: false })
})

describe('서버 시각 도우미', () => {
  it('offset = server_now − 클라이언트 시각, 남은 시간은 서버 기준', () => {
    const client = 1_000_000
    const off = serverOffset(iso(client + 120_000), client) // 서버가 2분 앞
    expect(off).toBe(120_000)
    // 만료가 클라이언트 기준 3분 뒤라도 서버 기준으론 1분 뒤
    expect(remainingMs(iso(client + 3 * MIN), off, client)).toBe(MIN)
    expect(formatCountdown(MIN)).toBe('01:00')
    expect(formatCountdown(61 * MIN)).toBe('1:01:00')
  })

  it('pending 이어도 서버 시각으로 만료가 지났으면 expired', () => {
    const client = 5_000_000
    const r = { status: 'pending' as const, expires_at: iso(client + 2 * MIN) }
    expect(effectiveStatus(r, 0, client)).toBe('pending')
    expect(effectiveStatus(r, 3 * MIN, client)).toBe('expired') // 서버가 3분 앞 → 이미 지남
  })

  it('되돌리기는 executed + can_undo + undo_until 전(서버 기준)만', () => {
    const client = 9_000_000
    const r = { status: 'executed' as const, can_undo: true, undo_until: iso(client + MIN) }
    expect(canUndoNow(r, 0, client)).toBe(true)
    expect(canUndoNow(r, 2 * MIN, client)).toBe(false)
    expect(canUndoNow({ ...r, can_undo: false }, 0, client)).toBe(false)
  })
})

describe('승인 카드 — low', () => {
  it('남은 시간은 server_now offset 으로 센다(클라이언트 시계가 2분 늦어도 05:00)', () => {
    // 서버가 클라이언트보다 2분 뒤처짐: expires_at 은 클라이언트 기준 3분 뒤지만 서버 기준으로는 5분 남음
    renderCard(req({}, -2 * MIN))
    const timer = screen.getByRole('timer')
    expect(timer.textContent).toContain('05:00')
  })

  it('서버 시각으로 만료가 지났으면 만료 카드(클라이언트 시계로는 아직 남아 있어도)', () => {
    // 서버가 10분 앞: server_now 기준 만료 5분이 이미 5분 전에 경과 — 클라이언트 시계 기준으로는 아직 미래
    const sNow = Date.now() + 10 * MIN
    renderCard(req({ server_now: iso(sNow), expires_at: iso(Date.now() + 5 * MIN) }))
    expect(screen.getByRole('region', { name: t('approvals.card.expiredLabel', { title: '위키 문서 만들기' }) })).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('approvals.choice.yes') })).toBeNull()
  })

  it('대기 → [실행] → 실행됨 + 되돌리기 카운트다운 → [되돌리기] → 되돌림', async () => {
    const onChange = vi.fn()
    api.respond = (url) => {
      const now = Date.now()
      if (url === '/api/approvals/wr_1/approve') {
        return req({ status: 'executed', executed_at: iso(now), decided_at: iso(now), can_undo: true, undo_until: iso(now + 10 * MIN), editable: [] })
      }
      if (url === '/api/approvals/wr_1/undo') return req({ status: 'undone', can_undo: false, undo_until: null, editable: [] })
      return {}
    }
    renderCard(req(), { onChange })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('approvals.choice.yes') })) })
    expect(api.calls.some(c => c.url === '/api/approvals/wr_1/approve' && c.opts?.method === 'POST')).toBe(true)
    await waitFor(() => expect(screen.getByRole('region', { name: t('approvals.card.executedLabel', { title: '위키 문서 만들기' }) })).toBeTruthy())
    const undoBtn = screen.getByRole('button', { name: t('approvals.card.undoAria', { time: '10:00' }) })
    expect(undoBtn.textContent).toContain('10:00')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'executed' }))
    await act(async () => { fireEvent.click(undoBtn) })
    expect(api.calls.some(c => c.url === '/api/approvals/wr_1/undo' && c.opts?.method === 'POST')).toBe(true)
    await waitFor(() => expect(screen.getByRole('region', { name: t('approvals.card.undoneLabel', { title: '위키 문서 만들기' }) })).toBeTruthy())
  })

  it('실행된 카드에 result 를 주면 요약 대신 그 결과를 카드 안에 보인다(결과 카드 이중 표시 방지)', () => {
    renderCard(req({ status: 'executed', executed_at: iso(Date.now()), editable: [] }), { result: <div data-testid="zip-result">묶음 결과</div> })
    const sections = document.querySelectorAll('section')
    expect(sections).toHaveLength(1)
    expect(sections[0].contains(screen.getByTestId('zip-result'))).toBe(true)
  })

  it('되돌리기 기한이 서버 기준으로 지났으면 버튼을 숨긴다', () => {
    const sNow = Date.now() + 11 * MIN // 서버가 11분 앞 → undo_until(클라이언트 기준 10분 뒤)이 이미 경과
    renderCard(req({ status: 'executed', can_undo: true, executed_at: iso(Date.now()), undo_until: iso(Date.now() + 10 * MIN), server_now: iso(sNow), editable: [] }))
    expect(screen.queryByRole('button', { name: /되돌리기/ })).toBeNull()
  })

  it('[취소] → 취소됨, [다시 제안]은 입력 칸 문장', async () => {
    const onCompose = vi.fn()
    api.respond = (url) => (url === '/api/approvals/wr_1/cancel' ? req({ status: 'canceled', decided_at: iso(Date.now()), editable: [] }) : {})
    renderCard(req(), { onCompose })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('approvals.card.cancel') })) })
    expect(api.calls.some(c => c.url === '/api/approvals/wr_1/cancel' && c.opts?.method === 'POST')).toBe(true)
    await waitFor(() => expect(screen.getByRole('region', { name: t('approvals.card.canceledLabel', { title: '위키 문서 만들기' }) })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: t('approvals.card.repropose') }))
    expect(onCompose).toHaveBeenCalledWith(t('approvals.card.reproposePrompt', { title: '위키 문서 만들기' }))
  })

  it('[수정] → 칸 인라인 편집 → PATCH(전체 인자) → 실행', async () => {
    api.respond = (url, opts) => {
      if (url === '/api/approvals/wr_1' && opts?.method === 'PATCH') return req({ args: opts.body.args, preview: [{ field: 'title', label: '제목', before: null, after: opts.body.args.title }] })
      if (url === '/api/approvals/wr_1/approve') return req({ status: 'executed', args: { title: '새 제목', content: '본문' }, executed_at: iso(Date.now()), editable: [] })
      return {}
    }
    renderCard(req())
    fireEvent.click(screen.getByRole('button', { name: t('approvals.card.edit') }))
    const input = screen.getByLabelText('제목') as HTMLInputElement
    expect(input.value).toBe('랩실 장비')
    fireEvent.change(input, { target: { value: '새 제목' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('approvals.card.saveAndRun') })) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/approvals/wr_1/approve')).toBe(true))
    const patch = api.calls.find(c => c.url === '/api/approvals/wr_1' && c.opts?.method === 'PATCH')
    expect(patch?.opts.body).toEqual({ args: { title: '새 제목', content: '본문' } })
    // PATCH 가 approve 보다 먼저
    expect(api.calls.findIndex(c => c.opts?.method === 'PATCH')).toBeLessThan(api.calls.findIndex(c => c.url.endsWith('/approve')))
    await waitFor(() => expect(screen.getByRole('region', { name: t('approvals.card.executedLabel', { title: '위키 문서 만들기' }) })).toBeTruthy())
  })

  it('편집 칸이 없으면 [수정]은 "대화로 수정"(입력 칸 문장)', () => {
    const onCompose = vi.fn()
    renderCard(req({ editable: [] }), { onCompose })
    fireEvent.click(screen.getByRole('button', { name: t('approvals.card.edit') }))
    expect(onCompose).toHaveBeenCalledWith(expect.stringContaining('위키 문서 만들기'))
    expect(api.calls.length).toBe(0)
  })

  it('이미 처리된 요청(409)이면 서버 상태로 맞춘다', async () => {
    api.respond = (url) => {
      if (url === '/api/approvals/wr_1/approve') throw Object.assign(new Error('conflict'), { statusCode: 409, data: { detail: '이미 처리된 요청입니다(canceled)' } })
      if (url === '/api/approvals/wr_1') return req({ status: 'canceled', editable: [] })
      return {}
    }
    renderCard(req())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('approvals.choice.yes') })) })
    await waitFor(() => expect(screen.getByRole('region', { name: t('approvals.card.canceledLabel', { title: '위키 문서 만들기' }) })).toBeTruthy())
  })
})

describe('승인 카드 — high', () => {
  it('내장 AI 의 high 도 채팅 카드에서 선택지로 결정(대기함 링크 함께)', () => {
    renderCard(req({ id: 'wr_h', risk: 'high', expires_at: iso(Date.now() + 30 * MIN), editable: [] }))
    expect(screen.getByRole('button', { name: t('approvals.choice.yes') })).toBeTruthy()
    expect(screen.getByRole('link', { name: t('approvals.card.openInbox') }).getAttribute('href')).toBe('/approvals?id=wr_h')
    expect(document.body.textContent).toContain(t('approvals.choice.alwaysHighHint'))
  })

  it('외부 커넥터(MCP) high — 승인 대기함으로 보냄 + /approvals?id= 링크, 실행 단추 없음', () => {
    renderCard(req({ id: 'wr_h', risk: 'high', source: 'mcp', expires_at: iso(Date.now() + 30 * MIN), editable: [] }))
    expect(screen.getByText(t('approvals.card.sentToInbox'))).toBeTruthy()
    const link = screen.getByRole('link', { name: t('approvals.card.openInbox') })
    expect(link.getAttribute('href')).toBe('/approvals?id=wr_h')
    expect(screen.queryByRole('button', { name: t('approvals.choice.yes') })).toBeNull()
    expect(document.body.textContent).toContain('30:00')
  })

  it('거부된 high — 사유와 [사유 반영해 다시]', () => {
    const onCompose = vi.fn()
    renderCard(req({ risk: 'high', status: 'rejected', reject_reason: '외부 수신자 빼고 다시', decided_at: iso(Date.now()), editable: [] }), { onCompose })
    expect(document.body.textContent).toContain('외부 수신자 빼고 다시')
    fireEvent.click(screen.getByRole('button', { name: t('approvals.card.retryWithReason') }))
    expect(onCompose).toHaveBeenCalledWith(expect.stringContaining('외부 수신자 빼고 다시'))
  })
})

describe('승인 카드 — 모바일', () => {
  it('390: 선택지 4개가 한 줄씩(전체 폭)', () => {
    isMobileStore.setState({ isMobile: true })
    renderCard(req())
    const yes = screen.getByRole('button', { name: t('approvals.choice.yes') })
    expect(yes.className).toContain('w-full')
    expect(screen.getAllByRole('button').filter(b => b.getAttribute('aria-keyshortcuts')?.match(/^[1-4]$/))).toHaveLength(4)
  })
})

describe('승인 카드 — Claude Code 선택지', () => {
  it('2 = 이 대화에서 다시 묻지 않기(remember=conversation), 3 = 항상 허용(remember=always)', async () => {
    api.respond = () => req({ status: 'executed', executed_at: iso(Date.now()), editable: [] })
    renderCard(req())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('approvals.choice.yesConversation', { title: '위키 문서 만들기' }) })) })
    expect(api.calls.find(c => c.url === '/api/approvals/wr_1/approve')?.opts?.body).toEqual({ remember: 'conversation' })
  })

  it('숫자 키 3 → 항상 허용', async () => {
    api.respond = () => req({ status: 'executed', executed_at: iso(Date.now()), editable: [] })
    renderCard(req())
    const region = screen.getByRole('region', { name: t('approvals.card.label', { title: '위키 문서 만들기' }) })
    await act(async () => { fireEvent.keyDown(region, { key: '3' }) })
    expect(api.calls.find(c => c.url === '/api/approvals/wr_1/approve')?.opts?.body).toEqual({ remember: 'always' })
  })

  it('4 = 아니요, 대신 이렇게 → 사유를 거절 사유로 보낸다(모델이 다시 계획)', async () => {
    api.respond = () => req({ status: 'rejected', reject_reason: '제목을 바꿔서', decided_at: iso(Date.now()), editable: [] })
    renderCard(req())
    fireEvent.click(screen.getByRole('button', { name: t('approvals.choice.instead') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('approvals.choice.instead') }), { target: { value: '제목을 바꿔서' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('approvals.choice.sendInstead') })) })
    expect(api.calls.find(c => c.url === '/api/approvals/wr_1/reject')?.opts?.body).toEqual({ reason: '제목을 바꿔서' })
  })

  it('Esc → 취소', async () => {
    api.respond = () => req({ status: 'canceled', editable: [] })
    renderCard(req())
    const region = screen.getByRole('region', { name: t('approvals.card.label', { title: '위키 문서 만들기' }) })
    await act(async () => { fireEvent.keyDown(region, { key: 'Escape' }) })
    expect(api.calls.some(c => c.url === '/api/approvals/wr_1/cancel')).toBe(true)
  })
})
