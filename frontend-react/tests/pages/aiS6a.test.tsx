// AI 대화 기본기: 진행 단계(펼침/접힘·실패), 출처 칩 + 본문 [n], 피드백(대화 첨부 기본 꺼짐), 이어서 받기,
// 수식(KaTeX)이 코드블록을 건드리지 않음. $fetch 와 fetch(스트림)는 가짜.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

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
    const f = url.match(/^\/api\/ai\/messages\/([^/]+)\/feedback$/)
    if (f) {
      const b = opts?.body || {}
      return { message_id: f[1], feedback: b.rating ? { rating: b.rating, reasons: b.reasons || [], comment: b.comment || '', include_conversation: !!b.include_conversation } : null }
    }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: AiPage } = await import('~/pages/ai')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')
const { aiMathPlugin, getAiKatex, aiKatexLoaded } = await import('~/utils/aiMath')
const { aiCitePlugin } = await import('~/utils/aiCite')
const { aiApplyStep, aiStepsSummary } = await import('~/utils/aiAssist')

function renderPage() {
  const router = createMemoryRouter([{ path: '*', element: <AiPage /> }], { initialEntries: ['/ai'] })
  return render(<RouterProvider router={router} />)
}

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
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

const T0 = '2026-11-05T01:00:00.000Z'
const T18 = '2026-11-05T01:00:18.000Z'
const STEPS = [
  { id: 'st1', kind: 'search', label: '메일 검색 “VPN 장애”', status: 'done', detail: '받은 메일 7건', started_at: T0, ended_at: '2026-11-05T01:00:02.100Z' },
  { id: 'st2', kind: 'read', label: '파일 3개 읽기', status: 'done', detail: 'vpn-gw01.log 외 2개', started_at: T0, ended_at: '2026-11-05T01:00:08.000Z' },
]
const CITES = [
  { n: 1, kind: 'mail', id: '42', title: '[장애] 지사 VPN 터널 반복 끊김', url: '/mail/42?mailbox=INBOX', snippet: '8시간마다 터널이 내려갔다 올라옵니다', author: 'lee@x', date: '2026-11-03T14:22:00' },
  { n: 2, kind: 'file', id: 'my/logs/vpn-gw01.log', title: 'vpn-gw01.log', url: '/files?path=my/logs', snippet: 'IKE rekey' },
]

function savedAnswer(over: Record<string, unknown> = {}) {
  return {
    id: 'a1', role: 'assistant', content: '원인은 재협상 주기입니다.[1][2] 없는 번호 [9]', created_at: T18,
    ai_generated: true, model: 'qwen-27b', status: 'complete', steps: STEPS, citations: CITES,
    started_at: T0, ended_at: T18, feedback: null, ...over,
  }
}

beforeEach(() => {
  api.calls = []
  api.conversations = [{ id: 'c1', title: '첫 대화', tools_enabled: true, updated_at: new Date().toISOString(), preview: '안녕' }]
  api.messages = { c1: [] }
  isMobileStore.setState({ isMobile: false })
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null })
  try { localStorage.removeItem('ai-sidebar-collapsed') } catch { /* */ }
})

async function openWith(messages: any[]) {
  api.messages = { c1: [{ id: 'q1', role: 'user', content: 'VPN 장애 정리', created_at: T0 }, ...messages] }
  renderPage()
  await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/c1/messages')).toBe(true))
}

