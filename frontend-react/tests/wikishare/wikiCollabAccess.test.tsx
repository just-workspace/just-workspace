// 위키 공동 편집 — 접속 중 권한이 변경된 경우: 강등은 읽기 전용 + 안내, 회수(4003)는 재접속 중단
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'

class FakeWS {
  static OPEN = 1
  static made: FakeWS[] = []
  readyState = 0
  binaryType = ''
  sent: Uint8Array[] = []
  onopen: (() => void) | null = null
  onclose: ((e?: { code: number }) => void) | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  constructor(public url: string) { FakeWS.made.push(this) }
  send(d: Uint8Array) { this.sent.push(d) }
  close() { this.readyState = 3 }
  addEventListener() { /* close 정리용 */ }
  open() { this.readyState = 1; this.onopen?.() }
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }) }
  push(bytes: number[]) { this.onmessage?.({ data: new Uint8Array(bytes).buffer }) }
}

const toast = vi.hoisted(() => ({ calls: [] as [string, string][] }))
vi.mock('~/composables/useToast', async (orig) => {
  const real = await orig<typeof import('~/composables/useToast')>()
  return { ...real, addToast: (type: string, message: string) => { toast.calls.push([type, message]); return 0 } }
})

const { WikiCollabEditor, SYNC_WAIT_MS } = await import('~/components/wiki/WikiCollabEditor')

const editable = (el: HTMLElement) => el.querySelector('[contenteditable="true"]') !== null

async function mount(readonly = false) {
  const view = render(<WikiCollabEditor pageId="p1" initialContent="<p>본문</p>" readonly={readonly} />)
  const ws = FakeWS.made.at(-1)!
  await act(async () => { ws.open() })
  await act(async () => { vi.advanceTimersByTime(SYNC_WAIT_MS + 50) })
  return { ...view, ws }
}

beforeEach(() => {
  FakeWS.made = []
  toast.calls = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWS as any)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WikiCollabEditor 권한 변화', () => {
  it('4003 으로 끊기면 재접속하지 않고 읽기 전용 + 안내', async () => {
    const { container, ws } = await mount()
    expect(editable(container)).toBe(true)
    await act(async () => { ws.drop(4003) })
    expect(editable(container)).toBe(false)
    expect(toast.calls).toHaveLength(1)
    expect(toast.calls[0][0]).toBe('error')
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(FakeWS.made).toHaveLength(1)
  })

  it('그 밖의 끊김은 전처럼 3초 뒤 재접속하고 편집을 막지 않는다', async () => {
    const { container, ws } = await mount()
    await act(async () => { ws.drop(1006) })
    expect(editable(container)).toBe(true)
    expect(toast.calls).toHaveLength(0)
    await act(async () => { vi.advanceTimersByTime(3100) })
    expect(FakeWS.made).toHaveLength(2)
  })

  it('서버의 강등 알림([4,0])이면 읽기 전용 + 안내 한 번, 복구([4,1])면 다시 편집', async () => {
    const { container, ws } = await mount()
    await act(async () => { ws.push([4, 0]) })
    expect(editable(container)).toBe(false)
    await act(async () => { ws.push([4, 0]) })
    expect(toast.calls).toEqual([['warning', expect.any(String)]])
    await act(async () => { ws.push([4, 1]) })
    expect(editable(container)).toBe(true)
    expect(toast.calls).toHaveLength(1)
  })

  it('강등된 동안에는 호스트가 readonly 를 풀어도 편집되지 않는다', async () => {
    const { container, ws, rerender } = await mount(true)
    await act(async () => { ws.push([4, 0]) })
    await act(async () => { rerender(<WikiCollabEditor pageId="p1" initialContent="<p>본문</p>" readonly={false} />) })
    expect(editable(container)).toBe(false)
    await act(async () => { ws.push([4, 1]) })
    expect(editable(container)).toBe(true)
  })
})
