// ★ 생성됨 — 손으로 고치지 말 것. 원본: rbi/mirror/client/src/mirror-client.ts · 동기화: node rbi/mirror/scripts/sync-client.mjs
/**
 * 미러 클라이언트 — 닫힌 어휘를 받아 **스크립트 없는 iframe**(sandbox="allow-same-origin", CSP script-src 'none') 의 문서에 DOM 을 조립한다.
 * 프레임워크 없는 모듈: React 뷰어(frontend-react, 동기화된 사본)와 하네스가 같은 코드를 쓴다.
 *
 * 보안 불변식
 *  - 받는 모든 텍스트 메시지는 validateServerMsg(엄격)를 통과한 것만 적용 — 모르는 메시지·필드·값은 거부하고 센다(stats.rejected).
 *  - 문자열 → DOM 싱크 없음: createElement / createElementNS / createTextNode / textContent / style.setProperty(허용 키) / setAttribute(숫자·검증값) 만.
 *  - 이미지 URL 은 sha 로부터 클라이언트가 조립한다(`${base}/asset/${sha}`). 서버 문자열을 URL 로 쓰는 곳은 없다. 폰트는 view 문서의 @font-face 가 고정 키로만.
 *  - 입력 위젯 값은 텍스트 노드로만 그린다(속성 선택자 키로거 불가). 미러 안에는 포커스 가능한 요소가 없다 — 키는 부모의 숨은 input 이 받는다.
 *  - 상한: 메시지 크기·초당 메시지·노드 수(LIMITS). 인셋 프레임은 머리·WebP 서명을 검사한다.
 *  - 정책: 복사(co)가 꺼져 있으면 미러 선택 복사를 막고, 붙여넣기(ci)가 꺼져 있으면 보내지 않는다(에이전트도 한 번 더 막는다).
 */
import {
  INSET_FRAME_TAG, INSET_HEADER_BYTES, LIMITS, MAX_INSET_FRAME_BYTES, type ClientMsg, type DocInfo, type MsgReject, type NoticeKind, type PolicyInfo, type ServerMsg,
  type StyleRec, type SvgGeom, type VNode, fontFamilyCss, gradientCss, validateServerMsg,
} from './vocab'
import { LocalEcho, keyToOp, type EchoOp } from './local-echo'

export interface LatencySample { seq: number; kind: ClientMsg['t']; ms: number; via: 'patch' | 'tick' | 'val' }

export interface MirrorStats {
  connected: boolean
  nodes: number
  msgs: number
  bytesIn: number
  bytesText: number
  bytesInset: number
  insetFrames: number
  snapshots: number
  patches: number
  lastSnapMs: number
  rttMs: number
  applyMs: number
  maxApplyMs: number
  rejected: number
  rejectedNodes: number
  lastReject: string
  droppedRate: number
  echo: { match: number; mismatch: number; ops: number; suspended: number }
  url: string
  title: string
}

export interface MirrorNotice { k: NoticeKind; id?: string; name?: string; size?: number; detail?: string; multi?: boolean }

export interface MirrorClientOptions {
  iframe: HTMLIFrameElement
  wsUrl: string
  /** 세션 경로 접두어(끝에 / 없음) — 예: /rbi/<sid>. asset/·download/·upload/ 는 여기서 조립한다 */
  base: string
  /** 숨은 IME 입력창을 둘 부모 요소 */
  imeHost: HTMLElement
  onStats?: (s: MirrorStats) => void
  onLatency?: (s: LatencySample) => void
  onDoc?: (d: DocInfo) => void
  onPolicy?: (p: PolicyInfo) => void
  onNotice?: (n: MirrorNotice) => void
  /** 원격 alert/confirm/prompt — 신뢰 크롬이 묻는다 */
  onDialog?: (d: { k: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; msg: string; def?: string }) => Promise<{ ok: boolean; text?: string }>
  /** 원격 파일 선택 — 고른 파일(취소면 null) */
  onFileChooser?: (multi: boolean) => Promise<File[] | null>
  /** 연결 상태 바뀜(신뢰 크롬 표시용) */
  onConnection?: (connected: boolean, closedReason?: string) => void
}

interface Entry { node: VNode; el: HTMLElement | SVGSVGElement; spacer?: HTMLElement; inner?: HTMLImageElement }

const SVG_NS = 'http://www.w3.org/2000/svg'
const USER_SCROLL_GRACE_MS = 300
const TEXT_WIDGETS = new Set(['text', 'password', 'textarea'])
/** 브라우저가 가져야 하는 단축키(보내지 않는다) */
function browserReserved(ev: KeyboardEvent): boolean {
  const ctrl = ev.ctrlKey || ev.metaKey
  const k = ev.key.toLowerCase()
  if (ev.key === 'F5' || ev.key === 'F11' || ev.key === 'F12') return true
  if (ctrl && ['t', 'w', 'n', 'l', 'f', 'r', 'q', '+', '=', '-', '0', 'tab', 'pageup', 'pagedown'].includes(k)) return true
  if (ctrl && ev.shiftKey && ['i', 'j', 'c', 'n', 't', 'delete'].includes(k)) return true
  if (ev.altKey && (k === 'arrowleft' || k === 'arrowright' || k === 'f4')) return true
  return false
}

export class MirrorClient {
  private ws: WebSocket | null = null
  private doc: Document | null = null
  private root: HTMLElement | null = null
  private entries = new Map<number, Entry>()
  private insetUrls = new Map<number, string>()
  private seq = 0
  private pending = new Map<number, { at: number; kind: ClientMsg['t'] }>()
  private lastUserScroll = new Map<number, number>()
  private ime: HTMLInputElement
  private focusedWidget = 0
  private composing = false
  private moveTimer = 0
  private lastMove = 0
  private lastMoveEv: MouseEvent | null = null
  private wheelAcc: { id: number; rx: number; ry: number; dx: number; dy: number; mods: number } | null = null
  private wheelTimer = 0
  private pingTimer = 0
  private resizeObs: ResizeObserver | null = null
  private closed = false
  private rate = { at: 0, n: 0 }
  private keysDown = new Set<string>()
  private clipWaiters = new Map<number, (t: string) => void>()
  pol: PolicyInfo = { ci: false, co: false, dl: false, ul: false }
  docInfo: DocInfo | null = null
  readonly echo = new LocalEcho()
  stats: MirrorStats = {
    connected: false, nodes: 0, msgs: 0, bytesIn: 0, bytesText: 0, bytesInset: 0, insetFrames: 0, snapshots: 0, patches: 0, lastSnapMs: 0,
    rttMs: 0, applyMs: 0, maxApplyMs: 0, rejected: 0, rejectedNodes: 0, lastReject: '', droppedRate: 0, echo: this.echo.stats, url: '', title: '',
  }
  latency: LatencySample[] = []

