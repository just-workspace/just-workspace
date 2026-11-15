// 내장 AI 구역 감사 수정 회귀 — 8(답변 id 를 받기 전 멈춤) · 9(다른 입력 칸의 Esc 는 멈춤이 아니다) · 10(글자와 그림이 같이 든 붙여넣기)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({ calls: [] as { url: string; opts?: any }[] }))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return {} }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const S = await import('~/composables/useAiStreams')
const { AiComposer } = await import('~/components/ai/AiComposer')

const ev = (name: string, data: unknown, id?: string) => `${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
function liveResponse(signal?: AbortSignal) {
  const enc = new TextEncoder()
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  signal?.addEventListener('abort', () => { try { ctl.error(new DOMException('aborted', 'AbortError')) } catch { /* 닫힘 */ } })
  return { res: new Response(body, { status: 200 }), push: (s: string) => ctl.enqueue(enc.encode(s)) }
}
async function until(fn: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise(r => setTimeout(r, 5))
  }
}
const asst = (): any => ({ role: 'assistant', content: '', streaming: true, tools: [], steps: [], citations: [], _uid: 7 })
const runs = () => Object.values(S.aiStreamStore.getState().runs)

beforeEach(() => { S.resetAiStreams(); api.calls = [] })
afterEach(() => { vi.unstubAllGlobals() })

describe('답변 id 를 받기 전 멈춤(8)', () => {
  it('연결을 끊지 않고 기다렸다가 meta 가 오면 stop 을 보낸다 — 그 뒤 조각은 화면에 넣지 않는다', async () => {
    let live!: ReturnType<typeof liveResponse>
    let signal!: AbortSignal
    vi.stubGlobal('fetch', vi.fn(async (_u: string, o: any) => { signal = o.signal; live = liveResponse(o.signal); return live.res }))
    let last: any
    const unsub = S.aiStreamStore.subscribe((s) => { const r = Object.values(s.runs)[0]; if (r) last = r.msg })
    const p = S.startAiRun({ convId: 'c1', url: '/x', body: null, msg: asst() })
    await until(() => !!live)
    const key = runs()[0].key
    S.stopAiRun(key)                       // 아직 meta 없음 — 멈춤을 전할 id 가 없다
    expect(signal.aborted).toBe(false)     // 끊으면 서버는 끝까지 만든다
    expect(api.calls).toEqual([])
    expect(runs()[0].active).toBe(false)   // 입력창은 바로 풀린다
    expect(last.status).toBe('stopped')
    live.push(ev('meta', { message_id: 'm9' }, '1-0') + ev('token', { text: '늦은 글' }, '2-0'))
    expect(await p).toBe(200)
    unsub()
    expect(api.calls.map(c => c.url)).toEqual(['/api/ai/messages/m9/stop'])
    expect(signal.aborted).toBe(true)
    expect(last.content).toBe('')
    expect(last.status).toBe('stopped')
  })
})

describe('AiComposer', () => {
  function mount(extra: Record<string, unknown> = {}) {
    const onStop = vi.fn()
    const onFiles = vi.fn()
    render(
      <div>
        <input data-testid="other" />
        <AiComposer modelValue="" onUpdateModelValue={() => {}} busy onStop={onStop} onFiles={onFiles} {...extra} />
      </div>,
    )
    const ta = document.querySelector('textarea') as HTMLTextAreaElement
    return { onStop, onFiles, ta }
  }

  it('Esc(9): 다른 입력 칸·한글 조합 중에는 멈추지 않고, 입력창·빈 곳에서는 멈춘다', () => {
    const { onStop, ta } = mount()
    fireEvent.keyDown(screen.getByTestId('other'), { key: 'Escape' })   // 승인 카드 [수정] 칸 · 질문 카드 '기타' 칸
    expect(onStop).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: 'Escape', isComposing: true })          // 한글 조합 취소
    expect(onStop).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onStop).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onStop).toHaveBeenCalledTimes(2)
  })

  it('붙여넣기(10): 글자와 그림이 같이 있으면(엑셀 셀) 글자를 그대로 두고, 파일만 있으면 첨부로 받는다', () => {
    const { onFiles, ta } = mount()
    const png = new File(['x'], 'image.png', { type: 'image/png' })
    const withText = fireEvent.paste(ta, { clipboardData: { files: [png], getData: (t: string) => (t === 'text/plain' ? 'A1\tB1' : '') } })
    expect(onFiles).not.toHaveBeenCalled()
    expect(withText).toBe(true)                                          // preventDefault 하지 않음 — 글자가 들어간다
    const onlyFile = fireEvent.paste(ta, { clipboardData: { files: [png], getData: () => '' } })
    expect(onFiles).toHaveBeenCalledWith([png])
    expect(onlyFile).toBe(false)
  })
})
