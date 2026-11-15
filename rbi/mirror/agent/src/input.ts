/**
 * 입력 — 클라이언트 메시지를 CDP Input.* 으로 바꾼다. 메시지는 이미 validateClientMsg(엄격)를 통과했다.
 *
 * 좌표는 노드 id + 노드 안 상대좌표다. 원격의 **지금** 위치는 수집기 pt(id) 가 getBoundingClientRect 로 알려 준다
 * (마지막 스냅샷 좌표를 쓰지 않는다 — 미러가 늦어도 "그 노드" 를 가리키고, 원격이 움직였어도 정확하다).
 * id 0 은 원격 뷰포트 좌표 그대로.
 * 한글 IME: 조합 중 텍스트는 Input.imeSetComposition, 확정은 Input.insertText. 조합 중 ⌫·자모 분해는 사용자 PC 의 IME 가 끝내고 결과만 온다.
 * 정책: 붙여넣기(paste)는 ci, 원격 선택 복사(getsel)는 co — 막히면 원격에 아무것도 하지 않고 'blocked-*' 알림만.
 */
import type { Protocol } from 'cdp-protocol'
import { LIMITS, type ClientMsg, type PolicyInfo, type ServerMsg } from '../../protocol/vocab.ts'

type Sender = <T extends keyof Protocol.CommandParameters>(m: T, p?: Protocol.CommandParameters[T]) => Promise<Protocol.CommandReturnValues[T]>
/** 격리 world 에서 수집기 함수 호출(값 반환) */
export type WorldCall = <T>(expr: string) => Promise<T | undefined>

const BUTTONS: Record<string, Protocol.Input.MouseButton> = { left: 'left', right: 'right', middle: 'middle', none: 'none' }
const BIT: Record<string, number> = { left: 1, right: 2, middle: 4, none: 0 }

export class InputBridge {
  /** 마지막으로 원격에 적용을 끝낸 클라이언트 seq */
  appliedSeq = 0
  private buttonsDown = 0
  private pendingScroll = new Map<number, Extract<ClientMsg, { t: 'scroll' }>>()
  private scrolling = false
  /** 다음 틱에 수집기에 알릴 포인터 위치(:hover)·눌림(:active) */
  pointer: [number, number] | null = null
  pressed = false
  /** 값이 바뀌었을 수 있다 — 다음 틱에 val(로컬 에코 대조)을 보낸다 */
  valDirty = false
  /** 원격 마우스 이동 합치기: 처리 중이면 마지막 것만 */
  private moveBusy = false
  private moveNext: Extract<ClientMsg, { t: 'mouse' }> | null = null
  stats = { mouse: 0, keys: 0, text: 0, comp: 0, paste: 0, blocked: 0, missed: 0 }

  constructor(private send: Sender, private world: WorldCall, private pol: PolicyInfo, private notify: (m: ServerMsg) => void) {}

  /** 누를 때의 기준(노드 id·그때의 원격 사각형 왼쪽 위) — 드래그 중 이동·떼기는 이것을 쓴다 */
  private anchor: { id: number; x: number; y: number } | null = null

  private async toViewport(id: number, rx: number, ry: number, anchored = false): Promise<{ x: number; y: number } | undefined> {
    if (id === 0) return { x: Math.round(rx * 100) / 100, y: Math.round(ry * 100) / 100 }
    if (anchored && this.anchor && this.anchor.id === id) return { x: Math.round((this.anchor.x + rx) * 100) / 100, y: Math.round((this.anchor.y + ry) * 100) / 100 }
    const p = await this.world<[number, number] | null>(`__jwm.pt(${id | 0}, ${+rx}, ${+ry})`)
    if (!p) { this.stats.missed++; return undefined }
    return { x: p[0], y: p[1] }
  }

  private mark(seq: number): void { this.appliedSeq = Math.max(this.appliedSeq, seq) }

