// 위키 공동 편집 시드 — 먼저 편집 중인 사용자가 있으면 저장본으로 시드하지 않고 방 상태로 시작한다
// (늦게 합류한 쪽의 본문이 중복되던 회귀). 단독이면 대기 후 저장본으로 시드.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import { generateJSON } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'

class FakeWS {
  static OPEN = 1
  static last: FakeWS | null = null
  readyState = 0
  binaryType = ''
  sent: Uint8Array[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  constructor(public url: string) { FakeWS.last = this }
  send(d: Uint8Array) { this.sent.push(d) }
  close() { this.readyState = 3 }
  addEventListener() { /* close 정리용 — 테스트에서는 미사용 */ }
  open() { this.readyState = 1; this.onopen?.() }
  push(type: number, payload: Uint8Array) {
    const out = new Uint8Array(payload.length + 1); out[0] = type; out.set(payload, 1)
    this.onmessage?.({ data: out.buffer })
  }
}

const { WikiCollabEditor, SYNC_WAIT_MS } = await import('~/components/wiki/WikiCollabEditor')

const SAVED = '<p>DUP-LINE-ONE</p>'
const count = (el: HTMLElement) => (el.innerHTML.match(/DUP-LINE-ONE/g) || []).length

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWS as any)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WikiCollabEditor 시드', () => {
  it('늦게 합류: 먼저 온 사람의 상태를 받으면 저장본 시드를 하지 않는다(본문 한 벌)', async () => {
    // 선행 접속자: 시드 후 직접 입력한 내용이 저장된 상황 — 해당 내용은 그 접속자의 clientID 항목
    const peer = new Y.Doc(); peer.clientID = 4242
    const schema = getSchema([StarterKit])
    prosemirrorJSONToYXmlFragment(schema, generateJSON(SAVED, [StarterKit]), peer.getXmlFragment('default'))

    const { container } = render(<WikiCollabEditor pageId="p1" initialContent={SAVED} readonly={false} />)
    const ws = FakeWS.last!
    await act(async () => { ws.open() })
    expect(ws.sent[0][0]).toBe(1)   // SYNC_REQUEST
    await act(async () => { ws.push(2, Y.encodeStateAsUpdate(peer)) })
    await act(async () => { vi.advanceTimersByTime(SYNC_WAIT_MS + 50) })
    expect(count(container)).toBe(1)
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull()
  })

  it('혼자: 응답이 없으면 기다렸다 저장본으로 시드하고, 그 전엔 편집을 막는다', async () => {
    const { container } = render(<WikiCollabEditor pageId="p2" initialContent={SAVED} readonly={false} />)
    const ws = FakeWS.last!
    await act(async () => { ws.open() })
    expect(count(container)).toBe(0)
    expect(container.querySelector('[contenteditable="true"]')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(SYNC_WAIT_MS + 50) })
    expect(count(container)).toBe(1)
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull()
  })
})
