// 내장 AI 답변 스트림 전역 저장소 — 페이지가 없어도(언마운트) 수신을 계속하고, 끊기면 after 로 재연결, 멈춤 시에만 abort.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const api = vi.hoisted(() => ({ calls: [] as { url: string; opts?: any }[] }))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return {} }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})
const nav = vi.hoisted(() => ({ to: [] as string[] }))
vi.mock('~/lib/router', async (orig) => {
  const real = await orig<typeof import('~/lib/router')>()
  return { ...real, navigateTo: (p: string) => { nav.to.push(p) } }
})

const S = await import('~/composables/useAiStreams')
const { toastStore } = await import('~/composables/useToast')

const ev = (name: string, data: unknown, id?: string) => `${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

/** 수동으로 전송하는 SSE 응답 — push 로 청크 전송, end 로 종료, abort 신호 시 오류 */
function liveResponse(signal?: AbortSignal) {
  const enc = new TextEncoder()
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  signal?.addEventListener('abort', () => { try { ctl.error(new DOMException('aborted', 'AbortError')) } catch { /* 닫힘 */ } })
  return {
    res: new Response(body, { status: 200 }),
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    end: () => ctl.close(),
  }
}
const tick = () => new Promise(r => setTimeout(r, 0))
async function until(fn: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise(r => setTimeout(r, 5))
  }
}
const asst = (): any => ({ role: 'assistant', content: '', streaming: true, tools: [], steps: [], citations: [], _uid: 7 })
const runs = () => Object.values(S.aiStreamStore.getState().runs)

beforeEach(() => {
  S.resetAiStreams()
  api.calls = []
  nav.to = []
  toastStore.setState({ toasts: [] })
  S.aiReconnect.base = 5
})
afterEach(() => { vi.unstubAllGlobals(); S.aiReconnect.base = 1000 })

describe('useAiStreams', () => {
  it('페이지가 없어도(언마운트) 토큰을 계속 모으고, 끝나면 다른 화면이면 완료 토스트', async () => {
    let live!: ReturnType<typeof liveResponse>
    const fetchMock = vi.fn(async (_u: string, o: any) => { live = liveResponse(o.signal); return live.res })
    vi.stubGlobal('fetch', fetchMock)
    S.setAiView(true, 'c1')
    const p = S.startAiRun({ convId: 'c1', url: '/api/ai/conversations/c1/chat', body: { content: 'q' }, msg: asst() })
    await until(() => !!live)
    live.push(ev('meta', { message_id: 'm1', model: 'x' }, '1-0'))
    live.push(ev('token', { text: '앞' }, '2-0'))
    await until(() => runs()[0]?.msg.content === '앞')
    S.setAiView(false, null) // 다른 화면으로 이동 — 연결 유지
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)
    live.push(ev('artifact', { id: 'a1' }, '3-0')) // 미지의 이벤트도 위치(id)는 기록
    live.push(ev('token', { text: '뒤' }, '4-0'))
    await until(() => runs()[0]?.msg.content === '앞뒤')
    expect(runs()[0].lastId).toBe('4-0')
    expect(runs()[0].msgId).toBe('m1')
    expect(S.aiActiveRunFor('c1')).toBeTruthy()
    live.push(ev('done', { message_id: 'm1', status: 'complete' }, '5-0'))
    live.end()
    expect(await p).toBe(200)
    expect(runs().length).toBe(0)
    const t = toastStore.getState().toasts
    expect(t.length).toBe(1)
    expect(t[0].message).toBe('AI 답변이 완료됐습니다')
    expect(t[0].action?.label).toBe('대화로 가기')
    void t[0].action!.onClick()
    expect(nav.to).toEqual(['/ai'])
    expect(S.takeAiPendingOpen()).toBe('c1')
  })

  it('보고 있는 대화면 토스트 없음', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const l = liveResponse()
      l.push(ev('meta', { message_id: 'm1' }, '1-0')); l.push(ev('done', { message_id: 'm1', status: 'complete' }, '2-0')); l.end()
      return l.res
    }))
    S.setAiView(true, 'c1')
    await S.startAiRun({ convId: 'c1', url: '/x', body: null, msg: asst() })
    expect(toastStore.getState().toasts.length).toBe(0)
  })

  it('done 없이 끊기면 마지막 id 를 after 로 재연결해 이어 받는다', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u)
      const l = liveResponse()
      if (urls.length === 1) {
        l.push(ev('meta', { message_id: 'm9' }, '1-0')); l.push(ev('token', { text: '가' }, '2-0')); l.end() // 끊김
      } else if (urls.length === 2) {
        l.push(': ping\n\n'); l.end() // 재연결했으나 다시 끊김(이벤트 없음)
      } else {
        l.push(ev('token', { text: '나' }, '3-0')); l.push(ev('done', { message_id: 'm9', status: 'complete' }, '4-0')); l.end()
      }
      return l.res
    }))
    S.setAiView(true, 'c1')
    let last: any
    const unsub = S.aiStreamStore.subscribe((s) => { const r = Object.values(s.runs)[0]; if (r) last = r.msg })
    expect(await S.startAiRun({ convId: 'c1', url: '/api/ai/conversations/c1/chat', body: null, msg: asst() })).toBe(200)
    unsub()
    expect(urls[1]).toBe('/api/ai/messages/m9/stream?after=2-0')
    expect(urls[2]).toBe('/api/ai/messages/m9/stream?after=2-0')
    expect(last.content).toBe('가나')
    expect(last.status).toBe('complete')
  })

  it('대화를 다시 열면(새로고침) after=0 으로 처음부터 재생, 이미 받는 중이면 같은 run', async () => {
    let live!: ReturnType<typeof liveResponse>
    const fetchMock = vi.fn(async (_u: string, o: any) => { live = liveResponse(o.signal); return live.res })
    vi.stubGlobal('fetch', fetchMock)
    const saved: any = { id: 'm5', role: 'assistant', content: '저장된 진행분', status: 'streaming', steps: [], citations: [] }
    const shown = S.resumeAiRun('c1', saved)
    expect(shown.streaming).toBe(true)
    expect(shown.content).toBe('저장된 진행분')
    await until(() => !!live)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/ai/messages/m5/stream?after=0')
    expect(S.resumeAiRun('c1', saved)).toBe(runs()[0].msg) // 중복 연결 없음
    live.push(ev('meta', { message_id: 'm5' }, '1-0'))
    live.push(ev('token', { text: '처음부터' }, '2-0'))
    await until(() => runs()[0]?.msg.content === '처음부터')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    live.push(ev('done', { message_id: 'm5', status: 'complete' }, '3-0'))
    live.end()
    await until(() => runs().length === 0)
  })

  it('스트림이 만료됐으면 done.final(DB 최종본)로 채운다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const l = liveResponse()
      l.push(ev('done', { message_id: 'm6', status: 'complete', final: { content: '최종', steps: [], citations: [] } })); l.end()
      return l.res
    }))
    let last: any
    const unsub = S.aiStreamStore.subscribe((s) => { const r = Object.values(s.runs)[0]; if (r) last = r.msg })
    S.resumeAiRun('c1', { id: 'm6', role: 'assistant', content: '', status: 'streaming' } as any)
    await until(() => runs().length === 0)
    unsub()
    expect(last.content).toBe('최종')
    expect(last.streaming).toBe(false)
  })

  it('멈춤만 abort 하고 stop API 를 부른다', async () => {
    let live!: ReturnType<typeof liveResponse>
    let signal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn(async (_u: string, o: any) => { signal = o.signal; live = liveResponse(o.signal); return live.res }))
    const p = S.startAiRun({ convId: 'c1', url: '/x', body: null, msg: asst() })
    await until(() => !!live)
    live.push(ev('meta', { message_id: 'm3' }, '1-0'))
    await until(() => runs()[0]?.msgId === 'm3')
    S.setAiView(false, null)
    await tick()
    expect(signal.aborted).toBe(false)
    let last: any
    const unsub = S.aiStreamStore.subscribe((s) => { const r = Object.values(s.runs)[0]; if (r) last = r.msg })
    S.stopAiRun(runs()[0].key)
    expect(signal.aborted).toBe(true)
    expect(await p).toBe(0)
    unsub()
    expect(last.status).toBe('stopped')
    expect(api.calls.map(c => c.url)).toEqual(['/api/ai/messages/m3/stop'])
    expect(toastStore.getState().toasts.length).toBe(0)
  })

  it('aiMergeRuns: _uid 또는 서버 id 로 최신 답변을 덮는다', () => {
    const msg = { role: 'assistant', content: '새', id: 'm1', _uid: 3 } as any
    const r = { k: { key: 'k', convId: 'c', msgId: 'm1', msg, lastId: '1-0', active: true } }
    const list = [{ role: 'user', content: 'q' }, { role: 'assistant', content: '옛', id: 'm1' }] as any[]
    const out = S.aiMergeRuns(list, r)
    expect(out[1].content).toBe('새')
    expect(S.aiMergeRuns([{ role: 'assistant', content: 'x', id: 'other' }] as any[], r)[0].content).toBe('x')
    expect(S.aiBackoff(0)).toBe(5)
  })
})

describe('승인 카드 — 받는 중에 실행해도 대기로 되돌아가지 않음', () => {
  const pend = { id: 'wr_a', status: 'pending', risk: 'low' } as any
  const done = { id: 'wr_a', status: 'executed', risk: 'low' } as any

  it('aiMergeRuns: run 사본이 대기여도 화면 쪽이 처리됐으면 화면 쪽 유지', () => {
    const runs = { k: { msg: { role: 'assistant', _uid: 1, content: 'x', writes: [pend] } } } as any
    const list = [{ role: 'assistant', _uid: 1, content: '', writes: [done] }] as any
    const out = S.aiMergeRuns(list, runs)
    expect(out[0].writes).toHaveLength(1)
    expect(out[0].writes![0].status).toBe('executed')
  })

  it('aiApplyEvent: 재생된 write_request 가 처리된 카드를 덮지 않고 중복도 안 생김', () => {
    const r = S.aiApplyEvent({ role: 'assistant', writes: [done] } as any, 'write_request', pend)
    expect(r.msg.writes).toEqual([done])
  })

  it('aiPatchRunWrite: 받는 중인 run 사본도 고친다', () => {
    S.aiStreamStore.setState({ runs: { k: { msg: { role: 'assistant', writes: [pend] } } as any } })
    S.aiPatchRunWrite(done)
    expect(S.aiStreamStore.getState().runs.k.msg.writes![0].status).toBe('executed')
    S.aiStreamStore.setState({ runs: {} })
  })
})
