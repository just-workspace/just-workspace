// 화면 안 AI: 버튼 상태(숨김·비활성+이유·활성) · 메일 요약(요점·할 일 → 고른 n개 등록 → 되돌리기) ·
// 답장 초안(말투·편집기로 옮기기 → 작성 창에 aiDraft) · 채팅 요약(안 읽은 것 많을 때만, 첫 안읽음부터 범위) ·
// 회의 할 일(붙잡아 둔 회의 채팅 · 담당자 있는 것만 처음 체크 · 등록에 room·assignee).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ReactNode } from 'react'

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

const { AiInlineButton } = await import('~/components/aiInline/AiInlineParts')
const { MailAiSummary, MailAiDraft, _clearMailAiCache } = await import('~/components/mail/MailAiPanels')
const { ChatAiSummary, MIN_UNREAD, requestChatAiSummary } = await import('~/components/chat/ChatAiSummary')
const { MeetingAiTodos, _setLastMeetingChat } = await import('~/components/meetings/MeetingAiTodos')
const { _setAiInlineStatus } = await import('~/composables/useAiInline')
const { authStore } = await import('~/composables/useAuth')
const { shortDue, inlineError, hhmm } = await import('~/utils/aiInline')
const { mailComposeStore, openCompose, takeAiDraft, _resetMailComposeStore } = await import('~/composables/useMailCompose')
const { isMobileStore } = await import('~/composables/useIsMobile')

const READY = { available: true, reason: null, external: true, mask_pii: true, model: 'claude-opus-5-5', is_admin: false } as const
const META = { model: 'claude-opus-5-5', ai_generated: true, external: true, masked: true }

function wrap(node: ReactNode) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: ['/x'] })
  return render(<RouterProvider router={router} />)
}
const posts = (path: string) => api.calls.filter(c => c.url === path)

beforeEach(() => {
  api.calls = []
  api.respond = () => ({})
  _clearMailAiCache()
  // 사용자가 바뀌면 상태를 비우므로 사용자 먼저
  authStore.setState({ user: { id: 'me', username: 'hana', display_name: '김하나' } as any })
  _setAiInlineStatus({ ...READY })
  isMobileStore.setState({ isMobile: false })
})

describe('도우미', () => {
  it('기한 짧게 · 오류 꺼내기 · 시각', () => {
    expect(shortDue('2026-11-07', 'ko')).toMatch(/^11-07\(.+\)$/)
    expect(shortDue('금요일')).toBe('금요일')
    expect(inlineError({ data: { detail: { code: 'external_blocked', message: '막힘' } } }, 'x')).toEqual({ code: 'external_blocked', message: '막힘' })
    expect(inlineError({ data: { detail: '문자열' } }, 'x').message).toBe('문자열')
    expect(inlineError(new Error('net'), '기본').code).toBe('network')
    expect(hhmm('nope')).toBe('')
  })
})