  constructor(private opt: MirrorClientOptions) {
    this.ime = document.createElement('input')
    this.ime.type = 'text'
    this.ime.setAttribute('aria-label', 'remote input')
    this.ime.setAttribute('autocomplete', 'off')
    this.ime.setAttribute('autocorrect', 'off')
    this.ime.setAttribute('autocapitalize', 'off')
    this.ime.spellcheck = false
    const s = this.ime.style
    s.position = 'fixed'; s.left = '0px'; s.top = '0px'; s.width = '2px'; s.height = '2px'; s.opacity = '0'
    s.border = '0'; s.padding = '0'; s.margin = '0'; s.zIndex = '-1'; s.pointerEvents = 'none'; s.caretColor = 'transparent'
    opt.imeHost.appendChild(this.ime)
    this.bindIme()
  }

  // ── 연결 ──
  private onLoad: (() => void) | null = null

  start(): void {
    const f = this.opt.iframe
    const ready = () => { if (!this.closed && f.contentDocument?.getElementById('root') && this.doc !== f.contentDocument) this.onFrameReady() }
    this.onLoad = ready
    f.addEventListener('load', ready)
    ready()
  }

  private onFrameReady(): void {
    if (this.closed) return
    const d = this.opt.iframe.contentDocument!
    this.doc = d
    this.root = d.getElementById('root') as HTMLElement
    this.entries.clear()
    this.bindFrameEvents(d)
    this.connect()
    this.resizeObs?.disconnect()
    this.resizeObs = new ResizeObserver(() => this.sendResize())
    this.resizeObs.observe(this.opt.iframe)
  }

  private connect(): void {
    if (this.closed) return
    const ws = new WebSocket(this.opt.wsUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.stats.connected = true; this.sendResize()
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', ts: Math.round(performance.now() * 1000) / 1000 }), 3000)
      this.send({ t: 'ping', ts: Math.round(performance.now() * 1000) / 1000 })
      this.opt.onConnection?.(true); this.emitStats()
    }
    ws.onclose = ev => {
      this.stats.connected = false; window.clearInterval(this.pingTimer); this.emitStats()
      // 4000: 다른 뷰어가 세션을 가져감 — 서로 뺏지 않는다 · 4001: 유휴 종료
      if (ev.code === 4000 || ev.code === 4001) this.closed = true
      this.opt.onConnection?.(false, ev.code === 4000 ? 'replaced' : ev.code === 4001 ? 'idle' : undefined)
      if (!this.closed) window.setTimeout(() => this.connect(), 1500)
    }
    ws.onmessage = ev => this.onMessage(ev.data)
  }

  stop(): void {
    this.closed = true
    // React StrictMode 는 effect 를 두 번 돌린다 — 멈춘 클라이언트가 나중의 iframe load 에 다시 붙지 않게
    if (this.onLoad) { this.opt.iframe.removeEventListener('load', this.onLoad); this.onLoad = null }
    this.ws?.close()
    this.resizeObs?.disconnect()
    window.clearInterval(this.pingTimer)
    for (const u of this.insetUrls.values()) URL.revokeObjectURL(u)
    this.ime.remove()
  }

