// 위키 공동 편집 — 끊긴 사이에 친 글은 재접속 때 내 상태를 통째로 한 번 보내야 상대에게 간다.
// (예전엔 재접속 때 상대 상태만 요청해, 끊긴 동안의 내 편집이 영영 전달되지 않고 그 뒤 편집도 상대 쪽에서 보류됐다)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { createRef } from 'react'
import * as Y from 'yjs'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async () => ({})
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { WikiCollabEditor, SYNC_WAIT_MS } = await import('~/components/wiki/WikiCollabEditor')
type Handle = import('~/components/wiki/WikiCollabEditor').WikiCollabEditorHandle
const { authStore } = await import('~/composables/useAuth')

const MSG_UPDATE = 0
const MSG_SYNC_REQUEST = 1

/** 보낸 프레임을 모아 두는 소켓 — drop() 으로 서버가 끊은 것을 흉내 낸다(편집기가 3초 뒤 다시 붙는다) */
class RecSocket {
  static all: RecSocket[] = []
  static OPEN = 1
  readyState = 0
  binaryType = ''
  sent: Uint8Array[] = []
  onopen: null | (() => void) = null
  onclose: null | (() => void) = null
  onmessage: null | ((ev: { data: ArrayBuffer }) => void) = null
  private listeners: Record<string, Array<() => void>> = {}
  constructor(public url: string) {
    RecSocket.all.push(this)
    setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.() } }, 0)
  }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ||= []).push(fn) }
  send(data: Uint8Array) { this.sent.push(data.slice()) }
  drop() {
    this.readyState = 3
    for (const fn of this.listeners.close || []) fn()
    this.onclose?.()
  }
  close() {
    this.readyState = 3
    for (const fn of this.listeners.close || []) fn()
    this.onclose = null
  }
}

const wait = async (ms: number) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }

beforeEach(() => {
  RecSocket.all = []
  vi.stubGlobal('WebSocket', RecSocket)
  authStore.setState({ user: { id: 'u1', username: 'kim', display_name: '김서연' } as any })
})

describe('WikiCollabEditor 재접속', () => {
  it('끊긴 사이의 편집을 재접속 때 MSG_UPDATE(전체 상태)로 보낸다 — 빈 문서에 적용하면 그 글이 들어 있다', async () => {
    const ref = createRef<Handle>()
    render(<WikiCollabEditor ref={ref} pageId="p1" initialContent="<p>저장본</p>" readonly={false} />)
    await wait(SYNC_WAIT_MS + 100)   // 혼자 → 저장본으로 시드, 편집 가능
    const first = RecSocket.all[0]
    expect(first.sent.some(f => f[0] === MSG_SYNC_REQUEST)).toBe(true)
    // 첫 접속(본문 준비 전)에는 보낼 상태가 없다
    expect(first.sent.some(f => f[0] === MSG_UPDATE)).toBe(false)

    // 서버가 끊는다 → 끊긴 사이에 입력
    await act(async () => { first.drop() })
    await act(async () => { ref.current!.editor!.commands.insertContent('끊긴 사이 입력') })
    expect(first.sent.some(f => f[0] === MSG_UPDATE)).toBe(false)   // 닫힌 소켓으로는 안 나간다

    await wait(3200)   // 3초 뒤 재접속
    const second = RecSocket.all[1]
    expect(second).toBeTruthy()
    expect(second.sent[0][0]).toBe(MSG_SYNC_REQUEST)
    const full = second.sent.find(f => f[0] === MSG_UPDATE)
    expect(full).toBeTruthy()

    // 상대(빈 문서)가 그 프레임 하나만 받아도 저장본 + 끊긴 사이 입력이 다 들어온다. 두 번 받아도 같다(멱등)
    const peer = new Y.Doc()
    Y.applyUpdate(peer, full!.subarray(1))
    const once = peer.getXmlFragment('default').toString()
    expect(once).toContain('저장본')
    expect(once).toContain('끊긴 사이 입력')
    Y.applyUpdate(peer, full!.subarray(1))
    expect(peer.getXmlFragment('default').toString()).toBe(once)
  }, 15_000)
})
