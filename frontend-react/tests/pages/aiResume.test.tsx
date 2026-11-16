// AI 화면 — 답변 생성은 페이지와 무관: 화면을 떠나도(언마운트) 중단하지 않고, 다시 열면 생성 중인 답변을 이어서 수신한다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
      return { module_enabled: true, configured: true, provider_kind: 'compatible', model: 'test-model', external: false, is_admin: false, allow_user_keys: false, external_allow_data: false, needs_consent: false, tools: [] }
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
const S = await import('~/composables/useAiStreams')
const { toastStore } = await import('~/composables/useToast')

function renderPage() {
  const router = createMemoryRouter([{ path: '*', element: <AiPage /> }], { initialEntries: ['/ai'] })
  return render(<RouterProvider router={router} />)
}
const ev = (name: string, data: unknown, id: string) => `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`
function liveResponse(signal?: AbortSignal) {
  const enc = new TextEncoder()
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  signal?.addEventListener('abort', () => { try { ctl.error(new DOMException('aborted', 'AbortError')) } catch { /* 닫힘 */ } })
  return { res: new Response(body, { status: 200 }), push: (s: string) => ctl.enqueue(enc.encode(s)), end: () => ctl.close() }
}

beforeEach(() => {
  S.resetAiStreams()
  toastStore.setState({ toasts: [] })
  api.calls = []
  api.conversations = [{ id: 'c1', title: '첫 대화', tools_enabled: false, updated_at: new Date().toISOString(), preview: '안녕' }]
  api.messages = { c1: [] }
  isMobileStore.setState({ isMobile: false })
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('AI 이어 받기', () => {
  it('화면을 떠나도 끊지 않고, 돌아오면 받은 내용이 이어 보이며 끝나면 토스트', async () => {
    let live!: ReturnType<typeof liveResponse>
    let signal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn(async (_u: string, o: any) => { signal = o.signal; live = liveResponse(o.signal); return live.res }))
    const view = renderPage()
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/c1/messages')).toBe(true))
    const ta = document.querySelector('textarea')!
    fireEvent.change(ta, { target: { value: '길게' } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
    await waitFor(() => expect(live).toBeTruthy())
    await act(async () => {
      live.push(ev('meta', { message_id: 'm1', model: 'test-model', ai_generated: true }, '1-0'))
      live.push(ev('token', { text: '앞부분' }, '2-0'))
    })
    await waitFor(() => expect(document.querySelector('.ai-md')?.textContent).toContain('앞부분'))
    view.unmount() // 다른 화면으로 이동
    expect(signal.aborted).toBe(false)
    live.push(ev('token', { text: ' 뒷부분' }, '3-0'))
    await waitFor(() => expect(Object.values(S.aiStreamStore.getState().runs)[0]?.msg.content).toBe('앞부분 뒷부분'))
    // 복귀 — 서버는 아직 streaming(진행분이 비어 있을 수 있음) → 저장소의 최신 내용 사용
    api.messages = { c1: [{ id: 'q1', role: 'user', content: '길게' }, { id: 'm1', role: 'assistant', content: '앞', status: 'streaming', steps: [], citations: [] }] }
    renderPage()
    await waitFor(() => expect(document.querySelector('.ai-md')?.textContent).toContain('앞부분 뒷부분'))
    expect(screen.getAllByRole('button', { name: '멈추기' }).length).toBeGreaterThan(0)
    // 다른 화면에 있는 동안 종료되면 토스트(현재는 열람 중이므로 없음)
    await act(async () => {
      live.push(ev('done', { message_id: 'm1', status: 'complete' }, '4-0'))
      live.end()
    })
    await waitFor(() => expect(Object.keys(S.aiStreamStore.getState().runs).length).toBe(0))
    expect(toastStore.getState().toasts.filter(t => t.message === 'AI 답변이 완료됐습니다').length).toBe(0)
  })

  it('새로고침 뒤 대화를 열면 생성 중인 답변을 처음부터 재연결', async () => {
    let live!: ReturnType<typeof liveResponse>
    const fetchMock = vi.fn(async (_u: string, o: any) => { live = liveResponse(o.signal); return live.res })
    vi.stubGlobal('fetch', fetchMock)
    api.messages = { c1: [{ id: 'q1', role: 'user', content: '질문' }, { id: 'm7', role: 'assistant', content: '저장된', status: 'streaming', steps: [], citations: [] }] }
    renderPage()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/ai/messages/m7/stream?after=0', expect.objectContaining({ method: 'GET' })))
    await act(async () => {
      live.push(ev('meta', { message_id: 'm7' }, '1-0'))
      live.push(ev('token', { text: '처음부터 다시' }, '2-0'))
    })
    await waitFor(() => expect(document.querySelector('.ai-md')?.textContent).toContain('처음부터 다시'))
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '멈추기' })[0]) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/messages/m7/stop')).toBe(true))
  })
})