  async handle(m: ClientMsg): Promise<boolean> {
    switch (m.t) {
      case 'mouse': {
        if (m.type === 'move') {
          // 이동은 합친다 — 앞 이동을 처리하는 동안 온 것은 마지막 하나만
          if (this.moveBusy) { this.moveNext = m; return false }
          this.moveBusy = true
          try {
            let cur: typeof m | null = m
            while (cur) { this.moveNext = null; await this.mouse(cur); cur = this.moveNext }
          } finally { this.moveBusy = false }
          return true
        }
        // 누르기·떼기 전에 밀린 이동을 먼저(드래그 마지막 구간 누락 방지)
        if (this.moveNext) { const mv = this.moveNext; this.moveNext = null; await this.mouse(mv) }
        return this.mouse(m)
      }
      case 'key': {
        const hasText = !!m.text
        const p: Protocol.Input.dispatchKeyEventParameters = {
          type: m.type === 'up' ? 'keyUp' : hasText ? 'keyDown' : 'rawKeyDown',
          key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: m.mods || 0,
          autoRepeat: !!m.rep,
        }
        if (hasText && m.type === 'down') { p.text = m.text; p.unmodifiedText = m.text }
        // 편집 단축키는 Chromium 이 텍스트 입력 명령으로 처리하도록 알려 준다(Ctrl+A·Z·Y 등)
        const cmd = m.type === 'down' ? editCommand(m.key, m.mods || 0) : undefined
        if (cmd) p.commands = [cmd]
        await this.send('Input.dispatchKeyEvent', p)
        this.stats.keys++
        this.valDirty = true
        this.mark(m.seq)
        return true
      }
      case 'text':
        await this.send('Input.insertText', { text: m.text })
        this.stats.text++
        this.valDirty = true
        this.mark(m.seq)
        return true
      case 'paste':
        if (!this.pol.ci) { this.stats.blocked++; this.notify({ t: 'notice', k: 'blocked-clip-in' }); this.mark(m.seq); return false }
        await this.send('Input.insertText', { text: m.text })
        this.stats.paste++
        this.valDirty = true
        this.mark(m.seq)
        return true
      case 'comp':
        await this.send('Input.imeSetComposition', { text: m.text, selectionStart: m.ss, selectionEnd: m.se })
        this.stats.comp++
        this.valDirty = true
        this.mark(m.seq)
        return true
      case 'compend':
        // 확정: insertText 가 조합을 끝내며 문자열을 넣는다. 취소(빈 문자열)는 빈 조합으로 지운다.
        if (m.text) await this.send('Input.insertText', { text: m.text })
        else await this.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
        this.valDirty = true
        this.mark(m.seq)
        return true
      case 'getsel': {
        if (!this.pol.co) { this.stats.blocked++; this.notify({ t: 'notice', k: 'blocked-clip-out' }); return false }
        const text = (await this.world<string>('__jwm.selection()')) ?? ''
        this.notify({ t: 'clip', seq: m.seq, text: text.slice(0, LIMITS.maxPasteTotal) })
        return false
      }
      case 'scroll': {
        // 로컬 스크롤이 진실 → 원격은 **절대값**(휠 델타로 보내면 과주행한다). 연속 스크롤은 합친다.
        this.pendingScroll.set(m.id, m)
        if (this.scrolling) return false
        this.scrolling = true
        try {
          while (this.pendingScroll.size) {
            const [id, sm] = this.pendingScroll.entries().next().value as [number, Extract<ClientMsg, { t: 'scroll' }>]
            this.pendingScroll.delete(id)
            const sx = clamp(sm.sx, 0, 1e7), sy = clamp(sm.sy, 0, 1e7)
            await this.world(`__jwm.scrollNode(${id | 0}, ${sx}, ${sy})`)
            this.mark(sm.seq)
          }
        } finally { this.scrolling = false }
        return true
      }
      case 'resize':
        await this.send('Emulation.setDeviceMetricsOverride', { width: clamp(m.w, 320, 4096), height: clamp(m.h, 240, 4096), deviceScaleFactor: 1, mobile: false })
        return true
      default:
        return false
    }
  }

  private async mouse(m: Extract<ClientMsg, { t: 'mouse' }>): Promise<boolean> {
    const pt = await this.toViewport(m.id, m.rx, m.ry, !!m.an)
    if (!pt) { this.mark(m.seq); return false }
    if (m.type === 'down' && m.id) this.anchor = { id: m.id, x: pt.x - m.rx, y: pt.y - m.ry }
    const button = BUTTONS[m.button || 'left'] || 'left'
    if (m.type === 'down') this.buttonsDown |= BIT[button]
    if (m.type === 'up') this.buttonsDown &= ~BIT[button]
    const type = m.type === 'down' ? 'mousePressed' : m.type === 'up' ? 'mouseReleased' : m.type === 'move' ? 'mouseMoved' : 'mouseWheel'
    const p: Protocol.Input.dispatchMouseEventParameters = {
      type, x: pt.x, y: pt.y, modifiers: m.mods || 0,
      button: m.type === 'move' ? (this.buttonsDown ? firstButton(this.buttonsDown) : 'none') : m.type === 'wheel' ? 'none' : button,
      buttons: this.buttonsDown,
      clickCount: m.type === 'down' || m.type === 'up' ? (m.clicks || 1) : 0,
    }
    if (m.type === 'wheel') { p.deltaX = m.dx || 0; p.deltaY = m.dy || 0 }
    await this.send('Input.dispatchMouseEvent', p)
    this.stats.mouse++
    this.pointer = [pt.x, pt.y]
    if (m.type === 'down' || m.type === 'up') { this.pressed = true; this.valDirty = true }
    this.mark(m.seq)
    return true
  }
}

function firstButton(bits: number): Protocol.Input.MouseButton { return bits & 1 ? 'left' : bits & 2 ? 'right' : bits & 4 ? 'middle' : 'none' }

/** Ctrl(Meta)+키 → Chromium 편집 명령(원격이 macOS 가 아니라 Ctrl 기준) */
function editCommand(key: string, mods: number): string | undefined {
  const ctrl = (mods & 2) !== 0 || (mods & 4) !== 0
  const shift = (mods & 8) !== 0
  if (!ctrl) return undefined
  switch (key.toLowerCase()) {
    case 'a': return 'selectAll'
    case 'z': return shift ? 'redo' : 'undo'
    case 'y': return 'redo'
    default: return undefined
  }
}

function clamp(v: number, lo: number, hi: number): number { const n = Math.round(Number(v) || 0); return Math.max(lo, Math.min(hi, n)) }
