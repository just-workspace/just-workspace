// 위키 공동 편집기(TipTap v3 + Yjs) — v2 저장 HTML 시드 하위호환, 확장 중복 없음, 모의 릴레이로 두 편집기 동기화·프레즌스, 커서 색 안전화
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async () => ({})
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { WikiCollabEditor, safePeerColor, renderPeerCaret, renderPeerSelection, peerTokenHex, SYNC_WAIT_MS } = await import('~/components/wiki/WikiCollabEditor')
const { authStore } = await import('~/composables/useAuth')

/**
 * 서버 릴레이(app/collab/relay.py) 모의 — 한 소켓이 전송한 바이트를 같은 방의 다른 소켓에 그대로 전달한다.
 * 편집기는 프레임 첫 바이트(UPDATE/SYNC/AWARENESS)로 동기화를 자체 수행하므로 릴레이는 내용을 해석할 필요가 없다.
 */
class FakeRelaySocket {
  static all: FakeRelaySocket[] = []
  static OPEN = 1
  readyState = 0
  binaryType = ''
  onopen: null | (() => void) = null
  onclose: null | (() => void) = null
  onmessage: null | ((ev: { data: ArrayBuffer }) => void) = null
  private listeners: Record<string, Array<() => void>> = {}
  constructor(public url: string) {
    FakeRelaySocket.all.push(this)
    setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0)
  }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ||= []).push(fn) }
  send(data: Uint8Array) {
    const copy = data.slice().buffer
    for (const peer of FakeRelaySocket.all) {
      if (peer === this || peer.readyState !== 1) continue
      setTimeout(() => peer.onmessage?.({ data: copy }), 0)
    }
  }
  close() {
    this.readyState = 3
    FakeRelaySocket.all = FakeRelaySocket.all.filter(s => s !== this)
    for (const fn of this.listeners.close || []) fn()
    this.onclose = null   // 재접속 타이머를 기동하지 않음
  }
}

const flush = async (ms = 20) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }

const V2_HTML = '<h2>제목</h2><p>본문 <strong>굵게</strong> <u>밑줄</u> <a href="https://example.com">링크</a></p>'
  + '<table><tbody><tr><th><p>머리</p></th><th><p>둘</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table><p>끝</p>'

// 전역 WebSocket 대체는 tests/setup.ts 의 afterEach 가 cleanup(언마운트) 이후에 복원한다 — 여기서 먼저 복원하면 언마운트 시 WebSocket.OPEN 을 읽을 수 없다
beforeEach(() => {
  FakeRelaySocket.all = []
  vi.stubGlobal('WebSocket', FakeRelaySocket)
  authStore.setState({ user: { id: 'u1', username: 'kim', display_name: '김서연' } as any })
})

describe('peer 색(TipTap v3 는 #rrggbb 만 안전한 색으로 본다)', () => {
  it('내 색은 항상 #rrggbb', () => {
    for (let i = 0; i < 3; i++) expect(peerTokenHex(i)).toMatch(/^#[0-9a-f]{6}$/i)
  })
  it('상대가 보낸 값: hex 는 그대로, 옛 클라이언트의 토큰 문자열은 같은 토큰의 hex, 그 밖엔 첫 색', () => {
    expect(safePeerColor('#3eb17e')).toBe('#3eb17e')
    expect(safePeerColor('hsl(var(--warning))')).toBe(peerTokenHex(1))
    expect(safePeerColor('url(javascript:alert(1))')).toBe(peerTokenHex(0))
    expect(safePeerColor(undefined)).toBe(peerTokenHex(0))
  })
  it('커서·선택 영역 렌더러: v3 클래스 이름 + 걸러진 색', () => {
    const el = renderPeerCaret({ name: '박', color: 'expression(1)' })
    expect(el.classList.contains('collaboration-carets__caret')).toBe(true)
    expect(el.querySelector('.collaboration-carets__label')?.textContent).toBe('박')
    expect(el.style.borderColor).not.toBe('')
    expect(renderPeerSelection({ color: '#abcdef' })).toEqual({ class: 'ProseMirror-yjs-selection', style: 'background-color: #abcdef' })
  })
})

describe('WikiCollabEditor', () => {
  it('v2 가 저장한 HTML(표·링크·밑줄·굵게)을 시드로 그대로 그린다 — 확장은 하나씩만(중복 경고 없음)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let state: any = null
    render(<WikiCollabEditor pageId="p1" initialContent={V2_HTML} readonly={false} onUpdateState={s => { state = s }} />)
    await flush(SYNC_WAIT_MS + 50)   // 방에 아무도 없음 → 대기 후 저장본으로 시드
    const html = state.editor.getHTML() as string
    expect(html).toContain('<table')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('<u>밑줄</u>')
    expect(html).toContain('<strong>굵게</strong>')
    const names = state.editor.extensionManager.extensions.map((e: any) => e.name) as string[]
    for (const n of ['underline', 'link', 'table', 'tableRow', 'tableCell', 'tableHeader', 'collaboration', 'collaborationCaret']) {
      expect(names.filter(x => x === n), n).toHaveLength(1)
    }
    expect(names).not.toContain('undoRedo')   // 되돌리기는 Yjs 가 담당
    expect(warn.mock.calls.map(c => String(c[0])).filter(m => /Duplicate|tiptap/i.test(m))).toEqual([])
    expect(state.connected).toBe(true)
    warn.mockRestore()
  })

  it('두 편집기가 릴레이로 동기화되고 상대가 프레즌스에 뜬다(색은 hex)', async () => {
    let a: any = null, b: any = null
    const onChangeA = vi.fn()
    render(<WikiCollabEditor pageId="p2" initialContent="<p>시작</p>" readonly={false} onChange={onChangeA} onUpdateState={s => { a = s }} />)
    await flush(SYNC_WAIT_MS + 50)
    authStore.setState({ user: { id: 'u2', username: 'park', display_name: '박지훈' } as any })
    render(<WikiCollabEditor pageId="p2" initialContent="<p>시작</p>" readonly={false} onUpdateState={s => { b = s }} />)
    await flush(60)
    // B 는 A 의 상태(SYNC_RESPONSE)로 시작하며 시드하지 않음 — "시작" 은 하나
    expect(b.editor.getText()).toBe('시작')
    await act(async () => { a.editor.commands.insertContentAt(a.editor.state.doc.content.size, '<p>A 가 씀</p>') })
    await flush(60)
    expect(b.editor.getHTML()).toContain('A 가 씀')
    expect(onChangeA).toHaveBeenCalled()
    await act(async () => { b.editor.commands.insertContentAt(b.editor.state.doc.content.size, '<p>B 가 씀</p>') })
    await flush(60)
    expect(a.editor.getHTML()).toContain('B 가 씀')
    expect(a.peers.map((p: any) => p.name)).toEqual(['박지훈'])
    expect(a.peers[0].color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(b.peers.map((p: any) => p.name)).toEqual(['김서연'])
  })
})
