// AI 화면(pages/ai.tsx) 핵심 동작: 상태 → 대화 목록 → 첫 대화 자동 선택(데스크톱), SSE 스트리밍(조각난 이벤트·도구 칩·완료 후 목록 재조회),
// 모바일은 목록부터(자동 선택 없음). $fetch 와 fetch(스트림)는 가짜.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  conversations: [] as any[],
  messages: {} as Record<string, any[]>,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    if (url === '/api/ai/status') {
      return { module_enabled: true, configured: true, provider_kind: 'compatible', model: 'test-model', external: false, is_admin: false, allow_user_keys: false, external_allow_data: false, needs_consent: false, tools: ['mail_search', 'files_read'] }
    }
    if (url === '/api/ai/conversations' && (!opts?.method || opts.method === 'GET')) return { conversations: api.conversations }
    const m = url.match(/^\/api\/ai\/conversations\/([^/]+)\/messages$/)
    if (m) return { messages: api.messages[m[1]] || [] }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: AiPage } = await import('~/pages/ai')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')

function renderPage() {
  const router = createMemoryRouter([{ path: '*', element: <AiPage /> }], { initialEntries: ['/ai'] })
  return render(<RouterProvider router={router} />)
}

/** 주어진 조각들을 차례로 내보내는 SSE 응답 */
function sseResponse(chunks: string[]) {
  const enc = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i < chunks.length) ctl.enqueue(enc.encode(chunks[i++]))
      else ctl.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

beforeEach(() => {
  api.calls = []
  api.conversations = [{ id: 'c1', title: '첫 대화', tools_enabled: true, updated_at: new Date().toISOString(), preview: '안녕' }]
  api.messages = { c1: [] }
  isMobileStore.setState({ isMobile: false })
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null })
  try { localStorage.removeItem('ai-sidebar-collapsed') } catch { /* */ }
})

describe('AI 화면', () => {
  it('데스크톱: 첫 대화를 자동으로 열고 빈 대화 추천을 보인다', async () => {
    renderPage()
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/c1/messages')).toBe(true))
    expect(await screen.findByRole('complementary')).toBeTruthy()
    expect(screen.getAllByText('첫 대화').length).toBeGreaterThan(0)
    // 도구 켜진 대화 → 머리의 도구 수 = 묶음 2개
    const toolsBtn = screen.getByText((_, el) => el?.tagName === 'BUTTON' && /\s2$/.test(el.textContent || '') && !!el.querySelector('.font-mono'))
    expect(toolsBtn).toBeTruthy()
  })

  it('보내기: 조각난 SSE 를 이어 붙여 그리고, 도구 칩·완료 후 목록 재조회', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'event: tool_call\ndata: {"name":"mail_search"}\n\n',
      'event: tool_result\ndata: {"name":"mail_search","ok":true}\n\nevent: tok',
      'en\ndata: {"text":"안녕"}\n\n',
      'event: token\ndata: {"text":"하세요"}\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/c1/messages')).toBe(true))

    const ta = await waitFor(() => { const el = document.querySelector('textarea'); if (!el) throw new Error('no textarea'); return el })
    fireEvent.change(ta, { target: { value: '테스트' } })
    const listCallsBefore = api.calls.filter(c => c.url === '/api/ai/conversations').length
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })

    await waitFor(() => expect(screen.getByText('테스트')).toBeTruthy())
    await waitFor(() => expect(document.querySelector('.ai-md')?.textContent).toContain('안녕하세요'), { timeout: 3000 })
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/conversations/c1/chat', expect.objectContaining({ method: 'POST', body: JSON.stringify({ content: '테스트' }) }))
    // 완료 후 대화 목록 다시 받음
    await waitFor(() => expect(api.calls.filter(c => c.url === '/api/ai/conversations').length).toBeGreaterThan(listCallsBefore))
    // 도구 칩(완료) — 이름표 또는 식별자
    expect(document.body.textContent).toMatch(/mail_search|메일/)
    // 입력은 비워짐
    expect((ta as HTMLTextAreaElement).value).toBe('')
    vi.unstubAllGlobals()
  })

  it('오류 응답은 경고 띠(role=alert)로', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: '한도 초과' }), { status: 429 })))
    renderPage()
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/c1/messages')).toBe(true))
    const ta = await waitFor(() => { const el = document.querySelector('textarea'); if (!el) throw new Error('no textarea'); return el })
    fireEvent.change(ta, { target: { value: '질문' } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('한도 초과')
    vi.unstubAllGlobals()
  })

  it('모바일: 목록부터(자동 선택 없음), 행을 누르면 대화', async () => {
    isMobileStore.setState({ isMobile: true })
    renderPage()
    const row = await screen.findByText('첫 대화')
    expect(api.calls.some(c => c.url.endsWith('/messages'))).toBe(false)
    expect(screen.getByText('안녕')).toBeTruthy()
    await act(async () => { fireEvent.click(row) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/c1/messages')).toBe(true))
    expect(await waitFor(() => { const el = document.querySelector('textarea'); if (!el) throw new Error('no textarea'); return el })).toBeTruthy()
  })

  it('write_request 이벤트 → 채팅 승인 카드([실행]) + AI 생성 표시', async () => {
    const now = new Date()
    const wr = {
      id: 'wr_x', tool: 'notes_create', title: '위키 문서 만들기', risk: 'low', status: 'pending', source: 'ai',
      client_kind: 'builtin_web', client_name: '내장 AI(웹)', target_summary: '랩실 장비', conversation_id: 'c1',
      args: { title: '랩실 장비' }, preview: [{ field: 'title', label: '제목', before: null, after: '랩실 장비' }], editable: [],
      read_external: null, created_at: now.toISOString(), expires_at: new Date(now.getTime() + 300_000).toISOString(),
      server_now: now.toISOString(), can_undo: false, undo_until: null,
    }
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'event: tool_call\ndata: {"name":"notes_create"}\n\n',
      `event: write_request\ndata: ${JSON.stringify(wr)}\n\n`,
      'event: tool_result\ndata: {"name":"notes_create","ok":false,"pending_confirmation":true}\n\n',
      'event: token\ndata: {"text":"아래 카드에서 실행하세요."}\n\n',
    ])))
    renderPage()
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/c1/messages')).toBe(true))
    const ta = await waitFor(() => { const el = document.querySelector('textarea'); if (!el) throw new Error('no textarea'); return el })
    fireEvent.change(ta, { target: { value: '위키 만들어 줘' } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
    const card = await screen.findByRole('region', { name: '쓰기 요청 — 위키 문서 만들기' })
    expect(card.textContent).toContain('랩실 장비')
    expect(screen.getByRole('button', { name: '예' })).toBeTruthy()
    await waitFor(() => expect(document.body.textContent).toContain('AI 생성 · test-model · 내용을 확인한 뒤 쓰세요'))
    vi.unstubAllGlobals()
  })
})
