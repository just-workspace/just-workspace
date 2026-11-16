// 내장 AI 화면 감사 수정 회귀 — 1(저장 전 실패한 질문의 "다시 시도") · 2(답변 종료 시 다른 대화로 전환되는 문제)
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
    const method = opts?.method || 'GET'
    if (url === '/api/ai/status') {
      return { module_enabled: true, configured: true, provider_kind: 'compatible', model: 'test-model', external: false, is_admin: false, allow_user_keys: false, external_allow_data: false, needs_consent: false, tools: [], vision: false, attachment_max_bytes: 30 * 1024 * 1024 }
    }
    if (url === '/api/ai/conversations' && method === 'GET') return { conversations: api.conversations, temporary: [] }
    if (url === '/api/ai/projects') return { projects: [] }
    const m = url.match(/^\/api\/ai\/conversations\/([^/]+)\/messages$/)
    if (m) return { messages: api.messages[m[1]] || [] }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch, apiRawFetch: vi.fn(async () => new Response(null, { status: 204 })) }
})

const { default: AiPage } = await import('~/pages/ai')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')
const { resetAiStreams } = await import('~/composables/useAiStreams')

function renderPage() {
  const router = createMemoryRouter([{ path: '*', element: <AiPage /> }], { initialEntries: ['/ai'] })
  return render(<RouterProvider router={router} />)
}
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
function liveResponse() {
  const enc = new TextEncoder()
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  return { res: new Response(body, { status: 200 }), push: (s: string) => ctl.enqueue(enc.encode(s)), end: () => ctl.close() }
}
const T0 = '2026-11-05T01:00:00.000Z'
const msgCalls = (id: string) => api.calls.filter(c => c.url === `/api/ai/conversations/${id}/messages`).length
const listCalls = () => api.calls.filter(c => c.url === '/api/ai/conversations' && (c.opts?.method || 'GET') === 'GET').length

beforeEach(() => {
  resetAiStreams()
  api.calls = []
  api.conversations = [
    { id: 'c1', title: '첫 대화', tools_enabled: false, updated_at: new Date().toISOString(), project_id: null },
    { id: 'c2', title: '둘째 대화', tools_enabled: false, updated_at: T0, project_id: null },
  ]
  api.messages = {
    c1: [
      { id: 'q1', role: 'user', content: '첫 질문', created_at: T0, versions: [{ id: 'q1' }], active_version: 1, attachments: [] },
      { id: 'a1', role: 'assistant', content: '첫 답', created_at: T0, status: 'complete', model: 'm' },
    ],
    c2: [],
  }
  isMobileStore.setState({ isMobile: false })
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null })
  try { localStorage.removeItem('ai-sidebar-collapsed') } catch { /* */ }
  window.history.replaceState({}, '', '/ai')
  vi.unstubAllGlobals()
})

async function ask(text: string) {
  const ta = screen.getByRole('textbox', { name: '메시지' }) as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: text } })
  fireEvent.keyDown(ta, { key: 'Enter' })
}

describe('저장 전에 실패한 질문(1)', () => {
  it('"다시 시도"는 /regenerate(이전 답변을 지움)가 아니라 같은 질문을 /chat 으로 다시 보낸다', async () => {
    const urls: string[] = []
    const bodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string, o: any) => {
      urls.push(u); bodies.push(o?.body ? JSON.parse(o.body) : null)
      // 한도 초과 — 서버는 질문 저장 전에 거부함
      return new Response(JSON.stringify({ detail: '오늘 AI 요청 한도(2회)를 다 썼습니다' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
    }))
    renderPage()
    await screen.findByText('첫 답')
    await ask('둘째 질문')
    await screen.findByText(/한도\(2회\)/)
    expect(urls).toEqual(['/api/ai/conversations/c1/chat'])
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(urls.length).toBe(2))
    expect(urls[1]).toBe('/api/ai/conversations/c1/chat')
    expect(bodies[1]).toEqual({ content: '둘째 질문' })
    expect(urls.some(u => u.includes('/regenerate'))).toBe(false)
    expect(screen.getByText('첫 답')).toBeTruthy()                 // 이전 답변은 유지
    expect(screen.getAllByText('둘째 질문').length).toBe(1)          // 질문이 중복 누적되지 않음
  })

  it('서버에 저장된 질문이면(답만 실패) 예전처럼 /regenerate', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u)
      return new Response(JSON.stringify({ detail: '제공자 오류' }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }))
    renderPage()
    await screen.findByText('첫 답')
    await ask('둘째 질문')
    await screen.findByText('제공자 오류')
    // 그 사이 서버에는 질문이 저장된 상태(meta 만 미수신)
    api.messages.c1 = [...api.messages.c1, { id: 'q2', role: 'user', content: '둘째 질문', created_at: T0, versions: [{ id: 'q2' }], active_version: 1, attachments: [] }]
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(urls.length).toBe(2))
    expect(urls[1]).toBe('/api/ai/conversations/c1/regenerate')
  })
})

describe('답변이 끝날 때 화면이 바뀌지 않는다(2)', () => {
  it('새 대화 화면에서 입력 중 — 다른 대화의 답변이 끝나도 첫 대화로 끌려가지 않는다', async () => {
    let live!: ReturnType<typeof liveResponse>
    vi.stubGlobal('fetch', vi.fn(async () => { live = liveResponse(); return live.res }))
    renderPage()
    await screen.findByText('첫 답')
    await ask('둘째 질문')
    await waitFor(() => expect(live).toBeTruthy())
    live.push(ev('meta', { message_id: 'a2', parent_id: 'q2' }))
    fireEvent.click(screen.getByRole('button', { name: '새 대화' }))
    await waitFor(() => expect(screen.queryByText('첫 답')).toBeNull())
    const before = { msgs: msgCalls('c1'), lists: listCalls() }
    await act(async () => { live.push(ev('token', { text: '끝' }) + ev('done', { message_id: 'a2', status: 'complete' })); live.end() })
    await waitFor(() => expect(listCalls()).toBe(before.lists + 1))   // 목록은 재조회(제목·순서)
    await new Promise(r => setTimeout(r, 30))
    expect(msgCalls('c1')).toBe(before.msgs)                           // 대화를 다시 열지는 않음
    expect(screen.queryByText('첫 답')).toBeNull()
  })

  it('주소의 ?c= 는 들어올 때 한 번만 — 다른 대화에서 답변이 끝나도 그 대화로 돌아가지 않는다', async () => {
    window.history.replaceState({}, '', '/ai?c=c2')
    let live!: ReturnType<typeof liveResponse>
    vi.stubGlobal('fetch', vi.fn(async () => { live = liveResponse(); return live.res }))
    renderPage()
    await waitFor(() => expect(msgCalls('c2')).toBe(1))              // ?c=c2 로 열림
    fireEvent.click(screen.getByRole('button', { name: '첫 대화' }))
    await screen.findByText('첫 답')
    await ask('둘째 질문')
    await waitFor(() => expect(live).toBeTruthy())
    const lists = listCalls()
    await act(async () => { live.push(ev('meta', { message_id: 'a2', parent_id: 'q2' }) + ev('token', { text: '끝' }) + ev('done', { message_id: 'a2', status: 'complete' })); live.end() })
    await waitFor(() => expect(listCalls()).toBe(lists + 1))
    await new Promise(r => setTimeout(r, 30))
    expect(msgCalls('c2')).toBe(1)
    expect(screen.getByText('첫 답')).toBeTruthy()
  })
})