describe('S6a 진행 단계', () => {
  it('저장된 답변: 접힌 요약("2단계 완료 · … · 18초"), 누르면 펼침', async () => {
    await openWith([savedAnswer()])
    const head = await screen.findByRole('button', { expanded: false, name: /단계 완료/ })
    expect(head.textContent).toContain('2단계 완료')
    expect(head.textContent).toContain('메일 검색 → 파일 3개 읽기')
    expect(head.textContent).toContain('18초')
    expect(screen.queryByText('받은 메일 7건')).toBeNull()
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('받은 메일 7건')).toBeTruthy()
    expect(screen.getByText('2.1s')).toBeTruthy()
    // AI 생성 표시에 모델 이름
    expect(document.body.textContent).toContain('AI 생성 · qwen-27b · 내용을 확인한 뒤 쓰세요')
  })

  it('실패한 단계: 경고 요약 + 이유 + "이 결과 없이 계속했습니다"', async () => {
    const steps = [STEPS[0], { id: 'st2', kind: 'read', label: '파일 읽기 — vpn-gw02.log', status: 'failed', detail: '읽을 권한이 없습니다', started_at: T0, ended_at: T18 }]
    await openWith([savedAnswer({ steps })])
    const head = await screen.findByRole('button', { name: /실패/ })
    expect(head.textContent).toContain('2단계 중 1개 실패')
    fireEvent.click(head)
    expect(document.body.textContent).toContain('읽을 권한이 없습니다 · 이 결과 없이 계속했습니다')
  })

  it('스트림: 단계가 running → done 으로 바뀌고, 받는 중엔 펼침·끝나면 접힘', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const enc = new TextEncoder()
    const parts = [
      ev('meta', { message_id: 'm-live', model: 'live-model', ai_generated: true, mode: 'new' }),
      ev('step', { id: 'st1', kind: 'search', label: '메일 검색 “VPN”', status: 'running', detail: '', started_at: new Date().toISOString(), ended_at: null }),
    ]
    const rest = [
      ev('step', { id: 'st1', kind: 'search', label: '메일 검색 “VPN”', status: 'done', detail: '받은 메일 7건', started_at: new Date().toISOString(), ended_at: new Date().toISOString() }),
      ev('citation', CITES[0]),
      ev('token', { text: '정리했습니다.[1]' }),
      ev('done', { message_id: 'm-live', status: 'complete', model: 'live-model', ai_generated: true }),
    ]
    const body = new ReadableStream<Uint8Array>({
      async start(ctl) {
        for (const p of parts) ctl.enqueue(enc.encode(p))
        await gate
        for (const p of rest) ctl.enqueue(enc.encode(p))
        ctl.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    await openWith([])
    const ta = document.querySelector('textarea')!
    fireEvent.change(ta, { target: { value: '정리해 줘' } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
    const head = await screen.findByRole('button', { expanded: true, name: /메일 검색 “VPN”/ })
    expect(head.textContent).toContain('1/1')
    expect(screen.getByRole('button', { name: '멈추기' })).toBeTruthy()
    await act(async () => { release() })
    await waitFor(() => expect(document.body.textContent).toContain('AI 생성 · live-model'))
    const done = await screen.findByRole('button', { expanded: false, name: /단계 완료/ })
    expect(done.textContent).toContain('1단계 완료 · 메일 검색')
    await waitFor(() => expect(document.querySelector('.ai-cite[data-cite="1"]')).toBeTruthy())
    expect(document.body.textContent).toContain('AI 생성 · live-model')
    vi.unstubAllGlobals()
  })
})

describe('S6a 출처', () => {
  it('출처 칩 + 본문 [n] 버튼(없는 번호는 글자 그대로) → 누르면 미리보기·앱 안 링크', async () => {
    await openWith([savedAnswer()])
    await waitFor(() => expect(document.querySelectorAll('.ai-cite').length).toBe(2))
    expect(document.querySelector('.ai-md')!.textContent).toContain('[9]')
    expect(document.querySelector('.ai-cite[data-cite="9"]')).toBeNull()
    const chip = screen.getByRole('button', { name: '출처 1: 메일 · [장애] 지사 VPN 터널 반복 끊김' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    // 본문 [2] → 파일 칩 미리보기
    await act(async () => { fireEvent.click(document.querySelector('.ai-cite[data-cite="2"]')!) })
    const prev2 = screen.getByRole('region', { name: '출처 2 미리보기' })
    expect(prev2.textContent).toContain('IKE rekey')
    expect(screen.getByRole('link', { name: '파일에서 열기' }).getAttribute('href')).toBe('/files?path=my/logs')
    // 칩 누름 → 메일 미리보기(보낸 사람·시각)
    await act(async () => { fireEvent.click(chip) })
    const prev1 = screen.getByRole('region', { name: '출처 1 미리보기' })
    expect(prev1.textContent).toContain('lee@x')
    expect(prev1.textContent).toContain('11-03 14:22')
    expect(screen.getByRole('link', { name: '메일에서 열기' }).getAttribute('href')).toBe('/mail/42?mailbox=INBOX')
    // Esc 로 닫힘
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('region', { name: '출처 1 미리보기' })).toBeNull()
  })
})

describe('S6a 피드백', () => {
  it('👍 바로 저장 · 👎 이유 카드 — 대화 첨부는 기본 꺼짐, 켜야 include_conversation=true', async () => {
    await openWith([savedAnswer()])
    const up = await screen.findByRole('button', { name: '좋아요' })
    await act(async () => { fireEvent.click(up) })
    await waitFor(() => expect(up.getAttribute('aria-pressed')).toBe('true'))
    const fbCalls = () => api.calls.filter(c => c.url === '/api/ai/messages/a1/feedback')
    expect(fbCalls()[0].opts.body).toMatchObject({ rating: 'up', include_conversation: false })

    const down = screen.getByRole('button', { name: '별로예요' })
    await act(async () => { fireEvent.click(down) })
    const dlg = await screen.findByRole('dialog', { name: '어떤 점이 아쉬웠나요?' })
    expect(fbCalls()[1].opts.body).toMatchObject({ rating: 'down', reasons: [], include_conversation: false })
    expect(dlg.textContent).toContain('대화 내용은 아래를 켤 때만 함께 보냅니다')
    const box = screen.getByRole('checkbox', { name: '이 대화 내용도 함께 보내기' }) as HTMLInputElement
    expect(box.checked).toBe(false)
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '사실과 다름' })) })
    // 첨부를 켜지 않고 보내기 → include_conversation=false
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '보내기' })) })
    await waitFor(() => expect(fbCalls().length).toBe(3))
    expect(fbCalls()[2].opts.body).toMatchObject({ rating: 'down', reasons: ['inaccurate'], include_conversation: false })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '어떤 점이 아쉬웠나요?' })).toBeNull())

    // 다시 👎(취소) → 다시 👎 → 첨부 켜고 보내기
    await act(async () => { fireEvent.click(down) })
    await waitFor(() => expect(fbCalls()[3].opts.body).toMatchObject({ rating: null }))
    await act(async () => { fireEvent.click(down) })
    const dlg2 = await screen.findByRole('dialog', { name: '어떤 점이 아쉬웠나요?' })
    await act(async () => { fireEvent.click(within(dlg2).getByRole('checkbox', { name: '이 대화 내용도 함께 보내기' })) })
    await act(async () => { fireEvent.click(within(dlg2).getByRole('button', { name: '보내기' })) })
    await waitFor(() => expect(fbCalls().at(-1)!.opts.body).toMatchObject({ rating: 'down', include_conversation: true }))
  })
})