  private send(m: ClientMsg): number {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return 0
    const s = JSON.stringify(m)
    // 상한은 바이트(UTF-8) — 넘으면 에이전트가 연결을 끊는다(1009). 긴 것만 인코딩해 잰다
    if (s.length * 3 > LIMITS.maxClientMsgBytes && new TextEncoder().encode(s).length > LIMITS.maxClientMsgBytes) return 0
    this.ws.send(s)
    return 'seq' in m ? m.seq : 0
  }
  private nextSeq(kind: ClientMsg['t']): number {
    const s = ++this.seq
    this.pending.set(s, { at: performance.now(), kind })
    if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value!)
    return s
  }
  private sendResize(): void {
    const r = this.opt.iframe.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) this.send({ t: 'resize', w: Math.round(r.width), h: Math.round(r.height) })
  }
  resync(): void { this.send({ t: 'resync' }) }
  focusInput(): void { this.ime.focus({ preventScroll: true }) }

  // ── 수신 ──
  private onMessage(data: string | ArrayBuffer): void {
    this.stats.msgs++
    // 초당 메시지 상한 — 넘는 것은 버린다(인셋 프레임이 먼저 버려지도록 바이너리는 더 일찍)
    const now = performance.now()
    if (now - this.rate.at > 1000) { this.rate.at = now; this.rate.n = 0 }
    this.rate.n++
    if (typeof data !== 'string') {
      if (this.rate.n > LIMITS.serverMsgsPerSec * 0.75) { this.stats.droppedRate++; return }
      this.stats.bytesIn += data.byteLength; this.stats.bytesInset += data.byteLength; this.onInsetFrame(data); return
    }
    if (this.rate.n > LIMITS.serverMsgsPerSec * 2) { this.stats.droppedRate++; return }
    this.stats.bytesIn += data.length; this.stats.bytesText += data.length
    if (data.length > LIMITS.maxServerMsgBytes) { this.reject('too large'); return }
    let raw: unknown
    try { raw = JSON.parse(data) } catch { this.reject('json'); return }
    const rej: MsgReject = { why: '', rejectedNodes: 0 }
    const m = validateServerMsg(raw, rej)
    if (rej.rejectedNodes) { this.stats.rejectedNodes += rej.rejectedNodes; this.stats.lastReject = rej.why }
    if (!m) { this.reject(rej.why || 'invalid'); return }
    const t0 = performance.now()
    switch (m.t) {
      case 'hello': this.pol = m.pol; this.opt.onPolicy?.(m.pol); this.applyPolicyToFrame(); break
      case 'snapshot': {
        this.clear()
        this.applyDoc(m.doc)
        this.applyNodes(m.nodes, [], [])
        this.stats.snapshots++; this.stats.lastSnapMs = m.ms
        this.settleLatency(m.iseq, 'patch')
        break
      }
      case 'patch':
        if (m.doc) this.applyDoc(m.doc)
        this.applyNodes(m.add, m.upd, m.del)
        this.stats.patches++; this.stats.lastSnapMs = m.ms
        this.settleLatency(m.iseq, 'patch')
        break
      case 'tick':
        this.stats.lastSnapMs = m.ms
        this.settleLatency(m.iseq, 'tick')
        break
      case 'focus': this.onRemoteFocus(m.id); break
      case 'val': {
        const ok = this.echo.reconcile(m.id, m.iseq, m.vh, m.n, m.ss, m.se, m.v)
        if (ok !== null) { const e = this.entries.get(m.id); if (e) this.renderWidget(e) }
        this.settleLatency(m.iseq, 'val')
        break
      }
      case 'clip': { const w = this.clipWaiters.get(m.seq); if (w) { this.clipWaiters.delete(m.seq); w(m.text) } break }
      case 'notice': void this.onNotice(m); break
      case 'dialog': void this.onDialog(m); break
      case 'pong': this.stats.rttMs = Math.round((performance.now() - m.ts) * 10) / 10; break
      case 'error': break
    }
    const applyMs = performance.now() - t0
    this.stats.applyMs = Math.round(applyMs * 100) / 100
    this.stats.maxApplyMs = Math.max(this.stats.maxApplyMs, this.stats.applyMs)
    this.stats.nodes = this.entries.size
    this.emitStats()
  }

  private reject(why: string): void { this.stats.rejected++; this.stats.lastReject = why; this.emitStats() }

  private settleLatency(iseq: number, via: LatencySample['via']): void {
    const now = performance.now()
    for (const [seq, p] of this.pending) {
      if (seq <= iseq) {
        const s: LatencySample = { seq, kind: p.kind, ms: Math.round((now - p.at) * 10) / 10, via }
        this.latency.push(s); if (this.latency.length > 2000) this.latency.shift()
        this.opt.onLatency?.(s)
        this.pending.delete(seq)
      }
    }
  }

  private emitStats(): void { this.opt.onStats?.({ ...this.stats }) }

  private clear(): void {
    if (!this.root) return
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild)
    this.entries.clear()
    for (const u of this.insetUrls.values()) URL.revokeObjectURL(u)
    this.insetUrls.clear()
    this.echo.stop()
    this.focusedWidget = 0
  }

  private applyPolicyToFrame(): void {
    // 복사 정책이 꺼져 있으면 미러 전체를 선택 불가(view 문서 CSS 도 같은 규칙을 이미 건다 — 두 겹)
    if (this.doc?.body) this.doc.body.style.setProperty('user-select', this.pol.co ? '' : 'none')
  }

  private applyDoc(d: DocInfo): void {
    if (!this.root || !this.doc) return
    this.docInfo = d
    this.stats.url = d.url; this.stats.title = d.title
    this.root.style.width = `${d.cw}px`; this.root.style.height = `${d.ch}px`
    this.doc.body.style.backgroundColor = d.bg || ''
    this.doc.documentElement.style.backgroundColor = d.bg || ''
    const w = this.doc.defaultView!
    const lu = this.lastUserScroll.get(0) || 0
    if (performance.now() - lu > USER_SCROLL_GRACE_MS && (Math.abs(w.scrollX - d.sx) > 1 || Math.abs(w.scrollY - d.sy) > 1)) w.scrollTo(d.sx, d.sy)
    this.opt.onDoc?.(d)
  }

  // ── 노드 적용 ──
  private applyNodes(add: VNode[], upd: VNode[], del: number[]): void {
    for (const id of del) this.removeNode(id)
    const touched: VNode[] = []
    for (const n of add.concat(upd)) {
      if (!this.entries.has(n.id) && this.entries.size >= LIMITS.maxNodes) { this.stats.rejectedNodes++; continue }
      this.upsert(n)
      touched.push(n)
    }
    // 부모가 나중에 온 노드를 제자리로(같은 패치 안에서 순서가 섞여 와도)
    for (const n of touched) this.place(n.id)
    for (const n of touched) { const e = this.entries.get(n.id); if (e?.node.sc) this.applyScroll(e) }
  }

  private removeNode(id: number): void {
    const e = this.entries.get(id)
    if (!e) return
    // 자식이 남아 있으면 루트로 옮겨 두지 않는다 — 서버가 함께 del 을 보낸다. 같이 지워진다(DOM 서브트리)
    e.el.remove()
    this.entries.delete(id)
    const u = this.insetUrls.get(id); if (u) { URL.revokeObjectURL(u); this.insetUrls.delete(id) }
    if (this.echo.id === id) this.echo.stop()
    if (this.focusedWidget === id) this.focusedWidget = 0
  }

  private upsert(n: VNode): void {
    const d = this.doc!
    let e = this.entries.get(n.id)
    if (e && (e.node.k !== n.k)) { this.removeNode(n.id); e = undefined }
    if (!e) {
      const el = this.createEl(d, n)
      el.dataset.id = String(n.id)
      e = { node: n, el }
      if (n.k === 'inset') { const im = d.createElement('img'); im.alt = ''; im.draggable = false; el.appendChild(im); e.inner = im }
      this.entries.set(n.id, e)
    } else e.node = n
    this.render(e)
  }

  private createEl(d: Document, n: VNode): HTMLElement | SVGSVGElement {
    switch (n.k) {
      case 'svg': { const s = d.createElementNS(SVG_NS, 'svg'); s.classList.add('m'); return s }
      case 'img': { const i = d.createElement('img'); i.className = 'm i'; i.draggable = false; i.alt = ''; return i }
      case 'inset': { const i = d.createElement('div'); i.className = 'm in'; return i }
      case 'widget': { const w = d.createElement('div'); w.className = 'm w'; return w }
      default: { const b = d.createElement('div'); b.className = 'm'; return b }
    }
  }

  private orderKey(el: Element): number { const id = (el as HTMLElement).dataset?.id; const e = id ? this.entries.get(+id) : undefined; return e?.node.o ?? 0 }

  /** 부모 안 제자리(o 순서)에 붙이고 위치·변환을 건다. x,y 는 이미 부모 기준 지역 좌표다 */
  private place(id: number): void {
    const e = this.entries.get(id)
    if (!e || !this.root) return
    const n = e.node
    const pe = n.p ? this.entries.get(n.p) : undefined
    const parentEl = pe ? pe.el : this.root
    const key = n.o ?? 0
    if (e.el.parentNode !== parentEl || !this.inOrder(e.el, key)) {
      // 대부분 끝에 붙는다(스냅샷은 문서 순서) — 끝 형제부터 본다
      const last = this.lastOrdered(parentEl)
      if (!last || this.orderKey(last) <= key) parentEl.insertBefore(e.el, pe?.spacer ?? null)
      else {
        let ref: Element | null = null
        for (let c = parentEl.firstElementChild; c; c = c.nextElementSibling) {
          if (c === e.el || !(c as HTMLElement).dataset?.id) continue
          if (this.orderKey(c) > key) { ref = c; break }
        }
        parentEl.insertBefore(e.el, ref)
      }
    }
    const st = (e.el as HTMLElement).style
    st.left = `${n.x}px`; st.top = `${n.y}px`
    st.position = n.fx ? 'fixed' : ''
    if (n.m) { st.transform = `matrix(${n.m.join(',')},0,0)`; st.transformOrigin = '50% 50%' } else { st.transform = ''; st.transformOrigin = '' }
    st.zIndex = n.zi !== undefined ? String(n.zi) : ''
  }
  private lastOrdered(parent: Element): Element | null {
    for (let c = parent.lastElementChild; c; c = c.previousElementSibling) if ((c as HTMLElement).dataset?.id) return c
    return null
  }
  private inOrder(el: Element, key: number): boolean {
    let prev = el.previousElementSibling
    while (prev && !(prev as HTMLElement).dataset?.id) prev = prev.previousElementSibling
    let next = el.nextElementSibling
    while (next && !(next as HTMLElement).dataset?.id) next = next.nextElementSibling
    return (!prev || this.orderKey(prev) <= key) && (!next || this.orderKey(next) >= key)
  }

  private render(e: Entry): void {
    const n = e.node
    const el = e.el as HTMLElement
    const st = el.style
    st.width = `${Math.max(0, n.w)}px`; st.height = `${Math.max(0, n.h)}px`
    this.applyStyle(el, n.s, n)
    switch (n.k) {
      case 'text': this.renderText(e); break
      case 'img': {
        const img = el as HTMLImageElement
        const want = n.a ? `${this.opt.base}/asset/${n.a}` : ''
        if (img.getAttribute('src') !== want) { if (want) img.setAttribute('src', want); else img.removeAttribute('src') }
        break
      }
      case 'svg': this.renderSvg(e); break
      case 'widget': this.renderWidget(e); break
      case 'inset': if (!n.s?.bg) st.backgroundColor = '#111'; break
      default: break
    }
    if (n.sc) {
      st.overflow = 'auto'
      if (!e.spacer) {
        e.spacer = this.doc!.createElement('div'); e.spacer.className = 'sp'; el.appendChild(e.spacer)
        el.addEventListener('scroll', () => this.onLocalScroll(n.id, el), { passive: true })
      }
      e.spacer.style.left = `${Math.max(0, n.sc[0] - 1)}px`; e.spacer.style.top = `${Math.max(0, n.sc[1] - 1)}px`
    } else if (e.spacer) { e.spacer.remove(); e.spacer = undefined; st.overflow = n.s?.clip ? 'hidden' : '' }
  }

  private applyScroll(e: Entry): void {
    const n = e.node, el = e.el as HTMLElement
    if (!n.sc) return
    const lu = this.lastUserScroll.get(n.id) || 0
    if (performance.now() - lu > USER_SCROLL_GRACE_MS) {
      if (Math.abs(el.scrollLeft - n.sc[2]) > 1) el.scrollLeft = n.sc[2]
      if (Math.abs(el.scrollTop - n.sc[3]) > 1) el.scrollTop = n.sc[3]
    }
  }

  private applyStyle(el: HTMLElement, s: StyleRec | undefined, n: VNode): void {
    const st = el.style
    // 전부 setProperty — 문자열 CSS 블록을 쓰는 곳 없음. 값은 validateStyle(엄격)을 통과한 것만 들어온다.
    st.setProperty('background-color', s?.bg ?? '')
    if (s?.bgl?.length) {
      st.setProperty('background-image', s.bgl.map(l => (l.i ? `url("${this.opt.base}/asset/${l.i}")` : l.g ? gradientCss(l.g) : 'none')).join(', '))
      st.setProperty('background-size', s.bgl.map(l => (l.sz === undefined ? 'auto' : typeof l.sz === 'string' ? l.sz : `${l.sz[1] === 'auto' ? 'auto' : `${l.sz[0]}${l.sz[1]}`} ${l.sz[3] === 'auto' ? 'auto' : `${l.sz[2]}${l.sz[3]}`}`)).join(', '))
      st.setProperty('background-position', s.bgl.map(l => (l.ps ? `${l.ps[0]}${l.ps[1]} ${l.ps[2]}${l.ps[3]}` : '0% 0%')).join(', '))
      st.setProperty('background-repeat', s.bgl.map(l => l.rp ?? 'repeat').join(', '))
    } else { st.setProperty('background-image', ''); st.setProperty('background-size', ''); st.setProperty('background-position', ''); st.setProperty('background-repeat', '') }
    const texty = n.k === 'text' || n.k === 'widget'
    if (texty) {
      st.setProperty('color', s?.c ?? '')
      st.setProperty('font-family', fontFamilyCss(s?.pf))
      st.setProperty('font-size', s?.fs !== undefined ? `${s.fs}px` : '')
      st.setProperty('font-weight', s?.fw !== undefined ? String(s.fw) : '')
      st.setProperty('font-style', s?.fi ?? '')
      st.setProperty('text-decoration-line', s?.td ?? '')
      st.setProperty('text-decoration-color', s?.tdc ?? '')
      st.setProperty('text-transform', s?.tt ?? '')
      st.setProperty('letter-spacing', s?.ls !== undefined ? `${s.ls}px` : '')
    }
    if (s?.bw && s.bs && s.bc) {
      const sides = ['top', 'right', 'bottom', 'left'] as const
      sides.forEach((side, i) => { st.setProperty(`border-${side}`, `${s.bw![i]}px ${s.bs![i]} ${s.bc![i]}`) })
    } else st.setProperty('border', '0')
    st.setProperty('border-radius', s?.br ? s.br.map(r => `${r}px`).join(' ') : '')
    st.setProperty('opacity', s?.op !== undefined ? String(s.op) : '')
    st.setProperty('box-shadow', s?.sh ?? '')
    st.setProperty('outline', s?.ol ? `${s.ol[0]}px ${s.ol[1]} ${s.ol[2]}` : '')
    st.setProperty('cursor', s?.cur ?? (n.k === 'text' ? 'text' : ''))
    // visibility·pointer-events 는 상속된다 — 원격 계산값을 매 노드에 명시해야 부모와 다를 때 맞는다
    st.setProperty('visibility', s?.hid ? 'hidden' : 'visible')
    st.setProperty('pointer-events', s?.pe ? 'none' : 'auto')
    st.setProperty('user-select', s?.nosel ? 'none' : '')
    st.setProperty('text-align', s?.ta ?? '')
    if (!n.sc) st.setProperty('overflow', s?.clip && (n.k === 'box' || n.k === 'img') ? 'hidden' : '')
  }

  private renderText(e: Entry): void {
    const n = e.node, d = this.doc!
    const el = e.el as HTMLElement
    const runs = n.runs || []
    while (el.childElementCount > runs.length) el.lastElementChild!.remove()
    while (el.childElementCount < runs.length) { const s = d.createElement('span'); s.className = 't'; s.dataset.id = String(n.id); el.appendChild(s) }
    runs.forEach((r, i) => {
      const s = el.children[i] as HTMLElement
      s.style.left = `${r.x}px`; s.style.top = `${r.y}px`
      s.style.height = `${r.h}px`; s.style.lineHeight = `${r.h}px`
      s.style.minWidth = `${r.w}px`
      s.style.pointerEvents = n.s?.pe ? 'none' : 'auto'
      s.dataset.rw = String(r.w)
      if (s.textContent !== r.t) s.textContent = r.t
    })
    el.style.pointerEvents = 'none'
  }

  private renderWidget(e: Entry): void {
    const n = e.node, d = this.doc!
    const el = e.el as HTMLElement
    while (el.firstChild) el.removeChild(el.firstChild)
    const pd = n.s?.pd
    el.style.padding = pd ? `${pd[0]}px ${pd[1]}px ${pd[2]}px ${pd[3]}px` : ''
    el.style.justifyContent = ''
    el.style.alignItems = ''
    const span = (t: string, cls = '') => { const s = d.createElement('span'); if (cls) s.className = cls; s.textContent = t; s.style.pointerEvents = 'none'; return s }
    const focused = this.focusedWidget === n.id && !n.wdis
    switch (n.wk) {
      // 체크박스·라디오·슬라이더는 Chromium 기본 모양을 상자로 그린다(원격도 같은 Chromium — 색은 기본 accent)
      case 'checkbox': case 'radio': {
        el.style.justifyContent = 'center'
        const b = d.createElement('span'), s = b.style, sz = Math.max(8, Math.min(16, Math.min(n.w, n.h) - 1))
        s.display = 'inline-block'; s.width = s.height = `${sz}px`; s.boxSizing = 'border-box'; s.pointerEvents = 'none'
        s.border = `1px solid ${n.wc ? '#0075ff' : '#767676'}`; s.borderRadius = n.wk === 'radio' ? '50%' : '2px'
        s.background = n.wc && n.wk === 'checkbox' ? '#0075ff' : '#fff'
        if (n.wc && n.wk === 'checkbox') { b.textContent = '✓'; s.color = '#fff'; s.fontSize = `${sz - 3}px`; s.lineHeight = `${sz - 2}px`; s.textAlign = 'center'; s.fontWeight = '700' }
        if (n.wc && n.wk === 'radio') { const dot = d.createElement('span'), ds = dot.style; ds.display = 'block'; ds.width = ds.height = `${Math.round(sz / 2)}px`; ds.margin = `${Math.round(sz / 4) - 1}px auto`; ds.borderRadius = '50%'; ds.background = '#0075ff'; b.appendChild(dot) }
        el.appendChild(b)
        break
      }
      case 'range': {
        const f = n.wr ?? 0.5
        const track = d.createElement('span'), ts = track.style
        ts.position = 'absolute'; ts.left = '0'; ts.right = '0'; ts.top = '50%'; ts.height = '4px'; ts.marginTop = '-2px'; ts.borderRadius = '2px'; ts.pointerEvents = 'none'
        ts.background = `linear-gradient(90deg, #0075ff ${f * 100}%, #efefef ${f * 100}%)`
        const th = d.createElement('span'), hs = th.style
        hs.position = 'absolute'; hs.top = '50%'; hs.width = hs.height = '16px'; hs.marginTop = '-8px'; hs.borderRadius = '50%'; hs.background = '#0075ff'; hs.pointerEvents = 'none'
        hs.left = `calc(${f * 100}% - ${f * 16}px)`
        el.appendChild(track); el.appendChild(th)
        break
      }
      case 'select': el.appendChild(span(`${n.wopt ?? ''}`)); { const ar = span(' ▾'); ar.style.marginLeft = 'auto'; el.appendChild(ar) } break
      case 'button': el.appendChild(span(n.wv ?? '')); el.style.justifyContent = n.s?.ta === 'left' ? 'flex-start' : n.s?.ta === 'right' ? 'flex-end' : 'center'; break
      default: {
        el.style.justifyContent = n.s?.ta === 'center' ? 'center' : n.s?.ta === 'right' ? 'flex-end' : 'flex-start'
        if (n.wk === 'textarea') { el.style.alignItems = 'flex-start'; el.style.whiteSpace = 'pre-wrap' } else el.style.whiteSpace = 'pre'
        const echoOn = focused && this.echo.id === n.id
        if (echoOn) {
          const v = this.echo.view()
          if (!v.value && n.wph && !v.comp) { el.appendChild(span('', 'cr')); el.appendChild(span(n.wph, 'ph')); break }
          el.appendChild(span(v.before))
          if (v.comp) el.appendChild(span(v.comp, 'co'))
          if (v.selected) { const s = span(v.selected); s.style.background = 'Highlight'; s.style.color = 'HighlightText'; el.appendChild(s) }
          if (v.caret) el.appendChild(span('', 'cr'))
          el.appendChild(span(v.after))
        } else if (n.wv) el.appendChild(span(n.wv))
        else if (n.wph) el.appendChild(span(n.wph, 'ph'))
        else if (focused) el.appendChild(span('', 'cr'))
      }
    }
    el.style.cursor = n.wk === 'text' || n.wk === 'password' || n.wk === 'textarea' ? 'text' : 'default'
    if (n.wdis) el.style.opacity = '0.6'
  }

  private renderSvg(e: Entry): void {
    const n = e.node
    const svg = e.el as SVGSVGElement
    svg.setAttribute('width', String(Math.max(0, n.w)))
    svg.setAttribute('height', String(Math.max(0, n.h)))
    svg.setAttribute('viewBox', n.vb ? n.vb.join(' ') : `0 0 ${Math.max(1, n.w)} ${Math.max(1, n.h)}`)
    svg.style.overflow = 'visible'
    svg.style.pointerEvents = n.s?.pe ? 'none' : 'auto'
    while (svg.firstChild) svg.removeChild(svg.firstChild)
    for (const g of n.g || []) svg.appendChild(this.buildGeom(g))
  }

  private buildGeom(g: SvgGeom): SVGElement {
    const d = this.doc!
    const el = d.createElementNS(SVG_NS, g.k)
    const num = (k: string, v: number) => el.setAttribute(k, String(v))
    switch (g.k) {
      case 'path': el.setAttribute('d', g.d); break
      case 'line': num('x1', g.x1); num('y1', g.y1); num('x2', g.x2); num('y2', g.y2); break
      case 'rect': num('x', g.x); num('y', g.y); num('width', g.w); num('height', g.h); if (g.rx !== undefined) num('rx', g.rx); if (g.ry !== undefined) num('ry', g.ry); break
      case 'circle': num('cx', g.cx); num('cy', g.cy); num('r', g.r); break
      case 'ellipse': num('cx', g.cx); num('cy', g.cy); num('rx', g.rx); num('ry', g.ry); break
      case 'polyline': case 'polygon': el.setAttribute('points', g.pts); break
      case 'g': for (const c of g.ch) el.appendChild(this.buildGeom(c)); break
      case 'text': {
        num('x', g.x); num('y', g.y)
        el.textContent = g.t
        const s = (el as SVGElement).style
        if (g.fs !== undefined) s.setProperty('font-size', `${g.fs}px`)
        if (g.fw !== undefined) s.setProperty('font-weight', String(g.fw))
        s.setProperty('font-family', fontFamilyCss(g.pf))
        if (g.anc) el.setAttribute('text-anchor', g.anc)
        break
      }
    }
    const st = g.st
    if (st.f !== undefined) el.setAttribute('fill', st.f)
    if (st.s !== undefined) el.setAttribute('stroke', st.s)
    if (st.sw !== undefined) num('stroke-width', st.sw)
    if (st.op !== undefined) num('opacity', st.op)
    if (st.da) el.setAttribute('stroke-dasharray', st.da)
    if (st.tr) el.setAttribute('transform', st.tr)
    if (st.lc) el.setAttribute('stroke-linecap', st.lc)
    if (st.lj) el.setAttribute('stroke-linejoin', st.lj)
    return el
  }

  private onInsetFrame(buf: ArrayBuffer): void {
    if (buf.byteLength <= INSET_HEADER_BYTES + 12 || buf.byteLength > MAX_INSET_FRAME_BYTES) { this.reject('inset size'); return }
    const dv = new DataView(buf)
    if (dv.getUint8(0) !== INSET_FRAME_TAG) { this.reject('inset tag'); return }
    // WebP 서명 RIFF....WEBP
    const sig = new Uint8Array(buf, INSET_HEADER_BYTES, 12)
    if (!(sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46 && sig[8] === 0x57 && sig[9] === 0x45 && sig[10] === 0x42 && sig[11] === 0x50)) { this.reject('inset sig'); return }
    const id = dv.getUint32(1)
    const w = dv.getUint16(9), h = dv.getUint16(11), dx = dv.getInt16(13), dy = dv.getInt16(15)
    const e = this.entries.get(id)
    this.stats.insetFrames++
    if (!e || e.node.k !== 'inset' || !e.inner) return
    const url = URL.createObjectURL(new Blob([buf.slice(INSET_HEADER_BYTES)], { type: 'image/webp' }))
    const prev = this.insetUrls.get(id)
    this.insetUrls.set(id, url)
    const img = e.inner
    img.onload = () => { if (prev) URL.revokeObjectURL(prev) }
    img.style.left = `${dx}px`; img.style.top = `${dy}px`; img.style.width = `${w}px`; img.style.height = `${h}px`
    img.src = url
  }

  // ── 알림·대화상자·파일 ──
  private async onNotice(m: Extract<ServerMsg, { t: 'notice' }>): Promise<void> {
    const n: MirrorNotice = { k: m.k }
    if (m.id) n.id = m.id
    if (m.name !== undefined) n.name = m.name
    if (m.size !== undefined) n.size = m.size
    if (m.detail !== undefined) n.detail = m.detail
    if (m.multi !== undefined) n.multi = m.multi
    if (m.k === 'filechooser' && m.id) {
      const files = this.opt.onFileChooser ? await this.opt.onFileChooser(!!m.multi).catch(() => null) : null
      if (!files || !files.length) { this.send({ t: 'chooser', id: m.id, cancel: true }); return }
      const list = m.multi ? files : files.slice(0, 1)
      for (let i = 0; i < list.length; i++) {
        const f = list[i]
        if (f.size > LIMITS.maxUploadBytes) { this.opt.onNotice?.({ k: 'limit', detail: 'upload', name: f.name }); this.send({ t: 'chooser', id: m.id, cancel: true }); return }
        const r = await fetch(`${this.opt.base}/upload/${m.id}`, {
          method: 'POST', body: f, credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/octet-stream', 'x-upload-name': encodeURIComponent(f.name.slice(0, 200)), 'x-upload-last': i === list.length - 1 ? '1' : '0' },
        }).catch(() => null)
        if (!r || !r.ok) { this.opt.onNotice?.({ k: 'limit', detail: `upload ${r?.status ?? 'error'}`, name: f.name }); return }
      }
      return
    }
    this.opt.onNotice?.(n)
  }

  /** 정책이 허용한 다운로드 주소(신뢰 크롬이 링크로 보인다) */
  downloadUrl(id: string): string { return /^[0-9a-f]{32}$/.test(id) ? `${this.opt.base}/download/${id}` : '' }

  private async onDialog(m: Extract<ServerMsg, { t: 'dialog' }>): Promise<void> {
    const r = this.opt.onDialog ? await this.opt.onDialog({ k: m.k, msg: m.msg, def: m.def }).catch(() => ({ ok: false })) : { ok: m.k === 'alert' }
    const out: ClientMsg = { t: 'dialog', id: m.id, ok: r.ok }
    if (m.k === 'prompt' && r.ok && typeof (r as { text?: string }).text === 'string') out.text = ((r as { text?: string }).text as string).slice(0, 4000)
    this.send(out)
  }

  // ── 입력 ──
  private targetOf(ev: Event): { id: number; el: HTMLElement } | null {
    let t = ev.target as HTMLElement | null
    while (t && t !== this.root) {
      const id = t.dataset?.id
      if (id) return { id: parseInt(id, 10), el: t }
      t = t.parentElement
    }
    return null
  }

  private mods(ev: MouseEvent | KeyboardEvent | WheelEvent): number { return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0) }

  private rel(ev: MouseEvent): { id: number; rx: number; ry: number } {
    const tg = this.targetOf(ev)
    if (!tg) return { id: 0, rx: ev.clientX, ry: ev.clientY }
    const e = this.entries.get(tg.id)
    // 텍스트 런 span 이면 그 텍스트 노드 상자 기준(원격 pt() 도 텍스트 노드 상자 기준)
    const box = (e && e.el !== tg.el ? e.el : tg.el) as HTMLElement
    const r = box.getBoundingClientRect()
    return { id: tg.id, rx: Math.round((ev.clientX - r.left) * 10) / 10, ry: Math.round((ev.clientY - r.top) * 10) / 10 }
  }

  /** 누를 때의 기준 — 버튼을 누른 동안 이동·떼기는 이 노드의 누를 때 사각형 기준으로 보낸다(원격도 같은 기준을 기억 — 드래그 과주행 방지) */
  private anchor: { id: number; left: number; top: number } | null = null

  private mouseMsg(type: 'down' | 'up' | 'move', ev: MouseEvent): void {
    const button = ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left'
    const seq = this.nextSeq('mouse')
    const base = { button, buttons: ev.buttons & 31, clicks: type === 'move' ? 0 : Math.max(1, Math.min(3, ev.detail || 1)), mods: this.mods(ev), seq } as const
    if (this.anchor && type !== 'down' && (ev.buttons || type === 'up')) {
      const a = this.anchor
      if (type === 'up') this.anchor = null
      this.send({ t: 'mouse', type, id: a.id, rx: Math.round((ev.clientX - a.left) * 10) / 10, ry: Math.round((ev.clientY - a.top) * 10) / 10, an: true, ...base })
      return
    }
    const { id, rx, ry } = this.rel(ev)
    if (type === 'down') this.anchor = id ? { id, left: ev.clientX - rx, top: ev.clientY - ry } : null
    this.send({ t: 'mouse', type, id, rx, ry, ...base })
  }

  /** 휠: 미러 안에서 그 방향으로 스크롤할 수 있는 상자가 있으면 로컬(스크롤 이벤트로 동기화), 없거나 Ctrl 이면 원격으로 */
  private canScrollLocally(ev: WheelEvent): boolean {
    if (ev.ctrlKey || ev.metaKey) return false
    const d = this.doc!
    for (let t = ev.target as HTMLElement | null; t && t !== d.documentElement; t = t.parentElement) {
      if (t.style?.overflow === 'auto') {
        if (ev.deltaY > 0 && t.scrollTop + t.clientHeight < t.scrollHeight - 1) return true
        if (ev.deltaY < 0 && t.scrollTop > 0) return true
        if (ev.deltaX > 0 && t.scrollLeft + t.clientWidth < t.scrollWidth - 1) return true
        if (ev.deltaX < 0 && t.scrollLeft > 0) return true
      }
    }
    const w = d.defaultView!, se = d.scrollingElement || d.documentElement
    if (ev.deltaY > 0 && w.scrollY + w.innerHeight < se.scrollHeight - 1) return true
    if (ev.deltaY < 0 && w.scrollY > 0) return true
    if (ev.deltaX > 0 && w.scrollX + w.innerWidth < se.scrollWidth - 1) return true
    if (ev.deltaX < 0 && w.scrollX > 0) return true
    return false
  }

  private bindFrameEvents(d: Document): void {
    d.addEventListener('mousedown', ev => {
      const tg = this.targetOf(ev)
      const e = tg ? this.entries.get(tg.id) : undefined
      const wasFocus = this.focusedWidget
      this.focusedWidget = e && e.node.k === 'widget' && !e.node.wdis ? e.node.id : 0
      if (this.focusedWidget && e) this.startEcho(e.node)
      else if (!this.focusedWidget) this.echo.stop()
      this.mouseMsg('down', ev)
      this.positionIme(e)
      this.ime.focus({ preventScroll: true })
      // 텍스트 런 위가 아니면 브라우저 기본 동작(선택 시작·네이티브 드래그·가운데 버튼 자동 스크롤)을 막는다 — 드래그는 원격에서 일어난다
      const onText = (ev.target as HTMLElement)?.classList?.contains('t')
      if (!onText || (e && e.node.k === 'widget') || ev.button !== 0) ev.preventDefault()
      if (wasFocus !== this.focusedWidget) for (const id of [wasFocus, this.focusedWidget]) { const w = this.entries.get(id); if (w && w.node.k === 'widget') this.renderWidget(w) }
    })
    d.addEventListener('mouseup', ev => {
      // 미뤄 둔 이동이 있으면 먼저 — 드래그 마지막 구간이 빠지지 않게(P0 실측 5px)
      if (this.moveTimer) { window.clearTimeout(this.moveTimer); this.moveTimer = 0; this.mouseMsg('move', this.lastMoveEv ?? ev) }
      this.mouseMsg('up', ev)
      this.ime.focus({ preventScroll: true })
    })
    d.addEventListener('mousemove', ev => {
      const now = performance.now()
      const interval = ev.buttons ? 16 : 40
      this.lastMoveEv = ev
      if (now - this.lastMove < interval) {
        if (!this.moveTimer) this.moveTimer = window.setTimeout(() => { this.moveTimer = 0; if (this.lastMoveEv) this.mouseMsg('move', this.lastMoveEv); this.lastMove = performance.now() }, interval)
        return
      }
      this.lastMove = now
      this.mouseMsg('move', ev)
    })
    d.addEventListener('wheel', ev => {
      if (this.canScrollLocally(ev)) return // 로컬 스크롤 → scroll 이벤트가 동기화
      ev.preventDefault()
      const { id, rx, ry } = this.rel(ev)
      const k = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? 800 : 1
      if (!this.wheelAcc) this.wheelAcc = { id, rx, ry, dx: 0, dy: 0, mods: this.mods(ev) }
      this.wheelAcc.dx += ev.deltaX * k; this.wheelAcc.dy += ev.deltaY * k
      if (!this.wheelTimer) this.wheelTimer = window.setTimeout(() => {
        this.wheelTimer = 0
        const w = this.wheelAcc; this.wheelAcc = null
        if (w) this.send({ t: 'mouse', type: 'wheel', id: w.id, rx: w.rx, ry: w.ry, dx: Math.round(w.dx), dy: Math.round(w.dy), mods: w.mods, seq: this.nextSeq('mouse') })
      }, 16)
    }, { passive: false })
    d.addEventListener('contextmenu', ev => ev.preventDefault()) // 오른쪽 버튼은 mousedown/up 으로 원격에 갔다 — 원격 메뉴(DOM)가 미러로 온다
    d.addEventListener('dragstart', ev => ev.preventDefault())
    d.addEventListener('auxclick', ev => ev.preventDefault())
    d.addEventListener('copy', ev => this.onCopy(ev as ClipboardEvent, false))
    d.defaultView!.addEventListener('scroll', () => {
      const w = d.defaultView!
      this.lastUserScroll.set(0, performance.now())
      this.send({ t: 'scroll', id: 0, sx: Math.round(w.scrollX), sy: Math.round(w.scrollY), seq: this.nextSeq('scroll') })
    }, { passive: true })
  }

  private onLocalScroll(id: number, el: HTMLElement): void {
    this.lastUserScroll.set(id, performance.now())
    this.send({ t: 'scroll', id, sx: Math.round(el.scrollLeft), sy: Math.round(el.scrollTop), seq: this.nextSeq('scroll') })
  }

  private positionIme(e: Entry | undefined): void {
    // IME 후보창이 위젯 근처에 뜨도록 숨은 input 을 그 위치로
    const fr = this.opt.iframe.getBoundingClientRect()
    if (e) {
      const r = (e.el as HTMLElement).getBoundingClientRect()
      this.ime.style.left = `${Math.round(fr.left + r.left)}px`; this.ime.style.top = `${Math.round(fr.top + r.bottom - 2)}px`
    }
  }

  private startEcho(n: VNode): void {
    if (!n.wk || !TEXT_WIDGETS.has(n.wk)) { this.echo.stop(); return }
    this.echo.start(n.id, n.wk === 'password' ? (n.wv ?? '') : (n.wv ?? ''), n.wk === 'password', n.wk === 'textarea')
  }

  private onRemoteFocus(id: number): void {
    const e = id ? this.entries.get(id) : undefined
    const prev = this.focusedWidget
    if (e && e.node.k === 'widget') {
      this.focusedWidget = id
      this.startEcho(e.node)
      this.positionIme(e)
    } else {
      this.focusedWidget = 0
      this.echo.stop()
    }
    for (const x of [prev, this.focusedWidget]) { const w = x ? this.entries.get(x) : undefined; if (w && w.node.k === 'widget') this.renderWidget(w) }
  }

  private echoPush(seq: number, op: EchoOp): void {
    if (!this.echo.id || this.focusedWidget !== this.echo.id) return
    this.echo.push(seq, op)
    const e = this.entries.get(this.echo.id)
    if (e) this.renderWidget(e)
  }

  /** 복사 — 미러 안 선택이 있으면 그것(네이티브 선택), 없으면 원격 선택(getsel). 정책(co)이 꺼져 있으면 막는다 */
  private onCopy(ev: ClipboardEvent, cut: boolean): void {
    const sel = this.doc?.getSelection()?.toString() ?? ''
    if (!this.pol.co) { ev.preventDefault(); this.opt.onNotice?.({ k: 'blocked-clip-out' }); return }
    if (sel) { ev.preventDefault(); ev.clipboardData?.setData('text/plain', sel); return }
    ev.preventDefault()
    const seq = this.nextSeq('getsel')
    this.clipWaiters.set(seq, t => { if (t) void navigator.clipboard?.writeText(t).catch(() => this.opt.onNotice?.({ k: 'limit', detail: 'clipboard' })) })
    this.send({ t: 'getsel', seq })
    if (cut) this.sendKeyPair({ key: 'x', code: 'KeyX', vk: 88, mods: 2 })
  }

  private sendKeyPair(k: { key: string; code: string; vk: number; mods: number }): void {
    this.send({ t: 'key', type: 'down', key: k.key, code: k.code, vk: k.vk, mods: k.mods, seq: this.nextSeq('key') })
    this.send({ t: 'key', type: 'up', key: k.key, code: k.code, vk: k.vk, mods: k.mods, seq: this.nextSeq('key') })
  }

  private bindIme(): void {
    const i = this.ime
    const vkOf = (ev: KeyboardEvent) => ev.keyCode || 0
    i.addEventListener('keydown', ev => {
      if (ev.isComposing || ev.keyCode === 229) return
      if (browserReserved(ev)) return
      const ctrl = ev.ctrlKey || ev.metaKey
      const k = ev.key.toLowerCase()
      // 복사·잘라내기·붙여넣기는 clipboard 이벤트가 처리한다(키를 원격에 보내지 않는다)
      if (ctrl && !ev.altKey && (k === 'c' || k === 'x' || k === 'v' || k === 'insert')) return
      if (ev.shiftKey && ev.key === 'Insert') return
      const printable = ev.key.length === 1 && !ctrl && !ev.altKey
      if (printable) return // beforeinput 이 text 로 보낸다
      ev.preventDefault()
      const text = ev.key === 'Enter' ? '\r' : ev.key === 'Tab' ? '\t' : undefined
      const mods = this.mods(ev)
      const seq = this.nextSeq('key')
      this.keysDown.add(ev.code)
      const m: ClientMsg = { t: 'key', type: 'down', key: ev.key.slice(0, 32), code: ev.code.slice(0, 32), vk: Math.min(255, vkOf(ev)), mods, seq }
      if (text) m.text = text
      if (ev.repeat) m.rep = true
      this.send(m)
      const n = this.echo.id ? this.entries.get(this.echo.id)?.node : undefined
      const op = keyToOp(ev.key, mods, n?.wk === 'textarea')
      if (op) this.echoPush(seq, op)
    })
    i.addEventListener('keyup', ev => {
      if (ev.isComposing || ev.keyCode === 229) return
      if (!this.keysDown.has(ev.code)) return
      this.keysDown.delete(ev.code)
      ev.preventDefault()
      this.send({ t: 'key', type: 'up', key: ev.key.slice(0, 32), code: ev.code.slice(0, 32), vk: Math.min(255, vkOf(ev)), mods: this.mods(ev), seq: this.nextSeq('key') })
    })
    i.addEventListener('beforeinput', ev => {
      const e = ev as InputEvent
      if (e.isComposing || e.inputType === 'insertCompositionText') return // IME 가 값을 써야 조합이 된다
      if (e.inputType === 'insertText' && e.data) {
        ev.preventDefault()
        const seq = this.nextSeq('text')
        this.send({ t: 'text', text: e.data.slice(0, 10000), seq })
        this.echoPush(seq, { k: 'ins', t: e.data })
      } else if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') {
        ev.preventDefault() // paste 이벤트에서 처리
      } else {
        ev.preventDefault() // 줄바꿈·삭제는 keydown 으로 이미 갔다
      }
    })
    i.addEventListener('paste', ev => {
      ev.preventDefault()
      const text = (ev as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      if (!this.pol.ci) { this.opt.onNotice?.({ k: 'blocked-clip-in' }); return }
      // 긴 붙여넣기는 조각으로(서로게이트 쌍을 가르지 않게). 전체 상한을 넘는 뒷부분은 버리고 알린다
      const all = Array.from(text.slice(0, LIMITS.maxPasteTotal))
      if (text.length > LIMITS.maxPasteTotal) this.opt.onNotice?.({ k: 'limit', detail: 'paste' })
      for (let i = 0; i < all.length; i += LIMITS.maxPasteChars) {
        const part = all.slice(i, i + LIMITS.maxPasteChars).join('')
        const seq = this.nextSeq('paste')
        this.send({ t: 'paste', text: part, seq })
        this.echoPush(seq, { k: 'ins', t: part })
      }
    })
    i.addEventListener('copy', ev => this.onCopy(ev as ClipboardEvent, false))
    i.addEventListener('cut', ev => this.onCopy(ev as ClipboardEvent, true))
    i.addEventListener('compositionstart', () => { this.composing = true })
    i.addEventListener('compositionupdate', ev => {
      const text = (ev as CompositionEvent).data || ''
      const seq = this.nextSeq('comp')
      this.send({ t: 'comp', text: text.slice(0, 1000), ss: Math.min(1000, text.length), se: Math.min(1000, text.length), seq })
      this.echoPush(seq, { k: 'comp', t: text })
    })
    i.addEventListener('compositionend', ev => {
      this.composing = false
      const text = (ev as CompositionEvent).data || ''
      const seq = this.nextSeq('compend')
      this.send({ t: 'compend', text: text.slice(0, 10000), seq })
      this.echoPush(seq, { k: 'compend', t: text })
      window.setTimeout(() => { if (!this.composing) i.value = '' }, 0)
    })
  }
}
