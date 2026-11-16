// 위키 공동 편집 — 연결이 끊긴 동안 입력한 내용은 재접속 시 본인 상태 전체를 1회 전송해야 상대에게 전달된다.
// (기존에는 재접속 시 상대 상태만 요청하여, 끊긴 동안의 본인 편집이 전달되지 않고 이후 편집도 상대 측에서 보류되었다)
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

/** 전송한 프레임을 수집하는 소켓 — drop() 으로 서버 측 연결 종료를 모의한다(편집기가 3초 뒤 재접속) */
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
    await wait(SYNC_WAIT_MS + 100)   // 단독 → 저장본으로 시드, 편집 가능
    const first = RecSocket.all[0]
    expect(first.sent.some(f => f[0] === MSG_SYNC_REQUEST)).toBe(true)
    // 첫 접속(본문 준비 전)에는 전송할 상태 없음
    expect(first.sent.some(f => f[0] === MSG_UPDATE)).toBe(false)

    // 서버가 연결 종료 → 끊긴 동안 입력
    await act(async () => { first.drop() })
    await act(async () => { ref.current!.editor!.commands.insertContent('끊긴 사이 입력') })
    expect(first.sent.some(f => f[0] === MSG_UPDATE)).toBe(false)   // 닫힌 소켓으로는 전송되지 않음

    await wait(3200)   // 3초 뒤 재접속
    const second = RecSocket.all[1]
    expect(second).toBeTruthy()
    expect(second.sent[0][0]).toBe(MSG_SYNC_REQUEST)
    const full = second.sent.find(f => f[0] === MSG_UPDATE)
    expect(full).toBeTruthy()

    // 상대(빈 문서)가 해당 프레임 하나만 수신해도 저장본 + 끊긴 동안의 입력이 전부 반영된다. 2회 수신해도 결과 동일(멱등)
    const peer = new Y.Doc()
    Y.applyUpdate(peer, full!.subarray(1))
    const once = peer.getXmlFragment('default').toString()
    expect(once).toContain('저장본')
    expect(once).toContain('끊긴 사이 입력')
    Y.applyUpdate(peer, full!.subarray(1))
    expect(peer.getXmlFragment('default').toString()).toBe(once)
  }, 15_000)
})