describe('S6a 이어서 받기', () => {
  it('끊긴 답변: 타일 [이어서 받기] → /continue 스트림이 같은 메시지 뒤에 붙인다', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      ev('meta', { message_id: 'a1', model: 'qwen-27b', ai_generated: true, mode: 'continue' }),
      ev('partial', { text: '원인은 IKE' }),
      ev('token', { text: ' 재협상 주기 불일치입니다.' }),
      ev('done', { message_id: 'a1', status: 'complete', model: 'qwen-27b', ai_generated: true }),
    ]))
    vi.stubGlobal('fetch', fetchMock)
    await openWith([savedAnswer({ content: '원인은 IKE', status: 'interrupted', steps: [], citations: [] })])
    const tile = await screen.findByRole('alert')
    expect(tile.textContent).toContain('답변이 중간에 끊겼습니다')
    expect(tile.textContent).toContain('받은 부분까지는 저장됐습니다')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '이어서 받기' })) })
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/conversations/c1/continue', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(document.querySelector('.ai-md')?.textContent).toContain('원인은 IKE 재협상 주기 불일치입니다.'))
    await waitFor(() => expect(screen.queryByRole('button', { name: '이어서 받기' })).toBeNull())
    expect(document.querySelectorAll('.ai-md').length).toBe(1) // 새 메시지가 아니라 같은 메시지
    vi.unstubAllGlobals()
  })

  it('멈춘 답변은 "답변을 멈췄습니다" + 이어서 받기, 제공자 미지원이면 다시 만들기로 바뀜', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      ev('meta', { message_id: 'a1', model: 'm', ai_generated: true, mode: 'continue' }),
      ev('partial', { text: '앞부분' }),
      ev('continue_fallback', { message: 'prefill not supported' }),
      ev('token', { text: '새 답변 전체' }),
      ev('done', { message_id: 'a1', status: 'complete', model: 'm', ai_generated: true }),
    ])))
    await openWith([savedAnswer({ content: '앞부분', status: 'stopped', steps: [], citations: [] })])
    expect((await screen.findByRole('alert')).textContent).toContain('답변을 멈췄습니다')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '이어서 받기' })) })
    await waitFor(() => expect(document.querySelector('.ai-md')?.textContent?.trim()).toBe('새 답변 전체'))
    vi.unstubAllGlobals()
  })

  it('멈추기: 스트림을 끊고 서버에 stop 을 남긴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(enc.encode(ev('meta', { message_id: 'm-stop', model: 'm', ai_generated: true, mode: 'new' })))
          ctl.enqueue(enc.encode(ev('token', { text: '받는 중' })))
          opts.signal.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(body, { status: 200 })
    }))
    await openWith([])
    const ta = document.querySelector('textarea')!
    fireEvent.change(ta, { target: { value: '길게 써 줘' } })
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }) })
    await waitFor(() => expect(document.querySelector('.ai-md')?.textContent).toContain('받는 중'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '멈추기' })) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/messages/m-stop/stop')).toBe(true))
    expect((await screen.findByRole('alert')).textContent).toContain('답변을 멈췄습니다')
    vi.unstubAllGlobals()
  })
})