describe('버튼 상태', () => {
  it('상태 없음·모듈 꺼짐은 숨기고, 미설정·외부 차단은 비활성 + 이유, 쓸 수 있으면 활성', () => {
    const { rerender, container } = render(<AiInlineButton status={null}>요약</AiInlineButton>)
    expect(container.textContent).toBe('')
    rerender(<AiInlineButton status={{ ...READY, available: false, reason: 'module_off' }}>요약</AiInlineButton>)
    expect(container.textContent).toBe('')
    rerender(<AiInlineButton status={{ ...READY, available: false, reason: 'external_blocked' }}>요약</AiInlineButton>)
    const b = screen.getByRole('button', { name: '요약' })
    expect((b as HTMLButtonElement).disabled).toBe(true)
    expect(b.getAttribute('title')).toContain('외부 AI')
    rerender(<AiInlineButton status={{ ...READY }}>요약</AiInlineButton>)
    expect((screen.getByRole('button', { name: '요약' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('메일 요약', () => {
  it('요점·할 일 — 기한 있는 것만 처음 체크, 고른 n개 등록 → 되돌리기', async () => {
    api.respond = (url) => {
      if (url === '/api/ai/inline/mail_summary') {
        return { ...META, points: ['랙 2대 증설'], todos: [
          { title: '분전반 여유 용량 회신', due: '2026-11-07', who: '박준호에게' },
          { title: '타일 교체 여부 확인', due: null, who: null },
        ] }
      }
      if (url === '/api/ai/inline/tasks') return { created: 1, results: [{ ok: true, title: '분전반 여유 용량 회신', request_id: 'wr_1', task_id: 't1', can_undo: true }] }
      return {}
    }
    wrap(<MailAiSummary mail={{ id: '42', mailboxId: 'INBOX', accountId: null }} status={{ ...READY }} onClose={() => {}} />)
    expect(await screen.findByText('랙 2대 증설')).toBeTruthy()
    expect(screen.getByText(/가려서 보냅니다/)).toBeTruthy()
    expect(screen.getByText(/박준호에게/).textContent).toMatch(/기한 11-07/)
    expect(screen.getByText('기한 없음')).toBeTruthy()
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map(b => b.checked)).toEqual([true, false])
    expect(screen.getByText(/원문과 다를 수 있습니다/).textContent).toContain('claude-opus-5-5')
    expect(posts('/api/ai/inline/mail_summary')[0].opts.body).toMatchObject({ message_id: '42', mailbox_id: 'INBOX' })

    // 숫자는 mono 조각(UiTrans 슬롯)이라 글자로 찾아 버튼을 누른다
    fireEvent.click(screen.getAllByRole('button').find(b => b.textContent === '고른 1개 할일에 등록')!)
    await screen.findByText('1개를 할일에 등록했습니다')
    const body = posts('/api/ai/inline/tasks')[0].opts.body
    expect(body.source).toBe('mail')
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ title: '분전반 여유 용량 회신', due_date: '2026-11-07' })
    expect(body.items[0].idempotency_key).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }))
    await waitFor(() => expect(posts('/api/approvals/wr_1/undo')).toHaveLength(1))
  })

  it('오류면 메시지 + 다시 시도', async () => {
    let n = 0
    api.respond = (url) => {
      if (url === '/api/ai/inline/mail_summary') {
        n++
        if (n === 1) throw Object.assign(new Error('x'), { data: { detail: { code: 'timeout', message: 'AI 응답이 너무 늦습니다' } } })
        return { ...META, points: ['둘째'], todos: [] }
      }
      return {}
    }
    wrap(<MailAiSummary mail={{ id: '7', mailboxId: null, accountId: null }} status={{ ...READY }} onClose={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toContain('AI 응답이 너무 늦습니다')
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByText('둘째')).toBeTruthy()
    expect(screen.getByText('이 메일에서 내가 할 일은 없습니다')).toBeTruthy()
  })
})

describe('답장 초안', () => {
  it('말투 바꾸면 다시 쓰고, 편집기로 옮기기 = 초안 넘김', async () => {
    api.respond = (url, opts) => (url === '/api/ai/inline/mail_reply'
      ? { ...META, tone: opts.body.tone, draft: opts.body.tone === 'short' ? '짧은 초안' : '정중한 초안\n\n김하나 드림' }
      : {})
    const onUse = vi.fn()
    render(<MailAiDraft mail={{ id: '42', mailboxId: 'INBOX', accountId: null }} onClose={() => {}} onUse={onUse} />)
    expect(await screen.findByText(/정중한 초안/)).toBeTruthy()
    expect(screen.getByText(/아직 아무것도 보내지 않았습니다/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '짧게' }))
    expect(await screen.findByText('짧은 초안')).toBeTruthy()
    expect(posts('/api/ai/inline/mail_reply').map(c => c.opts.body.tone)).toEqual(['polite', 'short'])
    fireEvent.click(screen.getByRole('button', { name: '편집기로 옮기기' }))
    expect(onUse).toHaveBeenCalledWith('짧은 초안')
  })

  it('작성 창: AI 초안은 새 창으로(쓰던 답장 창을 덮지 않음), 모바일은 맡겨 두고 한 번 꺼냄', () => {
    _resetMailComposeStore()
    const msg = { id: 'm1', subject: '랙' } as any
    openCompose('reply', msg)
    openCompose('reply', msg, null, { aiDraft: '초안' })
    const ws = mailComposeStore.getState().windows
    expect(ws).toHaveLength(2)
    expect(ws[1].aiDraft).toBe('초안')
    isMobileStore.setState({ isMobile: true })
    openCompose('reply', msg, null, { aiDraft: '모바일 초안' })
    expect(takeAiDraft('m1')).toBe('모바일 초안')
    expect(takeAiDraft('m1')).toBeUndefined()
  })
})

describe('채팅방 요약', () => {
  it('안 읽은 것이 적으면 아무것도, 많으면 접힌 버튼 → 첫 안읽음부터 요약', async () => {
    api.respond = (url) => (url === '/api/ai/inline/chat_summary'
      ? {
          ...META, points: ['재협상 주기 변경 완료 — 이서연'],
          called_me: [{ message_id: 'm9', text: '분전반 용량 회신 요청', at: '2026-11-05T01:31:00Z' }],
          scope: 'range', count: 48, from_at: '2026-11-05T00:02:00Z', to_at: '2026-11-05T01:44:00Z', from_message_id: 'm1', to_message_id: 'm48',
        }
      : {})
    const { rerender, container } = render(<ChatAiSummary channelId="ops" firstUnreadId="m1" unreadCount={MIN_UNREAD - 1} />)
    expect(container.textContent).toBe('')
    rerender(<ChatAiSummary channelId="ops" firstUnreadId="m1" unreadCount={48} />)
    fireEvent.click(screen.getAllByRole('button').find(b => b.textContent === '읽지 않은 48개 요약')!)
    expect(await screen.findByText('재협상 주기 변경 완료 — 이서연')).toBeTruthy()
    expect(screen.getByText('나를 부름')).toBeTruthy()
    expect(screen.getByRole('button', { name: '나를 부른 메시지로' })).toBeTruthy()
    expect(posts('/api/ai/inline/chat_summary')[0].opts.body).toMatchObject({ channel_id: 'ops', scope: 'range', from_message_id: 'm1' })
    fireEvent.click(screen.getByRole('button', { name: '요약 닫기' }))
    expect(container.textContent).toBe('')
  })

  it('메시지 ⋯ "여기부터 요약" 요청을 받는다', async () => {
    api.respond = () => ({ ...META, points: ['범위 요약'], called_me: [], scope: 'range', count: 3, from_at: null, to_at: null, from_message_id: 'm5', to_message_id: 'm7' })
    render(<ChatAiSummary channelId="ops" firstUnreadId={null} unreadCount={0} />)
    act(() => requestChatAiSummary('ops', 'm5'))
    expect(await screen.findByText('범위 요약')).toBeTruthy()
    expect(posts('/api/ai/inline/chat_summary')[0].opts.body.from_message_id).toBe('m5')
    expect(screen.getByRole('region', { name: '채팅방 요약' }).textContent).toMatch(/고른 3개 요약/)
  })
})

describe('회의 요약 → 할 일', () => {
  it('붙잡아 둔 회의 채팅으로 요약, 담당자 있는 것만 처음 체크, 등록에 room·assignee', async () => {
    _setLastMeetingChat('infra', [{ name: '박준호', text: '팬 교체 필요' }])
    api.respond = (url) => {
      if (url === '/api/ai/inline/meeting_summary') {
        return {
          ...META, title: '인프라 정기점검', points: ['팬 경고 1건'], participants: 4, source: 'chat', started_at: null, ended_at: null,
          todos: [
            { title: '팬 부품 견적', due: '2026-11-10', note: null, assignee_id: 'u-park', assignee_name: '박준호' },
            { title: '펌웨어 노트 확인', due: null, note: '다음 점검 전', assignee_id: null, assignee_name: null },
          ],
        }
      }
      if (url === '/api/ai/inline/tasks') return { created: 1, results: [{ ok: true, title: '팬 부품 견적', request_id: 'wr_2', task_id: 't2', can_undo: true }] }
      return {}
    }
    wrap(<MeetingAiTodos room="infra" title="인프라 정기점검" timeRange="10:00–10:52" />)
    expect(screen.getByText('회의가 끝났습니다 — 인프라 정기점검')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '요약·할 일 뽑기' }))
    expect(await screen.findByText('팬 경고 1건')).toBeTruthy()
    expect(posts('/api/ai/inline/meeting_summary')[0].opts.body.chat_lines).toEqual([{ name: '박준호', text: '팬 교체 필요' }])
    expect(screen.getByText('요약 · 참석 4명 · 회의 채팅 기준')).toBeTruthy()
    expect(screen.getByText(/박준호 · 11-10.* · 배정 알림/)).toBeTruthy()
    expect(screen.getByText('담당 미정 · 다음 점검 전')).toBeTruthy()
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map(b => b.checked)).toEqual([true, false])
    fireEvent.click(screen.getByRole('button', { name: '할일에 1개 등록' }))
    await screen.findByText('1개를 할일에 등록했습니다')
    const body = posts('/api/ai/inline/tasks')[0].opts.body
    expect(body).toMatchObject({ source: 'meeting', room: 'infra' })
    expect(body.items[0]).toMatchObject({ title: '팬 부품 견적', assignee_id: 'u-park', due_date: '2026-11-10' })
  })

  it('AI 모듈이 꺼져 있으면 카드 없음', () => {
    _setAiInlineStatus({ ...READY, available: false, reason: 'module_off' })
    const { container } = wrap(<MeetingAiTodos room="infra" title="x" />)
    expect(container.textContent).toBe('')
  })
})