describe('S6a 수식·출처 표식 렌더(markdown-it 플러그인)', () => {
  function mdWith(nums: number[] = []) {
    const m = new MarkdownIt({ html: false, linkify: true, breaks: true })
    aiMathPlugin(m, aiKatexLoaded)
    aiCitePlugin(m, () => new Set(nums), n => `출처 ${n}`)
    return m
  }

  it('KaTeX: 인라인·블록 수식은 그리고, 코드블록·인라인 코드·돈 표기는 그대로', async () => {
    await getAiKatex()
    const html = mdWith([1]).render([
      '가용률 $\\frac{41}{43200}$ 입니다[1]',
      '',
      '$$',
      'A = (1 - x) \\times 100',
      '$$',
      '',
      '```python',
      'price = "$5" + "$x$"  # [1]',
      '```',
      '',
      '`$y$` 와 $5, $10 은 그대로',
    ].join('\n'))
    const div = document.createElement('div')
    div.innerHTML = DOMPurify.sanitize(html) // AiMessage 와 같이 정화한 뒤에도 남아야 한다
    expect(div.querySelectorAll('.katex').length).toBe(2)
    expect(div.querySelector('.katex-html')).toBeTruthy()
    expect(div.querySelector('.katex-mathml math')).toBeTruthy()
    expect(div.querySelector('.ai-math-block .katex-display')).toBeTruthy()
    const code = div.querySelector('pre code')!
    expect(code.textContent).toContain('price = "$5" + "$x$"  # [1]')
    expect(code.querySelector('.katex, .ai-cite')).toBeNull()
    const inline = Array.from(div.querySelectorAll('code')).find(c => c.textContent === '$y$')
    expect(inline).toBeTruthy()
    expect(div.textContent).toContain('$5, $10 은 그대로')
    expect(div.querySelectorAll('.ai-cite').length).toBe(1)
  })

  it('KaTeX 를 아직 못 불렀을 때는 원문을 코드 모양으로', () => {
    const m = new MarkdownIt()
    aiMathPlugin(m, () => null)
    expect(m.render('식 $x^2$')).toContain('<code class="ai-math-src">$x^2$</code>')
  })

  it('[n] 은 링크 안에서는 바꾸지 않는다', () => {
    const html = mdWith([1]).render('[문서 [1]](https://a.example) 끝[1]')
    const div = document.createElement('div')
    div.innerHTML = html
    expect(div.querySelectorAll('.ai-cite').length).toBe(1)
    expect(div.querySelector('a')!.querySelector('.ai-cite')).toBeNull()
  })
})

describe('S6a 순수 함수', () => {
  it('aiApplyStep 은 같은 id 를 바꿔 끼우고 aiStepsSummary 는 실패·초를 센다', () => {
    let list = aiApplyStep([], { id: 'st1', kind: 'search', label: 'a', status: 'running', started_at: T0 })
    list = aiApplyStep(list, { id: 'st1', kind: 'search', label: 'a', status: 'failed', detail: 'x', started_at: T0, ended_at: T18 })
    expect(list.length).toBe(1)
    expect(list[0].status).toBe('failed')
    const s = aiStepsSummary(list, T0, T18)
    expect(s).toMatchObject({ total: 1, failed: 1, secs: 18, running: null })
  })
})
